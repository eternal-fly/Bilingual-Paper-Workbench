// Pure, browser-safe review projection. It never mutates notes, batches, source,
// drafts, decisions or import activation. Generation identity is batch identity.
const successful = new Set(['completed', 'complete', 'success', 'succeeded']);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const sources = note => [...new Set((Array.isArray(note.sourceSegmentIds) ? note.sourceSegmentIds : []).filter(identifier))];
const globalNote = note => note.global === true || note.scope === 'global' || note.anchorStatus === 'global';
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
function exactSources(batch) {
  const value = batch.reviewedSourceSegmentIds ?? batch.sourceSegmentIds ?? batch.coverage?.sourceSegmentIds;
  return Array.isArray(value) && value.length > 0 && value.every(identifier) && new Set(value).size === value.length ? [...value] : [];
}
function authoritativeSources(batch) {
  return batch.conversation !== true && Array.isArray(batch.reviewedSourceSegmentIds) ? exactSources({ reviewedSourceSegmentIds: batch.reviewedSourceSegmentIds }) : [];
}
function family(batch) {
  if (batch.conversation === true) return `conversation:${batch.batchId}`;
  const explicit = batch.reviewFamilyId ?? batch.familyId ?? batch.reviewFamily;
  if (identifier(explicit)) return `explicit:${explicit}`;
  if (batch.origin === 'external') {
    if (identifier(batch.fileHash)) return `external-file:${batch.fileHash.toLowerCase()}`;
    if (identifier(batch.filename)) return `external-name:${batch.filename}`;
    return `batch:${batch.batchId}`;
  }
  if (['codex', 'model', 'ai'].includes(batch.origin) && identifier(batch.scope)) {
    const scope = batch.scope, ids = ['paragraph', 'selected', 'selection'].includes(scope) ? exactSources(batch).sort() : [];
    // Explicit selected scope without its exact source set is not a shared
    // family. Candidates and paragraph-number guesses never establish scope.
    if (['paragraph', 'selected', 'selection'].includes(scope) && !ids.length) return `batch:${batch.batchId}`;
    return `native:${scope}:${batch.reviewTarget || ''}:${JSON.stringify(ids)}`;
  }
  return `batch:${batch.batchId}`;
}
function compare(a, b) {
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  if (a.order !== b.order) return a.order - b.order;
  return a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0;
}
function replaceHead(heads, key, generation) {
  const current = heads.get(key); if (!current || compare(current, generation) < 0) heads.set(key, generation);
}
/**
 * Current opinions are the latest available generation for each exact anchor.
 * A shared note can be historical for p1 while remaining current for p2: such
 * a note is never globally clearable. Missing generation metadata is retained
 * conservatively. Explicit archived notes are never promoted back to current.
 */
export function projectReviewHistory(state = {}, { sourceIds = null, filter = 'selected' } = {}) {
  if (sourceIds !== null && (!Array.isArray(sourceIds) || sourceIds.some(value => !identifier(value)))) throw new TypeError('Review projection source IDs must be exact strings or null.');
  if (!['selected', 'all', 'unlocated', 'global'].includes(filter)) throw new TypeError('Unknown review history filter.');
  const metadata = new Map(), generations = new Map(), entries = new Map(), retired = new Set();
  // Canonical storage alone cannot enumerate derived paragraph IDs. Only an
  // explicit complete reading graph may prove that an older anchor vanished.
  const currentGraph = Array.isArray(state.readingParagraphs) && identifier(state.project?.snapshotId) ? new Set([...state.readingParagraphs, ...(Array.isArray(state.segments) ? state.segments : [])].map(source => source?.id).filter(identifier)) : null;
  for (const [order, batch] of (Array.isArray(state.reviewBatches) ? state.reviewBatches : []).entries()) {
    if (!batch || !identifier(batch.batchId)) continue;
    const previous = metadata.get(batch.batchId);
    metadata.set(batch.batchId, { batch, order: previous?.order ?? order });
  }
  for (const [id, { batch }] of metadata) if (batch.origin === 'external' && (batch.active === false || batch.status === 'retired')) retired.add(id);
  for (const [id, { batch, order }] of metadata) {
    if (retired.has(id)) continue;
    const time = successful.has(batch.status) ? date(batch.completedAt) ?? date(batch.createdAt) : date(batch.createdAt);
    generations.set(id, { batchId: id, batch, order, time: time ?? Number.NEGATIVE_INFINITY, notes: [], opaque: false, family: family(batch) });
  }
  let sequence = 0;
  const add = (note, archived) => {
    if (!note || !identifier(note.noteId) || retired.has(note.batchId)) return;
    const previous = entries.get(note.noteId);
    // An archived duplicate cannot revoke a still-active canonical opinion.
    if (previous && !previous.archived && archived) return;
    const generation = generations.get(note.batchId) || { batchId: identifier(note.batchId) ? note.batchId : null, batch: null, order: -1, time: Number.NEGATIVE_INFINITY, opaque: true, notes: [], family: null };
    const sourceIds = sources(note), orphan = Boolean(currentGraph && identifier(note.sourceSnapshotId) && note.sourceSnapshotId !== state.project.snapshotId && sourceIds.length && sourceIds.every(id => !currentGraph.has(id)));
    entries.set(note.noteId, { note, archived, orphan, generation, order: previous?.order ?? sequence++, sourceIds, global: globalNote(note) });
  };
  for (const note of Array.isArray(state.reviewNotes) ? state.reviewNotes : []) add(note, false);
  for (const note of Array.isArray(state.reviewHistory) ? state.reviewHistory : []) add(note, true);
  for (const entry of entries.values()) if (!entry.generation.opaque) entry.generation.notes.push(entry);
  const latest = new Map(), unlocated = new Map(); let latestGlobal = null;
  for (const generation of generations.values()) {
    for (const entry of generation.notes) {
      if (entry.orphan) continue;
      if (entry.global) { if (!latestGlobal || compare(latestGlobal, generation) < 0) latestGlobal = generation; }
      else if (entry.sourceIds.length) for (const id of entry.sourceIds) replaceHead(latest, id, generation);
      else replaceHead(unlocated, generation.family, generation);
    }
    // The dedicated field is persisted only after a complete review returns.
    // It is authoritative even if the model found nothing on a reviewed p2.
    // Legacy broad sourceSegmentIds remains conservative for nonempty results.
    if (successful.has(generation.batch.status)) for (const id of authoritativeSources(generation.batch)) replaceHead(latest, id, generation);
    // Only an explicit successful zero-finding result can advance an empty
    // source head. An ongoing/failed empty review cannot hide saved opinions.
    if (generation.batch.conversation !== true && successful.has(generation.batch.status) && generation.batch.noteCount === 0 && !generation.notes.length) {
      for (const id of exactSources(generation.batch)) replaceHead(latest, id, generation);
      if (generation.batch.scope === 'global' || generation.batch.global === true) if (!latestGlobal || compare(latestGlobal, generation) < 0) latestGlobal = generation;
    }
  }
  const isCurrent = (entry, matchedSources = entry.sourceIds) => {
    if (entry.archived || entry.orphan) return false;
    if (entry.generation.opaque) return true;
    if (entry.global) return latestGlobal === entry.generation;
    if (entry.sourceIds.length) return matchedSources.some(id => latest.get(id) === entry.generation);
    return unlocated.get(entry.generation.family) === entry.generation;
  };
  const globallyCurrent = new Set([...entries.values()].filter(entry => isCurrent(entry)).map(entry => entry.note.noteId));
  const selected = filter === 'all' || sourceIds === null ? null : new Set(sourceIds);
  const current = [], history = [];
  for (const entry of entries.values()) {
    const located = entry.sourceIds.length > 0;
    if (filter === 'unlocated' && (entry.global || located) || filter === 'global' && !entry.global) continue;
    if (filter === 'selected' && selected && !entry.global && !located) continue;
    const matched = selected ? entry.sourceIds.filter(id => selected.has(id)) : entry.sourceIds;
    if (filter !== 'unlocated' && filter !== 'global' && selected && !entry.global && !matched.length) continue;
    (isCurrent(entry, matched) ? current : history).push(entry);
  }
  const recentFirst = (a, b) => compare(b.generation, a.generation) || a.order - b.order;
  current.sort(recentFirst); history.sort(recentFirst);
  const globallyHistoricalIds = [...entries.values()].filter(entry => !globallyCurrent.has(entry.note.noteId)).map(entry => entry.note.noteId).sort();
  return {
    current: current.map(entry => entry.note), history: history.map(entry => entry.note),
    currentIds: current.map(entry => entry.note.noteId), historyIds: history.map(entry => entry.note.noteId), globallyHistoricalIds,
    latestBySource: Object.fromEntries([...latest].sort(([a], [b]) => a.localeCompare(b)).map(([id, generation]) => [id, generation.batchId])),
    latestGlobalBatchId: latestGlobal?.batchId || null,
    latestByUnlocatedFamily: Object.fromEntries([...unlocated].sort(([a], [b]) => a.localeCompare(b)).map(([id, generation]) => [id, generation.batchId])),
    generations: [...generations.values()].filter(generation => generation.notes.length || generation.batch.conversation !== true && successful.has(generation.batch.status) && (authoritativeSources(generation.batch).length || generation.batch.noteCount === 0 && exactSources(generation.batch).length)).sort((a, b) => compare(b, a)).map(generation => ({ batchId: generation.batchId, order: generation.order, timestamp: Number.isFinite(generation.time) ? generation.time : null, status: generation.batch.status || null, family: generation.family, noteIds: generation.notes.map(entry => entry.note.noteId), reviewedSourceIds: successful.has(generation.batch.status) ? authoritativeSources(generation.batch) : [], emptySourceIds: generation.batch.conversation !== true && generation.batch.noteCount === 0 && !generation.notes.length && successful.has(generation.batch.status) ? exactSources(generation.batch) : [] })),
  };
}
