import type { ProviderSubmitResult } from "@infinite-canvas/contracts";
import {
  normalizeProviderFailure,
  secureFetch,
  type SecureFetchOptions,
} from "@infinite-canvas/domain";

import type { ProviderContext } from "./index.js";

const MAX_MEDIA_URL_LENGTH = 16 * 1024;

export async function providerFetch(
  context: ProviderContext,
  url: URL,
  init: RequestInit = {},
  options: SecureFetchOptions = {},
) {
  const startedAt = performance.now();
  try {
    const response = await secureFetch(url, init, {
      ...options,
      ...(context.addressResolver ? { resolver: context.addressResolver } : {}),
    });
    context.observeRequest?.({
      code: String(response.status),
      durationSeconds: (performance.now() - startedAt) / 1000,
    });
    return response;
  } catch (error) {
    context.observeRequest?.({
      code:
        error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "network_error",
      durationSeconds: (performance.now() - startedAt) / 1000,
    });
    throw error;
  }
}

export function providerUrl(context: ProviderContext, path: string): URL {
  const base = context.baseUrl.toString().replace(/\/$/, "");
  return new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
}

export function providerHeaders(
  context: ProviderContext,
  json = false,
): Record<string, string> {
  return {
    Authorization: `Bearer ${context.credential}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(context.idempotencyKey
      ? { "Idempotency-Key": context.idempotencyKey }
      : {}),
  };
}

export async function readPayload(
  response: Response,
  maxBytes = 1024 * 1024,
): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error("Provider response exceeded the configured JSON limit");
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error("Provider response exceeded the configured JSON limit");
    }
    chunks.push(value);
  }
  const text = new TextDecoder().decode(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
  );
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {
      message: /<[a-z][\s\S]*>/i.test(text)
        ? `Provider returned an HTML error page (HTTP ${response.status})`
        : text.slice(0, 500),
    };
  }
}

export function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === "string") return value.slice(0, 500);
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  return (
    errorMessage(record.error, "") ||
    errorMessage(record.msg, "") ||
    errorMessage(record.message, "") ||
    errorMessage(record.detail, "") ||
    fallback
  );
}

export function envelopeData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Provider returned a malformed response");
  const record = value as Record<string, unknown>;
  if (record.code !== undefined && record.code !== 0 && record.code !== "0") {
    throw new Error(
      errorMessage(record, `Provider error ${String(record.code)}`),
    );
  }
  return record.data &&
    typeof record.data === "object" &&
    !Array.isArray(record.data)
    ? (record.data as Record<string, unknown>)
    : record;
}

export function envelopeError(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  return record.code !== undefined && record.code !== 0 && record.code !== "0"
    ? errorMessage(record, `Provider error ${String(record.code)}`)
    : undefined;
}

export function rejectedFromResponse(
  status: number,
  payload: unknown,
): ProviderSubmitResult {
  const message = errorMessage(
    payload,
    `Provider request failed with HTTP ${status}`,
  );
  const acceptance = [400, 401, 403, 404, 405, 413, 415, 422].includes(status)
    ? "not_accepted"
    : "unknown";
  if (acceptance === "unknown") return { outcome: "outcome_unknown", message };
  const normalized = normalizeProviderFailure({ status, message, acceptance });
  return {
    outcome: "rejected",
    errorCode: normalized.code,
    message,
    retryable: normalized.retryable,
    acceptance: normalized.acceptance,
  };
}

export function resultFromEnvelopeError(message: string): ProviderSubmitResult {
  if (/moderation|content\s*policy|safety|sensitive/i.test(message)) {
    return {
      outcome: "rejected",
      errorCode: "content_moderation_rejected",
      message,
      retryable: false,
      acceptance: "not_accepted",
    };
  }
  return { outcome: "outcome_unknown", message };
}

export function absoluteMediaUrl(
  value: string,
  context: ProviderContext,
): string {
  const url = new URL(value, context.baseUrl);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Provider returned a non-HTTP media URL");
  const result = url.toString();
  if (result.length > MAX_MEDIA_URL_LENGTH)
    throw new Error("Provider returned an oversized media URL");
  return result;
}

export function responseMediaUrls(
  value: unknown,
  context: ProviderContext,
): string[] {
  const root = envelopeData(value);
  const items = [root.data, root.images, root.results].find(Array.isArray) as
    Array<Record<string, unknown>> | undefined;
  return (items ?? []).flatMap((item) => {
    if (typeof item.b64_json === "string" && item.b64_json) {
      if (!context.idempotencyKey)
        throw new Error(
          "Provider returned inline media without idempotent submission support",
        );
      return [`data:image/png;base64,${item.b64_json}`];
    }
    if (typeof item.url === "string" && item.url)
      return [absoluteMediaUrl(item.url, context)];
    return [];
  });
}
