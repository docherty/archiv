import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile('extension/content-main.js', 'utf8');
const start = source.indexOf('  async function captureRecordSetFingerprint(');
const end = source.indexOf('  function reportInventoryProgress(', start);
assert.ok(start >= 0 && end > start);
const fingerprint = vm.runInNewContext(`${source.slice(start, end)}; captureRecordSetFingerprint;`);

// Original record-fnv-v1 algorithm, retained as a compatibility oracle.
async function reference(records, encode = null) {
  const list = Array.isArray(records) ? records : [];
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (const record of list) {
    const value = `${JSON.stringify(encode ? await encode(record) : record)}\u0000`;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      h1 ^= code & 0xff;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h1 ^= code >>> 8;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 ^= (code + index) & 0xff;
      h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
      h2 ^= (code + index) >>> 8;
      h2 = Math.imul(h2, 0xc2b2ae35) >>> 0;
    }
  }
  return `record-fnv-v1-${list.length}-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

test('optimized fingerprint exactly preserves v1 across Unicode and record boundaries', async () => {
  const fixtures = [null, [], [null], [{ text: 'ascii' }],
    [{ text: '日本語😀\u0000\ud800\uffff' }, { id: 2, values: [false, 1, null] }],
    Array.from({ length: 80 }, (_, index) => ({ index, text: String.fromCharCode(index * 797) }))];
  for (const records of fixtures) assert.equal(await fingerprint(records), await reference(records));
});

test('optimized fingerprint retains async transport normalization', async () => {
  const encode = async value => ({ encoded: value });
  const records = ['😀', 'message', 42];
  assert.equal(await fingerprint(records, encode), await reference(records, encode));
});

test('large fingerprints remain compatible and detect in-place edits and ordering', async () => {
  const records = [{ id: 1, text: 'abc😀'.repeat(256 * 1024) }, { id: 2, text: 'tail' }];
  const original = await fingerprint(records);
  assert.equal(original, await reference(records));
  assert.notEqual(original, await fingerprint([...records].reverse()));
  records[1].text = 'edit';
  assert.notEqual(original, await fingerprint(records));
});
