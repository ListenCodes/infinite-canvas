import assert from "node:assert/strict";
import test from "node:test";

import { GROK2API_IMAGE_ADAPTER_SCRIPT, GROK_MEDIA_VIDEO_ADAPTER_SCRIPT, SUB2API_IMAGE_ADAPTER_SCRIPT, grokMediaCapability } from "../src/services/api/media-channel-adapter-scripts.ts";

function runScript(script, overrides = {}) {
    const values = {
        prompt: "test prompt",
        images: [],
        messages: [],
        params: {},
        model: "grok-imagine-image-quality",
        baseUrl: "https://media.example.com",
        apiKey: "test-key",
        systemPrompt: "",
        reasoningEffort: "auto",
        http: {},
        request: async () => undefined,
        poll: async () => undefined,
        sleep: async () => undefined,
        signal: undefined,
        onDelta: () => undefined,
        ...overrides,
    };
    const names = Object.keys(values);
    const runner = new Function(...names, `"use strict"; return (async () => {\n${script}\n})();`);
    return runner(...names.map((name) => values[name]));
}

test("Grok media model aliases receive the correct capability", () => {
    assert.equal(grokMediaCapability("grok-imagine"), "image");
    assert.equal(grokMediaCapability("grok-imagine-edit"), "image");
    assert.equal(grokMediaCapability("grok-imagine-image-quality"), "image");
    assert.equal(grokMediaCapability("grok-imagine-video-1.5"), "video");
    assert.equal(grokMediaCapability("grok-4.5"), undefined);
});

test("Grok2API image adapter sends JSON generation requests and resolves relative URLs", async () => {
    const calls = [];
    const result = await runScript(GROK2API_IMAGE_ADAPTER_SCRIPT, {
        params: { count: 12, size: "1024x1024" },
        http: {
            post: async (path, body) => {
                calls.push({ path, body });
                return { data: [{ url: "/v1/media/images/result.png" }] };
            },
        },
    });

    assert.deepEqual(result, ["https://media.example.com/v1/media/images/result.png"]);
    assert.equal(calls[0].path, "/images/generations");
    assert.equal(calls[0].body.n, 10);
    assert.equal(calls[0].body.stream, false);
    assert.equal(calls[0].body.aspect_ratio, "1:1");
});

test("image adapters preserve wide ratios and map high-resolution requests to 2k", async () => {
    let request;
    await runScript(SUB2API_IMAGE_ADAPTER_SCRIPT, {
        params: { count: 1, size: "1824x1024", quality: "high" },
        http: {
            post: async (path, body) => {
                request = { path, body };
                return { data: [{ b64_json: "BBBB" }] };
            },
        },
    });
    assert.equal(request.path, "/images/generations");
    assert.equal(request.body.aspect_ratio, "16:9");
    assert.equal(request.body.resolution, "2k");
});

test("image adapters reject unsupported 4k output instead of silently lowering it", async () => {
    await assert.rejects(
        runScript(SUB2API_IMAGE_ADAPTER_SCRIPT, {
            params: { count: 1, size: "3840x2160", quality: "high" },
        }),
        /up to 2K/,
    );
});

test("image adapters select each service's JSON edit model", async () => {
    for (const [script, expectedModel] of [
        [GROK2API_IMAGE_ADAPTER_SCRIPT, "grok-imagine-image-edit"],
        [SUB2API_IMAGE_ADAPTER_SCRIPT, "grok-imagine-edit"],
    ]) {
        let request;
        await runScript(script, {
            images: ["data:image/png;base64,AAAA"],
            params: { count: 3 },
            http: {
                post: async (path, body) => {
                    request = { path, body };
                    return { data: [{ b64_json: "BBBB" }] };
                },
            },
        });
        assert.equal(request.path, "/images/edits");
        assert.equal(request.body.model, expectedModel);
        assert.equal(request.body.n, 1);
        assert.deepEqual(request.body.images, [{ url: "data:image/png;base64,AAAA" }]);
    }
});

test("video adapter creates, polls, and downloads with the same authenticated helper", async () => {
    const calls = [];
    let statusCalls = 0;
    const video = new Blob(["video"], { type: "video/mp4" });
    const http = {
        post: async (path, body) => {
            calls.push({ method: "post", path, body });
            return { request_id: "video/123" };
        },
        get: async (path, options) => {
            calls.push({ method: "get", path, options });
            if (path.endsWith("/content")) return video;
            statusCalls += 1;
            return { status: statusCalls === 1 ? "pending" : "done" };
        },
    };
    const poll = async (request, extract) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const value = extract(await request());
            if (value) return value;
        }
        throw new Error("poll did not finish");
    };

    const result = await runScript(GROK_MEDIA_VIDEO_ADAPTER_SCRIPT, {
        model: "grok-imagine-video",
        images: ["data:image/png;base64,AAAA"],
        params: { seconds: "20", ratio: "9:16", resolution: "720p" },
        http,
        poll,
    });

    assert.equal(result, video);
    assert.equal(calls[0].path, "/videos/generations");
    assert.deepEqual(calls[0].body, {
        model: "grok-imagine-video",
        prompt: "test prompt",
        duration: 15,
        aspect_ratio: "9:16",
        resolution: "720p",
        image: { url: "data:image/png;base64,AAAA" },
    });
    assert.equal(calls.at(-1).path, "/videos/video%2F123/content");
    assert.equal(calls.at(-1).options.responseType, "blob");
});

test("video adapter surfaces a failed task message", async () => {
    await assert.rejects(
        runScript(GROK_MEDIA_VIDEO_ADAPTER_SCRIPT, {
            model: "grok-imagine-video",
            params: { seconds: "8", ratio: "16:9", resolution: "720p" },
            http: {
                post: async () => ({ request_id: "failed-task" }),
                get: async () => ({ status: "failed", error: { message: "upstream unavailable" } }),
            },
            poll: async (request, extract) => extract(await request()),
        }),
        /upstream unavailable/,
    );
});

test("legacy video adapter maps the production tall preset to 9:16", async () => {
    let request;
    await runScript(GROK_MEDIA_VIDEO_ADAPTER_SCRIPT, {
        params: { seconds: "10", ratio: "1024x1792", resolution: "720p" },
        http: {
            post: async (path, body) => {
                request = { path, body };
                return { request_id: "tall-video" };
            },
            get: async (path, options) => (path.endsWith("/content") ? new Blob(["video"], { type: "video/mp4" }) : { status: "done" }),
        },
        poll: async (fetchState, extract) => extract(await fetchState()),
    });
    assert.equal(request.body.aspect_ratio, "9:16");
});
