/**
 * Pure transforms for content-bearing Venice Studio browser state.
 */
(function initializeStudioTransform(globalScope) {
  'use strict';

  const VIDEO_STUDIO_QUEUE_KEY = /^video-studio-(?:active|pending|failed)-generations$/i;

  function cleanText(value) {
    return value == null ? '' : String(value).trim();
  }

  function deriveVideoStudioLocalState(storageRecords) {
    const derived = [];
    (Array.isArray(storageRecords) ? storageRecords : []).forEach((entry) => {
      if (
        !entry ||
        entry.redacted ||
        !VIDEO_STUDIO_QUEUE_KEY.test(cleanText(entry.key)) ||
        typeof entry.value !== 'string'
      ) {
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(entry.value);
      } catch (_) {
        return;
      }

      const records = Array.isArray(parsed)
        ? parsed
        : (parsed && typeof parsed === 'object' ? [parsed] : []);
      records.forEach((record, index) => {
        if (!record || typeof record !== 'object' || Array.isArray(record)) return;
        derived.push({
          ...record,
          __localStorageKey: entry.key,
          __localStorageIndex: index
        });
      });
    });
    return derived;
  }

  const api = Object.freeze({
    VIDEO_STUDIO_QUEUE_KEY,
    deriveVideoStudioLocalState
  });

  globalScope.VeniceStudioTransform = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
