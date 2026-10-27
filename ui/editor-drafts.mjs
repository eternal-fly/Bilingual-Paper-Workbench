/** Read-only, ephemeral evidence of the live editor. This never saves a draft. */
function editorClientId(){
  if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
  // Some embedded/opaque origins omit randomUUID even though Web Crypto's
  // random bytes remain available. This identifier is not an auth credential.
  const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');return`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function initializeEditorDraftPublisher({api,getScope,collect,pollMs=800,maxWaitMs=250}) {
  const clientId=editorClientId();let sequence=0,timer=null,firstChange=0,polling=false,destroyed=false,scopeKey='';
  const captures=new Set(),key=scope=>scope?.enabled&&scope.projectId&&scope.snapshotId?JSON.stringify([scope.recordId,scope.projectId,scope.snapshotId]):'';
  function scope(){const value=getScope();return key(value)?value:null;}
  function adopt(){const next=key(getScope());if(next!==scopeKey){scopeKey=next;clearTimeout(timer);timer=null;firstChange=0;captures.clear();if(next)queueMicrotask(()=>void poll());}}
  async function publish(captureId=null){
    if(destroyed)return;const current=scope();if(!current)return;
    // Collection happens synchronously at the capture request, before any await.
    const drafts=collect(),payload={clientId,expectedProjectId:current.projectId,expectedSnapshotId:current.snapshotId,sequence:++sequence,captureId,drafts};
    try{await api('publishEditorDrafts',payload);}catch{/* Save failures and stale scopes never alter the author's editor. */}
  }
  function changed(){
    adopt();if(!scope()||destroyed)return;const now=performance.now();firstChange ||= now;clearTimeout(timer);
    timer=setTimeout(()=>{timer=null;firstChange=0;void publish();},Math.max(0,Math.min(120,maxWaitMs-(now-firstChange))));
  }
  async function poll(){
    adopt();const current=scope();if(!current||polling||destroyed)return;const captured=key(current);polling=true;
    try{
      const result=await api('pollEditorDraftCapture',{clientId,expectedProjectId:current.projectId,expectedSnapshotId:current.snapshotId});
      if(destroyed||key(getScope())!==captured||!result?.captureId||result.expectedProjectId!==current.projectId||result.expectedSnapshotId!==current.snapshotId||captures.has(result.captureId))return;
      captures.add(result.captureId);await publish(result.captureId);captures.delete(result.captureId);
    }catch{/* An unavailable capture endpoint is not a manuscript or save error. */}finally{polling=false;}
  }
  const interval=setInterval(()=>void poll(),pollMs);
  return{adopt,changed,destroy(){destroyed=true;clearTimeout(timer);clearInterval(interval);captures.clear();}};
}
