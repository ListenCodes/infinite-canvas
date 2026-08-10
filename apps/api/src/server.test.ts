import assert from "node:assert/strict";
import { test } from "node:test";

import type { Authenticator } from "./auth.js";
import type { ApiConfig } from "./config.js";
import { AppError } from "./errors.js";
import { buildServer, type ApiDependencies } from "./server.js";
import {
  generationEventSchema,
  sessionBootstrapResponseSchema,
  type GenerationEvent,
} from "@infinite-canvas/contracts";

const projectId = "00000000-0000-4000-8000-000000000201";
const workspaceId = "00000000-0000-4000-8000-000000000101";
const modelConfigId = "00000000-0000-4000-8000-000000000401";
const batchId = "00000000-0000-4000-8000-000000000601";
const jobId = "00000000-0000-4000-8000-000000000701";
const attemptId = "00000000-0000-4000-8000-000000000801";

const config: ApiConfig = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3001,
  LOG_LEVEL: "silent",
  METRICS_BEARER_TOKEN: "test-metrics-token-32-characters-long",
  BUSINESS_DATABASE_URL: "postgres://test:test@localhost/test",
  BUSINESS_DATABASE_LISTENER_URL: "postgres://test:test@localhost/test",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_JWT_AUDIENCE: "authenticated",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key-not-real",
  CREDENTIAL_MASTER_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  STORAGE_BUCKET: "test",
  CORS_ALLOWED_ORIGINS: "http://localhost:5173",
  TRUST_PROXY: "false",
  GENERATION_WRITES_ENABLED: "true",
  MAX_UPLOAD_BYTES: 1024,
  MAX_IMPORT_BYTES: 1024,
  MAX_CONCURRENT_IMPORTS: 1,
  MAX_IMAGE_PIXELS: 40_000_000,
  MAX_MEDIA_DURATION_SECONDS: 1800,
  FFPROBE_PATH: "ffprobe",
  FFMPEG_PATH: "ffmpeg",
  IDEMPOTENCY_TTL_SECONDS: 86400,
  ADMIN_LARGE_DEBIT_THRESHOLD: 1000n,
  SSE_CURSOR_SCAN_MS: 5000,
};

class TestAuthenticator implements Authenticator {
  async authenticate(authorization: string | undefined) {
    if (authorization !== "Bearer valid")
      throw new AppError(401, "invalid_access_token", "Invalid token");
    return {
      userId: "00000000-0000-4000-8000-000000000001",
      email: "a@example.com",
      expiresAt: Date.now() + 60_000,
    };
  }
}

function dependencies(
  capture: {
    input?: unknown;
    key?: string;
    resolved?: { userId: string; projectId: string; key: string };
    event?: GenerationEvent;
    eventCursors?: string[];
    projectKey?: string;
    assetKey?: string;
    assetCompleteStatus?: "verifying" | "ready";
    assetStatus?: "uploading" | "verifying" | "ready" | "rejected";
    activeJobsProjectId?: string;
    sseScanMs?: number;
    subscriber?: (payload: { workspaceId: string; sequence: string }) => void;
    adminChannelKey?: string;
  } = {},
): ApiDependencies {
  return {
    config: { ...config, SSE_CURSOR_SCAN_MS: capture.sseScanMs ?? config.SSE_CURSOR_SCAN_MS },
    authenticator: new TestAuthenticator(),
    projectService: {
      async assertAccountAccess() {},
      async bootstrap(userId) {
        return sessionBootstrapResponseSchema.parse({
          userId,
          workspaceId: "00000000-0000-4000-8000-000000000101",
          role: "owner",
          platformRole: "user",
          featureFlags: {
            projects: false,
            imageGeneration: false,
            videoGeneration: false,
            credits: false,
          },
          wallet: { available: "0", reserved: "0" },
        });
      },
      async list() {
        return [];
      },
      async get() {
        throw new AppError(404, "project_not_found", "Not found");
      },
      async create(_userId, input, key) {
        capture.projectKey = key;
        return {
          id: projectId,
          workspaceId: "00000000-0000-4000-8000-000000000101",
          title: input.title,
          documentJson: input.documentJson,
          version: 1,
          createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:00.000Z",
        } as never;
      },
      async update() {
        throw new Error("not used");
      },
    },
    assetService: {
      async createUploadIntent(_userId, _input, key) {
        capture.assetKey = key;
        return {
          assetId: attemptId,
          objectKey: "workspace/uploads/asset.png",
          status: "uploading",
          signedUrl: "https://storage.example/upload",
          token: "test-upload-token",
        } as never;
      },
      async completeUpload() {
        if (!capture.assetCompleteStatus) throw new Error("not used");
        return { assetId: attemptId, status: capture.assetCompleteStatus } as never;
      },
      async status() {
        if (!capture.assetStatus) throw new Error("not used");
        return { assetId: attemptId, status: capture.assetStatus } as never;
      },
      async signedDownload() {
        throw new Error("not used");
      },
    },
    importService: {
      async create() {
        throw new Error("not used");
      },
      async get() {
        throw new Error("not used");
      },
    },
    generationService: {
      async listModels() {
        return [];
      },
      async createBatch(_userId, input, key) {
        capture.input = input;
        capture.key = key;
        return {
          batchId,
          status: "queued",
          jobs: [
            {
              batchId,
              jobId,
              slotIndex: 0,
              slotId: "slot-1",
              status: "queued",
              jobVersion: 0,
              attemptId,
              attemptNo: 1,
            },
          ],
          credits: { reserved: "10", available: "90" },
          eventCursor: "1",
        } as never;
      },
      async getBatch() {
        throw new Error("not used");
      },
      async activeJobs(_userId, activeProjectId) {
        capture.activeJobsProjectId = activeProjectId;
        return {
          projectId: activeProjectId,
          projectVersion: 3,
          jobs: [
            {
              batchId,
              jobId,
              slotIndex: 0,
              slotId: "slot-1",
              targetNodeId: "node-1",
              capability: "image",
              status: "running",
              jobVersion: 2,
              attemptId,
              attemptNo: 1,
            },
          ],
          eventCursor: "9",
        } as never;
      },
      async resolveBatch(userId, resolvedProjectId, key) {
        capture.resolved = { userId, projectId: resolvedProjectId, key };
        return {
          batchId,
          projectId: resolvedProjectId,
          status: "running",
          requestedCount: 1,
          jobs: [
            {
              batchId,
              jobId,
              slotIndex: 0,
              slotId: "slot-1",
              status: "running",
              jobVersion: 1,
              attemptId,
              attemptNo: 1,
            },
          ],
          eventCursor: "2",
        } as never;
      },
      async listJobs() {
        return { jobs: [], eventCursor: "0", nextCursor: null } as never;
      },
      async retryJob() {
        throw new Error("not used");
      },
      async cancelJob() {
        throw new Error("not used");
      },
    },
    eventService: {
      async workspaceForUser() {
        return "workspace";
      },
      async after(_userId, _workspaceId, cursor) {
        capture.eventCursors?.push(cursor);
        return capture.event && BigInt(capture.event.sequence) > BigInt(cursor)
          ? [capture.event]
          : [];
      },
    },
    eventBroker: {
      async start() {},
      subscribe(subscriber) {
        capture.subscriber = subscriber;
        return () => undefined;
      },
      async close() {},
    },
    async readinessProbe() {},
    adminService: {
      async assertAdmin() {},
      async users() {
        return [];
      },
      async usersPage() {
        return { items: [], nextCursor: null };
      },
      async setUserStatus() {
        throw new Error("not used");
      },
      async setUserFeatures() {
        throw new Error("not used");
      },
      async adjustWallet() {
        throw new Error("not used");
      },
      async channels() {
        return [];
      },
      async saveChannel(_actorUserId, _input, key) {
        capture.adminChannelKey = key;
        return { id: modelConfigId } as never;
      },
      async rotateCredential() {
        throw new Error("not used");
      },
      async createModel() {
        throw new Error("not used");
      },
      async resolveUnknown() {
        throw new Error("not used");
      },
      async jobs() {
        return [];
      },
      async jobsPage() {
        return { items: [], nextCursor: null };
      },
      async audit() {
        return [];
      },
      async auditPage() {
        return { items: [], nextCursor: null };
      },
    },
  };
}

test("protected routes reject missing access tokens", async () => {
  const server = await buildServer(dependencies());
  try {
    const response = await server.inject({
      method: "GET",
      url: "/v1/projects",
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, "invalid_access_token");
  } finally {
    await server.close();
  }
});

test("metrics require the configured bearer token", async () => {
  const server = await buildServer(dependencies());
  try {
    const unauthorized = await server.inject({ method: "GET", url: "/metrics" });
    assert.equal(unauthorized.statusCode, 401);
    const authorized = await server.inject({
      method: "GET",
      url: "/metrics",
      headers: {
        authorization: `Bearer ${config.METRICS_BEARER_TOKEN}`,
      },
    });
    assert.equal(authorized.statusCode, 200, authorized.body);
    assert.match(authorized.body, /infinite_canvas_api_/);
  } finally {
    await server.close();
  }
});

test("platform credential canaries never appear in HTTP responses", async () => {
  const canaries = [
    "secret-canary-service-role-1001",
    "secret-canary-credential-master-1002",
    "secret-canary-database-url-1003",
    "secret-canary-metrics-token-1004",
  ];
  const deps = dependencies();
  deps.config.SUPABASE_SERVICE_ROLE_KEY = canaries[0]!;
  deps.config.CREDENTIAL_MASTER_KEY = canaries[1]!;
  deps.config.BUSINESS_DATABASE_URL = canaries[2]!;
  deps.config.BUSINESS_DATABASE_LISTENER_URL = canaries[2]!;
  deps.config.METRICS_BEARER_TOKEN = canaries[3]!;
  const server = await buildServer(deps);
  try {
    const responses = await Promise.all([
      server.inject({ method: "GET", url: "/healthz" }),
      server.inject({ method: "GET", url: "/v1/session/bootstrap", headers: { authorization: "Bearer valid" } }),
      server.inject({ method: "GET", url: "/metrics" }),
      server.inject({ method: "GET", url: "/not-found" }),
    ]);
    const surface = responses.map((response) => `${JSON.stringify(response.headers)}\n${response.body}`).join("\n");
    for (const canary of canaries) assert.equal(surface.includes(canary), false);
  } finally {
    await server.close();
  }
});

test("generation route strips forged authority fields and keeps idempotency", async () => {
  const capture: { input?: unknown; key?: string } = {};
  const server = await buildServer(dependencies(capture));
  try {
    const response = await server.inject({
      method: "POST",
      url: "/v1/generation-batches",
      headers: {
        authorization: "Bearer valid",
        "idempotency-key": "batch-key-123",
      },
      payload: {
        projectId,
        kind: "image",
        count: 1,
        target: { nodeId: "node-1", slotIds: ["slot-1"] },
        modelConfigId,
        input: { prompt: "draw" },
        projectVersion: 1,
        workspaceId: "forged",
        ownerId: "forged",
        platformRole: "admin",
        price: "0",
        channelId: "forged",
      },
    });
    assert.equal(response.statusCode, 202, response.body);
    assert.equal(capture.key, "batch-key-123");
    assert.deepEqual(Object.keys(capture.input as object).sort(), [
      "count",
      "input",
      "kind",
      "modelConfigId",
      "projectId",
      "projectVersion",
      "target",
    ]);
  } finally {
    await server.close();
  }
});

test("project and upload-intent routes preserve client idempotency keys", async () => {
  const capture: { projectKey?: string; assetKey?: string } = {};
  const server = await buildServer(dependencies(capture));
  try {
    const project = await server.inject({
      method: "POST",
      url: "/v1/projects",
      headers: {
        authorization: "Bearer valid",
        "idempotency-key": "project-create:local-project-1",
      },
      payload: {
        workspaceId,
        clientProjectId: "local-project-1",
        title: "Cloud project",
        documentJson: {
          schemaVersion: 1,
          localProjectId: "local-project-1",
          document: {},
        },
      },
    });
    assert.equal(project.statusCode, 201, project.body);
    assert.equal(capture.projectKey, "project-create:local-project-1");

    const upload = await server.inject({
      method: "POST",
      url: "/v1/assets/upload-intents",
      headers: {
        authorization: "Bearer valid",
        "idempotency-key": `asset-upload:${"a".repeat(64)}`,
      },
      payload: {
        kind: "image",
        mime: "image/png",
        bytes: "8",
        sha256: "a".repeat(64),
        filename: "reference.png",
      },
    });
    assert.equal(upload.statusCode, 201, upload.body);
    assert.equal(capture.assetKey, `asset-upload:${"a".repeat(64)}`);
  } finally {
    await server.close();
  }
});

test("asset verification exposes in-progress state without a conflict response", async () => {
  const server = await buildServer(dependencies({
    assetCompleteStatus: "verifying",
    assetStatus: "verifying",
  }));
  try {
    const completion = await server.inject({
      method: "POST",
      url: `/v1/assets/${attemptId}/complete`,
      headers: { authorization: "Bearer valid" },
    });
    assert.equal(completion.statusCode, 202, completion.body);
    assert.deepEqual(completion.json(), { assetId: attemptId, status: "verifying" });
    const status = await server.inject({
      method: "GET",
      url: `/v1/assets/${attemptId}`,
      headers: { authorization: "Bearer valid" },
    });
    assert.equal(status.statusCode, 200, status.body);
    assert.deepEqual(status.json(), { assetId: attemptId, status: "verifying" });
  } finally {
    await server.close();
  }
});

test("a persisted idempotency key resolves a batch after a lost create response", async () => {
  const capture: {
    resolved?: { userId: string; projectId: string; key: string };
  } = {};
  const server = await buildServer(dependencies(capture));
  try {
    const response = await server.inject({
      method: "GET",
      url: `/v1/generation-batches/resolve?projectId=${projectId}&idempotencyKey=batch-key-123`,
      headers: { authorization: "Bearer valid" },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().batchId, batchId);
    assert.deepEqual(capture.resolved, {
      userId: "00000000-0000-4000-8000-000000000001",
      projectId,
      key: "batch-key-123",
    });
  } finally {
    await server.close();
  }
});

test("project active jobs preserve authoritative node and slot targets", async () => {
  const capture: Parameters<typeof dependencies>[0] = {};
  const server = await buildServer(dependencies(capture));
  const response = await server.inject({
    method: "GET",
    url: `/v1/projects/${projectId}/active-jobs`,
    headers: { authorization: "Bearer valid" },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(capture.activeJobsProjectId, projectId);
  assert.deepEqual(response.json().jobs[0], {
    batchId,
    jobId,
    slotIndex: 0,
    slotId: "slot-1",
    targetNodeId: "node-1",
    capability: "image",
    status: "running",
    jobVersion: 2,
    attemptId,
    attemptNo: 1,
  });
  await server.close();
});

test("admin provider mutations require and forward an idempotency key", async () => {
  const capture: Parameters<typeof dependencies>[0] = {};
  const server = await buildServer(dependencies(capture));
  try {
    const response = await server.inject({
      method: "POST",
      url: "/v1/admin/channels",
      headers: {
        authorization: "Bearer valid",
        "idempotency-key": "admin-channel-modal-request-0001",
      },
      payload: {
        name: "Provider",
        type: "openai",
        baseUrl: "https://provider.example",
        capabilities: ["image"],
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(capture.adminChannelKey, "admin-channel-modal-request-0001");
  } finally {
    await server.close();
  }
});

test("SSE replays strictly after Last-Event-ID before waiting for notifications", async () => {
  const event = generationEventSchema.parse({
    sequence: "42",
    type: "generation.job.state_changed",
    workspaceId: "00000000-0000-4000-8000-000000000101",
    projectId,
    batchId,
    jobId,
    attemptId,
    attemptNo: 1,
    jobVersion: 2,
    occurredAt: "2026-08-10T00:00:00.000Z",
    payload: { status: "running", attemptNo: 1, jobVersion: 2 },
  });
  const capture = { event, eventCursors: [] as string[] };
  const server = await buildServer(dependencies(capture));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(
      `${address}/v1/events?projectId=${projectId}&cursor=3`,
      {
        headers: {
          authorization: "Bearer valid",
          accept: "text/event-stream",
          "Last-Event-ID": "41",
        },
      },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.ok(response.body);
    reader = response.body.getReader();
    const chunk = await reader.read();
    const body = new TextDecoder().decode(chunk.value);
    assert.match(body, /id: 42/);
    assert.match(body, /event: generation\.job\.state_changed/);
    assert.match(body, /"jobVersion":2/);
    assert.deepEqual(capture.eventCursors, ["41"]);
  } finally {
    await reader?.cancel();
    await server.close();
  }
});

test("two API SSE connections recover one event when one instance loses NOTIFY", async () => {
  const event = generationEventSchema.parse({
    sequence: "42",
    type: "generation.job.state_changed",
    workspaceId: "00000000-0000-4000-8000-000000000101",
    projectId,
    batchId,
    jobId,
    attemptId,
    attemptNo: 1,
    jobVersion: 2,
    occurredAt: "2026-08-10T00:00:00.000Z",
    payload: { status: "running", attemptNo: 1, jobVersion: 2 },
  });
  const captureA: Parameters<typeof dependencies>[0] = { eventCursors: [], sseScanMs: 25 };
  const captureB: Parameters<typeof dependencies>[0] = { eventCursors: [], sseScanMs: 25 };
  const serverA = await buildServer(dependencies(captureA));
  const serverB = await buildServer(dependencies(captureB));
  const abortA = new AbortController();
  const abortB = new AbortController();
  try {
    const [addressA, addressB] = await Promise.all([
      serverA.listen({ host: "127.0.0.1", port: 0 }),
      serverB.listen({ host: "127.0.0.1", port: 0 }),
    ]);
    const [responseA, responseB] = await Promise.all([
      fetch(`${addressA}/v1/events?projectId=${projectId}&cursor=0`, {
        headers: { authorization: "Bearer valid", Accept: "text/event-stream" },
        signal: abortA.signal,
      }),
      fetch(`${addressB}/v1/events?projectId=${projectId}&cursor=0`, {
        headers: { authorization: "Bearer valid", Accept: "text/event-stream" },
        signal: abortB.signal,
      }),
    ]);
    assert.ok(responseA.body);
    assert.ok(responseB.body);
    let streamA = "";
    let streamB = "";
    const pump = async (response: Response, append: (chunk: string) => void) => {
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          append(value);
        }
      } catch {
        // Aborting the test connection terminates the pending stream read.
      }
    };
    const pumps = [
      pump(responseA, (chunk) => { streamA += chunk; }),
      pump(responseB, (chunk) => { streamB += chunk; }),
    ];
    for (let attempt = 0; attempt < 100 && (!captureA.subscriber || !captureB.subscriber); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(captureA.subscriber);
    assert.ok(captureB.subscriber);
    captureA.event = event;
    captureB.event = event;
    captureA.subscriber({ workspaceId: "workspace", sequence: event.sequence });
    for (let attempt = 0; attempt < 200 && (!streamA.includes("id: 42") || !streamB.includes("id: 42")); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.match(streamA, /id: 42/);
    assert.match(streamB, /id: 42/);
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(streamA.match(/id: 42/g)?.length, 1);
    assert.equal(streamB.match(/id: 42/g)?.length, 1);
    assert.ok(captureA.eventCursors!.includes("42"));
    assert.ok(captureB.eventCursors!.includes("42"));
    abortA.abort();
    abortB.abort();
    await Promise.all(pumps);
  } finally {
    abortA.abort();
    abortB.abort();
    await Promise.all([serverA.close(), serverB.close()]);
  }
});

test("SSE rejects an out-of-range Last-Event-ID before hijacking the response", async () => {
  const capture = { eventCursors: [] as string[] };
  const server = await buildServer(dependencies(capture));
  try {
    const response = await server.inject({
      method: "GET",
      url: `/v1/events?projectId=${projectId}`,
      headers: {
        authorization: "Bearer valid",
        "last-event-id": "9223372036854775808",
      },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, "invalid_request");
    assert.deepEqual(capture.eventCursors, []);
  } finally {
    await server.close();
  }
});
