import assert from "node:assert/strict";
import { test } from "node:test";

import { createLogger } from "./index.js";

test("structured logs redact platform credentials and authorization canaries", () => {
  const canaries = {
    authorization: "secret-canary-authorization-0001",
    serviceRole: "secret-canary-service-role-0002",
    credentialMaster: "secret-canary-credential-master-0003",
    hatchet: "secret-canary-hatchet-0004",
    database: "secret-canary-database-0005",
    storage: "secret-canary-storage-0006",
  };
  let output = "";
  const logger = createLogger("secret-boundary-test", "info", {
    write(chunk) {
      output += chunk;
    },
  });
  logger.info({
    req: { headers: { authorization: `Bearer ${canaries.authorization}` } },
    config: {
      SUPABASE_SERVICE_ROLE_KEY: canaries.serviceRole,
      CREDENTIAL_MASTER_KEY: canaries.credentialMaster,
      HATCHET_CLIENT_TOKEN: canaries.hatchet,
      BUSINESS_DATABASE_URL: canaries.database,
      S3_SECRET_ACCESS_KEY: canaries.storage,
    },
    provider: { credential: canaries.serviceRole },
  }, "canary request");
  logger.error({ err: new Error(`provider request failed: ${canaries.hatchet}`) }, "provider failure");

  for (const canary of Object.values(canaries)) assert.equal(output.includes(canary), false);
  assert.match(output, /\[REDACTED\]/);
});
