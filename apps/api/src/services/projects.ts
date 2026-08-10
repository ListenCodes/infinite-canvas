import { createProjectRequestSchema, projectProjectionSchema, sessionBootstrapResponseSchema, updateProjectRequestSchema, type ProjectProjection, type SessionBootstrapResponse } from "@infinite-canvas/contracts";
import { jsonParameter } from "@infinite-canvas/db";

import type { Sql, TransactionSql } from "../database.js";
import { setServiceContext, setUserContext } from "../database.js";
import { AppError } from "../errors.js";
import type { IdFactory } from "../ids.js";
import {
  assertIdempotencyKey,
  idempotencyRequestHash,
  type IdempotencyRow,
} from "../request-idempotency.js";

export const createProjectSchema = createProjectRequestSchema;
export const updateProjectSchema = updateProjectRequestSchema;

interface WorkspaceRow {
  workspace_id: string;
  role: "owner" | "editor" | "viewer";
  name: string;
}

interface ProjectRow {
  id: string;
  workspace_id: string;
  title: string;
  document_json: Record<string, unknown>;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface ProfileFeatureRow {
  cloud_projects_enabled: boolean;
  cloud_image_enabled: boolean;
  cloud_video_enabled: boolean;
  cloud_credits_enabled: boolean;
}

async function assertCloudProjectsEnabled(
  transaction: TransactionSql,
  userId: string,
): Promise<void> {
  const rows = await transaction<{ enabled: boolean }[]>`
    select cloud_projects_enabled as enabled
    from profiles where user_id = ${userId} and status = 'active'
  `;
  if (!rows[0]?.enabled)
    throw new AppError(
      403,
      "feature_disabled",
      "Cloud project writes are not enabled for this account",
    );
}

function projectProjection(row: ProjectRow): ProjectProjection {
  return projectProjectionSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    documentJson: row.document_json,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

export class ProjectService {
  constructor(private readonly sql: Sql, private readonly createId: IdFactory) {}

  async assertAccountAccess(userId: string): Promise<void> {
    const rows = await this.sql.begin(async (transaction) => {
      await setServiceContext(transaction);
      return transaction<{ status: "active" | "disabled" | "deleted" }[]>`
        select status from profiles where user_id = ${userId}
      `;
    });
    if (rows[0] && rows[0].status !== "active") throw new AppError(403, "account_disabled", "This account is not active");
  }

  async bootstrap(userId: string, email?: string): Promise<SessionBootstrapResponse> {
    return this.sql.begin(async (transaction) => {
      await setServiceContext(transaction);
      const existingProfile = await transaction<{ status: string }[]>`select status from profiles where user_id = ${userId} for update`;
      if (existingProfile[0] && existingProfile[0].status !== "active") throw new AppError(403, "account_disabled", "This account is not active");
      await transaction`
        insert into profiles (user_id, display_name, last_login_at)
        values (${userId}, ${email?.split("@")[0] || "User"}, now())
        on conflict (user_id) do update set last_login_at = now(), updated_at = now()
      `;
      const profiles = await transaction<
        (ProfileFeatureRow & { platform_role: "user" | "admin" })[]
      >`
        select platform_role, cloud_projects_enabled, cloud_image_enabled,
               cloud_video_enabled, cloud_credits_enabled
        from profiles where user_id = ${userId}
      `;
      const profile = profiles[0];
      if (!profile) throw new Error("Session profile was not created");
      const rows = await transaction<WorkspaceRow[]>`
        select member.workspace_id, member.role, workspace.name
        from workspace_members member
        join workspaces workspace on workspace.id = member.workspace_id
        where member.user_id = ${userId} and member.status = 'active' and workspace.status = 'active'
        order by member.created_at
        limit 1
        for update of member, workspace
      `;
      let workspace = rows[0];
      if (!workspace) {
        const workspaceId = this.createId();
        await transaction`
          insert into workspaces (id, owner_user_id, name)
          values (${workspaceId}, ${userId}, ${email ? `${email.split("@")[0]}'s workspace` : "My workspace"})
        `;
        await transaction`
          insert into workspace_members (workspace_id, user_id, role)
          values (${workspaceId}, ${userId}, 'owner')
        `;
        await transaction`insert into wallet_accounts (workspace_id) values (${workspaceId})`;
        workspace = { workspace_id: workspaceId, role: "owner", name: "My workspace" };
      }
      const wallet = await transaction<{ available: string; reserved: string }[]>`
        select available::text, reserved::text from wallet_accounts where workspace_id = ${workspace.workspace_id}
      `;
      return sessionBootstrapResponseSchema.parse({
        userId,
        workspaceId: workspace.workspace_id,
        role: workspace.role,
        platformRole: profile.platform_role,
        featureFlags: {
          projects: profile.cloud_projects_enabled,
          imageGeneration: profile.cloud_image_enabled,
          videoGeneration: profile.cloud_video_enabled,
          credits: profile.cloud_credits_enabled,
        },
        wallet: wallet[0] ?? { available: "0", reserved: "0" },
      });
    });
  }

  async list(userId: string): Promise<ProjectProjection[]> {
    const rows = await this.sql.begin(async (transaction) => {
      await setUserContext(transaction, userId);
      return transaction<ProjectRow[]>`
        select project.id, project.workspace_id, project.title, project.document_json,
               project.version, project.created_at, project.updated_at
        from projects project
        where project.deleted_at is null
        order by project.updated_at desc
      `;
    });
    return rows.map(projectProjection);
  }

  async get(userId: string, projectId: string): Promise<ProjectProjection> {
    const rows = await this.sql.begin(async (transaction) => {
      await setUserContext(transaction, userId);
      return transaction<ProjectRow[]>`
        select id, workspace_id, title, document_json, version, created_at, updated_at
        from projects where id = ${projectId} and deleted_at is null
      `;
    });
    if (!rows[0]) throw new AppError(404, "project_not_found", "Project was not found");
    return projectProjection(rows[0]);
  }

  async create(
    userId: string,
    input: import("zod").infer<typeof createProjectSchema>,
    idempotencyKey: string,
  ): Promise<ProjectProjection> {
    assertIdempotencyKey(idempotencyKey);
    input = createProjectSchema.parse(input);
    return this.sql.begin(async (transaction) => {
      await setUserContext(transaction, userId);
      await assertCloudProjectsEnabled(transaction, userId);
      const memberships = await transaction<{ workspace_id: string }[]>`
        select member.workspace_id
        from workspace_members member
        join workspaces workspace on workspace.id = member.workspace_id and workspace.status = 'active'
        where member.user_id = ${userId} and member.status = 'active' and member.role in ('owner', 'editor')
          and member.workspace_id = ${input.workspaceId}::uuid
        order by member.created_at limit 1
      `;
      const workspaceId = memberships[0]?.workspace_id;
      if (!workspaceId) throw new AppError(403, "workspace_write_forbidden", "The selected workspace is not writable");
      const clientProjectId = input.clientProjectId;
      const operation = `project.create:${userId}`;
      const requestHash = idempotencyRequestHash({
        workspaceId,
        clientProjectId,
      });
      let requests = await transaction<IdempotencyRow[]>`
        insert into idempotency_requests (id, workspace_id, operation, key, request_hash, expires_at)
        values (${this.createId()}, ${workspaceId}, ${operation}, ${idempotencyKey}, ${requestHash}, now() + interval '30 days')
        on conflict (workspace_id, operation, key) do nothing
        returning id, request_hash, status, response_body
      `;
      if (!requests[0]) {
        requests = await transaction<IdempotencyRow[]>`
          select id, request_hash, status, response_body
          from idempotency_requests
          where workspace_id = ${workspaceId} and operation = ${operation} and key = ${idempotencyKey}
          for update
        `;
      }
      const request = requests[0];
      if (!request || request.request_hash !== requestHash) {
        throw new AppError(409, "idempotency_key_conflict", "Idempotency-Key was already used for a different local project");
      }
      if (request.status === "completed") {
        return projectProjectionSchema.parse(request.response_body);
      }
      if (request.status !== "processing") {
        throw new AppError(409, "idempotency_request_failed", "The previous project creation did not complete");
      }
      let rows = await transaction<ProjectRow[]>`
        select id, workspace_id, title, document_json, version, created_at, updated_at
        from projects
        where workspace_id = ${workspaceId} and created_by = ${userId}
          and client_project_id = ${clientProjectId} and deleted_at is null
        for update
      `;
      let created = false;
      if (!rows[0]) {
        const projectId = this.createId();
        rows = await transaction<ProjectRow[]>`
        insert into projects (id, workspace_id, created_by, client_project_id, title, document_json, updated_by)
        values (${projectId}, ${workspaceId}, ${userId}, ${clientProjectId}, ${input.title}, ${jsonParameter(transaction, input.documentJson)}, ${userId})
        on conflict (workspace_id, created_by, client_project_id) do nothing
        returning id, workspace_id, title, document_json, version, created_at, updated_at
      `;
        created = Boolean(rows[0]);
        if (!rows[0]) {
          rows = await transaction<ProjectRow[]>`
            select id, workspace_id, title, document_json, version, created_at, updated_at
            from projects
            where workspace_id = ${workspaceId} and created_by = ${userId}
              and client_project_id = ${clientProjectId} and deleted_at is null
          `;
        }
      }
      const project = rows[0];
      if (!project) throw new Error("Project binding could not be resolved");
      if (created) await transaction`
        insert into project_versions (id, workspace_id, project_id, version, snapshot_json, reason, created_by)
        values (${this.createId()}, ${workspaceId}, ${project.id}, 1, ${jsonParameter(transaction, input.documentJson)}, 'create', ${userId})
      `;
      const response = projectProjection(project);
      await transaction`
        update idempotency_requests
        set status = 'completed', response_status = 201,
            response_body = ${jsonParameter(transaction, response)}, updated_at = now()
        where id = ${request.id}
      `;
      return response;
    });
  }

  async update(userId: string, projectId: string, input: import("zod").infer<typeof updateProjectSchema>): Promise<ProjectProjection> {
    return this.sql.begin(async (transaction) => {
      await setUserContext(transaction, userId);
      await assertCloudProjectsEnabled(transaction, userId);
      const rows = await transaction<ProjectRow[]>`
        update projects project
        set title = ${input.title}, document_json = ${jsonParameter(transaction, input.documentJson)},
            version = project.version + 1, updated_by = ${userId}, updated_at = now()
        where project.id = ${projectId} and project.version = ${input.version} and project.deleted_at is null
          and exists (
            select 1 from workspace_members member
            join workspaces workspace on workspace.id = member.workspace_id and workspace.status = 'active'
            where member.workspace_id = project.workspace_id and member.user_id = ${userId}
              and member.status = 'active' and member.role in ('owner', 'editor')
          )
        returning project.id, project.workspace_id, project.title, project.document_json,
                  project.version, project.created_at, project.updated_at
      `;
      const project = rows[0];
      if (!project) {
        const current = await transaction<{ version: number }[]>`
          select version from projects where id = ${projectId} and deleted_at is null
        `;
        if (current[0]) throw new AppError(409, "project_version_conflict", "Project has changed", { currentVersion: current[0].version });
        throw new AppError(404, "project_not_found", "Project was not found");
      }
      await transaction`
        insert into project_versions (id, workspace_id, project_id, version, snapshot_json, reason, created_by)
        values (${this.createId()}, ${project.workspace_id}, ${project.id}, ${project.version},
                ${jsonParameter(transaction, input.documentJson)}, 'save', ${userId})
      `;
      await transaction`
        insert into generation_job_events (
          workspace_id, aggregate_type, aggregate_id, project_id, type, payload
        ) values (
          ${project.workspace_id}, 'project', ${project.id}, ${project.id},
          'project.version_changed', ${transaction.json({ version: project.version })}
        )
      `;
      return projectProjection(project);
    });
  }
}
