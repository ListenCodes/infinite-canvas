import { createHash } from "node:crypto";

import { AppError } from "./errors.js";

export interface IdempotencyRow {
  id: string;
  request_hash: string;
  status: "processing" | "completed" | "failed";
  response_body: unknown;
}

export function assertIdempotencyKey(value: string): void {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new AppError(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key must contain 8 to 128 safe characters",
    );
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

export function idempotencyRequestHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}
