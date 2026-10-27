import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PaperApplication} from '../src/application.mjs';
import {linkCompletedReviewImports} from '../src/review-import-continuity.mjs';
import {captureAdoptedReviewEvidence,deriveReviewCompletion} from '../src/review-completion.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
 const owned=path.resolve('work/review-import-continuity-tests');await mkdir(owned,{recursive:true});
 const directory=await mkdtemp(path.join(owned,'case-')),root=path.join(directory,'source');await mkdir(root);
 const filename=path.join(root,'main.tex'),text='\\documentclass{article}\n\\begin{document}\n\nAn original abstract states one bound.\n\nA separate theorem retains its assumptions.\n\n\\end{document}\n';await writeFile(filename,text);
 const app=new PaperApplication({dataRoot:path.join(directory,'private')});await app.initialize();await app.openProject({root,mainFile:'main.tex'});
 t.after(async()=>{await app.close();assert(directory.startsWith(owned+path.sep));await rm(directory,{recursive:true,force:true});});
 const body=JSON.stringify({notes:[{title:'Bound scope',body:'Clarify the original abstract bound.',quote:'An original abstract states one bound.'},{title:'Theorem assumption',body:'Name the independent assumption.',quote:'A separate theorem retains its assumptions.'}]}),upload={filename:'synthetic-review.json',format:'json',fileHash:sha(body),text:body};
 const first=await app.importReviewNotes(upload);
 const change=async()=>{await writeFile(filename,text.replace('one bound','a precise bound'));await app.refreshProject();};
 return{app,upload,first,filename,text,change};
}

test('identical review reimport after a paper edit reuses original opinion identities and decisions rather than duplicating the file',async t=>{
 const f=await fixture(t),note=f.first.notes[1];await f.app.setReviewDecision({noteId:note.noteId,expectedRevision:note.revision,decision:'keep'});
 const before=f.app.core.getState(),identities=before.reviewNotes.map(n=>n.noteId);await f.change();
 const sourceBefore=await readFile(f.filename),again=await f.app.importReviewNotes(f.upload),after=f.app.core.getState();
 assert.equal(again.batch.batchId,f.first.batch.batchId,'An unchanged uploaded digest must keep its existing import identity.');
 assert.equal(again.idempotent,true);assert.equal(after.reviewBatches.length,1);assert.deepEqual(after.reviewNotes.map(n=>n.noteId),identities);
 assert.equal(after.reviewNotes.find(n=>n.noteId===note.noteId).decision,'keep');
 assert.equal(after.reviewBatches[0].sourceSnapshotId,f.first.batch.sourceSnapshotId);assert.deepEqual(await readFile(f.filename),sourceBefore);
});

test('the same declared review digest cannot smuggle changed extracted content across a source snapshot',async t=>{
 const f=await fixture(t);await f.change();const before=f.app.core.getState();
 await assert.rejects(f.app.importReviewNotes({...f.upload,text:f.upload.text.replace('independent assumption','a different concern')}),{code:'IDEMPOTENCY_CONFLICT'});
 assert.deepEqual(f.app.core.getState(),before);
});

test('reimporting an unchanged withdrawn file after a source edit never silently restores its opinions',async t=>{
 const f=await fixture(t);await f.app.setReviewImportActive({batchId:f.first.batch.batchId,expectedRevision:1,expectedFileHash:f.upload.fileHash,active:false});await f.change();
 const again=await f.app.importReviewNotes(f.upload),raw=f.app.core.getState();
 assert.equal(again.batch.batchId,f.first.batch.batchId);assert.equal(again.batch.active,false);assert.equal(raw.reviewBatches.length,1);assert.equal(raw.reviewNotes.length,2);
});

test('a genuinely different review digest remains a separate import and does not inherit old decisions',async t=>{
 const f=await fixture(t);await f.change();const body=JSON.stringify({notes:[{title:'New current concern',body:'Discuss the revised precise bound.',quote:'An original abstract states a precise bound.'}]});
 const next=await f.app.importReviewNotes({...f.upload,fileHash:sha(body),text:body});
 assert.notEqual(next.batch.batchId,f.first.batch.batchId);assert.equal(f.app.core.getState().reviewBatches.length,2);assert.equal(next.notes[0].decision,undefined);
});

test('an identical retained review returns opinions from both collections without restoring history as current notes',async t=>{
 const f=await fixture(t);await f.app.core._serial(async()=>{const raw=f.app.core.getState();raw.reviewHistory=[raw.reviewNotes.pop()];await f.app.core._commit(raw);});await f.change();
 const again=await f.app.importReviewNotes(f.upload),raw=f.app.core.getState();assert.equal(again.notes.length,2);assert.equal(raw.reviewNotes.length,1);assert.equal(raw.reviewHistory.length,1);assert.equal(raw.reviewBatches.length,1);
});

function completedFixture(){
 const before='The original abstract asserts a uniform bound with a fixed accuracy parameter.',after='The revised abstract states a precise bound and all required assumptions.';
 const note={noteId:'old-note',batchId:'old-batch',origin:'external',reviewCode:'A01',title:'State the accuracy assumption',body:'Name the fixed accuracy in this abstract bound.',currentSource:before,quote:before,decision:'adopt',decisionUpdatedAt:'2026-10-26T12:00:01Z',decisionSnapshotId:'before',sourceSnapshotId:'before',sourceSegmentIds:['p1'],sourceHashes:{p1:sha(before)},revision:2};
 const proposal={proposalId:'proposal',projectId:'paper',baseSnapshotId:'before',reviewState:'approved',applicationState:'applied',transactionId:'tx',edits:[{segmentId:'p1',path:'main.tex',before,beforeHash:sha(before),replacement:after}]};
 const transaction={transactionId:'tx',projectId:'paper',state:'applied',baseSnapshotId:'before',afterSnapshotId:'after',proposalIds:['proposal'],committedAt:'2026-10-26T12:00:02Z',appliedAt:'2026-10-26T12:00:03Z',sourceChangedAgain:false};
 const raw={project:{id:'paper',snapshotId:'after'},reviewNotes:[note],reviewHistory:[],reviewBatches:[{batchId:'old-batch',origin:'external',format:'json',fileHash:sha('old-file')}],proposals:[proposal]},state={...raw,readingParagraphs:[{id:'p1',path:'main.tex',source:after,sourceHash:sha(after)}],transactions:[transaction]};
 const incoming={...structuredClone(note),noteId:'new-note',batchId:'new-batch',decision:'pending',sourceSnapshotId:'after',sourceSegmentIds:[],sourceHashes:{},revision:1};delete incoming.decisionSnapshotId;delete incoming.decisionUpdatedAt;
 const batch={batchId:'new-batch',origin:'external',format:'json',fileHash:sha('different-file')};
 return{raw,state,note,incoming,batch,proposal,transaction,before,after};
}

test('a proven old concern in a different file inherits completed matching scope without inventing a new adoption decision',()=>{
 const f=completedFixture(),before=structuredClone(f),notes=linkCompletedReviewImports([f.incoming],f.raw,f.state,f.batch);
 assert.equal(notes[0].priorReviewCompletion?.sourceNoteId,'old-note');assert.equal(notes[0].decision,'pending');assert.equal(deriveReviewCompletion(notes[0],{...f.state,reviewNotes:[f.note,...notes]}).completed,true);assert.deepEqual(f,before);
});

test('a new current-source concern, reused review code, preview-only write, or explicit reopen cannot inherit old completion',()=>{
 for(const mutate of [f=>{f.incoming.body='A genuinely new concern at the new source.';},f=>{f.incoming.currentSource=f.after;f.incoming.quote=f.after;f.incoming.sourceSegmentIds=['p1'];f.incoming.sourceHashes={p1:sha(f.after)};},f=>{f.transaction.state='ready';},f=>{f.note.reviewReopen={transactionId:'tx'};}]){
  const f=completedFixture();mutate(f);assert.equal(linkCompletedReviewImports([f.incoming],f.raw,f.state,f.batch)[0].priorReviewCompletion,undefined);
 }
});

test('a same concern without exact old context remains active instead of being guessed complete',()=>{
 const f=completedFixture();delete f.incoming.currentSource;delete f.incoming.quote;
 assert.equal(linkCompletedReviewImports([f.incoming],f.raw,f.state,f.batch)[0].priorReviewCompletion,undefined);
});

test('a captured adopted write retains old-concern completion after the original import was explicitly deleted',()=>{
 const f=completedFixture(),pending={...f.proposal,reviewState:'pending',applicationState:'notApplied'},committing={...f.transaction,state:'committing'};
 f.transaction.reviewCompletions=captureAdoptedReviewEvidence({...f.raw,project:{...f.raw.project,snapshotId:'before'},proposals:[pending]},{transaction:committing,proposals:[pending]});assert.equal(f.transaction.reviewCompletions.length,1);
 f.raw.reviewNotes=[];f.raw.reviewBatches=[];f.state.reviewNotes=[];f.state.reviewBatches=[];
 const notes=linkCompletedReviewImports([f.incoming],f.raw,f.state,f.batch);assert.equal(notes[0].priorReviewCompletion?.sourceNoteId,'old-note');assert.equal(deriveReviewCompletion(notes[0],{...f.state,reviewNotes:notes}).completed,true);
});

test('contradictory historical context and current quotation never silently inherit completed state',()=>{
 const f=completedFixture();f.incoming.quote=f.after;assert.equal(linkCompletedReviewImports([f.incoming],f.raw,f.state,f.batch)[0].priorReviewCompletion,undefined);
});

test('two indistinguishable old concerns with different paragraph proofs stay ambiguous',()=>{
 const f=completedFixture(),other={...structuredClone(f.note),noteId:'other-note',sourceSegmentIds:['p2'],sourceHashes:{p2:sha(f.before)}};
 const proposal={...structuredClone(f.proposal),proposalId:'other-proposal',transactionId:'other-tx',edits:[{...f.proposal.edits[0],segmentId:'p2'}]},transaction={...f.transaction,transactionId:'other-tx',proposalIds:['other-proposal']};
 f.raw.reviewNotes.push(other);f.raw.proposals.push(proposal);f.state.proposals=f.raw.proposals;f.state.transactions.push(transaction);f.state.readingParagraphs.push({...f.state.readingParagraphs[0],id:'p2'});
 assert.equal(linkCompletedReviewImports([f.incoming],f.raw,f.state,f.batch)[0].priorReviewCompletion,undefined);
});
