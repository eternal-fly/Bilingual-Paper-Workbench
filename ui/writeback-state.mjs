const normalized = value => typeof value === 'string' ? value.replaceAll('\r\n', '\n') : '';
const sameIds = (left, right) => Array.isArray(left) && left.length === right.length && new Set(left).size === left.length && left.every(id => right.includes(id));
const sourceHash = source => source?.sourceHash || source?.beforeHash;
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

function authorReceiptMatches(receipt, draft, selected, request, proposal, transaction, id, language) {
  const marker=request?.oneClickWriteback, grants=transaction.authorDraftAcceptances || [transaction.authorDraftAcceptance];
  if(receipt?.schemaVersion!==2||receipt.sourceApplied!==true||draft?.sourceApplied!==true||receipt.mode!=='author-approved-free-source'||selected?.draftReview?.mode!=='raw-tex-source-review'||request.mode!=='source-review'||marker?.schemaVersion!==1||marker.mode!==receipt.mode||marker.taskId!==receipt.taskId||marker.scopeHash!==receipt.scopeHash||!validHash(receipt.scopeHash)||!Array.isArray(grants))return false;
  const matches=grants.filter(grant=>grant?.requestId===request.requestId);if(matches.length!==1)return false;
  const grant=matches[0],row=grant.drafts?.find(item=>item.segmentId===id);
  return grant.schemaVersion===1&&grant.taskId===receipt.taskId&&grant.scopeHash===receipt.scopeHash&&grant.projectId===request.projectId&&grant.baseSnapshotId===request.snapshotId&&grant.language===language&&Array.isArray(grant.drafts)&&new Set(grant.drafts.map(item=>item.segmentId)).size===grant.drafts.length&&row?.revision===receipt.capturedDraftRevision&&row?.textHash===receipt.draftHash&&row?.beforeSourceHash===receipt.beforeSourceHash&&selected.draftReview.draftRevision===receipt.capturedDraftRevision&&selected.draftReview.draftHash===receipt.draftHash&&selected.draftReview.sourceHash===receipt.beforeSourceHash&&request.draftRevisions?.[id]===receipt.capturedDraftRevision&&draft.revision===receipt.capturedDraftRevision+1&&draft.text===selected.translationDraft?.text&&receipt.requestId===request.requestId&&receipt.proposalId===proposal.proposalId&&receipt.baseSnapshotId===transaction.baseSnapshotId&&receipt.baseSnapshotId===request.snapshotId&&receipt.appliedSnapshotId===transaction.afterSnapshotId&&receipt.beforeSourceHash===proposal.edits?.find(edit=>edit.segmentId===id)?.beforeHash&&validHash(receipt.draftHash)&&validHash(receipt.candidateHash)&&receipt.candidateHash===transaction.candidateHash&&receipt.buildId===transaction.buildId;
}

function requestMatches(request, state, language, sources, current = true) {
  if (!request || request.kind !== 'revision' || request.projectId !== state.project?.id || request.language !== language || current && (request.status !== 'completed' || request.snapshotId !== state.project?.snapshotId || request.requiresTranslationMerge && !(request.mode==='source-review'&&request.oneClickWriteback?.mode==='author-approved-free-source'))) return false;
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
  if(alignedWriteReceipt(state,language,id,sources))return true;
  const physical=physicalWriteReceipt(state,language,id,sources);
  if(physical&&!unfulfilledAdaptiveIntent(state,language,id,physical))return true;
  const source = sources.get(id); if (!source || state.translations?.[language]?.[id]?.sourceReviewRequired) return false;
  return (state.proposals || []).some(proposal => {
    if (proposal.applicationState !== 'applied') return false;
    const transaction = proposal.transactionId ? (state.transactions || []).find(item => item.transactionId === proposal.transactionId) : (state.transactions || []).find(item => item.state === 'applied' && !item.revertedBy && item.proposalIds?.includes(proposal.proposalId));
    if (transaction?.state !== 'applied' || transaction.revertedBy) return false;
    const request = (state.requests || []).find(item => item.requestId === proposal.context?.requestId), edit = proposal.edits?.find(item => item.segmentId === id);
    const selected = request?.segments?.find(item => (item.segmentId || item.id) === id), drafts = state.translations?.[language] || {}, units = selected?.translationDraft?.translationUnitIds || [id];
    const draft = drafts[id], receipt = draft?.sourceWritebackReceipt, noPendingIntent = draft?.status !== 'stale' && !draft?.formulaEdits?.length && !draft?.referenceEdits?.length && !draft?.formulaEditsConflict && !draft?.formulaEditUnmapped && !draft?.referenceEditsConflict && !draft?.referenceEditUnmapped && !draft?.inlineStructureIntent && !draft?.inlineStructureConflict && !draft?.inlineStructureUnmapped && !draft?.sourceReviewRequired;
    const currentReceipt = [1,2].includes(receipt?.schemaVersion) && receipt.projectId === state.project?.id && receipt.language === language && receipt.segmentId === id && receipt.transactionId === transaction.transactionId && transaction.projectId === state.project?.id && receipt.revision === draft?.revision && receipt.sourceHash === sourceHash(source) && draft?.sourceHash === receipt.sourceHash && noPendingIntent && units.length === 1 && units[0] === id && (receipt.schemaVersion===1&&!selected?.draftReview||authorReceiptMatches(receipt,draft,selected,request,proposal,transaction,id,language));
    const capturedRevision = request?.draftRevisions?.[id] === (drafts[id]?.revision || 0) && units.every(unit => request.translationUnitRevisions?.[unit] === undefined || request.translationUnitRevisions[unit] === (drafts[unit]?.revision || 0));
    const covered = request?.kind === 'revision' && request.projectId === state.project?.id && request.language === language && (selected?.draftReview ? currentReceipt : capturedRevision || currentReceipt) && selected?.translationDraft && normalized(units.map(unit => drafts[unit]).filter(Boolean).map(draft => draft.text).join('\n\n')) === normalized(selected.translationDraft.text);
    return edit && covered && normalized(edit.replacement).trim() === normalized(source.source).trim();
  });
}

function alignedWriteReceipt(state,language,id,sources){
  const drafts=state.translations?.[language]||{},draft=drafts[id],receipt=draft?.sourceWritebackReceipt,sourceIds=receipt?.sourceSegmentIds,unitIds=receipt?.translationUnitIds;
  if(receipt?.schemaVersion!==2||receipt.sourceApplied!==true||draft.sourceApplied!==true||!Array.isArray(sourceIds)||!sourceIds.length||new Set(sourceIds).size!==sourceIds.length||!Array.isArray(unitIds)||new Set(unitIds).size!==unitIds.length||!unitIds.includes(id)||!sourceIds.every(sourceId=>sources.has(sourceId)))return null;
  const alignment=(state.alignments||[]).filter(row=>row.language===language&&row.translationUnitIds?.includes(id));
  if(alignment.length!==1||alignment[0].stale||alignment[0].status==='stale'||JSON.stringify(alignment[0].sourceSegmentIds)!==JSON.stringify(sourceIds)||JSON.stringify(alignment[0].translationUnitIds)!==JSON.stringify(unitIds))return null;
  const transaction=state.transactions?.find(row=>row.transactionId===receipt.transactionId),request=state.requests?.find(row=>row.requestId===receipt.requestId),marker=request?.oneClickWriteback,grants=transaction?.authorDraftAcceptances||[transaction?.authorDraftAcceptance],matches=grants.filter(row=>row?.requestId===request?.requestId);
  if(transaction?.state!=='applied'||transaction.projectId!==state.project?.id||transaction.revertedBy||transaction.sourceChangedAgain||receipt.appliedSnapshotId!==transaction.afterSnapshotId||receipt.baseSnapshotId!==transaction.baseSnapshotId||receipt.candidateHash!==transaction.candidateHash||receipt.buildId!==transaction.buildId||request?.mode!=='source-review'||request.kind!=='revision'||request.projectId!==state.project.id||request.snapshotId!==receipt.baseSnapshotId||request.language!==language||marker?.mode!=='author-approved-free-source'||marker.taskId!==receipt.taskId||marker.scopeHash!==receipt.scopeHash||!validHash(marker.scopeHash)||matches.length!==1)return null;
  const grant=matches[0],combined=unitIds.map(unit=>drafts[unit]?.text).join('\n\n');
  if(grant.schemaVersion!==1||grant.taskId!==receipt.taskId||grant.scopeHash!==receipt.scopeHash||grant.projectId!==state.project.id||grant.baseSnapshotId!==receipt.baseSnapshotId||grant.language!==language||!Array.isArray(grant.drafts)||new Set(grant.drafts.map(row=>row.segmentId)).size!==grant.drafts.length)return null;
  for(const unit of unitIds){
    const current=drafts[unit],proof=current?.sourceWritebackReceipt,row=grant.drafts.find(item=>item.segmentId===unit);
    if(!current||current.status==='stale'||current.sourceApplied!==true||current.sourceReviewRequired||current.formulaEdits?.length||current.referenceEdits?.length||current.formulaEditsConflict||current.formulaEditUnmapped||current.referenceEditsConflict||current.referenceEditUnmapped||current.inlineStructureIntent||current.inlineStructureConflict||current.inlineStructureUnmapped||proof?.schemaVersion!==2||proof.transactionId!==receipt.transactionId||proof.requestId!==receipt.requestId||proof.taskId!==receipt.taskId||proof.scopeHash!==receipt.scopeHash||proof.capturedDraftRevision!==row?.revision||proof.draftHash!==row?.textHash||proof.revision!==current.revision||current.revision!==row?.revision+1||request.translationUnitRevisions?.[unit]!==row.revision||JSON.stringify(proof.sourceSegmentIds)!==JSON.stringify(sourceIds)||JSON.stringify(proof.translationUnitIds)!==JSON.stringify(unitIds)||!sameIds(row.sourceSegmentIds,sourceIds))return null;
  }
  for(const sourceId of sourceIds){
    const source=sources.get(sourceId),selected=request.segments?.find(row=>(row.segmentId||row.id)===sourceId),proof=receipt.sourceProofs?.find(row=>row.segmentId===sourceId),proposal=state.proposals?.find(row=>row.proposalId===proof?.proposalId),edit=proposal?.edits?.find(row=>row.segmentId===sourceId);
    if(!proof||proof.sourceHash!==sourceHash(source)||receipt.sourceHashes?.[sourceId]!==sourceHash(source)||selected?.draftReview?.mode!=='raw-tex-source-review'||selected.translationDraft?.text!==combined||JSON.stringify(selected.translationDraft?.translationUnitIds)!==JSON.stringify(unitIds)||selected.sourceHash!==proof.beforeSourceHash||!transaction.proposalIds?.includes(proposal?.proposalId)||proposal.applicationState!=='applied'||proposal.transactionId!==transaction.transactionId||proposal.context?.requestId!==request.requestId||edit?.beforeHash!==proof.beforeSourceHash||edit.path!==source.path||edit.replacement.trim()!==source.source||grant.drafts.filter(row=>unitIds.includes(row.segmentId)).some(row=>row.beforeSourceHashes?.[sourceId]!==proof.beforeSourceHash))return null;
  }
  return receipt;
}

function physicalWriteReceipt(state,language,id,sources){
  const source=sources.get(id),draft=state.translations?.[language]?.[id];if(!source||!draft||draft.status==='stale')return null;
  for(const receipt of state.appliedDraftReceipts||[]){
    if(receipt.schemaVersion!==1||receipt.kind!=='verified-source-write'||receipt.physicalSourceApplied!==true||receipt.projectId!==state.project?.id||receipt.language!==language||receipt.segmentId!==id||receipt.revision!==draft.revision||receipt.sourceHash!==sourceHash(source)||receipt.sourceHash!==draft.sourceHash||!validHash(receipt.draftHash))continue;
    const transaction=state.transactions?.find(item=>item.transactionId===receipt.transactionId),proposal=state.proposals?.find(item=>item.proposalId===receipt.proposalId),request=state.requests?.find(item=>item.requestId===receipt.requestId),selected=request?.segments?.find(item=>(item.segmentId||item.id)===id);
    if(transaction?.state!=='applied'||transaction.revertedBy||transaction.sourceChangedAgain||transaction.projectId!==state.project.id||transaction.afterSnapshotId!==receipt.appliedSnapshotId||transaction.baseSnapshotId!==receipt.baseSnapshotId||transaction.candidateHash!==receipt.candidateHash||transaction.buildId!==receipt.buildId||!transaction.proposalIds?.includes(proposal?.proposalId)||proposal.applicationState!=='applied'||proposal.transactionId!==transaction.transactionId||proposal.context?.requestId!==request?.requestId||request?.kind!=='revision'||request.projectId!==state.project.id||request.snapshotId!==receipt.baseSnapshotId||request.language!==language||request.draftRevisions?.[id]!==receipt.capturedDraftRevision||draft.revision!==receipt.capturedDraftRevision+1||selected?.translationDraft?.text!==draft.text||selected.translationDraft.translationUnitIds?.some(unit=>unit!==id))continue;
    const edit=proposal.edits?.find(item=>item.segmentId===id&&item.beforeHash===sourceHash(selected)&&item.path===source.path&&typeof item.replacement==='string'&&item.replacement.trim()===source.source);
    if(edit&&(!selected.draftReview?.draftHash||selected.draftReview.draftHash===receipt.draftHash))return receipt;
  }
  return null;
}

function unfulfilledAdaptiveIntent(state,language,id,physical){
  if(!physical||!state.translations?.[language]?.[id]?.sourceReviewRequired)return false;
  const request=state.requests?.find(row=>row.requestId===physical.requestId),selected=request?.segments?.find(row=>(row.segmentId||row.id)===id);
  return selected?.draftReview?.mode==='adaptive-human-draft';
}

/** Physical source status is distinct from unresolved semantic review history. */
export function draftSourceWritebackStatus(state,language,id){
  const sources=new Map();for(const source of[...(state.readingParagraphs||[]),...(state.segments||[])])if(!sources.has(source.id))sources.set(source.id,source);
  const physical=physicalWriteReceipt(state,language,id,sources)||alignedWriteReceipt(state,language,id,sources),sourceApplied=Boolean(physical||appliedDraft(state,language,id,sources));
  return{sourceApplied,semanticReviewRequired:Boolean(state.translations?.[language]?.[id]?.sourceReviewRequired),pendingAuthorIntent:unfulfilledAdaptiveIntent(state,language,id,physical),transactionId:physical?.transactionId||state.translations?.[language]?.[id]?.sourceWritebackReceipt?.transactionId||null};
}

/** A UI plan selects a complete current human scope; only the backend grants write authority. */
export function deriveEnglishWriteback(state, language, buffers = []) {
  const sources = new Map(); for (const source of [...(state.readingParagraphs || []), ...(state.segments || [])]) if (!sources.has(source.id)) sources.set(source.id, source);
  const drafts = state.translations?.[language] || {}, human = Object.entries(drafts).filter(([, draft]) => draft?.origin === 'human' || draft?.status === 'humanEdited');
  const rows = [], blockedIds = [];
  for (const [id, draft] of human) {
    if (appliedDraft(state, language, id, sources)) continue;
    const known=(state.alignments||[]).filter(item=>item.language===language&&item.translationUnitIds?.includes(id));
    if(known.length===1&&(known[0].sourceSegmentIds?.length!==1||known[0].translationUnitIds?.length!==1||known[0].sourceSegmentIds[0]!==id)){
      const alignment=known[0],ids=alignment.sourceSegmentIds||[],units=alignment.translationUnitIds||[],valid=!alignment.stale&&alignment.status!=='stale'&&ids.length&&units.length&&new Set(ids).size===ids.length&&new Set(units).size===units.length&&units.every(unit=>drafts[unit])&&ids.every(sourceId=>{const source=sources.get(sourceId);return source&&source.translatable!==false&&(source.writableSource!==false||source.sourceReviewAvailable)&&units.every(unit=>!drafts[unit].sourceHashes?.[sourceId]||drafts[unit].sourceHashes[sourceId]===sourceHash(source));});
      if(!valid)blockedIds.push(id);
      for(const sourceId of ids)if(!rows.some(row=>row.id===sourceId))rows.push({id:sourceId,hash:sourceHash(sources.get(sourceId)),unitIds:units,drafts:units.map(unit=>({id:unit,revision:drafts[unit]?.revision||0,text:drafts[unit]?.text||'',sourceHashes:drafts[unit]?.sourceHashes||null}))});
      if(!ids.length)rows.push({id,revision:draft.revision||0,text:draft.text||'',hash:null});
      continue;
    }
    if(known.length>1){blockedIds.push(id);rows.push({id,revision:draft.revision||0,text:draft.text||'',hash:null});continue;}
    const source = sources.get(id), alignment = (state.alignments || []).find(item => item.language === language && item.translationUnitIds?.includes(id));
    const aligned = !alignment || !alignment.stale && alignment.status !== 'stale' && alignment.sourceSegmentIds?.length === 1 && alignment.sourceSegmentIds[0] === id && alignment.translationUnitIds?.length === 1;
    if (!source || !aligned || draft.unitKind === 'split' || source.writableSource === false && !source.sourceReviewAvailable || source.translatable === false || draft.sourceHash && draft.sourceHash !== sourceHash(source)) blockedIds.push(id);
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
