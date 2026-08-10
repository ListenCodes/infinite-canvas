import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { canonicalObjectManifest, classifyRestoredJob } from "./recovery-fixtures.mjs";
import {
  TERMINAL_PROBE_TASK,
  canonicalizeTerminalRunObservation,
  jsonHash,
  observeTerminalRun,
  terminalRunInventory,
} from "./hatchet-terminal-evidence.mjs";
import {
  createTerminalRun,
} from "./hatchet-terminal-probe.mjs";
import { verifyRestoredTerminalRun } from "./hatchet-terminal-verify.mjs";
import { terminateChildren } from "./run-local-drill.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function terminalRunResponses(runId, nonce = "a".repeat(64)) {
  const output = { digest: "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb" };
  const taskExternalId = "20000000-0000-4000-8000-000000000001";
  const rest = {
    run: {
      metadata: { id: runId },
      status: "COMPLETED",
      finishedAt: "2026-08-10T12:00:00.000Z",
      workflowId: "20000000-0000-4000-8000-000000000002",
      workflowVersionId: "20000000-0000-4000-8000-000000000003",
    },
    shape: [{ taskName: TERMINAL_PROBE_TASK }],
    tasks: [{ status: "COMPLETED", finishedAt: "2026-08-10T12:00:00.000Z", taskExternalId, input: { input: { nonce } }, output }],
  };
  const details = {
    done: true,
    status: "COMPLETED",
    input: { nonce },
    taskRuns: { probe: { status: "COMPLETED", externalId: taskExternalId, output } },
  };
  return { rest, details };
}

test("object reconciliation compares content history without provider version ids", () => {
  const canonical = canonicalObjectManifest({
    keys: [
      {
        key: "asset.png",
        history: [
          { kind: "version", bodyFile: "current.bin", sourceVersionId: "source-a", bytes: 2, sha256: "a".repeat(64), contentType: "image/png", metadata: { fixture: "current" } },
          { kind: "delete", sourceVersionId: "source-b" },
        ],
      },
    ],
  });
  assert.deepEqual(canonical, [
    {
      key: "asset.png",
      history: [
        { kind: "version", bytes: 2, sha256: "a".repeat(64), contentType: "image/png", metadata: { fixture: "current" } },
        { kind: "delete" },
      ],
    },
  ]);
});

test("recovery drill validates conditional S3 writes through the real SDK path", async () => {
  const fixtures = await readFile(resolve(repository, "scripts/recovery/recovery-fixtures.mjs"), "utf8");
  const drill = await readFile(resolve(repository, "scripts/recovery/run-local-drill.mjs"), "utf8");
  assert.match(fixtures, /IfNoneMatch: "\*"/);
  assert.match(fixtures, /conflictStatus !== 412/);
  assert.match(fixtures, /new HeadObjectCommand/);
  assert.match(drill, /const sourceValidation = await seedRecoveryFixtures/);
  assert.match(drill, /sourceValidation,/);
  assert.match(drill, /process\.env\.RELEASE_MANIFEST_PATH/);
  assert.match(drill, /Recovery images do not match the authoritative release manifest/);
  assert.match(drill, /releaseManifest: releaseManifest \?\? null/);
});

test("restored job reconciliation requires compatible business and control-plane state", () => {
  const probeById = new Map([["run-1", { status: "running", workflow_name: "media-generation-v1" }]]);
  assert.equal(classifyRestoredJob({ id: "job-1", status: "waiting_provider", attempt_status: "accepted", executor_run_id: "run-1", provider_task_id: "provider-1", submitted_at: new Date() }, probeById).classification, "control_plane_run");
  assert.equal(classifyRestoredJob({ id: "job-1", status: "waiting_provider", attempt_status: "created", executor_run_id: "run-1" }, probeById).reason, "job_attempt_state_mismatch");
  assert.equal(classifyRestoredJob({ id: "job-1", status: "waiting_provider", attempt_status: "accepted", executor_run_id: null, provider_task_id: "provider-1", submitted_at: new Date() }, probeById).reason, "missing_executor_run");
  assert.equal(classifyRestoredJob({ id: "job-1", status: "waiting_provider", attempt_status: "accepted", executor_run_id: "run-1", provider_task_id: "provider-1", submitted_at: new Date() }, new Map([["run-1", { status: "failed", workflow_name: "media-generation-v1" }]])).reason, "control_plane_state_mismatch");
  assert.equal(classifyRestoredJob({ id: "job-1", status: "waiting_provider", attempt_status: "accepted", executor_run_id: "run-1", provider_task_id: "provider-1", submitted_at: new Date() }, new Map([["run-1", { status: "running", workflow_name: "wrong-workflow" }]])).reason, "control_plane_state_mismatch");
  assert.equal(classifyRestoredJob({ id: "job-2", status: "failed", attempt_status: "accepted", executor_run_id: "run-1" }, probeById).reason, "terminal_attempt_mismatch");
  assert.equal(classifyRestoredJob({ id: "job-3", status: "queued", attempt_status: "created", executor_run_id: null, provider_task_id: null, submitted_at: null }, probeById).classification, "redispatchable_no_provider_submission");
  assert.equal(classifyRestoredJob({ id: "job-4", status: "dispatching", attempt_status: "claimed", executor_run_id: null, provider_task_id: null, submitted_at: null }, probeById).classification, "redispatchable_no_provider_submission");
  assert.equal(classifyRestoredJob({ id: "job-5", status: "running", attempt_status: "submitting", executor_run_id: "run-1", provider_task_id: null, submitted_at: new Date() }, probeById).classification, "provider_acceptance_unknown");
  assert.equal(classifyRestoredJob({ id: "job-5a", status: "running", attempt_status: "submitting", executor_run_id: null, provider_task_id: null, submitted_at: new Date() }, probeById).reason, "missing_executor_run");
  assert.equal(classifyRestoredJob({ id: "job-5b", status: "running", attempt_status: "submitting", executor_run_id: "missing-run", provider_task_id: null, submitted_at: new Date() }, probeById).reason, "missing_control_plane_run");
  assert.equal(classifyRestoredJob({ id: "job-5c", status: "dispatching", attempt_status: "claimed", executor_run_id: "run-1", provider_task_id: "provider-1", submitted_at: new Date() }, probeById).reason, "unexpected_provider_submission_evidence");
  assert.equal(classifyRestoredJob({ id: "job-5d", status: "queued", attempt_status: "created", executor_run_id: "run-1", provider_task_id: null, submitted_at: new Date() }, probeById).reason, "unexpected_provider_submission_evidence");
  assert.equal(classifyRestoredJob({ id: "job-6", status: "outcome_unknown", attempt_status: "outcome_unknown", executor_run_id: null, provider_task_id: "provider-1", submitted_at: new Date() }, probeById).reason, "missing_executor_run");
  assert.equal(classifyRestoredJob({ id: "job-7", status: "materializing", attempt_status: "materializing", executor_run_id: "run-1", provider_task_id: null, submitted_at: new Date(), evidence_json: { mediaUrls: ["https://storage.example/result.png"] } }, probeById).classification, "control_plane_run");
  assert.equal(classifyRestoredJob({ id: "job-8", status: "waiting_provider", attempt_status: "accepted", executor_run_id: "run-1", provider_task_id: null, submitted_at: new Date() }, probeById).reason, "missing_provider_acceptance_evidence");
  assert.equal(classifyRestoredJob({ id: "job-9", status: "materializing", attempt_status: "materializing", executor_run_id: "run-1", provider_task_id: null, submitted_at: new Date(), evidence_json: {} }, probeById).reason, "missing_materialization_evidence");
});

test("terminal run evidence requires matching completed REST and gRPC observations", () => {
  const runId = "20000000-0000-4000-8000-000000000004";
  const { rest, details } = terminalRunResponses(runId);
  const observation = canonicalizeTerminalRunObservation(runId, rest, details);
  assert.equal(observation.runId, runId);
  assert.equal(observation.taskName, TERMINAL_PROBE_TASK);
  assert.equal(observation.status, "COMPLETED");
  assert.equal("nonce" in observation, false);
  assert.equal(observation.inputSha256, jsonHash(rest.tasks[0].input));

  assert.throws(
    () => canonicalizeTerminalRunObservation(
      runId,
      rest,
      { ...details, input: { nonce: "b".repeat(64) } },
    ),
    /inputs differ/,
  );
  assert.throws(
    () => canonicalizeTerminalRunObservation(
      runId,
      { ...rest, tasks: [{ ...rest.tasks[0], input: { input: [] } }] },
      details,
    ),
    /REST standalone task input is not an object/,
  );
  const flatRest = { ...rest, tasks: [{ ...rest.tasks[0], input: details.input }] };
  assert.equal(
    canonicalizeTerminalRunObservation(runId, flatRest, details).inputSha256,
    jsonHash(details.input),
  );

  assert.throws(
    () => canonicalizeTerminalRunObservation(runId, { ...rest, run: { ...rest.run, status: "RUNNING" } }, details),
    /not completed/,
  );
  assert.throws(
    () => canonicalizeTerminalRunObservation(runId, rest, { ...details, done: false }),
    /not completed/,
  );
  assert.throws(
    () => canonicalizeTerminalRunObservation(runId, { ...rest, tasks: [] }, details),
    /exactly one REST task/,
  );
});

test("terminal run inventory uses total pages instead of Hatchet's unconditional next page", async () => {
  const row = {
    workflowRunExternalId: "20000000-0000-4000-8000-000000000010",
    taskExternalId: "20000000-0000-4000-8000-000000000011",
    workflowName: TERMINAL_PROBE_TASK,
    status: "COMPLETED",
    input: { input: { nonce: "a".repeat(64) } },
  };
  const client = {
    runs: {
      list: async () => ({
        rows: [row],
        pagination: { current_page: 1, next_page: 2, num_pages: 1 },
      }),
    },
  };
  assert.equal((await terminalRunInventory(client)).length, 1);

  client.runs.list = async () => ({
    rows: [row],
    pagination: { current_page: 1, next_page: 2, num_pages: 2 },
  });
  await assert.rejects(terminalRunInventory(client), /exceeded the single-page recovery bound/);

  client.runs.list = async () => ({
    rows: [row],
    pagination: { current_page: 1, next_page: 2 },
  });
  await assert.rejects(terminalRunInventory(client), /invalid pagination metadata/);
});

test("source probe creates one run while restored verification is query-only", async () => {
  const runId = "20000000-0000-4000-8000-000000000004";
  const nonce = "a".repeat(64);
  const { rest, details } = terminalRunResponses(runId, nonce);
  const calls = [];
  let taskOptions;
  let stopRunning;
  const running = new Promise((resolvePromise) => { stopRunning = resolvePromise; });
  const reference = { getWorkflowRunId: async () => runId, output: Promise.resolve(rest.tasks[0].output) };
  const task = {
    async runNoWait(input) {
      calls.push(["runNoWait", input]);
      return reference;
    },
  };
  const client = {
    task(options) { taskOptions = options; calls.push(["task", options.name]); return task; },
    async worker(_name, options) {
      calls.push(["worker", options.workflows.length]);
      return {
        start() { calls.push(["start"]); return running; },
        async waitUntilReady() { calls.push(["ready"]); },
        async stop() { calls.push(["stop"]); stopRunning(); },
      };
    },
    runs: {
      async get(id) { calls.push(["get", id]); return rest; },
      async getDetails(id) { calls.push(["getDetails", id]); return details; },
      async list() {
        calls.push(["list"]);
        return {
          pagination: {},
          rows: [{
            workflowRunExternalId: runId,
            taskExternalId: rest.tasks[0].taskExternalId,
            workflowName: TERMINAL_PROBE_TASK,
            status: "COMPLETED",
            input: rest.tasks[0].input,
          }],
        };
      },
    },
  };
  const source = await createTerminalRun(client, nonce);
  assert.equal(source.runId, runId);
  assert.equal(calls.filter(([name]) => name === "runNoWait").length, 1);
  assert.equal(calls.filter(([name]) => name === "stop").length, 1);
  assert.equal(reference.defaultSignal.aborted, true);
  assert.deepEqual(taskOptions.idempotency, { expression: "input.nonce", strategy: "ttl", ttlMs: 3_600_000 });

  const verifyCalls = [];
  const queryOnly = {
    runs: {
      async get(id) { verifyCalls.push(["get", id]); return rest; },
      async getDetails(id) { verifyCalls.push(["getDetails", id]); return details; },
      async list() {
        verifyCalls.push(["list"]);
        return {
          pagination: {},
          rows: [{
            workflowRunExternalId: runId,
            taskExternalId: rest.tasks[0].taskExternalId,
            workflowName: TERMINAL_PROBE_TASK,
            status: "COMPLETED",
            input: rest.tasks[0].input,
          }],
        };
      },
    },
  };
  assert.deepEqual(await verifyRestoredTerminalRun(queryOnly, source), source);
  assert.deepEqual(verifyCalls.map(([name]) => name).sort(), ["get", "getDetails", "list", "list"]);

  let inventoryRead = 0;
  await assert.rejects(
    verifyRestoredTerminalRun({
      runs: {
        get: async () => rest,
        getDetails: async () => details,
        list: async () => {
          inventoryRead += 1;
          return {
            pagination: {},
            rows: inventoryRead === 1 ? [] : [{
              workflowRunExternalId: runId,
              taskExternalId: rest.tasks[0].taskExternalId,
              status: "COMPLETED",
              input: rest.tasks[0].input,
            }],
          };
        },
      },
    }, source),
    /changed the Hatchet run inventory/,
  );
});

test("source probe converges an idempotency collision and observes exactly one run", async () => {
  const runId = "20000000-0000-4000-8000-000000000004";
  const nonce = "a".repeat(64);
  const { rest, details } = terminalRunResponses(runId, nonce);
  let stopRunning;
  const running = new Promise((resolvePromise) => { stopRunning = resolvePromise; });
  const collision = Object.assign(new Error("collision"), { name: "IdempotencyCollisionError", existingRunExternalId: runId });
  const task = { async runNoWait() { throw collision; } };
  const client = {
    task: () => task,
    async worker() {
      return {
        start: () => running,
        waitUntilReady: async () => {},
        stop: async () => { stopRunning(); },
      };
    },
    runs: {
      get: async () => rest,
      getDetails: async () => details,
      list: async () => ({
        pagination: {},
        rows: [{ workflowRunExternalId: runId, taskExternalId: rest.tasks[0].taskExternalId, status: "COMPLETED", input: rest.tasks[0].input }],
      }),
    },
  };
  assert.equal((await createTerminalRun(client, nonce)).runId, runId);
});

test("probe observation times out and worker startup rejection is handled", async () => {
  const never = new Promise(() => {});
  await assert.rejects(
    observeTerminalRun({ runs: { get: () => never, getDetails: () => never } }, "run-timeout", {
      deadlineMs: 15,
      requestTimeoutMs: 5,
      pause: async () => {},
    }),
    /timed out/,
  );

  const terminalButInvalid = terminalRunResponses(
    "20000000-0000-4000-8000-000000000004",
  );
  terminalButInvalid.rest.shape = [];
  await assert.rejects(
    observeTerminalRun(
      {
        runs: {
          get: async () => terminalButInvalid.rest,
          getDetails: async () => terminalButInvalid.details,
        },
      },
      "20000000-0000-4000-8000-000000000004",
      { deadlineMs: 15, pause: async () => {} },
    ),
    /Terminal run did not converge: REST run shape does not identify the terminal probe task/,
  );

  let stopped = 0;
  const client = {
    task: () => ({ runNoWait: async () => assert.fail("runNoWait must not execute") }),
    worker: async () => ({
      start: () => Promise.reject(new Error("worker startup failed")),
      waitUntilReady: () => never,
      stop: async () => { stopped += 1; },
    }),
  };
  await assert.rejects(createTerminalRun(client), /worker startup failed/);
  assert.equal(stopped, 1);
});

test("source probe bounds output and worker cleanup waits", async () => {
  const runId = "20000000-0000-4000-8000-000000000004";
  const nonce = "a".repeat(64);
  const never = new Promise(() => {});
  let stopRunning;
  const running = new Promise((resolvePromise) => { stopRunning = resolvePromise; });
  const outputTimeoutClient = {
    task: () => ({
      runNoWait: async () => ({ getWorkflowRunId: async () => runId, output: never }),
    }),
    worker: async () => ({
      start: () => running,
      waitUntilReady: async () => {},
      stop: async () => { stopRunning(); },
    }),
  };
  await assert.rejects(
    createTerminalRun(outputTimeoutClient, nonce, { deadlineMs: 15, cleanupTimeoutMs: 5 }),
    /output timed out/,
  );

  const { rest, details } = terminalRunResponses(runId, nonce);
  const cleanupTimeoutClient = {
    task: () => ({
      runNoWait: async () => ({ getWorkflowRunId: async () => runId, output: Promise.resolve(rest.tasks[0].output) }),
    }),
    worker: async () => ({
      start: () => never,
      waitUntilReady: async () => {},
      stop: async () => { throw new Error("stop failed"); },
    }),
    runs: {
      get: async () => rest,
      getDetails: async () => details,
      list: async () => ({
        pagination: {},
        rows: [{ workflowRunExternalId: runId, taskExternalId: rest.tasks[0].taskExternalId, status: "COMPLETED", input: rest.tasks[0].input }],
      }),
    },
  };
  await assert.rejects(
    createTerminalRun(cleanupTimeoutClient, nonce, { deadlineMs: 100, cleanupTimeoutMs: 5 }),
    /worker cleanup failed/,
  );
});

test("termination escalates a stuck child after the grace period", () => {
  const signals = [];
  const child = { kill: (signal) => { signals.push(signal); } };
  const children = new Set([child]);
  let escalate;
  const timer = terminateChildren(children, 1, (callback) => {
    escalate = callback;
    return { unref() {} };
  });
  assert.ok(timer);
  escalate();
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);

  const cleanupSignals = [];
  const cleanup = { kill: (signal) => { cleanupSignals.push(signal); } };
  children.delete(child);
  children.add(cleanup);
  escalate();
  assert.deepEqual(cleanupSignals, []);
});

test("recovery topology isolates the Hatchet observer from application data and egress networks", async () => {
  const compose = await readFile(resolve(repository, "infra/compose/recovery/compose.yaml"), "utf8");
  const parsed = parse(compose);
  for (const network of ["recovery-data", "hatchet-control", "hatchet-api"]) {
    assert.equal(parsed.networks[network].internal, true);
  }
  for (const forbidden of ["  api:", "  worker:", "extra_hosts:", "OUTBOX_DISPATCHER_ENABLED", "UNKNOWN_RECONCILER_ENABLED", "PROVIDER_"]) {
    assert.doesNotMatch(compose, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const required of ["business-db:", "hatchet-db:", "hatchet-lite:", "moto:", "recovery-audit:", "hatchet-terminal-observer:"]) {
    assert.ok(compose.includes(required), required);
  }
  const dynamicLoopbackPort = (target) => ({ target, published: "49152-65535", host_ip: "127.0.0.1", protocol: "tcp" });
  assert.deepEqual(parsed.services["business-db"].ports, [dynamicLoopbackPort(5432)]);
  assert.deepEqual(parsed.services["hatchet-db"].ports, [dynamicLoopbackPort(5432)]);
  assert.deepEqual(parsed.services.moto.ports, [dynamicLoopbackPort(5000)]);
  assert.deepEqual(parsed.services["hatchet-lite"].ports, [
    dynamicLoopbackPort(8888),
    dynamicLoopbackPort(8733),
  ]);
  assert.match(compose, /HATCHET_CLIENT_TOKEN_FILE: \/run\/secrets\/hatchet-client-token/);
  assert.match(compose, /source: recovery-hatchet-client-token/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /RECOVERY_PROBE_ENTRY_PATH/);
  assert.match(compose, /RECOVERY_PROBE_EVIDENCE_PATH/);
  assert.deepEqual(Object.keys(parsed.services["hatchet-terminal-observer"].environment).sort(), [
    "HATCHET_CLIENT_API_URL",
    "HATCHET_CLIENT_HOST_PORT",
    "HATCHET_CLIENT_TOKEN_FILE",
    "RECOVERY_PROBE_STATE_PATH",
  ]);
  const observerNetworks = new Set(parsed.services["hatchet-terminal-observer"].networks);
  assert.deepEqual([...observerNetworks], ["hatchet-api"]);
  for (const service of ["business-db", "moto", "hatchet-db"]) {
    assert.equal(parsed.services[service].networks.some((network) => observerNetworks.has(network)), false, service);
  }
  const verifier = await readFile(resolve(repository, "scripts/recovery/hatchet-terminal-verify.mjs"), "utf8");
  for (const forbidden of [".task(", ".worker(", "runNoWait"]) assert.doesNotMatch(verifier, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("drill emits only a redacted report and cleans exact temporary projects", async () => {
  const script = await readFile(resolve(repository, "scripts/recovery/run-local-drill.mjs"), "utf8");
  assert.match(script, /redactAudit/);
  assert.match(script, /down", "--volumes", "--remove-orphans/);
  assert.match(script, /infinite-canvas-recovery-drill-/);
  assert.doesNotMatch(script, /writeFile\([^\n]*(?:business\.dump|hatchet\.dump|hatchet-config)/);
  assert.doesNotMatch(script, /require-real-hatchet-run|HATCHET_RECOVERY_PROBE_TOKEN|HATCHET_RECOVERY_PROBE_RUN_ID|recovery_drill_probe_runs/);
  assert.match(script, /local_combined_restore_with_real_terminal_hatchet_run/);
  assert.match(script, /realHatchetRun: targetHatchetRun/);
  assert.match(script, /chmod\(path, 0o644\)/);
  assert.match(script, /if \(probeTokenPath\) await writeContainerReadableSecret\(probeTokenPath, ""\)/);
  assert.match(script, /process\.on\(signal, handler\)/);
  assert.match(script, /publishedPort/);
  assert.doesNotMatch(script, /freePort|createServer/);
  const probe = await readFile(resolve(repository, "scripts/recovery/hatchet-terminal-probe.mjs"), "utf8");
  assert.match(probe, /reference\.defaultSignal = listenerAbort\.signal/);
  assert.match(probe, /process\.exit\(1\)/);
});
