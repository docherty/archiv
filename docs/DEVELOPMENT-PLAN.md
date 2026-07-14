# Venice History Sync Extension - Development Plan

> Current implementation tracking lives in [DURABLE-LOCAL-ARCHIVE-IMPLEMENTATION-PLAN.md](DURABLE-LOCAL-ARCHIVE-IMPLEMENTATION-PLAN.md). The repository format is defined in [DURABLE-LOCAL-ARCHIVE-SPEC.md](DURABLE-LOCAL-ARCHIVE-SPEC.md), operator verification is documented in [VERIFY-LOCAL-ARCHIVE.md](VERIFY-LOCAL-ARCHIVE.md), and the current delivery summary is in [DURABLE-LOCAL-ARCHIVE-DELIVERY-SUMMARY.md](DURABLE-LOCAL-ARCHIVE-DELIVERY-SUMMARY.md). Use the checklist as the canonical progress file for the durable local archive repository work, and check off items there as they are completed.

## Project Overview

A Chrome extension that provides persistent, cross-device Venice.ai chat history by:
1. Backing up conversations to a local folder (synced via Dropbox/iCloud)
2. Preserving all encryption keys forever
3. Providing a unified view of ALL history regardless of which key encrypted it
4. Re-encrypting old conversations on-demand when loading into browser

## ✅ Confirmed Technical Details

| Property | Value |
|----------|-------|
| **Algorithm** | XSalsa20-Poly1305 (NaCl secretbox) |
| **Library** | tweetnacl |
| **Key Size** | 32 bytes |
| **Nonce Size** | 24 bytes |
| **Auth Tag** | 16 bytes (Poly1305 MAC) |
| **Format** | `[24-byte nonce][ciphertext + tag]` |
| **Database** | IndexedDB `venice-db-encrypted` v210 |
| **Key Storage** | `localStorage.encryptionKey` (comma-separated bytes) |

**Message structure** (decrypted JSON):
```
id, parentMessageId, conversationId, content, reasoningContent,
createdAtUnixTimestamp, updatedAtUnixTimestamp, references, role,
modelId, modelName, modelType, isSimpleVeniceMode, textSettings,
executionTime, queriedInternet, imageSettings, systemPrompt, $types
```

---

## Development Phases

### Phase 1: Core Infrastructure
- [ ] Create manifest.json (Manifest V3)
- [ ] Set up content script for Venice.ai
- [ ] Implement encryption module using tweetnacl
- [ ] Create storage manager for backup folder (File System Access API)

### Phase 2: Backup System
- [ ] Watch for new conversations/messages in IndexedDB
- [ ] Decrypt and store in backup folder as JSON
- [ ] Preserve encryption key in key vault
- [ ] Handle conversation updates (edits, new messages)

### Phase 3: Extension UI
- [ ] Popup with unified conversation list
- [ ] Search across all history
- [ ] Show which key encrypted each conversation
- [ ] Settings panel (backup folder, sync frequency)

### Phase 4: Restore/Sync
- [ ] Detect when browser data is cleared
- [ ] Re-encrypt old conversations with current key
- [ ] Inject into Venice's IndexedDB
- [ ] Cross-device sync via shared folder

### Phase 5: Polish
- [ ] Handle edge cases (partial data, corrupt files)
- [ ] Performance optimization for large histories
- [ ] Export functionality (markdown, JSON)
- [ ] Import from other devices

---

## File Structure (Planned)

```
archiv/
├── manifest.json           # Extension manifest (MV3)
├── package.json            # For build tools
├── src/
│   ├── background/
│   │   └── service-worker.js   # Background service worker
│   ├── content/
│   │   └── venice-bridge.js    # Content script for venice.ai
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js
│   ├── lib/
│   │   ├── encryption.js       # NaCl encryption wrapper
│   │   ├── storage.js          # Backup folder manager
│   │   └── venice-db.js        # IndexedDB interface
│   └── shared/
│       └── constants.js
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── docs/
    ├── TECHNICAL-BRIEF.md
    ├── UNIFIED-VIEW-DESIGN-V4.md
    ├── SYNC-PROTOCOL-V3.md
    ├── encryption-analysis.js
    ├── encryption-analysis-v2.js
    ├── test-nacl.js
    └── DEVELOPMENT-PLAN.md     # This file
```

---

## Backup Folder Structure

```
venice-backup/                    # User-selected folder in Dropbox
├── keys/
│   ├── key_abc123.json          # { keyId, keyBytes, firstSeen, lastUsed }
│   └── key_def456.json
├── conversations/
│   ├── conv_Zh02Qa3.json        # Decrypted conversation metadata
│   └── conv_Abc123.json
├── messages/
│   ├── msg_LraHvri.json         # Decrypted message content
│   └── msg_XyzPqr.json
└── sync-state.json              # { lastSync, deviceId, version }
```

---

## Key Design Decisions

### 1. Store Decrypted Content
The extension stores **decrypted** conversation content in the backup folder. This means:
- No key management complexity when viewing history
- Re-encryption only happens when injecting back to browser
- Backup folder should be in a secure location (encrypted drive or trusted cloud)

### 2. File System Access API
Using the modern File System Access API instead of Dropbox API:
- User selects a folder once (persisted permission)
- Works with any sync service (Dropbox, iCloud, Google Drive)
- No API keys or OAuth needed

### 3. Polling for Changes
Instead of complex observers, we poll Venice's IndexedDB:
- Every 5 seconds when tab is active
- Compare with last known state
- Capture new messages immediately

### 4. On-Demand Re-encryption
When user clicks on an old conversation in the extension:
1. Get the current encryption key from Venice
2. Re-encrypt the message with current key
3. Inject into Venice's IndexedDB
4. Navigate Venice to that conversation

---

## Testing Checklist

- [ ] Fresh install - no existing data
- [ ] Existing Venice user with history
- [ ] Key change scenario (logout/login)
- [ ] Browser data cleared - restore flow
- [ ] Cross-device sync (two Macs with same Dropbox)
- [ ] Large history (100+ conversations)
- [ ] Concurrent edits from Venice UI

---

## Resources

- [tweetnacl-js](https://github.com/dchest/tweetnacl-js) - Encryption library
- [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API)
- [Chrome Extension Manifest V3](https://developer.chrome.com/docs/extensions/mv3/)
- [IndexedDB API](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
