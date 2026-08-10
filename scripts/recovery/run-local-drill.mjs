import { randomBytes } from "node:crypto";
import { closeSync, createReadStream, openSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import {
  businessManifest,
  canonicalObjectManifest,
  createRecoveryS3,
  exportObjectVersions,
  fixtureIds,
  reconcileRestoredJobs,
  restoreObjectVersions,
  seedRecoveryFixtures,
  sha256,
  verifyRestoredAccess,
} from "./recovery-fixtures.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const composeFile = resolve(repository, "infra/compose/recovery/compose.yaml");
const probeScript = resolve(repository, "scripts/recovery/hatchet-terminal-probe.mjs");
const verifierScript = resolve(repository, "scripts/recovery/hatchet-terminal-verify.mjs");
const probeEvidenceScript = resolve(repository, "scripts/recovery/hatchet-terminal-evidence.mjs");
const probeResultPrefix = "RECOVERY_HATCHET_PROBE_RESULT=";
const activeChildren = new Set();
let terminationError;
const terminationTimers = new Set();

function throwIfTerminated() {
  if (terminationError) throw terminationError;
}

function trackChild(child) {
  activeChildren.add(child);
  child.once("close", () => activeChildren.delete(child));
  child.once("error", () => activeChildren.delete(child));
  return child;
}

export function terminateChildren(children, graceMs = 5_000, schedule = setTimeout) {
  const targets = [...children];
  for (const child of targets) child.kill("SIGTERM");
  const timer = schedule(() => {
    for (const child of targets) {
      if (children.has(child)) child.kill("SIGKILL");
    }
  }, graceMs);
  timer.unref?.();
  return timer;
}

async function writeContainerReadableSecret(path, value) {
  await writeFile(path, value, { mode: 0o644 });
  await chmod(path, 0o644);
}

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
  if (!options.allowDuringTermination) throwIfTerminated();
  return new Promise((resolvePromise, reject) => {
    const child = trackChild(spawn(command, argumentsList, {
      cwd: options.cwd ?? repository,
      env: options.env ?? process.env,
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }));
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (terminationError && !options.allowDuringTermination) reject(terminationError);
      else if (code === 0) resolvePromise({ stdout, stderr });
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
  throwIfTerminated();
  await new Promise((resolvePromise, reject) => {
    const input = createReadStream(path);
    const child = trackChild(spawn(command, argumentsList, {
      cwd: options.cwd ?? repository,
      env: options.env,
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    }));
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    input.on("error", reject);
    child.on("error", reject);
    input.pipe(child.stdin);
    child.on("close", (code) => {
      if (terminationError) reject(terminationError);
      else if (code === 0) resolvePromise();
      else reject(new Error(`${options.label} failed with exit code ${code}${stderr ? `\n${stderr.trim()}` : ""}`));
    });
  });
}

function composeArguments(project, argumentsList) {
  return ["compose", "-p", project, "-f", composeFile, ...argumentsList];
}

async function compose(project, environment, argumentsList, label, options = {}) {
  return run("docker", composeArguments(project, argumentsList), { env: environment, label, ...options });
}

async function cleanupComposeProject(project, environment) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await compose(project, environment, ["down", "--volumes", "--remove-orphans", "--timeout", "10"], `Clean ${project} (attempt ${attempt})`, { allowDuringTermination: true });
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
    const values = (await run("docker", args, { env: environment, label: `Inspect residual ${kind} for ${project}`, allowDuringTermination: true })).stdout.trim();
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
    throwIfTerminated();
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

function extractHatchetToken(stdout) {
  const candidates = stdout.match(/[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g) ?? [];
  if (candidates.length !== 1) throw new Error("Hatchet token command did not return exactly one token");
  return candidates[0];
}

function parseProbeResult(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith(probeResultPrefix));
  if (lines.length !== 1) throw new Error("Hatchet recovery probe did not return exactly one redacted result");
  return JSON.parse(lines[0].slice(probeResultPrefix.length));
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
  let cleanupError;
  let primaryError;
  let candidateImages;
  let releaseManifest;
  let probeTokenPath;
  const handleTermination = (signal) => {
    terminationError ??= new Error(`Recovery drill interrupted by ${signal}`);
    const timer = terminateChildren(activeChildren);
    terminationTimers.add(timer);
  };
  const signalHandlers = new Map([
    ["SIGINT", () => handleTermination("SIGINT")],
    ["SIGTERM", () => handleTermination("SIGTERM")],
  ]);
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);

  try {
    workingDirectory = await mkdtemp(join(tmpdir(), "infinite-canvas-recovery-drill-"));
    probeTokenPath = resolve(workingDirectory, "hatchet-client-token");
    const probeStateDirectory = resolve(workingDirectory, "probe-state");
    const probeStatePath = resolve(probeStateDirectory, "terminal-run.json");
    await mkdir(probeStateDirectory, { recursive: true, mode: 0o755 });
    // The private 0700 parent prevents host access; 0644 lets the non-root image read the bind-mounted file.
    await writeContainerReadableSecret(probeTokenPath, "");
    await writeFile(probeStatePath, "{}\n", { mode: 0o644 });
    for (const environment of [sourceEnvironment, targetEnvironment]) {
      Object.assign(environment, {
        RECOVERY_HATCHET_TOKEN_FILE: probeTokenPath,
        RECOVERY_PROBE_EVIDENCE_PATH: probeEvidenceScript,
        RECOVERY_PROBE_STATE_DIRECTORY: probeStateDirectory,
      });
    }
    sourceEnvironment.RECOVERY_PROBE_ENTRY_PATH = probeScript;
    targetEnvironment.RECOVERY_PROBE_ENTRY_PATH = verifierScript;
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
    if (process.env.RELEASE_MANIFEST_PATH) {
      const manifestBytes = await readFile(resolve(process.env.RELEASE_MANIFEST_PATH));
      const manifest = JSON.parse(manifestBytes.toString("utf8"));
      if (
        manifest?.source?.commit !== sourceSha ||
        manifest?.images?.api?.reference !== baseEnvironment.API_IMAGE ||
        manifest?.images?.worker?.reference !== baseEnvironment.WORKER_IMAGE ||
        typeof manifest?.images?.web?.reference !== "string"
      ) throw new Error("Recovery images do not match the authoritative release manifest");
      releaseManifest = {
        sha256: sha256(manifestBytes),
        images: {
          web: manifest.images.web.reference,
          api: manifest.images.api.reference,
          worker: manifest.images.worker.reference,
        },
      };
    }
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
    await waitForUrl(`${hatchetHealth(sourcePorts)}/ready`);
    await waitForUrl(`${hatchetApi(sourcePorts)}/api/ready`);
    const sourceVersion = await waitForUrl(`${hatchetHealth(sourcePorts)}/version`);
    const tokenOutput = await compose(
      sourceProject,
      sourceEnvironment,
      ["exec", "-T", "hatchet-lite", "./hatchet-admin", "token", "create", "--config", "/config", "--name", `recovery-drill-${suffix}`, "--expiresIn", "1h"],
      "Mint source Hatchet recovery token",
    );
    await writeContainerReadableSecret(probeTokenPath, extractHatchetToken(tokenOutput.stdout));
    const sourceProbeResult = await compose(
      sourceProject,
      sourceEnvironment,
      ["run", "--rm", "hatchet-terminal-observer"],
      "Create source terminal Hatchet run",
    );
    const sourceHatchetRun = parseProbeResult(sourceProbeResult.stdout);
    await writeFile(probeStatePath, `${JSON.stringify(sourceHatchetRun)}\n`, { mode: 0o644 });
    const sourceValidation = await seedRecoveryFixtures({
      businessUrl: businessUrl(sourcePorts),
      s3Endpoint: s3Endpoint(sourcePorts),
      terminalRunId: sourceHatchetRun.runId,
    });
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
    const targetProbeResult = await compose(
      targetProject,
      targetEnvironment,
      ["run", "--rm", "hatchet-terminal-observer"],
      "Verify restored terminal Hatchet run",
    );
    const targetHatchetRun = parseProbeResult(targetProbeResult.stdout);
    if (JSON.stringify(sourceHatchetRun) !== JSON.stringify(targetHatchetRun)) throw new Error("Restored Hatchet run evidence differs from source");
    await writeContainerReadableSecret(probeTokenPath, "");

    const auditResult = await compose(targetProject, targetEnvironment, ["run", "--rm", "recovery-audit"], "Run restored read-only audit");
    const audit = JSON.parse(auditResult.stdout.trim());
    if (!audit.pass) throw new Error("Read-only recovery audit reported a failure");
    const targetBusiness = await businessManifest(businessUrl(targetPorts));
    if (JSON.stringify(sourceBusiness) !== JSON.stringify(targetBusiness)) throw new Error("Restored business manifest differs from source");
    const terminalAttempt = targetBusiness.jobs.find(({ attempt_id: attemptId }) => attemptId === fixtureIds.succeededAttempt);
    if (terminalAttempt?.executor_run_id !== targetHatchetRun.runId) throw new Error("Restored business attempt is not bound to the terminal Hatchet run");
    const access = await verifyRestoredAccess({
      adminUrl: businessUrl(targetPorts),
      apiUrl: businessUrl(targetPorts, "infinite_canvas_api_recovery_drill", apiPassword),
      recoveryUrl: businessUrl(targetPorts, "infinite_canvas_recovery_drill", auditPassword),
    });
    const reconciliation = await reconcileRestoredJobs({
      businessUrl: businessUrl(targetPorts),
      hatchetUrl: hatchetUrl(targetPorts),
      controlPlaneRuns: [targetHatchetRun],
    });
    const completedAt = new Date();
    const evidence = {
      schemaVersion: 1,
      procedureVersion: 5,
      mode: "local_combined_restore_with_real_terminal_hatchet_run",
      candidate: {
        sourceSha,
        sourceDirty,
        images: candidateImages,
        releaseManifest: releaseManifest ?? null,
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
        realHatchetRun: targetHatchetRun,
      },
      limitations: [
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
    try {
      if (probeTokenPath) await writeContainerReadableSecret(probeTokenPath, "");
    } catch (error) {
      cleanupError ??= error;
    }
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
    for (const timer of terminationTimers) clearTimeout(timer);
    terminationTimers.clear();
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    if (cleanupError) {
      if (primaryError) throw new AggregateError([primaryError, cleanupError], "Recovery drill and cleanup both failed");
      throw cleanupError;
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
