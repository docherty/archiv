# Venice History Sync - Robust Bidirectional Sync Protocol (V2)

## Design Philosophy

1. **User is in control** - No automatic overwrites, always prompt for decisions
2. **Never delete** - Archive instead, user can always recover
3. **Local backup is the source of truth** - Browser is ephemeral
4. **Git-like model** - Track changes, show diffs, let user resolve
5. **Explicit sync** - User initiates sync, reviews changes, confirms

---

## Mental Model: Git for Venice History

```
┌─────────────────────┐         ┌─────────────────────┐
│   Browser Storage   │         │   Local Backup      │
│   (Working Copy)    │  ←───►  │   (Repository)      │
│                     │  sync   │                     │
│   - ephemeral       │         │   - persistent      │
│   - can be cleared  │         │   - in Dropbox      │
│   - Venice's domain │         │   - our domain      │
└─────────────────────┘         └─────────────────────┘

Sync = "commit" (browser → local) + "checkout" (local → browser)
Conflict = both sides changed since last sync
Archive = "stash" or ignored changes (never deleted)
```

---

## Local Storage Structure

```
~/Dropbox/VeniceBackup/
├── .venice-sync/                    # Sync metadata (hidden)
│   ├── config.json                  # User preferences
│   ├── sync-state.json              # Last known state of both sides
│   └── sync.log                     # Audit log of all operations
│
├── data/                            # Current active data
│   ├── encryption-key.json          # The critical encryption key
│   ├── conversations/               # One file per conversation
│   │   ├── BNtd6fg.json
│   │   ├── Zh02Qa3.json
│   │   └── ...
│   ├── messages/                    # Messages grouped by conversation
│   │   ├── BNtd6fg/
│   │   │   ├── RUfECu7.json
│   │   │   ├── eoI2eHP.json
│   │   │   └── ...
│   │   └── Zh02Qa3/
│   │       └── LraHvri.json
│   ├── folders.json                 # Folder organization
│   ├── settings.json                # User settings
│   └── README.md                    # Human-readable explanation
│
├── archive/                         # Never-deleted historical data
│   ├── ignored/                     # User chose to not sync these
│   │   └── 2025-12-15_conversation_abc123.json
│   ├── superseded/                  # Replaced by newer versions
│   │   └── 2025-12-15_message_xyz789_v1.json
│   └── snapshots/                   # Full point-in-time backups
│       ├── 2025-12-15T10-00-00/
│       └── 2025-12-15T16-00-00/
│
└── README.md                        # Explains the folder to user
```

### Why This Structure?

- **One file per conversation/message**: Enables granular sync and conflict resolution
- **Human-readable JSON**: User can browse/edit with any text editor
- **Archive folder**: Nothing ever deleted, mistakes recoverable
- **Snapshots**: Full backups at major sync points for disaster recovery

---

## Sync State Model

### sync-state.json

Tracks the last known state of every record on both sides:

```json
{
  "version": "1.0",
  "lastSyncTime": "2025-12-15T16:00:00.000Z",
  "encryptionKeyHash": "sha256:abc123...",
  
  "records": {
    "conversation:BNtd6fg": {
      "browserHash": "sha256:def456...",
      "localHash": "sha256:def456...",
      "lastSynced": "2025-12-15T16:00:00.000Z",
      "browserTimestamp": 1765814480839,
      "localTimestamp": 1765814480839
    },
    "message:LraHvri": {
      "browserHash": "sha256:ghi789...",
      "localHash": "sha256:ghi789...",
      "lastSynced": "2025-12-15T16:00:00.000Z",
      "browserTimestamp": 1765814390291,
      "localTimestamp": 1765814390291
    }
  },
  
  "ignored": {
    "conversation:old123": {
      "ignoredAt": "2025-12-15T14:00:00.000Z",
      "reason": "user_choice",
      "archivedTo": "archive/ignored/2025-12-15_conversation_old123.json"
    }
  }
}
```

---

## Sync Algorithm

### Phase 1: Gather State

```
GATHER STATE
════════════

Browser Side:
├── Read all records from IndexedDB
├── Calculate hash for each record
└── Build: Map<recordId, {hash, timestamp, data}>

Local Side:
├── Read all files from data/
├── Calculate hash for each file
└── Build: Map<recordId, {hash, timestamp, data}>

Previous State:
└── Read sync-state.json
```

### Phase 2: Classify Changes

For each record, determine its sync status:

```
CLASSIFICATION MATRIX
═════════════════════

Let:
  B = Browser hash
  L = Local hash  
  P = Previous sync hash (from sync-state.json)
  
┌─────────────────┬─────────────────┬──────────────────────────────────┐
│ Browser State   │ Local State     │ Classification                   │
├─────────────────┼─────────────────┼──────────────────────────────────┤
│ B = P           │ L = P           │ UNCHANGED - no action            │
│ B ≠ P           │ L = P           │ BROWSER_MODIFIED - push?         │
│ B = P           │ L ≠ P           │ LOCAL_MODIFIED - pull?           │
│ B ≠ P           │ L ≠ P, B ≠ L    │ CONFLICT - user must choose      │
│ B ≠ P           │ L ≠ P, B = L    │ BOTH_SAME - already in sync      │
│ exists          │ not exists      │ BROWSER_ONLY - new, push?        │
│ not exists      │ exists          │ LOCAL_ONLY - missing, pull?      │
│ not exists      │ not exists, P   │ DELETED_BOTH - clean up state    │
│ exists          │ in ignored      │ BROWSER_NEW_IGNORED - re-prompt? │
└─────────────────┴─────────────────┴──────────────────────────────────┘
```

### Phase 3: Present to User

```
SYNC REVIEW UI
══════════════

┌─────────────────────────────────────────────────────────────────┐
│ Venice History Sync                                    [Sync ▼] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ 📊 Sync Status                                                  │
│ ─────────────────────────────────────────────────────────────── │
│                                                                 │
│ ⬆️  3 new/modified in browser (not backed up)                   │
│ ⬇️  1 in backup (not in browser)                                │
│ ⚠️  1 conflict (changed in both)                                │
│ ✓  42 in sync                                                   │
│                                                                 │
│ ─────────────────────────────────────────────────────────────── │
│                                                                 │
│ [Review Changes]  [Backup All ⬆️]  [Restore All ⬇️]              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

Clicking "Review Changes":

┌─────────────────────────────────────────────────────────────────┐
│ Review Changes                                         [← Back] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ ⬆️ NEW IN BROWSER (not backed up)                               │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 📝 "Help me understand quantum computing"                   │ │
│ │    Created: 2 hours ago, 5 messages                         │ │
│ │    [Backup] [Ignore] [View]                                 │ │
│ └─────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 📝 "Recipe for chocolate cake"                              │ │
│ │    Created: 30 min ago, 3 messages                          │ │
│ │    [Backup] [Ignore] [View]                                 │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ⬇️ IN BACKUP (missing from browser)                             │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 📝 "Tax planning notes"                                     │ │
│ │    Last synced: 3 days ago, 12 messages                     │ │
│ │    [Restore] [Archive] [View]                               │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ⚠️ CONFLICTS (changed in both)                                  │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 📝 "Project ideas brainstorm"                               │ │
│ │    Browser: modified 1 hour ago                             │ │
│ │    Backup: modified 2 hours ago                             │ │
│ │    [Keep Browser] [Keep Backup] [View Diff]                 │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ─────────────────────────────────────────────────────────────── │
│ [Apply Selected Changes]                                        │
└─────────────────────────────────────────────────────────────────┘
```

### Phase 4: Execute User's Choices

```
EXECUTE SYNC
════════════

For each user decision:

BACKUP (Browser → Local):
├── Create snapshot of current local version (if exists)
│   └── Move to archive/superseded/{timestamp}_{id}.json
├── Write browser data to data/{path}
├── Update sync-state.json with new hashes
└── Log operation to sync.log

RESTORE (Local → Browser):
├── Write local data to browser IndexedDB
├── Update sync-state.json with new hashes
└── Log operation to sync.log

IGNORE:
├── Move local version (if exists) to archive/ignored/
├── Add to sync-state.json ignored list
├── This record won't be prompted in future syncs
└── Log operation to sync.log

ARCHIVE (remove from active consideration):
├── Move to archive/ignored/
├── Remove from browser (if present)
├── Add to ignored list
└── Log operation to sync.log
```

---

## Special Case: Browser Cleared (Recovery Mode)

When browser storage is empty but local backup exists:

```
RECOVERY DETECTION
══════════════════

On extension load (document_start):
├── Check: localStorage.encryptionKey exists?
├── Check: IndexedDB venice-db-encrypted has data?
│
└── If browser empty AND local backup exists:
    
    Show modal (blocks page):
    ┌─────────────────────────────────────────────────────┐
    │ ⚠️ Venice History Not Found                         │
    ├─────────────────────────────────────────────────────┤
    │                                                     │
    │ Your browser's Venice history appears to be         │
    │ empty, but you have a backup with:                  │
    │                                                     │
    │   • 42 conversations                                │
    │   • 1,337 messages                                  │
    │   • Last backup: 2 hours ago                        │
    │                                                     │
    │ Would you like to restore from backup?              │
    │                                                     │
    │ [Restore Now]  [Start Fresh]  [Decide Later]        │
    │                                                     │
    │ ℹ️ If you start fresh, your backup will be kept     │
    │   and you can restore anytime.                      │
    └─────────────────────────────────────────────────────┘
    
    If "Restore Now":
    ├── Restore encryption key to localStorage IMMEDIATELY
    │   (before Venice JS can generate a new one)
    ├── Restore full data to IndexedDB
    ├── Update sync-state.json
    └── Reload page
    
    If "Start Fresh":
    ├── Let Venice generate new encryption key
    ├── Mark all local backup as "orphaned" (not ignored)
    ├── Orphaned data kept in archive/orphaned/{old-key-hash}/
    └── User can still access old data but can't decrypt without old key
    
    If "Decide Later":
    ├── Let Venice generate new encryption key
    ├── Don't mark anything
    ├── Next sync will show conflicts
    └── User must eventually decide
```

### The Encryption Key Problem

If user starts fresh, Venice generates a new key. Old encrypted data is unreadable with new key.

**Solution**: We store data in two forms:

```json
// conversations/BNtd6fg.json
{
  "id": "BNtd6fg",
  "ownerId": "0x5d38...",
  "createdAtUnixTimestamp": 1765814480839,
  "updatedAtUnixTimestamp": 1765814480839,
  
  // Venice's encrypted blob (only readable with matching key)
  "__encryptedData": "base64:...",
  
  // Our metadata (always readable)
  "__syncMeta": {
    "encryptionKeyHash": "sha256:abc123...",
    "lastSynced": "2025-12-15T16:00:00.000Z",
    "conversationTitle": "Extracted from first message if possible",
    "messageCount": 5
  }
}
```

The `__syncMeta` lets us show meaningful info even if we can't decrypt. If keys don't match, we warn user:

```
⚠️ This conversation was encrypted with a different key.
   To access its contents, you need to restore the original
   encryption key from your backup.
   
   [Restore Original Key]  [Keep as Archive]
```

---

## Git as Backend (Optional Enhancement)

The backup folder can optionally be a Git repository:

```bash
cd ~/Dropbox/VeniceBackup
git init
```

**Benefits:**
- Full history of every change
- Built-in diff viewing
- Can use git tools for advanced operations
- Branching for experimental changes
- Works with GitHub/GitLab for remote backup

**Integration:**
```javascript
// After each sync operation
async function commitChanges(message) {
  await exec('git add -A', { cwd: backupPath });
  await exec(`git commit -m "${message}"`, { cwd: backupPath });
}

// Example commits:
// "Backup: 3 conversations, 12 messages (2025-12-15 16:00)"
// "Restore: conversation BNtd6fg to browser"
// "Archive: ignored 2 old conversations"
```

**User can then:**
```bash
# View history
git log --oneline

# See what changed in a sync
git show abc123

# Restore old version of a conversation
git checkout HEAD~5 -- data/conversations/BNtd6fg.json

# Compare versions
git diff HEAD~1 -- data/conversations/
```

---

## Alternative: SQLite Backend

For more robust querying and conflict detection:

```sql
-- backup.db

CREATE TABLE sync_state (
    record_type TEXT,           -- 'conversation', 'message', etc.
    record_id TEXT,
    browser_hash TEXT,
    local_hash TEXT,
    browser_timestamp INTEGER,
    local_timestamp INTEGER,
    last_synced TEXT,
    status TEXT,                -- 'synced', 'browser_modified', 'conflict', etc.
    PRIMARY KEY (record_type, record_id)
);

CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    owner_id TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    encrypted_data BLOB,
    encryption_key_hash TEXT,
    title_hint TEXT,            -- For display even when encrypted
    message_count INTEGER
);

CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    encrypted_data BLOB,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE TABLE archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_type TEXT,
    record_id TEXT,
    archived_at TEXT,
    reason TEXT,                -- 'superseded', 'ignored', 'orphaned'
    data JSON
);

CREATE TABLE sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT,
    operation TEXT,             -- 'backup', 'restore', 'ignore', 'archive'
    record_type TEXT,
    record_id TEXT,
    details JSON
);
```

**Benefits:**
- ACID transactions (no partial syncs)
- Efficient queries for large histories
- Single file (easy to backup)
- Can query across conversations

**Queries:**
```sql
-- Find all conflicts
SELECT * FROM sync_state WHERE status = 'conflict';

-- Find conversations modified in browser but not backed up
SELECT c.*, ss.status 
FROM conversations c
JOIN sync_state ss ON ss.record_id = c.id
WHERE ss.status = 'browser_modified';

-- Get sync history for a conversation
SELECT * FROM sync_log 
WHERE record_id = 'BNtd6fg' 
ORDER BY timestamp DESC;
```

---

## User Workflows

### Workflow 1: Regular Use (Happy Path)

```
1. User uses Venice normally
2. Extension icon shows: 🔵 (changes pending)
3. User clicks icon → sees "3 new conversations not backed up"
4. User clicks "Backup All"
5. Extension writes to local folder
6. Icon shows: ✅ (all synced)
7. Dropbox syncs folder to cloud automatically
```

### Workflow 2: Browser Cleared

```
1. User clears browser data (or switches browser/device)
2. User opens venice.ai
3. Extension (at document_start) detects: empty browser, backup exists
4. Modal: "Restore from backup?"
5. User clicks "Restore Now"
6. Extension restores key + data BEFORE Venice initializes
7. Venice loads normally with full history
8. User sees all their conversations ✅
```

### Workflow 3: Conflict Resolution

```
1. User has Venice open on two devices
2. Device A: edits conversation X
3. Device B: also edits conversation X (different changes)
4. Device A syncs → backup updated
5. Dropbox syncs to Device B
6. Device B opens sync panel → sees conflict
7. User reviews both versions:
   - "Browser version has the recipe I added"
   - "Backup version has the notes from my other computer"
8. User chooses "Keep Browser" for this one
9. Backup version archived (not deleted)
10. User can later recover archived version if needed
```

### Workflow 4: Ignoring Old Stuff

```
1. User has 100 old test conversations
2. User doesn't want to sync these
3. User clicks "Review Changes"
4. Selects the old conversations
5. Clicks "Ignore Selected"
6. Conversations moved to archive/ignored/
7. Won't be prompted about these again
8. Can still access in archive folder if ever needed
```

### Workflow 5: New Device Setup

```
1. User gets new computer
2. Installs Chrome, signs into Dropbox
3. ~/Dropbox/VeniceBackup/ syncs down
4. User installs Venice History Sync extension
5. Extension prompts: "Select backup folder"
6. User selects VeniceBackup folder
7. Extension sees: backup exists, no browser data
8. User opens venice.ai
9. Recovery flow triggers → restore prompt
10. Full history available on new device!
```

---

## Implementation Priority

### Phase 1: Core Sync Engine
- [ ] File System Access API for folder selection
- [ ] Read/write individual JSON files
- [ ] sync-state.json management
- [ ] Hash calculation for change detection
- [ ] Classification algorithm

### Phase 2: Sync UI
- [ ] Popup showing sync status
- [ ] Change review interface
- [ ] Conflict resolution UI
- [ ] Batch operations (backup all, restore all)

### Phase 3: Recovery
- [ ] document_start content script
- [ ] Recovery modal
- [ ] Key restoration
- [ ] Full data restoration

### Phase 4: Archive & History
- [ ] Archive folder management
- [ ] Snapshot creation
- [ ] Ignore functionality
- [ ] Sync log

### Phase 5: Enhancements
- [ ] Git integration (optional)
- [ ] SQLite backend (optional)
- [ ] Export/import for manual backup
- [ ] Search across backed up history

---

## Safety Guarantees

1. **No data loss**: Archive folder keeps everything, nothing truly deleted
2. **No silent overwrites**: User confirms every sync operation
3. **No race conditions**: Recovery blocks page until user decides
4. **No key loss**: Key backed up separately, multiple copies in snapshots
5. **No orphaned data**: Clear tracking of which key encrypts which data
6. **Audit trail**: sync.log records every operation for debugging

---

## Open Questions for Implementation

1. **File System Access API persistence**: How long do folder permissions last? 
   - Answer: Persist across sessions but user may need to re-grant occasionally

2. **Large histories**: What if user has 10,000 messages?
   - Consider: Pagination in UI, lazy loading, SQLite for queries

3. **Real-time sync**: Should we detect browser changes automatically?
   - Recommendation: No, keep it manual/explicit for user control

4. **Multiple Venice accounts**: What if user switches wallet addresses?
   - Each ownerId gets its own subfolder in backup

5. **Encryption key rotation**: What if Venice ever rotates keys?
   - Detect via key hash mismatch, prompt user to re-backup everything
