import assert from 'node:assert/strict';
import test from 'node:test';

await import('../extension/lib/studio-transform.js');

const transform = globalThis.VeniceStudioTransform;

test('deriveVideoStudioLocalState parses content-bearing Studio queues', () => {
  const records = transform.deriveVideoStudioLocalState([
    {
      key: 'video-studio-active-generations',
      redacted: false,
      value: JSON.stringify([
        { id: 'active-1', prompt: 'cinematic fox', downloadUrl: 'https://cdn.example/video.mp4' }
      ])
    },
    {
      key: 'video-studio-pending-generations',
      redacted: false,
      value: JSON.stringify({ id: 'pending-1', inputFileUrl: 'opfs-input-video:c1|a1|video/mp4' })
    },
    { key: 'unrelated', redacted: false, value: JSON.stringify([{ id: 'ignore' }]) }
  ]);

  assert.equal(records.length, 2);
  assert.equal(records[0].id, 'active-1');
  assert.equal(records[0].__localStorageKey, 'video-studio-active-generations');
  assert.equal(records[0].__localStorageIndex, 0);
  assert.equal(records[1].id, 'pending-1');
});

test('deriveVideoStudioLocalState ignores malformed and redacted values', () => {
  assert.deepEqual(transform.deriveVideoStudioLocalState([
    { key: 'video-studio-failed-generations', redacted: true, value: '[{"id":"secret"}]' },
    { key: 'video-studio-failed-generations', redacted: false, value: 'not-json' },
    { key: 'video-studio-failed-generations', redacted: false, value: 'null' }
  ]), []);
});
