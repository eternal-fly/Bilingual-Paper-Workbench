import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { verifiedExistingChat } from './existing-chat-binding.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { REVIEW_IMPORT_LIMITS } from './review-limits.mjs';
import { callBackgroundModelTool } from './native-tool-dispatch.mjs';
import { MODEL_TOOL_BYTES } from './request-budgets.mjs';
import { editorDraftsFor } from './editor-drafts.mjs';
import {publicUpdateChecker} from './update-checker.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const actions = new Set(['state', 'listWorkspaces', 'openWorkspaceRecord', 'bootstrapHostProject', 'openProject', 'demo', 'configureEngine', 'saveDraft', 'splitTranslation', 'setAlignment', 'createRequest', 'editProposal', 'addComment', 'resolveComment', 'rejectProposal', 'previewTransaction', 'exportPatch', 'refreshProject', 'readPdf', 'readVersionPair', 'reviewCycle', 'cacheVersionPairContext', 'cacheActivePdfContext', 'recordPdfView', 'selectPdfReviewTarget', 'configureLanguages', 'readBuildLog', 'locateSource', 'locatePdf', 'importResult', 'compileBaseline', 'compileEnglish', 'importReviewNotes', 'setReviewImportActive', 'fullPaperReview', 'reviewParagraph', 'configureSync', 'syncParagraph', 'resolveReviewNote', 'setReviewDecision', 'anchorReviewNote', 'cancelJob', 'prepareAcceptance', 'applyTransaction', 'createUndoProposal', 'recoverTransactions', 'models', 'chatState', 'chatStart', 'chatSelectModel', 'chatSend', 'chatInterrupt', 'chatDisconnect', 'runRequest']);
actions.add('compileReviewNote');
for (const action of ['configureReviewHistory', 'prepareClearReviewHistory', 'clearReviewHistory']) actions.add(action);
for (const action of ['prepareDeleteReviewImport', 'deleteReviewImport', 'revalidateReviewImport', 'reopenReviewImportNote']) actions.add(action);
for (const action of ['listProjectSources', 'readProjectSource', 'prepareReviewOrganization', 'getReviewOrganizationContext', 'submitReviewOrganization', 'runReviewOrganization']) actions.add(action);
for (const action of ['connectExistingChat','prepareReviewAnchors','getReviewAnchorContext','submitReviewAnchors','confirmReviewAnchor','runReviewAnchors']) actions.add(action);
for(const action of ['prepareBackgroundBinding','backgroundConnectionPrepare','backgroundConnectionActivate','backgroundConnectionStatus','backgroundConnectionRelease'])actions.add(action);
actions.add('sendNativeMessage');
actions.add('importFiles');
actions.add('callNativeTool');
actions.add('retryOriginChat');
actions.add('editTranslationFormula');
actions.add('saveTranslationDraftWithFormulaEdits');
actions.add('getDisplayPreferences');
actions.add('configureDisplayPreferences');
for (const action of ['startTranslationTask', 'cancelTranslationTask', 'resumeTranslationTask', 'desktopSendMessage', 'runDesktopRequest', 'openDesktopChat']) actions.add(action);
const editorActions = new Set(['pollEditorDraftCapture', 'publishEditorDrafts']);
for (const action of editorActions) actions.add(action);
const updateActions=new Set(['getUpdates','checkUpdates','configureUpdates']);
for(const action of updateActions)actions.add(action);
const nativeWorkerActions=new Set(['models','chatState','chatStart','chatSelectModel','chatSend','chatInterrupt','chatDisconnect','runRequest','runReviewOrganization','runReviewAnchors','reviewCycle','fullPaperReview','reviewParagraph','syncParagraph']);
const LIMIT = MODEL_TOOL_BYTES;
const error = (code, message) => Object.assign(new Error(message), { code });
function boundedBody(request, maximum) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0, settled = false;
    request.on('data', chunk => {
      if (settled) return; // Drain the remaining upload without retaining it.
      size += chunk.length;
      if (size > maximum) { settled = true; chunks = []; reject(error('INPUT_TOO_LARGE', '请求超过此通道的传输上限。')); return; }
      chunks.push(chunk);
    });
    request.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); chunks = []; } });
    request.on('error', cause => { if (!settled) { settled = true; chunks = []; reject(cause); } });
    request.on('aborted', () => { if (!settled) { settled = true; chunks = []; reject(error('UPLOAD_ABORTED', '上传已中止。')); } });
  });
}

export async function dispatchUi(service, action, payload = {}, { nativeBindingId = null,updateChecker=null } = {}) {
  if (!actions.has(action)) throw error('INVALID_INPUT', '不支持的操作。');
  if(updateActions.has(action)){
    const checker=updateChecker||publicUpdateChecker();
    if(action==='getUpdates'){if(Object.keys(payload).length)throw error('INVALID_INPUT','Read only the registered public update settings.');return checker.state();}
    return action==='checkUpdates'?checker.check(payload):checker.configure(payload);
  }
  if (service._assistantImportPromise && !['state', 'listWorkspaces'].includes(action)) throw error('IMPORT_BUSY', 'Wait for the current file import to finish.');
  if (action === 'retryOriginChat') {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length) throw error('INVALID_INPUT', 'Retry only this window\'s trusted originating chat.');
    return service.retryOriginChat();
  }
  if (action === 'importFiles') {
    if (!Object.hasOwn(payload, 'files')) return service.importFiles(payload);
    if (Object.keys(payload).some(key => !['files', 'originBindingId'].includes(key)) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(payload.originBindingId || '')) throw error('INVALID_INPUT', 'Use the exact originating paper chat instance.');
    return service.importFiles(payload.files, { bindingId: payload.originBindingId });
  }
  if (action === 'callNativeTool') return callBackgroundModelTool(service, payload);
  if (editorActions.has(action)) {
    const store = editorDraftsFor(service);
    return action === 'pollEditorDraftCapture' ? store.poll(payload) : store.publish(payload);
  }
  if (action === 'state') return service.getState();
  if(action==='sendNativeMessage'){if(!nativeBindingId||!service.nativeRelay)throw error('NATIVE_CHAT_REQUIRED','此窗口没有当前聊天连接卡。');const result=service.nativeRelay.enqueue(payload);await service.persistNativeRelayMessages?.(service.nativeRelay.getState().messages);service.emit?.('change');return result;}
  const desktop=service.desktopExecution?.state?.(),desktopMode=desktop?.mode==='desktop-queue';
  const desktopReady=desktopMode&&desktop.available===true&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(desktop.threadId||'');
  const desktopReviewAction=['prepareReviewOrganization','getReviewOrganizationContext','submitReviewOrganization','prepareReviewAnchors','getReviewAnchorContext','submitReviewAnchors'].includes(action);
  if(desktopMode&&!desktopReady&&(desktopReviewAction||nativeWorkerActions.has(action)))throw error('DESKTOP_EXECUTION_UNAVAILABLE',desktop.reason||'The verified originating Desktop chat is unavailable. No independent model fallback was started.');
  const direct=verifiedExistingChat(service),bindingId=desktopReady?`desktop:${desktop.threadId}`:direct?null:nativeBindingId;
  if(nativeBindingId&&!direct&&!desktopReady&&nativeWorkerActions.has(action))throw error('NATIVE_CHAT_REQUIRED','请通过已连接的宿主聊天通道发送，或先明确连接同一已存在的聊天。不会另建替代聊天。');
  if (action === 'prepareReviewOrganization') return service.prepareReviewOrganization(payload, { bindingId });
  if (action === 'getReviewOrganizationContext') return service.getReviewOrganizationContext(payload, { bindingId });
  if (action === 'submitReviewOrganization') return service.submitReviewOrganization(payload, { bindingId });
  if (action === 'prepareReviewAnchors') return service.prepareReviewAnchors(payload, { bindingId });
  if (action === 'getReviewAnchorContext') return service.getReviewAnchorContext(payload, { bindingId });
  if (action === 'submitReviewAnchors') return service.submitReviewAnchors(payload, { bindingId });
  if (action === 'importResult') {
    if (!payload || Object.keys(payload).length !== 1 || !payload.result || typeof payload.result !== 'object') throw error('INVALID_INPUT', '请粘贴完整的结构化返回结果。');
    const request = service.getState().requests.find(item => item.requestId === payload.result.requestId);
    if (!request || request.bindingId !== (direct?`codex:${direct.threadId}`:nativeBindingId || 'local-preview-manual')) throw error('PERMISSION_DENIED', '只能导入由此本地工作台登记的请求结果。');
    if (request.kind === 'translation') return service.submitTranslationResult(payload.result);
    if (request.kind === 'revision') return service.proposeRevision(payload.result);
    throw error('INVALID_INPUT', '讨论请求没有可导入的修改结果。');
  }
  if (action === 'demo') {
    await service.openProject({ root: path.join(packageRoot, 'fixtures/sample-paper'), mainFile: 'main.tex', sourceLanguage: 'en', targetLanguage: 'zh-CN' });
    return { ...service.getState(), synthetic: true };
  }
  if (action === 'createRequest') {
    const desktop = service.desktopExecution?.state();
    if (desktop?.mode === 'desktop-queue') {
      if (!desktop.available) throw error('DESKTOP_EXECUTION_UNAVAILABLE', desktop.reason || 'Desktop delivery is unavailable.');
      if (Object.hasOwn(payload, 'bindingId')) throw error('PERMISSION_DENIED', 'The Desktop request binding comes from this paper.');
      const { useDedicatedChat: _unused, ...request } = payload;
      return service.createRequest({ ...request, bindingId: `desktop:${desktop.threadId}` });
    }
    if (nativeBindingId) {
      if (Object.hasOwn(payload, 'bindingId')) throw error('PERMISSION_DENIED', '原生窗口的请求绑定由当前宿主确定。');
      const { useDedicatedChat = false, ...request } = payload;
      if (typeof useDedicatedChat !== 'boolean') throw error('INVALID_INPUT', '聊天连接选项无效。');
      const chat = service.chat?.getState?.();
      if(direct)return service.createRequest({...request,bindingId:`codex:${direct.threadId}`});
      if (useDedicatedChat && (!chat?.connected || !chat.threadId)) throw error('CHAT_REQUIRED', '请先明确连接独立论文聊天，再使用该聊天提交选段。');
      return service.createRequest({ ...request, ...(useDedicatedChat ? {} : { bindingId: nativeBindingId }) });
    }
    return service.createRequest({ ...payload, ...(service.chat ? {} : { bindingId: 'local-preview-manual' }) });
  }
  if (typeof service[action] !== 'function') throw error('CAPABILITY_UNAVAILABLE', '当前控制器不支持此操作。');
  const result = await service[action](payload);
  return result ?? service.getState();
}

export async function startLocalWeb({ service, port = 0, htmlPath = path.join(packageRoot, 'dist/preview.html'), nativeBindingId = null, syncHostProject = null, switchWorkspace = null, projectWindowHandoff = null,updateChecker=null } = {}) {
  if (!service) throw new TypeError('service is required');
  if (nativeBindingId !== null && (typeof nativeBindingId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(nativeBindingId))) throw new TypeError('Use an exact internal native instance identity.');
  const transport = state => {if(!nativeBindingId)return undefined;const direct=verifiedExistingChat(service,state),relay=service.nativeRelay?.getState?.(),ready=relay?.available&&relay?.canSendMessage;return nativeBindingId ? { mode:'native-window',nativeChat:true,canSendMessage:Boolean(ready||direct),directChat:Boolean(direct),relayChat:Boolean(!direct&&relay),messageRoute:direct?'bound-existing-chat':relay?'native-relay':'unavailable',reason:direct?'此窗口直接继续已验证的同一持久聊天。':relay?.reason||'请在绑定聊天中加载聊天连接卡。',...(direct?{threadId:direct.threadId}:{}) } : undefined;};
  const token = randomBytes(32).toString('base64url');
  let revision = 0;
  let relayFingerprint='';
  const observable = typeof service.on === 'function';
  const changed = () => { revision++; };
  if (observable) service.on('change', changed);
  let origin;
  const server = http.createServer(async (req, res) => {
    const reply = (status, value, extra = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.headers.host !== new URL(origin).host) return reply(403, { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Host 校验失败。' } });
      if (req.method === 'GET' && req.url === '/') {
        const html = await readFile(htmlPath);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'self'; frame-src blob:; worker-src blob:; font-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'
        });
        return res.end(html);
      }
      const reviewImport = req.url === '/api/review-import';
      const reviewCycle = req.url === '/api/review-cycle';
      if ((!reviewImport && !reviewCycle && req.url !== '/api') || req.method !== 'POST') return reply(404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown endpoint.' } });
      if (req.headers.origin !== origin) return reply(403, { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Origin 校验失败。' } });
      const supplied = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401, { ok: false, error: { code: 'PERMISSION_DENIED', message: '本地会话凭证无效，请重新打开启动链接。' } });
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return reply(415, { ok: false, error: { code: 'INVALID_INPUT', message: '仅接受 JSON。' } });
      const body = await boundedBody(req, reviewImport ? REVIEW_IMPORT_LIMITS.httpBytes : reviewCycle ? 8 * 1024 * 1024 : LIMIT);
      let input;
      try { input = JSON.parse(body); }
      catch { return reply(400, { ok: false, error: { code: 'INVALID_INPUT', message: 'JSON 无效。' } }); }
      if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(k => !['action', 'payload'].includes(k)) || !(actions.has(input.action) || input.action === 'syncHostProject' && typeof syncHostProject === 'function' || input.action === 'switchWorkspace' && typeof switchWorkspace === 'function' || input.action === 'prepareProjectWindowHandoff' && typeof projectWindowHandoff?.prepare === 'function' || input.action === 'ackProjectWindow' && typeof projectWindowHandoff?.acknowledge === 'function') || (input.payload !== undefined && (!input.payload || Array.isArray(input.payload) || typeof input.payload !== 'object'))) {
        return reply(400, { ok: false, error: { code: 'INVALID_INPUT', message: '请求格式或操作无效。' } });
      }
      if (reviewImport && input.action !== 'importReviewNotes') return reply(400, { ok: false, error: { code: 'INVALID_INPUT', message: '大文件通道仅用于导入评阅意见。' } });
      if (reviewCycle && !['reviewCycle', 'cacheVersionPairContext', 'cacheActivePdfContext', 'recordPdfView', 'selectPdfReviewTarget', 'configureLanguages'].includes(input.action)) return reply(400, { ok: false, error: { code: 'INVALID_INPUT', message: '双 PDF 通道仅用于本次论文反馈。' } });
      if (input.action === 'state') await service.refreshExternalJobStatus?.();
      if(input.action==='state'&&service.nativeRelay){const fresh=JSON.stringify(service.nativeRelay.getState());if(fresh!==relayFingerprint){relayFingerprint=fresh;revision++;}}
      const etag = observable && input.action === 'state' ? `"paper-${revision}"` : null;
      if (etag && req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-store' }); res.end(); return; }
      const result = input.action === 'syncHostProject' && typeof syncHostProject === 'function' ? await syncHostProject(input.payload) : input.action === 'switchWorkspace' && typeof switchWorkspace === 'function' ? await switchWorkspace(input.payload) : input.action === 'prepareProjectWindowHandoff' && projectWindowHandoff ? await projectWindowHandoff.prepare(input.payload) : input.action === 'ackProjectWindow' && projectWindowHandoff ? await projectWindowHandoff.acknowledge(input.payload) : await dispatchUi(service, input.action, input.payload, { nativeBindingId,updateChecker });
      // Editor heartbeats and snapshots carry only their bounded evidence. Do
      // not clone, serialize or repaint the entire manuscript while typing.
      if (editorActions.has(input.action)||updateActions.has(input.action)) return reply(200, { schemaVersion: 1, ok: true, result });
      const decorate = value => value && (service.active || service).core ? { ...value, capabilities: { ...value.capabilities, editorDraftCapture: true,releaseUpdates:true } } : value;
      const state = decorate(input.action === 'state' ? result : service.getState());
      const route=transport(state);return reply(200, { schemaVersion: 1, ok: true, result: input.action === 'state' ? state : result, ...(input.action === 'state' ? {} : { state }), ...(route ? { transport:route } : {}) }, etag ? { ETag: etag } : {});
    } catch (e) {
      return reply(e.code === 'INPUT_TOO_LARGE' ? 413 : e.code === 'VERSION_CONFLICT' ? 409 : 400, { schemaVersion: 1, ok: false, error: { code: e.code ?? 'INTERNAL_ERROR', message: e.code ? e.message : '操作失败。请检查项目权限与服务状态。' } });
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, token, url: `${origin}/#session=${token}`, server, close: () => new Promise(resolve => { if (observable) service.off?.('change', changed); server.close(resolve); server.closeAllConnections(); }) };
}

async function main() {
  const { createApplication } = await import('./runtime.mjs');
  const service = await createApplication();
  if (process.env.PAPER_EDITOR_WORKSPACE && process.env.PAPER_EDITOR_MAIN_FILE) await service.openProject({ root: process.env.PAPER_EDITOR_WORKSPACE, mainFile: process.env.PAPER_EDITOR_MAIN_FILE, sourceLanguage: 'en', targetLanguage: 'zh-CN' });
  service.startWatching();
  const web = await startLocalWeb({ service, port: Number(process.env.PAPER_EDITOR_PORT || 0) });
  const launch = { url: web.url, pid: process.pid, version: process.env.PAPER_EDITOR_INSTALL_VERSION || '0.5.0', mode: 'independent-workbench', hostConversation: false, dedicatedCodex: true };
  if (process.env.PAPER_EDITOR_LAUNCH_STATE) {
    await mkdir(path.dirname(process.env.PAPER_EDITOR_LAUNCH_STATE), { recursive: true, mode: 0o700 });
    await writeFile(process.env.PAPER_EDITOR_LAUNCH_STATE, JSON.stringify(launch), { mode: 0o600 });
  } else process.stdout.write(JSON.stringify(launch) + '\n');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await service.close(); await web.close(); process.exit(0); });
}
// esbuild gives imported modules the bundle's import.meta.url. Only the chosen
// entry may start a backend; importing this server from native-window must not
// start a second service or write a launch record into MCP stdio.
const localWebEntry = typeof __PAPER_ENTRY_KIND__ === 'string' ? __PAPER_ENTRY_KIND__ === 'local-web' : process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (localWebEntry) main().catch(e => { process.stderr.write(`${e.code || 'START_FAILED'}: local preview failed\n`); process.exitCode = 1; });
