import { randomUUID } from 'node:crypto';
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
const busy=app=>app._bindingPending||app.chat?.getState?.().busy||[...app.jobs.values()].some(job=>!job.finished);
/** Connection operations only. Never starts a chat or a model turn, and never
 * controls Desktop or another process. The host releases its own writer. */
export class BackgroundConnection {
 constructor(app){this.app=app;this.phase='inactive';this.plan=null;this.pending=null;this.lastAttempt=0;}
 reference(){const a=this.app,p=a.core.getState().project;return [a.flow?.nativeChatBinding,a.flow?.backgroundChatReference].find(r=>r&&r.projectId===p?.id&&id(r.threadId)&&id(r.model))||null;}
 state(){if(this.phase==='connected'&&this.app.chat?.getState?.().connected===false)this.phase='released';return {phase:this.phase,serviceOnline:Boolean(this.app.backgroundMode),binding:this.reference(),error:this.error||null};}
 scope(input={}){const p=this.app.core.getState().project;if(!p||p.id!==input.expectedProjectId||p.snapshotId!==input.expectedSnapshotId)fail('VERSION_CONFLICT','The paper source changed. Prepare this paper connection again.');return p;}
 async remember(input){
  if(!input||Object.keys(input).some(k=>!['threadId','model','effort'].includes(k))||!id(input.threadId)||!id(input.model)||input.effort!=null&&!id(input.effort))fail('INVALID_INPUT','Use one exact existing chat and model.');
  const a=this.app,p=a.core.getState().project;if(!p)fail('PROJECT_REQUIRED','Open the paper source first.');if(busy(a))fail('CHAT_BUSY','Finish the paper operation first.');
  const previous=this.reference();if(previous&&previous.threadId!==input.threadId)fail('THREAD_MISMATCH','The saved paper chat differs from the requested chat.');
  const next=await a.createBoundChat(input.threadId,{model:input.model,effort:input.effort});
  try{await next.connect();const s=next.getState();if(s.threadId!==input.threadId)fail('THREAD_MISMATCH','The existing chat identity did not match.');await a.core._assertSourceCurrent();await a._flowAction(()=>{if(a.core.getState().project?.id!==p.id)fail('VERSION_CONFLICT','The selected paper changed.');a.flow.backgroundChatReference={kind:'background-chat-reference',projectId:p.id,threadId:input.threadId,title:String(s.threadName||previous?.title||'').slice(0,160),model:input.model,effort:input.effort||null,verifiedAt:new Date().toISOString()};});}
  finally{await next.close();}
  if(a.backgroundMode){await a.chat?.close?.();const restored=await a.createBoundChat(input.threadId,{model:input.model,effort:input.effort});a.attachChat(restored);}
  a.emit('change');return this.state();
 }
 async prepare(input){
  if(this.pending)fail('CHAT_BUSY','Wait for the current connection attempt.');const p=this.scope(input),r=this.reference();if(!r)fail('CHAT_BINDING_REQUIRED','This paper has no verified existing chat reference.');if(busy(this.app))fail('CHAT_BUSY','Finish the paper operation first.');await this.app.core._assertSourceCurrent();this.scope(input);if(this.pending)fail('CHAT_BUSY','Wait for the current connection attempt.');
  if(input.model!==undefined&&!id(input.model)||input.effort!=null&&!id(input.effort))fail('INVALID_INPUT','Choose an available model.');
  this.plan={handoffId:randomUUID(),projectId:p.id,snapshotId:p.snapshotId,threadId:r.threadId,title:r.title,model:input.model||r.model,effort:input.effort||r.effort};this.phase='prepared';this.error=null;this.app.emit('change');return {...this.plan,phase:this.phase};
 }
 async activate(input){
  this.scope(input);const p=this.plan;if(!p||p.handoffId!==input.handoffId||p.projectId!==input.expectedProjectId||p.snapshotId!==input.expectedSnapshotId)fail('HANDOFF_EXPIRED','Prepare the exact paper connection again.');
  if(input.threadId!==undefined&&input.threadId!==p.threadId||input.model!==undefined&&input.model!==p.model||input.effort!==undefined&&input.effort!==p.effort)fail('THREAD_MISMATCH','The prepared chat selection changed.');
  if(this.pending)return this.pending;
  this.pending=this._activate(p).finally(()=>{this.pending=null;});return this.pending;
 }
 async _activate(p){
  this.phase='connecting';this.lastAttempt=Date.now();this.app.emit('change');
  try{await this.app.connectExistingChat({threadId:p.threadId,model:p.model,...(p.effort?{effort:p.effort}:{}),expectedProjectId:p.projectId,expectedSnapshotId:p.snapshotId});this.phase='connected';this.error=null;}
  catch(e){if(['THREAD_IN_USE','CHAT_BUSY','CHAT_LOCKED','NATIVE_CHAT_IN_USE','CHAT_IN_USE'].includes(e.code)||/thread.*in use|already.*loaded/iu.test(e.message||'')){this.phase='waiting-desktop-release';this.error={code:'THREAD_IN_USE',message:'This paper chat is still held by another client. Other Desktop chats can continue normally.'};}else{this.phase='failed';this.error={code:e.code||'CONNECTION_FAILED',message:e.message};throw e;}}
  this.app.emit('change');return this.state();
 }
 async status(input){this.scope(input);if(this.phase==='waiting-desktop-release'&&Date.now()-this.lastAttempt>=2000)return this.activate(input);return this.state();}
 async release(input){
  this.scope(input);const r=this.reference();if(!r||r.threadId!==input.threadId)fail('THREAD_MISMATCH','Release only this paper chat.');if(busy(this.app))fail('CHAT_BUSY','Wait for this paper turn to finish before releasing.');
  const chat=this.app.chat,s=chat?.getState?.();if(s?.mode!=='bound-existing-chat'||(s.threadId||s.boundThreadId)!==r.threadId)fail('THREAD_MISMATCH','This process does not own the selected paper chat.');await chat.close();this.phase='released';this.error=null;this.app.emit('change');return this.state();
 }
}
