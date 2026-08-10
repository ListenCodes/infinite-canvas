import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../apps/worker/src/recovery-audit.ts", import.meta.url),
  "utf8",
);
const composeSources = await Promise.all(
  ["local", "cloud", "oss"].map((topology) =>
    readFile(
      new URL(`../infra/compose/${topology}/compose.yaml`, import.meta.url),
      "utf8",
    ),
  ),
);
const errors = [];

for (const forbidden of [
  "@hatchet-dev/",
  "@infinite-canvas/provider-adapters",
  "PutObjectCommand",
  "DeleteObjectCommand",
  "provider_channels",
  "provider_credentials",
]) {
  if (source.includes(forbidden))
    errors.push(`recovery audit imports or references forbidden capability: ${forbidden}`);
}
for (const required of [
  'mode: "read_only_no_hatchet_no_provider"',
  '"isolation level repeatable read read only"',
  "ListObjectsV2Command",
  "GetObjectCommand",
]) {
  if (!source.includes(required))
    errors.push(`recovery audit is missing boundary marker: ${required}`);
}

for (const [index, compose] of composeSources.entries()) {
  const service = /\n  recovery-audit:\n([\s\S]*?)(?=\n  [a-zA-Z0-9_-]+:\n|\nvolumes:|\nnetworks:)/.exec(compose)?.[1];
  if (!service) {
    errors.push(`compose topology ${index} has no recovery-audit service`);
    continue;
  }
  for (const forbidden of [
    "HATCHET_",
    "CREDENTIAL_MASTER_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "OUTBOX_DISPATCHER_ENABLED",
    "UNKNOWN_RECONCILER_ENABLED",
  ]) {
    if (service.includes(forbidden))
      errors.push(`compose topology ${index} recovery audit exposes ${forbidden}`);
  }
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Recovery audit boundary passed\n");
}
