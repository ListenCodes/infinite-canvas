import { timingSafeEqual } from "node:crypto";

import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import { z, ZodError, type ZodType } from "zod";

import {
  activeJobsSnapshotSchema,
  adminAuditPageSchema,
  adminAuditLogSchema,
  adminJobPageSchema,
  adminJobSchema,
  adminModelConfigResponseSchema,
  adminPageQuerySchema,
  adminUserPageSchema,
  adminUserSchema,
  adminUserFeaturesResponseSchema,
  adminUserStatusResponseSchema,
  adminWalletAdjustmentResponseSchema,
  assetCompleteResponseSchema,
  assetSignedUrlResponseSchema,
  assetStatusResponseSchema,
  assetUploadIntentResponseSchema,
  cancelGenerationJobResponseSchema,
  createGenerationBatchRequestSchema,
  createGenerationBatchResponseSchema,
  generationBatchSnapshotSchema,
  generationJobProjectionSchema,
  generationTaskListResponseSchema,
  localDataImportResponseSchema,
  modelListResponseSchema,
  projectProjectionSchema,
  providerChannelMutationResponseSchema,
  providerChannelSchema,
  providerCredentialResponseSchema,
  sessionBootstrapResponseSchema,
  unknownResolutionResponseSchema,
} from "@infinite-canvas/contracts";
import { createLogger } from "@infinite-canvas/observability";

import type { Authenticator, AuthUser } from "./auth.js";
import type { ApiConfig } from "./config.js";
import { allowedOrigins } from "./config.js";
import { AppError } from "./errors.js";
import type { EventBroker, EventService } from "./events.js";
import type { GenerationService } from "./services/generation.js";
import {
  createProjectSchema,
  type ProjectService,
  updateProjectSchema,
} from "./services/projects.js";
import type { AssetService } from "./services/assets.js";
import type { ImportService } from "./services/imports.js";
import type { AdminService } from "./services/admin.js";

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
    metricsStartedAt?: bigint;
  }
}

export interface ApiDependencies {
  config: ApiConfig;
  authenticator: Authenticator;
  projectService: Pick<
    ProjectService,
    "assertAccountAccess" | "bootstrap" | "list" | "get" | "create" | "update"
  >;
  assetService: Pick<
    AssetService,
    "createUploadIntent" | "completeUpload" | "status" | "signedDownload"
  >;
  importService: Pick<ImportService, "create" | "get">;
  generationService: Pick<
    GenerationService,
    | "listModels"
    | "createBatch"
    | "getBatch"
    | "activeJobs"
    | "resolveBatch"
    | "listJobs"
    | "retryJob"
    | "cancelJob"
  >;
  eventService: Pick<EventService, "workspaceForUser" | "after">;
  eventBroker: Pick<EventBroker, "start" | "subscribe" | "close">;
  readinessProbe: () => Promise<void>;
  adminService: Pick<
    AdminService,
    | "assertAdmin"
    | "users"
    | "usersPage"
    | "setUserStatus"
    | "setUserFeatures"
    | "adjustWallet"
    | "channels"
    | "saveChannel"
    | "rotateCredential"
    | "createModel"
    | "resolveUnknown"
    | "jobs"
    | "jobsPage"
    | "audit"
    | "auditPage"
  >;
}

const uuidParamSchema = z.object({ id: z.uuid() });
const eventCursorSchema = z
  .string()
  .regex(/^\d+$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n, {
    message: "Event cursor exceeds PostgreSQL bigint range",
  });
const eventQuerySchema = z
  .object({
    cursor: eventCursorSchema.default("0"),
    projectId: z.uuid().optional(),
    workspaceId: z.uuid().optional(),
  })
  .refine(
    (value) => Boolean(value.projectId || value.workspaceId),
    "projectId or workspaceId is required",
  );
const modelQuerySchema = z.object({
  capability: z.enum(["image", "video"]).optional(),
});
const batchResolveQuerySchema = z.object({
  projectId: z.uuid(),
  idempotencyKey: z.string().min(8).max(128),
});
const jobListQuerySchema = z.object({
  workspaceId: z.uuid().optional(),
  before: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function validateResponse<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new AppError(
      500,
      "invalid_server_response",
      "The server produced an invalid response",
    );
  return parsed.data;
}

export async function buildServer(dependencies: ApiDependencies) {
  const logger = createLogger(
    "infinite-canvas-api",
    dependencies.config.LOG_LEVEL,
  );
  const server = Fastify({
    loggerInstance: logger,
    trustProxy: dependencies.config.TRUST_PROXY === "true",
    bodyLimit: Math.min(dependencies.config.MAX_UPLOAD_BYTES, 10 * 1024 * 1024),
    requestIdHeader: "x-request-id",
  });
  const metrics = new Registry();
  collectDefaultMetrics({ register: metrics, prefix: "infinite_canvas_api_" });
  const requestDuration = new Histogram({
    name: "infinite_canvas_api_http_request_duration_seconds",
    help: "API request duration in seconds",
    labelNames: ["method", "route", "status_code"] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [metrics],
  });
  const activeSseConnections = new Gauge({
    name: "infinite_canvas_api_sse_connections",
    help: "Current authenticated SSE connections",
    registers: [metrics],
  });
  const sseConnections = new Counter({
    name: "infinite_canvas_api_sse_connections_total",
    help: "SSE connections opened",
    registers: [metrics],
  });
  const sseDisconnects = new Counter({
    name: "infinite_canvas_api_sse_disconnects_total",
    help: "SSE connections closed by reason",
    labelNames: ["reason"] as const,
    registers: [metrics],
  });
  const sseReplayedEvents = new Counter({
    name: "infinite_canvas_api_sse_replayed_events_total",
    help: "Events delivered from the durable cursor scan",
    registers: [metrics],
  });
  const sseNotifyWakeups = new Counter({
    name: "infinite_canvas_api_sse_notify_wakeups_total",
    help: "Cursor scans requested by PostgreSQL notifications",
    registers: [metrics],
  });
  const sseScanFailures = new Counter({
    name: "infinite_canvas_api_sse_scan_failures_total",
    help: "Failed SSE cursor scans",
    registers: [metrics],
  });
  let activeImports = 0;
  await server.register(cors, {
    origin(origin, callback) {
      if (!origin || allowedOrigins(dependencies.config).includes(origin))
        callback(null, true);
      else callback(new Error("Origin is not allowed"), false);
    },
    credentials: false,
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "Idempotency-Key",
      "Last-Event-ID",
      "X-Request-ID",
    ],
  });
  await server.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await server.register(multipart, {
    limits: {
      fileSize: dependencies.config.MAX_UPLOAD_BYTES,
      files: 20,
      fields: 100,
    },
  });

  server.decorateRequest("authUser");
  server.decorateRequest("metricsStartedAt");
  server.addHook("onRequest", async (request) => {
    request.metricsStartedAt = process.hrtime.bigint();
  });
  server.addHook("onResponse", async (request, reply) => {
    const startedAt = request.metricsStartedAt;
    if (typeof startedAt !== "bigint") return;
    requestDuration.observe(
      {
        method: request.method,
        route: request.routeOptions.url ?? "unmatched",
        status_code: String(reply.statusCode),
      },
      Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
    );
  });
  server.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/v1/")) return;
    request.authUser = await dependencies.authenticator.authenticate(
      request.headers.authorization,
    );
    await dependencies.projectService.assertAccountAccess(
      request.authUser.userId,
    );
    if (request.url.startsWith("/v1/admin/")) {
      await dependencies.adminService.assertAdmin(request.authUser.userId);
    }
  });

  server.get("/healthz", async () => ({ status: "ok" }));
  server.get("/metrics", async (request, reply) => {
    const expectedToken = dependencies.config.METRICS_BEARER_TOKEN;
    if (expectedToken) {
      const expected = Buffer.from(`Bearer ${expectedToken}`);
      const actual = Buffer.from(request.headers.authorization ?? "");
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      ) {
        return reply.status(401).send({
          error: {
            code: "authentication_required",
            message: "Metrics authentication is required",
            retryable: false,
            correlationId: request.id,
          },
        });
      }
    }
    return reply.type(metrics.contentType).send(await metrics.metrics());
  });
  server.get("/readyz", async (_request, reply) => {
    try {
      await dependencies.readinessProbe();
      await dependencies.eventBroker.start();
      return { status: "ready" };
    } catch {
      return reply.status(503).send({ status: "not_ready" });
    }
  });

  server.post("/v1/session/bootstrap", async (request) => {
    return validateResponse(
      sessionBootstrapResponseSchema,
      await dependencies.projectService.bootstrap(
        request.authUser!.userId,
        request.authUser!.email,
      ),
    );
  });
  server.get("/v1/projects", async (request) =>
    validateResponse(
      projectProjectionSchema.array(),
      await dependencies.projectService.list(request.authUser!.userId),
    ),
  );
  server.post("/v1/projects", async (request, reply) => {
    const result = await dependencies.projectService.create(
      request.authUser!.userId,
      createProjectSchema.parse(request.body),
      String(request.headers["idempotency-key"] ?? ""),
    );
    return reply
      .status(201)
      .send(validateResponse(projectProjectionSchema, result));
  });
  server.get("/v1/projects/:id", async (request) => {
    const { id } = uuidParamSchema.parse(request.params);
    return validateResponse(
      projectProjectionSchema,
      await dependencies.projectService.get(request.authUser!.userId, id),
    );
  });
  server.get("/v1/projects/:id/active-jobs", async (request) => {
    const { id } = uuidParamSchema.parse(request.params);
    return validateResponse(
      activeJobsSnapshotSchema,
      await dependencies.generationService.activeJobs(
        request.authUser!.userId,
        id,
      ),
    );
  });
  server.put("/v1/projects/:id", async (request) => {
    const { id } = uuidParamSchema.parse(request.params);
    return validateResponse(
      projectProjectionSchema,
      await dependencies.projectService.update(
        request.authUser!.userId,
        id,
        updateProjectSchema.parse(request.body),
      ),
    );
  });

  server.post("/v1/assets/upload-intents", async (request, reply) => {
    const result = await dependencies.assetService.createUploadIntent(
      request.authUser!.userId,
      request.body,
      String(request.headers["idempotency-key"] ?? ""),
    );
    return reply
      .status(201)
      .send(validateResponse(assetUploadIntentResponseSchema, result));
  });
  server.post("/v1/assets/:id/complete", async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
    const result = validateResponse(
      assetCompleteResponseSchema,
      await dependencies.assetService.completeUpload(
        request.authUser!.userId,
        id,
      ),
    );
    return reply.status(result.status === "verifying" ? 202 : 200).send(result);
  });
  server.get("/v1/assets/:id", async (request) => {
    const { id } = uuidParamSchema.parse(request.params);
    return validateResponse(
      assetStatusResponseSchema,
      await dependencies.assetService.status(request.authUser!.userId, id),
    );
  });
  server.get("/v1/assets/:id/signed-url", async (request) => {
    const { id } = uuidParamSchema.parse(request.params);
    return validateResponse(
      assetSignedUrlResponseSchema,
      await dependencies.assetService.signedDownload(
        request.authUser!.userId,
        id,
      ),
    );
  });

  server.post("/v1/imports", async (request, reply) => {
    if (activeImports >= dependencies.config.MAX_CONCURRENT_IMPORTS)
      throw new AppError(
        429,
        "import_capacity_exceeded",
        "Too many imports are being validated; retry later",
      );
    activeImports += 1;
    try {
      const file = await request.file({
        limits: { fileSize: dependencies.config.MAX_IMPORT_BYTES, files: 1 },
        throwFileSizeLimit: false,
      });
      if (!file)
        throw new AppError(
          400,
          "import_file_required",
          "A local data export ZIP is required",
        );
      if (
        file.mimetype !== "application/zip" &&
        file.mimetype !== "application/x-zip-compressed"
      ) {
        throw new AppError(
          415,
          "invalid_import_media_type",
          "Import file must be a ZIP archive",
        );
      }
      const body = await file.toBuffer();
      if (file.file.truncated)
        throw new AppError(
          413,
          "import_too_large",
          "Import archive exceeds the upload limit",
        );
      const result = await dependencies.importService.create(
        request.authUser!.userId,
        body,
      );
      return reply
        .status(202)
        .send(validateResponse(localDataImportResponseSchema, result));
    } finally {
      activeImports -= 1;
    }
  });
  server.get("/v1/imports/:id", async (request) => {
    const { id } = uuidParamSchema.parse(request.params);
    return validateResponse(
      localDataImportResponseSchema,
      await dependencies.importService.get(request.authUser!.userId, id),
    );
  });

  server.get("/v1/model-configs", async (request) => {
    const query = modelQuerySchema.parse(request.query);
    return validateResponse(
      modelListResponseSchema,
      await dependencies.generationService.listModels(
        request.authUser!.userId,
        query.capability,
      ),
    );
  });

  server.post(
    "/v1/generation-batches",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const result = await dependencies.generationService.createBatch(
        request.authUser!.userId,
        createGenerationBatchRequestSchema.parse(request.body),
        String(request.headers["idempotency-key"] ?? ""),
      );
      return reply
        .status(202)
        .send(validateResponse(createGenerationBatchResponseSchema, result));
    },
  );
  server.get("/v1/generation-batches/resolve", async (request) => {
    const query = batchResolveQuerySchema.parse(request.query);
    return validateResponse(
      generationBatchSnapshotSchema,
      await dependencies.generationService.resolveBatch(
        request.authUser!.userId,
        query.projectId,
        query.idempotencyKey,
      ),
    );
  });
  server.get("/v1/generation-batches/:id", async (request) => {
    const { id } = uuidParamSchema.parse(request.params);
    return validateResponse(
      generationBatchSnapshotSchema,
      await dependencies.generationService.getBatch(
        request.authUser!.userId,
        id,
      ),
    );
  });
  server.get("/v1/generation-jobs", async (request) => {
    const query = jobListQuerySchema.parse(request.query);
    return validateResponse(
      generationTaskListResponseSchema,
      await dependencies.generationService.listJobs(
        request.authUser!.userId,
        query.workspaceId,
        query.before,
        query.limit,
      ),
    );
  });
  server.post("/v1/generation-jobs/:id/retry", async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
    const result = await dependencies.generationService.retryJob(
      request.authUser!.userId,
      id,
      String(request.headers["idempotency-key"] ?? ""),
    );
    return reply
      .status(202)
      .send(validateResponse(generationJobProjectionSchema, result));
  });
  server.post("/v1/generation-jobs/:id/cancel", async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
    return reply
      .status(202)
      .send(
        validateResponse(
          cancelGenerationJobResponseSchema,
          await dependencies.generationService.cancelJob(
            request.authUser!.userId,
            id,
          ),
        ),
      );
  });

  server.get("/v1/admin/users", async () =>
    validateResponse(
      adminUserSchema.array(),
      await dependencies.adminService.users(),
    ),
  );
  server.get("/v1/admin/users/page", async (request) => {
    const query = adminPageQuerySchema.parse(request.query);
    return validateResponse(adminUserPageSchema, await dependencies.adminService.usersPage(query));
  });
  server.patch("/v1/admin/users/:id/status", async (request) => {
    const { id } = uuidParamSchema.parse(request.params);
    return validateResponse(
      adminUserStatusResponseSchema,
      await dependencies.adminService.setUserStatus(
        request.authUser!.userId,
        id,
        request.body,
      ),
    );
  });
  server.patch("/v1/admin/users/:id/features", async (request) => {
    const { id } = uuidParamSchema.parse(request.params);
    return validateResponse(
      adminUserFeaturesResponseSchema,
      await dependencies.adminService.setUserFeatures(
        request.authUser!.userId,
        id,
        request.body,
      ),
    );
  });
  server.post("/v1/admin/wallet-adjustments", async (request) => {
    return validateResponse(
      adminWalletAdjustmentResponseSchema,
      await dependencies.adminService.adjustWallet(
        request.authUser!.userId,
        request.body,
        String(request.headers["idempotency-key"] ?? ""),
      ),
    );
  });
  server.get("/v1/admin/channels", async () =>
    validateResponse(
      providerChannelSchema.array(),
      await dependencies.adminService.channels(),
    ),
  );
  server.post("/v1/admin/channels", async (request, reply) => {
    return reply
      .status(201)
      .send(
        validateResponse(
          providerChannelMutationResponseSchema,
          await dependencies.adminService.saveChannel(
            request.authUser!.userId,
            request.body,
            String(request.headers["idempotency-key"] ?? ""),
          ),
        ),
      );
  });
  server.put("/v1/admin/channels/:id", async (request) => {
    const { id } = uuidParamSchema.parse(request.params);
    return validateResponse(
      providerChannelMutationResponseSchema,
      await dependencies.adminService.saveChannel(request.authUser!.userId, {
        ...(request.body as object),
        id,
      }, String(request.headers["idempotency-key"] ?? "")),
    );
  });
  server.post("/v1/admin/channels/:id/credentials", async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
    return reply
      .status(201)
      .send(
        validateResponse(
          providerCredentialResponseSchema,
          await dependencies.adminService.rotateCredential(
            request.authUser!.userId,
            id,
            request.body,
            String(request.headers["idempotency-key"] ?? ""),
          ),
        ),
      );
  });
  server.post("/v1/admin/channels/:id/models", async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
    return reply
      .status(201)
      .send(
        validateResponse(
          adminModelConfigResponseSchema,
          await dependencies.adminService.createModel(
            request.authUser!.userId,
            id,
            request.body,
            String(request.headers["idempotency-key"] ?? ""),
          ),
        ),
      );
  });
  server.get("/v1/admin/jobs", async () =>
    validateResponse(
      adminJobSchema.array(),
      await dependencies.adminService.jobs(),
    ),
  );
  server.get("/v1/admin/jobs/page", async (request) => {
    const query = adminPageQuerySchema.parse(request.query);
    return validateResponse(adminJobPageSchema, await dependencies.adminService.jobsPage(query));
  });
  server.post("/v1/admin/attempts/:id/resolve", async (request) => {
    const { id } = uuidParamSchema.parse(request.params);
    return validateResponse(
      unknownResolutionResponseSchema,
      await dependencies.adminService.resolveUnknown(
        request.authUser!.userId,
        id,
        request.body,
        String(request.headers["idempotency-key"] ?? ""),
      ),
    );
  });
  server.get("/v1/admin/audit", async () =>
    validateResponse(
      adminAuditLogSchema.array(),
      await dependencies.adminService.audit(),
    ),
  );
  server.get("/v1/admin/audit/page", async (request) => {
    const query = adminPageQuerySchema.parse(request.query);
    return validateResponse(adminAuditPageSchema, await dependencies.adminService.auditPage(query));
  });

  server.get("/v1/events", async (request, reply) => {
    const query = eventQuerySchema.parse(request.query);
    const headerCursor = request.headers["last-event-id"];
    let cursor =
      headerCursor === undefined
        ? query.cursor
        : eventCursorSchema.parse(headerCursor);
    const workspaceId = await dependencies.eventService.workspaceForUser(
      request.authUser!.userId,
      query.projectId,
      query.workspaceId,
    );

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write("retry: 3000\n\n");
    activeSseConnections.inc();
    sseConnections.inc();

    let scanning = false;
    let waitingForDrain = false;
    let closed = false;
    let unsubscribe: () => void = () => {};
    let interval: ReturnType<typeof setInterval> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let authorizationTimer: ReturnType<typeof setInterval> | undefined;
    const cleanup = (reason = "client_closed") => {
      if (closed) return;
      closed = true;
      activeSseConnections.dec();
      sseDisconnects.inc({ reason });
      if (interval) clearInterval(interval);
      if (heartbeat) clearInterval(heartbeat);
      if (authorizationTimer) clearInterval(authorizationTimer);
      unsubscribe();
    };
    request.raw.once("close", cleanup);
    const scan = async (): Promise<void> => {
      if (scanning || waitingForDrain || reply.raw.destroyed) return;
      scanning = true;
      try {
        if (request.authUser!.expiresAt <= Date.now())
          throw new AppError(
            401,
            "invalid_access_token",
            "The access token expired",
          );
        await dependencies.projectService.assertAccountAccess(
          request.authUser!.userId,
        );
        const events = await dependencies.eventService.after(
          request.authUser!.userId,
          workspaceId,
          cursor,
          query.projectId,
        );
        sseReplayedEvents.inc(events.length);
        for (const event of events) {
          const writable = reply.raw.write(
            `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
          cursor = event.sequence;
          if (!writable) {
            waitingForDrain = true;
            reply.raw.once("drain", () => {
              waitingForDrain = false;
              void scheduleScan();
            });
            break;
          }
        }
      } finally {
        scanning = false;
      }
    };
    const scheduleScan = async (): Promise<void> => {
      try {
        await scan();
      } catch (error) {
        sseScanFailures.inc();
        request.log.warn({ err: error }, "SSE cursor scan failed");
        cleanup("scan_failed");
        reply.raw.destroy();
      }
    };
    await scheduleScan();
    if (reply.raw.destroyed || closed) return;
    unsubscribe = dependencies.eventBroker.subscribe((payload) => {
      if (payload.workspaceId === workspaceId) {
        sseNotifyWakeups.inc();
        void scheduleScan();
      }
    });
    interval = setInterval(
      () => void scheduleScan(),
      dependencies.config.SSE_CURSOR_SCAN_MS,
    );
    authorizationTimer = setInterval(
      () => {
        void (async () => {
          try {
            if (request.authUser!.expiresAt <= Date.now())
              throw new Error("expired");
            await dependencies.projectService.assertAccountAccess(
              request.authUser!.userId,
            );
            const authorizedWorkspaceId =
              await dependencies.eventService.workspaceForUser(
                request.authUser!.userId,
                query.projectId,
                query.workspaceId,
              );
            if (authorizedWorkspaceId !== workspaceId)
              throw new Error("event workspace access changed");
          } catch {
            cleanup("authorization_changed");
            reply.raw.destroy();
          }
        })();
      },
      Math.min(60_000, dependencies.config.SSE_CURSOR_SCAN_MS),
    );
    heartbeat = setInterval(() => {
      if (!reply.raw.destroyed && !waitingForDrain)
        reply.raw.write(": heartbeat\n\n");
    }, 15_000);
  });

  server.setErrorHandler((error, request, reply) => {
    const correlationId = request.id;
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          correlationId,
          ...(error.details ? { details: error.details } : {}),
        },
      });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "invalid_request",
          message: "Request validation failed",
          retryable: false,
          correlationId,
          details: { issues: error.issues },
        },
      });
    }
    request.log.error({ err: error }, "request failed");
    return reply.status(500).send({
      error: {
        code: "internal_error",
        message: "The request could not be completed",
        retryable: true,
        correlationId,
      },
    });
  });

  server.addHook("onClose", async () => dependencies.eventBroker.close());
  return server;
}
