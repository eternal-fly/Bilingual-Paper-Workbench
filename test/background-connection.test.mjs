import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundConnection } from '../src/background-connection.mjs';
function fixture(){
 let stored=null,resumed=0,closed=0;
 const chat={getState:()=>({threadId:'paper-chat',boundThreadId:'paper-chat',threadName:'Paper',connected:true,model:'gpt-6-astra',busy:false}),async connect(){},async close(){closed++;}};
 const app={core:{getState:()=>({project:{id:'project-one',snapshotId:'snap-one'}}),async _assertSourceCurrent(){}},flow:{},jobs:new Map(),async _flowAction(f){await f();},async createBoundChat(){return chat;},emit(){},async connectExistingChat(input){resumed++;stored=input;this.chat=chat;return chat.getState();}};
 return {app,controller:new BackgroundConnection(app),chat,counts:()=>({resumed,closed,stored})};
}
test('reference and handoff prepare read exact chat without resuming or model requests',async()=>{
 const f=fixture();await f.controller.remember({threadId:'paper-chat',model:'gpt-6-astra',effort:'medium'});
 const p=await f.controller.prepare({expectedProjectId:'project-one',expectedSnapshotId:'snap-one'});
 assert.equal(p.threadId,'paper-chat');assert.equal(f.counts().resumed,0);assert.equal(f.counts().closed,1);
 await f.controller.activate({threadId:p.threadId,handoffId:p.handoffId,expectedProjectId:p.projectId,expectedSnapshotId:p.snapshotId});assert.equal(f.counts().resumed,1);assert.equal(f.controller.state().phase,'connected');
});
test('stale identity, unsolicited chat ID and busy release fail closed',async()=>{
 const f=fixture();await assert.rejects(f.controller.remember({threadId:'other',model:'gpt-6-astra'}),{code:'THREAD_MISMATCH'});
 await f.controller.remember({threadId:'paper-chat',model:'gpt-6-astra'});const p=await f.controller.prepare({expectedProjectId:'project-one',expectedSnapshotId:'snap-one'});
 await assert.rejects(f.controller.activate({threadId:p.threadId,handoffId:p.handoffId,expectedProjectId:'other',expectedSnapshotId:'snap-one'}),{code:'VERSION_CONFLICT'});
 assert.equal(f.counts().resumed,0);
});
test('Desktop ownership only waits; status retries connection without sending model messages',async()=>{
 const f=fixture();await f.controller.remember({threadId:'paper-chat',model:'gpt-6-astra'});const p=await f.controller.prepare({expectedProjectId:'project-one',expectedSnapshotId:'snap-one'});
 f.app.connectExistingChat=async()=>{throw Object.assign(Error('occupied'),{code:'THREAD_IN_USE'});};
 assert.equal((await f.controller.activate({threadId:p.threadId,handoffId:p.handoffId,expectedProjectId:p.projectId,expectedSnapshotId:p.snapshotId})).phase,'waiting-desktop-release');
 assert.equal((await f.controller.status({threadId:p.threadId,handoffId:p.handoffId,expectedProjectId:p.projectId,expectedSnapshotId:p.snapshotId})).phase,'waiting-desktop-release');
 assert.equal(f.counts().resumed,0);
});
test('a live paper/native data lease waits without takeover, while a damaged lease remains an explicit failure',async()=>{
 for(const code of ['NATIVE_CHAT_IN_USE','CHAT_IN_USE']){
  const f=fixture();await f.controller.remember({threadId:'paper-chat',model:'gpt-6-astra'});const p=await f.controller.prepare({expectedProjectId:'project-one',expectedSnapshotId:'snap-one'});
  f.app.connectExistingChat=async()=>{throw Object.assign(Error('An existing live owner holds the paper data lease.'),{code});};
  const result=await f.controller.activate({handoffId:p.handoffId,threadId:p.threadId,expectedProjectId:p.projectId,expectedSnapshotId:p.snapshotId});
  assert.equal(result.phase,'waiting-desktop-release');assert.equal(result.binding.threadId,'paper-chat');assert.equal(f.counts().resumed,0);assert.equal(f.counts().closed,1);
 }
 const f=fixture();await f.controller.remember({threadId:'paper-chat',model:'gpt-6-astra'});const p=await f.controller.prepare({expectedProjectId:'project-one',expectedSnapshotId:'snap-one'});
 f.app.connectExistingChat=async()=>{throw Object.assign(Error('The saved lease requires explicit identity recovery.'),{code:'NATIVE_CHAT_LEASE_RECOVERY_REQUIRED'});};
 await assert.rejects(f.controller.activate({handoffId:p.handoffId,threadId:p.threadId,expectedProjectId:p.projectId,expectedSnapshotId:p.snapshotId}),{code:'NATIVE_CHAT_LEASE_RECOVERY_REQUIRED'});assert.equal(f.controller.state().phase,'failed');assert.equal(f.counts().resumed,0);
});
test('a plan cannot replace another activation while source validation is awaiting',async()=>{
 const f=fixture();await f.controller.remember({threadId:'paper-chat',model:'gpt-6-astra'});
 const p=await f.controller.prepare({expectedProjectId:'project-one',expectedSnapshotId:'snap-one'});
 let sourceReady,connectionReady;f.app.core._assertSourceCurrent=()=>new Promise(r=>{sourceReady=r;});
 const preparing=f.controller.prepare({expectedProjectId:p.projectId,expectedSnapshotId:p.snapshotId,model:'other-model'});
 await Promise.resolve();f.app.connectExistingChat=()=>new Promise(r=>{connectionReady=r;});
 const activating=f.controller.activate({handoffId:p.handoffId,threadId:p.threadId,expectedProjectId:p.projectId,expectedSnapshotId:p.snapshotId});
 sourceReady();await assert.rejects(preparing,{code:'CHAT_BUSY'});assert.equal(f.controller.plan.model,'gpt-6-astra');connectionReady();await activating;
});
