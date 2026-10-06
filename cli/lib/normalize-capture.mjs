import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { resolveAssetPath } from './asset-store.mjs';

function text(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => text(item?.text ?? item?.content ?? item)).filter(Boolean).join('\n');
  if (value && typeof value === 'object') return text(value.text ?? value.content ?? value.value ?? value.summary ?? '');
  return '';
}

function responseText(outputItems) {
  if (!Array.isArray(outputItems)) return '';
  const messages = outputItems.filter((item) => item?.type === 'message').map((item) => text(item.content)).filter(Boolean);
  return messages.join('\n\n').trim();
}

function unwrap(record) {
  let value = record;
  for (let count = 0; count < 4; count += 1) {
    const nested = value?.documentData ?? value?.data ?? value?.doc ?? value?.value;
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) break;
    value = { ...value, ...nested };
  }
  return value || {};
}

function identifier(record, fallbacks = []) {
  for (const value of [record.id, record._id, record.messageId, record.conversationId, ...fallbacks]) {
    if (value !== null && value !== undefined && String(value).trim()) return String(value);
  }
  return null;
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

function studioTypeFromStore(storeName) {
  return /^studio(Image|Video|Audio)/.exec(String(storeName || ''))?.[1]?.toLowerCase() || null;
}

function studioTitle(type, raw = {}) {
  return firstString(raw.title, raw.name) || `${type ? `${type[0].toUpperCase()}${type.slice(1)} ` : ''}Studio`;
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
  return messageId ? { conversationId: match[1], messageId, attachment } : null;
}

function finiteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function internalMediaSidecar(item) {
  return /^[a-f0-9]{64}\.meta$/i.test(String(item?.fileName || ''));
}

function opfsMediaIdentity(item) {
  const match = /^media\/([^/]+)\/(?:attachments\/)?([^/]+)$/.exec(String(item?.path || ''));
  if (!match) return null;
  const extension = path.extname(match[2]);
  const recordId = extension ? match[2].slice(0, -extension.length) : match[2];
  return `${match[1]}:${recordId}`;
}

async function readJsonLines(filePath, visit) {
  const lines = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let index = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    await visit(unwrap(JSON.parse(line)), index++);
  }
}

export async function normalizeCapture(captureDirectory) {
  const manifest = JSON.parse(await readFile(path.join(captureDirectory, 'capture.manifest.json'), 'utf8'));
  const conversations = new Map();
  const messageRecords = [];
  const media = [];

  for (const store of manifest.stores || []) {
    // Physical and generic stores remain in the lossless layer; their logical
    // counterparts are preferred here to avoid duplicate search results.
    if (/^(?:rxdb-physical:|idb:)/.test(store.name)) continue;
    const filePath = path.join(captureDirectory, store.path);
    if (/^studio(?:Image|Video|Audio)Sessions$/.test(store.name)) {
      const studioType = studioTypeFromStore(store.name);
      await readJsonLines(filePath, (raw, index) => {
        const id = identifier(raw, [`${store.name}-${index}`]);
        conversations.set(id, {
          id,
          title: studioTitle(studioType, raw),
          kind: 'studio',
          studioType,
          studioSession: true,
          createdAt: raw.createdAt || raw.created_at || raw.createdAtUnixTimestamp || raw.created_at_unix_timestamp || null,
          updatedAt: raw.updatedAt || raw.updated_at || raw.updatedAtUnixTimestamp || raw.updated_at_unix_timestamp || null,
          messageCount: 0,
          mediaCount: 0,
          preview: ''
        });
      });
      continue;
    }
    if (/^studio(?:Image|Video|Audio)Turns$/.test(store.name)) {
      const studioType = studioTypeFromStore(store.name);
      await readJsonLines(filePath, (raw, index) => {
        const conversationId = firstString(raw.sessionId, raw.session_id) || 'recovered';
        const id = identifier(raw, [`${store.name}-${index}`]);
        messageRecords.push({
          conversationId,
          id,
          role: 'user',
          model: null,
          createdAt: raw.createdAt || raw.created_at || raw.createdAtUnixTimestamp || raw.created_at_unix_timestamp || null,
          updatedAt: raw.updatedAt || raw.updated_at || raw.updatedAtUnixTimestamp || raw.updated_at_unix_timestamp || null,
          status: firstString(raw.mode, raw.type),
          studioType,
          studioTurn: true,
          text: text(raw.prompt || raw.text || ''),
          media: [],
          attachments: []
        });
      });
      continue;
    }
    if (/^(?:conversations|rxConversations|mindConversations|supportBotThreads)$/.test(store.name)) {
      await readJsonLines(filePath, (raw, index) => {
        const id = identifier(raw, [`${store.name}-${index}`]);
        const studioType = studioConversationType(raw, id);
        conversations.set(id, {
          id,
          title: raw.title || raw.name || raw.subject || raw.agentName || 'Untitled conversation',
          kind: studioType ? 'studio' : (/mind/i.test(store.name) ? 'agentic' : 'chat'),
          studioType,
          studioSession: Boolean(studioType),
          createdAt: raw.createdAt || raw.created_at || raw.createdAtUnixTimestamp || raw.created_at_unix_timestamp || null,
          updatedAt: raw.updatedAt || raw.updated_at || raw.updatedAtUnixTimestamp || raw.updated_at_unix_timestamp || null,
          messageCount: 0,
          mediaCount: 0,
          preview: text(raw.preview || raw.summary || '')
        });
      });
      continue;
    }
    if (/^(?:messages|rxMessages|mindMessages|supportBotMessages)$/.test(store.name)) {
      await readJsonLines(filePath, (raw, index) => {
        const conversationId = String(raw.conversationId || raw.conversation_id || raw.mindConversationId || raw.mind_conversation_id || raw.threadId || raw.thread_id || raw.parentId || 'recovered');
        const body = responseText(raw.output_items || raw.outputItems) || text(raw.text ?? raw.content ?? raw.output ?? raw.message ?? raw.input);
        const id = identifier(raw, [`${store.name}-${index}`]);
        const usage = raw.usage || raw.tokenUsage || raw.token_usage || {};
        const studioType = studioConversationType({}, conversationId);
        const sourceRole = raw.role || raw.author || raw.type || 'unknown';
        const inputTokens = finiteNumber(raw.inputTokens, raw.input_tokens, usage.inputTokens, usage.input_tokens, usage.promptTokens, usage.prompt_tokens);
        const outputTokens = finiteNumber(raw.outputTokens, raw.output_tokens, usage.outputTokens, usage.output_tokens, usage.completionTokens, usage.completion_tokens);
        messageRecords.push({
          conversationId,
          id,
          role: studioType === 'video' ? 'user' : sourceRole,
          sourceRole,
          model: firstString(raw.modelName, raw.model_name, raw.model, raw.modelId, raw.model_id),
          modelId: firstString(raw.modelId, raw.model_id),
          modelType: raw.modelType || raw.model_type || null,
          fileName: raw.fileName || raw.filename || null,
          fileType: raw.fileType || raw.file_type || null,
          studioType,
          studioTurn: Boolean(studioType),
          createdAt: raw.createdAt || raw.created_at || raw.createdAtUnixTimestamp || raw.created_at_unix_timestamp || null,
          updatedAt: raw.updatedAt || raw.updated_at || raw.updatedAtUnixTimestamp || raw.updated_at_unix_timestamp || null,
          inputTokens,
          outputTokens,
          totalTokens: finiteNumber(raw.totalTokens, raw.total_tokens, usage.totalTokens, usage.total_tokens, inputTokens !== null || outputTokens !== null ? Number(inputTokens || 0) + Number(outputTokens || 0) : null),
          executionTimeMs: finiteNumber(raw.totalInferenceTime, raw.total_inference_time, raw.executionTime, raw.execution_time),
          status: raw.streamingStatus || raw.streaming_status || raw.status || null,
          seed: finiteNumber(raw.seed),
          text: body,
          media: [],
          attachments: []
        });
      });
      continue;
    }
    if (/(?:media|images|videos|attachments|audio)/i.test(store.name)) {
      await readJsonLines(filePath, (raw, index) => {
        const mimeType = raw.mimeType || raw.mime_type || raw.type || raw.contentType || raw.content_type || null;
        media.push({
          mediaId: identifier(raw, [`${store.name}-${index}`]),
          conversationId: raw.conversationId || raw.conversation_id || raw.mindConversationId || raw.mind_conversation_id || raw.sessionId || raw.session_id || null,
          messageId: raw.messageId || raw.message_id || raw.mindMessageId || raw.mind_message_id || raw.turnId || raw.turn_id || null,
          fileName: raw.fileName || raw.filename || raw.name || null,
          kind: mediaKind(mimeType, store.name),
          mimeType,
          source: store.name,
          prompt: text(raw.prompt || raw.text || ''),
          model: firstString(raw.modelName, raw.model_name, raw.model, raw.modelId, raw.model_id),
          modelId: firstString(raw.modelId, raw.model_id),
          mediaDisposition: mediaDisposition(raw, store.name),
          createdAt: raw.createdAt || raw.created_at || raw.createdAtUnixTimestamp || raw.created_at_unix_timestamp || null,
          path: null,
          status: 'source-record'
        });
      });
    }
  }

  const opfsByIdentity = new Map();
  for (const item of manifest.opfs || []) {
    const identity = opfsMediaIdentity(item);
    if (identity) opfsByIdentity.set(identity, item);
  }
  const opfsSidecars = new Map();
  for (const item of manifest.opfs || []) {
    if (!internalMediaSidecar(item) || !item.archivedPath) continue;
    try {
      const metadata = JSON.parse(await readFile(await resolveAssetPath(path.resolve(captureDirectory, '../..'), path.join(captureDirectory, item.archivedPath)), 'utf8'));
      if (!/^[a-f0-9]{64}$/i.test(String(metadata.hash || ''))) continue;
      const original = String(item.path || '').replaceAll('\\', '/');
      opfsSidecars.set(path.posix.join(path.posix.dirname(original), String(metadata.hash)), metadata);
    } catch {
      // Sidecars are optional enrichment; the raw file remains preserved.
    }
  }
  const claimedOpfsPaths = new Set();
  for (const item of media) {
    if (item.path || !item.conversationId || !item.mediaId) continue;
    const opfs = opfsByIdentity.get(`${item.conversationId}:${item.mediaId}`);
    if (!opfs) continue;
    item.path = opfs.archivedPath;
    item.status = 'materialized';
    item.bytes = Number(opfs.size || 0);
    item.mimeType = item.mimeType || opfs.mimeType || null;
    item.kind = mediaKind(item.mimeType, item.source, opfs.kind);
    item.fileName = item.fileName || opfs.fileName || null;
    const sidecar = opfsSidecars.get(String(opfs.path || '').replaceAll('\\', '/'));
    if (sidecar) {
      item.fileName = sidecar.fileName || sidecar.name || item.fileName;
      item.mimeType = sidecar.mimeType || item.mimeType;
      item.kind = mediaKind(item.mimeType, sidecar.type, item.kind);
      item.createdAt = item.createdAt || sidecar.storedAt || null;
    }
    claimedOpfsPaths.add(opfs.archivedPath);
  }

  const messagesByKey = new Map(messageRecords.map((message) => [`${message.conversationId}:${message.id}`, message]));

  for (const item of manifest.opfs || []) {
    if (claimedOpfsPaths.has(item.archivedPath)) continue;
    if (internalMediaSidecar(item)) continue;
    const sidecar = opfsSidecars.get(String(item.path || '').replaceAll('\\', '/'));
    const candidate = opfsMessageCandidate(item.path);
    const linkedMessage = candidate ? messagesByKey.get(`${candidate.conversationId}:${candidate.messageId}`) : null;
    const mediaDisposition = linkedMessage
      ? candidate.attachment ? 'input' : linkedMessage.model || linkedMessage.sourceRole === 'assistant' ? 'output' : null
      : null;
    media.push({
      mediaId: `opfs:${item.path}`,
      conversationId: linkedMessage ? candidate.conversationId : null,
      messageId: linkedMessage ? candidate.messageId : null,
      fileName: sidecar?.fileName || sidecar?.name || item.fileName,
      kind: mediaKind(sidecar?.mimeType || item.mimeType, sidecar?.type || item.source, item.kind),
      mimeType: sidecar?.mimeType || item.mimeType || null,
      source: 'opfs',
      prompt: linkedMessage?.text || '',
      model: mediaDisposition === 'output' ? linkedMessage?.model || null : null,
      modelId: mediaDisposition === 'output' ? linkedMessage?.modelId || null : null,
      mediaDisposition,
      createdAt: sidecar?.storedAt || item.lastModified || null,
      path: item.archivedPath,
      status: 'materialized'
    });
  }

  for (const message of messageRecords) {
    let conversation = conversations.get(message.conversationId);
    if (!conversation) {
      conversation = message.studioTurn
        ? { id: message.conversationId, title: studioTitle(message.studioType), kind: 'studio', studioType: message.studioType, studioSession: true, createdAt: message.createdAt, updatedAt: message.updatedAt, messageCount: 0, mediaCount: 0, preview: '' }
        : { id: message.conversationId, title: 'Recovered conversation', kind: 'recovered', createdAt: null, updatedAt: null, messageCount: 0, mediaCount: 0, preview: '' };
      conversations.set(message.conversationId, conversation);
    }
    message.conversationTitle = conversation.title;
    conversation.messageCount += 1;
    if (!conversation.preview && message.text) conversation.preview = message.text.slice(0, 240);
  }
  for (const item of media) {
    const conversation = item.conversationId && conversations.get(String(item.conversationId));
    if (conversation) conversation.mediaCount += 1;
  }

  const indexesDirectory = path.join(captureDirectory, 'indexes');
  await mkdir(indexesDirectory, { recursive: true });
  await writeFile(path.join(indexesDirectory, 'conversations.json'), `${JSON.stringify([...conversations.values()])}\n`);
  const messageOutput = createWriteStream(path.join(indexesDirectory, 'messages.jsonl'), { encoding: 'utf8' });
  for (const message of messageRecords) messageOutput.write(`${JSON.stringify(message)}\n`);
  await new Promise((resolve, reject) => { messageOutput.end(resolve); messageOutput.once('error', reject); });
  await writeFile(path.join(indexesDirectory, 'media.json'), `${JSON.stringify({ totals: { total: media.length }, items: media })}\n`);
  return { conversations: conversations.size, messages: messageRecords.length, media: media.length };
}
