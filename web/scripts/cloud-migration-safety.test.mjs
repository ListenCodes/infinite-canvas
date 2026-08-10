import assert from "node:assert/strict";
import test from "node:test";

import { annotateMigrationDocument, assertDurableMigrationAssets, assertMigrationSourcesPresent, collectMigrationStorageKeys } from "../src/lib/canvas/cloud-migration-export-core.ts";
import { parseCloudMigrationRollbackData, restoreCloudMigrationLocalAssets } from "../src/lib/canvas/cloud-migration-restore-core.ts";
import { stageAndApplyCloudProjects } from "../src/pages/canvas/cloud-project-bootstrap-core.ts";
import { OrderedPersistQueue } from "../src/stores/canvas/ordered-persist-queue.ts";
import { assertCloudRequestIdentity, captureCloudRequestIdentity, isCloudRequestAbort } from "../src/services/api/cloud-request-identity.ts";
import {
    cloudMigrationActivationMatches,
    cloudMigrationBelongsTo,
    cloudMigrationLoadRetryDelay,
    cloudMigrationRecordMatchesExpected,
    cloudMigrationRecordKey,
    cloudProjectBindingMatchesIdentity,
    cloudProjectBindingUnchanged,
    cloudProjectResponseMayUpdateBinding,
    ensureCloudMigrationCanStart,
    isCloudImportPublishedFor,
    isCloudMigrationBusy,
    isCloudMigrationIdentityLoaded,
    localProjectsChangedSinceExport,
    updateCloudMigrationBusyCounts,
    withCloudMigrationLock,
} from "../src/services/cloud-migration-policy.ts";

const accountA = { userId: "user-a", workspaceId: "workspace-a" };

test("cloud requests cannot switch accounts while the session token is loading", () => {
    const captured = captureCloudRequestIdentity({ authenticated: true, userId: "user-a", workspaceId: "workspace-a" });
    assert.throws(() => assertCloudRequestIdentity(captured, "user-b", { authenticated: true, userId: "user-b", workspaceId: "workspace-b" }), { name: "AbortError" });
    assert.throws(() => assertCloudRequestIdentity(captured, "user-a", { authenticated: true, userId: "user-a", workspaceId: "workspace-b" }), { name: "AbortError" });
    assert.doesNotThrow(() => assertCloudRequestIdentity(captured, "user-a", { authenticated: true, userId: "user-a", workspaceId: "workspace-a" }));
});

test("session bootstrap is fenced to the Supabase user without requiring a stale workspace", () => {
    const captured = captureCloudRequestIdentity({ authenticated: false, userId: null, workspaceId: null }, "user-b");
    assert.doesNotThrow(() => assertCloudRequestIdentity(captured, "user-b", { authenticated: true, userId: "user-a", workspaceId: "workspace-a" }));
    assert.throws(() => assertCloudRequestIdentity(captured, "user-a", { authenticated: true, userId: "user-a", workspaceId: "workspace-a" }), { name: "AbortError" });
});

test("identity aborts are control flow and never migration business failures", () => {
    assert.equal(isCloudRequestAbort(new DOMException("changed", "AbortError")), true);
    assert.equal(isCloudRequestAbort(new Error("provider failed")), false);
});

test("migration records are scoped to both user and workspace", () => {
    assert.notEqual(cloudMigrationRecordKey(accountA), cloudMigrationRecordKey({ userId: "user-b", workspaceId: "workspace-a" }));
    assert.notEqual(cloudMigrationRecordKey(accountA), cloudMigrationRecordKey({ userId: "user-a", workspaceId: "workspace-b" }));
    assert.equal(cloudMigrationBelongsTo(accountA, accountA), true);
    assert.equal(cloudMigrationBelongsTo(accountA, { userId: "user-b", workspaceId: "workspace-a" }), false);
    assert.equal(isCloudImportPublishedFor({ ...accountA, clientExportId: "export-1" }, accountA), true);
    assert.equal(isCloudImportPublishedFor({ userId: "user-b", workspaceId: "workspace-a", clientExportId: "export-1" }, accountA), false);
    assert.equal(cloudMigrationActivationMatches({ ...accountA, clientExportId: "export-1" }, { ...accountA, clientExportId: "export-1" }), true);
    assert.equal(cloudMigrationActivationMatches({ ...accountA, clientExportId: "export-1" }, { ...accountA, clientExportId: "export-other" }), false);
});

test("migration busy state is scoped to the current account and workspace", () => {
    const accountB = { userId: "user-b", workspaceId: "workspace-b" };
    let counts = updateCloudMigrationBusyCounts({}, accountA, 1);
    assert.equal(isCloudMigrationBusy(counts, accountA), true);
    assert.equal(isCloudMigrationBusy(counts, accountB), false);

    counts = updateCloudMigrationBusyCounts(counts, accountB, 1);
    counts = updateCloudMigrationBusyCounts(counts, accountA, -1);
    assert.equal(isCloudMigrationBusy(counts, accountA), false);
    assert.equal(isCloudMigrationBusy(counts, accountB), true);

    counts = updateCloudMigrationBusyCounts(counts, accountB, -1);
    assert.deepEqual(counts, {});
});

test("migration start remains closed until the current identity record is loaded", async () => {
    const accountB = { userId: "user-b", workspaceId: "workspace-b" };
    assert.equal(isCloudMigrationIdentityLoaded(null, accountB), false);
    assert.equal(isCloudMigrationIdentityLoaded(cloudMigrationRecordKey(accountA), accountB), false);
    assert.equal(isCloudMigrationIdentityLoaded(cloudMigrationRecordKey(accountB), accountB), true);

    let loadCalls = 0;
    await assert.rejects(
        ensureCloudMigrationCanStart({
            identity: accountB,
            loadedIdentityKey: cloudMigrationRecordKey(accountA),
            currentRecord: null,
            loadRecord: async () => {
                loadCalls += 1;
                return null;
            },
        }),
        /has not finished loading/,
    );
    assert.equal(loadCalls, 0);

    const existing = { ...accountB, clientExportId: "existing-export", status: "published" };
    await assert.rejects(
        ensureCloudMigrationCanStart({
            identity: accountB,
            loadedIdentityKey: cloudMigrationRecordKey(accountB),
            currentRecord: null,
            loadRecord: async () => existing,
        }),
        /must be resolved/,
    );
    assert.equal(existing.clientExportId, "existing-export");
});

test("cloud migration uses one browser-wide identity lock and rejects stale records", async () => {
    let tail = Promise.resolve();
    const names = [];
    const manager = {
        request(name, _options, callback) {
            names.push(name);
            const result = tail.then(callback);
            tail = result.catch(() => undefined);
            return result;
        },
    };
    const order = [];
    let releaseFirst;
    const first = withCloudMigrationLock(
        accountA,
        async () => {
            order.push("first:start");
            await new Promise((resolve) => {
                releaseFirst = resolve;
            });
            order.push("first:end");
        },
        manager,
    );
    const second = withCloudMigrationLock(
        accountA,
        async () => {
            order.push("second");
        },
        manager,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first:start", "first:end", "second"]);
    assert.equal(new Set(names).size, 1);

    const expected = { ...accountA, clientExportId: "export-1", importId: "import-1", status: "importing" };
    assert.equal(cloudMigrationRecordMatchesExpected({ ...expected }, expected), true);
    assert.equal(cloudMigrationRecordMatchesExpected({ ...expected, status: "published" }, expected), false);
    assert.equal(cloudMigrationRecordMatchesExpected({ ...expected, clientExportId: "export-2" }, expected), false);
});

test("migration record loading retries twice before requiring an explicit retry", () => {
    assert.equal(cloudMigrationLoadRetryDelay(1), 500);
    assert.equal(cloudMigrationLoadRetryDelay(2), 1_500);
    assert.equal(cloudMigrationLoadRetryDelay(3), null);
    assert.equal(cloudMigrationLoadRetryDelay(0), null);
});

test("cloud project bindings are valid only for the current account and workspace", () => {
    assert.equal(cloudProjectBindingMatchesIdentity(undefined, accountA), true);
    assert.equal(cloudProjectBindingMatchesIdentity(accountA, accountA), true);
    assert.equal(cloudProjectBindingMatchesIdentity(accountA, { userId: "user-b", workspaceId: accountA.workspaceId }), false);
    assert.equal(cloudProjectBindingMatchesIdentity(accountA, { userId: accountA.userId, workspaceId: "workspace-b" }), false);
    assert.equal(cloudProjectBindingMatchesIdentity(accountA, null), false);

    const captured = { ...accountA, projectId: "project-1", version: 1 };
    const response = { id: "project-1", workspaceId: accountA.workspaceId, version: 2 };
    assert.equal(cloudProjectResponseMayUpdateBinding({ identity: accountA, capturedBinding: captured, latestBinding: captured, response }), true);
    assert.equal(cloudProjectResponseMayUpdateBinding({ identity: accountA, capturedBinding: captured, latestBinding: { ...captured, version: 2 }, response }), false);
    assert.equal(cloudProjectResponseMayUpdateBinding({ identity: accountA, capturedBinding: undefined, latestBinding: { ...captured, version: 3 }, response }), false);
    assert.equal(cloudProjectResponseMayUpdateBinding({ identity: accountA, capturedBinding: captured, latestBinding: { ...captured, userId: "user-b" }, response }), false);
    assert.equal(cloudProjectBindingUnchanged(captured, captured, accountA), true);
    assert.equal(cloudProjectBindingUnchanged(captured, { ...captured, version: 2 }, accountA), false);
    assert.equal(cloudProjectBindingUnchanged(undefined, captured, accountA), false);
});

test("migration activation detects edits, additions, and deletions after export", () => {
    const baseline = { one: "2026-08-10T00:00:00.000Z", two: "2026-08-10T00:00:01.000Z" };
    assert.equal(
        localProjectsChangedSinceExport(baseline, [
            { id: "one", updatedAt: baseline.one },
            { id: "two", updatedAt: baseline.two },
        ]),
        false,
    );
    assert.equal(
        localProjectsChangedSinceExport(baseline, [
            { id: "one", updatedAt: "2026-08-10T00:01:00.000Z" },
            { id: "two", updatedAt: baseline.two },
        ]),
        true,
    );
    assert.equal(localProjectsChangedSinceExport(baseline, [{ id: "one", updatedAt: baseline.one }]), true);
    assert.equal(
        localProjectsChangedSinceExport(baseline, [
            { id: "one", updatedAt: baseline.one },
            { id: "two", updatedAt: baseline.two },
            { id: "three", updatedAt: baseline.two },
        ]),
        true,
    );
});

test("migration export fails closed for missing or ephemeral local media", () => {
    const storageKeys = collectMigrationStorageKeys({ nodes: [{ storageKey: "image:missing", content: "blob:local" }] });
    assert.throws(() => assertMigrationSourcesPresent(storageKeys, new Map()), /referenced local media files are missing/);
    assert.throws(() => annotateMigrationDocument({ content: "data:image/png;base64,AAAA" }, new Map()), /ephemeral media has no durable local object/);
    assert.throws(() => assertDurableMigrationAssets([{ kind: "image", data: { storageKey: undefined } }]), /no durable storage key/);
    assert.throws(() => assertDurableMigrationAssets([{ kind: "image", data: { storageKey: "" } }]), /no durable storage key/);
    assert.throws(() => annotateMigrationDocument({ storageKey: "", content: "" }, new Map()), /storage key is invalid/);
});

test("migration export replaces durable local media with cloud asset metadata", () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const sources = new Map([["image:one", { blob, filename: "one.png" }]]);
    assert.deepEqual(annotateMigrationDocument({ storageKey: "image:one", content: "blob:local", nested: { value: 1 } }, sources), {
        storageKey: "image:one",
        content: "",
        nested: { value: 1 },
        cloudAssetId: "image:one",
        cloudAssetMime: "image/png",
    });
});

test("a downloaded migration archive exposes projects and durable objects for rollback", () => {
    const sha256 = "a".repeat(64);
    assert.deepEqual(
        parseCloudMigrationRollbackData(
            { format: "infinite-canvas-local-export", schemaVersion: 1, counts: { projects: 1, assets: 1, objects: 1 } },
            [{ sourceId: "project-1", title: "Recovered", documentJson: { schemaVersion: 1, localProjectId: "project-1", document: { nodes: [], connections: [] } } }],
            [{ sourceId: "image:one", sha256, bytes: "3", mime: "image/png" }],
            [
                { id: "prompt-1", kind: "text", title: "Prompt", coverUrl: "", tags: ["saved"], createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z", data: { content: "A saved prompt" } },
                {
                    id: "image-1",
                    kind: "image",
                    title: "Standalone",
                    coverUrl: "",
                    tags: [],
                    createdAt: "2026-08-10T00:00:00.000Z",
                    updatedAt: "2026-08-10T00:00:00.000Z",
                    data: { dataUrl: "", storageKey: "image:one", width: 10, height: 20, bytes: 3, mimeType: "image/png" },
                },
            ],
        ),
        {
            projects: [{ sourceId: "project-1", title: "Recovered", document: { nodes: [], connections: [] } }],
            assets: [{ sourceId: "image:one", sha256, bytes: 3, mime: "image/png" }],
            localAssets: [
                { id: "prompt-1", kind: "text", title: "Prompt", coverUrl: "", tags: ["saved"], createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z", data: { content: "A saved prompt" } },
                {
                    id: "image-1",
                    kind: "image",
                    title: "Standalone",
                    coverUrl: "",
                    tags: [],
                    createdAt: "2026-08-10T00:00:00.000Z",
                    updatedAt: "2026-08-10T00:00:00.000Z",
                    data: { dataUrl: "", storageKey: "image:one", width: 10, height: 20, bytes: 3, mimeType: "image/png" },
                },
            ],
        },
    );
});

test("rollback restores standalone media and text assets without dropping unrelated library entries", () => {
    const archived = [
        { id: "prompt-1", kind: "text", title: "Prompt", coverUrl: "", tags: [], createdAt: "created", updatedAt: "updated", data: { content: "Saved text" } },
        { id: "image-1", kind: "image", title: "Image", coverUrl: "", tags: [], createdAt: "created", updatedAt: "updated", data: { dataUrl: "", storageKey: "image:one", width: 1, height: 1, bytes: 3, mimeType: "image/png" } },
    ];
    const existing = [
        { id: "image-1", kind: "image", title: "Stale", coverUrl: "", tags: [], createdAt: "created", updatedAt: "updated", data: { dataUrl: "stale", storageKey: "image:stale", width: 1, height: 1, bytes: 1, mimeType: "image/png" } },
        { id: "keep", kind: "text", title: "Keep", coverUrl: "", tags: [], createdAt: "created", updatedAt: "updated", data: { content: "Keep me" } },
    ];
    const restored = restoreCloudMigrationLocalAssets(archived, new Map([["image:one", "blob:restored"]]), existing);
    assert.deepEqual(
        restored.map((asset) => asset.id),
        ["prompt-1", "image-1", "keep"],
    );
    assert.equal(restored[1].data.dataUrl, "blob:restored");
    assert.equal(restored[1].coverUrl, "blob:restored");
    assert.equal(restored[2].data.content, "Keep me");
});

test("cloud migration activation applies nothing when staging or revision checks fail", async () => {
    const remotes = [
        { workspaceId: "workspace-a", documentJson: { localProjectId: "one" } },
        { workspaceId: "workspace-a", documentJson: { localProjectId: "two" } },
    ];
    const applied = [];
    await assert.rejects(
        stageAndApplyCloudProjects({
            remotes,
            userId: "user-a",
            workspaceId: "workspace-a",
            mayReplaceUnbound: true,
            approvedProjectRevisions: { one: "v1", two: "v1" },
            currentProjectRevisions: () => [
                { id: "one", updatedAt: "v1" },
                { id: "two", updatedAt: "v1" },
            ],
            findLocal: () => ({}),
            materialize: async (remote) => {
                if (remote.documentJson.localProjectId === "two") throw new Error("asset download failed");
                return remote.documentJson.localProjectId;
            },
            apply: (projects) => applied.push(...projects),
        }),
        /asset download failed/,
    );
    assert.deepEqual(applied, []);

    await assert.rejects(
        stageAndApplyCloudProjects({
            remotes: remotes.slice(0, 1),
            userId: "user-a",
            workspaceId: "workspace-a",
            mayReplaceUnbound: true,
            approvedProjectRevisions: { one: "v1" },
            currentProjectRevisions: () => [{ id: "one", updatedAt: "v2" }],
            findLocal: () => ({}),
            materialize: async () => "one",
            apply: (projects) => applied.push(...projects),
        }),
        /Local projects changed/,
    );
    assert.deepEqual(applied, []);
});

test("canvas persistence serializes a slow old snapshot before a flushed retry identity", async () => {
    const queue = new OrderedPersistQueue();
    const started = [];
    const completed = [];
    let releaseOld;
    const write = async (value) => {
        started.push(value);
        if (value === "old")
            await new Promise((resolve) => {
                releaseOld = resolve;
            });
        completed.push(value);
    };
    queue.queue("old");
    const oldFlush = queue.flush(write);
    await new Promise((resolve) => setTimeout(resolve, 0));
    queue.queue("retry-key-persisted");
    const retryFlush = queue.flush(write);
    assert.deepEqual(started, ["old"]);
    releaseOld();
    await Promise.all([oldFlush, retryFlush]);
    assert.deepEqual(started, ["old", "retry-key-persisted"]);
    assert.deepEqual(completed, ["old", "retry-key-persisted"]);
});

test("cloud migration activation requires every exported project to be staged", async () => {
    const applied = [];
    await assert.rejects(
        stageAndApplyCloudProjects({
            remotes: [],
            userId: "user-a",
            workspaceId: "workspace-a",
            mayReplaceUnbound: true,
            expectedLocalProjectIds: ["project-one"],
            approvedProjectRevisions: { "project-one": "v1" },
            currentProjectRevisions: () => [{ id: "project-one", updatedAt: "v1" }],
            findLocal: () => undefined,
            materialize: async () => "unreachable",
            apply: (projects) => applied.push(...projects),
        }),
        /missing 1 imported projects/,
    );
    assert.deepEqual(applied, []);

    await stageAndApplyCloudProjects({
        remotes: [
            { workspaceId: "workspace-a", documentJson: { localProjectId: "project-one" } },
            { workspaceId: "workspace-a", documentJson: { localProjectId: "unrelated" } },
        ],
        userId: "user-a",
        workspaceId: "workspace-a",
        mayReplaceUnbound: true,
        expectedLocalProjectIds: ["project-one"],
        approvedProjectRevisions: { "project-one": "v1" },
        currentProjectRevisions: () => [{ id: "project-one", updatedAt: "v1" }],
        findLocal: () => undefined,
        materialize: async (remote) => remote.documentJson.localProjectId,
        apply: (projects) => applied.push(...projects),
    });
    assert.deepEqual(applied, ["project-one"]);
});
