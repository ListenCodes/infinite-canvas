import type { ProviderSubmitResult } from "@infinite-canvas/contracts";

import {
  absoluteMediaUrl,
  envelopeData,
  envelopeError,
  errorMessage,
  providerFetch,
  providerHeaders,
  providerUrl,
  readPayload,
  rejectedFromResponse,
  responseMediaUrls,
  resultFromEnvelopeError,
} from "./http.js";
import {
  ProviderRequestNotSubmittedError,
  type FrozenGenerationInput,
  type MediaProviderAdapter,
  type ProviderContext,
  type ProviderState,
} from "./index.js";

const MAX_REFERENCE_BYTES = 16 * 1024 * 1024;

async function referenceBlob(
  url: URL,
  context: ProviderContext,
): Promise<Blob> {
  try {
    const response = await providerFetch(
      context,
      url,
      { signal: context.signal },
      {
        maxRedirects: 5,
        timeoutMs: 120_000,
        ...(context.trustedMediaOrigins
          ? { trustedPrivateOrigins: context.trustedMediaOrigins }
          : {}),
      },
    );
    if (!response.ok)
      throw new ProviderRequestNotSubmittedError(
        "reference_asset_unavailable",
        `Reference asset download failed with HTTP ${response.status}`,
        ![413, 415, 422].includes(response.status),
      );
    const declaredBytes = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_REFERENCE_BYTES)
      throw new ProviderRequestNotSubmittedError(
        "reference_asset_too_large",
        "Reference asset exceeds the provider upload limit",
        false,
      );
    if (!response.body)
      throw new ProviderRequestNotSubmittedError(
        "reference_asset_unavailable",
        "Reference asset download returned no body",
        true,
      );
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REFERENCE_BYTES) {
        await reader.cancel();
        throw new ProviderRequestNotSubmittedError(
          "reference_asset_too_large",
          "Reference asset exceeds the provider upload limit",
          false,
        );
      }
      chunks.push(value);
    }
    return new Blob(chunks, {
      type:
        response.headers.get("content-type")?.split(";", 1)[0] ??
        "application/octet-stream",
    });
  } catch (error) {
    if (error instanceof ProviderRequestNotSubmittedError) throw error;
    throw new ProviderRequestNotSubmittedError(
      "reference_asset_unavailable",
      error instanceof Error
        ? error.message
        : "Reference asset download failed",
      true,
    );
  }
}

export class OpenAiImageAdapter implements MediaProviderAdapter {
  readonly version = 1;
  readonly capability = "image" as const;
  readonly type = "openai";

  validate(input: FrozenGenerationInput): void {
    if (!input.prompt.trim()) throw new Error("Image prompt is required");
    if (input.referenceAssets.length > 8)
      throw new Error("Image editing supports at most 8 references");
  }

  async submit(
    input: FrozenGenerationInput,
    context: ProviderContext,
  ): Promise<ProviderSubmitResult> {
    const editing = input.referenceAssets.length > 0;
    let body: FormData | string;
    let headers: Record<string, string>;
    if (editing) {
      const form = new FormData();
      form.append("model", input.model);
      form.append("prompt", input.prompt);
      form.append("n", "1");
      if (input.parameters.size)
        form.append("size", String(input.parameters.size));
      for (const [index, reference] of input.referenceAssets.entries()) {
        form.append(
          "image[]",
          await referenceBlob(reference.url, context),
          `reference-${index}`,
        );
      }
      body = form;
      headers = providerHeaders(context);
    } else {
      body = JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        n: 1,
        response_format: "url",
        ...(input.parameters.size
          ? { size: String(input.parameters.size) }
          : {}),
        ...(input.parameters.quality
          ? { quality: String(input.parameters.quality) }
          : {}),
        ...(input.parameters.background
          ? { background: String(input.parameters.background) }
          : {}),
      });
      headers = providerHeaders(context, true);
    }
    const response = await providerFetch(
      context,
      providerUrl(context, editing ? "/images/edits" : "/images/generations"),
      {
        method: "POST",
        headers,
        body,
        signal: context.signal,
      },
      { timeoutMs: 120_000 },
    );
    const payload = await readPayload(response, 32 * 1024 * 1024);
    if (!response.ok) return rejectedFromResponse(response.status, payload);
    const providerError = envelopeError(payload);
    if (providerError) return resultFromEnvelopeError(providerError);
    try {
      const mediaUrls = responseMediaUrls(payload, context);
      return mediaUrls.length > 0
        ? { outcome: "completed", mediaUrls }
        : {
            outcome: "outcome_unknown",
            message: "Provider returned success without an image",
          };
    } catch (error) {
      return {
        outcome: "outcome_unknown",
        message:
          error instanceof Error
            ? error.message
            : "Provider response was malformed",
      };
    }
  }
}

function videoResultUrl(
  root: Record<string, unknown>,
  context: ProviderContext,
): URL | undefined {
  const content =
    root.content && typeof root.content === "object"
      ? (root.content as Record<string, unknown>)
      : {};
  const value = [
    root.video_url,
    root.result_url,
    root.url,
    content.video_url,
    content.url,
  ].find((candidate) => typeof candidate === "string" && candidate);
  if (typeof value !== "string" || value.startsWith("data:")) return undefined;
  return new URL(absoluteMediaUrl(value, context));
}

export class OpenAiVideoAdapter implements MediaProviderAdapter {
  readonly version = 1;
  readonly capability = "video" as const;
  readonly type = "openai";

  validate(input: FrozenGenerationInput): void {
    if (!input.prompt.trim()) throw new Error("Video prompt is required");
    if (input.referenceAssets.length > 7)
      throw new Error("Video generation supports at most 7 image references");
  }

  async submit(
    input: FrozenGenerationInput,
    context: ProviderContext,
  ): Promise<ProviderSubmitResult> {
    const form = new FormData();
    form.append("model", input.model);
    form.append("prompt", input.prompt);
    form.append(
      "seconds",
      String(
        Math.max(
          1,
          Math.min(
            20,
            Math.floor(Number(input.parameters.durationSeconds ?? 6)),
          ),
        ),
      ),
    );
    if (input.parameters.size && input.parameters.size !== "auto")
      form.append("size", String(input.parameters.size));
    form.append(
      "resolution_name",
      String(input.parameters.resolution ?? "720p"),
    );
    form.append("preset", "normal");
    for (const [index, reference] of input.referenceAssets.entries()) {
      form.append(
        "input_reference[]",
        await referenceBlob(reference.url, context),
        `reference-${index}`,
      );
    }
    const response = await providerFetch(
      context,
      providerUrl(context, "/videos"),
      {
        method: "POST",
        headers: providerHeaders(context),
        body: form,
        signal: context.signal,
      },
      { timeoutMs: 120_000 },
    );
    const payload = await readPayload(response);
    if (!response.ok) return rejectedFromResponse(response.status, payload);
    const providerError = envelopeError(payload);
    if (providerError) return resultFromEnvelopeError(providerError);
    try {
      const root = envelopeData(payload);
      const id = typeof root.id === "string" ? root.id : undefined;
      return id
        ? { outcome: "accepted", providerTaskId: id, nextPollDelayMs: 2500 }
        : {
            outcome: "outcome_unknown",
            message: "Provider returned success without a video task ID",
          };
    } catch (error) {
      return {
        outcome: "outcome_unknown",
        message:
          error instanceof Error
            ? error.message
            : "Provider response was malformed",
      };
    }
  }

  async poll(
    providerTaskId: string,
    context: ProviderContext,
  ): Promise<ProviderState> {
    const response = await providerFetch(
      context,
      providerUrl(context, `/videos/${encodeURIComponent(providerTaskId)}`),
      {
        headers: providerHeaders(context),
        signal: context.signal,
      },
      { timeoutMs: 15_000 },
    );
    const payload = await readPayload(response);
    if (!response.ok)
      throw new Error(
        errorMessage(
          payload,
          `Video status failed with HTTP ${response.status}`,
        ),
      );
    const root = envelopeData(payload);
    const direct = videoResultUrl(root, context);
    if (direct) return { status: "succeeded", mediaUrls: [direct] };
    const status = String(root.status ?? "").toLowerCase();
    if (["canceled", "cancelled"].includes(status))
      return { status: "canceled" };
    if (["failed", "expired"].includes(status)) {
      return {
        status: "failed",
        errorCode:
          status === "expired"
            ? "provider_task_expired"
            : "provider_task_failed",
        message: errorMessage(root, "Video generation failed"),
      };
    }
    if (status === "completed") {
      return {
        status: "succeeded",
        mediaUrls: [
          providerUrl(
            context,
            `/videos/${encodeURIComponent(providerTaskId)}/content`,
          ),
        ],
      };
    }
    return { status: "pending", nextPollDelayMs: 2500 };
  }

  async cancel(
    providerTaskId: string,
    context: ProviderContext,
  ): Promise<"canceled" | "not_supported" | "unknown"> {
    const response = await providerFetch(
      context,
      providerUrl(
        context,
        `/videos/${encodeURIComponent(providerTaskId)}/cancel`,
      ),
      {
        method: "POST",
        headers: providerHeaders(context),
        signal: context.signal,
      },
      { timeoutMs: 15_000 },
    );
    if ([404, 405, 501].includes(response.status)) return "not_supported";
    if (!response.ok || response.status === 202 || response.status === 204)
      return "unknown";
    const payload = await readPayload(response);
    const root = envelopeData(payload);
    const status = String(root.status ?? "").toLowerCase();
    return ["canceled", "cancelled"].includes(status) ? "canceled" : "unknown";
  }
}
