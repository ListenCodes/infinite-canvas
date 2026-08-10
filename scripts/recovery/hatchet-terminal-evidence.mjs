import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const requireFromApplication = createRequire(resolve(process.cwd(), "package.json"));
const { HatchetClient } = requireFromApplication("@hatchet-dev/typescript-sdk/v1");

export const TERMINAL_PROBE_TASK = "infinite-canvas-recovery-terminal-probe-v1";
export const RESULT_PREFIX = "RECOVERY_HATCHET_PROBE_RESULT=";

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableJson(item)]));
  }
  return value;
}

export function jsonHash(value) {
  return createHash("sha256").update(JSON.stringify(stableJson(value))).digest("hex");
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value;
}

function normalizeStatus(value) {
  return String(value ?? "").toUpperCase();
}

export async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function canonicalizeTerminalRunObservation(runId, rest, details) {
  const run = assertObject(rest?.run, "REST run");
  if (run.metadata?.id !== runId) throw new Error("REST run ID differs from the requested run");
  if (normalizeStatus(run.status) !== "COMPLETED") throw new Error("REST run is not completed");
  if (!run.finishedAt) throw new Error("REST run has no finished timestamp");
  if (!run.workflowId || !run.workflowVersionId) throw new Error("REST run is missing workflow identity");
  if (!Array.isArray(rest.tasks) || rest.tasks.length !== 1) throw new Error("Terminal probe must contain exactly one REST task");
  if (!Array.isArray(rest.shape) || rest.shape.length !== 1 || rest.shape[0]?.taskName !== TERMINAL_PROBE_TASK) {
    throw new Error("REST run shape does not identify the terminal probe task");
  }

  const restTask = assertObject(rest.tasks[0], "REST task");
  if (normalizeStatus(restTask.status) !== "COMPLETED" || !restTask.finishedAt) throw new Error("REST task is not completed");
  if (!restTask.taskExternalId) throw new Error("REST task has no external ID");

  if (details?.done !== true || normalizeStatus(details?.status) !== "COMPLETED") throw new Error("gRPC run is not completed");
  const detailTasks = Object.values(details?.taskRuns ?? {});
  if (detailTasks.length !== 1) throw new Error("Terminal probe must contain exactly one gRPC task");
  const detailTask = assertObject(detailTasks[0], "gRPC task");
  if (normalizeStatus(detailTask.status) !== "COMPLETED") throw new Error("gRPC task is not completed");
  if (detailTask.externalId !== restTask.taskExternalId) throw new Error("REST and gRPC task IDs differ");

  const input = assertObject(restTask.input, "REST task input");
  const logicalRestInput = typeof input.nonce === "string"
    ? input
    : assertObject(input.input, "REST standalone task input");
  const output = assertObject(restTask.output, "REST task output");
  const detailInput = assertObject(details.input, "gRPC run input");
  const detailOutput = assertObject(detailTask.output, "gRPC task output");
  if (jsonHash(logicalRestInput) !== jsonHash(detailInput)) throw new Error("REST and gRPC inputs differ");
  if (jsonHash(output) !== jsonHash(detailOutput)) throw new Error("REST and gRPC outputs differ");
  if (typeof logicalRestInput.nonce !== "string" || !/^[a-f0-9]{64}$/.test(logicalRestInput.nonce)) throw new Error("Terminal probe input is invalid");
  const expectedDigest = createHash("sha256").update(logicalRestInput.nonce).digest("hex");
  if (output.digest !== expectedDigest) throw new Error("Terminal probe output does not match its input");

  return {
    runId,
    taskName: TERMINAL_PROBE_TASK,
    status: "COMPLETED",
    workflowId: run.workflowId,
    workflowVersionId: run.workflowVersionId,
    taskExternalId: restTask.taskExternalId,
    finishedAt: run.finishedAt,
    inputSha256: jsonHash(input),
    outputSha256: jsonHash(output),
  };
}

export async function observeTerminalRun(client, runId, options = {}) {
  const deadlineAt = Date.now() + (options.deadlineMs ?? 60_000);
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  const pause = options.pause ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  let lastError;
  while (Date.now() < deadlineAt) {
    try {
      const remaining = Math.max(1, deadlineAt - Date.now());
      const [rest, details] = await withTimeout(
        Promise.all([client.runs.get(runId), client.runs.getDetails(runId)]),
        Math.min(requestTimeoutMs, remaining),
        "Hatchet run observation request timed out",
      );
      return canonicalizeTerminalRunObservation(runId, rest, details);
    } catch (error) {
      lastError = error;
      const remaining = deadlineAt - Date.now();
      if (remaining > 0) await pause(Math.min(1_000, remaining));
    }
  }
  throw new Error(`Terminal run did not converge: ${lastError instanceof Error ? lastError.message : "unknown error"}`);
}

export async function terminalRunInventory(client, options = {}) {
  const limit = 1_000;
  const page = await withTimeout(
    client.runs.list({ onlyTasks: true, limit, includePayloads: true }),
    options.requestTimeoutMs ?? 10_000,
    "Hatchet run inventory request timed out",
  );
  const rows = page?.rows ?? [];
  const currentPage = page?.pagination?.current_page;
  const numPages = page?.pagination?.num_pages;
  const hasPagination = currentPage !== undefined || numPages !== undefined;
  if (hasPagination && (!Number.isInteger(currentPage) || currentPage < 1 || !Number.isInteger(numPages) || numPages < 0)) {
    throw new Error("Hatchet run inventory returned invalid pagination metadata");
  }
  if ((hasPagination && numPages > currentPage) || (!hasPagination && rows.length >= limit) || rows.length > limit) {
    throw new Error("Hatchet run inventory exceeded the single-page recovery bound");
  }
  return rows.map((row) => ({
    workflowRunExternalId: row.workflowRunExternalId,
    taskExternalId: row.taskExternalId,
    workflowName: row.workflowName ?? null,
    status: normalizeStatus(row.status),
    inputSha256: jsonHash(row.input),
  })).sort((left, right) => `${left.workflowRunExternalId}:${left.taskExternalId}`.localeCompare(`${right.workflowRunExternalId}:${right.taskExternalId}`));
}

export function requireSingleProbeInventoryEntry(inventory, observation) {
  const matchingInput = inventory.filter(({ inputSha256 }) => inputSha256 === observation.inputSha256);
  if (matchingInput.length !== 1) throw new Error("Hatchet terminal probe input does not map to exactly one run");
  const [entry] = matchingInput;
  if (entry.workflowRunExternalId !== observation.runId || entry.taskExternalId !== observation.taskExternalId) {
    throw new Error("Hatchet terminal probe inventory identity differs from the observed run");
  }
}

export async function verifyTerminalRun(client, expected, options = {}) {
  const observed = await observeTerminalRun(client, expected.runId, options);
  if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error("Restored terminal run differs from the source checkpoint");
  return observed;
}

export function createClient(token) {
  return HatchetClient.init({
    token,
    host_port: process.env.HATCHET_CLIENT_HOST_PORT ?? "hatchet-lite:7077",
    api_url: process.env.HATCHET_CLIENT_API_URL ?? "http://hatchet-lite:8888",
    tls_config: { tls_strategy: "none" },
    healthcheck: { enabled: false },
  });
}

export function redactErrorMessage(error) {
  return (error instanceof Error ? error.message : "unknown error")
    .replace(/[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/authorization\s*[:=]\s*[^\s,;]+/gi, "authorization=[REDACTED]")
    .slice(0, 500);
}
