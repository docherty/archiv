/**
 * Venice History Sync - Popup Script
 * 
 * Manages the extension popup UI with full File System Access API integration
 * for backup/restore operations.
 */

// ===========================================
// DOM Elements
// ===========================================

const elements = {
  statusBadge: document.getElementById('statusBadge'),
  statusText: document.querySelector('.status-text'),
  messageBanner: document.getElementById('messageBanner'),
  conversationCount: document.getElementById('conversationCount'),
  messageCount: document.getElementById('messageCount'),
  currentKeyFingerprint: document.getElementById('currentKeyFingerprint'),
  folderPath: document.getElementById('folderPath'),
  folderStatus: document.getElementById('folderStatus'),
  selectFolderBtn: document.getElementById('selectFolderBtn'),
  backupBtn: document.getElementById('backupBtn'),
  restoreBtn: document.getElementById('restoreBtn'),
  vaultKeyCount: document.getElementById('vaultKeyCount'),
  keysList: document.getElementById('keysList'),
  lastSyncTime: document.getElementById('lastSyncTime')
};

// ===========================================
// State
// ===========================================

let currentState = null;
let stateLoadPromise = null;

const MESSAGE_TIMEOUT_MS = 5000;
const EXPECTED_PAGE_PROTOCOL_VERSION = '2026-07-store-api-v12-tab-handoff';
const RESTORE_ENABLED = false;
const RESTORE_DISABLED_MESSAGE = 'Restore is intentionally gated in this build while dry-run, rollback, and validation safeguards are being completed.';
const ARCHIVE_LOCATION_DB_NAME = 'venice-history-sync-local-state';
const ARCHIVE_LOCATION_DB_VERSION = 1;
const ARCHIVE_LOCATION_STORE = 'settings';
const ARCHIVE_LOCATION_KEY = 'directoryHandle';

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

async function sendVeniceMessage(tabId, message) {
  const response = await withTimeout(
    chrome.tabs.sendMessage(tabId, message),
    MESSAGE_TIMEOUT_MS,
    'Venice.ai did not respond in time'
  );

  if (response?.error) {
    throw new Error(response.error);
  }

  if (response?.success === false) {
    throw new Error(response.error || 'Venice.ai request failed');
  }

  return response;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  const element = document.createElement('div');
  element.textContent = String(value ?? '');
  return element.innerHTML;
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
  return message.includes('outdated');
}

function hasExpectedProtocol(response) {
  return response?.protocolVersion === EXPECTED_PAGE_PROTOCOL_VERSION;
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
    throw new Error('Reload the extension so it can reattach to existing Venice tabs.');
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content-bridge.js']
  });

  for (let attempt = 0; attempt < 12; attempt++) {
    await sleep(350);

    try {
      await pingVeniceTab(tab.id, 3000, { requireExpectedProtocol: true });
      return;
    } catch (error) {
      if (attempt === 11 || (!isMissingReceiverError(error) && !isBridgeStartupError(error) && !isProtocolMismatchError(error))) {
        throw new Error(`Failed to reconnect to Venice.ai: ${error.message}`);
      }
    }
  }
}

async function ensureVeniceReceiver(tab, { force = false } = {}) {
  if (!tab?.id) {
    throw new Error('No Venice.ai tab found.');
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

// ===========================================
// Initialization
// ===========================================

async function init() {
  elements.selectFolderBtn.textContent = 'Open archive manager';
  
  // Set up event listeners
  elements.selectFolderBtn.addEventListener('click', openBackupManager);
  elements.backupBtn.addEventListener('click', openBackupManager);
  elements.restoreBtn.addEventListener('click', openRestoreManager);
  
  // Load state from background
  await loadState();
  await loadArchiveLocationSummary();
  
  // Check if we're on Venice.ai and request fresh data
  await checkVeniceConnection();
  if (await requestFreshData()) {
    await loadState({ silent: true });
  }
  
  // Listen for updates from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STATE_UPDATED' || message.type === 'KEY_CHANGED') {
      loadState({ silent: true });
    }
  });
}

async function loadArchiveLocationSummary() {
  if (!globalThis.indexedDB) {
    return;
  }

  try {
    const record = await new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(ARCHIVE_LOCATION_DB_NAME, ARCHIVE_LOCATION_DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(ARCHIVE_LOCATION_STORE)) {
          request.result.createObjectStore(ARCHIVE_LOCATION_STORE);
        }
      };
      request.onerror = () => reject(request.error || new Error('Archive location storage unavailable'));
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(ARCHIVE_LOCATION_STORE, 'readonly');
        const getRequest = transaction.objectStore(ARCHIVE_LOCATION_STORE).get(ARCHIVE_LOCATION_KEY);
        getRequest.onsuccess = () => {
          database.close();
          resolve(getRequest.result || null);
        };
        getRequest.onerror = () => {
          database.close();
          reject(getRequest.error || new Error('Archive location could not be read'));
        };
      };
    });

    if (!record?.name) {
      return;
    }

    elements.folderPath.textContent = record.name;
    elements.folderStatus.className = 'folder-status';
    elements.folderStatus.textContent = record.manifestStatus === 'verified' ? 'Verified' : 'Configured';
  } catch (error) {
    console.debug('[Popup] Archive location summary unavailable:', error.message);
  }
}

// Open the backup manager in a new tab (File System API works there)
async function openBackupManager() {
  let sourceTabId = null;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && isSupportedVeniceUrl(tab.url)) {
      sourceTabId = tab.id;
    }
  } catch (error) {
    console.debug('[Popup] Could not retain the current Venice tab:', error.message);
  }

  const consoleUrl = new URL(chrome.runtime.getURL('backup.html'));
  if (sourceTabId) {
    consoleUrl.searchParams.set('sourceTabId', String(sourceTabId));
  }

  chrome.tabs.create({ url: consoleUrl.href });
}

function isSupportedVeniceUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && (url.hostname === 'venice.ai' || url.hostname.endsWith('.venice.ai'));
  } catch (_) {
    return false;
  }
}

function openRestoreManager() {
  showMessage('warning', RESTORE_DISABLED_MESSAGE);
}

// ===========================================
// State Management
// ===========================================

async function loadState({ silent = false } = {}) {
  if (stateLoadPromise) {
    return stateLoadPromise;
  }

  stateLoadPromise = (async () => {
    try {
      const response = await sendRuntimeMessage({ type: 'GET_STATE' });

      currentState = response;
      updateUI();
      return true;
    } catch (e) {
      console.error('[Popup] Failed to load state:', e);

      if (!silent) {
        const message = e.message.includes('did not respond')
          ? 'Extension is still starting. Try the popup again in a moment.'
          : 'Failed to load extension state';
        showMessage('error', message);
      }

      return false;
    } finally {
      stateLoadPromise = null;
    }
  })();

  return stateLoadPromise;
}

async function requestFreshData() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes('venice.ai')) {
      await ensureVeniceReceiver(tab);
      // Request the content script to send fresh data
      await sendVeniceMessage(tab.id, { type: 'REFRESH_STATE' });
      return true;
    }
  } catch (e) {
    console.warn('[Popup] Could not request fresh data:', e.message);
  }

  return false;
}

async function checkVeniceConnection() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isVenice = tab?.url?.includes('venice.ai');
    
    if (isVenice) {
      setStatus('connected', 'Connected to Venice.ai');
    } else {
      setStatus('disconnected', 'Open Venice.ai');
      showMessage('info', 'Open Venice.ai to inspect and archive your chat history');
    }
  } catch (e) {
    console.error('[Popup] Error checking Venice connection:', e);
  }
}

// ===========================================
// UI Updates
// ===========================================

function setStatus(type, text) {
  elements.statusBadge.className = `status-badge ${type}`;
  elements.statusText.textContent = text;
}

function showMessage(type, text) {
  elements.messageBanner.className = `message ${type}`;
  elements.messageBanner.textContent = text;
  
  if (type !== 'error') {
    setTimeout(() => {
      elements.messageBanner.className = 'message';
    }, 5000);
  }
}

function updateUI() {
  if (!currentState) return;
  
  // Update stats - handle both nested and flat response formats
  const conversationCount = currentState.conversationCount ?? currentState.browser?.conversationCount ?? 0;
  const messageCount = currentState.messageCount ?? currentState.browser?.messageCount ?? 0;
  const keyVault = currentState.keyVault || {};
  const keyCount = Array.isArray(keyVault) ? keyVault.length : Object.keys(keyVault).length;
  const keyFingerprint = currentState.keyFingerprint ?? currentState.browser?.keyFingerprint;
  const hasBrowserSnapshot = Boolean(currentState.browser?.lastChecked);

  elements.conversationCount.textContent = hasBrowserSnapshot ? conversationCount : '—';
  elements.messageCount.textContent = hasBrowserSnapshot ? messageCount : '—';
  // Update current key
  elements.currentKeyFingerprint.className = 'key-fingerprint';
  if (keyFingerprint) {
    elements.currentKeyFingerprint.textContent = keyFingerprint;
    elements.currentKeyFingerprint.classList.add('success');
  } else if (hasBrowserSnapshot) {
    elements.currentKeyFingerprint.textContent = 'Not detected';
    elements.currentKeyFingerprint.classList.add('warning');
  } else {
    elements.currentKeyFingerprint.textContent = 'Waiting for Venice.ai';
    elements.currentKeyFingerprint.classList.add('idle');
  }
  
  // Update folder status - folder selection happens in backup manager now
  if (currentState.backup?.folderName) {
    elements.folderPath.textContent = currentState.backup.folderName;
    elements.folderStatus.textContent = 'Configured';
    elements.folderStatus.classList.remove('not-set');
  } else {
    elements.folderPath.textContent = 'Managed in archive manager';
    elements.folderStatus.textContent = 'Open manager';
    elements.folderStatus.classList.add('not-set');
  }
  
  // Buttons always enabled - they open backup manager
  elements.backupBtn.disabled = false;
  elements.restoreBtn.disabled = false;
  elements.restoreBtn.title = RESTORE_DISABLED_MESSAGE;
  
  // Update last sync time
  const lastSync = currentState.lastSync ?? currentState.backup?.lastSync;
  if (lastSync) {
    const date = new Date(lastSync);
    elements.lastSyncTime.textContent = `Last archive update: ${date.toLocaleString()}`;
  } else if (hasBrowserSnapshot) {
    elements.lastSyncTime.textContent = 'No archive update recorded yet';
  } else {
    elements.lastSyncTime.textContent = 'Waiting for Venice.ai data';
  }
  
  // Update key vault list
  const keys = Array.isArray(keyVault)
    ? keyVault.map((key) => ({
      fingerprint: key.fingerprint,
      label: key.label,
      firstSeen: key.firstSeen
    }))
    : Object.entries(keyVault).map(([fingerprint, data]) => ({
      fingerprint,
      label: data.metadata?.label,
      firstSeen: data.metadata?.firstSeen
    }));
  updateKeysList(keys);
  elements.vaultKeyCount.textContent = `${keyCount} keys`;
}

function updateKeysList(keys) {
  if (!keys || keys.length === 0) {
    elements.keysList.innerHTML = '<div class="empty-keys">No recovery keys stored yet</div>';
    return;
  }
  
  const browserFingerprint = currentState?.browser?.keyFingerprint;
  
  elements.keysList.innerHTML = keys.map(key => {
    const fingerprint = String(key.fingerprint || '');
    const isActive = fingerprint === browserFingerprint;
    const firstSeen = key.firstSeen ? new Date(key.firstSeen).toLocaleDateString() : 'Unknown';
    
    return `
      <div class="key-item ${isActive ? 'active' : ''}" data-fingerprint="${escapeHtml(fingerprint)}">
        <div class="key-indicator"></div>
        <div class="key-details">
          <div class="key-name">${escapeHtml(key.label || 'Unnamed Key')}</div>
          <div class="key-meta">${escapeHtml(fingerprint.substring(0, 16))}... • Added ${escapeHtml(firstSeen)}</div>
        </div>
      </div>
    `;
  }).join('');
}

// ===========================================
// Start
// ===========================================

document.addEventListener('DOMContentLoaded', init);
