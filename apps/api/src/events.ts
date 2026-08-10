import type postgres from "postgres";

import { generationEventSchema, type GenerationEvent } from "@infinite-canvas/contracts";

import type { Sql } from "./database.js";
import { setUserContext } from "./database.js";
import { AppError } from "./errors.js";

interface NotifyPayload {
  workspaceId: string;
  sequence: string;
}

interface EventRow {
  sequence: string;
  workspace_id: string;
  project_id: string | null;
  batch_id: string | null;
  job_id: string | null;
  attempt_id: string | null;
  type: GenerationEvent["type"];
  payload: Record<string, unknown>;
  created_at: Date;
}

type Subscriber = (payload: NotifyPayload) => void;

export class EventBroker {
  readonly #subscribers = new Set<Subscriber>();
  #listenMeta: postgres.ListenMeta | undefined;

  constructor(private readonly listener: Sql) {}

  async start(): Promise<void> {
    if (this.#listenMeta) return;
    this.#listenMeta = await this.listener.listen("generation_job_events", (raw) => {
      try {
        const payload = JSON.parse(raw) as NotifyPayload;
        if (typeof payload.workspaceId !== "string" || typeof payload.sequence !== "string") return;
        for (const subscriber of this.#subscribers) subscriber(payload);
      } catch {
        // The five-second cursor scan is the recovery path for malformed or lost notifications.
      }
    });
  }

  subscribe(subscriber: Subscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  async close(): Promise<void> {
    await this.#listenMeta?.unlisten();
    this.#listenMeta = undefined;
    await this.listener.end({ timeout: 5 });
  }
}

export class EventService {
  constructor(private readonly sql: Sql) {}

  async workspaceForUser(userId: string, projectId?: string, requestedWorkspaceId?: string): Promise<string> {
    const rows = await this.sql.begin(async (transaction) => {
      await setUserContext(transaction, userId);
      return projectId
      ? transaction<{ workspace_id: string }[]>`
          select project.workspace_id
          from projects project
          join workspace_members member on member.workspace_id = project.workspace_id
          where project.id = ${projectId} and project.deleted_at is null
            and member.user_id = ${userId} and member.status = 'active'
            and (${requestedWorkspaceId ?? null}::uuid is null or project.workspace_id = ${requestedWorkspaceId ?? null}::uuid)
        `
      : transaction<{ workspace_id: string }[]>`
          select workspace_id from workspace_members
          where user_id = ${userId} and status = 'active' and workspace_id = ${requestedWorkspaceId!}
        `;
    });
    const workspaceId = rows[0]?.workspace_id;
    if (!workspaceId) throw new AppError(404, "workspace_access_forbidden", "The event workspace was not found");
    return workspaceId;
  }

  async after(userId: string, workspaceId: string, cursor: string, projectId?: string): Promise<GenerationEvent[]> {
    const rows: EventRow[] = await this.sql.begin(async (transaction) => {
      await setUserContext(transaction, userId);
      return projectId
      ? transaction<EventRow[]>`
          select event.sequence::text, event.workspace_id, event.project_id, event.batch_id,
                 event.job_id, event.attempt_id, event.type, event.payload, event.created_at
          from generation_job_events event
          join workspace_members member on member.workspace_id = event.workspace_id
          where event.workspace_id = ${workspaceId}
            and member.user_id = ${userId} and member.status = 'active'
            and event.sequence > ${cursor}::bigint and event.project_id = ${projectId}
          order by event.sequence limit 500
        `
      : transaction<EventRow[]>`
          select event.sequence::text, event.workspace_id, event.project_id, event.batch_id,
                 event.job_id, event.attempt_id, event.type, event.payload, event.created_at
          from generation_job_events event
          join workspace_members member on member.workspace_id = event.workspace_id
          where event.workspace_id = ${workspaceId}
            and member.user_id = ${userId} and member.status = 'active'
            and event.sequence > ${cursor}::bigint
          order by event.sequence limit 500
        `;
    });
    return rows.map((row) => generationEventSchema.parse({
      sequence: row.sequence,
      type: row.type,
      workspaceId: row.workspace_id,
      ...(row.project_id ? { projectId: row.project_id } : {}),
      ...(row.batch_id ? { batchId: row.batch_id } : {}),
      ...(row.job_id ? { jobId: row.job_id } : {}),
      ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
      ...(typeof row.payload.attemptNo === "number" ? { attemptNo: row.payload.attemptNo } : {}),
      ...(typeof row.payload.jobVersion === "number" ? { jobVersion: row.payload.jobVersion } : {}),
      occurredAt: row.created_at.toISOString(),
      payload: row.payload,
    }));
  }
}
