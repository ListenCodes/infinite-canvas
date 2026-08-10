import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

import { chromium } from "playwright-core";

import { buildServer } from "../apps/api/dist/server.js";

const webRoot = resolve(process.argv[2] ?? "web/dist");
await access(resolve(webRoot, "index.html"));

const userId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000101";
const remoteProjectId = "00000000-0000-4000-8000-000000000201";
const batchId = "00000000-0000-4000-8000-000000000321";
const successJobId = "00000000-0000-4000-8000-000000000421";
const capacityJobId = "00000000-0000-4000-8000-000000000422";
const moderationJobId = "00000000-0000-4000-8000-000000000423";
const successAttemptId = "00000000-0000-4000-8000-000000000521";
const originalCapacityAttemptId = "00000000-0000-4000-8000-000000000522";
const originalModerationAttemptId = "00000000-0000-4000-8000-000000000523";
const retryCapacityAttemptId = "00000000-0000-4000-8000-000000000532";
const retryModerationAttemptId = "00000000-0000-4000-8000-000000000533";
const successAssetId = "00000000-0000-4000-8000-000000000621";
const localProjectId = "e2e-local-project";
const nodeId = "e2e-image-node";
const email = "three-slot-retry@example.invalid";
const password = "local-fixture-password";
const pngDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const timestamps = {
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:01:00.000Z",
};

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
const issuedTokens = new Set();
const retryCalls = [];
const counters = { token: 0, create: 0, getBatch: 0, activeJobs: 0, projectUpdates: 0, signed: 0 };
let apiOrigin = "";
let authOrigin = "";
let retryBarrierResolve;
const retryBarrier = new Promise((resolveBarrier) => {
    retryBarrierResolve = resolveBarrier;
});

function unusedService() {
    return new Proxy({}, { get: (_target, property) => async () => { throw new Error(`Unexpected fixture call: ${String(property)}`); } });
}

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
    throw new Error("A supported Chrome/Edge executable is required for three-slot retry verification");
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

function jobProjection(jobId, slotIndex, slotId, status, errorMessage, attemptId, assetId) {
    return {
        batchId,
        jobId,
        slotIndex,
        slotId,
        status,
        jobVersion: status === "succeeded" ? 2 : status === "failed" ? 4 : 3,
        attemptId,
        attemptNo: jobId === successJobId ? 1 : 2,
        ...(assetId ? { assetId } : {}),
        ...(errorMessage ? { errorCode: slotId === "slot-capacity" ? "provider_capacity" : "provider_moderation", errorMessage } : {}),
    };
}

function finalBatch() {
    return {
        batchId,
        projectId: remoteProjectId,
        status: "partial_succeeded",
        requestedCount: 3,
        jobs: [
            jobProjection(successJobId, 0, "slot-success", "succeeded", undefined, successAttemptId, successAssetId),
            jobProjection(capacityJobId, 1, "slot-capacity", "failed", "Provider capacity remained exhausted after retry", retryCapacityAttemptId),
            jobProjection(moderationJobId, 2, "slot-moderation", "failed", "Prompt remained rejected by moderation", retryModerationAttemptId),
        ],
        eventCursor: "31",
    };
}

const authServer = createServer(async (request, response) => {
    const cors = {
        "access-control-allow-origin": request.headers.origin ?? "*",
        "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        vary: "Origin",
    };
    if (request.method === "OPTIONS") {
        response.writeHead(204, cors);
        response.end();
        return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/fixture/success.png") {
        response.writeHead(200, { ...cors, "content-type": "image/png", "cache-control": "no-store" });
        response.end(Buffer.from(pngDataUrl.split(",")[1], "base64"));
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
    assert.equal(body.email, email);
    assert.equal(body.password, password);
    counters.token += 1;
    const accessToken = jwt(counters.token);
    issuedTokens.add(accessToken);
    const now = new Date().toISOString();
    response.writeHead(200, { ...cors, "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({
        access_token: accessToken,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: `local-refresh-${counters.token}`,
        user: {
            id: userId,
            aud: "authenticated",
            role: "authenticated",
            email,
            email_confirmed_at: now,
            phone: "",
            app_metadata: { provider: "email", providers: ["email"] },
            user_metadata: { display_name: "Three Slot Gate" },
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

const project = {
    id: localProjectId,
    title: "Parallel retry fixture",
    ...timestamps,
    nodes: [{
        id: nodeId,
        type: "image",
        title: "Parallel retry fixture",
        position: { x: 500, y: 400 },
        width: 340,
        height: 240,
        metadata: {
            content: pngDataUrl,
            storageKey: "image:e2e-success",
            status: "success",
            prompt: "parallel retry fixture",
            count: 3,
            primaryImageId: "slot-success",
            cloudBatchId: batchId,
            images: [
                {
                    id: "slot-success", status: "success", content: pngDataUrl,
                    storageKey: "image:e2e-success", naturalWidth: 1, naturalHeight: 1,
                    bytes: 68, mimeType: "image/png",
                    cloud: { batchId, jobId: successJobId, slotId: "slot-success", jobVersion: 2, attemptId: successAttemptId, attemptNo: 1, serverStatus: "succeeded", assetId: successAssetId },
                },
                {
                    id: "slot-capacity", status: "error", errorDetails: "Provider capacity was exhausted",
                    content: "", storageKey: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "",
                    cloud: { batchId, jobId: capacityJobId, slotId: "slot-capacity", jobVersion: 2, attemptId: originalCapacityAttemptId, attemptNo: 1, serverStatus: "failed" },
                },
                {
                    id: "slot-moderation", status: "error", errorDetails: "Prompt was rejected by moderation",
                    content: "", storageKey: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "",
                    cloud: { batchId, jobId: moderationJobId, slotId: "slot-moderation", jobVersion: 2, attemptId: originalModerationAttemptId, attemptNo: 1, serverStatus: "failed" },
                },
            ],
        },
    }],
    connections: [],
    chatSessions: [],
    activeChatId: null,
    backgroundMode: "lines",
    showImageInfo: false,
    viewport: { x: 0, y: 0, k: 1 },
    cloud: { projectId: remoteProjectId, version: 1, workspaceId, userId },
};

let browser;
let api;
try {
    const applicationOrigin = await listen(webServer, "three-slot Web server");
    authOrigin = await listen(authServer, "three-slot Auth server");
    api = await buildServer({
        config: {
            NODE_ENV: "test",
            HOST: "127.0.0.1",
            PORT: 0,
            LOG_LEVEL: "silent",
            METRICS_BEARER_TOKEN: "local-metrics-token",
            BUSINESS_DATABASE_URL: "postgres://local:local@127.0.0.1/local",
            BUSINESS_DATABASE_LISTENER_URL: "postgres://local:local@127.0.0.1/local",
            SUPABASE_URL: authOrigin,
            SUPABASE_JWT_AUDIENCE: "authenticated",
            SUPABASE_SERVICE_ROLE_KEY: "local-service-role-key",
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
                    wallet: { available: "100", reserved: "0" },
                };
            },
            async list() { return []; },
            async get() { throw new Error("Project GET is not used by the three-slot fixture"); },
            async create() { throw new Error("Project creation is not used by the three-slot fixture"); },
            async update(_user, id, input) {
                assert.equal(id, remoteProjectId);
                counters.projectUpdates += 1;
                return { id, workspaceId, title: input.title, documentJson: input.documentJson, version: input.version + 1, ...timestamps };
            },
        },
        assetService: {
            async signedDownload(_user, id) {
                assert.equal(id, successAssetId);
                counters.signed += 1;
                return { assetId: id, signedUrl: `${authOrigin}/fixture/success.png`, expiresIn: 60 };
            },
            async createUploadIntent() { throw new Error("Upload intent is not used by the three-slot fixture"); },
            async completeUpload() { throw new Error("Upload completion is not used by the three-slot fixture"); },
            async status() { throw new Error("Asset status is not used by the three-slot fixture"); },
        },
        importService: unusedService(),
        generationService: {
            async listModels() { return []; },
            async createBatch() {
                counters.create += 1;
                throw new Error("Recovery retry must not create a generation batch");
            },
            async getBatch(_user, id) {
                assert.equal(id, batchId);
                counters.getBatch += 1;
                return finalBatch();
            },
            async activeJobs(_user, id) {
                assert.equal(id, remoteProjectId);
                counters.activeJobs += 1;
                return { projectId: remoteProjectId, projectVersion: 1, jobs: [], eventCursor: "0" };
            },
            async resolveBatch() { throw new Error("Batch resolution is not used by the three-slot fixture"); },
            async listJobs() { return { jobs: [], eventCursor: "0", nextCursor: null }; },
            async retryJob(_user, jobId, idempotencyKey) {
                assert.ok([capacityJobId, moderationJobId].includes(jobId));
                assert.match(idempotencyKey, /^retry:/);
                retryCalls.push({ jobId, idempotencyKey });
                if (retryCalls.length === 2) {
                    setTimeout(retryBarrierResolve, 150);
                }
                await retryBarrier;
                return jobProjection(
                    jobId,
                    jobId === capacityJobId ? 1 : 2,
                    jobId === capacityJobId ? "slot-capacity" : "slot-moderation",
                    "queued",
                    undefined,
                    jobId === capacityJobId ? retryCapacityAttemptId : retryModerationAttemptId,
                );
            },
            async cancelJob() { throw new Error("Cancellation is not used by the three-slot fixture"); },
        },
        eventService: {
            async workspaceForUser() { return workspaceId; },
            async after() { return []; },
        },
        eventBroker: { async start() {}, subscribe() { return () => {}; }, async close() {} },
        readinessProbe: async () => {},
        adminService: unusedService(),
    });
    apiOrigin = await api.listen({ host: "127.0.0.1", port: 0 });

    browser = await chromium.launch({ executablePath: await browserExecutable(), headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext({ serviceWorkers: "block" });
    const requestFailures = [];
    const pageErrors = [];
    context.on("requestfailed", (request) => {
        if (request.url().includes("/generation-jobs/") && request.url().endsWith("/retry")) requestFailures.push(request.failure()?.errorText ?? "unknown");
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${applicationOrigin}/canvas`, { waitUntil: "networkidle" });
    await page.locator("button").filter({ hasText: /登录|Sign in/i }).first().click();
    await page.locator('input[autocomplete="email"]').fill(email);
    await page.locator('input[autocomplete="current-password"]').fill(password);
    const bootstrap = page.waitForResponse((response) => response.url() === `${apiOrigin}/v1/session/bootstrap` && response.status() === 200);
    await page.locator('.ant-modal button[type="submit"]').click();
    await bootstrap;

    await page.evaluate(async ({ project, png }) => {
        const open = (version) => new Promise((resolveOpen, rejectOpen) => {
            const request = version ? indexedDB.open("infinite-canvas", version) : indexedDB.open("infinite-canvas");
            request.onerror = () => rejectOpen(request.error);
            request.onsuccess = () => resolveOpen(request.result);
            request.onupgradeneeded = () => {
                const db = request.result;
                for (const name of ["app_state", "image_files"]) {
                    if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
                }
            };
        });
        let db = await open();
        const missing = ["app_state", "image_files"].filter((name) => !db.objectStoreNames.contains(name));
        if (missing.length) {
            const version = db.version + 1;
            db.close();
            db = await open(version);
        }
        const imageBlob = await (await fetch(png)).blob();
        const transaction = db.transaction(["app_state", "image_files"], "readwrite");
        transaction.objectStore("app_state").put(JSON.stringify({ state: { projects: [project] }, version: 0 }), "infinite-canvas:canvas_store");
        transaction.objectStore("image_files").put(imageBlob, "image:e2e-success");
        await new Promise((resolveTransaction, rejectTransaction) => {
            transaction.oncomplete = resolveTransaction;
            transaction.onerror = () => rejectTransaction(transaction.error);
            transaction.onabort = () => rejectTransaction(transaction.error);
        });
        db.close();
    }, { project, png: pngDataUrl });

    await page.goto(`${applicationOrigin}/canvas/${localProjectId}`, { waitUntil: "networkidle" });
    const node = page.locator(`[data-node-id="${nodeId}"]`);
    await node.waitFor({ state: "visible", timeout: 30_000 });
    await node.getByRole("button", { name: /图片组已收起|Image group collapsed/i }).click();
    await node.getByText("Provider capacity was exhausted", { exact: true }).waitFor({ state: "visible" });
    await node.getByText("Prompt was rejected by moderation", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await node.locator('img[alt="Parallel retry fixture"]').count(), 1);

    const retryButtons = node.getByRole("button", { name: /^(重试|Retry)$/i });
    assert.equal(await retryButtons.count(), 2);
    await retryButtons.evaluateAll((buttons) => buttons.forEach((button) => button.click()));
    await node.getByText("Provider capacity remained exhausted after retry", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await node.getByText("Prompt remained rejected by moderation", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

    assert.equal(retryCalls.length, 2);
    assert.deepEqual(new Set(retryCalls.map((call) => call.jobId)), new Set([capacityJobId, moderationJobId]));
    assert.equal(new Set(retryCalls.map((call) => call.idempotencyKey)).size, 2);
    assert.deepEqual(requestFailures, []);
    assert.equal(counters.create, 0);
    assert.ok(counters.getBatch >= 1);
    assert.equal(counters.signed, 1);
    assert.equal(counters.token, 1);
    assert.equal(await node.locator('img[alt="Parallel retry fixture"]').count(), 1);
    assert.deepEqual(pageErrors, []);
    await context.close();
    console.log("Browser three-slot independent retry verification passed");
} finally {
    await browser?.close();
    await api?.close();
    await Promise.all([closeServer(webServer), closeServer(authServer)]);
}
