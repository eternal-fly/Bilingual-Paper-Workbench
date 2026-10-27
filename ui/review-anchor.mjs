import {renderMarkdown} from './markdown-reader.mjs';
import {decodeTexProse} from './tex-prose-reader.mjs';
import { reviewImportStatus, reviewSourceStatusLabel, completedReviewOpinion, reviewOperationProgress, reviewOperationLabel } from './review-validation.mjs';

const PAGE_SIZE = 20;
const node = (tag, className, text) => {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
};
const workspaceKey = state => `${state.workspaceIndex?.currentRecordId || state.project?.id || ''}:${state.project?.snapshotId || ''}`;
const busy = state => state.chat?.busy || (state.jobs || []).some(job => ['queued', 'running', 'compiling', 'cancelling', 'inProgress'].includes(job.status));
const unlocated = note => !Array.isArray(note.sourceSegmentIds) || note.sourceSegmentIds.length === 0;
const pendingMatch = note => ['pending', 'unmatched'].includes(note.anchorMatch?.status);

/** Matching prepares one bounded request; only explicit send invokes the bound
 * chat, and only an explicit candidate confirmation can resolve uncertainty. */
export function initializeReviewAnchors({api, getState, getHostState = () => ({}), sendToHost, refreshState = async () => {}, notify = () => {}, onBusyChange = () => {}, onCompleted = () => {}, beforePrepare = async () => {}}) {
  const dialog = node('dialog', 'source-workflow-dialog');
  dialog.id = 'review-anchor-dialog';
  dialog.setAttribute('aria-labelledby', 'review-anchor-title');
  const heading = node('div', 'dialog-heading'), headingText = node('div');
  const title = node('h2', '', '匹配需核对的审稿意见'); title.id = 'review-anchor-title';
  headingText.append(title, node('p', '', 'Codex 根据当前源码核对未定位或已变化的意见。原有链接保留，只有明确原文依据或你的确认才会更新关联；已写回意见默认跳过。'));
  const close = node('button', 'text-button', '关闭'); close.id = 'review-anchor-close'; close.type = 'button'; close.setAttribute('aria-label', '关闭意见匹配');
  heading.append(headingText, close);
  const status = node('p', 'helper'); status.id = 'review-anchor-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const error = node('p', 'inline-error'); error.id = 'review-anchor-error'; error.hidden = true; error.setAttribute('role', 'alert');
  const prepareSection = node('section', 'review-anchor-prepare-section');
  const scopeLabel = node('label', 'field', '本次交给 Codex 的需核对意见');
  const scope = node('select'); scope.multiple = true; scope.size = 5; scope.id = 'review-anchor-notes'; scopeLabel.append(scope);
  const instructionLabel = node('label', 'field', '匹配要求（可选）');
  const instruction = node('textarea'); instruction.id = 'review-anchor-instruction'; instruction.rows = 2; instruction.maxLength = 8000;
  instruction.placeholder = '例如：结合所在章节、原始语句和公式定位；跨段或范围不明确的意见保留待确认。'; instructionLabel.append(instruction);
  const prepare = node('button', 'button', '准备匹配请求'); prepare.id = 'review-anchor-prepare'; prepare.type = 'button';
  const send = node('button', 'button primary', '发送至绑定的 Codex 聊天'); send.id = 'review-anchor-send'; send.type = 'button';
  const actions = node('div', 'dialog-actions'); actions.append(prepare, send);
  const preview = node('details', 'organization-manual'), previewTitle = node('summary', '', '查看本次请求');
  const payload = node('textarea', 'mono'); payload.id = 'review-anchor-payload'; payload.rows = 5; payload.readOnly = true; payload.setAttribute('aria-label', '已准备的意见匹配请求');
  const copy = node('button', 'text-button', '复制请求备份'); copy.id = 'review-anchor-copy'; copy.type = 'button'; preview.append(previewTitle, payload, copy);
  prepareSection.append(scopeLabel, instructionLabel, actions, preview);
  const pendingSection = node('section', 'review-anchor-pending-section'), pendingTitle = node('h3', '', '需要你确认的位置');
  const pendingStatus = node('p', 'helper'); pendingStatus.id = 'review-anchor-pending-status';
  const pendingList = node('div', 'review-anchor-pending-list'); pendingList.id = 'review-anchor-pending-list';
  const more = node('button', 'button', '显示更多待确认意见'); more.id = 'review-anchor-more'; more.type = 'button'; more.hidden = true;
  pendingSection.append(pendingTitle, pendingStatus, pendingList, more);
  dialog.append(heading, status, error, prepareSection, pendingSection); document.body.append(dialog);

  let target = null, request = null, preparedSignature = '', working = false, lastBusy = false, generation = 0, sent = false, invalidated = false, pendingSignature = '', pendingLimit = PAGE_SIZE;
  const selections = new Map();
  const showError = problem => { error.textContent = [problem?.code, problem?.message || String(problem)].filter(Boolean).join('：'); error.hidden = false; };
  const currentBatch = () => (getState().reviewBatches || []).find(batch => batch.batchId === target?.batchId);
  const notesForBatch = () => (getState().reviewNotes || []).filter(note => note.batchId === target?.batchId && note.origin === 'external');
  const matchableNotes = () => { const validation = reviewImportStatus(getState(), target?.batchId).notes; return notesForBatch().filter(note => !completedReviewOpinion(validation.get(note.noteId)) && (unlocated(note) || validation.get(note.noteId)?.status !== 'current')); };
  const targetCurrent = () => {
    const batch = currentBatch();
    return target && target.workspace === workspaceKey(getState()) && batch?.origin === 'external' && batch.status === 'completed' && batch.active !== false && batch.fileHash === target.fileHash && (batch.revision || 1) === target.revision;
  };
  const signature = (selectedIds = request?.noteIds || []) => {
    const state = getState();
    const selected = new Set(selectedIds);
    return JSON.stringify([workspaceKey(state), currentBatch(), notesForBatch().filter(note => selected.has(note.noteId)).map(note => [note.noteId, note.revision, note.sourceSegmentIds]),
      (state.readingParagraphs || []).map(paragraph => [paragraph.id, paragraph.sourceHash || paragraph.beforeHash]),
      Object.entries(state.translations || {}).map(([language, drafts]) => [language, Object.entries(drafts).map(([id, draft]) => [id, draft.revision, draft.sourceHash, draft.status])]), state.languagePreferences, state.syncPreferences, state.alignments]);
  };
  const validRequest = () => { const progress = request && targetCurrent() && reviewOperationProgress(getState(), 'anchors', { requestId: request.requestId }); if (progress && Number.isFinite(Date.parse(progress.expiresAt))) request.expiresAt = progress.expiresAt; return !invalidated && request && targetCurrent() && Date.parse(request.expiresAt) > Date.now() && preparedSignature === signature(); };
  const completedRequest = () => {
    if (!request || !targetCurrent()) return false;
    const byId = new Map(notesForBatch().map(note => [note.noteId, note]));
    return request.noteIds.length > 0 && request.noteIds.every(id => {
      const match = byId.get(id)?.anchorMatch;
      return match?.requestId === request.requestId && match.projectId === getState().project?.id && match.sourceSnapshotId === getState().project?.snapshotId && ['matched', 'pending', 'unmatched', 'confirmed'].includes(match.status);
    });
  };
  function refreshControls() {
    const valid = validRequest(), selected = scope.selectedOptions.length;
    const progress = request && reviewOperationProgress(getState(), 'anchors', { requestId: request.requestId }); if (['collecting', 'receiving'].includes(progress?.status) && error.hidden) status.textContent = reviewOperationLabel(progress, 'anchors', getState().languagePreferences?.uiLanguage || 'en');
    prepare.disabled = working || busy(getState()) || !targetCurrent() || selected === 0;
    send.disabled = working || sent || !valid || busy(getState()) || !getHostState()?.connected || !getHostState()?.canSendMessage || typeof sendToHost !== 'function';
    copy.disabled = working || sent || !valid;
    close.disabled = working; scope.disabled = working; instruction.disabled = working;
    if (lastBusy !== working) { lastBusy = working; onBusyChange(working); }
    if (dialog.open) renderPending();
  }
  function populateScope(preselected = null) {
    const notes = matchableNotes(), validation = reviewImportStatus(getState(), target?.batchId).notes;
    scope.replaceChildren(...notes.map((note, index) => {
      const checked = validation.get(note.noteId), label = `${index + 1}. ${pendingMatch(note) ? '[待确认] ' : ''}${!unlocated(note) ? '[' + reviewSourceStatusLabel(checked?.status, getState().languagePreferences?.uiLanguage || 'en') + '] ' : ''}${note.title || note.body?.slice(0, 100) || note.noteId}`;
      const option = new Option(label, note.noteId);
      option.selected = Array.isArray(preselected) ? preselected.includes(note.noteId) : !pendingMatch(note);
      return option;
    }));
  }
  function renderPending() {
    const state = getState(), paragraphs = new Map((state.readingParagraphs || []).map((paragraph, index) => [paragraph.id, {...paragraph, number: index + 1}]));
    const notes = matchableNotes().filter(pendingMatch), nextSignature = JSON.stringify([target?.workspace, pendingLimit, working, notes.map(note => [note.noteId, note.revision, note.anchorMatch]), [...paragraphs].map(([id, paragraph]) => [id, paragraph.sourceHash || paragraph.beforeHash])]);
    pendingStatus.textContent = notes.length ? `${notes.length} 条意见尚未确定位置。先查看原始意见和候选段落，可选择多个段落共同关联；也可保留未定位。` : '没有待确认的匹配。无法明确定位的结果会保留在这里。';
    more.hidden = notes.length <= pendingLimit;
    if (nextSignature === pendingSignature) return;
    pendingSignature = nextSignature;
    const opened = new Set([...pendingList.querySelectorAll('details[open][data-review-anchor-note]')].map(detail => detail.dataset.reviewAnchorNote));
    const active = document.activeElement, activeNote = active?.closest?.('[data-review-anchor-note]')?.dataset.reviewAnchorNote;
    const activeCandidate = active?.dataset?.anchorSourceId, activeAction = active?.dataset?.anchorConfirm !== undefined ? 'confirm' : active?.dataset?.anchorDefer !== undefined ? 'defer' : active?.tagName === 'SUMMARY' ? 'summary' : null;
    pendingList.replaceChildren(...notes.slice(0, pendingLimit).map(note => {
      const matching = note.anchorMatch, details = node('details', 'review-import-record review-anchor-pending-note'); details.dataset.reviewAnchorNote = note.noteId; details.open = opened.has(note.noteId);
      const summary = node('summary', '', `${note.reviewCode ? '[' + note.reviewCode + '] ' : ''}${note.title || '未定位意见'} · ${matching.status === 'unmatched' ? '未找到可靠候选' : '需要确认'}`);
      const body = node('div', 'review-anchor-original'); body.append(node('h4', '', '原始意见'), node('p', '', note.body || note.recommendation || note.title || note.noteId));
      const reason = node('p', 'helper', matching.reason || '此意见尚不能唯一对应到一个段落。');
      if (matching.partialCompletedCount > 0) body.append(node('p', 'review-validation-warning', getState().languagePreferences?.uiLanguage?.startsWith('zh') ? '此意见的一部分已经写回；候选关联只处理剩余部分，跨越已写回段落的候选需人工核对。' : 'Part of this concern is already applied. Match the remaining concern only; candidates spanning applied paragraphs require human review.'));
      const candidates = node('div', 'review-anchor-candidates');
      const choose = node('button', 'button primary', '确认关联此段'); choose.type = 'button'; choose.dataset.anchorConfirm = note.noteId;
      const clear = node('button', 'text-button', '清空选择'); clear.type = 'button'; clear.dataset.anchorClear = note.noteId;
      const defer = node('button', 'button', '保留未定位，稍后确认'); defer.type = 'button'; defer.dataset.anchorDefer = note.noteId;
      const selectionStatus = node('p', 'helper'); selectionStatus.setAttribute('role', 'status'); selectionStatus.setAttribute('aria-live', 'polite');
      const rowIdentity = JSON.stringify([note.revision, matching.matchingId, state.project?.id, state.project?.snapshotId]);
      const remembered = selections.get(note.noteId);
      if (remembered?.rowIdentity !== rowIdentity) selections.delete(note.noteId);
      const allowed = new Map();
      const declaredIds = (matching.candidates || []).map(candidate => candidate.sourceSegmentId);
      const distinctIds = [...new Set(declaredIds)];
      const currentSelection = () => selections.get(note.noteId)?.rowIdentity === rowIdentity ? selections.get(note.noteId) : {rowIdentity, sourceHashes: new Map()};
      function refreshChoice() {
        const selected = currentSelection(), count = selected.sourceHashes.size;
        const valid = count >= 1 && [...selected.sourceHashes].every(([id, hash]) => allowed.get(id)?.sourceHash === hash) && distinctIds.filter(id => selected.sourceHashes.has(id)).length === count;
        choose.disabled = working || !valid; choose.textContent = count > 1 ? '同时关联所选段落' : '确认关联此段';
        clear.disabled = working || !count;
        selectionStatus.textContent = !count ? '尚未选择段落；请明确勾选需要关联的候选。' : valid ? `已选 ${count} 个段落；确认后同一条意见会关联这些段落。` : `已选 ${count} 个段落，其中有源文已变化或失效的候选；请取消该选择或重新匹配，不会只写入部分关联。`;
      }
      for (const [index, candidate] of (matching.candidates || []).entries()) {
        const paragraph = paragraphs.get(candidate.sourceSegmentId), currentHash = paragraph?.sourceHash || paragraph?.beforeHash;
        const fresh = Boolean(targetCurrent() && matching.projectId === state.project?.id && matching.sourceSnapshotId === state.project?.snapshotId && paragraph && candidate.sourceHash === currentHash && matching.matchingId && declaredIds.filter(id => id === candidate.sourceSegmentId).length === 1);
        const card = node('div', 'review-import-record review-anchor-candidate'); card.dataset.anchorCandidate = candidate.sourceSegmentId;
        const label = node('label', 'review-anchor-candidate-label'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.name = `review-anchor-${note.noteId}`; checkbox.value = candidate.sourceSegmentId; checkbox.dataset.anchorSourceId = candidate.sourceSegmentId;
        checkbox.checked = currentSelection().sourceHashes.has(candidate.sourceSegmentId);
        checkbox.disabled = working || (!fresh && !checkbox.checked);
        label.append(checkbox, node('span', '', paragraph ? `段落 ${paragraph.number} · ${paragraph.section || candidate.path || paragraph.path || '原文'}` : `候选 ${index + 1} · 段落已不可用`));
        const source = node('div', 'review-anchor-candidate-source');
        const sourceText = paragraph?.displayText || paragraph?.source || candidate.excerpt || '';
        const decoded = decodeTexProse(sourceText, {tokens: paragraph?.protectedTokens || []});
        renderMarkdown(source, decoded.text, {tokens: paragraph?.protectedTokens || [], macros: state.markdownContext?.macros || {}, references: state.markdownContext?.references || {}});
        const quote = node('blockquote', 'review-anchor-evidence', candidate.quote || '没有可核对的原文摘录。');
        card.append(label, source, quote, node('p', 'helper', candidate.reason || '请结合段落上下文核对。'));
        if (!fresh) card.append(node('p', 'inline-error', '源文已变化，或候选证据已失效；请重新匹配后确认。'));
        if (fresh) allowed.set(candidate.sourceSegmentId, candidate);
        checkbox.addEventListener('change', () => {
          if (working || checkbox.disabled) return;
          const selected = currentSelection();
          if (checkbox.checked) {
            if (!fresh) {
              checkbox.checked = false;
              refreshChoice(); return;
            }
            selected.sourceHashes.set(candidate.sourceSegmentId, candidate.sourceHash);
          } else selected.sourceHashes.delete(candidate.sourceSegmentId);
          selections.set(note.noteId, selected);
          checkbox.disabled = working || !fresh;
          refreshChoice();
        });
        candidates.append(card);
      }
      if (!matching.candidates?.length) candidates.append(node('p', 'helper', '没有可靠候选。可先关闭此窗口，在第二栏选择段落，再使用该意见的“关联当前段落”。'));
      refreshChoice();
      choose.addEventListener('click', async () => {
        const selected = currentSelection(), sourceSegmentIds = distinctIds.filter(id => selected.sourceHashes.has(id));
        if (working || choose.disabled || selected.rowIdentity !== rowIdentity || !sourceSegmentIds.length || sourceSegmentIds.length !== selected.sourceHashes.size || sourceSegmentIds.some(id => allowed.get(id)?.sourceHash !== selected.sourceHashes.get(id))) return;
        const expectedSourceHashes = Object.fromEntries(sourceSegmentIds.map(id => [id, selected.sourceHashes.get(id)]));
        const payload = {noteId: note.noteId, expectedRevision: note.revision, matchingId: matching.matchingId,
          ...(sourceSegmentIds.length === 1 ? {sourceSegmentId: sourceSegmentIds[0], expectedSourceHash: expectedSourceHashes[sourceSegmentIds[0]]} : {sourceSegmentIds, expectedSourceHashes})};
        working = true; error.hidden = true; refreshControls(); renderPending();
        try {
          await api('confirmReviewAnchor', payload);
          selections.delete(note.noteId); await refreshState();
          notify(`意见已关联到你确认的 ${sourceSegmentIds.length} 个段落，原始意见、译文和论文源码保留。`);
          pendingSignature = ''; renderPending();
        } catch (problem) { showError(problem); }
        finally { working = false; pendingSignature = ''; renderPending(); refreshControls(); }
      });
      clear.addEventListener('click', () => { if (working) return; selections.delete(note.noteId); pendingSignature = ''; renderPending(); });
      defer.addEventListener('click', () => { details.open = false; notify('此意见仍保留未定位，可随时回来确认；没有删除记录。'); });
      const pendingActions = node('div', 'dialog-actions'); pendingActions.append(choose, clear, defer);
      details.append(summary, body, reason, candidates, selectionStatus, pendingActions); return details;
    }));
    if (!notes.length) pendingList.append(node('p', 'empty', '所有已确定的位置会继续显示在对应段落的意见栏。'));
    if (activeNote) {
      const detail = [...pendingList.querySelectorAll('[data-review-anchor-note]')].find(value => value.dataset.reviewAnchorNote === activeNote);
      const focus = activeCandidate ? [...(detail?.querySelectorAll('input[data-anchor-source-id]') || [])].find(value => value.dataset.anchorSourceId === activeCandidate) : activeAction === 'confirm' ? detail?.querySelector('[data-anchor-confirm]') : activeAction === 'defer' ? detail?.querySelector('[data-anchor-defer]') : activeAction === 'summary' ? detail?.querySelector('summary') : null;
      if (focus && !focus.disabled) focus.focus({preventScroll: true});
    }
  }
  function invalidate() {
    invalidated = true; status.textContent = '匹配请求已失效，请重新准备；原预览保留供核对。';
    showError(Error('论文、意见、草稿或文件状态已变化，请重新准备匹配请求。'));
  }
  async function prepareRequest() {
    if (prepare.disabled) return;
    const captured = target, ticket = ++generation, ids = [...scope.selectedOptions].map(option => option.value);
    working = true; sent = false; invalidated = false; request = null; error.hidden = true; payload.value = '正在核对原意见和源码版本…'; refreshControls();
    try {
      await beforePrepare();
      const capturedSignature = signature(ids);
      const prepared = await api('prepareReviewAnchors', {batchId: captured.batchId, expectedRevision: captured.revision, expectedFileHash: captured.fileHash, noteIds: ids, instruction: instruction.value});
      if (ticket !== generation || target !== captured || !dialog.open || !targetCurrent()) return;
      if (!prepared || prepared.batchId !== captured.batchId || !prepared.requestId || prepared.noteCount !== ids.length || !Array.isArray(prepared.noteIds) || prepared.noteIds.length !== ids.length || !ids.every(id => prepared.noteIds.includes(id)) || !Array.isArray(prepared.context?.notes) || !Number.isFinite(Date.parse(prepared.expiresAt))) throw Error('匹配请求与所选文件或意见不一致，请重新准备。');
      request = prepared; preparedSignature = capturedSignature;
      payload.value = prepared.nativePrompt || `请只匹配此请求中的未定位意见。调用 bilingual_paper_get_review_anchor_context(${JSON.stringify({requestId: prepared.requestId})}) 读取原始意见和完整源码上下文，再调用 bilingual_paper_submit_review_anchors 回填每条的定位证据。确定性不足的保持待确认，不修改论文或译稿。`;
      preview.open = true;
      status.textContent = `已准备 ${prepared.noteCount} 条意见。${getHostState()?.canSendMessage ? '发送后等待绑定聊天返回匹配。' : '绑定聊天的直接发送通道尚未就绪；请求保留，连接后可直接发送。'} 源码和译稿保持不变。`;
      if (!validRequest()) invalidate();
    } catch (problem) { showError(problem); payload.value = ''; }
    finally { if (ticket === generation) working = false; refreshControls(); }
  }
  prepare.addEventListener('click', () => void prepareRequest());
  send.addEventListener('click', async () => {
    if (send.disabled || !validRequest()) return;
    working = true; error.hidden = true; refreshControls();
    try {
      if(getHostState()?.directChat)await api('runReviewAnchors',{requestId:request.requestId});else await sendToHost(payload.value); sent = true;
      status.textContent = `已发送 ${request.noteCount} 条意见，等待绑定的 Codex 聊天返回匹配结果…`;
      notify('匹配请求已发送，结果经版本校验后自动显示；不需要再次复制请求。');
      await refreshState();
    } catch (problem) { showError(problem); }
    finally { working = false; refreshControls(); }
  });
  copy.addEventListener('click', async () => {
    if (copy.disabled || !validRequest()) return;
    try { await navigator.clipboard.writeText(payload.value); notify('匹配请求备份已复制。'); }
    catch (problem) { showError(problem); }
  });
  for (const [control, event] of [[scope, 'change'], [instruction, 'input']]) control.addEventListener(event, () => { generation++; request = null; sent = false; invalidated = false; payload.value = ''; error.hidden = true; refreshControls(); });
  more.addEventListener('click', () => { pendingLimit += PAGE_SIZE; renderPending(); });
  close.addEventListener('click', () => { if (!working) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (working) event.preventDefault(); });
  dialog.addEventListener('close', () => { generation++; target = null; request = null; sent = false; preparedSignature = ''; payload.value = ''; pendingSignature = ''; selections.clear(); });
  function open(batch, pendingOnly = false, preselected = null) {
    if (working || busy(getState()) || batch?.origin !== 'external' || batch.status !== 'completed' || batch.active === false) return false;
    target = {batchId: batch.batchId, filename: batch.filename, fileHash: batch.fileHash, revision: batch.revision || 1, workspace: workspaceKey(getState())};
    generation++; request = null; sent = false; invalidated = false; payload.value = ''; instruction.value = ''; error.hidden = true; preview.open = false; pendingLimit = PAGE_SIZE; pendingSignature = ''; selections.clear();
    populateScope(preselected); renderPending();
    const count = matchableNotes().length;
    status.textContent = `${batch.filename} · ${count} 条意见需匹配当前段落。完整范围将在预览后明确发送；较大内容由后台分批处理。打开窗口不会调用模型。`;
    dialog.showModal(); refreshControls();
    if (pendingOnly) pendingSection.scrollIntoView({block: 'start', behavior: 'instant'});
    return true;
  }
  return {
    open: (batch, options = {}) => open(batch, false, options.noteIds || null),
    openPending: batch => open(batch || currentBatch() || (getState().reviewBatches || []).find(item => item.origin === 'external' && item.active !== false && item.status === 'completed'), true),
    adopt() {
      if (!dialog.open) return;
      if (request && completedRequest()) {
        const requestId = request.requestId, returned = notesForBatch().filter(note => request.noteIds.includes(note.noteId));
        const matchedCount = returned.filter(note => ['matched', 'confirmed'].includes(note.anchorMatch?.status)).length, pendingCount = returned.length - matchedCount;
        request = null; sent = false; invalidated = false; preparedSignature = ''; generation++; error.hidden = true;
        status.textContent = `匹配完成：已关联 ${matchedCount} 条，需确认 ${pendingCount} 条。原始意见、论文和译稿保持。`;
        populateScope(); pendingSignature = ''; renderPending(); notify(status.textContent); onCompleted({requestId, matchedCount, pendingCount});
      } else if (request && !validRequest()) invalidate();
      else if (target && !targetCurrent()) { invalidated = true; showError(Error('论文或意见文件状态已变化，请关闭后重新打开匹配。')); }
      renderPending(); refreshControls();
    },
    isBusy: () => working,
    destroy() { generation++; dialog.remove(); }
  };
}
