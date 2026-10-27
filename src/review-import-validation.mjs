import { createHash } from 'node:crypto';
import { deriveReviewCompletion, createReviewCompletionContext } from './review-completion.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value);
const sourceHash = value => value?.sourceHash || value?.beforeHash;

/** Only current literal source identity is evidence. Quotes, translations and
 * imported recommended prose never authorize automatic anchor migration. */
export function createReviewSourceIndex(state) {
  const paragraphs = state.readingParagraphs || [], covered = new Set(paragraphs.flatMap(p => (p.canonicalSegmentIds || []).filter(id => id !== p.id)));
  const byId = new Map();
  for (const source of [...paragraphs, ...(state.segments || []).filter(p => !covered.has(p.id))]) if (!byId.has(source.id) && digest(sourceHash(source))) byId.set(source.id, source);
  const byHash = new Map();
  for (const source of byId.values()) { const key = sourceHash(source).toLowerCase(); if (!byHash.has(key)) byHash.set(key, []); byHash.get(key).push(source.id); }
  return { byId, byHash };
}

export function validateExternalReviewNote(note, state, index = createReviewSourceIndex(state)) {
  const ids = Array.isArray(note.sourceSegmentIds) ? note.sourceSegmentIds : [], hashes = note.sourceHashes || {};
  const base = { noteId: note.noteId, revision: note.revision, sourceSegmentIds: [...ids], sourceHashes: { ...hashes }, verifiedSourceSegmentIds: [], verifiedSourceHashes: {}, organizable: true, requiresRecheck: true };
  if (note.projectId && note.projectId !== state.project?.id || note.sourceValidation?.projectId && note.sourceValidation.projectId !== state.project?.id) return { ...base, status: 'missing', reason: 'project-mismatch', organizable: false };
  if (!ids.length) return { ...base, status: 'unlocated', reason: 'no-source-association' };
  if (new Set(ids).size !== ids.length) return { ...base, status: 'ambiguous', reason: 'invalid-source-association' };
  const anchors = ids.map(id => {
    const source = index.byId.get(id), expected = hashes[id];
    if (source) return digest(expected) && sourceHash(source).toLowerCase() === expected.toLowerCase() ? { id, status: 'current', targetId: id } : { id, status: 'changed' };
    const candidates = digest(expected) ? index.byHash.get(expected.toLowerCase()) || [] : [];
    return candidates.length === 1 ? { id, status: 'relocatable', targetId: candidates[0] } : { id, status: candidates.length ? 'ambiguous' : 'missing', candidates };
  });
  const targets = anchors.map(a => a.targetId).filter(Boolean), collision = new Set(targets).size !== targets.length;
  const status = anchors.some(a => a.status === 'changed') ? 'changed' : collision || anchors.some(a => a.status === 'ambiguous') ? 'ambiguous' : anchors.some(a => a.status === 'missing') ? 'missing' : anchors.some(a => a.status === 'relocatable') ? 'relocatable' : 'current';
  const proven = ['current', 'relocatable'].includes(status);
  return { ...base, status, anchors, reason: status === 'changed' ? 'linked-source-changed' : status === 'ambiguous' ? 'source-association-ambiguous' : status === 'missing' ? 'linked-source-missing' : status === 'relocatable' ? 'unique-exact-source-relocation' : 'exact-current-source',
    requiresRecheck: status !== 'current', associationRefreshNeeded: proven && (status === 'relocatable' || note.sourceSnapshotId !== state.project?.snapshotId),
    ...(proven ? { verifiedSourceSegmentIds: targets, verifiedSourceHashes: Object.fromEntries(targets.map(id => [id, sourceHash(index.byId.get(id))])) } : {}),
    ...(anchors.some(a => a.candidates?.length) ? { candidates: [...new Set(anchors.flatMap(a => a.candidates || []))] } : {}) };
}

export function deriveReviewImportValidation(raw, state, options = {}) {
  const index = createReviewSourceIndex(state), allNotes = [...(raw.reviewNotes || []), ...(raw.reviewHistory || [])], byBatch = new Map(), completionContext = createReviewCompletionContext(state, { ...options, notes: allNotes });
  for (const note of allNotes) { if (!byBatch.has(note.batchId)) byBatch.set(note.batchId, []); byBatch.get(note.batchId).push(note); }
  const batches = (raw.reviewBatches || []).filter(batch => batch.origin === 'external').map(batch => {
    const originals = byBatch.get(batch.batchId) || [], notes = originals.map(note => {
      const checked = validateExternalReviewNote(note, state, index), completion = deriveReviewCompletion(note, state, { ...options, notes: allNotes, completionContext });
      return { ...checked, associationStatus: checked.status, completed: completion.completed, skipInMatching: completion.skipInMatching, completion, completionHash: hash(completion), ...(completion.completed ? { status: 'completed', requiresRecheck: false, organizable: false } : {}) };
    });
    const counts = Object.fromEntries(['current', 'relocatable', 'changed', 'missing', 'ambiguous', 'unlocated', 'completed'].map(status => [status + 'Count', notes.filter(note => note.status === status).length]));
    return { batchId: batch.batchId, revision: batch.revision ?? 1, fileHash: batch.fileHash, importSnapshotId: batch.sourceSnapshotId, sourceSnapshotId: state.project?.snapshotId || null, total: notes.length, ...counts, validationHash: hash([raw.project?.id, raw.project?.snapshotId, batch, originals, notes]), notes };
  });
  return { projectId: state.project?.id || null, sourceSnapshotId: state.project?.snapshotId || null, batches };
}

export function recordExternalReviewAssociation(note, project, sourceSegmentIds, sourceHashes, method, at = new Date().toISOString()) {
  if (note.origin !== 'external') return;
  note.originalSourceSnapshotId ??= note.sourceSnapshotId;
  note.sourceValidationHistory = [...(note.sourceValidationHistory || []), { sourceSnapshotId: note.sourceSnapshotId, sourceSegmentIds: [...(note.sourceSegmentIds || [])], sourceHashes: { ...(note.sourceHashes || {}) }, checkedAgainstSnapshotId: project.snapshotId, status: 'current', method, at }].slice(-8);
  note.sourceValidation = { schemaVersion: 1, projectId: project.id, sourceSnapshotId: project.snapshotId, status: 'current', method, sourceSegmentIds: [...sourceSegmentIds], sourceHashes: { ...sourceHashes }, checkedAt: at };
}

/** Explicit UI maintenance, never model approval or source mutation. */
export async function revalidateReviewImport(app, input) {
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const allowed = ['batchId', 'expectedRevision', 'expectedFileHash', 'expectedProjectId', 'expectedSnapshotId', 'expectedValidationHash', 'noteIds'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key)) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || !digest(input.expectedFileHash) || !digest(input.expectedValidationHash) || typeof input.expectedProjectId !== 'string' || typeof input.expectedSnapshotId !== 'string' || typeof input.batchId !== 'string' || input.noteIds !== undefined && (!Array.isArray(input.noteIds) || !input.noteIds.length || new Set(input.noteIds).size !== input.noteIds.length)) fail('INVALID_INPUT', 'Choose the exact current paper, imported file and validation summary.');
  return app._projectOperation(() => app.core._serial(async () => {
    await app.core._assertSourceCurrent(); const raw = app.core.getState(), state = app.getState(), batches = (raw.reviewBatches || []).filter(batch => batch.batchId === input.batchId), batch = batches[0];
    const originalNotes = [...(raw.reviewNotes || []), ...(raw.reviewHistory || [])].filter(note => note.batchId === input.batchId);
    if (batches.length !== 1 || batch.origin !== 'external' || batch.status !== 'completed' || batch.active === false || !digest(batch.fileHash) || batch.projectId && batch.projectId !== raw.project?.id || !originalNotes.length || originalNotes.some(note => note.origin !== 'external') || new Set(originalNotes.map(note => note.noteId)).size !== originalNotes.length) fail('REVIEW_IMPORT_UNAVAILABLE', 'Choose one active external review file from this paper with intact opinion identities.');
    const validation = state.reviewImportValidation?.batches.find(item => item.batchId === input.batchId) || deriveReviewImportValidation(raw, state).batches.find(item => item.batchId === input.batchId);
    if (raw.project?.id !== input.expectedProjectId || raw.project?.snapshotId !== input.expectedSnapshotId || validation.revision !== input.expectedRevision || batch.fileHash.toLowerCase() !== input.expectedFileHash.toLowerCase() || validation.validationHash !== input.expectedValidationHash) fail('VERSION_CONFLICT', 'The paper, import or opinion selection changed. Refresh the validation summary.');
    const ids = new Set(input.noteIds || validation.notes.map(note => note.noteId)), byId = new Map(validation.notes.map(note => [note.noteId, note]));
    if ([...ids].some(id => !byId.has(id))) fail('INVALID_INPUT', 'A selected opinion is outside this exact review import.');
    if (input.noteIds?.some(id => byId.get(id).completed)) fail('REVIEW_ALREADY_APPLIED', 'The selected opinion was adopted and written back. Reopen it explicitly before rechecking.');
    let skippedCompletedCount = 0; for (const id of ids) if (byId.get(id).completed) { ids.delete(id); skippedCompletedCount++; }
    const at = new Date().toISOString(); let updatedCount = 0, unchangedCount = 0, unverifiedCount = 0, mutations = 0;
    for (const collection of [raw.reviewNotes || [], raw.reviewHistory || []]) for (const note of collection) {
      if (note.batchId !== input.batchId || !ids.has(note.noteId)) continue;
      const checked = byId.get(note.noteId), proven = ['current', 'relocatable'].includes(checked.status);
      const association = proven && (note.sourceSnapshotId !== raw.project.snapshotId || JSON.stringify(note.sourceSegmentIds || []) !== JSON.stringify(checked.verifiedSourceSegmentIds) || JSON.stringify(note.sourceHashes || {}) !== JSON.stringify(checked.verifiedSourceHashes));
      if (proven) { if (association) updatedCount++; else unchangedCount++; } else unverifiedCount++;
      const nextValidation = { schemaVersion: 1, projectId: raw.project.id, sourceSnapshotId: raw.project.snapshotId, status: proven ? 'current' : checked.status, method: checked.status === 'relocatable' ? 'unique-exact-hash' : checked.status === 'current' ? 'exact-id-hashes' : 'needs-review', sourceSegmentIds: proven ? checked.verifiedSourceSegmentIds : note.sourceSegmentIds || [], sourceHashes: proven ? checked.verifiedSourceHashes : note.sourceHashes || {} };
      const previous = note.sourceValidation && Object.fromEntries(Object.entries(note.sourceValidation).filter(([key]) => key !== 'checkedAt'));
      if (!association && JSON.stringify(previous) === JSON.stringify(nextValidation)) continue;
      if (!Number.isSafeInteger(note.revision) || note.revision < 1 || note.revision >= Number.MAX_SAFE_INTEGER) fail('RECOVERY_REQUIRED', 'An imported opinion revision cannot be advanced.');
      note.originalSourceSnapshotId ??= note.sourceSnapshotId;
      note.sourceValidationHistory = [...(note.sourceValidationHistory || []), { sourceSnapshotId: note.sourceSnapshotId, sourceSegmentIds: [...(note.sourceSegmentIds || [])], sourceHashes: { ...(note.sourceHashes || {}) }, checkedAgainstSnapshotId: raw.project.snapshotId, status: checked.status, method: nextValidation.method, at }].slice(-8);
      if (proven) { note.sourceSegmentIds = [...checked.verifiedSourceSegmentIds]; note.sourceHashes = { ...checked.verifiedSourceHashes }; note.sourceSnapshotId = raw.project.snapshotId; }
      note.sourceValidation = { ...nextValidation, checkedAt: at }; note.revision++; mutations++;
    }
    if (mutations) { if (!Number.isSafeInteger(batch.revision ?? 1) || (batch.revision ?? 1) >= Number.MAX_SAFE_INTEGER) fail('RECOVERY_REQUIRED', 'The imported file revision cannot be advanced.'); batch.revision = (batch.revision ?? 1) + 1; batch.lastValidation = { sourceSnapshotId: raw.project.snapshotId, checkedAt: at, checkedCount: ids.size, updatedCount, unchangedCount, unverifiedCount }; await app.core._commit(raw); app.emit('change'); }
    const current = app.getState().reviewImportValidation.batches.find(item => item.batchId === input.batchId);
    return { batchId: input.batchId, revision: current.revision, updatedCount, unchangedCount, unverifiedCount, skippedCompletedCount, validation: current, sourceChanged: false, draftsChanged: false, decisionsChanged: false };
  }));
}

export async function reopenReviewImportNote(app, input) {
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['noteId', 'expectedRevision', 'expectedProjectId', 'expectedSnapshotId', 'expectedCompletionHash'].includes(key)) || typeof input.noteId !== 'string' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || !digest(input.expectedCompletionHash)) fail('INVALID_INPUT', 'Select one exactly completed imported opinion to reopen.');
  return app._projectOperation(() => app.core._serial(async () => {
    await app.core._assertSourceCurrent(); const raw = app.core.getState(), state = app.getState(), note = raw.reviewNotes?.find(note => note.noteId === input.noteId), batch = raw.reviewBatches?.find(batch => batch.batchId === note?.batchId);
    const checked = state.reviewImportValidation?.batches.find(batch => batch.batchId === note?.batchId)?.notes.find(row => row.noteId === input.noteId);
    if (!note || note.origin !== 'external' || batch?.origin !== 'external' || batch.status !== 'completed' || batch.active === false) fail('REVIEW_IMPORT_UNAVAILABLE', 'Choose an active imported opinion from this paper.');
    if (raw.project?.id !== input.expectedProjectId || raw.project?.snapshotId !== input.expectedSnapshotId || note.revision !== input.expectedRevision || checked?.completionHash !== input.expectedCompletionHash || !checked.completed && !checked.completion?.partialCompletedCount) fail('VERSION_CONFLICT', 'The paper, opinion or applied completion changed. Refresh before reopening.');
    if (note.revision >= Number.MAX_SAFE_INTEGER) fail('RECOVERY_REQUIRED', 'The opinion revision cannot be advanced.');
    const reopenedTransactions = [...new Set([...(note.reviewReopen?.transactionIds || []), note.reviewReopen?.transactionId, ...checked.completion.transactionIds].filter(id => typeof id === 'string' && id))];
    note.reviewReopen = { schemaVersion: 1, projectId: raw.project.id, sourceSnapshotId: raw.project.snapshotId, transactionId: checked.completion.transactionIds.at(-1), transactionIds: reopenedTransactions, at: new Date().toISOString(), completionHash: checked.completionHash };
    note.revision++; await app.core._commit(raw); app.emit('change');
    return { noteId: note.noteId, revision: note.revision, reopened: true, sourceChanged: false, draftsChanged: false, decisionsChanged: false };
  }));
}
