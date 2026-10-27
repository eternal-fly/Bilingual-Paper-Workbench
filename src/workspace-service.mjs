import { EventEmitter } from 'node:events';
import {mergeNativeRelayMessages} from './native-relay-history.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { TaskRegistry } from './task-registry.mjs';
import { resolveHostContext, projectDirectory, discoverMainFiles, authorizedRoot } from './host-context.mjs';
import { OriginChatBinding } from './origin-chat-binding.mjs';
import { DesktopExecution } from './desktop-execution.mjs';
import { paperProjectTitle, readProjectTitle } from './paper-project-title.mjs';
import { spawn } from 'node:child_process';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const hash = value => createHash('sha256').update(value).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const mainName = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && /\.tex$/i.test(value) && !path.isAbsolute(value) && !value.replaceAll('\\', '/').split('/').some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f<>"|?*]/.test(part));

/** Stable controller identity for both panels. Each saved task/paper gets its
 * own PaperApplication, private state store and optional worker conversation. */
export class WorkspaceService extends EventEmitter {
  constructor({ initialApp, factory, dataRoot, codexRoot, hostOptions = {}, originThreadId = null, readOriginMetadata = null, createDesktopProducer = null }) {
    super();
    this.active = initialApp; this.factory = factory; this.registry = new TaskRegistry({ dataRoot, codexRoot }); this.hostOptions = hostOptions;
    this.currentRecord = null; this.hostContext = null; this.bootstrap = { status: 'workspace-required', mainCandidates: [] }; this.recordCount = 0;
    this._watchOptions = null; this._switching = false; this._closing = false; this._bindingQueue = Promise.resolve();
    this.nativeRelay=null;
    this._assistantImportPromise=null;
    this._onChange = () => { this.emit('change'); this._saveBinding(); };
    this.active.on?.('change', this._onChange);
    this.desktopExecution = createDesktopProducer ? new DesktopExecution(this, { createProducer: createDesktopProducer }) : null;
    this.originChat = originThreadId ? new OriginChatBinding(this, { threadId: originThreadId, readMetadata: readOriginMetadata }) : null;
    return new Proxy(this, {
      get(target, key) {
        if (Reflect.has(target, key)) { const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; }
        const value = target.active[key];
        if (typeof value !== 'function') return value;
        return (...args) => { if (target._switching) fail('PROJECT_BUSY', 'Wait for the project switch to finish.'); return target.active[key](...args); };
      },
      set(target, key, value) { if (Reflect.has(target, key)) return Reflect.set(target, key, value, target); target.active[key] = value; return true; },
    });
  }
  async initializeWorkspace() {
    this.hostContext = await resolveHostContext(this.hostOptions);
    // v0.3.1 kept all original state at the base roots. Index that exact known
    // launch binding in place; no snapshots/chat files are moved or rewritten.
    const { explicitWorkspace, explicitMainFile } = this.hostOptions;
    if (explicitWorkspace && mainName(explicitMainFile)) {
      const projectRoot = await projectDirectory(explicitWorkspace).catch(() => null);
      if (projectRoot && await this._hasLegacyState(projectRoot, explicitMainFile)) await this.registry.register({ projectRoot, mainFile: explicitMainFile, legacy: true, hostSource: 'explicit-launch-binding' });
    }
    this.recordCount = (await this.registry.records()).length;
    return this;
  }
  async _hasLegacyState(root, mainFile) {
    const projectId = `project-${hash(`${root.toLowerCase()}\0${mainFile.toLowerCase().replaceAll('\\', '/')}`).slice(0, 24)}`;
    const info = await lstat(path.join(this.registry.dataRoot, 'projects', projectId, 'state.json')).catch(() => null);
    return Boolean(info?.isFile() && !info.isSymbolicLink());
  }
  getState() {
    const state = this.active.getState();
    if (this.originChat) state.originatingChat = this.originChat.state();
    if (this.desktopExecution) state.desktopExecution = this.desktopExecution.state();
    if (this.active.translationTasks) state.translationTasks = this.active.translationTasks.state();
    const relay=this.nativeRelay?.getState();state.nativeChatRelay=relay?{...relay,messages:mergeNativeRelayMessages(this.active.flow?.nativeChatMessages,relay.messages,state.project?.id)}:state.nativeChatRelay;
    return { ...state, ...(this.bootstrap.status === 'main-file-required' ? { mainCandidates: this.bootstrap.mainCandidates } : {}), workspaceIndex: { currentRecordId: this.currentRecord?.recordId || null, recordCount: this.recordCount, hostContext: structuredClone(this.hostContext), bootstrap: structuredClone(this.bootstrap), currentRecord: this.currentRecord ? this._publicRecord(this.currentRecord) : null, ...(this.registryError ? { error: this.registryError } : {}) } };
  }
  async refreshExternalJobStatus() {
    if (this._switching || this._closing) return { changed: false, updatedJobIds: [] };
    return await this.active.refreshExternalJobStatus?.() ?? { changed: false, updatedJobIds: [] };
  }
  async compileReviewNote(input) {
    if (this._switching || this._closing) fail('PROJECT_BUSY', 'Wait for the project switch to finish.');
    return this.active.compileReviewNote(input);
  }
  getHostContext() { return structuredClone(this.hostContext); }
  retryOriginChat() { return this.originChat?.retry() || { phase: 'unavailable', autoConnect: false, error: { code: 'HOST_CHAT_UNAVAILABLE', message: 'The launcher did not provide a trusted originating chat identity.' } }; }
  startTranslationTask(input) { if (!this.active.translationTasks || !this.desktopExecution?.state().available) fail('DESKTOP_EXECUTION_REQUIRED', 'Verify this paper Desktop delivery before starting translation.'); return this.active.translationTasks.start(input); }
  cancelTranslationTask(input) { if (!this.active.translationTasks) fail('DESKTOP_EXECUTION_REQUIRED', 'Desktop translation is unavailable.'); return this.active.translationTasks.cancel(input); }
  resumeTranslationTask(input) { if (!this.active.translationTasks || !this.desktopExecution?.state().available) fail('DESKTOP_EXECUTION_REQUIRED', 'Desktop translation is unavailable.'); return this.active.translationTasks.resume(input); }
  desktopSendMessage(input) { if (!this.desktopExecution) fail('DESKTOP_EXECUTION_REQUIRED', 'Open this paper from its Desktop chat first.'); return this.desktopExecution.sendMessage(input); }
  connectExistingChat(input) { if (this.desktopExecution) fail('DESKTOP_EXECUTION_REQUIRED', 'This paper sends model requests through Desktop. Change its model in the bound Desktop chat.'); return this.active.connectExistingChat(input); }
  runDesktopRequest(input) { if (!this.desktopExecution) fail('DESKTOP_EXECUTION_REQUIRED', 'Open this paper from its Desktop chat first.'); return this.desktopExecution.runRequest(this.active, input); }
  async openDesktopChat(input = {}) {
    if (!input || Object.keys(input).length) fail('INVALID_INPUT', 'Open only the verified paper chat.');
    const target = this.desktopExecution?.state();
    if (!target?.available || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(target.threadId)) fail('DESKTOP_EXECUTION_REQUIRED', 'The paper Desktop chat has not been verified.');
    const powershell = process.env.PAPER_EDITOR_POWERSHELL || 'pwsh.exe';
    await new Promise((resolve, reject) => { const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', 'Start-Process -FilePath $env:PAPER_EDITOR_OPEN_CHAT_URI'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, PAPER_EDITOR_OPEN_CHAT_URI: `codex://threads/${target.threadId}` } }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Object.assign(new Error('The Desktop chat could not be opened.'), { code: 'DESKTOP_OPEN_FAILED' }))); });
    return { opened: true, threadId: target.threadId };
  }
  async importFiles(input, { bindingId = null } = {}) {
    if (this._assistantImportPromise) fail('IMPORT_BUSY', 'Wait for the current file import to finish.');
    this._assertIdle();
    const work = import('./assistant-onboarding.mjs').then(module => module.importAssistantFiles(this, input, { bindingId }));
    this._assistantImportPromise = work;
    try { return await work; } finally { if (this._assistantImportPromise === work) this._assistantImportPromise = null; this.emit('change'); }
  }
  async setHostRoots(roots) {
    const next = await resolveHostContext({ ...this.hostOptions, roots });
    const changed = JSON.stringify(next) !== JSON.stringify(this.hostContext);
    if (changed) await this._switch(async () => {
      if (this.currentRecord && !authorizedRoot(next, this.currentRecord.projectRoot)) {
        await this._bindingQueue; await this._persistBinding();
        const empty = await this.factory(null), previous = this.active;
        previous.off?.('change', this._onChange);
        try { await previous.close?.(); } catch (error) { previous.on?.('change', this._onChange); await empty.close?.(); throw error; }
        this.active = empty; this.currentRecord = null; this.active.on?.('change', this._onChange);
        if (this._watchOptions) this.active.startWatching?.(this._watchOptions);
      }
      this.hostContext = next; this.bootstrap = { status: 'workspace-required', mainCandidates: [] }; this.emit('change');
    });
    return this.getHostContext();
  }
  /** Called only after the background validates its opener's HMAC proof. */
  async adoptSignedHostProject(context, { reset = false } = {}) {
    if (reset) await this._switch(async () => {
      await this._bindingQueue; await this._persistBinding();
      const empty = await this.factory(null), previous = this.active; previous.off?.('change', this._onChange);
      try { await previous.close?.(); } catch (error) { previous.on?.('change', this._onChange); await empty.close?.(); throw error; }
      this.active = empty; this.currentRecord = null; this.active.on?.('change', this._onChange); this.bootstrap = { status: 'workspace-required', mainCandidates: [] };
      if (this._watchOptions) this.active.startWatching?.(this._watchOptions);
    });
    this.hostContext = structuredClone(context);
    if (this.currentRecord && !this.currentRecord.hostProjectRoot && this.currentRecord.hostTaskId === context.hostTaskId && this.active.getState().project) this.currentRecord = await this.registry.touch(this.currentRecord.recordId, this._hostProjectCapture(this.currentRecord) || {});
    this.emit('change');
  }
  async bootstrapHostProject() {
    if (this._switching) fail('PROJECT_BUSY', 'Wait for the project switch to finish.');
    const context = this.hostContext;
    if (this.currentRecord && this.bootstrap.status === 'ready' && (!context.native || authorizedRoot(context, this.currentRecord.projectRoot))) return this.getState();
    if (!context.projectRoot) {
      this.bootstrap = { status: 'workspace-required', roots: context.roots, mainCandidates: [] }; this.emit('change'); return this.getState();
    }
    const root = context.projectRoot;
    const candidates = context.explicitMainFile ? [context.explicitMainFile] : await this._discover(root);
    if (candidates === null) return this.getState();
    if (candidates.length !== 1) {
      this.bootstrap = { status: 'main-file-required', root, mainCandidates: candidates }; this.emit('change'); return this.getState();
    }
    return this.openProject({ root, mainFile: candidates[0] });
  }
  async _discover(root) {
    try { return await discoverMainFiles(root); }
    catch (error) {
      if (error.code !== 'PROJECT_TOO_LARGE') throw error;
      this.bootstrap = { status: 'main-file-required', root, mainCandidates: [], diagnostic: { code: error.code, message: error.message } }; this.emit('change'); return null;
    }
  }
  _publicRecord(record) {
    const { recordId, projectRoot, rootLabel, mainFile, hostTaskId, hostProjectId, hostProjectRoot, paperTitle, boundChatTitle, hostSource, model, effort, threadId, lastOpenedAt, createdAt, legacy } = record;
    return { recordId, projectRoot, rootLabel, mainFile, hostTaskId, hostProjectId, ...(hostProjectRoot ? { hostProjectRoot } : {}), ...(paperTitle ? { paperTitle } : {}), ...(boundChatTitle ? { boundChatTitle } : {}), hostSource, model, effort, threadId, workerThreadId: threadId, lastOpenedAt, createdAt, legacy };
  }
  async listWorkspaces() {
    await this._bindingQueue;
    const all = await this.registry.records(); this.recordCount = all.length;
    const records = await Promise.all(all.slice(0, 100).map(async record => {
      const root = await lstat(record.projectRoot).catch(() => null), main = await lstat(path.join(record.projectRoot, record.mainFile)).catch(() => null);
      const available = Boolean(root?.isDirectory() && !root.isSymbolicLink() && main?.isFile() && !main.isSymbolicLink()), paperTitle = record.paperTitle || (available ? await readProjectTitle(record) : '');
      return { ...this._publicRecord(record), ...(paperTitle ? { paperTitle } : {}), available };
    }));
    return { records, currentRecordId: this.currentRecord?.recordId || null, hostContext: this.getHostContext(), chatSelection: await this.registry.chatSelection(this.hostContext?.hostTaskId), bootstrap: structuredClone(this.bootstrap), total: all.length, truncated: all.length > records.length };
  }
  _assertIdle() {
    if (this.active.translationTasks?.state()?.tasks.some(task => ['queued', 'running'].includes(task.status))) fail('PROJECT_BUSY', 'Finish or cancel the active Desktop translation before switching papers.');
    const projectId=this.active.core?.getState?.().project?.id;
    const relayBusy=(this.nativeRelay?.getState?.()?.messages||[]).some(message=>!message.historical&&message.projectId===projectId&&['claimed','sent','unknown'].includes(message.status));
    if (relayBusy || this._switching || this._closing || this.active._switching || this.active._pendingOps || this.active._chatConnecting || this.active.reviews?.starting || this.active.chat?.getState?.().busy || [...(this.active.jobs?.values?.() || [])].some(job => !job.finished)) fail('PROJECT_BUSY', 'Wait for or cancel the current paper operation before switching projects.');
  }
  async _switch(work) {
    this._assertIdle(); this._switching = true;
    try { return await work(); } finally { this._switching = false; }
  }
  async openProject(input, { initialEngine = null } = {}) {
    if (initialEngine !== null && !['pdflatex', 'xelatex'].includes(initialEngine)) fail('INVALID_INPUT', 'Choose a supported source compiler.');
    return this._switch(async () => {
      if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['root', 'mainFile', 'sourceLanguage', 'targetLanguage'].includes(key))) fail('INVALID_INPUT', 'Choose a project directory and main TeX file.');
      const root = await projectDirectory(input.root);
      if (this.hostContext.native && !authorizedRoot(this.hostContext, root)) fail('WORKSPACE_NOT_AUTHORIZED', 'Choose a main file inside this chat’s host-authorized project, or reopen an existing record from history.');
      let mainFile = input.mainFile;
      if (!mainFile) {
        const candidates = await this._discover(root);
        if (candidates === null) return this.getState();
        if (candidates.length !== 1) { this.bootstrap = { status: 'main-file-required', root, mainCandidates: candidates }; this.emit('change'); return this.getState(); }
        mainFile = candidates[0];
      }
      if (!mainName(mainFile)) fail('INVALID_INPUT', 'The main TeX filename must stay inside the selected project.');
      const record = await this.registry.register({ projectRoot: root, mainFile, hostTaskId: this.hostContext.hostTaskId, hostProjectId: this.hostContext.hostProjectId, hostSource: authorizedRoot(this.hostContext, root) ? this.hostContext.source : 'human-selection', legacy: !this.hostContext.native && await this._hasLegacyState(root, mainFile), sourceLanguage: input.sourceLanguage || 'en', targetLanguage: input.targetLanguage || 'zh-CN' });
      return this._openRecord(record, { initialEngine });
    });
  }
  async openWorkspaceRecord({ recordId } = {}) {
    return this._switch(async () => this._openRecord(await this.registry.get(recordId)));
  }
  _hostProjectCapture(record = null) {
    const context = this.hostContext;
    return context?.hostTaskId && (!record || record.hostTaskId === context.hostTaskId) && context.projectRoot && ['mcp-roots', 'native-launch-cwd'].includes(context.source) && authorizedRoot(context, context.projectRoot) ? { hostTaskId: context.hostTaskId, hostProjectRoot: context.projectRoot } : null;
  }
  async _openRecord(record, { initialEngine = null } = {}) {
    const root = await projectDirectory(record.projectRoot);
    if (!samePath(root, record.projectRoot)) fail('WORKSPACE_RECORD_CHANGED', 'The saved project root now resolves to a different directory.');
    if (this.currentRecord?.recordId === record.recordId && this.active.getState().project) { this.currentRecord = await this.registry.touch(record.recordId, { ...(this._hostProjectCapture(record) || {}), ...(paperProjectTitle(this.active.getState()) ? { paperTitle: paperProjectTitle(this.active.getState()) } : {}) }); this.bootstrap = { status: 'ready', root, mainCandidates: [] }; return this.getState(); }
    // Build/open first, so an invalid or missing paper never discards the panel
    // currently being read. The old chat is idle and no new chat is started.
    const next = await this.factory({ ...record, ...(initialEngine ? { initialEngine } : {}) });
    try { await next.openProject({ root, mainFile: record.mainFile, sourceLanguage: record.sourceLanguage || 'en', targetLanguage: record.targetLanguage || 'zh-CN' }); }
    catch (error) { await next.close?.(); throw error; }
    await this._bindingQueue; await this._persistBinding();
    const previous = this.active; previous.off?.('change', this._onChange);
    try { await previous.close?.(); } catch (error) { await next.close?.(); previous.on?.('change', this._onChange); throw error; }
    this.active = next; this.currentRecord = await this.registry.touch(record.recordId, { ...(this._hostProjectCapture(record) || {}), ...(paperProjectTitle(next.getState()) ? { paperTitle: paperProjectTitle(next.getState()) } : {}) }); this.active.on?.('change', this._onChange);
    this.recordCount = (await this.registry.records()).length; this.bootstrap = { status: 'ready', root, mainCandidates: [] };
    if (this._watchOptions) this.active.startWatching?.(this._watchOptions);
    this.emit('change'); return this.getState();
  }
  _saveBinding() {
    if (!this.currentRecord || this._switching || this._closing || this._desktopSelectionPending) return;
    const appState = this.active.getState(), reference = [this.active.flow?.nativeChatBinding, this.active.flow?.backgroundChatReference].find(item => item && item.projectId === appState.project?.id && item.threadId), state = reference || this.active.chat?.getState?.(), title = paperProjectTitle(appState);
    const binding = { ...(state?.threadId ? { model: state.model, effort: state.effort, threadId: state.threadId } : {}), ...(title ? { paperTitle: title } : {}), ...(reference?.title ? { boundChatTitle: reference.title } : {}) };
    if (!Object.keys(binding).length || Object.entries(binding).every(([key, value]) => this.currentRecord[key] === value)) return;
    const recordId = this.currentRecord.recordId;
    const key = JSON.stringify([recordId, binding]); if (key === this._queuedBinding) return; this._queuedBinding = key;
    this._bindingQueue = this._bindingQueue.then(async () => { const record = await this.registry.touch(recordId, binding); if (this.currentRecord?.recordId === recordId) this.currentRecord = record; }).catch(error => { this.registryError = { code: error.code || 'REGISTRY_WRITE_FAILED', message: error.message }; }).finally(() => { if (this._queuedBinding === key) this._queuedBinding = null; });
  }
  async persistVerifiedDesktopSelection({ app, projectId, snapshotId, selection, persist, assertCurrent }) {
    const recordId = this.currentRecord?.recordId;
    const check = async () => { await assertCurrent(); if (this.active !== app || app.core.getState().project?.id !== projectId || app.core.getState().project?.snapshotId !== snapshotId || this.currentRecord?.recordId !== recordId || this.currentRecord?.threadId && this.currentRecord.threadId !== selection.threadId) fail('DESKTOP_EXECUTION_STALE', 'The paper/chat record changed during current model verification.'); };
    await check(); await this._bindingQueue; await check(); this._desktopSelectionPending = true;
    try {
      await persist(); await check();
      if (recordId) {
        const record = await this.registry.touch(recordId, { threadId: selection.threadId, model: selection.model, effort: selection.effort, boundChatTitle: selection.title }); await check();
        if (record.threadId !== selection.threadId || record.model !== selection.model || record.effort !== selection.effort) fail('DESKTOP_QUEUE_METADATA_UNAVAILABLE', 'The saved paper model metadata did not verify.');
        this.currentRecord = record;
      }
    } finally { this._desktopSelectionPending = false; }
  }
  async _persistBinding() {
    const appState = this.active.getState(), reference = [this.active.flow?.nativeChatBinding, this.active.flow?.backgroundChatReference].find(item => item && item.projectId === appState.project?.id && item.threadId), state = reference || this.active.chat?.getState?.();
    if (this.currentRecord && state?.threadId) this.currentRecord = await this.registry.touch(this.currentRecord.recordId, { model: state.model, effort: state.effort, threadId: state.threadId, ...(paperProjectTitle(appState) ? { paperTitle: paperProjectTitle(appState) } : {}), ...(reference?.title ? { boundChatTitle: reference.title } : {}) });
  }
  startWatching(options = {}) { this._watchOptions = options; return this.active.startWatching?.(options); }
  stopWatching() { this._watchOptions = null; return this.active.stopWatching?.(); }
  async close() { this._closing = true; this.originChat?.close(); try { await this.desktopExecution?.close(); await this._bindingQueue; await this._persistBinding(); } finally { await this.active.close?.(); } }
}
