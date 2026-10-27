import test from 'node:test';
import assert from 'node:assert/strict';
import {sha256} from '../src/latex.mjs';
import * as rebase from '../src/draft-source-rebase.mjs';
import * as writeback from '../ui/writeback-state.mjs';
import {deriveReviewCompletion} from '../src/review-completion.mjs';
const {rebaseConfirmedTranslationDrafts}=rebase,{deriveEnglishWriteback}=writeback;

const clone=value=>structuredClone(value);
function fixture(){
 const language='zh-CN',id='paragraph',original='An original claim.',replacement='An author-revised claim with $x=2$.',oldHash=sha256(original),newHash=sha256(replacement);
 const source={id,path:'main.tex',startByte:0,endByte:Buffer.byteLength(original),source:original,displayText:original,sourceHash:oldHash,beforeHash:oldHash,protectedTokens:[],translatable:true,writableSource:true,sourceReviewAvailable:true};
 const draft={text:String.raw`完整作者意图 \Unresolved{新定义} 和 $x=2$。`,revision:4,origin:'human',status:'saved',sourceHash:oldHash,sourceReviewRequired:true,sourceReviewDiagnostics:[{code:'UNSUPPORTED_TEX',message:'Retain this exact raw draft.'}]};
 const selected={id,segmentId:id,text:original,sourceHash:oldHash,beforeHash:oldHash,translationDraft:clone(draft),draftReview:{mode:'raw-tex-source-review',draftRevision:draft.revision,draftHash:sha256(draft.text),sourceHash:oldHash}};
 const request={requestId:'request',kind:'revision',mode:'source-review',status:'completed',projectId:'project',snapshotId:'before',language,draftRevisions:{[id]:draft.revision},segments:[selected],oneClickWriteback:{schemaVersion:1,taskId:'writeback-task',mode:'author-approved-free-source',scopeHash:'d'.repeat(64)}};
 const proposal={proposalId:'proposal',projectId:'project',baseSnapshotId:'before',reviewState:'pending',applicationState:'notApplied',context:{requestId:request.requestId,mode:'source-review'},edits:[{segmentId:id,path:source.path,startByte:source.startByte,endByte:source.endByte,beforeHash:oldHash,replacement}]};
 const transaction={transactionId:'transaction',projectId:'project',baseSnapshotId:'before',state:'committing',proposalIds:[proposal.proposalId],candidateHash:'c'.repeat(64),buildId:'build',authorDraftAcceptance:{schemaVersion:1,taskId:'writeback-task',requestId:request.requestId,scopeHash:'d'.repeat(64),projectId:'project',baseSnapshotId:'before',language,drafts:[{segmentId:id,revision:draft.revision,textHash:sha256(draft.text),beforeSourceHash:oldHash}]}};
 const before={project:{id:'project',snapshotId:'before'},segments:[source],readingParagraphs:[],translations:{[language]:{[id]:draft}},requests:[request],proposals:[proposal]};
 const after=clone(before);after.project.snapshotId='after';Object.assign(after.segments[0],{source:replacement,displayText:replacement,sourceHash:newHash,beforeHash:newHash,endByte:Buffer.byteLength(replacement)});
 const registry={dynamic:{citations:new Set(),references:new Set()},counts:{citations:new Map(),references:new Map()},citationFoldCounts:new Map(),hash:'r'.repeat(64)};
 const current=()=>after.translations[language][id];
 const run=()=>rebaseConfirmedTranslationDrafts({before,after,transaction,registry,at:'2026-10-28T12:00:00.000Z'});
 const appliedState=()=>{const state=clone(after);state.transactions=[{...clone(transaction),state:'applied',afterSnapshotId:after.project.snapshotId}];state.proposals[0].applicationState='applied';state.proposals[0].transactionId=transaction.transactionId;return state;};
 return{language,id,before,after,transaction,registry,current,run,appliedState};
}

test('an exact one-click author grant consumes raw review intent only after the matching compiled source write',()=>{
 const f=fixture(),text=f.current().text;assert.equal(f.run().changed,1);const draft=f.current();
 assert.equal(draft.text,text);assert.equal(draft.revision,5);assert.equal(draft.sourceReviewRequired,undefined);assert.equal(draft.sourceReviewDiagnostics,undefined);
 assert.equal(draft.sourceApplied,true);assert.equal(draft.sourceWritebackReceipt.schemaVersion,2);assert.equal(draft.sourceWritebackReceipt.draftHash,sha256(text));assert.equal(draft.sourceWritebackReceipt.requestId,'request');assert.equal(draft.sourceWritebackReceipt.proposalId,'proposal');assert.equal(draft.sourceWritebackReceipt.taskId,'writeback-task');
 assert.equal(deriveEnglishWriteback(f.appliedState(),f.language).mode,'empty');
});

test('manual raw source-review and adaptive partial writes retain their existing unresolved draft semantics',()=>{
 for(const mode of['raw-tex-source-review','adaptive-human-draft']){const f=fixture();delete f.transaction.authorDraftAcceptance;f.before.requests[0].segments[0].draftReview.mode=mode;f.run();assert.equal(f.current().sourceReviewRequired,true);assert.equal(f.current().sourceApplied,undefined);assert.equal(f.current().sourceWritebackReceipt,undefined);assert.notEqual(deriveEnglishWriteback(f.appliedState(),f.language).mode,'empty');}
});

test('missing or mismatched task scope, draft hash, revision, source or request cannot consume raw author intent',()=>{
 const mutations=[f=>delete f.transaction.authorDraftAcceptance,f=>f.transaction.authorDraftAcceptance.projectId='foreign',f=>f.transaction.authorDraftAcceptance.baseSnapshotId='other',f=>f.transaction.authorDraftAcceptance.language='fr',f=>f.transaction.authorDraftAcceptance.requestId='other',f=>f.transaction.authorDraftAcceptance.taskId='',f=>f.transaction.authorDraftAcceptance.drafts[0].revision++,f=>f.transaction.authorDraftAcceptance.drafts[0].textHash='e'.repeat(64),f=>f.transaction.authorDraftAcceptance.drafts[0].beforeSourceHash='e'.repeat(64),f=>f.transaction.authorDraftAcceptance.drafts[0].segmentId='other',f=>f.before.requests[0].segments[0].draftReview.mode='adaptive-human-draft',f=>delete f.transaction.buildId,f=>f.transaction.candidateHash='invalid'];
 for(const mutate of mutations){const f=fixture();mutate(f);f.run();assert.equal(f.current().sourceReviewRequired,true);assert.equal(f.current().sourceApplied,undefined);assert.equal(f.current().sourceWritebackReceipt,undefined);}
});

test('new typing or a repeated revision never gets consumed by an earlier task or its durable replay',()=>{
 for(const mutate of[d=>d.text+=' Later typing',d=>d.revision++]){const f=fixture();mutate(f.after.translations[f.language][f.id]);const newer=clone(f.current());f.run();assert.equal(f.current().text,newer.text);assert.equal(f.current().revision,newer.revision);assert.equal(f.current().sourceWritebackReceipt,undefined);}
 const f=fixture();f.run();const consumed=clone(f.current());assert.equal(f.run().changed,0);assert.deepEqual(f.current(),consumed);f.current().text+=' Later input';f.current().revision++;const newer=clone(f.current());f.run();assert.deepEqual(f.current(),newer);
});

test('undo restores its own saved unresolved intent with a fresh revision and no source-applied stamp',()=>{
 const f=fixture();f.run();const undoBefore=clone(f.after),undoAfter=clone(f.before);undoAfter.translations[f.language][f.id]=clone(f.current());
 const transaction={transactionId:'undo',projectId:'project',baseSnapshotId:'after',proposalIds:[],state:'committing'};
 rebaseConfirmedTranslationDrafts({before:undoBefore,after:undoAfter,transaction,registry:f.registry,undoTransaction:f.transaction});
 const restored=undoAfter.translations[f.language][f.id];assert.equal(restored.text,f.before.translations[f.language][f.id].text);assert.equal(restored.revision,6);assert.equal(restored.sourceReviewRequired,true);assert.equal(restored.sourceApplied,undefined);assert.equal(restored.sourceWritebackReceipt,undefined);
});

test('a v2 receipt cannot hide later typing, changed source, a failed transaction, task mismatch or a reverted write',()=>{
 const mutations=[s=>s.translations['zh-CN'].paragraph.text+=' New intent',s=>s.translations['zh-CN'].paragraph.revision++,s=>s.translations['zh-CN'].paragraph.sourceReviewRequired=true,s=>s.translations['zh-CN'].paragraph.sourceApplied=false,s=>s.translations['zh-CN'].paragraph.sourceWritebackReceipt.taskId='other',s=>s.translations['zh-CN'].paragraph.sourceWritebackReceipt.requestId='other',s=>s.translations['zh-CN'].paragraph.sourceWritebackReceipt.proposalId='other',s=>s.translations['zh-CN'].paragraph.sourceWritebackReceipt.draftHash='e'.repeat(64),s=>s.translations['zh-CN'].paragraph.sourceWritebackReceipt.candidateHash='e'.repeat(64),s=>s.transactions[0].state='ready',s=>s.transactions[0].revertedBy='undo',s=>s.proposals[0].applicationState='reverted',s=>s.segments[0].source+=' External change'];
 for(const mutate of mutations){const f=fixture();f.run();assert(f.current().sourceWritebackReceipt,'A full exact receipt is required before testing its guards.');const state=f.appliedState();mutate(state);assert.notEqual(deriveEnglishWriteback(state,f.language).mode,'empty');}
});

test('durable replay validates the exact consumed row and cannot manufacture completion from altered evidence',()=>{
 const corruptions=[row=>row.afterDraft.text+=' Corrupt text',row=>row.afterHash='e'.repeat(64),row=>row.beforeHash='e'.repeat(64),row=>row.afterDraft.revision++,row=>row.afterDraft.sourceWritebackReceipt.taskId='foreign',row=>row.afterDraft.sourceWritebackReceipt.candidateHash='e'.repeat(64),row=>row.afterDraft.sourceApplied=false];
 for(const corrupt of corruptions){const f=fixture();f.run();f.after.translations[f.language][f.id]=clone(f.before.translations[f.language][f.id]);const saved=clone(f.current());corrupt(f.transaction.draftRebases.rows[0]);assert.equal(f.run().changed,0);assert.deepEqual(f.current(),saved);}
 const f=fixture();f.run();const expected=clone(f.current());f.after.translations[f.language][f.id]=clone(f.before.translations[f.language][f.id]);assert.equal(f.run().changed,1);assert.deepEqual(f.current(),expected);assert.equal(f.run().changed,0);
});

test('an exact legacy raw-write ledger clears physical pending status while retaining its semantic-review history',()=>{
 assert.equal(typeof rebase.verifiedAppliedDraftReceipts,'function');assert.equal(typeof writeback.draftSourceWritebackStatus,'function');
 const {verifiedAppliedDraftReceipts}=rebase,{draftSourceWritebackStatus}=writeback;
 const f=fixture();delete f.transaction.authorDraftAcceptance;f.run();const state=f.appliedState();
 state.appliedDraftReceipts=verifiedAppliedDraftReceipts({state,transactions:state.transactions});
 assert.equal(state.appliedDraftReceipts.length,1);assert.equal(state.translations[f.language][f.id].sourceReviewRequired,true);
 assert.equal(draftSourceWritebackStatus(state,f.language,f.id).sourceApplied,true);assert.equal(draftSourceWritebackStatus(state,f.language,f.id).semanticReviewRequired,true);assert.equal(deriveEnglishWriteback(state,f.language).mode,'empty');
 for(const mutate of[s=>s.translations[f.language][f.id].text+=' New input',s=>s.translations[f.language][f.id].revision++,s=>s.transactions[0].revertedBy='undo',s=>s.segments[0].source+=' Externally changed',s=>s.transactions[0].draftRebases.rows[0].afterHash='e'.repeat(64)]){
  const changed=clone(state);mutate(changed);if(changed.transactions[0].draftRebases.rows[0].afterHash===state.transactions[0].draftRebases.rows[0].afterHash)assert.notEqual(deriveEnglishWriteback(changed,f.language).mode,'empty','A stale public receipt cannot hide current typing, source drift or undo.');changed.appliedDraftReceipts=verifiedAppliedDraftReceipts({state:changed,transactions:changed.transactions});assert.equal(changed.appliedDraftReceipts.length,0);assert.notEqual(deriveEnglishWriteback(changed,f.language).mode,'empty');
 }
});

test('physical application of an adaptive protected partial does not consume its unfulfilled author intent',()=>{
 const f=fixture();delete f.transaction.authorDraftAcceptance;f.before.requests[0].segments[0].draftReview.mode='adaptive-human-draft';f.after.requests=clone(f.before.requests);f.run();const state=f.appliedState();state.appliedDraftReceipts=rebase.verifiedAppliedDraftReceipts({state,transactions:state.transactions});
 assert.equal(state.appliedDraftReceipts.length,1);const status=writeback.draftSourceWritebackStatus(state,f.language,f.id);assert.equal(status.sourceApplied,true);assert.equal(status.semanticReviewRequired,true);assert.equal(status.pendingAuthorIntent,true);assert.notEqual(deriveEnglishWriteback(state,f.language).mode,'empty');assert.deepEqual(deriveEnglishWriteback(state,f.language).sourceIds,[f.id]);
});

test('a legacy fully written raw range can complete only its explicitly adopted concern through the exact ledger',()=>{
 const f=fixture();delete f.transaction.authorDraftAcceptance;delete f.before.requests[0].oneClickWriteback;f.before.proposals[0].context.sourceReviewSegmentIds=[f.id];f.before.proposals[0].edits[0].before=f.before.segments[0].source;f.after.requests=clone(f.before.requests);f.after.proposals=clone(f.before.proposals);f.run();
 const state=f.appliedState(),transaction=state.transactions[0];transaction.committedAt='2026-10-28T12:00:02.000Z';transaction.appliedAt='2026-10-28T12:00:03.000Z';state.proposals[0].reviewState='approved';
 const note={noteId:'adopted',origin:'external',batchId:'review',body:'Clarify this exact claim.',decision:'adopt',decisionUpdatedAt:'2026-10-28T12:00:01.000Z',decisionSnapshotId:'before',sourceSnapshotId:'before',sourceSegmentIds:[f.id],sourceHashes:{[f.id]:f.before.segments[0].sourceHash}};
 assert.equal(deriveReviewCompletion(note,state).completed,true);
 for(const decision of['pending','keep','revise'])assert.equal(deriveReviewCompletion({...note,decision},state).completed,false);
 const changed=clone(state);changed.transactions[0].draftRebases.rows[0].afterHash='e'.repeat(64);assert.equal(deriveReviewCompletion(note,changed).completed,false);
 const adaptive=clone(state);adaptive.requests[0].segments[0].draftReview.mode='adaptive-human-draft';assert.equal(deriveReviewCompletion(note,adaptive).completed,false);
});

test('an exact newly created canonical-to-reading shadow receives the same write receipt and durable undo evidence',()=>{
 const f=fixture();f.after.readingDrafts={[f.language]:{[f.id]:clone(f.before.translations[f.language][f.id])}};assert.equal(f.run().changed,2);
 assert.deepEqual(f.after.readingDrafts[f.language][f.id],f.current());assert.equal(f.transaction.draftRebases.rows.length,2);assert.deepEqual(f.transaction.draftRebases.rows.map(row=>row.namespace),['translations','readingDrafts']);
 const undoBefore=clone(f.after),undoAfter=clone(f.before);undoAfter.translations[f.language][f.id]=clone(f.current());undoAfter.readingDrafts=clone(f.after.readingDrafts);
 rebaseConfirmedTranslationDrafts({before:undoBefore,after:undoAfter,transaction:{transactionId:'undo',projectId:'project',baseSnapshotId:'after',proposalIds:[],state:'committing'},registry:f.registry,undoTransaction:f.transaction});
 assert.equal(undoAfter.readingDrafts[f.language][f.id].sourceApplied,undefined);assert.deepEqual(undoAfter.readingDrafts[f.language][f.id],undoAfter.translations[f.language][f.id]);assert.equal(undoAfter.readingDrafts[f.language][f.id].sourceReviewRequired,true);
});

test('namespace migration never acknowledges a different shadow or erases a newer reading draft',()=>{
 for(const existed of[false,true]){const f=fixture(),shadow={...clone(f.before.translations[f.language][f.id]),text:'A different newer reading draft',revision:9};f.after.readingDrafts={[f.language]:{[f.id]:clone(shadow)}};if(existed)f.before.readingDrafts=clone(f.after.readingDrafts);f.run();assert.equal(f.after.readingDrafts[f.language][f.id].text,shadow.text);assert.equal(f.after.readingDrafts[f.language][f.id].revision,shadow.revision);assert.equal(f.after.readingDrafts[f.language][f.id].sourceWritebackReceipt,undefined);}
});

test('an explicit task over the current source acknowledges its exact saved draft even when its pre-click baseline was stale',()=>{
 const f=fixture();for(const draft of[f.before.translations[f.language][f.id],f.after.translations[f.language][f.id]]){draft.sourceHash=sha256('an older author baseline');draft.status='stale';}
 assert.equal(f.run().changed,1);assert.equal(f.current().sourceApplied,true);assert.equal(f.current().status,'saved');assert.equal(f.current().sourceHash,f.after.segments[0].sourceHash);assert.equal(deriveEnglishWriteback(f.appliedState(),f.language).mode,'empty');
 const undoBefore=clone(f.after),undoAfter=clone(f.before);undoAfter.translations[f.language][f.id]=clone(f.current());rebaseConfirmedTranslationDrafts({before:undoBefore,after:undoAfter,transaction:{transactionId:'undo-stale',projectId:'project',baseSnapshotId:'after',proposalIds:[],state:'committing'},registry:f.registry,undoTransaction:f.transaction});const undone=undoAfter.translations[f.language][f.id];assert.equal(undone.text,f.before.translations[f.language][f.id].text);assert.equal(undone.sourceApplied,undefined);assert.equal(undone.sourceReviewRequired,true);assert.equal(undone.sourceHash,f.before.segments[0].sourceHash);assert.equal(undone.revision,6);
 const denied=fixture();for(const draft of[denied.before.translations[denied.language][denied.id],denied.after.translations[denied.language][denied.id]]){draft.sourceHash=sha256('older');draft.status='stale';}denied.transaction.authorDraftAcceptance.drafts[0].beforeSourceHash=sha256('a different source after the click');assert.equal(denied.run().changed,0);assert.equal(denied.current().sourceApplied,undefined);assert.equal(denied.current().status,'stale');
});
