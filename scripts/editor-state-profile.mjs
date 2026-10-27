import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {PaperApplication} from '../src/application.mjs';
import {startLocalWeb} from '../src/local-web.mjs';

// A real private service/profile, with no compiler, chat or author manuscript.
const root=path.resolve(import.meta.dirname,'..'),owned=path.join(root,'work/editor-state-profile');await mkdir(owned,{recursive:true});
const directory=await mkdtemp(path.join(owned,'case-')),sourceRoot=path.join(directory,'source');await mkdir(sourceRoot);
const source='\\documentclass{article}\n\\begin{document}\n\n'+Array.from({length:123},(_,i)=>`Synthetic paragraph ${i} has a fixed formula $x_${i}=1$. `+Array.from({length:i===122?120:40},(_,j)=>`\\label{label-${i*40+j}}`).join('')).join('\n\n')+'\n\n\\end{document}\n';
const filename=path.join(sourceRoot,'main.tex');await writeFile(filename,source);
const app=new PaperApplication({dataRoot:path.join(directory,'private')});let web;
try{
  await app.openProject({root:sourceRoot,mainFile:'main.tex',targetLanguage:'zh-CN'});
  const initial=app.getState(),paragraph=initial.readingParagraphs[0];assert.equal(initial.readingParagraphs.length,123);
  const raw=app.core.getState();for(const row of initial.readingParagraphs){const namespace=app.reading.hasDerived(row.id)?'readingDrafts':'translations';raw[namespace]||={};raw[namespace]['zh-CN']||={};raw[namespace]['zh-CN'][row.id]={segmentId:row.id,language:'zh-CN',text:(row.id===paragraph.id?'Long editable prose. '.repeat(3200):'')+row.source,revision:1,origin:'human',status:'saved',sourceHash:row.sourceHash||row.beforeHash};}await app.core._commit(raw);
  const seeded=app.getState(),draft=seeded.translations['zh-CN'][paragraph.id];assert(draft.text.length>=60*1024);assert.equal((source.match(/\\label\{/g)||[]).length,5000);
  const measures=[];for(let i=0;i<6;i++){const start=performance.now(),state=app.getState(),viewMs=performance.now()-start,stringStart=performance.now(),json=JSON.stringify(state),serializeMs=performance.now()-stringStart,parseStart=performance.now();JSON.parse(json);measures.push({viewMs,serializeMs,parseMs:performance.now()-parseStart,bytes:Buffer.byteLength(json)});}
  web=await startLocalWeb({service:app,htmlPath:path.join(root,'dist/preview.html')});
  const request=async(action,payload={})=>{const start=performance.now(),response=await fetch(web.origin+'/api',{method:'POST',headers:{'Content-Type':'application/json',Origin:web.origin,Authorization:'Bearer '+web.token},body:JSON.stringify({action,payload})}),body=await response.text(),received=performance.now(),result=JSON.parse(body),parsed=performance.now();assert.equal(result.ok,true,result.error?.message);return{result,elapsedMs:parsed-start,responseMs:received-start,parseMs:parsed-received,bytes:Buffer.byteLength(body)};};
  const reads=[];for(let i=0;i<3;i++){const{result,...timing}=await request('state');assert.equal((result.state||result.result).readingParagraphs.length,123);reads.push(timing);}
  const saves=[];let text=draft.text;for(let i=0;i<3;i++){text+='x';const{result,...timing}=await request('saveTranslationDraftWithFormulaEdits',{segmentId:paragraph.id,language:'zh-CN',text,expectedRevision:i+1,expectedProjectId:initial.project.id,expectedSnapshotId:initial.project.snapshotId});assert.equal(result.result.draft.text,text);assert.equal(result.result.draft.revision,i+2);saves.push(timing);}
  assert.equal(await readFile(filename,'utf8'),source);assert.equal(app.getState().proposals.length,0);assert.equal(app.flow.transactions.length,0);
  const report={syntheticOnly:true,actualLocalService:true,paragraphs:123,sourceLabels:5000,renderedReferenceLabels:Object.keys(seeded.markdownContext.references.labels).length,bodyLength:draft.text.length,state:measures,reads,saves,sourcePreserved:true,noModelOrSourceTransactions:true};await writeFile(path.join(owned,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await web?.close();await app.close();assert(directory.startsWith(owned+path.sep));await rm(directory,{recursive:true,force:true});}
