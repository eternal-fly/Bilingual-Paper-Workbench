import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexBridge, PAPER_TOOL_SPECS, paperRequestSchema, paperRequestPrompt } from '../src/codex-bridge.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t, options = {}) {
  const owned = path.join(root, 'work/codex-tests'); await mkdir(owned, { recursive: true });
  const dataRoot = await mkdtemp(path.join(owned, 'state-'));
  const bridge = new CodexBridge({ dataRoot, cwd: dataRoot, command: process.execPath, commandArgs: [path.join(root, 'test/codex-fake-server.mjs')], ...options });
  const instances = [bridge];
  t.after(async () => { for (const instance of instances) await instance.close(); assert.ok(path.resolve(dataRoot).startsWith(path.resolve(owned) + path.sep)); await rm(dataRoot, { recursive: true, force: true }); });
  await bridge.connect(); return { bridge, dataRoot, instances };
}
test('model selection is explicit and validated against live catalog effort choices', async t => {
  const { bridge } = await fixture(t);
  const models = await bridge.listModels(); assert.equal(models[0].model, 'model-a');
  await assert.rejects(bridge.startChat({}), { code: 'MODEL_REQUIRED' });
  await assert.rejects(bridge.startChat({ model: 'unknown', effort: 'low' }), { code: 'MODEL_UNAVAILABLE' });
  await assert.rejects(bridge.startChat({ model: 'model-a', effort: 'ultra' }), { code: 'EFFORT_UNAVAILABLE' });
});

test('two-PDF review fits one trusted turn without broadening ordinary messages', async t => {
  const { bridge } = await fixture(t); await bridge.startChat({ model: 'model-a', effort: 'low' });
  const text = 'Original and latest PDF reference.\n'.repeat(11000);
  await assert.rejects(bridge.sendMessage({ text }), { code: 'INVALID_INPUT' });
  const queued = await bridge.sendReviewMessage({ text }); const result = await bridge.waitForTurn(queued.turnId);
  assert.equal(result.status, 'completed'); assert.equal(bridge.getState().messages.filter(item => item.role === 'user').length, 1);
  assert.equal(bridge.getState().messages.find(item => item.role === 'user').text, text);
  await assert.rejects(bridge.sendReviewMessage({ text: 'x'.repeat(2 * 1024 * 1024 + 1) }), { code: 'INVALID_INPUT' });
});

test('large review results remain complete and oversized ordinary results never masquerade as complete', async t => {
  const { bridge } = await fixture(t); await bridge.startChat({ model: 'model-a', effort: 'low' });
  const reviewed = await bridge.sendReviewMessage({ text: 'review-output', displayText: 'Only my selected paragraph.', reviewMetadata: { cycleId: 'cycle-synthetic', pairId: 'pair-synthetic' } });
  assert.equal((await bridge.waitForTurn(reviewed.turnId)).status, 'completed'); assert.equal(bridge.getState().messages.at(-1).text, '中'.repeat(100000));
  const user = bridge.getState().messages.find(item => item.turnId === reviewed.turnId && item.role === 'user'); assert.equal(user.text, 'Only my selected paragraph.'); assert.equal(user.reviewMetadata.pairId, 'pair-synthetic');
  const ordinary = await bridge.sendMessage({ text: 'review-output' }); assert.equal((await bridge.waitForTurn(ordinary.turnId)).status, 'failed'); assert.equal(bridge.getState().lastError.code, 'OUTPUT_TOO_LARGE');
});
test('dedicated chat streams only its own events and persists the authoritative thread model', async t => {
  const { bridge, dataRoot, instances } = await fixture(t);
  await bridge.startChat({ model: 'model-a', effort: 'high', title: 'Paper chat' });
  const deltas = []; bridge.on('delta', event => deltas.push(event.delta));
  const queued = await bridge.sendMessage({ text: 'hello' });
  const done = await bridge.waitForTurn(queued.turnId);
  assert.equal(done.status, 'completed');
  assert.equal(bridge.getState().messages.at(-1).text, 'Synthetic response');
  assert.equal(deltas.length, 2); assert.equal(deltas.join(''), 'Synthetic response');
  assert.equal(bridge.getState().provider, 'synthetic');
  assert.equal(bridge.getState().model, 'model-a');
  await bridge.close();
  const reopened = new CodexBridge({ dataRoot, cwd: dataRoot, command: process.execPath, commandArgs: [path.join(root, 'test/codex-fake-server.mjs')] });
  instances.push(reopened); await reopened.connect();
  assert.equal(reopened.getState().messages.length, 2);
  assert.equal(reopened.getState().threadId, 'synthetic-paper-thread');
  assert.equal(reopened.getState().connected, true);
});
test('failed and interrupted turns cannot masquerade as completed results', async t => {
  const { bridge } = await fixture(t); await bridge.startChat({ model: 'model-a', effort: 'low' });
  const failed = await bridge.sendMessage({ text: 'fail' });
  assert.equal((await bridge.waitForTurn(failed.turnId)).status, 'failed');
  const waiting = await bridge.sendMessage({ text: 'wait' }); await bridge.interrupt();
  assert.equal((await bridge.waitForTurn(waiting.turnId)).status, 'interrupted');
});
test('only approved dynamic tool names dispatch to the paper controller', async t => {
  const calls = [];
  const { bridge } = await fixture(t, { toolSpecs: [{ type: 'function', name: 'paper_compile', description: 'Compile selected immutable snapshot', inputSchema: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string' } }, required: ['reason'] } }], handleTool: async call => { calls.push(call); return { ok: true }; } });
  await bridge.startChat({ model: 'model-a', effort: 'low' });
  const queued = await bridge.sendMessage({ text: 'tool' }); await bridge.waitForTurn(queued.turnId);
  assert.equal(calls.length, 1); assert.equal(calls[0].tool, 'paper_compile');
});
test('structured responses are emitted only after a completed turn', async t => {
  const { bridge } = await fixture(t); await bridge.startChat({ model: 'model-a', effort: 'low' });
  const returned = []; bridge.on('structuredResult', result => returned.push(result));
  const queued = await bridge.sendMessage({ text: 'json', outputSchema: { type: 'object', properties: { requestId: { type: 'string' }, ok: { type: 'boolean' } }, required: ['requestId', 'ok'], additionalProperties: false } });
  await bridge.waitForTurn(queued.turnId); assert.deepEqual(returned[0].result, { requestId: 'req-one', ok: true });
});
test('app-server failure resolves the active turn as failed instead of waiting forever', async t => {
  const { bridge } = await fixture(t); await bridge.startChat({ model: 'model-a', effort: 'low' });
  const queued = await bridge.sendMessage({ text: 'exit' });
  const result = await bridge.waitForTurn(queued.turnId, { timeoutMs: 2000 });
  assert.equal(result.status, 'failed'); assert.equal(bridge.getState().connected, false);
});
test('a stopped owned app-server can reconnect without mistaking its own chat lock for another owner', async t => {
  const { bridge } = await fixture(t); await bridge.startChat({ model: 'model-a', effort: 'low' });
  const threadId = bridge.getState().threadId;
  const queued = await bridge.sendMessage({ text: 'exit' });
  assert.equal((await bridge.waitForTurn(queued.turnId, { timeoutMs: 2000 })).status, 'failed');
  await bridge.connect();
  assert.equal(bridge.getState().connected, true);
  assert.equal(bridge.getState().threadId, threadId);
  assert.equal((await bridge.listModels())[0].model, 'model-a');
});
test('a persisted paper identity cannot be silently adopted by a different paper', async t => {
  const { bridge, dataRoot, instances } = await fixture(t);
  await bridge.bindPaper({ projectId: 'project-' + 'a'.repeat(24) });
  await assert.rejects(bridge.bindPaper({ projectId: 'project-' + 'b'.repeat(24) }), { code: 'PAPER_CHAT_MISMATCH' });
  await bridge.close();
  const wrong = new CodexBridge({ dataRoot, cwd: dataRoot, paperBinding: 'project-' + 'b'.repeat(24), command: process.execPath, commandArgs: [path.join(root, 'test/codex-fake-server.mjs')] }); instances.push(wrong);
  await assert.rejects(wrong.connect(), { code: 'PAPER_CHAT_MISMATCH' });
});
test('paper response schemas bind exact request and selected segment identifiers', () => {
  const request = { requestId: 'req-one', kind: 'revision', language: 'zh-CN', segments: [{ segmentId: 'segment-one', beforeHash: 'a'.repeat(64), text: 'Source ⟦P1⟧.', translationDraft: { text: '译稿' } }] };
  const schema = paperRequestSchema(request);
  assert.equal(schema.properties.requestId.const, 'req-one');
  assert.deepEqual(schema.properties.edits.items.properties.segmentId.enum, ['segment-one']);
  assert.equal(schema.additionalProperties, false);
  assert.ok(paperRequestPrompt(request).includes('untrusted manuscript data'));
  assert.ok(paperRequestPrompt(request).includes('译稿'));
  assert.throws(() => paperRequestSchema({ ...request, segments: [] }), { code: 'INVALID_INPUT' });
});
test('streamed Chinese and emoji survive deliberately split UTF-8 transport chunks', async t => {
  const { bridge } = await fixture(t); await bridge.startChat({ model: 'model-a', effort: 'low' });
  const deltas = []; bridge.on('delta', item => deltas.push(item.delta));
  const queued = await bridge.sendMessage({ text: 'unicode' }); await bridge.waitForTurn(queued.turnId);
  assert.equal(deltas.join(''), '中文🙂逐字流式回包');
});

test('global MCP servers and newly added native paper tools are absent from standalone model context', async t => {
  const { bridge } = await fixture(t, { toolSpecs: PAPER_TOOL_SPECS, commandArgs: [path.join(root, 'test/codex-fake-server.mjs'), '--global-mcp'] });
  await bridge.startChat({ model: 'model-a', effort: 'low' });
  const queued = await bridge.sendMessage({ text: 'inspect-mcp-context' }); await bridge.waitForTurn(queued.turnId);
  const context = JSON.parse(bridge.getState().messages.at(-1).text);
  assert.deepEqual(context.activeMcpServers, []); assert.deepEqual(context.dynamicTools, PAPER_TOOL_SPECS.map(tool => tool.name));
  assert.ok(context.configReads >= 2, 'Each turn must see newly configured MCP names before inference.');
  assert.equal(context.forwardedCredential, false); assert.ok(!JSON.stringify(bridge.getState()).includes('synthetic-private-token'));
});
test('resuming an existing worker applies fresh MCP isolation without altering its thread identity', async t => {
  const { bridge } = await fixture(t, { commandArgs: [path.join(root, 'test/codex-fake-server.mjs'), '--global-mcp'] });
  await bridge.resumeChat({ threadId: 'legacy-worker-thread', model: 'model-a', effort: 'low' });
  const queued = await bridge.sendReviewMessage({ text: 'inspect-mcp-context' }); await bridge.waitForTurn(queued.turnId);
  assert.equal(bridge.getState().threadId, 'legacy-worker-thread'); assert.deepEqual(JSON.parse(bridge.getState().messages.at(-1).text).activeMcpServers, []);
});
test('unreadable or malformed MCP inventory fails closed before worker thread creation', async t => {
  for (const option of ['--unreadable-mcp', '--malformed-mcp']) await t.test(option, async subtest => {
    const { bridge } = await fixture(subtest, { commandArgs: [path.join(root, 'test/codex-fake-server.mjs'), option] });
    await assert.rejects(bridge.startChat({ model: 'model-a', effort: 'low' }), { code: 'MCP_ISOLATION_UNAVAILABLE' });
    assert.equal(bridge.getState().threadId, null); assert.equal(bridge.getState().messages.length, 0);
  });
});
test('falsy malformed MCP pagination fails closed before any model turn', async t => {
  for (const cursor of [0, false, '']) await t.test(JSON.stringify(cursor), async subtest => {
    const { bridge } = await fixture(subtest, { commandArgs: [path.join(root, 'test/codex-fake-server.mjs'), '--malformed-mcp-cursor', JSON.stringify(cursor)] });
    await assert.rejects(bridge.startChat({ model: 'model-a', effort: 'low' }), { code: 'MCP_ISOLATION_UNAVAILABLE' });
    assert.equal(bridge.getState().mcpIsolation.verified, false);
    await assert.rejects(bridge.sendMessage({ text: 'A malformed inventory must never reach inference.' }), { code: 'MCP_ISOLATION_UNAVAILABLE' });
    assert.equal(bridge.getState().messages.length, 0);
    assert.equal(bridge.getState().busy, false);
  });
});
test('a runtime that ignores scoped MCP overrides cannot expose those tools to a model turn', async t => {
  const { bridge } = await fixture(t, { commandArgs: [path.join(root, 'test/codex-fake-server.mjs'), '--global-mcp', '--ignore-mcp-disable'] });
  await assert.rejects(bridge.startChat({ model: 'model-a', effort: 'low' }), { code: 'MCP_ISOLATION_UNAVAILABLE' });
  assert.equal(bridge.getState().mcpIsolation.verified, false);
  await assert.rejects(bridge.sendMessage({ text: 'Do not run while native tools remain visible.' }), { code: 'MCP_ISOLATION_UNAVAILABLE' });
  assert.equal(bridge.getState().messages.length, 0);
});
test('verified ephemeral workers can send without a nonexistent rollout resume while still rechecking MCP isolation', async t => {
  const { bridge } = await fixture(t, { commandArgs: [path.join(root, 'test/codex-fake-server.mjs'), '--ephemeral-cannot-resume'] });
  await bridge.startChat({ model: 'model-a', effort: 'low', ephemeral: true });
  const queued = await bridge.sendMessage({ text: 'inspect-mcp-context' }); await bridge.waitForTurn(queued.turnId);
  const context = JSON.parse(bridge.getState().messages.at(-1).text);
  assert.ok(context.configReads >= 2); assert.deepEqual(context.activeMcpServers, []); assert.equal(bridge.getState().mcpIsolation.verified, true);
});
