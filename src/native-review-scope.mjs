import {assertNativePaperScope} from './native-paper-tools.mjs';

const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value);

/** Delivery availability is separate from current-paper read/result authority.
 * The returned hook runs only inside the owning workflow's existing core lock. */
export async function reviewAuthorization(service,caller,instanceId,{locked=false}={}){
 if(!identifier(instanceId))fail('INVALID_INPUT','Use the exact native review instance.');
 if(caller==null)return{bindingId:instanceId,beforeAccess:async()=>{}};
 const initial=assertNativePaperScope(service,caller),app=initial.app,scope={expectedProjectId:initial.project.id,expectedSnapshotId:initial.project.snapshotId};
 const verify=async held=>{
  assertNativePaperScope(service,caller,scope,app);
  const desktop=service.desktopExecution;let bindingId=instanceId;
  if(desktop){
   if(desktop.scope?.app!==app||typeof desktop.refreshContext!=='function')fail('DESKTOP_EXECUTION_STALE','The current paper has no matching verified Desktop context.');
   await desktop.refreshContext(app,caller,{locked:held});
   const state=desktop.state();
   if(state.mode!=='desktop-queue'||state.threadId!==caller)fail('THREAD_MISMATCH','Only the current bound paper chat may process its review.');
   bindingId=`desktop:${caller}`;
  }else{
   if(typeof app.refreshDesktopContext!=='function')fail('CAPABILITY_UNAVAILABLE','Current durable paper review authorization is unavailable.');
   await app.refreshDesktopContext({...scope,threadId:caller},{locked:held,assertCurrent:()=>assertNativePaperScope(service,caller,scope,app)});
  }
  assertNativePaperScope(service,caller,scope,app);return bindingId;
 };
 const bindingId=await verify(locked);
 return{bindingId,beforeAccess:async()=>{if(await verify(true)!==bindingId)fail('THREAD_MISMATCH','The current paper review binding changed.');}};
}
