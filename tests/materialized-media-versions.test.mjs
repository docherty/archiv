import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { materializeEmbeddedMedia } from '../cli/lib/materialize-media.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function capture(root, day, payload) {
  const id = `capture-2026-01-0${day}T00-00-00-000Z`;
  const folder = path.join(root, 'captures', id);
  await mkdir(path.join(folder, 'stores'), { recursive: true });
  await mkdir(path.join(folder, 'indexes'));
  const record = JSON.stringify({ id: 'same-record', messageId: 'same-message', contentBinary: payload });
  await writeFile(path.join(folder, 'stores/images.jsonl'), `${record}\n`);
  await writeFile(path.join(folder, 'indexes/messages.jsonl'), '');
  await writeFile(path.join(folder, 'capture.manifest.json'), JSON.stringify({ runId: id,
    stores: [{ name: 'messageImages', path: 'stores/images.jsonl', records: 1, fingerprint: sha(record) }], opfs: [] }));
  await writeFile(path.join(folder, 'capture.verification.json'), JSON.stringify({ ok: true }));
}

const first = Buffer.concat([png, Buffer.alloc(32768 - png.length)]);
const changed = Buffer.from(first);
changed[12000] = 17; // Exact original-file bytes matter, including opaque trailing data.
const together = Buffer.concat([first, changed]).toString('base64');
const forms = [
  ['base64', first.toString('base64'), changed.toString('base64')],
  ['byte-array', [...first], [...changed]],
  ['numeric-object', { ...first }, { ...changed }],
  ['encoded-view', { encoded: together, byteOffset: 0, length: first.length },
    { encoded: together, byteOffset: first.length, length: changed.length }]
];

for (const [name, originalPayload, changedPayload] of forms) {
  test(`materialization retains changed same-ID ${name} versions even when length/edges match`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'archiv-media-versions-'));
    try {
      await capture(root, 1, originalPayload);
      assert.equal((await materializeEmbeddedMedia(root)).added, 1);
      await capture(root, 2, changedPayload);
      assert.equal((await materializeEmbeddedMedia(root)).added, 1);
      const index = JSON.parse(await readFile(path.join(root, 'materialized-media/indexes/media.json')));
      assert.equal(index.items.length, 2);
      for (const bytes of [first, changed]) {
        const item = index.items.find(value => value.sha256 === sha(bytes));
        assert.ok(item);
        assert.deepEqual(await readFile(path.join(root, 'materialized-media', item.path)), bytes);
      }
      assert.equal((await materializeEmbeddedMedia(root)).mode, 'up-to-date');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const damage of ['intact', 'missing', 'corrupt']) {
  test(`same-byte materialization reuses one version and verifies/repairs an ${damage} object`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'archiv-media-reuse-'));
    try {
      await capture(root, 1, first.toString('base64'));
      await materializeEmbeddedMedia(root);
      const indexPath = path.join(root, 'materialized-media/indexes/media.json');
      const previous = JSON.parse(await readFile(indexPath));
      const object = path.join(root, 'materialized-media', previous.items[0].path);
      if (damage === 'missing') await rm(object);
      if (damage === 'corrupt') await writeFile(object, 'not the original bytes');
      await capture(root, 2, [...first]); // Different representation, identical decoded bytes.
      assert.equal((await materializeEmbeddedMedia(root)).added, 0);
      assert.equal(JSON.parse(await readFile(indexPath)).items.length, 1);
      assert.deepEqual(await readFile(object), first);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
