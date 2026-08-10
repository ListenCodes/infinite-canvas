import { rollbackInitialMigration } from "./migration-runner.js";

const url = process.env.BUSINESS_DATABASE_MIGRATION_URL;
if (!url) throw new Error("BUSINESS_DATABASE_MIGRATION_URL is required; runtime database roles must never run rollback");

await rollbackInitialMigration(url);
process.stdout.write("Rolled back initial schema\n");
