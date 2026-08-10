import type postgres from "postgres";

export interface RuntimeDatabaseIdentity {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  ownsBusinessTables: boolean;
  serviceAuthorized: boolean;
}

export async function inspectRuntimeDatabaseIdentity(sql: postgres.Sql): Promise<RuntimeDatabaseIdentity> {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('app.service_role', 'on', true)`;
    const rows = await transaction<{
      role: string;
      superuser: boolean;
      bypass_rls: boolean;
      owns_business_tables: boolean;
      service_authorized: boolean;
    }[]>`
      select
        session_user::text as role,
        login.rolsuper as superuser,
        login.rolbypassrls as bypass_rls,
        exists (
          select 1
          from pg_class relation
          join pg_namespace namespace on namespace.oid = relation.relnamespace
          where namespace.nspname = 'public'
            and relation.relkind in ('r', 'p')
            and relation.relowner = login.oid
            and relation.relname <> 'app_schema_migrations'
        ) as owns_business_tables,
        app.is_service_role() as service_authorized
      from pg_roles login
      where login.rolname = session_user
    `;
    const identity = rows[0];
    if (!identity) throw new Error("Database login role could not be inspected");
    return {
      role: identity.role,
      superuser: identity.superuser,
      bypassRls: identity.bypass_rls,
      ownsBusinessTables: identity.owns_business_tables,
      serviceAuthorized: identity.service_authorized,
    };
  });
}

export async function assertRuntimeDatabaseRole(sql: postgres.Sql, component: string): Promise<RuntimeDatabaseIdentity> {
  const identity = await inspectRuntimeDatabaseIdentity(sql);
  if (identity.superuser || identity.bypassRls || identity.ownsBusinessTables || !identity.serviceAuthorized) {
    throw new Error(
      `${component} database role ${identity.role} is unsafe: ` +
      `superuser=${identity.superuser}, bypassRls=${identity.bypassRls}, ` +
      `ownsBusinessTables=${identity.ownsBusinessTables}, serviceAuthorized=${identity.serviceAuthorized}`,
    );
  }
  return identity;
}
