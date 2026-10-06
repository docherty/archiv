import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { resolveAssetPath } from './asset-store.mjs';

async function hashAndCountLines(filePath) {
  const hash = createHash('sha256');
  let lines = 0;
  const stream = createReadStream(filePath);
  stream.on('data', (chunk) => hash.update(chunk));
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of reader) if (line.length) lines += 1;
  return { sha256: hash.digest('hex'), lines, bytes: (await stat(filePath)).size };
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  const fileStat = await stat(filePath);
  return { sha256: hash.digest('hex'), bytes: fileStat.size };
}

export async function verifyCapture(captureDirectory, { onProgress = () => {}, writeReport = true } = {}) {
  const manifest = JSON.parse(await readFile(path.join(captureDirectory, 'capture.manifest.json'), 'utf8'));
  const errors = [];
  const stores = [];
  for (let index = 0; index < (manifest.stores || []).length; index += 1) {
    const entry = manifest.stores[index];
    try {
      const result = await hashAndCountLines(path.join(captureDirectory, entry.path));
      if (result.lines !== entry.records) errors.push(`${entry.name}: manifest reports ${entry.records} records but file contains ${result.lines}.`);
      if (entry.expectedRecords !== undefined && entry.expectedRecords !== null && result.lines !== entry.expectedRecords) errors.push(`${entry.name}: Venice inventory reported ${entry.expectedRecords} records but ${result.lines} were captured.`);
      stores.push({ ...entry, ...result });
    } catch (error) {
      errors.push(`${entry.name}: ${error.message}`);
    }
    if (index === 0 || index + 1 === manifest.stores.length || (index + 1) % 25 === 0) onProgress(`Verifying stores ${index + 1}/${manifest.stores.length}`);
  }

  const opfs = [];
  for (let index = 0; index < (manifest.opfs || []).length; index += 1) {
    const entry = manifest.opfs[index];
    try {
      const result = await hashFile(await resolveAssetPath(path.resolve(captureDirectory, '../..'), path.join(captureDirectory, entry.archivedPath)));
      if (result.bytes !== entry.size) errors.push(`${entry.path}: expected ${entry.size} bytes but captured ${result.bytes}.`);
      opfs.push({ path: entry.path, archivedPath: entry.archivedPath, expectedBytes: entry.size, ...result });
    } catch (error) {
      errors.push(`${entry.path}: ${error.message}`);
    }
    if (index === 0 || index + 1 === manifest.opfs.length || (index + 1) % 50 === 0) onProgress(`Verifying OPFS ${index + 1}/${manifest.opfs.length}`);
  }

  const report = {
    schemaVersion: 1,
    captureId: manifest.runId,
    verifiedAt: new Date().toISOString(),
    ok: errors.length === 0 && stores.length > 0,
    totals: {
      stores: stores.length,
      storeRecords: stores.reduce((sum, item) => sum + item.lines, 0),
      opfsFiles: opfs.length,
      opfsBytes: opfs.reduce((sum, item) => sum + item.bytes, 0)
    },
    stores,
    opfs,
    errors
  };
  if (writeReport) await writeFile(path.join(captureDirectory, 'capture.verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
