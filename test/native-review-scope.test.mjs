import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {PaperApplication} from '../src/application.mjs';
import {WorkspaceService} from '../src/workspace-service.mjs';
import {registerReviewOrganizationTools} from '../src/review-organization-tools.mjs';
import {registerReviewAnchorTools} from '../src/review-anchor-tools.mjs';

const caller='native-review-scope-chat',selection={threadId:caller,model:'synthetic-no-model',effort:'high'};
async function fixture(t){
 const parent=path.resolve('work/native-review-scope-tests');await mkdir(parent,{recursive:true});const directory=await mkdtemp(path.join(parent,'case-')),source=path.join(directory,'source'),dataRoot=path.join(directory,'private');await mkdir(source);
 const filename=path.join(source,'main.tex'),sourceText='\\documentclass{article}\n\\begin{document}\n\nA self-authored exact claim has a bounded assumption.\n\nA second independent claim remains unchanged.\n\n\\end{document}\n';await writeFile(filename,sourceText);
 const writer=new PaperApplication({dataRoot});await writer.openProject({root:source,mainFile:'main.tex'});await writer._flowAction(()=>{writer.flow.backgroundChatReference={...selection,projectId:writer.core.getState().project.id,source:'originating-host-chat'};});
 const uploaded=await writer.importReviewNotes({filename:'synthetic-review.txt',format:'txt',fileHash:'d'.repeat(64),text:'1. Explain the assumption without an exact quote.'});
 const app=new PaperApplication({dataRoot});await app.openProject({root:source,mainFile:'main.tex'});let enqueues=0;
 const service=new WorkspaceService({initialApp:app,factory:async()=>{throw Error('No new application');},dataRoot:path.join(directory,'registry'),codexRoot:path.join(directory,'chat'),createDesktopProducer:async()=>({state:()=>({desktopQueueVerified:true}),close:async()=>{},enqueue:async()=>{enqueues++;throw Error('No model delivery is allowed');}})});
 await service.desktopExecution.bind({app,project:app.core.getState().project,selection});
 const input={batchId:uploaded.batch.batchId,expectedRevision:1,expectedFileHash:uploaded.batch.fileHash};
 const prepare=(kind,options={bindingId:`desktop:${caller}`})=>app[kind==='organization'?'prepareReviewOrganization':'prepareReviewAnchors'](input,options);
 function tools(kind,instanceId='callback-one',nativeThreadId=caller){const handlers=new Map();(kind==='organization'?registerReviewOrganizationTools:registerReviewAnchorTools)({registerTool(name,_config,handler){handlers.set(name,handler);}},{service,instanceId,nativeThreadId,guard:handler=>async args=>{try{return await handler(args);}catch(error){return{isError:true,error:{code:error.code,message:error.message}};}}});return{get:args=>handlers.get(kind==='organization'?'bilingual_paper_get_review_organization_context':'bilingual_paper_get_review_anchor_context')(args),submit:args=>handlers.get(kind==='organization'?'bilingual_paper_submit_review_organization':'bilingual_paper_submit_review_anchors')(args)};}
 const revoke=()=>writer._flowAction(()=>{writer.flow.backgroundChatReference.threadId='different-current-chat';});
 t.after(async()=>{await service.desktopExecution.close();await app.close();await writer.close();assert.equal(enqueues,0);assert.equal(await readFile(filename,'utf8'),sourceText);assert(directory.startsWith(parent+path.sep));await rm(directory,{recursive:true,force:true});});
 return{writer,app,service,input,prepare,tools,revoke,stateFile:path.join(app.core._store,'state.json')};
}
function output(kind,packet){return kind==='organization'?{requestId:packet.requestId,notes:packet.noteIds.map(noteId=>({noteId,suggestedSource:'The pending claim states its bounded assumption.',suggestedTranslation:'待审阅的结论说明其有界假设。',reasonSource:'Explain the reviewer concern precisely.',reasonTranslation:'精确解释审稿意见。'}))}:{requestId:packet.requestId,matches:packet.noteIds.map(noteId=>({noteId,status:'unmatched',candidates:[],reason:'No unique literal source evidence.'}))};}

for(const kind of ['organization','anchors']){
 test(`${kind} native context rechecks a durable chat rebind before revealing paper context`,async t=>{
  const f=await fixture(t),packet=await f.prepare(kind),before=await readFile(f.stateFile);await f.revoke();const result=await f.tools(kind).get({requestId:packet.requestId});assert.equal(result.isError,true);assert.deepEqual(await readFile(f.stateFile),before);
 });
 test(`${kind} native callbacks keep a stable verified chat binding across instances even when queue delivery is uncertain`,async t=>{
  const f=await fixture(t),packet=await f.prepare(kind),project=f.app.core.getState().project;
  await f.writer._flowAction(()=>{f.writer.flow.desktopMessages=[{messageId:'desktop-synthetic-uncertain',kind:'message',projectId:project.id,snapshotId:project.snapshotId,threadId:caller,status:'unknown',text:'Synthetic retained uncertainty.'}];});await f.app.core._serial(()=>f.app._loadFlow());assert.equal(f.service.desktopExecution.state().available,false);
  for(const instance of ['callback-one','callback-two']){const result=await f.tools(kind,instance).get({requestId:packet.requestId});assert.notEqual(result.isError,true,result.error?.message);}
  const saved=await f.tools(kind,'callback-three').submit(output(kind,packet));assert.notEqual(saved.isError,true,saved.error?.message);
 });
 test(`${kind} publication rechecks native binding inside the serialized commit after outer authorization`,async t=>{
  const f=await fixture(t),packet=await f.prepare(kind),before=await readFile(f.stateFile),method=kind==='organization'?'submitReviewOrganization':'submitReviewAnchors',original=f.app[method].bind(f.app);let enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
  f.app[method]=async(...args)=>{enter();await gate;return original(...args);};const pending=f.tools(kind).submit(output(kind,packet));await entered;await f.revoke();release();const result=await pending;assert.equal(result.isError,true);assert.deepEqual(await readFile(f.stateFile),before);
 });
 test(`${kind} prepare and context guard hooks cannot be bypassed by local paths`,async t=>{
  const f=await fixture(t),before=await readFile(f.stateFile),denied={bindingId:`desktop:${caller}`,beforeAccess:async()=>{throw Object.assign(Error('The current chat was revoked.'),{code:'THREAD_MISMATCH'});}};
  await assert.rejects(f.prepare(kind,denied),{code:'THREAD_MISMATCH'});const packet=await f.prepare(kind),workflow=kind==='organization'?f.app.organization:f.app.reviewAnchors;
  await assert.rejects(workflow.context({requestId:packet.requestId},denied),{code:'THREAD_MISMATCH'});await assert.rejects(workflow.submit(output(kind,packet),denied),{code:'THREAD_MISMATCH'});assert.deepEqual(await readFile(f.stateFile),before);
 });
 test(`${kind} completed transport receipts still require the current in-lock authorization`,async t=>{
  const f=await fixture(t),packet=await f.prepare(kind),workflow=kind==='organization'?f.app.organization:f.app.reviewAnchors,input={...output(kind,packet),batchOffset:0,resultCount:packet.noteCount,finalize:true};
  const result=await f.tools(kind).submit(input);assert.notEqual(result.isError,true,result.error?.message);assert(workflow.completed.has(packet.requestId));const before=await readFile(f.stateFile);
  await assert.rejects(workflow.submit(input,{bindingId:`desktop:${caller}`,beforeAccess:async()=>{throw Object.assign(Error('Revoked completed receipt.'),{code:'THREAD_MISMATCH'});}}),{code:'THREAD_MISMATCH'});assert.deepEqual(await readFile(f.stateFile),before);
 });
}

test('a native foreign caller never falls back to a matching legacy instance binding',async t=>{
 const f=await fixture(t),packet=await f.prepare('organization',{bindingId:'legacy-instance'}),before=await readFile(f.stateFile),result=await f.tools('organization','legacy-instance','different-native-chat').get({requestId:packet.requestId});assert.equal(result.isError,true);assert.deepEqual(await readFile(f.stateFile),before);
});
