# Current Venice Browser Storage Audit — 2026-07-10

Purpose: verify the extension against the current shipped Venice frontend rather than the historical v210 notes in older design documents.

## Evidence inspected

- Public application route: `https://venice.ai/chat`
- Deployment id observed in the page: `dpl_GHirwes4uaBvNBGwDgV7ZHruo9Lh`
- Current storage implementation chunks were downloaded from the application's own `/_next/static/chunks/` assets and searched locally.
- Account records were not inspected; authenticated runtime verification remains separate.

## Legacy/Dexie database

Database: `venice-db-encrypted`

Current shipped schema version: 30

Version 30 stores:

- `conversations`
- `folders`
- `messages`
- `messageIds`
- `messageImages`
- `userSystemPrompts`
- `characters`
- `settings`
- `textSettings`
- `imageSettings`
- `supportBotThreads`
- `supportBotMessages`
- `studioImageSessions`
- `studioImageTurnMedia`
- `studioImageTurns`
- `studioAudioSessions`
- `studioAudioTurnMedia`
- `studioAudioTurns`
- `studioVideoSessions`
- `pinnedMessages`
- `videoEditorSessions`

The extension now inventories the database dynamically, so this list is a projection/UX aid rather than an allowlist.

## RxDB database

Database: `venice-rx-db-encrypted`

Current shipped collection definitions include:

- `characters`
- `conversations`
- `entityInsights`
- `folders`
- `imageSettings`
- `memories`
- `messageAudioAttachments`
- `messages`
- `messageFileAttachments`
- `messageImageAttachments`
- `messageImages`
- `messageVideoAttachments`
- `messageVideos`
- `mindAttachments`
- `minds`
- `mindConversations`
- `mindMedia`
- `mindMessages`
- `radioPlaylists`
- `radioTracks`
- `relationshipInsights`
- `textSettings`
- `userSystemPrompts`
- `videoSettings`

The extension resolves the highest physical `*-<schemaVersion>-documents` store for every collection. Known current chat/media collections receive stable decoded logical names and unknown collections use `rxdb:<base>`. In addition, every physical RxDB object store—including attachment, write-ahead, internal, and older migration stores—is preserved separately as `rxdb-physical:<physical-store>`. The physical snapshots retain the raw recovery layer that normalized searchable records intentionally omit.

## Additional IndexedDB databases

The current Video Studio bundle also creates a separate Dexie database:

- Database: `video-studio-recovery`
- Store: `activeGenerations`
- Contents: active generation jobs, prompts/settings, recovery state, input references, and output/download references

Protocol v11 uses `indexedDB.databases()` to enumerate every other database and object store on the Venice origin. The known recovery store is exposed as `videoStudioActiveGenerations`; future/unknown stores use reversible `idb:<database>:<store>` logical names. Every discovered store is mandatory once inventoried, and initial/final decoded fingerprints detect in-place changes as well as record-count changes.

## Origin Private File System

The current frontend's media service uses `navigator.storage.getDirectory()` and stores conversation media as:

```text
media/<conversation-id>/<media-id>.<mime-extension>
media/<conversation-id>/attachments/<attachment-id>.<mime-extension>
```

It also uses other OPFS locations including `thumbnails/` and Studio/Mind input or asset directories. IndexedDB/RxDB media records may contain only ids and MIME metadata; the bytes are fetched from OPFS by the frontend.

This is why URL-only and IndexedDB-only export cannot provide total media coverage. Protocol v11 recursively inventories OPFS, reads files in chunks, hashes them, correlates ids where possible, and writes them into `media/sha256/`.

## Local storage

The current video Studio uses content-bearing local-storage state for pending, completed, failed, and submitting generation queues, while active recovery jobs also live in `video-studio-recovery`. Protocol v11 archives both sources. Recoverable local-storage entries are stored as `browserLocalStorage`, while authentication tokens, credential/session material, wallet connection state, and the Venice encryption key are redacted from the readable source snapshot.

Session storage is also inventoried as `browserSessionStorage`. Session/authentication/telemetry identifiers are redacted, while any recoverable non-sensitive state remains available if Venice begins persisting drafts or content there.

## Runtime verification still required

- Load extension version 0.3.3 unpacked in the user's Chrome profile.
- Reload Venice so page protocol `2026-07-store-api-v12-tab-handoff` is active.
- Export twice into the same folder.
- Run `npm run verify:archive -- <archive-folder>`.
- Spot-check current regular chats, Mind chats, Studio media, and uploaded attachments.
- Do not clear Venice browser data unless the verifier passes and the root manifest is `verified`.
