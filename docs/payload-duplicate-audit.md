# Read-only extracted-payload duplicate audit

```sh
npm run audit:duplicates -- --archive /path/to/archive \
  --output /private/reports/new-audit.json --deadline-seconds 300
```

Requires POSIX Python 3.9+. The output must be a **new file outside the archive**.
It is published owner-private (0600); it contains sensitive paths and must not be
committed, uploaded, or treated as a public diagnostic. Source files, indexes,
verification documents and raw objects are never rewritten by this command.

This audits the **physical layout**, not the logical asset store after consolidation. Missing original paths can be expected in a consolidated archive, so its `complete` flag is not the migration integrity gate. Use the [shared-store verification and restore-proof commands](shared-asset-store.md) instead.

## What it measures

- Full SHA-256 and size of every regular file in captures, imported/media layers,
  materialized/recovered media/content, source stores, conversations, indexes,
  exports, search and viewer artifacts, plus the root manifest.
- Whole-file exact-byte duplicates, including files from incomplete captures.
  Identity is never inferred from IDs, filenames, thumbnails, extensions, sizes
  alone or sampled edges. Different historical versions remain distinct.
- Already-existing raw objects with matching hashes are **independently read and
  hashed**, not trusted by their filenames. This identifies opportunities for one
  shared immutable object pool instead of duplicating it in a second asset pool.
- Existing checksum-bearing capture/media/source-store declarations are checked.
  Missing declared paths remain errors, with explicit exact-byte recovery candidates
  where available. A hash alternative does not pretend the original path exists.
- Input identity/size/mtime/ctime/mode/flags before and after streaming reads, and a
  final source inventory, detect replaced files and concurrent changes.

Symlinks and special files are refused, including symlinked ancestors when opening
payloads. SHA hashing is streamed in bounded chunks. Deadlines are positive/finite
and checked during inventory/hashing; an interrupted/partial audit cannot publish a
clean result. Progress prints counts/timing only, never source contents.

## Result semantics

- `inventoryComplete`: all observed files were hashed and the inventory stayed stable.
- `manifestValidationPassed`: declared references/checksums validated directly.
- `rawPoolComparisonPassed`: matching raw-object comparisons passed; **not** a new
  verification of every object or historical raw tree.
- `complete`: all of the above operation's checks passed without errors.
- Exit **0** means clean; exit **1** means incomplete/failed validation even if the
  byte inventory is useful. Exit **2** rejects invalid arguments/output destinations.

`repeatedLogicalBytes` is repeated **data-stream length**, not measured free space.
Inode/link and allocated-block accounting are reported separately. APFS clones,
compression and provider hydration prevent interpreting these counters as guaranteed
reclaim. No file removal occurs, so no actual space recovery is claimed.

The inventory does not capture full ACL/xattr/resourcefork metadata, decode embedded
base64 media, prove remote-account completeness, or preserve record/chunk identity.
It is **not a preservation tree, removal receipt, or deletion authorization**.

## Migration prerequisites

A later consolidation needs immutable per-path metadata/provenance and original
manifests, compatible readers/writers/download/range/export/restore support, exact
object verification before unlink, a stable source check, and interruption recovery.
Repair or resolve stale paths/IDs before removal; preserve association and historical
version metadata independently of content identity. Never substitute hard links or
mutable aliases to canonical objects for these guarantees.

Prefer one existing/shared SHA-256 pool if exact overlap is verified. Do not make
another permanent asset pool containing bytes already stored in raw history. Start
with standalone assets; source JSON/JSONL/container records require separate reader
coverage and should not be rewritten merely to save their embedded media bytes.
