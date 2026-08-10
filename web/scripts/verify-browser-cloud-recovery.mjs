import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";

const webRoot = resolve(import.meta.dirname, "..");
const gatePath = "/scripts/fixtures/cloud-recovery-gate.html";
const userId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000101";
const email = "cloud-recovery-gate@example.invalid";
const password = "local-fixture-password";
const sseProjectId = "00000000-0000-4000-8000-000000000211";
const sseBatchId = "00000000-0000-4000-8000-000000000311";
const timestamps = { occurredAt: "2026-08-10T00:00:00.000Z" };

const scenarios = {
    before_task_id: {
        projectId: "00000000-0000-4000-8000-000000000221",
        batchId: "00000000-0000-4000-8000-000000000321",
        jobId: "00000000-0000-4000-8000-000000000421",
        attemptId: "00000000-0000-4000-8000-000000000521",
        assetId: null,
        status: "outcome_unknown",
        idempotencyKey: "browser-video-before-task-id-0001",
    },
    after_task_id: {
        projectId: "00000000-0000-4000-8000-000000000222",
        batchId: "00000000-0000-4000-8000-000000000322",
        jobId: "00000000-0000-4000-8000-000000000422",
        attemptId: "00000000-0000-4000-8000-000000000522",
        assetId: "00000000-0000-4000-8000-000000000622",
        status: "succeeded",
    },
    polling: {
        projectId: "00000000-0000-4000-8000-000000000223",
        batchId: "00000000-0000-4000-8000-000000000323",
        jobId: "00000000-0000-4000-8000-000000000423",
        attemptId: "00000000-0000-4000-8000-000000000523",
        assetId: "00000000-0000-4000-8000-000000000623",
        status: "succeeded",
    },
    downloading: {
        projectId: "00000000-0000-4000-8000-000000000224",
        batchId: "00000000-0000-4000-8000-000000000324",
        jobId: "00000000-0000-4000-8000-000000000424",
        attemptId: "00000000-0000-4000-8000-000000000524",
        assetId: "00000000-0000-4000-8000-000000000624",
        status: "succeeded",
    },
};

const counters = {
    create: 0,
    token: 0,
    signed: new Map(),
    video: new Map(),
    snapshots: new Map(),
    sse: [],
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
    throw new Error("A supported Chrome/Edge executable is required for cloud recovery verification");
}

function json(response, status, body) {
    response.statusCode = status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(JSON.stringify(body));
}

async function requestBody(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
}

function jwt(counter) {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: userId, aud: "authenticated", role: "authenticated", email, iat: now, exp: now + 3600, fixture: counter })}.local-signature`;
}

function findScenarioByBatch(batchId) {
    return Object.values(scenarios).find((scenario) => scenario.batchId === batchId);
}

function findScenarioByProject(projectId) {
    return Object.values(scenarios).find((scenario) => scenario.projectId === projectId);
}

function jobProjection(scenario) {
    return {
        batchId: scenario.batchId,
        jobId: scenario.jobId,
        slotIndex: 0,
        slotId: "video-slot-1",
        status: scenario.status,
        jobVersion: scenario.status === "succeeded" ? 3 : 2,
        attemptId: scenario.attemptId,
        attemptNo: 1,
        ...(scenario.assetId ? { assetId: scenario.assetId } : {}),
        ...(scenario.status === "outcome_unknown" ? { errorCode: "provider_outcome_unknown", errorMessage: "Provider acceptance could not be confirmed" } : {}),
    };
}

function batchSnapshot(scenario) {
    return {
        batchId: scenario.batchId,
        projectId: scenario.projectId,
        status: scenario.status === "succeeded" ? "succeeded" : "running",
        requestedCount: 1,
        jobs: [jobProjection(scenario)],
        eventCursor: scenario.status === "succeeded" ? "31" : "21",
    };
}

function event(sequence) {
    return {
        sequence,
        type: "generation.job.state_changed",
        workspaceId,
        projectId: sseProjectId,
        batchId: sseBatchId,
        jobId: "00000000-0000-4000-8000-000000000411",
        attemptId: "00000000-0000-4000-8000-000000000511",
        attemptNo: 1,
        jobVersion: Number(sequence),
        occurredAt: timestamps.occurredAt,
        payload: { status: "running" },
    };
}

function fixturePlugin() {
    return {
        name: "cloud-recovery-browser-gate",
        configureServer(server) {
            server.middlewares.use(async (request, response, next) => {
                try {
                    const origin = `http://${request.headers.host}`;
                    const url = new URL(request.url ?? "/", origin);
                    if (request.method === "POST" && url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
                        const body = await requestBody(request);
                        assert.equal(body?.email, email);
                        assert.equal(body?.password, password);
                        counters.token += 1;
                        const now = new Date().toISOString();
                        json(response, 200, {
                            access_token: jwt(counters.token),
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
                                user_metadata: { display_name: "Recovery Gate" },
                                identities: [],
                                created_at: now,
                                updated_at: now,
                                is_anonymous: false,
                            },
                        });
                        return;
                    }
                    if (request.method === "POST" && url.pathname === "/api/v1/session/bootstrap") {
                        json(response, 200, {
                            userId,
                            workspaceId,
                            role: "owner",
                            platformRole: "user",
                            featureFlags: { projects: true, imageGeneration: true, videoGeneration: true, credits: true },
                            wallet: { available: "100", reserved: "0" },
                        });
                        return;
                    }
                    if (request.method === "POST" && url.pathname === "/api/v1/generation-batches") {
                        counters.create += 1;
                        json(response, 500, { error: { code: "unexpected_create", message: "Recovery must not create a batch", retryable: false, correlationId: "browser-gate" } });
                        return;
                    }
                    if (request.method === "GET" && url.pathname === "/api/v1/generation-batches/resolve") {
                        const scenario = findScenarioByProject(url.searchParams.get("projectId"));
                        assert.ok(scenario?.idempotencyKey);
                        assert.equal(url.searchParams.get("idempotencyKey"), scenario.idempotencyKey);
                        json(response, 200, batchSnapshot(scenario));
                        return;
                    }
                    const batchMatch = url.pathname.match(/^\/api\/v1\/generation-batches\/([^/]+)$/);
                    if (request.method === "GET" && batchMatch) {
                        const batchId = batchMatch[1];
                        if (batchId === sseBatchId) {
                            const calls = (counters.snapshots.get(batchId) ?? 0) + 1;
                            counters.snapshots.set(batchId, calls);
                            const cursor = calls <= 2 ? "10" : "25";
                            json(response, 200, {
                                batchId: sseBatchId,
                                projectId: sseProjectId,
                                status: "running",
                                requestedCount: 1,
                                jobs: [{
                                    batchId: sseBatchId,
                                    jobId: "00000000-0000-4000-8000-000000000411",
                                    slotIndex: 0,
                                    slotId: "sse-slot-1",
                                    status: "running",
                                    jobVersion: calls,
                                    attemptId: "00000000-0000-4000-8000-000000000511",
                                    attemptNo: 1,
                                }],
                                eventCursor: cursor,
                            });
                            return;
                        }
                        const scenario = findScenarioByBatch(batchId);
                        assert.ok(scenario, `Unknown generation batch ${batchId}`);
                        counters.snapshots.set(batchId, (counters.snapshots.get(batchId) ?? 0) + 1);
                        json(response, 200, batchSnapshot(scenario));
                        return;
                    }
                    if (request.method === "GET" && url.pathname === "/api/v1/events") {
                        const projectId = url.searchParams.get("projectId");
                        const cursor = url.searchParams.get("cursor");
                        const lastEventId = request.headers["last-event-id"];
                        if (projectId === sseProjectId) {
                            const call = counters.sse.length + 1;
                            counters.sse.push({ call, cursor, lastEventId });
                            if (call === 1) {
                                assert.equal(cursor, "10");
                                assert.equal(lastEventId, "10");
                                response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
                                response.end(`id: 12\ndata: ${JSON.stringify(event("12"))}\n\n`);
                                return;
                            }
                            if (call === 2) {
                                assert.equal(cursor, "12");
                                assert.equal(lastEventId, "12");
                                json(response, 409, { error: { code: "invalid_request", message: "Event cursor expired", retryable: true, correlationId: "browser-gate-sse-2", details: { reason: "event_cursor_expired" } } });
                                return;
                            }
                            assert.equal(call, 3);
                            assert.equal(cursor, "25");
                            assert.equal(lastEventId, "25");
                            response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
                            response.end(`id: 26\ndata: ${JSON.stringify(event("26"))}\n\n`);
                            return;
                        }
                        const scenario = findScenarioByProject(projectId);
                        assert.ok(scenario, `Unknown event project ${projectId}`);
                        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
                        response.end();
                        return;
                    }
                    const signedMatch = url.pathname.match(/^\/api\/v1\/assets\/([^/]+)\/signed-url$/);
                    if (request.method === "GET" && signedMatch) {
                        const assetId = signedMatch[1];
                        const scenario = Object.values(scenarios).find((candidate) => candidate.assetId === assetId);
                        assert.ok(scenario, `Unknown asset ${assetId}`);
                        counters.signed.set(assetId, (counters.signed.get(assetId) ?? 0) + 1);
                        json(response, 200, { assetId, signedUrl: `${origin}/fixture/video/${scenario.batchId}.mp4`, expiresIn: 60 });
                        return;
                    }
                    const videoMatch = url.pathname.match(/^\/fixture\/video\/([^/]+)\.mp4$/);
                    if (request.method === "GET" && videoMatch) {
                        const batchId = videoMatch[1];
                        assert.ok(findScenarioByBatch(batchId));
                        counters.video.set(batchId, (counters.video.get(batchId) ?? 0) + 1);
                        response.writeHead(200, { "content-type": "video/mp4", "cache-control": "no-store" });
                        response.end(Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex"));
                        return;
                    }
                    next();
                } catch (error) {
                    response.statusCode = 500;
                    response.setHeader("content-type", "application/json; charset=utf-8");
                    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
                }
            });
        },
    };
}

function videoNode(name, scenario) {
    const initial = name === "before_task_id" ? {
        cloudIdempotencyKey: scenario.idempotencyKey,
        status: "loading",
    } : name === "after_task_id" ? {
        cloudBatchId: scenario.batchId,
        status: "loading",
        cloudJob: {
            batchId: scenario.batchId,
            jobId: scenario.jobId,
            slotId: "video-slot-1",
            jobVersion: 1,
            attemptId: scenario.attemptId,
            attemptNo: 1,
            serverStatus: "waiting_provider",
        },
    } : name === "polling" ? {
        cloudBatchId: scenario.batchId,
        status: "loading",
        cloudJob: {
            batchId: scenario.batchId,
            jobId: scenario.jobId,
            slotId: "video-slot-1",
            jobVersion: 2,
            attemptId: scenario.attemptId,
            attemptNo: 1,
            serverStatus: "running",
        },
    } : {
        cloudBatchId: scenario.batchId,
        status: "loading",
        cloudJob: {
            batchId: scenario.batchId,
            jobId: scenario.jobId,
            slotId: "video-slot-1",
            jobVersion: 3,
            attemptId: scenario.attemptId,
            attemptNo: 1,
            serverStatus: "succeeded",
            assetId: scenario.assetId,
        },
    };
    return {
        id: `video-${name}`,
        type: "video",
        title: `Video ${name}`,
        position: { x: 0, y: 0 },
        width: 320,
        height: 180,
        metadata: initial,
    };
}

let browser;
const vite = await createViteServer({
    root: webRoot,
    configFile: resolve(webRoot, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    plugins: [fixturePlugin()],
    logLevel: "error",
});
try {
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Vite did not expose a local port");
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ executablePath: await browserExecutable(), headless: true, args: ["--no-sandbox"] });

    const runContext = async (callback) => {
        const context = await browser.newContext({ serviceWorkers: "block" });
        const errors = [];
        const requests = [];
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));
        await page.goto(`${origin}${gatePath}`, { waitUntil: "networkidle" });
        await page.waitForFunction(() => window.__cloudRecoveryGateReady === true);
        try {
            const result = await callback(page, requests);
            assert.deepEqual(errors, [], "browser recovery gate emitted a page error");
            return result;
        } finally {
            await context.close();
        }
    };

    const sequences = await runContext((page) => page.evaluate((batchId) => window.runSseRecoveryGate(batchId), sseBatchId));
    assert.deepEqual(sequences, ["12", "26"]);
    assert.deepEqual(counters.sse, [
        { call: 1, cursor: "10", lastEventId: "10" },
        { call: 2, cursor: "12", lastEventId: "12" },
        { call: 3, cursor: "25", lastEventId: "25" },
    ]);
    assert.equal(counters.snapshots.get(sseBatchId), 3);

    for (const [name, scenario] of Object.entries(scenarios)) {
        const result = await runContext(async (page, requests) => {
            const value = await page.evaluate(
                (input) => window.runVideoRecoveryGate(input),
                { node: videoNode(name, scenario), projectId: scenario.projectId },
            );
            assert.equal(requests.filter((request) => request.method === "POST" && request.url.includes("/api/v1/generation-batches")).length, 0);
            return value;
        });
        if (name === "before_task_id") {
            assert.equal(result.node.metadata.cloudJob.serverStatus, "outcome_unknown");
            assert.equal(result.node.metadata.status, "error");
            assert.equal(result.storedBytes, 0);
        } else {
            assert.equal(result.node.metadata.cloudJob.serverStatus, "succeeded");
            assert.equal(result.node.metadata.status, "success");
            assert.match(result.node.metadata.content, /^blob:/);
            assert.match(result.node.metadata.storageKey, /^video:/);
            assert.ok(result.storedBytes > 0);
            assert.equal(counters.signed.get(scenario.assetId), 1);
            assert.equal(counters.video.get(scenario.batchId), 1);
        }
    }
    assert.equal(counters.create, 0, "browser recovery issued a generation create request");
    assert.equal(counters.token, 5);
    console.log("Browser SSE cursor and four-window video recovery verification passed");
} finally {
    await browser?.close();
    await vite.close();
}
