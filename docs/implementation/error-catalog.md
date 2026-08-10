# API and generation error catalog

All public errors use `{ error: { code, message, retryable, correlationId, details } }`. Provider response bodies are stored only as redacted summaries.

| Code | HTTP | Retryable | Meaning |
|---|---:|---:|---|
| `authentication_required` | 401 | no | Session is absent or invalid |
| `account_disabled` | 403 | no | The authenticated profile is disabled |
| `forbidden` | 404 | no | The resource is outside the authorized tenant boundary |
| `validation_failed` | 400 | no | Request fields or limits are invalid |
| `idempotency_key_required` | 400 | no | A mutating endpoint requires `Idempotency-Key` |
| `idempotency_conflict` | 409 | no | The same key was reused for a different request |
| `project_version_conflict` | 409 | yes | The project optimistic-lock version is stale |
| `insufficient_credits` | 409 | no | Available credits cannot cover the reservation |
| `job_not_retryable` | 409 | no | The job state or active attempt does not allow a retry |
| `job_not_cancelable` | 409 | no | The job is already terminal or materialized |
| `content_moderation_rejected` | 422 | no | Provider explicitly rejected the content |
| `provider_parameter_rejected` | 422 | no | Provider rejected model parameters |
| `provider_authentication_failed` | 502 | no | The configured provider credential failed |
| `provider_rate_limited_not_accepted` | 503 | yes | Provider explicitly did not accept the call |
| `provider_unavailable_not_accepted` | 503 | yes | Provider explicitly did not accept the call |
| `provider_outcome_unknown` | 202 | no | A paid create may have been accepted and is under reconciliation |
| `provider_task_failed` | 502 | no | An accepted asynchronous task reached a failed terminal state |
| `provider_task_expired` | 504 | no | Provider task exceeded its frozen business deadline |
| `media_download_failed` | 502 | yes | Existing provider output could not be downloaded |
| `media_type_rejected` | 422 | no | Content type, magic bytes, dimensions, duration, or size is unsafe |
| `media_source_rejected` | 422 | no | The remote media URL failed SSRF policy |
| `object_storage_failed` | 503 | yes | Existing output could not be persisted |
| `dispatch_unavailable` | 503 | yes | Hatchet trigger is unavailable; the outbox remains authoritative |
| `workflow_contract_unsupported` | 500 | no | No compatible Worker handles the frozen workflow version |
| `data_invariant_violation` | 500 | no | A cross-tenant or accounting invariant failed; manual action is required |

An error is retryable only when repeating the specific operation cannot duplicate a paid provider side effect. User-initiated retries create a new attempt only after an explicit API command and balance check.
