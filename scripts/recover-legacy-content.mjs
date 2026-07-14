import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recoverLegacyContent } from '../cli/lib/recovery.mjs';

function values(name) {
  const results = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === `--${name}` && process.argv[index + 1]) results.push(process.argv[++index]);
    else if (process.argv[index].startsWith(`--${name}=`)) results.push(process.argv[index].slice(name.length + 3));
  }
  return results;
}

const archive = values('archive')[0];
if (!archive) {
  throw new Error('Usage: npm run recover:legacy -- --archive <folder> [--backup <legacy.json>] [--media-dir <folder>] [--apply]');
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = await recoverLegacyContent({
  archive,
  backups: values('backup'),
  mediaDirectories: values('media-dir'),
  apply: process.argv.includes('--apply'),
  projectRoot
});

console.log(JSON.stringify(result, null, 2));
