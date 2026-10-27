import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PaperApplication } from '../src/application.mjs';
import { ReviewOrganizationWorkflow } from '../src/review-organization.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, count) {
  const parent = path.join(root, 'work/review-organization-batches'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'case-')), source = path.join(directory, 'source'); await mkdir(source);
  const filename = path.join(source, 'main.tex'), original = '\\documentclass{article}\n\\begin{document}\n\nOne exact current source claim.\n\n\\end{document}\n'; await writeFile(filename, original);
  const app = new PaperApplication({ dataRoot: path.join(directory, 'private') }); await app.openProject({ root: source, mainFile: 'main.tex' });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const imported = await app.importReviewNotes({ filename: 'many-opinions.json', format: 'json', fileHash: sha('synthetic-' + count), text: JSON.stringify({ notes: Array.from({ length: count }, (_, at) => ({ title: `Concern ${at}`, body: `Clarify original concern ${at}.` })) }) });
  const workflow = new ReviewOrganizationWorkflow(app), input = { batchId: imported.batch.batchId, expectedRevision: 1, expectedFileHash: imported.batch.fileHash };
  return { app, workflow, input, imported, filename, original };
}
function output(packet, text = 'Retain the original bounded concern.') { return { requestId: packet.requestId, notes: packet.batchNoteIds.map(noteId => ({ noteId, suggestedSource: text, suggestedTranslation: text, reasonSource: text, reasonTranslation: text })) }; }

test('one hundred short external opinions organize as one complete scope without an eight-item limit', async t => {
  const f = await fixture(t, 100), packet = await f.workflow.prepare(f.input), before = f.app.core.getState();
  assert.equal(packet.batchNoteIds.length, 100); assert.equal(packet.noteCount, 100); assert.equal(packet.progress.batchCount, 1);
  const result = await f.workflow.submit(output(packet)); assert.equal(result.organizedCount, 100); assert.equal(result.complete, true);
  const after = f.app.core.getState(); assert.deepEqual(after.reviewNotes.map(note => [note.body, note.decision, note.sourceSegmentIds]), before.reviewNotes.map(note => [note.body, note.decision, note.sourceSegmentIds])); assert.equal(await readFile(f.filename, 'utf8'), f.original);
});

test('more than 5000 imported opinions retain exact full coverage and publish only after every byte batch', async t => {
  const f = await fixture(t, 5001), packet = await f.workflow.prepare(f.input), originalIds = f.imported.notes.map(note => note.noteId);
  assert.equal(packet.noteIds.length, 5001); assert.deepEqual(packet.noteIds, originalIds); assert(packet.progress.batchCount > 1);
  let result, last; const returned = [];
  do {
    const current = await f.workflow.context({ requestId: packet.requestId }); last = output(current); returned.push(...current.batchNoteIds);
    result = await f.workflow.submit(last);
    if (!result.complete) assert(f.app.core.getState().reviewNotes.every(note => !note.organizedPresentation && note.revision === 1));
  } while (!result.complete);
  assert.deepEqual(returned, originalIds); assert.equal(result.organizedCount, 5001); assert(f.app.core.getState().reviewNotes.every(note => note.organizedPresentation && note.revision === 2));
  assert.equal((await f.workflow.submit(last)).idempotent, true); assert.equal(await readFile(f.filename, 'utf8'), f.original);
});

test('large opinion returns use complete-record transport parts with atomic final publication and exact retries', async t => {
  const f = await fixture(t, 200), packet = await f.workflow.prepare(f.input), all = output(packet, 'x'.repeat(11500));
  assert(Buffer.byteLength(JSON.stringify(all)) > 8 * 1024 * 1024); assert.equal(packet.progress.batchCount, 1);
  let result, last;
  for (let offset = 0; offset < all.notes.length; offset += 25) {
    last = { requestId: packet.requestId, notes: all.notes.slice(offset, offset + 25), batchOffset: offset, resultCount: 200, finalize: offset + 25 === 200 };
    result = await f.workflow.submit(last);
    if (!last.finalize) { assert.equal(result.status, 'receiving'); assert.equal(result.nextOffset, offset + 25); assert(f.app.core.getState().reviewNotes.every(note => !note.organizedPresentation)); assert.equal((await f.workflow.submit(last)).nextOffset, offset + 25); }
  }
  assert.equal(result.organizedCount, 200); assert.equal(result.complete, true); assert.equal((await f.workflow.submit(last)).idempotent, true);
});

test('a draft change while byte results are staged rejects the remaining callback without partial publication', async t => {
  const f = await fixture(t, 100), packet = await f.workflow.prepare(f.input), all = output(packet);
  await f.workflow.submit({ ...all, notes: all.notes.slice(0, 50), batchOffset: 0, resultCount: 100, finalize: false });
  await f.app.core._serial(async () => { const next = f.app.core.getState(); next.readingDrafts = { 'zh-CN': { 'new-draft': { revision: 1, text: 'Changed author draft' } } }; await f.app.core._commit(next); });
  await assert.rejects(f.workflow.submit({ ...all, notes: all.notes.slice(50), batchOffset: 50, resultCount: 100, finalize: true }), { code: 'RESULT_STALE' });
  assert(f.app.core.getState().reviewNotes.every(note => !note.organizedPresentation)); assert.equal(await readFile(f.filename, 'utf8'), f.original);
});

test('an exact final retry publishes after a transient persistence failure instead of returning an unpublished completion receipt', async t => {
  const f = await fixture(t, 3), packet = await f.workflow.prepare(f.input), all = output(packet), commit = f.app.core._commit.bind(f.app.core); let failed = false;
  f.app.core._commit = async state => { if (!failed) { failed = true; throw Object.assign(new Error('Synthetic persistence failure'), { code: 'SYNTHETIC_WRITE_FAILED' }); } return commit(state); };
  await assert.rejects(f.workflow.submit(all), { code: 'SYNTHETIC_WRITE_FAILED' }); assert(f.app.core.getState().reviewNotes.every(note => !note.organizedPresentation));
  const result = await f.workflow.submit(all); assert.equal(result.complete, true); assert.equal(result.organizedCount, 3); assert(f.app.core.getState().reviewNotes.every(note => note.organizedPresentation));
});

test('a completed organization retry cannot report a current completion after the paper snapshot changes', async t => {
  const f = await fixture(t, 3), packet = await f.workflow.prepare(f.input, { bindingId: 'native-instance' });
  const all = { ...output(packet), batchOffset: 0, resultCount: 3, finalize: true };
  const saved = await f.workflow.submit(all, { bindingId: 'native-instance' }); assert.equal(saved.complete, true);
  await f.app.core._serial(async () => { const next = f.app.core.getState(); next.project.snapshotId = 'snap-after-source-change'; await f.app.core._commit(next); });
  const before = f.app.core.getState();
  await assert.rejects(f.workflow.submit(all, { bindingId: 'native-instance' }), { code: 'REQUEST_NOT_APPROVED' });
  assert.deepEqual(f.app.core.getState(), before);
});
