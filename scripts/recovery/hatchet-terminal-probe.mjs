import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  RESULT_PREFIX,
  TERMINAL_PROBE_TASK,
  createClient,
  observeTerminalRun,
  redactErrorMessage,
  requireSingleProbeInventoryEntry,
  terminalRunInventory,
  withTimeout,
} from "./hatchet-terminal-evidence.mjs";

const requireFromApplication = createRequire(resolve(process.cwd(), "package.json"));
const { IdempotencyCollisionError } = requireFromApplication("@hatchet-dev/typescript-sdk/v1");

function isIdempotencyCollision(error) {
  return error instanceof IdempotencyCollisionError
    || (error?.name === "IdempotencyCollisionError" && typeof error.existingRunExternalId === "string");
}

function operationOutcome(promise) {
  return Promise.resolve(promise).then(
    (value) => ({ kind: "operation", value }),
    (error) => ({ kind: "operation_error", error }),
  );
}

async function whileWorkerRuns(operation, workerOutcome) {
  const outcome = await Promise.race([operationOutcome(operation), workerOutcome]);
  if (outcome.kind === "operation") return outcome.value;
  if (outcome.kind === "operation_error") throw outcome.error;
  if (outcome.kind === "worker_error") throw outcome.error;
  throw new Error("Hatchet probe worker stopped before the terminal run completed");
}

export async function createTerminalRun(client, nonce = randomBytes(32).toString("hex"), options = {}) {
  const deadlineAt = Date.now() + (options.deadlineMs ?? 120_000);
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 10_000;
  const bounded = (operation, label) => withTimeout(
    whileWorkerRuns(operation, workerOutcome),
    Math.max(1, deadlineAt - Date.now()),
    `${label} timed out`,
  );
  const task = client.task({
    name: TERMINAL_PROBE_TASK,
    version: "1",
    retries: 0,
    executionTimeout: "1m",
    scheduleTimeout: "5m",
    idempotency: { expression: "input.nonce", strategy: "ttl", ttlMs: 60 * 60 * 1_000 },
    fn: async (input) => ({ digest: createHash("sha256").update(input.nonce).digest("hex") }),
  });
  const worker = await withTimeout(
    client.worker(`recovery-terminal-probe-${randomBytes(6).toString("hex")}`, {
      workflows: [task],
      slots: 1,
      durableSlots: 1,
      handleKill: false,
    }),
    Math.max(1, deadlineAt - Date.now()),
    "Hatchet probe worker creation timed out",
  );
  const workerOutcome = Promise.resolve().then(() => worker.start()).then(
    () => ({ kind: "worker_stopped" }),
    (error) => ({ kind: "worker_error", error }),
  );
  const listenerAbort = new AbortController();
  let primaryError;
  try {
    await bounded(worker.waitUntilReady(15_000), "Hatchet probe worker readiness");
    let reference;
    let runId;
    try {
      reference = await bounded(task.runNoWait({ nonce }), "Hatchet probe trigger");
      reference.defaultSignal = listenerAbort.signal;
      runId = await bounded(reference.getWorkflowRunId(), "Hatchet probe run ID");
      await bounded(reference.output, "Hatchet probe output");
    } catch (error) {
      if (!isIdempotencyCollision(error)) throw error;
      runId = error.existingRunExternalId;
    }
    const observed = await bounded(observeTerminalRun(client, runId, { deadlineMs: Math.max(1, deadlineAt - Date.now()) }), "Hatchet probe observation");
    const inventory = await bounded(terminalRunInventory(client), "Hatchet probe inventory");
    requireSingleProbeInventoryEntry(inventory, observed);
    return observed;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    listenerAbort.abort();
    const cleanupErrors = [];
    try {
      await withTimeout(worker.stop(), cleanupTimeoutMs, "Hatchet probe worker stop timed out");
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      const finalWorkerOutcome = await withTimeout(workerOutcome, cleanupTimeoutMs, "Hatchet probe worker shutdown timed out");
      if (finalWorkerOutcome.kind === "worker_error" && finalWorkerOutcome.error !== primaryError) {
        cleanupErrors.push(finalWorkerOutcome.error);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      if (primaryError) throw new AggregateError([primaryError, ...cleanupErrors], "Hatchet terminal probe and worker cleanup both failed");
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      throw new AggregateError(cleanupErrors, "Hatchet terminal probe worker cleanup failed");
    }
  }
}

async function main() {
  const tokenPath = process.env.HATCHET_CLIENT_TOKEN_FILE;
  if (!tokenPath) throw new Error("HATCHET_CLIENT_TOKEN_FILE is required");
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (!token) throw new Error("Hatchet client token file is empty");
  return createTerminalRun(createClient(token));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const observation = await main();
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(observation)}\n`, () => process.exit(0));
  } catch (error) {
    process.stderr.write(`Hatchet recovery probe failed: ${redactErrorMessage(error)}\n`, () => process.exit(1));
  }
}
