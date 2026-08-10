import assert from "node:assert/strict";
import test from "node:test";

import { buildCloudEventRequest, GenerationEventDecoder, newerEventCursor } from "../src/services/api/cloud-event-stream.ts";
import { resumeCloudProjectGenerations } from "../src/pages/canvas/cloud-generation-resume.ts";
import { abortCloudIdentityRequests, cloudIdentityRequestMayContinue, cloudImageRetryMode, resumeCloudImageBatchesCore, resumeCloudVideoBatchesCore } from "../src/pages/canvas/cloud-generation-recovery-drivers.ts";
import { ActiveGenerationWatchRegistry, CLOUD_GENERATION_CURSOR_SCAN_MS, CloudGenerationWakeChannel, runCloudGenerationEventPump, waitForCloudGenerationCursorScan } from "../src/pages/canvas/cloud-generation-watch-core.ts";
import { aggregateCloudImageStatus, mergeCloudImageJobStates } from "../src/pages/canvas/cloud-image-state-core.ts";
import { clearCloudUploadRetryKey, getOrCreateCloudUploadRetryKey, rotateCloudUploadRetryKey } from "../src/services/api/cloud-upload-retry.ts";

const workspaceId = "00000000-0000-4000-8000-000000000101";
const projectId = "00000000-0000-4000-8000-000000000201";

test("identity changes abort every shared generation controller before another API step", () => {
    const shared = new AbortController();
    const independent = new AbortController();
    const requests = new Map([
        ["one", { controller: shared }],
        ["two", { controller: shared }],
        ["three", { controller: independent }],
    ]);
    assert.equal(cloudIdentityRequestMayContinue(shared.signal), true);
    abortCloudIdentityRequests(requests);
    assert.equal(shared.signal.aborted, true);
    assert.equal(independent.signal.aborted, true);
    assert.equal(cloudIdentityRequestMayContinue(shared.signal), false);
    assert.equal(requests.size, 0);
});

function event(sequence) {
    return {
        sequence: String(sequence),
        type: "generation.job.state_changed",
        workspaceId,
        projectId,
        occurredAt: "2026-08-10T00:00:00.000Z",
        payload: { status: "running" },
    };
}

test("fragmented replay only delivers strictly newer generation events", () => {
    const text = [12, 12, 11].map((sequence) => `id: ${sequence}\ndata: ${JSON.stringify(event(sequence))}\n\n`).join("");
    const decoder = new GenerationEventDecoder("10");
    const cuts = [5, 17, 41, 83, text.length - 1, text.length];
    const delivered = [];
    let offset = 0;
    for (const cut of cuts) {
        delivered.push(...decoder.push(text.slice(offset, cut)));
        offset = cut;
    }
    assert.deepEqual(
        delivered.map(({ sequence }) => sequence),
        ["12"],
    );
    assert.equal(decoder.cursor, "12");
});

test("reconnect request uses the monotonic cursor even when a snapshot is stale", () => {
    let cursor = "10";
    cursor = newerEventCursor(cursor, "12");
    cursor = newerEventCursor(cursor, "10");
    const request = buildCloudEventRequest(projectId, cursor);
    assert.equal(new URL(request.path, "https://canvas.example").searchParams.get("cursor"), "12");
    assert.equal(request.headers["Last-Event-ID"], "12");
});

test("event pump preserves cursor across EOF and waits before reconnecting", async () => {
    const controller = new AbortController();
    const subscriptions = [];
    const reconnects = [];
    let snapshotCalls = 0;
    let releaseReconnect;
    const pump = runCloudGenerationEventPump({
        signal: controller.signal,
        loadSnapshot: async () => {
            snapshotCalls += 1;
            return { projectId, eventCursor: "10" };
        },
        subscribe: async ({ projectId: subscribedProjectId, cursor, onEventSequence }) => {
            subscriptions.push(buildCloudEventRequest(subscribedProjectId, cursor));
            if (subscriptions.length === 1) {
                onEventSequence("12");
                onEventSequence("11");
                return;
            }
            controller.abort();
        },
        onEvent: () => undefined,
        waitForReconnect: (delayMs) => {
            reconnects.push(delayMs);
            return new Promise((resolve) => {
                releaseReconnect = resolve;
            });
        },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(snapshotCalls, 1);
    assert.deepEqual(reconnects, [1500]);
    assert.equal(subscriptions.length, 1);
    releaseReconnect();
    await pump;
    assert.equal(snapshotCalls, 2);
    assert.equal(new URL(subscriptions[1].path, "https://canvas.example").searchParams.get("cursor"), "12");
    assert.equal(subscriptions[1].headers["Last-Event-ID"], "12");
});

test("subscribe failure reloads the authoritative snapshot without submitting again", async () => {
    const controller = new AbortController();
    const trace = [];
    const subscriptionCursors = [];
    const snapshotCursors = ["10", "25"];
    let snapshotCalls = 0;
    await runCloudGenerationEventPump({
        signal: controller.signal,
        initialCursor: "12",
        loadSnapshot: async () => {
            const eventCursor = snapshotCursors[snapshotCalls++];
            trace.push(`snapshot:${eventCursor}`);
            return { projectId, eventCursor };
        },
        subscribe: async ({ cursor }) => {
            trace.push(`subscribe:${cursor}`);
            subscriptionCursors.push(cursor);
            if (subscriptionCursors.length === 1) {
                throw Object.assign(new Error("cursor expired"), { status: 409, code: "event_cursor_expired" });
            }
            controller.abort();
        },
        onEvent: () => assert.fail("snapshot recovery must not synthesize an event"),
        waitForReconnect: async (delayMs) => {
            trace.push(`wait:${delayMs}`);
        },
    });
    assert.deepEqual(trace, ["snapshot:10", "subscribe:12", "wait:1500", "snapshot:25", "subscribe:25"]);
    assert.equal(snapshotCalls, 2);
});

test("wake channel performs the five second cursor sweep and aborts immediately", async () => {
    const timers = [];
    const scheduler = {
        setTimeout(callback, delayMs) {
            const timer = { callback, delayMs, cleared: false };
            timers.push(timer);
            return timer;
        },
        clearTimeout(timer) {
            timer.cleared = true;
        },
    };
    const channel = new CloudGenerationWakeChannel(scheduler);
    const first = waitForCloudGenerationCursorScan(channel, new AbortController().signal);
    assert.equal(CLOUD_GENERATION_CURSOR_SCAN_MS, 5_000);
    assert.equal(timers[0].delayMs, CLOUD_GENERATION_CURSOR_SCAN_MS);
    assert.equal(timers[0].cleared, false);
    timers[0].callback();
    await first;
    assert.equal(timers[0].cleared, true);

    const controller = new AbortController();
    const second = waitForCloudGenerationCursorScan(channel, controller.signal);
    controller.abort("project switched");
    await assert.rejects(second, (reason) => reason === "project switched");
    assert.equal(timers[1].cleared, true);
});

test("an aborted watcher can be replaced without the stale owner releasing the new one", () => {
    const registry = new ActiveGenerationWatchRegistry();
    const firstController = new AbortController();
    const releaseFirst = registry.acquire("batch-1", firstController.signal);
    assert.ok(releaseFirst);
    assert.equal(registry.acquire("batch-1", new AbortController().signal), null);
    firstController.abort();
    const secondController = new AbortController();
    const releaseSecond = registry.acquire("batch-1", secondController.signal);
    assert.ok(releaseSecond);
    releaseFirst();
    assert.equal(registry.acquire("batch-1", new AbortController().signal), null);
    releaseSecond();
    assert.ok(registry.acquire("batch-1", new AbortController().signal));
});

test("decoder accepts a bare-CR event split across chunks", () => {
    const decoder = new GenerationEventDecoder("0");
    const frame = `id: 3\rdata: ${JSON.stringify(event(3))}\r\r`;
    assert.deepEqual(decoder.push(frame.slice(0, -1)), []);
    assert.deepEqual(
        decoder.push(frame.slice(-1)).map(({ sequence }) => sequence),
        ["3"],
    );
});

test("decoder accepts mixed legal SSE newline pairs", () => {
    const decoder = new GenerationEventDecoder("0");
    const frame = `id: 4\r\ndata: ${JSON.stringify(event(4))}\r\n\ndata: ${JSON.stringify(event(5))}\n\r`;
    assert.deepEqual(
        decoder.push(frame).map(({ sequence }) => sequence),
        ["4", "5"],
    );
});

test("active jobs recovery invokes only the supplied resume drivers", async () => {
    const calls = [];
    const jobs = [
        { capability: "image", batchId: "image-batch", targetNodeId: "image-node" },
        { capability: "video", batchId: "video-batch", targetNodeId: "video-node" },
    ];
    await resumeCloudProjectGenerations({
        nodes: [],
        setNodes: () => undefined,
        signal: new AbortController().signal,
        remoteProjectId: projectId,
        getActiveJobs: async () => ({ jobs }),
        resumeImages: async (_nodes, _setNodes, _signal, remote, authoritative) => calls.push(["image", remote, authoritative]),
        resumeVideos: async (_nodes, _setNodes, _signal, remote, authoritative) => calls.push(["video", remote, authoritative]),
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(
        calls.map(([kind]) => kind),
        ["image", "video"],
    );
    assert.equal(calls[0][2], jobs);
    assert.equal(calls[1][2], jobs);
});

test("active-jobs failure still enters local metadata recovery without creating", async () => {
    const jobsSeen = [];
    await resumeCloudProjectGenerations({
        nodes: [],
        setNodes: () => undefined,
        signal: new AbortController().signal,
        remoteProjectId: projectId,
        getActiveJobs: async () => {
            throw new Error("offline");
        },
        resumeImages: async (_nodes, _setNodes, _signal, _remote, jobs) => jobsSeen.push(jobs),
        resumeVideos: async (_nodes, _setNodes, _signal, _remote, jobs) => jobsSeen.push(jobs),
    });
    assert.deepEqual(jobsSeen, [[], []]);
});

test("real image and video recovery drivers watch active and local batches without a create path", async () => {
    const watched = [];
    const updated = [];
    const signal = new AbortController().signal;
    const baseJob = {
        batchId: "00000000-0000-4000-8000-000000000301",
        jobId: "00000000-0000-4000-8000-000000000401",
        slotIndex: 0,
        slotId: "slot-1",
        status: "waiting_provider",
        jobVersion: 1,
        attemptId: "00000000-0000-4000-8000-000000000501",
        attemptNo: 1,
        targetNodeId: "node-active",
    };
    await resumeCloudImageBatchesCore({
        nodes: [{ id: "node-local", metadata: { cloudBatchId: "00000000-0000-4000-8000-000000000302", images: [{ content: "", storageKey: "", cloud: { serverStatus: "running" } }] } }],
        signal,
        authoritativeJobs: [{ ...baseJob, capability: "image" }],
        updateJobs: (nodeId) => updated.push(["image", nodeId]),
        watchBatch: async (batchId, nodeId) => {
            watched.push(["image", batchId, nodeId]);
        },
        resolveBatch: async () => {
            throw new Error("resolve must not run");
        },
        hasBlob: async () => false,
    });
    await resumeCloudVideoBatchesCore({
        nodes: [{ id: "video-local", type: "video", metadata: { cloudBatchId: "00000000-0000-4000-8000-000000000303", cloudJob: { serverStatus: "running" } } }],
        videoNodeType: "video",
        signal,
        authoritativeJobs: [{ ...baseJob, batchId: "00000000-0000-4000-8000-000000000304", jobId: "00000000-0000-4000-8000-000000000404", attemptId: "00000000-0000-4000-8000-000000000504", capability: "video" }],
        updateJob: (nodeId) => updated.push(["video", nodeId]),
        watchBatch: async (batchId, nodeId) => {
            watched.push(["video", batchId, nodeId]);
        },
        resolveBatch: async () => {
            throw new Error("resolve must not run");
        },
        hasBlob: async () => false,
    });
    assert.deepEqual(updated, [
        ["image", "node-active"],
        ["video", "node-active"],
    ]);
    assert.deepEqual(watched, [
        ["image", "00000000-0000-4000-8000-000000000301", "node-active"],
        ["image", "00000000-0000-4000-8000-000000000302", "node-local"],
        ["video", "00000000-0000-4000-8000-000000000304", "node-active"],
        ["video", "00000000-0000-4000-8000-000000000303", "video-local"],
    ]);
});

test("a locally failed succeeded image retries materialization without a paid attempt", () => {
    assert.equal(cloudImageRetryMode({ status: "error", cloud: { serverStatus: "succeeded" } }), "materialize");
    assert.equal(cloudImageRetryMode({ status: "error", cloud: { serverStatus: "failed" } }), "attempt");
    assert.equal(cloudImageRetryMode({ status: "success", cloud: { serverStatus: "succeeded" } }), null);
});

test("three image slots preserve success and expose independent failure reasons", () => {
    const baseJob = {
        batchId: "00000000-0000-4000-8000-000000000321",
        jobVersion: 2,
        attemptNo: 1,
        slotIndex: 0,
    };
    const images = mergeCloudImageJobStates(
        [
            { id: "slot-1", status: "success", content: "blob:ready" },
            { id: "slot-2", status: "loading" },
            { id: "slot-3", status: "loading" },
        ],
        [
            { ...baseJob, slotId: "slot-1", jobId: "00000000-0000-4000-8000-000000000421", attemptId: "00000000-0000-4000-8000-000000000521", status: "succeeded" },
            {
                ...baseJob,
                slotIndex: 1,
                slotId: "slot-2",
                jobId: "00000000-0000-4000-8000-000000000422",
                attemptId: "00000000-0000-4000-8000-000000000522",
                status: "failed",
                errorCode: "provider_rate_limited",
                errorMessage: "Provider capacity was exhausted",
            },
            {
                ...baseJob,
                slotIndex: 2,
                slotId: "slot-3",
                jobId: "00000000-0000-4000-8000-000000000423",
                attemptId: "00000000-0000-4000-8000-000000000523",
                status: "failed",
                errorCode: "content_moderation_rejected",
                errorMessage: "Prompt was rejected by moderation",
            },
        ],
    );
    assert.equal(images[0].status, "success");
    assert.equal(images[0].content, "blob:ready");
    assert.equal(images[1].errorDetails, "Provider capacity was exhausted");
    assert.equal(images[2].errorDetails, "Prompt was rejected by moderation");
    assert.equal(aggregateCloudImageStatus(images), "success");
});

test("video recovery resumes the task-id, polling, and download refresh windows", async () => {
    const watched = [];
    const updated = [];
    const signal = new AbortController().signal;
    const batchIds = {
        beforeTask: "00000000-0000-4000-8000-000000000311",
        afterTask: "00000000-0000-4000-8000-000000000312",
        polling: "00000000-0000-4000-8000-000000000313",
        downloading: "00000000-0000-4000-8000-000000000314",
    };
    const resolvedJob = {
        batchId: batchIds.beforeTask,
        jobId: "00000000-0000-4000-8000-000000000411",
        slotIndex: 0,
        slotId: "slot-before-task",
        status: "submitting",
        jobVersion: 1,
        attemptId: "00000000-0000-4000-8000-000000000511",
        attemptNo: 1,
    };
    await resumeCloudVideoBatchesCore({
        nodes: [
            { id: "before-task", type: "video", metadata: { cloudIdempotencyKey: "create-before-task" } },
            { id: "after-task", type: "video", metadata: { cloudBatchId: batchIds.afterTask, cloudJob: { serverStatus: "waiting_provider" } } },
            { id: "polling", type: "video", metadata: { cloudBatchId: batchIds.polling, cloudJob: { serverStatus: "running" } } },
            { id: "downloading", type: "video", metadata: { cloudBatchId: batchIds.downloading, cloudJob: { serverStatus: "succeeded" }, content: "", storageKey: "video:missing" } },
        ],
        videoNodeType: "video",
        signal,
        remoteProjectId: projectId,
        updateJob: (nodeId, job) => updated.push([nodeId, job.status]),
        watchBatch: async (batchId, nodeId) => {
            watched.push([batchId, nodeId]);
        },
        resolveBatch: async (_projectId, key) => {
            assert.equal(key, "create-before-task");
            return { batchId: batchIds.beforeTask, eventCursor: "1", projectId, status: "running", jobs: [resolvedJob] };
        },
        hasBlob: async () => false,
    });
    assert.deepEqual(updated, [["before-task", "submitting"]]);
    assert.deepEqual(watched, [
        [batchIds.beforeTask, "before-task"],
        [batchIds.afterTask, "after-task"],
        [batchIds.polling, "polling"],
        [batchIds.downloading, "downloading"],
    ]);
});

test("project switch aborts an in-flight active-jobs request before resume drivers run", async () => {
    const controller = new AbortController();
    let releaseRequest;
    let resumeCalls = 0;
    const recovery = resumeCloudProjectGenerations({
        nodes: [],
        setNodes: () => undefined,
        signal: controller.signal,
        remoteProjectId: projectId,
        getActiveJobs: async () =>
            new Promise((resolve) => {
                releaseRequest = resolve;
            }),
        resumeImages: async () => {
            resumeCalls += 1;
        },
        resumeVideos: async () => {
            resumeCalls += 1;
        },
    });
    controller.abort();
    releaseRequest({ jobs: [] });
    await recovery;
    assert.equal(resumeCalls, 0);
});

test("rejected upload retry keys survive response loss and rotate only after explicit rejection", () => {
    const values = new Map();
    const storage = {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    };
    const ids = ["generation-1", "generation-2"];
    const createId = () => ids.shift();
    const first = getOrCreateCloudUploadRetryKey("a".repeat(64), createId, storage);
    assert.equal(getOrCreateCloudUploadRetryKey("a".repeat(64), createId, storage), first);
    const second = rotateCloudUploadRetryKey("a".repeat(64), createId, storage);
    assert.notEqual(second, first);
    assert.equal(getOrCreateCloudUploadRetryKey("a".repeat(64), createId, storage), second);
    clearCloudUploadRetryKey("a".repeat(64), storage);
    assert.equal(values.get("infinite-canvas:cloud-upload-retries:v1"), "{}");
});
