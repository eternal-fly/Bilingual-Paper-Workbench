import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { verifyIcons } from './icons-verify.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const json = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'));
const manifest = await json('plugin.json');
const config = await json('mcp.json');
const pkg = await json('package.json');
await verifyIcons({ root });
assert.equal(manifest.name, pkg.name);
assert.equal(manifest.version, pkg.version);
assert.equal(config.mcpServers['bilingual-paper-editor'].type, 'stdio');
assert.equal(pkg.private, true);
for (const version of Object.values(pkg.dependencies)) assert.match(version, /^\d+\.\d+\.\d+$/);
await readFile(path.join(root, 'pnpm-lock.yaml'));
let syntax = 0;
async function checkTree(folder) {
  for (const file of await readdir(path.join(root, folder), { withFileTypes: true })) {
    const relative = path.join(folder, file.name);
    if (file.isDirectory()) { await checkTree(relative); continue; }
    if (!file.name.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(root, relative)], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); syntax++;
  }
}
for (const folder of ['src', 'ui', 'test', 'scripts']) await checkTree(folder);
const built = await json('dist/build-manifest.json');
assert.equal(built.version, pkg.version, 'Rebuild after a package version change.');
for (const [name, expected] of Object.entries(built.files)) {
  const bytes = await readFile(path.join(root, 'dist', name));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256);
}
const html = await readFile(path.join(root, 'dist/workbench.html'), 'utf8');
assert.ok(html.includes('bilingual_paper_ui'));
assert.ok(!/<(?:script|link)[^>]+(?:src|href)=["'](?!data:)/.test(html));
assert.ok(!/[A-Za-z]:[/\\]Users[/\\](?!Public[/\\]|Default[/\\])[^/\\<\s]+/iu.test(html), 'A machine-specific Windows user path leaked into the UI bundle.');
console.log(JSON.stringify({ ok: true, manifests: 3, syntaxFiles: syntax, verifiedBuildFiles: Object.keys(built.files).length, externalUiAssets: 0, sourceApply: 'human_ui_only' }));
