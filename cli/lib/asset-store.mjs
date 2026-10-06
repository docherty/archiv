import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chmod, copyFile, mkdir, mkdtemp } from 'node:fs/promises';

const SCHEMA = 'archiv.asset-store.v1';
const ID = /^assets-[a-f0-9]{32}$/;
const SHA = /^[a-f0-9]{64}$/;
const resolvers = new Map();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const stamp = value => [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs, value.mode].join(':');

export function assetPathAllowed(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') || path.posix.normalize(relative) !== relative || relative.startsWith('/') || relative.split('/').includes('..')) return false;
  const parts = relative.split('/');
  return parts.length > 3 && parts[0] === 'captures' && parts[2] === 'opfs'
    || parts.length > 2 && parts[0] === 'media' && parts[1] === 'sha256'
    || parts.length > 2 && ['materialized-media', 'recovered-media', 'recovered-content'].includes(parts[0]) && parts[1] === 'media';
}

async function noSymlinkPath(root, relative) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('Symlink in asset-store path');
  }
  return current;
}

async function readGeneration(root, identity, expectedHash, seen = new Set()) {
  if (!ID.test(identity) || !SHA.test(expectedHash) || seen.has(identity) || seen.size >= 200) throw new Error('Invalid/cyclic asset base chain');
  seen.add(identity);
  const bytes = await readFile(await noSymlinkPath(root, `asset-store/trees/${identity}.json`));
  const receipt = JSON.parse(await readFile(await noSymlinkPath(root, `asset-store/receipts/${identity}.json`)));
  if (digest(bytes) !== expectedHash || receipt.treeSha256 !== expectedHash) throw new Error('Asset tree checksum mismatch');
  const tree = JSON.parse(bytes);
  if (tree.schema !== SCHEMA || tree.tree !== identity || tree.objects !== '../raw-store/objects' || !Array.isArray(tree.entries)) throw new Error('Unsupported asset tree');
  const own = new Map();
  for (const entry of tree.entries) {
    if (!assetPathAllowed(entry.path) || own.has(entry.path) || !['file', 'alias'].includes(entry.type) || !SHA.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('Invalid asset entry');
    own.set(entry.path, entry);
  }
  for (const item of tree.legacy || []) {
    const entry = own.get(item.path);
    if (!entry || item.sha256 !== entry.sha256 || item.size !== entry.size) throw new Error('Invalid legacy asset association');
  }
  const base = tree.baseTree ? await readGeneration(root, tree.baseTree.tree, tree.baseTree.sha256, seen) : { entries: new Map(), legacy: [] };
  for (const [key, entry] of own) base.entries.set(key, entry);
  return { entries: base.entries, legacy: [...base.legacy, ...(tree.legacy || [])] };
}

export class AssetResolver {
  constructor(archive) {
    this.root = path.resolve(archive);
    this.entries = new Map();
    this.legacy = [];
    this.checked = new Map();
    this.pointerStamp = null;
  }

  async load() {
    let current;
    try { current = await noSymlinkPath(this.root, 'asset-store/current.json'); }
    catch (error) {
      if (error.code === 'ENOENT') {
        try {
          await lstat(path.join(this.root, 'asset-store/FORMAT.json'));
          throw new Error('Existing asset store lost its published pointer');
        } catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
        this.entries.clear(); this.legacy = []; this.pointerStamp = null;
        return this;
      }
      throw error;
    }
    const info = await lstat(current);
    if (this.pointerStamp === stamp(info)) return this;
    const pointer = JSON.parse(await readFile(current));
    if (pointer.schema !== SCHEMA || !ID.test(pointer.tree) || !SHA.test(pointer.treeSha256)) throw new Error('Invalid asset pointer');
    const generation = await readGeneration(this.root, pointer.tree, pointer.treeSha256);
    const entries = generation.entries;
    // A changed tree is never combined with a pointer from a different generation.
    if (stamp(await lstat(current)) !== stamp(info)) throw new Error('Asset pointer changed while loading');
    this.entries = entries;
    this.legacy = generation.legacy;
    this.pointerStamp = stamp(info);
    return this;
  }

  async resolve(file, expectedSha256 = null) {
    await this.load();
    const absolute = path.resolve(file);
    const relative = path.relative(this.root, absolute).split(path.sep).join('/');
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('Asset path outside archive');
    const entry = this.entries.get(relative);
    if (!entry) return absolute;
    if (expectedSha256 && entry.sha256 !== expectedSha256) throw new Error('Asset declaration checksum conflicts with reference');
    const objectRelative = `raw-store/objects/${entry.sha256.slice(0, 2)}/${entry.sha256}`;
    const object = await noSymlinkPath(this.root, objectRelative);
    const handle = await open(object, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== entry.size) throw new Error('Missing or wrong-size asset object');
      const signature = stamp(info);
      if (this.checked.get(entry.sha256) !== signature) {
        const hash = createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
        if (hash.digest('hex') !== entry.sha256 || stamp(await handle.stat()) !== signature || stamp(await lstat(object)) !== signature) throw new Error('Asset object checksum or identity mismatch');
        this.checked.set(entry.sha256, signature);
      }
      return object;
    } finally { await handle.close(); }
  }
}

export function assetResolver(archive) {
  const key = path.resolve(archive);
  if (!resolvers.has(key)) resolvers.set(key, new AssetResolver(key));
  return resolvers.get(key);
}

export async function resolveAssetPath(archive, file, expectedSha256 = null) {
  return assetResolver(archive).resolve(file, expectedSha256);
}


// Explicit Finder/reveal export: never open an editable canonical object as a user file.
export async function assetWorkingCopy(archive, file, fileName, sha256, directory = null) {
  const root = path.resolve(archive);
  const base = directory || path.join(process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Caches') : path.join(os.homedir(), '.cache'), 'archiv', digest(root).slice(0, 20), 'media-views');
  const relative = path.relative(root, path.resolve(base));
  if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error('Working copies must stay outside the archive');
  await mkdir(base, { recursive: true, mode: 0o700 });
  if ((await lstat(base)).isSymbolicLink()) throw new Error('Unsafe working-copy directory');
  const realRelative = path.relative(await realpath(root), await realpath(base));
  if (!realRelative || realRelative !== '..' && !realRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(realRelative)) throw new Error('Working-copy parent redirects inside the archive');
  const folder = await mkdtemp(path.join(base, 'view-'));
  const name = path.basename(String(fileName || 'archived-file')).replaceAll('\0', '_');
  const target = path.join(folder, name === '.' || name === '..' ? 'archived-file' : name);
  await copyFile(file, target, constants.COPYFILE_EXCL);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    if (hash.digest('hex') !== sha256) throw new Error('Working-copy checksum mismatch');
  } finally { await handle.close(); }
  await chmod(target, 0o600);
  return target;
}
