import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReviewHistoryRetention, reviewHistoryPreferences } from '../src/review-history-policy.mjs';
import { projectReviewHistory } from '../src/review-history.mjs';

const batch = (id, sourceIds, noteCount, day) => ({ batchId: id, origin: 'codex', status: 'completed', scope: 'selected', reviewedSourceSegmentIds: sourceIds, sourceSegmentIds: sourceIds, noteCount, completedAt: `2026-01-${String(day).padStart(2, '0')}T00:00:00Z` });
const note = (id, batchId, sourceIds) => ({ noteId: id, batchId, origin: 'codex', sourceSegmentIds: sourceIds, body: id, revision: 1 });
function initial() { return { reviewNotes: [note('old-p1', 'old', ['p1']), note('old-p2', 'old', ['p2'])], reviewBatches: [batch('old', ['p1', 'p2'], 2, 1)], reviewHistory: [] }; }
function advance(state, ids = ['p1'], notes = [note('new-p1', 'new', ['p1'])]) { state.reviewNotes.push(...notes); state.reviewBatches.push(batch('new', ids, notes.length, 2)); }
test('retention defaults preserve history and archive only the newly globally superseded model opinions', () => {
  const before = initial(), next = structuredClone(before); advance(next); const result = applyReviewHistoryRetention(next, { beforeState: before, batchId: 'new', at: '2026-01-02T00:00:00Z' });
  assert.deepEqual(reviewHistoryPreferences(before), { retain: true, revision: 0 }); assert.deepEqual(result, { archived: 1, dropped: 0 });
  assert.deepEqual(next.reviewNotes.map(item => item.noteId), ['old-p2', 'new-p1']); assert.equal(next.reviewHistory[0].noteId, 'old-p1'); assert.equal(next.reviewHistory[0].body, before.reviewNotes[0].body); assert.equal(next.reviewHistory[0].supersededByBatchId, 'new'); assert.deepEqual(projectReviewHistory(next).currentIds.sort(), ['new-p1', 'old-p2']);
});
test('retention off drops only future supersession and leaves preexisting history intact', () => {
  const before = initial(); before.reviewHistory = [note('archived', 'ancient', ['p1'])]; before.reviewHistoryPreferences = { retain: false, revision: 1 };
  const next = structuredClone(before); advance(next); const history = structuredClone(next.reviewHistory), result = applyReviewHistoryRetention(next, { beforeState: before, batchId: 'new' });
  assert.deepEqual(result, { archived: 0, dropped: 1 }); assert.deepEqual(next.reviewHistory, history); assert.deepEqual(next.reviewNotes.map(item => item.noteId), ['old-p2', 'new-p1']);
});
test('an old multi-anchor opinion stays active while current for any other paragraph', () => {
  const before = { reviewNotes: [note('shared', 'old', ['p1', 'p2'])], reviewBatches: [batch('old', ['p1', 'p2'], 1, 1)] }, next = structuredClone(before); advance(next);
  applyReviewHistoryRetention(next, { beforeState: before, batchId: 'new' }); assert.ok(next.reviewNotes.some(item => item.noteId === 'shared')); assert.equal(next.reviewHistory, undefined); assert.ok(projectReviewHistory(next).currentIds.includes('shared'));
});
test('completed zero findings with exact reviewed source IDs archive old heads without resurrection', () => {
  const before = initial(), next = structuredClone(before); advance(next, ['p1'], []); applyReviewHistoryRetention(next, { beforeState: before, batchId: 'new' });
  assert.deepEqual(projectReviewHistory(next, { sourceIds: ['p1'] }).currentIds, []); assert.equal(next.reviewHistory[0].noteId, 'old-p1');
  next.reviewHistory = []; assert.deepEqual(projectReviewHistory(next, { sourceIds: ['p1'] }).currentIds, []); assert.equal(next.reviewBatches.at(-1).reviewedSourceSegmentIds[0], 'p1');
});
test('nonempty complete reviews advance every authoritative reviewed paragraph and do not automatically delete external notes', () => {
  const before = initial(); before.reviewNotes.push({ ...note('external', 'external', ['p1']), origin: 'external' }); before.reviewBatches.push({ ...batch('external', ['p1'], 1, 1), origin: 'external', fileHash: 'a'.repeat(64) });
  const next = structuredClone(before); advance(next, ['p1', 'p2']); applyReviewHistoryRetention(next, { beforeState: before, batchId: 'new' });
  assert.ok(next.reviewHistory.some(item => item.noteId === 'old-p2')); assert.ok(next.reviewNotes.some(item => item.noteId === 'external')); assert.ok(!next.reviewHistory.some(item => item.noteId === 'external')); assert.deepEqual(projectReviewHistory(next, { sourceIds: ['p2'] }).currentIds, []);
});
test('failed or ongoing generations cannot trigger retention mutation', () => {
  for (const status of ['reading', 'failed', 'cancelled']) {
    const before = initial(), next = structuredClone(before); next.reviewBatches.push({ ...batch('new', ['p1'], 0, 2), status }); const expected = structuredClone(next.reviewNotes);
    applyReviewHistoryRetention(next, { beforeState: before, batchId: 'new' }); assert.deepEqual(next.reviewNotes, expected); assert.deepEqual(next.reviewHistory, []);
  }
});
