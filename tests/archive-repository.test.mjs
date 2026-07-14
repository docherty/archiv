import assert from 'node:assert/strict';
import test from 'node:test';

await import('../extension/lib/archive-repository.js');

const archiveRepository = globalThis.VeniceArchiveRepository;

test('resolveConversationTitle prefers Venice name before title', () => {
  const title = archiveRepository.resolveConversationTitle({
    name: 'Readable Venice name',
    title: 'Stale title'
  }, []);

  assert.equal(title, 'Readable Venice name');
});

test('resolveConversationTitle falls back to first readable message', () => {
  const title = archiveRepository.resolveConversationTitle({}, [
    { role: 'user', content: [{ type: 'text', text: 'Can you help with this letter?' }] }
  ]);

  assert.equal(title, 'Can you help with this letter?');
});

test('conversation artifact paths include stable id and safe slug', () => {
  const paths = archiveRepository.buildConversationArtifactPaths('1g8W9AY', 'My mum has received the attached letter.');

  assert.equal(paths.json, 'conversations/1g8W9AY--my-mum-has-received-the-attached-letter.json');
  assert.equal(paths.markdown, 'conversations/1g8W9AY--my-mum-has-received-the-attached-letter.md');
});

test('stableStringify produces canonical object key order', () => {
  const left = archiveRepository.stableStringify({ b: 2, a: { d: 4, c: 3 } });
  const right = archiveRepository.stableStringify({ a: { c: 3, d: 4 }, b: 2 });

  assert.equal(left, right);
  assert.equal(left, '{"a":{"c":3,"d":4},"b":2}');
});

test('buildMediaContentPath shards SHA-256 media files', () => {
  const hash = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
  const path = archiveRepository.buildMediaContentPath(hash, 'jpg');

  assert.equal(path, `media/sha256/ab/${hash}.jpg`);
});

test('validateRootManifest accepts newly built empty manifests', () => {
  const manifest = archiveRepository.buildEmptyRootManifest({
    archiveId: 'archive-test',
    now: new Date('2026-05-18T10:47:15.000Z')
  });

  const result = archiveRepository.validateRootManifest(manifest);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateRootManifest reports schema and index errors', () => {
  const result = archiveRepository.validateRootManifest({
    schemaVersion: '0.0.1',
    archiveId: '',
    createdAt: '2026-05-18T10:47:15.000Z',
    updatedAt: '2026-05-18T10:47:15.000Z',
    indexes: { conversations: 'wrong.json' }
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Unsupported root manifest schemaVersion/);
  assert.match(result.errors.join('\n'), /archiveId is required/);
  assert.match(result.errors.join('\n'), /indexes\.conversations/);
});

test('getRootManifestCompatibility detects migration-required schemas', () => {
  const manifest = archiveRepository.buildEmptyRootManifest({
    archiveId: 'archive-test',
    now: new Date('2026-05-18T10:47:15.000Z')
  });

  const result = archiveRepository.getRootManifestCompatibility({
    ...manifest,
    schemaVersion: '0.9.0'
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'migration-required');
  assert.equal(result.canWrite, false);
  assert.match(result.errors.join('\n'), /Migration is required/);
});

test('getRootManifestCompatibility rejects newer schemas', () => {
  const manifest = archiveRepository.buildEmptyRootManifest({
    archiveId: 'archive-test',
    now: new Date('2026-05-18T10:47:15.000Z')
  });

  const result = archiveRepository.getRootManifestCompatibility({
    ...manifest,
    schemaVersion: '2.0.0'
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'unsupported-newer');
  assert.equal(result.canRead, false);
  assert.match(result.errors.join('\n'), /Update the extension/);
});

test('classifyMediaCandidate accepts base64 attachment payload metadata', () => {
  const result = archiveRepository.classifyMediaCandidate({
    fileName: 'IMG_1808.JPG',
    mimeType: 'image/jpeg',
    hasEmbeddedResult: true
  });

  assert.equal(result.exportable, true);
  assert.equal(result.status, 'candidate');
  assert.equal(result.kind, 'image');
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.extension, 'jpg');
});

test('classifyMediaCandidate recognizes video and audio media URLs', () => {
  const video = archiveRepository.classifyMediaCandidate({ url: 'https://example.test/rendered-video.webm?download=1' });
  const audio = archiveRepository.classifyMediaCandidate({ sourceUrl: 'blob:https://venice.ai/audio-output', type: 'audio' });

  assert.equal(video.exportable, true);
  assert.equal(video.kind, 'video');
  assert.equal(video.mimeType, 'video/webm');
  assert.equal(video.extension, 'webm');
  assert.equal(audio.exportable, true);
  assert.equal(audio.kind, 'audio');
  assert.equal(audio.mimeType, 'audio/mpeg');
});

test('classifyMediaCandidate marks metadata-only placeholders unresolved', () => {
  const result = archiveRepository.classifyMediaCandidate({
    id: 'studio-placeholder',
    type: 'image',
    prompt: 'A missing studio asset'
  });

  assert.equal(result.exportable, false);
  assert.equal(result.status, 'unresolved');
  assert.equal(result.kind, 'image');
  assert.match(result.reason, /No bytes/);
});

test('resolveConversationArtifactPaths preserves previous safe filenames', () => {
  const paths = archiveRepository.resolveConversationArtifactPaths('abc123', 'New title after rename', {
    jsonPath: 'conversations/abc123--original-title.json',
    markdownPath: 'conversations/abc123--original-title.md'
  });

  assert.deepEqual(paths, {
    json: 'conversations/abc123--original-title.json',
    markdown: 'conversations/abc123--original-title.md'
  });
});

test('buildConversationManifestRecords tombstones missing previous conversations', () => {
  const records = archiveRepository.buildConversationManifestRecords([
    {
      id: 'current',
      title: 'Current conversation',
      recordHash: 'hash-current',
      jsonPath: 'conversations/current.json',
      markdownPath: 'conversations/current.md',
      updatedAt: '2026-05-18T10:47:15.000Z'
    }
  ], {
    current: {
      status: 'active',
      jsonPath: 'conversations/current.json',
      markdownPath: 'conversations/current.md'
    },
    missing: {
      status: 'active',
      jsonPath: 'conversations/missing.json',
      markdownPath: 'conversations/missing.md'
    }
  }, '2026-05-18T11:00:00.000Z');

  assert.equal(records.current.status, 'active');
  assert.equal(records.current.tombstoned, false);
  assert.equal(records.missing.status, 'tombstoned');
  assert.equal(records.missing.tombstoned, true);
  assert.equal(records.missing.tombstonedAt, '2026-05-18T11:00:00.000Z');
});

test('getTombstonedConversationIds reports records absent from current export', () => {
  const ids = archiveRepository.getTombstonedConversationIds({ a: {}, b: {}, c: {} }, ['a', 'c']);

  assert.deepEqual(ids, ['b']);
});
