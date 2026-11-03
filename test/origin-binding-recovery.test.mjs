import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { OriginChatBinding } from '../src/origin-chat-binding.mjs';

const threadId = 'exact-invoking-chat';
const metadata = { threadId, model: 'gpt-6-astra', effort: 'max', title: 'Verified invoking chat', cwd: os.tmpdir() };
const project = { id: 'synthetic-paper', snapshotId: 'immutable-source-version' };
const unavailable = code => Object.assign(new Error(`Synthetic runtime failure: ${code}`), { code });

function fixture(t, { readMetadata, retryMs = 10 } = {}) {
  const service = new EventEmitter(), calls = { reads: [], binds: [], writerCalls: 0 };
  const retained = { source: 'An unchanged synthetic paper.', translations: ['Retained translation.'], notes: ['Retained review.'], requests: [], transactions: [] };
  const app = new EventEmitter(); let selected = project;
  app.core = { getState: () => ({ project: selected }), async _assertSourceCurrent() {} };
  app.flow = { projectId: project.id }; app.jobs = new Map();
  app.chat = { getState: () => ({ mode: 'unbound', busy: false }), async close() {} };
  app._flowAction = async callback => callback();
  app.createBoundChat = async () => { calls.writerCalls++; throw Error('A Desktop origin must not create or resume a writer.'); };
  service.active = app;
  service.desktopExecution = { async bind({ app: target, project: source, selection }) { calls.binds.push({ app: target, project: source, selection }); } };
  const binding = new OriginChatBinding(service, { threadId, retryMs, readMetadata: async (exactId, options) => { calls.reads.push(exactId); return readMetadata ? readMetadata(exactId, options) : metadata; } });
  t.after(() => binding.close());
  return { service, app, binding, calls, retained, select(next) { selected = next; } };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'The bounded origin retry did not complete.'); await delay(5); }
}

for (const code of ['ENOENT', 'CODEX_COMMAND_UNAVAILABLE', 'CODEX_RUNTIME_UNAVAILABLE', 'CODEX_TIMEOUT', 'CODEX_UNAVAILABLE', 'CODEX_PROCESS_EXITED', 'CODEX_DISCONNECTED', 'ECONNRESET', 'EPIPE']) {
  test(`${code} during startup recovers the same exact Desktop origin without a writer or paper mutation`, async t => {
    let attempts = 0;
    const f = fixture(t, { readMetadata: async () => { if (++attempts === 1) throw unavailable(code); return metadata; } }), before = structuredClone(f.retained);
    const first = await f.binding.reconcile();
    assert.equal(first.phase, 'waiting-runtime'); assert.equal(first.verified, false); assert.equal(first.retryable, true);
    assert.equal(first.error.code, code); assert.equal(first.error.retryable, true); assert.ok(first.nextRetryAt > Date.now());
    assert.equal(f.app.flow.backgroundChatReference, undefined); assert.equal(f.calls.binds.length, 0);
    await waitFor(() => f.binding.state().phase === 'desktop-ready');
    const ready = f.binding.state();
    assert.equal(ready.threadId, threadId); assert.equal(ready.verified, true); assert.equal(ready.retryable, false);
    assert.equal(ready.error, undefined); assert.equal(ready.nextRetryAt, undefined);
    assert.deepEqual(f.calls.reads, [threadId, threadId]); assert.equal(f.calls.binds.length, 1); assert.equal(f.calls.writerCalls, 0);
    assert.equal(f.app.flow.backgroundChatReference.threadId, threadId); assert.equal(f.app.flow.backgroundChatReference.originCwd, metadata.cwd);
    assert.deepEqual(f.retained, before);
  });
}

test('persistent runtime failure keeps a bounded backoff and does not permanently stop the origin scope', async t => {
  const f = fixture(t, { readMetadata: async () => { throw unavailable('CODEX_RUNTIME_UNAVAILABLE'); }, retryMs: 2000 });
  const waits = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = Date.now(), state = await f.binding.reconcile();
    waits.push(state.nextRetryAt - before);
    assert.equal(state.phase, 'waiting-runtime'); assert.equal(state.retryable, true);
    assert.equal(state.verified, false); assert.equal(f.app.flow.backgroundChatReference, undefined);
  }
  assert.equal(f.calls.reads.length, 8); assert.ok(waits[1] >= 3900); assert.ok(waits[3] >= 15900);
  assert.ok(waits.slice(4).every(wait => wait >= 29900 && wait <= 30100), `Retry delay escaped its 30 second cap: ${waits}`);
});

test('foreign metadata remains stopped after a runtime outage and never guesses a replacement identity', async t => {
  let attempts = 0;
  const f = fixture(t, { readMetadata: async () => ++attempts === 1 ? Promise.reject(unavailable('ENOENT')) : { ...metadata, threadId: 'different-chat' } });
  await f.binding.reconcile();
  await waitFor(() => f.binding.state().phase === 'failed');
  const stopped = f.binding.state();
  assert.equal(stopped.verified, false); assert.equal(stopped.error.code, 'THREAD_MISMATCH'); assert.equal(stopped.retryable, false);
  assert.equal(stopped.error.retryable, false); assert.equal(stopped.nextRetryAt, undefined);
  await f.binding.reconcile(); await delay(30);
  assert.deepEqual(f.calls.reads, [threadId, threadId]); assert.equal(f.calls.binds.length, 0); assert.equal(f.calls.writerCalls, 0);
  assert.equal(f.app.flow.backgroundChatReference, undefined);
});

test('a deliberate foreign binding added during runtime backoff is preserved without another metadata read', async t => {
  const f = fixture(t, { readMetadata: async () => { throw unavailable('CODEX_RUNTIME_UNAVAILABLE'); } });
  await f.binding.reconcile();
  const explicit = { projectId: project.id, kind: 'bound-existing-chat', threadId: 'deliberately-selected-chat', model: 'selected-model' };
  f.app.flow.nativeChatBinding = explicit;
  await waitFor(() => f.binding.state().phase === 'preserved-binding');
  assert.equal(f.app.flow.nativeChatBinding, explicit); assert.equal(f.calls.reads.length, 1); assert.equal(f.calls.binds.length, 0);
  assert.equal(f.binding.state().retryable, false); assert.equal(f.binding.state().nextRetryAt, undefined);
});

test('a late successful retry for a previous project cannot bind the newly selected paper', async t => {
  let attempts = 0, release;
  const f = fixture(t, { readMetadata: async () => { if (++attempts === 1) throw unavailable('CODEX_TIMEOUT'); return new Promise(resolve => { release = resolve; }); } });
  await f.binding.reconcile(); await waitFor(() => release);
  f.select({ id: 'new-paper', snapshotId: 'new-source-version' });
  release(metadata); await f.binding.pending;
  assert.equal(f.app.flow.backgroundChatReference, undefined); assert.equal(f.calls.binds.length, 0); assert.equal(f.calls.writerCalls, 0);
});

test('retry cancellation invalidates a late metadata response and close cancels the recovery timer', async t => {
  let attempts = 0, release, firstSignal;
  const f = fixture(t, { readMetadata: async (_id, { signal }) => { if (++attempts === 1) { firstSignal = signal; return new Promise(resolve => { release = resolve; }); } throw unavailable('CODEX_RUNTIME_UNAVAILABLE'); } });
  const pending = f.binding.reconcile(); await Promise.resolve();
  f.binding.retry(); assert.equal(firstSignal.aborted, true);
  release(metadata); await pending;
  assert.equal(f.app.flow.backgroundChatReference, undefined); assert.equal(f.calls.binds.length, 0);
  await waitFor(() => f.binding.state().phase === 'waiting-runtime');
  f.binding.close(); const reads = f.calls.reads.length; await delay(40);
  assert.equal(f.calls.reads.length, reads); assert.equal(f.calls.writerCalls, 0);
});

test('manual retry immediately replaces a long runtime backoff after the runtime returns', async t => {
  let available = false;
  const f = fixture(t, { retryMs: 30000, readMetadata: async () => { if (!available) throw unavailable('CODEX_RUNTIME_UNAVAILABLE'); return metadata; } });
  await f.binding.reconcile(); available = true; f.binding.retry();
  await waitFor(() => f.binding.state().phase === 'desktop-ready');
  assert.deepEqual(f.calls.reads, [threadId, threadId]); assert.equal(f.calls.binds.length, 1); assert.equal(f.calls.writerCalls, 0);
});

test('a missing paper source after metadata verification is terminal and never relabeled as a runtime outage', async t => {
  const f = fixture(t);
  f.app.core._assertSourceCurrent = async () => { throw unavailable('ENOENT'); };
  const state = await f.binding.reconcile();
  assert.equal(state.phase, 'failed'); assert.equal(state.error.code, 'ENOENT'); assert.equal(state.retryable, false); assert.equal(state.error.retryable, false);
  await f.binding.reconcile(); await delay(30);
  assert.equal(f.calls.reads.length, 1); assert.equal(f.calls.binds.length, 0); assert.equal(f.app.flow.backgroundChatReference, undefined);
});
