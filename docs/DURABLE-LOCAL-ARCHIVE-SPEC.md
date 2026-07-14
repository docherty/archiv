# Durable Local Archive Repository Specification

Status: draft implementation contract  
Created: 2026-05-18  
Related checklist: [DURABLE-LOCAL-ARCHIVE-IMPLEMENTATION-PLAN.md](DURABLE-LOCAL-ARCHIVE-IMPLEMENTATION-PLAN.md)

This document defines the on-disk repository format for durable Venice backups. The format is intentionally file-based, portable, and usable without a local server. The Chrome extension writes the repository through browser file APIs; the local viewer reads the same files back directly from disk where browser permissions allow it.

## Goals

- Preserve Venice conversations, messages, and media locally even if browser cache is wiped or corrupted.
- Support incremental exports into the same repository without rewriting unchanged files.
- Keep flat files friendly to `jq`, scripts, notebooks, local search, and LLM ingestion.
- Make the repository itself the source of truth, not `chrome.storage.local`.
- Keep restore and live Venice writes out of scope.
- Avoid a local server for the normal workflow.

## Repository Layout

```text
venice-archive/
  venice-archive.manifest.json
  stores/
    store--<source-name>--<name-hash>.json
  conversations/
    <conversation-id>--<safe-title>.json
    <conversation-id>--<safe-title>.md
  exports/
    <export-id>.manifest.json
  indexes/
    conversations.json
    messages.jsonl
    media.json
    unresolved-media.json
  media/
    sha256/
      ab/
        <sha256>.<ext>
  viewer/
    index.html
    viewer-data.json
  logs/
    <export-id>.log.json
```

The root manifest is the repository marker. A selected folder is considered a Venice archive repository only when `venice-archive.manifest.json` exists and validates against the supported schema version.

## Source Coverage Contract

The repository must preserve both normalized views and lossless source data.

- The exporter inventories every object store in `venice-db-encrypted`.
- It discovers every highest-version RxDB collection in `venice-rx-db-encrypted`; known collections receive readable projections and unknown future collections receive an `rxdb:` logical name.
- It archives recoverable `localStorage` state while redacting authentication tokens, credentials, and the encryption key (key-vault handling remains separate).
- It recursively inventories Origin Private File System files and materializes every readable file under `media/sha256/`.
- A store present in initial inventory but unreadable, partially read, or changed before final inventory invalidates the export. Optional UI projections never make a discovered source store optional.

Current Venice frontend evidence (2026-07-10) uses Dexie schema version 30, RxDB collections for regular chats, Mind chats, media metadata, attachments, memories, and related content, plus `video-studio-recovery/activeGenerations`. The source coverage contract enumerates every origin IndexedDB database/store and every physical RxDB object store, so decoded projections never replace the raw recovery layer and a Venice release does not require a matching extension release merely to avoid data loss.

## Lossless Source Store Files

Each discovered source store is written as one JSON array:

```text
stores/store--<safe-logical-name>--<stable-name-hash>.json
```

The root manifest `records.sourceStores` entry for each active store includes its logical name, physical source, physical store name, schema version, record count, SHA-256, byte count, repository path, and last-seen timestamp. Store files with unchanged SHA-256 values are left untouched on folder-based incremental exports. Missing current stores are tombstoned in the manifest; historical files are never deleted automatically.

Normalized conversation files are optimized for search and reading. Source-store files are the lossless recovery layer and retain fields that the current viewer does not understand.

## Root Manifest

File: `venice-archive.manifest.json`

```json
{
  "schemaVersion": "1.0.0",
  "archiveId": "venice-archive-2026-05-18T10-47-15Z",
  "createdAt": "2026-05-18T10:47:15.000Z",
  "updatedAt": "2026-05-18T10:52:03.000Z",
  "latestExportId": "export-2026-05-18T10-52-03Z",
  "source": {
    "app": "venice.ai",
    "databaseName": "venice-db-encrypted",
    "databaseVersion": 210,
    "keyFingerprint": "optional-key-fingerprint"
  },
  "generatedBy": {
    "extensionName": "Venice History Sync",
    "extensionVersion": "0.2.0",
    "protocolVersion": "2026-03-store-api-v6"
  },
  "totals": {
    "conversations": 225,
    "messages": 2080,
    "mediaFiles": 17,
    "unresolvedMedia": 12,
    "sourceStores": 31,
    "sourceRecords": 4810,
    "exports": 2
  },
  "indexes": {
    "conversations": "indexes/conversations.json",
    "messages": "indexes/messages.jsonl",
    "media": "indexes/media.json",
    "unresolvedMedia": "indexes/unresolved-media.json"
  },
  "verification": {
    "status": "verified",
    "verifiedAt": "2026-05-18T10:52:05.000Z",
    "warnings": []
  }
}
```

The root manifest should be committed last during an export. If an export is interrupted before this file is updated, the prior repository state remains canonical.

Interrupted local writes are retried by selecting the same repository folder and running another archive update. Existing content-addressed media and unchanged conversation JSON/Markdown files are skipped where possible; the root manifest is not advanced until the retry completes.

When an existing root manifest uses a schema older than the extension supports, the extension must refuse to write and report that repository migration is required. When an existing root manifest uses a newer schema, the extension must refuse to write and instruct the user to update the extension before modifying the repository.

The `records` section stores canonical fingerprints for conversation outputs, settings records, studio records, unresolved media candidates, and source-store integrity metadata. It must not store raw media bytes or embedded base64 payloads; those live in `stores/` and `media/sha256/`.

## Export Manifest

File: `exports/<export-id>.manifest.json`

Each export manifest describes one read from Venice and one attempted repository update.

Required fields:

- `schemaVersion`: export manifest schema version.
- `exportId`: stable id derived from export timestamp.
- `startedAt` and `finishedAt`: ISO timestamps.
- `status`: `planned`, `committed`, `failed`, or `aborted`.
- `sourceInventory`: initial/final store inventory and DB version.
- `storeManifests`: per-store counts, byte estimates, and SHA-256 hashes.
- `changes`: counts of added, changed, unchanged, tombstoned, and skipped records.
- `changes.conversationsAdded`, `changes.conversationsChanged`, `changes.conversationsSkipped`, and `changes.tombstonedConversationIds`: the pre-commit write plan for conversation records.
- `media`: counts of materialized, deduped, unresolved, skipped, and failed media items.
- `warnings`: user-visible warnings that do not invalidate the export.
- `errors`: fatal errors if the export did not commit.

Exports must fail closed if the encryption key or database version changes; a store appears/disappears; or any source fingerprint/count changes during the read, including same-count in-place edits.

## Conversation Files

Each conversation has two canonical files:

- `conversations/<conversation-id>--<safe-title>.json`
- `conversations/<conversation-id>--<safe-title>.md`

Filename rules:

- Always include the immutable Venice conversation id first.
- Generate `<safe-title>` from the resolved title, lowercase where practical, with unsafe filesystem characters removed or replaced by hyphens.
- Keep filenames stable by preserving the old slug in the manifest unless the title was previously empty or unusable.
- Keep the full title inside the JSON and Markdown even if the filename slug is truncated.

Once a conversation has been written, later exports should reuse its prior JSON and Markdown paths from the root manifest so title edits do not break local links.

Title resolution order:

1. `conversation.name`
2. `conversation.title`
3. generated label fields if Venice exposes them
4. first readable user or assistant message text
5. `Untitled conversation`

Conversation JSON shape:

```json
{
  "schemaVersion": "1.0.0",
  "id": "1g8W9AY",
  "title": "My mum has received the attached letter...",
  "createdAt": "2026-05-18T10:00:00.000Z",
  "updatedAt": "2026-05-18T10:12:00.000Z",
  "messageCount": 12,
  "mediaCount": 2,
  "source": {
    "store": "conversations",
    "recordHash": "sha256-record-hash"
  },
  "messages": [
    {
      "id": "36s6Iqo",
      "role": "user",
      "createdAt": "2026-05-18T10:01:00.000Z",
      "model": null,
      "text": "Readable message text",
      "media": [
        {
          "mediaId": "sha256:<hash>",
          "path": "../media/sha256/ab/<hash>.jpg",
          "kind": "image",
          "fileName": "IMG_1808.jpg"
        }
      ],
      "source": {
        "store": "messages",
        "recordHash": "sha256-record-hash"
      }
    }
  ]
}
```

Markdown output should be easy to read and paste into an LLM. It should include the title, Venice id, timestamps, each message role, message text, and local media references.

## Media Files

Media is content-addressed by SHA-256 when bytes are available:

```text
media/sha256/<first-two-hex>/<sha256>.<ext>
```

Media index records must include:

- `mediaId`: `sha256:<hash>` for materialized bytes, or a stable unresolved id.
- `path`: repository-relative local path when materialized.
- `sha256`: content hash when materialized.
- `bytes`: byte size when materialized.
- `mimeType`: detected or inferred MIME type.
- `kind`: `image`, `video`, `audio`, `document`, or `file`.
- `sources`: array of source references with store, record id, message id, conversation id, turn id, session id, and original URL where available.
- `status`: `materialized`, `deduped`, `unresolved`, `skipped`, or `failed`.
- `reason`: required for unresolved, skipped, or failed media.

Message attachments with base64 `attachments[].result` are materializable media candidates. Studio records that contain only encrypted data or metadata are unresolved records, not successful media exports.

Current Venice media is also stored in OPFS. The exporter recursively captures paths including:

```text
media/<conversation-id>/<media-id>.<ext>
media/<conversation-id>/attachments/<attachment-id>.<ext>
thumbnails/<thumbnail-id>.jpg
```

Other OPFS directories are included rather than filtered out. OPFS paths are provenance only; archive media files remain content-addressed. Metadata records are correlated to OPFS filenames by conversation id and media/attachment id where possible.

Media that existed only as an in-memory Blob is captured by the installed page hook. Existing mounted `blob:` image/video/audio elements are scanned when the extension attaches. Live-capture gaps, oversized ephemeral Blobs, expired URLs, OPFS failures, and unreadable files must be explicit unresolved/failed index records.

## Indexes

`indexes/conversations.json` is optimized for viewer startup and conversation list rendering. It contains one compact summary per conversation.

`indexes/messages.jsonl` is optimized for search and LLM ingestion. Each line is a single message record with conversation id, role, timestamps, text, and local media references.

`indexes/media.json` contains all materialized and unresolved media records.

`indexes/unresolved-media.json` contains only unresolved, skipped, and failed records so gaps are visible and auditable.

Indexes are derived artifacts. They can be rebuilt from conversation files, media files, and export manifests.

## Incremental Export Semantics

1. Read current Venice store inventory.
2. Fetch stores through the existing byte-bounded page API.
3. Re-read final inventory and abort if the key, DB version, complete store-name set, counts, or decoded source fingerprints drift.
4. Build canonical fingerprints for each record.
5. Compare fingerprints to the root manifest and prior export manifests.
6. Stage only new or changed conversation, index, media, and manifest files.
7. Leave unchanged files untouched.
8. Mark missing current records as tombstoned in the manifest; do not delete historical files automatically.
9. Write changed source-store snapshots and leave hash-identical store files untouched.
10. Recursively materialize OPFS, embedded, URL-backed, and live-captured media with content-hash deduplication.
11. Verify staged writes and checksums.
12. Commit export manifest, derived indexes, viewer files, and root manifest last.

If any media record is unresolved or failed, the repository can still be committed for retry but the root manifest verification status must be `incomplete`, not `verified`.

## Viewer Requirements

The viewer must support the normal path without a local server. Preferred options are:

1. A generated `viewer/index.html` that can load bundled `viewer-data.json` or prompt the user to select the archive folder/files through browser file APIs.
2. Static repository indexes that remain useful even if browser file restrictions limit automatic loading.

The viewer should provide:

- conversation list with tokenized search across titles, message text, models, attachments, media, prompts, and agent/tool segments, plus type/media/status filters and sorting
- readable message pane with inline local media where available
- media gallery with search, type/source/status filters, sorting, preview, metadata, and local file references
- explicit archive health, unresolved media, and partial export states
- accessible keyboard and focus behavior
- responsive layouts with stable dimensions and no overlapping text

## Security and Privacy

- The readable repository contains decrypted Venice data.
- The extension must not write data back into Venice as part of repository export.
- The repository should be stored in a private local folder or an intentionally trusted sync location.
- Large manifests and indexes should live in the repository, not in `chrome.storage.local`.
- Lightweight extension state may remember recent repository handles and summaries, but the repository must remain recoverable without extension storage.

## Compatibility Artifacts

The existing readable JSON archive, HTML guide, and media gallery zip may remain available as secondary outputs. They should be described as packaging or compatibility artifacts. The durable local repository is canonical.
