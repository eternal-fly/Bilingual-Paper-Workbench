import {uiText,localizeInterface} from './languages.mjs';
import {configuredDesktopExecution} from './desktop-execution.mjs';
const node = (tag, className, text) => {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
};
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
const busy = state => state.chat?.busy || (state.jobs || []).some(job => ['queued', 'running', 'compiling', 'cancelling', 'inProgress'].includes(job.status));
const identity = state => JSON.stringify([state.workspaceIndex?.currentRecordId || state.workspaceIndex?.currentRecord?.recordId, state.project?.id, state.project?.snapshotId, (state.project?.files || []).map(file => [file.path, file.hash])]);
const savedBinding = state => {
  const value = state.nativeChatBinding;
  return value && identifier(value.threadId) && (!value.projectId || value.projectId === state.project?.id) ? value : null;
};

/** Explicit secondary ownership transfer. A working native relay stays primary;
 * this UI neither creates chats nor starts/resumes one during initialization. */
export function initializeExistingChatBinding({api, getState, getHostState = () => ({}), refreshState = async () => {}, notify = () => {}, onBusyChange = () => {},getLanguage=()=>document.documentElement.lang||'en'}) {
  const mount = document.getElementById('chat-settings') || document.getElementById('codex-panel');
  if (!mount) return {adopt() {}, destroy() {}};
  const copy=text=>uiText(text,getLanguage());
  const open = node('button', 'button', '连接已有聊天（高级）'); open.id = 'existing-chat-open'; open.type = 'button';
  const mountHint = node('p', 'helper', '需要由独立工作台继续持有一个已存在的聊天时使用；不会创建新聊天。'); mountHint.id = 'existing-chat-open-note';
  mount.append(open, mountHint);
  const dialog = node('dialog', 'source-workflow-dialog existing-chat-binding-dialog'); dialog.id = 'existing-chat-dialog'; dialog.setAttribute('aria-labelledby', 'existing-chat-title');
  const heading = node('div', 'dialog-heading'), group = node('div'), title = node('h2', '', '连接已有的 Codex 聊天'); title.id = 'existing-chat-title';
  group.append(title, node('p', '', '这是独立工作台接管已有聊天的备用方式。桌面端的聊天连接卡片可直接发送时，继续使用卡片即可。'));
  const close = node('button', 'text-button', '关闭'); close.type = 'button'; close.id = 'existing-chat-close'; close.setAttribute('aria-label', '关闭已有聊天连接'); heading.append(group, close);
  const status = node('p', 'helper'); status.id = 'existing-chat-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const error = node('p', 'inline-error'); error.id = 'existing-chat-error'; error.hidden = true; error.setAttribute('role', 'alert');
  const threadLabel = node('label', 'field', '已有聊天 ID'), thread = node('input'); thread.id = 'existing-chat-thread'; thread.type = 'text'; thread.maxLength = 128; thread.autocomplete = 'off'; thread.spellcheck = false; thread.placeholder = '输入要继续使用的现有聊天 ID'; threadLabel.append(thread);
  const modelGrid = node('div', 'chat-model-grid'), modelLabel = node('label', 'field', '模型'), model = node('input'); model.id = 'existing-chat-model'; model.type = 'text'; model.maxLength = 128; model.autocomplete = 'off'; model.spellcheck = false; model.setAttribute('list', 'existing-chat-models'); modelLabel.append(model);
  const models = node('datalist'); models.id = 'existing-chat-models';
  const effortLabel = node('label', 'field', '推理强度'), effort = node('select'); effort.id = 'existing-chat-effort'; effortLabel.append(effort); modelGrid.append(modelLabel, effortLabel);
  const modelHint = node('p', 'helper', '模型与推理强度会在连接时按本机 Codex 目录核验；不支持的选择会明确报错，不自动替换。');
  const connect = node('button', 'button primary', '明确连接此已有聊天'); connect.id = 'existing-chat-connect'; connect.type = 'button';
  const actions = node('div', 'dialog-actions'); actions.append(connect);
  const verified = node('div', 'review-import-record'); verified.id = 'existing-chat-verified'; verified.hidden = true; verified.setAttribute('role', 'status');
  dialog.append(heading, status, error, threadLabel, modelGrid, models, modelHint, actions, verified); document.body.append(dialog);
  let target = null, working = false, lastBusy = false, generation = 0, wasPrimary = false;
  const current = () => target && identity(getState()) === target.identity;
  const primaryRelay = () => getHostState()?.directChat === true||getHostState()?.relayChat===true&&getHostState()?.canSendMessage===true;
  const capability = () => getState().capabilities?.existingChatBinding === true;
  const displayError = problem => {
    const code = problem?.code || '';
    error.textContent = ['THREAD_IN_USE', 'CHAT_IN_USE'].includes(code)
      ? '该聊天仍由桌面端持有；可使用聊天连接卡片直接发送，或先在桌面端释放聊天后再连接。当前输入已保留。'
      : [code, problem?.message || String(problem)].filter(Boolean).join('：');
    error.hidden = false;
  };
  function showVerified(binding, connected = false) {
    if (!binding || !identifier(binding.threadId) || !identifier(binding.model)) { verified.hidden = true; verified.replaceChildren(); return; }
    const title = binding.threadName || binding.title || copy('已有 Codex 聊天');
    const id = node('code', '', binding.threadId), modelValue = node('code', '', binding.model);
    const idLine = node('p', 'helper', '聊天 ID：'); idLine.append(id);
    const modelLine = node('p', 'helper', '模型：'); modelLine.append(modelValue, document.createTextNode(` · ${binding.effort || copy('模型默认强度')}`));
    verified.replaceChildren(node('h3', '', `${copy(connected ? '已验证连接' : '已保存绑定')} · ${title}`), idLine, modelLine);
    verified.hidden = false;
  }
  function refresh() {
    const state = getState(), enabled = capability();
    const nativeWindow = getHostState()?.mode === 'native-window', panel = document.getElementById('codex-panel');
    const nativeMount = panel?.querySelector('.chat-heading-actions') || panel;
    if (nativeWindow && nativeMount && open.parentElement !== nativeMount) {
      if (nativeMount === panel) panel.insertBefore(open, document.getElementById('chat-settings'));
      else nativeMount.append(open);
    } else if (!nativeWindow && open.parentElement !== mount) mount.append(open);
    open.className = nativeWindow ? 'text-button' : 'button';
    open.textContent = nativeWindow ? '已有聊天接管（备用）' : '连接已有聊天（高级）';
    const desktop=Boolean(configuredDesktopExecution(state));
    open.hidden = !enabled || desktop; mountHint.hidden = !enabled || nativeWindow || desktop; if(desktop&&dialog.open)dialog.close();
    open.disabled = working || busy(state) || !state.project;
    connect.disabled = working || busy(state) || !enabled || !current() || primaryRelay() || !identifier(thread.value.trim()) || !identifier(model.value.trim()) || effort.value && !identifier(effort.value);
    for (const control of [thread, model, effort, close]) control.disabled = working;
    if (working !== lastBusy) { lastBusy = working; onBusyChange(working); }
    if (dialog.open && !current()) status.textContent = '论文或源文件版本已变化。输入保留；请关闭后针对当前论文重新打开连接。';
    else if (dialog.open && primaryRelay()) { status.textContent = '当前聊天连接卡片已可直接发送，无需重复接管。若改由独立工作台持有，请先在桌面端释放该聊天并断开卡片。'; wasPrimary = true; }
    else if (dialog.open && wasPrimary && !working) { status.textContent = '聊天连接卡片当前未接通。若桌面端已释放该聊天，可核对以下身份后明确连接。'; wasPrimary = false; }
    const defaultEffort=[...effort.options].find(option=>option.value==='');if(defaultEffort)defaultEffort.textContent=copy('模型默认');
    localizeInterface(open,getLanguage());localizeInterface(mountHint,getLanguage());localizeInterface(dialog,getLanguage());
  }
  function fillModels(state, selectedModel, selectedEffort) {
    const available = new Set();
    for (const entry of state.chat?.models || []) { const value = entry.model || entry.id; if (identifier(value)) available.add(value); }
    for (const option of document.getElementById('chat-model')?.options || []) if (identifier(option.value)) available.add(option.value);
    if (identifier(selectedModel)) available.add(selectedModel);
    models.replaceChildren(...[...available].map(value => new Option(value, value)));
    const catalog = (state.chat?.models || []).find(entry => entry.model === selectedModel || entry.id === selectedModel);
    const supported = catalog?.supportedReasoningEfforts?.map(entry => typeof entry === 'string' ? entry : entry.reasoningEffort).filter(identifier);
    const values = new Set(supported?.length ? supported : [...(document.getElementById('chat-effort')?.options || [])].map(option => option.value).filter(identifier));
    if (!values.size) for (const value of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) values.add(value);
    if (identifier(selectedEffort)) values.add(selectedEffort);
    effort.replaceChildren(new Option(copy('模型默认'), ''), ...[...values].map(value => new Option(value, value)));
    effort.value = selectedEffort || '';
  }
  open.addEventListener('click', () => {
    const state = getState(); if (open.disabled || !capability() || !state.project) return;
    const saved = savedBinding(state), trustedHost = state.workspaceIndex?.hostContext?.hostTaskId;
    thread.value = saved?.threadId || (identifier(trustedHost) ? trustedHost : '');
    model.value = saved?.model || state.chat?.model || state.preferredModel || document.getElementById('chat-model')?.value || 'gpt-6-astra';
    const selectedEffort = saved?.effort || state.chat?.effort || state.preferredEffort || document.getElementById('chat-effort')?.value || 'medium';
    fillModels(state, model.value, selectedEffort);
    target = {identity: identity(state), projectId: state.project.id, snapshotId: state.project.snapshotId}; generation++; wasPrimary = false;
    error.hidden = true; status.textContent = '请核对已有聊天 ID、模型和当前论文，再明确连接。此操作不会创建新聊天。';
    const connected = Boolean(saved && state.chat?.mode === 'bound-existing-chat' && state.chat.connected && state.chat.threadId === saved.threadId);
    showVerified(saved, connected); dialog.showModal(); refresh();
  });
  for (const input of [thread, model, effort]) input.addEventListener(input === effort ? 'change' : 'input', () => { error.hidden = true; refresh(); });
  connect.addEventListener('click', async () => {
    if (connect.disabled || !current()) return;
    const captured = target, ticket = ++generation;
    const payload = {threadId: thread.value.trim(), model: model.value.trim(), ...(effort.value ? {effort: effort.value} : {}), expectedProjectId: captured.projectId, expectedSnapshotId: captured.snapshotId};
    working = true; error.hidden = true; status.textContent = '正在核对聊天身份、模型和当前论文…'; refresh();
    try {
      const response = await api('connectExistingChat', payload);
      if (ticket !== generation || target !== captured || !dialog.open) return;
      if (!current()) throw Error('连接期间论文或源文件版本已变化，请核对当前论文后重新连接。');
      const result = response?.binding || response?.nativeChatBinding || response;
      if (!result || ![result.mode, result.kind].includes('bound-existing-chat') || result.threadId !== payload.threadId || result.model !== payload.model || payload.effort && result.effort !== payload.effort) throw Error('返回的聊天身份或模型未与明确选择一致，未显示为已连接。');
      await refreshState();
      if (!current()) throw Error('连接返回后论文版本已变化，请核对绑定状态。');
      showVerified(result, true);
      status.textContent = '已核对并连接此已有聊天。后续交互使用同一聊天身份及历史；论文源码、译稿和意见保留。';
      notify(copy('已连接指定的已有 Codex 聊天，没有创建新聊天。'));
    } catch (problem) { displayError(problem); status.textContent = '尚未完成新的连接；聊天 ID、模型和强度输入已保留。'; }
    finally { if (ticket === generation) working = false; refresh(); }
  });
  close.addEventListener('click', () => { if (!working) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (working) event.preventDefault(); });
  dialog.addEventListener('close', () => { generation++; target = null; });
  refresh();
  return {
    adopt() { refresh(); },
    destroy() { generation++; open.remove(); mountHint.remove(); dialog.remove(); }
  };
}
