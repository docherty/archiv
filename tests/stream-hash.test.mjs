import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

await import('../extension/lib/stream-hash.js');

const { IncrementalSha256 } = globalThis.VeniceStreamHash;

test('IncrementalSha256 matches standard SHA-256 across chunk boundaries', () => {
  const text = 'The quick brown fox jumps over the lazy dog'.repeat(4097);
  const bytes = new TextEncoder().encode(text);
  const expected = createHash('sha256').update(bytes).digest('hex');
  const hasher = new IncrementalSha256();
  for (let offset = 0; offset < bytes.length; offset += 13) {
    hasher.update(bytes.subarray(offset, Math.min(offset + 13, bytes.length)));
  }
  assert.equal(hasher.digestHex(), expected);
});

test('IncrementalSha256 handles empty input', () => {
  const hasher = new IncrementalSha256();
  assert.equal(hasher.digestHex(), createHash('sha256').update('').digest('hex'));
});
