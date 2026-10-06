import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';
import { commandExpression } from '../cli/lib/extract.mjs';

const protocol = '2026-07-store-api-v12-tab-handoff';
const responseEvent = `venice-sync-from-page:${protocol}`;
const progressEvent = `venice-sync-progress:${protocol}`;

function runtime(respond) {
  const listeners = new Map();
  class CustomEvent {
    constructor(type, { detail } = {}) { this.type = type; this.detail = detail; }
  }
  const window = {
    addEventListener(type, handler) { listeners.set(type, [...(listeners.get(type) || []), handler]); },
    removeEventListener(type, handler) { listeners.set(type, (listeners.get(type) || []).filter(item => item !== handler)); },
    dispatchEvent(event) {
      for (const handler of listeners.get(event.type) || []) handler(event);
      if (event.type === `venice-sync-to-page:${protocol}`) respond(window, event.detail);
    }
  };
  return { window, listeners, CustomEvent, setTimeout, clearTimeout };
}

function assertClean(context) {
  assert.equal(context.listeners.get(responseEvent)?.length, 0);
  assert.equal(context.listeners.get(progressEvent)?.length, 0);
}

test('page command timeout records its last metadata stage and removes listeners', async () => {
  const context = runtime(window => window.dispatchEvent({ type: progressEvent,
    detail: { phase: 'fingerprint', source: 'legacy', storeName: 'messages', secret: 'DO-NOT-LOG' } }));
  await assert.rejects(vm.runInNewContext(commandExpression('GET_SNAPSHOT_SUMMARY', {}, 10), context), error => {
    assert.match(error.message, /GET_SNAPSHOT_SUMMARY.*fingerprint\/legacy\/messages/);
    assert.doesNotMatch(error.message, /DO-NOT-LOG/);
    return true;
  });
  assertClean(context);
});

test('page command success and failure remove response and diagnostic listeners', async () => {
  for (const fail of [false, true]) {
    const context = runtime((window, request) => window.dispatchEvent({ type: responseEvent,
      detail: { requestId: request.requestId, ...(fail ? { error: 'Explicit failure' } : { response: { success: true } }) } }));
    const promise = vm.runInNewContext(commandExpression('PING', {}, 50), context);
    if (fail) await assert.rejects(promise, /Explicit failure/);
    else assert.equal((await promise).success, true);
    assertClean(context);
  }
});
