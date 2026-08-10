import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const acceptanceScenarios = [
  "tenant-isolation",
  "forged-authority",
  "ten-identical-keys",
  "three-images-two-fail",
  "browser-close-relogin",
  "four-video-refresh-windows",
  "moderation-400",
  "lost-paid-response",
  "unknown-deadlines",
  "three-worker-crash-points",
  "two-api-sse-replicas",
  "last-event-id-recovery",
  "hatchet-cloud-30-minute-outage",
  "secret-boundary",
  "combined-restore",
];

const exactKeys = (value, expected) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fullSha = /^[a-f0-9]{40}$/;
const digestReference = /^ghcr\.io\/listencodes\/infinite-canvas-(web|api|worker)@sha256:[a-f0-9]{64}$/;

function validUtcTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= Date.now() + 5 * 60_000;
}

function validEvidenceUri(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function validateProductionAcceptance({
  releaseManifest,
  releaseManifestBytes,
  acceptanceManifest,
  acceptanceManifestBytes,
  expectedTag,
  expectedSource,
  expectedAcceptanceSha256,
}) {
  const errors = [];
  if (!/^v[^\s]+$/.test(expectedTag ?? "")) errors.push("expected release tag is invalid");
  if (!fullSha.test(expectedSource ?? "")) errors.push("expected source SHA is invalid");
  if (!/^[a-f0-9]{64}$/.test(expectedAcceptanceSha256 ?? "")) {
    errors.push("expected acceptance SHA-256 is invalid");
  } else if (sha256(acceptanceManifestBytes) !== expectedAcceptanceSha256) {
    errors.push("production acceptance file does not match the reviewed SHA-256");
  }

  if (releaseManifest?.schemaVersion !== 1) errors.push("release manifest schemaVersion must be 1");
  if (releaseManifest?.releaseTag !== expectedTag) errors.push("release tag does not match release manifest");
  if (releaseManifest?.source?.commit !== expectedSource) errors.push("source SHA does not match release manifest");
  if (releaseManifest?.source?.ref !== `refs/tags/${expectedTag}`) errors.push("release manifest is not bound to the tag");

  const serviceNames = ["api", "web", "worker"];
  const releaseImages = releaseManifest?.images;
  if (!exactKeys(releaseImages, serviceNames)) errors.push("release manifest must contain exactly three services");

  if (!exactKeys(acceptanceManifest, ["schemaVersion", "candidate", "environment", "recordedAt", "rows"])) {
    errors.push("production acceptance top-level fields are invalid");
  }
  if (acceptanceManifest?.schemaVersion !== 1) errors.push("production acceptance schemaVersion must be 1");
  if (acceptanceManifest?.environment !== "production-candidate") {
    errors.push("production acceptance environment must be production-candidate");
  }
  if (!validUtcTimestamp(acceptanceManifest?.recordedAt)) errors.push("production acceptance recordedAt is invalid");

  const candidate = acceptanceManifest?.candidate;
  if (!exactKeys(candidate, ["releaseTag", "sourceSha", "releaseManifestSha256", "images"])) {
    errors.push("production acceptance candidate fields are invalid");
  }
  if (candidate?.releaseTag !== expectedTag) errors.push("acceptance release tag does not match");
  if (candidate?.sourceSha !== expectedSource) errors.push("acceptance source SHA does not match");
  if (candidate?.releaseManifestSha256 !== sha256(releaseManifestBytes)) {
    errors.push("acceptance release manifest SHA-256 does not match");
  }
  if (!exactKeys(candidate?.images, serviceNames)) errors.push("acceptance must bind exactly three image references");
  for (const service of serviceNames) {
    const reference = candidate?.images?.[service];
    if (!digestReference.test(reference ?? "")) errors.push(`acceptance ${service} image reference is invalid`);
    if (reference !== releaseImages?.[service]?.reference) errors.push(`acceptance ${service} image differs from release manifest`);
  }

  const rows = acceptanceManifest?.rows;
  if (!Array.isArray(rows) || rows.length !== acceptanceScenarios.length) {
    errors.push("production acceptance must contain exactly 15 rows");
  } else {
    rows.forEach((row, index) => {
      const id = index + 1;
      if (!exactKeys(row, ["id", "scenario", "result", "evidenceTier", "evidenceUri", "observedAt", "operator", "reviewer", "procedure", "limitations"])) {
        errors.push(`acceptance row ${id} fields are invalid`);
        return;
      }
      if (row.id !== id || row.scenario !== acceptanceScenarios[index]) errors.push(`acceptance row ${id} identity is invalid`);
      if (row.result !== "passed") errors.push(`acceptance row ${id} did not pass`);
      const expectedTier = id === 15 ? "managed-production-restore" : "staging-production-equivalent";
      if (row.evidenceTier !== expectedTier) errors.push(`acceptance row ${id} evidence tier is invalid`);
      if (!validEvidenceUri(row.evidenceUri)) errors.push(`acceptance row ${id} evidence URI must be a non-signed HTTPS URL`);
      if (!validUtcTimestamp(row.observedAt)) errors.push(`acceptance row ${id} observedAt is invalid`);
      if (typeof row.operator !== "string" || !row.operator.trim()) errors.push(`acceptance row ${id} operator is required`);
      if (typeof row.reviewer !== "string" || !row.reviewer.trim() || row.reviewer === row.operator) {
        errors.push(`acceptance row ${id} requires an independent reviewer`);
      }
      if (typeof row.procedure !== "string" || !row.procedure.trim()) errors.push(`acceptance row ${id} procedure is required`);
      if (!Array.isArray(row.limitations) || row.limitations.length !== 0) errors.push(`acceptance row ${id} has unresolved limitations`);
    });
  }

  const rawAcceptance = acceptanceManifestBytes.toString("utf8");
  if (/sb_secret_|gh[pousr]_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\./.test(rawAcceptance)) {
    errors.push("production acceptance contains secret-like material");
  }
  return errors;
}

async function main() {
  const values = new Map();
  for (let index = 2; index < process.argv.length; index += 2) values.set(process.argv[index], process.argv[index + 1]);
  const releasePath = values.get("--release-manifest");
  const acceptancePath = values.get("--acceptance-manifest");
  if (!releasePath || !acceptancePath) throw new Error("--release-manifest and --acceptance-manifest are required");
  const [releaseManifestBytes, acceptanceManifestBytes] = await Promise.all([
    readFile(resolve(releasePath)),
    readFile(resolve(acceptancePath)),
  ]);
  const errors = validateProductionAcceptance({
    releaseManifest: JSON.parse(releaseManifestBytes.toString("utf8")),
    releaseManifestBytes,
    acceptanceManifest: JSON.parse(acceptanceManifestBytes.toString("utf8")),
    acceptanceManifestBytes,
    expectedTag: values.get("--expected-tag"),
    expectedSource: values.get("--expected-source"),
    expectedAcceptanceSha256: values.get("--expected-acceptance-sha256"),
  });
  if (errors.length) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Production acceptance evidence passed\n");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
