import {createHash} from 'node:crypto';
import {createReviewCompletionContext,deriveReviewCompletion,reviewConcernHash} from './review-completion.mjs';

const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const normalized=value=>typeof value==='string'?value.replaceAll('\r\n','\n').trim():'';
const sha=value=>createHash('sha256').update(value).digest('hex');

/** A review file is immutable across paper snapshots. Reuse retained identities
 * instead of turning a source edit into a second import or restored opinions. */
export function findExistingReviewImport(raw,incomingBatch,normalizedHash){
 const candidates=(raw.reviewBatches||[]).filter(batch=>batch.origin==='external'&&batch.format===incomingBatch.format&&batch.fileHash?.toLowerCase()===incomingBatch.fileHash?.toLowerCase());
 if(candidates.some(batch=>batch.normalizedHash!==normalizedHash))fail('IDEMPOTENCY_CONFLICT','The same uploaded digest returned different normalized review data.');
 const records=[...(raw.reviewNotes||[]),...(raw.reviewHistory||[])];
 const matches=candidates.filter(batch=>{
  const notes=records.filter(note=>note.batchId===batch.batchId),cleared=batch.clearedHistoricalCount||0;
  const explicitClear=Number.isSafeInteger(cleared)&&cleared>0&&Number.isSafeInteger(batch.retainedNoteCount)&&batch.retainedNoteCount>=0&&batch.retainedNoteCount+cleared===batch.noteCount&&Number.isFinite(Date.parse(batch.lastHistoryClearedAt));
  const retained=explicitClear?batch.retainedNoteCount:batch.noteCount;
  return batch.noteCount===incomingBatch.noteCount&&notes.length===retained&&notes.every(note=>note.origin==='external')&&new Set(notes.map(note=>note.noteId)).size===notes.length;
 });
 if(candidates.some(batch=>batch.batchId===incomingBatch.batchId)&&!matches.some(batch=>batch.batchId===incomingBatch.batchId))fail('REVIEW_IMPORT_UNAVAILABLE','The retained import identity has incomplete opinion records. Restore its records before importing the same identity again.');
 const exact=matches.find(batch=>batch.batchId===incomingBatch.batchId);
 if(exact)return exact;
 if(matches.length===1)return matches[0];
 const active=matches.filter(batch=>batch.active!==false&&batch.status!=='retired');
 if(active.length===1)return active[0];
 if(matches.length)fail('REVIEW_IMPORT_DUPLICATE_CONFLICT','Several retained imports of this same file have different histories. Choose the intended retained import before importing it again.');
 return null;
}

/** Same paragraph numbers or review codes alone never close a new concern.
 * Only exact original meaning plus historical source/file evidence can inherit
 * a completion that the transaction layer still independently verifies. */
export function linkCompletedReviewImports(notes,raw,state,incomingBatch,options={}){
 const originals=[...(raw.reviewNotes||[]),...(raw.reviewHistory||[])],transactions=options.transactions||state.transactions||[],proposals=options.proposals||raw.proposals||state.proposals||[];
 const context={...state,reviewNotes:originals,reviewHistory:[]},evidenceOptions={transactions,proposals,notes:originals};
 evidenceOptions.completionContext=createReviewCompletionContext(context,evidenceOptions);
 const batches=new Map((raw.reviewBatches||[]).map(batch=>[batch.batchId,batch])),byConcern=new Map(),originalIds=new Set(originals.map(note=>JSON.stringify([note.noteId,note.batchId]))),ledgerByConcern=new Map();
 for(const note of originals){const proof=deriveReviewCompletion(note,context,evidenceOptions);if(!proof.completed)continue;const key=reviewConcernHash(note);if(!byConcern.has(key))byConcern.set(key,[]);byConcern.get(key).push({note,proof,fileHash:batches.get(note.batchId)?.fileHash});}
 for(const transaction of transactions)for(const evidence of transaction.reviewCompletions||[]){if(originalIds.has(JSON.stringify([evidence.sourceNoteId,evidence.sourceBatchId])))continue;if(!ledgerByConcern.has(evidence.concernHash))ledgerByConcern.set(evidence.concernHash,[]);ledgerByConcern.get(evidence.concernHash).push(evidence);}
 const sources=new Map();for(const source of [...(state.readingParagraphs||[]),...(state.segments||[])])if(!sources.has(source.id))sources.set(source.id,source);
 const currentTexts=[...sources.values()].map(source=>normalized(source.source)),quoteCache=new Map(),currentHas=quote=>{if(!quoteCache.has(quote))quoteCache.set(quote,currentTexts.some(text=>text.includes(quote)));return quoteCache.get(quote);};
 const editsFor=proof=>proof.paragraphs.map(paragraph=>proposals.find(proposal=>proposal.proposalId===paragraph.proposalId)?.edits?.find(edit=>edit.segmentId===paragraph.sourceSegmentId&&edit.beforeHash===paragraph.beforeHash)).filter(Boolean);
 return notes.map(note=>{
  if(note.origin!=='external')return note;
  const concernHash=reviewConcernHash(note),rows=[...(byConcern.get(concernHash)||[])];
  // A captured adoption survives removal of the old imported file. It remains
  // inert unless its actual transaction, exact edits and current source prove it.
  for(const evidence of ledgerByConcern.get(concernHash)||[]){
   const retained={...note,noteId:evidence.sourceNoteId,batchId:evidence.sourceBatchId};delete retained.priorReviewCompletion;
   const proof=deriveReviewCompletion(retained,context,evidenceOptions);if(proof.completed)rows.push({note:retained,proof,fileHash:evidence.sourceFileHash});
  }
  const matches=rows.filter(row=>{
   if(reviewConcernHash(row.note)!==concernHash)return false;
   const paragraphs=row.proof.paragraphs,ids=new Set(paragraphs.map(p=>p.sourceSegmentId)),edits=editsFor(row.proof);
   const sameFile=row.fileHash&&row.fileHash.toLowerCase()===incomingBatch.fileHash?.toLowerCase();
   if(sameFile)return true;
   if((note.sourceSegmentIds||[]).some(id=>!ids.has(id))||Object.entries(note.sourceHashes||{}).some(([id,value])=>paragraphs.some(p=>p.sourceSegmentId===id&&p.afterHash===value&&p.beforeHash!==value)))return false;
   const imported=normalized(note.currentSource),quote=normalized(note.quote);
   if(imported&&paragraphs.some(p=>normalized(sources.get(p.sourceSegmentId)?.source)===imported))return false;
   if(imported&&edits.some(edit=>normalized(edit.before)===imported))return !quote||edits.some(edit=>normalized(edit.before).includes(quote));
   return quote.length>=40&&edits.some(edit=>normalized(edit.before).includes(quote))&&!currentHas(quote);
  });
  const proofs=new Map(matches.map(row=>[JSON.stringify(row.proof.paragraphs.map(p=>[p.sourceSegmentId,p.beforeHash,p.afterHash,p.transactionId]).toSorted()),row]));
  if(proofs.size!==1)return note;
  const {note:original,proof}=proofs.values().next().value;
  return {...note,priorReviewCompletion:{sourceNoteId:original.noteId,sourceBatchId:original.batchId,concernHash,transactionId:proof.transactionIds[0]},importContinuity:{schemaVersion:1,method:'exact-old-concern-and-verified-write',sourceContextHash:sha(normalized(note.currentSource)||normalized(note.quote)),sourceFileHash:incomingBatch.fileHash}};
 });
}
