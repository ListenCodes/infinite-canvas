import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const argumentsList = process.argv.slice(2);
const envFileArguments = [];
const releaseManifestArguments = [];
let repositoryArgument;
let allowZeroDrainOwners = false;
for (let index = 0; index < argumentsList.length; index += 1) {
  const value = argumentsList[index];
  if (value === "--allow-zero-drain-owners") {
    allowZeroDrainOwners = true;
  } else if (value === "--env-file" || value === "--release-manifest") {
    const target = argumentsList[index + 1];
    if (!target) throw new Error(`${value} requires a path`);
    (value === "--env-file" ? envFileArguments : releaseManifestArguments).push(target);
    index += 1;
  } else if (!repositoryArgument) {
    repositoryArgument = value;
  }
}
const repository = resolve(repositoryArgument ?? ".");
const checkedFiles = [
  "Dockerfile",
  "docs/Dockerfile",
  "apps/api/Dockerfile",
  "apps/worker/Dockerfile",
  "infra/compose/local/compose.yaml",
  "infra/compose/cloud/compose.yaml",
  "infra/compose/cloud/drain.override.yaml",
  "infra/compose/oss/compose.yaml",
  "infra/compose/oss/drain.override.yaml",
  "infra/compose/recovery/compose.yaml",
  "infra/monitoring/compose.yaml",
  "infra/release/images.lock",
];
const errors = [];
const digestReference = /^[^\s:@]+(?:\/[^\s:@]+)*(?::[^\s@]+)?@sha256:[a-f0-9]{64}$/i;

function assertImmutableImage(value, source) {
  if (!digestReference.test(value)) errors.push(`${source}: image must use an immutable sha256 digest`);
}

const lockContent = await readFile(resolve(repository, "infra/release/images.lock"), "utf8");
const lockedImages = new Set();
for (const line of lockContent.split(/\r?\n/).filter((value) => value && !value.startsWith("#"))) {
  const separator = line.indexOf(": ");
  const value = separator >= 0 ? line.slice(separator + 2).trim() : "";
  if (!digestReference.test(value)) errors.push(`infra/release/images.lock: invalid entry ${line.split(":", 1)[0]}`);
  else lockedImages.add(value);
}

for (const relativePath of checkedFiles) {
  const content = await readFile(resolve(repository, relativePath), "utf8");
  if (/(?:image:|FROM)\s+[^\s]+:latest\b/i.test(content)) errors.push(`${relativePath}: rolling latest image is forbidden`);
  for (const match of content.matchAll(/sha256:([a-f0-9]+)/gi)) {
    if (match[1].length !== 64) errors.push(`${relativePath}: invalid sha256 digest length`);
  }
  for (const match of content.matchAll(/^\s*(?:FROM|image:)\s+([^\s#]+).*$/gim)) {
    const image = match[1];
    if (image.startsWith("${")) continue;
    if (relativePath === "infra/compose/local/compose.yaml" && /^infinite-canvas-(?:web|api|worker):local$/.test(image)) continue;
    assertImmutableImage(image, relativePath);
    if (!lockedImages.has(image)) errors.push(`${relativePath}: image is not recorded in infra/release/images.lock`);
  }
}

const webDockerfile = await readFile(resolve(repository, "Dockerfile"), "utf8");
const finalWebStage = webDockerfile.split(/^FROM\s+/im).at(-1) ?? "";
const finalWebUser = /^USER\s+([^\s#]+)/im.exec(finalWebStage)?.[1]?.toLowerCase();
if (!finalWebUser || finalWebUser === "root" || finalWebUser === "0") {
  errors.push("Dockerfile: final Web stage must declare a non-root USER");
}

for (const [relativePath, endpoint] of [
  ["apps/api/Dockerfile", "http://127.0.0.1:3001/readyz"],
  ["apps/worker/Dockerfile", "http://127.0.0.1:8733/health"],
]) {
  const dockerfile = await readFile(resolve(repository, relativePath), "utf8");
  const finalStage = dockerfile.split(/^FROM\s+/im).at(-1) ?? "";
  if (!/^HEALTHCHECK\s+/im.test(finalStage) || !finalStage.includes(endpoint)) {
    errors.push(`${relativePath}: final stage must retain the production health probe ${endpoint}`);
  }
}

const ossCompose = await readFile(resolve(repository, "infra/compose/oss/compose.yaml"), "utf8");
for (const required of [
  "http://127.0.0.1:8733/ready",
  "http://127.0.0.1/api/ready",
  "hatchet-engine: { condition: service_healthy }",
  "hatchet-dashboard: { condition: service_healthy }",
]) {
  if (!ossCompose.includes(required))
    errors.push(`infra/compose/oss/compose.yaml: missing readiness invariant ${required}`);
}

function composeService(content, service) {
  const match = new RegExp(`^  ${service}:\\r?\\n([\\s\\S]*?)(?=^  [a-z0-9-]+:|^volumes:|^networks:|(?![\\s\\S]))`, "m").exec(content);
  return match?.[1] ?? "";
}

for (const topology of ["cloud", "oss"]) {
  const basePath = `infra/compose/${topology}/compose.yaml`;
  const overridePath = `infra/compose/${topology}/drain.override.yaml`;
  const base = await readFile(resolve(repository, basePath), "utf8");
  const override = await readFile(resolve(repository, overridePath), "utf8");
  const oldBase = composeService(base, "worker");
  const oldOverride = composeService(override, "worker");
  const candidate = composeService(override, "worker-new");
  for (const [role, service] of [["old", oldOverride], ["new", candidate]]) {
    for (const required of [
      `WORKER_${role.toUpperCase()}_IMAGE`,
      `WORKER_${role.toUpperCase()}_DISPATCHER_ENABLED`,
      `WORKER_${role.toUpperCase()}_RECONCILER_ENABLED`,
      `infinite-canvas.revision-role: ${role}`,
      "http://127.0.0.1:8733/health",
    ]) {
      if (!service.includes(required)) errors.push(`${overridePath}: ${role} Worker is missing ${required}`);
    }
  }
  for (const required of ["read_only: true", 'cap_drop: ["ALL"]', 'security_opt: ["no-new-privileges:true"]', "stop_grace_period: 50m"]) {
    if (!oldBase.includes(required)) errors.push(`${basePath}: old Worker is missing ${required}`);
    if (!candidate.includes(required)) errors.push(`${overridePath}: new Worker is missing ${required}`);
  }
  if (/^\s+ports:/m.test(candidate)) errors.push(`${overridePath}: worker-new must not expose host ports`);
}

const workflowsDirectory = resolve(repository, ".github/workflows");
for (const entry of await readdir(workflowsDirectory, { withFileTypes: true })) {
  if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
  const relativePath = `.github/workflows/${entry.name}`;
  const content = await readFile(resolve(workflowsDirectory, entry.name), "utf8");
  for (const match of content.matchAll(/^\s*uses:\s*([^\s#]+).*$/gim)) {
    const reference = match[1];
    if (reference.startsWith("./")) continue;
    if (!/@[a-f0-9]{40}$/.test(reference)) {
      errors.push(`${relativePath}: external action must use a full commit SHA (${reference})`);
    }
  }
}

for (const topology of ["local", "cloud", "oss"]) {
  const relativePath = `infra/compose/${topology}/compose.yaml`;
  const content = await readFile(resolve(repository, relativePath), "utf8");
  const migration = composeService(content, "database-migrate");
  const provision = composeService(content, "database-provision-roles");
  const worker = composeService(content, "worker");
  const recoveryAudit = composeService(content, "recovery-audit");
  const workerEnvironment = topology === "cloud"
    ? (/^x-worker-environment:[^\n]*\n([\s\S]*?)(?=^services:)/m.exec(content)?.[1] ?? "") + worker
    : worker;
  if (!migration.includes("BUSINESS_DATABASE_MIGRATION_URL:") || migration.includes("BUSINESS_DATABASE_PROVISION_URL:")) {
    errors.push(`${relativePath}: database-migrate must receive only the migration-owner URL`);
  }
  for (const required of ["BUSINESS_DATABASE_PROVISION_URL:", "BUSINESS_DATABASE_OBJECT_OWNER_ROLE:"]) {
    if (!provision.includes(required)) errors.push(`${relativePath}: database-provision-roles is missing ${required.slice(0, -1)}`);
  }
  if (provision.includes("BUSINESS_DATABASE_MIGRATION_URL:")) {
    errors.push(`${relativePath}: database-provision-roles must not receive the migration-owner URL`);
  }
  if (!workerEnvironment.includes("BUSINESS_DATABASE_URL_WORKER") || workerEnvironment.includes("BUSINESS_DATABASE_URL_RECOVERY_AUDIT")) {
    errors.push(`${relativePath}: worker must receive only the Worker runtime database URL`);
  }
  if (!recoveryAudit.includes("BUSINESS_DATABASE_URL_RECOVERY_AUDIT") || recoveryAudit.includes("BUSINESS_DATABASE_URL_WORKER")) {
    errors.push(`${relativePath}: recovery-audit must receive only the read-only audit database URL`);
  }
  if (!provision.includes("BUSINESS_DATABASE_RECOVERY_AUDIT_PASSWORD:")) {
    errors.push(`${relativePath}: database-provision-roles is missing BUSINESS_DATABASE_RECOVERY_AUDIT_PASSWORD`);
  }
}

const recoveryCompose = await readFile(resolve(repository, "infra/compose/recovery/compose.yaml"), "utf8");
for (const forbidden of ["extra_hosts:", "  api:", "  worker:", "OUTBOX_DISPATCHER_ENABLED", "UNKNOWN_RECONCILER_ENABLED"]) {
  if (recoveryCompose.includes(forbidden)) errors.push(`infra/compose/recovery/compose.yaml: forbidden recovery boundary ${forbidden}`);
}
if (!/recovery:\s*\{\s*internal:\s*true\s*\}/.test(recoveryCompose)) {
  errors.push("infra/compose/recovery/compose.yaml: recovery network must be internal");
}

const serviceImageWorkflow = await readFile(resolve(repository, ".github/workflows/docker-image.yml"), "utf8");
for (const required of ["--metadata-file", "imagetools inspect", "release-images.json", "validate-deployment-config.mjs"]) {
  if (!serviceImageWorkflow.includes(required))
    errors.push(`.github/workflows/docker-image.yml: missing release manifest invariant ${required}`);
}

function parseEnvironment(content) {
  return Object.fromEntries(content.split(/\r?\n/).flatMap((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    return match ? [[match[1], match[2]]] : [];
  }));
}

function validateApplicationImages(environment, source, allowPlaceholder) {
  for (const key of ["WEB_IMAGE", "API_IMAGE", "WORKER_IMAGE"]) {
    const value = environment[key];
    if (!value) {
      errors.push(`${source}: ${key} is required`);
      continue;
    }
    if (allowPlaceholder && /@sha256:replace-me$/.test(value)) continue;
    assertImmutableImage(value, `${source}: ${key}`);
  }
}

function validateDrainEnvironment(environment, source, allowPlaceholder, allowZeroOwners = false) {
  for (const key of ["WORKER_OLD_IMAGE", "WORKER_NEW_IMAGE"]) {
    const value = environment[key];
    if (!value) errors.push(`${source}: ${key} is required`);
    else if (!(allowPlaceholder && /@sha256:replace-me$/.test(value))) assertImmutableImage(value, `${source}: ${key}`);
  }
  const ownerCounts = {};
  for (const subsystem of ["DISPATCHER", "RECONCILER"]) {
    const oldValue = environment[`WORKER_OLD_${subsystem}_ENABLED`];
    const newValue = environment[`WORKER_NEW_${subsystem}_ENABLED`];
    if (![oldValue, newValue].every((value) => value === "true" || value === "false")) {
      errors.push(`${source}: ${subsystem.toLowerCase()} owner flags must be explicit booleans`);
      continue;
    }
    ownerCounts[subsystem] = Number(oldValue === "true") + Number(newValue === "true");
  }
  if (allowZeroOwners) {
    if (ownerCounts.DISPATCHER !== 0 || ownerCounts.RECONCILER !== 0) {
      errors.push(`${source}: zero-owner handoff requires all dispatcher and reconciler flags to be false`);
    }
    if (environment.GENERATION_WRITES_ENABLED !== "false") {
      errors.push(`${source}: zero-owner handoff requires GENERATION_WRITES_ENABLED=false`);
    }
  } else {
    for (const subsystem of ["DISPATCHER", "RECONCILER"]) {
      if (ownerCounts[subsystem] !== 1) {
        errors.push(`${source}: exactly one ${subsystem.toLowerCase()} owner must be enabled`);
      }
    }
  }
}

const examples = [];
async function findExamples(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await findExamples(path);
    else if (entry.name.endsWith(".env.example")) examples.push(path);
  }
}
await findExamples(resolve(repository, "infra"));
for (const path of examples) {
  const content = await readFile(path, "utf8");
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsb_secret_[A-Za-z0-9._-]{16,}/.test(content)) {
    errors.push(`${path}: env example contains a secret-like value`);
  }
  const environment = parseEnvironment(content);
  if (/\bWORKER_(?:OLD|NEW)_IMAGE=/.test(content)) validateDrainEnvironment(environment, path, true);
  else if (/\b(?:WEB|API|WORKER)_IMAGE=/.test(content)) validateApplicationImages(environment, path, true);
}

const processImages = Object.fromEntries(["WEB_IMAGE", "API_IMAGE", "WORKER_IMAGE"].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
if (Object.keys(processImages).length > 0) validateApplicationImages(processImages, "process environment", false);
const validatedEnvironments = [];
for (const relativePath of envFileArguments) {
  const path = resolve(relativePath);
  const environment = parseEnvironment(await readFile(path, "utf8"));
  if ("WORKER_OLD_IMAGE" in environment || "WORKER_NEW_IMAGE" in environment) {
    validateDrainEnvironment(environment, path, false, allowZeroDrainOwners);
  } else {
    validateApplicationImages(environment, path, false);
    validatedEnvironments.push(environment);
  }
}

for (const relativePath of releaseManifestArguments) {
  const path = resolve(relativePath);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, "utf8"));
  } catch {
    errors.push(`${path}: release manifest must be valid JSON`);
    continue;
  }
  if (manifest?.schemaVersion !== 1) errors.push(`${path}: unsupported release manifest schemaVersion`);
  const source = manifest?.source;
  const sourceKeys = source && typeof source === "object" ? Object.keys(source).sort() : [];
  const expectedSourceKeys = ["commit", "event", "ref", "repository", "runId"];
  if (JSON.stringify(sourceKeys) !== JSON.stringify(expectedSourceKeys)) errors.push(`${path}: source must contain exactly repository, commit, ref, event, and runId`);
  if (!source || !/^[a-f0-9]{40}$/.test(source.commit ?? "")) errors.push(`${path}: source.commit must be a full Git SHA`);
  if (source?.repository !== "ListenCodes/infinite-canvas") errors.push(`${path}: unexpected source repository`);
  if (!Number.isSafeInteger(source?.runId)) errors.push(`${path}: invalid workflow run identity`);
  const expectedServices = ["api", "web", "worker"];
  const actualServices = Object.keys(manifest?.images ?? {}).sort();
  if (JSON.stringify(actualServices) !== JSON.stringify(expectedServices)) errors.push(`${path}: images must contain exactly api, web, and worker`);
  for (const service of expectedServices) {
    const image = manifest?.images?.[service];
    const repositoryName = `ghcr.io/listencodes/infinite-canvas-${service}`;
    if (!image || image.repository !== repositoryName) {
      errors.push(`${path}: invalid ${service} repository`);
      continue;
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(image.digest ?? "")) errors.push(`${path}: invalid ${service} digest`);
    if (image.reference !== `${repositoryName}@${image.digest}`) errors.push(`${path}: ${service} reference does not match its digest`);
    const platforms = Array.isArray(image.platforms) ? image.platforms : [];
    const platformNames = platforms.map((platform) => `${platform.os}/${platform.architecture}`).sort();
    if (JSON.stringify(platformNames) !== JSON.stringify(["linux/amd64", "linux/arm64"])) errors.push(`${path}: ${service} must contain exactly linux/amd64 and linux/arm64`);
    if (platforms.some((platform) => !/^sha256:[a-f0-9]{64}$/.test(platform.digest ?? ""))) errors.push(`${path}: ${service} has an invalid child digest`);
    const expectedTags = [`${repositoryName}:sha-${source?.commit ?? ""}`];
    if (manifest.releaseTag !== null) expectedTags.push(`${repositoryName}:${manifest.releaseTag}`);
    if (JSON.stringify([...(image.tags ?? [])].sort()) !== JSON.stringify(expectedTags.sort())) errors.push(`${path}: ${service} tags do not match source/release identity`);
    for (const environment of validatedEnvironments) {
      if (environment[`${service.toUpperCase()}_IMAGE`] !== image.reference) errors.push(`${path}: ${service} reference differs from release-images.env`);
    }
  }
  const tagPush = source?.event === "push" && /^refs\/tags\//.test(source?.ref ?? "");
  if (tagPush !== (typeof manifest.releaseTag === "string")) errors.push(`${path}: releaseTag must exist only for a tag push`);
  if (tagPush && source.ref !== `refs/tags/${manifest.releaseTag}`) errors.push(`${path}: releaseTag does not match source.ref`);
}

if (errors.length) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Deployment configuration policy passed\n");
}
