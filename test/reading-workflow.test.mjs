import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PaperApplication } from '../src/application.mjs';
import {createPaperServer} from '../src/server.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

test('all eighteen ordinary paragraphs with a mathematical iff remain writable through native request preparation and proposal return',async t=>{
 const owned=path.resolve('work/reading-authority-regressions');await mkdir(owned,{recursive:true});const temp=await mkdtemp(path.join(owned,'native-')),root=path.join(temp,'source');await mkdir(root);
 const source='\\documentclass{article}\n\\def\\Ns{N^*}\n\\let\\unrelated\\relax\n\\begin{document}\n\n'+Array.from({length:18},(_,i)=>`Leading paragraph ${i+1} refers to Sec.~3.1 with `+String.raw`$x=1\iff y=2$, \{escaped braces\}, and \textsf{ordinary words}. Trailing prose remains editable.`).join('\n\n')+'\n\\end{document}';const filename=path.join(root,'main.tex');await writeFile(filename,source);
 const app=new PaperApplication({dataRoot:path.join(temp,'private')}),threadId='synthetic-native-reading-origin';app.desktopExecutionEnabled=true;await app.openProject({root,mainFile:'main.tex',targetLanguage:'zh-CN'});const project=app.getState().project;await app._flowAction(()=>{app.flow.nativeChatBinding={projectId:project.id,threadId,source:'originating-host-chat'};});
 const server=createPaperServer({service:app,nativeThreadId:threadId,uiHtml:'<!doctype html>'}),client=new Client({name:'synthetic-reading-request-regression',version:'1'}),[cs,ss]=InMemoryTransport.createLinkedPair();await server.connect(ss);await client.connect(cs);
 t.after(async()=>{await client.close();await server.close();await app.close();assert.equal(await readFile(filename,'utf8'),source);assert(temp.startsWith(owned+path.sep));await rm(temp,{recursive:true,force:true});});
 const scope={expectedProjectId:project.id,expectedSnapshotId:project.snapshotId},call=async(name,args)=>{const result=await client.callTool({name,arguments:args});assert(!result.isError,result.structuredContent?.error?.code||result.content?.[0]?.text);return result.structuredContent;};
 const index=await call('bilingual_paper_read_project',{...scope,limit:100});assert.equal(index.paragraphs.length,18);assert(index.paragraphs.every(row=>row.writableSource&&row.requestable));
 const request=await call('bilingual_paper_prepare_request',{...scope,kind:'revision',segmentIds:index.paragraphs.map(row=>row.segmentId),language:'zh-CN'});assert.equal(request.segments.length,18);assert(request.segments.every(row=>row.text.includes('Leading paragraph')&&row.text.includes('Trailing prose')&&row.protectedTokens.some(token=>token.raw===String.raw`$x=1\iff y=2$`)));
 const returned=await call('bilingual_paper_propose_revision',{requestId:request.requestId,reason:'Clarify only the registered prose while retaining original TeX objects.',edits:request.segments.map(row=>({segmentId:row.id,beforeHash:row.beforeHash,replacement:row.text.replace('Leading paragraph','Revised paragraph')}))});assert(returned.proposalId);assert.equal(app.getState().proposals.at(-1).edits.length,18);assert.equal(await readFile(filename,'utf8'),source);
});

test('same-snapshot reading caches discard an obsolete derived safety policy without changing source or drafts',async t=>{
 const owned=path.resolve('work/reading-authority-regressions');await mkdir(owned,{recursive:true});const temp=await mkdtemp(path.join(owned,'cache-')),root=path.join(temp,'source');await mkdir(root);const source='\\documentclass{article}\n\\def\\Ns{N^*}\n\\begin{document}\n\nLeading prose retains Sec.~3.1 and $x=1$.\n\\end{document}';const filename=path.join(root,'main.tex');await writeFile(filename,source);
 const app=new PaperApplication({dataRoot:path.join(temp,'private')});await app.openProject({root,mainFile:'main.tex'});t.after(async()=>{await app.close();assert.equal(await readFile(filename,'utf8'),source);assert(temp.startsWith(owned+path.sep));await rm(temp,{recursive:true,force:true});});
 const current=app.core.getState(),legacy=structuredClone(current),profile=current.project.inlineStructureSafety;legacy.project.inlineStructureSafety={schemaVersion:1,projectId:current.project.id,snapshotId:current.project.snapshotId,fingerprint:profile.fingerprint,safe:false,unboundedBindings:true,literalSyntaxStable:false};
 app.reading.cache=null;app.reading.cache=app.reading.derive(legacy);assert(app.reading.cache.paragraphs.every(row=>!row.writableSource));
 const repaired=structuredClone(current);repaired.project.inlineStructureSafety={...profile,policyVersion:2,analysisFingerprint:'a'.repeat(64)};const fresh=app.reading.derive(repaired);assert.notEqual(fresh,app.reading.cache);assert(fresh.paragraphs.every(row=>row.writableSource));assert.deepEqual(app.core.getState().translations,current.translations);
 app.reading.cache={...app.reading.cache,key:`${current.project.snapshotId}:${current.readingAnchorRevision||0}`};assert(app.reading.state(repaired).readingParagraphs.every(row=>row.writableSource));
});

test('verified literal originals beyond the lexer cutoff can request protected source candidates', async t => {
  const owned = fileURLToPath(new URL('../work/reading-tests/', import.meta.url)); await mkdir(owned, { recursive: true });
  const temp = await mkdtemp(path.join(owned, 'case-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source'); await mkdir(source);
  const text = '\\documentclass{article}\n\\newcommand{\\eng}{\\noindent{\\normalfont\\sffamily\\scriptsize\\color{Muted}EN}\\enspace\\ignorespaces}\n\\newcommand{\\chin}{\\noindent{\\normalfont\\sffamily\\scriptsize\\color{Muted}中}\\enspace\\ignorespaces}\n\\newenvironment{pairedoriginal}[1]{\\par\\begingroup\\color{#1}}{\\par\\endgroup\\smallskip}\n\\begin{document}\n\\def\\unrelated{opaque}\n\\begin{pairedoriginal}{Old}\n\\eng An original state $x=1$ remains.\\par\\chin 原始状态 $x=1$ 保持不变。\n\\end{pairedoriginal}\n\\end{document}\n';
  const file = path.join(source, 'main.tex'); await writeFile(file, text);
  const app = new PaperApplication({ dataRoot: path.join(temp, 'private') }); await app.openProject({ root: source, mainFile: 'main.tex' });
  const state = app.getState(), paragraph = state.readingParagraphs.find(item => item.source.includes('An original state'));
  assert.ok(paragraph); assert.equal(paragraph.writableSource, true);
  const comment = await app.addComment({ segmentIds: [paragraph.id], text: '仅讨论此派生译文的表述。' });
  assert.deepEqual(comment.segmentIds, [paragraph.id]);
  const draft = state.translations['zh-CN'][paragraph.id]; assert.ok(draft.text.includes('原始状态'));
  await app.saveDraft({ segmentId: paragraph.id, language: 'zh-CN', text: '人工修改译文中的表达。', expectedRevision: draft.revision });
  assert.equal(app.getState().translations['zh-CN'][paragraph.id].text, '人工修改译文中的表达。');
  const revision = await app.createRequest({ kind: 'revision', segmentIds: [paragraph.id] });
  assert.equal(revision.segments[0].sourceAuthority.kind, 'literal-reading-v1');
  const proposal = await app.proposeRevision({ requestId: revision.requestId, reason: 'Clarify the selected Chinese intent.', edits: [{ segmentId: paragraph.id, beforeHash: paragraph.beforeHash, replacement: revision.segments[0].text.replace('remains.', 'is preserved.') }] });
  assert.equal(proposal.edits[0].replacement, 'An original state $x=1$ is preserved.');
  assert.equal(proposal.edits[0].sourceAuthority.snapshotId, state.project.snapshotId);
  const request = await app.createRequest({ kind: 'translation', segmentIds: [paragraph.id] });
  await app.submitTranslationResult({ requestId: request.requestId, translations: [{ segmentId: paragraph.id, text: request.segments[0].text.replace('An original state', '原始状态').replace('remains.', '保持不变。') }] });
  assert.equal(app.getState().requests.find(item => item.requestId === request.requestId).status, 'completed');
  assert.equal(await readFile(file, 'utf8'), text);
  const next = new PaperApplication({ dataRoot: path.join(temp, 'private') }); await next.openProject({ root: source, mainFile: 'main.tex' });
  assert.equal(next.getState().readingParagraphs[0].id, paragraph.id);
  assert.deepEqual(next.getState().originals[paragraph.id], state.originals[paragraph.id]);
});
