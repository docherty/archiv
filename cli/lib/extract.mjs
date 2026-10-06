import { constants as fsConstants, createWriteStream } from 'node:fs';
import { cp, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { CdpClient, findPageTarget, waitForDevToolsPort } from './cdp.mjs';
import { ensureDirectory, pathExists, run, safeName, timestampId } from './util.mjs';

const PROTOCOL = '2026-07-store-api-v12-tab-handoff';
const CORE_CONVERSATION_STORES = new Set(['conversations', 'rxConversations', 'mindConversations', 'supportBotThreads', 'messages', 'rxMessages', 'mindMessages', 'supportBotMessages']);
const CAPTURE_INITIAL_STORAGE = `(() => {
  const snapshot = (storage) => Object.keys(storage).sort().map((key) => [key, storage.getItem(key)]);
  try { Object.defineProperty(window, '__VENICE_ARCHIVE_INITIAL_LOCAL_STORAGE__', { value: snapshot(localStorage), configurable: false }); } catch {}
  try { Object.defineProperty(window, '__VENICE_ARCHIVE_INITIAL_SESSION_STORAGE__', { value: snapshot(sessionStorage), configurable: false }); } catch {}
})();`;

function storeState(item) {
  return { name: item.name, count: Number(item.count ?? item.expectedRecords ?? item.records ?? 0), fingerprint: item.fingerprint || null, source: item.source || null, physicalStoreName: item.physicalStoreName || null, schemaVersion: item.schemaVersion ?? null };
}

function opfsState(item) {
  return { path: item.path, fileName: item.fileName || null, size: Number(item.size || 0), lastModified: Number(item.lastModified || 0) || null, mimeType: item.mimeType || null, kind: item.kind || null };
}

function sameStore(previous, current) {
  return Boolean(previous?.fingerprint && current?.fingerprint && previous.fingerprint === current.fingerprint && Number(previous.count) === Number(current.count));
}

function sameOpfs(previous, current) {
  return Boolean(previous && previous.lastModified && current.lastModified && Number(previous.size) === Number(current.size) && Number(previous.lastModified) === Number(current.lastModified));
}

export function planIncrementalExtraction(previousManifest, storeInventory, opfsItems) {
  const previousStores = previousManifest?.sourceInventory?.stores || previousManifest?.stores || [];
  const previousOpfs = previousManifest?.sourceInventory?.opfs || previousManifest?.opfs || [];
  const previousStoreMap = new Map(previousStores.map((item) => [item.name, item]));
  const previousOpfsMap = new Map(previousOpfs.map((item) => [item.path, item]));
  let stores = storeInventory.filter((item) => !sameStore(previousStoreMap.get(item.name), item));
  const removedStores = previousStores.filter((item) => !storeInventory.some((current) => current.name === item.name)).map((item) => item.name);
  if ([...stores.map((item) => item.name), ...removedStores].some((name) => CORE_CONVERSATION_STORES.has(name))) {
    stores = storeInventory.filter((item) => CORE_CONVERSATION_STORES.has(item.name) || !sameStore(previousStoreMap.get(item.name), item));
  }
  const opfs = opfsItems.filter((item) => !sameOpfs(previousOpfsMap.get(item.path), item));
  const removedOpfs = previousOpfs.filter((item) => !opfsItems.some((current) => current.path === item.path)).map((item) => item.path);
  return {
    stores,
    opfs,
    removedStores,
    removedOpfs,
    skippedStores: Math.max(0, storeInventory.length - stores.length),
    skippedOpfs: Math.max(0, opfsItems.length - opfs.length),
    unchanged: stores.length === 0 && opfs.length === 0 && removedStores.length === 0 && removedOpfs.length === 0,
    sourceInventory: { stores: storeInventory.map(storeState), opfs: opfsItems.map(opfsState) }
  };
}

export function planInventoryReads(previousManifest, sourceChanges = []) {
  const previousStores = previousManifest?.sourceInventory?.stores || [];
  const previousOpfs = previousManifest?.sourceInventory?.opfs || [];
  const changes = Array.isArray(sourceChanges) ? sourceChanges : [];
  const known = changes.length > 0 && changes.every((item) => /^(?:IndexedDB|File System|Local Storage|Session Storage)\//.test(String(item?.path || '')));
  const indexedDbChanged = changes.some((item) => String(item?.path || '').startsWith('IndexedDB/'));
  const opfsChanged = changes.some((item) => String(item?.path || '').startsWith('File System/'));
  const localStorageChanged = changes.some((item) => String(item?.path || '').startsWith('Local Storage/'));
  const sessionStorageChanged = changes.some((item) => String(item?.path || '').startsWith('Session Storage/'));
  return {
    reuseStores: Boolean(known && previousStores.length && !indexedDbChanged),
    reuseOpfs: Boolean(known && previousOpfs.length && !opfsChanged),
    localStorageChanged,
    sessionStorageChanged,
    previousStores,
    previousOpfs
  };
}

function mergeInventory(previousItems, changedItems) {
  const merged = new Map(previousItems.map((item) => [item.name, item]));
  for (const item of changedItems) merged.set(item.name, item);
  return [...merged.values()];
}

async function latestVerifiedCapture(archiveDirectory) {
  const root = path.join(archiveDirectory, 'captures');
  let names = [];
  try { names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.startsWith('capture-')).map((entry) => entry.name).sort().reverse(); } catch { return null; }
  for (const name of names) {
    try {
      const directory = path.join(root, name);
      const verification = JSON.parse(await readFile(path.join(directory, 'capture.verification.json'), 'utf8'));
      if (!verification.ok) continue;
      return { directory, manifest: JSON.parse(await readFile(path.join(directory, 'capture.manifest.json'), 'utf8')) };
    } catch {
      // Ignore incomplete captures and continue to the latest verified one.
    }
  }
  return null;
}

async function cloneUserData(source, target, requireClone = false) {
  await ensureDirectory(target);
  if (process.platform === 'darwin') {
    try {
      await run('/bin/cp', ['-cR', `${source}/.`, target]);
      return;
    } catch (error) {
      if (requireClone) throw error; // Never silently turn a cheap clone into a multi-GiB copy.
      await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
      await ensureDirectory(target);
    }
  }
  await cp(source, target, { recursive: true, preserveTimestamps: true, mode: requireClone ? fsConstants.COPYFILE_FICLONE_FORCE : fsConstants.COPYFILE_FICLONE });
}

export function commandExpression(type, data = {}, timeoutMs = 180000) {
  const requestId = `cli-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const toPage = `venice-sync-to-page:${PROTOCOL}`;
  const fromPage = `venice-sync-from-page:${PROTOCOL}`;
  return `(async()=>await new Promise((resolve,reject)=>{
    const id=${JSON.stringify(requestId)};
    const responseEvent=${JSON.stringify(fromPage)};
    const progressEvent=${JSON.stringify(`venice-sync-progress:${PROTOCOL}`)};
    let lastStage='';
    const progress=(event)=>{
      const detail=event.detail||{};
      lastStage=[detail.phase,detail.source,detail.storeName].filter(value=>typeof value==='string').map(value=>value.slice(0,160)).join('/');
    };
    const cleanup=()=>{clearTimeout(timer);window.removeEventListener(responseEvent,handler);window.removeEventListener(progressEvent,progress);};
    const handler=(event)=>{
      if(event.detail?.requestId!==id)return;
      cleanup();
      event.detail.error?reject(new Error(event.detail.error)):resolve(event.detail.response);
    };
    const timer=setTimeout(()=>{cleanup();reject(new Error(${JSON.stringify(`Venice command timed out: ${type}`)}+(lastStage?' (last stage: '+lastStage+')':'')));},${Number(timeoutMs)});
    window.addEventListener(responseEvent,handler);
    window.addEventListener(progressEvent,progress);
    window.dispatchEvent(new CustomEvent(${JSON.stringify(toPage)},{detail:{type:${JSON.stringify(type)},requestId:id,...${JSON.stringify(data)}}}));
  }))()`;
}

async function pageCommand(client, type, data = {}) {
  const result = await client.evaluate(commandExpression(type, data));
  if (!result || result.success === false) throw new Error(result?.error || `${type} returned no result.`);
  return result;
}

async function waitForVeniceStorageContext(client, onProgress, timeoutMs = 60000) {
  const started = Date.now();
  let latest = null;
  while (Date.now() - started < timeoutMs) {
    try {
      latest = await client.evaluate(`(async()=>({origin:location.origin,readyState:document.readyState,databases:typeof indexedDB.databases==='function'?(await indexedDB.databases()).map(db=>db.name):[]}))()`);
      if (latest?.origin === 'https://venice.ai' && latest.readyState === 'complete' && latest.databases?.length) {
        onProgress(`Venice storage context ready: ${latest.databases.length} IndexedDB database${latest.databases.length === 1 ? '' : 's'} detected`);
        return latest;
      }
    } catch {
      // A navigation can replace the execution context while Venice starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Controlled Brave did not expose the copied Venice IndexedDB data. Last page state: ${JSON.stringify(latest)}`);
}

async function writeStore(client, captureDirectory, store, onProgress) {
  const storeHash = createHash('sha256').update(String(store.name)).digest('hex').slice(0, 10);
  const outputPath = path.join(captureDirectory, 'stores', `${safeName(store.name)}--${storeHash}.jsonl`);
  await ensureDirectory(path.dirname(outputPath));
  const output = createWriteStream(outputPath, { encoding: 'utf8' });
  let offset = 0;
  let records = 0;
  while (true) {
    const page = await pageCommand(client, 'GET_STORE_DATA', { storeName: store.name, encrypted: false, offset, limit: 100, maxBytes: 512 * 1024 });
    for (const record of page.records || []) output.write(`${JSON.stringify(record)}\n`);
    records += page.records?.length || 0;
    onProgress(`${store.name}: ${records}/${store.count ?? '?'}`);
    if (page.done || page.nextOffset <= offset) break;
    offset = page.nextOffset;
  }
  await new Promise((resolve, reject) => { output.end(resolve); output.once('error', reject); });
  return { ...storeState(store), path: path.relative(captureDirectory, outputPath).split(path.sep).join('/'), records, expectedRecords: store.count ?? null };
}

export async function writeOpfs(client, captureDirectory, items, onProgress) {
  const results = [];
  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const item = items[itemIndex];
    const pathHash = createHash('sha256').update(String(item.path)).digest('hex');
    const extension = path.extname(String(item.fileName || item.path)).slice(0, 16);
    const relative = `${pathHash.slice(0, 2)}/${pathHash}--${safeName(path.basename(String(item.fileName || item.path), extension))}${extension}`;
    const outputPath = path.join(captureDirectory, 'opfs', relative);
    await ensureDirectory(path.dirname(outputPath));
    const output = await open(outputPath, 'wx', 0o600);
    let offset = 0;
    try {
      while (true) {
        // The page reader already supports 4 MiB. Larger bounded chunks reduce
        // expensive CDP/event/handle round trips without buffering whole videos.
        const chunk = await pageCommand(client, 'FETCH_OPFS_MEDIA', { path: item.path, offset, chunkSize: 4 * 1024 * 1024 });
        const bytes = Buffer.from(chunk.chunkBase64 || '', 'base64');
        const invalid = bytes.length > 4 * 1024 * 1024 || chunk.chunkBytes !== bytes.length
          || chunk.offset !== offset || chunk.sizeBytes !== item.size
          || chunk.nextOffset !== offset + bytes.length || chunk.nextOffset > item.size
          || chunk.done !== (chunk.nextOffset === item.size) || (!chunk.done && !bytes.length);
        if (invalid) throw new Error(`Invalid OPFS chunk bounds: ${item.path}`);
        await output.writeFile(bytes); // Apply I/O backpressure and propagate errors.
        offset = chunk.nextOffset;
        if (chunk.done) break;
      }
      if (offset !== item.size) throw new Error(`Incomplete OPFS file: ${item.path}`);
    } finally { await output.close(); }
    results.push({ ...item, archivedPath: path.relative(captureDirectory, outputPath).split(path.sep).join('/') });
    onProgress(`OPFS ${itemIndex + 1}/${items.length}: ${item.path}`);
  }
  return results;
}

export async function extractSnapshot({ snapshotRoot, archiveDirectory, browser, profileDirectory, projectRoot, sourceChanges = [], onProgress = () => {} }) {
  const snapshotUserData = path.join(snapshotRoot, 'user-data');
  if (!(await pathExists(snapshotUserData))) throw new Error('Snapshot user-data directory is missing.');
  const snapshotManifest = JSON.parse(await readFile(path.join(snapshotRoot, 'snapshot.manifest.json'), 'utf8'));
  if (snapshotManifest.sourceConsistency?.stableDuringCopy !== true) {
    throw new Error('Snapshot is not marked stable and cannot be used for controlled extraction.');
  }
  const runId = `capture-${timestampId()}`;
  const workRoot = await mkdtemp(path.join(os.tmpdir(), 'venice-archive-browser-'));
  const workUserData = path.join(workRoot, 'user-data');
  let browserChild;
  let client = null;
  try {
    onProgress('Creating an isolated working clone of the browser snapshot');
    await cloneUserData(snapshotUserData, workUserData, snapshotManifest.cloneRequired);
    browserChild = spawn(browser.executable, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-default-apps', '--disable-extensions',
      '--disable-background-networking', '--disable-component-update', '--disable-domain-reliability', '--disable-sync', '--metrics-recording-only',
      '--remote-debugging-port=0', `--user-data-dir=${workUserData}`, `--profile-directory=${profileDirectory}`,
      'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    await new Promise((resolve, reject) => {
      browserChild.once('spawn', resolve);
      browserChild.once('error', reject);
    });
    const port = await waitForDevToolsPort(workUserData);
    const target = await findPageTarget(port);
    client = await new CdpClient(target.webSocketDebuggerUrl).connect();
    await client.call('Runtime.enable');
    await client.call('Page.enable');
    await client.call('Page.addScriptToEvaluateOnNewDocument', { source: CAPTURE_INITIAL_STORAGE });
    await client.call('Page.navigate', { url: 'https://venice.ai/' });
    await waitForVeniceStorageContext(client, onProgress);
    const naclSource = await readFile(path.join(projectRoot, 'extension/lib/nacl.min.js'), 'utf8');
    const mainSource = await readFile(path.join(projectRoot, 'extension/content-main.js'), 'utf8');
    await client.evaluate(naclSource, { awaitPromise: false });
    await client.evaluate(mainSource, { awaitPromise: false });
    await client.call('Runtime.addBinding', { name: 'archivInventoryProgress' });
    client.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method !== 'Runtime.bindingCalled' || message.params?.name !== 'archivInventoryProgress') return;
      try {
        const progress = JSON.parse(message.params.payload);
        if (progress.phase === 'inventory' || progress.phase === 'decrypt') {
          onProgress(`Snapshot summary: ${progress.phase}`);
        } else if (progress.phase === 'complete' && progress.elapsedMs >= 1000) {
          onProgress(`Inventory ${String(progress.source).slice(0, 40)}/${String(progress.storeName).slice(0, 160)}: ${progress.records} records checked in ${progress.elapsedMs}ms`);
        }
      } catch { /* malformed diagnostic events must not affect capture integrity */ }
    });
    await client.evaluate(`window.addEventListener('venice-sync-progress:${PROTOCOL}', event => window.archivInventoryProgress(JSON.stringify(event.detail)));`, { awaitPromise: false });
    const ping = await pageCommand(client, 'PING');
    if (ping.protocolVersion !== PROTOCOL) throw new Error(`Extractor protocol mismatch: ${ping.protocolVersion}`);
    const previous = await latestVerifiedCapture(archiveDirectory);
    const reads = planInventoryReads(previous?.manifest || null, sourceChanges);
    let summary;
    let storeInventory;
    if (reads.reuseStores) {
      storeInventory = reads.previousStores;
      summary = { summary: previous.manifest.summary };
      const browserStoreNames = [reads.localStorageChanged ? 'browserLocalStorage' : null, reads.sessionStorageChanged ? 'browserSessionStorage' : null].filter(Boolean);
      if (browserStoreNames.length) {
        onProgress(`IndexedDB is unchanged; checking browser state against ${reads.previousStores.length - browserStoreNames.length} reusable store fingerprints`);
        const browserState = await pageCommand(client, 'GET_STORE_INVENTORY', { storeNames: browserStoreNames });
        storeInventory = mergeInventory(reads.previousStores, browserState.storeInventory || []);
      } else {
        onProgress(`IndexedDB is unchanged; reusing ${reads.previousStores.length} verified store fingerprints`);
      }
    } else {
      summary = await pageCommand(client, 'GET_SNAPSHOT_SUMMARY');
      storeInventory = summary.diagnostics?.storeInventory || [];
      if (!storeInventory.length) storeInventory = (await pageCommand(client, 'GET_STORE_INVENTORY')).storeInventory || [];
    }
    if (!summary.summary || !storeInventory.length) {
      throw new Error(`Controlled Brave returned an empty Venice inventory (${storeInventory.length} stores). The capture was rejected.`);
    }
    let opfsItems;
    if (reads.reuseOpfs) {
      opfsItems = reads.previousOpfs;
      onProgress(`OPFS is unchanged; reusing the inventory for ${opfsItems.length} verified media files`);
    } else {
      opfsItems = (await pageCommand(client, 'GET_OPFS_MEDIA_INDEX')).items || [];
    }
    const plan = planIncrementalExtraction(previous?.manifest || null, storeInventory, opfsItems);
    onProgress(`Incremental comparison: ${plan.stores.length} changed stores and ${plan.opfs.length} changed media files; ${plan.skippedStores} stores and ${plan.skippedOpfs} media files unchanged`);
    if (previous && plan.unchanged) {
      return { unchanged: true, captureDirectory: null, manifest: previous.manifest, baseCapture: previous.manifest.runId, plan };
    }
    const captureDirectory = await ensureDirectory(path.join(archiveDirectory, 'captures', runId));
    const stores = [];
    for (const store of plan.stores) stores.push(await writeStore(client, captureDirectory, store, onProgress));
    const opfs = await writeOpfs(client, captureDirectory, plan.opfs, onProgress);
    const manifest = { schemaVersion: 2, runId, capturedAt: new Date().toISOString(), protocolVersion: PROTOCOL, snapshot: path.basename(snapshotRoot), incremental: Boolean(previous), baseCapture: previous?.manifest?.runId || null, summary: summary.summary, changes: { stores: stores.length, opfs: opfs.length, removedStores: plan.removedStores, removedOpfs: plan.removedOpfs }, sourceInventory: plan.sourceInventory, stores, opfs };
    await writeFile(path.join(captureDirectory, 'capture.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { captureDirectory, manifest };
  } finally {
    client?.close();
    if (browserChild?.pid && browserChild.exitCode === null) {
      browserChild.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => browserChild.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000))
      ]);
      if (browserChild.exitCode === null) {
        browserChild.kill('SIGKILL');
        await Promise.race([new Promise((resolve) => browserChild.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 1000))]);
      }
    }
    try {
      await rm(workRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
    } catch (error) {
      onProgress(`Temporary browser workspace could not be removed automatically: ${error.message}`);
    }
  }
}
