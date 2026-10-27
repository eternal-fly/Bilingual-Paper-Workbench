import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PaperApplication,buildInputHash} from '../src/application.mjs';
import {sha256} from '../src/latex.mjs';
import {deriveEnglishWriteback,draftSourceWritebackStatus} from '../ui/writeback-state.mjs';

async function fixture(t,many){
 const owned=path.resolve('work/aligned-author-application');await mkdir(owned,{recursive:true});const directory=await mkdtemp(path.join(owned,'case-')),root=path.join(directory,'source');await mkdir(root);
 const original='\\documentclass{article}\n\\begin{document}\n\nA precise first claim.\n\nA precise second claim.\n\n\\end{document}\n';await writeFile(path.join(root,'main.tex'),original);
 const compiler={probe:async()=>({available:true,isolated:true}),build:async input=>{const pdfPath=path.join(directory,`${randomUUID()}.pdf`);await writeFile(pdfPath,`%PDF-synthetic-aligned-${input.inputHash}`);return{buildId:`build-${randomUUID()}`,status:'success',snapshotId:input.snapshotId,candidateHash:input.candidateHash,inputHash:buildInputHash(input),pdfPath,pdfHash:sha256(await readFile(pdfPath)),isolation:{verified:true}};}};
 const app=new PaperApplication({dataRoot:path.join(directory,'private'),compiler});await app.initialize();await app.openProject({root,mainFile:'main.tex'});t.after(async()=>{await app.close();await Promise.allSettled([...app.jobs.values()].map(job=>job.promise));await rm(directory,{recursive:true,force:true});});
 const paragraphs=app.getState().segments.filter(row=>row.source.includes('precise')),first=paragraphs[0];await app.saveDraft({segmentId:first.id,language:'zh-CN',text:many?'完整合并意图。':'第一部分。\n\n第二部分。',expectedRevision:0});
 if(many)await app.setAlignment({language:'zh-CN',sourceSegmentIds:paragraphs.map(row=>row.id).reverse(),translationUnitIds:[first.id]});else await app.splitTranslation({segmentId:first.id,language:'zh-CN',expectedRevision:1,splitAt:'第一部分。\n\n'.length});
 return{app,root,original};
}
async function apply(app,proposal,grant=null){const preview=await app.previewTransaction({proposalIds:[proposal.proposalId]});assert.equal((await app.waitJob({jobId:preview.jobId})).status,'success');const prepared=await app.prepareAcceptance({transactionId:preview.transactionId,sourceReviewConfirmed:true});const result=await app.applyTransaction({transactionId:preview.transactionId,confirmationToken:prepared.confirmationToken,idempotencyKey:randomUUID()},grant?{beforeApply:({transaction})=>{transaction.authorDraftAcceptance=grant;}}:{});if(result.englishPdfJobId)await app.waitJob({jobId:result.englishPdfJobId});return result;}

for(const many of[false,true])test(`actual aligned ${many?'merged':'split'} request writes once, refreshes every unit and reopens pending intent on undo`,async t=>{
 const f=await fixture(t,many),state=f.app.getState(),alignment=state.alignments[0],sources=alignment.sourceSegmentIds,units=alignment.translationUnitIds,scopeHash=sha256('synthetic trusted aligned click'),marker={schemaVersion:1,taskId:'synthetic-aligned-task',mode:'author-approved-free-source',scopeHash};
 const beforeDrafts=Object.fromEntries(units.map(id=>[id,structuredClone(state.translations['zh-CN'][id])])),hashes=Object.fromEntries(sources.map(id=>[id,state.segments.find(row=>row.id===id).beforeHash]));
 const request=await f.app.core.createRequest({kind:'revision',mode:'source-review',language:'zh-CN',segmentIds:sources},{beforeCommit:captured=>{captured.oneClickWriteback=marker;}});
 // The fixture registers an internal author grant directly; queue/controller
 // authorization is covered by the dedicated one-click orchestration tests.
 const proposal=await f.app.core.proposeRevision({requestId:request.requestId,reason:'Apply only the complete author-confirmed alignment.',edits:request.segments.map((row,index)=>({segmentId:row.id,beforeHash:row.beforeHash,replacement:`A faithfully revised aligned claim ${index+1}.`}))});
 const grant={schemaVersion:1,taskId:marker.taskId,requestId:request.requestId,projectId:state.project.id,baseSnapshotId:state.project.snapshotId,language:'zh-CN',scopeHash,drafts:units.map(id=>({segmentId:id,revision:beforeDrafts[id].revision,textHash:sha256(beforeDrafts[id].text),sourceSegmentIds:[...sources].sort(),beforeSourceHashes:hashes,beforeSourceHash:sources.length===1?hashes[sources[0]]:null}))};
 const written=await apply(f.app,proposal,grant),after=f.app.getState();assert.equal(written.state,'applied');assert.equal(deriveEnglishWriteback(after,'zh-CN').mode,'empty');for(const id of units){assert.equal(after.translations['zh-CN'][id].sourceApplied,true);assert.equal(after.translations['zh-CN'][id].revision,beforeDrafts[id].revision+1);assert.equal(draftSourceWritebackStatus(after,'zh-CN',id).sourceApplied,true);}
 const inverse=await f.app.createUndoProposal({transactionId:written.transactionId});await apply(f.app,inverse);const undone=f.app.getState();if(units.some(id=>undone.translations['zh-CN'][id].sourceApplied))await writeFile(path.resolve(`work/v164-group-${many?'merged':'split'}-undo-diagnostic.json`),JSON.stringify({before:state,written:after,undone:f.app.core.getState(),transactions:f.app.flow.transactions},null,2));assert.equal(await readFile(path.join(f.root,'main.tex'),'utf8'),f.original);for(const id of units){assert.equal(undone.translations['zh-CN'][id].text,beforeDrafts[id].text);assert.equal(undone.translations['zh-CN'][id].sourceApplied,undefined);assert.equal(draftSourceWritebackStatus(undone,'zh-CN',id).sourceApplied,false);}assert.notEqual(deriveEnglishWriteback(undone,'zh-CN').mode,'empty');
});
