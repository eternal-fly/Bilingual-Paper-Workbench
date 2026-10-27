import { languageNames } from './languages.mjs';
import { configuredDesktopExecution } from './desktop-execution.mjs';

const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
const node = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; };
const active = status => ['queued', 'running'].includes(status);
const resumable = status => ['paused', 'cancelled', 'delivery-failed', 'blocked'].includes(status);

/** Desktop owns inference. This controller only starts explicitly chosen tasks
 * and displays persisted progress; it never starts a model worker or copies a prompt. */
export function initializeDesktopTranslation({ api, getState, getSources, getLanguage, getInterfaceLanguage = () => document.documentElement.lang || 'en', getSelection = () => [], refreshState = async () => {}, beforeStart = async () => {}, notify = () => {} }) {
  const copy = (en, zh) => getInterfaceLanguage().startsWith('zh') ? zh : en;
  let launch = document.getElementById('translate-paper');
  if (!launch) { launch = node('button', 'text-button'); launch.id = 'translate-paper'; launch.type = 'button'; (document.querySelector('.translation-tools') || document.getElementById('translation-panel')).prepend(launch); }
  const progress = node('section', 'desktop-translation-progress'); progress.id = 'desktop-translation-progress'; progress.hidden = true; progress.setAttribute('aria-label', 'Translation progress');
  const status = node('p', 'desktop-translation-status'); status.id = 'desktop-translation-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const meter = node('progress'); meter.id = 'desktop-translation-meter'; meter.max = 1; meter.value = 0;
  const controls = node('div', 'desktop-translation-actions'), show = node('button', 'text-button'), cancel = node('button', 'text-button'), resume = node('button', 'text-button');
  for (const item of [show, cancel, resume]) item.type = 'button'; show.id = 'desktop-translation-details'; cancel.id = 'desktop-translation-cancel'; resume.id = 'desktop-translation-resume'; controls.append(show, cancel, resume);
  const taskError = node('p', 'helper'); taskError.id = 'desktop-translation-task-error'; taskError.hidden = true;
  progress.append(status, meter, controls, taskError); document.getElementById('work-area').before(progress);
  const dialog = node('dialog', 'desktop-translation-dialog'); dialog.id = 'desktop-translation-dialog'; dialog.setAttribute('aria-labelledby', 'desktop-translation-title');
  const form = node('form'), heading = node('div', 'dialog-heading'), titleGroup = node('div'), title = node('h2'), subtitle = node('p'), close = node('button', 'text-button'); title.id = 'desktop-translation-title'; close.id = 'desktop-translation-close'; close.type = 'button'; titleGroup.append(title, subtitle); heading.append(titleGroup, close);
  const identity = node('p', 'desktop-translation-identity'); identity.id = 'desktop-translation-identity';
  const scopeLabel = node('label', 'field'), scopeCopy = node('span'), scope = node('select'); scope.id = 'desktop-translation-scope'; scope.append(new Option('', 'all'), new Option('', 'selected')); scopeLabel.append(scopeCopy, scope);
  const rangeGroup = node('div', 'desktop-translation-range-group'), rangeLabel = node('label', 'field'), rangeCopy = node('span'), range = node('input'); range.id = 'desktop-translation-range'; range.type = 'text'; range.inputMode = 'text'; range.autocomplete = 'off'; range.spellcheck = false; range.placeholder = '1-3, 7, 10-20'; range.setAttribute('aria-describedby', 'desktop-translation-range-help desktop-translation-error'); rangeLabel.append(rangeCopy, range);
  const rangeHelp = node('p', 'helper'), useSelection = node('button', 'text-button'); rangeHelp.id = 'desktop-translation-range-help'; useSelection.id = 'desktop-translation-use-selection'; useSelection.type = 'button'; rangeGroup.append(rangeLabel, rangeHelp, useSelection);
  const scopeNote = node('p', 'permission-note'); scopeNote.id = 'desktop-translation-scope-note'; scopeNote.setAttribute('role', 'status');
  const promptLabel = node('label', 'field'), promptCopy = node('span'), prompt = node('textarea'); prompt.id = 'desktop-translation-prompt'; prompt.rows = 3; prompt.maxLength = 8000; promptLabel.append(promptCopy, prompt);
  const error = node('p', 'inline-error'); error.id = 'desktop-translation-error'; error.hidden = true; error.setAttribute('role', 'alert');
  const actions = node('div', 'dialog-actions'), start = node('button', 'button primary'); start.id = 'desktop-translation-start'; start.type = 'submit'; actions.append(start); form.append(heading, identity, scopeLabel, rangeGroup, scopeNote, promptLabel, error, actions); dialog.append(form); document.body.append(dialog);
  let captured = null, working = false, returnFocus = null, optimistic = null, destroyed = false, submissionError = null;
  const paperKey = () => JSON.stringify([getState().project?.id, getState().project?.snapshotId]);
  const configuredExecution = () => configuredDesktopExecution(getState());
  const execution = () => configuredExecution()?.available === true ? configuredExecution() : null;
  const sources = () => (getSources?.() || getState().readingParagraphs || getState().segments || []).map((source, index) => ({ ...source, paragraphNumber: index + 1 }));
  const eligible = source => source.translatable === true && source.requestable !== false && validId(source.id);
  function rangeFromIds(ids) {
    const wanted = new Set(ids), numbers = sources().filter(source => wanted.has(source.id)).map(source => source.paragraphNumber), groups = [];
    for (const value of numbers) { const previous = groups.at(-1); if (previous && previous[1] + 1 === value) previous[1] = value; else groups.push([value, value]); }
    return groups.map(([first, last]) => first === last ? String(first) : `${first}-${last}`).join(', ');
  }
  function selection() {
    const all = sources();
    if (scope.value === 'all') return all.filter(eligible).map(source => source.id);
    if (!range.value.trim()) throw new Error(copy('Enter paragraph numbers or use the current selection.', '请输入段落编号，或使用当前选段。'));
    if (range.value.length > 20000) throw new Error(copy('The paragraph range is too long.', '段落范围过长。'));
    const selected = new Set();
    for (const item of range.value.split(/[,，;；]/u)) {
      const match = /^\s*(\d+)(?:\s*[-–]\s*(\d+))?\s*$/u.exec(item);
      const first = Number(match?.[1]), last = Number(match?.[2] || match?.[1]);
      if (!match || !Number.isSafeInteger(first) || first < 1 || last < first || last > all.length) throw new Error(copy('Use valid paragraph ranges, for example 1-3, 7, 10-20.', '请输入有效的段落范围，例如 1-3, 7, 10-20。'));
      for (let index = first; index <= last; index++) {
        if (!eligible(all[index - 1])) throw new Error(copy(`Paragraph ${index} is a protected structure and cannot be translated.`, `段落 ${index} 是受保护的结构，无需翻译。`));
        selected.add(all[index - 1].id);
      }
    }
    return all.filter(source => selected.has(source.id)).map(source => source.id);
  }
  function currentTask() {
    const state = getState(), list = [...(Array.isArray(state.translationTasks) ? state.translationTasks : state.translationTasks?.tasks || [])];
    if (optimistic && !list.some(item => item.taskId === optimistic.taskId)) list.push(optimistic);
    else if (optimistic) optimistic = null;
    return list.filter(item => item.projectId === state.project?.id && validId(item.taskId)).at(-1) || null;
  }
  function updateOwnedNotice() {
    const notice = document.getElementById('notice'), taskId = notice?.dataset.desktopTranslationTask;
    if (!taskId || notice.hidden || notice.classList.contains('error')) return;
    const tasks = getState().translationTasks, task = (Array.isArray(tasks) ? tasks : tasks?.tasks || []).find(item => item.taskId === taskId && item.projectId === getState().project?.id);
    if (task) notice.textContent = taskLabel(task);
  }
  function taskLabel(task) {
    const text = { queued: ['Queued · Waiting for Desktop', '已排队 · 等待桌面端'], running: ['Translating in Desktop', '桌面端正在翻译'], completed: ['Translation complete', '翻译已完成'], paused: ['Paused · Review before resuming', '已暂停 · 确认后可继续'], cancelled: ['Cancelled · Completed paragraphs retained', '已取消 · 保留已完成段落'], 'delivery-failed': ['Blocked · Delivery failed', '已阻止 · 请求投递失败'], blocked: ['Blocked · Action required', '已阻止 · 需要处理'] }[task.status] || ['Waiting for Desktop', '等待桌面端'];
    return `${copy(...text)} · ${Number(task.completed) || 0} / ${Number(task.total) || 0} · ${languageNames[task.language] || task.language || ''}`;
  }
  function showError(problem) { error.textContent = problem?.message || String(problem); error.hidden = false; }
  async function refreshAfterSubmission() { try { await refreshState(); } catch {} }
  function render() {
    if (destroyed) return;
    const state = getState(), route = execution(), task = currentTask();
    updateOwnedNotice();
    launch.textContent = copy('Translate paper', '翻译全文'); launch.disabled = !state.project || !route || working; launch.title = route ? copy('Translate the entire paper or an exact paragraph range in Desktop', '由桌面端翻译全文或指定段落范围') : state.desktopExecution?.reason || copy('Open this paper from a verified Desktop chat to translate.', '从已核验的桌面端聊天打开论文后可翻译。');
    title.textContent = copy('Translate with Desktop', '桌面端翻译'); subtitle.textContent = copy('Desktop runs the model. Validated translations return to the matching paragraphs.', '桌面端运行模型，校验后的译文回填对应段落。'); close.textContent = copy('Close', '关闭'); close.setAttribute('aria-label', copy('Close translation task', '关闭翻译任务'));
    scopeCopy.textContent = copy('Translation scope', '翻译范围'); scope.options[0].textContent = copy('Entire paper', '全文'); scope.options[1].textContent = copy('Selected paragraph numbers', '指定段落编号'); scope.setAttribute('aria-label', scopeCopy.textContent);
    rangeCopy.textContent = copy('Paragraph numbers', '段落编号'); rangeHelp.textContent = copy('Use the numbers shown in the paper. Ranges may contain any number of translatable paragraphs.', '按论文中的段落编号选择；可包含任意数量的可翻译段落。'); useSelection.textContent = copy('Use current selection', '使用当前选段'); useSelection.disabled = working || !getSelection().length;
    promptCopy.textContent = copy('Translation instructions (optional)', '翻译要求（可选）');
    identity.textContent = route ? `${route.title || route.threadId} · ${copy('Last verified model', '最近核验模型')}: ${route.model || ''}${route.effort ? ` · ${route.effort}` : ''} · ${copy('Model runs in Desktop', '模型在桌面端运行')}` : state.desktopExecution?.reason || copy('This Desktop chat is unavailable.', '当前桌面端聊天暂不可用。');
    rangeGroup.hidden = scope.value !== 'selected';
    let ids = [], selectionError = null;
    try { ids = selection(); } catch (problem) { selectionError = problem; }
    const changed = captured !== null && captured !== paperKey();
    if (changed) selectionError = new Error(copy('The paper or source version changed. Close and reopen this translation task.', '论文或源版本已改变，请关闭后重新打开翻译任务。'));
    if (dialog.open && (selectionError || submissionError)) showError(selectionError || submissionError); else if (dialog.open && !working) error.hidden = true;
    const target = languageNames[getLanguage()] || getLanguage();
    scopeNote.textContent = copy(`${ids.length} paragraphs → ${target}. Formulas, citations and source files remain protected.`, `${ids.length} 段 → ${target}。公式、引用和源文件保持受保护。`);
    start.textContent = working ? copy('Submitting…', '正在提交…') : copy(scope.value === 'all' ? 'Translate entire paper' : 'Translate selected paragraphs', scope.value === 'all' ? '翻译全文' : '翻译所选段落'); start.disabled = working || !route || !state.project || changed || !ids.length || Boolean(selectionError);
    scope.disabled = working; range.disabled = working; prompt.disabled = working;
    progress.hidden = !task;
    if (task) {
      status.textContent = taskLabel(task); meter.max = Math.max(1, Number(task.total) || 1); meter.value = Math.max(0, Number(task.completed) || 0); meter.setAttribute('aria-label', status.textContent);
      taskError.hidden = !task.error?.message; taskError.textContent = task.error?.message || '';
      cancel.hidden = !active(task.status); resume.hidden = !resumable(task.status) || Number(task.remaining) === 0; cancel.disabled = working; resume.disabled = working || !route;
    }
    show.textContent = copy('New translation', '新建翻译'); cancel.textContent = copy('Cancel remaining', '取消剩余'); resume.textContent = copy('Resume remaining', '继续剩余');
    progress.setAttribute('aria-label', copy('Translation progress', '翻译进度'));
  }
  function open({ scope: requestedScope = 'all', sourceSegmentIds } = {}) {
    if (!getState().project || working) return false;
    returnFocus = document.activeElement; captured = paperKey(); scope.value = requestedScope === 'selected' ? 'selected' : 'all'; range.value = rangeFromIds(sourceSegmentIds || getSelection()); prompt.value = ''; submissionError = null; error.hidden = true;
    render(); if (!dialog.open) dialog.showModal(); render(); queueMicrotask(() => (scope.value === 'selected' ? range : start).focus()); return true;
  }
  async function act(action) {
    const task = currentTask(); if (working || !task || action === 'resumeTranslationTask' && !execution()) return;
    working = true; render();
    try { const result = await api(action, { taskId: task.taskId }); if (result?.taskId) optimistic = result; await refreshAfterSubmission(); }
    catch (problem) { await refreshAfterSubmission(); notify(problem?.message || String(problem), true, true); }
    finally { working = false; render(); }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (working || start.disabled) return;
    const route = execution(), ids = selection(), state = getState(); if (!route || captured !== paperKey()) return;
    const intent = { scope: scope.value, ...(scope.value === 'selected' ? { sourceSegmentIds: ids } : {}), language: getLanguage(), ...(prompt.value.trim() ? { prompt: prompt.value } : {}), expectedProjectId: state.project.id, expectedSnapshotId: state.project.snapshotId };
    working = true; submissionError = null; error.hidden = true; render();
    try {
      await beforeStart(); if (captured !== paperKey() || execution()?.threadId !== route.threadId) throw new Error(copy('The paper or Desktop chat changed. Reopen this task.', '论文或桌面端聊天已改变，请重新打开任务。'));
      const result = await api('startTranslationTask', intent); if (result?.taskId) optimistic = result;
      await refreshAfterSubmission(); dialog.close(); notify(copy('Translation queued in the bound Desktop chat.', '翻译已进入绑定的桌面端聊天队列。'), false, true);
      const notice = document.getElementById('notice'); if (notice && result?.taskId) notice.dataset.desktopTranslationTask = result.taskId;
    } catch (problem) { submissionError = problem; await refreshAfterSubmission(); showError(problem); }
    finally { working = false; render(); }
  });
  launch.addEventListener('click', () => open({ scope: 'all' })); show.addEventListener('click', () => open({ scope: 'all' })); close.addEventListener('click', () => dialog.close()); dialog.addEventListener('close', () => { const target = returnFocus?.isConnected ? returnFocus : launch; target.focus({ preventScroll: true }); });
  for (const input of [scope, range]) input.addEventListener(input === scope ? 'change' : 'input', () => { submissionError = null; render(); });
  useSelection.addEventListener('click', () => { scope.value = 'selected'; range.value = rangeFromIds(getSelection()); render(); });
  cancel.addEventListener('click', () => void act('cancelTranslationTask')); resume.addEventListener('click', () => void act('resumeTranslationTask'));
  render();
  return { adopt: render, open, handles: () => Boolean(configuredExecution()), destroy() { destroyed = true; progress.remove(); dialog.remove(); } };
}
