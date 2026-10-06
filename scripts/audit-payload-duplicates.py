#!/usr/bin/env python3
"""Read-only exact-file SHA-256 audit of extracted/readable archival payloads.

The private report is an inventory, NOT a migration or permission to remove files.
No hashes from filenames/manifests, previews, IDs, or sampled edges are trusted.
Requires POSIX Python 3.9+; source paths are never followed through symlinks.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
import math

ROOTS = ('captures', 'media', 'materialized-media', 'recovered-media',
         'recovered-content', 'stores', 'conversations', 'indexes', 'exports',
         'search', 'viewer')
CHUNK = 4 * 1024 * 1024


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns, getattr(info, 'st_flags', 0))


def under(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def category(relative):
    parts = Path(relative).parts
    if parts[-1] == '.DS_Store' or parts[-1].startswith('._'):
        return 'filesystem-metadata'
    if (parts[0] == 'captures' and len(parts) > 3 and parts[2] == 'opfs'
            or parts[0] == 'media' and len(parts) > 1 and parts[1] == 'sha256'
            or parts[0] in ('materialized-media', 'recovered-media', 'recovered-content')
            and len(parts) > 1 and parts[1] == 'media'):
        return 'standalone-asset'
    if parts[0] == 'stores' or parts[0] == 'captures' and len(parts) > 2 and parts[2] == 'stores':
        return 'extracted-source'
    return 'derived-or-metadata'


def walk(root, errors, deadline=float('inf')):
    found = {}
    missing = []

    def visit(directory):
        try:
            with os.scandir(directory) as entries:
                items = sorted(entries, key=lambda item: item.name)
            for entry in items:
                if time.monotonic() > deadline:
                    raise TimeoutError('Inventory deadline exceeded')
                relative = str(Path(entry.path).relative_to(root))
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode):
                    errors.append({'path': relative, 'reason': 'symlink-refused'})
                elif stat.S_ISDIR(info.st_mode):
                    visit(Path(entry.path))
                elif stat.S_ISREG(info.st_mode):
                    found[relative] = info
                else:
                    errors.append({'path': relative, 'reason': 'unsupported-file-type'})
        except OSError as error:
            errors.append({'path': str(directory.relative_to(root)), 'reason': type(error).__name__})

    for name in ROOTS:
        directory = root / name
        try:
            info = directory.lstat()
        except FileNotFoundError:
            missing.append(name)
            continue
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            errors.append({'path': name, 'reason': 'root-is-not-a-real-directory'})
        else:
            visit(directory)
    return found, missing


def open_beneath(root, relative):
    parts = Path(relative).parts
    if not parts or Path(relative).is_absolute() or any(part in ('..', '.') for part in parts):
        raise ValueError('Unsafe relative path')
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        return os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally:
        os.close(directory)


def hash_file(root, relative, expected, deadline):
    descriptor = open_beneath(root, relative)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or identity(before) != identity(expected):
            raise ValueError('File identity changed before hashing')
        digest = hashlib.sha256()
        count = 0
        while True:
            if time.monotonic() > deadline:
                raise TimeoutError('Audit deadline exceeded')
            chunk = os.read(descriptor, CHUNK)
            if not chunk:
                break
            count += len(chunk)
            digest.update(chunk)
        if count != before.st_size or identity(os.fstat(descriptor)) != identity(before):
            raise ValueError('File changed while hashing')
        # Catch replacement/renaming of the path even while its old FD stayed readable.
        current = open_beneath(root, relative)
        try:
            if identity(os.fstat(current)) != identity(before):
                raise ValueError('Path changed while hashing')
        finally:
            os.close(current)
        return digest.hexdigest()
    finally:
        os.close(descriptor)


def summary(files, raw_matches):
    by_hash = {}
    inodes = {}
    for item in files:
        by_hash.setdefault(item['sha256'], []).append(item)
        inodes[(item['device'], item['inode'])] = item
    unique = sum(items[0]['bytes'] for items in by_hash.values())
    total = sum(item['bytes'] for item in files)
    raw_bytes = sum(items[0]['bytes'] for digest, items in by_hash.items() if digest in raw_matches)
    return {
        'files': len(files), 'distinctInodes': len(inodes), 'distinctContents': len(by_hash),
        'logicalBytes': total, 'uniqueContentBytes': unique,
        'repeatedLogicalBytes': total - unique,
        'distinctInodeAllocatedBytes': sum(item['allocatedBytes'] for item in inodes.values()),
        'duplicateGroups': sum(len(items) > 1 for items in by_hash.values()),
        'duplicateEmptyFiles': sum(len(items) - 1 for items in by_hash.values() if items[0]['bytes'] == 0),
        'alreadyInRawPoolContents': sum(digest in raw_matches for digest in by_hash),
        'alreadyInRawPoolUniqueBytes': raw_bytes,
        'additionalObjectBytesIfSharingRawPool': unique - raw_bytes,
        'sharedPoolRepeatedLogicalBytes': total - (unique - raw_bytes)
    }


def expected_checksums(root, files, errors):
    """Read only checksum-bearing media/source manifests; never rewrite verification."""
    checks = {}
    statuses = {}

    def load(relative):
        if relative not in files:
            return None
        descriptor = None
        try:
            if files[relative].st_size > 64 * 1024 * 1024:
                raise ValueError('Manifest exceeds the bounded parser limit')
            descriptor = open_beneath(root, relative)
            if identity(os.fstat(descriptor)) != identity(files[relative]):
                raise ValueError('Manifest identity changed')
            with os.fdopen(descriptor, 'rb', closefd=False) as stream:
                value = json.load(stream)
            if identity(os.fstat(descriptor)) != identity(files[relative]):
                raise ValueError('Manifest changed while parsing')
            return value
        except (OSError, ValueError, TypeError) as error:
            errors.append({'path': relative, 'reason': 'manifest-' + type(error).__name__})
            return None
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def add(base, entry, field='path'):
        if not isinstance(entry, dict):
            errors.append({'path': base, 'reason': 'malformed-manifest-entry'})
            return
        relative = entry.get(field)
        digest = entry.get('sha256')
        if not isinstance(relative, str) or not isinstance(digest, str):
            return
        parts = Path(relative).parts
        if Path(relative).is_absolute() or '..' in parts or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            errors.append({'path': base, 'reason': 'unsafe-or-invalid-checksum-reference'})
            return
        name = str(Path(base) / relative)
        size = entry.get('bytes')
        if size is not None and (type(size) is not int or size < 0):
            errors.append({'path': name, 'reason': 'malformed-manifest-size'})
            return
        checks.setdefault(name, set()).add((digest, size))

    def entries(value, key, relative):
        result = value.get(key, [])
        if not isinstance(result, list):
            errors.append({'path': relative, 'reason': 'malformed-manifest-table'})
            return []
        return result

    for relative in files:
        parts = Path(relative).parts
        if len(parts) == 3 and parts[0] == 'captures' and parts[2] == 'capture.verification.json':
            value = load(relative)
            if not isinstance(value, dict):
                continue
            statuses[parts[1]] = value.get('ok') is True
            if not statuses[parts[1]]:
                continue  # Failed/partial sources remain inventoried, not labelled verified.
            base = str(Path(relative).parent)
            for entry in entries(value, 'stores', relative):
                add(base, entry)
            for entry in entries(value, 'opfs', relative):
                add(base, entry, 'archivedPath')
    for layer in ('', 'materialized-media', 'recovered-media', 'recovered-content'):
        value = load(str(Path(layer) / 'indexes/media.json'))
        if isinstance(value, dict):
            for entry in entries(value, 'items', str(Path(layer) / 'indexes/media.json')):
                add(layer, entry)
    value = load('venice-archive.manifest.json')
    if isinstance(value, dict):
        records = value.get('records', {})
        stores = records.get('sourceStores', {}) if isinstance(records, dict) else None
        if not isinstance(stores, dict):
            errors.append({'path': 'venice-archive.manifest.json', 'reason': 'malformed-manifest-table'})
        else:
            for entry in stores.values():
                if not isinstance(entry, dict):
                    errors.append({'path': 'venice-archive.manifest.json', 'reason': 'malformed-manifest-entry'})
                elif entry.get('status') == 'active':
                    add('', entry)
    return checks, statuses


def audit(root, seconds=300, on_progress=lambda value: None):
    started = time.monotonic()
    if not math.isfinite(seconds) or seconds <= 0:
        raise ValueError('Deadline must be positive and finite')
    deadline = started + seconds
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Archive must be a real directory, not a symlink')
    root = root.resolve()
    errors = []
    initial, missing = walk(root, errors, deadline)
    # Root manifest is preservation metadata, also inventoried to validate its source-store checksums.
    root_manifest = root / 'venice-archive.manifest.json'
    try:
        info = root_manifest.lstat()
        if stat.S_ISREG(info.st_mode):
            initial['venice-archive.manifest.json'] = info
        else:
            errors.append({'path': root_manifest.name, 'reason': 'root-manifest-not-regular'})
    except FileNotFoundError:
        pass
    inventory_errors = bool(errors)
    checks, statuses = expected_checksums(root, initial, errors)
    records = []
    matched_checks = 0
    for index, (relative, info) in enumerate(sorted(initial.items())):
        try:
            digest = hash_file(root, relative, info, deadline)
            record = {'path': relative, 'layer': Path(relative).parts[0] if len(Path(relative).parts) > 1 else 'root-metadata', 'category': category(relative),
                      'sha256': digest, 'bytes': info.st_size, 'allocatedBytes': info.st_blocks * 512,
                      'device': info.st_dev, 'inode': info.st_ino, 'links': info.st_nlink,
                      'mode': info.st_mode, 'mtimeNs': info.st_mtime_ns, 'ctimeNs': info.st_ctime_ns,
                      'flags': getattr(info, 'st_flags', 0)}
            records.append(record)
            if relative in checks:
                for expected, size in checks[relative]:
                    if digest != expected or size is not None and info.st_size != int(size):
                        errors.append({'path': relative, 'reason': 'declared-checksum-or-size-mismatch'})
                    else:
                        matched_checks += 1
        except (OSError, ValueError, TimeoutError) as error:
            inventory_errors = True
            errors.append({'path': relative, 'reason': type(error).__name__, 'detail': str(error) if isinstance(error, (ValueError, TimeoutError)) else None})
            if isinstance(error, TimeoutError):
                break
        if index == 0 or (index + 1) % 200 == 0 or index + 1 == len(initial):
            on_progress({'hashed': len(records), 'files': len(initial), 'elapsedSeconds': round(time.monotonic() - started, 3)})
    for relative in checks.keys() - initial.keys():
        errors.append({'path': relative, 'reason': 'declared-payload-missing'})
    raw_matches = {}
    unique = {item['sha256']: item for item in records}
    for relative in checks.keys() - initial.keys():
        for digest, size in checks[relative]:
            unique.setdefault(digest, {'bytes': size})
    for digest, item in sorted(unique.items()):
        relative = 'raw-store/objects/' + digest[:2] + '/' + digest
        try:
            descriptor = open_beneath(root, relative)
        except FileNotFoundError:
            continue
        except OSError as error:
            errors.append({'path': relative, 'reason': 'raw-pool-' + type(error).__name__})
            continue
        try:
            info = os.fstat(descriptor)
        finally:
            os.close(descriptor)
        try:
            if item['bytes'] is not None and info.st_size != item['bytes'] or hash_file(root, relative, info, deadline) != digest:
                raise ValueError('Matching raw object failed byte verification')
            raw_matches[digest] = {'path': relative, 'bytes': info.st_size}
        except (OSError, ValueError, TimeoutError) as error:
            errors.append({'path': relative, 'reason': 'raw-pool-' + type(error).__name__})
            if isinstance(error, TimeoutError):
                break
    after_errors = []
    final, _ = walk(root, after_errors, deadline)
    try:
        final['venice-archive.manifest.json'] = root_manifest.lstat()
    except FileNotFoundError:
        pass
    changes = {
        'added': sorted(final.keys() - initial.keys()), 'removed': sorted(initial.keys() - final.keys()),
        'changed': sorted(name for name in initial.keys() & final.keys() if identity(initial[name]) != identity(final[name]))
    }
    errors.extend(after_errors)
    if any(changes.values()):
        errors.append({'reason': 'source-inventory-changed'})
    groups = {}
    for item in records:
        groups.setdefault(item['sha256'], []).append(item)
    missing_references = []
    for relative in sorted(checks.keys() - initial.keys()):
        expectations = []
        for digest, size in sorted(checks[relative], key=lambda value: (value[0], str(value[1]))):
            candidates = [item['path'] for item in groups.get(digest, [])
                          if size is None or item['bytes'] == size]
            raw = raw_matches.get(digest)
            if raw and size is not None and raw['bytes'] != size:
                raw = None
            expectations.append({'sha256': digest, 'bytes': size,
                                 'verifiedReadableCandidates': candidates,
                                 'verifiedRawObject': raw,
                                 'resolvable': bool(candidates or raw)})
        missing_references.append({'declaredPath': relative, 'expectations': expectations,
                                   'allExpectationsResolvable': all(item['resolvable'] for item in expectations)})
    duplicates = [
        {'sha256': digest, 'bytes': items[0]['bytes'], 'paths': [item['path'] for item in items],
         'layers': sorted({item['layer'] for item in items}), 'categories': sorted({item['category'] for item in items}),
         'copies': len(items), 'distinctInodes': len({(item['device'], item['inode']) for item in items}),
         'repeatedLogicalBytes': items[0]['bytes'] * (len(items) - 1), 'alreadyInRawPool': digest in raw_matches}
        for digest, items in groups.items() if len(items) > 1
    ]
    return {
        'schema': 'archiv.payload-audit.v1', 'algorithm': 'sha256', 'readOnly': True,
        'completedAt': time.time(), 'elapsedSeconds': round(time.monotonic() - started, 3),
        'complete': not errors and len(records) == len(initial), 'roots': list(ROOTS), 'missingRoots': missing,
        'inventoryComplete': not inventory_errors and not after_errors and not any(changes.values()) and len(records) == len(initial),
        'manifestValidationPassed': not any(item['reason'].startswith(('declared-', 'manifest-', 'malformed-manifest', 'unsafe-or-invalid')) for item in errors),
        'rawPoolComparisonPassed': not inventory_errors and len(records) == len(initial) and not any(item['reason'].startswith('raw-pool-') for item in errors),
        'notWalked': ['raw history (except independently hashed matching objects)', 'operational config/logs', 'working caches'],
        'limits': ['Exact whole-file bytes only; no embedded/base64 decoding or record/chunk dedup.',
                   'Allocated blocks do not reveal APFS clone/compression extent sharing; reclaim is NOT measured.',
                   'This inventory does not preserve ACL/xattr/resourcefork metadata and is NOT a removal receipt.'],
        'totals': summary(records, raw_matches),
        'byCategory': {name: summary([item for item in records if item['category'] == name], raw_matches) for name in sorted({item['category'] for item in records})},
        'byLayer': {name: summary([item for item in records if item['layer'] == name], raw_matches) for name in sorted({item['layer'] for item in records})},
        'manifestChecks': {'matchedDeclarations': matched_checks, 'declaredPaths': len(checks), 'verifiedCaptureManifests': sum(statuses.values()), 'failedOrPartialCaptureManifests': sum(not value for value in statuses.values())},
        'unverifiedCaptureDirectories': sorted({Path(name).parts[1] for name in initial if Path(name).parts[0] == 'captures' and len(Path(name).parts) > 2} - statuses.keys()),
        'referenceIssues': {'missingDeclaredPaths': len(missing_references),
                            'resolvableByVerifiedBytes': sum(item['allExpectationsResolvable'] for item in missing_references)},
        'missingReferences': missing_references,
        'changesDuringAudit': changes, 'errors': errors, 'files': records,
        'duplicateGroups': sorted(duplicates, key=lambda group: (-group['repeatedLogicalBytes'], group['sha256'])),
        'verifiedMatchingRawObjects': raw_matches
    }


def private_report(destination, root, value):
    destination = destination.absolute()
    # Resolve parent and existing targets before refusing outputs inside the archive.
    if under(destination.resolve(), root.resolve()) or destination.is_symlink() or destination.exists():
        raise ValueError('Report must be a new file outside the archive, not an existing file/symlink')
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.payload-audit-', dir=destination.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=True, separators=(',', ':'))
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        # Do not replace an output created by another process after the initial check.
        os.link(temporary, destination)
        os.unlink(temporary)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True, help='New owner-private JSON file OUTSIDE the archive')
    parser.add_argument('--deadline-seconds', type=float, default=300)
    args = parser.parse_args()
    if not math.isfinite(args.deadline_seconds) or args.deadline_seconds <= 0:
        parser.error('Deadline must be positive and finite')
    # Reject unsafe output before spending time hashing source bytes.
    if args.output.exists() or args.output.is_symlink() or under(args.output.resolve(), args.archive.resolve()):
        parser.error('Output must be a new file outside the archive')
    result = audit(args.archive, args.deadline_seconds, lambda progress: print(json.dumps({'progress': progress}), file=sys.stderr, flush=True))
    private_report(args.output, args.archive, result)
    print(json.dumps({key: result[key] for key in ('schema', 'complete', 'inventoryComplete', 'manifestValidationPassed', 'rawPoolComparisonPassed', 'elapsedSeconds', 'totals', 'byCategory', 'manifestChecks', 'referenceIssues')}))
    return 0 if result['complete'] else 1


if __name__ == '__main__':
    os.umask(0o077)
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print(json.dumps({'error': type(error).__name__, 'readOnly': True}), file=sys.stderr)
        sys.exit(1)
