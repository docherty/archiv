# Durable Local Archive Delivery Summary

## Total-Coverage Upgrade — 2026-07-10

- Extension version `0.3.3` and page protocol v12 now inventory every live store across the legacy database, RxDB, and additional origin IndexedDB databases rather than silently skipping unknown collections. The popup also hands the exact active Venice tab to the backup console, avoiding Brave's ambiguous cross-tab script access path.
- Current regular chats from RxDB, agentic/Mind chats, and support conversations are merged into the searchable conversation view while untouched records remain under `stores/`.
- Every discovered source store is written as a lossless JSON array with SHA-256, count, byte size, source metadata, incremental skip, and tombstone behavior.
- Venice OPFS is recursively archived. This covers the current `media/<conversation-id>/`, `attachments/`, thumbnails, Studio input media, and other origin-private files even when IndexedDB contains only an id.
- Message image/video/audio/file attachment collections are correlated with OPFS ids where possible; package mode now includes OPFS and live-captured media too.
- Content-bearing browser state is preserved with authentication tokens, credentials, wallet sessions, and the encryption key redacted from the readable source snapshot.
- Metadata-only media, expired URLs, OPFS failures, and live-capture gaps are explicit. Any unresolved or failed media sets the root manifest status to `incomplete`.
- The generated offline viewer now has a calm maintenance panel: choose a full/diff ZIP, validate its archive id and mode, apply stored entries directly to the same folder when the browser grants folder access, and write the root manifest last with visible progress.
- The current public Venice frontend was inspected during implementation: the legacy database is now Dexie schema version 30 and the RxDB schema contains regular conversations/messages plus multiple attachment/media collections, validating the need for inventory-driven coverage.

Automated result: `npm test` passes with coverage assertions. Account-specific folder export, viewer, incremental timestamp, and cache-clear survival tests still require a Chrome profile with the unpacked extension and the user's Venice data.

Date: 2026-05-18  
Branch: `main`

## Delivered

- Backup-first local archive repository is now the primary product path in the backup console.
- Repository exports use the File System Access API and write `venice-archive.manifest.json`, `conversations/`, `media/`, `exports/`, `indexes/`, `viewer/`, and `logs/`.
- Conversation JSON and Markdown files are generated with stable filenames, Venice `name` title fallback, message record hashes, and local media references.
- Embedded `attachments[].result` payloads and fetchable Venice media are materialized into content-addressed `media/sha256/` files where bytes are available.
- Media indexes distinguish materialized, deduped, unresolved, failed, skipped, and placeholder records instead of counting unavailable placeholders as exported media.
- Root and export manifests include provenance, verification status, write plans, supplemental fingerprints, tombstoned conversations, and retry/resume guidance.
- Generated `viewer/index.html` opens directly from disk and provides conversation search/sort/filter plus a media browser for message and non-message media records.
- Compatibility JSON/HTML/zip downloads remain secondary and now keep failed or canceled save artifacts retryable in memory.
- Restore/live Venice writes remain gated and excluded from the archive workflow.

## Documentation

- Repository format: `docs/DURABLE-LOCAL-ARCHIVE-SPEC.md`
- Implementation checklist: `docs/DURABLE-LOCAL-ARCHIVE-IMPLEMENTATION-PLAN.md`
- Operator verification guide: `docs/VERIFY-LOCAL-ARCHIVE.md`
- User workflow overview: `README.md`

## Checks Run

```bash
npm test
npm run check:release
npm run check:local-artifact
```

The local artifact regression streamed the private fixture selected with `VENICE_ARCHIVE_FIXTURE` and confirmed the target conversation id/name/content plus embedded attachment result payload signals without loading the full archive into memory.

## Remaining Manual Verification

- Load the unpacked extension in Chrome and refresh a Venice tab.
- Create or update a local archive repository through the extension UI.
- Open `viewer/index.html` directly from disk and verify no local server is needed.
- Spot-check the target `My mum has received the attached letter...` conversation and its materialized images.
- Run a second export and confirm unchanged conversation files are skipped while manifests update.
- Simulate a canceled compatibility download and verify Retry Downloads completes it.
- Clear browser extension storage and confirm the repository remains independently usable.
