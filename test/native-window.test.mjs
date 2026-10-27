import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PaperApplication } from '../src/application.mjs';
import { createPaperServer, WORKBENCH_URI,NATIVE_RELAY_URI } from '../src/server.mjs';
import { NativeWindowController, openNormalEdgeWindow } from '../src/native-window.mjs';
import { dispatchUi, startLocalWeb } from '../src/local-web.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function directory(t) {
  const parent = path.join(root, 'work/native-window-tests'); await mkdir(parent, { recursive: true }); const dir = await mkdtemp(path.join(parent, 'case-'));
  t.after(async () => { assert.ok(path.resolve(dir).startsWith(path.resolve(parent) + path.sep)); await rm(dir, { recursive: true, force: true }); }); return dir;
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('native window opens one shared HTTP service for concurrent opens, never starts a backend or worker', async t => {
  const dir = await directory(t), gate = deferred(), entered = deferred(), service = { identity: 'exact-native-service' }; let starts = 0, launches = 0, closes = 0;
  const url = `http://127.0.0.1:12345/#session=${'x'.repeat(43)}`;
  const controller = new NativeWindowController({ service, dataRoot: dir, instanceId: 'native-flight', startWeb: async input => { starts++; assert.equal(input.service, service); assert.equal(input.nativeBindingId, 'native-flight'); return { url, close: async () => { closes++; } }; }, launchWindow: async input => { assert.equal(input.url, url); launches++; entered.resolve(); await gate.promise; } });
  const first = controller.open(), second = controller.open(); await entered.promise; assert.equal(first, second); assert.equal(starts, 1); assert.equal(launches, 1); gate.resolve();
  const result = await first; assert.ok(!JSON.stringify(result).includes(url)); assert.ok(!JSON.stringify(result).includes('session=')); assert.equal(result.sameNativeService, true);
  await controller.open(); assert.equal(starts, 1); assert.equal(launches, 2);
  const privateSession = JSON.parse(await readFile(path.join(dir, 'sessions/native-native-flight.json'), 'utf8')); assert.equal(privateSession.url, url); assert.equal(privateSession.mode, 'native-independent-workbench');
  await controller.close(); assert.equal(closes, 1); await assert.rejects(controller.open(), { code: 'WINDOW_HOST_CLOSED' });
});
test('invalid external session is closed and never launches a browser or leaves a reusable HTTP instance', async t => {
  const dir = await directory(t); let closes = 0, launches = 0;
  const controller = new NativeWindowController({ service: {}, dataRoot: dir, instanceId: 'invalid-session', startWeb: async () => ({ url: `https://example.com/#session=${'x'.repeat(43)}`, close: async () => { closes++; } }), launchWindow: async () => { launches++; } });
  await assert.rejects(controller.open(), { code: 'WINDOW_SESSION_INVALID' }); assert.equal(launches, 0); assert.equal(closes, 1); assert.equal(controller.web, null); await controller.close();
});
test('a session-file preparation conflict closes the new HTTP service and preserves the existing file', async t => {
  const dir = await directory(t), sessions = path.join(dir, 'sessions'); await mkdir(sessions); const file = path.join(sessions, 'native-session-conflict.json'); await writeFile(file, 'existing-private-metadata'); let closed = 0, launches = 0;
  const controller = new NativeWindowController({ service: {}, dataRoot: dir, instanceId: 'session-conflict', startWeb: async () => ({ url: `http://127.0.0.1:12345/#session=${'x'.repeat(43)}`, close: async () => { closed++; } }), launchWindow: async () => { launches++; } });
  await assert.rejects(controller.open(), { code: 'EEXIST' }); assert.equal(closed, 1); assert.equal(launches, 0); assert.equal(controller.web, null); assert.equal(await readFile(file, 'utf8'), 'existing-private-metadata'); await controller.close();
});
test('ordinary browser launcher sends the capability only over stdin to its fixed helper', async t => {
  const dir = await directory(t), url = `http://127.0.0.1:12345/#session=${'z'.repeat(43)}`; let captured;
  const placement = await openNormalEdgeWindow({ url, dataRoot: dir, spawnAdapter: (command, args, options) => {
    captured = { command, args, options }; const child = new EventEmitter(); child.exitCode = null; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.kill = () => { child.exitCode = 1; };
    child.stdin.end = value => { captured.stdin = value; queueMicrotask(() => { const json = JSON.stringify({ width: 1440, height: 900, x: 20, y: 20, requestedState: 'normal', privateUntrustedField: url }); child.stdout.emit('data', Buffer.from(json.slice(0, 20))); child.exitCode = 0; child.emit('exit', 0); queueMicrotask(() => { child.stdout.emit('data', Buffer.from(json.slice(20))); child.emit('close', 0); }); }); }; return child;
  } });
  assert.ok(captured.args.includes('-ReadUrlFromStdin')); assert.ok(captured.args.includes('-DataRoot')); assert.ok(!JSON.stringify(captured.args).includes('session=')); assert.equal(captured.stdin, url + '\n'); assert.equal(captured.options.windowsHide, true);
  assert.deepEqual(placement, { width: 1440, height: 900, x: 20, y: 20, requestedState: 'normal', reusedWindow: false }); assert.ok(!JSON.stringify(placement).includes(url));
});

test('native HTTP requests bind to the host instance; dedicated worker binding requires an explicit live connection', async () => {
  let captured; const state = { connected: false, threadId: 'saved-id' }, service = { chat: { getState: () => ({ ...state }) }, createRequest: async value => { captured = value; return value; } };
  const options = { nativeBindingId: 'host-instance' };
  await dispatchUi(service, 'createRequest', { kind: 'revision', segmentIds: ['p1'] }, options); assert.equal(captured.bindingId, 'host-instance');
  await assert.rejects(dispatchUi(service, 'createRequest', { kind: 'revision', bindingId: 'forged' }, options), { code: 'PERMISSION_DENIED' });
  await assert.rejects(dispatchUi(service, 'createRequest', { kind: 'revision', useDedicatedChat: true }, options), { code: 'CHAT_REQUIRED' });
  state.connected = true; await dispatchUi(service, 'createRequest', { kind: 'revision', useDedicatedChat: true }, options); assert.equal(captured.bindingId, undefined); assert.equal(captured.useDedicatedChat, undefined);
});

test('default native tool opens an independent window with no model-visible private capability; optional panel remains separate', async t => {
  const dir = await directory(t), source = path.join(dir, 'source'); await mkdir(source); const sourceText = '\\documentclass{article}\n\\begin{document}\nA precise claim uses $x=1$.\n\\end{document}'; await writeFile(path.join(source, 'main.tex'), sourceText);
  const app = new PaperApplication({ dataRoot: path.join(dir, 'private') }); await app.openProject({ root: source, mainFile: 'main.tex' });
  const state = app.getState(), pair = { pairId: 'pair-window', projectId: state.project.id, original: { buildId: 'b1', hash: 'a'.repeat(64), snapshotId: 's0' }, latest: { buildId: 'b2', hash: 'b'.repeat(64), snapshotId: state.project.snapshotId } };
  app.versionPair = { read: async () => structuredClone(pair), state: () => structuredClone(pair) };
  let displayedUrl; const instanceId = 'native-window-host', controller = new NativeWindowController({ service: app, dataRoot: path.join(dir, 'private'), instanceId, launchWindow: async ({ url }) => { displayedUrl = url; } });
  const server = createPaperServer({ service: app, instanceId, uiHtml: '<!doctype html><title>Native panel test</title>', openIndependentWindow: async exact => { assert.equal(exact, app); return controller.open(); } });
  const client = new Client({ name: 'native-window-sdk', version: '1' }), [cs, ss] = InMemoryTransport.createLinkedPair(); await server.connect(ss); await client.connect(cs);
  t.after(async () => { await controller.close(); await client.close(); await server.close(); await app.close(); });
  const tools = (await client.listTools()).tools, editor = tools.find(tool => tool.name === 'bilingual_paper_editor'), panel = tools.find(tool => tool.name === 'bilingual_paper_panel');
  assert.equal(editor._meta?.ui?.resourceUri,NATIVE_RELAY_URI); assert.notEqual(editor._meta.ui.resourceUri,WORKBENCH_URI);assert.equal(panel._meta.ui.resourceUri, WORKBENCH_URI);
  const opened = await client.callTool({ name: 'bilingual_paper_editor', arguments: {} }); assert.equal(opened.isError, undefined, opened._meta?.paperError?.message); assert.ok(opened._meta.paperUiToken);assert.ok(opened._meta.paperRelaySession);const modelVisible=JSON.stringify({content:opened.content,structuredContent:opened.structuredContent});assert.ok(!modelVisible.includes(opened._meta.paperUiToken));assert.ok(!modelVisible.includes(opened._meta.paperRelaySession)); assert.equal(opened.structuredContent.window.sameNativeService, true);
  const parsed = new URL(displayedUrl), token = new URLSearchParams(parsed.hash.slice(1)).get('session'); assert.ok(!JSON.stringify(opened).includes(token)); assert.ok(!JSON.stringify(opened).includes(displayedUrl));
  const api = async (action, payload = {}, endpoint = '/api', headers = {}) => fetch(parsed.origin + endpoint, { method: 'POST', headers: { Origin: parsed.origin, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ action, payload }) });
  assert.equal((await api('state', {}, '/api', { Authorization: '' })).status, 401); assert.equal((await api('state', {}, '/api', { Origin: 'https://example.com' })).status, 403);
  const current = await (await api('state')).json(); assert.equal(current.transport.mode,'native-window');assert.equal(current.transport.nativeChat,true);assert.equal(current.transport.canSendMessage,false);assert.equal(current.transport.messageRoute,'native-relay'); assert.equal(current.result.project.id, app.getState().project.id);
  const pairContext = { pairId: pair.pairId, original: { hash: pair.original.hash, pageCount: 1, pages: [{ page: 1, text: 'Original complete PDF text' }] }, latest: { hash: pair.latest.hash, pageCount: 1, pages: [{ page: 1, text: 'Latest complete PDF text' }] } };
  const cached = await (await api('cacheVersionPairContext', { pairContext }, '/api/review-cycle')).json(); assert.equal(cached.ok, true); assert.ok(app.cycles.cached);
  const nativeContext = await client.callTool({ name: 'bilingual_paper_get_pdf_context', arguments: {} }); assert.equal(nativeContext.isError, undefined, nativeContext._meta?.paperError?.message); assert.equal(nativeContext.structuredContent.pdfs[1].pages[0].text, 'Latest complete PDF text');
  const paragraph = app.getState().readingParagraphs[0], created = await (await api('createRequest', { kind: 'revision', segmentIds: [paragraph.id] })).json(); assert.equal(created.ok, true); assert.equal(created.result.bindingId, instanceId);
  const approved = await client.callTool({ name: 'bilingual_paper_get_request', arguments: { requestId: created.result.requestId } }); assert.equal(approved.isError, undefined); assert.equal(approved.structuredContent.segments[0].id, paragraph.id);
  const embedded = await client.callTool({ name: 'bilingual_paper_panel', arguments: {} }); assert.ok(embedded._meta.paperUiToken); assert.equal(embedded._meta.instanceId, instanceId);
  assert.equal(app.chat, null); assert.equal(app.getState().transactions.length, 0); assert.equal(await readFile(path.join(source, 'main.tex'), 'utf8'), sourceText);
});
test('default opener reports unavailable runtime instead of pretending to open a window', async t => {
  const service = { getState: () => ({ project: null, segments: [], translations: {}, proposals: [] }) }, server = createPaperServer({ service, uiHtml: '<!doctype html>' }), client = new Client({ name: 'missing-native-window', version: '1' }), [cs, ss] = InMemoryTransport.createLinkedPair(); await server.connect(ss); await client.connect(cs);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: 'bilingual_paper_editor', arguments: {} }); assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, 'CAPABILITY_UNAVAILABLE'); assert.equal(result._meta.paperUiToken, undefined);
});
