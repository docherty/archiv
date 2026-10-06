import { constants as fsConstants } from 'node:fs';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { ensureDirectory, run } from './util.mjs';

export async function copySnapshotPath(source, target, options = {}) {
  if (process.platform === 'darwin') {
    // Node/libuv silently falls back to full copies for FICLONE on macOS; FORCE returns ENOSYS.
    // Use macOS's native clonefile-backed cp instead, also preserving source timestamps.
    await ensureDirectory(path.dirname(target));
    try {
      await run('/bin/cp', ['-cRfp', source, target], { env: { ...process.env, LC_ALL: 'C' } });
      return;
    } catch (error) {
      if (/No such file or directory/.test(error.message)) error.code = 'ENOENT';
      if (/No space left on device/.test(error.message)) error.code = 'ENOSPC';
      if (options.mode === fsConstants.COPYFILE_FICLONE_FORCE || error.code === 'ENOENT' || error.code === 'ENOSPC') throw error;
    }
  }
  await cp(source, target, options);
}
