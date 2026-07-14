(function initializeArchiveRepositoryUtilities(globalScope) {
  'use strict';

  const REPOSITORY_SCHEMA_VERSION = '1.0.0';
  const ROOT_MANIFEST_FILE = 'venice-archive.manifest.json';
  const MAX_TITLE_LENGTH = 120;
  const MAX_SLUG_LENGTH = 80;
  const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;
  const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

  const REPOSITORY_DIRECTORIES = Object.freeze({
    conversations: 'conversations',
    exports: 'exports',
    indexes: 'indexes',
    logs: 'logs',
    media: 'media',
    stores: 'stores',
    viewer: 'viewer'
  });

  const INDEX_FILES = Object.freeze({
    conversations: 'indexes/conversations.json',
    messages: 'indexes/messages.jsonl',
    media: 'indexes/media.json',
    unresolvedMedia: 'indexes/unresolved-media.json'
  });

  function cleanOptionalText(value) {
    if (value == null) {
      return '';
    }

    return String(value).replace(/\s+/g, ' ').trim();
  }

  function firstNonEmptyText(values) {
    for (const value of values || []) {
      const normalized = cleanOptionalText(value);
      if (normalized) {
        return normalized;
      }
    }

    return '';
  }

  function truncateTitle(value) {
    const normalized = cleanOptionalText(value);
    if (normalized.length <= MAX_TITLE_LENGTH) {
      return normalized;
    }

    return `${normalized.slice(0, MAX_TITLE_LENGTH).trim()}...`;
  }

  function extractMessageText(message) {
    if (!message || typeof message !== 'object') {
      return '';
    }

    if (typeof message.content === 'string') {
      return message.content;
    }

    if (Array.isArray(message.content)) {
      const contentParts = message.content.map((part) => {
        if (!part || typeof part !== 'object') {
          return '';
        }

        return firstNonEmptyText([
          part.text,
          part.content,
          part.caption,
          part.alt,
          part.prompt
        ]);
      });

      const contentText = firstNonEmptyText(contentParts);
      if (contentText) {
        return contentText;
      }
    }

    return firstNonEmptyText([
      message.text,
      message.message,
      message.prompt,
      message.reasoningContent
    ]);
  }

  function resolveConversationTitle(conversation, messages) {
    const directTitle = firstNonEmptyText([
      conversation?.name,
      conversation?.title,
      conversation?.generatedTitle,
      conversation?.label,
      conversation?.summary
    ]);

    if (directTitle) {
      return truncateTitle(directTitle);
    }

    const messageTitle = firstNonEmptyText((messages || []).map(extractMessageText));
    if (messageTitle) {
      return truncateTitle(messageTitle);
    }

    return 'Untitled conversation';
  }

  function slugifyTitle(value, fallback = 'untitled-conversation') {
    const normalized = cleanOptionalText(value)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();

    const slug = normalized || fallback;
    return slug.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '') || fallback;
  }

  function safeIdentifier(value, fallback = 'id') {
    const normalized = cleanOptionalText(value)
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');

    return normalized || fallback;
  }

  function buildConversationFileStem(conversationId, title) {
    return `${safeIdentifier(conversationId, 'conversation')}--${slugifyTitle(title)}`;
  }

  function buildConversationArtifactPaths(conversationId, title) {
    const stem = buildConversationFileStem(conversationId, title);
    return {
      json: `${REPOSITORY_DIRECTORIES.conversations}/${stem}.json`,
      markdown: `${REPOSITORY_DIRECTORIES.conversations}/${stem}.md`
    };
  }

  function isSafeConversationArtifactPath(value, extension) {
    const path = cleanOptionalText(value);
    return path.startsWith(`${REPOSITORY_DIRECTORIES.conversations}/`)
      && path.endsWith(extension)
      && !path.includes('..')
      && !path.includes('\\');
  }

  function resolveConversationArtifactPaths(conversationId, title, previousRecord = null) {
    if (
      isPlainObject(previousRecord)
      && isSafeConversationArtifactPath(previousRecord.jsonPath, '.json')
      && isSafeConversationArtifactPath(previousRecord.markdownPath, '.md')
    ) {
      return {
        json: previousRecord.jsonPath,
        markdown: previousRecord.markdownPath
      };
    }

    return buildConversationArtifactPaths(conversationId, title);
  }

  function buildConversationManifestRecords(currentRecords = [], previousRecords = {}, now = new Date()) {
    const timestamp = now instanceof Date ? now.toISOString() : cleanOptionalText(now);
    const result = {};
    const currentIds = new Set();

    currentRecords.forEach((record) => {
      const id = cleanOptionalText(record?.id);
      if (!id) {
        return;
      }

      currentIds.add(id);
      result[id] = {
        status: 'active',
        tombstoned: false,
        title: cleanOptionalText(record.title) || null,
        recordHash: record.recordHash || null,
        jsonPath: record.jsonPath,
        markdownPath: record.markdownPath,
        updatedAt: record.updatedAt || null,
        lastSeenAt: timestamp
      };
    });

    Object.entries(isPlainObject(previousRecords) ? previousRecords : {}).forEach(([id, previousRecord]) => {
      if (currentIds.has(id)) {
        return;
      }

      result[id] = {
        ...previousRecord,
        status: 'tombstoned',
        tombstoned: true,
        tombstonedAt: previousRecord?.tombstonedAt || timestamp
      };
    });

    return result;
  }

  function getTombstonedConversationIds(previousRecords = {}, currentIds = []) {
    const currentIdSet = new Set(Array.from(currentIds || []).map(cleanOptionalText).filter(Boolean));
    return Object.keys(isPlainObject(previousRecords) ? previousRecords : {})
      .filter((id) => !currentIdSet.has(id));
  }

  function buildMediaContentPath(sha256, extension = 'bin') {
    const normalizedHash = cleanOptionalText(sha256).toLowerCase();
    if (!SHA256_HEX_PATTERN.test(normalizedHash)) {
      throw new Error('Media content path requires a SHA-256 hex digest');
    }

    const safeExtension = safeIdentifier(extension, 'bin').replace(/^\.+/, '') || 'bin';
    return `${REPOSITORY_DIRECTORIES.media}/sha256/${normalizedHash.slice(0, 2)}/${normalizedHash}.${safeExtension}`;
  }

  function canonicalize(value) {
    if (value == null || typeof value !== 'object') {
      return value === undefined ? null : value;
    }

    if (Array.isArray(value)) {
      return value.map(canonicalize);
    }

    const result = {};
    Object.keys(value).sort().forEach((key) => {
      if (value[key] !== undefined) {
        result[key] = canonicalize(value[key]);
      }
    });
    return result;
  }

  function stableStringify(value) {
    return JSON.stringify(canonicalize(value));
  }

  function buildRecordFingerprintInput(record) {
    return stableStringify(record || {});
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function parseSchemaVersion(value) {
    const match = cleanOptionalText(value).match(SEMVER_PATTERN);
    if (!match) {
      return null;
    }

    return match.slice(1).map((part) => Number(part));
  }

  function compareSchemaVersions(left, right) {
    const leftParts = parseSchemaVersion(left);
    const rightParts = parseSchemaVersion(right);
    if (!leftParts || !rightParts) {
      return null;
    }

    for (let index = 0; index < leftParts.length; index += 1) {
      if (leftParts[index] < rightParts[index]) {
        return -1;
      }
      if (leftParts[index] > rightParts[index]) {
        return 1;
      }
    }

    return 0;
  }

  function getRootManifestCompatibility(manifest) {
    if (!isPlainObject(manifest)) {
      return {
        ok: false,
        status: 'invalid',
        canRead: false,
        canWrite: false,
        manifestVersion: null,
        supportedVersion: REPOSITORY_SCHEMA_VERSION,
        errors: ['Root manifest must be an object.']
      };
    }

    const manifestVersion = cleanOptionalText(manifest.schemaVersion);
    const comparison = compareSchemaVersions(manifestVersion, REPOSITORY_SCHEMA_VERSION);
    if (comparison == null) {
      return {
        ok: false,
        status: 'invalid',
        canRead: false,
        canWrite: false,
        manifestVersion: manifestVersion || null,
        supportedVersion: REPOSITORY_SCHEMA_VERSION,
        errors: [`Root manifest schemaVersion is invalid: ${manifestVersion || 'missing'}.`]
      };
    }

    if (comparison < 0) {
      return {
        ok: false,
        status: 'migration-required',
        canRead: false,
        canWrite: false,
        manifestVersion,
        supportedVersion: REPOSITORY_SCHEMA_VERSION,
        errors: [`Root manifest schemaVersion ${manifestVersion} is older than supported schema ${REPOSITORY_SCHEMA_VERSION}. Migration is required before writing this repository.`]
      };
    }

    if (comparison > 0) {
      return {
        ok: false,
        status: 'unsupported-newer',
        canRead: false,
        canWrite: false,
        manifestVersion,
        supportedVersion: REPOSITORY_SCHEMA_VERSION,
        errors: [`Root manifest schemaVersion ${manifestVersion} is newer than supported schema ${REPOSITORY_SCHEMA_VERSION}. Update the extension before writing this repository.`]
      };
    }

    const validation = validateRootManifest(manifest);
    return {
      ok: validation.ok,
      status: validation.ok ? 'current' : 'invalid',
      canRead: validation.ok,
      canWrite: validation.ok,
      manifestVersion,
      supportedVersion: REPOSITORY_SCHEMA_VERSION,
      errors: validation.errors
    };
  }

  function getCandidateMimeType(value) {
    if (!isPlainObject(value)) {
      return null;
    }

    return firstNonEmptyText([
      value.mimeType,
      value.mime_type,
      value.contentType,
      value.mediaType,
      value.fileType,
      value.mime
    ]) || null;
  }

  function getCandidateUrl(value) {
    if (typeof value === 'string') {
      return value;
    }

    if (!isPlainObject(value)) {
      return '';
    }

    return firstNonEmptyText([
      value.url,
      value.sourceUrl,
      value.src,
      value.href,
      value.resultUrl,
      value.mediaUrl,
      value.imageUrl,
      value.videoUrl,
      value.audioUrl,
      value.fileUrl,
      value.path,
      value.fileName,
      value.name
    ]);
  }

  function defaultMimeTypeForKind(kind) {
    switch (kind) {
      case 'image':
        return 'image/webp';
      case 'video':
        return 'video/mp4';
      case 'audio':
        return 'audio/mpeg';
      default:
        return 'application/octet-stream';
    }
  }

  function classifyMediaKind(value) {
    const url = getCandidateUrl(value);
    const signal = `${isPlainObject(value) ? value.type || value.kind || '' : ''} ${getCandidateMimeType(value) || ''} ${url || ''}`.toLowerCase();

    if (signal.includes('video') || /\.(mp4|mov|webm|m4v|avi|mkv|ogv|mpeg|mpg)(?:$|[?#])/.test(signal)) {
      return 'video';
    }

    if (signal.includes('audio') || /\.(mp3|wav|ogg|m4a|aac|flac|opus)(?:$|[?#])/.test(signal)) {
      return 'audio';
    }

    if (signal.includes('image') || signal.includes('thumbnail') || signal.includes('poster') || /\.(png|jpg|jpeg|gif|webp|svg|bmp|avif|heic|heif|tiff|jfif)(?:$|[?#])/.test(signal)) {
      return 'image';
    }

    if (signal.includes('pdf') || signal.includes('file') || signal.includes('attachment') || signal.includes('document')) {
      return 'file';
    }

    return 'asset';
  }

  function extensionForMimeType(mimeType, kind = 'asset') {
    const normalized = String(mimeType || '').toLowerCase();
    const knownExtensions = {
      'image/avif': 'avif',
      'image/bmp': 'bmp',
      'image/heic': 'heic',
      'image/heif': 'heif',
      'image/tiff': 'tiff',
      'image/webp': 'webp',
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/svg+xml': 'svg',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/quicktime': 'mov',
      'video/x-msvideo': 'avi',
      'video/x-matroska': 'mkv',
      'video/ogg': 'ogv',
      'audio/mpeg': 'mp3',
      'audio/wav': 'wav',
      'audio/ogg': 'ogg',
      'audio/mp4': 'm4a',
      'audio/aac': 'aac',
      'audio/flac': 'flac',
      'audio/opus': 'opus',
      'text/plain': 'txt',
      'text/markdown': 'md',
      'text/csv': 'csv',
      'text/html': 'html',
      'text/xml': 'xml',
      'application/pdf': 'pdf'
    };

    if (knownExtensions[normalized]) {
      return knownExtensions[normalized];
    }

    if (normalized.includes('/')) {
      return normalized.split('/').pop().replace(/[^a-z0-9.+-]/g, '') || 'bin';
    }

    switch (kind) {
      case 'image':
        return 'webp';
      case 'video':
        return 'mp4';
      case 'audio':
        return 'mp3';
      default:
        return 'bin';
    }
  }

  function inferMimeTypeFromUrl(url, kind = 'asset') {
    const normalized = String(url || '').trim().toLowerCase();
    if (!normalized) {
      return defaultMimeTypeForKind(kind);
    }

    if (normalized.startsWith('data:')) {
      const mimeMatch = normalized.match(/^data:([^;,]+)[;,]/i);
      return mimeMatch?.[1] || defaultMimeTypeForKind(kind);
    }

    const pathname = normalized.split('#')[0].split('?')[0];
    const knownMimeTypes = [
      [/\.avif$/i, 'image/avif'],
      [/\.bmp$/i, 'image/bmp'],
      [/\.heic$/i, 'image/heic'],
      [/\.heif$/i, 'image/heif'],
      [/\.tiff?$/i, 'image/tiff'],
      [/\.webp$/i, 'image/webp'],
      [/\.png$/i, 'image/png'],
      [/\.jpe?g$/i, 'image/jpeg'],
      [/\.gif$/i, 'image/gif'],
      [/\.svg$/i, 'image/svg+xml'],
      [/\.mp4$/i, 'video/mp4'],
      [/\.webm$/i, 'video/webm'],
      [/\.mov$/i, 'video/quicktime'],
      [/\.m4v$/i, 'video/x-m4v'],
      [/\.avi$/i, 'video/x-msvideo'],
      [/\.mkv$/i, 'video/x-matroska'],
      [/\.ogv$/i, 'video/ogg'],
      [/\.mp3$/i, 'audio/mpeg'],
      [/\.wav$/i, 'audio/wav'],
      [/\.ogg$/i, 'audio/ogg'],
      [/\.m4a$/i, 'audio/mp4'],
      [/\.aac$/i, 'audio/aac'],
      [/\.flac$/i, 'audio/flac'],
      [/\.opus$/i, 'audio/opus'],
      [/\.pdf$/i, 'application/pdf']
    ];

    for (const [pattern, inferredMimeType] of knownMimeTypes) {
      if (pattern.test(pathname)) {
        return inferredMimeType;
      }
    }

    return defaultMimeTypeForKind(kind);
  }

  function classifyMediaCandidate(candidate = {}) {
    const mimeType = firstNonEmptyText([
      getCandidateMimeType(candidate),
      inferMimeTypeFromUrl(getCandidateUrl(candidate), candidate.kind || candidate.type || 'asset')
    ]);
    const kind = classifyMediaKind({ ...candidate, mimeType });
    const url = getCandidateUrl(candidate);
    const hasInlinePayload = /^data:/i.test(url) || Boolean(candidate.inline || candidate.hasInlineData || candidate.hasEmbeddedResult);
    const hasFetchableUrl = /^(https?:|blob:|filesystem:|chrome-extension:)/i.test(url);
    const hasBytes = Number(candidate.bytes || candidate.byteLength || candidate.size || 0) > 0;
    const hasExportableBytes = hasInlinePayload || hasFetchableUrl || hasBytes;

    return {
      kind,
      mimeType: mimeType || defaultMimeTypeForKind(kind),
      extension: extensionForMimeType(mimeType, kind),
      exportable: hasExportableBytes,
      status: hasExportableBytes ? 'candidate' : 'unresolved',
      reason: hasExportableBytes ? null : 'No bytes, inline payload, or fetchable media URL was available.'
    };
  }

  function validateRootManifest(manifest) {
    const errors = [];

    if (!isPlainObject(manifest)) {
      return { ok: false, errors: ['Root manifest must be an object.'] };
    }

    if (manifest.schemaVersion !== REPOSITORY_SCHEMA_VERSION) {
      errors.push(`Unsupported root manifest schemaVersion: ${manifest.schemaVersion || 'missing'}.`);
    }

    if (!cleanOptionalText(manifest.archiveId)) {
      errors.push('Root manifest archiveId is required.');
    }

    if (!cleanOptionalText(manifest.createdAt)) {
      errors.push('Root manifest createdAt is required.');
    }

    if (!cleanOptionalText(manifest.updatedAt)) {
      errors.push('Root manifest updatedAt is required.');
    }

    if (!isPlainObject(manifest.indexes)) {
      errors.push('Root manifest indexes object is required.');
    } else {
      Object.entries(INDEX_FILES).forEach(([key, expectedPath]) => {
        if (manifest.indexes[key] !== expectedPath) {
          errors.push(`Root manifest indexes.${key} must be ${expectedPath}.`);
        }
      });
    }

    return { ok: errors.length === 0, errors };
  }

  function buildEmptyRootManifest({ archiveId, now = new Date(), source = {}, generatedBy = {} } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : cleanOptionalText(now);
    const resolvedArchiveId = cleanOptionalText(archiveId) || `venice-archive-${timestamp.replace(/[:.]/g, '-')}`;

    return {
      schemaVersion: REPOSITORY_SCHEMA_VERSION,
      archiveId: resolvedArchiveId,
      createdAt: timestamp,
      updatedAt: timestamp,
      latestExportId: null,
      source,
      generatedBy,
      totals: {
        conversations: 0,
        messages: 0,
        mediaFiles: 0,
        unresolvedMedia: 0,
        exports: 0
      },
      indexes: { ...INDEX_FILES },
      verification: {
        status: 'pending',
        verifiedAt: null,
        warnings: []
      }
    };
  }

  const api = Object.freeze({
    INDEX_FILES,
    REPOSITORY_DIRECTORIES,
    REPOSITORY_SCHEMA_VERSION,
    ROOT_MANIFEST_FILE,
    buildConversationArtifactPaths,
    buildConversationFileStem,
    buildConversationManifestRecords,
    buildEmptyRootManifest,
    buildMediaContentPath,
    buildRecordFingerprintInput,
    classifyMediaCandidate,
    classifyMediaKind,
    getRootManifestCompatibility,
    getTombstonedConversationIds,
    cleanOptionalText,
    defaultMimeTypeForKind,
    extensionForMimeType,
    firstNonEmptyText,
    inferMimeTypeFromUrl,
    resolveConversationTitle,
    resolveConversationArtifactPaths,
    safeIdentifier,
    slugifyTitle,
    stableStringify,
    validateRootManifest
  });

  globalScope.VeniceArchiveRepository = api;
})(globalThis);
