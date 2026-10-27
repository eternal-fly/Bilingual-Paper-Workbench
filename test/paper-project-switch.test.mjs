import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { TaskRegistry } from '../src/task-registry.mjs';
import { switchPaperProject } from '../src/paper-project-switch.mjs';
import { paperProjectTitle, readProjectTitle } from '../src/paper-project-title.mjs';
import { startLocalWeb, dispatchUi } from '../src/local-web.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const parent = fileURLToPath(new URL('../work/project-switch-tests/', import.meta.url)); await mkdir(parent, { recursive: true }); const root = await mkdtemp(path.join(parent, 'case-')); t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new TaskRegistry({ dataRoot: path.join(root, 'private'), codexRoot: path.join(root, 'chat') }), paper = path.join(root, 'paper'); await mkdir(paper); await writeFile(path.join(paper, 'main.tex'), 'Synthetic source bytes.');
  const record = await registry.register({ projectRoot: paper, mainFile: 'main.tex', hostTaskId: 'old-chat-owner' }); await registry.touch(record.recordId, { threadId: 'chat-b', paperTitle: 'A synthetic paper title' });
  const projectId = `project-${hash(paper.toLowerCase() + '\0main.tex').slice(0, 24)}`, folder = path.join(record.stateRoot, 'projects', projectId); await mkdir(folder, { recursive: true });
  const flow = { schemaVersion: 1, projectId, nativeChatBinding: { kind: 'bound-existing-chat', projectId, threadId: 'chat-b', model: 'gpt-6-astra' } }; await writeFile(path.join(folder, 'workflow.json'), JSON.stringify(flow));
  let sourceRecord = 'source-a', sourceSnapshot = 'snap-a', busy = false;
  const service = { registry, _assertIdle() { if (busy) throw Object.assign(Error('Busy synthetic source.'), { code: 'PROJECT_BUSY' }); }, getState: () => ({ project: { id: 'project-a', snapshotId: sourceSnapshot }, workspaceIndex: { currentRecordId: sourceRecord } }) };
  const sourceUrl = `http://127.0.0.1:12345/#session=${'a'.repeat(43)}`, targetUrl = `http://127.0.0.1:23456/#session=${'b'.repeat(43)}`, events = [], state = { project: { id: projectId, snapshotId: 'snap-b' }, workspaceIndex: { currentRecordId: 'another-paper', currentRecord: { paperTitle: 'A synthetic paper title' } }, desktopExecution: { available: true, threadId: 'chat-b' }, originatingChat: { verified: true, threadId: 'chat-b', phase: 'desktop-ready' } };
  const options = { service, profile: { originThreadId: 'chat-a', pluginRoot: root, dataRoot: registry.dataRoot, version: '1.4.0' }, session: { url: sourceUrl }, input: { recordId: record.recordId }, ensure: async target => { events.push(['ensure', target]); }, readSession: async target => { assert.equal(target.originThreadId, 'chat-b'); return { url: targetUrl }; }, signRefresh: async () => ({ syntheticProof: true }), signHandoff: async (_options, _session, input) => ({ syntheticHandoff: true, recordId: input.recordId, handoffId: input.handoffId }), reserveWindow: async input => { events.push(['reserve', input]); assert.equal(input.fromUrl, sourceUrl); assert.equal(input.toUrl, targetUrl); return { reason: 'reserved' }; }, cancelWindow: async input => { events.push(['cancel', input]); }, readMetadata: async threadId => { assert.equal(threadId, 'chat-b'); events.push(['metadata', threadId]); return { threadId, model: 'gpt-6-astra', effort: 'max', cwd: paper, title: 'Saved paper chat B' }; }, request: async ({ url, action, payload }) => { assert.equal(url, targetUrl); events.push([action, payload]); if (action === 'openWorkspaceRecord') state.workspaceIndex.currentRecordId = payload.recordId; return { ok: true, state: structuredClone(state), ...(action === 'prepareProjectWindowHandoff' ? { result: { handoffId: payload.handoffId } } : {}) }; }, readyTimeoutMs: 0 };
  return { root, record, flow, folder, paper, registry, options, state, events, setBusy: value => { busy = value; }, drift: () => { sourceSnapshot = 'snap-new'; }, sourceUrl, targetUrl };
}

test('an explicit saved project choice hands the same window to chat B canonical daemon without source writes, resume or a new chat', async t => {
  const f = await fixture(t), before = await readFile(path.join(f.paper, 'main.tex')); const result = await switchPaperProject(f.options);
  assert(result.navigateUrl.startsWith(f.targetUrl + '&handoff=')); assert.match(result.navigateUrl.split('&handoff=')[1], /^[a-f0-9]{48}$/u); assert.equal(result.threadId, 'chat-b'); assert.equal(result.recordId, f.record.recordId); assert.equal(result.paperTitle, 'A synthetic paper title');
  assert.equal(f.events[1][0], 'ensure'); assert.equal(f.events[1][1].launchId, 'chat-b'); assert.equal(f.events[1][1].hostProject.autoOpen, false);
  assert.deepEqual(f.events.filter(event => event[0] === 'openWorkspaceRecord').map(event => event[1]), [{ recordId: f.record.recordId }]); assert.equal(f.events.at(-1)[0], 'prepareProjectWindowHandoff');
  assert.deepEqual(await readFile(path.join(f.paper, 'main.tex')), before); assert.equal((await f.registry.chatSelection('chat-b')).recordId, f.record.recordId); assert.equal((await f.registry.get(f.record.recordId)).hostTaskId, 'old-chat-owner');
});

test('unknown UI fields, a busy source, missing flow binding and stale source cannot redirect a paper window', async t => {
  const f = await fixture(t); await assert.rejects(switchPaperProject({ ...f.options, input: { recordId: f.record.recordId, threadId: 'forged' } }), { code: 'INVALID_INPUT' });
  f.setBusy(true); await assert.rejects(switchPaperProject(f.options), { code: 'PROJECT_BUSY' }); f.setBusy(false); assert.equal(f.events.length, 0);
  await writeFile(path.join(f.folder, 'workflow.json'), JSON.stringify({ ...f.flow, nativeChatBinding: null })); await assert.rejects(switchPaperProject(f.options), { code: 'PROJECT_CHAT_REQUIRED' }); assert.equal(f.events.length, 0);
  await writeFile(path.join(f.folder, 'workflow.json'), JSON.stringify(f.flow)); const ensure = f.options.ensure; f.options.ensure = async value => { await ensure(value); f.drift(); }; await assert.rejects(switchPaperProject(f.options), { code: 'WORKSPACE_RECORD_CHANGED' }); assert(!f.events.some(event => event[0] === 'transfer'));
  assert.equal(f.events.at(-1)[0], 'cancel'); assert.equal(f.events.at(-1)[1].handoffId, f.events.find(event => event[0] === 'reserve')[1].handoffId);
});

test('an existing target window blocks before any target project state is changed', async t => {
  const f = await fixture(t); f.options.reserveWindow = async () => { f.events.push(['reserve-conflict']); throw Object.assign(Error('Target already owns a live window.'), { code: 'PROJECT_WINDOW_ALREADY_OPEN' }); };
  await assert.rejects(switchPaperProject(f.options), { code: 'PROJECT_WINDOW_ALREADY_OPEN' }); assert.equal(f.state.workspaceIndex.currentRecordId, 'another-paper');
  assert(!f.events.some(event => ['syncHostProject', 'openWorkspaceRecord', 'prepareProjectWindowHandoff'].includes(event[0])));
});

test('a different returned chat, target paper or unavailable Desktop route cannot become the selected chat', async t => {
  for (const kind of ['metadata', 'paper', 'desktop']) {
    const f = await fixture(t); if (kind === 'metadata') f.options.readMetadata = async () => ({ threadId: 'other-chat', model: 'gpt-6-astra', cwd: f.paper });
    if (kind === 'paper') f.state.project.id = 'foreign-project'; if (kind === 'desktop') f.state.desktopExecution.available = false;
    await assert.rejects(switchPaperProject(f.options), { code: kind === 'metadata' ? 'THREAD_MISMATCH' : kind === 'paper' ? 'WORKSPACE_RECORD_CHANGED' : 'PROJECT_CHAT_NOT_READY' });
    assert(!f.events.some(event => event[0] === 'transfer')); assert.equal(await f.registry.chatSelection('chat-b'), null);
  }
});

test('source titles are bounded plain labels and explicit chat selection pointers preserve legacy record identities', async t => {
  assert.equal(paperProjectTitle({ project: { mainFile: 'main.tex' }, readingParagraphs: [{ kind: 'title', path: 'main.tex', source: 'A \\emph{clear} title\nwith $x$' }] }), 'A clear title with x');
  assert.equal(paperProjectTitle({ readingParagraphs: [{ kind: 'title', source: 'x'.repeat(9000) }] }), '');
  const f = await fixture(t); await f.registry.selectForChat({ threadId: 'chat-b', recordId: f.record.recordId, hostProjectRoot: f.paper });
  await writeFile(path.join(f.paper, 'main.tex'), '\\documentclass{article}\n% \\title{Ignored comment}\n\\title{A \\emph{readable} paper title}\n\\begin{document}\n' + 'Body. '.repeat(20000)); const before = await readFile(f.registry.filename); assert.equal(await readProjectTitle(f.record), 'A readable paper title'); assert.deepEqual(await readFile(f.registry.filename), before);
  const reopened = new TaskRegistry({ dataRoot: f.registry.dataRoot, codexRoot: f.registry.codexRoot }); assert.equal((await reopened.chatSelection('chat-b')).recordId, f.record.recordId);
  await assert.rejects(reopened.touch(f.record.recordId, { threadId: 'worker-c' }), { code: 'WORKSPACE_RECORD_CHANGED' }); assert.equal((await reopened.get(f.record.recordId)).threadId, 'chat-b');
});

test('only the authenticated configured UI endpoint returns a project navigation capability', async t => {
  const f = await fixture(t), htmlPath = path.join(f.root, 'index.html'); await writeFile(htmlPath, '<!doctype html><title>Synthetic project selector</title>');
  let calls = 0; const web = await startLocalWeb({ service: f.options.service, htmlPath, switchWorkspace: input => { calls++; return switchPaperProject({ ...f.options, input }); } }); t.after(() => web.close());
  const url = new URL(web.url), payload = { action: 'switchWorkspace', payload: { recordId: f.record.recordId } };
  const response = async headers => fetch(url.origin + '/api', { method: 'POST', headers: { Origin: url.origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) }).then(result => result.json());
  assert.equal((await response({})).ok, false); assert.equal(calls, 0);
  const accepted = await response({ Authorization: 'Bearer ' + url.hash.slice(9) }); assert.equal(accepted.ok, true); assert(accepted.result.navigateUrl.startsWith(f.targetUrl + '&handoff=')); assert.equal(calls, 1);
  await assert.rejects(dispatchUi(f.options.service, 'switchWorkspace', payload.payload), { code: 'INVALID_INPUT' });
  const plain = await startLocalWeb({ service: f.options.service, htmlPath }); t.after(() => plain.close()); const other = new URL(plain.url);
  const denied = await fetch(other.origin + '/api', { method: 'POST', headers: { Origin: other.origin, 'Content-Type': 'application/json', Authorization: 'Bearer ' + other.hash.slice(9) }, body: JSON.stringify(payload) }).then(result => result.json()); assert.equal(denied.error.code, 'INVALID_INPUT');
});
