import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {PaperApplication} from '../src/application.mjs';
import {createPaperServer} from '../src/server.mjs';
import {STATIC_FONT_PROFILE_BODY} from '../src/static-font-profile.mjs';
import {sha256} from '../src/latex.mjs';

test('all four bounded stock template constructs preserve native candidates for 123 originals and retain author records',async t=>{
 const owned=path.resolve('work/stock-template-native-tests');await mkdir(owned,{recursive:true});const temporary=await mkdtemp(path.join(owned,'case-')),root=path.join(temporary,'source');await mkdir(root);
 const preamble=String.raw`\documentclass{article}
\makeatletter
\let\pre@bibdata\@empty
\immediate\write\@auxout{\string\citation{syntheticStyle}}
\let\th@syntheticStatement\th@plain
\renewcommand\normalsize{`+STATIC_FONT_PROFILE_BODY+String.raw`}
\makeatother
\def\unrelated{opaque}
\begin{document}
`,paragraphs=Array.from({length:123},(_,i)=>`Template paragraph ${i+1} retains Sec.~3.1, `+`$x_{${i}}=1$`+String.raw`, \cite{syntheticA}, and \eqref{eq:synthetic}. Trailing prose remains editable.`+(i===0?String.raw`\label{eq:synthetic}`:'')),source=preamble+'\n'+paragraphs.join('\n\n')+String.raw`\bibliography{refs}`+'\n'+String.raw`\end{document}`+'\n',filename=path.join(root,'main.tex');await writeFile(filename,source);await writeFile(path.join(root,'refs.bib'),'@article{syntheticA,title={Self-authored synthetic reference}}\n');
 const app=new PaperApplication({dataRoot:path.join(temporary,'private')});app.desktopExecutionEnabled=true;await app.openProject({root,mainFile:'main.tex',targetLanguage:'zh-CN'});const threadId='synthetic-stock-template-native-chat',project=app.getState().project,rows=app.getState().readingParagraphs.filter(row=>row.source.startsWith('Template paragraph'));
 t.after(async()=>{await app.close();assert.equal(await readFile(filename,'utf8'),source);assert(temporary.startsWith(owned+path.sep));await rm(temporary,{recursive:true,force:true});});
 assert.equal(rows.length,123);assert(!project.inlineStructureSafety.unboundedBindings);assert.equal(project.inlineStructureSafety.literalSyntaxStable,true);assert(rows.every(row=>row.writableSource));
 for(const row of rows.slice(0,18))await app.saveDraft({segmentId:row.id,language:'zh-CN',expectedRevision:app.getState().translations['zh-CN'][row.id]?.revision||0,text:'Existing author draft for '+row.id});
 const review='“'+rows[0].source+'” Clarify the exact stated assumption.';await app.importReviewNotes({filename:'synthetic-retained-review.txt',format:'txt',fileHash:sha256(review),text:review});await app._flowAction(()=>{app.flow.nativeChatBinding={projectId:project.id,threadId,source:'originating-host-chat'};});
 const before=app.getState(),server=createPaperServer({service:app,nativeThreadId:threadId,uiHtml:'<!doctype html>'}),client=new Client({name:'synthetic-stock-template-native-regression',version:'1'}),[cs,ss]=InMemoryTransport.createLinkedPair();await server.connect(ss);await client.connect(cs);t.after(async()=>{await client.close();await server.close();});
 const scope={expectedProjectId:project.id,expectedSnapshotId:project.snapshotId},call=async(name,args)=>{const result=await client.callTool({name,arguments:args});assert(!result.isError,result.structuredContent?.error?.code||result.content?.[0]?.text);return result.structuredContent;};
 const index=await call('bilingual_paper_read_project',{...scope,limit:200}),ids=rows.map(row=>row.id);assert(index.paragraphs.filter(row=>ids.includes(row.segmentId)).every(row=>row.writableSource));
 const packet=await call('bilingual_paper_prepare_request',{...scope,kind:'revision',segmentIds:ids,language:'zh-CN'}),selected=[...packet.segments];let next=packet.nextOffset;
 while(next!==null){const page=await call('bilingual_paper_get_request',{requestId:packet.requestId,offset:next});selected.push(...page.segments);next=page.nextOffset;}
 assert.equal(selected.length,123);assert.deepEqual(selected.map(row=>row.id),ids);assert(selected.every(row=>row.text.includes('Template paragraph')&&row.text.includes('Trailing prose')));
 const malformed=await client.callTool({name:'bilingual_paper_propose_revision',arguments:{requestId:packet.requestId,reason:'Synthetic invalid result must be rejected atomically.',edits:selected.map((row,i)=>({segmentId:row.id,beforeHash:row.beforeHash,replacement:i===0?'Missing protected objects.':row.text}))}});assert.equal(malformed.isError,true);assert.equal(app.getState().proposals.length,0);
 const pending=await call('bilingual_paper_propose_revision',{requestId:packet.requestId,reason:'Clarify only the registered natural-language prose.',edits:selected.map(row=>({segmentId:row.id,beforeHash:row.beforeHash,replacement:row.text.replace('Template paragraph','Revised paragraph')}))});assert(pending.proposalId);const after=app.getState(),proposal=after.proposals.find(row=>row.proposalId===pending.proposalId);assert.equal(proposal.edits.length,123);assert.equal(proposal.reviewState,'pending');assert.equal(proposal.applicationState,'notApplied');
 for(const key of['translations','originals','reviewNotes','reviewHistory'])assert.deepEqual(after[key],before[key],key);assert(before.reviewNotes.length>0);assert.equal(await readFile(filename,'utf8'),source);
});
