import test from 'node:test';
import assert from 'node:assert/strict';
import { projectReviewHistory } from '../src/review-history.mjs';

const batch = (batchId, day, extra = {}) => ({ batchId, origin: 'codex', status: 'completed', createdAt: `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`, ...extra });
const note = (noteId, batchId, sourceSegmentIds = [], extra = {}) => ({ noteId, batchId, sourceSegmentIds, body: noteId, revision: 1, status: 'open', ...extra });
const ids = values => values.map(value => value.noteId).sort();
test('the newest native generation replaces older external opinions while all notes in the same generation remain current', () => {
  const state = { reviewBatches: [batch('external', 1, { origin: 'external', filename: 'old.pdf' }), batch('native', 2)], reviewNotes: [note('old', 'external', ['p1'], { origin: 'external' }), note('new-a', 'native', ['p1']), note('new-b', 'native', ['p1'], { status: 'resolved', decision: 'keep' })] };
  const before = structuredClone(state), result = projectReviewHistory(state, { sourceIds: ['p1'] });
  assert.deepEqual(ids(result.current), ['new-a', 'new-b']); assert.deepEqual(ids(result.history), ['old']);
  assert.deepEqual(result.globallyHistoricalIds, ['old']); assert.equal(result.latestBySource.p1, 'native'); assert.deepEqual(state, before);
});
test('a multi-anchor opinion may be historical locally but current elsewhere and is never globally clearable', () => {
  const state = { reviewBatches: [batch('old', 1), batch('new', 2)], reviewNotes: [note('shared', 'old', ['p1', 'p2']), note('new-one', 'new', ['p1'])] };
  const first = projectReviewHistory(state, { sourceIds: ['p1'] }); assert.deepEqual(ids(first.current), ['new-one']); assert.deepEqual(ids(first.history), ['shared']); assert.deepEqual(first.globallyHistoricalIds, []);
  const second = projectReviewHistory(state, { sourceIds: ['p2'] }); assert.deepEqual(ids(second.current), ['shared']); assert.deepEqual(second.history, []);
  const all = projectReviewHistory(state); assert.deepEqual(ids(all.current), ['new-one', 'shared']); assert.deepEqual(all.history, []);
});
test('presentation enrichment, decisions and import restoration never advance a review generation', () => {
  const state = { reviewBatches: [batch('old', 1, { origin: 'external', revision: 90, updatedAt: '2027-01-01T00:00:00Z', restoredAt: '2027-01-01T00:00:00Z' }), batch('new', 2)], reviewNotes: [note('old', 'old', ['p1'], { revision: 100, currentSource: 'Enriched.', updatedAt: '2027-01-01T00:00:00Z' }), note('new', 'new', ['p1'])] };
  assert.deepEqual(ids(projectReviewHistory(state).current), ['new']);
});
test('failed and in-progress batches retain actual partial notes without advancing by failure time or declared unreturned scope', () => {
  const state = { reviewBatches: [batch('partial', 1, { status: 'failed', completedAt: '2026-12-01T00:00:00Z', sourceSegmentIds: ['p1', 'p2', 'p3'] }), batch('new', 2), batch('empty', 3, { status: 'cancelled', noteCount: 0, sourceSegmentIds: ['p1', 'p2'] })], reviewNotes: [note('part-one', 'partial', ['p1']), note('part-two', 'partial', ['p2']), note('new', 'new', ['p1'])] };
  const out = projectReviewHistory(state); assert.deepEqual(ids(out.current), ['new', 'part-two']); assert.deepEqual(ids(out.history), ['part-one']); assert.equal(out.latestBySource.p3, undefined);
});
test('explicit completed zero-finding source coverage advances an empty head and survives history clearing', () => {
  const state = { reviewBatches: [batch('old', 1), batch('zero', 2, { noteCount: 0, sourceSegmentIds: ['p1'] })], reviewNotes: [note('shared', 'old', ['p1', 'p2']), note('old-one', 'old', ['p1'])] };
  const first = projectReviewHistory(state, { sourceIds: ['p1'] }); assert.deepEqual(first.current, []); assert.deepEqual(ids(first.history), ['old-one', 'shared']); assert.deepEqual(first.globallyHistoricalIds, ['old-one']); assert.equal(first.latestBySource.p1, 'zero');
  state.reviewNotes = state.reviewNotes.filter(value => !first.globallyHistoricalIds.includes(value.noteId));
  assert.deepEqual(projectReviewHistory(state, { sourceIds: ['p1'] }).current, []); assert.deepEqual(ids(projectReviewHistory(state, { sourceIds: ['p2'] }).current), ['shared']);
  const noEvidence = { reviewBatches: [batch('old', 1), batch('empty', 4, { noteCount: 0 })], reviewNotes: [note('kept', 'old', ['p1'])] };
  assert.deepEqual(ids(projectReviewHistory(noEvidence).current), ['kept']);
});
test('authoritative completed reviewed source IDs supersede earlier findings even where the new result has no finding', () => {
  const state = { reviewBatches: [batch('old', 1), batch('complete', 2, { noteCount: 1, reviewedSourceSegmentIds: ['p1', 'p2'] })], reviewNotes: [note('old-two', 'old', ['p2']), note('shared', 'old', ['p2', 'p3']), note('new-one', 'complete', ['p1'])] };
  const result = projectReviewHistory(state, { sourceIds: ['p2'] });
  assert.deepEqual(result.current, []); assert.deepEqual(ids(result.history), ['old-two', 'shared']); assert.deepEqual(result.globallyHistoricalIds, ['old-two']);
  assert.equal(result.latestBySource.p1, 'complete'); assert.equal(result.latestBySource.p2, 'complete'); assert.equal(result.latestBySource.p3, 'old');
  assert.deepEqual(ids(projectReviewHistory(state, { sourceIds: ['p3'] }).current), ['shared']);
});
test('ordinary conversation context never advances empty review heads, even if it contains a reviewed-source field', () => {
  for (const extra of [{}, { reviewedSourceSegmentIds: ['p1', 'p2'] }]) {
    const state = { reviewBatches: [batch('old', 1), batch('chat', 2, { conversation: true, scope: 'paper', sourceSegmentIds: ['p1', 'p2'], noteCount: 0, ...extra })], reviewNotes: [note('old-one', 'old', ['p1']), note('old-two', 'old', ['p2'])] };
    assert.deepEqual(ids(projectReviewHistory(state).current), ['old-one', 'old-two']);
    assert.deepEqual(projectReviewHistory(state).globallyHistoricalIds, []);
    state.reviewNotes.push(note('feedback', 'chat', ['p1'])); state.reviewBatches[1].noteCount = 1;
    assert.deepEqual(ids(projectReviewHistory(state).current), ['feedback', 'old-two']);
    assert.deepEqual(projectReviewHistory(state).globallyHistoricalIds, ['old-one']);
  }
});
test('retired imports stay outside iteration history and archived opinions never become current', () => {
  const state = { reviewBatches: [batch('retired', 4, { origin: 'external', status: 'retired', active: false }), batch('old', 1), batch('new', 2)], reviewNotes: [note('retired-note', 'retired', ['p1'], { origin: 'external' }), note('old-note', 'old', ['p1'])], reviewHistory: [note('archived-new', 'new', ['p1'], { archivedAt: '2026-12-01T00:00:00Z', archivedReason: 'superseded-review' })] };
  const out = projectReviewHistory(state); assert.deepEqual(out.current, []); assert.deepEqual(ids(out.history), ['archived-new', 'old-note']); assert.deepEqual(out.globallyHistoricalIds, ['archived-new', 'old-note']);
  assert.ok(!JSON.stringify(out).includes('retired-note'));
});
test('unlocated generations supersede only an explicit batch family and never guess candidate paragraph anchors', () => {
  const state = { reviewBatches: [batch('old-native', 1, { scope: 'paper' }), batch('new-native', 2, { scope: 'paper' }), batch('file-a', 1, { origin: 'external', filename: 'a.pdf' }), batch('file-b', 3, { origin: 'external', filename: 'b.pdf' })], reviewNotes: [note('u-old', 'old-native', [], { candidates: ['p1'] }), note('u-new', 'new-native'), note('external-a', 'file-a'), note('external-b', 'file-b')] };
  const out = projectReviewHistory(state, { sourceIds: ['p1'], filter: 'unlocated' }); assert.deepEqual(ids(out.current), ['external-a', 'external-b', 'u-new']); assert.deepEqual(ids(out.history), ['u-old']); assert.equal(out.latestBySource.p1, undefined);
  assert.deepEqual(projectReviewHistory(state, { sourceIds: ['p1'] }).current, []);
});
test('global opinions use their own latest generation and remain visible without a selected paragraph', () => {
  const state = { reviewBatches: [batch('old', 1), batch('new', 2)], reviewNotes: [note('g-old', 'old', [], { global: true }), note('g-new', 'new', [], { scope: 'global' }), note('anchor', 'old', ['p1'])] };
  const out = projectReviewHistory(state, { sourceIds: [] }); assert.deepEqual(ids(out.current), ['g-new']); assert.deepEqual(ids(out.history), ['g-old']); assert.equal(out.latestGlobalBatchId, 'new');
});
test('missing generation metadata conservatively keeps legacy opinions current and deterministic batch ties use array order', () => {
  const state = { reviewBatches: [batch('b', 1), batch('a', 1)], reviewNotes: [note('legacy-a', undefined, ['p1']), note('legacy-b', undefined, ['p1']), note('missing', 'missing-batch', ['p1']), note('older', 'b', ['p1']), note('newer', 'a', ['p1'])] };
  const out = projectReviewHistory(state); assert.deepEqual(ids(out.current), ['legacy-a', 'legacy-b', 'missing', 'newer']); assert.deepEqual(out.globallyHistoricalIds, ['older']); assert.equal(out.latestBySource.p1, 'a');
});
test('duplicate archived IDs cannot make an active current opinion clearable', () => {
  const active = note('one', 'new', ['p1']);
  const state = { reviewBatches: [batch('new', 1)], reviewNotes: [active], reviewHistory: [{ ...active, archivedAt: '2027-01-01T00:00:00Z' }] };
  const out = projectReviewHistory(state); assert.deepEqual(ids(out.current), ['one']); assert.deepEqual(out.history, []); assert.deepEqual(out.globallyHistoricalIds, []);
});
test('only full current source-graph and changed-snapshot evidence makes completely orphaned anchors historical', () => {
  const state = { project: { snapshotId: 'new-snapshot' }, readingParagraphs: [{ id: 'derived-live' }], segments: [{ id: 'canonical-live' }], reviewBatches: [batch('old', 1)], reviewNotes: [note('orphan', 'old', ['gone'], { sourceSnapshotId: 'old-snapshot' }), note('mixed', 'old', ['gone', 'derived-live'], { sourceSnapshotId: 'old-snapshot' }), note('canonical', 'old', ['canonical-live'], { sourceSnapshotId: 'old-snapshot' }), note('same-snapshot', 'old', ['unknown'], { sourceSnapshotId: 'new-snapshot' }), note('unknown-snapshot', 'old', ['unknown'])] };
  const out = projectReviewHistory(state); assert.deepEqual(ids(out.current), ['canonical', 'mixed', 'same-snapshot', 'unknown-snapshot']); assert.deepEqual(ids(out.history), ['orphan']); assert.deepEqual(out.globallyHistoricalIds, ['orphan']);
  const canonicalOnly = structuredClone(state); delete canonicalOnly.readingParagraphs;
  assert.deepEqual(ids(projectReviewHistory(canonicalOnly).current), ['canonical', 'mixed', 'orphan', 'same-snapshot', 'unknown-snapshot']); assert.deepEqual(projectReviewHistory(canonicalOnly).globallyHistoricalIds, []);
  const noProjectProof = structuredClone(state); delete noProjectProof.project;
  assert.ok(projectReviewHistory(noProjectProof).currentIds.includes('orphan'));
});
