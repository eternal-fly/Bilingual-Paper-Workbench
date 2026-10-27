import { randomUUID } from 'node:crypto';
import { MODEL_CONTEXT_BYTES, REGISTERED_REQUEST_BYTES } from './request-budgets.mjs';
import { deriveEnglishView } from './english-view.mjs';
import { extractSegments, restoreProtected, sha256 } from './latex.mjs';
import { paperRequestPrompt } from './codex-bridge.mjs';
import { prepareRangeFile, authorizeReadingRange } from './range-authority.mjs';
import { protectEnglishReading } from './english-source-paragraphs.mjs';
import {reconcileFormulaDraft,captureFormulaRequest,formulaDraftFromState,carryFormulaDraft,requestDraft} from './formula-edits.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const languageTag = value => { if (typeof value !== 'string' || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value) || Object.hasOwn(Object.prototype, value)) fail('INVALID_INPUT', 'Invalid language.'); return value; };
const now = () => new Date().toISOString();
function protectedReading(source, id, filename) {
  const parts = extractSegments(source, filename), bytes = Buffer.from(source), tokens = [];
  let cursor = 0, displayText = '';
  for (const part of parts) {
    displayText += bytes.subarray(cursor, part.startByte).toString('utf8');
    let text = part.displayText;
    for (const token of part.protectedTokens) { const replacement = { id: `⟦P${tokens.length + 1}_${sha256(id).slice(0, 6)}⟧`, raw: token.raw }; tokens.push(replacement); text = text.replace(token.id, replacement.id); }
    displayText += text; cursor = part.endByte;
  }
  displayText += bytes.subarray(cursor).toString('utf8');
  let requestable = true;
  try { if (restoreProtected({ protectedTokens: tokens }, displayText) !== source) requestable = false; } catch { requestable = false; }
  return { displayText, protectedTokens: tokens, requestable };
}

/** Reading projections acquire source authority only through an independent literal-range validator. */
export class ReadingWorkspace {
  constructor(app) { this.app = app; this.cache = null; }
  derive(state = this.app.core.getState(), history = state.readingAnchors || []) {
    const key = `${state.project?.snapshotId}:${state.readingAnchorRevision || 0}`;
    if (this.cache?.key === key && history === state.readingAnchors) return this.cache;
    const projections = [], paragraphs = [], used = new Set();
    for (const file of this.app.core._files.values()) {
      if (!file.path.toLowerCase().endsWith('.tex')) continue;
      let view;
      try { view = deriveEnglishView(file.text, file.path); }
      catch (error) { view = { supported: false, changed: false, text: file.text, paragraphs: [], diagnostics: [{ code: error.code || 'ENGLISH_VIEW_UNSUPPORTED', message: error.message }] }; }
      projections.push({ ...view, path: file.path });
      if (!view.supported) continue;
      let prepared; try { prepared = prepareRangeFile(file.text, file.path, view); } catch { prepared = null; }
      for (const raw of view.paragraphs || []) {
        const source = raw.source ?? raw.english;
        if (typeof source !== 'string' || !Number.isSafeInteger(raw.startByte) || !Number.isSafeInteger(raw.endByte)) continue;
        const sourceHash = sha256(source), exact = state.segments.find(item => item.path === file.path && item.startByte === raw.startByte && item.endByte === raw.endByte && item.beforeHash === sourceHash);
        const previous = history.find(item => !used.has(item.id) && item.path === file.path && item.startByte === raw.startByte && item.endByte === raw.endByte && item.sourceHash === sourceHash);
        // An independently readable opaque canonical block needs a separate
        // reading namespace; the canonical request route must remain opaque.
        const ordinaryCanonical = raw.confidence === 'literalEnglishStructure' && exact && !exact.translatable;
        const id = previous?.id || (!ordinaryCanonical ? exact?.id : null) || `read-${randomUUID()}`; used.add(id);
        const authority = prepared && this.app.core._literalProjectSafe() && authorizeReadingRange(prepared, { id, path: file.path, startByte: raw.startByte, endByte: raw.endByte, sourceHash }, state.project.snapshotId);
        const masked = authority ? { displayText: authority.displayText, protectedTokens: authority.protectedTokens, sourceAuthority: authority.sourceAuthority, requestable: true } : raw.confidence === 'literalEnglishStructure' ? protectEnglishReading(source, id) : protectedReading(source, id, file.path);
        const sourceDiagnostics = raw.confidence === 'literalEnglishStructure' && !authority && (!exact?.translatable || raw.sourceCandidateEligible === false) ? [{ code: 'ENGLISH_SOURCE_READING_ONLY', severity: 'warning', message: raw.sourceCandidateEligible === false ? 'This mathematical, opaque or structurally uncertain interval is preserved for reading/translation only.' : 'Literal source-write authority could not be proved; existing TeX objects remain protected for translation and discussion.' }] : [];
        paragraphs.push({ ...raw, id, path: file.path, source, sourceHash, beforeHash: sourceHash, sourceSegmentIds: [id],
          canonicalSegmentIds: state.segments.filter(item => item.path === file.path && item.startByte < raw.endByte && item.endByte > raw.startByte).map(item => item.id),
          section: raw.section || exact?.section || state.segments.find(item => item.path === file.path && item.startByte <= raw.startByte && item.endByte >= raw.endByte)?.section || '正文',
          translation: raw.translation ?? raw.existingTranslation?.text ?? '', translatable: true, writableSource: Boolean(authority || raw.sourceCandidateEligible !== false && exact?.translatable), ...masked,
          ...(sourceDiagnostics.length ? { sourceDiagnostics } : {}),
        originalLine: raw.originalLine || file.bytes.subarray(0, raw.startByte).toString('utf8').split('\n').length });
      }
    }
    if (!paragraphs.length) for (const segment of state.segments.filter(item => item.translatable)) paragraphs.push({ ...segment, sourceHash: segment.beforeHash, sourceSegmentIds: [segment.id], canonicalSegmentIds: [segment.id], writableSource: true, requestable: true, translation: state.translations[state.project?.targetLanguage]?.[segment.id]?.text || '', originalLine: this.app.core._files.get(segment.path).bytes.subarray(0, segment.startByte).toString('utf8').split('\n').length });
    return { key, projections, paragraphs };
  }
  async syncLocked(history = null) {
    const state = this.app.core.getState(); if (!state.project) return;
    const view = this.derive(state, history || state.readingAnchors || []);
    state.readingAnchors = view.paragraphs.map(({ id, path, startByte, endByte, sourceHash }) => ({ id, path, startByte, endByte, sourceHash }));
    state.readingAnchorRevision = (state.readingAnchorRevision || 0) + 1;
    state.readingDrafts ||= {}; state.readingOriginals ||= {};
    for (const paragraph of view.paragraphs) {
      if (!Object.hasOwn(state.readingOriginals, paragraph.id)) state.readingOriginals[paragraph.id] = { source: paragraph.source, sourceHash: paragraph.sourceHash, translation: paragraph.translation || null, translationHash: paragraph.translation ? sha256(paragraph.translation) : null, path: paragraph.path, firstSnapshotId: state.project.snapshotId, origin: 'sourceBilingual', capturedAt: now() };
      if (!state.segments.some(item => item.id === paragraph.id)) {
        // A lexer boundary may turn a canonical source ID into a derived ID.
        // Carry every existing language draft before creating the companion default.
        for (const [language, drafts] of Object.entries(state.translations || {})) if (drafts[paragraph.id] && !state.readingDrafts[language]?.[paragraph.id]) {
          state.readingDrafts[language] ||= {}; state.readingDrafts[language][paragraph.id] = structuredClone(drafts[paragraph.id]);
        }
        const language = 'zh-CN';
        state.readingDrafts[language] ||= {};
        if (!Object.hasOwn(state.readingDrafts[language], paragraph.id)) state.readingDrafts[language][paragraph.id] = { text: language === 'zh-CN' ? paragraph.translation : '', revision: paragraph.translation && language === 'zh-CN' ? 1 : 0, sourceHash: paragraph.sourceHash, status: 'saved', origin: 'sourceBilingual' };
      }
    }
    await this.app.core._commit(state); this.cache = { ...view, key: `${state.project.snapshotId}:${state.readingAnchorRevision}` };
  }
  state(state) {
    if (!state.project) return { ...state, readingParagraphs: [], englishView: { available: false, diagnostics: [] } };
    const view = this.cache?.key === `${state.project.snapshotId}:${state.readingAnchorRevision || 0}` ? this.cache : this.derive(state);
    const translations = structuredClone(state.translations);
    for (const [language, drafts] of Object.entries(state.readingDrafts || {})) translations[language] = { ...(translations[language] || {}), ...structuredClone(drafts) };
    return { ...state, translations, originals: { ...(state.readingOriginals || {}), ...(state.originals || {}) }, readingParagraphs: structuredClone(view.paragraphs),
      englishView: { available: view.projections.length > 0 && view.projections.every(item => item.supported), changed: view.projections.some(item => item.changed), diagnostics: structuredClone(view.projections.flatMap(item => item.diagnostics || [])) } };
  }
  paragraph(id) { return this.state(this.app.core.getState()).readingParagraphs.find(item => item.id === id); }
  hasDerived(id) { const state = this.app.core._state || this.app.core.getState(); return !state.segments.some(item => item.id === id) && this.derive(state).paragraphs.some(item => item.id === id); }
  async saveDraft(input) {
    languageTag(input.language);
    return this.app.core._serial(async () => {
      if (Object.keys(input).some(key => !['segmentId', 'language', 'text', 'expectedRevision'].includes(key)) || typeof input.text !== 'string' || Buffer.byteLength(input.text) > 128 * 1024 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail('INVALID_INPUT', 'Invalid reading translation draft.');
      const paragraph = this.paragraph(input.segmentId); if (!paragraph) fail('SEGMENT_NOT_FOUND', 'The reading paragraph is no longer current.');
      const state = this.app.core.getState(), current = state.readingDrafts?.[input.language]?.[input.segmentId];
      if ((current?.revision || 0) !== input.expectedRevision) fail('VERSION_CONFLICT', 'The translation changed; preserve your buffer.');
      state.readingDrafts ||= {}; state.readingDrafts[input.language] ||= {};
      const draft = { text: input.text, revision: input.expectedRevision + 1, sourceHash: paragraph.sourceHash, status: 'saved', origin: 'human', updatedAt: now(),...reconcileFormulaDraft(paragraph,current,input.text,state.project,input.language) };
      state.readingDrafts[input.language][input.segmentId] = draft; await this.app.core._commit(state); this.app.emit('change'); return draft;
    });
  }
  async createRequest(input,{beforeCreate,beforeCommit}={}) {
    return this.app.core._serial(async () => {
      await this.app.core._assertSourceCurrent();
      if(beforeCreate)await beforeCreate();
      if (Object.keys(input).some(key => !['segmentIds', 'language', 'kind', 'prompt', 'bindingId'].includes(key)) || !['translation', 'revision', 'discussion'].includes(input.kind) || !Array.isArray(input.segmentIds) || !input.segmentIds.length || new Set(input.segmentIds).size !== input.segmentIds.length) fail('UNSUPPORTED_TEX', 'Select unique current reading originals.');
      const state = this.state(this.app.core.getState()), language = languageTag(input.language || state.project.targetLanguage), paragraphs = input.segmentIds.map(id => state.readingParagraphs.find(item => item.id === id));
      if (paragraphs.some(item => !item || input.kind === 'translation' && !item.requestable || input.kind === 'revision' && !item.writableSource)) fail('UNSUPPORTED_TEX', 'A reading paragraph cannot be safely represented for this request.');
      if (typeof (input.prompt || '') !== 'string' || Buffer.byteLength(input.prompt || '') > MODEL_CONTEXT_BYTES) fail('INVALID_INPUT', 'Author instruction exceeds its byte budget.');
      const threadId = this.app.chat?.getState?.().threadId;
      const request = { schemaVersion: 1, requestId: `req-${randomUUID()}`, projectId: state.project.id, snapshotId: state.project.snapshotId, kind: input.kind, language, prompt: input.prompt || '', bindingId: input.bindingId || (threadId ? `codex:${threadId}` : 'local-preview-manual'),
        origin: 'readingView', generation: Math.max(0, ...state.requests.filter(item => item.kind === input.kind && item.language === language).map(item => item.generation || 0)) + 1, status: 'pending', createdAt: now(), segmentIds: input.segmentIds,
        draftRevisions: Object.fromEntries(paragraphs.map(item => [item.id, state.translations[language]?.[item.id]?.revision || 0])),
        segments: paragraphs.map(item => ({ id: item.id, segmentId: item.id, path: item.path, beforeHash: item.sourceHash, sourceHash: item.sourceHash, text: item.displayText, protectedTokens: item.protectedTokens, ...(item.sourceAuthority ? { sourceAuthority: item.sourceAuthority } : {}), translationDraft: requestDraft(state.translations[language]?.[item.id]) })) };
      request.translationUnitRevisions = {};
      for (const selected of request.segments) {
        const alignment = (state.alignments || []).find(item => item.language === language && item.sourceSegmentIds.includes(selected.id));
        const units = alignment?.translationUnitIds || [selected.id], drafts = units.map(id => state.translations[language]?.[id]).filter(Boolean);
        for (const id of units) request.translationUnitRevisions[id] = state.translations[language]?.[id]?.revision || 0;
        if (drafts.length) selected.translationDraft = { text: drafts.map(item => item.text).join('\n\n'), revision: Math.max(...drafts.map(item => item.revision)), sourceHash: selected.sourceHash, translationUnitIds: units };
        if (units.length > 1 || alignment && (alignment.sourceSegmentIds.length !== 1 || units[0] !== selected.id)) request.requiresTranslationMerge = true;
      }
      request.segments=request.segments.map(selected=>{selected.translationDraft=requestDraft(selected.translationDraft);return input.kind==='revision'?captureFormulaRequest(selected,paragraphs.find(p=>p.id===selected.id),formulaDraftFromState(state,language,selected.id),state.project,language):selected;});
      if (Buffer.byteLength(JSON.stringify(request)) > REGISTERED_REQUEST_BYTES) fail('REQUEST_TOO_LARGE', 'The complete reading request exceeds the registered storage byte budget.');
      if(beforeCommit)await beforeCommit(request);
      const next = this.app.core.getState(); next.requests.push(request); await this.app.core._commit(next);
      return { ...request, ...(request.bindingId.startsWith('codex:') ? { previewMessage: paperRequestPrompt(request) } : {}) };
    });
  }
  async submitTranslation(input, { beforeWrite } = {}) {
    return this.app.core._serial(async () => {
      if (!input || Object.keys(input).some(key => !['requestId', 'translations'].includes(key))) fail('INVALID_INPUT', 'Invalid translation result.');
      const state = this.app.core.getState(), request = state.requests.find(item => item.requestId === input.requestId && item.kind === 'translation' && item.origin === 'readingView');
      if (!request || !Array.isArray(input.translations) || input.translations.length !== request.segmentIds.length) fail('REQUEST_NOT_APPROVED', 'No exact reading translation request matches.');
      const seen = new Set(), results = input.translations.map(item => {
        if (!item || Object.keys(item).some(key => !['segmentId', 'text'].includes(key)) || seen.has(item.segmentId) || !request.segmentIds.includes(item.segmentId)) fail('INVALID_INPUT', 'Translation IDs differ from the reading selection.');
        seen.add(item.segmentId); const selected = request.segments.find(selected => selected.segmentId === item.segmentId);
        return { segmentId: item.segmentId, text: restoreProtected(selected, item.text), sourceHash: selected.sourceHash };
      });
      const resultHash = sha256(JSON.stringify(input));
      if (request.resultHash) { if (request.resultHash !== resultHash) fail('IDEMPOTENCY_CONFLICT', 'This request already returned another result.'); return { requestId: request.requestId, status: request.status }; }
      if (beforeWrite) await beforeWrite(request);
      const merged = this.state(state), paragraphs = new Map(merged.readingParagraphs.map(item => [item.id, item])), stale = request.status !== 'pending' || request.requiresTranslationMerge || request.snapshotId !== state.project.snapshotId || state.requests.some(item => item.kind === request.kind && item.language === request.language && item.generation > request.generation && item.segmentIds.some(id => request.segmentIds.includes(id))) || request.segmentIds.some(id => (merged.translations[request.language]?.[id]?.revision || 0) !== request.draftRevisions[id] || paragraphs.get(id)?.sourceHash !== request.segments.find(item => item.segmentId === id).sourceHash) || Object.entries(request.translationUnitRevisions || {}).some(([id, revision]) => (merged.translations[request.language]?.[id]?.revision || 0) !== revision);
      Object.assign(request, { resultHash, status: stale ? 'stale' : 'completed', completedAt: now() });
      if (stale) request.historicalResult = results;
      else for (const result of results) {
        const derived = !state.segments.some(item => item.id === result.segmentId), key = derived||state.readingDrafts?.[request.language]?.[result.segmentId] ? 'readingDrafts' : 'translations'; state[key] ||= {}; state[key][request.language] ||= {};
        const current=merged.translations[request.language]?.[result.segmentId],paragraph=paragraphs.get(result.segmentId);
        state[key][request.language][result.segmentId] = { ...result,...carryFormulaDraft(paragraph,current,result.text,state.project), revision: request.draftRevisions[result.segmentId] + 1, status: 'saved', origin: 'ai', updatedAt: now() };
      }
      await this.app.core._commit(state); this.app.emit('change'); return { requestId: request.requestId, status: request.status };
    });
  }
}
