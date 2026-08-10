import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? "web/dist");
const forbidden = [
  /SUPABASE_SERVICE_ROLE_KEY/g,
  /CREDENTIAL_MASTER_KEY/g,
  /HATCHET_CLIENT_TOKEN/g,
  /BUSINESS_DATABASE_(?:URL|MIGRATION_URL|LISTENER_URL)/g,
  /S3_SECRET_ACCESS_KEY/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\bsb_secret_[A-Za-z0-9._-]+/g,
];
const canaries = (process.env.SECRET_SCAN_CANARIES ?? "").split(",").map((value) => value.trim()).filter((value) => value.length >= 12);

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if ((await stat(path)).size <= 20 * 1024 * 1024) result.push(path);
  }
  return result;
}

const violations = [];
for (const path of await files(root)) {
  const content = await readFile(path, "utf8").catch(() => "");
  for (const pattern of forbidden) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) violations.push(`${path}: forbidden pattern ${pattern.source}`);
  }
  for (const canary of canaries) {
    if (content.includes(canary)) violations.push(`${path}: secret canary was embedded`);
  }
}

if (violations.length) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Web bundle secret boundary passed\n");
}
