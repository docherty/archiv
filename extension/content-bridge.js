/**
 * Venice History Sync - Content Bridge Script
 * 
 * This script runs in the ISOLATED world and:
 * 1. Injects the main content script into the MAIN world
 * 2. Relays messages between the page and the extension background
 * 
 * Architecture:
 * [Page JS / IndexedDB] <-> [content-main.js (MAIN world)] 
 *                              <-> [content-bridge.js (ISOLATED world)]
 *                                  <-> [background.js (service worker)]
 */

(function() {
  'use strict';
  
  const LOG_PREFIX = '[Venice Sync Bridge]';
  const BRIDGE_PROTOCOL_VERSION = '2026-07-store-api-v12-tab-handoff';
  const TO_EXTENSION_EVENT = `venice-sync-to-extension:${BRIDGE_PROTOCOL_VERSION}`;
  const FROM_EXTENSION_EVENT = `venice-sync-from-extension:${BRIDGE_PROTOCOL_VERSION}`;
  const TO_PAGE_EVENT = `venice-sync-to-page:${BRIDGE_PROTOCOL_VERSION}`;
  const FROM_PAGE_EVENT = `venice-sync-from-page:${BRIDGE_PROTOCOL_VERSION}`;
  const MAIN_READY_EVENT = `venice-sync-main-ready:${BRIDGE_PROTOCOL_VERSION}`;

  if (globalThis.__veniceSyncBridgeVersion === BRIDGE_PROTOCOL_VERSION) {
    console.log(LOG_PREFIX, 'Bridge already loaded');
    return;
  }

  globalThis.__veniceSyncBridgeVersion = BRIDGE_PROTOCOL_VERSION;

  const DEFAULT_MESSAGE_TIMEOUT_MS = 5000;
  const HEAVY_MESSAGE_TIMEOUT_MS = 120000;
  const SNAPSHOT_MESSAGE_TIMEOUT_MS = 180000;
  let mainWorldReady = false;
  let extensionContextInvalidated = false;

  function getRuntime() {
    return globalThis.chrome?.runtime || null;
  }

  function getRuntimeUnavailableMessage() {
    return 'Extension runtime is unavailable. Reload the extension and refresh the Venice tab.';
  }

  function isContextInvalidatedError(error) {
    const message = String(error?.message || error || '');
    return message.includes('Extension context invalidated');
  }

  function dispatchBridgeError(requestId, errorMessage) {
    window.dispatchEvent(new CustomEvent(FROM_EXTENSION_EVENT, {
      detail: { requestId, error: errorMessage }
    }));
  }

  function getMessageTimeoutMs(messageType) {
    switch (messageType) {
      case 'GET_SNAPSHOT_SUMMARY':
      case 'GET_STORE_INVENTORY':
        return SNAPSHOT_MESSAGE_TIMEOUT_MS;
      case 'GET_FULL_DATA':
      case 'GET_STORE_DATA':
      case 'FETCH_MEDIA_RESOURCE':
      case 'GET_OPFS_MEDIA_INDEX':
      case 'FETCH_OPFS_MEDIA':
      case 'GET_CAPTURED_MEDIA_INDEX':
      case 'FETCH_CAPTURED_MEDIA':
      case 'WRITE_DATA':
        return HEAVY_MESSAGE_TIMEOUT_MS;
      default:
        return DEFAULT_MESSAGE_TIMEOUT_MS;
    }
  }
  
  // ===========================================
  // Inject Main World Script
  // ===========================================
  
  function injectMainWorldScript() {
    // First inject nacl library
    const naclScript = document.createElement('script');
    naclScript.src = chrome.runtime.getURL('lib/nacl.min.js');
    naclScript.onload = () => {
      console.log(LOG_PREFIX, 'NaCl library injected');
      
      // Then inject our main script
      const script = document.createElement('script');
      script.src = `${chrome.runtime.getURL('content-main.js')}?protocol=${encodeURIComponent(BRIDGE_PROTOCOL_VERSION)}`;
      script.onload = () => {
        console.log(LOG_PREFIX, 'Main world script injected');
        script.remove();
      };
      script.onerror = (e) => {
        console.error(LOG_PREFIX, 'Failed to inject main world script:', e);
      };
      (document.head || document.documentElement).appendChild(script);
      
      naclScript.remove();
    };
    naclScript.onerror = (e) => {
      console.error(LOG_PREFIX, 'Failed to inject NaCl library:', e);
    };
    (document.head || document.documentElement).appendChild(naclScript);
  }
  
  // ===========================================
  // Message Relay: Page <-> Extension
  // ===========================================
  
  // Listen for messages from the injected script (via custom events)
  window.addEventListener(TO_EXTENSION_EVENT, (event) => {
    const message = event.detail;

    if (extensionContextInvalidated) {
      dispatchBridgeError(message.requestId, getRuntimeUnavailableMessage());
      return;
    }

    console.log(LOG_PREFIX, 'Relaying to background:', message.type);

    const runtime = getRuntime();
    if (!runtime?.sendMessage) {
      extensionContextInvalidated = true;
      const errorMessage = getRuntimeUnavailableMessage();
      dispatchBridgeError(message.requestId, errorMessage);
      return;
    }
    
    // Forward to background script
    let sendPromise;

    try {
      sendPromise = runtime.sendMessage(message);
    } catch (error) {
      if (isContextInvalidatedError(error)) {
        extensionContextInvalidated = true;
        dispatchBridgeError(message.requestId, getRuntimeUnavailableMessage());
        return;
      }

      console.error(LOG_PREFIX, 'Error sending to background:', error);
      dispatchBridgeError(message.requestId, error.message);
      return;
    }

    Promise.resolve(sendPromise)
      .then(response => {
        // Send response back to page
        window.dispatchEvent(new CustomEvent(FROM_EXTENSION_EVENT, {
          detail: { requestId: message.requestId, response }
        }));
      })
      .catch(error => {
        if (isContextInvalidatedError(error)) {
          extensionContextInvalidated = true;
          dispatchBridgeError(message.requestId, getRuntimeUnavailableMessage());
          return;
        }

        console.error(LOG_PREFIX, 'Error sending to background:', error);
        dispatchBridgeError(message.requestId, error.message);
      });
  });

  window.addEventListener(MAIN_READY_EVENT, () => {
    mainWorldReady = true;
    console.log(LOG_PREFIX, 'Main world script is ready');
  });
  
  // Listen for messages from background script
  const runtime = getRuntime();
  if (!runtime?.onMessage?.addListener) {
    console.warn(LOG_PREFIX, getRuntimeUnavailableMessage());
    return;
  }

  runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log(LOG_PREFIX, 'Received from background:', message.type);

    if (!mainWorldReady) {
      sendResponse({
        success: false,
        error: 'Venice page bridge is still starting. Refresh Venice.ai and try again.'
      });
      return false;
    }
    
    // Forward to page script
    const requestId = `bg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const timeoutMs = getMessageTimeoutMs(message.type);
    let completed = false;
    let timeoutId = null;

    const finish = (payload) => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timeoutId);
      window.removeEventListener(FROM_PAGE_EVENT, responseHandler);
      sendResponse(payload);
    };
    
    // Set up response listener
    const responseHandler = (event) => {
      if (event.detail.requestId === requestId) {
        if (event.detail.error) {
          finish({ success: false, error: event.detail.error });
          return;
        }
        finish(event.detail.response);
      }
    };
    window.addEventListener(FROM_PAGE_EVENT, responseHandler);

    timeoutId = setTimeout(() => {
      finish({
        success: false,
        error: 'Venice page did not respond in time. Refresh the page and try again.'
      });
    }, timeoutMs);
    
    // Forward message to page
    window.dispatchEvent(new CustomEvent(TO_PAGE_EVENT, {
      detail: { ...message, requestId }
    }));
    
    // Keep the message channel open for async response
    return true;
  });
  
  // ===========================================
  // Initialize
  // ===========================================
  
  console.log(LOG_PREFIX, 'Initializing on', window.location.href);
  injectMainWorldScript();
  
})();
