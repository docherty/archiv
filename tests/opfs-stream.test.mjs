import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { writeOpfs } from '../cli/lib/extract.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
test('OPFS uses supported bounded 4 MiB chunks, writes exact bytes and handles empty files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archiv-opfs-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 123);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  let calls = 0;
  const client = { async evaluate(expression) {
    const match = expression.match(/"path":"([^"]+)","offset":(\d+),"chunkSize":(\d+)/);
    assert.ok(match); assert.equal(Number(match[3]), 4 * 1024 * 1024);
    const data = match[1] === 'media/empty' ? Buffer.alloc(0) : bytes;
    const offset = Number(match[2]); const end = Math.min(data.length, offset + Number(match[3]));
    calls++;
    return { success: true, offset, nextOffset: end, sizeBytes: data.length, chunkBytes: end - offset, chunkBase64: data.subarray(offset, end).toString('base64'), done: end === data.length };
  } };
  const results = await writeOpfs(client, root, [{ path: 'media/video.mp4', size: bytes.length }, { path: 'media/empty', size: 0 }], () => {});
  assert.equal(calls, 3);
  assert.equal(hash(await readFile(path.join(root, results[0].archivedPath))), hash(bytes));
  assert.equal((await stat(path.join(root, results[0].archivedPath))).mode & 0o777, 0o600);
  assert.equal((await readFile(path.join(root, results[1].archivedPath))).length, 0);
});

test('OPFS rejects nonadvancing, truncated, oversized and inconsistent chunks before success', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archiv-opfs-bounds-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const good = { success: true, offset: 0, nextOffset: 1, sizeBytes: 1, chunkBytes: 1, chunkBase64: 'YQ==', done: true };
  for (const [index, change] of [{ nextOffset: 0 }, { done: false }, { offset: 9 }, { sizeBytes: 2 }, { chunkBytes: 0 }].entries()) {
    await assert.rejects(writeOpfs({ evaluate: async () => ({ ...good, ...change }) }, path.join(root, String(index)), [{ path: 'media/file', size: 1 }], () => {}), /Invalid OPFS chunk bounds/);
  }
  const oversized = Buffer.alloc(4 * 1024 * 1024 + 1);
  await assert.rejects(writeOpfs({ evaluate: async () => ({ ...good, sizeBytes: oversized.length, nextOffset: oversized.length, chunkBytes: oversized.length, chunkBase64: oversized.toString('base64') }) }, path.join(root, 'oversized'), [{ path: 'media/file', size: oversized.length }], () => {}), /Invalid OPFS chunk bounds/);
  await assert.rejects(writeOpfs({ evaluate: async () => ({ ...good, success: false, error: 'disk read failed' }) }, path.join(root, 'failed'), [{ path: 'media/file', size: 1 }], () => {}), /disk read failed/);
});
