import {sha256} from './latex.mjs';

const MAX_ENDPOINTS=5000,MAX_TEXT=4*1024*1024;
const NAMESPACES=['translations','readingDrafts'];
const INTENT_FIELDS=['formulaEdits','formulaEditHistory','formulaEditsConflict','formulaEditUnmapped','referenceEdits','referenceEditHistory','referenceEditsConflict','referenceEditUnmapped','inlineStructureIntent','inlineStructureConflict','inlineStructureUnmapped','sourceReviewRequired','sourceReviewDiagnostics'];
const copy=value=>structuredClone(value),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fingerprint=draft=>sha256(JSON.stringify({...draft,status:null}));
const hash=source=>source?.sourceHash||source?.beforeHash;
const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!value.includes('\0');
const ids=value=>Array.isArray(value)&&value.length>0&&value.length<=MAX_ENDPOINTS&&value.every(validId)&&new Set(value).size===value.length;
const sameIds=(left,right)=>ids(left)&&ids(right)&&left.length===right.length&&left.every(id=>right.includes(id));
const key=(namespace,language,id)=>`${namespace}\0${language}\0${id}`;
const sourceIndex=state=>new Map([...(state.segments||[]),...(state.readingParagraphs||[])].map(row=>[row.id,row]));
const groupShape=alignment=>alignment&&validId(alignment.language)&&ids(alignment.sourceSegmentIds)&&ids(alignment.translationUnitIds)&&!(alignment.sourceSegmentIds.length===1&&alignment.translationUnitIds.length===1&&alignment.sourceSegmentIds[0]===alignment.translationUnitIds[0]);
const active=alignment=>alignment.stale!==true&&alignment.status!=='stale';
const endpoint=(state,language,id)=>NAMESPACES.toReversed().map(namespace=>({namespace,draft:state[namespace]?.[language]?.[id]})).find(row=>row.draft);
const groupReceipt=receipt=>receipt?.schemaVersion===2&&ids(receipt.sourceSegmentIds)&&ids(receipt.translationUnitIds);
function rememberEndpoints(result,before,alignment){
 if(!groupShape(alignment))return;
 for(const id of alignment.translationUnitIds)for(const namespace of NAMESPACES)if(before[namespace]?.[alignment.language]?.[id])result.add(key(namespace,alignment.language,id));
}
function transactionCurrent(before,after,transaction){
 return before.project?.id&&before.project.id===after.project?.id&&transaction.projectId===before.project.id&&before.project.snapshotId===transaction.baseSnapshotId&&validId(after.project.snapshotId)&&validId(transaction.transactionId)&&['committing','recovering','applied'].includes(transaction.state)&&!transaction.sourceChangedAgain&&validHash(transaction.candidateHash)&&validId(transaction.buildId)&&ids(transaction.proposalIds);
}
function exactSource(source){return source&&validId(source.id)&&validId(source.path)&&typeof source.source==='string'&&validHash(hash(source))&&sha256(source.source)===hash(source)&&Number.isSafeInteger(source.startByte)&&Number.isSafeInteger(source.endByte)&&source.startByte>=0&&source.endByte>=source.startByte&&source.endByte-source.startByte===Buffer.byteLength(source.source);}
function editMatches(edit,oldSource,newSource){
 return exactSource(oldSource)&&exactSource(newSource)&&edit.segmentId===oldSource.id&&edit.path===oldSource.path&&newSource.path===oldSource.path&&edit.startByte===oldSource.startByte&&edit.endByte===oldSource.endByte&&edit.beforeHash===hash(oldSource)&&(edit.before===undefined||edit.before===oldSource.source)&&typeof edit.replacement==='string'&&edit.replacement.trim()===newSource.source;
}
function editsFor(before,after,transaction,sourceIds,{requestId=null,undoOf=null}={}){
 const oldSources=sourceIndex(before),sources=sourceIndex(after),proofs=[],requests=new Set();
 for(const id of sourceIds){
  const found=[];
  for(const proposal of before.proposals||[]){
   if(!transaction.proposalIds.includes(proposal.proposalId))continue;
   for(const edit of proposal.edits||[])if(edit.segmentId===id)found.push({proposal,edit});
  }
  if(found.length!==1)return null;
  const {proposal,edit}=found[0];
  if(proposal.projectId!==before.project.id||proposal.baseSnapshotId!==transaction.baseSnapshotId||!editMatches(edit,oldSources.get(id),sources.get(id)))return null;
  if(undoOf){if(proposal.context?.undoOf!==undoOf)return null;}
  else if(proposal.context?.undoOf||proposal.context?.mode!=='source-review'||!validId(proposal.context?.requestId))return null;
  if(requestId&&proposal.context?.requestId!==requestId)return null;
  requests.add(proposal.context?.requestId);
  proofs.push({segmentId:id,proposalId:proposal.proposalId,beforeSourceHash:hash(oldSources.get(id)),sourceHash:hash(sources.get(id))});
 }
 if(!undoOf&&requests.size!==1)return null;
 return{proofs,requestId:[...requests][0],oldSources,sources};
}
function sameHashes(value,sourceIds,sources){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===sourceIds.length&&sourceIds.every(id=>value[id]===hash(sources.get(id)));}
function wholeInverseFiles(before,after,transaction,undoOf=null){
 const proposals=(before.proposals||[]).filter(row=>transaction.proposalIds.includes(row.proposalId)),files=new Map();
 if(proposals.length!==transaction.proposalIds.length||!proposals.length)return null;
 const origins=new Set(proposals.map(row=>row.context?.undoOf));if(origins.size!==1||!validId([...origins][0])||undoOf&&![...origins].includes(undoOf))return null;
 for(const proposal of proposals){
  if(proposal.projectId!==before.project.id||proposal.baseSnapshotId!==transaction.baseSnapshotId)return null;
  for(const edit of proposal.edits||[]){
   const candidate=transaction.candidate?.files?.filter(file=>file.path===edit.path),read=transaction.readSet?.filter(file=>file.path===edit.path);
   if(files.has(edit.path)||edit.startByte!==0||typeof edit.before!=='string'||typeof edit.replacement!=='string'||edit.endByte!==Buffer.byteLength(edit.before)||sha256(edit.before)!==edit.beforeHash||candidate?.length!==1||read?.length!==1||read[0].hash!==edit.beforeHash||candidate[0].beforeHash!==edit.beforeHash||candidate[0].content!==edit.replacement||candidate[0].hash!==sha256(edit.replacement))return null;
   const oldFile=before.project.files?.find(file=>file.path===edit.path),newFile=after?.project.files?.find(file=>file.path===edit.path);
   if(oldFile&&oldFile.hash!==edit.beforeHash||newFile&&newFile.hash!==candidate[0].hash)return null;
   files.set(edit.path,{proposal,edit,before:Buffer.from(edit.before),after:Buffer.from(edit.replacement)});
  }
 }
 return files;
}
function inverseEditsFor(before,after,transaction,sourceIds,undoOf){
 const direct=editsFor(before,after,transaction,sourceIds,{undoOf});if(direct)return direct;
 const files=wholeInverseFiles(before,after,transaction,undoOf);if(!files)return null;
 const oldSources=sourceIndex(before),sources=sourceIndex(after),proofs=[];
 for(const id of sourceIds){
  const old=oldSources.get(id),source=sources.get(id),file=files.get(old?.path);
  if(!exactSource(old)||!exactSource(source)||old.path!==source.path||!file||old.endByte>file.before.length||source.endByte>file.after.length||file.before.subarray(old.startByte,old.endByte).toString('utf8')!==old.source||file.after.subarray(source.startByte,source.endByte).toString('utf8')!==source.source)return null;
  proofs.push({segmentId:id,proposalId:file.proposal.proposalId,beforeSourceHash:hash(old),sourceHash:hash(source)});
 }
 return{oldSources,sources,proofs};
}

/** Validate a complete explicit group against a server-owned author grant and
 * the exact refreshed source. This helper performs no writes or TeX execution. */
export function validateAlignedAuthorGrant({before,after,transaction,alignment}){
 try{
  if(!groupShape(alignment)||!active(alignment)||!transactionCurrent(before,after,transaction))return null;
  const language=alignment.language,sourceIds=alignment.sourceSegmentIds,unitIds=alignment.translationUnitIds;
  const registered=(before.alignments||[]).filter(other=>validId(alignment.alignmentId)&&other.alignmentId===alignment.alignmentId&&other.language===language&&same(other.sourceSegmentIds,sourceIds)&&same(other.translationUnitIds,unitIds));
  if(registered.length!==1||!active(registered[0]))return null;
  const overlapping=(before.alignments||[]).filter(other=>other!==registered[0]&&active(other)&&other.language===language&&((other.sourceSegmentIds||[]).some(id=>sourceIds.includes(id))||(other.translationUnitIds||[]).some(id=>unitIds.includes(id))));
  if(overlapping.length)return null;
  const edits=editsFor(before,after,transaction,sourceIds);if(!edits)return null;
  const request=(before.requests||[]).find(row=>row.requestId===edits.requestId),marker=request?.oneClickWriteback;
  if(request?.kind!=='revision'||request.mode!=='source-review'||request.status!=='completed'||request.projectId!==before.project.id||request.snapshotId!==transaction.baseSnapshotId||request.language!==language||!Array.isArray(request.segmentIds)||sourceIds.some(id=>!request.segmentIds.includes(id))||marker?.schemaVersion!==1||marker.mode!=='author-approved-free-source'||!validId(marker.taskId)||!validHash(marker.scopeHash))return null;
  const grants=transaction.authorDraftAcceptances??[transaction.authorDraftAcceptance];
  if(!Array.isArray(grants))return null;const matches=grants.filter(row=>row?.requestId===request.requestId);if(matches.length!==1)return null;const grant=matches[0];
  if(grant.schemaVersion!==1||grant.taskId!==marker.taskId||grant.scopeHash!==marker.scopeHash||grant.projectId!==before.project.id||grant.baseSnapshotId!==transaction.baseSnapshotId||grant.language!==language||!Array.isArray(grant.drafts)||grant.drafts.length>MAX_ENDPOINTS||new Set(grant.drafts.map(row=>row.segmentId)).size!==grant.drafts.length)return null;
  const units=[];let total=0;
  for(const id of unitIds){
   const item=endpoint(before,language,id),draft=item?.draft,current=item&&after[item.namespace]?.[language]?.[id],given=grant.drafts.find(row=>row.segmentId===id),primarySourceId=sourceIds.includes(id)?id:sourceIds[0];
   // A newly authorized free-source task binds the current source inventory,
   // even if this saved author's older baseline was already stale at the click.
   // The exact before/after draft fingerprint still forbids mid-flight changes.
   if(!draft||!current||!given||fingerprint(current)!==fingerprint(draft)||!Number.isSafeInteger(draft.revision)||draft.revision<1||draft.revision>=Number.MAX_SAFE_INTEGER||typeof draft.text!=='string'||(total+=Buffer.byteLength(draft.text))>MAX_TEXT||!same(draft.sourceSegmentIds,sourceIds)||given.revision!==draft.revision||given.textHash!==sha256(draft.text)||!sameIds(given.sourceSegmentIds,sourceIds)||!sameHashes(given.beforeSourceHashes,sourceIds,edits.oldSources)||given.beforeSourceHash!==(sourceIds.length===1?hash(edits.oldSources.get(sourceIds[0])):null)||request.translationUnitRevisions?.[id]!==draft.revision)return null;
   units.push({id,namespace:item.namespace,draft,current,primarySourceId});
  }
  const combined=units.map(unit=>unit.draft.text).join('\n\n'),revision=Math.max(...units.map(unit=>unit.draft.revision));
  for(const id of sourceIds){
   const selected=request.segments?.filter(row=>(row.segmentId||row.id)===id);if(selected?.length!==1)return null;const row=selected[0],captured=row.translationDraft,review=row.draftReview,oldSource=edits.oldSources.get(id);
   const authority=row.sourceAuthority,bounds=authority||row;
   if(authority&&(authority.kind!=='source-review-range-v1'||authority.projectId!==before.project.id||authority.snapshotId!==transaction.baseSnapshotId||authority.path!==oldSource.path||authority.beforeHash!==hash(oldSource)))return null;
   if(hash(row)!==hash(oldSource)||row.path!==oldSource.path||bounds.startByte!==oldSource.startByte||bounds.endByte!==oldSource.endByte||row.startByte!==undefined&&row.startByte!==oldSource.startByte||row.endByte!==undefined&&row.endByte!==oldSource.endByte||['text','rawSource','originalSource'].some(name=>row[name]!==undefined&&row[name]!==oldSource.source)||captured?.text!==combined||captured.revision!==revision||!same(captured.translationUnitIds,unitIds)||review?.mode!=='raw-tex-source-review'||review.draftRevision!==revision||review.draftHash!==sha256(combined)||review.sourceHash!==hash(oldSource))return null;
  }
  return{alignment,language,sourceIds:[...sourceIds],unitIds:[...unitIds],request,grant,units,sourceProofs:edits.proofs,sourceHashes:Object.fromEntries(sourceIds.map(id=>[id,hash(edits.sources.get(id))])),beforeSourceHashes:Object.fromEntries(sourceIds.map(id=>[id,hash(edits.oldSources.get(id))]))};
 }catch{return null;}
}
function acceptedRows(proof,after,transaction,at){
 return proof.units.map(unit=>{
  const beforeDraft=copy(unit.draft),afterDraft=copy(beforeDraft);for(const field of [...INTENT_FIELDS,'sourceWritebackReceipt','sourceApplied'])delete afterDraft[field];
  const revision=beforeDraft.revision+1,sourceHash=proof.sourceHashes[unit.primarySourceId];
  Object.assign(afterDraft,{revision,sourceHash,sourceHashes:copy(proof.sourceHashes),status:'saved',updatedAt:at,sourceApplied:true});
  afterDraft.sourceWritebackReceipt={schemaVersion:2,projectId:after.project.id,language:proof.language,segmentId:unit.id,transactionId:transaction.transactionId,revision,sourceHash,sourceApplied:true,mode:'author-approved-free-source',taskId:proof.grant.taskId,scopeHash:proof.grant.scopeHash,requestId:proof.request.requestId,candidateHash:transaction.candidateHash,buildId:transaction.buildId,baseSnapshotId:transaction.baseSnapshotId,appliedSnapshotId:after.project.snapshotId,capturedDraftRevision:beforeDraft.revision,draftHash:sha256(beforeDraft.text),beforeSourceHash:proof.beforeSourceHashes[unit.primarySourceId],beforeSourceHashes:copy(proof.beforeSourceHashes),primarySourceId:unit.primarySourceId,sourceSegmentIds:[...proof.sourceIds],translationUnitIds:[...proof.unitIds],sourceProofs:copy(proof.sourceProofs),sourceHashes:copy(proof.sourceHashes)};
  return{namespace:unit.namespace,language:proof.language,segmentId:unit.id,beforeDraft,beforeHash:fingerprint(beforeDraft),afterDraft,afterHash:fingerprint(afterDraft)};
 });
}
export function rebaseAlignedAuthorDrafts({before,after,transaction,at=new Date().toISOString()}){
 const rows=[],handledKeys=new Set();
 for(const alignment of before.alignments||[]){rememberEndpoints(handledKeys,before,alignment);const proof=validateAlignedAuthorGrant({before,after,transaction,alignment});if(proof)rows.push(...acceptedRows(proof,after,transaction,at));}
 return{rows,handledKeys};
}
function ledgerCurrent(transaction,after){const ledger=transaction?.draftRebases;return ledger?.schemaVersion===1&&ledger.projectId===after.project?.id&&ledger.baseSnapshotId===transaction.baseSnapshotId&&ledger.afterSnapshotId===after.project?.snapshotId&&Array.isArray(ledger.rows)&&ledger.rows.length<=MAX_ENDPOINTS?ledger:null;}
function sameGroup(receipt,other){return groupReceipt(other)&&receipt.language===other.language&&same(receipt.sourceSegmentIds,other.sourceSegmentIds)&&same(receipt.translationUnitIds,other.translationUnitIds);}
function ledgerGroupRows(ledger,receipt){
 const result=[];for(const id of receipt.translationUnitIds){const matching=ledger.rows.filter(row=>row.language===receipt.language&&row.segmentId===id&&sameGroup(receipt,row.afterDraft?.sourceWritebackReceipt));if(matching.length!==1)return null;result.push(matching[0]);}return result;
}
function restoreDrafts(state,rows,which){for(const row of rows){state[row.namespace]||={};state[row.namespace][row.language]||={};state[row.namespace][row.language][row.segmentId]=copy(row[which]);}}
function validRows(rows){return rows.every(row=>NAMESPACES.includes(row.namespace)&&validId(row.language)&&validId(row.segmentId)&&row.beforeHash===fingerprint(row.beforeDraft)&&row.afterHash===fingerprint(row.afterDraft)&&row.beforeDraft?.text===row.afterDraft?.text&&Number.isSafeInteger(row.beforeDraft?.revision)&&row.beforeDraft.revision>=1&&row.afterDraft?.revision===row.beforeDraft.revision+1);}
function currentRows(after,rows){return rows.every(row=>{const current=after[row.namespace]?.[row.language]?.[row.segmentId],value=current&&fingerprint(current);return value===row.beforeHash||value===row.afterHash;});}
function recoverOriginalSources(before,transaction,sourceIds){
 const original=copy(before),recovered=new Map();original.project.snapshotId=transaction.baseSnapshotId;
 for(const id of sourceIds){
  const matches=(before.proposals||[]).filter(proposal=>transaction.proposalIds.includes(proposal.proposalId)).flatMap(proposal=>(proposal.edits||[]).filter(edit=>edit.segmentId===id).map(edit=>({proposal,edit})));
  if(!matches.length){
   // Actual app undo proposals replace whole files. The transaction's retained
   // before anchors pin the source interval inside those exact inverse bytes.
   const files=wholeInverseFiles({...before,project:{...before.project,files:undefined}},null,transaction),anchors=[...(transaction.beforeReadingAnchors||[]),...(transaction.beforeSegments||[])].filter(row=>row.id===id),anchor=anchors[0],file=files?.get(anchor?.path);
   if(!anchor||!file||anchors.some(row=>row.path!==anchor.path||row.startByte!==anchor.startByte||row.endByte!==anchor.endByte||hash(row)!==hash(anchor))||!Number.isSafeInteger(anchor.startByte)||!Number.isSafeInteger(anchor.endByte)||anchor.startByte<0||anchor.endByte>file.before.length)return null;
   const bytes=file.before.subarray(anchor.startByte,anchor.endByte).toString('utf8');if(sha256(bytes)!==hash(anchor))return null;
   recovered.set(id,{...sourceIndex(before).get(id),id,path:anchor.path,startByte:anchor.startByte,endByte:anchor.endByte,source:bytes,displayText:bytes,sourceHash:hash(anchor),beforeHash:hash(anchor)});continue;
  }
  if(matches.length!==1)return null;
  const {proposal,edit}=matches[0],request=before.requests?.find(row=>row.requestId===proposal.context?.requestId),selected=request?.segments?.find(row=>(row.segmentId||row.id)===id),bytes=edit.before??selected?.rawSource??selected?.originalSource??selected?.source;
  if(typeof bytes!=='string'||sha256(bytes)!==edit.beforeHash||Buffer.byteLength(bytes)!==edit.endByte-edit.startByte||['rawSource','originalSource','source'].some(name=>selected?.[name]!==undefined&&selected[name]!==bytes))return null;
  recovered.set(id,{...sourceIndex(before).get(id),id,path:edit.path,startByte:edit.startByte,endByte:edit.endByte,source:bytes,displayText:bytes,sourceHash:edit.beforeHash,beforeHash:edit.beforeHash});
 }
 for(const namespace of['segments','readingParagraphs'])if(original[namespace])original[namespace]=original[namespace].map(source=>recovered.get(source.id)||source);
 return original;
}

/** Replay is admitted for a complete still-current group, including siblings
 * already replayed by this same ledger. No caller state is modified. */
export function validateAlignedReplayRow(row,{before,after,transaction,undoTransaction=null}){
 try{
  const ledger=ledgerCurrent(transaction,after),receipt=row.afterDraft?.sourceWritebackReceipt;if(!ledger)return false;
  if(!groupReceipt(receipt)){
   if(!groupReceipt(row.beforeDraft?.sourceWritebackReceipt)||!undoTransaction)return false;
   const group=row.beforeDraft.sourceWritebackReceipt,rows=ledger.rows.filter(item=>item.language===row.language&&group.translationUnitIds.includes(item.segmentId));if(rows.length!==group.translationUnitIds.length||!validRows(rows)||!currentRows(after,rows))return false;
   const original=recoverOriginalSources(before,transaction,group.sourceSegmentIds),restored=copy(after);if(!original)return false;restoreDrafts(original,rows,'beforeDraft');restoreDrafts(restored,rows,'beforeDraft');const expected=rebaseAlignedUndoDrafts({before:original,after:restored,transaction,undoTransaction,at:row.afterDraft.updatedAt}).rows;
   return rows.every(item=>expected.some(candidate=>same(item,candidate)))&&rows.some(item=>same(item,row));
  }
  const rows=ledgerGroupRows(ledger,receipt);if(!rows||!validRows(rows)||!currentRows(after,rows)||!rows.some(item=>same(item,row)))return false;
  const alignment=(before.alignments||[]).find(item=>item.language===receipt.language&&same(item.sourceSegmentIds,receipt.sourceSegmentIds)&&same(item.translationUnitIds,receipt.translationUnitIds));if(!alignment)return false;
  const original=recoverOriginalSources(before,transaction,receipt.sourceSegmentIds),restored=copy(after);if(!original)return false;restoreDrafts(original,rows,'beforeDraft');restoreDrafts(restored,rows,'beforeDraft');
  const proof=validateAlignedAuthorGrant({before:original,after:restored,transaction,alignment});if(!proof)return false;
  const expected=acceptedRows(proof,after,transaction,row.afterDraft.updatedAt);return rows.length===expected.length&&rows.every(item=>expected.some(candidate=>same(item,candidate)));
 }catch{return false;}
}

/** An exact inverse restores each captured pending intent, never a later
 * editor revision. The caller must separately prove the physical inverse. */
export function rebaseAlignedUndoDrafts({before,after,transaction,undoTransaction,at=new Date().toISOString()}){
 const rows=[],handledKeys=new Set();
 try{
  const oldLedger=undoTransaction?.draftRebases;if(!oldLedger||oldLedger.schemaVersion!==1||!Array.isArray(oldLedger.rows)||oldLedger.rows.length>MAX_ENDPOINTS)return{rows,handledKeys};
  const receipts=oldLedger.rows.map(row=>row.afterDraft?.sourceWritebackReceipt).filter(groupReceipt),seen=new Set();
  for(const received of receipts){
   const groupKey=JSON.stringify([received.language,received.sourceSegmentIds,received.translationUnitIds]);if(seen.has(groupKey))continue;seen.add(groupKey);
   const alignment=(before.alignments||[]).find(item=>item.language===received.language&&same(item.sourceSegmentIds,received.sourceSegmentIds)&&same(item.translationUnitIds,received.translationUnitIds));
   if(alignment)rememberEndpoints(handledKeys,before,alignment);
   if(!alignment||!active(alignment)||!transactionCurrent(before,after,transaction)||undoTransaction.projectId!==before.project.id||undoTransaction.state!=='applied'||undoTransaction.revertedBy&&undoTransaction.revertedBy!==transaction.transactionId||oldLedger.projectId!==before.project.id||oldLedger.baseSnapshotId!==undoTransaction.baseSnapshotId||oldLedger.afterSnapshotId!==undoTransaction.afterSnapshotId)continue;
   const groupRows=ledgerGroupRows(oldLedger,received);if(!groupRows||!validRows(groupRows)||groupRows.some(row=>fingerprint(before[row.namespace]?.[row.language]?.[row.segmentId])!==row.afterHash||fingerprint(after[row.namespace]?.[row.language]?.[row.segmentId])!==row.afterHash))continue;
   if(groupRows.some(row=>row.afterDraft.revision>=Number.MAX_SAFE_INTEGER))continue;
   const inverse=inverseEditsFor(before,after,transaction,received.sourceSegmentIds,undoTransaction.transactionId);if(!inverse||!sameHashes(received.beforeSourceHashes,received.sourceSegmentIds,inverse.sources)||!sameHashes(received.sourceHashes,received.sourceSegmentIds,inverse.oldSources))continue;
   const priorBefore=copy(before),priorAfter=copy(before);priorBefore.project.snapshotId=undoTransaction.baseSnapshotId;priorAfter.project.snapshotId=oldLedger.afterSnapshotId;
   for(const namespace of['segments','readingParagraphs'])if(priorBefore[namespace])priorBefore[namespace]=priorBefore[namespace].map(source=>inverse.sources.has(source.id)?copy(inverse.sources.get(source.id)):source);
   restoreDrafts(priorBefore,groupRows,'beforeDraft');restoreDrafts(priorAfter,groupRows,'beforeDraft');
   const proof=validateAlignedAuthorGrant({before:priorBefore,after:priorAfter,transaction:undoTransaction,alignment});
   if(!proof)continue;const expected=acceptedRows(proof,priorAfter,undoTransaction,groupRows[0].afterDraft.updatedAt);if(!groupRows.every(row=>expected.some(candidate=>same(row,candidate))))continue;
   for(const old of groupRows){
    const beforeDraft=copy(before[old.namespace][old.language][old.segmentId]),afterDraft=copy(old.beforeDraft),primary=old.afterDraft.sourceWritebackReceipt.primarySourceId;
    delete afterDraft.sourceWritebackReceipt;delete afterDraft.sourceApplied;Object.assign(afterDraft,{revision:beforeDraft.revision+1,sourceHash:hash(inverse.sources.get(primary)),sourceHashes:copy(received.beforeSourceHashes),status:'saved',updatedAt:at});
    rows.push({namespace:old.namespace,language:old.language,segmentId:old.segmentId,beforeDraft,beforeHash:fingerprint(beforeDraft),afterDraft,afterHash:fingerprint(afterDraft)});
   }
  }
 }catch{return{rows:[],handledKeys};}
 return{rows,handledKeys};
}
