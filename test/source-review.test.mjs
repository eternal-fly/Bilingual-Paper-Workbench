import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PaperApplication,buildInputHash} from '../src/application.mjs';
import {CompilerWorker} from '../src/compiler/worker.mjs';
import {sha256} from '../src/latex.mjs';
import {validateSourceReviewReplacement} from '../src/source-review.mjs';
import {desktopRequestFingerprint} from '../src/desktop-execution.mjs';
import {VersionWorkflow} from '../src/version-workflow.mjs';

const original=String.raw`\documentclass{article}
\usepackage{amsmath,lmodern}
\expandafter\def\csname Opaque\endcsname#1{#1}
\begin{document}
A \Opaque{claim} keeps $x=1$ and its original meaning.

A separate paragraph stays unchanged.
\end{document}
`;
async function fixture(t,{real=false,compileFailure=false}={}){
 const owned=fileURLToPath(new URL('../work/source-review-tests/',import.meta.url));await mkdir(owned,{recursive:true});
 const directory=await mkdtemp(path.join(owned,'case-')),source=path.join(directory,'source');await mkdir(source);const file=path.join(source,'main.tex');await writeFile(file,original);
 const compiler=real?new CompilerWorker({dataRoot:path.join(directory,'compiler'),runtimeRoot:process.env.PAPER_EDITOR_TEST_RUNTIME}):{probe:async()=>({available:true,isolated:true}),build:async input=>{if(compileFailure)return{buildId:`build-${randomUUID()}`,status:'failed',code:'TEX_COMPILE_FAILED',snapshotId:input.snapshotId,candidateHash:input.candidateHash,inputHash:buildInputHash(input),isolation:{verified:true}};const pdfPath=path.join(directory,`build-${randomUUID()}.pdf`);await writeFile(pdfPath,`%PDF-synthetic-source-review-${input.inputHash}`);return{buildId:`build-${randomUUID()}`,status:'success',snapshotId:input.snapshotId,candidateHash:input.candidateHash,inputHash:buildInputHash(input),pdfPath,pdfHash:sha256(await readFile(pdfPath)),isolation:{verified:true}};}};
 const app=new PaperApplication({dataRoot:path.join(directory,'private'),compiler,engine:'pdflatex'});await app.initialize();await app.openProject({root:source,mainFile:'main.tex'});
 t.after(async()=>{await app.close();await Promise.allSettled([...app.jobs.values()].map(job=>job.promise));await rm(directory,{recursive:true,force:true});});
 return{app,file,source,directory,paragraph:app.getState().readingParagraphs.find(row=>row.source.includes('original meaning'))};
}
const create=(app,id)=>app.core.createRequest({kind:'revision',mode:'source-review',segmentIds:[id],language:'zh-CN',bindingId:'native:synthetic-source-review',prompt:'Adapt the exact saved author paragraph as a pending English TeX candidate.'});
const propose=(app,request,replacement)=>app.proposeRevision({requestId:request.requestId,reason:'Review the complete TeX diff before confirming.',edits:[{segmentId:request.segmentIds[0],beforeHash:request.segments[0].beforeHash,replacement}]});
const save=(app,input)=>{const project=app.getState().project;return app.saveTranslationDraftWithFormulaEdits({...input,expectedProjectId:project.id,expectedSnapshotId:project.snapshotId});};
async function preview(app,proposal){const queued=await app.previewTransaction({proposalIds:[proposal.proposalId]});const build=await app.waitJob({jobId:queued.jobId});return{...queued,build};}

test('Desktop fingerprints bind raw review mode and policy while retaining exact legacy identities',()=>{
 const legacy={requestId:'req-synthetic',projectId:'project-synthetic',snapshotId:'snap-synthetic',bindingId:'desktop:synthetic',kind:'revision',language:'zh-CN',prompt:'Revise.',segmentIds:['one'],segments:[{id:'one',text:'Original.'}],draftRevisions:{one:1},translationUnitRevisions:{one:1}},old=sha256(JSON.stringify(Object.fromEntries(['requestId','projectId','snapshotId','bindingId','kind','language','prompt','segmentIds','segments','draftRevisions','translationUnitRevisions'].map(key=>[key,legacy[key]??null]))));assert.equal(desktopRequestFingerprint(legacy),old);assert.equal(desktopRequestFingerprint({...legacy,mode:'protected'}),old);
 const raw={...legacy,mode:'source-review',sourceReview:{manifestHash:sha256('manifest'),requiresHumanSourceReview:true}};assert.notEqual(desktopRequestFingerprint(raw),old);assert.notEqual(desktopRequestFingerprint(raw),desktopRequestFingerprint({...raw,mode:'protected'}));assert.notEqual(desktopRequestFingerprint(raw),desktopRequestFingerprint({...raw,sourceReview:{...raw.sourceReview,instructions:'Changed registered instructions.'}}));
});

test('explicit source-review prepares an exact raw range without changing the protected default',async t=>{
 const{app,file,paragraph}=await fixture(t);assert.equal(paragraph.writableSource,false);const before=await readFile(file);
 await assert.rejects(app.createRequest({kind:'revision',segmentIds:[paragraph.id]}),error=>['UNSUPPORTED_TEX','SEGMENT_NOT_FOUND'].includes(error.code));
 const request=await create(app,paragraph.id),selected=request.segments[0];assert.equal(request.mode,'source-review');assert.equal(selected.text,paragraph.source);assert.equal(selected.rawSource,paragraph.source);assert.deepEqual(selected.protectedTokens,[]);assert.equal(selected.sourceAuthority.kind,'source-review-range-v1');assert.equal(selected.sourceAuthority.beforeHash,paragraph.sourceHash);assert.equal(selected.draftReview.mode,'raw-tex-source-review');assert.equal(request.sourceReview.requiresHumanSourceReview,true);assert.deepEqual(await readFile(file),before);
 await assert.rejects(app.core.createRequest({kind:'translation',mode:'source-review',segmentIds:[paragraph.id]}),{code:'INVALID_INPUT'});
});

test('generic new macros, environments, formulas and references remain pending and need explicit compiled human source review',async t=>{
 const{app,file,paragraph}=await fixture(t);const request=await create(app,paragraph.id),replacement=String.raw`\newcommand{\Fresh}[1]{\textit{#1}}A \Fresh{revised claim} with $x=2$ and \label{claim:new}.`;
 const proposal=await propose(app,request,replacement);assert.equal(proposal.reviewState,'pending');assert.equal(proposal.context.mode,'source-review');assert.equal(proposal.edits[0].replacement,replacement);assert.equal(await readFile(file,'utf8'),original);
 const candidate=app.core._candidate([proposal.proposalId]);assert.equal(candidate.requiresHumanSourceReview,true);assert.equal(candidate.sourceReview.edits[0].replacementHash,sha256(replacement));
 const built=await preview(app,proposal);assert.equal(built.build.status,'success');await assert.rejects(app.prepareAcceptance({transactionId:built.transactionId}),{code:'SOURCE_REVIEW_CONFIRMATION_REQUIRED'});
 const acceptance=await app.prepareAcceptance({transactionId:built.transactionId,sourceReviewConfirmed:true});assert.equal(acceptance.requiresHumanSourceReview,true);
 await app.applyTransaction({transactionId:built.transactionId,confirmationToken:acceptance.confirmationToken,idempotencyKey:'synthetic-raw-review'});assert.ok((await readFile(file,'utf8')).includes(replacement));
});

test('raw proposals cannot select other ranges, change bound source metadata or add direct external capability controls',async t=>{
 const{app,paragraph}=await fixture(t),request=await create(app,paragraph.id),source=request.segments[0].text;
 for(const replacement of[source+String.raw`\input{C:/private/secret.tex}`,source+String.raw`\input{../secret}`,source+String.raw`\openout1=secret`,source+String.raw`\write18{calc}`,source+String.raw`\directlua{os.execute('calc')}`,source+String.raw`\csname input\endcsname{C:/private/secret.tex}`,source+String.raw`\iffalse\csname openout\endcsname1=C:/private/out.txt\fi`])await assert.rejects(propose(app,request,replacement),{code:'SOURCE_REVIEW_CAPABILITY_DENIED'});
 await assert.rejects(app.proposeRevision({requestId:request.requestId,reason:'Foreign interval.',edits:[{segmentId:'foreign',beforeHash:request.segments[0].beforeHash,replacement:source}]}),{code:'PERMISSION_DENIED'});
 const proposal=await propose(app,request,source.replace('claim','revised claim'));
 await app.core._serial(async()=>{const state=app.core.getState();state.proposals.find(row=>row.proposalId===proposal.proposalId).edits[0].startByte++;await app.core._commit(state);});
 await assert.rejects(app.previewTransaction({proposalIds:[proposal.proposalId]}),{code:'VERSION_CONFLICT'});
});

test('source review preserves complete original auxiliary writes while refusing retargeted or added operations',()=>{
 const raw=String.raw`A claim. \immediate\write\@auxout{\string\citation{style}}`,source={source:raw,path:'main.tex'},files=new Map([['main.tex',{}]]);
 assert.equal(validateSourceReviewReplacement(source,raw.replace('claim','revised claim'),files),raw.replace('claim','revised claim'));
 for(const changed of[raw.replace('{style}','{other}'),raw+String.raw`\write\@auxout{\string\citation{style}}`,raw.replace('\\@auxout','18')])assert.throws(()=>validateSourceReviewReplacement(source,changed,files),{code:'SOURCE_REVIEW_CAPABILITY_DENIED'});
 assert.equal(validateSourceReviewReplacement(source,'An ordinary revised claim.',files),'An ordinary revised claim.');
 const inactive={source:String.raw`A claim.\iffalse\write18{calc}\fi`,path:'main.tex'};assert.throws(()=>validateSourceReviewReplacement(inactive,String.raw`A revised claim.\write18{calc}`,files),{code:'SOURCE_REVIEW_CAPABILITY_DENIED'});
 for(const encoded of['A claim.\\iffalse\\csname in% comment\nput\\endcsname{C:/private/secret.tex}\\fi',String.raw`A claim.\iffalse\in^^70ut{C:/private/secret.tex}\fi`])assert.throws(()=>validateSourceReviewReplacement({source:'A claim.',path:'main.tex'},encoded,files),{code:'SOURCE_REVIEW_CAPABILITY_DENIED'});
});

test('changed author drafts and captured manifest/source drift invalidate a compiled raw candidate',async t=>{
 const{app,paragraph}=await fixture(t);await save(app,{segmentId:paragraph.id,language:'zh-CN',text:'作者的原始意图。',expectedRevision:0});
 const request=await create(app,paragraph.id),proposal=await propose(app,request,request.segments[0].text.replace('claim','revised claim')),built=await preview(app,proposal);
 const draft=app.getState().translations['zh-CN'][paragraph.id];await save(app,{segmentId:paragraph.id,language:'zh-CN',text:'更新的作者意图。',expectedRevision:draft.revision});
 await assert.rejects(app.prepareAcceptance({transactionId:built.transactionId,sourceReviewConfirmed:true}),{code:'VERSION_CONFLICT'});
});

test('external source drift, forged manifest authority and overlapping raw selections fail without publishing a proposal',async t=>{
 const{app,file,paragraph}=await fixture(t),request=await create(app,paragraph.id),before=await readFile(file);await writeFile(file,Buffer.concat([before,Buffer.from('% external synthetic drift\n')]));await assert.rejects(propose(app,request,request.segments[0].text.replace('claim','revised claim')),{code:'VERSION_CONFLICT'});assert.equal(app.getState().proposals.filter(row=>row.author==='ai').length,0);await writeFile(file,before);
 await app.core._serial(async()=>{const state=app.core.getState();state.requests.find(row=>row.requestId===request.requestId).segments[0].sourceAuthority.manifestHash=sha256('foreign manifest');await app.core._commit(state);});await assert.rejects(propose(app,request,request.segments[0].text),{code:'VERSION_CONFLICT'});
 await app.core._serial(async()=>{const state=app.core.getState(),anchor=state.readingAnchors.find(row=>row.id===paragraph.id);state.readingAnchors.push({...anchor,id:'read-synthetic-overlap'});await app.core._commit(state);});const count=app.getState().requests.length;await assert.rejects(app.core.createRequest({kind:'revision',mode:'source-review',segmentIds:[paragraph.id,'read-synthetic-overlap']}),{code:'OVERLAPPING_EDITS'});assert.equal(app.getState().requests.length,count);
});

test('compiled raw candidate swaps and revoked final callbacks never write or publish',async t=>{
 const{app,file,paragraph}=await fixture(t),request=await create(app,paragraph.id);await assert.rejects(app.proposeRevision({requestId:request.requestId,reason:'Revoked callback.',edits:[{segmentId:paragraph.id,beforeHash:paragraph.sourceHash,replacement:request.segments[0].text}]},{beforeWrite:()=>{throw Object.assign(new Error('Caller revoked.'),{code:'NATIVE_CALLER_REVOKED'});}}),{code:'NATIVE_CALLER_REVOKED'});assert.equal(app.getState().proposals.filter(row=>row.author==='ai').length,0);
 const proposal=await propose(app,request,request.segments[0].text.replace('claim','first claim')),built=await preview(app,proposal),acceptance=await app.prepareAcceptance({transactionId:built.transactionId,sourceReviewConfirmed:true});await app.core._serial(async()=>{const state=app.core.getState();state.proposals.find(row=>row.proposalId===proposal.proposalId).edits[0].replacement+=' Another uncompiled sentence.';await app.core._commit(state);});await assert.rejects(app.applyTransaction({transactionId:built.transactionId,confirmationToken:acceptance.confirmationToken,idempotencyKey:'swapped-raw-refusal'}),{code:'CANDIDATE_HASH_MISMATCH'});assert.equal(await readFile(file,'utf8'),original);
});

test('failed isolated compilation cannot issue raw source acceptance or change any source bytes',async t=>{
 const{app,file,paragraph}=await fixture(t,{compileFailure:true}),request=await create(app,paragraph.id),proposal=await propose(app,request,request.segments[0].text+' \\badunclosed{'),built=await preview(app,proposal);
 assert.equal(built.build.status,'failed');await assert.rejects(app.prepareAcceptance({transactionId:built.transactionId,sourceReviewConfirmed:true}),{code:'ACCEPTANCE_NOT_READY'});assert.equal(await readFile(file,'utf8'),original);
});

test('raw candidate editing revalidates the same mode and exact source scope',async t=>{
 const{app,paragraph}=await fixture(t),request=await create(app,paragraph.id),proposal=await propose(app,request,request.segments[0].text.replace('claim','first claim'));
 const revised=await app.editProposal({proposalId:proposal.proposalId,edits:[{segmentId:paragraph.id,replacement:String.raw`A \Opaque{second claim} includes \newcommand{\Local}{local}\Local.`}]});
 assert.equal(revised.context.mode,'source-review');assert.ok(app.core._candidate([revised.proposalId]).requiresHumanSourceReview);await assert.rejects(app.editProposal({proposalId:revised.proposalId,edits:[{segmentId:paragraph.id,replacement:String.raw`\input{outside.tex}`}]}),{code:'SOURCE_REVIEW_CAPABILITY_DENIED'});
});

test('a confirmed empty raw range retains only its exact insertion point for a later cycle and undo',async t=>{
 const{app,file,paragraph}=await fixture(t);await save(app,{segmentId:paragraph.id,language:'zh-CN',text:'删除这一段，保留草稿记录。',expectedRevision:0});
 const first=await create(app,paragraph.id),deleted=await propose(app,first,''),built=await preview(app,deleted),acceptance=await app.prepareAcceptance({transactionId:built.transactionId,sourceReviewConfirmed:true});await app.applyTransaction({transactionId:built.transactionId,confirmationToken:acceptance.confirmationToken,idempotencyKey:'delete-raw-paragraph'});
 const empty=app.getState().readingParagraphs.find(row=>row.id===paragraph.id);assert.equal(empty?.source,'');assert.equal(empty.sourceReviewAvailable,true);const draft=app.getState().translations['zh-CN'][paragraph.id];assert.equal(draft.status,'saved');
 await save(app,{segmentId:paragraph.id,language:'zh-CN',text:'在原位置恢复改写后的段落。',expectedRevision:draft.revision});const second=await create(app,paragraph.id),restored=await propose(app,second,'A restored claim at the exact confirmed insertion point.'),rebuilt=await preview(app,restored),reaccept=await app.prepareAcceptance({transactionId:rebuilt.transactionId,sourceReviewConfirmed:true});await app.applyTransaction({transactionId:rebuilt.transactionId,confirmationToken:reaccept.confirmationToken,idempotencyKey:'restore-raw-paragraph'});
 assert.ok((await readFile(file,'utf8')).includes('A restored claim at the exact confirmed insertion point.'));assert.equal(app.getState().readingParagraphs.filter(row=>row.id===paragraph.id).length,1);
 const inverse=await app.createUndoProposal({transactionId:rebuilt.transactionId}),inverseBuild=await preview(app,inverse),inverseAcceptance=await app.prepareAcceptance({transactionId:inverseBuild.transactionId});await app.applyTransaction({transactionId:inverseBuild.transactionId,confirmationToken:inverseAcceptance.confirmationToken,idempotencyKey:'restore-empty-point'});assert.equal(app.getState().readingParagraphs.find(row=>row.id===paragraph.id)?.source,'');
});

test('actual isolated raw source review supports two confirmed cycles, preserves unresolved draft, and undo', {skip:!process.env.PAPER_EDITOR_TEST_RUNTIME},async t=>{
 const{app,file,paragraph,directory,source}=await fixture(t,{real:true}),contextDir=path.join(directory,'author-pdfs');app.versionPair=new VersionWorkflow(app,{contextDir});const baseline=await app.compileEnglish();assert.equal((await app.waitJob({jobId:baseline.jobId})).status,'success');const firstPair=await app.readVersionPair();let previousPdf=firstPair.latest.hash;
 await app.core._serial(async()=>{const state=app.core.getState();state.reviewNotes=[{noteId:'synthetic-raw-review-one',body:'Clarify the selected claim.',decision:'pending',revision:1,sourceSnapshotId:state.project.snapshotId},{noteId:'synthetic-raw-review-two',body:'Keep the independent paragraph.',decision:'keep',revision:1,sourceSnapshotId:state.project.snapshotId}];await app.core._commit(state);});const reviews=structuredClone(app.core.getState().reviewNotes);let id=paragraph.id,revision=0;let last;
 for(const[turn,replacement]of [String.raw`\newcommand{\Fresh}[1]{\textit{#1}}A \Fresh{revised claim} keeps $x=2$ and \label{claim:new}.`,String.raw`A \Opaque{final claim} uses \begin{math}\frac{1}{2}\end{math} and \ref{claim:new}.`].entries()){
  const saved=await save(app,{segmentId:id,language:'zh-CN',text:`第${turn+1}次意图，\\Unknown{保留原样}。`,expectedRevision:revision});revision=saved.draft.revision;
  const request=await create(app,id),proposal=await propose(app,request,replacement),built=await preview(app,proposal);assert.equal(built.build.status,'success',JSON.stringify(built.build));const accepted=await app.prepareAcceptance({transactionId:built.transactionId,sourceReviewConfirmed:true});const applied=await app.applyTransaction({transactionId:built.transactionId,confirmationToken:accepted.confirmationToken,idempotencyKey:`actual-raw-${turn}`});if(applied.englishPdfJobId)assert.equal((await app.waitJob({jobId:applied.englishPdfJobId})).status,'success');
  const draft=app.getState().translations['zh-CN'][id];assert.equal(draft.text,saved.draft.text);assert.equal(draft.sourceReviewRequired,true);assert.equal(draft.status,'saved');assert.equal(draft.sourceWritebackReceipt,undefined);revision=draft.revision;assert.ok((await readFile(file,'utf8')).includes(replacement));const pair=await app.readVersionPair();assert.equal(pair.latest.snapshotId,app.getState().project.snapshotId);assert.equal(pair.latest.hash,built.build.pdfHash);assert.notEqual(pair.latest.hash,previousPdf);assert.equal(pair.original.hash,firstPair.original.hash);previousPdf=pair.latest.hash;assert.deepEqual(app.core.getState().reviewNotes,reviews);last=built;
 }
 const inverse=await app.createUndoProposal({transactionId:last.transactionId});const queued=await preview(app,inverse);assert.equal(queued.build.status,'success');const acceptance=await app.prepareAcceptance({transactionId:queued.transactionId});const undone=await app.applyTransaction({transactionId:queued.transactionId,confirmationToken:acceptance.confirmationToken,idempotencyKey:'actual-raw-undo'});if(undone.englishPdfJobId)await app.waitJob({jobId:undone.englishPdfJobId});assert.ok((await readFile(file,'utf8')).includes('revised claim'));const finalPair=await app.readVersionPair();assert.equal(finalPair.latest.snapshotId,app.getState().project.snapshotId);assert.equal(finalPair.latest.hash,queued.build.pdfHash);assert.equal(finalPair.original.hash,firstPair.original.hash);assert.deepEqual((await readdir(contextDir)).sort(),['latest-english.pdf','original.pdf']);
 const finalState=app.getState(),rawBefore=app.core.getState(),sourceBefore=await readFile(file);await app.close();const reopened=new PaperApplication({dataRoot:path.join(directory,'private'),compiler:new CompilerWorker({dataRoot:path.join(directory,'compiler'),runtimeRoot:process.env.PAPER_EDITOR_TEST_RUNTIME}),engine:'pdflatex'});try{await reopened.initialize();await reopened.openProject({root:source,mainFile:'main.tex'});reopened.versionPair=new VersionWorkflow(reopened,{contextDir});assert.deepEqual(await readFile(file),sourceBefore);assert.deepEqual(reopened.getState().translations,finalState.translations);assert.deepEqual(reopened.core.getState().reviewNotes,reviews);assert.deepEqual(reopened.core.getState().sourceReviewAnchors,rawBefore.sourceReviewAnchors);assert.ok(reopened.getState().readingParagraphs.some(row=>row.id===id&&row.sourceReviewAvailable));const reopenedPair=await reopened.readVersionPair();assert.equal(reopenedPair.latest.hash,finalPair.latest.hash);assert.equal(reopenedPair.original.hash,firstPair.original.hash);assert.deepEqual((await readdir(contextDir)).sort(),['latest-english.pdf','original.pdf']);}finally{await reopened.close();}
});
