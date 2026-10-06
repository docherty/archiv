import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { correctMediaFileExtension, decodeBinaryPayload, inspectMedia } from './media-bytes.mjs';
import { pathExists, sha256File } from './util.mjs';

function unwrap(record) {
  let value = record;
  for (let count = 0; count < 4; count += 1) {
    const nested = value?.documentData ?? value?.data ?? value?.doc ?? value?.value;
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) break;
    value = { ...value, ...nested };
  }
  return value || {};
}

function dateValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function visitJsonLines(file, visit) {
  if (!(await pathExists(file))) return;
  const input = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let index = 0;
  for await (const line of input) {
    if (!line.trim()) continue;
    await visit(unwrap(JSON.parse(line)), index++);
  }
}

async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content);
  await rename(temporary, file);
}

async function verifiedCaptures(archiveRoot) {
  const root = path.join(archiveRoot, 'captures');
  let entries = [];
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const captures = [];
  for (const entry of entries.filter((item) => item.isDirectory() && item.name.startsWith('capture-')).sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = path.join(root, entry.name);
    const verification = await readJson(path.join(directory, 'capture.verification.json'), null);
    if (!verification?.ok) continue;
    const manifest = await readJson(path.join(directory, 'capture.manifest.json'), null);
    if (manifest) captures.push({ id: entry.name, directory, manifest });
  }
  return captures;
}

function storeKey(capture, store) {
  return `${capture.id}:${store.name}:${store.fingerprint || store.path}`;
}

function possibleInlineMediaStore(name) {
  const value = String(name || '');
  if (/^(?:rxdb-physical:|idb:|rxdb:rx-migration-state-meta-)/.test(value)) return false;
  return /(?:message(?:Images|Videos|AudioAttachments|FileAttachments|ImageAttachments|VideoAttachments)|rxMessageImages|mind(?:Attachments|Media)|studio(?:Audio|Image|Video).*Media|Media)$/i.test(value);
}

function payloadLength(payload) {
  if (typeof payload === 'string') return payload.length;
  if (typeof payload?.encoded === 'string') return payload.encoded.length;
  if (Array.isArray(payload)) return payload.length;
  if (payload && typeof payload === 'object') return Object.keys(payload).filter((key) => /^\d+$/.test(key)).length;
  return 0;
}

function payloadEdgeFingerprint(payload) {
  const text = typeof payload === 'string' ? payload : typeof payload?.encoded === 'string' ? payload.encoded : null;
  if (!text) return null;
  return createHash('sha256').update(String(text.length)).update(text.slice(0, 4096)).update(text.slice(-4096)).digest('hex');
}

function recordIdentity(raw, storeName, index) {
  return String(raw.messageId || raw.message_id || raw.id || raw._id || `${storeName}-${index}`);
}

function text(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => text(item?.text ?? item?.content ?? item)).filter(Boolean).join('\n');
  if (value && typeof value === 'object') return text(value.text ?? value.content ?? value.value ?? '');
  return '';
}

function firstString(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (!['string', 'number'].includes(typeof value)) continue;
    const result = String(value).trim();
    if (result && result !== '0') return result;
  }
  return null;
}

function mediaDisposition(raw, source = '') {
  const explicit = firstString(raw.mediaDisposition, raw.media_disposition, raw.mediaRole, raw.media_role)?.toLowerCase();
  if (['input', 'output'].includes(explicit)) return explicit;
  return /attachment|upload/i.test(source) ? 'input' : null;
}

async function messageLookup(captures) {
  const messages = new Map();
  for (const capture of captures) {
    await visitJsonLines(path.join(capture.directory, 'indexes', 'messages.jsonl'), (raw) => {
      if (!raw.id) return;
      messages.set(String(raw.id), {
        id: String(raw.id),
        conversationId: raw.conversationId ? String(raw.conversationId) : null,
        createdAt: dateValue(raw.createdAt),
        role: raw.role || null,
        model: firstString(raw.model, raw.modelName, raw.model_name, raw.modelId, raw.model_id),
        text: text(raw.text).slice(0, 2000)
      });
    });
  }
  return messages;
}

async function writeContentAddressed(root, relative, bytes, sha256) {
  const destination = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(destination), { recursive: true });
  if (await pathExists(destination)) {
    const fileStat = await stat(destination);
    if (fileStat.size === bytes.length && await sha256File(destination) === sha256) return destination;
  }
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, bytes);
    if (await sha256File(temporary) !== sha256) throw new Error('Materialized media failed its SHA-256 check');
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return destination;
}

async function verifyLayerFiles(layerRoot, items, onProgress) {
  const unique = new Map(items.map((item) => [item.path, item]));
  let index = 0;
  for (const item of unique.values()) {
    const file = path.join(layerRoot, ...String(item.path || '').split('/'));
    const fileStat = await stat(file);
    if (fileStat.size !== Number(item.bytes) || await sha256File(file) !== item.sha256) throw new Error(`Full-resolution media verification failed: ${item.fileName || item.path}`);
    index += 1;
    if (index === 1 || index === unique.size || index % 50 === 0) onProgress(`Verifying full-resolution media ${index}/${unique.size}`);
  }
  return { files: unique.size, bytes: [...unique.values()].reduce((total, item) => total + Number(item.bytes || 0), 0) };
}

function materializationManifest(items, processed, verifiedTotals) {
  return {
    schemaVersion: 2,
    updatedAt: new Date().toISOString(),
    note: 'Full-resolution files materialized from lossless capture stores. Source captures remain unchanged.',
    totals: { media: items.length, ...verifiedTotals },
    verification: { status: 'verified', verifiedAt: new Date().toISOString(), algorithm: 'sha256' },
    processedStores: [...processed.values()]
  };
}

export async function materializeEmbeddedMedia(archiveDirectory, { apply = true, onProgress = () => {} } = {}) {
  const archiveRoot = path.resolve(archiveDirectory);
  const layerRoot = path.join(archiveRoot, 'materialized-media');
  const indexes = path.join(layerRoot, 'indexes');
  const mediaPath = path.join(indexes, 'media.json');
  const manifestPath = path.join(layerRoot, 'materialization.manifest.json');
  const previousDocument = await readJson(mediaPath, { items: [] });
  const previousManifest = await readJson(manifestPath, { processedStores: [] });
  const captures = await verifiedCaptures(archiveRoot);
  const processed = new Map((previousManifest.processedStores || []).map((item) => [item.key, item]));
  const pending = [];
  for (const capture of captures) {
    for (const store of capture.manifest.stores || []) {
      if (!possibleInlineMediaStore(store.name)) continue;
      const key = storeKey(capture, store);
      if (!processed.has(key)) pending.push({ capture, store, key });
    }
  }
  const needsLayerVerification = previousDocument.items?.length && (previousManifest.schemaVersion !== 2 || previousManifest.verification?.status !== 'verified');
  let verifiedPreviousTotals = null;
  if (apply && needsLayerVerification) verifiedPreviousTotals = await verifyLayerFiles(layerRoot, previousDocument.items, onProgress);
  if (!pending.length) {
    if (apply && verifiedPreviousTotals) await atomicWrite(manifestPath, `${JSON.stringify(materializationManifest(previousDocument.items, processed, verifiedPreviousTotals), null, 2)}\n`);
    return { mode: apply ? 'up-to-date' : 'dry-run', captures: captures.length, stores: 0, records: 0, payloads: 0, added: 0, bytes: 0, total: previousDocument.items?.length || 0 };
  }

  const messages = await messageLookup(captures);
  const items = new Map((previousDocument.items || []).map((item) => [item.mediaId || item.id, item]));
  const bySourceRecord = new Map();
  for (const item of items.values()) if (item.source && item.sourceRecordId) bySourceRecord.set(`${item.source}:${item.sourceRecordId}`, item);
  let records = 0;
  let payloads = 0;
  let added = 0;
  let bytesAdded = 0;

  for (let storeIndex = 0; storeIndex < pending.length; storeIndex += 1) {
    const { capture, store, key } = pending[storeIndex];
    const storeFile = path.join(capture.directory, store.path);
    let storeRecords = 0;
    let storePayloads = 0;
    await visitJsonLines(storeFile, async (raw, index) => {
      records += 1;
      storeRecords += 1;
      const payload = raw.contentBinary ?? raw.content_binary ?? raw.binaryContent ?? null;
      if (payload === null || payload === undefined) return;
      payloads += 1;
      storePayloads += 1;
      const sourceRecordId = recordIdentity(raw, store.name, index);
      const sourceRecordKey = `${store.name}:${sourceRecordId}`;
      const encodedLength = payloadLength(payload);
      const encodedEdgeSha256 = payloadEdgeFingerprint(payload);
      const previous = bySourceRecord.get(sourceRecordKey);
      // Length/edge samples are diagnostics, not identity. Middle-byte edits and
      // encoded view offsets can change originals while those samples stay equal.
      const decoded = decodeBinaryPayload(payload);
      if (!decoded?.length) return;
      const inspected = inspectMedia(decoded, raw.fileName || raw.filename || raw.name || '', raw.mimeType || raw.mime_type || raw.contentType || raw.content_type || '');
      if (inspected.mimeType === 'application/octet-stream') return;
      const sha256 = createHash('sha256').update(decoded).digest('hex');
      const relative = ['media', 'sha256', sha256.slice(0, 2), `${sha256}${inspected.extension}`].join('/');
      if (previous?.sha256 === sha256) {
        // Same decoded bytes need no new version; also repair a missing/corrupt
        // materialized object from this captured source before trusting the reuse.
        if (apply) await writeContentAddressed(layerRoot, relative, decoded, sha256);
        return;
      }
      if (apply) await writeContentAddressed(layerRoot, relative, decoded, sha256);
      const messageId = String(raw.messageId || raw.message_id || sourceRecordId);
      const linked = messages.get(messageId);
      const conversationId = raw.conversationId || raw.conversation_id || linked?.conversationId || null;
      const reportedFileName = raw.fileName || raw.filename || raw.name || null;
      const fileName = reportedFileName
        ? correctMediaFileExtension(reportedFileName, inspected.extension)
        : `${conversationId ? `${conversationId}_` : ''}${messageId}${inspected.extension}`;
      const mediaId = `embedded:${store.name}:${sourceRecordId}:${sha256.slice(0, 16)}`;
      const item = {
        mediaId,
        path: relative,
        kind: inspected.kind,
        status: 'materialized',
        available: true,
        sha256,
        bytes: decoded.length,
        width: inspected.width || null,
        height: inspected.height || null,
        mimeType: inspected.mimeType,
        fileName,
        conversationId: conversationId ? String(conversationId) : null,
        messageId,
        prompt: text(raw.prompt || '') || linked?.text || '',
        model: firstString(raw.modelName, raw.model_name, raw.model, raw.modelId, raw.model_id) || (linked?.role === 'assistant' ? linked.model : null),
        modelId: firstString(raw.modelId, raw.model_id),
        mediaDisposition: mediaDisposition(raw, store.name),
        createdAt: dateValue(raw.createdAt || raw.created_at || raw.createdAtUnixTimestamp || raw.created_at_unix_timestamp) || linked?.createdAt || null,
        source: store.name,
        sourceRecordId,
        sourceCapture: capture.id,
        encodedLength,
        encodedEdgeSha256
      };
      if (!items.has(mediaId)) { added += 1; bytesAdded += decoded.length; }
      items.set(mediaId, item);
      bySourceRecord.set(sourceRecordKey, item);
    });
    processed.set(key, { key, captureId: capture.id, store: store.name, fingerprint: store.fingerprint || null, records: storeRecords, payloads: storePayloads });
    onProgress(`Materializing full-resolution media ${storeIndex + 1}/${pending.length}: ${store.name}`);
  }

  for (const item of items.values()) {
    if (!item.messageId) continue;
    const linked = messages.get(String(item.messageId));
    if (!linked) continue;
    item.conversationId = item.conversationId || linked.conversationId;
    item.createdAt = item.createdAt || linked.createdAt;
    item.prompt = item.prompt || linked.text || '';
    item.model = item.model || (linked.role === 'assistant' ? linked.model : null);
    if (/^(?:embedded:)/.test(item.mediaId) && item.conversationId && /^([^_]+)(?:\.[^.]+)?$/.test(item.fileName || '')) item.fileName = `${item.conversationId}_${item.messageId}${path.extname(item.fileName)}`;
  }

  if (apply) {
    const values = [...items.values()];
    const uniqueFiles = new Map(values.map((item) => [item.path, item]));
    await atomicWrite(mediaPath, `${JSON.stringify({ totals: { total: values.length }, items: values }, null, 2)}\n`);
    await atomicWrite(manifestPath, `${JSON.stringify(materializationManifest(values, processed, {
      files: uniqueFiles.size,
      bytes: [...uniqueFiles.values()].reduce((total, item) => total + Number(item.bytes || 0), 0)
    }), null, 2)}\n`);
  }
  return { mode: apply ? 'applied' : 'dry-run', captures: captures.length, stores: pending.length, records, payloads, added, bytes: bytesAdded, total: items.size };
}
