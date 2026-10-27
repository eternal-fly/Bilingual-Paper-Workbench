import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {PaperApplication} from '../src/application.mjs';
import {registerNativeWorkbenchTools} from '../src/native-workbench-tools.mjs';
import {editorDraftsFor} from '../src/editor-drafts.mjs';
import {callBackgroundModelTool} from '../src/native-tool-dispatch.mjs';
import {parseDesktopCallback} from '../src/desktop-callback.mjs';
const root=path.resolve(fileURLToPath(new URL('../work/native-workbench-tools/',import.meta.url))),caller='synthetic-bound-native-chat',sha=s=>createHash('sha256').update(s).digest('hex');
async function fixture(t,{foreign=false}={}){
 await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'case-')),source=path.join(dir,'source');await mkdir(source);
 const {writeFile}=await import('node:fs/promises');const original=String.raw`\documentclass{article}
\begin{document}
The native editor retains $x=1$ and \cite{Alpha}; see \eqref{eq:a}.
\section{Auxiliary identities}
\begin{equation}x=1\label{eq:a}\end{equation}
\begin{equation}y=2\label{eq:b}\end{equation}
\begin{thebibliography}{9}\bibitem{Alpha}A.\bibitem{Beta}B.\end{thebibliography}
\end{document}`;
 await writeFile(path.join(source,'main.tex'),original);const app=new PaperApplication({dataRoot:path.join(dir,'private')});await app.openProject({root:source,mainFile:'main.tex',sourceLanguage:'en',targetLanguage:'zh-CN'});
 await app._flowAction(()=>{app.flow.nativeChatBinding={projectId:app.core.getState().project.id,threadId:caller,source:'originating-host-chat'};});
 const paragraph=app.getState().readingParagraphs.find(p=>p.source.startsWith('The native'));
 await app.saveTranslationDraftWithFormulaEdits({segmentId:paragraph.id,language:'zh-CN',text:String.raw`原始说明 $x=1$，引用 \cite{Alpha}，参见 \eqref{eq:a}。`,expectedRevision:0,expectedProjectId:app.getState().project.id,expectedSnapshotId:app.getState().project.snapshotId});
 const tools=new Map();registerNativeWorkbenchTools({registerTool(name,config,handler){tools.set(name,{config,handler});}},{service:app,nativeThreadId:foreign?'different-chat':caller,instanceId:'synthetic-instance',guard:handler=>async args=>{try{return await handler(args);}catch(error){return{isError:true,structuredContent:{error:{code:error.code||'INVALID_INPUT'}}};}}});
 const scope=()=>({expectedProjectId:app.getState().project.id,expectedSnapshotId:app.getState().project.snapshotId});
 const draft=()=>app.getState().translations['zh-CN'][paragraph.id];
 const edit=(text=String.raw`改写说明 $x=2$，引用 \cite{Beta}，参见 \eqref{eq:b}。`)=>({...scope(),segmentId:paragraph.id,language:'zh-CN',text,expectedRevision:draft().revision,expectedTextHash:sha(draft().text),reason:'Apply the author-directed edit in this exact bound chat.'});
 const call=async(name,args)=>{assert(tools.has(name),'Native operation must be registered without a UI token');return tools.get(name).handler(args);};
 t.after(async()=>{editorDraftsFor(app).close();await app.close();assert.equal(await readFile(path.join(source,'main.tex'),'utf8'),original);assert(dir.startsWith(root+path.sep));await rm(dir,{recursive:true,force:true});});
 return{app,paragraph,tools,scope,draft,edit,call};
}
test('bound native chat edits formula and references with exact draft revision, attribution and no source promotion',async t=>{
 const f=await fixture(t),before=f.draft(),result=await f.call('bilingual_paper_edit_translation',f.edit());assert.notEqual(result.isError,true,JSON.stringify(result));
 const after=f.draft();assert.equal(after.revision,before.revision+1);assert.equal(after.text,f.edit().text);assert.equal(after.editActor.kind,'bound-chat');assert.equal(after.editActor.threadId,caller);assert.equal(result.structuredContent.sourceChanged,false);assert(after.formulaEdits?.length||after.formulaEditHistory?.length||after.formulaEditUnmapped);assert(after.referenceEdits?.length||after.referenceEditHistory?.length);
 const invoke=(name,args)=>callBackgroundModelTool(f.app,{name,arguments:args,bindingId:'synthetic-protected-edit',originThreadId:caller});
 const prepared=await invoke('bilingual_paper_prepare_request',{...f.scope(),kind:'revision',segmentIds:[f.paragraph.id],language:'zh-CN',prompt:'Apply only the saved author-directed formula and reference edit.'});assert.notEqual(prepared.isError,true,JSON.stringify(prepared));const request=prepared.structuredContent,segment=request.segments[0];
 const proposal=await invoke('bilingual_paper_propose_revision',{requestId:request.requestId,reason:'Use the saved bound-chat intent without accepting source.',edits:[{segmentId:f.paragraph.id,beforeHash:segment.beforeHash,replacement:segment.text.replace('The native editor retains','The revised native editor retains')}]});assert.notEqual(proposal.isError,true,JSON.stringify(proposal));const pending=f.app.getState().proposals.find(row=>row.proposalId===proposal.structuredContent.proposalId);assert.equal(pending.applicationState,'notApplied');const captured=await f.app._capture([pending.proposalId]),candidate=captured.candidate.files.find(file=>file.path==='main.tex').content;assert(candidate.includes('$x=2$'));assert(candidate.includes(String.raw`\cite{Beta}`));
 assert.equal(f.tools.has('bilingual_paper_apply_transaction'),false);
});
test('native draft editing rejects another chat, stale text hashes and unrecognized grant fields',async t=>{
 const f=await fixture(t,{foreign:true}),before=structuredClone(f.draft());assert.equal((await f.call('bilingual_paper_edit_translation',f.edit())).isError,true);assert.deepEqual(f.draft(),before);
 const g=await fixture(t);const own=structuredClone(g.draft());for(const changes of [{expectedTextHash:'0'.repeat(64)},{expectedRevision:0},{force:true},{editActor:{kind:'bound-chat',threadId:'forged'}}]){assert.equal((await g.call('bilingual_paper_edit_translation',{...g.edit(),...changes})).isError,true);assert.deepEqual(g.draft(),own);}
});
test('native project inspection reads only declared files with exact hashes and never exposes a UI capability',async t=>{
 const f=await fixture(t),listed=await f.call('bilingual_paper_workbench',{...f.scope(),action:'list_sources',payload:{}});assert.notEqual(listed.isError,true,JSON.stringify(listed));const file=listed.structuredContent.files.find(row=>row.path==='main.tex');assert(file);
 const read=await f.call('bilingual_paper_workbench',{...f.scope(),action:'read_source',payload:{path:file.path,expectedHash:file.hash}});assert.notEqual(read.isError,true);assert(read.structuredContent.content.includes('native editor'));assert(!JSON.stringify(read).includes('paperUiToken'));
 const rejected=await f.call('bilingual_paper_workbench',{...f.scope(),action:'read_source',payload:{path:'../outside.tex',expectedHash:file.hash}});assert.equal(rejected.isError,true);
});
test('a live unsaved or composing buffer is preserved instead of being replaced by a native edit',async t=>{
 const f=await fixture(t),store=editorDraftsFor(f.app),input=f.edit(),before=structuredClone(f.draft());let sequence=0;const clientId='synthetic-live-editor';store.poll({...f.scope(),clientId});
 const timer=setInterval(()=>{const packet=store.poll({...f.scope(),clientId});if(packet.captureId)store.publish({...f.scope(),clientId,captureId:packet.captureId,sequence:++sequence,drafts:[{segmentId:f.paragraph.id,language:'zh-CN',text:'New unsaved author input',baseDraftRevision:before.revision,bufferSequence:sequence,saveState:'dirty',composing:false}]});},5);timer.unref();t.after(()=>clearInterval(timer));
 const result=await f.call('bilingual_paper_edit_translation',input);assert.equal(result.isError,true);assert.equal(result.structuredContent.error.code,'EDITOR_UNSAVED_CHANGES');assert.deepEqual(f.draft(),before);
});
test('current native background and fixed callback verbs expose the broader bound-chat tools without source promotion',async t=>{
 const f=await fixture(t),result=await callBackgroundModelTool(f.app,{name:'bilingual_paper_workbench',arguments:{...f.scope(),action:'list_sources',payload:{}},bindingId:'synthetic-native-permissions',originThreadId:caller});assert.notEqual(result.isError,true,JSON.stringify(result));assert(result.structuredContent.files.length);
 const paragraphs=await callBackgroundModelTool(f.app,{name:'bilingual_paper_read_paragraphs',arguments:{...f.scope(),segmentIds:[f.paragraph.id]},bindingId:'synthetic-native-permissions',originThreadId:caller});assert.equal(paragraphs.structuredContent.segments[0].translationDraft.textHash,sha(f.draft().text));
 assert.equal(parseDesktopCallback(['edit-translation'],Buffer.from(JSON.stringify(f.edit()))).action,'edit-translation');
 assert.equal(parseDesktopCallback(['workbench'],Buffer.from(JSON.stringify({...f.scope(),action:'review_state',payload:{}}))).action,'workbench');
 assert.throws(()=>parseDesktopCallback(['workbench'],Buffer.from(JSON.stringify({...f.scope(),action:'applyTransaction',payload:{}}))));
});
test('native review inspection and decisions preserve the underlying manuscript and source confirmation boundary',async t=>{
 const f=await fixture(t),text=JSON.stringify({notes:[{title:'Clarify the claim',body:'State the scope of this synthetic example.'}]});await f.app.importReviewNotes({filename:'synthetic-review.json',format:'json',fileHash:sha(text),text});
 const state=await f.call('bilingual_paper_workbench',{...f.scope(),action:'review_state',payload:{}});assert.notEqual(state.isError,true);assert.equal(state.structuredContent.notes.length,1);const note=state.structuredContent.notes[0];
 const updated=await f.call('bilingual_paper_workbench',{...f.scope(),action:'review_decision',payload:{noteId:note.noteId,expectedRevision:note.revision,decision:'keep'}});assert.notEqual(updated.isError,true,JSON.stringify(updated));assert.equal(updated.structuredContent.decision,'keep');
 const refused=await f.call('bilingual_paper_workbench',{...f.scope(),action:'applyTransaction',payload:{}});assert.equal(refused.isError,true);
});
