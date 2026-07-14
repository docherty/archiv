# Venice History Sync - Robust Design (V3)

## Design Principles

1. **No timing dependencies** - Don't race Venice, work alongside it
2. **User initiates all changes** - Explicit button presses, no automatic overwrites
3. **All keys preserved forever** - Key vault tracks every key ever seen
4. **All data preserved forever** - Organized by which key encrypted it
5. **Clear visibility** - User always knows what state things are in

---

## The Problem with Timing-Based Approach

The previous design tried to restore data BEFORE Venice's JavaScript loaded. This is fragile:

- Extension might load slowly
- Venice might change their initialization order
- Browser might prioritize differently under load
- Race conditions are inherently unpredictable

**New approach**: Don't try to beat Venice. Work with whatever state exists.

---

## New Architecture: Key Vault + Data Pools

```
~/Dropbox/VeniceBackup/
│
├── .venice-sync/
│   ├── config.json              # User preferences
│   └── vault-state.json         # Which key is "active", sync status
│
├── keys/                        # KEY VAULT - never delete from here
│   ├── index.json               # Quick lookup of all keys
│   ├── k_a1b2c3d4.json         # Key file (hash as filename)
│   ├── k_e5f6g7h8.json         # Another key
│   └── k_i9j0k1l2.json         # Yet another key
│
├── pools/                       # DATA POOLS - organized by key
│   ├── k_a1b2c3d4/             # All data encrypted with this key
│   │   ├── conversations/
│   │   │   ├── conv_BNtd6fg.json
│   │   │   └── conv_Zh02Qa3.json
│   │   ├── messages/
│   │   │   └── (organized by conversation)
│   │   └── images/
│   │
│   ├── k_e5f6g7h8/             # Data from different key
│   │   └── ...
│   │
│   └── k_i9j0k1l2/             # Data from yet another key
│       └── ...
│
└── archive/                     # Historical snapshots, never deleted
    └── snapshots/
        ├── 2025-12-15T10-00-00/
        └── 2025-12-15T16-00-00/
```

### Key File Structure

```json
// keys/k_a1b2c3d4.json
{
  "keyHash": "<sha256-of-key-bytes>",      // SHA-256 of the key bytes
  "keyBytes": "<comma-separated-bytes>",   // The actual key
  "metadata": {
    "firstSeen": "2025-12-01T10:00:00Z",  // When we first saw this key
    "lastSeen": "2025-12-15T16:00:00Z",   // Last time it was in browser
    "lastBackup": "2025-12-15T16:00:00Z", // Last time we backed up with it
    "ownerId": "0x5d3819BE3Dd5bA41C784c56b54CfA0D3Dc875044",
    "source": "browser",                   // Where we got it: browser, import, etc.
    "label": "Main laptop key"             // User-editable friendly name
  },
  "stats": {
    "conversationCount": 42,
    "messageCount": 1337,
    "imageCount": 5,
    "totalSizeBytes": 2456789
  }
}
```

### Vault State

```json
// .venice-sync/vault-state.json
{
  "version": "1.0",
  "browserState": {
    "currentKeyHash": "a1b2c3d4...",      // What key is in the browser NOW
    "lastChecked": "2025-12-15T16:00:00Z",
    "conversationCount": 42,
    "isEmpty": false
  },
  "activePoolKey": "a1b2c3d4...",          // Which pool we're syncing with
  "syncStatus": "in_sync",                  // in_sync, browser_ahead, pool_ahead, diverged, empty_browser
  "lastSync": "2025-12-15T16:00:00Z"
}
```

---

## State Machine (No Timing Dependencies)

The extension checks state whenever:
- User opens extension popup
- User navigates to venice.ai
- User clicks "Check Sync Status"

### State Detection

```javascript
async function detectState() {
  // 1. What's in the browser RIGHT NOW?
  const browserKey = localStorage.getItem('encryptionKey');
  const browserKeyHash = browserKey ? hashKey(browserKey) : null;
  const browserData = await readIndexedDB();
  const browserIsEmpty = !browserKey || browserData.conversationCount === 0;
  
  // 2. What's in our vault?
  const vaultKeys = await listVaultKeys();
  const vaultHasData = vaultKeys.length > 0;
  
  // 3. Classify the situation
  if (browserIsEmpty && !vaultHasData) {
    return 'FRESH';           // New user, nothing anywhere
  }
  if (browserIsEmpty && vaultHasData) {
    return 'BROWSER_EMPTY';   // Browser cleared, but we have backup
  }
  if (!browserIsEmpty && !vaultHasData) {
    return 'VAULT_EMPTY';     // Browser has data, we haven't backed up yet
  }
  
  // Both have data - check if they match
  const activePool = await getActivePool();
  if (browserKeyHash === activePool.keyHash) {
    // Same key - compare data
    const comparison = await compareData(browserData, activePool.data);
    if (comparison.identical) {
      return 'IN_SYNC';
    } else if (comparison.browserNewer) {
      return 'BROWSER_AHEAD';   // Browser has stuff not in backup
    } else if (comparison.poolNewer) {
      return 'POOL_AHEAD';      // Backup has stuff not in browser
    } else {
      return 'DIVERGED';        // Both have unique changes
    }
  } else {
    // Different key!
    return 'KEY_MISMATCH';      // Browser using different key than active pool
  }
}
```

---

## User Interface: The Sync Panel

The extension popup always shows current state and available actions:

### State: FRESH (Nothing Anywhere)

```
┌─────────────────────────────────────────────────────────┐
│ Venice History Sync                                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ 📭 No Data Yet                                          │
│                                                         │
│ Your Venice.ai chat history is empty, and you don't    │
│ have any backups yet.                                   │
│                                                         │
│ Start chatting on Venice.ai, then come back here to    │
│ back up your conversations.                             │
│                                                         │
│ ─────────────────────────────────────────────────────── │
│ Backup Folder: ~/Dropbox/VeniceBackup ✓                │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### State: VAULT_EMPTY (Browser Has Data, No Backup)

```
┌─────────────────────────────────────────────────────────┐
│ Venice History Sync                                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ ⚠️ Not Backed Up                                        │
│                                                         │
│ Your browser has Venice data that isn't backed up:      │
│                                                         │
│   💬 42 conversations                                   │
│   📝 1,337 messages                                     │
│   🖼️ 5 images                                           │
│   🔑 1 encryption key                                   │
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │            [ 💾 Back Up Now ]                       │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ This will copy everything to your backup folder.        │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### State: BROWSER_EMPTY (Browser Cleared, Backup Exists)

```
┌─────────────────────────────────────────────────────────┐
│ Venice History Sync                                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ 🔄 Restore Available                                    │
│                                                         │
│ Your browser's Venice data is empty, but you have       │
│ backed up data:                                         │
│                                                         │
│   🔑 Key: "Main laptop" (a1b2c3...)                    │
│   💬 42 conversations                                   │
│   📝 1,337 messages                                     │
│   📅 Last backup: 2 hours ago                          │
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │            [ 🔄 Restore to Browser ]                │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ [ View Backup Contents ]  [ Choose Different Key ]      │
│                                                         │
│ ─────────────────────────────────────────────────────── │
│ ℹ️ After restoring, refresh Venice.ai to see your data │
└─────────────────────────────────────────────────────────┘
```

### State: IN_SYNC (Everything Matches)

```
┌─────────────────────────────────────────────────────────┐
│ Venice History Sync                                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ ✅ In Sync                                              │
│                                                         │
│ Browser and backup are identical.                       │
│                                                         │
│   🔑 Key: "Main laptop" (a1b2c3...)                    │
│   💬 42 conversations                                   │
│   📝 1,337 messages                                     │
│   📅 Last sync: 5 minutes ago                          │
│                                                         │
│ [ 🔍 Check for Changes ]                               │
│                                                         │
│ ─────────────────────────────────────────────────────── │
│ 🔑 Key Vault: 1 key stored                             │
│ [ Manage Keys ]                                         │
└─────────────────────────────────────────────────────────┘
```

### State: BROWSER_AHEAD (Browser Has New Stuff)

```
┌─────────────────────────────────────────────────────────┐
│ Venice History Sync                                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ 📤 Backup Needed                                        │
│                                                         │
│ Your browser has changes not in backup:                 │
│                                                         │
│   ⬆️ 3 new conversations                                │
│   ⬆️ 12 new messages                                    │
│   ⬆️ 1 new image                                        │
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │            [ 💾 Back Up Changes ]                   │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ [ Review Changes First ]                                │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### State: POOL_AHEAD (Backup Has Stuff Not in Browser)

```
┌─────────────────────────────────────────────────────────┐
│ Venice History Sync                                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ 📥 Restore Available                                    │
│                                                         │
│ Your backup has data not in the browser:                │
│                                                         │
│   ⬇️ 5 conversations missing from browser               │
│   ⬇️ 47 messages missing from browser                   │
│                                                         │
│ This can happen if:                                     │
│   • You restored from backup on another device          │
│   • Browser data was partially cleared                  │
│   • Venice deleted old conversations                    │
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │            [ 🔄 Restore Missing Data ]              │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ [ Review What's Missing ]  [ Ignore - Mark as Archived ]│
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### State: DIVERGED (Both Have Unique Changes)

```
┌─────────────────────────────────────────────────────────┐
│ Venice History Sync                                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ ⚠️ Sync Conflict                                        │
│                                                         │
│ Browser and backup have different changes:              │
│                                                         │
│   ⬆️ Browser has: 3 new conversations, 12 messages      │
│   ⬇️ Backup has: 2 conversations not in browser         │
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │            [ 🔀 Review & Merge ]                    │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ Or choose a direction:                                  │
│ [ ⬆️ Backup Browser → Overwrites backup ]              │
│ [ ⬇️ Restore Backup → Overwrites browser ]             │
│                                                         │
│ ℹ️ Nothing is ever deleted - old versions are archived │
└─────────────────────────────────────────────────────────┘
```

### State: KEY_MISMATCH (Different Encryption Key!)

```
┌─────────────────────────────────────────────────────────┐
│ Venice History Sync                                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ 🔑 Different Encryption Key                             │
│                                                         │
│ Your browser is using a DIFFERENT encryption key than   │
│ your backed up data.                                    │
│                                                         │
│ Browser key: e5f6g7h8... (new, 2 conversations)         │
│ Backup key:  a1b2c3d4... (42 conversations)             │
│                                                         │
│ This usually happens after clearing browser data.       │
│                                                         │
│ What would you like to do?                              │
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ [ 🔄 Switch to Backup Key ]                         │ │
│ │ Replace browser key with backup key.                │ │
│ │ Your 42 backed-up conversations become accessible.  │ │
│ │ The 2 new conversations will be saved separately.   │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ [ 💾 Keep Browser Key & Back It Up ]                │ │
│ │ Save browser's new key and its 2 conversations.     │ │
│ │ Your old backup remains accessible separately.      │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ [ 🔑 View All Keys in Vault ]                          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Key Vault Manager

A dedicated UI for managing all encryption keys:

```
┌─────────────────────────────────────────────────────────┐
│ 🔑 Key Vault                                   [← Back] │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ All encryption keys are preserved here. Each key        │
│ can only decrypt data that was encrypted with it.       │
│                                                         │
│ ─────────────────────────────────────────────────────── │
│                                                         │
│ 🔑 "Main laptop" (a1b2c3d4...)          ★ ACTIVE       │
│    Created: Dec 1, 2025                                │
│    Last used: Dec 15, 2025                             │
│    Data: 42 conversations, 1,337 messages              │
│    Status: ✅ In browser                               │
│    [ Make Active ] [ Rename ] [ View Data ]            │
│                                                         │
│ ─────────────────────────────────────────────────────── │
│                                                         │
│ 🔑 "After browser clear" (e5f6g7h8...)                 │
│    Created: Dec 15, 2025                               │
│    Last used: Dec 15, 2025                             │
│    Data: 2 conversations, 8 messages                   │
│    Status: ⚠️ In browser (not active pool)             │
│    [ Make Active ] [ Rename ] [ View Data ]            │
│                                                         │
│ ─────────────────────────────────────────────────────── │
│                                                         │
│ 🔑 "Old phone" (i9j0k1l2...)                           │
│    Created: Nov 15, 2025                               │
│    Last used: Nov 20, 2025                             │
│    Data: 15 conversations, 234 messages                │
│    Status: 📦 Archived                                 │
│    [ Make Active ] [ Rename ] [ View Data ]            │
│                                                         │
│ ─────────────────────────────────────────────────────── │
│                                                         │
│ [ 📥 Import Key ] [ 📤 Export Key ]                    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Sync Operations (All User-Initiated)

### Operation: Back Up Browser → Pool

```
USER CLICKS: "Back Up Changes" or "Back Up Now"

1. CONFIRM
   Show: "This will copy browser data to your backup. Continue?"
   User clicks: [Yes, Back Up]

2. SNAPSHOT (safety net)
   Create: archive/snapshots/{timestamp}/
   Copy: entire current pool state

3. EXTRACT
   Read: all data from browser IndexedDB
   Read: encryption key from localStorage

4. SAVE KEY (if new)
   If key not in vault:
     Create: keys/k_{hash}.json
     Log: "New key discovered and saved"

5. SAVE DATA
   For each conversation:
     Write: pools/k_{hash}/conversations/conv_{id}.json
   For each message:
     Write: pools/k_{hash}/messages/{conv_id}/msg_{id}.json
   For each image:
     Write: pools/k_{hash}/images/img_{id}.json

6. UPDATE STATE
   Write: .venice-sync/vault-state.json
   Log: operation to sync.log

7. CONFIRM TO USER
   Show: "✅ Backed up 3 conversations, 12 messages"
```

### Operation: Restore Pool → Browser

```
USER CLICKS: "Restore to Browser" or "Restore Missing Data"

1. CONFIRM
   Show: "This will write data to your browser. Continue?"
   If browser not empty:
     Show: "Browser has existing data. It will be merged/replaced."
   User clicks: [Yes, Restore]

2. GET KEY
   Read: key from keys/k_{activeKeyHash}.json

3. WRITE KEY TO BROWSER
   localStorage.setItem('encryptionKey', keyBytes)
   ⚠️ This is the critical step

4. WRITE DATA TO BROWSER
   Open: IndexedDB 'venice-db-encrypted'
   For each conversation in pool:
     Write: to conversations store
   For each message in pool:
     Write: to messages store
   For each image in pool:
     Write: to messageImages store

5. UPDATE STATE
   Write: .venice-sync/vault-state.json
   Log: operation to sync.log

6. PROMPT USER
   Show: "✅ Restored 42 conversations. Please refresh Venice.ai"
   Button: [ Refresh Venice.ai Tab ]
```

### Operation: Switch Key

```
USER CLICKS: "Switch to Backup Key" or "Make Active" on a key

1. CONFIRM
   Show: "Switch to key 'Main laptop' (a1b2c3d4...)?"
   Show: "This key has 42 conversations."
   Show: "Current browser key will be saved to vault first."
   User clicks: [Yes, Switch]

2. SAVE CURRENT (if browser has data)
   If browser has key and data:
     Back up browser → new/existing pool
     Show: "Saved current data to vault"

3. WRITE NEW KEY
   localStorage.setItem('encryptionKey', selectedKeyBytes)

4. WRITE DATA
   Clear IndexedDB stores
   Write all data from selected pool

5. UPDATE STATE
   Set activePoolKey = selected key hash
   Write: vault-state.json

6. PROMPT USER
   Show: "✅ Switched to key 'Main laptop'. Please refresh Venice.ai"
```

---

## Data Flow Diagrams

### Normal Backup Flow
```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│   Venice     │         │  Extension   │         │   Backup     │
│   Browser    │         │   Popup      │         │   Folder     │
└──────┬───────┘         └──────┬───────┘         └──────┬───────┘
       │                        │                        │
       │ User creates chats     │                        │
       │◄──────────────────────►│                        │
       │                        │                        │
       │      User clicks popup │                        │
       │                        │                        │
       │      "Back Up Now"     │                        │
       │      ─────────────────►│                        │
       │                        │                        │
       │      Extract data      │                        │
       │◄───────────────────────│                        │
       │                        │                        │
       │      Return data       │                        │
       │────────────────────────►                        │
       │                        │                        │
       │                        │ Write to files         │
       │                        │───────────────────────►│
       │                        │                        │
       │                        │ "Backup complete!"     │
       │                        │◄───────────────────────│
       │                        │                        │
```

### Recovery Flow (Post Browser Clear)
```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│   Venice     │         │  Extension   │         │   Backup     │
│   Browser    │         │   Popup      │         │   Folder     │
└──────┬───────┘         └──────┬───────┘         └──────┬───────┘
       │                        │                        │
       │ (Browser cleared)      │                        │
       │ Venice shows empty     │                        │
       │                        │                        │
       │      User notices empty│                        │
       │      User clicks popup │                        │
       │                        │                        │
       │      Check browser     │                        │
       │◄───────────────────────│                        │
       │      (empty!)          │                        │
       │────────────────────────►                        │
       │                        │                        │
       │                        │ Check backup           │
       │                        │───────────────────────►│
       │                        │ (has data!)            │
       │                        │◄───────────────────────│
       │                        │                        │
       │      Show: "Restore    │                        │
       │      Available"        │                        │
       │                        │                        │
       │      User clicks       │                        │
       │      "Restore"         │                        │
       │      ─────────────────►│                        │
       │                        │                        │
       │                        │ Read backup data       │
       │                        │───────────────────────►│
       │                        │◄───────────────────────│
       │                        │                        │
       │      Write key + data  │                        │
       │◄───────────────────────│                        │
       │                        │                        │
       │      "Please refresh"  │                        │
       │      ─────────────────►│                        │
       │                        │                        │
       │ User refreshes page    │                        │
       │                        │                        │
       │ Venice loads data! ✅   │                        │
       │                        │                        │
```

---

## Key Guarantees

### 1. No Key Is Ever Lost

```
Every time we see a key:
├── Calculate hash
├── Check if in vault
├── If not: save it immediately
└── Never delete keys from vault

Keys accumulate over time. User can have many keys.
Each key's data is in its own pool.
```

### 2. No Data Is Ever Lost

```
Before any overwrite:
├── Create snapshot in archive/snapshots/
└── Old version is always recoverable

Pools are append-only by default.
Deletes are actually moves to archive/.
```

### 3. User Controls All Changes

```
Every modification requires:
├── User clicking a button
├── Confirmation dialog (for destructive actions)
└── Clear explanation of what will happen

No automatic syncs.
No background overwrites.
```

### 4. Clear State Visibility

```
User can always see:
├── What's in browser
├── What's in backup
├── How they differ
├── All available keys
└── Full sync history
```

---

## Edge Cases Handled

### Edge Case 1: Multiple Keys Over Time

```
User history:
├── Dec 1: Starts using Venice (key A created)
├── Dec 10: Clears browser, continues (key B created by Venice)
├── Dec 12: Clears again (key C created)
├── Dec 15: Installs extension

Vault after backup:
├── Key A: 0 conversations (never backed up, lost)
├── Key B: 15 conversations (if backed up)
├── Key C: 5 conversations (current)

User can switch between B and C.
Key A data is gone (extension wasn't installed).
```

### Edge Case 2: Same Key, Different Devices

```
Setup:
├── Device 1: Has key A, 30 conversations
├── Device 2: Has key A, 45 conversations (superset)
├── Both backed up to same Dropbox folder

Result:
├── Pool for key A has 45 conversations (union)
├── Device 1 can restore to get the 15 it's missing
├── No conflicts because same key = same encryption
```

### Edge Case 3: Different Keys, Want to Merge

```
User: "I have data under key A and key B, want them together"

Challenge: Data encrypted with A can't be decrypted with B

Options shown:
├── Keep separate (different pools)
├── Export readable summaries (titles, dates - unencrypted metadata)
├── Manual merge: Open Venice with key A, copy content, switch to key B, paste

We can't automatically merge encrypted data across keys.
We CAN preserve both and let user access either.
```

### Edge Case 4: Browser Has New Key But Also Has Data We Want

```
Situation:
├── Browser: Key B with 2 new conversations
├── Vault: Key A with 42 conversations

User clicks "Switch to Backup Key"

Process:
├── First: Back up key B + its 2 conversations to vault
├── Then: Write key A to browser
├── Then: Write 42 conversations to browser
├── Result: Key B pool preserved, browser now on key A

User can later switch back to key B if they want those 2 conversations.
```

---

## Implementation Notes

### No Timing Dependencies

The extension never tries to "beat" Venice. It works by:
1. Checking state when user opens popup
2. Presenting clear options
3. Executing user's choice
4. Asking user to refresh if browser was modified

This means:
- Works even if extension loads after Venice
- Works even if extension is slow
- Works even if Venice changes their initialization

### File System Access

Using File System Access API:
```javascript
// User selects folder once
const dirHandle = await window.showDirectoryPicker();
await set('backupDirHandle', dirHandle);

// Later, read/write to folder
const fileHandle = await dirHandle.getFileHandle('vault-state.json');
const file = await fileHandle.getFile();
const contents = await file.text();
```

Permission persists across sessions (usually).
If permission lost, re-prompt user.

### Browser Modification

Writing to IndexedDB from extension:
```javascript
// This works from extension popup or content script
const request = indexedDB.open('venice-db-encrypted', 210);
request.onsuccess = (event) => {
  const db = event.target.result;
  const tx = db.transaction('conversations', 'readwrite');
  const store = tx.objectStore('conversations');
  store.put(conversationRecord);
};
```

Writing to localStorage:
```javascript
// Must be done from content script in Venice's context
// Or via chrome.scripting.executeScript with world: "MAIN"
localStorage.setItem('encryptionKey', keyBytes);
```

After modifying browser storage, user must refresh for Venice to see changes.
