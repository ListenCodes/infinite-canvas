# ADR 0001: Hatchet multi-service architecture

- Status: accepted
- Baseline: design v1.1

## Context

Infinite Canvas currently ships a Vite application behind Nginx. Browser storage is the product data source and provider requests use browser-held credentials. This cannot provide tenant isolation, durable paid work, refresh recovery, or an auditable credit ledger.

The repository already has independent top-level applications, but no unified workspace. Moving the mature `web/` tree would add risk without changing a runtime boundary.

## Decision

- Keep `web/` at its existing path.
- Add deployable applications under `apps/api` and `apps/worker`.
- Add shared packages under `packages/contracts`, `packages/db`, `packages/domain`, `packages/provider-adapters`, and `packages/observability`.
- Add a root npm workspace for only the new server applications and packages. Existing `web`, `docs`, `canvas-agent`, and plugin lockfiles remain independent until a separate migration is justified.
- Use Fastify for the business API, Drizzle plus explicit SQL migrations for PostgreSQL, Supabase Auth for user identity, private S3-compatible storage for media, and the Hatchet TypeScript SDK for durable execution.
- Business PostgreSQL is authoritative for user-visible projects, assets, jobs, authorization, idempotency, events, and credits. Hatchet is authoritative for execution scheduling and run history.
- Use a transactional outbox between the business transaction and Hatchet trigger. Hatchet idempotency is an additional defense, never the business authority.
- Production starts with Hatchet Cloud and managed Supabase. The same worker supports Hatchet OSS by configuration; local development uses Hatchet Lite.

## Version baseline

- Node.js 24 LTS; target image 24.16.0.
- PostgreSQL 17; baseline 17.10. Hatchet's separate PostgreSQL 15 image is 15.18.
- `@hatchet-dev/typescript-sdk` 1.28.1.
- Fastify 5.11.3, Drizzle ORM 0.45.2, Drizzle Kit 0.31.10, Zod 4.4.3.

Exact application dependencies are committed without floating production image tags. Security patch upgrades require normal tests and a lockfile update.

## Consequences

- API and Worker become independent containers with separate health/readiness checks and resource limits.
- The existing browser-direct media path remains only behind explicit migration feature flags. A server-created job can never fall back to browser execution during rollback.
- Hatchet Cloud, OSS, and Lite must be covered by configuration and deployment documentation; production readiness still requires a real Staging exercise.
