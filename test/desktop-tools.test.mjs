import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PaperApplication } from '../src/application.mjs';
import { DesktopExecution } from '../src/desktop-execution.mjs';
import { DesktopTranslationTasks } from '../src/translation-tasks.mjs';
import { createPaperServer } from '../src/server.mjs';
import { callBackgroundModelTool } from '../src/native-tool-dispatch.mjs';
import { MODEL_CONTEXT_BYTES } from '../src/request-budgets.mjs';
import { AUTHOR_FIDELITY_POLICY } from '../src/author-fidelity-policy.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)), threadId = 'exact-desktop-chat';
const hash = text => createHash('sha256').update(text).digest('hex');
async function connect(t, options) { const server = createPaperServer({ uiHtml: '<!doctype html>', relayHtml: '<!doctype html>', ...options }), client = new Client({ name: 'desktop-tools-test', version: '1' }), [cs, ss] = InMemoryTransport.createLinkedPair(); await server.connect(ss); await client.connect(cs); t.after(async () => { await client.close(); await server.close(); }); return client; }
async function fixture(t, count = 17) {
  const owned = path.join(root, 'work/desktop-tools-tests'); await mkdir(owned, { recursive: true }); const temporary = await mkdtemp(path.join(owned, 'case-')), source = path.join(temporary, 'source'); await mkdir(source);
  const original = '\\documentclass{article}\n\\begin{document}\n\n' + Array.from({ length: count }, (_, i) => `Paragraph ${i} protects $x_{${i}}=1$ and \\cite{ref${i}}.`).join('\n\n') + '\n\n\\end{document}\n'; const filename = path.join(source, 'main.tex'); await writeFile(filename, original);
  const app = new PaperApplication({ dataRoot: path.join(temporary, 'private') }); await app.openProject({ root: source, mainFile: 'main.tex', targetLanguage: 'zh-CN' });
  const service = new Proxy(new EventEmitter(), { get(target, key) { if (key in target) return typeof target[key] === 'function' ? target[key].bind(target) : target[key]; return typeof app[key] === 'function' ? app[key].bind(app) : app[key]; } }); service.active = app;
  const deliveries = [], producer = { state: () => ({ desktopQueueVerified: true }), async enqueue(input, { beforeEnqueue } = {}) { await beforeEnqueue?.({ threadId, title: 'Synthetic Desktop paper', model: 'gpt-6-astra', effort: 'max', cwd: source }); deliveries.push(input); return { threadId, clientUserMessageId: input.clientUserMessageId, inputHash: hash(input.text), status: 'queued', queuedSubmissionId: `q-${deliveries.length}` }; }, async close() {} };
  const execution = service.desktopExecution = new DesktopExecution(service, { createProducer: async () => producer }); const project = app.getState().project;
  await app._flowAction(() => { app.flow.backgroundChatReference = { projectId: project.id, threadId, model: 'gpt-6-astra', effort: 'max' }; }); await execution.bind({ app, project, selection: { threadId, model: 'gpt-6-astra', effort: 'max' } });
  app.desktopExecutionEnabled = true; app.desktopThreadId = () => execution.state().threadId; app.desktopRequestRunner = input => execution.runRequest(app, input);
  app.translationTasks = new DesktopTranslationTasks(app, { getThreadId: () => threadId, enqueue: input => execution.enqueueForApp(app, input) }); service.getHostContext = () => ({ native: true, taskIdAvailable: true, hostTaskId: threadId });
  service.startTranslationTask = input => app.translationTasks.start(input); service.cancelTranslationTask = input => app.translationTasks.cancel(input); service.resumeTranslationTask = input => app.translationTasks.resume(input); service.desktopSendMessage = input => execution.sendMessage(input); service.runDesktopRequest = input => execution.runRequest(app, input);
  t.after(async () => { await execution.close(); await app.close(); assert.equal(await readFile(filename, 'utf8'), original); assert.ok(temporary.startsWith(owned + path.sep)); await rm(temporary, { recursive: true, force: true }); });
  const client = await connect(t, { service, nativeThreadId: threadId });
  return { app, service, execution, client, deliveries, filename, original, project, async start(scope = 'all', sourceSegmentIds) { return app.translationTasks.start({ scope, ...(sourceSegmentIds ? { sourceSegmentIds } : {}), language: 'zh-CN', expectedProjectId: project.id, expectedSnapshotId: project.snapshotId }); } };
}
const translated = packet => packet.batch.segments.map(segment => ({ segmentId: segment.segmentId || segment.id, text: segment.text.replace('Paragraph', 'Translated paragraph') }));

test('existing native get/submit tools complete a selected 17-paragraph protected task through one Desktop delivery', async t => {
  const f = await fixture(t, 25), ids = f.app.getState().readingParagraphs.slice(2, 19).map(row => row.id), started = await f.start('selected', ids), processedIds = []; let processed = 0, batches = 0, firstReturn;
  for (;;) {
    const response = await f.client.callTool({ name: 'bilingual_paper_get_request', arguments: { requestId: started.taskId } }); assert.equal(response.isError, undefined, response._meta?.paperError?.message); assert.equal(response._meta?.paperUiToken, undefined); const packet = JSON.parse(response.content[0].text);
    assert.ok(Buffer.byteLength(response.content[0].text) <= MODEL_CONTEXT_BYTES); if (!packet.batch) { assert.equal(packet.status, 'completed'); assert.equal(packet.completed, ids.length); assert.equal(packet.remaining, 0); break; } assert.deepEqual(response.structuredContent.batch, packet.batch); assert.ok(response.structuredContent.batch.segments[0].protectedTokens.length >= 2);
    assert(packet.instruction.includes(AUTHOR_FIDELITY_POLICY)); assert(f.deliveries[0].text.includes(AUTHOR_FIDELITY_POLICY));
    processed += packet.batch.segmentIds.length; processedIds.push(...packet.batch.segmentIds); batches++;
    const payload = { requestId: packet.batch.requestId, translations: translated(packet) }; firstReturn ||= payload;
    const returned = await f.client.callTool({ name: 'bilingual_paper_submit_translation_result', arguments: payload }); assert.equal(returned.isError, undefined, returned._meta?.paperError?.message); if (processed < 17) assert.equal(returned.structuredContent.nextTaskRequestId, started.taskId);
  }
  assert.equal(processed, 17); assert.deepEqual(processedIds, ids); assert.equal(batches, 1); assert.equal(f.deliveries.length, 1); assert.deepEqual(Object.keys(f.app.getState().translations['zh-CN']).sort(), [...ids].sort());
  const replay = await f.client.callTool({ name: 'bilingual_paper_submit_translation_result', arguments: firstReturn }); assert.equal(replay.isError, undefined); assert.equal(replay.structuredContent.status, 'completed'); assert.equal(f.app.getState().translations['zh-CN'][firstReturn.translations[0].segmentId].revision, 1);
});

test('native caller identity cannot be supplied by model arguments and a different chat cannot read or return task batches', async t => {
  const f = await fixture(t), started = await f.start(), other = await connect(t, { service: f.service, nativeThreadId: 'other-chat' });
  const denied = await other.callTool({ name: 'bilingual_paper_get_request', arguments: { requestId: started.taskId } }); assert.equal(denied.isError, true); assert.match(denied.structuredContent.error.code, /ORIGIN|THREAD/);
  const spoofed = await f.client.callTool({ name: 'bilingual_paper_get_request', arguments: { requestId: started.taskId, originThreadId: threadId } }); assert.equal(spoofed.isError, true);
  const packet = JSON.parse((await f.client.callTool({ name: 'bilingual_paper_get_request', arguments: { requestId: started.taskId } })).content[0].text);
  assert(packet.instruction.includes(AUTHOR_FIDELITY_POLICY)); assert(f.deliveries[0].text.includes(AUTHOR_FIDELITY_POLICY));
  const wrong = await other.callTool({ name: 'bilingual_paper_submit_translation_result', arguments: { requestId: packet.batch.requestId, translations: translated(packet) } }); assert.equal(wrong.isError, true); assert.equal(Object.keys(f.app.getState().translations['zh-CN'] || {}).length, 0);
  const broken = translated(packet); broken[0].text = 'Missing formulas'; const protectedResult = await f.client.callTool({ name: 'bilingual_paper_submit_translation_result', arguments: { requestId: packet.batch.requestId, translations: broken } }); assert.equal(protectedResult.structuredContent.error.code, 'PROTECTED_TOKEN_CHANGED');
});

test('regular Desktop revision and message replies return through existing native tools after core validation', async t => {
  const f = await fixture(t, 1), segment = f.app.getState().readingParagraphs[0];
  const request = await f.app.createRequest({ kind: 'revision', language: 'zh-CN', segmentIds: [segment.id], bindingId: `desktop:${threadId}`, prompt: 'Clarify this claim.' }); const queued = await f.execution.runRequest(f.app, { requestId: request.requestId });
  const packet = await f.client.callTool({ name: 'bilingual_paper_get_request', arguments: { requestId: request.requestId } }); assert.equal(packet.isError, undefined, packet._meta?.paperError?.message);
  assert(packet.structuredContent.instruction.includes(AUTHOR_FIDELITY_POLICY)); assert(f.deliveries[0].text.includes(AUTHOR_FIDELITY_POLICY));
  const selected = JSON.parse(packet.content[0].text).segments[0], proposed = await f.client.callTool({ name: 'bilingual_paper_propose_revision', arguments: { requestId: request.requestId, edits: [{ segmentId: selected.id, beforeHash: selected.beforeHash, replacement: selected.text.replace('Paragraph', 'Revised paragraph') }], reason: 'Clarify the selected claim.' } }); assert.equal(proposed.isError, undefined, proposed._meta?.paperError?.message); assert.equal(proposed._meta?.paperState, undefined); assert.equal((await f.app.waitJob({ jobId: queued.jobId })).status, 'completed');
  const message = await f.execution.sendMessage({ text: 'Explain this equation.', idempotencyKey: 'discussion-1' }); const reply = await f.client.callTool({ name: 'bilingual_paper_submit_chat_reply', arguments: { messageId: message.messageId, text: 'The protected equation stays unchanged.' } }); assert.equal(reply.isError, undefined, reply._meta?.paperError?.message); assert.equal(f.execution.state().messages.at(-1).reply, 'The protected equation stays unchanged.');
});

test('callbacks route to the private existing backend before any opener, with fixed caller and no UI capability leakage', async t => {
  const f = await fixture(t), started = await f.start(); let openings = 0, dispatches = 0;
  const outerService = { getState: () => ({ project: null, requests: [] }), getHostContext: () => ({ native: true, taskIdAvailable: true, hostTaskId: threadId }) };
  const outer = await connect(t, { service: outerService, openIndependentWindow: async () => { openings++; return { opened: true }; }, dispatchBackground: async (action, payload) => { dispatches++; assert.equal(action, 'callNativeTool'); assert.equal(payload.originThreadId, threadId); return { result: await callBackgroundModelTool(f.service, payload) }; } });
  const packet = await outer.callTool({ name: 'bilingual_paper_get_request', arguments: { requestId: started.taskId } }); assert.equal(packet.isError, undefined, packet._meta?.paperError?.message); assert.equal(openings, 0); assert.equal(dispatches, 1); assert.equal(packet._meta?.paperUiToken, undefined);
  const fixed = { name: 'bilingual_paper_get_request', arguments: { requestId: started.taskId }, bindingId: 'same-instance' };
  const good = await callBackgroundModelTool(f.service, { ...fixed, originThreadId: threadId }); assert.equal(good.isError, undefined);
  const denied = await callBackgroundModelTool(f.service, { ...fixed, originThreadId: 'other-chat' }); assert.equal(denied.isError, true);
  const missing = await callBackgroundModelTool(f.service, fixed); assert.equal(missing.isError, true); assert.equal(missing.structuredContent.error.code, 'HOST_CHAT_UNAVAILABLE');
});


test('Desktop UI actions require a private UI capability and createRequest cannot select another chat', async t => {
  const f = await fixture(t), denied = await f.client.callTool({ name: 'bilingual_paper_ui', arguments: { action: 'startTranslationTask', payload: {} } }); assert.equal(denied.structuredContent.error.code, 'UI_AUTHORIZATION_REQUIRED');
  const panel = await f.client.callTool({ name: 'bilingual_paper_panel', arguments: {} }), uiToken = panel._meta.paperUiToken;
  const selected = f.app.getState().readingParagraphs.map(row => row.id);
  const request = await f.client.callTool({ name: 'bilingual_paper_ui', arguments: { action: 'createRequest', payload: { kind: 'translation', segmentIds: selected.slice(0, 1), language: 'zh-CN', bindingId: 'desktop:foreign-chat', useDedicatedChat: true }, uiToken } }); assert.equal(request.isError, undefined); assert.equal(request._meta.paperResult.bindingId, `desktop:${threadId}`);
  const task = await f.client.callTool({ name: 'bilingual_paper_ui', arguments: { action: 'startTranslationTask', payload: { scope: 'selected', sourceSegmentIds: selected, language: 'zh-CN', expectedProjectId: f.project.id, expectedSnapshotId: f.project.snapshotId }, uiToken } }); assert.equal(task.isError, undefined, task._meta?.paperError?.message); assert.equal(task._meta.paperResult.total, 17); assert.equal(f.deliveries.length, 1);
  const spoof = await f.client.callTool({ name: 'bilingual_paper_ui', arguments: { action: 'desktopSendMessage', payload: { text: 'No arbitrary destinations', idempotencyKey: 'spoof', threadId: 'other-chat' }, uiToken } }); assert.equal(spoof.isError, true); assert.equal(f.deliveries.length, 1);
});

test('a late task return through native tools pauses after a manual edit and preserves that draft', async t => {
  const f = await fixture(t), started = await f.start(), response = await f.client.callTool({ name: 'bilingual_paper_get_request', arguments: { requestId: started.taskId } }), packet = JSON.parse(response.content[0].text), selected = packet.batch.segmentIds[0];
  await f.app.saveDraft({ segmentId: selected, language: 'zh-CN', text: 'Author preserved draft.', expectedRevision: 0 });
  const late = await f.client.callTool({ name: 'bilingual_paper_submit_translation_result', arguments: { requestId: packet.batch.requestId, translations: translated(packet) } }); assert.equal(late.isError, undefined, late._meta?.paperError?.message); assert.equal(late.structuredContent.status, 'paused'); assert.equal(late.structuredContent.nextTaskRequestId, null); assert.equal(f.app.getState().translations['zh-CN'][selected].text, 'Author preserved draft.');
});
