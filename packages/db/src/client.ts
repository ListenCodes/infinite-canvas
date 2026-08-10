import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDatabase>["db"];

export function createDatabase(url: string, options: { max?: number; applicationName?: string } = {}) {
  const client = postgres(url, {
    max: options.max ?? 10,
    connection: { application_name: options.applicationName ?? "infinite-canvas" },
    prepare: false,
    transform: { undefined: null },
  });
  return { client, db: drizzle(client, { schema }) };
}
