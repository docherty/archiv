const ARCHIVE_SCHEMA_VERSION = '2.2.0';
const MESSAGE_TIMEOUT_MS = 180000;
const STATUS_RESET_MS = 7000;
const HISTORY_LIMIT = 8;
const EXPECTED_PAGE_PROTOCOL_VERSION = '2026-07-store-api-v12-tab-handoff';
const MEDIA_FETCH_CHUNK_BYTES = 384 * 1024;
const MEDIA_FETCH_MAX_BYTES = 512 * 1024 * 1024;
const SNAPSHOT_MESSAGE_TIMEOUT_MS = 180000;
const RESTORE_ENABLED = false;
const RESTORE_DISABLED_MESSAGE = 'Restore remains gated in this build until dry-run, rollback, and validation protections are complete.';
const REPOSITORY_PACKAGE_BASELINE_KEY = 'localArchivePackageBaselineV1';
const REPOSITORY_PACKAGE_BASELINE_VERSION = 1;
const ARCHIVE_LOCATION_DB_NAME = 'venice-history-sync-local-state';
const ARCHIVE_LOCATION_DB_VERSION = 1;
const ARCHIVE_LOCATION_STORE = 'settings';
const ARCHIVE_LOCATION_KEY = 'directoryHandle';

let currentState = null;
let currentSnapshot = null;
let previewLoadPromise = null;
let exportInProgress = false;
let encryptedMode = false;
let statusTimer = null;
let pendingDownloadRetries = [];
let progressStartedAt = null;
let progressTimer = null;
let progressOutcome = 'idle';
let packageBaseline = null;
let archiveLocation = null;
let archiveLocationHandle = null;

const elements = {
  connectionBadge: document.getElementById('connectionBadge'),
  convCount: document.getElementById('convCount'),
  msgCount: document.getElementById('msgCount'),
  mediaCount: document.getElementById('mediaCount'),
  keyCount: document.getElementById('keyCount'),
  currentKey: document.getElementById('currentKey'),
  keyStatusMeta: document.getElementById('keyStatusMeta'),
  imageCount: document.getElementById('imageCount'),
  videoCount: document.getElementById('videoCount'),
  orphanCount: document.getElementById('orphanCount'),
  estimatedSize: document.getElementById('estimatedSize'),
  refreshBtn: document.getElementById('refreshBtn'),
  restoreBtn: document.getElementById('restoreBtn'),
  repositoryBtn: document.getElementById('repositoryBtn'),
  backupBtn: document.getElementById('backupBtn'),
  retryDownloadsBtn: document.getElementById('retryDownloadsBtn'),
  repositoryDiffPackage: document.getElementById('repositoryDiffPackage'),
  repositoryPackageCard: document.getElementById('repositoryPackageCard'),
  archiveLocationCard: document.getElementById('archiveLocationCard'),
  archiveLocationBadge: document.getElementById('archiveLocationBadge'),
  archiveLocationCopy: document.getElementById('archiveLocationCopy'),
  chooseArchiveLocationBtn: document.getElementById('chooseArchiveLocationBtn'),
  verifyArchiveLocationBtn: document.getElementById('verifyArchiveLocationBtn'),
  forgetArchiveLocationBtn: document.getElementById('forgetArchiveLocationBtn'),
  packageBaselineBadge: document.getElementById('packageBaselineBadge'),
  packageDiffHelp: document.getElementById('packageDiffHelp'),
  packageBaselineMeta: document.getElementById('packageBaselineMeta'),
  decryptedBtn: document.getElementById('decryptedBtn'),
  encryptedBtn: document.getElementById('encryptedBtn'),
  includeHtmlReport: document.getElementById('includeHtmlReport'),
  includeMediaManifest: document.getElementById('includeMediaManifest'),
  includeMediaGallery: document.getElementById('includeMediaGallery'),
  includeKeyVault: document.getElementById('includeKeyVault'),
  formatDescription: document.getElementById('formatDescription'),
  modeNote: document.getElementById('modeNote'),
  progressSection: document.getElementById('progressSection'),
  progressHeadline: document.getElementById('progressHeadline'),
  progressState: document.getElementById('progressState'),
  progressTrack: document.getElementById('progressTrack'),
  progressFill: document.getElementById('progressFill'),
  progressPercent: document.getElementById('progressPercent'),
  progressText: document.getElementById('progressText'),
  progressElapsed: document.getElementById('progressElapsed'),
  progressLatest: document.getElementById('progressLatest'),
  progressScope: document.getElementById('progressScope'),
  logSection: document.getElementById('logSection'),
  statusMessage: document.getElementById('statusMessage'),
  historyList: document.getElementById('historyList'),
  lastExportSummary: document.getElementById('lastExportSummary'),
  repositoryStatus: document.getElementById('repositoryStatus'),
  inventoryList: document.getElementById('inventoryList')
};

const PREVIEW_STORE_REQUESTS = [
  { name: 'conversations', dataKey: 'conversations', label: 'conversations', pageSize: 40, maxBytes: 2 * 1024 * 1024 },
  { name: 'messages', dataKey: 'messages', label: 'messages', pageSize: 8, maxBytes: 512 * 1024 },
  { name: 'messageImages', dataKey: 'messageImages', label: 'message images', optional: true, pageSize: 8, maxBytes: 512 * 1024 },
  { name: 'studioImageTurnMedia', dataKey: 'studioImageTurnMedia', label: 'studio image media', optional: true, pageSize: 8, maxBytes: 768 * 1024 },
  { name: 'studioAudioTurnMedia', dataKey: 'studioAudioTurnMedia', label: 'studio audio media', optional: true, pageSize: 8, maxBytes: 768 * 1024 },
  { name: 'videoEditorSessions', dataKey: 'videoEditorSessions', label: 'video editor sessions', optional: true, pageSize: 8, maxBytes: 768 * 1024 },
  { name: 'videoStudioActiveGenerations', dataKey: 'videoStudioActiveGenerations', label: 'active video Studio generations', optional: true, pageSize: 8, maxBytes: 1024 * 1024 },
  { name: 'mindConversations', dataKey: 'mindConversations', label: 'agentic sessions', optional: true, pageSize: 40, maxBytes: 2 * 1024 * 1024 },
  { name: 'mindMessages', dataKey: 'mindMessages', label: 'agentic messages', optional: true, pageSize: 8, maxBytes: 1024 * 1024 },
  { name: 'messageVideos', dataKey: 'messageVideos', label: 'videos', optional: true, pageSize: 8, maxBytes: 768 * 1024 }
];

const ARCHIVE_STORE_REQUESTS = [
  { name: 'conversations', dataKey: 'conversations', label: 'conversations', pageSize: 40, maxBytes: 2 * 1024 * 1024 },
  { name: 'messages', dataKey: 'messages', label: 'messages', pageSize: 8, maxBytes: 512 * 1024 },
  { name: 'messageIds', dataKey: 'messageIds', label: 'message ids', pageSize: 120, maxBytes: 2 * 1024 * 1024 },
  { name: 'messageImages', dataKey: 'messageImages', label: 'message images', optional: true, pageSize: 8, maxBytes: 512 * 1024 },
  { name: 'studioImageSessions', dataKey: 'studioImageSessions', label: 'studio image sessions', optional: true, pageSize: 20, maxBytes: 1024 * 1024 },
  { name: 'studioImageTurns', dataKey: 'studioImageTurns', label: 'studio image turns', optional: true, pageSize: 20, maxBytes: 1024 * 1024 },
  { name: 'studioImageTurnMedia', dataKey: 'studioImageTurnMedia', label: 'studio image media', optional: true, pageSize: 8, maxBytes: 768 * 1024 },
  { name: 'studioAudioSessions', dataKey: 'studioAudioSessions', label: 'studio audio sessions', optional: true, pageSize: 20, maxBytes: 1024 * 1024 },
  { name: 'studioAudioTurns', dataKey: 'studioAudioTurns', label: 'studio audio turns', optional: true, pageSize: 20, maxBytes: 1024 * 1024 },
  { name: 'studioAudioTurnMedia', dataKey: 'studioAudioTurnMedia', label: 'studio audio media', optional: true, pageSize: 8, maxBytes: 768 * 1024 },
  { name: 'studioVideoSessions', dataKey: 'studioVideoSessions', label: 'studio video sessions', optional: true, pageSize: 20, maxBytes: 1024 * 1024 },
  { name: 'videoEditorSessions', dataKey: 'videoEditorSessions', label: 'video editor sessions', optional: true, pageSize: 20, maxBytes: 1024 * 1024 },
  { name: 'videoStudioActiveGenerations', dataKey: 'videoStudioActiveGenerations', label: 'active video Studio generations', optional: true, pageSize: 20, maxBytes: 2 * 1024 * 1024 },
  { name: 'rxConversations', dataKey: 'rxConversations', label: 'current RxDB conversations', optional: true, pageSize: 40, maxBytes: 2 * 1024 * 1024 },
  { name: 'rxMessages', dataKey: 'rxMessages', label: 'current RxDB messages', optional: true, pageSize: 8, maxBytes: 1024 * 1024 },
  { name: 'rxMessageImages', dataKey: 'rxMessageImages', label: 'current RxDB message images', optional: true, pageSize: 8, maxBytes: 768 * 1024 },
  { name: 'messageAudioAttachments', dataKey: 'messageAudioAttachments', label: 'audio attachments', optional: true, pageSize: 20, maxBytes: 1024 * 1024 },
  { name: 'messageFileAttachments', dataKey: 'messageFileAttachments', label: 'file attachments', optional: true, pageSize: 20, maxBytes: 1024 * 1024 },
  { name: 'messageImageAttachments', dataKey: 'messageImageAttachments', label: 'image attachments', optional: true, pageSize: 20, maxBytes: 1024 * 1024 },
  { name: 'messageVideoAttachments', dataKey: 'messageVideoAttachments', label: 'video attachments', optional: true, pageSize: 20, maxBytes: 1024 * 1024 },
  { name: 'mindConversations', dataKey: 'mindConversations', label: 'agentic sessions', optional: true, pageSize: 40, maxBytes: 2 * 1024 * 1024 },
  { name: 'mindMessages', dataKey: 'mindMessages', label: 'agentic messages', optional: true, pageSize: 8, maxBytes: 1024 * 1024 },
  { name: 'mindMedia', dataKey: 'mindMedia', label: 'agentic media', optional: true, pageSize: 8, maxBytes: 768 * 1024 },
  { name: 'mindAttachments', dataKey: 'mindAttachments', label: 'agentic attachments', optional: true, pageSize: 20, maxBytes: 1024 * 1024 },
  { name: 'messageVideos', dataKey: 'messageVideos', label: 'videos', optional: true, pageSize: 8, maxBytes: 768 * 1024 },
  { name: 'folders', dataKey: 'folders', label: 'folders', optional: true, pageSize: 40, maxBytes: 2 * 1024 * 1024 },
  { name: 'settings', dataKey: 'settings', label: 'settings', optional: true, pageSize: 20, maxBytes: 512 * 1024 },
  { name: 'textSettings', dataKey: 'textSettings', label: 'text settings', optional: true, pageSize: 20, maxBytes: 512 * 1024 },
  { name: 'imageSettings', dataKey: 'imageSettings', label: 'image settings', optional: true, pageSize: 20, maxBytes: 512 * 1024 },
  { name: 'characters', dataKey: 'characters', label: 'characters', optional: true, pageSize: 20, maxBytes: 1024 * 1024 },
  { name: 'personas', dataKey: 'personas', label: 'personas', optional: true, pageSize: 20, maxBytes: 1024 * 1024 },
  { name: 'userSystemPrompts', dataKey: 'userSystemPrompts', label: 'system prompts', optional: true, pageSize: 20, maxBytes: 1024 * 1024 },
  { name: 'supportBotThreads', dataKey: 'supportBotThreads', label: 'support conversations', optional: true, pageSize: 40, maxBytes: 1024 * 1024 },
  { name: 'supportBotMessages', dataKey: 'supportBotMessages', label: 'support messages', optional: true, pageSize: 20, maxBytes: 1024 * 1024 },
  { name: 'pinnedMessages', dataKey: 'pinnedMessages', label: 'pinned message references', optional: true, pageSize: 80, maxBytes: 1024 * 1024 },
  { name: 'browserLocalStorage', dataKey: 'browserLocalStorage', label: 'recoverable browser state', optional: false, pageSize: 100, maxBytes: 1024 * 1024 },
  { name: 'browserSessionStorage', dataKey: 'browserSessionStorage', label: 'recoverable session state', optional: false, pageSize: 100, maxBytes: 1024 * 1024 },
  { name: '_encryptionSettings', dataKey: 'encryptionSettings', label: 'encryption settings', optional: true, pageSize: 20, maxBytes: 512 * 1024 }
];

const STUDIO_MEDIA_STORE_CONFIGS = [
  {
    dataKey: 'studioImageTurnMedia',
    sourceStore: 'studioImageTurnMedia',
    sourceLabel: 'studio.image.turnMedia',
    defaultKind: 'image',
    turnStore: 'studioImageTurns',
    sessionStore: 'studioImageSessions',
    turnIdFields: ['turnId', 'studioImageTurnId', 'imageTurnId'],
    sessionIdFields: ['sessionId', 'studioImageSessionId', 'imageSessionId']
  },
  {
    dataKey: 'studioAudioTurnMedia',
    sourceStore: 'studioAudioTurnMedia',
    sourceLabel: 'studio.audio.turnMedia',
    defaultKind: 'audio',
    turnStore: 'studioAudioTurns',
    sessionStore: 'studioAudioSessions',
    turnIdFields: ['turnId', 'studioAudioTurnId', 'audioTurnId'],
    sessionIdFields: ['sessionId', 'studioAudioSessionId', 'audioSessionId']
  },
  {
    dataKey: 'studioVideoSessions',
    sourceStore: 'studioVideoSessions',
    sourceLabel: 'studio.video.session',
    defaultKind: 'video',
    metadataOnlyIsMedia: false,
    turnStore: null,
    sessionStore: null,
    turnIdFields: [],
    sessionIdFields: []
  },
  {
    dataKey: 'videoEditorSessions',
    sourceStore: 'videoEditorSessions',
    sourceLabel: 'video.editor.session',
    defaultKind: 'video',
    metadataOnlyIsMedia: false,
    turnStore: null,
    sessionStore: null,
    turnIdFields: [],
    sessionIdFields: []
  },
  {
    dataKey: 'videoStudioActiveGenerations',
    sourceStore: 'videoStudioActiveGenerations',
    sourceLabel: 'studio.video.activeGeneration',
    defaultKind: 'video',
    metadataOnlyIsMedia: false,
    turnStore: null,
    sessionStore: null,
    turnIdFields: [],
    sessionIdFields: []
  },
  {
    dataKey: 'videoStudioLocalState',
    sourceStore: 'browserLocalStorage',
    sourceLabel: 'studio.video.localState',
    defaultKind: 'video',
    metadataOnlyIsMedia: false,
    turnStore: null,
    sessionStore: null,
    turnIdFields: [],
    sessionIdFields: []
  }
];

const SUPPLEMENTAL_ARCHIVE_RECORD_STORES = [
  { dataKey: 'settings', manifestGroup: 'settings' },
  { dataKey: 'textSettings', manifestGroup: 'settings' },
  { dataKey: 'imageSettings', manifestGroup: 'settings' },
  { dataKey: 'encryptionSettings', manifestGroup: 'settings' },
  { dataKey: 'studioImageSessions', manifestGroup: 'studio' },
  { dataKey: 'studioImageTurns', manifestGroup: 'studio' },
  { dataKey: 'studioImageTurnMedia', manifestGroup: 'studio' },
  { dataKey: 'studioAudioSessions', manifestGroup: 'studio' },
  { dataKey: 'studioAudioTurns', manifestGroup: 'studio' },
  { dataKey: 'studioAudioTurnMedia', manifestGroup: 'studio' },
  { dataKey: 'studioVideoSessions', manifestGroup: 'studio' },
  { dataKey: 'videoEditorSessions', manifestGroup: 'studio' },
  { dataKey: 'videoStudioActiveGenerations', manifestGroup: 'studio' },
  { dataKey: 'videoStudioLocalState', manifestGroup: 'studio' }
];

async function init() {
  bindEvents();
  setEncryptedMode(false);
  clearLog();
  log('Initializing backup console...', 'info');

  // Render capability and action state before the Venice scan. A slow or
  // failed bridge connection must not leave the page looking inert.
  updateArchiveLocationUI();
  updatePackageBaselineUI();
  updateRepositoryAccessModeUI();
  updateUI();

  await refreshState();
  const snapshotReady = await refreshSnapshotPreview({ silent: true });
  await Promise.all([
    refreshPackageBaselineStatus(),
    refreshArchiveLocationStatus()
  ]);

  updateRepositoryAccessModeUI();
  updateUI();
  log(snapshotReady
    ? 'Backup console ready'
    : 'Backup console loaded, but Venice access still needs attention', snapshotReady ? 'success' : 'warning');
}

function bindEvents() {
  elements.refreshBtn.addEventListener('click', () => refreshSnapshotPreview());
  elements.restoreBtn.addEventListener('click', openRestoreManager);
  elements.repositoryBtn.addEventListener('click', performRepositoryBackup);
  elements.chooseArchiveLocationBtn.addEventListener('click', chooseArchiveLocation);
  elements.verifyArchiveLocationBtn.addEventListener('click', verifyArchiveLocation);
  elements.forgetArchiveLocationBtn.addEventListener('click', forgetArchiveLocation);
  elements.backupBtn.addEventListener('click', performBackup);
  elements.retryDownloadsBtn.addEventListener('click', retryPendingDownloads);
  elements.decryptedBtn.addEventListener('click', () => setEncryptedMode(false));
  elements.encryptedBtn.addEventListener('click', () => setEncryptedMode(true));
  elements.includeHtmlReport.addEventListener('change', updateModeUI);
  elements.includeMediaManifest.addEventListener('change', updateModeUI);
  elements.includeMediaGallery.addEventListener('change', updateModeUI);
  elements.includeKeyVault.addEventListener('change', updateModeUI);
  elements.repositoryDiffPackage.addEventListener('change', updateRepositoryAccessModeUI);
}

function setEncryptedMode(encrypted) {
  encryptedMode = encrypted;

  if (encryptedMode) {
    elements.includeHtmlReport.checked = false;
    elements.includeHtmlReport.disabled = true;
    elements.includeMediaGallery.checked = false;
    elements.includeMediaGallery.disabled = true;
  } else {
    elements.includeHtmlReport.disabled = false;
    elements.includeMediaGallery.disabled = false;
  }

  updateModeUI();
  updateUI();
}

function updateModeUI() {
  elements.decryptedBtn.classList.toggle('active', !encryptedMode);
  elements.encryptedBtn.classList.toggle('active', encryptedMode);

  if (encryptedMode) {
    elements.formatDescription.textContent = 'Portable encrypted snapshots keep raw Venice records intact. The archive is not human-readable, but it stays closer to the original browser data model.';
    elements.modeNote.textContent = elements.includeKeyVault.checked
      ? 'Key vault export remains enabled so this archive can be useful for future recovery work.'
      : 'Without the key vault, an encrypted archive may not be sufficient for future recovery work.';
  } else {
    elements.formatDescription.textContent = 'Readable archives export conversation text, media references, key metadata, and a structured JSON archive designed for auditing and cold storage.';
    if (elements.includeMediaGallery.checked) {
      elements.modeNote.textContent = 'This mode can also emit a companion media gallery zip with exported files, search, filters, and a large preview view.';
    } else {
      elements.modeNote.textContent = elements.includeKeyVault.checked
      ? 'This mode can generate an HTML guide for quick browsing alongside the complete JSON export.'
        : 'If you disable the key vault, the archive remains readable but is less suitable for future recovery work.';
    }
  }
}

function withTimeout(promise, timeoutMs, errorMessage) {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);
  });

  return Promise.race([
    promise.finally(() => clearTimeout(timeoutId)),
    timeoutPromise
  ]);
}

async function sendRuntimeMessage(message) {
  const response = await withTimeout(
    chrome.runtime.sendMessage(message),
    MESSAGE_TIMEOUT_MS,
    'Background service worker did not respond in time'
  );

  if (!response) {
    throw new Error('Background service worker returned no response');
  }

  if (response.success === false) {
    throw new Error(response.error || 'Background request failed');
  }

  return response;
}

function getVeniceMessageTimeoutMs(messageType) {
  switch (messageType) {
    case 'GET_SNAPSHOT_SUMMARY':
      return SNAPSHOT_MESSAGE_TIMEOUT_MS;
    default:
      return MESSAGE_TIMEOUT_MS;
  }
}

async function sendVeniceMessage(tabId, message) {
  const response = await withTimeout(
    chrome.tabs.sendMessage(tabId, message),
    getVeniceMessageTimeoutMs(message?.type),
    'Venice.ai did not respond in time'
  );

  if (!response) {
    throw new Error('Venice.ai returned no response');
  }

  if (response.success === false) {
    throw new Error(response.error || 'Venice.ai request failed');
  }

  return response;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissingReceiverError(error) {
  const message = String(error?.message || error || '');
  return message.includes('Could not establish connection') || message.includes('Receiving end does not exist');
}

function isBridgeStartupError(error) {
  const message = String(error?.message || error || '');
  return message.includes('bridge is still starting') || message.includes('did not respond in time');
}

function isProtocolMismatchError(error) {
  const message = String(error?.message || error || '');
  return message.includes('outdated') || message.includes('unexpected response');
}

function hasExpectedProtocol(response) {
  return response?.protocolVersion === EXPECTED_PAGE_PROTOCOL_VERSION;
}

function isValidSnapshotSummaryResponse(response) {
  return Boolean(
    response &&
    response.success !== false &&
    response.command === 'GET_SNAPSHOT_SUMMARY' &&
    hasExpectedProtocol(response) &&
    Number.isInteger(response.dbVersion) &&
    response.summary &&
    response.summary.stats &&
    Array.isArray(response.summary.conversationIndex)
  );
}

function isValidStoreInventoryResponse(response) {
  return Boolean(
    response &&
    response.success !== false &&
    response.command === 'GET_STORE_INVENTORY' &&
    hasExpectedProtocol(response) &&
    Number.isInteger(response.dbVersion) &&
    Array.isArray(response.storeInventory)
  );
}

function isValidStoreDataResponse(response, storeName) {
  return Boolean(
    response &&
    response.success !== false &&
    response.command === 'GET_STORE_DATA' &&
    hasExpectedProtocol(response) &&
    Number.isInteger(response.dbVersion) &&
    response.storeName === storeName &&
    Number.isFinite(response.nextOffset) &&
    typeof response.pageComplete === 'boolean' &&
    typeof response.pageTruncated === 'boolean' &&
    Array.isArray(response.records)
  );
}

function isValidMediaResourceResponse(response) {
  return Boolean(
    response &&
    response.success !== false &&
    response.command === 'FETCH_MEDIA_RESOURCE' &&
    hasExpectedProtocol(response) &&
    typeof response.done === 'boolean' &&
    typeof response.chunkBase64 === 'string'
  );
}

function isValidOpfsMediaIndexResponse(response) {
  return Boolean(
    response &&
    response.success !== false &&
    response.command === 'GET_OPFS_MEDIA_INDEX' &&
    hasExpectedProtocol(response) &&
    typeof response.available === 'boolean' &&
    Array.isArray(response.items)
  );
}

function isValidOpfsMediaChunkResponse(response) {
  return Boolean(
    response &&
    response.success !== false &&
    response.command === 'FETCH_OPFS_MEDIA' &&
    hasExpectedProtocol(response) &&
    typeof response.done === 'boolean' &&
    typeof response.chunkBase64 === 'string'
  );
}

function isValidCapturedMediaIndexResponse(response) {
  return Boolean(
    response &&
    response.success !== false &&
    response.command === 'GET_CAPTURED_MEDIA_INDEX' &&
    hasExpectedProtocol(response) &&
    Array.isArray(response.items)
  );
}

function isValidCapturedMediaChunkResponse(response) {
  return Boolean(
    response &&
    response.success !== false &&
    response.command === 'FETCH_CAPTURED_MEDIA' &&
    hasExpectedProtocol(response) &&
    typeof response.done === 'boolean' &&
    typeof response.chunkBase64 === 'string'
  );
}

async function pingVeniceTab(tabId, timeoutMs = 2500, { requireExpectedProtocol = false } = {}) {
  const response = await withTimeout(
    chrome.tabs.sendMessage(tabId, { type: 'PING' }),
    timeoutMs,
    'Venice.ai did not respond in time'
  );

  if (!response || response.success === false) {
    throw new Error(response?.error || 'Venice.ai ping failed');
  }

  if (requireExpectedProtocol && !hasExpectedProtocol(response)) {
    throw new Error('Venice.ai bridge is outdated and must be reattached');
  }

  return response;
}

async function injectVeniceReceiver(tab) {
  if (!chrome.scripting?.executeScript) {
    throw new Error('The extension is missing scripting permission. Reload the extension to apply the latest manifest.');
  }

  const tabUrl = cleanOptionalText(tab?.url);
  if (!isSupportedVeniceUrl(tabUrl)) {
    throw new Error(`The selected tab is not a supported Venice page${tabUrl ? ` (${tabUrl})` : ''}. Open https://venice.ai and try again.`);
  }

  log('Reattaching Venice bridge to the current tab...', 'warning');

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content-bridge.js']
    });
  } catch (error) {
    if (/cannot access contents|must request permission|cannot be scripted/i.test(String(error?.message || ''))) {
      let manifestAccess = false;
      try {
        manifestAccess = await chrome.permissions.contains({ origins: ['https://*.venice.ai/*'] });
      } catch (_) {
        // The diagnostic remains useful even if Brave does not expose the
        // optional permissions API on this extension page.
      }

      const tabDetails = `tab ${tab.id}${tab.discarded ? ', discarded' : ''}${tab.status ? `, ${tab.status}` : ''}`;
      if (manifestAccess) {
        throw new Error(`Brave reports Venice site access is allowed, but refused script access to ${tabUrl} (${tabDetails}). Go to the live Venice tab, click the extension icon there, and choose Open Backup Console so Brave hands that exact tab to the console.`);
      }

      throw new Error(`Brave refused extension access to ${new URL(tabUrl).origin} (${tabDetails}). Allow https://*.venice.ai/* in the extension's Site access settings, then open the console from the extension icon while the Venice tab is active.`);
    }
    throw error;
  }

  for (let attempt = 0; attempt < 15; attempt++) {
    await sleep(400);

    try {
      await pingVeniceTab(tab.id, 3000, { requireExpectedProtocol: true });
      log('Venice bridge is ready', 'success');
      return;
    } catch (error) {
      if (attempt === 14 || (!isMissingReceiverError(error) && !isBridgeStartupError(error) && !isProtocolMismatchError(error))) {
        throw new Error(`Failed to reconnect to the Venice tab: ${error.message}`);
      }
    }
  }
}

function isSupportedVeniceUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && (url.hostname === 'venice.ai' || url.hostname.endsWith('.venice.ai'));
  } catch (_) {
    return false;
  }
}

async function ensureVeniceReceiver(tab, { force = false } = {}) {
  if (!tab?.id) {
    throw new Error('No Venice.ai tab found. Please open Venice.ai first.');
  }

  if (!force) {
    try {
      await pingVeniceTab(tab.id, 2500, { requireExpectedProtocol: true });
      return;
    } catch (error) {
      if (!isMissingReceiverError(error) && !isBridgeStartupError(error) && !isProtocolMismatchError(error)) {
        throw error;
      }
    }
  }

  await injectVeniceReceiver(tab);
}

async function sendVeniceCommandWithRecovery(tab, message, validateResponse, description) {
  await ensureVeniceReceiver(tab);

  let response;
  try {
    response = await sendVeniceMessage(tab.id, message);
  } catch (error) {
    if (!isMissingReceiverError(error) && !isBridgeStartupError(error) && !isProtocolMismatchError(error)) {
      throw error;
    }

    log(`The Venice bridge timed out during ${description}. Reattaching and retrying once...`, 'warning');
    await ensureVeniceReceiver(tab, { force: true });
    response = await sendVeniceMessage(tab.id, message);
  }

  if (validateResponse(response)) {
    return response;
  }

  log(`Unexpected ${description} response. Reattaching the Venice bridge and retrying...`, 'warning');
  await ensureVeniceReceiver(tab, { force: true });
  response = await sendVeniceMessage(tab.id, message);

  if (validateResponse(response)) {
    return response;
  }

  throw new Error(`Venice.ai returned an unexpected ${description} response. Reload the Venice tab and try again.`);
}

async function findVeniceTab() {
  const sourceTabId = Number(new URLSearchParams(location.search).get('sourceTabId'));
  if (Number.isInteger(sourceTabId) && sourceTabId > 0) {
    try {
      const sourceTab = await chrome.tabs.get(sourceTabId);
      if (isSupportedVeniceUrl(sourceTab?.url)) {
        log(`Using the Venice tab handed off by the extension menu (tab ${sourceTab.id}).`);
        return sourceTab;
      }
    } catch (error) {
      log(`The Venice tab handed off by the extension menu is no longer available: ${error.message}`, 'warning');
    }
  }

  const tabs = (await chrome.tabs.query({}))
    .filter((tab) => isSupportedVeniceUrl(tab?.url))
    .sort((left, right) => {
      const leftScore = (left.discarded ? 0 : 1_000_000_000_000_000) + Number(left.lastAccessed || 0);
      const rightScore = (right.discarded ? 0 : 1_000_000_000_000_000) + Number(right.lastAccessed || 0);
      return rightScore - leftScore;
    });

  if (!tabs.length) {
    return null;
  }

  // A responding bridge is a stronger signal than tab enumeration order.
  // This also avoids selecting an old or discarded Venice tab when the user
  // has several workspaces open.
  for (const tab of tabs.slice(0, 8)) {
    try {
      await pingVeniceTab(tab.id, 900, { requireExpectedProtocol: true });
      log(`Connected to a responsive Venice tab (tab ${tab.id}).`);
      return tab;
    } catch (_) {
      // Fall through to the most recently used viable tab below.
    }
  }

  const selectedTab = tabs.find((tab) => !tab.discarded) || tabs[0];
  log(`Found ${formatNumber(tabs.length)} Venice tab${tabs.length === 1 ? '' : 's'}; trying the most recently used one (tab ${selectedTab.id}, ${selectedTab.status || 'unknown status'}).`, 'warning');
  return selectedTab;
}

async function refreshState() {
  try {
    currentState = await sendRuntimeMessage({ type: 'GET_STATE' });
    updateUI();
    return currentState;
  } catch (error) {
    showStatus('error', `Failed to read extension state: ${error.message}`);
    log(`State refresh failed: ${error.message}`, 'error');
    return null;
  }
}

async function refreshSnapshotPreview({ silent = false } = {}) {
  if (previewLoadPromise) {
    return previewLoadPromise;
  }

  previewLoadPromise = (async () => {
    try {
      setConnectionBadge('loading', 'Scanning Venice.ai');
      elements.refreshBtn.disabled = true;

      const tab = await findVeniceTab();
      if (!tab) {
        currentSnapshot = null;
        setConnectionBadge('offline', 'Open Venice.ai');
        updateUI();

        if (!silent) {
          showStatus('warning', 'Open a Venice.ai tab to inspect what the next backup will export.');
        }

        return false;
      }

      const response = await requestSnapshotSummary(tab);
      currentSnapshot = buildSnapshotModel(response);
      setConnectionBadge('ready', 'Connected to Venice.ai');
      updateUI();

      if (!silent) {
        showStatus('success', `Snapshot refreshed: ${formatNumber(currentSnapshot.stats.conversationCount)} conversations and ${formatNumber(currentSnapshot.stats.mediaCount)} media references detected.`);
      }

      return true;
    } catch (error) {
      currentSnapshot = null;
      setConnectionBadge('error', 'Snapshot unavailable');
      updateUI();
      log(`Snapshot refresh failed: ${error.message}`, 'error');

      // A failed automatic scan is still a blocking condition. Keep it in the
      // main reading flow instead of hiding it inside the technical log.
      showStatus('error', `Venice is not ready for backup: ${error.message}`);
      elements.repositoryStatus.textContent = 'Backup is paused until Venice access succeeds. Resolve the message above, reload the Venice page, then press Refresh.';

      return false;
    } finally {
      elements.refreshBtn.disabled = exportInProgress;
      previewLoadPromise = null;
    }
  })();

  return previewLoadPromise;
}

async function requestSnapshotSummary(tab) {
  const veniceTab = tab || await findVeniceTab();
  if (!veniceTab?.id) {
    throw new Error('No Venice.ai tab found. Please open Venice.ai first.');
  }

  return sendVeniceCommandWithRecovery(
    veniceTab,
    { type: 'GET_SNAPSHOT_SUMMARY' },
    isValidSnapshotSummaryResponse,
    'snapshot summary'
  );
}

async function requestStoreInventory(tab) {
  const veniceTab = tab || await findVeniceTab();
  if (!veniceTab?.id) {
    throw new Error('No Venice.ai tab found. Please open Venice.ai first.');
  }

  return sendVeniceCommandWithRecovery(
    veniceTab,
    { type: 'GET_STORE_INVENTORY' },
    isValidStoreInventoryResponse,
    'store inventory'
  );
}

async function requestMediaResourceChunk(tab, options) {
  const veniceTab = tab || await findVeniceTab();
  if (!veniceTab?.id) {
    throw new Error('No Venice.ai tab found. Please open Venice.ai first.');
  }

  return sendVeniceCommandWithRecovery(
    veniceTab,
    {
      type: 'FETCH_MEDIA_RESOURCE',
      url: options?.url,
      cacheKey: options?.cacheKey || null,
      offset: options?.offset || 0,
      chunkSize: options?.chunkSize || MEDIA_FETCH_CHUNK_BYTES,
      maxBytes: options?.maxBytes || MEDIA_FETCH_MAX_BYTES
    },
    isValidMediaResourceResponse,
    'media resource'
  );
}

async function requestCapturedMediaIndex(tab) {
  const veniceTab = tab || await findVeniceTab();
  if (!veniceTab?.id) {
    throw new Error('No Venice.ai tab found. Please open Venice.ai first.');
  }

  return sendVeniceCommandWithRecovery(
    veniceTab,
    { type: 'GET_CAPTURED_MEDIA_INDEX' },
    isValidCapturedMediaIndexResponse,
    'captured media index'
  );
}

async function requestOpfsMediaIndex(tab) {
  const veniceTab = tab || await findVeniceTab();
  if (!veniceTab?.id) {
    throw new Error('No Venice.ai tab found. Please open Venice.ai first.');
  }
  return sendVeniceCommandWithRecovery(
    veniceTab,
    { type: 'GET_OPFS_MEDIA_INDEX' },
    isValidOpfsMediaIndexResponse,
    'OPFS media index'
  );
}

async function requestOpfsMediaChunk(tab, options) {
  const veniceTab = tab || await findVeniceTab();
  if (!veniceTab?.id) {
    throw new Error('No Venice.ai tab found. Please open Venice.ai first.');
  }
  return sendVeniceCommandWithRecovery(
    veniceTab,
    {
      type: 'FETCH_OPFS_MEDIA',
      path: options?.path,
      offset: options?.offset || 0,
      chunkSize: options?.chunkSize || MEDIA_FETCH_CHUNK_BYTES
    },
    isValidOpfsMediaChunkResponse,
    'OPFS media chunk'
  );
}

async function requestCapturedMediaChunk(tab, options) {
  const veniceTab = tab || await findVeniceTab();
  if (!veniceTab?.id) {
    throw new Error('No Venice.ai tab found. Please open Venice.ai first.');
  }

  return sendVeniceCommandWithRecovery(
    veniceTab,
    {
      type: 'FETCH_CAPTURED_MEDIA',
      hash: options?.hash,
      offset: options?.offset || 0,
      chunkSize: options?.chunkSize || MEDIA_FETCH_CHUNK_BYTES
    },
    isValidCapturedMediaChunkResponse,
    'captured media chunk'
  );
}

async function loadArchivePayload({ tab, keepEncrypted, requests, silent = false, phaseLabel = 'archive' }) {
  const veniceTab = tab || await findVeniceTab();
  if (!veniceTab?.id) {
    throw new Error('No Venice.ai tab found. Please open Venice.ai first.');
  }

  await ensureVeniceReceiver(veniceTab);

  const inventoryResponse = await requestStoreInventory(veniceTab);
  const storeInventory = inventoryResponse.storeInventory || [];
  const inventoryMap = new Map(storeInventory.map((store) => [store.name, store]));
  const coverage = globalThis.VeniceArchiveCoverage;
  if (!coverage) {
    throw new Error('Archive coverage helpers are unavailable. Reload the extension and retry.');
  }
  const effectiveRequests = coverage.buildArchiveStoreRequests(requests, storeInventory);
  const sourceDbVersion = inventoryResponse.dbVersion;
  const data = {};
  const sourceStores = {};
  const extraStores = {};
  const fetchedStores = [];
  const loadProgressStart = phaseLabel.includes('package') ? 20 : (phaseLabel === 'archive' ? 26 : 20);
  const loadProgressEnd = phaseLabel.includes('package') ? 54 : (phaseLabel === 'archive' ? 57 : 54);

  const saveStoreRecords = (request, records, inventoryEntry) => {
    if (request.dataKey) {
      data[request.dataKey] = records;
    } else {
      extraStores[request.name] = records;
    }

    if (inventoryEntry) {
      sourceStores[request.sourceStoreName || request.name] = {
        name: request.sourceStoreName || request.name,
        source: inventoryEntry.source || 'legacy',
        databaseName: inventoryEntry.databaseName || null,
        physicalStoreName: inventoryEntry.physicalStoreName || request.name,
        schemaVersion: inventoryEntry.schemaVersion ?? null,
        sourceFingerprint: inventoryEntry.fingerprint || null,
        encrypted: Boolean(
          inventoryEntry.encrypted ||
          (keepEncrypted && (inventoryEntry.source || 'legacy') === 'legacy')
        ),
        records
      };
    }
  };

  for (let index = 0; index < effectiveRequests.length; index++) {
    const request = effectiveRequests[index];
    const inventoryEntry = inventoryMap.get(request.name);
    const expectedCount = inventoryEntry?.count ?? null;
    const pageSize = request.pageSize || 100;
    const maxBytes = request.maxBytes || (1024 * 1024);
    const requestStart = index / Math.max(effectiveRequests.length, 1);
    const requestEnd = (index + 1) / Math.max(effectiveRequests.length, 1);
    const setLoadProgress = (fraction, label = request.label) => {
      const boundedFraction = Math.max(0, Math.min(1, Number(fraction) || 0));
      const requestFraction = requestStart + ((requestEnd - requestStart) * boundedFraction);
      setProgress(
        loadProgressStart + ((loadProgressEnd - loadProgressStart) * requestFraction),
        `${label} • store ${formatNumber(index + 1)} of ${formatNumber(effectiveRequests.length)}`
      );
    };

    setLoadProgress(0, inventoryEntry?.count ? `Loading ${request.label}` : `Checking ${request.label}`);

    // Inventory is authoritative. A configured projection can legitimately be
    // absent after a Venice migration, but once a store is discovered it is
    // mandatory regardless of its historical `optional` label.
    if (!inventoryEntry) {
      saveStoreRecords(request, [], null);
      setLoadProgress(1, `Skipped ${request.label}`);
      fetchedStores.push({
        name: request.name,
        count: 0,
        missing: true,
        expectedCount: null,
        source: 'absent'
      });
      if (!silent) {
        log(`Skipping ${request.label}: store is not present in this Venice schema`, 'info');
      }
      continue;
    }

    if (!Number.isInteger(expectedCount)) {
      throw new Error(`Venice could not verify the ${request.label} record count${inventoryEntry.error ? `: ${inventoryEntry.error}` : '.'}`);
    }

    if (expectedCount === 0) {
      saveStoreRecords(request, [], inventoryEntry);
      setLoadProgress(1, `Skipped ${request.label}`);
      fetchedStores.push({
        name: request.name,
        count: 0,
        skipped: true,
        expectedCount: 0,
        source: inventoryEntry?.source || 'legacy',
        databaseName: inventoryEntry?.databaseName || null,
        physicalStoreName: inventoryEntry?.physicalStoreName || request.name,
        schemaVersion: inventoryEntry?.schemaVersion ?? null
      });
      if (!silent) {
        log(`Skipping ${request.label}: store is empty`, 'info');
      }
      continue;
    }

    if (!silent) {
      log(`Loading ${request.label}...`, 'info');
    }

    const records = [];
    let offset = 0;
    let receivedAnyPage = false;
    let approxBytesTotal = 0;

    while (true) {
      const response = await sendVeniceCommandWithRecovery(
        veniceTab,
        {
          type: 'GET_STORE_DATA',
          storeName: request.name,
          offset,
          limit: pageSize,
          maxBytes,
          encrypted: keepEncrypted
        },
        (payload) => isValidStoreDataResponse(payload, request.name),
        `${request.label} data`
      );

      if (response.dbVersion !== sourceDbVersion) {
        throw new Error('Venice data changed during export. Refresh the snapshot and try again.');
      }

      if (!response.success) {
        throw new Error(`Failed to load ${request.label}: ${response.error || 'unknown error'}`);
      }

      const pageRecords = response.records || [];
      if (!response.done && pageRecords.length === 0) {
        throw new Error(`The ${request.label} store returned an empty partial page. Reduce export scope or refresh Venice.ai before retrying.`);
      }

      records.push(...pageRecords);
      receivedAnyPage = true;
      offset = response.nextOffset;
      approxBytesTotal += response.approxBytes || 0;
      setLoadProgress(
        expectedCount ? Math.min(1, offset / expectedCount) : (response.done ? 1 : 0),
        `Loading ${request.label}`
      );

      if (!response.done && offset <= records.length - pageRecords.length) {
        throw new Error(`The ${request.label} export cursor stalled before completion.`);
      }

      if (expectedCount != null && offset > expectedCount) {
        throw new Error(`The ${request.label} export exceeded the expected record count.`);
      }

      if (!silent && expectedCount && expectedCount > pageSize) {
        const sizeLabel = response.approxBytes ? ` • ${formatBytes(response.approxBytes)}` : '';
        log(`Loaded ${request.label}: ${formatNumber(Math.min(offset, expectedCount))}/${formatNumber(expectedCount)}${sizeLabel}`, 'info');
      }

      if (response.missing || response.done || pageRecords.length === 0) {
        break;
      }

      if (expectedCount != null && offset >= expectedCount) {
        break;
      }
    }

    if (!receivedAnyPage) {
      saveStoreRecords(request, [], null);
      fetchedStores.push({ name: request.name, count: 0, missing: true });
      continue;
    }

    saveStoreRecords(request, records, inventoryEntry);

    if (expectedCount != null && records.length !== expectedCount) {
      throw new Error(`The ${request.label} export completed with ${records.length} records, but Venice reported ${expectedCount}.`);
    }

    fetchedStores.push({
      name: request.name,
      count: records.length,
      missing: false,
      approxBytesTotal,
      expectedCount,
      dbVersion: sourceDbVersion,
      source: inventoryEntry?.source || 'legacy',
      databaseName: inventoryEntry?.databaseName || null,
      physicalStoreName: inventoryEntry?.physicalStoreName || request.name,
      schemaVersion: inventoryEntry?.schemaVersion ?? null
    });
    setLoadProgress(1, `Loaded ${request.label}`);

    if (!silent) {
      log(`Loaded ${request.label}: ${formatNumber(records.length)} records`, 'success');
    }
  }

  const finalInventoryResponse = await requestStoreInventory(veniceTab);
  if (finalInventoryResponse.dbVersion !== sourceDbVersion) {
    throw new Error('Venice changed database versions during export. Refresh and export again.');
  }
  if ((finalInventoryResponse.keyFingerprint || null) !== (inventoryResponse.keyFingerprint || null)) {
    throw new Error('Venice changed encryption keys during export. Refresh the page and export again.');
  }

  const finalInventoryMap = new Map((finalInventoryResponse.storeInventory || []).map((store) => [store.name, store]));
  const initialInventoryNames = Array.from(inventoryMap.keys()).sort();
  const finalInventoryNames = Array.from(finalInventoryMap.keys()).sort();
  if (JSON.stringify(initialInventoryNames) !== JSON.stringify(finalInventoryNames)) {
    throw new Error('Venice created or removed a source store during export. Refresh the snapshot and export again.');
  }
  for (const request of effectiveRequests) {
    const initialEntry = inventoryMap.get(request.name) || null;
    const finalEntry = finalInventoryMap.get(request.name) || null;
    if (initialEntry?.mutableDuringExport || finalEntry?.mutableDuringExport) {
      // Venice uses local/session storage for live UI queues, telemetry, and
      // ephemeral recovery state. Keep the captured start-of-export snapshot,
      // but do not reject a complete archive because that volatile state moved
      // while the long IndexedDB/media export was running.
      if (!silent) {
        log(`Keeping the start-of-export snapshot for volatile ${request.label}; Venice changed it during export.`, 'warning');
      }
      continue;
    }
    const initialSignature = initialEntry
      ? JSON.stringify([initialEntry.count, initialEntry.source || 'legacy', initialEntry.databaseName || null, initialEntry.physicalStoreName || null, initialEntry.schemaVersion ?? null, initialEntry.fingerprint || null])
      : null;
    const finalSignature = finalEntry
      ? JSON.stringify([finalEntry.count, finalEntry.source || 'legacy', finalEntry.databaseName || null, finalEntry.physicalStoreName || null, finalEntry.schemaVersion ?? null, finalEntry.fingerprint || null])
      : null;
    if (initialSignature !== finalSignature) {
      throw new Error(`The ${request.label} store changed during export. Refresh Venice.ai and try again.`);
    }
  }

  if (Object.keys(extraStores).length) {
    data.extraStores = extraStores;
  }
  coverage.attachSourceStores(data, sourceStores);

  // Video Studio persists pending/active/failed generation payloads as JSON in
  // localStorage. Parse the content-bearing queues into a derived projection so
  // their output/download/input URLs participate in media materialization.
  deriveVideoStudioLocalState(data);

  // Venice's current frontend stores regular chats in RxDB. Merge those current
  // records over any legacy copies by immutable id before deriving flat files.
  mergeRxChatRecordsIntoData(data);

  // Fold secondary conversational models into the primary searchable view.
  // Their untouched source records remain available through the source-store
  // map written under stores/.
  mergeSupportBotRecordsIntoData(data);

  // Fold agentic ("Mind") sessions, videos, and newer RxDB media into the
  // legacy record shapes so the rest of the pipeline treats them uniformly.
  mergeAgenticRecordsIntoData(data);

  return {
    success: true,
    keyFingerprint: inventoryResponse.keyFingerprint || currentState?.keyFingerprint || null,
    diagnostics: {
      storeInventory,
      finalStoreInventory: finalInventoryResponse.storeInventory || [],
      fetchedStores,
      sourceDbVersion,
      phase: phaseLabel
    },
    data
  };
}

function deriveVideoStudioLocalState(data) {
  const transform = globalThis.VeniceStudioTransform;
  if (!transform?.deriveVideoStudioLocalState) {
    throw new Error('Video Studio state transform is unavailable. Reload the extension and retry.');
  }
  const derived = transform.deriveVideoStudioLocalState(data?.browserLocalStorage);
  data.videoStudioLocalState = derived;
  return derived;
}

function mergeRxChatRecordsIntoData(data) {
  const mergeById = (legacyRecords, currentRecords) => {
    const merged = new Map();
    (Array.isArray(legacyRecords) ? legacyRecords : []).forEach((record, index) => {
      const key = cleanOptionalText(record?.id) || `legacy:${index}`;
      merged.set(key, record);
    });
    (Array.isArray(currentRecords) ? currentRecords : []).forEach((record, index) => {
      const key = cleanOptionalText(record?.id) || `rx:${index}`;
      merged.set(key, record);
    });
    return Array.from(merged.values());
  };

  data.conversations = mergeById(data?.conversations, data?.rxConversations);
  data.messages = mergeById(data?.messages, data?.rxMessages);
  return data;
}

function mergeSupportBotRecordsIntoData(data) {
  const threads = Array.isArray(data?.supportBotThreads) ? data.supportBotThreads : [];
  const sourceMessages = Array.isArray(data?.supportBotMessages) ? data.supportBotMessages : [];
  if (!threads.length && !sourceMessages.length) {
    return data;
  }

  const prefixConversationId = (value) => `support:${cleanOptionalText(value) || 'unknown'}`;
  const normalizedMessages = [];
  const messageThreadIds = new Set();

  sourceMessages.forEach((record, index) => {
    const threadId = cleanOptionalText(record?.supportBotThreadId || record?.threadId || record?.conversationId || 'unknown');
    const conversationId = prefixConversationId(threadId);
    messageThreadIds.add(threadId);
    const baseId = cleanOptionalText(record?.id) || `message-${index + 1}`;
    const createdAt = record?.createdAtUnixTimestamp || record?.created_at_unix_timestamp || null;
    const updatedAt = record?.updatedAtUnixTimestamp || record?.updated_at_unix_timestamp || createdAt;
    const question = firstNonEmptyText([
      record?.question,
      record?.query,
      record?.prompt,
      record?.userMessage,
      record?.user_message
    ]);
    const answer = firstNonEmptyText([
      record?.response,
      record?.answer,
      record?.reply,
      record?.assistantMessage,
      record?.assistant_message
    ]);

    const pushMessage = (text, role, suffix = '') => {
      if (!cleanOptionalText(text)) {
        return;
      }
      normalizedMessages.push({
        ...record,
        id: `support:${baseId}${suffix}`,
        conversationId,
        role,
        content: text,
        createdAtUnixTimestamp: createdAt,
        updatedAtUnixTimestamp: updatedAt,
        source: 'supportBotMessages'
      });
    };

    if (question || answer) {
      pushMessage(question, 'user', ':question');
      pushMessage(answer, 'assistant', ':answer');
      return;
    }

    pushMessage(
      firstNonEmptyText([record?.content, record?.text, record?.message]),
      normalizeGuideRole(record?.role || record?.sender || 'assistant')
    );
  });

  const normalizedThreads = [];
  const knownThreadIds = new Set();
  threads.forEach((thread, index) => {
    const threadId = cleanOptionalText(thread?.id) || `thread-${index + 1}`;
    knownThreadIds.add(threadId);
    const conversationId = prefixConversationId(threadId);
    const threadMessages = normalizedMessages.filter((message) => message.conversationId === conversationId);
    normalizedThreads.push({
      ...thread,
      id: conversationId,
      name: firstNonEmptyText([thread?.name, thread?.title, thread?.subject]) || resolveConversationTitle(null, threadMessages),
      title: firstNonEmptyText([thread?.title, thread?.name, thread?.subject]) || resolveConversationTitle(null, threadMessages),
      kind: 'support',
      createdAtUnixTimestamp: thread?.createdAtUnixTimestamp || threadMessages[0]?.createdAtUnixTimestamp || null,
      updatedAtUnixTimestamp: thread?.updatedAtUnixTimestamp || threadMessages[threadMessages.length - 1]?.updatedAtUnixTimestamp || null
    });
  });

  messageThreadIds.forEach((threadId) => {
    if (knownThreadIds.has(threadId)) {
      return;
    }
    const conversationId = prefixConversationId(threadId);
    const threadMessages = normalizedMessages.filter((message) => message.conversationId === conversationId);
    normalizedThreads.push({
      id: conversationId,
      name: resolveConversationTitle(null, threadMessages),
      title: resolveConversationTitle(null, threadMessages),
      kind: 'support',
      createdAtUnixTimestamp: threadMessages[0]?.createdAtUnixTimestamp || null,
      updatedAtUnixTimestamp: threadMessages[threadMessages.length - 1]?.updatedAtUnixTimestamp || null
    });
  });

  data.conversations = [
    ...(Array.isArray(data.conversations) ? data.conversations : []),
    ...normalizedThreads
  ];
  data.messages = [
    ...(Array.isArray(data.messages) ? data.messages : []),
    ...normalizedMessages
  ];
  return data;
}

// Folds decoded RxDB agentic records into the legacy conversation/message/media
// arrays so the snapshot, durable archive, and viewer all see a single dataset.
function mergeAgenticRecordsIntoData(data) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  const util = globalThis.VeniceAgenticTransform;
  if (!util) {
    // Transform module unavailable — leave legacy data untouched rather than fail.
    return data;
  }

  const agenticConversations = util.buildAgenticConversations(data.mindConversations);
  const agenticMessages = util.buildAgenticMessages(data.mindMessages);
  const agenticMedia = util.buildAgenticMediaRecords({
    messageVideos: data.messageVideos,
    rxMessageImages: data.rxMessageImages,
    messageAudioAttachments: data.messageAudioAttachments,
    messageFileAttachments: data.messageFileAttachments,
    messageImageAttachments: data.messageImageAttachments,
    messageVideoAttachments: data.messageVideoAttachments,
    mindMedia: data.mindMedia,
    mindAttachments: data.mindAttachments
  });

  if (agenticConversations.length) {
    data.conversations = [
      ...(Array.isArray(data.conversations) ? data.conversations : []),
      ...agenticConversations
    ];
  }
  if (agenticMessages.length) {
    data.messages = [
      ...(Array.isArray(data.messages) ? data.messages : []),
      ...agenticMessages
    ];
  }
  if (agenticMedia.length) {
    data.messageImages = [
      ...(Array.isArray(data.messageImages) ? data.messageImages : []),
      ...agenticMedia
    ];
  }

  return data;
}

function buildSnapshotModel(response) {
  if (!response || typeof response !== 'object') {
    throw new Error('Venice.ai returned no snapshot payload');
  }

  if (response.summary) {
    return {
      capturedAt: response.summary.capturedAt || new Date().toISOString(),
      response,
      fullData: {},
      diagnostics: {
        storeInventory: response.diagnostics?.storeInventory || []
      },
      mediaItems: response.summary.mediaItems || [],
      conversationIndex: response.summary.conversationIndex || [],
      stats: response.summary.stats || {},
      estimatedSizeBytes: response.summary.estimatedSizeBytes || 0
    };
  }

  if (!response.data || typeof response.data !== 'object') {
    throw new Error('Venice.ai returned an unexpected archive payload');
  }

  const fullData = response.data || {};
  const conversations = fullData.conversations || [];
  const messages = fullData.messages || [];
  const messageImages = fullData.messageImages || [];
  const storeInventory = response.diagnostics?.storeInventory || [];
  const mediaItems = extractMediaItems(fullData);
  const conversationIndex = buildConversationIndex(fullData, mediaItems);
  const conversationIds = new Set(conversations.map((conversation) => conversation.id));
  const messagesMissingConversation = messages.filter((message) => message.conversationId && !conversationIds.has(message.conversationId)).length;
  const messageImagesStore = storeInventory.find((store) => store.name === 'messageImages');

  const stats = {
    conversationCount: conversations.length,
    messageCount: messages.length,
    mediaCount: mediaItems.length,
    imageCount: mediaItems.filter((item) => item.kind === 'image').length,
    videoCount: mediaItems.filter((item) => item.kind === 'video').length,
    audioCount: mediaItems.filter((item) => item.kind === 'audio').length,
    fileCount: mediaItems.filter((item) => item.kind === 'file').length,
    orphanCount: mediaItems.filter((item) => item.orphaned).length,
    messageImageCount: messageImages.length,
    messageImagesStoreCount: messageImagesStore?.count ?? messageImages.length,
    messagesMissingConversation,
    storeCount: storeInventory.length,
    keyFingerprint: response.keyFingerprint || currentState?.keyFingerprint || null
  };

  const transportEstimatedBytes = estimateFetchedStoresBytes(response.diagnostics?.fetchedStores || []);
  const estimatedSizeBytes = transportEstimatedBytes || estimateBytes({
    conversations,
    messages,
    messageIds: fullData.messageIds || [],
    messageImages,
    studioImageSessions: fullData.studioImageSessions || [],
    studioImageTurns: fullData.studioImageTurns || [],
    studioImageTurnMedia: fullData.studioImageTurnMedia || [],
    studioAudioSessions: fullData.studioAudioSessions || [],
    studioAudioTurns: fullData.studioAudioTurns || [],
    studioAudioTurnMedia: fullData.studioAudioTurnMedia || [],
    videoEditorSessions: fullData.videoEditorSessions || [],
    videoStudioActiveGenerations: fullData.videoStudioActiveGenerations || [],
    videoStudioLocalState: fullData.videoStudioLocalState || [],
    folders: fullData.folders || [],
    settings: fullData.settings || [],
    characters: fullData.characters || [],
    personas: fullData.personas || [],
    userSystemPrompts: fullData.userSystemPrompts || []
  });

  return {
    capturedAt: new Date().toISOString(),
    response,
    fullData,
    diagnostics: {
      storeInventory
    },
    mediaItems,
    conversationIndex,
    stats,
    estimatedSizeBytes
  };
}

function estimateFetchedStoresBytes(fetchedStores) {
  return fetchedStores.reduce((total, store) => total + (store.approxBytesTotal || 0), 0);
}

function buildConversationIndex(fullData, mediaItems) {
  const messages = fullData.messages || [];
  const conversations = fullData.conversations || [];
  const messagesByConversation = new Map();
  const mediaCountByConversation = new Map();

  for (const message of messages) {
    const conversationId = message.conversationId || '__unknown__';
    if (!messagesByConversation.has(conversationId)) {
      messagesByConversation.set(conversationId, []);
    }
    messagesByConversation.get(conversationId).push(message);
  }

  for (const mediaItem of mediaItems) {
    const conversationId = mediaItem.conversationId || '__unknown__';
    mediaCountByConversation.set(
      conversationId,
      (mediaCountByConversation.get(conversationId) || 0) + 1
    );
  }

  const results = conversations.map((conversation) => {
    const conversationMessages = messagesByConversation.get(conversation.id) || [];
    const preview = conversationMessages
      .map(extractMessageText)
      .find(Boolean) || 'No preview available';

    return {
      id: conversation.id,
      title: resolveConversationTitle(conversation, conversationMessages),
      createdAt: conversation.createdAtUnixTimestamp || null,
      updatedAt: conversation.updatedAtUnixTimestamp || conversation.createdAtUnixTimestamp || null,
      messageCount: conversationMessages.length,
      mediaCount: mediaCountByConversation.get(conversation.id) || 0,
      preview: preview.length > 180 ? `${preview.slice(0, 177)}...` : preview
    };
  });

  const knownConversationIds = new Set(conversations.map((conversation) => conversation.id));
  for (const [conversationId, conversationMessages] of messagesByConversation.entries()) {
    if (conversationId === '__unknown__' || knownConversationIds.has(conversationId)) {
      continue;
    }

    const preview = conversationMessages
      .map(extractMessageText)
      .find(Boolean) || 'Messages were captured without a matching conversation record.';

    results.push({
      id: conversationId,
      title: 'Recovered conversation reference',
      createdAt: conversationMessages[0]?.createdAtUnixTimestamp || null,
      updatedAt: conversationMessages[conversationMessages.length - 1]?.updatedAtUnixTimestamp || null,
      messageCount: conversationMessages.length,
      mediaCount: mediaCountByConversation.get(conversationId) || 0,
      preview: preview.length > 180 ? `${preview.slice(0, 177)}...` : preview
    });
  }

  return results.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
}

function extractMediaItems(fullData) {
  const messages = fullData.messages || [];
  const messageImages = fullData.messageImages || [];
  const messageConversationMap = new Map(messages.map((message) => [message.id, message.conversationId || null]));
  const knownMessageIds = new Set(messageConversationMap.keys());
  const items = [];
  const seen = new Set();

  const addMediaItem = (candidate) => {
    const normalized = normalizeMediaCandidate(candidate, messageConversationMap, knownMessageIds);
    if (!normalized) {
      return;
    }

    const dedupeKey = normalized.url
      ? [normalized.kind, normalized.url].join('|')
      : [normalized.kind, normalized.sourceStore || normalized.source, normalized.id || ''].join('|');

    if (seen.has(dedupeKey)) {
      return;
    }

    seen.add(dedupeKey);
    items.push(normalized);
  };

  messageImages.forEach((record, index) => {
    const mediaUrl = getMediaUrl(record);
    const embeddedPayload = getEmbeddedBinaryPayload(record);
    const inline = hasInlineData(record) || Boolean(embeddedPayload?.base64) || Boolean(record.contentBinary);
    const inferredKind = classifyMediaKind({ ...(record || {}), url: mediaUrl, mimeType: getMimeType(record) });
    addMediaItem({
      id: record.id || `message-image-${index + 1}`,
      messageId: record.messageId || null,
      conversationId: record.conversationId || null,
      url: mediaUrl,
      mimeType: getMimeType(record),
      kind: inferredKind === 'asset' ? (record.__mediaDefaultKind || 'image') : inferredKind,
      approxBytes: detectApproxBytes(record),
      inline,
      source: 'messageImages'
    });
  });

  messages.forEach((message) => {
    extractMessageMediaCandidates(message).forEach(addMediaItem);
  });

  extractStructuredStoreMediaCandidates(fullData).forEach(addMediaItem);
  extractGenericStoreMediaCandidates(fullData).forEach(addMediaItem);

  return items;
}

function buildRecordIdMap(records) {
  return new Map(
    (Array.isArray(records) ? records : [])
      .filter((record) => record && cleanOptionalText(record.id))
      .map((record) => [cleanOptionalText(record.id), record])
  );
}

function getFirstDefinedText(value, fields) {
  if (!value || typeof value !== 'object') {
    return '';
  }

  for (const field of fields) {
    const normalized = cleanOptionalText(value[field]);
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function getFirstDefinedNumber(value, fields) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  for (const field of fields) {
    const candidate = value[field];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildStudioContextMaps(fullData) {
  return {
    studioImageTurns: buildRecordIdMap(fullData.studioImageTurns || []),
    studioImageSessions: buildRecordIdMap(fullData.studioImageSessions || []),
    studioAudioTurns: buildRecordIdMap(fullData.studioAudioTurns || []),
    studioAudioSessions: buildRecordIdMap(fullData.studioAudioSessions || [])
  };
}

function resolveStudioMediaContext(record, config, contextMaps) {
  const turnMap = config.turnStore ? contextMaps[config.turnStore] : null;
  const sessionMap = config.sessionStore ? contextMaps[config.sessionStore] : null;
  const turnId = getFirstDefinedText(record, config.turnIdFields || []);
  const turn = turnId && turnMap ? turnMap.get(turnId) || null : null;
  const sessionId = getFirstDefinedText(record, config.sessionIdFields || []) ||
    getFirstDefinedText(turn, config.sessionIdFields || []);
  const session = sessionId && sessionMap ? sessionMap.get(sessionId) || null : null;

  return {
    turn,
    session,
    conversationId: firstNonEmptyText([
      record?.conversationId,
      turn?.conversationId,
      session?.conversationId
    ]) || null,
    createdAtUnix: getFirstDefinedNumber(record, ['createdAtUnixTimestamp', 'createdAt', 'timestamp']) ||
      getFirstDefinedNumber(turn, ['createdAtUnixTimestamp', 'createdAt', 'timestamp']) ||
      getFirstDefinedNumber(session, ['createdAtUnixTimestamp', 'createdAt', 'timestamp']) ||
      null,
    updatedAtUnix: getFirstDefinedNumber(record, ['updatedAtUnixTimestamp', 'updatedAt', 'timestamp']) ||
      getFirstDefinedNumber(turn, ['updatedAtUnixTimestamp', 'updatedAt', 'timestamp']) ||
      getFirstDefinedNumber(session, ['updatedAtUnixTimestamp', 'updatedAt', 'timestamp']) ||
      null
  };
}

function collectRecordMediaReferenceEntries(record) {
  const results = new Map();
  const seen = new WeakSet();

  const visit = (value, keyHint = '', depth = 0) => {
    if (depth > 6 || value == null) return;
    if (typeof value === 'string') {
      if (looksLikeMediaReference(value, keyHint) && !results.has(value)) {
        results.set(value, { url: value, keyHint });
      }
      return;
    }
    if (typeof value !== 'object' || value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof Blob) return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, keyHint, depth + 1));
      return;
    }
    const entries = Object.entries(value);
    const isNumericRecord = entries.length > 64 && entries.every(([key]) => /^\d+$/.test(key));
    if (isNumericRecord) return;
    entries.forEach(([key, nested]) => {
      if (key !== '__encryptedData') visit(nested, key, depth + 1);
    });
  };

  visit(record);
  return Array.from(results.values());
}

function extractStructuredStoreMediaCandidates(fullData) {
  const contextMaps = buildStudioContextMaps(fullData);
  const candidates = [];

  STUDIO_MEDIA_STORE_CONFIGS.forEach((config) => {
    const records = Array.isArray(fullData[config.dataKey]) ? fullData[config.dataKey] : [];

    records.forEach((record, index) => {
      const embeddedPayload = getEmbeddedBinaryPayload(record);
      const references = collectRecordMediaReferenceEntries(record);
      const context = resolveStudioMediaContext(record, config, contextMaps);

      if (!references.length && !embeddedPayload && config.metadataOnlyIsMedia === false) {
        return;
      }

      const candidateReferences = references.length ? references : [{ url: null, keyHint: '' }];
      candidateReferences.forEach(({ url, keyHint }, referenceIndex) => {
        const inferredKind = classifyMediaKind({ ...(record || {}), type: keyHint || record?.type, url, mimeType: getMimeType(record) });
        const kind = inferredKind === 'asset' ? config.defaultKind : inferredKind;

        candidates.push({
          id: record?.id
            ? `${record.id}${referenceIndex ? `-${referenceIndex + 1}` : ''}`
            : `${config.dataKey}-${index + 1}${referenceIndex ? `-${referenceIndex + 1}` : ''}`,
          messageId: record?.messageId || null,
          conversationId: context.conversationId,
          url,
          inline: Boolean(embeddedPayload || (typeof url === 'string' && url.startsWith('data:'))),
          mimeType: getMimeType(record) || (url ? inferMimeTypeFromUrl(url, kind) : null),
          kind,
          approxBytes: detectApproxBytes(record),
          source: `${config.sourceLabel}${url ? '.reference' : '.embedded'}`,
          sourceStore: config.sourceStore,
          orphaned: !(context.conversationId || context.turn || context.session)
        });
      });
    });
  });

  return candidates;
}

function isLikelyBase64Payload(value) {
  const text = String(value || '').replace(/\s+/g, '');
  if (text.startsWith('__') || text.includes('__ENCRYPTED')) {
    return false;
  }
  return text.length >= 16 && isValidBase64Payload(text);
}

function isValidBase64Payload(value) {
  const text = String(value || '').replace(/\s+/g, '');
  if (!text || text.startsWith('__') || text.includes('__ENCRYPTED')) {
    return false;
  }
  return text.length % 4 !== 1 && /^[A-Za-z0-9+/_-]*={0,2}$/.test(text);
}

function getEmbeddedPayloadFromValue(value, keyHint = '') {
  if (value == null) {
    return null;
  }

  if (
    value &&
    typeof value === 'object' &&
    value.encoding === 'base64' &&
    typeof value.data === 'string'
  ) {
    if (!isValidBase64Payload(value.data)) {
      return null;
    }
    return {
      base64: normalizeBase64Payload(value.data),
      mimeType: typeof value.mimeType === 'string' ? value.mimeType : null
    };
  }

  if (typeof value === 'string') {
    const text = value.trim();
    const key = String(keyHint || '').toLowerCase();
    if (text.startsWith('__') || key.includes('opaque') || key.includes('encrypted')) {
      return null;
    }
    if (text.startsWith('data:') || (/(?:data|blob|file|payload|bytes|binary|base64|result|content)/.test(key) && isLikelyBase64Payload(text))) {
      return getEmbeddedBinaryPayload({ contentBinary: text });
    }
    return null;
  }

  if (value instanceof Uint8Array) {
    return { base64: uint8ArrayToBase64(value), mimeType: null };
  }
  if (value instanceof ArrayBuffer) {
    return { base64: uint8ArrayToBase64(new Uint8Array(value)), mimeType: null };
  }
  return null;
}

function collectRecordEmbeddedBinaryEntries(record) {
  const entries = [];
  const seen = new WeakSet();
  const seenPaths = new Set();

  const visit = (value, path = [], keyHint = '', depth = 0) => {
    if (depth > 8 || value == null) {
      return;
    }

    const payload = getEmbeddedPayloadFromValue(value, keyHint);
    if (payload?.base64) {
      const pathKey = path.join('.');
      if (!seenPaths.has(pathKey)) {
        seenPaths.add(pathKey);
        entries.push({ payload, path });
      }
      return;
    }

    if (typeof value !== 'object' || value instanceof Blob) {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, index], keyHint, depth + 1));
      return;
    }

    Object.entries(value).forEach(([key, nested]) => {
      if (key === '__encryptedData' || key === '__veniceArchiveRedacted') {
        return;
      }
      visit(nested, [...path, key], key, depth + 1);
    });
  };

  visit(record);
  return entries;
}

function extractGenericStoreMediaCandidates(fullData) {
  const extraStores = fullData?.extraStores && typeof fullData.extraStores === 'object'
    ? fullData.extraStores
    : {};
  const candidates = [];

  Object.entries(extraStores).forEach(([sourceStore, records]) => {
    if (!Array.isArray(records)) {
      return;
    }

    records.forEach((record, recordIndex) => {
      const embeddedEntries = collectRecordEmbeddedBinaryEntries(record);
      const references = collectRecordMediaReferenceEntries(record)
        .filter(({ url, keyHint }) => isLikelyAttachmentReference(record, keyHint, url));
      const recordMimeType = getMimeType(record);
      const recordKind = classifyMediaKind({ ...(record || {}), mimeType: recordMimeType });
      const defaultKind = recordKind === 'asset' ? 'file' : recordKind;
      const messageId = record?.messageId || record?.message_id || record?.mindMessageId || null;
      const conversationId = record?.conversationId || record?.conversation_id || record?.mindConversationId || record?.mind_conversation_id || null;

      embeddedEntries.forEach(({ payload, path }, entryIndex) => {
        const payloadMimeType = payload.mimeType || inferMimeTypeFromBase64(payload.base64, recordMimeType || defaultMimeTypeForKind(defaultKind));
        const payloadKind = classifyMediaKind({ mimeType: payloadMimeType });
        candidates.push({
          id: `${sourceStore}-${record?.id || recordIndex + 1}-embedded-${entryIndex + 1}`,
          sourceStore,
          recordIndex,
          embeddedPayload: payload,
          embeddedPayloadPath: path,
          messageId,
          conversationId,
          url: null,
          mimeType: payloadMimeType || recordMimeType || null,
          kind: payloadKind === 'asset' ? defaultKind : payloadKind,
          approxBytes: Number(record?.size || record?.sizeBytes || 0) || Math.floor(payload.base64.length * 3 / 4),
          inline: true,
          source: `${sourceStore}.embedded`,
          orphaned: !conversationId
        });
      });

      references.forEach(({ url, keyHint }, referenceIndex) => {
        candidates.push({
          id: `${sourceStore}-${record?.id || recordIndex + 1}-reference-${referenceIndex + 1}`,
          sourceStore,
          recordIndex,
          embeddedPayload: null,
          embeddedPayloadPath: [],
          messageId,
          conversationId,
          url,
          mimeType: recordMimeType || inferMimeTypeFromUrl(url, defaultKind),
          kind: classifyMediaKind({ ...(record || {}), type: keyHint || record?.type, url, mimeType: recordMimeType }) === 'asset'
            ? defaultKind
            : classifyMediaKind({ ...(record || {}), type: keyHint || record?.type, url, mimeType: recordMimeType }),
          approxBytes: Number(record?.size || record?.sizeBytes || 0) || null,
          inline: typeof url === 'string' && url.startsWith('data:'),
          source: `${sourceStore}.reference`,
          orphaned: !conversationId
        });
      });
    });
  });

  return candidates;
}

function isLikelyAttachmentReference(record, keyHint, url) {
  const hint = String(keyHint || '').toLowerCase();
  const typeHint = [
    record?.type,
    record?.kind,
    record?.mediaType,
    record?.contentType,
    record?.mimeType,
    record?.mime_type
  ].filter(Boolean).join(' ').toLowerCase();
  const hasFileIdentity = Boolean(firstNonEmptyText([
    record?.fileName,
    record?.filename,
    record?.name,
    record?.attachmentId,
    record?.attachment_id,
    record?.mediaId,
    record?.media_id
  ]));

  if (/(attachment|file|media|asset|image|video|audio|upload|blob|download|preview|render|recording)/.test(hint)) {
    return true;
  }
  if (/(attachment|file|media|asset|image|video|audio|upload|blob|document)/.test(typeHint) || hasFileIdentity) {
    return true;
  }

  // Keep obvious inline media links, but do not turn every research citation
  // (especially external PDFs in agentic web-search records) into an archive
  // obligation. The untouched URL remains in the lossless source store.
  return /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|heic|heif|tiff|mp4|mov|webm|m4v|avi|mkv|ogv|mpeg|mpg|mp3|wav|ogg|m4a|aac|flac|opus)(?:$|[?#])/i.test(String(url || ''));
}

function normalizeMediaCandidate(candidate, messageConversationMap, knownMessageIds) {
  if (!candidate) {
    return null;
  }

  const conversationId = candidate.conversationId || (candidate.messageId ? messageConversationMap.get(candidate.messageId) || null : null);
  const hasReference = Boolean(candidate.url) || candidate.inline;
  if (!hasReference && !candidate.id) {
    return null;
  }

  return {
    id: candidate.id || null,
    kind: candidate.kind || 'asset',
    source: candidate.source || 'message',
    sourceStore: candidate.sourceStore || null,
    messageId: candidate.messageId || null,
    conversationId,
    url: candidate.url || null,
    mimeType: candidate.mimeType || null,
    inline: Boolean(candidate.inline),
    approxBytes: candidate.approxBytes || null,
    orphaned: typeof candidate.orphaned === 'boolean'
      ? candidate.orphaned
      : (candidate.messageId ? !knownMessageIds.has(candidate.messageId) : !conversationId)
  };
}

function extractMessageMediaCandidates(message) {
  const candidates = [];
  const messageId = message.id || null;
  const conversationId = message.conversationId || null;

  const pushCandidate = (payload, source, forcedKind = null) => {
    const normalizedPayload = typeof payload === 'string' ? { url: payload } : payload;
    const url = getMediaUrl(normalizedPayload);
    const embeddedPayload = source === 'message.attachments'
      ? getAttachmentEmbeddedPayload(normalizedPayload)
      : getEmbeddedBinaryPayload(normalizedPayload);
    const inline = hasInlineData(normalizedPayload) || Boolean(embeddedPayload?.base64);
    const mimeType = source === 'message.attachments'
      ? getAttachmentMimeType(normalizedPayload, embeddedPayload?.mimeType)
      : getMimeType(normalizedPayload);
    const kind = forcedKind || classifyMediaKind({ ...(normalizedPayload || {}), url, mimeType });

    if (!url && !inline && !normalizedPayload?.id) {
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
      fileName: normalizedPayload?.fileName || normalizedPayload?.filename || normalizedPayload?.name || null,
      approxBytes: detectApproxBytes(normalizedPayload),
      embeddedPayload,
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
    message.attachments.forEach((attachment, index) => {
      pushCandidate({
        ...(attachment || {}),
        id: attachment?.id || `${messageId || 'message'}-attachment-${index + 1}`
      }, 'message.attachments');
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

  [
    ['messageImageAttachmentIds', 'image'],
    ['messageVideoAttachmentIds', 'video'],
    ['messageAudioAttachmentIds', 'audio'],
    ['messageFileAttachmentIds', 'file']
  ].forEach(([field, forcedKind]) => {
    const ids = Array.isArray(message[field]) ? message[field] : [];
    ids.forEach((id) => {
      if (cleanOptionalText(id)) {
        pushCandidate({ id: cleanOptionalText(id) }, `message.${field}`, forcedKind);
      }
    });
  });

  return candidates;
}

function getMediaUrl(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return looksLikeMediaReference(value) ? value : null;
  }

  const keys = [
    'url',
    'imageUrl',
    'videoUrl',
    'audioUrl',
    'fileUrl',
    'mediaUrl',
    'downloadUrl',
    'previewUrl',
    'sourceUrl',
    'assetUrl',
    'outputUrl',
    'originalUrl',
    'signedUrl',
    'publicUrl',
    'resultUrl',
    'src',
    'href',
    'dataUrl',
    'imageData'
  ];
  for (const key of keys) {
    if (value[key]) {
      if (typeof value[key] === 'string' && looksLikeMediaReference(value[key], key)) {
        return value[key];
      }

      const nested = getMediaUrl(value[key]);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

function looksLikeMediaReference(value, keyHint = '') {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (normalized.startsWith('data:')) {
    const commaIndex = normalized.indexOf(',');
    return commaIndex > 0
      && /;base64(?:;|$)/i.test(normalized.slice(0, commaIndex))
      && isValidBase64Payload(normalized.slice(commaIndex + 1));
  }

  if (normalized.startsWith('blob:')) {
    return true;
  }

  if (!(normalized.startsWith('http://') || normalized.startsWith('https://') || normalized.startsWith('//'))) {
    return false;
  }

  if (/\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif|tiff|mp4|mov|webm|m4v|avi|mkv|ogv|mpeg|mpg|mp3|wav|ogg|m4a|aac|flac|opus|pdf)(?:$|[?#])/i.test(normalized)) {
    return true;
  }

  if (/\/(image|video|audio)\//i.test(normalized) || /[?&](mime|mimetype|contenttype|format|ext)=/i.test(normalized)) {
    return true;
  }

  return /(image|video|audio|media|asset|attachment|file|download|preview|source|output|result|render|recording)/i.test(String(keyHint || ''));
}

function hasInlineData(value) {
  const url = getMediaUrl(value);
  return typeof url === 'string' && url.startsWith('data:');
}

function getMimeType(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  return value.mimeType || value.mime_type || value.contentType || value.mediaType || value.fileType || value.mime || value.type || null;
}

function classifyMediaKind(value) {
  if (globalThis.VeniceArchiveRepository?.classifyMediaKind) {
    return globalThis.VeniceArchiveRepository.classifyMediaKind(value);
  }

  const url = typeof value === 'object' ? getMediaUrl(value) : typeof value === 'string' ? value : '';
  const signal = `${typeof value === 'object' ? value.type || '' : ''} ${getMimeType(value) || ''} ${url || ''}`.toLowerCase();

  if (signal.includes('video') || /\.(mp4|mov|webm|m4v|avi|mkv|ogv|mpeg|mpg)(?:$|\?)/.test(signal)) {
    return 'video';
  }

  if (signal.includes('audio') || /\.(mp3|wav|ogg|m4a|aac|flac|opus)(?:$|\?)/.test(signal)) {
    return 'audio';
  }

  if (signal.includes('image') || signal.includes('thumbnail') || signal.includes('poster') || /\.(png|jpg|jpeg|gif|webp|svg|bmp|avif|heic|heif|tiff|jfif)(?:$|\?)/.test(signal)) {
    return 'image';
  }

  if (signal.includes('file') || signal.includes('attachment') || signal.includes('document')) {
    return 'file';
  }

  return 'asset';
}

function detectApproxBytes(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'object' && typeof value.contentBinary === 'string') {
    return Math.floor((value.contentBinary.length * 3) / 4);
  }

  if (typeof value === 'object') {
    const numericSize = value.size || value.byteLength || value.bytes || null;
    if (typeof numericSize === 'number' && Number.isFinite(numericSize)) {
      return numericSize;
    }
  }

  const url = getMediaUrl(value);
  if (!url || !url.startsWith('data:')) {
    return null;
  }

  const commaIndex = url.indexOf(',');
  if (commaIndex === -1) {
    return null;
  }

  const base64 = url.slice(commaIndex + 1);
  return Math.floor((base64.length * 3) / 4);
}

function extractMessageText(message) {
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

async function performBackup() {
  if (exportInProgress) {
    return;
  }

  exportInProgress = true;
  updateUI();
  clearLog();
  showProgress(true);

  try {
    log('Preparing a fresh Venice snapshot...', 'info');
    setProgress(8, 'Refreshing Venice snapshot...');

    const snapshotReady = await refreshSnapshotPreview({ silent: true });
    if (!snapshotReady) {
      throw new Error('Open Venice.ai and wait for the snapshot to finish before exporting.');
    }

    const tab = await findVeniceTab();
    if (!tab) {
      throw new Error('No Venice.ai tab found. Please open Venice.ai first.');
    }

    setProgress(18, 'Connecting to Venice.ai...');
    const includeHtmlReport = elements.includeHtmlReport.checked && !encryptedMode;
    const includeMediaManifest = elements.includeMediaManifest.checked;
    const includeMediaGallery = elements.includeMediaGallery.checked && !encryptedMode;
    const includeKeyVault = elements.includeKeyVault.checked;

    setProgress(26, 'Loading Venice stores one by one...');
    const fullDataResponse = await loadArchivePayload({
      tab,
      keepEncrypted: encryptedMode,
      requests: ARCHIVE_STORE_REQUESTS,
      silent: false,
      phaseLabel: 'archive'
    });
    const fullData = fullDataResponse.data || {};

    setProgress(58, 'Building archive manifest...');
    const { archive, jsonBlob, fileIntegrity } = await buildArchive(fullDataResponse, {
      includeHtmlReport,
      includeMediaManifest,
      includeMediaGallery,
      includeKeyVault
    });

    const timestamp = archive.exportedAt.replace(/[:.]/g, '-').slice(0, 19);
    const modeSlug = encryptedMode ? 'encrypted' : 'readable';
    const fileName = `venice-archive-${modeSlug}-${timestamp}.json`;

    log(`Archive prepared: ${formatNumber(archive.stats.conversations)} conversations, ${formatNumber(archive.stats.messages)} messages, ${formatNumber(archive.stats.media)} media references`, 'success');
    setProgress(76, 'Downloading JSON archive...');
    await downloadBlob(jsonBlob, fileName, true);

    let reportFileName = null;
    if (includeHtmlReport) {
      reportFileName = `venice-archive-guide-${timestamp}.html`;
      const reportHtml = buildHtmlReport(archive);
      log(`Generating companion guide: ${reportFileName}`, 'info');
      setProgress(88, 'Downloading HTML guide...');
      await downloadBlob(new Blob([reportHtml], { type: 'text/html' }), reportFileName, false);
    }

    let galleryExport = null;
    if (includeMediaGallery) {
      galleryExport = await exportMediaGallery({
        tab,
        fullData,
        archive,
        timestamp
      });
    }

    setProgress(94, 'Recording archive metadata...');
    const exportRecord = {
      exportedAt: archive.exportedAt,
      fileName,
      reportFileName,
      galleryIndexFileName: galleryExport?.indexPath || null,
      galleryFolderName: galleryExport?.folderName || null,
      galleryZipFileName: galleryExport?.zipFileName || null,
      format: archive.format,
      sizeBytes: jsonBlob.size,
      sha256: fileIntegrity.sha256,
      keyFingerprint: archive.keyFingerprint,
      stats: archive.stats,
      media: archive.mediaIndex?.totals || {},
      mediaGallery: galleryExport ? {
        exportedFiles: galleryExport.exportedCount,
        linkedReferences: galleryExport.linkedOnlyCount,
        totalBytes: galleryExport.totalBytes
      } : null
    };

    await sendRuntimeMessage({
      type: 'RECORD_BACKUP_EXPORT',
      exportRecord
    });

    await refreshState();
    setProgress(100, 'Archive ready');
    log(`Archive checksum: ${fileIntegrity.sha256}`, 'success');
    if (galleryExport?.zipFileName) {
      log(`Media gallery ready: ${galleryExport.zipFileName}`, 'success');
    }

    const downloadedArtifacts = [fileName];
    if (reportFileName) {
      downloadedArtifacts.push(reportFileName);
    }
    if (galleryExport?.zipFileName) {
      downloadedArtifacts.push(galleryExport.zipFileName);
    }

    if (pendingDownloadRetries.length) {
      showStatus('warning', `${formatNumber(pendingDownloadRetries.length)} prepared archive artifact${pendingDownloadRetries.length === 1 ? ' is' : 's are'} waiting to be downloaded. Use Retry Downloads when ready.`);
    } else {
      showStatus('success', `Archive downloaded: ${downloadedArtifacts.join(', ')}`);
    }
  } catch (error) {
    log(`Backup failed: ${error.message}`, 'error');
    showStatus('error', `Backup failed: ${error.message}`);
  } finally {
    exportInProgress = false;
    updateUI();
    setTimeout(() => showProgress(false), 1500);
  }
}

async function performRepositoryBackup() {
  if (exportInProgress) {
    return;
  }

  if (encryptedMode) {
    showStatus('warning', 'Local archive repositories currently require readable mode so conversation and message files can be written as flat files.');
    return;
  }

  if (!supportsDirectoryWriteAccess()) {
    await performRepositoryPackageBackup();
    return;
  }

  exportInProgress = true;
  updateUI();
  clearLog();
  showProgress(true);

  try {
    log(archiveLocationHandle
      ? 'Reusing the saved local archive folder...'
      : 'Choose or create the local Venice archive repository folder...', 'info');
    setProgress(4, archiveLocationHandle ? 'Checking archive folder permission...' : 'Waiting for archive folder selection...');
    const rootHandle = await getWritableArchiveDirectoryHandle();

    log(`Archive repository folder selected: ${rootHandle.name}`, 'success');
    elements.repositoryStatus.textContent = `Selected repository: ${rootHandle.name}. Preparing a verified local archive update.`;
    setProgress(10, 'Refreshing Venice snapshot...');
    const snapshotReady = await refreshSnapshotPreview({ silent: true });
    if (!snapshotReady) {
      throw new Error('Open Venice.ai and wait for the snapshot to finish before exporting.');
    }

    const tab = await findVeniceTab();
    if (!tab) {
      throw new Error('No Venice.ai tab found. Please open Venice.ai first.');
    }

    setProgress(20, 'Loading Venice stores one by one...');
    const fullDataResponse = await loadArchivePayload({
      tab,
      keepEncrypted: false,
      requests: ARCHIVE_STORE_REQUESTS,
      silent: false,
      phaseLabel: 'archive repository'
    });

    setProgress(56, 'Building repository export model...');
    const { archive, fileIntegrity } = await buildArchive(fullDataResponse, {
      includeHtmlReport: true,
      includeMediaManifest: true,
      includeMediaGallery: false,
      includeKeyVault: elements.includeKeyVault.checked
    });

    const repositoryExport = await writeArchiveRepository(rootHandle, archive, fileIntegrity, {
      tab,
      fullData: fullDataResponse.data || {}
    });

    setProgress(94, 'Recording repository export metadata...');
    await sendRuntimeMessage({
      type: 'RECORD_BACKUP_EXPORT',
      exportRecord: {
        exportedAt: archive.exportedAt,
        fileName: repositoryExport.rootManifestPath,
        reportFileName: repositoryExport.viewerPath,
        galleryIndexFileName: null,
        galleryFolderName: null,
        galleryZipFileName: null,
        format: 'local-repository',
        sizeBytes: repositoryExport.bytesWritten,
        sha256: fileIntegrity.sha256,
        keyFingerprint: archive.keyFingerprint,
        stats: archive.stats,
        media: archive.mediaIndex?.totals || {},
        mediaGallery: null,
        repository: {
          exportId: repositoryExport.exportId,
          rootName: rootHandle.name,
          conversationsWritten: repositoryExport.conversationsWritten,
          conversationsUnchanged: repositoryExport.conversationsUnchanged,
          sourceStoresWritten: repositoryExport.sourceStoresWritten,
          sourceStoresUnchanged: repositoryExport.sourceStoresUnchanged,
          mediaFilesWritten: repositoryExport.mediaFilesWritten,
          unresolvedMedia: repositoryExport.unresolvedMedia,
          manifestStatus: repositoryExport.manifestStatus,
          filesWritten: repositoryExport.filesWritten
        }
      }
    });

    await refreshState();
    await refreshArchiveLocationStatus({ handle: rootHandle });
    setProgress(100, 'Local archive repository updated');
    const repositoryVerified = repositoryExport.manifestStatus === 'verified';
    log(`${repositoryVerified ? 'Verified' : 'Committed with media warnings'} repository manifest: ${repositoryExport.rootManifestPath}`, repositoryVerified ? 'success' : 'warning');
    log(`Conversation files updated: ${formatNumber(repositoryExport.conversationsWritten)} changed, ${formatNumber(repositoryExport.conversationsUnchanged)} unchanged, ${formatNumber(repositoryExport.messageCount)} messages indexed`, repositoryVerified ? 'success' : 'warning');
    log(`Lossless source stores: ${formatNumber(repositoryExport.sourceStoresWritten)} written, ${formatNumber(repositoryExport.sourceStoresUnchanged)} unchanged`, repositoryVerified ? 'success' : 'warning');
    log(`OPFS, attachment, URL, and live-captured media written: ${formatNumber(repositoryExport.mediaFilesWritten)} files • ${formatNumber(repositoryExport.unresolvedMedia)} unresolved`, repositoryVerified ? 'success' : 'warning');
    elements.repositoryStatus.textContent = `Latest repository update: ${rootHandle.name} • manifest ${repositoryExport.manifestStatus} • ${formatNumber(repositoryExport.sourceStoresWritten)} source stores written • ${formatNumber(repositoryExport.sourceStoresUnchanged)} source stores unchanged • ${formatNumber(repositoryExport.conversationsWritten)} changed conversations • ${formatNumber(repositoryExport.mediaFilesWritten)} media files written • ${formatNumber(repositoryExport.unresolvedMedia)} unresolved media.`;
    if (repositoryExport.manifestStatus === 'verified') {
      showStatus('success', `Local archive repository updated and verified in ${rootHandle.name}. Open viewer/index.html from that folder to browse it without a server.`);
    } else {
      showStatus('warning', `Local archive repository updated in ${rootHandle.name}, but media coverage is incomplete. Review indexes/unresolved-media.json before clearing Venice data.`);
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      log('Local archive update canceled before any Venice data was written.', 'warning');
      showStatus('warning', 'Local archive update canceled. No repository commit was made.');
    } else {
      log(`Local archive update failed: ${error.message}`, 'error');
      showStatus('error', `Local archive update failed: ${error.message}`);
      elements.repositoryStatus.textContent = 'Local archive update failed before the root manifest commit. Re-authorize the saved folder and run Sync now again; unchanged conversation files and existing media are skipped where possible.';
    }
  } finally {
    exportInProgress = false;
    updateUI();
    setTimeout(() => showProgress(false), 1500);
  }
}

function supportsDirectoryWriteAccess() {
  return typeof globalThis.showDirectoryPicker === 'function';
}

function openArchiveLocationDatabase() {
  if (!globalThis.indexedDB) {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(ARCHIVE_LOCATION_DB_NAME, ARCHIVE_LOCATION_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(ARCHIVE_LOCATION_STORE)) {
        request.result.createObjectStore(ARCHIVE_LOCATION_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Archive location storage could not be opened.'));
  });
}

function readArchiveLocationRecord() {
  return openArchiveLocationDatabase().then((database) => {
    if (!database) {
      return null;
    }

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(ARCHIVE_LOCATION_STORE, 'readonly');
      const request = transaction.objectStore(ARCHIVE_LOCATION_STORE).get(ARCHIVE_LOCATION_KEY);
      request.onsuccess = () => {
        database.close();
        resolve(request.result || null);
      };
      request.onerror = () => {
        database.close();
        reject(request.error || new Error('Archive location could not be read.'));
      };
    });
  });
}

function writeArchiveLocationRecord(record) {
  return openArchiveLocationDatabase().then((database) => {
    if (!database) {
      throw new Error('This browser context cannot persist a local archive folder handle.');
    }

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(ARCHIVE_LOCATION_STORE, 'readwrite');
      const request = transaction.objectStore(ARCHIVE_LOCATION_STORE).put(record, ARCHIVE_LOCATION_KEY);
      request.onsuccess = () => {
        database.close();
        resolve();
      };
      request.onerror = () => {
        database.close();
        reject(request.error || new Error('Archive location could not be saved.'));
      };
    });
  });
}

function deleteArchiveLocationRecord() {
  return openArchiveLocationDatabase().then((database) => {
    if (!database) {
      return;
    }

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(ARCHIVE_LOCATION_STORE, 'readwrite');
      const request = transaction.objectStore(ARCHIVE_LOCATION_STORE).delete(ARCHIVE_LOCATION_KEY);
      request.onsuccess = () => {
        database.close();
        resolve();
      };
      request.onerror = () => {
        database.close();
        reject(request.error || new Error('Archive location could not be forgotten.'));
      };
    });
  });
}

async function persistArchiveLocation(record) {
  try {
    await writeArchiveLocationRecord(record);
    return true;
  } catch (error) {
    log(`Archive folder selected, but its handle could not be persisted: ${error.message || 'browser storage error'}`, 'warning');
    return false;
  }
}

async function requestArchiveDirectoryPermission(handle, request = false) {
  if (!handle) {
    return false;
  }

  if (typeof handle.queryPermission === 'function') {
    let permission = await handle.queryPermission({ mode: 'readwrite' });
    if (permission === 'granted') {
      return true;
    }
    if (request && permission === 'prompt' && typeof handle.requestPermission === 'function') {
      permission = await handle.requestPermission({ mode: 'readwrite' });
    }
    return permission === 'granted';
  }

  // Some Chromium builds expose writable handles without the permission query
  // methods. The actual write will still fail safely if permission is absent.
  return true;
}

async function refreshArchiveLocationStatus({ handle = null } = {}) {
  try {
    const record = handle
      ? { ...(archiveLocation || {}), handle, name: handle.name || archiveLocation?.name || 'Archive folder' }
      : await readArchiveLocationRecord();
    archiveLocationHandle = record?.handle || null;
    archiveLocation = record || null;

    if (archiveLocationHandle) {
      const permission = await requestArchiveDirectoryPermission(archiveLocationHandle, false);
      archiveLocation.permission = permission ? 'granted' : 'prompt';
      if (permission) {
        try {
          const manifest = await readRepositoryRootManifest(archiveLocationHandle);
          archiveLocation.manifestStatus = manifest?.verification?.status || 'empty';
          archiveLocation.archiveId = manifest?.archiveId || null;
          archiveLocation.latestExportId = manifest?.latestExportId || null;
        } catch (error) {
          archiveLocation.manifestStatus = 'error';
          archiveLocation.error = error.message || 'archive manifest could not be read';
          log(`Archive folder is writable, but its manifest needs review: ${archiveLocation.error}`, 'warning');
        }
      }
    }
  } catch (error) {
    archiveLocationHandle = null;
    archiveLocation = archiveLocation
      ? { ...archiveLocation, permission: 'error', error: error.message || 'permission check failed' }
      : null;
    log(`Archive location status unavailable: ${error.message || 'folder handle could not be checked'}`, 'warning');
  }

  updateArchiveLocationUI();
}

function updateArchiveLocationUI() {
  const hasDirectoryAccess = supportsDirectoryWriteAccess();
  const hasHandle = Boolean(archiveLocationHandle);
  const permissionGranted = archiveLocation?.permission === 'granted';
  const manifestStatus = archiveLocation?.manifestStatus || 'empty';

  if (!hasDirectoryAccess) {
    elements.archiveLocationBadge.className = 'archive-location-badge unavailable';
    elements.archiveLocationBadge.textContent = 'ZIP mode';
    elements.archiveLocationCopy.textContent = 'Brave does not let this extension page keep write access to a folder. The main action will download a full archive ZIP; extract it into one private folder, then apply later incremental ZIPs over that same folder.';
    elements.chooseArchiveLocationBtn.hidden = false;
    elements.chooseArchiveLocationBtn.disabled = exportInProgress;
    elements.chooseArchiveLocationBtn.textContent = 'Why ZIP mode?';
    elements.verifyArchiveLocationBtn.hidden = true;
    elements.forgetArchiveLocationBtn.hidden = true;
    if (elements.repositoryPackageCard && 'open' in elements.repositoryPackageCard) {
      elements.repositoryPackageCard.open = true;
    }
    return;
  }

  elements.chooseArchiveLocationBtn.hidden = false;
  elements.chooseArchiveLocationBtn.disabled = exportInProgress;
  elements.verifyArchiveLocationBtn.hidden = !hasHandle || !permissionGranted;
  elements.verifyArchiveLocationBtn.disabled = exportInProgress;
  elements.forgetArchiveLocationBtn.hidden = !hasHandle;
  elements.forgetArchiveLocationBtn.disabled = exportInProgress;
  elements.chooseArchiveLocationBtn.textContent = hasHandle && !permissionGranted ? 'Re-authorize folder' : (hasHandle ? 'Change folder' : 'Choose archive folder');

  if (!hasHandle) {
    elements.archiveLocationBadge.className = 'archive-location-badge none';
    elements.archiveLocationBadge.textContent = 'Not set';
    elements.archiveLocationCopy.textContent = 'Choose a private folder once. The extension will create the full repository there, then update it in place on later Sync now runs.';
    return;
  }

  if (!permissionGranted) {
    elements.archiveLocationBadge.className = 'archive-location-badge warning';
    elements.archiveLocationBadge.textContent = 'Permission needed';
    elements.archiveLocationCopy.textContent = `Archive folder saved as “${archiveLocation.name || 'selected folder'}”, but permission must be re-authorized before it can be updated.`;
    return;
  }

  const needsReview = manifestStatus === 'incomplete' || manifestStatus === 'error';
  const statusText = manifestStatus === 'verified'
    ? 'verified'
    : (manifestStatus === 'incomplete' ? 'needs media review' : (manifestStatus === 'error' ? 'manifest review' : 'ready for first export'));
  elements.archiveLocationBadge.className = `archive-location-badge ${needsReview ? 'warning' : 'ready'}`;
  elements.archiveLocationBadge.textContent = manifestStatus === 'empty' ? 'Ready' : statusText;
  elements.archiveLocationCopy.textContent = `Archive folder: ${archiveLocation.name || 'selected folder'}. ${manifestStatus === 'empty' ? 'Press Create full archive to initialise it.' : (needsReview ? 'Review the manifest before clearing Venice data; Sync now can retry recoverable media.' : 'Press Sync now to add new and changed Venice content without deleting historical files.')}`;
}

async function chooseArchiveLocation() {
  if (exportInProgress) {
    return;
  }

  if (!supportsDirectoryWriteAccess()) {
    showStatus('warning', 'Brave cannot grant a reusable folder handle from this extension page. Use “Download full archive ZIP”, extract it into one private folder, and apply future incremental ZIPs over that folder. Nothing is written until you choose where to extract the ZIP.');
    if (elements.repositoryPackageCard && 'open' in elements.repositoryPackageCard) {
      elements.repositoryPackageCard.open = true;
      elements.repositoryPackageCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    return;
  }

  try {
    let handle = archiveLocationHandle;
    if (handle && archiveLocation?.permission !== 'granted') {
      const permissionGranted = await requestArchiveDirectoryPermission(handle, true);
      if (permissionGranted) {
        await persistArchiveLocation({ ...(archiveLocation || {}), handle, name: handle.name || archiveLocation?.name || 'Archive folder', savedAt: archiveLocation?.savedAt || new Date().toISOString() });
        await refreshArchiveLocationStatus({ handle });
        showStatus('success', `Archive folder re-authorized: ${handle.name}. Press ${archiveLocation?.manifestStatus === 'empty' ? 'Create full archive' : 'Sync now'} when ready.`);
        updateUI();
        return;
      }
    }

    handle = await globalThis.showDirectoryPicker({
      id: 'venice-archive-repository',
      mode: 'readwrite',
      startIn: 'documents'
    });
    await persistArchiveLocation({
      handle,
      name: handle.name || 'Archive folder',
      savedAt: new Date().toISOString(),
      manifestStatus: 'empty'
    });
    await refreshArchiveLocationStatus({ handle });
    showStatus('success', `Archive folder selected: ${handle.name}. Press Create full archive to initialise it.`);
    updateUI();
  } catch (error) {
    if (error?.name === 'AbortError') {
      showStatus('warning', 'Archive folder selection canceled. No local archive was changed.');
      return;
    }
    log(`Archive folder selection failed: ${error.message || 'unknown error'}`, 'error');
    showStatus('error', `Archive folder selection failed: ${error.message || 'unknown error'}`);
  }
}

async function forgetArchiveLocation() {
  if (exportInProgress) {
    return;
  }

  try {
    await deleteArchiveLocationRecord();
    archiveLocation = null;
    archiveLocationHandle = null;
    updateUI();
    showStatus('success', 'Archive location forgotten. The folder and its files were not deleted.');
  } catch (error) {
    showStatus('error', `Archive location could not be forgotten: ${error.message || 'storage error'}`);
  }
}

async function readRepositoryTextFile(rootHandle, relativePath) {
  const segments = String(relativePath || '').split('/').filter(Boolean);
  if (!segments.length) {
    throw new Error('Archive file path is empty.');
  }

  const fileName = segments.pop();
  let directoryHandle = rootHandle;
  for (const segment of segments) {
    directoryHandle = await directoryHandle.getDirectoryHandle(segment, { create: false });
  }
  const fileHandle = await directoryHandle.getFileHandle(fileName, { create: false });
  return (await fileHandle.getFile()).text();
}

async function verifyArchiveLocation() {
  if (exportInProgress || !supportsDirectoryWriteAccess()) {
    return;
  }

  try {
    const rootHandle = await getWritableArchiveDirectoryHandle();
    const repository = getArchiveRepositoryUtilities();
    const manifest = await readRepositoryRootManifest(rootHandle);
    if (!manifest) {
      throw new Error('No venice-archive.manifest.json exists in the selected folder yet.');
    }

    const unresolvedIndexPresent = await repositoryFileExists(rootHandle, repository.INDEX_FILES.unresolvedMedia);
    const unresolvedText = unresolvedIndexPresent
      ? await readRepositoryTextFile(rootHandle, repository.INDEX_FILES.unresolvedMedia)
      : '';
    let unresolvedCount = 0;
    try {
      const unresolved = JSON.parse(unresolvedText);
      unresolvedCount = Array.isArray(unresolved) ? unresolved.length : 0;
    } catch (_) {
      unresolvedCount = -1;
    }

    const viewerPresent = await repositoryFileExists(rootHandle, 'viewer/index.html');
    const status = manifest.verification?.status || 'unknown';
    const verified = status === 'verified' && unresolvedIndexPresent && unresolvedCount === 0 && viewerPresent;
    await refreshArchiveLocationStatus({ handle: rootHandle });
    log(verified
      ? `Archive verification passed for ${rootHandle.name}: manifest verified, unresolved media empty, viewer present.`
      : `Archive verification needs review for ${rootHandle.name}: manifest ${status}, unresolved media ${!unresolvedIndexPresent ? 'index missing' : (unresolvedCount < 0 ? 'could not be read' : formatNumber(unresolvedCount))}, viewer ${viewerPresent ? 'present' : 'missing'}.`, verified ? 'success' : 'warning');
    showStatus(verified ? 'success' : 'warning', verified
      ? `Archive verified in ${rootHandle.name}. It is ready for a normal browse/checkpoint.`
      : `Archive needs review in ${rootHandle.name}. Run npm run verify:archive for full file-level checks before clearing Venice data.`);
    updateUI();
  } catch (error) {
    if (error?.name === 'AbortError') {
      showStatus('warning', 'Archive verification canceled. No local files were changed.');
      return;
    }
    log(`Archive verification failed: ${error.message || 'unknown error'}`, 'error');
    showStatus('error', `Archive verification failed: ${error.message || 'unknown error'}`);
  }
}

async function getWritableArchiveDirectoryHandle() {
  if (archiveLocationHandle && await requestArchiveDirectoryPermission(archiveLocationHandle, true)) {
    return archiveLocationHandle;
  }

  const handle = await globalThis.showDirectoryPicker({
    id: 'venice-archive-repository',
    mode: 'readwrite',
    startIn: 'documents'
  });
  await persistArchiveLocation({
    handle,
    name: handle.name || 'Archive folder',
    savedAt: archiveLocation?.savedAt || new Date().toISOString(),
    manifestStatus: archiveLocation?.manifestStatus || 'empty'
  });
  archiveLocationHandle = handle;
  archiveLocation = { ...(archiveLocation || {}), handle, name: handle.name || 'Archive folder', permission: 'granted' };
  updateArchiveLocationUI();
  return handle;
}

function updateRepositoryAccessModeUI() {
  const hasDirectoryAccess = supportsDirectoryWriteAccess();
  elements.repositoryBtn.textContent = !currentSnapshot && !exportInProgress
    ? 'Waiting for Venice…'
    : (hasDirectoryAccess
      ? (archiveLocationHandle && archiveLocation?.manifestStatus && archiveLocation.manifestStatus !== 'empty' ? 'Sync archive now' : 'Create full archive')
      : (elements.repositoryDiffPackage.checked ? 'Download incremental ZIP' : 'Download full archive ZIP'));
  elements.repositoryPackageCard.hidden = false;

  if (!hasDirectoryAccess && !exportInProgress) {
    const statusText = String(elements.repositoryStatus.textContent || '');
    const shouldSetFallbackStatus = !statusText
      || statusText.includes('No local archive repository selected yet')
      || statusText.includes('Selected repository:');

    if (shouldSetFallbackStatus) {
      elements.repositoryStatus.textContent = currentSnapshot
        ? 'Ready to download. The first ZIP is complete; later incremental ZIPs update the same extracted archive folder.'
        : 'Waiting for Venice access before the archive can be built.';
    }
  }
}

async function refreshPackageBaselineStatus() {
  try {
    packageBaseline = await loadRepositoryPackageBaseline();
  } catch (error) {
    packageBaseline = null;
    log(`Package baseline status unavailable: ${error.message || 'browser storage could not be read'}`, 'warning');
  }
  updatePackageBaselineUI();
}

function updatePackageBaselineUI() {
  const hasDirectoryAccess = supportsDirectoryWriteAccess();
  const hasBaseline = Boolean(packageBaseline);
  const baselineNeedsReview = packageBaseline?.manifestStatus === 'incomplete';
  const baselineDate = packageBaseline?.savedAt ? formatRelativeTime(packageBaseline.savedAt) : null;

  elements.repositoryPackageCard.hidden = false;
  elements.repositoryDiffPackage.disabled = exportInProgress
    || hasDirectoryAccess
    || !currentSnapshot
    || encryptedMode
    || !hasBaseline;

  elements.packageBaselineBadge.className = `package-baseline-badge ${hasDirectoryAccess ? 'folder' : (baselineNeedsReview ? 'warning' : (hasBaseline ? 'ready' : 'none'))}`;
  elements.packageBaselineBadge.textContent = hasDirectoryAccess
    ? 'Folder mode'
    : (baselineNeedsReview ? 'Baseline needs review' : (hasBaseline ? 'Baseline ready' : 'Full package first'));

  elements.packageDiffHelp.textContent = hasDirectoryAccess
    ? 'Folder mode writes directly to the archive folder. This checkbox is only used when Brave requires ZIP downloads.'
    : (hasBaseline
      ? (baselineNeedsReview
        ? 'A previous package was saved with coverage warnings. Incremental mode will retry those records, but do not clear Venice data until a later manifest is verified.'
        : 'Only changed records and refreshed indexes are downloaded. Apply every diff from the viewer or extract it over the same archive folder; never use a diff as a standalone archive.')
      : 'Download and extract a full package once. The extension will enable incremental packages after it saves a baseline in this Brave profile.');

  elements.packageBaselineMeta.textContent = hasDirectoryAccess
    ? 'The selected folder is the durable archive. Keep it private and back it up separately.'
    : (hasBaseline
      ? `Last package baseline saved ${baselineDate}${baselineNeedsReview ? ' with coverage warnings' : ''}. The next incremental ZIP belongs in the same archive folder; the viewer can apply it directly when folder access is available.`
      : 'No package baseline saved in this Brave profile yet. A full package is required before incremental mode can be used.');
}

async function performRepositoryPackageBackup() {
  if (exportInProgress) {
    return;
  }

  const diffOnly = Boolean(elements.repositoryDiffPackage.checked);
  if (diffOnly) {
    await refreshPackageBaselineStatus();
    if (!packageBaseline) {
      elements.repositoryDiffPackage.checked = false;
      updatePackageBaselineUI();
      log('Incremental package blocked: download and extract a full package first so unchanged archive files have a durable home.', 'warning');
      showStatus('warning', 'Download and extract a full package first. Incremental mode is now disabled until its baseline is saved.');
      return;
    }
  }

  exportInProgress = true;
  updateUI();
  clearLog();
  showProgress(true);

  try {
    log('Folder write access is unavailable. Preparing a downloadable local archive package instead.', 'warning');
    log(diffOnly
      ? 'Incremental package: changed files plus refreshed manifests/indexes/viewer. Extract it over the same archive folder as the previous package.'
      : 'Full package: complete current repository files. Extract it into a new/private archive folder before using incremental mode.', 'info');
    if (diffOnly && packageBaseline?.manifestStatus === 'incomplete') {
      log('The previous package baseline had media warnings; this incremental run will retry those records. Keep Venice data until a later manifest is verified.', 'warning');
    }

    setProgress(10, 'Refreshing Venice snapshot...');
    const snapshotReady = await refreshSnapshotPreview({ silent: true });
    if (!snapshotReady) {
      throw new Error('Open Venice.ai and wait for the snapshot to finish before exporting.');
    }

    const tab = await findVeniceTab();
    if (!tab) {
      throw new Error('No Venice.ai tab found. Please open Venice.ai first.');
    }

    setProgress(20, 'Loading Venice stores one by one...');
    const fullDataResponse = await loadArchivePayload({
      tab,
      keepEncrypted: false,
      requests: ARCHIVE_STORE_REQUESTS,
      silent: false,
      phaseLabel: 'archive package'
    });

    setProgress(56, 'Building package export model...');
    const { archive, fileIntegrity } = await buildArchive(fullDataResponse, {
      includeHtmlReport: true,
      includeMediaManifest: true,
      includeMediaGallery: false,
      includeKeyVault: elements.includeKeyVault.checked
    });

    const packageExport = await buildRepositoryDownloadPackage({
      archive,
      fileIntegrity,
      tab,
      fullData: fullDataResponse.data || {},
      diffOnly
    });

    setProgress(94, 'Downloading package zip...');
    const downloadResult = await downloadBlob(packageExport.zipBlob, packageExport.zipFileName, true, {
      retryMetadata: {
        onSuccess: async () => {
          await saveRepositoryPackageBaseline(packageExport.baseline);
          packageBaseline = packageExport.baseline;
          updatePackageBaselineUI();
        }
      }
    });
    if (!downloadResult.ok) {
      log(`Package prepared but not downloaded yet: ${packageExport.zipFileName}`, 'warning');
      elements.repositoryStatus.textContent = `Prepared package: ${packageExport.zipFileName}. Use Retry Downloads to save it, then extract it into your archive folder.`;
      showStatus('warning', `Package prepared: ${packageExport.zipFileName}. Use Retry Downloads to save it.`);
      return;
    }

    await saveRepositoryPackageBaseline(packageExport.baseline);
    packageBaseline = packageExport.baseline;
    updatePackageBaselineUI();

    await sendRuntimeMessage({
      type: 'RECORD_BACKUP_EXPORT',
      exportRecord: {
        exportedAt: archive.exportedAt,
        fileName: packageExport.zipFileName,
        reportFileName: packageExport.viewerPath,
        galleryIndexFileName: null,
        galleryFolderName: null,
        galleryZipFileName: null,
        format: diffOnly ? 'local-repository-package-diff' : 'local-repository-package-full',
        sizeBytes: packageExport.zipBlob.size,
        sha256: await digestBlobHex(packageExport.zipBlob),
        keyFingerprint: archive.keyFingerprint,
        stats: archive.stats,
        media: archive.mediaIndex?.totals || {},
        mediaGallery: null,
        repository: {
          exportId: packageExport.exportId,
          mode: diffOnly ? 'diff' : 'full',
          conversationsWritten: packageExport.conversationsPackaged,
          conversationsUnchanged: packageExport.conversationsSkipped,
          sourceStoresWritten: packageExport.sourceStoresPackaged,
          sourceStoresUnchanged: packageExport.sourceStoresUnchanged,
          mediaFilesWritten: packageExport.mediaFilesPackaged,
          failedMedia: packageExport.failedMedia,
          unresolvedMedia: packageExport.unresolvedMedia,
          manifestStatus: packageExport.manifestStatus,
          filesWritten: packageExport.filesPackaged,
          packageFileName: packageExport.zipFileName
        }
      }
    });

    await refreshState();
    setProgress(100, 'Local archive package ready');
    const packageVerified = packageExport.manifestStatus === 'verified';
    log(packageVerified
      ? `Verified local archive package downloaded: ${packageExport.zipFileName}`
      : `Local archive package downloaded but needs media review: ${packageExport.zipFileName}`,
    packageVerified ? 'success' : 'warning');
    log(`Package contents: ${formatNumber(packageExport.filesPackaged)} files • ${formatNumber(packageExport.sourceStoresPackaged)} source stores • ${formatNumber(packageExport.conversationsPackaged)} conversations • ${formatNumber(packageExport.mediaFilesPackaged)} media files • ${formatNumber(packageExport.unresolvedMedia)} unresolved${packageExport.failedMedia ? ` • ${formatNumber(packageExport.failedMedia)} failed` : ''}`,
    packageVerified ? 'success' : 'warning');
    if (diffOnly) {
      log(`Diff summary: ${formatNumber(packageExport.conversationsAdded)} added, ${formatNumber(packageExport.conversationsChanged)} changed, ${formatNumber(packageExport.conversationsSkipped)} unchanged.`, 'info');
    }

    elements.repositoryStatus.textContent = diffOnly
      ? `Latest package: ${packageExport.zipFileName} • manifest ${packageExport.manifestStatus} • diff mode • ${formatNumber(packageExport.conversationsPackaged)} changed conversations • ${formatNumber(packageExport.mediaFilesPackaged)} media files • ${formatNumber(packageExport.unresolvedMedia)} unresolved media.`
      : `Latest package: ${packageExport.zipFileName} • manifest ${packageExport.manifestStatus} • full mode • ${formatNumber(packageExport.conversationsPackaged)} conversations • ${formatNumber(packageExport.mediaFilesPackaged)} media files • ${formatNumber(packageExport.unresolvedMedia)} unresolved media.`;

    if (packageExport.manifestStatus === 'verified') {
      showStatus('success', diffOnly
      ? `Verified incremental package downloaded: ${packageExport.zipFileName}. Apply it from the archive viewer or extract it over the same archive folder as the previous package.`
        : `Verified full package downloaded: ${packageExport.zipFileName}. Extract it into one new/private archive folder before using incremental mode.`);
    } else {
      showStatus('warning', diffOnly
        ? `Incremental package downloaded, but media coverage is incomplete. Extract ${packageExport.zipFileName} over the same archive folder and review indexes/unresolved-media.json before clearing Venice data.`
        : `Full package downloaded, but media coverage is incomplete. Extract ${packageExport.zipFileName} into one archive folder and review indexes/unresolved-media.json before clearing Venice data.`);
    }
  } catch (error) {
    log(`Local archive package export failed: ${error.message}`, 'error');
    showStatus('error', `Local archive package export failed: ${error.message}`);
  } finally {
    exportInProgress = false;
    updateUI();
    setTimeout(() => showProgress(false), 1500);
  }
}

async function getLocalStorageValue(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([key], (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result?.[key] ?? null);
    });
  });
}

async function setLocalStorageValue(key, value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function loadRepositoryPackageBaseline() {
  const baseline = await getLocalStorageValue(REPOSITORY_PACKAGE_BASELINE_KEY);
  if (!baseline || typeof baseline !== 'object') {
    return null;
  }

  if (baseline.version !== REPOSITORY_PACKAGE_BASELINE_VERSION) {
    return null;
  }

  return baseline;
}

async function saveRepositoryPackageBaseline(baseline) {
  await setLocalStorageValue(REPOSITORY_PACKAGE_BASELINE_KEY, baseline);
}

function buildPreviousManifestFromBaseline(baseline) {
  if (!baseline || typeof baseline !== 'object' || !baseline.manifest || typeof baseline.manifest !== 'object') {
    return null;
  }

  return {
    schemaVersion: baseline.manifest.schemaVersion || getArchiveRepositoryUtilities().REPOSITORY_SCHEMA_VERSION,
    archiveId: baseline.manifest.archiveId || null,
    createdAt: baseline.manifest.createdAt || null,
    totals: {
      exports: baseline.manifest.exports || 0
    },
    records: {
      conversations: baseline.manifest.conversations || {},
      settings: baseline.manifest.settings || {},
      studio: baseline.manifest.studio || {},
      unresolvedMedia: baseline.manifest.unresolvedMedia || {},
      sourceStores: baseline.manifest.sourceStores || {}
    }
  };
}

function buildRepositoryPackageBaseline({ rootManifest, mediaHashes }) {
  return {
    version: REPOSITORY_PACKAGE_BASELINE_VERSION,
    savedAt: new Date().toISOString(),
    manifestStatus: rootManifest.verification?.status || 'unknown',
    manifest: {
      schemaVersion: rootManifest.schemaVersion,
      archiveId: rootManifest.archiveId,
      createdAt: rootManifest.createdAt,
      exports: rootManifest.totals?.exports || 0,
      conversations: rootManifest.records?.conversations || {},
      settings: rootManifest.records?.settings || {},
      studio: rootManifest.records?.studio || {},
      unresolvedMedia: rootManifest.records?.unresolvedMedia || {},
      sourceStores: rootManifest.records?.sourceStores || {}
    },
    mediaHashes: Array.from(new Set(mediaHashes.filter(Boolean))).sort()
  };
}

function buildRepositorySourceStoreArtifacts(archive) {
  const coverage = globalThis.VeniceArchiveCoverage;
  const sourceStores = coverage?.getSourceStores(archive) || {};
  const manifests = Array.isArray(archive.storeManifests) ? archive.storeManifests : [];

  const seenPaths = new Map();
  return manifests.map((manifest) => {
    const sourceStore = sourceStores[manifest.name];
    if (!sourceStore || !Array.isArray(sourceStore.records)) {
      throw new Error(`Lossless source records are unavailable for discovered store ${manifest.name}.`);
    }
    if (sourceStore.records.length !== manifest.count) {
      throw new Error(`Source store ${manifest.name} changed while the repository model was being built.`);
    }
    const path = manifest.path || coverage.buildSourceStorePath(manifest.name);
    const previousName = seenPaths.get(path);
    if (previousName && previousName !== manifest.name) {
      throw new Error(`Source stores ${previousName} and ${manifest.name} resolve to the same repository path.`);
    }
    seenPaths.set(path, manifest.name);
    const blob = buildArrayJsonBlob(sourceStore.records);
    if (blob.size !== manifest.payloadBytes) {
      throw new Error(`Source store ${manifest.name} byte verification failed before repository write.`);
    }
    return {
      ...manifest,
      path,
      blob
    };
  });
}

async function buildRepositoryDownloadPackage({ archive, fileIntegrity, tab, fullData, diffOnly }) {
  const repository = getArchiveRepositoryUtilities();
  const exportId = `export-${archive.exportedAt.replace(/[:.]/g, '-').slice(0, 19)}`;
  const finishedAt = new Date().toISOString();
  const baseline = await loadRepositoryPackageBaseline();
  const previousManifest = diffOnly ? buildPreviousManifestFromBaseline(baseline) : null;
  const baselineMediaHashes = new Set(diffOnly ? (baseline?.mediaHashes || []) : []);

  const fileMap = new Map();
  const writeData = (relativePath, data) => {
    fileMap.set(relativePath, {
      data,
      lastModified: finishedAt
    });
  };

  const sourceStoreArtifacts = buildRepositorySourceStoreArtifacts(archive);
  let sourceStoresPackaged = 0;
  let sourceStoresUnchanged = 0;
  setProgress(60, 'Packaging lossless Venice source stores...');
  sourceStoreArtifacts.forEach((artifact) => {
    const previous = previousManifest?.records?.sourceStores?.[artifact.name];
    const unchanged = Boolean(previous?.sha256 && previous.sha256 === artifact.sha256);
    if (diffOnly && unchanged) {
      sourceStoresUnchanged += 1;
      return;
    }
    writeData(artifact.path, artifact.blob);
    sourceStoresPackaged += 1;
  });

  setProgress(62, 'Preparing repository package model...');
  const conversationArtifacts = buildRepositoryConversationArtifacts(archive, { previousManifest });

  setProgress(66, 'Materializing embedded attachments for package...');
  const embeddedMedia = await materializeRepositoryEmbeddedAttachmentsForPackage({
    archive,
    conversationArtifacts,
    writeData,
    knownHashes: baselineMediaHashes,
    diffOnly
  });

  setProgress(68, 'Materializing fetchable Venice media for package...');
  const galleryMedia = await materializeRepositoryGalleryMediaForPackage({
    archive,
    fullData: fullData || archive.data || {},
    tab,
    conversationArtifacts,
    writeData,
    knownHashes: new Set([
      ...Array.from(baselineMediaHashes),
      ...embeddedMedia.map((item) => item.sha256).filter(Boolean)
    ]),
    diffOnly
  });

  setProgress(69, 'Materializing Venice OPFS media for package...');
  const opfsMedia = await materializeRepositoryOpfsMedia({
    tab,
    conversationArtifacts,
    knownHashes: new Set([
      ...Array.from(baselineMediaHashes),
      ...embeddedMedia.map((item) => item.sha256).filter(Boolean),
      ...galleryMedia.map((item) => item.sha256).filter(Boolean)
    ]),
    mediaExists: async () => false,
    writeMedia: async (path, blob) => writeData(path, blob)
  });

  setProgress(69, 'Materializing live-captured media for package...');
  const capturedMedia = await materializeRepositoryCapturedMediaForPackage({
    tab,
    conversationArtifacts,
    writeData,
    knownHashes: new Set([
      ...Array.from(baselineMediaHashes),
      ...embeddedMedia.map((item) => item.sha256).filter(Boolean),
      ...galleryMedia.map((item) => item.sha256).filter(Boolean),
      ...opfsMedia.map((item) => item.sha256).filter(Boolean)
    ]),
    diffOnly
  });

  const materializedMedia = [...embeddedMedia, ...galleryMedia, ...opfsMedia, ...capturedMedia];
  refreshRepositoryConversationArtifacts(conversationArtifacts);
  await annotateRepositoryFingerprints(conversationArtifacts);
  const indexes = buildRepositoryIndexes(archive, conversationArtifacts, materializedMedia);
  const supplementalRecords = await buildRepositorySupplementalRecords(archive, indexes);
  const writePlan = buildRepositoryWritePlan({
    conversationArtifacts,
    indexes,
    materializedMedia: indexes.materializedMedia,
    previousManifest
  });

  const conversationsToPackage = diffOnly
    ? conversationArtifacts.filter((artifact) => {
      const previousRecord = previousManifest?.records?.conversations?.[artifact.id];
      return !previousRecord || previousRecord.recordHash !== artifact.recordHash;
    })
    : conversationArtifacts;

  conversationsToPackage.forEach((artifact) => {
    writeData(artifact.paths.json, `${JSON.stringify(artifact.json, null, 2)}\n`);
    writeData(artifact.paths.markdown, artifact.markdown);
  });

  const exportManifest = buildRepositoryExportManifest({
    archive,
    exportId,
    finishedAt,
    fileIntegrity,
    conversationArtifacts,
    indexes,
    supplementalRecords,
    sourceStoreArtifacts,
    writePlan,
    previousManifest,
    writeStats: {
      conversationsWritten: conversationsToPackage.length,
      conversationsUnchanged: Math.max(0, conversationArtifacts.length - conversationsToPackage.length),
      filesSkipped: diffOnly ? Math.max(0, (conversationArtifacts.length - conversationsToPackage.length) * 2) + sourceStoresUnchanged : 0,
      sourceStoresWritten: sourceStoresPackaged,
      sourceStoresUnchanged
    }
  });

  const rootManifest = buildRepositoryRootManifest({
    archive,
    exportId,
    finishedAt,
    conversationArtifacts,
    indexes,
    supplementalRecords,
    sourceStoreArtifacts,
    previousManifest,
    exportManifest
  });

  writeData(repository.INDEX_FILES.conversations, buildArrayJsonBlob(indexes.conversations));
  writeData(repository.INDEX_FILES.messages, indexes.messagesJsonl);
  writeData(repository.INDEX_FILES.media, buildRepositoryMediaIndexBlob(indexes.media));
  writeData(repository.INDEX_FILES.unresolvedMedia, buildArrayJsonBlob(indexes.unresolvedMedia));
  writeData('viewer/index.html', buildRepositoryViewerHtml({ rootManifest, exportManifest, indexes }));
  writeData('viewer/viewer-data.json', buildRepositoryViewerDataBlob(indexes.viewerData));
  writeData(`exports/${exportId}.manifest.json`, `${JSON.stringify(exportManifest, null, 2)}\n`);
  writeData(`logs/${exportId}.log.json`, `${JSON.stringify({ exportId, finishedAt, warnings: exportManifest.warnings }, null, 2)}\n`);
  writeData(repository.ROOT_MANIFEST_FILE, `${JSON.stringify(rootManifest, null, 2)}\n`);
  writeData('PACKAGE-README.txt', buildRepositoryPackageReadme({ exportId, diffOnly, rootManifest }));

  setProgress(90, 'Packaging repository zip...');
  const zipEntries = Array.from(fileMap.entries()).map(([path, entry]) => ({
    path,
    data: entry.data,
    lastModified: entry.lastModified
  }));
  const zipBlob = await buildStoredZip(zipEntries);

  const fileStamp = archive.exportedAt.replace(/[:.]/g, '-').slice(0, 19);
  const zipFileName = diffOnly
    ? `venice-local-archive-diff-${fileStamp}.zip`
    : `venice-local-archive-full-${fileStamp}.zip`;

  const nextMediaHashes = indexes.media.items
    .map((item) => cleanOptionalText(item?.sha256 || '').toLowerCase())
    .filter(Boolean);

  return {
    exportId,
    zipBlob,
    zipFileName,
    viewerPath: 'viewer/index.html',
    manifestStatus: rootManifest.verification?.status || 'unknown',
    filesPackaged: zipEntries.length,
    conversationsPackaged: conversationsToPackage.length,
    conversationsAdded: writePlan.conversationsAdded,
    conversationsChanged: writePlan.conversationsChanged,
    conversationsSkipped: writePlan.conversationsSkipped,
    sourceStoresPackaged,
    sourceStoresUnchanged,
    mediaFilesPackaged: indexes.materializedMedia.filter((item) => item.status === 'materialized').length,
    failedMedia: indexes.materializedMedia.filter((item) => item.status === 'failed').length,
    unresolvedMedia: indexes.unresolvedMedia.length,
    baseline: buildRepositoryPackageBaseline({
      rootManifest,
      mediaHashes: nextMediaHashes
    })
  };
}

function buildRepositoryPackageReadme({ exportId, diffOnly, rootManifest }) {
  const validationStep = diffOnly ? '4.' : '5.';
  const lines = [
    'Venice Local Archive Package',
    '============================',
    '',
    `Export ID: ${exportId}`,
    `Mode: ${diffOnly ? 'diff (changed files only plus refreshed manifests/indexes/viewer)' : 'full (complete repository files for this export)'}`,
    `Archive ID: ${rootManifest.archiveId || 'unknown'}`,
    '',
    diffOnly ? 'Apply this incremental package:' : 'Apply this first/full package:',
    ...(diffOnly
      ? [
        '1. Confirm that the matching full package (and any earlier incremental packages) has already been extracted into your private archive folder.',
        '2. Open viewer/index.html from that folder, choose this ZIP in “Keep this archive current”, and press “Apply to this archive” when folder access is available. Otherwise Extract this zip over that same folder and allow file overwrite when prompted. Do not start a new folder for a diff package.',
        '3. Reload viewer/index.html; it keeps the complete archive because unchanged historical files remain in place.'
      ]
      : [
        '1. Create or choose one private archive folder on a drive with enough space for media.',
        '2. Extract this zip into that new folder and allow file overwrite when prompted. Keep this folder as the canonical archive target.',
        '3. Open viewer/index.html from that folder before clearing any Venice site data. The viewer can apply later packages directly with “Apply to this archive” when this browser exposes folder access.',
        '4. Later, choose incremental package mode in the extension and always apply or extract each diff over this same folder.'
      ]),
    `${validationStep} Validate venice-archive.manifest.json and exports/<export-id>.manifest.json. Continue only when verification.status is verified.`,
    '',
    'Notes:',
    '- stores/ contains lossless source-store snapshots; media/sha256 contains OPFS and other materialized media.',
    '- Do not clear Venice site data unless verification.status is verified and indexes/unresolved-media.json is empty.',
    '- Diff packages do not delete historical files; they overwrite manifests/indexes/viewer and add changed/new files.',
    '- A diff package is not a standalone archive; it depends on the existing folder retaining unchanged historical files.',
    '- If a previous package was not applied or extracted into the same folder, run a full package export first.',
    '- The viewer writes the root manifest last during package application so an interrupted update does not advance the archive checkpoint prematurely.'
  ];

  return `${lines.join('\n')}\n`;
}

async function materializeRepositoryEmbeddedAttachmentsForPackage({ archive, conversationArtifacts, writeData, knownHashes = new Set(), diffOnly = false }) {
  const repository = getArchiveRepositoryUtilities();
  const messages = Array.isArray(archive.data?.messages) ? archive.data.messages : [];
  const messageRecords = new Map();
  conversationArtifacts.forEach((artifact) => {
    artifact.json.messages.forEach((message) => {
      if (message.id) {
        messageRecords.set(message.id, { artifact, message });
      }
    });
  });

  const materialized = [];
  const seenHashes = new Set();

  for (const sourceMessage of messages) {
    if (!Array.isArray(sourceMessage?.attachments) || !messageRecords.has(sourceMessage.id)) {
      continue;
    }

    const target = messageRecords.get(sourceMessage.id);
    for (let index = 0; index < sourceMessage.attachments.length; index += 1) {
      const attachment = sourceMessage.attachments[index];
      const attachmentPayload = getAttachmentPayloadValue(attachment);
      if (!attachmentPayload) {
        continue;
      }

      let decoded;
      try {
        decoded = decodeAttachmentPayload(attachmentPayload, attachment);
      } catch (error) {
        materialized.push({
          mediaId: `${sourceMessage.id || 'message'}-attachment-${index + 1}`,
          kind: 'file',
          status: 'failed',
          source: 'message.attachments',
          sourceRecordId: attachment?.id || `${sourceMessage.id || 'message'}-attachment-${index + 1}`,
          fileName: attachment.fileName || attachment.name || null,
          messageId: sourceMessage.id,
          conversationId: sourceMessage.conversationId || target.artifact.id,
          reason: `Attachment payload could not be decoded: ${error.message}`
        });
        continue;
      }

      if (!decoded.bytes.byteLength) {
        continue;
      }

      const mimeType = getAttachmentMimeType(attachment, decoded.mimeType);
      const kind = classifyMediaKind({ mimeType, type: attachment.type, fileName: attachment.fileName || attachment.name });
      const extension = getAttachmentExtension(attachment, mimeType, kind);
      const sha256 = await digestBytesHex(decoded.bytes);
      const mediaPath = repository.buildMediaContentPath(sha256, extension);
      const alreadySeen = seenHashes.has(sha256) || knownHashes.has(sha256);

      if (!alreadySeen || !diffOnly) {
        if (!alreadySeen || !diffOnly) {
          if (!alreadySeen) {
            writeData(mediaPath, new Blob([decoded.bytes], { type: mimeType || defaultMimeTypeForKind(kind) }));
          }
        }
      }

      seenHashes.add(sha256);
      knownHashes.add(sha256);

      const mediaRecord = {
        mediaId: `sha256:${sha256}`,
        path: mediaPath,
        kind: kind === 'asset' ? 'file' : kind,
        status: alreadySeen ? 'deduped' : 'materialized',
        sha256,
        bytes: decoded.bytes.byteLength,
        mimeType: mimeType || defaultMimeTypeForKind(kind),
        source: 'message.attachments',
        sourceRecordId: attachment?.id || `${sourceMessage.id || 'message'}-attachment-${index + 1}`,
        fileName: attachment.fileName || attachment.name || null,
        messageId: sourceMessage.id,
        conversationId: sourceMessage.conversationId || target.artifact.id
      };

      target.message.media.push(mediaRecord);
      const targetAttachment = target.message.attachments[index];
      if (targetAttachment) {
        targetAttachment.materialized = true;
        targetAttachment.mediaId = mediaRecord.mediaId;
        targetAttachment.path = mediaRecord.path;
        targetAttachment.sha256 = sha256;
        targetAttachment.bytes = decoded.bytes.byteLength;
        targetAttachment.mimeType = mediaRecord.mimeType;
      }

      materialized.push(mediaRecord);
    }

    target.artifact.json.mediaCount = target.artifact.json.messages.reduce((total, message) => total + message.media.length, 0);
    target.artifact.markdown = buildRepositoryConversationMarkdown(target.artifact.json);
  }

  return materialized;
}

async function materializeRepositoryGalleryMediaForPackage({ archive, fullData, tab, conversationArtifacts, writeData, knownHashes = new Set(), diffOnly = false }) {
  const repository = getArchiveRepositoryUtilities();
  const galleryBundle = buildMediaGalleryItems(fullData || {});
  const galleryItems = Array.isArray(galleryBundle?.items) ? galleryBundle.items : [];
  const messageTargets = buildRepositoryMessageTargetMap(conversationArtifacts);
  const materialized = [];

  for (const item of galleryItems) {
    if (!item.exportable && !item.sourceUrl && !item.inline) {
      continue;
    }

    let blob = null;
    try {
      blob = await buildMediaBlobFromItem(item, fullData || {}, tab);
    } catch (error) {
      materialized.push(buildFailedRepositoryMediaRecord(item, `Media could not be fetched: ${error.message}`));
      continue;
    }

    if (!blob) {
      materialized.push(buildFailedRepositoryMediaRecord(item, 'Venice did not expose bytes for this media item during export.'));
      continue;
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!bytes.byteLength) {
      materialized.push(buildFailedRepositoryMediaRecord(item, 'Fetched media was empty.'));
      continue;
    }

    const sha256 = await digestBytesHex(bytes);
    const mimeType = blob.type || item.mimeType || defaultMimeTypeForKind(item.kind);
    const extension = extensionForMimeType(mimeType, item.kind);
    const mediaPath = repository.buildMediaContentPath(sha256, extension);
    const alreadyExists = knownHashes.has(sha256);

    if (!alreadyExists || !diffOnly) {
      if (!alreadyExists) {
        writeData(mediaPath, new Blob([bytes], { type: mimeType }));
      }
    }
    knownHashes.add(sha256);

    const mediaRecord = {
      mediaId: `sha256:${sha256}`,
      path: mediaPath,
      kind: item.kind || 'file',
      status: alreadyExists ? 'deduped' : 'materialized',
      sha256,
      bytes: bytes.byteLength,
      mimeType,
      source: item.source || 'media-gallery',
      sourceRecordId: item.id || null,
      sourceStore: item.sourceStore || null,
      fileName: item.displayTitle || item.fileName || null,
      messageId: item.messageId || null,
      conversationId: item.conversationId || null,
      originalUrl: item.sourceUrl || null
    };

    const target = item.messageId ? messageTargets.get(item.messageId) : null;
    if (target && !target.message.media.some((media) => media.mediaId === mediaRecord.mediaId && media.source === mediaRecord.source)) {
      target.message.media.push(mediaRecord);
    }

    materialized.push(mediaRecord);
  }

  return materialized;
}

async function writeArchiveRepository(rootHandle, archive, fileIntegrity, { tab = null, fullData = null } = {}) {
  const repository = getArchiveRepositoryUtilities();
  const exportId = `export-${archive.exportedAt.replace(/[:.]/g, '-').slice(0, 19)}`;
  const finishedAt = new Date().toISOString();
  const previousManifest = await readRepositoryRootManifest(rootHandle);

  setProgress(62, 'Preparing archive repository directories...');
  await ensureArchiveRepositoryDirectories(rootHandle);

  let filesWritten = 0;
  let bytesWritten = 0;
  let filesSkipped = 0;
  const writeData = async (relativePath, data, byteLength = null, options = {}) => {
    if (options.skipIfUnchanged && typeof data === 'string') {
      const existing = await readTextFileFromDirectory(rootHandle, relativePath);
      if (existing === data) {
        filesSkipped += 1;
        return false;
      }
    }

    await writeFileToDirectory(rootHandle, relativePath, data);
    filesWritten += 1;
    bytesWritten += byteLength ?? (typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.size || data.byteLength || 0);
    return true;
  };

  const sourceStoreArtifacts = buildRepositorySourceStoreArtifacts(archive);
  const sourceStoreWriteStats = {
    sourceStoresWritten: 0,
    sourceStoresUnchanged: 0
  };
  setProgress(64, 'Writing lossless Venice source stores...');
  for (const artifact of sourceStoreArtifacts) {
    const previous = previousManifest?.records?.sourceStores?.[artifact.name];
    const unchanged = Boolean(
      previous?.sha256 &&
      previous.sha256 === artifact.sha256 &&
      await repositoryFileExists(rootHandle, artifact.path)
    );
    if (unchanged) {
      filesSkipped += 1;
      sourceStoreWriteStats.sourceStoresUnchanged += 1;
      continue;
    }
    await writeData(artifact.path, artifact.blob, artifact.payloadBytes);
    await assertRepositoryFileSize(rootHandle, artifact.path, artifact.payloadBytes);
    sourceStoreWriteStats.sourceStoresWritten += 1;
  }

  const conversationArtifacts = buildRepositoryConversationArtifacts(archive, { previousManifest });
  setProgress(66, 'Materializing embedded attachments...');
  const embeddedMedia = await materializeRepositoryEmbeddedAttachments({
    rootHandle,
    archive,
    conversationArtifacts,
    writeData
  });
  setProgress(68, 'Materializing fetchable Venice media...');
  const galleryMedia = await materializeRepositoryGalleryMedia({
    rootHandle,
    archive,
    fullData: fullData || archive.data || {},
    tab,
    conversationArtifacts,
    writeData,
    knownHashes: new Set(embeddedMedia.map((item) => item.sha256).filter(Boolean))
  });
  setProgress(69, 'Materializing Venice OPFS media...');
  const opfsMedia = await materializeRepositoryOpfsMedia({
    tab,
    conversationArtifacts,
    knownHashes: new Set([...embeddedMedia, ...galleryMedia].map((item) => item.sha256).filter(Boolean)),
    mediaExists: (path) => repositoryFileExists(rootHandle, path),
    writeMedia: async (path, blob, bytes) => {
      await writeData(path, blob, bytes);
      await assertRepositoryFileSize(rootHandle, path, bytes);
    }
  });
  setProgress(69, 'Materializing live-captured media (videos)...');
  const capturedMedia = await materializeRepositoryCapturedMedia({
    rootHandle,
    tab,
    conversationArtifacts,
    writeData,
    knownHashes: new Set([...embeddedMedia, ...galleryMedia, ...opfsMedia].map((item) => item.sha256).filter(Boolean))
  });
  const materializedMedia = [...embeddedMedia, ...galleryMedia, ...opfsMedia, ...capturedMedia];
  refreshRepositoryConversationArtifacts(conversationArtifacts);
  await annotateRepositoryFingerprints(conversationArtifacts);
  const indexes = buildRepositoryIndexes(archive, conversationArtifacts, materializedMedia);
  const supplementalRecords = await buildRepositorySupplementalRecords(archive, indexes);
  const writePlan = buildRepositoryWritePlan({
    conversationArtifacts,
    indexes,
    materializedMedia: indexes.materializedMedia,
    previousManifest
  });
  log(`Repository write plan: ${formatNumber(writePlan.conversationsAdded)} added, ${formatNumber(writePlan.conversationsChanged)} changed, ${formatNumber(writePlan.conversationsSkipped)} skipped, ${formatNumber(writePlan.conversationsTombstoned)} tombstoned, ${formatNumber(writePlan.unresolvedMedia)} unresolved media, ${formatNumber(writePlan.failedMedia)} failed media.`, writePlan.failedMedia ? 'warning' : 'info');
  const writeStats = {
    conversationsWritten: 0,
    conversationsUnchanged: 0,
    filesSkipped: 0
  };

  setProgress(72, 'Writing conversation files...');
  for (const artifact of conversationArtifacts) {
    const jsonChanged = await writeData(artifact.paths.json, `${JSON.stringify(artifact.json, null, 2)}\n`, null, { skipIfUnchanged: true });
    const markdownChanged = await writeData(artifact.paths.markdown, artifact.markdown, null, { skipIfUnchanged: true });
    if (jsonChanged || markdownChanged) {
      writeStats.conversationsWritten += 1;
    } else {
      writeStats.conversationsUnchanged += 1;
    }
  }
  writeStats.filesSkipped = filesSkipped;

  const exportManifest = buildRepositoryExportManifest({
    archive,
    exportId,
    finishedAt,
    fileIntegrity,
    conversationArtifacts,
    indexes,
    supplementalRecords,
    sourceStoreArtifacts,
    writePlan,
    previousManifest,
    writeStats: { ...writeStats, ...sourceStoreWriteStats }
  });
  const rootManifest = buildRepositoryRootManifest({
    archive,
    exportId,
    finishedAt,
    conversationArtifacts,
    indexes,
    supplementalRecords,
    sourceStoreArtifacts,
    previousManifest,
    exportManifest
  });

  setProgress(78, 'Writing repository indexes...');
  await writeData(repository.INDEX_FILES.conversations, buildArrayJsonBlob(indexes.conversations));
  await writeData(repository.INDEX_FILES.messages, indexes.messagesJsonl);
  await writeData(repository.INDEX_FILES.media, buildRepositoryMediaIndexBlob(indexes.media));
  await writeData(repository.INDEX_FILES.unresolvedMedia, buildArrayJsonBlob(indexes.unresolvedMedia));

  setProgress(84, 'Writing local viewer...');
  await writeData('viewer/index.html', buildRepositoryViewerHtml({ rootManifest, exportManifest, indexes }));
  await writeData('viewer/viewer-data.json', buildRepositoryViewerDataBlob(indexes.viewerData));

  setProgress(89, 'Writing export manifest...');
  await writeData(`exports/${exportId}.manifest.json`, `${JSON.stringify(exportManifest, null, 2)}\n`);
  await writeData(`logs/${exportId}.log.json`, `${JSON.stringify({ exportId, finishedAt, warnings: exportManifest.warnings }, null, 2)}\n`);

  setProgress(92, 'Committing root manifest...');
  await writeData(repository.ROOT_MANIFEST_FILE, `${JSON.stringify(rootManifest, null, 2)}\n`);

  return {
    exportId,
    rootManifestPath: repository.ROOT_MANIFEST_FILE,
    viewerPath: 'viewer/index.html',
    conversationCount: conversationArtifacts.length,
    messageCount: indexes.messageCount,
    mediaFilesWritten: materializedMedia.filter((item) => item.status === 'materialized').length,
    unresolvedMedia: indexes.unresolvedMedia.length,
    manifestStatus: rootManifest.verification.status,
    conversationsWritten: writeStats.conversationsWritten,
    conversationsUnchanged: writeStats.conversationsUnchanged,
    filesSkipped,
    sourceStoresWritten: sourceStoreWriteStats.sourceStoresWritten,
    sourceStoresUnchanged: sourceStoreWriteStats.sourceStoresUnchanged,
    filesWritten,
    bytesWritten
  };
}

function getArchiveRepositoryUtilities() {
  const repository = globalThis.VeniceArchiveRepository;
  if (!repository) {
    throw new Error('Archive repository utilities did not load. Reload the extension and try again.');
  }

  return repository;
}

async function ensureArchiveRepositoryDirectories(rootHandle) {
  const repository = getArchiveRepositoryUtilities();
  for (const directoryName of Object.values(repository.REPOSITORY_DIRECTORIES)) {
    await rootHandle.getDirectoryHandle(directoryName, { create: true });
  }

  const mediaDirectory = await rootHandle.getDirectoryHandle(repository.REPOSITORY_DIRECTORIES.media, { create: true });
  await mediaDirectory.getDirectoryHandle('sha256', { create: true });
}

async function readRepositoryRootManifest(rootHandle) {
  const repository = getArchiveRepositoryUtilities();
  try {
    const fileHandle = await rootHandle.getFileHandle(repository.ROOT_MANIFEST_FILE, { create: false });
    const file = await fileHandle.getFile();
    const manifest = JSON.parse(await file.text());
    const compatibility = repository.getRootManifestCompatibility(manifest);
    if (!compatibility.ok) {
      throw new Error(`Existing archive manifest is not compatible (${compatibility.status}): ${compatibility.errors.join(' ')}`);
    }
    return manifest;
  } catch (error) {
    if (error?.name === 'NotFoundError') {
      return null;
    }
    throw error;
  }
}

async function writeFileToDirectory(rootHandle, relativePath, data) {
  const segments = relativePath.split('/').filter(Boolean);
  if (!segments.length) {
    throw new Error('Cannot write an empty repository path.');
  }

  const fileName = segments.pop();
  let directoryHandle = rootHandle;
  for (const segment of segments) {
    directoryHandle = await directoryHandle.getDirectoryHandle(segment, { create: true });
  }

  const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(data);
  } finally {
    await writable.close();
  }
}

async function repositoryFileExists(rootHandle, relativePath) {
  const segments = relativePath.split('/').filter(Boolean);
  const fileName = segments.pop();
  let directoryHandle = rootHandle;

  try {
    for (const segment of segments) {
      directoryHandle = await directoryHandle.getDirectoryHandle(segment, { create: false });
    }
    await directoryHandle.getFileHandle(fileName, { create: false });
    return true;
  } catch (error) {
    if (error?.name === 'NotFoundError') {
      return false;
    }
    throw error;
  }
}

async function readTextFileFromDirectory(rootHandle, relativePath) {
  const segments = relativePath.split('/').filter(Boolean);
  const fileName = segments.pop();
  let directoryHandle = rootHandle;

  try {
    for (const segment of segments) {
      directoryHandle = await directoryHandle.getDirectoryHandle(segment, { create: false });
    }
    const fileHandle = await directoryHandle.getFileHandle(fileName, { create: false });
    const file = await fileHandle.getFile();
    return await file.text();
  } catch (error) {
    if (error?.name === 'NotFoundError') {
      return null;
    }
    throw error;
  }
}

async function assertRepositoryFileSize(rootHandle, relativePath, expectedBytes) {
  const segments = relativePath.split('/').filter(Boolean);
  const fileName = segments.pop();
  let directoryHandle = rootHandle;

  for (const segment of segments) {
    directoryHandle = await directoryHandle.getDirectoryHandle(segment, { create: false });
  }

  const fileHandle = await directoryHandle.getFileHandle(fileName, { create: false });
  const file = await fileHandle.getFile();
  if (file.size !== expectedBytes) {
    throw new Error(`Repository media verification failed for ${relativePath}: expected ${expectedBytes} bytes, wrote ${file.size} bytes.`);
  }
}

async function materializeRepositoryEmbeddedAttachments({ rootHandle, archive, conversationArtifacts, writeData }) {
  const repository = getArchiveRepositoryUtilities();
  const messages = Array.isArray(archive.data?.messages) ? archive.data.messages : [];
  const messageRecords = new Map();
  conversationArtifacts.forEach((artifact) => {
    artifact.json.messages.forEach((message) => {
      if (message.id) {
        messageRecords.set(message.id, { artifact, message });
      }
    });
  });

  const materialized = [];
  const seenHashes = new Set();

  for (const sourceMessage of messages) {
    if (!Array.isArray(sourceMessage?.attachments) || !messageRecords.has(sourceMessage.id)) {
      continue;
    }

    const target = messageRecords.get(sourceMessage.id);
    for (let index = 0; index < sourceMessage.attachments.length; index++) {
      const attachment = sourceMessage.attachments[index];
      const attachmentPayload = getAttachmentPayloadValue(attachment);
      if (!attachmentPayload) {
        continue;
      }

      let decoded;
      try {
        decoded = decodeAttachmentPayload(attachmentPayload, attachment);
      } catch (error) {
        materialized.push({
          mediaId: `${sourceMessage.id || 'message'}-attachment-${index + 1}`,
          kind: 'file',
          status: 'failed',
          source: 'message.attachments',
          sourceRecordId: attachment?.id || `${sourceMessage.id || 'message'}-attachment-${index + 1}`,
          fileName: attachment.fileName || attachment.name || null,
          messageId: sourceMessage.id,
          conversationId: sourceMessage.conversationId || target.artifact.id,
          reason: `Attachment payload could not be decoded: ${error.message}`
        });
        continue;
      }
      if (!decoded.bytes.byteLength) {
        continue;
      }

      const mimeType = getAttachmentMimeType(attachment, decoded.mimeType);
      const kind = classifyMediaKind({ mimeType, type: attachment.type, fileName: attachment.fileName || attachment.name });
      const extension = getAttachmentExtension(attachment, mimeType, kind);
      const sha256 = await digestBytesHex(decoded.bytes);
      const mediaPath = repository.buildMediaContentPath(sha256, extension);
      const alreadySeen = seenHashes.has(sha256);
      const alreadyExists = alreadySeen || await repositoryFileExists(rootHandle, mediaPath);

      if (!alreadyExists) {
        await writeData(mediaPath, new Blob([decoded.bytes], { type: mimeType || defaultMimeTypeForKind(kind) }), decoded.bytes.byteLength);
        await assertRepositoryFileSize(rootHandle, mediaPath, decoded.bytes.byteLength);
      }
      seenHashes.add(sha256);

      const mediaRecord = {
        mediaId: `sha256:${sha256}`,
        path: mediaPath,
        kind: kind === 'asset' ? 'file' : kind,
        status: alreadyExists ? 'deduped' : 'materialized',
        sha256,
        bytes: decoded.bytes.byteLength,
        mimeType: mimeType || defaultMimeTypeForKind(kind),
        source: 'message.attachments',
        sourceRecordId: attachment?.id || `${sourceMessage.id || 'message'}-attachment-${index + 1}`,
        fileName: attachment.fileName || attachment.name || null,
        messageId: sourceMessage.id,
        conversationId: sourceMessage.conversationId || target.artifact.id
      };

      target.message.media.push(mediaRecord);
      const targetAttachment = target.message.attachments[index];
      if (targetAttachment) {
        targetAttachment.materialized = true;
        targetAttachment.mediaId = mediaRecord.mediaId;
        targetAttachment.path = mediaRecord.path;
        targetAttachment.sha256 = sha256;
        targetAttachment.bytes = decoded.bytes.byteLength;
        targetAttachment.mimeType = mediaRecord.mimeType;
      }

      materialized.push(mediaRecord);
    }

    target.artifact.json.mediaCount = target.artifact.json.messages.reduce((total, message) => total + message.media.length, 0);
    target.artifact.markdown = buildRepositoryConversationMarkdown(target.artifact.json);
  }

  return materialized;
}

async function materializeRepositoryGalleryMedia({ rootHandle, fullData, tab, conversationArtifacts, writeData, knownHashes = new Set() }) {
  const repository = getArchiveRepositoryUtilities();
  const galleryItems = buildMediaGalleryItems(fullData || {});
  const messageTargets = buildRepositoryMessageTargetMap(conversationArtifacts);
  const materialized = [];

  for (const item of galleryItems) {
    if (!item.exportable && !item.sourceUrl && !item.inline) {
      continue;
    }

    let blob = null;
    try {
      blob = await buildMediaBlobFromItem(item, fullData || {}, tab);
    } catch (error) {
      materialized.push(buildFailedRepositoryMediaRecord(item, `Media could not be fetched: ${error.message}`));
      continue;
    }

    if (!blob) {
      materialized.push(buildFailedRepositoryMediaRecord(item, 'Venice did not expose bytes for this media item during export.'));
      continue;
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!bytes.byteLength) {
      materialized.push(buildFailedRepositoryMediaRecord(item, 'Fetched media was empty.'));
      continue;
    }

    const sha256 = await digestBytesHex(bytes);
    const mimeType = blob.type || item.mimeType || defaultMimeTypeForKind(item.kind);
    const extension = extensionForMimeType(mimeType, item.kind);
    const mediaPath = repository.buildMediaContentPath(sha256, extension);
    const alreadyExists = knownHashes.has(sha256) || await repositoryFileExists(rootHandle, mediaPath);

    if (!alreadyExists) {
      await writeData(mediaPath, new Blob([bytes], { type: mimeType }), bytes.byteLength);
      await assertRepositoryFileSize(rootHandle, mediaPath, bytes.byteLength);
    }
    knownHashes.add(sha256);

    const mediaRecord = {
      mediaId: `sha256:${sha256}`,
      path: mediaPath,
      kind: item.kind || 'file',
      status: alreadyExists ? 'deduped' : 'materialized',
      sha256,
      bytes: bytes.byteLength,
      mimeType,
      source: item.source || 'media-gallery',
      sourceRecordId: item.id || null,
      sourceStore: item.sourceStore || null,
      fileName: item.displayTitle || item.fileName || null,
      messageId: item.messageId || null,
      conversationId: item.conversationId || null,
      originalUrl: item.sourceUrl || null
    };

    const target = item.messageId ? messageTargets.get(item.messageId) : null;
    if (target && !target.message.media.some((media) => media.mediaId === mediaRecord.mediaId && media.source === mediaRecord.source)) {
      target.message.media.push(mediaRecord);
    }

    materialized.push(mediaRecord);
  }

  return materialized;
}

function parseConversationIdFromCapturePath(pagePath) {
  if (!pagePath || typeof pagePath !== 'string') {
    return null;
  }
  const match = pagePath.match(/\/(?:chat|agent|mind|video[-/]?studio|image)\/(?:[a-z-]+\/)?([0-9a-f]{6,}[0-9a-f-]*)/i);
  return match ? match[1] : null;
}

function parseOpfsMediaContext(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  const fileName = parts[parts.length - 1] || null;
  const recordId = fileName ? fileName.replace(/\.[^.]+$/, '') : null;
  if (parts[0] === 'media' && parts.length >= 3) {
    return {
      conversationId: parts[1] || null,
      recordId,
      attachment: parts[2] === 'attachments',
      fileName
    };
  }
  return { conversationId: null, recordId, attachment: false, fileName };
}

async function fetchOpfsMediaBlob(item, tab) {
  const chunks = [];
  let offset = 0;
  let mimeType = item?.mimeType || defaultMimeTypeForKind(item?.kind);
  while (true) {
    const response = await requestOpfsMediaChunk(tab, {
      path: item?.path,
      offset,
      chunkSize: MEDIA_FETCH_CHUNK_BYTES
    });
    mimeType = response.mimeType || mimeType;
    if (response.chunkBase64) {
      const bytes = decodeBase64ToUint8Array(response.chunkBase64);
      if (bytes.length) {
        chunks.push(bytes);
      }
      offset = response.nextOffset || (offset + bytes.length);
    }
    if (response.done) {
      break;
    }
    if (!response.chunkBase64) {
      throw new Error('OPFS media returned an empty chunk before completion.');
    }
  }
  return new Blob(chunks, { type: mimeType || defaultMimeTypeForKind(item?.kind) });
}

async function materializeRepositoryOpfsMedia({ tab, conversationArtifacts, knownHashes = new Set(), mediaExists, writeMedia }) {
  if (!tab) {
    return [];
  }
  let indexResponse;
  try {
    indexResponse = await requestOpfsMediaIndex(tab);
  } catch (error) {
    return [{
      mediaId: 'opfs-index',
      kind: 'file',
      status: 'failed',
      source: 'opfs',
      sourceStore: 'opfs',
      reason: `Venice OPFS media index could not be read: ${error.message}`
    }];
  }
  if (!indexResponse.available) {
    return [{
      mediaId: 'opfs-unavailable',
      kind: 'file',
      status: 'unresolved',
      source: 'opfs',
      sourceStore: 'opfs',
      reason: indexResponse.reason || 'Origin Private File System is unavailable.'
    }];
  }

  const repository = getArchiveRepositoryUtilities();
  const items = Array.isArray(indexResponse.items) ? indexResponse.items : [];
  if (items.length) {
    log(`Venice OPFS media inventory: ${formatNumber(items.length)} file${items.length === 1 ? '' : 's'} will be verified and archived.`, 'info');
  }
  const materialized = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item?.path) {
      continue;
    }
    setProgress(69, `Materializing Venice OPFS media (${formatNumber(index + 1)}/${formatNumber(items.length)})...`);
    const context = parseOpfsMediaContext(item.path);
    let blob;
    try {
      blob = await fetchOpfsMediaBlob(item, tab);
    } catch (error) {
      materialized.push({
        mediaId: `opfs:${item.path}`,
        kind: item.kind || 'file',
        status: 'failed',
        source: 'opfs',
        sourceStore: 'opfs',
        sourceRecordId: item.path,
        conversationId: context.conversationId,
        fileName: context.fileName,
        originalPath: item.path,
        bytes: item.size || 0,
        mimeType: item.mimeType || null,
        reason: `OPFS media could not be read: ${error.message}`
      });
      continue;
    }
    if (!blob?.size) {
      materialized.push({
        mediaId: `opfs:${item.path}`,
        kind: item.kind || 'file',
        status: 'failed',
        source: 'opfs',
        sourceStore: 'opfs',
        sourceRecordId: item.path,
        conversationId: context.conversationId,
        fileName: context.fileName,
        originalPath: item.path,
        reason: 'OPFS media file was empty.'
      });
      continue;
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const sha256 = await digestBytesHex(bytes);
    const mimeType = blob.type || item.mimeType || defaultMimeTypeForKind(item.kind);
    const kind = item.kind && item.kind !== 'asset' ? item.kind : classifyMediaKind({ mimeType, url: item.path });
    const extension = extensionForMimeType(mimeType, kind);
    const mediaPath = repository.buildMediaContentPath(sha256, extension);
    const alreadyExists = knownHashes.has(sha256) || await mediaExists(mediaPath);
    if (!alreadyExists) {
      await writeMedia(mediaPath, new Blob([bytes], { type: mimeType }), bytes.byteLength);
    }
    knownHashes.add(sha256);

    const mediaRecord = {
      mediaId: `sha256:${sha256}`,
      path: mediaPath,
      kind: kind === 'asset' ? 'file' : kind,
      status: alreadyExists ? 'deduped' : 'materialized',
      sha256,
      bytes: bytes.byteLength,
      mimeType,
      source: 'opfs',
      sourceStore: 'opfs',
      sourceRecordId: context.recordId || item.path,
      fileName: context.fileName,
      messageId: null,
      conversationId: context.conversationId,
      originalPath: item.path,
      lastModified: item.lastModified || null,
      attachment: context.attachment
    };
    attachOpfsMediaToConversation(mediaRecord, conversationArtifacts);
    materialized.push(mediaRecord);
  }
  return materialized;
}

async function fetchCapturedMediaBlob(item, tab) {
  const chunks = [];
  let offset = 0;
  let mimeType = item.mimeType || defaultMimeTypeForKind(item.kind);

  while (true) {
    const response = await requestCapturedMediaChunk(tab, {
      hash: item.hash,
      offset,
      chunkSize: MEDIA_FETCH_CHUNK_BYTES
    });

    mimeType = response.mimeType || mimeType;

    if (response.chunkBase64) {
      const bytes = decodeBase64ToUint8Array(response.chunkBase64);
      if (bytes.length) {
        chunks.push(bytes);
      }
      offset = response.nextOffset || (offset + bytes.length);
    }

    if (response.done) {
      break;
    }

    if (!response.chunkBase64) {
      throw new Error('Captured media returned an empty chunk before completion');
    }
  }

  return new Blob(chunks, { type: mimeType || defaultMimeTypeForKind(item.kind) });
}

function attachCapturedMediaToConversation(mediaRecord, conversationArtifacts) {
  if (!mediaRecord?.conversationId) {
    return;
  }
  const artifact = conversationArtifacts.find((candidate) => String(candidate?.id || '') === String(mediaRecord.conversationId));
  const messages = Array.isArray(artifact?.json?.messages) ? artifact.json.messages : null;
  if (!messages?.length) {
    return;
  }
  const lastMessage = messages[messages.length - 1];
  if (Array.isArray(lastMessage.media) && !lastMessage.media.some((media) => media.mediaId === mediaRecord.mediaId)) {
    lastMessage.media.push(mediaRecord);
  }
}

function attachOpfsMediaToConversation(mediaRecord, conversationArtifacts) {
  if (!mediaRecord?.conversationId) {
    return;
  }
  const artifact = conversationArtifacts.find((candidate) => String(candidate?.id || '') === String(mediaRecord.conversationId));
  const messages = Array.isArray(artifact?.json?.messages) ? artifact.json.messages : null;
  if (!messages?.length) {
    return;
  }

  for (const message of messages) {
    const media = Array.isArray(message.media) ? message.media : [];
    const matchIndex = media.findIndex((candidate) =>
      candidate?.sourceRecordId && candidate.sourceRecordId === mediaRecord.sourceRecordId
    );
    if (matchIndex >= 0) {
      mediaRecord.messageId = message.id || null;
      media.splice(matchIndex, 1, mediaRecord);
      return;
    }
  }

  attachCapturedMediaToConversation(mediaRecord, conversationArtifacts);
}

async function materializeRepositoryCapturedMediaForPackage({ tab, conversationArtifacts, writeData, knownHashes = new Set(), diffOnly = false }) {
  if (!tab) {
    return [];
  }

  const repository = getArchiveRepositoryUtilities();
  let indexResponse;
  try {
    indexResponse = await requestCapturedMediaIndex(tab);
  } catch (error) {
    return [{
      mediaId: 'live-capture-index',
      kind: 'file',
      status: 'failed',
      source: 'live-capture',
      sourceStore: 'capturedMedia',
      reason: `Live-captured media index could not be read: ${error.message}`
    }];
  }

  const items = Array.isArray(indexResponse.items) ? indexResponse.items : [];
  const materialized = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item?.hash) {
      continue;
    }
    const conversationId = parseConversationIdFromCapturePath(item.pagePath) || null;
    if (item.status === 'unresolved') {
      materialized.push({
        mediaId: item.hash,
        kind: item.kind || 'file',
        status: 'unresolved',
        source: 'live-capture',
        sourceStore: 'capturedMedia',
        conversationId,
        originalUrl: item.blobUrl || null,
        bytes: item.size || 0,
        mimeType: item.mimeType || null,
        capturedAt: item.capturedAt || null,
        reason: item.reason || 'The live media Blob was observed but its bytes could not be retained.'
      });
      continue;
    }

    let blob;
    try {
      blob = await fetchCapturedMediaBlob(item, tab);
    } catch (error) {
      materialized.push({
        mediaId: item.hash,
        kind: item.kind || 'file',
        status: 'failed',
        source: 'live-capture',
        sourceStore: 'capturedMedia',
        conversationId,
        originalUrl: item.blobUrl || null,
        reason: `Captured media could not be read: ${error.message}`
      });
      continue;
    }
    if (!blob?.size) {
      materialized.push({
        mediaId: item.hash,
        kind: item.kind || 'file',
        status: 'failed',
        source: 'live-capture',
        sourceStore: 'capturedMedia',
        conversationId,
        reason: 'Captured media was empty.'
      });
      continue;
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const sha256 = await digestBytesHex(bytes);
    const mimeType = blob.type || item.mimeType || defaultMimeTypeForKind(item.kind);
    const extension = extensionForMimeType(mimeType, item.kind);
    const mediaPath = repository.buildMediaContentPath(sha256, extension);
    const alreadyExists = knownHashes.has(sha256);
    if (!alreadyExists) {
      writeData(mediaPath, new Blob([bytes], { type: mimeType }));
    }
    knownHashes.add(sha256);

    const mediaRecord = {
      mediaId: `sha256:${sha256}`,
      path: mediaPath,
      kind: item.kind || 'file',
      status: alreadyExists ? 'deduped' : 'materialized',
      sha256,
      bytes: bytes.byteLength,
      mimeType,
      source: 'live-capture',
      sourceStore: 'capturedMedia',
      fileName: item.pageTitle || null,
      messageId: null,
      conversationId,
      originalUrl: item.blobUrl || null,
      capturedAt: item.capturedAt || null
    };
    attachCapturedMediaToConversation(mediaRecord, conversationArtifacts);
    materialized.push(mediaRecord);
  }
  return materialized;
}

// Materializes media that only ever existed as an in-memory Blob in the page
// (e.g. generated videos handed to <video> via URL.createObjectURL). These bytes
// are captured live by the MAIN-world hook into a dedicated extension-owned
// IndexedDB and are otherwise unreachable by a passive export.
async function materializeRepositoryCapturedMedia({ rootHandle, tab, conversationArtifacts, writeData, knownHashes = new Set() }) {
  if (!tab) {
    return [];
  }

  const repository = getArchiveRepositoryUtilities();
  let indexResponse;
  try {
    indexResponse = await requestCapturedMediaIndex(tab);
  } catch (error) {
    log(`Could not read live-captured media: ${error.message}`, 'warning');
    return [{
      mediaId: 'live-capture-index',
      kind: 'file',
      status: 'failed',
      source: 'live-capture',
      sourceStore: 'capturedMedia',
      reason: `Live-captured media index could not be read: ${error.message}`
    }];
  }

  const items = Array.isArray(indexResponse.items) ? indexResponse.items : [];
  if (!items.length) {
    return [];
  }

  log(`Live media capture: ${formatNumber(items.length)} blob(s) available to fold into the durable archive.`, 'info');

  const materialized = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item?.hash) {
      continue;
    }

    const conversationId = parseConversationIdFromCapturePath(item.pagePath) || null;
    if (item.status === 'unresolved') {
      materialized.push({
        mediaId: item.hash,
        kind: item.kind || 'file',
        status: 'unresolved',
        source: 'live-capture',
        sourceStore: 'capturedMedia',
        conversationId,
        originalUrl: item.blobUrl || null,
        bytes: item.size || 0,
        mimeType: item.mimeType || null,
        capturedAt: item.capturedAt || null,
        reason: item.reason || 'The live media Blob was observed but its bytes could not be retained.'
      });
      continue;
    }

    setProgress(69, `Materializing live-captured media (${formatNumber(index + 1)}/${formatNumber(items.length)})...`);

    let blob;
    try {
      blob = await fetchCapturedMediaBlob(item, tab);
    } catch (error) {
      log(`Skipping live-captured ${item.kind || 'media'} ${String(item.hash).slice(0, 12)}: ${error.message}`, 'warning');
      materialized.push({
        mediaId: item.hash,
        kind: item.kind || 'file',
        status: 'failed',
        source: 'live-capture',
        sourceStore: 'capturedMedia',
        conversationId,
        originalUrl: item.blobUrl || null,
        reason: `Captured media could not be read: ${error.message}`
      });
      continue;
    }

    if (!blob || !blob.size) {
      materialized.push({
        mediaId: item.hash,
        kind: item.kind || 'file',
        status: 'failed',
        source: 'live-capture',
        sourceStore: 'capturedMedia',
        conversationId,
        reason: 'Captured media was empty.'
      });
      continue;
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!bytes.byteLength) {
      continue;
    }

    const sha256 = await digestBytesHex(bytes);
    const mimeType = blob.type || item.mimeType || defaultMimeTypeForKind(item.kind);
    const extension = extensionForMimeType(mimeType, item.kind);
    const mediaPath = repository.buildMediaContentPath(sha256, extension);
    const alreadyExists = knownHashes.has(sha256) || await repositoryFileExists(rootHandle, mediaPath);

    if (!alreadyExists) {
      await writeData(mediaPath, new Blob([bytes], { type: mimeType }), bytes.byteLength);
      await assertRepositoryFileSize(rootHandle, mediaPath, bytes.byteLength);
    }
    knownHashes.add(sha256);

    const mediaRecord = {
      mediaId: `sha256:${sha256}`,
      path: mediaPath,
      kind: item.kind || 'file',
      status: alreadyExists ? 'deduped' : 'materialized',
      sha256,
      bytes: bytes.byteLength,
      mimeType,
      source: 'live-capture',
      sourceStore: 'capturedMedia',
      fileName: item.pageTitle || null,
      messageId: null,
      conversationId,
      originalUrl: item.blobUrl || null,
      capturedAt: item.capturedAt || null
    };

    attachCapturedMediaToConversation(mediaRecord, conversationArtifacts);

    materialized.push(mediaRecord);
  }

  return materialized;
}

function buildRepositoryMessageTargetMap(conversationArtifacts) {
  const targets = new Map();
  conversationArtifacts.forEach((artifact) => {
    artifact.json.messages.forEach((message) => {
      if (message.id) {
        targets.set(message.id, { artifact, message });
      }
    });
  });
  return targets;
}

function buildFailedRepositoryMediaRecord(item, reason) {
  return {
    mediaId: item?.id || `${item?.source || 'media'}-${item?.recordIndex ?? 'unknown'}`,
    kind: item?.kind || 'file',
    status: 'failed',
    source: item?.source || 'media-gallery',
    sourceRecordId: item?.id || null,
    sourceStore: item?.sourceStore || null,
    fileName: item?.displayTitle || item?.fileName || null,
    messageId: item?.messageId || null,
    conversationId: item?.conversationId || null,
    originalUrl: item?.sourceUrl || null,
    reason
  };
}

function refreshRepositoryConversationArtifacts(conversationArtifacts) {
  conversationArtifacts.forEach((artifact) => {
    artifact.json.mediaCount = artifact.json.messages.reduce((total, message) => total + message.media.length, 0);
    artifact.markdown = buildRepositoryConversationMarkdown(artifact.json);
  });
}

function getAttachmentPayloadValue(attachment) {
  if (typeof attachment?.result === 'string' && attachment.result.trim()) {
    return attachment.result;
  }
  const embedded = getEmbeddedBinaryPayload(attachment);
  if (!embedded?.base64) {
    return null;
  }
  return embedded.mimeType
    ? `data:${embedded.mimeType};base64,${embedded.base64}`
    : embedded.base64;
}

function getAttachmentEmbeddedPayload(attachment) {
  const value = getAttachmentPayloadValue(attachment);
  if (!value) {
    return null;
  }

  try {
    const decoded = decodeAttachmentPayload(value, attachment);
    if (!decoded?.bytes?.byteLength) {
      return null;
    }
    return {
      base64: uint8ArrayToBase64(decoded.bytes),
      mimeType: decoded.mimeType || null
    };
  } catch (_) {
    // The repository materializer records the original attachment as
    // unresolved when no byte representation can be recovered.
    return null;
  }
}

function decodeAttachmentPayload(value, attachment = null) {
  const trimmed = String(value || '').trim();

  // Full data URL: honor its declared encoding (base64 vs. plain/percent-encoded text).
  const dataUrlMatch = trimmed.match(/^data:([^;,]+)?((?:;[^,]*)*),(.*)$/is);
  if (dataUrlMatch) {
    const mimeType = dataUrlMatch[1] || null;
    const params = dataUrlMatch[2] || '';
    const payload = dataUrlMatch[3] || '';
    if (/;base64/i.test(params)) {
      return { bytes: base64ToBytesStrict(payload.replace(/\s+/g, '')), mimeType };
    }
    // Non-base64 data URL → percent-decoded UTF-8 text.
    let text = payload;
    try { text = decodeURIComponent(payload); } catch (_) { /* leave as-is */ }
    return { bytes: new TextEncoder().encode(text), mimeType };
  }

  // Text-like attachments (markdown, txt, code, json, etc.) store raw UTF-8 in `result`,
  // not base64. Encoding those with atob throws "characters outside Latin1 range".
  if (isLikelyTextAttachment(attachment, trimmed)) {
    return { bytes: new TextEncoder().encode(trimmed), mimeType: null };
  }

  // Otherwise assume base64; if it is not valid base64, fall back to raw UTF-8 text.
  const normalized = trimmed.replace(/\s+/g, '');
  try {
    return { bytes: base64ToBytesStrict(normalized), mimeType: null };
  } catch (_) {
    return { bytes: new TextEncoder().encode(trimmed), mimeType: null };
  }
}

function base64ToBytesStrict(normalized) {
  const safeBase64 = normalizeBase64Payload(normalized);
  if (!safeBase64 || safeBase64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(safeBase64)) {
    throw new Error('Attachment payload is not valid base64.');
  }
  const binary = atob(safeBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isLikelyTextAttachment(attachment, value) {
  const typeHint = `${attachment?.type || ''} ${attachment?.mimeType || attachment?.mime_type || attachment?.contentType || ''} ${attachment?.fileName || attachment?.name || ''}`.toLowerCase();
  if (/\b(text|markdown|md|txt|json|csv|html|xml|yaml|yml|code|javascript|typescript|python|source)\b/.test(typeHint)) {
    return true;
  }
  // Heuristic: contains characters outside the base64 alphabet (ignoring whitespace).
  return /[^A-Za-z0-9+/=\s]/.test(value);
}

function isTextAttachmentRepresentation(attachment) {
  const value = typeof attachment?.result === 'string' ? attachment.result.trim() : '';
  return Boolean(value && isLikelyTextAttachment(attachment, value));
}

function getAttachmentMimeType(attachment, payloadMimeType = null) {
  if (!payloadMimeType && isTextAttachmentRepresentation(attachment) && !String(attachment?.mimeType || attachment?.mime_type || attachment?.contentType || '').includes('/')) {
    return 'text/plain';
  }

  const explicit = firstNonEmptyText([
    payloadMimeType,
    attachment?.mimeType,
    attachment?.mime_type,
    attachment?.contentType,
    attachment?.mediaType
  ]);

  if (explicit && explicit.includes('/')) {
    return explicit;
  }

  const fileName = cleanOptionalText(attachment?.fileName || attachment?.name);
  if (fileName) {
    return inferMimeTypeFromUrl(fileName, classifyMediaKind({ mimeType: explicit, type: attachment?.type }));
  }

  if (cleanOptionalText(attachment?.type).toLowerCase().includes('image')) {
    return 'image/jpeg';
  }

  return explicit || 'application/octet-stream';
}

function getAttachmentExtension(attachment, mimeType, kind) {
  const fileName = cleanOptionalText(attachment?.fileName || attachment?.name);
  const extensionMatch = fileName.match(/\.([a-z0-9]{1,8})$/i);
  if (isTextAttachmentRepresentation(attachment)) {
    const textExtensions = new Set(['md', 'markdown', 'txt', 'text', 'json', 'csv', 'html', 'htm', 'xml', 'yaml', 'yml', 'js', 'ts', 'tsx', 'jsx', 'py', 'css', 'sql', 'log']);
    const originalExtension = extensionMatch?.[1]?.toLowerCase();
    return textExtensions.has(originalExtension) ? originalExtension : 'txt';
  }
  if (extensionMatch) {
    return extensionMatch[1].toLowerCase();
  }

  return extensionForMimeType(mimeType, kind);
}

function buildRepositoryConversationArtifacts(archive, { previousManifest = null } = {}) {
  const repository = getArchiveRepositoryUtilities();
  const data = archive.data || {};
  const conversations = Array.isArray(data.conversations) ? data.conversations : [];
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const messagesByConversation = new Map();

  messages.forEach((message) => {
    const conversationId = message?.conversationId || '__unknown__';
    if (!messagesByConversation.has(conversationId)) {
      messagesByConversation.set(conversationId, []);
    }
    messagesByConversation.get(conversationId).push(message);
  });

  const artifacts = conversations.map((conversation) => {
    const conversationMessages = (messagesByConversation.get(conversation.id) || [])
      .slice()
      .sort((left, right) => (left?.createdAtUnixTimestamp || 0) - (right?.createdAtUnixTimestamp || 0));
    const title = resolveConversationTitle(conversation, conversationMessages);
    const paths = repository.resolveConversationArtifactPaths(conversation.id, title, previousManifest?.records?.conversations?.[conversation.id]);
    const normalizedMessages = conversationMessages.map((message) => buildRepositoryMessageRecord(message));
    const mediaCount = normalizedMessages.reduce((total, message) => total + message.media.length, 0);
    const json = {
      schemaVersion: repository.REPOSITORY_SCHEMA_VERSION,
      id: conversation.id,
      title,
      kind: conversation.kind === 'agent' ? 'agent' : (conversation.kind === 'support' ? 'support' : 'chat'),
      agentUrl: conversation.agentUrl || null,
      createdAt: normalizeArchiveTimestamp(conversation.createdAtUnixTimestamp),
      updatedAt: normalizeArchiveTimestamp(conversation.updatedAtUnixTimestamp || conversation.createdAtUnixTimestamp),
      messageCount: normalizedMessages.length,
      mediaCount,
      source: {
        store: 'conversations',
        recordFingerprintInput: repository.buildRecordFingerprintInput(conversation)
      },
      messages: normalizedMessages
    };

    return {
      id: conversation.id,
      title,
      paths,
      json,
      markdown: buildRepositoryConversationMarkdown(json)
    };
  });

  const knownConversationIds = new Set(conversations.map((conversation) => conversation.id));
  for (const [conversationId, conversationMessages] of messagesByConversation.entries()) {
    if (conversationId === '__unknown__' || knownConversationIds.has(conversationId)) {
      continue;
    }

    const title = resolveConversationTitle(null, conversationMessages);
    const paths = repository.resolveConversationArtifactPaths(conversationId, title, previousManifest?.records?.conversations?.[conversationId]);
    const normalizedMessages = conversationMessages.map((message) => buildRepositoryMessageRecord(message));
    const json = {
      schemaVersion: repository.REPOSITORY_SCHEMA_VERSION,
      id: conversationId,
      title,
      createdAt: normalizeArchiveTimestamp(conversationMessages[0]?.createdAtUnixTimestamp),
      updatedAt: normalizeArchiveTimestamp(conversationMessages[conversationMessages.length - 1]?.updatedAtUnixTimestamp),
      messageCount: normalizedMessages.length,
      mediaCount: normalizedMessages.reduce((total, message) => total + message.media.length, 0),
      source: {
        store: 'messages',
        recordFingerprintInput: repository.buildRecordFingerprintInput({ conversationId, recovered: true })
      },
      messages: normalizedMessages
    };

    artifacts.push({
      id: conversationId,
      title,
      paths,
      json,
      markdown: buildRepositoryConversationMarkdown(json)
    });
  }

  return artifacts.sort((left, right) => String(left.title).localeCompare(String(right.title)));
}

function buildRepositoryMessageRecord(message) {
  const media = extractMessageMediaCandidates(message).map((candidate, index) => ({
    mediaId: candidate.id || `${message?.id || 'message'}-media-${index + 1}`,
    sourceRecordId: candidate.id || null,
    kind: candidate.kind || 'file',
    status: candidate.url ? 'referenced' : 'unresolved',
    originalUrl: candidate.url || null,
    source: candidate.source || 'message',
    fileName: candidate.fileName || null
  }));

  const attachments = Array.isArray(message?.attachments)
    ? message.attachments.map((attachment, index) => ({
        id: attachment?.id || `${message?.id || 'message'}-attachment-${index + 1}`,
        fileName: attachment?.fileName || attachment?.name || null,
        type: attachment?.type || null,
        materialized: false,
        hasEmbeddedResult: Boolean(getAttachmentPayloadValue(attachment))
      }))
    : [];

  return {
    id: message?.id || null,
    role: normalizeGuideRole(message?.role || message?.sender || message?.authorRole || ''),
    createdAt: normalizeArchiveTimestamp(message?.createdAtUnixTimestamp),
    updatedAt: normalizeArchiveTimestamp(message?.updatedAtUnixTimestamp || message?.createdAtUnixTimestamp),
    model: buildModelLabel(
      cleanOptionalText(message?.modelName),
      cleanOptionalText(message?.modelId),
      cleanOptionalText(message?.modelType)
    ) || null,
    text: extractMessageText(message),
    media,
    attachments,
    ...(Array.isArray(message?.agentSegments) && message.agentSegments.length
      ? { agentSegments: message.agentSegments }
      : {}),
    source: {
      store: 'messages',
      recordFingerprintInput: getArchiveRepositoryUtilities().buildRecordFingerprintInput(message || {})
    }
  };
}

async function annotateRepositoryFingerprints(conversationArtifacts) {
  const repository = getArchiveRepositoryUtilities();

  for (const artifact of conversationArtifacts) {
    if (artifact.json.source?.recordFingerprintInput) {
      artifact.json.source.recordHash = await digestHex(artifact.json.source.recordFingerprintInput);
      delete artifact.json.source.recordFingerprintInput;
    }

    for (const message of artifact.json.messages) {
      if (message.source?.recordFingerprintInput) {
        message.source.recordHash = await digestHex(message.source.recordFingerprintInput);
        delete message.source.recordFingerprintInput;
      }
    }

    artifact.recordHash = await digestHex(repository.stableStringify({
      id: artifact.json.id,
      title: artifact.json.title,
      createdAt: artifact.json.createdAt,
      updatedAt: artifact.json.updatedAt,
      messageCount: artifact.json.messageCount,
      mediaCount: artifact.json.mediaCount,
      messages: artifact.json.messages
    }));
  }
}

function buildRepositoryConversationMarkdown(conversation) {
  const lines = [
    `# ${conversation.title}`,
    '',
    `- Venice conversation id: ${conversation.id}`,
    `- Created: ${conversation.createdAt || 'unknown'}`,
    `- Updated: ${conversation.updatedAt || 'unknown'}`,
    `- Messages: ${conversation.messageCount}`,
    `- Media references: ${conversation.mediaCount}`,
    ''
  ];

  for (const message of conversation.messages) {
    lines.push(`## ${capitalizeLabel(message.role || 'message')} - ${message.createdAt || 'unknown time'}`);
    if (message.model) {
      lines.push('', `Model: ${message.model}`);
    }
    lines.push('', message.text || '_No readable text captured for this message._');

    if (message.attachments.length) {
      lines.push('', 'Attachments:');
      message.attachments.forEach((attachment) => {
        const label = attachment.fileName || attachment.id;
        lines.push(`- ${label}${attachment.hasEmbeddedResult ? ' (embedded payload captured; materialization pending)' : ''}`);
      });
    }

    if (message.media.length) {
      lines.push('', 'Media references:');
      message.media.forEach((media) => {
        lines.push(`- ${media.kind}: ${media.originalUrl || media.status}`);
      });
    }

    lines.push('');
  }

  return `${lines.join('\n').trim()}\n`;
}

function buildRepositoryIndexes(archive, conversationArtifacts, materializedMedia = []) {
  const conversations = conversationArtifacts.map((artifact) => ({
    id: artifact.id,
    title: artifact.title,
    kind: artifact.json.kind === 'agent' ? 'agent' : (artifact.json.kind === 'support' ? 'support' : 'chat'),
    agentUrl: artifact.json.agentUrl || null,
    jsonPath: artifact.paths.json,
    markdownPath: artifact.paths.markdown,
    createdAt: artifact.json.createdAt,
    updatedAt: artifact.json.updatedAt,
    messageCount: artifact.json.messageCount,
    mediaCount: artifact.json.mediaCount,
    recordHash: artifact.recordHash || null,
    preview: artifact.json.messages.map((message) => message.text).find(Boolean) || 'No preview available'
  }));

  const messageRecords = conversationArtifacts.flatMap((artifact) => artifact.json.messages.map((message) => ({
    conversationId: artifact.id,
    conversationTitle: artifact.title,
    conversationKind: artifact.json.kind === 'agent' ? 'agent' : (artifact.json.kind === 'support' ? 'support' : 'chat'),
    id: message.id,
    role: message.role,
    model: message.model || null,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    text: message.text,
    media: message.media,
    attachments: message.attachments,
    ...(Array.isArray(message.agentSegments) && message.agentSegments.length
      ? { agentSegments: message.agentSegments }
      : {})
  })));

  // Gallery discovery can see the same attachment as both a dedicated
  // message attachment and a generic media candidate. If the byte-bearing
  // record succeeded, suppress only the duplicate failed placeholder; keep
  // genuinely failed records visible for review.
  const successfulMedia = materializedMedia.filter((item) => item?.path);
  const successfulIdentityCoverage = new Set(
    successfulMedia.map((item) => String(item?.sourceRecordId || item?.id || '')).filter(Boolean)
  );
  const successfulMessageCoverage = new Set(
    successfulMedia
      .filter((item) => item?.messageId)
      .map((item) => `${item.source || ''}|${item.messageId}|${item.sourceRecordId || item.id || ''}`)
  );
  const successfulSourceMessageCoverage = new Set(
    successfulMedia
      .filter((item) => item?.messageId)
      .map((item) => `${item.source || ''}|${item.messageId}`)
  );
  const effectiveMaterializedMedia = materializedMedia.filter((item) => {
    if (item?.status !== 'failed') {
      return true;
    }
    const identity = String(item?.sourceRecordId || item?.id || '');
    const messageKey = item?.messageId
      ? `${item.source || ''}|${item.messageId}|${item.sourceRecordId || item.id || ''}`
      : '';
    const sourceMessageKey = item?.messageId
      ? `${item.source || ''}|${item.messageId}`
      : '';
    const syntheticIdentity = !item?.sourceRecordId || /^message-image-\d+$/i.test(String(item?.sourceRecordId || item?.id || ''));
    return !successfulIdentityCoverage.has(identity)
      && !successfulMessageCoverage.has(messageKey)
      && !(syntheticIdentity && successfulSourceMessageCoverage.has(sourceMessageKey));
  });

  const materializedMessageCoverage = new Set();
  const materializedRecordCoverage = new Set();
  const materializedIdentityCoverage = new Set();
  const supplementalMediaByIdentity = new Map();
  (archive.mediaIndex?.items || []).forEach((item) => {
    const identity = item?.sourceRecordId || item?.id;
    if (identity) {
      supplementalMediaByIdentity.set(String(identity), item);
    }
  });

  const enrichedMaterializedMedia = effectiveMaterializedMedia.map((item) => {
    const identity = item?.sourceRecordId || item?.id;
    if (!identity) {
      return item;
    }

    const key = String(identity);
    materializedIdentityCoverage.add(key);
    const supplemental = supplementalMediaByIdentity.get(key);
    if (!supplemental) {
      return item;
    }

    // Keep the verified bytes/path/status from the materializer while
    // retaining Studio/gallery context (prompt, model, title, and source
    // record) from the original media projection.
    return {
      ...supplemental,
      ...item,
      displayTitle: item.displayTitle || supplemental.displayTitle || null,
      promptText: item.promptText || supplemental.promptText || null,
      messageText: item.messageText || supplemental.messageText || null,
      conversationTitle: item.conversationTitle || supplemental.conversationTitle || null,
      modelLabel: item.modelLabel || supplemental.modelLabel || null,
      modelId: item.modelId || supplemental.modelId || null,
      modelName: item.modelName || supplemental.modelName || null,
      modelType: item.modelType || supplemental.modelType || null,
      generationSettings: item.generationSettings || supplemental.generationSettings || []
    };
  });

  enrichedMaterializedMedia.forEach((item) => {
    if (item && item.messageId) {
      materializedMessageCoverage.add(`${item.source || ''}|${item.messageId}|${item.sourceRecordId || item.id || ''}`);
    }
    if (item?.path && (item.sourceRecordId || item.id)) {
      materializedRecordCoverage.add(`${item.conversationId || ''}|${item.sourceRecordId || item.id}`);
    }
  });
  const supplementalIndexItems = (archive.mediaIndex?.items || []).filter((item) => {
    const hasOwnSource = item && (item.path || item.url || item.sourceUrl || item.originalUrl || item.localPath);
    if (hasOwnSource) {
      return true;
    }
    // Drop pathless inventory placeholders that a materialized record already covers
    // (otherwise the viewer renders empty/black thumbnails for already-saved media).
    const coverageKey = `${item?.source || ''}|${item?.messageId || ''}|${item?.sourceRecordId || item?.id || ''}`;
    const sourceMessageKey = `${item?.source || ''}|${item?.messageId || ''}`;
    const recordCoverageKey = `${item?.conversationId || ''}|${item?.sourceRecordId || item?.id || ''}`;
    const identity = item?.sourceRecordId || item?.id;
    const syntheticIdentity = !item?.sourceRecordId || /^message-image-\d+$/i.test(String(item?.sourceRecordId || item?.id || ''));
    return !materializedMessageCoverage.has(coverageKey)
      && !materializedRecordCoverage.has(recordCoverageKey)
      && !materializedIdentityCoverage.has(String(identity || ''))
      && !(syntheticIdentity && successfulSourceMessageCoverage.has(sourceMessageKey));
  });
  const mediaItems = [
    ...enrichedMaterializedMedia,
    ...supplementalIndexItems
  ];
  const unresolvedMedia = mediaItems.filter((item) => !item.path && !item.url && !item.sourceUrl && !item.originalUrl && !item.inline && !item.localPath);
  const archivedMediaFiles = new Set(
    mediaItems
      .filter((item) => item?.path)
      .map((item) => item.sha256 || item.path)
  ).size;

  return {
    conversations,
    messagesJsonl: buildJsonLinesBlob(messageRecords),
    media: {
      totals: {
        ...(archive.mediaIndex?.totals || {}),
        archivedFiles: archivedMediaFiles,
        opfsFiles: effectiveMaterializedMedia.filter((item) => item.source === 'opfs' && item.path).length,
        liveCapturedFiles: effectiveMaterializedMedia.filter((item) => item.source === 'live-capture' && item.path).length,
        materializedAttachments: effectiveMaterializedMedia.filter((item) => item.status === 'materialized').length,
        dedupedAttachments: effectiveMaterializedMedia.filter((item) => item.status === 'deduped').length
      },
      items: mediaItems
    },
    unresolvedMedia,
    viewerData: {
      generatedAt: new Date().toISOString(),
      conversations,
      messages: messageRecords,
      totals: archive.stats || {},
      media: {
        ...(archive.mediaIndex?.totals || {}),
        archivedFiles: archivedMediaFiles,
        opfsFiles: effectiveMaterializedMedia.filter((item) => item.source === 'opfs' && item.path).length,
        liveCapturedFiles: effectiveMaterializedMedia.filter((item) => item.source === 'live-capture' && item.path).length,
        materializedAttachments: effectiveMaterializedMedia.filter((item) => item.status === 'materialized').length,
        dedupedAttachments: effectiveMaterializedMedia.filter((item) => item.status === 'deduped').length,
        items: mediaItems
      }
    },
    messageCount: messageRecords.length,
    materializedMedia: effectiveMaterializedMedia
  };
}

function buildRepositoryWritePlan({ conversationArtifacts, indexes, materializedMedia, previousManifest }) {
  const repository = getArchiveRepositoryUtilities();
  const previousConversationRecords = previousManifest?.records?.conversations || {};
  const currentIds = conversationArtifacts.map((artifact) => artifact.id);
  let conversationsAdded = 0;
  let conversationsChanged = 0;
  let conversationsSkipped = 0;

  conversationArtifacts.forEach((artifact) => {
    const previousRecord = previousConversationRecords[artifact.id];
    if (!previousRecord) {
      conversationsAdded += 1;
      return;
    }

    if (previousRecord.recordHash && artifact.recordHash && previousRecord.recordHash === artifact.recordHash) {
      conversationsSkipped += 1;
    } else {
      conversationsChanged += 1;
    }
  });

  return {
    conversationsAdded,
    conversationsChanged,
    conversationsSkipped,
    conversationsTombstoned: repository.getTombstonedConversationIds(previousConversationRecords, currentIds).length,
    materializedMedia: materializedMedia.filter((item) => item.status === 'materialized').length,
    dedupedMedia: materializedMedia.filter((item) => item.status === 'deduped').length,
    unresolvedMedia: indexes.unresolvedMedia.length,
    failedMedia: materializedMedia.filter((item) => item.status === 'failed').length
  };
}

async function buildRepositorySupplementalRecords(archive, indexes) {
  const repository = getArchiveRepositoryUtilities();
  const data = archive.data || {};
  const records = {
    settings: {},
    studio: {},
    unresolvedMedia: {}
  };

  for (const config of SUPPLEMENTAL_ARCHIVE_RECORD_STORES) {
    const sourceRecords = Array.isArray(data[config.dataKey]) ? data[config.dataKey] : [];
    if (!sourceRecords.length) {
      continue;
    }

    if (!records[config.manifestGroup][config.dataKey]) {
      records[config.manifestGroup][config.dataKey] = {};
    }

    for (let index = 0; index < sourceRecords.length; index += 1) {
      const sourceRecord = sourceRecords[index];
      const recordId = resolveRepositoryRecordId(sourceRecord, `${config.dataKey}-${index + 1}`);
      records[config.manifestGroup][config.dataKey][recordId] = {
        recordHash: await digestHex(repository.buildRecordFingerprintInput(sourceRecord)),
        sourceStore: config.dataKey
      };
    }
  }

  for (let index = 0; index < indexes.unresolvedMedia.length; index += 1) {
    const unresolved = indexes.unresolvedMedia[index];
    const recordId = resolveRepositoryRecordId(unresolved, `unresolved-media-${index + 1}`);
    records.unresolvedMedia[recordId] = {
      recordHash: await digestHex(repository.buildRecordFingerprintInput(unresolved)),
      status: unresolved.status || 'unresolved',
      reason: unresolved.reason || null,
      source: unresolved.source || unresolved.sourceStore || null
    };
  }

  return records;
}

function resolveRepositoryRecordId(record, fallback) {
  return cleanOptionalText(
    record?.id
      || record?.mediaId
      || record?.recordId
      || record?.turnId
      || record?.sessionId
      || record?.key
      || record?.name
      || fallback
  );
}

function buildRepositoryViewerHtml({ rootManifest, exportManifest, indexes }) {
  const viewerData = {
    rootManifest,
    exportManifest,
    conversations: indexes.conversations,
    messages: indexes.viewerData.messages || [],
    media: indexes.media,
    unresolvedMedia: indexes.unresolvedMedia
  };

  // Keep the static viewer shell separate from the archive payload.  A full
  // JSON.stringify(viewerData) can exceed the browser's maximum JS string
  // length for a large history even though the resulting Blob would be valid.
  // The payload is inserted as several smaller Blob parts below.
  const viewerDataMarker = '__VENICE_VIEWER_DATA__';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Venice Local Archive</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f1ea;
      --panel: #ffffff;
      --panel-soft: #f1ece3;
      --border: #ddd5c8;
      --border-soft: #ece6db;
      --text: #221f1b;
      --muted: #71695d;
      --accent: #0f6b5c;
      --accent-strong: #0b5247;
      --accent-soft: #dff0ec;
      --danger: #9b3428;
      --shadow: 0 18px 48px rgba(49, 43, 36, 0.12);
      --shadow-sm: 0 4px 14px rgba(49, 43, 36, 0.08);
      --radius: 14px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Avenir Next", "Segoe UI", system-ui, sans-serif;
      background: radial-gradient(120% 120% at 0% 0%, #f8f5ef 0%, var(--bg) 60%);
      color: var(--text);
      -webkit-font-smoothing: antialiased;
    }
    button, input, select, textarea { font: inherit; }
    a { color: var(--accent); }
    .shell { max-width: 1500px; margin: 0 auto; padding: 26px 24px 80px; }
    .topbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 20px;
      align-items: center;
      margin-bottom: 20px;
    }
    .brand { display: flex; align-items: center; gap: 16px; }
    .brand-mark {
      width: 54px; height: 54px; flex: none;
      display: grid; place-items: center;
      border-radius: 16px;
      background: linear-gradient(160deg, var(--accent) 0%, var(--accent-strong) 100%);
      box-shadow: var(--shadow-sm);
      color: #eafaf6;
    }
    .brand-mark svg { width: 30px; height: 30px; }
    .eyebrow {
      color: var(--muted);
      font-size: 11px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      margin: 0 0 6px;
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: clamp(24px, 4vw, 34px); line-height: 1.04; letter-spacing: -0.02em; }
    .subtle { color: var(--muted); line-height: 1.55; }
    .status-card {
      background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
      box-shadow: var(--shadow-sm); padding: 12px 16px; color: var(--muted); font-size: 13px; line-height: 1.6;
    }
    .status-card strong { color: var(--text); }
    .status-pill { display: inline-flex; align-items: center; gap: 6px; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
    .health {
      display: grid;
      grid-template-columns: repeat(5, minmax(120px, 1fr));
      gap: 12px;
      margin: 0 0 18px;
    }
    .metric {
      background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
      box-shadow: var(--shadow-sm); padding: 14px 16px;
    }
    .metric span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 6px; letter-spacing: 0.02em; }
    .metric strong { font-size: 26px; letter-spacing: -0.02em; }
    .notice {
      background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
      box-shadow: var(--shadow-sm); padding: 12px 16px; color: var(--muted); line-height: 1.55; margin-bottom: 18px; font-size: 13px;
    }
    .notice strong { color: var(--text); }
    .maintenance-card {
      background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
      box-shadow: var(--shadow-sm); padding: 16px 18px; margin-bottom: 18px;
    }
    .maintenance-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
    .maintenance-head h2 { font-size: 16px; line-height: 1.25; margin-bottom: 5px; }
    .maintenance-head .subtle { font-size: 13px; max-width: 760px; }
    .maintenance-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 14px; }
    .maintenance-status { color: var(--muted); font-size: 12px; line-height: 1.45; min-height: 18px; flex: 1 1 260px; }
    .maintenance-status.error { color: var(--danger); }
    .maintenance-progress { width: 100%; height: 6px; margin-top: 12px; border-radius: 999px; background: var(--border-soft); overflow: hidden; }
    .maintenance-progress span { display: block; width: 0; height: 100%; background: var(--accent); transition: width .15s ease; }
    .maintenance-card[hidden] { display: none; }
    @media (max-width: 720px) {
      .maintenance-head { display: block; }
    }
    /* Tabs */
    .tabs { display: inline-flex; gap: 4px; padding: 5px; margin-bottom: 18px; background: var(--panel-soft); border: 1px solid var(--border); border-radius: 999px; }
    .tab {
      border: none; background: transparent; color: var(--muted); cursor: pointer;
      padding: 9px 18px; border-radius: 999px; font-weight: 600; display: inline-flex; align-items: center; gap: 8px;
      transition: background .15s, color .15s;
    }
    .tab:hover { color: var(--text); }
    .tab.active { background: var(--panel); color: var(--accent-strong); box-shadow: var(--shadow-sm); }
    .tab .count { font-size: 12px; color: var(--muted); background: var(--border-soft); border-radius: 999px; padding: 1px 8px; }
    .tab.active .count { background: var(--accent-soft); color: var(--accent-strong); }
    .tab-panel { display: block; }
    .tab-panel[hidden] { display: none; }
    /* Conversations workspace */
    .workspace { display: grid; grid-template-columns: 340px minmax(0, 1fr); gap: 18px; align-items: start; }
    .sidebar {
      position: sticky; top: 16px; align-self: start;
      border: 1px solid var(--border); background: var(--panel); border-radius: var(--radius);
      box-shadow: var(--shadow-sm); padding: 14px;
      max-height: calc(100vh - 32px); display: flex; flex-direction: column; min-height: 0;
    }
    .search-wrap, .media-search-wrap { position: relative; display: flex; align-items: center; }
    .search { width: 100%; border: 1px solid var(--border); border-radius: 10px; padding: 11px 38px 11px 12px; margin-bottom: 10px; background: var(--panel-soft); }
    .search:focus { outline: 2px solid var(--accent-soft); border-color: var(--accent); }
    .search-clear { position: absolute; right: 7px; top: 4px; width: 30px; height: 30px; border: 0; background: transparent; color: var(--muted); border-radius: 8px; cursor: pointer; }
    .search-clear:hover { background: var(--border-soft); color: var(--text); }
    .search-clear:focus-visible, .control-row select:focus-visible, .media-toolbar select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .filter-stack { display: grid; gap: 8px; margin-bottom: 10px; }
    .control-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .control-row select { width: 100%; border: 1px solid var(--border); border-radius: 10px; padding: 9px; background: #fff; color: var(--text); }
    .results-meta { color: var(--muted); font-size: 12px; line-height: 1.45; padding: 0 2px 9px; }
    .list { display: grid; gap: 8px; overflow: auto; padding-right: 4px; min-height: 0; }
    .conversation-button {
      width: 100%; text-align: left; border: 1px solid var(--border-soft); background: #fff;
      border-radius: 12px; padding: 11px 12px; cursor: pointer; transition: border-color .12s, background .12s;
    }
    .conversation-button:hover { border-color: var(--border); }
    .conversation-button.active { border-color: var(--accent); background: var(--accent-soft); }
    .conversation-title { font-weight: 700; line-height: 1.3; margin-bottom: 5px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .conversation-meta { color: var(--muted); font-size: 12px; line-height: 1.5; display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; }
    .conversation-meta .dot { width: 3px; height: 3px; border-radius: 50%; background: var(--muted); opacity: .6; }
    .conversation-meta .review-inline { color: #8a6818; background: #f7e5ae; border-radius: 999px; padding: 2px 7px; font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
    /* Conversation detail */
    .detail { min-width: 0; }
    .detail-head {
      background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
      box-shadow: var(--shadow-sm); padding: 18px 20px; margin-bottom: 16px;
    }
    .detail-head h2 { font-size: clamp(20px, 3vw, 28px); line-height: 1.12; letter-spacing: -0.02em; margin-bottom: 8px; }
    .detail-head .subtle { font-size: 14px; margin-bottom: 14px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .head-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; color: var(--muted); font-size: 13px; }
    .head-actions { display: flex; gap: 8px; margin-left: auto; }
    .btn {
      display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--border);
      background: var(--panel-soft); color: var(--text); border-radius: 10px; padding: 8px 13px;
      cursor: pointer; font-weight: 600; font-size: 13px; text-decoration: none; transition: background .12s, border-color .12s;
    }
    .btn:hover { background: #fff; border-color: var(--accent); }
    .btn svg { width: 15px; height: 15px; }
    .btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
    .btn-primary:hover { background: var(--accent-strong); color: #fff; }
    .icon-btn {
      display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: 8px;
      border: 1px solid transparent; background: transparent; color: var(--muted); cursor: pointer; transition: all .12s;
    }
    .icon-btn:hover { background: var(--panel-soft); border-color: var(--border); color: var(--accent-strong); }
    .icon-btn svg { width: 15px; height: 15px; }
    .message-stack { display: grid; gap: 14px; }
    .message {
      border: 1px solid var(--border-soft); background: var(--panel); border-radius: var(--radius);
      padding: 0; box-shadow: var(--shadow-sm); overflow: hidden;
    }
    .message.user { border-color: #cfe3dd; background: linear-gradient(180deg, #f3faf8, #effaf6); }
    .message-head {
      display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-bottom: 1px solid var(--border-soft);
    }
    .avatar {
      width: 28px; height: 28px; border-radius: 8px; flex: none; display: grid; place-items: center;
      font-size: 12px; font-weight: 700; color: #fff; background: var(--accent);
    }
    .message.user .avatar { background: #3a4a46; }
    .author { font-weight: 700; font-size: 14px; }
    .message-time { color: var(--muted); font-size: 12px; }
    .message-head .icon-btn { margin-left: auto; }
    .message-body { padding: 14px; }
    .message-text { overflow-wrap: anywhere; line-height: 1.65; }
    .message-text p { margin: 0 0 10px; }
    .message-text p:last-child { margin-bottom: 0; }
    .message-text pre {
      background: #1c211f; color: #e9f3f0; border-radius: 10px; padding: 14px 16px; overflow: auto;
      font-family: "SF Mono", "Fira Code", Menlo, monospace; font-size: 12.5px; line-height: 1.5; margin: 10px 0;
    }
    .message-text code { font-family: "SF Mono", "Fira Code", Menlo, monospace; font-size: 0.9em; }
    .message-text :not(pre) > code { background: var(--panel-soft); border: 1px solid var(--border-soft); border-radius: 5px; padding: 1px 5px; }
    .message-text a { word-break: break-all; }
    .message-text .md-h { margin: 18px 0 8px; line-height: 1.3; font-weight: 700; }
    .message-text h1.md-h { font-size: 1.45rem; }
    .message-text h2.md-h { font-size: 1.25rem; }
    .message-text h3.md-h { font-size: 1.1rem; }
    .message-text h4.md-h, .message-text h5.md-h, .message-text h6.md-h { font-size: 1rem; }
    .message-text .md-h:first-child { margin-top: 0; }
    .message-text hr { border: 0; border-top: 1px solid var(--border-soft); margin: 18px 0; }
    .message-text ul, .message-text ol { margin: 8px 0 12px; padding-left: 22px; }
    .message-text li { margin: 3px 0; }
    .message-text blockquote { margin: 10px 0; padding: 6px 14px; border-left: 3px solid var(--accent); color: var(--muted); background: var(--panel-soft); border-radius: 0 8px 8px 0; }
    /* Inline embedded media */
    .embed-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-top: 12px; }
    .embed {
      position: relative; border: 1px solid var(--border); border-radius: 12px; overflow: hidden;
      background: #11140f; aspect-ratio: 1 / 1; cursor: pointer;
    }
    .embed img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .embed .embed-icon {
      position: absolute; top: 6px; right: 6px; width: 28px; height: 28px; border-radius: 8px;
      background: rgba(12,14,12,0.62); color: #fff; display: grid; place-items: center; backdrop-filter: blur(4px);
    }
    .embed .embed-icon svg { width: 15px; height: 15px; }
    .embed.file { aspect-ratio: auto; padding: 14px; color: #e9f3f0; display: flex; align-items: center; gap: 10px; cursor: default; }
    .embed.file a { color: #bfe7dd; }
    .attach-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .attach-chip { display: inline-flex; gap: 7px; align-items: center; border: 1px solid var(--border); border-radius: 999px; padding: 6px 11px; background: var(--panel-soft); font-size: 12px; }
    a.attach-chip { color: var(--accent-strong); text-decoration: none; }
    a.attach-chip:hover { border-color: var(--accent); background: var(--accent-soft); }
    /* Media tab */
    .media-toolbar { display: grid; grid-template-columns: minmax(220px, 1fr) auto auto auto; align-items: center; gap: 10px; margin-bottom: 12px; }
    .media-search-wrap .search { margin-bottom: 0; background: var(--panel); }
    .media-toolbar select { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--panel); color: var(--text); }
    .media-filters { display: inline-flex; flex-wrap: wrap; gap: 6px; }
    .media-toolbar-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 14px; }
    .media-results-meta { color: var(--muted); font-size: 12px; }
    .chip {
      border: 1px solid var(--border); background: var(--panel); color: var(--muted); cursor: pointer;
      border-radius: 999px; padding: 8px 14px; font-weight: 600; font-size: 13px; display: inline-flex; gap: 7px; align-items: center;
    }
    .chip:hover { color: var(--text); }
    .chip.active { background: var(--accent); border-color: var(--accent); color: #fff; }
    .chip .count { font-size: 11px; opacity: .85; background: rgba(0,0,0,0.08); border-radius: 999px; padding: 1px 7px; }
    .chip.active .count { background: rgba(255,255,255,0.22); }
    .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 14px; }
    .thumb {
      position: relative; border: 1px solid var(--border); border-radius: 14px; overflow: hidden; background: #11140f;
      cursor: pointer; aspect-ratio: 1 / 1; box-shadow: var(--shadow-sm); transition: transform .12s, box-shadow .12s;
    }
    .thumb:hover { transform: translateY(-2px); box-shadow: var(--shadow); }
    .thumb img, .thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
    .thumb .ph { width: 100%; height: 100%; display: grid; place-items: center; color: #cdd6d1; }
    .thumb .ph svg { width: 38px; height: 38px; }
    .thumb .badge {
      position: absolute; left: 8px; bottom: 8px; font-size: 11px; font-weight: 700; letter-spacing: .04em;
      text-transform: uppercase; background: rgba(12,14,12,0.66); color: #fff; padding: 3px 8px; border-radius: 999px; backdrop-filter: blur(4px);
    }
    .thumb-caption { position: absolute; left: 8px; right: 8px; bottom: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #fff; background: rgba(12,14,12,0.68); border-radius: 7px; padding: 4px 7px; font-size: 11px; }
    .thumb .review-badge { position: absolute; top: 8px; left: 8px; color: #2a2110; background: #f0c86a; border-radius: 999px; padding: 3px 7px; font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
    .gallery-empty { color: var(--muted); padding: 40px; text-align: center; border: 1px dashed var(--border); border-radius: var(--radius); }
    /* Lightbox */
    .lightbox { position: fixed; inset: 0; z-index: 50; background: rgba(14,16,14,0.86); backdrop-filter: blur(6px); display: grid; grid-template-columns: minmax(0,1fr) 320px; }
    .lightbox[hidden] { display: none; }
    .lb-stage { position: relative; display: grid; place-items: center; padding: 44px 84px; min-width: 0; }
    .lb-media { display: grid; place-items: center; max-width: 100%; max-height: calc(100vh - 88px); }
    .lb-stage img, .lb-stage video { max-width: 100%; max-height: calc(100vh - 88px); object-fit: contain; border-radius: 10px; box-shadow: 0 24px 60px rgba(0,0,0,.5); }
    .lb-stage audio { width: min(560px, 90%); }
    .lb-stage .ph { color: #cdd6d1; display: grid; place-items: center; gap: 12px; }
    .lb-stage .ph svg { width: 64px; height: 64px; }
    .lb-meta { background: var(--panel); padding: 22px; overflow: auto; }
    .lb-meta h3 { font-size: 16px; margin-bottom: 4px; overflow-wrap: anywhere; }
    .lb-meta .subtle { font-size: 12px; margin-bottom: 16px; }
    .lb-actions { display: flex; gap: 8px; margin-bottom: 18px; flex-wrap: wrap; }
    .metadata-grid { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 9px 12px; font-size: 13px; line-height: 1.45; }
    .metadata-grid dt { color: var(--muted); }
    .metadata-grid dd { margin: 0; overflow-wrap: anywhere; }
    .lb-nav {
      position: absolute; top: 50%; transform: translateY(-50%); width: 46px; height: 46px; border-radius: 50%;
      border: none; background: rgba(255,255,255,0.14); color: #fff; font-size: 26px; cursor: pointer; display: grid; place-items: center;
    }
    .lb-nav:hover { background: rgba(255,255,255,0.26); }
    .lb-prev { left: 18px; }
    .lb-next { right: 18px; }
    .lb-close { position: absolute; top: 14px; left: 18px; width: 40px; height: 40px; border-radius: 50%; border: none; background: rgba(255,255,255,0.14); color: #fff; font-size: 22px; cursor: pointer; z-index: 2; }
    .lb-close:hover { background: rgba(255,255,255,0.26); }
    .lb-counter { position: absolute; top: 18px; left: 50%; transform: translateX(-50%); color: rgba(255,255,255,0.78); font-size: 13px; }
    /* Scroll to top */
    .scroll-top {
      position: fixed; right: 26px; bottom: 26px; width: 46px; height: 46px; border-radius: 50%; z-index: 40;
      border: 1px solid var(--border); background: var(--panel); color: var(--accent-strong); cursor: pointer;
      box-shadow: var(--shadow); display: grid; place-items: center; transition: opacity .2s, transform .2s;
    }
    .scroll-top[hidden] { opacity: 0; pointer-events: none; transform: translateY(8px); }
    .scroll-top svg { width: 20px; height: 20px; }
    /* Agentic transcript segments */
    .agent-detail { border: 1px solid var(--border-soft); border-radius: 10px; background: var(--panel-soft); margin: 8px 0; overflow: hidden; }
    .agent-detail > summary { cursor: pointer; padding: 8px 12px; font-weight: 600; font-size: 13px; color: var(--accent-strong); display: flex; align-items: center; gap: 8px; list-style: none; }
    .agent-detail > summary::-webkit-details-marker { display: none; }
    .agent-detail > summary .seg-icon { width: 14px; height: 14px; flex: none; }
    .agent-detail[open] > summary { border-bottom: 1px solid var(--border-soft); }
    .agent-detail .agent-detail-body { padding: 10px 12px; font-size: 13px; line-height: 1.55; overflow-wrap: anywhere; }
    .agent-detail .agent-detail-body pre { background: #1c211f; color: #e9f3f0; border-radius: 8px; padding: 10px 12px; overflow: auto; font-size: 12px; margin: 6px 0; }
    .agent-sources { list-style: none; margin: 6px 0 0; padding: 0; display: grid; gap: 4px; }
    .agent-sources a { word-break: break-all; }
    .kind-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; background: var(--accent-soft); color: var(--accent-strong); padding: 2px 9px; border-radius: 999px; }
    .kind-badge svg { width: 12px; height: 12px; }
    .conversation-title .kind-badge { vertical-align: middle; margin-left: 6px; }
    .thumb .badge svg { width: 14px; height: 14px; display: block; }
    .message-foot { display: flex; justify-content: flex-end; padding: 0 14px 12px; }
    .message-foot .btn { font-size: 12px; padding: 6px 11px; }
    /* Gallery audio + attachment cards */
    .thumb.audio-card, .thumb.file-card { aspect-ratio: auto; background: var(--panel); border: 1px solid var(--border); padding: 12px; display: flex; flex-direction: column; gap: 8px; color: var(--text); cursor: default; }
    .thumb.file-card { cursor: pointer; }
    .thumb.audio-card:hover, .thumb.file-card:hover { transform: none; box-shadow: var(--shadow-sm); }
    .file-card .file-icon { width: 30px; height: 30px; color: var(--accent-strong); }
    .file-card .file-name, .audio-card .file-name { font-weight: 600; font-size: 13px; overflow-wrap: anywhere; }
    .file-card .file-date, .audio-card .file-date { color: var(--muted); font-size: 12px; }
    .audio-card audio { width: 100%; }
    /* Lightbox meta link + copy */
    .meta-link { background: none; border: none; padding: 0; color: var(--accent); cursor: pointer; text-decoration: underline; font: inherit; text-align: left; overflow-wrap: anywhere; }
    .meta-copy { display: flex; align-items: flex-start; gap: 6px; }
    .meta-copy .icon-btn { width: 24px; height: 24px; flex: none; }
    .meta-copy .meta-copy-text { overflow-wrap: anywhere; }
    @media (max-width: 920px) {
      .topbar, .workspace { grid-template-columns: 1fr; }
      .sidebar { position: static; max-height: none; }
      .list { max-height: 420px; }
      .health { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .media-toolbar { grid-template-columns: 1fr 1fr; }
      .media-search-wrap { grid-column: 1 / -1; }
      .lightbox { grid-template-columns: 1fr; grid-template-rows: minmax(0,1fr) auto; }
      .lb-meta { max-height: 40vh; }
      .lb-stage { padding: 34px 58px; }
      .lb-media { max-height: 60vh; }
      .lb-stage img, .lb-stage video { max-height: 60vh; }
    }
    @media (max-width: 560px) {
      .shell { padding: 16px 14px 70px; }
      .health { grid-template-columns: 1fr; }
      .metadata-grid { grid-template-columns: 1fr; }
      .head-actions { width: 100%; margin-left: 0; }
      .media-toolbar { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"></rect><circle cx="12" cy="12" r="4.2"></circle><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"></circle><path d="M12 7.8v-1M12 17.2v-1M7.8 12h-1M17.2 12h-1"></path></svg>
        </div>
        <div>
          <p class="eyebrow">Venice Local Archive</p>
          <h1>Archive Vault</h1>
        </div>
      </div>
      <div class="status-card">
        <div class="status-pill"><span class="status-dot"></span><strong>${escapeHtml(rootManifest.verification?.status || 'unknown')}</strong></div>
        <div>Latest export: ${escapeHtml(rootManifest.latestExportId || 'none')}</div>
      </div>
    </header>
    <section class="health" id="health"></section>
    <section class="notice" id="warningBox"></section>
    <section class="maintenance-card" id="maintenanceCard">
      <div class="maintenance-head">
        <div>
          <h2>Keep this archive current</h2>
          <p class="subtle">Choose a later full or incremental ZIP and apply it to this archive folder. The viewer writes files directly, keeps the manifest until the end, and never sends the package anywhere.</p>
        </div>
      </div>
      <div class="maintenance-actions">
        <input id="packageFileInput" type="file" accept=".zip,application/zip" hidden>
        <button class="btn" id="selectPackageBtn" type="button">Choose package ZIP</button>
        <button class="btn btn-primary" id="applyPackageBtn" type="button" disabled>Apply to this archive</button>
        <span class="maintenance-status" id="maintenanceStatus" aria-live="polite"></span>
      </div>
      <div class="maintenance-progress" id="maintenanceProgress" role="progressbar" aria-label="Package apply progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>
    </section>
    <nav class="tabs" id="tabs" role="tablist">
      <button class="tab active" data-tab="conversations" role="tab">Conversations</button>
      <button class="tab" data-tab="media" role="tab">Media <span class="count" id="mediaTabCount">0</span></button>
    </nav>
    <section class="tab-panel" id="panel-conversations">
      <div class="workspace">
        <aside class="sidebar">
          <div class="search-wrap">
            <input class="search" id="searchInput" type="search" placeholder="Search conversations, messages, files…" aria-label="Search conversations, messages, files">
            <button class="search-clear" id="clearSearch" type="button" aria-label="Clear conversation search" hidden>&times;</button>
          </div>
          <div class="filter-stack">
            <div class="control-row">
              <select id="sortSelect" aria-label="Sort conversations">
                <option value="updated-desc">Recently updated</option>
                <option value="created-desc">Recently created</option>
                <option value="title-asc">Title A to Z</option>
                <option value="messages-desc">Most messages</option>
                <option value="media-desc">Most media</option>
              </select>
              <select id="kindFilter" aria-label="Filter by conversation type">
                <option value="all">All types</option>
                <option value="chat">Chats</option>
                <option value="agent">Mind / agents</option>
                <option value="support">Support</option>
              </select>
            </div>
            <div class="control-row">
              <select id="mediaFilter" aria-label="Filter by media">
                <option value="all">All conversations</option>
                <option value="with-media">With media</option>
                <option value="with-attachments">With attachments</option>
                <option value="without-media">Without media</option>
              </select>
              <select id="conversationStatusFilter" aria-label="Filter by archive status">
                <option value="all">Any archive status</option>
                <option value="local-media">Has local media</option>
                <option value="review">Needs media review</option>
              </select>
            </div>
          </div>
          <div class="results-meta" id="conversationResultsMeta" aria-live="polite"></div>
          <div class="list" id="conversationList"></div>
        </aside>
        <section class="detail" id="detail"></section>
      </div>
    </section>
    <section class="tab-panel" id="panel-media" hidden>
      <div class="media-toolbar">
        <div class="media-search-wrap">
          <input class="search" id="mediaSearchInput" type="search" placeholder="Search media, prompts, files…" aria-label="Search media, prompts, files">
          <button class="search-clear" id="clearMediaSearch" type="button" aria-label="Clear media search" hidden>&times;</button>
        </div>
        <select id="mediaSortSelect" aria-label="Sort media">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="name">Name A to Z</option>
          <option value="largest">Largest first</option>
        </select>
        <select id="mediaStatusFilter" aria-label="Filter media status">
          <option value="all">All media</option>
          <option value="local">Local files</option>
          <option value="reference">References</option>
          <option value="review">Needs review</option>
        </select>
        <select id="mediaSourceFilter" aria-label="Filter media source">
          <option value="all">All sources</option>
        </select>
      </div>
      <div class="media-toolbar-row">
        <div class="media-filters" id="mediaTypeFilters"></div>
        <div class="media-results-meta" id="mediaResultsMeta" aria-live="polite"></div>
      </div>
      <div class="gallery" id="mediaGrid"></div>
    </section>
  </main>
  <button class="scroll-top" id="scrollTop" type="button" aria-label="Scroll to top" hidden>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"></path></svg>
  </button>
  <div class="lightbox" id="lightbox" hidden>
    <button class="lb-close" id="lbClose" type="button" aria-label="Close">&times;</button>
    <div class="lb-stage" id="lbStage">
      <button class="lb-nav lb-prev" id="lbPrev" type="button" aria-label="Previous">&#8249;</button>
      <div class="lb-counter" id="lbCounter"></div>
      <div class="lb-media" id="lbMedia"></div>
      <button class="lb-nav lb-next" id="lbNext" type="button" aria-label="Next">&#8250;</button>
    </div>
    <aside class="lb-meta" id="lbMeta"></aside>
  </div>
  <script>
    ${viewerDataMarker}
    var BACKTICK = String.fromCharCode(96);
    var FENCE = BACKTICK + BACKTICK + BACKTICK;
    var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    var IC = {
      ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></svg>',
      dl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path></svg>',
      copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg>',
      check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>',
      file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5h5"></path><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path></svg>',
      play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"></path></svg>',
      image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-5-5L5 21"></path></svg>',
      audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>',
      reasoning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" class="seg-icon"><path d="M9.5 2A4.5 4.5 0 0 0 5 6.5c0 .9.26 1.74.7 2.45A4 4 0 0 0 6 17a3.5 3.5 0 0 0 6 1.5V4a2 2 0 0 0-2.5-2z"></path><path d="M14.5 2A4.5 4.5 0 0 1 19 6.5c0 .9-.26 1.74-.7 2.45A4 4 0 0 1 18 17a3.5 3.5 0 0 1-6 1.5"></path></svg>',
      tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" class="seg-icon"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-2.4z"></path></svg>',
      search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" class="seg-icon"><circle cx="11" cy="11" r="7"></circle><path d="m21 21-4.3-4.3"></path></svg>',
      link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"></path><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"></path></svg>'
    };
    const numberFormat = new Intl.NumberFormat();
    function escapeHtmlClient(value) {
      return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function formatNumber(value) { return numberFormat.format(Number(value || 0)); }
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function parseDate(value) { if (!value) return null; var d = new Date(value); return isNaN(d.getTime()) ? null : d; }
    function ordinal(n) { var s = ['th','st','nd','rd']; var v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
    function formatDateTime(value) {
      var d = parseDate(value);
      if (!d) return 'Unknown time';
      return ordinal(d.getUTCDate()) + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
    }
    function formatDate(value) {
      var d = parseDate(value);
      if (!d) return 'Unknown';
      return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()].slice(0, 3) + ' ' + d.getUTCFullYear();
    }
    function formatDateShortTime(value) {
      var d = parseDate(value);
      if (!d) return 'Unknown';
      return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()].slice(0, 3) + ' ' + d.getUTCFullYear() + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
    }
    function formatBytes(n) {
      n = Number(n || 0);
      if (!n) return '0 B';
      var u = ['B','KB','MB','GB'];
      var i = Math.floor(Math.log(n) / Math.log(1024));
      i = Math.max(0, Math.min(i, u.length - 1));
      return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
    }
    function capitalize(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
    function cleanTitle(t) {
      var s = String(t == null ? '' : t).trim();
      if (!s) return 'Untitled conversation';
      if (s.charAt(0) === '{' || s.charAt(0) === '[') return 'Untitled conversation';
      return s;
    }
    function mimeExt(m) {
      m = String(m || '').toLowerCase();
      if (m.indexOf('webp') >= 0) return 'webp';
      if (m.indexOf('png') >= 0) return 'png';
      if (m.indexOf('jpeg') >= 0 || m.indexOf('jpg') >= 0) return 'jpg';
      if (m.indexOf('gif') >= 0) return 'gif';
      if (m.indexOf('svg') >= 0) return 'svg';
      if (m.indexOf('mp4') >= 0) return 'mp4';
      if (m.indexOf('webm') >= 0) return 'webm';
      if (m.indexOf('mp3') >= 0 || m.indexOf('mpeg') >= 0) return 'mp3';
      if (m.indexOf('wav') >= 0) return 'wav';
      return '';
    }
    function prettyModel(m) { return String(m || '').trim(); }
    function authorLabel(message) {
      if (message.role === 'user') return 'You';
      if (message.role === 'system') return 'System';
      var m = message.model ? prettyModel(message.model) : '';
      if (message.role === 'assistant') return m || 'Assistant';
      if (message.role === 'tool') return m || 'Tool';
      return m || (message.role ? capitalize(message.role) : 'Message');
    }
    function initialsFor(label) {
      var parts = String(label || '').replace(/[^A-Za-z0-9]/g, ' ').trim().split(/\\s+/).filter(Boolean);
      var out = parts.map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase();
      return out || 'M';
    }
    function looksLikeJson(t) {
      var s = String(t == null ? '' : t).trim();
      if (!s) return false;
      var c = s.charAt(0);
      if (c !== '{' && c !== '[') return false;
      try { JSON.parse(s); return true; } catch (e) { return false; }
    }
    function stripCodeLang(block) {
      var s = block;
      if (s.charAt(0) === '\\n') s = s.slice(1);
      var nl = s.indexOf('\\n');
      if (nl >= 0) {
        var first = s.slice(0, nl).trim();
        if (first && first.indexOf(' ') === -1 && first.length < 24) return s.slice(nl + 1);
      }
      return s;
    }
    function renderInline(text) {
      var out = escapeHtmlClient(text);
      out = out.replace(new RegExp(BACKTICK + '([^' + BACKTICK + ']+)' + BACKTICK, 'g'), '<code>$1</code>');
      out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      out = out.replace(/(https?:\\/\\/[^\\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
      out = out.replace(/\\n/g, '<br>');
      return out;
    }
    function renderMarkdownBlocks(seg) {
      var lines = String(seg).split(/\\n/);
      var out = '';
      var para = [];
      var list = null;
      function flushPara() {
        if (para.length) { out += '<p>' + para.map(renderInline).join('<br>') + '</p>'; para = []; }
      }
      function flushList() {
        if (list) {
          out += '<' + list.type + '>' + list.items.map(function (t) { return '<li>' + renderInline(t) + '</li>'; }).join('') + '</' + list.type + '>';
          list = null;
        }
      }
      for (var j = 0; j < lines.length; j++) {
        var t = lines[j].trim();
        if (!t) { flushPara(); flushList(); continue; }
        var h = t.match(/^(#{1,6})\\s+(.*)$/);
        if (h) { flushPara(); flushList(); var lvl = h[1].length; out += '<h' + lvl + ' class="md-h">' + renderInline(h[2]) + '</h' + lvl + '>'; continue; }
        if (/^(---+|\\*\\*\\*+|___+)$/.test(t)) { flushPara(); flushList(); out += '<hr>'; continue; }
        if (/^>\\s?/.test(t)) { flushPara(); flushList(); out += '<blockquote>' + renderInline(t.replace(/^>\\s?/, '')) + '</blockquote>'; continue; }
        var ul = t.match(/^[-*+]\\s+(.*)$/);
        if (ul) { flushPara(); if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; } list.items.push(ul[1]); continue; }
        var ol = t.match(/^\\d+\\.\\s+(.*)$/);
        if (ol) { flushPara(); if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; } list.items.push(ol[1]); continue; }
        flushList();
        para.push(t);
      }
      flushPara();
      flushList();
      return out;
    }
    function renderRichText(text) {
      if (text == null || String(text).trim() === '') return '<p class="subtle">No readable text was captured for this message.</p>';
      if (looksLikeJson(text)) {
        var pretty;
        try { pretty = JSON.stringify(JSON.parse(String(text).trim()), null, 2); } catch (e) { pretty = String(text); }
        return '<pre><code>' + escapeHtmlClient(pretty) + '</code></pre>';
      }
      var parts = String(text).split(FENCE);
      var html = '';
      for (var i = 0; i < parts.length; i++) {
        if (i % 2 === 1) {
          html += '<pre><code>' + escapeHtmlClient(stripCodeLang(parts[i])) + '</code></pre>';
        } else {
          var seg = parts[i];
          if (!seg || !seg.trim()) continue;
          html += renderMarkdownBlocks(seg);
        }
      }
      return html || ('<p>' + renderInline(String(text)) + '</p>');
    }
    function mediaHref(item) {
      if (!item) return null;
      if (item.path) return '../' + item.path;
      return item.localPath || item.originalUrl || item.sourceUrl || item.url || null;
    }
    function mediaKind(item) {
      var k = String(item && item.kind || '').toLowerCase();
      if (k === 'image' || k === 'video' || k === 'audio') return k;
      return 'attachment';
    }
    function keyOf(item) {
      return item.path || item.mediaId || item.sha256 || mediaHref(item) || (String(item.fileName || '') + ':' + (item.messageId || ''));
    }
    function mediaName(item) {
      var n = String(item.fileName || item.displayTitle || '').trim();
      var looksReal = n && n.length <= 80 && n.indexOf('{') === -1 && n.indexOf('}') === -1 && n.indexOf('"') === -1 && /\\.[a-z0-9]{2,5}$/i.test(n);
      if (looksReal) return n;
      var sha = item.sha256 || (item.mediaId ? String(item.mediaId).replace('sha256:', '') : '');
      var base = String(sha || item.id || 'media').slice(0, 12);
      var ext = mimeExt(item.mimeType);
      return base + (ext ? ('.' + ext) : '');
    }
    function normalizeMedia(item) {
      var msg = item.messageId ? MESSAGE_BY_ID[item.messageId] : null;
      var conv = item.conversationId ? CONVERSATION_BY_ID[item.conversationId] : null;
      var createdAt = item.createdAt
        || (item.createdAtUnixTimestamp ? new Date(Number(item.createdAtUnixTimestamp)).toISOString() : '')
        || (msg ? msg.createdAt : '')
        || '';
      return {
        key: keyOf(item),
        href: mediaHref(item),
        kind: mediaKind(item),
        name: mediaName(item),
        mimeType: item.mimeType || '',
        bytes: item.bytes || 0,
        sha256: item.sha256 || (item.mediaId ? String(item.mediaId).replace('sha256:', '') : ''),
        source: item.source || item.sourceStore || '',
        conversationId: item.conversationId || '',
        conversationTitle: item.conversationTitle || (conv ? conv.title : '') || (msg ? msg.conversationTitle : '') || '',
        messageId: item.messageId || '',
        createdAt: createdAt,
      model: prettyModel(item.model || (msg ? msg.model : '') || ''),
      prompt: String(item.prompt || item.caption || (msg && msg.role !== 'assistant' ? msg.text : '') || '').trim(),
      status: item.status || 'referenced',
      local: Boolean(item.path || item.localPath),
      review: ['failed', 'unresolved'].indexOf(String(item.status || '').toLowerCase()) >= 0
        || (!item.path && !item.localPath && !item.url && !item.sourceUrl && !item.originalUrl && !item.inline && item.status !== 'referenced')
    };
  }
    function collectGalleryMedia() {
      var raw = (VIEWER_DATA.media && VIEWER_DATA.media.items) || [];
      if (!raw.length) {
        raw = [];
        VIEWER_DATA.messages.forEach(function (m) {
          (m.media || []).forEach(function (x) { raw.push(Object.assign({ conversationId: m.conversationId, messageId: m.id }, x)); });
        });
      }
      var seen = {};
      var out = [];
      raw.forEach(function (it) {
        var norm = normalizeMedia(it);
        if (seen[norm.key]) return;
        seen[norm.key] = true;
        out.push(norm);
      });
      out.sort(function (a, b) {
        var ta = a.createdAt ? Date.parse(a.createdAt) : 0;
        var tb = b.createdAt ? Date.parse(b.createdAt) : 0;
        return (isNaN(tb) ? 0 : tb) - (isNaN(ta) ? 0 : ta);
      });
      return out;
    }
    function collectConversationMedia(conversationId) {
      var out = [];
      VIEWER_DATA.messages.filter(function (m) { return m.conversationId === conversationId; }).forEach(function (m) {
        (m.media || []).forEach(function (x) {
          var norm = normalizeMedia(Object.assign({ conversationId: conversationId, messageId: m.id }, x));
          if (norm.href) out.push(norm);
        });
      });
      return out;
    }
    var MESSAGE_BY_ID = {};
    var CONVERSATION_BY_ID = {};
    VIEWER_DATA.messages.forEach(function (m) { if (m && m.id) MESSAGE_BY_ID[m.id] = m; });
    VIEWER_DATA.conversations.forEach(function (c) { if (c && c.id) CONVERSATION_BY_ID[c.id] = c; });
    const MEDIA_ITEMS = collectGalleryMedia();
    const elements = {
      health: document.getElementById('health'),
      warningBox: document.getElementById('warningBox'),
      searchInput: document.getElementById('searchInput'),
      clearSearch: document.getElementById('clearSearch'),
      sortSelect: document.getElementById('sortSelect'),
      kindFilter: document.getElementById('kindFilter'),
      mediaFilter: document.getElementById('mediaFilter'),
      conversationStatusFilter: document.getElementById('conversationStatusFilter'),
      conversationResultsMeta: document.getElementById('conversationResultsMeta'),
      conversationList: document.getElementById('conversationList'),
      detail: document.getElementById('detail'),
      mediaGrid: document.getElementById('mediaGrid'),
      mediaTypeFilters: document.getElementById('mediaTypeFilters'),
      mediaSearchInput: document.getElementById('mediaSearchInput'),
      clearMediaSearch: document.getElementById('clearMediaSearch'),
      mediaSortSelect: document.getElementById('mediaSortSelect'),
      mediaStatusFilter: document.getElementById('mediaStatusFilter'),
      mediaSourceFilter: document.getElementById('mediaSourceFilter'),
      mediaResultsMeta: document.getElementById('mediaResultsMeta'),
      maintenanceCard: document.getElementById('maintenanceCard'),
      packageFileInput: document.getElementById('packageFileInput'),
      selectPackageBtn: document.getElementById('selectPackageBtn'),
      applyPackageBtn: document.getElementById('applyPackageBtn'),
      maintenanceStatus: document.getElementById('maintenanceStatus'),
      maintenanceProgress: document.getElementById('maintenanceProgress'),
      maintenanceProgressBar: document.querySelector('#maintenanceProgress span')
    };
    var selectedPackageFile = null;
    var viewerDirectoryHandle = null;
    var maintenanceBusy = false;
    var VIEWER_STATE_DB_NAME = 'venice-archive-viewer-state';
    var VIEWER_STATE_DB_VERSION = 1;
    var VIEWER_STATE_STORE = 'settings';
    var VIEWER_STATE_KEY = 'directoryHandle';
    function setMaintenanceStatus(text, isError) {
      if (!elements.maintenanceStatus) return;
      elements.maintenanceStatus.textContent = String(text || '');
      elements.maintenanceStatus.classList.toggle('error', Boolean(isError));
    }
    function setMaintenanceProgress(value) {
      var percent = Math.max(0, Math.min(100, Number(value || 0)));
      if (elements.maintenanceProgress) elements.maintenanceProgress.setAttribute('aria-valuenow', String(percent));
      if (elements.maintenanceProgressBar) elements.maintenanceProgressBar.style.width = percent + '%';
    }
    function openViewerStateDb() {
      return new Promise(function (resolve, reject) {
        if (!window.indexedDB) { resolve(null); return; }
        var request;
        try { request = window.indexedDB.open(VIEWER_STATE_DB_NAME, VIEWER_STATE_DB_VERSION); } catch (error) { reject(error); return; }
        request.onupgradeneeded = function () {
          var db = request.result;
          if (!db.objectStoreNames.contains(VIEWER_STATE_STORE)) db.createObjectStore(VIEWER_STATE_STORE);
        };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error || new Error('Could not open archive viewer storage.')); };
      });
    }
    function readViewerDirectoryHandle() {
      return openViewerStateDb().then(function (db) {
        if (!db) return null;
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(VIEWER_STATE_STORE, 'readonly');
          var request = tx.objectStore(VIEWER_STATE_STORE).get(VIEWER_STATE_KEY);
          request.onsuccess = function () { resolve(request.result || null); };
          request.onerror = function () { reject(request.error || new Error('Could not read archive folder permission.')); };
          tx.oncomplete = function () { try { db.close(); } catch (error) {} };
          tx.onerror = function () { try { db.close(); } catch (error) {} };
        });
      });
    }
    function saveViewerDirectoryHandle(handle) {
      if (!handle) return Promise.resolve(false);
      return openViewerStateDb().then(function (db) {
        if (!db) return false;
        return new Promise(function (resolve) {
          var tx;
          try {
            tx = db.transaction(VIEWER_STATE_STORE, 'readwrite');
            tx.objectStore(VIEWER_STATE_STORE).put(handle, VIEWER_STATE_KEY);
            tx.oncomplete = function () { try { db.close(); } catch (error) {} resolve(true); };
            tx.onerror = function () { try { db.close(); } catch (error) {} resolve(false); };
            tx.onabort = function () { try { db.close(); } catch (error) {} resolve(false); };
          } catch (error) {
            try { db.close(); } catch (closeError) {}
            resolve(false);
          }
        });
      }, function () { return false; });
    }
    function normalisePackagePath(path) {
      var value = String(path || '').replace(/\\\\/g, '/');
      if (!value || value.charAt(0) === '/' || /^[A-Za-z]:\\//.test(value)) return null;
      var parts = value.split('/').filter(function (segment) { return segment && segment !== '.'; });
      if (!parts.length || parts.some(function (segment) { return segment === '..'; })) return null;
      return parts.join('/');
    }
    function packageU16(view, offset) { return view.getUint16(offset, true); }
    function packageU32(view, offset) { return view.getUint32(offset, true); }
    function findPackageEndRecord(bytes) {
      for (var offset = bytes.length - 22; offset >= 0; offset -= 1) {
        if (bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b && bytes[offset + 2] === 0x05 && bytes[offset + 3] === 0x06) return offset;
      }
      return -1;
    }
    async function parseStoredPackage(file) {
      if (!file || !file.size) throw new Error('Choose a non-empty package ZIP first.');
      var tailSize = Math.min(file.size, 65557);
      var tail = new Uint8Array(await file.slice(file.size - tailSize).arrayBuffer());
      var endOffset = findPackageEndRecord(tail);
      if (endOffset < 0) throw new Error('This file is not a readable ZIP package.');
      var endView = new DataView(tail.buffer, tail.byteOffset + endOffset, 22);
      var entryCount = packageU16(endView, 10);
      var centralSize = packageU32(endView, 12);
      var centralOffset = packageU32(endView, 16);
      if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error('ZIP64 packages are not supported by this local applier.');
      if (!entryCount || centralOffset + centralSize > file.size) throw new Error('The package ZIP directory is incomplete.');
      var central = new Uint8Array(await file.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
      var decoder = new TextDecoder('utf-8', { fatal: false });
      var entries = [];
      var seenPaths = {};
      var cursor = 0;
      for (var i = 0; i < entryCount; i += 1) {
        if (cursor + 46 > central.length || packageU32(new DataView(central.buffer, central.byteOffset + cursor, 46), 0) !== 0x02014b50) throw new Error('The package ZIP directory is malformed.');
        var view = new DataView(central.buffer, central.byteOffset + cursor, 46);
        var flags = packageU16(view, 8);
        var method = packageU16(view, 10);
        var compressedSize = packageU32(view, 20);
        var uncompressedSize = packageU32(view, 24);
        var nameLength = packageU16(view, 28);
        var extraLength = packageU16(view, 30);
        var commentLength = packageU16(view, 32);
        var localOffset = packageU32(view, 42);
        var recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
        if (recordEnd > central.length) throw new Error('The package ZIP directory contains a truncated filename.');
        var nameBytes = central.slice(cursor + 46, cursor + 46 + nameLength);
        var decodedName = decoder.decode(nameBytes);
        // The package writer emits file entries only, but tolerate ordinary
        // ZIP directory entries when a user selects a package that was
        // repacked by another tool.  A directory marker is a single trailing
        // slash (not a backslash-plus-slash sequence).
        var isDirectory = /\\\/$/.test(decodedName);
        var path = isDirectory ? null : normalisePackagePath(decodedName);
        if (!isDirectory && !path) throw new Error('The package ZIP contains an unsafe relative path.');
        if (path) {
          if (seenPaths[path]) throw new Error('The package ZIP contains duplicate file paths.');
          seenPaths[path] = true;
          if ((flags & 1) !== 0) throw new Error('Encrypted ZIP entries cannot be applied safely.');
          if (method !== 0 || compressedSize !== uncompressedSize) throw new Error('This package uses compression; choose a Venice package ZIP created by the extension.');
          if (localOffset >= file.size || localOffset + 30 > file.size) throw new Error('The package ZIP contains an invalid file offset.');
          entries.push({ path: path, compressedSize: compressedSize, uncompressedSize: uncompressedSize, localOffset: localOffset });
        }
        cursor = recordEnd;
      }
      var manifestEntry = entries.find(function (entry) { return entry.path === 'venice-archive.manifest.json'; });
      if (!manifestEntry) throw new Error('This package does not contain venice-archive.manifest.json.');
      var readmeEntry = entries.find(function (entry) { return entry.path === 'PACKAGE-README.txt'; });
      var mode = 'unknown';
      if (readmeEntry) {
        var readmeText = await readPackageEntryBlob(file, readmeEntry).then(function (blob) { return blob.text(); });
        mode = /Mode:\\s*diff\\b/i.test(readmeText) ? 'diff' : 'full';
      }
      var manifest;
      try { manifest = JSON.parse(await readPackageEntryBlob(file, manifestEntry).then(function (blob) { return blob.text(); })); } catch (error) { throw new Error('The package root manifest is not valid JSON.'); }
      if (!manifest || typeof manifest !== 'object' || !manifest.archiveId) throw new Error('The package root manifest is missing its archive id.');
      entries.sort(function (left, right) {
        if (left.path === manifestEntry.path) return 1;
        if (right.path === manifestEntry.path) return -1;
        return left.path.localeCompare(right.path);
      });
      return { entries: entries, manifestEntry: manifestEntry, manifest: manifest, mode: mode };
    }
    function ensureArchiveDirectoryPermission(handle) {
      if (!handle || typeof handle.queryPermission !== 'function') return Promise.resolve(handle);
      return handle.queryPermission({ mode: 'readwrite' }).then(function (permission) {
        if (permission === 'granted') return handle;
        if (typeof handle.requestPermission === 'function') {
          return handle.requestPermission({ mode: 'readwrite' }).then(function (requested) {
            if (requested !== 'granted') throw new Error('Write permission was not granted for this archive folder.');
            return handle;
          });
        }
        throw new Error('Write permission is required for this archive folder.');
      });
    }
    async function getViewerArchiveDirectory() {
      if (viewerDirectoryHandle) {
        try { return await ensureArchiveDirectoryPermission(viewerDirectoryHandle); } catch (error) { viewerDirectoryHandle = null; }
      }
      try {
        var saved = await readViewerDirectoryHandle();
        if (saved) {
          try {
            viewerDirectoryHandle = await ensureArchiveDirectoryPermission(saved);
            if (viewerDirectoryHandle) return viewerDirectoryHandle;
          } catch (error) { viewerDirectoryHandle = null; }
        }
      } catch (error) {}
      if (typeof window.showDirectoryPicker !== 'function') throw new Error('This browser cannot grant a local folder to the archive viewer. Extract the ZIP manually into the existing archive folder.');
      viewerDirectoryHandle = await window.showDirectoryPicker({ id: 'venice-archive-repository', mode: 'readwrite', startIn: 'documents' });
      await ensureArchiveDirectoryPermission(viewerDirectoryHandle);
      await saveViewerDirectoryHandle(viewerDirectoryHandle);
      return viewerDirectoryHandle;
    }
    async function writePackageEntry(rootHandle, entry, file) {
      var payload = await readPackageEntryBlob(file, entry);
      var segments = entry.path.split('/');
      var target = rootHandle;
      for (var i = 0; i < segments.length - 1; i += 1) target = await target.getDirectoryHandle(segments[i], { create: true });
      var fileHandle = await target.getFileHandle(segments[segments.length - 1], { create: true });
      var writable = await fileHandle.createWritable();
      try { await writable.write(payload); } finally { await writable.close(); }
    }
    async function readPackageEntryBlob(file, entry) {
      var localHeader = new Uint8Array(await file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
      if (localHeader.length < 30 || packageU32(new DataView(localHeader.buffer), 0) !== 0x04034b50) throw new Error('The package ZIP contains an invalid local file header.');
      var localView = new DataView(localHeader.buffer);
      var localNameLength = packageU16(localView, 26);
      var localExtraLength = packageU16(localView, 28);
      var dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
      var dataEnd = dataStart + entry.uncompressedSize;
      if (dataStart < 0 || dataEnd > file.size) throw new Error('The package ZIP contains a truncated file.');
      return file.slice(dataStart, dataEnd);
    }
    async function readViewerTargetManifest(rootHandle) {
      try {
        var fileHandle = await rootHandle.getFileHandle('venice-archive.manifest.json', { create: false });
        return JSON.parse(await (await fileHandle.getFile()).text());
      } catch (error) {
        if (error && error.name === 'NotFoundError') return null;
        throw error;
      }
    }
    async function validatePackageTarget(rootHandle, parsed) {
      var existingManifest = await readViewerTargetManifest(rootHandle);
      if (existingManifest && existingManifest.archiveId && existingManifest.archiveId !== parsed.manifest.archiveId) {
        throw new Error('The selected folder belongs to a different Venice archive. Choose the matching archive folder.');
      }
      if (parsed.mode === 'diff' && !existingManifest) {
        throw new Error('This is an incremental package. Apply it to the existing full archive folder, not an empty folder.');
      }
      return existingManifest;
    }
    async function applySelectedPackage() {
      if (maintenanceBusy) return;
      if (!selectedPackageFile) { setMaintenanceStatus('Choose a full or incremental ZIP first.', true); return; }
      maintenanceBusy = true;
      elements.selectPackageBtn.disabled = true;
      elements.applyPackageBtn.disabled = true;
      setMaintenanceProgress(0);
      setMaintenanceStatus('Checking package…');
      try {
        var parsed = await parseStoredPackage(selectedPackageFile);
        var rootHandle = await getViewerArchiveDirectory();
        await validatePackageTarget(rootHandle, parsed);
        var entries = parsed.entries;
        for (var i = 0; i < entries.length; i += 1) {
          var entry = entries[i];
          setMaintenanceStatus('Writing ' + (i + 1) + ' of ' + entries.length + ': ' + entry.path);
          await writePackageEntry(rootHandle, entry, selectedPackageFile);
          setMaintenanceProgress(((i + 1) / entries.length) * 100);
        }
        setMaintenanceStatus('Applied ' + formatNumber(entries.length) + ' files. Reloading the archive…');
        setMaintenanceProgress(100);
        window.setTimeout(function () { window.location.reload(); }, 700);
      } catch (error) {
        setMaintenanceStatus(error && error.message ? error.message : 'The package could not be applied.', true);
        setMaintenanceProgress(0);
        elements.selectPackageBtn.disabled = false;
        elements.applyPackageBtn.disabled = !selectedPackageFile;
        maintenanceBusy = false;
      }
    }
    function setupMaintenance() {
      if (!elements.maintenanceCard) return;
      if (typeof window.showDirectoryPicker !== 'function') {
        setMaintenanceStatus('Folder access is unavailable here. Extract packages manually into this same archive folder.');
      } else {
        setMaintenanceStatus('Choose a package ZIP to update this archive folder.');
        readViewerDirectoryHandle().then(function (handle) {
          if (handle && handle.name) {
            viewerDirectoryHandle = handle;
            setMaintenanceStatus('Archive folder remembered: ' + handle.name + '. Choose a package ZIP to update it.');
          }
        }).catch(function () {});
      }
      elements.selectPackageBtn.addEventListener('click', function () { if (!maintenanceBusy) elements.packageFileInput.click(); });
      elements.packageFileInput.addEventListener('change', function () {
        selectedPackageFile = elements.packageFileInput.files && elements.packageFileInput.files[0] ? elements.packageFileInput.files[0] : null;
        elements.applyPackageBtn.disabled = !selectedPackageFile || typeof window.showDirectoryPicker !== 'function';
        setMaintenanceProgress(0);
        if (selectedPackageFile) setMaintenanceStatus(selectedPackageFile.name + ' · ' + formatBytes(selectedPackageFile.size) + ' ready to apply.');
      });
      elements.applyPackageBtn.addEventListener('click', applySelectedPackage);
    }
    function segmentSearchText(segment) {
      if (!segment) return '';
      var parts = [segment.type, segment.tool, segment.phase, segment.query, segment.text];
      if (segment.sources && Array.isArray(segment.sources)) {
        segment.sources.forEach(function (source) { parts.push(source && source.title, source && source.url); });
      }
      ['arguments', 'output'].forEach(function (key) {
        if (segment[key] == null) return;
        try { parts.push(typeof segment[key] === 'string' ? segment[key] : JSON.stringify(segment[key])); } catch (e) { parts.push(String(segment[key])); }
      });
      return parts.filter(Boolean).join(' ');
    }
    function messageSearchText(message) {
      var parts = [message.id, message.role, message.model, message.text];
      (message.attachments || []).forEach(function (attachment) { parts.push(attachment.id, attachment.fileName, attachment.type, attachment.mimeType); });
      (message.media || []).forEach(function (media) { parts.push(media.mediaId, media.fileName, media.displayTitle, media.promptText, media.source, media.sourceStore, media.mimeType, media.status); });
      (message.agentSegments || []).forEach(function (segment) { parts.push(segmentSearchText(segment)); });
      return parts.filter(Boolean).join(' ');
    }
    var CONVERSATION_META = {};
    VIEWER_DATA.conversations.forEach(function (conversation) {
      var messages = VIEWER_DATA.messages.filter(function (message) { return message.conversationId === conversation.id; });
      var attachments = messages.reduce(function (total, message) { return total + (message.attachments || []).length; }, 0);
      var media = messages.reduce(function (all, message) { return all.concat(message.media || []); }, []);
      var galleryMedia = MEDIA_ITEMS.filter(function (item) { return item.conversationId === conversation.id; });
      var localMedia = media.filter(function (item) { return Boolean(item.path || item.localPath); }).length;
      var reviewMedia = media.filter(function (item) { return ['failed', 'unresolved'].indexOf(String(item.status || '').toLowerCase()) >= 0 || (!item.path && !item.localPath && !item.url && !item.sourceUrl && !item.originalUrl && !item.inline && item.status !== 'referenced'); }).length;
      localMedia += galleryMedia.filter(function (item) { return item.local; }).length;
      reviewMedia += galleryMedia.filter(function (item) { return item.review; }).length;
      CONVERSATION_META[conversation.id] = {
        searchText: [conversation.id, conversation.title, conversation.preview, conversation.kind].concat(messages.map(messageSearchText)).concat(galleryMedia.map(function (item) { return [item.name, item.source, item.prompt, item.model, item.status].join(' '); })).join(' ').toLowerCase(),
        attachments: attachments,
        localMedia: localMedia,
        reviewMedia: reviewMedia
      };
    });
    const state = { query: '', sort: 'updated-desc', kindFilter: 'all', mediaFilter: 'all', conversationStatusFilter: 'all', selectedId: VIEWER_DATA.conversations[0] ? VIEWER_DATA.conversations[0].id : null, tab: 'conversations', mediaType: 'all', mediaQuery: '', mediaSort: 'newest', mediaStatus: 'all', mediaSource: 'all', mediaRendered: false };
    var lb = { list: [], index: 0 };
    function messagesFor(conversationId) { return VIEWER_DATA.messages.filter((message) => message.conversationId === conversationId); }
    function queryTokens(value) { return String(value || '').toLowerCase().trim().split(/\s+/).filter(Boolean); }
    function filteredConversations() {
      const query = queryTokens(state.query);
      const filtered = VIEWER_DATA.conversations.filter((conversation) => {
        var meta = CONVERSATION_META[conversation.id] || { searchText: '', attachments: 0, localMedia: 0, reviewMedia: 0 };
        if (state.kindFilter !== 'all' && conversation.kind !== state.kindFilter) return false;
        if (state.mediaFilter === 'with-media' && !conversation.mediaCount) return false;
        if (state.mediaFilter === 'with-attachments' && !meta.attachments) return false;
        if (state.mediaFilter === 'without-media' && conversation.mediaCount) return false;
        if (state.conversationStatusFilter === 'local-media' && !meta.localMedia) return false;
        if (state.conversationStatusFilter === 'review' && !meta.reviewMedia) return false;
        if (!query.length) return true;
        return query.every(function (token) { return meta.searchText.indexOf(token) >= 0; });
      });
      return filtered.sort((left, right) => {
        if (state.sort === 'title-asc') return String(left.title).localeCompare(String(right.title));
        if (state.sort === 'messages-desc') return Number(right.messageCount || 0) - Number(left.messageCount || 0);
        if (state.sort === 'media-desc') return Number(right.mediaCount || 0) - Number(left.mediaCount || 0);
        if (state.sort === 'created-desc') return String(right.createdAt || '').localeCompare(String(left.createdAt || ''));
        return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
      });
    }
    function renderHealth() {
      const totals = VIEWER_DATA.rootManifest.totals || {};
      elements.health.innerHTML = [
        ['Conversations', totals.conversations],
        ['Messages', totals.messages],
        ['Media files', totals.mediaFiles],
        ['Source stores', totals.sourceStores],
        ['Unresolved media', totals.unresolvedMedia]
      ].map(([label, value]) => '<article class="metric"><span>' + escapeHtmlClient(label) + '</span><strong>' + escapeHtmlClient(formatNumber(value)) + '</strong></article>').join('');
      const warnings = (VIEWER_DATA.rootManifest.verification && VIEWER_DATA.rootManifest.verification.warnings) || [];
      elements.warningBox.innerHTML = warnings.length ? '<strong>Export notes:</strong> ' + escapeHtmlClient(warnings.join(' ')) : '<strong>Export notes:</strong> No repository warnings were recorded.';
    }
    function renderList() {
      const conversations = filteredConversations();
      elements.conversationResultsMeta.textContent = formatNumber(conversations.length) + ' of ' + formatNumber(VIEWER_DATA.conversations.length) + ' conversations' + (state.query ? ' match “' + state.query.trim() + '”' : '');
      elements.clearSearch.hidden = !state.query;
      if (!conversations.some((conversation) => conversation.id === state.selectedId)) {
        state.selectedId = conversations[0] ? conversations[0].id : null;
      }
      elements.conversationList.innerHTML = conversations.length ? conversations.map((conversation) => {
        const active = conversation.id === state.selectedId ? ' active' : '';
        var conversationMeta = CONVERSATION_META[conversation.id] || {};
        var when = formatDateShortTime(conversation.updatedAt || conversation.createdAt);
        var meta = '<span>' + escapeHtmlClient(when) + '</span><span class="dot"></span><span>' + escapeHtmlClient(formatNumber(conversation.messageCount)) + ' msgs</span>' + (conversation.mediaCount ? '<span class="dot"></span><span>' + escapeHtmlClient(formatNumber(conversation.mediaCount)) + ' media</span>' : '') + (conversationMeta.reviewMedia ? '<span class="review-inline">Review media</span>' : '');
        var badge = conversation.kind === 'agent'
          ? ' <span class="kind-badge">' + IC.tool + 'Agent</span>'
          : (conversation.kind === 'support' ? ' <span class="kind-badge">Support</span>' : '');
        return '<button class="conversation-button' + active + '" data-id="' + escapeHtmlClient(conversation.id) + '"><div class="conversation-title">' + escapeHtmlClient(cleanTitle(conversation.title)) + badge + '</div><div class="conversation-meta">' + meta + '</div></button>';
      }).join('') : '<p class="conversation-meta">No conversations match this search.</p>';
      elements.conversationList.querySelectorAll('[data-id]').forEach((button) => button.addEventListener('click', () => {
        state.selectedId = button.getAttribute('data-id');
        renderList();
        renderDetail();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }));
    }
    function renderEmbeds(media) {
      var items = (media || []).filter(function (it) {
        if (!it) return false;
        var kind = mediaKind(it);
        return kind === 'image' || kind === 'video' || kind === 'audio';
      });
      if (!items.length) return '';
      var cards = items.map(function (it) {
        var href = mediaHref(it);
        var kind = mediaKind(it);
        if (kind === 'image' && href) {
          return '<div class="embed" data-media-open="' + escapeHtmlClient(keyOf(it)) + '"><img loading="lazy" src="' + escapeHtmlClient(href) + '" alt=""><a class="embed-icon" href="' + escapeHtmlClient(href) + '" target="_blank" rel="noreferrer" title="Open raw image">' + IC.ext + '</a></div>';
        }
        if (kind === 'video' && href) {
          return '<div class="embed" data-media-open="' + escapeHtmlClient(keyOf(it)) + '"><video src="' + escapeHtmlClient(href) + '" muted></video><span class="embed-icon">' + IC.play + '</span></div>';
        }
        if (kind === 'audio' && href) {
          return '<div class="embed audio" data-media-open="' + escapeHtmlClient(keyOf(it)) + '">' + IC.audio + '<span>' + escapeHtmlClient(mediaName(it)) + '</span></div>';
        }
        return '';
      }).join('');
      return '<div class="embed-grid">' + cards + '</div>';
    }
    function renderAttachments(attachments) {
      if (!attachments || !attachments.length) return '';
      return '<div class="attach-list">' + attachments.map(function (a) {
        var label = escapeHtmlClient(a.fileName || a.id || 'attachment');
        var href = a.path ? '../' + a.path : null;
        var suffix = a.materialized ? ' · saved' : (a.hasEmbeddedResult ? ' · review' : '');
        return href
          ? '<a class="attach-chip" href="' + escapeHtmlClient(href) + '" download>' + IC.file + label + escapeHtmlClient(suffix) + '</a>'
          : '<span class="attach-chip">' + IC.file + label + escapeHtmlClient(suffix) + '</span>';
      }).join('') + '</div>';
    }
    function renderToolSegment(seg) {
      var title;
      var bodyHtml;
      if (seg.tool === 'web_search') {
        title = IC.search + '<span>Web search' + (seg.query ? ': ' + escapeHtmlClient(seg.query) : '') + '</span>';
        var sources = (seg.sources || []).map(function (s) {
          var label = escapeHtmlClient(s.title || s.url || 'source');
          if (s.url) return '<li><a href="' + escapeHtmlClient(s.url) + '" target="_blank" rel="noreferrer">' + label + '</a></li>';
          return '<li>' + label + '</li>';
        }).join('');
        bodyHtml = sources ? '<ul class="agent-sources">' + sources + '</ul>' : '<p class="subtle">No sources were recorded.</p>';
      } else {
        var phase = seg.phase === 'output' ? 'output' : 'call';
        title = IC.tool + '<span>Tool ' + phase + ': ' + escapeHtmlClient(seg.tool || 'function') + '</span>';
        var payload = seg.phase === 'output' ? seg.output : seg.arguments;
        var text;
        if (payload == null) text = '';
        else if (typeof payload === 'string') text = payload;
        else { try { text = JSON.stringify(payload, null, 2); } catch (e) { text = String(payload); } }
        bodyHtml = text ? '<pre><code>' + escapeHtmlClient(text) + '</code></pre>' : '<p class="subtle">No payload was recorded.</p>';
      }
      return '<details class="agent-detail"><summary>' + title + '</summary><div class="agent-detail-body">' + bodyHtml + '</div></details>';
    }
    function renderAgentSegments(segments) {
      return (segments || []).map(function (seg) {
        if (!seg) return '';
        if (seg.type === 'text') return '<div class="message-text">' + renderRichText(seg.text) + '</div>';
        if (seg.type === 'reasoning') return '<details class="agent-detail"><summary>' + IC.reasoning + '<span>Reasoning</span></summary><div class="agent-detail-body">' + renderRichText(seg.text) + '</div></details>';
        if (seg.type === 'tool') return renderToolSegment(seg);
        return '';
      }).join('');
    }
    function copyText(text, btn) {
      var done = function () {
        if (!btn) return;
        var prev = btn.innerHTML;
        btn.innerHTML = IC.check;
        setTimeout(function () { btn.innerHTML = prev; }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
        return;
      }
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
      done();
    }
    function renderDetail() {
      const conversation = VIEWER_DATA.conversations.find((entry) => entry.id === state.selectedId);
      if (!conversation) {
        elements.detail.innerHTML = '<p class="subtle">Select a conversation to inspect the local archive contents.</p>';
        return;
      }
      const messages = messagesFor(conversation.id);
      var isAgent = conversation.kind === 'agent';
      var head = '<div class="detail-head"><p class="eyebrow">' + escapeHtmlClient(conversation.id) + '</p><h2>' + escapeHtmlClient(cleanTitle(conversation.title)) + (isAgent ? ' <span class="kind-badge">' + IC.tool + 'Agent</span>' : '') + '</h2>'
        + (conversation.preview ? '<p class="subtle">' + escapeHtmlClient(conversation.preview) + '</p>' : '')
        + '<div class="head-meta"><span>' + escapeHtmlClient(formatDateShortTime(conversation.updatedAt || conversation.createdAt)) + '</span>'
        + '<span class="dot"></span><span>' + escapeHtmlClient(formatNumber(conversation.messageCount)) + ' messages</span>'
        + '<span class="dot"></span><span>' + escapeHtmlClient(formatNumber(conversation.mediaCount)) + ' media</span>'
        + '<div class="head-actions">'
        + (isAgent && conversation.agentUrl ? '<a class="btn" href="' + escapeHtmlClient(conversation.agentUrl) + '" target="_blank" rel="noreferrer">' + IC.ext + 'Open in Venice</a>' : '')
        + '<a class="btn" href="../' + escapeHtmlClient(conversation.markdownPath) + '" download>' + IC.dl + 'Markdown</a><a class="btn" href="../' + escapeHtmlClient(conversation.jsonPath) + '" download>' + IC.dl + 'JSON</a></div>'
        + '</div></div>';
      var stack = messages.map(function (message, idx) {
        var role = ['user', 'assistant', 'system', 'tool'].indexOf(message.role) >= 0 ? message.role : 'message';
        var author = authorLabel(message);
        var msgHead = '<div class="message-head"><span class="avatar">' + escapeHtmlClient(initialsFor(author)) + '</span><span class="author">' + escapeHtmlClient(author) + '</span><span class="message-time">' + escapeHtmlClient(formatDateTime(message.createdAt)) + '</span><button class="icon-btn copy-btn" type="button" data-idx="' + idx + '" title="Copy message as markdown" aria-label="Copy message">' + IC.copy + '</button></div>';
        var hasSegments = message.agentSegments && message.agentSegments.length;
        var textHtml = hasSegments ? renderAgentSegments(message.agentSegments) : '<div class="message-text">' + renderRichText(message.text) + '</div>';
        var foot = (role === 'assistant' || role === 'tool' || role === 'message')
          ? '<div class="message-foot"><button class="btn copy-btn" type="button" data-idx="' + idx + '" aria-label="Copy message">' + IC.copy + 'Copy</button></div>'
          : '';
        var body = '<div class="message-body">' + textHtml + renderEmbeds(message.media) + renderAttachments(message.attachments) + '</div>' + foot;
        return '<article class="message ' + escapeHtmlClient(role) + '">' + msgHead + body + '</article>';
      }).join('');
      elements.detail.innerHTML = head + '<div class="message-stack">' + stack + '</div>';
      elements.detail.querySelectorAll('.copy-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var i = Number(btn.getAttribute('data-idx'));
          var text = messages[i] ? (messages[i].text || '') : '';
          copyText(text, btn);
        });
      });
      elements.detail.querySelectorAll('[data-media-open]').forEach(function (el) {
        el.addEventListener('click', function (event) {
          if (event.target.closest && event.target.closest('a')) return;
          var key = el.getAttribute('data-media-open');
          var list = collectConversationMedia(conversation.id);
          var idx = 0;
          for (var i = 0; i < list.length; i++) { if (list[i].key === key) { idx = i; break; } }
          openLightbox(list, idx);
        });
      });
    }
    function galleryItems() {
      var query = queryTokens(state.mediaQuery);
      var items = MEDIA_ITEMS.filter(function (it) {
        if (state.mediaType !== 'all' && it.kind !== state.mediaType) return false;
        if (state.mediaSource !== 'all' && it.source !== state.mediaSource) return false;
        if (state.mediaStatus === 'local' && !it.local) return false;
        if (state.mediaStatus === 'reference' && (it.local || !it.href)) return false;
        if (state.mediaStatus === 'review' && !it.review) return false;
        if (!query.length) return true;
        var text = [it.name, it.mimeType, it.source, it.conversationTitle, it.model, it.prompt, it.messageId, it.sha256, it.status].join(' ').toLowerCase();
        return query.every(function (token) { return text.indexOf(token) >= 0; });
      });
      return items.sort(function (left, right) {
        if (state.mediaSort === 'name') return left.name.localeCompare(right.name);
        if (state.mediaSort === 'largest') return Number(right.bytes || 0) - Number(left.bytes || 0);
        var leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
        var rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
        return state.mediaSort === 'oldest' ? leftTime - rightTime : rightTime - leftTime;
      });
    }
    function renderMediaFilters() {
      var counts = { image: 0, video: 0, audio: 0, attachment: 0 };
      MEDIA_ITEMS.forEach(function (it) { counts[it.kind] = (counts[it.kind] || 0) + 1; });
      var buckets = [['all', 'All', MEDIA_ITEMS.length]];
      [['image', 'Images'], ['video', 'Video'], ['audio', 'Audio'], ['attachment', 'Attachments']].forEach(function (b) {
        if (counts[b[0]]) buckets.push([b[0], b[1], counts[b[0]]]);
      });
      elements.mediaTypeFilters.innerHTML = buckets.map(function (b) {
        var active = state.mediaType === b[0] ? ' active' : '';
        return '<button class="chip' + active + '" type="button" data-type="' + escapeHtmlClient(b[0]) + '">' + escapeHtmlClient(b[1]) + '<span class="count">' + escapeHtmlClient(formatNumber(b[2])) + '</span></button>';
      }).join('');
      elements.mediaTypeFilters.querySelectorAll('[data-type]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          state.mediaType = btn.getAttribute('data-type');
          renderMediaFilters();
          renderMediaGrid();
        });
      });
      var sources = {};
      MEDIA_ITEMS.forEach(function (item) { if (item.source) sources[item.source] = (sources[item.source] || 0) + 1; });
      var sourceOptions = '<option value="all">All sources</option>' + Object.keys(sources).sort().map(function (source) {
        return '<option value="' + escapeHtmlClient(source) + '">' + escapeHtmlClient(source) + ' (' + escapeHtmlClient(formatNumber(sources[source])) + ')</option>';
      }).join('');
      var selectedSource = state.mediaSource;
      elements.mediaSourceFilter.innerHTML = sourceOptions;
      elements.mediaSourceFilter.value = Object.prototype.hasOwnProperty.call(sources, selectedSource) ? selectedSource : 'all';
      state.mediaSource = elements.mediaSourceFilter.value;
    }
    function iconForKind(kind) {
      if (kind === 'image') return IC.image;
      if (kind === 'video') return IC.play;
      if (kind === 'audio') return IC.audio;
      return IC.file;
    }
    function renderMediaGrid() {
      var items = galleryItems();
      elements.mediaResultsMeta.textContent = formatNumber(items.length) + ' media items' + (state.mediaQuery ? ' match “' + state.mediaQuery.trim() + '”' : '');
      elements.clearMediaSearch.hidden = !state.mediaQuery;
      if (!items.length) {
        elements.mediaGrid.innerHTML = '<div class="gallery-empty">No media of this type was captured in the archive.</div>';
        return;
      }
      var showBadge = state.mediaType === 'all';
      elements.mediaGrid.innerHTML = items.map(function (it, i) {
        var date = it.createdAt ? formatDate(it.createdAt) : '';
        if (it.kind === 'audio') {
          return '<div class="thumb audio-card" data-idx="' + i + '">'
            + '<div class="file-name">' + escapeHtmlClient(it.name) + '</div>'
            + (date ? '<div class="file-date">' + escapeHtmlClient(date) + '</div>' : '')
            + (it.href ? '<audio src="' + escapeHtmlClient(it.href) + '" controls preload="none"></audio>' : '<div class="file-date">No audio file is available.</div>')
            + '</div>';
        }
        if (it.kind === 'attachment') {
          return '<div class="thumb file-card" data-idx="' + i + '" data-open="1">'
            + '<span class="file-icon">' + IC.file + '</span>'
            + '<div class="file-name">' + escapeHtmlClient(it.name) + '</div>'
            + (date ? '<div class="file-date">' + escapeHtmlClient(date) + '</div>' : '')
            + '</div>';
        }
        var inner;
        if (it.kind === 'image' && it.href) inner = '<img loading="lazy" src="' + escapeHtmlClient(it.href) + '" alt="">';
        else if (it.kind === 'video' && it.href) inner = '<video src="' + escapeHtmlClient(it.href) + '" muted></video>';
        else inner = '<div class="ph">' + iconForKind(it.kind) + '</div>';
        return '<div class="thumb" data-idx="' + i + '" data-open="1">' + inner
          + (it.review ? '<span class="review-badge">Review</span>' : '')
          + (showBadge ? '<span class="badge" title="' + escapeHtmlClient(it.kind) + '">' + iconForKind(it.kind) + '</span>' : '')
          + '<span class="thumb-caption">' + escapeHtmlClient(it.name) + '</span></div>';
      }).join('');
      elements.mediaGrid.querySelectorAll('[data-open]').forEach(function (el) {
        el.addEventListener('click', function () { openLightbox(items, Number(el.getAttribute('data-idx'))); });
      });
    }
    function openLightbox(list, index) {
      lb.list = list || [];
      lb.index = index || 0;
      document.getElementById('lightbox').hidden = false;
      document.body.style.overflow = 'hidden';
      renderLightbox();
    }
    function closeLightbox() {
      document.getElementById('lightbox').hidden = true;
      document.body.style.overflow = '';
      document.getElementById('lbMedia').innerHTML = '';
    }
    function lbStep(delta) {
      if (!lb.list.length) return;
      lb.index = (lb.index + delta + lb.list.length) % lb.list.length;
      renderLightbox();
    }
    function renderLightbox() {
      var it = lb.list[lb.index];
      if (!it) return;
      var media;
      if (it.kind === 'image' && it.href) media = '<img src="' + escapeHtmlClient(it.href) + '" alt="">';
      else if (it.kind === 'video' && it.href) media = '<video src="' + escapeHtmlClient(it.href) + '" controls preload="metadata"></video>';
      else if (it.kind === 'audio' && it.href) media = '<div class="ph">' + IC.audio + '<audio src="' + escapeHtmlClient(it.href) + '" controls preload="metadata"></audio></div>';
      else media = '<div class="ph">' + IC.file + '<p>No previewable file is available for this item.</p></div>';
      document.getElementById('lbMedia').innerHTML = media;
      document.getElementById('lbCounter').textContent = (lb.index + 1) + ' / ' + lb.list.length;
      var multi = lb.list.length > 1;
      document.getElementById('lbPrev').style.display = multi ? 'grid' : 'none';
      document.getElementById('lbNext').style.display = multi ? 'grid' : 'none';
      var rows = [
        ['Type', it.kind],
        ['File', it.name],
        ['MIME', it.mimeType || 'Unknown'],
        ['Size', it.bytes ? formatBytes(it.bytes) : 'Unknown'],
        ['Created', it.createdAt ? formatDateTime(it.createdAt) : 'Unknown'],
        ['Model', it.model || 'Unknown'],
        ['Source', it.source || 'Unknown'],
        ['Status', it.review ? 'Needs review' : (it.local ? 'Saved locally' : (it.href ? 'Reference' : 'No bytes'))],
        ['SHA-256', it.sha256 || 'Unknown'],
        ['Message', it.messageId || 'None']
      ];
      var metaParts = rows.map(function (r) { return '<dt>' + escapeHtmlClient(r[0]) + '</dt><dd>' + escapeHtmlClient(r[1]) + '</dd>'; });
      if (it.prompt) {
        metaParts.push('<dt>Prompt</dt><dd><div class="meta-copy"><span class="meta-copy-text">' + escapeHtmlClient(it.prompt) + '</span><button class="icon-btn" type="button" id="lbPromptCopy" title="Copy prompt" aria-label="Copy prompt">' + IC.copy + '</button></div></dd>');
      }
      if (it.conversationId) {
        metaParts.push('<dt>Conversation</dt><dd><button class="meta-link" type="button" id="lbConvLink">' + escapeHtmlClient(cleanTitle(it.conversationTitle || it.conversationId)) + '</button></dd>');
      } else {
        metaParts.push('<dt>Conversation</dt><dd>None</dd>');
      }
      var actions = it.href
        ? ('<a class="btn" href="' + escapeHtmlClient(it.href) + '" target="_blank" rel="noreferrer">' + IC.ext + 'Open in new tab</a><a class="btn btn-primary" href="' + escapeHtmlClient(it.href) + '" download="' + escapeHtmlClient(it.name) + '">' + IC.dl + 'Download</a>')
        : '<span class="subtle">No local file is available for this item.</span>';
      document.getElementById('lbMeta').innerHTML = '<h3>' + escapeHtmlClient(it.name) + '</h3><p class="subtle">' + escapeHtmlClient(capitalize(it.kind)) + (it.bytes ? (' &middot; ' + escapeHtmlClient(formatBytes(it.bytes))) : '') + '</p><div class="lb-actions">' + actions + '</div><dl class="metadata-grid">' + metaParts.join('') + '</dl>';
      var promptCopy = document.getElementById('lbPromptCopy');
      if (promptCopy) { promptCopy.addEventListener('click', function () { copyText(it.prompt, promptCopy); }); }
      var convLink = document.getElementById('lbConvLink');
      if (convLink) {
        convLink.addEventListener('click', function () {
          var conversationId = it.conversationId;
          closeLightbox();
          setTab('conversations');
          state.query = '';
          state.mediaFilter = 'all';
          if (elements.searchInput) elements.searchInput.value = '';
          if (elements.mediaFilter) elements.mediaFilter.value = 'all';
          state.selectedId = conversationId;
          renderList();
          renderDetail();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        });
      }
    }
    function setTab(tab) {
      state.tab = tab;
      document.getElementById('panel-conversations').hidden = tab !== 'conversations';
      document.getElementById('panel-media').hidden = tab !== 'media';
      document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-tab') === tab); });
      if (tab === 'media' && !state.mediaRendered) {
        state.mediaRendered = true;
        renderMediaFilters();
        renderMediaGrid();
      }
      window.scrollTo({ top: 0 });
    }
    elements.searchInput.addEventListener('input', (event) => { state.query = event.target.value || ''; renderList(); renderDetail(); });
    elements.clearSearch.addEventListener('click', function () { state.query = ''; elements.searchInput.value = ''; renderList(); renderDetail(); elements.searchInput.focus(); });
    elements.sortSelect.addEventListener('change', (event) => { state.sort = event.target.value || 'updated-desc'; renderList(); renderDetail(); });
    elements.kindFilter.addEventListener('change', (event) => { state.kindFilter = event.target.value || 'all'; renderList(); renderDetail(); });
    elements.mediaFilter.addEventListener('change', (event) => { state.mediaFilter = event.target.value || 'all'; renderList(); renderDetail(); });
    elements.conversationStatusFilter.addEventListener('change', (event) => { state.conversationStatusFilter = event.target.value || 'all'; renderList(); renderDetail(); });
    elements.mediaSearchInput.addEventListener('input', (event) => { state.mediaQuery = event.target.value || ''; renderMediaGrid(); });
    elements.clearMediaSearch.addEventListener('click', function () { state.mediaQuery = ''; elements.mediaSearchInput.value = ''; renderMediaGrid(); elements.mediaSearchInput.focus(); });
    elements.mediaSortSelect.addEventListener('change', function (event) { state.mediaSort = event.target.value || 'newest'; renderMediaGrid(); });
    elements.mediaStatusFilter.addEventListener('change', function (event) { state.mediaStatus = event.target.value || 'all'; renderMediaGrid(); });
    elements.mediaSourceFilter.addEventListener('change', function (event) { state.mediaSource = event.target.value || 'all'; renderMediaGrid(); });
    document.querySelectorAll('.tab').forEach(function (t) { t.addEventListener('click', function () { setTab(t.getAttribute('data-tab')); }); });
    document.getElementById('lbClose').addEventListener('click', closeLightbox);
    document.getElementById('lbPrev').addEventListener('click', function () { lbStep(-1); });
    document.getElementById('lbNext').addEventListener('click', function () { lbStep(1); });
    document.getElementById('lightbox').addEventListener('click', function (event) { if (event.target.id === 'lightbox') closeLightbox(); });
    document.addEventListener('keydown', function (event) {
      if (document.getElementById('lightbox').hidden) return;
      if (event.key === 'ArrowLeft') lbStep(-1);
      else if (event.key === 'ArrowRight') lbStep(1);
      else if (event.key === 'Escape') closeLightbox();
    });
    var scrollTopBtn = document.getElementById('scrollTop');
    window.addEventListener('scroll', function () { scrollTopBtn.hidden = window.scrollY < 320; });
    scrollTopBtn.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
    state.mediaType = 'all';
    document.getElementById('mediaTabCount').textContent = String(MEDIA_ITEMS.length);
    renderHealth();
    renderList();
    renderDetail();
    setupMaintenance();
  </script>
</body>
</html>`;

  const markerIndex = html.indexOf(viewerDataMarker);
  if (markerIndex < 0) {
    throw new Error('Venice repository viewer data marker was not found.');
  }

  return new Blob([
    html.slice(0, markerIndex),
    ...buildRepositoryViewerDataParts(viewerData),
    html.slice(markerIndex + viewerDataMarker.length)
  ], { type: 'text/html' });
}

function buildRepositoryViewerDataParts(viewerData) {
  const parts = ['const VIEWER_DATA = {'];
  parts.push('rootManifest:', serializeForInlineScript(viewerData?.rootManifest ?? null), ',');
  parts.push('exportManifest:', serializeForInlineScript(viewerData?.exportManifest ?? null), ',');
  parts.push('conversations:');
  appendInlineJsonArrayExpression(parts, viewerData?.conversations);
  parts.push(',messages:');
  appendInlineJsonArrayExpression(parts, viewerData?.messages);

  const media = viewerData?.media && typeof viewerData.media === 'object'
    ? viewerData.media
    : {};
  const mediaMeta = { ...media };
  delete mediaMeta.items;
  parts.push(',media:Object.assign(');
  parts.push(serializeForInlineScript(mediaMeta));
  parts.push(',{items:');
  appendInlineJsonArrayExpression(parts, media.items);
  parts.push('}),unresolvedMedia:');
  appendInlineJsonArrayExpression(parts, viewerData?.unresolvedMedia);
  parts.push('};');
  return parts;
}

function appendInlineJsonArrayExpression(parts, items, chunkSize = 64) {
  const values = Array.isArray(items) ? items : [];
  parts.push('[].concat(');
  if (!values.length) {
    parts.push('[]');
  } else {
    for (let start = 0; start < values.length; start += chunkSize) {
      if (start > 0) {
        parts.push(',');
      }
      parts.push(serializeForInlineScript(values.slice(start, start + chunkSize)));
    }
  }
  parts.push(')');
}

function buildInlinePayloadHtmlBlob(html, marker, appendPayloadParts) {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Venice HTML payload marker was not found: ${marker}`);
  }
  const payloadParts = [];
  appendPayloadParts(payloadParts);
  return new Blob([
    html.slice(0, markerIndex),
    ...payloadParts,
    html.slice(markerIndex + marker.length)
  ], { type: 'text/html' });
}

function buildRepositoryExportManifest({ archive, exportId, finishedAt, fileIntegrity, conversationArtifacts, indexes, supplementalRecords, sourceStoreArtifacts = [], writePlan, previousManifest, writeStats }) {
  const repository = getArchiveRepositoryUtilities();
  const coverage = globalThis.VeniceArchiveCoverage;
  const currentConversationIds = conversationArtifacts.map((artifact) => artifact.id);
  const tombstonedConversationIds = repository.getTombstonedConversationIds(previousManifest?.records?.conversations, currentConversationIds);
  const tombstonedSourceStoreNames = coverage?.getTombstonedSourceStoreNames(
    previousManifest?.records?.sourceStores,
    sourceStoreArtifacts.map((store) => store.name)
  ) || [];
  const failedMediaCount = indexes.materializedMedia.filter((item) => item.status === 'failed').length;
  const warnings = [];

  if (indexes.unresolvedMedia.length) {
    warnings.push(`${formatNumber(indexes.unresolvedMedia.length)} media record${indexes.unresolvedMedia.length === 1 ? ' is' : 's are'} unresolved. Review indexes/unresolved-media.json for details.`);
  }

  if (failedMediaCount) {
    warnings.push(`${formatNumber(failedMediaCount)} media fetch or materialization attempt${failedMediaCount === 1 ? '' : 's'} failed during this export.`);
  }

  return {
    schemaVersion: repository.REPOSITORY_SCHEMA_VERSION,
    exportId,
    startedAt: archive.exportedAt,
    finishedAt,
    status: 'committed',
    mode: previousManifest ? 'derived-refresh' : 'initial-derived-export',
    sourceInventory: {
      dbVersion: archive.source?.dbVersion || null,
      protocolVersion: archive.source?.protocolVersion || null
    },
    storeManifests: archive.storeManifests || [],
    changes: {
      conversationsAdded: writePlan?.conversationsAdded ?? 0,
      conversationsChanged: writePlan?.conversationsChanged ?? 0,
      conversationsSkipped: writePlan?.conversationsSkipped ?? 0,
      conversationsWritten: writeStats?.conversationsWritten ?? conversationArtifacts.length,
      conversationsUnchanged: writeStats?.conversationsUnchanged ?? 0,
      messagesWritten: indexes.messageCount,
      filesSkipped: writeStats?.filesSkipped ?? 0,
      sourceStoresWritten: writeStats?.sourceStoresWritten ?? sourceStoreArtifacts.length,
      sourceStoresUnchanged: writeStats?.sourceStoresUnchanged ?? 0,
      sourceStoresTombstoned: tombstonedSourceStoreNames.length,
      tombstonedSourceStoreNames,
      unchanged: null,
      tombstoned: tombstonedConversationIds.length,
      tombstonedConversationIds
    },
    media: {
      plannedMaterialized: writePlan?.materializedMedia ?? 0,
      plannedDeduped: writePlan?.dedupedMedia ?? 0,
      materialized: indexes.materializedMedia.filter((item) => item.status === 'materialized').length,
      deduped: indexes.materializedMedia.filter((item) => item.status === 'deduped').length,
      unresolved: indexes.unresolvedMedia.length,
      skipped: 0,
      failed: failedMediaCount,
      referenced: archive.mediaIndex?.totals?.total || 0
    },
    recordFingerprints: {
      settings: Object.values(supplementalRecords.settings || {}).reduce((total, group) => total + Object.keys(group || {}).length, 0),
      studio: Object.values(supplementalRecords.studio || {}).reduce((total, group) => total + Object.keys(group || {}).length, 0),
      unresolvedMedia: Object.keys(supplementalRecords.unresolvedMedia || {}).length
    },
    integrity: fileIntegrity,
    warnings,
    errors: []
  };
}

function buildRepositoryRootManifest({ archive, exportId, finishedAt, conversationArtifacts, indexes, supplementalRecords, sourceStoreArtifacts = [], previousManifest, exportManifest }) {
  const repository = getArchiveRepositoryUtilities();
  const coverage = globalThis.VeniceArchiveCoverage;
  const archiveId = previousManifest?.archiveId || `venice-archive-${archive.exportedAt.replace(/[:.]/g, '-').slice(0, 19)}`;
  const conversationRecords = repository.buildConversationManifestRecords(
    conversationArtifacts.map((artifact) => ({
      id: artifact.id,
      title: artifact.title,
      recordHash: artifact.recordHash || null,
      jsonPath: artifact.paths.json,
      markdownPath: artifact.paths.markdown,
      updatedAt: artifact.json.updatedAt
    })),
    previousManifest?.records?.conversations,
    finishedAt
  );
  const sourceStoreRecords = coverage?.buildSourceStoreManifestRecords(
    sourceStoreArtifacts,
    previousManifest?.records?.sourceStores,
    finishedAt
  ) || {};

  return {
    schemaVersion: repository.REPOSITORY_SCHEMA_VERSION,
    archiveId,
    createdAt: previousManifest?.createdAt || archive.exportedAt,
    updatedAt: finishedAt,
    latestExportId: exportId,
    source: {
      app: 'venice.ai',
      databaseName: 'venice-db-encrypted',
      databaseVersion: archive.source?.dbVersion || null,
      keyFingerprint: archive.keyFingerprint || null
    },
    generatedBy: {
      ...archive.generatedBy,
      protocolVersion: archive.source?.protocolVersion || EXPECTED_PAGE_PROTOCOL_VERSION
    },
    totals: {
      conversations: conversationArtifacts.length,
      messages: indexes.messageCount,
      mediaFiles: new Set(
        indexes.media.items
          .filter((item) => item?.path)
          .map((item) => item.sha256 || item.path)
      ).size,
      unresolvedMedia: indexes.unresolvedMedia.length,
      sourceStores: sourceStoreArtifacts.length,
      sourceRecords: sourceStoreArtifacts.reduce((total, store) => total + Number(store.count || 0), 0),
      exports: (previousManifest?.totals?.exports || 0) + 1
    },
    records: {
      conversations: conversationRecords,
      settings: supplementalRecords.settings,
      studio: supplementalRecords.studio,
      unresolvedMedia: supplementalRecords.unresolvedMedia,
      sourceStores: sourceStoreRecords
    },
    indexes: { ...repository.INDEX_FILES },
    verification: {
      status: (exportManifest.media?.unresolved || exportManifest.media?.failed) ? 'incomplete' : 'verified',
      verifiedAt: finishedAt,
      warnings: exportManifest.warnings
    }
  };
}

function normalizeArchiveTimestamp(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 1000000000000 ? value : value * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function capitalizeLabel(value) {
  const normalized = cleanOptionalText(value) || 'message';
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

async function buildArchive(response, options) {
  const manifest = chrome.runtime.getManifest();
  const fullData = response.data || {};
  const coverage = globalThis.VeniceArchiveCoverage;
  const sourceStores = coverage?.getSourceStores(fullData) || {};
  const exportedAt = new Date().toISOString();
  const preview = buildSnapshotModel({
    ...response,
    data: encryptedMode ? {} : fullData
  });

  const archiveMediaItems = options.includeMediaManifest
    ? sanitizeMediaItems(preview.mediaItems || [], !encryptedMode)
    : [];

  const archiveConversationIndex = buildArchiveConversationIndex(preview.conversationIndex || [], !encryptedMode);
  const keyVault = options.includeKeyVault ? normalizeKeyVault(currentState?.keyVault || {}) : {};
  const storeManifests = await buildStoreManifests(sourceStores, response.diagnostics?.fetchedStores || []);

  const archive = {
    version: ARCHIVE_SCHEMA_VERSION,
    archiveType: 'venice-history-archive',
    format: encryptedMode ? 'encrypted' : 'decrypted',
    exportedAt,
    keyFingerprint: response.keyFingerprint || currentState?.keyFingerprint || null,
    generatedBy: {
      extensionName: manifest.name,
      extensionVersion: manifest.version,
      page: 'backup.html'
    },
    source: {
      protocolVersion: EXPECTED_PAGE_PROTOCOL_VERSION,
      dbVersion: response.diagnostics?.sourceDbVersion || null
    },
    stats: {
      conversations: fullData.conversations?.length || preview.stats?.conversationCount || 0,
      messages: fullData.messages?.length || preview.stats?.messageCount || 0,
      images: preview.stats?.imageCount || 0,
      videos: preview.stats?.videoCount || 0,
      media: preview.stats?.mediaCount || 0,
      messageImageRecords: fullData.messageImages?.length || 0,
      orphans: preview.stats?.orphanCount || 0,
      folders: fullData.folders?.length || 0,
      characters: fullData.characters?.length || 0,
      personas: fullData.personas?.length || 0,
      userSystemPrompts: fullData.userSystemPrompts?.length || 0,
      sourceStores: storeManifests.length,
      sourceRecords: storeManifests.reduce((total, store) => total + Number(store.count || 0), 0)
    },
    archiveSummary: {
      readableGuideIncluded: options.includeHtmlReport,
      mediaManifestIncluded: options.includeMediaManifest,
      mediaGalleryIncluded: options.includeMediaGallery,
      keyVaultIncluded: options.includeKeyVault,
      snapshotCapturedAt: preview.capturedAt || null,
      estimatedSourceBytes: preview.estimatedSizeBytes || 0,
      conversationIndexCount: archiveConversationIndex.length,
      sourceStoreCount: storeManifests.length
    },
    storeManifests,
    conversationIndex: archiveConversationIndex,
    mediaIndex: {
      totals: summarizeMediaItems(preview.mediaItems || []),
      items: archiveMediaItems
    },
    keyVault,
    data: {
      conversations: fullData.conversations || [],
      messages: fullData.messages || [],
      messageIds: fullData.messageIds || [],
      messageImages: fullData.messageImages || [],
      studioImageSessions: fullData.studioImageSessions || [],
      studioImageTurns: fullData.studioImageTurns || [],
      studioImageTurnMedia: fullData.studioImageTurnMedia || [],
      studioAudioSessions: fullData.studioAudioSessions || [],
      studioAudioTurns: fullData.studioAudioTurns || [],
      studioAudioTurnMedia: fullData.studioAudioTurnMedia || [],
      studioVideoSessions: fullData.studioVideoSessions || [],
      videoEditorSessions: fullData.videoEditorSessions || [],
      videoStudioActiveGenerations: fullData.videoStudioActiveGenerations || [],
      videoStudioLocalState: fullData.videoStudioLocalState || [],
      folders: fullData.folders || [],
      characters: fullData.characters || [],
      personas: fullData.personas || [],
      settings: fullData.settings || [],
      textSettings: fullData.textSettings || [],
      imageSettings: fullData.imageSettings || [],
      encryptionSettings: fullData.encryptionSettings || [],
      userSystemPrompts: fullData.userSystemPrompts || [],
      supportBotThreads: fullData.supportBotThreads || [],
      supportBotMessages: fullData.supportBotMessages || [],
      pinnedMessages: fullData.pinnedMessages || [],
      browserLocalStorage: fullData.browserLocalStorage || [],
      browserSessionStorage: fullData.browserSessionStorage || [],
      rxConversations: fullData.rxConversations || [],
      rxMessages: fullData.rxMessages || [],
      rxMessageImages: fullData.rxMessageImages || [],
      messageAudioAttachments: fullData.messageAudioAttachments || [],
      messageFileAttachments: fullData.messageFileAttachments || [],
      messageImageAttachments: fullData.messageImageAttachments || [],
      messageVideoAttachments: fullData.messageVideoAttachments || [],
      mindConversations: fullData.mindConversations || [],
      mindMessages: fullData.mindMessages || [],
      mindMedia: fullData.mindMedia || [],
      mindAttachments: fullData.mindAttachments || [],
      messageVideos: fullData.messageVideos || [],
      extraStores: fullData.extraStores || {}
    }
  };
  coverage?.attachSourceStores(archive, sourceStores);

  const archivePayloadBlob = buildArchiveJsonBlob(archive);
  archive.integrity = {
    algorithm: 'SHA-256',
    payloadSha256: await digestBlobHex(archivePayloadBlob),
    payloadBytes: archivePayloadBlob.size
  };
  const jsonBlob = buildArchiveJsonBlob(archive);
  const fileIntegrity = {
    algorithm: 'SHA-256',
    sha256: await digestBlobHex(jsonBlob),
    bytes: jsonBlob.size
  };
  archive.integrity.sha256 = fileIntegrity.sha256;
  archive.integrity.bytes = fileIntegrity.bytes;

  return {
    archive,
    jsonBlob,
    fileIntegrity
  };
}

async function buildStoreManifests(sourceStores, fetchedStores) {
  const fetchedStoreMap = new Map(fetchedStores.map((store) => [store.name, store]));
  const coverage = globalThis.VeniceArchiveCoverage;
  const storeEntries = Object.values(sourceStores && typeof sourceStores === 'object' ? sourceStores : {})
    .filter((store) => store && store.name && Array.isArray(store.records))
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));

  const manifests = [];

  for (const store of storeEntries) {
    const name = store.name;
    const value = store.records;
    const storeBlob = buildArrayJsonBlob(value);
    const fetchedStore = fetchedStoreMap.get(name) || null;

    manifests.push({
      name,
      source: store.source || fetchedStore?.source || 'legacy',
      databaseName: store.databaseName || fetchedStore?.databaseName || null,
      physicalStoreName: store.physicalStoreName || fetchedStore?.physicalStoreName || name,
      schemaVersion: store.schemaVersion ?? fetchedStore?.schemaVersion ?? null,
      sourceFingerprint: store.sourceFingerprint || null,
      encrypted: Boolean(store.encrypted),
      path: coverage?.buildSourceStorePath(name) || `stores/store--${name}.json`,
      count: value.length,
      payloadBytes: storeBlob.size,
      sha256: await digestBlobHex(storeBlob),
      approxTransportBytes: fetchedStore?.approxBytesTotal || 0,
      expectedCount: fetchedStore?.expectedCount ?? null,
      dbVersion: fetchedStore?.dbVersion ?? null
    });
  }

  return manifests;
}

function buildArrayJsonBlob(items) {
  const parts = [];
  appendJsonArrayParts(parts, Array.isArray(items) ? items : []);
  return new Blob(parts, { type: 'application/json' });
}

function buildJsonLinesBlob(records) {
  const parts = [];
  (Array.isArray(records) ? records : []).forEach((record, index) => {
    if (index > 0) {
      parts.push('\n');
    }
    parts.push(JSON.stringify(record));
  });
  parts.push('\n');
  return new Blob(parts, { type: 'application/x-ndjson' });
}

function buildRepositoryMediaIndexBlob(media) {
  const value = media && typeof media === 'object' ? media : {};
  const items = Array.isArray(value.items) ? value.items : [];
  const metadata = { ...value };
  delete metadata.items;
  const parts = ['{'];
  Object.entries(metadata).forEach(([key, entry], index) => {
    if (index > 0) {
      parts.push(',');
    }
    parts.push(JSON.stringify(key), ':', JSON.stringify(entry ?? null));
  });
  if (Object.keys(metadata).length) {
    parts.push(',');
  }
  parts.push(JSON.stringify('items'), ':');
  appendJsonArrayParts(parts, items);
  parts.push('}');
  return new Blob(parts, { type: 'application/json' });
}

function buildRepositoryViewerDataBlob(viewerData) {
  const value = viewerData && typeof viewerData === 'object' ? viewerData : {};
  const media = value.media && typeof value.media === 'object' ? value.media : {};
  const mediaItems = Array.isArray(media.items) ? media.items : [];
  const mediaMetadata = { ...media };
  delete mediaMetadata.items;
  const parts = ['{'];
  parts.push(JSON.stringify('generatedAt'), ':', JSON.stringify(value.generatedAt ?? null), ',');
  parts.push(JSON.stringify('conversations'), ':');
  appendJsonArrayParts(parts, Array.isArray(value.conversations) ? value.conversations : []);
  parts.push(',', JSON.stringify('messages'), ':');
  appendJsonArrayParts(parts, Array.isArray(value.messages) ? value.messages : []);
  parts.push(',', JSON.stringify('totals'), ':', JSON.stringify(value.totals ?? {}), ',');
  parts.push(JSON.stringify('media'), ':{');
  Object.entries(mediaMetadata).forEach(([key, entry], index) => {
    if (index > 0) {
      parts.push(',');
    }
    parts.push(JSON.stringify(key), ':', JSON.stringify(entry ?? null));
  });
  if (Object.keys(mediaMetadata).length) {
    parts.push(',');
  }
  parts.push(JSON.stringify('items'), ':');
  appendJsonArrayParts(parts, mediaItems);
  parts.push('}}');
  return new Blob(parts, { type: 'application/json' });
}

function buildArchiveJsonBlob(archive) {
  const data = archive.data || {};
  const archiveWithoutData = { ...archive };
  delete archiveWithoutData.data;

  const prefix = `${JSON.stringify(archiveWithoutData).slice(0, -1)},"data":{`;
  const parts = [prefix];
  const dataEntries = [
    ['conversations', data.conversations || []],
    ['messages', data.messages || []],
    ['messageIds', data.messageIds || []],
    ['messageImages', data.messageImages || []],
    ['studioImageSessions', data.studioImageSessions || []],
    ['studioImageTurns', data.studioImageTurns || []],
    ['studioImageTurnMedia', data.studioImageTurnMedia || []],
    ['studioAudioSessions', data.studioAudioSessions || []],
    ['studioAudioTurns', data.studioAudioTurns || []],
    ['studioAudioTurnMedia', data.studioAudioTurnMedia || []],
    ['studioVideoSessions', data.studioVideoSessions || []],
    ['videoEditorSessions', data.videoEditorSessions || []],
    ['videoStudioActiveGenerations', data.videoStudioActiveGenerations || []],
    ['videoStudioLocalState', data.videoStudioLocalState || []],
    ['folders', data.folders || []],
    ['characters', data.characters || []],
    ['personas', data.personas || []],
    ['settings', data.settings || []],
    ['textSettings', data.textSettings || []],
    ['imageSettings', data.imageSettings || []],
    ['encryptionSettings', data.encryptionSettings || []],
    ['userSystemPrompts', data.userSystemPrompts || []],
    ['supportBotThreads', data.supportBotThreads || []],
    ['supportBotMessages', data.supportBotMessages || []],
    ['pinnedMessages', data.pinnedMessages || []],
    ['browserLocalStorage', data.browserLocalStorage || []],
    ['browserSessionStorage', data.browserSessionStorage || []],
    ['rxConversations', data.rxConversations || []],
    ['rxMessages', data.rxMessages || []],
    ['rxMessageImages', data.rxMessageImages || []],
    ['messageAudioAttachments', data.messageAudioAttachments || []],
    ['messageFileAttachments', data.messageFileAttachments || []],
    ['messageImageAttachments', data.messageImageAttachments || []],
    ['messageVideoAttachments', data.messageVideoAttachments || []],
    ['mindConversations', data.mindConversations || []],
    ['mindMessages', data.mindMessages || []],
    ['mindMedia', data.mindMedia || []],
    ['mindAttachments', data.mindAttachments || []],
    ['messageVideos', data.messageVideos || []]
  ];

  dataEntries.forEach(([key, value], index) => {
    if (index > 0) {
      parts.push(',');
    }
    parts.push(JSON.stringify(key), ':');
    appendJsonArrayParts(parts, Array.isArray(value) ? value : []);
  });

  parts.push(',"extraStores":{');
  const extraStoreEntries = Object.entries(data.extraStores && typeof data.extraStores === 'object' ? data.extraStores : {})
    .sort(([left], [right]) => left.localeCompare(right));
  extraStoreEntries.forEach(([key, value], index) => {
    if (index > 0) {
      parts.push(',');
    }
    parts.push(JSON.stringify(key), ':');
    appendJsonArrayParts(parts, Array.isArray(value) ? value : []);
  });
  parts.push('}}}');
  return new Blob(parts, { type: 'application/json' });
}

function appendJsonArrayParts(parts, items) {
  parts.push('[');

  items.forEach((item, index) => {
    if (index > 0) {
      parts.push(',');
    }
    parts.push(JSON.stringify(item));
  });

  parts.push(']');
}

function truncateText(value, maxLength = 260) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }

  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function slugify(value, fallback = 'item') {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return normalized || fallback;
}

function formatFileStamp(value) {
  if (!value) {
    return 'undated';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'undated';
  }

  return date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function serializeForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function cleanOptionalText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function firstNonEmptyText(values) {
  for (const value of values) {
    const normalized = cleanOptionalText(value);
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function truncateConversationTitle(value) {
  const normalized = cleanOptionalText(value);
  if (normalized.length <= 120) {
    return normalized;
  }

  return `${normalized.slice(0, 120).trim()}...`;
}

function resolveConversationTitle(conversation, messages = []) {
  const directTitle = firstNonEmptyText([
    conversation?.name,
    conversation?.title,
    conversation?.generatedTitle,
    conversation?.label,
    conversation?.summary
  ]);

  if (directTitle) {
    return truncateConversationTitle(directTitle);
  }

  const messageTitle = firstNonEmptyText(messages.map(extractMessageText));
  if (messageTitle) {
    return truncateConversationTitle(messageTitle);
  }

  return 'Untitled conversation';
}

function getGenerationSettingsKey(kind) {
  if (kind === 'video') {
    return 'videoSettings';
  }

  if (kind === 'audio') {
    return 'audioSettings';
  }

  return 'imageSettings';
}

function getGenerationModelKey(kind) {
  if (kind === 'video') {
    return 'videoModel';
  }

  if (kind === 'audio') {
    return 'audioModel';
  }

  return 'imageModel';
}

function hasGenerationMetadata(record, kind) {
  if (!record || typeof record !== 'object') {
    return false;
  }

  const settingsKey = getGenerationSettingsKey(kind);
  return Boolean(
    cleanOptionalText(record.modelId) ||
    cleanOptionalText(record.modelName) ||
    cleanOptionalText(record.modelType) ||
    (record[settingsKey] && typeof record[settingsKey] === 'object')
  );
}

function selectGenerationMetadataSource(record, message, parentMessage, kind) {
  const candidates = [
    { record, source: 'media-record' },
    { record: message, source: 'linked-message' },
    { record: parentMessage, source: 'prompt-message' }
  ];

  return candidates.find((candidate) => hasGenerationMetadata(candidate.record, kind)) ||
    candidates.find((candidate) => candidate.record) ||
    { record: null, source: null };
}

function resolveGallerySettingsRecord(settingsRecords, ownerCandidates) {
  const candidates = ownerCandidates.map(cleanOptionalText).filter(Boolean);

  for (const candidate of candidates) {
    const matched = settingsRecords.find((record) => record?.ownerId === candidate || record?.id === candidate);
    if (matched) {
      return matched;
    }
  }

  if (settingsRecords.length === 1) {
    return settingsRecords[0];
  }

  return settingsRecords.find((record) => record?.imageSettings?.isDefault || record?.isDefault) || settingsRecords[0] || null;
}

function formatGenerationSettingValue(value) {
  if (value == null) {
    return '';
  }

  if (Array.isArray(value)) {
    return value.map(formatGenerationSettingValue).filter(Boolean).join(', ');
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(value);
  }

  if (typeof value === 'string') {
    return cleanOptionalText(value);
  }

  if (typeof value === 'object') {
    return cleanOptionalText(JSON.stringify(value));
  }

  return '';
}

function pushGenerationSetting(entries, label, value) {
  const formatted = formatGenerationSettingValue(value);
  if (formatted) {
    entries.push({ label, value: formatted });
  }
}

function buildGenerationSettingsEntries(kind, settings) {
  if (!settings || typeof settings !== 'object') {
    return [];
  }

  const entries = [];

  if (kind === 'video') {
    pushGenerationSetting(entries, 'Duration', settings.duration);
    pushGenerationSetting(entries, 'Aspect Ratio', settings.aspectRatio);
    pushGenerationSetting(entries, 'Resolution', settings.resolution);
    pushGenerationSetting(entries, 'Audio', settings.audio);
    pushGenerationSetting(entries, 'Variants', settings.variants);
    return entries;
  }

  if (settings.width || settings.height) {
    pushGenerationSetting(entries, 'Canvas', `${settings.width || '?'} x ${settings.height || '?'}`);
  }

  pushGenerationSetting(entries, 'Aspect Ratio', settings.aspectRatio);
  pushGenerationSetting(entries, 'Resolution', settings.resolution);
  pushGenerationSetting(entries, 'Format', settings.format);
  pushGenerationSetting(entries, 'Steps', Number(settings.steps) === 0 ? 'Auto' : settings.steps);
  pushGenerationSetting(entries, 'CFG Scale', settings.cfgScale);
  pushGenerationSetting(entries, 'Variants', settings.variants);
  pushGenerationSetting(entries, 'Style Preset', cleanOptionalText(settings.stylePreset) === 'None' ? '' : settings.stylePreset);
  pushGenerationSetting(entries, 'Seed', cleanOptionalText(settings.customSeed));
  pushGenerationSetting(entries, 'Creativity', settings.enhanceCreativity);
  pushGenerationSetting(entries, 'Replication', settings.replication);
  pushGenerationSetting(entries, 'Auto Enhance', settings.autoEnhance);
  pushGenerationSetting(entries, 'Upscale Enhance', settings.upscaleEnhance);
  pushGenerationSetting(entries, 'Upscale Scale', Number(settings.upscaleScale) > 1 ? settings.upscaleScale : '');
  pushGenerationSetting(entries, 'Negative Prompt', truncateText(settings.negativePrompt, 140));
  pushGenerationSetting(entries, 'Web Search', settings.enableWebSearch);
  pushGenerationSetting(entries, 'Hide Watermark', settings.hideWatermark);
  return entries;
}

function buildModelLabel(modelName, modelId, modelType) {
  if (modelName && modelId && modelName !== modelId) {
    return `${modelName} (${modelId})`;
  }

  return firstNonEmptyText([modelName, modelId, modelType]);
}

function resolveMediaGenerationMetadata({ record, message, parentMessage, conversation, fullData, kind }) {
  const settingsRecords = Array.isArray(fullData?.settings) ? fullData.settings : [];
  const settingsRecord = resolveGallerySettingsRecord(settingsRecords, [
    record?.ownerId,
    message?.ownerId,
    conversation?.ownerId,
    parentMessage?.ownerId,
    conversation?.id
  ]);

  const metadataSource = selectGenerationMetadataSource(record, message, parentMessage, kind);
  const settingsKey = getGenerationSettingsKey(kind);
  const modelKey = getGenerationModelKey(kind);
  const sourceRecord = metadataSource.record;
  const sourceLabels = {
    'media-record': 'Media record',
    'linked-message': 'Linked message',
    'prompt-message': 'Prompt message',
    'workspace-settings': 'Workspace settings fallback'
  };

  const modelName = cleanOptionalText(sourceRecord?.modelName);
  const modelId = cleanOptionalText(sourceRecord?.modelId) || cleanOptionalText(settingsRecord?.[modelKey]);
  const modelType = cleanOptionalText(sourceRecord?.modelType);
  const modelSourceKey = sourceRecord && (modelName || cleanOptionalText(sourceRecord?.modelId) || modelType)
    ? metadataSource.source
    : (settingsRecord?.[modelKey] ? 'workspace-settings' : null);
  const settingsObject = sourceRecord?.[settingsKey] || settingsRecord?.[settingsKey] || null;
  const settingsSourceKey = sourceRecord?.[settingsKey]
    ? metadataSource.source
    : (settingsRecord?.[settingsKey] ? 'workspace-settings' : null);

  return {
    modelLabel: buildModelLabel(modelName, modelId, modelType),
    modelId,
    modelName,
    modelType,
    modelSourceLabel: sourceLabels[modelSourceKey] || '',
    settingsSourceLabel: sourceLabels[settingsSourceKey] || '',
    settingsEntries: buildGenerationSettingsEntries(kind, settingsObject)
  };
}

function uint8ArrayToBase64(bytes) {
  const parts = [];
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize)));
  }
  return btoa(parts.join(''));
}

function getEmbeddedBinaryPayload(record) {
  if (!record || typeof record !== 'object') {
    return null;
  }

  // Do not use a single nullish-coalescing chain here. Some Venice records
  // have a normal metadata `data` object before the actual `blob`, `file`, or
  // `payload` field. Trying each candidate lets us retain the bytes instead
  // of stopping at that first non-binary value.
  const candidates = [
    record,
    record.contentBinary,
    record.content_binary,
    record.base64,
    record.bytes,
    record.data,
    record.blob,
    record.file,
    record.payload,
    record.result,
    record.value,
    record.body
  ];

  for (const candidate of candidates) {
    let raw = '';
    let wrapperMimeType = null;
    let isStringCandidate = false;
    let isEncodedWrapper = false;
    if (typeof candidate === 'string') {
      raw = candidate.trim();
      isStringCandidate = true;
    } else if (candidate instanceof Uint8Array) {
      raw = uint8ArrayToBase64(candidate);
    } else if (candidate instanceof ArrayBuffer) {
      raw = uint8ArrayToBase64(new Uint8Array(candidate));
    } else if (Array.isArray(candidate) && candidate.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
      raw = uint8ArrayToBase64(new Uint8Array(candidate));
    } else if (
      candidate &&
      typeof candidate === 'object' &&
      candidate.encoding === 'base64' &&
      typeof candidate.data === 'string'
    ) {
      // content-main represents Blob/ArrayBuffer values as bounded transport
      // records so Chrome messaging does not silently turn them into `{}`.
      raw = candidate.data.trim();
      wrapperMimeType = typeof candidate.mimeType === 'string' ? candidate.mimeType : null;
      isEncodedWrapper = true;
    } else if (candidate && typeof candidate === 'object' && typeof candidate.encoded === 'string') {
      raw = candidate.encoded.trim();
      wrapperMimeType = typeof candidate.mimeType === 'string' ? candidate.mimeType : null;
      isEncodedWrapper = true;
    }

    if (!raw || /^(https?:|blob:|\/\/)/i.test(raw)) {
      continue;
    }

    if (raw.startsWith('data:')) {
      const commaIndex = raw.indexOf(',');
      if (commaIndex === -1) {
        continue;
      }

      const header = raw.slice(0, commaIndex);
      if (!/;base64(?:;|$)/i.test(header) || !isValidBase64Payload(raw.slice(commaIndex + 1))) {
        continue;
      }
      const mimeMatch = header.match(/^data:([^;]+)(?:;base64)?$/i);
      return {
        base64: normalizeBase64Payload(raw.slice(commaIndex + 1)),
        mimeType: mimeMatch?.[1] || wrapperMimeType || null
      };
    }

    // A plain `result`/`body` string is often extracted document text, not
    // binary data. Only treat string candidates as embedded bytes when they
    // have a plausible base64 shape; text attachments are handled explicitly
    // by getAttachmentEmbeddedPayload below.
    if (isStringCandidate && !isLikelyBase64Payload(raw)) {
      continue;
    }
    if (isEncodedWrapper && !isValidBase64Payload(raw)) {
      continue;
    }

    return {
      base64: normalizeBase64Payload(raw),
      mimeType: wrapperMimeType
    };
  }

  return null;
}

function normalizeBase64Payload(value) {
  let normalized = String(value || '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!normalized) {
    return '';
  }
  if (normalized.length % 4 === 1) {
    return normalized;
  }
  while (normalized.length % 4) {
    normalized += '=';
  }
  return normalized;
}

function decodeBase64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function decodeBase64HeaderBytes(base64, byteCount = 64) {
  const safeBase64 = String(base64 || '').replace(/\s+/g, '');
  if (!safeBase64) {
    return new Uint8Array();
  }

  const requiredChars = Math.max(4, Math.ceil(byteCount / 3) * 4);
  const snippet = safeBase64.slice(0, requiredChars);
  return decodeBase64ToUint8Array(snippet);
}

function sniffMimeTypeFromBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return null;
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
    bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A
  ) {
    return 'image/png';
  }

  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return 'image/jpeg';
  }

  if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
  ) {
    return 'image/gif';
  }

  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
  ) {
    return 'video/mp4';
  }

  if (bytes.length >= 4 && bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) {
    return 'video/webm';
  }

  const textHeader = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 64)).trim().toLowerCase();
  if (textHeader.startsWith('<svg') || textHeader.includes('<svg')) {
    return 'image/svg+xml';
  }

  return null;
}

function inferMimeTypeFromBase64(base64, fallbackMimeType) {
  try {
    return sniffMimeTypeFromBytes(decodeBase64HeaderBytes(base64)) || fallbackMimeType || null;
  } catch {
    return fallbackMimeType || null;
  }
}

function defaultMimeTypeForKind(kind) {
  if (globalThis.VeniceArchiveRepository?.defaultMimeTypeForKind) {
    return globalThis.VeniceArchiveRepository.defaultMimeTypeForKind(kind);
  }

  switch (kind) {
    case 'image':
      return 'image/webp';
    case 'video':
      return 'video/mp4';
    case 'audio':
      return 'audio/mpeg';
    case 'file':
      return 'application/octet-stream';
    default:
      return 'application/octet-stream';
  }
}

function extensionForMimeType(mimeType, kind = 'asset') {
  if (globalThis.VeniceArchiveRepository?.extensionForMimeType) {
    return globalThis.VeniceArchiveRepository.extensionForMimeType(mimeType, kind);
  }

  const normalized = String(mimeType || '').toLowerCase();
  const knownExtensions = {
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/tiff': 'tiff',
    'image/webp': 'webp',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-msvideo': 'avi',
    'video/x-matroska': 'mkv',
    'video/ogg': 'ogv',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/flac': 'flac',
    'audio/opus': 'opus',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/csv': 'csv',
    'text/html': 'html',
    'text/xml': 'xml',
    'application/pdf': 'pdf',
    'application/octet-stream': kind === 'image' ? 'bin' : 'bin'
  };

  if (knownExtensions[normalized]) {
    return knownExtensions[normalized];
  }

  if (normalized.includes('/')) {
    return normalized.split('/').pop().replace(/[^a-z0-9.+-]/g, '') || 'bin';
  }

  switch (kind) {
    case 'image':
      return 'webp';
    case 'video':
      return 'mp4';
    case 'audio':
      return 'mp3';
    default:
      return 'bin';
  }
}

function inferMimeTypeFromUrl(url, kind = 'asset') {
  if (globalThis.VeniceArchiveRepository?.inferMimeTypeFromUrl) {
    return globalThis.VeniceArchiveRepository.inferMimeTypeFromUrl(url, kind);
  }

  const normalized = String(url || '').trim().toLowerCase();
  if (!normalized) {
    return defaultMimeTypeForKind(kind);
  }

  if (normalized.startsWith('data:')) {
    const mimeMatch = normalized.match(/^data:([^;,]+)[;,]/i);
    return mimeMatch?.[1] || defaultMimeTypeForKind(kind);
  }

  const pathname = normalized.split('#')[0].split('?')[0];
  const knownMimeTypes = [
    [/\.avif$/i, 'image/avif'],
    [/\.bmp$/i, 'image/bmp'],
    [/\.heic$/i, 'image/heic'],
    [/\.heif$/i, 'image/heif'],
    [/\.tiff?$/i, 'image/tiff'],
    [/\.webp$/i, 'image/webp'],
    [/\.png$/i, 'image/png'],
    [/\.jpe?g$/i, 'image/jpeg'],
    [/\.gif$/i, 'image/gif'],
    [/\.svg$/i, 'image/svg+xml'],
    [/\.mp4$/i, 'video/mp4'],
    [/\.webm$/i, 'video/webm'],
    [/\.mov$/i, 'video/quicktime'],
    [/\.m4v$/i, 'video/x-m4v'],
    [/\.avi$/i, 'video/x-msvideo'],
    [/\.mkv$/i, 'video/x-matroska'],
    [/\.ogv$/i, 'video/ogg'],
    [/\.mp3$/i, 'audio/mpeg'],
    [/\.wav$/i, 'audio/wav'],
    [/\.ogg$/i, 'audio/ogg'],
    [/\.m4a$/i, 'audio/mp4'],
    [/\.aac$/i, 'audio/aac'],
    [/\.flac$/i, 'audio/flac'],
    [/\.opus$/i, 'audio/opus'],
    [/\.pdf$/i, 'application/pdf']
  ];

  for (const [pattern, mimeType] of knownMimeTypes) {
    if (pattern.test(pathname)) {
      return mimeType;
    }
  }

  return defaultMimeTypeForKind(kind);
}

function buildGalleryRelativePath({ kind, mimeType, createdAt, sequence, conversationTitle, displayTitle, recordId }) {
  return `media/${slugify(kind, 'asset')}/${formatFileStamp(createdAt)}-${String(sequence).padStart(4, '0')}-${slugify(conversationTitle || displayTitle, 'conversation')}-${slugify(recordId, 'media')}.${extensionForMimeType(mimeType, kind)}`;
}

function updateGalleryItemPathForMimeType(item, mimeType) {
  if (!item || !item.localPath) {
    return;
  }

  const extension = extensionForMimeType(mimeType, item.kind);
  item.localPath = item.localPath.replace(/\.[^.\/]+$/, `.${extension}`);
}

function buildGalleryItemRecord({
  record = null,
  recordIndex = null,
  sourceStore = null,
  recordId,
  message = null,
  parentMessage = null,
  conversation = null,
  conversationId = null,
  sourceUrl = null,
  embeddedPayload = null,
  explicitMimeType = null,
  kind,
  source,
  approxBytes = null,
  inline = false,
  orphaned = false,
  settingsRecords = [],
  contextTitle = '',
  contextText = '',
  createdAtUnix = null,
  updatedAtUnix = null,
  sequence = 1
}) {
  const conversationTitle = firstNonEmptyText([conversation?.title, contextTitle]);
  const fallbackText = truncateText(contextText, 260);
  const promptText = truncateText(firstNonEmptyText([extractMessageText(parentMessage), fallbackText]), 260);
  const messageText = truncateText(firstNonEmptyText([extractMessageText(message), fallbackText]), 260);
  const generationMetadata = resolveMediaGenerationMetadata({
    record,
    message,
    parentMessage,
    conversation,
    fullData: { settings: settingsRecords },
    kind
  });
  const displayTitle = firstNonEmptyText([
    conversationTitle,
    promptText,
    messageText,
    generationMetadata.modelLabel,
    recordId
  ]);
  const mimeType = embeddedPayload
    ? (inferMimeTypeFromBase64(embeddedPayload.base64 || '', explicitMimeType || inferMimeTypeFromUrl(sourceUrl, kind)) || defaultMimeTypeForKind(kind))
    : (explicitMimeType || inferMimeTypeFromUrl(sourceUrl, kind) || defaultMimeTypeForKind(kind));
  const localPath = embeddedPayload || sourceUrl
    ? buildGalleryRelativePath({
        kind,
        mimeType,
        createdAt: createdAtUnix || updatedAtUnix,
        sequence,
        conversationTitle,
        displayTitle,
        recordId
      })
    : null;
  const settingsSearchText = generationMetadata.settingsEntries.map((entry) => `${entry.label} ${entry.value}`).join(' ');

  const item = {
    id: recordId,
    recordIndex,
    sourceStore,
    source,
    messageId: message?.id || record?.messageId || null,
    conversationId,
    conversationTitle,
    displayTitle,
    promptText,
    messageText,
    caption: firstNonEmptyText([promptText, messageText, conversationTitle]),
    createdAt: createdAtUnix ? new Date(createdAtUnix).toISOString() : null,
    updatedAt: updatedAtUnix ? new Date(updatedAtUnix).toISOString() : null,
    kind,
    mimeType,
    localPath,
    sourceUrl: sourceUrl || null,
    exportable: Boolean(localPath),
    inline: Boolean(inline || embeddedPayload || (typeof sourceUrl === 'string' && sourceUrl.startsWith('data:'))),
    orphaned: Boolean(orphaned || !conversationId),
    sizeBytes: approxBytes || null,
    modelLabel: generationMetadata.modelLabel,
    modelId: generationMetadata.modelId,
    modelName: generationMetadata.modelName,
    modelType: generationMetadata.modelType,
    modelSourceLabel: generationMetadata.modelSourceLabel,
    settingsSourceLabel: generationMetadata.settingsSourceLabel,
    generationSettings: generationMetadata.settingsEntries,
    searchText: [
      displayTitle,
      conversationTitle,
      promptText,
      messageText,
      recordId,
      message?.id || record?.messageId || '',
      conversationId || '',
      source || '',
      sourceUrl || '',
      generationMetadata.modelLabel,
      generationMetadata.modelId,
      generationMetadata.modelName,
      generationMetadata.modelType,
      generationMetadata.modelSourceLabel,
      generationMetadata.settingsSourceLabel,
      settingsSearchText,
      mimeType,
      kind
    ].join(' ').toLowerCase()
  };

  // Keep the decoded payload available to the materializer without embedding
  // the potentially multi-megabyte base64 value in viewer/index metadata.
  if (embeddedPayload?.base64) {
    Object.defineProperty(item, '__embeddedPayload', {
      configurable: true,
      enumerable: false,
      value: embeddedPayload
    });
  }
  return item;
}

function buildMediaGalleryItems(fullData) {
  const conversationsById = new Map((fullData.conversations || []).map((conversation) => [conversation.id, conversation]));
  const messagesById = new Map((fullData.messages || []).map((message) => [message.id, message]));
  const settingsRecords = Array.isArray(fullData.settings) ? fullData.settings : [];
  const studioContextMaps = buildStudioContextMaps(fullData);
  const items = [];
  const seen = new Set();
  let sequence = 0;

  const addItem = (item) => {
    if (!item) {
      return;
    }

    const dedupeKey = item.sourceUrl
      ? [item.kind, item.sourceUrl].join('|')
      : [item.kind, item.sourceStore || item.source || '', item.recordIndex != null ? `record:${item.recordIndex}` : item.id || ''].join('|');

    if (seen.has(dedupeKey)) {
      return;
    }

    seen.add(dedupeKey);
    items.push(item);
  };

  (fullData.messageImages || []).forEach((record, index) => {
    const message = messagesById.get(record.messageId) || null;
    const parentMessage = message?.parentMessageId ? messagesById.get(message.parentMessageId) || null : null;
    const conversationId = record.conversationId || message?.conversationId || null;
    const conversation = conversationId ? conversationsById.get(conversationId) || null : null;
    const embeddedPayload = getEmbeddedBinaryPayload(record);
    const sourceUrl = getMediaUrl(record);
    const explicitMimeType = getMimeType(record);
    const inferredKind = classifyMediaKind({ ...(record || {}), url: sourceUrl, mimeType: explicitMimeType });
    const kind = inferredKind === 'asset'
      ? (record.__mediaDefaultKind || (embeddedPayload ? 'image' : 'file'))
      : inferredKind;
    const createdAtUnix = message?.createdAtUnixTimestamp || record.createdAtUnixTimestamp || null;
    const updatedAtUnix = message?.updatedAtUnixTimestamp || record.updatedAtUnixTimestamp || createdAtUnix || null;
    const recordId = record.id || record.messageId || `message-image-${index + 1}`;

    addItem(buildGalleryItemRecord({
      record,
      recordIndex: index,
      sourceStore: 'messageImages',
      recordId,
      message,
      parentMessage,
      conversation,
      conversationId,
      sourceUrl,
      embeddedPayload,
      explicitMimeType,
      kind,
      source: 'messageImages',
      approxBytes: detectApproxBytes(record),
      inline: Boolean(embeddedPayload),
      orphaned: !conversationId,
      settingsRecords,
      createdAtUnix,
      updatedAtUnix,
      sequence: ++sequence
    }));
  });

  (fullData.messages || []).forEach((message) => {
    const parentMessage = message?.parentMessageId ? messagesById.get(message.parentMessageId) || null : null;
    const conversationId = message?.conversationId || null;
    const conversation = conversationId ? conversationsById.get(conversationId) || null : null;

    extractMessageMediaCandidates(message).forEach((candidate, index) => {
      const sourceUrl = candidate.url || null;
      const kind = candidate.kind === 'asset'
        ? (sourceUrl || candidate.inline ? 'file' : 'asset')
        : candidate.kind;

      if (kind === 'asset' || (!sourceUrl && !candidate.inline)) {
        return;
      }

      const recordId = candidate.id || `${message.id || 'message'}-${kind}-${index + 1}`;
      const createdAtUnix = message?.createdAtUnixTimestamp || null;
      const updatedAtUnix = message?.updatedAtUnixTimestamp || createdAtUnix || null;

      addItem(buildGalleryItemRecord({
        record: null,
        recordIndex: null,
        sourceStore: null,
        recordId,
        message,
        parentMessage,
        conversation,
        conversationId: candidate.conversationId || conversationId,
        sourceUrl,
        embeddedPayload: candidate.embeddedPayload || null,
        explicitMimeType: candidate.mimeType || inferMimeTypeFromUrl(sourceUrl, kind),
        kind,
        source: candidate.source || 'message',
        approxBytes: candidate.approxBytes || null,
        inline: candidate.inline,
        orphaned: candidate.messageId ? !messagesById.has(candidate.messageId) : !conversationId,
        settingsRecords,
        createdAtUnix,
        updatedAtUnix,
        sequence: ++sequence
      }));
    });
  });

  STUDIO_MEDIA_STORE_CONFIGS.forEach((config) => {
    const records = Array.isArray(fullData[config.dataKey]) ? fullData[config.dataKey] : [];

    records.forEach((record, index) => {
      const embeddedPayload = getEmbeddedBinaryPayload(record);
      const sourceReferences = collectRecordMediaReferenceEntries(record);
      const context = resolveStudioMediaContext(record, config, studioContextMaps);
      const turn = context.turn;
      const session = context.session;

      if (!sourceReferences.length && !embeddedPayload && config.metadataOnlyIsMedia === false) {
        return;
      }

      const contextTitle = firstNonEmptyText([
        session?.title,
        session?.name,
        turn?.title,
        turn?.name,
        record?.title,
        record?.name
      ]);
      const contextText = firstNonEmptyText([
        record?.prompt,
        record?.promptText,
        turn?.prompt,
        turn?.promptText,
        session?.prompt,
        session?.promptText,
        record?.description,
        turn?.description,
        session?.description,
        record?.caption,
        turn?.caption,
        session?.caption,
        extractMessageText(record),
        extractMessageText(turn),
        extractMessageText(session)
      ]);
      const candidateReferences = sourceReferences.length ? sourceReferences : [{ url: null, keyHint: '' }];

      candidateReferences.forEach(({ url: sourceUrl, keyHint }, candidateIndex) => {
        const inferredKind = classifyMediaKind({ ...(record || {}), type: keyHint || record?.type, url: sourceUrl, mimeType: getMimeType(record) });
        const kind = inferredKind === 'asset' ? config.defaultKind : inferredKind;
        const recordId = record?.id
          ? `${record.id}${candidateIndex ? `-${candidateIndex + 1}` : ''}`
          : `${config.dataKey}-${index + 1}${candidateIndex ? `-${candidateIndex + 1}` : ''}`;

        addItem(buildGalleryItemRecord({
          record,
          recordIndex: index,
          sourceStore: config.sourceStore,
          recordId,
          message: turn,
          parentMessage: session,
          conversation: null,
          conversationId: context.conversationId,
          sourceUrl,
          embeddedPayload,
          explicitMimeType: getMimeType(record) || (sourceUrl ? inferMimeTypeFromUrl(sourceUrl, kind) : null),
          kind,
          source: `${config.sourceLabel}${sourceUrl ? '.reference' : '.embedded'}`,
          approxBytes: detectApproxBytes(record),
          inline: Boolean(embeddedPayload || (typeof sourceUrl === 'string' && sourceUrl.startsWith('data:'))),
          orphaned: !(context.conversationId || turn || session),
          settingsRecords,
          contextTitle,
          contextText,
          createdAtUnix: context.createdAtUnix,
          updatedAtUnix: context.updatedAtUnix || context.createdAtUnix,
          sequence: ++sequence
        }));
      });
    });
  });

  extractGenericStoreMediaCandidates(fullData).forEach((candidate) => {
    const records = fullData.extraStores?.[candidate.sourceStore];
    const record = Array.isArray(records) ? records[candidate.recordIndex] : null;
    const message = candidate.messageId ? messagesById.get(candidate.messageId) || null : null;
    const parentMessage = message?.parentMessageId ? messagesById.get(message.parentMessageId) || null : null;
    const conversation = candidate.conversationId ? conversationsById.get(candidate.conversationId) || null : null;
    const contextTitle = firstNonEmptyText([record?.title, record?.name, record?.filename, record?.fileName]);
    const contextText = firstNonEmptyText([
      record?.prompt,
      record?.promptText,
      record?.caption,
      record?.description,
      extractMessageText(record)
    ]);
    const createdAtUnix = getFirstDefinedNumber(record, ['createdAtUnixTimestamp', 'createdAt', 'timestamp']) || message?.createdAtUnixTimestamp || null;
    const updatedAtUnix = getFirstDefinedNumber(record, ['updatedAtUnixTimestamp', 'updatedAt', 'timestamp']) || message?.updatedAtUnixTimestamp || createdAtUnix || null;

    addItem(buildGalleryItemRecord({
      record,
      recordIndex: candidate.recordIndex,
      sourceStore: candidate.sourceStore,
      recordId: candidate.id,
      message,
      parentMessage,
      conversation,
      conversationId: candidate.conversationId || message?.conversationId || null,
      sourceUrl: candidate.url,
      embeddedPayload: candidate.embeddedPayload,
      explicitMimeType: candidate.mimeType,
      kind: candidate.kind || 'file',
      source: candidate.source,
      approxBytes: candidate.approxBytes,
      inline: candidate.inline,
      orphaned: candidate.orphaned,
      settingsRecords,
      contextTitle,
      contextText,
      createdAtUnix,
      updatedAtUnix,
      sequence: ++sequence
    }));
  });

  items.sort((left, right) => {
    const rightTime = right.updatedAt ? new Date(right.updatedAt).getTime() : 0;
    const leftTime = left.updatedAt ? new Date(left.updatedAt).getTime() : 0;
    return rightTime - leftTime;
  });

  return {
    items,
    exportedCount: items.filter((item) => item.exportable).length,
    linkedOnlyCount: items.filter((item) => !item.exportable && item.sourceUrl).length,
    totalBytes: items.reduce((total, item) => total + Number(item.sizeBytes || 0), 0)
  };
}

async function fetchMediaBlobFromVenice(item, tab) {
  if (!item?.sourceUrl) {
    return null;
  }

  const chunks = [];
  let cacheKey = null;
  let offset = 0;
  let mimeType = item.mimeType || defaultMimeTypeForKind(item.kind);

  try {
    while (true) {
      const response = await requestMediaResourceChunk(tab, {
        url: item.sourceUrl,
        cacheKey,
        offset,
        chunkSize: MEDIA_FETCH_CHUNK_BYTES,
        maxBytes: MEDIA_FETCH_MAX_BYTES
      });

      cacheKey = response.cacheKey || cacheKey;
      mimeType = response.mimeType || mimeType;

      if (response.chunkBase64) {
        const bytes = decodeBase64ToUint8Array(response.chunkBase64);
        if (bytes.length) {
          chunks.push(bytes);
        }
        offset = response.nextOffset || (offset + bytes.length);
      }

      if (response.done) {
        break;
      }

      if (!response.chunkBase64) {
        throw new Error('Media fetch returned an empty chunk before completion');
      }
    }
  } catch (pageFetchError) {
    const directBlob = await fetchVeniceMediaDirectly(item.sourceUrl).catch(() => null);
    if (directBlob) {
      return directBlob;
    }
    throw pageFetchError;
  }

  return new Blob(chunks, { type: mimeType || defaultMimeTypeForKind(item.kind) });
}

async function fetchVeniceMediaDirectly(sourceUrl) {
  const url = new URL(sourceUrl);
  const host = url.hostname.toLowerCase();
  if (host !== 'venice.ai' && !host.endsWith('.venice.ai')) {
    return null;
  }
  const response = await fetch(url.href, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`Direct Venice media request failed with status ${response.status}`);
  }
  const declaredBytes = Number(response.headers.get('content-length') || 0);
  if (declaredBytes > MEDIA_FETCH_MAX_BYTES) {
    throw new Error(`Media resource exceeds export limit (${declaredBytes} bytes)`);
  }
  const blob = await response.blob();
  if (blob.size > MEDIA_FETCH_MAX_BYTES) {
    throw new Error(`Media resource exceeds export limit (${blob.size} bytes)`);
  }
  return blob;
}

async function buildMediaBlobFromItem(item, fullData, tab) {
  const sourceRecords = item?.sourceStore && Array.isArray(fullData[item.sourceStore])
    ? fullData[item.sourceStore]
    : (item?.sourceStore && Array.isArray(fullData.extraStores?.[item.sourceStore])
      ? fullData.extraStores[item.sourceStore]
      : (fullData.messageImages || []));
  const record = sourceRecords[item.recordIndex];
  const embeddedPayload = item?.__embeddedPayload || getEmbeddedBinaryPayload(record);

  if (embeddedPayload?.base64) {
    const bytes = decodeBase64ToUint8Array(embeddedPayload.base64);
    const mimeType = sniffMimeTypeFromBytes(bytes) || embeddedPayload.mimeType || item.mimeType || defaultMimeTypeForKind(item.kind);
    return new Blob([bytes], { type: mimeType });
  }

  if (typeof item?.sourceUrl === 'string' && item.sourceUrl.startsWith('data:')) {
    const inlinePayload = getEmbeddedBinaryPayload({ contentBinary: item.sourceUrl });
    if (!inlinePayload?.base64) {
      return null;
    }

    const bytes = decodeBase64ToUint8Array(inlinePayload.base64);
    const mimeType = sniffMimeTypeFromBytes(bytes) || inlinePayload.mimeType || item.mimeType || defaultMimeTypeForKind(item.kind);
    return new Blob([bytes], { type: mimeType });
  }

  if (item?.sourceUrl && tab) {
    return fetchMediaBlobFromVenice(item, tab);
  }

  return null;
}

function summarizeGalleryItems(items) {
  return {
    total: items.length,
    exported: items.filter((item) => item.localPath).length,
    linked: items.filter((item) => !item.localPath && item.sourceUrl).length,
    metadataOnly: items.filter((item) => !item.localPath && !item.sourceUrl).length,
    unresolved: items.filter((item) => !item.localPath).length,
    images: items.filter((item) => item.kind === 'image').length,
    videos: items.filter((item) => item.kind === 'video').length,
    audio: items.filter((item) => item.kind === 'audio').length,
    files: items.filter((item) => item.kind === 'file').length,
    orphaned: items.filter((item) => item.orphaned).length,
    bytes: items.reduce((total, item) => total + Number(item.sizeBytes || 0), 0)
  };
}

async function exportMediaGallery({ tab, fullData, archive, timestamp }) {
  const { items } = buildMediaGalleryItems(fullData);
  if (!items.length) {
    log('No Venice media records were available for companion gallery export.', 'warning');
    return null;
  }

  const folderName = `venice-media-gallery-${timestamp}`;
  const zipFileName = `${folderName}.zip`;
  const indexPath = `${folderName}/index.html`;
  const exportableItems = items.filter((item) => item.localPath);
  const zipEntries = [];

  log(`Preparing media gallery zip: ${zipFileName}`, 'info');
  log(`Media gallery inventory: ${formatNumber(exportableItems.length)} media files scheduled for export`, 'info');

  for (let index = 0; index < exportableItems.length; index++) {
    const item = exportableItems[index];
    let blob = null;

    try {
      blob = await buildMediaBlobFromItem(item, fullData, tab);
    } catch (error) {
      item.localPath = null;
      item.exportable = false;
      item.materializationError = error.message;
      log(`Skipping ${item.kind} ${item.id}: ${error.message}`, 'warning');
      continue;
    }

    if (!blob) {
      item.localPath = null;
      item.exportable = false;
      continue;
    }

    item.mimeType = blob.type || item.mimeType || defaultMimeTypeForKind(item.kind);
    updateGalleryItemPathForMimeType(item, item.mimeType);
    item.exportable = Boolean(item.localPath);
    item.sizeBytes = blob.size || item.sizeBytes || 0;

    setProgress(84 + Math.round(((index + 1) / Math.max(exportableItems.length, 1)) * 9), `Collecting media files (${formatNumber(index + 1)}/${formatNumber(exportableItems.length)})...`);
    zipEntries.push({
      path: `${folderName}/${item.localPath}`,
      data: blob,
      lastModified: item.updatedAt || item.createdAt || Date.now()
    });

    if (index === 0 || (index + 1) % 12 === 0 || index === exportableItems.length - 1) {
      log(`Collected media files: ${formatNumber(index + 1)}/${formatNumber(exportableItems.length)}`, 'info');
    }
  }

  const finalStats = summarizeGalleryItems(items);

  const galleryHtml = buildMediaGalleryExperienceHtml({
    archive,
    folderName,
    items,
    stats: finalStats
  });
  zipEntries.push({
    path: indexPath,
    data: new Blob([galleryHtml], { type: 'text/html' }),
    lastModified: archive.exportedAt || Date.now()
  });

  setProgress(95, 'Packaging media gallery zip...');
  const zipBlob = await buildStoredZip(zipEntries);

  setProgress(97, 'Downloading media gallery zip...');
  await downloadBlob(zipBlob, zipFileName, false);

  return {
    folderName,
    indexPath,
    zipFileName,
    exportedCount: finalStats.exported,
    linkedOnlyCount: finalStats.linked,
    totalBytes: finalStats.bytes,
    zipSizeBytes: zipBlob.size
  };
}

function buildMediaGalleryHtml({ archive, folderName, items, stats }) {
  const galleryItems = items.map((item) => ({
    id: item.id,
    messageId: item.messageId,
    conversationId: item.conversationId,
    conversationTitle: item.conversationTitle,
    displayTitle: item.displayTitle,
    promptText: item.promptText,
    messageText: item.messageText,
    caption: item.caption,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    kind: item.kind,
    mimeType: item.mimeType,
    localPath: item.localPath,
    sourceUrl: item.sourceUrl,
    exportable: item.exportable,
    inline: item.inline,
    orphaned: item.orphaned,
    sizeBytes: item.sizeBytes,
    modelLabel: item.modelLabel,
    modelId: item.modelId,
    modelName: item.modelName,
    modelType: item.modelType,
    modelSourceLabel: item.modelSourceLabel,
    settingsSourceLabel: item.settingsSourceLabel,
    generationSettings: item.generationSettings,
    searchText: item.searchText
  }));

  const galleryDataMarker = '__VENICE_GALLERY_ITEMS__';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Venice Media Gallery</title>
  <style>
    :root {
      --bg: #06121b;
      --bg-soft: #0c1e2a;
      --panel: rgba(12, 29, 40, 0.9);
      --panel-soft: rgba(19, 41, 56, 0.8);
      --border: rgba(123, 224, 207, 0.16);
      --text: #edf6f7;
      --muted: #97acb7;
      --accent: #7be0cf;
      --accent-strong: #2ac1ad;
      --shadow: 0 18px 60px rgba(0, 0, 0, 0.35);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Avenir Next", "SF Pro Display", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(42, 193, 173, 0.18), transparent 28%),
        linear-gradient(180deg, #07131b 0%, #102838 100%);
      min-height: 100vh;
      padding: 28px;
    }
    .shell { max-width: 1380px; margin: 0 auto; }
    .hero, .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 26px;
      padding: 24px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
      margin-bottom: 18px;
    }
    .eyebrow {
      font-size: 11px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 10px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: clamp(2.2rem, 4.5vw, 3.4rem);
      letter-spacing: -0.04em;
    }
    p { margin: 0; }
    .hero-copy {
      color: var(--muted);
      max-width: 760px;
      line-height: 1.6;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-top: 20px;
    }
    .stat {
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.04);
      padding: 16px;
    }
    .stat span {
      display: block;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .stat strong {
      font-size: 1.8rem;
      letter-spacing: -0.04em;
    }
    .controls {
      display: grid;
      grid-template-columns: minmax(260px, 1fr) auto auto;
      gap: 12px;
      align-items: center;
    }
    .search {
      width: 100%;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(255,255,255,0.05);
      color: var(--text);
      padding: 14px 18px;
      font: inherit;
    }
    .filters {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .filter-btn {
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(255,255,255,0.04);
      color: var(--muted);
      padding: 10px 14px;
      border-radius: 999px;
      font: inherit;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      cursor: pointer;
    }
    .filter-btn.active {
      background: rgba(123, 224, 207, 0.12);
      border-color: rgba(123, 224, 207, 0.26);
      color: var(--accent);
    }
    .results {
      text-align: right;
      color: var(--muted);
      font-size: 13px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 14px;
      margin-top: 18px;
    }
    .card {
      border: 1px solid rgba(255,255,255,0.08);
      background: var(--panel-soft);
      border-radius: 20px;
      overflow: hidden;
      cursor: pointer;
      transition: transform 0.18s ease, border-color 0.18s ease;
    }
    .card:hover {
      transform: translateY(-1px);
      border-color: rgba(123, 224, 207, 0.2);
    }
    .thumb {
      aspect-ratio: 1 / 1;
      background: linear-gradient(135deg, rgba(123,224,207,0.08), rgba(255,255,255,0.03));
      display: grid;
      place-items: center;
      overflow: hidden;
      position: relative;
    }
    .thumb img,
    .thumb video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .thumb-placeholder {
      padding: 18px;
      text-align: center;
      color: var(--muted);
      line-height: 1.5;
      font-size: 13px;
    }
    .badge-row {
      position: absolute;
      top: 12px;
      left: 12px;
      right: 12px;
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    .badge {
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      background: rgba(3, 14, 20, 0.72);
      color: var(--text);
    }
    .card-body {
      padding: 14px;
    }
    .card-title {
      font-size: 15px;
      font-weight: 700;
      margin-bottom: 6px;
      letter-spacing: -0.02em;
    }
    .card-meta,
    .card-copy,
    .gallery-note {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.55;
    }
    .card-copy {
      margin-top: 8px;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .empty {
      display: none;
      margin-top: 18px;
      padding: 24px;
      border-radius: 18px;
      text-align: center;
      color: var(--muted);
      background: rgba(255,255,255,0.04);
      border: 1px dashed rgba(255,255,255,0.08);
    }
    .empty.active {
      display: block;
    }
    .lightbox {
      position: fixed;
      inset: 0;
      background: rgba(2, 8, 12, 0.82);
      backdrop-filter: blur(10px);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
      z-index: 10;
    }
    .lightbox.open {
      display: flex;
    }
    .lightbox-shell {
      width: min(1300px, 100%);
      max-height: 92vh;
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
      gap: 18px;
    }
    .viewer,
    .sidebar {
      background: rgba(8, 20, 28, 0.96);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 24px;
      box-shadow: var(--shadow);
    }
    .viewer {
      min-height: 70vh;
      display: grid;
      place-items: center;
      overflow: hidden;
      position: relative;
    }
    .viewer img,
    .viewer video {
      max-width: 100%;
      max-height: 90vh;
      object-fit: contain;
      display: block;
    }
    .sidebar {
      padding: 20px;
      overflow: auto;
    }
    .sidebar h2 {
      margin: 0 0 10px;
      font-size: 1.3rem;
      letter-spacing: -0.03em;
    }
    .sidebar p,
    .meta-list {
      color: var(--muted);
      line-height: 1.6;
      font-size: 14px;
    }
    .meta-list {
      display: grid;
      gap: 10px;
      margin: 18px 0;
    }
    .meta-row strong {
      display: block;
      color: var(--text);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      margin-bottom: 4px;
    }
    .sidebar-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 18px;
    }
    .link-btn,
    .close-btn {
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 999px;
      background: rgba(255,255,255,0.04);
      color: var(--text);
      padding: 11px 14px;
      font: inherit;
      cursor: pointer;
      text-decoration: none;
    }
    .close-btn {
      position: absolute;
      top: 18px;
      right: 18px;
      z-index: 2;
    }
    @media (max-width: 980px) {
      .stats,
      .controls,
      .lightbox-shell {
        grid-template-columns: 1fr;
      }
      .results {
        text-align: left;
      }
    }
    @media (max-width: 720px) {
      body { padding: 18px; }
      .hero, .panel { padding: 18px; border-radius: 22px; }
      .grid { grid-template-columns: 1fr; }
      .filters { justify-content: flex-start; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <p class="eyebrow">Venice Companion Gallery</p>
      <h1>Exported Venice Media</h1>
      <p class="hero-copy">This gallery is a companion to the readable archive. After extracting the zip, open this index to browse materialized Venice media files with search, filters, and generation metadata pulled from linked messages when available.</p>
      <div class="stats">
        <div class="stat"><span>Exported Files</span><strong>${escapeHtml(formatNumber(stats.exported || 0))}</strong></div>
        <div class="stat"><span>Images</span><strong>${escapeHtml(formatNumber(stats.images || 0))}</strong></div>
        <div class="stat"><span>Linked Refs</span><strong>${escapeHtml(formatNumber(stats.linked || 0))}</strong></div>
        <div class="stat"><span>Approx Size</span><strong>${escapeHtml(formatBytes(stats.bytes || 0))}</strong></div>
      </div>
    </section>

    <section class="panel">
      <div class="controls">
        <input class="search" id="searchInput" type="search" placeholder="Search by prompt, model, settings, message text, id, or mime type">
        <div class="filters" id="filterBar">
          <button class="filter-btn active" data-kind="all" type="button">All</button>
          <button class="filter-btn" data-kind="image" type="button">Images</button>
          <button class="filter-btn" data-kind="video" type="button">Videos</button>
          <button class="filter-btn" data-kind="audio" type="button">Audio</button>
          <button class="filter-btn" data-kind="file" type="button">Files</button>
        </div>
        <div class="results" id="resultCount">${escapeHtml(formatNumber(items.length))} items</div>
      </div>

      <div class="gallery-note" style="margin-top: 14px;">Extracted folder: ${escapeHtml(folderName)}. Search uses conversation titles, nearby message text, model names, and saved generation settings so large Venice media libraries stay navigable.</div>

      <div class="grid" id="galleryGrid"></div>
      <div class="empty" id="emptyState">No media matches the current search or filter.</div>
    </section>
  </main>

  <div class="lightbox" id="lightbox">
    <div class="lightbox-shell">
      <div class="viewer" id="viewerPane">
        <button class="close-btn" id="closeLightbox" type="button">Close</button>
      </div>
      <aside class="sidebar">
        <p class="eyebrow">Media Details</p>
        <h2 id="detailTitle">Media item</h2>
        <p id="detailCaption"></p>
        <div class="meta-list" id="detailMeta"></div>
        <div class="sidebar-actions" id="detailActions"></div>
      </aside>
    </div>
  </div>

  <script>
    const GALLERY_ITEMS = ${galleryDataMarker};
    const state = {
      query: '',
      kind: 'all',
      filtered: GALLERY_ITEMS.slice(),
      activeIndex: null
    };

    const elements = {
      searchInput: document.getElementById('searchInput'),
      filterBar: document.getElementById('filterBar'),
      resultCount: document.getElementById('resultCount'),
      galleryGrid: document.getElementById('galleryGrid'),
      emptyState: document.getElementById('emptyState'),
      lightbox: document.getElementById('lightbox'),
      viewerPane: document.getElementById('viewerPane'),
      closeLightbox: document.getElementById('closeLightbox'),
      detailTitle: document.getElementById('detailTitle'),
      detailCaption: document.getElementById('detailCaption'),
      detailMeta: document.getElementById('detailMeta'),
      detailActions: document.getElementById('detailActions')
    };

    function escapeHtmlClient(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function formatBytesClient(value) {
      const bytes = Number(value || 0);
      if (!bytes) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
      const size = bytes / (1024 ** exponent);
      return \`\${size.toFixed(size >= 10 || exponent === 0 ? 0 : 1)} \${units[exponent]}\`;
    }

    function formatDateClient(value) {
      if (!value) return 'Unknown date';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString();
    }

    function getItemSource(item) {
      return item.localPath || item.sourceUrl || '';
    }

    function getKindLabel(kind) {
      if (kind === 'image') return 'Image';
      if (kind === 'video') return 'Video';
      if (kind === 'audio') return 'Audio';
      if (kind === 'file') return 'File';
      return 'Media';
    }

    function getDisplayTitle(item) {
      return item.displayTitle || item.conversationTitle || item.caption || item.modelLabel || (getKindLabel(item.kind) + ' item');
    }

    function getDetailCaption(item) {
      const title = getDisplayTitle(item);
      const caption = String(item.caption || '').trim();
      return caption && caption !== title ? caption : '';
    }

    function matchesFilters(item) {
      const matchesKind = state.kind === 'all' || item.kind === state.kind;
      const matchesQuery = !state.query || String(item.searchText || '').includes(state.query);
      return matchesKind && matchesQuery;
    }

    function renderGrid() {
      state.filtered = GALLERY_ITEMS.filter(matchesFilters);
      elements.resultCount.textContent = \`\${state.filtered.length} of \${GALLERY_ITEMS.length} items\`;
      elements.emptyState.classList.toggle('active', state.filtered.length === 0);

      elements.galleryGrid.innerHTML = state.filtered.map((item, index) => {
        const source = getItemSource(item);
        const displayTitle = getDisplayTitle(item);
        const cardMeta = [
          formatDateClient(item.updatedAt || item.createdAt),
          formatBytesClient(item.sizeBytes || 0),
          item.modelLabel || ''
        ].filter(Boolean).join(' • ');
        const thumb = item.kind === 'image' && source
          ? \`<img loading="lazy" alt="\${escapeHtmlClient(displayTitle)}" src="\${escapeHtmlClient(source)}">\`
          : item.kind === 'video' && source
            ? \`<video muted playsinline preload="metadata" src="\${escapeHtmlClient(source)}"></video>\`
            : \`<div class="thumb-placeholder">\${escapeHtmlClient(getKindLabel(item.kind))}<br>\${item.exportable ? 'Preview available in viewer' : 'Reference only'}</div>\`;

        const titleHtml = item.conversationTitle
          ? \`<div class="card-title">\${escapeHtmlClient(item.conversationTitle)}</div>\`
          : '';

        return \`
          <article class="card" data-index="\${index}" tabindex="0">
            <div class="thumb">
              <div class="badge-row">
                <span class="badge">\${escapeHtmlClient(getKindLabel(item.kind))}</span>
                <span class="badge">\${escapeHtmlClient(item.exportable ? 'Embedded' : 'Reference')}</span>
              </div>
              \${thumb}
            </div>
            <div class="card-body">
              \${titleHtml}
              <div class="card-meta">\${escapeHtmlClient(cardMeta)}</div>
              <div class="card-copy">\${escapeHtmlClient(item.caption || 'No metadata summary available')}</div>
            </div>
          </article>
        \`;
      }).join('');
    }

    function openLightbox(index) {
      const item = state.filtered[index];
      if (!item) return;

      const source = getItemSource(item);
      const displayTitle = getDisplayTitle(item);
      let viewerMarkup = '<div class="thumb-placeholder">No preview available</div>';
      if (item.kind === 'image' && source) {
        viewerMarkup = \`<button class="close-btn" id="closeLightbox" type="button">Close</button><img alt="\${escapeHtmlClient(displayTitle)}" src="\${escapeHtmlClient(source)}">\`;
      } else if (item.kind === 'video' && source) {
        viewerMarkup = \`<button class="close-btn" id="closeLightbox" type="button">Close</button><video controls playsinline preload="metadata" src="\${escapeHtmlClient(source)}"></video>\`;
      } else {
        viewerMarkup = \`<button class="close-btn" id="closeLightbox" type="button">Close</button><div class="thumb-placeholder">\${escapeHtmlClient(item.exportable ? 'Open the source file to inspect this item.' : 'This entry is a linked reference without a local exported file.')}</div>\`;
      }

      elements.viewerPane.innerHTML = viewerMarkup;
      elements.viewerPane.querySelector('#closeLightbox').addEventListener('click', closeLightbox);
      elements.detailTitle.textContent = displayTitle;
      elements.detailCaption.textContent = getDetailCaption(item);

      const metaEntries = [
        item.conversationTitle ? ['Conversation', item.conversationTitle] : null,
        item.modelLabel ? ['Model', item.modelLabel] : null,
        item.modelName && item.modelId && item.modelName !== item.modelId ? ['Model ID', item.modelId] : null,
        item.modelType ? ['Model Type', item.modelType] : null,
        item.modelSourceLabel ? ['Model Source', item.modelSourceLabel] : null,
        item.settingsSourceLabel ? ['Settings Source', item.settingsSourceLabel] : null,
        ['Kind', getKindLabel(item.kind)],
        ['Mime Type', item.mimeType || 'Unknown'],
        ['Approx Size', formatBytesClient(item.sizeBytes || 0)],
        ['Updated', formatDateClient(item.updatedAt || item.createdAt)],
        ...(Array.isArray(item.generationSettings) ? item.generationSettings.map((entry) => [entry.label, entry.value]) : []),
        ['Message ID', item.messageId || 'Unknown'],
        ['Conversation ID', item.conversationId || 'Unknown']
      ].filter(Boolean);

      elements.detailMeta.innerHTML = metaEntries
        .map(([label, value]) => \`<div class="meta-row"><strong>\${escapeHtmlClient(label)}</strong>\${escapeHtmlClient(value)}</div>\`)
        .join('');

      const actions = [];
      if (item.localPath) {
        actions.push(\`<a class="link-btn" href="\${escapeHtmlClient(item.localPath)}" target="_blank" rel="noopener">Open File</a>\`);
      }
      if (item.sourceUrl) {
        actions.push(\`<a class="link-btn" href="\${escapeHtmlClient(item.sourceUrl)}" target="_blank" rel="noopener">Open Source URL</a>\`);
      }
      elements.detailActions.innerHTML = actions.join('');
      elements.lightbox.classList.add('open');
    }

    function closeLightbox() {
      elements.lightbox.classList.remove('open');
      elements.viewerPane.innerHTML = '<button class="close-btn" id="closeLightbox" type="button">Close</button>';
      elements.detailActions.innerHTML = '';
      elements.detailCaption.textContent = '';
      elements.detailMeta.innerHTML = '';
    }

    elements.searchInput.addEventListener('input', (event) => {
      state.query = String(event.target.value || '').trim().toLowerCase();
      renderGrid();
    });

    elements.filterBar.addEventListener('click', (event) => {
      const button = event.target.closest('[data-kind]');
      if (!button) return;
      state.kind = button.dataset.kind || 'all';
      Array.from(elements.filterBar.querySelectorAll('[data-kind]')).forEach((element) => {
        element.classList.toggle('active', element.dataset.kind === state.kind);
      });
      renderGrid();
    });

    elements.galleryGrid.addEventListener('click', (event) => {
      const card = event.target.closest('[data-index]');
      if (!card) return;
      openLightbox(Number(card.dataset.index));
    });

    elements.galleryGrid.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const card = event.target.closest('[data-index]');
      if (!card) return;
      event.preventDefault();
      openLightbox(Number(card.dataset.index));
    });

    elements.lightbox.addEventListener('click', (event) => {
      if (event.target === elements.lightbox) {
        closeLightbox();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeLightbox();
      }
    });

    renderGrid();
  </script>
</body>
</html>`;

  return buildInlinePayloadHtmlBlob(html, galleryDataMarker, (parts) => {
    appendInlineJsonArrayExpression(parts, galleryItems);
  });
}

function buildMediaGalleryExperienceHtml({ archive, folderName, items, stats }) {
  const galleryItems = items.map((item) => ({
    id: item.id,
    source: item.source,
    messageId: item.messageId,
    conversationId: item.conversationId,
    conversationTitle: item.conversationTitle,
    displayTitle: item.displayTitle,
    promptText: item.promptText,
    messageText: item.messageText,
    caption: item.caption,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    kind: item.kind,
    mimeType: item.mimeType,
    localPath: item.localPath,
    sourceUrl: item.sourceUrl,
    exportable: item.exportable,
    inline: item.inline,
    orphaned: item.orphaned,
    sizeBytes: item.sizeBytes,
    modelLabel: item.modelLabel,
    modelId: item.modelId,
    modelName: item.modelName,
    modelType: item.modelType,
    modelSourceLabel: item.modelSourceLabel,
    settingsSourceLabel: item.settingsSourceLabel,
    generationSettings: item.generationSettings,
    materializationError: item.materializationError || '',
    searchText: item.searchText
  }));

  const galleryStatusParts = [];
  if (stats.linked) {
    galleryStatusParts.push(`${formatNumber(stats.linked)} linked ${stats.linked === 1 ? 'reference remains' : 'references remain'} because the file bytes could not be saved into the zip.`);
  }
  if (stats.metadataOnly) {
    galleryStatusParts.push(`${formatNumber(stats.metadataOnly)} ${stats.metadataOnly === 1 ? 'item could' : 'items could'} not be saved because Venice no longer exposed the original ${stats.metadataOnly === 1 ? 'file' : 'files'} at export time.`);
  }
  const galleryStatusNote = galleryStatusParts.length
    ? galleryStatusParts.join(' ')
    : 'All displayed gallery items were saved as local files inside the zip.';

  const galleryDataMarker = '__VENICE_GALLERY_ITEMS_EXPERIENCE__';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Venice Media Gallery</title>
  <style>
    :root {
      --bg: #06121b;
      --bg-soft: #0c1e2a;
      --panel: rgba(12, 29, 40, 0.9);
      --panel-soft: rgba(19, 41, 56, 0.8);
      --panel-strong: rgba(10, 23, 32, 0.96);
      --border: rgba(123, 224, 207, 0.16);
      --text: #edf6f7;
      --muted: #97acb7;
      --accent: #7be0cf;
      --shadow: 0 18px 60px rgba(0, 0, 0, 0.35);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Avenir Next", "SF Pro Display", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(42, 193, 173, 0.18), transparent 28%),
        linear-gradient(180deg, #07131b 0%, #102838 100%);
      min-height: 100vh;
      padding: 28px;
    }
    .shell { max-width: 1380px; margin: 0 auto; }
    .hero, .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 26px;
      padding: 24px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
      margin-bottom: 18px;
    }
    .eyebrow {
      font-size: 11px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 10px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: clamp(2.2rem, 4.5vw, 3.4rem);
      letter-spacing: -0.04em;
    }
    p { margin: 0; }
    .hero-copy {
      color: var(--muted);
      max-width: 820px;
      line-height: 1.6;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-top: 20px;
    }
    .stat {
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.04);
      padding: 16px;
    }
    .stat span {
      display: block;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .stat strong {
      font-size: 1.8rem;
      letter-spacing: -0.04em;
    }
    .controls {
      display: grid;
      grid-template-columns: minmax(260px, 1fr) auto auto;
      gap: 12px;
      align-items: center;
    }
    .search {
      width: 100%;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(255,255,255,0.05);
      color: var(--text);
      padding: 14px 18px;
      font: inherit;
    }
    .filters {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .filter-btn {
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(255,255,255,0.04);
      color: var(--muted);
      padding: 10px 14px;
      border-radius: 999px;
      font: inherit;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      cursor: pointer;
    }
    .filter-btn.active {
      background: rgba(123, 224, 207, 0.12);
      border-color: rgba(123, 224, 207, 0.26);
      color: var(--accent);
    }
    .results {
      text-align: right;
      color: var(--muted);
      font-size: 13px;
    }
    .gallery-note {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.55;
      margin-top: 14px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 14px;
      margin-top: 18px;
    }
    .card {
      border: 1px solid rgba(255,255,255,0.08);
      background: var(--panel-soft);
      border-radius: 20px;
      overflow: hidden;
      cursor: pointer;
      transition: transform 0.18s ease, border-color 0.18s ease;
    }
    .card:hover {
      transform: translateY(-1px);
      border-color: rgba(123, 224, 207, 0.2);
    }
    .thumb {
      aspect-ratio: 1 / 1;
      background: linear-gradient(135deg, rgba(123,224,207,0.08), rgba(255,255,255,0.03));
      display: grid;
      place-items: center;
      overflow: hidden;
      position: relative;
    }
    .thumb img,
    .thumb video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .thumb-placeholder {
      padding: 18px;
      text-align: center;
      color: var(--muted);
      line-height: 1.5;
      font-size: 13px;
    }
    .badge-row {
      position: absolute;
      top: 12px;
      left: 12px;
      right: 12px;
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    .badge,
    .thumb-status,
    .chip {
      border-radius: 999px;
      padding: 7px 11px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      background: rgba(3, 14, 20, 0.76);
      color: var(--text);
    }
    .thumb-status {
      position: absolute;
      right: 14px;
      bottom: 14px;
    }
    .card-body { padding: 14px; }
    .card-title {
      font-size: 15px;
      font-weight: 700;
      margin-bottom: 6px;
      letter-spacing: -0.02em;
    }
    .card-subtitle,
    .card-meta,
    .card-copy {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.55;
    }
    .card-subtitle { margin-bottom: 8px; }
    .card-copy {
      margin-top: 8px;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .empty {
      display: none;
      margin-top: 18px;
      padding: 24px;
      border-radius: 18px;
      text-align: center;
      color: var(--muted);
      background: rgba(255,255,255,0.04);
      border: 1px dashed rgba(255,255,255,0.08);
    }
    .empty.active { display: block; }
    .overlay {
      position: fixed;
      inset: 0;
      background: rgba(2, 8, 12, 0.82);
      backdrop-filter: blur(10px);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
      z-index: 20;
    }
    .overlay.open { display: flex; }
    .detail-shell,
    .viewer-shell {
      width: min(1380px, 100%);
      max-height: 92vh;
      background: var(--panel-strong);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 28px;
      box-shadow: var(--shadow);
      position: relative;
      overflow: hidden;
    }
    .detail-shell {
      display: grid;
      grid-template-columns: minmax(0, 1.05fr) minmax(340px, 0.95fr);
      gap: 18px;
      padding: 22px;
    }
    .detail-preview-panel {
      min-height: 0;
      display: grid;
      grid-template-rows: auto minmax(280px, 1fr) auto auto;
      gap: 16px;
    }
    .detail-top h2 {
      margin: 0 0 8px;
      font-size: clamp(1.5rem, 2vw, 2rem);
      letter-spacing: -0.04em;
    }
    .detail-caption,
    .detail-note,
    .sidebar-copy,
    .meta-card span,
    .viewer-hint {
      color: var(--muted);
      line-height: 1.6;
      font-size: 14px;
    }
    .chip-row,
    .action-row,
    .viewer-controls {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .detail-preview {
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 24px;
      background: linear-gradient(135deg, rgba(123,224,207,0.08), rgba(255,255,255,0.03));
      min-height: 0;
      overflow: hidden;
      display: grid;
      place-items: center;
      padding: 0;
      position: relative;
      cursor: pointer;
    }
    .detail-preview.is-disabled { cursor: default; }
    .detail-preview img,
    .detail-preview video {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
      background: rgba(2, 8, 12, 0.45);
    }
    .preview-cta {
      position: absolute;
      bottom: 18px;
      left: 18px;
      border-radius: 999px;
      padding: 9px 12px;
      background: rgba(3, 14, 20, 0.8);
      color: var(--text);
      font-size: 11px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .detail-sidebar {
      min-height: 0;
      border-radius: 22px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
      padding: 18px;
      overflow: auto;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-top: 14px;
    }
    .meta-card {
      border-radius: 18px;
      padding: 14px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.05);
      min-width: 0;
    }
    .meta-card strong {
      display: block;
      color: var(--text);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      margin-bottom: 6px;
    }
    .link-btn,
    .dismiss-btn,
    .nav-btn {
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 999px;
      background: rgba(255,255,255,0.04);
      color: var(--text);
      padding: 11px 14px;
      font: inherit;
      cursor: pointer;
      text-decoration: none;
    }
    .dismiss-btn {
      position: absolute;
      top: 20px;
      right: 20px;
      z-index: 3;
      width: 40px;
      height: 40px;
      display: grid;
      place-items: center;
      padding: 0;
    }
    .dismiss-btn svg,
    .nav-btn svg {
      width: 17px;
      height: 17px;
      flex: 0 0 auto;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .nav-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
    .viewer-shell {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
    }
    .viewer-topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 18px 20px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.02);
    }
    .viewer-title {
      font-size: 14px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--muted);
      flex: 1;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .viewer-viewport {
      min-height: 0;
      overflow: hidden;
      display: grid;
      place-items: center;
      background: rgba(1, 5, 8, 0.65);
      touch-action: none;
    }
    .viewer-stage {
      width: 100%;
      height: 100%;
      display: grid;
      place-items: center;
      overflow: hidden;
    }
    .viewer-asset {
      max-width: 100%;
      max-height: 100%;
      display: block;
    }
    .viewer-image {
      transform-origin: center center;
      transition: transform 0.08s linear;
      will-change: transform;
      cursor: zoom-in;
      user-select: none;
      -webkit-user-drag: none;
    }
    .viewer-video,
    .viewer-audio {
      width: min(1100px, 100%);
    }
    .viewer-hint {
      padding: 14px 20px 18px;
      border-top: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.02);
    }
    @media (max-width: 980px) {
      .stats,
      .controls,
      .detail-shell,
      .meta-grid {
        grid-template-columns: 1fr;
      }
      .results { text-align: left; }
      .detail-shell { overflow: auto; }
      .detail-preview-panel {
        grid-template-rows: auto minmax(220px, 42vh) auto auto;
      }
    }
    @media (max-width: 720px) {
      body { padding: 18px; }
      .hero, .panel { padding: 18px; border-radius: 22px; }
      .grid { grid-template-columns: 1fr; }
      .filters { justify-content: flex-start; }
      .detail-shell,
      .viewer-shell { border-radius: 22px; }
      .detail-shell { padding: 18px; }
      .viewer-topbar {
        align-items: flex-start;
        flex-direction: column;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <p class="eyebrow">Venice archive · Media</p>
      <h1>Media library</h1>
      <p class="hero-copy">Browse the media saved in this export, search prompts and file details, and open images at full resolution.</p>
      <div class="stats">
        <div class="stat"><span>Exported Files</span><strong>${escapeHtml(formatNumber(stats.exported || 0))}</strong></div>
        <div class="stat"><span>Images</span><strong>${escapeHtml(formatNumber(stats.images || 0))}</strong></div>
        <div class="stat"><span>Videos</span><strong>${escapeHtml(formatNumber(stats.videos || 0))}</strong></div>
        <div class="stat"><span>Approx Size</span><strong>${escapeHtml(formatBytes(stats.bytes || 0))}</strong></div>
      </div>
    </section>

    <section class="panel">
      <div class="controls">
        <input class="search" id="searchInput" type="search" aria-label="Search media" placeholder="Search prompts, conversations, models and file details">
        <div class="filters" id="filterBar" aria-label="Media type">
          <button class="filter-btn active" data-kind="all" type="button" aria-pressed="true">All</button>
          <button class="filter-btn" data-kind="image" type="button" aria-pressed="false">Images</button>
          <button class="filter-btn" data-kind="video" type="button" aria-pressed="false">Videos</button>
          <button class="filter-btn" data-kind="audio" type="button" aria-pressed="false">Audio</button>
          <button class="filter-btn" data-kind="file" type="button" aria-pressed="false">Files</button>
        </div>
        <div class="results" id="resultCount">${escapeHtml(formatNumber(items.length))} items</div>
      </div>

      <div class="gallery-note">Archive folder: ${escapeHtml(folderName)}. Search covers conversation titles, prompts, nearby messages, model names and saved settings. ${escapeHtml(galleryStatusNote)}</div>

      <div class="grid" id="galleryGrid"></div>
      <div class="empty" id="emptyState">No media matches the current search or filter.</div>
    </section>
  </main>

  <div class="overlay" id="detailOverlay" role="dialog" aria-modal="true" aria-labelledby="detailTitle">
    <div class="detail-shell">
      <button class="dismiss-btn" id="closeDetailOverlay" type="button" aria-label="Close details"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
      <section class="detail-preview-panel">
        <div class="detail-top">
          <p class="eyebrow">Media details</p>
          <h2 id="detailTitle">Media item</h2>
          <p class="detail-caption" id="detailCaption"></p>
          <div class="chip-row" id="detailChips"></div>
        </div>
        <button class="detail-preview is-disabled" id="detailPreview" type="button"></button>
        <div class="action-row" id="detailActions"></div>
        <p class="detail-note" id="detailNote"></p>
      </section>
      <aside class="detail-sidebar">
        <p class="eyebrow">Saved information</p>
        <p class="sidebar-copy">Prompt, source and generation details saved with this item.</p>
        <div class="meta-grid" id="detailMeta"></div>
      </aside>
    </div>
  </div>

  <div class="overlay" id="viewerOverlay" role="dialog" aria-modal="true" aria-labelledby="viewerTitle">
    <div class="viewer-shell">
      <div class="viewer-topbar">
        <button class="nav-btn" id="closeViewerOverlay" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg> Back</button>
        <div class="viewer-title" id="viewerTitle">Full Resolution</div>
        <div class="viewer-controls" id="viewerControls">
          <button class="nav-btn" id="zoomOutBtn" type="button" aria-label="Zoom out">−</button>
          <button class="nav-btn" id="zoomResetBtn" type="button">Reset</button>
          <button class="nav-btn" id="zoomInBtn" type="button" aria-label="Zoom in">+</button>
        </div>
      </div>
      <div class="viewer-viewport" id="viewerViewport">
        <div class="viewer-stage" id="viewerStage"></div>
      </div>
      <div class="viewer-hint" id="viewerHint">Use the mouse wheel to zoom and drag the image to pan.</div>
    </div>
  </div>

  <script>
    const GALLERY_ITEMS = ${galleryDataMarker};
    const state = {
      query: '',
      kind: 'all',
      filtered: GALLERY_ITEMS.slice(),
      activeItem: null,
      zoom: 1,
      panX: 0,
      panY: 0,
      dragging: false,
      dragPointerId: null,
      dragOriginX: 0,
      dragOriginY: 0,
      detailReturnFocus: null,
      viewerReturnFocus: null
    };

    const elements = {
      searchInput: document.getElementById('searchInput'),
      filterBar: document.getElementById('filterBar'),
      resultCount: document.getElementById('resultCount'),
      galleryGrid: document.getElementById('galleryGrid'),
      emptyState: document.getElementById('emptyState'),
      detailOverlay: document.getElementById('detailOverlay'),
      closeDetailOverlay: document.getElementById('closeDetailOverlay'),
      detailTitle: document.getElementById('detailTitle'),
      detailCaption: document.getElementById('detailCaption'),
      detailChips: document.getElementById('detailChips'),
      detailPreview: document.getElementById('detailPreview'),
      detailActions: document.getElementById('detailActions'),
      detailNote: document.getElementById('detailNote'),
      detailMeta: document.getElementById('detailMeta'),
      viewerOverlay: document.getElementById('viewerOverlay'),
      closeViewerOverlay: document.getElementById('closeViewerOverlay'),
      viewerTitle: document.getElementById('viewerTitle'),
      viewerControls: document.getElementById('viewerControls'),
      viewerViewport: document.getElementById('viewerViewport'),
      viewerStage: document.getElementById('viewerStage'),
      viewerHint: document.getElementById('viewerHint'),
      zoomOutBtn: document.getElementById('zoomOutBtn'),
      zoomResetBtn: document.getElementById('zoomResetBtn'),
      zoomInBtn: document.getElementById('zoomInBtn')
    };

    function escapeHtmlClient(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function formatBytesClient(value) {
      const bytes = Number(value || 0);
      if (!bytes) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
      const size = bytes / (1024 ** exponent);
      return \`\${size.toFixed(size >= 10 || exponent === 0 ? 0 : 1)} \${units[exponent]}\`;
    }

    function formatDateClient(value) {
      if (!value) return 'Unknown date';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString();
    }

    function isHttpUrl(value) {
      return /^https?:\/\//i.test(String(value || ''));
    }

    function isRenderableRemoteSource(value) {
      return isHttpUrl(value) || /^data:/i.test(String(value || ''));
    }

    function getRenderableSource(item) {
      if (item.localPath) return item.localPath;
      return isRenderableRemoteSource(item.sourceUrl) ? item.sourceUrl : '';
    }

    function getKindLabel(kind) {
      if (kind === 'image') return 'Image';
      if (kind === 'video') return 'Video';
      if (kind === 'audio') return 'Audio';
      if (kind === 'file') return 'File';
      return 'Media';
    }

    function getDisplayTitle(item) {
      return item.displayTitle || item.conversationTitle || item.caption || item.modelLabel || (getKindLabel(item.kind) + ' item');
    }

    function getConversationSubtitle(item) {
      const conversationTitle = String(item.conversationTitle || '').trim();
      const displayTitle = getDisplayTitle(item);
      return conversationTitle && conversationTitle !== displayTitle ? conversationTitle : '';
    }

    function getDetailCaption(item) {
      const title = getDisplayTitle(item);
      const caption = String(item.caption || '').trim();
      return caption && caption !== title ? caption : '';
    }

    function getAvailabilityLabel(item) {
      if (item.localPath) return 'Saved file';
      if (String(item.sourceUrl || '').startsWith('blob:')) return 'Live Venice reference';
      if (item.sourceUrl) return 'Linked reference';
      return 'Metadata only';
    }

    function getSourceDescriptor(item) {
      if (!item.sourceUrl) return '';
      if (String(item.sourceUrl).startsWith('blob:')) return 'Venice blob URL';
      if (String(item.sourceUrl).startsWith('data:')) return 'Inline data URL';
      if (isHttpUrl(item.sourceUrl)) return 'External URL';
      return 'Captured reference';
    }

    function getDetailNote(item) {
      if (item.localPath) {
        return 'This file was saved into the gallery zip. Open the saved file directly or use the full-resolution viewer.';
      }

      if (item.materializationError) {
        return 'The gallery preserved metadata, but the file bytes could not be saved into the zip: ' + item.materializationError;
      }

      if (String(item.sourceUrl || '').startsWith('blob:')) {
        return 'This entry was only available as a live Venice blob URL when the export ran. Blob URLs do not survive extraction, so only the metadata view remains.';
      }

      if (item.sourceUrl) {
        return 'This entry is linked by URL rather than embedded in the archive. Use the original URL if it is still reachable.';
      }

      return 'This entry contains metadata only.';
    }

    function hasFullViewer(item) {
      const source = getRenderableSource(item);
      return Boolean(source && (item.kind === 'image' || item.kind === 'video' || item.kind === 'audio'));
    }

    function matchesFilters(item) {
      const matchesKind = state.kind === 'all' || item.kind === state.kind;
      const matchesQuery = !state.query || String(item.searchText || '').includes(state.query);
      return matchesKind && matchesQuery;
    }

    function renderGrid() {
      state.filtered = GALLERY_ITEMS.filter(matchesFilters);
      elements.resultCount.textContent = \`\${state.filtered.length} of \${GALLERY_ITEMS.length} items\`;
      elements.emptyState.classList.toggle('active', state.filtered.length === 0);

      elements.galleryGrid.innerHTML = state.filtered.map((item, index) => {
        const source = getRenderableSource(item);
        const displayTitle = getDisplayTitle(item);
        const conversationSubtitle = getConversationSubtitle(item);
        const cardMeta = [
          formatDateClient(item.updatedAt || item.createdAt),
          formatBytesClient(item.sizeBytes || 0),
          item.modelLabel || ''
        ].filter(Boolean).join(' • ');
        const thumb = item.kind === 'image' && source
          ? \`<img loading="lazy" alt="\${escapeHtmlClient(displayTitle)}" src="\${escapeHtmlClient(source)}">\`
          : item.kind === 'video' && source
            ? \`<video muted playsinline preload="metadata" src="\${escapeHtmlClient(source)}"></video>\`
            : \`<div class="thumb-placeholder">\${escapeHtmlClient(getKindLabel(item.kind))}<br>\${item.localPath ? 'Saved preview opens in details' : 'Metadata available in details'}</div>\`;

        return \`
          <article class="card" data-index="\${index}" tabindex="0">
            <div class="thumb">
              <div class="badge-row">
                <span class="badge">\${escapeHtmlClient(getKindLabel(item.kind))}</span>
                <span class="badge">\${escapeHtmlClient(item.modelLabel || getAvailabilityLabel(item))}</span>
              </div>
              \${thumb}
              <div class="thumb-status">\${escapeHtmlClient(getAvailabilityLabel(item))}</div>
            </div>
            <div class="card-body">
              <div class="card-title">\${escapeHtmlClient(displayTitle)}</div>
              \${conversationSubtitle ? \`<div class="card-subtitle">\${escapeHtmlClient(conversationSubtitle)}</div>\` : ''}
              <div class="card-meta">\${escapeHtmlClient(cardMeta)}</div>
              <div class="card-copy">\${escapeHtmlClient(item.caption || item.messageText || 'No metadata summary available')}</div>
            </div>
          </article>
        \`;
      }).join('');
    }

    function renderDetailPreview(item) {
      const source = getRenderableSource(item);
      const displayTitle = getDisplayTitle(item);
      let markup = \`<div class="thumb-placeholder">\${escapeHtmlClient(getAvailabilityLabel(item))}<br>\${escapeHtmlClient(getDetailNote(item))}</div>\`;

      if (item.kind === 'image' && source) {
        markup = \`<img alt="\${escapeHtmlClient(displayTitle)}" src="\${escapeHtmlClient(source)}"><div class="preview-cta">Open full resolution</div>\`;
      } else if (item.kind === 'video' && source) {
        markup = \`<video muted playsinline preload="metadata" src="\${escapeHtmlClient(source)}"></video><div class="preview-cta">Open full resolution</div>\`;
      } else if (item.kind === 'audio' && source) {
        markup = \`<div class="thumb-placeholder">Audio preview ready<br>Open the full viewer for playback</div><div class="preview-cta">Open full resolution</div>\`;
      }

      elements.detailPreview.innerHTML = markup;
      elements.detailPreview.disabled = !hasFullViewer(item);
      elements.detailPreview.classList.toggle('is-disabled', !hasFullViewer(item));
    }

    function openDetails(index) {
      const item = state.filtered[index];
      if (!item) return;

      state.detailReturnFocus = document.activeElement;
      state.activeItem = item;
      elements.detailTitle.textContent = getDisplayTitle(item);
      elements.detailCaption.textContent = getDetailCaption(item);
      elements.detailNote.textContent = getDetailNote(item);
      renderDetailPreview(item);

      const chips = [getKindLabel(item.kind), getAvailabilityLabel(item)];
      if (item.orphaned) chips.push('Orphaned reference');
      elements.detailChips.innerHTML = chips.map((label) => \`<span class="chip">\${escapeHtmlClient(label)}</span>\`).join('');

      const metaEntries = [
        ['Conversation', item.conversationTitle || 'None'],
        ['Detected From', item.source || 'Unknown'],
        ['Availability', getAvailabilityLabel(item)],
        item.localPath ? ['Saved Path', item.localPath] : null,
        item.modelLabel ? ['Model', item.modelLabel] : null,
        item.modelName && item.modelId && item.modelName !== item.modelId ? ['Model ID', item.modelId] : null,
        item.modelType ? ['Model Type', item.modelType] : null,
        item.modelSourceLabel ? ['Model Source', item.modelSourceLabel] : null,
        item.settingsSourceLabel ? ['Settings Source', item.settingsSourceLabel] : null,
        ['Kind', getKindLabel(item.kind)],
        ['Mime Type', item.mimeType || 'Unknown'],
        ['Approx Size', formatBytesClient(item.sizeBytes || 0)],
        ['Updated', formatDateClient(item.updatedAt || item.createdAt)],
        item.sourceUrl ? ['Original Source', getSourceDescriptor(item)] : null,
        ...(Array.isArray(item.generationSettings) ? item.generationSettings.map((entry) => [entry.label, entry.value]) : []),
        ['Message ID', item.messageId || 'Unknown'],
        ['Conversation ID', item.conversationId || 'Unknown'],
        item.materializationError ? ['Export Note', item.materializationError] : null
      ].filter(Boolean);

      elements.detailMeta.innerHTML = metaEntries
        .map(([label, value]) => \`<div class="meta-card"><strong>\${escapeHtmlClient(label)}</strong><span>\${escapeHtmlClient(String(value || ''))}</span></div>\`)
        .join('');

      const actions = [];
      if (hasFullViewer(item)) {
        actions.push('<button class="link-btn" data-action="viewer" type="button">Open Full Resolution</button>');
      }
      if (item.localPath) {
        actions.push(\`<a class="link-btn" href="\${escapeHtmlClient(item.localPath)}" target="_blank" rel="noopener">Open Saved File</a>\`);
      }
      if (isHttpUrl(item.sourceUrl)) {
        actions.push(\`<a class="link-btn" href="\${escapeHtmlClient(item.sourceUrl)}" target="_blank" rel="noopener">Open Original URL</a>\`);
      }
      elements.detailActions.innerHTML = actions.join('');
      elements.detailOverlay.classList.add('open');
      document.body.style.overflow = 'hidden';
      elements.closeDetailOverlay.focus();
    }

    function closeDetails() {
      closeViewer();
      state.activeItem = null;
      elements.detailOverlay.classList.remove('open');
      elements.detailPreview.innerHTML = '';
      elements.detailPreview.disabled = true;
      elements.detailPreview.classList.add('is-disabled');
      elements.detailActions.innerHTML = '';
      elements.detailCaption.textContent = '';
      elements.detailChips.innerHTML = '';
      elements.detailMeta.innerHTML = '';
      elements.detailNote.textContent = '';
      document.body.style.overflow = '';
      state.detailReturnFocus?.focus?.();
      state.detailReturnFocus = null;
    }

    function applyViewerTransform() {
      const image = elements.viewerStage.querySelector('.viewer-image');
      if (!image) return;
      image.style.transform = \`translate(\${state.panX}px, \${state.panY}px) scale(\${state.zoom})\`;
      image.style.cursor = state.zoom > 1 ? (state.dragging ? 'grabbing' : 'grab') : 'zoom-in';
    }

    function resetViewerTransform() {
      state.zoom = 1;
      state.panX = 0;
      state.panY = 0;
      state.dragging = false;
      state.dragPointerId = null;
      applyViewerTransform();
    }

    function setZoom(nextZoom) {
      state.zoom = Math.max(1, Math.min(6, Number(nextZoom || 1)));
      if (state.zoom === 1) {
        state.panX = 0;
        state.panY = 0;
      }
      applyViewerTransform();
    }

    function openViewer() {
      const item = state.activeItem;
      if (!item) return;

      const source = getRenderableSource(item);
      if (!source) return;

      const displayTitle = getDisplayTitle(item);
      state.viewerReturnFocus = document.activeElement;
      elements.viewerTitle.textContent = displayTitle;
      resetViewerTransform();

      if (item.kind === 'image') {
        elements.viewerStage.innerHTML = \`<img class="viewer-asset viewer-image" alt="\${escapeHtmlClient(displayTitle)}" src="\${escapeHtmlClient(source)}">\`;
        elements.viewerControls.style.display = 'flex';
        elements.viewerHint.textContent = 'Use the mouse wheel to zoom and drag the image to pan.';
      } else if (item.kind === 'video') {
        elements.viewerStage.innerHTML = \`<video class="viewer-asset viewer-video" controls playsinline preload="metadata" src="\${escapeHtmlClient(source)}"></video>\`;
        elements.viewerControls.style.display = 'none';
        elements.viewerHint.textContent = 'Full-resolution video playback runs in its own stage so you can return to metadata with one step.';
      } else if (item.kind === 'audio') {
        elements.viewerStage.innerHTML = \`<audio class="viewer-asset viewer-audio" controls preload="metadata" src="\${escapeHtmlClient(source)}"></audio>\`;
        elements.viewerControls.style.display = 'none';
        elements.viewerHint.textContent = 'Audio playback is available here while metadata stays one step back in the details stage.';
      }

      elements.viewerOverlay.classList.add('open');
      applyViewerTransform();
      elements.closeViewerOverlay.focus();
    }

    function closeViewer() {
      const wasOpen = elements.viewerOverlay.classList.contains('open');
      state.dragging = false;
      state.dragPointerId = null;
      elements.viewerOverlay.classList.remove('open');
      elements.viewerStage.innerHTML = '';
      elements.viewerControls.style.display = 'flex';
      if (wasOpen) state.viewerReturnFocus?.focus?.();
      state.viewerReturnFocus = null;
    }

    elements.searchInput.addEventListener('input', (event) => {
      state.query = String(event.target.value || '').trim().toLowerCase();
      renderGrid();
    });

    elements.filterBar.addEventListener('click', (event) => {
      const button = event.target.closest('[data-kind]');
      if (!button) return;
      state.kind = button.dataset.kind || 'all';
      Array.from(elements.filterBar.querySelectorAll('[data-kind]')).forEach((element) => {
        const active = element.dataset.kind === state.kind;
        element.classList.toggle('active', active);
        element.setAttribute('aria-pressed', String(active));
      });
      renderGrid();
    });

    elements.galleryGrid.addEventListener('click', (event) => {
      const card = event.target.closest('[data-index]');
      if (!card) return;
      openDetails(Number(card.dataset.index));
    });

    elements.galleryGrid.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const card = event.target.closest('[data-index]');
      if (!card) return;
      event.preventDefault();
      openDetails(Number(card.dataset.index));
    });

    elements.detailPreview.addEventListener('click', () => {
      if (state.activeItem && hasFullViewer(state.activeItem)) {
        openViewer();
      }
    });

    elements.detailActions.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action="viewer"]');
      if (!button) return;
      event.preventDefault();
      openViewer();
    });

    elements.closeDetailOverlay.addEventListener('click', closeDetails);
    elements.closeViewerOverlay.addEventListener('click', closeViewer);
    elements.zoomInBtn.addEventListener('click', () => setZoom(state.zoom + 0.25));
    elements.zoomOutBtn.addEventListener('click', () => setZoom(state.zoom - 0.25));
    elements.zoomResetBtn.addEventListener('click', resetViewerTransform);

    elements.detailOverlay.addEventListener('click', (event) => {
      if (event.target === elements.detailOverlay) {
        closeDetails();
      }
    });

    elements.viewerOverlay.addEventListener('click', (event) => {
      if (event.target === elements.viewerOverlay) {
        closeViewer();
      }
    });

    elements.viewerViewport.addEventListener('wheel', (event) => {
      const image = elements.viewerStage.querySelector('.viewer-image');
      if (!image || !elements.viewerOverlay.classList.contains('open')) {
        return;
      }

      event.preventDefault();
      const delta = event.deltaY < 0 ? 0.2 : -0.2;
      setZoom(state.zoom + delta);
    }, { passive: false });

    elements.viewerViewport.addEventListener('dblclick', () => {
      const image = elements.viewerStage.querySelector('.viewer-image');
      if (!image) return;
      setZoom(state.zoom > 1 ? 1 : 2);
    });

    elements.viewerViewport.addEventListener('pointerdown', (event) => {
      const image = elements.viewerStage.querySelector('.viewer-image');
      if (!image || state.zoom <= 1) {
        return;
      }

      state.dragging = true;
      state.dragPointerId = event.pointerId;
      state.dragOriginX = event.clientX - state.panX;
      state.dragOriginY = event.clientY - state.panY;
      elements.viewerViewport.setPointerCapture(event.pointerId);
      applyViewerTransform();
    });

    elements.viewerViewport.addEventListener('pointermove', (event) => {
      if (!state.dragging || event.pointerId !== state.dragPointerId) {
        return;
      }

      state.panX = event.clientX - state.dragOriginX;
      state.panY = event.clientY - state.dragOriginY;
      applyViewerTransform();
    });

    const releaseViewerPointer = (event) => {
      if (event.pointerId != null && event.pointerId !== state.dragPointerId) {
        return;
      }

      state.dragging = false;
      state.dragPointerId = null;
      applyViewerTransform();
    };

    elements.viewerViewport.addEventListener('pointerup', releaseViewerPointer);
    elements.viewerViewport.addEventListener('pointercancel', releaseViewerPointer);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (elements.viewerOverlay.classList.contains('open')) {
          closeViewer();
        } else if (elements.detailOverlay.classList.contains('open')) {
          closeDetails();
        }
      }
    });

    renderGrid();
  </script>
</body>
</html>`;

  return buildInlinePayloadHtmlBlob(html, galleryDataMarker, (parts) => {
    appendInlineJsonArrayExpression(parts, galleryItems);
  });
}

function buildArchiveConversationIndex(conversationIndex, includeReadableFields) {
  return conversationIndex.map((conversation) => {
    const record = {
      id: conversation.id,
      messageCount: conversation.messageCount,
      mediaCount: conversation.mediaCount,
      createdAt: conversation.createdAt || null,
      updatedAt: conversation.updatedAt || null
    };

    if (includeReadableFields) {
      record.title = conversation.title;
      record.preview = conversation.preview;
    }

    return record;
  });
}

function sanitizeMediaItems(mediaItems, includeUrls) {
  return mediaItems.map((mediaItem) => {
    const record = {
      id: mediaItem.id,
      kind: mediaItem.kind,
      source: mediaItem.source,
      sourceStore: mediaItem.sourceStore || null,
      messageId: mediaItem.messageId,
      conversationId: mediaItem.conversationId,
      mimeType: mediaItem.mimeType,
      inline: mediaItem.inline,
      approxBytes: mediaItem.approxBytes,
      orphaned: mediaItem.orphaned
    };

    if (includeUrls && mediaItem.url) {
      if (mediaItem.inline || String(mediaItem.url).startsWith('data:')) {
        record.urlOmitted = true;
        record.urlKind = 'inline-data';
      } else if (String(mediaItem.url).length > 2048) {
        record.urlPreview = `${String(mediaItem.url).slice(0, 2045)}...`;
        record.urlTruncated = true;
      } else {
        record.url = mediaItem.url;
      }
    } else if (mediaItem.url) {
      record.urlOmitted = true;
      record.urlKind = mediaItem.inline ? 'inline-data' : 'reference';
    }

    if (mediaItem.inline && !record.urlKind) {
      record.urlKind = 'inline-data';
    }

    if (mediaItem.url && !record.urlKind) {
      record.urlKind = 'reference';
    }

    if (includeUrls && !mediaItem.url) {
      record.url = mediaItem.url;
    }

    return record;
  });
}

function summarizeMediaItems(mediaItems) {
  return {
    total: mediaItems.length,
    images: mediaItems.filter((item) => item.kind === 'image').length,
    videos: mediaItems.filter((item) => item.kind === 'video').length,
    audio: mediaItems.filter((item) => item.kind === 'audio').length,
    files: mediaItems.filter((item) => item.kind === 'file').length,
    inline: mediaItems.filter((item) => item.inline).length,
    orphaned: mediaItems.filter((item) => item.orphaned).length
  };
}

function normalizeKeyVault(keyVault) {
  return Object.fromEntries(
    Object.entries(keyVault).map(([fingerprint, data]) => [
      fingerprint,
      {
        keyString: data.keyString,
        metadata: {
          ...(data.metadata || {})
        }
      }
    ])
  );
}

async function digestBytesHex(bufferSource) {
  const buffer = await crypto.subtle.digest('SHA-256', bufferSource);
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function digestHex(text) {
  return digestBytesHex(new TextEncoder().encode(text));
}

async function digestBlobHex(blob) {
  const streamHash = globalThis.VeniceStreamHash?.IncrementalSha256;
  if (streamHash && blob?.stream) {
    const hasher = new streamHash();
    const reader = blob.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) hasher.update(value);
      }
    } finally {
      reader.releaseLock?.();
    }
    return hasher.digestHex();
  }
  return digestBytesHex(await blob.arrayBuffer());
}

let crc32Table = null;

function getCrc32Table() {
  if (crc32Table) {
    return crc32Table;
  }

  crc32Table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let current = index;
    for (let bit = 0; bit < 8; bit++) {
      current = (current & 1) ? (0xEDB88320 ^ (current >>> 1)) : (current >>> 1);
    }
    crc32Table[index] = current >>> 0;
  }

  return crc32Table;
}

function computeCrc32(bytes) {
  return (updateCrc32(0xFFFFFFFF, bytes) ^ 0xFFFFFFFF) >>> 0;
}

function updateCrc32(crc, bytes) {
  const table = getCrc32Table();
  for (let index = 0; index < bytes.length; index++) {
    crc = table[(crc ^ bytes[index]) & 0xFF] ^ (crc >>> 8);
  }
  return crc >>> 0;
}

async function computeCrc32Blob(blob) {
  if (blob?.stream) {
    const reader = blob.stream().getReader();
    let crc = 0xFFFFFFFF;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) crc = updateCrc32(crc, value);
      }
    } finally {
      reader.releaseLock?.();
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  return computeCrc32(new Uint8Array(await blob.arrayBuffer()));
}

function normalizeZipPath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/');
}

function getZipDosDateTime(value) {
  const date = value ? new Date(value) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = Math.max(1980, safeDate.getFullYear());

  return {
    date: (((year - 1980) & 0x7F) << 9) | (((safeDate.getMonth() + 1) & 0x0F) << 5) | (safeDate.getDate() & 0x1F),
    time: ((safeDate.getHours() & 0x1F) << 11) | ((safeDate.getMinutes() & 0x3F) << 5) | (Math.floor(safeDate.getSeconds() / 2) & 0x1F)
  };
}

async function toBlob(value) {
  if (value instanceof Blob) return value;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return new Blob([value]);
  return new Blob([String(value || '')]);
}

async function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }

  return new TextEncoder().encode(String(value || ''));
}

async function buildStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let centralSize = 0;
  let entryCount = 0;

  for (const entry of entries) {
    const zipPath = normalizeZipPath(entry.path);
    if (!zipPath) {
      continue;
    }

    const pathBytes = new TextEncoder().encode(zipPath);
    const dataBlob = await toBlob(entry.data);
    const dataSize = dataBlob.size;
    const localOffset = offset;

    if (pathBytes.length > 0xFFFF) {
      throw new Error('Media gallery ZIP path is too long to export safely.');
    }

    if (dataSize > 0xFFFFFFFF) {
      throw new Error('A gallery file exceeds the standard ZIP size limit.');
    }

    const crc32 = await computeCrc32Blob(dataBlob);
    const dosDateTime = getZipDosDateTime(entry.lastModified);
    const localHeader = new Uint8Array(30);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034B50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dosDateTime.time, true);
    localView.setUint16(12, dosDateTime.date, true);
    localView.setUint32(14, crc32, true);
    localView.setUint32(18, dataSize, true);
    localView.setUint32(22, dataSize, true);
    localView.setUint16(26, pathBytes.length, true);
    localView.setUint16(28, 0, true);

    localParts.push(localHeader, pathBytes, dataBlob);
    offset += localHeader.byteLength + pathBytes.length + dataSize;

    const centralHeader = new Uint8Array(46);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014B50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosDateTime.time, true);
    centralView.setUint16(14, dosDateTime.date, true);
    centralView.setUint32(16, crc32, true);
    centralView.setUint32(20, dataSize, true);
    centralView.setUint32(24, dataSize, true);
    centralView.setUint16(28, pathBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, localOffset, true);

    centralParts.push(centralHeader, pathBytes);
    centralSize += centralHeader.byteLength + pathBytes.length;
    entryCount += 1;
  }

  if (!entryCount) {
    throw new Error('Media gallery ZIP had no files to export.');
  }

  if (entryCount > 0xFFFF || offset > 0xFFFFFFFF || centralSize > 0xFFFFFFFF || (offset + centralSize + 22) > 0xFFFFFFFF) {
    throw new Error('Media gallery is too large for the current ZIP exporter.');
  }

  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  endView.setUint32(0, 0x06054B50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entryCount, true);
  endView.setUint16(10, entryCount, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, endRecord], { type: 'application/zip' });
}

async function downloadBlob(blob, filename, saveAs, { retrying = false, retryMetadata = null } = {}) {
  const url = URL.createObjectURL(blob);

  try {
    await chrome.downloads.download({
      url,
      filename,
      saveAs
    });
    return { ok: true, filename };
  } catch (error) {
    if (!retrying) {
      pendingDownloadRetries.push({ blob, filename, saveAs, ...(retryMetadata || {}) });
    }
    updateRetryDownloadButton();
    log(`Download did not complete for ${filename}: ${error.message || 'download was canceled'}`, 'warning');
    return { ok: false, filename, error };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

async function retryPendingDownloads() {
  if (!pendingDownloadRetries.length || exportInProgress) {
    return;
  }

  const retries = pendingDownloadRetries.slice();
  pendingDownloadRetries = [];
  updateRetryDownloadButton();

  let completed = 0;
  for (const artifact of retries) {
    const result = await downloadBlob(artifact.blob, artifact.filename, artifact.saveAs, { retrying: true });
    if (result.ok) {
      if (typeof artifact.onSuccess === 'function') {
        try {
          await artifact.onSuccess();
        } catch (error) {
          log(`Download completed, but its archive baseline could not be saved: ${error.message || 'browser storage error'}`, 'warning');
        }
      }
      completed += 1;
    } else {
      pendingDownloadRetries.push(artifact);
    }
  }

  updateRetryDownloadButton();
  if (pendingDownloadRetries.length) {
    showStatus('warning', `${formatNumber(completed)} downloads completed. ${formatNumber(pendingDownloadRetries.length)} still need retry.`);
  } else {
    showStatus('success', `${formatNumber(completed)} prepared downloads completed.`);
  }
}

function updateRetryDownloadButton() {
  elements.retryDownloadsBtn.hidden = pendingDownloadRetries.length === 0;
  elements.retryDownloadsBtn.textContent = pendingDownloadRetries.length
    ? `Retry Downloads (${formatNumber(pendingDownloadRetries.length)})`
    : 'Retry Downloads';
}

function openRestoreManager() {
  showStatus('warning', RESTORE_DISABLED_MESSAGE);
  log(RESTORE_DISABLED_MESSAGE, 'warning');
}

function updateUI() {
  const snapshotStats = currentSnapshot?.stats;
  const keyVault = currentState?.keyVault || {};
  const keyCount = Object.keys(keyVault).length;

  elements.convCount.textContent = formatNumber(snapshotStats?.conversationCount ?? currentState?.conversationCount ?? 0);
  elements.msgCount.textContent = formatNumber(snapshotStats?.messageCount ?? currentState?.messageCount ?? 0);
  elements.mediaCount.textContent = formatNumber(snapshotStats?.mediaCount ?? 0);
  elements.keyCount.textContent = formatNumber(keyCount);

  const keyFingerprint = snapshotStats?.keyFingerprint || currentState?.keyFingerprint;
  if (keyFingerprint) {
    elements.currentKey.textContent = keyFingerprint;
  } else {
    elements.currentKey.textContent = currentSnapshot ? 'No active key detected' : 'Waiting for Venice.ai';
  }

  if (currentSnapshot) {
    elements.keyStatusMeta.textContent = `Snapshot captured ${formatRelativeTime(currentSnapshot.capturedAt)}. Scanned ${formatNumber(snapshotStats.storeCount)} stores; messageImages currently reports ${formatNumber(snapshotStats.messageImagesStoreCount)} records.`;
  } else if (currentState?.browser?.lastChecked) {
    elements.keyStatusMeta.textContent = `Last browser snapshot ${formatRelativeTime(currentState.browser.lastChecked)}. Open Venice.ai and refresh for a richer media inventory.`;
  } else {
    elements.keyStatusMeta.textContent = 'Open a Venice.ai tab to capture a fresh snapshot before exporting an archive.';
  }

  elements.imageCount.textContent = formatNumber(snapshotStats?.imageCount ?? 0);
  elements.videoCount.textContent = formatNumber(snapshotStats?.videoCount ?? 0);
  elements.orphanCount.textContent = formatNumber(snapshotStats?.orphanCount ?? 0);
  elements.estimatedSize.textContent = snapshotStats ? formatBytes(currentSnapshot.estimatedSizeBytes) : 'Waiting';
  if (!exportInProgress) {
    elements.progressScope.textContent = currentSnapshot
      ? `${formatNumber(snapshotStats.conversationCount)} conversations • ${formatNumber(snapshotStats.messageCount)} messages • ${formatNumber(snapshotStats.mediaCount)} media references ready`
      : 'Keep the Venice.ai tab open during export.';
  }

  updateRepositoryAccessModeUI();
  updateArchiveLocationUI();
  elements.repositoryBtn.disabled = exportInProgress || !currentSnapshot || encryptedMode;
  elements.backupBtn.disabled = exportInProgress || !currentSnapshot;
  elements.retryDownloadsBtn.disabled = exportInProgress || pendingDownloadRetries.length === 0;
  updatePackageBaselineUI();
  elements.refreshBtn.disabled = Boolean(previewLoadPromise) || exportInProgress;
  elements.restoreBtn.disabled = false;

  renderHistory();
  renderInventory();
}

function setConnectionBadge(state, text) {
  elements.connectionBadge.className = `connection-badge ${state}`;
  elements.connectionBadge.textContent = text;
}

function renderHistory() {
  const history = (currentState?.backup?.exportHistory || []).slice(0, HISTORY_LIMIT);

  if (!history.length) {
    elements.lastExportSummary.textContent = 'No archive has been downloaded from this device yet.';
    elements.historyList.innerHTML = '';
    return;
  }

  const [latest] = history;
  elements.lastExportSummary.textContent = `Latest archive: ${latest.fileName} • ${formatBytes(latest.sizeBytes || 0)} • ${formatRelativeTime(latest.exportedAt)}`;

  elements.historyList.innerHTML = history.map((entry) => {
    const media = entry.media || {};
    const verificationStatus = entry.repository?.manifestStatus || 'downloaded';
    const verificationLabel = verificationStatus === 'verified' ? 'Verified' : (verificationStatus === 'incomplete' ? 'Review media' : 'Downloaded');
    return `
      <article class="history-entry">
        <div class="history-topline">
          <div class="history-title">${escapeHtml(entry.fileName)}</div>
          <span class="history-status ${escapeHtml(verificationStatus)}">${escapeHtml(verificationLabel)}</span>
        </div>
        <div class="history-meta">${escapeHtml(formatDateTime(entry.exportedAt))} • ${escapeHtml(entry.format || 'decrypted')} • ${escapeHtml(formatBytes(entry.sizeBytes || 0))}</div>
        <div class="history-meta">${escapeHtml(formatNumber(entry.stats?.conversations || 0))} conversations • ${escapeHtml(formatNumber(entry.stats?.messages || 0))} messages • ${escapeHtml(formatNumber(media.total || 0))} media</div>
      </article>
    `;
  }).join('');
}

function renderInventory() {
  const conversations = currentSnapshot?.conversationIndex || [];
  const storeInventory = currentSnapshot?.diagnostics?.storeInventory || [];
  const inventoryCards = [];

  if (storeInventory.length) {
    const sortedStores = [...storeInventory].sort((left, right) => (right.count || 0) - (left.count || 0));
    inventoryCards.push(`
      <article class="inventory-row">
        <div class="inventory-topline">
          <div class="inventory-title">IndexedDB store inventory</div>
          <span class="inventory-badge">${escapeHtml(formatNumber(storeInventory.length))} stores</span>
        </div>
        <div class="inventory-meta">messageImages: ${escapeHtml(formatNumber(currentSnapshot?.stats?.messageImagesStoreCount || 0))} • media detected: ${escapeHtml(formatNumber(currentSnapshot?.stats?.mediaCount || 0))}</div>
        <div class="inventory-preview">${escapeHtml(sortedStores.slice(0, 8).map((store) => `${store.name}: ${store.count ?? 'n/a'}`).join(' • '))}</div>
      </article>
    `);
  }

  if (!conversations.length) {
    if (inventoryCards.length) {
      elements.inventoryList.innerHTML = inventoryCards.join('');
      return;
    }

    elements.inventoryList.innerHTML = '<div class="empty-state">Open Venice.ai and refresh the snapshot to preview conversations, media coverage, and archive scope.</div>';
    return;
  }

  const conversationCards = conversations.slice(0, 10).map((conversation) => `
    <article class="inventory-row">
      <div class="inventory-topline">
        <div class="inventory-title">${escapeHtml(conversation.title)}</div>
        <span class="inventory-badge">${escapeHtml(formatNumber(conversation.mediaCount))} media</span>
      </div>
      <div class="inventory-meta">${escapeHtml(formatNumber(conversation.messageCount))} messages • ${escapeHtml(formatDateTime(conversation.updatedAt || conversation.createdAt))}</div>
      <div class="inventory-preview">${escapeHtml(conversation.preview || 'No preview available')}</div>
    </article>
  `);

  elements.inventoryList.innerHTML = [...inventoryCards, ...conversationCards].join('');
}

function showProgress(show) {
  elements.progressSection.classList.toggle('active', show);

  if (show) {
    progressStartedAt = Date.now();
    progressOutcome = 'running';
    elements.progressSection.classList.remove('verified', 'warning', 'error');
    elements.progressHeadline.textContent = 'Export in progress';
    elements.progressState.textContent = 'Running';
    elements.progressLatest.textContent = 'Starting archive capture...';
    elements.progressScope.textContent = 'Keep the Venice.ai tab open; large media stores can take several minutes.';
    elements.progressSection.setAttribute('aria-busy', 'true');
    setProgress(0, 'Preparing archive...');
    updateProgressElapsed();
    clearInterval(progressTimer);
    progressTimer = setInterval(updateProgressElapsed, 1000);
    return;
  }

  clearInterval(progressTimer);
  progressTimer = null;
  elements.progressSection.setAttribute('aria-busy', 'false');

  const verified = progressOutcome === 'success';
  const reviewRequired = progressOutcome === 'warning' || progressOutcome === 'error';
  elements.progressSection.classList.remove('verified', 'warning', 'error');
  const outcomeClass = verified ? 'verified' : (progressOutcome === 'error' ? 'error' : (reviewRequired ? 'warning' : null));
  if (outcomeClass) {
    elements.progressSection.classList.add(outcomeClass);
  }
  elements.progressHeadline.textContent = verified
    ? 'Export verified'
    : (reviewRequired ? 'Export saved — review coverage' : 'Export stopped');
  elements.progressState.textContent = verified ? 'Verified' : (reviewRequired ? 'Review' : 'Stopped');
  if (progressStartedAt) {
    elements.progressElapsed.textContent = (verified || reviewRequired)
      ? `Completed in ${formatDuration(Date.now() - progressStartedAt)}`
      : `Stopped after ${formatDuration(Date.now() - progressStartedAt)}`;
  }
}

function setProgress(percent, text) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  elements.progressFill.style.width = `${safePercent}%`;
  elements.progressText.textContent = text;
  elements.progressPercent.textContent = `${Math.round(safePercent)}%`;
  elements.progressTrack.setAttribute('aria-valuenow', String(Math.round(safePercent)));
}

function updateProgressElapsed() {
  if (!progressStartedAt) {
    return;
  }

  elements.progressElapsed.textContent = formatDuration(Date.now() - progressStartedAt);
}

function clearLog() {
  elements.logSection.innerHTML = '<div class="log-empty">Export activity will appear here.</div>';
}

function log(message, type = 'info') {
  if (elements.logSection.querySelector('.log-empty')) {
    elements.logSection.innerHTML = '';
  }

  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  elements.logSection.appendChild(entry);
  elements.logSection.scrollTop = elements.logSection.scrollHeight;
  elements.progressLatest.textContent = message;
  console.log(`[Backup Console] ${message}`);
}

function showStatus(type, text) {
  clearTimeout(statusTimer);
  elements.statusMessage.className = `banner ${type}`;
  elements.statusMessage.textContent = text;
  elements.progressLatest.textContent = text;
  if (exportInProgress && ['success', 'warning', 'error'].includes(type)) {
    progressOutcome = type;
  }

  statusTimer = setTimeout(() => {
    elements.statusMessage.className = 'banner hidden';
    elements.statusMessage.textContent = '';
  }, STATUS_RESET_MS);
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  if (minutes) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / (1024 ** exponent);
  return `${size.toFixed(size >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatDateTime(value) {
  if (!value) {
    return 'Unknown date';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown date';
  }

  return date.toLocaleString();
}

function formatRelativeTime(value) {
  if (!value) {
    return 'unknown time';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'unknown time';
  }

  const deltaSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  const ranges = [
    { unit: 'day', seconds: 86400 },
    { unit: 'hour', seconds: 3600 },
    { unit: 'minute', seconds: 60 },
    { unit: 'second', seconds: 1 }
  ];

  for (const range of ranges) {
    if (Math.abs(deltaSeconds) >= range.seconds || range.unit === 'second') {
      return formatter.format(Math.round(deltaSeconds / range.seconds), range.unit);
    }
  }

  return 'just now';
}

function estimateBytes(value) {
  const seen = new WeakSet();

  function estimateValueBytes(entry) {
    if (entry == null) {
      return 4;
    }

    const entryType = typeof entry;
    if (entryType === 'string') {
      const approxBytes = detectApproxBytes(entry);
      return (approxBytes || new TextEncoder().encode(entry).byteLength) + 2;
    }

    if (entryType === 'number') {
      return 8;
    }

    if (entryType === 'boolean') {
      return entry ? 4 : 5;
    }

    if (entryType === 'bigint') {
      return entry.toString().length + 2;
    }

    if (entryType !== 'object') {
      return 0;
    }

    if (entry instanceof Uint8Array) {
      return entry.byteLength;
    }

    if (entry instanceof ArrayBuffer) {
      return entry.byteLength;
    }

    const approxBytes = detectApproxBytes(entry);
    if (approxBytes) {
      return approxBytes;
    }

    if (seen.has(entry)) {
      return 0;
    }
    seen.add(entry);

    if (Array.isArray(entry)) {
      return entry.reduce((total, item) => total + estimateValueBytes(item) + 1, 2);
    }

    return Object.entries(entry).reduce((total, [key, nested]) => {
      return total + new TextEncoder().encode(key).byteLength + 3 + estimateValueBytes(nested) + 1;
    }, 2);
  }

  try {
    return estimateValueBytes(value);
  } catch (error) {
    console.warn('[Backup Console] Failed to estimate size:', error);
    return 0;
  }
}

function escapeHtml(value) {
  const text = String(value ?? '');
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeGuideRole(value) {
  const normalized = cleanOptionalText(value).toLowerCase();

  if (!normalized) {
    return 'message';
  }

  if (normalized.includes('assistant') || normalized === 'bot' || normalized === 'model') {
    return 'assistant';
  }

  if (normalized.includes('user') || normalized === 'human') {
    return 'user';
  }

  if (normalized.includes('system')) {
    return 'system';
  }

  if (normalized.includes('tool')) {
    return 'tool';
  }

  return normalized;
}

function getGuideSafeUrl(url) {
  const normalized = cleanOptionalText(url);
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith('data:') || normalized.startsWith('blob:') || normalized.length > 4096) {
    return null;
  }

  return normalized;
}

function buildGuideMessageBlocks(message) {
  const blocks = [];
  const seenMedia = new Set();

  const pushText = (value) => {
    const normalized = String(value || '').trim();
    if (normalized) {
      blocks.push({ type: 'text', text: normalized });
    }
  };

  const pushMedia = (url, kind) => {
    const normalizedUrl = cleanOptionalText(url);
    if (!normalizedUrl || seenMedia.has(normalizedUrl)) {
      return;
    }

    seenMedia.add(normalizedUrl);
    const safeUrl = getGuideSafeUrl(normalizedUrl);
    blocks.push({
      type: 'media',
      kind: kind === 'asset' ? 'file' : kind,
      label: safeUrl ? 'Open reference' : 'Captured in archive',
      url: safeUrl
    });
  };

  if (typeof message?.content === 'string') {
    pushText(message.content);
  } else if (Array.isArray(message?.content)) {
    message.content.forEach((part) => {
      if (!part) {
        return;
      }

      if (part.type === 'text' && typeof part.text === 'string') {
        pushText(part.text);
        return;
      }

      const mediaUrl = part.image_url ? getMediaUrl(part.image_url)
        : part.video_url ? getMediaUrl(part.video_url)
          : getMediaUrl(part);

      if (mediaUrl) {
        const kind = part.image_url ? 'image'
          : part.video_url ? 'video'
            : classifyMediaKind(part);
        pushMedia(mediaUrl, kind);
      }

      pushText(part.text || part.caption || part.alt || part.prompt || '');
    });
  }

  if (typeof message?.text === 'string') {
    pushText(message.text);
  }

  extractMessageMediaCandidates(message).forEach((candidate) => {
    if (candidate.url) {
      pushMedia(candidate.url, candidate.kind || 'file');
    }
  });

  if (!blocks.length) {
    blocks.push({ type: 'empty', text: 'No readable content captured for this message.' });
  }

  return blocks;
}

function buildGuideReportModel(archive) {
  const data = archive.data || {};
  const foldersById = new Map((data.folders || []).map((folder) => [folder.id, folder]));
  const conversationsById = new Map((data.conversations || []).map((conversation) => [conversation.id, conversation]));
  const messagesByConversation = new Map();

  (data.messages || []).forEach((message) => {
    const conversationId = message.conversationId || '__unknown__';
    if (!messagesByConversation.has(conversationId)) {
      messagesByConversation.set(conversationId, []);
    }
    messagesByConversation.get(conversationId).push(message);
  });

  const conversations = (archive.conversationIndex || []).map((conversation) => {
    const sourceConversation = conversationsById.get(conversation.id) || null;
    const folder = foldersById.get(sourceConversation?.folderId) || null;
    const sourceMessages = (messagesByConversation.get(conversation.id) || [])
      .slice()
      .sort((left, right) => {
        const leftTime = left?.createdAtUnixTimestamp || left?.updatedAtUnixTimestamp || 0;
        const rightTime = right?.createdAtUnixTimestamp || right?.updatedAtUnixTimestamp || 0;
        return leftTime - rightTime;
      });
    const messages = sourceMessages
      .map((message) => {
        const role = normalizeGuideRole(
          message?.role ||
          message?.authorRole ||
          message?.senderRole ||
          message?.sender ||
          message?.author?.role ||
          ''
        );
        const modelLabel = buildModelLabel(
          cleanOptionalText(message?.modelName),
          cleanOptionalText(message?.modelId),
          cleanOptionalText(message?.modelType)
        );

        return {
          id: message.id || null,
          role,
          roleLabel: role === 'message' ? 'Message' : `${role.charAt(0).toUpperCase()}${role.slice(1)}`,
          createdAt: message.createdAtUnixTimestamp || null,
          updatedAt: message.updatedAtUnixTimestamp || null,
          modelLabel,
          blocks: buildGuideMessageBlocks(message)
        };
      });

    return {
      id: conversation.id,
      title: resolveConversationTitle(sourceConversation || conversation, sourceMessages),
      preview: conversation.preview || 'No preview available',
      createdAt: conversation.createdAt || null,
      updatedAt: conversation.updatedAt || null,
      messageCount: conversation.messageCount || messages.length,
      mediaCount: conversation.mediaCount || 0,
      folderName: folder?.name || null,
      messages,
      searchText: [
        resolveConversationTitle(sourceConversation || conversation, sourceMessages),
        conversation.preview,
        folder?.name,
        ...messages.map((message) => message.blocks.filter((block) => block.type === 'text').map((block) => block.text).join(' '))
      ].join(' ').toLowerCase()
    };
  });

  return {
    summary: {
      conversations: archive.stats?.conversations || conversations.length,
      messages: archive.stats?.messages || 0,
      media: archive.stats?.media || 0,
      exportedAt: archive.exportedAt,
      checksum: archive.integrity?.sha256 || archive.integrity?.payloadSha256 || '',
      keyFingerprint: archive.keyFingerprint || 'Unavailable',
      format: archive.format || 'decrypted'
    },
    conversations
  };
}

function buildHtmlReport(archive) {
  const mediaTotals = archive.mediaIndex?.totals || {};
  const footerNote = archive.archiveSummary?.mediaGalleryIncluded
    ? 'Read-only export note: this guide is generated from the archive after Venice data has already been read. No browser cache writes occur during archive creation. A companion media gallery zip was also exported beside the archive when that option was enabled.'
    : 'Read-only export note: this guide is generated from the archive after Venice data has already been read. No browser cache writes occur during archive creation. Embedded Venice media remains inside the JSON archive unless a companion media gallery zip was exported.';
  const guideData = buildGuideReportModel(archive);

  const guideDataMarker = '__VENICE_GUIDE_DATA__';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Venice Archive Guide</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #e9dfcf;
      --bg-accent: #f7f0e4;
      --panel: rgba(255, 249, 240, 0.88);
      --panel-strong: rgba(255, 252, 246, 0.96);
      --border: rgba(92, 64, 40, 0.16);
      --border-strong: rgba(92, 64, 40, 0.24);
      --text: #2b211d;
      --muted: #726154;
      --accent: #8f4f2a;
      --accent-soft: rgba(143, 79, 42, 0.12);
      --assistant: #fffaf2;
      --user: #35221b;
      --user-text: #f8efe6;
      --shadow: 0 28px 80px rgba(68, 43, 28, 0.12);
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      font-family: "Avenir Next", "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(255,255,255,0.48), transparent 34%),
        linear-gradient(180deg, #f1e7d7 0%, #e4d7c2 100%);
      color: var(--text);
    }
    h1, h2, h3, p { margin: 0; }
    button, input { font: inherit; }
    .shell {
      max-width: 1460px;
      margin: 0 auto;
      padding: 28px;
    }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.25fr) minmax(320px, 0.75fr);
      gap: 18px;
      margin-bottom: 20px;
    }
    .hero-panel, .workspace, .footer-note {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 28px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(14px);
    }
    .hero-panel {
      padding: 24px;
    }
    .eyebrow {
      text-transform: uppercase;
      letter-spacing: 0.16em;
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 10px;
    }
    .hero-copy {
      color: var(--muted);
      line-height: 1.65;
      margin-top: 12px;
      max-width: 72ch;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-top: 18px;
    }
    .stat {
      padding: 16px;
      border-radius: 20px;
      background: rgba(255,255,255,0.45);
      border: 1px solid rgba(92, 64, 40, 0.08);
    }
    .stat span {
      display: block;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .stat strong {
      display: block;
      font-size: 28px;
      line-height: 1.1;
      letter-spacing: -0.04em;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      color: var(--muted);
      line-height: 1.6;
    }
    .meta-grid strong {
      color: var(--text);
    }
    .workspace {
      display: grid;
      grid-template-columns: 360px minmax(0, 1fr);
      min-height: 70vh;
      overflow: hidden;
    }
    .sidebar {
      border-right: 1px solid var(--border);
      background: rgba(248, 241, 230, 0.84);
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      min-height: 0;
    }
    .sidebar-search {
      width: 100%;
      border: 1px solid var(--border-strong);
      background: rgba(255,255,255,0.72);
      border-radius: 16px;
      padding: 12px 14px;
      color: var(--text);
      outline: none;
    }
    .sidebar-search:focus {
      border-color: rgba(143, 79, 42, 0.4);
      box-shadow: 0 0 0 4px rgba(143, 79, 42, 0.1);
    }
    .sidebar-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: var(--muted);
      font-size: 13px;
    }
    .conversation-list {
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding-right: 2px;
    }
    .conversation-card {
      border: 1px solid rgba(92, 64, 40, 0.1);
      background: rgba(255,255,255,0.62);
      border-radius: 18px;
      padding: 14px;
      text-align: left;
      cursor: pointer;
      transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
    }
    .conversation-card:hover {
      transform: translateY(-1px);
      border-color: rgba(143, 79, 42, 0.3);
      background: rgba(255,255,255,0.78);
    }
    .conversation-card.active {
      border-color: rgba(143, 79, 42, 0.38);
      background: linear-gradient(180deg, rgba(255,255,255,0.86) 0%, rgba(247, 233, 217, 0.92) 100%);
      box-shadow: inset 0 0 0 1px rgba(143, 79, 42, 0.08);
    }
    .conversation-title {
      font-size: 16px;
      font-weight: 600;
      line-height: 1.35;
      margin-bottom: 8px;
    }
    .conversation-preview {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
      margin-bottom: 10px;
    }
    .conversation-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      color: var(--muted);
      font-size: 12px;
    }
    .detail-pane {
      padding: 24px;
      display: flex;
      flex-direction: column;
      min-height: 0;
      background: linear-gradient(180deg, rgba(255,252,246,0.98) 0%, rgba(251,247,240,0.96) 100%);
    }
    .detail-empty {
      margin: auto;
      max-width: 420px;
      text-align: center;
      color: var(--muted);
      line-height: 1.7;
    }
    .detail-header {
      padding-bottom: 18px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 18px;
    }
    .detail-title {
      font-size: clamp(28px, 4vw, 42px);
      line-height: 1.04;
      letter-spacing: -0.05em;
      margin-bottom: 10px;
    }
    .detail-preview {
      color: var(--muted);
      line-height: 1.65;
      max-width: 72ch;
    }
    .detail-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin: 12px 0 14px;
    }
    .meta-pill, .media-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid rgba(92, 64, 40, 0.12);
      background: rgba(143, 79, 42, 0.08);
      font-size: 12px;
      color: var(--text);
    }
    .message-stack {
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding-right: 4px;
    }
    .message-card {
      max-width: min(860px, 100%);
      border-radius: 24px;
      padding: 16px 18px;
      border: 1px solid rgba(92, 64, 40, 0.1);
      background: var(--assistant);
    }
    .message-card.user {
      margin-left: auto;
      background: linear-gradient(180deg, #4b2f24 0%, #2d1d16 100%);
      color: var(--user-text);
      border-color: rgba(0,0,0,0.14);
    }
    .message-card.system, .message-card.tool {
      background: rgba(143, 79, 42, 0.08);
    }
    .message-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 10px;
      font-size: 12px;
      color: var(--muted);
    }
    .message-card.user .message-meta {
      color: rgba(248, 239, 230, 0.78);
    }
    .message-body {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .message-text {
      line-height: 1.7;
      white-space: normal;
      word-break: break-word;
    }
    .message-empty {
      font-style: italic;
      color: var(--muted);
    }
    .message-card.user .message-empty {
      color: rgba(248, 239, 230, 0.72);
    }
    .media-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .media-pill {
      background: rgba(255,255,255,0.8);
      text-decoration: none;
    }
    .message-card.user .media-pill {
      background: rgba(255,255,255,0.1);
      color: var(--user-text);
      border-color: rgba(255,255,255,0.12);
    }
    .footer-note {
      margin-top: 20px;
      padding: 18px 20px;
      color: var(--muted);
      line-height: 1.7;
    }
    @media (max-width: 1100px) {
      .hero { grid-template-columns: 1fr; }
      .workspace { grid-template-columns: 1fr; }
      .sidebar { border-right: none; border-bottom: 1px solid var(--border); }
    }
    @media (max-width: 720px) {
      .shell { padding: 16px; }
      .stats, .meta-grid { grid-template-columns: 1fr 1fr; }
      .detail-pane, .sidebar, .hero-panel { padding: 18px; }
      .message-card { max-width: 100%; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <article class="hero-panel">
        <p class="eyebrow">Venice Archive Guide</p>
        <h1>${escapeHtml(archive.generatedBy.extensionName)}</h1>
        <p class="hero-copy">Browse the conversations in this export without installing anything. The complete JSON export remains alongside this reading view.</p>
        <div class="stats">
          <div class="stat"><span>Conversations</span><strong>${escapeHtml(formatNumber(archive.stats.conversations || 0))}</strong></div>
          <div class="stat"><span>Messages</span><strong>${escapeHtml(formatNumber(archive.stats.messages || 0))}</strong></div>
          <div class="stat"><span>Media</span><strong>${escapeHtml(formatNumber(archive.stats.media || 0))}</strong></div>
          <div class="stat"><span>Fingerprint</span><strong>${escapeHtml(archive.keyFingerprint || 'Unavailable')}</strong></div>
        </div>
      </article>
      <article class="hero-panel">
        <p class="eyebrow">Archive Metadata</p>
        <div class="meta-grid">
          <p><strong>Exported</strong><br>${escapeHtml(formatDateTime(archive.exportedAt))}</p>
          <p><strong>Format</strong><br>${escapeHtml(archive.format)}</p>
          <p><strong>Checksum</strong><br>${escapeHtml(guideData.summary.checksum)}</p>
          <p><strong>Media Summary</strong><br>${escapeHtml(formatNumber(mediaTotals.images || 0))} images, ${escapeHtml(formatNumber(mediaTotals.videos || 0))} videos, ${escapeHtml(formatNumber(mediaTotals.audio || 0))} audio</p>
        </div>
      </article>
    </section>

    <section class="workspace">
      <aside class="sidebar">
        <div>
          <p class="eyebrow">Conversation Index</p>
          <input class="sidebar-search" id="searchInput" type="search" placeholder="Search titles, previews, and message text">
        </div>
        <div class="sidebar-meta">
          <span id="resultCount">0 conversations</span>
          <span>${escapeHtml(formatNumber(archive.stats.messages || 0))} messages</span>
        </div>
        <div class="conversation-list" id="conversationList"></div>
      </aside>
      <section class="detail-pane">
        <div class="detail-empty" id="detailEmpty">
          <p class="eyebrow">Archive Browser</p>
          <h2>Select a conversation</h2>
          <p>Choose a conversation from the index to render its messages, activity, media references, and context from the downloaded archive.</p>
        </div>
        <div id="conversationDetail" hidden></div>
      </section>
    </section>

    <section class="footer-note">
      ${escapeHtml(footerNote)}
    </section>
  </main>

  <script>
    const GUIDE_DATA = ${guideDataMarker};
    const state = {
      query: '',
      selectedConversationId: GUIDE_DATA.conversations[0] ? GUIDE_DATA.conversations[0].id : null
    };

    const elements = {
      searchInput: document.getElementById('searchInput'),
      resultCount: document.getElementById('resultCount'),
      conversationList: document.getElementById('conversationList'),
      detailEmpty: document.getElementById('detailEmpty'),
      conversationDetail: document.getElementById('conversationDetail')
    };

    function escapeHtmlClient(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function formatDateClient(value) {
      if (!value) {
        return 'Unknown date';
      }

      const normalized = typeof value === 'number' ? new Date(value) : new Date(value);
      if (Number.isNaN(normalized.getTime())) {
        return 'Unknown date';
      }

      return normalized.toLocaleString();
    }

    function formatNumberClient(value) {
      return new Intl.NumberFormat().format(Number(value || 0));
    }

    function getFilteredConversations() {
      const query = state.query.trim().toLowerCase();
      if (!query) {
        return GUIDE_DATA.conversations;
      }

      return GUIDE_DATA.conversations.filter((conversation) => conversation.searchText.includes(query));
    }

    function renderConversationList() {
      const conversations = getFilteredConversations();
      elements.resultCount.textContent = conversations.length === 1
        ? '1 conversation'
        : formatNumberClient(conversations.length) + ' conversations';

      if (!conversations.length) {
        elements.conversationList.innerHTML = '<div class="detail-empty"><p>No conversations match this search.</p></div>';
        return;
      }

      if (!conversations.some((conversation) => conversation.id === state.selectedConversationId)) {
        state.selectedConversationId = conversations[0].id;
      }

      elements.conversationList.innerHTML = conversations.map((conversation) => {
        const isActive = conversation.id === state.selectedConversationId;
        const folderPill = conversation.folderName
          ? '<span>' + escapeHtmlClient(conversation.folderName) + '</span>'
          : '';
        return '<button class="conversation-card' + (isActive ? ' active' : '') + '" data-conversation-id="' + escapeHtmlClient(conversation.id) + '">' +
          '<div class="conversation-title">' + escapeHtmlClient(conversation.title) + '</div>' +
          '<div class="conversation-preview">' + escapeHtmlClient(conversation.preview) + '</div>' +
          '<div class="conversation-meta">' +
            '<span>' + escapeHtmlClient(formatNumberClient(conversation.messageCount)) + ' messages</span>' +
            '<span>' + escapeHtmlClient(formatNumberClient(conversation.mediaCount)) + ' media</span>' +
            '<span>' + escapeHtmlClient(formatDateClient(conversation.updatedAt || conversation.createdAt)) + '</span>' +
            folderPill +
          '</div>' +
        '</button>';
      }).join('');

      elements.conversationList.querySelectorAll('[data-conversation-id]').forEach((button) => {
        button.addEventListener('click', () => {
          state.selectedConversationId = button.getAttribute('data-conversation-id');
          renderConversationList();
          renderConversationDetail();
        });
      });
    }

    function renderMessageBlock(block) {
      if (block.type === 'text') {
        return '<p class="message-text">' + escapeHtmlClient(block.text).replace(/\\n/g, '<br>') + '</p>';
      }

      if (block.type === 'media') {
        if (block.url) {
          return '<div class="media-row"><a class="media-pill" href="' + escapeHtmlClient(block.url) + '" target="_blank" rel="noreferrer">' + escapeHtmlClient(block.kind) + ' • ' + escapeHtmlClient(block.label) + '</a></div>';
        }

        return '<div class="media-row"><span class="media-pill">' + escapeHtmlClient(block.kind) + ' • ' + escapeHtmlClient(block.label) + '</span></div>';
      }

      return '<p class="message-empty">' + escapeHtmlClient(block.text || 'No readable content captured for this message.') + '</p>';
    }

    function renderConversationDetail() {
      const conversation = GUIDE_DATA.conversations.find((entry) => entry.id === state.selectedConversationId) || null;

      if (!conversation) {
        elements.detailEmpty.hidden = false;
        elements.conversationDetail.hidden = true;
        elements.conversationDetail.innerHTML = '';
        return;
      }

      elements.detailEmpty.hidden = true;
      elements.conversationDetail.hidden = false;

      const headerMarkup = '<div class="detail-header">' +
        '<p class="eyebrow">' + escapeHtmlClient(conversation.folderName || 'Archived conversation') + '</p>' +
        '<h2 class="detail-title">' + escapeHtmlClient(conversation.title) + '</h2>' +
        '<div class="detail-meta">' +
          '<span class="meta-pill">' + escapeHtmlClient(formatNumberClient(conversation.messageCount)) + ' messages</span>' +
          '<span class="meta-pill">' + escapeHtmlClient(formatNumberClient(conversation.mediaCount)) + ' media references</span>' +
          '<span class="meta-pill">Updated ' + escapeHtmlClient(formatDateClient(conversation.updatedAt || conversation.createdAt)) + '</span>' +
        '</div>' +
        '<p class="detail-preview">' + escapeHtmlClient(conversation.preview) + '</p>' +
      '</div>';

      const messagesMarkup = conversation.messages.length
        ? conversation.messages.map((message) => {
            const roleClass = ['user', 'assistant', 'system', 'tool'].includes(message.role) ? message.role : 'message';
            const metaParts = [message.roleLabel, formatDateClient(message.updatedAt || message.createdAt)];
            if (message.modelLabel) {
              metaParts.push(message.modelLabel);
            }

            return '<article class="message-card ' + escapeHtmlClient(roleClass) + '">' +
              '<div class="message-meta">' + metaParts.map((part) => '<span>' + escapeHtmlClient(part) + '</span>').join('') + '</div>' +
              '<div class="message-body">' + message.blocks.map(renderMessageBlock).join('') + '</div>' +
            '</article>';
          }).join('')
        : '<div class="detail-empty"><p>No messages were captured for this conversation.</p></div>';

      elements.conversationDetail.innerHTML = headerMarkup + '<div class="message-stack">' + messagesMarkup + '</div>';
    }

    elements.searchInput.addEventListener('input', (event) => {
      state.query = event.target.value || '';
      renderConversationList();
      renderConversationDetail();
    });

    renderConversationList();
    renderConversationDetail();
  </script>
</body>
</html>`;

  const guideMetadata = { ...guideData };
  delete guideMetadata.conversations;
  return buildInlinePayloadHtmlBlob(html, guideDataMarker, (parts) => {
    parts.push('Object.assign(', serializeForInlineScript(guideMetadata), ',{conversations:');
    appendInlineJsonArrayExpression(parts, guideData.conversations);
    parts.push('})');
  });
}

init();
