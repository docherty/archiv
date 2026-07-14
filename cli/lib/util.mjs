import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const options = { _: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith('--')) {
      options._.push(value);
      continue;
    }
    const [rawKey, inlineValue] = value.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      options[rawKey] = inlineValue;
    } else if (rest[index + 1] && !rest[index + 1].startsWith('--')) {
      options[rawKey] = rest[++index];
    } else {
      options[rawKey] = true;
    }
  }
  return { command, options };
}

export async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function pathExists(value) {
  try {
    await stat(value);
    return true;
  } catch {
    return false;
  }
}

export async function directorySize(root) {
  if (!(await pathExists(root))) return 0;
  const entries = await readdir(root, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}

export async function listFiles(root, prefix = '') {
  const results = [];
  if (!(await pathExists(root))) return results;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) results.push(...await listFiles(absolute, relative));
    else if (entry.isFile()) results.push({ relative, absolute, stat: await stat(absolute) });
  }
  return results;
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
      cwd: options.cwd,
      env: options.env || process.env
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; options.onStdout?.(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += chunk; options.onStderr?.(chunk); });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(`${command} exited with ${code ?? signal}: ${stderr.trim() || stdout.trim()}`));
    });
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
    options.onChild?.(child);
  });
}

export function timestampId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** exponent)).toFixed(exponent && bytes < 10 * (1024 ** exponent) ? 1 : 0)} ${units[exponent]}`;
}

export function safeName(value) {
  return String(value || 'item').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'item';
}
