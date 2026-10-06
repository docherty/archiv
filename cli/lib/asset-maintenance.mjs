import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const script = fileURLToPath(new URL('../../scripts/asset-store.py', import.meta.url));

export async function maintainAssetStore(archive, { onProgress = () => {}, timeoutMs = 30000 } = {}) {
  for (const relative of ['asset-store', 'asset-store/maintenance.json']) {
    let info;
    try { info = await lstat(path.join(archive, relative)); }
    catch (error) { if (error.code === 'ENOENT') return { maintenance: 'disabled', files: 0 }; throw error; }
    if (info.isSymbolicLink()) throw new Error('Unsafe asset maintenance policy path');
  }
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.env.ARCHIV_PYTHON || 'python3', [script, '--archive', archive, 'maintain'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out = (out + chunk).slice(-20000); });
    child.stderr.on('data', chunk => { err = (err + chunk).slice(-20000); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0) return reject(new Error(`Asset maintenance failed (${signal || code}); originals retained for retry: ${err.trim()}`));
      try { resolve(JSON.parse(out.trim().split('\n').at(-1))); } catch (error) { reject(error); }
    });
  });
  if (result.removedFiles) onProgress(`Shared asset maintenance: ${result.removedFiles} files consolidated after native delta proof`);
  if (result.pendingFiles) throw new Error(`Shared asset maintenance has ${result.pendingFiles} queued files; retry the next bounded pass`);
  return result;
}
