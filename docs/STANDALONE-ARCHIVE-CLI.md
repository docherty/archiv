# Standalone Venice Archive CLI

The standalone CLI removes archive construction and persistence from the browser extension. It uses two layers:

1. A byte-for-byte safety snapshot of the Venice-related Brave profile storage.
2. A controlled, isolated Brave session that reads IndexedDB and OPFS through Chromium's supported web APIs and writes a lossless capture to the local archive.

It never parses or mutates a live LevelDB database. The safest mode requires Brave to be fully quit. In `--allow-running` mode, the first copy is checked with a short final pass; when Brave rewrites a journal or filesystem record in the background, Archiv reconciles only that delta and repeats the check. A live snapshot is accepted only after the copied IndexedDB, OPFS and browser-storage files exactly match a source inventory that stayed still for the whole final pass. No journal is simply ignored. If Archiv cannot obtain that quiet window after six passes, the incomplete snapshot is removed and the command asks for Brave to be fully closed.

## Current workflow

```sh
npm run archive -- discover --browser brave
npm run archive -- init --archive "/path/to/Venice Archive" --browser brave --profile "Work"
npm run archive -- import --archive "/path/to/Venice Archive" --zip "/path/to/venice-local-archive-full.zip"
npm run archive -- index --archive "/path/to/Venice Archive"
npm run archive -- search --archive "/path/to/Venice Archive" "meeting transcript"
npm run archive -- serve --archive "/path/to/Venice Archive"
npm run archive -- verify-capture --archive "/path/to/Venice Archive" --capture latest
```

After quitting Brave, create a verified raw snapshot:

```sh
npm run archive -- snapshot --archive "/path/to/Venice Archive"
```

Or create a snapshot and then extract every discovered source store and OPFS file through an isolated headless Brave session:

```sh
npm run archive -- sync --archive "/path/to/Venice Archive"
```

If extraction needs to be retried after a successful snapshot, reuse it without copying the browser profile again:

```sh
npm run archive -- extract --archive "/path/to/Venice Archive" --snapshot latest
```

To attempt the consistency-gated live mode while leaving Brave open:

```sh
npm run archive -- sync --archive "/path/to/Venice Archive" --allow-running
```

New raw history lives in `raw-store/objects/` with immutable dated path/metadata trees and checksum receipts. `raw-snapshots/` contains legacy copies, which are not automatically migrated or deleted. Controlled captures live under `captures/` and are normalized/indexed after acquisition. Search queries captures and the imported readable repository, removing duplicate results. See [preservation and recovery](archive-preservation.md).

### Managed working cache

Normal CLI/library sync keeps one managed working snapshot in the account's private cache outside the archive. Raw history is committed before decoding. Override its location or retention explicitly:

```sh
npm run archive -- sync --archive "/path/to/Venice Archive" --allow-running \
  --snapshot-directory "/private/local/venice-snapshots" --snapshot-retain 1 --require-clone
```

The managed cache requires at least five GiB of free disk space before copying. macOS uses native `cp -c` clones: Node's best-effort FICLONE option silently makes full copies there. `--require-clone` refuses a full-copy fallback. Cache permissions are owner-only; paths overlapping the live browser data are rejected, including symlink aliases. A live journal rotation is reconciled, never accepted as a complete snapshot without a quiet matching inventory.

Superseded stable managed working copies are removed only through checksum-verified raw-history persistence; their historical bytes and metadata remain in the store. The default retained working count is one. Incomplete or unpreserved sources stay available for recovery. Historical `raw-snapshots/` are not automatically pruned. `snapshot` persists raw history and removes its working reconstruction; `extract --snapshot latest` uses a legacy snapshot when present, otherwise reconstructs the latest complete archived raw source. Use an explicit path to retry a particular retained working snapshot.

A failed copy is removed with bounded retries. If cleanup itself fails (e.g. synced metadata recreates a directory), the original capture error is retained alongside the cleanup warning rather than replaced by `ENOTEMPTY`. Extraction setup failures also clean their disposable browser workspace.

The `serve` command starts a private archive library on `127.0.0.1:43110`. It does not listen on the network and serves files only from the configured archive and its capture directories. The library includes complete conversation transcripts with inline attachments, clickable full-text search, a filterable media gallery, a full-screen keyboard-navigable viewer and archive-status details. Open **Sync archive**, then choose **Fetch new content** to run the same consistency-gated sync as the CLI, follow its progress and see exact counts for new images, video, audio, files, conversations and messages.

The normal ongoing workflow is therefore:

1. Start the local library with `npm run archive -- serve --archive "/path/to/Venice Archive" --allow-running`.
2. Browse and search the already archived material at `http://127.0.0.1:43110/`.
3. Open **Sync archive** and choose **Fetch new content** whenever you want to bring the local archive up to date. Avoid using Venice until it completes. Background browser bookkeeping is reconciled in short passes; continuous storage changes still reject the sync instead of accepting an inconsistent backup.

After changing the service code, stop the running process and start it again; the interface and API are served by that process.

### Opt-in shared assets and maintenance

Existing standalone media/OPFS files are not silently converted. Stop any running library process and follow the [shared asset migration and restore-proof procedure](shared-asset-store.md) before enabling maintenance. After conversion, media paths are logical references into the existing raw byte pool; direct filesystem/static-viewer consumers need an explicit restored working view. Do not combine legacy extension diff packages with a consolidated root without first restoring/validating the intended working layout.

```sh
# Read-only preview of previously processed embedded-media stores:
npm run archive -- materialize-media --archive /path/to/archive --reprocess --dry-run
# Enable only after an explicitly approved prepare/proof/remove baseline:
npm run assets -- --archive /path/to/archive maintain --enable
```

Enabled maintenance runs on sync (including no-op checks), materialisation and library startup. New payloads get separate native delta restore proofs before individual unlink; unchanged checks publish no new metadata generation. Pending/deadline/oversized-file failures remain visible and retain originals. See the linked guide for limits, retry and checkpoint requirements. Python 3.9+ on POSIX is required; Windows capture/restore needs a backend port.

## Safety properties

- `snapshot` and CLI `sync` refuse a running browser by default. `--allow-running` and the local app use bounded, exact-match reconciliation and fail closed if they cannot obtain a quiet storage window.
- Copies only into the configured archive and isolated work directories.
- Hashes every raw snapshot file and writes `snapshot.manifest.json`.
- Validates ZIP paths before extraction.
- Verifies imported archive manifests and content hashes.
- Keeps an incomplete imported package searchable while clearly withholding verified-backup status; a failed package can seed search but cannot authorize browser-data deletion.
- Uses paged store reads and chunked OPFS reads instead of constructing multi-gigabyte strings.
- Hashes every controlled store and OPFS file, checks store line counts against the Venice inventory, and checks every OPFS byte count against the source index.
- Never enables write operations in the injected Venice acquisition code.

## Present boundary

`sync` produces a complete lossless capture of source stores and OPFS plus normalized conversation, message, and media indexes for search. The lossless store files remain the source of truth when Venice introduces a schema that the normalizer does not yet recognize.
