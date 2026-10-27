import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,appendFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {PaperApplication} from '../src/application.mjs';
import {WorkspaceService} from '../src/workspace-service.mjs';
import {createPaperServer} from '../src/server.mjs';

const filename=fileURLToPath(import.meta.url),root=fileURLToPath(new URL('../',import.meta.url)),threadId='synthetic-ticket-owner';
const digest=value=>createHash('sha256').update(value).digest('hex');
const selection={threadId,model:'synthetic-no-model',effort:'medium',title:'Synthetic shared ticket integration'};

async function controller(config,{canEnqueue=false}={}){
 const app=new PaperApplication({dataRoot:config.dataRoot});app.desktopExecutionEnabled=true;await app.initialize();await app.openProject({root:config.sourceRoot,mainFile:'main.tex',sourceLanguage:'en',targetLanguage:'zh-CN'});
 const producer={state:()=>({desktopQueueVerified:true}),async enqueue(input,{beforeEnqueue}={}){if(!canEnqueue)throw Object.assign(Error('Background callback process must never enqueue another model request.'),{code:'SYNTHETIC_ENQUEUE_FORBIDDEN'});await beforeEnqueue?.({...selection,cwd:config.sourceRoot});await appendFile(config.receipts,JSON.stringify({pid:process.pid,clientUserMessageId:input.clientUserMessageId,inputHash:digest(input.text)})+'\n');return{threadId,clientUserMessageId:input.clientUserMessageId,inputHash:digest(input.text),status:'queued',queuedSubmissionId:'synthetic-one-delivery'};},async close(){}};
 const service=new WorkspaceService({initialApp:app,factory:async()=>{throw Error('The fixture cannot switch to another paper.');},dataRoot:config.registryRoot,codexRoot:path.join(config.directory,'synthetic-codex'),hostOptions:{native:true,cwd:config.sourceRoot,env:{CODEX_THREAD_ID:threadId},explicitWorkspace:config.sourceRoot,explicitMainFile:'main.tex'},createDesktopProducer:async()=>{await appendFile(config.factories,JSON.stringify({pid:process.pid,canEnqueue})+'\n');return producer;}});await service.initializeWorkspace();
 await service.desktopExecution.bind({app,project:app.core.getState().project,selection});app.desktopThreadId=()=>service.desktopExecution.state().threadId;app.desktopRequestRunner=input=>service.desktopExecution.runRequest(app,input);
 return{app,service};
}

async function producerProcess(config){
 const {app,service}=await controller(config,{canEnqueue:true});let pending=Promise.resolve();
 process.on('message',message=>{pending=pending.then(async()=>{try{let result;
  if(message.action==='queue'){const ids=app.getState().readingParagraphs.map(p=>p.id),request=await app.createRequest({kind:'revision',language:'zh-CN',segmentIds:ids,prompt:'Clarify all twenty-two synthetic paragraphs; retain protected objects.'});const receipt=await service.runDesktopRequest({requestId:request.requestId});result={request,receipt,pid:process.pid};}
  else if(message.action==='refresh'){await service.refreshExternalJobStatus();result={messages:service.desktopExecution.state().messages,requests:app.core.getState().requests};}
  else if(message.action==='cancel'){const jobId=`desktop-${message.requestId}`;result=await app.cancelJob({jobId});await app.jobs.get(jobId)?.cancellation;}
  else if(message.action==='revoke'){await app._flowAction(()=>{for(const key of ['nativeChatBinding','backgroundChatReference'])if(app.flow[key])app.flow[key]={...app.flow[key],threadId:'different-synthetic-chat'};});result={revoked:true};}
  else if(message.action==='tamper-hash'){await app._flowAction(()=>{app.flow.desktopMessages.find(row=>row.requestId===message.requestId).requestHash='0'.repeat(64);});result={tampered:true};}
  else if(message.action==='close'){await service.close();process.send?.({id:message.id,ok:true,result:{closed:true}},()=>process.exit(0));return;}
  else throw Error('Unknown fixture command');process.send?.({id:message.id,ok:true,result});
 }catch(error){process.send?.({id:message.id,ok:false,error:{code:error.code,message:error.message}});}});});
 process.send?.({ready:true,pid:process.pid});
}

async function backgroundProcess(config){
 const {app,service}=await controller(config);const server=createPaperServer({service,instanceId:'synthetic-background-session',nativeThreadId:config.caller||threadId,uiHtml:'<!doctype html>'});
 let gateArmed=false;const propose=app.proposeRevision.bind(app);
 app.proposeRevision=async(input,options)=>{if(gateArmed){gateArmed=false;await writeFile(path.join(config.directory,'proposal-entered'),'synthetic outer approval reached');await waitForFile(path.join(config.directory,'proposal-release'));}return propose(input,options);};
 server.registerTool('synthetic_test_state',{inputSchema:{}},async()=>({content:[],structuredContent:{pid:process.pid,requestCount:app.core.getState().requests.length,messageCount:app.flow.desktopMessages?.length||0,ownedRuntimes:service.desktopExecution.runtimes.size,project:app.core.getState().project}}));
 server.registerTool('synthetic_test_identical_bind',{inputSchema:{}},async()=>{await service.desktopExecution.bind({app,project:app.core.getState().project,selection});return{content:[],structuredContent:{rebound:true,pid:process.pid}};});
 server.registerTool('synthetic_test_arm_proposal_gate',{inputSchema:{}},async()=>{gateArmed=true;return{content:[],structuredContent:{armed:true}};});
 await server.connect(new StdioServerTransport());process.stdin.once('end',()=>{void service.close().finally(()=>process.exit(0));});
}
async function waitForFile(filename){const deadline=Date.now()+10000;while(Date.now()<deadline){try{return await readFile(filename,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Synthetic process synchronization timed out.');}

if(process.argv[2]==='--synthetic-producer')await producerProcess(JSON.parse(process.argv[3]));
else if(process.argv[2]==='--synthetic-background')await backgroundProcess(JSON.parse(process.argv[3]));
else{
 async function fixture(t){
  const owned=path.join(root,'work/desktop-ticket-recovery-integration');await mkdir(owned,{recursive:true});const directory=await mkdtemp(path.join(owned,'case-')),sourceRoot=path.join(directory,'source');await mkdir(sourceRoot);
  const original='\\documentclass{article}\n\\begin{document}\n\n'+Array.from({length:22},(_,i)=>`Synthetic paragraph ${i} preserves $x_{${i}}=1$ and \\cite{ref${i}}.`).join('\n\n')+'\n\n\\end{document}\n';await writeFile(path.join(sourceRoot,'main.tex'),original);
  const config={directory,sourceRoot,dataRoot:path.join(directory,'private'),registryRoot:path.join(directory,'registry'),receipts:path.join(directory,'enqueue.jsonl'),factories:path.join(directory,'factories.jsonl')};const seed=new PaperApplication({dataRoot:config.dataRoot});seed.desktopExecutionEnabled=true;await seed.openProject({root:sourceRoot,mainFile:'main.tex',sourceLanguage:'en',targetLanguage:'zh-CN'});await seed._flowAction(()=>{seed.flow.nativeChatBinding={projectId:seed.core.getState().project.id,...selection,source:'originating-host-chat'};});for(const p of seed.getState().readingParagraphs)await seed.saveDraft({segmentId:p.id,language:'zh-CN',text:p.source+' Author intent.',expectedRevision:0});await seed.close();
  const backgrounds=[],children=[];let sourceExpected=original;
  async function background(caller=threadId){const transport=new StdioClientTransport({command:process.execPath,args:[filename,'--synthetic-background',JSON.stringify({...config,caller})],cwd:root,stderr:'pipe'});let stderr='';transport.stderr?.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-4000);});const client=new Client({name:'synthetic-ticket-recovery',version:'1'});try{await client.connect(transport);}catch(error){throw Error(error.message+' '+stderr);}backgrounds.push(client);return client;}
  async function producer(){const child=fork(filename,['--synthetic-producer',JSON.stringify(config)],{cwd:root,execArgv:[],stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});children.push(child);let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-4000);});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Producer did not become ready: '+stderr)),15000);child.once('error',reject);child.once('exit',code=>reject(Error('Producer exited before ready: '+code+' '+stderr)));child.on('message',message=>{if(message.ready){clearTimeout(timer);resolve();}});});return{pid:child.pid,rpc:(action,payload={})=>new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>{child.off('message',listener);reject(Error('Fixture command timed out: '+action+' '+stderr));},15000),listener=message=>{if(message.id!==id)return;clearTimeout(timer);child.off('message',listener);if(message.ok)resolve(message.result);else reject(Object.assign(Error(message.error.message),{code:message.error.code}));};child.on('message',listener);child.send({id,action,...payload});})};}
  t.after(async()=>{for(const client of backgrounds)await client.close().catch(()=>{});for(const child of children){if(child.exitCode===null){child.kill();await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,2000).unref();});}}assert.equal(await readFile(path.join(sourceRoot,'main.tex'),'utf8'),sourceExpected);assert(directory.startsWith(owned+path.sep));await rm(directory,{recursive:true,force:true});});
  return{config,original,background,producer,expectSource:value=>{sourceExpected=value;},async enqueues(){return(await readFile(config.receipts,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);},async durable(){const files=await import('node:fs/promises');const dirs=await files.readdir(path.join(config.dataRoot,'projects'));assert.equal(dirs.length,1);return JSON.parse(await readFile(path.join(config.dataRoot,'projects',dirs[0],'state.json'),'utf8'));}};
 }
 const ok=response=>{assert.notEqual(response.isError,true,response.structuredContent?.error?.code+': '+response.structuredContent?.error?.message);assert.equal(response._meta?.paperUiToken,undefined);return response.structuredContent;};
 const call=(client,name,args={})=>client.callTool({name,arguments:args},undefined,{timeout:20000});
 const proposal=(request)=>({requestId:request.requestId,reason:'Clarify the exact current synthetic author intent.',edits:request.segments.map(p=>({segmentId:p.id||p.segmentId,beforeHash:p.beforeHash,replacement:p.text.replace('Synthetic paragraph','Revised synthetic paragraph')}))});
 const denied=response=>{assert.equal(response.isError,true,'A revoked, stale or foreign ticket must be refused.');assert(response.structuredContent?.error?.code);assert(!JSON.stringify(response.structuredContent).includes('Synthetic paragraph'));return response.structuredContent.error.code;};
 test('separate stdio background admits the exact newly queued 22-paragraph disk ticket after an identical bind without enqueueing twice',{timeout:45000},async t=>{
  const f=await fixture(t),background=await f.background(),before=ok(await call(background,'synthetic_test_state'));assert.equal(before.requestCount,0);assert.equal(before.messageCount,0);
  const producer=await f.producer(),queued=await producer.rpc('queue');assert.notEqual(before.pid,producer.pid);assert.equal(queued.request.segmentIds.length,22);assert.equal((await f.enqueues()).length,1);
  ok(await call(background,'synthetic_test_identical_bind'));const request=ok(await call(background,'bilingual_paper_get_request',{requestId:queued.request.requestId}));assert.equal(request.segments.length,22);
  const returned=ok(await call(background,'bilingual_paper_propose_revision',proposal(request)));assert(returned.proposalId);await producer.rpc('refresh');assert.equal((await f.enqueues()).length,1);const durable=await f.durable();assert.equal(durable.requests.find(row=>row.requestId===queued.request.requestId).status,'completed');assert.equal(durable.proposals.length,1);assert.equal(durable.proposals[0].applicationState,'notApplied');assert.equal(ok(await call(background,'synthetic_test_state')).ownedRuntimes,0);const factories=(await readFile(f.config.factories,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(factories.filter(row=>row.pid===before.pid).length,1,'Identical binding must keep its original queue producer.');assert.equal(await readFile(path.join(f.config.sourceRoot,'main.tex'),'utf8'),f.original);
 });
 test('background restart preserves the current disk ticket and exact callback replay is idempotent',{timeout:45000},async t=>{
  const f=await fixture(t),old=await f.background(),before=ok(await call(old,'synthetic_test_state')),producer=await f.producer(),queued=await producer.rpc('queue');await old.close();const background=await f.background(),after=ok(await call(background,'synthetic_test_state'));assert.notEqual(before.pid,after.pid);
  const request=ok(await call(background,'bilingual_paper_get_request',{requestId:queued.request.requestId})),payload=proposal(request),first=ok(await call(background,'bilingual_paper_propose_revision',payload)),replayed=ok(await call(background,'bilingual_paper_propose_revision',payload));assert.equal(replayed.proposalId,first.proposalId);await producer.rpc('refresh');assert.equal((await f.durable()).proposals.length,1);assert.equal((await f.enqueues()).length,1);const tools=await background.listTools();assert(!tools.tools.some(tool=>/apply|accept|undo|confirmation/u.test(tool.name)));
 });
 test('separate producer cancellation revokes a ticket already admitted into background memory',{timeout:45000},async t=>{
  const f=await fixture(t),background=await f.background(),producer=await f.producer(),queued=await producer.rpc('queue');ok(await call(background,'synthetic_test_identical_bind'));const request=ok(await call(background,'bilingual_paper_get_request',{requestId:queued.request.requestId}));await producer.rpc('cancel',{requestId:request.requestId});denied(await call(background,'bilingual_paper_get_request',{requestId:request.requestId}));denied(await call(background,'bilingual_paper_propose_revision',proposal(request)));assert.equal((await f.durable()).proposals.length,0);assert.equal((await f.enqueues()).length,1);
 });
 test('cancellation after outer native approval is checked before a proposal can be committed',{timeout:45000},async t=>{
  const f=await fixture(t),background=await f.background(),producer=await f.producer(),queued=await producer.rpc('queue');ok(await call(background,'synthetic_test_identical_bind'));const request=ok(await call(background,'bilingual_paper_get_request',{requestId:queued.request.requestId}));ok(await call(background,'synthetic_test_arm_proposal_gate'));const returning=call(background,'bilingual_paper_propose_revision',proposal(request));await waitForFile(path.join(f.config.directory,'proposal-entered'));await producer.rpc('cancel',{requestId:request.requestId});await writeFile(path.join(f.config.directory,'proposal-release'),'cancel persisted in the separate process');denied(await returning);const durable=await f.durable();assert.equal(durable.proposals.length,0,'A rejection after persisting a proposal is too late.');assert.equal(durable.requests.find(row=>row.requestId===request.requestId).status,'pending');assert.equal((await f.enqueues()).length,1);
 });
 test('closing the producer revokes its owned unfinished return without starting another delivery',{timeout:45000},async t=>{
  const f=await fixture(t),background=await f.background(),producer=await f.producer(),queued=await producer.rpc('queue');ok(await call(background,'synthetic_test_identical_bind'));const request=ok(await call(background,'bilingual_paper_get_request',{requestId:queued.request.requestId}));await producer.rpc('close');denied(await call(background,'bilingual_paper_propose_revision',proposal(request)));assert.equal((await f.durable()).proposals.length,0);assert.equal((await f.enqueues()).length,1);
 });
 test('durable chat revocation cannot be overwritten by the background cached binding',{timeout:45000},async t=>{
  const f=await fixture(t),background=await f.background(),producer=await f.producer(),queued=await producer.rpc('queue');ok(await call(background,'synthetic_test_identical_bind'));const request=ok(await call(background,'bilingual_paper_get_request',{requestId:queued.request.requestId}));await producer.rpc('revoke');denied(await call(background,'bilingual_paper_get_request',{requestId:request.requestId}));denied(await call(background,'bilingual_paper_propose_revision',proposal(request)));assert.equal((await f.durable()).proposals.length,0);assert.equal((await f.enqueues()).length,1);
 });
 test('physical source drift rejects the old queued request and leaves the external source bytes intact',{timeout:45000},async t=>{
  const f=await fixture(t),background=await f.background(),producer=await f.producer(),queued=await producer.rpc('queue');ok(await call(background,'synthetic_test_identical_bind'));const request=ok(await call(background,'bilingual_paper_get_request',{requestId:queued.request.requestId})),changed=f.original+'\n% external synthetic source edit\n';await writeFile(path.join(f.config.sourceRoot,'main.tex'),changed);f.expectSource(changed);denied(await call(background,'bilingual_paper_propose_revision',proposal(request)));assert.equal((await f.durable()).proposals.length,0);assert.equal((await f.enqueues()).length,1);
 });
 test('a foreign native chat cannot read or return a valid recovered ticket',{timeout:45000},async t=>{
  const f=await fixture(t),background=await f.background(),producer=await f.producer(),queued=await producer.rpc('queue');ok(await call(background,'synthetic_test_identical_bind'));const request=ok(await call(background,'bilingual_paper_get_request',{requestId:queued.request.requestId})),foreign=await f.background('foreign-synthetic-chat');denied(await call(foreign,'bilingual_paper_get_request',{requestId:request.requestId}));denied(await call(foreign,'bilingual_paper_propose_revision',proposal(request)));assert.equal((await f.durable()).proposals.length,0);assert.equal((await f.enqueues()).length,1);
 });
 test('a disk request-fingerprint mismatch cannot reuse an earlier admitted background ticket',{timeout:45000},async t=>{
  const f=await fixture(t),background=await f.background(),producer=await f.producer(),queued=await producer.rpc('queue');ok(await call(background,'synthetic_test_identical_bind'));const request=ok(await call(background,'bilingual_paper_get_request',{requestId:queued.request.requestId}));await producer.rpc('tamper-hash',{requestId:request.requestId});denied(await call(background,'bilingual_paper_get_request',{requestId:request.requestId}));denied(await call(background,'bilingual_paper_propose_revision',proposal(request)));assert.equal((await f.durable()).proposals.length,0);assert.equal((await f.enqueues()).length,1);
 });
}
