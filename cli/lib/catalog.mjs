import { createReadStream } from 'node:fs';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { correctMediaFileExtension, inspectMediaSignature, mediaExtensionsMatch } from './media-bytes.mjs';
import { pathExists } from './util.mjs';

const MEDIA_HEADER_BYTES = 128 * 1024;

function dateValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function inferConversationIdFromOpfs(item) {
  const original = String(item.originalPath || '');
  const parts = original.split('/').filter(Boolean);
  return parts[0] === 'media' && parts[1] ? parts[1] : null;
}

async function readJson(filePath, fallback) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); } catch { return fallback; }
}

async function readJsonLines(filePath) {
  const items = [];
  if (!(await pathExists(filePath))) return items;
  const lines = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) items.push(JSON.parse(line));
  return items;
}

function mergePreferFirst(existing, incoming) {
  if (!existing) return { ...incoming };
  const merged = { ...incoming, ...existing };
  for (const [key, value] of Object.entries(existing)) {
    if (value === null || value === undefined || value === '') merged[key] = incoming[key] ?? value;
  }
  return merged;
}

function mergeMediaPreferFirst(existing, incoming) {
  const merged = mergePreferFirst(existing, incoming);
  if (existing && !existing.available && incoming.available) {
    for (const key of ['path', 'available', 'status', 'bytes', 'sha256', 'mimeType', 'archiveSource', 'archiveDirectory']) merged[key] = incoming[key] ?? merged[key];
  }
  return merged;
}

function pathWithin(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function inspectCatalogFile(filePath, fileName, mimeType, cache) {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { exists: false };
    throw error;
  }
  const cached = cache.get(filePath);
  if (cached?.bytes === fileStat.size && cached?.modified === fileStat.mtimeMs) return cached;
  const header = Buffer.alloc(Math.min(MEDIA_HEADER_BYTES, fileStat.size));
  let handle;
  try {
    handle = await open(filePath, 'r');
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const inspected = inspectMediaSignature(header.subarray(0, bytesRead), fileName, mimeType);
    const result = { exists: true, bytes: fileStat.size, modified: fileStat.mtimeMs, inspected };
    cache.set(filePath, result);
    return result;
  } finally {
    await handle?.close();
  }
}

async function reconcileMediaFiles(items, cache) {
  const files = new Map();
  for (const item of items) {
    if (!item.available || !item.path || !item.archiveDirectory) continue;
    const sourceDirectory = path.resolve(item.archiveDirectory);
    const filePath = path.resolve(sourceDirectory, item.path);
    if (!pathWithin(sourceDirectory, filePath)) {
      item.available = false;
      item.status = 'missing';
      continue;
    }
    if (!files.has(filePath)) files.set(filePath, []);
    files.get(filePath).push(item);
  }
  for (const [filePath, linkedItems] of files) {
    const representative = linkedItems[0];
    const result = await inspectCatalogFile(filePath, representative.fileName || representative.path, representative.mimeType, cache);
    for (const item of linkedItems) {
      if (!result.exists) {
        item.available = false;
        item.status = 'missing';
        continue;
      }
      item.bytes = result.bytes;
      const detected = result.inspected;
      if (!detected) continue;
      const reportedMimeType = String(item.mimeType || '').toLowerCase().split(';')[0];
      const reportedFileName = item.fileName;
      const correctedFileName = correctMediaFileExtension(reportedFileName, detected.extension);
      const pathExtension = path.extname(item.path).toLowerCase();
      item.formatCorrected = Boolean(
        (reportedMimeType && reportedMimeType !== detected.mimeType) ||
        (reportedFileName && correctedFileName !== reportedFileName) ||
        (pathExtension && !mediaExtensionsMatch(pathExtension, detected.extension))
      );
      if (reportedMimeType && reportedMimeType !== detected.mimeType) item.reportedMimeType = item.mimeType;
      if (reportedFileName && correctedFileName !== reportedFileName) item.archivedFileName = reportedFileName;
      item.fileName = correctedFileName || item.fileName;
      item.mimeType = detected.mimeType;
      item.kind = detected.kind;
      item.width = detected.width || item.width;
      item.height = detected.height || item.height;
    }
  }
  const availableByHash = new Map();
  for (const item of items) {
    if (!item.available || !item.sha256) continue;
    if (!availableByHash.has(item.sha256)) availableByHash.set(item.sha256, []);
    availableByHash.get(item.sha256).push(item);
  }
  for (const item of items) {
    if (item.available || !item.sha256) continue;
    const candidates = availableByHash.get(item.sha256) || [];
    if (!candidates.length) continue;
    if (item.messageId && candidates.some((candidate) => candidate.messageId === item.messageId && candidate.kind === item.kind)) continue;
    const canonical = [...candidates].sort((a, b) => {
      const score = (value) => (value.formatCorrected ? 0 : 4) + (value.status === 'materialized' ? 2 : 0) + (/full-resolution|recovered/i.test(value.archiveSource) ? 1 : 0);
      return score(b) - score(a);
    })[0];
    item.indexedPath = item.path;
    item.indexedArchiveSource = item.archiveSource;
    item.path = canonical.path;
    item.archiveSource = canonical.archiveSource;
    item.archiveDirectory = canonical.archiveDirectory;
    item.available = true;
    item.status = 'deduped';
    item.bytes = canonical.bytes;
    item.mimeType = canonical.mimeType || item.mimeType;
    item.kind = canonical.kind || item.kind;
    item.width = canonical.width || item.width;
    item.height = canonical.height || item.height;
    item.recoveredByHash = true;
  }
}

function mediaDimension(raw, key) {
  const direct = Number(raw?.[key] || raw?.metadata?.[key]);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const dimensions = String(raw?.dimensions || raw?.metadata?.dimensions || '');
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(dimensions);
  return match ? Number(match[key === 'width' ? 1 : 2]) : null;
}

function unwrapRecord(record) {
  let value = record;
  for (let count = 0; count < 4; count += 1) {
    const nested = value?.documentData ?? value?.data ?? value?.doc ?? value?.value;
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) break;
    value = { ...value, ...nested };
  }
  return value || {};
}

function mediaKind(mimeType, source = '', fallback = 'file') {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (/image/i.test(source)) return 'image';
  if (/video/i.test(source)) return 'video';
  if (/audio/i.test(source)) return 'audio';
  return fallback || 'file';
}

function firstString(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (!['string', 'number'].includes(typeof value)) continue;
    const text = String(value).trim();
    if (text && text !== '0') return text;
  }
  return null;
}

function savedMediaDisposition(item) {
  const disposition = firstString(item?.mediaDisposition, item?.media_disposition, item?.mediaRole, item?.media_role)?.toLowerCase();
  return ['input', 'output'].includes(disposition) ? disposition : null;
}

function resolvedMediaDisposition(item, linkedMessage = null) {
  const explicit = savedMediaDisposition(item);
  if (explicit) return explicit;
  const source = String(item?.source || '');
  const original = String(item?.originalPath || '');
  if (/attachment|upload/i.test(source) || /(?:^|\/)attachments\//i.test(original)) return 'input';
  if (linkedMessage?.studioTurn && (linkedMessage.model || linkedMessage.sourceRole === 'assistant')) return 'output';
  if (linkedMessage?.role === 'user') return 'input';
  if (/messageImages|mindMedia|generated|output|studio(?:Image|Video|Audio).*Media/i.test(source)) return 'output';
  return 'media';
}

function savedMediaModel(item) {
  return firstString(item?.modelName, item?.model_name, item?.model, item?.modelId, item?.model_id);
}

function mediaRecordIdFromOpfs(originalPath) {
  const match = /^media\/[^/]+\/(?:attachments\/)?([^/]+)$/.exec(String(originalPath || ''));
  if (!match) return null;
  const extension = path.extname(match[1]);
  return extension ? match[1].slice(0, -extension.length) : match[1];
}

function internalMediaSidecar(item) {
  const name = String(item?.fileName || '');
  const original = String(item?.originalPath || '');
  return /^[a-f0-9]{64}\.meta$/i.test(name) || /(?:^|\/)video-editor\/.*\/[a-f0-9]{64}\.meta$/i.test(original);
}

function thumbnailMedia(item) {
  const original = String(item?.originalPath || '').replaceAll('\\', '/');
  const fileName = String(item?.fileName || path.basename(original));
  return /(?:^|\/)thumbnails\//i.test(original) || /_thumb\.[^.]+$/i.test(fileName);
}

function thumbnailStem(item) {
  const original = String(item?.originalPath || '').replaceAll('\\', '/');
  const fileName = String(item?.fileName || path.basename(original));
  return path.basename(fileName, path.extname(fileName)).replace(/_thumb$/i, '').replace(/_v\d+$/i, '').toLowerCase();
}

function uploadedMedia(item, linkedMessage = null) {
  const disposition = savedMediaDisposition(item);
  if (disposition) return disposition === 'input';
  const source = String(item?.source || '');
  const original = String(item?.originalPath || '');
  const attachment = /attachment|upload/i.test(source) || /(?:^|\/)attachments\//i.test(original);
  return attachment || linkedMessage?.role === 'user';
}

async function captureOpfsSidecars(directory, manifest) {
  const sidecars = new Map();
  for (const item of manifest?.opfs || []) {
    if (!/^[a-f0-9]{64}\.meta$/i.test(String(item.fileName || '')) || !item.archivedPath) continue;
    const metadata = await readJson(path.join(directory, item.archivedPath), null);
    if (!metadata || !/^[a-f0-9]{64}$/i.test(String(metadata.hash || ''))) continue;
    const original = String(item.path || '').replaceAll('\\', '/');
    const target = path.posix.join(path.posix.dirname(original), String(metadata.hash));
    sidecars.set(target, metadata);
  }
  return sidecars;
}

function studioTypeFromStore(storeName) {
  return /^studio(Image|Video|Audio)/.exec(String(storeName || ''))?.[1]?.toLowerCase() || null;
}

function studioTitle(type, raw = {}) {
  const saved = firstString(raw.title, raw.name);
  if (saved) return saved;
  return `${type ? `${type[0].toUpperCase()}${type.slice(1)} ` : ''}Studio`;
}

function studioConversationType(raw = {}, id = '') {
  const explicit = firstString(raw.studioType, raw.studio_type)?.toLowerCase();
  if (['image', 'video', 'audio'].includes(explicit)) return explicit;
  return /^video-studio-(?:gallery|inputs)-/i.test(String(id || raw.id || '')) ? 'video' : null;
}

function opfsMessageCandidate(originalPath) {
  const normalized = String(originalPath || '').replaceAll('\\', '/');
  const match = /^media\/([^/]+)\/(attachments\/)?([^/]+)$/.exec(normalized);
  if (!match) return null;
  const extension = path.extname(match[3]);
  const stem = extension ? match[3].slice(0, -extension.length) : match[3];
  const attachment = Boolean(match[2]);
  const messageId = attachment ? stem.replace(/__m\d+$/i, '') : stem;
  return messageId ? { conversationId: match[1], messageId, attachment, normalized } : null;
}

function inferOpfsMessageLink(item, messageMap) {
  const candidate = opfsMessageCandidate(item.originalPath);
  if (!candidate) return null;
  const conversationId = String(item.conversationId || candidate.conversationId);
  if (conversationId !== candidate.conversationId) return null;
  const direct = messageMap.get(`${conversationId}:${candidate.messageId}`);
  if (direct) return { conversationId, messageId: candidate.messageId, message: direct, attachment: candidate.attachment };
  const relativePath = candidate.normalized.replace(/^media\//, '');
  const exact = [...messageMap.values()].find((message) => (
    message.conversationId === conversationId && String(message.fileName || '').replaceAll('\\', '/') === relativePath
  ));
  return exact ? { conversationId, messageId: exact.id, message: exact, attachment: candidate.attachment } : null;
}

async function captureMessageMetadata(directory, manifest) {
  const metadata = new Map();
  for (const store of manifest?.stores || []) {
    if (!/^(?:messages|rxMessages|mindMessages|supportBotMessages)$/.test(String(store.name || '')) || !store.path) continue;
    const filePath = path.resolve(directory, store.path);
    if (filePath !== directory && !filePath.startsWith(`${directory}${path.sep}`)) continue;
    for (const encoded of await readJsonLines(filePath)) {
      const raw = unwrapRecord(encoded);
      const conversationId = firstString(raw.conversationId, raw.conversation_id, raw.mindConversationId, raw.mind_conversation_id, raw.threadId, raw.thread_id, raw.parentId);
      const id = firstString(raw.id, raw.messageId, raw.message_id);
      if (!conversationId || !id) continue;
      const studioType = studioConversationType({}, conversationId);
      metadata.set(`${conversationId}:${id}`, {
        model: firstString(raw.modelName, raw.model_name, raw.model, raw.modelId, raw.model_id),
        modelId: firstString(raw.modelId, raw.model_id),
        modelType: firstString(raw.modelType, raw.model_type),
        fileName: firstString(raw.fileName, raw.filename),
        fileType: firstString(raw.fileType, raw.file_type),
        sourceRole: firstString(raw.role, raw.author, raw.type),
        studioType,
        studioTurn: Boolean(studioType)
      });
    }
  }
  return metadata;
}

async function captureStudioRecords(directory, manifest) {
  const conversations = new Map();
  const messages = new Map();
  for (const store of manifest?.stores || []) {
    const name = String(store.name || '');
    const sessionStore = /^studio(?:Image|Video|Audio)Sessions$/.test(name);
    const turnStore = /^studio(?:Image|Video|Audio)Turns$/.test(name);
    if ((!sessionStore && !turnStore) || !store.path) continue;
    const filePath = path.resolve(directory, store.path);
    if (filePath !== directory && !filePath.startsWith(`${directory}${path.sep}`)) continue;
    const studioType = studioTypeFromStore(name);
    for (const encoded of await readJsonLines(filePath)) {
      const raw = unwrapRecord(encoded);
      if (sessionStore) {
        const id = firstString(raw.id, raw.sessionId, raw.session_id);
        if (!id) continue;
        conversations.set(id, {
          id,
          title: studioTitle(studioType, raw),
          preview: '',
          kind: 'studio',
          studioType,
          createdAt: dateValue(raw.createdAt || raw.created_at || raw.createdAtUnixTimestamp || raw.created_at_unix_timestamp),
          updatedAt: dateValue(raw.updatedAt || raw.updated_at || raw.updatedAtUnixTimestamp || raw.updated_at_unix_timestamp),
          studioSession: true
        });
        continue;
      }
      const conversationId = firstString(raw.sessionId, raw.session_id);
      const id = firstString(raw.id, raw.turnId, raw.turn_id);
      if (!conversationId || !id) continue;
      const createdAt = dateValue(raw.createdAt || raw.created_at || raw.createdAtUnixTimestamp || raw.created_at_unix_timestamp);
      messages.set(`${conversationId}:${id}`, {
        id,
        conversationId,
        role: 'user',
        text: firstString(raw.prompt, raw.text) || '',
        createdAt,
        updatedAt: createdAt,
        status: firstString(raw.mode, raw.type),
        studioType,
        studioTurn: true
      });
      if (!conversations.has(conversationId)) conversations.set(conversationId, {
        id: conversationId,
        title: studioTitle(studioType),
        preview: '',
        kind: 'studio',
        studioType,
        createdAt,
        updatedAt: createdAt,
        studioSession: true
      });
    }
  }
  return { conversations: [...conversations.values()], messages: [...messages.values()] };
}

async function captureMediaLinks(directory, manifest) {
  const links = new Map();
  for (const store of manifest?.stores || []) {
    if (!/^(?:mindAttachments|mindMedia|studio(?:Image|Video|Audio)TurnMedia)$/.test(String(store.name || '')) || !store.path) continue;
    const filePath = path.resolve(directory, store.path);
    if (filePath !== directory && !filePath.startsWith(`${directory}${path.sep}`)) continue;
    for (const encoded of await readJsonLines(filePath)) {
      const raw = unwrapRecord(encoded);
      const id = raw.id == null ? '' : String(raw.id);
      if (!id) continue;
      const mimeType = raw.mimeType || raw.mime_type || raw.contentType || raw.content_type || null;
      const modelId = firstString(raw.modelId, raw.model_id);
      const studioMedia = /^studio(?:Image|Video|Audio)TurnMedia$/.test(String(store.name || ''));
      links.set(id, {
        conversationId: raw.conversationId || raw.conversation_id || raw.mindConversationId || raw.mind_conversation_id || (studioMedia ? raw.sessionId || raw.session_id : null) || null,
        messageId: raw.messageId || raw.message_id || raw.mindMessageId || raw.mind_message_id || (studioMedia ? raw.turnId || raw.turn_id : null) || null,
        fileName: raw.fileName || raw.filename || raw.name || null,
        mimeType,
        kind: mediaKind(mimeType, store.name),
        source: store.name,
        prompt: firstString(raw.prompt, raw.enhancedPrompt, raw.enhanced_prompt),
        model: firstString(raw.modelName, raw.model_name, raw.model, modelId),
        modelId,
        mediaDisposition: savedMediaDisposition(raw),
        createdAt: dateValue(raw.createdAt || raw.created_at || raw.createdAtUnixTimestamp || raw.created_at_unix_timestamp)
      });
    }
  }
  return links;
}

function excerptAround(value, tokens, maximum = 420) {
  const text = String(value || '');
  if (text.length <= maximum) return text;
  const lower = text.toLowerCase();
  const positions = tokens.map((token) => lower.indexOf(token)).filter((position) => position >= 0);
  const match = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, Math.min(match - 120, text.length - maximum));
  return `${start ? '…' : ''}${text.slice(start, start + maximum).trim()}${start + maximum < text.length ? '…' : ''}`;
}

function searchTerms(query) {
  const terms = [];
  for (const match of String(query || '').toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)) terms.push((match[1] || match[2] || '').trim());
  return [...new Set(terms.filter(Boolean))];
}

function wholeTermPattern(term) {
  const literal = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${literal}(?=$|[^\\p{L}\\p{N}])`, 'iu');
}

export class ArchiveCatalog {
  constructor(root) {
    this.root = path.resolve(root);
    this.loadedAt = null;
    this.conversations = [];
    this.messages = [];
    this.media = [];
    this.conversationMap = new Map();
    this.messageMap = new Map();
    this.mediaMap = new Map();
    this.mediaInspectionCache = new Map();
    this.favouriteKeys = new Set();
    this.hiddenMediaKeys = new Set();
    this.verifiedCapture = null;
    this.verification = null;
    this.importManifest = null;
  }

  async sourceDirectories() {
    const sources = [];
    const capturesRoot = path.join(this.root, 'captures');
    if (await pathExists(capturesRoot)) {
      const entries = (await readdir(capturesRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('capture-'))
        .map((entry) => entry.name)
        .sort().reverse();
      for (const name of entries) {
        const directory = path.join(capturesRoot, name);
        const verification = await readJson(path.join(directory, 'capture.verification.json'), null);
        if (verification?.ok) sources.push({ name, directory, capture: true, verification });
      }
    }
    if (await pathExists(path.join(this.root, 'indexes'))) sources.push({ name: 'imported archive', directory: this.root, capture: false, verification: null });
    const materializedMedia = path.join(this.root, 'materialized-media');
    if (await pathExists(path.join(materializedMedia, 'indexes', 'media.json'))) sources.push({ name: 'full-resolution media', directory: materializedMedia, capture: false, recovery: true, verification: null });
    const recovered = path.join(this.root, 'recovered-media');
    if (await pathExists(path.join(recovered, 'indexes', 'media.json'))) sources.push({ name: 'recovered media', directory: recovered, capture: false, recovery: true, verification: null });
    const recoveredContent = path.join(this.root, 'recovered-content');
    if (
      await pathExists(path.join(recoveredContent, 'indexes', 'conversations.json')) ||
      await pathExists(path.join(recoveredContent, 'indexes', 'messages.jsonl')) ||
      await pathExists(path.join(recoveredContent, 'indexes', 'media.json'))
    ) sources.push({ name: 'recovered content', directory: recoveredContent, capture: false, recovery: true, verification: null });
    return sources;
  }

  async reload() {
    const conversationMap = new Map();
    const messageMap = new Map();
    const mediaByKey = new Map();
    const sources = await this.sourceDirectories();
    const hasVerifiedCapture = sources.some((source) => source.capture);
    const capturedConversationIds = new Set();
    this.verifiedCapture = sources.find((source) => source.capture)?.name || null;
    this.verification = sources.find((source) => source.capture)?.verification || null;
    this.importManifest = await readJson(path.join(this.root, 'venice-archive.manifest.json'), null);

    for (const source of sources) {
      const indexes = path.join(source.directory, 'indexes');
      const conversations = await readJson(path.join(indexes, 'conversations.json'), []);
      const messages = await readJsonLines(path.join(indexes, 'messages.jsonl'));
      const mediaDocument = await readJson(path.join(indexes, 'media.json'), { items: [] });
      const captureManifest = source.capture ? await readJson(path.join(source.directory, 'capture.manifest.json'), null) : null;
      const studioRecords = source.capture ? await captureStudioRecords(source.directory, captureManifest) : { conversations: [], messages: [] };
      const messageMetadata = source.capture ? await captureMessageMetadata(source.directory, captureManifest) : new Map();
      const opfsByPath = new Map((captureManifest?.opfs || []).map((item) => [item.archivedPath, item]));
      const opfsSidecars = source.capture ? await captureOpfsSidecars(source.directory, captureManifest) : new Map();
      const verifiedOpfs = new Map((source.verification?.opfs || []).map((item) => [item.archivedPath, item]));
      const mediaLinks = source.capture ? await captureMediaLinks(source.directory, captureManifest) : new Map();

      for (const raw of [...conversations, ...studioRecords.conversations]) {
        const id = String(raw.id || 'recovered');
        if (!source.capture && !source.recovery && hasVerifiedCapture && id === 'recovered') continue;
        const studioType = studioConversationType(raw, id);
        const item = {
          ...raw,
          id,
          title: raw.title || 'Untitled conversation',
          preview: raw.preview || '',
          kind: studioType ? 'studio' : (raw.kind || 'chat'),
          studioType: studioType || raw.studioType || null,
          studioSession: Boolean(studioType || raw.studioSession),
          createdAt: dateValue(raw.createdAt),
          updatedAt: dateValue(raw.updatedAt || raw.createdAt),
          archiveSource: source.name,
          archiveDirectory: source.directory
        };
        conversationMap.set(id, mergePreferFirst(conversationMap.get(id), item));
        if (source.capture) capturedConversationIds.add(id);
      }

      for (const raw of [...messages, ...studioRecords.messages]) {
        const conversationId = String(raw.conversationId || 'recovered');
        if (!source.capture && !source.recovery && hasVerifiedCapture && (capturedConversationIds.has(conversationId) || conversationId === 'recovered')) continue;
        const id = String(raw.id || `${conversationId}:${raw.createdAt || messageMap.size}`);
        const key = `${conversationId}:${id}`;
        const savedMetadata = messageMetadata.get(key);
        const studioType = savedMetadata?.studioType || raw.studioType || studioConversationType({}, conversationId);
        const item = {
          ...raw,
          id,
          conversationId,
          text: String(raw.text || ''),
          role: studioType === 'video' ? 'user' : (raw.role || 'unknown'),
          sourceRole: savedMetadata?.sourceRole || raw.sourceRole || raw.role || null,
          model: firstString(savedMetadata?.model, raw.modelName, raw.model_name, raw.model, raw.modelId, raw.model_id),
          modelId: firstString(savedMetadata?.modelId, raw.modelId, raw.model_id),
          modelType: firstString(savedMetadata?.modelType, raw.modelType, raw.model_type),
          fileName: firstString(savedMetadata?.fileName, raw.fileName, raw.filename),
          fileType: firstString(savedMetadata?.fileType, raw.fileType, raw.file_type),
          studioType: studioType || null,
          studioTurn: Boolean(savedMetadata?.studioTurn || raw.studioTurn || studioType),
          createdAt: dateValue(raw.createdAt),
          updatedAt: dateValue(raw.updatedAt || raw.createdAt),
          archiveSource: source.name,
          archiveDirectory: source.directory
        };
        messageMap.set(key, mergePreferFirst(messageMap.get(key), item));
      }

      for (const raw of mediaDocument.items || []) {
        const opfs = opfsByPath.get(raw.path);
        const sidecar = opfsSidecars.get(String(opfs?.path || '').replaceAll('\\', '/'));
        const verified = verifiedOpfs.get(raw.path);
        const linkedRecord = mediaLinks.get(String(raw.mediaId || raw.id || '')) || mediaLinks.get(mediaRecordIdFromOpfs(opfs?.path));
        const sha256 = raw.sha256 || verified?.sha256 || null;
        const id = String(raw.mediaId || raw.id || (sha256 ? `sha256:${sha256}` : `${source.name}:${raw.path || mediaByKey.size}`));
        const item = {
          ...raw,
          id,
          mediaId: id,
          kind: linkedRecord?.kind || (sidecar ? mediaKind(sidecar.mimeType, sidecar.type, raw.kind) : raw.kind) || 'file',
          status: raw.path ? 'materialized' : (raw.status || 'metadata-only'),
          available: Boolean(raw.path),
          bytes: Number(raw.bytes ?? verified?.bytes ?? opfs?.size ?? 0),
          width: mediaDimension(raw, 'width'),
          height: mediaDimension(raw, 'height'),
          duration: Number(raw.duration || raw.metadata?.duration || 0) || null,
          sha256,
          originalPath: opfs?.path || null,
          conversationId: raw.conversationId || linkedRecord?.conversationId || inferConversationIdFromOpfs({ originalPath: opfs?.path }) || null,
          messageId: raw.messageId || linkedRecord?.messageId || null,
          fileName: linkedRecord?.fileName || sidecar?.fileName || sidecar?.name || raw.fileName || null,
          mimeType: linkedRecord?.mimeType || sidecar?.mimeType || raw.mimeType || opfs?.mimeType || null,
          source: linkedRecord?.source || raw.source || source.name,
          prompt: raw.prompt || linkedRecord?.prompt || null,
          model: firstString(raw.modelName, raw.model_name, raw.model, linkedRecord?.model, raw.modelId, raw.model_id) || null,
          modelId: firstString(raw.modelId, raw.model_id, linkedRecord?.modelId),
          mediaDisposition: savedMediaDisposition(raw) || linkedRecord?.mediaDisposition || null,
          createdAt: dateValue(raw.createdAt || linkedRecord?.createdAt || sidecar?.storedAt || opfs?.lastModified),
          archiveSource: source.name,
          archiveDirectory: source.directory
        };
        if (!item.messageId) {
          const inferred = inferOpfsMessageLink(item, messageMap);
          if (inferred) {
            item.conversationId = inferred.conversationId;
            item.messageId = inferred.messageId;
            if (!item.mediaDisposition) {
              item.mediaDisposition = inferred.attachment
                ? 'input'
                : inferred.message.model || inferred.message.sourceRole === 'assistant' || inferred.message.role === 'assistant'
                  ? 'output'
                  : null;
            }
          }
        }
        if (!source.capture && hasVerifiedCapture && !item.available) continue;
        const stableId = raw.mediaId || raw.id;
        const relationship = item.conversationId && item.messageId
          ? `${item.conversationId}:${item.messageId}:${stableId || raw.path || id}`
          : null;
        const key = relationship ? `relationship:${relationship}` : source.recovery && stableId ? `id:${stableId}` : sha256 ? `sha256:${sha256}` : stableId ? `id:${stableId}` : `${source.name}:${id}`;
        mediaByKey.set(key, mergeMediaPreferFirst(mediaByKey.get(key), item));
      }
    }

    let messages = [...messageMap.values()].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    const canonicalMessageIds = new Set(messages.filter((message) => message.conversationId !== 'recovered').map((message) => message.id));
    messages = messages.filter((message) => message.conversationId !== 'recovered' || !canonicalMessageIds.has(message.id));
    if (!messages.some((message) => message.conversationId === 'recovered')) conversationMap.delete('recovered');
    const messagesByConversation = new Map();
    for (const message of messages) {
      if (!messagesByConversation.has(message.conversationId)) messagesByConversation.set(message.conversationId, []);
      messagesByConversation.get(message.conversationId).push(message);
    }
    const allMedia = [...mediaByKey.values()].filter((item) => !internalMediaSidecar(item));
    await reconcileMediaFiles(allMedia, this.mediaInspectionCache);
    for (const item of allMedia) item.isThumbnail = thumbnailMedia(item);
    for (const item of allMedia) {
      if (!item.messageId || !item.conversationId) continue;
      const linkedMessage = messageMap.get(`${item.conversationId}:${item.messageId}`);
      if (!linkedMessage) continue;
      if (!item.createdAt) item.createdAt = linkedMessage.createdAt;
      if (!item.prompt) item.prompt = linkedMessage.text;
    }
    const fullResolutionStems = new Set(allMedia
      .filter((item) => item.available && !item.isThumbnail && item.conversationId && item.messageId)
      .map((item) => `${item.conversationId}_${item.messageId}`.toLowerCase()));
    const materializedMessageMedia = new Set(allMedia.filter((item) => item.available && item.messageId).map((item) => `${item.messageId}:${item.kind}`));
    const linkedMaterializedHashes = new Map();
    for (const item of allMedia.filter((entry) => entry.available && entry.messageId && entry.sha256)) {
      if (!linkedMaterializedHashes.has(item.sha256)) linkedMaterializedHashes.set(item.sha256, new Set());
      linkedMaterializedHashes.get(item.sha256).add(String(item.conversationId || ''));
    }
    const seenLinkedFiles = new Set();
    const media = allMedia.filter((item) => {
      if (item.isThumbnail && fullResolutionStems.has(thumbnailStem(item))) return false;
      if (!item.available && item.messageId && materializedMessageMedia.has(`${item.messageId}:${item.kind}`)) return false;
      if (item.available && !item.messageId && item.sha256) {
        const linkedConversations = linkedMaterializedHashes.get(item.sha256);
        if (linkedConversations && (!item.conversationId || linkedConversations.has(String(item.conversationId)))) return false;
      }
      if (item.available && item.messageId && item.sha256) {
        const key = `${item.conversationId || ''}:${item.messageId}:${item.kind}:${item.sha256}`;
        if (seenLinkedFiles.has(key)) return false;
        seenLinkedFiles.add(key);
      }
      return true;
    });
    const mediaByConversation = new Map();
    for (const item of media) {
      item.isUploaded = uploadedMedia(item);
      if (!item.conversationId) {
        item.mediaDisposition = resolvedMediaDisposition(item);
        if (item.mediaDisposition === 'input') item.model = null;
        continue;
      }
      const conversationMessages = messagesByConversation.get(String(item.conversationId)) || [];
      const linkedIndex = conversationMessages.findIndex((message) => message.id === item.messageId);
      const linkedMessage = linkedIndex >= 0 ? conversationMessages[linkedIndex] : null;
      const disposition = resolvedMediaDisposition(item, linkedMessage);
      const precedingUser = linkedMessage?.role === 'assistant' && disposition === 'input'
        ? conversationMessages.slice(0, linkedIndex).reverse().find((message) => message.role === 'user')
        : null;
      item.displayMessageId = precedingUser?.id || item.messageId || null;
      item.mediaDisposition = disposition;
      item.model = disposition === 'input'
        ? null
        : savedMediaModel(item) || (disposition === 'output' ? linkedMessage?.model : null) || (linkedMessage?.role === 'assistant' ? linkedMessage.model : null);
      item.modelId = disposition === 'input'
        ? null
        : firstString(item.modelId, disposition === 'output' ? linkedMessage?.modelId : null);
      item.isUploaded = item.isUploaded || uploadedMedia(item, linkedMessage) || item.mediaDisposition === 'input';
      if (!mediaByConversation.has(String(item.conversationId))) mediaByConversation.set(String(item.conversationId), []);
      mediaByConversation.get(String(item.conversationId)).push(item);
    }
    for (const [conversationId, items] of mediaByConversation) {
      const order = new Map((messagesByConversation.get(conversationId) || []).map((message, index) => [message.id, index]));
      items.sort((a, b) => {
        const messageOrder = (order.get(a.displayMessageId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.displayMessageId) ?? Number.MAX_SAFE_INTEGER);
        if (messageOrder) return messageOrder;
        const dispositionOrder = ({ input: 0, output: 1, media: 2 }[a.mediaDisposition] ?? 2) - ({ input: 0, output: 1, media: 2 }[b.mediaDisposition] ?? 2);
        if (dispositionOrder) return dispositionOrder;
        return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
      });
    }
    for (const [id, conversation] of conversationMap) {
      const linkedMessages = messagesByConversation.get(id) || [];
      const linkedMedia = mediaByConversation.get(id) || [];
      conversation.messageCount = linkedMessages.length || conversation.messageCount || 0;
      conversation.mediaCount = linkedMedia.length || conversation.mediaCount || 0;
      conversation.models = [...new Set([...linkedMessages.map((message) => message.model), ...linkedMedia.map((mediaItem) => mediaItem.model)].filter(Boolean))];
      if (!conversation.preview) conversation.preview = linkedMessages.find((message) => message.text)?.text.slice(0, 260) || '';
      if (!conversation.updatedAt) conversation.updatedAt = linkedMessages.map((message) => message.createdAt).filter(Boolean).sort().at(-1) || conversation.createdAt;
    }
    for (const item of media) {
      const conversation = item.conversationId ? conversationMap.get(String(item.conversationId)) : null;
      item.conversationTitle = conversation?.title || null;
      item.conversationKind = conversation?.kind || null;
      item.conversationMessageCount = item.conversationId ? (messagesByConversation.get(String(item.conversationId)) || []).length : 0;
    }

    this.conversationMap = conversationMap;
    this.messageMap = messageMap;
    this.mediaMap = mediaByKey;
    this.messagesByConversation = messagesByConversation;
    this.mediaByConversation = mediaByConversation;
    this.conversations = [...conversationMap.values()].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    this.messages = messages;
    this.media = media.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    this.loadedAt = new Date().toISOString();
    return this;
  }

  overview() {
    const libraryMedia = this.media.filter((item) => !item.isThumbnail);
    const available = libraryMedia.filter((item) => item.available);
    const kinds = Object.fromEntries(['image', 'video', 'audio', 'file'].map((kind) => [kind, available.filter((item) => item.kind === kind).length]));
    return {
      verified: Boolean(this.verification?.ok),
      verifiedAt: this.verification?.verifiedAt || null,
      captureId: this.verifiedCapture,
      loadedAt: this.loadedAt,
      totals: { conversations: this.conversations.length, messages: this.messages.length, media: available.length, unavailableMedia: libraryMedia.filter((item) => !item.available).length, ...kinds },
      recentConversations: this.conversations.slice(0, 10),
      recentMedia: available.filter((item) => !item.isUploaded && !this.isHidden(item)).slice(0, 12).map((item) => this.publicMedia(item))
    };
  }

  favouriteKey(item) {
    if (!item) return null;
    const hash = String(item.sha256 || '').trim().toLowerCase();
    return hash ? `sha256:${hash}` : item.id != null ? `id:${String(item.id)}` : null;
  }

  isFavourite(item) {
    const key = this.favouriteKey(item);
    return Boolean(key && this.favouriteKeys.has(key));
  }

  setFavouriteKeys(keys = []) {
    this.favouriteKeys = new Set([...keys].filter((key) => typeof key === 'string' && /^(?:sha256|id):/.test(key)));
    return this;
  }

  savedFavouriteKeys() {
    return [...this.favouriteKeys].sort();
  }

  setMediaFavourite(id, favourite) {
    const item = this.media.find((entry) => entry.id === String(id));
    const key = this.favouriteKey(item);
    if (!item || !key) return null;
    if (favourite) this.favouriteKeys.add(key);
    else this.favouriteKeys.delete(key);
    return this.publicMedia(item);
  }

  isHidden(item) {
    const key = this.favouriteKey(item);
    return Boolean(key && this.hiddenMediaKeys.has(key));
  }

  setHiddenMediaKeys(keys = []) {
    this.hiddenMediaKeys = new Set([...keys].filter((key) => typeof key === 'string' && /^(?:sha256|id):/.test(key)));
    return this;
  }

  savedHiddenMediaKeys() {
    return [...this.hiddenMediaKeys].sort();
  }

  setMediaHidden(id, hidden) {
    const item = this.media.find((entry) => entry.id === String(id));
    const key = this.favouriteKey(item);
    if (!item || !key) return null;
    if (hidden) this.hiddenMediaKeys.add(key);
    else this.hiddenMediaKeys.delete(key);
    return this.publicMedia(item);
  }

  publicMedia(item) {
    const formatVersion = item.sha256?.slice(0, 16) || `${item.bytes || 0}-${String(item.mimeType || 'file').replace(/[^a-z0-9]+/gi, '-')}`;
    return {
      ...item,
      isFavourite: this.isFavourite(item),
      isHidden: this.isHidden(item),
      fileUrl: item.available ? `/api/file/${encodeURIComponent(item.archiveSource)}/${encodeURIComponent(item.path)}?v=${encodeURIComponent(formatVersion)}` : null,
      downloadUrl: item.available ? `/api/download/${encodeURIComponent(item.id)}` : null
    };
  }

  listConversations(params) {
    const query = String(params.get('q') || '').toLowerCase();
    const kind = params.get('kind') || 'all';
    const sort = params.get('sort') || 'recent';
    const limit = Math.min(200, Math.max(1, Number(params.get('limit') || 60)));
    let items = this.conversations.filter((item) => (!query || `${item.title} ${item.preview} ${item.models?.join(' ')}`.toLowerCase().includes(query)) && (kind === 'all' || item.kind === kind));
    if (sort === 'oldest') items.sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')));
    if (sort === 'title') items.sort((a, b) => a.title.localeCompare(b.title));
    if (sort === 'messages') items.sort((a, b) => b.messageCount - a.messageCount);
    return { total: items.length, items: items.slice(0, limit) };
  }

  conversation(id) {
    const item = this.conversationMap.get(String(id));
    if (!item) return null;
    return { ...item, messages: this.messagesByConversation.get(String(id)) || [], media: (this.mediaByConversation.get(String(id)) || []).map((media) => this.publicMedia(media)) };
  }

  listMedia(params) {
    const query = String(params.get('q') || '').toLowerCase();
    const kind = params.get('kind') || 'all';
    const status = params.get('status') || 'available';
    const source = params.get('source') || 'all';
    const includeUploads = params.get('uploads') === 'include';
    const includeThumbnails = params.get('thumbnails') === 'include';
    const favouriteOnly = params.get('favourites') === 'only';
    const includeHidden = params.get('hidden') === 'include';
    const sort = params.get('sort') || 'recent';
    const limit = Math.min(2000, Math.max(1, Number(params.get('limit') || 120)));
    const matching = this.media.filter((item) => {
      const searchable = `${item.fileName || ''} ${item.prompt || ''} ${item.mimeType || ''} ${item.source || ''}`.toLowerCase();
      return (!query || searchable.includes(query)) && (includeThumbnails || !item.isThumbnail) && (status === 'all' || (status === 'available' ? item.available : !item.available)) && (source === 'all' || item.source === source);
    });
    const favouriteFiltered = favouriteOnly ? matching.filter((item) => this.isFavourite(item)) : matching;
    const uploads = favouriteFiltered.filter((item) => item.isUploaded).length;
    const uploadFiltered = includeUploads ? favouriteFiltered : favouriteFiltered.filter((item) => !item.isUploaded);
    const selectedKind = kind === 'all' ? uploadFiltered : uploadFiltered.filter((item) => item.kind === kind);
    const hidden = selectedKind.filter((item) => this.isHidden(item)).length;
    const filtered = includeHidden ? uploadFiltered : uploadFiltered.filter((item) => !this.isHidden(item));
    const favourites = filtered.filter((item) => this.isFavourite(item)).length;
    const facets = { all: filtered.length, image: filtered.filter((item) => item.kind === 'image').length, video: filtered.filter((item) => item.kind === 'video').length, audio: filtered.filter((item) => item.kind === 'audio').length, file: filtered.filter((item) => item.kind === 'file').length };
    const items = [...(kind === 'all' ? filtered : filtered.filter((item) => item.kind === kind))];
    if (sort === 'oldest') items.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    if (sort === 'model') items.sort((a, b) => String(a.model || '\uffff').localeCompare(String(b.model || '\uffff'), undefined, { sensitivity: 'base' }) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    if (sort === 'name') items.sort((a, b) => String(a.fileName || a.title || '').localeCompare(String(b.fileName || b.title || ''), undefined, { numeric: true, sensitivity: 'base' }) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    if (sort === 'session') {
      const conversationOrder = new Map(this.conversations.map((conversation, index) => [String(conversation.id), index]));
      items.sort((a, b) => {
        const aConversation = a.conversationId == null ? Number.MAX_SAFE_INTEGER : (conversationOrder.get(String(a.conversationId)) ?? Number.MAX_SAFE_INTEGER);
        const bConversation = b.conversationId == null ? Number.MAX_SAFE_INTEGER : (conversationOrder.get(String(b.conversationId)) ?? Number.MAX_SAFE_INTEGER);
        if (aConversation !== bConversation) return aConversation - bConversation;
        if (String(a.conversationId || '') !== String(b.conversationId || '')) return String(a.conversationId || '').localeCompare(String(b.conversationId || ''));
        return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
      });
    }
    return { total: items.length, facets, favourites, favouriteOnly, hidden, hiddenIncluded: includeHidden, sort, uploads, uploadsIncluded: includeUploads, thumbnailsIncluded: includeThumbnails, items: items.slice(0, limit).map((item) => this.publicMedia(item)) };
  }

  mediaItem(id) {
    const item = this.media.find((entry) => entry.id === String(id));
    return item ? this.publicMedia(item) : null;
  }

  search(query, type = 'all', limit = 100, matchMode = 'contains') {
    const tokens = searchTerms(query);
    const wholePatterns = matchMode === 'whole' ? tokens.map(wholeTermPattern) : [];
    const matches = (value) => matchMode === 'whole'
      ? wholePatterns.every((pattern) => pattern.test(value))
      : tokens.every((token) => value.includes(token));
    const allResults = [];
    for (const item of this.conversations) if (matches(`${item.title} ${item.preview}`.toLowerCase())) allResults.push({ type: 'conversation', id: item.id, conversationId: item.id, title: item.title, excerpt: excerptAround(item.preview, tokens), date: item.updatedAt });
    for (const item of this.messages) if (matches(`${item.conversationTitle || ''} ${item.text}`.toLowerCase())) allResults.push({ type: 'message', id: item.id, conversationId: item.conversationId, title: item.conversationTitle || this.conversationMap.get(item.conversationId)?.title, excerpt: excerptAround(item.text, tokens), date: item.createdAt, role: item.role, model: item.model });
    for (const item of this.media) if (!item.isThumbnail && !this.isHidden(item) && matches(`${item.fileName || ''} ${item.prompt || ''} ${item.source || ''}`.toLowerCase())) allResults.push({ type: 'media', id: item.id, conversationId: item.conversationId, title: item.fileName || item.kind, excerpt: excerptAround(item.prompt || item.mimeType || item.source, tokens), date: item.createdAt, kind: item.kind, available: item.available });
    const counts = Object.fromEntries(['conversation', 'message', 'media'].map((kind) => [kind, allResults.filter((item) => item.type === kind).length]));
    const results = type === 'all' ? allResults : allResults.filter((item) => item.type === type);
    return { total: allResults.length, filteredTotal: results.length, counts, items: results.slice(0, Math.min(300, limit)) };
  }
}
