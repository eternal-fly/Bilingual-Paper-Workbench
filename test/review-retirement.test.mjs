import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PaperApplication } from '../src/application.mjs';
import { createPaperServer } from '../src/server.mjs';
import { startLocalWeb } from '../src/local-web.mjs';
import { reviewNoteSchema } from '../src/full-review.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
async function fixture(t) {
  const owned=path.join(root,'work/review-retirement-tests');await mkdir(owned,{recursive:true});
  const dir=await mkdtemp(path.join(owned,'case-')),source=path.join(dir,'source'),dataRoot=path.join(dir,'private');await mkdir(source);
  const sourceBytes=Buffer.from('\\documentclass{article}\n\\begin{document}\n\nA synthetic claim has explicit assumptions.\n\n\\end{document}\n');await writeFile(path.join(source,'main.tex'),sourceBytes);
  const app=new PaperApplication({dataRoot});await app.openProject({root:source,mainFile:'main.tex'});
  t.after(async()=>{await app.close();assert.ok(path.resolve(dir).startsWith(path.resolve(owned)+path.sep));await rm(dir,{recursive:true,force:true});});
  const upload={filename:'synthetic-review.pdf',format:'pdf',fileHash:'a'.repeat(64),text:'1. State the assumptions.\n2. Check the notation.'};
  const imported=await app.importReviewNotes(upload);
  const select=(changes={})=>({batchId:imported.batch.batchId,expectedFileHash:upload.fileHash,expectedRevision:1,active:false,...changes});
  return {app,source,dataRoot,sourceBytes,upload,imported,select};
}

test('external retirement preserves canonical opinions, other notes, drafts and source; restore survives reload',async t=>{
  const {app,source,dataRoot,sourceBytes,imported,select}=await fixture(t);
  const paragraph=app.getState().readingParagraphs[0],draft=app.getState().translations['zh-CN']?.[paragraph.id];
  await app.saveDraft({segmentId:paragraph.id,language:'zh-CN',text:'保留人工译稿。',expectedRevision:draft?.revision||0});
  await app.core._serial(async()=>{const next=app.core.getState();next.reviewNotes.push({noteId:'note-model-synthetic',batchId:'review-model-synthetic',origin:'codex',body:'Keep this model opinion.',status:'open',revision:1});next.reviewBatches.push({batchId:'review-model-synthetic',origin:'codex',status:'completed'});await app.core._commit(next);});
  const before=app.core.getState(),notes=structuredClone(before.reviewNotes);
  const retired=await app.setReviewImportActive(select());assert.equal(retired.status,'retired');assert.equal(retired.active,false);assert.equal(retired.revision,2);
  assert.deepEqual(app.getState().reviewNotes.map(note=>note.noteId),['note-model-synthetic']);
  assert.deepEqual(app.core.getState().reviewNotes,notes);assert.deepEqual(app.core.getState().translations,before.translations);
  assert.deepEqual(await readFile(path.join(source,'main.tex')),sourceBytes);
  const same=await app.setReviewImportActive(select({expectedRevision:2}));assert.equal(same.revision,2);assert.equal(same.idempotent,true);
  const reopened=new PaperApplication({dataRoot});await reopened.openProject({root:source,mainFile:'main.tex'});t.after(()=>reopened.close());
  assert.equal(reopened.getState().reviewNotes.length,1);assert.equal(reopened.getState().reviewBatches.find(batch=>batch.batchId===imported.batch.batchId).status,'retired');
  const restored=await reopened.setReviewImportActive(select({expectedRevision:2,active:true}));assert.equal(restored.status,'completed');assert.equal(restored.revision,3);
  assert.deepEqual(reopened.getState().reviewNotes,notes);assert.deepEqual(reopened.core.getState().reviewNotes,notes);
});

test('strict review schema requires the bilingual quartet and a nullable review code',()=>{
  for(const field of ['suggestedSource','suggestedTranslation','reasonSource','reasonTranslation']){assert.ok(reviewNoteSchema.required.includes(field));assert.equal(reviewNoteSchema.properties[field].type,'string');assert.equal(reviewNoteSchema.properties[field].minLength,1);}
  assert.deepEqual(reviewNoteSchema.properties.reviewCode.type,['string','null']);assert.ok(reviewNoteSchema.required.includes('reviewCode'));
});

test('review decisions record only human intent, retain resolve state and legacy notes, and survive reload',async t=>{
  const {app,source,dataRoot,sourceBytes}=await fixture(t);const note=app.getState().reviewNotes[0];
  await app.resolveReviewNote({noteId:note.noteId,expectedRevision:note.revision,resolved:true});
  const before=app.core.getState();let revision=2;
  for(const decision of ['adopt','revise','keep','pending']){
    const updated=await app.setReviewDecision({noteId:note.noteId,expectedRevision:revision,decision});assert.equal(updated.decision,decision);assert.equal(updated.status,'resolved');assert.equal(updated.revision,++revision);
    assert.ok(updated.decisionUpdatedAt);assert.deepEqual(app.getState().proposals,before.proposals);assert.deepEqual(app.getState().translations,before.translations);assert.equal(app.jobs.size,0);assert.equal(app.chat,null);
  }
  const same=await app.setReviewDecision({noteId:note.noteId,expectedRevision:revision,decision:'pending'});assert.equal(same.revision,revision);assert.equal(same.idempotent,true);
  const reopened=new PaperApplication({dataRoot});await reopened.openProject({root:source,mainFile:'main.tex'});t.after(()=>reopened.close());assert.equal(reopened.getState().reviewNotes[0].decision,'pending');assert.equal(reopened.getState().reviewNotes[0].status,'resolved');
  assert.deepEqual(await readFile(path.join(source,'main.tex')),sourceBytes);assert.equal(reopened.getState().reviewNotes[0].suggestedSource,undefined);
});

test('review decisions reject stale CAS, source/hash mismatches and retired batches without source changes',async t=>{
  const {app,source,sourceBytes,select}=await fixture(t),note=app.getState().reviewNotes[0];
  const call=changes=>app.setReviewDecision({noteId:note.noteId,expectedRevision:1,decision:'adopt',...changes});
  await assert.rejects(call({noteId:'missing-note'}),{code:'REVIEW_NOTE_NOT_FOUND'});await assert.rejects(call({expectedRevision:9}),{code:'VERSION_CONFLICT'});await assert.rejects(call({decision:'apply'}),{code:'INVALID_INPUT'});
  await app.core._serial(async()=>{const next=app.core.getState();next.reviewNotes[0].sourceSnapshotId='snap-historical';await app.core._commit(next);});
  await assert.rejects(call(),{code:'REVIEW_NOTE_STALE'});await call({decision:'keep'});
  await app.core._serial(async()=>{const next=app.core.getState(),paragraph=app.getState().readingParagraphs[0];Object.assign(next.reviewNotes[0],{sourceSnapshotId:next.project.snapshotId,sourceSegmentIds:[paragraph.id],sourceHashes:{[paragraph.id]:'f'.repeat(64)}});await app.core._commit(next);});
  await assert.rejects(call({expectedRevision:2,decision:'revise'}),{code:'REVIEW_NOTE_STALE'});
  await app.setReviewImportActive(select());await assert.rejects(call({expectedRevision:2,decision:'pending'}),{code:'REVIEW_IMPORT_RETIRED'});
  await app.setReviewImportActive(select({expectedRevision:2,active:true}));await writeFile(path.join(source,'main.tex'),Buffer.concat([sourceBytes,Buffer.from('% synthetic external edit\n')]));
  await assert.rejects(call({expectedRevision:2,decision:'pending'}),{code:'VERSION_CONFLICT'});assert.equal(app.core.getState().reviewNotes[0].revision,2);
});

test('review decision mutation is authenticated UI authority with strict payloads',async t=>{
  const {app}=await fixture(t),note=app.getState().reviewNotes[0],server=createPaperServer({service:app,uiHtml:'<!doctype html>'}),client=new Client({name:'synthetic-decision',version:'1'}),[cs,ss]=InMemoryTransport.createLinkedPair();
  await server.connect(ss);await client.connect(cs);t.after(async()=>{await client.close();await server.close();});
  const payload={noteId:note.noteId,expectedRevision:1,decision:'adopt'};
  const denied=await client.callTool({name:'bilingual_paper_ui',arguments:{action:'setReviewDecision',payload}});assert.equal(denied.structuredContent.error.code,'UI_AUTHORIZATION_REQUIRED');
  const panel=await client.callTool({name:'bilingual_paper_panel',arguments:{}});const changed=await client.callTool({name:'bilingual_paper_ui',arguments:{action:'setReviewDecision',payload,uiToken:panel._meta.paperUiToken}});assert.equal(changed.isError,undefined,changed._meta?.paperError?.message);assert.equal(changed._meta.paperResult.decision,'adopt');
  const web=await startLocalWeb({service:app,nativeBindingId:'synthetic-decision-host'});t.after(()=>web.close());
  const response=await fetch(web.origin+'/api',{method:'POST',headers:{Origin:web.origin,'Content-Type':'application/json',Authorization:'Bearer '+web.token},body:JSON.stringify({action:'setReviewDecision',payload:{...payload,expectedRevision:2,decision:'keep'}})});const body=await response.json();assert.equal(body.ok,true);assert.equal(body.result.decision,'keep');assert.equal(app.getState().proposals.length,0);
});

test('concurrent review decisions cannot overwrite the same note revision',async t=>{
  const {app}=await fixture(t),note=app.getState().reviewNotes[0];
  const results=await Promise.allSettled(['adopt','keep'].map(decision=>app.setReviewDecision({noteId:note.noteId,expectedRevision:note.revision,decision})));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.deepEqual(results.filter(result=>result.status==='rejected').map(result=>result.reason.code),['VERSION_CONFLICT']);
  const updated=app.getState().reviewNotes.find(item=>item.noteId===note.noteId);assert.equal(updated.revision,2);assert.equal(updated.decision,results.find(result=>result.status==='fulfilled').value.decision);assert.equal(app.getState().proposals.length,0);assert.equal(app.jobs.size,0);
});

test('external retirement requires exact digest and revision, rejects model batches and strict-payload violations',async t=>{
  const {app,select}=await fixture(t);const before=app.core.getState();
  await assert.rejects(app.setReviewImportActive(select({expectedFileHash:'b'.repeat(64)})),{code:'VERSION_CONFLICT'});
  await assert.rejects(app.setReviewImportActive(select({expectedRevision:7})),{code:'VERSION_CONFLICT'});
  await assert.rejects(app.setReviewImportActive(select({active:'false'})),{code:'INVALID_INPUT'});
  await assert.rejects(app.setReviewImportActive({...select(),replacement:'Do not write source.'}),{code:'INVALID_INPUT'});
  await app.core._serial(async()=>{const next=app.core.getState();next.reviewBatches.push({batchId:'review-model-synthetic',origin:'codex',status:'completed',fileHash:'a'.repeat(64)});await app.core._commit(next);});
  await assert.rejects(app.setReviewImportActive(select({batchId:'review-model-synthetic'})),{code:'PERMISSION_DENIED'});
  assert.deepEqual(app.core.getState().reviewNotes,before.reviewNotes);assert.deepEqual(app.core.getState().reviewBatches[0],before.reviewBatches[0]);
});

test('retirement blocks active jobs/chat/start reservations and reimport never silently restores a retired batch',async t=>{
  const {app,upload,select}=await fixture(t);
  for(const busy of ['job','chat','review','operation']){
    if(busy==='job')app.jobs.set('synthetic-job',{kind:'codex',finished:false});
    if(busy==='chat')app.chat={getState:()=>({busy:true})};
    if(busy==='review')app.reviews.starting=true;
    if(busy==='operation')app._pendingOps=1;
    try{await assert.rejects(app.setReviewImportActive(select()),{code:'PROJECT_BUSY'});}finally{app.jobs.clear();app.chat=null;app.reviews.starting=false;app._pendingOps=0;}
  }
  await app._flowAction(()=>{app.flow.jobs.push({jobId:'synthetic-persisted-job',status:'running',ownerPid:process.pid});});
  await assert.rejects(app.setReviewImportActive(select()),{code:'PROJECT_BUSY'});
  await app._flowAction(()=>{app.flow.jobs.find(job=>job.jobId==='synthetic-persisted-job').status='completed';});
  await app.setReviewImportActive(select());const result=await app.importReviewNotes(upload);assert.equal(result.idempotent,true);
  assert.equal(app.getState().reviewNotes.length,0);assert.equal(app.getState().reviewBatches[0].status,'retired');
});

test('serialized batch CAS rejects a second controller carrying the old activation revision',async t=>{
  const {app,source,dataRoot,select}=await fixture(t),other=new PaperApplication({dataRoot});await other.openProject({root:source,mainFile:'main.tex'});t.after(()=>other.close());
  const results=await Promise.allSettled([app.setReviewImportActive(select()),other.setReviewImportActive(select())]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  const rejected=results.findIndex(result=>result.status==='rejected');assert.ok(['PROJECT_BUSY','VERSION_CONFLICT'].includes(results[rejected].reason.code));
  await assert.rejects((rejected===0?app:other).setReviewImportActive(select()),{code:'VERSION_CONFLICT'});
});

test('legacy external import batches without activation revision can be retired and restored',async t=>{
  const {app,select}=await fixture(t);await app.core._serial(async()=>{const next=app.core.getState();delete next.reviewBatches[0].revision;delete next.reviewBatches[0].active;await app.core._commit(next);});
  assert.equal(app.getState().reviewBatches[0].revision,1);assert.equal(app.getState().reviewBatches[0].active,true);
  await app.setReviewImportActive(select());await app.setReviewImportActive(select({expectedRevision:2,active:true}));assert.equal(app.getState().reviewNotes.length,2);
});

test('retirement is authenticated UI authority through MCP and native HTTP, never a model tool',async t=>{
  const {app,select}=await fixture(t),server=createPaperServer({service:app,uiHtml:'<!doctype html>'}),client=new Client({name:'synthetic-retirement',version:'1'}),[cs,ss]=InMemoryTransport.createLinkedPair();
  await server.connect(ss);await client.connect(cs);t.after(async()=>{await client.close();await server.close();});
  const names=(await client.listTools()).tools.map(tool=>tool.name);assert.ok(!names.some(name=>/retire|setReviewImportActive/.test(name)));
  const unauthenticated=await client.callTool({name:'bilingual_paper_ui',arguments:{action:'setReviewImportActive',payload:select()}});assert.equal(unauthenticated.isError,true);assert.equal(unauthenticated.structuredContent.error.code,'UI_AUTHORIZATION_REQUIRED');
  const panel=await client.callTool({name:'bilingual_paper_panel',arguments:{}}),retired=await client.callTool({name:'bilingual_paper_ui',arguments:{action:'setReviewImportActive',payload:select(),uiToken:panel._meta.paperUiToken}});
  assert.equal(retired.isError,undefined,retired._meta?.paperError?.message);assert.equal(app.getState().reviewNotes.length,0);
  const web=await startLocalWeb({service:app,nativeBindingId:'synthetic-host'});t.after(()=>web.close());
  const send=authorization=>fetch(web.origin+'/api',{method:'POST',headers:{Origin:web.origin,'Content-Type':'application/json',Authorization:authorization},body:JSON.stringify({action:'setReviewImportActive',payload:select({expectedRevision:2,active:true})})});
  assert.equal((await send('')).status,401);const restored=await(await send('Bearer '+web.token)).json();assert.equal(restored.ok,true);assert.equal(restored.result.active,true);assert.equal(app.getState().reviewNotes.length,2);
});
