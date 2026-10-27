const activeStatuses = new Set(['queued', 'running', 'inProgress', 'streaming', 'thinking', 'connecting', 'starting', 'cancelling']);
const syncKinds = new Set(['codex', 'translation', 'revision', 'fullReview', 'fullPaperReview', 'full-paper-review', 'paragraphReview', 'reviewCycle']);
const defaults = () => ({ revision: 0, sentenceEnd: false, englishToTranslation: false, glossary: [] });
const messageFor = error => [error?.code, error?.message || String(error)].filter(Boolean).join('：');
const sameIds = (left, right) => left.length === right.length && left.every(id => right.includes(id));
const identifier = value => typeof value === 'string' && value.length > 0;
const chinese = language => /^zh(?:-|$)/i.test(language || '');
const sentenceEnd = text => /[。！？.!?]["'”’）)\]}】》〉]*\s*$/u.test(text || '');
function preferences(value) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0) return defaults();
  return { revision: value.revision, sentenceEnd: value.sentenceEnd === true, englishToTranslation: value.englishToTranslation === true, glossary: Array.isArray(value.glossary) ? value.glossary.map(item => ({ source: item.source, target: item.target })) : [] };
}
export function parseGlossary(text) {
  if (typeof text !== 'string' || text.length > 41000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) throw new Error('术语表文字无效或超过允许长度。');
  const rows = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean), seen = new Set();
  const result = rows.map((row, index) => {
    const parts = row.split('=');
    if (parts.length !== 2) throw new Error(`第 ${index + 1} 行请使用“中文术语 = English term”，每行只保留一个等号。`);
    const [source, target] = parts.map(value => value.trim());
    if (!source || !target || source.length > 200 || target.length > 200 || seen.has(source)) throw new Error(`第 ${index + 1} 行存在空术语、重复中文术语或超过 200 字符的术语。`);
    seen.add(source); return { source, target };
  });
  if (new TextEncoder().encode(JSON.stringify(result)).length > 8192) throw new Error('完整术语表超过 8 KiB；请减少术语，当前内容未截断。');
  return result;
}
function projectIdentity(state) { return state?.workspaceIndex?.currentRecordId || state?.project?.id || state?.project?.projectId || null; }
function sourceEntries(state) {
  const rows = state?.readingParagraphs?.length ? state.readingParagraphs : state?.segments || [];
  return new Map(rows.filter(row => identifier(row.id)).map(row => [row.id, { id: row.id, hash: row.sourceHash || row.beforeHash || row.hash || '', text: row.source || row.displayText || '', writableSource: row.writableSource, requestable: row.requestable, translatable: row.translatable !== false }]));
}

/** A bounded foreground queue. It never accepts proposals or writes manuscript source. */
export function createSyncController({ api, notify = () => {}, getState, getLanguage, getSelection, getUnit, getBuffer, flushDrafts = async () => {}, refreshState = async () => {}, isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible', now = () => Date.now(), setTimer = (fn, delay) => setTimeout(fn, delay), clearTimer = id => clearTimeout(id), onChange = () => {} }) {
  let currentProject = null, prefs = defaults(), baseline = new Map(), destroyed = false, sending = false, status = '自动同步默认关闭；手动同步只生成译稿或待审英文候选。', error = false;
  const queue = new Map(), humanEdits = new Map(), compositions = new Set(), timers = new Map(), manualUnits = new Set(), sent = new Map(), observedJobs = new Map();
  let inFlight = null;
  function emit(message = status, failure = false) { status = message; error = failure; onChange({ message: status, error, queued: queue.size, sending, preferences: structuredClone(prefs) }); }
  function busy(state = getState()) { return Boolean(state?.chat?.busy) || activeStatuses.has(state?.chat?.status) || (state?.jobs || []).some(job => syncKinds.has(job.kind) && activeStatuses.has(job.status)); }
  function connected(state = getState()) { return Boolean(state?.project && state?.capabilities?.codexChat && state?.chat?.threadId && state.chat.connected !== false); }
  function activeLinks(language) { return (getState().alignments || []).filter(link => link.language === language && !link.stale && link.status !== 'stale' && (!link.snapshotId || link.snapshotId === getState().project?.snapshotId)); }
  function unitSources(unitId, language = getLanguage()) {
    const links = activeLinks(language), matched = links.filter(link => link.translationUnitIds?.includes(unitId));
    if (matched.length) return [...new Set(matched.flatMap(link => link.sourceSegmentIds || []))];
    const unit = getUnit(unitId);
    if (unit?.unitKind === 'split' || links.some(link => link.sourceSegmentIds?.includes(unitId))) return [];
    return Array.isArray(unit?.sourceSegmentIds) && unit.sourceSegmentIds.length ? [...new Set(unit.sourceSegmentIds)] : unit?.id ? [unit.id] : [];
  }
  function sourceBinding(sourceId, language) {
    const matched = activeLinks(language).filter(link => link.sourceSegmentIds?.includes(sourceId));
    return matched.length ? { sourceIds: [...new Set(matched.flatMap(link => link.sourceSegmentIds || []))], unitIds: [...new Set(matched.flatMap(link => link.translationUnitIds || []))] } : { sourceIds: [sourceId], unitIds: [sourceId] };
  }
  function clearPending() { queue.clear(); humanEdits.clear(); compositions.clear(); manualUnits.clear(); sent.clear(); observedJobs.clear(); for (const timer of timers.values()) clearTimer(timer); timers.clear(); }
  function capture(sourceIds, unitIds, direction, language, previousEnglish, automatic) {
    const sources = sourceEntries(getState()), expectedDraftRevisions = {}, draftTexts = {};
    if (!sourceIds.length || sourceIds.some(id => !sources.has(id))) throw new Error('请先选择具有明确原文身份的段落。');
    if (sourceIds.some(id => sources.get(id).translatable === false || direction === 'toTranslation' && sources.get(id).requestable === false)) throw new Error('此段含有无法安全自动转换的结构，暂不支持更新译文。');
    if (direction === 'toEnglish' && sourceIds.some(id => sources.get(id).writableSource === false || getUnit(id)?.writableSource === false)) throw new Error('此段为只读来源，不能同步为可写回的英文候选；仍可更新译文或添加意见。');
    for (const id of unitIds.length ? unitIds : sourceIds) {
      const buffer = getBuffer(id, language);
      if (!buffer || buffer.state !== 'saved' || buffer.pending || compositions.has(id)) throw new Error('译文尚未完成保存，请保留当前输入并稍后同步。');
      expectedDraftRevisions[id] = buffer.revision || 0; draftTexts[id] = buffer.text || '';
    }
    return { project: projectIdentity(getState()), sourceIds: [...sourceIds], sourceHashes: Object.fromEntries(sourceIds.map(id => [id, sources.get(id).hash])), unitIds: Object.keys(expectedDraftRevisions), direction, language, expectedDraftRevisions, draftTexts, ...(previousEnglish ? { previousEnglish } : {}), automatic, preferencesRevision: prefs.revision };
  }
  function keyFor(entry) { return `${entry.language}:${entry.direction}:${[...entry.sourceIds].sort().join('|')}`; }
  function currentEntry(entry) {
    if (entry.project !== projectIdentity(getState())) return 'stale';
    const sources = sourceEntries(getState());
    if (entry.sourceIds.some(id => !sources.has(id) || sources.get(id).hash !== entry.sourceHashes[id])) return 'stale';
    for (const id of entry.unitIds) {
      const buffer = getBuffer(id, entry.language);
      if (!buffer || compositions.has(id) || buffer.state !== 'saved' || buffer.pending) return entry.direction === 'toTranslation' ? 'stale' : 'wait';
      if ((buffer.revision || 0) !== entry.expectedDraftRevisions[id] || (buffer.text || '') !== entry.draftTexts[id]) return 'stale';
    }
    return 'ready';
  }
  async function drain() {
    if (destroyed || sending || !isVisible() || !connected() || busy()) return;
    const available = [...queue.entries()].find(([, entry]) => currentEntry(entry) !== 'wait');
    if (!available) return;
    const [key, entry] = available;
    if (currentEntry(entry) !== 'ready') { queue.delete(key); emit('源文或译稿已变化，旧的同步任务已跳过；当前输入保持不变。'); return drain(); }
    queue.delete(key); sending = true; inFlight = entry; emit(entry.direction === 'toEnglish' ? '正在提交英文候选同步…' : '正在提交译文更新…');
    try {
      const payload = { sourceSegmentIds: entry.sourceIds, direction: entry.direction, language: entry.language, expectedDraftRevisions: entry.expectedDraftRevisions, ...(entry.previousEnglish ? { previousEnglish: entry.previousEnglish } : {}) };
      const result = await api('syncParagraph', payload);
      if (!result?.jobId || !result?.requestId) throw new Error('后台未返回同步任务与请求标识。');
      sent.set(key, { entry, jobId: result.jobId });
      emit(entry.direction === 'toEnglish' ? '英文同步已进入任务队列；候选仍需修订审查。' : '译文更新已进入任务队列；返回时仍会核对草稿版本。');
      await refreshState();
      if (!entry.automatic) notify(status, false, true);
    } catch (failure) {
      if (failure?.code === 'CHAT_BUSY') { if (!queue.has(key)) queue.set(key, entry); emit('当前论文聊天正在工作，将在空闲后同步此段的最新已保存版本。'); }
      else { emit(messageFor(failure), true); notify(messageFor(failure), true, true); }
    } finally { sending = false; inFlight = null; emit(status, error); }
    if (!queue.size || busy()) return;
    // A later adopt observes the authoritative job/chat state before another send.
  }
  function enqueue(entry) { if (destroyed) return; queue.set(keyFor(entry), entry); emit(busy() ? '当前论文聊天正在工作；最新同步已排队，当前讨论不会被打断。' : '同步已排队。'); void drain().catch(failure => emit(messageFor(failure), true)); }
  function humanCandidate(unitId, generation) {
    timers.delete(unitId);
    const edit = humanEdits.get(unitId);
    if (destroyed || !prefs.sentenceEnd || !edit || edit.generation !== generation || !edit.saved || compositions.has(unitId) || edit.composing || !chinese(edit.language) || !sentenceEnd(edit.text)) return;
    const buffer = getBuffer(unitId, edit.language);
    if (!buffer || buffer.state !== 'saved' || buffer.pending || buffer.text !== edit.text || (buffer.revision || 0) !== edit.saved.revision) return;
    const token = `${edit.saved.revision}:${edit.text}`;
    if (edit.queuedToken === token) return;
    const sourceIds = unitSources(unitId, edit.language);
    if (!sourceIds.length || sourceIds.some(id => getUnit(id)?.writableSource === false)) return;
    try { const entry = capture(sourceIds, [unitId], 'toEnglish', edit.language, null, true); edit.queuedToken = token; enqueue(entry); }
    catch (failure) { emit(messageFor(failure), true); }
  }
  function onHumanInput(unitId, text, { composing = false } = {}) {
    if (destroyed) return;
    const previous = humanEdits.get(unitId); humanEdits.set(unitId, { text: String(text || ''), language: getLanguage(), at: now(), generation: (previous?.generation || 0) + 1, composing, saved: null });
    if (timers.has(unitId)) { clearTimer(timers.get(unitId)); timers.delete(unitId); }
  }
  function onComposition(unitId, composing) { if (composing) compositions.add(unitId); else compositions.delete(unitId); const edit = humanEdits.get(unitId); if (edit) edit.composing = composing; }
  function onSaved({ unitId, segmentId, language, text, revision }) {
    unitId ||= segmentId; const edit = humanEdits.get(unitId);
    if (destroyed || !edit || edit.text !== text || edit.language !== language || !Number.isSafeInteger(revision) || compositions.has(unitId) || edit.composing) return;
    edit.saved = { revision };
    for (const [key, entry] of queue) if (!entry.automatic && entry.direction === 'toEnglish' && entry.language === language && entry.unitIds.includes(unitId)) {
      try { queue.set(key, capture(entry.sourceIds, entry.unitIds, entry.direction, entry.language, entry.previousEnglish, false)); emit('已用最新保存版本更新排队的英文候选同步。'); } catch {}
    }
    if (timers.has(unitId)) { clearTimer(timers.get(unitId)); timers.delete(unitId); }
    if (manualUnits.has(unitId)) return;
    const delay = Math.max(0, 650 - (now() - edit.at));
    if (delay) timers.set(unitId, setTimer(() => humanCandidate(unitId, edit.generation), delay)); else humanCandidate(unitId, edit.generation);
  }
  function adopt(state = getState()) {
    if (destroyed) return;
    const project = projectIdentity(state);
    if (project !== currentProject) { currentProject = project; clearPending(); baseline = new Map(); prefs = defaults(); }
    const incoming = preferences(state?.syncPreferences);
    if (incoming.revision >= prefs.revision) prefs = incoming;
    for (const [key, entry] of queue) if (entry.automatic && (entry.direction === 'toEnglish' && !prefs.sentenceEnd || entry.direction === 'toTranslation' && !prefs.englishToTranslation)) queue.delete(key);
    const next = sourceEntries(state), language = getLanguage();
    if (prefs.englishToTranslation && currentProject) {
      const changedGroups = new Map();
      for (const [id, source] of next) {
        const previous = baseline.get(id);
        if (!previous?.hash || !source.hash || previous.hash === source.hash || previous.text === source.text) continue;
        const binding = sourceBinding(id, language), key = [...binding.sourceIds].sort().join('|');
        const group = changedGroups.get(key) || { ...binding, previousEnglish: {} }; group.previousEnglish[id] = previous.text; changedGroups.set(key, group);
      }
      for (const group of changedGroups.values()) {
        const buffers = group.unitIds.map(id => ({ id, buffer: getBuffer(id, language) }));
        if (buffers.some(({ id, buffer }) => !buffer || buffer.state !== 'saved' || buffer.pending || compositions.has(id))) { emit('正式英文已变化；此段对齐组中的译文正在编辑，已跳过自动更新以保留输入。'); continue; }
        if (Object.values(group.previousEnglish).some(text => text.length > 8000)) { emit('旧英文超过增量上下文限制，请明确选择此段并手动更新译文。'); continue; }
        try { enqueue(capture(group.sourceIds, group.unitIds, 'toTranslation', language, group.previousEnglish, true)); }
        catch (failure) { emit(messageFor(failure), true); }
      }
    }
    for (const { entry, jobId } of sent.values()) {
      const job = (state.jobs || []).find(item => item.jobId === jobId); if (!job) continue;
      const stamp = `${job.status}:${job.result?.status || ''}:${job.code || job.error?.code || ''}`; if (observedJobs.get(jobId) === stamp) continue; observedJobs.set(jobId, stamp);
      const stale = job.status === 'stale' || job.result?.status === 'stale' || job.code === 'RESULT_STALE' || job.error?.code === 'RESULT_STALE';
      if (stale) emit('同步答复对应旧版本，已作为历史结果保留；此次结果不会覆盖当前译稿或形成有效英文候选。');
      else if (job.status === 'completed') emit(entry.direction === 'toEnglish' ? '英文候选已返回，请到修订队列审查。' : '同步任务已完成，请核对译稿；正式源未自动改变。');
      else if (job.status === 'failed' || job.status === 'cancelled') emit('同步任务未完成，当前输入保持不变。', true);
    }
    baseline = next; emit(status, error); void drain().catch(failure => emit(messageFor(failure), true));
  }
  async function configure(fields, expectedRevision = prefs.revision, expectedProject = projectIdentity(getState())) {
    if (!expectedProject || expectedProject !== projectIdentity(getState())) throw new Error('项目已改变，请重新核对此项目的同步设置。');
    const payload = { expectedRevision };
    for (const name of ['sentenceEnd', 'englishToTranslation']) if (Object.hasOwn(fields, name)) { if (typeof fields[name] !== 'boolean') throw new Error('同步开关必须为明确的开启或关闭。'); payload[name] = fields[name]; }
    if (Object.hasOwn(fields, 'glossary')) { if (!Array.isArray(fields.glossary)) throw new Error('术语表格式无效。'); payload.glossary = parseGlossary(fields.glossary.map(item => `${item.source}=${item.target}`).join('\n')); }
    const result = await api('configureSync', payload), updated = preferences(result?.syncPreferences || result?.preferences || result);
    if (expectedProject !== projectIdentity(getState())) { await refreshState(); throw new Error('项目在设置请求期间发生变化，请重新核对当前项目。'); }
    if (updated.revision <= expectedRevision) throw new Error('后台未返回更新后的同步设置版本。');
    prefs = updated; await refreshState(); adopt(getState()); emit('同步设置已保存。关闭自动同步不会接受或应用任何英文候选。'); return structuredClone(prefs);
  }
  async function manual(direction) {
    if (!['toEnglish', 'toTranslation'].includes(direction)) throw new Error('同步方向无效。');
    if (!connected()) throw new Error('请先连接这篇论文的 Codex 聊天。');
    const selection = getSelection() || {}, sourceIds = [...new Set(selection.sourceIds || selection.sourceSegmentIds || [])], unitIds = [...new Set(selection.unitIds || selection.translationUnitIds || sourceIds)], language = getLanguage(), project = projectIdentity(getState());
    unitIds.forEach(id => { manualUnits.add(id); if (timers.has(id)) { clearTimer(timers.get(id)); timers.delete(id); } });
    try {
      await flushDrafts();
      if (project !== projectIdentity(getState())) throw new Error('项目已改变，请重新选择同步段落。');
      const entry = capture(sourceIds, unitIds, direction, language, null, false), key = keyFor(entry);
      for (const id of unitIds) { const edit = humanEdits.get(id); if (edit && edit.text === entry.draftTexts[id]) edit.queuedToken = `${entry.expectedDraftRevisions[id]}:${edit.text}`; }
      const previous = sent.get(key), sameVersion = candidate => candidate && candidate.preferencesRevision === entry.preferencesRevision && JSON.stringify(candidate.expectedDraftRevisions) === JSON.stringify(entry.expectedDraftRevisions) && JSON.stringify(candidate.sourceHashes) === JSON.stringify(entry.sourceHashes);
      if (sameVersion(inFlight) && sameIds(inFlight.sourceIds, sourceIds) && inFlight.direction === direction && inFlight.language === language || previous && sameVersion(previous.entry) && (getState().jobs || []).some(job => job.jobId === previous.jobId && activeStatuses.has(job.status))) { emit('此段的当前版本已在同步任务中，无需重复提交。'); return { queued: true }; }
      queue.delete(key); enqueue(entry); await drain(); return { queued: true };
    } finally { unitIds.forEach(id => manualUnits.delete(id)); }
  }
  return { adopt, onHumanInput, onComposition, onSaved, manual, configure, drain, getPreferences: () => structuredClone(prefs), getStatus: () => ({ message: status, error, queued: queue.size, sending }), canTranslation: () => { const selection = getSelection() || {}; const ids = selection.sourceIds || selection.sourceSegmentIds || []; return ids.length > 0 && ids.every(id => getUnit(id)?.requestable !== false && getUnit(id)?.translatable !== false); }, canEnglish: () => { const selection = getSelection() || {}; const ids = selection.sourceIds || selection.sourceSegmentIds || []; return ids.length > 0 && ids.every(id => getUnit(id)?.writableSource !== false && getUnit(id)?.translatable !== false); }, destroy() { destroyed = true; clearPending(); baseline.clear(); } };
}

function node(tag, className, text) { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; }
export function initializeSync(options) {
  const $ = id => document.getElementById(id), dialog = node('dialog'); dialog.id = 'sync-dialog'; dialog.setAttribute('aria-labelledby', 'sync-dialog-title');
  const form = node('form'), heading = node('div', 'dialog-heading'), titleGroup = node('div'), title = node('h2', '', '双向同步'); title.id = 'sync-dialog-title';
  titleGroup.append(title, node('p', '', '译文更新与英文候选分别处理，正式源仍需审查后写回。'));
  const close = node('button', 'text-button', '关闭'); close.type = 'button'; close.setAttribute('aria-label', '关闭双向同步'); close.addEventListener('click', () => dialog.close()); heading.append(titleGroup, close);
  const selection = node('p', 'permission-note'); selection.id = 'sync-selection-summary';
  const actions = node('div', 'dialog-actions'); const toEnglish = node('button', 'button primary', '译文同步为英文候选'); toEnglish.id = 'sync-to-english'; toEnglish.type = 'button'; const toTranslation = node('button', 'button', '更新译文'); toTranslation.id = 'sync-to-translation'; toTranslation.type = 'button'; actions.append(toEnglish, toTranslation);
  const optionsBox = node('div', 'sync-options'); optionsBox.style.marginTop = '20px';
  const sentenceLabel = node('label', 'acceptance-check'), sentence = node('input'); sentence.type = 'checkbox'; sentence.id = 'sync-sentence-end'; sentenceLabel.append(sentence, node('span', '', '句末将中文同步为英文候选'));
  const englishLabel = node('label', 'acceptance-check'), english = node('input'); english.type = 'checkbox'; english.id = 'sync-english-to-translation'; englishLabel.append(english, node('span', '', '正式英文变化后更新译文'));
  optionsBox.append(sentenceLabel, englishLabel, node('p', 'helper', '两个自动选项默认关闭；聊天忙碌时只排队最新已保存版本。人工输入未保存或正在使用输入法时不会发送。'));
  const glossaryField = node('label', 'field'); glossaryField.style.marginTop = '18px'; glossaryField.append(node('span', '', '本篇术语表')); const glossary = node('textarea'); glossary.id = 'sync-glossary'; glossary.rows = 5; glossary.maxLength = 41000; glossary.spellcheck = false; glossary.placeholder = '量子态 = quantum state\n量子信道 = quantum channel'; glossaryField.append(glossary, node('span', 'helper', '每行一对“中文 = English”，数量不限，完整 JSON 最多 8 KiB。保存设置后用于后续同步。'));
  const status = node('p', 'helper'); status.id = 'sync-status'; status.setAttribute('role', 'status'); const error = node('p', 'inline-error'); error.id = 'sync-error'; error.hidden = true; error.setAttribute('role', 'alert');
  const footer = node('div', 'dialog-actions'), reload = node('button', 'button', '读取已保存设置'); reload.id = 'sync-reload-settings'; reload.type = 'button'; const save = node('button', 'button primary', '保存同步设置'); save.id = 'sync-save'; save.type = 'submit'; footer.append(reload, save);
  form.append(heading, selection, actions, optionsBox, glossaryField, status, error, footer); dialog.append(form); document.body.append(dialog);
  let dirty = false, formRevision = -1, busy = false, formProject = null;
  const projectDrafts = new Map();
  const controller = createSyncController({ ...options, onChange: () => render() });
  function render() {
    const state = options.getState(), currentProject = projectIdentity(state);
    if (formProject !== currentProject) {
      if (formProject && dirty) projectDrafts.set(formProject, { sentenceEnd: sentence.checked, englishToTranslation: english.checked, glossary: glossary.value, revision: formRevision });
      formProject = currentProject;
      const savedDraft = projectDrafts.get(currentProject); dirty = Boolean(savedDraft); formRevision = savedDraft?.revision ?? -1;
      if (savedDraft) { sentence.checked = savedDraft.sentenceEnd; english.checked = savedDraft.englishToTranslation; glossary.value = savedDraft.glossary; }
      error.hidden = true;
    }
    const prefs = controller.getPreferences(), current = controller.getStatus(), chosen = options.getSelection() || {}, ids = chosen.sourceIds || chosen.sourceSegmentIds || [];
    selection.textContent = ids.length ? `已选 ${ids.length} 个明确原文段落；${options.getLanguage()} 译稿将通过版本校验后同步。` : '请先选择要同步的段落。';
    status.textContent = `${current.message}${current.queued ? ` 待发送 ${current.queued} 项。` : ''}`;
    status.classList.toggle('opaque-note', current.error);
    if (!dirty && formRevision !== prefs.revision) { formRevision = prefs.revision; sentence.checked = prefs.sentenceEnd; english.checked = prefs.englishToTranslation; glossary.value = prefs.glossary.map(item => `${item.source} = ${item.target}`).join('\n'); }
    const ready = Boolean(state?.project && state?.capabilities?.codexChat && state?.chat?.threadId && state.chat.connected !== false);
    sentence.disabled = busy; english.disabled = busy; glossary.disabled = busy; reload.disabled = busy;
    toEnglish.disabled = busy || current.sending || !ready || !ids.length || !controller.canEnglish(); toTranslation.disabled = busy || current.sending || !ready || !ids.length || !controller.canTranslation(); save.disabled = busy || !state?.project;
    toEnglish.title = controller.canEnglish() ? '生成待审英文候选，正式源不会自动改变。' : '只读来源不支持生成可写回英文候选；仍可更新译文。';
    if ($('sync-toggle')) $('sync-toggle').disabled = !state?.project;
  }
  reload.addEventListener('click', () => { if (formProject) projectDrafts.delete(formProject); dirty = false; formRevision = -1; error.hidden = true; render(); });
  form.addEventListener('input', () => { dirty = true; error.hidden = true; });
  async function runManual(direction) { busy = true; error.hidden = true; render(); try { await controller.manual(direction); } catch (failure) { error.textContent = messageFor(failure); error.hidden = false; } finally { busy = false; render(); } }
  toEnglish.addEventListener('click', () => { void runManual('toEnglish'); }); toTranslation.addEventListener('click', () => { void runManual('toTranslation'); });
  form.addEventListener('submit', async event => { event.preventDefault(); if (busy) return; busy = true; error.hidden = true; render(); try { const expectedProject = formProject; if (expectedProject !== projectIdentity(options.getState())) throw new Error('项目已改变，请重新核对设置。'); await controller.configure({ sentenceEnd: sentence.checked, englishToTranslation: english.checked, glossary: parseGlossary(glossary.value) }, formRevision, expectedProject); if (formProject === expectedProject) { projectDrafts.delete(expectedProject); dirty = false; formRevision = -1; } } catch (failure) { error.textContent = messageFor(failure); error.hidden = false; } finally { busy = false; render(); } });
  const open = () => { render(); dialog.showModal(); }; $('sync-toggle')?.addEventListener('click', open);
  controller.adopt(options.getState());
  return { ...controller, destroy() { controller.destroy(); $('sync-toggle')?.removeEventListener('click', open); dialog.remove(); } };
}
