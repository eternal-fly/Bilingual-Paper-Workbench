import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PaperApplication} from '../src/application.mjs';
import {DesktopExecution} from '../src/desktop-execution.mjs';

const authorKeys=['translations','readingDrafts','requests','proposals','originals','readingOriginals','reviewNotes','reviewHistory','alignments'];
const authorRecord=state=>JSON.stringify(Object.fromEntries(authorKeys.map(key=>[key,state[key]||null])));
async function fixture(t, prefix=''){
 const parent=path.resolve('work/inline-profile-refresh-tests');await mkdir(parent,{recursive:true});const run=await mkdtemp(path.join(parent,'case-')),root=path.join(run,'source');await mkdir(root);
 const source='\\documentclass{article}\n'+prefix+'\n\\begin{document}\n\nA synthetic literal claim with $x=1$.\n\n\\end{document}\n',filename=path.join(root,'main.tex');await writeFile(filename,source);
 const app=new PaperApplication({dataRoot:path.join(run,'state')});app.desktopExecutionEnabled=true;await app.openProject({root,mainFile:'main.tex'});
 const project=app.core.getState().project,threadId='synthetic-profile-chat',selection={threadId,model:'synthetic-no-model'};
 await app._flowAction(()=>{app.flow.backgroundChatReference={...selection,projectId:project.id};});
 const service=new EventEmitter();service.active=app;let factories=0;
 const desktop=new DesktopExecution(service,{createProducer:async()=>{factories++;return{state:()=>({desktopQueueVerified:true}),enqueue:()=>{throw Error('A profile refresh must not enqueue.');},close:async()=>{}};}});
 t.after(async()=>{await desktop.close();await app.close();assert.equal(await readFile(filename,'utf8'),source);await rm(run,{recursive:true,force:true});});
 return{app,desktop,project,selection,filename,stateFile:path.join(app.core._store,'state.json'),workflow:path.join(app.core._store,'workflow.json'),factories:()=>factories};
}
async function legacyProfile(f){
 const durable=JSON.parse(await readFile(f.stateFile,'utf8')),p=durable.project;
 p.inlineStructureSafety={schemaVersion:1,projectId:p.id,snapshotId:p.snapshotId,fingerprint:p.inlineStructureSafety.fingerprint,safe:false,opaqueSymbolArity:true,reboundControls:[],unboundedBindings:true,literalSyntaxStable:false};
 await writeFile(f.stateFile,JSON.stringify(durable));f.app.core._state=structuredClone(durable);f.app.core._literalSafety={snapshotId:p.snapshotId,safe:false};f.app.reading.cache=null;
 return durable;
}

test('same-identity bind repairs legacy derived safety without rewriting source, author records or durable files',async t=>{
 const f=await fixture(t),segment=f.app.core.getState().segments[0];await f.app.saveDraft({segmentId:segment.id,language:'zh-CN',text:segment.source,expectedRevision:0});
 await f.app.createRequest({kind:'translation',segmentIds:[segment.id],language:'zh-CN',bindingId:`desktop:${f.selection.threadId}`});
 await f.desktop.bind({app:f.app,project:f.project,selection:f.selection});const legacy=await legacyProfile(f),before=await readFile(f.stateFile),workflow=await readFile(f.workflow),records=authorRecord(legacy);
 await f.desktop.bind({app:f.app,project:f.project,selection:f.selection});
 const state=f.app.getState(),profile=state.project.inlineStructureSafety;
 assert.equal(profile.policyVersion,2);assert.equal(profile.literalSyntaxStable,true);assert.notEqual(profile.unboundedBindings,true);assert.match(profile.analysisFingerprint,/^[a-f0-9]{64}$/u);
 assert(state.readingParagraphs.some(row=>row.writableSource===true));assert.equal(f.app.core._literalProjectSafe(),true);assert.equal(f.factories(),1);
 assert.equal(authorRecord(f.app.core.getState()),records);assert.deepEqual(await readFile(f.stateFile),before);assert.deepEqual(await readFile(f.workflow),workflow);
});

test('every durable reload normalizes a same-snapshot legacy profile in memory, without new requests or commits',async t=>{
 const f=await fixture(t),legacy=await legacyProfile(f),before=await readFile(f.stateFile),eventSeq=legacy.eventSeq;
 for(let attempt=0;attempt<2;attempt++)await f.app.core._serial(()=>{const state=f.app.core.getState();assert.equal(state.project.inlineStructureSafety.policyVersion,2);assert.equal(state.project.inlineStructureSafety.literalSyntaxStable,true);assert.equal(state.eventSeq,eventSeq);assert.equal(authorRecord(state),authorRecord(legacy));});
 assert.deepEqual(await readFile(f.stateFile),before);
});

test('a legacy cached reading projection cannot hide repaired same-snapshot source eligibility',async t=>{
 const f=await fixture(t),legacy=await legacyProfile(f),before=await readFile(f.stateFile),bad=f.app.reading.derive(legacy);
 assert(bad.paragraphs.every(row=>!row.writableSource));
 f.app.reading.cache={...bad,key:`${legacy.project.snapshotId}:${legacy.readingAnchorRevision||0}`};
 const repaired=f.app.getState();assert.equal(repaired.project.inlineStructureSafety.policyVersion,2);assert(repaired.readingParagraphs.some(row=>row.writableSource));
 assert.deepEqual(await readFile(f.stateFile),before);
});

test('an unproved captured manifest never clears a legacy unsafe profile',async t=>{
 const f=await fixture(t),legacy=await legacyProfile(f);legacy.project.files[0].hash='0'.repeat(64);f.app.core._state=legacy;
 const state=f.app.core.getState();assert.equal(state.project.inlineStructureSafety.unboundedBindings,true);assert.equal(state.project.inlineStructureSafety.safe,false);assert.equal(f.app.core._literalProjectSafe(),false);
});

test('actual unbounded lexical staging remains denied after current-policy refresh',async t=>{
 const f=await fixture(t,String.raw`\catcode\`\@=11`);const state=f.app.getState();assert.equal(state.project.inlineStructureSafety.unboundedBindings,true);assert.equal(f.app.core._literalProjectSafe(),false);assert(state.readingParagraphs.every(row=>!row.writableSource));
});
