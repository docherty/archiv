import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ArchiveCatalog } from '../cli/lib/catalog.mjs';

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function filesBelow(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
}

const archive = path.resolve(option('archive') || '');
const source = path.resolve(option('source') || '');
if (!option('archive') || !option('source')) throw new Error('Usage: node scripts/audit-missing-media.mjs --archive <archive> --source <folder>');

const catalog = await new ArchiveCatalog(archive).reload();
const missing = catalog.media.filter((item) => !item.available);
const missingById = new Map(missing.map((item) => [item.id, item]));
const missingByMessageKind = new Map();
for (const item of missing) {
  if (!item.messageId) continue;
  const key = `${item.messageId}:${item.kind}`;
  if (!missingByMessageKind.has(key)) missingByMessageKind.set(key, []);
  missingByMessageKind.get(key).push(item);
}

const sourceFiles = await filesBelow(source);
const mediaIndexes = sourceFiles.filter((file) => path.basename(file) === 'media.json' && path.basename(path.dirname(file)) === 'indexes');
const candidateMap = new Map();
for (const indexPath of mediaIndexes) {
  let document;
  try { document = JSON.parse(await readFile(indexPath, 'utf8')); } catch { continue; }
  const repository = path.dirname(path.dirname(indexPath));
  for (const item of document.items || []) {
    if (!item.path || !item.messageId) continue;
    const targets = missingByMessageKind.get(`${item.messageId}:${item.kind}`) || [];
    if (!targets.length) continue;
    const file = path.resolve(repository, item.path);
    let fileStat;
    try { fileStat = await stat(file); } catch { continue; }
    if (!fileStat.isFile()) continue;
    for (const target of targets) {
      if (!candidateMap.has(target.id)) candidateMap.set(target.id, []);
      candidateMap.get(target.id).push({
        file,
        archive: repository,
        sha256: item.sha256 || null,
        bytes: fileStat.size,
        source: item.source || null,
        fileName: item.fileName || null
      });
    }
  }
}

const exactNameMap = new Map();
for (const file of sourceFiles) {
  const key = path.basename(file).toLowerCase();
  if (!exactNameMap.has(key)) exactNameMap.set(key, []);
  exactNameMap.get(key).push(file);
}
const exactNameMatches = missing.filter((item) => item.fileName && exactNameMap.has(path.basename(item.fileName).toLowerCase()));
const candidates = [...candidateMap].map(([id, matches]) => {
  const identities = new Set(matches.map((match) => match.sha256 || `${match.file}:${match.bytes}`));
  return { id, confidence: identities.size === 1 ? 'high' : 'ambiguous', matches };
});

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

let recovered = [];
if (process.argv.includes('--apply')) {
  const recoveryRoot = path.join(archive, 'recovered-media');
  const indexes = path.join(recoveryRoot, 'indexes');
  await mkdir(indexes, { recursive: true });
  for (const candidate of candidates.filter((item) => item.confidence === 'high')) {
    const sourceItem = candidate.matches.find((match) => match.sha256) || candidate.matches[0];
    const digest = await sha256(sourceItem.file);
    if (sourceItem.sha256 && sourceItem.sha256 !== digest) continue;
    const extension = path.extname(sourceItem.file).toLowerCase() || '.bin';
    const relative = ['media', 'sha256', digest.slice(0, 2), `${digest}${extension}`].join('/');
    const destination = path.join(recoveryRoot, ...relative.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(sourceItem.file, destination);
    const target = missingById.get(candidate.id);
    recovered.push({
      ...target,
      mediaId: target.id,
      path: relative,
      available: true,
      status: 'recovered',
      sha256: digest,
      bytes: sourceItem.bytes,
      source: target.source || sourceItem.source || 'recovered-media',
      recoveredAt: new Date().toISOString(),
      recoveredFrom: path.relative(source, sourceItem.file)
    });
  }
  const mediaPath = path.join(indexes, 'media.json');
  let previous = { items: [] };
  try { previous = JSON.parse(await readFile(mediaPath, 'utf8')); } catch {}
  const merged = new Map((previous.items || []).map((item) => [item.mediaId || item.id, item]));
  for (const item of recovered) merged.set(item.mediaId, item);
  const items = [...merged.values()];
  await writeFile(mediaPath, `${JSON.stringify({ totals: { total: items.length }, items }, null, 2)}\n`);
  await writeFile(path.join(recoveryRoot, 'recovery.manifest.json'), `${JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), source, items: recovered.map((item) => ({ mediaId: item.mediaId, path: item.path, sha256: item.sha256, bytes: item.bytes, recoveredFrom: item.recoveredFrom })) }, null, 2)}\n`);
}

console.log(JSON.stringify({
  archive,
  source,
  missingReferences: missing.length,
  filesScanned: sourceFiles.length,
  archiveIndexesScanned: mediaIndexes.length,
  stableMessageCandidates: candidates.length,
  highConfidenceCandidates: candidates.filter((item) => item.confidence === 'high').length,
  ambiguousCandidates: candidates.filter((item) => item.confidence === 'ambiguous').length,
  exactFilenameReferences: exactNameMatches.length,
  applied: recovered.length,
  candidates
}, null, 2));
