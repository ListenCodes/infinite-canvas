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
