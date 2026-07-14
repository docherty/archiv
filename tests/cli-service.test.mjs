import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSearchIndex, searchArchive } from '../cli/lib/archive.mjs';
import { chooseProfile } from '../cli/lib/browsers.mjs';
import { ArchiveCatalog } from '../cli/lib/catalog.mjs';
import { planIncrementalExtraction, planInventoryReads } from '../cli/lib/extract.mjs';
import { compareConsistencyInventories, createRawSnapshot, inventoryConsistencyFiles, reconcileConsistencySnapshot, saveSourceCheckpoint, serializeConsistencyInventory, sourceCheckpointStatus, verifyRawSnapshot } from '../cli/lib/snapshot.mjs';
import { normalizeCapture } from '../cli/lib/normalize-capture.mjs';
import { startArchiveService } from '../cli/lib/service.mjs';
import { verifyCapture } from '../cli/lib/verify-capture.mjs';

function getStatus(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, { headers }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
  });
}

test('chooseProfile selects Venice evidence and honors explicit names', () => {
  const profiles = [
    { name: 'Home', directoryName: 'Profile 2', hasVeniceData: false },
    { name: 'Work', directoryName: 'Default', hasVeniceData: true }
  ];
  assert.equal(chooseProfile(profiles).name, 'Work');
  assert.equal(chooseProfile(profiles, 'Profile 2').name, 'Home');
  assert.equal(chooseProfile(profiles, 'work').directoryName, 'Default');
});

test('raw snapshot copies the selected browser state and verifies hashes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'venice-cli-snapshot-'));
  const browserRoot = path.join(root, 'browser');
  const profileRoot = path.join(browserRoot, 'Default');
  await mkdir(path.join(profileRoot, 'IndexedDB/https_venice.ai_0.indexeddb.leveldb'), { recursive: true });
  await writeFile(path.join(browserRoot, 'Local State'), '{"profile":{"last_used":"Default"}}');
  await writeFile(path.join(profileRoot, 'Preferences'), '{"profile":{"name":"Work"}}');
  await writeFile(path.join(profileRoot, 'IndexedDB/https_venice.ai_0.indexeddb.leveldb', '000001.ldb'), 'venice-test-data');
  const result = await createRawSnapshot({
    archiveDirectory: path.join(root, 'archive'),
    browser: { id: 'fixture', name: 'Fixture Browser', executable: '/no/such/browser', userDataDirectory: browserRoot },
    profile: { directoryName: 'Default', name: 'Work', path: profileRoot }
  });
  assert.equal(result.manifest.files.length, 3);
  assert.ok(result.manifest.totalBytes > 0);
  const verification = await verifyRawSnapshot(result.snapshotRoot);
  assert.equal(verification.ok, true);
  assert.equal(verification.checked, 3);
  assert.equal(verification.manifest.sourceConsistency.mode, 'browser-closed');
  const repeated = await createRawSnapshot({
    archiveDirectory: path.join(root, 'archive'),
    browser: { id: 'fixture', name: 'Fixture Browser', executable: '/no/such/browser', userDataDirectory: browserRoot },
    profile: { directoryName: 'Default', name: 'Work', path: profileRoot }
  });
  assert.equal(repeated.manifest.integrity.reusedHashes, 1);
  assert.equal(repeated.manifest.integrity.hashedFiles, 2);
  assert.equal((await verifyRawSnapshot(repeated.snapshotRoot)).ok, true);
});

test('live snapshot consistency comparison detects creates, changes, and removals', () => {
  const before = new Map([['a', '1:10'], ['b', '2:20']]);
  const after = new Map([['a', '1:11'], ['c', '3:30']]);
  assert.deepEqual(compareConsistencyInventories(before, after), [
    { path: 'a', change: 'modified' },
    { path: 'b', change: 'removed' },
    { path: 'c', change: 'created' }
  ]);
});

test('snapshot reconciliation turns browser journal churn into a verified quiet-window copy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'venice-cli-live-reconcile-'));
  const browserRoot = path.join(root, 'browser');
  const profileRoot = path.join(browserRoot, 'Default');
  const databaseRoot = path.join(profileRoot, 'IndexedDB/https_venice.ai_0.indexeddb.leveldb');
  const journalPath = path.join(databaseRoot, '000001.log');
  await mkdir(databaseRoot, { recursive: true });
  await writeFile(path.join(browserRoot, 'Local State'), '{}');
  await writeFile(path.join(profileRoot, 'Preferences'), '{}');
  await writeFile(journalPath, 'first journal state');
  let changedDuringCopy = false;
  const result = await createRawSnapshot({
    archiveDirectory: path.join(root, 'archive'),
    browser: { id: 'fixture', name: 'Fixture Browser', executable: '/no/such/browser', userDataDirectory: browserRoot },
    profile: { directoryName: 'Default', name: 'Work', path: profileRoot },
    allowRunning: true,
    onProgress(message) {
      if (!changedDuringCopy && message === 'Copying IndexedDB/https_venice.ai_0.indexeddb.leveldb') {
        changedDuringCopy = true;
        writeFileSync(journalPath, 'second journal state after browser maintenance');
      }
    }
  });
  assert.equal(changedDuringCopy, true);
  assert.equal(result.manifest.sourceConsistency.mode, 'browser-closed');
  assert.equal(result.manifest.sourceConsistency.reconciliation.required, true);
  assert.equal(result.manifest.sourceConsistency.reconciliation.initialChanges, 1);
  assert.equal(
    await readFile(path.join(result.userDataDirectory, 'Default/IndexedDB/https_venice.ai_0.indexeddb.leveldb/000001.log'), 'utf8'),
    'second journal state after browser maintenance'
  );
  assert.equal((await verifyRawSnapshot(result.snapshotRoot)).ok, true);
});

test('short snapshot reconciliation repairs a stale copy and still fails closed under continuous writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'venice-cli-reconcile-pass-'));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  const relativeRoot = 'IndexedDB/https_venice.ai_0.indexeddb.leveldb';
  const sourceJournal = path.join(source, relativeRoot, '000001.log');
  const targetJournal = path.join(target, relativeRoot, '000001.log');
  await mkdir(path.dirname(sourceJournal), { recursive: true });
  await mkdir(path.dirname(targetJournal), { recursive: true });
  await writeFile(sourceJournal, 'current source journal');
  await writeFile(targetJournal, 'stale target journal');
  await writeFile(path.join(target, relativeRoot, 'obsolete.log'), 'rotated away');
  const repaired = await reconcileConsistencySnapshot({ sourceProfile: source, targetProfile: target });
  assert.equal(await readFile(targetJournal, 'utf8'), 'current source journal');
  assert.ok(repaired.copiedFiles >= 1);
  assert.equal(repaired.removedFiles, 1);

  let writes = 0;
  await assert.rejects(
    reconcileConsistencySnapshot({
      sourceProfile: source,
      targetProfile: target,
      browserName: 'Fixture Browser',
      maxPasses: 2,
      onProgress(message) {
        if (message.includes('short pass')) writeFileSync(sourceJournal, `continuous write ${++writes} ${'x'.repeat(writes)}`);
      }
    }),
    /kept changing Venice storage.*No snapshot was kept/
  );
  assert.equal(writes, 2);
});

test('source checkpoint makes unchanged incremental checks fast and detects a delta', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'venice-cli-checkpoint-'));
  const profilePath = path.join(root, 'browser/Default');
  await mkdir(path.join(profilePath, 'IndexedDB/https_venice.ai_0.indexeddb.leveldb'), { recursive: true });
  const dataPath = path.join(profilePath, 'IndexedDB/https_venice.ai_0.indexeddb.leveldb/000001.log');
  await writeFile(dataPath, 'one');
  const setup = { archiveDirectory: path.join(root, 'archive'), browser: { id: 'brave' }, profile: { directoryName: 'Default', path: profilePath } };
  const inventory = await inventoryConsistencyFiles(profilePath);
  await saveSourceCheckpoint({ ...setup, snapshotManifest: { sourceInventory: serializeConsistencyInventory(inventory) }, captureId: 'capture-one' });
  assert.equal((await sourceCheckpointStatus(setup)).matches, true);
  await writeFile(dataPath, 'two-two');
  const changed = await sourceCheckpointStatus(setup);
  assert.equal(changed.matches, false);
  assert.equal(changed.changes.length, 1);
});

test('incremental extraction skips fingerprint-identical stores and unchanged OPFS', () => {
  const stores = [
    { name: 'conversations', count: 2, fingerprint: 'conversations-v1' },
    { name: 'messages', count: 4, fingerprint: 'messages-v1' },
    { name: 'settings', count: 1, fingerprint: 'settings-v1' }
  ];
  const opfs = [{ path: 'media/c1/image.png', size: 10, lastModified: 100, fileName: 'image.png' }];
  const previous = { runId: 'capture-one', sourceInventory: { stores, opfs } };
  assert.equal(planIncrementalExtraction(previous, stores, opfs).unchanged, true);
  const changedStores = stores.map((item) => item.name === 'messages' ? { ...item, count: 5, fingerprint: 'messages-v2' } : item);
  const changed = planIncrementalExtraction(previous, changedStores, [...opfs, { path: 'media/c1/new.png', size: 20, lastModified: 200 }]);
  assert.deepEqual(changed.stores.map((item) => item.name), ['conversations', 'messages']);
  assert.deepEqual(changed.opfs.map((item) => item.path), ['media/c1/new.png']);
  assert.equal(changed.skippedStores, 1);
  assert.equal(changed.skippedOpfs, 1);
});

test('source change scopes avoid full inventories when IndexedDB and OPFS are unchanged', () => {
  const previous = { sourceInventory: { stores: [{ name: 'messages' }, { name: 'browserLocalStorage' }], opfs: [{ path: 'media/example' }] } };
  const local = planInventoryReads(previous, [{ path: 'Local Storage/leveldb/000001.log', change: 'modified' }]);
  assert.equal(local.reuseStores, true);
  assert.equal(local.localStorageChanged, true);
  assert.equal(local.sessionStorageChanged, false);
  assert.equal(local.reuseOpfs, true);
  const session = planInventoryReads(previous, [{ path: 'Session Storage/000003.log', change: 'modified' }]);
  assert.equal(session.reuseStores, true);
  assert.equal(session.sessionStorageChanged, true);
  assert.equal(session.reuseOpfs, true);
  const opfs = planInventoryReads(previous, [{ path: 'File System/001/t/00/00000001', change: 'created' }]);
  assert.equal(opfs.reuseStores, true);
  assert.equal(opfs.reuseOpfs, false);
  const indexedDb = planInventoryReads(previous, [{ path: 'IndexedDB/https_venice.ai_0.indexeddb.leveldb/000002.ldb', change: 'created' }]);
  assert.equal(indexedDb.reuseStores, false);
  assert.equal(indexedDb.reuseOpfs, true);
});

test('SQLite index searches conversations, messages, and media', async () => {
  const archive = await mkdtemp(path.join(os.tmpdir(), 'venice-cli-search-'));
  await mkdir(path.join(archive, 'indexes'), { recursive: true });
  await writeFile(path.join(archive, 'indexes/conversations.json'), JSON.stringify([
    { id: 'c1', title: 'Project Lantern', preview: 'Planning notes', markdownPath: 'conversations/c1.md', createdAt: '2026-01-01' }
  ]));
  await writeFile(path.join(archive, 'indexes/messages.jsonl'), `${JSON.stringify({ id: 'm1', conversationId: 'c1', conversationTitle: 'Project Lantern', text: 'The launch checklist contains telemetry tasks.', createdAt: '2026-01-02' })}\n`);
  await writeFile(path.join(archive, 'indexes/media.json'), JSON.stringify({ items: [
    { mediaId: 'asset1', conversationId: 'c1', fileName: 'lantern-diagram.png', kind: 'image', prompt: 'system architecture', path: 'media/asset1.png' }
  ] }));
  const index = await buildSearchIndex(archive);
  assert.equal(index.items, 3);
  const messageResults = await searchArchive(archive, 'launch telemetry');
  assert.equal(messageResults[0].type, 'message');
  const mediaResults = await searchArchive(archive, 'architecture diagram');
  assert.equal(mediaResults[0].type, 'media');
});

test('lossless captures normalize known Venice stores and OPFS for search', async () => {
  const capture = await mkdtemp(path.join(os.tmpdir(), 'venice-cli-capture-'));
  await mkdir(path.join(capture, 'stores'), { recursive: true });
  await writeFile(path.join(capture, 'stores/conversations.jsonl'), `${JSON.stringify({ id: 'c1', title: 'Captured planning' })}\n`);
  await writeFile(path.join(capture, 'stores/messages.jsonl'), `${JSON.stringify({ id: 'm1', conversationId: 'c1', role: 'user', content: 'Remember the cobalt launch notes.' })}\n`);
  await writeFile(path.join(capture, 'capture.manifest.json'), JSON.stringify({
    stores: [
      { name: 'conversations', path: 'stores/conversations.jsonl' },
      { name: 'messages', path: 'stores/messages.jsonl' }
    ],
    opfs: [{ path: 'studio/image.webp', fileName: 'image.webp', kind: 'image', mimeType: 'image/webp', archivedPath: 'opfs/a/image.webp' }]
  }));
  const result = await normalizeCapture(capture);
  assert.deepEqual(result, { conversations: 1, messages: 1, media: 1 });
  const conversations = JSON.parse(await readFile(path.join(capture, 'indexes/conversations.json'), 'utf8'));
  assert.equal(conversations[0].messageCount, 1);
  await buildSearchIndex(capture);
  const found = await searchArchive(capture, 'cobalt launch');
  assert.ok(found.some((item) => item.id === 'm1' && item.type === 'message'));
});

test('OPFS meta sidecars enrich their media file and stay out of the library', async () => {
  const capture = await mkdtemp(path.join(os.tmpdir(), 'venice-cli-sidecar-'));
  await mkdir(path.join(capture, 'opfs'), { recursive: true });
  const hash = 'a'.repeat(64);
  await writeFile(path.join(capture, 'opfs/asset'), 'media bytes');
  await writeFile(path.join(capture, 'opfs/asset.meta'), JSON.stringify({ hash, mediaId: 'media-one', fileName: 'finished-video.mp4', mimeType: 'video/mp4', type: 'video', storedAt: 1000 }));
  await writeFile(path.join(capture, 'capture.manifest.json'), JSON.stringify({ stores: [], opfs: [
    { path: `video-editor/session/${hash}`, archivedPath: 'opfs/asset', fileName: hash, size: 11, lastModified: 900, mimeType: 'application/octet-stream', kind: 'file' },
    { path: `video-editor/session/${hash}.meta`, archivedPath: 'opfs/asset.meta', fileName: `${hash}.meta`, size: 200, lastModified: 1000, mimeType: 'application/octet-stream', kind: 'file' }
  ] }));
  const result = await normalizeCapture(capture);
  assert.equal(result.media, 1);
  const media = JSON.parse(await readFile(path.join(capture, 'indexes/media.json'), 'utf8')).items;
  assert.deepEqual(media.map((item) => [item.fileName, item.kind, item.mimeType]), [['finished-video.mp4', 'video', 'video/mp4']]);
});

test('Studio media retains its saved model and explicit input/output role', async () => {
  const archive = await mkdtemp(path.join(os.tmpdir(), 'venice-cli-studio-media-meta-'));
  const capture = path.join(archive, 'captures/capture-studio');
  await mkdir(path.join(capture, 'stores'), { recursive: true });
  await mkdir(path.join(capture, 'opfs'), { recursive: true });
  await writeFile(path.join(capture, 'opfs/input.png'), 'input');
  await writeFile(path.join(capture, 'opfs/output.png'), 'output');
  await writeFile(path.join(capture, 'stores/studio-sessions.jsonl'), `${JSON.stringify({ id: 's1', name: 'Venice Image Studio', type: 'edit', createdAt: 1000, updatedAt: 2000 })}\n`);
  await writeFile(path.join(capture, 'stores/studio-turns.jsonl'), `${JSON.stringify({ id: 'turn-1', sessionId: 's1', prompt: 'Refine this image', mode: 'edit', createdAt: 1500 })}\n`);
  await writeFile(path.join(capture, 'stores/studio-media.jsonl'), [
    { id: 'studio-input', sessionId: 's1', turnId: 'turn-1', mimeType: 'image/png', mediaRole: 'input' },
    { id: 'studio-output', sessionId: 's1', turnId: 'turn-1', mimeType: 'image/png', mediaRole: 'output', modelId: 'image-model-id', modelName: 'Image Model' }
  ].map((item) => JSON.stringify(item)).join('\n') + '\n');
  const opfs = [
    { path: 'media/s1/studio-input.png', archivedPath: 'opfs/input.png', fileName: 'studio-input.png', size: 5, mimeType: 'image/png', kind: 'image' },
    { path: 'media/s1/studio-output.png', archivedPath: 'opfs/output.png', fileName: 'studio-output.png', size: 6, mimeType: 'image/png', kind: 'image' }
  ];
  await writeFile(path.join(capture, 'capture.manifest.json'), JSON.stringify({ stores: [
    { name: 'studioImageSessions', path: 'stores/studio-sessions.jsonl' },
    { name: 'studioImageTurns', path: 'stores/studio-turns.jsonl' },
    { name: 'studioImageTurnMedia', path: 'stores/studio-media.jsonl' }
  ], opfs }));
  await writeFile(path.join(capture, 'capture.verification.json'), JSON.stringify({ ok: true, opfs: opfs.map((item) => ({ archivedPath: item.archivedPath, bytes: item.size })) }));
  const result = await normalizeCapture(capture);
  assert.deepEqual(result, { conversations: 1, messages: 1, media: 2 });
  const normalizedConversations = JSON.parse(await readFile(path.join(capture, 'indexes/conversations.json'), 'utf8'));
  const normalizedMessages = (await readFile(path.join(capture, 'indexes/messages.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(normalizedConversations[0].kind, 'studio');
  assert.equal(normalizedConversations[0].title, 'Venice Image Studio');
  assert.deepEqual(normalizedMessages.map((item) => [item.id, item.conversationId, item.text, item.studioTurn]), [['turn-1', 's1', 'Refine this image', true]]);
  const normalized = JSON.parse(await readFile(path.join(capture, 'indexes/media.json'), 'utf8')).items;
  assert.equal(normalized.find((item) => item.mediaId === 'studio-output').model, 'Image Model');
  assert.equal(normalized.find((item) => item.mediaId === 'studio-output').modelId, 'image-model-id');
  assert.equal(normalized.find((item) => item.mediaId === 'studio-input').mediaDisposition, 'input');
  const catalog = await new ArchiveCatalog(archive).reload();
  const available = catalog.listMedia(new URLSearchParams('uploads=include')).items;
  const input = available.find((item) => item.fileName === 'studio-input.png');
  const output = available.find((item) => item.fileName === 'studio-output.png');
  assert.equal(input.mediaDisposition, 'input');
  assert.equal(input.isUploaded, true);
  assert.equal(input.model, null);
  assert.equal(output.mediaDisposition, 'output');
  assert.equal(output.isUploaded, false);
  assert.equal(output.model, 'Image Model');
  assert.equal(output.modelId, 'image-model-id');
  assert.equal(output.conversationKind, 'studio');
  assert.equal(output.conversationMessageCount, 1);
  const session = catalog.conversation('s1');
  assert.equal(session.kind, 'studio');
  assert.equal(session.messageCount, 1);
  assert.equal(session.mediaCount, 2);
  assert.deepEqual(session.media.map((item) => [item.messageId, item.mediaDisposition]), [['turn-1', 'input'], ['turn-1', 'output']]);
});

test('Video Studio OPFS media is linked inline with friendly models and duplicate working copies removed', async () => {
  const archive = await mkdtemp(path.join(os.tmpdir(), 'venice-cli-video-studio-'));
  const capture = path.join(archive, 'captures/capture-video-studio');
  const conversationId = 'video-studio-gallery-owner';
  const outputHash = 'a'.repeat(64);
  const inputHash = 'b'.repeat(64);
  await mkdir(path.join(capture, 'stores'), { recursive: true });
  await mkdir(path.join(capture, 'opfs'), { recursive: true });
  await mkdir(path.join(archive, 'indexes'), { recursive: true });
  await mkdir(path.join(archive, 'media'), { recursive: true });
  await writeFile(path.join(capture, 'opfs/input.jpg'), 'input image');
  await writeFile(path.join(capture, 'opfs/output.mp4'), 'output video');
  await writeFile(path.join(archive, 'media/output-copy.mp4'), 'output video');
  await writeFile(path.join(capture, 'stores/conversations.jsonl'), `${JSON.stringify({ id: conversationId, title: 'Venice Video Studio', type: 'video' })}\n`);
  await writeFile(path.join(capture, 'stores/messages.jsonl'), `${JSON.stringify({
    id: 'turn-1',
    conversationId,
    role: 'assistant',
    content: 'Animate the subject with a slow camera move.',
    modelName: 'Cinema Motion',
    modelId: 'cinema-motion-v2',
    fileName: `${conversationId}/turn-1.mp4`,
    fileType: 'video/mp4',
    createdAt: 2000
  })}\n`);
  const opfs = [
    { path: `media/${conversationId}/attachments/turn-1__m1.jpg`, archivedPath: 'opfs/input.jpg', fileName: 'turn-1__m1.jpg', size: 11, mimeType: 'image/jpeg', kind: 'image' },
    { path: `media/${conversationId}/turn-1.mp4`, archivedPath: 'opfs/output.mp4', fileName: 'turn-1.mp4', size: 12, mimeType: 'video/mp4', kind: 'video' }
  ];
  await writeFile(path.join(capture, 'capture.manifest.json'), JSON.stringify({ stores: [
    { name: 'conversations', path: 'stores/conversations.jsonl' },
    { name: 'messages', path: 'stores/messages.jsonl' }
  ], opfs }));
  await writeFile(path.join(capture, 'capture.verification.json'), JSON.stringify({ ok: true, opfs: [
    { archivedPath: 'opfs/input.jpg', sha256: inputHash, bytes: 11 },
    { archivedPath: 'opfs/output.mp4', sha256: outputHash, bytes: 12 }
  ] }));

  const result = await normalizeCapture(capture);
  assert.deepEqual(result, { conversations: 1, messages: 1, media: 2 });
  const normalizedConversation = JSON.parse(await readFile(path.join(capture, 'indexes/conversations.json'), 'utf8'))[0];
  const normalizedMessage = JSON.parse((await readFile(path.join(capture, 'indexes/messages.jsonl'), 'utf8')).trim());
  const normalizedMedia = JSON.parse(await readFile(path.join(capture, 'indexes/media.json'), 'utf8')).items;
  assert.deepEqual([normalizedConversation.kind, normalizedConversation.studioType, normalizedConversation.studioSession], ['studio', 'video', true]);
  assert.deepEqual(
    [normalizedMessage.role, normalizedMessage.sourceRole, normalizedMessage.model, normalizedMessage.modelId, normalizedMessage.studioTurn],
    ['user', 'assistant', 'Cinema Motion', 'cinema-motion-v2', true]
  );
  assert.deepEqual(normalizedMedia.map((item) => [item.messageId, item.mediaDisposition, item.model]), [
    ['turn-1', 'input', null],
    ['turn-1', 'output', 'Cinema Motion']
  ]);

  await writeFile(path.join(capture, 'indexes/conversations.json'), JSON.stringify([{ ...normalizedConversation, kind: 'chat', studioType: null, studioSession: false }]));
  await writeFile(path.join(capture, 'indexes/messages.jsonl'), `${JSON.stringify({ ...normalizedMessage, role: 'assistant', sourceRole: null, model: 'cinema-motion-v2', modelId: null, studioType: null, studioTurn: false })}\n`);
  await writeFile(path.join(capture, 'indexes/media.json'), JSON.stringify({ items: normalizedMedia.map((item) => item.mediaDisposition === 'output'
    ? { ...item, mediaDisposition: null, model: null, modelId: null }
    : item) }));

  await writeFile(path.join(archive, 'indexes/conversations.json'), '[]');
  await writeFile(path.join(archive, 'indexes/messages.jsonl'), '');
  await writeFile(path.join(archive, 'indexes/media.json'), JSON.stringify({ items: [{
    mediaId: 'working-copy',
    conversationId,
    fileName: 'turn-1.mp4',
    kind: 'video',
    mimeType: 'video/mp4',
    source: 'opfs',
    path: 'media/output-copy.mp4',
    sha256: outputHash
  }] }));

  const catalog = await new ArchiveCatalog(archive).reload();
  const session = catalog.conversation(conversationId);
  assert.equal(session.kind, 'studio');
  assert.equal(session.studioType, 'video');
  assert.equal(session.media.length, 2);
  assert.deepEqual(session.media.map((item) => [item.messageId, item.mediaDisposition, item.model, item.modelId]), [
    ['turn-1', 'input', null, null],
    ['turn-1', 'output', 'Cinema Motion', 'cinema-motion-v2']
  ]);
  assert.equal(catalog.media.some((item) => item.id === 'working-copy'), false);
});

test('message normalization retains response metrics when Venice provides them', async () => {
  const capture = await mkdtemp(path.join(os.tmpdir(), 'venice-cli-message-meta-'));
  await mkdir(path.join(capture, 'stores'), { recursive: true });
  await writeFile(path.join(capture, 'stores/conversations.jsonl'), `${JSON.stringify({ id: 'c1', title: 'Metrics' })}\n`);
  await writeFile(path.join(capture, 'stores/messages.jsonl'), `${JSON.stringify({ id: 'm1', conversationId: 'c1', role: 'assistant', content: 'A measured response', modelId: 'test-model', totalInferenceTime: 4321, usage: { completion_tokens: 17, total_tokens: 23 }, streamingStatus: 'complete' })}\n`);
  await writeFile(path.join(capture, 'capture.manifest.json'), JSON.stringify({ stores: [{ name: 'conversations', path: 'stores/conversations.jsonl' }, { name: 'messages', path: 'stores/messages.jsonl' }], opfs: [] }));
  await normalizeCapture(capture);
  const message = JSON.parse((await readFile(path.join(capture, 'indexes/messages.jsonl'), 'utf8')).trim());
  assert.equal(message.outputTokens, 17);
  assert.equal(message.totalTokens, 23);
  assert.equal(message.executionTimeMs, 4321);
  assert.equal(message.status, 'complete');
});

test('agentic capture records normalize into readable conversation messages', async () => {
  const capture = await mkdtemp(path.join(os.tmpdir(), 'venice-cli-agentic-'));
  await mkdir(path.join(capture, 'stores'), { recursive: true });
  await writeFile(path.join(capture, 'stores/mind-conversations.jsonl'), `${JSON.stringify({ id: 'agent1', name: 'Agent research', createdAtUnixTimestamp: 1000 })}\n`);
  await writeFile(path.join(capture, 'stores/mind-messages.jsonl'), [
    { id: 'u1', mind_conversation_id: 'agent1', role: 'user', created_at_unix_timestamp: 1100, output_items: [{ type: 'message', content: [{ text: 'Research this market.' }] }] },
    { id: 'a1', mind_conversation_id: 'agent1', role: 'assistant', created_at_unix_timestamp: 1200, output_items: [{ type: 'reasoning', content: [{ text: 'Private reasoning' }] }, { type: 'message', content: [{ text: '**Final answer** with evidence.' }] }] }
  ].map((item) => JSON.stringify(item)).join('\n') + '\n');
  await writeFile(path.join(capture, 'stores/mind-attachments.jsonl'), `${JSON.stringify({ id: 'attachment.1', filename: 'market-brief.md', mimeType: 'text/markdown', mindConversationId: 'agent1', mindMessageId: 'u1' })}\n`);
  await writeFile(path.join(capture, 'stores/mind-media.jsonl'), `${JSON.stringify({ id: 'generated.0', mimeType: 'image/png', mindConversationId: 'agent1', mindMessageId: 'a1' })}\n`);
  await writeFile(path.join(capture, 'capture.manifest.json'), JSON.stringify({ stores: [
    { name: 'mindConversations', path: 'stores/mind-conversations.jsonl' },
    { name: 'mindMessages', path: 'stores/mind-messages.jsonl' },
    { name: 'mindAttachments', path: 'stores/mind-attachments.jsonl' },
    { name: 'mindMedia', path: 'stores/mind-media.jsonl' }
  ], opfs: [
    { path: 'media/agent1/attachments/attachment.1.markdown', fileName: 'attachment.1.markdown', size: 120, mimeType: 'application/octet-stream', kind: 'file', archivedPath: 'opfs/attachment.markdown' },
    { path: 'media/agent1/generated.0.png', fileName: 'generated.0.png', size: 240, mimeType: 'image/png', kind: 'image', archivedPath: 'opfs/generated.png' }
  ] }));
  const result = await normalizeCapture(capture);
  assert.deepEqual(result, { conversations: 1, messages: 2, media: 2 });
  const conversations = JSON.parse(await readFile(path.join(capture, 'indexes/conversations.json'), 'utf8'));
  const messages = (await readFile(path.join(capture, 'indexes/messages.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const media = JSON.parse(await readFile(path.join(capture, 'indexes/media.json'), 'utf8')).items;
  assert.equal(conversations[0].messageCount, 2);
  assert.equal(conversations[0].mediaCount, 2);
  assert.equal(conversations[0].kind, 'agentic');
  assert.equal(messages[0].conversationId, 'agent1');
  assert.equal(messages[1].text, '**Final answer** with evidence.');
  assert.doesNotMatch(messages[1].text, /Private reasoning/);
  assert.deepEqual(media.map((item) => [item.mediaId, item.conversationId, item.messageId, item.fileName, item.kind, item.path]), [
    ['attachment.1', 'agent1', 'u1', 'market-brief.md', 'file', 'opfs/attachment.markdown'],
    ['generated.0', 'agent1', 'a1', 'generated.0.png', 'image', 'opfs/generated.png']
  ]);
  const catalog = await new ArchiveCatalog(capture).reload();
  assert.deepEqual(catalog.conversation('agent1').media.map((item) => [item.id, item.displayMessageId, item.mediaDisposition]), [
    ['attachment.1', 'u1', 'input'],
    ['generated.0', 'a1', 'output']
  ]);
});

test('catalog orders input before output and suppresses covered placeholders', async () => {
  const archive = await mkdtemp(path.join(os.tmpdir(), 'venice-cli-media-order-'));
  await mkdir(path.join(archive, 'indexes'), { recursive: true });
  await mkdir(path.join(archive, 'media'), { recursive: true });
  await writeFile(path.join(archive, 'media/input.png'), 'input');
  await writeFile(path.join(archive, 'media/user-linked-input.png'), 'user input');
  await writeFile(path.join(archive, 'media/output.png'), 'output');
  await writeFile(path.join(archive, 'indexes/conversations.json'), JSON.stringify([{ id: 'c1', title: 'Image edit' }]));
  await writeFile(path.join(archive, 'indexes/messages.jsonl'), [
    { id: 'u1', conversationId: 'c1', role: 'user', createdAt: 1000, text: 'Edit this' },
    { id: 'a1', conversationId: 'c1', role: 'assistant', createdAt: 2000, model: 'image-model', text: 'Edit this' }
  ].map((item) => JSON.stringify(item)).join('\n') + '\n');
  await writeFile(path.join(archive, 'indexes/media.json'), JSON.stringify({ items: [
    { mediaId: 'a1', conversationId: 'c1', messageId: 'a1', kind: 'image', source: 'messageImages', path: null },
    { mediaId: 'input', conversationId: 'c1', messageId: 'a1', kind: 'image', source: 'message.attachments', path: 'media/input.png' },
    { mediaId: 'user-linked-input', conversationId: 'c1', messageId: 'u1', kind: 'image', source: 'messageImages', path: 'media/user-linked-input.png' },
    { mediaId: 'output', conversationId: 'c1', messageId: 'a1', kind: 'image', source: 'messageImages', path: 'media/output.png' }
  ] }));
  const catalog = await new ArchiveCatalog(archive).reload();
  const conversation = catalog.conversation('c1');
  assert.equal(catalog.overview().totals.unavailableMedia, 0);
  assert.equal(conversation.media.length, 3);
  assert.deepEqual(conversation.media.map((item) => [item.id, item.displayMessageId, item.mediaDisposition]), [
    ['user-linked-input', 'u1', 'input'],
    ['input', 'u1', 'input'],
    ['output', 'a1', 'output']
  ]);
  assert.equal(conversation.media.find((item) => item.id === 'user-linked-input').model, null);
  assert.equal(conversation.media.find((item) => item.id === 'output').model, 'image-model');
  assert.equal(catalog.overview().recentMedia.length, 1);
  assert.equal(catalog.overview().recentMedia[0].id, 'output');
  assert.deepEqual(catalog.listMedia(new URLSearchParams()).items.map((item) => item.id), ['output']);
  assert.deepEqual(catalog.listMedia(new URLSearchParams('uploads=include')).items.map((item) => item.id).sort(), ['input', 'output', 'user-linked-input']);
  assert.equal(catalog.conversation('c1').media.length, 3);
});

test('catalog combines favourites with media filters and useful sort orders', async () => {
  const archive = await mkdtemp(path.join(os.tmpdir(), 'venice-cli-media-sorts-'));
  await mkdir(path.join(archive, 'indexes'), { recursive: true });
  await mkdir(path.join(archive, 'media'), { recursive: true });
  for (const name of ['alpha.md', 'bravo.md', 'charlie.md']) await writeFile(path.join(archive, 'media', name), `# ${name}`);
  await writeFile(path.join(archive, 'indexes/conversations.json'), JSON.stringify([
    { id: 'new-session', title: 'New session', updatedAt: '2026-04-01T00:00:00.000Z' },
    { id: 'old-session', title: 'Old session', updatedAt: '2026-03-01T00:00:00.000Z' }
  ]));
  await writeFile(path.join(archive, 'indexes/messages.jsonl'), '');
  await writeFile(path.join(archive, 'indexes/media.json'), JSON.stringify({ items: [
    { mediaId: 'a', conversationId: 'new-session', fileName: 'charlie.md', kind: 'file', path: 'media/charlie.md', createdAt: '2026-02-01T00:00:00.000Z', model: 'Zulu' },
    { mediaId: 'b', conversationId: 'old-session', fileName: 'alpha.md', kind: 'file', path: 'media/alpha.md', createdAt: '2026-03-01T00:00:00.000Z', model: 'Alpha' },
    { mediaId: 'c', conversationId: 'new-session', fileName: 'bravo.md', kind: 'file', path: 'media/bravo.md', createdAt: '2026-01-01T00:00:00.000Z', model: 'Beta' }
  ] }));
  const catalog = await new ArchiveCatalog(archive).reload();
  catalog.setFavouriteKeys(['id:c']);
  assert.deepEqual(catalog.listMedia(new URLSearchParams('sort=recent')).items.map((item) => item.id), ['b', 'a', 'c']);
  assert.deepEqual(catalog.listMedia(new URLSearchParams('sort=oldest')).items.map((item) => item.id), ['c', 'a', 'b']);
  assert.deepEqual(catalog.listMedia(new URLSearchParams('sort=session')).items.map((item) => item.id), ['c', 'a', 'b']);
  assert.deepEqual(catalog.listMedia(new URLSearchParams('sort=model')).items.map((item) => item.id), ['b', 'c', 'a']);
  assert.deepEqual(catalog.listMedia(new URLSearchParams('sort=name')).items.map((item) => item.id), ['b', 'c', 'a']);
  const favourites = catalog.listMedia(new URLSearchParams('favourites=only'));
  assert.equal(favourites.favourites, 1);
  assert.deepEqual(favourites.items.map((item) => [item.id, item.isFavourite]), [['c', true]]);
  catalog.setHiddenMediaKeys(['id:b']);
  const hiddenExcluded = catalog.listMedia(new URLSearchParams());
  assert.equal(hiddenExcluded.hidden, 1);
  assert.deepEqual(hiddenExcluded.items.map((item) => item.id), ['a', 'c']);
  const hiddenIncluded = catalog.listMedia(new URLSearchParams('hidden=include'));
  assert.deepEqual(hiddenIncluded.items.map((item) => [item.id, item.isHidden]), [['b', true], ['a', false], ['c', false]]);
  assert.deepEqual(catalog.overview().recentMedia.map((item) => item.id), ['a', 'c']);
  assert.equal(catalog.search('alpha').filteredTotal, 0);
  await catalog.reload();
  assert.equal(catalog.mediaItem('c').isFavourite, true);
  assert.equal(catalog.mediaItem('b').isHidden, true);
});

test('catalog repairs legacy agentic links and preserves repeated attachment placement', async () => {
  const archive = await mkdtemp(path.join(os.tmpdir(), 'venice-cli-agentic-links-'));
  const capture = path.join(archive, 'captures/capture-legacy');
  await mkdir(path.join(capture, 'indexes'), { recursive: true });
  await mkdir(path.join(capture, 'stores'), { recursive: true });
  await mkdir(path.join(capture, 'opfs'), { recursive: true });
  await writeFile(path.join(capture, 'opfs/first.png'), 'one!');
  await writeFile(path.join(capture, 'opfs/second.png'), 'two!');
  await writeFile(path.join(capture, 'stores/mind-attachments.jsonl'), [
    { id: 'same.1', filename: 'first.png', mimeType: 'image/png', mindConversationId: 'c1', mindMessageId: 'u1' },
    { id: 'same.2', filename: 'second.png', mimeType: 'image/png', mindConversationId: 'c1', mindMessageId: 'u2' }
  ].map((item) => JSON.stringify(item)).join('\n') + '\n');
  const opfs = [
    { path: 'media/c1/attachments/same.1.png', archivedPath: 'opfs/first.png', fileName: 'same.1.png', size: 4, mimeType: 'image/png', kind: 'image' },
    { path: 'media/c1/attachments/same.2.png', archivedPath: 'opfs/second.png', fileName: 'same.2.png', size: 4, mimeType: 'image/png', kind: 'image' }
  ];
  await writeFile(path.join(capture, 'capture.manifest.json'), JSON.stringify({ stores: [{ name: 'mindAttachments', path: 'stores/mind-attachments.jsonl' }], opfs }));
  await writeFile(path.join(capture, 'capture.verification.json'), JSON.stringify({ ok: true, opfs: opfs.map((item) => ({ archivedPath: item.archivedPath, sha256: 'same-content', bytes: 4 })) }));
  await writeFile(path.join(capture, 'indexes/conversations.json'), JSON.stringify([{ id: 'c1', title: 'Agentic attachments', kind: 'agentic' }]));
  await writeFile(path.join(capture, 'indexes/messages.jsonl'), [
    { id: 'u1', conversationId: 'c1', role: 'user', text: 'First use' },
    { id: 'u2', conversationId: 'c1', role: 'user', text: 'Second use' }
  ].map((item) => JSON.stringify(item)).join('\n') + '\n');
  await writeFile(path.join(capture, 'indexes/media.json'), JSON.stringify({ items: [
    { mediaId: 'same.1', kind: 'file', source: 'mindAttachments', path: null },
    { mediaId: 'same.2', kind: 'file', source: 'mindAttachments', path: null },
    { mediaId: 'opfs:first', fileName: 'same.1.png', kind: 'image', source: 'opfs', path: 'opfs/first.png' },
    { mediaId: 'opfs:second', fileName: 'same.2.png', kind: 'image', source: 'opfs', path: 'opfs/second.png' }
  ] }));
  const catalog = await new ArchiveCatalog(archive).reload();
  const conversation = catalog.conversation('c1');
  assert.equal(catalog.overview().totals.unavailableMedia, 0);
  assert.deepEqual(conversation.media.map((item) => [item.fileName, item.messageId, item.displayMessageId, item.available]), [
    ['first.png', 'u1', 'u1', true],
    ['second.png', 'u2', 'u2', true]
  ]);
});

test('catalog whole-word search excludes substring-only matches', async () => {
  const archive = await mkdtemp(path.join(os.tmpdir(), 'venice-cli-whole-word-'));
  await mkdir(path.join(archive, 'indexes'), { recursive: true });
  await writeFile(path.join(archive, 'indexes/conversations.json'), JSON.stringify([
    { id: 'car', title: 'Car research', preview: 'A vehicle review' },
    { id: 'cartoon', title: 'Cartoon references', preview: 'Animation notes' }
  ]));
  await writeFile(path.join(archive, 'indexes/messages.jsonl'), '');
  await writeFile(path.join(archive, 'indexes/media.json'), '{"items":[]}');
  const catalog = await new ArchiveCatalog(archive).reload();
  assert.equal(catalog.search('car').filteredTotal, 2);
  const whole = catalog.search('car', 'all', 100, 'whole');
  assert.equal(whole.filteredTotal, 1);
  assert.equal(whole.items[0].id, 'car');
});

test('local service exposes semantic library APIs and background sync over loopback', async () => {
  const archive = await mkdtemp(path.join(os.tmpdir(), 'venice-cli-service-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'venice-cli-outside-'));
  await mkdir(path.join(archive, 'indexes'), { recursive: true });
  await mkdir(path.join(archive, '.venice-archive'), { recursive: true });
  await writeFile(path.join(archive, '.venice-archive/favourites.json'), JSON.stringify({ version: 1, keys: ['id:image1'] }));
  await writeFile(path.join(archive, 'indexes/conversations.json'), JSON.stringify([{ id: 'c1', title: 'Service Search', preview: 'private lantern archive' }]));
  await writeFile(path.join(archive, 'indexes/messages.jsonl'), `${JSON.stringify({ id: 'm1', conversationId: 'c1', conversationTitle: 'Service Search', role: 'user', text: `${'Earlier context. '.repeat(45)}private lantern archive message` })}\n`);
  await mkdir(path.join(archive, 'media'), { recursive: true });
  await writeFile(path.join(archive, 'media/lantern.png'), 'image');
  await writeFile(path.join(archive, 'media/lantern.mp4'), 'video');
  await writeFile(path.join(outside, 'private.txt'), 'must not be served');
  await writeFile(path.join(archive, 'indexes/media.json'), JSON.stringify({ items: [
    { mediaId: 'image1', fileName: 'private-lantern.png', kind: 'image', path: 'media/lantern.png' },
    { mediaId: 'video1', fileName: 'private-lantern.mp4', kind: 'video', path: 'media/lantern.mp4' }
  ] }));
  await buildSearchIndex(archive);
  let openedDirectory = null;
  let revealedFile = null;
  const service = await startArchiveService(archive, {
    port: 0,
    onSync: async (emit) => { emit({ phase: 'verify', message: 'Verifying fixture' }); return { captureId: 'fixture' }; },
    onOpenLocation: async (directory) => { openedDirectory = directory; },
    onRevealFile: async (filePath) => { revealedFile = filePath; }
  });
  try {
    assert.match(service.url, /^http:\/\/127\.0\.0\.1:/);
    const page = await fetch(service.url);
    const pageHtml = await page.text();
    assert.match(pageHtml, /Archiv/);
    assert.match(pageHtml, /favicon\.svg/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(await getStatus(service.url, { host: 'attacker.example' }), 403);
    const favicon = await fetch(`${service.url}favicon.ico`);
    assert.equal(favicon.status, 200);
    assert.match(favicon.headers.get('content-type'), /svg/);
    const license = await fetch(`${service.url}license`);
    assert.equal(license.status, 200);
    assert.match(license.headers.get('content-type'), /text\/plain/);
    assert.match(await license.text(), /GNU AFFERO GENERAL PUBLIC LICENSE/);
    const missingFile = await fetch(`${service.url}api/file/imported%20archive/does-not-exist.css`);
    assert.equal(missingFile.status, 404);
    const archivedFile = await fetch(`${service.url}api/file/imported%20archive/media/lantern.png`);
    assert.equal(archivedFile.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(archivedFile.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    const download = await fetch(`${service.url}api/download/image1`);
    assert.match(download.headers.get('content-disposition'), /private-lantern\.png/);
    assert.equal(await download.text(), 'image');
    const revealed = await fetch(`${service.url}api/reveal-file`, { method: 'POST', body: JSON.stringify({ id: 'image1' }) });
    assert.equal(revealed.status, 200);
    assert.equal(revealedFile, await realpath(path.join(archive, 'media/lantern.png')));
    const initialOverview = await (await fetch(`${service.url}api/overview`)).json();
    assert.equal(initialOverview.capabilities.favourites, true);
    assert.equal(initialOverview.capabilities.hiddenMedia, true);
    const response = await fetch(`${service.url}api/search?q=private%20lantern`);
    const results = await response.json();
    assert.equal(results.total, 4);
    assert.ok(results.items.some((item) => item.id === 'm1' && item.type === 'message'));
    const filteredSearch = await (await fetch(`${service.url}api/search?q=private%20lantern&type=message`)).json();
    assert.deepEqual(filteredSearch.counts, { conversation: 1, message: 1, media: 2 });
    assert.equal(filteredSearch.filteredTotal, 1);
    assert.equal(filteredSearch.items[0].type, 'message');
    assert.match(filteredSearch.items[0].excerpt, /private lantern/);
    assert.ok(filteredSearch.items[0].excerpt.startsWith('…'));
    const wholeSearch = await (await fetch(`${service.url}api/search?q=lantern&match=whole`)).json();
    assert.equal(wholeSearch.total, 4);
    const filteredMedia = await (await fetch(`${service.url}api/media?kind=image&limit=1`)).json();
    assert.deepEqual(filteredMedia.facets, { all: 2, image: 1, video: 1, audio: 0, file: 0 });
    assert.equal(filteredMedia.items.length, 1);
    assert.equal(filteredMedia.items[0].isFavourite, true);
    const favouriteMedia = await (await fetch(`${service.url}api/media?favourites=only`)).json();
    assert.equal(favouriteMedia.total, 1);
    assert.deepEqual(favouriteMedia.facets, { all: 1, image: 1, video: 0, audio: 0, file: 0 });
    assert.deepEqual(favouriteMedia.items.map((item) => item.id), ['image1']);
    const favouriteVideos = await (await fetch(`${service.url}api/media?favourites=only&kind=video`)).json();
    assert.equal(favouriteVideos.total, 0);
    assert.deepEqual(favouriteVideos.facets, { all: 1, image: 1, video: 0, audio: 0, file: 0 });
    const crossSiteHidden = await fetch(`${service.url}api/hidden`, { method: 'POST', headers: { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body: JSON.stringify({ id: 'image1', hidden: true }) });
    assert.equal(crossSiteHidden.status, 403);
    const hideMedia = await (await fetch(`${service.url}api/hidden`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'image1', hidden: true }) })).json();
    assert.equal(hideMedia.item.isHidden, true);
    assert.deepEqual(JSON.parse(await readFile(path.join(archive, '.venice-archive/hidden-media.json'), 'utf8')).keys, ['id:image1']);
    const defaultAfterHide = await (await fetch(`${service.url}api/media?kind=image`)).json();
    assert.equal(defaultAfterHide.total, 0);
    assert.equal(defaultAfterHide.hidden, 1);
    assert.deepEqual(defaultAfterHide.facets, { all: 1, image: 0, video: 1, audio: 0, file: 0 });
    const includedAfterHide = await (await fetch(`${service.url}api/media?kind=image&hidden=include`)).json();
    assert.equal(includedAfterHide.total, 1);
    assert.deepEqual(includedAfterHide.items.map((item) => [item.id, item.isHidden]), [['image1', true]]);
    const searchAfterHide = await (await fetch(`${service.url}api/search?q=private%20lantern`)).json();
    assert.equal(searchAfterHide.counts.media, 1);
    const overviewAfterHide = await (await fetch(`${service.url}api/overview`)).json();
    assert.equal(overviewAfterHide.recentMedia.some((item) => item.id === 'image1'), false);
    const showMedia = await (await fetch(`${service.url}api/hidden`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'image1', hidden: false }) })).json();
    assert.equal(showMedia.item.isHidden, false);
    assert.deepEqual(JSON.parse(await readFile(path.join(archive, '.venice-archive/hidden-media.json'), 'utf8')).keys, []);
    const crossSiteFavourite = await fetch(`${service.url}api/favourites`, { method: 'POST', headers: { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body: JSON.stringify({ id: 'image1', favourite: false }) });
    assert.equal(crossSiteFavourite.status, 403);
    const unfavourite = await (await fetch(`${service.url}api/favourites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'image1', favourite: false }) })).json();
    assert.equal(unfavourite.item.isFavourite, false);
    assert.deepEqual(JSON.parse(await readFile(path.join(archive, '.venice-archive/favourites.json'), 'utf8')).keys, []);
    const noFavourites = await (await fetch(`${service.url}api/media?favourites=only`)).json();
    assert.equal(noFavourites.total, 0);
    assert.deepEqual(noFavourites.facets, { all: 0, image: 0, video: 0, audio: 0, file: 0 });
    const conversation = await (await fetch(`${service.url}api/conversations/c1`)).json();
    assert.match(conversation.messages[0].text, /private lantern archive message$/);
    const overview = await (await fetch(`${service.url}api/overview`)).json();
    assert.equal(overview.totals.conversations, 1);
    const crossSiteOpen = await fetch(`${service.url}api/open-location`, { method: 'POST', headers: { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' } });
    assert.equal(crossSiteOpen.status, 403);
    assert.equal(openedDirectory, null);
    const opened = await fetch(`${service.url}api/open-location`, { method: 'POST' });
    assert.equal(opened.status, 200);
    assert.equal(openedDirectory, archive);
    await unlink(path.join(archive, 'media/lantern.png'));
    await symlink(path.join(outside, 'private.txt'), path.join(archive, 'media/lantern.png'));
    assert.equal((await fetch(`${service.url}api/file/imported%20archive/media/lantern.png`)).status, 404);
    assert.equal((await fetch(`${service.url}api/download/image1`)).status, 404);
    await fetch(`${service.url}api/sync`, { method: 'POST', body: '{}' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const sync = await (await fetch(`${service.url}api/sync/status`)).json();
    assert.equal(sync.status, 'complete');
    assert.match(sync.message, /No new content found/);
    assert.deepEqual(sync.result.delta, { conversations: 0, messages: 0, media: 0, unavailableMedia: 0, image: 0, video: 0, audio: 0, file: 0 });
  } finally {
    await new Promise((resolve) => service.server.close(resolve));
  }
});

test('catalog and service use media signatures when legacy filenames are wrong', async () => {
  const archive = await mkdtemp(path.join(os.tmpdir(), 'venice-cli-media-signature-'));
  const mediaDirectory = path.join(archive, 'media');
  await mkdir(path.join(archive, 'indexes'), { recursive: true });
  await mkdir(mediaDirectory, { recursive: true });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]);
  await writeFile(path.join(mediaDirectory, 'legacy.png'), jpeg);
  await writeFile(path.join(archive, 'indexes/conversations.json'), '[]');
  await writeFile(path.join(archive, 'indexes/messages.jsonl'), '');
  await writeFile(path.join(archive, 'indexes/media.json'), JSON.stringify({ items: [
    { mediaId: 'legacy-image', fileName: 'legacy.png', kind: 'image', mimeType: 'image/png', path: 'media/legacy.png', sha256: 'a'.repeat(64) },
    { mediaId: 'missing-image', fileName: 'missing.jpg', kind: 'image', mimeType: 'image/jpeg', path: 'media/missing.jpg' }
  ] }));
  const service = await startArchiveService(archive, { port: 0 });
  try {
    const media = await (await fetch(`${service.url}api/media?uploads=include`)).json();
    assert.equal(media.total, 1);
    assert.equal(media.items[0].fileName, 'legacy.jpg');
    assert.equal(media.items[0].archivedFileName, 'legacy.png');
    assert.equal(media.items[0].mimeType, 'image/jpeg');
    assert.equal(media.items[0].kind, 'image');
    assert.equal(media.items[0].width, 3);
    assert.equal(media.items[0].height, 2);
    assert.equal(media.items[0].formatCorrected, true);
    assert.match(media.items[0].fileUrl, /\?v=/);
    const file = await fetch(new URL(media.items[0].fileUrl, service.url));
    assert.equal(file.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), jpeg);
    const download = await fetch(new URL(media.items[0].downloadUrl, service.url));
    assert.match(download.headers.get('content-disposition'), /legacy\.jpg/);
    const overview = await (await fetch(`${service.url}api/overview`)).json();
    assert.equal(overview.totals.media, 1);
    assert.equal(overview.totals.unavailableMedia, 1);
  } finally {
    await new Promise((resolve) => service.server.close(resolve));
  }
});

test('catalog reuses an existing same-hash file when a legacy dedupe path is missing', async () => {
  const archive = await mkdtemp(path.join(os.tmpdir(), 'venice-cli-media-hash-fallback-'));
  await mkdir(path.join(archive, 'indexes'), { recursive: true });
  await mkdir(path.join(archive, 'media'), { recursive: true });
  await writeFile(path.join(archive, 'media/shared.md'), '# Shared attachment');
  await writeFile(path.join(archive, 'indexes/conversations.json'), '[]');
  await writeFile(path.join(archive, 'indexes/messages.jsonl'), '');
  await writeFile(path.join(archive, 'indexes/media.json'), JSON.stringify({ items: [
    { mediaId: 'canonical', conversationId: 'c1', messageId: 'm1', fileName: 'shared.md', kind: 'file', path: 'media/shared.md', sha256: 'b'.repeat(64) },
    { mediaId: 'legacy-alias', conversationId: 'c2', fileName: 'shared.markdown', kind: 'file', path: 'media/missing.octet-stream', sha256: 'b'.repeat(64), status: 'deduped' }
  ] }));
  const catalog = await new ArchiveCatalog(archive).reload();
  const alias = catalog.media.find((item) => item.id === 'legacy-alias');
  assert.equal(alias.available, true);
  assert.equal(alias.path, 'media/shared.md');
  assert.equal(alias.indexedPath, 'media/missing.octet-stream');
  assert.equal(alias.recoveredByHash, true);
  assert.equal(catalog.overview().totals.unavailableMedia, 0);
});

test('local service refuses non-loopback listeners', async () => {
  const archive = await mkdtemp(path.join(os.tmpdir(), 'venice-cli-listener-'));
  await assert.rejects(
    startArchiveService(archive, { host: '0.0.0.0' }),
    /only listen on a loopback address/
  );
});

test('catalog deduplicates unavailable media references across verified captures', async () => {
  const archive = await mkdtemp(path.join(os.tmpdir(), 'venice-cli-catalog-'));
  for (const name of ['capture-2026-01-01', 'capture-2026-01-02']) {
    const capture = path.join(archive, 'captures', name);
    await mkdir(path.join(capture, 'indexes'), { recursive: true });
    await writeFile(path.join(capture, 'capture.verification.json'), JSON.stringify({ ok: true, verifiedAt: '2026-01-02T00:00:00.000Z' }));
    await writeFile(path.join(capture, 'indexes/conversations.json'), '[]');
    await writeFile(path.join(capture, 'indexes/messages.jsonl'), '');
    await writeFile(path.join(capture, 'indexes/media.json'), JSON.stringify({ items: [{ mediaId: 'missing-1', kind: 'image', status: 'metadata-only', path: null }] }));
  }
  const catalog = await new ArchiveCatalog(archive).reload();
  assert.equal(catalog.overview().totals.unavailableMedia, 1);
});

test('capture verifier checks store counts, hashes, and OPFS sizes', async () => {
  const capture = await mkdtemp(path.join(os.tmpdir(), 'venice-cli-verify-capture-'));
  await mkdir(path.join(capture, 'stores'), { recursive: true });
  await mkdir(path.join(capture, 'opfs'), { recursive: true });
  await writeFile(path.join(capture, 'stores/messages.jsonl'), '{"id":"one"}\n{"id":"two"}\n');
  await writeFile(path.join(capture, 'opfs/image.webp'), 'media-bytes');
  await writeFile(path.join(capture, 'capture.manifest.json'), JSON.stringify({
    runId: 'fixture',
    stores: [{ name: 'messages', path: 'stores/messages.jsonl', records: 2, expectedRecords: 2 }],
    opfs: [{ path: 'media/image.webp', archivedPath: 'opfs/image.webp', size: 11 }]
  }));
  const result = await verifyCapture(capture);
  assert.equal(result.ok, true);
  assert.deepEqual(result.totals, { stores: 1, storeRecords: 2, opfsFiles: 1, opfsBytes: 11 });
  assert.match(result.stores[0].sha256, /^[a-f0-9]{64}$/);
});
