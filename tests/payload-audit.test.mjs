import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = new URL('../scripts/audit-payload-duplicates.py', import.meta.url).pathname;
const python = process.env.ARCHIV_PYTHON || 'python3';
const sha = value => createHash('sha256').update(value).digest('hex');

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archiv-payload-audit-'));
  const archive = path.join(root, 'archive');
  await mkdir(archive);
  const output = path.join(root, 'report.json');
  try { await run({ root, archive, output }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function put(root, relative, content) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

function audit(archive, output, extra = []) {
  return spawnSync(python, [script, '--archive', archive, '--output', output, ...extra], { encoding: 'utf8' });
}

async function inventory(root) {
  const result = {};
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const info = await stat(file);
        result[path.relative(root, file)] = [info.size, info.mtimeMs, info.ctimeMs, sha(await readFile(file))];
      }
    }
  }
  await visit(root);
  return result;
}

test('audit hashes full bytes, counts cross-layer duplicates and independently verifies matching raw objects', async () => fixture(async ({ archive, output }) => {
  const bytes = Buffer.from('same original full-resolution bytes');
  await put(archive, 'captures/capture-old/opfs/a/shared.png', bytes);
  await put(archive, 'media/sha256/aa/untrusted-filename.jpg', bytes);
  await put(archive, 'materialized-media/media/sha256/bb/shared.webp', bytes);
  const sameIdA = await put(archive, 'captures/capture-old/stores/same-id.jsonl', 'same-id: earlier version');
  const sameIdB = await put(archive, 'captures/capture-new/stores/same-id.jsonl', 'same-id: changed version');
  const digest = sha(bytes);
  await put(archive, `raw-store/objects/${digest.slice(0, 2)}/${digest}`, bytes);
  const before = await inventory(archive);
  const result = audit(archive, output);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(output));
  assert.equal(report.complete, true);
  assert.equal(report.totals.files, 5);
  assert.equal(report.totals.distinctContents, 3);
  assert.equal(report.totals.repeatedLogicalBytes, bytes.length * 2);
  assert.equal(report.totals.alreadyInRawPoolUniqueBytes, bytes.length);
  assert.equal(report.byCategory['standalone-asset'].additionalObjectBytesIfSharingRawPool, 0);
  assert.equal(report.duplicateGroups[0].copies, 3);
  assert.equal(report.duplicateGroups[0].alreadyInRawPool, true);
  assert.notEqual(sha(await readFile(sameIdA)), sha(await readFile(sameIdB)));
  assert.deepEqual(await inventory(archive), before);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
}));

test('audit detects middle-byte changes despite identical lengths and sampled edges', async () => fixture(async ({ archive, output }) => {
  const first = Buffer.from('prefix'.repeat(1024) + 'AAAA' + 'suffix'.repeat(1024));
  const second = Buffer.from('prefix'.repeat(1024) + 'BBBB' + 'suffix'.repeat(1024));
  await put(archive, 'media/sha256/aa/one.bin', first);
  await put(archive, 'media/sha256/aa/two.bin', second);
  assert.equal(audit(archive, output).status, 0);
  const report = JSON.parse(await readFile(output));
  assert.equal(report.totals.distinctContents, 2);
  assert.equal(report.totals.repeatedLogicalBytes, 0);
}));

test('audit accounts for empty files and hardlink aliases without pretending to measure APFS reclaim', async () => fixture(async ({ archive, output }) => {
  await put(archive, 'stores/empty-one.json', '');
  await put(archive, 'stores/empty-two.json', '');
  const file = await put(archive, 'media/sha256/aa/original', 'one inode');
  await link(file, path.join(path.dirname(file), 'alias'));
  assert.equal(audit(archive, output).status, 0);
  const report = JSON.parse(await readFile(output));
  assert.equal(report.totals.files, 4);
  assert.equal(report.totals.distinctInodes, 3);
  assert.equal(report.totals.duplicateEmptyFiles, 1);
  const group = report.duplicateGroups.find(item => item.bytes > 0);
  assert.equal(group.copies, 2);
  assert.equal(group.distinctInodes, 1);
  assert.ok(report.limits.some(item => /reclaim is NOT measured/.test(item)));
}));

test('audit refuses symlinks, never hashes their outside targets, and returns a partial report', async () => fixture(async ({ root, archive, output }) => {
  await put(archive, 'media/safe', 'safe');
  const outside = await put(root, 'private/outside', 'DO-NOT-READ');
  await symlink(outside, path.join(archive, 'media/escape'));
  assert.equal(audit(archive, output).status, 1);
  const report = JSON.parse(await readFile(output));
  assert.equal(report.complete, false);
  assert.ok(report.errors.some(item => item.reason === 'symlink-refused'));
  assert.equal(report.files.some(item => item.sha256 === sha('DO-NOT-READ')), false);
  assert.equal(await readFile(outside, 'utf8'), 'DO-NOT-READ');
}));

test('audit validates declared checksums but retains failed/partial capture payloads in the inventory', async () => fixture(async ({ archive, output }) => {
  await put(archive, 'captures/capture-good/stores/data.jsonl', 'payload');
  await put(archive, 'captures/capture-good/capture.verification.json', JSON.stringify({ ok: true,
    stores: [{ path: 'stores/data.jsonl', bytes: 7, sha256: sha('payload') }], opfs: [] }));
  await put(archive, 'captures/capture-partial/opfs/unconfirmed.bin', 'partial bytes');
  await put(archive, 'captures/capture-partial/capture.verification.json', JSON.stringify({ ok: false }));
  assert.equal(audit(archive, output).status, 0);
  const report = JSON.parse(await readFile(output));
  assert.equal(report.manifestChecks.matchedDeclarations, 1);
  assert.equal(report.manifestChecks.verifiedCaptureManifests, 1);
  assert.equal(report.manifestChecks.failedOrPartialCaptureManifests, 1);
  assert.ok(report.files.some(item => item.path.includes('unconfirmed.bin')));
}));

test('audit reports corrupt or missing declared payloads and refuses unverified raw-pool matches', async () => fixture(async ({ archive, output }) => {
  await put(archive, 'captures/capture-good/stores/data.jsonl', 'payload');
  await put(archive, 'captures/capture-good/capture.verification.json', JSON.stringify({ ok: true,
    stores: [{ path: 'stores/data.jsonl', bytes: 7, sha256: sha('another') },
      { path: 'stores/missing.jsonl', sha256: sha('missing') }], opfs: [] }));
  const digest = sha('payload');
  await put(archive, `raw-store/objects/${digest.slice(0, 2)}/${digest}`, 'corrupt');
  assert.equal(audit(archive, output).status, 1);
  const report = JSON.parse(await readFile(output));
  assert.equal(report.complete, false);
  assert.ok(report.errors.some(item => item.reason === 'declared-checksum-or-size-mismatch'));
  assert.ok(report.errors.some(item => item.reason === 'declared-payload-missing'));
  assert.ok(report.errors.some(item => item.reason.startsWith('raw-pool-')));
  assert.equal(report.totals.alreadyInRawPoolContents, 0);
}));

test('audit rejects reports inside the archive, existing reports and symlinked report destinations', async () => fixture(async ({ root, archive, output }) => {
  await put(archive, 'stores/data', 'must survive');
  assert.equal(audit(archive, path.join(archive, 'report.json')).status, 2);
  await writeFile(output, 'do not replace');
  assert.equal(audit(archive, output).status, 2);
  assert.equal(await readFile(output, 'utf8'), 'do not replace');
  const redirect = path.join(root, 'redirect.json');
  await symlink(path.join(archive, 'stores/data'), redirect);
  assert.equal(audit(archive, redirect).status, 2);
  assert.equal(await readFile(path.join(archive, 'stores/data'), 'utf8'), 'must survive');
}));

test('expired audit deadline cannot publish a complete report', async () => fixture(async ({ archive, output }) => {
  await put(archive, 'stores/data', Buffer.alloc(1024 * 1024));
  assert.equal(audit(archive, output, ['--deadline-seconds', '0.000000001']).status, 1);
  const report = JSON.parse(await readFile(output));
  assert.equal(report.complete, false);
  assert.ok(report.errors.some(item => item.reason === 'TimeoutError'));
}));

test('path replacement and changes during auditing fail the identity/inventory checks', async () => fixture(async ({ archive }) => {
  await put(archive, 'media/original', 'same bytes');
  const source = `import importlib.util, pathlib, os, time\nspec=importlib.util.spec_from_file_location('audit',${JSON.stringify(script)})\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nr=pathlib.Path(${JSON.stringify(archive)})\np=r/'media/original'\nold=p.stat()\np.unlink();p.write_text('same bytes')\ntry:\n m.hash_file(r,'media/original',old,time.monotonic()+10)\n raise AssertionError('replacement accepted')\nexcept ValueError:\n pass\ndef change(progress):\n (r/'media/added-during-audit').write_text('new bytes')\nresult=m.audit(r,on_progress=change)\nassert not result['complete']\nassert result['changesDuringAudit']['added']==['media/added-during-audit']\n`;
  execFileSync(python, ['-c', source]);
}));

test('system Python 3.9 can run the same streaming audit', { skip: process.platform !== 'darwin' }, async () => fixture(async ({ archive, output }) => {
  await put(archive, 'stores/data', 'portable bytes');
  execFileSync('/usr/bin/python3', [script, '--archive', archive, '--output', output]);
  assert.equal(JSON.parse(await readFile(output)).complete, true);
}));

test('stale declared paths have explicit same-byte recovery evidence but never pass direct-path validation', async () => fixture(async ({ archive, output }) => {
  const digest = sha('original bytes');
  await put(archive, 'media/sha256/aa/actual.png', 'original bytes');
  await put(archive, 'indexes/media.json', JSON.stringify({ items: [
    { path: 'media/sha256/aa/stale.jpg', sha256: digest, bytes: 14, status: 'deduped' }
  ] }));
  assert.equal(audit(archive, output).status, 1);
  const report = JSON.parse(await readFile(output));
  assert.equal(report.inventoryComplete, true);
  assert.equal(report.manifestValidationPassed, false);
  assert.equal(report.referenceIssues.resolvableByVerifiedBytes, 1);
  assert.deepEqual(report.missingReferences[0].expectations[0].verifiedReadableCandidates, ['media/sha256/aa/actual.png']);
}));

test('missing readable paths can be evidenced by verified raw bytes without counting nonexistent readable files', async () => fixture(async ({ archive, output }) => {
  const digest = sha('raw bytes');
  await put(archive, `raw-store/objects/${digest.slice(0, 2)}/${digest}`, 'raw bytes');
  await put(archive, 'indexes/media.json', JSON.stringify({ items: [
    { path: 'media/missing', sha256: digest, bytes: 9 }
  ] }));
  assert.equal(audit(archive, output).status, 1);
  const report = JSON.parse(await readFile(output));
  assert.equal(report.inventoryComplete, true);
  assert.equal(report.totals.files, 1);
  assert.equal(report.referenceIssues.resolvableByVerifiedBytes, 1);
  assert.equal(report.missingReferences[0].expectations[0].verifiedRawObject.bytes, 9);
  assert.equal(report.totals.alreadyInRawPoolUniqueBytes, 0);
}));

test('malformed manifest tables, entries, sizes and unsafe references fail closed without stopping the byte inventory', async () => fixture(async ({ archive, output }) => {
  await put(archive, 'captures/capture-bad/capture.verification.json', JSON.stringify({ ok: true,
    stores: {}, opfs: [false, { archivedPath: '../../outside', sha256: sha('outside') }] }));
  await put(archive, 'indexes/media.json', JSON.stringify({ items: [
    { path: 'media/x', sha256: sha('x'), bytes: {} }
  ] }));
  assert.equal(audit(archive, output).status, 1);
  const report = JSON.parse(await readFile(output));
  assert.equal(report.inventoryComplete, true);
  assert.equal(report.manifestValidationPassed, false);
  for (const reason of ['malformed-manifest-table', 'malformed-manifest-entry', 'malformed-manifest-size', 'unsafe-or-invalid-checksum-reference']) {
    assert.ok(report.errors.some(item => item.reason === reason), reason);
  }
}));

test('nonfinite and nonpositive deadlines are rejected instead of silently disabling bounds', async () => fixture(async ({ archive, output }) => {
  for (const seconds of ['nan', 'inf', '0', '-1']) {
    assert.equal(audit(archive, output, ['--deadline-seconds', seconds]).status, 2);
  }
}));

test('root manifest creation during hashing is detected by the final inventory', async () => fixture(async ({ archive }) => {
  await put(archive, 'media/original', 'original bytes');
  const source = `import importlib.util, pathlib\nspec=importlib.util.spec_from_file_location('audit',${JSON.stringify(script)})\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nr=pathlib.Path(${JSON.stringify(archive)})\ndef change(progress):\n (r/'venice-archive.manifest.json').write_text('{"records":{"sourceStores":{}}}')\nresult=m.audit(r,on_progress=change)\nassert not result['complete']\nassert result['changesDuringAudit']['added']==['venice-archive.manifest.json']\n`;
  execFileSync(python, ['-c', source]);
}));

test('the final source walk uses the same finite deadline as the first walk', async () => fixture(async ({ archive }) => {
  await put(archive, 'media/original', 'original bytes');
  const source = `import importlib.util, pathlib, math\nspec=importlib.util.spec_from_file_location('audit',${JSON.stringify(script)})\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nr=pathlib.Path(${JSON.stringify(archive)})\noriginal=m.walk\nseen=[]\ndef walk(root,errors,deadline=float('inf')):\n seen.append(deadline)\n return original(root,errors,deadline)\nm.walk=walk\nassert m.audit(r)['complete']\nassert len(seen)==2 and all(math.isfinite(value) for value in seen) and seen[0]==seen[1]\n`;
  execFileSync(python, ['-c', source]);
}));
