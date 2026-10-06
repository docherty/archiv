# Shared asset byte store

Standalone extracted assets can reference the **existing** immutable `raw-store/objects/<prefix>/<sha256>` pool. There is no second permanent media pool, hard-link alias or object garbage collector. Original JSON/JSONL source containers remain physical and unchanged.

`asset-store/trees/<id>.json` is an immutable logical path tree, retaining every observed file's SHA/size, original path, provenance and POSIX/native metadata. Historical missing paths are explicit aliases backed by independently verified content. `current.json` atomically publishes a checksum-bound tree; separate receipts record proof/removal progress. Old trees are not overwritten. Same bytes from different origins have **separate metadata**, including distinct resource forks.

## Operations

```sh
npm run assets -- --archive /path/to/archive prepare
npm run assets -- --archive /path/to/archive verify
npm run assets -- --archive /path/to/archive proof --destination /new/private/outside-directory --cleanup
# Only after explicit owner approval and successful native proof:
npm run assets -- --archive /path/to/archive remove
# Independent filesystem view; never restore over an existing directory:
npm run assets -- --archive /path/to/archive restore --destination /new/outside-directory
```

Preparation inventories/hashes all selected files, checks the final source inventory, verifies reused/new objects, preserves metadata and publishes/fsyncs the tree **before** removing anything. Only standalone asset roots, capture OPFS and the explicitly recognised imported OPFS root are selected; arbitrary raw profile files are never assets. New additions/changed sources fail closed or remain untouched. Removal performs a fresh object pass, requires the published tree's matching full native restore receipt, and rechecks each source signature and SHA immediately before individual unlink. Crash/retry is resumable; directories and unknown later files are not recursively deleted.

Each tree pins recovery code and its AGPL license in `asset-store/tools/<digest>/`. Its `asset-store.py` runs with standard-library Python, including macOS system Python 3.9:

```sh
/usr/bin/python3 /path/to/archive/asset-store/tools/<digest>/asset-store.py \
  --archive /path/to/archive restore --tree <tree-id> --destination /new/outside-directory
```

This does not require Venice, a browser, Node, QMD or Global Memory. On a non-macOS host, use `--portable`: restored bytes/POSIX modes/times do not constitute native ACL/xattr/resourcefork restoration; original opaque metadata remains in the archive for later macOS recovery.

## Metadata proof and macOS caveat

Native restore uses **data-only copies**, then applies the particular origin's AppleDouble metadata; copying canonical-object metadata would incorrectly transfer another origin's resource fork/ACL. The proof checks file bytes, file/directory modes and modification times, plus complete native metadata packets.

Real macOS testing found that native `COPYFILE_UNPACK` synthesises quarantine dates/agents/flags. The asset restorer decodes the native `q/<original value> + NUL` packet and reapplies the **original quarantine attribute exactly**. It never clears/removes quarantine or relaxes source protection.

macOS also regenerates the eight-byte ID in its eleven-byte `com.apple.provenance` attribute. The proof permits **only that specific eight-byte field** to differ: attribute name/layout/length/leading flags and every other metadata byte must still match. Each exception records original/restored attribute SHA values; the exact original complete packet remains immutable preservation data. Receipts explicitly say `native-with-recorded-provenance-rebinding`, not exact host-identity recreation. Owner/group, birth/change times and immutable/provider flags are recorded rather than forcibly recreated on a new host, as in raw history.

## Readers and working views

Catalog, media/file/download routes, HEAD/ranges, sidecar normalisation, capture verification and materialisation resolve published logical paths. Old legacy IDs can fall back to their original index associations; display names and MIME come from the logical origin, not an extensionless object filename. Arbitrary `raw-store`/`asset-store` paths, symlinks and traversal are blocked from media routes.

Finder/reveal creates an explicit independent working copy outside the archive rather than exposing an editable canonical object. Existing filesystem-only consumers/static viewers must use a **restored working view**; logical paths are not promised to exist as physical files in the consolidated root. Include the shared pool, trees, receipts and tools when transferring the archive. The earlier duplication auditor measures physical layout; its missing-path check is not a logical-store verification after migration—use the reference-aware verify/restore commands.

New unknown content is preserved by ordinary capture/materialisation. Same-byte materialisation of already referenced content does not recreate duplicate physical assets. **Automatic incremental asset consolidation is not installed**: collecting future new files remains a separately approved prepare/proof/remove operation. A same-disk store or working view is not an independent backup.
