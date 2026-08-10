import assert from "node:assert/strict";
import { test } from "node:test";

import { hatchetClientOptions, loadWorkerConfig } from "./config.js";

const baseEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  BUSINESS_DATABASE_URL: "postgres://worker:password@database/infinite_canvas",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  HATCHET_MODE: "cloud",
  HATCHET_CLIENT_TOKEN: "test-token-with-embedded-cloud-addresses",
  CREDENTIAL_MASTER_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  S3_REGION: "local",
  S3_ENDPOINT: "http://object-storage:9000",
  S3_BUCKET: "infinite-canvas-assets",
  S3_ACCESS_KEY_ID: "test-access-key",
  S3_SECRET_ACCESS_KEY: "test-secret-key",
};

test("cloud mode accepts token-derived endpoints and defaults to TLS", () => {
  const config = loadWorkerConfig(baseEnvironment);
  const options = hatchetClientOptions(config);
  assert.equal(options.tls_config.tls_strategy, "tls");
  assert.equal("host_port" in options, false);
  assert.equal("api_url" in options, false);
});

test("lite mode requires explicit endpoints and uses plaintext only", () => {
  assert.throws(
    () => loadWorkerConfig({ ...baseEnvironment, HATCHET_MODE: "lite" }),
    /requires explicit HATCHET_CLIENT_HOST_PORT/,
  );
  const config = loadWorkerConfig({
    ...baseEnvironment,
    HATCHET_MODE: "lite",
    HATCHET_CLIENT_HOST_PORT: "hatchet-lite:7077",
    HATCHET_CLIENT_API_URL: "http://hatchet-lite:8888",
  });
  const options = hatchetClientOptions(config);
  assert.equal(options.host_port, "hatchet-lite:7077");
  assert.equal(options.api_url, "http://hatchet-lite:8888");
  assert.equal(options.tls_config.tls_strategy, "none");
});

test("production rejects Lite and incomplete or invalid mTLS configuration", () => {
  assert.throws(
    () => loadWorkerConfig({
      ...baseEnvironment,
      NODE_ENV: "production",
      HATCHET_MODE: "lite",
      HATCHET_CLIENT_HOST_PORT: "hatchet-lite:7077",
      HATCHET_CLIENT_API_URL: "http://hatchet-lite:8888",
    }),
    /not allowed in production/,
  );
  assert.throws(
    () => loadWorkerConfig({
      ...baseEnvironment,
      HATCHET_MODE: "oss",
      HATCHET_CLIENT_HOST_PORT: "hatchet-engine:7077",
      HATCHET_CLIENT_API_URL: "https://hatchet-api.internal",
      HATCHET_CLIENT_TLS_STRATEGY: "mtls",
    }),
    /requires certificate, key, and root CA/,
  );
});
