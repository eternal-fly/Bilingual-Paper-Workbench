import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WindowsSourceWriter } from '../src/windows-writer.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const owned = path.join(root, 'work/writer-tests'); await mkdir(owned, { recursive: true });
  const directory = await mkdtemp(path.join(owned, 'case-'));
  t.after(async () => { assert.ok(path.resolve(directory).startsWith(path.resolve(owned) + path.sep)); await rm(directory, { recursive: true, force: true }); });
  const source = path.join(directory, 'paper'); await mkdir(source);
  const state = path.join(directory, 'private');
  const before = Buffer.from('Original 中文 😀\r\n'), after = Buffer.from('Reviewed 中文 😀\r\n');
  await writeFile(path.join(source, 'main.tex'), before);
  const writer = new WindowsSourceWriter({ dataRoot: state });
  const request = { root: source, transactionId: 'tx-test', readSet: [{ path: 'main.tex', hash: hash(before) }], changes: [{ path: 'main.tex', beforeHash: hash(before), hash: hash(after), bytes: after }] };
  return { directory, source, before, after, writer, request };
}
test('exclusive writer preserves UTF8 and CRLF through held file handles', async t => {
  const f = await fixture(t);
  const result = await f.writer.write(f.request);
  assert.equal(result.status, 'applied');
  assert.deepEqual(await readFile(path.join(f.source, 'main.tex')), f.after);
});
test('external in-place writes and rename replacement fail while commit read-set is locked', async t => {
  const f = await fixture(t);
  let checked = false;
  await f.writer.write(f.request, { onLocked: async () => {
    checked = true;
    await assert.rejects(writeFile(path.join(f.source, 'main.tex'), 'external'), error => ['EBUSY', 'EACCES', 'EPERM'].includes(error.code));
    const external = path.join(f.source, 'replacement.tex'); await writeFile(external, 'external');
    await assert.rejects(rename(external, path.join(f.source, 'main.tex')), error => ['EBUSY', 'EACCES', 'EPERM'].includes(error.code));
  } });
  assert.equal(checked, true);
  assert.deepEqual(await readFile(path.join(f.source, 'main.tex')), f.after);
});
test('a changed dependency or before hash prevents every source write', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'refs.bib'), 'new dependency');
  f.request.readSet.push({ path: 'refs.bib', hash: hash(Buffer.from('old dependency')) });
  await assert.rejects(f.writer.write(f.request), { code: 'VERSION_CONFLICT' });
  assert.deepEqual(await readFile(path.join(f.source, 'main.tex')), f.before);
});
test('traversal is rejected before the native broker is started', async t => {
  const f = await fixture(t);
  f.request.changes[0].path = '../main.tex';
  await assert.rejects(f.writer.write(f.request), { code: 'PERMISSION_DENIED' });
});
test('interrupted multi-file promotion reports partial progress without overwriting remaining files', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'second.tex'), f.before);
  f.request.readSet.push({ path: 'second.tex', hash: hash(f.before) });
  f.request.changes.push({ path: 'second.tex', beforeHash: hash(f.before), hash: hash(f.after), bytes: f.after });
  await assert.rejects(f.writer.write(f.request, { onProgress: async progress => { if (progress.writtenCount === 1) throw Object.assign(new Error('simulated coordinator crash'), { code: 'COORDINATOR_CRASH' }); } }), { code: 'COORDINATOR_CRASH' });
  assert.deepEqual(await readFile(path.join(f.source, 'main.tex')), f.after);
  assert.deepEqual(await readFile(path.join(f.source, 'second.tex')), f.before);
});
