import { EventEmitter } from 'node:events';
import { readFile, writeFile, mkdir, open, rename, lstat } from 'node:fs/promises';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { PaperService } from './core.mjs';
import { WindowsSourceWriter } from './windows-writer.mjs';
import { paperRequestPrompt, paperRequestSchema } from './codex-bridge.mjs';
import { restoreProtected } from './latex.mjs';
import { ReadingWorkspace } from './reading-workflow.mjs';
import { rebaseConfirmedTranslationDrafts, reconcileLegacyConfirmedDraft } from './draft-source-rebase.mjs';
import { listProjectSources, readProjectSource } from './project-source.mjs';
import { ReviewOrganizationWorkflow } from './review-organization.mjs';
import { deriveReviewImportValidation, revalidateReviewImport, reopenReviewImportNote } from './review-import-validation.mjs';
import { captureAdoptedReviewEvidence } from './review-completion.mjs';
import { ReviewAnchorWorkflow } from './review-anchor.mjs';
import { connectExistingChat, restoreExistingChat } from './existing-chat-binding.mjs';
import { BackgroundConnection } from './background-connection.mjs';
import {mergeNativeRelayMessages} from './native-relay-history.mjs';
import { inputManifestIdentity } from './build-identity.mjs';
import { ReviewWorkflow } from './full-review.mjs';
import { startParagraphReview } from './paragraph-review.mjs';
import { SyncWorkflow } from './sync-workflow.mjs';
import { ReviewCycle } from './review-cycle.mjs';
import { PdfSelection } from './pdf-selection.mjs';
import {prepareNativePdfContext,closeNativePdfContext} from './native-pdf-context.mjs';
import { OpinionMathRenderer, opinionMathFingerprint } from './opinion-math.mjs';
import { createMarkdownContext } from './markdown-context.mjs';
import { projectReviewHistory } from './review-history.mjs';
import { reviewHistoryPreferences } from './review-history-policy.mjs';
import {createFormulaDraft,createInlineFormulaDraft,reconcileFormulaDraft,formulaSourceForRequest,validateDraftSourceReplacement} from './formula-edits.mjs';
import {maskRawReplacement} from './range-authority.mjs';
import {referenceTargetRegistry,topLevelReferences} from './reference-edits.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const stamp = () => new Date().toISOString();
function stoppedJobOwner(job) {
  if (!['running', 'queued', 'cancelling', 'compiling'].includes(job.status) || !Number.isSafeInteger(job.ownerPid) || job.ownerPid <= 0 || job.ownerPid === process.pid) return false;
  try { process.kill(job.ownerPid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}
function languageTag(value) { if (typeof value !== 'string' || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value) || Object.hasOwn(Object.prototype, value)) fail('INVALID_INPUT', 'Invalid language tag.'); return value; }
export function buildInputHash({ engine, mainFile, files }) {
  return inputManifestIdentity({ engine, mainFile, files: files.map(item => ({ path: item.path, hash: hash(item.bytes) })) });
}
async function atomicJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, filename);
}
async function boundedDisplayArtifact(filename, limit) {
  const checkPath = async () => { let cursor = path.resolve(filename); for (;;) { if ((await lstat(cursor)).isSymbolicLink()) fail('REFERENCE_CONTEXT_UNSAFE', 'Display reference artifacts cannot traverse reparse paths.'); const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent; } };
  await checkPath(); const before = await lstat(filename);
  if (!before.isFile() || before.nlink !== 1 || before.size > limit) fail('REFERENCE_CONTEXT_UNSAFE', 'Display reference artifacts must be bounded unaliased files.');
  const handle = await open(filename, 'r');
  try {
    const opened = await handle.stat(); if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.size > limit) fail('REFERENCE_CONTEXT_UNSAFE', 'Display reference artifact identity changed before reading.');
    const bytes = Buffer.alloc(opened.size + 1); let count = 0;
    while (count < bytes.length) { const read = await handle.read(bytes, count, bytes.length - count, count); if (!read.bytesRead) break; count += read.bytesRead; }
    const after = await handle.stat(), named = await lstat(filename); await checkPath();
    if (count !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.nlink !== 1 || named.ino !== opened.ino || named.dev !== opened.dev || named.nlink !== 1) fail('REFERENCE_CONTEXT_CHANGED', 'Display reference artifact changed while reading.');
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}
function insideDirectory(root, filename) { const relative = path.relative(path.resolve(root), path.resolve(filename)); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
const freshFlow = projectId => ({ schemaVersion: 1, projectId, builds: [], transactions: [], jobs: [], acceptances: [], lastBaselineBuildId: null });

/** Trusted local application controller. Model tools never receive its promotion methods. */
export class PaperApplication extends EventEmitter {
  constructor({ dataRoot, compiler = null, writer = null, chat = null, versionPair = null, engine = 'xelatex', preferredModel = null, preferredEffort = null }) {
    super();
    this.dataRoot = dataRoot; this.core = new PaperService({ dataRoot });
    this.reading = new ReadingWorkspace(this);
    this.reviews = new ReviewWorkflow(this);
    this.sync = new SyncWorkflow(this);
    this.cycles = new ReviewCycle(this); this.versionPair = versionPair;
    this.pdfSelection = new PdfSelection(this);
    this.compiler = compiler; this.writer = writer || new WindowsSourceWriter({ dataRoot: path.join(dataRoot, 'native-writer') });
    this.opinionMath = new OpinionMathRenderer({ compiler });
    this.chat = chat; this.engine = engine; this.defaultEngine = engine; this.flow = null; this.preferredModel = preferredModel; this.preferredEffort = preferredEffort;
    this.probe = { available: false, isolated: false }; this.jobs = new Map(); this.controllerId = randomUUID();
    this.chat?.on?.('change', () => this.emit('change'));
  }
  async initialize() {
    if (this.compiler) this.probe = await this.compiler.probe().catch(error => ({ available: false, isolated: false, reason: error.code || error.message }));
    return { ...this.probe };
  }
  getProjectRoot() { return this.core.getProjectRoot(); }
  listProjectSources(input) { return listProjectSources(this, input); }
  readProjectSource(input) { return readProjectSource(this, input); }
  prepareReviewOrganization(input, options) { this.organization ||= new ReviewOrganizationWorkflow(this); return this.organization.prepare(input, options); }
  getReviewOrganizationContext(input, options) { this.organization ||= new ReviewOrganizationWorkflow(this); return this.organization.context(input, options); }
  submitReviewOrganization(input, options) { this.organization ||= new ReviewOrganizationWorkflow(this); return this.organization.submit(input, options); }
  runReviewOrganization(input) { this.organization ||= new ReviewOrganizationWorkflow(this); return this.organization.run(input); }
  revalidateReviewImport(input) { return revalidateReviewImport(this, input); }
  reopenReviewImportNote(input) { return reopenReviewImportNote(this, input); }
  prepareReviewAnchors(input, options) { this.reviewAnchors ||= new ReviewAnchorWorkflow(this); return this.reviewAnchors.prepare(input, options); }
  getReviewAnchorContext(input, options) { this.reviewAnchors ||= new ReviewAnchorWorkflow(this); return this.reviewAnchors.context(input, options); }
  submitReviewAnchors(input, options) { this.reviewAnchors ||= new ReviewAnchorWorkflow(this); return this.reviewAnchors.submit(input, options); }
  confirmReviewAnchor(input) { this.reviewAnchors ||= new ReviewAnchorWorkflow(this); return this.reviewAnchors.confirm(input); }
  runReviewAnchors(input) { this.reviewAnchors ||= new ReviewAnchorWorkflow(this); return this.reviewAnchors.run(input); }
  connectExistingChat(input) { return connectExistingChat(this, input); }
  prepareBackgroundBinding(input) { this.backgroundConnection ||= new BackgroundConnection(this); return this.backgroundConnection.remember(input); }
  backgroundConnectionPrepare(input) { this.backgroundConnection ||= new BackgroundConnection(this); return this.backgroundConnection.prepare(input); }
  backgroundConnectionActivate(input) { this.backgroundConnection ||= new BackgroundConnection(this); return this.backgroundConnection.activate(input); }
  backgroundConnectionStatus(input) { this.backgroundConnection ||= new BackgroundConnection(this); return this.backgroundConnection.status(input); }
  backgroundConnectionRelease(input) { this.backgroundConnection ||= new BackgroundConnection(this); return this.backgroundConnection.release(input); }
  async persistNativeRelayMessages(messages){if(!this.flow||!this.core.getState().project)return;const projectId=this.core.getState().project.id;return this._flowAction(()=>{if(this.flow.projectId===projectId)this.flow.nativeChatMessages=clone(mergeNativeRelayMessages(this.flow.nativeChatMessages,messages,projectId));});}
  getState() {
    const state = this.reading.state(this.core.getState());
    const own = this.flow?.projectId === state.project?.id ? this.flow : null;
    const secure = Boolean(this.probe.available && this.probe.isolated);
    const reviewBatches = (state.reviewBatches || []).map(batch => batch.origin === 'external' ? { ...batch, revision: batch.revision ?? 1, active: batch.status !== 'retired' && batch.active !== false } : batch);
    const retiredImports = new Set(reviewBatches.filter(batch => batch.origin === 'external' && !batch.active).map(batch => batch.batchId));
    const reference = this._markdownReferences && this._markdownReferenceIdentity(this.flow?.builds.find(build => build.buildId === this._markdownReferences.buildId), state.project) === this._markdownReferences.identity ? this._markdownReferences : null;
    const markdownKey = `${state.project?.id || ''}:${state.project?.snapshotId || ''}:${reference?.key || ''}`;
    if (this._markdownContext?.key !== markdownKey) {
      let value = { macros: {}, references: { labels: {}, citations: {} }, diagnostics: [], contextKey: markdownKey, snapshotId: state.project?.snapshotId || null };
      if (state.project) { try { value = createMarkdownContext({ state, files: [...this.core._files.values()].map(file => ({ path: file.path, bytes: file.bytes })), referenceContext: reference?.context || null }); } catch { value.diagnostics.push({ code: 'MARKDOWN_CONTEXT_UNAVAILABLE', message: 'Display macros are unavailable for this snapshot; unsupported objects retain their source.' }); } }
      if (reference) { value.contextKey = hash(`${value.contextKey}:${reference.key}`); value.diagnostics.push(...reference.diagnostics); if (reference.context) value.referenceProvenance = { type: 'verified-build-output', displayOnly: true, auxiliaryHashAttestedAtBuild: false, buildId: reference.buildId, snapshotId: reference.context.snapshotId, inputHash: reference.context.inputHash, pdfHash: reference.context.pdfHash, auxHash: reference.auxHash }; }
      this._markdownContext = { key: markdownKey, value };
    }
    state.markdownContext = clone(this._markdownContext.value);
    state.reviewImportValidation = deriveReviewImportValidation(state, state, { transactions: own?.transactions || [], proposals: state.proposals || [] });
    state.reviewOperations = { organization: this.organization?.progress?.() || [], anchors: this.reviewAnchors?.progress?.() || [] };
    const liveRelay=this.nativeRelay?.getState?.();
    return { ...state, displayPreferences:this.getDisplayPreferences(), nativeChatRelay:{...liveRelay,messages:mergeNativeRelayMessages(own?.nativeChatMessages,liveRelay?.messages,state.project?.id)}, backgroundConnection: this.backgroundConnection?.state() || { phase: 'inactive', serviceOnline: Boolean(this.backgroundMode), binding: own?.nativeChatBinding || own?.backgroundChatReference || null }, nativeChatBinding: own?.nativeChatBinding || own?.backgroundChatReference || null, nativeChatBindingError: this._nativeBindingError || null, reviewNotes: (state.reviewNotes || []).filter(note => !retiredImports.has(note.batchId)), reviewHistory: (state.reviewHistory || []).filter(note => !retiredImports.has(note.batchId)), reviewHistoryPreferences: reviewHistoryPreferences(state), pdfSelection: this.pdfSelection.state(), languagePreferences: this.pdfSelection.languages(), syncPreferences: this.sync.preferences(state.syncPreferences), versionPair: this.versionPair?.state?.() || null, reviewCycleContext: this.cycles.state(), capabilities: { ...state.capabilities, backgroundConnection: Boolean(this.backgroundMode), existingChatBinding: typeof this.createBoundChat === 'function', nativePdfContext: true, secureCompile: secure, directApply: secure && process.platform === 'win32', codexChat: Boolean(this.chat),
      reasons: { secureCompile: secure ? '' : this.probe.reason || 'No verified isolated compiler is configured.', directApply: secure ? '' : 'A successful exact isolated build is required before source promotion.' } },
      builds: (own?.builds || []).map(({ pdfPath, synctexPath, logPath, ...item }) => ({ ...clone(item), stale: (item.promotedSnapshotId || item.snapshotId) !== state.project?.snapshotId })),
      englishBuilds: (own?.builds || []).filter(item => item.kind === 'english').map(({ pdfPath, synctexPath, logPath, ...item }) => ({ ...clone(item), stale: item.snapshotId !== state.project?.snapshotId })),
      transactions: (own?.transactions || []).map(({ originals, candidate, readSet, beforeSegments, beforeReadingAnchors, draftRebases, acceptanceHash, ...item }) => clone(item)),
      orphanedDrafts: Object.entries(state.translations).flatMap(([language, drafts]) => Object.entries(drafts).filter(([segmentId, draft]) => !(draft.sourceSegmentIds || [segmentId]).some(id => state.segments.some(segment => segment.id === id) || state.readingParagraphs.some(segment => segment.id === id))).map(([segmentId, draft]) => ({ ...draft, segmentId, language, status: 'stale' }))),
      reviewBatches: reviewBatches.map(batch => (own?.jobs || []).some(job => job.batchId === batch.batchId && stoppedJobOwner(job)) ? { ...batch, status: 'interrupted', error: { code: 'CONTROLLER_STOPPED', message: 'The controller stopped before review completion; preserved reading progress is incomplete.' } } : batch),
      jobs: (own?.jobs || []).map(job => stoppedJobOwner(job) ? { ...clone(job), status: 'interrupted', error: { code: 'CONTROLLER_STOPPED' }, controllable: false } : { ...clone(job), controllable: Boolean(this.jobs.get(job.jobId) && !this.jobs.get(job.jobId).finished) }), compiler: { engine: this.engine, supportedEngines: ['xelatex', 'pdflatex'] }, watcher: clone(this.watchState || { enabled: false }), chat: this.chat?.getState?.() || null };
  }
  async refreshExternalJobStatus() {
    const unchanged = { changed: false, updatedJobIds: [] }, flow = this.flow, store = this.core._store;
    const projectId = this.core.getState().project?.id;
    const active = job => ['running', 'queued', 'cancelling', 'compiling'].includes(job?.status);
    const foreign = job => active(job) && typeof job.jobId === 'string' && typeof job.kind === 'string' && job.kind.length <= 128 && Number.isSafeInteger(job.ownerPid) && job.ownerPid > 0 && job.ownerPid !== process.pid && !this.jobs.has(job.jobId) && (job.ownerControllerId == null || typeof job.ownerControllerId === 'string');
    if (!store || !projectId || flow?.schemaVersion !== 1 || flow.projectId !== projectId || !Array.isArray(flow.jobs) || !flow.jobs.some(foreign)) return unchanged;
    let persisted, handle;
    try {
      const filename = path.join(store, 'workflow.json'), info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) return unchanged;
      handle = await open(filename, 'r'); const opened = await handle.stat();
      if (!opened.isFile() || opened.size > 16 * 1024 * 1024) return unchanged;
      const bytes = Buffer.alloc(opened.size + 1); let length = 0;
      while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
      if (length > opened.size) return unchanged;
      persisted = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    } catch { return unchanged; }
    finally { await handle?.close(); }
    // The file is metadata from another controller. It cannot replace this
    // controller's builds, transactions, live jobs or current project binding.
    if (this.flow !== flow || this.core._store !== store || this.core.getState().project?.id !== projectId || persisted?.schemaVersion !== 1 || persisted.projectId !== projectId || !Array.isArray(persisted.jobs) || persisted.jobs.length > 10000 || new Set(persisted.jobs.map(job => job?.jobId)).size !== persisted.jobs.length) return unchanged;
    const records = new Map(persisted.jobs.map(job => [job?.jobId, job])), updatedJobIds = [];
    const identity = ['jobId', 'ownerPid', 'ownerControllerId', 'kind', 'type', 'snapshotId', 'batchId', 'requestId', 'transactionId', 'threadId', 'turnId', 'createdAt'];
    for (let i = 0; i < flow.jobs.length && updatedJobIds.length < 256; i++) {
      const current = flow.jobs[i], next = records.get(current?.jobId);
      if (!foreign(current) || !next || !['completed', 'failed', 'cancelled', 'interrupted', 'stale'].includes(next.status) || identity.some(key => next[key] !== current[key]) || Buffer.byteLength(JSON.stringify(next)) > 1024 * 1024) continue;
      flow.jobs[i] = clone(next); updatedJobIds.push(current.jobId);
    }
    if (updatedJobIds.length) this.emit('change');
    return { changed: updatedJobIds.length > 0, updatedJobIds };
  }
  async _loadFlow() {
    if (!this.core._store) { this.flow = null; return; }
    try { this.flow = JSON.parse(await readFile(path.join(this.core._store, 'workflow.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') fail('RECOVERY_REQUIRED', 'Workflow state is unreadable; preserve it for recovery.'); this.flow = freshFlow(this.core.getState().project.id); }
    if (this.flow.schemaVersion !== 1 || this.flow.projectId !== this.core.getState().project.id) fail('RECOVERY_REQUIRED', 'Workflow identity does not match the selected paper.');
    this.engine = ['xelatex', 'pdflatex'].includes(this.flow.engine) ? this.flow.engine : this.defaultEngine;
  }
  async _persistFlow() { await atomicJson(path.join(this.core._store, 'workflow.json'), this.flow); this.emit('change'); }
  async _flowAction(work) {
    return this.core._serial(async () => { await this._loadFlow(); const value = await work(); await this._persistFlow(); return value; });
  }
  async openProject(input) {
    const projectId=this.core.getState().project?.id;
    const relayBusy=(this.nativeRelay?.getState?.()?.messages||[]).some(message=>!message.historical&&message.projectId===projectId&&['claimed','sent','unknown'].includes(message.status));
    if (relayBusy || this._switching || this._pendingOps || this.chat?.getState?.().busy || [...this.jobs.values()].some(job => !job.finished)) fail('PROJECT_BUSY', 'Wait for or cancel the current paper operation before switching projects.');
    this._switching = true;
    try { await this.core.openProject(input); await this._loadFlow(); if (this.core.getState().project) await this.core._serial(() => this.reading.syncLocked()); if (!this.desktopExecutionEnabled && (this.flow?.nativeChatBinding || this.flow?.backgroundChatReference)) { try { await restoreExistingChat(this); this._nativeBindingError = null; } catch (error) { this._nativeBindingError = { code: error.code || 'CHAT_BINDING_RECOVERY_REQUIRED', message: error.message }; } } this.versionPair?.schedule?.(); this.emit('change'); return this.getState(); }
    finally { this._switching = false; }
  }
  async readVersionPair() { return this._projectOperation(async () => { if (!this.versionPair?.read) fail('VERSION_PAIR_REQUIRED', 'The original/latest PDF pair is unavailable.'); return this.versionPair.read(); }); }
  _projectOperation(work) {
    if (this._switching) fail('PROJECT_BUSY', 'The paper project is switching.');
    this.core._requireProject(); this._pendingOps = (this._pendingOps || 0) + 1;
    return Promise.resolve().then(work).finally(() => { this._pendingOps--; });
  }
  async configureEngine({ engine }) {
    if (!['xelatex', 'pdflatex'].includes(engine)) fail('INVALID_INPUT', 'Choose an allowlisted TeX engine.');
    if (engine === this.engine) return { engine };
    if (this._pendingOps || [...this.jobs.values()].some(job => !job.finished)) fail('PROJECT_BUSY', 'Finish current paper work before changing its compiler.');
    return this._projectOperation(() => this._flowAction(() => {
      this.engine = engine; this.flow.engine = engine;
      for (const transaction of this.flow.transactions) if (transaction.state === 'ready') transaction.state = 'stale';
      this.flow.acceptances = []; this._watchCompilePending = true;
      return { engine };
    }));
  }
  async refreshProject() {
    await this.core._serial(async () => {
      this.core._requireProject();
      const project = this.core.getState().project;
      await this.core._openProject({ root: this.core.getProjectRoot(), mainFile: project.mainFile, sourceLanguage: project.sourceLanguage, targetLanguage: project.targetLanguage });
      await this.reading.syncLocked();
      await this._loadFlow();
    }, { reload: false });
    this.emit('change'); return this.getState();
  }
  startWatching({ intervalMs = 1000, debounceMs = 600, autoCompile = true, initialCompile = true } = {}) {
    this.stopWatching(); this.watchState = { enabled: true, autoCompile, status: 'watching' };
    let baseline = null, pending = null, changedAt = 0, busy = false, projectId = null;
    const tick = async () => {
      if (busy || !this.core._state.project || this.flow?.transactions.some(item => ['committing', 'recovering', 'recoveryRequired'].includes(item.state))) return;
      busy = true;
      try {
        const state = this.core.getState();
        if (projectId !== state.project.id) { projectId = state.project.id; baseline = null; pending = null; }
        const names = [...new Set([...state.project.files.map(item => item.path), ...state.project.diagnostics.filter(item => item.code === 'DEPENDENCY_MISSING').map(item => item.path)])].sort();
        const signature = JSON.stringify(await Promise.all(names.map(async name => { try { const info = await lstat(path.join(this.core.getProjectRoot(), name)); return [name, info.mtimeMs, info.ctimeMs, info.size, info.isSymbolicLink()]; } catch (error) { if (error.code === 'ENOENT') return [name, 'missing']; throw error; } })));
        if (baseline === null) { baseline = signature; if (initialCompile && !this.flow?.lastEnglishBuildId) this._watchCompilePending = true; }
        else if (signature !== baseline) {
          if (pending !== signature) { pending = signature; changedAt = Date.now(); }
          else if (Date.now() - changedAt >= debounceMs) {
            const previous = state.project.snapshotId;
            await this.refreshProject(); baseline = signature; pending = null;
            if (this.core.getState().project.snapshotId !== previous) {
              await this._flowAction(() => { for (const transaction of this.flow.transactions) if (['compiling', 'ready'].includes(transaction.state)) transaction.state = 'stale'; this.flow.acceptances = []; });
              this._watchCompilePending = true;
            }
          }
        } else pending = null;
        if (autoCompile && this._watchCompilePending && ![...this.jobs.values()].some(job => !job.finished) && this.probe.available && this.probe.isolated) {
          this._watchCompilePending = false;
          const current = this.core.getState();
          const promoted = this.flow?.builds.find(item => item.buildId === this.flow.lastEnglishBuildId);
          if ((promoted?.promotedSnapshotId || promoted?.snapshotId) !== current.project.snapshotId || promoted?.engine !== this.engine) await this.compileEnglish();
        }
        Object.assign(this.watchState, { status: 'watching', code: null });
      } catch (error) { Object.assign(this.watchState, { status: 'error', code: error.code || 'WATCH_FAILED' }); this.emit('change'); }
      finally { busy = false; }
    };
    this._watchTimer = setInterval(tick, Math.max(20, intervalMs)); this._watchTimer.unref?.(); void tick();
    return this.getState().watcher;
  }
  stopWatching() { if (this._watchTimer) clearInterval(this._watchTimer); this._watchTimer = null; this._watchCompilePending = false; this.watchState = { enabled: false }; }
  async close() { closeNativePdfContext(this); this.translationTasks?.close?.(); this.stopWatching(); this._reviewHistoryClearPlans?.clear(); this._reviewImportDeletePlans?.clear(); for (const job of this.jobs.values()) if (!job.finished && job.controller) job.controller.abort(); await this.opinionMath.close?.(); await this.chat?.close(); }
  getDisplayPreferences() {
    const value=this.flow?.projectId===this.core._state.project?.id?this.flow?.displayPreferences:null;
    return {translationTextSize:Number.isInteger(value?.translationTextSize)&&value.translationTextSize>=14&&value.translationTextSize<=28?value.translationTextSize:17,revision:Number.isSafeInteger(value?.revision)&&value.revision>=0?value.revision:0};
  }
  async configureDisplayPreferences(input,{beforeWrite=null}={}) {
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['translationTextSize','expectedProjectId','expectedRevision'].includes(k))||!Number.isInteger(input.translationTextSize)||input.translationTextSize<14||input.translationTextSize>28||typeof input.expectedProjectId!=='string'||!input.expectedProjectId||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)fail('INVALID_INPUT','Use a text size from 14 to 28 and the current project/settings revision.');
    return this._projectOperation(()=>this._flowAction(async()=>{
      if(beforeWrite)await beforeWrite();
      if(this.core._state.project?.id!==input.expectedProjectId)fail('VERSION_CONFLICT','The selected paper changed; keep its display preferences separate.');
      const current=this.getDisplayPreferences();if(current.revision!==input.expectedRevision)fail('VERSION_CONFLICT','The text-size preference changed. Read its current revision before updating.');
      const result={translationTextSize:input.translationTextSize,revision:current.revision+1};this.flow.displayPreferences=result;return clone(result);
    }));
  }
  async saveDraft(input) {
    if (this.reading.hasDerived(input.segmentId)||this.core.getState().readingDrafts?.[input.language]?.[input.segmentId]) return this.reading.saveDraft(input);
    const existing = this.core.getState().translations[input.language]?.[input.segmentId];
    if (existing?.unitKind !== 'split') { const value = await this.core.saveDraft(input); this.emit('change'); return value; }
    const result = await this.core._serial(async () => {
      const state = this.core.getState(), current = state.translations[input.language]?.[input.segmentId];
      if (!current || current.revision !== input.expectedRevision) fail('VERSION_CONFLICT', 'The translation unit changed.');
      if (Object.keys(input).some(key => !['segmentId', 'language', 'text', 'expectedRevision'].includes(key)) || typeof input.text !== 'string' || Buffer.byteLength(input.text) > 128 * 1024) fail('INVALID_INPUT', 'Invalid translation unit draft.');
      const source=this.reading.paragraph(current.sourceSegmentIds?.[0])||state.segments.find(s=>s.id===current.sourceSegmentIds?.[0]);
      const draft = { ...current, text: input.text, revision: current.revision + 1, status: 'saved', origin: 'human', updatedAt: stamp() };
      for(const key of['formulaEdits','formulaEditHistory','formulaEditsConflict','formulaEditUnmapped','referenceEdits','referenceEditHistory','referenceEditsConflict','referenceEditUnmapped'])delete draft[key];
      if(source)Object.assign(draft,reconcileFormulaDraft(source,current,input.text,state.project,input.language));
      state.translations[input.language][input.segmentId] = draft; await this.core._commit(state); return draft;
    }); this.emit('change'); return result;
  }
  async editTranslationFormula(input){return this._projectOperation(()=>this.core._serial(async()=>{
    const keys=['segmentId','language','expectedRevision','expectedProjectId','expectedSnapshotId','start','end','before','replacement'];if(!input||Object.keys(input).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(input,k))||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)fail('INVALID_INPUT','Use an exact current formula selection and draft revision.');languageTag(input.language);await this.core._assertSourceCurrent();const state=this.core.getState();if(state.project?.id!==input.expectedProjectId||state.project?.snapshotId!==input.expectedSnapshotId)fail('VERSION_CONFLICT','The selected paper or source changed.');const merged=this.reading.state(state),current=merged.translations[input.language]?.[input.segmentId];if(!current||current.revision!==input.expectedRevision)fail('VERSION_CONFLICT','The translation changed. Save the current text before editing its formula.');const source=this.reading.paragraph(input.segmentId)||state.segments.find(s=>s.id===input.segmentId)||this.reading.paragraph(current.sourceSegmentIds?.[0]);if(!source)fail('SEGMENT_NOT_FOUND','The current source paragraph is unavailable.');const newline=this.core._files.get(source.path)?.text?.includes('\r\n')?'\r\n':'\n';const formulaInput=typeof input.replacement==='string'?{...input,replacement:input.replacement.replace(/\r?\n/g,newline)}:input;const result={...createFormulaDraft(source,current,formulaInput,state.project),appliedReplacement:formulaInput.replacement};const key=this.reading.hasDerived(input.segmentId)||state.readingDrafts?.[input.language]?.[input.segmentId]?'readingDrafts':'translations';state[key]||={};state[key][input.language]||={};state[key][input.language][input.segmentId]=result.draft;await this.core._commit(state);this.emit('change');return result;
  }));}
  async saveTranslationDraftWithFormulaEdits(input,{beforeWrite=null}={}){return this._projectOperation(()=>this.core._serial(async()=>{
    const keys=['segmentId','language','text','expectedRevision','expectedProjectId','expectedSnapshotId'];if(!input||Object.keys(input).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(input,k))||typeof input.segmentId!=='string'||typeof input.text!=='string'||Buffer.byteLength(input.text)>128*1024||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)fail('INVALID_INPUT','Use the complete translation text and its current paper and revision.');languageTag(input.language);const state=this.core.getState();if(state.project?.id!==input.expectedProjectId||state.project?.snapshotId!==input.expectedSnapshotId)fail('VERSION_CONFLICT','The selected paper or source changed.');const merged=this.reading.state(state),existing=merged.translations[input.language]?.[input.segmentId];if((existing?.revision||0)!==input.expectedRevision)fail('VERSION_CONFLICT','The translation changed. Keep the current editor text and reload its latest revision.');const source=this.reading.paragraph(input.segmentId)||state.segments.find(s=>s.id===input.segmentId)||this.reading.paragraph(existing?.sourceSegmentIds?.[0]);if(!source)fail('SEGMENT_NOT_FOUND','The current source paragraph is unavailable.');const current=existing||{segmentId:input.segmentId,language:input.language,text:'',revision:0,sourceHash:source.sourceHash||source.beforeHash},newline=this.core._files.get(source.path)?.text?.includes('\r\n')?'\r\n':'\n';const referenceRegistry=referenceTargetRegistry(this.core._files,state.project),result=createInlineFormulaDraft(source,current,input.text,state.project,{newline,referenceRegistry,language:input.language});const key=this.reading.hasDerived(input.segmentId)||state.readingDrafts?.[input.language]?.[input.segmentId]?'readingDrafts':'translations';state[key]||={};state[key][input.language]||={};state[key][input.language][input.segmentId]=result.draft;if(beforeWrite)await beforeWrite();await this.core._commit(state);this.emit('change');return result;
  }));}
  async reconcileTranslationDraft(input, { beforeWrite = null } = {}) {
    const keys = ['segmentId', 'language', 'expectedRevision', 'expectedProjectId', 'expectedSnapshotId'];
    if (!input || Object.keys(input).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(input, key)) || typeof input.segmentId !== 'string' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail('INVALID_INPUT', 'Choose an exact saved draft and its current paper version.');
    languageTag(input.language);
    return this._projectOperation(() => this._flowAction(async () => {
      await this.core._assertSourceCurrent(); if (beforeWrite) await beforeWrite(); const raw = this.core.getState(), view = this.reading.state(raw), draft = view.translations[input.language]?.[input.segmentId];
      if (raw.project.id !== input.expectedProjectId || raw.project.snapshotId !== input.expectedSnapshotId || draft?.revision !== input.expectedRevision) fail('VERSION_CONFLICT', 'The paper or saved author draft changed. Preserve the editor text and reload its current version.');
      const state = { ...raw, readingParagraphs: view.readingParagraphs }, result = reconcileLegacyConfirmedDraft({ state, transactions: this.flow.transactions, segmentId: input.segmentId, language: input.language });
      if (!result) fail('VERSION_CONFLICT', 'This draft cannot be aligned from an exact confirmed writeback. Its text is preserved; review its source/formula correspondence before generating another candidate.');
      if (result.repaired) { if (beforeWrite) await beforeWrite(); await this._persistFlow(); delete state.readingParagraphs; if (beforeWrite) await beforeWrite(); await this.core._commit(state); }
      return { ...result, draft: clone(result.draft), sourceChanged: false, textChanged: false };
    }));
  }
  async splitTranslation({ segmentId, language, splitAt, expectedRevision }) {
    languageTag(language);
    return this.core._serial(async () => {
      const state = this.core.getState(), draft = state.translations[language]?.[segmentId];
      if (!draft || draft.revision !== expectedRevision) fail('VERSION_CONFLICT', 'Save the current translation before splitting it.');
      if (!Number.isInteger(splitAt) || splitAt <= 0 || splitAt >= draft.text.length || /[\uD800-\uDBFF]/.test(draft.text[splitAt - 1]) && /[\uDC00-\uDFFF]/.test(draft.text[splitAt])) fail('INVALID_INPUT', 'Choose a complete text boundary inside the draft.');
      const sourceIds = draft.sourceSegmentIds || [segmentId];
      const sources = state.segments.filter(segment => sourceIds.includes(segment.id));
      if (!sources.length) fail('ANCHOR_AMBIGUOUS', 'The source alignment is no longer active.');
      for (const source of sources) for (const token of source.protectedTokens) {
        let at = draft.text.indexOf(token.raw);
        while (at >= 0) { if (splitAt > at && splitAt < at + token.raw.length) fail('PROTECTED_TOKEN_CHANGED', 'A protected object cannot be split.'); at = draft.text.indexOf(token.raw, at + token.raw.length); }
      }
      const unitId = `unit-${randomUUID()}`;
      state.translations[language][segmentId] = { ...draft, text: draft.text.slice(0, splitAt), sourceSegmentIds: sourceIds, revision: draft.revision + 1, origin: 'human', status: 'saved' };
      state.translations[language][unitId] = { ...draft, text: draft.text.slice(splitAt), sourceSegmentIds: sourceIds, unitKind: 'split', revision: 1, origin: 'human', status: 'saved' };
      state.alignments ||= [];
      const prior = state.alignments.find(item => item.language === language && item.translationUnitIds.includes(segmentId));
      if (prior) { prior.translationUnitIds.splice(prior.translationUnitIds.indexOf(segmentId) + 1, 0, unitId); prior.revision++; prior.relation = prior.sourceSegmentIds.length === 1 ? 'oneToMany' : 'manyToMany'; }
      else state.alignments.push({ alignmentId: `alignment-${randomUUID()}`, language, sourceSegmentIds: sourceIds, translationUnitIds: [segmentId, unitId], relation: sourceIds.length === 1 ? 'oneToMany' : 'manyToMany', revision: 1, snapshotId: state.project.snapshotId, method: 'humanConfirmed' });
      await this.core._commit(state); this.emit('change'); return this.getState();
    });
  }
  async setAlignment({ language, sourceSegmentIds, translationUnitIds, expectedRevision = null, expectedRevisions = null, expectedSourceSnapshotId = null }) {
    languageTag(language);
    return this.core._serial(async () => {
      const state = this.core.getState();
      if (expectedSourceSnapshotId !== null && expectedSourceSnapshotId !== state.project.snapshotId) fail('VERSION_CONFLICT', 'The source version changed while alignment was being edited.');
      if (!Array.isArray(sourceSegmentIds) || !Array.isArray(translationUnitIds) || !sourceSegmentIds.length || !translationUnitIds.length || new Set(sourceSegmentIds).size !== sourceSegmentIds.length || new Set(translationUnitIds).size !== translationUnitIds.length) fail('INVALID_INPUT', 'Choose a bounded set of distinct source and translation IDs.');
      if (sourceSegmentIds.some(id => !state.segments.some(segment => segment.id === id)) || translationUnitIds.some(id => !Object.hasOwn(state.translations[language] || {}, id) && !state.segments.some(segment => segment.id === id))) fail('ANCHOR_AMBIGUOUS', 'An alignment endpoint is no longer active.');
      state.alignments ||= [];
      const overlapping = state.alignments.filter(item => item.language === language && (item.sourceSegmentIds.some(id => sourceSegmentIds.includes(id)) || item.translationUnitIds.some(id => translationUnitIds.includes(id))));
      if (expectedRevision !== null && overlapping.some(item => item.revision !== expectedRevision)) fail('VERSION_CONFLICT', 'The alignment changed.');
      if (expectedRevisions !== null && (typeof expectedRevisions !== 'object' || Array.isArray(expectedRevisions) || overlapping.some(item => expectedRevisions[item.alignmentId] !== item.revision) || Object.keys(expectedRevisions).some(id => !overlapping.some(item => item.alignmentId === id)))) fail('VERSION_CONFLICT', 'The exact set of alignment revisions changed.');
      state.alignments = state.alignments.filter(item => !overlapping.includes(item));
      const record = { alignmentId: `alignment-${randomUUID()}`, language, sourceSegmentIds, translationUnitIds, revision: Math.max(0, ...overlapping.map(item => item.revision)) + 1,
        relation: sourceSegmentIds.length === 1 ? translationUnitIds.length === 1 ? 'oneToOne' : 'oneToMany' : translationUnitIds.length === 1 ? 'manyToOne' : 'manyToMany', snapshotId: state.project.snapshotId, method: 'humanConfirmed' };
      state.alignments.push(record);
      for (const unitId of translationUnitIds) if (state.translations[language]?.[unitId]) { state.translations[language][unitId].sourceSegmentIds = [...sourceSegmentIds]; state.translations[language][unitId].sourceHashes = Object.fromEntries(sourceSegmentIds.map(id => [id, state.segments.find(item => item.id === id).beforeHash])); }
      await this.core._commit(state); this.emit('change'); return this.getState();
    });
  }
  async createRequest(input) {
    input = { ...input, language: input.language || this.pdfSelection.languages().effectiveTargetLanguage };
    const desktopThreadId = this.desktopExecutionEnabled ? this.desktopThreadId?.() : null;
    if (desktopThreadId) input.bindingId = `desktop:${desktopThreadId}`;
    const requestState = this.core.getState();
    if (input.segmentIds?.some(id => this.reading.hasDerived(id)||requestState.readingDrafts?.[input.language]?.[id])) return this.reading.createRequest(input);
    const threadId = this.chat?.getState?.().threadId;
    const request = await this.core.createRequest({ ...input, bindingId: input.bindingId || (threadId ? `codex:${threadId}` : 'local-preview-manual') });
    return request.bindingId?.startsWith('codex:') ? { ...request, previewMessage: paperRequestPrompt(request) } : request;
  }
  async submitTranslationResult(input, { beforeWrite } = {}) { const request = this.core.getState().requests.find(item => item.requestId === input.requestId); if (request?.origin === 'reviewCycle') fail('PERMISSION_DENIED', 'Cycle translations are published only with their complete atomically validated review result.'); const options = { beforeWrite: async request => { await this.sync.beforeResult(request); await beforeWrite?.(request); } }; if (request?.origin === 'readingView') return this.reading.submitTranslation(input, options); const result = await this.core.submitTranslationResult(input, options); this.emit('change'); return result; }
  importReviewNotes(input) { return this.reviews.import(input); }
  setReviewImportActive(input) { return this.reviews.setImportActive(input); }
  _assertReviewImportDeleteIdle(owned = false) {
    if (this.reviews.starting || this._chatConnecting || this.chat?.getState?.().busy || (this._pendingOps || 0) > (owned ? 1 : 0) || [...this.jobs.values()].some(job => !job.finished) || (this.getState().jobs || []).some(job => ['running', 'queued', 'cancelling', 'compiling'].includes(job.status))) fail('PROJECT_BUSY', 'Finish the active paper operation before deleting an imported review record.');
  }
  _reviewImportDeleteRecord(state, batchId) {
    if (!Array.isArray(state.reviewBatches || []) || !Array.isArray(state.reviewNotes || []) || !Array.isArray(state.reviewHistory || [])) fail('RECOVERY_REQUIRED', 'Saved import records are not valid annotation arrays.');
    const matches = (state.reviewBatches || []).filter(batch => batch.batchId === batchId), batch = matches[0];
    const notes = (state.reviewNotes || []).filter(note => note.batchId === batchId), history = (state.reviewHistory || []).filter(note => note.batchId === batchId);
    if (matches.length !== 1 || batch.origin !== 'external' || !['completed', 'retired'].includes(batch.status) || !/^[a-f0-9]{64}$/i.test(batch.fileHash || '') || [...notes, ...history].some(note => note.origin !== 'external')) fail('PERMISSION_DENIED', 'Only one complete external import record and its external opinions can be deleted.');
    const revision = batch.revision ?? 1; if (!Number.isSafeInteger(revision) || revision < 1) fail('RECOVERY_REQUIRED', 'The imported review revision is invalid.');
    return { batch, notes, history, revision };
  }
  _reviewImportDeleteFingerprint(state, batchId) { return hash(JSON.stringify([state.project?.id, state.project?.snapshotId, (state.reviewBatches || []).filter(batch => batch.batchId === batchId), (state.reviewNotes || []).filter(note => note.batchId === batchId), (state.reviewHistory || []).filter(note => note.batchId === batchId)])); }
  async prepareDeleteReviewImport(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['batchId', 'expectedRevision', 'expectedFileHash'].includes(key)) || typeof input.batchId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.batchId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || typeof input.expectedFileHash !== 'string' || !/^[a-f0-9]{64}$/i.test(input.expectedFileHash)) fail('INVALID_INPUT', 'Choose one exact imported record, file digest and activation revision.');
    this._assertReviewImportDeleteIdle();
    return this._projectOperation(() => this.core._serial(async () => {
      await this._loadFlow(); this._assertReviewImportDeleteIdle(true); await this.core._assertSourceCurrent();
      const state = this.core.getState(), { batch, notes, history, revision } = this._reviewImportDeleteRecord(state, input.batchId);
      if (revision !== input.expectedRevision || batch.fileHash.toLowerCase() !== input.expectedFileHash.toLowerCase()) fail('VERSION_CONFLICT', 'The imported record changed. Refresh the file list before deleting it.');
      const planId = `import-delete-${randomUUID()}`, confirmationToken = randomBytes(32).toString('base64url'), expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
      const summary = { batchId: batch.batchId, filename: batch.filename || 'Imported review', fileHash: batch.fileHash.toLowerCase(), revision, count: notes.length + history.length, activeCount: notes.length, historyCount: history.length, status: batch.status, active: batch.status !== 'retired' && batch.active !== false, originalFileRetained: true };
      this._reviewImportDeletePlans ||= new Map(); for (const [id, plan] of this._reviewImportDeletePlans) if (Date.parse(plan.expiresAt) <= Date.now()) this._reviewImportDeletePlans.delete(id);
      while (this._reviewImportDeletePlans.size >= 8) this._reviewImportDeletePlans.delete(this._reviewImportDeletePlans.keys().next().value);
      this._reviewImportDeletePlans.set(planId, { ...summary, projectId: state.project.id, snapshotId: state.project.snapshotId, fingerprint: this._reviewImportDeleteFingerprint(state, batch.batchId), tokenHash: hash(confirmationToken), expiresAt, consumed: false });
      return { ...summary, planId, confirmationToken, expiresAt };
    }));
  }
  async deleteReviewImport(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['planId', 'confirmationToken'].includes(key)) || typeof input.planId !== 'string' || !/^import-delete-[a-f0-9-]{36}$/.test(input.planId) || typeof input.confirmationToken !== 'string' || input.confirmationToken.length < 20 || input.confirmationToken.length > 128) fail('INVALID_INPUT', 'Confirm one exact prepared import-record deletion.');
    this._assertReviewImportDeleteIdle();
    return this._projectOperation(() => this.core._serial(async () => {
      await this._loadFlow(); this._assertReviewImportDeleteIdle(true);
      const plan = this._reviewImportDeletePlans?.get(input.planId); if (!plan || plan.consumed || Date.parse(plan.expiresAt) <= Date.now() || hash(input.confirmationToken) !== plan.tokenHash) fail('CONFIRMATION_INVALID', 'The import-deletion confirmation is missing, expired or already used.');
      await this.core._assertSourceCurrent(); const next = this.core.getState();
      if (next.project.id !== plan.projectId || next.project.snapshotId !== plan.snapshotId || this._reviewImportDeleteFingerprint(next, plan.batchId) !== plan.fingerprint) fail('IMPORT_DELETE_PLAN_STALE', 'The exact imported record changed; prepare a fresh deletion preview.');
      const { notes, history } = this._reviewImportDeleteRecord(next, plan.batchId);
      next.reviewNotes = (next.reviewNotes || []).filter(note => note.batchId !== plan.batchId); next.reviewHistory = (next.reviewHistory || []).filter(note => note.batchId !== plan.batchId); next.reviewBatches = (next.reviewBatches || []).filter(batch => batch.batchId !== plan.batchId);
      await this.core._commit(next); for (const other of this._reviewImportDeletePlans.values()) if (other.batchId === plan.batchId) other.consumed = true;
      this.emit('change'); return { batchId: plan.batchId, deletedCount: notes.length + history.length, activeDeleted: notes.length, historyDeleted: history.length, originalFileRetained: true };
    }));
  }
  fullPaperReview(input) { return this.reviews.start(input); }
  reviewParagraph(input) { return startParagraphReview(this, input); }
  reviewCycle(input) { return this.cycles.start(input); }
  cacheVersionPairContext(input) { return this.cycles.cache(input); }
  configureLanguages(input,options={}) { return this.pdfSelection.configureLanguages(input,options); }
  recordPdfView(input) { return this.pdfSelection.recordView(input); }
  selectPdfReviewTarget(input, source = 'human') { return this.pdfSelection.select(input, source); }
  cacheActivePdfContext(input) { return this.pdfSelection.cacheActive(input); }
  async getPdfContext(input) { await prepareNativePdfContext(this);return this.pdfSelection.context(input); }
  submitPdfReview(input) { return this.pdfSelection.submit(input); }
  configureSync(input) { return this.sync.configure(input); }
  async configureReviewHistory(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['retain', 'expectedRevision'].includes(key)) || typeof input.retain !== 'boolean' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail('INVALID_INPUT', 'Choose whether future superseded opinions should be retained and provide the exact preference revision.');
    return this._projectOperation(() => this.core._serial(async () => {
      const next = this.core.getState(), prior = reviewHistoryPreferences(next); if (prior.revision !== input.expectedRevision) fail('VERSION_CONFLICT', 'The history preference changed in another window.');
      if (prior.retain === input.retain) return { ...prior, idempotent: true };
      if (prior.revision >= Number.MAX_SAFE_INTEGER) fail('RECOVERY_REQUIRED', 'The history preference revision cannot be incremented.');
      next.reviewHistoryPreferences = { retain: input.retain, revision: prior.revision + 1 }; await this.core._commit(next); this.emit('change'); return clone(next.reviewHistoryPreferences);
    }));
  }
  _reviewHistoryFingerprint(state) { return hash(JSON.stringify([state.project?.id, state.project?.snapshotId, state.reviewNotes || [], state.reviewHistory || [], state.reviewBatches || [], reviewHistoryPreferences(state)])); }
  _reviewHistoryClearCandidates(state, { scope, sourceIds }) {
    const retired = new Set((state.reviewBatches || []).filter(batch => batch.origin === 'external' && (batch.status === 'retired' || batch.active === false)).map(batch => batch.batchId));
    const historical = new Set(projectReviewHistory(this.reading.state(state)).globallyHistoricalIds), selected = new Set(sourceIds || []), seen = new Set(), result = [];
    for (const note of [...(state.reviewNotes || []), ...(state.reviewHistory || [])]) {
      if (!historical.has(note.noteId) || retired.has(note.batchId)) continue;
      const anchors = note.sourceSegmentIds?.length ? note.sourceSegmentIds : note.reviewScopeIds || [];
      if (scope === 'selected' && (!anchors.length || !anchors.every(id => selected.has(id)))) continue;
      if (seen.has(note.noteId)) fail('HISTORY_INDEX_AMBIGUOUS', 'An annotation identity appears more than once; preserve history for recovery.');
      seen.add(note.noteId); result.push(note);
    }
    return result;
  }
  async prepareClearReviewHistory(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['scope', 'sourceIds'].includes(key)) || !['project', 'selected'].includes(input.scope) || input.sourceIds !== undefined && (!Array.isArray(input.sourceIds) || new Set(input.sourceIds).size !== input.sourceIds.length || input.sourceIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(id))) || input.scope === 'selected' && !input.sourceIds?.length || input.scope === 'project' && input.sourceIds?.length) fail('INVALID_INPUT', 'Choose the whole project or exact selected source paragraph IDs.');
    return this._projectOperation(() => this.core._serial(async () => {
      await this.core._assertSourceCurrent(); const state = this.core.getState(), scope = input.scope, sourceIds = [...(input.sourceIds || [])].sort();
      if (!Array.isArray(state.reviewNotes || []) || !Array.isArray(state.reviewHistory || [])) fail('RECOVERY_REQUIRED', 'Saved history is not an annotation array.');
      const known = new Set([...(this.getState().readingParagraphs || []), ...(state.segments || [])].map(source => source.id));
      for (const note of [...(state.reviewNotes || []), ...(state.reviewHistory || [])]) for (const id of [...(note.sourceSegmentIds || []), ...(note.reviewScopeIds || [])]) known.add(id);
      if (sourceIds.some(id => !known.has(id))) fail('INVALID_INPUT', 'A selected paragraph is unknown to this paper and its history.');
      const candidates = this._reviewHistoryClearCandidates(state, { scope, sourceIds }), historyRevision = this._reviewHistoryFingerprint(state), byOrigin = {}, grouped = new Map();
      for (const note of candidates) { byOrigin[note.origin || 'unknown'] = (byOrigin[note.origin || 'unknown'] || 0) + 1; const batch = (state.reviewBatches || []).find(item => item.batchId === note.batchId), key = note.batchId || `origin:${note.origin || 'unknown'}`; if (!grouped.has(key)) grouped.set(key, { batchId: note.batchId || null, origin: note.origin || 'unknown', ...(batch?.filename ? { filename: batch.filename } : {}), ...(batch?.fileHash ? { fileHash: batch.fileHash } : {}), count: 0 }); grouped.get(key).count++; }
      const summary = { count: candidates.length, scope, sourceIds, historyRevision, byOrigin, sources: [...grouped.values()].slice(0, 1000), sourcesTruncated: grouped.size > 1000 };
      if (!candidates.length) return { ...summary, planId: null, confirmationToken: null, expiresAt: null };
      const planId = `history-clear-${randomUUID()}`, confirmationToken = randomBytes(32).toString('base64url'), expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
      this._reviewHistoryClearPlans ||= new Map(); for (const [id, plan] of this._reviewHistoryClearPlans) if (Date.parse(plan.expiresAt) <= Date.now()) this._reviewHistoryClearPlans.delete(id);
      while (this._reviewHistoryClearPlans.size >= 8) this._reviewHistoryClearPlans.delete(this._reviewHistoryClearPlans.keys().next().value);
      this._reviewHistoryClearPlans.set(planId, { ...summary, projectId: state.project.id, snapshotId: state.project.snapshotId, noteIds: candidates.map(note => note.noteId).sort(), tokenHash: hash(confirmationToken), expiresAt, consumed: false });
      return { ...summary, planId, confirmationToken, expiresAt };
    }));
  }
  async clearReviewHistory(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['planId', 'confirmationToken'].includes(key)) || typeof input.planId !== 'string' || !/^history-clear-[a-f0-9-]{36}$/.test(input.planId) || typeof input.confirmationToken !== 'string' || input.confirmationToken.length < 20 || input.confirmationToken.length > 128) fail('INVALID_INPUT', 'Confirm one exact prepared history-clear plan.');
    return this._projectOperation(() => this.core._serial(async () => {
      const plan = this._reviewHistoryClearPlans?.get(input.planId); if (!plan || plan.consumed || Date.parse(plan.expiresAt) <= Date.now() || hash(input.confirmationToken) !== plan.tokenHash) fail('CONFIRMATION_INVALID', 'The history-clear confirmation is missing, expired or already used.');
      await this.core._assertSourceCurrent(); const next = this.core.getState();
      if (next.project.id !== plan.projectId || next.project.snapshotId !== plan.snapshotId || this._reviewHistoryFingerprint(next) !== plan.historyRevision) fail('HISTORY_PLAN_STALE', 'History or its current generation changed; prepare a fresh clear preview.');
      const candidates = this._reviewHistoryClearCandidates(next, plan), ids = candidates.map(note => note.noteId).sort();
      if (JSON.stringify(ids) !== JSON.stringify(plan.noteIds)) fail('HISTORY_PLAN_STALE', 'The exact set of historical annotations changed.');
      const removed = new Set(ids), affected = new Set(candidates.map(note => note.batchId));
      next.reviewNotes = (next.reviewNotes || []).filter(note => !removed.has(note.noteId)); next.reviewHistory = (next.reviewHistory || []).filter(note => !removed.has(note.noteId));
      for (const batch of next.reviewBatches || []) if (affected.has(batch.batchId)) { const count = candidates.filter(note => note.batchId === batch.batchId).length; batch.clearedHistoricalCount = (batch.clearedHistoricalCount || 0) + count; batch.retainedNoteCount = [...next.reviewNotes, ...next.reviewHistory].filter(note => note.batchId === batch.batchId).length; batch.lastHistoryClearedAt = stamp(); }
      await this.core._commit(next); plan.consumed = true; this.emit('change');
      return { clearedCount: ids.length, clearedNoteIds: ids, scope: plan.scope, sourceIds: plan.sourceIds };
    }));
  }
  syncParagraph(input) { return this.sync.start(input); }
  resolveReviewNote(input) { return this.reviews.resolve(input); }
  setReviewDecision(input) { return this.reviews.setDecision(input); }
  anchorReviewNote(input) { return this.reviews.anchor(input); }
  async compileReviewNote(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['noteId', 'expectedRevision'].includes(key)) || typeof input.noteId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.noteId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail('INVALID_INPUT', 'Choose a current opinion and its exact revision.');
    return this._projectOperation(async () => {
      if (!this.probe.available || !this.probe.isolated) fail('COMPILER_UNAVAILABLE', 'Opinion reading requires the verified isolated compiler. Source view remains available.');
      const capture = async () => {
        await this.core._assertSourceCurrent();
        const state = this.getState(), note = state.reviewNotes.find(item => item.noteId === input.noteId);
        if (!note) fail('REVIEW_NOTE_NOT_FOUND', 'The opinion is unavailable or its import is retired.');
        if (note.revision !== input.expectedRevision) fail('VERSION_CONFLICT', 'The opinion changed while its reading view was being prepared.');
        const files = [...this.core._files.values()].map(({ path: filename, bytes }) => ({ path: filename, bytes: Buffer.from(bytes) }));
        return { note: clone(note), state, files, language: state.languagePreferences.effectiveTargetLanguage };
      };
      const captured = await this.core._serial(capture), fingerprint = opinionMathFingerprint(captured);
      // Reading previews use their own cache. They never enter paper builds,
      // version-pair selection, source transactions or the model chat queue.
      const result = await this.opinionMath.render(captured);
      await this.core._serial(async () => {
        if (opinionMathFingerprint(await capture()) !== fingerprint) fail('VERSION_CONFLICT', 'The paper or opinion changed during formula typesetting. Reopen its current reading view.');
      });
      return { ...result, projectId: captured.state.project.id, noteId: captured.note.noteId, noteRevision: captured.note.revision, sourceSnapshotId: captured.state.project.snapshotId, language: captured.language };
    });
  }
  async proposeRevision(input,{beforeWrite}={}) { const result = await this.core.proposeRevision(input, { beforeWrite: async request => {await this.sync.beforeResult(request);await beforeWrite?.(request);} }); this.emit('change'); return result; }
  async editProposal({ proposalId, edits, reason }) {
    return this._flowAction(async () => {
      await this.core._assertSourceCurrent();
      const state = this.core.getState(), previous = state.proposals.find(item => item.proposalId === proposalId);
      if (!previous || previous.reviewState !== 'pending' || previous.applicationState !== 'notApplied') fail('VERSION_CONFLICT', 'The proposal changed or was already reviewed.');
      if (previous.context?.undoOf) fail('INVALID_INPUT', 'An exact inverse proposal cannot be edited; create a separate source revision instead.');
      if (!Array.isArray(edits) || edits.length !== previous.edits.length || reason !== undefined && (typeof reason !== 'string' || reason.length > 8000)) fail('INVALID_INPUT', 'Provide the exact bounded proposal edit set.');
      const seen = new Set();
      const revised = edits.map(edit => {
        if (!edit || Object.keys(edit).some(key => !['segmentId', 'replacement'].includes(key)) || typeof edit.replacement !== 'string' || Buffer.byteLength(edit.replacement) > 128 * 1024 || seen.has(edit.segmentId)) fail('INVALID_INPUT', 'The candidate edit is invalid.');
        seen.add(edit.segmentId);
        const original = previous.edits.find(item => item.segmentId === edit.segmentId);
        const segment = this.core._revisionSource(edit.segmentId, original?.sourceAuthority);
        if (!original || !segment?.translatable || original.beforeHash !== segment.beforeHash) fail('VERSION_CONFLICT', 'This source interval cannot be edited from the old candidate.');
        const request=state.requests.find(r=>r.requestId===previous.context?.requestId),selected=request?.segments.find(s=>s.id===segment.id),effective=request?formulaSourceForRequest(segment,selected,request,state):segment;
        const protectedText=maskRawReplacement(effective,edit.replacement);
        const replacement = restoreProtected(effective, protectedText);
        validateDraftSourceReplacement(segment,selected,replacement);
        const newline = this.core._files.get(segment.path).text.includes('\r\n') ? '\r\n' : '\n';
        return { ...original, replacement: replacement.replace(/\r?\n/g, newline) };
      });
      const proposal = { ...clone(previous), proposalId: `proposal-${randomUUID()}`, author: previous.author === 'human' ? 'human' : 'mixed', edits: revised, reason: reason ?? previous.reason, supersedes: previous.proposalId, createdAt: stamp(), reviewState: 'pending', applicationState: 'notApplied' };
      previous.reviewState = 'superseded'; state.proposals.push(proposal); await this.core._commit(state);
      for (const transaction of this.flow.transactions) if (transaction.proposalIds.includes(previous.proposalId) && ['ready', 'compiling'].includes(transaction.state)) transaction.state = 'stale';
      this.flow.acceptances = this.flow.acceptances.filter(item => !this.flow.transactions.some(transaction => transaction.transactionId === item.transactionId && transaction.state === 'stale'));
      return proposal;
    });
  }
  async addComment({ proposalId = null, segmentIds = [], text }) {
    return this.core._serial(async () => {
      const state = this.core.getState(); this.core._requireProject();
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 16000 || !Array.isArray(segmentIds) || segmentIds.some(id => !state.segments.some(item => item.id === id) && !this.reading.paragraph(id)) || proposalId && !state.proposals.some(item => item.proposalId === proposalId) || !proposalId && !segmentIds.length) fail('INVALID_INPUT', 'A comment needs a current paper anchor and bounded text.');
      const comment = { commentId: `comment-${randomUUID()}`, proposalId, segmentIds, text, author: 'human', revision: 1, resolved: false, sourceSnapshotId: state.project.snapshotId, createdAt: stamp() };
      state.comments ||= []; state.comments.push(comment); await this.core._commit(state); this.emit('change'); return comment;
    });
  }
  async resolveComment({ commentId, expectedRevision, resolved }) {
    return this.core._serial(async () => {
      const state = this.core.getState(), comment = state.comments?.find(item => item.commentId === commentId);
      if (!comment || comment.revision !== expectedRevision) fail('VERSION_CONFLICT', 'The comment changed.');
      if (typeof resolved !== 'boolean') fail('INVALID_INPUT', 'Choose the comment resolution state.');
      Object.assign(comment, { resolved, revision: comment.revision + 1, updatedAt: stamp() }); await this.core._commit(state); this.emit('change'); return comment;
    });
  }
  async rejectProposal(input) {
    const result = await this.core.rejectProposal(input);
    await this._flowAction(() => {
      for (const transaction of this.flow.transactions) if (transaction.proposalIds.includes(input.proposalId) && ['ready', 'compiling'].includes(transaction.state)) transaction.state = 'stale';
      this.flow.acceptances = this.flow.acceptances.filter(item => !this.flow.transactions.some(transaction => transaction.transactionId === item.transactionId && transaction.state === 'stale'));
    }); this.emit('change'); return result;
  }
  exportPatch(input) { return this.core.exportPatch(input); }
  _assertAvailable() { if (!this.probe.available || !this.probe.isolated || !this.compiler) fail('CAPABILITY_UNAVAILABLE', 'The verified isolated compiler is unavailable.'); }
  async _capture(proposalIds = null) {
    return this.core._serial(async () => {
      await this.core._assertSourceCurrent();
      const state = this.core.getState();
      const candidate = proposalIds ? this.core._candidate(proposalIds) : null;
      const replacements = new Map((candidate?.files || []).map(file => [file.path, Buffer.from(file.content)]));
      const files = [...this.core._files.values()].map(file => ({ path: file.path, bytes: Buffer.from(replacements.get(file.path) || file.bytes) }));
      const readSet = [...this.core._files.values()].map(file => ({ path: file.path, hash: file.hash }));
      const originals = (candidate?.files || []).map(file => ({ path: file.path, hash: file.beforeHash, base64: this.core._files.get(file.path).bytes.toString('base64') }));
      const snapshot = { projectId: state.project.id, snapshotId: state.project.snapshotId, mainFile: state.project.mainFile, engine: this.engine, files, candidateHash: candidate?.candidateHash || null };
      snapshot.inputHash = buildInputHash(snapshot);
      return { snapshot, candidate, readSet, originals, beforeReadingAnchors: state.readingAnchors || [], beforeSegments: state.segments.map(({ id, path, startByte, endByte, beforeHash }) => ({ id, path, startByte, endByte, beforeHash })) };
    });
  }
  async compileBaseline() { return this._projectOperation(async () => { this._assertAvailable(); const captured = await this._capture(); return this._queueBuild(captured, 'baseline'); }); }
  async compileEnglish() {
    return this._projectOperation(async () => {
      this._assertAvailable(); const captured = await this._capture();
      const view = this.reading.derive();
      if (view.projections.some(item => !item.supported)) fail('ENGLISH_VIEW_UNSUPPORTED', 'The current bilingual source cannot be projected reliably; inspect the English reading diagnostics.');
      const projected = new Map(view.projections.map(item => [item.path, item]));
      const fileEvidence = [];
      captured.snapshot.files = captured.snapshot.files.map(file => {
        const projection = projected.get(file.path); const bytes = projection ? Buffer.from(projection.text) : file.bytes;
        fileEvidence.push({ path: file.path, originalHash: hash(file.bytes), projectedHash: hash(bytes), changed: Boolean(projection?.changed) });
        return { path: file.path, bytes };
      });
      captured.snapshot.inputHash = buildInputHash(captured.snapshot);
      captured.readingView = { type: 'english-original', sourceSnapshotId: captured.snapshot.snapshotId, projectedFiles: fileEvidence, rulesVersion: 1 };
      return this._queueBuild(captured, 'english');
    });
  }
  async previewTransaction({ proposalIds }) {
    return this._projectOperation(async () => {
    if (!this.probe.available || !this.probe.isolated) return this.core.previewTransaction({ proposalIds });
    const captured = await this._capture(proposalIds);
    const transactionId = `transaction-${randomUUID()}`;
    await this._flowAction(() => {
      if (this.flow.transactions.some(item => ['committing', 'recovering', 'recoveryRequired'].includes(item.state))) fail('PARTIAL_COMMIT_RECOVERY_REQUIRED', 'Resolve the interrupted source transaction before preparing another.');
      this.flow.transactions.push({ transactionId, state: 'compiling', projectId: captured.snapshot.projectId, baseSnapshotId: captured.snapshot.snapshotId, candidateHash: captured.candidate.candidateHash,
        proposalIds: [...proposalIds], candidate: captured.candidate, readSet: captured.readSet, originals: captured.originals, beforeSegments: captured.beforeSegments, beforeReadingAnchors: captured.beforeReadingAnchors, createdAt: stamp(), progress: [] });
    });
    const job = await this._queueBuild(captured, 'candidate', transactionId);
    return { transactionId, candidateHash: captured.candidate.candidateHash, state: 'compiling', ...job };
    });
  }
  async _queueBuild(captured, kind, transactionId = null) {
    const jobId = `job-${randomUUID()}`, controller = new AbortController();
    const record = { jobId, kind, status: 'queued', transactionId, snapshotId: captured.snapshot.snapshotId, ownerPid: process.pid, createdAt: stamp() };
    await this._flowAction(() => { this.flow.jobs.push(record); });
    const runtime = { controller, finished: false, promise: null };
    this.jobs.set(jobId, runtime);
    runtime.promise = (async () => {
      await this._flowAction(() => { this.flow.jobs.find(job => job.jobId === jobId).status = 'running'; });
      let result;
      try {
        result = await this.compiler.build({ ...captured.snapshot, jobId, signal: controller.signal });
        if (result.status === 'success' && (result.inputHash !== captured.snapshot.inputHash || result.snapshotId !== captured.snapshot.snapshotId || result.candidateHash !== captured.snapshot.candidateHash || result.isolation?.verified !== true)) fail('BUILD_IDENTITY_MISMATCH', 'Compiler output does not prove the exact reviewed isolated input.');
        if (result.status === 'success') await this._verifyBuildArtifact(result);
      } catch (error) { result = { buildId: `failed-${jobId}`, status: controller.signal.aborted ? 'cancelled' : 'failed', code: error.code || 'COMPILE_FAILED', message: error.message, snapshotId: captured.snapshot.snapshotId, candidateHash: captured.snapshot.candidateHash, inputHash: captured.snapshot.inputHash, isolation: { verified: false } }; }
      await this._flowAction(() => {
        const job = this.flow.jobs.find(item => item.jobId === jobId);
        Object.assign(job, { status: result.status === 'success' ? 'completed' : result.status, buildId: result.buildId, completedAt: stamp(), code: result.code });
        const build = { ...result, engine: captured.snapshot.engine, jobId, kind, ...(captured.readingView ? { readingView: captured.readingView } : {}), createdAt: stamp(), stale: this.core.getState().project.snapshotId !== captured.snapshot.snapshotId };
        this.flow.builds.push(build);
        if (transactionId) {
          const transaction = this.flow.transactions.find(item => item.transactionId === transactionId);
          Object.assign(transaction, { state: transaction.state === 'stale' ? 'stale' : result.status === 'success' && !build.stale ? 'ready' : result.status === 'cancelled' ? 'cancelled' : 'failed', buildId: result.buildId });
        } else if (result.status === 'success' && !build.stale) { if (kind === 'english') this.flow.lastEnglishBuildId = result.buildId; else this.flow.lastBaselineBuildId = result.buildId; }
      });
      if (kind === 'english' && result.status === 'success') this.versionPair?.schedule?.();
      return clone(result);
    })().finally(() => { runtime.finished = true; this.emit('change'); });
    runtime.promise.catch(() => {});
    return { jobId, status: 'queued', transactionId };
  }
  async waitJob({ jobId }) { const job = this.jobs.get(jobId); if (!job) fail('JOB_NOT_FOUND', 'No live job matches this ID.'); return job.promise; }
  async cancelJob({ jobId }) { const job = this.jobs.get(jobId); if (!job || job.finished) fail('JOB_NOT_RUNNING', 'The job is not running.'); if (job.finalizing) fail('JOB_FINALIZING', 'The completed model result is already being saved; resolve its notes after saving.'); job.controller?.abort(); if (job.kind === 'codex') await this.chat.interrupt(); return { jobId, status: 'cancelling' }; }
  async prepareAcceptance({ transactionId }) {
    this._assertAvailable();
    return this._flowAction(async () => {
      await this.core._assertSourceCurrent();
      const transaction = this.flow.transactions.find(item => item.transactionId === transactionId);
      const build = this.flow.builds.find(item => item.buildId === transaction?.buildId);
      if (!transaction || transaction.state !== 'ready' || !build || build.status !== 'success' || build.isolation?.verified !== true || transaction.candidateHash !== build.candidateHash || transaction.baseSnapshotId !== this.core.getState().project.snapshotId) fail('ACCEPTANCE_NOT_READY', 'Review and compile the exact current candidate before accepting.');
      if(this.core._candidate(transaction.proposalIds).candidateHash!==transaction.candidateHash)fail('CANDIDATE_HASH_MISMATCH','The current source candidate changed after compilation.');
      await this._verifyBuildArtifact(build);
      const token = randomBytes(32).toString('base64url'), expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
      this.flow.acceptances = this.flow.acceptances.filter(item => item.transactionId !== transactionId);
      this.flow.acceptances.push({ transactionId, tokenHash: hash(token), controllerId: this.controllerId, candidateHash: transaction.candidateHash, buildId: build.buildId, expiresAt, consumed: false });
      return { transactionId, confirmationToken: token, candidateHash: transaction.candidateHash, buildId: build.buildId, expiresAt };
    });
  }
  async applyTransaction({ transactionId, confirmationToken, idempotencyKey }) {
    this._assertAvailable();
    if (typeof confirmationToken !== 'string' || confirmationToken.length > 128 || typeof idempotencyKey !== 'string' || idempotencyKey.length > 128 || !idempotencyKey) fail('INVALID_INPUT', 'A UI confirmation and idempotency identity are required.');
    const projectId = this.core.getState().project?.id;
    const result = await this._flowAction(async () => {
      const transaction = this.flow.transactions.find(item => item.transactionId === transactionId);
      if (transaction?.state === 'applied' && transaction.idempotencyKey === idempotencyKey && transaction.acceptanceHash === hash(confirmationToken)) return { transactionId, state: 'applied', snapshotId: transaction.afterSnapshotId, idempotent: true };
      const acceptance = this.flow.acceptances.find(item => item.transactionId === transactionId && item.tokenHash === hash(confirmationToken));
      const build = this.flow.builds.find(item => item.buildId === transaction?.buildId);
      if (!acceptance || acceptance.consumed || acceptance.controllerId !== this.controllerId || Date.parse(acceptance.expiresAt) <= Date.now() || transaction?.state !== 'ready' || acceptance.candidateHash !== transaction.candidateHash || acceptance.buildId !== build?.buildId || build.status !== 'success' || build.isolation?.verified !== true) fail('CONFIRMATION_INVALID', 'The confirmation is expired, used or belongs to another candidate.');
      await this._verifyBuildArtifact(build);
      await this.core._assertSourceCurrent();
      if (transaction.baseSnapshotId !== this.core.getState().project.snapshotId) fail('VERSION_CONFLICT', 'The source changed after candidate review.');
      const reconstructed = this.core._candidate(transaction.proposalIds);
      this._verifyCandidate(transaction, build);
      if (reconstructed.candidateHash !== transaction.candidateHash || JSON.stringify(reconstructed.files.map(item => ({ path: item.path, hash: item.hash }))) !== JSON.stringify(transaction.candidate.files.map(item => ({ path: item.path, hash: item.hash })))) fail('CANDIDATE_HASH_MISMATCH', 'Proposal contents changed after compilation.');
      acceptance.consumed = true;
      Object.assign(transaction, { state: 'committing', idempotencyKey, acceptanceHash: acceptance.tokenHash, committedAt: stamp() });
      transaction.reviewCompletions = captureAdoptedReviewEvidence(this.core.getState(), { transaction, transactions: this.flow.transactions, proposals: this.core.getState().proposals });
      await this._persistFlow();
      const changes = reconstructed.files.map(file => ({ path: file.path, beforeHash: file.beforeHash, hash: file.hash, bytes: Buffer.from(file.content) }));
      try {
        await this.writer.write({ root: this.core.getProjectRoot(), transactionId, readSet: transaction.readSet, changes }, {
          onLocked: async () => { transaction.state = 'committing'; await this._persistFlow(); },
          onProgress: async progress => { transaction.progress.push({ path: progress.path, hash: progress.hash, at: stamp() }); await this._persistFlow(); }
        });
      } catch (error) { transaction.state = ['SOURCE_BUSY', 'VERSION_CONFLICT', 'PERMISSION_DENIED'].includes(error.code) && !transaction.progress.length ? 'conflict' : 'recoveryRequired'; transaction.error = { code: error.code, message: error.message }; await this._persistFlow(); throw error; }
      await this._recordApplied(transaction);
      return { transactionId, state: 'applied', snapshotId: transaction.afterSnapshotId, candidateHash: transaction.candidateHash, buildId: transaction.buildId };
    });
    return this._publishAppliedPdf(result, projectId);
  }
  async _publishAppliedPdf(result, projectId) {
    // Projection builds acquire the core queue themselves; run only after the
    // source transaction has released it. A PDF failure cannot undo a source
    // write that the author already confirmed successfully.
    const current = this.core.getState().project;
    if (result.state !== 'applied' || !result.snapshotId || current?.id !== projectId || current.snapshotId !== result.snapshotId) return result;
    const english = this.flow?.builds.find(item => item.buildId === this.flow.lastEnglishBuildId);
    if (english?.status === 'success' && (english.promotedSnapshotId || english.snapshotId) === current.snapshotId) {
      this.versionPair?.schedule?.();
      return { ...result, englishPdfBuildId: english.buildId };
    }
    const active = this.flow?.jobs.find(item => item.kind === 'english' && item.snapshotId === current.snapshotId && ['queued', 'running', 'compiling'].includes(item.status));
    if (active) return { ...result, englishPdfJobId: active.jobId };
    try { const queued = await this.compileEnglish(); return { ...result, englishPdfJobId: queued.jobId }; }
    catch (error) { return { ...result, englishPdfError: { code: error.code || 'COMPILE_FAILED', message: error.message } }; }
  }
  async _recordApplied(transaction) {
    const before = this.core.getState();
    const beforeReading = this.reading.state(before);
    const previousIds = new Set(before.proposals.map(item => item.proposalId));
    const next = this.core.getState();
    for (const proposal of next.proposals) if (transaction.proposalIds.includes(proposal.proposalId)) { proposal.reviewState = 'approved'; proposal.applicationState = 'applied'; proposal.transactionId = transaction.transactionId; }
    const inverses = next.proposals.filter(item => transaction.proposalIds.includes(item.proposalId) && item.context?.undoOf);
    let history = transaction.beforeSegments || before.segments, readingHistory = transaction.beforeReadingAnchors || before.readingAnchors || [];
    if (inverses.length === 1) {
      const prior = this.flow.transactions.find(item => item.transactionId === inverses[0].context.undoOf);
      if (prior?.beforeSegments) history = prior.beforeSegments;
      if (prior?.beforeReadingAnchors) readingHistory = prior.beforeReadingAnchors;
      if (prior) { prior.revertedBy = transaction.transactionId; prior.revertedAt = stamp(); for (const proposal of next.proposals) if (prior.proposalIds.includes(proposal.proposalId)) proposal.applicationState = 'reverted'; }
    } else {
      const edits = before.proposals.filter(item => transaction.proposalIds.includes(item.proposalId)).flatMap(item => item.edits);
      history = history.map(segment => {
        const relevant = edits.filter(edit => edit.path === segment.path);
        const shift = relevant.filter(edit => edit.endByte <= segment.startByte).reduce((total, edit) => total + Buffer.byteLength(edit.replacement) - (edit.endByte - edit.startByte), 0);
        const overlap = relevant.find(edit => edit.startByte < segment.endByte && edit.endByte > segment.startByte);
        if (overlap && (overlap.startByte !== segment.startByte || overlap.endByte !== segment.endByte)) return segment;
        const reading = readingHistory.some(item => item.id === segment.id && item.path === segment.path && item.startByte === segment.startByte && item.endByte === segment.endByte);
        const replacement = overlap && reading ? overlap.replacement.trim() : overlap?.replacement;
        const leading = overlap && reading ? Buffer.byteLength(overlap.replacement.slice(0, overlap.replacement.length - overlap.replacement.trimStart().length)) : 0;
        return { ...segment, startByte: segment.startByte + shift + leading, endByte: overlap ? segment.startByte + shift + leading + Buffer.byteLength(replacement) : segment.endByte + shift, beforeHash: overlap ? hash(Buffer.from(replacement)) : segment.beforeHash };
      });
      readingHistory = readingHistory.map(paragraph => {
        const relevant = edits.filter(edit => edit.path === paragraph.path);
        const shift = relevant.filter(edit => edit.endByte <= paragraph.startByte).reduce((total, edit) => total + Buffer.byteLength(edit.replacement) - (edit.endByte - edit.startByte), 0);
        const overlap = relevant.find(edit => edit.startByte < paragraph.endByte && edit.endByte > paragraph.startByte);
        if (overlap && (overlap.startByte !== paragraph.startByte || overlap.endByte !== paragraph.endByte)) return paragraph;
        const replacement = overlap?.replacement.trim();
        const leading = overlap ? Buffer.byteLength(overlap.replacement.slice(0, overlap.replacement.length - overlap.replacement.trimStart().length)) : 0;
        return { ...paragraph, startByte: paragraph.startByte + shift + leading, endByte: overlap ? paragraph.startByte + shift + leading + Buffer.byteLength(replacement) : paragraph.endByte + shift, sourceHash: overlap ? hash(Buffer.from(replacement)) : paragraph.sourceHash };
      });
    }
    await this.core._commit(next);
    await this.core._openProject({ root: this.core.getProjectRoot(), mainFile: before.project.mainFile, sourceLanguage: before.project.sourceLanguage, targetLanguage: before.project.targetLanguage }, { segmentHistory: history });
    await this.reading.syncLocked(readingHistory); this._watchCompilePending = true;
    const refreshed = this.core.getState();
    const expected = new Map(transaction.readSet.map(item => [item.path, item.hash]));
    for (const file of transaction.candidate.files) expected.set(file.path, file.hash);
    const exact = refreshed.project.files.length === expected.size && refreshed.project.files.every(file => expected.get(file.path) === file.hash);
    if (exact) {
      const afterReading = this.reading.state(refreshed), undoTransaction = inverses.length === 1 ? this.flow.transactions.find(item => item.transactionId === inverses[0].context.undoOf) : null;
      rebaseConfirmedTranslationDrafts({ before: { ...before, readingParagraphs: beforeReading.readingParagraphs }, after: { ...refreshed, readingParagraphs: afterReading.readingParagraphs }, transaction, registry: referenceTargetRegistry(this.core._files, refreshed.project), undoTransaction });
      // Persist exact replay/undo evidence before changing the private draft
      // projection. Recovery can finish this same rebase without a new grant.
      await this._persistFlow();
      refreshed.proposals = refreshed.proposals.filter(item => previousIds.has(item.proposalId) || item.author !== 'externalUnknown');
      // An accepted source revision requests the new latest view, even if an
      // older original-view request had not yet reached its acknowledgment.
      // The explicitly chosen review scope remains unchanged.
      refreshed.pdfSelection = { ...this.pdfSelection.state(), revision: this.pdfSelection.state().revision + 1, requestedRole: 'latest', activeRole: null, activeBuildId: null, activePdfHash: null, pairId: null };
      await this.core._commit(refreshed);
    }
    Object.assign(transaction, { state: 'applied', afterSnapshotId: exact ? refreshed.project.snapshotId : null, appliedAt: stamp(), sourceChangedAgain: !exact });
    const build = this.flow.builds.find(item => item.buildId === transaction.buildId);
    if (exact && build) {
      build.promotedSnapshotId = refreshed.project.snapshotId; this.flow.lastBaselineBuildId = build.buildId;
      const views = this.reading.derive().projections;
      if (views.every(view => view.supported)) {
        const projected = new Map(views.map(view => [view.path, view.text]));
        const inputHash = buildInputHash({ engine: this.engine, mainFile: refreshed.project.mainFile, files: [...this.core._files.values()].map(file => ({ path: file.path, bytes: projected.has(file.path) ? Buffer.from(projected.get(file.path)) : file.bytes })) });
        if (build.inputHash === inputHash && build.engine === this.engine) { this.flow.lastEnglishBuildId = build.buildId; this._watchCompilePending = false; }
      }
    }
  }
  async createUndoProposal({ transactionId }) {
    return this._flowAction(async () => {
      await this.core._assertSourceCurrent();
      const transaction = this.flow.transactions.find(item => item.transactionId === transactionId);
      if (!transaction || transaction.state !== 'applied' || transaction.afterSnapshotId !== this.core.getState().project.snapshotId) fail('VERSION_CONFLICT', 'The applied version changed; create a reviewed recovery proposal instead of overwriting later edits.');
      const state = this.core.getState();
      const edits = transaction.originals.map(original => {
        const current = this.core._files.get(original.path);
        const applied = transaction.candidate.files.find(file => file.path === original.path);
        if (!current || current.hash !== applied.hash) fail('VERSION_CONFLICT', 'The changed source has later edits.');
        return { kind: 'replace', path: original.path, startByte: 0, endByte: current.bytes.length, beforeHash: current.hash, before: current.text,
          replacement: Buffer.from(original.base64, 'base64').toString('utf8'), protectedTokenIds: [] };
      });
      const proposal = { schemaVersion: 1, proposalId: `undo-${randomUUID()}`, projectId: state.project.id, baseSnapshotId: state.project.snapshotId, author: 'mixed', reviewState: 'pending', applicationState: 'notApplied', reason: 'Restore the exact source bytes from the selected applied transaction.', context: { undoOf: transactionId }, edits, createdAt: stamp() };
      state.proposals.push(proposal); await this.core._commit(state); return clone(proposal);
    });
  }
  async recoverTransactions() {
    const projectId = this.core.getState().project?.id;
    const result = await this._flowAction(async () => {
      const results = [];
      for (const transaction of this.flow.transactions.filter(item => ['committing', 'recovering', 'recoveryRequired'].includes(item.state))) {
        const build = this.flow.builds.find(item => item.buildId === transaction.buildId);
        this._verifyCandidate(transaction, build); await this._verifyBuildArtifact(build);
        const readSet = [], remaining = [];
        for (const entry of transaction.readSet) {
          const bytes = await readFile(path.join(this.core.getProjectRoot(), entry.path)), actual = hash(bytes);
          const changed = transaction.candidate.files.find(file => file.path === entry.path);
          if (actual !== entry.hash && actual !== changed?.hash) { transaction.state = 'recoveryRequired'; await this._persistFlow(); fail('PARTIAL_COMMIT_RECOVERY_REQUIRED', 'Unknown third-party content prevents automatic recovery. Source backups are preserved.'); }
          readSet.push({ path: entry.path, hash: actual });
          if (changed && actual !== changed.hash) remaining.push({ path: changed.path, beforeHash: actual, hash: changed.hash, bytes: Buffer.from(changed.content) });
        }
        transaction.state = 'recovering'; await this._persistFlow();
        await this.writer.write({ root: this.core.getProjectRoot(), transactionId: transaction.transactionId, readSet, changes: remaining }, { onProgress: async progress => { transaction.progress.push(progress); await this._persistFlow(); } });
        await this._recordApplied(transaction); results.push({ transactionId: transaction.transactionId, state: transaction.state });
      }
      return { recovered: results };
    });
    const last = result.recovered.at(-1), transaction = this.flow?.transactions.find(item => item.transactionId === last?.transactionId);
    if (!transaction) return result;
    const publication = await this._publishAppliedPdf({ state: transaction.state, snapshotId: transaction.afterSnapshotId }, projectId);
    return { ...result, ...(publication.englishPdfBuildId ? { englishPdfBuildId: publication.englishPdfBuildId } : {}), ...(publication.englishPdfJobId ? { englishPdfJobId: publication.englishPdfJobId } : {}), ...(publication.englishPdfError ? { englishPdfError: publication.englishPdfError } : {}) };
  }
  async readPdf({ buildId } = {}) {
    const chosen = buildId || this.flow?.lastEnglishBuildId || this.flow?.lastBaselineBuildId;
    if (!chosen) return this.core.readPdf();
    const build = this.flow?.builds.find(item => item.buildId === chosen);
    if (!build || build.status !== 'success' || build.isolation?.verified !== true || !build.pdfPath) fail('PDF_UNAVAILABLE', 'No successful isolated PDF matches the selected build.');
    let bytes;
    try { bytes = await this._verifyBuildArtifact(build); }
    catch (error) { if (this._markdownReferences?.buildId === build.buildId) { this._markdownReferences = null; this._markdownContext = null; this.emit('change'); } throw error; }
    await this._readMarkdownReferences(build);
    return { base64: bytes.toString('base64'), mimeType: 'application/pdf', filename: path.basename(build.pdfPath), provenance: 'verified-isolated-build', snapshotId: build.promotedSnapshotId || build.snapshotId, candidateHash: build.candidateHash, promoted: Boolean(build.promotedSnapshotId), buildId: build.buildId, hash: hash(bytes), kind: build.kind, readingView: build.readingView || null };
  }
  _markdownReferenceIdentity(build, project = this.core.getState().project) {
    if (!project || !build || build.status !== 'success' || build.isolation?.verified !== true || !['english', 'baseline', 'candidate'].includes(build.kind) || (build.promotedSnapshotId || build.snapshotId) !== project.snapshotId || build.kind === 'candidate' && !build.promotedSnapshotId || build.projectId !== project.id || !/^[a-f0-9]{64}$/.test(build.inputHash || '') || !/^[a-f0-9]{64}$/.test(build.pdfHash || '')) return null;
    if (build.kind === 'candidate' && !this.flow?.transactions.some(transaction => transaction.state === 'applied' && transaction.buildId === build.buildId && transaction.afterSnapshotId === project.snapshotId && transaction.candidateHash === build.candidateHash)) return null;
    return hash(JSON.stringify([project.id, project.snapshotId, build.buildId, build.snapshotId, build.promotedSnapshotId || null, build.kind, build.engine, build.inputHash, build.pdfHash, build.pdfPath, build.candidateHash || null]));
  }
  async _readMarkdownReferences(build) {
    const project = this.core.getState().project, identity = this._markdownReferenceIdentity(build, project); if (!identity) return;
    let context = null, auxHash = null, manifestHash = null, code = null;
    try {
      await this.core._assertSourceCurrent();
      const output = path.dirname(build.pdfPath), job = path.dirname(output), compilerRoot = this.compiler?.dataRoot;
      if (typeof compilerRoot !== 'string' || !insideDirectory(compilerRoot, output) || path.basename(output) !== 'output' || path.basename(job) !== build.buildId || path.basename(build.pdfPath) !== 'paper.pdf') fail('REFERENCE_CONTEXT_UNSAFE', 'Reference metadata is outside the exact compiler output directory.');
      const manifestBytes = await boundedDisplayArtifact(path.join(job, 'build-manifest.json'), 1024 * 1024), manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); manifestHash = hash(manifestBytes);
      const projected = build.kind === 'english' ? this.reading.derive().projections : [];
      if (projected.some(item => !item.supported)) fail('REFERENCE_CONTEXT_UNVERIFIED', 'Current English projection is unavailable.');
      const projections = new Map(projected.map(item => [item.path, item.text])), files = [...this.core._files.values()].map(file => ({ path: file.path, bytes: projections.has(file.path) ? Buffer.from(projections.get(file.path)) : file.bytes }));
      const expectedInputHash = buildInputHash({ engine: build.engine, mainFile: project.mainFile, files });
      const expectedFiles = files.map(file => ({ path: file.path, hash: hash(file.bytes) })).sort((a, b) => a.path.localeCompare(b.path));
      if (build.inputHash !== expectedInputHash || manifest.buildId !== build.buildId || manifest.projectId !== project.id || manifest.snapshotId !== build.snapshotId || manifest.inputHash !== expectedInputHash || manifest.pdfHash !== build.pdfHash || manifest.status !== 'success' || manifest.isolation?.verified !== true || manifest.engine !== build.engine || (manifest.candidateHash || null) !== (build.candidateHash || null) || path.resolve(manifest.pdfPath || '') !== path.resolve(build.pdfPath) || !Array.isArray(manifest.inputFiles) || JSON.stringify([...manifest.inputFiles].sort((a, b) => a.path.localeCompare(b.path))) !== JSON.stringify(expectedFiles)) fail('REFERENCE_CONTEXT_UNVERIFIED', 'Reference output does not match the verified current source and PDF build.');
      const auxBytes = await boundedDisplayArtifact(path.join(output, 'paper.aux'), 1024 * 1024); auxHash = hash(auxBytes);
      this._markdownReferencePins ||= new Map();
      if (this._markdownReferencePins.has(identity) && this._markdownReferencePins.get(identity) !== `${manifestHash}:${auxHash}`) fail('REFERENCE_CONTEXT_CHANGED', 'Previously observed reference output changed for this immutable build.');
      const auxText = new TextDecoder('utf-8', { fatal: true }).decode(auxBytes);
      await this.core._assertSourceCurrent();
      if (this._markdownReferenceIdentity(this.flow?.builds.find(item => item.buildId === build.buildId), this.core.getState().project) !== identity) return;
      context = { auxText, verified: true, snapshotId: project.snapshotId, buildId: build.buildId, inputHash: build.inputHash, pdfHash: build.pdfHash };
    } catch (error) { code = ['REFERENCE_CONTEXT_CHANGED', 'REFERENCE_CONTEXT_UNSAFE', 'REFERENCE_CONTEXT_UNVERIFIED'].includes(error.code) ? error.code : 'REFERENCE_CONTEXT_UNAVAILABLE'; }
    if (this._markdownReferenceIdentity(this.flow?.builds.find(item => item.buildId === build.buildId), this.core.getState().project) !== identity) return;
    this._markdownReferencePins ||= new Map();
    if (!this._markdownReferencePins.has(identity)) this._markdownReferencePins.set(identity, context ? `${manifestHash}:${auxHash}` : null);
    while (this._markdownReferencePins.size > 32) this._markdownReferencePins.delete(this._markdownReferencePins.keys().next().value);
    const key = hash(JSON.stringify([identity, manifestHash, auxHash, code])), changed = this._markdownReferences?.key !== key;
    this._markdownReferences = { identity, key, buildId: build.buildId, auxHash, context, diagnostics: code ? [{ code, message: 'Numeric references are unavailable for this build; source labels remain readable.' }] : [] };
    if (changed) { this._markdownContext = null; this.emit('change'); }
  }
  async readBuildLog({ buildId }) {
    const build = this.flow?.builds.find(item => item.buildId === buildId);
    if (!build?.logPath) fail('LOG_UNAVAILABLE', 'This build has no retained compiler log.');
    const handle = await open(build.logPath, 'r');
    try {
      const info = await handle.stat(); if (!info.isFile() || info.size > 32 * 1024 * 1024) fail('LOG_UNAVAILABLE', 'The compiler log exceeds its supported size.');
      const size = Math.min(info.size, 256 * 1024), bytes = Buffer.alloc(size);
      const { bytesRead } = await handle.read(bytes, 0, size, info.size - size);
      return { buildId, text: bytes.subarray(0, bytesRead).toString('utf8'), truncated: info.size > size, sourceSnapshotId: build.snapshotId };
    } finally { await handle.close(); }
  }
  async _locationBuild(buildId) {
    await this.core._assertSourceCurrent();
    const build = this.flow?.builds.find(item => item.buildId === buildId);
    if (!build || build.status !== 'success' || build.isolation?.verified !== true || (build.promotedSnapshotId || build.snapshotId) !== this.core.getState().project.snapshotId || build.kind === 'candidate' && !build.promotedSnapshotId) fail('ANCHOR_UNAVAILABLE', 'Source navigation requires the exact current baseline or promoted build.');
    await this._verifyBuildArtifact(build); return { ...build, navigationSnapshotId: this.core.getState().project.snapshotId };
  }
  async locateSource({ buildId, segmentId }) {
    const build = await this._locationBuild(buildId);
    const segment = this.reading.paragraph(segmentId) || this.core.getState().segments.find(item => item.id === segmentId);
    if (!segment || !this.compiler?.locate) fail('ANCHOR_UNAVAILABLE', 'An exact current source anchor is unavailable.');
    const bytes = this.core._files.get(segment.path)?.bytes;
    if (!bytes) fail('ANCHOR_UNAVAILABLE', 'The source file is unavailable.');
    const prefix = bytes.subarray(0, segment.startByte).toString('utf8'), line = prefix.split('\n').length;
    const result = await this.compiler.locate({ build, sourcePath: segment.path, line, column: 0 });
    await this.core._assertSourceCurrent();
    if (this.core.getState().project.snapshotId !== build.navigationSnapshotId) fail('VERSION_CONFLICT', 'The source changed during navigation.');
    return { ...result, snapshotId: this.core.getState().project.snapshotId, segmentId };
  }
  async locatePdf({ buildId, page, x, y }) {
    const build = await this._locationBuild(buildId);
    if (!this.compiler?.inverse) fail('ANCHOR_UNAVAILABLE', 'Inverse SyncTeX is unavailable.');
    const result = await this.compiler.inverse({ build, page, x, y });
    await this.core._assertSourceCurrent();
    if (this.core.getState().project.snapshotId !== build.navigationSnapshotId) fail('VERSION_CONFLICT', 'The source changed during navigation.');
    const segments = build.kind === 'english' ? this.getState().readingParagraphs : this.core.getState().segments;
    const matches = result.matches.map(match => {
      const file = this.core._files.get(match.sourcePath);
      const lines = file?.text?.split('\n');
      if (!lines || match.line < 1 || match.line > lines.length) return { ...match, segmentIds: [], ambiguous: true };
      const startByte = Buffer.byteLength(lines.slice(0, match.line - 1).join('\n')) + (match.line > 1 ? 1 : 0);
      const endByte = startByte + Buffer.byteLength(lines[match.line - 1]);
      const segmentIds = segments.filter(segment => segment.path === match.sourcePath && segment.startByte <= endByte && segment.endByte > startByte).map(segment => segment.id);
      return { ...match, segmentIds, ambiguous: segmentIds.length !== 1 };
    });
    return { ...result, snapshotId: this.core.getState().project.snapshotId, matches, ambiguous: matches.length !== 1 || matches.some(item => item.ambiguous) };
  }
  async _verifyBuildArtifact(build) {
    if (!build?.pdfPath || !/^[a-f0-9]{64}$/.test(build.pdfHash || '')) fail('BUILD_ARTIFACT_CHANGED', 'The build lacks an exact compiler artifact hash.');
    const handle = await open(build.pdfPath, 'r');
    let bytes;
    try {
      const metadata = await handle.stat(); if (!metadata.isFile() || metadata.size > 20 * 1024 * 1024) fail('INVALID_PDF', 'The compiled PDF exceeds its display limit.');
      const chunks = []; let length = 0;
      for (;;) { const chunk = Buffer.allocUnsafe(Math.min(65536, 20 * 1024 * 1024 + 1 - length)); const result = await handle.read(chunk, 0, chunk.length, null); if (!result.bytesRead) break; length += result.bytesRead; if (length > 20 * 1024 * 1024) fail('INVALID_PDF', 'The compiled PDF grew past its display limit.'); chunks.push(chunk.subarray(0, result.bytesRead)); }
      bytes = Buffer.concat(chunks, length);
    } finally { await handle.close(); }
    if (hash(bytes) !== build.pdfHash || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) fail('BUILD_ARTIFACT_CHANGED', 'The compiled PDF no longer matches the artifact that was reviewed.');
    return bytes;
  }
  _verifyCandidate(transaction, build) {
    if (!transaction?.candidate?.files || !build || build.status !== 'success' || build.isolation?.verified !== true || build.candidateHash !== transaction.candidateHash) fail('CANDIDATE_HASH_MISMATCH', 'The compiled candidate identity is unavailable.');
    const files = transaction.candidate.files;
    for (const file of files) if (hash(Buffer.from(file.content)) !== file.hash || !transaction.readSet.some(item => item.path === file.path && item.hash === file.beforeHash)) fail('CANDIDATE_HASH_MISMATCH', 'Stored candidate bytes changed after review.');
    const aggregate = hash(JSON.stringify({ baseSnapshotId: transaction.baseSnapshotId, proposalIds: [...transaction.proposalIds].sort(), files: files.map(({ path, hash }) => ({ path, hash })).sort((a, b) => a.path.localeCompare(b.path)) }));
    const replacements = new Map(files.map(file => [file.path, file.hash]));
    const compiled = inputManifestIdentity({ engine: build.engine, mainFile: this.core.getState().project.mainFile, files: transaction.readSet.map(item => ({ path: item.path, hash: replacements.get(item.path) || item.hash })) });
    if (aggregate !== transaction.candidateHash || compiled !== build.inputHash) fail('CANDIDATE_HASH_MISMATCH', 'The stored candidate no longer matches its immutable compiled snapshot.');
    if (transaction.originals.length !== files.length || transaction.originals.some(item => hash(Buffer.from(item.base64, 'base64')) !== item.hash || !transaction.readSet.some(entry => entry.path === item.path && entry.hash === item.hash))) fail('CANDIDATE_HASH_MISMATCH', 'The before-image backup does not match the reviewed source.');
  }
  attachChat(chat) { if (this._chatChangeListener) this.chat?.off?.('change', this._chatChangeListener); this.chat = chat; this._chatChangeListener = () => this.emit('change'); chat.on('change', this._chatChangeListener); }
  async _connectChat() {
    if (this.desktopExecutionEnabled) fail('DESKTOP_EXECUTION_REQUIRED', 'This paper sends requests to Desktop. Its model does not run in a second chat connection.');
    return this._projectOperation(async () => {
    if (!this.chat) fail('CAPABILITY_UNAVAILABLE', 'The dedicated Codex chat is not configured.');
    this.core._requireProject();
    if(this.backgroundMode && this.chat?.getState?.().mode!=='bound-existing-chat') fail('CHAT_BINDING_REQUIRED','Connect the verified existing paper chat before sending. No replacement chat is created.');
    const projectId = this.core.getState().project.id;
    if (!this._chatConnecting) this._chatConnecting = (async () => { await this.chat.connect(); await this.chat.bindPaper({ projectId }); })().finally(() => { this._chatConnecting = null; });
    await this._chatConnecting;
    });
  }
  async models() {
    await this._connectChat();
    return { models: await this.chat.listModels(), preferredModel: this.chat.getState().model || this.preferredModel, preferredEffort: this.chat.getState().effort || this.preferredEffort };
  }
  chatState() { return this.chat?.getState() || { connected: false, busy: false, messages: [], lastError: { code: 'CAPABILITY_UNAVAILABLE', message: 'Codex chat is not configured.' } }; }
  async chatStart({ model, effort }) {
    return this._projectOperation(async () => {
    if (this.reviews.starting || [...this.jobs.values()].some(job => job.kind === 'codex' && !job.finished)) fail('CHAT_BUSY', 'Finish or cancel the paper model task before changing its connection.');
    await this._connectChat();
    const current = this.chat.getState();
    if (current.threadId) return this.chat.resumeChat({ threadId: current.threadId, model, effort });
    return this.chat.startChat({ model, effort, title: `Paper Review · ${path.basename(this.core.getState().project.mainFile, '.tex')}` });
    });
  }
  async chatSelectModel(input) {
    const projectId=this.core.getState().project?.id,result=await this.chatStart(input);
    if(result?.mode==='bound-existing-chat')await this._flowAction(()=>{const binding=this.flow?.nativeChatBinding;if(binding?.projectId===projectId&&binding.threadId===result.threadId)this.flow.nativeChatBinding={...binding,model:result.model,effort:result.effort||null};});
    return result;
  }
  async chatSend(input) { return this._projectOperation(async () => {
    if (this.reviews.starting || [...this.jobs.values()].some(job => job.kind === 'codex' && !job.finished)) fail('CHAT_BUSY', 'Finish or cancel the paper model task before sending another message.');
    await this._connectChat();
    if (this.chat.getState().busy) fail('CHAT_BUSY', 'Wait for the active paper reply.');
    this._activeChatScope = { projectId: this.core.getState().project.id, threadId: this.chat.getState().threadId, requestIds: [], turnId: null };
    const started = await this.chat.sendMessage(input); this._activeChatScope.turnId = started.turnId; return started;
  }); }
  async chatInterrupt() { if (!this.chat) fail('CAPABILITY_UNAVAILABLE', 'Codex chat is not configured.'); for (const job of this.jobs.values()) if (job.kind === 'codex' && !job.finished && !job.finalizing) job.controller?.abort(); return this.chat.interrupt(); }
  async chatDisconnect() {
    return this._projectOperation(async () => {
      if (this.reviews.starting || this.chat?.getState?.().busy || [...this.jobs.values()].some(job => job.kind === 'codex' && !job.finished)) fail('CHAT_BUSY', 'Stop or finish the active reply before releasing this paper chat.');
      await this.chat?.close(); this.emit('change'); return this.chatState();
    });
  }
  _approvedChatRequest(requestId, threadId = this.chat?.getState()?.threadId) {
    const request = this.core.getState().requests.find(item => item.requestId === requestId);
    if (!request || request.projectId !== this.core.getState().project.id || request.bindingId !== `codex:${threadId}`) fail('REQUEST_NOT_APPROVED', 'This request is not bound to the selected paper and Codex conversation.');
    return request;
  }
  async handlePaperTool(name, arguments_, context = {}) {
    if (context.threadId && context.threadId !== this.chat?.getState()?.threadId) fail('THREAD_MISMATCH', 'The tool invocation belongs to another conversation.');
    if (this._activeChatScope?.reviewCycleId || this._activeChatScope?.reviewOrganizationId || this._activeChatScope?.reviewAnchorId) fail('PERMISSION_DENIED', 'This review cycle uses only the supplied PDF texts and protected reading index; model tools are unavailable.');
    if (name === 'paper_compile') {
      if (!arguments_ || Object.keys(arguments_).some(key => key !== 'proposalIds') || !Array.isArray(arguments_.proposalIds)) fail('INVALID_INPUT', 'Compilation accepts proposal IDs only.');
      const queued = arguments_.proposalIds.length ? await this.previewTransaction(arguments_) : await this.compileEnglish();
      const built = await this.waitJob({ jobId: queued.jobId });
      await this._flowAction(() => { this.flow.toolEvents ||= []; this.flow.toolEvents.push({ tool: name, threadId: context.threadId || this.chat?.getState()?.threadId, turnId: context.turnId, callId: context.callId, jobId: queued.jobId, buildId: built.buildId, status: built.status, at: stamp() }); });
      return { jobId: queued.jobId, transactionId: queued.transactionId, buildId: built.buildId, status: built.status, inputHash: built.inputHash, pdfHash: built.pdfHash, isolated: built.isolation?.verified === true, diagnostics: built.diagnostics || [], scientificCorrectness: 'author_review_required' };
    }
    const scope = this._activeChatScope, state = this.core.getState();
    const registered = state.requests.find(item => item.requestId === arguments_?.requestId);
    if (!scope || scope.projectId !== state.project?.id || scope.threadId !== context.threadId || !scope.requestIds.includes(arguments_?.requestId) || scope.turnId && scope.turnId !== context.turnId || !registered || registered.status !== 'pending' || registered.snapshotId !== state.project.snapshotId) fail('REQUEST_NOT_APPROVED', 'This paper request is not authorized for the active selected turn.');
    this._approvedChatRequest(arguments_?.requestId);
    if (name === 'paper_get_request') {
      if (Object.keys(arguments_).some(key => key !== 'requestId')) fail('INVALID_INPUT', 'The request tool accepts a registered identity only.');
      const request = this._approvedChatRequest(arguments_.requestId);
      if (Buffer.byteLength(JSON.stringify(request)) > 64 * 1024) fail('INPUT_TOO_LARGE', 'The selected request exceeds the model budget.');
      return request;
    }
    if (name === 'paper_submit_translation') return this.submitTranslationResult(arguments_);
    if (name === 'paper_propose_revision') return this.proposeRevision(arguments_);
    fail('PERMISSION_DENIED', 'The model cannot invoke source writeback, acceptance or undo operations.');
  }
  async runRequest({ requestId }, syncReservation = null) {
    if (this.desktopRequestRunner) return this.desktopRequestRunner({ requestId });
    return this._projectOperation(async () => {
    if (this.reviews.starting && (!syncReservation || syncReservation !== this.sync.reservation) || [...this.jobs.values()].some(job => job.kind === 'codex' && !job.finished)) fail('CHAT_BUSY', 'Finish or cancel the paper model task before another selected request.');
    await this._connectChat();
    const request = this._approvedChatRequest(requestId);
    if (request.status !== 'pending' || request.snapshotId !== this.core.getState().project.snapshotId) fail('VERSION_CONFLICT', 'Create a current pending selection before sending it.');
    if (this.chat.getState().busy) fail('CHAT_BUSY', 'Wait for the active paper reply.');
    this._activeChatScope = { projectId: request.projectId, threadId: this.chat.getState().threadId, requestIds: [requestId], turnId: null };
    const started = await this.chat.sendMessage({ text: paperRequestPrompt(request), outputSchema: paperRequestSchema(request) || undefined });
    this._activeChatScope.turnId = started.turnId;
    const jobId = `codex-${started.turnId}`;
    await this._flowAction(() => { this.flow.jobs.push({ jobId, kind: request.kind, status: 'running', ownerPid: process.pid, requestId, threadId: started.threadId, turnId: started.turnId, createdAt: stamp() }); });
    const runtime = { controller: null, finished: false, kind: 'codex', promise: null };
    this.jobs.set(jobId, runtime);
    runtime.promise = (async () => {
      let turn = null, imported = null, problem = null;
      try {
        turn = await this.chat.waitForTurn(started.turnId);
        if (turn.status !== 'completed' || turn.threadId !== started.threadId) fail(turn.status === 'interrupted' ? 'JOB_CANCELLED' : 'MODEL_TURN_FAILED', 'The Codex turn did not complete successfully.');
        if (request.kind !== 'discussion') {
          const message = this.chat.getState().messages.filter(item => item.role === 'assistant' && item.turnId === started.turnId).at(-1);
          let result; try { result = JSON.parse(message?.text || ''); } catch { fail('STRUCTURED_RESULT_INVALID', 'Codex did not return valid structured paper data.'); }
          if (result.requestId !== requestId) fail('REQUEST_NOT_APPROVED', 'Codex returned a different request identity.');
          this._approvedChatRequest(requestId, started.threadId);
          imported = request.kind === 'translation' ? await this.submitTranslationResult(result) : await this.proposeRevision(result);
        }
      } catch (error) { problem = { code: error.code || 'MODEL_RESULT_FAILED', message: error.message }; }
      await this._flowAction(() => { Object.assign(this.flow.jobs.find(item => item.jobId === jobId), { status: problem ? 'failed' : 'completed', error: problem, result: imported, completedAt: stamp() }); });
      if (problem) throw Object.assign(new Error(problem.message), { code: problem.code });
      return { ...turn, imported };
    })().finally(() => { runtime.finished = true; if (this._activeChatScope?.turnId === started.turnId) this._activeChatScope = null; this.emit('change'); });
    runtime.promise.catch(() => {});
    return { ...started, jobId, status: 'queued' };
    });
  }
}

