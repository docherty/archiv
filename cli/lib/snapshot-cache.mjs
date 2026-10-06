import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { persistRawSnapshot } from './raw-store.mjs';

const MIN_FREE_BYTES = 5 * 1024 ** 3;

async function canonicalPath(value) {
  try { return await realpath(value); } catch (error) {
    if (error.code !== 'ENOENT' || path.dirname(value) === value) throw error;
    return path.join(await canonicalPath(path.dirname(value)), path.basename(value));
  }
}

export async function prepareSnapshotCache(directory, sourceDirectory, { minimumFreeBytes = MIN_FREE_BYTES } = {}) {
  const root = path.resolve(directory);
  const source = await canonicalPath(path.resolve(sourceDirectory));
  const resolved = await canonicalPath(root);
  const overlaps = (a, b) => a === b || a.startsWith(`${b}${path.sep}`);
  if (overlaps(resolved, source) || overlaps(source, resolved)) throw new Error('Snapshot cache must be separate from the live browser data.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Snapshot cache must be a real directory, not a symlink.');
  await chmod(root, 0o700);
  const space = await statfs(root);
  const free = Number(space.bavail) * Number(space.bsize);
  if (free < minimumFreeBytes) throw new Error(`Insufficient disk space for Venice capture: ${(free / 1024 ** 3).toFixed(2)} GiB free; keep at least ${(minimumFreeBytes / 1024 ** 3).toFixed(0)} GiB free. No browser copy was started.`);
  return root;
}

// Preserve the primary failure even if a synced directory recreates metadata during removal.
export async function cleanupFailedSnapshot(root, originalError, { remove = rm, onProgress = () => {} } = {}) {
  try {
    await remove(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  } catch (cleanupError) {
    originalError.cleanupError = cleanupError;
    try { onProgress(`Snapshot cleanup also failed: ${cleanupError.message}. Original capture error: ${originalError.message}`); } catch {}
  }
  throw originalError;
}

export async function markSnapshotCaptured(snapshotRoot, captureId, { outsideSnapshot = false, comparisonOnly = false } = {}) {
  if (!captureId || typeof captureId !== 'string') throw new Error('Missing verified capture identity.');
  const receipts = path.join(path.dirname(snapshotRoot), '.capture-receipts');
  if (outsideSnapshot) await mkdir(receipts, { recursive: true, mode: 0o700 });
  const destination = outsideSnapshot ? path.join(receipts, `${path.basename(snapshotRoot)}.json`) : path.join(snapshotRoot, 'capture.receipt.json');
  await writeFile(destination, `${JSON.stringify({ verified: true, captureId, comparisonOnly, capturedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
}

export async function pruneSnapshotCache(directory, currentSnapshot, keep = 2, { archiveDirectory = null } = {}) {
  if (!Number.isSafeInteger(keep) || keep < (archiveDirectory ? 1 : 2)) throw new Error('Keep at least two managed snapshots unless raw history is durably archived.');
  const root = path.resolve(directory);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || path.dirname(path.resolve(currentSnapshot)) !== root) throw new Error('Unsafe snapshot cache pruning path.');
  const candidates = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^snapshot-[\dTZ-]+$/.test(entry.name)) continue;
    const target = path.join(root, entry.name);
    try {
      const manifest = JSON.parse(await readFile(path.join(target, 'snapshot.manifest.json'), 'utf8'));
      let receipt;
      try { receipt = JSON.parse(await readFile(path.join(root, '.capture-receipts', `${entry.name}.json`), 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try { receipt = JSON.parse(await readFile(path.join(target, 'capture.receipt.json'), 'utf8')); }
        catch (legacyError) {
          if (legacyError.code !== 'ENOENT' || !archiveDirectory) throw legacyError;
          const archived = JSON.parse(await readFile(path.join(archiveDirectory, 'raw-store/receipts', `${entry.name}.json`), 'utf8'));
          // Decoder success is not the preservation criterion. This is only an
          // eligibility hint; destructive persistence rehashes the full raw tree.
          if (!/^[a-f0-9]{64}$/.test(archived.treeSha256)) throw new Error('No committed raw history');
          receipt = { verified: true, captureId: 'raw-history-only' };
        }
      }
      // Only new, explicitly managed copies qualify. Legacy safety copies and incomplete runs are untouched.
      if (receipt.verified === true && typeof receipt.captureId === 'string' && manifest.snapshotId === entry.name && manifest.managedCache === root && manifest.sourceConsistency?.stableDuringCopy === true) candidates.push(target);
    } catch {}
  }
  if (!candidates.includes(path.resolve(currentSnapshot))) throw new Error('Current snapshot is not a stable managed cache entry.');
  candidates.sort().reverse();
  const preserved = new Set([path.resolve(currentSnapshot), ...candidates.filter((target) => target !== path.resolve(currentSnapshot)).slice(0, keep - 1)]);
  const removed = [];
  for (const target of candidates) {
    if (preserved.has(target)) continue;
    if (archiveDirectory) await persistRawSnapshot(archiveDirectory, target, { removeSource: true });
    else await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
    await rm(path.join(root, '.capture-receipts', `${path.basename(target)}.json`), { force: true });
    removed.push(path.basename(target));
  }
  return removed;
}
