import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {PaperApplication,buildInputHash} from '../src/application.mjs';
import {randomUUID} from 'node:crypto';
import {sha256} from '../src/latex.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createPaperServer} from '../src/server.mjs';

async function fixture(t,{source='A precise claim has $M$ choices on $n$ qubits and costs $\\Omega(\\sqrt n)$ with \\cite{one}.',draft='结论有 $M$ 个选择和 $n$ 比特，代价 $\\Omega(\\sqrt n)$，引用 \\cite{one}。',compiled=false}={}){
 const owned=path.resolve('work/paragraph-math-tests');await mkdir(owned,{recursive:true});const directory=await mkdtemp(path.join(owned,'case-')),root=path.join(directory,'source');await mkdir(root);
 const tex='\\documentclass{article}\n\\begin{document}\n\n'+source+'\n\n\\begin{thebibliography}{9}\n\\bibitem{one} First.\n\\bibitem{two} Second.\n\\end{thebibliography}\n\\end{document}\n';await writeFile(path.join(root,'main.tex'),tex);
 const compiler=compiled?{probe:async()=>({available:true,isolated:true}),build:async input=>{const pdfPath=path.join(directory,`build-${randomUUID()}.pdf`);await writeFile(pdfPath,'%PDF-synthetic-paragraph-math-test');return{buildId:`build-${randomUUID()}`,status:'success',snapshotId:input.snapshotId,candidateHash:input.candidateHash,inputHash:buildInputHash(input),pdfPath,pdfHash:sha256(await readFile(pdfPath)),isolation:{verified:true}};}}:undefined;
 const app=new PaperApplication({dataRoot:path.join(directory,'private'),compiler});await app.initialize();await app.openProject({root,mainFile:'main.tex'});t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
 const paragraph=app.getState().readingParagraphs.find(p=>p.source.includes('precise claim'));assert(paragraph);await app.saveDraft({segmentId:paragraph.id,language:'zh-CN',text:draft,expectedRevision:0});
 const current=()=>app.getState().translations['zh-CN'][paragraph.id];const save=text=>app.saveTranslationDraftWithFormulaEdits({segmentId:paragraph.id,language:'zh-CN',text,expectedRevision:current().revision,expectedProjectId:app.getState().project.id,expectedSnapshotId:app.getState().project.snapshotId});
 const request=(extra={})=>app.createRequest({kind:'revision',segmentIds:[paragraph.id],language:'zh-CN',...extra});
 return{app,root,tex,paragraph,draft,current,save,request};
}
const submit=(f,r,replacement=r.segments[0].text)=>f.app.proposeRevision({requestId:r.requestId,reason:'Use the complete author math inventory in this selected paragraph.',edits:[{segmentId:f.paragraph.id,beforeHash:f.paragraph.beforeHash,replacement}]});

test('a human whole-paragraph rewrite captures exact reordered and added math without guessing token correspondence',async t=>{
 const f=await fixture(t),text='对 $n$ 比特的 $M$ 个查询，成功概率 $2/3$，满足 $N(n,M)=\\Omega\\!\\left(\\sqrt{\\min\\{n,M\\}}\\right)$，引用 \\cite{one}。';await f.save(text);assert(f.current().formulaEditUnmapped);
 const r=await f.request(),selected=r.segments[0];assert.equal(selected.paragraphMathIntent.mode,'complete-draft-inventory');assert.equal(selected.paragraphMathIntent.draftRevision,f.current().revision);
 assert.deepEqual(selected.mathReview.before,['$M$','$n$','$\\Omega(\\sqrt n)$']);assert.deepEqual(selected.mathReview.after,['$n$','$M$','$2/3$','$N(n,M)=\\Omega\\!\\left(\\sqrt{\\min\\{n,M\\}}\\right)$']);
 assert.equal(selected.originalSource,f.paragraph.source);assert.equal(selected.protectedTokens.filter(p=>p.raw.startsWith('$')).length,4);assert(!selected.formulaEdits?.length);
 const p=await submit(f,r);assert(p.edits[0].replacement.includes('$2/3$'));assert(p.edits[0].replacement.includes('\\cite{one}'));await f.app.core.previewTransaction({proposalIds:[p.proposalId]});assert.equal(await readFile(path.join(f.root,'main.tex'),'utf8'),f.tex);
});

test('the model cannot add, omit, change, duplicate or reorder the author math inventory',async t=>{
 const f=await fixture(t);await f.save(f.draft+' 新增 $2/3$。');const r=await f.request(),s=r.segments[0],first=s.protectedTokens[0].id,last=s.protectedTokens.at(-1).id;
 for(const value of[s.text+' $z=9$',s.text.replace(first,''),s.text.replace(first,first+first),s.text.replace(first,'$M+1$'),s.text.replace(first,'TEMP').replace(last,first).replace('TEMP',last)])await assert.rejects(submit(f,r,value),e=>['PROTECTED_TOKEN_CHANGED','UNSUPPORTED_TEX'].includes(e.code));
 assert.equal(f.app.getState().proposals.length,0);
});

test('any later text edit or undo revokes pending and compiled paragraph math authority',async t=>{
 const f=await fixture(t);await f.save(f.draft+' 新增 $2/3$。');let r=await f.request(),p=await submit(f,r);await f.app.core.previewTransaction({proposalIds:[p.proposalId]});await f.save(f.current().text.replace('新增','补充'));
 await assert.rejects(f.app.core.previewTransaction({proposalIds:[p.proposalId]}),{code:'VERSION_CONFLICT'});
 r=await f.request();await f.save(f.draft);await assert.rejects(submit(f,r),{code:'VERSION_CONFLICT'});
});

test('unmapped AI drafts, unsafe or unknown new controls and altered nested label/reference footprints do not grant math authority',async t=>{
 const f=await fixture(t);await f.save(f.draft+' 新增 $2/3$。');const state=f.app.core.getState(),key=state.readingDrafts?.['zh-CN']?.[f.paragraph.id]?'readingDrafts':'translations';state[key]['zh-CN'][f.paragraph.id].origin='ai';await f.app.core._commit(state);const ai=await f.request();assert.equal(ai.segments[0].paragraphMathIntent,undefined);assert.equal(ai.segments[0].mathReview,undefined);assert.deepEqual(ai.segments[0].protectedTokens.map(t=>t.raw),f.paragraph.protectedTokens.map(t=>t.raw));await assert.rejects(submit(f,ai,ai.segments[0].text+' $2/3$'),{code:'UNSUPPORTED_TEX'});
 for(const raw of['$\\input{secret}$','$\\UnseenControl{x}$']){const g=await fixture(t),text=g.draft+' '+raw,saved=await g.save(text);assert.equal(saved.draft.text,text);assert.equal(saved.sourceCandidateAvailable,false);assert(saved.draft.formulaEditUnmapped||saved.draft.sourceReviewRequired);const r=await g.request();assert.equal(r.segments[0].paragraphMathIntent,undefined);assert.deepEqual(r.segments[0].protectedTokens.map(t=>t.raw),g.paragraph.protectedTokens.map(t=>t.raw));await assert.rejects(submit(g,r,r.segments[0].text+' '+raw),e=>['UNSUPPORTED_TEX','PROTECTED_TOKEN_CHANGED'].includes(e.code));assert.equal(await readFile(path.join(g.root,'main.tex'),'utf8'),g.tex);}
 const h=await fixture(t,{source:'A precise claim keeps $x\\label{eq:one}$ with \\cite{one}.',draft:'结论 $x\\label{eq:one}$，引用 \\cite{one}。'}),saved=await h.save('改写 $y$，引用 \\cite{one}。');assert.equal(saved.draft.sourceReviewRequired,true);const r=await h.request(),labeled=r.segments[0].protectedTokens.find(t=>t.raw.includes('\\label{eq:one}'));assert(labeled);assert.equal(r.segments[0].paragraphMathIntent,undefined);await assert.rejects(submit(h,r,r.segments[0].text.replace(labeled.id,'')),{code:'PROTECTED_TOKEN_CHANGED'});
});

test('paragraph math inventory composes with separately validated citation edits and rejects raw replacement tampering',async t=>{
 const f=await fixture(t);await f.save(f.draft.replace('\\cite{one}','\\cite{two}')+' 新增 $2/3$。');const r=await f.request();assert.equal(r.segments[0].referenceEdits.length,1);assert(r.segments[0].protectedTokens.some(p=>p.raw==='\\cite{two}'));const p=await submit(f,r);
 const state=f.app.core.getState();state.proposals.find(x=>x.proposalId===p.proposalId).edits[0].replacement=state.proposals.find(x=>x.proposalId===p.proposalId).edits[0].replacement.replace('$2/3$','$3/4$');await f.app.core._commit(state);await assert.rejects(f.app.core.previewTransaction({proposalIds:[p.proposalId]}),e=>['PROTECTED_TOKEN_CHANGED','UNSUPPORTED_TEX'].includes(e.code));
});

test('empty and repeated math lists are explicit inventory changes while immutable citations remain required',async t=>{
 const f=await fixture(t);await f.save('删去公式，引用 \\cite{one}。');const r=await f.request();assert(r.segments[0].protectedTokens.some(p=>p.raw==='\\cite{one}'));assert(r.segments[0].protectedTokens.filter(p=>p.raw==='').length===3);await submit(f,r);
 const g=await fixture(t);await g.save('重写 $n$ $n$ $2/3$，引用 \\cite{one}。');const repeated=await g.request();assert.deepEqual(repeated.segments[0].mathReview.after,['$n$','$n$','$2/3$']);await submit(g,repeated);
 const h=await fixture(t);await h.save(h.draft+' 新增 $2/3$。');await h.app.saveDraft({segmentId:h.paragraph.id,language:'zh-CN',text:'重写 $2/3$。',expectedRevision:h.current().revision});const protectedSource=await h.request(),citation=protectedSource.segments[0].protectedTokens.find(t=>t.raw==='\\cite{one}');assert(citation);assert.equal(protectedSource.segments[0].paragraphMathIntent,undefined);assert(!protectedSource.segments[0].protectedTokens.some(t=>t.raw==='$2/3$'));await assert.rejects(submit(h,protectedSource,protectedSource.segments[0].text.replace(citation.id,'')),{code:'PROTECTED_TOKEN_CHANGED'});
});

test('labeled mathematical inventory may change its body but cannot drop its numbered environment',async t=>{
 const body='A precise claim uses \\[x\\label{eq:one}\\] with \\cite{one}.',draft='结论 \\[x\\label{eq:one}\\]，引用 \\cite{one}。';
 const f=await fixture(t,{source:body,draft});await f.save('完整改写 \\[y\\label{eq:one}\\] 以及 $2/3$，引用 \\cite{one}。');assert((await f.request()).segments[0].paragraphMathIntent);
 const g=await fixture(t,{source:body,draft}),saved=await g.save('完整改写 $y\\label{eq:one}$ 以及 $2/3$，引用 \\cite{one}。');assert.equal(saved.sourceCandidateAvailable,false);assert(saved.draft.formulaEditUnmapped||saved.draft.sourceReviewRequired);const baseline=await g.request(),label=baseline.segments[0].protectedTokens.find(t=>t.raw==='\\[x\\label{eq:one}\\]');assert(label);assert.equal(baseline.segments[0].paragraphMathIntent,undefined);await assert.rejects(submit(g,baseline,baseline.segments[0].text.replace(label.id,'$y\\label{eq:one}$')),{code:'PROTECTED_TOKEN_CHANGED'});
});

test('native approved request packets expose the complete human inventory and read-only original without changing source',async t=>{
 const f=await fixture(t);await f.save(f.draft+' 新增 $2/3$。');const binding='synthetic-paragraph-math',r=await f.request({bindingId:binding}),server=createPaperServer({service:f.app,instanceId:binding,uiHtml:'<!doctype html>'}),client=new Client({name:binding,version:'1'}),[c,s]=InMemoryTransport.createLinkedPair();await server.connect(s);await client.connect(c);
 try{const result=await client.callTool({name:'bilingual_paper_get_request',arguments:{requestId:r.requestId}});assert.notEqual(result.isError,true);const selected=result.structuredContent.segments[0];assert.deepEqual(selected.mathReview,r.segments[0].mathReview);assert.equal(selected.originalSource,f.paragraph.source);assert.equal(selected.paragraphMathIntent.draftHash,r.segments[0].paragraphMathIntent.draftHash);assert.equal(await readFile(path.join(f.root,'main.tex'),'utf8'),f.tex);}finally{await client.close();await server.close();}
});

test('editing a saved paragraph invalidates its compiled human confirmation before any source write',async t=>{
 const f=await fixture(t,{compiled:true});await f.save(f.draft+' 新增 $2/3$。');const r=await f.request(),p=await submit(f,r),preview=await f.app.previewTransaction({proposalIds:[p.proposalId]});await f.app.waitJob(preview);const acceptance=await f.app.prepareAcceptance(preview);await f.save(f.current().text.replace('新增','补充'));
 await assert.rejects(f.app.applyTransaction({transactionId:preview.transactionId,confirmationToken:acceptance.confirmationToken,idempotencyKey:'obsolete-paragraph-math'}),{code:'VERSION_CONFLICT'});assert.equal(await readFile(path.join(f.root,'main.tex'),'utf8'),f.tex);
});

test('forged request inventory or baseline metadata never expands the exact human grant',async t=>{
 for(const change of[selected=>{selected.paragraphMathIntent.projectId='foreign';},selected=>{selected.protectedTokens[0].raw='$invented$';},selected=>{selected.originalSource='Another paper.';},selected=>{selected.mathReview.after.push('$invented$');}]){
  const f=await fixture(t);await f.save(f.draft+' 新增 $2/3$。');const r=await f.request(),state=f.app.core.getState();change(state.requests.find(x=>x.requestId===r.requestId).segments[0]);await f.app.core._commit(state);await assert.rejects(submit(f,r),{code:'FORMULA_INTENT_CONFLICT'});assert.equal(f.app.getState().proposals.length,0);
 }
});

test('plain prose-only saved intent does not implicitly delete or replace protected source mathematics',async t=>{
 const f=await fixture(t);await f.app.saveDraft({segmentId:f.paragraph.id,language:'zh-CN',text:'请把这段的表达写清楚。',expectedRevision:f.current().revision});const r=await f.request();assert.equal(r.segments[0].paragraphMathIntent,undefined);assert.equal(r.segments[0].text,f.paragraph.displayText);assert.deepEqual(r.segments[0].protectedTokens,f.paragraph.protectedTokens);const p=await submit(f,r);assert(p.edits[0].replacement.includes('$M$'));assert(p.edits[0].replacement.includes('\\cite{one}'));
 const g=await fixture(t);await g.app.saveDraft({segmentId:g.paragraph.id,language:'zh-CN',text:'可讨论的新数学 $2/3$。',expectedRevision:g.current().revision});const ordinary=await g.request();assert.equal(ordinary.segments[0].paragraphMathIntent,undefined);await assert.rejects(submit(g,ordinary,ordinary.segments[0].text+' $2/3$'),{code:'UNSUPPORTED_TEX'});
});
