import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AssetResolver, resolveAssetPath } from '../cli/lib/asset-store.mjs';
import { ArchiveCatalog } from '../cli/lib/catalog.mjs';
import { startArchiveService } from '../cli/lib/service.mjs';
import { verifyCapture } from '../cli/lib/verify-capture.mjs';
import { materializeEmbeddedMedia } from '../cli/lib/materialize-media.mjs';

const script = new URL('../scripts/asset-store.py', import.meta.url).pathname;
const python = process.env.ARCHIV_PYTHON || 'python3';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const captureId = 'capture-2026-01-01T00-00-00-000Z';

async function put(root, relative, bytes) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return file;
}
function cli(archive, args, ok = true) {
  const result = spawnSync(python, [script, '--archive', archive, ...args], { encoding: 'utf8', timeout: 30000 });
  if (ok) assert.equal(result.status, 0, result.stderr || result.error?.message);
  else assert.notEqual(result.status, 0);
  return ok ? JSON.parse(result.stdout.trim().split('\n').at(-1)) : result;
}
async function fixture(run) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'archiv-assets-'));
  const root = path.join(parent, 'archive');
  await mkdir(root);
  const original = `media/sha256/${sha(png).slice(0, 2)}/${sha(png)}.png`;
  const stale = original.replace(/\.png$/, '.jpg');
  const second = `materialized-media/media/sha256/${sha(png).slice(0, 2)}/${sha(png)}.png`;
  const opfs = `captures/${captureId}/opfs/media/c1/${sha(png)}`;
  await put(root, original, png);
  await put(root, second, png);
  await put(root, opfs, png);
  await put(root, `captures/${captureId}/stores/messages.jsonl`, JSON.stringify({ id: 'm1', conversationId: 'c1', role: 'assistant', text: 'source text' })+'\n');
  await put(root, `captures/${captureId}/indexes/conversations.json`, '[]');
  await put(root, `captures/${captureId}/indexes/messages.jsonl`, '');
  await put(root, `captures/${captureId}/indexes/media.json`, JSON.stringify({ items: [{ mediaId: 'current', path: `opfs/media/c1/${sha(png)}`, sha256: sha(png), bytes: png.length, fileName: 'picture.png', kind: 'image' }] }));
  await put(root, `captures/${captureId}/capture.manifest.json`, JSON.stringify({ runId: captureId,
    stores: [{ name: 'messages', path: 'stores/messages.jsonl', records: 1 }],
    opfs: [{ path: `media/c1/${sha(png)}`, archivedPath: `opfs/media/c1/${sha(png)}`, size: png.length, fileName: sha(png) }] }));
  await verifyCapture(path.join(root, 'captures', captureId));
  await put(root, 'indexes/conversations.json', '[]');
  await put(root, 'indexes/messages.jsonl', '');
  await put(root, 'indexes/media.json', JSON.stringify({ items: [
    { mediaId: 'old-unlisted-id', path: stale, sha256: sha(png), bytes: png.length, fileName: 'oldname.jpg', status: 'deduped', kind: 'image', mimeType: 'image/jpeg' }
  ] }));
  const unused = sha('SECRET-ONLY-RAW');
  await put(root, `raw-store/objects/${unused.slice(0, 2)}/${unused}`, 'SECRET-ONLY-RAW');
  const before = await readFile(path.join(root, 'indexes/media.json'));
  try { await run({ parent, root, original, stale, second, opfs, unused, before }); }
  finally { await rm(parent, { recursive: true, force: true }); }
}

test('one shared pool preserves every original path, native metadata and stale alias; proof gates unlink', async () => fixture(async ({ parent, root, original, second, stale, before }) => {
  await chmod(path.join(root, original), 0o604);
  const originalQuarantine = new Map();
  if (process.platform === 'darwin') {
    for (const [file, name, value, fork] of [[original, 'alpha', 'original A metadata', 'opaque original A fork'], [second, 'beta', 'original B metadata', 'opaque different B fork']]) {
      execFileSync('/usr/bin/xattr', ['-w', `com.example.${name}`, value, path.join(root, file)]);
      execFileSync('/usr/bin/xattr', ['-w', 'com.apple.ResourceFork', fork, path.join(root, file)]);
      execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;12345678;OriginalTestApp;test-source-id', path.join(root, file)]);
      originalQuarantine.set(file, execFileSync('/usr/bin/xattr', ['-px', 'com.apple.quarantine', path.join(root, file)]));
    }
  } else {
    execFileSync(python, ['-c', `import os\nos.setxattr(${JSON.stringify(path.join(root, original))},'user.alpha',b'original A metadata')\nos.setxattr(${JSON.stringify(path.join(root, second))},'user.beta',b'original B metadata')\n`]);
  }
  // Seed the shared object from origin A with its native metadata: B must not inherit it.
  const existingObject = path.join(root, `raw-store/objects/${sha(png).slice(0,2)}/${sha(png)}`);
  await mkdir(path.dirname(existingObject), { recursive: true });
  if (process.platform === 'darwin') execFileSync('/bin/cp', ['-p', path.join(root, original), existingObject]);
  else execFileSync(python, ['-c', `import shutil\nshutil.copy2(${JSON.stringify(path.join(root, original))},${JSON.stringify(existingObject)})`]);
  const prepared = cli(root, ['prepare']);
  assert.equal(prepared.paths, 4);
  assert.equal(prepared.aliases, 1);
  assert.equal(prepared.newObjectBytes, 0);
  assert.deepEqual(await readFile(path.join(root, original)), png);
  cli(root, ['remove'], false);
  assert.deepEqual(await readFile(path.join(root, original)), png);
  const proof = cli(root, ['proof', '--destination', path.join(parent, 'proof'), '--cleanup']);
  assert.equal(proof.restoreProof, true);
  assert.equal(proof.temporaryRestoreRemoved, true);
  assert.equal(cli(root, ['remove']).removedFiles, 3);
  assert.equal((await new AssetResolver(root).load()).entries.size, 4);
  assert.deepEqual(await readFile(await resolveAssetPath(root, path.join(root, stale))), png);
  assert.deepEqual(await readFile(path.join(root, 'indexes/media.json')), before);
  const restored = path.join(parent, 'restore');
  assert.equal(cli(root, ['restore', '--destination', restored]).originalFiles, 3);
  if (process.platform === 'darwin') {
    for (const [file, name, value, fork] of [[original, 'alpha', 'original A metadata', 'opaque original A fork'], [second, 'beta', 'original B metadata', 'opaque different B fork']]) {
      assert.equal(execFileSync('/usr/bin/xattr', ['-p', `com.example.${name}`, path.join(restored, file)], { encoding: 'utf8' }).trim(), value);
      assert.equal(execFileSync('/usr/bin/xattr', ['-p', 'com.apple.ResourceFork', path.join(restored, file)], { encoding: 'utf8' }).trim(), fork);
      assert.deepEqual(execFileSync('/usr/bin/xattr', ['-px', 'com.apple.quarantine', path.join(restored, file)]), originalQuarantine.get(file));
      const other = name === 'alpha' ? 'beta' : 'alpha';
      assert.notEqual(spawnSync('/usr/bin/xattr', ['-p', `com.example.${other}`, path.join(restored, file)]).status, 0);
    }
  } else {
    execFileSync(python, ['-c', `import os\na=${JSON.stringify(path.join(restored, original))}\nb=${JSON.stringify(path.join(restored, second))}\nassert os.getxattr(a,'user.alpha')==b'original A metadata'\nassert 'user.beta' not in os.listxattr(a)\nassert os.getxattr(b,'user.beta')==b'original B metadata'\nassert 'user.alpha' not in os.listxattr(b)\n`]);
  }
  const again = cli(root, ['prepare']);
  assert.notEqual(again.tree, prepared.tree);
  assert.equal(again.newObjectBytes, 0);
  const refs = await new AssetResolver(root).load();
  assert.equal(refs.entries.get(original).type, 'file');
  assert.ok(refs.entries.get(original).metadata.appleDouble || refs.entries.get(original).metadata.xattrs);
  assert.equal(cli(root, ['verify', '--tree', prepared.tree]).verified, prepared.tree);
}));

test('catalog, historical IDs, downloads, correct MIME, HEAD/ranges and original capture verification survive consolidation', async () => fixture(async ({ parent, root, original, stale, unused, before }) => {
  cli(root, ['prepare']);
  cli(root, ['proof', '--destination', path.join(parent, 'proof'), '--cleanup']);
  cli(root, ['remove']);
  const captureRoot = path.join(root, 'captures', captureId);
  const verificationBytes = await readFile(path.join(captureRoot, 'capture.verification.json'));
  assert.equal((await verifyCapture(captureRoot, { writeReport: false })).ok, true);
  assert.deepEqual(await readFile(path.join(captureRoot, 'capture.verification.json')), verificationBytes);
  const catalog = await new ArchiveCatalog(root).reload();
  const old = catalog.mediaItem('old-unlisted-id');
  assert.equal(old.available, true);
  assert.equal(old.mimeType, 'image/png');
  assert.equal(old.fileName, 'oldname.png');
  assert.equal(catalog.setMediaFavourite(old.id, true).isFavourite, true);
  assert.equal(catalog.setMediaHidden(old.id, true).isHidden, true);
  let revealed;
  const service = await startArchiveService(root, { viewDirectory: path.join(parent, 'views'), onRevealFile: file => { revealed = file; } });
  try {
    const meta = await (await fetch(`${service.url}api/media/old-unlisted-id`)).json();
    const response = await fetch(`${service.url}api/download/old-unlisted-id`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.match(response.headers.get('content-disposition'), /oldname\.png/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    for (const [range, expected] of [['bytes=2-8', png.subarray(2,9)], ['bytes=-3', png.subarray(-3)], ['bytes=4-', png.subarray(4)]]) {
      const result = await fetch(new URL(meta.fileUrl, service.url), { headers: { range } });
      assert.equal(result.status, 206);
      assert.deepEqual(Buffer.from(await result.arrayBuffer()), expected);
    }
    const head = await fetch(new URL(meta.fileUrl, service.url), { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), png.length);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal((await fetch(new URL(meta.fileUrl, service.url), { headers: { range: 'bytes=9999-' } })).status, 416);
    for (const p of [`raw-store/objects/${unused.slice(0,2)}/${unused}`, 'asset-store/current.json']) {
      assert.equal((await fetch(`${service.url}api/file/imported%20archive/${encodeURIComponent(p)}`)).status, 403);
    }
    await symlink(path.join(root, `raw-store/objects/${unused.slice(0,2)}/${unused}`), path.join(root, 'media/trap.txt'));
    assert.equal((await fetch(`${service.url}api/file/imported%20archive/media%2Ftrap.txt`)).status, 403);
    const reveal = await fetch(`${service.url}api/reveal-file`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: old.id }) });
    assert.equal(reveal.status, 200);
    assert.equal(path.basename(revealed), 'oldname.png');
    assert.ok(revealed.startsWith(path.join(parent, 'views')));
    assert.deepEqual(await readFile(revealed), png);
    await writeFile(revealed, 'user edit on independent working copy');
    assert.deepEqual(await readFile(await resolveAssetPath(root, path.join(root, original))), png);
    assert.deepEqual(await readFile(path.join(root, 'indexes/media.json')), before);
  } finally { await new Promise(resolve => service.server.close(resolve)); }
}));

test('interrupted unlink resumes without deleting later additions; changed sources stop safely', async () => fixture(async ({ parent, root, original, second }) => {
  cli(root, ['prepare']);
  cli(root, ['proof', '--destination', path.join(parent, 'proof'), '--cleanup']);
  await writeFile(path.join(root, second), 'changed original');
  cli(root, ['remove'], false);
  assert.deepEqual(await readFile(path.join(root, original)), png);
  await writeFile(path.join(root, second), png);
  cli(root, ['prepare']); // Preserve the new source observation, never replace the old tree.
  cli(root, ['proof', '--destination', path.join(parent, 'proof2'), '--cleanup']);
  const source = `import importlib.util\ns=importlib.util.spec_from_file_location('assets',${JSON.stringify(script)})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\na=m.Assets(${JSON.stringify(root)})\ndef stop(count):\n raise RuntimeError('simulated interruption')\nwith a.pool.lock():\n a.remove(a.current()['tree'],on_unlink=stop)\n`;
  assert.notEqual(spawnSync(python, ['-c', source]).status, 0);
  const later = await put(root, 'media/sha256/new/unknown-later.bin', 'later untouched');
  assert.equal(cli(root, ['remove']).removedFiles, 2);
  assert.equal(await readFile(later, 'utf8'), 'later untouched');
  assert.equal(cli(root, ['remove']).removedFiles, 0);
}));

test('missing/corrupt objects, symlink ancestors and malformed reference trees fail closed', async () => fixture(async ({ parent, root, original }) => {
  cli(root, ['prepare']);
  const resolver = await new AssetResolver(root).load();
  const object = await resolver.resolve(path.join(root, original));
  await chmod(object, 0o600);
  await writeFile(object, Buffer.alloc(png.length));
  await assert.rejects(resolver.resolve(path.join(root, original)), /checksum/);
  cli(root, ['verify'], false);
  cli(root, ['remove'], false);
  assert.deepEqual(await readFile(path.join(root, original)), png);
  await rm(object);
  await assert.rejects(resolver.resolve(path.join(root, original)), /ENOENT/);
  await put(root, path.relative(root, object), png);
  const folder = path.dirname(object);
  const outside = path.join(parent, 'outside');
  await mkdir(outside);
  await rm(folder, { recursive: true });
  await symlink(outside, folder);
  await assert.rejects(resolver.resolve(path.join(root, original)), /Symlink/);
}));

test('POSIX system Python can prepare, prove and reconstruct an independent asset-only filesystem view', { skip: process.platform !== 'darwin' }, async () => fixture(async ({ parent, root }) => {
  execFileSync('/usr/bin/python3', [script, '--archive', root, 'prepare']);
  execFileSync('/usr/bin/python3', [script, '--archive', root, 'proof', '--destination', path.join(parent, 'proof'), '--cleanup']);
  execFileSync('/usr/bin/python3', [script, '--archive', root, 'remove']);
  execFileSync('/usr/bin/python3', [script, '--archive', root, 'restore', '--destination', path.join(parent, 'restored')]);
  assert.ok((await readdir(path.join(parent, 'restored'))).includes('captures'));
}));

test('explicit full-hash backfill bypasses old processed keys and converted writers do not recreate duplicate files', async () => fixture(async ({ parent, root, second }) => {
  const captureRoot = path.join(root, 'captures', captureId);
  const manifestPath = path.join(captureRoot, 'capture.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath));
  manifest.stores.push({ name: 'messageImages', path: 'stores/images.jsonl', records: 1 });
  await writeFile(manifestPath, JSON.stringify(manifest));
  const storeFile = await put(root, `captures/${captureId}/stores/images.jsonl`, JSON.stringify({ id: 'image1', messageId: 'image1', contentBinary: png.toString('base64') })+'\n');
  await verifyCapture(captureRoot);
  assert.equal((await materializeEmbeddedMedia(root)).added, 1);
  cli(root, ['prepare']);
  cli(root, ['proof', '--destination', path.join(parent, 'proof'), '--cleanup']);
  cli(root, ['remove']);
  assert.equal((await materializeEmbeddedMedia(root, { reprocess: true })).added, 0);
  await assert.rejects(readFile(path.join(root, second)), /ENOENT/);
  const changed = Buffer.from(png);
  changed[40] ^= 1;
  await writeFile(storeFile, JSON.stringify({ id: 'image1', messageId: 'image1', contentBinary: changed.toString('base64') })+'\n');
  await verifyCapture(captureRoot);
  const index = path.join(root, 'materialized-media/indexes/media.json');
  const before = await readFile(index);
  assert.equal((await materializeEmbeddedMedia(root)).mode, 'up-to-date');
  assert.equal((await materializeEmbeddedMedia(root, { apply: false, reprocess: true })).added, 1);
  assert.deepEqual(await readFile(index), before);
  assert.equal((await materializeEmbeddedMedia(root, { reprocess: true })).added, 1);
  assert.equal(JSON.parse(await readFile(index)).items.length, 2);
}));

test('validly checksummed but unsafe tree paths/directories and missing published pointers cannot authorize access or removal', async () => fixture(async ({ parent, root, original }) => {
  cli(root, ['prepare']);
  const pointerPath = path.join(root, 'asset-store/current.json');
  const pointer = JSON.parse(await readFile(pointerPath));
  const treePath = path.join(root, 'asset-store/trees', `${pointer.tree}.json`);
  const receiptPath = path.join(root, 'asset-store/receipts', `${pointer.tree}.json`);
  const pristine = JSON.parse(await readFile(treePath));
  async function corrupt(tree) {
    await chmod(treePath, 0o600);
    const bytes = Buffer.from(JSON.stringify(tree));
    await writeFile(treePath, bytes);
    const receipt = JSON.parse(await readFile(receiptPath));
    receipt.treeSha256 = sha(bytes);
    pointer.treeSha256 = sha(bytes);
    await writeFile(receiptPath, JSON.stringify(receipt));
    await writeFile(pointerPath, JSON.stringify(pointer));
  }
  const bad = structuredClone(pristine);
  bad.entries[0].path = 'raw-store/objects/not-an-asset';
  await corrupt(bad);
  await assert.rejects(new AssetResolver(root).load(), /asset entry/);
  cli(root, ['restore', '--destination', path.join(parent, 'must-not-create')], false);
  assert.deepEqual(await readFile(path.join(root, original)), png);
  const badDirectory = structuredClone(pristine);
  badDirectory.directories['../../escape'] = Object.values(badDirectory.directories)[0];
  await corrupt(badDirectory);
  cli(root, ['restore', '--destination', path.join(parent, 'must-not-create')], false);
  await rm(pointerPath);
  await assert.rejects(new AssetResolver(root).load(), /lost its published pointer/);
  cli(root, ['prepare'], false);
  assert.deepEqual(await readFile(path.join(root, original)), png);
}));

test('native proof normalization permits only the observed provenance ID, never flags, other attrs or forks', () => {
  const source = `import importlib.util,struct,base64\ns=importlib.util.spec_from_file_location('assets',${JSON.stringify(script)})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nnames=[b'com.apple.provenance\\0',b'com.example.other\\0']\nstart=84;cursor=start+36\npositions=[]\nfor name in names:\n positions.append(cursor);cursor=(cursor+11+len(name)+3)&~3\ndata_start=cursor;meta_end=data_start+11+5\nb=bytearray(meta_end+4)\nstruct.pack_into('>II16sH',b,0,0x00051607,0x00020000,b'\\0'*16,2)\nstruct.pack_into('>III',b,26,9,50,meta_end-50)\nstruct.pack_into('>III',b,38,2,meta_end,4)\nstruct.pack_into('>8I2H',b,start,0x41545452,0,meta_end,data_start,16,0,0,0,0,2)\nfor i,name in enumerate(names):\n off=data_start if i==0 else data_start+11\n struct.pack_into('>IIHB',b,positions[i],off,11 if i==0 else 5,0,len(name))\n b[positions[i]+11:positions[i]+11+len(name)]=name\nb[data_start:data_start+11]=b'abc12345678'\nb[data_start+11:meta_end]=b'other'\nb[meta_end:]=b'fork'\ndef view(value):return m.provenance_view(base64.b64encode(value).decode())[0]\nx=bytearray(b);x[data_start+3:data_start+11]=b'87654321'\nassert view(b)==view(x)\nfor where in [data_start,data_start+11,meta_end]:\n bad=bytearray(x);bad[where]^=1\n assert view(b)!=view(bad)\ntry:\n bad=bytearray(b);struct.pack_into('>I',bad,positions[0],meta_end)\n view(bad)\n raise AssertionError('fork pointer accepted')\nexcept ValueError:pass\n`;
  execFileSync(python, ['-c', source]);
});
