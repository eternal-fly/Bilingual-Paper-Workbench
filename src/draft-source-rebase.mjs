import { sha256 } from './latex.mjs';
import { captureFormulaRequest } from './formula-edits.mjs';
import { parseEditableReference } from './reference-edits.mjs';
import { deriveTranslationProtectedTokens } from '../ui/translation-protection.mjs';

const fields = ['formulaEdits', 'formulaEditHistory', 'formulaEditsConflict', 'formulaEditUnmapped', 'referenceEdits', 'referenceEditHistory', 'referenceEditsConflict', 'referenceEditUnmapped'];
const copy = value => structuredClone(value), same = (a, b) => JSON.stringify(a) === JSON.stringify(b), sourceHash = row => row?.sourceHash || row?.beforeHash;
const fingerprint = draft => sha256(JSON.stringify({ ...draft, status: null }));
const index = state => new Map([...(state.segments || []), ...(state.readingParagraphs || [])].map(row => [row.id, row]));
const footprint = (text, source) => deriveTranslationProtectedTokens(text, source.protectedTokens || []).map(row => row.raw);
const receipt = (transaction, project, source, language, revision) => ({ schemaVersion: 1, projectId: project.id, language, segmentId: source.id, transactionId: transaction.transactionId, revision, sourceHash: sourceHash(source) });
function targetsCurrent(edits, registry) { return (edits || []).every(edit => { if (!edit.replacement) return true; const parsed = parseEditableReference(edit.replacement); return parsed && parsed.keys.every(key => !registry.dynamic[parsed.category].has(key) && registry.counts[parsed.category].get(key) === 1 && (parsed.category !== 'citations' || registry.citationFoldCounts.get(key.toLowerCase()) === 1)); }); }
function retag(draft, source, oldProject, project, registry, language) {
  try { captureFormulaRequest({ id: source.id, text: source.displayText, protectedTokens: source.protectedTokens }, source, draft, oldProject, language); } catch { return null; }
  if (!targetsCurrent(draft.referenceEdits, registry)) return null;
  const result = copy(draft), edits = rows => (rows || []).map(row => ({ ...row, snapshotId: project.snapshotId, sourceHash: sourceHash(source), ...(row.registryHash ? { registryHash: registry.hash } : {}) }));
  for (const kind of ['formula', 'reference']) {
    if (result[kind + 'Edits']) result[kind + 'Edits'] = edits(result[kind + 'Edits']);
    const history = kind + 'EditHistory'; if (result[history]) result[history] = result[history].filter(row => row.projectId === oldProject.id && row.snapshotId === oldProject.snapshotId && row.sourceHash === sourceHash(source) && targetsCurrent(kind === 'reference' ? [...(row.beforeIntent?.edits || []), ...(row.afterIntent?.edits || [])] : [], registry)).map(row => ({ ...row, snapshotId: project.snapshotId, beforeIntent: { ...row.beforeIntent, edits: edits(row.beforeIntent?.edits) }, afterIntent: { ...row.afterIntent, edits: edits(row.afterIntent?.edits) } }));
  }
  return result;
}
function acceptedDraft(before, source, draft, language, transaction) {
  for (const proposal of before.proposals || []) {
    if (!transaction.proposalIds.includes(proposal.proposalId) || proposal.context?.undoOf) continue;
    const request = before.requests?.find(row => row.requestId === proposal.context?.requestId);
    if (!request || request.kind !== 'revision' || request.projectId !== before.project.id || request.snapshotId !== transaction.baseSnapshotId || request.language !== language) continue;
    const selected = request.segments.find(row => (row.segmentId || row.id) === source.id), captured = selected?.translationDraft;
    if (!selected || captured?.text !== draft.text || (request.draftRevisions?.[source.id] || 0) !== draft.revision || captured.translationUnitIds?.some(id => id !== source.id)) continue;
    const edit = proposal.edits.find(row => row.segmentId === source.id && row.path === source.path && row.beforeHash === sourceHash(source) && row.startByte === source.startByte && row.endByte === source.endByte);
    if (edit) return edit;
  }
  return null;
}
/** Exact confirmed writes may advance their own author drafts. A source reload,
 * matching formula alone or a model result never grants this transition. */
export function rebaseConfirmedTranslationDrafts({ before, after, transaction, registry, undoTransaction = null, at = new Date().toISOString() }) {
  if (before.project?.id !== after.project?.id || transaction.projectId !== after.project?.id) return { changed: 0 };
  const sources = index(after), oldSources = index(before);
  if (transaction.draftRebases) {
    const ledger = transaction.draftRebases; if (ledger.projectId !== after.project.id || ledger.afterSnapshotId !== after.project.snapshotId) return { changed: 0 };
    let changed = 0;
    for (const row of ledger.rows) { const current = after[row.namespace]?.[row.language]?.[row.segmentId], source = sources.get(row.segmentId); if (!current || sourceHash(source) !== row.afterDraft.sourceHash || fingerprint(current) === row.afterHash) continue; if (fingerprint(current) === row.beforeHash) { after[row.namespace][row.language][row.segmentId] = copy(row.afterDraft); changed++; } }
    return { changed, replay: true };
  }
  if (before.project.snapshotId !== transaction.baseSnapshotId) return { changed: 0 };
  const rows = [], undoRows = new Map((undoTransaction?.draftRebases?.rows || []).map(row => [`${row.namespace}\0${row.language}\0${row.segmentId}`, row]));
  for (const namespace of ['translations', 'readingDrafts']) for (const [language, drafts] of Object.entries(before[namespace] || {})) for (const [segmentId, draft] of Object.entries(drafts)) {
    const source = sources.get(segmentId), oldSource = oldSources.get(segmentId), current = after[namespace]?.[language]?.[segmentId];
    if (!source || !oldSource || !current || fingerprint(current) !== fingerprint(draft) || !Number.isSafeInteger(draft.revision) || draft.revision < 1 || draft.revision >= Number.MAX_SAFE_INTEGER || typeof draft.text !== 'string' || draft.sourceSegmentIds && (!same(draft.sourceSegmentIds, [segmentId]) || draft.unitKind === 'split')) continue;
    let rebased = null, written = false;
    const inverse = undoRows.get(`${namespace}\0${language}\0${segmentId}`);
    if (inverse && fingerprint(draft) === inverse.afterHash && draft.revision === inverse.afterDraft.revision && sourceHash(source) === inverse.beforeDraft.sourceHash) rebased = retag(inverse.beforeDraft, source, { ...after.project, snapshotId: undoTransaction.baseSnapshotId }, after.project, registry, language);
    else if (draft.status !== 'stale' && draft.sourceHash === sourceHash(oldSource)) {
      const edit = acceptedDraft(before, oldSource, draft, language, transaction);
      if (edit && edit.replacement.trim() === source.source && same(footprint(draft.text, source), footprint(source.source, source))) { rebased = copy(draft); for (const key of fields) delete rebased[key]; written = true; }
      else if (sourceHash(oldSource) === sourceHash(source) && oldSource.source === source.source && same(oldSource.protectedTokens, source.protectedTokens) && fields.some(key => Object.hasOwn(draft, key))) rebased = retag(draft, source, before.project, after.project, registry, language);
    }
    if (!rebased) { if (draft.sourceHash !== sourceHash(source) || fields.some(key => Object.hasOwn(draft, key)) && before.project.snapshotId !== after.project.snapshotId) current.status = 'stale'; continue; }
    Object.assign(rebased, { revision: draft.revision + 1, sourceHash: sourceHash(source), status: 'saved', updatedAt: at });
    if (written) rebased.sourceWritebackReceipt = receipt(transaction, after.project, source, language, rebased.revision);
    if (rebased.sourceHashes) rebased.sourceHashes = { [segmentId]: sourceHash(source) };
    const row = { namespace, language, segmentId, beforeDraft: copy(draft), beforeHash: fingerprint(draft), afterDraft: rebased, afterHash: fingerprint(rebased) }; rows.push(row); after[namespace][language][segmentId] = copy(rebased);
  }
  transaction.draftRebases = { schemaVersion: 1, projectId: after.project.id, baseSnapshotId: transaction.baseSnapshotId, afterSnapshotId: after.project.snapshotId, rows };
  return { changed: rows.length };
}

export function reconcileLegacyConfirmedDraft({ state, transactions, segmentId, language }) {
  const namespace = state.readingDrafts?.[language]?.[segmentId] ? 'readingDrafts' : 'translations', draft = state[namespace]?.[language]?.[segmentId], source = index(state).get(segmentId);
  if (!draft || !source) return null;
  if (draft.sourceHash === sourceHash(source) && draft.status !== 'stale' && !fields.some(key => Object.hasOwn(draft, key))) return { draft, repaired: false };
  for (const transaction of [...transactions].reverse()) {
    if (transaction.state !== 'applied' || transaction.revertedBy || transaction.projectId !== state.project.id) continue;
    for (const proposal of state.proposals || []) {
      if (!transaction.proposalIds.includes(proposal.proposalId) || proposal.context?.undoOf) continue;
      const request = state.requests?.find(row => row.requestId === proposal.context?.requestId), selected = request?.segments?.find(row => (row.segmentId || row.id) === segmentId), captured = selected?.translationDraft, revision = request?.draftRevisions?.[segmentId];
      if (request?.kind !== 'revision' || request.projectId !== state.project.id || request.snapshotId !== transaction.baseSnapshotId || request.language !== language || captured?.text !== draft.text || !Number.isSafeInteger(revision) || draft.revision !== revision || captured.translationUnitIds?.some(id => id !== segmentId)) continue;
      const edit = proposal.edits.find(row => row.segmentId === segmentId && row.path === source.path && row.beforeHash === selected.beforeHash && row.replacement.trim() === source.source);
      if (!edit || ![edit.beforeHash, sourceHash(source)].includes(draft.sourceHash) || !same(footprint(draft.text, source), footprint(source.source, source))) continue;
      const rebased = copy(draft); for (const key of fields) delete rebased[key]; Object.assign(rebased, { sourceHash: sourceHash(source), revision: draft.revision + 1, status: 'saved', updatedAt: new Date().toISOString() });
      rebased.sourceWritebackReceipt = receipt(transaction, state.project, source, language, rebased.revision);
      if (rebased.sourceHashes) rebased.sourceHashes = { [segmentId]: sourceHash(source) };
      const row = { namespace, language, segmentId, beforeDraft: copy(draft), beforeHash: fingerprint(draft), afterDraft: rebased, afterHash: fingerprint(rebased) };
      const ledger = transaction.draftRebases ||= { schemaVersion: 1, projectId: state.project.id, baseSnapshotId: transaction.baseSnapshotId, afterSnapshotId: state.project.snapshotId, rows: [] };
      const prepared = ledger.rows.find(item => item.namespace === namespace && item.language === language && item.segmentId === segmentId);
      if (prepared) {
        if (prepared.beforeHash !== fingerprint(draft) || prepared.afterHash !== fingerprint(prepared.afterDraft) || prepared.afterDraft.text !== draft.text || prepared.afterDraft.sourceHash !== sourceHash(source) || prepared.afterDraft.revision !== draft.revision + 1) return null;
        state[namespace][language][segmentId] = copy(prepared.afterDraft); return { draft: state[namespace][language][segmentId], repaired: true, transactionId: transaction.transactionId, replay: true };
      }
      ledger.rows.push(row); state[namespace][language][segmentId] = rebased; return { draft: rebased, repaired: true, transactionId: transaction.transactionId };
    }
  }
  return null;
}
