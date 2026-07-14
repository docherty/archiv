import assert from 'node:assert/strict';
import test from 'node:test';

await import('../extension/lib/archive-coverage.js');

const coverage = globalThis.VeniceArchiveCoverage;

test('buildArchiveStoreRequests appends every newly discovered Venice store', () => {
  const requests = coverage.buildArchiveStoreRequests([
    { name: 'conversations', dataKey: 'conversations', optional: false }
  ], [
    { name: 'conversations', count: 2, source: 'legacy' },
    { name: 'futureStudioAssets', count: 4, source: 'legacy' },
    { name: 'rxdb:newCollection', count: 3, source: 'rxdb' }
  ]);

  assert.deepEqual(requests.map((request) => request.name), [
    'conversations',
    'futureStudioAssets',
    'rxdb:newCollection'
  ]);
  assert.equal(requests[1].optional, false);
  assert.equal(requests[1].discovered, true);
  assert.equal(requests[2].sourceStoreName, 'rxdb:newCollection');
});

test('source-store map is available to writers but omitted from compatibility JSON', () => {
  const target = { conversations: [{ id: 'c1' }] };
  const stores = {
    conversations: { name: 'conversations', records: target.conversations }
  };

  coverage.attachSourceStores(target, stores);

  assert.equal(coverage.getSourceStores(target), stores);
  assert.equal(Object.keys(target).includes(coverage.SOURCE_STORES_PROPERTY), false);
  assert.doesNotMatch(JSON.stringify(target), /veniceArchiveSourceStores/);
});

test('buildSourceStorePath cannot turn hostile names into traversal paths', () => {
  assert.match(coverage.buildSourceStorePath('..'), /^stores\/store--\.\.--[a-f0-9]{8}\.json$/);
  assert.match(coverage.buildSourceStorePath('rxdb:new/media'), /^stores\/store--rxdb-new-media--[a-f0-9]{8}\.json$/);
  assert.doesNotMatch(coverage.buildSourceStorePath('../../outside'), /\.\.\//);
  assert.notEqual(coverage.buildSourceStorePath('rxdb:new/media'), coverage.buildSourceStorePath('rxdb-new-media'));
});

test('source-store manifest records retain missing historical stores as tombstones', () => {
  const records = coverage.buildSourceStoreManifestRecords([
    {
      name: 'messages',
      source: 'legacy',
      count: 5,
      sha256: 'abc',
      payloadBytes: 100,
      path: 'stores/store--messages.json'
    }
  ], {
    messages: { status: 'active', sha256: 'old' },
    retiredStudioStore: { status: 'active', path: 'stores/store--retiredStudioStore.json' }
  }, '2026-07-10T12:00:00.000Z');

  assert.equal(records.messages.status, 'active');
  assert.equal(records.messages.count, 5);
  assert.equal(records.retiredStudioStore.status, 'tombstoned');
  assert.equal(records.retiredStudioStore.tombstonedAt, '2026-07-10T12:00:00.000Z');
});
