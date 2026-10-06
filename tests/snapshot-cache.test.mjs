import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupFailedSnapshot, prepareSnapshotCache, markSnapshotCaptured, pruneSnapshotCache } from '../cli/lib/snapshot-cache.mjs';
import { createRawSnapshot, verifyRawSnapshot } from '../cli/lib/snapshot.mjs';
import { extractSnapshot } from '../cli/lib/extract.mjs';
import { persistRawSnapshot, retainFailedRawSnapshot, archivedSnapshotManifest, withRawSnapshot } from '../cli/lib/raw-store.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archiv-cache-test-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const browserRoot = path.join(root, 'browser');
  const profileRoot = path.join(browserRoot, 'Default');
  await mkdir(path.join(profileRoot, 'IndexedDB/https_venice.ai_0.indexeddb.leveldb'), { recursive: true });
  await writeFile(path.join(profileRoot, 'Preferences'), '{}');
  await writeFile(path.join(profileRoot, 'IndexedDB/https_venice.ai_0.indexeddb.leveldb/000001.log'), 'fixture journal');
  return { root, setup: { archiveDirectory: path.join(root, 'archive'), browser: { id: 'fixture', name: 'Fixture', executable: '/no/such/fixture-browser', userDataDirectory: browserRoot }, profile: { directoryName: 'Default', name: 'Fixture', path: profileRoot } } };
}

test('ENOTEMPTY cleanup cannot replace the original capture error', async () => {
  const original = Object.assign(new Error('disk full during copy'), { code: 'ENOSPC' });
  const secondary = Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
  const messages = [];
  await assert.rejects(cleanupFailedSnapshot('/fixture/snapshot', original, {
    remove: async (_root, options) => { assert.equal(options.maxRetries, 3); assert.equal(options.retryDelay, 250); throw secondary; },
    onProgress: (message) => messages.push(message)
  }), (error) => error === original && error.code === 'ENOSPC' && error.cleanupError === secondary);
  assert.match(messages[0], /Original capture error: disk full/);
  await assert.rejects(cleanupFailedSnapshot('/fixture/snapshot', original, { remove: async () => { throw secondary; }, onProgress: () => { throw Error('observer failed'); } }), (error) => error === original);
});

test('failed raw copies remove their partial directory and preserve the cause', async (t) => {
  const { setup } = await fixture(t);
  const error = Object.assign(new Error('fixture copy failure'), { code: 'ENOSPC' });
  await assert.rejects(createRawSnapshot({ ...setup, onProgress: () => { throw error; } }), (failure) => failure === error);
  assert.deepEqual(await readdir(path.join(setup.archiveDirectory, 'raw-snapshots')), []);
  assert.equal(await readFile(path.join(setup.profile.path, 'Preferences'), 'utf8'), '{}');
});

test('private snapshot cache rejects low space and live-profile paths, including parent symlinks', async (t) => {
  const { root, setup } = await fixture(t);
  const cache = path.join(root, 'cache');
  await assert.rejects(prepareSnapshotCache(cache, setup.browser.userDataDirectory, { minimumFreeBytes: Number.MAX_SAFE_INTEGER }), /Insufficient disk space.*No browser copy was started/);
  assert.deepEqual(await readdir(cache), []);
  await assert.rejects(prepareSnapshotCache(path.join(setup.profile.path, 'cache'), setup.browser.userDataDirectory), /separate from the live browser/);
  const alias = path.join(root, 'browser-alias'); await symlink(setup.browser.userDataDirectory, alias);
  await assert.rejects(prepareSnapshotCache(path.join(alias, 'cache'), setup.browser.userDataDirectory), /separate from the live browser/);
  await prepareSnapshotCache(cache, setup.browser.userDataDirectory, { minimumFreeBytes: 0 });
  assert.equal((await stat(cache)).mode & 0o777, 0o700);
});

test('managed snapshots stay local, verify, reuse hashes and prune only their own superseded copies', async (t) => {
  const { root, setup } = await fixture(t);
  const legacy = await createRawSnapshot(setup);
  const cache = path.join(root, 'cache');
  const copies = [];
  for (let i = 0; i < 4; i++) {
    const copy = await createRawSnapshot({ ...setup, snapshotDirectory: cache, minimumFreeBytes: 0, requireClone: process.platform === 'darwin' });
    await markSnapshotCaptured(copy.snapshotRoot, `capture-fixture-${i}`);
    copies.push(copy);
  }
  const current = copies.at(-1);
  assert.equal(current.manifest.managedCache, cache);
  assert.ok(current.manifest.integrity.reusedHashes >= 1);
  assert.equal((await verifyRawSnapshot(current.snapshotRoot)).ok, true);
  if (process.platform === 'darwin') assert.equal(current.manifest.cloneRequired, true);
  const historical = path.join(cache, 'snapshot-2000-01-01T00-00-00-000Z'); await mkdir(historical);
  await writeFile(path.join(historical, 'snapshot.manifest.json'), JSON.stringify({ snapshotId: path.basename(historical), sourceConsistency: { stableDuringCopy: true } }));
  const partial = path.join(cache, 'snapshot-2001-01-01T00-00-00-000Z'); await mkdir(partial);
  const uncaptured = path.join(cache, 'snapshot-2003-01-01T00-00-00-000Z'); await mkdir(uncaptured);
  await writeFile(path.join(uncaptured, 'snapshot.manifest.json'), JSON.stringify({ snapshotId: path.basename(uncaptured), managedCache: cache, sourceConsistency: { stableDuringCopy: true } }));
  await symlink(legacy.snapshotRoot, path.join(cache, 'snapshot-2002-01-01T00-00-00-000Z'));
  assert.equal((await pruneSnapshotCache(cache, current.snapshotRoot, 2)).length, 2);
  assert.equal((await verifyRawSnapshot(legacy.snapshotRoot)).ok, true);
  assert.equal((await verifyRawSnapshot(current.snapshotRoot)).ok, true);
  assert.ok((await stat(historical)).isDirectory()); assert.ok((await stat(partial)).isDirectory());
  assert.ok((await stat(uncaptured)).isDirectory()); // Stable copy with failed extraction can hold unique recovery data.
  await assert.rejects(pruneSnapshotCache(cache, historical, 2), /not a stable managed/);
  await assert.rejects(pruneSnapshotCache(cache, current.snapshotRoot, 0), /at least two/);
});

test('one working copy is safe only with durable raw history; restores and integrity reuse survive cache removal', async (t) => {
  const { root, setup } = await fixture(t);
  const cache = path.join(root, 'cache');
  const copies = [];
  for (let i = 0; i < 2; i++) {
    const copy = await createRawSnapshot({ ...setup, snapshotDirectory: cache, minimumFreeBytes: 0, requireClone: process.platform === 'darwin' });
    if (i > 0) await markSnapshotCaptured(copy.snapshotRoot, `capture-fixture-${i}`, { outsideSnapshot: true });
    await persistRawSnapshot(setup.archiveDirectory, copy.snapshotRoot);
    copies.push(copy);
  }
  const current = copies.at(-1);
  assert.equal((await pruneSnapshotCache(cache, current.snapshotRoot, 1, { archiveDirectory: setup.archiveDirectory })).length, 1);
  assert.equal((await readdir(cache)).filter((name) => name.startsWith('snapshot-')).length, 1);
  assert.equal((await archivedSnapshotManifest(setup.archiveDirectory, copies[0].manifest.snapshotId)).snapshotId, copies[0].manifest.snapshotId);
  await persistRawSnapshot(setup.archiveDirectory, current.snapshotRoot, { removeSource: true });
  const next = await createRawSnapshot({ ...setup, snapshotDirectory: cache, minimumFreeBytes: 0 });
  assert.ok(next.manifest.integrity.reusedHashes >= 1);
  let temporary;
  await withRawSnapshot(setup.archiveDirectory, copies[0].manifest.snapshotId, async (restored) => {
    temporary = restored;
    assert.equal((await verifyRawSnapshot(restored)).ok, true);
    assert.equal(await readFile(path.join(restored, 'user-data/Default/Preferences'), 'utf8'), '{}');
  });
  await assert.rejects(stat(temporary), /ENOENT/);
});

test('decoder failure still archives raw unknown data and cannot hide the original error', async (t) => {
  const { root, setup } = await fixture(t);
  const copy = await createRawSnapshot({ ...setup, snapshotDirectory: path.join(root, 'cache'), minimumFreeBytes: 0 });
  const error = new Error('future unknown Venice schema');
  await assert.rejects(retainFailedRawSnapshot(setup.archiveDirectory, copy.snapshotRoot, error), (result) => result === error);
  await assert.rejects(stat(copy.snapshotRoot), /ENOENT/);
  assert.equal((await archivedSnapshotManifest(setup.archiveDirectory, copy.manifest.snapshotId)).snapshotId, copy.manifest.snapshotId);
  const next = await createRawSnapshot({ ...setup, snapshotDirectory: path.join(root, 'cache'), minimumFreeBytes: 0 });
  const invalidArchive = path.join(root, 'invalid-archive'); await writeFile(invalidArchive, 'not a directory');
  const secondError = new Error('decoder failure plus disk error');
  await assert.rejects(retainFailedRawSnapshot(invalidArchive, next.snapshotRoot, secondError), (result) => result === secondError && Boolean(result.rawHistoryPersistenceError));
  assert.equal((await verifyRawSnapshot(next.snapshotRoot)).ok, true);
});

test('browser startup failure cleans the disposable extraction workspace', async (t) => {
  const { setup } = await fixture(t);
  const snapshot = await createRawSnapshot(setup);
  const before = new Set((await readdir(os.tmpdir())).filter((name) => name.startsWith('venice-archive-browser-')));
  await assert.rejects(extractSnapshot({ snapshotRoot: snapshot.snapshotRoot, archiveDirectory: setup.archiveDirectory, browser: setup.browser, profileDirectory: 'Default', projectRoot: path.dirname(setup.archiveDirectory) }), /ENOENT/);
  assert.deepEqual((await readdir(os.tmpdir())).filter((name) => name.startsWith('venice-archive-browser-') && !before.has(name)), []);
  assert.equal((await verifyRawSnapshot(snapshot.snapshotRoot)).ok, true);
});
