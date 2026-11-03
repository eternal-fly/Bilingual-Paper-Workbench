import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodexCommand as resolve } from '../src/codex-command.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const owned = path.join(pluginRoot, 'work/codex-command-tests'); await mkdir(owned, { recursive: true });
  const root = await mkdtemp(path.join(owned, 'case-')), local = path.join(root, 'Local'), bin = path.join(local, 'OpenAI/Codex/bin');
  await mkdir(bin, { recursive: true });
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(owned) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const executable = async (name, modified = null) => { const filename = path.join(bin, name, 'codex.exe'); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, 'Synthetic file; this must never execute.'); if (modified) await utimes(filename, modified, modified); return filename; };
  return { root, local, bin, executable, missing: path.join(bin, '1111111111111111/codex.exe'), options: { platform: 'win32', env: { LOCALAPPDATA: local, PATH: '' } } };
}

test('an existing configured absolute executable remains selected without starting it', async t => {
  const f = await fixture(t), command = await f.executable('2222222222222222');
  assert.equal(await resolve(command, f.options), command);
  assert.equal(await resolve(process.execPath, f.options), process.execPath);
});

test('a retained official version follows the current verified PATH version from the same installation', async t => {
  const f = await fixture(t), old = await f.executable('2222222222222222', new Date('2030-01-01T00:00:00Z')), current = await f.executable('3333333333333333', new Date('2020-01-01T00:00:00Z'));
  assert.equal(await resolve(old, { ...f.options, env: { ...f.options.env, PATH: path.dirname(current) } }), current);
});

test('an existing official version remains pinned when PATH has no verified version in its installation', async t => {
  const f = await fixture(t), old = await f.executable('2222222222222222', new Date('2020-01-01T00:00:00Z'));
  await f.executable('3333333333333333', new Date('2030-01-01T00:00:00Z'));
  assert.equal(await resolve(old, f.options), old);
  const foreignDirectory = path.join(f.root, 'another-installation/OpenAI/Codex/bin/4444444444444444');
  await mkdir(foreignDirectory, { recursive: true }); await writeFile(path.join(foreignDirectory, 'codex.exe'), 'Different installation; do not select.');
  assert.equal(await resolve(old, { ...f.options, env: { ...f.options.env, PATH: foreignDirectory } }), old);
});

test('an existing explicit custom executable remains pinned despite a current official PATH command', async t => {
  const f = await fixture(t), current = await f.executable('3333333333333333'), custom = path.join(f.root, 'custom/codex.exe');
  await mkdir(path.dirname(custom)); await writeFile(custom, 'Explicit custom executable; do not replace.');
  assert.equal(await resolve(custom, { ...f.options, env: { ...f.options.env, PATH: path.dirname(current) } }), custom);
});

test('a deleted official version resolves the current official PATH binary ahead of unrelated impostors', async t => {
  const f = await fixture(t), current = await f.executable('2222222222222222'), newerSibling = await f.executable('3333333333333333', new Date('2030-01-01T00:00:00Z'));
  const other = path.join(f.root, 'unrelated'); await mkdir(other); await writeFile(path.join(other, 'codex.exe'), 'Must not be selected.');
  const options = { ...f.options, env: { ...f.options.env, Path: `${other};.;"${path.dirname(current)}"`, PATH: undefined } };
  assert.equal(await resolve(f.missing, options), current); assert.notEqual(current, newerSibling);
});

test('a stale PATH recovers the newest verified sibling only inside the exact official bin root', async t => {
  const f = await fixture(t); await f.executable('2222222222222222', new Date('2020-01-01T00:00:00Z'));
  const current = await f.executable('3333333333333333', new Date('2021-01-01T00:00:00Z'));
  await f.executable('not-a-version', new Date('2030-01-01T00:00:00Z'));
  assert.equal(await resolve(f.missing, { ...f.options, env: { ...f.options.env, PATH: path.dirname(f.missing) } }), current);
});

test('a bare default command resolves the known official installation without using the current directory', async t => {
  const f = await fixture(t), current = await f.executable('2222222222222222');
  await writeFile(path.join(f.root, 'codex.exe'), 'Must not be selected.');
  assert.equal(await resolve('codex', { ...f.options, env: { ...f.options.env, PATH: `.;relative;${path.dirname(current)}` } }), current);
});

test('a missing explicit custom command never silently switches to another executable', async t => {
  const f = await fixture(t), current = await f.executable('2222222222222222');
  await assert.rejects(resolve(path.join(f.root, 'custom/codex.exe'), { ...f.options, env: { ...f.options.env, PATH: path.dirname(current) } }), { code: 'CODEX_COMMAND_UNAVAILABLE' });
});

test('malformed or relative command paths are rejected without searching for a replacement', async t => {
  const f = await fixture(t);
  for (const command of ['', 'relative/codex.exe', 'other', 'codex --version', f.missing + '\0', '\\server\\share\\codex.exe']) await assert.rejects(resolve(command, f.options), { code: 'CODEX_COMMAND_INVALID' });
});

test('a symlink or junction executable and redirected installation ancestor are never returned', async t => {
  const f = await fixture(t), target = path.join(f.root, 'target'); await mkdir(target); await writeFile(path.join(target, 'codex.exe'), 'Must not execute.');
  const linkedDirectory = path.join(f.bin, '2222222222222222');
  try { await symlink(target, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('This environment does not permit creating synthetic symlinks or junctions.'); return; } throw error; }
  await assert.rejects(resolve(path.join(linkedDirectory, 'codex.exe'), f.options), { code: 'CODEX_COMMAND_INVALID' });
  await assert.rejects(resolve(f.missing, f.options), { code: 'CODEX_COMMAND_UNAVAILABLE' });
  const current = await f.executable('3333333333333333');
  await assert.rejects(resolve(path.join(linkedDirectory, 'codex.exe'), { ...f.options, env: { ...f.options.env, PATH: path.dirname(current) } }), { code: 'CODEX_COMMAND_INVALID' });
});

test('a plain file named as an executable directory cannot become a fallback', async t => {
  const f = await fixture(t); await writeFile(path.join(f.bin, '2222222222222222'), 'Not a directory.');
  await assert.rejects(resolve(f.missing, f.options), { code: 'CODEX_COMMAND_UNAVAILABLE' });
});

test('an unavailable official installation fails explicitly instead of returning an unresolved command', async t => {
  const f = await fixture(t);
  await assert.rejects(resolve(f.missing, f.options), { code: 'CODEX_COMMAND_UNAVAILABLE' });
  await assert.rejects(resolve('codex', f.options), { code: 'CODEX_COMMAND_UNAVAILABLE' });
});
