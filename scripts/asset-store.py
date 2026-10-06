#!/usr/bin/env python3
"""Lossless standalone asset references into the existing raw SHA-256 pool.

Prepare/verify/proof preserve original asset files. Explicit remove requires a
matching full native restore proof; opt-in maintain may unlink recorded files only
after each batch's native delta proof. Source JSON/JSONL and original indexes stay put.
No hard links, alternate byte pool, object GC or network/browser dependencies.
POSIX Python 3.9+; macOS extended metadata uses the existing raw-store serializer.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import base64
import sys
import tempfile
import time
import signal
import uuid

HERE = Path(__file__).resolve().parent

def module(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

raw = module('asset_raw', 'raw-store.py')
auditor = module('asset_audit', 'audit-payload-duplicates.py')
SCHEMA = 'archiv.asset-store.v1'
ID = re.compile(r'assets-[0-9a-f]{32}\Z')
RESERVE = 5 * 1024 ** 3


def allowed(value):
    raw.safe_path(value)
    parts = Path(value).parts
    return (len(parts) > 3 and parts[0] == 'captures' and parts[2] == 'opfs'
            or len(parts) > 2 and parts[:2] == ('media', 'sha256')
            or len(parts) > 2 and parts[0] in ('materialized-media', 'recovered-media', 'recovered-content') and parts[1] == 'media')


def load_json(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('Missing or unsafe control file')
    return json.loads(path.read_bytes())


def real_path(root, relative):
    raw.safe_path(relative)
    current = root
    for part in Path(relative).parts:
        current = current / part
        if stat.S_ISLNK(current.lstat().st_mode):
            raise ValueError('Symlink refused')
    return current


def provenance_view(encoded, attributes=None):
    """Mask only the observed 8-byte OS-bound ID in a v2 native provenance xattr.

    The original complete AppleDouble is still immutable preservation data. This
    does not mask ACLs, FinderInfo, resourceforks, other attrs or provenance flags.
    Any changed layout/name/size/prefix/other byte remains a proof failure.
    """
    data = bytearray(base64.b64decode(encoded, validate=True))
    if len(data) < 26 or struct.unpack_from('>II', data) != (0x00051607, 0x00020000):
        raise ValueError('Unsupported AppleDouble metadata')
    count = struct.unpack_from('>H', data, 24)[0]
    if 26 + 12 * count > len(data):
        raise ValueError('Truncated AppleDouble table')
    finder = [struct.unpack_from('>III', data, 26 + 12 * i) for i in range(count) if struct.unpack_from('>I', data, 26 + 12 * i)[0] == 9]
    if len(finder) != 1:
        raise ValueError('Ambiguous FinderInfo metadata')
    _, offset, size = finder[0]
    start = (offset + 32 + 3) & ~3
    if start + 36 > offset + size or data[start:start+4] != b'ATTR':
        return bytes(data), None
    fields = struct.unpack_from('>8I2H', data, start)
    if offset + size > len(data) or fields[3] < start + 36 or fields[3] + fields[4] > offset + size:
        raise ValueError('Invalid native attribute data area')
    cursor = start + 36
    provenance = None
    for _ in range(fields[-1]):
        if cursor + 11 > len(data):
            raise ValueError('Truncated native attribute')
        value_offset, length, flags, name_length = struct.unpack_from('>IIHB', data, cursor)
        name = bytes(data[cursor+11:cursor+11+name_length])
        if not name_length or not name.endswith(b'\0') or value_offset < fields[3] or value_offset + length > offset + size or cursor + 11 + name_length > fields[3]:
            raise ValueError('Invalid native attribute bounds')
        if attributes is not None:
            attributes[name[:-1].decode('utf-8')] = bytes(data[value_offset:value_offset+length])
        if name == b'com.apple.provenance\0':
            if provenance is not None or length != 11:
                raise ValueError('Unsupported provenance shape')
            value = bytes(data[value_offset:value_offset+length])
            provenance = {'bytes': length, 'sha256': hashlib.sha256(value).hexdigest()}
            data[value_offset+3:value_offset+11] = b'\0' * 8
        cursor = (cursor + 11 + name_length + 3) & ~3
    return bytes(data), provenance


def apply_asset_metadata(path, record, scratch, portable=False):
    raw.apply_metadata(path, record, scratch, portable=portable)
    if not portable and raw.LIB and record.get('appleDouble'):
        attributes = {}
        provenance_view(record['appleDouble'], attributes)
        # COPYFILE_UNPACK synthesizes new quarantine dates/agents/flags. Restore
        # the ORIGINAL protection attribute exactly; never remove/clear it.
        if 'com.apple.quarantine' in attributes:
            value = attributes['com.apple.quarantine']
            # Native PACK encodes quarantine as q/<original xattr> + NUL,
            # not as the raw xattr value. Fail closed on an unknown encoding.
            if not value.startswith(b'q/') or not value.endswith(b'\0'):
                raise ValueError('Unsupported packed quarantine metadata')
            value = value[2:-1]
            raw.LIB.setxattr.argtypes = [raw.ctypes.c_char_p, raw.ctypes.c_char_p, raw.ctypes.c_void_p,
                                       raw.ctypes.c_size_t, raw.ctypes.c_uint32, raw.ctypes.c_int]
            raw.LIB.setxattr.restype = raw.ctypes.c_int
            if raw.LIB.setxattr(os.fsencode(path), b'com.apple.quarantine', value, len(value), 0, 0) != 0:
                raise OSError(raw.ctypes.get_errno(), 'Cannot restore original quarantine protection')


def bundle_tools(root):
    names = ('asset-store.py', 'raw-store.py', 'audit-payload-duplicates.py')
    sources = {name: (HERE / name).read_bytes() for name in names}
    license_path = HERE / 'LICENSE' if (HERE / 'LICENSE').exists() else HERE.parent / 'LICENSE'
    sources['LICENSE'] = license_path.read_bytes()
    names = (*names, 'LICENSE')
    identity = hashlib.sha256(b'\0'.join(name.encode() + b'\0' + sources[name] for name in names)).hexdigest()
    destination = root / 'tools' / identity
    destination.mkdir(mode=0o700, exist_ok=True)
    for name, data in sources.items():
        target = destination / name
        if target.exists():
            if target.is_symlink() or target.read_bytes() != data:
                raise RuntimeError('Pinned recovery tool changed')
        else:
            with target.open('xb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(target, 0o400)
    raw.fsync_directory(destination)
    return identity


class Assets:
    def __init__(self, archive, create=False):
        p = Path(archive).absolute()
        if p.is_symlink() or not p.is_dir():
            raise ValueError('Archive must be a real directory')
        self.archive = p.resolve()
        self.root = self.archive / 'asset-store'
        if self.root.is_symlink():
            raise ValueError('Unsafe asset store')
        if create:
            self.root.mkdir(mode=0o700, exist_ok=True)
            for name in ('trees', 'receipts', 'tools'):
                q = self.root / name
                if q.is_symlink():
                    raise ValueError('Unsafe asset directory')
                q.mkdir(mode=0o700, exist_ok=True)
        self.pool = raw.Store(self.archive / 'raw-store')

    def paths(self, identity):
        if not ID.fullmatch(identity):
            raise ValueError('Invalid asset tree identity')
        return self.root / 'trees' / (identity + '.json'), self.root / 'receipts' / (identity + '.json')

    def current(self):
        pointer = self.root / 'current.json'
        if not pointer.exists():
            if (self.root / 'FORMAT.json').exists():
                raise RuntimeError('Existing asset store lost its pointer; inspect receipts before repair')
            return None
        value = load_json(pointer)
        if value.get('schema') != SCHEMA:
            raise ValueError('Unsupported asset pointer')
        tree, receipt = self.read(value['tree'])
        if value['treeSha256'] != receipt['treeSha256']:
            raise ValueError('Asset pointer checksum mismatch')
        return tree

    def read(self, identity, merged=True, seen=None):
        chain = set() if seen is None else set(seen)
        if identity in chain or len(chain) >= 200:
            raise ValueError('Asset tree cycle/depth limit; explicit checkpoint required')
        chain.add(identity)
        tree_path, receipt_path = self.paths(identity)
        tree_path = real_path(self.archive, str(tree_path.relative_to(self.archive)))
        receipt_path = real_path(self.archive, str(receipt_path.relative_to(self.archive)))
        receipt = load_json(receipt_path)
        if raw.sha(tree_path) != receipt['treeSha256']:
            raise ValueError('Asset tree checksum mismatch')
        tree = load_json(tree_path)
        if tree.get('schema') != SCHEMA or tree.get('tree') != identity or tree.get('objects') != '../raw-store/objects':
            raise ValueError('Unsupported asset tree')
        seen = set()
        for entry in tree['entries']:
            if not allowed(entry['path']) or entry['path'] in seen:
                raise ValueError('Invalid or duplicate asset path')
            seen.add(entry['path'])
            if entry['type'] not in ('file', 'alias') or type(entry['size']) is not int or entry['size'] < 0:
                raise ValueError('Invalid asset entry')
            self.pool.object(entry['sha256'])  # Validates full hex digest and pool prefix.
            if entry['type'] == 'file' and (not isinstance(entry.get('metadata'), dict) or not isinstance(entry.get('sourceSignature'), list)):
                raise ValueError('Original asset metadata missing')
        parents = {p.as_posix() for e in tree['entries'] for p in Path(e['path']).parents if p.as_posix() != '.'}
        if not isinstance(tree.get('directories'), dict):
            raise ValueError('Missing asset directory metadata')
        for name in tree['directories']:
            raw.safe_path(name)
            if name not in parents:
                raise ValueError('Directory outside asset tree')
        for item in tree.get('legacy', []):
            entry = next((e for e in tree['entries'] if e['path'] == item.get('path')), None)
            if not entry or item.get('sha256') != entry['sha256'] or item.get('size') != entry['size']:
                raise ValueError('Invalid historical ID reference')
        if merged and tree.get('baseTree'):
            base = tree['baseTree']
            parent, parent_receipt = self.read(base['tree'], seen=chain)
            if base['sha256'] != parent_receipt['treeSha256']:
                raise ValueError('Asset base tree checksum mismatch')
            entries = {e['path']: e for e in parent['entries']}
            entries.update({e['path']: e for e in tree['entries']})
            tree = {**tree, 'entries': sorted(entries.values(), key=lambda e: e['path']),
                    'directories': {**parent['directories'], **tree['directories']},
                    'legacy': [*parent.get('legacy', []), *tree.get('legacy', [])]}
        return tree, receipt

    def verify(self, identity, merged=True):
        tree, receipt = self.read(identity, merged=merged)
        self.pool.checked.clear()
        for entry in tree['entries']:
            self.pool.verify_object(entry['sha256'], entry['size'])
        return tree, receipt

    def maintain(self, enable=False, seconds=20, max_files=128, max_bytes=1024 ** 3):
        """Opt-in, bounded delta transaction; no full source/pool audit or no-op tree."""
        policy_path = self.root / 'maintenance.json'
        if enable:
            current = self.current()
            if not current or not self.read(current['tree'])[1].get('removalCompletedAt'):
                raise RuntimeError('Enable maintenance only after approved baseline consolidation')
            raw.atomic_json(policy_path, {'schema': SCHEMA, 'enabled': True})
        if not policy_path.exists():
            return {'maintenance': 'disabled', 'files': 0}
        policy = load_json(policy_path)
        if policy.get('schema') != SCHEMA or policy.get('enabled') is not True:
            raise ValueError('Invalid maintenance policy')
        if seconds <= 0 or max_files < 1 or max_bytes < 1:
            raise ValueError('Invalid maintenance bounds')
        deadline = time.monotonic() + seconds
        def tick(*args):
            if time.monotonic() >= deadline:
                raise TimeoutError('Asset maintenance deadline; originals retained for retry')
        original_sha = raw.sha
        def bounded_sha(path):
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                while True:
                    tick()
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        return digest.hexdigest()
                    digest.update(chunk)
        raw.sha = bounded_sha
        try:
            previous = self.current()
            if not previous:
                raise RuntimeError('Maintenance lost its published baseline')
            _, receipt = self.read(previous['tree'])
            # Resume a published delta after proof failure/interrupted unlink, never
            # grow another tree or discard the physical originals on every retry.
            if previous.get('baseTree') and not receipt.get('removalCompletedAt'):
                identity = previous['tree']
                pending_files = 1  # Rescan additions on the next bounded pass after recovery.
            else:
                roots = ['media/sha256', 'materialized-media/media', 'recovered-media/media', 'recovered-content/media']
                captures = self.archive / 'captures'
                if captures.exists():
                    real_path(self.archive, 'captures')
                    for child in sorted(captures.iterdir()):
                        tick()
                        if child.is_symlink():
                            raise ValueError('Unsafe capture directory')
                        if child.is_dir() and (child / 'opfs').exists():
                            roots.append(str((child / 'opfs').relative_to(self.archive)))
                candidates = []
                total = 0
                pending_files = 0
                for name in roots:
                    tick()
                    if not (self.archive / name).exists():
                        continue
                    root = real_path(self.archive, name)
                    for parent, dirs, files in os.walk(root, followlinks=False):
                        tick()
                        for item in sorted(dirs + files):
                            path = Path(parent) / item
                            relative = path.relative_to(self.archive).as_posix()
                            info = path.lstat()
                            if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                                raise ValueError('Unsafe asset candidate; originals retained')
                            if stat.S_ISREG(info.st_mode) and auditor.category(relative) == 'standalone-asset':
                                if len(candidates) >= max_files or total + info.st_size > max_bytes:
                                    pending_files += 1
                                    continue
                                candidates.append((relative, raw.signature(info)))
                                total += info.st_size
                if not candidates:
                    if pending_files:
                        raise RuntimeError('Asset exceeds automatic byte budget; explicit maintenance required')
                    return {'maintenance': 'up-to-date', 'files': 0, 'newTree': False, 'hashedPayloadBytes': 0}
                if shutil.disk_usage(self.archive).free < total + RESERVE:
                    raise RuntimeError('Maintenance would cross the five-GiB free-space reserve')
                entries, directories = {}, {}
                old = {e['path']: e for e in previous['entries']}
                new_bytes = 0
                with tempfile.TemporaryDirectory(prefix='.maintenance-metadata-', dir=self.root) as tmp:
                    scratch = Path(tmp)
                    for name, signature in candidates:
                        tick()
                        path = real_path(self.archive, name)
                        info = path.lstat()
                        if raw.signature(info) != signature:
                            raise RuntimeError('Asset changed during maintenance inventory')
                        digest = raw.sha(path)
                        if name in old and old[name]['sha256'] != digest:
                            raise RuntimeError('Known logical path was overwritten; explicit version repair required')
                        meta = raw.metadata(path, info, scratch)
                        target = self.pool.object(digest)
                        if not target.exists():
                            new_bytes += info.st_size
                        self.pool.put(path, digest, info.st_size, sys.platform == 'darwin')
                        if raw.signature(path.lstat()) != signature:
                            raise RuntimeError('Asset changed while preparing delta')
                        entries[name] = {'path': name, 'type': 'file', 'sha256': digest, 'size': info.st_size,
                                         'metadata': meta, 'sourceSignature': signature}
                        for parent in path.parents:
                            if parent == self.archive:
                                break
                            relative = parent.relative_to(self.archive).as_posix()
                            if relative not in directories:
                                real_path(self.archive, relative)
                                directories[relative] = raw.metadata(parent, parent.lstat(), scratch)
                tick()
                identity = 'assets-' + uuid.uuid4().hex
                tree = {'schema': SCHEMA, 'tree': identity, 'objects': '../raw-store/objects', 'createdAt': time.time(),
                        'baseTree': {'tree': previous['tree'], 'sha256': receipt['treeSha256']},
                        'previousTree': previous['tree'], 'recoveryTools': bundle_tools(self.root),
                        'entries': sorted(entries.values(), key=lambda e: e['path']), 'directories': directories,
                        'legacy': [], 'sourceContainerPolicy': 'unchanged', 'gc': 'none'}
                tree_path, receipt_path = self.paths(identity)
                raw.atomic_json(tree_path, tree)
                os.chmod(tree_path, 0o400)
                receipt = {'treeSha256': raw.sha(tree_path), 'preparedAt': time.time(), 'restoreProof': None,
                           'removalStarted': False, 'sourceFiles': len(entries), 'newObjectBytes': new_bytes}
                raw.atomic_json(receipt_path, receipt)
                self.verify(identity, merged=False)
                # Check the entire base chain before exposing the new generation.
                self.read(identity)
                raw.atomic_json(self.root / 'current.json', {'schema': SCHEMA, 'tree': identity, 'treeSha256': receipt['treeSha256']})
            tick()
            cache = Path(tempfile.gettempdir()) / 'archiv-asset-proofs'
            cache.mkdir(mode=0o700, exist_ok=True)
            if cache.is_symlink():
                raise ValueError('Unsafe maintenance proof cache')
            with tempfile.TemporaryDirectory(prefix='delta-', dir=cache) as tmp:
                proof = self.proof(identity, Path(tmp) / 'view', cleanup=True, delta=True)
            tick()
            result = self.remove(identity, on_unlink=tick, delta=True)
            return {**result, 'maintenance': 'consolidated', 'deltaProofFiles': proof['files'], 'newTree': True, 'pendingFiles': pending_files}
        finally:
            raw.sha = original_sha

    def prepare(self, seconds=300):
        previous = self.current()
        entries = {e['path']: e for e in previous['entries']} if previous else {}
        # A fresh whole-byte audit is the source plan, never a stale inventory file.
        report = auditor.audit(self.archive, seconds)
        permissible = all(e['reason'] == 'declared-payload-missing' for e in report['errors'])
        if not report['inventoryComplete'] or not report['rawPoolComparisonPassed'] or not permissible:
            raise RuntimeError('Fresh audit is not safe for asset preparation')
        if any(not e['allExpectationsResolvable'] for e in report['missingReferences']):
            raise RuntimeError('Unresolved original declaration; originals retained')
        candidates = [e for e in report['files'] if e['category'] == 'standalone-asset']
        started = time.monotonic()
        new_bytes = 0
        with tempfile.TemporaryDirectory(prefix='.metadata-', dir=self.root) as temporary:
            scratch = Path(temporary)
            for index, item in enumerate(candidates):
                name = item['path']
                if not allowed(name):
                    raise ValueError('Candidate outside standalone asset scope')
                source = real_path(self.archive, name)
                info = source.lstat()
                stamp = [item['device'], item['inode'], item['bytes'], item['mtimeNs'], item['ctimeNs'], item['flags']]
                if raw.signature(info) != stamp or info.st_mode != item['mode']:
                    raise RuntimeError('Asset changed since fresh audit')
                meta = raw.metadata(source, info, scratch)
                target = self.pool.object(item['sha256'])
                if not target.exists():
                    new_bytes += item['bytes']
                self.pool.put(source, item['sha256'], item['bytes'], sys.platform == 'darwin')
                if raw.signature(source.lstat()) != stamp:
                    raise RuntimeError('Asset changed while preserving metadata')
                entries[name] = {'path': name, 'type': 'file', 'sha256': item['sha256'], 'size': item['bytes'],
                                 'metadata': meta, 'sourceSignature': stamp}
                if index == 0 or (index + 1) % 500 == 0:
                    print(json.dumps({'phase': 'prepare-assets', 'files': index + 1, 'total': len(candidates), 'seconds': round(time.monotonic()-started, 2)}), flush=True)
            # Aliases are byte proofs of already-missing paths, NOT invented native metadata.
            for issue in report['missingReferences']:
                name = issue['declaredPath']
                recorded = entries.get(name)
                if recorded and all(e['sha256'] == recorded['sha256'] and (e['bytes'] is None or e['bytes'] == recorded['size']) for e in issue['expectations']):
                    self.pool.verify_object(recorded['sha256'], recorded['size'])
                    continue  # Keep original native metadata for previously consolidated files.
                if not allowed(name):
                    raise RuntimeError('Missing non-asset declaration; originals retained')
                expectations = issue['expectations']
                if len(expectations) != 1:
                    raise RuntimeError('Conflicting alias declarations')
                expected = expectations[0]
                digest = expected['sha256']
                size = expected['bytes']
                readable = next((p for p in expected['verifiedReadableCandidates'] if allowed(p)), None)
                if readable:
                    source = real_path(self.archive, readable)
                    size = source.stat().st_size
                    self.pool.put(source, digest, size, sys.platform == 'darwin')
                elif expected['verifiedRawObject']:
                    size = expected['verifiedRawObject']['bytes']
                else:
                    raise RuntimeError('Alias has no standalone recovery candidate')
                self.pool.verify_object(digest, size)
                entries[name] = {'path': name, 'type': 'alias', 'sha256': digest, 'size': size,
                                 'metadata': None, 'provenance': {'declaredPath': name, 'expectedSha256': digest,
                                 'expectedBytes': expected['bytes'], 'verifiedCandidates': expected['verifiedReadableCandidates']}}
            directories = {}
            for name in entries:
                for parent in (self.archive / name).parents:
                    if parent == self.archive:
                        break
                    relative = parent.relative_to(self.archive).as_posix()
                    if relative in directories:
                        continue
                    if parent.exists():
                        p = real_path(self.archive, relative)
                        directories[relative] = raw.metadata(p, p.lstat(), scratch)
                    elif previous and relative in previous.get('directories', {}):
                        directories[relative] = previous['directories'][relative]
        # Preserve old IDs/associations in the resolution layer, not by changing old indexes.
        legacy = []
        legacy_path = self.archive / 'indexes/media.json'
        if legacy_path.exists():
            document = load_json(real_path(self.archive, 'indexes/media.json'))
            for item in document.get('items', []):
                name = item.get('path')
                entry = entries.get(name)
                if entry and item.get('sha256') == entry['sha256'] and item.get('bytes') == entry['size']:
                    legacy.append({'id': str(item.get('mediaId') or item.get('id') or 'sha256:' + entry['sha256']),
                                   'path': name, 'sha256': entry['sha256'], 'size': entry['size'], 'original': item})
        # Do not overwrite a previous generation. Remaining original files must still match.
        for item in candidates:
            info = real_path(self.archive, item['path']).lstat()
            if raw.signature(info) != entries[item['path']]['sourceSignature']:
                raise RuntimeError('Asset changed before tree publication')
        identity = 'assets-' + uuid.uuid4().hex
        tree = {'schema': SCHEMA, 'tree': identity, 'objects': '../raw-store/objects', 'createdAt': time.time(),
                'previousTree': previous['tree'] if previous else None, 'recoveryTools': bundle_tools(self.root), 'entries': sorted(entries.values(), key=lambda e: e['path']),
                'directories': directories, 'legacy': legacy, 'sourceContainerPolicy': 'unchanged', 'gc': 'none'}
        tree_path, receipt_path = self.paths(identity)
        raw.atomic_json(tree_path, tree)
        os.chmod(tree_path, 0o400)
        receipt = {'treeSha256': raw.sha(tree_path), 'preparedAt': time.time(), 'restoreProof': None, 'removalStarted': False,
                   'sourceFiles': len(candidates), 'newObjectBytes': new_bytes}
        raw.atomic_json(receipt_path, receipt)
        self.verify(identity)
        raw.atomic_json(self.root / 'FORMAT.json', {'schema': SCHEMA, 'objects': '../raw-store/objects',
                        'hash': 'sha256', 'metadata': 'POSIX and opaque native AppleDouble', 'gc': 'none'})
        # Publishing first ensures the new reader can always fall back as originals are unlinked.
        raw.atomic_json(self.root / 'current.json', {'schema': SCHEMA, 'tree': identity, 'treeSha256': receipt['treeSha256']})
        return {'tree': identity, 'paths': len(entries), 'aliases': sum(e['type'] == 'alias' for e in entries.values()),
                'newObjectBytes': new_bytes, 'prepared': True, 'sourceFilesRemoved': 0}

    def restore(self, identity, destination, portable=False, prefix='', delta=False):
        tree, receipt = self.verify(identity, merged=not delta)
        if prefix:
            raw.safe_path(prefix)
        entries = [e for e in tree['entries'] if not prefix or e['path'].startswith(prefix + '/') or e['path'] == prefix]
        if not entries:
            raise ValueError('No assets selected')
        destination = Path(destination).absolute()
        if destination.exists() or destination.is_symlink() or destination.resolve() == self.archive or self.archive in destination.resolve().parents:
            raise ValueError('Restore must be a new directory outside the archive')
        destination.parent.mkdir(parents=True, exist_ok=True)
        if shutil.disk_usage(destination.parent).free < sum(e['size'] for e in entries) + RESERVE:
            raise RuntimeError('Restore would cross the five-GiB free-space reserve')
        destination.mkdir(mode=0o700)
        with tempfile.TemporaryDirectory(prefix='.restore-metadata-', dir=self.root) as temporary:
            scratch = Path(temporary)
            for entry in entries:
                relative = entry['path'][len(prefix)+1:] if prefix else entry['path']
                target = destination / relative
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                # Data-only copy: do not leak another same-byte origin's ACL/xattrs/fork.
                with self.pool.verify_object(entry['sha256'], entry['size']).open('rb') as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output, 4 * 1024 * 1024)
                if raw.sha(target) != entry['sha256']:
                    raise RuntimeError('Restored asset bytes mismatch')
                if entry['metadata']:
                    apply_asset_metadata(target, entry['metadata'], scratch, portable=portable)
                else:
                    os.chmod(target, 0o600)  # Already-missing aliases have no native metadata claim.
                if raw.sha(target) != entry['sha256']:
                    raise RuntimeError('Native metadata changed restored data')
            directories = sorted(tree['directories'], key=lambda p: len(Path(p).parts), reverse=True)
            for name in directories:
                if prefix and name != prefix and not name.startswith(prefix + '/'):
                    continue
                relative = name[len(prefix)+1:] if prefix and name != prefix else '' if name == prefix else name
                target = destination / relative
                if target.is_dir():
                    apply_asset_metadata(target, tree['directories'][name], scratch, portable=portable)
        return {'tree': identity, 'files': len(entries), 'originalFiles': sum(e['type'] == 'file' for e in entries),
                'aliases': sum(e['type'] == 'alias' for e in entries), 'bytes': sum(e['size'] for e in entries),
                'destination': str(destination), 'metadataRestore': 'posix-only' if portable else 'native'}

    def proof(self, identity, destination, cleanup=False, delta=False):
        result = self.restore(identity, destination, delta=delta)
        tree, receipt = self.read(identity, merged=not delta)
        provenance_rebindings = []
        with tempfile.TemporaryDirectory(prefix='.proof-metadata-', dir=self.root) as temporary:
            scratch = Path(temporary)
            checks = [(e['path'], e['metadata']) for e in tree['entries'] if e['type'] == 'file'] + list(tree['directories'].items())
            for name, expected in checks:
                target = Path(destination) / name
                actual = raw.metadata(target, target.stat(), scratch)
                if stat.S_IMODE(actual['mode']) != stat.S_IMODE(expected['mode']) or actual['mtime_ns'] != expected['mtime_ns']:
                    raise RuntimeError('Restored POSIX metadata mismatch')
                # Native opaque serialization also proves ACL/xattrs/resourcefork recovery.
                for field in ('appleDouble', 'xattrs'):
                    if actual.get(field) == expected.get(field):
                        continue
                    if field != 'appleDouble' or not actual.get(field) or not expected.get(field):
                        raise RuntimeError('Restored extended metadata mismatch')
                    original_view, original_id = provenance_view(expected[field])
                    restored_view, restored_id = provenance_view(actual[field])
                    if not original_id or not restored_id or original_view != restored_view:
                        raise RuntimeError('Restored extended metadata mismatch outside OS provenance ID')
                    provenance_rebindings.append({'path': name, 'attribute': 'com.apple.provenance',
                                                   'original': original_id, 'restored': restored_id,
                                                   'originalCompleteMetadataRetained': True})
        result['metadataRestore'] = 'native-with-recorded-provenance-rebinding' if provenance_rebindings else 'native'
        raw.atomic_json(self.paths(identity)[1], {**receipt, ('deltaRestoreProof' if delta else 'restoreProof'): {'verifiedAt': time.time(),
                        'treeSha256': receipt['treeSha256'], 'metadataRestore': 'native-with-recorded-provenance-rebinding' if provenance_rebindings else 'native', 'files': result['files'],
                        'bytes': result['bytes'], 'nativeDirectoryMetadataVerified': len(tree['directories']), 'provenanceRebindings': provenance_rebindings, 'metadataProofPolicy': 'only-8-byte-provenance-id-v1'}})
        if cleanup:
            shutil.rmtree(destination)  # Only the new isolated directory created by restore above.
        return {**result, 'restoreProof': True, 'temporaryRestoreRemoved': cleanup, 'metadataProofPolicy': 'only-8-byte-provenance-id-v1', 'provenanceRebindings': len(provenance_rebindings)}

    def remove(self, identity, on_unlink=lambda count: None, delta=False):
        tree, receipt = self.verify(identity, merged=not delta)  # Fresh independent object pass at destructive boundary.
        current = self.current()
        if not current or current['tree'] != identity:
            raise RuntimeError('Only the published current tree can be consolidated')
        proof = receipt.get('deltaRestoreProof' if delta else 'restoreProof') or {}
        if proof.get('treeSha256') != receipt['treeSha256'] or proof.get('files') != len(tree['entries']) or proof.get('metadataRestore') not in ('native', 'native-with-recorded-provenance-rebinding') or proof.get('metadataProofPolicy') != 'only-8-byte-provenance-id-v1':
            raise RuntimeError('Full native restore proof is required before removal')
        remaining = []
        for entry in tree['entries']:
            if entry['type'] != 'file':
                continue
            try:
                source = real_path(self.archive, entry['path'])
            except FileNotFoundError:
                continue  # Old committed refs / interrupted removal remain recoverable.
            if raw.signature(source.lstat()) != entry['sourceSignature']:
                raise RuntimeError('Source changed before removal; originals retained')
            remaining.append(entry)
        raw.atomic_json(self.paths(identity)[1], {**receipt, 'removalStarted': True})
        removed_bytes = 0
        for count, entry in enumerate(remaining, 1):
            source = real_path(self.archive, entry['path'])
            if raw.signature(source.lstat()) != entry['sourceSignature'] or raw.sha(source) != entry['sha256']:
                raise RuntimeError('Source changed immediately before unlink')
            # Re-open and compare identity after hashing; unknown additions are never traversed/deleted.
            if raw.signature(source.lstat()) != entry['sourceSignature']:
                raise RuntimeError('Source changed while verifying unlink')
            self.pool.verify_object(entry['sha256'], entry['size'])
            source.unlink()
            removed_bytes += entry['size']
            on_unlink(count)
            if count == 1 or count % 500 == 0:
                print(json.dumps({'phase': 'remove-assets', 'files': count, 'total': len(remaining)}), flush=True)
        raw.atomic_json(self.paths(identity)[1], {**receipt, 'removalStarted': True, 'removalCompletedAt': time.time(),
                        'removedFilesThisPass': len(remaining), 'removedLogicalBytesThisPass': removed_bytes})
        return {'tree': identity, 'removedFiles': len(remaining), 'removedLogicalBytes': removed_bytes}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True)
    sub = parser.add_subparsers(dest='command', required=True)
    prepare = sub.add_parser('prepare')
    prepare.add_argument('--deadline-seconds', type=float, default=300)
    maintain = sub.add_parser('maintain')
    maintain.add_argument('--enable', action='store_true')
    maintain.add_argument('--deadline-seconds', type=float, default=20)
    maintain.add_argument('--max-files', type=int, default=128)
    maintain.add_argument('--max-bytes', type=int, default=1024 ** 3)
    verify = sub.add_parser('verify')
    verify.add_argument('--tree')
    restore = sub.add_parser('restore')
    restore.add_argument('--tree')
    restore.add_argument('--destination', required=True)
    restore.add_argument('--prefix', default='')
    restore.add_argument('--portable', action='store_true')
    proof = sub.add_parser('proof')
    proof.add_argument('--tree')
    proof.add_argument('--destination', required=True)
    proof.add_argument('--cleanup', action='store_true')
    remove = sub.add_parser('remove')
    remove.add_argument('--tree')
    args = parser.parse_args()
    if args.command == 'maintain':
        def interrupted(signum, frame):
            raise TimeoutError('Asset maintenance interrupted; originals retained')
        signal.signal(signal.SIGTERM, interrupted)
    assets = Assets(args.archive, create=args.command == 'prepare')
    with assets.pool.lock():
        if args.command == 'prepare':
            result = assets.prepare(args.deadline_seconds)
        elif args.command == 'maintain':
            result = assets.maintain(args.enable, args.deadline_seconds, args.max_files, args.max_bytes)
        else:
            identity = args.tree or (assets.current() or {}).get('tree')
            if not identity:
                raise ValueError('No prepared asset tree')
            if args.command == 'verify':
                tree, receipt = assets.verify(identity)
                result = {'verified': identity, 'paths': len(tree['entries']), 'treeSha256': receipt['treeSha256']}
            elif args.command == 'restore':
                result = assets.restore(identity, args.destination, args.portable, args.prefix)
            elif args.command == 'proof':
                result = assets.proof(identity, args.destination, args.cleanup)
            elif args.command == 'remove':
                result = assets.remove(identity)
        print(json.dumps(result), flush=True)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': type(error).__name__, 'detail': str(error), 'unknownFilesNotDeleted': True}), file=sys.stderr)
        sys.exit(1)
