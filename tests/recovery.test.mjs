import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ArchiveCatalog } from '../cli/lib/catalog.mjs';
import { correctMediaFileExtension } from '../cli/lib/media-bytes.mjs';
import { decryptLegacyRecord, detectMedia, loadVendoredNacl, recoverLegacyContent } from '../cli/lib/recovery.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function encryptedRecord(nacl, key, outer, inner, nonceSeed = 1) {
  const nonce = Uint8Array.from({ length: 24 }, (_, index) => (nonceSeed + index) % 256);
  const message = new TextEncoder().encode(JSON.stringify(inner));
  const ciphertext = nacl.secretbox(message, nonce, key);
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce);
  combined.set(ciphertext, nonce.length);
  return { ...outer, __encryptedData: Object.fromEntries([...combined].map((value, index) => [index, value])) };
}

test('legacy recovery decrypts, materializes, and remains idempotent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'venice-recovery-'));
  const archive = path.join(root, 'archive');
  const backup = path.join(root, 'legacy.json');
  const nacl = await loadVendoredNacl(projectRoot);
  const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const document = {
    version: '1.0.0',
    keyVault: { fixture: { keyString: [...key].join(',') } },
    data: {
      conversations: [encryptedRecord(nacl, key, { id: 'c1', createdAtUnixTimestamp: 1_700_000_000_000 }, { title: 'Recovered fixture', type: 'image' }, 1)],
      messages: [
        encryptedRecord(nacl, key, { id: 'm1', conversationId: 'c1', createdAtUnixTimestamp: 1_700_000_000_100 }, { role: 'user', content: 'Make an image' }, 2),
        encryptedRecord(nacl, key, { id: 'm2', conversationId: 'c1', createdAtUnixTimestamp: 1_700_000_000_200 }, { role: 'assistant', model: 'fixture-model', content: 'Make an image' }, 3)
      ],
      images: [encryptedRecord(nacl, key, { messageId: 'm2' }, { contentBinary: png.toString('base64'), mimeType: 'image/png' }, 4)]
    }
  };
  await writeFile(backup, JSON.stringify(document));

  const dryRun = await recoverLegacyContent({ archive, backups: [backup], apply: false, projectRoot });
  assert.deepEqual(dryRun.additions, { conversations: 1, messages: 2, media: 1, bytes: png.length });
  const applied = await recoverLegacyContent({ archive, backups: [backup], apply: true, projectRoot });
  assert.equal(applied.mode, 'applied');
  const catalog = await new ArchiveCatalog(archive).reload();
  assert.equal(catalog.conversations.length, 1);
  assert.equal(catalog.messages.length, 2);
  assert.equal(catalog.media.filter((item) => item.available).length, 1);
  assert.equal(catalog.conversation('c1').media[0].prompt, 'Make an image');
  assert.deepEqual((await recoverLegacyContent({ archive, backups: [backup], apply: false, projectRoot })).additions, {
    conversations: 0, messages: 0, media: 0, bytes: 0
  });
});

test('recovery messages can complete a conversation from a verified capture', async () => {
  const archive = await mkdtemp(path.join(os.tmpdir(), 'venice-recovery-catalog-'));
  const capture = path.join(archive, 'captures', 'capture-2026-01-01');
  const recovered = path.join(archive, 'recovered-content', 'indexes');
  await mkdir(path.join(capture, 'indexes'), { recursive: true });
  await mkdir(recovered, { recursive: true });
  await writeFile(path.join(capture, 'capture.verification.json'), JSON.stringify({ ok: true }));
  await writeFile(path.join(capture, 'indexes', 'conversations.json'), JSON.stringify([{ id: 'c1', title: 'Existing' }]));
  await writeFile(path.join(capture, 'indexes', 'messages.jsonl'), `${JSON.stringify({ id: 'm1', conversationId: 'c1', role: 'user', text: 'First' })}\n`);
  await writeFile(path.join(capture, 'indexes', 'media.json'), JSON.stringify({ items: [] }));
  await writeFile(path.join(recovered, 'conversations.json'), '[]');
  await writeFile(path.join(recovered, 'messages.jsonl'), `${JSON.stringify({ id: 'm2', conversationId: 'c1', role: 'assistant', text: 'Recovered reply' })}\n`);
  await writeFile(path.join(recovered, 'media.json'), JSON.stringify({ items: [] }));
  const catalog = await new ArchiveCatalog(archive).reload();
  assert.deepEqual(catalog.conversation('c1').messages.map((item) => item.id), ['m1', 'm2']);
});

test('media detection prefers file signatures', () => {
  assert.equal(correctMediaFileExtension('Screenshot 2026-07-08 at 11.34.14.png', '.png'), 'Screenshot 2026-07-08 at 11.34.14.png');
  assert.equal(correctMediaFileExtension('image-to-edit.png', '.jpg'), 'image-to-edit.jpg');
  assert.deepEqual(detectMedia(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'wrong.bin'), {
    extension: '.png', mimeType: 'image/png', kind: 'image'
  });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]);
  assert.deepEqual(detectMedia(jpeg, 'incorrect.png'), {
    extension: '.jpg', mimeType: 'image/jpeg', kind: 'image', width: 3, height: 2
  });
  const m4a = Buffer.from('0000001c667479704d344120000000004d34412069736f6d6d703432', 'hex');
  assert.deepEqual(detectMedia(m4a, 'recording.m4a'), {
    extension: '.m4a', mimeType: 'audio/mp4', kind: 'audio'
  });
  const avif = Buffer.from('00000018667479706176696600000000617669666d696631', 'hex');
  assert.deepEqual(detectMedia(avif, 'incorrect.mp4'), {
    extension: '.avif', mimeType: 'image/avif', kind: 'image'
  });
});

test('legacy decryption rejects a wrong key', async () => {
  const nacl = await loadVendoredNacl(projectRoot);
  const key = new Uint8Array(32).fill(7);
  const record = encryptedRecord(nacl, key, { id: 'fixture' }, { title: 'Private' });
  assert.throws(() => decryptLegacyRecord(record, [new Uint8Array(32).fill(8)], nacl), /could not be decrypted/);
});
