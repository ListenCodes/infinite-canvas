import assert from "node:assert/strict";
import test from "node:test";

import { settleCanceledGeneration, settleCanceledImageGeneration } from "../src/lib/canvas/canvas-generation-state.ts";

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
