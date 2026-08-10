import postgres from "postgres";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const environmentSchema = z.object({
  BUSINESS_DATABASE_PROVISION_URL: z.url(),
  BUSINESS_DATABASE_OBJECT_OWNER_ROLE: z.string().regex(/^[a-z][a-z0-9_]{2,62}$/),
  BUSINESS_DATABASE_API_ROLE: z.string().regex(/^[a-z][a-z0-9_]{2,62}$/).default("infinite_canvas_api"),
  BUSINESS_DATABASE_API_PASSWORD: z.string().min(20),
  BUSINESS_DATABASE_WORKER_ROLE: z.string().regex(/^[a-z][a-z0-9_]{2,62}$/).default("infinite_canvas_worker"),
  BUSINESS_DATABASE_WORKER_PASSWORD: z.string().min(20),
  BUSINESS_DATABASE_RECOVERY_AUDIT_ROLE: z.string().regex(/^[a-z][a-z0-9_]{2,62}$/).default("infinite_canvas_recovery_audit"),
  BUSINESS_DATABASE_RECOVERY_AUDIT_PASSWORD: z.string().min(20),
});

const businessTables = [
  "profiles", "workspaces", "workspace_members", "projects", "project_versions", "assets",
  "provider_channels", "provider_credentials", "model_configs", "model_prices", "wallet_accounts",
  "wallet_entries", "idempotency_requests", "platform_idempotency_requests", "generation_batches", "generation_jobs", "generation_attempts",
  "generation_job_targets", "credit_reservations", "generation_job_events", "outbox_events", "imports",
  "platform_risk_entries", "audit_logs", "import_source_mappings",
  "provider_channel_capacity_policies", "provider_channel_capacity_leases", "generation_capacity_rate_windows",
] as const;
const businessTableNames = new Set<string>(businessTables);

type ProvisionSql = postgres.Sql | postgres.TransactionSql;

async function executeFormatted(sql: ProvisionSql, rows: Promise<{ command: string }[]>): Promise<void> {
  const commands = await rows;
  for (const { command } of commands) await sql.unsafe(command);
}

async function ensureLoginRole(sql: ProvisionSql, role: string, password: string): Promise<void> {
  await executeFormatted(sql, sql<{ command: string }[]>`
    select format('create role %I login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password %L', ${role}::text, ${password}::text) as command
    where not exists (select 1 from pg_roles where rolname = ${role})
  `);
  await executeFormatted(sql, sql<{ command: string }[]>`
    select format('alter role %I with login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password %L', ${role}::text, ${password}::text) as command
  `);
}

export async function provisionRuntimeRoles(rawEnvironment: NodeJS.ProcessEnv): Promise<void> {
  const environment = environmentSchema.parse(rawEnvironment);
  if (new Set([
    environment.BUSINESS_DATABASE_API_ROLE,
    environment.BUSINESS_DATABASE_WORKER_ROLE,
    environment.BUSINESS_DATABASE_RECOVERY_AUDIT_ROLE,
  ]).size !== 3) {
    throw new Error("API, Worker, and recovery-audit database roles must be different login roles");
  }

  const sql = postgres(environment.BUSINESS_DATABASE_PROVISION_URL, { max: 1, prepare: false });
  try {
    await sql.begin(async (transaction) => {
    await executeFormatted(transaction, transaction<{ command: string }[]>`
      select 'create role infinite_canvas_service nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls' as command
      where not exists (select 1 from pg_roles where rolname = 'infinite_canvas_service')
    `);
    await transaction.unsafe(
      "alter role infinite_canvas_service with nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls",
    );
    const objectOwners = await transaction<{ exists: boolean }[]>`
      select exists (
        select 1 from pg_roles where rolname = ${environment.BUSINESS_DATABASE_OBJECT_OWNER_ROLE}
      ) as exists
    `;
    if (!objectOwners[0]?.exists) {
      throw new Error("BUSINESS_DATABASE_OBJECT_OWNER_ROLE does not exist");
    }
    const tableOwners = await transaction<{ name: string; owner: string }[]>`
      select relation.relname as name, owner.rolname as owner
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      join pg_roles owner on owner.oid = relation.relowner
      where namespace.nspname = 'public' and relation.relkind in ('r', 'p')
    `;
    const appRoutineOwners = await transaction<{ name: string; owner: string }[]>`
      select routine.oid::regprocedure::text as name, owner.rolname as owner
      from pg_proc routine
      join pg_namespace namespace on namespace.oid = routine.pronamespace
      join pg_roles owner on owner.oid = routine.proowner
      where namespace.nspname = 'app'
    `;
    const ownedObjects = [
      ...tableOwners.filter(({ name }) => businessTableNames.has(name)).map((row) => ({ ...row, kind: "table" })),
      ...appRoutineOwners.map((row) => ({ ...row, kind: "routine" })),
    ];
    const misownedObjects = ownedObjects.filter(({ owner }) => owner !== environment.BUSINESS_DATABASE_OBJECT_OWNER_ROLE);
    if (misownedObjects.length > 0) {
      const details = misownedObjects.map(({ kind, name, owner }) => `${kind} ${name} is owned by ${owner}`).join(", ");
      throw new Error(`BUSINESS_DATABASE_OBJECT_OWNER_ROLE does not own the current database objects: ${details}`);
    }
    await executeFormatted(transaction, transaction<{ command: string }[]>`
      select format(
        'alter default privileges for role %I revoke execute on functions from public',
        ${environment.BUSINESS_DATABASE_OBJECT_OWNER_ROLE}::text
      ) as command
    `);
    await transaction.unsafe("revoke execute on all functions in schema app from public");
    await ensureLoginRole(transaction, environment.BUSINESS_DATABASE_API_ROLE, environment.BUSINESS_DATABASE_API_PASSWORD);
    await ensureLoginRole(transaction, environment.BUSINESS_DATABASE_WORKER_ROLE, environment.BUSINESS_DATABASE_WORKER_PASSWORD);
    await ensureLoginRole(
      transaction,
      environment.BUSINESS_DATABASE_RECOVERY_AUDIT_ROLE,
      environment.BUSINESS_DATABASE_RECOVERY_AUDIT_PASSWORD,
    );

    const tableList = tableOwners
      .map(({ name }) => name)
      .filter((name) => businessTableNames.has(name))
      .map((table) => `\"${table}\"`)
      .join(", ");
    for (const role of [environment.BUSINESS_DATABASE_API_ROLE, environment.BUSINESS_DATABASE_WORKER_ROLE]) {
      await executeFormatted(transaction, transaction<{ command: string }[]>`
        select format('grant infinite_canvas_service to %I', ${role}::text) as command
        union all select format('grant connect on database %I to %I', current_database(), ${role}::text)
        union all select format('grant usage on schema public, app to %I', ${role}::text)
        union all select format('grant usage, select on all sequences in schema public to %I', ${role}::text)
        union all select format('grant execute on all functions in schema app to %I', ${role}::text)
        union all select format(
          'alter default privileges for role %I in schema app grant execute on functions to %I',
          ${environment.BUSINESS_DATABASE_OBJECT_OWNER_ROLE}::text, ${role}::text
        )
        union all select format(
          'alter default privileges for role %I in schema public grant select, insert, update, delete on tables to %I',
          ${environment.BUSINESS_DATABASE_OBJECT_OWNER_ROLE}::text, ${role}::text
        )
        union all select format(
          'alter default privileges for role %I in schema public grant usage, select on sequences to %I',
          ${environment.BUSINESS_DATABASE_OBJECT_OWNER_ROLE}::text, ${role}::text
        )
      `);
      if (tableList) {
        await executeFormatted(transaction, transaction<{ command: string }[]>`
          select format(${`grant select, insert, update, delete on table ${tableList} to %I`}, ${role}::text) as command
        `);
      }
    }
    await executeFormatted(transaction, transaction<{ command: string }[]>`
      select format('grant infinite_canvas_service to %I', ${environment.BUSINESS_DATABASE_RECOVERY_AUDIT_ROLE}::text) as command
      union all select format('grant connect on database %I to %I', current_database(), ${environment.BUSINESS_DATABASE_RECOVERY_AUDIT_ROLE}::text)
      union all select format('grant usage on schema public, app to %I', ${environment.BUSINESS_DATABASE_RECOVERY_AUDIT_ROLE}::text)
      union all select format('grant select on table app_schema_migrations to %I', ${environment.BUSINESS_DATABASE_RECOVERY_AUDIT_ROLE}::text)
      union all select format(
        'grant execute on function app.current_user_id(), app.is_service_role(), app.is_platform_admin(), app.has_workspace_access(uuid, workspace_role[]) to %I',
        ${environment.BUSINESS_DATABASE_RECOVERY_AUDIT_ROLE}::text
      )
      union all select format(
        'alter default privileges for role %I in schema public grant select on tables to %I',
        ${environment.BUSINESS_DATABASE_OBJECT_OWNER_ROLE}::text, ${environment.BUSINESS_DATABASE_RECOVERY_AUDIT_ROLE}::text
      )
    `);
    if (tableList) {
      await executeFormatted(transaction, transaction<{ command: string }[]>`
        select format(${`grant select on table ${tableList} to %I`}, ${environment.BUSINESS_DATABASE_RECOVERY_AUDIT_ROLE}::text) as command
      `);
    }
    });
  } finally {
    await sql.end();
  }
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1]!)).href;
if (isMain) {
  await provisionRuntimeRoles(process.env);
  process.stdout.write("Runtime database roles provisioned\n");
}
