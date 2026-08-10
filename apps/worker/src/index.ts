import { hostname } from "node:os";

import { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import { createClient } from "@supabase/supabase-js";
import { assertRuntimeDatabaseRole, createDatabase } from "@infinite-canvas/db";
import { createLogger } from "@infinite-canvas/observability";
import { AdapterRegistry, GrokImageAdapter, GrokVideoAdapter, OpenAiImageAdapter, OpenAiVideoAdapter } from "@infinite-canvas/provider-adapters";
import { v7 as uuidv7 } from "uuid";

import { hatchetClientOptions, loadWorkerConfig } from "./config.js";
import { OutboxDispatcher } from "./dispatcher.js";
import { GenerationExecutor } from "./executor.js";
import { UnknownOutcomeReconciler } from "./reconciler.js";
import { ImportExecutor } from "./import-executor.js";
import { GenerationRepository } from "./repository.js";
import { ObjectStorage } from "./storage.js";
import { WorkerMetricsServer } from "./metrics.js";
import { createLocalDataImportWorkflow, createMediaGenerationWorkflow, MEDIA_GENERATION_WORKER_V2 } from "./workflow.js";

const config = loadWorkerConfig();
const database = createDatabase(config.BUSINESS_DATABASE_URL, { applicationName: "infinite-canvas-worker" });
await assertRuntimeDatabaseRole(database.client, "Worker");
const hatchet = HatchetClient.init(hatchetClientOptions(config));
const registry = new AdapterRegistry();
registry.register(new GrokImageAdapter("grok2api", "grok-imagine-image-edit"));
registry.register(new GrokVideoAdapter("grok2api"));
registry.register(new GrokImageAdapter("sub2api", "grok-imagine-edit"));
registry.register(new GrokVideoAdapter("sub2api"));
registry.register(new OpenAiImageAdapter());
registry.register(new OpenAiVideoAdapter());

const storage = new ObjectStorage(config);
const metrics = new WorkerMetricsServer(database.client, config.WORKER_METRICS_PORT, createLogger("infinite-canvas-worker-metrics", config.LOG_LEVEL));
const repository = new GenerationRepository(
  database.client,
  config,
  registry,
  storage,
  uuidv7,
  (observation: { code: string; durationSeconds: number }) =>
    metrics.observeProviderRequest(observation),
);
const executor = new GenerationExecutor(repository, storage);
const generationWorkflows = createMediaGenerationWorkflow(hatchet, executor, repository);
const importWorkflow = createLocalDataImportWorkflow(hatchet, new ImportExecutor(database.client, storage, config.MAX_MEDIA_BYTES, uuidv7));
const worker = await hatchet.worker(MEDIA_GENERATION_WORKER_V2, {
  workflows: [generationWorkflows.workflow, ...generationWorkflows.executionTasks, importWorkflow],
  slots: config.HATCHET_WORKER_SLOTS,
  durableSlots: config.HATCHET_DURABLE_SLOTS,
  handleKill: false,
});
const instanceId = `${hostname()}:${process.pid}:${uuidv7()}`;
const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const dispatcher = new OutboxDispatcher(database.client, hatchet, config, instanceId, {
  async setUserDisabled(userId, disabled) {
    const { error } = await supabase.auth.admin.updateUserById(userId, { ban_duration: disabled ? "876000h" : "none" });
    if (error) throw error;
  },
});
const reconciler = new UnknownOutcomeReconciler(
  database.client,
  uuidv7,
  60_000,
  (candidate, now) => repository.reconcileUnknownProviderTask(candidate, now),
);

let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await dispatcher.stop();
  await reconciler.stop();
  await metrics.stop();
  await worker.stop();
  await database.client.end({ timeout: 15 });
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

const running = worker.start();
await worker.waitUntilReady(30_000);
await metrics.start();
if (config.OUTBOX_DISPATCHER_ENABLED === "true") dispatcher.start();
if (config.UNKNOWN_RECONCILER_ENABLED === "true") reconciler.start();
await running;
