import { createServer, type Server } from "node:http";

import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import type { Logger } from "@infinite-canvas/observability";
import type postgres from "postgres";

interface OperationalMetrics {
  pending_outbox: number;
  oldest_outbox_seconds: number;
  outcome_unknown: number;
  oldest_unknown_seconds: number;
  queued_jobs: number;
  reserved_credits: number;
  oldest_reserved_seconds: number;
  oldest_active_attempt_seconds: number;
  invariant_violations: number;
  unhealthy_channels: number;
  overdue_active_attempts: number;
}

export class WorkerMetricsServer {
  readonly #registry = new Registry();
  readonly #pendingOutbox: Gauge;
  readonly #oldestOutbox: Gauge;
  readonly #outcomeUnknown: Gauge;
  readonly #oldestUnknown: Gauge;
  readonly #queuedJobs: Gauge;
  readonly #reservedCredits: Gauge;
  readonly #oldestReserved: Gauge;
  readonly #oldestActiveAttempt: Gauge;
  readonly #invariantViolations: Gauge;
  readonly #unhealthyChannels: Gauge;
  readonly #overdueActiveAttempts: Gauge;
  readonly #providerRequests: Counter;
  readonly #providerRequestDuration: Histogram;
  #server: Server | undefined;

  constructor(
    private readonly sql: postgres.Sql,
    private readonly port: number,
    private readonly logger: Logger,
  ) {
    collectDefaultMetrics({ register: this.#registry, prefix: "infinite_canvas_worker_" });
    this.#pendingOutbox = new Gauge({ name: "infinite_canvas_outbox_pending", help: "Pending or leased outbox rows", registers: [this.#registry] });
    this.#oldestOutbox = new Gauge({ name: "infinite_canvas_outbox_oldest_seconds", help: "Age of the oldest pending outbox row", registers: [this.#registry] });
    this.#outcomeUnknown = new Gauge({ name: "infinite_canvas_outcome_unknown", help: "Attempts awaiting authoritative outcome reconciliation", registers: [this.#registry] });
    this.#oldestUnknown = new Gauge({ name: "infinite_canvas_outcome_unknown_oldest_seconds", help: "Age of the oldest unresolved unknown outcome", registers: [this.#registry] });
    this.#queuedJobs = new Gauge({ name: "infinite_canvas_generation_jobs_queued", help: "Generation jobs that have not reached a worker", registers: [this.#registry] });
    this.#reservedCredits = new Gauge({ name: "infinite_canvas_credits_reserved", help: "Credits currently frozen across all workspaces", registers: [this.#registry] });
    this.#oldestReserved = new Gauge({ name: "infinite_canvas_credit_reservation_oldest_seconds", help: "Age of the oldest active credit reservation", registers: [this.#registry] });
    this.#oldestActiveAttempt = new Gauge({ name: "infinite_canvas_active_attempt_oldest_seconds", help: "Age of the oldest accepted or materializing attempt", registers: [this.#registry] });
    this.#invariantViolations = new Gauge({ name: "infinite_canvas_financial_invariant_violations", help: "Wallet/reservation consistency violations requiring immediate investigation", registers: [this.#registry] });
    this.#unhealthyChannels = new Gauge({ name: "infinite_canvas_provider_channels_unhealthy", help: "Active provider channels whose health status is not healthy", registers: [this.#registry] });
    this.#overdueActiveAttempts = new Gauge({ name: "infinite_canvas_active_attempts_overdue", help: "Nonterminal attempts more than five minutes beyond their business deadline", registers: [this.#registry] });
    this.#providerRequests = new Counter({ name: "infinite_canvas_provider_requests_total", help: "Provider HTTP requests by response or transport code", labelNames: ["code"] as const, registers: [this.#registry] });
    this.#providerRequestDuration = new Histogram({ name: "infinite_canvas_provider_request_duration_seconds", help: "Provider HTTP request duration", labelNames: ["code"] as const, buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120], registers: [this.#registry] });
  }

  observeProviderRequest(observation: { code: string; durationSeconds: number }): void {
    this.#providerRequests.inc({ code: observation.code });
    this.#providerRequestDuration.observe({ code: observation.code }, observation.durationSeconds);
  }

  async start(): Promise<void> {
    if (this.#server) return;
    this.#server = createServer((request, response) => {
      if (request.method !== "GET" || request.url !== "/metrics") {
        response.writeHead(404).end("Not Found");
        return;
      }
      void this.render(response);
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(this.port, "0.0.0.0", resolve);
    });
    this.logger.info({ port: this.port }, "worker metrics server started");
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  private async render(response: import("node:http").ServerResponse): Promise<void> {
    try {
      const values = await this.sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        return transaction<OperationalMetrics[]>`
          select
            (select count(*)::int from outbox_events where status in ('pending', 'sending')) as pending_outbox,
            coalesce((select extract(epoch from now() - min(created_at))::float from outbox_events where status in ('pending', 'sending')), 0) as oldest_outbox_seconds,
            (select count(*)::int from generation_attempts where status = 'outcome_unknown') as outcome_unknown,
            coalesce((select extract(epoch from now() - min(outcome_unknown_at))::float from generation_attempts where status = 'outcome_unknown'), 0) as oldest_unknown_seconds,
            (select count(*)::int from generation_jobs where status in ('queued', 'dispatching')) as queued_jobs,
            coalesce((select sum(amount)::float from credit_reservations where status = 'reserved'), 0) as reserved_credits,
            coalesce((select extract(epoch from now() - min(created_at))::float from credit_reservations where status = 'reserved'), 0) as oldest_reserved_seconds,
            coalesce((select extract(epoch from now() - min(updated_at))::float from generation_attempts where status in ('accepted', 'materializing')), 0) as oldest_active_attempt_seconds,
            (
              select count(*)::int
              from (
                select account.workspace_id
                from wallet_accounts account
                left join (
                  select workspace_id, sum(amount) as amount
                  from credit_reservations
                  where status = 'reserved'
                  group by workspace_id
                ) reservation on reservation.workspace_id = account.workspace_id
                where account.reserved <> coalesce(reservation.amount, 0)
                union all
                select reservation.workspace_id
                from credit_reservations reservation
                join generation_attempts attempt on attempt.id = reservation.attempt_id
                where reservation.status = 'reserved'
                  and attempt.status in ('succeeded', 'failed', 'canceled')
              ) violation
            ) as invariant_violations,
            (select count(*)::int from provider_channels where status = 'active' and health_status in ('degraded', 'unhealthy')) as unhealthy_channels,
            (select count(*)::int from generation_attempts where status in ('created', 'claimed', 'submitting', 'accepted', 'materializing') and business_deadline_at + interval '5 minutes' < now()) as overdue_active_attempts
        `;
      });
      const value = values[0];
      if (!value) throw new Error("Operational metrics query returned no row");
      this.#pendingOutbox.set(Number(value.pending_outbox));
      this.#oldestOutbox.set(Number(value.oldest_outbox_seconds));
      this.#outcomeUnknown.set(Number(value.outcome_unknown));
      this.#oldestUnknown.set(Number(value.oldest_unknown_seconds));
      this.#queuedJobs.set(Number(value.queued_jobs));
      this.#reservedCredits.set(Number(value.reserved_credits));
      this.#oldestReserved.set(Number(value.oldest_reserved_seconds));
      this.#oldestActiveAttempt.set(Number(value.oldest_active_attempt_seconds));
      this.#invariantViolations.set(Number(value.invariant_violations));
      this.#unhealthyChannels.set(Number(value.unhealthy_channels));
      this.#overdueActiveAttempts.set(Number(value.overdue_active_attempts));
      response.writeHead(200, { "Content-Type": this.#registry.contentType });
      response.end(await this.#registry.metrics());
    } catch (error) {
      this.logger.error({ err: error }, "worker metrics collection failed");
      response.writeHead(503, { "Content-Type": "text/plain" }).end("Metrics unavailable");
    }
  }
}
