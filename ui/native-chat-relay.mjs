const codeOf=error=>typeof error?.code==='string'?error.code:'NATIVE_RELAY_UNAVAILABLE';
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);

/** Reuse in either the compact native card or the existing embedded workbench.
 * app must already be connected. Tokens stay in closures/private MCP metadata;
 * only the host SDK can dispatch messages. There is no clipboard/worker path. */
export function mountNativeRelay({app,getUiToken,getRelaySession,onStatus=()=>{},clientId=globalThis.crypto?.randomUUID?.(),intervalMs=1500,autoStart=true,setTimer=setTimeout,clearTimer=clearTimeout}={}){
  if(!app||typeof app.callServerTool!=='function'||typeof app.sendMessage!=='function'||typeof getUiToken!=='function'||typeof getRelaySession!=='function'||!safeId(clientId)||!Number.isSafeInteger(intervalMs)||intervalMs<500||intervalMs>10000)throw new TypeError('A connected native App and private relay metadata are required.');
  let stopped=false,timer=null,ticking=false,delivery=null,offline=false;const attempted=new Set();
  const notify=(status,text,code)=>{try{onStatus({status,text,...(code?{code}:{})});}catch{}};
  const schedule=()=>{if(stopped||!autoStart)return;clearTimer(timer);timer=setTimer(()=>{void tick();},intervalMs);};
  async function context(){const uiToken=await getUiToken(),sessionId=await getRelaySession();if(typeof uiToken!=='string'||!uiToken.length||uiToken.length>128||!safeId(sessionId))throw Object.assign(Error('Private relay metadata is unavailable'),{code:'UI_METADATA_MISSING'});return{uiToken,sessionId};}
  async function call(action,payload,ctx){const result=await app.callServerTool({name:'bilingual_paper_ui',arguments:{action,payload,uiToken:ctx.uiToken}},{timeout:10000});if(result?.isError){const code=result._meta?.paperError?.code||result.structuredContent?.error?.code||'NATIVE_RELAY_UNAVAILABLE';throw Object.assign(Error('Native relay operation was rejected'),{code});}return result?._meta&&Object.hasOwn(result._meta,'paperResult')?result._meta.paperResult:result?.structuredContent;}
  async function deliver(claim,ctx){
    let status='unknown',reason='HOST_SEND_UNCERTAIN';
    try{
      if(stopped||await getRelaySession()!==ctx.sessionId){status='failed';reason='HOST_RELAY_CHANGED_BEFORE_SEND';}
      else{notify('sending','正在发送到绑定的 Codex 聊天…');const result=await app.sendMessage({role:'user',content:[{type:'text',text:claim.text}]});if(result&&typeof result==='object'){status=result.isError?'failed':'sent';reason=result.isError?'HOST_SEND_REJECTED':undefined;}}
    }catch{/* Delivery may already have happened; never retry an uncertain send. */}
    try{await call('nativeRelayComplete',{clientId,sessionId:ctx.sessionId,messageId:claim.messageId,claimToken:claim.claimToken,status,...(reason?{reason}:{})},ctx);notify(status,status==='sent'?'已送达绑定的 Codex 聊天。':status==='failed'?'宿主未接受此消息，原文已保留。':'送达状态待确认，消息不会自动重发。',reason);}
    catch(error){const code=codeOf(error);notify(code==='NATIVE_RELAY_SESSION_STALE'?'stale':'unknown','消息回执尚未确认，不会自动重发。',code);}
  }
  async function tick(){if(stopped||ticking)return false;ticking=true;
    try{
      if(offline){notify('unavailable','连接暂时离线，消息尚未发送。');return false;}
      const ctx=await context(),canSendMessage=Boolean(app.getHostCapabilities?.()?.message);
      const heartbeat=await call('nativeRelayHeartbeat',{clientId,sessionId:ctx.sessionId,canSendMessage},ctx);
      if(!canSendMessage||!heartbeat?.available){notify(heartbeat?.status||'waiting',heartbeat?.reason||'当前宿主未提供消息能力。',heartbeat?.reasonCode);return false;}
      if(delivery)return true;
      const claim=await call('nativeRelayClaim',{clientId,sessionId:ctx.sessionId},ctx);
      if(!claim){notify('ready','独立窗口已连接当前 Codex 聊天。');return true;}
      if(!safeId(claim.messageId)||typeof claim.claimToken!=='string'||claim.claimToken.length<20||claim.claimToken.length>128||typeof claim.text!=='string'||new TextEncoder().encode(claim.text).byteLength>66*1024)throw Object.assign(Error('Malformed relay claim'),{code:'NATIVE_RELAY_CLAIM_INVALID'});
      if(attempted.has(claim.messageId)){await call('nativeRelayComplete',{clientId,sessionId:ctx.sessionId,messageId:claim.messageId,claimToken:claim.claimToken,status:'unknown',reason:'DUPLICATE_CLAIM_NOT_RESENT'},ctx);notify('unknown','此消息已经尝试发送，不会自动重发。');return false;}
      attempted.add(claim.messageId);delivery=deliver(claim,ctx).finally(()=>{delivery=null;});return true;
    }catch(error){const code=codeOf(error);if(['NATIVE_RELAY_SESSION_STALE','UI_AUTHORIZATION_REQUIRED'].includes(code)){stop();notify('stale','此连接卡已过期，请保留最近打开工作台时的连接卡。',code);}else notify('waiting',code==='NATIVE_RELAY_CLIENT_IN_USE'?'当前已有另一张有效连接卡。':'正在等待原生聊天连接。',code);return false;}
    finally{ticking=false;schedule();}
  }
  const onOffline=()=>{offline=true;notify('unavailable','连接暂时离线，消息尚未发送。');},onOnline=()=>{offline=false;void tick();};
  function stop(){stopped=true;clearTimer(timer);globalThis.removeEventListener?.('offline',onOffline);globalThis.removeEventListener?.('online',onOnline);globalThis.removeEventListener?.('pagehide',stop);}
  globalThis.addEventListener?.('offline',onOffline);globalThis.addEventListener?.('online',onOnline);globalThis.addEventListener?.('pagehide',stop);
  if(autoStart)void tick();return{stop,tick,flush:async()=>{await delivery;}};
}

export async function startNativeRelayCard({document:doc=globalThis.document,appFactory}={}){
  const status=doc?.getElementById('native-relay-status'),root=doc?.getElementById('native-relay-root');if(!status||!root)return null;
  let uiToken,sessionId,relay,resolveMetadata,bootstrapAttempted=false;const metadataReady=new Promise(resolve=>{resolveMetadata=resolve;});
  const adopt=result=>{if(result?.isError)throw Object.assign(Error('Native relay bootstrap failed'),{code:result._meta?.paperError?.code||'NATIVE_RELAY_UNAVAILABLE'});const m=result?._meta;if(typeof m?.paperUiToken==='string'&&m.paperUiToken.length&&m.paperUiToken.length<=128)uiToken=m.paperUiToken;if(safeId(m?.paperRelaySession))sessionId=m.paperRelaySession;if(uiToken&&sessionId)resolveMetadata();};
  try{const app=appFactory?appFactory():new(await import('@modelcontextprotocol/ext-apps/app-with-deps')).App({name:'bilingual-paper-native-relay',version:'1'});app.ontoolresult=result=>{try{adopt(result);}catch{status.textContent='原生连接卡初始化失败，请重新打开工作台。';}};await app.connect();
    await Promise.race([metadataReady,new Promise(resolve=>setTimeout(resolve,100))]);if(!uiToken||!sessionId){bootstrapAttempted=true;const result=await app.callServerTool({name:'bilingual_paper_relay',arguments:{}},{timeout:10000});adopt(result);}
    if(!uiToken||!sessionId)throw Object.assign(Error('Private relay metadata missing'),{code:'UI_METADATA_MISSING'});
    relay=mountNativeRelay({app,getUiToken:()=>uiToken,getRelaySession:()=>sessionId,onStatus:value=>{root.dataset.state=value.status;status.textContent=value.text;}});return{app,relay,bootstrapAttempted};
  }catch{root.dataset.state='unavailable';status.textContent='连接卡尚未接通，请在目标聊天中重新打开工作台。';relay?.stop();return null;}
}
if(typeof window!=='undefined'&&globalThis.document?.getElementById('native-relay-root'))void startNativeRelayCard();
