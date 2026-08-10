import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

import { chromium } from "playwright-core";

import { buildServer } from "../apps/api/dist/server.js";
import { findCanaryLocations, scanBrowserStorage } from "./browser-boundary-scan.mjs";

const webRoot = resolve(process.argv[2] ?? "web/dist");
const startupTimeoutMs = Number(process.env.BROWSER_STARTUP_TIMEOUT_MS ?? "30000");
if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 100 || startupTimeoutMs > 60_000) {
  throw new Error("BROWSER_STARTUP_TIMEOUT_MS must be an integer from 100 to 60000");
}
await access(resolve(webRoot, "index.html"));

const userId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000101";
const projectId = "00000000-0000-4000-8000-000000000201";
const modelConfigId = "00000000-0000-4000-8000-000000000401";
const batchId = "00000000-0000-4000-8000-000000000601";
const jobId = "00000000-0000-4000-8000-000000000701";
const attemptId = "00000000-0000-4000-8000-000000000801";
const email = "relogin-recovery@example.invalid";
const password = "local-fixture-password";
const platformCanaries = (process.env.SECRET_SCAN_CANARIES ?? "local-service-secret-canary-0001,local-hatchet-secret-canary-0002,local-credential-secret-canary-0003")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (platformCanaries.length !== 3) throw new Error("SECRET_SCAN_CANARIES must contain exactly three values");
const timestamps = {
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:01:00.000Z",
};

const counters = {
  tokenIssues: 0,
  create: 0,
  providerSubmit: 0,
  list: 0,
  retry: 0,
  cancel: 0,
};
const state = { created: false, status: "running" };
const issuedTokens = new Set();
let apiOrigin = "";
let authOrigin = "";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function browserExecutable() {
  const candidates = [
    process.env.BROWSER_EXECUTABLE_PATH,
    process.platform === "win32" ? `${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
    process.platform === "win32" ? `${process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe` : undefined,
    process.platform === "win32" ? `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  throw new Error("A supported Chrome/Edge executable is required for relogin recovery verification");
}

async function staticFile(pathname) {
  const requested = decodeURIComponent(pathname).replace(/^\/+/, "");
  let path = resolve(webRoot, requested || "index.html");
  if (path !== webRoot && !path.startsWith(`${webRoot}${sep}`)) throw new Error("Unsafe static path");
  const info = await stat(path).catch(() => undefined);
  if (info?.isDirectory()) path = resolve(path, "index.html");
  if (!await stat(path).then((value) => value.isFile()).catch(() => false)) {
    if (extname(requested)) throw new Error("Static asset was not found");
    path = resolve(webRoot, "index.html");
  }
  return path;
}

function listen(server, label) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") rejectListen(new Error(`Failed to bind ${label}`));
      else resolveListen(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server) {
  return server.listening
    ? new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
    : Promise.resolve();
}

function jwt(counter) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: userId, aud: "authenticated", role: "authenticated", email, iat: now, exp: now + 3600, fixture: counter })}.local-signature`;
}

const authServer = createServer(async (request, response) => {
  const cors = {
    "access-control-allow-origin": request.headers.origin ?? "*",
    "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "60",
    vary: "Origin",
  };
  if (request.method === "OPTIONS") {
    response.writeHead(204, cors);
    response.end();
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/auth/v1/boundary-probe") {
    response.writeHead(200, { ...cors, "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ probe: platformCanaries[0] }));
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/auth/v1/token" || url.searchParams.get("grant_type") !== "password") {
    response.writeHead(404, { ...cors, "content-type": "application/json" });
    response.end(JSON.stringify({ message: "Not found" }));
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (body.email !== email || body.password !== password) {
    response.writeHead(400, { ...cors, "content-type": "application/json" });
    response.end(JSON.stringify({ error: "invalid_grant", error_description: "Invalid credentials" }));
    return;
  }
  counters.tokenIssues += 1;
  const accessToken = jwt(counters.tokenIssues);
  issuedTokens.add(accessToken);
  const now = new Date().toISOString();
  response.writeHead(200, { ...cors, "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: `local-refresh-${counters.tokenIssues}`,
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email,
      email_confirmed_at: now,
      phone: "",
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: { display_name: "Recovery Fixture" },
      identities: [],
      created_at: now,
      updated_at: now,
      is_anonymous: false,
    },
  }));
});

const webServer = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/config.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(`window.__RUNTIME_CONFIG__=${JSON.stringify({
        CLOUD_BACKEND_ENABLED: "true",
        API_BASE_URL: apiOrigin,
        SUPABASE_URL: authOrigin,
        SUPABASE_ANON_KEY: "local-public-anon-key",
      })};`);
      return;
    }
    const path = await staticFile(pathname);
    response.writeHead(200, { "content-type": contentTypes[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
    response.end(await readFile(path));
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

function taskProjection() {
  return {
    batchId,
    jobId,
    slotIndex: 0,
    slotId: "slot-1",
    status: state.status,
    jobVersion: state.status === "succeeded" ? 2 : 1,
    attemptId,
    attemptNo: 1,
    workspaceId,
    projectId,
    capability: "image",
    ...timestamps,
  };
}

function unusedService(boundaryValue = "") {
  void boundaryValue;
  return new Proxy({}, { get: (_target, property) => async () => { throw new Error(`Unexpected fixture call: ${String(property)}`); } });
}

let browser;
let api;
try {
  const applicationOrigin = await listen(webServer, "relogin recovery Web server");
  authOrigin = await listen(authServer, "relogin recovery Auth server");
  api = await buildServer({
    config: {
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: 0,
      LOG_LEVEL: "silent",
      METRICS_BEARER_TOKEN: platformCanaries[1],
      BUSINESS_DATABASE_URL: "postgres://local:local@127.0.0.1/local",
      BUSINESS_DATABASE_LISTENER_URL: "postgres://local:local@127.0.0.1/local",
      SUPABASE_URL: authOrigin,
      SUPABASE_JWT_AUDIENCE: "authenticated",
      SUPABASE_SERVICE_ROLE_KEY: platformCanaries[0],
      CREDENTIAL_MASTER_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      STORAGE_BUCKET: "local",
      CORS_ALLOWED_ORIGINS: applicationOrigin,
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
    },
    authenticator: {
      async authenticate(authorization) {
        const token = authorization?.replace(/^Bearer\s+/i, "");
        assert.ok(token && issuedTokens.has(token), "API received an unissued browser token");
        return { userId, email, expiresAt: Date.now() + 60_000 };
      },
    },
    projectService: {
      async assertAccountAccess() {},
      async bootstrap() {
        return {
          userId,
          workspaceId,
          role: "owner",
          platformRole: "user",
          featureFlags: { projects: true, imageGeneration: true, videoGeneration: true, credits: true },
          wallet: { available: "90", reserved: state.created && state.status !== "succeeded" ? "10" : "0" },
        };
      },
      async list() { return []; },
      async get() { throw new Error("Project reads are not used by the tasks recovery fixture"); },
      async create() { throw new Error("Project creation is not used by the tasks recovery fixture"); },
      async update() { throw new Error("Project updates are not used by the tasks recovery fixture"); },
    },
    assetService: unusedService(),
    importService: unusedService(),
    generationService: {
      async listModels() { return []; },
      async createBatch(_user, input, key) {
        assert.equal(key, "browser-relogin-batch-0001");
        assert.equal(input.projectId, projectId);
        counters.create += 1;
        counters.providerSubmit += 1;
        state.created = true;
        state.status = "running";
        return {
          batchId,
          status: "running",
          jobs: [taskProjection()],
          credits: { reserved: "10", available: "90" },
          eventCursor: "1",
        };
      },
      async getBatch() { throw new Error("Batch reads are not used by the tasks recovery fixture"); },
      async activeJobs() { throw new Error("Project active jobs are not used by the tasks recovery fixture"); },
      async resolveBatch() { throw new Error("Batch resolution is not used by the tasks recovery fixture"); },
      async listJobs() {
        counters.list += 1;
        return { jobs: state.created ? [taskProjection()] : [], eventCursor: state.created ? "2" : "0", nextCursor: null };
      },
      async retryJob() { counters.retry += 1; throw new Error("Recovery must not retry a terminal job"); },
      async cancelJob() { counters.cancel += 1; throw new Error("Recovery must not cancel a terminal job"); },
    },
    eventService: unusedService(),
    eventBroker: { async start() {}, subscribe() { return () => {}; }, async close() {} },
    readinessProbe: async () => {},
    adminService: unusedService(platformCanaries[2]),
  });
  apiOrigin = await api.listen({ host: "127.0.0.1", port: 0 });

  browser = await chromium.launch({ executablePath: await browserExecutable(), headless: true, args: ["--no-sandbox"] });
  const allowedOrigins = new Set([applicationOrigin, apiOrigin, authOrigin]);
  const blockedHttpRequests = [];
  const blockedWebSockets = [];
  const externalHttpResponses = [];
  const networkBoundaryRecords = [];
  const responseCapturePromises = [];
  const inspectedOrigins = new Set([apiOrigin, authOrigin]);
  const createContext = async () => {
    const context = await browser.newContext({ serviceWorkers: "block" });
    context.on("request", (request) => {
      const url = new URL(request.url());
      if (!inspectedOrigins.has(url.origin)) return;
      networkBoundaryRecords.push({
        kind: "request",
        url: request.url(),
        headers: request.headers(),
        body: request.postData() ?? "",
      });
    });
    context.on("response", (response) => {
      const url = new URL(response.url());
      if (["http:", "https:"].includes(url.protocol) && !allowedOrigins.has(url.origin)) {
        externalHttpResponses.push(url.href);
      }
      if (inspectedOrigins.has(url.origin)) {
        responseCapturePromises.push((async () => {
          const contentType = response.headers()["content-type"] ?? "";
          const body = /json|text|event-stream/i.test(contentType)
            ? await response.text().catch(() => "")
            : "";
          networkBoundaryRecords.push({
            kind: "response",
            url: response.url(),
            status: response.status(),
            headers: response.headers(),
            body: body.length <= 2 * 1024 * 1024 ? body : "response-too-large",
          });
        })());
      }
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (!["http:", "https:"].includes(url.protocol) || allowedOrigins.has(url.origin)) {
        await route.continue();
        return;
      }
      blockedHttpRequests.push(url.href);
      await route.abort("blockedbyclient");
    });
    await context.routeWebSocket(/.*/, async (route) => {
      blockedWebSockets.push(route.url());
      await route.close({ code: 1008, reason: "WebSocket access is disabled in the recovery gate" });
    });
    return context;
  };
  const signIn = async (page) => {
    await page.locator('button').filter({ hasText: /登录|Sign in/i }).first().click();
    await page.locator('input[autocomplete="email"]').fill(email);
    await page.locator('input[autocomplete="current-password"]').fill(password);
    const bootstrap = page.waitForResponse((response) => response.url() === `${apiOrigin}/v1/session/bootstrap` && response.status() === 200);
    await page.locator('.ant-modal button[type="submit"]').click();
    await bootstrap;
    await page.locator("h1").waitFor({ state: "visible", timeout: startupTimeoutMs });
  };

  const contextA = await createContext();
  const pageA = await contextA.newPage();
  await pageA.goto(`${applicationOrigin}/tasks`, { waitUntil: "networkidle" });
  await signIn(pageA);
  const createResult = await pageA.evaluate(async ({ api, request }) => {
    let token;
    for (const value of Object.values(localStorage)) {
      try {
        const parsed = JSON.parse(value);
        if (parsed?.access_token) { token = parsed.access_token; break; }
      } catch {}
    }
    if (!token) throw new Error("Authenticated Supabase session was not persisted");
    const response = await fetch(`${api}/v1/generation-batches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "browser-relogin-batch-0001",
      },
      body: JSON.stringify(request),
    });
    return { status: response.status, body: await response.json() };
  }, {
    api: apiOrigin,
    request: {
      projectId,
      kind: "image",
      count: 1,
      target: { nodeId: "node-1", slotIds: ["slot-1"] },
      modelConfigId,
      input: { prompt: "browser relogin recovery", referenceAssetIds: [], parameters: {} },
      projectVersion: 1,
    },
  });
  assert.equal(createResult.status, 202);
  assert.equal(createResult.body.batchId, batchId);
  assert.equal(counters.create, 1);
  assert.equal(counters.providerSubmit, 1);
  await contextA.close();

  state.status = "succeeded";
  const contextB = await createContext();
  const pageB = await contextB.newPage();
  await pageB.goto(`${applicationOrigin}/tasks`, { waitUntil: "networkidle" });
  const preLoginStorage = await pageB.evaluate(() => Object.values(localStorage).join("\n"));
  assert.doesNotMatch(preLoginStorage, /access_token|local-refresh-/, "new browser context reused the previous session");
  await signIn(pageB);
  await pageB.locator(".ant-tag").filter({ hasText: /成功|succeeded/i }).waitFor({ state: "visible", timeout: startupTimeoutMs });
  const isolationProbe = {
    http: "https://browser-recovery-boundary.invalid/probe",
    websocket: "wss://browser-recovery-boundary.invalid/socket",
  };
  await pageB.evaluate(async ({ http, websocket }) => {
    await fetch(http).catch(() => undefined);
    await new Promise((resolveProbe) => {
      const socket = new WebSocket(websocket);
      const finish = () => resolveProbe();
      socket.addEventListener("close", finish, { once: true });
      socket.addEventListener("error", finish, { once: true });
      window.setTimeout(finish, 1_000);
    });
  }, isolationProbe);
  assert.equal(counters.tokenIssues, 2);
  assert.equal(counters.create, 1);
  assert.equal(counters.providerSubmit, 1);
  assert.equal(counters.retry, 0);
  assert.equal(counters.cancel, 0);
  assert.ok(counters.list >= 2);
  assert.equal(state.status, "succeeded");
  assert.ok(blockedHttpRequests.includes(isolationProbe.http), "HTTP isolation probe was not blocked");
  assert.deepEqual(externalHttpResponses, [], "a non-local HTTP request received a response");
  assert.ok(blockedWebSockets.includes(isolationProbe.websocket), "WebSocket isolation probe was not blocked");

  await pageB.evaluate(async (origin) => {
    const response = await fetch(`${origin}/auth/v1/boundary-probe`);
    if (!response.ok) throw new Error("Network boundary positive probe failed");
    await response.json();
  }, authOrigin);
  await Promise.all(responseCapturePromises);
  const positiveNetworkRecords = networkBoundaryRecords.filter((record) => record.url.includes("/auth/v1/boundary-probe"));
  assert.ok(findCanaryLocations(positiveNetworkRecords, platformCanaries).length > 0, "network scanner did not detect its positive probe");
  const operationalNetworkRecords = networkBoundaryRecords.filter((record) => !record.url.includes("/auth/v1/boundary-probe"));
  assert.deepEqual(findCanaryLocations(operationalNetworkRecords, platformCanaries), [], "platform canary leaked through authenticated browser traffic");

  assert.deepEqual(await scanBrowserStorage(pageB, platformCanaries), [], "platform canary leaked into authenticated browser storage");
  await pageB.evaluate((canary) => localStorage.setItem("__platform_boundary_positive_probe__", canary), platformCanaries[2]);
  assert.ok((await scanBrowserStorage(pageB, platformCanaries)).length > 0, "storage scanner did not detect its positive probe");
  await pageB.evaluate(() => localStorage.removeItem("__platform_boundary_positive_probe__"));
  assert.deepEqual(await scanBrowserStorage(pageB, platformCanaries), [], "storage positive probe cleanup failed");
  await contextB.close();
  process.stdout.write("Browser close and relogin generation recovery passed\n");
} finally {
  await browser?.close();
  await api?.close();
  await Promise.all([closeServer(authServer), closeServer(webServer)]);
}
