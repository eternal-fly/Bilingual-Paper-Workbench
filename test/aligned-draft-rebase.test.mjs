import test from 'node:test';
import assert from 'node:assert/strict';
import {sha256} from '../src/latex.mjs';
import {rebaseAlignedAuthorDrafts,rebaseAlignedUndoDrafts,validateAlignedReplayRow} from '../src/aligned-draft-rebase.mjs';
const clone=value=>structuredClone(value),fingerprint=value=>sha256(JSON.stringify({...value,status:null}));

function fixture(many=false){
 const sourceIds=many?['a','b']:['a'],unitIds=many?['a']:['a','split-unit'],language='zh-CN';
 const sources=sourceIds.map((id,i)=>{const source=`Original ${id}.`;return{id,path:'main.tex',source,sourceHash:sha256(source),beforeHash:sha256(source),startByte:i*64,endByte:i*64+Buffer.byteLength(source)};});
 const hashes=Object.fromEntries(sources.map(s=>[s.id,s.sourceHash])),drafts=Object.fromEntries(unitIds.map((id,i)=>[id,{text:`作者完整意图 ${i}。`,revision:4+i,origin:'human',status:'saved',sourceHash:hashes.a,sourceHashes:clone(hashes),sourceSegmentIds:sourceIds,unitKind:many?'merged':'split',sourceReviewRequired:true,sourceReviewDiagnostics:[{code:'RAW_SOURCE_REVIEW_DRAFT_PENDING'}],inlineStructureConflict:true}]));
 const text=unitIds.map(id=>drafts[id].text).join('\n\n'),revision=Math.max(...unitIds.map(id=>drafts[id].revision)),alignment={alignmentId:'alignment',language,sourceSegmentIds:sourceIds,translationUnitIds:unitIds,status:'confirmed',stale:false};
 const request={requestId:'request',kind:'revision',mode:'source-review',status:'completed',projectId:'project',snapshotId:'before',language,segmentIds:sourceIds,translationUnitRevisions:Object.fromEntries(unitIds.map(id=>[id,drafts[id].revision])),oneClickWriteback:{schemaVersion:1,taskId:'task',mode:'author-approved-free-source',scopeHash:'d'.repeat(64)},segments:sources.map(s=>({...s,id:s.id,segmentId:s.id,text:s.source,rawSource:s.source,translationDraft:{text,revision,translationUnitIds:unitIds},draftReview:{mode:'raw-tex-source-review',draftRevision:revision,draftHash:sha256(text),sourceHash:s.sourceHash}}))};
 const proposal={proposalId:'proposal',projectId:'project',baseSnapshotId:'before',context:{requestId:request.requestId,mode:'source-review'},edits:sources.map(s=>({segmentId:s.id,path:s.path,startByte:s.startByte,endByte:s.endByte,beforeHash:s.sourceHash,before:s.source,replacement:`Revised ${s.id}.`}))};
 const transaction={transactionId:'transaction',projectId:'project',baseSnapshotId:'before',state:'committing',proposalIds:[proposal.proposalId],candidateHash:'c'.repeat(64),buildId:'build',authorDraftAcceptance:{schemaVersion:1,taskId:'task',requestId:request.requestId,scopeHash:'d'.repeat(64),projectId:'project',baseSnapshotId:'before',language,drafts:unitIds.map(id=>({segmentId:id,revision:drafts[id].revision,textHash:sha256(drafts[id].text),sourceSegmentIds:sourceIds,beforeSourceHashes:clone(hashes),beforeSourceHash:many?null:hashes.a}))}};
 const before={project:{id:'project',snapshotId:'before'},segments:sources,readingParagraphs:[],translations:{[language]:drafts},alignments:[alignment],requests:[request],proposals:[proposal]},after=clone(before);after.project.snapshotId='after';for(const s of after.segments){s.source=proposal.edits.find(e=>e.segmentId===s.id).replacement;s.sourceHash=s.beforeHash=sha256(s.source);s.endByte=s.startByte+Buffer.byteLength(s.source);}
 const run=()=>rebaseAlignedAuthorDrafts({before,after,transaction,at:'synthetic-time'});
 const ledger=rows=>{transaction.draftRebases={schemaVersion:1,projectId:'project',baseSnapshotId:'before',afterSnapshotId:'after',rows:clone(rows)};};
 return{before,after,transaction,sourceIds,unitIds,language,run,ledger};
}
function applyRows(state,rows){for(const row of rows){state[row.namespace]||={};state[row.namespace][row.language]||={};state[row.namespace][row.language][row.segmentId]=clone(row.afterDraft);}}

for(const many of[false,true])test(`complete ${many?'many-to-one':'one-to-many'} proof acknowledges every exact unit without mutating input state`,()=>{
 const f=fixture(many),saved=clone(f.after),result=f.run();assert.equal(result.rows.length,f.unitIds.length);assert.deepEqual(f.after,saved);
 for(const row of result.rows){const old=f.before[row.namespace][row.language][row.segmentId],d=row.afterDraft,r=d.sourceWritebackReceipt;assert(result.handledKeys.has(`${row.namespace}\0${row.language}\0${row.segmentId}`));assert.equal(row.beforeHash,fingerprint(old));assert.equal(row.afterHash,fingerprint(d));assert.equal(d.text,old.text);assert.equal(d.revision,old.revision+1);assert.equal(d.sourceReviewRequired,undefined);assert.equal(d.inlineStructureConflict,undefined);assert.equal(d.sourceApplied,true);assert.equal(r.schemaVersion,2);assert.equal(r.taskId,'task');assert.equal(r.requestId,'request');assert.equal(r.capturedDraftRevision,old.revision);assert.equal(r.draftHash,sha256(old.text));assert.deepEqual(r.sourceSegmentIds,f.sourceIds);assert.deepEqual(r.translationUnitIds,f.unitIds);assert.equal(r.sourceProofs.length,f.sourceIds.length);}
});

test('an exact new author task may replace a pre-click stale unit baseline but never stale grant hashes or later typing',()=>{
 for(const many of[false,true]){
  const f=fixture(many);for(const state of[f.before,f.after])for(const id of f.unitIds)Object.assign(state.translations[f.language][id],{status:'stale',sourceHash:'e'.repeat(64),sourceHashes:Object.fromEntries(f.sourceIds.map(sourceId=>[sourceId,'e'.repeat(64)]))});
  const result=f.run();assert.equal(result.rows.length,f.unitIds.length);for(const row of result.rows){assert.equal(row.afterDraft.status,'saved');assert.equal(row.afterDraft.sourceApplied,true);assert.notEqual(row.afterDraft.sourceHash,'e'.repeat(64));}
  f.transaction.authorDraftAcceptance.drafts[0].beforeSourceHashes[f.sourceIds[0]]='e'.repeat(64);assert.equal(f.run().rows.length,0);
  f.transaction.authorDraftAcceptance.drafts[0].beforeSourceHashes[f.sourceIds[0]]=f.before.segments.find(row=>row.id===f.sourceIds[0]).sourceHash;f.after.translations[f.language][f.unitIds.at(-1)].text+=' later typing';assert.equal(f.run().rows.length,0);
 }
});

test('a changed endpoint grant capture source or transaction denies the complete group without a scalar fallback',()=>{
 const changes=[f=>f.after.translations[f.language][f.unitIds.at(-1)].text+=' typing',f=>f.after.translations[f.language].a.revision++,f=>f.before.alignments[0].stale=true,f=>f.transaction.authorDraftAcceptance.drafts.pop(),f=>f.transaction.authorDraftAcceptance.drafts[0].textHash='e'.repeat(64),f=>f.transaction.authorDraftAcceptance.drafts[0].beforeSourceHashes.a='e'.repeat(64),f=>f.before.proposals[0].edits.pop(),f=>f.before.requests[0].segments[0].translationDraft.text+=' foreign',f=>f.before.requests[0].translationUnitRevisions.a++,f=>f.transaction.state='ready',f=>f.transaction.sourceChangedAgain=true,f=>f.after.segments[0].source+=' drift',f=>f.before.alignments.push({...clone(f.before.alignments[0]),alignmentId:'ambiguous'})];
 for(const change of changes){const f=fixture();change(f);const result=f.run();assert.equal(result.rows.length,0);for(const id of f.unitIds)assert(result.handledKeys.has(`translations\0${f.language}\0${id}`));}
});

test('the scalar same-ID route is excluded and mixed draft namespaces retain their exact identity',()=>{
 const f=fixture();f.before.alignments[0].translationUnitIds=['a'];assert.equal(f.run().rows.length,0);assert.equal(f.run().handledKeys.size,0);
 const mixed=fixture();for(const state of[mixed.before,mixed.after]){state.readingDrafts={[mixed.language]:{'split-unit':state.translations[mixed.language]['split-unit']}};delete state.translations[mixed.language]['split-unit'];}
 const result=mixed.run();assert.equal(result.rows.length,2);assert.equal(result.rows.find(r=>r.segmentId==='split-unit').namespace,'readingDrafts');
});

test('real core raw selection positions are read from the registered source authority',()=>{
 const f=fixture();for(const selected of f.before.requests[0].segments){selected.sourceAuthority={kind:'source-review-range-v1',projectId:'project',snapshotId:'before',manifestHash:'m'.repeat(64),path:selected.path,beforeHash:selected.sourceHash,startByte:selected.startByte,endByte:selected.endByte};delete selected.startByte;delete selected.endByte;}
 assert.equal(f.run().rows.length,2);
 f.before.requests[0].segments[0].sourceAuthority.startByte++;assert.equal(f.run().rows.length,0);
});

test('grant source inventories are exact sets while receipt and translation-unit order remain explicit',()=>{
 const f=fixture(true),ordered=['b','a'];f.before.alignments[0].sourceSegmentIds=ordered;
 for(const state of[f.before,f.after])state.translations[f.language].a.sourceSegmentIds=ordered;
 const result=f.run();assert.equal(result.rows.length,1);assert.deepEqual(result.rows[0].afterDraft.sourceWritebackReceipt.sourceSegmentIds,ordered);assert.equal(result.rows[0].afterDraft.sourceWritebackReceipt.primarySourceId,'a');
 const split=fixture();split.before.requests[0].segments[0].translationDraft.translationUnitIds.reverse();assert.equal(split.run().rows.length,0);
});

test('an exact aligned undo restores pending intent with monotonic revisions and never replaces newer typing',()=>{
 const f=fixture(),accepted=f.run();f.ledger(accepted.rows);const before=clone(f.after);applyRows(before,accepted.rows);const after=clone(before);after.project.snapshotId='undo-after';after.segments=clone(f.before.segments);
 const transaction={transactionId:'undo',projectId:'project',baseSnapshotId:'after',state:'committing',proposalIds:['undo-proposal'],candidateHash:'e'.repeat(64),buildId:'undo-build'};
 before.proposals.push({proposalId:'undo-proposal',projectId:'project',baseSnapshotId:'after',context:{undoOf:f.transaction.transactionId},edits:before.segments.map(s=>({segmentId:s.id,path:s.path,startByte:s.startByte,endByte:s.endByte,beforeHash:s.sourceHash,before:s.source,replacement:f.before.segments.find(old=>old.id===s.id).source}))});
 const run=()=>rebaseAlignedUndoDrafts({before,after,transaction,undoTransaction:{...f.transaction,state:'applied',afterSnapshotId:'after'},at:'undo-time'}),result=run();assert.equal(result.rows.length,2);
 for(const row of result.rows){assert.equal(row.afterDraft.text,f.before.translations[f.language][row.segmentId].text);assert.equal(row.afterDraft.sourceReviewRequired,true);assert.equal(row.afterDraft.inlineStructureConflict,true);assert.equal(row.afterDraft.revision,row.beforeDraft.revision+1);assert.equal(row.afterDraft.sourceApplied,undefined);assert.equal(row.afterDraft.sourceWritebackReceipt,undefined);}
 transaction.draftRebases={schemaVersion:1,projectId:'project',baseSnapshotId:'after',afterSnapshotId:'undo-after',rows:clone(result.rows)};
 after.proposals=clone(before.proposals);
 const reloaded=clone(after);for(const row of result.rows)assert.equal(validateAlignedReplayRow(row,{before:reloaded,after,transaction,undoTransaction:{...f.transaction,state:'applied',afterSnapshotId:'after'}}),true);
 after.translations[f.language]['split-unit'].text+=' newer';assert.equal(run().rows.length,0);
});

test('aligned ledger replay validates every group row and accepts already replayed siblings without a second increment',()=>{
 const f=fixture(),result=f.run();f.ledger(result.rows);for(const row of result.rows)assert.equal(validateAlignedReplayRow(row,{before:f.before,after:f.after,transaction:f.transaction}),true);
 applyRows(f.after,[result.rows[0]]);assert.equal(validateAlignedReplayRow(result.rows[1],{before:f.before,after:f.after,transaction:f.transaction}),true);
 const saved=clone(f.after);validateAlignedReplayRow(result.rows[1],{before:f.before,after:f.after,transaction:f.transaction});assert.deepEqual(f.after,saved);
});

test('recovery after source reload reconstructs original bounds only from the registered exact before bytes',()=>{
 const f=fixture(),result=f.run();f.ledger(result.rows);const reloaded=clone(f.after);
 for(const row of result.rows)assert.equal(validateAlignedReplayRow(row,{before:reloaded,after:f.after,transaction:f.transaction}),true);
 applyRows(reloaded,result.rows);for(const row of result.rows)assert.equal(validateAlignedReplayRow(row,{before:reloaded,after:reloaded,transaction:f.transaction}),true);
 f.before.proposals[0].edits[0].before+=' foreign';const bad=clone(f.after);bad.proposals=clone(f.before.proposals);assert.equal(validateAlignedReplayRow(result.rows[0],{before:bad,after:f.after,transaction:f.transaction}),false);
});

test('tampered receipts hashes ledgers and newer sibling drafts cannot replay a group acknowledgment',()=>{
 const changes=[f=>f.transaction.draftRebases.rows[0].afterHash='f'.repeat(64),f=>f.transaction.draftRebases.rows[0].afterDraft.sourceWritebackReceipt.taskId='foreign',f=>f.transaction.draftRebases.rows.pop(),f=>f.transaction.draftRebases.afterSnapshotId='foreign',f=>f.after.translations[f.language]['split-unit'].text+=' later',f=>f.transaction.authorDraftAcceptance.drafts[0].textHash='f'.repeat(64)];
 for(const change of changes){const f=fixture(),result=f.run();f.ledger(result.rows);change(f);assert.equal(validateAlignedReplayRow(result.rows[0],{before:f.before,after:f.after,transaction:f.transaction}),false);}
});

test('an undo revision limit in one sibling denies the entire group rather than returning a partial inverse',()=>{
 const f=fixture(),id=f.unitIds.at(-1),revision=Number.MAX_SAFE_INTEGER-1;
 for(const state of[f.before,f.after])state.translations[f.language][id].revision=revision;
 f.before.requests[0].translationUnitRevisions[id]=revision;for(const selected of f.before.requests[0].segments){selected.translationDraft.revision=revision;selected.draftReview.draftRevision=revision;}
 f.after.requests=clone(f.before.requests);
 f.transaction.authorDraftAcceptance.drafts.find(row=>row.segmentId===id).revision=revision;
 const accepted=f.run();assert.equal(accepted.rows.length,2);f.ledger(accepted.rows);const before=clone(f.after);applyRows(before,accepted.rows);const after=clone(before);after.project.snapshotId='undo-after';after.segments=clone(f.before.segments);
 const transaction={transactionId:'undo',projectId:'project',baseSnapshotId:'after',state:'committing',proposalIds:['undo-proposal'],candidateHash:'e'.repeat(64),buildId:'undo-build'};
 before.proposals.push({proposalId:'undo-proposal',projectId:'project',baseSnapshotId:'after',context:{undoOf:f.transaction.transactionId},edits:before.segments.map(s=>({segmentId:s.id,path:s.path,startByte:s.startByte,endByte:s.endByte,beforeHash:s.sourceHash,replacement:f.before.segments.find(old=>old.id===s.id).source}))});
 const result=rebaseAlignedUndoDrafts({before,after,transaction,undoTransaction:{...f.transaction,state:'applied',afterSnapshotId:'after'}});assert.equal(result.rows.length,0);
});

for(const many of[false,true])test(`an actual whole-file inverse restores ${many?'merged':'split'} intent using exact source byte bounds`,()=>{
 const f=fixture(many),accepted=f.run();f.ledger(accepted.rows);const before=clone(f.after);applyRows(before,accepted.rows);const after=clone(before);after.project.snapshotId='undo-after';after.segments=clone(f.before.segments);
 const file=sources=>{let text='';for(const source of [...sources].sort((a,b)=>a.startByte-b.startByte)){text+=' '.repeat(source.startByte-Buffer.byteLength(text))+source.source;}return text+'\nTAIL';},previous=file(before.segments),restored=file(after.segments);
 const inverse={proposalId:'undo-file',projectId:'project',baseSnapshotId:'after',context:{undoOf:f.transaction.transactionId},edits:[{path:'main.tex',startByte:0,endByte:Buffer.byteLength(previous),beforeHash:sha256(previous),before:previous,replacement:restored}]};before.proposals.push(inverse);after.proposals=clone(before.proposals);
 const transaction={transactionId:'undo',projectId:'project',baseSnapshotId:'after',state:'committing',proposalIds:[inverse.proposalId],candidateHash:'e'.repeat(64),buildId:'undo-build',readSet:[{path:'main.tex',hash:sha256(previous)}],candidate:{files:[{path:'main.tex',content:restored,hash:sha256(restored),beforeHash:sha256(previous)}]},beforeSegments:before.segments.map(({id,path,startByte,endByte,beforeHash})=>({id,path,startByte,endByte,beforeHash}))},undoTransaction={...f.transaction,state:'applied',afterSnapshotId:'after'};
 const run=()=>rebaseAlignedUndoDrafts({before,after,transaction,undoTransaction,at:'undo-time'}),result=run();assert.equal(result.rows.length,f.unitIds.length);assert(result.rows.every(row=>!row.afterDraft.sourceApplied));
 transaction.draftRebases={schemaVersion:1,projectId:'project',baseSnapshotId:'after',afterSnapshotId:'undo-after',rows:clone(result.rows)};const reloaded=clone(after);for(const row of result.rows)assert.equal(validateAlignedReplayRow(row,{before:reloaded,after,transaction,undoTransaction}),true);
 inverse.edits[0].replacement+=' foreign';assert.equal(run().rows.length,0);
});
