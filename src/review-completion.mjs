import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value);
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const normalized = value => typeof value === 'string' ? value.replaceAll('\r\n', '\n').trim() : '';
const sourceHash = source => source?.sourceHash || source?.beforeHash;
const concernFields = ['reviewCode', 'title', 'body', 'recommendation', 'suggestedSource', 'suggestedTranslation', 'reasonSource', 'reasonTranslation'];

/** Exact original concern identity. Source context is checked separately by
 * import continuity; equal paragraph IDs alone never identify a concern. */
export function reviewConcernHash(note) { return sha(JSON.stringify(concernFields.map(key => [key, normalized(note?.[key])]))); }

function inventory(ids, hashes) {
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !id || !digest(hashes?.[id]))) return null;
  return { ids: [...ids], hashes: Object.fromEntries(ids.map(id => [id, hashes[id].toLowerCase()])) };
}
function decisionEvidence(note) {
  if (note.decision !== 'adopt' || !note.decisionSnapshotId || time(note.decisionUpdatedAt) === null) return null;
  if (note.decisionSourceSegmentIds !== undefined || note.decisionSourceHashes !== undefined) {
    const captured = inventory(note.decisionSourceSegmentIds, note.decisionSourceHashes);
    return captured && { ...captured, method: 'captured-decision-anchors' };
  }
  const candidates = [];
  if (note.sourceSnapshotId === note.decisionSnapshotId) candidates.push(inventory(note.sourceSegmentIds, note.sourceHashes));
  for (const record of note.sourceValidationHistory || []) if (record.sourceSnapshotId === note.decisionSnapshotId) candidates.push(inventory(record.sourceSegmentIds, record.sourceHashes));
  const valid = candidates.filter(Boolean), identities = new Map(valid.map(value => [JSON.stringify(value), value]));
  return identities.size === 1 ? { ...identities.values().next().value, method: 'legacy-exact-decision-epoch' } : null;
}
function transactionProposals(transaction, proposals, projectId, pending = false) {
  if (transaction?.projectId !== projectId || !Array.isArray(transaction.proposalIds) || !transaction.proposalIds.length || new Set(transaction.proposalIds).size !== transaction.proposalIds.length) return null;
  const selected = transaction.proposalIds.map(id => proposals instanceof Map ? proposals.get(id) : proposals.find(proposal => proposal.proposalId === id));
  if (selected.some(proposal => !proposal || proposal.projectId !== projectId || proposal.baseSnapshotId !== transaction.baseSnapshotId || proposal.context?.undoOf || !Array.isArray(proposal.edits) || !proposal.edits.length || (pending ? proposal.reviewState !== 'pending' || proposal.applicationState !== 'notApplied' : proposal.reviewState !== 'approved' || proposal.applicationState !== 'applied' || proposal.transactionId !== transaction.transactionId))) return null;
  return selected;
}
function applied(transaction, proposals, projectId) {
  const committed = time(transaction?.committedAt), finished = time(transaction?.appliedAt);
  return transaction?.state === 'applied' && !transaction.revertedBy && !transaction.sourceChangedAgain && typeof transaction.baseSnapshotId === 'string' && typeof transaction.afterSnapshotId === 'string' && Boolean(transaction.afterSnapshotId) && committed !== null && finished !== null && finished >= committed && transactionProposals(transaction, proposals, projectId);
}
function scope(options, state) {
  const context = options.completionContext;
  return context?.projectId === state.project?.id && context?.snapshotId === state.project?.snapshotId ? context : createReviewCompletionContext(state, options);
}
function sourceIndex(state) {
  const result = new Map();
  for (const source of [...(state.readingParagraphs || []), ...(state.segments || [])]) if (!result.has(source.id)) result.set(source.id, source);
  return result;
}
function reviewRequestIndex(requests = []) {
  return new Map(requests.map(request => [request.requestId, { projectId: request.projectId, snapshotId: request.snapshotId, ids: new Set((request.segments || []).filter(segment => segment.draftReview?.mode === 'adaptive-human-draft').map(segment => segment.id)) }]));
}
function sourceReviewPending(proposal, segmentId, requests) {
  const captured = proposal.context?.sourceReviewSegmentIds;
  if (captured !== undefined && (!Array.isArray(captured) || captured.includes(segmentId))) return true;
  const request = requests?.get(proposal.context?.requestId);
  return request?.projectId === proposal.projectId && request.snapshotId === proposal.baseSnapshotId && request.ids.has(segmentId);
}
/** One immutable-state projection may reuse this index for thousands of notes.
 * No index is retained across calls or silently reused after state mutation. */
export function createReviewCompletionContext(state, options = {}) {
  const transactions = options.transactions || state.transactions || [], proposals = options.proposals || state.proposals || [], notes = options.notes || [...(state.reviewNotes || []), ...(state.reviewHistory || [])];
  const proposalMap = new Map(proposals.map(proposal => [proposal.proposalId, proposal])), requestIndex = reviewRequestIndex(state.requests), records = [], byBefore = new Map(), ledgerByNote = new Map();
  for (const transaction of transactions) {
    const selected = applied(transaction, proposalMap, state.project?.id);
    if (!selected) continue;
    const record = { transaction, proposals: selected }; records.push(record);
    const keys = new Set(selected.flatMap(proposal => proposal.edits.filter(edit => !sourceReviewPending(proposal, edit.segmentId, requestIndex))).filter(edit => typeof edit.segmentId === 'string' && digest(edit.beforeHash)).map(edit => JSON.stringify([edit.segmentId, edit.beforeHash.toLowerCase()])));
    for (const key of keys) { if (!byBefore.has(key)) byBefore.set(key, []); byBefore.get(key).push(record); }
    for (const evidence of transaction.reviewCompletions || []) { const key = JSON.stringify([evidence.sourceNoteId, evidence.sourceBatchId]); if (!ledgerByNote.has(key)) ledgerByNote.set(key, []); ledgerByNote.get(key).push({ transaction, evidence }); }
  }
  for (const values of byBefore.values()) values.sort((a, b) => time(b.transaction.appliedAt) - time(a.transaction.appliedAt));
  for (const values of ledgerByNote.values()) values.sort((a, b) => time(b.transaction.appliedAt) - time(a.transaction.appliedAt));
  return { projectId: state.project?.id || null, snapshotId: state.project?.snapshotId || null, transactions, proposals, notes, proposalMap, requestIndex, records, byBefore, ledgerByNote, sources: sourceIndex(state), notesById: new Map(notes.map(note => [JSON.stringify([note.noteId, note.batchId]), note])) };
}
function hasAncestry(from, to, decisionAt, committedAt, transactions, proposals, projectId, indexedRecords = null) {
  if (from === to) return true;
  if (transactions.length > 10000) return false;
  const edges = new Map();
  for (const transaction of indexedRecords ? indexedRecords.map(record => record.transaction) : transactions) {
    const at = time(transaction.committedAt);
    if (at < decisionAt || at > committedAt || !indexedRecords && !applied(transaction, proposals, projectId)) continue;
    if (!edges.has(transaction.baseSnapshotId)) edges.set(transaction.baseSnapshotId, []);
    edges.get(transaction.baseSnapshotId).push(transaction.afterSnapshotId);
  }
  const visited = new Set([from]), queue = [from];
  for (let at = 0; at < queue.length; at++) for (const next of edges.get(queue[at]) || []) { if (next === to) return true; if (!visited.has(next)) { visited.add(next); queue.push(next); } }
  return false;
}
function currentEditProof(id, expectedBeforeHash, transaction, proposals, sources, requests) {
  const source = sources.get(id), currentHash = sourceHash(source);
  if (!digest(currentHash)) return null;
  const matches = proposals.flatMap(proposal => proposal.edits.filter(edit => edit.segmentId === id && !sourceReviewPending(proposal, id, requests)).map(edit => ({ proposal, edit }))).filter(({ edit }) => edit.beforeHash?.toLowerCase() === expectedBeforeHash && typeof edit.before === 'string' && sha(edit.before) === expectedBeforeHash && typeof edit.replacement === 'string' && (!source.path || edit.path === source.path));
  if (matches.length !== 1) return null;
  const { proposal, edit } = matches[0], afterHash = currentHash.toLowerCase();
  if (afterHash === expectedBeforeHash || ![sha(edit.replacement), sha(edit.replacement.trim())].includes(afterHash) || typeof source.source === 'string' && sha(source.source) !== afterHash) return null;
  return { sourceSegmentId: id, beforeHash: expectedBeforeHash, afterHash, transactionId: transaction.transactionId, proposalId: proposal.proposalId, beforeSnapshotId: transaction.baseSnapshotId, afterSnapshotId: transaction.afterSnapshotId, committedAt: transaction.committedAt, appliedAt: transaction.appliedAt };
}
function result(note, state, paragraphs, details = {}) {
  const transactionIds = [...new Set(paragraphs.map(proof => proof.transactionId))], reopenIds = new Set([note.reviewReopen?.transactionId, ...(note.reviewReopen?.transactionIds || [])].filter(Boolean));
  const complete = Boolean(details.complete), reopened = complete && transactionIds.some(id => reopenIds.has(id));
  const completed = complete && !reopened;
  const completedSourceSegmentIds = paragraphs.filter(proof => !reopenIds.has(proof.transactionId)).map(proof => proof.sourceSegmentId);
  return { schemaVersion: 1, noteId: note.noteId, projectId: state.project?.id || null, sourceSnapshotId: state.project?.snapshotId || null, sourceSegmentIds: paragraphs.map(proof => proof.sourceSegmentId), completedSourceSegmentIds, partialCompletedCount: completed ? 0 : completedSourceSegmentIds.length, completed, skipInMatching: completed, status: reopened ? 'reopened' : completed ? 'completed' : 'open', reason: reopened ? 'explicitly-reopened-for-review' : completed ? 'adopted-and-exact-source-write-verified' : details.reason || 'no-complete-adopted-source-write-proof', paragraphs, transactionIds, ...(details.decisionEvidence ? { decisionEvidence: details.decisionEvidence } : {}), ...(details.inherited ? { inherited: true, sourceNoteId: details.sourceNoteId, sourceBatchId: details.sourceBatchId } : {}) };
}
function proveEvidence(note, evidence, state, context, onlyTransactionId = null) {
  const adoptedAt = time(evidence.decisionUpdatedAt), original = inventory(evidence.sourceSegmentIds, evidence.sourceHashes);
  if (evidence.decision !== 'adopt' || adoptedAt === null || !evidence.decisionSnapshotId || !original || evidence.projectId !== state.project?.id) return null;
  const sources = context.sources, paragraphs = [];
  for (const id of original.ids) {
    let proof;
    for (const { transaction, proposals } of context.byBefore.get(JSON.stringify([id, original.hashes[id]])) || []) {
      if (onlyTransactionId && transaction.transactionId !== onlyTransactionId || time(transaction.committedAt) < adoptedAt) continue;
      if (!hasAncestry(evidence.decisionSnapshotId, transaction.baseSnapshotId, adoptedAt, time(transaction.committedAt), context.transactions, context.proposals, state.project.id, context.records)) continue;
      const found = currentEditProof(id, original.hashes[id], transaction, proposals, sources, context.requestIndex);
      if (found) { proof = found; break; }
    }
    if (proof) paragraphs.push(proof);
  }
  return result(note, state, paragraphs, { complete: paragraphs.length === original.ids.length, decisionEvidence: evidence.method || 'adopted-at-write-ledger' });
}

/** Called at the commit boundary, before source writing. Stored evidence is
 * inert until the containing transaction actually reaches verified applied. */
export function captureAdoptedReviewEvidence(raw, { transaction, transactions = [], proposals = raw.proposals || [] } = {}) {
  const projectId = raw.project?.id, committedAt = time(transaction?.committedAt), selected = transactionProposals(transaction, proposals, projectId, true);
  if (!projectId || transaction?.state !== 'committing' || transaction.baseSnapshotId !== raw.project.snapshotId || committedAt === null || !selected) return [];
  const batches = new Map((raw.reviewBatches || []).map(batch => [batch.batchId, batch]));
  const requestIndex = reviewRequestIndex(raw.requests);
  return (raw.reviewNotes || []).flatMap(note => {
    if (note.origin !== 'external' || note.projectId && note.projectId !== projectId || batches.get(note.batchId)?.active === false || batches.get(note.batchId)?.status === 'retired') return [];
    const captured = decisionEvidence(note), adoptedAt = time(note.decisionUpdatedAt);
    if (!captured || adoptedAt > committedAt || !hasAncestry(note.decisionSnapshotId, transaction.baseSnapshotId, adoptedAt, committedAt, transactions, proposals, projectId)) return [];
    const edits = selected.flatMap(proposal => proposal.edits.filter(edit => !sourceReviewPending(proposal, edit.segmentId, requestIndex)));
    if (captured.ids.some(id => edits.filter(edit => edit.segmentId === id && edit.beforeHash?.toLowerCase() === captured.hashes[id] && typeof edit.before === 'string' && sha(edit.before) === captured.hashes[id] && typeof edit.replacement === 'string' && sha(edit.replacement.trim()) !== captured.hashes[id]).length !== 1)) return [];
    return [{ schemaVersion: 1, projectId, sourceNoteId: note.noteId, sourceBatchId: note.batchId, sourceFileHash: batches.get(note.batchId)?.fileHash || null, concernHash: reviewConcernHash(note), decision: 'adopt', decisionSnapshotId: note.decisionSnapshotId, decisionUpdatedAt: note.decisionUpdatedAt, sourceSegmentIds: captured.ids, sourceHashes: captured.hashes, transactionId: transaction.transactionId }];
  });
}

/** Completion is per original concern, not a blanket paragraph exemption. */
export function deriveReviewCompletion(note, state, options = {}) {
  const context = scope(options, state);
  if (!note || note.origin !== 'external' || !state.project?.id || note.projectId && note.projectId !== state.project.id) return result(note || {}, state, [], { reason: 'outside-external-paper-scope' });
  const concernHash = reviewConcernHash(note), prior = note.priorReviewCompletion;
  const ledger = [...(context.ledgerByNote.get(JSON.stringify([note.noteId, note.batchId])) || []), ...(prior ? context.ledgerByNote.get(JSON.stringify([prior.sourceNoteId, prior.sourceBatchId])) || [] : [])];
  for (const { transaction, evidence } of ledger) {
    const own = evidence.sourceNoteId === note.noteId && evidence.sourceBatchId === note.batchId;
    const inherited = prior && evidence.sourceNoteId === prior.sourceNoteId && evidence.sourceBatchId === prior.sourceBatchId && transaction.transactionId === prior.transactionId && prior.concernHash === concernHash;
    if ((!own && !inherited) || evidence.concernHash !== concernHash || evidence.transactionId !== transaction.transactionId) continue;
    const sourceNote = inherited && context.notesById.get(JSON.stringify([evidence.sourceNoteId, evidence.sourceBatchId]));
    if (sourceNote && [sourceNote.reviewReopen?.transactionId, ...(sourceNote.reviewReopen?.transactionIds || [])].includes(transaction.transactionId)) continue;
    const proof = proveEvidence(note, evidence, state, context, transaction.transactionId);
    if (proof?.completed || proof?.status === 'reopened') return inherited ? { ...proof, inherited: true, sourceNoteId: evidence.sourceNoteId, sourceBatchId: evidence.sourceBatchId } : proof;
  }
  const captured = decisionEvidence(note);
  if (captured) {
    const proof = proveEvidence(note, { ...note, projectId: state.project.id, sourceSegmentIds: captured.ids, sourceHashes: captured.hashes, method: captured.method }, state, context);
    if (proof?.completed || proof?.status === 'reopened' || proof?.paragraphs.length) return proof;
  }
  if (prior && !options.skipPrior && prior.concernHash === concernHash) {
    const original = context.notesById.get(JSON.stringify([prior.sourceNoteId, prior.sourceBatchId]));
    if (original && original.noteId !== note.noteId && reviewConcernHash(original) === concernHash) {
      const proof = deriveReviewCompletion(original, state, { ...options, completionContext: context, notes: context.notes, skipPrior: true });
      if (proof.completed && proof.transactionIds.includes(prior.transactionId)) return result(note, state, proof.paragraphs, { complete: true, inherited: true, sourceNoteId: original.noteId, sourceBatchId: original.batchId });
    }
  }
  return result(note, state, [], { reason: note.decision === 'adopt' ? 'no-current-accepted-write-after-adoption' : 'no-adoption-at-source-write' });
}

export function deriveReviewCompletions(raw, state, options = {}) {
  const originals = [...(raw.reviewNotes || []), ...(raw.reviewHistory || [])], context = createReviewCompletionContext(state, { ...options, notes: options.notes || originals }), notes = originals.map(note => deriveReviewCompletion(note, state, { ...options, completionContext: context, notes: options.notes || originals }));
  const completed = notes.filter(note => note.completed);
  return { projectId: state.project?.id || null, sourceSnapshotId: state.project?.snapshotId || null, notes, completedCount: completed.length, completedParagraphCount: new Set(completed.flatMap(note => note.sourceSegmentIds)).size };
}
