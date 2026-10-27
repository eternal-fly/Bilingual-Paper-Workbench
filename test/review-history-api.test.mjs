import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PaperApplication } from '../src/application.mjs';
import { createPaperServer } from '../src/server.mjs';
import { startLocalWeb } from '../src/local-web.mjs';
import { projectReviewHistory } from '../src/review-history.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const owned = path.join(root, 'work/review-history-api-tests'); await mkdir(owned, { recursive: true }); const directory = await mkdtemp(path.join(owned, 'case-')), source = path.join(directory, 'source'); await mkdir(source);
  const original = Buffer.from('\\documentclass{article}\n\\begin{document}\n\nFirst synthetic paragraph.\n\nSecond synthetic paragraph.\n\n\\end{document}\n'); await writeFile(path.join(source, 'main.tex'), original);
  const dataRoot = path.join(directory, 'private'), app = new PaperApplication({ dataRoot }); await app.openProject({ root: source, mainFile: 'main.tex' }); const [p1, p2] = app.getState().readingParagraphs.map(item => item.id);
  await app.core._serial(async () => { const next = app.core.getState(), snapshotId = next.project.snapshotId;
    const batch = (id, origin, day, count, extra = {}) => ({ batchId: id, origin, scope: 'paper', status: 'completed', createdAt: `2026-01-${day}T00:00:00Z`, completedAt: `2026-01-${day}T00:00:00Z`, noteCount: count, ...extra });
    const note = (id, batchId, ids, origin = 'codex') => ({ noteId: id, batchId, origin, sourceSegmentIds: ids, sourceSnapshotId: snapshotId, body: id, revision: 1, decision: 'keep' });
    next.reviewBatches = [batch('archive', 'codex', '01', 1), batch('old', 'codex', '02', 2), batch('external-old', 'external', '02', 1, { filename: 'provided-review.pdf', fileHash: 'a'.repeat(64) }), batch('new', 'codex', '03', 2), batch('retired', 'external', '04', 1, { status: 'retired', active: false })];
    next.reviewNotes = [note('old-p1', 'old', [p1]), note('shared-history', 'old', [p1, p2]), note('external-history', 'external-old', [p1], 'external'), note('current-p1', 'new', [p1]), note('current-p2', 'new', [p2]), note('retired-input', 'retired', [p1], 'external')];
    next.reviewHistory = [{ ...note('archived-p1', 'archive', [p1]), archivedAt: '2026-01-03T00:00:00Z' }]; await app.core._commit(next);
  });
  t.after(async () => { await app.close(); assert.ok(path.resolve(directory).startsWith(path.resolve(owned) + path.sep)); await rm(directory, { recursive: true, force: true }); });
  return { app, dataRoot, source, original, p1, p2 };
}
test('future history-retention preference uses per-project CAS, persists and never retroactively clears records', async t => {
  const f = await fixture(t), before = f.app.core.getState(); assert.deepEqual(f.app.getState().reviewHistoryPreferences, { retain: true, revision: 0 });
  assert.deepEqual(await f.app.configureReviewHistory({ retain: false, expectedRevision: 0 }), { retain: false, revision: 1 });
  await assert.rejects(f.app.configureReviewHistory({ retain: true, expectedRevision: 0 }), { code: 'VERSION_CONFLICT' });
  assert.equal((await f.app.configureReviewHistory({ retain: false, expectedRevision: 1 })).idempotent, true);
  assert.deepEqual(f.app.core.getState().reviewNotes, before.reviewNotes); assert.deepEqual(f.app.core.getState().reviewHistory, before.reviewHistory);
  const reopened = new PaperApplication({ dataRoot: f.dataRoot }); await reopened.openProject({ root: f.source, mainFile: 'main.tex' }); assert.deepEqual(reopened.getState().reviewHistoryPreferences, { retain: false, revision: 1 }); await reopened.close();
});
test('selected clear previews exact origins and removes only globally historical notes wholly inside that paragraph scope', async t => {
  const f = await fixture(t), before = f.app.core.getState(), flow = structuredClone(f.app.flow), current = projectReviewHistory(before).currentIds;
  const plan = await f.app.prepareClearReviewHistory({ scope: 'selected', sourceIds: [f.p1] }); assert.equal(plan.count, 3); assert.deepEqual(plan.byOrigin, { codex: 2, external: 1 }); assert.ok(plan.sources.some(item => item.filename === 'provided-review.pdf')); assert.deepEqual(f.app.core.getState(), before); assert.ok(!JSON.stringify(f.app.getState()).includes(plan.confirmationToken));
  const out = await f.app.clearReviewHistory({ planId: plan.planId, confirmationToken: plan.confirmationToken }); assert.equal(out.clearedCount, 3);
  const after = f.app.core.getState(); assert.deepEqual(projectReviewHistory(after).currentIds, current); assert.ok(after.reviewNotes.some(note => note.noteId === 'shared-history')); assert.ok(after.reviewNotes.some(note => note.noteId === 'retired-input')); assert.equal(after.reviewHistory.length, 0);
  for (const id of ['current-p1', 'current-p2', 'shared-history', 'retired-input']) assert.deepEqual(after.reviewNotes.find(note => note.noteId === id), before.reviewNotes.find(note => note.noteId === id));
  assert.deepEqual(after.translations, before.translations); assert.deepEqual(after.originals, before.originals); assert.deepEqual(after.proposals, before.proposals); assert.deepEqual(f.app.flow, flow); assert.deepEqual(await readFile(path.join(f.source, 'main.tex')), f.original);
  await assert.rejects(f.app.clearReviewHistory({ planId: plan.planId, confirmationToken: plan.confirmationToken }), { code: 'CONFIRMATION_INVALID' });
});
test('project history clear retains generation heads and source provenance rather than reviving old notes', async t => {
  const f = await fixture(t), before = f.app.core.getState(), current = projectReviewHistory(before).currentIds;
  const plan = await f.app.prepareClearReviewHistory({ scope: 'project' }); assert.equal(plan.count, 4); await f.app.clearReviewHistory({ planId: plan.planId, confirmationToken: plan.confirmationToken });
  const after = f.app.core.getState(); assert.deepEqual(projectReviewHistory(after).currentIds, current); assert.equal(after.reviewBatches.length, before.reviewBatches.length); assert.equal(after.reviewBatches.find(batch => batch.batchId === 'external-old').fileHash, 'a'.repeat(64)); assert.equal(after.reviewBatches.find(batch => batch.batchId === 'old').noteCount, 2); assert.equal(after.reviewBatches.find(batch => batch.batchId === 'old').retainedNoteCount, 0); assert.equal(after.reviewBatches.find(batch => batch.batchId === 'old').clearedHistoricalCount, 2);
  assert.equal((await f.app.prepareClearReviewHistory({ scope: 'project' })).count, 0);
});
test('idempotent reimport never recreates explicitly cleared historical annotations from a retained source file', async t => {
  const f = await fixture(t), upload = { filename: 'retained-review.txt', format: 'txt', fileHash: 'b'.repeat(64), text: '“First synthetic paragraph.” Please clarify this sentence.' }, imported = await f.app.importReviewNotes(upload);
  await f.app.core._serial(async () => { const next = f.app.core.getState(); next.reviewBatches.find(batch => batch.batchId === 'new').completedAt = new Date(Date.now() + 60000).toISOString(); await f.app.core._commit(next); });
  const plan = await f.app.prepareClearReviewHistory({ scope: 'project' }); assert.ok(plan.count >= 1); await f.app.clearReviewHistory({ planId: plan.planId, confirmationToken: plan.confirmationToken });
  const after = f.app.core.getState(), batch = after.reviewBatches.find(item => item.batchId === imported.batch.batchId); assert.equal(batch.noteCount, 1); assert.equal(batch.retainedNoteCount, 0); assert.equal(batch.fileHash, upload.fileHash);
  const repeated = await f.app.importReviewNotes(upload); assert.equal(repeated.idempotent, true); assert.deepEqual(repeated.notes, []); assert.ok(!f.app.core.getState().reviewNotes.some(note => note.batchId === imported.batch.batchId)); assert.deepEqual(await readFile(path.join(f.source, 'main.tex')), f.original);
});
test('clear plans require exact unexpired one-use confirmation and fail closed after concurrent history or preference changes', async t => {
  const f = await fixture(t), before = f.app.core.getState(), plan = await f.app.prepareClearReviewHistory({ scope: 'project' });
  await assert.rejects(f.app.clearReviewHistory({ planId: plan.planId, confirmationToken: 'x'.repeat(43) }), { code: 'CONFIRMATION_INVALID' });
  await assert.rejects(f.app.clearReviewHistory({ planId: plan.planId, confirmationToken: plan.confirmationToken, sourceIds: [f.p2] }), { code: 'INVALID_INPUT' });
  await f.app.configureReviewHistory({ retain: false, expectedRevision: 0 }); await assert.rejects(f.app.clearReviewHistory({ planId: plan.planId, confirmationToken: plan.confirmationToken }), { code: 'HISTORY_PLAN_STALE' });
  const expired = await f.app.prepareClearReviewHistory({ scope: 'project' }); f.app._reviewHistoryClearPlans.get(expired.planId).expiresAt = new Date(Date.now() - 1).toISOString(); await assert.rejects(f.app.clearReviewHistory({ planId: expired.planId, confirmationToken: expired.confirmationToken }), { code: 'CONFIRMATION_INVALID' });
  assert.deepEqual(f.app.core.getState().reviewNotes, before.reviewNotes); assert.deepEqual(f.app.core.getState().reviewHistory, before.reviewHistory);
});
test('another controller changing an opinion invalidates the exact history-clear preview without deleting anything', async t => {
  const f = await fixture(t), plan = await f.app.prepareClearReviewHistory({ scope: 'project' }), other = new PaperApplication({ dataRoot: f.dataRoot }); await other.openProject({ root: f.source, mainFile: 'main.tex' });
  await other.core._serial(async () => { const next = other.core.getState(); next.reviewNotes.find(note => note.noteId === 'old-p1').body = 'A later retained annotation edit.'; await other.core._commit(next); }); await other.close();
  await assert.rejects(f.app.clearReviewHistory({ planId: plan.planId, confirmationToken: plan.confirmationToken }), { code: 'HISTORY_PLAN_STALE' }); assert.equal(f.app.core.getState().reviewNotes.length, 6);
});
test('history clear uses the complete current reading graph for a provably orphaned old-snapshot annotation', async t => {
  const f = await fixture(t);
  await f.app.core._serial(async () => { const next = f.app.core.getState(); next.reviewNotes.push({ noteId: 'removed-paragraph-history', batchId: 'old', origin: 'codex', sourceSegmentIds: ['read-removed-source'], sourceSnapshotId: 'snap-history-before-removal', body: 'Historical removed paragraph.', revision: 1 }); await f.app.core._commit(next); });
  const before = f.app.core.getState(), plan = await f.app.prepareClearReviewHistory({ scope: 'selected', sourceIds: ['read-removed-source'] }); assert.equal(plan.count, 1); assert.ok(projectReviewHistory(f.app.getState()).globallyHistoricalIds.includes('removed-paragraph-history'));
  await f.app.clearReviewHistory({ planId: plan.planId, confirmationToken: plan.confirmationToken });
  assert.ok(!f.app.core.getState().reviewNotes.some(note => note.noteId === 'removed-paragraph-history'));
  for (const id of ['current-p1', 'current-p2']) assert.deepEqual(f.app.core.getState().reviewNotes.find(note => note.noteId === id), before.reviewNotes.find(note => note.noteId === id));
  assert.equal(Object.hasOwn(f.app.core.getState(), 'readingParagraphs'), false); assert.deepEqual(await readFile(path.join(f.source, 'main.tex')), f.original);
});
test('history management is private authenticated UI authority and cannot be injected through a model tool', async t => {
  const f = await fixture(t), server = createPaperServer({ service: f.app, uiHtml: '<!doctype html>' }), client = new Client({ name: 'synthetic-history-management', version: '1' }), [cs, ss] = InMemoryTransport.createLinkedPair(); await server.connect(ss); await client.connect(cs); t.after(async () => { await client.close(); await server.close(); });
  const tools = await client.listTools(); assert.ok(!tools.tools.some(tool => /clear.*history|configure.*history/i.test(tool.name))); const ui = tools.tools.find(tool => tool.name === 'bilingual_paper_ui'); assert.deepEqual(ui._meta.ui.visibility, ['app']);
  const denied = await client.callTool({ name: 'bilingual_paper_ui', arguments: { action: 'prepareClearReviewHistory', payload: { scope: 'project' } } }); assert.equal(denied.structuredContent.error.code, 'UI_AUTHORIZATION_REQUIRED');
  const panel = await client.callTool({ name: 'bilingual_paper_panel', arguments: {} }), uiToken = panel._meta.paperUiToken, accepted = await client.callTool({ name: 'bilingual_paper_ui', arguments: { action: 'prepareClearReviewHistory', payload: { scope: 'project' }, uiToken } }); assert.equal(accepted.isError, undefined, accepted._meta?.paperError?.message); assert.equal(accepted._meta.paperResult.count, 4);
  const web = await startLocalWeb({ service: f.app, nativeBindingId: 'synthetic-history-ui' }); t.after(() => web.close()); const call = (payload, authenticated) => fetch(web.origin + '/api', { method: 'POST', headers: { Origin: web.origin, 'Content-Type': 'application/json', Authorization: authenticated ? 'Bearer ' + web.token : '' }, body: JSON.stringify(payload) });
  assert.equal((await call({ action: 'prepareClearReviewHistory', payload: { scope: 'project' } }, false)).status, 401);
  const response = await (await call({ action: 'configureReviewHistory', payload: { retain: false, expectedRevision: 0 } }, true)).json(); assert.equal(response.ok, true); assert.equal(response.result.retain, false); assert.equal(f.app.core.getState().reviewNotes.length, 6);
});
