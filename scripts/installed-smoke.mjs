import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = process.env.PAPER_EDITOR_INSTALLED_ROOT;
if (!root) throw new Error('Set PAPER_EDITOR_INSTALLED_ROOT to the installed plugin source.');
const config = JSON.parse(await readFile(path.join(root, 'mcp.json'), 'utf8')).mcpServers['bilingual-paper-editor'];
const main = path.join(config.env.PAPER_EDITOR_WORKSPACE, config.env.PAPER_EDITOR_MAIN_FILE);
const hash = async () => createHash('sha256').update(await readFile(main)).digest('hex');
const before = await hash();
const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map(); let id = 0, buffer = '', stderr = '';
child.stderr.on('data', b => { stderr = (stderr + b).slice(-1000); });
child.stdout.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line), item = pending.get(message.id);
    if (item) { clearTimeout(item.timer); pending.delete(message.id); item.resolve(message.result); }
  }
});
child.on('exit', code => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(`Installed server exited ${code}: ${stderr}`)); } pending.clear(); });
function request(method, params) {
  const requestId = ++id;
  const promise = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`Installed server timed out: ${method}`)), 20000); pending.set(requestId, { resolve, reject, timer }); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n'); return promise;
}
try {
  const initialized = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'local-install-verifier', version: '1' } });
  assert.equal(initialized.serverInfo.name, 'bilingual-paper-editor');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const opened = await request('tools/call', { name: 'bilingual_paper_panel', arguments: {} });
  assert.ok(!opened.isError);
  const state = opened._meta.paperState;
  assert.equal(state.project.mainFile, config.env.PAPER_EDITOR_MAIN_FILE);
  assert.ok(state.segments.length > 0);
  const ui = await request('tools/call', { name: 'bilingual_paper_ui', arguments: { action: 'state', payload: {}, uiToken: opened._meta.paperUiToken } });
  assert.ok(!ui.isError);
  const after = await hash(); assert.equal(after, before);
  console.log(JSON.stringify({ ok: true, installedBundle: true, exactPaperOpened: true, sourceUnchanged: true, files: state.project.files.length, segments: state.segments.length, translatableSegments: state.segments.filter(x => x.translatable).length, protectedObjects: state.segments.reduce((n, x) => n + x.protectedTokens.length, 0), compiler: state.capabilities.secureCompile, directApply: state.capabilities.directApply, uiPrivateCapability: Boolean(opened._meta.paperUiToken), nativeHostRouting: 'not_live_verified' }));
} finally { child.stdin.end(); child.kill(); }
