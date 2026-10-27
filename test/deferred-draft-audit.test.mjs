import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PaperApplication,buildInputHash} from '../src/application.mjs';
import {sha256} from '../src/latex.mjs';
import {editorDraftsFor} from '../src/editor-drafts.mjs';
import {deriveEnglishWriteback} from '../ui/writeback-state.mjs';

async function fixture(t,{style=String.raw`\def\unrelated{opaque}`,nested=false}={}){
 const owned=path.resolve('work/deferred-draft-audit');await mkdir(owned,{recursive:true});const temp=await mkdtemp(path.join(owned,'case-')),root=path.join(temp,'source'),dataRoot=path.join(temp,'private');await mkdir(root);
 let original=String.raw`\documentclass{article}
\usepackage{custom}
\begin{document}

A~precise~claim~keeps \textbf{bold text} and $x=1$ with \cite{A}; see \eqref{eq:one}.

\begin{equation}x=1\label{eq:one}\end{equation}
\bibliography{refs}
\end{document}
`;
 if(nested)original=original.replace(String.raw`\textbf{bold text}`,String.raw`\textit{outer \textbf{bold text}}`);
 await writeFile(path.join(root,'main.tex'),original);await writeFile(path.join(root,'custom.sty'),style);await writeFile(path.join(root,'refs.bib'),'@article{A,title={Synthetic reference}}\n');
 let failCompile=false,app;
 const compiler={probe:async()=>({available:true,isolated:true}),build:async input=>{if(failCompile)throw Object.assign(Error('Synthetic candidate compilation failed.'),{code:'SYNTHETIC_COMPILE_FAILURE'});const pdfPath=path.join(temp,randomUUID()+'.pdf');await writeFile(pdfPath,'%PDF-synthetic-deferred');return{buildId:randomUUID(),status:'success',snapshotId:input.snapshotId,candidateHash:input.candidateHash,inputHash:buildInputHash(input),pdfPath,pdfHash:sha256(await readFile(pdfPath)),isolation:{verified:true}};}};
 const open=async()=>{app=new PaperApplication({dataRoot,compiler});await app.initialize();await app.openProject({root,mainFile:'main.tex'});};await open();
 t.after(async()=>{await app.close();await Promise.allSettled([...app.jobs.values()].map(j=>j.promise));assert(temp.startsWith(owned+path.sep));await rm(temp,{recursive:true,force:true});});
 const id=app.getState().readingParagraphs.find(p=>p.source.startsWith('A~precise')).id,base=String.raw`准确~结论~保留~\textbf{粗体} 和 $x=1$，引用 \cite{A}；见 \eqref{eq:one}。`,initial=nested?base.replace(String.raw`\textbf{粗体}`,String.raw`\textit{外层 \textbf{粗体}}`):base;
 await app.saveDraft({segmentId:id,language:'zh-CN',text:initial,expectedRevision:0});
 return{get app(){return app;},root,id,original,initial,current:()=>app.getState().translations['zh-CN'][id],source:()=>readFile(path.join(root,'main.tex'),'utf8'),setCompileFailure:value=>{failCompile=value;},async reopen(){await app.close();await open();},save(text,extra={}){const s=app.getState();return app.saveTranslationDraftWithFormulaEdits({segmentId:id,language:'zh-CN',text,expectedRevision:s.translations['zh-CN'][id].revision,expectedProjectId:s.project.id,expectedSnapshotId:s.project.snapshotId,...extra});}};
}
const request=f=>f.app.createRequest({kind:'revision',language:'zh-CN',segmentIds:[f.id]});
async function proposal(f,r=undefined){r||=await request(f);const selected=r.segments[0];return f.app.proposeRevision({requestId:r.requestId,reason:'Review the exact saved author draft against its registered protected source inventory.',edits:[{segmentId:f.id,beforeHash:selected.beforeHash,replacement:selected.text.replace('准确','Accurate').replace('结论','claim').replace('保留','keeps').replace('粗体','bold')}]});}
async function apply(f,p){const preview=await f.app.previewTransaction({proposalIds:[p.proposalId]});await f.app.waitJob({jobId:preview.jobId});const grant=await f.app.prepareAcceptance({transactionId:preview.transactionId}),result=await f.app.applyTransaction({transactionId:preview.transactionId,confirmationToken:grant.confirmationToken,idempotencyKey:randomUUID()});if(result.englishPdfJobId)await f.app.waitJob({jobId:result.englishPdfJobId});assert.equal(result.state,'applied');return result;}

test('bounded incomplete and unknown structural author text persists exactly and reopens without source authority',async t=>{
 const f=await fixture(t);assert.equal(f.app.getState().project.inlineStructureSafety.safe,false);
 for(const suffix of[String.raw` \textsf{unfinished`,String.raw` \unknown{draft}`,String.raw` \input{private}`,String.raw` $x=4`,String.raw` \label{new}`]){
  const text=f.initial+suffix,before=f.current(),r=await f.save(text);assert.equal(r.draft.text,text);assert.equal(r.draft.revision,before.revision+1);assert.equal(r.draft.status,'saved');assert.equal(r.draft.sourceReviewRequired,true);assert(r.diagnostics.length);assert(!r.draft.inlineStructureIntent&&!r.draft.formulaEdits?.length&&!r.draft.referenceEdits?.length&&!r.draft.sourceWritebackReceipt);assert.equal(await f.source(),f.original);
 }
 const before=f.current();await f.reopen();assert.equal(f.current().text,before.text);assert.equal(f.current().revision,before.revision);assert.equal(f.current().sourceReviewRequired,true);
 await assert.rejects(f.save('foreign',{expectedProjectId:'foreign-project'}),{code:'VERSION_CONFLICT'});assert.deepEqual(f.current(),before);
});

test('deleting three existing spacing atoms works through repeated confirmed writes and undo despite unrelated macros',async t=>{
 const f=await fixture(t);assert.equal(f.app.getState().project.inlineStructureSafety.safe,false);const text=f.initial.replaceAll('~',' '),saved=await f.save(text);assert.equal(saved.draft.text,text);assert.equal(saved.sourceCandidateAvailable,true);
 const first=await apply(f,await proposal(f));assert(!f.current().sourceReviewRequired);assert(f.current().sourceWritebackReceipt);assert(!f.app.getState().readingParagraphs.find(p=>p.id===f.id).source.includes('~'));const firstSource=await f.source();
 const next=text.replace(String.raw`\textbf{粗体}`,'粗体');await f.save(next);await apply(f,await proposal(f));assert(!f.app.getState().readingParagraphs.find(p=>p.id===f.id).source.includes(String.raw`\textbf{`));
 const second=f.app.getState().transactions.find(tx=>tx.state==='applied'&&tx.transactionId!==first.transactionId);await apply(f,await f.app.createUndoProposal({transactionId:second.transactionId}));assert.equal(await f.source(),firstSource);assert.equal(f.current().text,next);assert.notEqual(f.current().sourceWritebackReceipt?.revision,f.current().revision);assert.notEqual(deriveEnglishWriteback(f.app.getState(),'zh-CN').mode,'empty');assert((await request(f)).requestId);
});

test('failed and partial adaptive source candidates preserve the exact unresolved draft through apply and reopen',async t=>{
 const f=await fixture(t),raw=f.initial+String.raw` \textsf{unfinished`;await f.save(raw);const r=await request(f),selected=r.segments[0];assert.equal(selected.draftReview.mode,'adaptive-human-draft');assert.equal(selected.draftReview.disposition,'preserve-source-protected-inventory');assert.equal(selected.translationDraft.text,raw);assert.equal(selected.draftReview.draftHash,sha256(raw));assert.equal(selected.draftReview.draftRevision,f.current().revision);assert(!selected.protectedTokens.some(p=>p.raw.includes('unfinished')));
 f.setCompileFailure(true);const before=f.current(),p=await proposal(f,r),preview=await f.app.previewTransaction({proposalIds:[p.proposalId]});assert.equal((await f.app.waitJob({jobId:preview.jobId})).status,'failed');await assert.rejects(f.app.prepareAcceptance({transactionId:preview.transactionId}));assert.deepEqual(f.current(),before);assert.equal(await f.source(),f.original);
 f.setCompileFailure(false);const partial=await apply(f,await proposal(f));assert.equal(f.current().text,raw);assert.equal(f.current().sourceReviewRequired,true);assert(!f.current().sourceWritebackReceipt);await apply(f,await f.app.createUndoProposal({transactionId:partial.transactionId}));assert.equal(await f.source(),f.original);assert.equal(f.current().text,raw);assert.equal(f.current().sourceReviewRequired,true);assert(!f.current().sourceWritebackReceipt);await f.reopen();assert.equal(f.current().text,raw);assert.equal(f.current().sourceReviewRequired,true);assert.equal((await request(f)).segments[0].draftReview.mode,'adaptive-human-draft');
 const repaired=await f.save(f.initial.replaceAll('~',' '));assert(!repaired.draft.sourceReviewRequired);await apply(f,await proposal(f));assert(!f.current().sourceReviewRequired);assert(f.current().sourceWritebackReceipt);
});

test('adaptive review never grants model file commands, new labels or changed protected citations and rejects newer draft races',async t=>{
 const f=await fixture(t);await f.save(f.initial+String.raw` \input{private}`);const r=await request(f),selected=r.segments[0],citation=selected.protectedTokens.find(p=>p.raw===String.raw`\cite{A}`);assert(citation);
 for(const replacement of[selected.text+String.raw` \input{private}`,selected.text+String.raw` \label{new}`,selected.text.replace(citation.id,'')])await assert.rejects(f.app.proposeRevision({requestId:r.requestId,reason:'Untrusted result.',edits:[{segmentId:f.id,beforeHash:selected.beforeHash,replacement}]}),e=>['UNSUPPORTED_TEX','PROTECTED_TOKEN_CHANGED'].includes(e.code));
 await f.save(f.current().text+' Later author text.');await assert.rejects(proposal(f,r),{code:'VERSION_CONFLICT'});assert.equal(await f.source(),f.original);assert(f.current().text.endsWith('Later author text.'));
});

test('native capture saves the fresh incomplete author buffer while later caller revocation preserves the durable draft',async t=>{
 const f=await fixture(t),store=editorDraftsFor(f.app),scope={expectedProjectId:f.app.getState().project.id,expectedSnapshotId:f.app.getState().project.snapshotId},clientId='synthetic-editor';let sequence=0,bufferSequence=1,text=f.initial+String.raw` \textbf{unfinished`;
 const publish=()=>{const p=store.poll({...scope,clientId});if(p.captureId)store.publish({...scope,clientId,sequence:++sequence,captureId:p.captureId,drafts:[{segmentId:f.id,language:'zh-CN',text,baseDraftRevision:f.current().revision,bufferSequence,saveState:'dirty',composing:false,sourceSnapshotId:scope.expectedSnapshotId,baseSourceHash:f.current().sourceHash}]});};
 store.poll({...scope,clientId});const timer=setInterval(publish,2);t.after(()=>{clearInterval(timer);store.close();});
 const capture=await store.read({...scope,segmentIds:[f.id],language:'zh-CN'}),row=capture.drafts[0];const saved=await store.save({...scope,captureId:capture.captureId,segmentId:f.id,language:'zh-CN',baseDraftRevision:row.baseDraftRevision,textHash:row.textHash});assert.equal(saved.draft.text,text);assert.equal(saved.draft.sourceReviewRequired,true);
 text+=' newer';bufferSequence++;const next=await store.read({...scope,segmentIds:[f.id],language:'zh-CN'}),before=f.current();await assert.rejects(store.save({...scope,captureId:next.captureId,segmentId:f.id,language:'zh-CN',baseDraftRevision:next.drafts[0].baseDraftRevision,textHash:next.drafts[0].textHash},{beforeWrite:async()=>{throw Object.assign(Error('Synthetic caller scope revoked.'),{code:'PERMISSION_DENIED'});}}),{code:'PERMISSION_DENIED'});assert.deepEqual(f.current(),before);assert.equal(await f.source(),f.original);
});

test('omission and adaptive candidates cannot retarget a surviving source formatter rebound to a file command',async t=>{
 for(const nested of[false,true]){
 const f=await fixture(t,{style:String.raw`\renewcommand{\textbf}[1]{\input{#1}}`,nested});
 for(const text of[f.initial.replaceAll('~',' '),f.initial+String.raw` \unknown{unfinished`]){
  await f.save(text);const r=await request(f),selected=r.segments[0],wrapper=selected.protectedTokens.find(p=>p.raw.includes(String.raw`\textbf{`));assert(wrapper);
  const replacement=wrapper.raw===String.raw`\textbf{`?selected.text.replace('粗体','foreign-file').replace('bold text','foreign-file'):selected.text.replace(wrapper.id,wrapper.raw.replace('bold text','foreign-file').replace('粗体','foreign-file'));assert.notEqual(replacement,selected.text);
  await assert.rejects(f.app.proposeRevision({requestId:r.requestId,reason:'Do not retarget an unproved source command argument.',edits:[{segmentId:f.id,beforeHash:selected.beforeHash,replacement}]}),e=>['UNSUPPORTED_TEX','PROTECTED_TOKEN_CHANGED','FORMULA_INTENT_CONFLICT'].includes(e.code));assert.equal(await f.source(),f.original);assert.equal(f.current().text,text);
 }
 }
});
