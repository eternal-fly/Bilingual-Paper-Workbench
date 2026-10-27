import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { callDesktopCallback, parseDesktopCallback } from '../src/desktop-callback.mjs';
import { MODEL_TOOL_BYTES } from '../src/request-budgets.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t, changes = {}) {
  const owned = path.join(root, 'work/desktop-callback-tests'); await mkdir(owned, { recursive: true }); const installed = await mkdtemp(path.join(owned, 'case-')); await mkdir(path.join(installed, 'dist'));
  const body = '// Synthetic installed server; never executed.\n', version = '1.2.1';
  await writeFile(path.join(installed, 'plugin.json'), JSON.stringify({ name: 'bilingual-paper-editor', version })); await writeFile(path.join(installed, 'package.json'), JSON.stringify({ name: 'bilingual-paper-editor', version })); await writeFile(path.join(installed, 'dist/server.mjs'), body);
  await writeFile(path.join(installed, 'dist/build-manifest.json'), JSON.stringify({ schemaVersion: 1, version, files: { 'server.mjs': { sha256: createHash('sha256').update(body).digest('hex'), size: Buffer.byteLength(body) } } }));
  const config = { type: 'stdio', command: process.execPath, args: [path.join(installed, 'dist/server.mjs')], env: { PAPER_EDITOR_FULL_RUNTIME: '1', PAPER_EDITOR_INSTALL_VERSION: version, PAPER_EDITOR_DATA_ROOT: path.join(installed, 'private'), CODEX_THREAD_ID: 'must-not-override', CoDeX_ThReAd_Id: 'also-not-authority' }, ...changes };
  await writeFile(path.join(installed, 'mcp.json'), JSON.stringify({ mcpServers: { 'bilingual-paper-editor': config } }));
  const calls = [], response = { structuredContent: { requestId: 'req-1', batch: { segments: [{ id: 'p1', text: 'Keep ⟦protected-formula⟧.' }] } }, _meta: { paperUiToken: 'PRIVATE_UI_CAPABILITY', paperState: { secret: 'DO_NOT_PRINT' } } };
  class ClientClass { async connect(transport) { calls.push(['connect', transport.options]); } async callTool(input) { calls.push(['tool', input]); return response; } async close() { calls.push(['close']); } }
  class TransportClass { constructor(options) { this.options = options; } }
  const options = { pluginRoot: installed, env: { CODEX_THREAD_ID: 'actual-desktop-thread', CODEX_PROJECT_ID: 'actual-project', CODEX_HOME: 'actual-home', HOST_SENTINEL: 'preserved' }, cwd: root, ClientClass, TransportClass };
  t.after(async () => { assert.ok(installed.startsWith(owned + path.sep)); await rm(installed, { recursive: true, force: true }); }); return { installed, config, calls, response, options };
}

test('callback retains the four registered result actions and emits structured data without private metadata', async t => {
  const f = await fixture(t), inputs = [parseDesktopCallback(['get', 'translation-task-1']), parseDesktopCallback(['submit'], Buffer.from(JSON.stringify({ requestId: 'req-1', translations: [{ segmentId: 'p1', text: 'Translation' }] }))), parseDesktopCallback(['revision'], Buffer.from(JSON.stringify({ requestId: 'req-1', edits: [{ segmentId: 'p1', beforeHash: 'hash', replacement: 'Candidate' }], reason: 'Clarification' }))), parseDesktopCallback(['reply'], Buffer.from(JSON.stringify({ messageId: 'desktop-1', text: 'Answer' })))];
  for (const input of inputs) { const result = await callDesktopCallback(input, f.options); assert.deepEqual(result, f.response.structuredContent); assert.ok(!JSON.stringify(result).includes('PRIVATE_UI_CAPABILITY')); }
  assert.deepEqual(f.calls.filter(call => call[0] === 'tool').map(call => call[1].name), ['bilingual_paper_get_request', 'bilingual_paper_submit_translation_result', 'bilingual_paper_propose_revision', 'bilingual_paper_submit_chat_reply']);
  for (const [, transport] of f.calls.filter(call => call[0] === 'connect')) { assert.equal(transport.command, process.execPath); assert.deepEqual(transport.args, [path.join(f.installed, 'dist/server.mjs')]); assert.equal(transport.cwd, root); assert.equal(transport.env.CODEX_THREAD_ID, 'actual-desktop-thread'); assert.equal(transport.env.CoDeX_ThReAd_Id, undefined); assert.equal(transport.env.CODEX_PROJECT_ID, 'actual-project'); assert.equal(transport.env.HOST_SENTINEL, 'preserved'); assert.equal(transport.stderr, 'ignore'); }
  assert.equal(f.calls.filter(call => call[0] === 'close').length, 4);
});

test('stale host catalogs use fixed native project/editor/preparation verbs without arbitrary tools or text overrides',async t=>{
 const f=await fixture(t),scope={expectedProjectId:'paper-1',expectedSnapshotId:'source-1'},cases=[['project',{},'bilingual_paper_read_project'],['paragraphs',{...scope,segmentIds:['p1']},'bilingual_paper_read_paragraphs'],['read-editor',scope,'bilingual_paper_read_editor_drafts'],['save-editor',{...scope,captureId:'capture-1',segmentId:'p1',language:'zh-CN',baseDraftRevision:2,textHash:'a'.repeat(64)},'bilingual_paper_save_editor_draft'],['reconcile-draft',{...scope,segmentId:'p1',language:'zh-CN',expectedRevision:2},'bilingual_paper_reconcile_translation_draft'],['prepare',{...scope,kind:'revision',segmentIds:['p1']},'bilingual_paper_prepare_request'],['prepare-translation',{...scope,scope:'all'},'bilingual_paper_prepare_translation_task']];
 for(const[action,input,name]of cases){await callDesktopCallback(parseDesktopCallback([action],Buffer.from(JSON.stringify(input))),f.options);assert.equal(f.calls.filter(call=>call[0]==='tool').at(-1)[1].name,name);}
 assert.throws(()=>parseDesktopCallback(['save-editor'],Buffer.from(JSON.stringify({...cases[3][1],text:'Injected model replacement'}))),{code:'INVALID_INPUT'});assert.throws(()=>parseDesktopCallback(['project'],Buffer.from(JSON.stringify({originThreadId:'foreign'}))),{code:'INVALID_INPUT'});
});

test('candidate compilation uses its fixed native tool and cannot accept a caller-selected tool or source approval',async t=>{
 const f=await fixture(t),input={kind:'candidate',proposalIds:['proposal-a','proposal-b']};await callDesktopCallback(parseDesktopCallback(['compile'],Buffer.from(JSON.stringify(input))),f.options);
 const sent=f.calls.filter(row=>row[0]==='tool').at(-1)[1];assert.equal(sent.name,'bilingual_paper_compile');assert.deepEqual(sent.arguments,input);
 for(const extra of[{tool:'applyTransaction'},{confirmationToken:'forged'},{originThreadId:'foreign'}])assert.throws(()=>parseDesktopCallback(['compile'],Buffer.from(JSON.stringify({...input,...extra}))),{code:'INVALID_INPUT'});
});

test('missing or malformed inherited origin fails before installation reads or client connection', async t => {
  const f = await fixture(t), input = parseDesktopCallback(['get', 'req-1']);
  for (const origin of [undefined, '', 'foreign root/path', 'bad\nthread']) await assert.rejects(callDesktopCallback(input, { ...f.options, pluginRoot: path.join(f.installed, 'missing'), env: origin === undefined ? {} : { CODEX_THREAD_ID: origin } }), { code: 'HOST_CHAT_UNAVAILABLE' });
  assert.equal(f.calls.length, 0);
});

test('current installed root, exact server file, version and node executable are verified before transport', async t => {
  const f = await fixture(t), input = parseDesktopCallback(['get', 'req-1']);
  await writeFile(path.join(f.installed, 'dist/server.mjs'), '// Changed after build'); await assert.rejects(callDesktopCallback(input, f.options), { code: 'CALLBACK_INSTALLATION_INVALID' }); assert.equal(f.calls.length, 0);
  const other = await fixture(t, { args: [path.join(root, 'src/server.mjs')] }); await assert.rejects(callDesktopCallback(input, other.options), { code: 'CALLBACK_INSTALLATION_INVALID' }); assert.equal(other.calls.length, 0);
  const version = await fixture(t, { env: { PAPER_EDITOR_FULL_RUNTIME: '1', PAPER_EDITOR_INSTALL_VERSION: '0.0.0' } }); await assert.rejects(callDesktopCallback(input, version.options), { code: 'CALLBACK_INSTALLATION_INVALID' });
});

test('arguments cannot select another tool, chat, root, UI capability or over-budget stdin', () => {
  for (const argv of [['get', 'req-1', '--thread', 'other'], ['get', '../source'], ['compile', 'req-1'], ['get', 'req-1', '--root', 'elsewhere'], ['reply', 'extra']]) assert.throws(() => parseDesktopCallback(argv), { code: 'INVALID_INPUT' });
  for (const value of [{ messageId: 'desktop-1', text: 'Answer', originThreadId: 'other' }, { messageId: 'desktop-1', text: 'Answer', uiToken: 'capability' }]) assert.throws(() => parseDesktopCallback(['reply'], Buffer.from(JSON.stringify(value))), { code: 'INVALID_INPUT' });
  assert.throws(() => parseDesktopCallback(['submit'], Buffer.alloc(MODEL_TOOL_BYTES + 1, 32)), { code: 'INPUT_TOO_LARGE' }); assert.throws(() => parseDesktopCallback(['submit'], Buffer.from([0xff])), { code: 'INVALID_INPUT' });
});

test('server failure returns a sanitized code and always closes only its own callback client', async t => {
  const f = await fixture(t); f.response.isError = true; f.response.structuredContent = { error: { code: 'REQUEST_NOT_APPROVED' } }; f.response.content = [{ type: 'text', text: 'PRIVATE source path or token' }];
  await assert.rejects(callDesktopCallback(parseDesktopCallback(['get', 'req-1']), f.options), error => error.code === 'REQUEST_NOT_APPROVED' && !error.message.includes('PRIVATE')); assert.equal(f.calls.at(-1)[0], 'close');
});

test('importing the helper does not invoke its CLI or change the process exit code', () => {
  const uri = pathToFileURL(path.join(root, 'src/desktop-callback.mjs')).href, result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(uri)}); console.log('IMPORTED');`], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), 'IMPORTED'); assert.equal(result.stderr, '');
});
