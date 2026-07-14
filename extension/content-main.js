/**
 * Venice History Sync - Main World Content Script
 * 
 * This script runs in the MAIN world (same context as the page) and has
 * direct access to Venice's IndexedDB and localStorage.
 * 
 * It communicates with the extension via custom events relayed through
 * the bridge script.
 */

(function() {
  'use strict';
  
  const LOG_PREFIX = '[Venice Sync Main]';
  const MAIN_PROTOCOL_VERSION = '2026-07-store-api-v12-tab-handoff';
  const DB_NAME = 'venice-db-encrypted';
  const WRITE_OPERATIONS_ENABLED = false;
  const WRITE_OPERATIONS_DISABLED_ERROR = 'Restore and live writes are intentionally disabled in this build until dry-run, rollback, and validation safety checks are complete.';
  const TO_EXTENSION_EVENT = `venice-sync-to-extension:${MAIN_PROTOCOL_VERSION}`;
  const FROM_EXTENSION_EVENT = `venice-sync-from-extension:${MAIN_PROTOCOL_VERSION}`;
  const TO_PAGE_EVENT = `venice-sync-to-page:${MAIN_PROTOCOL_VERSION}`;
  const FROM_PAGE_EVENT = `venice-sync-from-page:${MAIN_PROTOCOL_VERSION}`;
  const MAIN_READY_EVENT = `venice-sync-main-ready:${MAIN_PROTOCOL_VERSION}`;
  const SUPPORTED_COMMANDS = [
    'PING',
    'GET_CURRENT_STATE',
    'REFRESH_STATE',
    'GET_FULL_DATA',
    'GET_STORE_INVENTORY',
    'GET_SNAPSHOT_SUMMARY',
    'GET_STORE_DATA',
    'FETCH_MEDIA_RESOURCE',
    'GET_OPFS_MEDIA_INDEX',
    'FETCH_OPFS_MEDIA',
    'GET_CAPTURED_MEDIA_INDEX',
    'FETCH_CAPTURED_MEDIA'
  ];

  if (WRITE_OPERATIONS_ENABLED) {
    SUPPORTED_COMMANDS.push('WRITE_DATA', 'WRITE_KEY');
  }

  if (window.__veniceSyncMainVersion === MAIN_PROTOCOL_VERSION) {
    console.log(LOG_PREFIX, 'Main world script already loaded');
    window.dispatchEvent(new CustomEvent(MAIN_READY_EVENT));
    return;
  }

  window.__veniceSyncMainVersion = MAIN_PROTOCOL_VERSION;

  // ===========================================
  // Live media capture (in-memory blob backup)
  // ===========================================
  //
  // Some Venice media (notably generated videos from the Video Studio /
  // Grok-Imagine) is never written to IndexedDB. It exists only as an
  // in-memory Blob handed to a <video>/<audio> element through
  // URL.createObjectURL(). A passive IndexedDB export can never reach those
  // bytes, so we transparently wrap createObjectURL and persist qualifying
  // media blobs into a DEDICATED, extension-owned IndexedDB database. We never
  // touch Venice's own databases here.
  const CAPTURE_DB_NAME = 'venice-archive-capture';
  const CAPTURE_DB_VERSION = 1;
  const CAPTURE_STORE = 'capturedMedia';
  // Declared image/audio/video Blobs are captured regardless of compression.
  // Unknown-type blobs must be large enough to plausibly be media and must pass
  // a magic-byte sniff so we never persist JavaScript/worker blobs.
  const CAPTURE_MAX_BLOB_BYTES = 512 * 1024 * 1024;
  const CAPTURE_FETCH_CHUNK_BYTES = 384 * 1024;

  // Blobs we have already processed in this page session (identity-based) so we
  // never re-read the same Blob when createObjectURL is called repeatedly.
  const seenCaptureBlobs = (typeof WeakSet === 'function') ? new WeakSet() : null;
  const seenCaptureUrls = new Set();

  function captureShouldConsiderBlob(blob) {
    if (typeof Blob === 'undefined' || !(blob instanceof Blob)) {
      return false;
    }
    if (!blob.size || blob.size > CAPTURE_MAX_BLOB_BYTES) {
      return false;
    }
    const type = (blob.type || '').toLowerCase();
    if (type.startsWith('video/') || type.startsWith('audio/')) {
      return true;
    }
    if (type.startsWith('image/')) {
      // Generated Studio images can be highly compressed and well below 1 MB.
      // Capturing every declared image Blob is preferable to silently losing a
      // legitimate generation; content hashes deduplicate any repeated UI blob.
      return true;
    }
    if (type.startsWith('text/') || type.startsWith('application/javascript') || type.startsWith('application/json') || type.startsWith('application/wasm')) {
      return false;
    }
    // Empty / octet-stream / other: only the large ones, and they still have to
    // pass the magic-byte sniff in the async path.
    if (type === '' || type === 'application/octet-stream' || type.startsWith('application/')) {
      return blob.size >= 1.5 * 1024 * 1024;
    }
    return false;
  }

  function captureKindForMime(mimeType, bytes) {
    const type = (mimeType || '').toLowerCase();
    if (type.startsWith('video/')) return 'video';
    if (type.startsWith('audio/')) return 'audio';
    if (type.startsWith('image/')) return 'image';
    const sniffed = captureSniffMime(bytes);
    if (sniffed) {
      if (sniffed.startsWith('video/')) return 'video';
      if (sniffed.startsWith('audio/')) return 'audio';
      if (sniffed.startsWith('image/')) return 'image';
    }
    return 'file';
  }

  // Returns a sniffed mime type for common media containers, or null when the
  // bytes do not look like real media (e.g. JavaScript/worker blobs).
  function captureSniffMime(bytes) {
    if (!bytes || bytes.length < 12) {
      return null;
    }
    const b = bytes;
    // ISO BMFF (mp4/m4v/m4a/mov): "ftyp" at offset 4
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
      return 'video/mp4';
    }
    // EBML (webm/mkv): 1A 45 DF A3
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
      return 'video/webm';
    }
    // OGG: "OggS"
    if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) {
      return 'audio/ogg';
    }
    // WAV: "RIFF"...."WAVE"
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) {
      return 'audio/wav';
    }
    // MP3: "ID3" or frame sync 0xFFEx
    if ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) {
      return 'audio/mpeg';
    }
    // PNG
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      return 'image/png';
    }
    // JPEG
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
      return 'image/jpeg';
    }
    // GIF
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
      return 'image/gif';
    }
    // WEBP: "RIFF"...."WEBP"
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
      return 'image/webp';
    }
    return null;
  }

  function openCaptureDB() {
    return new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDB.open(CAPTURE_DB_NAME, CAPTURE_DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(CAPTURE_STORE)) {
          const store = db.createObjectStore(CAPTURE_STORE, { keyPath: 'hash' });
          store.createIndex('capturedAt', 'capturedAt', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Failed to open capture database.'));
    });
  }

  async function captureHashBytes(bytes) {
    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const view = new Uint8Array(digest);
      let hex = '';
      for (let i = 0; i < view.length; i++) {
        hex += view[i].toString(16).padStart(2, '0');
      }
      return hex;
    }
    // Fallback: non-cryptographic but stable identity hash.
    let h1 = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h1 ^= bytes[i];
      h1 = (h1 * 0x01000193) >>> 0;
    }
    return `fnv-${bytes.length}-${h1.toString(16)}`;
  }

  // Hash a record collection without ever materializing JSON.stringify(records)
  // as one giant string. Large Venice message stores can exceed the browser's
  // maximum string length even though each individual record is readable.
  // This is a deterministic drift fingerprint; the repository later writes
  // and verifies full source-store SHA-256 payloads incrementally by parts.
  async function captureRecordSetFingerprint(records, encodeRecord = null) {
    const list = Array.isArray(records) ? records : [];
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    const update = (serialized) => {
      const value = `${serialized}\u0000`;
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
    };
    for (const record of list) {
      const normalized = encodeRecord ? await encodeRecord(record) : record;
      update(JSON.stringify(normalized));
    }
    return `record-fnv-v1-${list.length}-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
  }

  function captureRecordExists(db, hash) {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(CAPTURE_STORE, 'readonly');
        const store = tx.objectStore(CAPTURE_STORE);
        const req = store.getKey ? store.getKey(hash) : store.get(hash);
        req.onsuccess = () => resolve(Boolean(req.result));
        req.onerror = () => resolve(false);
      } catch (_) {
        resolve(false);
      }
    });
  }

  function capturePutRecord(db, record) {
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(CAPTURE_STORE, 'readwrite');
        tx.objectStore(CAPTURE_STORE).put(record);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || new Error('Failed to write captured media.'));
        tx.onabort = () => reject(tx.error || new Error('Capture write aborted.'));
      } catch (error) {
        reject(error);
      }
    });
  }

  async function captureRecordGap(blob, blobUrl, reason) {
    let db;
    try {
      db = await openCaptureDB();
      const now = new Date().toISOString();
      await capturePutRecord(db, {
        hash: `gap-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        mimeType: blob?.type || 'application/octet-stream',
        size: Number(blob?.size || 0),
        kind: captureKindForMime(blob?.type || '', null),
        capturedAt: now,
        pageUrl: location?.href || null,
        pagePath: location?.pathname || null,
        pageTitle: document?.title || null,
        blobUrl: blobUrl || null,
        status: 'unresolved',
        reason
      });
    } catch (_) {
      // A gap record is best-effort and must never affect Venice.
    } finally {
      try { db?.close(); } catch (_) { /* ignore */ }
    }
  }

  async function captureBlob(blob, blobUrl) {
    if (seenCaptureBlobs) {
      if (seenCaptureBlobs.has(blob)) {
        return;
      }
      seenCaptureBlobs.add(blob);
    }

    let bytes;
    try {
      bytes = new Uint8Array(await blob.arrayBuffer());
    } catch (_) {
      return;
    }
    if (!bytes.length || bytes.length > CAPTURE_MAX_BLOB_BYTES) {
      return;
    }

    let mimeType = (blob.type || '').toLowerCase();
    const declared = mimeType.startsWith('video/') || mimeType.startsWith('audio/') || mimeType.startsWith('image/');
    if (!declared) {
      const sniffed = captureSniffMime(bytes);
      if (!sniffed) {
        // Unknown blob that does not look like media (e.g. a JS/worker blob).
        return;
      }
      if (!mimeType || mimeType === 'application/octet-stream') {
        mimeType = sniffed;
      }
    }

    let db;
    try {
      db = await openCaptureDB();
    } catch (_) {
      return;
    }

    try {
      const hash = await captureHashBytes(bytes);
      if (await captureRecordExists(db, hash)) {
        return;
      }
      const record = {
        hash,
        mimeType: mimeType || 'application/octet-stream',
        size: bytes.length,
        kind: captureKindForMime(mimeType, bytes),
        capturedAt: new Date().toISOString(),
        pageUrl: (typeof location !== 'undefined' && location.href) ? location.href : null,
        pagePath: (typeof location !== 'undefined' && location.pathname) ? location.pathname : null,
        pageTitle: (typeof document !== 'undefined' && document.title) ? document.title : null,
        blobUrl: blobUrl || null,
        status: 'captured',
        reason: null,
        blob: new Blob([bytes], { type: mimeType || 'application/octet-stream' })
      };
      await capturePutRecord(db, record);
      console.log(LOG_PREFIX, `Captured ${record.kind} blob (${record.size} bytes, ${record.mimeType}) for durable archive.`);
    } catch (_) {
      // Never surface capture failures to the page.
    } finally {
      try { db.close(); } catch (_) { /* ignore */ }
    }
  }

  function installMediaCaptureHook() {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      return;
    }
    if (URL.createObjectURL.__veniceCaptureWrapped) {
      return;
    }
    const original = URL.createObjectURL.bind(URL);
    const wrapped = function(object) {
      const url = original(object);
      try {
        if (captureShouldConsiderBlob(object)) {
          // Fire-and-forget: never block the page or consume the blob (reads are
          // non-destructive and the page keeps its own reference).
          Promise.resolve().then(() => captureBlob(object, url)).catch(() => {});
        } else if (
          typeof Blob !== 'undefined' &&
          object instanceof Blob &&
          object.size > CAPTURE_MAX_BLOB_BYTES &&
          /^(image|audio|video)\//i.test(object.type || '')
        ) {
          Promise.resolve().then(() => captureRecordGap(
            object,
            url,
            `Media Blob exceeds the live-capture safety limit (${CAPTURE_MAX_BLOB_BYTES} bytes).`
          )).catch(() => {});
        }
      } catch (_) {
        // Capture must never break page behaviour.
      }
      return url;
    };
    wrapped.__veniceCaptureWrapped = true;
    try {
      URL.createObjectURL = wrapped;
      console.log(LOG_PREFIX, 'Live media capture hook installed.');
    } catch (_) {
      // createObjectURL may be non-writable in some environments; ignore.
    }
  }

  async function captureExistingBlobUrl(url) {
    if (!url || seenCaptureUrls.has(url)) {
      return;
    }
    seenCaptureUrls.add(url);
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      if (captureShouldConsiderBlob(blob)) {
        await captureBlob(blob, url);
      } else if (blob.size > CAPTURE_MAX_BLOB_BYTES && /^(image|audio|video)\//i.test(blob.type || '')) {
        await captureRecordGap(blob, url, `Existing media Blob exceeds the live-capture safety limit (${CAPTURE_MAX_BLOB_BYTES} bytes).`);
      }
    } catch (_) {
      // Expired/revoked blob URLs cannot be recovered; source-store and URL
      // inventory paths will still report them as unresolved during export.
    }
  }

  function scanExistingBlobMedia() {
    if (typeof document === 'undefined' || !document.querySelectorAll) {
      return;
    }
    const elements = document.querySelectorAll('img[src^="blob:"], video[src^="blob:"], audio[src^="blob:"], source[src^="blob:"]');
    elements.forEach((element) => {
      const url = element.currentSrc || element.src || element.getAttribute('src');
      if (url) {
        Promise.resolve().then(() => captureExistingBlobUrl(url)).catch(() => {});
      }
    });
  }

  // Read captured media metadata (no bytes) for the durable-archive exporter.
  async function listCapturedMediaIndex() {
    let db;
    try {
      db = await openCaptureDB();
    } catch (_) {
      return [];
    }
    try {
      return await new Promise((resolve) => {
        const items = [];
        const tx = db.transaction(CAPTURE_STORE, 'readonly');
        const store = tx.objectStore(CAPTURE_STORE);
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) {
            resolve(items);
            return;
          }
          const value = cursor.value || {};
          items.push({
            hash: value.hash,
            mimeType: value.mimeType || null,
            size: value.size || 0,
            kind: value.kind || 'file',
            capturedAt: value.capturedAt || null,
            pageUrl: value.pageUrl || null,
            pagePath: value.pagePath || null,
            pageTitle: value.pageTitle || null,
            blobUrl: value.blobUrl || null,
            status: value.status || (value.blob ? 'captured' : 'unresolved'),
            reason: value.reason || null
          });
          cursor.continue();
        };
        cursorReq.onerror = () => resolve(items);
      });
    } finally {
      try { db.close(); } catch (_) { /* ignore */ }
    }
  }

  // Return one base64 chunk of a captured media blob, keyed by content hash.
  async function fetchCapturedMediaChunk(hash, offset, chunkSize) {
    if (!hash) {
      throw new Error('A captured media hash is required.');
    }
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeChunk = Math.min(Math.max(1, Number(chunkSize) || CAPTURE_FETCH_CHUNK_BYTES), 4 * 1024 * 1024);
    let db;
    try {
      db = await openCaptureDB();
    } catch (error) {
      throw new Error(`Capture database unavailable: ${error.message}`);
    }
    try {
      const record = await new Promise((resolve, reject) => {
        const tx = db.transaction(CAPTURE_STORE, 'readonly');
        const req = tx.objectStore(CAPTURE_STORE).get(hash);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error || new Error('Failed to read captured media.'));
      });
      if (!record || !record.blob) {
        throw new Error('Captured media not found.');
      }
      const totalBytes = record.size || record.blob.size || 0;
      const start = Math.min(safeOffset, totalBytes);
      const end = Math.min(start + safeChunk, totalBytes);
      const sliceBytes = new Uint8Array(await record.blob.slice(start, end).arrayBuffer());
      const done = end >= totalBytes;
      return {
        success: true,
        command: 'FETCH_CAPTURED_MEDIA',
        protocolVersion: MAIN_PROTOCOL_VERSION,
        hash,
        mimeType: record.mimeType || 'application/octet-stream',
        sizeBytes: totalBytes,
        offset: start,
        nextOffset: end,
        chunkBytes: sliceBytes.length,
        chunkBase64: uint8ArrayToBase64(sliceBytes),
        done
      };
    } finally {
      try { db.close(); } catch (_) { /* ignore */ }
    }
  }

  function inferOpfsMimeType(path, explicitType = null) {
    if (explicitType) {
      return explicitType;
    }
    const normalized = String(path || '').toLowerCase().split('?')[0];
    const types = [
      [/\.avif$/, 'image/avif'], [/\.png$/, 'image/png'], [/\.jpe?g$/, 'image/jpeg'],
      [/\.webp$/, 'image/webp'], [/\.gif$/, 'image/gif'], [/\.svg$/, 'image/svg+xml'],
      [/\.mp4$/, 'video/mp4'], [/\.webm$/, 'video/webm'], [/\.mov$/, 'video/quicktime'],
      [/\.mp3$/, 'audio/mpeg'], [/\.wav$/, 'audio/wav'], [/\.ogg$/, 'audio/ogg'],
      [/\.m4a$/, 'audio/mp4'], [/\.aac$/, 'audio/aac'], [/\.flac$/, 'audio/flac'],
      [/\.pdf$/, 'application/pdf'], [/\.json$/, 'application/json'], [/\.txt$/, 'text/plain']
    ];
    for (const [pattern, mimeType] of types) {
      if (pattern.test(normalized)) {
        return mimeType;
      }
    }
    return 'application/octet-stream';
  }

  function opfsKindForFile(path, mimeType) {
    const signal = `${path || ''} ${mimeType || ''}`.toLowerCase();
    if (signal.includes('video/') || /\.(mp4|webm|mov|m4v|mkv)$/.test(signal)) return 'video';
    if (signal.includes('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/.test(signal)) return 'audio';
    if (signal.includes('image/') || /\.(png|jpe?g|webp|gif|svg|avif|heic|heif)$/.test(signal)) return 'image';
    return 'file';
  }

  async function listOpfsMediaIndex() {
    if (!navigator?.storage || typeof navigator.storage.getDirectory !== 'function') {
      return { available: false, items: [], reason: 'Origin Private File System is unavailable in this browser.' };
    }

    const root = await navigator.storage.getDirectory();
    const items = [];
    const walk = async (directoryHandle, prefix = '', depth = 0) => {
      if (depth > 16) {
        throw new Error(`OPFS directory nesting exceeds archive limit at ${prefix || '/'}.`);
      }
      for await (const [name, handle] of directoryHandle.entries()) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === 'directory') {
          await walk(handle, path, depth + 1);
          continue;
        }
        if (handle.kind !== 'file') {
          continue;
        }
        const file = await handle.getFile();
        const mimeType = inferOpfsMimeType(path, file.type || null);
        items.push({
          path,
          fileName: name,
          size: file.size,
          lastModified: file.lastModified || null,
          mimeType,
          kind: opfsKindForFile(path, mimeType),
          source: 'opfs'
        });
      }
    };
    await walk(root);
    items.sort((left, right) => left.path.localeCompare(right.path));
    return { available: true, items, reason: null };
  }

  async function getOpfsFile(path) {
    if (!navigator?.storage || typeof navigator.storage.getDirectory !== 'function') {
      throw new Error('Origin Private File System is unavailable in this browser.');
    }
    const parts = String(path || '').split('/').filter(Boolean);
    if (!parts.length || parts.some((part) => part === '.' || part === '..')) {
      throw new Error('A safe OPFS file path is required.');
    }
    const fileName = parts.pop();
    let directory = await navigator.storage.getDirectory();
    for (const part of parts) {
      directory = await directory.getDirectoryHandle(part, { create: false });
    }
    const handle = await directory.getFileHandle(fileName, { create: false });
    return handle.getFile();
  }

  async function fetchOpfsMediaChunk(path, offset, chunkSize) {
    const file = await getOpfsFile(path);
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeChunk = Math.min(Math.max(1, Number(chunkSize) || CAPTURE_FETCH_CHUNK_BYTES), 4 * 1024 * 1024);
    const start = Math.min(safeOffset, file.size);
    const end = Math.min(start + safeChunk, file.size);
    const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
    return {
      success: true,
      command: 'FETCH_OPFS_MEDIA',
      protocolVersion: MAIN_PROTOCOL_VERSION,
      path,
      mimeType: inferOpfsMimeType(path, file.type || null),
      sizeBytes: file.size,
      offset: start,
      nextOffset: end,
      chunkBytes: bytes.length,
      chunkBase64: uint8ArrayToBase64(bytes),
      done: end >= file.size
    };
  }

  installMediaCaptureHook();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanExistingBlobMedia, { once: true });
  } else {
    scanExistingBlobMedia();
  }
  window.addEventListener('load', scanExistingBlobMedia, { once: true });


  const ENCRYPTED_STORE_NAMES = new Set([
    'conversations',
    'messages',
    'messageImages',
    'studioImageSessions',
    'studioImageTurns',
    'studioImageTurnMedia',
    'studioAudioSessions',
    'studioAudioTurns',
    'studioAudioTurnMedia',
    'studioVideoSessions',
    'videoEditorSessions',
    'folders',
    'settings',
    'textSettings',
    'imageSettings',
    'characters',
    'personas',
    'userSystemPrompts',
    'supportBotThreads',
    'supportBotMessages',
    'pinnedMessages'
  ]);
  const OPTIONAL_STORE_NAMES = new Set([
    'messageImages',
    'studioImageSessions',
    'studioImageTurns',
    'studioImageTurnMedia',
    'studioAudioSessions',
    'studioAudioTurns',
    'studioAudioTurnMedia',
    'studioVideoSessions',
    'videoEditorSessions',
    'folders',
    'settings',
    'textSettings',
    'imageSettings',
    'characters',
    'personas',
    'userSystemPrompts',
    'supportBotThreads',
    'supportBotMessages',
    'pinnedMessages',
    '_encryptionSettings'
  ]);

  // Venice migrated newer data (agentic "Mind" sessions, videos, newer media)
  // into a SECOND, RxDB/Dexie-backed IndexedDB database. The legacy DB above no
  // longer contains these records, so we surface a set of logical store names
  // that are read from the RxDB database and decoded into plain records.
  const RX_DB_NAME = 'venice-rx-db-encrypted';
  // logical store name -> RxDB collection base name. Physical RxDB stores are
  // named `<base>-<schemaVersion>-documents`; only the highest version holds
  // live data (lower versions are emptied by RxDB migrations).
  const RX_LOGICAL_STORES = new Map([
    ['rxConversations', 'conversations'],
    ['rxMessages', 'messages'],
    ['rxMessageImages', 'messageImages'],
    ['messageAudioAttachments', 'messageAudioAttachments'],
    ['messageFileAttachments', 'messageFileAttachments'],
    ['messageImageAttachments', 'messageImageAttachments'],
    ['messageVideoAttachments', 'messageVideoAttachments'],
    ['mindConversations', 'mindConversations'],
    ['mindMessages', 'mindMessages'],
    ['mindMedia', 'mindMedia'],
    ['mindAttachments', 'mindAttachments'],
    ['messageVideos', 'messageVideos']
  ]);
  const RX_UNKNOWN_STORE_PREFIX = 'rxdb:';
  const RX_PHYSICAL_STORE_PREFIX = 'rxdb-physical:';
  const GENERIC_IDB_STORE_PREFIX = 'idb:';
  const BROWSER_LOCAL_STORAGE_STORE = 'browserLocalStorage';
  const BROWSER_SESSION_STORAGE_STORE = 'browserSessionStorage';
  const GENERIC_IDB_KNOWN_STORES = new Map([
    ['videoStudioActiveGenerations', {
      databaseName: 'video-studio-recovery',
      storeName: 'activeGenerations'
    }]
  ]);
  const GENERIC_IDB_PHYSICAL_TO_LOGICAL = new Map(
    Array.from(GENERIC_IDB_KNOWN_STORES.entries()).map(([logicalName, descriptor]) => [
      `${descriptor.databaseName}\u0000${descriptor.storeName}`,
      logicalName
    ])
  );
  const GENERIC_IDB_EXCLUDED_DATABASES = new Set([
    DB_NAME,
    RX_DB_NAME,
    CAPTURE_DB_NAME,
    '__venice_indexeddb_probe__'
  ]);
  const RX_BASE_TO_LOGICAL_STORE = new Map(
    Array.from(RX_LOGICAL_STORES.entries()).map(([logicalName, base]) => [base, logicalName])
  );
  const rxStoreReadCache = new Map();
  const rxPhysicalStoreReadCache = new Map();
  const legacyStoreReadCache = new Map();
  const genericIdbStoreReadCache = new Map();
  let detectedDBVersion = null;
  let rxDbAvailable = null; // null = unknown, true/false once probed
  
  // Pending request callbacks
  const pendingRequests = new Map();
  
  // Cache of current state
  let cachedState = null;
  let cachedKeyInfo = null;
  let cachedKeyString = null;
  let lastPollTime = 0;
  let pollInFlight = null;
  const POLL_INTERVAL = 5000; // 5 seconds
  const MEDIA_FETCH_CHUNK_BYTES = 384 * 1024;
  const MEDIA_FETCH_MAX_BYTES = 512 * 1024 * 1024;
  const MEDIA_FETCH_CACHE_LIMIT = 6;
  const mediaResourceCache = new Map();
  
  // ===========================================
  // Decryption Helpers (using Venice's nacl)
  // ===========================================
  
  const MAX_DECRYPT_DEPTH = 8;

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }

  function toUint8Array(obj) {
    if (obj instanceof Uint8Array) return obj;
    if (obj instanceof ArrayBuffer) return new Uint8Array(obj);
    if (ArrayBuffer.isView(obj)) return new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength);
    if (Array.isArray(obj)) return new Uint8Array(obj);
    // Venice serialized typed-array form: { encoded: <base64>, byteOffset, length }
    if (obj && typeof obj === 'object' && typeof obj.encoded === 'string') {
      const bytes = base64ToBytes(obj.encoded);
      const offset = Number(obj.byteOffset) || 0;
      const length = Number.isFinite(obj.length) ? Number(obj.length) : (bytes.length - offset);
      if (offset === 0 && length >= bytes.length) return bytes;
      return bytes.subarray(offset, offset + length);
    }
    // Digit-keyed object form: { 0: .., 1: .., ... }
    const length = Object.keys(obj).filter(k => !isNaN(k)).length;
    const arr = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      arr[i] = obj[i];
    }
    return arr;
  }

  // True when a value looks like an encrypted/serialized binary payload that can be
  // converted to bytes via toUint8Array (real Uint8Array, array, digit-keyed object,
  // or Venice's { encoded } serialized form).
  function isEncryptedPayload(val) {
    if (val == null) return false;
    if (val instanceof Uint8Array || val instanceof ArrayBuffer || ArrayBuffer.isView(val)) return true;
    if (Array.isArray(val)) return val.length > 0;
    if (typeof val === 'object') {
      if (typeof val.encoded === 'string') return true;
      for (const k in val) {
        if (!isNaN(k)) return true;
      }
    }
    return false;
  }

  // Venice tags binary fields with a `$types` map, e.g. { contentBinary: 'arraybuffer' }
  // or { __encryptedData: 'uint8array' }. Normalize any serialized { encoded } binary
  // fields to base64 strings (the form downstream consumers expect) and drop `$types`.
  function finalizeDecryptedRecord(record) {
    if (!record || typeof record !== 'object') return record;
    const types = record.$types;
    if (types && typeof types === 'object') {
      for (const field of Object.keys(types)) {
        if (field === '__encryptedData') continue;
        const raw = record[field];
        if (raw && typeof raw === 'object' && typeof raw.encoded === 'string') {
          record[field] = raw.encoded; // base64 string
        }
      }
    }
    if ('$types' in record) {
      delete record.$types;
    }
    return record;
  }

  function parseKeyString(keyString) {
    if (typeof keyString !== 'string' || keyString.trim() === '') {
      return null;
    }

    const keyValues = keyString.split(',').map(Number);
    if (keyValues.length === 0 || keyValues.some(value => Number.isNaN(value))) {
      return null;
    }

    return new Uint8Array(keyValues);
  }

  function getFingerprint(keyBytes) {
    return Array.from(keyBytes.slice(0, 8))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function buildKeyInfo(keyString) {
    const keyBytes = parseKeyString(keyString);
    if (!keyBytes) {
      return null;
    }

    return {
      keyString,
      keyBytes,
      fingerprint: getFingerprint(keyBytes)
    };
  }
  
  function decryptData(encryptedData, keyBytes) {
    try {
      // Venice uses NaCl secretbox (XSalsa20-Poly1305)
      // Format: nonce (24 bytes) + ciphertext (includes 16 byte auth tag)
      const data = toUint8Array(encryptedData);
      const nonce = data.slice(0, 24);
      const ciphertext = data.slice(24);
      
      // Use Venice's nacl library if available, otherwise try global
      const naclLib = window.nacl || (typeof nacl !== 'undefined' ? nacl : null);
      if (!naclLib) {
        console.error(LOG_PREFIX, 'NaCl library not available! window.nacl:', typeof window.nacl);
        return null;
      }
      
      if (!naclLib.secretbox || !naclLib.secretbox.open) {
        console.error(LOG_PREFIX, 'NaCl secretbox not available');
        return null;
      }
      
      const decrypted = naclLib.secretbox.open(ciphertext, nonce, keyBytes);
      if (!decrypted) {
        console.warn(LOG_PREFIX, 'Decryption returned null - wrong key?');
        return null;
      }
      
      const text = new TextDecoder().decode(decrypted);
      return JSON.parse(text);
    } catch (e) {
      console.error(LOG_PREFIX, 'Decryption error:', e.message);
      return null;
    }
  }
  
  function decryptRecord(record, keyBytes) {
    if (!record || typeof record !== 'object' || !record.__encryptedData) {
      return record; // Not encrypted or no data
    }

    let current = record;
    let depth = 0;

    // Venice may wrap content in multiple encryption layers: decrypting the outer
    // __encryptedData can yield a record that itself contains another __encryptedData
    // (serialized as { encoded: <base64>, byteOffset, length } and tagged via $types).
    // Decrypt recursively until no encrypted payload remains.
    while (
      current &&
      current.__encryptedData &&
      isEncryptedPayload(current.__encryptedData) &&
      depth < MAX_DECRYPT_DEPTH
    ) {
      const decrypted = decryptData(current.__encryptedData, keyBytes);
      if (!decrypted) {
        // Decryption failed at this layer. Surface a flag so undecryptable records
        // can be reported rather than silently emitted as blank entries.
        const { __encryptedData, ...rest } = current;
        return { ...rest, __decryptError: true };
      }
      const { __encryptedData, $types, ...rest } = current;
      current = { ...rest, ...decrypted };
      depth++;
    }

    if (current && current.__encryptedData && isEncryptedPayload(current.__encryptedData)) {
      // Still encrypted after max depth — flag instead of returning ciphertext as content.
      const { __encryptedData, ...rest } = current;
      return { ...rest, __decryptError: true };
    }

    return finalizeDecryptedRecord(current);
  }
  
  function decryptRecords(records, keyBytes) {
    return records.map(r => decryptRecord(r, keyBytes));
  }

  // ===========================================
  // Encryption Helpers (for re-encrypting data)
  // ===========================================

  function encryptData(data, keyBytes) {
    try {
      const naclLib = window.nacl || (typeof nacl !== 'undefined' ? nacl : null);
      if (!naclLib) {
        console.error(LOG_PREFIX, 'NaCl library not available for encryption');
        return null;
      }

      // Generate random nonce (24 bytes)
      const nonce = naclLib.randomBytes(24);
      
      // Convert data to JSON string then to Uint8Array
      const dataString = JSON.stringify(data);
      const dataBytes = new TextEncoder().encode(dataString);
      
      // Encrypt using secretbox
      const ciphertext = naclLib.secretbox(dataBytes, nonce, keyBytes);
      if (!ciphertext) {
        console.error(LOG_PREFIX, 'Encryption failed');
        return null;
      }
      
      // Combine nonce + ciphertext (Venice's format)
      const combined = new Uint8Array(nonce.length + ciphertext.length);
      combined.set(nonce);
      combined.set(ciphertext, nonce.length);
      
      return combined;
    } catch (e) {
      console.error(LOG_PREFIX, 'Encryption error:', e.message);
      return null;
    }
  }

  function encryptRecord(record, keyBytes) {
    // If already encrypted, return as-is
    if (record && record.__encryptedData) {
      return record;
    }
    
    // Extract fields that should remain unencrypted (IDs, timestamps, references)
    // Keep id, conversationId, timestamps outside the encrypted blob
    const { 
      id, 
      conversationId, 
      createdAtUnixTimestamp, 
      updatedAtUnixTimestamp,
      ...dataToEncrypt 
    } = record;
    
    const encryptedData = encryptData(dataToEncrypt, keyBytes);
    if (!encryptedData) {
      console.warn(LOG_PREFIX, 'Failed to encrypt record, returning original');
      return record;
    }
    
    // Return in Venice's expected format
    const result = {
      id,
      __encryptedData: encryptedData
    };
    
    // Add conversation reference for messages
    if (conversationId !== undefined) {
      result.conversationId = conversationId;
    }
    
    // Add timestamps if present
    if (createdAtUnixTimestamp !== undefined) {
      result.createdAtUnixTimestamp = createdAtUnixTimestamp;
    }
    if (updatedAtUnixTimestamp !== undefined) {
      result.updatedAtUnixTimestamp = updatedAtUnixTimestamp;
    }
    
    console.log(LOG_PREFIX, 'Encrypted record:', id, 'encData length:', encryptedData.length);
    
    return result;
  }

  function encryptRecords(records, keyBytes) {
    return records.map(r => encryptRecord(r, keyBytes));
  }

  function isBridgeUnavailableError(error) {
    const message = String(error?.message || error || '');
    return message.includes('Extension context invalidated') ||
      message.includes('Extension runtime is unavailable');
  }

  function warnIfBridgeForwardingFailed(prefix, error) {
    if (isBridgeUnavailableError(error)) {
      return;
    }

    console.warn(LOG_PREFIX, prefix, error?.message || String(error || 'Unknown error'));
  }
  
  // ===========================================
  // Message Handling
  // ===========================================
  
  function sendToExtension(type, data = {}) {
    return new Promise((resolve, reject) => {
      const requestId = `page-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      pendingRequests.set(requestId, { resolve, reject });
      
      // Timeout after 30 seconds
      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, 30000);
      
      window.dispatchEvent(new CustomEvent(TO_EXTENSION_EVENT, {
        detail: { type, data, requestId }
      }));
    });
  }

  function buildWriteDisabledResponse(command) {
    return {
      success: false,
      command,
      protocolVersion: MAIN_PROTOCOL_VERSION,
      writesEnabled: WRITE_OPERATIONS_ENABLED,
      error: WRITE_OPERATIONS_DISABLED_ERROR
    };
  }
  
  // Listen for responses from extension
  window.addEventListener(FROM_EXTENSION_EVENT, (event) => {
    const { requestId, response, error } = event.detail;
    const pending = pendingRequests.get(requestId);
    
    if (pending) {
      pendingRequests.delete(requestId);
      if (error) {
        pending.reject(new Error(error));
      } else {
        pending.resolve(response);
      }
    }
  });
  
  // Listen for commands from extension
  window.addEventListener(TO_PAGE_EVENT, async (event) => {
    const { type, requestId, ...data } = event.detail;
    console.log(LOG_PREFIX, 'Received command:', type);
    
    let response;
    try {
      switch (type) {
        case 'PING':
          response = {
            success: true,
            ready: true,
            protocolVersion: MAIN_PROTOCOL_VERSION,
            writesEnabled: WRITE_OPERATIONS_ENABLED,
            supportedCommands: SUPPORTED_COMMANDS
          };
          break;
        case 'GET_CURRENT_STATE':
        case 'REFRESH_STATE':
          // Force fresh state capture and send to background
          response = await getCurrentState();
          // Also send to background as an update
          try {
            await sendToExtension('INITIAL_STATE', response);
          } catch (syncError) {
            warnIfBridgeForwardingFailed('Could not forward state to background:', syncError);
          }
          break;
        case 'GET_FULL_DATA':
          response = await getFullData(data.encrypted);
          break;
        case 'GET_STORE_INVENTORY':
          response = await getStoreInventoryResponse({ storeNames: data.storeNames });
          break;
        case 'GET_SNAPSHOT_SUMMARY':
          response = await getSnapshotSummary();
          break;
        case 'GET_STORE_DATA':
          response = await getStoreData(data.storeName, data.encrypted, {
            offset: data.offset,
            limit: data.limit,
            maxBytes: data.maxBytes
          });
          break;
        case 'FETCH_MEDIA_RESOURCE':
          response = await fetchMediaResource(data.url, {
            cacheKey: data.cacheKey,
            offset: data.offset,
            chunkSize: data.chunkSize,
            maxBytes: data.maxBytes
          });
          break;
        case 'GET_OPFS_MEDIA_INDEX': {
          const opfs = await listOpfsMediaIndex();
          response = {
            success: true,
            command: 'GET_OPFS_MEDIA_INDEX',
            protocolVersion: MAIN_PROTOCOL_VERSION,
            available: opfs.available,
            items: opfs.items,
            count: opfs.items.length,
            reason: opfs.reason
          };
          break;
        }
        case 'FETCH_OPFS_MEDIA':
          response = await fetchOpfsMediaChunk(data.path, data.offset, data.chunkSize);
          break;
        case 'GET_CAPTURED_MEDIA_INDEX': {
          const capturedItems = await listCapturedMediaIndex();
          response = {
            success: true,
            command: 'GET_CAPTURED_MEDIA_INDEX',
            protocolVersion: MAIN_PROTOCOL_VERSION,
            items: capturedItems,
            count: capturedItems.length
          };
          break;
        }
        case 'FETCH_CAPTURED_MEDIA':
          response = await fetchCapturedMediaChunk(data.hash, data.offset, data.chunkSize);
          break;
        case 'WRITE_DATA':
          response = WRITE_OPERATIONS_ENABLED
            ? await writeData(data)
            : buildWriteDisabledResponse('WRITE_DATA');
          break;
        case 'WRITE_KEY':
          response = WRITE_OPERATIONS_ENABLED
            ? writeKey(data.keyString)
            : buildWriteDisabledResponse('WRITE_KEY');
          break;
        default:
          response = { error: `Unknown command: ${type}` };
      }
    } catch (e) {
      response = { error: e.message };
    }
    
    // Send response back
    window.dispatchEvent(new CustomEvent(FROM_PAGE_EVENT, {
      detail: { requestId, response }
    }));
  });
  
  // ===========================================
  // IndexedDB Access
  // ===========================================

  window.dispatchEvent(new CustomEvent(MAIN_READY_EVENT));

  async function getExistingDBVersion() {
    if (Number.isInteger(detectedDBVersion) && detectedDBVersion > 0) {
      return detectedDBVersion;
    }

    if (typeof indexedDB.databases !== 'function') {
      return null;
    }

    const databases = await indexedDB.databases();
    const match = databases.find((database) => database.name === DB_NAME);

    if (!match?.version) {
      throw new Error('Venice database not found. Open Venice.ai and wait for chats to load before scanning.');
    }

    detectedDBVersion = match.version;
    return detectedDBVersion;
  }

  function openDBWithVersion(version) {
    return new Promise((resolve, reject) => {
      let request;

      try {
        request = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
      } catch (error) {
        reject(error);
        return;
      }

      request.onsuccess = () => {
        detectedDBVersion = request.result.version;
        resolve(request.result);
      };

      request.onerror = () => {
        if (request.error?.name === 'VersionError') {
          detectedDBVersion = null;
        }
        reject(request.error);
      };

      request.onupgradeneeded = () => {
        request.transaction?.abort();
        detectedDBVersion = null;
        reject(new Error('Venice database is not ready yet. Reload Venice.ai and try again.'));
      };
    });
  }
  
  async function openDB() {
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const version = await getExistingDBVersion();
        return await openDBWithVersion(version);
      } catch (error) {
        lastError = error;

        if (error?.name === 'VersionError' && attempt === 0) {
          console.warn(LOG_PREFIX, 'Observed Venice DB version drift, refreshing cached version');
          detectedDBVersion = null;
          continue;
        }

        throw error;
      }
    }

    throw lastError || new Error('Failed to open Venice database');
  }
  
  // ===========================================
  // RxDB database access (venice-rx-db-encrypted)
  // ===========================================

  // Opens the RxDB database WITHOUT creating it. Resolves null if the database
  // does not exist (older Venice builds), so callers can degrade gracefully.
  async function openRxDB() {
    if (rxDbAvailable === false) {
      return null;
    }

    if (typeof indexedDB.databases === 'function') {
      try {
        const databases = await indexedDB.databases();
        if (!databases.some((database) => database.name === RX_DB_NAME)) {
          rxDbAvailable = false;
          return null;
        }
      } catch (error) {
        // databases() can be unavailable/blocked; fall through to open attempt.
      }
    }

    return new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDB.open(RX_DB_NAME);
      } catch (error) {
        reject(error);
        return;
      }

      let aborting = false;
      request.onupgradeneeded = () => {
        // The DB did not exist and is being created at version 1 — abort so we
        // never leave behind an empty database on the Venice origin.
        aborting = true;
        try {
          request.transaction?.abort();
        } catch (abortError) {
          // ignore
        }
      };
      request.onsuccess = () => {
        rxDbAvailable = true;
        resolve(request.result);
      };
      request.onerror = () => {
        if (aborting) {
          rxDbAvailable = false;
          resolve(null);
          return;
        }
        reject(request.error);
      };
      request.onblocked = () => {
        reject(new Error('Venice RxDB database is blocked. Close other Venice.ai tabs and retry.'));
      };
    });
  }

  function escapeForRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // RxDB stores each collection across versioned object stores named
  // `<base>-<schemaVersion>-documents`. Only the highest-version store holds
  // live records (migrations empty the older ones).
  function resolveRxStoreDescriptor(db, base) {
    const pattern = new RegExp('^' + escapeForRegExp(base) + '-(\\d+)-documents$');
    let bestName = null;
    let bestVersion = -1;
    for (const name of Array.from(db.objectStoreNames || [])) {
      const match = pattern.exec(name);
      if (match) {
        const version = Number(match[1]);
        if (Number.isFinite(version) && version > bestVersion) {
          bestVersion = version;
          bestName = name;
        }
      }
    }
    return bestName ? { base, physicalStoreName: bestName, schemaVersion: bestVersion } : null;
  }

  function resolveRxStoreName(db, base) {
    return resolveRxStoreDescriptor(db, base)?.physicalStoreName || null;
  }

  function listRxStoreDescriptors(db) {
    const bestByBase = new Map();
    for (const physicalStoreName of Array.from(db.objectStoreNames || [])) {
      const match = /^(.*)-(\d+)-documents$/.exec(physicalStoreName);
      if (!match || !match[1]) {
        continue;
      }
      const base = match[1];
      const schemaVersion = Number(match[2]);
      const previous = bestByBase.get(base);
      if (!previous || schemaVersion > previous.schemaVersion) {
        bestByBase.set(base, { base, physicalStoreName, schemaVersion });
      }
    }
    return Array.from(bestByBase.values()).sort((left, right) => left.base.localeCompare(right.base));
  }

  function getRxLogicalStoreName(base) {
    return RX_BASE_TO_LOGICAL_STORE.get(base) || `${RX_UNKNOWN_STORE_PREFIX}${base}`;
  }

  function getRxBaseName(storeName) {
    if (RX_LOGICAL_STORES.has(storeName)) {
      return RX_LOGICAL_STORES.get(storeName);
    }
    if (typeof storeName === 'string' && storeName.startsWith(RX_UNKNOWN_STORE_PREFIX)) {
      return storeName.slice(RX_UNKNOWN_STORE_PREFIX.length) || null;
    }
    return null;
  }

  // RxDB/Dexie stores each document inside an envelope { i:<primaryKey>,
  // d:<document>, i0..iN:<index fields> }. The document itself is encrypted with
  // the same key as the legacy database (nested __encryptedData).
  function unwrapRxRecord(record, keyBytes) {
    let doc = record;
    if (record && typeof record === 'object' && !Array.isArray(record) && Object.prototype.hasOwnProperty.call(record, 'd')) {
      doc = record.d;
    }
    if (doc && typeof doc === 'object' && doc.__encryptedData) {
      doc = decryptRecord(doc, keyBytes);
    }
    return doc;
  }

  function stripRxMeta(doc) {
    if (!doc || typeof doc !== 'object') {
      return doc;
    }
    const { _meta, _rev, _attachments, _deleted, ...clean } = doc;
    return clean;
  }

  // Reads and decodes a logical RxDB collection. Returns:
  //   null  -> RxDB database is not present at all
  //   []    -> collection store missing or empty
  //   [...] -> decoded, non-deleted documents (RxDB metadata stripped)
  async function readRxStore(base, keyBytes) {
    const db = await openRxDB();
    if (!db) {
      return null;
    }

    try {
      const storeName = resolveRxStoreName(db, base);
      if (!storeName) {
        return [];
      }

      const raw = await new Promise((resolve, reject) => {
        try {
          const tx = db.transaction([storeName], 'readonly');
          const request = tx.objectStore(storeName).getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
        } catch (error) {
          reject(error);
        }
      });

      const out = [];
      for (const record of raw) {
        const doc = unwrapRxRecord(record, keyBytes);
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
          continue;
        }
        if (doc._deleted === true) {
          continue;
        }
        out.push(stripRxMeta(doc));
      }
      return out;
    } finally {
      try {
        db.close();
      } catch (closeError) {
        // ignore
      }
    }
  }

  function buildEmptyStoreDataResponse(storeName, offset, limit, keyFingerprint, { missing = false } = {}) {
    return {
      success: true,
      command: 'GET_STORE_DATA',
      protocolVersion: MAIN_PROTOCOL_VERSION,
      dbVersion: detectedDBVersion,
      keyFingerprint: keyFingerprint || null,
      storeName,
      count: 0,
      offset,
      limit,
      nextOffset: offset,
      approxBytes: 0,
      done: true,
      pageComplete: true,
      pageTruncated: false,
      missing,
      encrypted: false,
      records: []
    };
  }

  async function getRxStoreData(storeName, options = {}) {
    const offset = Number.isFinite(options.offset) ? Math.max(0, Number(options.offset)) : 0;
    const limit = Number.isFinite(options.limit) ? Math.max(1, Number(options.limit)) : null;
    const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(1024, Number(options.maxBytes)) : null;
    const key = getEncryptionKey();
    const base = getRxBaseName(storeName);

    if (!base) {
      return { success: false, error: `Unknown RxDB store: ${storeName}` };
    }

    if (!key) {
      // Without a key the encrypted RxDB documents cannot be decoded; report the
      // store as empty rather than failing the whole export.
      return buildEmptyStoreDataResponse(storeName, offset, limit, null, { missing: true });
    }

    try {
      const cached = rxStoreReadCache.get(base);
      const all = cached?.keyFingerprint === key.fingerprint
        ? cached.records
        : await readRxStore(base, key.keyBytes);
      if (all === null) {
        // RxDB database absent on this Venice build.
        return buildEmptyStoreDataResponse(storeName, offset, limit, key.fingerprint, { missing: true });
      }
      if (!cached || cached.keyFingerprint !== key.fingerprint) {
        rxStoreReadCache.set(base, { keyFingerprint: key.fingerprint, records: all });
      }

      const slice = [];
      let approxBytes = 0;
      const maxRecords = limit || Number.POSITIVE_INFINITY;
      for (let index = offset; index < all.length && slice.length < maxRecords; index += 1) {
        const record = all[index];
        const encoded = await encodeArchiveTransportValue(record);
        const recordBytes = estimateSerializedBytes(encoded);
        if (maxBytes && slice.length > 0 && approxBytes + recordBytes > maxBytes) {
          break;
        }
        slice.push(encoded);
        approxBytes += recordBytes;
        if (maxBytes && approxBytes >= maxBytes) {
          break;
        }
      }
      const nextOffset = offset + slice.length;
      const done = nextOffset >= all.length;

      return {
        success: true,
        command: 'GET_STORE_DATA',
        protocolVersion: MAIN_PROTOCOL_VERSION,
        dbVersion: detectedDBVersion,
        keyFingerprint: key.fingerprint || null,
        storeName,
        count: slice.length,
        offset,
        limit,
        nextOffset,
        approxBytes,
        done,
        pageComplete: done,
        pageTruncated: !done,
        encrypted: false,
        records: slice
      };
    } catch (error) {
      console.warn(LOG_PREFIX, `Could not read RxDB store ${storeName}:`, error.message);
      return buildEmptyStoreDataResponse(storeName, offset, limit, key.fingerprint, { missing: true });
    }
  }

  async function getRxStoreInventory(keyBytes) {
    const inventory = [];
    const db = await openRxDB();
    if (!db) {
      return inventory;
    }

    const activeKeyFingerprint = keyBytes ? (getEncryptionKey()?.fingerprint || null) : null;

    let descriptors;
    try {
      descriptors = listRxStoreDescriptors(db);
    } finally {
      try { db.close(); } catch (_) { /* ignore */ }
    }

    for (const descriptor of descriptors) {
      const logicalName = getRxLogicalStoreName(descriptor.base);
      try {
        const records = keyBytes ? await readRxStore(descriptor.base, keyBytes) : null;
        if (records === null) {
          continue; // RxDB unavailable — omit entirely
        }
        inventory.push({
          name: logicalName,
          count: records.length,
          source: 'rxdb',
          physicalStoreName: descriptor.physicalStoreName,
          schemaVersion: descriptor.schemaVersion,
          // Counts alone cannot detect an in-place edit while an export is
          // running. Hash the decoded snapshot that backs all subsequent
          // paged reads; the closing inventory pass performs a fresh read and
          // the backup page rejects any changed fingerprint.
          fingerprint: await captureRecordSetFingerprint(records, encodeArchiveTransportValue)
        });
        rxStoreReadCache.set(descriptor.base, {
          keyFingerprint: activeKeyFingerprint,
          records
        });
      } catch (error) {
        rxStoreReadCache.delete(descriptor.base);
        inventory.push({
          name: logicalName,
          count: null,
          source: 'rxdb',
          physicalStoreName: descriptor.physicalStoreName,
          schemaVersion: descriptor.schemaVersion,
          error: error.message
        });
      }
    }
    return inventory;
  }

  function getRxPhysicalLogicalStoreName(physicalStoreName) {
    return `${RX_PHYSICAL_STORE_PREFIX}${encodeURIComponent(physicalStoreName)}`;
  }

  function getRxPhysicalStoreName(logicalName) {
    if (typeof logicalName !== 'string' || !logicalName.startsWith(RX_PHYSICAL_STORE_PREFIX)) return null;
    try {
      return decodeURIComponent(logicalName.slice(RX_PHYSICAL_STORE_PREFIX.length)) || null;
    } catch (_) {
      return null;
    }
  }

  async function readRxPhysicalStore(physicalStoreName) {
    const db = await openRxDB();
    if (!db) return null;
    try {
      if (!db.objectStoreNames.contains(physicalStoreName)) return [];
      const raw = await new Promise((resolve, reject) => {
        const tx = db.transaction([physicalStoreName], 'readonly');
        const request = tx.objectStore(physicalStoreName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error(`Could not read RxDB physical store ${physicalStoreName}.`));
      });
      return raw;
    } finally {
      try { db.close(); } catch (_) { /* ignore */ }
    }
  }

  async function getRxPhysicalStoreInventory() {
    const db = await openRxDB();
    if (!db) return [];
    let physicalStoreNames;
    let databaseVersion;
    try {
      physicalStoreNames = Array.from(db.objectStoreNames || []).sort();
      databaseVersion = db.version;
    } finally {
      try { db.close(); } catch (_) { /* ignore */ }
    }

    const inventory = [];
    for (const physicalStoreName of physicalStoreNames) {
      const logicalName = getRxPhysicalLogicalStoreName(physicalStoreName);
      try {
        const records = await readRxPhysicalStore(physicalStoreName);
        if (records === null) continue;
        inventory.push({
          name: logicalName,
          count: records.length,
          source: 'rxdb-physical',
          encrypted: true,
          databaseName: RX_DB_NAME,
          physicalStoreName,
          schemaVersion: databaseVersion,
          fingerprint: await captureRecordSetFingerprint(records, encodeArchiveTransportValue)
        });
        rxPhysicalStoreReadCache.set(physicalStoreName, { databaseVersion, records });
      } catch (error) {
        rxPhysicalStoreReadCache.delete(physicalStoreName);
        inventory.push({
          name: logicalName,
          count: null,
          source: 'rxdb-physical',
          databaseName: RX_DB_NAME,
          physicalStoreName,
          schemaVersion: databaseVersion,
          error: error.message
        });
      }
    }
    return inventory;
  }

  async function getRxPhysicalStoreData(storeName, options = {}) {
    const physicalStoreName = getRxPhysicalStoreName(storeName);
    if (!physicalStoreName) return { success: false, error: `Unknown RxDB physical store: ${storeName}` };
    const offset = Number.isFinite(options.offset) ? Math.max(0, Number(options.offset)) : 0;
    const limit = Number.isFinite(options.limit) ? Math.max(1, Number(options.limit)) : 100;
    const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(1024, Number(options.maxBytes)) : null;
    const cached = rxPhysicalStoreReadCache.get(physicalStoreName);
    const all = cached?.records || await readRxPhysicalStore(physicalStoreName);
    if (all === null) return buildEmptyStoreDataResponse(storeName, offset, limit, getEncryptionKey()?.fingerprint || null, { missing: true });
    if (!cached) rxPhysicalStoreReadCache.set(physicalStoreName, { databaseVersion: null, records: all });

    const records = [];
    let approxBytes = 0;
    for (let index = offset; index < all.length && records.length < limit; index += 1) {
      const record = await encodeArchiveTransportValue(all[index]);
      const bytes = estimateSerializedBytes(record);
      if (maxBytes && records.length > 0 && approxBytes + bytes > maxBytes) break;
      records.push(record);
      approxBytes += bytes;
      if (maxBytes && approxBytes >= maxBytes) break;
    }
    const nextOffset = offset + records.length;
    const done = nextOffset >= all.length;
    return {
      success: true,
      command: 'GET_STORE_DATA',
      protocolVersion: MAIN_PROTOCOL_VERSION,
      dbVersion: detectedDBVersion,
      keyFingerprint: getEncryptionKey()?.fingerprint || null,
      storeName,
      count: records.length,
      offset,
      limit,
      nextOffset,
      approxBytes,
      done,
      pageComplete: done,
      pageTruncated: !done,
      encrypted: true,
      records
    };
  }

  function genericIdbCacheKey(databaseName, storeName) {
    return `${databaseName}\u0000${storeName}`;
  }

  function getGenericIdbLogicalStoreName(databaseName, storeName) {
    return GENERIC_IDB_PHYSICAL_TO_LOGICAL.get(genericIdbCacheKey(databaseName, storeName))
      || `${GENERIC_IDB_STORE_PREFIX}${encodeURIComponent(databaseName)}:${encodeURIComponent(storeName)}`;
  }

  function getGenericIdbDescriptor(logicalName) {
    if (GENERIC_IDB_KNOWN_STORES.has(logicalName)) {
      return GENERIC_IDB_KNOWN_STORES.get(logicalName);
    }
    if (typeof logicalName !== 'string' || !logicalName.startsWith(GENERIC_IDB_STORE_PREFIX)) {
      return null;
    }
    const encoded = logicalName.slice(GENERIC_IDB_STORE_PREFIX.length);
    const separator = encoded.indexOf(':');
    if (separator < 1 || separator >= encoded.length - 1) {
      return null;
    }
    try {
      const databaseName = decodeURIComponent(encoded.slice(0, separator));
      const storeName = decodeURIComponent(encoded.slice(separator + 1));
      return databaseName && storeName ? { databaseName, storeName } : null;
    } catch (_) {
      return null;
    }
  }

  function isSensitiveArchiveFieldName(name) {
    return /^(?:accessToken|refreshToken|idToken|authToken|oauthToken|password|secret|privateKey|credential)$/i.test(String(name || '').replace(/[-_.]/g, ''));
  }

  // Chrome extension messaging JSON-serializes values. Convert structured-
  // clone types explicitly so a newly discovered store containing bytes does
  // not silently turn ArrayBuffers, typed arrays, Maps, Sets, or Blobs into {}.
  async function encodeArchiveTransportValue(value, seen = new WeakSet()) {
    if (value == null || typeof value === 'string' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : { __veniceArchiveType: 'number', value: String(value) };
    }
    if (typeof value === 'bigint') {
      return { __veniceArchiveType: 'bigint', value: value.toString() };
    }
    if (typeof value !== 'object') {
      return { __veniceArchiveType: typeof value, value: String(value) };
    }
    if (seen.has(value)) {
      return { __veniceArchiveType: 'circular-reference' };
    }
    seen.add(value);

    if (value instanceof Date) {
      return { __veniceArchiveType: 'date', value: value.toISOString() };
    }
    if (value instanceof ArrayBuffer) {
      return {
        __veniceArchiveType: 'binary',
        encoding: 'base64',
        data: uint8ArrayToBase64(new Uint8Array(value))
      };
    }
    if (ArrayBuffer.isView(value)) {
      return {
        __veniceArchiveType: value.constructor?.name || 'typed-array',
        encoding: 'base64',
        data: uint8ArrayToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
      };
    }
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      return {
        __veniceArchiveType: typeof File !== 'undefined' && value instanceof File ? 'file' : 'blob',
        encoding: 'base64',
        mimeType: value.type || null,
        name: typeof File !== 'undefined' && value instanceof File ? value.name : null,
        lastModified: typeof File !== 'undefined' && value instanceof File ? value.lastModified : null,
        size: value.size,
        data: uint8ArrayToBase64(new Uint8Array(await value.arrayBuffer()))
      };
    }
    if (Array.isArray(value)) {
      const result = [];
      for (const entry of value) result.push(await encodeArchiveTransportValue(entry, seen));
      return result;
    }
    if (value instanceof Map) {
      const entries = [];
      for (const [key, entry] of value.entries()) {
        entries.push([
          await encodeArchiveTransportValue(key, seen),
          await encodeArchiveTransportValue(entry, seen)
        ]);
      }
      return { __veniceArchiveType: 'map', entries };
    }
    if (value instanceof Set) {
      const values = [];
      for (const entry of value.values()) values.push(await encodeArchiveTransportValue(entry, seen));
      return { __veniceArchiveType: 'set', values };
    }

    const result = {};
    for (const key of Object.keys(value)) {
      result[key] = isSensitiveArchiveFieldName(key)
        ? { __veniceArchiveRedacted: true, reason: 'Credential field intentionally excluded.' }
        : await encodeArchiveTransportValue(value[key], seen);
    }
    return result;
  }

  async function openExistingGenericIdb(databaseName) {
    if (typeof indexedDB.databases !== 'function') {
      throw new Error('IndexedDB database enumeration is unavailable; total origin coverage cannot be verified in this browser.');
    }
    const databases = await indexedDB.databases();
    const descriptor = databases.find((database) => database.name === databaseName);
    if (!descriptor) return null;

    return new Promise((resolve, reject) => {
      let request;
      let aborting = false;
      try {
        request = descriptor.version
          ? indexedDB.open(databaseName, descriptor.version)
          : indexedDB.open(databaseName);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        aborting = true;
        try { request.transaction?.abort(); } catch (_) { /* ignore */ }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        if (aborting) resolve(null);
        else reject(request.error || new Error(`Could not open IndexedDB database ${databaseName}.`));
      };
      request.onblocked = () => reject(new Error(`IndexedDB database ${databaseName} is blocked. Close other Venice.ai tabs and retry.`));
    });
  }

  async function readGenericIdbStore(databaseName, storeName, keyBytes) {
    const db = await openExistingGenericIdb(databaseName);
    if (!db) return null;
    try {
      if (!db.objectStoreNames.contains(storeName)) return [];
      const raw = await new Promise((resolve, reject) => {
        const tx = db.transaction([storeName], 'readonly');
        const request = tx.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error(`Could not read ${databaseName}/${storeName}.`));
      });
      return raw.map((record) => keyBytes ? decryptRecord(record, keyBytes) : record);
    } finally {
      try { db.close(); } catch (_) { /* ignore */ }
    }
  }

  async function getGenericIdbStoreInventory(keyBytes) {
    if (typeof indexedDB.databases !== 'function') {
      throw new Error('IndexedDB database enumeration is unavailable; total origin coverage cannot be verified in this browser.');
    }
    const databases = (await indexedDB.databases())
      .filter((database) => database?.name && !GENERIC_IDB_EXCLUDED_DATABASES.has(database.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    const inventory = [];
    const activeKeyFingerprint = keyBytes ? (getEncryptionKey()?.fingerprint || null) : null;

    for (const database of databases) {
      const db = await openExistingGenericIdb(database.name);
      if (!db) continue;
      let storeNames;
      let schemaVersion;
      try {
        storeNames = Array.from(db.objectStoreNames || []).sort();
        schemaVersion = db.version;
      } finally {
        try { db.close(); } catch (_) { /* ignore */ }
      }
      for (const storeName of storeNames) {
        const logicalName = getGenericIdbLogicalStoreName(database.name, storeName);
        const cacheKey = genericIdbCacheKey(database.name, storeName);
        try {
          const records = await readGenericIdbStore(database.name, storeName, keyBytes);
          if (records === null) continue;
          inventory.push({
            name: logicalName,
            count: records.length,
            source: 'indexedDB',
            databaseName: database.name,
            physicalStoreName: storeName,
            schemaVersion,
          fingerprint: await captureRecordSetFingerprint(records, encodeArchiveTransportValue)
          });
          genericIdbStoreReadCache.set(cacheKey, { keyFingerprint: activeKeyFingerprint, records });
        } catch (error) {
          genericIdbStoreReadCache.delete(cacheKey);
          inventory.push({
            name: logicalName,
            count: null,
            source: 'indexedDB',
            databaseName: database.name,
            physicalStoreName: storeName,
            schemaVersion,
            error: error.message
          });
        }
      }
    }
    return inventory;
  }

  async function getGenericIdbStoreData(storeName, options = {}) {
    const descriptor = getGenericIdbDescriptor(storeName);
    if (!descriptor) return { success: false, error: `Unknown IndexedDB source store: ${storeName}` };
    const offset = Number.isFinite(options.offset) ? Math.max(0, Number(options.offset)) : 0;
    const limit = Number.isFinite(options.limit) ? Math.max(1, Number(options.limit)) : 100;
    const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(1024, Number(options.maxBytes)) : null;
    const key = getEncryptionKey();
    const cacheKey = genericIdbCacheKey(descriptor.databaseName, descriptor.storeName);
    const cached = genericIdbStoreReadCache.get(cacheKey);
    const all = cached?.keyFingerprint === (key?.fingerprint || null)
      ? cached.records
      : await readGenericIdbStore(descriptor.databaseName, descriptor.storeName, key?.keyBytes || null);
    if (all === null) {
      return buildEmptyStoreDataResponse(storeName, offset, limit, key?.fingerprint || null, { missing: true });
    }
    if (!cached || cached.keyFingerprint !== (key?.fingerprint || null)) {
      genericIdbStoreReadCache.set(cacheKey, { keyFingerprint: key?.fingerprint || null, records: all });
    }

    const page = [];
    let approxBytes = 0;
    for (let index = offset; index < all.length && page.length < limit; index += 1) {
      const record = await encodeArchiveTransportValue(all[index]);
      const bytes = estimateSerializedBytes(record);
      if (maxBytes && page.length > 0 && approxBytes + bytes > maxBytes) break;
      page.push(record);
      approxBytes += bytes;
      if (maxBytes && approxBytes >= maxBytes) break;
    }
    const nextOffset = offset + page.length;
    const done = nextOffset >= all.length;
    return {
      success: true,
      command: 'GET_STORE_DATA',
      protocolVersion: MAIN_PROTOCOL_VERSION,
      dbVersion: detectedDBVersion,
      keyFingerprint: key?.fingerprint || null,
      storeName,
      count: page.length,
      offset,
      limit,
      nextOffset,
      approxBytes,
      done,
      pageComplete: done,
      pageTruncated: !done,
      encrypted: false,
      records: page
    };
  }

  async function getAllFromStore(storeName) {
    const db = await openDB();
    try {
      return await readAllFromOpenStore(db, storeName);
    } finally {
      db.close();
    }
  }

  function readAllFromOpenStore(db, storeName) {
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction([storeName], 'readonly');
        const request = tx.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error(`Failed to read ${storeName}.`));
      } catch (error) {
        reject(error);
      }
    });
  }

  function estimateSerializedBytes(value) {
    const seen = new WeakSet();
    const estimate = (entry) => {
      if (entry == null) return 4;
      if (typeof entry === 'string') return entry.length + 2;
      if (typeof entry === 'boolean') return entry ? 4 : 5;
      if (typeof entry === 'number') return 16;
      if (typeof entry !== 'object') return 16;
      if (seen.has(entry)) return 24;
      seen.add(entry);

      if (typeof Blob !== 'undefined' && entry instanceof Blob) {
        // Chrome extension messages JSON-encode the transport value. A Blob
        // therefore becomes a base64 payload, not the small `{}` that a plain
        // JSON.stringify(Blob) estimate would report.
        return 96 + Math.ceil(entry.size * 4 / 3);
      }
      if (entry instanceof ArrayBuffer) {
        return 64 + Math.ceil(entry.byteLength * 4 / 3);
      }
      if (ArrayBuffer.isView(entry)) {
        return 64 + Math.ceil(entry.byteLength * 4 / 3);
      }
      if (Array.isArray(entry)) {
        return 2 + entry.reduce((total, child) => total + estimate(child), 0);
      }

      return 2 + Object.entries(entry).reduce((total, [key, child]) => (
        total + key.length + estimate(child)
      ), 0);
    };

    return estimate(value);
  }

  async function getStorePageFromCursor(storeName, options = {}) {
    const db = await openDB();
    const offset = Number.isFinite(options.offset) ? Math.max(0, Number(options.offset)) : 0;
    const limit = Number.isFinite(options.limit) ? Math.max(1, Number(options.limit)) : 100;
    const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(1024, Number(options.maxBytes)) : null;
    const transformRecord = typeof options.transformRecord === 'function' ? options.transformRecord : (record) => record;

    return new Promise((resolve, reject) => {
      let records = [];
      let skipped = false;
      let settled = false;
      let done = true;
      let approxBytes = 0;

      const finalize = (callback, payload) => {
        if (settled) {
          return;
        }
        settled = true;
        callback(payload);
      };

      try {
        const tx = db.transaction([storeName], 'readonly');
        const store = tx.objectStore(storeName);
        const request = store.openCursor();

        tx.oncomplete = () => {
          db.close();
          finalize(resolve, {
            records,
            done,
            nextOffset: offset + records.length,
            approxBytes
          });
        };

        tx.onabort = tx.onerror = () => {
          const error = tx.error || new Error(`Failed to page ${storeName}`);
          db.close();
          finalize(reject, error);
        };

        request.onerror = () => {
          db.close();
          finalize(reject, request.error);
        };

        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            return;
          }

          if (!skipped && offset > 0) {
            skipped = true;
            cursor.advance(offset);
            return;
          }

          skipped = true;
          const record = transformRecord(cursor.value);
          const recordBytes = estimateSerializedBytes(record);

          if (maxBytes && records.length > 0 && approxBytes + recordBytes > maxBytes) {
            done = false;
            return;
          }

          if (maxBytes && records.length === 0 && recordBytes > maxBytes) {
            done = false;
          }

          records.push(record);
          approxBytes += recordBytes;

          if (records.length >= limit) {
            done = false;
            return;
          }

          cursor.continue();
        };
      } catch (error) {
        db.close();
        finalize(reject, error);
      }
    });
  }

  async function getStoreInventory() {
    const db = await openDB();

    try {
      const storeNames = Array.from(db.objectStoreNames || []);
      const inventory = [];

      for (const storeName of storeNames) {
        try {
          const records = await readAllFromOpenStore(db, storeName);
          inventory.push({
            name: storeName,
            count: records.length,
            source: 'legacy',
            databaseName: DB_NAME,
            physicalStoreName: storeName,
            schemaVersion: db.version,
            fingerprint: await captureRecordSetFingerprint(records, encodeArchiveTransportValue)
          });
          legacyStoreReadCache.set(storeName, { dbVersion: db.version, records });
        } catch (error) {
          legacyStoreReadCache.delete(storeName);
          inventory.push({ name: storeName, count: null, error: error.message });
        }
      }

      return inventory;
    } finally {
      db.close();
    }
  }

  async function getStoreInventoryResponse(options = {}) {
    const key = getEncryptionKey();
    const requestedNames = Array.isArray(options.storeNames)
      ? new Set(options.storeNames.map((name) => String(name)))
      : null;
    const browserStateOnly = requestedNames?.size > 0
      && [...requestedNames].every((name) => name === BROWSER_LOCAL_STORAGE_STORE || name === BROWSER_SESSION_STORAGE_STORE);

    if (browserStateOnly) {
      const storeInventory = [];
      if (requestedNames.has(BROWSER_LOCAL_STORAGE_STORE)) {
        const records = getArchiveLocalStorageRecords();
        storeInventory.push({
          name: BROWSER_LOCAL_STORAGE_STORE,
          count: records.length,
          source: 'localStorage',
          physicalStoreName: 'window.localStorage',
          schemaVersion: 1,
          mutableDuringExport: true,
          fingerprint: await captureRecordSetFingerprint(records)
        });
      }
      if (requestedNames.has(BROWSER_SESSION_STORAGE_STORE)) {
        const records = getArchiveSessionStorageRecords();
        storeInventory.push({
          name: BROWSER_SESSION_STORAGE_STORE,
          count: records.length,
          source: 'sessionStorage',
          physicalStoreName: 'window.sessionStorage',
          schemaVersion: 1,
          mutableDuringExport: true,
          fingerprint: await captureRecordSetFingerprint(records)
        });
      }
      return {
        success: true,
        command: 'GET_STORE_INVENTORY',
        protocolVersion: MAIN_PROTOCOL_VERSION,
        dbVersion: detectedDBVersion,
        keyFingerprint: key?.fingerprint || null,
        storeInventory
      };
    }
    const storeInventory = await getStoreInventory();

    // Append logical RxDB stores (regular/Mind chats, videos, newer media).
    // A present-but-unreadable database must abort total-coverage inventory;
    // only a genuinely absent database is allowed to return an empty list.
    const rxInventory = await getRxStoreInventory(key?.keyBytes || null);
    storeInventory.push(...rxInventory);

    // Preserve every physical RxDB object store as a raw recovery layer in
    // addition to the decoded highest-version collection projections above.
    // This includes attachment, write-ahead, internal, and older migration
    // stores whenever they contain records.
    const rxPhysicalInventory = await getRxPhysicalStoreInventory();
    storeInventory.push(...rxPhysicalInventory);

    // Enumerate every additional origin-scoped IndexedDB database/store. This
    // currently captures video-studio-recovery/activeGenerations and protects
    // against Venice moving future Studio/content state into another database.
    const genericIdbInventory = await getGenericIdbStoreInventory(key?.keyBytes || null);
    storeInventory.push(...genericIdbInventory);

    const browserStateRecords = getArchiveLocalStorageRecords();
    storeInventory.push({
      name: BROWSER_LOCAL_STORAGE_STORE,
      count: browserStateRecords.length,
      source: 'localStorage',
      physicalStoreName: 'window.localStorage',
      schemaVersion: 1,
      mutableDuringExport: true,
      fingerprint: await captureRecordSetFingerprint(browserStateRecords)
    });

    const browserSessionStateRecords = getArchiveSessionStorageRecords();
    storeInventory.push({
      name: BROWSER_SESSION_STORAGE_STORE,
      count: browserSessionStateRecords.length,
      source: 'sessionStorage',
      physicalStoreName: 'window.sessionStorage',
      schemaVersion: 1,
      mutableDuringExport: true,
      fingerprint: await captureRecordSetFingerprint(browserSessionStateRecords)
    });

    return {
      success: true,
      command: 'GET_STORE_INVENTORY',
      protocolVersion: MAIN_PROTOCOL_VERSION,
      dbVersion: detectedDBVersion,
      keyFingerprint: key?.fingerprint || null,
      storeInventory
    };
  }

  async function scanStoreRecords(storeName, onRecord) {
    const db = await openDB();

    return new Promise((resolve, reject) => {
      let settled = false;
      let scanError = null;

      const finalize = (callback, payload) => {
        if (settled) {
          return;
        }
        settled = true;
        callback(payload);
      };

      try {
        const tx = db.transaction([storeName], 'readonly');
        const store = tx.objectStore(storeName);
        const request = store.openCursor();

        tx.oncomplete = () => {
          db.close();
          finalize(resolve);
        };

        tx.onabort = tx.onerror = () => {
          db.close();
          finalize(reject, scanError || tx.error || new Error(`Failed to scan ${storeName}`));
        };

        request.onerror = () => {
          db.close();
          finalize(reject, request.error);
        };

        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            return;
          }

          try {
            onRecord(cursor.value);
          } catch (error) {
            scanError = error;
            tx.abort();
            return;
          }

          cursor.continue();
        };
      } catch (error) {
        db.close();
        finalize(reject, error);
      }
    });
  }

  function estimateStoreBytesFromSample(totalCount, sampleCount, sampleBytes) {
    if (!totalCount || !sampleCount || !sampleBytes) {
      return 0;
    }

    return Math.round((sampleBytes / sampleCount) * totalCount);
  }

  function truncatePreview(text, maxLength = 180) {
    if (!text) {
      return '';
    }

    return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
  }

  async function buildLightweightSnapshotSummary(key, storeInventory) {
    const conversationsRaw = await getAllFromStore('conversations');
    const conversations = decryptRecords(conversationsRaw, key.keyBytes);
    const conversationIds = new Set(conversations.map((conversation) => conversation.id));
    const messageCountByConversation = new Map();
    const messageConversationMap = new Map();
    const latestMessageByConversation = new Map();
    const mediaCountByConversation = new Map();
    const messagePreviewMap = new Map();

    let totalMessageCount = 0;
    let messagesMissingConversation = 0;
    let messageSampleCount = 0;
    let messageSampleBytes = 0;

    await scanStoreRecords('messages', (record) => {
      totalMessageCount += 1;

      if (messageSampleCount < 12) {
        messageSampleBytes += estimateSerializedBytes(record);
        messageSampleCount += 1;
      }

      const conversationId = record.conversationId || '__unknown__';
      messageConversationMap.set(record.id, conversationId);
      messageCountByConversation.set(conversationId, (messageCountByConversation.get(conversationId) || 0) + 1);

      if (record.conversationId && !conversationIds.has(record.conversationId)) {
        messagesMissingConversation += 1;
      }

      const timestamp = record.updatedAtUnixTimestamp || record.createdAtUnixTimestamp || 0;
      const previous = latestMessageByConversation.get(conversationId);
      if (!previous || timestamp >= previous.timestamp) {
        latestMessageByConversation.set(conversationId, { timestamp, record });
      }
    });

    let mediaCount = 0;
    let imageCount = 0;
    let videoCount = 0;
    let audioCount = 0;
    let fileCount = 0;
    let orphanCount = 0;
    let messageImageCount = 0;
    let messageImageTotalBytes = 0;
    const messageImagesStore = storeInventory.find((store) => store.name === 'messageImages');

    if ((messageImagesStore?.count ?? 0) > 0) {
      try {
        await scanStoreRecords('messageImages', (record) => {
          messageImageCount += 1;
          mediaCount += 1;
          messageImageTotalBytes += estimateSerializedBytes(record);

          const conversationId = record.conversationId || (record.messageId ? messageConversationMap.get(record.messageId) || '__unknown__' : '__unknown__');
          mediaCountByConversation.set(conversationId, (mediaCountByConversation.get(conversationId) || 0) + 1);

          const inferredKind = classifyMediaKind(record);
          const kind = inferredKind === 'asset' ? 'image' : inferredKind;
          if (kind === 'video') videoCount += 1;
          else if (kind === 'audio') audioCount += 1;
          else if (kind === 'file') fileCount += 1;
          else imageCount += 1;

          if (conversationId === '__unknown__') {
            orphanCount += 1;
          }
        });
      } catch (error) {
        console.warn(LOG_PREFIX, 'Could not scan messageImages for lightweight summary:', error.message);
      }
    }

    const previewConversationIds = conversations
      .slice()
      .sort((left, right) => {
        const rightTime = right.updatedAtUnixTimestamp || right.createdAtUnixTimestamp || 0;
        const leftTime = left.updatedAtUnixTimestamp || left.createdAtUnixTimestamp || 0;
        return rightTime - leftTime;
      })
      .slice(0, 12)
      .map((conversation) => conversation.id);

    previewConversationIds.forEach((conversationId) => {
      const latestMessage = latestMessageByConversation.get(conversationId);
      if (!latestMessage) {
        return;
      }

      const decrypted = decryptRecord(latestMessage.record, key.keyBytes);
      const preview = truncatePreview(extractMessageTextPreview(decrypted));
      if (preview) {
        messagePreviewMap.set(conversationId, preview);
      }
    });

    const conversationIndex = conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title || 'Untitled conversation',
      createdAt: conversation.createdAtUnixTimestamp || null,
      updatedAt: conversation.updatedAtUnixTimestamp || conversation.createdAtUnixTimestamp || null,
      messageCount: messageCountByConversation.get(conversation.id) || 0,
      mediaCount: mediaCountByConversation.get(conversation.id) || 0,
      preview: messagePreviewMap.get(conversation.id) || 'Preview omitted for quick scan'
    }));

    const unknownConversationIds = new Set(messageCountByConversation.keys());
    conversations.forEach((conversation) => unknownConversationIds.delete(conversation.id));
    unknownConversationIds.delete('__unknown__');

    unknownConversationIds.forEach((conversationId) => {
      conversationIndex.push({
        id: conversationId,
        title: 'Recovered conversation reference',
        createdAt: null,
        updatedAt: null,
        messageCount: messageCountByConversation.get(conversationId) || 0,
        mediaCount: mediaCountByConversation.get(conversationId) || 0,
        preview: 'Messages were captured without a matching conversation record.'
      });
    });

    conversationIndex.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));

    const estimatedSizeBytes = estimateSerializedBytes(conversationsRaw) +
      estimateStoreBytesFromSample(totalMessageCount, messageSampleCount, messageSampleBytes) +
      messageImageTotalBytes;

    return {
      capturedAt: new Date().toISOString(),
      stats: {
        conversationCount: conversations.length,
        messageCount: totalMessageCount,
        mediaCount,
        imageCount,
        videoCount,
        audioCount,
        fileCount,
        orphanCount,
        messageImageCount,
        messageImagesStoreCount: messageImagesStore?.count ?? messageImageCount,
        messagesMissingConversation,
        storeCount: storeInventory.length,
        keyFingerprint: key.fingerprint
      },
      conversationIndex,
      mediaItems: [],
      estimatedSizeBytes
    };
  }

  function extractMessageTextPreview(message) {
    if (!message) {
      return '';
    }

    if (typeof message.content === 'string') {
      return message.content;
    }

    if (Array.isArray(message.content)) {
      return message.content
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join(' ');
    }

    if (typeof message.text === 'string') {
      return message.text;
    }

    return '';
  }

  function getMediaUrl(value) {
    if (!value) {
      return null;
    }

    if (typeof value === 'string') {
      return looksLikeMediaReference(value) ? value : null;
    }

    const keys = ['url', 'imageUrl', 'videoUrl', 'fileUrl', 'mediaUrl', 'downloadUrl', 'previewUrl', 'src', 'href', 'dataUrl', 'imageData'];
    for (const key of keys) {
      if (value[key]) {
        const nested = getMediaUrl(value[key]);
        if (nested) {
          return nested;
        }
      }
    }

    return null;
  }

  function looksLikeMediaReference(value) {
    if (typeof value !== 'string') {
      return false;
    }

    return value.startsWith('data:') ||
      value.startsWith('blob:') ||
      value.startsWith('http://') ||
      value.startsWith('https://') ||
      value.startsWith('//');
  }

  function hasInlineData(value) {
    const url = getMediaUrl(value);
    return typeof url === 'string' && url.startsWith('data:');
  }

  function getMimeType(value) {
    if (!value || typeof value !== 'object') {
      return null;
    }

    return value.mimeType || value.mime_type || value.contentType || value.type || null;
  }

  function classifyMediaKind(value) {
    const url = typeof value === 'object' ? getMediaUrl(value) : typeof value === 'string' ? value : '';
    const signal = `${typeof value === 'object' ? value.type || '' : ''} ${getMimeType(value) || ''} ${url || ''}`.toLowerCase();

    if (signal.includes('video') || /\.(mp4|mov|webm|m4v)(?:$|\?)/.test(signal)) {
      return 'video';
    }

    if (signal.includes('audio') || /\.(mp3|wav|ogg|m4a)(?:$|\?)/.test(signal)) {
      return 'audio';
    }

    if (signal.includes('image') || /\.(png|jpg|jpeg|gif|webp|svg)(?:$|\?)/.test(signal)) {
      return 'image';
    }

    if (signal.includes('file') || signal.includes('attachment') || signal.includes('document')) {
      return 'file';
    }

    return 'asset';
  }

  function collectMediaReferencesDeep(value, depth = 0, results = new Set(), seen = new WeakSet()) {
    if (depth > 5 || value == null) {
      return results;
    }

    if (typeof value === 'string') {
      if (looksLikeMediaReference(value)) {
        results.add(value);
      }
      return results;
    }

    if (typeof value !== 'object') {
      return results;
    }

    if (value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof Blob) {
      return results;
    }

    if (seen.has(value)) {
      return results;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry) => collectMediaReferencesDeep(entry, depth + 1, results, seen));
      return results;
    }

    const entries = Object.entries(value);
    const isNumericRecord = entries.length > 64 && entries.every(([key]) => /^\d+$/.test(key));
    if (isNumericRecord) {
      return results;
    }

    for (const [key, nested] of entries) {
      if (key === '__encryptedData') {
        continue;
      }

      if (typeof nested === 'string' && looksLikeMediaReference(nested)) {
        results.add(nested);
        continue;
      }

      collectMediaReferencesDeep(nested, depth + 1, results, seen);
    }

    return results;
  }

  function extractMessageMediaCandidates(message) {
    const candidates = [];
    const messageId = message.id || null;
    const conversationId = message.conversationId || null;

    const pushCandidate = (payload, source, forcedKind = null) => {
      const normalizedPayload = typeof payload === 'string' ? { url: payload } : payload;
      const url = getMediaUrl(normalizedPayload);
      const inline = hasInlineData(normalizedPayload);
      const mimeType = getMimeType(normalizedPayload);
      const kind = forcedKind || classifyMediaKind({ ...(normalizedPayload || {}), url, mimeType });

      if (!url && !inline) {
        return;
      }

      candidates.push({
        id: normalizedPayload?.id || null,
        messageId,
        conversationId,
        url,
        inline,
        mimeType,
        kind,
        source
      });
    };

    if (Array.isArray(message.content)) {
      message.content.forEach((part) => {
        if (!part || part.type === 'text') {
          return;
        }

        if (part.image_url) {
          pushCandidate(part.image_url, 'message.content.image_url', 'image');
          return;
        }

        if (part.video_url) {
          pushCandidate(part.video_url, 'message.content.video_url', 'video');
          return;
        }

        pushCandidate(part, `message.content.${part.type || 'asset'}`);
      });
    }

    if (Array.isArray(message.attachments)) {
      message.attachments.forEach((attachment) => {
        pushCandidate(attachment, 'message.attachments');
      });
    }

    [
      ['imageUrl', 'image'],
      ['videoUrl', 'video'],
      ['fileUrl', 'file'],
      ['mediaUrl', null],
      ['previewUrl', 'image']
    ].forEach(([field, forcedKind]) => {
      if (message[field]) {
        pushCandidate({ url: message[field] }, `message.${field}`, forcedKind);
      }
    });

    return candidates;
  }

  function summarizeSnapshotState(conversations, messages, messageImages, storeInventory, keyFingerprint, estimatedSizeBytes = 0) {
    const conversationIds = new Set(conversations.map((conversation) => conversation.id));
    const messageConversationMap = new Map();
    const messagePreviewMap = new Map();
    const messageCountByConversation = new Map();
    const mediaCountByConversation = new Map();
    const seenMedia = new Set();

    const mediaTotals = {
      mediaCount: 0,
      imageCount: 0,
      videoCount: 0,
      audioCount: 0,
      fileCount: 0,
      orphanCount: 0
    };

    const incrementMedia = (mediaItem) => {
      const signature = [mediaItem.kind, mediaItem.messageId || '', mediaItem.url || '', mediaItem.source || '', mediaItem.id || ''].join('|');
      if (seenMedia.has(signature)) {
        return;
      }
      seenMedia.add(signature);

      mediaTotals.mediaCount += 1;
      if (mediaItem.kind === 'image') mediaTotals.imageCount += 1;
      if (mediaItem.kind === 'video') mediaTotals.videoCount += 1;
      if (mediaItem.kind === 'audio') mediaTotals.audioCount += 1;
      if (mediaItem.kind === 'file') mediaTotals.fileCount += 1;
      if (mediaItem.orphaned) mediaTotals.orphanCount += 1;

      const conversationId = mediaItem.conversationId || '__unknown__';
      mediaCountByConversation.set(conversationId, (mediaCountByConversation.get(conversationId) || 0) + 1);
    };

    messages.forEach((message) => {
      const conversationId = message.conversationId || '__unknown__';
      messageConversationMap.set(message.id, conversationId);
      messageCountByConversation.set(conversationId, (messageCountByConversation.get(conversationId) || 0) + 1);

      const preview = extractMessageTextPreview(message);
      if (preview && !messagePreviewMap.has(conversationId)) {
        messagePreviewMap.set(conversationId, preview.length > 180 ? `${preview.slice(0, 177)}...` : preview);
      }

      extractMessageMediaCandidates(message).forEach((mediaItem) => {
        incrementMedia({
          ...mediaItem,
          orphaned: mediaItem.messageId ? !messageConversationMap.has(mediaItem.messageId) : !mediaItem.conversationId
        });
      });
    });

    messageImages.forEach((record, index) => {
      const conversationId = record.conversationId || (record.messageId ? messageConversationMap.get(record.messageId) || null : null);
      incrementMedia({
        id: record.id || `message-image-${index + 1}`,
        kind: classifyMediaKind(record),
        source: 'messageImages',
        messageId: record.messageId || null,
        conversationId,
        url: getMediaUrl(record),
        orphaned: record.messageId ? !messageConversationMap.has(record.messageId) : !conversationId
      });
    });

    const conversationIndex = conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title || 'Untitled conversation',
      createdAt: conversation.createdAtUnixTimestamp || null,
      updatedAt: conversation.updatedAtUnixTimestamp || conversation.createdAtUnixTimestamp || null,
      messageCount: messageCountByConversation.get(conversation.id) || 0,
      mediaCount: mediaCountByConversation.get(conversation.id) || 0,
      preview: messagePreviewMap.get(conversation.id) || 'No preview available'
    }));

    const unknownConversationIds = new Set(messageCountByConversation.keys());
    conversations.forEach((conversation) => unknownConversationIds.delete(conversation.id));
    unknownConversationIds.delete('__unknown__');

    unknownConversationIds.forEach((conversationId) => {
      conversationIndex.push({
        id: conversationId,
        title: 'Recovered conversation reference',
        createdAt: null,
        updatedAt: null,
        messageCount: messageCountByConversation.get(conversationId) || 0,
        mediaCount: mediaCountByConversation.get(conversationId) || 0,
        preview: messagePreviewMap.get(conversationId) || 'Messages were captured without a matching conversation record.'
      });
    });

    conversationIndex.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));

    const messageImagesStore = storeInventory.find((store) => store.name === 'messageImages');

    return {
      capturedAt: new Date().toISOString(),
      stats: {
        conversationCount: conversations.length,
        messageCount: messages.length,
        mediaCount: mediaTotals.mediaCount,
        imageCount: mediaTotals.imageCount,
        videoCount: mediaTotals.videoCount,
        audioCount: mediaTotals.audioCount,
        fileCount: mediaTotals.fileCount,
        orphanCount: mediaTotals.orphanCount,
        messageImageCount: messageImages.length,
        messageImagesStoreCount: messageImagesStore?.count ?? messageImages.length,
        messagesMissingConversation: messages.filter((message) => message.conversationId && !conversationIds.has(message.conversationId)).length,
        storeCount: storeInventory.length,
        keyFingerprint
      },
      conversationIndex,
      mediaItems: [],
      estimatedSizeBytes
    };
  }

  async function getSnapshotSummary() {
    const key = getEncryptionKey();
    if (!key) {
      return { success: false, error: 'No encryption key found' };
    }

    try {
      const inventoryResponse = await getStoreInventoryResponse().catch((error) => {
        console.warn(LOG_PREFIX, 'Could not inspect store inventory:', error.message);
        return { storeInventory: [] };
      });
      const storeInventory = inventoryResponse.storeInventory || [];
      const summary = await buildLightweightSnapshotSummary(key, storeInventory);

      const countFor = (name) => {
        const value = storeInventory.find((store) => store.name === name)?.count;
        return Number.isInteger(value) ? value : 0;
      };
      const agentConversationCount = countFor('mindConversations') + countFor('supportBotThreads');
      const agentMessageCount = countFor('mindMessages') + countFor('supportBotMessages');
      const additionalImages = countFor('studioImageTurnMedia') + countFor('mindMedia') + countFor('rxMessageImages') + countFor('messageImageAttachments');
      const additionalAudio = countFor('studioAudioTurnMedia') + countFor('messageAudioAttachments');
      const additionalVideos = countFor('messageVideos') + countFor('messageVideoAttachments') + countFor('videoEditorSessions') + countFor('studioVideoSessions') + countFor('videoStudioActiveGenerations');
      const additionalFiles = countFor('mindAttachments') + countFor('messageFileAttachments');
      const capturedMedia = await listCapturedMediaIndex().catch(() => []);

      summary.stats.conversationCount = Math.max(summary.stats.conversationCount, countFor('rxConversations')) + agentConversationCount;
      summary.stats.messageCount = Math.max(summary.stats.messageCount, countFor('rxMessages')) + agentMessageCount;
      summary.stats.imageCount += additionalImages + capturedMedia.filter((item) => item.kind === 'image').length;
      summary.stats.audioCount += additionalAudio + capturedMedia.filter((item) => item.kind === 'audio').length;
      summary.stats.videoCount += additionalVideos + capturedMedia.filter((item) => item.kind === 'video').length;
      summary.stats.fileCount += additionalFiles + capturedMedia.filter((item) => item.kind === 'file').length;
      summary.stats.mediaCount += additionalImages + additionalAudio + additionalVideos + additionalFiles + capturedMedia.length;
      summary.stats.storeCount = storeInventory.length;
      summary.stats.capturedMediaCount = capturedMedia.length;

      return {
        success: true,
        command: 'GET_SNAPSHOT_SUMMARY',
        protocolVersion: MAIN_PROTOCOL_VERSION,
        dbVersion: detectedDBVersion,
        keyFingerprint: key.fingerprint,
        diagnostics: {
          storeInventory,
          summaryMode: 'lightweight'
        },
        summary
      };
    } catch (error) {
      console.error(LOG_PREFIX, 'getSnapshotSummary error:', error);
      return { success: false, error: error.message };
    }
  }

  function isSensitiveLocalStorageKey(key) {
    if (key === 'encryptionKey') {
      return true;
    }
    return /(?:^|[-_.:])(access[-_.]?token|refresh[-_.]?token|id[-_.]?token|auth[-_.]?token|oauth|credential|password|secret|private[-_.]?key)(?:$|[-_.:])/i.test(key)
      || /walletconnect|wagmi\.store/i.test(key);
  }

  function isVolatileTelemetryStorageKey(key) {
    return /posthog|sentry|analytics|telemetry|amplitude|mixpanel|segment|previous[-_.:]?trace|survey/i.test(String(key || ''))
      || /^veniceActiveSessions$/i.test(String(key || ''));
  }

  function capturedStorageEntries(storage, snapshotName) {
    const captured = window[snapshotName];
    if (Array.isArray(captured)) return captured.map(([key, value]) => [String(key), value == null ? null : String(value)]);
    return Object.keys(storage).sort().map((key) => [key, storage.getItem(key)]);
  }

  function getArchiveLocalStorageRecords() {
    const records = [];
    for (const [key, value] of capturedStorageEntries(localStorage, '__VENICE_ARCHIVE_INITIAL_LOCAL_STORAGE__')) {
      if (isSensitiveLocalStorageKey(key)) {
        records.push({ key, redacted: true, reason: 'Authentication or credential state is intentionally excluded.' });
        continue;
      }
      if (isVolatileTelemetryStorageKey(key)) {
        records.push({ key, redacted: true, reason: 'Volatile telemetry state is intentionally excluded.' });
        continue;
      }
      records.push({ key, redacted: false, value });
    }
    return records;
  }

  function isSensitiveSessionStorageKey(key) {
    return isSensitiveLocalStorageKey(key)
      || /(?:^|[-_.:])(session[-_.]?id|session[-_.]?token|attestation|trace)(?:$|[-_.:])/i.test(key)
      || /^veniceSession(?:Id|StartTime)$/i.test(key);
  }

  function getArchiveSessionStorageRecords() {
    const records = [];
    for (const [key, value] of capturedStorageEntries(sessionStorage, '__VENICE_ARCHIVE_INITIAL_SESSION_STORAGE__')) {
      if (isSensitiveSessionStorageKey(key)) {
        records.push({ key, redacted: true, reason: 'Session, authentication, or telemetry identifier intentionally excluded.' });
        continue;
      }
      if (isVolatileTelemetryStorageKey(key)) {
        records.push({ key, redacted: true, reason: 'Volatile telemetry state is intentionally excluded.' });
        continue;
      }
      records.push({ key, redacted: false, value });
    }
    return records;
  }

  function getBrowserStorageData(storeName, records, options = {}) {
    const offset = Number.isFinite(options.offset) ? Math.max(0, Number(options.offset)) : 0;
    const limit = Number.isFinite(options.limit) ? Math.max(1, Number(options.limit)) : 100;
    const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(1024, Number(options.maxBytes)) : null;
    const page = [];
    let approxBytes = 0;
    for (let index = offset; index < records.length && page.length < limit; index += 1) {
      const record = records[index];
      const bytes = estimateSerializedBytes(record);
      if (maxBytes && page.length > 0 && approxBytes + bytes > maxBytes) {
        break;
      }
      page.push(record);
      approxBytes += bytes;
    }
    const nextOffset = offset + page.length;
    const done = nextOffset >= records.length;
    return {
      success: true,
      command: 'GET_STORE_DATA',
      protocolVersion: MAIN_PROTOCOL_VERSION,
      dbVersion: detectedDBVersion,
      keyFingerprint: getEncryptionKey()?.fingerprint || null,
      storeName,
      count: page.length,
      offset,
      limit,
      nextOffset,
      approxBytes,
      done,
      pageComplete: done,
      pageTruncated: !done,
      encrypted: false,
      records: page
    };
  }

  async function getStoreData(storeName, keepEncrypted = false, options = {}) {
    if (!storeName) {
      return { success: false, error: 'A store name is required' };
    }

    if (storeName === BROWSER_LOCAL_STORAGE_STORE) {
      return getBrowserStorageData(storeName, getArchiveLocalStorageRecords(), options);
    }

    if (storeName === BROWSER_SESSION_STORAGE_STORE) {
      return getBrowserStorageData(storeName, getArchiveSessionStorageRecords(), options);
    }

    if (getGenericIdbDescriptor(storeName)) {
      return await getGenericIdbStoreData(storeName, options);
    }

    if (getRxPhysicalStoreName(storeName)) {
      return await getRxPhysicalStoreData(storeName, options);
    }

    if (getRxBaseName(storeName)) {
      return await getRxStoreData(storeName, {
        offset: options.offset,
        limit: options.limit,
        maxBytes: options.maxBytes
      });
    }

    const offset = Number.isFinite(options.offset) ? Math.max(0, Number(options.offset)) : 0;
    const limit = Number.isFinite(options.limit) ? Math.max(1, Number(options.limit)) : null;
    const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(1024, Number(options.maxBytes)) : null;

    const key = getEncryptionKey();
    const isEncryptedStore = ENCRYPTED_STORE_NAMES.has(storeName);
    if (isEncryptedStore && !keepEncrypted && !key) {
      return { success: false, error: `No encryption key found for ${storeName}` };
    }

    try {
      console.log(LOG_PREFIX, `Reading store: ${storeName}`, { offset, limit, maxBytes });

      let records = [];
      let done = true;
      let approxBytes = 0;
      const cached = legacyStoreReadCache.get(storeName);
      const transformForArchive = async (record) => encodeArchiveTransportValue(
        keepEncrypted || !key ? record : decryptRecord(record, key.keyBytes)
      );

      if ((limit || maxBytes) && cached?.dbVersion === detectedDBVersion) {
        const maxRecords = limit || 100;
        for (let index = offset; index < cached.records.length && records.length < maxRecords; index += 1) {
          const record = await transformForArchive(cached.records[index]);
          const recordBytes = estimateSerializedBytes(record);
          if (maxBytes && records.length > 0 && approxBytes + recordBytes > maxBytes) break;
          records.push(record);
          approxBytes += recordBytes;
          if (maxBytes && approxBytes >= maxBytes) break;
        }
        done = offset + records.length >= cached.records.length;
      } else if (limit || maxBytes) {
        const page = await getStorePageFromCursor(storeName, {
          offset,
          limit: limit || 100,
          maxBytes,
          // Unknown Venice stores are decrypted opportunistically too. A plain
          // record passes through unchanged, while a newly introduced encrypted
          // store is preserved readably without waiting for a release update.
          transformRecord: (record) => (keepEncrypted || !key
            ? record
            : decryptRecord(record, key.keyBytes))
        });
        for (const record of page.records) {
          const encoded = await encodeArchiveTransportValue(record);
          records.push(encoded);
          approxBytes += estimateSerializedBytes(encoded);
        }
        done = page.done;
      } else {
        const recordsRaw = await getAllFromStore(storeName);
        const transformed = keepEncrypted || !key
          ? recordsRaw
          : decryptRecords(recordsRaw, key.keyBytes);
        for (const record of transformed) records.push(await encodeArchiveTransportValue(record));
        approxBytes = estimateSerializedBytes(records);
      }

      console.log(LOG_PREFIX, `Store ${storeName} loaded: ${records.length} records`, { offset, limit, maxBytes, approxBytes, done });

      return {
        success: true,
        command: 'GET_STORE_DATA',
        protocolVersion: MAIN_PROTOCOL_VERSION,
        dbVersion: detectedDBVersion,
        keyFingerprint: key?.fingerprint || null,
        storeName,
        count: records.length,
        offset,
        limit,
        nextOffset: offset + records.length,
        approxBytes,
        done,
        pageComplete: done,
        pageTruncated: !done,
        encrypted: Boolean(keepEncrypted && isEncryptedStore),
        records
      };
    } catch (error) {
      if (OPTIONAL_STORE_NAMES.has(storeName)) {
        console.warn(LOG_PREFIX, `Optional store unavailable: ${storeName}`, error.message);
        return {
          success: true,
          command: 'GET_STORE_DATA',
          protocolVersion: MAIN_PROTOCOL_VERSION,
          dbVersion: detectedDBVersion,
          keyFingerprint: key?.fingerprint || null,
          storeName,
          count: 0,
          offset,
          limit,
          nextOffset: offset,
          approxBytes: 0,
          done: true,
          pageComplete: true,
          pageTruncated: false,
          missing: true,
          records: []
        };
      }

      console.error(LOG_PREFIX, `Failed to load store ${storeName}:`, error);
      return {
        success: false,
        command: 'GET_STORE_DATA',
        protocolVersion: MAIN_PROTOCOL_VERSION,
        dbVersion: detectedDBVersion,
        keyFingerprint: key?.fingerprint || null,
        storeName,
        error: error.message
      };
    }
  }

  function uint8ArrayToBase64(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
      return '';
    }

    const parts = [];
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize)));
    }

    return btoa(parts.join(''));
  }

  function pruneMediaResourceCache(activeCacheKey = null) {
    if (mediaResourceCache.size <= MEDIA_FETCH_CACHE_LIMIT) {
      return;
    }

    const entries = [...mediaResourceCache.entries()]
      .filter(([cacheKey]) => cacheKey !== activeCacheKey)
      .sort((left, right) => (left[1]?.accessedAt || 0) - (right[1]?.accessedAt || 0));

    while (mediaResourceCache.size > MEDIA_FETCH_CACHE_LIMIT && entries.length) {
      const [cacheKey] = entries.shift();
      mediaResourceCache.delete(cacheKey);
    }
  }

  async function fetchMediaResource(url, options = {}) {
    const normalizedUrl = typeof url === 'string' ? url.trim() : '';
    if (!normalizedUrl) {
      return { success: false, error: 'A media URL is required' };
    }

    const offset = Number.isFinite(options.offset) ? Math.max(0, Number(options.offset)) : 0;
    const chunkSize = Number.isFinite(options.chunkSize)
      ? Math.max(64 * 1024, Math.min(Number(options.chunkSize), MEDIA_FETCH_CHUNK_BYTES))
      : MEDIA_FETCH_CHUNK_BYTES;
    const maxBytes = Number.isFinite(options.maxBytes)
      ? Math.max(chunkSize, Math.min(Number(options.maxBytes), MEDIA_FETCH_MAX_BYTES))
      : MEDIA_FETCH_MAX_BYTES;
    let cacheKey = typeof options.cacheKey === 'string' && options.cacheKey.trim()
      ? options.cacheKey.trim()
      : null;

    try {
      let cached = cacheKey ? mediaResourceCache.get(cacheKey) || null : null;
      if (cached && cached.url !== normalizedUrl) {
        mediaResourceCache.delete(cacheKey);
        cached = null;
        cacheKey = null;
      }

      let blob = cached?.blob || null;
      if (!blob) {
        const response = await fetch(normalizedUrl, { credentials: 'include' });
        if (!response.ok) {
          throw new Error(`Media request failed with status ${response.status}`);
        }

        blob = await response.blob();
        if (blob.size > maxBytes) {
          throw new Error(`Media resource exceeds export limit (${blob.size} bytes)`);
        }

        cacheKey = cacheKey || `media-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        cached = {
          url: normalizedUrl,
          blob,
          createdAt: Date.now(),
          accessedAt: Date.now()
        };
        mediaResourceCache.set(cacheKey, cached);
        pruneMediaResourceCache(cacheKey);
      }

      cached.accessedAt = Date.now();

      const start = Math.min(offset, blob.size);
      const end = Math.min(start + chunkSize, blob.size);
      const bytes = new Uint8Array(await blob.slice(start, end).arrayBuffer());
      const done = end >= blob.size;

      if (done && cacheKey) {
        mediaResourceCache.delete(cacheKey);
      }

      return {
        success: true,
        command: 'FETCH_MEDIA_RESOURCE',
        protocolVersion: MAIN_PROTOCOL_VERSION,
        url: normalizedUrl,
        cacheKey: done ? null : cacheKey,
        offset: start,
        nextOffset: end,
        chunkBytes: bytes.length,
        chunkBase64: uint8ArrayToBase64(bytes),
        sizeBytes: blob.size,
        mimeType: blob.type || null,
        done
      };
    } catch (error) {
      console.warn(LOG_PREFIX, 'Could not fetch media resource:', normalizedUrl, error.message);
      return {
        success: false,
        error: error.message,
        command: 'FETCH_MEDIA_RESOURCE',
        protocolVersion: MAIN_PROTOCOL_VERSION,
        url: normalizedUrl
      };
    }
  }
  
  async function putToStore(storeName, records) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction([storeName], 'readwrite');
        const store = tx.objectStore(storeName);

        tx.oncomplete = () => {
          db.close();
          resolve({ success: true, count: records.length });
        };

        tx.onabort = tx.onerror = () => {
          const error = tx.error || new Error(`Failed to write ${storeName}`);
          db.close();
          reject(error);
        };

        if (records.length === 0) {
          resolve({ success: true, count: 0 });
          return;
        }

        for (const record of records) {
          store.put(record);
        }
      } catch (e) {
        db.close();
        reject(e);
      }
    });
  }
  
  // ===========================================
  // Encryption Key Management
  // ===========================================
  
  function getEncryptionKey() {
    const keyString = localStorage.getItem('encryptionKey');
    if (!keyString) {
      cachedKeyString = null;
      cachedKeyInfo = null;
      return null;
    }

    if (cachedKeyInfo && cachedKeyString === keyString) {
      return cachedKeyInfo;
    }

    const keyInfo = buildKeyInfo(keyString);
    if (!keyInfo) {
      console.warn(LOG_PREFIX, 'Encryption key format is invalid');
      cachedKeyString = null;
      cachedKeyInfo = null;
      return null;
    }

    cachedKeyString = keyInfo.keyString;
    cachedKeyInfo = keyInfo;

    return cachedKeyInfo;
  }
  
  function writeKey(keyString) {
    try {
      const keyInfo = buildKeyInfo(keyString);
      if (!keyInfo) {
        return { success: false, error: 'Invalid encryption key format' };
      }

      localStorage.setItem('encryptionKey', keyString);
      cachedKeyString = keyInfo.keyString;
      cachedKeyInfo = keyInfo;
      return { success: true, fingerprint: keyInfo.fingerprint };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  
  // ===========================================
  // State Management
  // ===========================================
  
  async function getCurrentState() {
    const key = getEncryptionKey();
    
    // Quick count without loading all data
    let conversationCount = 0;
    let messageCount = 0;
    
    try {
      const conversations = await getAllFromStore('conversations');
      const messages = await getAllFromStore('messages');
      conversationCount = conversations.length;
      messageCount = messages.length;
    } catch (e) {
      console.error(LOG_PREFIX, 'Error getting counts:', e);
    }
    
    return {
      success: true,
      protocolVersion: MAIN_PROTOCOL_VERSION,
      hasKey: !!key,
      keyFingerprint: key?.fingerprint || null,
      keyString: key?.keyString || null,
      conversationCount,
      messageCount,
      isEmpty: !key || conversationCount === 0
    };
  }
  
  async function getFullData(keepEncrypted = false) {
    const key = getEncryptionKey();
    if (!key) {
      return { success: false, error: 'No encryption key found' };
    }
    
    try {
      const storeInventoryPromise = getStoreInventory().catch((error) => {
        console.warn(LOG_PREFIX, 'Could not inspect store inventory:', error.message);
        return [];
      });

      // Get all stores
      const [
        conversationsRaw,
        messagesRaw,
        messageIds,
        messageImagesRaw,
        studioImageSessionsRaw,
        studioImageTurnsRaw,
        studioImageTurnMediaRaw,
        studioAudioSessionsRaw,
        studioAudioTurnsRaw,
        studioAudioTurnMediaRaw,
        videoEditorSessionsRaw,
        foldersRaw,
        settingsRaw,
        charactersRaw,
        personasRaw,
        userSystemPromptsRaw,
        encryptionSettings,
        storeInventory
      ] = await Promise.all([
        getAllFromStore('conversations'),
        getAllFromStore('messages'),
        getAllFromStore('messageIds'),
        getAllFromStore('messageImages'),
        getAllFromStore('studioImageSessions').catch(() => []),
        getAllFromStore('studioImageTurns').catch(() => []),
        getAllFromStore('studioImageTurnMedia').catch(() => []),
        getAllFromStore('studioAudioSessions').catch(() => []),
        getAllFromStore('studioAudioTurns').catch(() => []),
        getAllFromStore('studioAudioTurnMedia').catch(() => []),
        getAllFromStore('videoEditorSessions').catch(() => []),
        getAllFromStore('folders'),
        getAllFromStore('settings'),
        getAllFromStore('characters'),
        getAllFromStore('personas'),
        getAllFromStore('userSystemPrompts'),
        getAllFromStore('_encryptionSettings').catch(() => []),
        storeInventoryPromise
      ]);
      
      let conversations;
      let messages;
      let messageImages;
      let studioImageSessions;
      let studioImageTurns;
      let studioImageTurnMedia;
      let studioAudioSessions;
      let studioAudioTurns;
      let studioAudioTurnMedia;
      let videoEditorSessions;
      let folders;
      let settings;
      let characters;
      let personas;
      let userSystemPrompts;
      
      if (keepEncrypted) {
        // Return raw encrypted data
        console.log(LOG_PREFIX, 'Returning encrypted data');
        conversations = conversationsRaw;
        messages = messagesRaw;
        messageImages = messageImagesRaw;
        studioImageSessions = studioImageSessionsRaw;
        studioImageTurns = studioImageTurnsRaw;
        studioImageTurnMedia = studioImageTurnMediaRaw;
        studioAudioSessions = studioAudioSessionsRaw;
        studioAudioTurns = studioAudioTurnsRaw;
        studioAudioTurnMedia = studioAudioTurnMediaRaw;
        videoEditorSessions = videoEditorSessionsRaw;
        folders = foldersRaw;
        settings = settingsRaw;
        characters = charactersRaw;
        personas = personasRaw;
        userSystemPrompts = userSystemPromptsRaw;
      } else {
        // Decrypt all encrypted records
        console.log(LOG_PREFIX, 'Raw data fetched, decrypting...');
        conversations = decryptRecords(conversationsRaw, key.keyBytes);
        messages = decryptRecords(messagesRaw, key.keyBytes);
        messageImages = decryptRecords(messageImagesRaw, key.keyBytes);
        studioImageSessions = decryptRecords(studioImageSessionsRaw, key.keyBytes);
        studioImageTurns = decryptRecords(studioImageTurnsRaw, key.keyBytes);
        studioImageTurnMedia = decryptRecords(studioImageTurnMediaRaw, key.keyBytes);
        studioAudioSessions = decryptRecords(studioAudioSessionsRaw, key.keyBytes);
        studioAudioTurns = decryptRecords(studioAudioTurnsRaw, key.keyBytes);
        studioAudioTurnMedia = decryptRecords(studioAudioTurnMediaRaw, key.keyBytes);
        videoEditorSessions = decryptRecords(videoEditorSessionsRaw, key.keyBytes);
        folders = decryptRecords(foldersRaw, key.keyBytes);
        settings = decryptRecords(settingsRaw, key.keyBytes);
        characters = decryptRecords(charactersRaw, key.keyBytes);
        personas = decryptRecords(personasRaw, key.keyBytes);
        userSystemPrompts = decryptRecords(userSystemPromptsRaw, key.keyBytes);
        console.log(LOG_PREFIX, 'Decryption complete');
      }
      
      return {
        success: true,
        keyFingerprint: key.fingerprint,
        keyString: key.keyString,
        diagnostics: {
          storeInventory
        },
        data: {
          conversations,
          messages,
          messageIds,
          messageImages,
          studioImageSessions,
          studioImageTurns,
          studioImageTurnMedia,
          studioAudioSessions,
          studioAudioTurns,
          studioAudioTurnMedia,
          videoEditorSessions,
          folders,
          settings,
          characters,
          personas,
          userSystemPrompts,
          encryptionSettings
        },
        stats: {
          conversationCount: conversations.length,
          messageCount: messages.length,
          imageCount: messageImages.length,
          studioImageSessionCount: studioImageSessions.length,
          studioImageTurnCount: studioImageTurns.length,
          studioImageMediaCount: studioImageTurnMedia.length,
          studioAudioSessionCount: studioAudioSessions.length,
          studioAudioTurnCount: studioAudioTurns.length,
          studioAudioMediaCount: studioAudioTurnMedia.length,
          videoEditorSessionCount: videoEditorSessions.length,
          folderCount: folders.length,
          characterCount: characters.length,
          personaCount: personas.length
        }
      };
    } catch (e) {
      console.error(LOG_PREFIX, 'getFullData error:', e);
      return { success: false, error: e.message };
    }
  }
  
  async function writeData(data) {
    const results = {};
    
    console.log(LOG_PREFIX, 'writeData called with:', {
      conversations: data.conversations?.length || 0,
      messages: data.messages?.length || 0,
      messageIds: data.messageIds?.length || 0,
      messageImages: data.messageImages?.length || 0
    });
    
    try {
      let key = getEncryptionKey();
      
      // Write key first if provided
      if (data.keyString) {
        if (key && key.keyString !== data.keyString) {
          return {
            success: false,
            error: 'Refusing to replace the active Venice encryption key. Restore into an empty Venice profile or a browser with the same key.'
          };
        }

        const keyResult = writeKey(data.keyString);
        if (!keyResult.success) {
          return { success: false, error: `Failed to write key: ${keyResult.error}` };
        }
        key = getEncryptionKey();
        results.key = keyResult.fingerprint || 'written';
      }

      if (!key) {
        return {
          success: false,
          error: 'No encryption key found. Open Venice.ai first or restore into a profile with a compatible key.'
        };
      }

      console.log(LOG_PREFIX, 'Using encryption key:', key.fingerprint);
      
      // Stores that need encryption
      const encryptedStores = [
        'conversations', 'messages', 'messageImages',
        'folders', 'settings', 'characters', 'personas', 'userSystemPrompts'
      ];
      
      // Stores that don't need encryption
      const plainStores = ['messageIds'];
      
      // Write encrypted stores
      for (const storeName of encryptedStores) {
        if (data[storeName] && Array.isArray(data[storeName]) && data[storeName].length > 0) {
          // Check if data needs encryption (if first record doesn't have __encryptedData)
          const needsEncryption = !data[storeName][0]?.__encryptedData;
          const recordsToWrite = needsEncryption 
            ? encryptRecords(data[storeName], key.keyBytes)
            : data[storeName];
          
          console.log(LOG_PREFIX, `Writing ${storeName}: ${recordsToWrite.length} records, encrypted: ${needsEncryption}`);
          const result = await putToStore(storeName, recordsToWrite);
          results[storeName] = result.count;
        }
      }
      
      // Write plain stores
      for (const storeName of plainStores) {
        if (data[storeName] && Array.isArray(data[storeName]) && data[storeName].length > 0) {
          console.log(LOG_PREFIX, `Writing ${storeName}: ${data[storeName].length} records (plain)`);
          const result = await putToStore(storeName, data[storeName]);
          results[storeName] = result.count;
        }
      }
      
      console.log(LOG_PREFIX, 'writeData complete:', results);
      return { success: true, results };
    } catch (e) {
      console.error(LOG_PREFIX, 'writeData error:', e);
      return { success: false, error: e.message, results };
    }
  }
  
  // ===========================================
  // Polling for Changes
  // ===========================================
  
  async function pollForChanges(force = false) {
    const now = Date.now();
    if (!force && now - lastPollTime < POLL_INTERVAL) return pollInFlight;
    if (pollInFlight) return pollInFlight;

    lastPollTime = now;

    pollInFlight = (async () => {
      try {
      const state = await getCurrentState();
      
      console.log(LOG_PREFIX, 'Current state:', {
        hasKey: state.hasKey,
        keyFingerprint: state.keyFingerprint,
        conversations: state.conversationCount,
        messages: state.messageCount
      });
      
      // Check if state changed
      if (cachedState) {
        const changed = 
          state.keyFingerprint !== cachedState.keyFingerprint ||
          state.conversationCount !== cachedState.conversationCount ||
          state.messageCount !== cachedState.messageCount;
        
        if (changed) {
          console.log(LOG_PREFIX, 'Data changed, notifying extension');
          
          if (state.keyFingerprint !== cachedState.keyFingerprint) {
            sendToExtension('KEY_CHANGED', {
              oldFingerprint: cachedState.keyFingerprint,
              newFingerprint: state.keyFingerprint,
              newKeyString: state.keyString
            }).catch(error => {
              warnIfBridgeForwardingFailed('Could not notify extension about key change:', error);
            });
          } else {
            sendToExtension('DB_CHANGED', state).catch(error => {
              warnIfBridgeForwardingFailed('Could not notify extension about DB change:', error);
            });
          }
        }
      } else {
        // Initial state
        console.log(LOG_PREFIX, 'Initial state captured');
        sendToExtension('INITIAL_STATE', state).catch(error => {
          warnIfBridgeForwardingFailed('Could not notify extension about initial state:', error);
        });
      }
      
      cachedState = state;
      } catch (e) {
        console.error(LOG_PREFIX, 'Error polling for changes:', e);
      } finally {
        pollInFlight = null;
      }
    })();

    return pollInFlight;
  }
  
  // ===========================================
  // Initialize
  // ===========================================
  
  async function init() {
    console.log(LOG_PREFIX, 'Initializing on', window.location.href);
    
    // Initial poll
    await pollForChanges(true);
    
    // Set up polling interval
    setInterval(pollForChanges, POLL_INTERVAL);
    
    // Also poll on visibility change (when tab becomes visible)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        scanExistingBlobMedia();
        pollForChanges(true);
      }
    });
  }
  
  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
})();
