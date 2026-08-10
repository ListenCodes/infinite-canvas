import { sql } from "drizzle-orm";

import type { Database } from "./client.js";

export async function withUserContext<T>(db: Database, userId: string, operation: (transaction: Parameters<Parameters<Database["transaction"]>[0]>[0]) => Promise<T>): Promise<T> {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    await transaction.execute(sql`select set_config('app.service_role', 'off', true)`);
    return operation(transaction);
  });
}

export async function withServiceContext<T>(db: Database, operation: (transaction: Parameters<Parameters<Database["transaction"]>[0]>[0]) => Promise<T>): Promise<T> {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select set_config('app.service_role', 'on', true)`);
    return operation(transaction);
  });
}
