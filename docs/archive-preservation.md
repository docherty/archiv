# Preservation, not a pile of backups

Archiv's primary job is to preserve captured Venice material for future uses,
including uses its current decoders and search tools cannot anticipate. Global
Memory is one consumer of the archive, not its owner or its definition.

## Three deliberately separate layers

1. **Preservation:** exact raw browser bytes, unknown records, original manifests,
   extracted source records, historical versions, original media, and provenance.
   Older evidence is not removed when it disappears from the newest browser state.
2. **Readable library:** conversations and original/full-resolution media in ordinary
   formats. A useful independent archive should not require today's browser database
   decoder to be understandable. Keep the existing extracted captures and recovery
   material; do not trade them away for the raw store.
3. **Disposable views:** current conversation Markdown, search databases, embeddings,
   thumbnails and Global Memory's redacted exports. These can be rebuilt; they must
   never be the only copy of a conversation or the criterion for pruning evidence.

These are representations, not permission to make a new full backup every update.
A forensic database and its decoded conversation are different byte streams with
useful independent recovery properties. Identical byte streams need one object.

## Raw history: one byte copy, many small references

`raw-store/` is a portable, content-addressed directory, not a proprietary database:

```text
FORMAT.json               version, hash algorithm and policy
objects/ab/abcdef...       original bytes, named by their complete SHA-256
                          (the prefix directory is the first two hash characters)
trees/snapshot-....json    original paths/types, object hashes, sizes and metadata
receipts/snapshot-....json tree checksum, verification and source-removal journal
migrations/               optional migration provenance
```

A tree includes **everything actually found** in a source snapshot, not only the
files listed in its old manifest. The original `snapshot.manifest.json` is also an
object with its exact bytes. Empty directories survive. Files with identical bytes
share one object even when their dates, filenames, permissions or xattrs differ:
those differences belong in each tree's per-path metadata, not in duplicate data.

On macOS, metadata includes POSIX mode/UID/GID/nanosecond timestamps/flags/creation
time and opaque base64 AppleDouble serialization of ACLs, xattrs, FinderInfo and
resource forks. Restore applies native extended metadata, permissions and access/
modification timestamps. Historical ownership, creation/change times and provider/
immutable flags remain recorded, but are not forced onto a new host; in particular
restores never recreate a dataless placeholder flag. This is exact-byte preservation,
not a promise to reproduce filesystem inode identities or OS-bound login sessions.

The SHA-256 object names and JSON trees are enough to recover bytes with any future
language. Python 3.9+ provides the maintained tools; no database, model, network,
Global Memory installation or Venice login is needed to verify or reconstruct them.
A `--portable` restore provides bytes/POSIX metadata on other operating systems;
macOS-specific metadata remains in the tree for native restoration later.

### Safety rules

- Hash every source file, verify original manifest payload checksums, and verify
  destination objects independently. Finder `.DS_Store` discrepancies are recorded
  explicitly, preserving current bytes and original expected hashes; no such
  exception exists for browser databases, media or arbitrary unknown files.
- Publish/fsync the complete tree and checksum receipt before any source unlink.
- Reverify referenced objects at the destructive boundary, then require a matching
  source inventory and each file's identity/size/mtime/ctime immediately before unlink.
- Never recursively delete newly created, unobserved files. Directory-removal races
  stop safely. Interrupted removal is journaled and can be resumed without deleting
  unknown additions. Cloud-metadata races can require private same-volume staging;
  relocation is not payload deletion and its provenance must be retained.
- Never overwrite a committed tree. A later metadata observation can use a separate
  `--identity`; it shares data objects while preserving the earlier observation.
- Reject unsupported file types/symlinks rather than silently dropping them.
- Objects have no automatic garbage collection. A decoder's success is not proof
  that unknown source records are disposable.
- Restore into a new isolated folder using native clones or independent copies,
  **never hard links**, and never into the immutable store or an existing profile.

## Future updates

Normal CLI and local-app updates use a private working snapshot outside a sync
provider, native clone-required copying on macOS, and a five-GiB free-space reserve.
Raw history is committed **before decoding starts**, so unknown schemas and hard
process deadlines cannot erase a complete captured source. Capture success is a
separate journal entry; it does not mutate or duplicate the raw path tree.
A successful sync must persist its raw history before publishing the successful
source checkpoint. One verified working snapshot remains for cheap change/hash
reuse; superseded working copies are removed only through verified raw persistence.
That working clone is a cache, **not a backup**. Failed/unconfirmed extraction copies
are persisted independently even when decoding fails; their working copy is
removed only after successful lossless persistence. If persistence also fails, the
working copy stays available and neither failure is hidden.

A standalone `snapshot` writes permanent raw history and removes its verified
working reconstruction. `extract --snapshot latest` can reconstruct the latest
complete archived source temporarily and clean up that reconstruction afterward.
Incomplete historical copies remain preserved and explicitly labelled incomplete;
they are not chosen as a known-consistent latest source.

The cumulative Markdown exporter overlays legacy indexes and **every verified
capture delta**, oldest to newest, by `(conversationId, messageId)`. An empty newest
capture cannot erase history. This is a derived historical-union view; original
message revisions remain in untouched captures/raw history.

## Verification and recovery

```sh
npm run archive -- history --archive /path/to/archive
npm run archive -- verify-history --archive /path/to/archive
npm run archive -- restore-snapshot --archive /path/to/archive \
  --snapshot snapshot-YYYY-MM-DDTHH-MM-SS-mmmZ --destination /path/to/new-folder
```

For cross-platform byte recovery, add `--portable`. Direct tooling also supports:

```sh
python3 scripts/raw-store.py --store /path/to/archive/raw-store verify
python3 scripts/raw-store.py --store /path/to/archive/raw-store restore \
  --snapshot snapshot-YYYY-MM-DDTHH-MM-SS-mmmZ \
  --destination /path/to/new-folder --portable
```

Verification must be supplemented by occasional real restore tests. Migrating an
old archive requires explicit permission for source removal; `ingest` without
`--remove-source` is nondestructive. Never equate a `du` estimate to reclaimed space:
measure actual free-space change, accounting for clones, cloud hydration and other
concurrent activity.

## One real backup, not sixty same-disk replicas

Keep one canonical archive. Optionally keep **one independently recoverable backup**
on another encrypted device or a versioned backup system, updated incrementally.
Back up the **whole archive**, including raw objects, trees/receipts and extracted/
readable material. Multiple snapshot manifests share the same objects; they are
history, not redundant full backups. Object corruption can affect many dates, which
is why a true independent backup and integrity/restore checks matter.

Dropbox sync and a local APFS clone are not automatically independent backups:
sync can propagate deletion/corruption, while clones share one disk's failure domain.
No extra backup destination is provisioned without choosing it with the owner.
The archive is sensitive: raw browser state can retain credentials and private data.
Keep owner-private access and encryption; never commit or publish archive contents.

## Honest limits and follow-up

This preserves what has actually been captured locally. It does not prove complete
coverage of an entire remote Venice account, items never loaded into the browser,
or media that were already missing before capture. OS-bound browser encryption may
need the original host/keychain; readable extracted records and media reduce that
risk. Older data already absent before this migration cannot be recreated by dedup.

Existing decoded media/capture copies have not been deleted or globally reorganized.
A future exact-byte inventory can identify duplication there and introduce one
canonical asset store with explicit references/compatible readers. Do not infer
that same message IDs, filenames or lower-resolution previews mean identical media.
Chunks inside changing LevelDB files may still repeat: whole-file SHA dedup does not
pretend to be record/chunk-level dedup. Add such optimization only with separately
verified reconstruction and a demonstrated need, not a lossy latest-only shortcut.
