import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";

import { GrokImageAdapter, GrokVideoAdapter } from "./grok.js";
import { ProviderRequestNotSubmittedError } from "./index.js";
import type { FrozenGenerationInput, ProviderContext } from "./index.js";
import { OpenAiImageAdapter } from "./openai.js";

afterEach(() => mock.restoreAll());

function input(
  capability: "image" | "video",
  overrides: Partial<FrozenGenerationInput> = {},
): FrozenGenerationInput {
  return {
    prompt: "draw a city",
    model: capability === "image" ? "grok-imagine-image" : "grok-imagine-video",
    capability,
    parameters: {},
    referenceAssetIds: [],
    referenceAssets: [],
    ...overrides,
  };
}

function context(): ProviderContext {
  return {
    channelId: "00000000-0000-4000-8000-000000000301" as never,
    baseUrl: new URL("https://provider.example/v1"),
    credential: "secret-not-logged",
    signal: new AbortController().signal,
    idempotencyKey: "attempt-1",
    addressResolver: async () => [{ address: "8.8.8.8", family: 4 }],
  };
}

test("Grok image adapter preserves relative URLs and one-slot request", async () => {
  let requestBody: Record<string, unknown> | undefined;
  mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ data: [{ url: "/media/result.png" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );
  const result = await new GrokImageAdapter(
    "grok2api",
    "grok-imagine-image-edit",
  ).submit(input("image"), context());
  assert.equal(requestBody?.n, 1);
  assert.deepEqual(result, {
    outcome: "completed",
    mediaUrls: ["https://provider.example/media/result.png"],
  });
});

test("Grok image adapter rejects output larger than 2K before calling provider", () => {
  assert.throws(
    () =>
      new GrokImageAdapter("sub2api", "grok-imagine-edit").validate(
        input("image", { parameters: { size: "4096x4096" } }),
      ),
    /up to 2K/i,
  );
});

test("moderation HTTP 400 is explicit and non-retryable", async () => {
  mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({ error: { message: "content moderation rejected" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
  );
  const result = await new GrokImageAdapter(
    "grok2api",
    "grok-imagine-image-edit",
  ).submit(input("image"), context());
  assert.deepEqual(result, {
    outcome: "rejected",
    errorCode: "content_moderation_rejected",
    message: "content moderation rejected",
    retryable: false,
    acceptance: "not_accepted",
  });
});

test("string envelope error code is not mistaken for image success", async () => {
  mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({ code: "40012", message: "sensitive prompt" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  const result = await new GrokImageAdapter(
    "sub2api",
    "grok-imagine-edit",
  ).submit(input("image"), context());
  assert.equal(result.outcome, "rejected");
  if (result.outcome === "rejected")
    assert.equal(result.message, "sensitive prompt");
});

test("Grok video resumes by task ID and returns authenticated content endpoint", async () => {
  let call = 0;
  mock.method(globalThis, "fetch", async () => {
    call += 1;
    return call === 1
      ? new Response(JSON.stringify({ data: { request_id: "task/a" } }), {
          status: 200,
        })
      : new Response(JSON.stringify({ status: "completed" }), { status: 200 });
  });
  const adapter = new GrokVideoAdapter("grok2api");
  const submitted = await adapter.submit(input("video"), context());
  assert.equal(submitted.outcome, "accepted");
  const state = await adapter.poll("task/a", context());
  assert.equal(state.status, "succeeded");
  if (state.status === "succeeded")
    assert.equal(
      state.mediaUrls[0]?.toString(),
      "https://provider.example/v1/videos/task%2Fa/content",
    );
});

test("OpenAI reference failure is known to occur before the paid POST", async () => {
  let requests = 0;
  mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return new Response("missing", { status: 404 });
  });
  const generation = input("image", {
    referenceAssetIds: ["00000000-0000-4000-8000-000000000901" as never],
    referenceAssets: [
      {
        assetId: "00000000-0000-4000-8000-000000000901" as never,
        url: new URL("https://storage.example/reference.png"),
        mime: "image/png",
      },
    ],
  });
  await assert.rejects(
    new OpenAiImageAdapter().submit(generation, context()),
    (error: unknown) =>
      error instanceof ProviderRequestNotSubmittedError && error.retryable,
  );
  assert.equal(requests, 1);
});

test("non-idempotent inline image and oversized media URL are not accepted as durable results", async () => {
  const responses = [
    { data: [{ b64_json: "aGVsbG8=" }] },
    {
      data: [
        {
          url: `https://media.example/image.png?value=${"a".repeat(17 * 1024)}`,
        },
      ],
    },
  ];
  mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify(responses.shift()), { status: 200 }),
  );
  const { idempotencyKey: _idempotencyKey, ...nonIdempotent } = context();
  const adapter = new GrokImageAdapter("grok2api", "grok-imagine-image-edit");
  assert.equal(
    (await adapter.submit(input("image"), nonIdempotent)).outcome,
    "outcome_unknown",
  );
  assert.equal(
    (await adapter.submit(input("image"), context())).outcome,
    "outcome_unknown",
  );
});
