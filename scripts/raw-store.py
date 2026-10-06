#!/usr/bin/env python3
"""Lossless, content-addressed raw history. Standard library; no live-browser writes.

Objects are immutable SHA-256 byte streams; trees preserve original paths, POSIX
metadata and (on macOS) opaque AppleDouble ACL/xattr/resource-fork metadata.
Never garbage-collect objects. A committed, independently verified tree must
exist before --remove-source can unlink any original file. No hard links.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tempfile
import time

SCHEMA = 'archiv.raw-store.v1'
SNAPSHOT = re.compile(r'snapshot-[0-9TZ-]+\Z')
DIGEST = re.compile(r'[0-9a-f]{64}\Z')
LIB = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True) if sys.platform == 'darwin' else None
if LIB:
    LIB.copyfile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_uint32]
    LIB.copyfile.restype = ctypes.c_int
    LIB.clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
    LIB.clonefile.restype = ctypes.c_int


def sha(path):
    # Apple's launchd PATH can select Python 3.9; bounded streaming also avoids
    # making preservation depend on hashlib.file_digest (introduced in 3.11).
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def signature(info):
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, getattr(info, 'st_flags', 0)]


def safe_path(value):
    p = PurePosixPath(value)
    if not value or p.is_absolute() or '..' in p.parts or str(p) != value or '\\' in value:
        raise ValueError('Unsafe tree path')
    return p


def native_copy(source, target, clone_required=False):
    if LIB:
        if LIB.clonefile(os.fsencode(source), os.fsencode(target), 1) == 0:
            return
        error = ctypes.get_errno()
        if clone_required:
            raise OSError(error, 'Native clone required; refusing a full-copy fallback')
    elif clone_required:
        raise RuntimeError('Native clones require macOS')
    shutil.copyfile(source, target)


def metadata(path, info, scratch):
    record = {name: getattr(info, 'st_' + name) for name in ('mode', 'uid', 'gid', 'atime_ns', 'mtime_ns', 'ctime_ns')}
    record['flags'] = getattr(info, 'st_flags', 0)
    record['birthtime'] = getattr(info, 'st_birthtime', None)
    record['birthtime_ns'] = getattr(info, 'st_birthtime_ns', None)
    if LIB:
        packed = scratch / 'metadata'
        result = LIB.copyfile(os.fsencode(path), os.fsencode(packed), None, 7 | (1 << 22))
        if result != 0:
            raise OSError(ctypes.get_errno(), 'Cannot preserve AppleDouble metadata')
        record['appleDouble'] = base64.b64encode(packed.read_bytes()).decode('ascii')
        packed.unlink()
    elif hasattr(os, 'listxattr'):
        record['xattrs'] = {name: base64.b64encode(os.getxattr(path, name)).decode('ascii') for name in os.listxattr(path)}
    return record


def fsync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_json(path, value):
    data = (json.dumps(value, ensure_ascii=True, separators=(',', ':')) + '\n').encode()
    fd, temporary = tempfile.mkstemp(prefix='.pending-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        fsync_directory(path.parent)
        if LIB:
            with path.open('rb') as committed:
                fcntl.fcntl(committed.fileno(), fcntl.F_FULLFSYNC)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Store:
    def __init__(self, root):
        self.root = Path(root).absolute()
        if self.root.is_symlink():
            raise ValueError('Store cannot be a symlink')
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)
        for name in ('objects', 'trees', 'receipts'):
            p = self.root / name
            if p.is_symlink():
                raise ValueError('Unsafe store directory')
            p.mkdir(exist_ok=True, mode=0o700)
        self.checked = {}

    @contextlib.contextmanager
    def lock(self):
        with (self.root / '.lock').open('a') as stream:
            os.chmod(stream.name, 0o600)
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            header = self.root / 'FORMAT.json'
            if header.exists():
                if json.loads(header.read_text()).get('schema') != SCHEMA:
                    raise ValueError('Unsupported raw-store format')
            else:
                atomic_json(header, {'schema': SCHEMA, 'hash': 'sha256', 'purpose': 'Independent lossless Venice history; indexes are disposable views', 'metadata': 'POSIX fields and opaque AppleDouble on macOS', 'gc': 'none'})
            yield

    def object(self, digest):
        if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
            raise ValueError('Invalid object hash')
        directory = self.root / 'objects' / digest[:2]
        if directory.is_symlink():
            raise ValueError('Unsafe object directory')
        return directory / digest

    def verify_object(self, digest, size):
        p = self.object(digest)
        info = p.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size != size:
            raise RuntimeError('Missing, nonregular or wrong-sized object: ' + digest)
        stamp = signature(info)
        if self.checked.get(digest) != stamp:
            if sha(p) != digest:
                raise RuntimeError('Corrupt object: ' + digest)
            self.checked[digest] = signature(p.stat())
        return p

    def put(self, source, digest, size, clone_required):
        target = self.object(digest)
        if target.exists() or target.is_symlink():
            self.verify_object(digest, size)
            return
        target.parent.mkdir(exist_ok=True, mode=0o700)
        temporary = target.parent / ('.pending-' + str(os.getpid()))
        if temporary.exists():
            raise RuntimeError('Pending object already exists; inspect before retrying')
        try:
            native_copy(source, temporary, clone_required)
            if temporary.stat().st_size != size or sha(temporary) != digest:
                raise RuntimeError('Destination object checksum mismatch')
            os.chmod(temporary, 0o400)
            with temporary.open('rb') as stream:
                os.fsync(stream.fileno())
            os.replace(temporary, target)
            fsync_directory(target.parent)
            self.checked[digest] = signature(target.stat())
        finally:
            if temporary.exists():
                temporary.unlink()

    def tree_path(self, identity):
        if not SNAPSHOT.fullmatch(identity):
            raise ValueError('Invalid snapshot identity')
        return self.root / 'trees' / (identity + '.json')

    def verify_tree(self, identity):
        tree_path = self.tree_path(identity)
        receipt_path = self.root / 'receipts' / (identity + '.json')
        receipt = json.loads(receipt_path.read_text())
        if sha(tree_path) != receipt['treeSha256']:
            raise RuntimeError('Tree checksum mismatch')
        tree = json.loads(tree_path.read_text())
        if tree.get('schema') != SCHEMA or tree.get('snapshotId') != identity:
            raise ValueError('Unsupported tree')
        seen = set()
        for entry in tree['entries']:
            value = entry['path']
            if value != '.':
                safe_path(value)
            if value in seen:
                raise ValueError('Duplicate tree path')
            seen.add(value)
            if entry['type'] == 'file':
                self.verify_object(entry['sha256'], entry['size'])
            elif entry['type'] != 'directory':
                raise ValueError('Unsupported tree entry')
        return tree

    def ingest(self, source, remove=False, clone_required=False, identity=None):
        source = Path(source).absolute()
        identity = identity or source.name
        tree_path = self.tree_path(identity)
        if source.is_symlink() or not source.is_dir():
            raise ValueError('Source must be a real snapshot directory')
        src = source.resolve()
        dst = self.root.resolve()
        if src == dst or src in dst.parents or dst in src.parents:
            raise ValueError('Store and source must not overlap')
        source_manifest = source / 'snapshot.manifest.json'
        expected = {}
        if source_manifest.exists():
            original = json.loads(source_manifest.read_text())
            if original.get('snapshotId') != source.name:
                raise ValueError('Source manifest identity mismatch')
            for entry in original['files']:
                relative = 'user-data/' + str(safe_path(entry['path']))
                if relative in expected:
                    raise ValueError('Duplicate source manifest path')
                expected[relative] = entry
        paths = inventory(source)
        receipt_path = self.root / 'receipts' / (identity + '.json')
        if tree_path.exists():
            tree = self.verify_tree(identity)
            entries = {e['path']: e for e in tree['entries']}
            receipt = json.loads(receipt_path.read_text())
            resuming_removal = receipt.get('removalStarted', False)
            if (not resuming_removal and set(paths) != set(entries)) or not set(paths).issubset(entries):
                raise RuntimeError('Existing tree differs from source paths; refusing replacement')
            for relative, info in paths.items():
                entry = entries[relative]
                if entry['type'] == 'file' and (info.st_size != entry['size'] or sha(source / relative) != entry['sha256']):
                    raise RuntimeError('Existing tree differs from source bytes')
                # Only directory signatures change as our journaled unlink proceeds.
                if not (resuming_removal and entry['type'] == 'directory') and signature(info) != entry['sourceSignature']:
                    raise RuntimeError('Source metadata changed since ingestion; originals retained')
        else:
            entries = []
            started = time.monotonic()
            discrepancies = []
            with tempfile.TemporaryDirectory(prefix='.metadata-', dir=self.root) as temporary:
                scratch = Path(temporary)
                for index, (relative, info) in enumerate(paths.items()):
                    path = source if relative == '.' else source / relative
                    if not stat.S_ISREG(info.st_mode) and not stat.S_ISDIR(info.st_mode):
                        raise ValueError('Unsupported file type; original retained: ' + relative)
                    entry = {'path': relative, 'type': 'directory' if stat.S_ISDIR(info.st_mode) else 'file', 'metadata': metadata(path, info, scratch)}
                    if entry['type'] == 'file':
                        digest = sha(path)
                        original = expected.pop(relative, None)
                        if original and (info.st_size != original['size'] or digest != original['sha256']):
                            if Path(relative).name != '.DS_Store':
                                raise RuntimeError('Source manifest checksum mismatch: ' + relative)
                            discrepancies.append({'path': relative, 'reason': 'Finder metadata changed since original manifest', 'originalSha256': original['sha256'], 'originalSize': original['size'], 'preservedSha256': digest, 'preservedSize': info.st_size})
                        self.put(path, digest, info.st_size, clone_required)
                        entry.update(sha256=digest, size=info.st_size)
                    after = path.lstat()
                    if signature(after) != signature(info):
                        raise RuntimeError('Source changed while reading: ' + relative)
                    entry['sourceSignature'] = signature(after)
                    entries.append(entry)
                    if index and index % 500 == 0:
                        print(json.dumps({'phase': 'ingest', 'snapshot': identity, 'entries': index, 'total': len(paths), 'seconds': round(time.monotonic() - started, 1)}), flush=True)
            if expected:
                raise RuntimeError('Source manifest references missing files')
            tree = {'schema': SCHEMA, 'snapshotId': identity, 'sourceSnapshotId': source.name, 'sourceManifestPresent': source_manifest.exists(), 'sourceDirectory': str(source), 'originalManifestDiscrepancies': discrepancies, 'entries': entries}
            check_inventory(source, {e['path']: e['sourceSignature'] for e in entries})
            atomic_json(tree_path, tree)
            os.chmod(tree_path, 0o400)
            atomic_json(self.root / 'receipts' / (identity + '.json'), {'treeSha256': sha(tree_path), 'verifiedAt': time.time(), 'sourceRemoved': False})
            tree = self.verify_tree(identity)
        if remove:
            # A fresh object checksum pass is mandatory at the destructive boundary.
            self.checked.clear()
            self.verify_tree(identity)
            entries = {e['path']: e for e in tree['entries']}
            receipt = json.loads(receipt_path.read_text())
            actual = inventory(source)
            if receipt.get('removalStarted'):
                if not set(actual).issubset(entries):
                    raise RuntimeError('Unknown source entries appeared; originals retained')
                for name, info in actual.items():
                    if entries[name]['type'] == 'file' and signature(info) != entries[name]['sourceSignature']:
                        raise RuntimeError('Source changed during interrupted removal')
            else:
                check_inventory(source, {name: e['sourceSignature'] for name, e in entries.items()})
                atomic_json(receipt_path, {**receipt, 'removalStarted': True})
            for relative, entry in entries.items():
                if entry['type'] != 'file' or relative not in actual:
                    continue
                target = source / relative
                if signature(target.lstat()) != entry['sourceSignature']:
                    raise RuntimeError('Source changed before unlink; remaining originals retained')
                target.unlink()
            # Never recursive-delete unknown files added by Finder/a cloud provider.
            for relative in sorted((name for name, e in entries.items() if e['type'] == 'directory' and name in actual), key=lambda p: (p.count('/'), len(p)), reverse=True):
                (source if relative == '.' else source / relative).rmdir()
            atomic_json(receipt_path, {**receipt, 'removalStarted': True, 'sourceRemoved': True, 'removedAt': time.time()})
        result = {'phase': 'committed', 'snapshot': identity, 'files': sum(e['type'] == 'file' for e in tree['entries']), 'bytes': sum(e.get('size', 0) for e in tree['entries']), 'sourceManifestPresent': tree['sourceManifestPresent'], 'sourceRemoved': remove}
        print(json.dumps(result), flush=True)
        return result

    def record_capture(self, identity, capture_id):
        if not re.fullmatch(r'capture-[0-9TZ-]+', capture_id):
            raise ValueError('Invalid capture identity')
        self.verify_tree(identity)
        capture = self.root.parent / 'captures' / capture_id
        verification = capture / 'capture.verification.json'
        manifest = capture / 'capture.manifest.json'
        if json.loads(verification.read_text()).get('ok') is not True or json.loads(manifest.read_text()).get('snapshot') != identity:
            raise ValueError('Capture does not verify this raw snapshot')
        receipt_path = self.root / 'receipts' / (identity + '.json')
        receipt = json.loads(receipt_path.read_text())
        atomic_json(receipt_path, {**receipt, 'capture': {'verified': True, 'captureId': capture_id, 'verificationSha256': sha(verification), 'manifestSha256': sha(manifest), 'recordedAt': time.time()}})

    def restore(self, identity, destination, clone_required=False, portable=False):
        tree = self.verify_tree(identity)
        destination = Path(destination).absolute()
        if destination.exists() or destination.is_symlink():
            raise ValueError('Restore destination must not exist')
        if self.root.resolve() in destination.resolve().parents:
            raise ValueError('Restore must be outside the immutable store')
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.mkdir(mode=0o700)
        try:
            with tempfile.TemporaryDirectory(prefix='.restore-metadata-', dir=self.root) as temporary:
                scratch = Path(temporary)
                directories = sorted((e for e in tree['entries'] if e['type'] == 'directory' and e['path'] != '.'), key=lambda e: len(PurePosixPath(e['path']).parts))
                for entry in directories:
                    (destination / entry['path']).mkdir(mode=0o700)
                for entry in tree['entries']:
                    if entry['type'] != 'file':
                        continue
                    p = destination / entry['path']
                    native_copy(self.object(entry['sha256']), p, clone_required)
                    if sha(p) != entry['sha256']:
                        raise RuntimeError('Restored bytes mismatch')
                    apply_metadata(p, entry['metadata'], scratch, portable=portable)
                for entry in sorted((e for e in tree['entries'] if e['type'] == 'directory'), key=lambda e: len(PurePosixPath(e['path']).parts) if e['path'] != '.' else 0, reverse=True):
                    apply_metadata(destination if entry['path'] == '.' else destination / entry['path'], entry['metadata'], scratch, portable=portable)
        except BaseException:
            shutil.rmtree(destination)
            raise
        print(json.dumps({'restored': identity, 'destination': str(destination), 'metadataRestore': 'posix-only' if portable else 'native', 'files': sum(e['type'] == 'file' for e in tree['entries'])}), flush=True)


def apply_metadata(path, data, scratch, portable=False):
    if data.get('appleDouble') and not portable:
        if not LIB:
            # Keep the opaque metadata for later macOS recovery without mislabelling
            # a cross-platform restore as a full metadata restore.
            raise RuntimeError('AppleDouble metadata restoration requires macOS')
        packed = scratch / 'metadata'
        packed.write_bytes(base64.b64decode(data['appleDouble'], validate=True))
        if LIB.copyfile(os.fsencode(packed), os.fsencode(path), None, 7 | (1 << 23)) != 0:
            raise OSError(ctypes.get_errno(), 'Cannot restore AppleDouble metadata')
        packed.unlink()
    for name, value in data.get('xattrs', {}).items():
        os.setxattr(path, name, base64.b64decode(value, validate=True))
    os.chmod(path, stat.S_IMODE(data['mode']))
    os.utime(path, ns=(data['atime_ns'], data['mtime_ns']))
    # Ownership, creation/change times and provider/immutable flags are recorded,
    # not forced on a new host. In particular never recreate a dataless flag.


def inventory(root):
    result = {'.': root.lstat()}
    for parent, dirs, files in os.walk(root, followlinks=False):
        for name in sorted(dirs + files):
            p = Path(parent) / name
            relative = p.relative_to(root).as_posix()
            safe_path(relative)
            info = p.lstat()
            if not stat.S_ISREG(info.st_mode) and not stat.S_ISDIR(info.st_mode):
                raise ValueError('Unsupported file type; source retained: ' + relative)
            result[relative] = info
    return result


def check_inventory(source, expected):
    actual = {name: signature(info) for name, info in inventory(source).items()}
    if actual != expected:
        changed = [name for name in sorted(set(actual) | set(expected)) if actual.get(name) != expected.get(name)]
        raise RuntimeError('Snapshot changed after inventory; originals retained: ' + json.dumps([{'path': name, 'before': expected.get(name), 'after': actual.get(name)} for name in changed[:10]]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--store', required=True)
    sub = parser.add_subparsers(dest='command', required=True)
    ingest = sub.add_parser('ingest')
    ingest.add_argument('--source', required=True)
    ingest.add_argument('--remove-source', action='store_true')
    ingest.add_argument('--require-clone', action='store_true')
    ingest.add_argument('--identity', help='Preserve a separate observation without overwriting an already committed tree')
    migrate = sub.add_parser('migrate')
    migrate.add_argument('--source-directory', required=True)
    migrate.add_argument('--remove-source', action='store_true')
    migrate.add_argument('--require-clone', action='store_true')
    migrate.add_argument('--continue-on-error', action='store_true', help='Attempt other snapshots; report every retained source and exit nonzero')
    capture = sub.add_parser('record-capture')
    capture.add_argument('--snapshot', required=True)
    capture.add_argument('--capture', required=True)
    verify = sub.add_parser('verify')
    verify.add_argument('--snapshot')
    restore = sub.add_parser('restore')
    restore.add_argument('--snapshot', required=True)
    restore.add_argument('--destination', required=True)
    restore.add_argument('--require-clone', action='store_true')
    restore.add_argument('--portable', action='store_true', help='Restore bytes/POSIX only; opaque macOS metadata stays in the archive tree')
    sub.add_parser('list')
    args = parser.parse_args()
    store = Store(args.store)
    with store.lock():
        if args.command == 'ingest':
            store.ingest(args.source, args.remove_source, args.require_clone, args.identity)
        elif args.command == 'migrate':
            root = Path(args.source_directory)
            if root.is_symlink():
                raise ValueError('Snapshot root cannot be a symlink')
            failures = []
            for p in sorted(root.iterdir()):
                if SNAPSHOT.fullmatch(p.name):
                    try:
                        store.ingest(p, args.remove_source, args.require_clone)
                    except Exception as error:
                        if not args.continue_on_error:
                            raise
                        failures.append({'snapshot': p.name, 'error': str(error)})
                        print(json.dumps({'phase': 'source-retained', **failures[-1]}), flush=True)
            if failures:
                print(json.dumps({'retainedSources': failures}), file=sys.stderr)
                return 1
        elif args.command == 'record-capture':
            store.record_capture(args.snapshot, args.capture)
            print(json.dumps({'snapshot': args.snapshot, 'capture': args.capture, 'verified': True}))
        elif args.command == 'restore':
            store.restore(args.snapshot, args.destination, args.require_clone, args.portable)
        elif args.command == 'verify':
            names = [args.snapshot] if args.snapshot else [p.stem for p in sorted((store.root / 'trees').glob('*.json'))]
            for name in names:
                tree = store.verify_tree(name)
                print(json.dumps({'verified': name, 'files': sum(e['type'] == 'file' for e in tree['entries'])}), flush=True)
        elif args.command == 'list':
            print(json.dumps([p.stem for p in sorted((store.root / 'trees').glob('*.json'))]))


if __name__ == '__main__':
    os.umask(0o077)
    try:
        sys.exit(main() or 0)
    except Exception as error:
        print(json.dumps({'error': str(error), 'originalsNotRecursivelyDeleted': True}), file=sys.stderr)
        sys.exit(1)
