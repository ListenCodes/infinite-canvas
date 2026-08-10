import { randomBytes } from "node:crypto";
import { closeSync, createReadStream, openSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import {
  businessManifest,
  canonicalObjectManifest,
  createRecoveryS3,
  exportObjectVersions,
  fixtureProbeRunId,
  reconcileRestoredJobs,
  restoreObjectVersions,
  seedRecoveryFixtures,
  sha256,
  verifyRestoredAccess,
} from "./recovery-fixtures.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const composeFile = resolve(repository, "infra/compose/recovery/compose.yaml");

function parseArguments(values) {
  let evidenceDirectory;
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--evidence-dir") {
      evidenceDirectory = values[index + 1];
      if (!evidenceDirectory) throw new Error("--evidence-dir requires a path");
      index += 1;
    } else {
      throw new Error(`Unknown recovery drill argument: ${values[index]}`);
    }
  }
  return { evidenceDirectory };
}

async function run(command, argumentsList, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, argumentsList, {
      cwd: options.cwd ?? repository,
      env: options.env ?? process.env,
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${options.label ?? command} failed with exit code ${code}${stderr ? `\n${stderr.trim()}` : ""}`));
    });
  });
}

async function runToFile(command, argumentsList, path, options) {
  const descriptor = openSync(path, "w");
  try {
    await run(command, argumentsList, { ...options, stdio: ["ignore", descriptor, "pipe"] });
  } finally {
    closeSync(descriptor);
  }
}

async function runFromFile(command, argumentsList, path, options) {
  await new Promise((resolvePromise, reject) => {
    const input = createReadStream(path);
    const child = spawn(command, argumentsList, {
      cwd: options.cwd ?? repository,
      env: options.env,
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    input.on("error", reject);
    child.on("error", reject);
    input.pipe(child.stdin);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${options.label} failed with exit code ${code}${stderr ? `\n${stderr.trim()}` : ""}`));
    });
  });
}

function composeArguments(project, argumentsList) {
  return ["compose", "-p", project, "-f", composeFile, ...argumentsList];
}

async function compose(project, environment, argumentsList, label) {
  return run("docker", composeArguments(project, argumentsList), { env: environment, label });
}

async function cleanupComposeProject(project, environment) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await compose(project, environment, ["down", "--volumes", "--remove-orphans", "--timeout", "10"], `Clean ${project} (attempt ${attempt})`);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolvePromise) => setTimeout(resolvePromise, 500 * attempt));
    }
  }
  if (lastError) throw lastError;
  const filters = [
    ["containers", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`]],
    ["volumes", ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]],
    ["networks", ["network", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]],
  ];
  const residual = [];
  for (const [kind, args] of filters) {
    const values = (await run("docker", args, { env: environment, label: `Inspect residual ${kind} for ${project}` })).stdout.trim();
    if (values) residual.push(`${kind}: ${values.split(/\r?\n/).join(", ")}`);
  }
  if (residual.length > 0) throw new Error(`Recovery cleanup left resources for ${project}: ${residual.join("; ")}`);
}

async function publishedPort(project, environment, service, containerPort) {
  const result = await compose(
    project,
    environment,
    ["port", service, String(containerPort)],
    `Discover ${service}:${containerPort} port`,
  );
  const line = result.stdout.trim().split(/\r?\n/).at(-1) ?? "";
  const match = /(?:127\.0\.0\.1|\[::1\]):(\d+)$/.exec(line);
  if (!match?.[1]) throw new Error(`Unexpected published port for ${service}:${containerPort}`);
  return Number(match[1]);
}

async function directoryChecksums(directory) {
  const entries = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const body = await readFile(path);
        entries.push({ path: relative(directory, path).split(sep).join("/"), bytes: body.byteLength, sha256: sha256(body) });
      }
    }
  }
  await visit(directory);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function waitForUrl(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return response.text();
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : "unknown error"}`);
}

function redactAudit(report) {
  return {
    ...report,
    activeAttempts: {
      byStatus: report.activeAttempts?.byStatus ?? {},
      total: report.activeAttempts?.total ?? 0,
    },
  };
}

async function main() {
  const { evidenceDirectory: requestedEvidence } = parseArguments(process.argv.slice(2));
  const suffix = randomBytes(5).toString("hex");
  const sourceProject = `ic-recovery-source-${suffix}`;
  const targetProject = `ic-recovery-target-${suffix}`;
  let workingDirectory;
  const evidenceDirectory = resolve(requestedEvidence ?? join(tmpdir(), `infinite-canvas-recovery-evidence-${suffix}`));
  await mkdir(evidenceDirectory, { recursive: true });
  const evidenceRelativeToRepository = relative(await realpath(repository), await realpath(evidenceDirectory));
  if (
    evidenceRelativeToRepository === "" ||
    (!evidenceRelativeToRepository.startsWith(`..${sep}`) && evidenceRelativeToRepository !== "..")
  ) throw new Error("Recovery evidence directory must be outside the Git repository");
  const startedAt = new Date();
  const password = randomBytes(24).toString("hex");
  const apiPassword = randomBytes(24).toString("hex");
  const workerPassword = randomBytes(24).toString("hex");
  const auditPassword = randomBytes(24).toString("hex");
  const baseEnvironment = {
    ...process.env,
    API_IMAGE: process.env.API_IMAGE ?? "infinite-canvas-api:gate",
    WORKER_IMAGE: process.env.WORKER_IMAGE ?? "infinite-canvas-worker:gate",
    RECOVERY_POSTGRES_PASSWORD: password,
    RECOVERY_API_PASSWORD: apiPassword,
    RECOVERY_WORKER_PASSWORD: workerPassword,
    RECOVERY_AUDIT_PASSWORD: auditPassword,
  };
  const sourceEnvironment = { ...baseEnvironment };
  const targetEnvironment = { ...baseEnvironment };
  const sourcePorts = [];
  const targetPorts = [];
  const businessUrl = (ports, role = "postgres", rolePassword = password) =>
    `postgresql://${role}:${rolePassword}@127.0.0.1:${ports[0]}/infinite_canvas`;
  const hatchetUrl = (ports) => `postgresql://hatchet:${password}@127.0.0.1:${ports[1]}/hatchet`;
  const s3Endpoint = (ports) => `http://127.0.0.1:${ports[2]}`;
  const hatchetApi = (ports) => `http://127.0.0.1:${ports[3]}`;
  const hatchetHealth = (ports) => `http://127.0.0.1:${ports[4]}`;
  const probeRunId = fixtureProbeRunId;
  let cleanupError;
  let primaryError;
  let candidateImages;

  try {
    workingDirectory = await mkdtemp(join(tmpdir(), "infinite-canvas-recovery-drill-"));
    await run("docker", ["version"], { label: "Docker availability check" });
    const sourceSha = process.env.GITHUB_SHA ?? (await run("git", ["rev-parse", "HEAD"], { label: "Resolve recovery source revision" })).stdout.trim();
    const sourceDirty = Boolean((await run("git", ["status", "--porcelain"], { label: "Inspect recovery source state" })).stdout.trim());
    if (process.env.GITHUB_ACTIONS === "true" && sourceDirty) throw new Error("Release-gate recovery evidence requires a clean Git worktree");
    candidateImages = {
      api: {
        reference: baseEnvironment.API_IMAGE,
        imageId: (await run("docker", ["image", "inspect", "--format", "{{.Id}}", baseEnvironment.API_IMAGE], { label: "Inspect API recovery image" })).stdout.trim(),
      },
      worker: {
        reference: baseEnvironment.WORKER_IMAGE,
        imageId: (await run("docker", ["image", "inspect", "--format", "{{.Id}}", baseEnvironment.WORKER_IMAGE], { label: "Inspect Worker recovery image" })).stdout.trim(),
      },
    };
    await compose(sourceProject, sourceEnvironment, ["config", "--quiet"], "Source recovery Compose validation");
    await compose(targetProject, targetEnvironment, ["config", "--quiet"], "Target recovery Compose validation");
    await Promise.all([
      compose(sourceProject, sourceEnvironment, ["up", "-d", "--wait", "business-db", "hatchet-db", "moto", "hatchet-lite"], "Start source recovery stack"),
      compose(targetProject, targetEnvironment, ["up", "-d", "--wait", "business-db", "hatchet-db", "moto"], "Start empty target recovery stack"),
    ]);
    sourcePorts.push(
      await publishedPort(sourceProject, sourceEnvironment, "business-db", 5432),
      await publishedPort(sourceProject, sourceEnvironment, "hatchet-db", 5432),
      await publishedPort(sourceProject, sourceEnvironment, "moto", 5000),
      await publishedPort(sourceProject, sourceEnvironment, "hatchet-lite", 8888),
      await publishedPort(sourceProject, sourceEnvironment, "hatchet-lite", 8733),
    );
    targetPorts.push(
      await publishedPort(targetProject, targetEnvironment, "business-db", 5432),
      await publishedPort(targetProject, targetEnvironment, "hatchet-db", 5432),
      await publishedPort(targetProject, targetEnvironment, "moto", 5000),
    );
    await compose(sourceProject, sourceEnvironment, ["run", "--rm", "database-migrate"], "Migrate source business database");
    const sourceValidation = await seedRecoveryFixtures({
      businessUrl: businessUrl(sourcePorts),
      hatchetUrl: hatchetUrl(sourcePorts),
      s3Endpoint: s3Endpoint(sourcePorts),
      probeRunId,
    });
    await waitForUrl(`${hatchetHealth(sourcePorts)}/ready`);
    const sourceVersion = await waitForUrl(`${hatchetHealth(sourcePorts)}/version`);
    const sourceBusiness = await businessManifest(businessUrl(sourcePorts));
    const checkpointAt = new Date();

    const objectBackupDirectory = resolve(workingDirectory, "objects");
    const sourceStorage = createRecoveryS3(s3Endpoint(sourcePorts));
    const sourceObjects = await exportObjectVersions(sourceStorage, "infinite-canvas-recovery", objectBackupDirectory);
    sourceStorage.destroy();

    await compose(sourceProject, sourceEnvironment, ["stop", "hatchet-lite"], "Stop source Hatchet control plane");
    const sourceConfigDirectory = resolve(workingDirectory, "hatchet-config-source");
    await mkdir(sourceConfigDirectory, { recursive: true });
    await compose(sourceProject, sourceEnvironment, ["cp", "hatchet-lite:/config/.", sourceConfigDirectory], "Archive source Hatchet config");
    const sourceConfig = await directoryChecksums(sourceConfigDirectory);
    if (sourceConfig.length === 0) throw new Error("Hatchet config backup is empty");

    const businessDump = resolve(workingDirectory, "business.dump");
    const hatchetDump = resolve(workingDirectory, "hatchet.dump");
    await runToFile("docker", composeArguments(sourceProject, ["exec", "-T", "business-db", "pg_dump", "-U", "postgres", "-d", "infinite_canvas", "-Fc", "--no-owner", "--no-acl"]), businessDump, { env: sourceEnvironment, label: "Business database backup" });
    await runToFile("docker", composeArguments(sourceProject, ["exec", "-T", "hatchet-db", "pg_dump", "-U", "hatchet", "-d", "hatchet", "-Fc", "--no-owner", "--no-acl"]), hatchetDump, { env: sourceEnvironment, label: "Hatchet database backup" });
    const restoreStartedAt = new Date();

    const targetStorage = createRecoveryS3(s3Endpoint(targetPorts));
    await restoreObjectVersions(targetStorage, sourceObjects, objectBackupDirectory);
    const targetObjectDirectory = resolve(workingDirectory, "objects-restored");
    const targetObjects = await exportObjectVersions(targetStorage, "infinite-canvas-recovery", targetObjectDirectory);
    targetStorage.destroy();
    if (JSON.stringify(canonicalObjectManifest(sourceObjects)) !== JSON.stringify(canonicalObjectManifest(targetObjects))) {
      throw new Error("Restored object-version manifest differs from the source checkpoint");
    }

    await runFromFile("docker", composeArguments(targetProject, ["exec", "-T", "business-db", "pg_restore", "-U", "postgres", "-d", "infinite_canvas", "--exit-on-error", "--clean", "--if-exists", "--no-owner", "--no-acl"]), businessDump, { env: targetEnvironment, label: "Business database restore" });
    await runFromFile("docker", composeArguments(targetProject, ["exec", "-T", "hatchet-db", "pg_restore", "-U", "hatchet", "-d", "hatchet", "--exit-on-error", "--clean", "--if-exists", "--no-owner", "--no-acl"]), hatchetDump, { env: targetEnvironment, label: "Hatchet database restore" });
    await compose(targetProject, targetEnvironment, ["run", "--rm", "database-migrate"], "Validate restored business migrations");
    await compose(targetProject, targetEnvironment, ["run", "--rm", "database-provision-roles"], "Provision restored runtime roles");
    await compose(targetProject, targetEnvironment, ["create", "hatchet-lite"], "Create target Hatchet control plane");
    await compose(targetProject, targetEnvironment, ["cp", `${sourceConfigDirectory}${sep}.`, "hatchet-lite:/config/"], "Restore target Hatchet config");
    await compose(targetProject, targetEnvironment, ["up", "-d", "--wait", "hatchet-lite"], "Start restored Hatchet control plane");
    targetPorts.push(
      await publishedPort(targetProject, targetEnvironment, "hatchet-lite", 8888),
      await publishedPort(targetProject, targetEnvironment, "hatchet-lite", 8733),
    );
    await waitForUrl(`${hatchetHealth(targetPorts)}/ready`);
    await waitForUrl(`${hatchetApi(targetPorts)}/api/ready`);
    const targetVersion = await waitForUrl(`${hatchetHealth(targetPorts)}/version`);
    if (sourceVersion.trim() !== targetVersion.trim()) throw new Error("Restored Hatchet version differs from source");
    const targetConfigDirectory = resolve(workingDirectory, "hatchet-config-target");
    await mkdir(targetConfigDirectory, { recursive: true });
    await compose(targetProject, targetEnvironment, ["cp", "hatchet-lite:/config/.", targetConfigDirectory], "Read restored Hatchet config");
    const targetConfig = await directoryChecksums(targetConfigDirectory);
    if (JSON.stringify(sourceConfig) !== JSON.stringify(targetConfig)) throw new Error("Restored Hatchet config checksum differs from source");

    const auditResult = await compose(targetProject, targetEnvironment, ["run", "--rm", "recovery-audit"], "Run restored read-only audit");
    const audit = JSON.parse(auditResult.stdout.trim());
    if (!audit.pass) throw new Error("Read-only recovery audit reported a failure");
    const targetBusiness = await businessManifest(businessUrl(targetPorts));
    if (JSON.stringify(sourceBusiness) !== JSON.stringify(targetBusiness)) throw new Error("Restored business manifest differs from source");
    const access = await verifyRestoredAccess({
      adminUrl: businessUrl(targetPorts),
      apiUrl: businessUrl(targetPorts, "infinite_canvas_api_recovery_drill", apiPassword),
      recoveryUrl: businessUrl(targetPorts, "infinite_canvas_recovery_drill", auditPassword),
    });
    const reconciliation = await reconcileRestoredJobs({ businessUrl: businessUrl(targetPorts), hatchetUrl: hatchetUrl(targetPorts) });
    const completedAt = new Date();
    const evidence = {
      schemaVersion: 1,
      procedureVersion: 3,
      mode: "local_combined_restore_with_synthetic_control_plane_probe",
      candidate: {
        sourceSha,
        sourceDirty,
        images: candidateImages,
      },
      sourceCheckpointAt: checkpointAt.toISOString(),
      restoreStartedAt: restoreStartedAt.toISOString(),
      restoredAt: completedAt.toISOString(),
      observedRestoreValidationSeconds: Math.ceil((completedAt.getTime() - restoreStartedAt.getTime()) / 1000),
      drillDurationSeconds: Math.ceil((completedAt.getTime() - startedAt.getTime()) / 1000),
      releaseBoundary: {
        businessWorkersStarted: false,
        providerEgressConfigured: false,
        networkInternal: true,
      },
      sourceValidation,
      backups: {
        businessDatabaseSha256: sha256(await readFile(businessDump)),
        hatchetDatabaseSha256: sha256(await readFile(hatchetDump)),
        hatchetConfig: sourceConfig,
        objectVersions: canonicalObjectManifest(sourceObjects),
      },
      restored: {
        businessManifestSha256: sha256(Buffer.from(JSON.stringify(targetBusiness))),
        objectVersionsMatch: true,
        hatchetVersion: targetVersion.trim(),
        hatchetConfigMatch: true,
        access,
        audit: redactAudit(audit),
        reconciliation,
        realHatchetRun: null,
      },
      limitations: [
        "The control-plane run marker is a deterministic test-only row restored with the real Hatchet schema; it is not an actual Hatchet workflow run.",
        "Actual Hatchet run recovery must be recorded separately from the selected OSS backup or managed-service recovery procedure.",
        "Observed local restore-validation time is not a production RTO measurement.",
        "Local Hatchet Lite and Moto evidence does not replace managed Supabase, production object storage, Hatchet Cloud, or production RTO evidence.",
      ],
    };
    const evidencePath = resolve(evidenceDirectory, "combined-restore.json");
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    process.stdout.write(`${evidencePath}\n`);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    for (const [project, environment] of [[sourceProject, sourceEnvironment], [targetProject, targetEnvironment]]) {
      try {
        await cleanupComposeProject(project, environment);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    try {
      if (workingDirectory) {
        const resolvedWork = resolve(workingDirectory);
        const resolvedTemp = resolve(tmpdir());
        if (!resolvedWork.startsWith(`${resolvedTemp}${sep}`) || !resolvedWork.includes("infinite-canvas-recovery-drill-")) {
          throw new Error(`Refusing to remove unexpected recovery work directory: ${resolvedWork}`);
        }
        await rm(resolvedWork, { recursive: true, force: true });
      }
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) {
      if (primaryError) throw new AggregateError([primaryError, cleanupError], "Recovery drill and cleanup both failed");
      throw cleanupError;
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
