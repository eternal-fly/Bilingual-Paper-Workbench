import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const helper = path.join(root, 'scripts/desktop-discovery.ps1');
const pwsh = process.env.PAPER_EDITOR_POWERSHELL || 'pwsh';
const sourcePath = './.agents/plugins/local/paper-editor-local/plugins/bilingual-paper-editor';
async function fixture(t) {
  const parent = path.join(root, 'work/desktop-discovery-tests'); await mkdir(parent, { recursive: true });
  const home = await mkdtemp(path.join(parent, 'case-'));
  t.after(async () => { assert.ok(path.resolve(home).startsWith(path.resolve(parent) + path.sep)); await rm(home, { recursive: true, force: true }); });
  return { home, catalogPath: path.join(home, '.agents/plugins/marketplace.json') };
}
function run(home, code, extra = {}) {
  const result = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; . $env:PAPER_DESKTOP_HELPER; " + code], { cwd: root, env: { ...process.env, PAPER_DESKTOP_HELPER: helper, PAPER_TEST_HOME: home, ...extra }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return { ...result, json: result.status === 0 && result.stdout.trim() ? JSON.parse(result.stdout) : null };
}
test('Desktop discovery dry plan uses a home-relative local code source and performs no writes', async t => {
  const { home } = await fixture(t), result = run(home, '$p=Get-PaperDesktopDiscoveryPlan -UserHome $env:PAPER_TEST_HOME; $p | ConvertTo-Json -Depth 32 -Compress');
  assert.equal(result.status, 0, result.stderr); assert.equal(result.json.sourcePath, sourcePath); assert.equal(result.json.catalogName, 'paper-editor-local');
  assert.equal(result.json.catalogBeforeHash, null); assert.equal(path.relative(home, result.json.pluginRoot), path.join('.agents/plugins/local/paper-editor-local/plugins/bilingual-paper-editor'));
  assert.deepEqual(await readdir(home), []);
});
test('Desktop catalog merge preserves unrelated entries, identity, policies and unknown metadata', async t => {
  const { home, catalogPath } = await fixture(t); await mkdir(path.dirname(catalogPath), { recursive: true });
  const original = { name: 'my-personal-catalog', interface: { displayName: 'Author local tools', custom: true }, plugins: [{ name: 'another-tool', source: { source: 'local', path: './another-tool' }, policy: { installation: 'NOT_AVAILABLE' }, extra: [1, 2] }], userField: { retain: 'unchanged' } };
  const before = JSON.stringify(original, null, 2); await writeFile(catalogPath, before);
  const result = run(home, '$p=Get-PaperDesktopDiscoveryPlan -UserHome $env:PAPER_TEST_HOME; $null=Save-PaperDesktopDiscoveryCatalog -Plan $p; $p | ConvertTo-Json -Depth 32 -Compress');
  assert.equal(result.status, 0, result.stderr); const after = JSON.parse(await readFile(catalogPath, 'utf8'));
  assert.equal(after.name, original.name); assert.deepEqual(after.interface, original.interface); assert.deepEqual(after.userField, original.userField); assert.deepEqual(after.plugins[0], original.plugins[0]);
  assert.equal(after.plugins.length, 2); assert.equal(after.plugins[1].source.path, sourcePath); assert.equal(result.json.pluginId, 'bilingual-paper-editor@my-personal-catalog');
  const backup = (await readdir(path.dirname(catalogPath))).find(name => name.startsWith('marketplace.before-paper-editor.')); assert.ok(backup); assert.equal(await readFile(path.join(path.dirname(catalogPath), backup), 'utf8'), before);
  const again = run(home, '$p=Get-PaperDesktopDiscoveryPlan -UserHome $env:PAPER_TEST_HOME; $p | ConvertTo-Json -Depth 32 -Compress'); assert.equal(again.status, 0, again.stderr); assert.equal(again.json.catalog.plugins.length, 2);
  const savedBytes = await readFile(catalogPath), savedFiles = await readdir(path.dirname(catalogPath));
  const repeated = run(home, '$p=Get-PaperDesktopDiscoveryPlan -UserHome $env:PAPER_TEST_HOME; $null=Save-PaperDesktopDiscoveryCatalog -Plan $p'); assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(await readFile(catalogPath), savedBytes); assert.deepEqual(await readdir(path.dirname(catalogPath)), savedFiles);
});
test('conflicting same-name source, invalid JSON and duplicate entries fail without replacing a catalog', async t => {
  for (const value of [
    JSON.stringify({ name: 'other', plugins: [{ name: 'bilingual-paper-editor', source: { source: 'local', path: './different' } }] }),
    '{invalid-json',
    JSON.stringify({ name: 'other', plugins: [1, 2].map(() => ({ name: 'bilingual-paper-editor', source: { source: 'local', path: sourcePath } })) }),
  ]) await t.test('preserves exact catalog bytes', async subtest => {
    const { home, catalogPath } = await fixture(subtest); await mkdir(path.dirname(catalogPath), { recursive: true }); await writeFile(catalogPath, value);
    const result = run(home, '$p=Get-PaperDesktopDiscoveryPlan -UserHome $env:PAPER_TEST_HOME; $null=Save-PaperDesktopDiscoveryCatalog -Plan $p'); assert.notEqual(result.status, 0); assert.equal(await readFile(catalogPath, 'utf8'), value);
  });
});
test('catalog concurrent revision and injected destination are rejected without altering current bytes', async t => {
  const { home, catalogPath } = await fixture(t);
  const result = run(home, "$p=Get-PaperDesktopDiscoveryPlan -UserHome $env:PAPER_TEST_HOME; New-Item -ItemType Directory -Path (Split-Path -Parent $p.catalogPath) -Force | Out-Null; [IO.File]::WriteAllText($p.catalogPath,'{\"name\":\"changed\",\"plugins\":[]}'); $null=Save-PaperDesktopDiscoveryCatalog -Plan $p");
  assert.notEqual(result.status, 0); assert.deepEqual(JSON.parse(await readFile(catalogPath, 'utf8')), { name: 'changed', plugins: [] });
  const injected = run(home, "$p=Get-PaperDesktopDiscoveryPlan -UserHome $env:PAPER_TEST_HOME; $p.catalogPath=Join-Path $env:PAPER_TEST_HOME 'outside.json'; $null=Save-PaperDesktopDiscoveryCatalog -Plan $p"); assert.notEqual(injected.status, 0); assert.ok(!(await readdir(home)).includes('outside.json'));
});
test('Desktop discovery rejects relative homes and existing reparse directories', async t => {
  const { home } = await fixture(t); assert.notEqual(run(home, "$p=Get-PaperDesktopDiscoveryPlan -UserHome 'relative-home'").status, 0);
  const destination = path.join(home, 'unrelated'); await mkdir(destination);
  try { await symlink(destination, path.join(home, '.agents'), 'junction'); } catch (error) { if (error.code === 'EPERM') return t.skip('Creating the synthetic junction is denied by this OS policy.'); throw error; }
  assert.notEqual(run(home, '$p=Get-PaperDesktopDiscoveryPlan -UserHome $env:PAPER_TEST_HOME').status, 0); assert.deepEqual(await readdir(destination), []);
});
test('full installer DryRun declares Desktop discovery and does not create personal catalogs or copies', async t => {
  const { home } = await fixture(t), installer = path.join(root, 'scripts/install.ps1');
  const result = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', installer, '-DryRun', '-NoShortcuts', '-DesktopHome', home, '-PrivateRoot', path.join(home, 'private'), '-Destination', path.join(home, 'installed'), '-Node', process.execPath, '-Codex', process.execPath], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); const plan = JSON.parse(result.stdout);
  assert.equal(plan.desktopProcessRequired, false, 'The saved viewer can open without Desktop.');
  assert.equal(plan.desktopInferenceProcessRequired, true, 'Model execution remains owned by running Desktop.');
  assert.equal(plan.inferenceMode, 'desktop-existing-chat-queue');
  assert.equal(plan.desktopDiscovery.sourcePath, sourcePath); assert.equal(plan.desktopDiscovery.appRestartRequired, true); assert.equal(plan.privateDataRoot, path.join(home, 'private/preview')); assert.deepEqual(await readdir(home), []);
});
