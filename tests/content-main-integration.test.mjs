import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';

class FakeWindow {
  constructor() {
    this.listeners = new Map();
    this.location = { href: 'https://venice.ai/chat', pathname: '/chat' };
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter((candidate) => candidate !== listener));
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    return true;
  }
}

class FakeCustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}

function makeStorage(initial = {}) {
  const storage = {
    getItem(key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
    setItem(key, value) { storage[key] = String(value); },
    removeItem(key) { delete storage[key]; },
    key(index) { return Object.keys(storage).filter((key) => typeof storage[key] === 'string')[index] || null; }
  };
  Object.defineProperty(storage, 'length', {
    enumerable: false,
    get() { return Object.keys(storage).filter((key) => typeof storage[key] === 'string').length; }
  });
  Object.entries(initial).forEach(([key, value]) => { storage[key] = String(value); });
  return storage;
}

function makeRequest(result) {
  const request = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
  setTimeout(() => {
    request.result = result;
    request.onsuccess?.({ target: request });
  }, 0);
  return request;
}

function makeFakeIndexedDb(databases) {
  const descriptors = Object.entries(databases).map(([name, data]) => ({
    name,
    version: data.version || 1
  }));

  const makeDb = (name, data) => {
    const storeNames = Object.keys(data.stores);
    const objectStoreNames = [...storeNames];
    objectStoreNames.contains = (storeName) => storeNames.includes(storeName);
    return {
      name,
      version: data.version || 1,
      objectStoreNames,
      close() {},
      transaction(names) {
        return {
          objectStore(storeName) {
            return {
              getAll: () => makeRequest(data.stores[storeName] || [])
            };
          }
        };
      }
    };
  };

  return {
    databases: async () => descriptors,
    open(name) {
      const request = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      setTimeout(() => {
        const data = databases[name];
        if (!data) {
          request.error = new Error(`Missing fake database ${name}`);
          request.onerror?.({ target: request });
          return;
        }
        request.result = makeDb(name, data);
        request.onsuccess?.({ target: request });
      }, 0);
      return request;
    }
  };
}

async function createRuntime() {
  const window = new FakeWindow();
  const document = {
    readyState: 'loading',
    visibilityState: 'hidden',
    addEventListener() {},
    querySelectorAll() { return []; },
    title: 'Venice test'
  };
  const databases = {
    'venice-db-encrypted': {
      version: 30,
      stores: {
        conversations: [{ id: 'legacy-c1' }],
        messages: [{ id: 'legacy-m1', conversationId: 'legacy-c1', content: 'legacy' }]
      }
    },
    'venice-rx-db-encrypted': {
      version: 7,
      stores: {
        'conversations-1-documents': [{ i: 'rx-c1', d: { id: 'rx-c1', name: 'Current chat' } }],
        'messages-1-documents': [{ i: 'rx-m1', d: { id: 'rx-m1', conversationId: 'rx-c1', content: 'current' } }],
        'messages-1-attachments': [{ docIdWithAttachmentId: 'rx-m1|file-1', data: 'raw-attachment' }]
      }
    },
    'video-studio-recovery': {
      version: 1,
      stores: {
        activeGenerations: [{ id: 'generation-1', prompt: 'test video' }]
      }
    },
    'future-content-db': {
      version: 2,
      stores: {
        savedDrafts: [{ id: 'draft-1', text: 'future content' }],
        binaryAssets: [{ id: 'asset-1', mimeType: 'image/png', blob: new Blob([new Uint8Array(4096)], { type: 'image/png' }) }]
      }
    }
  };
  const context = {
    window,
    document,
    location: window.location,
    CustomEvent: FakeCustomEvent,
    indexedDB: makeFakeIndexedDb(databases),
    localStorage: makeStorage({ encryptionKey: Array.from({ length: 32 }, (_, index) => index).join(',') }),
    sessionStorage: makeStorage({ draft: 'recoverable' }),
    navigator: { storage: {} },
    crypto: webcrypto,
    Blob,
    ArrayBuffer,
    Uint8Array,
    Map,
    Set,
    Date,
    WeakSet,
    TextEncoder,
    TextDecoder,
    URL,
    atob,
    btoa,
    setTimeout,
    clearTimeout,
    console
  };
  context.globalThis = context;
  vm.runInNewContext(await readFile('extension/content-main.js', 'utf8'), context, { filename: 'content-main.js' });
  return { window, context };
}

function dispatchCommand(window, type, data = {}) {
  const protocol = '2026-07-store-api-v12-tab-handoff';
  const responseEvent = `venice-sync-from-page:${protocol}`;
  const commandEvent = `venice-sync-to-page:${protocol}`;
  const requestId = `${type}-test`;
  return new Promise((resolve) => {
    const handler = (event) => {
      if (event.detail?.requestId !== requestId) return;
      window.removeEventListener(responseEvent, handler);
      resolve(event.detail.response);
    };
    window.addEventListener(responseEvent, handler);
    window.dispatchEvent(new FakeCustomEvent(commandEvent, { detail: { type, requestId, ...data } }));
  });
}

test('content-main inventories and pages legacy, RxDB physical, Studio, and future stores', async () => {
  const { window } = await createRuntime();
  const inventory = await dispatchCommand(window, 'GET_STORE_INVENTORY');
  assert.equal(inventory.success, true);
  const names = new Set(inventory.storeInventory.map((entry) => entry.name));
  assert.ok(names.has('conversations'));
  assert.ok(names.has('videoStudioActiveGenerations'));
  assert.ok(names.has('rxdb-physical:messages-1-attachments'));
  assert.ok(names.has('idb:future-content-db:savedDrafts'));
  assert.ok(names.has('browserSessionStorage'));
  assert.equal(inventory.storeInventory.find((entry) => entry.name === 'browserLocalStorage')?.mutableDuringExport, true);
  assert.equal(inventory.storeInventory.find((entry) => entry.name === 'browserSessionStorage')?.mutableDuringExport, true);

  const browserStateOnly = await dispatchCommand(window, 'GET_STORE_INVENTORY', { storeNames: ['browserLocalStorage'] });
  assert.equal(browserStateOnly.storeInventory.map((entry) => entry.name).join(','), 'browserLocalStorage');
  assert.equal(typeof browserStateOnly.storeInventory[0].fingerprint, 'string');
  window.__VENICE_ARCHIVE_INITIAL_LOCAL_STORAGE__ = [['captured-before-page-start', 'stable source value'], ['veniceActiveSessions', 'volatile session ids']];
  const capturedBrowserState = await dispatchCommand(window, 'GET_STORE_DATA', {
    storeName: 'browserLocalStorage', offset: 0, limit: 20, maxBytes: 1024 * 1024
  });
  assert.equal(capturedBrowserState.records.length, 2);
  assert.equal(capturedBrowserState.records[0].key, 'captured-before-page-start');
  assert.equal(capturedBrowserState.records[0].value, 'stable source value');
  assert.equal(capturedBrowserState.records[1].key, 'veniceActiveSessions');
  assert.equal(capturedBrowserState.records[1].redacted, true);

  const future = await dispatchCommand(window, 'GET_STORE_DATA', {
    storeName: 'idb:future-content-db:savedDrafts', offset: 0, limit: 20, maxBytes: 1024 * 1024
  });
  assert.equal(future.success, true);
  assert.equal(future.records[0].text, 'future content');

  const binary = await dispatchCommand(window, 'GET_STORE_DATA', {
    storeName: 'idb:future-content-db:binaryAssets', offset: 0, limit: 20, maxBytes: 1024
  });
  assert.equal(binary.success, true);
  assert.equal(binary.records[0].blob.__veniceArchiveType, 'blob');
  assert.equal(binary.records[0].blob.size, 4096);
  assert.ok(binary.records[0].blob.data.length > 4000);

  const rawAttachment = await dispatchCommand(window, 'GET_STORE_DATA', {
    storeName: 'rxdb-physical:messages-1-attachments', offset: 0, limit: 20, maxBytes: 1024 * 1024
  });
  assert.equal(rawAttachment.success, true);
  assert.equal(rawAttachment.records[0].docIdWithAttachmentId, 'rx-m1|file-1');
});
