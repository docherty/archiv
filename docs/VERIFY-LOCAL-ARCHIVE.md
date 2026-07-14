# Verify a Local Venice Archive Repository

Use this checklist after creating or updating a local archive repository from the backup console. The normal verification path does not require a local server.

When folder access is available, choose the archive location once in the console, use `Create full archive` for the first run, and use `Sync now` thereafter. The saved handle is an access convenience only; the repository manifest and files remain the durable source of truth. `Verify archive` performs a quick in-console checkpoint, while the command below performs the full file-level audit.

For a full checksum/count and derivative-consistency verification, run from this extension repository. The exporter fingerprints records incrementally and streams large Blob hashes; the command checks source stores, content-addressed media, normalized conversation hashes, the message/conversation indexes, viewer data, and the latest committed export manifest:

```bash
npm run verify:archive -- /absolute/path/to/your/venice-archive
```

The command streams large source-store files, verifies every active store count/size/SHA-256, verifies every indexed media file, and exits non-zero when the manifest is incomplete or unresolved media remains.

If folder write access is unavailable in the current browser context, export a local archive package zip and extract it into the target archive folder before running this checklist.

## Package Workflow: Full Once, Incremental Thereafter

For the first package download, use full mode and extract it into one new, private archive folder. Open `viewer/index.html` from that folder and run this checklist before treating the folder as your canonical backup.

After the full package is saved, the backup console shows `Baseline ready` and enables incremental package mode. Each incremental ZIP contains changed/new files plus refreshed manifests, indexes, and the viewer. Open the viewer, choose the ZIP in `Keep this archive current`, and press `Apply to this archive` when folder access is available; otherwise extract it over the same archive folder and allow overwrite. Do not extract a diff into a new folder or delete unchanged files between runs. The ZIP's `PACKAGE-README.txt` repeats these rules so the workflow remains understandable away from the extension UI.

If the browser profile or extension storage is reset, the baseline is intentionally lost and incremental mode is disabled. Run another full package export rather than guessing which historical files the diff depends on.

The package fallback is deliberately explicit rather than pretending it can observe extraction into a local folder. Unattended extraction/sync on a browser without persistent folder access would require a separately installed native helper.

## 1. Confirm the Repository Marker

At the selected archive root, confirm this file exists:

```text
venice-archive.manifest.json
```

Quick checks:

```bash
jq '.schemaVersion, .latestExportId, .verification.status, .totals' venice-archive.manifest.json
```

Expected result:

- `schemaVersion` is `1.0.0`
- `latestExportId` is not empty
- `verification.status` is `verified`; `incomplete` means at least one media item still requires attention and browser data must not be cleared
- `totals.conversations` and `totals.messages` match the export summary in the console

The backup console keeps this distinction visible after the export: `Verified` means the manifest has no unresolved or failed media; `Review media` means the ZIP was saved but the archive is not yet safe for cache offload.

## 2. Open the Viewer Without a Server

Open this file directly from the archive folder:

```text
viewer/index.html
```

Expected result:

- The page opens from `file://`
- Conversation search works
- Sort and media filters work
- Selecting a conversation renders message text
- Markdown and JSON links open local files
- Media chips open local files when media was materialized

## 3. Spot-Check Conversations

List conversation files:

```bash
find conversations -maxdepth 1 -type f | sort | head
```

Inspect one JSON conversation:

```bash
jq '{id, title, messageCount, mediaCount, firstMessage: .messages[0].text}' conversations/<conversation-file>.json
```

Expected result:

- The title is human-readable
- Venice ids are present
- Messages have roles, timestamps, text, and record hashes
- Materialized media includes repository-relative paths when available

## 4. Spot-Check Media

Check the media index:

```bash
jq '.totals, (.items | length)' indexes/media.json
```

List materialized media:

```bash
find media/sha256 -type f | sort | head
```

Expected result:

- Embedded attachments, RxDB-backed attachments, OPFS files, URL-backed media, and live-captured Blobs are content-addressed under `media/sha256/`
- Media index records include `sha256`, `bytes`, `mimeType`, `status`, and source ids where available
- Unresolved media is visible instead of silently counted as exported

Check OPFS provenance and archived-file totals:

```bash
jq '.totals | {archivedFiles, opfsFiles, liveCapturedFiles}' indexes/media.json
jq '[.items[] | select(.source == "opfs")][0:5]' indexes/media.json
```

Current Venice builds normally produce OPFS-backed records. If you have images, video, audio, or uploaded attachments but `opfsFiles` is zero, do not clear site data until the cause is understood.

## 5. Verify Lossless Source Stores

```bash
jq '.totals | {sourceStores, sourceRecords}' venice-archive.manifest.json
jq '.records.sourceStores | to_entries[0:5]' venice-archive.manifest.json
find stores -maxdepth 1 -type f -name '*.json' | sort | head
```

Expected result:

- Every active `records.sourceStores` entry points to an existing JSON file.
- Its `count`, `bytes`, and `sha256` describe that file.
- The list includes the legacy database, current RxDB collections, and `browserLocalStorage`.
- Authentication/credential local-storage values are represented as redacted records rather than copied into the readable repository.

## 6. Review Unresolved Media

```bash
jq '. | length' indexes/unresolved-media.json
jq '.[0:5]' indexes/unresolved-media.json
```

Unresolved records are explicit and reviewable, but they are not proof of a complete backup. Retry while Venice is open, visit any Studio result that only exists in memory, and verify OPFS access. If an expired URL or already-evicted Blob is the only remaining source, the bytes may no longer be recoverable from the browser.

## 7. Confirm Incremental Behavior

Run a second repository export into the same folder.

Then inspect the latest export manifest:

```bash
latest=$(jq -r '.latestExportId' venice-archive.manifest.json)
jq '.changes, .media, .warnings' "exports/$latest.manifest.json"
```

Expected result:

- `changes.conversationsUnchanged` is populated when generated conversation files did not change
- `changes.filesSkipped` increases for unchanged conversation JSON/Markdown files
- `changes.sourceStoresUnchanged` increases for hash-identical source stores
- Historical local files are not deleted just because a record is absent from the current browser cache

## 8. Browser-Cache Offload Gate

Before deleting Venice site data, require all of the following:

```bash
jq -e '.verification.status == "verified"' venice-archive.manifest.json
jq -e 'length == 0' indexes/unresolved-media.json
```

Then manually spot-check at least one normal chat, one Mind/agent chat if used, one Studio generation of each media type you use, and one uploaded attachment. The extension intentionally does not clear Venice data for you.

## 9. Preserve the Archive

The repository contains readable decrypted conversations and media. Store it in a private folder, encrypted disk, or intentionally trusted sync location. Do not share the folder unless you intend to share the underlying conversations and media.

## Optional Local Fixture Regression

If the May 18 readable archive fixture is present on the local machine, run:

```bash
npm run check:local-artifact
```

This streams the large JSON file and checks the known target conversation/title fallback and embedded attachment payload signals without loading the full archive into memory. The target attachments are raw base64 payloads, so the check does not require MIME strings next to the payloads.
