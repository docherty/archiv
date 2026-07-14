import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArchiveCatalog } from '../cli/lib/catalog.mjs';
import { materializeEmbeddedMedia } from '../cli/lib/materialize-media.mjs';

test('embedded originals replace matching thumbnails while unmatched thumbnails remain available', async () => {
  const archive = await mkdtemp(path.join(os.tmpdir(), 'venice-materialized-media-'));
  const capture = path.join(archive, 'captures', 'capture-2026-01-01');
  await mkdir(path.join(capture, 'stores'), { recursive: true });
  await mkdir(path.join(capture, 'indexes'), { recursive: true });
  await mkdir(path.join(capture, 'opfs'), { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(capture, 'stores', 'messageImages.jsonl'), `${JSON.stringify({ messageId: 'm2', contentBinary: png.toString('base64') })}\n`);
  await writeFile(path.join(capture, 'opfs', 'matched.jpg'), 'thumbnail');
  await writeFile(path.join(capture, 'opfs', 'unmatched.jpg'), 'thumbnail');
  await writeFile(path.join(capture, 'capture.verification.json'), JSON.stringify({ ok: true }));
  await writeFile(path.join(capture, 'capture.manifest.json'), JSON.stringify({
    runId: 'capture-2026-01-01',
    stores: [{ name: 'messageImages', path: 'stores/messageImages.jsonl', records: 1, fingerprint: 'message-images-v1' }],
    opfs: [
      { path: 'thumbnails/c1_m2_v0_thumb.jpg', fileName: 'c1_m2_v0_thumb.jpg', archivedPath: 'opfs/matched.jpg', size: 9, mimeType: 'image/jpeg' },
      { path: 'thumbnails/c9_other_thumb.jpg', fileName: 'c9_other_thumb.jpg', archivedPath: 'opfs/unmatched.jpg', size: 9, mimeType: 'image/jpeg' }
    ]
  }));
  await writeFile(path.join(capture, 'indexes', 'conversations.json'), JSON.stringify([{ id: 'c1', title: 'Image conversation' }]));
  await writeFile(path.join(capture, 'indexes', 'messages.jsonl'), [
    JSON.stringify({ id: 'm1', conversationId: 'c1', role: 'user', text: 'Create this' }),
    JSON.stringify({ id: 'm2', conversationId: 'c1', role: 'assistant', text: 'Create this' })
  ].join('\n'));
  await writeFile(path.join(capture, 'indexes', 'media.json'), JSON.stringify({ items: [
    { mediaId: 'm2', messageId: 'm2', source: 'messageImages', kind: 'image', path: null },
    { mediaId: 'matched-thumb', path: 'opfs/matched.jpg', fileName: 'c1_m2_v0_thumb.jpg', source: 'opfs', kind: 'image' },
    { mediaId: 'unmatched-thumb', path: 'opfs/unmatched.jpg', fileName: 'c9_other_thumb.jpg', source: 'opfs', kind: 'image' }
  ] }));

  const result = await materializeEmbeddedMedia(archive);
  assert.equal(result.added, 1);
  assert.equal(result.payloads, 1);
  const catalog = await new ArchiveCatalog(archive).reload();
  assert.deepEqual(catalog.media.map((item) => item.fileName).sort(), ['c1_m2.png', 'c9_other_thumb.jpg']);
  const original = catalog.media.find((item) => item.fileName === 'c1_m2.png');
  assert.equal(original.width, 1);
  assert.equal(original.height, 1);
  assert.equal(original.bytes, png.length);
  assert.equal(original.conversationId, 'c1');
  assert.equal(original.messageId, 'm2');
  assert.equal(catalog.media.some((item) => item.fileName === 'c1_m2_v0_thumb.jpg'), false);
  assert.deepEqual(catalog.listMedia(new URLSearchParams()).items.map((item) => item.fileName), ['c1_m2.png']);
  assert.deepEqual(catalog.listMedia(new URLSearchParams('thumbnails=include')).items.map((item) => item.fileName).sort(), ['c1_m2.png', 'c9_other_thumb.jpg']);
  assert.equal(catalog.overview().totals.media, 1);
  assert.equal((await materializeEmbeddedMedia(archive)).mode, 'up-to-date');
  const manifest = await readFile(path.join(archive, 'materialized-media', 'materialization.manifest.json'), 'utf8');
  assert.doesNotMatch(manifest, new RegExp(archive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
