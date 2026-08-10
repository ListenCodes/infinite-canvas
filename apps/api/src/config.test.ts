import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "./config.js";

const baseEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  BUSINESS_DATABASE_URL: "postgresql://api:password@example.com/app",
  BUSINESS_DATABASE_LISTENER_URL: "postgresql://api:password@example.com/app",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-not-real-12345",
  CREDENTIAL_MASTER_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  CORS_ALLOWED_ORIGINS: "https://canvas.example.com",
};

test("production configuration requires a private metrics token", () => {
  assert.throws(
    () => loadConfig(baseEnvironment),
    /METRICS_BEARER_TOKEN is required/,
  );
  const config = loadConfig({
    ...baseEnvironment,
    METRICS_BEARER_TOKEN: "metrics-token-at-least-32-characters-long",
  });
  assert.equal(config.NODE_ENV, "production");
  assert.equal(config.GENERATION_WRITES_ENABLED, "true");
  assert.equal(loadConfig({
    ...baseEnvironment,
    HOST: "127.0.0.1",
    GENERATION_WRITES_ENABLED: "false",
  }).GENERATION_WRITES_ENABLED, "false");
});

test("non-loopback development metrics also fail closed without a token", () => {
  assert.throws(
    () =>
      loadConfig({
        ...baseEnvironment,
        NODE_ENV: "development",
        HOST: "0.0.0.0",
      }),
    /non-loopback host/,
  );
  const loopback = loadConfig({
    ...baseEnvironment,
    NODE_ENV: "development",
    HOST: "127.0.0.1",
  });
  assert.equal(loopback.METRICS_BEARER_TOKEN, undefined);
});
