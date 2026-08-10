import { createServer } from "node:http";
import { access, readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

import { chromium } from "playwright-core";

const root = resolve(process.argv[2] ?? "web/dist");
const canaries = (process.env.SECRET_SCAN_CANARIES ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.length >= 12);
if (!canaries.length) throw new Error("SECRET_SCAN_CANARIES must contain at least one platform canary");
const startupTimeoutMs = Number(process.env.BROWSER_STARTUP_TIMEOUT_MS ?? "30000");
if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 100 || startupTimeoutMs > 60_000) {
  throw new Error("BROWSER_STARTUP_TIMEOUT_MS must be an integer from 100 to 60000");
}
await access(resolve(root, "index.html"));

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

async function browserExecutable() {
  const candidates = [
    process.env.BROWSER_EXECUTABLE_PATH,
    process.platform === "win32" ? `${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
    process.platform === "win32" ? `${process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe` : undefined,
    process.platform === "win32" ? `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  throw new Error("A supported Chrome/Edge executable is required for browser storage verification");
}

async function staticFile(pathname) {
  const requested = decodeURIComponent(pathname).replace(/^\/+/, "");
  let path = resolve(root, requested || "index.html");
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Unsafe static path");
  const info = await stat(path).catch(() => undefined);
  if (info?.isDirectory()) path = resolve(path, "index.html");
  if (!await stat(path).then((value) => value.isFile()).catch(() => false)) {
    if (extname(requested)) throw new Error("Static asset was not found");
    path = resolve(root, "index.html");
  }
  return path;
}

const server = createServer(async (request, response) => {
  try {
    const path = await staticFile(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    response.writeHead(200, { "content-type": contentTypes[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
    response.end(await readFile(path));
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

async function scanStorage(page) {
  return page.evaluate(async (expected) => {
    const violations = [];
    const visited = new WeakSet();
    const inspect = async (location, value) => {
      if (typeof value === "string") {
        if (expected.some((canary) => value.includes(canary))) violations.push(location);
        return;
      }
      if (value instanceof Blob) {
        if (value.size <= 20 * 1024 * 1024) await inspect(location, await value.text());
        return;
      }
      if (value instanceof ArrayBuffer) {
        if (value.byteLength <= 20 * 1024 * 1024) {
          await inspect(location, new TextDecoder().decode(value));
        }
        return;
      }
      if (ArrayBuffer.isView(value)) {
        if (value.byteLength <= 20 * 1024 * 1024) {
          await inspect(
            location,
            new TextDecoder().decode(
              new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
            ),
          );
        }
        return;
      }
      if (value instanceof Map) {
        if (visited.has(value)) return;
        visited.add(value);
        let entryIndex = 0;
        for (const [key, child] of value.entries()) {
          await inspect(`${location}:map-${entryIndex}:key`, key);
          await inspect(`${location}:map-${entryIndex}:value`, child);
          entryIndex += 1;
        }
        return;
      }
      if (value instanceof Set) {
        if (visited.has(value)) return;
        visited.add(value);
        let entryIndex = 0;
        for (const child of value.values()) {
          await inspect(`${location}:set-${entryIndex}`, child);
          entryIndex += 1;
        }
        return;
      }
      if (value && typeof value === "object") {
        if (visited.has(value)) return;
        visited.add(value);
        let propertyIndex = 0;
        for (const [key, child] of Object.entries(value)) {
          await inspect(`${location}:property-${propertyIndex}:key`, key);
          await inspect(`${location}:property-${propertyIndex}:value`, child);
          propertyIndex += 1;
        }
        return;
      }
      if (value !== undefined && value !== null) await inspect(location, String(value));
    };
    for (const [storageName, storage] of [["localStorage", localStorage], ["sessionStorage", sessionStorage]]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key === null) continue;
        await inspect(`${storageName}:entry-${index}:key`, key);
        await inspect(`${storageName}:entry-${index}:value`, storage.getItem(key));
      }
    }
    if (typeof indexedDB.databases === "function") {
      let databaseIndex = 0;
      for (const entry of await indexedDB.databases()) {
        if (!entry.name) continue;
        const databaseLocation = `indexedDB:database-${databaseIndex}`;
        await inspect(`${databaseLocation}:name`, entry.name);
        const database = await new Promise((resolveOpen, rejectOpen) => {
          const request = indexedDB.open(entry.name);
          request.onsuccess = () => resolveOpen(request.result);
          request.onerror = () => rejectOpen(request.error);
        });
        try {
          let storeIndex = 0;
          for (const storeName of Array.from(database.objectStoreNames)) {
            const storeLocation = `${databaseLocation}:store-${storeIndex}`;
            await inspect(`${storeLocation}:name`, storeName);
            const records = await new Promise((resolveStore, rejectStore) => {
              const values = [];
              const transaction = database.transaction(storeName, "readonly");
              const request = transaction.objectStore(storeName).openCursor();
              request.onerror = () => rejectStore(request.error);
              transaction.onerror = () => rejectStore(transaction.error);
              transaction.oncomplete = () => resolveStore(values);
              request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return;
                values.push({ key: cursor.key, value: cursor.value });
                cursor.continue();
              };
            });
            for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
              const record = records[recordIndex];
              await inspect(`${storeLocation}:record-${recordIndex}:key`, record.key);
              await inspect(`${storeLocation}:record-${recordIndex}:value`, record.value);
            }
            storeIndex += 1;
          }
        } finally {
          database.close();
        }
        databaseIndex += 1;
      }
    }
    return violations;
  }, canaries);
}

let browser;
try {
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind storage verifier server");
  const applicationOrigin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: await browserExecutable(), headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext();
  const page = await context.newPage();
  let pageErrors = 0;
  let failedRequests = 0;
  page.on("pageerror", () => { pageErrors += 1; });
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).origin === applicationOrigin) failedRequests += 1;
  });
  page.on("response", (response) => {
    if (
      new URL(response.url()).origin === applicationOrigin &&
      response.status() >= 400
    ) {
      failedRequests += 1;
    }
  });
  await page.goto(`${applicationOrigin}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => {
    const application = document.querySelector("#root");
    return application instanceof HTMLElement && application.childElementCount > 0;
  }, undefined, { timeout: startupTimeoutMs });
  if (pageErrors || failedRequests) {
    throw new Error(
      `Built Web application failed startup validation (${pageErrors} page errors, ${failedRequests} failed requests)`,
    );
  }
  const initial = await scanStorage(page);
  if (initial.length) throw new Error(`Platform canary found in application browser storage: ${initial.join(", ")}`);

  const probes = [canaries[0], canaries[1] ?? canaries[0], canaries[2] ?? canaries[0]];
  await page.evaluate(([localCanary, sessionCanary, indexedCanary]) => new Promise((resolveProbe, rejectProbe) => {
    localStorage.setItem("infinite-canvas-secret-probe", localCanary);
    sessionStorage.setItem("infinite-canvas-secret-probe", sessionCanary);
    const request = indexedDB.open("infinite-canvas-secret-probe", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("probe");
    request.onerror = () => rejectProbe(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("probe", "readwrite");
      transaction.objectStore("probe").put({ value: indexedCanary }, "canary");
      transaction.oncomplete = () => { database.close(); resolveProbe(); };
      transaction.onerror = () => rejectProbe(transaction.error);
    };
  }), probes);
  const detected = await scanStorage(page);
  for (const prefix of ["localStorage:", "sessionStorage:", "indexedDB:"]) {
    if (!detected.some((location) => location.startsWith(prefix))) throw new Error(`Browser storage scanner did not detect its ${prefix.slice(0, -1)} probe`);
  }
  await page.evaluate(() => new Promise((resolveCleanup, rejectCleanup) => {
    localStorage.removeItem("infinite-canvas-secret-probe");
    sessionStorage.removeItem("infinite-canvas-secret-probe");
    const request = indexedDB.deleteDatabase("infinite-canvas-secret-probe");
    request.onsuccess = () => resolveCleanup();
    request.onerror = () => rejectCleanup(request.error);
  }));
  const cleaned = await scanStorage(page);
  if (cleaned.length) throw new Error(`Platform canary remained after isolated probe cleanup: ${cleaned.join(", ")}`);
  await context.close();
  process.stdout.write("Browser storage secret boundary passed\n");
} finally {
  await browser?.close();
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
}
