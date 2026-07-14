import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

function makeBackupRuntime() {
  const element = () => ({
    addEventListener() {},
    querySelectorAll() { return []; },
    focus() {},
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
    checked: false,
    value: '',
    textContent: '',
    innerHTML: '',
    hidden: false
  });
  const context = {
    document: {
      getElementById: element,
      querySelector: element,
      querySelectorAll() { return []; },
      addEventListener() {},
      body: { style: {} }
    },
    window: { addEventListener() {}, scrollTo() {} },
    chrome: {},
    location: { href: 'https://venice.ai/chat', pathname: '/chat' },
    Blob,
    ArrayBuffer,
    Uint8Array,
    TextEncoder,
    TextDecoder,
    URL,
    Date,
    Map,
    Set,
    WeakSet,
    atob,
    btoa,
    console,
    fetch: async () => { throw new Error('fetch not expected for embedded media'); }
  };
  context.globalThis = context;
  return context;
}

async function loadBackupRuntime() {
  const source = (await readFile('extension/backup.js', 'utf8')).replace(/\ninit\(\);\s*$/, '\n');
  const context = makeBackupRuntime();
  vm.runInNewContext(source, context, { filename: 'backup.js' });
  return context;
}

function blobTransport(bytes, mimeType) {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return {
    __veniceArchiveType: 'blob',
    encoding: 'base64',
    mimeType,
    size: bytes.length,
    data: btoa(binary)
  };
}

test('generic source-store Blob records become gallery media', async () => {
  const runtime = await loadBackupRuntime();
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]);
  const fullData = {
    conversations: [{ id: 'c1', title: 'Chat' }],
    messages: [],
    settings: [],
    extraStores: {
      'rxdb-physical:messages-1-attachments': [{
        id: 'asset-1',
        conversationId: 'c1',
        data: blobTransport(bytes, 'image/png')
      }]
    }
  };

  const bundle = runtime.buildMediaGalleryItems(fullData);
  assert.equal(bundle.items.length, 1);
  assert.equal(bundle.items[0].kind, 'image');
  const blob = await runtime.buildMediaBlobFromItem(bundle.items[0], fullData, null);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
});

test('message attachment Blob wrappers remain materializable', async () => {
  const runtime = await loadBackupRuntime();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const fullData = {
    conversations: [{ id: 'c1', title: 'Chat' }],
    messages: [{
      id: 'm1',
      conversationId: 'c1',
      attachments: [{ id: 'a1', mimeType: 'application/octet-stream', data: blobTransport(bytes, 'application/octet-stream') }]
    }],
    settings: [],
    messageImages: []
  };

  const bundle = runtime.buildMediaGalleryItems(fullData);
  assert.equal(bundle.items.length, 1);
  const blob = await runtime.buildMediaBlobFromItem(bundle.items[0], fullData, null);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
});

test('structured media records skip metadata data objects before Blob fields', async () => {
  const runtime = await loadBackupRuntime();
  const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x57, 0x45, 0x42, 0x50]);
  const fullData = {
    conversations: [{ id: 'c1', title: 'Chat' }],
    messages: [],
    settings: [],
    messageImages: [{
      id: 'image-1',
      conversationId: 'c1',
      data: { width: 640, height: 480 },
      blob: blobTransport(bytes, 'image/webp')
    }]
  };

  const bundle = runtime.buildMediaGalleryItems(fullData);
  assert.equal(bundle.items.length, 1);
  assert.equal(bundle.items[0].mimeType, 'image/webp');
  const blob = await runtime.buildMediaBlobFromItem(bundle.items[0], fullData, null);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
});

test('text attachment results are archived as UTF-8 bytes instead of sent to atob', async () => {
  const runtime = await loadBackupRuntime();
  const text = 'A recovered document with curly quotes: “ready to archive”.';
  const fullData = {
    conversations: [{ id: 'c1', title: 'Chat' }],
    messages: [{
      id: 'm1',
      conversationId: 'c1',
      attachments: [{
        id: 'a1',
        fileName: 'proposal.pdf',
        type: 'Text',
        result: text
      }]
    }],
    settings: [],
    messageImages: []
  };

  const bundle = runtime.buildMediaGalleryItems(fullData);
  assert.equal(bundle.items.length, 1);
  assert.equal(bundle.items[0].mimeType, 'text/plain');
  assert.match(bundle.items[0].localPath, /\.txt$/);
  const blob = await runtime.buildMediaBlobFromItem(bundle.items[0], fullData, null);
  assert.equal(await blob.text(), text);
});

test('encrypted and invalid data-URI fields are not misclassified as media', async () => {
  const runtime = await loadBackupRuntime();
  const fullData = {
    conversations: [],
    messages: [],
    settings: [],
    extraStores: {
      'rxdb-physical:mindMessages-16-documents': [{
        id: 'opaque-1',
        opaque_provider_data: '__ENCRYPTED_REASONING__abc123+/=',
        dataUrl: 'data:application/zip;base92,not-really-base64'
      }]
    }
  };

  const bundle = runtime.buildMediaGalleryItems(fullData);
  assert.equal(bundle.items.length, 0);
});

test('OPFS media with a Studio record id covers the pathless Studio placeholder', async () => {
  const runtime = await loadBackupRuntime();
  const archive = {
    stats: {},
    mediaIndex: {
      totals: {},
      items: [{
        id: 'studio-image-1',
        kind: 'image',
        source: 'studio.image.turnMedia.embedded',
        sourceStore: 'studioImageTurnMedia',
        mimeType: 'image/png',
        inline: false,
        orphaned: false
      }]
    }
  };
  const indexes = runtime.buildRepositoryIndexes(archive, [], [{
    mediaId: 'sha256:abc',
    source: 'opfs',
    sourceRecordId: 'studio-image-1',
    path: 'media/sha256/ab/abc.png',
    sha256: 'abc',
    status: 'materialized',
    kind: 'image',
    mimeType: 'image/png'
  }, {
    mediaId: 'studio-image-1',
    source: 'studio.image.turnMedia.embedded',
    sourceRecordId: 'studio-image-1',
    status: 'failed',
    kind: 'image'
  }]);

  assert.equal(indexes.unresolvedMedia.length, 0);
  assert.equal(indexes.media.items.length, 1);
  assert.equal(indexes.media.items[0].source, 'opfs');
});

test('captured original URLs remain references rather than false unresolved records', async () => {
  const runtime = await loadBackupRuntime();
  const indexes = runtime.buildRepositoryIndexes({
    stats: {},
    mediaIndex: {
      totals: {},
      items: [{
        id: 'citation-1',
        kind: 'file',
        source: 'search.reference',
        originalUrl: 'https://example.com/reference.pdf',
        status: 'failed'
      }]
    }
  }, [], []);

  assert.equal(indexes.unresolvedMedia.length, 0);
  assert.equal(indexes.media.items[0].originalUrl, 'https://example.com/reference.pdf');
});

test('message-level media coverage closes generic pathless image placeholders', async () => {
  const runtime = await loadBackupRuntime();
  const indexes = runtime.buildRepositoryIndexes({
    stats: {},
    mediaIndex: {
      totals: {},
      items: [{
        id: 'message-image-1',
        kind: 'image',
        source: 'messageImages',
        messageId: 'message-1',
        conversationId: 'conversation-1'
      }]
    }
  }, [], [{
    mediaId: 'sha256:image-1',
    source: 'messageImages',
    sourceRecordId: 'remote-image-id',
    messageId: 'message-1',
    conversationId: 'conversation-1',
    path: 'media/sha256/im/image.png',
    sha256: 'image-1',
    status: 'materialized',
    kind: 'image',
    mimeType: 'image/png'
  }]);

  assert.equal(indexes.unresolvedMedia.length, 0);
  assert.equal(indexes.media.items.length, 1);
  assert.equal(indexes.media.items[0].sourceRecordId, 'remote-image-id');
});

test('generic source stores do not treat web-search PDF citations as attachments', async () => {
  const runtime = await loadBackupRuntime();
  const citationData = {
    conversations: [],
    messages: [],
    settings: [],
    extraStores: {
      'rxdb-physical:mindMessages-16-documents': [{
        id: 'search-1',
        sources: [{ url: 'https://example.com/reference.pdf', title: 'Reference' }]
      }]
    }
  };
  assert.equal(runtime.buildMediaGalleryItems(citationData).items.length, 0);

  const attachmentData = {
    ...citationData,
    extraStores: {
      'future-content-db.binaryAssets': [{
        id: 'asset-1',
        fileName: 'reference.pdf',
        url: 'https://example.com/reference.pdf'
      }]
    }
  };
  assert.equal(runtime.buildMediaGalleryItems(attachmentData).items.length, 1);
});

test('package instructions make full-first and same-folder diff application explicit', async () => {
  const runtime = await loadBackupRuntime();
  const rootManifest = { archiveId: 'archive-1' };
  const fullReadme = runtime.buildRepositoryPackageReadme({
    exportId: 'export-full',
    diffOnly: false,
    rootManifest
  });
  assert.match(fullReadme, /first\/full package/i);
  assert.match(fullReadme, /private archive folder/i);
  assert.match(fullReadme, /incremental package mode/i);
  assert.match(fullReadme, /Apply to this archive/i);

  const diffReadme = runtime.buildRepositoryPackageReadme({
    exportId: 'export-diff',
    diffOnly: true,
    rootManifest
  });
  assert.match(diffReadme, /incremental package/i);
  assert.match(diffReadme, /same folder/i);
  assert.match(diffReadme, /not a standalone archive/i);
  assert.match(diffReadme, /Apply to this archive/i);
});

test('generated archive viewer contains valid search and filter controls', async () => {
  const runtime = await loadBackupRuntime();
  const viewerBlob = runtime.buildRepositoryViewerHtml({
    rootManifest: { verification: { status: 'verified', warnings: [] }, totals: {} },
    exportManifest: {},
    indexes: {
      conversations: [],
      messagesJsonl: new Blob(['']),
      media: { totals: {}, items: [] },
      unresolvedMedia: [],
      viewerData: { conversations: [], messages: [], media: { totals: {}, items: [] } }
    }
  });
  const html = await viewerBlob.text();
  assert.match(html, /id="kindFilter"/);
  assert.match(html, /id="mediaSearchInput"/);
  assert.match(html, /id="mediaSourceFilter"/);
  assert.match(html, /id="maintenanceCard"/);
  assert.match(html, /id="applyPackageBtn"/);
  assert.match(html, /parseStoredPackage/);
  assert.match(html, /venice-archive\.manifest\.json/);
  assert.match(html, /Search conversations, messages, files/);
  const script = html.match(/<script>\n([\s\S]*)\n  <\/script>/)?.[1];
  assert.ok(script);
  new vm.Script(script, { filename: 'viewer.js' });

  const viewerContext = makeBackupRuntime();
  vm.runInNewContext(script, viewerContext, { filename: 'viewer.js' });
  const zip = await runtime.buildStoredZip([
    { path: 'PACKAGE-README.txt', data: 'Mode: full (complete repository files for this export)\n' },
    { path: 'viewer/index.html', data: '<!doctype html>' },
    { path: 'venice-archive.manifest.json', data: JSON.stringify({ archiveId: 'archive-test', schemaVersion: '1.0.0' }) }
  ]);
  const parsed = await viewerContext.parseStoredPackage(zip);
  assert.equal(parsed.mode, 'full');
  assert.equal(parsed.manifest.archiveId, 'archive-test');
  assert.equal(parsed.entries.at(-1).path, 'venice-archive.manifest.json');
});
