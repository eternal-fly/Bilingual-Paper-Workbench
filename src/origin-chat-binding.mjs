import { CodexBridge } from './codex-bridge.mjs';
import { BackgroundConnection } from './background-connection.mjs';
import path from 'node:path';
import { lstat } from 'node:fs/promises';

const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const diagnostic = error => ({ code: /^[A-Z][A-Z0-9_]{1,63}$/u.test(error?.code || '') ? error.code : 'ORIGIN_CHAT_UNAVAILABLE', message: String(error?.message || 'The invoking chat could not be verified.').replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/giu, '[redacted]').slice(0, 1200) });

/** This metadata reader cannot resume, change settings, load turns or start a
 * chat. Its subprocess owns neither the Desktop writer nor a native lease. */
export class OriginMetadataBridge extends CodexBridge {
  constructor({ threadId, ...options }) { super({ ...options, toolSpecs: [], handleTool: null }); if (!id(threadId)) fail('INVALID_INPUT', 'Use the exact invoking chat identity.'); this.originThreadId = threadId; }
  _request(method, params = {}) {
    if (method !== 'initialize' && !(method === 'thread/read' && params.threadId === this.originThreadId && params.includeTurns === false && Object.keys(params).every(key => ['threadId', 'includeTurns'].includes(key)))) return Promise.reject(Object.assign(new Error('The origin reader only verifies exact chat metadata.'), { code: 'METADATA_ONLY' }));
    return super._request(method, params);
  }
}
export async function readOriginChatMetadata({ threadId, dataRoot, cwd, command, signal, Bridge = OriginMetadataBridge }) {
  if (signal?.aborted) fail('ORIGIN_BINDING_CANCELLED', 'The origin verification was cancelled.');
  const bridge = new Bridge({ threadId, dataRoot, cwd, command, requestTimeoutMs: 15000 });
  const abort = () => { void bridge.close(); }; signal?.addEventListener('abort', abort, { once: true });
  try {
    await bridge.connect(); if (signal?.aborted) fail('ORIGIN_BINDING_CANCELLED', 'The origin verification was cancelled.');
    const response = await bridge._request('thread/read', { threadId, includeTurns: false }), thread = response?.thread;
    if (thread?.id !== threadId) fail('THREAD_MISMATCH', 'The metadata belongs to a different chat.');
    if (!id(thread.model) || thread.reasoningEffort != null && !id(thread.reasoningEffort)) fail('ORIGIN_MODEL_UNAVAILABLE', 'The invoking chat did not report verifiable model settings.');
    if (typeof thread.cwd !== 'string' || !path.isAbsolute(thread.cwd) || thread.cwd.length > 4096 || /[\x00-\x1f]/u.test(thread.cwd)) fail('ORIGIN_WORKSPACE_UNAVAILABLE', 'The invoking chat did not report a verifiable project directory.');
    return { threadId, title: String(thread.name || '').replace(/[\x00-\x1f]/gu, '').slice(0, 160), model: thread.model, effort: thread.reasoningEffort || null, cwd: thread.cwd };
  } finally { signal?.removeEventListener('abort', abort); await bridge.close(); }
}
export async function resolveOriginChatCwd({ flow, threadId, fallback }) {
  const origin = [flow?.backgroundChatReference, flow?.nativeChatBinding].find(value => value?.source === 'originating-host-chat' && value.threadId === threadId);
  if (!origin) return fallback;
  if (typeof origin.originCwd !== 'string' || !path.isAbsolute(origin.originCwd) || origin.originCwd.length > 4096 || /[\x00-\x1f]/u.test(origin.originCwd)) fail('ORIGIN_WORKSPACE_UNAVAILABLE', 'The invoking chat project directory requires verification.');
  const info = await lstat(origin.originCwd).catch(() => null);
  if (!info?.isDirectory()) fail('ORIGIN_WORKSPACE_UNAVAILABLE', 'The invoking chat project directory is unavailable; no replacement directory was created.');
  return origin.originCwd;
}

/** Only the trusted launcher supplies the origin. Verification never blocks
 * opening the window. Every late result remains tied to its exact paper. */
export class OriginChatBinding {
  constructor(service, { threadId, readMetadata, retryMs = 2000 } = {}) {
    if (!id(threadId) || typeof readMetadata !== 'function') throw new TypeError('Use the trusted host origin and its metadata reader.');
    this.service = service; this.threadId = threadId; this.readMetadata = readMetadata; this.retryMs = retryMs;
    this.value = { threadId, phase: 'pending-paper', verified: false, autoConnect: true };
    this.timer = null; this.pending = null; this.closed = false; this.generation = 0; this.cached = null; this.retries = 0; this.stoppedScope = null;
    this.onChange = () => this.schedule(); service.on('change', this.onChange); this.schedule();
  }
  state() { return structuredClone(this.value); }
  observeDesktopSelection({ app, projectId, snapshotId, selection }) {
    const project = app.core?.getState?.().project;
    if (this.closed || this.service.active !== app || project?.id !== projectId || project?.snapshotId !== snapshotId || selection.threadId !== this.threadId) return;
    this.cached = { ...this.scope(app, project), selection }; this.value = { ...this.value, ...selection, projectId, snapshotId, verified: true, phase: 'desktop-ready', error: undefined };
  }
  current(app, project, generation) { const next = app.core?.getState?.().project; return !this.closed && !this.service._closing && this.generation === generation && this.service.active === app && next?.id === project.id && next?.snapshotId === project.snapshotId; }
  scope(app, project) { return { app, projectId: project.id, snapshotId: project.snapshotId }; }
  sameScope(scope, app, project) { return scope?.app === app && scope.projectId === project.id && scope.snapshotId === project.snapshotId; }
  reference(app, project) { return [app.flow?.nativeChatBinding, app.flow?.backgroundChatReference].find(value => value?.projectId === project.id && id(value.threadId)); }
  update(patch) { this.value = { ...this.value, ...patch }; this.service.emit('change'); }
  bindingBusy(app) { return this.service._switching || this.service._assistantImportPromise || app._pendingOps || app._bindingPending || app._chatConnecting || app.reviews?.starting || app.chat?.getState?.().busy; }
  busy(app) { return this.bindingBusy(app) || [...(app.jobs?.values?.() || [])].some(job => !job.finished); }
  schedule(delay = 0) { if (this.closed || this.pending || this.timer !== null) return; this.timer = setTimeout(() => { this.timer = null; void this.reconcile(); }, Math.max(0, delay)); this.timer.unref?.(); }
  reconcile() {
    if (this.closed) return Promise.resolve(this.state()); if (this.pending) return this.pending;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    let again = null;
    this.pending = Promise.resolve().then(() => this._run()).then(delay => { again = delay; return this.state(); }).finally(() => { this.pending = null; if (again !== null) this.schedule(again); });
    return this.pending;
  }
  async _run() {
    const service = this.service, app = service.active, project = app.core?.getState?.().project;
    if (!project) { if (this.value.phase !== 'pending-paper') this.update({ phase: 'pending-paper', verified: false, projectId: undefined, snapshotId: undefined }); return null; }
    const generation = this.generation;
    if (this.sameScope(this.stoppedScope, app, project)) return null;
    const existing = this.reference(app, project), savedThread = existing?.threadId || service.currentRecord?.threadId;
    if (savedThread && savedThread !== this.threadId) { this.stoppedScope = this.scope(app, project); this.update({ phase: 'preserved-binding', verified: false, projectId: project.id, snapshotId: project.snapshotId, error: { code: 'EXPLICIT_CHAT_BINDING_PRESERVED', message: 'This paper has an explicitly saved different chat. Its binding was preserved.' } }); return null; }
    if (app.backgroundConnection?.phase === 'released' && this.sameScope(this.cached, app, project)) { this.stoppedScope = this.scope(app, project); this.update({ phase: 'released', autoConnect: false }); return null; }
    if (this.sameScope(this.cached, app, project) && app.backgroundConnection?.phase === 'connected' && app.chat?.getState?.().connected !== false) { if (this.value.phase !== 'connected') this.update({ phase: 'connected', error: undefined }); return null; }
    if (service._switching || service._assistantImportPromise) { this.update({ phase: 'waiting-paper-operation', projectId: project.id, snapshotId: project.snapshotId }); return 250; }
    try {
      if (!this.sameScope(this.cached, app, project)) {
        this.update({ phase: 'verifying', verified: false, projectId: project.id, snapshotId: project.snapshotId, error: undefined });
        this.abort = new AbortController(); let expectedReference = JSON.stringify(existing || null);
        const metadata = await this.readMetadata(this.threadId, { signal: this.abort.signal }); this.abort = null;
        if (!this.current(app, project, generation)) return 0;
        if (metadata?.threadId !== this.threadId || !id(metadata.model) || metadata.effort != null && !id(metadata.effort)) fail('THREAD_MISMATCH', 'The invoking chat or model settings could not be verified.');
        if (typeof metadata.cwd !== 'string' || !path.isAbsolute(metadata.cwd) || metadata.cwd.length > 4096 || /[\x00-\x1f]/u.test(metadata.cwd)) fail('ORIGIN_WORKSPACE_UNAVAILABLE', 'The invoking chat project directory could not be verified.');
        const selection = { threadId: this.threadId, title: String(metadata.title || '').slice(0, 160), model: metadata.model, effort: metadata.effort || null, originCwd: metadata.cwd };
        // Manual binding uses this same reservation. Acquire it synchronously
        // before persisting the reference or awaiting creation of a new client.
        if (this.bindingBusy(app)) fail('CHAT_BUSY', 'Finish the current paper operation before binding its invoking chat.');
        app._bindingPending = true; let expectedChat = app.chat;
        const assertUnchanged = () => {
          if (!this.current(app, project, generation)) fail('ORIGIN_BINDING_CANCELLED', 'The selected paper changed during origin verification.');
          if (JSON.stringify(this.reference(app, project) || null) !== expectedReference || app.chat !== expectedChat) fail('ORIGIN_BINDING_CHANGED', 'A deliberate chat binding changed during origin verification.');
        };
        try {
          await app._flowAction(async () => {
            assertUnchanged(); await app.core._assertSourceCurrent(); assertUnchanged();
            const verifiedAt = new Date().toISOString();
            app.flow.backgroundChatReference = { kind: 'background-chat-reference', projectId: project.id, ...selection, source: 'originating-host-chat', verifiedAt };
            const native = app.flow.nativeChatBinding;
            if (native?.projectId === project.id && native.threadId === this.threadId) app.flow.nativeChatBinding = { ...native, ...selection, source: 'originating-host-chat', verifiedAt };
            expectedReference = JSON.stringify(this.reference(app, project) || null);
          });
          assertUnchanged();
          const chatState = expectedChat?.getState?.();
          if (service.desktopExecution) {
            await expectedChat?.close?.(); assertUnchanged();
            await service.desktopExecution.bind({ app, project, selection }); assertUnchanged();
          } else if (!(chatState?.mode === 'bound-existing-chat' && (chatState.threadId || chatState.boundThreadId) === this.threadId)) {
            let bound;
            try {
              bound = await app.createBoundChat(this.threadId, selection); assertUnchanged();
              await expectedChat?.close?.(); assertUnchanged();
              app.attachChat(bound); expectedChat = bound; bound = null;
            } finally { await bound?.close?.(); }
          }
          if (service.currentRecord?.recordId) {
            const recordId = service.currentRecord.recordId; await service._bindingQueue; assertUnchanged();
            const record = await service.registry.touch(recordId, { threadId: selection.threadId, model: selection.model, effort: selection.effort, boundChatTitle: selection.title });
            assertUnchanged(); if (service.currentRecord?.recordId === recordId) service.currentRecord = record;
          }
          this.cached = { ...this.scope(app, project), selection }; this.retries = 0;
          this.update({ ...selection, phase: service.desktopExecution ? 'desktop-ready' : 'connecting', verified: true, autoConnect: true, error: undefined });
        } finally { app._bindingPending = false; }
      }
      if (!this.current(app, project, generation)) return 0;
      if (service.desktopExecution) {
        if (this.value.phase !== 'desktop-ready') this.update({ phase: 'desktop-ready', error: undefined });
        return null;
      }
      if (this.busy(app)) { this.update({ phase: 'waiting-paper-operation' }); return 500; }
      app.backgroundConnection ||= new BackgroundConnection(app); this.update({ phase: 'connecting', error: undefined });
      const selected = this.cached.selection, plan = await app.backgroundConnection.prepare({ expectedProjectId: project.id, expectedSnapshotId: project.snapshotId, model: selected.model, ...(selected.effort ? { effort: selected.effort } : {}) });
      if (!this.current(app, project, generation)) return 0;
      const connection = await app.backgroundConnection.activate({ handoffId: plan.handoffId, threadId: this.threadId, expectedProjectId: project.id, expectedSnapshotId: project.snapshotId });
      if (!this.current(app, project, generation)) return 0;
      this.update({ phase: connection.phase, error: connection.error || undefined });
      if (connection.phase === 'waiting-desktop-release') return Math.min(30000, this.retryMs * 2 ** Math.min(4, this.retries++)); return null;
    } catch (error) {
      this.abort = null; if (!this.current(app, project, generation)) return 0;
      if (['CHAT_BUSY', 'PROJECT_BUSY', 'IMPORT_BUSY'].includes(error.code)) { this.update({ phase: 'waiting-paper-operation' }); return 500; }
      this.stoppedScope = this.scope(app, project); this.update({ phase: 'failed', error: diagnostic(error) }); return null;
    }
  }
  retry() { if (this.closed) return this.state(); this.generation++; this.abort?.abort(); this.stoppedScope = null; this.cached = null; this.retries = 0; this.update({ autoConnect: true, error: undefined, phase: this.service.active.core?.getState?.().project ? 'verifying' : 'pending-paper' }); this.schedule(); return this.state(); }
  close() { this.closed = true; this.generation++; this.abort?.abort(); if (this.timer !== null) clearTimeout(this.timer); this.timer = null; this.service.off('change', this.onChange); }
}
