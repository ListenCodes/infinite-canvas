import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const validator = resolve(repository, "scripts/validate-deployment-config.mjs");
const commit = "1".repeat(40);
const digest = `sha256:${"a".repeat(64)}`;
const childDigests = [
  `sha256:${"b".repeat(64)}`,
  `sha256:${"c".repeat(64)}`,
];

function releaseManifest() {
  return {
    schemaVersion: 1,
    source: {
      repository: "ListenCodes/infinite-canvas",
      commit,
      ref: "refs/heads/main",
      event: "workflow_dispatch",
      runId: 1,
    },
    releaseTag: null,
    images: Object.fromEntries(
      ["web", "api", "worker"].map((service) => {
        const image = `ghcr.io/listencodes/infinite-canvas-${service}`;
        return [
          service,
          {
            repository: image,
            digest,
            reference: `${image}@${digest}`,
            tags: [`${image}:sha-${commit}`],
            platforms: [
              { os: "linux", architecture: "amd64", digest: childDigests[0] },
              { os: "linux", architecture: "arm64", digest: childDigests[1] },
            ],
          },
        ];
      }),
    ),
  };
}

async function validate(manifest, mutateEnvironment = (value) => value) {
  const directory = await mkdtemp(join(tmpdir(), "infinite-canvas-release-manifest-"));
  try {
    const manifestPath = join(directory, "release-images.json");
    const environmentPath = join(directory, "release-images.env");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    const environment = ["web", "api", "worker"]
      .filter((service) => manifest.images?.[service]?.reference)
      .map((service) => `${service.toUpperCase()}_IMAGE=${manifest.images[service].reference}`)
      .join("\n");
    await writeFile(environmentPath, mutateEnvironment(environment), "utf8");
    return spawnSync(
      process.execPath,
      [validator, repository, "--release-manifest", manifestPath, "--env-file", environmentPath],
      { encoding: "utf8" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function validateDrainEnvironment(lines, allowZeroOwners = false) {
  const directory = await mkdtemp(join(tmpdir(), "infinite-canvas-drain-environment-"));
  try {
    const environmentPath = join(directory, "drain.env");
    await writeFile(environmentPath, lines.join("\n"), "utf8");
    return spawnSync(
      process.execPath,
      [validator, repository, ...(allowZeroOwners ? ["--allow-zero-drain-owners"] : []), "--env-file", environmentPath],
      { encoding: "utf8" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("release manifest binds three multi-architecture images to the source commit", async () => {
  const result = await validate(releaseManifest());
  assert.equal(result.status, 0, result.stderr);
});

test("release manifest rejects mutable workflow attempt metadata", async () => {
  const manifest = releaseManifest();
  manifest.source.runAttempt = 2;
  const result = await validate(manifest);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /source must contain exactly/);
});

test("Cloud and OSS drain overlays preserve isolation and version-scoped ownership", async () => {
  for (const topology of ["cloud", "oss"]) {
    const path = resolve(repository, `infra/compose/${topology}/drain.override.yaml`);
    const parsed = parse(await readFile(path, "utf8"));
    for (const [service, role] of [["worker", "old"], ["worker-new", "new"]]) {
      const definition = parsed.services?.[service];
      assert.ok(definition, `${topology}:${service}`);
      assert.equal(definition.labels?.["infinite-canvas.revision-role"], role);
      assert.match(definition.image, new RegExp(`WORKER_${role.toUpperCase()}_IMAGE`));
      assert.match(String(definition.environment?.OUTBOX_DISPATCHER_ENABLED), new RegExp(`WORKER_${role.toUpperCase()}_DISPATCHER_ENABLED`));
      assert.match(String(definition.environment?.UNKNOWN_RECONCILER_ENABLED), new RegExp(`WORKER_${role.toUpperCase()}_RECONCILER_ENABLED`));
      assert.match(JSON.stringify(definition.healthcheck), /127\.0\.0\.1:8733\/health/);
      assert.equal(definition.ports, undefined);
    }
    assert.equal(parsed.services["worker-new"].read_only, true);
    assert.deepEqual(parsed.services["worker-new"].cap_drop, ["ALL"]);
    assert.deepEqual(parsed.services["worker-new"].security_opt, ["no-new-privileges:true"]);
    assert.equal(parsed.services["worker-new"].stop_grace_period, "50m");
  }

  const image = `ghcr.io/listencodes/infinite-canvas-worker@${digest}`;
  const valid = await validateDrainEnvironment([
    `WORKER_OLD_IMAGE=${image}`,
    `WORKER_NEW_IMAGE=${image}`,
    "WORKER_OLD_DISPATCHER_ENABLED=true",
    "WORKER_NEW_DISPATCHER_ENABLED=false",
    "WORKER_OLD_RECONCILER_ENABLED=true",
    "WORKER_NEW_RECONCILER_ENABLED=false",
  ]);
  assert.equal(valid.status, 0, valid.stderr);
  const doubleDispatcher = await validateDrainEnvironment([
    `WORKER_OLD_IMAGE=${image}`,
    `WORKER_NEW_IMAGE=${image}`,
    "WORKER_OLD_DISPATCHER_ENABLED=true",
    "WORKER_NEW_DISPATCHER_ENABLED=true",
    "WORKER_OLD_RECONCILER_ENABLED=true",
    "WORKER_NEW_RECONCILER_ENABLED=false",
  ]);
  assert.equal(doubleDispatcher.status, 1);
  assert.match(doubleDispatcher.stderr, /exactly one dispatcher owner/);
  const noDispatcher = await validateDrainEnvironment([
    `WORKER_OLD_IMAGE=${image}`,
    `WORKER_NEW_IMAGE=${image}`,
    "WORKER_OLD_DISPATCHER_ENABLED=false",
    "WORKER_NEW_DISPATCHER_ENABLED=false",
    "WORKER_OLD_RECONCILER_ENABLED=true",
    "WORKER_NEW_RECONCILER_ENABLED=false",
  ]);
  assert.equal(noDispatcher.status, 1);
  assert.match(noDispatcher.stderr, /exactly one dispatcher owner/);
  const zeroHandoff = await validateDrainEnvironment([
    `WORKER_OLD_IMAGE=${image}`,
    `WORKER_NEW_IMAGE=${image}`,
    "GENERATION_WRITES_ENABLED=false",
    "WORKER_OLD_DISPATCHER_ENABLED=false",
    "WORKER_NEW_DISPATCHER_ENABLED=false",
    "WORKER_OLD_RECONCILER_ENABLED=false",
    "WORKER_NEW_RECONCILER_ENABLED=false",
  ], true);
  assert.equal(zeroHandoff.status, 0, zeroHandoff.stderr);
  const unsafeZeroHandoff = await validateDrainEnvironment([
    `WORKER_OLD_IMAGE=${image}`,
    `WORKER_NEW_IMAGE=${image}`,
    "GENERATION_WRITES_ENABLED=true",
    "WORKER_OLD_DISPATCHER_ENABLED=false",
    "WORKER_NEW_DISPATCHER_ENABLED=false",
    "WORKER_OLD_RECONCILER_ENABLED=false",
    "WORKER_NEW_RECONCILER_ENABLED=false",
  ], true);
  assert.equal(unsafeZeroHandoff.status, 1);
  assert.match(unsafeZeroHandoff.stderr, /GENERATION_WRITES_ENABLED=false/);
  const partialZeroHandoff = await validateDrainEnvironment([
    `WORKER_OLD_IMAGE=${image}`,
    `WORKER_NEW_IMAGE=${image}`,
    "GENERATION_WRITES_ENABLED=false",
    "WORKER_OLD_DISPATCHER_ENABLED=false",
    "WORKER_NEW_DISPATCHER_ENABLED=false",
    "WORKER_OLD_RECONCILER_ENABLED=true",
    "WORKER_NEW_RECONCILER_ENABLED=false",
  ], true);
  assert.equal(partialZeroHandoff.status, 1);
  assert.match(partialZeroHandoff.stderr, /requires all dispatcher and reconciler flags to be false/);
  const doubleReconciler = await validateDrainEnvironment([
    `WORKER_OLD_IMAGE=${image}`,
    `WORKER_NEW_IMAGE=${image}`,
    "WORKER_OLD_DISPATCHER_ENABLED=true",
    "WORKER_NEW_DISPATCHER_ENABLED=true",
    "WORKER_OLD_RECONCILER_ENABLED=true",
    "WORKER_NEW_RECONCILER_ENABLED=true",
  ]);
  assert.equal(doubleReconciler.status, 1);
  assert.match(doubleReconciler.stderr, /exactly one reconciler owner/);
});

test("drain proof blocks accepted v1 runs that have not claimed their attempt", async () => {
  const runbook = await readFile(resolve(repository, "docs/operations/upgrade-and-drain.md"), "utf8");
  assert.match(runbook, /A `sent` Outbox row with a `created` attempt is still an\s+accepted Hatchet run waiting to claim/);
  assert.match(
    runbook,
    /attempt\.status in \(\s*'created',\s*'claimed',\s*'submitting',\s*'accepted',\s*'materializing',\s*'outcome_unknown'\s*\)/,
  );
});

test("release manifest rejects a missing target platform", async () => {
  const manifest = releaseManifest();
  manifest.images.worker.platforms.pop();
  const result = await validate(manifest);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /linux\/amd64 and linux\/arm64/);
});

test("release manifest rejects a tag not bound to the full source commit", async () => {
  const manifest = releaseManifest();
  manifest.images.api.tags = ["ghcr.io/listencodes/infinite-canvas-api:sha-short"];
  const result = await validate(manifest);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tags do not match/);
});

test("release manifest rejects a missing service", async () => {
  const manifest = releaseManifest();
  delete manifest.images.worker;
  const result = await validate(manifest);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exactly api, web, and worker/);
});

test("release manifest rejects a missing primary digest", async () => {
  const manifest = releaseManifest();
  manifest.images.api.digest = "";
  const result = await validate(manifest);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid api digest/);
});

test("release manifest rejects an additional service", async () => {
  const manifest = releaseManifest();
  manifest.images.docs = { ...manifest.images.web };
  const result = await validate(manifest);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exactly api, web, and worker/);
});

test("release manifest rejects environment references that differ from the manifest", async () => {
  const manifest = releaseManifest();
  const result = await validate(manifest, (environment) =>
    environment.replace(manifest.images.web.reference, `ghcr.io/listencodes/infinite-canvas-web@sha256:${"f".repeat(64)}`),
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /web reference differs from release-images.env/);
});

test("all third-party workflow actions use immutable commit SHAs", async () => {
  const workflowDirectory = resolve(repository, ".github/workflows");
  for (const name of await readdir(workflowDirectory)) {
    if (!/\.ya?ml$/i.test(name)) continue;
    const content = await readFile(resolve(workflowDirectory, name), "utf8");
    for (const match of content.matchAll(/^\s*uses:\s*([^\s#]+).*$/gim)) {
      const reference = match[1];
      if (!reference.startsWith("./")) {
        assert.match(reference, /@[a-f0-9]{40}$/, `${name}: ${reference}`);
      }
    }
  }
});

test("leaf release workflows cannot be dispatched independently", async () => {
  for (const name of ["docs-docker-image.yml", "github-pages.yml", "publish-plugins.yml"]) {
    const content = await readFile(resolve(repository, ".github/workflows", name), "utf8");
    assert.match(content, /^\s*workflow_call:\s*$/m, name);
    assert.doesNotMatch(content, /^\s*workflow_dispatch:\s*$/m, name);
  }
});

test("release evidence is finalized after every leaf publisher without clobber", async () => {
  const content = await readFile(resolve(repository, ".github/workflows/docker-image.yml"), "utf8");
  const finalizer = content.slice(content.indexOf("  finalize-release:"));
  assert.match(finalizer, /^\s*needs:\s*publish-pages\s*$/m);
  assert.match(finalizer, /cmp --silent/);
  assert.doesNotMatch(finalizer, /--clobber/);
  assert.match(finalizer, /gh release edit "\$GITHUB_REF_NAME" --draft=false --latest/);
});

test("tag promotion persists and reuses one release set before writing image tags", async () => {
  const content = await readFile(resolve(repository, ".github/workflows/docker-image.yml"), "utf8");
  const workflow = parse(content);
  const steps = workflow.jobs?.["verify-and-promote-release-manifest"]?.steps;
  assert.ok(Array.isArray(steps));
  const promote = steps.find(({ name }) => name === "Establish release set and promote immutable manifests");
  assert.ok(promote?.run);
  const createBoundary = promote.run.indexOf('gh release create "$GITHUB_REF_NAME"');
  const reuseBoundary = promote.run.indexOf('gh release download "$GITHUB_REF_NAME"');
  const shaPromotion = promote.run.indexOf('sha_tag="${image}:sha-${GITHUB_SHA}"');
  const releasePromotion = promote.run.indexOf('release_tag="${image}:${GITHUB_REF_NAME}"');
  assert.ok(createBoundary >= 0 && reuseBoundary >= 0);
  assert.ok(shaPromotion > createBoundary && shaPromotion > reuseBoundary);
  assert.ok(releasePromotion > shaPromotion);
  assert.match(promote.run, /--draft --verify-tag --generate-notes/);
  assert.match(promote.run, /The persisted release set, not a rebuilt candidate, is authoritative on reruns/);
  assert.match(promote.run, /RELEASE_MANIFEST_PATH="\$RUNNER_TEMP\/release-images\.json"/);
  assert.match(promote.run, /gh release download "\$GITHUB_REF_NAME" --pattern combined-restore\.json/);
  assert.match(promote.run, /\.candidate\.releaseManifest\.sha256 == \$manifestSha/);
  const artifact = steps.find(({ uses }) => String(uses).startsWith("actions/upload-artifact@"));
  assert.equal(artifact?.with?.overwrite, true);
  assert.match(artifact?.with?.path ?? "", /release-evidence\/combined-restore\.json/);
});

test("documentation image bases are immutable and recorded in the image lock", async () => {
  const dockerfile = await readFile(resolve(repository, "docs/Dockerfile"), "utf8");
  const lock = await readFile(resolve(repository, "infra/release/images.lock"), "utf8");
  const bases = [...dockerfile.matchAll(/^FROM\s+([^\s]+)(?:\s+AS\s+\S+)?$/gim)].map((match) => match[1]);
  assert.equal(bases.length, 2);
  for (const base of bases) {
    assert.match(base, /@sha256:[a-f0-9]{64}$/);
    assert.ok(lock.includes(base), `${base} is missing from images.lock`);
  }
});

test("release gate builds recovery images before the drill and uploads exact evidence", async () => {
  const content = await readFile(resolve(repository, ".github/workflows/release-gate.yml"), "utf8");
  const workflow = parse(content);
  const steps = workflow.jobs?.["deployment-config"]?.steps;
  assert.ok(Array.isArray(steps));
  const buildIndex = steps.findIndex(({ name }) => name === "Build deployable service images");
  const drillIndex = steps.findIndex(({ name }) => name === "Run isolated combined recovery drill");
  const uploadIndex = steps.findIndex(({ name }) => name === "Preserve redacted recovery evidence");
  assert.ok(buildIndex >= 0 && drillIndex > buildIndex && uploadIndex > drillIndex);
  assert.match(steps[buildIndex].run, /docker build -t infinite-canvas-api:gate -f apps\/api\/Dockerfile \./);
  assert.match(steps[buildIndex].run, /docker build -t infinite-canvas-worker:gate -f apps\/worker\/Dockerfile \./);
  assert.equal(steps[drillIndex].run, 'npm run recovery:drill -- --evidence-dir "$RUNNER_TEMP/recovery-evidence"');
  assert.equal(steps[uploadIndex].uses, "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
  assert.deepEqual(steps[uploadIndex].with, {
    name: "combined-recovery-${{ github.sha }}",
    path: "${{ runner.temp }}/recovery-evidence/combined-restore.json",
    "if-no-files-found": "error",
    "retention-days": 14,
  });
});

test("release gate scans all browser storage layers with exact platform canaries", async () => {
  const content = await readFile(resolve(repository, ".github/workflows/release-gate.yml"), "utf8");
  const workflow = parse(content);
  const steps = workflow.jobs?.quality?.steps;
  assert.ok(Array.isArray(steps));
  const buildIndex = steps.findIndex(({ name }) => name === "Verify Web");
  const storageIndex = steps.findIndex(({ name }) => name === "Verify browser storage secret boundary");
  assert.ok(buildIndex >= 0 && storageIndex > buildIndex);
  assert.equal(steps[storageIndex].run, "npm run verify:browser-storage-boundary");
  assert.equal(
    steps[storageIndex].env?.SECRET_SCAN_CANARIES,
    "release-gate-service-secret-0001,release-gate-hatchet-secret-0002,release-gate-credential-secret-0003",
  );
});
