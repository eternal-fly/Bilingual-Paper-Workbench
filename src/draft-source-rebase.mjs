import { sha256 } from './latex.mjs';
import { captureFormulaRequest } from './formula-edits.mjs';
import { parseEditableReference } from './reference-edits.mjs';
import { deriveTranslationProtectedTokens } from '../ui/translation-protection.mjs';
import { inlineStructureFields,prepareInlineStructureIntent } from './inline-structures.mjs';
import {rebaseAlignedAuthorDrafts,rebaseAlignedUndoDrafts,validateAlignedReplayRow} from './aligned-draft-rebase.mjs';

const fields = ['formulaEdits', 'formulaEditHistory', 'formulaEditsConflict', 'formulaEditUnmapped', 'referenceEdits', 'referenceEditHistory', 'referenceEditsConflict', 'referenceEditUnmapped',...inlineStructureFields,'sourceReviewRequired','sourceReviewDiagnostics'];
const copy = value => structuredClone(value), same = (a, b) => JSON.stringify(a) === JSON.stringify(b), sourceHash = row => row?.sourceHash || row?.beforeHash;
const fingerprint = draft => sha256(JSON.stringify({ ...draft, status: null }));
const index = state => new Map([...(state.segments || []), ...(state.readingParagraphs || [])].map(row => [row.id, row]));
const footprint = (text, source) => deriveTranslationProtectedTokens(text, source.protectedTokens || []).map(row => row.raw);
const receipt = (transaction, project, source, language, revision) => ({ schemaVersion: 1, projectId: project.id, language, segmentId: source.id, transactionId: transaction.transactionId, revision, sourceHash: sourceHash(source) });
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export function authorDraftGrant(request, selected, draft, language, transaction, segmentId, beforeSourceHash) {
  const marker = request?.oneClickWriteback, grants = transaction.authorDraftAcceptances || [transaction.authorDraftAcceptance];
  if (!Array.isArray(grants) || marker?.schemaVersion !== 1 || marker.mode !== 'author-approved-free-source' || !validHash(marker.scopeHash) || typeof marker.taskId !== 'string' || !marker.taskId || marker.taskId.length > 128 || request.kind !== 'revision' || request.mode !== 'source-review' || transaction.projectId!==request.projectId || !['committing','recovering','applied'].includes(transaction.state) || transaction.sourceChangedAgain || selected?.draftReview?.mode !== 'raw-tex-source-review' || sourceHash(selected)!==beforeSourceHash || !draft || typeof draft.text !== 'string' || !validHash(transaction.candidateHash) || typeof transaction.buildId !== 'string' || !transaction.buildId) return null;
  const matches = grants.filter(grant => grant?.requestId === request.requestId);
  if (matches.length !== 1) return null;
  const grant = matches[0];
  if (grant.schemaVersion !== 1 || grant.taskId !== marker.taskId || grant.scopeHash !== marker.scopeHash || grant.projectId !== request.projectId || grant.baseSnapshotId !== request.snapshotId || grant.baseSnapshotId !== transaction.baseSnapshotId || grant.language !== language || !Array.isArray(grant.drafts) || new Set(grant.drafts.map(row => row.segmentId)).size !== grant.drafts.length) return null;
  const row = grant.drafts.find(item => item.segmentId === segmentId), captured = selected.translationDraft;
  if (!row || row.revision !== draft.revision || row.textHash !== sha256(draft.text) || row.beforeSourceHash !== beforeSourceHash || selected.draftReview.draftRevision !== draft.revision || selected.draftReview.draftHash !== row.textHash || selected.draftReview.sourceHash !== beforeSourceHash || captured?.text !== draft.text || (captured.revision !== undefined && captured.revision !== draft.revision)) return null;
  return grant;
}
function authorReceipt(transaction, project, source, language, revision, accepted, draft, grant) {
  return { ...receipt(transaction, project, source, language, revision), schemaVersion: 2, sourceApplied: true, mode: 'author-approved-free-source', taskId: grant.taskId, scopeHash: grant.scopeHash, requestId: accepted.request.requestId, proposalId: accepted.proposal.proposalId, capturedDraftRevision: draft.revision, draftHash: sha256(draft.text), beforeSourceHash: accepted.edit.beforeHash, baseSnapshotId: transaction.baseSnapshotId, appliedSnapshotId: project.snapshotId, candidateHash: transaction.candidateHash, buildId: transaction.buildId };
}
function validReplayRow(row, before, after, transaction, source) {
  if (!['translations','readingDrafts'].includes(row.namespace) || row.beforeHash !== fingerprint(row.beforeDraft) || row.afterHash !== fingerprint(row.afterDraft) || row.beforeDraft?.text !== row.afterDraft?.text || !Number.isSafeInteger(row.beforeDraft?.revision) || row.afterDraft?.revision !== row.beforeDraft.revision + 1) return false;
  const received = row.afterDraft.sourceWritebackReceipt;
  if (received?.schemaVersion !== 2) return true;
  const request=before.requests?.find(item=>item.requestId===received.requestId),proposal=before.proposals?.find(item=>item.proposalId===received.proposalId),selected=request?.segments?.find(item=>(item.segmentId||item.id)===row.segmentId),edit=proposal?.edits?.find(item=>item.segmentId===row.segmentId),grant=edit&&authorDraftGrant(request,selected,row.beforeDraft,row.language,transaction,row.segmentId,edit.beforeHash);
  return Boolean(grant && transaction.proposalIds.includes(proposal.proposalId) && edit.path===source.path && edit.replacement.trim()===source.source && row.afterDraft.sourceApplied===true && !fields.some(key=>Object.hasOwn(row.afterDraft,key)) && same(received,authorReceipt(transaction,after.project,source,row.language,row.afterDraft.revision,{request,proposal,selected,edit},row.beforeDraft,grant)));
}
function targetsCurrent(edits, registry) { return (edits || []).every(edit => { if (!edit.replacement) return true; const parsed = parseEditableReference(edit.replacement); return parsed && parsed.keys.every(key => !registry.dynamic[parsed.category].has(key) && registry.counts[parsed.category].get(key) === 1 && (parsed.category !== 'citations' || registry.citationFoldCounts.get(key.toLowerCase()) === 1)); }); }
function retag(draft, source, oldProject, project, registry, language) {
  try { const captured=captureFormulaRequest({ id: source.id, text: source.displayText, protectedTokens: source.protectedTokens }, source, draft, oldProject, language);if(captured.draftReview&&!draft.sourceReviewRequired)return null; } catch { return null; }
  if (!targetsCurrent(draft.referenceEdits, registry)) return null;
  const result = copy(draft), edits = rows => (rows || []).map(row => ({ ...row, snapshotId: project.snapshotId, sourceHash: sourceHash(source), ...(row.registryHash ? { registryHash: registry.hash } : {}) }));
  if(result.inlineStructureIntent){try{Object.assign(result,prepareInlineStructureIntent(source,draft.text,project,language));}catch{return null;}}
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
    if (edit) return {edit,selected,request,proposal};
  }
  return null;
}
/** Exact confirmed writes may advance their own author drafts. A source reload,
 * matching formula alone or a model result never grants this transition. */
export function rebaseConfirmedTranslationDrafts({ before, after, transaction, registry, undoTransaction = null, at = new Date().toISOString() }) {
  if (before.project?.id !== after.project?.id || transaction.projectId !== after.project?.id) return { changed: 0 };
  const sources = index(after), oldSources = index(before);
  if (transaction.draftRebases) {
    const ledger = transaction.draftRebases; if (ledger.schemaVersion!==1 || ledger.projectId !== after.project.id || ledger.baseSnapshotId!==transaction.baseSnapshotId || ledger.afterSnapshotId !== after.project.snapshotId || !Array.isArray(ledger.rows)) return { changed: 0 };
    let changed = 0;
    for (const row of ledger.rows) { const current = after[row.namespace]?.[row.language]?.[row.segmentId], source = sources.get(row.segmentId); if (!current || fingerprint(current) === row.afterHash)continue;const aligned=row.afterDraft?.sourceWritebackReceipt?.sourceSegmentIds||row.beforeDraft?.sourceWritebackReceipt?.sourceSegmentIds;if(aligned){if(fingerprint(current)===row.beforeHash&&validateAlignedReplayRow(row,{before,after,transaction,undoTransaction})){after[row.namespace][row.language][row.segmentId]=copy(row.afterDraft);changed++;}continue;} if (sourceHash(source) !== row.afterDraft.sourceHash || !validReplayRow(row,before,after,transaction,source)) continue; if (fingerprint(current) === row.beforeHash) { after[row.namespace][row.language][row.segmentId] = copy(row.afterDraft); changed++; } }
    return { changed, replay: true };
  }
  if (before.project.snapshotId !== transaction.baseSnapshotId) return { changed: 0 };
  const group=undoTransaction?rebaseAlignedUndoDrafts({before,after,transaction,undoTransaction,at}):rebaseAlignedAuthorDrafts({before,after,transaction,at}),rows = [...group.rows], undoRows = new Map((undoTransaction?.draftRebases?.rows || []).map(row => [`${row.namespace}\0${row.language}\0${row.segmentId}`, row]));
  for(const row of group.rows)after[row.namespace][row.language][row.segmentId]=copy(row.afterDraft);
  for (const namespace of ['translations', 'readingDrafts']) for (const [language, drafts] of Object.entries(before[namespace] || {})) for (const [segmentId, draft] of Object.entries(drafts)) {
    if(group.handledKeys.has(`${namespace}\0${language}\0${segmentId}`))continue;
    const source = sources.get(segmentId), oldSource = oldSources.get(segmentId), current = after[namespace]?.[language]?.[segmentId];
    if (!source || !oldSource || !current || fingerprint(current) !== fingerprint(draft) || !Number.isSafeInteger(draft.revision) || draft.revision < 1 || draft.revision >= Number.MAX_SAFE_INTEGER || typeof draft.text !== 'string' || draft.sourceSegmentIds && (!same(draft.sourceSegmentIds, [segmentId]) || draft.unitKind === 'split')) continue;
    let rebased = null, written = false, authorWrite = null;
    const inverse = undoRows.get(`${namespace}\0${language}\0${segmentId}`);
    const accepted=acceptedDraft(before,oldSource,draft,language,transaction),edit=accepted?.edit,clickedGrant=accepted&&authorDraftGrant(accepted.request,accepted.selected,draft,language,transaction,segmentId,sourceHash(oldSource));
    if (inverse && fingerprint(draft) === inverse.afterHash && draft.revision === inverse.afterDraft.revision && sourceHash(source) === inverse.beforeDraft.sourceHash) rebased = retag(inverse.beforeDraft, source, { ...after.project, snapshotId: undoTransaction.baseSnapshotId }, after.project, registry, language);
    else if(inverse&&fingerprint(draft)===inverse.afterHash&&draft.revision===inverse.afterDraft.revision&&inverse.afterDraft.sourceWritebackReceipt?.schemaVersion===2&&sourceHash(source)===inverse.afterDraft.sourceWritebackReceipt.beforeSourceHash&&validReplayRow(inverse,before,before,undoTransaction,oldSource)){
      rebased=copy(inverse.beforeDraft);for(const key of fields)delete rebased[key];delete rebased.sourceWritebackReceipt;delete rebased.sourceApplied;rebased.sourceReviewRequired=true;rebased.sourceReviewDiagnostics=[{code:'SOURCE_REVIEW_REOPENED_AFTER_UNDO',message:'The exact saved author text is preserved after undo. Prepare a fresh candidate against the restored source; older source-edit grants were not restored.'}];
    }
    else if (draft.status !== 'stale' && draft.sourceHash === sourceHash(oldSource) || clickedGrant) {
      if(edit&&edit.replacement.trim()===source.source&&accepted.selected.draftReview){rebased=copy(draft);for(const key of fields)delete rebased[key];delete rebased.sourceWritebackReceipt;delete rebased.sourceApplied;if(clickedGrant){authorWrite={accepted,grant:clickedGrant};written=true;}else{rebased.sourceReviewRequired=true;const raw=accepted.selected.draftReview.mode==='raw-tex-source-review';rebased.sourceReviewDiagnostics=[...(draft.sourceReviewDiagnostics||accepted.selected.draftReview.diagnostics||[]).filter(row=>!['ADAPTIVE_SOURCE_BASELINE_RETAINED','RAW_SOURCE_REVIEW_DRAFT_PENDING'].includes(row.code)).slice(0,7),{code:raw?'RAW_SOURCE_REVIEW_DRAFT_PENDING':'ADAPTIVE_SOURCE_BASELINE_RETAINED',message:raw?'The exact reviewed English TeX candidate was written. Your raw author draft is saved against the new source; unresolved draft intent has not been automatically marked fully applied. Continue editing or prepare another source-review candidate.':'The confirmed English candidate retained the listed original TeX objects. Your exact raw author draft is saved; its unresolved changes still need review.'}];}}
      else if (edit && !draft.sourceReviewRequired && edit.replacement.trim() === source.source && same(footprint(draft.text, source), footprint(source.source, source))) { rebased = copy(draft); for (const key of fields) delete rebased[key]; written = true; }
      else if (sourceHash(oldSource) === sourceHash(source) && oldSource.source === source.source && same(oldSource.protectedTokens, source.protectedTokens) && fields.some(key => Object.hasOwn(draft, key))) rebased = retag(draft, source, before.project, after.project, registry, language);
    }
    if (!rebased) { if (draft.sourceHash !== sourceHash(source) || fields.some(key => Object.hasOwn(draft, key)) && before.project.snapshotId !== after.project.snapshotId) current.status = 'stale'; continue; }
    Object.assign(rebased, { revision: draft.revision + 1, sourceHash: sourceHash(source), status: 'saved', updatedAt: at });
    if (written) rebased.sourceWritebackReceipt = authorWrite ? authorReceipt(transaction,after.project,source,language,rebased.revision,authorWrite.accepted,draft,authorWrite.grant) : receipt(transaction, after.project, source, language, rebased.revision);
    if(authorWrite)rebased.sourceApplied=true;
    if (rebased.sourceHashes) rebased.sourceHashes = { [segmentId]: sourceHash(source) };
    const row = { namespace, language, segmentId, beforeDraft: copy(draft), beforeHash: fingerprint(draft), afterDraft: rebased, afterHash: fingerprint(rebased) }; rows.push(row); after[namespace][language][segmentId] = copy(rebased);
  }
  // Reading synchronization may copy a canonical draft into a newly derived
  // slot (including an exact empty insertion anchor). Advance that shadow only
  // when it is provably the same untouched draft; retain independent/newer text.
  for(const row of [...rows]){
    if(row.namespace!=='translations'||row.afterDraft.sourceWritebackReceipt?.sourceSegmentIds||row.beforeDraft.sourceWritebackReceipt?.sourceSegmentIds||before.readingDrafts?.[row.language]?.[row.segmentId])continue;
    const shadow=after.readingDrafts?.[row.language]?.[row.segmentId];
    if(!shadow||fingerprint(shadow)!==row.beforeHash)continue;
    const mirrored={...copy(row),namespace:'readingDrafts',beforeDraft:copy(shadow)};mirrored.beforeHash=fingerprint(mirrored.beforeDraft);rows.push(mirrored);after.readingDrafts[row.language][row.segmentId]=copy(row.afterDraft);
  }
  transaction.draftRebases = { schemaVersion: 1, projectId: after.project.id, baseSnapshotId: transaction.baseSnapshotId, afterSnapshotId: after.project.snapshotId, rows };
  return { changed: rows.length };
}

export function reconcileLegacyConfirmedDraft({ state, transactions, segmentId, language }) {
  const namespace = state.readingDrafts?.[language]?.[segmentId] ? 'readingDrafts' : 'translations', draft = state[namespace]?.[language]?.[segmentId], source = index(state).get(segmentId);
  if (!draft || !source) return null;
  if(draft.sourceReviewRequired)return{draft,repaired:false};
  if (draft.sourceHash === sourceHash(source) && draft.status !== 'stale' && !fields.some(key => Object.hasOwn(draft, key))) return { draft, repaired: false };
  for (const transaction of [...transactions].reverse()) {
    if (transaction.state !== 'applied' || transaction.revertedBy || transaction.projectId !== state.project.id) continue;
    for (const proposal of state.proposals || []) {
      if (!transaction.proposalIds.includes(proposal.proposalId) || proposal.context?.undoOf) continue;
      const request = state.requests?.find(row => row.requestId === proposal.context?.requestId), selected = request?.segments?.find(row => (row.segmentId || row.id) === segmentId), captured = selected?.translationDraft, revision = request?.draftRevisions?.[segmentId];
      if (request?.kind !== 'revision' || selected?.draftReview || request.projectId !== state.project.id || request.snapshotId !== transaction.baseSnapshotId || request.language !== language || captured?.text !== draft.text || !Number.isSafeInteger(revision) || draft.revision !== revision || captured.translationUnitIds?.some(id => id !== segmentId)) continue;
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

/** Read-only physical-write proof for old and new private rebase ledgers. This
 * does not grant source authority or assert semantic fidelity of a raw draft. */
export function verifiedAppliedDraftReceipts({state,transactions=[]}) {
  const sources=index(state),records=[];
  for(const transaction of transactions){
    const ledger=transaction.draftRebases;
    if(transaction.state!=='applied'||transaction.revertedBy||transaction.sourceChangedAgain||transaction.projectId!==state.project?.id||!transaction.afterSnapshotId||ledger?.schemaVersion!==1||ledger.projectId!==state.project.id||ledger.baseSnapshotId!==transaction.baseSnapshotId||ledger.afterSnapshotId!==transaction.afterSnapshotId||!Array.isArray(ledger.rows))continue;
    for(const row of ledger.rows){
      const draft=state[row.namespace]?.[row.language]?.[row.segmentId],source=sources.get(row.segmentId);
      const aligned=row.afterDraft?.sourceWritebackReceipt;
      if(aligned?.schemaVersion===2&&Array.isArray(aligned.sourceSegmentIds)){
        if(draft&&fingerprint(draft)===row.afterHash&&validateAlignedReplayRow(row,{before:state,after:state,transaction}))records.push({schemaVersion:1,kind:'verified-source-write-group',physicalSourceApplied:true,projectId:state.project.id,namespace:row.namespace,language:row.language,segmentId:row.segmentId,revision:draft.revision,draftHash:sha256(draft.text),sourceHash:draft.sourceHash,sourceSegmentIds:copy(aligned.sourceSegmentIds),sourceProofs:copy(aligned.sourceProofs),transactionId:transaction.transactionId,requestId:aligned.requestId,baseSnapshotId:transaction.baseSnapshotId,appliedSnapshotId:transaction.afterSnapshotId,semanticReviewRequired:draft.sourceReviewRequired===true});
        continue;
      }
      if(!draft||!source||draft.status==='stale'||!['translations','readingDrafts'].includes(row.namespace)||row.afterHash!==fingerprint(row.afterDraft)||row.beforeHash!==fingerprint(row.beforeDraft)||fingerprint(draft)!==row.afterHash||row.afterDraft.revision!==row.beforeDraft.revision+1||row.afterDraft.text!==row.beforeDraft.text||sourceHash(source)!==draft.sourceHash||row.afterDraft.sourceHash!==draft.sourceHash)continue;
      const matches=[];
      for(const proposal of state.proposals||[]){
        if(!transaction.proposalIds?.includes(proposal.proposalId)||proposal.context?.undoOf||proposal.projectId!==state.project.id||proposal.baseSnapshotId!==transaction.baseSnapshotId||proposal.applicationState!=='applied'||proposal.transactionId!==transaction.transactionId)continue;
        const request=state.requests?.find(item=>item.requestId===proposal.context?.requestId),selected=request?.segments?.find(item=>(item.segmentId||item.id)===row.segmentId),captured=selected?.translationDraft;
        if(request?.kind!=='revision'||request.projectId!==state.project.id||request.snapshotId!==transaction.baseSnapshotId||request.language!==row.language||request.draftRevisions?.[row.segmentId]!==row.beforeDraft.revision||captured?.text!==draft.text||captured.translationUnitIds?.some(id=>id!==row.segmentId))continue;
        const edits=proposal.edits?.filter(edit=>edit.segmentId===row.segmentId&&edit.path===source.path&&edit.beforeHash===sourceHash(selected)&&typeof edit.replacement==='string'&&edit.replacement.trim()===source.source)||[];
        for(const edit of edits)matches.push({proposal,request,selected,edit});
      }
      if(matches.length!==1)continue;
      const {proposal,request}=matches[0];
      records.push({schemaVersion:1,kind:'verified-source-write',physicalSourceApplied:true,projectId:state.project.id,namespace:row.namespace,language:row.language,segmentId:row.segmentId,revision:draft.revision,capturedDraftRevision:row.beforeDraft.revision,draftHash:sha256(draft.text),sourceHash:draft.sourceHash,transactionId:transaction.transactionId,requestId:request.requestId,proposalId:proposal.proposalId,baseSnapshotId:transaction.baseSnapshotId,appliedSnapshotId:transaction.afterSnapshotId,candidateHash:transaction.candidateHash,buildId:transaction.buildId,semanticReviewRequired:draft.sourceReviewRequired===true});
    }
  }
  return records;
}
