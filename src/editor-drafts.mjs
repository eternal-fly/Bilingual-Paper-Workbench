import { createHash, randomUUID } from 'node:crypto';
import { MODEL_TOOL_BYTES } from './request-budgets.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
const languageTag = value => typeof value === 'string' && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const textHash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
function strict(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) fail('INVALID_INPUT', 'Use only the registered editor operation fields.');
}

/** Authenticated UI evidence only. A capture is never a saved translation or
 * permission to promote source. No text is written to a log, cache or workflow. */
export class EditorDraftStore {
  constructor({ getProject, isKnownParagraph = () => false, getParagraphHash = () => null, saveDraft = null,onPublish=null, captureTimeoutMs = 4000, clientTtlMs = 12000, captureTtlMs = 120000, now = Date.now } = {}) {
    if (typeof getProject !== 'function') throw new TypeError('A current paper identity is required.');
    Object.assign(this, { getProject, isKnownParagraph, getParagraphHash, saveDraft,onPublish, captureTimeoutMs, clientTtlMs, captureTtlMs, now });
    this.clients = new Map(); this.captures = new Map(); this.pending = null; this.scopeKey = null;
  }
  close() {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(Object.assign(new Error('The editor service closed.'), { code: 'EDITOR_NOT_CONNECTED' })); this.pending = null; }
    this.clients.clear(); this.captures.clear();
  }
  _scope(input) {
    const project = this.getProject();
    if (!project) fail('PROJECT_REQUIRED', 'Open the current paper before accessing its editor.');
    if (input.expectedProjectId !== project.id || input.expectedSnapshotId !== project.snapshotId) fail('VERSION_CONFLICT', 'The editor request belongs to another paper or source version. Refresh its native paragraph index.');
    const key = `${project.id}:${project.snapshotId}`;
    if (this.scopeKey !== key) { this.close(); this.scopeKey = key; }
    const now = this.now();
    for (const [id, client] of this.clients) if (now - client.seenAt > this.clientTtlMs) this.clients.delete(id);
    for (const [id, capture] of this.captures) if (now - capture.time > this.captureTtlMs) this.captures.delete(id);
    return project;
  }
  _client(input) {
    if (!identifier(input.clientId)) fail('INVALID_INPUT', 'Use this live page’s editor identity.');
    let client = this.clients.get(input.clientId);
    if (!client) {
      if (this.clients.size >= 8) fail('EDITOR_WINDOW_AMBIGUOUS', 'Close duplicate paper windows before capturing editor text.');
      client = { clientId: input.clientId, sequence: -1, seenAt: this.now() }; this.clients.set(input.clientId, client);
    }
    client.seenAt = this.now();
    return client;
  }
  poll(input) {
    strict(input, ['clientId', 'expectedProjectId', 'expectedSnapshotId']);
    const project = this._scope(input), client = this._client(input);
    if (this.pending && this.pending.clientId === null) this.pending.clientId = client.clientId;
    return { projectId: project.id, expectedProjectId: project.id, expectedSnapshotId: project.snapshotId, captureId: this.pending?.clientId === client.clientId ? this.pending.captureId : null };
  }
  publish(input) {
    strict(input, ['clientId', 'expectedProjectId', 'expectedSnapshotId', 'sequence', 'captureId', 'drafts']);
    const project = this._scope(input), client = this._client(input);
    if (!integer(input.sequence) || !Array.isArray(input.drafts) || input.captureId != null && !identifier(input.captureId)) fail('INVALID_INPUT', 'Publish a complete editor snapshot and monotonic sequence.');
    if (Buffer.byteLength(JSON.stringify(input)) > MODEL_TOOL_BYTES) fail('INPUT_TOO_LARGE', 'The live editor snapshot exceeds the local transport budget. The page retains its input.');
    if (input.sequence <= client.sequence) return { accepted: false, sequence: client.sequence };
    const keys = new Set(), drafts = input.drafts.map(row => {
      strict(row, ['segmentId', 'language', 'text', 'baseDraftRevision', 'bufferSequence', 'saveState', 'composing', 'selectionStart', 'selectionEnd', 'sourceSnapshotId', 'baseSourceHash']);
      if (!identifier(row.segmentId) || !this.isKnownParagraph(row.segmentId, row.language) || !languageTag(row.language) || typeof row.text !== 'string' || !integer(row.baseDraftRevision) || !integer(row.bufferSequence) || !['dirty', 'saving', 'saveFailed', 'saved'].includes(row.saveState) || typeof row.composing !== 'boolean') fail('EDITOR_SCOPE_INVALID', 'An editor buffer does not belong to a current paragraph or has invalid capture metadata.');
      const key = `${row.language}:${row.segmentId}`;
      if (keys.has(key)) fail('EDITOR_SCOPE_INVALID', 'Each paragraph/language buffer must appear once.');
      keys.add(key);
      if (row.sourceSnapshotId !== undefined && !identifier(row.sourceSnapshotId) || row.baseSourceHash !== undefined && !/^[a-f0-9]{64}$/u.test(row.baseSourceHash)) fail('INVALID_INPUT', 'Use exact source identity metadata for this editor buffer.');
      for (const property of ['selectionStart', 'selectionEnd']) if (row[property] !== undefined && (!integer(row[property]) || row[property] > row.text.length)) fail('INVALID_INPUT', 'An editor caret must remain inside its exact captured text.');
      const currentHash = this.getParagraphHash(row.segmentId, row.language);
      const staleSource = Boolean(row.baseSourceHash && currentHash && row.baseSourceHash !== currentHash || row.sourceSnapshotId && row.sourceSnapshotId !== project.snapshotId && (!row.baseSourceHash || !currentHash || row.baseSourceHash !== currentHash));
      return { ...row, textHash: textHash(row.text), staleSource };
    });
    client.sequence = input.sequence;
    this.onPublish?.(drafts,project);
    if (input.captureId && this.pending?.captureId === input.captureId && this.pending.clientId === client.clientId) {
      if (this.clients.size !== 1) {
        const pending = this.pending; this.pending = null; clearTimeout(pending.timer);
        pending.reject(Object.assign(new Error('More than one editor page answered this paper session. Close duplicate windows before capturing.'), { code: 'EDITOR_WINDOW_AMBIGUOUS' }));
        return { accepted: true, sequence: input.sequence };
      }
      const snapshot = { projectId: project.id, snapshotId: project.snapshotId, captureId: input.captureId, capturedAt: new Date(this.now()).toISOString(), fresh: true, windowConnected: true, drafts, sourceWriteback: 'human_ui_only' };
      this.captures.set(input.captureId, { time: this.now(), snapshot, clientId: client.clientId });
      while (this.captures.size > 16) this.captures.delete(this.captures.keys().next().value);
      const pending = this.pending; this.pending = null; clearTimeout(pending.timer); pending.resolve(snapshot);
    }
    return { accepted: true, sequence: input.sequence };
  }
  async read(input) {
    strict(input, ['expectedProjectId', 'expectedSnapshotId', 'segmentIds', 'language', 'captureId']);
    this._scope(input);
    if (input.segmentIds !== undefined && (!Array.isArray(input.segmentIds) || input.segmentIds.some(id => !identifier(id) || !this.isKnownParagraph(id, input.language)) || new Set(input.segmentIds).size !== input.segmentIds.length)) fail('EDITOR_SCOPE_INVALID', 'Choose only distinct current paper paragraph IDs.');
    if (input.language !== undefined && !languageTag(input.language)) fail('INVALID_INPUT', 'Use an exact target language tag.');
    let snapshot;
    if (input.captureId !== undefined) {
      if (!identifier(input.captureId)) fail('INVALID_INPUT', 'Use a registered editor capture identity.');
      snapshot = this.captures.get(input.captureId)?.snapshot;
      if (!snapshot) fail('EDITOR_CAPTURE_EXPIRED', 'Read the live editor again before continuing or saving this capture.');
    } else {
      if (this.clients.size > 1) fail('EDITOR_WINDOW_AMBIGUOUS', 'More than one editor page is active for this paper. Close duplicate windows before requesting an exact live capture.');
      if (!this.pending) {
        const captureId = `capture-${randomUUID()}`, clientId = this.clients.keys().next().value || null;
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        const pending = { captureId, clientId, resolve, reject, promise };
        pending.timer = setTimeout(() => { if (this.pending === pending) this.pending = null; reject(Object.assign(new Error(pending.clientId === null ? 'No live editor page connected to this exact paper service. Open its workbench; Computer Use is not required.' : 'The live editor did not confirm its current text. Cached or saved text was not substituted.'), { code: pending.clientId === null ? 'EDITOR_NOT_CONNECTED' : 'EDITOR_CAPTURE_TIMEOUT' })); }, this.captureTimeoutMs);
        this.pending = pending;
      }
      snapshot = await this.pending.promise;
      this._scope(input);
    }
    const result = clone(snapshot);
    if (input.segmentIds) result.drafts = result.drafts.filter(row => input.segmentIds.includes(row.segmentId));
    if (input.language) result.drafts = result.drafts.filter(row => row.language === input.language);
    return result;
  }
  async save(input, { beforeWrite = null } = {}) {
    strict(input, ['expectedProjectId', 'expectedSnapshotId', 'captureId', 'segmentId', 'language', 'baseDraftRevision', 'textHash']);
    this._scope(input);
    if (!identifier(input.segmentId) || !languageTag(input.language) || !integer(input.baseDraftRevision) || !/^[a-f0-9]{64}$/u.test(input.textHash || '')) fail('INVALID_INPUT', 'Save only an exact previously captured author buffer and base revision.');
    const captured = (await this.read({ expectedProjectId: input.expectedProjectId, expectedSnapshotId: input.expectedSnapshotId, captureId: input.captureId })).drafts.find(row => row.segmentId === input.segmentId && row.language === input.language);
    if (!captured || captured.textHash !== input.textHash || captured.baseDraftRevision !== input.baseDraftRevision) fail('EDITOR_BUFFER_CHANGED', 'The selected capture or base revision no longer matches. Read the editor again.');
    if (captured.composing) fail('EDITOR_COMPOSING', 'Wait until the author finishes the input-method composition before saving.');
    if (captured.staleSource) fail('EDITOR_SOURCE_STALE', 'The live text is preserved but its source association needs verified reconciliation. Reconcile the translation draft, then read a fresh editor capture before saving.');
    const fresh = await this.read({ expectedProjectId: input.expectedProjectId, expectedSnapshotId: input.expectedSnapshotId, segmentIds: [input.segmentId], language: input.language });
    const current = fresh.drafts[0];
    if (!current || current.textHash !== captured.textHash || current.bufferSequence !== captured.bufferSequence || current.baseDraftRevision !== captured.baseDraftRevision) fail('EDITOR_BUFFER_CHANGED', 'Newer typing or saving superseded this capture. The live input is preserved.');
    if (current.composing) fail('EDITOR_COMPOSING', 'Wait until input-method composition ends.');
    if (!this.saveDraft) fail('CAPABILITY_UNAVAILABLE', 'This editor cannot save through its current native controller.');
    await beforeWrite?.();
    return this.saveDraft({ expectedProjectId: input.expectedProjectId, expectedSnapshotId: input.expectedSnapshotId, segmentId: input.segmentId, language: input.language, text: current.text, expectedRevision: input.baseDraftRevision }, { beforeWrite: async () => {
      await beforeWrite?.(); this._scope(input);
      const final = (await this.read({ expectedProjectId: input.expectedProjectId, expectedSnapshotId: input.expectedSnapshotId, segmentIds: [input.segmentId], language: input.language })).drafts[0];
      if (!final || final.textHash !== captured.textHash || final.bufferSequence !== captured.bufferSequence || final.baseDraftRevision !== captured.baseDraftRevision || final.composing || final.staleSource) fail('EDITOR_BUFFER_CHANGED', 'Typing, saving or source association changed while this save waited. Current input is preserved.');
      await beforeWrite?.();
    } });
  }
}

const stores = new WeakMap();
export function editorDraftsFor(service) {
  const app = service.active || service;
  let store = stores.get(app);
  if (!store) {
    store = new EditorDraftStore({
      getProject: () => app.core?._state?.project || null,
      isKnownParagraph: (id, language) => Boolean(app.reading?.paragraph?.(id) || app.core?._state?.segments?.some(row => row.id === id) || (language ? app.core?._state?.translations?.[language]?.[id] || app.core?._state?.readingDrafts?.[language]?.[id] : Object.values(app.core?._state?.readingDrafts || {}).some(rows => rows[id]))),
      getParagraphHash: id => { const row = app.reading?.paragraph?.(id) || app.core?._state?.segments?.find(row => row.id === id); return row?.sourceHash || row?.beforeHash || null; },
      saveDraft: (input, options) => app.saveTranslationDraftWithFormulaEdits(input, options),
      onPublish:(drafts,project)=>app.oneClick?.observeEditor(drafts,project),
    });
    stores.set(app, store);
  }
  return store;
}
