import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {PaperApplication,buildInputHash} from '../src/application.mjs';
import {WorkspaceService} from '../src/workspace-service.mjs';
import {DesktopQueueProducer} from '../src/desktop-queue.mjs';
import {editorDraftsFor} from '../src/editor-drafts.mjs';
import {sha256} from '../src/latex.mjs';

for(const scenario of ['typing','window-closed','second-window'])test(`${scenario} after the final pre-lock capture is freshly checked at the exclusive writer lock`,async t=>{
 const parent=fileURLToPath(new URL('../work/one-click-audit/',import.meta.url));await mkdir(parent,{recursive:true});
 const directory=await mkdtemp(path.join(parent,'last-input-')),source=path.join(directory,'source');await mkdir(source);
 const original=String.raw`\documentclass{article}
\begin{document}
A current claim keeps $x=1$.
\end{document}
`,filename=path.join(source,'main.tex');await writeFile(filename,original);
 const compiler={probe:async()=>({available:true,isolated:true}),build:async input=>{const pdfPath=path.join(directory,`${randomUUID()}.pdf`);await writeFile(pdfPath,'%PDF-synthetic-oneclick-audit');return{buildId:`build-${randomUUID()}`,status:'success',snapshotId:input.snapshotId,candidateHash:input.candidateHash,inputHash:buildInputHash(input),pdfPath,pdfHash:sha256(await readFile(pdfPath)),isolation:{verified:true}};}};
 const app=new PaperApplication({dataRoot:path.join(directory,'private'),compiler,engine:'pdflatex'});await app.initialize();await app.openProject({root:source,mainFile:'main.tex'});
 const threadId='synthetic-lock-input-chat',calls=[];
 class Bridge{async connect(){}async close(){}async _request(method,params){calls.push(method);if(method==='thread/read')return{thread:{id:threadId,model:'gpt-6-astra',reasoningEffort:'high',cwd:source}};if(method==='thread/queue/add')return{queuedSubmission:{id:`audit-${calls.length}`,clientUserMessageId:params.clientUserMessageId,input:params.input}};throw Error(method);}}
 const service=new WorkspaceService({initialApp:app,factory:async()=>app,dataRoot:path.join(directory,'registry'),codexRoot:path.join(directory,'codex'),createDesktopProducer:async()=>new DesktopQueueProducer({threadId,dataRoot:path.join(directory,'producer'),Bridge,desktopQueueVerified:true})});
 let timer; t.after(async()=>{clearInterval(timer);await service.close();await Promise.allSettled([...app.jobs.values()].map(job=>job.promise));await rm(directory,{recursive:true,force:true});});
 const project=app.getState().project,paragraph=app.getState().readingParagraphs.find(row=>row.source.includes('current claim'));
 await app._flowAction(()=>{app.flow.backgroundChatReference={projectId:project.id,threadId,model:'gpt-6-astra',effort:'high'};});await service.desktopExecution.bind({app,project,selection:{threadId,model:'gpt-6-astra',effort:'high'}});app.desktopExecutionEnabled=true;app.desktopThreadId=()=>service.desktopExecution.state().available?threadId:null;app.desktopRequestRunner=input=>service.desktopExecution.runRequest(app,input);
 await app.saveTranslationDraftWithFormulaEdits({segmentId:paragraph.id,language:'zh-CN',text:'当前论断改为 $x=2$。',expectedRevision:0,expectedProjectId:project.id,expectedSnapshotId:project.snapshotId});
 const saved=app.getState().translations['zh-CN'][paragraph.id],store=editorDraftsFor(app),scope={clientId:'synthetic-live-editor',expectedProjectId:project.id,expectedSnapshotId:project.snapshotId};
 let live={text:saved.text,saveState:'saved',bufferSequence:0},sequence=0,lastCapture=null,lockReached=false,connected=true;store.captureTimeoutMs=50;
 store.poll(scope);
 // A live page answers explicit capture requests immediately. Ordinary typing
 // has not yet reached the separate debounced unsolicited-publish channel.
 timer=setInterval(()=>{try{if(!connected)return;const answer=store.poll(scope);if(!answer.captureId||answer.captureId===lastCapture)return;lastCapture=answer.captureId;store.publish({...scope,sequence:++sequence,captureId:answer.captureId,drafts:[{segmentId:paragraph.id,language:'zh-CN',...live,baseDraftRevision:saved.revision,composing:false,sourceSnapshotId:project.snapshotId,baseSourceHash:saved.sourceHash}]});}catch{}},1);
 const write=app.writer.write.bind(app.writer);app.writer.write=(input,hooks)=>write(input,{...hooks,onLocked:async()=>{lockReached=true;if(scenario==='typing')live={text:'刚刚输入、尚未保存的作者内容 $x=9$。',saveState:'dirty',bufferSequence:1};else if(scenario==='window-closed')connected=false;else store.poll({...scope,clientId:'second-synthetic-editor'});await hooks.onLocked();}});
 await service.startOneClickWriteback({sourceSegmentIds:[paragraph.id],language:'zh-CN',idempotencyKey:'last-input-lock',expectedProjectId:project.id,expectedSnapshotId:project.snapshotId});await app.oneClick.waitForIdle();
 const task=app.getState().oneClickWritebacks.tasks[0],request=app.core.getState().requests.find(row=>row.requestId===task.requestId),proposal=await app.proposeRevision({requestId:request.requestId,reason:'Faithful synthetic pending result.',edits:request.segments.map(row=>({segmentId:row.id,beforeHash:row.beforeHash,replacement:'A revised claim keeps $x=2$.'}))});await service.desktopExecution.requestSubmitted(app,request.requestId,threadId,proposal);await app.oneClick.waitForIdle();
 assert.equal(lockReached,true);assert.equal(await readFile(filename,'utf8'),original,'The fresh unsaved author input must prevent the old saved scope from writing.');
 assert.equal(app.flow.transactions.filter(row=>row.state==='applied').length,0);assert.equal(app.flow.transactions[0].state,'conflict','A verified pre-first-write refusal needs no partial-source recovery.');assert.equal(app.getState().translations['zh-CN'][paragraph.id].text,saved.text);if(scenario==='typing')assert.equal(live.text,'刚刚输入、尚未保存的作者内容 $x=9$。');assert.equal(calls.filter(method=>method==='thread/queue/add').length,1);
});
