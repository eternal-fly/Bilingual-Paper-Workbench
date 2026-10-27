import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {PaperApplication} from '../src/application.mjs';
import {restoreProtected} from '../src/latex.mjs';
import {prepareRangeFile,authorizeReadingRange} from '../src/range-authority.mjs';

const prose=String.raw`Leading prose refers to Sec.~3.1 with \{x\}, escaped 10\%, \textbf{ordinary words}, $x=1\,\!$, \cite{A}, and \eqref{eq:one}. Trailing prose remains editable.`;
async function fixture(t,{definition=String.raw`\let\unrelated\relax`,style=false,body=prose}={}){
 const owned=path.resolve('work/inline-object-granularity');await mkdir(owned,{recursive:true});const temp=await mkdtemp(path.join(owned,'case-')),root=path.join(temp,'source');await mkdir(root);
 const original='\\documentclass{article}\n'+(style?'\\usepackage{custom}':definition)+'\n\\begin{document}\n\n'+body+'\n\n\\begin{equation}x=1\\label{eq:one}\\end{equation}\n\\bibliography{refs}\n\\end{document}\n';await writeFile(path.join(root,'main.tex'),original);if(style)await writeFile(path.join(root,'custom.sty'),definition);await writeFile(path.join(root,'refs.bib'),'@article{A,title={Synthetic reference}}\n');
 const app=new PaperApplication({dataRoot:path.join(temp,'private')});app.desktopExecutionEnabled=true;await app.initialize();await app.openProject({root,mainFile:'main.tex'});const paragraph=app.getState().readingParagraphs.find(p=>p.source.startsWith('Leading'));assert(paragraph);await app.saveDraft({segmentId:paragraph.id,language:'zh-CN',text:body,expectedRevision:0});
 t.after(async()=>{await app.close();assert.equal(await readFile(path.join(root,'main.tex'),'utf8'),original);assert(temp.startsWith(owned+path.sep));await rm(temp,{recursive:true,force:true});});
 return{app,root,original,paragraph,body,current:()=>app.getState().translations['zh-CN'][paragraph.id],async save(text){const s=app.getState();return app.saveTranslationDraftWithFormulaEdits({segmentId:paragraph.id,language:'zh-CN',text,expectedRevision:s.translations['zh-CN'][paragraph.id].revision,expectedProjectId:s.project.id,expectedSnapshotId:s.project.snapshotId});},request:()=>app.createRequest({kind:'revision',language:'zh-CN',segmentIds:[paragraph.id]})};
}
async function propose(f,r,replacement){return f.app.proposeRevision({requestId:r.requestId,reason:'Revise only natural-language prose around exact protected source objects.',edits:[{segmentId:f.paragraph.id,beforeHash:r.segments[0].beforeHash,replacement}]});}

test('unrelated literal aliases do not freeze spacing, escapes, static formatting, mathematical or reference paragraphs',async t=>{
 const f=await fixture(t),r=await f.request(),s=r.segments[0];assert(s.text.includes('Leading prose'));assert(s.text.includes('ordinary words'));assert(s.text.includes('Trailing prose'));assert(!s.draftReview?.opaqueSourceRange);
 for(const raw of['~',String.raw`\{`,String.raw`\}`,String.raw`\%`,String.raw`$x=1\,\!$`,String.raw`\cite{A}`,String.raw`\eqref{eq:one}`])assert(s.protectedTokens.some(token=>token.raw===raw),raw);
 const replacement=s.text.replace('Leading prose','Revised opening').replace('ordinary words','clear words').replace('Trailing prose','Revised ending'),p=await propose(f,r,replacement);assert(p.edits[0].replacement.includes('Revised opening'));assert(p.edits[0].replacement.includes('Revised ending'));assert(p.edits[0].replacement.includes(String.raw`\textbf{clear words}`));
});
test('unrelated aliases do not revoke the trusted author edit path for default inline formatting and spacing',async t=>{
 const f=await fixture(t),text=f.body.replace('Sec.~3.1','Sec. 3.1').replace(String.raw`\textbf{ordinary words}`,String.raw`\textsf{clear words}`),saved=await f.save(text);assert.equal(saved.sourceCandidateAvailable,true);assert(!saved.draft.sourceReviewRequired);assert(saved.draft.inlineStructureIntent);const r=await f.request();assert(r.segments[0].inlineStructureRequest);assert.equal(restoreProtected(r.segments[0],r.segments[0].text),text);assert((await propose(f,r,r.segments[0].text)).proposalId);
});
test('a proven closed rebound formatter protects only its complete consumed argument and leaves both prose gaps editable',async t=>{
 const f=await fixture(t,{definition:String.raw`\renewcommand{\textbf}[1]{\textit{#1}}`,style:true}),r=await f.request(),s=r.segments[0];assert(s.text.includes('Leading prose'));assert(s.text.includes('Trailing prose'));assert(s.protectedTokens.some(p=>p.raw===String.raw`\textbf{ordinary words}`));assert(!s.draftReview?.opaqueSourceRange);const token=s.protectedTokens.find(p=>p.raw===String.raw`\textbf{ordinary words}`);await assert.rejects(propose(f,r,s.text.replace(token.id,String.raw`\textbf{different argument}`)),e=>['PROTECTED_TOKEN_CHANGED','UNSUPPORTED_TEX'].includes(e.code));const p=await propose(f,r,s.text.replace('Leading prose','Revised opening').replace('Trailing prose','Revised ending'));assert(p.edits[0].replacement.includes(String.raw`\textbf{ordinary words}`));
});
test('literal custom zero and one argument calls remain complete opaque objects rather than freezing their paragraph',async t=>{
 for(const [definition,body,raw]of[[String.raw`\newcommand{\customzero}{STAT}`,String.raw`Leading prose \customzero keeps a claim. Trailing prose remains editable.`,String.raw`\customzero`],[String.raw`\newcommand{\customone}[1]{[#1]}`,String.raw`Leading prose \customone{fixed operand} keeps a claim. Trailing prose remains editable.`,String.raw`\customone{fixed operand}`]])await t.test(raw,async t=>{const f=await fixture(t,{definition,body}),r=await f.request(),s=r.segments[0];assert(s.text.includes('Leading prose'));assert(s.text.includes('Trailing prose'));assert(s.protectedTokens.some(p=>p.raw===raw));assert((await propose(f,r,s.text.replace('Leading prose','Revised opening').replace('Trailing prose','Revised ending'))).proposalId);});
});
test('unproved input consumption preserves its continuation and rejects appending caller operands or retargeting the invocation',async t=>{
 const f=await fixture(t,{definition:String.raw`\renewcommand{\textbf}[1]{\input}`,style:true}),r=await f.request(),s=r.segments[0];assert(s.text.includes('Leading prose'));assert(!s.text.includes('Trailing prose'));assert(s.draftReview.opaqueSourceContinuation);await assert.rejects(propose(f,r,s.text+' another-file'),{code:'UNSUPPORTED_TEX'});const p=await propose(f,r,s.text.replace('Leading prose','Revised opening'));assert(p.edits[0].replacement.endsWith(prose.slice(prose.indexOf(String.raw`\textbf{`))));
});

test('a complete 22-paragraph request keeps ordinary prose editable around every safe inline object',async t=>{
 const body=Array.from({length:22},(_,index)=>`Leading paragraph ${index+1} `+String.raw`keeps Sec.~3.1, three~safe~spaces, \{escaped braces\}, \%, \,, \!, \textsf{clear text}, \textsc{small capitals}, \underline{underlined text}, \mbox{boxed text}, $x=1\,\!$, \cite{A}, and \eqref{eq:one}. Trailing prose remains editable.`).join('\n\n'),f=await fixture(t,{body}),paragraphs=f.app.getState().readingParagraphs.filter(row=>row.source.startsWith('Leading'));
 assert.equal(paragraphs.length,22);for(const paragraph of paragraphs){const current=f.app.getState().translations['zh-CN'][paragraph.id];await f.app.saveDraft({segmentId:paragraph.id,language:'zh-CN',text:paragraph.source,expectedRevision:current?.revision||0});}
 const r=await f.app.createRequest({kind:'revision',language:'zh-CN',segmentIds:paragraphs.map(row=>row.id)});assert.equal(r.segments.length,22);
 for(const selected of r.segments){assert(selected.text.includes('Leading paragraph'));assert(selected.text.includes('Trailing prose'),JSON.stringify({text:selected.text,review:selected.draftReview,profile:f.app.getState().project.inlineStructureSafety}));assert(!selected.draftReview?.opaqueSourceRange);assert(!selected.protectedTokens.some(token=>token.raw.includes('Leading paragraph')));assert(selected.protectedTokens.some(token=>token.raw===String.raw`$x=1\,\!$`));assert(selected.protectedTokens.some(token=>token.raw===String.raw`\eqref{eq:one}`));}
 const proposal=await f.app.proposeRevision({requestId:r.requestId,reason:'Clarify natural language across the complete current scope while preserving each protected object.',edits:r.segments.map(selected=>({segmentId:selected.id,beforeHash:selected.beforeHash,replacement:selected.text.replace('Leading paragraph','Revised paragraph').replace('Trailing prose','Revised ending')}))});assert.equal(proposal.edits.length,22);assert(proposal.edits.every(edit=>edit.replacement.includes('Revised paragraph')&&edit.replacement.includes('Revised ending')));
});

test('an unchanged bounded custom call does not discard independently authorized formula and inline edits',async t=>{
 const body=String.raw`Leading prose \customone{fixed operand} keeps $x=1$, Sec.~3.1 and \textbf{ordinary words}; see \cite{A} and \eqref{eq:one}. Trailing prose remains editable.`,f=await fixture(t,{definition:String.raw`\newcommand{\customone}[1]{[#1]}`,body}),edited=body.replace('$x=1$','$x=2$').replace('Sec.~3.1','Sec. 3.1').replace(String.raw`\textbf{ordinary words}`,String.raw`\textsf{clear words}`),saved=await f.save(edited);
 assert.equal(saved.sourceCandidateAvailable,true);assert(!saved.draft.sourceReviewRequired);assert(saved.draft.formulaEdits?.length);assert(saved.draft.inlineStructureIntent);
 const r=await f.request(),selected=r.segments[0];assert(!selected.draftReview);assert(selected.formulaEdits?.length);assert(selected.inlineStructureRequest);assert(selected.protectedTokens.some(token=>token.raw===String.raw`\customone{fixed operand}`));assert.equal(restoreProtected(selected,selected.text),edited);const proposal=await propose(f,r,selected.text.replace('Leading prose','Revised opening'));assert(proposal.edits[0].replacement.includes('$x=2$'));assert(proposal.edits[0].replacement.includes(String.raw`\textsf{clear words}`));
});

test('a current staged lexical-risk profile vetoes the older permissive literal scan',async t=>{
 const f=await fixture(t,{definition:String.raw`\aftergroup\relax`}),state=f.app.getState(),profile=state.project.inlineStructureSafety,prepared=prepareRangeFile(f.original,'main.tex'),range=prepared.projection.paragraphs.find(row=>row.source.startsWith('Leading'));
 assert.equal(prepared.lexicalSafe,true);assert.equal(profile.unboundedBindings,true);assert.equal(profile.literalSyntaxStable,false);assert.equal(f.app.core._literalProjectSafe(),false);assert.equal(authorizeReadingRange(prepared,{...range,id:f.paragraph.id,path:'main.tex'},state.project.snapshotId,{inlineStructureSafety:profile}),null);
});

test('rebound escaped-symbol and spacing helpers retain their unknown original caller continuation',async t=>{
 for(const [name,control]of[['textbraceleft',String.raw`\{`],['textpercent',String.raw`\%`],['tmspace',String.raw`\,`]])await t.test(name,async t=>{
  const body='Leading prose '+control+'fixed operand and remaining caller text.',f=await fixture(t,{definition:`\\def\\${name}#1{\\input{#1}}`,style:true,body}),r=await f.request(),selected=r.segments[0];assert(selected.draftReview?.opaqueSourceContinuation);assert(selected.text.includes('Leading prose'));assert(!selected.text.includes('remaining caller text'));await assert.rejects(propose(f,r,selected.text+' foreign-file'),{code:'UNSUPPORTED_TEX'});assert((await propose(f,r,selected.text.replace('Leading prose','Revised opening'))).proposalId);
 });
});
