import assert from "node:assert/strict";
import test from "node:test";

import { settleCanceledGeneration, settleCanceledImageGeneration } from "../src/lib/canvas/canvas-generation-state.ts";
import { storeGeneratedVideoCore } from "../src/services/api/video-storage-core.ts";

test("canceled image generation settles every loading slot", () => {
    const node = {
        id: "root",
        metadata: {
            status: "loading",
            images: [
                { id: "one", status: "loading" },
                { id: "two", status: "loading" },
            ],
        },
    };

    const result = settleCanceledImageGeneration(node, "Request canceled");

    assert.equal(result.metadata.status, "idle");
    assert.equal(result.metadata.errorDetails, "Request canceled");
    assert.deepEqual(
        result.metadata.images.map((image) => ({ status: image.status, errorDetails: image.errorDetails })),
        [
            { status: "error", errorDetails: "Request canceled" },
            { status: "error", errorDetails: "Request canceled" },
        ],
    );
});

test("canceled partial generation preserves successful images", () => {
    const node = {
        id: "root",
        metadata: {
            status: "loading",
            content: "blob:successful-image",
            images: [
                { id: "one", status: "success", content: "blob:successful-image" },
                { id: "two", status: "loading" },
            ],
        },
    };

    const result = settleCanceledImageGeneration(node, "Request canceled");

    assert.equal(result.metadata.status, "success");
    assert.equal(result.metadata.errorDetails, undefined);
    assert.equal(result.metadata.images[0], node.metadata.images[0]);
    assert.equal(result.metadata.images[1].status, "error");
});

test("terminal image generation remains unchanged", () => {
    const node = { id: "root", metadata: { status: "success", content: "blob:image" } };
    assert.equal(settleCanceledImageGeneration(node, "Request canceled"), node);
});

test("canceled non-image generation returns to idle", () => {
    const node = { id: "config", metadata: { status: "loading", errorDetails: "old error" } };
    const result = settleCanceledGeneration(node, "Request canceled", false);
    assert.equal(result.metadata.status, "idle");
    assert.equal(result.metadata.errorDetails, undefined);
});

test("video storage forwards cancellation and does not retain a partial local write", async () => {
    const controller = new AbortController();
    let stored = false;
    await assert.rejects(
        storeGeneratedVideoCore(
            { blob: new Blob(["video"], { type: "video/mp4" }) },
            controller.signal,
            async (_input, prefix, signal) => {
                assert.equal(prefix, "video");
                assert.equal(signal, controller.signal);
                stored = true;
                controller.abort(new DOMException("superseded", "AbortError"));
                try {
                    signal?.throwIfAborted();
                } catch (error) {
                    stored = false;
                    throw error;
                }
                assert.fail("aborted storage must not complete");
            },
        ),
        (error) => error instanceof Error && error.name === "AbortError",
    );
    assert.equal(stored, false);
});

test("video URL fallback never converts cancellation into success", async () => {
    await assert.rejects(
        storeGeneratedVideoCore(
            { url: "https://media.example/video.mp4", mimeType: "video/mp4" },
            undefined,
            async () => {
                throw new DOMException("canceled", "AbortError");
            },
        ),
        (error) => error instanceof Error && error.name === "AbortError",
    );

    const fallback = await storeGeneratedVideoCore(
        { url: "https://media.example/video.mp4", mimeType: "video/mp4" },
        undefined,
        async () => {
            throw new Error("offline storage unavailable");
        },
    );
    assert.deepEqual(fallback, {
        url: "https://media.example/video.mp4",
        storageKey: "",
        bytes: 0,
        mimeType: "video/mp4",
    });
});
