import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,readFile,realpath,lstat,unlink} from 'node:fs/promises';
import path from 'node:path';
import {CodexBridge} from './codex-bridge.mjs';
import {StringDecoder} from 'node:string_decoder';

const failure=(code,message)=>Object.assign(new Error(message),{code});
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const head=turn=>turn?`${turn.id}:${turn.status}`:'empty';
const deadPid=pid=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}};
const turnMetadata=turn=>turn?Object.fromEntries(['id','status','startedAt','completedAt'].filter(key=>turn[key]!==undefined).map(key=>[key,turn[key]])):null;
const validTurn=turn=>turn&&typeof turn==='object'&&!Array.isArray(turn)&&validId(turn.id)&&['completed','interrupted','failed','inProgress'].includes(turn.status)&&Array.isArray(turn.items);
const validSelection=value=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/u.test(value);
const historyNotice='\n[…历史显示已省略；原聊天保留全文。]';
const clipHistory=(text,budget)=>{if(Buffer.byteLength(text)<=budget)return{text,truncated:false};const available=budget-Buffer.byteLength(historyNotice);if(available<1)return null;return{text:new StringDecoder('utf8').write(Buffer.from(text).subarray(0,available))+historyNotice,truncated:true};};

/** Continue one explicitly bound persisted Codex conversation. This owns its
 * stdio client, not the Desktop connection. Persisted-history idle checks cannot
 * make a Desktop client's later turn atomic; callers must not claim otherwise.
 * Existing dynamic tools are retained by Codex; resume never replaces them. */
export class NativeBoundChat extends CodexBridge{
  constructor({threadId,leaseRoot,bindingSelection=null,...options}={}){
    if(!validId(threadId))throw new TypeError('An exact existing thread ID is required.');
    if(typeof leaseRoot!=='string'||!path.isAbsolute(leaseRoot))throw new TypeError('An absolute shared lease root is required.');
    if(options.transportMode&&options.transportMode!=='spawn')throw new TypeError('A bound chat uses its own documented stdio client.');
    if(bindingSelection!==null&&(!bindingSelection||typeof bindingSelection!=='object'||!validSelection(bindingSelection.model)||bindingSelection.effort!=null&&!validSelection(bindingSelection.effort)))throw new TypeError('The persisted binding requires a model and an optional reasoning effort.');
    super({...options,transportMode:'spawn'});
    this.boundThreadId=threadId;this.leaseRoot=path.resolve(leaseRoot);this.bindingSelection=bindingSelection?{model:bindingSelection.model,effort:bindingSelection.effort}:null;this._nativeLease=null;this._loadedHead=undefined;this._ownedTurnIds=new Set();this._connecting=null;this._historyRequestId=null;this._discardingHistory=false;this._nativeThreadOwned=false;this._settingsWaiter=null;this._settingsRevision=0;this._settingsUncertain=false;
    this._state.mode='bound-existing-chat';
    this._restoreBindingSelection();
  }
  getState(){return{...super.getState(),mode:'bound-existing-chat',boundThreadId:this.boundThreadId,desktopControlVerified:false,nativeTransport:'persisted-thread-app-server'};}
  _restoreBindingSelection(){if(!this.bindingSelection)return;if(!this._state.model)this._state.model=this.bindingSelection.model;if(!this._state.effort&&this._state.model===this.bindingSelection.model)this._state.effort=this.bindingSelection.effort||null;}
  async _checkedLeaseRoot(){
    const real=await realpath(this.leaseRoot),info=await lstat(this.leaseRoot);
    if(info.isSymbolicLink()||!info.isDirectory()||!samePath(real,this.leaseRoot))throw failure('NATIVE_CHAT_LEASE_RECOVERY_REQUIRED','绑定聊天的共享租约目录身份不一致，未连接。');return real;
  }
  async _leaseSnapshot(filename,{native=false}={}){
    let handle;
    try{
      const stat=await lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<2||stat.size>4096)throw Error('Invalid lease');
      handle=await open(filename,'r');const opened=await handle.stat();if(opened.dev!==stat.dev||opened.ino!==stat.ino||opened.size!==stat.size)throw Error('Lease changed');
      const raw=await handle.readFile('utf8');if(Buffer.byteLength(raw)>4096)throw Error('Oversized lease');const value=JSON.parse(raw);
      if(!validId(value.owner)||!Number.isSafeInteger(value.pid)||value.pid<1||native&&(value.schemaVersion!==1||value.threadId!==this.boundThreadId||value.dataRoot!==undefined&&(typeof value.dataRoot!=='string'||!path.isAbsolute(value.dataRoot))))throw Error('Invalid lease identity');
      return{filename,raw,value,stat:{dev:stat.dev,ino:stat.ino,size:stat.size,mtimeMs:stat.mtimeMs}};
    }catch(error){if(error.code==='ENOENT')return null;throw failure('NATIVE_CHAT_LEASE_RECOVERY_REQUIRED','绑定聊天的租约无法安全核实；未删除已有记录。');}
    finally{await handle?.close();}
  }
  async _sameDeadLease(snapshot,{native=false}={}){
    const current=await this._leaseSnapshot(snapshot.filename,{native});
    if(!current||current.raw!==snapshot.raw||Object.keys(snapshot.stat).some(key=>current.stat[key]!==snapshot.stat[key])||!deadPid(current.value.pid))throw failure('NATIVE_CHAT_LEASE_RECOVERY_REQUIRED','租约已变化或所属进程尚未退出；未删除已有记录。');
  }
  /** An explicit crash-recovery action. Never steal a live PID or guess which
   * local lock belongs to this native lease. Unknown PID errors are live. */
  async recoverStaleLease(){
    if(this._nativeLease||this._lock||this._state.connected||this._state.busy)throw failure('NATIVE_CHAT_IN_USE','请先关闭此工作台拥有的连接，再恢复遗留租约。');
    let real;try{real=await this._checkedLeaseRoot();}catch(error){if(error.code==='ENOENT')return{recovered:false,threadId:this.boundThreadId,localLockRecovered:false};throw error;}
    const filename=path.join(real,createHash('sha256').update(this.boundThreadId).digest('hex')+'.json'),native=await this._leaseSnapshot(filename,{native:true});
    if(!native)return{recovered:false,threadId:this.boundThreadId,localLockRecovered:false};
    if(!deadPid(native.value.pid))throw failure('NATIVE_CHAT_IN_USE','此聊天租约所属进程仍在运行；未删除或抢占。');
    const localFilename=path.join(path.resolve(this.dataRoot),'.codex-chat.lock');let local;
    try{
      const realDataRoot=await realpath(this.dataRoot),info=await lstat(this.dataRoot);
      if(info.isSymbolicLink()||!info.isDirectory()||!samePath(realDataRoot,path.resolve(this.dataRoot)))throw failure('NATIVE_CHAT_LEASE_RECOVERY_REQUIRED','聊天数据目录身份不一致，未恢复。');
      local=await this._leaseSnapshot(localFilename);
    }catch(error){if(error.code!=='ENOENT')throw error;}
    if(local&&(local.value.pid!==native.value.pid||!deadPid(local.value.pid)))throw failure('NATIVE_CHAT_LEASE_RECOVERY_REQUIRED','本地锁不属于同一个已退出进程，未恢复。');
    if(local&&(!native.value.dataRoot||!samePath(native.value.dataRoot,path.resolve(this.dataRoot)))){
      // Older native leases lack the state-directory identity. In that case a
      // saved exact thread binding is required before recovering its local lock.
      try{const filename=path.join(this.dataRoot,'chat-state.json'),stat=await lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024*1024)throw Error('Invalid state');const saved=JSON.parse(await readFile(filename,'utf8'));if(saved.schemaVersion!==1||saved.threadId!==this.boundThreadId||!Array.isArray(saved.messages))throw Error('Foreign state');}
      catch{throw failure('NATIVE_CHAT_LEASE_RECOVERY_REQUIRED','无法证明本地遗留锁属于此绑定聊天，未恢复。');}
    }
    await this._checkedLeaseRoot();await this._sameDeadLease(native,{native:true});
    if(local){await this._sameDeadLease(local);await unlink(local.filename);}
    await this._sameDeadLease(native,{native:true});await unlink(native.filename);
    return{recovered:true,threadId:this.boundThreadId,localLockRecovered:!!local};
  }
  async _acquireNativeLease(){
    await mkdir(this.leaseRoot,{recursive:true,mode:0o700});
    const real=await this._checkedLeaseRoot();
    const filename=path.join(real,createHash('sha256').update(this.boundThreadId).digest('hex')+'.json'),owner=randomUUID();let handle;
    try{handle=await open(filename,'wx',0o600);}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      let existing;try{const stat=await lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw Error('Invalid lease');existing=JSON.parse(await readFile(filename,'utf8'));if(existing.schemaVersion!==1||existing.threadId!==this.boundThreadId||!validId(existing.owner)||!Number.isSafeInteger(existing.pid)||existing.pid<1)throw Error('Invalid lease');}
      catch{throw failure('NATIVE_CHAT_LEASE_RECOVERY_REQUIRED','绑定聊天的租约需要明确恢复；未删除或抢占已有记录。');}
      let alive=true;try{process.kill(existing.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;}
      throw failure(alive?'NATIVE_CHAT_IN_USE':'NATIVE_CHAT_LEASE_RECOVERY_REQUIRED',alive?'另一个工作台正在使用此绑定聊天，请先关闭该连接。':'此绑定聊天有遗留租约，需要明确恢复；未自动抢占。');
    }
    try{await handle.writeFile(JSON.stringify({schemaVersion:1,threadId:this.boundThreadId,dataRoot:path.resolve(this.dataRoot),pid:process.pid,owner,createdAt:new Date().toISOString()}));await handle.sync();this._nativeLease={filename,owner,pid:process.pid,handle};}
    catch(error){await handle.close();throw error;}
  }
  async _releaseNativeLease(){
    const lease=this._nativeLease;this._nativeLease=null;if(!lease)return;
    await lease.handle.close();
    try{if(!samePath(await realpath(this.leaseRoot),path.dirname(lease.filename)))return;const stat=await lstat(lease.filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)return;const current=JSON.parse(await readFile(lease.filename,'utf8'));if(current.schemaVersion===1&&current.owner===lease.owner&&current.pid===lease.pid&&current.threadId===this.boundThreadId)await unlink(lease.filename);}
    catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  }
  async connect(){
    if(this._connecting)return this._connecting;
    this._connecting=this._connectBound();try{return await this._connecting;}finally{this._connecting=null;}
  }
  async _connectBound(){
    if(this._state.connected){if(this._state.threadId!==this.boundThreadId)throw failure('NATIVE_CHAT_MISMATCH','当前连接不是明确绑定的聊天。');return this.getState();}
    if(this._lock||this._nativeLease)await this.close();
    await this._acquireNativeLease();
    try{
      await super.connect();if(this._state.threadId&&this._state.threadId!==this.boundThreadId)throw failure('NATIVE_CHAT_MISMATCH','已有本地聊天状态属于另一任务，未覆盖。');this._state.threadId=this.boundThreadId;this._state.mode='bound-existing-chat';this._restoreBindingSelection();
      const metadata=await this._readIdentity();this._state.threadName=metadata.name||this._state.threadName;
      try{await this.loadHistory();}catch(error){this._state.nativeHistory={...this._state.nativeHistory,available:false,historyUnavailable:true,truncated:true,errorCode:error.code||'NATIVE_CHAT_HISTORY_UNAVAILABLE'};}
      await this._persist();this._changed();return this.getState();
    }
    catch(error){await this.close();throw error;}
  }
  async _readIdentity(){
    const result=await super._request('thread/read',{threadId:this.boundThreadId,includeTurns:false});
    if(result?.thread?.id!==this.boundThreadId)throw failure('NATIVE_CHAT_MISMATCH','Codex 返回的聊天身份与绑定任务不一致。');return result.thread;
  }
  _discardableHistoryPrefix(prefix){
    // Only one pending read-only history response may use this exception. The
    // response ID must precede result and match before any bytes are discarded.
    if(this._historyRequestId===null||this._pending.size!==1||!this._pending.has(this._historyRequestId))return false;
    const match=/^\s*\{\s*(?:"jsonrpc"\s*:\s*"2\.0"\s*,\s*)?"id"\s*:\s*(\d+)\s*,\s*"result"\s*:/u.exec(prefix);return!!match&&Number(match[1])===this._historyRequestId;
  }
  _read(data){
    if(this._historyRequestId===null&&!this._discardingHistory)return super._read(data);
    // JSONL delimiters are single UTF-8 bytes. Split before decoding so an
    // oversized display-history line can be drained with constant memory while
    // preserving the following response and the shared parser's normal limit.
    let offset=0;
    while(offset<data.length){
      const newline=data.indexOf(10,offset),end=newline<0?data.length:newline+1,chunk=data.subarray(offset,end);offset=end;
      if(this._discardingHistory){if(newline>=0){this._discardingHistory=false;this._decoder=new StringDecoder('utf8');this._buffer='';}continue;}
      if(Buffer.byteLength(this._buffer)+chunk.length>4*1024*1024-4){
        const prefix=(this._buffer+chunk.subarray(0,512).toString('utf8')).slice(0,512);
        if(this._discardableHistoryPrefix(prefix)){
          const pending=this._pending.get(this._historyRequestId);clearTimeout(pending.timer);this._pending.delete(this._historyRequestId);this._buffer='';this._decoder=new StringDecoder('utf8');this._discardingHistory=newline<0;
          pending.reject(failure('NATIVE_CHAT_HISTORY_TOO_LARGE','旧回合超过历史显示上限，已跳过显示；原聊天保留全文，连接仍可使用。'));continue;
        }
      }
      super._read(chunk);
    }
  }
  async _readHistoryPage(params){
    if(this._historyRequestId!==null||this._discardingHistory)throw failure('NATIVE_CHAT_HISTORY_UNAVAILABLE','近期历史仍在读取，请稍后刷新。');
    const requestId=this._id+1;this._historyRequestId=requestId;
    try{return await super._request('thread/turns/list',params);}finally{if(this._historyRequestId===requestId)this._historyRequestId=null;}
  }
  /** Display-only recent history. Codex retains the full server-side history;
   * this never hydrates rollout files or starts/resumes a writer. */
  async loadHistory({limit=6,maxPages=2,maxBytes=256*1024}={}){
    if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(maxPages)||maxPages<1||maxPages>5||!Number.isInteger(maxBytes)||maxBytes<4096||maxBytes>1024*1024)throw failure('INVALID_INPUT','历史显示范围无效。');
    if(!this._state.connected)await this.connect();if(this._state.busy)throw failure('CHAT_BUSY','请在当前回复完成后刷新历史。');
    let cursor=null,pages=0,sourceBytes=0,hasMore=false;const turns=[],seenTurns=new Set(),seenCursors=new Set();
    do{
      const pageSize=Math.min(3,limit-turns.length),page=await this._readHistoryPage({threadId:this.boundThreadId,limit:pageSize,sortDirection:'desc',itemsView:'full',...(cursor?{cursor}:{})});
      if(!Array.isArray(page?.data)||page.data.length>pageSize)throw failure('NATIVE_CHAT_HISTORY_INVALID','近期聊天历史分页格式无法核实。');
      sourceBytes+=Buffer.byteLength(JSON.stringify(page));
      for(const turn of page.data){if(!validTurn(turn)||turn.items.length>1000||turn.itemsView&&turn.itemsView!=='full'||seenTurns.has(turn.id))throw failure('NATIVE_CHAT_HISTORY_INVALID','近期聊天历史回合格式无法核实。');seenTurns.add(turn.id);turns.push(turn);}
      cursor=page.nextCursor??null;if(cursor!==null&&(typeof cursor!=='string'||!cursor||cursor.length>4096||seenCursors.has(cursor)))throw failure('NATIVE_CHAT_HISTORY_INVALID','近期聊天历史分页游标无法核实。');if(cursor)seenCursors.add(cursor);pages++;hasMore=!!cursor;
    }while(cursor&&pages<maxPages&&turns.length<limit);
    const imported=[],itemIds=new Set();let bytes=0,textTruncated=false,omittedMessageCount=0,loadedMessageCount=0;
    // Allocate display space to the newest visible messages first. Tool output
    // is never copied into the window or consumed by this display budget.
    for(const turn of turns)for(const item of [...turn.items].reverse()){
      if(!item||typeof item!=='object'||!['userMessage','agentMessage'].includes(item.type))continue;
      if(!validId(item.id)||itemIds.has(item.id)||item.type==='agentMessage'&&typeof item.text!=='string'||item.type==='userMessage'&&(!Array.isArray(item.content)||item.content.some(part=>!part||typeof part!=='object'||typeof part.type!=='string'||part.type==='text'&&typeof part.text!=='string')))throw failure('NATIVE_CHAT_HISTORY_INVALID','近期聊天历史消息格式无法核实。');
      itemIds.add(item.id);const text=item.type==='agentMessage'?item.text:item.content.filter(part=>part.type==='text').map(part=>part.text).join('\n');
      if(!text)continue;loadedMessageCount++;const visible=clipHistory(text,Math.min(48*1024,maxBytes-bytes));if(!visible){omittedMessageCount++;continue;}bytes+=Buffer.byteLength(visible.text);textTruncated ||= visible.truncated;
      imported.push({id:item.id,role:item.type==='agentMessage'?'assistant':'user',text:visible.text,...(visible.truncated?{historyTruncated:true}:{}),status:turn.status,turnId:turn.id,historySource:'native',...(Number.isSafeInteger(turn.startedAt)&&Number.isFinite(new Date(turn.startedAt*1000).getTime())?{createdAt:new Date(turn.startedAt*1000).toISOString()}:{}),...(item.phase?{phase:item.phase}:{})});
    }
    imported.reverse();
    if(this._state.busy)throw failure('CHAT_BUSY','当前回复开始后，历史刷新未替换显示内容。');
    const local=this._state.messages.filter(item=>item.historySource!=='native'),used=new Set();
    const messages=imported.map(item=>{const previous=local.find(old=>!used.has(old.id)&&(old.id===item.id||item.role==='user'&&old.role==='user'&&old.turnId===item.turnId));if(!previous)return item;used.add(previous.id);return{...previous,...item,...(item.role==='user'?{id:previous.id,text:previous.text,historySource:'local'}:{historySource:'local'})};});
    this._state.messages=[...messages,...local.filter(item=>!used.has(item.id))];
    this._state.nativeHistory={available:true,threadId:this.boundThreadId,loadedAt:new Date().toISOString(),turnCount:turns.length,messageCount:imported.length,loadedMessageCount,omittedMessageCount,pages,bytes,sourceBytes,nextCursor:cursor,hasMore,truncated:hasMore||textTruncated||omittedMessageCount>0,latestTurn:turnMetadata(turns[0])||this._state.nativeHistory?.latestTurn||null};
    await this._persist();this._changed();return this.getState();
  }
  async _assertPeerIdle(){
    let metadata,page;
    try{metadata=await this._readIdentity();if(metadata.status?.type==='active')throw failure('CHAT_BUSY','绑定聊天仍有正在运行的任务，请完成后再发送。');if(!['notLoaded','idle'].includes(metadata.status?.type))throw failure('NATIVE_CHAT_STATUS_UNAVAILABLE','无法确认绑定聊天的当前状态，未发送。');page=await super._request('thread/turns/list',{threadId:this.boundThreadId,limit:1,sortDirection:'desc',itemsView:'notLoaded'});}
    catch(error){if(['NATIVE_CHAT_MISMATCH','CHAT_BUSY','NATIVE_CHAT_STATUS_UNAVAILABLE'].includes(error.code))throw error;throw failure('NATIVE_CHAT_STATUS_UNAVAILABLE','无法读取绑定聊天最新回合状态，未发送。');}
    if(!Array.isArray(page?.data)||page.data.length>1||page.data.length===1&&(!page.data[0]||typeof page.data[0]!=='object'||Array.isArray(page.data[0])))throw failure('NATIVE_CHAT_STATUS_UNAVAILABLE','绑定聊天回合状态格式不可验证，未发送。');
    const latest=page.data[0]||null;
    if(latest&&(!validId(latest.id)||!['completed','interrupted','failed','inProgress'].includes(latest.status)||!Array.isArray(latest.items)||latest.items.length||latest.itemsView&&latest.itemsView!=='notLoaded'))throw failure('NATIVE_CHAT_STATUS_UNAVAILABLE','绑定聊天回合状态格式不可验证，未发送。');
    if(latest?.status==='inProgress')throw failure('CHAT_BUSY','绑定聊天仍有正在运行的回合，请完成后再发送。');
    return{metadata,latest,head:head(latest)};
  }
  async startChat(){throw failure('EXISTING_CHAT_ONLY','此窗口只连接已绑定的聊天，不另建聊天。');}
  async resumeChat({threadId=this.boundThreadId,...options}={}){
    if(threadId!==this.boundThreadId)throw failure('NATIVE_CHAT_MISMATCH','不能把当前窗口静默切换到另一个聊天。');
    if(!this._state.connected)await this.connect();await this._assertPeerIdle();return super.resumeChat({threadId,...options});
  }
  async _resumeThread(threadId,selected,configuration){
    if(threadId!==this.boundThreadId)throw failure('NATIVE_CHAT_MISMATCH','只能继续明确绑定的聊天。');
    const before=await this._assertPeerIdle();
    try{
      if(!this._nativeThreadOwned){
        const response=await this._request('thread/resume',{threadId,excludeTurns:true,model:selected.model,cwd:this.cwd,permissions:this._state.permissionProfile,approvalPolicy:'never',environments:[],runtimeWorkspaceRoots:[this.cwd],config:configuration});
        if(response?.thread?.id!==threadId)throw failure('THREAD_MISMATCH','Codex 返回了不同的聊天身份。');
        this._nativeThreadOwned=true;this._loadedHead=before.head;
        if(response.activePermissionProfile?.id!==this._state.permissionProfile)throw failure('PERMISSION_MISMATCH','无法确认此绑定聊天采用工作台的只读权限，已停止。');
        if(!validSelection(response.model))throw failure('MODEL_SETTINGS_UNCONFIRMED','无法确认绑定聊天恢复后的模型。');
        // A loaded thread can ignore model/effort overrides on resume. Treat its
        // returned values as the current settings, then update only this thread.
        this._verifyThread(response,{model:response.model,effort:response.reasoningEffort||''});this._state.effort=response.reasoningEffort||null;this._settingsUncertain=!response.reasoningEffort;
      }else if(before.head!==this._loadedHead){throw failure('NATIVE_CHAT_CHANGED','绑定聊天的内容已变化，请重新连接后读取最新上下文。');}
      await this._verifyMcpIsolation(threadId,configuration);
      if(this._settingsUncertain||this._state.model!==selected.model||this._state.effort!==selected.effort)await this._updateBoundSettings(selected,configuration,before.head);
      else{const after=await this._assertPeerIdle();if(after.head!==before.head)throw failure('NATIVE_CHAT_CHANGED','设置核对期间聊天内容已变化，未继续。');this._verifyConfiguredMetadata(after.metadata,selected);if(this._settingsUncertain)throw failure('MODEL_SETTINGS_UNCONFIRMED','聊天设置刚被其他操作更改，未继续。');}
      this._loaded=true;this._loadedHead=before.head;this._state.lastError=null;await this._persist();this._changed();return this.getState();
    }catch(error){this._loaded=false;this._state.lastError={code:error.code||'MODEL_SETTINGS_UNCONFIRMED',message:error.message};this._changed();throw error;}
  }
  _verifyConfiguredMetadata(metadata,selected){
    // Schema: loaded metadata is current configuration; notLoaded metadata is
    // only the latest persisted configuration and can legitimately be older.
    if(metadata.status?.type!=='idle')return;
    if(metadata.model!=null&&metadata.model!==selected.model)throw failure('MODEL_MISMATCH','已加载聊天报告的模型与确认设置不同，已停止。');
    if(metadata.reasoningEffort!=null&&metadata.reasoningEffort!==selected.effort)throw failure('EFFORT_MISMATCH','已加载聊天报告的推理强度与确认设置不同，已停止。');
  }
  async _updateBoundSettings(selected,configuration,expectedHead){
    if(this._settingsWaiter)throw failure('CHAT_BUSY','当前聊天模型设置仍在核对。');
    this._settingsUncertain=true;let resolve,reject;
    const acknowledged=new Promise((yes,no)=>{resolve=yes;reject=no;});acknowledged.catch(()=>{});
    const waiter={selected,resolve,reject,error:null,timer:setTimeout(()=>reject(failure('MODEL_SETTINGS_UNCONFIRMED','未收到此聊天模型和推理强度的精确确认，未启动回合。')),Math.min(5000,this.requestTimeoutMs))};this._settingsWaiter=waiter;
    try{
      // Do not change permissions, cwd, plugins, approvals or global config.
      await super._request('thread/settings/update',{threadId:this.boundThreadId,model:selected.model,effort:selected.effort});
      const confirmation=await acknowledged;if(waiter.error)throw waiter.error;
      const after=await this._assertPeerIdle();if(after.head!==expectedHead)throw failure('NATIVE_CHAT_CHANGED','模型设置期间聊天内容已变化，未继续。');
      this._verifyConfiguredMetadata(after.metadata,selected);await this._verifyMcpIsolation(this.boundThreadId,configuration);
      if(waiter.error)throw waiter.error;if(confirmation.revision!==this._settingsRevision)throw failure('MODEL_SETTINGS_UNCONFIRMED','确认后聊天设置再次变化，未启动回合。');
      this._state.model=confirmation.settings.model;this._state.effort=confirmation.settings.effort;this._state.provider=confirmation.settings.modelProvider||this._state.provider;this._settingsUncertain=false;
    }finally{clearTimeout(waiter.timer);if(this._settingsWaiter===waiter)this._settingsWaiter=null;}
  }
  async _sendTurn(input,budget){
    if(this._state.busy)throw failure('CHAT_BUSY','当前窗口的 Codex 回合仍在运行。');
    if(!this._state.connected)await this.connect();const current=await this._assertPeerIdle();
    if(current.head!==this._loadedHead||this._settingsUncertain)this._loaded=false;
    return super._sendTurn(input,budget);
  }
  async _request(method,params,options){
    if(['thread/start','thread/fork'].includes(method))throw failure('EXISTING_CHAT_ONLY','此连接不能创建或派生聊天。');
    if(method==='turn/start'){
      if(params?.threadId!==this.boundThreadId)throw failure('NATIVE_CHAT_MISMATCH','消息只能发往明确绑定的聊天。');
      if(this._settingsUncertain||this._settingsWaiter)throw failure('MODEL_SETTINGS_UNCONFIRMED','聊天模型设置尚未得到确认，未启动回合。');
      const current=await this._assertPeerIdle();
      if(current.head!==this._loadedHead){this._loaded=false;throw failure('NATIVE_CHAT_CHANGED','绑定聊天刚收到其他新内容，请重试以重新读取最新上下文。');}
      const response=await super._request(method,params,options);if(!validId(response?.turn?.id))throw failure('NATIVE_CHAT_STATUS_UNAVAILABLE','Codex 未返回可验证的回合身份。');this._ownedTurnIds.add(response.turn.id);while(this._ownedTurnIds.size>128)this._ownedTurnIds.delete(this._ownedTurnIds.values().next().value);const completed=this._turns.get(response.turn.id);if(completed)this._recordOwnedCompletion({id:response.turn.id,status:completed.status});return response;
    }
    return super._request(method,params,options);
  }
  _recordOwnedCompletion(turn){if(!validId(turn?.id)||!['completed','interrupted','failed'].includes(turn.status))return;this._loadedHead=head(turn);const previous=this._state.nativeHistory?.latestTurn;this._state.nativeHistory={...this._state.nativeHistory,latestTurn:{...(previous?.id===turn.id?previous:{}),...turnMetadata(turn)}};}
  _notification(method,params){
    if(method==='thread/settings/updated'&&params?.threadId===this.boundThreadId){
      this._settingsRevision++;const settings=params.threadSettings,waiter=this._settingsWaiter;
      if(waiter){
        let error;if(settings?.model!==waiter.selected.model)error=failure('MODEL_MISMATCH','Codex 确认的聊天模型与所选模型不同，已停止。');else if(settings?.effort!==waiter.selected.effort)error=failure('EFFORT_MISMATCH','Codex 确认的聊天推理强度与所选值不同，已停止。');else if(settings?.activePermissionProfile?.id!==this._state.permissionProfile)error=failure('PERMISSION_MISMATCH','Codex 确认的聊天权限与只读配置不同，已停止。');
        if(error){waiter.error=error;waiter.reject(error);}else waiter.resolve({settings,revision:this._settingsRevision});
      }else if(this._nativeThreadOwned&&(settings?.model!==this._state.model||settings?.effort!==this._state.effort||settings?.activePermissionProfile?.id!==this._state.permissionProfile)){this._settingsUncertain=true;this._loaded=false;}
    }
    // Advance before CodexBridge persists/emits completion. Only this client's
    // owned turns may advance its loaded head; a Desktop turn must be resumed.
    if(method==='turn/completed'&&params?.threadId===this.boundThreadId&&this._ownedTurnIds.has(params.turn?.id))this._recordOwnedCompletion(params.turn);
    return super._notification(method,params);
  }
  _processFailed(error){this._settingsWaiter?.reject(error);this._nativeThreadOwned=false;return super._processFailed(error);}
  async interrupt(){if(!this._ownedTurnIds.has(this._state.turnId))return{interrupted:false};return super.interrupt();}
  async close(){this._settingsWaiter?.reject(failure('CODEX_UNAVAILABLE','聊天连接已关闭。'));try{await super.close();}finally{this._loadedHead=undefined;this._historyRequestId=null;this._discardingHistory=false;this._nativeThreadOwned=false;this._settingsUncertain=false;await this._releaseNativeLease();}}
}
