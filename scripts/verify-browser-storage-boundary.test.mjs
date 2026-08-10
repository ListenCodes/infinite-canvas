import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verifier = resolve(repository, "scripts/verify-browser-storage-boundary.mjs");

test("browser storage verifier fails closed when the built application cannot start", async () => {
  const fixtures = [
    {
      name: "missing-script",
      html: '<div id="root"><span>ready</span></div><script src="/missing.js"></script>',
    },
    {
      name: "page-error",
      html: '<div id="root"><span>ready</span></div><script>throw new Error("fixture startup failure")</script>',
    },
    { name: "empty-root", html: '<div id="root"></div>' },
  ];
  const directory = await mkdtemp(join(tmpdir(), "infinite-canvas-browser-boundary-"));
  try {
    for (const fixture of fixtures) {
      const root = resolve(directory, fixture.name);
      await mkdir(root);
      await writeFile(resolve(root, "index.html"), fixture.html, "utf8");
      const result = spawnSync(process.execPath, [verifier, root], {
        cwd: repository,
        encoding: "utf8",
        env: {
          ...process.env,
          BROWSER_STARTUP_TIMEOUT_MS: "250",
          SECRET_SCAN_CANARIES: "browser-boundary-canary-0001",
        },
        timeout: 30_000,
      });
      assert.notEqual(result.status, 0, `${fixture.name} unexpectedly passed`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
