/**
 * Venice agentic ("Mind") transform utilities.
 *
 * Venice stores agentic chat sessions (URL: https://venice.ai/chat/agent/<id>)
 * in a separate RxDB database (venice-rx-db-encrypted) using an OpenAI
 * Responses-style schema. This module converts the decoded RxDB records
 * (mindConversations / mindMessages / mindMedia / mindAttachments / messageVideos)
 * into the same conversation / message / media record shapes the archive
 * pipeline already understands, so agentic sessions appear in the durable
 * archive and viewer alongside legacy chats.
 *
 * Pure module: no DOM, no IndexedDB. Exported for both browser (globalThis)
 * and Node (module.exports) so it can be unit tested.
 */
(function initializeAgenticTransform(globalScope) {
  'use strict';

  const AGENT_URL_BASE = 'https://venice.ai/chat/agent/';

  function cleanText(value) {
    if (value == null) {
      return '';
    }
    return String(value).replace(/\s+/g, ' ').trim();
  }

  function firstText(values) {
    for (const value of values || []) {
      const normalized = cleanText(value);
      if (normalized) {
        return normalized;
      }
    }
    return '';
  }

  function toFiniteNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return null;
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  // Pull readable text out of an OpenAI-style content array (message/reasoning items).
  function extractContentText(content) {
    if (typeof content === 'string') {
      return cleanText(content);
    }
    if (!Array.isArray(content)) {
      return '';
    }
    const parts = [];
    for (const part of content) {
      if (typeof part === 'string') {
        const value = part.trim();
        if (value) {
          parts.push(value);
        }
        continue;
      }
      if (!isPlainObject(part)) {
        continue;
      }
      const text = firstText([part.text, part.content, part.summary, part.value, part.delta]);
      if (text) {
        parts.push(text);
      }
    }
    return parts.join('\n\n').trim();
  }

  function safeJsonParse(value) {
    if (value == null) {
      return null;
    }
    if (typeof value !== 'string') {
      return value;
    }
    try {
      return JSON.parse(value);
    } catch (error) {
      return value;
    }
  }

  // Convert a single mindMessage's output_items[] into ordered viewer segments
  // plus a flattened visible-text string.
  function flattenOutputItems(outputItems) {
    const segments = [];
    const textChunks = [];
    const callNameById = new Map();

    if (!Array.isArray(outputItems)) {
      return { segments, text: '' };
    }

    outputItems.forEach((item) => {
      if (!isPlainObject(item)) {
        return;
      }

      const type = cleanText(item.type);

      if (type === 'message') {
        const text = extractContentText(item.content);
        if (text) {
          textChunks.push(text);
          segments.push({ type: 'text', text });
        }
        return;
      }

      if (type === 'reasoning') {
        const text = extractContentText(item.content) || firstText([item.summary]);
        if (text) {
          segments.push({ type: 'reasoning', text });
        }
        return;
      }

      if (type === 'webSearch') {
        const sources = Array.isArray(item.sources)
          ? item.sources.map((source) => ({
              url: firstText([source && source.url, source && source.link]) || null,
              title: firstText([source && source.title, source && source.name]) || null
            })).filter((source) => source.url || source.title)
          : [];
        segments.push({
          type: 'tool',
          tool: 'web_search',
          query: firstText([item.query]) || null,
          sources
        });
        return;
      }

      if (type === 'serverFunctionCall' || type === 'functionCall' || type === 'mcpCall') {
        const name = firstText([item.name]) || 'function';
        const callId = firstText([item.call_id, item.callId, item.id]);
        if (callId) {
          callNameById.set(callId, name);
        }
        segments.push({
          type: 'tool',
          tool: name,
          phase: 'call',
          arguments: safeJsonParse(item.arguments)
        });
        return;
      }

      if (type === 'serverFunctionCallOutput' || type === 'functionCallOutput' || type === 'mcpCallOutput') {
        const callId = firstText([item.call_id, item.callId]);
        const name = (callId && callNameById.get(callId)) || firstText([item.name]) || 'function';
        segments.push({
          type: 'tool',
          tool: name,
          phase: 'output',
          output: safeJsonParse(item.output)
        });
        return;
      }

      // Unknown item type — keep any text we can find so nothing is silently lost.
      const fallbackText = extractContentText(item.content);
      if (fallbackText) {
        segments.push({ type: 'text', text: fallbackText });
        textChunks.push(fallbackText);
      }
    });

    return { segments, text: textChunks.join('\n\n').trim() };
  }

  function resolveAgentModel(message) {
    return firstText([
      message && message.model,
      message && message.modelId,
      message && message.model_id,
      message && message.modelName,
      message && message.model_name
    ]) || null;
  }

  function normalizeAgentRole(value) {
    const role = cleanText(value).toLowerCase();
    if (role === 'user' || role === 'human') {
      return 'user';
    }
    if (role === 'assistant' || role === 'ai' || role === 'model') {
      return 'assistant';
    }
    if (role === 'system' || role === 'tool' || role === 'developer') {
      return role;
    }
    return role || 'assistant';
  }

  // mindConversations record -> conversation record (matching legacy shape).
  function buildAgenticConversation(record) {
    if (!isPlainObject(record)) {
      return null;
    }
    const id = firstText([record.id]);
    if (!id) {
      return null;
    }
    const title = firstText([record.name, record.title]) || 'Agentic session';
    return {
      id,
      name: title,
      title,
      createdAtUnixTimestamp: toFiniteNumber(record.createdAtUnixTimestamp),
      updatedAtUnixTimestamp: toFiniteNumber(record.updatedAtUnixTimestamp) || toFiniteNumber(record.createdAtUnixTimestamp),
      kind: 'agent',
      agentUrl: AGENT_URL_BASE + id
    };
  }

  // mindMessage record -> message record (matching legacy shape) with agentSegments.
  function buildAgenticMessage(record) {
    if (!isPlainObject(record)) {
      return null;
    }
    const id = firstText([record.id]);
    const conversationId = firstText([
      record.mind_conversation_id,
      record.mindConversationId,
      record.conversationId
    ]);
    if (!conversationId) {
      return null;
    }

    const { segments, text } = flattenOutputItems(record.output_items || record.outputItems);
    const fallbackText = text || firstText([record.text, record.content, record.input]);
    const role = normalizeAgentRole(record.role);
    const model = resolveAgentModel(record);

    return {
      id: id || `${conversationId}-${toFiniteNumber(record.created_at_unix_timestamp) || 0}`,
      conversationId,
      role,
      createdAtUnixTimestamp: toFiniteNumber(record.created_at_unix_timestamp) || toFiniteNumber(record.createdAtUnixTimestamp),
      updatedAtUnixTimestamp: toFiniteNumber(record.updated_at_unix_timestamp) || toFiniteNumber(record.updatedAtUnixTimestamp),
      content: fallbackText,
      modelName: model,
      agentSegments: segments,
      source: 'agentic'
    };
  }

  function buildAgenticConversations(mindConversations) {
    return (Array.isArray(mindConversations) ? mindConversations : [])
      .map(buildAgenticConversation)
      .filter(Boolean);
  }

  function buildAgenticMessages(mindMessages) {
    return (Array.isArray(mindMessages) ? mindMessages : [])
      .map(buildAgenticMessage)
      .filter(Boolean);
  }

  // Normalize a media-bearing RxDB record (messageVideos / mindMedia /
  // mindAttachments) into the messageImages-style record shape consumed by
  // extractMediaItems. Returns null when no usable media reference exists.
  function buildMediaRecord(record, { source, defaultKind } = {}) {
    if (!isPlainObject(record)) {
      return null;
    }

    const url = firstText([
      record.url,
      record.mediaUrl,
      record.media_url,
      record.downloadUrl,
      record.download_url,
      record.src,
      record.fileUrl,
      record.file_url
    ]);
    const hasInline = Boolean(
      record.contentBinary ||
      record.content_binary ||
      record.data ||
      record.base64 ||
      record.bytes
    );
    if (!url && !hasInline && !firstText([record.id])) {
      return null;
    }

    const conversationId = firstText([
      record.conversationId,
      record.mindConversationId,
      record.mind_conversation_id
    ]) || null;
    const messageId = firstText([
      record.messageId,
      record.mindMessageId,
      record.mind_message_id
    ]) || null;
    const mimeType = firstText([
      record.mimeType,
      record.mime_type,
      record.contentType,
      record.content_type
    ]) || null;

    const normalized = {
      ...record,
      id: firstText([record.id]) || null,
      conversationId,
      messageId,
      url: url || null,
      mimeType,
      fileName: firstText([record.filename, record.fileName, record.name]) || null,
      prompt: firstText([record.prompt, record.promptText, record.caption]) || null,
      createdAtUnixTimestamp: toFiniteNumber(record.createdAtUnixTimestamp) || toFiniteNumber(record.created_at_unix_timestamp),
      __mediaSource: source || 'rxdb',
      __mediaDefaultKind: defaultKind || null
    };
    return normalized;
  }

  function buildAgenticMediaRecords(rxData) {
    const data = isPlainObject(rxData) ? rxData : {};
    const out = [];
    const push = (list, options) => {
      (Array.isArray(list) ? list : []).forEach((record) => {
        const normalized = buildMediaRecord(record, options);
        if (normalized) {
          out.push(normalized);
        }
      });
    };
    push(data.messageVideos, { source: 'messageVideos', defaultKind: 'video' });
    push(data.rxMessageImages, { source: 'rxMessageImages', defaultKind: 'image' });
    push(data.messageAudioAttachments, { source: 'messageAudioAttachments', defaultKind: 'audio' });
    push(data.messageFileAttachments, { source: 'messageFileAttachments', defaultKind: 'file' });
    push(data.messageImageAttachments, { source: 'messageImageAttachments', defaultKind: 'image' });
    push(data.messageVideoAttachments, { source: 'messageVideoAttachments', defaultKind: 'video' });
    push(data.mindMedia, { source: 'mindMedia', defaultKind: null });
    push(data.mindAttachments, { source: 'mindAttachments', defaultKind: 'file' });
    return out;
  }

  const api = {
    AGENT_URL_BASE,
    flattenOutputItems,
    buildAgenticConversation,
    buildAgenticMessage,
    buildAgenticConversations,
    buildAgenticMessages,
    buildMediaRecord,
    buildAgenticMediaRecords
  };

  if (globalScope) {
    globalScope.VeniceAgenticTransform = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
