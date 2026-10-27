import test from 'node:test';
import assert from 'node:assert/strict';
import {sha256} from '../src/latex.mjs';
import {rebaseConfirmedTranslationDrafts} from '../src/draft-source-rebase.mjs';
import {deriveEnglishWriteback} from '../ui/writeback-state.mjs';
const clone=value=>structuredClone(value);

function fixture(manySources=false){
 const sourceIds=manySources?['a','b']:['a'],unitIds=manySources?['a']:['a','split-unit'],language='zh-CN';
 const sources=sourceIds.map((id,index)=>{const source=`Original claim ${id}.`;return{id,path:'main.tex',source,displayText:source,sourceHash:sha256(source),beforeHash:sha256(source),startByte:index*64,endByte:index*64+Buffer.byteLength(source),protectedTokens:[],translatable:true,writableSource:true,sourceReviewAvailable:true};});
 const hashes=Object.fromEntries(sources.map(row=>[row.id,row.sourceHash])),drafts=Object.fromEntries(unitIds.map((id,index)=>[id,{text:`作者完整意图 ${index+1}。`,revision:index+4,origin:'human',status:'saved',sourceHash:hashes.a,sourceSegmentIds:sourceIds,sourceHashes:hashes,unitKind:manySources?'merged':'split',sourceReviewRequired:true,sourceReviewDiagnostics:[{code:'RAW_SOURCE_REVIEW_DRAFT_PENDING'}]}]));
 const combined=unitIds.map(id=>drafts[id].text).join('\n\n'),revision=Math.max(...unitIds.map(id=>drafts[id].revision));
 const alignment={alignmentId:'alignment',language,sourceSegmentIds:sourceIds,translationUnitIds:unitIds,relation:manySources?'manyToOne':'oneToMany',status:'confirmed',stale:false};
 const request={requestId:'group-request',kind:'revision',mode:'source-review',status:'completed',projectId:'project',snapshotId:'before',language,segmentIds:sourceIds,draftRevisions:Object.fromEntries(sourceIds.map(id=>[id,drafts[id]?.revision||0])),translationUnitRevisions:Object.fromEntries(unitIds.map(id=>[id,drafts[id].revision])),requiresTranslationMerge:true,oneClickWriteback:{schemaVersion:1,taskId:'group-task',mode:'author-approved-free-source',scopeHash:'d'.repeat(64)},segments:sources.map(row=>({...row,segmentId:row.id,translationDraft:{text:combined,revision,translationUnitIds:unitIds},draftReview:{mode:'raw-tex-source-review',draftRevision:revision,draftHash:sha256(combined),sourceHash:row.sourceHash}}))};
 const proposal={proposalId:'group-proposal',projectId:'project',baseSnapshotId:'before',context:{requestId:request.requestId,mode:'source-review'},reviewState:'pending',applicationState:'notApplied',edits:sources.map(row=>({segmentId:row.id,path:row.path,startByte:row.startByte,endByte:row.endByte,beforeHash:row.sourceHash,replacement:`Revised full claim ${row.id}.`}))};
 const transaction={transactionId:'group-transaction',projectId:'project',baseSnapshotId:'before',state:'committing',proposalIds:[proposal.proposalId],candidateHash:'c'.repeat(64),buildId:'build',authorDraftAcceptance:{schemaVersion:1,taskId:'group-task',requestId:request.requestId,scopeHash:'d'.repeat(64),projectId:'project',baseSnapshotId:'before',language,drafts:unitIds.map(id=>({segmentId:id,revision:drafts[id].revision,textHash:sha256(drafts[id].text),sourceSegmentIds:sourceIds,beforeSourceHashes:hashes,beforeSourceHash:manySources?null:hashes.a}))}};
 const before={project:{id:'project',snapshotId:'before'},segments:sources,readingParagraphs:[],translations:{[language]:drafts},alignments:[alignment],requests:[request],proposals:[proposal]},after=clone(before);after.project.snapshotId='after';for(const row of after.segments){row.source=proposal.edits.find(edit=>edit.segmentId===row.id).replacement;row.displayText=row.source;row.sourceHash=row.beforeHash=sha256(row.source);row.endByte=row.startByte+Buffer.byteLength(row.source);}
 const registry={dynamic:{citations:new Set(),references:new Set()},counts:{citations:new Map(),references:new Map()},citationFoldCounts:new Map(),hash:'r'.repeat(64)};
 const run=()=>rebaseConfirmedTranslationDrafts({before,after,transaction,registry});
 const state=()=>{const result=clone(after);result.transactions=[{...clone(transaction),state:'applied',afterSnapshotId:'after'}];result.proposals[0].applicationState='applied';result.proposals[0].transactionId=transaction.transactionId;return result;};
 return{before,after,transaction,registry,unitIds,sourceIds,language,run,state};
}

for(const many of[false,true])test(`exact confirmed ${many?'many-to-one':'one-to-many'} author task consumes the complete known alignment once`,()=>{
 const f=fixture(many);assert.equal(f.run().changed,f.unitIds.length);
 for(const id of f.unitIds){const draft=f.after.translations[f.language][id];assert.equal(draft.text,f.before.translations[f.language][id].text);assert.equal(draft.revision,f.before.translations[f.language][id].revision+1);assert.equal(draft.sourceReviewRequired,undefined);assert.equal(draft.sourceApplied,true);assert.deepEqual(draft.sourceWritebackReceipt.sourceSegmentIds,f.sourceIds);}
 assert.equal(deriveEnglishWriteback(f.state(),f.language).mode,'empty');assert.equal(f.run().changed,0);
});

test('aligned groups require complete current endpoints and exact grant hashes; one stale unit cannot be partially consumed',()=>{
 const mutations=[f=>f.after.translations[f.language][f.unitIds.at(-1)].text+=' New typing',f=>f.before.alignments[0].stale=true,f=>f.before.alignments[0].translationUnitIds=['a','unknown'],f=>f.transaction.authorDraftAcceptance.drafts.pop(),f=>f.transaction.authorDraftAcceptance.drafts[0].textHash='e'.repeat(64),f=>f.transaction.authorDraftAcceptance.drafts[0].beforeSourceHashes.a='e'.repeat(64),f=>f.before.proposals[0].edits.pop(),f=>f.before.requests[0].segments[0].translationDraft.translationUnitIds=['a']];
 for(const mutate of mutations){const f=fixture();mutate(f);const texts=clone(f.after.translations);f.run();for(const id of f.unitIds){assert.equal(f.after.translations[f.language][id].text,texts[f.language][id].text);assert.equal(f.after.translations[f.language][id].sourceWritebackReceipt,undefined);}}
});

test('new group edits remain actionable only through the exact known source group and cannot reuse an old group receipt',()=>{
 const f=fixture();f.run();const state=f.state();state.translations[f.language]['split-unit'].text+=' New author intent';state.translations[f.language]['split-unit'].revision++;
 const plan=deriveEnglishWriteback(state,f.language);assert.notEqual(plan.mode,'empty');assert.notEqual(plan.mode,'blocked');assert.deepEqual(plan.sourceIds,['a']);
 state.alignments[0].stale=true;assert.equal(deriveEnglishWriteback(state,f.language).mode,'blocked');
});
