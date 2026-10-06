import { constants as fsConstants } from 'node:fs';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDirectory, listFiles, pathExists, run, sha256File, timestampId } from './util.mjs';
import { cleanupFailedSnapshot, prepareSnapshotCache } from './snapshot-cache.mjs';
import { copySnapshotPath as cp } from './snapshot-copy.mjs';
import { latestArchivedSnapshot } from './raw-store.mjs';

const PROFILE_PATHS = [
  'Preferences',
  'Secure Preferences',
  'IndexedDB/https_venice.ai_0.indexeddb.leveldb',
  'IndexedDB/https_venice.ai_0.indexeddb.blob',
  'File System',
  'Local Storage/leveldb',
  'Session Storage',
  'Network/Cookies',
  'Network/Cookies-journal'
];

const CONSISTENCY_PATHS = [
  'IndexedDB/https_venice.ai_0.indexeddb.leveldb',
  'IndexedDB/https_venice.ai_0.indexeddb.blob',
  'File System',
  'Local Storage/leveldb',
  'Session Storage'
];
const SOURCE_CHECKPOINT_FILE = 'source-checkpoint.json';
const LIVE_RECONCILIATION_PASSES = 6;

export function serializeConsistencyInventory(inventory) {
  return [...inventory.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([filePath, signature]) => ({ path: filePath, signature }));
}

function deserializeConsistencyInventory(entries) {
  return new Map((Array.isArray(entries) ? entries : []).filter((item) => item?.path && item?.signature).map((item) => [item.path, item.signature]));
}

export async function sourceCheckpointStatus({ archiveDirectory, browser, profile }) {
  const checkpointPath = path.join(archiveDirectory, '.venice-archive', SOURCE_CHECKPOINT_FILE);
  if (!(await pathExists(checkpointPath))) return { available: false, matches: false, changes: [] };
  try {
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
    if (checkpoint.browserId !== browser.id || checkpoint.profileDirectory !== profile.directoryName || !checkpoint.sourceInventory?.length) return { available: false, matches: false, changes: [] };
    const current = await inventoryConsistencyFiles(profile.path);
    const changes = compareConsistencyInventories(deserializeConsistencyInventory(checkpoint.sourceInventory), current);
    return { available: true, matches: changes.length === 0, changes, files: current.size, captureId: checkpoint.captureId || null };
  } catch {
    return { available: false, matches: false, changes: [] };
  }
}

export async function saveSourceCheckpoint({ archiveDirectory, browser, profile, snapshotManifest, captureId }) {
  if (!Array.isArray(snapshotManifest?.sourceInventory) || !snapshotManifest.sourceInventory.length) return null;
  const directory = await ensureDirectory(path.join(archiveDirectory, '.venice-archive'));
  const checkpoint = { schemaVersion: 1, savedAt: new Date().toISOString(), browserId: browser.id, profileDirectory: profile.directoryName, captureId: captureId || null, snapshotId: snapshotManifest.snapshotId || null, sourceInventory: snapshotManifest.sourceInventory };
  const checkpointPath = path.join(directory, SOURCE_CHECKPOINT_FILE);
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  return checkpointPath;
}

async function latestReusableSnapshot(archiveDirectory, profileDirectory, snapshotDirectory) {
  const root = snapshotDirectory || path.join(archiveDirectory, 'raw-snapshots');
  let names = [];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('snapshot-'))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return (await latestArchivedSnapshot(archiveDirectory, profileDirectory))?.manifest || null;
  }
  for (const name of names) {
    try {
      const manifest = JSON.parse(await readFile(path.join(root, name, 'snapshot.manifest.json'), 'utf8'));
      if (manifest.profile?.directoryName !== profileDirectory || manifest.sourceConsistency?.stableDuringCopy !== true || !Array.isArray(manifest.files)) continue;
      return manifest;
    } catch {
      // An incomplete snapshot has no reusable integrity index.
    }
  }
  return (await latestArchivedSnapshot(archiveDirectory, profileDirectory))?.manifest || null;
}

export async function inventoryConsistencyFiles(profilePath, { precise = false } = {}) {
  const inventory = new Map();
  for (const relativeRoot of CONSISTENCY_PATHS) {
    const absoluteRoot = path.join(profilePath, relativeRoot);
    for (const file of await listFiles(absoluteRoot)) {
      const relative = path.join(relativeRoot, file.relative).split(path.sep).join('/');
      inventory.set(relative, `${file.stat.size}:${precise ? file.stat.mtimeMs : Math.trunc(file.stat.mtimeMs)}`);
    }
  }
  return inventory;
}

function checkpointConsistencyInventory(inventory) {
  return new Map([...inventory.entries()].map(([filePath, signature]) => {
    const separator = signature.indexOf(':');
    const size = signature.slice(0, separator);
    const modified = Number(signature.slice(separator + 1));
    return [filePath, `${size}:${Math.trunc(modified)}`];
  }));
}

function portableConsistencyInventory(inventory) {
  return new Map([...inventory.entries()].map(([filePath, signature]) => {
    const separator = signature.indexOf(':');
    const size = signature.slice(0, separator);
    const modified = Number(signature.slice(separator + 1));
    return [filePath, `${size}:${Math.round(modified)}`];
  }));
}

export function compareConsistencyInventories(before, after) {
  const changes = [];
  const names = new Set([...before.keys(), ...after.keys()]);
  for (const name of names) {
    if (!before.has(name)) changes.push({ path: name, change: 'created' });
    else if (!after.has(name)) changes.push({ path: name, change: 'removed' });
    else if (before.get(name) !== after.get(name)) changes.push({ path: name, change: 'modified' });
  }
  return changes;
}

function consistencyDelta(sourceInventory, targetInventory, forcedPaths = []) {
  const changes = compareConsistencyInventories(targetInventory, sourceInventory);
  const included = new Set(changes.map((entry) => entry.path));
  for (const value of forcedPaths) {
    const filePath = typeof value === 'string' ? value : value?.path;
    if (!filePath || included.has(filePath)) continue;
    if (sourceInventory.has(filePath)) changes.push({ path: filePath, change: targetInventory.has(filePath) ? 'modified' : 'created' });
    else if (targetInventory.has(filePath)) changes.push({ path: filePath, change: 'removed' });
    included.add(filePath);
  }
  return changes;
}

async function applyConsistencyDelta(sourceProfile, targetProfile, sourceInventory, targetInventory, forcedPaths = [], copyMode = fsConstants.COPYFILE_FICLONE) {
  const changes = consistencyDelta(sourceInventory, targetInventory, forcedPaths);
  let copiedFiles = 0;
  let removedFiles = 0;
  let missedFiles = 0;
  for (const entry of changes) {
    const target = path.join(targetProfile, entry.path);
    if (entry.change === 'removed') {
      await rm(target, { force: true });
      removedFiles += 1;
      continue;
    }
    await ensureDirectory(path.dirname(target));
    try {
      await cp(path.join(sourceProfile, entry.path), target, {
        force: true,
        preserveTimestamps: true,
        mode: copyMode
      });
      copiedFiles += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      // A live database can rotate a journal between inventory and copy. The
      // closing inventories below will detect that and request another pass.
      missedFiles += 1;
    }
  }
  return { changes, copiedFiles, removedFiles, missedFiles };
}

export async function reconcileConsistencySnapshot({
  sourceProfile,
  targetProfile,
  browserName = 'the browser',
  maxPasses = LIVE_RECONCILIATION_PASSES,
  forcePaths = [],
  copyMode = fsConstants.COPYFILE_FICLONE,
  onProgress = () => {}
}) {
  let copiedFiles = 0;
  let removedFiles = 0;
  let lastActivity = [];
  let lastMismatches = [];
  let requiredPaths = forcePaths;

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const sourceBefore = await inventoryConsistencyFiles(sourceProfile, { precise: true });
    const targetBefore = await inventoryConsistencyFiles(targetProfile, { precise: true });
    const pending = consistencyDelta(
      portableConsistencyInventory(sourceBefore),
      portableConsistencyInventory(targetBefore),
      requiredPaths
    );
    onProgress(pending.length
      ? `Reconciling ${pending.length} changed Venice storage file${pending.length === 1 ? '' : 's'} (short pass ${pass}/${maxPasses})`
      : `Confirming a quiet Venice storage window (short pass ${pass}/${maxPasses})`);

    const applied = await applyConsistencyDelta(
      sourceProfile,
      targetProfile,
      portableConsistencyInventory(sourceBefore),
      portableConsistencyInventory(targetBefore),
      requiredPaths,
      copyMode
    );
    copiedFiles += applied.copiedFiles;
    removedFiles += applied.removedFiles;

    const sourceAfter = await inventoryConsistencyFiles(sourceProfile, { precise: true });
    const targetAfter = await inventoryConsistencyFiles(targetProfile, { precise: true });
    lastActivity = compareConsistencyInventories(sourceBefore, sourceAfter);
    lastMismatches = compareConsistencyInventories(
      portableConsistencyInventory(targetAfter),
      portableConsistencyInventory(sourceAfter)
    );
    if (!lastActivity.length && !lastMismatches.length) {
      return { inventory: sourceAfter, passes: pass, copiedFiles, removedFiles };
    }
    requiredPaths = [...lastActivity, ...lastMismatches];
  }

  const blockingChanges = lastActivity.length ? lastActivity : lastMismatches;
  const preview = blockingChanges.slice(0, 5).map((entry) => `${entry.change}: ${entry.path}`).join('; ');
  throw new Error(`${browserName} kept changing Venice storage while Archiv tried ${maxPasses} short consistency passes (${blockingChanges.length} files in the last pass). No snapshot was kept. Fully quit ${browserName}, wait a few seconds, then run Fetch new content again.${preview ? ` ${preview}` : ''}`);
}

export async function isBrowserRunning(browser) {
  try {
    if (process.platform === 'win32') {
      const result = await run('tasklist.exe', ['/FI', `IMAGENAME eq ${path.basename(browser.executable)}`]);
      return result.stdout.toLowerCase().includes(path.basename(browser.executable).toLowerCase());
    }
    await run('pgrep', ['-f', browser.executable]);
    return true;
  } catch {
    return false;
  }
}

export async function createRawSnapshot({ archiveDirectory, browser, profile, allowRunning = false, snapshotDirectory = null, requireClone = false, minimumFreeBytes, onProgress = () => {} }) {
  const browserRunning = await isBrowserRunning(browser);
  if (!allowRunning && browserRunning) {
    throw new Error(`${browser.name} is running. Quit it before taking the raw safety snapshot so LevelDB and OPFS are internally consistent.`);
  }

  const snapshotId = `snapshot-${timestampId()}`;
  const cacheRoot = snapshotDirectory ? await prepareSnapshotCache(snapshotDirectory, browser.userDataDirectory, { minimumFreeBytes }) : null;
  const copyMode = requireClone ? fsConstants.COPYFILE_FICLONE_FORCE : fsConstants.COPYFILE_FICLONE;
  const snapshotRoot = await ensureDirectory(path.join(cacheRoot || path.join(archiveDirectory, 'raw-snapshots'), snapshotId));
  try {
    const consistencyBefore = await inventoryConsistencyFiles(profile.path, { precise: true });
    const userDataDirectory = await ensureDirectory(path.join(snapshotRoot, 'user-data'));
    const targetProfile = await ensureDirectory(path.join(userDataDirectory, profile.directoryName));

    const localState = path.join(browser.userDataDirectory, 'Local State');
    if (await pathExists(localState)) await cp(localState, path.join(userDataDirectory, 'Local State'), { mode: copyMode });

    for (const relative of PROFILE_PATHS) {
      const source = path.join(profile.path, relative);
      if (!(await pathExists(source))) continue;
      onProgress(`Copying ${relative}`);
      try {
        await cp(source, path.join(targetProfile, relative), { recursive: true, preserveTimestamps: true, mode: copyMode });
      } catch (error) {
        if (!allowRunning || error.code !== 'ENOENT') throw error;
        onProgress(`Live browser storage rotated while copying ${relative}; the consistency pass will repair the delta`);
      }
    }

    onProgress('Checking that Venice storage stayed unchanged during the copy');
    const consistencyAfterFirstPass = await inventoryConsistencyFiles(profile.path, { precise: true });
    const firstPassChanges = compareConsistencyInventories(consistencyBefore, consistencyAfterFirstPass);
    if (firstPassChanges.length) {
      onProgress(`${firstPassChanges.length} browser storage file${firstPassChanges.length === 1 ? '' : 's'} changed during the first pass; reconciling only that delta safely`);
    }
    const result = await reconcileConsistencySnapshot({
      sourceProfile: profile.path,
      targetProfile,
      browserName: browser.name,
      forcePaths: firstPassChanges,
      copyMode,
      onProgress
    });
    const consistencyAfter = result.inventory;
    const reconciliationRequired = Boolean(firstPassChanges.length || result.copiedFiles || result.removedFiles);
    const reconciliation = { performed: true, required: reconciliationRequired, passes: result.passes, copiedFiles: result.copiedFiles, removedFiles: result.removedFiles, initialChanges: firstPassChanges.length };
    if (reconciliationRequired) {
      onProgress(`Snapshot reconciled in ${result.passes} short pass${result.passes === 1 ? '' : 'es'}; the copy now matches a quiet Venice storage window`);
    }

    const checkpointInventory = checkpointConsistencyInventory(consistencyAfter);
    onProgress('Hashing snapshot files');
    const files = [];
    const snapshotFiles = await listFiles(userDataDirectory);
    const reusableManifest = await latestReusableSnapshot(archiveDirectory, profile.directoryName, cacheRoot)
      || (cacheRoot ? await latestReusableSnapshot(archiveDirectory, profile.directoryName) : null);
    const reusableFiles = new Map((reusableManifest?.files || []).map((file) => [String(file.path), file]));
    const reusableSource = deserializeConsistencyInventory(reusableManifest?.sourceInventory);
    const profilePrefix = `${profile.directoryName}/`;
    let reusedHashes = 0;
    let hashedFiles = 0;
    for (let index = 0; index < snapshotFiles.length; index += 1) {
      const file = snapshotFiles[index];
      const relative = file.relative.split(path.sep).join('/');
      const sourceRelative = relative.startsWith(profilePrefix) ? relative.slice(profilePrefix.length) : null;
      const reusable = reusableFiles.get(relative);
      const currentSignature = sourceRelative ? checkpointInventory.get(sourceRelative) : null;
      if (currentSignature && reusable && reusable.size === file.stat.size && reusableSource.get(sourceRelative) === currentSignature) {
        files.push({ path: relative, size: file.stat.size, sha256: reusable.sha256 });
        reusedHashes += 1;
        continue;
      }
      if (hashedFiles === 0 || index + 1 === snapshotFiles.length || hashedFiles % 100 === 0) onProgress(`Hashing changed file ${hashedFiles + 1}: ${relative}`);
      files.push({ path: relative, size: file.stat.size, sha256: await sha256File(file.absolute) });
      hashedFiles += 1;
    }
    if (reusedHashes) onProgress(`Snapshot integrity index reused ${reusedHashes} unchanged hashes and hashed ${hashedFiles} changed or volatile files`);
    const manifest = {
      schemaVersion: 1,
      snapshotId,
      ...(cacheRoot ? { managedCache: cacheRoot } : {}),
      ...(requireClone ? { cloneRequired: true } : {}),
      createdAt: new Date().toISOString(),
      browser: { id: browser.id, name: browser.name, executable: browser.executable },
      profile: { directoryName: profile.directoryName, name: profile.name },
      sourceConsistency: {
        browserWasRunning: browserRunning,
        mode: browserRunning ? (reconciliation.required ? 'live-reconciled' : 'live-stability-gated') : 'browser-closed',
        stableDuringCopy: true,
        checkedFiles: checkpointInventory.size,
        changes: [],
        reconciliation
      },
      sourceInventory: serializeConsistencyInventory(checkpointInventory),
      integrity: { reusedHashes, hashedFiles },
      files,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0)
    };
    await writeFile(path.join(snapshotRoot, 'snapshot.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { snapshotRoot, userDataDirectory, manifest };
  } catch (error) {
    return cleanupFailedSnapshot(snapshotRoot, error, { onProgress });
  }
}

export async function verifyRawSnapshot(snapshotRoot) {
  const manifest = JSON.parse(await readFile(path.join(snapshotRoot, 'snapshot.manifest.json'), 'utf8'));
  const failures = [];
  for (const file of manifest.files) {
    const absolute = path.join(snapshotRoot, 'user-data', file.path);
    if (!(await pathExists(absolute))) failures.push({ path: file.path, error: 'missing' });
    else if (await sha256File(absolute) !== file.sha256) failures.push({ path: file.path, error: 'hash mismatch' });
  }
  return { ok: failures.length === 0, checked: manifest.files.length, failures, manifest };
}
