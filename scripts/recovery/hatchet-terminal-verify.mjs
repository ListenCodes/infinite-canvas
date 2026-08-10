import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  RESULT_PREFIX,
  createClient,
  redactErrorMessage,
  requireSingleProbeInventoryEntry,
  terminalRunInventory,
  verifyTerminalRun,
} from "./hatchet-terminal-evidence.mjs";

export async function verifyRestoredTerminalRun(client, expected) {
  const before = await terminalRunInventory(client);
  const observed = await verifyTerminalRun(client, expected);
  const after = await terminalRunInventory(client);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Target verification changed the Hatchet run inventory");
  requireSingleProbeInventoryEntry(after, observed);
  return observed;
}

async function main() {
  const tokenPath = process.env.HATCHET_CLIENT_TOKEN_FILE;
  const statePath = process.env.RECOVERY_PROBE_STATE_PATH;
  if (!tokenPath) throw new Error("HATCHET_CLIENT_TOKEN_FILE is required");
  if (!statePath) throw new Error("RECOVERY_PROBE_STATE_PATH is required");
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (!token) throw new Error("Hatchet client token file is empty");
  const expected = JSON.parse(await readFile(statePath, "utf8"));
  return verifyRestoredTerminalRun(createClient(token), expected);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const observation = await main();
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(observation)}\n`, () => process.exit(0));
  } catch (error) {
    process.stderr.write(`Hatchet recovery verification failed: ${redactErrorMessage(error)}\n`, () => process.exit(1));
  }
}
