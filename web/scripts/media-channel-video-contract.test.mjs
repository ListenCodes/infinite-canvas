import assert from "node:assert/strict";
import test from "node:test";

import { grokMediaAspectRatio, grokMediaResolution, unwrapGrokMediaVideoResponse } from "../src/services/api/media-channel-video-contract.ts";

test("native Grok video settings preserve production landscape and portrait presets", () => {
    assert.equal(grokMediaAspectRatio("1792x1024"), "16:9");
    assert.equal(grokMediaAspectRatio("1024x1792"), "9:16");
    assert.equal(grokMediaResolution("480"), "480p");
    assert.equal(grokMediaResolution("1080p"), "1080p");
    assert.equal(grokMediaResolution("2160"), "720p");
});

test("native Grok video responses unwrap successful task envelopes", () => {
    assert.deepEqual(unwrapGrokMediaVideoResponse({ code: "0", data: { request_id: "task-1" } }), { request_id: "task-1" });
    assert.deepEqual(unwrapGrokMediaVideoResponse({ status: "done", video: { url: "/v1/videos/task-1/content" } }), { status: "done", video: { url: "/v1/videos/task-1/content" } });
});

test("native Grok video responses reject string-code and message-only errors", () => {
    assert.throws(() => unwrapGrokMediaVideoResponse({ code: "401", message: "token expired" }), /token expired/);
    assert.throws(() => unwrapGrokMediaVideoResponse({ message: "quota exhausted" }), /quota exhausted/);
});
