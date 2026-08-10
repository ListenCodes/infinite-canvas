import { migrateDatabase } from "./migration-runner.js";

const url = process.env.BUSINESS_DATABASE_MIGRATION_URL;
if (!url) throw new Error("BUSINESS_DATABASE_MIGRATION_URL is required; runtime database roles must never run migrations");

const applied = await migrateDatabase(url);
process.stdout.write(applied.length ? `Applied migrations: ${applied.join(", ")}\n` : "Database is up to date\n");
