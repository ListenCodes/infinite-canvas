import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalObjectManifest, classifyRestoredJob } from "./recovery-fixtures.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
  assert.equal(classifyRestoredJob({ id: "job-1", status: "waiting_provider", attempt_status: "accepted", executor_run_id: "run-1", provider_task_id: "provider-1", submitted_at: new Date() }, probeById).classification, "synthetic_control_plane_probe");
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
  assert.equal(classifyRestoredJob({ id: "job-7", status: "materializing", attempt_status: "materializing", executor_run_id: "run-1", provider_task_id: null, submitted_at: new Date(), evidence_json: { mediaUrls: ["https://storage.example/result.png"] } }, probeById).classification, "synthetic_control_plane_probe");
  assert.equal(classifyRestoredJob({ id: "job-8", status: "waiting_provider", attempt_status: "accepted", executor_run_id: "run-1", provider_task_id: null, submitted_at: new Date() }, probeById).reason, "missing_provider_acceptance_evidence");
  assert.equal(classifyRestoredJob({ id: "job-9", status: "materializing", attempt_status: "materializing", executor_run_id: "run-1", provider_task_id: null, submitted_at: new Date(), evidence_json: {} }, probeById).reason, "missing_materialization_evidence");
});

test("recovery topology cannot start application executors or use an egress network", async () => {
  const compose = await readFile(resolve(repository, "infra/compose/recovery/compose.yaml"), "utf8");
  assert.match(compose, /^\s*recovery:\s*\{\s*internal:\s*true\s*\}\s*$/m);
  for (const forbidden of ["  api:", "  worker:", "extra_hosts:", "OUTBOX_DISPATCHER_ENABLED", "UNKNOWN_RECONCILER_ENABLED"]) {
    assert.doesNotMatch(compose, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const required of ["business-db:", "hatchet-db:", "hatchet-lite:", "moto:", "recovery-audit:"]) {
    assert.ok(compose.includes(required), required);
  }
});

test("drill emits only a redacted report and cleans exact temporary projects", async () => {
  const script = await readFile(resolve(repository, "scripts/recovery/run-local-drill.mjs"), "utf8");
  assert.match(script, /redactAudit/);
  assert.match(script, /down", "--volumes", "--remove-orphans/);
  assert.match(script, /infinite-canvas-recovery-drill-/);
  assert.doesNotMatch(script, /writeFile\([^\n]*(?:business\.dump|hatchet\.dump|hatchet-config)/);
  assert.doesNotMatch(script, /require-real-hatchet-run|HATCHET_RECOVERY_PROBE_TOKEN|HATCHET_RECOVERY_PROBE_RUN_ID/);
  assert.match(script, /local_combined_restore_with_synthetic_control_plane_probe/);
  assert.match(script, /publishedPort/);
  assert.doesNotMatch(script, /freePort|createServer/);
});
