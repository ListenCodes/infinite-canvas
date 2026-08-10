import type postgres from "postgres";

export type Sql = postgres.Sql;
export type TransactionSql = postgres.TransactionSql;

export async function setServiceContext(sql: TransactionSql): Promise<void> {
  await sql`select set_config('app.service_role', 'on', true)`;
}

export async function setUserContext(sql: TransactionSql, userId: string): Promise<void> {
  await sql`select set_config('app.user_id', ${userId}, true)`;
  await sql`select set_config('app.service_role', 'off', true)`;
}
