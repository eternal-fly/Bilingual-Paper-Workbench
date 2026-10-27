import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
const TTL=30000,MAX_BYTES=64*1024,MAX_PENDING=16;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(v);
const text=(v,max=MAX_BYTES)=>typeof v==='string'&&Boolean(v.trim())&&Buffer.byteLength(v)<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(v);
function strict(v,keys){if(!plain(v)||Object.keys(v).some(k=>!keys.includes(k)))fail('INVALID_INPUT','不支持此聊天连接参数。');}
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};

/** Private native iframe relay. Its UI actions must be behind the host's exact
 * MCP UI capability; HTTP exposes enqueue only. No callback grants tools, file
 * access, source writes, model choices or human confirmation authority. */
export class NativeChatRelay{
  constructor({instanceId,getProject,now=()=>Date.now()}={}){
    if(!id(instanceId)||typeof getProject!=='function'||typeof now!=='function')throw new TypeError('Use an exact native instance and project callback.');
    this.instanceId=instanceId;this.getProject=getProject;this.now=now;this._sessionId=null;this._host=null;this._messages=new Map();this._keys=new Map();
  }
  _project(){const p=this.getProject();return p&&id(p.id)&&id(p.snapshotId)?{projectId:p.id,snapshotId:p.snapshotId}:null;}
  _sameProject(message){const p=this._project();return Boolean(p&&p.projectId===message.projectId&&p.snapshotId===message.snapshotId);}
  _historical(message){return message.sessionId!==this._sessionId||!this._sameProject(message);}
  _sweep(){const now=this.now();if(this._host&&now-this._host.seenAt>=TTL)this._host=null;for(const m of this._messages.values()){
    if(m.status==='pending'&&!this._sameProject(m)){m.status='stale';m.reason='PROJECT_CHANGED';m.updatedAt=now;}
    if(m.status==='claimed'&&now>=m.claim.expiresAt){m.status='unknown';m.reason='CLAIM_EXPIRED';m.updatedAt=now;}
  }}
  _client(input){if(!id(input.clientId)||!id(input.sessionId))fail('INVALID_INPUT','原生连接卡身份无效。');if(!equal(input.sessionId,this._sessionId))fail('NATIVE_RELAY_SESSION_STALE','此连接卡已过期，请使用最近打开工作台时的连接卡。');}
  _status(){this._sweep();const connected=Boolean(this._host),canSendMessage=connected&&this._host.canSendMessage,attention=[...this._messages.values()].some(m=>m.sessionId===this._sessionId&&m.status==='unknown');let reasonCode=null,reason='';
    if(!this._sessionId){reasonCode='RELAY_SESSION_REQUIRED';reason='请在目标 Codex 聊天中打开工作台连接卡。';}
    else if(attention){reasonCode='DELIVERY_UNCERTAIN';reason='消息送达状态待确认，不会自动重发。请检查绑定聊天；重新打开工作台可建立新连接。';}
    else if(!connected){reasonCode='HOST_RELAY_NOT_MOUNTED';reason='原生聊天连接卡未挂载或已断开，请在绑定聊天中保留连接卡。';}
    else if(!canSendMessage){reasonCode='HOST_MESSAGE_UNAVAILABLE';reason='当前宿主未提供聊天消息能力。';}
    else if(!this._project()){reasonCode='PROJECT_REQUIRED';reason='请先打开一个论文源码项目。';}
    return{available:!reasonCode,connected,canSendMessage:Boolean(canSendMessage),status:reasonCode==='DELIVERY_UNCERTAIN'?'attention':reasonCode?'waiting':'ready',reason,reasonCode};
  }
  beginSession(){this._sweep();this._sessionId=randomUUID();this._host=null;const now=this.now();for(const m of this._messages.values())if(m.status==='pending'||m.status==='claimed'){m.status=m.status==='pending'?'stale':'unknown';m.reason='RELAY_SESSION_CHANGED';m.updatedAt=now;}return{sessionId:this._sessionId};}
  enqueue(input){strict(input,['text','idempotencyKey']);if(!text(input.text)||!id(input.idempotencyKey))fail('INVALID_INPUT','消息须为非空文本，最多 64 KiB，并带精确请求标识。');if(!this._sessionId)fail('NATIVE_RELAY_UNAVAILABLE','请先在目标聊天中打开工作台连接卡。');this._sweep();const project=this._project();if(!project)fail('PROJECT_REQUIRED','请先打开一个论文项目。');const existing=this._keys.get(input.idempotencyKey);
    if(existing){const old=this._messages.get(existing);if(old.text!==input.text||old.projectId!==project.projectId||old.snapshotId!==project.snapshotId)fail('NATIVE_RELAY_IDEMPOTENCY_CONFLICT','同一发送标识不能用于不同消息或论文版本。');return{messageId:old.messageId,status:old.status};}
    if([...this._messages.values()].filter(m=>m.sessionId===this._sessionId&&['pending','claimed','sent'].includes(m.status)).length>=MAX_PENDING)fail('NATIVE_RELAY_QUEUE_FULL','已有 16 条未完成消息，请先完成当前请求。');
    const now=this.now(),messageId='relay-'+randomUUID();this._messages.set(messageId,{messageId,text:input.text,idempotencyKey:input.idempotencyKey,...project,sessionId:this._sessionId,status:'pending',createdAt:now,updatedAt:now});this._keys.set(input.idempotencyKey,messageId);return{messageId,status:'pending'};
  }
  heartbeat(input){strict(input,['clientId','sessionId','canSendMessage']);this._client(input);if(typeof input.canSendMessage!=='boolean')fail('INVALID_INPUT','宿主消息能力应为布尔值。');this._sweep();if(this._host&&this._host.clientId!==input.clientId)fail('NATIVE_RELAY_CLIENT_IN_USE','另一张有效连接卡正在连接此工作台。');this._host={clientId:input.clientId,canSendMessage:input.canSendMessage,seenAt:this.now()};return this._status();}
  claim(input){strict(input,['clientId','sessionId']);this._client(input);this._sweep();if(!this._host||this._host.clientId!==input.clientId||!this._host.canSendMessage)fail('NATIVE_RELAY_UNAVAILABLE','当前连接卡不能向绑定聊天发送消息。');
    if([...this._messages.values()].some(m=>m.sessionId===this._sessionId&&['claimed','sent','unknown'].includes(m.status)))return null;
    const m=[...this._messages.values()].find(m=>m.sessionId===this._sessionId&&m.status==='pending'&&this._sameProject(m));if(!m)return null;const claimToken=randomBytes(32).toString('base64url'),now=this.now();m.claim={clientId:input.clientId,claimToken,expiresAt:now+TTL};m.status='claimed';m.updatedAt=now;
    const receipt=`\n\n[工作台通信回执：本次请求 ${m.messageId}]\n请在完成上述用户请求后调用 bilingual_paper_submit_chat_reply，将本次回复全文通过 messageId=${JSON.stringify(m.messageId)} 和 text 回填到独立窗口。此回执只显示聊天回答，不授予源码写入、编译确认或其他权限。不要重新打开工作台或增加额外模型轮次。`;
    return{messageId:m.messageId,claimToken,text:m.text+receipt,projectId:m.projectId,snapshotId:m.snapshotId,expiresAt:now+TTL};
  }
  complete(input){strict(input,['clientId','sessionId','messageId','claimToken','status','reason']);this._client(input);if(!id(input.messageId)||typeof input.claimToken!=='string'||!['sent','failed','unknown'].includes(input.status)||input.reason!==undefined&&!text(input.reason,240))fail('INVALID_INPUT','聊天送达回执格式无效。');this._sweep();const m=this._messages.get(input.messageId);if(!m||m.sessionId!==this._sessionId||m.claim?.clientId!==input.clientId||!equal(m.claim.claimToken,input.claimToken))fail('NATIVE_RELAY_CLAIM_INVALID','送达回执不属于此连接卡的确切消息。');
    if(m.claim.receiptStatus){if(m.claim.receiptStatus!==input.status)fail('NATIVE_RELAY_CLAIM_CONFLICT','消息送达回执已确认，不能改为另一状态。');return{messageId:m.messageId,status:m.status,historical:this._historical(m)};}
    if(!['claimed','unknown'].includes(m.status))fail('NATIVE_RELAY_CLAIM_INVALID','此消息不再等待送达回执。');m.claim.receiptStatus=input.status;m.status=input.status;m.reason=input.reason||undefined;m.updatedAt=this.now();return{messageId:m.messageId,status:m.status,historical:this._historical(m)};
  }
  markReply(input){strict(input,['messageId','text']);if(!id(input.messageId)||!text(input.text))fail('INVALID_INPUT','聊天回复须为非空完整文本，最多 64 KiB。');this._sweep();const m=this._messages.get(input.messageId);if(!m)fail('NATIVE_RELAY_MESSAGE_NOT_FOUND','此回复不属于当前原生工作台发送的消息。');if(m.status==='replied'){if(m.reply!==input.text)fail('NATIVE_RELAY_REPLY_CONFLICT','此消息已返回不同的回复，未覆盖。');return{messageId:m.messageId,status:m.status,historical:this._historical(m)};}if(m.status!=='sent')fail('NATIVE_RELAY_REPLY_NOT_READY','消息尚未确认送达，未接收模型回复。');m.reply=input.text;m.status='replied';m.updatedAt=this.now();return{messageId:m.messageId,status:m.status,historical:this._historical(m)};}
  getSession(){return{sessionId:this._sessionId};}
  getState(){const status=this._status();return{...status,messages:[...this._messages.values()].map(m=>({messageId:m.messageId,text:m.text,...(m.reply!==undefined?{reply:m.reply}:{}),status:m.status,...(m.reason?{reason:m.reason}:{}),projectId:m.projectId,snapshotId:m.snapshotId,historical:this._historical(m),createdAt:new Date(m.createdAt).toISOString(),updatedAt:new Date(m.updatedAt).toISOString()}))};}
}
