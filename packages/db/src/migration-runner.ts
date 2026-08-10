import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = resolve(packageDir, "migrations");

export interface MigrationFile {
  name: string;
  path: string;
}

export async function collectMigrationFiles(directory = migrationsDir): Promise<MigrationFile[]> {
  const files: MigrationFile[] = [];

  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "down") continue;
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/^\d+.*\.sql$/.test(entry.name)) {
        files.push({ name: relative(directory, path).split(sep).join("/"), path });
      }
    }
  }

  await visit(directory);
  const order = (await readFile(resolve(directory, "order.txt"), "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (new Set(order).size !== order.length)
    throw new Error("Migration order contains duplicate entries");
  const byName = new Map(files.map((file) => [file.name, file]));
  const missing = order.filter((name) => !byName.has(name));
  const unlisted = files
    .map((file) => file.name)
    .filter((name) => !order.includes(name));
  if (missing.length > 0 || unlisted.length > 0) {
    throw new Error(
      `Migration order mismatch: missing=[${missing.join(",")}], unlisted=[${unlisted.join(",")}]`,
    );
  }
  return order.map((name) => byName.get(name)!);
}

export interface MigrationOptions {
  through?: string;
}

export async function migrateDatabase(
  url: string,
  options: MigrationOptions = {},
): Promise<string[]> {
  const client = postgres(url, { max: 1, prepare: false });
  let migrationLockHeld = false;
  try {
    await client`select pg_advisory_lock(hashtext('infinite_canvas_schema_migrations'))`;
    migrationLockHeld = true;
    await client.unsafe(`create table if not exists app_schema_migrations (name text primary key, sha256 text not null, applied_at timestamptz not null default now())`);
    const migrations = await collectMigrationFiles();
    const targetIndex = options.through
      ? migrations.findIndex(({ name }) => name === options.through)
      : migrations.length - 1;
    if (targetIndex < 0) {
      throw new Error(`Unknown migration target: ${options.through}`);
    }
    const prepared = await Promise.all(
      migrations.map(async (migration) => {
        const body = await readFile(migration.path, "utf8");
        return {
          ...migration,
          body,
          checksum: createHash("sha256").update(body).digest("hex"),
        };
      }),
    );
    const existingRows = await client<{ name: string; sha256: string }[]>`
      select name, sha256 from app_schema_migrations
    `;
    const existing = new Map(existingRows.map((row) => [row.name, row.sha256]));
    const knownNames = new Set(prepared.map((migration) => migration.name));
    const unknownApplied = existingRows
      .map((row) => row.name)
      .filter((name) => !knownNames.has(name));
    if (unknownApplied.length > 0)
      throw new Error(
        `Database contains unknown migrations: ${unknownApplied.join(", ")}`,
      );
    let encounteredPending = false;
    for (const migration of prepared) {
      const appliedChecksum = existing.get(migration.name);
      if (appliedChecksum && appliedChecksum !== migration.checksum)
        throw new Error(`Applied migration changed: ${migration.name}`);
      if (!appliedChecksum) encounteredPending = true;
      else if (encounteredPending)
        throw new Error(
          `Applied migrations are not a prefix of order.txt: ${migration.name}`,
        );
    }
    const applied: string[] = [];
    for (const [index, { name, body, checksum }] of prepared.entries()) {
      if (index > targetIndex) break;
      if (existing.has(name)) continue;
      await client.begin(async (transaction) => {
        await transaction.unsafe(body);
        await transaction`insert into app_schema_migrations (name, sha256) values (${name}, ${checksum})`;
      });
      applied.push(name);
    }
    return applied;
  } finally {
    if (migrationLockHeld) {
      await client`select pg_advisory_unlock(hashtext('infinite_canvas_schema_migrations'))`;
    }
    await client.end();
  }
}

export async function rollbackInitialMigration(url: string): Promise<void> {
  if (process.env.ALLOW_DESTRUCTIVE_MIGRATION_ROLLBACK !== "initial-schema") throw new Error("Set ALLOW_DESTRUCTIVE_MIGRATION_ROLLBACK=initial-schema to confirm rollback");
  const client = postgres(url, { max: 1, prepare: false });
  try {
    const body = await readFile(resolve(migrationsDir, "down", "0001_initial.sql"), "utf8");
    await client.begin(async (transaction) => {
      await transaction.unsafe(body);
      await transaction`delete from app_schema_migrations`;
    });
  } finally {
    await client.end();
  }
}
