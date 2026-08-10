import type postgres from "postgres";

import {
  assertRuntimeDatabaseRole,
  type RuntimeDatabaseIdentity,
} from "@infinite-canvas/db";

export type RuntimeRoleAssertion = (
  sql: postgres.Sql,
  component: string,
) => Promise<RuntimeDatabaseIdentity>;

export async function assertApiDatabaseTopology(
  database: postgres.Sql,
  listener: postgres.Sql,
  assertRole: RuntimeRoleAssertion = assertRuntimeDatabaseRole,
): Promise<{ database: RuntimeDatabaseIdentity; listener: RuntimeDatabaseIdentity }> {
  const databaseIdentity = await assertRole(database, "API");
  const listenerIdentity = await assertRole(listener, "API event listener");
  if (listenerIdentity.role !== databaseIdentity.role) {
    throw new Error(
      `API database roles must match: primary=${databaseIdentity.role}, listener=${listenerIdentity.role}`,
    );
  }
  return { database: databaseIdentity, listener: listenerIdentity };
}
