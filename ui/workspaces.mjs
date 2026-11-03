import { switchWorkbenchRecord } from './project-switcher.mjs';

const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = String(text); return value; };
const projectKey = state => state?.workspaceIndex?.currentRecordId || state?.project?.id || null;
const identity = state => ({ currentRecordId: state?.workspaceIndex?.currentRecordId || null, projectId: state?.project?.id || null, snapshotId: state?.project?.snapshotId || null });
const recordIdentity = record => JSON.stringify(['recordId', 'projectRoot', 'mainFile', 'hostTaskId', 'hostProjectId', 'hostProjectRoot', 'paperTitle', 'boundChatTitle', 'model', 'effort'].map(key => record?.[key] ?? null).concat(record?.threadId ?? record?.workerThreadId ?? null));
const blockingWritebackPhases = new Set(['preparing', 'waiting-model', 'compiling', 'applying', 'awaiting-editor', 'recovery-required']);
const active = state => Boolean(state?.chat?.busy || (state?.jobs || []).some(job => ['queued', 'running', 'compiling', 'cancelling', 'inProgress'].includes(job.status)) || state?.project?.id && state?.oneClickWritebacks?.tasks?.some(task => task.projectId === state.project.id && blockingWritebackPhases.has(task.status)));

/** Record choices are explicit UI actions; opening history never calls a model. */
export function initializeWorkspaces({ api, getState, flushDrafts, adopt, notify, withSwitch = work => work(), onMainCandidates = () => {}, onRender = () => {} }) {
  const text = (en, zh) => document.documentElement.lang?.startsWith('zh') ? zh : en;
  const trigger = document.getElementById('workspace-history');
  const dialog = node('dialog', 'workspace-dialog'); dialog.id = 'workspace-history-dialog'; dialog.setAttribute('aria-labelledby', 'workspace-history-title');
  const heading = node('div', 'dialog-heading'), titleGroup = node('div'), title = node('h2'), description = node('p'); title.id = 'workspace-history-title'; titleGroup.append(title, description);
  const close = node('button', 'text-button'); close.type = 'button'; close.addEventListener('click', () => dialog.close()); heading.append(titleGroup, close);
  const context = node('p', 'workspace-context helper'); context.id = 'workspace-history-context';
  const status = node('p', 'helper'); status.id = 'workspace-history-status'; status.setAttribute('role', 'status');
  const error = node('p', 'inline-error'); error.id = 'workspace-history-error'; error.setAttribute('role', 'alert'); error.hidden = true;
  const filter = node('label', 'check-control'), deletedFilter = node('input'), filterText = node('span'); deletedFilter.type = 'checkbox'; deletedFilter.id = 'workspace-history-deleted'; filter.append(deletedFilter, filterText);
  const list = node('div', 'workspace-record-list'); list.id = 'workspace-record-list';
  const actions = node('div', 'dialog-actions'), retry = node('button', 'button'); retry.id = 'workspace-bootstrap'; retry.type = 'button';
  const refresh = node('button', 'button'); refresh.id = 'workspace-history-refresh'; refresh.type = 'button'; actions.append(retry, refresh);
  dialog.append(heading, context, status, error, filter, list, actions); document.body.append(dialog);

  const confirmation = node('dialog', 'workspace-dialog'); confirmation.id = 'workspace-delete-dialog'; confirmation.setAttribute('aria-labelledby', 'workspace-delete-title'); confirmation.setAttribute('aria-describedby', 'workspace-delete-description workspace-delete-target');
  const confirmHeading = node('h2'); confirmHeading.id = 'workspace-delete-title';
  const confirmDescription = node('p', 'permission-note'); confirmDescription.id = 'workspace-delete-description';
  const confirmTarget = node('p', 'workspace-context'); confirmTarget.id = 'workspace-delete-target';
  const confirmError = node('p', 'inline-error'); confirmError.id = 'workspace-delete-error'; confirmError.setAttribute('role', 'alert'); confirmError.hidden = true;
  const confirmActions = node('div', 'dialog-actions'), cancel = node('button', 'button'), confirm = node('button', 'button danger'); cancel.id = 'workspace-delete-cancel'; confirm.id = 'workspace-delete-confirm'; cancel.type = confirm.type = 'button'; confirmActions.append(cancel, confirm);
  confirmation.append(confirmHeading, confirmTarget, confirmDescription, confirmError, confirmActions); document.body.append(confirmation);
  let records = [], metadata = null, loading = false, switching = false, project = projectKey(getState()), pendingDelete = null;
  const displayError = (problem, target = error) => { target.textContent = [problem.code, problem.message || String(problem)].filter(Boolean).join(': '); target.hidden = false; };
  const setBusy = busy => { loading = busy; trigger.disabled = switching; close.disabled = switching; deletedFilter.disabled = busy || switching; refresh.disabled = busy || switching; retry.disabled = busy || switching || active(getState()); for (const button of list.querySelectorAll('button')) button.disabled = busy || switching || active(getState()) || button.dataset.unavailable === 'true'; cancel.disabled = confirm.disabled = switching; };
  function render() {
    const state = getState(), index = metadata || state.workspaceIndex || {}, host = index.hostContext || {}, bootstrap = index.bootstrap || {};
    title.textContent = text('Paper tasks & history', '论文任务与历史'); description.textContent = text('Keep project bindings, translations, and revision records with their task.', '按聊天任务保存项目绑定、译稿和修订记录。'); close.textContent = text('Close', '关闭'); close.setAttribute('aria-label', text('Close paper task history', '关闭论文任务历史'));
    retry.textContent = text('Use current chat project', '使用当前聊天项目'); refresh.textContent = text('Refresh history', '刷新记录'); filterText.textContent = text('Deleted tasks', '已删除的任务');
    context.textContent = host.projectRoot ? `${text('Current chat directory', '当前聊天目录')}: ${host.projectRoot}${host.hostTaskId ? ` · ${text('Task', '任务')} ${host.hostTaskId}` : ''}` : text('The current chat project directory is unconfirmed. Retry its binding or choose a main file in Project.', '当前聊天的项目目录尚未确认。可重新读取宿主绑定，或在“项目”中明确选择主文件。');
    if (host.native && !host.taskIdAvailable) context.textContent += text(' The host did not supply a chat ID; records use project and main-file identity.', ' 宿主未提供聊天标识，当前按项目与主文件保存记录。');
    const fragment = document.createDocumentFragment();
    for (const record of records) {
      const item = node('article', 'workspace-record'); item.dataset.recordId = record.recordId;
      const row = node('div', 'workspace-record-heading'), label = node('h3', '', record.paperTitle || record.mainFile || record.rootLabel || text('Untitled paper', '未命名论文')); row.append(label);
      const current = record.recordId === (index.currentRecordId || state.workspaceIndex?.currentRecordId);
      if (current) row.append(node('span', 'workspace-current', text('Current task', '当前任务')));
      item.append(row, node('p', 'workspace-path mono', record.projectRoot || ''), node('p', 'helper', record.hostTaskTitle || record.taskTitle || (record.hostTaskId ? `${text('Chat task', '聊天任务')} ${record.hostTaskId}` : record.legacy ? text('Existing paper record', '既有论文记录') : text('Project paper record', '项目论文记录'))));
      const details = [record.model, record.lastOpenedAt ? `${text('Last opened', '上次打开')} ${new Date(record.lastOpenedAt).toLocaleString()}` : ''].filter(Boolean).join(' · ');
      if (details) item.append(node('p', 'helper', details));
      if (record.deletedAt) {
        item.append(node('p', 'helper', `${text('Deleted', '已删除')} ${new Date(record.deletedAt).toLocaleString()}`));
        const restore = node('button', 'button workspace-restore', text('Restore task', '恢复任务')); restore.type = 'button'; restore.addEventListener('click', () => restoreRecord(record)); item.append(restore);
      } else {
        const open = node('button', 'button workspace-open', current ? text('Reopen this task', '重新打开此任务') : text('Open paper task', '打开此论文任务')); open.type = 'button'; open.dataset.recordId = record.recordId; open.dataset.unavailable = String(record.available === false); open.addEventListener('click', () => switchRecord(record)); item.append(open);
        const remove = node('button', 'button workspace-delete', text('Delete task', '删除任务')); remove.type = 'button'; remove.setAttribute('aria-label', `${text('Delete task', '删除任务')}: ${record.paperTitle || record.mainFile || record.recordId}`); remove.addEventListener('click', () => requestDelete(record)); item.append(remove);
        if (record.available === false) item.append(node('p', 'helper', text('The project path is unavailable; its saved record is retained.', '项目路径暂不可用，记录仍保留。')));
      }
      fragment.append(item);
    }
    if (!records.length) fragment.append(node('p', 'empty', deletedFilter.checked ? text('No deleted paper tasks.', '没有已删除的论文任务。') : text('No earlier paper tasks. Opening a paper creates a local project and revision index.', '暂无以往论文任务。首次打开后，项目与修订索引会保存在本机。')));
    list.replaceChildren(fragment);
    if (active(state)) status.textContent = text('Current work is running. Finish or stop it before changing tasks.', '当前任务正在运行。完成或停止后再切换项目，译稿内容保持在当前任务中。');
    else if (bootstrap.status === 'main-file-required') status.textContent = text('Choose the manuscript main file in Project.', '当前目录有多个主文件，请在“项目”中选择要编辑的论文。');
    else status.textContent = records.length ? text(`${records.length} saved tasks. Current drafts are saved before task changes; a failed save keeps your editor.`, `已保存 ${records.length} 个论文任务。切换前会先保存当前译稿；保存失败时保留当前编辑。`) : '';
    setBusy(loading); onRender();
  }
  async function load() {
    if (loading || switching) return;
    error.hidden = true; status.textContent = text('Loading the local task index…', '正在读取本机任务索引…'); setBusy(true);
    try { await loadAfterSwitch(); } catch (problem) { displayError(problem); } finally { loading = false; render(); }
  }
  async function loadAfterSwitch() { const result = await api('listWorkspaces', deletedFilter.checked ? { deleted: 'deleted' } : {}); if (!Array.isArray(result?.records)) throw new Error(text('The backend did not return valid task records.', '后台未返回有效的任务记录。')); records = result.records; metadata = result; }
  async function switchRecord(record) {
    if (switching || active(getState())) return;
    const captured = projectKey(getState()); error.hidden = true; switching = true; setBusy(true);
    try {
      await withSwitch(async () => {
        await flushDrafts(); if (captured !== projectKey(getState())) throw new Error(text('The current task changed. Select its history record again.', '当前任务已改变，请重新选择历史记录。'));
        if (getState().capabilities?.projectSwitch === true) { await switchWorkbenchRecord({ api, recordId: record.recordId, adopt }); dialog.close(); return; }
        const result = await api('openWorkspaceRecord', { recordId: record.recordId }), next = result?.state || result;
        if (!next || !Array.isArray(next.segments)) throw new Error(text('The selected task was not returned. Your current editor is retained.', '后台尚未返回所选论文任务，当前编辑仍保留。'));
        adopt(next); dialog.close(); notify(text(`Opened ${record.mainFile || 'paper task'} with its saved project and records.`, `已打开 ${record.mainFile || '论文任务'}，使用该任务保存的项目与记录。`));
      });
    } catch (problem) { displayError(problem); } finally { switching = false; loading = false; render(); }
  }
  function requestDelete(record) {
    if (switching || loading || active(getState())) return;
    pendingDelete = { record, identity: identity(getState()) }; confirmError.hidden = true;
    confirmHeading.textContent = text('Delete this paper task?', '删除此论文任务？'); confirmTarget.textContent = `${record.paperTitle || record.mainFile || record.recordId}\n${record.projectRoot || ''}`;
    confirmDescription.textContent = text('This hides the task from history. Original files, drafts, reviews, and chat history stay on this computer. Restore it from Deleted tasks. Current edits must save successfully first.', '此操作将任务从历史中隐藏。原始文件、译稿、审稿记录和聊天历史仍保留在本机，可从“已删除的任务”恢复。当前编辑须先保存成功。');
    cancel.textContent = text('Cancel', '取消'); confirm.textContent = text('Delete task', '删除任务'); confirmation.showModal(); cancel.focus();
  }
  async function deleteRecord() {
    if (!pendingDelete || switching || active(getState())) return;
    const pending = pendingDelete; switching = true; setBusy(true); confirmError.hidden = true;
    try {
      await withSwitch(async () => {
        await flushDrafts();
        if (JSON.stringify(identity(getState())) !== JSON.stringify(pending.identity)) throw new Error(text('The current paper changed. Reopen the task confirmation.', '当前论文已改变，请重新确认要删除的任务。'));
        // Saving may persist an unchanged binding with a newer metadata
        // revision. Refresh only this exact record and retain the confirmation
        // if any paper/chat identity, title, model, or effort actually changed.
        const freshIndex = await api('listWorkspaces'), fresh = freshIndex?.records?.find(record => record.recordId === pending.record.recordId);
        if (!fresh || fresh.deletedAt || recordIdentity(fresh) !== recordIdentity(pending.record) || JSON.stringify(identity(getState())) !== JSON.stringify(pending.identity)) throw new Error(text('The saved paper or chat binding changed. Refresh history and review the task again.', '论文或聊天绑定已改变，请刷新历史并重新确认任务。'));
        const result = await api('deleteWorkspaceRecord', { recordId: fresh.recordId, expectedRevision: fresh.revision || 0, ...pending.identity });
        const next = result?.state || result; if (!Array.isArray(next?.segments)) throw new Error(text('The backend did not confirm the task change. Refresh history.', '后台未确认任务变化，请刷新历史。'));
        adopt(next); confirmation.close(); pendingDelete = null; await loadAfterSwitch();
        notify(text('Task deleted. Its files and history are retained; restore it from Deleted tasks.', '任务已删除，文件和历史仍保留，可从“已删除的任务”恢复。'));
      });
    } catch (problem) { displayError(problem, confirmation.open ? confirmError : error); } finally { switching = false; loading = false; render(); }
  }
  async function restoreRecord(record) {
    if (switching || loading || active(getState())) return;
    switching = true; setBusy(true); error.hidden = true;
    try { const result = await api('restoreWorkspaceRecord', { recordId: record.recordId, expectedRevision: record.revision || 0 }); if (Array.isArray(result?.state?.segments)) adopt(result.state); await loadAfterSwitch(); notify(text('Task restored. Open it to continue with its saved files and chat binding.', '任务已恢复，打开后可继续使用其保存的文件和聊天绑定。')); }
    catch (problem) { displayError(problem); } finally { switching = false; loading = false; render(); }
  }
  async function bootstrap() {
    if (switching || active(getState())) return;
    error.hidden = true; switching = true; setBusy(true);
    try {
      await withSwitch(async () => {
        await flushDrafts(); const result = await api('bootstrapHostProject', {}), next = result?.state || result;
        if (Array.isArray(next?.segments)) adopt(next);
        const bootstrap = result?.bootstrap || next?.workspaceIndex?.bootstrap;
        if (bootstrap?.status === 'main-file-required') { dialog.close(); onMainCandidates(bootstrap); } else await loadAfterSwitch();
      });
    } catch (problem) { displayError(problem); } finally { switching = false; loading = false; render(); }
  }
  cancel.addEventListener('click', () => { if (!switching) { pendingDelete = null; confirmation.close(); } }); confirm.addEventListener('click', deleteRecord);
  confirmation.addEventListener('cancel', event => { if (switching) event.preventDefault(); else pendingDelete = null; }); dialog.addEventListener('cancel', event => { if (switching) event.preventDefault(); });
  trigger.addEventListener('click', () => { dialog.showModal(); load(); }); refresh.addEventListener('click', load); retry.addEventListener('click', bootstrap); deletedFilter.addEventListener('change', load);
  return { adopt(state) { const next = projectKey(state); if (next !== project) { project = next; metadata = null; } if (dialog.open) render(); }, show() { dialog.showModal(); return load(); }, destroy() { dialog.remove(); confirmation.remove(); } };
}
