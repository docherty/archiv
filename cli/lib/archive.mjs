import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { ensureDirectory, pathExists, run } from './util.mjs';

function assertSafeZipEntry(entry) {
  const normalized = entry.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`Unsafe ZIP entry: ${entry}`);
  }
}

export async function importArchiveZip({ zipPath, archiveDirectory, verifyScript }) {
  const listing = await run('/usr/bin/unzip', ['-Z1', zipPath]);
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
  entries.forEach(assertSafeZipEntry);
  if (!entries.includes('venice-archive.manifest.json')) throw new Error('ZIP is not a Venice local archive package.');
  await ensureDirectory(archiveDirectory);
  await run('/usr/bin/unzip', ['-oq', zipPath, '-d', archiveDirectory]);
  let verification = { ok: true, error: null };
  if (verifyScript) {
    try {
      await run(process.execPath, [verifyScript, archiveDirectory]);
    } catch (error) {
      verification = { ok: false, error: error.message };
    }
  }
  return {
    entries: entries.length,
    manifest: JSON.parse(await readFile(path.join(archiveDirectory, 'venice-archive.manifest.json'), 'utf8')),
    verification
  };
}

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replaceAll("'", "''").replaceAll('\u0000', '')}'`;
}

function flattenMediaText(item) {
  return [item.fileName, item.kind, item.mimeType, item.source, item.prompt, item.model, item.originalUrl].filter(Boolean).join(' ');
}

export async function buildSearchIndex(archiveDirectory) {
  const indexes = path.join(archiveDirectory, 'indexes');
  const conversationsPath = path.join(indexes, 'conversations.json');
  const messagesPath = path.join(indexes, 'messages.jsonl');
  const mediaPath = path.join(indexes, 'media.json');
  for (const required of [conversationsPath, messagesPath, mediaPath]) {
    if (!(await pathExists(required))) throw new Error(`Archive index is missing: ${path.relative(archiveDirectory, required)}`);
  }

  const searchDirectory = await ensureDirectory(path.join(archiveDirectory, 'search'));
  const databasePath = path.join(searchDirectory, 'venice-search.sqlite');
  const child = spawn('/usr/bin/sqlite3', [databasePath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const write = (sql) => child.stdin.write(`${sql}\n`);
  write('PRAGMA journal_mode=WAL;');
  write('DROP TABLE IF EXISTS archive_items;');
  write('DROP TABLE IF EXISTS archive_fts;');
  write('CREATE TABLE archive_items(rowid INTEGER PRIMARY KEY, type TEXT NOT NULL, item_id TEXT, conversation_id TEXT, title TEXT, body TEXT, path TEXT, created_at TEXT);');
  write("CREATE VIRTUAL TABLE archive_fts USING fts5(type UNINDEXED, item_id UNINDEXED, conversation_id UNINDEXED, title, body, path UNINDEXED, content='archive_items', content_rowid='rowid', tokenize='unicode61');");
  write('BEGIN;');

  let count = 0;
  const conversations = JSON.parse(await readFile(conversationsPath, 'utf8'));
  for (const item of conversations) {
    write(`INSERT INTO archive_items(type,item_id,conversation_id,title,body,path,created_at) VALUES('conversation',${sqlValue(item.id)},${sqlValue(item.id)},${sqlValue(item.title)},${sqlValue(item.preview)},${sqlValue(item.markdownPath || item.jsonPath)},${sqlValue(item.updatedAt || item.createdAt)});`);
    count += 1;
  }

  const lines = readline.createInterface({ input: createReadStream(messagesPath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const item = JSON.parse(line);
    write(`INSERT INTO archive_items(type,item_id,conversation_id,title,body,path,created_at) VALUES('message',${sqlValue(item.id)},${sqlValue(item.conversationId)},${sqlValue(item.conversationTitle)},${sqlValue(item.text)},NULL,${sqlValue(item.createdAt)});`);
    count += 1;
  }

  const mediaDocument = JSON.parse(await readFile(mediaPath, 'utf8'));
  for (const item of mediaDocument.items || []) {
    write(`INSERT INTO archive_items(type,item_id,conversation_id,title,body,path,created_at) VALUES('media',${sqlValue(item.mediaId || item.id)},${sqlValue(item.conversationId)},${sqlValue(item.fileName || item.kind)},${sqlValue(flattenMediaText(item))},${sqlValue(item.path)},NULL);`);
    count += 1;
  }
  write('COMMIT;');
  write("INSERT INTO archive_fts(archive_fts) VALUES('rebuild');");
  write('PRAGMA optimize;');
  child.stdin.end();
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`sqlite3 index build failed: ${stderr.trim()}`)));
  });
  await writeFile(path.join(searchDirectory, 'index.meta.json'), `${JSON.stringify({ schemaVersion: 1, builtAt: new Date().toISOString(), items: count }, null, 2)}\n`);
  return { databasePath, items: count };
}

function ftsQuery(value) {
  const tokens = String(value || '').match(/[\p{L}\p{N}_-]+/gu) || [];
  if (!tokens.length) throw new Error('Enter at least one searchable word.');
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' AND ');
}

export async function searchArchive(archiveDirectory, query, limit = 25) {
  const databasePath = path.join(archiveDirectory, 'search', 'venice-search.sqlite');
  if (!(await pathExists(databasePath))) throw new Error('Search index not found. Run the index command first.');
  const match = ftsQuery(query);
  const sql = `SELECT i.type,i.item_id AS id,i.conversation_id,i.title,snippet(archive_fts,4,'[',']','…',18) AS excerpt,i.path,i.created_at FROM archive_fts JOIN archive_items i ON i.rowid=archive_fts.rowid WHERE archive_fts MATCH ${sqlValue(match)} ORDER BY bm25(archive_fts) LIMIT ${Math.max(1, Math.min(200, Number(limit) || 25))};`;
  const result = await run('/usr/bin/sqlite3', ['-json', databasePath, sql]);
  return result.stdout.trim() ? JSON.parse(result.stdout) : [];
}

export async function searchArchiveTree(archiveDirectory, query, limit = 25) {
  const locations = [];
  const capturesRoot = path.join(archiveDirectory, 'captures');
  if (await pathExists(capturesRoot)) {
    const captures = (await readdir(capturesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const capture of captures) locations.push({ name: capture, directory: path.join(capturesRoot, capture) });
  }
  locations.push({ name: 'imported archive', directory: archiveDirectory });

  const merged = [];
  const seen = new Set();
  for (const location of locations) {
    if (!(await pathExists(path.join(location.directory, 'search', 'venice-search.sqlite')))) continue;
    for (const item of await searchArchive(location.directory, query, limit)) {
      const key = `${item.type}:${item.id || ''}:${item.conversation_id || ''}:${item.title || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...item, archive_source: location.name, archive_directory: location.directory });
      if (merged.length >= Math.max(1, Number(limit) || 25)) return merged;
    }
  }
  return merged;
}
