import assert from "node:assert/strict";
import { test } from "node:test";

import type postgres from "postgres";
import type { RuntimeDatabaseIdentity } from "@infinite-canvas/db";

import { assertApiDatabaseTopology, type RuntimeRoleAssertion } from "./database-topology.js";

const sql = {} as postgres.Sql;
const safeIdentity = (role: string): RuntimeDatabaseIdentity => ({
  role,
  superuser: false,
  bypassRls: false,
  ownsBusinessTables: false,
  serviceAuthorized: true,
});

test("API validates both primary and listener connections as the same runtime role", async () => {
  const components: string[] = [];
  const assertRole: RuntimeRoleAssertion = async (_connection, component) => {
    components.push(component);
    return safeIdentity("infinite_canvas_api");
  };

  const identities = await assertApiDatabaseTopology(sql, sql, assertRole);
  assert.deepEqual(components, ["API", "API event listener"]);
  assert.equal(identities.database.role, "infinite_canvas_api");
  assert.equal(identities.listener.role, "infinite_canvas_api");
});

test("API rejects an unsafe listener before LISTEN starts", async () => {
  const assertRole: RuntimeRoleAssertion = async (_connection, component) => {
    if (component === "API event listener") throw new Error("listener role is unsafe");
    return safeIdentity("infinite_canvas_api");
  };

  await assert.rejects(
    assertApiDatabaseTopology(sql, sql, assertRole),
    /listener role is unsafe/,
  );
});

test("API rejects a separately authorized listener role", async () => {
  const identities = [safeIdentity("infinite_canvas_api"), safeIdentity("another_runtime_role")];
  const assertRole: RuntimeRoleAssertion = async () => identities.shift()!;

  await assert.rejects(
    assertApiDatabaseTopology(sql, sql, assertRole),
    /API database roles must match/,
  );
});
