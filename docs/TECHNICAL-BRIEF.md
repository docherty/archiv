# Venice.ai History Sync Extension - Technical Brief

## Executive Summary

Venice.ai stores all chat history in browser storage (IndexedDB/localStorage) to maintain user privacy - they don't store conversations on their servers. This is a privacy feature, but creates a data loss risk when browser data is cleared. This extension will securely backup and sync Venice.ai chat history to cloud storage (Dropbox, Google Drive, etc.) while maintaining the privacy guarantees that Venice.ai users expect.

Current implementation work is focused on a durable local archive repository rather than live restore or browser-cache write-back. The repository format is specified in [DURABLE-LOCAL-ARCHIVE-SPEC.md](DURABLE-LOCAL-ARCHIVE-SPEC.md), and progress is tracked in [DURABLE-LOCAL-ARCHIVE-IMPLEMENTATION-PLAN.md](DURABLE-LOCAL-ARCHIVE-IMPLEMENTATION-PLAN.md). The default workflow must remain browser-only and file-based; a local server is not required for normal backup or viewing.

---

## Problem Statement

1. **Data Volatility**: Venice.ai chat history lives only in browser storage
2. **Browser Cleanup Risk**: Users can lose everything when:
   - Clearing browsing data
   - Browser updates/reinstalls
   - Switching browsers/devices
   - System restores
3. **No Cross-Device Access**: History is locked to one browser on one device
4. **No User Control**: Users have limited control over browser temporary file management

---

## Storage Discovery Results (December 15, 2025) ✅

### Primary Database: `venice-db-encrypted` (IndexedDB v210)

Venice uses **client-side encryption** - data is encrypted before storage using a key held only by the user. This is excellent for privacy but critical for our sync solution.

#### Object Stores Structure

| Store | keyPath | Encrypted | Records | Purpose |
|-------|---------|-----------|---------|---------|
| `conversations` | `id` | ✅ `__encryptedData` | Variable | Chat sessions |
| `messages` | `id` | ✅ `__encryptedData` | Variable | Message content |
| `messageIds` | `id` | ❌ Plaintext | Variable | Message metadata/links |
| `messageImages` | `messageId` | ✅ `__encryptedData` | Variable | Image attachments |
| `folders` | `id` | ❌ Plaintext | Variable | Chat organization |
| `settings` | `id` | ❌ Plaintext | Per-user | User preferences |
| `characters` | `id` | ❌ Plaintext | Variable | Custom AI characters |
| `personas` | `id` | ❌ Plaintext | Variable | User personas |
| `userSystemPrompts` | `id` | ❌ Plaintext | Variable | Custom system prompts |
| `_encryptionSettings` | `id` | ❌ Config | 1 | Encryption configuration |

#### Critical Data Structures

**Conversation Record**:
```javascript
{
  "id": "BNtd6fg",                    // Short alphanumeric conversation ID
  "ownerId": "0x5d38...875044",       // User's wallet address
  "folderId": null,                    // Organization folder (optional)
  "createdAtUnixTimestamp": 1765814480839,
  "updatedAtUnixTimestamp": 1765814480839,
  "__encryptedData": { "0": 208, "1": 194, ... }  // Encrypted blob as byte object
}
```

**Message Record**:
```javascript
{
  "id": "LraHvri",                    // Unique message ID
  "conversationId": "Zh02Qa3",        // Links to conversation
  "parentMessageId": null,             // For threading
  "createdAtUnixTimestamp": 1765814390291,
  "updatedAtUnixTimestamp": 1765814398170,
  "executionTime": 6338,               // AI response time in ms
  "__encryptedData": { "0": 11, "1": 117, ... }
}
```

**MessageIds Record** (unencrypted metadata):
```javascript
{
  "id": "LraHvri",
  "conversationId": "Zh02Qa3",
  "createdAtUnixTimestamp": 1765814390291,
  "updatedAtUnixTimestamp": 1765814398170,
  "parentMessageId": null
}
```

### Encryption Key Location

**localStorage key**: `encryptionKey`
```javascript
// Raw bytes as comma-separated string (32 bytes = AES-256)
"98,67,158,227,249,223,105,0,133,62,216,133,139,114,204,181,132,203,58,177,212,192,141,74,213,72,139,..."
```

⚠️ **CRITICAL**: This key MUST be synced along with the database. Without it, encrypted data is unrecoverable.

### Encryption Settings

The `_encryptionSettings` store defines which fields are encrypted:
```javascript
{
  "settings": {
    "conversations": "NON_INDEXED_FIELDS",
    "messages": "NON_INDEXED_FIELDS",
    "messageImages": "NON_INDEXED_FIELDS",
    // ... only non-indexed fields are encrypted (the actual content)
  },
  "keyChangeDetection": "..."
}
```

### Owner Identification

Users are identified by **Ethereum wallet address**:
- Example: `0x5d3819BE3Dd5bA41C784c56b54CfA0D3Dc875044`
- Found in `ownerId` field across all stores
- Enables multi-user support per browser

### Important localStorage Keys

| Key | Purpose | Sync? |
|-----|---------|-------|
| `encryptionKey` | AES-256 key bytes | ⚠️ CRITICAL |
| `conversationType` | UI state | Optional |
| `chakra-ui-color-mode` | Theme preference | Optional |
| `introPrompt` | Onboarding state | No |
| `@appkit/*` | Wallet connection | No |
| `wagmi.store` | Web3 state | No |

### Non-Critical IndexedDB Databases

| Database | Purpose | Sync? |
|----------|---------|-------|
| `WALLET_CONNECT_V2_INDEXED_DB` | Web3 wallet | No |
| `cbwsdk` | Coinbase wallet SDK | No |
| `keyval-store` | Analytics | No |

---

## Technical Research Findings

### 1. Venice.ai Storage Architecture ✅ CONFIRMED

Venice.ai uses client-side encryption with IndexedDB as primary storage:

- **Primary Storage**: `venice-db-encrypted` IndexedDB (v210)
- **Encryption Key**: localStorage `encryptionKey` (AES-256, 32 bytes)
- **Encryption Mode**: Field-level encryption on `__encryptedData` properties
- **User Identity**: Ethereum wallet address as `ownerId`

**Key Insight**: Since Venice already encrypts the data, we can sync the encrypted blobs directly to cloud storage. The user's encryption key is the master secret - we need to handle it carefully.

### 2. Browser Extension Capabilities

#### Chrome Manifest V3 (Required for new extensions)

**Key APIs Needed**:
- `scripting` - Execute scripts in web page context
- `storage` - Extension's own persistent storage
- `tabs` - Access tab information
- `identity` - OAuth authentication for cloud services
- `alarms` - Schedule periodic syncs

**Critical Capability**: We need to execute code in the **MAIN world** (not isolated) to access the page's IndexedDB:

```javascript
// service-worker.js
chrome.scripting.executeScript({
  target: { tabId: tabId },
  world: "MAIN",  // Critical! Access page's storage context
  func: extractVeniceHistory,
});
```

**Content Script Limitations**:
- Content scripts run in an isolated world
- Cannot directly access page's IndexedDB
- Must use `world: "MAIN"` via `scripting.executeScript()` 

### 3. Cloud Storage Integration

#### Option A: Dropbox (Recommended)

**Pros**:
- Excellent OAuth 2.0 + PKCE support for browser extensions
- Simple file upload/download API
- Works well with periodic syncs
- No server needed

**API Flow**:
```
1. User clicks "Connect Dropbox"
2. OAuth 2.0 + PKCE flow (no client secret needed in browser)
3. Get refresh token for long-term access
4. Upload files to /Apps/VeniceHistorySync/
```

**Key Endpoints**:
- `POST /oauth2/authorize` - Start OAuth with PKCE
- `POST /oauth2/token` - Exchange code for tokens
- `POST /files/upload` - Upload history files (up to 150MB)
- `POST /files/download` - Download for restore
- `POST /files/list_folder` - List backups

**CORS Consideration**: Dropbox API supports CORS for browser-based JavaScript apps.

#### Option B: Google Drive

**Pros**: Many users have Google accounts
**Cons**: More complex API, requires Google Cloud Console setup

#### Option C: Custom Server (Future)

Could add a self-hosted option for advanced users.

### 4. Security Architecture

Since Venice already encrypts chat data client-side, our security model is simplified:

#### Encryption Strategy (Revised)

**Venice's Built-in Encryption**:
- Venice encrypts all sensitive fields using AES (32-byte key from localStorage)
- `__encryptedData` contains encrypted content as byte arrays
- Indexed fields (timestamps, IDs) remain unencrypted for querying

**Our Approach - Leverage Existing Encryption**:
```javascript
// Venice's data is ALREADY encrypted - we just need to sync it safely
// The __encryptedData fields contain encrypted byte arrays

// What we sync to cloud:
// 1. Encrypted IndexedDB records (already safe)
// 2. Encryption key (CRITICAL - needs protection!)

// Option A: User provides a passphrase to wrap the encryption key
async function wrapEncryptionKey(veniceKey, userPassphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrappingKey = await deriveKeyFromPassphrase(userPassphrase, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  
  const wrappedKey = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    wrappingKey,
    veniceKey  // The raw encryption key bytes
  );
  
  return { salt, iv, wrappedKey };  // Safe to upload
}

// Option B: Store key only in extension storage (not synced to cloud)
// User must export/import key manually for cross-device
```

**Key Management Strategy**:

| Approach | Security | Convenience | Cross-Device |
|----------|----------|-------------|--------------|
| Passphrase-wrapped key | ⭐⭐⭐ | ⭐⭐ | ✅ Automatic |
| Key in extension only | ⭐⭐ | ⭐⭐⭐ | ❌ Manual export |
| Key synced plain | ⭐ | ⭐⭐⭐ | ✅ Automatic |

**Recommendation**: Default to passphrase-wrapped key with option to skip (local-only backup).

### 5. Sync Strategy

#### Data Synchronization Model (Updated)

```
┌───────────────────────────────────────┐
│           Venice.ai Tab               │
│  ┌─────────────────────────────────┐  │
│  │ IndexedDB: venice-db-encrypted  │  │
│  │ ├── conversations (encrypted)   │  │
│  │ ├── messages (encrypted)        │  │
│  │ ├── messageImages (encrypted)   │  │
│  │ └── settings, folders, etc.     │  │
│  └─────────────────────────────────┘  │
│  ┌─────────────────────────────────┐  │
│  │ localStorage                    │  │
│  │ └── encryptionKey (32 bytes)    │  │
│  └─────────────────────────────────┘  │
└────────────────┬──────────────────────┘
                 │ Extract via MAIN world script
                 ▼
┌───────────────────────────────────────┐
│      Extension Service Worker         │
├───────────────────────────────────────┤
│ 1. Receive extracted data             │
│ 2. Wrap encryption key (optional)     │
│ 3. Package as JSON backup             │
│ 4. Track changes via timestamps       │
│ 5. Upload to cloud storage            │
└────────────────┬──────────────────────┘
                 │ OAuth + REST API
                 ▼
┌───────────────────────────────────────┐
│          Dropbox Storage              │
│  /Apps/VeniceHistorySync/             │
│  ├── backup-2025-12-15T16-00-00.json  │
│  ├── backup-latest.json               │
│  └── encryption-key.enc (wrapped)     │
└───────────────────────────────────────┘
```

#### Backup File Format

```json
{
  "version": "1.0",
  "exportedAt": "2025-12-15T16:00:00.000Z",
  "veniceDbVersion": 210,
  "ownerId": "0x5d3819BE3Dd5bA41C784c56b54CfA0D3Dc875044",
  "stores": {
    "conversations": [...],   // Already encrypted by Venice
    "messages": [...],        // Already encrypted by Venice
    "messageIds": [...],      // Unencrypted metadata
    "messageImages": [...],   // Already encrypted by Venice
    "folders": [...],
    "settings": [...],
    "characters": [...],
    "personas": [...],
    "userSystemPrompts": [...]
  },
  "checksums": {
    "conversations": "sha256:...",
    "messages": "sha256:..."
  }
}
```

#### Sync Frequency Options

1. **Manual**: User clicks "Sync Now"
2. **On Change**: Detect storage changes, debounce, sync
3. **Periodic**: Every N minutes (using `chrome.alarms`)
4. **On Close**: Sync when Venice.ai tab closes

**Recommended Default**: On Change + Periodic (every 30 min)

#### Conflict Resolution

- Use timestamps to detect conflicts
- Keep last N versions (configurable)
- Merge strategy: Last Write Wins with version history

---

## Architecture Design

### Component Overview

```
archiv/
├── manifest.json           # Extension manifest (MV3)
├── background/
│   └── service-worker.js   # Background service worker
├── content/
│   └── venice-extractor.js # Injected into venice.ai
├── popup/
│   ├── popup.html          # Extension popup UI
│   ├── popup.js            # Popup logic
│   └── popup.css           # Popup styles
├── options/
│   ├── options.html        # Settings page
│   └── options.js          # Settings logic
├── lib/
│   ├── crypto.js           # Encryption utilities
│   ├── dropbox-client.js   # Dropbox API wrapper
│   ├── storage-manager.js  # Local storage management
│   └── sync-engine.js      # Sync orchestration
└── assets/
    └── icons/              # Extension icons
```

### Manifest.json (Manifest V3)

```json
{
  "manifest_version": 3,
  "name": "Venice History Sync",
  "version": "1.0.0",
  "description": "Securely backup and sync your Venice.ai chat history to cloud storage",
  
  "permissions": [
    "storage",
    "alarms",
    "tabs",
    "scripting",
    "identity"
  ],
  
  "host_permissions": [
    "https://venice.ai/*",
    "https://api.dropboxapi.com/*",
    "https://content.dropboxapi.com/*",
    "https://www.dropbox.com/oauth2/*"
  ],
  
  "background": {
    "service_worker": "background/service-worker.js",
    "type": "module"
  },
  
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "assets/icons/icon16.png",
      "48": "assets/icons/icon48.png",
      "128": "assets/icons/icon128.png"
    }
  },
  
  "options_page": "options/options.html",
  
  "icons": {
    "16": "assets/icons/icon16.png",
    "48": "assets/icons/icon48.png",
    "128": "assets/icons/icon128.png"
  }
}
```

---

## Key Implementation Challenges

### Challenge 1: Accessing Page's IndexedDB ✅ SOLVED

**Problem**: Content scripts can't access the page's IndexedDB directly.

**Solution**: Use `chrome.scripting.executeScript` with `world: "MAIN"`:

```javascript
// service-worker.js
async function extractVeniceData(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      // This runs in Venice.ai's context - has access to venice-db-encrypted
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('venice-db-encrypted', 210);
        request.onsuccess = (event) => {
          const db = event.target.result;
          const stores = ['conversations', 'messages', 'messageIds', 
                          'messageImages', 'folders', 'settings'];
          const data = {};
          
          // Extract each store
          const tx = db.transaction(stores, 'readonly');
          // ... iterate and collect records
          resolve(data);
        };
      });
    }
  });
  return results[0].result;
}
```

### Challenge 2: Handling Encrypted Data Format

**Problem**: Venice stores `__encryptedData` as byte objects like `{"0": 208, "1": 194, ...}`.

**Solution**: Convert to efficient format for storage/transfer:

```javascript
// Convert byte object to Base64 for JSON storage
function byteObjectToBase64(byteObj) {
  const length = Object.keys(byteObj).length;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = byteObj[i];
  }
  return btoa(String.fromCharCode(...bytes));
}

// Convert back for restoration
function base64ToByteObject(base64) {
  const binary = atob(base64);
  const bytes = {};
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
```

### Challenge 3: Large Data Sets

**Problem**: Users may have hundreds of conversations with images.

**Solutions**:
- Convert encrypted byte objects to Base64 (more compact JSON)
- Use chunked uploads for large backups (Dropbox supports this)
- Implement incremental sync (only changed conversations via timestamps)
- Consider splitting large backups: `conversations.json`, `messages.json`, etc.

### Challenge 4: OAuth in Extensions ✅ SOLVED

**Problem**: Browser extensions have specific OAuth requirements.

**Solution**: Use `chrome.identity` API for OAuth flow:

```javascript
// Using chrome.identity.launchWebAuthFlow for Dropbox PKCE
async function authenticateDropbox() {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  
  const authUrl = new URL('https://www.dropbox.com/oauth2/authorize');
  authUrl.searchParams.set('client_id', DROPBOX_APP_KEY);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('redirect_uri', chrome.identity.getRedirectURL());
  
  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true
  });
  
  // Extract code and exchange for tokens
}
```

### Challenge 4: Detecting Storage Changes

**Problem**: Need to know when Venice.ai updates storage.

**Solutions**:
1. Poll IndexedDB periodically (simple but battery-intensive)
2. Use MutationObserver on DOM elements that reflect chat state
3. Intercept IndexedDB operations (complex)
4. User-triggered sync only (simplest)

**Recommendation**: Start with periodic check (every 5 min when tab active) + manual sync.

---

## User Experience Flow

### First-Time Setup

1. Install extension
2. Click extension icon → popup shows "Setup Required"
3. Click "Connect Cloud Storage" → OAuth flow
4. Optional: Set encryption password
5. Click "Initial Backup" → extracts and uploads all history

### Ongoing Use

1. Extension icon shows sync status (green checkmark / orange warning)
2. Auto-syncs based on user preferences
3. Popup shows:
   - Last sync time
   - Number of conversations backed up
   - Sync now button
   - Settings link

### Restore Flow

1. User on new device/browser
2. Installs extension, connects same cloud account
3. Click "Restore from Backup"
4. Extension downloads, decrypts, injects history into Venice.ai storage

---

## Development Phases (Updated)

### Phase 1: MVP (1-2 weeks) ✅ Research Complete
- [x] Venice.ai storage structure discovery
- [x] Document database schema and encryption
- [ ] Create Dropbox developer app
- [ ] Basic extraction script (MAIN world)
- [ ] Manual backup to Dropbox
- [ ] Simple popup UI

### Phase 2: Encryption Key Handling (1 week)
- [ ] Extract and safely store Venice's encryption key
- [ ] Optional passphrase wrapping for cloud sync
- [ ] Key export/import for manual backup

### Phase 3: Sync Engine (1-2 weeks)
- [ ] Automatic change detection (via timestamps)
- [ ] Incremental sync (only new/modified records)
- [ ] Conflict resolution (timestamp-based)
- [ ] Version history in Dropbox

### Phase 4: Restore & Polish (1-2 weeks)
- [ ] Restore functionality (write back to IndexedDB)
- [ ] Cross-device testing
- [ ] Error handling & retry logic
- [ ] User documentation

### Phase 5: Additional Features (Future)
- [ ] Google Drive support
- [ ] Export to markdown/JSON
- [ ] Search across backed-up history
- [ ] Safari/Firefox ports

---

## Prerequisites for Development

### 1. Dropbox App Setup

1. Go to https://www.dropbox.com/developers/apps
2. Create new app with these settings:
   - API: Scoped access
   - Access type: App folder (safer) or Full Dropbox
   - Name: "Venice History Sync" (or similar)
3. Configure:
   - Add redirect URI: `https://<extension-id>.chromiumapp.org/`
   - Enable PKCE
   - Note the App Key (no secret needed for PKCE)

### 2. Development Environment

- Chrome/Chromium browser
- Node.js (for build tools if needed)
- Text editor with JS support

### 3. Venice.ai Account

- Active Venice.ai account with chat history
- For testing different scenarios

---

## Open Questions ✅ RESOLVED

| Question | Answer |
|----------|--------|
| Venice.ai Storage Structure | `venice-db-encrypted` IndexedDB v210 with field-level encryption |
| Database names | Primary: `venice-db-encrypted`, others are wallet-related (skip) |
| Object stores | conversations, messages, messageIds, messageImages, folders, settings, etc. |
| Data Schema | See "Critical Data Structures" section above |
| Encryption | AES with 32-byte key in localStorage `encryptionKey` |
| User identity | Ethereum wallet address as `ownerId` |
| Restore Mechanism | TBD - need to test writing to IndexedDB with Venice's schema |

---

## Risk Assessment (Updated)

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Venice changes DB version | High | Medium | Version detection in extraction, adapter pattern |
| Venice changes encryption | High | Low | Detect encryption settings changes, alert user |
| Cloud API rate limits | Medium | Low | Exponential backoff, batch operations |
| Encryption key loss | High | Medium | Clear warnings, require passphrase backup for cloud |
| Large image attachments | Medium | Medium | Separate image backup, compression |
| Restore corrupts Venice state | High | Low | Backup before restore, validate schema |

---

## Next Steps

1. **Create Dropbox App**: https://www.dropbox.com/developers/apps
   - Scoped access, App folder
   - Enable PKCE, add redirect URI

2. **Scaffold Extension**: Create basic Manifest V3 extension structure

3. **Build Extraction**: MAIN world script to extract all Venice stores

4. **Test Backup**: Manual upload to Dropbox

5. **Iterate**: Add sync, restore, UI polish

---

## Resources

- [Chrome Extensions MV3 Documentation](https://developer.chrome.com/docs/extensions/mv3/)
- [Chrome Scripting API - MAIN world](https://developer.chrome.com/docs/extensions/reference/api/scripting#type-ExecutionWorld)
- [Dropbox API Documentation](https://www.dropbox.com/developers/documentation)
- [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
- [IndexedDB API](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
