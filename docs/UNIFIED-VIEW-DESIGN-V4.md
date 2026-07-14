# Venice History Sync - Unified View Design (V4)

## ✅ CONFIRMED: Encryption Format (December 2025)

Testing confirmed Venice uses **NaCl secretbox** encryption:

| Property | Value |
|----------|-------|
| Algorithm | XSalsa20-Poly1305 (NaCl secretbox) |
| Library | tweetnacl |
| Key Size | 32 bytes |
| Nonce Size | 24 bytes |
| Auth Tag | 16 bytes (Poly1305 MAC) |
| Format | `[24-byte nonce][ciphertext + tag]` |

**Message structure** (decrypted JSON):
```
id, parentMessageId, conversationId, content, reasoningContent,
createdAtUnixTimestamp, updatedAtUnixTimestamp, references, role,
modelId, modelName, modelType, isSimpleVeniceMode, textSettings,
executionTime, queriedInternet, imageSettings, systemPrompt, $types
```

---

## Core Concept

The extension becomes the **single source of truth** for all Venice history. The browser is just a "viewport" into this history.

```
┌─────────────────────────────────────────────────────────────────┐
│                      EXTENSION (Master View)                    │
│                                                                 │
│   Stores ALL conversations from ALL keys                        │
│   Shows unified timeline                                        │
│   Handles re-encryption transparently                           │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                        ▲           │                            │
│              Real-time │           │ On-demand                  │
│              capture   │           │ injection                  │
│                        │           ▼                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│                      BROWSER (Viewport)                         │
│                                                                 │
│   Venice.ai UI                                                  │
│   Only sees conversations with CURRENT key                      │
│   Extension injects old conversations as needed                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Key Innovation: On-Demand Re-Encryption

When user clicks an old conversation (encrypted with Key A) but browser has Key B:

```javascript
async function loadConversationToBrowser(conversationId) {
  // 1. Find which key pool this conversation is in
  const pool = await findPoolForConversation(conversationId);
  const oldKey = await getKeyFromVault(pool.keyHash);
  
  // 2. Get current browser key
  const currentKey = await getBrowserKey();
  
  // 3. If same key, just ensure it's in browser
  if (oldKey.hash === currentKey.hash) {
    await ensureInBrowser(conversationId, pool);
    return;
  }
  
  // 4. Different key - re-encrypt!
  const conversation = await pool.getConversation(conversationId);
  const messages = await pool.getMessages(conversationId);
  
  // Decrypt with old key
  const decryptedConv = await decrypt(conversation.__encryptedData, oldKey);
  const decryptedMsgs = await Promise.all(
    messages.map(m => decrypt(m.__encryptedData, oldKey))
  );
  
  // Re-encrypt with current key
  const reencryptedConv = await encrypt(decryptedConv, currentKey);
  const reencryptedMsgs = await Promise.all(
    decryptedMsgs.map(m => encrypt(m, currentKey))
  );
  
  // 5. Write to browser with new encryption
  await writeToBrowser({
    ...conversation,
    __encryptedData: reencryptedConv
  });
  
  for (const msg of reencryptedMsgs) {
    await writeMessageToBrowser(msg);
  }
  
  // 6. Also save re-encrypted version to current key's pool
  //    (so we don't have to re-encrypt again)
  await saveToPool(currentKey.hash, conversation, messages);
  
  // 7. Navigate Venice to this conversation
  window.location.href = `https://venice.ai/chat/${conversationId}`;
}
```

## Understanding Venice's Encryption

### Discovery Task: Encryption Format

We need to reverse-engineer Venice's encryption. Run this in console on Venice.ai:

```javascript
// Attempt to understand the encryption format
async function analyzeEncryption() {
  // Get the key
  const keyStr = localStorage.getItem('encryptionKey');
  const keyBytes = new Uint8Array(keyStr.split(',').map(Number));
  console.log('Key length:', keyBytes.length, 'bytes');  // Should be 32 (AES-256)
  
  // Get a sample encrypted message
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('venice-db-encrypted', 210);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  
  const tx = db.transaction('messages', 'readonly');
  const store = tx.objectStore('messages');
  const messages = await new Promise((resolve) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
  });
  
  if (messages.length === 0) {
    console.log('No messages to analyze');
    return;
  }
  
  const sample = messages[0];
  const encData = sample.__encryptedData;
  
  // Convert byte object to Uint8Array
  const encBytes = new Uint8Array(Object.keys(encData).length);
  for (let i = 0; i < encBytes.length; i++) {
    encBytes[i] = encData[i];
  }
  
  console.log('Encrypted data length:', encBytes.length, 'bytes');
  console.log('First 32 bytes (might be IV/nonce):', 
    Array.from(encBytes.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' '));
  
  // Common patterns:
  // - AES-GCM: 12-byte nonce + ciphertext + 16-byte auth tag
  // - AES-CBC: 16-byte IV + ciphertext (padded to block size)
  
  // Try to identify
  if (encBytes.length >= 12 && (encBytes.length - 12) % 16 === 0) {
    console.log('Possible AES-GCM: 12-byte nonce + ciphertext');
  }
  if (encBytes.length % 16 === 0) {
    console.log('Possible AES-CBC: 16-byte blocks');
  }
  
  return { keyBytes, encBytes, sample };
}

// Also look for any crypto-related code in Venice's JS
// Search for: crypto.subtle, AES, GCM, CBC, encrypt, decrypt
```

### Likely Encryption Scheme

Based on modern web practices and the 32-byte key, Venice likely uses:

```
AES-256-GCM (most probable):
┌──────────────────────────────────────────────────────┐
│ 12 bytes │        variable length        │ 16 bytes │
│  nonce   │         ciphertext            │ auth tag │
└──────────────────────────────────────────────────────┘

Decryption:
1. Extract nonce (first 12 bytes)
2. Extract auth tag (last 16 bytes)
3. Ciphertext is the middle
4. crypto.subtle.decrypt({name: "AES-GCM", iv: nonce}, key, ciphertext)
```

### Re-encryption Implementation

```javascript
// Assuming AES-256-GCM (we'll verify with discovery)
class VeniceEncryption {
  static async importKey(keyBytes) {
    return crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
  }
  
  static async decrypt(encryptedData, keyBytes) {
    const key = await this.importKey(keyBytes);
    
    // Convert byte object to Uint8Array
    const data = this.byteObjectToArray(encryptedData);
    
    // Extract IV (first 12 bytes for GCM)
    const iv = data.slice(0, 12);
    const ciphertext = data.slice(12);  // Rest includes auth tag
    
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
    
    return new TextDecoder().decode(decrypted);
  }
  
  static async encrypt(plaintext, keyBytes) {
    const key = await this.importKey(keyBytes);
    
    // Generate new IV
    const iv = crypto.getRandomValues(new Uint8Array(12));
    
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plaintext)
    );
    
    // Combine IV + ciphertext
    const result = new Uint8Array(iv.length + encrypted.byteLength);
    result.set(iv);
    result.set(new Uint8Array(encrypted), iv.length);
    
    return this.arrayToByteObject(result);
  }
  
  static byteObjectToArray(obj) {
    const length = Object.keys(obj).length;
    const arr = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      arr[i] = obj[i];
    }
    return arr;
  }
  
  static arrayToByteObject(arr) {
    const obj = {};
    for (let i = 0; i < arr.length; i++) {
      obj[i] = arr[i];
    }
    return obj;
  }
}
```

---

## Storage Architecture (Revised)

Since we're now doing re-encryption, we can store DECRYPTED content in our vault (encrypted at rest with our own key if desired):

```
~/Dropbox/VeniceBackup/
│
├── .venice-sync/
│   ├── config.json
│   ├── master-index.json       # Index of ALL conversations
│   └── sync-state.json
│
├── keys/                        # Still keep all keys
│   ├── k_a1b2c3d4.json
│   └── k_e5f6g7h8.json
│
├── conversations/               # DECRYPTED content!
│   ├── conv_abc123/
│   │   ├── meta.json           # Title, dates, original key
│   │   ├── messages.json       # All messages, decrypted
│   │   └── images/             # Any images, decrypted
│   ├── conv_def456/
│   └── ...
│
└── archive/
    └── ...
```

### Master Index

```json
// .venice-sync/master-index.json
{
  "conversations": [
    {
      "id": "abc123",
      "title": "Help me debug this React code",
      "preview": "I'm getting an error when...",
      "createdAt": "2025-12-15T14:00:00Z",
      "updatedAt": "2025-12-15T14:30:00Z",
      "messageCount": 8,
      "originalKeyHash": "a1b2c3d4",
      "inBrowser": true,
      "browserKeyHash": "a1b2c3d4"
    },
    {
      "id": "def456",
      "title": "Tax planning strategies",
      "preview": "What are some ways to...",
      "createdAt": "2025-12-07T10:00:00Z",
      "updatedAt": "2025-12-07T11:00:00Z",
      "messageCount": 15,
      "originalKeyHash": "old_key_xyz",
      "inBrowser": false,
      "browserKeyHash": null
    }
  ],
  "totalConversations": 44,
  "totalMessages": 387,
  "lastUpdated": "2025-12-15T16:00:00Z"
}
```

### Conversation Storage (Decrypted)

```json
// conversations/conv_abc123/meta.json
{
  "id": "abc123",
  "title": "Help me debug this React code",
  "ownerId": "0x5d38...",
  "folderId": null,
  "createdAt": "2025-12-15T14:00:00Z",
  "updatedAt": "2025-12-15T14:30:00Z",
  "originalKeyHash": "a1b2c3d4",
  "model": "llama-3.1-405b"
}

// conversations/conv_abc123/messages.json
{
  "messages": [
    {
      "id": "msg001",
      "role": "user",
      "content": "I'm getting an error when I try to...",
      "createdAt": "2025-12-15T14:00:00Z"
    },
    {
      "id": "msg002",
      "role": "assistant",
      "content": "Looking at your code, the issue is...",
      "createdAt": "2025-12-15T14:00:15Z",
      "executionTime": 3200
    }
  ]
}
```

### Security Option: Encrypt at Rest

If user wants vault encrypted too:

```javascript
// User sets a vault passphrase
const vaultKey = await deriveKeyFromPassphrase(userPassphrase);

// All conversation files encrypted with vault key
// Separate from Venice's keys
```

---

## UI Design: Unified Timeline

### Main View

```
┌─────────────────────────────────────────────────────────────────┐
│ Venice History                                         [⚙️] [↻] │
├─────────────────────────────────────────────────────────────────┤
│ 🔍 Search conversations...                          [Filters ▼] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ ● LIVE  Venice.ai is open                                       │
│                                                                 │
│ ─────────────────────────────────────────────────────────────── │
│                                                                 │
│ Today                                                           │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 🟢 Help me debug this React code                   2m ago   │ │
│ │    "I'm getting an error when I try to..."                  │ │
│ │    8 messages                                               │ │
│ └─────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 🟢 Generate a sunset image                         1h ago   │ │
│ │    "Create a beautiful sunset over mountains..."            │ │
│ │    3 messages, 1 image                                      │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ This Week                                                       │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 🔵 Plan my trip to Japan                           Dec 14   │ │
│ │    "I want to visit Tokyo and Kyoto..."                     │ │
│ │    12 messages                              [Load to Venice]│ │
│ └─────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 🔵 Explain quantum computing                       Dec 14   │ │
│ │    "Can you explain quantum entanglement..."                │ │
│ │    6 messages                               [Load to Venice]│ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ Earlier                                                         │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 🔵 Tax planning strategies                         Dec 7    │ │
│ │    "What are some ways to minimize..."                      │ │
│ │    15 messages                              [Load to Venice]│ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ─────────────────────────────────────────────────────────────── │
│ 🟢 In browser (44)    🔵 In backup only (12)    Total: 56      │
└─────────────────────────────────────────────────────────────────┘

Legend:
🟢 = In browser with current key (accessible in Venice UI)
🔵 = In backup only (click to load → will re-encrypt if needed)
```

### Clicking a 🔵 Conversation

```
┌─────────────────────────────────────────────────────────────────┐
│ Load Conversation                                      [Cancel] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ 📝 "Tax planning strategies"                                    │
│                                                                 │
│ This conversation is in your backup but not currently in        │
│ your browser.                                                   │
│                                                                 │
│ ⓘ It was created with a different encryption key.               │
│   It will be re-encrypted with your current key to make         │
│   it accessible in Venice.                                      │
│                                                                 │
│ Preview:                                                        │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ You: What are some ways to minimize taxes legally?          │ │
│ │                                                             │ │
│ │ AI: There are several legitimate strategies for tax         │ │
│ │     optimization. First, maximizing retirement account      │ │
│ │     contributions...                                        │ │
│ │                                                             │ │
│ │ (15 messages total)                                         │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│         [ Load to Venice ]    [ Just View Here ]                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### "Just View Here" - Read-Only in Extension

```
┌─────────────────────────────────────────────────────────────────┐
│ ← Back                            Tax planning strategies       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ Dec 7, 2025                                                     │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 👤 You                                              10:00 AM │ │
│ │                                                             │ │
│ │ What are some ways to minimize taxes legally?               │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 🤖 Assistant                                        10:00 AM │ │
│ │                                                             │ │
│ │ There are several legitimate strategies for tax             │ │
│ │ optimization:                                               │ │
│ │                                                             │ │
│ │ 1. **Maximize retirement contributions** - 401(k), IRA      │ │
│ │ 2. **Health Savings Account (HSA)** - Triple tax advantage  │ │
│ │ 3. **Tax-loss harvesting** - Offset gains with losses       │ │
│ │ ...                                                         │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ (scrollable, 15 messages)                                       │
│                                                                 │
│ ─────────────────────────────────────────────────────────────── │
│ [ Load to Venice (to continue conversation) ]  [ Export ]       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Real-Time Sync

### Watching for Changes

```javascript
// Content script injected into Venice.ai
class VeniceWatcher {
  constructor() {
    this.lastKnownState = null;
    this.pollInterval = 5000; // 5 seconds
  }
  
  async start() {
    // Initial sync
    await this.syncToExtension();
    
    // Poll for changes (IndexedDB doesn't have change events)
    setInterval(() => this.checkForChanges(), this.pollInterval);
    
    // Also watch for navigation (new conversation started)
    this.watchNavigation();
  }
  
  async checkForChanges() {
    const currentState = await this.getVeniceState();
    
    if (this.hasChanges(currentState)) {
      await this.syncToExtension();
      this.lastKnownState = currentState;
    }
  }
  
  async getVeniceState() {
    const key = localStorage.getItem('encryptionKey');
    const conversations = await this.readStore('conversations');
    const messages = await this.readStore('messages');
    
    return {
      keyHash: hashKey(key),
      conversationIds: conversations.map(c => c.id),
      messageCount: messages.length,
      latestTimestamp: Math.max(...messages.map(m => m.updatedAtUnixTimestamp))
    };
  }
  
  async syncToExtension() {
    const data = await this.extractAllData();
    
    // Send to service worker
    chrome.runtime.sendMessage({
      type: 'VENICE_DATA_UPDATE',
      payload: data
    });
  }
}
```

### Service Worker Handling

```javascript
// service-worker.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'VENICE_DATA_UPDATE') {
    handleVeniceUpdate(message.payload);
  }
});

async function handleVeniceUpdate(data) {
  const { keyHash, conversations, messages } = data;
  
  // Ensure key is in vault
  await ensureKeyInVault(keyHash, data.keyBytes);
  
  // Decrypt and store each conversation
  for (const conv of conversations) {
    const decrypted = await decryptConversation(conv, data.keyBytes);
    await saveToMasterStore(conv.id, decrypted, keyHash);
  }
  
  // Update master index
  await updateMasterIndex();
  
  // Update badge
  chrome.action.setBadgeText({ text: '' }); // Clear "needs sync" indicator
}
```

---

## Workflow Summary

### User Creates New Chat

```
1. User types in Venice.ai
2. Venice encrypts with current key, stores in IndexedDB
3. Extension watcher detects new message (poll)
4. Extension decrypts, stores in vault
5. Extension UI updates to show new conversation
6. No user action needed - happens automatically
```

### User Wants Old Conversation

```
1. User opens extension, sees unified timeline
2. Clicks on old conversation (🔵 - different key)
3. Extension shows preview (already decrypted in vault)
4. User clicks "Load to Venice"
5. Extension re-encrypts with current browser key
6. Extension writes to browser IndexedDB
7. Extension opens Venice to that conversation URL
8. Venice shows the conversation (thinks it's native)
9. Status changes 🔵 → 🟢
```

### Browser Gets Cleared

```
1. User clears browser data
2. Venice shows empty (new key generated)
3. User opens extension
4. Extension shows: "Browser empty, 56 conversations in backup"
5. All conversations show as 🔵
6. User can click any to load (re-encrypted with new key)
7. Or bulk action: "Load all to browser"
```

---

## Benefits of This Approach

| Aspect | Previous (V3) | New (V4) |
|--------|--------------|----------|
| User sees keys | Yes, must manage | No, transparent |
| View all history | Must switch keys | Single unified view |
| Access old data | Manual key switch | One click, auto re-encrypt |
| Mental model | Multiple isolated pools | Single timeline |
| Browser cleared | Choose which key | Just reload what you need |

---

## Technical Challenges

### 1. Discovering Venice's Encryption Algorithm

**Must verify**: AES-GCM vs AES-CBC vs something else

**Next step**: Run encryption analysis script, or inspect Venice's JS bundle

### 2. Performance with Large Histories

**Concern**: Re-encrypting 1000 messages

**Mitigation**: 
- Do it lazily (only when user requests)
- Cache re-encrypted versions
- Show progress for bulk operations

### 3. Keeping Extension in Sync

**Concern**: Browser and extension getting out of sync

**Mitigation**:
- Frequent polling (every 5s when Venice tab active)
- Manual "Refresh" button
- Show sync status indicator

### 4. Image/Video Handling

**Concern**: Large binary data

**Mitigation**:
- Store images as separate files
- Lazy-load in preview
- Show thumbnails in extension UI

---

## Next Steps

1. **Verify encryption scheme** - Run analysis script on Venice
2. **Build re-encryption proof of concept** - Confirm we can decrypt/re-encrypt
3. **Scaffold extension** - Basic structure with unified UI
4. **Implement watcher** - Real-time sync from browser
5. **Add "Load to Venice"** - Re-encryption + injection flow
