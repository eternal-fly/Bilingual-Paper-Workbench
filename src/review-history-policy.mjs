import { projectReviewHistory } from './review-history.mjs';

const modelOrigins = new Set(['codex', 'ai', 'model']);
export function reviewHistoryPreferences(state) {
  const value = state.reviewHistoryPreferences;
  if (!value || typeof value.retain !== 'boolean' || !Number.isSafeInteger(value.revision) || value.revision < 0) return { retain: true, revision: 0 };
  return { retain: value.retain, revision: value.revision };
}
/** Apply only a newly committed generation's global supersession. Existing
 * history is untouched by the future-retention preference. */
export function applyReviewHistoryRetention(state, { beforeState, batchId, at = new Date().toISOString() } = {}) {
  if (state.reviewHistory !== undefined && !Array.isArray(state.reviewHistory)) throw Object.assign(new Error('Saved review history is not an annotation array; preserve it for recovery.'), { code: 'RECOVERY_REQUIRED' });
  const prior = new Set(projectReviewHistory(beforeState).globallyHistoricalIds), after = projectReviewHistory(state);
  const superseded = new Set(after.globallyHistoricalIds.filter(id => !prior.has(id)));
  const moved = [], kept = [], retain = reviewHistoryPreferences(state).retain; let removed = 0;
  for (const note of state.reviewNotes || []) {
    if (!modelOrigins.has(note.origin) || !superseded.has(note.noteId)) { kept.push(note); continue; }
    removed++;
    if (retain) moved.push({ ...structuredClone(note), archivedAt: at, archivedReason: 'superseded-review', supersededByBatchId: batchId });
  }
  if (superseded.size) {
    state.reviewNotes = kept;
    if (retain && moved.length) {
      const existing = new Set((state.reviewHistory || []).map(note => note.noteId));
      state.reviewHistory = [...(state.reviewHistory || []), ...moved.filter(note => !existing.has(note.noteId))];
    }
  }
  return { archived: moved.length, dropped: retain ? 0 : removed };
}
