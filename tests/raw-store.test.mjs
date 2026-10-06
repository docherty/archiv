import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, symlink, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const script = new URL('../scripts/raw-store.py', import.meta.url).pathname;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function run(store, ...args) { return execFileSync('python3', [script, '--store', store, ...args], { encoding: 'utf8' }); }
async function snapshot(root, id, bytes = 'unknown raw payload\r\nretained exactly') {
  const source = path.join(root, id);
  await mkdir(path.join(source, 'user-data', 'Default', 'empty'), { recursive: true });
  await writeFile(path.join(source, 'user-data', 'Default', 'record'), bytes);
  await writeFile(path.join(source, 'snapshot.manifest.json'), JSON.stringify({ snapshotId: id, files: [{ path: 'Default/record', size: Buffer.byteLength(bytes), sha256: digest(bytes) }] }));
  return source;
}
async function fixture(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archiv-cas-test-'));
  try { await fn(root, path.join(root, 'store')); } finally { await rm(root, { recursive: true, force: true }); }
}

test('raw store deduplicates bytes, keeps different historical versions and restores independent writable files', async () => fixture(async (root, store) => {
  const ids = ['snapshot-2026-01-01T00-00-00-000Z', 'snapshot-2026-01-02T00-00-00-000Z', 'snapshot-2026-01-03T00-00-00-000Z'];
  for (let i = 0; i < ids.length; i++) {
    const source = await snapshot(root, ids[i], i === 2 ? 'later version' : undefined);
    await writeFile(path.join(source, 'unindexed-unknown-record'), 'future use');
    run(store, 'ingest', '--source', source, '--remove-source', ...(process.platform === 'darwin' ? ['--require-clone'] : []));
    assert.equal((await readdir(root)).includes(ids[i]), false);
  }
  const trees = await Promise.all(ids.map(async (id) => JSON.parse(await readFile(path.join(store, 'trees', `${id}.json`)))));
  const hash = (tree) => tree.entries.find((e) => e.path.endsWith('/record')).sha256;
  assert.equal(hash(trees[0]), hash(trees[1]));
  assert.notEqual(hash(trees[1]), hash(trees[2]));
  run(store, 'verify');
  const restored = path.join(root, 'restored');
  run(store, 'restore', '--snapshot', ids[0], '--destination', restored);
  assert.equal(await readFile(path.join(restored, 'unindexed-unknown-record'), 'utf8'), 'future use');
  assert.ok((await stat(path.join(restored, 'user-data/Default/empty'))).isDirectory());
  await writeFile(path.join(restored, 'user-data/Default/record'), 'browser can change checkout');
  assert.equal(await readFile(path.join(store, 'objects', hash(trees[0]).slice(0, 2), hash(trees[0])), 'utf8'), 'unknown raw payload\r\nretained exactly');
}));

test('raw store preserves macOS extended metadata and timestamp/mode', { skip: process.platform !== 'darwin' }, async () => fixture(async (root, store) => {
  const source = await snapshot(root, 'snapshot-2026-01-01T00-00-00-000Z');
  const file = path.join(source, 'user-data/Default/record');
  execFileSync('/usr/bin/xattr', ['-w', 'user.archiv.test', 'opaque unknown metadata', file]);
  execFileSync('/bin/chmod', ['+a', `${os.userInfo().username} allow read,write`, file]);
  await chmod(file, 0o640);
  await writeFile(`${file}/..namedfork/rsrc`, 'original resource fork');
  const before = await stat(file);
  run(store, 'ingest', '--source', source, '--remove-source', '--require-clone');
  const restored = path.join(root, 'restored');
  run(store, 'restore', '--snapshot', path.basename(source), '--destination', restored, '--require-clone');
  const result = path.join(restored, 'user-data/Default/record');
  assert.equal(execFileSync('/usr/bin/xattr', ['-p', 'user.archiv.test', result], { encoding: 'utf8' }).trim(), 'opaque unknown metadata');
  assert.equal(await readFile(`${result}/..namedfork/rsrc`, 'utf8'), 'original resource fork');
  assert.match(execFileSync('/bin/ls', ['-le', result], { encoding: 'utf8' }), /allow read,write/);
  assert.equal((await stat(result)).mode, before.mode);
  assert.equal((await stat(result)).mtimeMs, before.mtimeMs);
}));

test('raw store records changed Finder metadata but never excuses other payload mismatches', async () => fixture(async (root, store) => {
  const source = await snapshot(root, 'snapshot-2026-01-01T00-00-00-000Z');
  const file = path.join(source, 'user-data/.DS_Store');
  await writeFile(file, 'current Finder state');
  const manifestPath = path.join(source, 'snapshot.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath));
  manifest.files.push({ path: '.DS_Store', size: 3, sha256: digest('old') });
  await writeFile(manifestPath, JSON.stringify(manifest));
  run(store, 'ingest', '--source', source, '--remove-source');
  const tree = JSON.parse(await readFile(path.join(store, 'trees', `${path.basename(source)}.json`)));
  assert.equal(tree.originalManifestDiscrepancies.length, 1);
  assert.equal(tree.originalManifestDiscrepancies[0].preservedSha256, digest('current Finder state'));
  const restored = path.join(root, 'portable-restored');
  run(store, 'restore', '--snapshot', path.basename(source), '--destination', restored, '--portable');
  assert.equal(await readFile(path.join(restored, 'user-data/.DS_Store'), 'utf8'), 'current Finder state');
  assert.throws(() => run(store, 'restore', '--snapshot', path.basename(source), '--destination', restored), /must not exist/);
  assert.throws(() => run(store, 'restore', '--snapshot', path.basename(source), '--destination', path.join(store, 'checkout')), /outside the immutable store/);
}));

test('raw store refuses deletion on source checksum mismatch and unsupported symlinks', async () => fixture(async (root, store) => {
  const source = await snapshot(root, 'snapshot-2026-01-01T00-00-00-000Z');
  await writeFile(path.join(source, 'user-data/Default/record'), 'corruption');
  assert.throws(() => run(store, 'ingest', '--source', source, '--remove-source'), /checksum mismatch/);
  assert.ok((await stat(source)).isDirectory());
  await symlink(root, path.join(source, 'external'));
  assert.throws(() => run(store, 'ingest', '--source', source, '--remove-source'), /Unsupported file type/);
}));

test('raw store verifies objects again before deleting originals; corrupt object or tree blocks deletion', async () => fixture(async (root, store) => {
  const id = 'snapshot-2026-01-01T00-00-00-000Z';
  const source = await snapshot(root, id);
  run(store, 'ingest', '--source', source);
  const hash = digest('unknown raw payload\r\nretained exactly');
  const object = path.join(store, 'objects', hash.slice(0, 2), hash);
  await chmod(object, 0o600);
  await writeFile(object, 'unknown raw payload\r\nretained exactlZ');
  assert.throws(() => run(store, 'ingest', '--source', source, '--remove-source'), /Corrupt object/);
  assert.ok((await stat(source)).isDirectory());
  const tree = path.join(store, 'trees', `${id}.json`);
  await chmod(tree, 0o600);
  await writeFile(tree, '{}');
  assert.throws(() => run(store, 'verify'), /Tree checksum mismatch/);
}));

test('raw store retains incomplete snapshots without claiming original-manifest verification', async () => fixture(async (root, store) => {
  const source = await snapshot(root, 'snapshot-2026-01-01T00-00-00-000Z');
  await rm(path.join(source, 'snapshot.manifest.json'));
  run(store, 'ingest', '--source', source, '--remove-source');
  const tree = JSON.parse(await readFile(path.join(store, 'trees', `${path.basename(source)}.json`)));
  assert.equal(tree.sourceManifestPresent, false);
}));

test('raw store resumes interrupted removal but refuses unknown new files', async () => fixture(async (root, store) => {
  const id = 'snapshot-2026-01-01T00-00-00-000Z';
  const source = await snapshot(root, id);
  run(store, 'ingest', '--source', source);
  const receipt = path.join(store, 'receipts', `${id}.json`);
  const data = JSON.parse(await readFile(receipt));
  await writeFile(receipt, JSON.stringify({ ...data, removalStarted: true }));
  await rm(path.join(source, 'snapshot.manifest.json'));
  await writeFile(path.join(source, 'new-unknown'), 'must survive');
  assert.throws(() => run(store, 'ingest', '--source', source, '--remove-source'), /differs from source paths/);
  assert.equal(await readFile(path.join(source, 'new-unknown'), 'utf8'), 'must survive');
  await rm(path.join(source, 'new-unknown'));
  run(store, 'ingest', '--source', source, '--remove-source');
  assert.equal((await readdir(root)).includes(id), false);
  run(store, 'verify');
}));

test('verified capture journal updates never mutate the pre-decoder raw tree', async () => fixture(async (root, store) => {
  const id = 'snapshot-2026-01-01T00-00-00-000Z';
  const source = await snapshot(root, id);
  run(store, 'ingest', '--source', source);
  const treePath = path.join(store, 'trees', `${id}.json`);
  const before = await readFile(treePath);
  const capture = 'capture-2026-01-01T00-00-01-000Z';
  const folder = path.join(root, 'captures', capture); await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'capture.manifest.json'), JSON.stringify({ snapshot: id }));
  const verification = path.join(folder, 'capture.verification.json');
  await writeFile(verification, JSON.stringify({ ok: false }));
  assert.throws(() => run(store, 'record-capture', '--snapshot', id, '--capture', capture), /does not verify/);
  await writeFile(verification, JSON.stringify({ ok: true }));
  run(store, 'record-capture', '--snapshot', id, '--capture', capture);
  assert.deepEqual(await readFile(treePath), before);
  run(store, 'ingest', '--source', source, '--remove-source');
  assert.equal(JSON.parse(await readFile(path.join(store, 'receipts', `${id}.json`))).capture.verified, true);
}));

test('system Python launchd compatibility supports real hashing, commit and restore', { skip: process.platform !== 'darwin' }, async () => fixture(async (root, store) => {
  const source = await snapshot(root, 'snapshot-2026-01-01T00-00-00-000Z');
  const args = [script, '--store', store];
  execFileSync('/usr/bin/python3', [...args, 'ingest', '--source', source, '--remove-source', '--require-clone']);
  execFileSync('/usr/bin/python3', [...args, 'restore', '--snapshot', path.basename(source), '--destination', path.join(root, 'system-python-restore'), '--require-clone']);
  assert.equal(await readFile(path.join(root, 'system-python-restore/user-data/Default/record'), 'utf8'), 'unknown raw payload\r\nretained exactly');
}));

test('raw store refuses existing restore targets, path traversal and overlapping trees', async () => fixture(async (root, store) => {
  const source = await snapshot(root, 'snapshot-2026-01-01T00-00-00-000Z');
  const manifest = path.join(source, 'snapshot.manifest.json');
  await writeFile(manifest, JSON.stringify({ snapshotId: path.basename(source), files: [{ path: '../../outside', size: 0, sha256: digest('') }] }));
  assert.throws(() => run(store, 'ingest', '--source', source), /Unsafe tree path/);
  const overlap = spawnSync('python3', [script, '--store', path.join(source, 'nested-store'), 'ingest', '--source', source], { encoding: 'utf8' });
  assert.notEqual(overlap.status, 0);
  assert.match(overlap.stderr, /must not overlap/);
}));
