# Venice History Sync - Robust Sync Protocol

## Critical Insight

The **encryption key** is the crown jewel. Venice stores it in `localStorage.encryptionKey`. 
If this key is lost/changed, all encrypted data becomes unreadable.

When browser data is cleared:
1. `localStorage` is wiped → encryption key gone
2. `IndexedDB` is wiped → conversations gone
3. Venice.ai generates a NEW key on next visit
4. Old backups encrypted with old key become orphaned

**Our job**: Restore the encryption key BEFORE Venice can generate a new one.

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────────┐
│                          BACKUP LOCATION                           │
│                    (Local folder in Dropbox)                       │
│                                                                    │
│  ~/Dropbox/Apps/VeniceBackup/                                      │
│  ├── manifest.json          # Backup metadata & version            │
│  ├── encryption-key.backup  # The critical key (optionally wrapped)│
│  ├── latest/                                                       │
│  │   ├── conversations.json                                        │
│  │   ├── messages.json                                             │
│  │   ├── messageIds.json                                           │
│  │   ├── messageImages.json                                        │
│  │   ├── folders.json                                              │
│  │   └── settings.json                                             │
│  └── history/               # Version history (append-only)        │
│      ├── 2025-12-15T16-00-00/                                      │
│      └── 2025-12-15T18-30-00/                                      │
└────────────────────────────────────────────────────────────────────┘
```

---

## State Machine

The extension operates in these states:

```
                    ┌─────────────┐
                    │   STARTUP   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │  FRESH   │ │  NORMAL  │ │ RECOVERY │
        │ (no key, │ │ (key +   │ │ (no key, │
        │ no backup│ │  data)   │ │  backup) │
        └──────────┘ └──────────┘ └──────────┘
              │            │            │
              ▼            ▼            ▼
        Do nothing   Run backups   RESTORE NOW
```

### State Detection (runs at document_start)

```javascript
async function detectState() {
  const hasLocalKey = localStorage.getItem('encryptionKey') !== null;
  const hasBackup = await checkBackupExists();
  
  if (!hasLocalKey && !hasBackup) {
    return 'FRESH';      // New user, let Venice initialize normally
  }
  if (hasLocalKey) {
    return 'NORMAL';     // Working state, run periodic backups
  }
  if (!hasLocalKey && hasBackup) {
    return 'RECOVERY';   // DANGER: Must restore before Venice loads!
  }
}
```

---

## Protocol: BACKUP (Normal Operation)

### Trigger Conditions
- Manual: User clicks "Backup Now"
- Automatic: Every N minutes while Venice tab is open
- On tab close: Final backup before leaving

### Sequence

```
BACKUP SEQUENCE
═══════════════

1. VALIDATE
   ├── Check Venice tab is on venice.ai
   ├── Verify encryption key exists
   └── Abort if any validation fails

2. EXTRACT (in MAIN world)
   ├── Read localStorage.encryptionKey
   ├── Open IndexedDB 'venice-db-encrypted' v210
   ├── For each store in [conversations, messages, messageIds, 
   │                      messageImages, folders, settings]:
   │   └── Read all records
   └── Return {key, stores, timestamp}

3. TRANSFORM
   ├── Convert __encryptedData byte objects to Base64
   ├── Calculate checksums for each store
   └── Package as JSON

4. PERSIST (append-only!)
   ├── Write to latest/
   ├── Copy to history/{timestamp}/
   └── Update manifest.json with:
       {
         "lastBackup": "2025-12-15T16:00:00Z",
         "conversationCount": 42,
         "messageCount": 1337,
         "checksum": "sha256:...",
         "veniceDbVersion": 210
       }

5. VERIFY
   ├── Read back and verify checksum
   └── Alert user if verification fails
```

### Key Protection Strategy

The encryption key is backed up separately with extra safeguards:

```javascript
// Option A: Plain backup (simplest, relies on Dropbox security)
{
  "key": "98,67,158,227,...",  // Raw bytes as comma-separated
  "exportedAt": "2025-12-15T16:00:00Z",
  "ownerId": "0x5d38..."
}

// Option B: Passphrase-protected (more secure)
{
  "salt": "base64...",
  "iv": "base64...",
  "wrappedKey": "base64...",  // Key encrypted with user's passphrase
  "exportedAt": "2025-12-15T16:00:00Z"
}
```

---

## Protocol: RESTORE (Recovery Operation)

### Trigger Conditions
- **Automatic**: Extension detects RECOVERY state (no key, backup exists)
- **Manual**: User clicks "Restore from Backup"

### CRITICAL: Timing

The restore MUST happen before Venice.ai's JavaScript initializes:

```javascript
// manifest.json - content script configuration
{
  "content_scripts": [{
    "matches": ["https://venice.ai/*"],
    "js": ["content/early-restore.js"],
    "run_at": "document_start",  // ← CRITICAL: Before page JS runs
    "all_frames": false
  }]
}
```

### Automatic Restore Sequence

```
AUTO-RESTORE SEQUENCE (at document_start)
═════════════════════════════════════════

1. CHECK STATE (synchronous, fast!)
   ├── Is localStorage.encryptionKey present?
   │   ├── YES → Exit, Venice is fine
   │   └── NO  → Continue to step 2

2. CHECK BACKUP (async but fast)
   ├── Does backup exist?
   │   ├── NO  → Exit, let Venice create fresh state
   │   └── YES → EMERGENCY RESTORE

3. RESTORE KEY (MUST complete before Venice JS runs!)
   ├── Read encryption-key.backup
   ├── If passphrase-protected:
   │   └── Show quick modal for passphrase (blocks page load)
   ├── Write to localStorage.encryptionKey
   └── Log: "🔐 Encryption key restored"

4. RESTORE DATA (can be slightly async)
   ├── Open IndexedDB 'venice-db-encrypted'
   │   └── If doesn't exist, create with version 210
   ├── For each store:
   │   ├── Clear existing (should be empty anyway)
   │   └── Write all records from backup
   └── Log: "📦 Restored N conversations, M messages"

5. SIGNAL COMPLETION
   ├── Set flag: localStorage.setItem('__veniceRestored', Date.now())
   └── Venice.ai JS now loads → sees key → loads data → works!
```

### Manual Restore Sequence

```
MANUAL RESTORE SEQUENCE
═══════════════════════

1. USER INITIATES
   └── Clicks "Restore from Backup" in extension popup

2. PRE-FLIGHT CHECKS
   ├── Does Venice currently have data?
   │   ├── YES → Show warning dialog:
   │   │         "Venice has existing data. This will be replaced."
   │   │         [Cancel] [Merge] [Replace]
   │   └── NO  → Proceed to step 3

3. BACKUP CURRENT (safety net)
   └── Create backup of current state before modifying

4. RESTORE
   ├── Same as auto-restore steps 3-4
   └── But with user confirmation at each step

5. RELOAD
   └── Prompt user to reload Venice.ai tab
```

---

## Protocol: MERGE (Advanced)

For cases where both Venice and backup have data:

```
MERGE STRATEGY
══════════════

Conversations:
├── Match by ID
├── If only in backup → add to Venice
├── If only in Venice → keep (and backup)
├── If in both:
│   └── Keep version with newer updatedAtUnixTimestamp

Messages:
├── Same logic as conversations
└── Orphan check: ensure conversationId exists

Encryption Key Conflict:
├── If keys differ → STOP, require user decision
└── Cannot merge data encrypted with different keys
```

---

## Failure Modes & Recovery

### Failure: Backup file corrupted

```
Detection: Checksum mismatch on read
Recovery: 
  1. Alert user
  2. Try previous version from history/
  3. If all corrupted, data may be lost (warn user to not clear browser)
```

### Failure: Partial restore (power loss mid-write)

```
Detection: manifest.json shows "restoreInProgress": true
Recovery:
  1. On next startup, detect incomplete restore
  2. Re-run restore from last known good backup
```

### Failure: Venice DB version changed

```
Detection: veniceDbVersion in backup ≠ current IndexedDB version
Recovery:
  1. Alert user
  2. Attempt restore anyway (may work)
  3. If fails, provide manual export option
```

### Failure: Extension uninstalled while backup in progress

```
Detection: N/A (can't detect)
Prevention: 
  1. Keep history/ versions
  2. Never delete, only append
  3. User can manually import JSON if needed
```

---

## File Access Strategy

Since browser extensions can't write directly to arbitrary folders, we have options:

### Option A: Download API (Simplest)

```javascript
// Export creates a download
chrome.downloads.download({
  url: URL.createObjectURL(new Blob([json], {type: 'application/json'})),
  filename: 'VeniceBackup/backup-latest.json',
  saveAs: false  // Auto-save to default location
});

// User configures Chrome to save downloads to Dropbox folder
```

**Pros**: Simple, works everywhere
**Cons**: Creates new files (doesn't overwrite), clutters download folder

### Option B: File System Access API (Best UX)

```javascript
// One-time: User grants access to a folder
const dirHandle = await window.showDirectoryPicker();
await chrome.storage.local.set({ backupDirHandle: dirHandle });

// Subsequent: Write directly to that folder
const fileHandle = await dirHandle.getFileHandle('backup.json', { create: true });
const writable = await fileHandle.createWritable();
await writable.write(json);
await writable.close();
```

**Pros**: Overwrites in place, clean
**Cons**: Requires user to grant access once, permission may expire

### Option C: Native Messaging (Most Powerful)

```
Extension ←→ Native Helper App ←→ File System
```

**Pros**: Full file system access
**Cons**: Requires installing a small helper app

### Recommendation

Start with **Option B** (File System Access API):
1. On first run, prompt user to select backup folder
2. Store folder handle persistently
3. Read/write directly to that folder
4. If permission expires, re-prompt

---

## Preventing Accidental Data Loss

### Rule 1: Never Delete from Backup

```javascript
// ❌ WRONG
fs.unlinkSync('backup/old-backup.json');

// ✅ RIGHT
fs.renameSync('backup/old.json', 'backup/history/old.json');
```

### Rule 2: Always Verify Before Overwriting

```javascript
async function safeWrite(path, newData) {
  const existing = await read(path);
  if (existing) {
    // Archive existing first
    await copy(path, `${path}.${Date.now()}.bak`);
  }
  await write(path, newData);
  // Verify
  const written = await read(path);
  if (checksum(written) !== checksum(newData)) {
    throw new Error('Write verification failed');
  }
}
```

### Rule 3: Encryption Key Gets Extra Protection

```javascript
// Key is backed up in multiple places:
// 1. backup/encryption-key.backup (primary)
// 2. backup/history/*/encryption-key.backup (with each backup)
// 3. Optionally: user exports to password manager
```

### Rule 4: Clear Browser = DON'T Touch Backup

The backup folder is OUTSIDE the browser. Clearing browser data:
- ✅ Clears Venice's IndexedDB
- ✅ Clears localStorage  
- ❌ Does NOT touch ~/Dropbox/VeniceBackup/

This is the whole point! The backup survives browser clears.

---

## User Workflow

### Setup (One Time)

1. Install extension
2. Extension prompts: "Select backup folder"
3. User navigates to `~/Dropbox/Apps/VeniceBackup/` (creates if needed)
4. Extension stores folder handle
5. Optional: Set passphrase for key protection
6. Click "Initial Backup"

### Daily Use

- Extension icon shows: 🟢 (backed up) or 🟡 (pending changes)
- Auto-backup runs every 30 min while Venice tab is open
- User can click "Backup Now" anytime

### After Browser Clear

1. User clears browser data (intentionally or accidentally)
2. User opens venice.ai
3. Extension (at document_start) detects: no key, but backup exists
4. Extension restores key immediately
5. Extension restores data
6. Venice.ai loads normally with all history intact
7. User sees: "✅ Restored 42 conversations from backup"

### New Device

1. Install Chrome, sign into Dropbox (folder syncs)
2. Install extension
3. Extension prompts: "Select backup folder"
4. User selects `~/Dropbox/Apps/VeniceBackup/`
5. Extension detects existing backup
6. User opens venice.ai
7. Auto-restore kicks in
8. All history available on new device!

---

## Implementation Priority

1. **P0**: Backup encryption key (everything else is useless without it)
2. **P0**: Auto-restore at document_start
3. **P1**: Full database backup
4. **P1**: History/versioning
5. **P2**: Merge functionality
6. **P3**: Nice UI

---

## Testing Checklist

- [ ] Fresh install, no backup → Venice works normally
- [ ] Create backup → files appear in folder
- [ ] Clear browser data → auto-restore works
- [ ] Clear + open Venice before extension loads → ??? (race condition test)
- [ ] Corrupted backup file → graceful error
- [ ] Large history (1000+ messages) → performance OK
- [ ] Different Venice DB version → handled gracefully
- [ ] Passphrase-protected key → unlock flow works
