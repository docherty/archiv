/**
 * Venice History Sync - Background Service Worker
 * 
 * Handles:
 * 1. Receiving data from content script
 * 2. Managing the backup folder via File System Access API
 * 3. Key vault management
 * 4. Coordinating sync operations
 * 5. Encryption/decryption for backup storage
 */

const EXTENSION_PAGE_PREFIX = chrome.runtime.getURL('');
const VENICE_ORIGIN = 'https://venice.ai/';
const STATE_SCHEMA_VERSION = 1;
const KEY_FINGERPRINT_PATTERN = /^[a-f0-9]{16}$/;
const VENICE_BRIDGE_MESSAGE_TYPES = new Set(['INITIAL_STATE', 'DB_CHANGED', 'KEY_CHANGED']);
const EXTENSION_UI_MESSAGE_TYPES = new Set([
  'GET_STATE',
  'GET_ALL_HISTORY',
  'SET_BACKUP_FOLDER',
  'GET_BACKUP_FOLDER_STATUS',
  'GET_KEYS',
  'RENAME_KEY',
  'UPDATE_KEY_STATS',
  'RECORD_BACKUP_EXPORT'
]);

// ===========================================
// State
// ===========================================

// In-memory state (persisted to chrome.storage)
function createDefaultState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    browser: {
      keyFingerprint: null,
      keyString: null,
      conversationCount: 0,
      messageCount: 0,
      isEmpty: true,
      lastChecked: null
    },
    vault: {
      keys: {},
      activeKeyFingerprint: null
    },
    backup: {
      folderName: null,
      lastSync: null,
      lastExport: null,
      exportHistory: [],
      syncStatus: 'unknown'
    }
  };
}

let state = createDefaultState();

let stateReady = false;
let stateReadyPromise = Promise.resolve();

// ===========================================
// Storage Persistence
// ===========================================

async function loadState() {
  try {
    const stored = await chrome.storage.local.get(['veniceSync']);
    if (stored.veniceSync) {
      const storedState = await validateStoredState(stored.veniceSync);
      if (!storedState) {
        await chrome.storage.local.remove('veniceSync');
        state = createDefaultState();
        return;
      }

      state = {
        ...createDefaultState(),
        ...storedState,
        browser: {
          ...createDefaultState().browser,
          ...(storedState.browser || {})
        },
        vault: {
          ...createDefaultState().vault,
          ...(storedState.vault || {}),
          keys: {
            ...createDefaultState().vault.keys,
            ...(storedState.vault?.keys || {})
          }
        },
        backup: {
          ...createDefaultState().backup,
          ...(storedState.backup || {})
        }
      };
    }
  } catch (e) {
    console.error('[Venice Sync BG] Failed to load state:', e);
  }
}

async function saveState() {
  try {
    const persistedState = await buildPersistedState(state);
    await chrome.storage.local.set({ veniceSync: persistedState });
  } catch (e) {
    console.error('[Venice Sync BG] Failed to save state:', e);
  }
}

stateReadyPromise = loadState().finally(() => {
  stateReady = true;
});

async function digestStatePayload(payload) {
  const json = JSON.stringify(payload);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function buildPersistedState(sourceState) {
  const payload = {
    ...sourceState,
    schemaVersion: STATE_SCHEMA_VERSION
  };

  return {
    ...payload,
    checksum: await digestStatePayload(payload)
  };
}

async function validateStoredState(storedState) {
  if (!storedState || typeof storedState !== 'object') {
    return null;
  }

  const { checksum, ...payload } = storedState;
  const schemaVersion = Number.isInteger(payload.schemaVersion) ? payload.schemaVersion : 0;
  if (schemaVersion > STATE_SCHEMA_VERSION) {
    return null;
  }

  if (typeof checksum === 'string') {
    if (checksum !== await digestStatePayload(payload)) {
      return null;
    }
  } else if (schemaVersion !== 0) {
    return null;
  }

  return {
    ...payload,
    schemaVersion: STATE_SCHEMA_VERSION
  };
}

// ===========================================
// Key Vault Management
// ===========================================

function normalizeKeyRecord(fingerprint, keyString) {
  const normalizedFingerprint = String(fingerprint || '').toLowerCase();
  const values = String(keyString || '').split(',').map((value) => Number(value.trim()));
  if (!KEY_FINGERPRINT_PATTERN.test(normalizedFingerprint) || values.length !== 32 || values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  const derivedFingerprint = values.slice(0, 8).map((value) => value.toString(16).padStart(2, '0')).join('');
  if (derivedFingerprint !== normalizedFingerprint) return null;
  return { fingerprint: normalizedFingerprint, keyString: values.join(',') };
}

function safeCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? Math.min(count, 100000000) : 0;
}

function addKeyToVault(fingerprint, keyString, metadata = {}) {
  const key = normalizeKeyRecord(fingerprint, keyString);
  if (!key) return false;
  fingerprint = key.fingerprint;
  keyString = key.keyString;
  const now = new Date().toISOString();
  
  if (state.vault.keys[fingerprint]) {
    // Update existing key
    state.vault.keys[fingerprint].metadata.lastSeen = now;
    state.vault.keys[fingerprint].metadata = {
      ...state.vault.keys[fingerprint].metadata,
      ...metadata
    };
  } else {
    // New key
    state.vault.keys[fingerprint] = {
      keyString,
      metadata: {
        firstSeen: now,
        lastSeen: now,
        label: `Key ${Object.keys(state.vault.keys).length + 1}`,
        ...metadata
      }
    };
  }
  
  saveState();
  return true;
}

function getKeyFromVault(fingerprint) {
  return state.vault.keys[fingerprint];
}

function getAllKeys() {
  return Object.entries(state.vault.keys).map(([fingerprint, data]) => ({
    fingerprint,
    ...data.metadata,
    keyString: data.keyString
  }));
}

// ===========================================
// Sync Status Detection
// ===========================================

function detectSyncStatus() {
  if (!state.backup.folderName) {
    return 'not_configured';
  }
  
  if (state.browser.isEmpty && Object.keys(state.vault.keys).length === 0) {
    return 'fresh'; // Nothing anywhere
  }
  
  if (state.browser.isEmpty && Object.keys(state.vault.keys).length > 0) {
    return 'browser_empty'; // Browser cleared, backup exists
  }
  
  if (!state.browser.isEmpty && Object.keys(state.vault.keys).length === 0) {
    return 'vault_empty'; // Browser has data, no backup
  }
  
  // Both have data - this would need more detailed comparison
  return 'needs_check';
}

function getSenderUrl(sender) {
  return sender?.tab?.url || sender?.url || sender?.documentUrl || sender?.origin || '';
}

function isExtensionUiSender(sender) {
  const senderUrl = getSenderUrl(sender);
  return sender?.id === chrome.runtime.id && (!senderUrl || senderUrl.startsWith(EXTENSION_PAGE_PREFIX));
}

function isVeniceBridgeSender(sender) {
  return getSenderUrl(sender).startsWith(VENICE_ORIGIN);
}

function isAuthorizedSender(message, sender) {
  if (!message || typeof message.type !== 'string') {
    return false;
  }

  if (VENICE_BRIDGE_MESSAGE_TYPES.has(message.type)) {
    return isVeniceBridgeSender(sender);
  }

  if (EXTENSION_UI_MESSAGE_TYPES.has(message.type)) {
    return isExtensionUiSender(sender);
  }

  return false;
}

// ===========================================
// Message Handling
// ===========================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle async responses
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(e => {
      console.error('[Venice Sync BG] Error handling message:', e);
      sendResponse({ success: false, error: e.message });
    });
  
  return true; // Keep channel open for async response
});

async function handleMessage(message, sender) {
  await stateReadyPromise;

  if (!isAuthorizedSender(message, sender)) {
    return { success: false, error: 'Unauthorized message sender' };
  }

  switch (message.type) {
    case 'INITIAL_STATE':
      return handleInitialState(message.data);
    
    case 'DB_CHANGED':
      return handleDBChanged(message.data);
    
    case 'KEY_CHANGED':
      return handleKeyChanged(message.data);
    
    case 'GET_STATE':
      return getFullState();
    
    case 'GET_ALL_HISTORY':
      return getAllHistory();
    
    case 'SET_BACKUP_FOLDER':
      return handleSetBackupFolder(message.folderName);
    
    case 'GET_BACKUP_FOLDER_STATUS':
      return { 
        configured: !!state.backup.folderName,
        folderName: state.backup.folderName
      };
    
    case 'GET_KEYS':
      return { success: true, keys: getAllKeys() };
    
    case 'RENAME_KEY':
      return renameKey(message.fingerprint, message.newLabel);
    
    case 'UPDATE_KEY_STATS':
      return updateKeyStats(message.fingerprint, message.stats);

    case 'RECORD_BACKUP_EXPORT':
      return recordBackupExport(message.exportRecord);
    
    default:
      return { success: false, error: `Unknown message type: ${message.type}` };
  }
}

// ===========================================
// State Handlers
// ===========================================

async function handleInitialState(data) {
  // Handle both direct data and wrapped {state: data} formats
  const stateData = data?.state || data || {};
  const key = normalizeKeyRecord(stateData.keyFingerprint, stateData.keyString);
  if ((stateData.keyFingerprint != null || stateData.keyString != null) && !key) return { success: false, error: 'Invalid Venice recovery key metadata' };
  
  state.browser = {
    keyFingerprint: key?.fingerprint || null,
    keyString: key?.keyString || null,
    conversationCount: safeCount(stateData.conversationCount),
    messageCount: safeCount(stateData.messageCount),
    isEmpty: Boolean(stateData.isEmpty),
    lastChecked: new Date().toISOString()
  };
  
  // Add key to vault if present
  if (key) {
    addKeyToVault(key.fingerprint, key.keyString);
  }
  
  state.backup.syncStatus = detectSyncStatus();
  await saveState();
  
  return { success: true };
}

async function handleDBChanged(data) {
  const update = data || {};
  state.browser = {
    ...state.browser,
    conversationCount: safeCount(update.conversationCount),
    messageCount: safeCount(update.messageCount),
    isEmpty: Boolean(update.isEmpty),
    lastChecked: new Date().toISOString()
  };
  
  state.backup.syncStatus = detectSyncStatus();
  await saveState();
  
  // Notify popup if it's open
  notifyPopup('STATE_UPDATED', { browser: state.browser, syncStatus: state.backup.syncStatus });
  
  return { success: true };
}

async function handleKeyChanged(data) {
  const update = data || {};
  const key = normalizeKeyRecord(update.newFingerprint, update.newKeyString);
  const isKeyRemoval = update.newFingerprint == null && update.newKeyString == null;
  if (!key && !isKeyRemoval) return { success: false, error: 'Invalid Venice recovery key metadata' };
  // Add new key to vault
  if (key) {
    addKeyToVault(key.fingerprint, key.keyString);
  }
  
  state.browser.keyFingerprint = key?.fingerprint || null;
  state.browser.keyString = key?.keyString || null;
  state.backup.syncStatus = detectSyncStatus();
  
  await saveState();
  
  // Notify popup
  notifyPopup('KEY_CHANGED', {
    oldFingerprint: KEY_FINGERPRINT_PATTERN.test(String(update.oldFingerprint || '').toLowerCase()) ? String(update.oldFingerprint).toLowerCase() : null,
    newFingerprint: key?.fingerprint || null,
    keyCount: Object.keys(state.vault.keys).length
  });
  
  return { success: true };
}

function getFullState() {
  // Return flat structure for easier consumption
  return {
    success: true,
    meta: {
      ready: stateReady
    },
    // Flat properties for popup/backup page
    conversationCount: state.browser.conversationCount || 0,
    messageCount: state.browser.messageCount || 0,
    keyFingerprint: state.browser.keyFingerprint,
    keyVault: state.vault.keys,
    lastSync: state.backup.lastSync,
    // Also include nested for compatibility
    browser: state.browser,
    vault: {
      keyCount: Object.keys(state.vault.keys).length,
      keys: getAllKeys(),
      activeKeyFingerprint: state.vault.activeKeyFingerprint
    },
    backup: state.backup,
    syncStatus: detectSyncStatus()
  };
}

function getAllHistory() {
  return {
    success: true,
    keyCount: Object.keys(state.vault.keys).length,
    lastSync: state.backup.lastSync,
    conversationCount: state.browser.conversationCount,
    messageCount: state.browser.messageCount,
    keyFingerprint: state.browser.keyFingerprint
  };
}

async function handleSetBackupFolder(folderName) {
  state.backup.folderName = folderName;
  await saveState();
  return { success: true, folderName };
}

function renameKey(fingerprint, newLabel) {
  const safeFingerprint = String(fingerprint || '').toLowerCase();
  const safeLabel = String(newLabel || '').trim().slice(0, 80);
  if (KEY_FINGERPRINT_PATTERN.test(safeFingerprint) && safeLabel && state.vault.keys[safeFingerprint]) {
    state.vault.keys[safeFingerprint].metadata.label = safeLabel;
    saveState();
    return { success: true };
  }
  return { success: false, error: 'Key not found' };
}

function updateKeyStats(fingerprint, stats) {
  if (state.vault.keys[fingerprint]) {
    state.vault.keys[fingerprint].metadata.stats = stats;
    state.vault.keys[fingerprint].metadata.lastBackup = new Date().toISOString();
    saveState();
    return { success: true };
  }
  return { success: false, error: 'Key not found' };
}

async function recordBackupExport(exportRecord) {
  if (!exportRecord || !exportRecord.exportedAt || !exportRecord.fileName) {
    return { success: false, error: 'Invalid export record' };
  }

  const normalizedRecord = {
    exportedAt: exportRecord.exportedAt,
    fileName: exportRecord.fileName,
    reportFileName: exportRecord.reportFileName || null,
    format: exportRecord.format || 'decrypted',
    sizeBytes: exportRecord.sizeBytes || 0,
    sha256: exportRecord.sha256 || null,
    keyFingerprint: exportRecord.keyFingerprint || null,
    stats: exportRecord.stats || {},
    media: exportRecord.media || {}
  };

  state.backup.lastSync = normalizedRecord.exportedAt;
  state.backup.lastExport = normalizedRecord;
  state.backup.exportHistory = [normalizedRecord, ...(state.backup.exportHistory || [])]
    .slice(0, 8);
  state.backup.syncStatus = detectSyncStatus();

  await saveState();

  return {
    success: true,
    exportHistory: state.backup.exportHistory,
    lastExport: state.backup.lastExport
  };
}

// ===========================================
// Notification Helper
// ===========================================

function notifyPopup(type, data) {
  chrome.runtime.sendMessage({ type, data }).catch(() => {
    // Popup not open, ignore
  });
}

// ===========================================
// Initialize
// ===========================================
