const noteStatuses = new Set(['current', 'relocatable', 'changed', 'missing', 'ambiguous', 'unlocated', 'completed']);
export const completedReviewOpinion = entry => entry?.status === 'completed' || entry?.completed === true || entry?.skipInMatching === true || entry?.completion?.completed === true;
export const partialReviewOpinion = entry => !completedReviewOpinion(entry) && Number(entry?.completion?.partialCompletedCount || entry?.partialCompletedCount || 0) > 0;

/** Backend proofs are usable only with the exact current project, file and note revision. */
export function reviewImportStatus(state, batchId) {
  const batch = (state.reviewBatches || []).find(item => item.batchId === batchId), validation = state.reviewImportValidation;
  const supplied = validation && state.project?.id && state.project?.snapshotId && validation.projectId === state.project.id && validation.sourceSnapshotId === state.project.snapshotId ? validation.batches?.find(item => item.batchId === batchId && item.revision === (batch?.revision || 1) && item.fileHash === batch?.fileHash) : null;
  const proof = new Map((supplied?.notes || []).map(note => [note.noteId, note])), notes = new Map();
  for (const note of [...(state.reviewNotes || []), ...(state.reviewHistory || [])].filter(note => note.batchId === batchId)) {
    const entry = proof.get(note.noteId);
    if (entry?.revision === (note.revision || 1) && noteStatuses.has(entry.status)) notes.set(note.noteId, { ...entry, organizable: entry.organizable !== false && !completedReviewOpinion(entry), requiresRecheck: !completedReviewOpinion(entry) && entry.status !== 'current', associationRefreshNeeded: entry.associationRefreshNeeded === true || entry.status === 'current' && entry.requiresRecheck === true });
    else {
      const current = Boolean(!validation && state.project?.id && state.project?.snapshotId && note.sourceSnapshotId === state.project.snapshotId);
      notes.set(note.noteId, { noteId: note.noteId, revision: note.revision || 1, status: current ? 'current' : 'recheck', organizable: true, requiresRecheck: !current });
    }
  }
  const values = [...notes.values()];
  return { batch, validation: supplied || null, notes, total: notes.size, currentCount: values.filter(note => note.status === 'current' && !completedReviewOpinion(note)).length, recheckCount: values.filter(note => note.status !== 'current' && !completedReviewOpinion(note)).length, completedCount: values.filter(completedReviewOpinion).length, partialCompletedCount: values.filter(partialReviewOpinion).length, associationRefreshCount: values.filter(note => note.associationRefreshNeeded).length };
}
export function reviewValidationIndex(state) {
  const result = new Map(); for (const batch of state.reviewBatches || []) for (const [id, note] of reviewImportStatus(state, batch.batchId).notes) result.set(id, note); return result;
}
export function reviewSourceStatusLabel(status, language = 'en') {
  const chinese = language.startsWith('zh');
  const labels = { current: ['Current paragraph', '当前段落已核实'], relocatable: ['Same text · location changed', '原文相同 · 位置变化'], changed: ['Paragraph changed', '段落已修改'], missing: ['Paragraph missing', '段落已缺失'], ambiguous: ['Ambiguous location', '位置存在歧义'], unlocated: ['Unlocated', '尚未定位'], completed: ['Applied · skipped', '已写回 · 默认跳过'], recheck: ['Needs recheck', '需要重新核对'] };
  return (labels[status] || labels.recheck)[chinese ? 1 : 0];
}

export function reviewOperationProgress(state, kind, { requestId, batchId } = {}) {
  return (state.reviewOperations?.[kind] || []).findLast(operation => (!requestId || operation.requestId === requestId) && (!batchId || operation.batchId === batchId) && ['prepared', 'receiving', 'collecting', 'completed'].includes(operation.status) && ['totalNotes', 'completedNotes', 'batchIndex', 'batchCount'].every(key => Number.isSafeInteger(operation[key])) && operation.totalNotes > 0 && operation.completedNotes >= 0 && operation.completedNotes <= operation.totalNotes && operation.batchIndex >= 0 && operation.batchCount > 0 && operation.batchIndex < operation.batchCount && (operation.status !== 'receiving' || Number.isSafeInteger(operation.receivedResultRecords) && operation.receivedResultRecords >= 0));
}
export function reviewOperationLabel(operation, kind, language = 'en') {
  const chinese = language.startsWith('zh'), name = kind === 'organization' ? chinese ? '整理意见' : 'Organizing opinions' : chinese ? '匹配意见' : 'Matching opinions';
  const receiving = operation.status === 'receiving' ? chinese ? `本批次已收 ${operation.receivedResultRecords} 条 · ` : `receiving ${operation.receivedResultRecords} records · ` : '';
  return `${name} · ${receiving}${operation.completedNotes}/${operation.totalNotes} ${chinese ? '条完成' : 'complete'} · ${chinese ? '自动批次' : 'automatic batch'} ${operation.batchIndex + 1}/${operation.batchCount}`;
}
