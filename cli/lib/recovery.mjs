import { createHash } from 'node:crypto';
import { copyFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { ArchiveCatalog } from './catalog.mjs';
import { decodeBinaryPayload, inspectMedia } from './media-bytes.mjs';
import { pathExists, sha256File } from './util.mjs';

const MAX_DECRYPT_DEPTH = 4;

function dateValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function keyBytes(document) {
  return Object.values(document?.keyVault || {}).map((item) => {
    const values = String(item?.keyString || '').split(',').map((value) => Number(value.trim()));
    return values.length === 32 && values.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
      ? Uint8Array.from(values)
      : null;
  }).filter(Boolean);
}

export async function loadVendoredNacl(projectRoot) {
  const source = await readFile(path.join(projectRoot, 'extension', 'lib', 'nacl.min.js'), 'utf8');
  // Reuse the host typed-array constructors: TweetNaCl performs instanceof
  // checks, and values created in a separate VM realm would otherwise fail.
  const context = { self: {}, Uint8Array, Uint16Array, Int32Array, Float64Array };
  vm.runInNewContext(source, context, { filename: 'nacl.min.js' });
  if (!context.self.nacl?.secretbox?.open) throw new Error('The bundled NaCl decoder could not be loaded');
  return context.self.nacl;
}

export function decryptLegacyRecord(record, keys, nacl) {
  if (!record || typeof record !== 'object' || !record.__encryptedData) return record;
  let current = record;
  for (let depth = 0; depth < MAX_DECRYPT_DEPTH && current?.__encryptedData; depth += 1) {
    const encrypted = decodeBinaryPayload(current.__encryptedData);
    if (!encrypted || encrypted.length < 41) throw new Error('Legacy record contains an invalid encrypted payload');
    let decoded = null;
    for (const key of keys) {
      const opened = nacl.secretbox.open(encrypted.subarray(24), encrypted.subarray(0, 24), key);
      if (!opened) continue;
      try {
        decoded = JSON.parse(new TextDecoder().decode(opened));
        break;
      } catch {}
    }
    if (!decoded) throw new Error('Legacy record could not be decrypted with its embedded recovery keys');
    const { __encryptedData, $types, ...outer } = current;
    current = { ...outer, ...decoded };
  }
  if (current?.__encryptedData) throw new Error('Legacy record exceeds the supported encryption depth');
  if (current?.$types) {
    for (const field of Object.keys(current.$types)) {
      if (typeof current[field]?.encoded === 'string') current[field] = current[field].encoded;
    }
    delete current.$types;
  }
  return current;
}

function textValue(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  return textValue(value.text || value.content || value.value || value.message || '');
}

export const detectMedia = inspectMedia;

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeMessage(raw, conversationTitle = null) {
  const createdAt = dateValue(raw.createdAt || raw.createdAtUnixTimestamp || raw.created_at);
  return {
    id: String(raw.id),
    conversationId: String(raw.conversationId || raw.conversation_id),
    conversationTitle,
    role: raw.role || raw.author || 'unknown',
    model: raw.model || raw.modelId || raw.model_id || null,
    createdAt,
    updatedAt: dateValue(raw.updatedAt || raw.updatedAtUnixTimestamp || raw.updated_at) || createdAt,
    text: textValue(raw.content ?? raw.text ?? raw.message ?? raw.prompt),
    source: 'legacy-backup'
  };
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function readJsonLines(file) {
  if (!(await pathExists(file))) return [];
  return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function candidateFiles(root) {
  const results = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) results.push(...await candidateFiles(absolute));
    else if (entry.isFile() && /^VeniceAI_/i.test(entry.name)) results.push(absolute);
  }
  return results;
}

async function fileHeader(file, length = 16) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content);
  await rename(temporary, file);
}

async function atomicCopy(source, destination) {
  if (await pathExists(destination)) return;
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    await copyFile(source, temporary);
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function relativeMediaPath(sha256, extension) {
  return ['media', 'sha256', sha256.slice(0, 2), `${sha256}${extension}`].join('/');
}

export async function recoverLegacyContent({ archive, backups = [], mediaDirectories = [], apply = false, projectRoot }) {
  const archiveRoot = path.resolve(archive);
  const recoveryRoot = path.join(archiveRoot, 'recovered-content');
  const indexes = path.join(recoveryRoot, 'indexes');
  const catalog = await new ArchiveCatalog(archiveRoot).reload();
  const knownConversationIds = new Set(catalog.conversations.map((item) => item.id));
  const knownMessageKeys = new Set(catalog.messages.map((item) => `${item.conversationId}:${item.id}`));
  const knownHashes = new Set(catalog.media.map((item) => item.sha256).filter(Boolean));
  const existingConversations = await readJson(path.join(indexes, 'conversations.json'), []);
  const existingMessages = await readJsonLines(path.join(indexes, 'messages.jsonl'));
  const existingMediaDocument = await readJson(path.join(indexes, 'media.json'), { items: [] });
  const conversationMap = new Map(existingConversations.map((item) => [String(item.id), item]));
  const messageMap = new Map(existingMessages.map((item) => [`${item.conversationId}:${item.id}`, item]));
  const mediaMap = new Map((existingMediaDocument.items || []).map((item) => [item.sha256 || item.mediaId || item.id, item]));
  for (const item of existingMediaDocument.items || []) if (item.sha256) knownHashes.add(item.sha256);

  const nacl = backups.length ? await loadVendoredNacl(projectRoot) : null;
  const additions = { conversations: [], messages: [], media: [] };
  const imports = [];

  for (const backupPath of backups.map((value) => path.resolve(value))) {
    const before = {
      conversations: additions.conversations.length,
      messages: additions.messages.length,
      media: additions.media.length
    };
    const document = JSON.parse(await readFile(backupPath, 'utf8'));
    const keys = keyBytes(document);
    if (!keys.length) throw new Error(`${path.basename(backupPath)} has no usable embedded recovery key`);
    const conversations = (document.data?.conversations || []).map((item) => decryptLegacyRecord(item, keys, nacl));
    const titles = new Map();
    for (const raw of conversations) {
      const id = String(raw.id || '');
      if (!id) continue;
      const title = textValue(raw.name || raw.title) || 'Recovered conversation';
      titles.set(id, title);
      if (knownConversationIds.has(id) || conversationMap.has(id)) continue;
      const createdAt = dateValue(raw.createdAt || raw.createdAtUnixTimestamp || raw.created_at);
      const item = {
        id,
        title,
        preview: '',
        kind: raw.type === 'image' ? 'chat' : (raw.type || 'chat'),
        createdAt,
        updatedAt: dateValue(raw.updatedAt || raw.updatedAtUnixTimestamp || raw.updated_at) || createdAt,
        messageCount: 0,
        mediaCount: 0,
        source: 'legacy-backup'
      };
      conversationMap.set(id, item);
      additions.conversations.push(item);
    }

    const decryptedMessages = (document.data?.messages || []).map((item) => decryptLegacyRecord(item, keys, nacl));
    const normalizedMessages = decryptedMessages.filter((raw) => raw.id && (raw.conversationId || raw.conversation_id)).map((raw) => normalizeMessage(raw, titles.get(String(raw.conversationId || raw.conversation_id))));
    for (const item of normalizedMessages) {
      const key = `${item.conversationId}:${item.id}`;
      if (knownMessageKeys.has(key) || messageMap.has(key)) continue;
      messageMap.set(key, item);
      additions.messages.push(item);
    }

    const messagesById = new Map(normalizedMessages.map((item) => [item.id, item]));
    const orderedByConversation = new Map();
    for (const item of normalizedMessages) {
      if (!orderedByConversation.has(item.conversationId)) orderedByConversation.set(item.conversationId, []);
      orderedByConversation.get(item.conversationId).push(item);
    }
    for (const items of orderedByConversation.values()) items.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

    for (const encoded of document.data?.images || []) {
      const raw = decryptLegacyRecord(encoded, keys, nacl);
      const bytes = decodeBinaryPayload(raw.contentBinary || raw.content || raw.data);
      if (!bytes?.length) continue;
      const sha256 = sha256Bytes(bytes);
      if (knownHashes.has(sha256) || mediaMap.has(sha256)) continue;
      const linkedMessage = messagesById.get(String(raw.messageId || encoded.messageId || ''));
      const conversationMessages = orderedByConversation.get(linkedMessage?.conversationId) || [];
      const linkedIndex = conversationMessages.findIndex((item) => item.id === linkedMessage?.id);
      const prompt = linkedIndex >= 0 ? conversationMessages.slice(0, linkedIndex).reverse().find((item) => item.role === 'user')?.text || null : null;
      const detected = inspectMedia(bytes, raw.fileName || raw.filename || '');
      const relative = relativeMediaPath(sha256, detected.extension);
      const item = {
        mediaId: `legacy-image:${linkedMessage?.id || sha256}`,
        path: relative,
        kind: detected.kind,
        status: 'recovered',
        available: true,
        sha256,
        bytes: bytes.length,
        mimeType: detected.mimeType,
        fileName: raw.fileName || raw.filename || path.basename(relative),
        conversationId: linkedMessage?.conversationId || null,
        messageId: linkedMessage?.id || raw.messageId || encoded.messageId || null,
        prompt,
        model: linkedMessage?.role === 'assistant' ? linkedMessage.model : null,
        createdAt: linkedMessage?.createdAt || null,
        source: 'messageImages',
        recoveredFrom: path.basename(backupPath)
      };
      item._bytes = bytes;
      mediaMap.set(sha256, item);
      knownHashes.add(sha256);
      additions.media.push(item);
    }
    imports.push({
      type: 'legacy-backup',
      sourceName: path.basename(backupPath),
      sourceSha256: await sha256File(backupPath),
      recovered: {
        conversations: additions.conversations.length - before.conversations,
        messages: additions.messages.length - before.messages,
        media: additions.media.length - before.media
      }
    });
  }

  for (const directory of mediaDirectories.map((value) => path.resolve(value))) {
    let scanned = 0;
    let recovered = 0;
    for (const file of await candidateFiles(directory)) {
      scanned += 1;
      const sha256 = await sha256File(file);
      if (knownHashes.has(sha256) || mediaMap.has(sha256)) continue;
      const fileStat = await stat(file);
      const detected = inspectMedia(await fileHeader(file), file);
      const relative = relativeMediaPath(sha256, detected.extension);
      const item = {
        mediaId: `sha256:${sha256}`,
        path: relative,
        kind: detected.kind,
        status: 'recovered',
        available: true,
        sha256,
        bytes: fileStat.size,
        mimeType: detected.mimeType,
        fileName: path.basename(file),
        conversationId: null,
        messageId: null,
        createdAt: dateValue(fileStat.mtime),
        source: 'manual-venice-download',
        recoveredFrom: path.posix.join(path.basename(directory), path.relative(directory, file).split(path.sep).join('/'))
      };
      item._sourceFile = file;
      mediaMap.set(sha256, item);
      knownHashes.add(sha256);
      additions.media.push(item);
      recovered += 1;
    }
    imports.push({ type: 'venice-named-media', sourceName: path.basename(directory), scanned, recovered });
  }

  for (const item of conversationMap.values()) {
    const messages = [...messageMap.values()].filter((message) => message.conversationId === item.id);
    const media = [...mediaMap.values()].filter((mediaItem) => mediaItem.conversationId === item.id);
    item.messageCount = messages.length;
    item.mediaCount = media.length;
    item.models = [...new Set(messages.map((message) => message.model).filter(Boolean))];
    if (!item.preview) item.preview = messages.find((message) => message.text)?.text.slice(0, 260) || '';
  }

  if (apply && (additions.conversations.length || additions.messages.length || additions.media.length)) {
    for (const item of additions.media) {
      const destination = path.join(recoveryRoot, ...item.path.split('/'));
      if (item._bytes) {
        await mkdir(path.dirname(destination), { recursive: true });
        if (!(await pathExists(destination))) await writeFile(destination, item._bytes);
      } else if (item._sourceFile) {
        await atomicCopy(item._sourceFile, destination);
      }
      if (await sha256File(destination) !== item.sha256) throw new Error(`Recovered media failed verification: ${item.fileName}`);
    }
    const cleanedMedia = [...mediaMap.values()].map(({ _bytes, _sourceFile, ...item }) => item);
    await atomicWrite(path.join(indexes, 'conversations.json'), `${JSON.stringify([...conversationMap.values()], null, 2)}\n`);
    await atomicWrite(path.join(indexes, 'messages.jsonl'), `${[...messageMap.values()].map((item) => JSON.stringify(item)).join('\n')}\n`);
    await atomicWrite(path.join(indexes, 'media.json'), `${JSON.stringify({ totals: { total: cleanedMedia.length }, items: cleanedMedia }, null, 2)}\n`);
    const previousManifest = await readJson(path.join(recoveryRoot, 'recovery.manifest.json'), { imports: [] });
    const importMap = new Map((previousManifest.imports || []).map((item) => [`${item.type}:${item.sourceSha256 || item.sourceName}`, item]));
    for (const item of imports) importMap.set(`${item.type}:${item.sourceSha256 || item.sourceName}`, item);
    await atomicWrite(path.join(recoveryRoot, 'recovery.manifest.json'), `${JSON.stringify({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      note: 'Recovered content is kept separate from verified captures. Source paths and recovery keys are not retained.',
      totals: { conversations: conversationMap.size, messages: messageMap.size, media: cleanedMedia.length },
      imports: [...importMap.values()]
    }, null, 2)}\n`);
  }

  return {
    mode: apply ? 'applied' : 'dry-run',
    additions: {
      conversations: additions.conversations.length,
      messages: additions.messages.length,
      media: additions.media.length,
      bytes: additions.media.reduce((total, item) => total + Number(item.bytes || 0), 0)
    },
    imports,
    recoveryLayer: 'recovered-content'
  };
}
