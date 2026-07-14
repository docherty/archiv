/**
 * Forward-compatible archive coverage helpers.
 *
 * The UI has named projections for stores it understands, but a backup must not
 * silently omit a new Venice store simply because this extension predates it.
 * These helpers merge the known projection list with the live inventory and
 * maintain a lossless, non-enumerable source-store map for repository writers.
 */
(function initializeArchiveCoverage(globalScope) {
  'use strict';

  const SOURCE_STORES_PROPERTY = '__veniceArchiveSourceStores';

  function cleanText(value) {
    return value == null ? '' : String(value).trim();
  }

  function safeStoreIdentifier(value) {
    const normalized = cleanText(value)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 140);
    return normalized || 'unknown-store';
  }

  function hashStoreName(value) {
    const text = cleanText(value);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  function buildSourceStorePath(storeName) {
    // Prefixing the filename keeps even a pathological store name such as ".."
    // from ever becoming a traversal segment.
    return `stores/store--${safeStoreIdentifier(storeName)}--${hashStoreName(storeName)}.json`;
  }

  function buildArchiveStoreRequests(configuredRequests = [], inventory = []) {
    const configured = Array.isArray(configuredRequests) ? configuredRequests : [];
    const liveInventory = Array.isArray(inventory) ? inventory : [];
    const configuredNames = new Set();
    const requests = configured.map((request) => {
      const name = cleanText(request?.name);
      if (name) {
        configuredNames.add(name);
      }
      return {
        ...request,
        name,
        sourceStoreName: name,
        discovered: false
      };
    });

    liveInventory.forEach((entry) => {
      const name = cleanText(entry?.name);
      if (!name || configuredNames.has(name)) {
        return;
      }
      configuredNames.add(name);
      requests.push({
        name,
        dataKey: null,
        sourceStoreName: name,
        label: `discovered source store ${name}`,
        optional: false,
        discovered: true,
        pageSize: 20,
        maxBytes: 1024 * 1024
      });
    });

    return requests;
  }

  function attachSourceStores(target, sourceStores) {
    if (!target || typeof target !== 'object') {
      return target;
    }
    Object.defineProperty(target, SOURCE_STORES_PROPERTY, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: sourceStores && typeof sourceStores === 'object' ? sourceStores : {}
    });
    return target;
  }

  function getSourceStores(target) {
    if (!target || typeof target !== 'object') {
      return {};
    }
    return target[SOURCE_STORES_PROPERTY] || {};
  }

  function buildSourceStoreManifestRecords(currentStores = [], previousStores = {}, now = new Date()) {
    const timestamp = now instanceof Date ? now.toISOString() : cleanText(now);
    const previous = previousStores && typeof previousStores === 'object' ? previousStores : {};
    const records = {};
    const currentNames = new Set();

    (Array.isArray(currentStores) ? currentStores : []).forEach((store) => {
      const name = cleanText(store?.name);
      if (!name) {
        return;
      }
      currentNames.add(name);
      records[name] = {
        status: 'active',
        tombstoned: false,
        source: store.source || 'legacy',
        databaseName: store.databaseName || null,
        physicalStoreName: store.physicalStoreName || null,
        schemaVersion: store.schemaVersion ?? null,
        count: Number.isFinite(store.count) ? Number(store.count) : 0,
        sha256: store.sha256 || null,
        bytes: Number.isFinite(store.payloadBytes) ? Number(store.payloadBytes) : 0,
        path: store.path || buildSourceStorePath(name),
        lastSeenAt: timestamp
      };
    });

    Object.entries(previous).forEach(([name, record]) => {
      if (currentNames.has(name)) {
        return;
      }
      records[name] = {
        ...record,
        status: 'tombstoned',
        tombstoned: true,
        tombstonedAt: record?.tombstonedAt || timestamp
      };
    });

    return records;
  }

  function getTombstonedSourceStoreNames(previousStores = {}, currentNames = []) {
    const current = new Set((Array.isArray(currentNames) ? currentNames : []).map(cleanText).filter(Boolean));
    return Object.keys(previousStores && typeof previousStores === 'object' ? previousStores : {})
      .filter((name) => !current.has(name));
  }

  const api = Object.freeze({
    SOURCE_STORES_PROPERTY,
    attachSourceStores,
    buildArchiveStoreRequests,
    buildSourceStoreManifestRecords,
    buildSourceStorePath,
    getSourceStores,
    getTombstonedSourceStoreNames,
    safeStoreIdentifier
  });

  globalScope.VeniceArchiveCoverage = api;
})(globalThis);
