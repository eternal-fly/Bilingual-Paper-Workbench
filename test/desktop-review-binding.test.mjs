import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PaperApplication } from '../src/application.mjs';
import { dispatchUi } from '../src/local-web.mjs';
import { registerReviewOrganizationTools } from '../src/review-organization-tools.mjs';
import { registerReviewAnchorTools } from '../src/review-anchor-tools.mjs';

const threadId = 'synthetic-verified-review-desktop', digest = text => createHash('sha256').update(text).digest('hex');
const paragraphs = ['The first complete synthetic paragraph establishes the exact bounded response under the explicitly fixed preparation assumption.', 'The second complete synthetic paragraph describes an independent estimator under a different explicitly stated sampling assumption.'];
async function fixture(t) {
  const owned = path.resolve(fileURLToPath(new URL('../work/desktop-review-binding-tests/', import.meta.url))); await mkdir(owned, { recursive: true });
  const directory = await mkdtemp(path.join(owned, 'case-')), source = path.join(directory, 'source'); await mkdir(source);
  const filename = path.join(source, 'main.tex'), content = '\\documentclass{article}\n\\begin{document}\n\n' + paragraphs.join('\n\n') + '\n\n\\end{document}\n'; await writeFile(filename, content);
  const app = new PaperApplication({ dataRoot: path.join(directory, 'private') }); await app.openProject({ root: source, mainFile: 'main.tex' });
  let ready = true; app.desktopExecution = { state: () => ({ mode: 'desktop-queue', threadId, available: ready, reason: 'The verified Desktop is unavailable.' }) };
  const imported = await app.importReviewNotes({ filename: 'synthetic-review.json', format: 'json', fileHash: digest('synthetic immutable review'), text: JSON.stringify({ notes: [{ title: 'First concern', body: 'Clarify the first stated preparation assumption.' }, { title: 'Second concern', body: 'Clarify the independently stated sampling procedure.' }] }) });
  const input = { batchId: imported.batch.batchId, expectedRevision: 1, expectedFileHash: imported.batch.fileHash };
  t.after(async () => { await app.close(); assert.ok(directory.startsWith(owned + path.sep)); await rm(directory, { recursive: true, force: true }); });
  return { app, input, imported, filename, content, setReady: value => { ready = value; } };
}
async function tools(t, f, nativeThreadId = threadId, instanceId = 'fresh-mcp-instance') {
  const server = new McpServer({ name: 'synthetic-desktop-review-binding', version: '1' }), options = { service: f.app, guard: handler => handler, instanceId, nativeThreadId };
  registerReviewOrganizationTools(server, options); registerReviewAnchorTools(server, options);
  const client = new Client({ name: 'synthetic-desktop-model', version: '1' }), [c, s] = InMemoryTransport.createLinkedPair(); await server.connect(s); await client.connect(c);
  t.after(async () => { await client.close(); await server.close(); });
  return (name, input) => client.callTool({ name, arguments: input });
}
const organization = packet => ({ requestId: packet.requestId, notes: packet.noteIds.map(noteId => ({ noteId, suggestedSource: 'The revised assumption is stated explicitly for author review.', suggestedTranslation: '明确陈述修订后的假设，交由作者审阅。', reasonSource: 'Clarify the existing concern without extending its scientific scope.', reasonTranslation: '澄清已有意见，不扩大其科学范围。' })) });
const anchors = (packet, f) => ({ requestId: packet.requestId, matches: packet.noteIds.map((noteId, i) => ({ noteId, status: 'certain', candidates: [{ sourceSegmentId: f.app.getState().readingParagraphs[i].id, quote: paragraphs[i], reason: 'The complete literal paragraph uniquely matches the original concern.' }], reason: 'The original concern corresponds to this explicit source assumption.' })) });

test('Desktop UI preparation and a fresh trusted MCP instance share exact organization binding', async t => {
  const f = await fixture(t), before = f.app.core.getState(), packet = await dispatchUi(f.app, 'prepareReviewOrganization', f.input);
  assert.equal(packet.context.transport, 'native'); assert.ok(packet.nativePrompt.includes(packet.requestId));
  const call = await tools(t, f), context = await call('bilingual_paper_get_review_organization_context', { requestId: packet.requestId }); assert.notEqual(context.isError, true, JSON.stringify(context));
  assert.equal(JSON.parse(context.content[0].text).context.transport, 'native');
  const result = await call('bilingual_paper_submit_review_organization', organization(packet)); assert.notEqual(result.isError, true, JSON.stringify(result)); assert.equal(result.structuredContent.organizedCount, 2);
  const after = f.app.core.getState(); assert.deepEqual(after.translations, before.translations); assert.deepEqual(after.proposals, before.proposals); assert.deepEqual(after.reviewNotes.map(note => note.body), before.reviewNotes.map(note => note.body)); assert.equal(await readFile(f.filename, 'utf8'), f.content);
});

test('Desktop UI anchor preparation survives fresh MCP context/submit callbacks without a worker', async t => {
  const f = await fixture(t), packet = await dispatchUi(f.app, 'prepareReviewAnchors', f.input); assert.equal(packet.context.transport, 'native');
  const call = await tools(t, f), context = await call('bilingual_paper_get_review_anchor_context', { requestId: packet.requestId }); assert.notEqual(context.isError, true, JSON.stringify(context));
  const result = await call('bilingual_paper_submit_review_anchors', anchors(packet, f)); assert.notEqual(result.isError, true, JSON.stringify(result)); assert.equal(result.structuredContent.matchedCount, 2);
  assert.equal(f.app.jobs.size, 0); assert.equal(await readFile(f.filename, 'utf8'), f.content);
});

test('missing and foreign trusted caller identities cannot read or submit Desktop review requests', async t => {
  for (const caller of [null, 'another-desktop-chat']) for (const kind of ['organization', 'anchor']) await t.test(`${caller}/${kind}`, async subtest => {
    const f = await fixture(subtest), packet = await dispatchUi(f.app, kind === 'organization' ? 'prepareReviewOrganization' : 'prepareReviewAnchors', f.input), before = f.app.core.getState();
    const call = await tools(subtest, f, caller), getName = kind === 'organization' ? 'bilingual_paper_get_review_organization_context' : 'bilingual_paper_get_review_anchor_context', submitName = kind === 'organization' ? 'bilingual_paper_submit_review_organization' : 'bilingual_paper_submit_review_anchors';
    assert.equal((await call(getName, { requestId: packet.requestId })).isError, true); assert.equal((await call(submitName, kind === 'organization' ? organization(packet) : anchors(packet, f))).isError, true); assert.deepEqual(f.app.core.getState(), before);
  });
});

test('unavailable Desktop execution rejects preparation and native worker fallback clearly', async t => {
  const f = await fixture(t); f.setReady(false);
  for (const action of ['prepareReviewOrganization', 'prepareReviewAnchors', 'getReviewOrganizationContext', 'submitReviewOrganization', 'getReviewAnchorContext', 'submitReviewAnchors', 'runReviewOrganization', 'runReviewAnchors', 'reviewCycle', 'syncParagraph']) await assert.rejects(dispatchUi(f.app, action, action.startsWith('prepare') ? f.input : {}), { code: 'DESKTOP_EXECUTION_UNAVAILABLE' });
  assert.equal(f.app.jobs.size, 0);
});

test('legacy native instance bindings still work when Desktop execution is absent', async t => {
  const f = await fixture(t); delete f.app.desktopExecution;
  const packet = await dispatchUi(f.app, 'prepareReviewOrganization', f.input, { nativeBindingId: 'legacy-instance' }); assert.equal(packet.context.transport, 'native');
  const call = await tools(t, f, null, 'legacy-instance'), result = await call('bilingual_paper_get_review_organization_context', { requestId: packet.requestId }); assert.notEqual(result.isError, true, JSON.stringify(result));
});
