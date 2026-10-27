const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = String(text); return value; };
const currentRecord = state => state?.workspaceIndex?.currentRecordId || state?.project?.id || null;
const running = state => Boolean(state?.chat?.busy || (state?.jobs || []).some(job => ['queued', 'running', 'compiling', 'cancelling', 'inProgress'].includes(job.status)) || (state?.desktopExecution?.messages || []).some(message => ['queued', 'running', 'unknown'].includes(message.status)) || (Array.isArray(state?.translationTasks) ? state.translationTasks : state?.translationTasks?.tasks || []).some(task => ['queued', 'running'].includes(task.status)));

/** A switch capability can navigate only to another authenticated local workbench. */
export function isWorkbenchSwitchUrl(value) {
  return isLocalWorkbenchUrl(value, { allowHandoff: true });
}

/** This shared UI path is also used by saved-record management in background mode. */
export async function switchWorkbenchRecord({ api, recordId, navigate = url => location.replace(url), adopt = () => {} }) {
  const result = await api('switchWorkspace', { recordId });
  if (!result || result.recordId !== recordId || ![true, false].includes(result.switched)) throw Object.assign(Error('The selected paper identity was not confirmed.'), { code: 'SWITCH_TARGET_INVALID' });
  if (result.switched) {
    if (!isWorkbenchSwitchUrl(result.navigateUrl)) throw Object.assign(Error('The selected paper did not return a valid local workbench.'), { code: 'SWITCH_TARGET_INVALID' });
    navigate(result.navigateUrl);
  } else { const next = result.state || await api('state'); if (Array.isArray(next?.segments)) adopt(next); }
  return result;
}

export function initializeProjectSwitcher({ api, getState, getLanguage = () => 'en', flushDrafts, adopt, notify, navigate, withSwitch = work => work(), onManage = () => {}, onHistory = () => {} }) {
  const trigger = document.getElementById('open-project');
  const popover = node('dialog', 'project-switcher-popover'); popover.id = 'project-switcher-popover'; popover.setAttribute('aria-labelledby', 'project-switcher-title');
  const heading = node('div', 'project-switcher-heading'), title = node('h2'); title.id = 'project-switcher-title';
  const closeButton = node('button', 'text-button'); closeButton.type = 'button'; closeButton.id = 'project-switcher-close'; heading.append(title, closeButton);
  const searchLabel = node('label', 'project-switcher-search-label'), searchText = node('span', 'sr-only'), search = node('input'); search.id = 'project-switcher-search'; search.type = 'search'; search.autocomplete = 'off'; searchLabel.append(searchText, search);
  const status = node('p', 'helper project-switcher-status'); status.id = 'project-switcher-status'; status.setAttribute('role', 'status');
  const error = node('p', 'inline-error'); error.id = 'project-switcher-error'; error.setAttribute('role', 'alert'); error.hidden = true;
  const list = node('div', 'project-switcher-list'); list.id = 'project-switcher-list';
  const footer = node('div', 'project-switcher-footer'), manage = node('button', 'button'), history = node('button', 'text-button'); manage.type = history.type = 'button'; manage.id = 'project-switcher-manage'; history.id = 'project-switcher-history'; footer.append(manage, history);
  popover.append(heading, searchLabel, status, error, list, footer); document.body.append(popover);
  trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', popover.id);
  let records = [], loading = false, switching = false, generation = 0, signature = '';
  const copy = (english, chinese) => getLanguage().startsWith('zh') ? chinese : english;
  const displayError = problem => { error.textContent = [problem.code, problem.message || String(problem)].filter(Boolean).join(': '); error.hidden = false; };
  function place() {
    if (!popover.open) return;
    const anchor = trigger.getBoundingClientRect(), width = Math.min(390, innerWidth - 24), height = Math.min(540, innerHeight - 24);
    popover.style.width = `${width}px`; popover.style.maxHeight = `${height}px`; popover.style.left = `${Math.max(12, Math.min(anchor.right + 8, innerWidth - width - 12))}px`; popover.style.top = `${Math.max(12, Math.min(anchor.top, innerHeight - height - 12))}px`;
  }
  function close(focus = true) { generation++; if (popover.open) popover.close(); trigger.setAttribute('aria-expanded', 'false'); if (focus) trigger.focus({ preventScroll: true }); }
  function render(force = false) {
    if (!popover.open) return;
    const state = getState(), current = currentRecord(state), busy = running(state), nextSignature = JSON.stringify([current, busy, loading, switching, getLanguage(), search.value, records]);
    if (!force && signature === nextSignature) return;
    signature = nextSignature;
    const focused = document.activeElement?.dataset?.projectRecord;
    title.textContent = copy('Paper projects', '论文项目'); closeButton.textContent = copy('Close', '关闭'); closeButton.setAttribute('aria-label', copy('Close paper projects', '关闭论文项目'));
    searchText.textContent = copy('Find a paper', '查找论文'); search.placeholder = copy('Find a paper…', '查找论文…');
    manage.textContent = copy('Open / import project', '打开／导入项目'); history.textContent = copy('Manage saved projects', '管理已保存项目'); manage.disabled = history.disabled = loading || switching || busy;
    const query = search.value.trim().toLocaleLowerCase(), visible = records.filter(record => [record.paperTitle, record.mainFile, record.rootLabel, record.boundChatTitle, record.hostTaskTitle, record.taskTitle].filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
    const fragment = document.createDocumentFragment();
    for (const record of visible) {
      const button = node('button', 'project-switcher-record'); button.type = 'button'; button.dataset.projectRecord = record.recordId; button.disabled = loading || switching || busy || record.available === false;
      const selected = record.recordId === current, row = node('span', 'project-switcher-record-title'), label = node('strong', '', record.paperTitle || record.mainFile || record.rootLabel || copy('Untitled paper', '未命名论文'));
      row.append(label); if (selected) { button.setAttribute('aria-current', 'true'); row.append(node('span', 'project-switcher-current', copy('Current', '当前'))); }
      const chat = record.boundChatTitle || record.hostTaskTitle || record.taskTitle || copy('Bound Codex chat', '已绑定 Codex 聊天');
      button.append(row, node('span', 'project-switcher-record-chat', [chat, record.model].filter(Boolean).join(' · ')), node('span', 'project-switcher-record-file', [record.mainFile, record.available === false ? copy('Project unavailable', '项目暂不可用') : ''].filter(Boolean).join(' · ')));
      button.addEventListener('click', () => select(record)); fragment.append(button);
    }
    if (!visible.length) fragment.append(node('p', 'project-switcher-empty helper', records.length ? copy('No papers match this search.', '没有匹配的论文。') : copy('No saved papers yet. Open or import your LaTeX project to begin.', '尚无已保存论文。请先打开或导入 LaTeX 项目。')));
    list.replaceChildren(fragment);
    status.textContent = switching ? copy('Saving drafts and opening the selected paper…', '正在保存草稿并打开选定论文…') : loading ? copy('Loading saved paper projects…', '正在读取已保存论文项目…') : busy ? copy('Finish or stop the current paper operation before switching.', '请先完成或停止当前论文任务，再切换项目。') : state.capabilities?.projectSwitch === true ? copy('Each paper opens its saved PDF, drafts, notes and Codex chat.', '每篇论文恢复其 PDF、译稿、意见和已绑定的 Codex 聊天。') : copy('Open saved PDFs, drafts and notes. Switch chats in the background workbench.', '恢复已保存的 PDF、译稿和意见。后台工作台支持同时切换绑定聊天。');
    if (focused) [...list.querySelectorAll('button')].find(button => button.dataset.projectRecord === focused)?.focus({ preventScroll: true });
    place();
  }
  async function load() {
    const ticket = ++generation; loading = true; error.hidden = true; render(true);
    try { const result = await api('listWorkspaces'); if (!popover.open || ticket !== generation) return; if (!Array.isArray(result?.records) || result.records.some(record => !record || typeof record.recordId !== 'string')) throw Error(copy('The saved project index is invalid.', '已保存项目索引无效。')); records = result.records; }
    catch (problem) { if (ticket === generation && popover.open) displayError(problem); }
    finally { if (ticket === generation) { loading = false; render(true); } }
  }
  async function open() {
    if (!getState().workspaceIndex) { onManage(); return; }
    if (popover.open) { close(); return; }
    search.value = ''; error.hidden = true; signature = ''; popover.show(); trigger.setAttribute('aria-expanded', 'true'); render(true); search.focus({ preventScroll: true }); await load();
  }
  async function select(record) {
    if (switching || loading || running(getState()) || record.available === false) { render(true); return; }
    if (record.recordId === currentRecord(getState())) { close(); return; }
    const captured = currentRecord(getState()); switching = true; error.hidden = true; render(true);
    try { await withSwitch(async () => {
      await flushDrafts(); if (captured !== currentRecord(getState())) throw Error(copy('The current paper changed. Select a saved project again.', '当前论文已变化，请重新选择项目。'));
      const canonical = getState().capabilities?.projectSwitch === true;
      if (canonical) await switchWorkbenchRecord({ api, recordId: record.recordId, navigate, adopt });
      else { const result = await api('openWorkspaceRecord', { recordId: record.recordId }), next = result?.state || result; if (!Array.isArray(next?.segments)) throw Error(copy('The selected saved paper was not returned.', '后台尚未返回所选论文。')); adopt(next); }
      close(false); notify(canonical ? copy('Opening the selected paper and its saved Codex chat.', '正在打开选定论文及其已保存的 Codex 聊天。') : copy('The saved paper project was opened.', '已打开所保存的论文项目。'));
    }); }
    catch (problem) { displayError(problem); }
    finally { switching = false; render(true); }
  }
  function outside(event) { if (popover.open && !popover.contains(event.target) && !trigger.contains(event.target)) close(false); }
  function outsideFocus(event) { if (popover.open && !popover.contains(event.target) && !trigger.contains(event.target)) close(false); }
  function keyboard(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.target === search && ['Home', 'End'].includes(event.key)) return;
    const buttons = [...list.querySelectorAll('button:not(:disabled)')]; if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement); let next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length;
    if (index < 0) next = event.key === 'ArrowUp' ? buttons.length - 1 : 0; event.preventDefault(); buttons[next].focus();
  }
  trigger.addEventListener('click', open); closeButton.addEventListener('click', () => close()); search.addEventListener('input', () => render(true)); popover.addEventListener('keydown', keyboard); document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outsideFocus); window.addEventListener('resize', place);
  manage.addEventListener('click', () => { if (running(getState()) || switching) return; close(false); onManage(); }); history.addEventListener('click', () => { if (running(getState()) || switching) return; close(false); onHistory(); });
  return { open, adopt() { render(); }, destroy() { generation++; trigger.removeEventListener('click', open); document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outsideFocus); window.removeEventListener('resize', place); popover.remove(); } };
}
import { isLocalWorkbenchUrl } from './local-session.mjs';

