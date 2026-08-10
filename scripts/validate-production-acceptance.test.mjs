import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { acceptanceScenarios, validateProductionAcceptance } from "./validate-production-acceptance.mjs";

const sourceSha = "1".repeat(40);
const tag = "v0.15.1";
const reference = (service, character) =>
  `ghcr.io/listencodes/infinite-canvas-${service}@sha256:${character.repeat(64)}`;

function fixtures() {
  const releaseManifest = {
    schemaVersion: 1,
    source: { repository: "ListenCodes/infinite-canvas", commit: sourceSha, ref: `refs/tags/${tag}`, event: "push", runId: 1 },
    releaseTag: tag,
    images: Object.fromEntries(["web", "api", "worker"].map((service, index) => [service, { reference: reference(service, String.fromCharCode(97 + index)) }])),
  };
  const releaseManifestBytes = Buffer.from(JSON.stringify(releaseManifest));
  const acceptanceManifest = {
    schemaVersion: 1,
    candidate: {
      releaseTag: tag,
      sourceSha,
      releaseManifestSha256: createHash("sha256").update(releaseManifestBytes).digest("hex"),
      images: Object.fromEntries(["web", "api", "worker"].map((service, index) => [service, reference(service, String.fromCharCode(97 + index))])),
    },
    environment: "production-candidate",
    recordedAt: "2026-08-10T00:00:00Z",
    rows: acceptanceScenarios.map((scenario, index) => ({
      id: index + 1,
      scenario,
      result: "passed",
      evidenceTier: index === 14 ? "managed-production-restore" : "staging-production-equivalent",
      evidenceUri: `https://evidence.example/releases/${tag}/row-${index + 1}`,
      observedAt: "2026-08-10T00:00:00Z",
      operator: "operator@example.com",
      reviewer: "reviewer@example.com",
      procedure: `release-acceptance-row-${index + 1}`,
      limitations: [],
    })),
  };
  const acceptanceManifestBytes = Buffer.from(JSON.stringify(acceptanceManifest));
  return {
    releaseManifest,
    releaseManifestBytes,
    acceptanceManifest,
    acceptanceManifestBytes,
    expectedTag: tag,
    expectedSource: sourceSha,
    expectedAcceptanceSha256: createHash("sha256").update(acceptanceManifestBytes).digest("hex"),
  };
}

test("production acceptance binds every passed row to one immutable candidate", () => {
  assert.deepEqual(validateProductionAcceptance(fixtures()), []);
});

test("production acceptance rejects a missing or limited row", () => {
  const missing = fixtures();
  missing.acceptanceManifest.rows.pop();
  assert.match(validateProductionAcceptance(missing).join("\n"), /exactly 15 rows/);

  const limited = fixtures();
  limited.acceptanceManifest.rows[12].limitations.push("outage lasted only five minutes");
  assert.match(validateProductionAcceptance(limited).join("\n"), /row 13 has unresolved limitations/);
});

test("production acceptance rejects candidate drift and mutable evidence links", () => {
  const input = fixtures();
  input.acceptanceManifest.candidate.images.worker = reference("worker", "f");
  input.acceptanceManifest.rows[0].evidenceUri = "https://evidence.example/report?token=signed";
  const errors = validateProductionAcceptance(input).join("\n");
  assert.match(errors, /worker image differs/);
  assert.match(errors, /non-signed HTTPS URL/);
});

test("production acceptance rejects unreviewed file replacement", () => {
  const input = fixtures();
  input.expectedAcceptanceSha256 = "f".repeat(64);
  assert.match(validateProductionAcceptance(input).join("\n"), /reviewed SHA-256/);
});
