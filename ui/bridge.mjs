import { App } from '@modelcontextprotocol/ext-apps/app-with-deps';
import { mountNativeRelay } from './native-chat-relay.mjs';
import { parseLocalSessionFragment } from './local-session.mjs';

const listeners = new Set();
const local = window.parent === window && /^127\.0\.0\.1$/.test(location.hostname);
let token, handoffId, sessionFragmentError;
if (local) {
  try { ({ session: token, handoffId } = parseLocalSessionFragment(location.hash)); }
  catch (error) { sessionFragmentError = error; }
  if (token) { sessionStorage.setItem('paper-editor-session', token); if (!handoffId) history.replaceState(null, '', location.pathname); }
  if (!sessionFragmentError && !token) { const stored = sessionStorage.getItem('paper-editor-session'); if (/^[A-Za-z0-9_-]{43}$/.test(stored || '')) token = stored; }
}
const host = { connected: false, mode: local ? 'local-preview' : 'mcp-app', canSendMessage: false, projectHandoffId: handoffId || null, label: local ? '本地预览 · 未连接项目聊天' : '正在连接线程面板', reason: '' };
host.bridgeDiagnostics = { toolResultReceived: false, toolResultMetaFields: [], bootstrapAttempted: false, bootstrapReturned: false, bootstrapMetaFields: [], bootstrapFailed: false, uiTokenReceived: false, stateReceived: false };
let lastState;
let stateTag;
let uiToken;
let resolveUiToken;
const tokenReady = new Promise(resolve => { resolveUiToken = resolve; });
let app;
let relaySession,hostRelay;
const outgoingKeys=new Map();
function startHostRelay(){if(local||hostRelay||!app||!uiToken||!relaySession)return;hostRelay=mountNativeRelay({app,getUiToken:()=>uiToken,getRelaySession:()=>relaySession,onStatus:value=>{host.relayStatus=value.status;}});window.addEventListener('pagehide',()=>hostRelay?.stop(),{once:true});}
let uiSession;
const workerActions = new Set(['models', 'chatState', 'chatStart', 'chatSelectModel', 'chatSend', 'chatInterrupt', 'chatDisconnect', 'runRequest', 'runReviewOrganization', 'reviewCycle', 'fullPaperReview', 'reviewParagraph', 'syncParagraph']);
const lightActions=new Set(['pollEditorDraftCapture','publishEditorDrafts','getUpdates','checkUpdates','configureUpdates']);
const announce = () => { for (const fn of listeners) fn(lastState, { ...host }); };
const unpack = (result, source = 'rpc') => {
  const metadata = result?._meta;
  const fields = ['paperState', 'paperResult', 'instanceId', 'paperUiToken', 'paperError'].filter(key => metadata && Object.hasOwn(metadata, key));
  if (source === 'tool-result') { host.bridgeDiagnostics.toolResultReceived = true; host.bridgeDiagnostics.toolResultMetaFields = fields; }
  if (source === 'bootstrap') { host.bridgeDiagnostics.bootstrapReturned = true; host.bridgeDiagnostics.bootstrapMetaFields = fields; }
  if (result.isError) {
    const detail = result._meta?.paperError ?? result.structuredContent?.error;
    throw Object.assign(new Error(detail?.message || result.content?.find(x => x.type === 'text')?.text || '宿主工具调用失败'), { code: detail?.code || 'HOST_TOOL_FAILED' });
  }
  if (Array.isArray(metadata?.paperState?.segments)) { lastState = metadata.paperState; host.bridgeDiagnostics.stateReceived = true; }
  if (typeof metadata?.paperUiToken === 'string' && metadata.paperUiToken.length > 0 && metadata.paperUiToken.length <= 128) { uiToken = metadata.paperUiToken; host.bridgeDiagnostics.uiTokenReceived = true; resolveUiToken(uiToken); }
  if(typeof metadata?.paperRelaySession==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(metadata.paperRelaySession)){relaySession=metadata.paperRelaySession;startHostRelay();}
  announce();
  return result._meta?.paperResult ?? result._meta?.paperState ?? result.structuredContent;
};
const ready = local ? Promise.resolve() : (async () => {
  app = new App({ name: 'bilingual-paper-editor', version: '1.6.2' });
  app.ontoolresult = result => { try { unpack(result, 'tool-result'); } catch (e) { host.reason = e.message; announce(); } };
  app.onhostcontextchanged = context => {
    if (context.theme && !document.documentElement.dataset.themePreference) document.documentElement.dataset.theme = context.theme;
    announce();
  };
  try {
    await app.connect();
    const capabilities = app.getHostCapabilities();
    host.connected = true;
    host.canSendMessage = Boolean(capabilities?.message);
    host.label = host.canSendMessage ? '宿主桥已连接 · 当前线程入口' : '宿主桥已连接 · 消息能力未确认';
    announce();
  } catch (e) {
    host.reason = '宿主桥未建立。请在支持 MCP Apps 的 Codex 线程入口中重新打开。';
    host.label = '宿主未连接';
    announce();
  }
})();

async function ensureUiSession() {
  if (uiToken) return;
  uiSession ||= (async () => {
    // Let the normal post-initialize tool-result notification arrive first.
    await Promise.race([tokenReady, new Promise(resolve => setTimeout(resolve, 100))]);
    if (uiToken) return;
    host.bridgeDiagnostics.bootstrapAttempted = true; announce();
    const bootstrap = app.callServerTool({ name: 'bilingual_paper_panel', arguments: {} }, { timeout: 10000 }).then(result => {
      unpack(result, 'bootstrap');
      if (!uiToken) throw Object.assign(new Error('宿主未转交工作台的 UI 专用元数据。请重新打开原生面板，并查看“详情”中的桥诊断。'), { code: 'UI_METADATA_MISSING' });
    }).catch(error => {
      host.bridgeDiagnostics.bootstrapFailed = true; announce();
      if (uiToken) return;
      if (error.code === 'UI_METADATA_MISSING') throw error;
      throw Object.assign(new Error('原生工作台自举未完成。请重新打开面板，并查看“详情”中的桥诊断。'), { code: 'UI_BOOTSTRAP_FAILED' });
    });
    // A delayed original notification can establish the session while the
    // single fallback RPC is still pending. Neither path starts a model.
    await Promise.race([tokenReady, bootstrap]);
  })();
  await uiSession;
}

export function subscribe(fn) { listeners.add(fn); if (lastState) fn(lastState, { ...host }); return () => listeners.delete(fn); }
export function getHostState() { return { ...host }; }
export async function api(action, payload = {}) {
  if (local) {
    if (sessionFragmentError) throw sessionFragmentError;
    if (host.mode === 'native-window' && !host.directChat&&workerActions.has(action)) throw Object.assign(new Error('此窗口通过已绑定的原生聊天处理请求，不运行替代线程。请使用已连接的发送通道。'), { code: 'NATIVE_WINDOW_WORKER_DISABLED' });
    const endpoint = action === 'importReviewNotes' ? '/api/review-import' : ['reviewCycle', 'cacheVersionPairContext', 'cacheActivePdfContext'].includes(action) ? '/api/review-cycle' : '/api';
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token || ''}`, ...(action === 'state' && stateTag ? { 'If-None-Match': stateTag } : {}) }, body: JSON.stringify({ action, payload }) });
    if (response.status === 304 && action === 'state' && lastState) return lastState;
    const body = await response.json();
    if (!body.ok) throw Object.assign(new Error(body.error?.message || '请求失败'), { code: body.error?.code, ...(body.error?.returnUrl ? { returnUrl: body.error.returnUrl } : {}) });
    if (action === 'ackProjectWindow' && body.result?.acknowledged === true) { host.projectHandoffId = null; handoffId = null; history.replaceState(null, '', location.pathname); }
    if (body.transport?.mode === 'native-window' && body.transport.nativeChat === true) {
      host.mode='native-window';host.connected=true;host.canSendMessage=body.transport.canSendMessage===true;host.directChat=body.transport.directChat===true;host.relayChat=body.transport.relayChat===true;host.messageRoute=body.transport.messageRoute;host.threadId=body.transport.threadId||null;
      host.label=host.canSendMessage?'独立窗口 · 已连接绑定聊天':'独立窗口 · 等待聊天连接卡';host.reason=body.transport.reason||'';
    }
    const responseState=action==='state'?(body.state||body.result):body.state;
    if (responseState&&!lightActions.has(action)) lastState = responseState;
    host.relayPending=Boolean(host.relayChat&&lastState?.nativeChatRelay?.messages?.some(message=>!message.historical&&['pending','claimed','sent'].includes(message.status)));
    if (action === 'state') stateTag = response.headers.get('etag'); else if(!lightActions.has(action)) stateTag = null;
    if(!lightActions.has(action))announce();
    return action==='state'&&lastState?lastState:body.result;
  }
  await ready;
  if (!host.connected) throw Object.assign(new Error(host.reason), { code: 'CAPABILITY_UNAVAILABLE' });
  if (action === 'state' && lastState && !uiToken) return lastState;
  await ensureUiSession();
  return unpack(await app.callServerTool({ name: 'bilingual_paper_ui', arguments: { action, payload, uiToken } }));
}
export async function sendToHost(text) {
  await ready;
  if(host.mode==='native-window'){
    if(host.directChat)return api('chatSend',{text});
    if(!host.relayChat||!host.canSendMessage)throw Object.assign(new Error(host.reason||'请在绑定聊天中保留聊天连接卡，再从窗口发送。'),{code:'NATIVE_WINDOW_MESSAGE_UNAVAILABLE'});
    if(typeof text!=='string'||!text.trim()||new TextEncoder().encode(text).length>65536)throw new Error('消息须为非空文本，最多64 KiB。');
    const idempotencyKey=outgoingKeys.get(text)||crypto.randomUUID();outgoingKeys.set(text,idempotencyKey);const result=await api('sendNativeMessage',{text,idempotencyKey});outgoingKeys.delete(text);return result;
  }
  if (!host.connected || !host.canSendMessage) throw Object.assign(new Error(local ? '本地预览没有项目聊天通道。可复制请求到原项目聊天。' : '当前宿主未提供消息能力。'), { code: 'CAPABILITY_UNAVAILABLE' });
  if (typeof text !== 'string' || text.length > 64000) throw new Error('选段请求超过允许范围。');
  const result = await app.sendMessage({ role: 'user', content: [{ type: 'text', text }] });
  if (result?.isError) throw new Error('宿主拒绝发送消息；请求尚未送达。');
  return result;
}
