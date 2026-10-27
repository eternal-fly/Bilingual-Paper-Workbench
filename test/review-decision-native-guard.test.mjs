import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {PaperApplication} from '../src/application.mjs';
import {assertNativePaperScope} from '../src/native-paper-tools.mjs';

async function fixture(t) {
  const parent=path.resolve('work/review-decision-native-guard-tests');await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(path.join(parent,'case-')),source=path.join(directory,'source');await mkdir(source);
  const filename=path.join(source,'main.tex'),sourceText='\\documentclass{article}\n\\begin{document}\n\nA self-authored synthetic claim states its assumption.\n\n\\end{document}\n';await writeFile(filename,sourceText);
  const app=new PaperApplication({dataRoot:path.join(directory,'private')});await app.openProject({root:source,mainFile:'main.tex'});
  const imported=await app.importReviewNotes({filename:'synthetic-review.txt',format:'txt',fileHash:'a'.repeat(64),text:'1. Clarify the synthetic assumption.'}),note=imported.notes[0],project=app.core.getState().project;
  const origin={threadId:'native-review-guard-chat',verified:true,projectId:project.id,snapshotId:project.snapshotId};
  const service={active:app,originChat:{state:()=>({...origin})}},scope={expectedProjectId:project.id,expectedSnapshotId:project.snapshotId};
  let guardCalls=0;
  const options={beforeWrite:async()=>{guardCalls++;await Promise.resolve();assertNativePaperScope(service,'native-review-guard-chat',scope,app);}};
  t.after(async()=>{await app.close();assert.equal(await readFile(filename,'utf8'),sourceText);assert(directory.startsWith(parent+path.sep));await rm(directory,{recursive:true,force:true});});
  const stateFile=path.join(app.core._store,'state.json');
  return{app,note,origin,options,get guardCalls(){return guardCalls;},snapshot:async()=>({state:app.core.getState(),durable:await readFile(stateFile)})};
}

for(const action of ['decision','resolve'])test(`native ${action} guard rejects a revoked binding inside the serialized commit without changing opinions`,async t=>{
  const f=await fixture(t),before=await f.snapshot();let release,entered;const ready=new Promise(resolve=>entered=resolve);
  const held=f.app.core._serial(async()=>{entered();await new Promise(resolve=>release=resolve);});await ready;
  const pending=action==='decision'?f.app.reviews.setDecision({noteId:f.note.noteId,expectedRevision:1,decision:'keep'},f.options):f.app.reviews.resolve({noteId:f.note.noteId,expectedRevision:1,resolved:true},f.options);
  f.origin.threadId='a-different-chat';release();await held;
  await assert.rejects(pending,{code:'THREAD_MISMATCH'});assert.equal(f.guardCalls,1);assert.deepEqual(await f.snapshot(),before);
});

test('an idempotent review decision still awaits the current native binding guard',async t=>{
  const f=await fixture(t),before=await f.snapshot();f.origin.verified=false;
  await assert.rejects(f.app.reviews.setDecision({noteId:f.note.noteId,expectedRevision:1,decision:'pending'},f.options),{code:'THREAD_MISMATCH'});
  assert.equal(f.guardCalls,1);assert.deepEqual(await f.snapshot(),before);
});

test('guarded review decisions and resolution preserve defaults, exact revisions and independent metadata',async t=>{
  const f=await fixture(t),initial=f.app.core.getState();
  const decision=await f.app.reviews.setDecision({noteId:f.note.noteId,expectedRevision:1,decision:'keep'},f.options);assert.equal(f.guardCalls,1);assert.equal(decision.revision,2);assert.equal(decision.decision,'keep');
  const repeat=await f.app.reviews.setDecision({noteId:f.note.noteId,expectedRevision:2,decision:'keep'},f.options);assert.equal(f.guardCalls,2);assert.equal(repeat.idempotent,true);assert.equal(repeat.revision,2);
  const resolved=await f.app.reviews.resolve({noteId:f.note.noteId,expectedRevision:2,resolved:true},f.options);assert.equal(f.guardCalls,3);assert.equal(resolved.status,'resolved');assert.equal(resolved.decision,'keep');assert.equal(resolved.revision,3);
  const reopened=await f.app.reviews.resolve({noteId:f.note.noteId,expectedRevision:3,resolved:false});assert.equal(reopened.revision,4);assert.equal(reopened.status,'open');assert.equal(f.guardCalls,3);
  const plain=await f.app.reviews.setDecision({noteId:f.note.noteId,expectedRevision:4,decision:'pending'});assert.equal(plain.revision,5);assert.equal(plain.decision,'pending');assert.equal(f.guardCalls,3);
  const final=f.app.core.getState();for(const key of ['project','translations','proposals','requests','reviewBatches'])assert.deepEqual(final[key],initial[key]);assert.equal(f.app.jobs.size,0);
});
