import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceService } from '../src/workspace-service.mjs';
import { connectExistingChat } from '../src/existing-chat-binding.mjs';

const threadId = 'exact-originating-chat';
const project = { id: 'source-project', snapshotId: 'source-snapshot', mainFile: 'main.tex' };
function fakeApp() {
  const app = new EventEmitter(); let current = null;
  const calls = { reads: 0, resumes: [], closes: 0 };
  app.jobs = new Map(); app.flow = { projectId: project.id }; app.backgroundMode = true;
  app.core = { getState: () => ({ project: current }), async _assertSourceCurrent() {} };
  app.getState = () => ({ project: current, segments: [], translations: { 'zh-CN': { p: { text: '既有译文', revision: 4 } } }, reviewNotes: [{ noteId: 'retained-note' }], proposals: [], transactions: [], nativeChatBinding: app.flow.nativeChatBinding || app.flow.backgroundChatReference || null, chat: app.chat?.getState() });
  app._flowAction = async callback => { const result = await callback(); app.emit('change'); return result; };
  const chat = { getState: () => ({ connected: calls.resumes.length > 0, threadId, boundThreadId: threadId, mode: 'bound-existing-chat', busy: false }), async close() { calls.closes++; } };
  app.attachChat = next => { app.chat = next; };
  app.createBoundChat = async () => chat;
  app.connectExistingChat = async input => { calls.resumes.push(input); app.chat = chat; return chat.getState(); };
  app.close = async () => { await app.chat?.close(); };
  return { app, calls, setProject(value = project) { current = value; app.flow.projectId = value?.id; } };
}
function fixture(t, options = {}) {
  const f = fakeApp(), root = path.join(os.tmpdir(), 'origin-binding-fixture');
  const service = new WorkspaceService({ initialApp: f.app, factory: async () => f.app, dataRoot: root, codexRoot: root,
    originThreadId: threadId,
    readOriginMetadata: async id => { f.calls.reads++; assert.equal(id, threadId); return { threadId, title: 'Invoking paper chat', model: 'gpt-6-astra', effort: 'max', cwd: os.tmpdir() }; },
    ...options,
  });
  t.after(async () => service.close()); return { ...f, service };
}
test('trusted launch identity is visible before paper import without reading or creating a chat', async t => {
  const f = fixture(t), origin = f.service.getState().originatingChat;
  assert.equal(origin?.threadId, threadId); assert.equal(origin.phase, 'pending-paper'); assert.equal(origin.verified, false);
  assert.equal(f.calls.reads, 0); assert.equal(f.calls.resumes.length, 0);
});
test('the imported paper automatically verifies and binds its invoking chat with actual model/effort', async t => {
  const f = fixture(t); f.setProject(); const before = f.app.getState();
  await f.service.originChat.reconcile();
  const state = f.service.getState(), origin = state.originatingChat;
  assert.equal(origin.phase, 'connected'); assert.equal(origin.verified, true); assert.equal(f.calls.reads, 1);
  assert.equal(state.nativeChatBinding.threadId, threadId); assert.equal(state.nativeChatBinding.model, 'gpt-6-astra'); assert.equal(state.nativeChatBinding.effort, 'max');
  assert.equal(state.nativeChatBinding.originCwd, os.tmpdir());
  assert.equal(f.calls.resumes.length, 1); assert.equal(f.calls.resumes[0].threadId, threadId);
  assert.deepEqual(state.translations, before.translations); assert.deepEqual(state.reviewNotes, before.reviewNotes); assert.deepEqual(state.transactions, []);
  await f.service.originChat.reconcile(); assert.equal(f.calls.reads, 1); assert.equal(f.calls.resumes.length, 1);
});

test('Desktop execution verifies the originating chat without resuming or creating a competing writer', async t => {
  let binds = 0;
  const f = fixture(t); f.setProject();
  f.service.desktopExecution = { async bind({ app, selection }) { binds++; assert.equal(app, f.app); assert.equal(selection.threadId, threadId); }, state() { return { mode: 'desktop-queue', available: true, threadId }; }, async close() {} };
  f.app.createBoundChat = async () => { throw Error('Desktop owns this writer.'); };
  await f.service.originChat.reconcile();
  assert.equal(f.service.getState().originatingChat.phase, 'desktop-ready');
  assert.equal(binds, 1); assert.equal(f.calls.resumes.length, 0);
  await f.service.originChat.reconcile(); assert.equal(binds, 1); assert.equal(f.calls.reads, 1);
});

test('verified Desktop model observations refresh the origin cache without a second binding or thread read', async t => {
  let binds = 0; const f = fixture(t); f.setProject();
  f.service.desktopExecution = { async bind() { binds++; }, state() { return { mode: 'desktop-queue', available: true, threadId }; }, async close() {} };
  await f.service.originChat.reconcile(); const generation = f.service.originChat.generation;
  const selection = { threadId, model: 'new-verified-model', effort: null, title: 'Current chat title', verifiedAt: new Date().toISOString() };
  f.service.originChat.observeDesktopSelection({ app: f.app, projectId: project.id, snapshotId: project.snapshotId, selection });
  assert.equal(f.service.getState().originatingChat.model, selection.model); assert.equal(f.service.getState().originatingChat.effort, null); assert.equal(f.service.originChat.cached.selection, selection);
  await f.service.originChat.reconcile(); assert.equal(binds, 1); assert.equal(f.calls.reads, 1); assert.equal(f.service.originChat.generation, generation);
});
test('an occupied originating writer retains its verified identity and waits instead of requiring manual binding', async t => {
  const f = fixture(t); f.setProject(); f.app.connectExistingChat = async () => { throw Object.assign(Error('thread already has an active writer'), { code: 'THREAD_IN_USE' }); };
  await f.service.originChat.reconcile(); const state = f.service.getState();
  assert.equal(state.originatingChat.phase, 'waiting-desktop-release'); assert.equal(state.nativeChatBinding.threadId, threadId);
  assert.equal(state.originatingChat.error.code, 'THREAD_IN_USE'); assert.equal(f.calls.reads, 1);
});
test('a deliberate different saved chat binding is preserved without querying or taking it over', async t => {
  const f = fixture(t); f.setProject(); f.app.flow.nativeChatBinding = { projectId: project.id, kind: 'bound-existing-chat', threadId: 'explicit-other-chat', model: 'selected-model', effort: 'high' };
  const stored = structuredClone(f.app.flow); await f.service.originChat.reconcile();
  assert.equal(f.service.getState().originatingChat.phase, 'preserved-binding'); assert.deepEqual(f.app.flow, stored); assert.equal(f.calls.reads, 0); assert.equal(f.calls.resumes.length, 0);
});
test('the same invoking chat refreshes a stale saved selection while Desktop owns its writer', async t => {
  const f = fixture(t); f.setProject();
  f.app.flow.nativeChatBinding = { projectId: project.id, kind: 'bound-existing-chat', threadId, title: 'Old title', model: 'gpt-6-astra', effort: 'medium' };
  f.app.connectExistingChat = async () => { throw Object.assign(Error('thread already has an active writer'), { code: 'THREAD_IN_USE' }); };
  await f.service.originChat.reconcile(); const state = f.service.getState();
  assert.equal(state.originatingChat.phase, 'waiting-desktop-release'); assert.equal(state.nativeChatBinding.effort, 'max'); assert.equal(state.nativeChatBinding.title, 'Invoking paper chat'); assert.equal(state.nativeChatBinding.originCwd, os.tmpdir());
});
test('foreign metadata fails closed and a late source-switch result cannot bind a different paper', async t => {
  const wrong = fixture(t, { readOriginMetadata: async () => ({ threadId: 'foreign', model: 'gpt-6-astra', effort: 'max' }) }); wrong.setProject();
  await wrong.service.originChat.reconcile(); assert.equal(wrong.service.getState().originatingChat.phase, 'failed'); assert.equal(wrong.app.flow.backgroundChatReference, undefined);
  let resolve; const late = fixture(t, { readOriginMetadata: () => new Promise(done => { resolve = done; }) }); late.setProject();
  const pending = late.service.originChat.reconcile(); await Promise.resolve();
  const other = fakeApp(); other.setProject({ ...project, id: 'another-project', snapshotId: 'another-snapshot' }); late.service.active = other.app;
  resolve({ threadId, model: 'gpt-6-astra', effort: 'max', cwd: os.tmpdir() }); await pending;
  assert.equal(late.app.flow.backgroundChatReference, undefined); assert.equal(other.app.flow.backgroundChatReference, undefined); assert.equal(late.calls.resumes.length, 0);
});
test('compilation delays activation, not verified binding, and an explicit release stays released', async t => {
  const f = fixture(t); f.setProject(); f.app.jobs.set('compile', { finished: false });
  await f.service.originChat.reconcile(); assert.equal(f.service.getState().originatingChat.phase, 'waiting-paper-operation'); assert.equal(f.service.getState().nativeChatBinding.threadId, threadId); assert.equal(f.calls.resumes.length, 0);
  f.app.jobs.get('compile').finished = true; await f.service.originChat.reconcile(); assert.equal(f.calls.reads, 1); assert.equal(f.calls.resumes.length, 1);
  f.app.backgroundConnection.phase = 'released'; await f.service.originChat.reconcile(); assert.equal(f.service.getState().originatingChat.phase, 'released'); assert.equal(f.service.getState().originatingChat.autoConnect, false); assert.equal(f.calls.resumes.length, 1);
});
test('a long import does not cause a zero-delay state-event retry loop', async t => {
  const f = fixture(t); f.setProject(); f.service._assistantImportPromise = Promise.resolve();
  let changes = 0; f.service.on('change', () => { changes++; });
  await f.service.originChat.reconcile(); await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(changes <= 2, `Import waiting produced ${changes} redundant state events.`); assert.equal(f.calls.reads, 0);
  f.service._assistantImportPromise = null;
});


test('a manual binding started during metadata verification delays origin reference mutation and chat replacement', async t => {
  let resolveMetadata;
  const f = fixture(t, { readOriginMetadata: () => new Promise(resolve => { resolveMetadata = resolve; }) }); f.setProject();
  const previous = { getState: () => ({ mode: 'unbound', busy: false }), async close() { f.calls.closes++; } }; f.app.chat = previous;
  const pending = f.service.originChat.reconcile(); await Promise.resolve();
  f.app._bindingPending = true; f.app._pendingOps = 1;
  resolveMetadata({ threadId, model: 'gpt-6-astra', effort: 'max', cwd: os.tmpdir() }); await pending;
  assert.equal(f.service.getState().originatingChat.phase, 'waiting-paper-operation');
  assert.equal(f.app.flow.backgroundChatReference, undefined); assert.equal(f.app.chat, previous); assert.equal(f.calls.closes, 0); assert.equal(f.calls.resumes.length, 0);
  f.app._bindingPending = false; f.app._pendingOps = 0;
});

test('origin chat creation reserves the binding operation before a manual connection can interleave', async t => {
  const f = fixture(t); f.setProject();
  let created, release; const creation = new Promise(resolve => { created = resolve; }); let manualCreates = 0;
  const originChat = { getState: () => ({ mode: 'bound-existing-chat', threadId, busy: false }), async close() { f.calls.closes++; } };
  const manualChat = { getState: () => ({ mode: 'bound-existing-chat', threadId: 'manual-other-chat', busy: false }), async connect() {}, async bindPaper() {}, async resumeChat() { return { threadId: 'manual-other-chat', model: 'manual-model' }; }, async close() {} };
  f.app.createBoundChat = async selected => { if (selected !== threadId) { manualCreates++; return manualChat; } created(); return new Promise(resolve => { release = resolve; }); };
  f.app._projectOperation = work => { f.app._pendingOps = (f.app._pendingOps || 0) + 1; return Promise.resolve().then(work).finally(() => { f.app._pendingOps--; }); };
  const pending = f.service.originChat.reconcile(); await creation;
  const manual = await connectExistingChat(f.app, { threadId: 'manual-other-chat', model: 'manual-model', expectedProjectId: project.id, expectedSnapshotId: project.snapshotId }).then(() => ({ code: 'UNEXPECTED_SUCCESS' }), error => error);
  release(originChat); await pending;
  assert.equal(manual.code, 'CHAT_BUSY'); assert.equal(manualCreates, 0); assert.equal(f.app._bindingPending, false);
  assert.equal(f.service.getState().originatingChat.phase, 'connected'); assert.equal(f.app.flow.backgroundChatReference.threadId, threadId);
});

test('a different completed binding during deferred origin creation is preserved and the unused candidate is closed', async t => {
  const f = fixture(t); f.setProject();
  let created, release; const creation = new Promise(resolve => { created = resolve; }); let candidateCloses = 0;
  const candidate = { getState: () => ({ mode: 'bound-existing-chat', threadId, busy: false }), async close() { candidateCloses++; } };
  f.app.createBoundChat = async () => { created(); return new Promise(resolve => { release = resolve; }); };
  const pending = f.service.originChat.reconcile(); await creation;
  const manual = { getState: () => ({ mode: 'bound-existing-chat', threadId: 'manual-other-chat', busy: false }), async close() {} };
  const manualBinding = { projectId: project.id, kind: 'bound-existing-chat', threadId: 'manual-other-chat', model: 'manual-model' };
  f.app.chat = manual; f.app.flow.nativeChatBinding = manualBinding;
  release(candidate); await pending;
  assert.equal(f.app.chat, manual); assert.equal(f.app.flow.nativeChatBinding, manualBinding); assert.equal(candidateCloses, 1); assert.equal(f.calls.resumes.length, 0); assert.equal(f.app._bindingPending, false);
});
