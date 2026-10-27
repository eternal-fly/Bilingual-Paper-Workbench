import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {createHash} from 'node:crypto';
import { ensureBackgroundWorkbench, readBackgroundSession, runBackgroundWorkbench, openConfiguredWorkbench, signHostProjectRefresh, signProjectWindowHandoff } from '../src/background-workbench.mjs';
import { createApplication } from '../src/runtime.mjs';
import { WorkspaceService } from '../src/workspace-service.mjs';
import { PaperApplication } from '../src/application.mjs';
import { startLocalWeb, dispatchUi } from '../src/local-web.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const parent = path.join(root, 'work/background-tests'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'case-')), pluginRoot = path.join(directory, 'plugin'), dataRoot = path.join(directory, 'private'), projectRoot = path.join(directory, 'paper');
  for (const dir of [pluginRoot, dataRoot, projectRoot, path.join(pluginRoot, 'dist')]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(projectRoot, 'main.tex'), '\\documentclass{article}\\begin{document}Synthetic $x=1$.\\end{document}');
  await writeFile(path.join(pluginRoot, 'dist/background-workbench.mjs'), '// synthetic fixed entry');
  await writeFile(path.join(pluginRoot, 'mcp.json'), JSON.stringify({ mcpServers: { 'bilingual-paper-editor': { command: process.execPath, env: { PAPER_EDITOR_DATA_ROOT: dataRoot, PAPER_EDITOR_CODEX_ROOT: path.join(directory, 'codex'), PAPER_EDITOR_INSTALL_VERSION: '0.6.0', PAPER_EDITOR_WORKSPACE: projectRoot, PAPER_EDITOR_MAIN_FILE: 'main.tex' } } } }));
  const cleanups = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); assert.ok(path.resolve(directory).startsWith(path.resolve(parent) + path.sep)); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { pluginRoot, dataRoot, record: { projectRoot, mainFile: 'main.tex' }, version: '0.6.0', binding: { threadId: 'existing-synthetic-chat', model: 'gpt-6-astra', effort: 'medium' }, timeoutMs: 500, pollMs: 5, onCleanup: work => cleanups.push(work) };
}

test('the signed invoking chat identity reaches an empty daemon without binding a random fallback instance', async t => {
  const f = await fixture(t), options = { ...f, record: null, binding: null, launchId: 'trusted-origin-chat', originThreadId: 'trusted-origin-chat' };
  let captured, lifecycle;
  const spawnAdapter = (_command, args) => {
    queueMicrotask(async () => {
      const handle = await runBackgroundWorkbench({ descriptorFile: args.at(-1), pluginRoot: options.pluginRoot, createService: async input => {
        captured = input; return { hostContext: {}, getState: () => ({ project: null, workspaceIndex: { currentRecord: null } }), startWatching() {}, async close() {} };
      }, startWeb: async ({ service }) => { lifecycle = service.getState().backgroundLifecycle; return { url: `http://127.0.0.1:12345/#session=${'o'.repeat(43)}`, async close() {} }; }, registerSignals: false });
      options.onCleanup(() => handle.close());
    });
    return { pid: process.pid, unref() {}, once() {} };
  };
  const ready = await ensureBackgroundWorkbench({ ...options, spawnAdapter, probeAdapter: async () => true });
  const session = await readBackgroundSession({ ...options, probeAdapter: async () => true });
  assert.equal(captured.backgroundOriginThreadId, 'trusted-origin-chat'); assert.equal(captured.backgroundBinding, null); assert.equal(captured.mainFile, null);
  assert.equal(lifecycle.originThreadId, 'trusted-origin-chat'); assert.equal(session.originThreadId, 'trusted-origin-chat'); assert.equal(ready.mode, 'background-workbench');
  await assert.rejects(ensureBackgroundWorkbench({ ...options, originThreadId: 'random-other-chat' }), { code: 'BACKGROUND_CONFIG_INVALID' });
});

test('identical installed copies reuse the same private task daemon for Desktop callbacks', async t => {
  const f = await fixture(t), options = { ...f, record: null, binding: null, launchId: 'same-origin', originThreadId: 'same-origin' };
  const otherRoot = path.join(path.dirname(f.pluginRoot), 'installed-copy');
  await mkdir(path.join(otherRoot, 'dist'), { recursive: true });
  await writeFile(path.join(otherRoot, 'dist/background-workbench.mjs'), '// synthetic fixed entry');
  await writeFile(path.join(otherRoot, 'mcp.json'), await readFile(path.join(f.pluginRoot, 'mcp.json')));
  let launches = 0;
  const spawnAdapter = (_command, args) => {
    launches++; queueMicrotask(async () => {
      const handle = await runBackgroundWorkbench({ descriptorFile: args.at(-1), pluginRoot: f.pluginRoot, createService: async () => ({ getState: () => ({ project: null, workspaceIndex: { currentRecord: null } }), startWatching() {}, async close() {} }), startWeb: async () => ({ url: `http://127.0.0.1:12345/#session=${'j'.repeat(43)}`, async close() {} }), registerSignals: false });
      f.onCleanup(() => handle.close());
    }); return { pid: process.pid, unref() {}, once() {} };
  };
  const first = await ensureBackgroundWorkbench({ ...options, spawnAdapter, probeAdapter: async () => true });
  const second = await ensureBackgroundWorkbench({ ...options, pluginRoot: otherRoot, spawnAdapter: () => { throw Error('A second installation must not start a competing paper daemon.'); }, probeAdapter: async () => true });
  assert.equal(second.reused, true); assert.equal(first.sessionFile, second.sessionFile); assert.equal(launches, 1);
});

test('a changed same-version background build gets a new content owner without closing the old window',async t=>{
 const options=await fixture(t);let launches=0,closed=0;const spawnAdapter=(_command,args)=>{launches++;queueMicrotask(async()=>{const handle=await runBackgroundWorkbench({descriptorFile:args.at(-1),pluginRoot:options.pluginRoot,createService:async()=>({getState:()=>({project:{mainFile:'main.tex'},workspaceIndex:{currentRecord:options.record}}),openProject:async()=>{},prepareBackgroundBinding:async()=>{},startWatching(){},async close(){closed++;}}),startWeb:async()=>({url:`http://127.0.0.1:12345/#session=${'v'.repeat(43)}`,async close(){}}),registerSignals:false});options.onCleanup(()=>handle.close());});return{pid:process.pid,unref(){},once(){}};};
 const first=await ensureBackgroundWorkbench({...options,spawnAdapter,probeAdapter:async()=>true}),oldBytes=await readFile(first.sessionFile);await writeFile(path.join(options.pluginRoot,'dist/background-workbench.mjs'),'// synthetic changed same-version entry');const second=await ensureBackgroundWorkbench({...options,spawnAdapter,probeAdapter:async()=>true});
 assert.equal(second.reused,false);assert.notEqual(second.sessionFile,first.sessionFile);assert.equal(launches,2);assert.equal(closed,0);assert.deepEqual(await readFile(first.sessionFile),oldBytes);
 const copy=path.join(path.dirname(options.pluginRoot),'same-build-copy');await mkdir(path.join(copy,'dist'),{recursive:true});await writeFile(path.join(copy,'dist/background-workbench.mjs'),await readFile(path.join(options.pluginRoot,'dist/background-workbench.mjs')));await writeFile(path.join(copy,'mcp.json'),await readFile(path.join(options.pluginRoot,'mcp.json')));const reused=await ensureBackgroundWorkbench({...options,pluginRoot:copy,spawnAdapter:()=>{throw Error('Identical runtime content must reuse its task daemon.');},probeAdapter:async()=>true});assert.equal(reused.reused,true);assert.equal(reused.sessionFile,second.sessionFile);assert.equal(closed,0);
});

test('same-version UI build identity changes daemon key and inconsistent installed manifests never spawn',async t=>{
 const options=await fixture(t),entry=await readFile(path.join(options.pluginRoot,'dist/background-workbench.mjs')),sha=bytes=>createHash('sha256').update(bytes).digest('hex'),manifest={schemaVersion:1,version:options.version,files:{'background-workbench.mjs':{size:entry.length,sha256:sha(entry)},'workbench.html':{size:3,sha256:sha('old')}}};await writeFile(path.join(options.pluginRoot,'dist/build-manifest.json'),JSON.stringify(manifest));let launches=0;
 const spawnAdapter=(_command,args)=>{launches++;queueMicrotask(async()=>{const handle=await runBackgroundWorkbench({descriptorFile:args.at(-1),pluginRoot:options.pluginRoot,createService:async()=>({getState:()=>({project:{mainFile:'main.tex'},workspaceIndex:{currentRecord:options.record}}),openProject:async()=>{},prepareBackgroundBinding:async()=>{},startWatching(){},async close(){}}),startWeb:async()=>({url:`http://127.0.0.1:12345/#session=${'u'.repeat(43)}`,async close(){}}),registerSignals:false});options.onCleanup(()=>handle.close());});return{pid:process.pid,unref(){},once(){}};};
 const first=await ensureBackgroundWorkbench({...options,spawnAdapter,probeAdapter:async()=>true});manifest.files['workbench.html']={size:3,sha256:sha('new')};await writeFile(path.join(options.pluginRoot,'dist/build-manifest.json'),JSON.stringify(manifest));const second=await ensureBackgroundWorkbench({...options,spawnAdapter,probeAdapter:async()=>true});assert.notEqual(first.sessionFile,second.sessionFile);assert.equal(second.reused,false);assert.equal(launches,2);
 manifest.files['background-workbench.mjs'].sha256=sha('not the installed entry');await writeFile(path.join(options.pluginRoot,'dist/build-manifest.json'),JSON.stringify(manifest));await assert.rejects(ensureBackgroundWorkbench({...options,spawnAdapter:()=>{launches++;throw Error('Do not spawn inconsistent installed bytes.');},probeAdapter:async()=>true}),{code:'BACKGROUND_CONFIG_INVALID'});assert.equal(launches,2);
});

test('installed build replacement revokes an already signed descriptor before any service is opened',async t=>{
 const options=await fixture(t);let descriptorFile,opened=0;await assert.rejects(ensureBackgroundWorkbench({...options,timeoutMs:30,spawnAdapter:(_command,args)=>{descriptorFile=args.at(-1);return{pid:process.pid,unref(){},once(){}};},probeAdapter:async()=>false}),{code:'BACKGROUND_NOT_READY'});await writeFile(path.join(options.pluginRoot,'dist/background-workbench.mjs'),'// replacement after descriptor was signed');await assert.rejects(runBackgroundWorkbench({descriptorFile,pluginRoot:options.pluginRoot,createService:async()=>{opened++;},registerSignals:false}),{code:'BACKGROUND_HANDOFF_INVALID'});assert.equal(opened,0);
});

test('oversized or malformed installed build identity never launches or rewrites an existing session',async t=>{
 const options=await fixture(t);let launches=0;const spawnAdapter=()=>{launches++;throw Error('Unverified runtime must not launch.');},entry=path.join(options.pluginRoot,'dist/background-workbench.mjs');await writeFile(entry,Buffer.alloc(16*1024*1024+1));await assert.rejects(ensureBackgroundWorkbench({...options,spawnAdapter}),{code:'BACKGROUND_CONFIG_INVALID'});await writeFile(entry,'// restored synthetic entry');await writeFile(path.join(options.pluginRoot,'dist/build-manifest.json'),Buffer.from([0x7b,0x22,0x78,0x22,0x3a,0x22,0xff,0x22,0x7d]));await assert.rejects(ensureBackgroundWorkbench({...options,spawnAdapter}),{code:'BACKGROUND_CONFIG_INVALID'});assert.equal(launches,0);
});

test('a caller cannot replace both signed launch and origin identities before any chat verification', async t => {
  const f = await fixture(t), options = { ...f, record: null, binding: null, launchId: 'trusted-origin-chat', originThreadId: 'trusted-origin-chat' }; let descriptorFile, opened = 0;
  await assert.rejects(ensureBackgroundWorkbench({ ...options, timeoutMs: 30, spawnAdapter: (_command, args) => { descriptorFile = args.at(-1); return { pid: process.pid, unref() {}, once() {} }; }, probeAdapter: async () => false }), { code: 'BACKGROUND_NOT_READY' });
  const envelope = JSON.parse(await readFile(descriptorFile, 'utf8')); envelope.payload.launchId = 'replacement'; envelope.payload.originThreadId = 'replacement'; await writeFile(descriptorFile, JSON.stringify(envelope));
  await assert.rejects(runBackgroundWorkbench({ descriptorFile, pluginRoot: options.pluginRoot, createService: async () => { opened++; }, registerSignals: false }), { code: 'BACKGROUND_HANDOFF_INVALID' });
  assert.equal(opened, 0);
});

test('background launch detaches from native stdio, keeps capabilities private and reuses exact ready service', async t => {
  const options = await fixture(t); let launches = 0, unrefs = 0, captured, closed = 0;
  const url = `http://127.0.0.1:12345/#session=${'b'.repeat(43)}`;
  const spawnAdapter = (command, args, spawnOptions) => {
    launches++; captured = { command, args, spawnOptions };
    queueMicrotask(async () => {
      const handle = await runBackgroundWorkbench({ descriptorFile: args.at(-1), pluginRoot: options.pluginRoot, createService: async input => {
        assert.deepEqual(input.backgroundBinding, options.binding); assert.equal(input.workspace, options.record.projectRoot); assert.equal(input.backgroundMode, true);
        return { getState: () => ({ project: { id: 'synthetic-project', mainFile: 'main.tex' }, workspaceIndex: { currentRecord: { projectRoot: options.record.projectRoot, mainFile: 'main.tex' } } }), openProject: async () => {}, prepareBackgroundBinding: async () => {}, startWatching: () => {}, close: async () => { closed++; } };
      }, startWeb: async () => ({ url, close: async () => {} }), registerSignals: false });
      options.onCleanup(() => handle.close());
    });
    return { pid: process.pid, unref() { unrefs++; }, once() {} };
  };
  const probeAdapter = async () => true;
  const first = await ensureBackgroundWorkbench({ ...options, spawnAdapter, probeAdapter });
  assert.equal(first.mode, 'background-workbench'); assert.equal(first.reused, false); assert.equal(first.desktopWindowRequired, false);
  assert.equal(captured.command, process.execPath); assert.equal(captured.spawnOptions.detached, true); assert.equal(captured.spawnOptions.stdio, 'ignore'); assert.equal(captured.spawnOptions.windowsHide, true); assert.equal(unrefs, 1);
  assert.equal(captured.args[0], path.join(options.pluginRoot, 'dist/background-workbench.mjs')); assert.ok(!JSON.stringify(captured).includes('session=')); assert.ok(!JSON.stringify(first).includes(url));
  const privateSession = await readBackgroundSession({ ...options, sessionFile: first.sessionFile, probeAdapter }); assert.equal(privateSession.url, url);
  const second = await ensureBackgroundWorkbench({ ...options, spawnAdapter, probeAdapter }); assert.equal(second.reused, true); assert.equal(launches, 1);
  assert.equal(closed, 0);
});

test('signed launch descriptor rejects tampering before opening the paper or starting any chat', async t => {
  const options = await fixture(t); let descriptorFile, initialization = 0;
  await assert.rejects(ensureBackgroundWorkbench({ ...options, timeoutMs: 30, spawnAdapter: (_command, args) => { descriptorFile = args.at(-1); return { pid: process.pid, unref() {}, once() {} }; }, probeAdapter: async () => false }), { code: 'BACKGROUND_NOT_READY' });
  const descriptor = JSON.parse(await readFile(descriptorFile, 'utf8')); descriptor.payload.record.mainFile = 'other.tex'; await writeFile(descriptorFile, JSON.stringify(descriptor));
  await assert.rejects(runBackgroundWorkbench({ descriptorFile, pluginRoot: options.pluginRoot, createService: async () => { initialization++; }, registerSignals: false }), { code: 'BACKGROUND_HANDOFF_INVALID' });
  assert.equal(initialization, 0);
});

test('unhealthy live process is not killed or overwritten during recovery', async t => {
  const options = await fixture(t); let sessionFile;
  const spawnAdapter = (_command, args) => {
    queueMicrotask(async () => {
      const handle = await runBackgroundWorkbench({ descriptorFile: args.at(-1), pluginRoot: options.pluginRoot, createService: async () => ({ getState: () => ({ project: { mainFile: 'main.tex' }, workspaceIndex: { currentRecord: options.record } }), openProject: async () => {}, prepareBackgroundBinding: async () => {}, startWatching() {}, close: async () => {} }), startWeb: async () => ({ url: `http://127.0.0.1:12345/#session=${'c'.repeat(43)}`, close: async () => {} }), registerSignals: false });
      options.onCleanup(() => handle.close());
    });
    return { pid: process.pid, unref() {}, once() {} };
  };
  sessionFile = (await ensureBackgroundWorkbench({ ...options, spawnAdapter, probeAdapter: async () => true })).sessionFile;
  const original = await readFile(sessionFile, 'utf8');
  await assert.rejects(ensureBackgroundWorkbench({ ...options, spawnAdapter: () => { throw Error('must not start competing owner'); }, probeAdapter: async () => false }), { code: 'BACKGROUND_OWNER_UNAVAILABLE' });
  assert.equal(await readFile(sessionFile, 'utf8'), original);
});

test('unregistered install command and mismatched private data root never spawn', async t => {
  const options = await fixture(t); let launches = 0;
  await assert.rejects(ensureBackgroundWorkbench({ ...options, dataRoot: path.join(options.dataRoot, 'different'), spawnAdapter: () => { launches++; } }), { code: 'BACKGROUND_CONFIG_INVALID' });
  const configPath = path.join(options.pluginRoot, 'mcp.json'), config = JSON.parse(await readFile(configPath, 'utf8')); config.mcpServers['bilingual-paper-editor'].command = 'node'; await writeFile(configPath, JSON.stringify(config));
  await assert.rejects(ensureBackgroundWorkbench({ ...options, spawnAdapter: () => { launches++; } }), { code: 'BACKGROUND_CONFIG_INVALID' }); assert.equal(launches, 0);
});

test('own newly started service can finish bounded health readiness without launching a second owner', async t => {
  const options = await fixture(t); let probes = 0, launches = 0;
  const launch = await ensureBackgroundWorkbench({ ...options, probeAdapter: async () => ++probes >= 3, spawnAdapter: (_command, args) => {
    launches++;
    queueMicrotask(async () => {
      const handle = await runBackgroundWorkbench({ descriptorFile: args.at(-1), pluginRoot: options.pluginRoot, createService: async () => ({ getState: () => ({ project: { mainFile: 'main.tex' }, workspaceIndex: { currentRecord: options.record } }), openProject: async () => {}, prepareBackgroundBinding: async () => {}, startWatching() {}, close: async () => {} }), startWeb: async () => ({ url: `http://127.0.0.1:12345/#session=${'d'.repeat(43)}`, close: async () => {} }), registerSignals: false }); options.onCleanup(() => handle.close());
    });
    return { pid: process.pid, unref() {}, once() {} };
  } });
  assert.equal(launch.reused, false); assert.equal(probes, 3); assert.equal(launches, 1);
});

test('dead launch lock and stopped prior PID recover without stopping or overwriting any live owner', async t => {
  const options = await fixture(t); let launches = 0, previous, latest;
  const spawnAdapter = (_command, args) => {
    launches++;
    queueMicrotask(async () => {
      const handle = await runBackgroundWorkbench({ descriptorFile: args.at(-1), pluginRoot: options.pluginRoot, createService: async () => ({ getState: () => ({ project: { mainFile: 'main.tex' }, workspaceIndex: { currentRecord: options.record } }), openProject: async () => {}, prepareBackgroundBinding: async () => {}, startWatching() {}, close: async () => {} }), startWeb: async () => ({ url: `http://127.0.0.1:12345/#session=${'e'.repeat(43)}`, close: async () => {} }), registerSignals: false });
      if (!previous) previous = handle; else latest = handle; options.onCleanup(() => handle.close());
    });
    return { pid: process.pid, unref() {}, once() {} };
  };
  const first = await ensureBackgroundWorkbench({ ...options, spawnAdapter, probeAdapter: async () => true });
  const old = JSON.parse(await readFile(first.sessionFile, 'utf8')); await writeFile(first.sessionFile, JSON.stringify({ ...old, pid: 900000001 }));
  await writeFile(first.sessionFile.replace(/\.json$/u, '.lock'), JSON.stringify({ pid: 900000001, owner: 'a'.repeat(48) }));
  const second = await ensureBackgroundWorkbench({ ...options, spawnAdapter, probeAdapter: async () => true, isAlive: pid => pid === process.pid });
  assert.equal(second.reused, false); assert.equal(launches, 2); assert.ok(latest);
  const fresh = await readFile(second.sessionFile, 'utf8'); assert.notEqual(JSON.parse(fresh).owner, old.owner);
  await previous.close(); assert.equal(await readFile(second.sessionFile, 'utf8'), fresh);
});

test('real owned background service survives launcher exit and authenticated health stays tied to the same paper', { timeout: 15000 }, async t => {
  const options = { ...await fixture(t), timeoutMs: 5000 }, moduleUrl = pathToFileURL(path.join(root, 'src/background-workbench.mjs')).href;
  await writeFile(path.join(options.pluginRoot, 'dist/preview.html'), '<!doctype html><title>Synthetic background lifetime</title>');
  await writeFile(path.join(options.pluginRoot, 'dist/background-workbench.mjs'), `import {runBackgroundWorkbench} from ${JSON.stringify(moduleUrl)};\nawait runBackgroundWorkbench({descriptorFile:process.argv[3],pluginRoot:${JSON.stringify(options.pluginRoot)},createService:async options=>({getState:()=>({project:{id:'synthetic',mainFile:options.mainFile},workspaceIndex:{currentRecord:{projectRoot:options.workspace,mainFile:options.mainFile}}}),openProject:async()=>{},prepareBackgroundBinding:async()=>{},startWatching(){},close:async()=>{}})});setTimeout(()=>process.exit(0),10000).unref();`);
  const launcher = path.join(options.pluginRoot, 'synthetic-launcher.mjs');
  await writeFile(launcher, `import {ensureBackgroundWorkbench} from ${JSON.stringify(moduleUrl)};\nconst safe=await ensureBackgroundWorkbench(${JSON.stringify(options)});process.stdout.write(JSON.stringify(safe));`);
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [launcher], { windowsHide: true, timeout: 10000 });
  assert.equal(stderr, ''); const launched = JSON.parse(stdout); assert.equal(launched.mode, 'background-workbench'); assert.ok(!stdout.includes('session=')); assert.notEqual(launched.pid, process.pid);
  options.onCleanup(async () => { try { process.kill(launched.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } for (let i = 0; i < 100; i++) { try { process.kill(launched.pid, 0); } catch (error) { if (error.code === 'ESRCH') return; } await new Promise(resolve => setTimeout(resolve, 20)); } });
  const session = await readBackgroundSession({ ...options, sessionFile: launched.sessionFile });
  assert.equal(session.pid, launched.pid); assert.equal(session.threadId, options.binding.threadId);
  const reused = await ensureBackgroundWorkbench(options); assert.equal(reused.reused, true); assert.equal(reused.pid, launched.pid);
});

test('desktop shortcut uses its exact saved Desktop origin profile without opening a temporary paper or writer', async t => {
  const options = await fixture(t), url = `http://127.0.0.1:12345/#session=${'s'.repeat(43)}`; let closed = false, sentOptions, launched;
  const selected = { recordId: 'workspace-' + 'a'.repeat(32), ...options.record, hostTaskId: options.binding.threadId, ...options.binding, lastOpenedAt: '2026-10-25T12:00:00Z' }, older = { recordId: 'workspace-' + 'b'.repeat(32), ...options.record, lastOpenedAt: '2026-10-24T12:00:00Z' };
  const result = await openConfiguredWorkbench({ pluginRoot: options.pluginRoot, browser: process.execPath, createService: async input => {
    assert.equal(input.backgroundMode, true); assert.equal(input.workspace, null); assert.equal(input.mainFile, null); assert.equal(input.desktopViewerOnly, true); assert.equal(input.hostEnv.PAPER_EDITOR_WORKSPACE, undefined);
    return { listWorkspaces: async () => ({ records: [older, { ...selected, projectRoot: path.join(options.record.projectRoot, 'different') }, selected] }), openWorkspaceRecord: async () => { throw Error('preflight must never open a paper'); }, openProject: async () => { throw Error('must not register a duplicate unidentified-host task'); }, getState: () => ({ project: null, workspaceIndex: { currentRecord: null } }), close: async () => { closed = true; } };
  }, ensure: async input => { assert.equal(closed, true); sentOptions = input; return { pid: 123, mode: 'background-workbench', version: '0.6.0', reused: true, sessionFile: 'private-file', url: 'must-not-escape' }; }, readSession: async input => { assert.deepEqual(input, sentOptions); return { url }; }, launchWindow: async input => { launched = input; return { width: 1440, height: 900, x: 0, y: 0, requestedState: 'normal', privateCapability: url }; } });
  assert.equal(sentOptions.record, null); assert.equal(sentOptions.binding, null); assert.equal(sentOptions.launchId, selected.hostTaskId); assert.equal(sentOptions.originThreadId, selected.hostTaskId); assert.notEqual(sentOptions.viewerOnly, true);
  assert.deepEqual(launched, { url, dataRoot: options.dataRoot, browser: process.execPath }); assert.equal(result.independentWindow, true); assert.ok(!JSON.stringify(result).includes('session=')); assert.ok(!JSON.stringify(result).includes('must-not-escape')); assert.deepEqual(result.windowPlacement, { width: 1440, height: 900, x: 0, y: 0, requestedState: 'normal' });
});

test('shortcut NoOpen initializes only the selected background paper without reading a capability or opening a browser', async t => {
  const options = await fixture(t); let registered = false, closed = false;
  const recordId = 'workspace-' + 'c'.repeat(32);
  const result = await openConfiguredWorkbench({ pluginRoot: options.pluginRoot, noOpen: true, createService: async input => { assert.equal(input.desktopViewerOnly, true); return { registry: { records: async () => [], register: async record => { registered = true; assert.equal(record.projectRoot, options.record.projectRoot); assert.equal(record.mainFile, 'main.tex'); return { ...record, recordId }; } }, openProject: async () => { throw Error('preflight cannot open source or restore a chat'); }, close: async () => { closed = true; } }; }, ensure: async input => { assert.equal(closed, true); assert.equal(input.binding, null); assert.equal(input.viewerOnly, true); assert.equal(input.record.recordId, recordId); return { pid: 123, mode: 'background-workbench', reused: false, version: '0.6.0', sessionFile: 'private-file' }; }, readSession: async () => { throw Error('NoOpen must not read the capability'); }, launchWindow: async () => { throw Error('NoOpen must not launch a window'); } });
  assert.equal(registered, true); assert.equal(result.independentWindow, false); assert.equal(result.windowPlacement, null);
});


test('empty first-use background claims a task identity and never opens an installer paper or chat', async t=>{
  const fixtureOptions=await fixture(t),options={...fixtureOptions,record:null,binding:null,launchId:'first-use-paper-task'};let launched=0,handle;
  const result=await ensureBackgroundWorkbench({...options,probeAdapter:async()=>true,spawnAdapter:(_command,args)=>{launched++;queueMicrotask(async()=>{handle=await runBackgroundWorkbench({descriptorFile:args.at(-1),pluginRoot:options.pluginRoot,createService:async input=>{assert.equal(input.workspace,null);assert.equal(input.mainFile,null);assert.equal(input.backgroundBinding,null);assert.equal(input.hostEnv.PAPER_EDITOR_WORKSPACE,undefined);assert.equal(input.hostEnv.PAPER_EDITOR_MAIN_FILE,undefined);return{getState:()=>({project:null,workspaceIndex:{currentRecord:null}}),openProject:async()=>{throw Error('first-use must not open the installed paper');},startWatching(){},close:async()=>{}};},startWeb:async()=>({url:`http://127.0.0.1:12345/#session=${'n'.repeat(43)}`,close:async()=>{}}),registerSignals:false});options.onCleanup(()=>handle.close());});return{pid:process.pid,unref(){},once(){}};}});
  assert.equal(result.reused,false);assert.equal(launched,1);const session=await readBackgroundSession({...options,probeAdapter:async()=>true});assert.equal(session.projectRoot,null);assert.equal(session.launchId,options.launchId);
  await assert.rejects(readBackgroundSession({...options,launchId:'other-paper-task',sessionFile:result.sessionFile,probeAdapter:async()=>true}),{code:'BACKGROUND_SESSION_INVALID'});
});


test('task-bound empty service remains privately identifiable after an explicit project import', async t=>{
  const base=await fixture(t),options={...base,record:null,binding:null,launchId:'mutable-first-use-task'};
  let current={project:null,workspaceIndex:{currentRecord:null}},handle;
  const launched=await ensureBackgroundWorkbench({...options,spawnAdapter:(_command,args)=>{queueMicrotask(async()=>{handle=await runBackgroundWorkbench({descriptorFile:args.at(-1),pluginRoot:options.pluginRoot,createService:async()=>({getState:()=>structuredClone(current),startWatching(){},close:async()=>{}}),registerSignals:false});options.onCleanup(()=>handle.close());});return{pid:process.pid,unref(){},once(){}};}});
  const empty=await readBackgroundSession({...options,sessionFile:launched.sessionFile});assert.equal(empty.launchId,options.launchId);
  current={project:{id:'explicitly-imported-paper',mainFile:'imported.tex'},workspaceIndex:{currentRecord:{recordId:'imported-task-paper',projectRoot:base.record.projectRoot,mainFile:'imported.tex'}}};
  const imported=await readBackgroundSession({...options,sessionFile:launched.sessionFile});assert.equal(imported.owner,empty.owner);assert.equal(imported.pid,empty.pid);
  const record=JSON.parse(await readFile(launched.sessionFile,'utf8'));await writeFile(launched.sessionFile,JSON.stringify({...record,launchId:'other-native-task'}));await assert.rejects(readBackgroundSession({...options,sessionFile:launched.sessionFile}),{code:'BACKGROUND_SESSION_INVALID'});await writeFile(launched.sessionFile,JSON.stringify(record));
});


test('saved chat lease recovery does not prevent a healthy paper workbench from opening', async t=>{
  const options=await fixture(t);let descriptorFile,webService;
  await assert.rejects(ensureBackgroundWorkbench({...options,timeoutMs:20,spawnAdapter:(_command,args)=>{descriptorFile=args.at(-1);return{pid:process.pid,unref(){},once(){}};},probeAdapter:async()=>false}),{code:'BACKGROUND_NOT_READY'});
  const preserved={project:{id:'saved-paper',mainFile:'main.tex',snapshotId:'saved-version'},workspaceIndex:{currentRecord:options.record},nativeChatBinding:{kind:'background-chat-reference',projectId:'saved-paper',...options.binding},translations:{'zh-CN':{p:{text:'Retained draft',revision:7}}},reviewNotes:[{noteId:'saved-note'}]},connection={phase:'inactive',error:null};
  let prepares=0,closes=0;
  const service={backgroundConnection:connection,getState(){return{...structuredClone(preserved),nativeChatBindingError:this._nativeBindingError||null,backgroundConnection:{phase:connection.phase,error:connection.error,binding:preserved.nativeChatBinding,serviceOnline:true}};},openProject:async()=>{},prepareBackgroundBinding:async()=>{prepares++;throw Object.assign(Error('Existing chat lease needs explicit recovery.'),{code:'NATIVE_CHAT_LEASE_RECOVERY_REQUIRED'});},startWatching(){},close:async()=>{closes++;}};
  const handle=await runBackgroundWorkbench({descriptorFile,pluginRoot:options.pluginRoot,createService:async()=>service,startWeb:async input=>{webService=input.service;return{url:`http://127.0.0.1:12345/#session=${'r'.repeat(43)}`,close:async()=>{}};},registerSignals:false});options.onCleanup(()=>handle.close());
  const state=webService.getState();assert.equal(prepares,1);assert.equal(closes,0);assert.deepEqual(state.project,preserved.project);assert.deepEqual(state.translations,preserved.translations);assert.deepEqual(state.reviewNotes,preserved.reviewNotes);assert.deepEqual(state.nativeChatBinding,preserved.nativeChatBinding);assert.equal(state.nativeChatBindingError.code,'NATIVE_CHAT_LEASE_RECOVERY_REQUIRED');assert.equal(state.backgroundConnection.phase,'failed');assert.equal(state.backgroundConnection.error.code,'NATIVE_CHAT_LEASE_RECOVERY_REQUIRED');
  const session=await readBackgroundSession({...options,probeAdapter:async()=>true});assert.equal(session.threadId,options.binding.threadId);
});


test('offline saved chat never bypasses missing capability, chat mismatch or paper identity checks', async t=>{
  for(const kind of ['missing-capability','wrong-chat','wrong-paper']){
    const options=await fixture(t);let descriptorFile,webStarts=0,closes=0;
    await assert.rejects(ensureBackgroundWorkbench({...options,timeoutMs:20,spawnAdapter:(_command,args)=>{descriptorFile=args.at(-1);return{pid:process.pid,unref(){},once(){}};},probeAdapter:async()=>false}),{code:'BACKGROUND_NOT_READY'});
    const service={getState:()=>({project:{mainFile:kind==='wrong-paper'?'other.tex':'main.tex'},workspaceIndex:{currentRecord:options.record}}),openProject:async()=>{},close:async()=>{closes++;}};
    if(kind!=='missing-capability')service.prepareBackgroundBinding=async()=>{throw Object.assign(Error('Existing saved identity unavailable.'),{code:kind==='wrong-chat'?'THREAD_MISMATCH':'NATIVE_CHAT_LEASE_RECOVERY_REQUIRED'});};
    await assert.rejects(runBackgroundWorkbench({descriptorFile,pluginRoot:options.pluginRoot,createService:async()=>service,startWeb:async()=>{webStarts++;},registerSignals:false}),{code:kind==='missing-capability'?'BACKGROUND_BINDING_UNAVAILABLE':kind==='wrong-chat'?'THREAD_MISMATCH':'BACKGROUND_PROJECT_MISMATCH'});
    assert.equal(webStarts,0);assert.equal(closes,1);
  }
});

async function signedFirstUseDescriptor(t, originThreadId = 'synthetic-saved-origin', project = null) {
  const base = await fixture(t), hostProject = project === true ? { projectRoot: base.record.projectRoot, source: 'native-launch-cwd', hostProjectId: null, autoOpen: true } : project, options = { ...base, record: null, binding: null, launchId: originThreadId, originThreadId, ...(hostProject ? { hostProject } : {}) }; let descriptorFile;
  await assert.rejects(ensureBackgroundWorkbench({ ...options, timeoutMs: 20, spawnAdapter: (_command, args) => { descriptorFile = args.at(-1); return { pid: process.pid, unref() {}, once() {} }; }, probeAdapter: async () => false }), { code: 'BACKGROUND_NOT_READY' });
  return { options, descriptorFile };
}

test('a signed current chat project bootstraps a unique main only when this exact task has no compatible saved record', async t => {
  const { options, descriptorFile } = await signedFirstUseDescriptor(t, 'synthetic-new-project-task', true); let current = null, bootstraps = 0;
  const service = { hostContext: {}, async listWorkspaces() { return { records: [] }; }, async bootstrapHostProject() { bootstraps++; assert.equal(this.hostContext.projectRoot, options.hostProject.projectRoot); assert.equal(this.hostContext.native, false); assert.equal(this.hostContext.hostTaskId, options.originThreadId); current = { project: { id: 'new-current-project', mainFile: 'main.tex' }, workspaceIndex: { currentRecord: { hostTaskId: options.originThreadId, projectRoot: options.hostProject.projectRoot, mainFile: 'main.tex' } } }; }, getState: () => current || { project: null, workspaceIndex: { currentRecord: null } }, startWatching() {}, async close() {} };
  const handle = await runBackgroundWorkbench({ descriptorFile, pluginRoot: options.pluginRoot, createService: async () => service, startWeb: async () => ({ url: `http://127.0.0.1:12345/#session=${'h'.repeat(43)}`, async close() {} }), registerSignals: false }); options.onCleanup(() => handle.close());
  assert.equal(bootstraps, 1); assert.equal(service.getState().project.id, 'new-current-project');
});

test('saved imported copies match their declared invoking project rather than their private paper root', async t => {
  const { options, descriptorFile } = await signedFirstUseDescriptor(t, 'synthetic-private-import-task', true), saved = { recordId: 'workspace-' + 'b'.repeat(32), hostTaskId: options.originThreadId, hostProjectRoot: options.hostProject.projectRoot, projectRoot: options.pluginRoot, mainFile: 'saved.tex', lastOpenedAt: '2026-10-25T12:00:00Z' };
  const stale = { ...saved, recordId: 'workspace-' + 'a'.repeat(32), hostProjectRoot: options.pluginRoot, lastOpenedAt: '2030-10-25T12:00:00Z' }; let current = null;
  const service = { hostContext: {}, listWorkspaces: async () => ({ records: [stale, saved] }), async openWorkspaceRecord({ recordId }) { assert.equal(recordId, saved.recordId); current = { project: { mainFile: saved.mainFile }, workspaceIndex: { currentRecord: saved } }; }, async bootstrapHostProject() { throw Error('The compatible private paper must be restored.'); }, getState: () => current || { project: null, workspaceIndex: { currentRecord: null } }, startWatching() {}, async close() {} };
  const handle = await runBackgroundWorkbench({ descriptorFile, pluginRoot: options.pluginRoot, createService: async () => service, startWeb: async () => ({ url: `http://127.0.0.1:12345/#session=${'j'.repeat(43)}`, async close() {} }), registerSignals: false }); options.onCleanup(() => handle.close());
  assert.equal(service.getState().workspaceIndex.currentRecord.recordId, saved.recordId);
});

test('enriching an existing task with a current host project reuses its exact background owner and private session', async t => {
  const { options, descriptorFile } = await signedFirstUseDescriptor(t, 'synthetic-enriched-task');
  const service = { hostContext: {}, listWorkspaces: async () => ({ records: [] }), getState: () => ({ project: null, workspaceIndex: { currentRecord: null } }), startWatching() {}, async close() {} };
  const handle = await runBackgroundWorkbench({ descriptorFile, pluginRoot: options.pluginRoot, createService: async () => service, startWeb: async () => ({ url: `http://127.0.0.1:12345/#session=${'k'.repeat(43)}`, async close() {} }), registerSignals: false }); options.onCleanup(() => handle.close());
  let spawns = 0; const enriched = await ensureBackgroundWorkbench({ ...options, hostProject: { projectRoot: options.record?.projectRoot || path.join(path.dirname(options.pluginRoot), 'paper'), source: 'native-launch-cwd', hostProjectId: null, autoOpen: true }, probeAdapter: async () => true, spawnAdapter: () => { spawns++; throw Error('Enrichment must not create a second task daemon.'); } });
  assert.equal(enriched.reused, true); assert.equal(enriched.sessionFile, handle.sessionFile); assert.equal(spawns, 0);
});

test('one-use signed refresh reuses its task owner, bootstraps after failed import, and changes logical projects without copying private history', async t => {
  const { options, descriptorFile } = await signedFirstUseDescriptor(t, 'synthetic-refresh-task'); let refresh;
  const firstRoot = path.join(path.dirname(options.pluginRoot), 'paper'), secondRoot = path.join(path.dirname(options.pluginRoot), 'second-paper'); await mkdir(secondRoot); await writeFile(path.join(secondRoot, 'main.tex'), '\\documentclass{article}\\begin{document}Second project.\\end{document}');
  const codexRoot = path.join(path.dirname(options.pluginRoot), 'chat');
  const factory = record => new PaperApplication({ dataRoot: record?.stateRoot || options.dataRoot });
  const service = new WorkspaceService({ initialApp: factory(), factory, dataRoot: options.dataRoot, codexRoot, hostOptions: { native: false, cwd: options.pluginRoot, env: {} } }); await service.initializeWorkspace();
  await writeFile(path.join(options.pluginRoot, 'dist/preview.html'), '<!doctype html><title>Synthetic signed host refresh</title>');
  const handle = await runBackgroundWorkbench({ descriptorFile, pluginRoot: options.pluginRoot, createService: async () => service, startWeb: async input => { const web = await startLocalWeb(input), url = new URL(web.url); refresh = async proof => { const result = await fetch(url.origin + '/api', { method: 'POST', headers: { Origin: url.origin, Authorization: 'Bearer ' + url.hash.slice(9), 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'syncHostProject', payload: proof }) }).then(response => response.json()); if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code }); return result.result; }; return web; }, registerSignals: false }); options.onCleanup(() => handle.close());
  const session = await readBackgroundSession({ ...options, probeAdapter: async () => true }), hint = projectRoot => ({ projectRoot, source: 'native-launch-cwd', hostProjectId: null, autoOpen: true });
  await assert.rejects(refresh({ hostProject: hint(firstRoot) }), { code: 'BACKGROUND_HANDOFF_INVALID' });
  const first = await signHostProjectRefresh({ ...options, hostProject: hint(firstRoot) }, session), tampered = structuredClone(first); tampered.payload.hostProject.projectRoot = secondRoot;
  await assert.rejects(dispatchUi(service, 'syncHostProject', first), { code: 'INVALID_INPUT' });
  await assert.rejects(refresh(tampered), { code: 'BACKGROUND_HANDOFF_INVALID' }); await refresh(first); const firstRecord = service.getState().workspaceIndex.currentRecordId;
  await assert.rejects(refresh(first), { code: 'BACKGROUND_HANDOFF_REPLAY' });
  const paragraph = service.getState().readingParagraphs.find(p => p.requestable); await service.saveDraft({ segmentId: paragraph.id, language: 'zh-CN', expectedRevision: 0, text: 'Private saved draft.' });
  const again = await signHostProjectRefresh({ ...options, hostProject: hint(firstRoot) }, session); await refresh(again); assert.equal(service.getState().workspaceIndex.currentRecordId, firstRecord); assert.equal(service.getState().translations['zh-CN'][paragraph.id].text, 'Private saved draft.');
  service.active._pendingOps = 1; const busy = await signHostProjectRefresh({ ...options, hostProject: hint(secondRoot) }, session); await assert.rejects(refresh(busy), { code: 'PROJECT_BUSY' }); service.active._pendingOps = 0; assert.equal(service.getState().workspaceIndex.currentRecordId, firstRecord);
  await refresh(await signHostProjectRefresh({ ...options, hostProject: hint(secondRoot) }, session)); assert.equal(service.getProjectRoot(), secondRoot); assert.notEqual(service.getState().workspaceIndex.currentRecordId, firstRecord); assert.equal(service.getState().translations['zh-CN']?.[paragraph.id], undefined);
  await refresh(await signHostProjectRefresh({ ...options, hostProject: hint(firstRoot) }, session)); assert.equal(service.getState().workspaceIndex.currentRecordId, firstRecord); assert.equal(service.getState().translations['zh-CN'][paragraph.id].text, 'Private saved draft.');
  assert.equal((await service.listWorkspaces()).records.length, 2); assert.equal((await readBackgroundSession({ ...options, hostProject: hint(secondRoot), probeAdapter: async () => true })).owner, session.owner);
});

test('a restarted signed Desktop task restores only its newest exact host record before web readiness', async t => {
  const { options, descriptorFile } = await signedFirstUseDescriptor(t), events = [], record = suffix => ({ recordId: 'workspace-' + suffix.repeat(32), hostTaskId: options.originThreadId, projectRoot: options.pluginRoot, mainFile: 'saved.tex', lastOpenedAt: '2026-10-24T12:00:00Z' });
  const old = record('a'), latest = { ...record('b'), lastOpenedAt: '2026-10-25T12:00:00Z' }, foreign = { ...record('c'), hostTaskId: 'foreign-chat', lastOpenedAt: '2030-10-25T12:00:00Z' }, unidentified = { ...record('d'), hostTaskId: null, threadId: options.originThreadId, lastOpenedAt: '2031-10-25T12:00:00Z' };
  let current = { project: null, workspaceIndex: { currentRecord: null } };
  const service = { hostContext: {}, async listWorkspaces() { events.push('list'); return { records: [foreign, old, unidentified, latest] }; }, async openWorkspaceRecord(input) { events.push(input.recordId); assert.deepEqual(input, { recordId: latest.recordId }); current = { project: { id: 'saved-project', mainFile: latest.mainFile }, workspaceIndex: { currentRecord: latest }, translations: { 'zh-CN': { retained: { text: 'Retained synthetic draft.', revision: 9 } } } }; }, async openProject() { throw Error('Restoration must use the known record identity, not source paths.'); }, getState: () => structuredClone(current), startWatching() { events.push('watch'); }, async close() {} };
  const handle = await runBackgroundWorkbench({ descriptorFile, pluginRoot: options.pluginRoot, createService: async input => { assert.equal(input.workspace, null); assert.equal(input.mainFile, null); return service; }, startWeb: async ({ service: facade }) => { events.push('web'); assert.equal(facade.getState().workspaceIndex.currentRecord.recordId, latest.recordId); assert.equal(facade.getState().translations['zh-CN'].retained.revision, 9); return { url: `http://127.0.0.1:12345/#session=${'v'.repeat(43)}`, async close() {} }; }, registerSignals: false }); options.onCleanup(() => handle.close());
  assert.deepEqual(events, ['list', latest.recordId, 'watch', 'web']);
  const session = await readBackgroundSession({ ...options, probeAdapter: async () => true }); assert.equal(session.launchId, options.launchId); assert.equal(session.projectRoot, null); assert.equal(session.originThreadId, options.originThreadId);
});

test('a cold chat restores its last explicitly selected legacy paper from the bounded authorized record pool', async t => {
  const { options, descriptorFile } = await signedFirstUseDescriptor(t, 'synthetic-bound-chat-b', true), chosen = { recordId: 'workspace-' + 'a'.repeat(32), hostTaskId: 'legacy-host-a', threadId: options.originThreadId, projectRoot: options.pluginRoot, mainFile: 'chosen.tex', lastOpenedAt: '2031-10-24T12:00:00Z' }, newer = { ...chosen, recordId: 'workspace-' + 'b'.repeat(32), hostTaskId: options.originThreadId, mainFile: 'newer.tex', lastOpenedAt: '2030-10-25T12:00:00Z' };
  let current = null; const selection = { threadId: options.originThreadId, recordId: chosen.recordId, hostProjectRoot: options.hostProject.projectRoot, selectedAt: '2026-10-26T00:00:00Z' };
  const service = { hostContext: {}, listWorkspaces: async () => ({ records: [newer, chosen], chatSelection: selection }), async openWorkspaceRecord({ recordId }) { assert.equal(recordId, chosen.recordId); current = { project: { mainFile: chosen.mainFile }, workspaceIndex: { currentRecord: chosen }, translations: { fr: { retained: { revision: 7 } } } }; }, async bootstrapHostProject() { throw Error('An exact explicit selection must not be substituted.'); }, getState: () => current || { project: null, workspaceIndex: { currentRecord: null } }, startWatching() {}, async close() {} };
  const handle = await runBackgroundWorkbench({ descriptorFile, pluginRoot: options.pluginRoot, createService: async () => service, startWeb: async () => ({ url: `http://127.0.0.1:12345/#session=${'m'.repeat(43)}`, async close() {} }), registerSignals: false }); options.onCleanup(() => handle.close());
  assert.equal(service.getState().workspaceIndex.currentRecord.recordId, chosen.recordId); assert.equal(service.getState().translations.fr.retained.revision, 7);
});

test('a newer source import in this exact chat supersedes its older explicit legacy selection without admitting foreign history', async t => {
  const { options, descriptorFile } = await signedFirstUseDescriptor(t, 'synthetic-new-import-chat', true), old = { recordId: 'workspace-' + 'a'.repeat(32), hostTaskId: 'legacy-host-a', threadId: options.originThreadId, projectRoot: options.pluginRoot, mainFile: 'old.tex', lastOpenedAt: '2026-10-24T12:00:00Z' }, latest = { ...old, recordId: 'workspace-' + 'b'.repeat(32), hostTaskId: options.originThreadId, mainFile: 'latest.tex', hostProjectRoot: options.hostProject.projectRoot, lastOpenedAt: '2026-10-26T12:00:00Z' }, foreign = { ...latest, recordId: 'workspace-' + 'c'.repeat(32), hostTaskId: 'foreign-task', lastOpenedAt: '2030-10-26T12:00:00Z' };
  let current = null; const service = { hostContext: {}, listWorkspaces: async () => ({ records: [old, foreign, latest], chatSelection: { threadId: options.originThreadId, recordId: old.recordId, hostProjectRoot: options.hostProject.projectRoot } }), async openWorkspaceRecord({ recordId }) { assert.equal(recordId, latest.recordId); current = { project: { mainFile: latest.mainFile }, workspaceIndex: { currentRecord: latest } }; }, getState: () => current || { project: null, workspaceIndex: { currentRecord: null } }, startWatching() {}, async close() {} };
  const handle = await runBackgroundWorkbench({ descriptorFile, pluginRoot: options.pluginRoot, createService: async () => service, startWeb: async () => ({ url: `http://127.0.0.1:12345/#session=${'n'.repeat(43)}`, async close() {} }), registerSignals: false }); options.onCleanup(() => handle.close()); assert.equal(service.getState().workspaceIndex.currentRecord.recordId, latest.recordId);
});

test('signed window preparation changes no ownership until the arriving page acknowledges its one-use navigation nonce', async t => {
  const { options, descriptorFile } = await signedFirstUseDescriptor(t, 'synthetic-handoff-chat-b', true), record = { recordId: 'workspace-' + 'a'.repeat(32), hostTaskId: options.originThreadId, threadId: options.originThreadId, projectRoot: options.hostProject.projectRoot, mainFile: 'main.tex', lastOpenedAt: '2026-10-26T00:00:00Z' }; let current = false, web, transfers = 0, conflict = false, gate = null, transferResult = { reassigned: true };
  const state = () => ({ project: current ? { id: 'paper-b', mainFile: 'main.tex', snapshotId: 'snap-b' } : null, workspaceIndex: { currentRecordId: current ? record.recordId : null, currentRecord: current ? record : null }, desktopExecution: { available: true, threadId: options.originThreadId } });
  const service = { hostContext: {}, listWorkspaces: async () => ({ records: [record] }), async openWorkspaceRecord() { current = true; }, getState: state, _assertIdle() {}, startWatching() {}, async close() {} };
  await writeFile(path.join(options.pluginRoot, 'dist/preview.html'), '<!doctype html><title>Synthetic arriving page</title>');
  const handle = await runBackgroundWorkbench({ descriptorFile, pluginRoot: options.pluginRoot, createService: async () => service, startWeb: async input => { web = await startLocalWeb(input); return web; }, transferProjectWindow: async input => { assert(!input.toUrl.includes('handoff=')); transfers++; if (gate) await gate; if (conflict) throw Object.assign(Error('Another target window is live.'), { code: 'PROJECT_WINDOW_ALREADY_OPEN' }); return transferResult; }, registerSignals: false }); options.onCleanup(() => handle.close());
  const target = await readBackgroundSession({ ...options, probeAdapter: async () => true }), source = { key: 'b'.repeat(32), owner: 'c'.repeat(48), url: `http://127.0.0.1:23456/#session=${'r'.repeat(43)}` }, url = new URL(web.url);
  const api = async (action, payload) => fetch(url.origin + '/api', { method: 'POST', headers: { Origin: url.origin, Authorization: 'Bearer ' + url.hash.slice(9), 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload }) }).then(response => response.json());
  const proof = await signProjectWindowHandoff(options, target, { sourceSession: source, recordId: record.recordId, snapshotId: 'snap-b' }), tampered = structuredClone(proof); tampered.payload.source.url = source.url.replace('23456', '34567');
  assert.equal((await api('prepareProjectWindowHandoff', tampered)).error.code, 'BACKGROUND_HANDOFF_INVALID'); assert.equal(transfers, 0);
  const prepared = await api('prepareProjectWindowHandoff', proof); assert.equal(prepared.ok, true); assert.equal(transfers, 0); assert.equal((await api('prepareProjectWindowHandoff', proof)).error.code, 'BACKGROUND_HANDOFF_REPLAY');
  const acknowledged = await api('ackProjectWindow', { handoffId: prepared.result.handoffId }); assert.equal(acknowledged.result.acknowledged, true); assert.equal(transfers, 1); assert.equal((await api('ackProjectWindow', { handoffId: prepared.result.handoffId })).result.acknowledged, true); assert.equal(transfers, 1);
  conflict = true; const second = await api('prepareProjectWindowHandoff', await signProjectWindowHandoff(options, target, { sourceSession: source, recordId: record.recordId, snapshotId: 'snap-b' })); const rejected = await api('ackProjectWindow', { handoffId: second.result.handoffId }); assert.equal(rejected.result.acknowledged, false); assert.equal(rejected.result.code, 'PROJECT_WINDOW_ALREADY_OPEN'); assert.equal(rejected.result.returnUrl, source.url); assert.equal(transfers, 2);
  conflict = false; let release; gate = new Promise(resolve => { release = resolve; }); const third = await api('prepareProjectWindowHandoff', await signProjectWindowHandoff(options, target, { sourceSession: source, recordId: record.recordId, snapshotId: 'snap-b' })); const firstAck = api('ackProjectWindow', { handoffId: third.result.handoffId });
  for (let attempt = 0; transfers < 3 && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5)); const duplicateAck = api('ackProjectWindow', { handoffId: third.result.handoffId }); release(); const repeated = await Promise.all([firstAck, duplicateAck]); assert(repeated.every(result => result.result.acknowledged)); assert.equal(transfers, 3); gate = null;
  transferResult = { reassigned: false, reason: 'not-registered' }; const fourth = await api('prepareProjectWindowHandoff', await signProjectWindowHandoff(options, target, { sourceSession: source, recordId: record.recordId, snapshotId: 'snap-b' })); const unverified = await api('ackProjectWindow', { handoffId: fourth.result.handoffId }); assert.equal(unverified.result.acknowledged, false); assert.equal(unverified.result.code, 'PROJECT_WINDOW_HANDOFF_UNVERIFIED'); assert.equal(unverified.result.returnUrl, source.url);
  assert(!JSON.stringify(state()).includes(source.url)); await assert.rejects(dispatchUi(service, 'ackProjectWindow', { handoffId: proof.payload.nonce }), { code: 'INVALID_INPUT' });
});

test('a signed task with no exact saved host record stays empty instead of inheriting installer or foreign history', async t => {
  const { options, descriptorFile } = await signedFirstUseDescriptor(t); let opens = 0, webStarts = 0;
  const service = { hostContext: {}, listWorkspaces: async () => ({ records: [{ recordId: 'workspace-' + 'a'.repeat(32), hostTaskId: 'foreign-chat', threadId: options.originThreadId, lastOpenedAt: '2030-01-01T00:00:00Z' }, { recordId: 'workspace-' + 'b'.repeat(32), hostTaskId: null, threadId: options.originThreadId, lastOpenedAt: '2031-01-01T00:00:00Z' }] }), async openWorkspaceRecord() { opens++; }, getState: () => ({ project: null, workspaceIndex: { currentRecord: null } }), startWatching() {}, async close() {} };
  const handle = await runBackgroundWorkbench({ descriptorFile, pluginRoot: options.pluginRoot, createService: async () => service, startWeb: async ({ service: facade }) => { webStarts++; assert.equal(facade.getState().project, null); return { url: `http://127.0.0.1:12345/#session=${'w'.repeat(43)}`, async close() {} }; }, registerSignals: false }); options.onCleanup(() => handle.close());
  assert.equal(opens, 0); assert.equal(webStarts, 1);
});

test('a missing saved paper leaves its record intact and opens an empty workbench with an honest restore diagnostic', async t => {
  const { options, descriptorFile } = await signedFirstUseDescriptor(t), saved = { recordId: 'workspace-' + 'a'.repeat(32), hostTaskId: options.originThreadId, projectRoot: options.pluginRoot, mainFile: 'missing.tex', lastOpenedAt: '2026-10-25T12:00:00Z', available: false }, records = [saved]; let opens = 0;
  const service = { hostContext: {}, bootstrap: { status: 'workspace-required', mainCandidates: [] }, listWorkspaces: async () => ({ records: structuredClone(records) }), async openWorkspaceRecord() { opens++; throw Object.assign(Error('The selected original is no longer present.'), { code: 'ENOENT' }); }, getState() { return { project: null, workspaceIndex: { currentRecord: null, bootstrap: structuredClone(this.bootstrap) } }; }, startWatching() {}, async close() {} };
  const handle = await runBackgroundWorkbench({ descriptorFile, pluginRoot: options.pluginRoot, createService: async () => service, startWeb: async ({ service: facade }) => { const state = facade.getState(); assert.equal(state.project, null); assert.equal(state.workspaceIndex.bootstrap.diagnostic.code, 'HOST_WORKSPACE_RESTORE_UNAVAILABLE'); assert.equal(state.workspaceIndex.bootstrap.diagnostic.causeCode, 'ENOENT'); assert.equal(state.workspaceIndex.bootstrap.diagnostic.recordId, saved.recordId); return { url: `http://127.0.0.1:12345/#session=${'x'.repeat(43)}`, async close() {} }; }, registerSignals: false }); options.onCleanup(() => handle.close());
  assert.equal(opens, 1); assert.deepEqual(records, [saved]);
});

test('saved host identity errors are never swallowed or replaced by an older record', async t => {
  const { options, descriptorFile } = await signedFirstUseDescriptor(t), record = { recordId: 'workspace-' + 'a'.repeat(32), hostTaskId: options.originThreadId, projectRoot: options.pluginRoot, mainFile: 'saved.tex', lastOpenedAt: '2026-10-25T12:00:00Z' }; let opens = 0, webStarts = 0;
  const service = { hostContext: {}, listWorkspaces: async () => ({ records: [record] }), async openWorkspaceRecord() { opens++; throw Object.assign(Error('The saved root identity changed.'), { code: 'WORKSPACE_RECORD_CHANGED' }); }, getState: () => ({ project: null, workspaceIndex: { currentRecord: null } }), async close() {} };
  await assert.rejects(runBackgroundWorkbench({ descriptorFile, pluginRoot: options.pluginRoot, createService: async () => service, startWeb: async () => { webStarts++; }, registerSignals: false }), { code: 'WORKSPACE_RECORD_CHANGED' }); assert.equal(opens, 1); assert.equal(webStarts, 0);
});

test('shortcut legacy and deliberately different saved chats open as viewers without replacing a binding', async t => {
  for (const hostTaskId of [null, 'different-origin']) {
    const options = await fixture(t), saved = { ...options.record, recordId: 'workspace-' + 'f'.repeat(32), hostTaskId, threadId: options.binding.threadId, lastOpenedAt: '2026-10-25T12:00:00Z' }; let closed = false;
    await openConfiguredWorkbench({ pluginRoot: options.pluginRoot, noOpen: true, createService: async input => { assert.equal(input.desktopViewerOnly, true); assert.equal(input.workspace, null); return { listWorkspaces: async () => ({ records: [saved] }), openWorkspaceRecord: async () => { throw Error('viewer preflight cannot load the saved chat'); }, close: async () => { closed = true; } }; }, ensure: async input => { assert.equal(closed, true); assert.equal(input.viewerOnly, true); assert.equal(input.binding, null); assert.equal(input.originThreadId, undefined); assert.equal(input.record.recordId, saved.recordId); return { pid: 123 }; } });
  }
});

test('signed viewer profiles are distinct and initialize the runtime without model ownership', async t => {
  const options = { ...await fixture(t), binding: null, viewerOnly: true }; let descriptorFile, factoryInput;
  await assert.rejects(ensureBackgroundWorkbench({ ...options, viewerOnly: 'true' }), { code: 'BACKGROUND_CONFIG_INVALID' });
  await assert.rejects(ensureBackgroundWorkbench({ ...options, timeoutMs: 20, spawnAdapter: (_command, args) => { descriptorFile = args.at(-1); return { pid: process.pid, unref() {}, once() {} }; }, probeAdapter: async () => false }), { code: 'BACKGROUND_NOT_READY' });
  const handle = await runBackgroundWorkbench({ descriptorFile, pluginRoot: options.pluginRoot, createService: async input => { factoryInput = input; return { getState: () => ({ project: { mainFile: 'main.tex' }, workspaceIndex: { currentRecord: options.record } }), async openProject() {}, async close() {} }; }, startWeb: async ({ service }) => { assert.equal(service.getState().backgroundLifecycle.viewerOnly, true); return { url: `http://127.0.0.1:12345/#session=${'y'.repeat(43)}`, async close() {} }; }, registerSignals: false }); options.onCleanup(() => handle.close());
  assert.equal(factoryInput.desktopViewerOnly, true); const session = await readBackgroundSession({ ...options, probeAdapter: async () => true }); assert.equal(session.viewerOnly, true);
  await assert.rejects(readBackgroundSession({ ...options, viewerOnly: false, sessionFile: handle.sessionFile, probeAdapter: async () => true }), { code: 'BACKGROUND_SESSION_INVALID' });
});

test('runtime viewer mode preserves a saved different chat without restoring even a temporary bound client', async t => {
  const options = await fixture(t), runtimeOptions = { dataRoot: options.dataRoot, codexRoot: path.join(options.dataRoot, 'codex'), compilerRoot: path.join(options.dataRoot, 'missing-compiler'), command: 'must-not-run-codex', workspace: null, mainFile: null, cwd: options.pluginRoot, hostEnv: {}, backgroundMode: true, desktopViewerOnly: true };
  const first = await createApplication(runtimeOptions); options.onCleanup(() => first.close()); await first.openProject({ root: options.record.projectRoot, mainFile: 'main.tex' });
  const projectId = first.getState().project.id;
  await first.active._flowAction(() => { first.active.flow.nativeChatBinding = { kind: 'bound-existing-chat', projectId, threadId: 'deliberately-saved-chat', model: 'gpt-6-astra', effort: 'max' }; }); await first.close();
  const second = await createApplication(runtimeOptions); options.onCleanup(() => second.close()); await second.openProject({ root: options.record.projectRoot, mainFile: 'main.tex' });
  assert.equal(second.active.desktopExecutionEnabled, true); assert.equal(second.active.chat.getState().mode, 'dedicated-codex-chat'); assert.equal(second.getState().nativeChatBinding.threadId, 'deliberately-saved-chat'); assert.equal(second.getState().nativeChatBindingError.code, 'LEGACY_VIEWER_ONLY');
  await assert.rejects(second.active.createBoundChat('deliberately-saved-chat', { model: 'gpt-6-astra', effort: 'max' }), { code: 'DESKTOP_EXECUTION_REQUIRED' });
});

test('restored Desktop tasks wait boundedly for origin verification before exposing callback readiness', async t => {
  for (const mode of ['ready', 'timeout', 'security']) {
    const { options, descriptorFile } = await signedFirstUseDescriptor(t), saved = { projectRoot: path.join(path.dirname(options.pluginRoot), 'paper'), mainFile: 'main.tex', recordId: 'workspace-' + 'a'.repeat(32), hostTaskId: options.originThreadId, lastOpenedAt: '2026-10-25T12:00:00Z' }; let opened = false, reconciled = false, webStarts = 0;
    const service = { hostContext: {}, bootstrap: {}, originChat: { async reconcile() { assert.equal(opened, true); if (mode === 'timeout') return new Promise(() => {}); await new Promise(resolve => setTimeout(resolve, 5)); reconciled = true; return { threadId: options.originThreadId, phase: mode === 'security' ? 'failed' : 'desktop-ready', ...(mode === 'security' ? { error: { code: 'THREAD_MISMATCH', message: 'The verified identity differs.' } } : {}) }; } }, listWorkspaces: async () => ({ records: [saved] }), async openWorkspaceRecord() { opened = true; }, getState() { return { project: opened ? { id: 'saved-paper', mainFile: 'main.tex' } : null, workspaceIndex: { currentRecord: opened ? saved : null, bootstrap: structuredClone(this.bootstrap) } }; }, startWatching() {}, async close() {} };
    const start = () => runBackgroundWorkbench({ descriptorFile, pluginRoot: options.pluginRoot, originReadyTimeoutMs: mode === 'timeout' ? 20 : 1000, createService: async () => service, startWeb: async ({ service: facade }) => { webStarts++; if (mode === 'ready') assert.equal(reconciled, true); if (mode === 'timeout') assert.equal(facade.getState().workspaceIndex.bootstrap.diagnostic.code, 'ORIGIN_CHAT_NOT_READY'); return { url: `http://127.0.0.1:12345/#session=${'z'.repeat(43)}`, async close() {} }; }, registerSignals: false });
    if (mode === 'security') { await assert.rejects(start(), { code: 'THREAD_MISMATCH' }); assert.equal(webStarts, 0); }
    else { const handle = await start(); options.onCleanup(() => handle.close()); assert.equal(webStarts, 1); }
  }
});
