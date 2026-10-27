import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackgroundWindowController } from '../src/native-window.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataRoot = path.join(root, 'work/synthetic-background-window-private');
const projectRoot = path.join(root, 'fixtures/sample-paper');
const url = `http://127.0.0.1:12345/#session=${'v'.repeat(43)}`;
const placement = { width: 1440, height: 900, x: 20, y: 30, requestedState: 'normal' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function currentState() {
  return { project: { id: 'synthetic-paper', mainFile: 'main.tex' }, workspaceIndex: { currentRecord: { recordId: 'task-synthetic-paper', projectRoot, mainFile: 'main.tex' } }, nativeChatBinding: { kind: 'bound-existing-chat', projectId: 'synthetic-paper', threadId: 'exact-existing-paper-chat', model: 'gpt-6-astra', effort: 'medium' } };
}

test('a trusted Desktop task keeps one task-scoped daemon after its native controller selects a paper', async () => {
  const state = currentState(); state.workspaceIndex.hostContext = { native: true, taskIdAvailable: true, hostTaskId: 'verified-origin-chat' };
  let options;
  const controller = new BackgroundWindowController({ service: { getState: () => state }, pluginRoot: root, dataRoot, version: '1.2.1', ensure: async value => { options = value; return {}; }, readSession: async () => ({ url }), launchWindow: async () => placement });
  await controller.open();
  assert.equal(options.launchId, 'verified-origin-chat'); assert.equal(options.originThreadId, 'verified-origin-chat');
  assert.equal(options.record, null); assert.equal(options.binding, null);
});

test('background opener passes only the exact active record and its verified chat reference', async () => {
  const state = currentState(), captured = []; let launches = 0;
  const controller = new BackgroundWindowController({ service: { getState: () => structuredClone(state) }, pluginRoot: root, dataRoot, version: '0.7.0', ensure: async options => { captured.push(['ensure', options]); return { reused: true, pid: 123 }; }, readSession: async options => { captured.push(['read', options]); return { url, pid: 123 }; }, launchWindow: async input => { launches++; assert.deepEqual(input, { url, dataRoot }); return placement; } });
  const before = structuredClone(state), result = await controller.open();
  const expected = { pluginRoot: root, dataRoot, version: '0.7.0', record: { projectRoot, mainFile: 'main.tex', recordId: 'task-synthetic-paper' }, binding: { threadId: 'exact-existing-paper-chat', model: 'gpt-6-astra', effort: 'medium' } };
  assert.deepEqual(captured, [['ensure', expected], ['read', expected]]); assert.equal(launches, 1); assert.deepEqual(state, before);
  assert.equal(result.mode, 'background-workbench'); assert.equal(result.sameNativeService, false); assert.equal(result.reusedService, true); assert.equal(result.desktopWindowRequired, false); assert.equal(result.nativeCardRequired, false); assert.equal(result.requestedWindowState, 'normal'); assert.deepEqual(result.placement, placement); assert.ok(!JSON.stringify(result).includes('session='));
});

test('concurrent opens share one helper and later opens reuse its window without reloading the paper', async () => {
  const gate = deferred(), entered = deferred(); let ensures = 0, reads = 0, launches = 0;
  let windows = 0;
  const controller = new BackgroundWindowController({ service: { getState: currentState }, pluginRoot: root, dataRoot, version: '0.7.0', ensure: async () => { ensures++; entered.resolve(); await gate.promise; return { reused: ensures > 1 }; }, readSession: async () => { reads++; return { url }; }, launchWindow: async () => { launches++; const reusedWindow = windows > 0; if (!reusedWindow) windows++; return { ...placement, reusedWindow }; } });
  const first = controller.open(), second = controller.open(); assert.equal(first, second); await entered.promise; assert.equal(ensures, 1); gate.resolve(); await first;
  assert.equal(reads, 1); assert.equal(launches, 1);
  const next = await controller.open(); assert.equal(next.reusedService, true); assert.equal(next.reusedWindow, true); assert.equal(ensures, 2); assert.equal(reads, 2); assert.equal(launches, 2); assert.equal(windows, 1);
});

test('closing an MCP opener never closes its source service or detached backend', async () => {
  const gate = deferred(); let sourceCloses = 0, backgroundCloses = 0, launches = 0;
  const controller = new BackgroundWindowController({ service: { getState: currentState, close: async () => { sourceCloses++; } }, pluginRoot: root, dataRoot, ensure: async () => { await gate.promise; return { reused: false, close: async () => { backgroundCloses++; } }; }, readSession: async () => ({ url, close: async () => { backgroundCloses++; } }), launchWindow: async () => { launches++; return placement; } });
  const opening = controller.open(); await controller.close(); gate.resolve(); await opening; await controller.close();
  assert.equal(sourceCloses, 0); assert.equal(backgroundCloses, 0); assert.equal(launches, 1);
});

test('a binding from another paper is never forwarded', async () => {
  const state = currentState(); state.nativeChatBinding.projectId = 'different-paper'; let ensured;
  const controller = new BackgroundWindowController({ service: { getState: () => state }, pluginRoot: root, dataRoot, ensure: async options => { ensured = options; return { reused: false }; }, readSession: async () => ({ url }), launchWindow: async () => placement });
  await controller.open(); assert.equal(ensured.binding, null);
});

test('private session capabilities cannot escape through untrusted launcher placement metadata', async () => {
  const controller = new BackgroundWindowController({ service: { getState: currentState }, pluginRoot: root, dataRoot, ensure: async () => ({ reused: false, url, token: 'not-public' }), readSession: async () => ({ url }), launchWindow: async () => ({ ...placement, privateUntrustedField: url, token: 'not-public' }) });
  const result = await controller.open(); assert.ok(!JSON.stringify(result).includes(url)); assert.ok(!JSON.stringify(result).includes('not-public')); assert.deepEqual(result.placement, placement);
});

test('failed readiness or session validation never opens a window and allows a later retry', async () => {
  let attempts = 0, launches = 0;
  const controller = new BackgroundWindowController({ service: { getState: currentState }, pluginRoot: root, dataRoot, ensure: async () => { if (++attempts === 1) throw Object.assign(Error('pending'), { code: 'BACKGROUND_NOT_READY' }); return { reused: true }; }, readSession: async () => ({ url }), launchWindow: async () => { launches++; return placement; } });
  await assert.rejects(controller.open(), { code: 'BACKGROUND_NOT_READY' }); assert.equal(launches, 0); await controller.open(); assert.equal(attempts, 2); assert.equal(launches, 1);
});

test('an external or malformed private session is rejected before invoking the window helper', async () => {
  let launches = 0;
  const controller = new BackgroundWindowController({ service: { getState: currentState }, pluginRoot: root, dataRoot, ensure: async () => ({ reused: true }), readSession: async () => ({ url: `https://example.com/#session=${'v'.repeat(43)}` }), launchWindow: async () => { launches++; return placement; } });
  await assert.rejects(controller.open(), { code: 'WINDOW_SESSION_INVALID' }); assert.equal(launches, 0);
});


test('first use opens an empty independent task window before any project is imported', async () => {
  let captured, launched=0;
  const empty = new BackgroundWindowController({ instanceId:'new-native-instance', version:'1.1.0', service:{getState:()=>({project:null,workspaceIndex:{currentRecord:null,hostContext:{hostTaskId:'new-paper-chat'}}})},pluginRoot:root,dataRoot,ensure:async options=>{captured=options;return{reused:false};},readSession:async()=>({url}),launchWindow:async()=>{launched++;return placement;} });
  const result=await empty.open();
  assert.deepEqual(captured,{pluginRoot:root,dataRoot,version:'1.1.0',record:null,binding:null,launchId:'new-paper-chat'});
  assert.equal(launched,1);assert.equal(result.opened,true);assert.equal(result.projectRequired,true);assert.equal(result.mode,'background-workbench');
});

test('imports dispatch privately to the already opened backend without reopening its window', async () => {
  let launches=0,ensures=0,requests=0;const options=[];
  const controller = new BackgroundWindowController({instanceId:'empty-window',service:{getState:()=>({project:null,workspaceIndex:{currentRecord:null,hostContext:{hostTaskId:'paper-task'}}})},pluginRoot:root,dataRoot,ensure:async value=>{ensures++;options.push(value);return{reused:ensures>1};},readSession:async()=>({url}),launchWindow:async()=>{launches++;return placement;},dispatchRequest:async input=>{requests++;assert.equal(input.url,url);assert.equal(input.action,'importFiles');assert.deepEqual(input.payload,{sourcePath:'exact-user-file.zip'});return{ok:true,result:{imported:true},state:{project:{id:'new-paper'}}};}});
  await controller.open();const returned=await controller.dispatch('importFiles',{sourcePath:'exact-user-file.zip'});
  assert.equal(launches,1);assert.equal(requests,1);assert.equal(returned.state.project.id,'new-paper');assert.deepEqual(options[1],options[0]);
  await assert.rejects(controller.dispatch('applyTransaction',{}),{code:'PERMISSION_DENIED'});assert.equal(requests,1);
});
test('only the trusted native host task becomes the automatic originating chat, never a random instance fallback', async () => {
  for (const trusted of [true, false]) {
    let selected;
    const controller = new BackgroundWindowController({ instanceId: 'random-fallback-instance', pluginRoot: root, dataRoot,
      service: { getState: () => ({ project: null, workspaceIndex: { hostContext: { native: true, hostTaskId: trusted ? 'actual-host-chat' : null, taskIdAvailable: trusted } } }) },
      ensure: async value => { selected = value; return { reused: false }; }, readSession: async () => ({ url }), launchWindow: async () => placement,
    });
    await controller.open();
    assert.equal(selected.originThreadId ?? null, trusted ? 'actual-host-chat' : null);
    assert.equal(selected.launchId, trusted ? 'actual-host-chat' : 'random-fallback-instance');
  }
});

test('the native launcher signs only a current transport-derived project hint and updates it when the current chat project changes', async () => {
  let currentRoot = path.join(root, 'current-project'), source = 'mcp-roots'; const selected = [];
  const controller = new BackgroundWindowController({ pluginRoot: root, dataRoot, instanceId: 'instance', service: { getState: () => ({ project: null, workspaceIndex: { hostContext: { native: true, hostTaskId: 'actual-host-chat', taskIdAvailable: true, projectRoot: currentRoot, roots: [{ root: currentRoot }], source, hostProjectId: 'current-project-id' } } }) }, ensure: async value => { selected.push(value); return { reused: false }; }, readSession: async () => ({ url }), signProjectRefresh: async () => ({ syntheticProof: true }), dispatchRequest: async input => { assert.equal(input.action, 'syncHostProject'); assert.deepEqual(input.payload, { syntheticProof: true }); return { ok: true }; }, launchWindow: async () => placement });
  await controller.open(); assert.deepEqual(selected[0].hostProject, { projectRoot: currentRoot, source: 'mcp-roots', hostProjectId: 'current-project-id', autoOpen: true });
  currentRoot = path.join(root, 'new-project'); await controller.open(); assert.equal(selected[1].hostProject.projectRoot, currentRoot);
  source = 'explicit-launch-binding'; await controller.open(); assert.equal(selected[2].hostProject, undefined);
});
