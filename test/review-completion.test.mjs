import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { captureAdoptedReviewEvidence, createReviewCompletionContext, deriveReviewCompletion, deriveReviewCompletions, reviewConcernHash } from '../src/review-completion.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const stamp = second => `2026-10-26T12:00:${String(second).padStart(2, '0')}.000Z`;
function fixture() {
  const before = 'Original exact claim.', after = 'Reviewed exact claim.';
  const note = { noteId: 'external-1', batchId: 'batch-1', origin: 'external', body: 'Clarify this precise bounded claim.', decision: 'adopt', decisionUpdatedAt: stamp(1), decisionSnapshotId: 'before', sourceSnapshotId: 'before', sourceSegmentIds: ['p1'], sourceHashes: { p1: hash(before) }, revision: 2 };
  const proposal = { proposalId: 'proposal-1', projectId: 'paper', baseSnapshotId: 'before', reviewState: 'approved', applicationState: 'applied', transactionId: 'tx-1', edits: [{ segmentId: 'p1', path: 'main.tex', before, beforeHash: hash(before), replacement: after }] };
  const transaction = { transactionId: 'tx-1', projectId: 'paper', state: 'applied', baseSnapshotId: 'before', afterSnapshotId: 'after', proposalIds: ['proposal-1'], committedAt: stamp(2), appliedAt: stamp(3), sourceChangedAgain: false };
  const state = { project: { id: 'paper', snapshotId: 'after' }, readingParagraphs: [{ id: 'p1', path: 'main.tex', source: after, sourceHash: hash(after) }], proposals: [proposal], transactions: [transaction] };
  return { before, after, note, proposal, transaction, state };
}

test('only an adopted note followed by the exact accepted source write is complete', () => {
  const f = fixture(), before = structuredClone(f);
  const result = deriveReviewCompletion(f.note, f.state);
  assert.equal(result.completed, true); assert.equal(result.skipInMatching, true); assert.deepEqual(result.transactionIds, ['tx-1']);
  assert.equal(result.paragraphs[0].beforeHash, hash(f.before)); assert.equal(result.paragraphs[0].afterHash, hash(f.after));
  assert.deepEqual(f, before);
});

test('pending/revise/keep, adopted-only and preview compilation never count as written completion', () => {
  for (const decision of ['pending', 'revise', 'keep', undefined]) { const f = fixture(); f.note.decision = decision; assert.equal(deriveReviewCompletion(f.note, f.state).completed, false); }
  for (const state of ['ready', 'compiling', 'failed', 'conflict', 'recoveryRequired']) { const f = fixture(); f.transaction.state = state; assert.equal(deriveReviewCompletion(f.note, f.state).completed, false); }
  const f = fixture(); f.state.transactions = []; assert.equal(deriveReviewCompletion(f.note, f.state).completed, false);
});

test('adoption after the commit does not retrospectively claim a source write', () => {
  const f = fixture(); f.note.decisionUpdatedAt = stamp(4); assert.equal(deriveReviewCompletion(f.note, f.state).completed, false);
  f.note.decisionUpdatedAt = stamp(1); delete f.note.decisionSnapshotId; assert.equal(deriveReviewCompletion(f.note, f.state).completed, false);
});

test('wrong project, snapshot, prior hash, source identity or unaccepted proposal cannot prove completion', () => {
  for (const mutate of [f => f.transaction.projectId = 'other', f => f.proposal.projectId = 'other', f => f.note.projectId = 'other', f => f.transaction.baseSnapshotId = 'foreign', f => f.proposal.baseSnapshotId = 'foreign', f => f.proposal.edits[0].beforeHash = hash('other'), f => f.proposal.edits[0].segmentId = 'other', f => f.proposal.applicationState = 'notApplied', f => f.proposal.reviewState = 'pending', f => f.transaction.sourceChangedAgain = true, f => f.transaction.afterSnapshotId = null]) {
    const f = fixture(); mutate(f); assert.equal(deriveReviewCompletion(f.note, f.state).completed, false);
  }
});

test('a later manual paragraph edit or a changed/missing current identity reopens matching', () => {
  const f = fixture(); f.state.readingParagraphs[0].source = 'A further manual change.'; f.state.readingParagraphs[0].sourceHash = hash(f.state.readingParagraphs[0].source); assert.equal(deriveReviewCompletion(f.note, f.state).completed, false);
  f.state.readingParagraphs[0] = { id: 'relocated', source: f.after, sourceHash: hash(f.after) }; assert.equal(deriveReviewCompletion(f.note, f.state).completed, false);
});

test('undo, reversion and no-op candidates cannot count as a completed concern', () => {
  for (const mutate of [f => f.transaction.revertedBy = 'undo-1', f => f.proposal.applicationState = 'reverted', f => f.proposal.context = { undoOf: 'tx-other' }, f => { f.proposal.edits[0].replacement = f.before; f.state.readingParagraphs[0].source = f.before; f.state.readingParagraphs[0].sourceHash = hash(f.before); }]) {
    const f = fixture(); mutate(f); assert.equal(deriveReviewCompletion(f.note, f.state).completed, false);
  }
});

test('explicit reopen suppresses only the completed transaction, without erasing decision/proof history', () => {
  const f = fixture(); f.note.reviewReopen = { transactionId: 'tx-1', at: stamp(5), revision: 3 };
  const result = deriveReviewCompletion(f.note, f.state); assert.equal(result.completed, false); assert.equal(result.skipInMatching, false); assert.equal(result.status, 'reopened'); assert.equal(result.paragraphs.length, 1);
  f.note.reviewReopen.transactionId = 'older-transaction'; assert.equal(deriveReviewCompletion(f.note, f.state).completed, true);
});

test('all linked paragraphs must be written; a partial multi-paragraph opinion stays open', () => {
  const f = fixture(); f.note.sourceSegmentIds.push('p2'); f.note.sourceHashes.p2 = hash('Another old claim.');
  f.state.readingParagraphs.push({ id: 'p2', path: 'main.tex', source: 'Another old claim.', sourceHash: hash('Another old claim.') });
  const partial = deriveReviewCompletion(f.note, f.state); assert.equal(partial.completed, false); assert.equal(partial.paragraphs.length, 1); assert.deepEqual(partial.completedSourceSegmentIds, ['p1']); assert.equal(partial.partialCompletedCount, 1); assert.equal(partial.skipInMatching, false);
  f.proposal.edits.push({ segmentId: 'p2', path: 'main.tex', before: 'Another old claim.', beforeHash: f.note.sourceHashes.p2, replacement: 'Another reviewed claim.' });
  Object.assign(f.state.readingParagraphs[1], { source: 'Another reviewed claim.', sourceHash: hash('Another reviewed claim.') });
  assert.equal(deriveReviewCompletion(f.note, f.state).completed, true);
});

test('explicit decision anchor inventory survives safe association refresh, but ambiguous legacy history does not prove adoption scope', () => {
  const f = fixture(); Object.assign(f.note, { decisionSourceSegmentIds: ['p1'], decisionSourceHashes: { p1: hash(f.before) }, sourceSnapshotId: 'after', sourceHashes: { p1: hash(f.after) } });
  assert.equal(deriveReviewCompletion(f.note, f.state).completed, true);
  delete f.note.decisionSourceSegmentIds; delete f.note.decisionSourceHashes;
  f.note.sourceValidationHistory = [{ sourceSnapshotId: 'before', sourceSegmentIds: ['p1'], sourceHashes: { p1: hash(f.before) } }];
  assert.equal(deriveReviewCompletion(f.note, f.state).completed, true);
  f.note.sourceValidationHistory.push({ sourceSnapshotId: 'before', sourceSegmentIds: ['other'], sourceHashes: { other: hash('different anchor') } });
  assert.equal(deriveReviewCompletion(f.note, f.state).completed, false);
});

test('unrelated later source versions retain completion and a genuinely new concern never inherits paragraph completion', () => {
  const f = fixture(); f.state.project.snapshotId = 'later-unrelated-version';
  assert.equal(deriveReviewCompletion(f.note, f.state).completed, true);
  const newConcern = { ...f.note, noteId: 'new-concern', body: 'A new independent concern.', decision: 'pending' };
  assert.equal(deriveReviewCompletion(newConcern, f.state).completed, false);
  const summary = deriveReviewCompletions({ reviewNotes: [f.note, newConcern] }, f.state);
  assert.equal(summary.completedCount, 1); assert.equal(summary.completedParagraphCount, 1);
});

test('later writes can complete the other anchored paragraph only through applied snapshot ancestry', () => {
  const f = fixture(), before = 'Another original.', after = 'Another reviewed.';
  f.note.sourceSegmentIds.push('p2'); f.note.sourceHashes.p2 = hash(before);
  f.state.proposals.push({ ...f.proposal, proposalId: 'proposal-2', transactionId: 'tx-2', baseSnapshotId: 'after', edits: [{ segmentId: 'p2', path: 'main.tex', before, beforeHash: hash(before), replacement: after }] });
  f.state.transactions.push({ ...f.transaction, transactionId: 'tx-2', proposalIds: ['proposal-2'], baseSnapshotId: 'after', afterSnapshotId: 'after-second', committedAt: stamp(4), appliedAt: stamp(5) });
  f.state.readingParagraphs.push({ id: 'p2', source: after, sourceHash: hash(after) }); f.state.project.snapshotId = 'after-second';
  assert.equal(deriveReviewCompletion(f.note, f.state).completed, true);
  f.state.transactions[1].baseSnapshotId = 'unrelated-root'; f.state.proposals[1].baseSnapshotId = 'unrelated-root';
  assert.equal(deriveReviewCompletion(f.note, f.state).completed, false);
});

function ledgerFixture() {
  const f = fixture(), pending = structuredClone(f.proposal); Object.assign(pending, { applicationState: 'notApplied', reviewState: 'pending' }); delete pending.transactionId;
  const committing = { ...f.transaction, state: 'committing' }; delete committing.afterSnapshotId; delete committing.appliedAt;
  const raw = { project: { id: 'paper', snapshotId: 'before' }, proposals: [pending], reviewNotes: [f.note], reviewBatches: [{ batchId: f.note.batchId, origin: 'external', status: 'completed', fileHash: hash('imported file') }] };
  const evidence = captureAdoptedReviewEvidence(raw, { transaction: committing });
  return { ...f, raw, committing, evidence };
}

test('commit-boundary evidence captures explicit adoption only, remains inert before success and survives a later pending decision', () => {
  const f = ledgerFixture(); assert.equal(f.evidence.length, 1); assert.equal(f.evidence[0].concernHash, reviewConcernHash(f.note)); assert.equal(f.evidence[0].sourceFileHash, hash('imported file'));
  f.transaction.reviewCompletions = f.evidence; f.note.decision = 'pending';
  assert.equal(deriveReviewCompletion(f.note, f.state).completed, true);
  f.transaction.state = 'failed'; assert.equal(deriveReviewCompletion(f.note, f.state).completed, false);
  f.raw.reviewNotes[0].decision = 'pending'; assert.deepEqual(captureAdoptedReviewEvidence(f.raw, { transaction: f.committing }), []);
});

test('capture rejects unrelated/partial/late decisions and does not mutate any source or review data', () => {
  for (const mutate of [f => f.note.decision = 'pending', f => f.note.decisionUpdatedAt = stamp(8), f => f.committing.projectId = 'foreign', f => f.raw.proposals[0].edits[0].beforeHash = hash('wrong'), f => { f.note.sourceSegmentIds.push('p2'); f.note.sourceHashes.p2 = hash('uncopied paragraph'); }]) {
    const f = ledgerFixture(); mutate(f); const before = structuredClone(f); assert.deepEqual(captureAdoptedReviewEvidence(f.raw, { transaction: f.committing }), []); assert.deepEqual(f, before);
  }
});

test('a recomputed durable ledger can link the exact prior concern after the original import is removed, without adopting the new record', () => {
  const f = ledgerFixture(); f.transaction.reviewCompletions = f.evidence;
  const incoming = { ...f.note, noteId: 'incoming', batchId: 'another-file', decision: 'pending', priorReviewCompletion: { sourceNoteId: f.note.noteId, sourceBatchId: f.note.batchId, transactionId: f.transaction.transactionId, concernHash: reviewConcernHash(f.note) } };
  const before = structuredClone(incoming), proof = deriveReviewCompletion(incoming, f.state);
  assert.equal(proof.completed, true); assert.equal(proof.inherited, true); assert.equal(proof.sourceNoteId, f.note.noteId); assert.deepEqual(incoming, before);
  for (const mutate of [note => note.body += ' A genuinely new condition.', note => note.priorReviewCompletion.transactionId = 'not-applied', note => note.priorReviewCompletion.concernHash = hash('invented'), note => note.priorReviewCompletion.sourceNoteId = 'foreign']) {
    const note = structuredClone(incoming); mutate(note); assert.equal(deriveReviewCompletion(note, f.state).completed, false);
  }
  incoming.reviewReopen = { transactionId: f.transaction.transactionId, at: stamp(8) }; assert.equal(deriveReviewCompletion(incoming, f.state).status, 'reopened');
});

test('a reference alone cannot grant completion and retained prior proof respects its explicit reopen', () => {
  const f = fixture(), incoming = { ...f.note, noteId: 'incoming', batchId: 'another-file', decision: 'pending', priorReviewCompletion: { sourceNoteId: f.note.noteId, sourceBatchId: f.note.batchId, transactionId: f.transaction.transactionId, concernHash: reviewConcernHash(f.note) } };
  assert.equal(deriveReviewCompletion(incoming, f.state).completed, false);
  f.state.reviewNotes = [f.note, incoming]; assert.equal(deriveReviewCompletion(incoming, f.state).completed, true);
  f.note.reviewReopen = { transactionId: f.transaction.transactionId, at: stamp(9) }; assert.equal(deriveReviewCompletion(incoming, f.state).completed, false);
  f.transaction.reviewCompletions = [{ ...f.note, schemaVersion: 1, projectId: 'paper', sourceNoteId: f.note.noteId, sourceBatchId: f.note.batchId, concernHash: reviewConcernHash(f.note), transactionId: f.transaction.transactionId }];
  assert.equal(deriveReviewCompletion(incoming, f.state).completed, false);
});

test('one explicit batch index handles 5000 independent decisions without a persistent mutable-state cache', () => {
  const f = fixture(), notes = Array.from({ length: 5000 }, (_, index) => ({ ...f.note, noteId: `note-${index}`, body: `Exact concern ${index}.` }));
  const context = createReviewCompletionContext(f.state, { notes });
  assert(notes.every(note => deriveReviewCompletion(note, f.state, { completionContext: context }).completed));
  f.state.readingParagraphs[0].source = 'Later source text.'; f.state.readingParagraphs[0].sourceHash = hash(f.state.readingParagraphs[0].source);
  assert.equal(deriveReviewCompletion(f.note, f.state).completed, false);
});
