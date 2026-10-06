#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { chooseProfile, discoverProfiles } from './lib/browsers.mjs';
import { buildSearchIndex, importArchiveZip, searchArchiveTree } from './lib/archive.mjs';
import { loadConfig, saveConfig } from './lib/config.mjs';
import { createRawSnapshot, saveSourceCheckpoint, sourceCheckpointStatus, verifyRawSnapshot } from './lib/snapshot.mjs';
import { extractSnapshot } from './lib/extract.mjs';
import { normalizeCapture } from './lib/normalize-capture.mjs';
import { materializeEmbeddedMedia } from './lib/materialize-media.mjs';
import { startArchiveService } from './lib/service.mjs';
import { verifyCapture } from './lib/verify-capture.mjs';
import { formatBytes, parseArgs, pathExists } from './lib/util.mjs';
import { markSnapshotCaptured, pruneSnapshotCache } from './lib/snapshot-cache.mjs';
import { defaultSnapshotCache, persistRawSnapshot, recordRawCaptureResult, retainFailedRawSnapshot, withRawSnapshot, latestArchivedSnapshot, runRawStore } from './lib/raw-store.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.log(`Archiv CLI

Usage:
  npm start -- --archive <folder> [--browser brave] [--profile "Work"]
  npm run archive -- discover [--browser brave]
  npm run archive -- init --archive <folder> [--browser brave] [--profile "Work"]
  npm run archive -- snapshot --archive <folder> [--allow-running]
  npm run archive -- sync --archive <folder> [--allow-running]
  npm run archive -- extract --archive <folder> [--snapshot latest|<folder>]
  # Optional sync cache: --snapshot-directory <private local folder> --snapshot-retain 1 --require-clone
  npm run archive -- import --archive <folder> --zip <archive.zip>
  npm run archive -- index --archive <folder>
  npm run archive -- search --archive <folder> <words> [--limit 25]
  npm run archive -- serve --archive <folder> [--browser brave] [--profile "Work"] [--port 43110]
  npm run archive -- verify-snapshot --snapshot <folder>
  npm run archive -- history --archive <folder>
  npm run archive -- verify-history --archive <folder>
  npm run archive -- restore-snapshot --archive <folder> --snapshot <id> --destination <new folder>
  npm run archive -- verify-capture --archive <folder> [--capture latest|<folder>]
  npm run archive -- materialize-media --archive <folder>

The serve command discovers and configures Brave automatically on first run. It
can take a stability-checked copy while Brave is open, but do not use Venice
during an update. Snapshot and sync require the browser to be closed unless
--allow-running is explicit. No command writes to Venice browser storage.`);
  console.log('\nCopyright (C) 2026 hiroP. GNU AGPL v3 only; no warranty.\nSource: https://github.com/docherty/archiv');
}

function required(options, name) {
  const value = options[name];
  if (!value || value === true) throw new Error(`Missing required option: --${name}`);
  return path.resolve(String(value));
}

async function resolveSetup(options, { initialize = false } = {}) {
  const archiveDirectory = required(options, 'archive');
  let config = await loadConfig(archiveDirectory);
  let initialized = false;
  if (!config && initialize) {
    const browserId = String(options.browser || 'brave');
    const discovery = await discoverProfiles(browserId);
    const profile = chooseProfile(discovery.profiles, options.profile ? String(options.profile) : null);
    config = await saveConfig(archiveDirectory, {
      createdAt: new Date().toISOString(), browser: browserId, profileDirectory: profile.directoryName, profileName: profile.name
    });
    initialized = true;
  }
  if (!config) throw new Error(`Archive is not configured at ${archiveDirectory}. Run init first, or start the local app to configure it automatically.`);
  const discovery = await discoverProfiles(config.browser);
  const profile = chooseProfile(discovery.profiles, config.profileDirectory);
  return { archiveDirectory, config, browser: discovery.browser, profile, initialized };
}

async function hasControlledCapture(archiveDirectory) {
  try {
    const entries = await readdir(path.join(archiveDirectory, 'captures'), { withFileTypes: true });
    return entries.some((entry) => entry.isDirectory() && entry.name.startsWith('capture-'));
  } catch {
    return false;
  }
}

async function resolveSnapshot(archiveDirectory, requested = 'latest') {
  if (requested && requested !== 'latest') return path.resolve(String(requested));
  const root = path.join(archiveDirectory, 'raw-snapshots');
  let entries = [];
  try { entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('snapshot-'))
    .map((entry) => entry.name).sort(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (entries.length) return path.join(root, entries.at(-1));
  const stored = await latestArchivedSnapshot(archiveDirectory);
  if (!stored) throw new Error('No complete raw snapshots are available for extraction.');
  return stored.identity;
}

async function resolveCapture(archiveDirectory, requested = 'latest') {
  if (requested && requested !== 'latest') return path.resolve(String(requested));
  const root = path.join(archiveDirectory, 'captures');
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('capture-'))
    .map((entry) => entry.name)
    .sort();
  if (!entries.length) throw new Error('No controlled captures are available for verification.');
  return path.join(root, entries.at(-1));
}

async function completeExtraction(setup, snapshotRoot, emit = () => {}, sourceChanges = []) {
  const capture = await extractSnapshot({
    snapshotRoot,
    archiveDirectory: setup.archiveDirectory,
    browser: setup.browser,
    profileDirectory: setup.profile.directoryName,
    projectRoot,
    sourceChanges,
    onProgress: (message) => {
      console.log(`[extract] ${message}`);
      emit({ phase: /OPFS/i.test(message) ? 'media' : 'discover', message });
    }
  });
  if (capture.unchanged) {
    const message = `No record or media changes found; ${capture.plan.skippedStores} stores and ${capture.plan.skippedOpfs} media files already match the verified archive.`;
    console.log(message);
    emit({ phase: 'complete', message });
    return { captureId: capture.baseCapture, unchanged: true, compared: { stores: capture.plan.skippedStores, opfs: capture.plan.skippedOpfs } };
  }
  emit({ phase: 'library', message: 'Building conversations, gallery and search index…' });
  const normalized = await normalizeCapture(capture.captureDirectory);
  const search = await buildSearchIndex(capture.captureDirectory);
  const verification = await verifyCapture(capture.captureDirectory, {
    onProgress: (message) => {
      console.log(`[verify] ${message}`);
      emit({ phase: 'verify', message });
    }
  });
  console.log(`Lossless Venice capture created: ${capture.captureDirectory}`);
  console.log(`Searchable capture: ${normalized.conversations} conversations, ${normalized.messages} messages, ${normalized.media} media records; ${search.items} indexed items.`);
  console.log(`Capture verification ${verification.ok ? 'passed' : 'FAILED'}: ${verification.totals.stores} stores, ${verification.totals.storeRecords} records, ${verification.totals.opfsFiles} OPFS files, ${formatBytes(verification.totals.opfsBytes)}.`);
  if (!verification.ok) throw new Error(`Capture verification failed with ${verification.errors.length} error(s).`);
  const materialized = await materializeEmbeddedMedia(setup.archiveDirectory, {
    apply: true,
    onProgress: (message) => {
      console.log(`[media] ${message}`);
      emit({ phase: 'media', message });
    }
  });
  if (materialized.added) console.log(`Full-resolution media materialized: ${materialized.added} files, ${formatBytes(materialized.bytes)}.`);
  return {
    captureId: capture.manifest.runId,
    captureDirectory: capture.captureDirectory,
    normalized,
    searchItems: search.items,
    verification: verification.totals,
    materialized
  };
}

async function syncArchive(setup, { allowRunning = false, snapshotDirectory = defaultSnapshotCache(setup.archiveDirectory), requireClone = process.platform === 'darwin', retainSnapshots = 1, emit = () => {} } = {}) {
  if (snapshotDirectory && (!Number.isSafeInteger(retainSnapshots) || retainSnapshots < 1)) throw new Error('Keep at least one disposable working snapshot; raw history lives in the store.');
  emit({ phase: 'discover', message: 'Checking for changes since the last verified update…' });
  const checkpoint = await sourceCheckpointStatus(setup);
  if (checkpoint.matches) {
    const message = `Up to date. ${checkpoint.files} Venice storage files are unchanged since the last verified update.`;
    console.log(message);
    emit({ phase: 'complete', message });
    return { captureId: checkpoint.captureId, unchanged: true, checkpoint: true, checkedFiles: checkpoint.files };
  }
  if (checkpoint.available) emit({ phase: 'snapshot', message: `Venice storage changed in ${checkpoint.changes.length} place${checkpoint.changes.length === 1 ? '' : 's'}; saving the delta safely…` });
  const snapshot = await createRawSnapshot({ ...setup, allowRunning, snapshotDirectory, requireClone, onProgress: (message) => { console.log(`[snapshot] ${message}`); emit({ phase: 'snapshot', message }); } });
  // Preserve before decoding: unknown schemas and hard process deadlines cannot
  // turn a complete, quiet source snapshot into an unarchived disposable cache.
  await persistRawSnapshot(setup.archiveDirectory, snapshot.snapshotRoot, { requireClone, onProgress: (message) => console.log(`[raw-store] ${message}`) });
  let result;
  try { result = await completeExtraction(setup, snapshot.snapshotRoot, emit, checkpoint.changes); }
  catch (error) { return retainFailedRawSnapshot(setup.archiveDirectory, snapshot.snapshotRoot, error); }
  await recordRawCaptureResult(setup.archiveDirectory, snapshot.manifest.snapshotId, result);
  // Operational receipts live outside the immutable raw tree, so successful
  // decoding doesn't require a second full metadata tree or any duplicate bytes.
  await markSnapshotCaptured(snapshot.snapshotRoot, result.captureId, { outsideSnapshot: true, comparisonOnly: result.unchanged === true });
  await saveSourceCheckpoint({ ...setup, snapshotManifest: snapshot.manifest, captureId: result.captureId });
  if (snapshotDirectory) {
    try {
      const removed = await pruneSnapshotCache(snapshotDirectory, snapshot.snapshotRoot, retainSnapshots, { archiveDirectory: setup.archiveDirectory });
      if (removed.length) console.log(`[snapshot] Removed ${removed.length} verified working copies; all raw history remains in the deduplicated store`);
    } catch (error) { console.warn(`[snapshot] Managed cache cleanup failed: ${error.message}`); }
  }
  return result;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help' || command === '--help' || command === '-h' || options.help || options.h) return usage();

  if (['history', 'verify-history', 'restore-snapshot'].includes(command)) {
    const archive = required(options, 'archive');
    const args = command === 'history' ? ['list'] : command === 'verify-history' ? ['verify']
      : ['restore', '--snapshot', String(options.snapshot || ''), '--destination', required(options, 'destination'), ...(process.platform === 'darwin' ? ['--require-clone'] : []), ...(options.portable ? ['--portable'] : [])];
    console.log((await runRawStore(archive, args)).trim());
    return;
  }
  if (command === 'discover') {
    const { browser, profiles } = await discoverProfiles(String(options.browser || 'brave'));
    console.log(`${browser.name}: ${browser.userDataDirectory}`);
    for (const profile of profiles) {
      console.log(`${profile.hasVeniceData ? '●' : '○'} ${profile.name} (${profile.directoryName}) — Venice IndexedDB ${formatBytes(profile.indexedDbBytes)}, profile file storage ${formatBytes(profile.opfsCandidateBytes)}${profile.isLastUsed ? ' — last used' : ''}`);
    }
    return;
  }

  if (command === 'init') {
    const archiveDirectory = required(options, 'archive');
    const browserId = String(options.browser || 'brave');
    const discovery = await discoverProfiles(browserId);
    const profile = chooseProfile(discovery.profiles, options.profile ? String(options.profile) : null);
    const config = await saveConfig(archiveDirectory, {
      createdAt: new Date().toISOString(), browser: browserId, profileDirectory: profile.directoryName, profileName: profile.name
    });
    console.log(`Configured ${archiveDirectory}`);
    console.log(`Source: ${discovery.browser.name} / ${profile.name} (${profile.directoryName})`);
    console.log(`Venice evidence: ${formatBytes(profile.evidenceBytes)}`);
    return config;
  }

  if (command === 'snapshot') {
    const setup = await resolveSetup(options);
    const result = await createRawSnapshot({ ...setup, snapshotDirectory: defaultSnapshotCache(setup.archiveDirectory), requireClone: process.platform === 'darwin', allowRunning: Boolean(options['allow-running']), onProgress: (message) => console.log(message) });
    await persistRawSnapshot(setup.archiveDirectory, result.snapshotRoot, { removeSource: true });
    console.log(`Verified-source raw history preserved: ${result.manifest.snapshotId} in ${path.join(setup.archiveDirectory, 'raw-store')}`);
    console.log(`${result.manifest.files.length} files, ${formatBytes(result.manifest.totalBytes)}`);
    return;
  }

  if (command === 'sync') {
    const setup = await resolveSetup(options);
    await syncArchive(setup, {
      allowRunning: Boolean(options['allow-running']),
      snapshotDirectory: options['snapshot-directory'] ? required(options, 'snapshot-directory') : defaultSnapshotCache(setup.archiveDirectory),
      requireClone: process.platform === 'darwin' || Boolean(options['require-clone']),
      retainSnapshots: options['snapshot-retain'] === undefined ? 1 : Number(options['snapshot-retain'])
    });
    return;
  }

  if (command === 'extract') {
    const setup = await resolveSetup(options);
    await withRawSnapshot(setup.archiveDirectory, await resolveSnapshot(setup.archiveDirectory, String(options.snapshot || 'latest')), (snapshotRoot) => completeExtraction(setup, snapshotRoot));
    return;
  }

  if (command === 'import') {
    const archiveDirectory = required(options, 'archive');
    const zipPath = required(options, 'zip');
    const result = await importArchiveZip({ zipPath, archiveDirectory, verifyScript: path.join(projectRoot, 'scripts/verify-archive.mjs') });
    const search = await buildSearchIndex(archiveDirectory);
    console.log(`Imported ${result.entries} files.`);
    console.log(`${result.manifest.totals?.conversations || 0} conversations, ${result.manifest.totals?.messages || 0} messages, ${result.manifest.totals?.mediaFiles || 0} media files.`);
    console.log(`Search index built with ${search.items} items.`);
    if (result.verification.ok) {
      console.log('Archive verification passed.');
    } else {
      console.warn('Archive verification did not pass. The imported records remain searchable, but this package must not be treated as a complete backup.');
      console.warn(result.verification.error.split('\n').slice(0, 4).join('\n'));
    }
    return;
  }

  if (command === 'index') {
    const archiveDirectory = required(options, 'archive');
    const result = await buildSearchIndex(archiveDirectory);
    console.log(`Search index built: ${result.items} items at ${result.databasePath}`);
    return;
  }

  if (command === 'search') {
    const archiveDirectory = required(options, 'archive');
    const query = options._.join(' ');
    const results = await searchArchiveTree(archiveDirectory, query, options.limit);
    for (const item of results) {
      console.log(`\n[${item.type}] ${item.title || item.id || 'Untitled'}`);
      console.log(String(item.excerpt || '').replaceAll('[', '\u001b[1m').replaceAll(']', '\u001b[0m'));
      if (item.path) console.log(path.join(item.archive_directory, item.path));
      console.log(`Source: ${item.archive_source}`);
    }
    console.log(`\n${results.length} result${results.length === 1 ? '' : 's'}`);
    return;
  }

  if (command === 'serve') {
    const setup = await resolveSetup(options, { initialize: true });
    const firstRun = !(await hasControlledCapture(setup.archiveDirectory));
    const service = await startArchiveService(setup.archiveDirectory, {
      port: Number(options.port || 43110),
      source: { browser: setup.browser.name, browserId: setup.browser.id, profile: setup.profile.name, profileDirectory: setup.profile.directoryName },
      autoSync: firstRun,
      onSync: async (emit) => syncArchive(setup, { allowRunning: true, emit })
    });
    if (setup.initialized) console.log(`Found Venice content in ${setup.browser.name} / ${setup.profile.name} and configured this archive automatically.`);
    console.log(`Archiv is available at ${service.url}`);
    if (firstRun) console.log('Initial import has started. Open the library to follow its progress; do not use Venice until it completes.');
    console.log('Press Control-C to stop. Nothing is exposed outside this device.');
    return new Promise(() => {});
  }

  if (command === 'verify-snapshot') {
    const result = await verifyRawSnapshot(required(options, 'snapshot'));
    console.log(`${result.ok ? 'Verified' : 'FAILED'}: ${result.checked} files checked.`);
    if (!result.ok) process.exitCode = 2;
    return;
  }

  if (command === 'verify-capture') {
    const archiveDirectory = required(options, 'archive');
    const captureDirectory = await resolveCapture(archiveDirectory, String(options.capture || 'latest'));
    const result = await verifyCapture(captureDirectory, { onProgress: (message) => console.log(message) });
    console.log(`${result.ok ? 'Verified' : 'FAILED'}: ${result.totals.stores} stores, ${result.totals.storeRecords} records, ${result.totals.opfsFiles} OPFS files, ${formatBytes(result.totals.opfsBytes)}.`);
    if (!result.ok) {
      result.errors.slice(0, 20).forEach((error) => console.error(error));
      process.exitCode = 2;
    }
    return;
  }

  if (command === 'materialize-media') {
    const archiveDirectory = required(options, 'archive');
    const result = await materializeEmbeddedMedia(archiveDirectory, { apply: !options['dry-run'], reprocess: Boolean(options.reprocess), onProgress: (message) => console.log(message) });
    console.log(`Full-resolution media (${result.mode}): ${result.added} ${options['dry-run'] ? 'would be added' : 'added'}, ${result.total} total, ${formatBytes(result.bytes)} ${options['dry-run'] ? 'would be written' : 'written'}.`);
    return;
  }

  usage();
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
