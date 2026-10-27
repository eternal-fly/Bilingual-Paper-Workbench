const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const busy=app=>app._bindingPending||app.reviews?.starting||app.chat?.getState?.().busy||[...app.jobs.values()].some(job=>!job.finished);
export async function connectExistingChat(app,input){
 if(!plain(input)||Object.keys(input).some(k=>!['threadId','model','effort','expectedProjectId','expectedSnapshotId'].includes(k))||!id(input.threadId)||!id(input.model)||!id(input.expectedProjectId)||!id(input.expectedSnapshotId)||input.effort!==undefined&&input.effort!==null&&!id(input.effort))fail('INVALID_INPUT','Choose an exact existing chat, model and current project snapshot.');
 return app._projectOperation(async()=>{
  if(busy(app))fail('CHAT_BUSY','Finish the current paper operation before binding its chat.');
  if(typeof app.createBoundChat!=='function')fail('CAPABILITY_UNAVAILABLE','The installed runtime has no existing-chat transport.');
  const project=app.core.getState().project;if(project.id!==input.expectedProjectId||project.snapshotId!==input.expectedSnapshotId)fail('VERSION_CONFLICT','The selected paper changed before the chat binding.');
  await app.core._assertSourceCurrent();app._bindingPending=true;const previous=app.chat;let next,same=false,attached=false;
  try{
   same=previous?.getState?.().mode==='bound-existing-chat'&&previous.getState().threadId===input.threadId;
   next=same?previous:await app.createBoundChat(input.threadId,{model:input.model,effort:input.effort});await next.connect();await next.bindPaper?.({projectId:project.id});
   const result=await next.resumeChat({threadId:input.threadId,model:input.model,...(input.effort?{effort:input.effort}:{})});
   if(result?.threadId!==input.threadId||next.getState()?.threadId!==input.threadId||next.getState()?.mode!=='bound-existing-chat')fail('THREAD_MISMATCH','The connection did not return the exact selected existing chat.');
   await app._flowAction(async()=>{await app.core._assertSourceCurrent();const current=app.core.getState().project;if(current.id!==project.id||current.snapshotId!==project.snapshotId)fail('VERSION_CONFLICT','The selected paper changed during chat binding.');app.flow.nativeChatBinding={kind:'bound-existing-chat',projectId:project.id,threadId:input.threadId,title:String(result.threadName||'').slice(0,160),model:result.model,effort:result.effort||null,verifiedAt:new Date().toISOString()};});
   if(!same){await previous?.close?.();app.attachChat(next);}attached=true;app._nativeBindingError=null;app.emit('change');return next.getState();
  }finally{if(next&&!same&&!attached)await next.close().catch(()=>{});app._bindingPending=false;}
 });
}
export async function restoreExistingChat(app){
 const record=app.flow?.nativeChatBinding||app.flow?.backgroundChatReference;if(!record)return;
 if(!plain(record)||!['bound-existing-chat','background-chat-reference'].includes(record.kind)||record.projectId!==app.core.getState().project?.id||!id(record.threadId)||!id(record.model)||typeof app.createBoundChat!=='function')fail('CHAT_BINDING_RECOVERY_REQUIRED','The saved paper chat binding needs explicit recovery.');
 if(app.chat?.getState?.().mode==='bound-existing-chat'&&app.chat.getState().threadId===record.threadId)return;
 const next=await app.createBoundChat(record.threadId,{model:record.model,effort:record.effort}),state=next.getState();if(state?.mode!=='bound-existing-chat'||(state.boundThreadId||state.threadId)!==record.threadId)fail('THREAD_MISMATCH','The saved paper chat did not restore its exact identity.');await app.chat?.close?.();app.attachChat(next);
}
export function verifiedExistingChat(service){const state=service.getState?.(),record=state?.nativeChatBinding,chat=service.chat?.getState?.();return record?.kind==='bound-existing-chat'&&record.projectId===state?.project?.id&&id(record.threadId)&&chat?.mode==='bound-existing-chat'&&(chat.boundThreadId||chat.threadId)===record.threadId?record:null;}
