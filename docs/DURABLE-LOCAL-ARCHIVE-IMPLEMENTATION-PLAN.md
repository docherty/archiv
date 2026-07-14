# Durable Local Archive Implementation Plan

Status: in progress  
Created: 2026-05-18  
Canonical progress file: yes

This file is the working checklist for re-architecting Venice History Sync into a durable local archive repository. Keep it current as implementation progresses: check off items when they are complete, update status notes when scope changes, and keep code, tests, and documentation aligned in the same change set.

## Operating Constraints

- The primary product must remain browser-only and extension-driven.
- Do not require a local server for the normal archive or viewer workflow.
- If a local server ever becomes necessary as a fallback, document exactly why and keep the file-based path as the default.
- Restore and live writes to Venice remain out of scope for this phase.
- The local repository on disk is the canonical backup artifact; JSON, HTML, and zip downloads are compatibility outputs.
- Readable archives contain sensitive decrypted content and must be treated as private local data.

## Baseline Notes

- Current branch at implementation start: `main`.
- Existing modified files recorded before this plan was created: `.DS_Store`, `README.md`, `extension/backup.js`, `extension/content-bridge.js`, and `extension/content-main.js`.
- Do not revert or overwrite unrelated existing changes while implementing this plan.
- Baseline automated checks passed at implementation start: `npm test` and `npm run check:release` both reported `release-checks: ok`.

## Product Goal

Build the extension into a high-trust local archive tool that can create and incrementally update a durable Venice archive repository on disk. The repository should survive browser cache loss, be inspectable without Venice or extension storage, expose flat files for LLM workflows, and include a polished local viewer that opens from files by default.

## Progress Checklist

### Phase 0: Baseline, Safety, and Git Hygiene

- [x] Create `docs/DURABLE-LOCAL-ARCHIVE-IMPLEMENTATION-PLAN.md` as the repo-tracked standalone progress checklist.
- [x] Check `git status --short` before editing and record unrelated existing changes.
- [x] Confirm current branch context and keep the work commit-ready without creating commits unless explicitly requested.
- [x] Run `npm test` before large implementation edits to establish baseline release-check status.
- [x] Run `npm run check:release` before large implementation edits to establish baseline release-check status.
- [x] Preserve existing safety posture: write operations disabled, restore gates disabled, and no Venice cache mutation introduced.
- [x] Confirm the no-local-server constraint in product docs and UI copy.

### Phase 1: Repository Contract and File Layout

- [x] Define the local archive repository root contract in documentation before coding the writer.
- [x] Use `venice-archive.manifest.json` as the canonical repository root marker.
- [x] Define root manifest fields: schema version, archive id, created/updated timestamps, source metadata, extension version, protocol version, latest export id, and verification status.
- [x] Define durable directories: `conversations/`, `media/`, `exports/`, `indexes/`, `viewer/`, and `logs/`.
- [x] Define one-file-per-conversation JSON artifacts as the primary LLM-friendly unit.
- [x] Define per-conversation Markdown artifacts for human reading and LLM ingestion.
- [x] Include immutable Venice ids in filenames so title changes do not break references.
- [x] Define append/update semantics: unchanged records remain untouched, changed conversations are rewritten atomically, and new media is content-addressed and deduped.
- [x] Define per-export manifests under `exports/` with source DB version, store inventory, counts, hashes, changed records, media counts, warnings, and verification status.
- [x] Define media records with local path, content hash, MIME type, byte size, source store, source ids, original URL if available, and extraction status.
- [x] Define viewer/search indexes: conversation summary index, message search index, media index, and unresolved media report.

### Phase 2: Export Pipeline Refactor

- [x] Add browser-compatible repository utility foundations for schema constants, safe artifact paths, canonical JSON, root manifest validation, and conversation title fallback.
- [x] In `extension/backup.js`, split one-shot archive orchestration from repository-writing orchestration while reusing bounded store fetches.
- [x] Add a repository writer abstraction for staged text, JSON, Markdown, index, manifest, and binary media writes.
- [x] Write staged data first and commit root/export manifests last so interrupted exports do not appear complete.
- [x] Keep `buildArchiveJsonBlob()` and zip generation as compatibility outputs.
- [x] Make durable repository creation/update the primary export path in the backup console.
- [x] Ensure `loadArchivePayload()` still verifies store counts, DB version stability, partial stores, and byte-bounded paging before repository writes are committed.
- [x] Add a dry-run planning pass that reports added, changed, skipped, unresolved, and failed records before final write where feasible.
- [x] Add retry behavior for canceled compatibility downloads.
- [x] Add retry/resume behavior for interrupted local write steps where feasible.

### Phase 3: Incremental Change Detection

- [x] Skip rewriting unchanged conversation JSON and Markdown files by comparing staged content to existing repository files.
- [x] Record changed versus unchanged conversation counts and skipped file counts in export manifests.
- [x] Build stable fingerprints for conversations and messages using canonical JSON serialization.
- [x] Build stable fingerprints for settings, studio records, and unresolved media candidates using canonical JSON serialization.
- [x] Compare current Venice conversations against the root manifest and prior export manifests.
- [x] Append new conversation records, update changed records, and leave unchanged conversation JSON/Markdown files untouched.
- [x] Treat conversations missing from the current Venice cache as historical/tombstoned rather than deleting local archive data.
- [x] Abort incremental commits if source store counts or DB version change mid-export.
- [x] Add repository schema migration detection for older local archive repositories.
- [x] Store enough conversation/message provenance to rebuild indexes from flat files even if Chrome extension storage is wiped.

### Phase 4: Conversations, Titles, and LLM-Friendly Outputs

- [x] Fix conversation title resolution to prefer `name`, then `title`, generated labels, first message text, and finally `Untitled conversation`.
- [x] Write normalized per-conversation JSON with metadata, message ids, local media references, Venice ids, timestamps, and model metadata where available.
- [x] Write per-conversation Markdown with roles, timestamps, message text, attachment references, and media file paths.
- [x] Optionally write repository-level JSONL streams for conversations and messages.
- [x] Ensure filenames are stable, macOS-safe, and resilient to title edits.
- [x] Avoid duplicating huge inline media payloads once media is materialized as files.

### Phase 5: Media Completeness and Durability

- [x] Materialize message attachments stored in `attachments[].result`, including the known conversation `1g8W9AY` case.
- [x] Continue materializing actionable `messageImages` records.
- [x] Do not count placeholder media records with no bytes and no real media URL as exported media.
- [x] Include studio image/audio/video assets when bytes or fetchable media URLs exist.
- [x] Record encrypted or metadata-only studio records as unresolved with clear reasons.
- [x] Fetch live Venice media through the existing chunked `FETCH_MEDIA_RESOURCE` path with size limits, progress, retry, and explicit failures.
- [x] Deduplicate embedded attachment media by content hash while preserving source references in the media index.
- [x] Embed local media references for materialized attachments into conversation outputs.
- [x] Record checksums and byte sizes for materialized attachment media files.
- [x] Deduplicate live-fetched Venice media by content hash across exports while preserving all source references in the media index.
- [x] Embed local media references for message-linked live-fetched Venice media into conversation outputs.
- [x] Record and verify checksums and byte sizes for every live-fetched materialized media file.
- [x] Embed local media references for non-message studio/library media into the viewer detail surfaces.

### Phase 6: Local Viewer and Gallery UX

- [x] Rebuild the viewer to consume `venice-archive.manifest.json` and repository indexes instead of only a single embedded HTML data blob.
- [x] Keep the normal viewer path file-based and no-server.
- [x] Use browser-supported file selection or bundled static data where needed.
- [x] Document that the normal archive viewer path does not require a local server; no fallback is required for generated self-contained viewer data.
- [x] Provide a dense conversation list, fast search, readable message pane, inline media links, and archive health/status.
- [x] Add advanced filters and sort controls to the repository viewer.
- [x] Add empty and error states for no conversation matches, no media matches, no media selection, unresolved media, canceled file access, and partial exports.
- [x] Redesign media detail with a generous preview area, separate metadata panel, video/audio playback where supported, and direct local-file references.
- [x] Use restrained, utilitarian archive UI with stable dimensions, accessible contrast, and predictable controls.
- [x] Ensure text fits across mobile and desktop viewports without overlap or viewport-scaled fonts.
- [x] Keep flat files useful even if the viewer cannot run because of browser restrictions.

### Phase 7: Extension UI Workflow

- [x] Update `extension/backup.html` so `Create or update local archive repository` is the primary action.
- [x] Show selected repository root, last successful export, changed records, and media written.
- [x] Show unresolved items and manifest health persistently in the backup console.
- [x] Keep archive and zip downloads as secondary compatibility actions.
- [x] Add phase progress for inventory, store reads, change detection, conversation writes, media writes, index rebuild, manifest commit, and verification.
- [x] Add clear privacy warnings for readable local archives.
- [x] Ensure no restore/write UI is promoted as part of the archive workflow.

### Phase 8: Background State and Persistence

- [x] In `extension/background.js`, store only lightweight repository history: export summaries and last verification state.
- [x] Do not store large manifests or media indexes in `chrome.storage.local`.
- [x] Make extension state recoverable from the repository manifest after browser storage loss.
- [x] Preserve sender validation, protocol version checks, and stale receiver handling.

### Phase 9: Documentation and Operator Experience

- [x] Update `README.md` with the new product definition: private local Venice archive repository, incremental updates, no local server by default, and restore gated.
- [x] Update `docs/TECHNICAL-BRIEF.md` with repository schema, File System Access assumptions, integrity model, and threat model.
- [x] Update `docs/DEVELOPMENT-PLAN.md` to point to this checklist as the canonical implementation plan.
- [x] Add user-facing backup verification instructions: inspect manifest, open viewer, spot-check conversations/media, run `jq` examples, and preserve the repository folder.
- [x] Document privacy guidance for decrypted local archives.
- [x] Document optional compatibility artifacts: readable JSON, HTML guide, and media zip.

### Phase 10: Automated Tests and Release Checks

- [x] Add tests for canonical JSON/fingerprint input.
- [x] Add tests for filename slugging and conversation artifact paths.
- [x] Add tests for root manifest validation.
- [x] Add tests for title fallback.
- [x] Add tests for migration detection.
- [x] Add tests for media classification.
- [x] Add fixtures for base64 `attachments[].result` and metadata-only media placeholders.
- [x] Test incremental behavior: stable conversation paths, tombstoned prior records, and unchanged file skip primitives.
- [x] Extend `tests/release-checks.mjs` to keep safety gates, durable archive docs, no-server posture, and primary repository UI enforced.
- [x] Run `npm test` after implementation changes.
- [x] Run `npm run check:release` after implementation changes.
- [x] Use targeted local artifact regression checks against the private fixture selected with `VENICE_ARCHIVE_FIXTURE`, without loading the full file into memory.

### Phase 10B: Total-Coverage Upgrade (2026-07-10)

- [x] Audit the current Venice public frontend rather than relying on the historical v210 notes; confirm the shipped legacy schema is Dexie version 30.
- [x] Discover and export unknown legacy IndexedDB stores instead of limiting backup to a hardcoded request list.
- [x] Discover every highest-version RxDB collection and preserve unknown future collections under stable `rxdb:` logical names.
- [x] Merge current RxDB regular conversations/messages into the searchable conversation view, with current records winning over legacy copies by id.
- [x] Include OPFS-backed message image/video/audio/file attachment metadata and correlate file ids where possible.
- [x] Recursively inventory and chunk-export every Venice OPFS file, including `media/<conversation>/attachments/`, thumbnails, Mind assets, and Studio input media.
- [x] Write lossless source-store JSON files under `stores/` with SHA-256, byte counts, record counts, paths, and tombstone semantics.
- [x] Capture recoverable local-storage state while redacting credentials and key material; include a source fingerprint in drift checks.
- [x] Include `textSettings`, `imageSettings`, support conversations, pinned-message metadata, and `studioVideoSessions` in known projections.
- [x] Include live-captured media in both directory and package repository modes and surface capture failures as unresolved records.
- [x] Scan already-mounted `blob:` media and capture compressed Studio images regardless of the former 1.5 MB threshold.
- [x] Mark the root manifest `incomplete` whenever media is unresolved or failed so users cannot mistake a partial media backup for a cache-offload-safe archive.
- [x] Bump the page protocol whenever the source-coverage contract changes so stale injected scripts cannot pass readiness checks.
- [x] Add forward-coverage tests and release assertions for unknown stores, source-store tombstones, OPFS commands, and metadata-only attachments.
- [x] Enumerate additional origin IndexedDB databases/stores and include `video-studio-recovery/activeGenerations` in Studio projections.
- [x] Fingerprint the exact initial snapshot of every legacy, RxDB, additional IndexedDB, and local-storage source, then compare a fresh closing inventory including the full store-name set.
- [x] Preserve every physical RxDB object store as raw source data alongside decoded/searchable collection projections, including attachment, write-ahead, internal, and migration stores.
- [x] Inventory session storage as a separate source while redacting session/authentication/telemetry identifiers.
- [x] Replace whole-store JSON fingerprinting and whole-Blob SHA/ZIP reads with bounded record/stream processing for large message archives.
- [x] Bump the page protocol to v12 and extension version to 0.3.3 so the origin-wide database coverage contract, exact-tab handoff, and Brave access fixes cannot be confused with earlier builds.

### Phase 11: Manual Verification Without a Local Server

- [ ] Load the unpacked extension in Chrome and refresh a Venice tab.
- [ ] Create a new local archive repository through the extension UI using a chosen folder.
- [ ] Open the generated viewer directly from disk.
- [ ] Verify the target conversation beginning `My mum has received the attached letter...` has the correct title and both attached images inline.
- [ ] Verify media counts separate materialized, unresolved, skipped, and placeholder records.
- [ ] Run a second export and confirm incremental writes in the manifest and file timestamps.
- [ ] Simulate canceled download/save behavior for compatibility artifacts and confirm retry works.
- [ ] Confirm the archive still works after browser extension storage is cleared.

### Phase 12: Final Git and Delivery Pass

- [x] Run `git diff --stat` and inspect the diff for accidental unrelated changes.
- [x] Run `git status --short` and ensure generated local archive artifacts are outside the repo or ignored.
- [x] Confirm documentation and code agree on repository schema names, UI labels, and verification commands.
- [x] Run final automated checks and record any known limitations.
- [x] Prepare a final implementation summary with changed files, checks run, and remaining follow-up items.

## Current Decisions

- [x] Durable local backup repository is the primary product direction.
- [x] No local server is required for the default path.
- [x] Restore/write-back is excluded and remains gated for this phase.
- [x] The repository on disk is the source of truth, not extension storage.
- [x] The UX target is a high-trust archive workflow with excellent progress, recovery, accessibility, and local-file transparency.

## Verification Status

- [x] `npm test`
- [x] `npm run check:release`
- [x] `npm run check:local-artifact`
- [x] Current Venice frontend storage audit (public shipped assets, 2026-07-10)
- [x] OPFS/source-store/RxDB automated regression checks
- [ ] Manual Chrome extension export to repository
- [ ] File-based viewer opens without a server
- [ ] Incremental second export preserves unchanged files
- [ ] Repository remains usable after browser storage loss

## Known Limitations / Manual Verification Remaining

- Manual Chrome extension export is still pending because it requires an unpacked-extension Chrome session and a shared Venice tab.
- File-based viewer verification, second-export timestamp checks, canceled save-dialog retry checks, and browser-storage-loss checks must be completed in that Chrome session.
- Restore/write-back remains intentionally gated and outside this archive-first delivery phase.
