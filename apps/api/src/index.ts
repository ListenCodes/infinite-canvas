import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

import { assertRuntimeDatabaseRole, createDatabase } from "@infinite-canvas/db";

import { SupabaseAuthenticator } from "./auth.js";
import { loadConfig } from "./config.js";
import { EventBroker, EventService } from "./events.js";
import { createId } from "./ids.js";
import { buildServer } from "./server.js";
import { GenerationService } from "./services/generation.js";
import { ProjectService } from "./services/projects.js";
import { AssetService } from "./services/assets.js";
import { ImportService } from "./services/imports.js";
import { AdminService } from "./services/admin.js";

const config = loadConfig();
const database = createDatabase(config.BUSINESS_DATABASE_URL, { applicationName: "infinite-canvas-api" });
await assertRuntimeDatabaseRole(database.client, "API");
const listener = postgres(config.BUSINESS_DATABASE_LISTENER_URL, {
  max: 1,
  prepare: false,
  connection: { application_name: "infinite-canvas-api-events" },
});
const eventBroker = new EventBroker(listener);
await eventBroker.start();
const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const server = await buildServer({
  config,
  authenticator: new SupabaseAuthenticator(config.SUPABASE_URL, config.SUPABASE_JWT_AUDIENCE),
  projectService: new ProjectService(database.client, createId),
  assetService: new AssetService(database.client, supabase, config.STORAGE_BUCKET, config.MAX_UPLOAD_BYTES, createId, {
    maxImagePixels: config.MAX_IMAGE_PIXELS,
    maxDurationSeconds: config.MAX_MEDIA_DURATION_SECONDS,
    ffprobePath: config.FFPROBE_PATH,
    ffmpegPath: config.FFMPEG_PATH,
  }),
  importService: new ImportService(database.client, supabase, config.STORAGE_BUCKET, config.MAX_IMPORT_BYTES, createId),
  generationService: new GenerationService(
    database.client,
    createId,
    config.IDEMPOTENCY_TTL_SECONDS,
    config.GENERATION_WRITES_ENABLED === "true",
  ),
  eventService: new EventService(database.client),
  eventBroker,
  readinessProbe: async () => { await database.client`select 1`; },
  adminService: new AdminService(
    database.client,
    config.CREDENTIAL_MASTER_KEY,
    config.ADMIN_LARGE_DEBIT_THRESHOLD,
    createId,
    config.GENERATION_WRITES_ENABLED === "true",
  ),
});

const shutdown = async (signal: string): Promise<void> => {
  server.log.info({ signal }, "shutting down");
  await server.close();
  await database.client.end({ timeout: 10 });
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await server.listen({ host: config.HOST, port: config.PORT });
