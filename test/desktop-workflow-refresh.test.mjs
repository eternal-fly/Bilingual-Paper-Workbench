import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaperApplication } from '../src/application.mjs';
import { DesktopExecution } from '../src/desktop-execution.mjs';
import { DesktopTranslationTasks } from '../src/translation-tasks.mjs';
import { createPaperServer } from '../src/server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const selection = { threadId: 'shared-desktop-chat', model: 'synthetic-no-model', effort: 'high' };
async function fixture(t) {
  const parent = fileURLToPath(new URL('../work/desktop-workflow-refresh-tests/', import.meta.url)); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'case-')), source = path.join(directory, 'source'), dataRoot = path.join(directory, 'private'); await mkdir(source);
  const filename = path.join(source, 'main.tex'), original = '\\documentclass{article}\n\\begin{document}\n\n' + Array.from({ length: 22 }, (_, i) => `Synthetic paragraph ${i}.`).join('\n\n') + '\n\n\\end{document}\n';
  await writeFile(filename, original);
  const writer = new PaperApplication({ dataRoot }); await writer.openProject({ root: source, mainFile: 'main.tex' });
  await writer._flowAction(() => { writer.flow.backgroundChatReference = { ...selection, projectId: writer.getState().project.id }; });
  const reader = new PaperApplication({ dataRoot }); await reader.openProject({ root: source, mainFile: 'main.tex' });
  const calls = [], executions = [];
  const execution = async (app, name) => {
    const service = new EventEmitter(); service.active = app; service.getState = () => app.getState(); service.getHostContext = () => ({ native: true, taskIdAvailable: true, hostTaskId: selection.threadId });
    const controller = new DesktopExecution(service, { createProducer: async () => {
      calls.push(`${name}:factory`); return { state: () => ({ desktopQueueVerified: true }), close: async () => {}, enqueue: async (input, { beforeEnqueue }) => {
        await beforeEnqueue({ ...selection, cwd: source }); calls.push(`${name}:enqueue`);
        return { threadId: selection.threadId, clientUserMessageId: input.clientUserMessageId, inputHash: sha(input.text), status: 'queued', queuedSubmissionId: 'synthetic-queue' };
      } };
    } });
    service.desktopExecution = controller; executions.push(controller); await controller.bind({ app, project: app.getState().project, selection }); return controller;
  };
  const background = await execution(reader, 'reader'), producer = await execution(writer, 'writer');
  t.after(async () => { for (const item of executions.reverse()) await item.close(); await writer.close(); await reader.close(); assert.equal(await readFile(filename, 'utf8'), original); assert.ok(directory.startsWith(parent)); await rm(directory, { recursive: true, force: true }); });
  return { writer, reader, background, producer, calls, filename, workflow: path.join(writer.core._store, 'workflow.json'), async queue(kind = 'revision') {
    const request = await writer.createRequest({ kind, segmentIds: writer.getState().segments.map(row => row.id), language: 'zh-CN', bindingId: `desktop:${selection.threadId}`, prompt: 'Clarify all twenty-two synthetic paragraphs.' });
    const receipt = await producer.runRequest(writer, { requestId: request.requestId }); return { request, receipt };
  } };
}

test('same-identity rebind and approval refresh another controller\'s exact twenty-two-paragraph request and durable ticket without resending', async t => {
  const f = await fixture(t), { request } = await f.queue();
  assert.equal(f.reader.flow.desktopMessages?.length || 0, 0); const disk = await readFile(f.workflow);
  await f.background.bind({ app: f.reader, project: f.reader.getState().project, selection });
  const approved = await f.background.approvedRequest(f.reader, request.requestId, selection.threadId);
  assert.equal(approved.segments.length, 22); assert.equal(f.background.state().messages[0].requestId, request.requestId);
  assert.equal(f.calls.filter(value => value === 'reader:factory').length, 1); assert.equal(f.calls.filter(value => value.endsWith(':enqueue')).length, 1);
  assert.deepEqual(await readFile(f.workflow), disk);
});

test('approval alone reloads durable request and ticket while refusing a foreign caller', async t => {
  const f = await fixture(t), { request } = await f.queue();
  const approved = await f.background.approvedRequest(f.reader, request.requestId, selection.threadId); assert.equal(approved.requestId, request.requestId);
  await assert.rejects(f.background.approvedRequest(f.reader, request.requestId, 'foreign-chat'), { code: 'THREAD_MISMATCH' });
  assert.equal(f.calls.filter(value => value.endsWith(':enqueue')).length, 1);
});

test('a read-only Desktop refresh never discards unpersisted workflow changes', async t => {
  const f = await fixture(t), { request } = await f.queue(), disk = await readFile(f.workflow);
  f.reader.flow.displayPreferences = { translationTextSize: 23, revision: 99 }; const buffer = structuredClone(f.reader.flow);
  await assert.rejects(f.background.approvedRequest(f.reader, request.requestId, selection.threadId), { code: 'WORKFLOW_DIRTY' });
  assert.deepEqual(f.reader.flow, buffer); assert.deepEqual(await readFile(f.workflow), disk);
});

test('a stale workflow persistence cannot overwrite another controller\'s newer durable version', async t => {
  const f = await fixture(t), external = JSON.parse(await readFile(f.workflow, 'utf8'));
  external.externalSentinel = 'retained-durable-work'; const bytes = JSON.stringify(external); await writeFile(f.workflow, bytes);
  f.reader.flow.unpersistedSentinel = 'retained-local-work'; const local = structuredClone(f.reader.flow);
  await assert.rejects(f.reader._persistFlow(), { code: 'WORKFLOW_VERSION_CONFLICT' });
  assert.deepEqual(f.reader.flow, local); assert.equal(await readFile(f.workflow, 'utf8'), bytes);
});

test('invalid UTF-8 workflow JSON fails closed without normalization or rewriting', async t => {
  const f = await fixture(t), { request } = await f.queue();
  const original = await readFile(f.workflow), invalid = Buffer.concat([original.subarray(0, original.length - 1), Buffer.from(',"invalid":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  await writeFile(f.workflow, invalid);
  await assert.rejects(f.background.approvedRequest(f.reader, request.requestId, selection.threadId), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(await readFile(f.workflow), invalid);
});

test('an oversized workflow is refused before replacing the valid durable store', async t => {
  const f = await fixture(t), before = await readFile(f.workflow);
  f.reader.flow.syntheticOversize = 'x'.repeat(64 * 1024 * 1024);
  await assert.rejects(f.reader._persistFlow(), { code: 'WORKFLOW_TOO_LARGE' });
  assert.deepEqual(await readFile(f.workflow), before);
});

test('a previously existing workflow disappearing cannot reset or recreate its retained metadata', async t => {
  const f = await fixture(t), before = structuredClone(f.reader.flow); await rm(f.workflow);
  await assert.rejects(f.reader._flowAction(() => { f.reader.flow.shouldNeverPersist = true; }), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(f.reader.flow, before); await assert.rejects(readFile(f.workflow), { code: 'ENOENT' });
});

async function translationFixture(t) {
  const f = await fixture(t);
  for (const [app, execution] of [[f.writer, f.producer], [f.reader, f.background]]) app.translationTasks = new DesktopTranslationTasks(app, { getThreadId: () => selection.threadId, enqueue: input => execution.enqueueForApp(app, input) });
  const project = f.writer.getState().project, task = await f.writer.translationTasks.start({ scope: 'all', language: 'zh-CN', expectedProjectId: project.id, expectedSnapshotId: project.snapshotId });
  const server = createPaperServer({ service: f.background.service, nativeThreadId: selection.threadId, uiHtml: '<!doctype html>' }), [a, b] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'synthetic-workflow-task-test', version: '1' });
  await server.connect(b); await client.connect(a); t.after(async () => { await client.close(); await server.close(); });
  return { ...f, task, client };
}

test('full-paper task lookup refreshes a task created after the background controller opened', async t => {
  const f = await translationFixture(t); assert.equal(f.reader.flow.translationTasks, undefined);
  const response = await f.client.callTool({ name: 'bilingual_paper_get_request', arguments: { requestId: f.task.taskId } });
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent)); assert.equal(response.structuredContent.batch.segmentIds.length, 22);
  assert.equal(f.calls.filter(value => value.endsWith(':enqueue')).length, 1);
});

test('cross-controller task cancellation after outer approval prevents atomic translation publication', async t => {
  const f = await translationFixture(t); await f.reader.core._serial(() => f.reader._loadFlow());
  const response = await f.client.callTool({ name: 'bilingual_paper_get_request', arguments: { requestId: f.task.taskId } }); assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
  const request = response.structuredContent.batch, submit = f.reader.submitTranslationResult.bind(f.reader);
  f.reader.submitTranslationResult = async (...args) => { await f.writer.translationTasks.cancel({ taskId: f.task.taskId }); return submit(...args); };
  const returned = await f.client.callTool({ name: 'bilingual_paper_submit_translation_result', arguments: { requestId: request.requestId, translations: request.segments.map(segment => ({ segmentId: segment.id, text: segment.text.replace('Synthetic', 'Translated') })) } });
  assert.equal(returned.isError, true); assert.equal(Object.keys(f.reader.getState().translations['zh-CN'] || {}).length, 0);
  const durable = JSON.parse(await readFile(f.workflow, 'utf8')); assert.equal(durable.translationTasks[0].status, 'cancelled');
  assert.equal(f.calls.filter(value => value.endsWith(':enqueue')).length, 1);
});

test('a proven pre-enqueue workflow write denial preserves the durable version and permits only a later explicit retry', async t => {
  const f = await fixture(t), { request } = await f.queue(), durable = await readFile(f.workflow), before = f.calls.filter(value => value.endsWith(':enqueue')).length;
  await chmod(f.workflow, 0o444);
  try { await assert.rejects(f.background.sendMessage({ text: 'A synthetic explicit question.', idempotencyKey: 'after-permission-restored' }), error => ['EPERM', 'EACCES'].includes(error.code)); }
  finally { await chmod(f.workflow, 0o666); }
  assert.deepEqual(await readFile(f.workflow), durable); assert.equal(f.calls.filter(value => value.endsWith(':enqueue')).length, before);
  await f.background.bind({ app: f.reader, project: f.reader.getState().project, selection });
  assert.equal((await f.background.approvedRequest(f.reader, request.requestId, selection.threadId)).requestId, request.requestId);
  assert.equal(f.calls.filter(value => value.endsWith(':enqueue')).length, before);
  const sent = await f.background.sendMessage({ text: 'A synthetic explicit question.', idempotencyKey: 'after-permission-restored' });
  assert.equal(sent.status, 'queued'); assert.equal(f.calls.filter(value => value.endsWith(':enqueue')).length, before + 1);
});

test('a failed ordinary workflow action is not silently recovered as Desktop metadata', async t => {
  const f = await fixture(t), before = await readFile(f.workflow);
  await assert.rejects(f.reader._flowAction(() => { f.reader.flow.transactions.push({ transactionId: 'retained-source-journal', state: 'committing', progress: [{ path: 'main.tex', hash: 'retained-proof' }] }); throw Object.assign(Error('Synthetic journal failure'), { code: 'EACCES' }); }), { code: 'EACCES' });
  const journal = structuredClone(f.reader.flow);
  await assert.rejects(f.background.bind({ app: f.reader, project: f.reader.getState().project, selection }), { code: 'WORKFLOW_DIRTY' });
  assert.deepEqual(f.reader.flow, journal); assert.deepEqual(await readFile(f.workflow), before);
});

test('the original window polling sees another controller\'s exact translations and releases its owned runtime', async t => {
  const f = await fixture(t), { request, receipt } = await f.queue('translation');
  await f.background.approvedRequest(f.reader, request.requestId, selection.threadId);
  const returned = await f.reader.submitTranslationResult({ requestId: request.requestId, translations: request.segments.map(segment => ({ segmentId: segment.id, text: segment.text.replace('Synthetic', 'Translated') })) }, { beforeWrite: () => f.background.approvedRequest(f.reader, request.requestId, selection.threadId, { locked: true, expectedRequest: request }) });
  await f.background.requestSubmitted(f.reader, request.requestId, selection.threadId, returned);
  assert.equal(f.writer.core.getState().requests[0].status, 'pending'); assert.equal(f.writer.jobs.get(receipt.jobId).finished, false);
  const refreshed = await f.producer.refreshStatus(); assert.equal(refreshed.changed, true);
  assert.equal(f.writer.core.getState().requests[0].status, 'completed'); assert.equal(Object.keys(f.writer.getState().translations['zh-CN']).length, 22);
  assert.equal(f.writer.jobs.get(receipt.jobId).finished, true); assert.equal(f.producer.state().messages[0].resultState, 'validated');
  assert.equal(f.calls.filter(value => value.endsWith(':enqueue')).length, 1);
});

test('fresh durable readback emits one observable change even without a local Desktop runtime', async t => {
  const f = await fixture(t), { request } = await f.queue('translation'); let changes = 0; f.reader.on('change', () => changes++);
  await f.writer.submitTranslationResult({ requestId: request.requestId, translations: request.segments.map(segment => ({ segmentId: segment.id, text: segment.text.replace('Synthetic', 'Translated') })) });
  await f.producer.requestSubmitted(f.writer, request.requestId, selection.threadId, { status: 'completed' });
  assert.equal(f.reader.jobs.size, 0); const disk = await readFile(f.workflow);
  const refreshed = await f.background.refreshStatus(); assert.equal(refreshed.changed, true); assert.equal(changes, 1);
  assert.equal(Object.keys(f.reader.getState().translations['zh-CN']).length, 22); assert.deepEqual(await readFile(f.workflow), disk);
  assert.equal((await f.background.refreshStatus()).changed, false); assert.equal(changes, 1);
});

test('a cancellation persisted by another controller releases only its exact original runtime', async t => {
  const f = await fixture(t), { request, receipt } = await f.queue(), runtime = f.writer.jobs.get(receipt.jobId);
  await f.reader._flowAction(() => { f.reader.flow.desktopMessages.find(row => row.requestId === request.requestId).status = 'cancelled'; });
  assert.equal(runtime.finished, false); const refreshed = await f.producer.refreshStatus();
  assert.equal(refreshed.changed, true); assert.equal(runtime.finished, true); assert.equal(runtime.cancelled, true);
  await assert.rejects(runtime.promise, { code: 'JOB_CANCELLED' });
  assert.equal(f.producer.state().activity.busy, false); assert.equal(f.writer.flow.jobs.find(row => row.jobId === receipt.jobId).status, 'cancelled');
  assert.equal(f.writer.core.getState().requests.find(row => row.requestId === request.requestId).status, 'pending');
  await assert.rejects(f.producer.approvedRequest(f.writer, request.requestId, selection.threadId), { code: 'REQUEST_NOT_APPROVED' });
  assert.equal(f.calls.filter(value => value.endsWith(':enqueue')).length, 1);
});

test('a trusted bound-chat save records attribution without changing human draft authority or source', async t => {
  const f = await fixture(t), project = f.reader.getState().project, segmentId = f.reader.getState().readingParagraphs[0].id;
  const input = { segmentId, language: 'zh-CN', text: '用户明确要求的中文修改。', expectedRevision: 0, expectedProjectId: project.id, expectedSnapshotId: project.snapshotId }, editActor = { kind: 'bound-chat', threadId: selection.threadId, reason: 'Apply the author-requested wording.' };
  const result = await f.reader.saveTranslationDraftWithFormulaEdits(input, { editActor });
  assert.deepEqual(result.draft.editActor, editActor); assert.equal(result.draft.origin, 'human');
  const next = await f.reader.saveTranslationDraftWithFormulaEdits({ ...input, text: input.text + ' 人工续写。', expectedRevision: 1 });
  assert.equal(next.draft.editActor, undefined); assert.equal(next.draft.origin, 'human');
});

test('bound-chat attribution cannot be supplied in draft payload or bypass the final save guard', async t => {
  const f = await fixture(t), project = f.reader.getState().project, segmentId = f.reader.getState().readingParagraphs[0].id;
  const input = { segmentId, language: 'zh-CN', text: '保留的精确用户文本。', expectedRevision: 0, expectedProjectId: project.id, expectedSnapshotId: project.snapshotId }, editActor = { kind: 'bound-chat', threadId: selection.threadId, reason: 'Explicit author edit.' };
  await assert.rejects(f.reader.saveTranslationDraftWithFormulaEdits({ ...input, editActor }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.reader.saveTranslationDraftWithFormulaEdits(input, { editActor: { ...editActor, kind: 'source-authority' } }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.reader.saveTranslationDraftWithFormulaEdits(input, { editActor, beforeWrite: async () => { throw Object.assign(Error('The native caller changed.'), { code: 'REQUEST_NOT_APPROVED' }); } }), { code: 'REQUEST_NOT_APPROVED' });
  assert.equal(f.reader.getState().translations['zh-CN']?.[segmentId], undefined);
});
