import { deriveEnglishWriteback } from './writeback-state.mjs';

/** Only an explicit author click can obtain and consume source confirmation. */
export function initializeEnglishWriteback({ api, getState, getLanguage, getInterfaceLanguage = () => 'en', getBuffers = () => [], flushDrafts, refreshState, getBusy = () => false, getBusyReason = () => '', notify, lockEditing = () => {}, onCompile = () => {}, onPrepareRequest = () => {}, onReviewSource = null, onApplied = async () => {} }) {
  const button = document.getElementById('writeback-english'), status = document.getElementById('writeback-status');
  let busy = false, lastSuccess = false, successIdentity = '';
  const copy = (english, chinese) => getInterfaceLanguage().startsWith('zh') ? chinese : english;
  const plan = () => deriveEnglishWriteback(getState(), getLanguage(), getBuffers());
  const identity = () => JSON.stringify([getState().workspaceIndex?.currentRecordId || null, getState().project?.id, getLanguage()]);
  const changed = () => Error(copy('The draft, source, project or candidate changed. Review the current English candidate and click again.', '译稿、源文、项目或候选已变化。请检查当前英文候选后重新点击。'));
  const action = current => ['missing','save'].includes(current.mode) ? 'prepare' : current.mode === 'compile' ? 'compile' : 'apply';
  const blockedReason = current => getBusy(action(current)) ? getBusyReason(action(current)) || copy('Another paper operation is active. Wait before this action.', '另一论文操作正在进行，请完成后再执行此操作。') : '';
  function render() {
    const current = plan(), count = current.count, scope = copy(`${count} paragraph${count === 1 ? '' : 's'}`, `${count} 段`), blocked=blockedReason(current);
    button.textContent = current.mode === 'compile' ? copy('Compile English changes', '编译英文修改') : ['missing', 'save'].includes(current.mode) ? copy('Prepare English changes', '准备英文修改') : copy('Write back English', '写回英文');
    button.disabled = busy || Boolean(blocked) || ['empty', 'blocked', 'compiling'].includes(current.mode) || current.mode === 'ready' && !getState().capabilities?.directApply || current.mode === 'compile' && !getState().capabilities?.secureCompile;
    button.setAttribute('aria-busy', String(busy));
    status.textContent = busy ? copy('Checking the exact English writeback…', '正在核对精确英文修改…') : current.mode === 'ready' ? copy(`${scope} ready. Click to write the reviewed, compiled English candidate.`, `${scope}已就绪。点击写回已审阅并编译的英文候选。`) : current.mode === 'empty' ? lastSuccess && successIdentity === identity() ? copy('English changes applied; the latest PDF updates automatically.', '英文修改已写回；最新版 PDF 自动更新。') : copy('No pending human translation changes.', '没有待写回的人工译文修改。') : current.mode === 'blocked' ? copy(`${scope}: review stale source or custom paragraph alignment first. No partial writeback.`, `${scope}：请先核对过期源文或手工对齐关系；不会部分写回。`) : current.mode === 'missing' ? copy(`${scope}; ${current.missingIds.length} need current English candidates. No partial writeback.`, `${scope}；其中 ${current.missingIds.length} 段需要当前英文候选。不会部分写回。`) : current.mode === 'compiling' ? copy(`${scope} compiling. Review the PDF, then click Write back English.`, `${scope}正在编译。检查 PDF 后再点击“写回英文”。`) : current.mode === 'save' ? copy('Save current edits and prepare their English candidates.', '先保存当前编辑并准备对应英文候选。') : current.compileFailed ? copy(`${scope}: compilation failed. Retry before writeback; source unchanged.`, `${scope}：编译失败。重新编译后才能写回；源文未变。`) : copy(`${scope}: compile the complete English candidate before writeback.`, `${scope}：先编译完整英文候选，再点击写回。`);
    if (current.mode === 'ready' && !getState().capabilities?.directApply) status.textContent = copy('Reviewed source writeback is unavailable in this environment.', '当前环境尚未启用受审源文写回。');
    if(!busy&&blocked)status.textContent+=' '+blocked;
    button.title = status.title = status.textContent;
  }
  async function click() {
    const clicked = plan(), capturedIdentity = identity(), clickedSnapshot = getState().project?.snapshotId;
    if (busy || blockedReason(clicked)) return;
    busy = true; lastSuccess = false; lockEditing(true); render();
    try {
      await flushDrafts(); await refreshState();
      const selected = plan();
      if (identity() !== capturedIdentity || getState().project?.snapshotId !== clickedSnapshot || clicked.mode === 'ready' && (selected.mode !== 'ready' || clicked.fingerprint !== selected.fingerprint)) throw changed();
      if (clicked.mode !== 'ready' && selected.mode === 'ready') { notify(copy('The compiled English candidate is ready. Review it, then click Write back English.', '英文候选已编译就绪。检查后再点击“写回英文”。')); return; }
      if (selected.mode === 'empty') return;
      const blocked=blockedReason(selected);if(blocked)throw Error(blocked);
      if (selected.mode === 'missing') {
        await onPrepareRequest(selected.missingIds); return;
      }
      if (selected.mode === 'compile') {
        if (!getState().capabilities?.secureCompile) throw Error(copy('Isolated compilation is unavailable.', '隔离编译尚不可用。'));
        const result = await api('previewTransaction', { proposalIds: selected.proposalIds }); if (identity() !== capturedIdentity || getState().project?.snapshotId !== clickedSnapshot) throw changed(); onCompile(result, selected.proposalIds); await refreshState();
        notify(copy('English candidate compilation queued. Review its PDF, then click Write back English; nothing is applied automatically.', '英文候选已进入编译队列。检查 PDF 后点击“写回英文”；不会自动写回。')); return;
      }
      if (selected.mode !== 'ready' || !getState().capabilities?.directApply) throw Error(copy('The complete current English candidate is not ready for writeback.', '完整的当前英文候选尚未就绪，不能写回。'));
      if (selected.transaction.requiresHumanSourceReview || selected.proposalIds.some(id => getState().proposals?.find(proposal => proposal.proposalId === id)?.context?.mode === 'source-review')) {
        if (!onReviewSource) throw Error(copy('Review the complete TeX source candidate in Revisions before confirming writeback.', '请在修订中检查完整 TeX 源码候选并确认写回。'));
        await onReviewSource(selected.transaction); return;
      }
      const prepared = await api('prepareAcceptance', { transactionId: selected.transaction.transactionId });
      await refreshState();
      const current = plan();
      if (identity() !== capturedIdentity || current.mode !== 'ready' || current.fingerprint !== selected.fingerprint || prepared.transactionId !== selected.transaction.transactionId || prepared.candidateHash !== selected.transaction.candidateHash || prepared.buildId !== selected.transaction.buildId || typeof prepared.confirmationToken !== 'string' || !prepared.confirmationToken || Date.parse(prepared.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(prepared.expiresAt))) throw changed();
      const blockedAfterPrepare=blockedReason(current);if(blockedAfterPrepare)throw Error(blockedAfterPrepare);
      const result = await api('applyTransaction', { transactionId: prepared.transactionId, confirmationToken: prepared.confirmationToken, idempotencyKey: crypto.randomUUID() });
      if (identity() !== capturedIdentity) throw changed();
      await onApplied(result, selected.proposalIds); await refreshState(); lastSuccess = result.state === 'applied' && identity() === capturedIdentity; if (lastSuccess) successIdentity = capturedIdentity;
    } catch (error) { notify([error.code, error.message || String(error)].filter(Boolean).join(': '), true, true); }
    finally { busy = false; lockEditing(false); render(); }
  }
  button.addEventListener('click', click); render();
  return { adopt: render, isBusy: () => busy, destroy() { button.removeEventListener('click', click); } };
}
