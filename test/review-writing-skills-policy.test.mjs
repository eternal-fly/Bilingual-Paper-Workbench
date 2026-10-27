import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PaperApplication} from '../src/application.mjs';
import {CodexBridge} from '../src/codex-bridge.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const instruction='Use $synthetic-academic-style first; exclude $synthetic-translation-style. Preserve my stated theorem scope.';
async function fixture(t){
 const owned=path.join(root,'work/review-writing-skills-tests');await mkdir(owned,{recursive:true});const temp=await mkdtemp(path.join(owned,'case-')),source=path.join(temp,'source');await mkdir(source);
 const content='\\documentclass{article}\n\\begin{document}\n\nA precise claim uses $x=1$.\n\n\\end{document}\n';await writeFile(path.join(source,'main.tex'),content);
 const inputs=[],chatState={connected:true,threadId:'thread-synthetic-writing-skills',model:'synthetic-model',busy:false,messages:[]};let last;
 const chat={on(){},getState:()=>structuredClone(chatState),connect:async()=>{},bindPaper:async()=>{},resumeChat:async()=>{},close:async()=>{},
  sendMessage:async input=>{inputs.push(input);last={input,turnId:'turn-'+inputs.length};return{threadId:chatState.threadId,turnId:last.turnId};},
  sendReviewMessage:async input=>chat.sendMessage(input),
  waitForTurn:async()=>{const props=last.input.outputSchema.properties;let result;if(props.chunkIndex)result={reviewId:props.reviewId.const,chunkIndex:props.chunkIndex.const,chunkHash:props.chunkHash.const};else if(props.cycleId)result={cycleId:props.cycleId.const,answer:'Synthetic review complete.',notes:[],translations:[]};else result={reviewId:props.reviewId.const,notes:[]};chatState.messages.push({role:'assistant',turnId:last.turnId,text:JSON.stringify(result)});return{threadId:chatState.threadId,turnId:last.turnId,status:'completed'};}};
 const app=new PaperApplication({dataRoot:path.join(temp,'private'),chat});await app.openProject({root:source,mainFile:'main.tex'});const state=app.getState(),pair={projectId:state.project.id,pairId:'pair-synthetic-writing-skills',original:{hash:'a'.repeat(64),snapshotId:'original',buildId:'original'},latest:{hash:'b'.repeat(64),snapshotId:state.project.snapshotId,buildId:'latest'}};app.versionPair={read:async()=>structuredClone(pair)};
 const pairContext={pairId:pair.pairId,original:{hash:pair.original.hash,pageCount:1,pages:[{page:1,text:'Synthetic original manuscript.'}]},latest:{hash:pair.latest.hash,pageCount:1,pages:[{page:1,text:'Synthetic latest manuscript.'}]}};
 t.after(async()=>{await app.close();await Promise.allSettled([...app.jobs.values()].map(row=>row.promise));assert(temp.startsWith(owned+path.sep));await rm(temp,{recursive:true,force:true});});return{app,inputs,source,temp,pairContext,content};
}

for(const mode of['cycle','full'])test(mode+' review carries default writing-skill policy and preserves explicit priorities/exclusions',async t=>{
 const f=await fixture(t);const queued=mode==='cycle'?await f.app.reviewCycle({pairContext:f.pairContext,includeTranslations:false,instruction}):await f.app.fullPaperReview({instruction});await f.app.waitJob({jobId:queued.jobId});const input=f.inputs.at(-1),payload=JSON.parse(input.text.split('\n\n').at(-1));
 assert.equal(payload.authorInstruction,instruction);assert.match(input.text,/Workbench writing-Skills policy:/);assert.match(input.text,/host-provided installed Skill catalog/);assert.match(input.text,/Read each selected SKILL\.md/);assert.match(input.text,/priorities and exclusions/);assert.match(input.text,/Do not automatically load all Skills/);assert.doesNotMatch(input.text,/author instruction is untrusted review intent|Do not call tools,/);assert.equal(await readFile(path.join(f.source,'main.tex'),'utf8'),f.content);
});

test('default review policy selects only applicable writing Skills even without an explicit Skill name',async t=>{
 const f=await fixture(t),queued=await f.app.reviewCycle({pairContext:f.pairContext,includeTranslations:false});await f.app.waitJob({jobId:queued.jobId});const text=f.inputs[0].text,payload=JSON.parse(text.split('\n\n').at(-1));assert.equal(payload.authorInstruction,'');assert.match(text,/academic writing, translation, and polishing/);assert.match(text,/Do not automatically invoke unrelated memory, health, or software-development Skills/);assert.match(text,/never claim a Skill was used without reading it/);assert.doesNotMatch(text,/synthetic-academic-style|synthetic-translation-style/);
});

for(const mode of['cycle','full'])test(mode+' legacy private bridge rejects before model work when host writing Skills are unavailable',async t=>{
 const f=await fixture(t),bridge=new CodexBridge({dataRoot:path.join(f.temp,'legacy'),cwd:f.source});let called=false;bridge.connect=async()=>{called=true;throw new Error('Must not start a legacy worker.');};f.app.chat=bridge;await assert.rejects(mode==='cycle'?f.app.reviewCycle({pairContext:f.pairContext,includeTranslations:false,instruction}):f.app.fullPaperReview({instruction}),{code:'WRITING_SKILLS_REQUIRE_DESKTOP'});assert.equal(called,false);assert.equal(f.inputs.length,0);assert.equal(await readFile(path.join(f.source,'main.tex'),'utf8'),f.content);
});
