import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PaperApplication } from '../src/application.mjs';
import { ReviewAnchorWorkflow } from '../src/review-anchor.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t, count, { chat = null } = {}) {
  const owned = path.join(root, 'work/review-anchor-batches-tests'); await mkdir(owned, { recursive: true }); const base = await mkdtemp(path.join(owned, 'case-')), source = path.join(base, 'source'); await mkdir(source);
  const content = '\\documentclass{article}\n\\begin{document}\n\nA complete synthetic statement has an exact assumption that must remain explicit throughout this manuscript.\n\n\\end{document}\n', filename = path.join(source, 'main.tex'); await writeFile(filename, content);
  const app = new PaperApplication({ dataRoot: path.join(base, 'private'), chat }); await app.openProject({ root: source, mainFile: 'main.tex' });
  const imported = await app.importReviewNotes({ filename: 'all-review-notes.json', format: 'json', text: '[]', fileHash: createHash('sha256').update('synthetic-' + count).digest('hex'), annotations: Array.from({ length: count }, (_, index) => ({ title: 'Concern ' + index, body: 'Retain this exact independent review concern ' + index + '.' })) });
  const workflow = new ReviewAnchorWorkflow(app), input = { batchId: imported.batch.batchId, expectedRevision: 1, expectedFileHash: imported.batch.fileHash };
  t.after(async () => { await app.close(); assert.ok(path.resolve(base).startsWith(path.resolve(owned) + path.sep)); await rm(base, { recursive: true, force: true }); });
  return { app, workflow, input, filename, content, notes: imported.notes };
}
async function context(workflow, requestId, bindingId = 'native-test') {
  let packet = await workflow.context({ requestId }, { bindingId }); for (let offset = packet.pagination?.nextOffset; offset !== null && offset !== undefined;) { const page = await workflow.context({ requestId, offset }, { bindingId }); offset = page.pagination.nextOffset; } return packet;
}
const result = packet => ({ requestId: packet.requestId, matches: (packet.batchNoteIds || packet.noteIds).map(noteId => ({ noteId, status: 'unmatched', candidates: [], reason: 'No uniquely justified source paragraph; retain the original concern for author confirmation.' })) });

test('one hundred short opinions form one full matching request instead of eight-note user groups', async t => {
  const f = await fixture(t, 100), before = f.app.core.getState(), prepared = await f.workflow.prepare(f.input, { bindingId: 'native-test' }); assert.equal(prepared.noteCount, 100); assert.equal(prepared.batchNoteIds.length, 100); assert.equal(prepared.progress.batchCount, 1); assert.equal(Object.keys(prepared.noteRevisions).length, 100);
  const packet = await context(f.workflow, prepared.requestId), saved = await f.workflow.submit(result(packet), { bindingId: 'native-test' }); assert.equal(saved.complete, true); assert.equal(saved.unmatchedCount, 100); assert.equal(f.app.core.getState().reviewNotes.length, 100); assert.deepEqual(f.app.core.getState().translations, before.translations); assert.equal(await readFile(f.filename, 'utf8'), f.content);
});

test('all6001 opinions finish by automatic byte batches with no published intermediate links or lost originals', async t => {
  const f = await fixture(t, 6001), before = f.app.core.getState(), prepared = await f.workflow.prepare(f.input, { bindingId: 'native-test' }); assert.equal(prepared.noteCount, 6001); assert.equal(prepared.noteIds.length, 6001); assert.ok(prepared.progress.batchCount > 1); let saved, batches = 0;
  do { const packet = await context(f.workflow, prepared.requestId); saved = await f.workflow.submit(result(packet), { bindingId: 'native-test' }); batches++; if (!saved.complete) { assert.deepEqual(f.app.core.getState(), before); assert.equal(saved.nextBatch, true); assert.equal(saved.sourceChanged, false); } } while (!saved.complete);
  const after = f.app.core.getState(); assert.ok(batches > 1); assert.equal(saved.unmatchedCount, 6001); assert.equal(after.reviewNotes.length, 6001); assert.deepEqual(after.reviewNotes.map(note => [note.noteId, note.body, note.decision]), before.reviewNotes.map(note => [note.noteId, note.body, note.decision])); assert.ok(after.reviewNotes.every(note => note.anchorMatch.requestId === prepared.requestId)); assert.equal(after.project.snapshotId, before.project.snapshotId); assert.equal(await readFile(f.filename, 'utf8'), f.content);
});

test('native transport parts stage the exact full matching scope and final retries never republish records', async t => {
  const f = await fixture(t, 4), prepared = await f.workflow.prepare(f.input, { bindingId: 'native-test' }), packet = await context(f.workflow, prepared.requestId), rows = result(packet).matches, before = f.app.core.getState();
  const first = { requestId: packet.requestId, matches: rows.slice(0, 2), batchOffset: 0, resultCount: 4, finalize: false }, last = { requestId: packet.requestId, matches: rows.slice(2), batchOffset: 2, resultCount: 4, finalize: true };
  const staged = await f.workflow.submit(first, { bindingId: 'native-test' }); assert.equal(staged.complete, false); assert.equal(staged.status, 'receiving'); assert.deepEqual(f.app.core.getState(), before); assert.deepEqual(await f.workflow.submit(first, { bindingId: 'native-test' }), staged);
  const saved = await f.workflow.submit(last, { bindingId: 'native-test' }); assert.equal(saved.complete, true); assert.equal(saved.unmatchedCount, 4); const after = f.app.core.getState(); const retry = await f.workflow.submit(last, { bindingId: 'native-test' }); assert.equal(retry.idempotent, true); assert.equal(retry.unmatchedCount, 4); assert.deepEqual(f.app.core.getState(), after); await assert.rejects(f.workflow.submit(last, { bindingId: 'another-chat' }), { code: 'REQUEST_NOT_APPROVED' });
});

test('each exact context read renews idle expiry without changing any original opinion', async t => {
  const f = await fixture(t, 2), prepared = await f.workflow.prepare(f.input, { bindingId: 'native-test' }), pending = f.workflow.requests.get(prepared.requestId), before = f.app.core.getState(); pending.expires = Date.now() + 1000; const packet = await f.workflow.context({ requestId: prepared.requestId }, { bindingId: 'native-test' }); assert.ok(Date.parse(packet.expiresAt) > Date.now() + 20 * 60 * 1000); assert.equal(Date.parse(packet.expiresAt), pending.expires); assert.deepEqual(f.app.core.getState(), before);
});

function syntheticChat({ reasonBytes = 100 } = {}) {
  const state = { connected: true, busy: false, threadId: 'same-paper-chat', model: 'gpt-6-astra', effort: 'medium', messages: [] }, calls = [];
  return { state, calls, on() {}, close: async () => {}, getState: () => structuredClone(state), connect: async () => { throw Error('No alternate owner'); }, sendReviewMessage: async input => { calls.push(input); state.busy = true; return { threadId: state.threadId, turnId: 'turn-' + calls.length }; }, waitForTurn: async turnId => { const input = calls[Number(turnId.slice(5)) - 1], schema = input.outputSchema.properties, response = schema.contextHash ? Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, value.const])) : { requestId: schema.requestId.const, matches: schema.matches.items.properties.noteId.enum.map(noteId => ({ noteId, status: 'unmatched', candidates: [], reason: 'Explicit remaining concern. ' + 'x'.repeat(reasonBytes) })) }; state.messages.push({ role: 'assistant', turnId, text: JSON.stringify(response) }); state.busy = false; return { status: 'completed', threadId: state.threadId, turnId }; }, interrupt: async () => ({ interrupted: true }) };
}

test('one bound worker automatically retries actual-byte repartition until every selected opinion returns', async t => {
  const chat = syntheticChat({ reasonBytes: 4000 }), f = await fixture(t, 300, { chat }), prepared = await f.workflow.prepare(f.input), job = await f.workflow.run({ requestId: prepared.requestId }), saved = await f.app.waitJob({ jobId: job.jobId });
  assert.equal(saved.complete, true); assert.equal(saved.unmatchedCount, 300); assert.ok(chat.calls.length > 1); assert.ok(chat.calls.every(call => call.model === 'gpt-6-astra')); assert.equal(chat.state.threadId, 'same-paper-chat'); assert.equal(f.app._activeChatScope, null); assert.equal(await readFile(f.filename, 'utf8'), f.content);
});

test('the same bound worker acknowledges every exact large context page before final matching', async t => {
  const chat = syntheticChat(), f = await fixture(t, 2, { chat }); await f.app.core._serial(async () => { const raw = f.app.core.getState(); raw.reviewNotes[0].body = 'Large original concern. '.repeat(140000); await f.app.core._commit(raw); }); const prepared = await f.workflow.prepare(f.input); assert.ok(prepared.pagination.total > 1);
  const job = await f.workflow.run({ requestId: prepared.requestId }), saved = await f.app.waitJob({ jobId: job.jobId }); assert.equal(saved.complete, true); assert.equal(saved.unmatchedCount, 2); assert.equal(chat.calls.filter(call => call.outputSchema.properties.contextHash).length, prepared.pagination.total); assert.equal(chat.calls.length, prepared.pagination.total + prepared.progress.batchCount); assert.equal(await readFile(f.filename, 'utf8'), f.content);
});
