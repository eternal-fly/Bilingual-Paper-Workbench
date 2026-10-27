import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { PaperApplication } from '../src/application.mjs';
import { DesktopExecution } from '../src/desktop-execution.mjs';

const threadId = 'synthetic-sync-desktop', hash = text => createHash('sha256').update(text).digest('hex');
const content = '\\documentclass{article}\n\\begin{document}\n\nA measured quantity uses $x=1$, \\cite{synthetic} and \\ref{eq:synthetic}.\n\n\\end{document}\n';
async function fixture(t) {
  const owned = path.resolve(fileURLToPath(new URL('../work/sync-desktop-tests/', import.meta.url))); await mkdir(owned, { recursive: true });
  const directory = await mkdtemp(path.join(owned, 'case-')), source = path.join(directory, 'source'); await mkdir(source);
  const filename = path.join(source, 'main.tex'); await writeFile(filename, content);
  const independentCalls = [], chat = { on() {}, off() {}, getState: () => ({ connected: false, threadId: null, busy: false, model: 'unused-model' }), async close() {} };
  for (const method of ['connect', 'startChat', 'resumeChat', 'sendMessage', 'listModels']) chat[method] = async () => { independentCalls.push(method); throw Error('An independent model connection must never execute this synchronization.'); };
  const app = new PaperApplication({ dataRoot: path.join(directory, 'private'), chat }); await app.openProject({ root: source, mainFile: 'main.tex', targetLanguage: 'zh-CN' });
  const project = app.core.getState().project, selection = { threadId, model: 'gpt-6-astra', effort: 'max', title: 'Synthetic Desktop sync' };
  await app._flowAction(() => { app.flow.backgroundChatReference = { ...selection, projectId: project.id, kind: 'background-chat-reference', source: 'originating-host-chat' }; });
  const deliveries = [], service = { active: app, _closing: false, _switching: false, emit() {} };
  const desktop = new DesktopExecution(service, { createProducer: async () => ({ state: () => ({ desktopQueueVerified: true }), async enqueue(input, { beforeEnqueue } = {}) { await beforeEnqueue?.({ threadId, title: 'Synthetic Desktop paper', model: 'gpt-6-astra', effort: 'max', cwd: source }); deliveries.push(input); return { threadId, clientUserMessageId: input.clientUserMessageId, inputHash: hash(input.text), status: 'queued', queuedSubmissionId: `synthetic-queue-${deliveries.length}` }; }, async close() {} }) });
  await desktop.bind({ app, project, selection }); app.desktopExecutionEnabled = true; app.desktopThreadId = () => desktop.state().available ? threadId : null; app.desktopRequestRunner = input => desktop.runRequest(app, input);
  // A synthetic native MCP return adapter exercises the same approved request,
  // protected result validator and Desktop completion callback as the host route.
  const server = new McpServer({ name: 'synthetic-desktop-sync-return', version: '1' });
  const requestId = z.string(), segmentId = z.string();
  server.registerTool('bilingual_paper_get_request', { inputSchema: z.object({ requestId }) }, async input => { const request = await desktop.approvedRequest(app, input.requestId, threadId); return { content: [{ type: 'text', text: JSON.stringify(request) }] }; });
  server.registerTool('bilingual_paper_submit_translation_result', { inputSchema: z.object({ requestId, translations: z.array(z.object({ segmentId, text: z.string() })) }) }, async input => { await desktop.approvedRequest(app, input.requestId, threadId); const result = await app.submitTranslationResult(input); await desktop.requestSubmitted(app, input.requestId, threadId, result); return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }; });
  server.registerTool('bilingual_paper_propose_revision', { inputSchema: z.object({ requestId, edits: z.array(z.object({ segmentId, beforeHash: z.string(), replacement: z.string() })), reason: z.string() }) }, async input => { await desktop.approvedRequest(app, input.requestId, threadId); const result = await app.proposeRevision(input); await desktop.requestSubmitted(app, input.requestId, threadId, result); return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }; });
  const client = new Client({ name: 'synthetic-native-desktop', version: '1' }), [c, s] = InMemoryTransport.createLinkedPair(); await server.connect(s); await client.connect(c);
  const call = (name, args) => client.callTool({ name, arguments: args });
  t.after(async () => { await client.close(); await server.close(); await desktop.close(); await app.close(); await Promise.allSettled([...app.jobs.values()].map(job => job.promise)); assert.ok(directory.startsWith(owned + path.sep)); await rm(directory, { recursive: true, force: true }); });
  return { app, desktop, deliveries, independentCalls, filename, call, paragraph: app.getState().readingParagraphs[0] };
}
async function begin(f, direction) {
  return f.app.syncParagraph({ sourceSegmentIds: [f.paragraph.id], direction, language: 'zh-CN', expectedDraftRevisions: { [f.paragraph.id]: f.app.getState().translations['zh-CN']?.[f.paragraph.id]?.revision || 0 } });
}
async function readRequest(f, requestId) { const result = await f.call('bilingual_paper_get_request', { requestId }); assert.notEqual(result.isError, true, JSON.stringify(result)); return JSON.parse(result.content[0].text); }
const translation = request => ({ requestId: request.requestId, translations: request.segments.map(segment => ({ segmentId: segment.segmentId, text: segment.text.replace('A measured quantity uses', '测量量采用') })) });
const revision = request => ({ requestId: request.requestId, edits: request.segments.map(segment => ({ segmentId: segment.segmentId, beforeHash: segment.beforeHash, replacement: segment.text.replace('A measured quantity', 'An estimated expectation value') })), reason: 'Clarify the estimated quantity while preserving the protected objects.' });

test('Desktop-owned Chinese-to-English sync returns only a protected pending proposal through native MCP', async t => {
  const f = await fixture(t); await f.app.saveDraft({ segmentId: f.paragraph.id, language: 'zh-CN', text: '明确估计的是期望值，同时保留公式和引用。', expectedRevision: 0 });
  const queued = await begin(f, 'toEnglish'), request = await readRequest(f, queued.requestId);
  assert.equal(request.bindingId, `desktop:${threadId}`); assert.equal(request.kind, 'revision'); assert.equal(request.syncContext.direction, 'toEnglish'); assert.equal(request.segments[0].protectedTokens.length, 3); assert.match(request.segments[0].translationDraft.text, /期望值/);
  const result = await f.call('bilingual_paper_propose_revision', revision(request)); assert.notEqual(result.isError, true, JSON.stringify(result));
  const completed = await f.app.waitJob({ jobId: queued.jobId }); assert.equal(completed.status, 'completed');
  const state = f.app.getState(); assert.equal(state.proposals.length, 1); assert.equal(state.proposals[0].applicationState, 'notApplied'); assert.equal(state.proposals[0].reviewState, 'pending');
  assert.match(state.proposals[0].edits[0].replacement, /\$x=1\$/); assert.match(state.proposals[0].edits[0].replacement, /\\cite\{synthetic\}/); assert.match(state.proposals[0].edits[0].replacement, /\\ref\{eq:synthetic\}/);
  assert.equal(state.transactions.length, 0); assert.equal(f.deliveries.length, 1); assert.deepEqual(f.independentCalls, []); assert.equal(await readFile(f.filename, 'utf8'), content);
});

test('Desktop-owned English-to-translation sync refills the current draft through native MCP and waitJob', async t => {
  const f = await fixture(t), queued = await begin(f, 'toTranslation'), request = await readRequest(f, queued.requestId);
  assert.equal(request.bindingId, `desktop:${threadId}`); assert.equal(request.kind, 'translation');
  const result = await f.call('bilingual_paper_submit_translation_result', translation(request)); assert.notEqual(result.isError, true, JSON.stringify(result));
  const finished = await f.app.waitJob({ jobId: queued.jobId }); assert.equal(finished.imported.status, 'completed');
  const draft = f.app.getState().translations['zh-CN'][f.paragraph.id]; assert.match(draft.text, /^测量量采用/); assert.match(draft.text, /\\cite\{synthetic\}/); assert.match(draft.text, /\$x=1\$/); assert.equal(draft.revision, 1);
  assert.equal(f.deliveries.length, 1); assert.deepEqual(f.independentCalls, []); assert.equal(await readFile(f.filename, 'utf8'), content);
});

test('late native synchronization replies cannot overwrite a manual draft, changed source or target language', async t => {
  for (const mode of ['manual', 'source', 'language']) for (const direction of ['toEnglish', 'toTranslation']) await t.test(`${mode}/${direction}`, async subtest => {
    const f = await fixture(subtest), queued = await begin(f, direction), request = await readRequest(f, queued.requestId);
    if (mode === 'manual') await f.app.saveDraft({ segmentId: f.paragraph.id, language: 'zh-CN', text: 'The author wins this race.', expectedRevision: 0 });
    if (mode === 'source') await writeFile(f.filename, content + '\n');
    if (mode === 'language') await f.app.configureLanguages({ translationLanguage: 'fr', expectedRevision: f.app.getState().languagePreferences.revision });
    const result = await f.call(direction === 'toEnglish' ? 'bilingual_paper_propose_revision' : 'bilingual_paper_submit_translation_result', direction === 'toEnglish' ? revision(request) : translation(request));
    assert.equal(result.isError, true); const state = f.app.getState(); assert.equal(state.proposals.length, 0); assert.equal(state.translations['zh-CN']?.[f.paragraph.id]?.text || '', mode === 'manual' ? 'The author wins this race.' : ''); assert.deepEqual(f.independentCalls, []);
  });
});

test('a missing or changed verified Desktop origin fails without trying a separate model connection', async t => {
  const f = await fixture(t); f.app.desktopThreadId = () => null;
  await assert.rejects(begin(f, 'toTranslation'), { code: 'DESKTOP_EXECUTION_UNAVAILABLE' }); assert.equal(f.app.getState().requests.length, 0); assert.equal(f.deliveries.length, 0); assert.deepEqual(f.independentCalls, []);
});

test('pending owned Desktop jobs prevent overlapping sync startup and cleanly release its reservation', async t => {
  const f = await fixture(t), queued = await begin(f, 'toTranslation');
  await assert.rejects(begin(f, 'toEnglish'), { code: 'CHAT_BUSY' }); assert.equal(f.app.reviews.starting, false); assert.equal(f.app.sync.reservation, null); assert.equal(f.deliveries.length, 1);
  const request = await readRequest(f, queued.requestId); await f.call('bilingual_paper_submit_translation_result', translation(request)); await f.app.waitJob({ jobId: queued.jobId });
  assert.equal(f.app.jobs.get(queued.jobId).finished, true);
});
