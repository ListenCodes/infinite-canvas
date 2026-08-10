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
import type {
  FrozenGenerationInput,
  MediaProviderAdapter,
  ProviderContext,
  ProviderState,
} from "./index.js";

const ratios = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;

function closestRatio(size: unknown): string | undefined {
  const value = String(size ?? "");
  if ((ratios as readonly string[]).includes(value)) return value;
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) return undefined;
  const target = Number(match[1]) / Number(match[2]);
  return ratios.reduce((best, candidate) => {
    const [width, height] = candidate.split(":").map(Number) as [
      number,
      number,
    ];
    const [bestWidth, bestHeight] = best.split(":").map(Number) as [
      number,
      number,
    ];
    return Math.abs(width / height - target) <
      Math.abs(bestWidth / bestHeight - target)
      ? candidate
      : best;
  }, "1:1");
}

function pixels(size: unknown): number {
  const match = /^(\d+)x(\d+)$/.exec(String(size ?? ""));
  return match ? Number(match[1]) * Number(match[2]) : 0;
}

export class GrokImageAdapter implements MediaProviderAdapter {
  readonly version = 1;
  readonly capability = "image" as const;

  constructor(
    readonly type: "grok2api" | "sub2api",
    private readonly editModel: string,
  ) {}

  validate(input: FrozenGenerationInput): void {
    if (!input.prompt.trim()) throw new Error("Image prompt is required");
    if (input.referenceAssets.length > 8)
      throw new Error("Grok media supports at most 8 reference images");
    if (pixels(input.parameters.size) > 4_194_304)
      throw new Error("Grok media supports image output up to 2K");
  }

  async submit(
    input: FrozenGenerationInput,
    context: ProviderContext,
  ): Promise<ProviderSubmitResult> {
    const editing = input.referenceAssets.length > 0;
    const requestedPixels = pixels(input.parameters.size);
    const body: Record<string, unknown> = {
      model: editing
        ? this.editModel
        : input.model.includes("edit")
          ? "grok-imagine-image-quality"
          : input.model,
      prompt: input.prompt,
      n: 1,
      response_format: "url",
      stream: false,
      resolution: editing
        ? "1k"
        : ["medium", "high"].includes(String(input.parameters.quality)) ||
            requestedPixels > 1_600_000
          ? "2k"
          : "1k",
    };
    const size = String(input.parameters.size ?? "");
    if (["1024x1024", "1024x1536", "1536x1024"].includes(size))
      body.size = size;
    const aspectRatio = closestRatio(size);
    if (aspectRatio) body.aspect_ratio = aspectRatio;
    if (editing)
      body.images = input.referenceAssets.map(({ url }) => ({
        url: url.toString(),
      }));

    const response = await providerFetch(
      context,
      providerUrl(context, editing ? "/images/edits" : "/images/generations"),
      {
        method: "POST",
        headers: providerHeaders(context, true),
        body: JSON.stringify(body),
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

export class GrokVideoAdapter implements MediaProviderAdapter {
  readonly version = 1;
  readonly capability = "video" as const;

  constructor(readonly type: "grok2api" | "sub2api") {}

  validate(input: FrozenGenerationInput): void {
    if (!input.prompt.trim()) throw new Error("Video prompt is required");
    if (input.referenceAssets.length > 8)
      throw new Error("Grok media supports at most 8 reference images");
  }

  async submit(
    input: FrozenGenerationInput,
    context: ProviderContext,
  ): Promise<ProviderSubmitResult> {
    const duration = Math.max(
      1,
      Math.min(15, Math.round(Number(input.parameters.durationSeconds ?? 8))),
    );
    const resolutionValue = String(
      input.parameters.resolution ?? "720p",
    ).replace(/p$/i, "");
    const resolution = ["480", "720", "1080"].includes(resolutionValue)
      ? `${resolutionValue}p`
      : "720p";
    const body: Record<string, unknown> = {
      model: input.model,
      prompt: input.prompt,
      duration,
      aspect_ratio: closestRatio(input.parameters.size) ?? "16:9",
      resolution,
    };
    if (input.referenceAssets[0])
      body.image = { url: input.referenceAssets[0].url.toString() };
    if (input.referenceAssets.length > 1)
      body.reference_images = input.referenceAssets
        .slice(1)
        .map(({ url }) => ({ url: url.toString() }));
    const response = await providerFetch(
      context,
      providerUrl(context, "/videos/generations"),
      {
        method: "POST",
        headers: providerHeaders(context, true),
        body: JSON.stringify(body),
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
      const taskId =
        typeof root.request_id === "string"
          ? root.request_id
          : typeof root.id === "string"
            ? root.id
            : undefined;
      return taskId
        ? { outcome: "accepted", providerTaskId: taskId, nextPollDelayMs: 2500 }
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
    if (!["done", "completed", "succeeded"].includes(status))
      return { status: "pending", nextPollDelayMs: 2500 };
    const rawUrl =
      root.video && typeof root.video === "object"
        ? (root.video as Record<string, unknown>).url
        : undefined;
    const direct =
      typeof rawUrl === "string" && !rawUrl.startsWith("data:")
        ? absoluteMediaUrl(rawUrl, context)
        : providerUrl(
            context,
            `/videos/${encodeURIComponent(providerTaskId)}/content`,
          ).toString();
    return { status: "succeeded", mediaUrls: [new URL(direct)] };
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
        headers: providerHeaders(context, true),
        body: "{}",
        signal: context.signal,
      },
      { timeoutMs: 15_000 },
    );
    if (
      response.status === 404 ||
      response.status === 405 ||
      response.status === 501
    )
      return "not_supported";
    if (!response.ok || response.status === 202 || response.status === 204)
      return "unknown";
    const payload = await readPayload(response);
    const root = envelopeData(payload);
    const status = String(root.status ?? "").toLowerCase();
    return ["canceled", "cancelled"].includes(status) ? "canceled" : "unknown";
  }
}
