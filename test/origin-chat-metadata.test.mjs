import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { OriginMetadataBridge, readOriginChatMetadata, resolveOriginChatCwd } from '../src/origin-chat-binding.mjs';
import { CodexBridge } from '../src/codex-bridge.mjs';

test('the origin reader rejects settings, writer acquisition, turns, history and unrelated chats before transport', async () => {
  const reader = new OriginMetadataBridge({ threadId: 'origin', dataRoot: os.tmpdir(), cwd: os.tmpdir() });
  for (const [method, params] of [['thread/start', {}], ['thread/resume', { threadId: 'origin' }], ['turn/start', {}], ['thread/settings/update', {}], ['thread/read', { threadId: 'origin', includeTurns: true }], ['thread/read', { threadId: 'other', includeTurns: false }], ['thread/read', { threadId: 'origin', includeTurns: false, extra: true }]]) await assert.rejects(reader._request(method, params), { code: 'METADATA_ONLY' });
  assert.equal(reader._child, null); assert.equal(reader._pending.size, 0);
});
test('metadata verification inherits exact current model, effort and project without turns or rollout content', async () => {
  const calls = [];
  class Reader { async connect() { calls.push(['connect']); } async _request(...args) { calls.push(args); return { thread: { id: 'origin', model: 'gpt-6-astra', reasoningEffort: 'max', name: 'Invoking task', cwd: os.tmpdir(), preview: 'must not be returned', turns: [{ content: 'must not be returned' }] } }; } async close() { calls.push(['close']); } }
  const result = await readOriginChatMetadata({ threadId: 'origin', dataRoot: os.tmpdir(), cwd: os.tmpdir(), Bridge: Reader });
  assert.deepEqual(result, { threadId: 'origin', model: 'gpt-6-astra', effort: 'max', title: 'Invoking task', cwd: os.tmpdir() });
  assert.deepEqual(calls, [['connect'], ['thread/read', { threadId: 'origin', includeTurns: false }], ['close']]);
});
test('a foreign identity or unavailable originating project never becomes a fallback binding', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'origin-cwd-')); t.after(() => rm(root, { recursive: true, force: true }));
  class Reader { async connect() {} async _request() { return { thread: { id: 'foreign', model: 'valid-model', cwd: root } }; } async close() {} }
  await assert.rejects(readOriginChatMetadata({ threadId: 'origin', dataRoot: root, cwd: root, Bridge: Reader }), { code: 'THREAD_MISMATCH' });
  const flow = { backgroundChatReference: { source: 'originating-host-chat', threadId: 'origin', originCwd: path.join(root, 'missing') } };
  await assert.rejects(resolveOriginChatCwd({ flow, threadId: 'origin', fallback: root }), { code: 'ORIGIN_WORKSPACE_UNAVAILABLE' });
});
test('resuming an origin chat preserves its host project while paper context remains private', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'origin-cwd-')); t.after(() => rm(root, { recursive: true, force: true }));
  const host = path.join(root, 'host-project'), context = path.join(root, 'private-context'); await mkdir(host); await mkdir(context);
  const flow = { backgroundChatReference: { source: 'originating-host-chat', threadId: 'origin', originCwd: host } };
  const cwd = await resolveOriginChatCwd({ flow, threadId: 'origin', fallback: context }); assert.equal(cwd, host);
  let payload;
  const client = { cwd, _request: async (method, input) => { assert.equal(method, 'thread/resume'); payload = input; return { thread: { id: 'origin' } }; }, _verifyThread() {}, async _verifyMcpIsolation() {}, async _persist() {}, _changed() {}, getState() { return {}; } };
  await CodexBridge.prototype._resumeThread.call(client, 'origin', { model: 'gpt-6-astra', effort: 'max' }, {});
  assert.equal(payload.cwd, host); assert.deepEqual(payload.runtimeWorkspaceRoots, [host]); assert.notEqual(payload.cwd, context);
  assert.equal(await resolveOriginChatCwd({ flow, threadId: 'explicit-other-chat', fallback: context }), context);
});
