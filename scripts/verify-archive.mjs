#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const REPOSITORY_SCHEMA_VERSION = '1.0.0';
const EXPECTED_INDEXES = Object.freeze({
  conversations: 'indexes/conversations.json',
  messages: 'indexes/messages.jsonl',
  media: 'indexes/media.json',
  unresolvedMedia: 'indexes/unresolved-media.json'
});

const root = path.resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('Usage: npm run verify:archive -- /absolute/path/to/venice-archive');
  process.exitCode = 2;
} else {
  await verifyArchive(root);
}

async function verifyArchive(archiveRoot) {
  const errors = [];
  const warnings = [];
  const rootManifest = await readJson(path.join(archiveRoot, 'venice-archive.manifest.json'), errors);
  if (!rootManifest) {
    report(errors, warnings, {});
    return;
  }

  if (rootManifest.verification?.status !== 'verified') {
    errors.push(`Root verification status is ${rootManifest.verification?.status || 'missing'}, not verified.`);
  }

  validateRootManifest(rootManifest, errors);

  const sourceStores = rootManifest.records?.sourceStores || {};
  let verifiedSourceStores = 0;
  let verifiedSourceRecords = 0;
  for (const [name, record] of Object.entries(sourceStores)) {
    if (record?.status !== 'active') continue;
    const filePath = resolveInside(archiveRoot, record.path, errors, `source store ${name}`);
    if (!filePath) continue;
    const fileStat = await safeStat(filePath, errors, `source store ${name}`);
    if (!fileStat) continue;
    if (Number(record.bytes) !== fileStat.size) {
      errors.push(`Source store ${name} byte mismatch: manifest ${record.bytes}, file ${fileStat.size}.`);
    }
    const digest = await hashFile(filePath);
    if (record.sha256 && digest !== record.sha256) {
      errors.push(`Source store ${name} SHA-256 mismatch.`);
    }
    const count = await countTopLevelJsonArrayItems(filePath);
    if (Number(record.count) !== count) {
      errors.push(`Source store ${name} count mismatch: manifest ${record.count}, file ${count}.`);
    }
    verifiedSourceStores += 1;
    verifiedSourceRecords += count;
  }

  const conversationVerification = await verifyConversationArtifacts(archiveRoot, rootManifest, errors);
  const mediaIndex = await readJson(path.join(archiveRoot, EXPECTED_INDEXES.media), errors);
  const unresolved = await readJson(path.join(archiveRoot, EXPECTED_INDEXES.unresolvedMedia), errors);
  if (Array.isArray(unresolved) && unresolved.length) {
    errors.push(`${unresolved.length} unresolved or failed media record(s) remain.`);
  }
  if (Array.isArray(unresolved) && Number(rootManifest.totals?.unresolvedMedia) !== unresolved.length) {
    errors.push(`Root unresolved-media total mismatch: manifest ${rootManifest.totals?.unresolvedMedia}, index ${unresolved.length}.`);
  }

  const mediaItems = Array.isArray(mediaIndex?.items) ? mediaIndex.items : [];
  const uniqueMedia = new Map();
  mediaItems.forEach((item) => {
    if (item?.path) uniqueMedia.set(item.path, item);
  });
  let verifiedMediaFiles = 0;
  for (const [relativePath, item] of uniqueMedia.entries()) {
    const filePath = resolveInside(archiveRoot, relativePath, errors, `media ${relativePath}`);
    if (!filePath) continue;
    if (item.sha256) {
      const normalizedPath = String(relativePath).replace(/\\/g, '/');
      const expectedPrefix = `media/sha256/${item.sha256.slice(0, 2).toLowerCase()}/${item.sha256.toLowerCase()}.`;
      if (!normalizedPath.toLowerCase().startsWith(expectedPrefix)) {
        errors.push(`Media path is not content-addressed by its SHA-256: ${relativePath}.`);
      }
    }
    const fileStat = await safeStat(filePath, errors, `media ${relativePath}`);
    if (!fileStat) continue;
    if (Number.isFinite(Number(item.bytes)) && Number(item.bytes) !== fileStat.size) {
      errors.push(`Media byte mismatch for ${relativePath}: index ${item.bytes}, file ${fileStat.size}.`);
    }
    if (item.sha256) {
      const digest = await hashFile(filePath);
      if (digest !== item.sha256) {
        errors.push(`Media SHA-256 mismatch for ${relativePath}.`);
      }
    } else {
      warnings.push(`Media ${relativePath} has no SHA-256 in the index.`);
    }
    verifiedMediaFiles += 1;
  }

  if (Number(rootManifest.totals?.sourceStores) !== verifiedSourceStores) {
    errors.push(`Root source-store total mismatch: manifest ${rootManifest.totals?.sourceStores}, verified ${verifiedSourceStores}.`);
  }
  if (Number(rootManifest.totals?.sourceRecords) !== verifiedSourceRecords) {
    errors.push(`Root source-record total mismatch: manifest ${rootManifest.totals?.sourceRecords}, verified ${verifiedSourceRecords}.`);
  }
  if (Number(rootManifest.totals?.mediaFiles) !== verifiedMediaFiles) {
    errors.push(`Root media-file total mismatch: manifest ${rootManifest.totals?.mediaFiles}, verified ${verifiedMediaFiles}.`);
  }

  await verifyViewerAndLatestExport(archiveRoot, rootManifest, errors);

  report(errors, warnings, {
    archiveId: rootManifest.archiveId,
    sourceStores: verifiedSourceStores,
    sourceRecords: verifiedSourceRecords,
    mediaFiles: verifiedMediaFiles,
    conversations: conversationVerification.conversations,
    messages: conversationVerification.messages
  });
}

function validateRootManifest(manifest, errors) {
  if (manifest.schemaVersion !== REPOSITORY_SCHEMA_VERSION) {
    errors.push(`Unsupported root schemaVersion: ${manifest.schemaVersion || 'missing'} (expected ${REPOSITORY_SCHEMA_VERSION}).`);
  }
  if (!manifest.archiveId || !manifest.createdAt || !manifest.updatedAt) {
    errors.push('Root manifest must include archiveId, createdAt, and updatedAt.');
  }
  for (const [key, expectedPath] of Object.entries(EXPECTED_INDEXES)) {
    if (manifest.indexes?.[key] !== expectedPath) {
      errors.push(`Root indexes.${key} must be ${expectedPath}.`);
    }
  }
}

async function verifyConversationArtifacts(archiveRoot, rootManifest, errors) {
  const records = rootManifest.records?.conversations || {};
  const activeRecords = Object.entries(records).filter(([, record]) => record?.status === 'active' && !record?.tombstoned);
  const conversationIndex = await readJson(path.join(archiveRoot, EXPECTED_INDEXES.conversations), errors);
  const indexItems = Array.isArray(conversationIndex) ? conversationIndex : [];
  if (conversationIndex && !Array.isArray(conversationIndex)) {
    errors.push('Conversation index must be a JSON array.');
  }

  const indexById = new Map();
  for (const item of indexItems) {
    const id = String(item?.id || '');
    if (!id) {
      errors.push('Conversation index contains an entry without an id.');
      continue;
    }
    if (indexById.has(id)) {
      errors.push(`Conversation index contains duplicate id ${id}.`);
    }
    indexById.set(id, item);
  }

  const derivedMessages = [];
  let verifiedConversations = 0;
  let verifiedMessages = 0;
  for (const [id, record] of activeRecords) {
    const jsonPath = resolveInside(archiveRoot, record.jsonPath, errors, `conversation ${id} JSON`);
    const markdownPath = resolveInside(archiveRoot, record.markdownPath, errors, `conversation ${id} Markdown`);
    if (markdownPath) await safeStat(markdownPath, errors, `conversation ${id} Markdown`);
    if (!jsonPath || !(await safeStat(jsonPath, errors, `conversation ${id} JSON`))) continue;
    const conversation = await readJson(jsonPath, errors);
    if (!conversation) continue;

    if (String(conversation.id || '') !== id) {
      errors.push(`Conversation ${id} JSON id does not match its manifest key.`);
    }
    if (conversation.schemaVersion !== REPOSITORY_SCHEMA_VERSION) {
      errors.push(`Conversation ${id} has unsupported schemaVersion ${conversation.schemaVersion || 'missing'}.`);
    }
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    if (!Array.isArray(conversation.messages)) {
      errors.push(`Conversation ${id} messages must be an array.`);
    }
    const mediaCount = messages.reduce((total, message) => total + (Array.isArray(message?.media) ? message.media.length : 0), 0);
    if (Number(conversation.messageCount) !== messages.length) {
      errors.push(`Conversation ${id} messageCount mismatch: JSON ${conversation.messageCount}, actual ${messages.length}.`);
    }
    if (Number(conversation.mediaCount) !== mediaCount) {
      errors.push(`Conversation ${id} mediaCount mismatch: JSON ${conversation.mediaCount}, actual ${mediaCount}.`);
    }

    const recordHash = hashText(stableStringify({
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messageCount: conversation.messageCount,
      mediaCount: conversation.mediaCount,
      messages
    }));
    if (!record.recordHash || recordHash !== record.recordHash) {
      errors.push(`Conversation ${id} record hash mismatch.`);
    }

    const indexRecord = indexById.get(id);
    if (!indexRecord) {
      errors.push(`Conversation ${id} is missing from indexes/conversations.json.`);
    } else {
      if (indexRecord.recordHash !== record.recordHash) errors.push(`Conversation ${id} index hash does not match the root manifest.`);
      if (indexRecord.jsonPath !== record.jsonPath || indexRecord.markdownPath !== record.markdownPath) {
        errors.push(`Conversation ${id} index paths do not match the root manifest.`);
      }
    }

    const conversationKind = conversation.kind === 'agent' ? 'agent' : (conversation.kind === 'support' ? 'support' : 'chat');
    for (const message of messages) {
      derivedMessages.push({
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        conversationKind,
        id: message.id,
        role: message.role,
        model: message.model || null,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
        text: message.text,
        media: message.media,
        attachments: message.attachments,
        ...(Array.isArray(message.agentSegments) && message.agentSegments.length
          ? { agentSegments: message.agentSegments }
          : {})
      });
    }
    verifiedConversations += 1;
    verifiedMessages += messages.length;
  }

  if (activeRecords.length !== indexItems.length) {
    errors.push(`Conversation index count mismatch: ${indexItems.length} indexed, ${activeRecords.length} active manifest records.`);
  }
  if (Number(rootManifest.totals?.conversations) !== verifiedConversations) {
    errors.push(`Root conversation total mismatch: manifest ${rootManifest.totals?.conversations}, verified ${verifiedConversations}.`);
  }
  if (Number(rootManifest.totals?.messages) !== verifiedMessages) {
    errors.push(`Root message total mismatch: manifest ${rootManifest.totals?.messages}, verified ${verifiedMessages}.`);
  }

  const messageIndexPath = path.join(archiveRoot, EXPECTED_INDEXES.messages);
  const indexedMessages = await readJsonLines(messageIndexPath, errors);
  if (indexedMessages && !equalRecordMultisets(indexedMessages, derivedMessages)) {
    errors.push('indexes/messages.jsonl does not match the normalized conversation JSON files.');
  }

  return { conversations: verifiedConversations, messages: verifiedMessages };
}

async function verifyViewerAndLatestExport(archiveRoot, rootManifest, errors) {
  const viewerHtml = resolveInside(archiveRoot, 'viewer/index.html', errors, 'archive viewer');
  const viewerDataPath = resolveInside(archiveRoot, 'viewer/viewer-data.json', errors, 'viewer data');
  if (viewerHtml) {
    const file = await safeStat(viewerHtml, errors, 'archive viewer');
    if (file && file.size === 0) errors.push('Archive viewer is empty.');
  }
  if (viewerDataPath) {
    const viewerData = await readJson(viewerDataPath, errors);
    if (viewerData) {
      if (!Array.isArray(viewerData.conversations) || viewerData.conversations.length !== Number(rootManifest.totals?.conversations)) {
        errors.push('viewer/viewer-data.json conversation count does not match the root manifest.');
      }
      if (!Array.isArray(viewerData.messages) || viewerData.messages.length !== Number(rootManifest.totals?.messages)) {
        errors.push('viewer/viewer-data.json message count does not match the root manifest.');
      }
    }
  }

  const exportId = String(rootManifest.latestExportId || '');
  if (!exportId || exportId.includes('/') || exportId.includes('\\') || exportId.includes('..')) {
    errors.push('Root latestExportId is missing or unsafe.');
    return;
  }
  const exportManifest = await readJson(path.join(archiveRoot, `exports/${exportId}.manifest.json`), errors);
  if (exportManifest) {
    if (exportManifest.exportId !== exportId || exportManifest.status !== 'committed') {
      errors.push(`Latest export manifest ${exportId} is not a matching committed export.`);
    }
    if (Number(exportManifest.media?.unresolved || 0) || Number(exportManifest.media?.failed || 0)) {
      errors.push(`Latest export ${exportId} reports unresolved or failed media.`);
    }
  }
  const logPath = resolveInside(archiveRoot, `logs/${exportId}.log.json`, errors, `export log ${exportId}`);
  if (logPath) await safeStat(logPath, errors, `export log ${exportId}`);
}

function resolveInside(rootPath, relativePath, errors, label) {
  if (!relativePath || path.isAbsolute(relativePath)) {
    errors.push(`Unsafe or missing path for ${label}.`);
    return null;
  }
  const resolved = path.resolve(rootPath, relativePath);
  const prefix = `${rootPath}${path.sep}`;
  if (resolved !== rootPath && !resolved.startsWith(prefix)) {
    errors.push(`Path escapes archive root for ${label}: ${relativePath}.`);
    return null;
  }
  return resolved;
}

async function readJson(filePath, errors) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    errors.push(`Could not read ${filePath}: ${error.message}`);
    return null;
  }
}

async function readJsonLines(filePath, errors) {
  try {
    const text = await readFile(filePath, 'utf8');
    const records = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch (error) {
        errors.push(`Could not parse ${filePath} line ${index + 1}: ${error.message}`);
        return null;
      }
    }
    return records;
  } catch (error) {
    errors.push(`Could not read ${filePath}: ${error.message}`);
    return null;
  }
}

function canonicalize(value) {
  if (value == null || typeof value !== 'object') {
    return value === undefined ? null : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalize(value[key]);
  }
  return result;
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}

function equalRecordMultisets(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const counts = new Map();
  for (const record of left) {
    const key = stableStringify(record);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const record of right) {
    const key = stableStringify(record);
    const remaining = counts.get(key) || 0;
    if (!remaining) return false;
    if (remaining === 1) counts.delete(key);
    else counts.set(key, remaining - 1);
  }
  return counts.size === 0;
}

async function safeStat(filePath, errors, label) {
  try {
    const value = await stat(filePath);
    if (!value.isFile()) {
      errors.push(`${label} is not a file: ${filePath}.`);
      return null;
    }
    return value;
  } catch (error) {
    errors.push(`Missing ${label}: ${filePath} (${error.message}).`);
    return null;
  }
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function countTopLevelJsonArrayItems(filePath) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    let containerDepth = 0;
    let started = false;
    let hasItem = false;
    let commas = 0;
    let inString = false;
    let escaped = false;
    let complete = false;

    stream.on('data', (chunk) => {
      for (const character of chunk) {
        if (complete) break;
        if (inString) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') {
          inString = true;
          if (containerDepth === 1) hasItem = true;
          continue;
        }
        if (!started) {
          if (/\s/.test(character)) continue;
          if (character !== '[') {
            reject(new Error(`${filePath} is not a top-level JSON array.`));
            stream.destroy();
            return;
          }
          started = true;
          containerDepth = 1;
          continue;
        }
        if (character === '[' || character === '{') {
          if (containerDepth === 1) hasItem = true;
          containerDepth += 1;
          continue;
        }
        if (character === ']' || character === '}') {
          if (character === ']' && containerDepth === 1) {
            complete = true;
            continue;
          }
          containerDepth -= 1;
          continue;
        }
        if (containerDepth === 1 && character === ',') {
          commas += 1;
          continue;
        }
        if (containerDepth === 1 && !/\s/.test(character)) hasItem = true;
      }
    });
    stream.on('error', reject);
    stream.on('end', () => {
      if (!started || !complete || inString || containerDepth !== 1) {
        reject(new Error(`${filePath} is not a complete top-level JSON array.`));
        return;
      }
      resolve(hasItem ? commas + 1 : 0);
    });
  });
}

function report(errors, warnings, summary) {
  warnings.forEach((warning) => console.warn(`warning: ${warning}`));
  if (errors.length) {
    errors.forEach((error) => console.error(`error: ${error}`));
    console.error(`archive verification failed with ${errors.length} error(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ status: 'verified', ...summary }, null, 2));
}
