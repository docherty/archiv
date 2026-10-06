import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { pathExists } from './util.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/raw-store.py', import.meta.url));
const ID = /^snapshot-[0-9TZ-]+$/;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const rawStoreDirectory = (archive) => path.join(archive, 'raw-store');
export function defaultSnapshotCache(archive) {
  const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Caches') : path.join(os.homedir(), '.cache');
  return path.join(base, 'archiv', digest(path.resolve(archive)).slice(0, 20), 'snapshots');
}

export async function runRawStore(archive, args, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ARCHIV_PYTHON || 'python3', [SCRIPT, '--store', rawStoreDirectory(archive), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out = (out + chunk).slice(-20000); });
    child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-20000); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(`Raw history persistence failed (${code}): ${err.trim()}`));
      try { onProgress('Raw history checksum-verified in the deduplicated archive'); } catch {}
      resolve(out);
    });
  });
}

export async function persistRawSnapshot(archive, source, { removeSource = false, requireClone = process.platform === 'darwin', onProgress } = {}) {
  return runRawStore(archive, ['ingest', '--source', source, ...(removeSource ? ['--remove-source'] : []), ...(requireClone ? ['--require-clone'] : [])], onProgress);
}

export async function recordRawCaptureResult(archive, identity, result) {
  // A successful no-op compares against a prior verified capture; it does not
  // create a new decoded capture of this raw snapshot. Keep that distinction.
  if (result.unchanged === true) return;
  return runRawStore(archive, ['record-capture', '--snapshot', identity, '--capture', result.captureId]);
}

export async function retainFailedRawSnapshot(archive, source, originalError) {
  try {
    await persistRawSnapshot(archive, source, { removeSource: true });
    console.warn('[raw-store] Decoding failed, but the complete raw source is independently preserved in archive history');
  } catch (persistenceError) {
    originalError.rawHistoryPersistenceError = persistenceError;
    console.warn(`[raw-store] Raw persistence also failed; original working copy retained: ${persistenceError.message}`);
  }
  throw originalError;
}
export async function archivedSnapshots(archive) {
  try {
    return (await readdir(path.join(rawStoreDirectory(archive), 'trees'))).filter((name) => name.endsWith('.json') && ID.test(name.slice(0, -5))).map((name) => name.slice(0, -5)).sort();
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// Reading the small original manifest does not require materializing browser data.
export async function archivedSnapshotManifest(archive, identity) {
  if (!ID.test(identity)) throw new Error('Invalid archived snapshot identity');
  const root = rawStoreDirectory(archive);
  const bytes = await readFile(path.join(root, 'trees', `${identity}.json`));
  const receipt = JSON.parse(await readFile(path.join(root, 'receipts', `${identity}.json`), 'utf8'));
  if (digest(bytes) !== receipt.treeSha256) throw new Error('Raw tree checksum mismatch');
  const tree = JSON.parse(bytes);
  if (tree.schema !== 'archiv.raw-store.v1' || tree.snapshotId !== identity) throw new Error('Unsupported raw tree');
  const entry = tree.entries.find((item) => item.path === 'snapshot.manifest.json' && item.type === 'file');
  if (!entry) return null; // Incomplete historical copies are preserved but not claimed consistent.
  if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid raw manifest object');
  const original = await readFile(path.join(root, 'objects', entry.sha256.slice(0, 2), entry.sha256));
  if (original.length !== entry.size || digest(original) !== entry.sha256) throw new Error('Raw manifest object checksum mismatch');
  return JSON.parse(original);
}

export async function latestArchivedSnapshot(archive, profile = null) {
  for (const identity of (await archivedSnapshots(archive)).reverse()) {
    const manifest = await archivedSnapshotManifest(archive, identity);
    if (manifest && (!profile || manifest.profile?.directoryName === profile) && manifest.sourceConsistency?.stableDuringCopy === true) return { identity, manifest };
  }
  return null;
}

export async function withRawSnapshot(archive, requested, action) {
  if (requested !== 'latest' && await pathExists(path.join(path.resolve(requested), 'user-data'))) return action(path.resolve(requested));
  const identity = requested === 'latest' ? (await latestArchivedSnapshot(archive))?.identity : path.basename(requested).replace(/\.json$/, '');
  if (!identity || !ID.test(identity)) throw new Error('No complete archived raw snapshot is available');
  // Private, throwaway reconstruction; never a hardlink into the immutable store.
  const parent = await mkdtemp(path.join(os.tmpdir(), 'archiv-raw-restore-'));
  const restored = path.join(parent, identity);
  try {
    await runRawStore(archive, ['restore', '--snapshot', identity, '--destination', restored, ...(process.platform === 'darwin' ? ['--require-clone'] : [])]);
    return await action(restored);
  } finally { await rm(parent, { recursive: true, force: true, maxRetries: 3 }); }
}
