import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { DesktopExecution } from '../src/desktop-execution.mjs';
const digest = text => createHash('sha256').update(text).digest('hex');
const project = { id: 'paper-1', snapshotId: 'source-1' }, selection = { threadId: 'origin-chat', title: 'Invoking chat', model: 'gpt-6-astra', effort: 'max' };
function fixture(t, options = {}) {
  const service = new EventEmitter(), app = new EventEmitter(), state = { project: { ...project }, requests: [] }, calls = [];
  app.jobs = new Map(); app.flow = { jobs: [], projectId: project.id, backgroundChatReference: { projectId: project.id, ...selection }, desktopMessages: [] };
  app.core = { getState: () => structuredClone(state), async _assertSourceCurrent() {} };
  app.getState = () => app.core.getState(); app._flowAction = async callback => { const value = await callback(); calls.push(['persist']); return value; };
  service.active = app;
  const producer = { state: () => ({ desktopQueueVerified: true }), async enqueue(input, { beforeEnqueue } = {}) { await beforeEnqueue?.({ ...selection, cwd: process.cwd() }); calls.push(['enqueue', input]); assert.equal(app.flow.desktopMessages.at(-1)?.status, 'unknown'); return { threadId: selection.threadId, clientUserMessageId: input.clientUserMessageId, inputHash: digest(input.text), status: 'queued', queuedSubmissionId: 'queue-1' }; }, async close() { calls.push(['close']); } };
  const execution = new DesktopExecution(service, { createProducer: async chosen => { calls.push(['factory', chosen]); return producer; }, ...options }); t.after(() => execution.close());
  return { app, service, state, producer, calls, execution, bind: () => execution.bind({ app, project, selection }) };
}
function register(f, patch = {}) { const request = { requestId: 'req-1', projectId: project.id, snapshotId: project.snapshotId, bindingId: 'desktop:origin-chat', kind: 'translation', status: 'pending', language: 'zh-CN', segmentIds: ['p1'], segments: [{ id: 'p1', text: 'Protected manuscript text must only be read through the request tool.', beforeHash: 'source-hash' }], ...patch }; f.state.requests.push(request); return request; }

test('binding a verified Desktop chat sends nothing and exposes its inherited selection', async t => {
  const f = fixture(t); assert.equal(f.execution.state().available, false); await f.bind(); const state = f.execution.state();
  assert.equal(state.mode, 'desktop-queue'); assert.equal(state.available, true); assert.equal(state.threadId, selection.threadId); assert.equal(state.model, selection.model); assert.equal(state.effort, 'max'); assert.deepEqual(state.messages, []); assert.equal(f.calls.some(c => c[0] === 'enqueue'), false);
});

test('one user message creates its durable ticket before queueing and validates exact same-chat returns', async t => {
  const f = fixture(t); await f.bind(); const sent = await f.execution.sendMessage({ text: 'Explain this paragraph.', idempotencyKey: 'click-1' });
  assert.equal(sent.status, 'queued'); assert.equal(f.app.flow.desktopMessages[0].textHash, digest('Explain this paragraph.')); assert.equal(f.calls.filter(c => c[0] === 'enqueue').length, 1);
  const queued = f.calls.find(c => c[0] === 'enqueue')[1]; assert.ok(queued.text.includes('bilingual_paper_submit_chat_reply')); assert.ok(queued.text.includes(sent.messageId));
  assert.ok(queued.text.includes('bilingual_paper_read_editor_drafts')); assert.ok(queued.text.includes('saved drafts are not a live editor capture')); assert.ok(queued.text.includes('not Computer Use'));
  assert.deepEqual(await f.execution.sendMessage({ text: 'Explain this paragraph.', idempotencyKey: 'click-1' }), sent); assert.equal(f.calls.filter(c => c[0] === 'enqueue').length, 1);
  await assert.rejects(f.execution.completeReply({ messageId: sent.messageId, text: 'Foreign answer' }, 'other-chat'), { code: 'THREAD_MISMATCH' });
  const returned = await f.execution.completeReply({ messageId: sent.messageId, text: 'Exact returned answer.' }, selection.threadId); assert.equal(returned.status, 'completed');
  assert.equal(f.execution.state().messages[0].reply, 'Exact returned answer.'); assert.deepEqual(await f.execution.completeReply({ messageId: sent.messageId, text: 'Exact returned answer.' }, selection.threadId), returned);
  await assert.rejects(f.execution.completeReply({ messageId: sent.messageId, text: 'Different return.' }, selection.threadId), { code: 'DESKTOP_REPLY_CONFLICT' });
});

test('registered translation execution queues a compact request tool round trip and marks only validated results complete', async t => {
  const f = fixture(t); await f.bind(); const request = register(f), sent = await f.execution.runRequest(f.app, { requestId: request.requestId });
  const queued = f.calls.find(c => c[0] === 'enqueue')[1]; assert.ok(queued.text.includes('bilingual_paper_get_request')); assert.ok(queued.text.includes('bilingual_paper_submit_translation_result')); assert.ok(!queued.text.includes(request.segments[0].text));
  for (const instruction of ['nextOffset', 'resultProtocol', 'batchOffset', 'finalize=true', 'entire registered request completed']) assert(queued.text.includes(instruction));
  assert.equal(sent.requestId, request.requestId); assert.equal((await f.execution.approvedRequest(f.app, request.requestId, selection.threadId)).bindingId, 'desktop:origin-chat');
  await assert.rejects(f.execution.approvedRequest(f.app, request.requestId, 'foreign'), { code: 'THREAD_MISMATCH' });
  await assert.rejects(f.execution.completeRequest(f.app, request.requestId, selection.threadId), { code: 'DESKTOP_RESULT_NOT_VALIDATED' });
  request.status = 'completed'; request.resultHash = 'validated-result'; const done = await f.execution.completeRequest(f.app, request.requestId, selection.threadId); assert.equal(done.status, 'completed');
  assert.equal(f.calls.filter(c => c[0] === 'enqueue').length, 1);
});

test('an unregistered, differently bound or mutated request cannot be sent or receive a result', async t => {
  const f = fixture(t); await f.bind();
  await assert.rejects(f.execution.runRequest(f.app, { requestId: 'unknown' }), { code: 'REQUEST_NOT_APPROVED' });
  const request = register(f, { bindingId: 'desktop:other-chat' }); await assert.rejects(f.execution.runRequest(f.app, { requestId: request.requestId }), { code: 'REQUEST_NOT_APPROVED' }); request.bindingId = 'desktop:origin-chat';
  await f.execution.runRequest(f.app, { requestId: request.requestId }); request.language = 'fr';
  await assert.rejects(f.execution.approvedRequest(f.app, request.requestId, selection.threadId), { code: 'REQUEST_NOT_APPROVED' });
});

test('source changes and release invalidate delayed queue acknowledgments without changing another project', async t => {
  const f = fixture(t); await f.bind(); let entered, resolve; const ready = new Promise(done => { entered = done; });
  f.producer.enqueue = async input => { entered(); return new Promise(done => { resolve = () => done({ threadId: selection.threadId, clientUserMessageId: input.clientUserMessageId, inputHash: digest(input.text), status: 'queued' }); }); };
  const sending = f.execution.sendMessage({ text: 'Wait for the exact paper.', idempotencyKey: 'late' }); await ready;
  f.state.project.snapshotId = 'new-source'; resolve(); await assert.rejects(sending, { code: 'DESKTOP_EXECUTION_STALE' }); assert.equal(f.app.flow.desktopMessages[0].status, 'unknown');
  f.state.project.snapshotId = project.snapshotId; await f.execution.close();
  await assert.rejects(f.execution.completeReply({ messageId: f.app.flow.desktopMessages[0].messageId, text: 'Late answer' }, selection.threadId), { code: 'DESKTOP_EXECUTION_UNAVAILABLE' });
});

test('lost delivery acknowledgment is retained as unknown and a duplicate click cannot resend', async t => {
  const f = fixture(t); await f.bind(); f.producer.enqueue = async input => { f.calls.push(['enqueue', input]); throw Object.assign(Error('Delivery unknown'), { code: 'DESKTOP_QUEUE_DELIVERY_UNCERTAIN' }); };
  await assert.rejects(f.execution.sendMessage({ text: 'Translate this exact selection.', idempotencyKey: 'uncertain' }), { code: 'DESKTOP_QUEUE_DELIVERY_UNCERTAIN' });
  await assert.rejects(f.execution.sendMessage({ text: 'Translate this exact selection.', idempotencyKey: 'uncertain' }), { code: 'DESKTOP_QUEUE_DELIVERY_UNCERTAIN' }); assert.equal(f.calls.filter(c => c[0] === 'enqueue').length, 1);
  assert.equal(f.execution.state().messages[0].status, 'unknown'); assert.equal(f.execution.state().available, false);
  await f.execution.completeReply({ messageId: f.app.flow.desktopMessages[0].messageId, text: 'Proven delivered answer' }, selection.threadId); assert.equal(f.execution.state().available, true);
});


test('registered Desktop execution participates in existing waitJob and resolves only after validated submission', async t => {
  const f = fixture(t); await f.bind(); const request = register(f), sent = await f.execution.runRequest(f.app, { requestId: request.requestId });
  const runtime = f.app.jobs.get(sent.jobId); assert.equal(runtime.kind, 'desktop'); assert.equal(runtime.finished, false); assert.equal(f.app.flow.jobs.find(row => row.jobId === sent.jobId).status, 'queued');
  const waiting = runtime.promise; request.status = 'completed'; request.resultHash = 'validated-result';
  await f.execution.requestSubmitted(f.app, request.requestId, selection.threadId, { requestId: request.requestId, status: 'completed' });
  const completed = await waiting; assert.equal(completed.status, 'completed'); assert.equal(completed.imported.requestId, request.requestId); assert.equal(runtime.finished, true); assert.equal(f.app.flow.jobs.find(row => row.jobId === sent.jobId).status, 'completed');
});

test('cancelling or closing a Desktop job rejects its waiter and revokes only the owned return ticket', async t => {
  const cancelled = fixture(t); await cancelled.bind(); register(cancelled); const sent = await cancelled.execution.runRequest(cancelled.app, { requestId: 'req-1' }), runtime = cancelled.app.jobs.get(sent.jobId);
  runtime.controller.abort(); await assert.rejects(runtime.promise, { code: 'JOB_CANCELLED' });
  await assert.rejects(cancelled.execution.approvedRequest(cancelled.app, 'req-1', selection.threadId), { code: 'REQUEST_NOT_APPROVED' }); assert.equal(cancelled.calls.filter(call => call[0] === 'enqueue').length, 1);
  const closing = fixture(t); await closing.bind(); register(closing); const other = await closing.execution.runRequest(closing.app, { requestId: 'req-1' }), owned = closing.app.jobs.get(other.jobId);
  const waited = assert.rejects(owned.promise, { code: 'DESKTOP_EXECUTION_UNAVAILABLE' }); await closing.execution.close(); await waited; assert.equal(owned.finished, true); assert.equal(closing.calls.filter(call => call[0] === 'enqueue').length, 1);
});


test('a message at the documented 64 KiB limit still fits after its private return receipt is appended', async t => {
  const f = fixture(t); await f.bind(); const sent = await f.execution.sendMessage({ text: 'x'.repeat(64 * 1024), idempotencyKey: 'bounded-large-message' });
  assert.equal(sent.status, 'queued'); assert.equal(f.calls.filter(c => c[0] === 'enqueue').length, 1); assert.ok(Buffer.byteLength(f.calls.find(c => c[0] === 'enqueue')[1].text) > 64 * 1024);
});

test('a proven preflight failure is recorded as not sent and only an explicit later call can retry', async t => {
  const f = fixture(t); await f.bind(); const enqueue = f.producer.enqueue;
  f.producer.enqueue = async input => { f.calls.push(['preflight-failure', input]); throw Object.assign(Error('Control directory occupied'), { code: 'CHAT_IN_USE', deliveryAttempted: false, clientUserMessageId: input.clientUserMessageId }); };
  await assert.rejects(f.execution.sendMessage({ text: 'Explicit author question.', idempotencyKey: 'safe-retry' }), { code: 'CHAT_IN_USE' });
  assert.equal(f.execution.state().messages[0].status, 'failed'); assert.equal(f.execution.state().available, true);
  assert.equal(f.calls.filter(call => call[0] === 'preflight-failure').length, 1); assert.equal(f.calls.some(call => call[0] === 'enqueue'), false);
  f.producer.enqueue = enqueue;
  const sent = await f.execution.sendMessage({ text: 'Explicit author question.', idempotencyKey: 'safe-retry' });
  assert.equal(sent.status, 'queued'); assert.equal(f.app.flow.desktopMessages.length, 2); assert.equal(f.app.flow.desktopMessages[0].status, 'failed');
  assert.deepEqual(await f.execution.sendMessage({ text: 'Explicit author question.', idempotencyKey: 'safe-retry' }), sent); assert.equal(f.calls.filter(call => call[0] === 'enqueue').length, 1);
});
test('an unproven or differently identified no-send error remains unknown and cannot clear delivery protection', async t => {
  const f = fixture(t); await f.bind();
  f.producer.enqueue = async () => { throw Object.assign(Error('Unproven preflight'), { code: 'CHAT_IN_USE', deliveryAttempted: false, clientUserMessageId: 'foreign' }); };
  await assert.rejects(f.execution.sendMessage({ text: 'Preserve uncertainty.', idempotencyKey: 'foreign-proof' }), { code: 'CHAT_IN_USE' });
  assert.equal(f.app.flow.desktopMessages[0].status, 'unknown'); assert.equal(f.execution.state().available, false);
});
test('a registered preflight failure settles its job and requires a fresh selection request', async t => {
  const f = fixture(t); await f.bind(); register(f);
  f.producer.enqueue = async input => { throw Object.assign(Error('Queue control occupied'), { code: 'CHAT_IN_USE', deliveryAttempted: false, clientUserMessageId: input.clientUserMessageId }); };
  await assert.rejects(f.execution.runRequest(f.app, { requestId: 'req-1' }), { code: 'CHAT_IN_USE' });
  const runtime = f.app.jobs.get('desktop-req-1'); assert.equal(runtime.finished, true); await assert.rejects(runtime.promise, { code: 'CHAT_IN_USE' });
  assert.equal(f.app.flow.jobs[0].status, 'failed'); assert.equal(f.execution.state().available, true);
  await assert.rejects(f.execution.runRequest(f.app, { requestId: 'req-1' }), { code: 'DESKTOP_REQUEST_NOT_SENT' });
  assert.equal(f.app.flow.desktopMessages.length, 1);
});

test('delivery history is not a live task and only exact current-scope uncertainty blocks new sends', async t => {
  const f = fixture(t); await f.bind();
  const sent = await f.execution.sendMessage({ text: 'Retain this discussion in the paper history.', idempotencyKey: 'history-only' });
  assert.equal(sent.status, 'queued'); assert.equal(f.app.jobs.size, 0); assert.equal(f.execution.state().available, true);
  const current = { ...f.app.flow.desktopMessages[0], status: 'unknown' };
  for (const [key, value] of [['projectId', 'earlier-paper'], ['snapshotId', 'earlier-source'], ['threadId', 'earlier-chat']]) {
    f.app.flow.desktopMessages.push({ ...current, messageId: `historical-${key}`, [key]: value });
  }
  let projected = f.execution.state();
  assert.equal(projected.available, true); assert.equal(projected.phase, 'ready');
  assert.equal(projected.messages.filter(row => row.historical).length, 3);
  assert.equal(projected.activity.busy, false); assert.deepEqual(projected.activity.activeJobIds, []);
  assert.equal(projected.messages[0].activityState, 'awaiting-result'); assert.equal(projected.messages[0].resultState, 'awaiting-return');
  assert.equal(projected.messages[0].deliveryState, 'acknowledged');
  assert.deepEqual(projected.activity.awaitingResultMessageIds, [sent.messageId]);
  f.app.flow.desktopMessages.push({ ...current, messageId: 'current-uncertain' });
  projected = f.execution.state(); assert.equal(projected.available, false); assert.equal(projected.phase, 'attention');
  assert.equal(projected.activity.busy, false); assert.deepEqual(projected.activity.uncertainMessageIds, ['current-uncertain']);
  assert.equal(f.calls.filter(call => call[0] === 'enqueue').length, 1);
});

test('a registered lost acknowledgment releases its local runtime but retains no-resend uncertainty until a validated return', async t => {
  const f = fixture(t); await f.bind(); const request = register(f);
  f.producer.enqueue = async input => { f.calls.push(['enqueue', input]); throw Object.assign(Error('Acknowledgment lost after delivery may have happened.'), { code: 'DESKTOP_QUEUE_DELIVERY_UNCERTAIN' }); };
  await assert.rejects(f.execution.runRequest(f.app, { requestId: request.requestId }), { code: 'DESKTOP_QUEUE_DELIVERY_UNCERTAIN' });
  const runtime = f.app.jobs.get(`desktop-${request.requestId}`);
  assert.equal(runtime.finished, true); assert.equal(runtime.cancelled, false);
  assert.equal([...f.app.jobs.values()].some(job => !job.finished), false);
  assert.equal(f.execution.state().activity.busy, false);
  assert.equal(f.app.flow.jobs[0].status, 'unknown'); assert.equal(f.execution.state().available, false);
  await assert.rejects(f.execution.runRequest(f.app, { requestId: request.requestId }), { code: 'DESKTOP_QUEUE_DELIVERY_UNCERTAIN' });
  assert.equal(f.calls.filter(call => call[0] === 'enqueue').length, 1);
  request.status = 'completed'; request.resultHash = 'validated-after-lost-ack';
  await f.execution.requestSubmitted(f.app, request.requestId, selection.threadId, { status: 'completed' });
  assert.equal(f.app.flow.jobs[0].status, 'completed'); assert.equal(f.execution.state().available, true);
  assert.equal(f.execution.state().messages[0].status, 'completed');
  await assert.rejects(f.execution.runRequest(f.app, { requestId: request.requestId }), { code: 'VERSION_CONFLICT' });
  assert.equal(f.calls.filter(call => call[0] === 'enqueue').length, 1);
});

test('exact registered result proof calibrates a missed terminal callback without delivery or paper mutation', async t => {
  const f = fixture(t); await f.bind(); const request = register(f);
  const sent = await f.execution.runRequest(f.app, { requestId: request.requestId }), runtime = f.app.jobs.get(sent.jobId);
  assert.equal(f.execution.state().activity.busy, true); assert.deepEqual(f.execution.state().activity.activeJobIds, [sent.jobId]);
  request.status = 'completed'; request.resultHash = 'already-validated-result';
  const preview = f.execution.state(); assert.equal(preview.messages[0].resultState, 'validated'); assert.equal(preview.activity.busy, false);
  assert.equal(runtime.finished, false); assert.equal(f.app.flow.desktopMessages[0].status, 'queued');
  const original = structuredClone(f.state), updated = await f.execution.refreshStatus();
  assert.equal(updated.changed, true); assert.deepEqual(updated.updatedMessageIds, [sent.messageId]); assert.deepEqual(updated.updatedJobIds, [sent.jobId]);
  assert.equal(runtime.finished, true); assert.equal((await runtime.promise).status, 'completed');
  assert.equal(f.app.flow.desktopMessages[0].status, 'completed'); assert.equal(f.app.flow.jobs[0].status, 'completed');
  assert.deepEqual(f.state, original); assert.equal(f.calls.filter(call => call[0] === 'enqueue').length, 1);
  assert.deepEqual(await f.execution.refreshStatus(), { changed: false, updatedMessageIds: [], updatedJobIds: [] });
});

test('status calibration refuses altered requests and preserves owned cancellation and unrelated delivery history', async t => {
  const f = fixture(t); await f.bind(); const request = register(f), sent = await f.execution.runRequest(f.app, { requestId: request.requestId });
  request.status = 'completed'; request.resultHash = 'untrusted-different-context'; request.segments[0].text += ' altered after registration';
  assert.equal(f.execution.state().activity.busy, true);
  const before = structuredClone(f.app.flow); assert.equal((await f.execution.refreshStatus()).changed, false); assert.deepEqual(f.app.flow, before);
  const runtime = f.app.jobs.get(sent.jobId); runtime.controller.abort(); await runtime.cancellation;
  assert.equal(runtime.finished, true); assert.equal(f.execution.state().activity.busy, false);
  assert.equal(f.execution.state().messages[0].resultState, 'cancelled'); assert.equal((await f.execution.refreshStatus()).changed, false);
  assert.equal(f.app.flow.jobs[0].status, 'cancelled'); assert.equal(f.calls.filter(call => call[0] === 'enqueue').length, 1);
});

test('status calibration settles only after durable metadata succeeds and a stale validated result is terminal', async t => {
  const f = fixture(t); await f.bind(); const request = register(f), sent = await f.execution.runRequest(f.app, { requestId: request.requestId });
  const runtime = f.app.jobs.get(sent.jobId); request.status = 'stale'; request.resultHash = 'validated-but-newer-human-draft-retained';
  const persist = f.app._flowAction; let denied = true;
  f.app._flowAction = async work => { const value = await persist(work); if (denied) throw Object.assign(Error('Synthetic metadata persistence denied.'), { code: 'EACCES' }); return value; };
  await assert.rejects(f.execution.refreshStatus(), { code: 'EACCES' }); assert.equal(runtime.finished, false);
  denied = false; const result = await f.execution.refreshStatus(); assert.equal(result.changed, true);
  assert.equal(runtime.finished, true); assert.equal((await runtime.promise).imported.status, 'stale');
  assert.equal(f.app.flow.desktopMessages[0].resultStatus, 'stale'); assert.equal(f.app.flow.jobs[0].status, 'completed');
  assert.equal(f.execution.state().activity.busy, false); assert.equal(f.calls.filter(call => call[0] === 'enqueue').length, 1);
});

test('a validated native result arriving before the queue acknowledgment cannot be downgraded to queued', async t => {
  const f = fixture(t); await f.bind(); const request = register(f);
  let release, entered; const waiting = new Promise(resolve => { entered = resolve; });
  f.producer.enqueue = async (input, { beforeEnqueue } = {}) => {
    await beforeEnqueue?.({ ...selection, cwd: process.cwd() }); f.calls.push(['enqueue', input]); entered();
    await new Promise(resolve => { release = resolve; });
    return { threadId: selection.threadId, clientUserMessageId: input.clientUserMessageId, inputHash: digest(input.text), status: 'queued', queuedSubmissionId: 'queue-late' };
  };
  const sending = f.execution.runRequest(f.app, { requestId: request.requestId }); await waiting;
  const runtime = f.app.jobs.get(`desktop-${request.requestId}`); assert.equal(runtime.finished, false);
  request.status = 'completed'; request.resultHash = 'validated-before-queue-ack';
  await f.execution.requestSubmitted(f.app, request.requestId, selection.threadId, { status: 'completed' });
  assert.equal(runtime.finished, true); assert.equal(f.app.flow.jobs[0].status, 'completed');
  release(); const sent = await sending;
  assert.equal(sent.status, 'completed'); assert.equal(f.app.flow.jobs[0].status, 'completed');
  assert.equal(f.execution.state().messages[0].status, 'completed'); assert.equal(f.execution.state().available, true);
  assert.equal(f.calls.filter(call => call[0] === 'enqueue').length, 1);
});
