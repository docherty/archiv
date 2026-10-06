import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const secretPattern = /VENICE-INFERENCE-KEY-[A-Za-z0-9_-]+/;

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

function walk(dirPath, results = []) {
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }

    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, results);
      continue;
    }

    results.push(fullPath);
  }

  return results;
}

function assertNoTrackedSecrets() {
  const trackedFiles = walk(root).filter((filePath) => {
    const relative = path.relative(root, filePath);
    return /\.(json|md|js|html|mjs)$/.test(relative);
  });

  const matches = [];
  for (const filePath of trackedFiles) {
    const relative = path.relative(root, filePath);
    const contents = readFileSync(filePath, 'utf8');
    if (secretPattern.test(contents)) {
      matches.push(relative);
    }
  }

  assert.equal(matches.length, 0, `Found secret-like Venice keys in tracked files: ${matches.join(', ')}`);
}

function assertAgplReleaseMetadata() {
  const packageJson = JSON.parse(read('package.json'));
  const license = readFileSync(path.join(root, 'LICENSE'));
  const readme = read('README.md');
  const notice = read('NOTICE');

  assert.equal(packageJson.name, 'archiv');
  assert.equal(packageJson.license, 'AGPL-3.0-only');
  assert.equal(packageJson.repository.url, 'https://github.com/docherty/archiv.git');
  assert.equal(
    createHash('sha256').update(license).digest('hex'),
    '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0',
    'LICENSE must remain the verbatim GNU AGPL v3 text.'
  );
  assert.match(readme, /license-AGPL%20v3/);
  assert.doesNotMatch(readme, /MIT license|license-MIT/);
  assert.match(readme, /I built this because I needed it/);
  assert.match(readme, /AGPL-3\.0-only/);
  assert.match(notice, /Copyright \(C\) 2026 hiroP/);
  assert.match(notice, /without warranty/i);
  assert.match(notice, /https:\/\/github\.com\/docherty\/archiv/);
  assert.equal(existsSync(path.join(root, 'CONTRIBUTING.md')), true);

  for (const relativePath of ['cli/ui/index.html', 'extension/popup.html', 'extension/backup.html', 'extension/sync.html']) {
    const contents = read(relativePath);
    assert.match(contents, /AGPL v3/);
    assert.match(contents, /no warranty/);
    assert.match(contents, /github\.com\/docherty\/archiv/);
  }
  assert.match(read('cli/lib/service.mjs'), /url\.pathname === '\/license'/);
  assert.match(read('cli/venice-archive.mjs'), /GNU AGPL v3 only; no warranty/);
  assert.match(read('cli/venice-archive.mjs'), /command === '--help'/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /TweetNaCl\.js 1\.0\.3/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /Unlicense/);
}

function assertNoTrackedPrivateArtifacts() {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((relativePath) => relativePath && existsSync(path.join(root, relativePath)));
  const forbidden = tracked.filter((relativePath) => (
    /(?:^|\/)\.DS_Store$/i.test(relativePath)
    || /^(?:config(?:\.local)?\.json|archive|venice-archive|captures|raw-snapshots|raw-store|asset-store|indexes|materialized-media|recovered-media|recovered-content)(?:\/|$)/i.test(relativePath)
    || /\.(?:zip|tar|tgz|7z|ldb|sqlite3?|pem|p12)$/i.test(relativePath)
  ));
  assert.deepEqual(forbidden, [], `Private or generated artifacts are tracked: ${forbidden.join(', ')}`);

  for (const filePath of walk(root)) {
    const relativePath = path.relative(root, filePath);
    if (!/\.(?:json|md|js|html|mjs|css)$/.test(relativePath)) continue;
    assert.doesNotMatch(readFileSync(filePath, 'utf8'), /\/Users\/(?!you(?:\/|\b)|username(?:\/|\b)|name(?:\/|\b))[^/\s"'`]+/, `Machine-specific macOS path found in ${relativePath}`);
  }
}

function assertGitignoreCoversLocalConfig() {
  const gitignore = read('.gitignore');
  assert.match(gitignore, /^\/config\.json$/m);
  assert.match(gitignore, /^\/config\.local\.json$/m);
  assert.equal(existsSync(path.join(root, 'config.json')), false, 'Root config.json must remain untracked; it has contained credentials in the past.');
}

function assertVendoredCryptoIsPinned() {
  const nacl = readFileSync(path.join(root, 'extension/lib/nacl.min.js'));
  assert.equal(
    createHash('sha256').update(nacl).digest('hex'),
    '3ec535c004aeeb225785d8e93fb33bf99f52e399bd7dfc01969b5629baea5131',
    'Vendored TweetNaCl changed; verify it against the upstream 1.0.3 nacl-fast.min.js before updating this hash.'
  );
  assert.equal(existsSync(path.join(root, 'THIRD_PARTY_NOTICES.md')), true);
}

function assertManifestIsTight() {
  const manifest = JSON.parse(read('extension/manifest.json'));
  assert.equal(manifest.version, '0.3.4');
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.ok(Array.isArray(manifest.web_accessible_resources));
  const resources = manifest.web_accessible_resources[0]?.resources || [];
  assert.deepEqual(resources, ['content-main.js', 'lib/nacl.min.js']);
}

function assertCliVersionsAreAligned() {
  const version = JSON.parse(read('package.json')).version;
  const escaped = version.replaceAll('.', '\\.');
  assert.match(read('cli/lib/service.mjs'), new RegExp(`const BUILD = '${escaped}-local'`));
  assert.match(read('cli/ui/app.js'), new RegExp(`const APP_BUILD = '${escaped}-local'`));
  assert.match(read('cli/ui/index.html'), new RegExp(`app\\.css\\?v=${escaped}`));
  assert.match(read('cli/ui/index.html'), new RegExp(`app\\.js\\?v=${escaped}`));
  assert.match(read('cli/ui/index.html'), new RegExp(`favicon\\.svg\\?v=${escaped}`));
}

function assertHtmlHasCsp() {
  for (const relativePath of ['extension/popup.html', 'extension/backup.html', 'extension/sync.html']) {
    const html = read(relativePath);
    assert.match(html, /Content-Security-Policy/);
    assert.doesNotMatch(html, /frame-ancestors/);
  }
}

function assertNoReservedExtensionPaths() {
  const extensionRoot = path.join(root, 'extension');
  const entries = walk(extensionRoot).map((filePath) => path.relative(extensionRoot, filePath));

  for (const relativePath of entries) {
    const segments = relativePath.split(path.sep);
    for (const segment of segments) {
      assert.ok(!segment.startsWith('_'), `Reserved underscore-prefixed path found in extension bundle: ${relativePath}`);
    }
  }
}

function assertWritesAreDisabled() {
  const contentMain = read('extension/content-main.js');
  assert.match(contentMain, /const WRITE_OPERATIONS_ENABLED = false;/);
  assert.match(contentMain, /buildWriteDisabledResponse\('WRITE_DATA'\)|buildWriteDisabledResponse\("WRITE_DATA"\)/);
}

function assertRestoreIsGated() {
  const syncJs = read('extension/sync.js');
  const popupJs = read('extension/popup.js');
  const backupJs = read('extension/backup.js');

  assert.match(syncJs, /const RESTORE_ENABLED = false;/);
  assert.match(popupJs, /Restore is intentionally gated/);
  assert.match(backupJs, /Restore remains gated/);
}

function assertPopupNoLongerShipsLegacyFlows() {
  const popupJs = read('extension/popup.js');
  assert.doesNotMatch(popupJs, /showDirectoryPicker/);
  assert.doesNotMatch(popupJs, /WRITE_DATA/);
}

function assertBackgroundGuardsSenders() {
  const backgroundJs = read('extension/background.js');
  const popupJs = read('extension/popup.js');
  const syncJs = read('extension/sync.js');
  assert.match(backgroundJs, /Unauthorized message sender/);
  assert.match(backgroundJs, /isAuthorizedSender/);
  assert.match(backgroundJs, /normalizeKeyRecord/);
  assert.match(popupJs, /escapeHtml\(key\.label/);
  assert.match(syncJs, /const safeId = escapeHtml/);
}

function assertDurableArchiveDocsExist() {
  const plan = read('docs/DURABLE-LOCAL-ARCHIVE-IMPLEMENTATION-PLAN.md');
  const spec = read('docs/DURABLE-LOCAL-ARCHIVE-SPEC.md');
  const verify = read('docs/VERIFY-LOCAL-ARCHIVE.md');
  const readme = read('README.md');

  assert.match(plan, /Progress Checklist/);
  assert.match(plan, /no local server/i);
  assert.match(spec, /venice-archive\.manifest\.json/);
  assert.match(spec, /without a local server/i);
  assert.match(verify, /Open the Viewer Without a Server/);
  assert.match(verify, /jq/);
  assert.match(verify, /Unresolved media/i);
  assert.match(readme, /## Features/);
  assert.match(readme, /## A look at Archiv/);
  assert.match(readme, /## Browser support/);
  assert.match(readme, /--browser chrome/);
  assert.match(readme, /Archiv is a personal project/i);
  assert.match(readme, /img\.shields\.io/);
  assert.match(readme, /## Inside the archive folder/);
  assert.match(readme, /## Optional browser extension/);
  assert.match(readme, /Most people should skip this section/);
  for (const screenshot of ['library.jpg', 'conversation.jpg', 'search.jpg', 'media-gallery.jpg', 'media-viewer.jpg', 'archive-status.jpg', 'sync.jpg']) {
    assert.equal(existsSync(path.join(root, 'docs', 'screenshots', screenshot)), true, `README screenshot is missing: ${screenshot}`);
    assert.match(readme, new RegExp(`docs/screenshots/${screenshot.replace('.', '\\.')}`));
  }
  assert.doesNotMatch(readme, /## Is the extension required\?/);
  assert.match(readme, /verify:archive/);
  assert.match(verify, /verify:archive/);
  assert.match(read('scripts/verify-archive.mjs'), /sourceStores/);
  assert.match(read('docs/STANDALONE-ARCHIVE-CLI.md'), /controlled, isolated Brave session/i);
  assert.match(read('cli/venice-archive.mjs'), /createRawSnapshot/);
  assert.match(read('cli/lib/extract.mjs'), /GET_OPFS_MEDIA_INDEX/);
  assert.match(read('cli/lib/archive.mjs'), /fts5/);
  assert.match(read('cli/lib/verify-capture.mjs'), /expectedRecords/);
  assert.match(read('cli/lib/snapshot.mjs'), /live-stability-gated/);
  assert.match(read('cli/lib/catalog.mjs'), /listConversations/);
  assert.match(read('cli/ui/app.js'), /openConversation/);
  assert.match(read('cli/ui/app.js'), /ArrowRight/);
  assert.match(read('cli/ui/app.js'), /syncResultMarkup/);
  assert.match(read('cli/ui/app.js'), /inline-media-card/);
  assert.match(read('cli/ui/app.js'), /function inlineAudioPlayer/);
  assert.match(read('cli/ui/app.js'), /<audio src=.* controls preload="metadata"/);
  assert.match(read('cli/ui/app.js'), /document\.addEventListener\('play'/);
  assert.match(read('cli/ui/app.css'), /\.inline-audio-player audio/);
  assert.match(read('cli/ui/app.js'), /search-review-workspace/);
  assert.match(read('cli/ui/app.js'), /data-search-step/);
  assert.match(read('cli/ui/app.js'), /archiveHealth/);
  assert.doesNotMatch(read('cli/ui/app.js'), /Checked and complete|Archive verified/);
  assert.match(read('cli/ui/app.js'), /conversation-media-strip/);
  assert.match(read('cli/ui/app.js'), /stopMediaPlayback/);
  assert.match(read('cli/ui/app.js'), /mediaDetailsOpen/);
  assert.match(read('cli/ui/app.js'), /attachmentPreviewType/);
  assert.match(read('cli/ui/app.js'), /wholeWord/);
  assert.match(read('cli/ui/app.js'), /data-scroll-media/);
  assert.match(read('cli/ui/app.js'), /data-reveal-media/);
  assert.match(read('cli/ui/app.js'), /data-copy-message/);
  assert.match(read('cli/ui/app.js'), /data-prompt-jump/);
  assert.match(read('cli/ui/app.js'), /data-toggle-uploads/);
  assert.match(read('cli/ui/app.js'), /data-favourite-media/);
  assert.match(read('cli/ui/app.js'), /data-toggle-favourites/);
  assert.match(read('cli/ui/app.js'), /data-hidden-media/);
  assert.match(read('cli/ui/app.js'), /data-toggle-hidden/);
  assert.match(read('cli/ui/app.js'), /uiIcon\(filter\.showHidden \? 'eye' : 'eye-off'\)/);
  assert.doesNotMatch(read('cli/ui/app.js'), /data-media-hidden-count/);
  assert.match(read('cli/ui/app.js'), /state\.capabilities\?\.\[name\]/);
  assert.match(read('cli/ui/app.js'), /<span>Starred<\/span>/);
  assert.match(read('cli/ui/app.js'), /function loadMoreMedia/);
  assert.match(read('cli/ui/app.js'), /function refreshMediaAfterFavourite/);
  assert.match(read('cli/ui/app.js'), /data-zoom-map/);
  assert.match(read('cli/ui/app.js'), /function updateZoomNavigator/);
  assert.match(read('cli/ui/app.js'), /const IMAGE_ZOOM_STEPS/);
  assert.match(read('cli/ui/app.js'), /data-zoom-minimise/);
  assert.match(read('cli/ui/app.js'), /data-zoom-actual/);
  assert.match(read('cli/ui/app.js'), /data-zoom-fit/);
  assert.match(read('cli/ui/app.js'), /function imageZoomLayout/);
  assert.match(read('cli/ui/app.js'), /function imageZoomFocusAtPoint/);
  assert.match(read('cli/ui/app.js'), /addEventListener\('dblclick'/);
  assert.match(read('cli/ui/app.js'), /event\.shiftKey \|\| event\.getModifierState\?\.\('Shift'\)/);
  assert.match(read('cli/ui/app.js'), /media-stage\.zoomed[\s\S]*setImageZoom\(false\)/);
  assert.match(read('cli/ui/app.css'), /\.zoom-navigator/);
  assert.match(read('cli/ui/app.css'), /\.zoom-fit-button/);
  assert.match(read('cli/ui/app.css'), /\.media-stage\.zoomed \[data-zoomable\][^{]*\{[^}]*object-fit: fill;/);
  assert.doesNotMatch(read('cli/ui/app.css'), /\.media-stage\.zoomed \[data-zoomable\][^{]*\{[^}]*object-fit: none;/);
  assert.match(read('cli/ui/app.css'), /\.hidden-filter/);
  assert.match(read('cli/ui/app.css'), /\.media-hide-action/);
  assert.match(read('cli/ui/favicon.svg'), /font-family="Georgia/);
  assert.match(read('cli/ui/app.js'), /Restart Archiv to finish enabling media preferences/);
  assert.match(read('cli/ui/app.js'), /id="mediaSort"/);
  assert.doesNotMatch(read('cli/ui/app.js'), /id="mediaStatus"/);
  assert.match(read('cli/ui/app.js'), /status: 'available'/);
  assert.match(read('cli/ui/app.js'), /event\.key\.toLowerCase\(\) === 'i'/);
  assert.match(read('cli/ui/app.js'), /toggleMediaDetails\(\)/);
  assert.match(read('cli/ui/app.js'), /aria-keyshortcuts="i"/);
  assert.match(read('cli/ui/app.js'), /<dt>Model<\/dt>/);
  assert.match(read('cli/ui/app.js'), /class="media-info-model"/);
  assert.match(read('cli/ui/app.js'), /item\.model \|\| 'Not recorded'/);
  assert.match(read('cli/ui/app.js'), /uploads: filter\.uploads \? 'include' : 'exclude'/);
  assert.match(read('cli/ui/app.js'), /hidden: filter\.showHidden \? 'include' : 'exclude'/);
  assert.match(read('cli/ui/index.html'), /Fetch new content/);
  assert.match(read('cli/ui/index.html'), /Sync archive/);
  assert.match(read('cli/ui/index.html'), /aria-label="Open archive sync panel"/);
  assert.match(read('cli/ui/app.css'), /transform-box: view-box/);
  assert.match(read('cli/ui/app.css'), /@keyframes sync-spin/);
  assert.match(read('cli/ui/app.js'), /mediaPan\.dragging/);
  assert.match(read('cli/ui/index.html'), /favicon\.svg/);
  assert.match(read('cli/ui/index.html'), /community project/i);
  assert.match(read('cli/ui/index.html'), /community project by hiroP/i);
  assert.match(read('cli/ui/index.html'), /icon-sprite/);
  assert.match(read('cli/ui/index.html'), /aria-current="page"/);
  assert.match(read('cli/ui/app.css'), /prefers-reduced-motion/);
  assert.doesNotMatch(read('cli/ui/app.js'), /Dropbox|this Mac/);
  assert.doesNotMatch(read('cli/lib/service.mjs'), /up to date and verified/);
  assert.match(read('cli/lib/service.mjs'), /open-location/);
  assert.match(read('cli/lib/service.mjs'), /api\/download/);
  assert.match(read('cli/lib/service.mjs'), /api\/favourites/);
  assert.match(read('cli/lib/service.mjs'), /api\/hidden/);
  assert.match(read('cli/lib/service.mjs'), /hidden-media\.json/);
  assert.match(read('cli/lib/service.mjs'), /capabilities: CAPABILITIES/);
  assert.match(read('cli/lib/catalog.mjs'), /setMediaFavourite/);
  assert.match(read('cli/lib/catalog.mjs'), /setMediaHidden/);
  assert.match(read('cli/lib/normalize-capture.mjs'), /mindMessageId/);
  assert.match(read('cli/lib/normalize-capture.mjs'), /internalMediaSidecar/);
  assert.match(read('cli/lib/snapshot.mjs'), /sourceCheckpointStatus/);
  assert.match(read('cli/lib/extract.mjs'), /planIncrementalExtraction/);
  assert.match(read('cli/venice-archive.mjs'), /initialize: true/);
  assert.match(read('package.json'), /"start": "node cli\/venice-archive\.mjs serve"/);
  assert.match(read('scripts/audit-missing-media.mjs'), /highConfidenceCandidates/);
  assert.match(read('extension/popup.html'), /Encryption and recovery details/);
}

function assertBackupConsolePromotesRepositoryFlow() {
  const backupHtml = read('extension/backup.html');
  const backupJs = read('extension/backup.js');

  assert.match(backupHtml, /id="repositoryBtn"/);
  assert.match(backupHtml, /1 · Check/);
  assert.match(backupHtml, /2 · Back up/);
  assert.match(backupHtml, /3 · Verify and browse/);
  assert.match(backupHtml, /Only offload Venice data after verification/);
  assert.match(backupHtml, /id="retryDownloadsBtn"/);
  assert.match(backupHtml, /id="progressSection"/);
  assert.match(backupHtml, /id="progressLatest"/);
  assert.match(backupHtml, /id="progressElapsed"/);
  assert.match(backupHtml, /position: sticky/);
  assert.match(backupHtml, /id="packageBaselineBadge"/);
  assert.match(backupHtml, /id="packageDiffHelp"/);
  assert.match(backupHtml, /Incremental ZIP settings/);
  assert.match(backupHtml, /id="archiveLocationCard"/);
  assert.match(backupHtml, /id="chooseArchiveLocationBtn"/);
  assert.match(backupHtml, /id="verifyArchiveLocationBtn"/);
  assert.match(backupHtml, /id="forgetArchiveLocationBtn"/);
  assert.match(backupHtml, /lib\/archive-repository\.js/);
  assert.match(backupHtml, /lib\/archive-coverage\.js/);
  assert.match(backupHtml, /lib\/studio-transform\.js/);
  assert.match(backupHtml, /lib\/stream-hash\.js/);
  assert.match(backupJs, /async function performRepositoryBackup/);
  assert.match(backupJs, /showDirectoryPicker/);
  assert.match(backupJs, /venice-archive\.manifest\.json|ROOT_MANIFEST_FILE/);
  assert.match(backupJs, /buildArchiveStoreRequests/);
  assert.match(backupJs, /buildRepositorySourceStoreArtifacts/);
  assert.match(backupJs, /materializeRepositoryCapturedMediaForPackage/);
  assert.match(backupJs, /materializeRepositoryOpfsMedia/);
  assert.match(backupJs, /computeCrc32Blob/);
  assert.match(backupJs, /VeniceStreamHash/);
  assert.match(backupJs, /buildRepositoryViewerDataParts/);
  assert.match(backupJs, /appendInlineJsonArrayExpression/);
  assert.match(backupJs, /buildJsonLinesBlob/);
  assert.match(backupJs, /buildRepositoryViewerDataBlob/);
  assert.match(backupJs, /extractGenericStoreMediaCandidates/);
  assert.match(backupJs, /__embeddedPayload/);
  assert.match(backupJs, /refreshPackageBaselineStatus/);
  assert.match(backupJs, /Incremental package blocked/);
  assert.match(backupJs, /Extract this zip over that same folder/);
  assert.match(backupJs, /ARCHIVE_LOCATION_DB_NAME/);
  assert.match(backupJs, /getWritableArchiveDirectoryHandle/);
  assert.match(backupJs, /verifyArchiveLocation/);
  assert.match(backupJs, /Why ZIP mode\?/);
  assert.match(backupJs, /Brave refused extension access/);
  assert.match(backupJs, /chrome\.permissions\.contains/);
  assert.match(backupJs, /sourceTabId/);
  assert.match(backupJs, /isSupportedVeniceUrl/);
  assert.match(backupJs, /Search conversations, messages, files/);
  assert.match(backupJs, /mediaSourceFilter/);
  assert.match(backupJs, /maintenanceCard/);
  assert.match(backupJs, /applyPackageBtn/);
  assert.match(backupJs, /parseStoredPackage/);
  assert.match(backupJs, /writePackageEntry/);
  assert.match(backupJs, /venice-archive-viewer-state/);

  const popupJs = read('extension/popup.js');
  assert.match(popupJs, /loadArchiveLocationSummary/);
  assert.match(popupJs, /ARCHIVE_LOCATION_DB_NAME/);
  assert.match(popupJs, /sourceTabId/);

  const contentMain = read('extension/content-main.js');
  assert.match(contentMain, /const DB_NAME = 'venice-db-encrypted';/);
  assert.match(contentMain, /RX_UNKNOWN_STORE_PREFIX/);
  assert.match(contentMain, /RX_PHYSICAL_STORE_PREFIX/);
  assert.match(contentMain, /listRxStoreDescriptors/);
  assert.match(contentMain, /getRxPhysicalStoreInventory/);
  assert.match(contentMain, /GENERIC_IDB_STORE_PREFIX/);
  assert.match(contentMain, /getGenericIdbStoreInventory/);
  assert.match(contentMain, /videoStudioActiveGenerations/);
  assert.match(contentMain, /browserSessionStorage/);
  assert.match(contentMain, /GET_OPFS_MEDIA_INDEX/);
  assert.match(contentMain, /FETCH_OPFS_MEDIA/);
  assert.match(contentMain, /rxStoreReadCache/);
  assert.match(contentMain, /legacyStoreReadCache/);
  assert.match(contentMain, /genericIdbStoreReadCache/);
  assert.match(contentMain, /captureRecordSetFingerprint/);
  assert.match(contentMain, /mutableDuringExport: true/);
  assert.match(contentMain, /navigator\.storage\.getDirectory/);

  const protocol = '2026-07-store-api-v12-tab-handoff';
  for (const relativePath of ['extension/content-main.js', 'extension/content-bridge.js', 'extension/popup.js', 'extension/backup.js']) {
    assert.match(read(relativePath), new RegExp(protocol));
  }
}

function main() {
  assertNoTrackedSecrets();
  assertAgplReleaseMetadata();
  assertNoTrackedPrivateArtifacts();
  assertGitignoreCoversLocalConfig();
  assertVendoredCryptoIsPinned();
  assertManifestIsTight();
  assertCliVersionsAreAligned();
  assertHtmlHasCsp();
  assertNoReservedExtensionPaths();
  assertWritesAreDisabled();
  assertRestoreIsGated();
  assertPopupNoLongerShipsLegacyFlows();
  assertBackgroundGuardsSenders();
  assertDurableArchiveDocsExist();
  assertBackupConsolePromotesRepositoryFlow();

  console.log('release-checks: ok');
}

main();
