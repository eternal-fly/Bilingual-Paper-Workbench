const normalized = value => typeof value === 'string' ? value.replaceAll('\r\n', '\n') : '';
const sameIds = (left, right) => Array.isArray(left) && left.length === right.length && new Set(left).size === left.length && left.every(id => right.includes(id));
const sourceHash = source => source?.sourceHash || source?.beforeHash;

function requestMatches(request, state, language, sources, current = true) {
  if (!request || request.kind !== 'revision' || request.projectId !== state.project?.id || request.language !== language || current && (request.status !== 'completed' || request.snapshotId !== state.project?.snapshotId || request.requiresTranslationMerge)) return false;
  const drafts = state.translations?.[language] || {};
  for (const [id, revision] of Object.entries({ ...(request.draftRevisions || {}), ...(request.translationUnitRevisions || {}) })) if ((drafts[id]?.revision || 0) !== revision) return false;
  for (const selected of request.segments || []) {
    const id = selected.segmentId || selected.id, source = sources.get(id);
    if (current && (!source || selected.sourceHash !== sourceHash(source))) return false;
    if (selected.translationDraft) {
      const ids = selected.translationDraft.translationUnitIds || [id], text = ids.map(unit => drafts[unit]).filter(Boolean).map(draft => draft.text).join('\n\n');
      if (normalized(text) !== normalized(selected.translationDraft.text)) return false;
    }
  }
  return true;
}
function appliedDraft(state, language, id, sources) {
  const source = sources.get(id); if (!source || state.translations?.[language]?.[id]?.sourceReviewRequired) return false;
  return (state.proposals || []).some(proposal => {
    if (proposal.applicationState !== 'applied') return false;
    const transaction = proposal.transactionId ? (state.transactions || []).find(item => item.transactionId === proposal.transactionId) : (state.transactions || []).find(item => item.state === 'applied' && !item.revertedBy && item.proposalIds?.includes(proposal.proposalId));
    if (transaction?.state !== 'applied' || transaction.revertedBy) return false;
    const request = (state.requests || []).find(item => item.requestId === proposal.context?.requestId), edit = proposal.edits?.find(item => item.segmentId === id);
    const selected = request?.segments?.find(item => (item.segmentId || item.id) === id), drafts = state.translations?.[language] || {}, units = selected?.translationDraft?.translationUnitIds || [id];
    const draft = drafts[id], receipt = draft?.sourceWritebackReceipt, noPendingIntent = draft?.status !== 'stale' && !draft?.formulaEdits?.length && !draft?.referenceEdits?.length && !draft?.formulaEditsConflict && !draft?.formulaEditUnmapped && !draft?.referenceEditsConflict && !draft?.referenceEditUnmapped && !draft?.inlineStructureIntent && !draft?.inlineStructureConflict && !draft?.inlineStructureUnmapped && !draft?.sourceReviewRequired;
    const currentReceipt = receipt?.schemaVersion === 1 && receipt.projectId === state.project?.id && receipt.language === language && receipt.segmentId === id && receipt.transactionId === transaction.transactionId && transaction.projectId === state.project?.id && receipt.revision === draft?.revision && receipt.sourceHash === sourceHash(source) && draft?.sourceHash === receipt.sourceHash && noPendingIntent && units.length === 1 && units[0] === id;
    const capturedRevision = request?.draftRevisions?.[id] === (drafts[id]?.revision || 0) && units.every(unit => request.translationUnitRevisions?.[unit] === undefined || request.translationUnitRevisions[unit] === (drafts[unit]?.revision || 0));
    const covered = request?.kind === 'revision' && request.projectId === state.project?.id && request.language === language && (capturedRevision || currentReceipt) && selected?.translationDraft && normalized(units.map(unit => drafts[unit]).filter(Boolean).map(draft => draft.text).join('\n\n')) === normalized(selected.translationDraft.text);
    return edit && covered && normalized(edit.replacement).trim() === normalized(source.source).trim();
  });
}

/** A UI plan selects a complete current human scope; only the backend grants write authority. */
export function deriveEnglishWriteback(state, language, buffers = []) {
  const sources = new Map(); for (const source of [...(state.readingParagraphs || []), ...(state.segments || [])]) if (!sources.has(source.id)) sources.set(source.id, source);
  const drafts = state.translations?.[language] || {}, human = Object.entries(drafts).filter(([, draft]) => draft?.origin === 'human' || draft?.status === 'humanEdited');
  const rows = [], blockedIds = [];
  for (const [id, draft] of human) {
    if (appliedDraft(state, language, id, sources)) continue;
    const source = sources.get(id), alignment = (state.alignments || []).find(item => item.language === language && item.translationUnitIds?.includes(id));
    const aligned = !alignment || !alignment.stale && alignment.status !== 'stale' && alignment.sourceSegmentIds?.length === 1 && alignment.sourceSegmentIds[0] === id && alignment.translationUnitIds?.length === 1;
    if (!source || !aligned || draft.unitKind === 'split' || source.writableSource === false || source.translatable === false || draft.sourceHash && draft.sourceHash !== sourceHash(source)) blockedIds.push(id);
    rows.push({ id, revision: draft.revision || 0, text: draft.text || '', hash: sourceHash(source), draftSourceHash: draft.sourceHash || null });
  }
  const unsaved = buffers.filter(buffer => (!buffer.language || buffer.language === language) && buffer.state !== 'saved');
  const base = { mode: 'empty', language, count: rows.length, sourceIds: rows.map(row => row.id), proposalIds: [], missingIds: [], blockedIds, transaction: null };
  const finish = extra => { const result = { ...base, ...extra }; result.fingerprint = JSON.stringify([state.workspaceIndex?.currentRecordId || null, state.project?.id, state.project?.snapshotId, language, rows, result.mode, result.proposalIds.map(id => (state.proposals || []).find(proposal => proposal.proposalId === id)), result.missingIds, result.blockedIds, result.transaction?.transactionId, result.transaction?.candidateHash, result.transaction?.buildId]); return result; };
  if (!state.project) return finish({});
  if (unsaved.length) return finish({ mode: 'save', count: new Set([...base.sourceIds, ...unsaved.map(buffer => buffer.segmentId)]).size });
  if (!rows.length) return finish({});
  if (blockedIds.length) return finish({ mode: 'blocked' });
  const scope = new Set(base.sourceIds), requests = new Map((state.requests || []).map(request => [request.requestId, request]));
  const candidates = (state.proposals || []).map((proposal, index) => ({ proposal, index, request: requests.get(proposal.context?.requestId) })).filter(({ proposal, request }) => proposal.projectId === state.project.id && proposal.baseSnapshotId === state.project.snapshotId && proposal.reviewState === 'pending' && proposal.applicationState === 'notApplied' && proposal.edits?.length && requestMatches(request, state, language, sources) && proposal.edits.every(edit => scope.has(edit.segmentId) && edit.beforeHash === sourceHash(sources.get(edit.segmentId))));
  candidates.sort((a, b) => (b.request.generation || 0) - (a.request.generation || 0) || String(b.proposal.createdAt || '').localeCompare(String(a.proposal.createdAt || '')) || b.index - a.index);
  const covered = new Set(), chosen = [];
  for (const { proposal } of candidates) { const ids = proposal.edits.map(edit => edit.segmentId); if (ids.some(id => covered.has(id)) || new Set(ids).size !== ids.length) continue; chosen.push(proposal.proposalId); for (const id of ids) covered.add(id); }
  const missingIds = base.sourceIds.filter(id => !covered.has(id));
  if (missingIds.length) return finish({ mode: 'missing', proposalIds: chosen, missingIds });
  const transactions = (state.transactions || []).filter(transaction => transaction.baseSnapshotId === state.project.snapshotId && (!transaction.projectId || transaction.projectId === state.project.id) && sameIds(transaction.proposalIds, chosen));
  const transaction = transactions.filter(item => item.state === 'ready').findLast(item => {
    const build = (state.builds || []).find(build => build.buildId === item.buildId);
    return build && ['success', 'succeeded', 'completed'].includes(build.status) && !build.stale && build.isolation?.verified === true && build.snapshotId === state.project.snapshotId && !build.promotedSnapshotId && build.candidateHash === item.candidateHash && /^[a-f0-9]{64}$/i.test(build.pdfHash || '');
  });
  if (transaction) return finish({ mode: 'ready', proposalIds: chosen, transaction });
  const compiling = transactions.findLast(item => ['compiling', 'queued'].includes(item.state));
  return finish({ mode: compiling ? 'compiling' : 'compile', proposalIds: chosen, transaction: compiling || null, compileFailed: transactions.at(-1)?.state === 'failed' });
}
