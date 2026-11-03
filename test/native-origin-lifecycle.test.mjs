import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdir,mkdtemp,writeFile,copyFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createPaperServer} from '../src/server.mjs';
import {CodexBridge} from '../src/codex-bridge.mjs';
import {assertNativePaperScope} from '../src/native-paper-tools.mjs';
import {BackgroundWindowController} from '../src/native-window.mjs';
async function fixture(t,{thread='chat-a',explicit}={}){
 const service=new EventEmitter();let current=thread,opens=0;const forwarded=[];
 service.getHostContext=()=>({native:true,taskIdAvailable:Boolean(current),hostTaskId:current});service.getState=()=>({project:null,segments:[],translations:{},requests:[],capabilities:{}});
 const server=createPaperServer({service,backgroundWindow:true,...(explicit!==undefined?{nativeThreadId:explicit}:{}),uiHtml:'<!doctype html>',openIndependentWindow:async()=>{opens++;return{opened:true,mode:'background-workbench'};},dispatchBackground:async(action,payload)=>{forwarded.push({action,payload});return{result:{origin:payload.originThreadId},state:{project:null}};}}),client=new Client({name:'synthetic-origin-lifecycle',version:'1'}),[cs,ss]=InMemoryTransport.createLinkedPair();await server.connect(ss);await client.connect(cs);t.after(async()=>{await client.close();await server.close();});return{client,forwarded,setThread:id=>current=id,opens:()=>opens};
}
test('a reused MCP instance takes each current trusted host identity instead of retaining its startup chat',async t=>{
 const f=await fixture(t);await f.client.callTool({name:'bilingual_paper_get_state',arguments:{}});f.setThread('chat-b');await f.client.callTool({name:'bilingual_paper_get_state',arguments:{}});assert.deepEqual(f.forwarded.map(row=>row.payload.originThreadId),['chat-a','chat-b']);
});
test('missing host identity returns same-turn recovery before opening a window or importing files',async t=>{
 const f=await fixture(t,{thread:null});const result=await f.client.callTool({name:'bilingual_paper_editor',arguments:{sourcePath:'C:/synthetic/explicit-paper.zip'}});assert.equal(result.isError,true);assert.equal(result.structuredContent.error.code,'HOST_CHAT_UNAVAILABLE');assert.equal(result.structuredContent.recovery.action,'open');assert(result.structuredContent.nativeAccess.currentTransport.verbs.includes('open'));assert.equal(f.opens(),0);assert.equal(f.forwarded.length,0);
 const imported=await f.client.callTool({name:'bilingual_paper_import_files',arguments:{sourcePath:'C:/synthetic/explicit-paper.zip'}});assert.equal(imported.isError,true);assert.equal(f.opens(),0);assert.equal(f.forwarded.length,0);
});
test('explicit missing forwarded identity never inherits a saved host identity or model metadata',async t=>{
 const f=await fixture(t,{thread:'saved-chat',explicit:null});await f.client.callTool({name:'bilingual_paper_get_state',arguments:{},_meta:{threadId:'forged-chat'}});assert.equal(f.forwarded.length,0);
});
test('window routing refuses a caller change during readiness instead of overwriting its originating identity',async()=>{
 let thread='chat-a',release,entered;const ready=new Promise(resolve=>entered=resolve),wait=new Promise(resolve=>release=resolve),calls=[];
 const service={getState:()=>({workspaceIndex:{hostContext:{native:true,taskIdAvailable:true,hostTaskId:thread}},project:null})};
 const controller=new BackgroundWindowController({service,dataRoot:path.resolve('work/native-origin-lifecycle'),instanceId:'test',ensure:async()=>{entered();await wait;return{reused:true};},readSession:async()=>({url:'http://127.0.0.1:1234/#session='+ 's'.repeat(43)}),dispatchRequest:async input=>{calls.push(input);return{};}});
 const pending=controller.dispatch('callNativeTool',{name:'bilingual_paper_get_state',arguments:{},bindingId:'native-test',originThreadId:'chat-a'});await ready;thread='chat-b';release();await assert.rejects(pending,{code:'HOST_CHAT_CHANGED'});assert.equal(calls.length,0);
});

for(const pauseAt of ['signing','synchronizing','launching'])test(`window routing rechecks its exact caller after ${pauseAt}`,{timeout:5000},async()=>{
 let thread='chat-a',release,entered;const ready=new Promise(resolve=>entered=resolve),wait=new Promise(resolve=>release=resolve),calls=[];
 const root=path.resolve('work/synthetic-origin-project'),service={getState:()=>({project:null,workspaceIndex:{hostContext:{native:true,taskIdAvailable:true,hostTaskId:thread,projectRoot:root,source:'native-launch-cwd',roots:[{root}]}}})};
 const pause=async()=>{entered();await wait;};
 const controller=new BackgroundWindowController({service,dataRoot:path.resolve('work/native-origin-lifecycle'),instanceId:'test',ensure:async()=>({reused:true}),readSession:async()=>({url:'http://127.0.0.1:1234/#session='+'s'.repeat(43)}),signProjectRefresh:async()=>{if(pauseAt==='signing')await pause();return{threadId:'chat-a'};},dispatchRequest:async input=>{calls.push(input.action);if(input.action==='syncHostProject'&&pauseAt==='synchronizing')await pause();return{};},launchWindow:async()=>{await pause();return{requestedState:'normal',width:1280,height:800,x:0,y:0};}});
 const pending=pauseAt==='launching'?controller.open():controller.dispatch('callNativeTool',{name:'bilingual_paper_get_state',arguments:{},bindingId:'native-test',originThreadId:'chat-a'});
 await ready;thread='chat-b';release();await assert.rejects(pending,{code:'HOST_CHAT_CHANGED'});
 assert(!calls.includes('callNativeTool'),'a changed caller must not forward a model tool');
 if(pauseAt==='signing')assert.deepEqual(calls,[]);
 if(pauseAt==='synchronizing')assert.equal(controller.syncedHostProject,null,'a stale synchronization must not mark the new caller synchronized');
});
test('unverified same-chat runtime failures retain their actual recovery cause instead of pretending a foreign chat',()=>{
 const project={id:'project',snapshotId:'source'},app={core:{getState:()=>({project})},flow:{}};const service={active:app,originChat:{state:()=>({threadId:'chat-a',projectId:'project',snapshotId:'source',verified:false,phase:'waiting-runtime',retryable:true,error:{code:'CODEX_COMMAND_UNAVAILABLE',message:'Installed executable is temporarily unavailable.'}})}};
 assert.throws(()=>assertNativePaperScope(service,'chat-a'),{code:'CODEX_COMMAND_UNAVAILABLE'});assert.throws(()=>assertNativePaperScope(service,'foreign'),{code:'THREAD_MISMATCH'});
});
test('a trusted host changing chats revokes the prior caller even before its saved paper state changes',()=>{
 const project={id:'project',snapshotId:'source'},app={core:{getState:()=>({project})},flow:{nativeChatBinding:{projectId:'project',threadId:'chat-a',source:'originating-host-chat'}}};const service={active:app,getHostContext:()=>({native:true,taskIdAvailable:true,hostTaskId:'chat-b'})};assert.throws(()=>assertNativePaperScope(service,'chat-a'),{code:'THREAD_MISMATCH'});
});
test('a cached MCP environment cannot pin a newly installed controller to an obsolete package version',async()=>{
 const previous=process.env.PAPER_EDITOR_INSTALL_VERSION;process.env.PAPER_EDITOR_INSTALL_VERSION='0.0.1';try{const controller=new BackgroundWindowController({service:{},dataRoot:path.resolve('work/native-origin-lifecycle')});const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));assert.equal(controller.version,pkg.version);}finally{if(previous===undefined)delete process.env.PAPER_EDITOR_INSTALL_VERSION;else process.env.PAPER_EDITOR_INSTALL_VERSION=previous;}
});
test('a bridge recovers a removed official version path before spawning its metadata-only process',async t=>{
 const parent=path.resolve('work/native-origin-lifecycle');await mkdir(parent,{recursive:true});const dir=await mkdtemp(path.join(parent,'case-'));t.after(()=>rm(dir,{recursive:true,force:true}));const bin=path.join(dir,'OpenAI/Codex/bin'),old=path.join(bin,'1111111111111111/codex.exe'),fresh=path.join(bin,'2222222222222222/codex.exe');await mkdir(path.dirname(fresh),{recursive:true});await copyFile(process.execPath,fresh);const script=path.join(dir,'metadata-fixture.mjs');await writeFile(script,"process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',chunk=>{s+=chunk;for(;;){const i=s.indexOf('\\n');if(i<0)break;const line=s.slice(0,i);s=s.slice(i+1);const q=JSON.parse(line);if(q.id)process.stdout.write(JSON.stringify({id:q.id,result:{}})+'\\n');}});");
 const bridge=new CodexBridge({command:old,commandArgs:[script],dataRoot:path.join(dir,'private'),cwd:dir,requestTimeoutMs:3000});t.after(()=>bridge.close());await bridge.connect();assert.equal(bridge.getState().connected,true);await bridge.close();
});
