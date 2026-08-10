import { createHash } from "node:crypto";

import { strFromU8, unzipSync } from "fflate";
import { z } from "zod";

const fileSchema = z.object({
  path: z.string().min(1).max(500),
  bytes: z.string().regex(/^\d+$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.string().min(1).max(100),
});

export const localExportManifestSchema = z.object({
  format: z.literal("infinite-canvas-local-export"),
  schemaVersion: z.literal(1),
  clientExportId: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  counts: z.object({
    projects: z.number().int().nonnegative(),
    assets: z.number().int().nonnegative(),
    objects: z.number().int().nonnegative(),
  }),
  files: z.array(fileSchema).min(2).max(20_000),
});

export const importedProjectSchema = z.object({
  sourceId: z.string().min(1).max(500),
  title: z.string().trim().min(1).max(200),
  documentJson: z.record(z.string(), z.unknown()),
});

export const importedAssetSchema = z.object({
  sourceId: z.string().min(1).max(500),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.string().regex(/^\d+$/),
  mime: z.string().regex(/^(image|video|audio)\/[a-z0-9.+-]+$/i),
  filename: z.string().trim().min(1).max(200),
  kind: z.enum(["image", "video", "audio"]).optional(),
});

export interface ParsedLocalDataArchive {
  manifest: z.infer<typeof localExportManifestSchema>;
  manifestSha256: string;
  projects: z.infer<typeof importedProjectSchema>[];
  assets: z.infer<typeof importedAssetSchema>[];
  objects: Map<string, Uint8Array>;
}

function safePath(path: string): boolean {
  return !path.startsWith("/") && !path.startsWith("\\") && !path.includes("\\") &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonFile(files: Record<string, Uint8Array>, path: string): unknown {
  const value = files[path];
  if (!value) throw new Error(`Archive is missing ${path}`);
  return JSON.parse(strFromU8(value)) as unknown;
}

function assertNoSecrets(value: unknown, path = "data"): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/^(api.?key|authorization|password|refresh.?token|access.?token|secret|signed.?url)$/i.test(key)) {
      throw new Error(`Archive contains forbidden secret field at ${path}.${key}`);
    }
    assertNoSecrets(item, `${path}.${key}`);
  }
}

export function parseLocalDataArchive(buffer: Uint8Array, maxUncompressedBytes: number): ParsedLocalDataArchive {
  const files = unzipSync(buffer, { filter: ({ name, originalSize }) => {
    if (!safePath(name)) throw new Error(`Archive contains unsafe path: ${name}`);
    if (originalSize > maxUncompressedBytes) throw new Error(`Archive entry is too large: ${name}`);
    return true;
  } });
  const names = Object.keys(files);
  if (names.length > 20_000) throw new Error("Archive contains too many entries");
  const total = Object.values(files).reduce((sum, value) => sum + value.byteLength, 0);
  if (total > maxUncompressedBytes) throw new Error("Archive uncompressed size exceeds the limit");

  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) throw new Error("Archive is missing manifest.json");
  const manifest = localExportManifestSchema.parse(JSON.parse(strFromU8(manifestBytes)));
  const declared = new Set<string>();
  for (const file of manifest.files) {
    if (!safePath(file.path) || declared.has(file.path)) throw new Error(`Manifest contains invalid or duplicate path: ${file.path}`);
    declared.add(file.path);
    const value = files[file.path];
    if (!value) throw new Error(`Archive is missing declared file: ${file.path}`);
    if (BigInt(value.byteLength) !== BigInt(file.bytes)) throw new Error(`Size mismatch for ${file.path}`);
    if (hash(value) !== file.sha256) throw new Error(`Checksum mismatch for ${file.path}`);
  }
  for (const name of names) {
    if (name !== "manifest.json" && !declared.has(name)) throw new Error(`Archive contains undeclared file: ${name}`);
  }

  const projects = z.array(importedProjectSchema).parse(jsonFile(files, "data/projects.json"));
  const assets = z.array(importedAssetSchema).parse(jsonFile(files, "data/assets.json"));
  if (declared.has("data/local-assets.json")) {
    const localAssets = z.array(z.record(z.string(), z.unknown())).parse(jsonFile(files, "data/local-assets.json"));
    assertNoSecrets(localAssets, "localAssets");
  }
  assertNoSecrets(projects, "projects");
  assertNoSecrets(assets, "assets");
  if (projects.length !== manifest.counts.projects || assets.length !== manifest.counts.assets) throw new Error("Manifest record counts do not match data files");
  const objects = new Map<string, Uint8Array>();
  for (const asset of assets) {
    const path = `objects/${asset.sha256}`;
    const value = files[path];
    if (!value || hash(value) !== asset.sha256 || BigInt(value.byteLength) !== BigInt(asset.bytes)) {
      throw new Error(`Asset object verification failed: ${asset.sourceId}`);
    }
    objects.set(asset.sha256, value);
  }
  if (objects.size !== manifest.counts.objects) throw new Error("Manifest object count does not match unique asset objects");
  return { manifest, manifestSha256: hash(manifestBytes), projects, assets, objects };
}
