# Local data export v1

This format is the migration boundary from browser-owned data to server-owned projects and assets. Export is read-only: successful upload never deletes or mutates the original browser data.

## Archive layout

```text
manifest.json
data/projects.json
data/assets.json
data/image-generation-logs.json
data/video-generation-logs.json
objects/<sha256>
```

`manifest.json` contains:

```json
{
  "format": "infinite-canvas-local-export",
  "schemaVersion": 1,
  "clientExportId": "019...",
  "createdAt": "2026-08-10T00:00:00.000Z",
  "counts": { "projects": 0, "assets": 0, "objects": 0 },
  "files": [
    { "path": "data/projects.json", "bytes": "0", "sha256": "...", "mediaType": "application/json" }
  ]
}
```

Rules:

- `clientExportId` is generated once and retained when the same archive is retried.
- Every file has byte length and SHA-256. Missing or mismatched files reject the import before publication.
- Existing browser project, asset, node, slot, and storage keys are retained as source IDs. Server IDs are mapped separately.
- Blob filenames are content hashes. Duplicate content may be uploaded once, but tenant authorization still uses database asset ownership.
- `apiKey`, provider headers, WebDAV credentials, Agent tokens, signed URLs, plugin code, local paths, and session data are excluded.
- JSON uses UTF-8, UTC timestamps, and decimal strings for values that may exceed JavaScript safe integers.
- Unknown schema versions are rejected without overwriting an earlier import.

## Server import protocol

1. Create an import using `(user_id, client_export_id)` as the uniqueness key.
2. Upload the archive to a private temporary namespace.
3. Verify archive limits, paths, every checksum, counts, media type, and tenant ownership.
4. Import objects and records with source-ID upserts in an isolated staging namespace.
5. Atomically publish the completed import and record its mapping and audit event.
6. On failure, retain the error for retry and garbage-collect only the server temporary namespace.

The browser keeps its original stores and downloaded archive until the user explicitly removes them. Switching accounts in one browser never implicitly assigns unowned local data to the next account.
