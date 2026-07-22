import { createReadStream } from 'node:fs';
import { open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArchiveCatalog } from './catalog.mjs';
import { materializeEmbeddedMedia } from './materialize-media.mjs';
import { inspectMediaSignature } from './media-bytes.mjs';
import { ensureDirectory, pathExists } from './util.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(MODULE_DIRECTORY, '../ui');
const PROJECT_ROOT = path.resolve(MODULE_DIRECTORY, '../..');
const BUILD = '0.7.16-local';
const CAPABILITIES = Object.freeze({ favourites: true, hiddenMedia: true });
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.mpeg': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.pdf': 'application/pdf' };
const CONTENT_TYPE_CACHE = new Map();
const MEDIA_HEADER_BYTES = 128 * 1024;
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY'
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function normalizedHostname(value) {
  return String(value || '').toLowerCase().replace(/^\[|\]$/g, '');
}

function hostnameFromAuthority(authority) {
  try {
    return normalizedHostname(new URL(`http://${authority}`).hostname);
  } catch {
    return null;
  }
}

function isLoopbackHost(value) {
  return LOOPBACK_HOSTS.has(normalizedHostname(value));
}

function hasTrustedHostHeader(request) {
  return isLoopbackHost(hostnameFromAuthority(request.headers.host));
}

function hasTrustedWriteOrigin(request) {
  if (String(request.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && parsed.host.toLowerCase() === String(request.headers.host || '').toLowerCase();
  } catch {
    return false;
  }
}

function isWithin(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function existingPathWithin(base, candidate) {
  try {
    const resolved = await realpath(candidate);
    return isWithin(base, resolved) ? resolved : null;
  } catch {
    return null;
  }
}
const ARCHIVE_FILE_HEADERS = {
  ...SECURITY_HEADERS,
  'content-security-policy': "default-src 'none'; frame-ancestors 'self'",
  'x-frame-options': 'SAMEORIGIN'
};

function json(response, status, value) {
  response.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function serveLicense(response) {
  const contents = await readFile(path.join(PROJECT_ROOT, 'LICENSE'));
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': 'text/plain; charset=utf-8',
    'content-length': contents.byteLength,
    'content-disposition': 'inline; filename="LICENSE"',
    'cache-control': 'public, max-age=86400'
  });
  response.end(contents);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => { bytes += chunk.length; if (bytes > 64 * 1024) reject(new Error('Request body is too large.')); else chunks.push(chunk); });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function contentTypeForFile(filePath, fileStat) {
  const cached = CONTENT_TYPE_CACHE.get(filePath);
  if (cached?.bytes === fileStat.size && cached?.modified === fileStat.mtimeMs) return cached.contentType;
  const extensionType = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const header = Buffer.alloc(Math.min(MEDIA_HEADER_BYTES, fileStat.size));
  let handle;
  try {
    handle = await open(filePath, 'r');
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const detected = inspectMediaSignature(header.subarray(0, bytesRead), filePath, extensionType);
    const contentType = detected?.mimeType || extensionType;
    CONTENT_TYPE_CACHE.set(filePath, { bytes: fileStat.size, modified: fileStat.mtimeMs, contentType });
    return contentType;
  } finally {
    await handle?.close();
  }
}

async function serveFile(request, response, filePath, cacheControl = 'private, max-age=3600', { embeddable = false, extraHeaders = {} } = {}) {
  const fileStat = await stat(filePath);
  const contentType = await contentTypeForFile(filePath, fileStat);
  const headers = embeddable ? ARCHIVE_FILE_HEADERS : SECURITY_HEADERS;
  const stream = (options) => {
    const input = createReadStream(filePath, options);
    input.on('error', () => response.destroy());
    input.pipe(response);
  };
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), fileStat.size - 1) : fileStat.size - 1;
      if (start <= end && start < fileStat.size) {
        response.writeHead(206, { ...headers, ...extraHeaders, 'content-type': contentType, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${fileStat.size}`, 'accept-ranges': 'bytes' });
        stream({ start, end });
        return;
      }
    }
  }
  response.writeHead(200, { ...headers, ...extraHeaders, 'content-type': contentType, 'content-length': fileStat.size, 'accept-ranges': 'bytes', 'cache-control': cacheControl });
  stream();
}

function phaseFor(message) {
  const value = String(message || '');
  if (/Hashing|Copying|snapshot|consistency/i.test(value)) return 'snapshot';
  if (/OPFS|media/i.test(value)) return 'media';
  if (/Verifying|verify/i.test(value)) return 'verify';
  if (/index|Searchable|normal/i.test(value)) return 'library';
  return 'discover';
}

function userProgressMessage(message) {
  const value = String(message || '');
  const reconciliation = value.match(/Reconciling (\d+) changed Venice storage files?.*?short pass (\d+)\/(\d+)/i);
  if (reconciliation) return `Your browser updated ${reconciliation[1]} storage file${reconciliation[1] === '1' ? '' : 's'} in the background. Reconciling safely — pass ${reconciliation[2]} of ${reconciliation[3]}…`;
  const quietWindow = value.match(/quiet Venice storage window.*?short pass (\d+)\/(\d+)/i);
  if (quietWindow) return `Confirming a quiet browser-storage window — pass ${quietWindow[1]} of ${quietWindow[2]}…`;
  if (/changed during the first pass/i.test(value)) return 'Your browser made a background storage update. Reconciling only the changed files…';
  if (/Snapshot reconciled/i.test(value)) return 'Safe copy ready. Continuing with the Venice content check…';
  const mediaCount = value.match(/(?:OPFS media inventory|media inventory).*?(\d[\d,]*)/i);
  if (mediaCount) return `Checking ${mediaCount[1]} media files…`;
  if (/OPFS/i.test(value)) return 'Saving media to your archive…';
  if (/store|IndexedDB|database/i.test(value)) return 'Reading Venice conversations and Studio content…';
  if (/Hashing|Copying|snapshot/i.test(value)) return 'Creating a safe copy of your Venice data…';
  if (/consistency/i.test(value)) return 'Confirming Venice did not change during the update…';
  if (/Verifying|verify/i.test(value)) return 'Checking every saved file…';
  if (/index|Searchable|normal/i.test(value)) return 'Updating conversations, gallery and search…';
  return value;
}

function openDirectory(directory) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  return new Promise((resolve, reject) => {
    const child = spawn(command, [directory], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function revealFile(filePath) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const args = process.platform === 'darwin'
    ? ['-R', filePath]
    : process.platform === 'win32'
      ? ['/select,', filePath]
      : [path.dirname(filePath)];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function attachmentDisposition(fileName) {
  const name = path.basename(String(fileName || 'attachment'));
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'attachment';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function startArchiveService(archiveDirectory, { port = 0, host = '127.0.0.1', onSync = null, onOpenLocation = openDirectory, onRevealFile = revealFile, source = null, autoSync = false } = {}) {
  if (!isLoopbackHost(host)) throw new Error('Venice Archive can only listen on a loopback address (127.0.0.1, localhost or ::1).');
  const root = path.resolve(archiveDirectory);
  await materializeEmbeddedMedia(root, { apply: true });
  const catalog = await new ArchiveCatalog(root).reload();
  const sourceMap = new Map((await catalog.sourceDirectories()).map((source) => [source.name, source.directory]));
  const stateDirectory = await ensureDirectory(path.join(root, '.venice-archive'));
  const rootRealPath = await realpath(root);
  const historyPath = path.join(stateDirectory, 'sync-history.json');
  const favouritesPath = path.join(stateDirectory, 'favourites.json');
  const hiddenMediaPath = path.join(stateDirectory, 'hidden-media.json');
  let syncHistory = await pathExists(historyPath) ? JSON.parse(await readFile(historyPath, 'utf8')) : [];
  const readPreferenceKeys = async (filePath) => {
    if (!await pathExists(filePath)) return [];
    try {
      const document = JSON.parse(await readFile(filePath, 'utf8'));
      return Array.isArray(document?.keys) ? document.keys : [];
    } catch {
      return [];
    }
  };
  catalog.setFavouriteKeys(await readPreferenceKeys(favouritesPath));
  catalog.setHiddenMediaKeys(await readPreferenceKeys(hiddenMediaPath));
  let syncJob = { status: 'idle', phase: null, message: 'Ready. Select Fetch new content below to check Venice and save anything new.', progress: null, startedAt: null, completedAt: null, error: null, result: null, log: [] };

  const persistHistory = async () => writeFile(historyPath, `${JSON.stringify(syncHistory.slice(0, 30), null, 2)}\n`);
  const persistFavourites = async () => writeFile(favouritesPath, `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), keys: catalog.savedFavouriteKeys() }, null, 2)}\n`);
  const persistHiddenMedia = async () => writeFile(hiddenMediaPath, `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), keys: catalog.savedHiddenMediaKeys() }, null, 2)}\n`);
  const resolveMediaFile = async (id) => {
    const item = catalog.mediaItem(id);
    if (!item?.available) return null;
    const sourceDirectory = sourceMap.get(item.archiveSource);
    if (!sourceDirectory) return null;
    const filePath = path.resolve(sourceDirectory, item.path);
    if (filePath !== sourceDirectory && !filePath.startsWith(`${sourceDirectory}${path.sep}`)) return null;
    const safePath = await existingPathWithin(rootRealPath, filePath);
    return safePath ? { item, filePath: safePath } : null;
  };
  const updateSync = (update) => {
    const rawMessage = typeof update === 'string' ? update : update?.message;
    const message = userProgressMessage(rawMessage);
    syncJob = { ...syncJob, ...(typeof update === 'string' ? {} : update), phase: update?.phase || phaseFor(rawMessage), message: message || syncJob.message };
    if (rawMessage) syncJob.log = [...syncJob.log.slice(-99), { at: new Date().toISOString(), message, detail: rawMessage }];
  };

  const beginSync = async () => {
    if (!onSync) throw new Error('Sync is unavailable in this service process. Start it with the archive CLI.');
    if (syncJob.status === 'running') return syncJob;
    const before = catalog.overview().totals;
    syncJob = { status: 'running', phase: 'prepare', message: 'Checking Venice and preparing a consistent snapshot…', progress: null, startedAt: new Date().toISOString(), completedAt: null, error: null, result: null, log: [] };
    Promise.resolve().then(async () => {
      try {
        const result = await onSync(updateSync);
        await catalog.reload();
        sourceMap.clear();
        for (const source of await catalog.sourceDirectories()) sourceMap.set(source.name, source.directory);
        const after = catalog.overview().totals;
        const delta = Object.fromEntries(Object.keys(after).map((key) => [key, Math.max(0, Number(after[key] || 0) - Number(before[key] || 0))]));
        const changed = delta.conversations + delta.messages + delta.media;
        const newFiles = delta.image + delta.video + delta.audio + delta.file;
        const message = changed
          ? `Found and saved ${newFiles} new file${newFiles === 1 ? '' : 's'}, ${delta.conversations} conversation${delta.conversations === 1 ? '' : 's'} and ${delta.messages} message${delta.messages === 1 ? '' : 's'}. Current Venice content is saved and the archive check completed.`
          : `No new content found. We checked ${after.conversations} conversations and ${after.media} files; the archive check completed.`;
        syncJob = { ...syncJob, status: 'complete', phase: 'complete', message, completedAt: new Date().toISOString(), result: { ...result, before, after, delta } };
      } catch (error) {
        syncJob = { ...syncJob, status: 'error', phase: 'error', message: error.message, error: error.message, completedAt: new Date().toISOString() };
      }
      syncHistory = [{ ...syncJob, log: syncJob.log.slice(-25) }, ...syncHistory];
      await persistHistory();
    });
    return syncJob;
  };

  const server = http.createServer(async (request, response) => {
    try {
      if (!hasTrustedHostHeader(request)) return json(response, 403, { error: 'Requests must use the local Venice Archive address.' });
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      if (url.pathname === '/' || url.pathname === '/index.html') return await serveFile(request, response, path.join(UI_ROOT, 'index.html'), 'no-store');
      if (url.pathname === '/license') return await serveLicense(response);
      if (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico') return await serveFile(request, response, path.join(UI_ROOT, 'favicon.svg'), 'public, max-age=86400');
      if (url.pathname === '/assets/app.css') return await serveFile(request, response, path.join(UI_ROOT, 'app.css'), 'no-store');
      if (url.pathname === '/assets/app.js') return await serveFile(request, response, path.join(UI_ROOT, 'app.js'), 'no-store');
      if (url.pathname === '/api/overview') return json(response, 200, { ...catalog.overview(), build: BUILD, capabilities: CAPABILITIES, archivePath: root, source, sync: syncJob });
      if (url.pathname === '/api/conversations') return json(response, 200, catalog.listConversations(url.searchParams));
      if (url.pathname.startsWith('/api/conversations/')) {
        const item = catalog.conversation(decodeURIComponent(url.pathname.slice('/api/conversations/'.length)));
        return item ? json(response, 200, item) : json(response, 404, { error: 'Conversation not found.' });
      }
      if (url.pathname === '/api/media') return json(response, 200, catalog.listMedia(url.searchParams));
      if (url.pathname === '/api/favourites' && request.method === 'POST') {
        if (!hasTrustedWriteOrigin(request)) return json(response, 403, { error: 'Cross-site requests are not allowed.' });
        const body = JSON.parse(await readBody(request) || '{}');
        if (typeof body.favourite !== 'boolean') return json(response, 400, { error: 'A favourite state is required.' });
        const item = catalog.setMediaFavourite(String(body.id || ''), body.favourite);
        if (!item) return json(response, 404, { error: 'Media item not found.' });
        await persistFavourites();
        return json(response, 200, { item, favourites: catalog.savedFavouriteKeys().length });
      }
      if (url.pathname === '/api/hidden' && request.method === 'POST') {
        if (!hasTrustedWriteOrigin(request)) return json(response, 403, { error: 'Cross-site requests are not allowed.' });
        const body = JSON.parse(await readBody(request) || '{}');
        if (typeof body.hidden !== 'boolean') return json(response, 400, { error: 'A hidden state is required.' });
        const item = catalog.setMediaHidden(String(body.id || ''), body.hidden);
        if (!item) return json(response, 404, { error: 'Media item not found.' });
        await persistHiddenMedia();
        return json(response, 200, { item, hidden: catalog.savedHiddenMediaKeys().length });
      }
      if (url.pathname.startsWith('/api/media/')) {
        const item = catalog.mediaItem(decodeURIComponent(url.pathname.slice('/api/media/'.length)));
        return item ? json(response, 200, item) : json(response, 404, { error: 'Media item not found.' });
      }
      if (url.pathname === '/api/search') return json(response, 200, catalog.search(url.searchParams.get('q'), url.searchParams.get('type') || 'all', Number(url.searchParams.get('limit') || 100), url.searchParams.get('match') || 'contains'));
      if (url.pathname === '/api/sync/status') return json(response, 200, syncJob);
      if (url.pathname === '/api/sync-history') return json(response, 200, syncHistory);
      if (url.pathname === '/api/sync' && request.method === 'POST') {
        if (!hasTrustedWriteOrigin(request)) return json(response, 403, { error: 'Cross-site requests are not allowed.' });
        await readBody(request);
        return json(response, syncJob.status === 'running' ? 202 : 201, await beginSync());
      }
      if (url.pathname === '/api/open-location' && request.method === 'POST') {
        if (!hasTrustedWriteOrigin(request)) return json(response, 403, { error: 'Cross-site requests are not allowed.' });
        await onOpenLocation(root);
        return json(response, 200, { ok: true });
      }
      if (url.pathname === '/api/reveal-file' && request.method === 'POST') {
        if (!hasTrustedWriteOrigin(request)) return json(response, 403, { error: 'Cross-site requests are not allowed.' });
        const body = JSON.parse(await readBody(request) || '{}');
        const resolved = await resolveMediaFile(String(body.id || ''));
        if (!resolved) return json(response, 404, { error: 'This archived file is no longer present.' });
        await onRevealFile(resolved.filePath);
        return json(response, 200, { ok: true });
      }
      if (url.pathname.startsWith('/api/download/')) {
        const resolved = await resolveMediaFile(decodeURIComponent(url.pathname.slice('/api/download/'.length)));
        if (!resolved) return json(response, 404, { error: 'This archived file is no longer present.' });
        return await serveFile(request, response, resolved.filePath, 'no-store', { extraHeaders: { 'content-disposition': attachmentDisposition(resolved.item.fileName || resolved.filePath) } });
      }
      if (url.pathname.startsWith('/api/file/')) {
        const [, , , encodedSource, ...encodedPath] = url.pathname.split('/');
        const sourceName = decodeURIComponent(encodedSource || '');
        const source = sourceMap.get(sourceName);
        if (!source) return json(response, 404, { error: 'Archive source not found.' });
        const relative = encodedPath.map(decodeURIComponent).join('/');
        const filePath = path.resolve(source, relative);
        if (filePath !== source && !filePath.startsWith(`${source}${path.sep}`)) return json(response, 403, { error: 'File path is outside the archive.' });
        const safePath = await existingPathWithin(rootRealPath, filePath);
        if (!safePath) return json(response, 404, { error: 'This archived file is no longer present.' });
        return await serveFile(request, response, safePath, 'private, max-age=3600', { embeddable: true });
      }
      response.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    } catch (error) {
      json(response, 400, { error: error.message });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  if (autoSync) beginSync().catch((error) => { syncJob = { ...syncJob, status: 'error', phase: 'error', message: error.message, error: error.message, completedAt: new Date().toISOString() }; });
  const urlHost = normalizedHostname(host).includes(':') ? `[${normalizedHostname(host)}]` : normalizedHostname(host);
  return { server, catalog, beginSync, url: `http://${urlHost}:${server.address().port}/` };
}
