import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PaperApplication } from '../src/application.mjs';
import { createPaperServer } from '../src/server.mjs';
import { startLocalWeb } from '../src/local-web.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const owned = path.join(root, 'work/review-import-delete-tests'); await mkdir(owned, { recursive: true });
  const directory = await mkdtemp(path.join(owned, 'case-')), source = path.join(directory, 'source'), dataRoot = path.join(directory, 'private'); await mkdir(source);
  const sourceBytes = Buffer.from('\\documentclass{article}\n\\begin{document}\n\nA unique synthetic claim needs assumptions.\n\nA second independent paragraph.\n\n\\end{document}\n'); await writeFile(path.join(source, 'main.tex'), sourceBytes);
  const originalPdfBytes = Buffer.from('%PDF-synthetic-original-review-kept-on-disk'), originalPdfPath = path.join(directory, 'uploaded-review.pdf'); await writeFile(originalPdfPath, originalPdfBytes);
  const app = new PaperApplication({ dataRoot }); await app.openProject({ root: source, mainFile: 'main.tex' });
  const upload = { filename: 'uploaded-review.pdf', format: 'pdf', fileHash: sha(originalPdfBytes), text: '1. “A unique synthetic claim needs assumptions.” Clarify the first claim.\n2. Explain the independent paragraph.' }, imported = await app.importReviewNotes(upload), batchId = imported.batch.batchId;
  await app.core._serial(async () => { const next = app.core.getState(), archived = next.reviewNotes.find(note => note.batchId === batchId && note.noteId === imported.notes[1].noteId); next.reviewNotes = next.reviewNotes.filter(note => note.noteId !== archived.noteId); next.reviewHistory = [{ ...archived, archivedAt: '2026-01-01T00:00:00Z' }];
    next.reviewBatches.push({ ...next.reviewBatches.find(batch => batch.batchId === batchId), batchId: 'other-external-same-file', noteCount: 1, sourceSnapshotId: 'snap-earlier' }, { batchId: 'native-model-review', origin: 'codex', status: 'completed', revision: 1, fileHash: upload.fileHash, noteCount: 1 });
    next.reviewNotes.push({ noteId: 'other-file-batch-note', batchId: 'other-external-same-file', origin: 'external', body: 'Another exact batch using the same file digest.', revision: 1 }, { noteId: 'native-model-note', batchId: 'native-model-review', origin: 'codex', body: 'A native model opinion must survive.', revision: 1 }); await app.core._commit(next);
  });
  const paragraph = app.getState().readingParagraphs[0]; await app.saveDraft({ segmentId: paragraph.id, language: 'zh-CN', text: '保留作者的人工译稿。', expectedRevision: 0 }); await app.addComment({ segmentIds: [paragraph.id], text: '保留人工批注。' });
  t.after(async () => { await app.close(); assert.ok(path.resolve(directory).startsWith(path.resolve(owned) + path.sep)); await rm(directory, { recursive: true, force: true }); });
  return { app, source, dataRoot, sourceBytes, originalPdfPath, originalPdfBytes, upload, batchId, select: { batchId, expectedRevision: 1, expectedFileHash: upload.fileHash } };
}
test('deleting one imported record removes only its canonical and archived external opinions while all files and other records remain exact', async t => {
  const f = await fixture(t), before = f.app.core.getState(), flow = structuredClone(f.app.flow);
  const plan = await f.app.prepareDeleteReviewImport(f.select); assert.equal(plan.count, 2); assert.equal(plan.activeCount, 1); assert.equal(plan.historyCount, 1); assert.equal(plan.filename, f.upload.filename); assert.equal(plan.originalFileRetained, true); assert.deepEqual(f.app.core.getState(), before); assert.ok(!JSON.stringify(f.app.getState()).includes(plan.confirmationToken));
  const result = await f.app.deleteReviewImport({ planId: plan.planId, confirmationToken: plan.confirmationToken }); assert.equal(result.deletedCount, 2); assert.equal(result.activeDeleted, 1); assert.equal(result.historyDeleted, 1); assert.equal(result.originalFileRetained, true);
  const after = f.app.core.getState(); assert.ok(!after.reviewBatches.some(batch => batch.batchId === f.batchId)); assert.ok(!after.reviewNotes.some(note => note.batchId === f.batchId)); assert.ok(!after.reviewHistory.some(note => note.batchId === f.batchId));
  assert.deepEqual(after.reviewBatches, before.reviewBatches.filter(batch => batch.batchId !== f.batchId)); assert.deepEqual(after.reviewNotes, before.reviewNotes.filter(note => note.batchId !== f.batchId));
  for (const field of ['translations', 'readingDrafts', 'originals', 'readingOriginals', 'proposals', 'requests', 'comments', 'reviewHistoryPreferences']) assert.deepEqual(after[field], before[field]);
  assert.deepEqual(f.app.flow, flow); assert.deepEqual(await readFile(path.join(f.source, 'main.tex')), f.sourceBytes); assert.deepEqual(await readFile(f.originalPdfPath), f.originalPdfBytes);
});
test('retired imported records are deleted from raw storage without requiring restoration first', async t => {
  const f = await fixture(t); await f.app.setReviewImportActive({ ...f.select, active: false }); assert.ok(!f.app.getState().reviewNotes.some(note => note.batchId === f.batchId)); assert.ok(!f.app.getState().reviewHistory.some(note => note.batchId === f.batchId));
  const plan = await f.app.prepareDeleteReviewImport({ ...f.select, expectedRevision: 2 }); assert.equal(plan.status, 'retired'); assert.equal(plan.active, false); assert.equal(plan.count, 2);
  await f.app.deleteReviewImport({ planId: plan.planId, confirmationToken: plan.confirmationToken }); assert.ok(!f.app.core.getState().reviewBatches.some(batch => batch.batchId === f.batchId)); assert.equal(f.app.core.getState().reviewNotes.length, 2); assert.deepEqual(await readFile(f.originalPdfPath), f.originalPdfBytes);
});
test('empty imported records still produce an actionable deletion plan without deleting the original PDF', async t => {
  const f = await fixture(t); await f.app.core._serial(async () => { const next = f.app.core.getState(); next.reviewNotes = next.reviewNotes.filter(note => note.batchId !== f.batchId); next.reviewHistory = next.reviewHistory.filter(note => note.batchId !== f.batchId); next.reviewBatches.find(batch => batch.batchId === f.batchId).retainedNoteCount = 0; await f.app.core._commit(next); });
  const plan = await f.app.prepareDeleteReviewImport(f.select); assert.equal(plan.count, 0); assert.ok(plan.planId); assert.ok(plan.confirmationToken);
  const result = await f.app.deleteReviewImport({ planId: plan.planId, confirmationToken: plan.confirmationToken }); assert.equal(result.deletedCount, 0); assert.ok(!f.app.core.getState().reviewBatches.some(batch => batch.batchId === f.batchId)); assert.deepEqual(await readFile(f.originalPdfPath), f.originalPdfBytes);
});
test('native batches, mixed-origin corruption, unsupported statuses and stale digest/revision requests are rejected without mutation', async t => {
  const f = await fixture(t), before = f.app.core.getState();
  for (const change of [{ batchId: 'native-model-review' }, { batchId: 'missing-record' }, { expectedRevision: 4 }, { expectedFileHash: '0'.repeat(64) }, { injected: true }, { originalPath: f.originalPdfPath }]) await assert.rejects(f.app.prepareDeleteReviewImport({ ...f.select, ...change }), error => ['PERMISSION_DENIED', 'VERSION_CONFLICT', 'INVALID_INPUT'].includes(error.code));
  assert.deepEqual(f.app.core.getState(), before);
  for (const location of ['reviewNotes', 'reviewHistory']) {
    await f.app.core._serial(async () => { const next = f.app.core.getState(); next[location].push({ noteId: `native-contamination-${location}`, batchId: f.batchId, origin: 'codex', body: 'Must not be deleted.', revision: 1 }); await f.app.core._commit(next); });
    await assert.rejects(f.app.prepareDeleteReviewImport(f.select), { code: 'PERMISSION_DENIED' });
    await f.app.core._serial(async () => { const next = f.app.core.getState(); next[location] = next[location].filter(note => note.noteId !== `native-contamination-${location}`); await f.app.core._commit(next); });
  }
  await f.app.core._serial(async () => { const next = f.app.core.getState(); next.reviewBatches.find(batch => batch.batchId === f.batchId).status = 'reading'; await f.app.core._commit(next); }); await assert.rejects(f.app.prepareDeleteReviewImport(f.select), { code: 'PERMISSION_DENIED' });
});
test('paper work, model activity and pending operations block both preparing and confirming import deletion', async t => {
  const f = await fixture(t), plan = await f.app.prepareDeleteReviewImport(f.select), before = f.app.core.getState();
  f.app.reviews.starting = true; await assert.rejects(f.app.prepareDeleteReviewImport(f.select), { code: 'PROJECT_BUSY' }); f.app.reviews.starting = false;
  f.app._pendingOps = 1; await assert.rejects(f.app.prepareDeleteReviewImport(f.select), { code: 'PROJECT_BUSY' }); f.app._pendingOps = 0;
  f.app.jobs.set('synthetic-active-job', { finished: false }); await assert.rejects(f.app.deleteReviewImport({ planId: plan.planId, confirmationToken: plan.confirmationToken }), { code: 'PROJECT_BUSY' }); f.app.jobs.delete('synthetic-active-job');
  f.app.chat = { getState: () => ({ busy: true }), close: async () => {} }; await assert.rejects(f.app.prepareDeleteReviewImport(f.select), { code: 'PROJECT_BUSY' }); f.app.chat = null;
  assert.deepEqual(f.app.core.getState(), before);
});
test('deletion confirmations are exact, expire, and all plans for a deleted batch remain unusable after explicit reimport', async t => {
  const f = await fixture(t), first = await f.app.prepareDeleteReviewImport(f.select), second = await f.app.prepareDeleteReviewImport(f.select), before = f.app.core.getState();
  await assert.rejects(f.app.deleteReviewImport({ planId: first.planId, confirmationToken: 'x'.repeat(43) }), { code: 'CONFIRMATION_INVALID' }); await assert.rejects(f.app.deleteReviewImport({ planId: first.planId, confirmationToken: first.confirmationToken, batchId: 'native-model-review' }), { code: 'INVALID_INPUT' });
  const expired = await f.app.prepareDeleteReviewImport(f.select); f.app._reviewImportDeletePlans.get(expired.planId).expiresAt = new Date(Date.now() - 1).toISOString(); await assert.rejects(f.app.deleteReviewImport({ planId: expired.planId, confirmationToken: expired.confirmationToken }), { code: 'CONFIRMATION_INVALID' }); assert.deepEqual(f.app.core.getState(), before);
  await f.app.deleteReviewImport({ planId: first.planId, confirmationToken: first.confirmationToken }); const imported = await f.app.importReviewNotes(f.upload); assert.equal(imported.notes.length, 2); assert.notEqual(imported.idempotent, true);
  for (const plan of [first, second]) await assert.rejects(f.app.deleteReviewImport({ planId: plan.planId, confirmationToken: plan.confirmationToken }), { code: 'CONFIRMATION_INVALID' });
  assert.ok(f.app.core.getState().reviewBatches.some(batch => batch.batchId === imported.batch.batchId)); assert.deepEqual(await readFile(f.originalPdfPath), f.originalPdfBytes);
});
test('another controller changing the exact record invalidates a prepared deletion without deleting its updated notes', async t => {
  const f = await fixture(t), plan = await f.app.prepareDeleteReviewImport(f.select), other = new PaperApplication({ dataRoot: f.dataRoot }); await other.openProject({ root: f.source, mainFile: 'main.tex' });
  await other.core._serial(async () => { const next = other.core.getState(), note = next.reviewHistory.find(note => note.batchId === f.batchId); note.body = 'A later edit preserved by stale-plan rejection.'; note.revision++; await other.core._commit(next); }); await other.close();
  await assert.rejects(f.app.deleteReviewImport({ planId: plan.planId, confirmationToken: plan.confirmationToken }), { code: 'IMPORT_DELETE_PLAN_STALE' }); assert.ok(f.app.core.getState().reviewHistory.some(note => note.body.includes('later edit'))); assert.ok(f.app.core.getState().reviewBatches.some(batch => batch.batchId === f.batchId));
});
test('import deletion is available only through authenticated UI transport and never exposes a model deletion tool', async t => {
  const f = await fixture(t), server = createPaperServer({ service: f.app, uiHtml: '<!doctype html>' }), client = new Client({ name: 'synthetic-import-record-delete', version: '1' }), [cs, ss] = InMemoryTransport.createLinkedPair(); await server.connect(ss); await client.connect(cs); t.after(async () => { await client.close(); await server.close(); });
  const tools = await client.listTools(); assert.ok(!tools.tools.some(tool => /delete.*import/i.test(tool.name))); const ui = tools.tools.find(tool => tool.name === 'bilingual_paper_ui'); assert.deepEqual(ui._meta.ui.visibility, ['app']); assert.ok(ui.inputSchema.properties.action.enum.includes('prepareDeleteReviewImport'));
  const denied = await client.callTool({ name: 'bilingual_paper_ui', arguments: { action: 'prepareDeleteReviewImport', payload: f.select } }); assert.equal(denied.structuredContent.error.code, 'UI_AUTHORIZATION_REQUIRED');
  const panel = await client.callTool({ name: 'bilingual_paper_panel', arguments: {} }), uiToken = panel._meta.paperUiToken, preview = await client.callTool({ name: 'bilingual_paper_ui', arguments: { action: 'prepareDeleteReviewImport', payload: f.select, uiToken } }); assert.equal(preview.isError, undefined, preview._meta?.paperError?.message); assert.equal(preview._meta.paperResult.count, 2);
  const web = await startLocalWeb({ service: f.app, nativeBindingId: 'synthetic-import-record-delete' }); t.after(() => web.close());
  const call = (action, payload, auth = true) => fetch(web.origin + '/api', { method: 'POST', headers: { Origin: web.origin, 'Content-Type': 'application/json', Authorization: auth ? 'Bearer ' + web.token : '' }, body: JSON.stringify({ action, payload }) });
  assert.equal((await call('prepareDeleteReviewImport', f.select, false)).status, 401); const response = await (await call('prepareDeleteReviewImport', f.select)).json(); assert.equal(response.ok, true); const plan = response.result;
  const deleted = await (await call('deleteReviewImport', { planId: plan.planId, confirmationToken: plan.confirmationToken })).json(); assert.equal(deleted.ok, true); assert.equal(deleted.result.deletedCount, 2); assert.deepEqual(await readFile(f.originalPdfPath), f.originalPdfBytes);
});
