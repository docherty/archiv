import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function backgroundHarness() {
  let listener;
  const stored = {};
  const extensionOrigin = 'chrome-extension://fixture-extension/';
  const chrome = {
    runtime: {
      id: 'fixture-extension',
      getURL: (value = '') => `${extensionOrigin}${value}`,
      onMessage: { addListener(value) { listener = value; } },
      sendMessage: async () => ({ success: true })
    },
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries(keys.filter((key) => Object.hasOwn(stored, key)).map((key) => [key, stored[key]]));
        },
        async set(values) { Object.assign(stored, values); },
        async remove(key) { delete stored[key]; }
      }
    }
  };
  const context = vm.createContext({ chrome, console, crypto: globalThis.crypto, TextEncoder: globalThis.TextEncoder, setTimeout, clearTimeout });
  vm.runInContext(await readFile(new URL('../extension/background.js', import.meta.url), 'utf8'), context, { filename: 'background.js' });
  assert.equal(typeof listener, 'function');
  const send = (message, sender) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Background response timed out.')), 1000);
    const keepAlive = listener(message, sender, (response) => { clearTimeout(timeout); resolve(response); });
    assert.equal(keepAlive, true);
  });
  return {
    send,
    veniceSender: { id: 'fixture-extension', tab: { url: 'https://venice.ai/chat' } },
    extensionSender: { id: 'fixture-extension', url: `${extensionOrigin}popup.html` }
  };
}

test('background rejects untrusted senders and malformed recovery keys', async () => {
  const harness = await backgroundHarness();
  const unauthorized = await harness.send({ type: 'GET_STATE' }, harness.veniceSender);
  assert.equal(unauthorized.success, false);
  assert.equal(unauthorized.error, 'Unauthorized message sender');

  const malformed = await harness.send({
    type: 'INITIAL_STATE',
    data: { keyFingerprint: '__proto__', keyString: '1,2,3', conversationCount: 1, messageCount: 2, isEmpty: false }
  }, harness.veniceSender);
  assert.equal(malformed.success, false);

  const state = await harness.send({ type: 'GET_STATE' }, harness.extensionSender);
  assert.equal(state.keyFingerprint, null);
  assert.equal(state.vault.keyCount, 0);
});

test('background accepts a valid 32-byte Venice recovery key', async () => {
  const harness = await backgroundHarness();
  const values = Array.from({ length: 32 }, (_, index) => index);
  const response = await harness.send({
    type: 'INITIAL_STATE',
    data: { keyFingerprint: '0001020304050607', keyString: values.join(','), conversationCount: 3, messageCount: 9, isEmpty: false }
  }, harness.veniceSender);
  assert.equal(response.success, true);

  const state = await harness.send({ type: 'GET_STATE' }, harness.extensionSender);
  assert.equal(state.keyFingerprint, '0001020304050607');
  assert.equal(state.vault.keyCount, 1);
  assert.equal(state.conversationCount, 3);
  assert.equal(state.messageCount, 9);

  const removed = await harness.send({ type: 'KEY_CHANGED', data: { oldFingerprint: '0001020304050607', newFingerprint: null, newKeyString: null } }, harness.veniceSender);
  assert.equal(removed.success, true);
  const afterRemoval = await harness.send({ type: 'GET_STATE' }, harness.extensionSender);
  assert.equal(afterRemoval.keyFingerprint, null);
  assert.equal(afterRemoval.vault.keyCount, 1);
});
