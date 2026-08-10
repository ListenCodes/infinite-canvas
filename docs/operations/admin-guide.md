# Administrator Guide

The `/admin` workspace is available only to an active profile with
`platform_role=admin`. The last active administrator cannot disable themselves or
the final remaining administrator.

## Users and wallets

- Disable/restore changes the business profile first and emits an authentication
  synchronization Outbox event. Check Outbox and audit status if Supabase Auth does
  not converge.
- Never edit workspace membership as a side effect of account disable/restore.
- Wallet adjustments require an `Idempotency-Key`, a reason, and explicit
  confirmation for large debits. Repeating the same key replays the saved response;
  using it with another payload is rejected.
- Wallet history is append-only. Corrections use a compensating entry, not SQL
  update/delete.

## Providers and models

- Channel base URLs must resolve to public HTTP(S) addresses. Private, loopback,
  link-local, and metadata endpoints are rejected.
- Credential rotation stores only encrypted envelopes and a suffix. Secret values
  must never be pasted into tickets, logs, documentation, or browser configuration.
- A model freezes channel, adapter type/version, capability, limits, concurrency,
  price, and provider-idempotency support into each attempt. Mark idempotency support
  true only when the provider contract is verified for the exact endpoint.
- Model creation also sets the channel/capability concurrency and requests-per-minute
  policy. Use verified provider terms and Staging load evidence. A changed limit
  appends a policy version; it does not rewrite attempts already in flight.
- The defaults are operational starting values. If a provider returns explicit
  rate-limit headers or contract limits, preserve the evidence in the change record
  and reduce the configured values before increasing Worker replicas.
- Disable unhealthy channels for new attempts; never move an existing attempt to a
  different channel or credential version.

When investigating capacity, correlate Hatchet workspace scheduling with
`provider_channel_capacity_leases` and `generation_capacity_rate_windows`. Do not
manually delete a live lease to make a task run. Pause new channel work instead;
accepted work and authoritative unknown reconciliation must continue under the same
provider limits.

## Unknown outcomes

Use the reconciliation view only with authoritative evidence. Every action requires
an `Idempotency-Key`, reason, and a redacted evidence object with nonempty `source`
and `reference` fields. The reference should identify a provider-console case,
signed audit export, or incident record without embedding credentials.

| Resolution | Required evidence | Result |
|---|---|---|
| Not accepted | Provider request/audit proves no task was created | Fail and release |
| Provider failed | Authoritative terminal failure | Fail and release |
| Accepted | Provider task ID | Resume polling with the same attempt and a new bounded 30-minute execution window |
| Provider succeeded | Stable media URL and provider evidence | Resume materialization and settle after storage |

Do not manually mark success without a recoverable asset. Do not release accepted
work merely because a Worker or Hatchet run is unavailable. At 24 hours unresolved
credits are released to the user, a platform-risk entry is recorded, and later
provider charges are not silently clawed back.

## Audit and incident checks

For every incident correlate API request ID, audit correlation ID, workspace, job,
attempt, Outbox, Hatchet run, provider task, asset key, reservation, and ledger entry.
Export only redacted evidence. Escalate immediately on cross-tenant access, duplicate
provider create, duplicate settlement, object/hash mismatch, secret exposure, or
unknown outcomes approaching the 24-hour deadline.
