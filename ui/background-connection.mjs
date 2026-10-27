import {uiText,localizeInterface} from './languages.mjs';
import {configuredDesktopExecution} from './desktop-execution.mjs';
const element=(tag,className,text)=>{
  const value=document.createElement(tag);
  if(className)value.className=className;
  if(text!==undefined)value.textContent=text;
  return value;
};
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
const paperIdentity=state=>JSON.stringify([state.workspaceIndex?.currentRecordId,state.project?.id,state.project?.snapshotId,(state.project?.files||[]).map(file=>[file.path,file.hash])]);
const paperBusy=state=>state.chat?.busy===true||(state.jobs||[]).some(job=>['queued','running','compiling','cancelling','inProgress'].includes(job.status));
const waiting=phase=>['starting','connecting','waiting-desktop-release'].includes(phase);
const trustedBinding=state=>{
  const value=state.nativeChatBinding;
  return value&&value.projectId===state.project?.id&&validId(value.threadId)?value:null;
};

/** A paper-scoped ownership control. Preparing and checking a connection never
 * sends a conversation message, creates a chat, or controls the Desktop app. */
export function initializeBackgroundConnection({
  api,getState,refreshState=async()=>{},notify=()=>{},onBusyChange=()=>{},
  actions={},pollIntervalMs=2000,maxPolls=60,getLanguage=()=>document.documentElement.lang||'en'
}){
  const panel=document.getElementById('codex-panel');
  if(!panel)return{adopt(){},destroy(){}};
  const action={prepare:'backgroundConnectionPrepare',activate:'backgroundConnectionActivate',status:'backgroundConnectionStatus',release:'backgroundConnectionRelease',...actions};
  const copy=text=>uiText(text,getLanguage());
  const style=element('style');
  style.textContent='.background-connection-bar{padding:10px 16px;border-bottom:1px solid var(--line);background:var(--secondary)}.background-connection-summary{font-size:12px;line-height:1.7;overflow-wrap:anywhere}.background-connection-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:7px}.background-connection-actions .button{font-size:12px;min-height:36px}.background-connection-dialog .dialog-actions{gap:10px;flex-wrap:wrap}.background-connection-dialog .dialog-actions .button{min-height:44px}.background-connection-identity{border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px;margin:14px 0;background:var(--secondary)}.background-connection-identity p{font-size:13px;line-height:1.8;overflow-wrap:anywhere}.background-connection-identity code{font-size:12px;white-space:normal;overflow-wrap:anywhere}.background-connection-dialog .helper{line-height:1.8;margin:12px 0}.background-connection-dialog .inline-error{overflow-wrap:anywhere}.background-connection-dialog .dialog-heading{align-items:flex-start}';
  const bar=element('section','background-connection-bar');bar.id='background-connection-controls';bar.setAttribute('aria-label','论文聊天后台连接');
  const summary=element('p','background-connection-summary');summary.id='background-connection-summary';summary.setAttribute('role','status');summary.setAttribute('aria-live','polite');
  const open=element('button','button','启用后台直连');open.id='background-connection-open';open.type='button';
  const release=element('button','text-button','释放论文聊天连接');release.id='background-connection-release';release.type='button';
  const controls=element('div','background-connection-actions');controls.append(open,release);bar.append(summary,controls);
  panel.insertBefore(bar,document.getElementById('chat-settings')||panel.firstChild);
  const dialog=element('dialog','source-workflow-dialog background-connection-dialog');dialog.id='background-connection-dialog';dialog.setAttribute('aria-labelledby','background-connection-title');
  const heading=element('div','dialog-heading'),headingCopy=element('div'),title=element('h2','','连接论文专用聊天');title.id='background-connection-title';
  headingCopy.append(title,element('p','','独立窗口继续使用同一聊天的历史和模型。'));
  const close=element('button','text-button','关闭');close.id='background-connection-close';close.type='button';heading.append(headingCopy,close);
  const identity=element('div','background-connection-identity');identity.id='background-connection-identity';
  const status=element('p','helper');status.id='background-connection-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const error=element('p','inline-error');error.id='background-connection-error';error.hidden=true;error.setAttribute('role','alert');
  const ownership=element('p','helper','此窗口仅接管论文专用聊天；GPT 桌面端可继续使用其他聊天。后台服务运行时，可关闭桌面端窗口。');
  const activate=element('button','button primary','启用后台直连');activate.id='background-connection-activate';activate.type='button';
  const check=element('button','button','检查连接');check.id='background-connection-check';check.type='button';
  const retryOrigin=element('button','button primary');retryOrigin.id='background-origin-retry';retryOrigin.type='button';retryOrigin.hidden=true;
  const dialogActions=element('div','dialog-actions');dialogActions.append(check,activate,retryOrigin);dialog.append(heading,identity,status,error,ownership,dialogActions);document.head.append(style);document.body.append(dialog);
  let target=null,plan=null,live=null,working=false,lastBusy=false,timer=null,polls=0,generation=0,destroyed=false,pollHalted=false,originDialogThread=null;
  const originCopy=(en,zh)=>getLanguage().startsWith('zh')?zh:en;
  const originState=()=>{
    const state=getState(),origin=state.originatingChat;
    if(!origin||origin.autoConnect!==true||!validId(origin.threadId)||!['pending-paper','waiting-paper-operation','verifying','connecting','waiting-desktop-release','connected','preserved-binding','failed','released'].includes(origin.phase))return null;
    if(origin.projectId&&state.project?.id&&origin.projectId!==state.project.id)return null;
    return origin;
  };
  const automaticOrigin=()=>{const origin=originState();return origin&&origin.phase!=='released'?origin:null;};
  const originMessage=origin=>{
    const messages={
      'pending-paper':['Waiting for a paper; this workbench will connect to the chat that opened it.','等待打开论文；工作台将自动连接发起它的聊天。'],
      'waiting-paper-operation':['Waiting for the paper operation to finish before connecting this chat.','等待论文操作完成后自动连接当前聊天。'],
      verifying:['Verifying the chat that opened this workbench…','正在核验发起此工作台的聊天…'],
      connecting:['Connecting to the verified originating chat…','正在连接已核验的发起聊天…'],
      'waiting-desktop-release':['Waiting for Desktop to release this chat. The same chat is already linked; other chats can continue normally.','当前聊天已关联，等待桌面端释放其连接；其他聊天可正常使用。'],
      connected:['Connected to the chat that opened this workbench. Its history and model are retained.','已连接发起此工作台的聊天，历史记录和模型设置保留。'],
      'preserved-binding':['The saved paper chat differs from the originating chat. Its explicit binding is preserved; use advanced connection controls to change it.','已保存的论文聊天与发起聊天不同。已保留原有明确绑定；如需更换，请使用高级连接设置。'],
      failed:['The originating chat is temporarily unavailable. Retry its verification without choosing another chat.','发起聊天暂时无法连接。可重试核验，无需另选聊天。']
    };
    const [en,zh]=messages[origin.phase]||messages.failed;
    return originCopy(en,zh)+(origin.phase==='failed'&&origin.error?.message?` ${origin.error.message}`:'');
  };
  const current=()=>target&&paperIdentity(getState())===target.identity;
  const capability=()=>getState().capabilities?.backgroundConnection===true;
  const stopPolling=()=>{if(timer!==null){clearTimeout(timer);timer=null;}};
  const scopedLive=()=>{
    const state=getState(),value=live||state.backgroundConnection;
    if(value?.binding?.projectId&&value.binding.projectId!==state.project?.id)return null;
    return value;
  };
  const displayedBinding=()=>{
    const state=getState(),value=scopedLive()?.binding;
    const saved=value&&value.projectId===state.project?.id&&validId(value.threadId)?value:trustedBinding(state),origin=originState();
    if(saved)return saved;
    return origin?.verified===true&&origin.phase!=='preserved-binding'&&validId(origin.model)?origin:null;
  };
  const showError=problem=>{error.textContent=[problem?.code,problem?.message||String(problem)].filter(Boolean).join('：');error.hidden=false;};
  const drawIdentity=binding=>{
    const state=getState();
    identity.replaceChildren();
    for(const[label,value,code]of[
      ['论文',state.project?.mainFile||state.project?.name||state.project?.id||originCopy('Open a paper first','请先打开论文'),false],
      ['聊天',binding?.title||binding?.threadName||copy('等待核验论文专用聊天'),false],
      ['聊天 ID',binding?.threadId||copy('核验后显示'),true],
      ['模型',binding?.model?`${binding.model}${binding.effort?` · ${binding.effort}`:''}`:copy('采用当前模型选择'),true]
    ]){const line=element('p');line.append(element('strong','',`${copy(label)}: `),element(code?'code':'span','',value));identity.append(line);}
  };
  function render(){
    if(destroyed)return;
    const state=getState(),enabled=capability(),connection=scopedLive(),binding=displayedBinding(),phase=connection?.phase||'inactive',isWaiting=waiting(phase),origin=automaticOrigin();
    const desktop=Boolean(configuredDesktopExecution(state));
    bar.hidden=!enabled||desktop;if(desktop&&dialog.open)dialog.close();open.disabled=working||desktop||(!origin&&(paperBusy(state)||!state.project));
    open.textContent=origin?originCopy('Connection status','连接状态'):phase==='connected'?'后台连接设置':isWaiting?'查看连接进度':'启用后台直连';
    title.textContent=origin?originCopy('Originating chat connection','当前聊天连接'):'连接论文专用聊天';
    const service=connection?.serviceOnline?'后台服务在线':'后台服务尚未连接';
    const connectionText=phase==='connected'?'后台已连接':phase==='released'?'已释放论文聊天':isWaiting?'正在连接论文聊天':'论文聊天待连接';
    summary.textContent=origin?`${originMessage(origin)} · ${binding?.title||binding?.threadName||origin.threadId}${binding?.model?` · ${binding.model}${binding.effort?` · ${binding.effort}`:''}`:''}`:`${copy(connectionText)} · ${copy(service)}${binding?` · ${binding.title||binding.threadName||binding.threadId}`:''}${binding?.model?` · ${binding.model}`:''}`;
    release.hidden=phase!=='connected';release.disabled=working||paperBusy(state)||!binding;
    close.disabled=working;activate.hidden=Boolean(origin);activate.disabled=working||paperBusy(state)||!enabled||!current()||!plan||phase==='connected'||isWaiting;
    check.hidden=Boolean(origin)||!plan||phase==='prepared'||phase==='inactive';check.disabled=working||!current();
    retryOrigin.hidden=origin?.phase!=='failed';retryOrigin.disabled=working;retryOrigin.textContent=originCopy('Retry this chat connection','重试当前聊天连接');
    if(dialog.open&&!current()&&!origin)status.textContent='论文或源文件版本已变化，请关闭后针对当前论文重新核验。';
    if(working!==lastBusy){lastBusy=working;onBusyChange(working);}
    localizeInterface(bar,getLanguage());localizeInterface(dialog,getLanguage());
  }
  function describeConnection(){
    const origin=automaticOrigin();if(origin){status.textContent=originMessage(origin);return;}
    const connection=scopedLive(),phase=connection?.phase;
    if(phase==='connected')status.textContent='后台已连接同一论文聊天，历史与模型保留。GPT 桌面端可继续使用其他聊天；后台服务运行时可关闭桌面端窗口。';
    else if(phase==='released')status.textContent='已释放这篇论文的聊天连接；后台服务继续运行，可在桌面端继续该聊天。';
    else if(phase==='waiting-desktop-release')status.textContent='正在等待桌面端释放这篇论文的聊天连接。其他聊天可正常使用；这里只检查连接状态，不会重发消息。';
    else if(waiting(phase))status.textContent='正在启动后台服务并连接这篇论文的聊天；仅检查连接状态，不会发送模型请求。';
    else if(phase==='failed')status.textContent='后台连接尚未完成。可以检查连接状态，或关闭后重新核验。';
    else status.textContent='请核对论文、聊天和模型后启用后台直连。仅移交这篇论文的聊天连接。';
  }
  const payload=()=>({handoffId:plan.handoffId,threadId:plan.threadId,expectedProjectId:target.projectId,expectedSnapshotId:target.snapshotId});
  function acceptConnection(value){
    const result=value?.connection||value?.backgroundConnection||value;
    if(!result||!['inactive','prepared','starting','connecting','waiting-desktop-release','connected','released','failed'].includes(result.phase)||result.phase==='connected'&&!result.binding)throw Error('后台连接状态无法核验。');
    if(result.binding&&(result.binding.projectId!==target.projectId||result.binding.threadId!==plan.threadId))throw Error('后台返回的聊天身份与当前论文不一致。');
    live=result;drawIdentity(result.binding||plan);describeConnection();render();
  }
  async function readStatus(){
    if(working||!plan||!current()||destroyed||automaticOrigin())return;
    const ticket=generation;working=true;error.hidden=true;render();
    try{const result=await api(action.status,payload());if(destroyed||ticket!==generation||!current())return;acceptConnection(result);pollHalted=false;await refreshState();}
    catch(problem){if(!destroyed&&ticket===generation){pollHalted=true;stopPolling();showError(problem);status.textContent='暂时无法检查后台连接。未重发任何聊天消息，可以稍后再检查。';}}
    finally{if(!destroyed&&ticket===generation){working=false;render();}}
  }
  function schedulePoll(){
    stopPolling();
    if(destroyed||pollHalted||!current()||!plan||automaticOrigin()||!waiting(scopedLive()?.phase)||polls>=maxPolls)return;
    timer=setTimeout(async()=>{timer=null;polls++;await readStatus();schedulePoll();},Math.max(20,pollIntervalMs));
  }
  open.addEventListener('click',async()=>{
    if(open.disabled||!capability())return;
    const origin=automaticOrigin();
    if(origin){
      stopPolling();const state=getState();target={identity:paperIdentity(state),projectId:state.project?.id,snapshotId:state.project?.snapshotId};originDialogThread=origin.threadId;generation++;plan=null;error.hidden=true;
      drawIdentity(displayedBinding()||{threadId:origin.threadId});describeConnection();dialog.showModal();render();return;
    }
    originDialogThread=null;
    stopPolling();const state=getState();target={identity:paperIdentity(state),projectId:state.project.id,snapshotId:state.project.snapshotId};
    const ticket=++generation;plan=null;working=true;pollHalted=false;error.hidden=true;drawIdentity(trustedBinding(state));status.textContent='正在核验当前论文与已保存的聊天身份…';dialog.showModal();render();
    try{
      const selected=trustedBinding(state),model=document.getElementById('chat-model')?.value||selected?.model||state.chat?.model,effort=document.getElementById('chat-effort')?.value||selected?.effort||state.chat?.effort;
      const value=await api(action.prepare,{expectedProjectId:target.projectId,expectedSnapshotId:target.snapshotId,...(model?{model}:{}),...(effort?{effort}:{})});
      if(destroyed||ticket!==generation||!current())return;
      const prepared=value?.plan||value;
      if(!validId(prepared?.handoffId)||prepared.projectId!==target.projectId||prepared.snapshotId!==target.snapshotId||!validId(prepared.threadId)||!validId(prepared.model)||prepared.effort&&!validId(prepared.effort)||selected&&prepared.threadId!==selected.threadId||model&&prepared.model!==model||effort&&prepared.effort!==effort)throw Error('准备连接返回的论文、聊天或模型身份无法核验。');
      const previous=scopedLive(),sameConnection=previous?.binding?.threadId===prepared.threadId&&previous?.binding?.projectId===prepared.projectId;
      plan=prepared;live={phase:sameConnection&&(previous.phase==='connected'||waiting(previous.phase))?previous.phase:'prepared',serviceOnline:previous?.serviceOnline===true,binding:prepared};drawIdentity(prepared);describeConnection();
    }catch(problem){if(!destroyed&&ticket===generation){showError(problem);status.textContent='尚未启用后台直连；当前论文和聊天记录保留。';}}
    finally{if(!destroyed&&ticket===generation){working=false;render();}}
  });
  activate.addEventListener('click',async()=>{
    if(activate.disabled||!current())return;
    const ticket=generation;working=true;error.hidden=true;status.textContent='正在启动后台服务并移交这篇论文的聊天连接…';render();
    try{
      const result=await api(action.activate,{...payload(),model:plan.model,...(plan.effort?{effort:plan.effort}:{})});
      if(destroyed||ticket!==generation||!current())return;acceptConnection(result);await refreshState();polls=0;pollHalted=false;
      if(scopedLive()?.phase==='connected')notify(copy('后台已连接同一论文聊天。'));
    }catch(problem){if(!destroyed&&ticket===generation){showError(problem);status.textContent='后台连接尚未完成；没有重发聊天消息，也没有创建其他聊天。';}}
    finally{if(!destroyed&&ticket===generation){working=false;render();schedulePoll();}}
  });
  check.addEventListener('click',async()=>{if(check.disabled)return;stopPolling();await readStatus();});
  retryOrigin.addEventListener('click',async()=>{
    const origin=automaticOrigin();if(retryOrigin.disabled||origin?.phase!=='failed')return;
    const threadId=origin.threadId,ticket=++generation;working=true;error.hidden=true;render();
    try{await api('retryOriginChat',{});if(destroyed||ticket!==generation||originState()?.threadId!==threadId)return;await refreshState();describeConnection();}
    catch(problem){if(!destroyed&&ticket===generation)showError(problem);}
    finally{if(!destroyed&&ticket===generation){working=false;render();}}
  });
  release.addEventListener('click',async()=>{
    const state=getState(),binding=displayedBinding();if(release.disabled||!binding)return;
    stopPolling();const captured=paperIdentity(state),ticket=++generation;working=true;error.hidden=true;render();
    try{
      const result=await api(action.release,{threadId:binding.threadId,expectedProjectId:state.project.id,expectedSnapshotId:state.project.snapshotId});
      if(destroyed||ticket!==generation||captured!==paperIdentity(getState()))return;
      const connection=result?.connection||result?.backgroundConnection||result;
      if(connection?.phase!=='released'||connection.binding?.threadId&&connection.binding.threadId!==binding.threadId)throw Error('论文聊天的释放状态无法核验。');
      live=connection;await refreshState();notify(copy('已释放论文聊天连接，后台服务继续运行。'));
    }catch(problem){if(!destroyed&&ticket===generation){showError(problem);if(!dialog.open){drawIdentity(binding);status.textContent='尚未确认释放论文聊天。请关闭后重新打开后台连接设置以核验。';dialog.showModal();}}}
    finally{if(!destroyed&&ticket===generation){working=false;render();}}
  });
  close.addEventListener('click',()=>{if(!working)dialog.close();});
  dialog.addEventListener('cancel',event=>{if(working)event.preventDefault();});
  render();
  return{
    adopt(){
      if(destroyed)return;
      const incoming=getState().backgroundConnection;if(incoming)live=incoming;
      const origin=automaticOrigin();
      if(origin)stopPolling();
      if(dialog.open&&origin){
        if(originDialogThread!==origin.threadId){originDialogThread=origin.threadId;generation++;working=false;plan=null;error.hidden=true;}
        const state=getState();target={identity:paperIdentity(state),projectId:state.project?.id,snapshotId:state.project?.snapshotId};drawIdentity(displayedBinding()||{threadId:origin.threadId});describeConnection();
      }
      if(target&&!current())stopPolling();render();
    },
    destroy(){destroyed=true;generation++;stopPolling();bar.remove();dialog.remove();style.remove();if(lastBusy)onBusyChange(false);}
  };
}
