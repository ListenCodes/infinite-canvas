import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import postgres from "postgres";

const sourceUrl = process.env.TEST_POSTGRES_ADMIN_URL;
if (!sourceUrl) {
  throw new Error("TEST_POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
}

const databaseName = `infinite_canvas_test_${Date.now()}_${randomBytes(4).toString("hex")}`;
const migrationRole = `${databaseName}_owner`;
const migrationPassword = randomBytes(24).toString("hex");
const testUrl = new URL(sourceUrl);
testUrl.pathname = `/${databaseName}`;
const migrationUrl = new URL(testUrl);
migrationUrl.username = migrationRole;
migrationUrl.password = migrationPassword;
const admin = postgres(sourceUrl, { max: 1, prepare: false });
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(workspace) {
  const result = spawnSync(
    npmCommand,
    ["run", "test:postgres", "-w", workspace],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_POSTGRES_ADMIN_URL: testUrl.toString(),
        TEST_POSTGRES_MIGRATION_URL: migrationUrl.toString(),
        TEST_POSTGRES_MIGRATION_ROLE: migrationRole,
      },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${workspace} PostgreSQL integration tests failed`);
}

try {
  const roleCommands = await admin`
    select format(
      'create role %I login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password %L',
      ${migrationRole}::text, ${migrationPassword}::text
    ) as command
  `;
  await admin.unsafe(roleCommands[0].command);
  await admin.unsafe(`create database "${databaseName}" owner "${migrationRole}"`);
  run("@infinite-canvas/db");
  run("@infinite-canvas/api");
  run("@infinite-canvas/worker");
} finally {
  await admin`
    select pg_terminate_backend(pid)
    from pg_stat_activity
    where datname = ${databaseName} and pid <> pg_backend_pid()
  `;
  await admin.unsafe(`drop database if exists "${databaseName}"`);
  await admin.unsafe(`drop role if exists "${migrationRole}"`);
  await admin.end();
}
