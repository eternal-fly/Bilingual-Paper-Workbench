import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveHostContext, discoverMainFiles } from '../src/host-context.mjs';
import { TaskRegistry } from '../src/task-registry.mjs';
import { WorkspaceService } from '../src/workspace-service.mjs';
import { PaperApplication } from '../src/application.mjs';

const owned = fileURLToPath(new URL('../work/workspace-registry-tests/', import.meta.url));
const sourceText = '\\documentclass{article}\n\\begin{document}\n\nA precise synthetic claim needs explicit assumptions.\n\n\\end{document}\n';
async function fixture(t) {
  await mkdir(owned, { recursive: true }); const root = await mkdtemp(path.join(owned, 'case-'));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(owned) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  for (const folder of [first, second]) { await mkdir(folder); await writeFile(path.join(folder, 'main.tex'), sourceText); }
  return { root, first, second, dataRoot: path.join(root, 'private'), codexRoot: path.join(root, 'chat') };
}
function chat() {
  const value = new EventEmitter(); value.state = { connected: false, busy: false, threadId: null, model: null, effort: null, messages: [] };
  value.getState = () => structuredClone(value.state); value.close = async () => { value.closed = true; }; return value;
}
async function controller(f, options = {}) {
  const factory = async record => new PaperApplication({ dataRoot: record?.stateRoot || f.dataRoot, chat: chat() });
  const service = new WorkspaceService({ initialApp: new PaperApplication({ dataRoot: f.dataRoot, chat: chat() }), factory, dataRoot: f.dataRoot, codexRoot: f.codexRoot, hostOptions: { native: false, ...options } });
  await service.initializeWorkspace(); return service;
}

test('host roots supersede installer binding and unknown metadata never supplies a task identity', async t => {
  const f = await fixture(t);
  const options = { native: true, cwd: f.second, env: { CODEX_THREAD_ID: 'native-task-a' }, explicitWorkspace: f.first, explicitMainFile: 'main.tex' };
  const context = await resolveHostContext({ ...options, roots: [{ uri: pathToFileURL(f.second).href, name: 'Current host project' }] });
  assert.equal(context.projectRoot, f.second); assert.equal(context.source, 'mcp-roots'); assert.equal(context.hostTaskId, 'native-task-a'); assert.equal(context.explicitMainFile, null);
  assert.equal((await resolveHostContext({ ...options, roots: [] })).projectRoot, null);
  assert.equal((await resolveHostContext({ ...options, roots: [{ uri: 'https://example.invalid/private' }] })).projectRoot, null);
  const multiple = await resolveHostContext({ ...options, roots: [{ uri: pathToFileURL(f.first).href }, { uri: pathToFileURL(f.second).href }] });
  assert.equal(multiple.projectRoot, null); assert.equal(multiple.roots.length, 2);
  const standalone = await resolveHostContext({ ...options, native: false });
  assert.equal(standalone.hostTaskId, null); assert.equal(standalone.taskIdAvailable, false); assert.equal(standalone.projectRoot, f.first);
  const noIdentity = await resolveHostContext({ ...options, env: { CODEX_SESSION_ID: 'session-is-not-a-native-task' } });
  assert.equal(noIdentity.hostTaskId, null); assert.equal(noIdentity.source, 'native-launch-cwd');
});

test('records capture the invoking host project independently of a private imported paper root and preserve legacy identity', async t => {
  const f = await fixture(t), registry = new TaskRegistry(f), first = await registry.register({ projectRoot: f.first, mainFile: 'main.tex', hostTaskId: 'task-a' });
  const enriched = await registry.touch(first.recordId, { hostTaskId: 'task-a', hostProjectRoot: f.second }); assert.equal(enriched.hostProjectRoot, f.second); assert.equal(enriched.projectRoot, f.first); assert.equal(enriched.recordId, first.recordId);
  await assert.rejects(registry.touch(first.recordId, { hostTaskId: 'task-b', hostProjectRoot: f.first }), { code: 'WORKSPACE_RECORD_CHANGED' });
  assert.equal((await registry.get(first.recordId)).hostProjectRoot, f.second);
  await registry.touch(first.recordId, { model: 'gpt-6-astra' }); assert.equal((await registry.get(first.recordId)).hostProjectRoot, f.second);
});

test('bootstrap selects only a unique actual main and exposes ambiguity without guessing', async t => {
  const f = await fixture(t); const service = await controller(f, { native: true, cwd: f.first, env: { CODEX_THREAD_ID: 'task-a' } }); t.after(() => service.close());
  await writeFile(path.join(f.first, 'notes.tex'), '% \\documentclass{article}\nA note.');
  assert.deepEqual(await discoverMainFiles(f.first), ['main.tex']);
  await writeFile(path.join(f.first, 'another.tex'), sourceText);
  await service.bootstrapHostProject(); assert.equal(service.getState().project, null);
  assert.deepEqual(service.getState().workspaceIndex.bootstrap.mainCandidates, ['another.tex', 'main.tex']);
  await service.openProject({ root: f.first, mainFile: 'main.tex' });
  assert.equal(service.getState().workspaceIndex.bootstrap.status, 'ready');
  await assert.rejects(service.openProject({ root: f.second, mainFile: 'main.tex' }), { code: 'WORKSPACE_NOT_AUTHORIZED' });
  await assert.rejects(service.openProject({ root: f.first, mainFile: '../second/main.tex' }), { code: 'INVALID_INPUT' });
});

test('task and paper identities isolate saved drafts and optional worker bindings while history restores an exact record', async t => {
  const f = await fixture(t);
  const first = await controller(f, { native: true, cwd: f.first, env: { CODEX_THREAD_ID: 'task-one' } });
  await first.bootstrapHostProject(); const firstRecord = first.getState().workspaceIndex.currentRecordId;
  const segment = first.getState().segments.find(item => item.translatable);
  await first.saveDraft({ segmentId: segment.id, language: 'zh-CN', text: '第一项修改任务的独立草稿。', expectedRevision: 0 });
  Object.assign(first.chat.state, { threadId: 'worker-one', model: 'gpt-6-astra', effort: 'medium' }); first.chat.emit('change');
  const metadata = await first.listWorkspaces(); assert.equal(metadata.records[0].hostTaskId, 'task-one'); assert.equal(metadata.records[0].workerThreadId, 'worker-one');
  await first.close();
  const second = await controller(f, { native: true, cwd: f.first, env: { CODEX_THREAD_ID: 'task-two' } }); t.after(() => second.close());
  await second.bootstrapHostProject(); const secondRecord = second.getState().workspaceIndex.currentRecordId;
  assert.notEqual(secondRecord, firstRecord); assert.deepEqual(second.getState().translations, {});
  assert.equal((await second.listWorkspaces()).records.length, 2);
  await second.openWorkspaceRecord({ recordId: firstRecord });
  assert.equal(second.getState().translations['zh-CN'][segment.id].text, '第一项修改任务的独立草稿。');
  assert.equal(second.getState().workspaceIndex.currentRecord.hostTaskId, 'task-one');
  assert.equal(second.getState().workspaceIndex.hostContext.hostTaskId, 'task-two');
  assert.equal(second.getState().workspaceIndex.currentRecord.workerThreadId, 'worker-one');
  assert.ok(second.core.dataRoot.endsWith(path.join('tasks', firstRecord)));
  const disk = await readFile(path.join(f.dataRoot, 'workspace-index.json'), 'utf8');
  assert.ok(!disk.includes('独立草稿') && !disk.includes(sourceText) && !disk.includes('messages'));
});

test('busy native jobs and pending operations prevent record switches before any new record is registered', async t => {
  const f = await fixture(t); const service = await controller(f); t.after(() => service.close());
  await service.openProject({ root: f.first, mainFile: 'main.tex' }); const original = service.getState().workspaceIndex.currentRecordId;
  for (const kind of ['job', 'chat', 'operation']) {
    if (kind === 'job') service.jobs.set('synthetic', { finished: false });
    if (kind === 'chat') service.chat.state.busy = true;
    if (kind === 'operation') service._pendingOps = 1;
    await assert.rejects(service.openProject({ root: f.second, mainFile: 'main.tex' }), { code: 'PROJECT_BUSY' });
    service.jobs.clear(); service.chat.state.busy = false; service._pendingOps = 0;
    assert.equal(service.getState().workspaceIndex.currentRecordId, original); assert.equal((await service.listWorkspaces()).records.length, 1);
  }
  await assert.rejects(service.openProject({ root: f.second, mainFile: 'missing.tex' }), { code: 'ENOENT' });
  assert.equal(service.getState().workspaceIndex.currentRecordId, original); assert.equal(service.getState().project.mainFile, 'main.tex');
});

test('revoked host roots clear the active paper while retaining its recoverable history', async t => {
  const f = await fixture(t), service = await controller(f, { native: true, cwd: f.first, env: { CODEX_THREAD_ID: 'task-a' } }); t.after(() => service.close());
  await service.bootstrapHostProject(); const original = service.getState().workspaceIndex.currentRecordId;
  await service.setHostRoots([]); await service.bootstrapHostProject();
  assert.equal(service.getState().project, null); assert.equal(service.getState().workspaceIndex.currentRecordId, null);
  assert.equal(service.getState().workspaceIndex.bootstrap.status, 'workspace-required'); assert.equal((await service.listWorkspaces()).records[0].recordId, original);
  await service.setHostRoots([{ uri: pathToFileURL(f.second).href }]); await service.bootstrapHostProject();
  assert.equal(service.getProjectRoot(), f.second); assert.notEqual(service.getState().workspaceIndex.currentRecordId, original);
});

test('v0.3.1 exact bound paper is indexed in place with drafts and chat file preserved', async t => {
  const f = await fixture(t); await mkdir(f.codexRoot);
  const old = new PaperApplication({ dataRoot: f.dataRoot }); await old.openProject({ root: f.first, mainFile: 'main.tex' });
  const segment = old.getState().segments.find(item => item.translatable);
  await old.saveDraft({ segmentId: segment.id, language: 'zh-CN', text: '原有 0.3.1 草稿。', expectedRevision: 0 });
  const chatBytes = Buffer.from('{"schemaVersion":1,"threadId":"original-worker","messages":[]}');
  await writeFile(path.join(f.codexRoot, 'chat-state.json'), chatBytes);
  const service = await controller(f, { explicitWorkspace: f.first, explicitMainFile: 'main.tex', env: { CODEX_THREAD_ID: 'inherited-but-standalone' } }); t.after(() => service.close());
  const index = await service.listWorkspaces(); assert.equal(index.records.length, 1); assert.equal(index.records[0].legacy, true); assert.equal(index.records[0].hostTaskId, null);
  await service.bootstrapHostProject(); assert.equal(service.core.dataRoot, f.dataRoot);
  assert.equal(service.getState().translations['zh-CN'][segment.id].text, '原有 0.3.1 草稿。');
  assert.deepEqual(await readFile(path.join(f.codexRoot, 'chat-state.json')), chatBytes);
});

test('malformed registry and a live index lock fail closed without overwriting saved metadata', async t => {
  const f = await fixture(t), registry = new TaskRegistry(f);
  const first = await registry.register({ projectRoot: f.first, mainFile: 'main.tex', hostTaskId: 'task-a' });
  const before = await readFile(registry.filename); await writeFile(path.join(f.dataRoot, '.workspace-index.lock'), 'synthetic-owner');
  await assert.rejects(registry.touch(first.recordId), { code: 'REGISTRY_BUSY' }); assert.deepEqual(await readFile(registry.filename), before);
  await rm(path.join(f.dataRoot, '.workspace-index.lock'));
  const corrupt = Buffer.from('{"schemaVersion":1,"records":[{"recordId":"../../escape"}]}'); await writeFile(registry.filename, corrupt);
  await assert.rejects(registry.records(), { code: 'REGISTRY_RECOVERY_REQUIRED' }); await assert.rejects(registry.register({ projectRoot: f.second, mainFile: 'main.tex' }), { code: 'REGISTRY_RECOVERY_REQUIRED' });
  assert.deepEqual(await readFile(registry.filename), corrupt);
});

test('real MCP roots/list bootstraps the current host project and history remains private UI authority', async t => {
  const f = await fixture(t);
  const service = await controller(f, { native: true, cwd: f.first, env: { CODEX_THREAD_ID: 'host-native-task' }, explicitWorkspace: f.first, explicitMainFile: 'main.tex' });
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { ListRootsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const { createPaperServer } = await import('../src/server.mjs');
  const server = createPaperServer({ service, workspace: f.first, mainFile: 'main.tex', uiHtml: '<!doctype html><title>Synthetic native task</title>' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'synthetic-native-project-host', version: '1.0.0' }, { capabilities: { roots: { listChanged: true } } });
  let calls = 0; client.setRequestHandler(ListRootsRequestSchema, async () => { calls++; return { roots: [{ uri: pathToFileURL(f.second).href, name: 'Actual Codex project' }] }; });
  t.after(async () => { await client.close(); await server.close(); await service.close(); });
  await server.connect(serverSide); await client.connect(clientSide);
  const opened = await client.callTool({ name: 'bilingual_paper_panel', arguments: {} });
  assert.equal(opened.isError, undefined, opened._meta?.paperError?.message); assert.equal(calls, 1);
  assert.equal(service.getProjectRoot(), f.second); assert.equal(opened._meta.paperState.workspaceIndex.hostContext.source, 'mcp-roots');
  assert.ok(!JSON.stringify(opened.structuredContent).includes(f.second));
  const denied = await client.callTool({ name: 'bilingual_paper_ui', arguments: { action: 'listWorkspaces', payload: {} } });
  assert.equal(denied._meta.paperError.code, 'UI_AUTHORIZATION_REQUIRED');
  const listed = await client.callTool({ name: 'bilingual_paper_ui', arguments: { action: 'listWorkspaces', payload: {}, uiToken: opened._meta.paperUiToken } });
  assert.equal(listed._meta.paperResult.records.length, 1); assert.equal(listed._meta.paperResult.records[0].hostTaskId, 'host-native-task');
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(!names.includes('openWorkspaceRecord') && !names.includes('listWorkspaces'));
  const spoofed = await client.callTool({ name: 'bilingual_paper_panel', arguments: { root: f.first, hostTaskId: 'spoofed-task' } });
  assert.equal(spoofed.isError, true); assert.equal(service.getProjectRoot(), f.second);
});

test('full runtime factory derives isolated private chat/context roots without creating a model conversation', async t => {
  const f = await fixture(t); const { createApplication } = await import('../src/runtime.mjs');
  const service = await createApplication({ dataRoot: f.dataRoot, codexRoot: f.codexRoot, compilerRoot: path.join(f.root, 'uninstalled-compiler'), workspace: null, mainFile: null, native: true, cwd: f.first, hostEnv: { CODEX_THREAD_ID: 'native-runtime-task' } }); t.after(() => service.close());
  await service.setHostRoots([{ uri: pathToFileURL(f.first).href }]);
  await service.bootstrapHostProject(); const recordId = service.getState().workspaceIndex.currentRecordId;
  assert.equal(service.dataRoot, path.join(f.dataRoot, 'tasks', recordId));
  assert.equal(service.chat.dataRoot, path.join(f.codexRoot, 'tasks', recordId));
  assert.equal(service.chat.cwd, path.join(f.codexRoot, 'tasks', recordId, 'context'));
  assert.equal(service.chat.expectedPaperBinding, service.getState().project.id);
  assert.equal(path.dirname(service.compiler.dataRoot), path.join(path.dirname(f.dataRoot), 'c'));
  assert.match(path.basename(service.compiler.dataRoot), /^[a-f0-9]{12}$/);
  assert.ok(!service.compiler.dataRoot.includes(recordId), 'Compiler probe paths must not include the long task record identity.');
  assert.equal(service.chat.getState().threadId, null); assert.equal(service.chat.getState().connected, false);
  assert.equal(service.getState().workspaceIndex.hostContext.hostTaskId, 'native-runtime-task');
});
