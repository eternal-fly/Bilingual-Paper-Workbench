const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = String(text); return value; };
const projectKey = state => state?.workspaceIndex?.currentRecordId || state?.project?.id || null;
const active = state => Boolean(state?.chat?.busy || (state?.jobs || []).some(job => ['queued', 'running', 'compiling', 'cancelling', 'inProgress'].includes(job.status)));

/** Record choices are explicit UI actions; opening history never calls a model. */
export function initializeWorkspaces({ api, getState, flushDrafts, adopt, notify, withSwitch = work => work(), onMainCandidates = () => {}, onRender = () => {} }) {
  const trigger = document.getElementById('workspace-history');
  const dialog = node('dialog', 'workspace-dialog'); dialog.id = 'workspace-history-dialog'; dialog.setAttribute('aria-labelledby', 'workspace-history-title');
  const heading = node('div', 'dialog-heading'), titleGroup = node('div'), title = node('h2', '', '论文任务与历史'); title.id = 'workspace-history-title';
  titleGroup.append(title, node('p', '', '按聊天任务保存项目绑定、译稿和修订记录。'));
  const close = node('button', 'text-button', '关闭'); close.type = 'button'; close.setAttribute('aria-label', '关闭论文任务历史'); close.addEventListener('click', () => dialog.close()); heading.append(titleGroup, close);
  const context = node('p', 'workspace-context helper'); context.id = 'workspace-history-context';
  const status = node('p', 'helper'); status.id = 'workspace-history-status'; status.setAttribute('role', 'status');
  const error = node('p', 'inline-error'); error.id = 'workspace-history-error'; error.setAttribute('role', 'alert'); error.hidden = true;
  const list = node('div', 'workspace-record-list'); list.id = 'workspace-record-list';
  const actions = node('div', 'dialog-actions'), retry = node('button', 'button', '使用当前聊天项目'); retry.id = 'workspace-bootstrap'; retry.type = 'button';
  const refresh = node('button', 'button', '刷新记录'); refresh.id = 'workspace-history-refresh'; refresh.type = 'button'; actions.append(retry, refresh);
  dialog.append(heading, context, status, error, list, actions); document.body.append(dialog);
  let records = [], metadata = null, loading = false, switching = false, project = projectKey(getState());
  const displayError = problem => { error.textContent = [problem.code, problem.message || String(problem)].filter(Boolean).join('：'); error.hidden = false; };
  const setBusy = busy => { loading = busy; trigger.disabled = switching; refresh.disabled = busy || switching; retry.disabled = busy || switching || active(getState()); for (const button of list.querySelectorAll('button')) button.disabled = busy || switching || active(getState()) || button.dataset.unavailable === 'true'; };
  function render() {
    const state = getState(), index = metadata || state.workspaceIndex || {}, host = index.hostContext || {}, bootstrap = index.bootstrap || {};
    context.textContent = host.projectRoot ? `当前聊天目录：${host.projectRoot}${host.hostTaskId ? ` · 任务 ${host.hostTaskId}` : ''}` : '当前聊天的项目目录尚未确认。可重新读取宿主绑定，或在“项目”中明确选择主文件。';
    if (host.native && !host.taskIdAvailable) context.textContent += ' 宿主未提供聊天标识，当前按项目与主文件保存记录。';
    const fragment = document.createDocumentFragment();
    for (const record of records) {
      const item = node('article', 'workspace-record'); item.dataset.recordId = record.recordId;
      const row = node('div', 'workspace-record-heading'), label = node('h3', '', record.paperTitle || record.mainFile || record.rootLabel || '未命名论文'); row.append(label);
      const current = record.recordId === (index.currentRecordId || state.workspaceIndex?.currentRecordId);
      if (current) row.append(node('span', 'workspace-current', '当前任务'));
      item.append(row, node('p', 'workspace-path mono', record.projectRoot || ''), node('p', 'helper', record.hostTaskTitle || record.taskTitle || (record.hostTaskId ? `聊天任务 ${record.hostTaskId}` : record.legacy ? '既有论文记录' : '项目论文记录')));
      const details = [record.model, record.lastOpenedAt ? `上次打开 ${new Date(record.lastOpenedAt).toLocaleString()}` : ''].filter(Boolean).join(' · ');
      if (details) item.append(node('p', 'helper', details));
      const open = node('button', 'button', current ? '重新打开此任务' : '打开此论文任务'); open.type = 'button'; open.dataset.recordId = record.recordId; open.dataset.unavailable = String(record.available === false); open.disabled = loading || switching || active(state) || record.available === false;
      open.addEventListener('click', () => switchRecord(record)); item.append(open); if (record.available === false) item.append(node('p', 'helper', '项目路径暂不可用，记录仍保留。'));
      fragment.append(item);
    }
    if (!records.length) fragment.append(node('p', 'empty', '暂无以往论文任务。首次打开后，项目与修订索引会保存在本机。'));
    list.replaceChildren(fragment);
    if (active(state)) status.textContent = '当前任务正在运行。完成或停止后再切换项目，译稿内容保持在当前任务中。';
    else if (bootstrap.status === 'main-file-required') status.textContent = '当前目录有多个主文件，请在“项目”中选择要编辑的论文。';
    else status.textContent = records.length ? `已保存 ${records.length} 个论文任务。切换前会先保存当前译稿；保存失败时保留当前编辑。` : '';
    setBusy(loading);
    onRender();
  }
  async function load() {
    if (loading || switching) return;
    error.hidden = true; status.textContent = '正在读取本机任务索引…'; setBusy(true);
    try { const result = await api('listWorkspaces'); if (!Array.isArray(result?.records)) throw new Error('后台未返回有效的任务记录。'); records = result.records; metadata = result; }
    catch (problem) { displayError(problem); }
    finally { loading = false; render(); }
  }
  async function switchRecord(record) {
    if (switching || active(getState())) { status.textContent = '请先完成或停止当前任务，再切换项目。'; return; }
    const captured = projectKey(getState()); error.hidden = true; switching = true; setBusy(true); status.textContent = '正在保存当前译稿并打开选定任务…';
    try {
      await withSwitch(async () => {
        await flushDrafts();
        if (captured !== projectKey(getState())) throw new Error('当前任务已改变，请重新选择历史记录。');
        if (getState().capabilities?.projectSwitch === true) { await switchWorkbenchRecord({ api, recordId: record.recordId, adopt }); dialog.close(); return; }
        const result = await api('openWorkspaceRecord', { recordId: record.recordId });
        const next = result?.state || result;
        if (!next || !Array.isArray(next.segments)) throw new Error('后台尚未返回所选论文任务，当前编辑仍保留。');
        adopt(next); dialog.close(); notify(`已打开 ${record.mainFile || '论文任务'}，使用该任务保存的项目与记录。`);
      });
    } catch (problem) { displayError(problem); }
    finally { switching = false; loading = false; render(); }
  }
  async function bootstrap() {
    if (switching || active(getState())) return;
    error.hidden = true; switching = true; setBusy(true);
    try {
      await withSwitch(async () => {
        await flushDrafts(); const result = await api('bootstrapHostProject', {}), next = result?.state || result;
        if (Array.isArray(next?.segments)) adopt(next);
        const bootstrap = result?.bootstrap || next?.workspaceIndex?.bootstrap;
        if (bootstrap?.status === 'main-file-required') { dialog.close(); onMainCandidates(bootstrap); }
        else { await loadAfterSwitch(); }
      });
    } catch (problem) { displayError(problem); }
    finally { switching = false; loading = false; render(); }
  }
  async function loadAfterSwitch() { const result = await api('listWorkspaces'); if (Array.isArray(result?.records)) { records = result.records; metadata = result; } }
  trigger.addEventListener('click', () => { dialog.showModal(); load(); }); refresh.addEventListener('click', load); retry.addEventListener('click', bootstrap);
  return { adopt(state) { const next = projectKey(state); if (next !== project) { project = next; metadata = null; } if (dialog.open) render(); }, show() { dialog.showModal(); return load(); }, destroy() { dialog.remove(); } };
}
import { switchWorkbenchRecord } from './project-switcher.mjs';

