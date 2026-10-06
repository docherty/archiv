# Changelog

Notable changes to Archiv's public code and archive workflows. This file starts
with the storage changes below; it is not a complete retrospective release history.

## Unreleased

### Added

- Content-addressed raw history: one SHA-256 object pool, immutable dated path trees,
  per-origin filesystem metadata and checksummed receipts. Raw browser history is
  persisted before decoding, including records the current decoder cannot interpret.
- `history`, `verify-history` and `restore-snapshot` CLI commands for independent
  inspection and recovery; portable POSIX recovery retains opaque macOS metadata
  for later native restoration.
- A read-only, full-checksum physical-payload duplicate auditor with bounded
  deadlines and private reports. It never deletes files or authorizes migration.
- Opt-in shared assets using the existing raw object pool. Prepare, verify, native
  restore proof, remove and independent restore operations preserve original logical
  paths and per-origin metadata, including independently verified historical aliases.
- Opt-in bounded asset maintenance after baseline migration, including delta-only
  metadata generations, per-batch restore proofs, resumable removal and visible
  attention states when bounds are exceeded.

### Changed

- Sync uses a private managed working cache outside the archive, with one retained
  working snapshot by default. macOS copying requires native clones; history remains
  in the raw store rather than accumulating full browser copies in `raw-snapshots/`.
- Unchanged checkpoints and capture comparisons avoid repeated full decoding.
  Enabled asset maintenance still runs on unchanged checks, materialisation and
  library startup; a no-op asset pass publishes no new generation.
- Catalog, verification and media/download/range routes resolve logical shared-asset
  paths. Filename, MIME type and provenance remain those of the logical origin.
  Finder/reveal produces an independent working copy, not an editable shared object.
- Embedded-media processing preserves changed historical versions instead of
  skipping every later record with the same ID. `materialize-media --reprocess
  --dry-run` previews previously processed stores without applying changes.

### Compatibility and migration

- Node.js 18+ and POSIX Python 3.9+ are required for the storage backend. macOS is
  the tested native-metadata platform; Linux needs more field testing. Windows
  discovery paths do not imply Windows capture/restore support.
- Legacy raw snapshots and standalone assets are **not automatically migrated**.
  Stop Archiv writers, review an independent backup, then follow
  [raw preservation](docs/archive-preservation.md) and the explicit
  [shared-asset migration procedure](docs/shared-asset-store.md).
- Asset source removal requires a matching native restore proof. Automatic
  maintenance is disabled until explicitly enabled after baseline consolidation.
  Source JSON/JSONL containers and historical raw trees are not pruned or rewritten;
  the object pool has no automatic garbage collector.
- After asset removal, original media paths are logical references, not necessarily
  physical files. Filesystem-only consumers and static viewers need a restored
  working layout, including their corresponding indexes/viewer files. Do not apply
  legacy extension incremental ZIPs directly to a consolidated root without
  validating/restoring that layout.
- Back up and transfer the **whole archive**, including shared objects, trees,
  receipts and pinned recovery tools. A working clone, deduplicated store or same-disk
  restore is not an independent backup; checksums do not prove remote completeness.

See the [verification guide](docs/VERIFY-LOCAL-ARCHIVE.md) for layer-specific checks,
real restore tests and the distinct legacy-extension workflow.
