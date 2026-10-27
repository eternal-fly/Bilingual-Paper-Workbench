import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('bundled native entry imports the window HTTP library without starting a second backend or polluting MCP stdio', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  await mkdir(path.join(root, 'work'), { recursive: true });
  const directory = await mkdtemp(path.join(root, 'work/bundled-entry-'));
  const filename = path.join(directory, 'server.mjs');
  await build({ entryPoints: [path.join(root, 'src/server.mjs')], outfile: filename, bundle: true, format: 'esm', platform: 'node', target: 'node24', legalComments: 'none', define: { __PAPER_ENTRY_KIND__: JSON.stringify('server') }, banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
  const child = spawn(process.execPath, [filename], { cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PAPER_EDITOR_FULL_RUNTIME: '0', PAPER_EDITOR_DATA_ROOT: path.join(directory, 'data'), PAPER_EDITOR_CODEX_ROOT: path.join(directory, 'chat'), PAPER_EDITOR_COMPILER_ROOT: path.join(directory, 'missing-compiler'), PAPER_EDITOR_WORKSPACE: '', PAPER_EDITOR_MAIN_FILE: '', PAPER_EDITOR_LAUNCH_STATE: '' } });
  t.after(() => { child.stdin.end(); child.kill(); });
  let buffer = '', diagnostics = '', invalid = null, sequence = 0;
  const pending = new Map();
  child.stderr.on('data', bytes => { diagnostics += bytes; });
  child.stdout.on('data', bytes => {
    buffer += bytes;
    for (;;) {
      const newline = buffer.indexOf('\n'); if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue;
      let message; try { message = JSON.parse(line); } catch { invalid = 'Non-JSON output'; continue; }
      if (message.jsonrpc !== '2.0') { invalid = 'Unexpected standalone launch output'; continue; }
      const item = pending.get(message.id); if (item) { clearTimeout(item.timer); pending.delete(message.id); item.resolve(message); }
    }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(new Error('Bundled native MCP response timed out')), 15000);
    pending.set(id, { resolve, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const initialized = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic-bundled-entry-test', version: '1' } });
  assert.equal(initialized.result.serverInfo.name, 'bilingual-paper-editor');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await request('tools/list');
  assert.ok(listed.result.tools.some(tool => tool.name === 'bilingual_paper_editor'));
  assert.ok(listed.result.tools.some(tool => tool.name === 'bilingual_paper_panel'));
  const stopped = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native stdin shutdown left an unexpected backend alive')), 4000);
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  child.stdin.end(); assert.equal(await stopped, 0);
  assert.equal(invalid, null); assert.equal(diagnostics, '');
});
