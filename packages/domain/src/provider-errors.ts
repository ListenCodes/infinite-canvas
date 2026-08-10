import type { ApiErrorCode, ProviderAcceptance } from "@infinite-canvas/contracts";

export interface ProviderFailureInput {
  status?: number;
  message?: string;
  code?: string;
  acceptance: ProviderAcceptance;
}

export interface NormalizedProviderFailure {
  code: ApiErrorCode;
  retryable: boolean;
  acceptance: ProviderAcceptance;
}

export function normalizeProviderFailure(input: ProviderFailureInput): NormalizedProviderFailure {
  const text = `${input.code ?? ""} ${input.message ?? ""}`.toLowerCase();
  if (input.acceptance === "unknown") return { code: "provider_outcome_unknown", retryable: false, acceptance: "unknown" };
  if (input.status === 401 || input.status === 403) return { code: "provider_authentication_failed", retryable: false, acceptance: input.acceptance };
  if (input.status === 400 && /moderation|content.?policy|safety|审核|敏感/.test(text)) {
    return { code: "content_moderation_rejected", retryable: false, acceptance: input.acceptance };
  }
  if (input.status === 400 || input.status === 422) return { code: "provider_parameter_rejected", retryable: false, acceptance: input.acceptance };
  if (input.status === 429 && input.acceptance === "not_accepted") {
    return { code: "provider_rate_limited_not_accepted", retryable: true, acceptance: "not_accepted" };
  }
  if (input.status !== undefined && input.status >= 500 && input.acceptance === "not_accepted") {
    return { code: "provider_unavailable_not_accepted", retryable: true, acceptance: "not_accepted" };
  }
  return input.acceptance === "accepted"
    ? { code: "provider_task_failed", retryable: false, acceptance: "accepted" }
    : { code: "provider_unavailable_not_accepted", retryable: true, acceptance: "not_accepted" };
}
