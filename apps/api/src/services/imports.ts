import type { SupabaseClient } from "@supabase/supabase-js";

import { parseLocalDataArchive } from "@infinite-canvas/importer";

import type { Sql } from "../database.js";
import { setServiceContext, setUserContext } from "../database.js";
import { AppError } from "../errors.js";
import type { IdFactory } from "../ids.js";
import { publicImportErrorMessage } from "../public-errors.js";

interface ImportRow {
  id: string;
  workspace_id: string;
  status: "uploaded" | "validating" | "importing" | "published" | "failed" | "deleted";
  manifest_sha256: string;
  counts_json: Record<string, unknown>;
  error_code: string | null;
  error_message: string | null;
  published_at: Date | null;
}

export class ImportService {
  constructor(
    private readonly sql: Sql,
    private readonly supabase: SupabaseClient,
    private readonly bucket: string,
    private readonly maxUploadBytes: number,
    private readonly createId: IdFactory,
  ) {}

  async create(userId: string, archive: Buffer) {
    if (archive.byteLength > this.maxUploadBytes) throw new AppError(413, "import_too_large", "Import archive exceeds the upload limit");
    let parsed: ReturnType<typeof parseLocalDataArchive>;
    try {
      parsed = parseLocalDataArchive(archive, this.maxUploadBytes * 3);
    } catch {
      throw new AppError(422, "invalid_import_archive", "Import archive is invalid");
    }
    const claimed = await this.sql.begin(async (transaction) => {
      await setServiceContext(transaction);
      const features = await transaction<{ enabled: boolean }[]>`
        select cloud_projects_enabled as enabled
        from profiles where user_id = ${userId} and status = 'active'
      `;
      if (!features[0]?.enabled)
        throw new AppError(
          403,
          "feature_disabled",
          "Cloud data import is not enabled for this account",
        );
      const memberships = await transaction<{ workspace_id: string }[]>`
        select member.workspace_id
        from workspace_members member
        join workspaces workspace on workspace.id = member.workspace_id and workspace.status = 'active'
        where member.user_id = ${userId} and member.status = 'active' and member.role in ('owner', 'editor')
        order by member.created_at limit 1
      `;
      const workspaceId = memberships[0]?.workspace_id;
      if (!workspaceId) throw new AppError(403, "workspace_write_forbidden", "No writable workspace is available");
      const importId = this.createId();
      const objectKey = `${workspaceId}/imports/${importId}/${parsed.manifestSha256}.zip`;
      await transaction`
        insert into imports (
          id, workspace_id, user_id, client_export_id, schema_version, status,
          object_key, manifest_sha256, counts_json
        ) values (
          ${importId}, ${workspaceId}, ${userId}, ${parsed.manifest.clientExportId}, 1, 'uploaded',
          ${objectKey}, ${parsed.manifestSha256}, ${JSON.stringify(parsed.manifest.counts)}::jsonb
        ) on conflict (user_id, client_export_id) do nothing
      `;
      const existing = await transaction<ImportRow[]>`
        select id, workspace_id, status, manifest_sha256, counts_json, error_code, error_message, published_at
        from imports where user_id = ${userId} and client_export_id = ${parsed.manifest.clientExportId}
        for update
      `;
      const current = existing[0];
      if (!current) throw new Error("Import claim returned no row");
      if (current.workspace_id !== workspaceId || current.manifest_sha256 !== parsed.manifestSha256) {
        throw new AppError(409, "import_id_conflict", "clientExportId was already used by a different archive");
      }
      return { current, workspaceId, objectKey: `${workspaceId}/imports/${current.id}/${current.manifest_sha256}.zip` };
    });
    if (claimed.current.status === "published") return this.response(claimed.current);
    if (["validating", "importing"].includes(claimed.current.status))
      return this.response(claimed.current);
    if (claimed.current.status === "deleted")
      throw new AppError(
        409,
        "import_id_conflict",
        "A deleted import cannot be restarted with the same clientExportId",
      );

    const uploaded = await this.supabase.storage.from(this.bucket).upload(claimed.objectKey, archive, {
      contentType: "application/zip",
      upsert: false,
      cacheControl: "no-cache",
    });
    if (uploaded.error) {
      const existingObject = await this.supabase.storage.from(this.bucket).info(claimed.objectKey);
      if (existingObject.error || existingObject.data.size !== archive.byteLength) {
        throw new AppError(503, "object_storage_failed", "Could not store import archive");
      }
    }

    const row = await this.sql.begin(async (transaction) => {
      await setServiceContext(transaction);
      const imports = await transaction<ImportRow[]>`
        select id, workspace_id, status, manifest_sha256, counts_json, error_code, error_message, published_at
        from imports where user_id = ${userId} and client_export_id = ${parsed.manifest.clientExportId}
        for update
      `;
      const current = imports[0];
      if (!current || current.manifest_sha256 !== parsed.manifestSha256) throw new AppError(409, "import_id_conflict", "Import claim changed before dispatch");
      let responseRow = current;
      if (["uploaded", "failed"].includes(current.status)) {
        if (current.status === "failed") {
          const reset = await transaction<ImportRow[]>`
            update imports
            set status = 'uploaded', error_code = null, error_message = null, updated_at = now()
            where id = ${current.id} and status = 'failed'
            returning id, workspace_id, status, manifest_sha256, counts_json,
                      error_code, error_message, published_at
          `;
          responseRow = reset[0] ?? current;
        }
        await transaction`
          insert into outbox_events (id, workspace_id, topic, aggregate_id, dedupe_key, payload)
          values (
            ${this.createId()}, ${claimed.workspaceId}, 'data.import.requested', ${current.id},
            ${`data.import.requested:${current.id}`},
            ${JSON.stringify({
              schemaVersion: 1,
              workflowName: "local-data-import-v1",
              importId: current.id,
              workspaceId: claimed.workspaceId,
              userId,
              objectKey: claimed.objectKey,
            })}::jsonb
          ) on conflict (dedupe_key) do update
            set status = case when outbox_events.status = 'dead' then 'pending'::outbox_status else outbox_events.status end,
                available_at = now(), updated_at = now()
        `;
      }
      return responseRow;
    });
    return this.response(row);
  }

  async get(userId: string, importId: string) {
    const rows = await this.sql.begin(async (transaction) => {
      await setUserContext(transaction, userId);
      return transaction<ImportRow[]>`
        select import_record.id, import_record.workspace_id, import_record.status,
               import_record.manifest_sha256, import_record.counts_json,
               import_record.error_code, import_record.error_message, import_record.published_at
        from imports import_record
        join workspace_members member on member.workspace_id = import_record.workspace_id
        where import_record.id = ${importId} and import_record.user_id = ${userId}
          and member.user_id = ${userId} and member.status = 'active'
      `;
    });
    if (!rows[0]) throw new AppError(404, "import_not_found", "Import was not found");
    return this.response(rows[0]);
  }

  private response(row: ImportRow) {
    return {
      importId: row.id,
      status: row.status,
      counts: row.counts_json,
      ...(row.error_code
        ? {
            error: {
              code: row.error_code,
              message: publicImportErrorMessage(row.error_code),
            },
          }
        : {}),
      ...(row.published_at ? { publishedAt: row.published_at.toISOString() } : {}),
    };
  }
}
