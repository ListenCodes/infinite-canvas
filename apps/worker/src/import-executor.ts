import type postgres from "postgres";

import type { LocalDataImportWorkflowInput } from "@infinite-canvas/contracts";
import { parseLocalDataArchive } from "@infinite-canvas/importer";

import type { ObjectStorage } from "./storage.js";

type Sql = postgres.Sql;

export class InvalidImportError extends Error {}

function rewriteSourceIds(value: unknown, mappings: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return mappings.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => rewriteSourceIds(item, mappings));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, rewriteSourceIds(item, mappings)]));
}

function assetKind(mime: string): "image" | "video" | "audio" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "audio";
}

export class ImportExecutor {
  constructor(
    private readonly sql: Sql,
    private readonly storage: ObjectStorage,
    private readonly maxArchiveBytes: number,
    private readonly createId: () => string,
  ) {}

  async execute(input: LocalDataImportWorkflowInput): Promise<{ status: "published"; projects: number; assets: number }> {
    await this.setStatus(input.importId, "validating");
    const archive = await this.storage.readObject(input.objectKey);
    let parsed: ReturnType<typeof parseLocalDataArchive>;
    try {
      parsed = parseLocalDataArchive(archive, this.maxArchiveBytes * 3);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Import archive is invalid";
      await this.fail(input.importId, "invalid_import_archive", message);
      throw new InvalidImportError(message);
    }
    const importRows = await this.sql.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'on', true)`;
      return transaction<{ manifest_sha256: string; status: string }[]>`
        select manifest_sha256, status from imports
        where id = ${input.importId} and workspace_id = ${input.workspaceId} and user_id = ${input.userId}
      `;
    });
    const importRow = importRows[0];
    if (!importRow || importRow.manifest_sha256 !== parsed.manifestSha256) {
      await this.fail(input.importId, "import_manifest_mismatch", "Stored archive does not match the registered manifest");
      throw new InvalidImportError("Stored archive does not match import record");
    }
    if (importRow.status === "published") return { status: "published", projects: parsed.projects.length, assets: parsed.assets.length };
    if (!["validating", "importing"].includes(importRow.status))
      throw new InvalidImportError("Import is no longer active");

    const objectKeys = new Map<string, string>();
    for (const [sha256, body] of parsed.objects) {
      const asset = parsed.assets.find((candidate) => candidate.sha256 === sha256);
      if (!asset) throw new InvalidImportError(`Object ${sha256} has no asset metadata`);
      const key = `${input.workspaceId}/imports/${input.importId}/objects/${sha256}`;
      await this.storage.putImportObject(key, body, asset.mime);
      objectKeys.set(sha256, key);
    }

    try {
      return await this.sql.begin(async (transaction) => {
        await transaction`select set_config('app.service_role', 'on', true)`;
        const locked = await transaction<{ status: string }[]>`
          select status from imports where id = ${input.importId} and workspace_id = ${input.workspaceId} for update
        `;
        if (!locked[0]) throw new InvalidImportError("Import record disappeared");
        if (locked[0].status === "published") return { status: "published" as const, projects: parsed.projects.length, assets: parsed.assets.length };
        if (!["validating", "importing"].includes(locked[0].status))
          throw new InvalidImportError("Import is no longer active");
        await transaction`update imports set status = 'importing', updated_at = now() where id = ${input.importId}`;

        const sourceMappings = new Map<string, string>();
        const assetIdsBySha = new Map<string, string>();
        for (const asset of parsed.assets) {
          let assetId = assetIdsBySha.get(asset.sha256);
          if (!assetId) {
            assetId = this.createId();
            assetIdsBySha.set(asset.sha256, assetId);
            await transaction`
              insert into assets (
                id, workspace_id, kind, status, object_key, mime, bytes, sha256, import_id, source_id
              ) values (
                ${assetId}, ${input.workspaceId}, ${asset.kind ?? assetKind(asset.mime)}, 'ready',
                ${objectKeys.get(asset.sha256)!}, ${asset.mime}, ${asset.bytes}::bigint, ${asset.sha256},
                ${input.importId}, ${asset.sourceId}
              ) on conflict (object_key) do update set updated_at = now()
              returning id
            `;
          }
          sourceMappings.set(asset.sourceId, assetId);
          await transaction`
            insert into import_source_mappings (import_id, workspace_id, entity_type, source_id, target_id)
            values (${input.importId}, ${input.workspaceId}, 'asset', ${asset.sourceId}, ${assetId})
            on conflict (import_id, entity_type, source_id) do update set target_id = excluded.target_id
          `;
        }

        for (const project of parsed.projects) {
          const projectId = this.createId();
          const documentJson = rewriteSourceIds(project.documentJson, sourceMappings);
          await transaction`
            insert into projects (
              id, workspace_id, title, document_json, updated_by, import_id, source_id
            ) values (
              ${projectId}, ${input.workspaceId}, ${project.title}, ${JSON.stringify(documentJson)}::jsonb,
              ${input.userId}, ${input.importId}, ${project.sourceId}
            ) on conflict (workspace_id, import_id, source_id) do update
              set title = excluded.title, document_json = excluded.document_json, updated_at = now()
            returning id
          `;
          const persisted = await transaction<{ id: string }[]>`
            select id from projects
            where workspace_id = ${input.workspaceId} and import_id = ${input.importId} and source_id = ${project.sourceId}
          `;
          const targetId = persisted[0]?.id ?? projectId;
          sourceMappings.set(project.sourceId, targetId);
          await transaction`
            insert into project_versions (id, workspace_id, project_id, version, snapshot_json, reason, created_by)
            values (${this.createId()}, ${input.workspaceId}, ${targetId}, 1, ${JSON.stringify(documentJson)}::jsonb, 'local_import', ${input.userId})
            on conflict (project_id, version) do nothing
          `;
          await transaction`
            insert into import_source_mappings (import_id, workspace_id, entity_type, source_id, target_id)
            values (${input.importId}, ${input.workspaceId}, 'project', ${project.sourceId}, ${targetId})
            on conflict (import_id, entity_type, source_id) do update set target_id = excluded.target_id
          `;
        }

        const mappings = Object.fromEntries(sourceMappings);
        await transaction`
          update imports
          set status = 'published', counts_json = ${JSON.stringify({ ...parsed.manifest.counts, mappings })}::jsonb,
              published_at = now(), error_code = null, error_message = null, updated_at = now()
          where id = ${input.importId}
        `;
        await transaction`
          insert into audit_logs (
            id, workspace_id, actor_user_id, actor_type, action, target_type, target_id, after_summary, correlation_id
          ) values (
            ${this.createId()}, ${input.workspaceId}, ${input.userId}, 'user', 'local_import.publish',
            'import', ${input.importId}, ${JSON.stringify(parsed.manifest.counts)}::jsonb, ${`import:${input.importId}`}
          )
        `;
        return { status: "published" as const, projects: parsed.projects.length, assets: parsed.assets.length };
      });
    } catch (error) {
      await this.fail(input.importId, "import_publish_failed", error instanceof Error ? error.message : "Import publication failed");
      throw error;
    }
  }

  private async setStatus(importId: string, status: "validating" | "importing"): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'on', true)`;
      if (status === "validating")
        await transaction`
          update imports set status = 'validating', updated_at = now()
          where id = ${importId} and status = 'uploaded'
        `;
      else
        await transaction`
          update imports set status = 'importing', updated_at = now()
          where id = ${importId} and status in ('validating', 'importing')
        `;
    });
  }

  private async fail(importId: string, code: string, message: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`select set_config('app.service_role', 'on', true)`;
      await transaction`
        update imports set status = 'failed', error_code = ${code}, error_message = ${message.slice(0, 500)}, updated_at = now()
        where id = ${importId} and status in ('validating', 'importing')
      `;
    });
  }
}
