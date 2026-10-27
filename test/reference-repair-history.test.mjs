import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {PaperApplication} from '../src/application.mjs';
import {sha256} from '../src/latex.mjs';

async function fixture(t){const parent=path.resolve('work/reference-repair-history');await mkdir(parent,{recursive:true});const temp=await mkdtemp(path.join(parent,'case-')),root=path.join(temp,'source');await mkdir(root);await writeFile(path.join(root,'main.tex'),String.raw`\documentclass{article}
\begin{document}

A precise claim uses $x=1$, \cite{A}, Fig. \ref{fig:first}, Eq. \eqref{eq:first}.

\begin{figure}\caption{First}\label{fig:first}\end{figure}
\begin{figure}\caption{Second}\label{fig:second}\end{figure}
\begin{equation}x=1\label{eq:first}\end{equation}
\begin{equation}x=2\label{eq:second}\end{equation}
\bibliography{refs}
\end{document}`);await writeFile(path.join(root,'refs.bib'),'@article{A,title={Alpha}}\n@article{B,title={Beta}}');const app=new PaperApplication({dataRoot:path.join(temp,'private')});await app.initialize();await app.openProject({root,mainFile:'main.tex'});t.after(async()=>{await app.close();await rm(temp,{recursive:true,force:true});});const paragraph=app.getState().readingParagraphs.find(p=>p.source.startsWith('A precise')),initial=String.raw`精确结论使用 $x=1$、\cite{A}、图 \ref{fig:first}、式 \eqref{eq:first}。`;await app.saveDraft({segmentId:paragraph.id,language:'zh-CN',expectedRevision:0,text:initial});const current=()=>app.getState().translations['zh-CN'][paragraph.id],save=text=>app.saveTranslationDraftWithFormulaEdits({segmentId:paragraph.id,language:'zh-CN',text,expectedRevision:current().revision,expectedProjectId:app.getState().project.id,expectedSnapshotId:app.getState().project.snapshotId});const full=initial.replace('$x=1$','$x=2$').replace(String.raw`\cite{A}`,String.raw`\cite{A,B}`).replace('fig:first','fig:second').replace('eq:first','eq:second');return{app,paragraph,initial,full,current,save};}
test('complete repair independently maps distinct citation/figure/equation command identities',async t=>{const f=await fixture(t);await f.save(f.full.replace(String.raw`\cite{A,B}`,String.raw`\cite{missing}`));assert(f.current().sourceReviewRequired);const result=await f.save(f.full);assert(!result.draft.sourceReviewRequired);assert(!result.draft.referenceEditUnmapped);assert.equal(result.draft.referenceEdits.length,3);assert(result.sourceCandidateAvailable);});
test('stale unmapped history for an identical text hash cannot shadow fresh exact reference alignment',async t=>{const f=await fixture(t);await f.save(f.full);await f.app.core._serial(async()=>{const state=f.app.core.getState(),draft=state.translations['zh-CN'][f.paragraph.id];draft.referenceEditHistory||=[];draft.referenceEditHistory.push({editId:'legacy-unmapped',projectId:state.project.id,snapshotId:state.project.snapshotId,sourceHash:f.paragraph.sourceHash,beforeDraftHash:sha256(f.initial),afterDraftHash:sha256(f.full),beforeIntent:{edits:[],conflict:false,unmapped:false},afterIntent:{edits:[],conflict:false,unmapped:true}});await f.app.core._commit(state);});await f.save(f.initial);let text=f.initial.replace('$x=1$','$x=2$').replace(String.raw`\cite{A}`,String.raw`\cite{A,B}`);await f.save(text);text=text.replace('fig:first','fig:second');await f.save(text);const result=await f.save(text.replace('eq:first','eq:second'));assert.equal(result.draft.text,f.full);assert(!result.draft.referenceEditUnmapped);assert.equal(result.draft.referenceEdits.length,3);assert(result.sourceCandidateAvailable);});
