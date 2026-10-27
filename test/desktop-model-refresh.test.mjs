import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaperApplication } from '../src/application.mjs';
import { WorkspaceService } from '../src/workspace-service.mjs';
import { DesktopQueueProducer } from '../src/desktop-queue.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), threadId = 'verified-paper-chat';
async function fixture(t) {
  const parent = path.join(root, 'work/desktop-model-refresh'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'case-')), source = path.join(directory, 'source'); await mkdir(source);
  await writeFile(path.join(source, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\nA protected current paper claim.\n\n\\end{document}\n');
  const app = new PaperApplication({ dataRoot: path.join(directory, 'private') }); await app.openProject({ root: source, mainFile: 'main.tex' });
  const metadata = { id: threadId, name: 'Verified paper conversation', model: 'model-a', reasoningEffort: 'medium', cwd: source }, calls = [], hooks = {};
  class Bridge {
    async connect() {}
    async close() {}
    async _request(method, params) {
      calls.push(method);
      if (method === 'thread/read') { await hooks.read?.(); return { thread: structuredClone(metadata) }; }
      if (method === 'thread/queue/add') { await hooks.add?.(); return { queuedSubmission: { id: `q-${calls.length}`, clientUserMessageId: params.clientUserMessageId, input: params.input } }; }
      throw new Error('Unexpected queue method: ' + method);
    }
  }
  const service = new WorkspaceService({ initialApp: app, factory: async () => app, dataRoot: path.join(directory, 'registry'), codexRoot: path.join(directory, 'codex'), createDesktopProducer: async () => new DesktopQueueProducer({ threadId, dataRoot: path.join(directory, 'producer'), Bridge, desktopQueueVerified: true }) });
  const project = app.getState().project, selection = { threadId, title: metadata.name, model: metadata.model, effort: metadata.reasoningEffort };
  service.currentRecord = await service.registry.register({ projectRoot: source, mainFile: 'main.tex' });
  service.currentRecord = await service.registry.touch(service.currentRecord.recordId, selection);
  await app._flowAction(() => { app.flow.backgroundChatReference = { kind: 'background-chat-reference', projectId: project.id, source: 'originating-host-chat', ...selection }; }); await service._bindingQueue;
  await service.desktopExecution.bind({ app, project, selection });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, service, metadata, calls, directory, source, project, hooks };
}

test('every new Desktop submission inherits the verified current model and effort before one queue/add without rebinding', async t => {
  const f = await fixture(t), execution = f.service.desktopExecution, scope = execution.scope, generation = execution.generation;
  f.metadata.model = 'model-b'; f.metadata.reasoningEffort = 'high';
  await f.service.desktopSendMessage({ text: 'Discuss this paper.', idempotencyKey: 'first' });
  assert.equal(execution.state().model, 'model-b'); assert.equal(execution.state().effort, 'high');
  assert.equal(f.app.flow.backgroundChatReference.model, 'model-b'); assert.equal(f.service.currentRecord.model, 'model-b');
  assert.equal(JSON.parse(await readFile(path.join(f.app.core._store, 'workflow.json'), 'utf8')).backgroundChatReference.model, 'model-b');
  assert.equal((await f.service.registry.get(f.service.currentRecord.recordId)).effort, 'high');
  f.metadata.model = 'model-c'; f.metadata.reasoningEffort = null;
  await execution.enqueueForApp(f.app, { clientUserMessageId: 'translation-task', text: 'Complete the registered full translation.' });
  assert.equal(execution.state().model, 'model-c'); assert.equal(execution.state().effort, null); assert.equal((await f.service.registry.get(f.service.currentRecord.recordId)).effort, null);
  assert.equal(execution.scope, scope); assert.equal(execution.generation, generation);
  assert.equal(f.calls.filter(method => method === 'thread/read').length, 2); assert.equal(f.calls.filter(method => method === 'thread/queue/add').length, 2);
});

test('model metadata or registry write denial prevents delivery and preserves known preflight retry semantics', async t => {
  const f = await fixture(t), execution = f.service.desktopExecution;
  f.metadata.id = 'foreign-thread';
  await assert.rejects(f.service.desktopSendMessage({ text: 'No foreign delivery.', idempotencyKey: 'foreign' }), { code: 'THREAD_MISMATCH', deliveryAttempted: false });
  assert.equal(f.calls.filter(method => method === 'thread/queue/add').length, 0); assert.equal(f.app.flow.desktopMessages.at(-1).deliveryAttempted, false);
  assert.equal(execution.state().phase, 'verification-failed'); assert.equal(execution.state().error.code, 'THREAD_MISMATCH');
  f.metadata.id = threadId; f.metadata.model = 'model-b'; const touch = f.service.registry.touch.bind(f.service.registry); let deny = true;
  f.service.registry.touch = async (...args) => { if (deny) throw Object.assign(new Error('Synthetic registry permission denied'), { code: 'EACCES' }); return touch(...args); };
  await assert.rejects(f.service.desktopSendMessage({ text: 'Preserve this request.', idempotencyKey: 'denied' }), { code: 'EACCES', deliveryAttempted: false });
  assert.equal(f.calls.filter(method => method === 'thread/queue/add').length, 0); assert.equal(f.app.flow.desktopMessages.at(-1).status, 'failed');
  deny = false; await f.service.desktopSendMessage({ text: 'Preserve this request.', idempotencyKey: 'denied' });
  assert.equal(f.calls.filter(method => method === 'thread/queue/add').length, 1); assert.equal(execution.state().model, 'model-b');
  assert.equal(execution.state().error, undefined);
});

test('translation and revision submissions refresh their own jobs while retaining an earlier active runtime and exact chat', async t => {
  const f = await fixture(t), execution = f.service.desktopExecution, ids = [f.app.core.getState().segments[0].id];
  const translation = await f.app.createRequest({ kind: 'translation', segmentIds: ids, language: 'zh-CN', bindingId: `desktop:${threadId}` });
  f.metadata.model = 'model-b'; f.metadata.reasoningEffort = 'high';
  const first = await execution.runRequest(f.app, { requestId: translation.requestId }), runtime = f.app.jobs.get(first.jobId), generation = execution.generation;
  assert.equal(f.app.flow.jobs.find(job => job.jobId === first.jobId).model, 'model-b');
  const revision = await f.app.createRequest({ kind: 'revision', segmentIds: ids, language: 'zh-CN', bindingId: `desktop:${threadId}` });
  f.metadata.model = 'model-c'; f.metadata.reasoningEffort = 'low';
  const second = await execution.runRequest(f.app, { requestId: revision.requestId });
  assert.equal(f.app.flow.jobs.find(job => job.jobId === second.jobId).model, 'model-c'); assert.equal(f.app.flow.jobs.find(job => job.jobId === second.jobId).effort, 'low');
  assert.equal(f.app.jobs.get(first.jobId), runtime); assert.equal(runtime.finished, false); assert.equal(execution.generation, generation); assert.equal(execution.state().threadId, threadId);
  assert.equal(f.calls.filter(method => method === 'thread/read').length, 2); assert.equal(f.calls.filter(method => method === 'thread/queue/add').length, 2);
});

test('unverifiable model or flow write denial never adds a queue entry or invokes the result path', async t => {
  const f = await fixture(t), execution = f.service.desktopExecution;
  f.metadata.model = null;
  await assert.rejects(execution.enqueueForApp(f.app, { clientUserMessageId: 'missing-model', text: 'Preserve the original task.' }), { code: 'DESKTOP_QUEUE_METADATA_UNAVAILABLE', deliveryAttempted: false });
  f.metadata.model = 'model-b'; const persist = f.app._persistFlow.bind(f.app); let denied = true;
  f.app._persistFlow = async () => { if (denied && f.app.flow.backgroundChatReference.model === 'model-b') throw Object.assign(new Error('Synthetic workflow permission denial'), { code: 'EACCES' }); return persist(); };
  await assert.rejects(execution.enqueueForApp(f.app, { clientUserMessageId: 'flow-denied', text: 'Preserve the task text.' }), { code: 'EACCES', deliveryAttempted: false });
  assert.equal(f.calls.filter(method => method === 'thread/queue/add').length, 0); assert.equal(execution.state().model, 'model-a');
  denied = false; await execution.enqueueForApp(f.app, { clientUserMessageId: 'flow-denied', text: 'Preserve the task text.' });
  assert.equal(f.calls.filter(method => method === 'thread/queue/add').length, 1); assert.equal(execution.state().model, 'model-b');
});

test('a lost queue acknowledgment after metadata verification remains uncertain and cannot be resent', async t => {
  const f = await fixture(t); f.metadata.model = 'model-b'; f.hooks.add = async () => { throw Object.assign(new Error('Synthetic lost acknowledgment'), { code: 'CODEX_TIMEOUT' }); };
  await assert.rejects(f.service.desktopSendMessage({ text: 'One exact user request.', idempotencyKey: 'lost' }), { code: 'DESKTOP_QUEUE_DELIVERY_UNCERTAIN' });
  assert.equal(f.service.desktopExecution.state().model, 'model-b');
  await assert.rejects(f.service.desktopSendMessage({ text: 'One exact user request.', idempotencyKey: 'lost' }), { code: 'DESKTOP_QUEUE_DELIVERY_UNCERTAIN' });
  assert.equal(f.calls.filter(method => method === 'thread/queue/add').length, 1);
});

test('a source snapshot change during live metadata lookup prevents both metadata adoption and queue delivery', async t => {
  const f = await fixture(t), before = structuredClone(f.app.flow.backgroundChatReference); f.metadata.model = 'model-b';
  f.hooks.read = () => f.app.core._serial(async () => { const next = f.app.core.getState(); next.project.snapshotId = 'snap-after-delayed-verification'; await f.app.core._commit(next); });
  await assert.rejects(f.service.desktopExecution.enqueueForApp(f.app, { clientUserMessageId: 'stale-metadata', text: 'Keep the task in its original paper.' }), { code: 'DESKTOP_EXECUTION_STALE', deliveryAttempted: false });
  assert.equal(f.calls.filter(method => method === 'thread/queue/add').length, 0); assert.deepEqual(f.app.flow.backgroundChatReference, before); assert.equal(f.service.desktopExecution.scope.model, 'model-a');
});
