import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  if (value == null || typeof value !== 'object') return value === undefined ? null : value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonicalize(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

test('verify-archive validates source stores and content-addressed media', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'venice-archive-verifier-'));
  await mkdir(path.join(root, 'stores'));
  await mkdir(path.join(root, 'indexes'));
  await mkdir(path.join(root, 'conversations'));
  await mkdir(path.join(root, 'viewer'));
  await mkdir(path.join(root, 'exports'));
  await mkdir(path.join(root, 'logs'));

  const storeData = '[{"id":"c1"},{"id":"c2","text":"comma, inside string"}]';
  const storePath = 'stores/store--conversations--test.json';
  const mediaData = Buffer.from('archive media bytes');
  const mediaHash = sha256(mediaData);
  const mediaPath = `media/sha256/${mediaHash.slice(0, 2)}/${mediaHash}.bin`;
  await writeFile(path.join(root, storePath), storeData);
  await mkdir(path.dirname(path.join(root, mediaPath)), { recursive: true });
  await writeFile(path.join(root, mediaPath), mediaData);

  const normalizedMessages = [
    {
      id: 'm1', role: 'user', model: null, createdAt: '2026-07-10T10:00:00.000Z', updatedAt: '2026-07-10T10:00:00.000Z',
      text: 'hello', media: [], attachments: [], source: { store: 'messages', recordHash: sha256('{}') }
    },
    {
      id: 'm2', role: 'assistant', model: 'test-model', createdAt: '2026-07-10T10:00:01.000Z', updatedAt: '2026-07-10T10:00:01.000Z',
      text: 'world', media: [], attachments: [], source: { store: 'messages', recordHash: sha256('{"id":"m2"}') }
    }
  ];
  const conversation = {
    schemaVersion: '1.0.0',
    id: 'c1',
    title: 'Test conversation',
    kind: 'chat',
    agentUrl: null,
    createdAt: '2026-07-10T10:00:00.000Z',
    updatedAt: '2026-07-10T10:00:01.000Z',
    messageCount: normalizedMessages.length,
    mediaCount: 0,
    source: { store: 'conversations', recordHash: sha256('{"id":"c1"}') },
    messages: normalizedMessages
  };
  const conversationHash = sha256(stableStringify({
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messageCount,
    mediaCount: conversation.mediaCount,
    messages: conversation.messages
  }));
  const conversationJsonPath = 'conversations/c1--test-conversation.json';
  const conversationMarkdownPath = 'conversations/c1--test-conversation.md';
  await writeFile(path.join(root, conversationJsonPath), JSON.stringify(conversation));
  await writeFile(path.join(root, conversationMarkdownPath), '# Test conversation\n');

  const conversationIndex = [{
    id: 'c1', title: conversation.title, kind: 'chat', agentUrl: null,
    jsonPath: conversationJsonPath, markdownPath: conversationMarkdownPath,
    createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
    messageCount: 2, mediaCount: 0, recordHash: conversationHash, preview: 'hello'
  }];
  const messageIndex = normalizedMessages.map((message) => ({
    conversationId: 'c1',
    conversationTitle: conversation.title,
    conversationKind: 'chat',
    id: message.id,
    role: message.role,
    model: message.model,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    text: message.text,
    media: message.media,
    attachments: message.attachments
  }));
  await writeFile(path.join(root, 'indexes/conversations.json'), JSON.stringify(conversationIndex));
  await writeFile(path.join(root, 'indexes/messages.jsonl'), `${messageIndex.map((record) => JSON.stringify(record)).join('\n')}\n`);

  const mediaIndex = {
    totals: { archivedFiles: 1 },
    items: [{ path: mediaPath, sha256: mediaHash, bytes: mediaData.length, status: 'materialized' }]
  };
  await writeFile(path.join(root, 'indexes/media.json'), JSON.stringify(mediaIndex));
  await writeFile(path.join(root, 'indexes/unresolved-media.json'), '[]');
  await writeFile(path.join(root, 'viewer/index.html'), '<!doctype html><title>Archive</title>');
  await writeFile(path.join(root, 'viewer/viewer-data.json'), JSON.stringify({ conversations: conversationIndex, messages: messageIndex }));
  const exportId = 'export-2026-07-10T10-00-02';
  await writeFile(path.join(root, `exports/${exportId}.manifest.json`), JSON.stringify({
    schemaVersion: '1.0.0', exportId, status: 'committed', media: { unresolved: 0, failed: 0 }
  }));
  await writeFile(path.join(root, `logs/${exportId}.log.json`), JSON.stringify({ exportId, warnings: [] }));
  await writeFile(path.join(root, 'venice-archive.manifest.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    archiveId: 'test-archive',
    createdAt: '2026-07-10T10:00:00.000Z',
    updatedAt: '2026-07-10T10:00:02.000Z',
    latestExportId: exportId,
    verification: { status: 'verified' },
    totals: { sourceStores: 1, sourceRecords: 2, mediaFiles: 1, unresolvedMedia: 0, conversations: 1, messages: 2 },
    indexes: {
      conversations: 'indexes/conversations.json',
      messages: 'indexes/messages.jsonl',
      media: 'indexes/media.json',
      unresolvedMedia: 'indexes/unresolved-media.json'
    },
    records: {
      conversations: {
        c1: {
          status: 'active', tombstoned: false, recordHash: conversationHash,
          jsonPath: conversationJsonPath, markdownPath: conversationMarkdownPath
        }
      },
      sourceStores: {
        conversations: {
          status: 'active',
          path: storePath,
          bytes: Buffer.byteLength(storeData),
          count: 2,
          sha256: sha256(storeData)
        }
      }
    }
  }));

  const result = await execFileAsync(process.execPath, ['scripts/verify-archive.mjs', root], {
    cwd: process.cwd()
  });
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'verified');
  assert.equal(summary.sourceRecords, 2);
  assert.equal(summary.mediaFiles, 1);
  assert.equal(summary.conversations, 1);
  assert.equal(summary.messages, 2);

  await writeFile(path.join(root, conversationJsonPath), JSON.stringify({ ...conversation, title: 'corrupted title' }));
  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/verify-archive.mjs', root], { cwd: process.cwd() }),
    (error) => {
      assert.match(error.stderr, /Conversation c1 record hash mismatch/);
      return true;
    }
  );
  await writeFile(path.join(root, conversationJsonPath), JSON.stringify(conversation));

  await writeFile(path.join(root, mediaPath), 'corrupted');
  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/verify-archive.mjs', root], { cwd: process.cwd() }),
    (error) => {
      assert.match(error.stderr, /archive verification failed/);
      return true;
    }
  );
});
