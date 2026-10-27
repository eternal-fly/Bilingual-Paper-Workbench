import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MODEL_CONTEXT_BYTES, REGISTERED_REQUEST_BYTES } from './request-budgets.mjs';
import { lstat, realpath, readdir, readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { commands, extractSegments, restoreProtected, sha256 } from './latex.mjs';
import { extractBilingualPairs } from './bilingual-import.mjs';
import { prepareRangeFile, authorizeReadingRange, maskRawReplacement, literalLexicalSafety } from './range-authority.mjs';
import {reconcileFormulaDraft,captureFormulaRequest,formulaSourceForRequest,formulaDraftFromState,carryFormulaDraft,requestDraft} from './formula-edits.mjs';
import {inlineStructureSafetyForFiles} from './inline-structures.mjs';

const MAX_FILE = 4 * 1024 * 1024;
const MAX_TREE = 32 * 1024 * 1024;
const MAX_FILES = 500;
const copy = value => structuredClone(value);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const now = () => new Date().toISOString();
const emptyState = () => ({ schemaVersion: 1, project: null, segments: [], translations: {}, proposals: [], requests: [], previews: [], reviewHistory: [], reviewHistoryPreferences: { retain: true, revision: 0 }, eventSeq: 0,
  capabilities: { secureCompile: false, directApply: false, translationProvider: 'hostConversation',
    reasons: { secureCompile: 'No verified isolated compiler is configured.', directApply: 'No verified conditional or exclusive project writer is configured.' } } });

function strict(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !(k in value)))
    fail('INVALID_INPUT', 'Input does not match the allowed request fields.');
}
function text(value, name, max = 4096, optional = false) {
  if (optional && value === undefined) return;
  if (typeof value !== 'string' || value.length > max || (!optional && !value.length)) fail('INVALID_INPUT', `${name} must be a bounded string.`);
}
function languageTag(value) { text(value, 'language', 40); if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value) || Object.hasOwn(Object.prototype, value)) fail('INVALID_INPUT', 'Invalid language tag.'); return value; }
function relativeName(value) {
  text(value, 'path', 1024);
  const normalized = value.replaceAll('\\', '/');
  if (path.isAbsolute(value) || normalized.startsWith('/') || normalized.split('/').some(p => !p || p === '.' || p === '..' || /[:\x00-\x1f<>"|?*]/.test(p) || /[. ]$/.test(p) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p)))
    fail('PERMISSION_DENIED', 'The path must stay inside the authorized project.');
  return normalized;
}
async function inside(root, relative) {
  const safe = relativeName(relative);
  let cursor = root;
  for (const component of safe.split('/')) {
    cursor = path.join(cursor, component);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) fail('PERMISSION_DENIED', 'Symbolic links and reparse inputs are unsupported.');
  }
  const resolved = await realpath(cursor), prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.toLowerCase().startsWith(prefix.toLowerCase())) fail('PERMISSION_DENIED', 'The input escapes the authorized project.');
  return { path: resolved, relative: safe };
}
function decode(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { fail('UNSUPPORTED_ENCODING', 'Only valid UTF-8 text is editable; convert other encodings explicitly.'); }
}
async function atomicJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, filename);
}

async function boundedRead(filename, limit, code = 'PROJECT_TOO_LARGE') {
  const handle = await open(filename, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail('PERMISSION_DENIED', 'Only regular input files may be read.');
    if (stat.size > limit) fail(code, 'Input exceeds the supported byte limit.');
    const chunks = [];
    let size = 0;
    while (size <= limit) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) fail(code, 'Input grew beyond the supported byte limit while it was read.');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, size);
  } finally { await handle.close(); }
}

export class PaperService {
  constructor({ dataRoot }) {
    text(dataRoot, 'dataRoot');
    this.dataRoot = path.resolve(dataRoot);
    this._state = emptyState();
    this._root = null;
    this._store = null;
    this._files = new Map();
    this._queue = Promise.resolve();
  }
  getState() { return copy(this._state); }
  getProjectRoot() { return this._root; }
  _serial(work, { reload = true } = {}) {
    const result = this._queue.then(async () => {
      await mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
      const lockPath = path.join(this.dataRoot, '.write.lock'), owner = randomUUID();
      let lock;
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (e) { if (e.code === 'EEXIST') fail('PROJECT_BUSY', 'Another writer or interrupted session owns the private-data lock. Retry after the writer finishes; a stale lock requires explicit recovery.'); throw e; }
      try {
        await lock.writeFile(JSON.stringify({ schemaVersion: 1, owner, pid: process.pid, createdAt: now() }));
        await lock.sync();
        if (reload && this._store && this._state.project) {
          let current;
          try { current = JSON.parse(await readFile(path.join(this._store, 'state.json'), 'utf8')); }
          catch { fail('RECOVERY_REQUIRED', 'Durable project state is missing or unreadable; preserve the current buffer and inspect the private data.'); }
          if (current.schemaVersion !== 1 || current.project?.id !== this._state.project.id) fail('RECOVERY_REQUIRED', 'Durable project state has an unexpected identity or schema.');
          if (current.project.snapshotId !== this._state.project.snapshotId) fail('VERSION_CONFLICT', 'Another session refreshed the source snapshot. Refresh this panel before editing.');
          this._state = current;
        }
        return await work();
      } finally {
        await lock.close();
        let currentLock;
        try { currentLock = JSON.parse(await readFile(lockPath, 'utf8')); }
        catch { fail('RECOVERY_REQUIRED', 'The private-data lock changed unexpectedly; automatic mutation is frozen.'); }
        if (currentLock.owner !== owner) fail('RECOVERY_REQUIRED', 'The private-data lock ownership changed; it was not removed.');
        await unlink(lockPath);
      }
    });
    this._queue = result.catch(() => {});
    return result;
  }
  _requireProject() { if (!this._state.project) fail('PROJECT_NOT_OPEN', 'Select a project and its main TeX file first.'); }
  async _commit(next, store = this._store) {
    next.eventSeq++;
    await atomicJson(path.join(store, 'state.json'), next);
    this._state = next;
  }
  async _scan(root, mainFile) {
    const diagnostics = [], files = new Map(), queue = [relativeName(mainFile)];
    const caseNames = new Map();
    let total = 0;
    while (queue.length) {
      const relative = queue.shift();
      if (files.has(relative)) continue;
      if (files.size >= MAX_FILES) fail('PROJECT_TOO_LARGE', 'The project exceeds the 500-file review limit.');
      let resolved;
      try { resolved = await inside(root, relative); }
      catch (e) { if (e.code === 'ENOENT' && relative !== mainFile) { diagnostics.push({ code: 'DEPENDENCY_MISSING', path: relative, severity: 'warning', message: 'A declared dependency is missing.' }); continue; } throw e; }
      const stat = await lstat(resolved.path);
      if (!stat.isFile()) fail('PERMISSION_DENIED', 'Project inputs must be regular files.');
      if (stat.size > MAX_FILE) fail('PROJECT_TOO_LARGE', 'Project input size exceeds the supported review limit.');
      const key = relative.toLowerCase();
      if (caseNames.has(key) && caseNames.get(key) !== relative) fail('PATH_COLLISION', 'Two inputs differ only by letter case.');
      caseNames.set(key, relative);
      const bytes = await boundedRead(resolved.path, MAX_FILE);
      if ((total += bytes.length) > MAX_TREE) fail('PROJECT_TOO_LARGE', 'Project input size exceeds the supported review limit.');
      const item = { path: relative, hash: sha256(bytes), size: bytes.length, bytes };
      const ext = path.extname(relative).toLowerCase();
      if (['.tex', '.bib', '.sty', '.cls'].includes(ext)) item.text = decode(bytes);
      files.set(relative, item);
      if (item.text === undefined || ext === '.bib') continue;
      for (const command of commands(item.text)) {
        let names, extensions;
        if (['input', 'include'].includes(command.name)) { names = [command.args[0]]; extensions = ['.tex']; }
        else if (['bibliography', 'addbibresource'].includes(command.name)) { names = command.args[0]?.split(','); extensions = ['.bib']; }
        else if (command.name === 'bibliographystyle') { names = [command.args[0]]; extensions = ['.bst']; }
        else if (command.name === 'includegraphics') { names = [command.args[0]]; extensions = ['.pdf', '.png', '.jpg', '.jpeg', '.eps']; }
        else if (['documentclass', 'usepackage', 'RequirePackage'].includes(command.name)) { names = command.args[0]?.split(','); extensions = [command.name === 'documentclass' ? '.cls' : '.sty']; }
        else continue;
        if (!names?.length || names.some(name => !name || /[\\#{}]/.test(name))) { diagnostics.push({ code: 'UNSUPPORTED_TEX', path: relative, severity: 'warning', message: 'Dynamic dependency is opaque and was not expanded.' }); continue; }
        for (const name of names) {
          const base = relativeName(path.posix.join(path.posix.dirname(relative), relativeName(name.trim())));
          const candidates = path.posix.extname(base) ? [base] : extensions.map(ext => base + ext);
          let chosen;
          for (const candidate of candidates) {
            try { await inside(root, candidate); chosen = candidate; break; }
            catch (e) { if (e.code !== 'ENOENT') throw e; }
          }
          if (!chosen && ['documentclass', 'usepackage', 'RequirePackage', 'bibliographystyle'].includes(command.name)) {
            diagnostics.push({ code: 'TOOLCHAIN_DEPENDENCY', path: candidates[0], severity: 'info', message: 'Expected from the external TeX toolchain; not bundled or verified.' });
          } else queue.push(chosen ?? candidates[0]);
        }
      }
    }
    return { files, diagnostics };
  }
  async _mainCandidates(root) {
    const candidates = [];
    let visited = 0;
    const walk = async (dir, relative = '', depth = 0) => {
      if (depth > 6) return;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (++visited > 2000) fail('PROJECT_TOO_LARGE', 'Main-file discovery exceeds the bounded scan limit.');
        if (entry.name.startsWith('.') || ['node_modules', 'build', 'dist'].includes(entry.name) || entry.isSymbolicLink()) continue;
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), name, depth + 1);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.tex')) {
          const safe = await inside(root, name), stat = await lstat(safe.path);
          if (stat.size > MAX_FILE) continue;
          const source = decode(await boundedRead(safe.path, MAX_FILE));
          if (commands(source).some(c => c.name === 'documentclass')) candidates.push(name);
        }
      }
    };
    await walk(root);
    return candidates.sort();
  }
  openProject(input) { return this._serial(() => this._openProject(input), { reload: false }); }
  async _openProject({ root, mainFile, sourceLanguage = 'en', targetLanguage = 'zh-CN' }, { segmentHistory = null } = {}) {
    text(root, 'root', 4096);
    sourceLanguage = languageTag(sourceLanguage); targetLanguage = languageTag(targetLanguage);
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('PERMISSION_DENIED', 'Select an actual project directory.');
    const resolvedRoot = await realpath(root);
    if (!mainFile) {
      const candidates = await this._mainCandidates(resolvedRoot);
      if (candidates.length !== 1) {
        this._state = { ...emptyState(), mainCandidates: candidates, diagnostics: [{ code: 'MAIN_FILE_REQUIRED', message: candidates.length ? 'Choose the main TeX file.' : 'No documentclass entry was found; specify a main file.' }] };
        this._root = resolvedRoot; this._files = new Map(); this._store = null;
        return this.getState();
      }
      mainFile = candidates[0];
    }
    mainFile = relativeName(mainFile);
    if (!mainFile.toLowerCase().endsWith('.tex')) fail('INVALID_INPUT', 'The main file must have a .tex extension.');
    const scanned = await this._scan(resolvedRoot, mainFile);
    const projectId = `project-${sha256(resolvedRoot.toLowerCase() + '\0' + mainFile.toLowerCase()).slice(0, 24)}`;
    const store = path.join(this.dataRoot, 'projects', projectId);
    let old = emptyState();
    try { old = JSON.parse(await readFile(path.join(store, 'state.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') fail('RECOVERY_REQUIRED', 'Saved project state could not be read; preserve it for recovery.'); }
    if (old.schemaVersion !== 1) fail('SCHEMA_UNSUPPORTED', 'Saved state uses an unsupported schema; no data was overwritten.');
    const list = [...scanned.files.values()].map(({ path, hash, size }) => ({ path, hash, size })).sort((a, b) => a.path.localeCompare(b.path));
    const snapshotId = `snap-${sha256(JSON.stringify({ mainFile, files: list }))}`;
    const changed = old.project && (old.project.snapshotId !== snapshotId || old.project.mainFile !== mainFile);
    const bilingual = [];
    const history = segmentHistory || old.segments;
    const segments = [...scanned.files.values()].filter(file => file.path.toLowerCase().endsWith('.tex')).flatMap(file => {
      const canonical = extractSegments(file.text, file.path, history);
      if (sourceLanguage !== 'en') return canonical;
      const pairs = extractBilingualPairs(file.text, file.path, canonical);
      if (!pairs.length) return canonical;
      const used = new Set();
      const overrides = pairs.map(pair => {
        const exact = history.find(item => item.path === file.path && item.startByte === pair.sourceStartByte && item.endByte === pair.sourceEndByte && item.beforeHash === pair.sourceHash);
        const preferred = exact?.id || pair.parentSegmentId;
        const id = used.has(preferred) ? `seg-${randomUUID()}` : preferred; used.add(id);
        return { startByte: pair.sourceStartByte, endByte: pair.sourceEndByte, id };
      });
      const narrowed = extractSegments(file.text, file.path, history, overrides);
      for (const pair of pairs) {
        const segment = narrowed.find(item => item.startByte === pair.sourceStartByte && item.endByte === pair.sourceEndByte && item.beforeHash === pair.sourceHash);
        if (segment) { segment.bilingualCompanion = { language: 'zh-CN', startByte: pair.existingTranslation.startByte, endByte: pair.existingTranslation.endByte, hash: pair.existingTranslation.hash, confidence: pair.confidence }; bilingual.push({ segment, pair }); }
      }
      return narrowed;
    });
    const next = { ...emptyState(), ...old, project: { id: projectId, rootLabel: path.basename(resolvedRoot), mainFile, sourceLanguage, targetLanguage, snapshotId, files: list, diagnostics: scanned.diagnostics }, segments };
    next.project.inlineStructureSafety=inlineStructureSafetyForFiles(scanned.files,next.project,{lexicalSafety:literalLexicalSafety});
    next.originalSnapshotId ||= snapshotId;
    next.originals ||= {};
    const companions = new Map(bilingual.map(({ segment, pair }) => [segment.id, pair]));
    for (const segment of segments) if (!Object.hasOwn(next.originals, segment.id)) {
      const pair = companions.get(segment.id);
      next.originals[segment.id] = { source: segment.source, sourceHash: segment.beforeHash,
        translation: pair?.existingTranslation.text ?? null, translationHash: pair?.existingTranslation.hash ?? null,
        path: segment.path, firstSnapshotId: snapshotId, origin: pair ? 'sourceBilingual' : 'source', capturedAt: now() };
    }
    for (const { segment, pair } of bilingual) {
      next.translations['zh-CN'] ??= {};
      if (!Object.hasOwn(next.translations['zh-CN'], segment.id)) next.translations['zh-CN'][segment.id] = { text: pair.existingTranslation.text, revision: 1, sourceHash: segment.beforeHash, status: 'saved', origin: 'sourceBilingual', sourceProvenance: segment.bilingualCompanion, updatedAt: now() };
    }
    for (const drafts of Object.values(next.translations)) for (const [segmentId, draft] of Object.entries(drafts)) {
      const sourceIds = draft.sourceSegmentIds || [segmentId], current = sourceIds.map(id => segments.find(item => item.id === id));
      if (current.some(item => !item) || sourceIds.length === 1 && current[0]?.beforeHash !== draft.sourceHash || sourceIds.length > 1 && current.some(item => draft.sourceHashes?.[item.id] !== item.beforeHash)) draft.status = 'stale';
    }
    delete next.mainCandidates;
    if (changed) {
      for (const proposal of next.proposals) if (proposal.applicationState === 'notApplied' && proposal.reviewState === 'pending') proposal.reviewState = 'stale';
      for (const request of next.requests) if (request.status === 'pending') request.status = 'stale';
      for (const drafts of Object.values(next.translations)) for (const [segmentId, draft] of Object.entries(drafts)) {
        const sourceIds = draft.sourceSegmentIds || [segmentId];
        const current = sourceIds.map(id => segments.find(s => s.id === id));
        if (current.some(item => !item) || sourceIds.length === 1 && current[0].beforeHash !== draft.sourceHash) draft.status = 'stale';
      }
      next.proposals.push({ proposalId: `external-${randomUUID()}`, author: 'externalUnknown', reviewState: 'observed', applicationState: 'externallyApplied', baseSnapshotId: old.project.snapshotId, snapshotId, reason: 'Project inputs changed outside this review service.', edits: [], createdAt: now() });
    }
    const snapshotFile = path.join(store, 'snapshots', `${snapshotId}.json`);
    try { await lstat(snapshotFile); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      await atomicJson(snapshotFile, { schemaVersion: 1, snapshotId, files: [...scanned.files.values()].map(({ path, hash, bytes }) => ({ path, hash, base64: bytes.toString('base64') })) });
    }
    await this._commit(next, store);
    this._root = resolvedRoot; this._store = store; this._files = scanned.files;
    return this.getState();
  }
  refreshProject() { return this._serial(async () => { this._requireProject(); return this._openProject({ root: this._root, mainFile: this._state.project.mainFile, sourceLanguage: this._state.project.sourceLanguage, targetLanguage: this._state.project.targetLanguage }); }, { reload: false }); }
  saveDraft(input) { return this._serial(async () => {
    strict(input, ['segmentId', 'language', 'text', 'expectedRevision']); this._requireProject();
    const { segmentId, text: content, expectedRevision } = input, language = languageTag(input.language);
    text(content, 'draft', 128 * 1024, true);
    if (typeof content !== 'string' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('INVALID_INPUT', 'Draft content and revision are required.');
    const segment = this._state.segments.find(s => s.id === segmentId);
    if (!segment) fail('SEGMENT_NOT_FOUND', 'The segment no longer exists in the active source.');
    const current = this._state.translations[language]?.[segmentId];
    if ((current?.revision ?? 0) !== expectedRevision) fail('VERSION_CONFLICT', 'The draft changed; preserve your buffer and merge or reload.');
    const next = this.getState(); next.translations[language] ??= {};
    const result = { text: content, revision: expectedRevision + 1, sourceHash: segment.beforeHash, status: 'saved', origin: 'human', updatedAt: now(), ...reconcileFormulaDraft(segment,current,content,next.project,language), ...(current?.sourceSegmentIds ? { sourceSegmentIds: current.sourceSegmentIds, sourceHashes: Object.fromEntries(current.sourceSegmentIds.map(id => [id, this._state.segments.find(item => item.id === id)?.beforeHash])) } : {}) };
    next.translations[language][segmentId] = result;
    await this._commit(next); return copy(result);
  }); }
  _literalProjectSafe() {
    const snapshotId = this._state.project?.snapshotId;
    if (this._literalSafety?.snapshotId === snapshotId) return this._literalSafety.safe;
    let safe = !this._state.project?.diagnostics?.some(item => item.code === 'UNSUPPORTED_TEX');
    try {
      for (const file of this._files.values()) if (file.text !== undefined || /\.(?:bbl|ltx|def|cfg)$/i.test(file.path)) {
        if (!literalLexicalSafety(file.text ?? decode(file.bytes))) { safe = false; break; }
      }
    } catch { safe = false; }
    this._literalSafety = { snapshotId, safe }; return safe;
  }
  _readingSource(id) {
    if (!this._literalProjectSafe()) return null;
    const anchor = this._state.readingAnchors?.find(item => item.id === id), file = anchor && this._files.get(anchor.path);
    if (!file) return null;
    this._rangeFiles ||= new Map();
    let prepared = this._rangeFiles.get(file.path);
    if (!prepared || prepared.fileHash !== file.hash) {
      try { prepared = prepareRangeFile(file.text, file.path); } catch { return null; }
      this._rangeFiles.set(file.path, prepared);
    }
    return authorizeReadingRange(prepared, anchor, this._state.project.snapshotId);
  }
  _revisionSource(id, authority = null) {
    if (!authority) return this._state.segments.find(item => item.id === id);
    const segment = this._readingSource(id);
    if (!segment || JSON.stringify(segment.sourceAuthority) !== JSON.stringify(authority)) fail('VERSION_CONFLICT', 'The independently verified source range changed.');
    return segment;
  }
  createRequest(input,{beforeCreate,beforeCommit}={}) { return this._serial(async () => {
    strict(input, ['segmentIds', 'language', 'kind', 'prompt', 'bindingId'], ['segmentIds', 'kind']); this._requireProject();
    await this._assertSourceCurrent();
    if(beforeCreate)await beforeCreate();
    const { segmentIds, kind, prompt = '', bindingId = null } = input, language = languageTag(input.language ?? this._state.project.targetLanguage);
    if (!['translation', 'revision', 'discussion'].includes(kind) || !Array.isArray(segmentIds) || segmentIds.length < 1 || new Set(segmentIds).size !== segmentIds.length) fail('INVALID_INPUT', 'Select unique current segments and a supported request kind.');
    text(prompt, 'prompt', MODEL_CONTEXT_BYTES, true);
    if (bindingId !== null) text(bindingId, 'bindingId', 256);
    const segments = segmentIds.map(id => this._state.segments.find(s => s.id === id));
    if (segments.some(s => !s)) fail('SEGMENT_NOT_FOUND', 'A selected segment no longer exists.');
    if (segments.some(s => !s.translatable) && kind !== 'discussion') fail('UNSUPPORTED_TEX', 'An opaque or structural block cannot be translated or revised automatically.');
    if (segments.reduce((n, s) => n + Buffer.byteLength(s.source), 0) > REGISTERED_REQUEST_BYTES) fail('REQUEST_TOO_LARGE', 'The source selection exceeds the registered request storage byte budget.');
    const next = this.getState();
    const generation = Math.max(0, ...next.requests.filter(r => r.kind === kind && r.language === language).map(r => r.generation ?? 0)) + 1;
    const request = { schemaVersion: 1, requestId: `req-${randomUUID()}`, kind, segmentIds: [...segmentIds], language, prompt, bindingId,
      snapshotId: next.project.snapshotId, projectId: next.project.id, generation, status: 'pending', createdAt: now(),
      draftRevisions: Object.fromEntries(segmentIds.map(id => [id, next.translations[language]?.[id]?.revision ?? 0])),
      segments: segments.map(s => ({ id: s.id, segmentId: s.id, path: s.path, beforeHash: s.beforeHash, sourceHash: s.beforeHash, text: s.displayText, protectedTokens: s.protectedTokens,
        translationDraft: requestDraft(next.translations[language]?.[s.id]) })) };
    request.translationUnitRevisions = {};
    for (const selected of request.segments) {
      const alignment = (next.alignments || []).find(item => item.language === language && item.sourceSegmentIds.includes(selected.id));
      const units = alignment?.translationUnitIds || [selected.id];
      const drafts = units.map(id => next.translations[language]?.[id]).filter(Boolean);
      for (const id of units) request.translationUnitRevisions[id] = next.translations[language]?.[id]?.revision || 0;
      if (drafts.length) selected.translationDraft = { text: drafts.map(item => item.text).join('\n\n'), revision: Math.max(...drafts.map(item => item.revision)), sourceHash: selected.sourceHash, translationUnitIds: units };
      if (units.length > 1) request.requiresTranslationMerge = true;
    }
    request.segments = request.segments.map(selected => {
      selected.translationDraft=requestDraft(selected.translationDraft);
      if(kind!=='revision')return selected;
      const source=segments.find(s=>s.id===selected.id),draft=formulaDraftFromState(next,language,selected.id);
      return captureFormulaRequest(selected,source,draft,next.project,language);
    });
    if(Buffer.byteLength(JSON.stringify(request))>REGISTERED_REQUEST_BYTES)fail('REQUEST_TOO_LARGE','The complete protected request exceeds the registered request storage byte budget.');
    if(beforeCommit)await beforeCommit(request);
    next.requests.push(request);
    await this._commit(next); return copy(request);
  }); }
  _request(requestId, kind) {
    text(requestId, 'requestId', 100); this._requireProject();
    const request = this._state.requests.find(r => r.requestId === requestId && r.kind === kind);
    if (!request) fail('PERMISSION_DENIED', 'No registered request matches this result.');
    return request;
  }
  submitTranslationResult(input, { beforeWrite } = {}) { return this._serial(async () => {
    strict(input, ['requestId', 'translations']);
    const request = this._request(input.requestId, 'translation');
    if (!Array.isArray(input.translations) || input.translations.length !== request.segmentIds.length) fail('INVALID_INPUT', 'Translation results must contain every registered segment exactly once.');
    const seen = new Set(), results = [];
    for (const result of input.translations) {
      strict(result, ['segmentId', 'text']);
      if (seen.has(result.segmentId) || !request.segmentIds.includes(result.segmentId)) fail('PERMISSION_DENIED', 'A result is outside this registered request.');
      seen.add(result.segmentId);
      const selected = request.segments.find(s => s.id === result.segmentId);
      results.push({ segmentId: result.segmentId, text: restoreProtected(selected, result.text), sourceHash: selected.sourceHash });
    }
    const inputHash = sha256(JSON.stringify(input));
    if (request.resultHash) {
      if (request.resultHash !== inputHash) fail('IDEMPOTENCY_CONFLICT', 'A completed request cannot accept a different retry.');
      return { requestId: request.requestId, status: request.status };
    }
    if (beforeWrite) await beforeWrite(request);
    const next = this.getState(), record = next.requests.find(r => r.requestId === request.requestId);
    const superseded = next.requests.some(r => r.kind === 'translation' && r.language === request.language && r.generation > request.generation && r.segmentIds.some(id => request.segmentIds.includes(id)));
    const stale = request.snapshotId !== next.project.snapshotId || superseded || request.requiresTranslationMerge || request.segmentIds.some(id => (next.translations[request.language]?.[id]?.revision ?? 0) !== request.draftRevisions[id] || next.segments.find(item => item.id === id)?.beforeHash !== request.segments.find(item => item.id === id)?.sourceHash) || Object.entries(request.translationUnitRevisions || {}).some(([id, revision]) => (next.translations[request.language]?.[id]?.revision || 0) !== revision);
    record.status = stale ? 'stale' : 'completed'; record.resultHash = inputHash; record.completedAt = now();
    if (stale) record.historicalResult = results;
    else {
      next.translations[request.language] ??= {};
      for (const result of results) { const source=next.segments.find(s=>s.id===result.segmentId),current=next.translations[request.language][result.segmentId]; next.translations[request.language][result.segmentId] = { ...carryFormulaDraft(source,current,result.text,next.project), revision: request.draftRevisions[result.segmentId] + 1, sourceHash: result.sourceHash, status: 'saved', origin: 'ai', updatedAt: now() }; }
    }
    await this._commit(next);
    return { requestId: request.requestId, status: record.status };
  }); }
  proposeRevision(input, { beforeWrite } = {}) { return this._serial(async () => {
    strict(input, ['requestId', 'edits', 'reason']);
    const request = this._request(input.requestId, 'revision');
    text(input.reason, 'reason', 8192);
    if (!Array.isArray(input.edits) || input.edits.length < 1 || input.edits.length > request.segmentIds.length) fail('INVALID_INPUT', 'A proposal needs bounded registered segment edits.');
    const inputHash = sha256(JSON.stringify(input));
    if (request.resultHash) {
      if (request.resultHash !== inputHash) fail('IDEMPOTENCY_CONFLICT', 'A completed request cannot accept a different retry.');
      return copy(this._state.proposals.find(p => p.proposalId === request.proposalId));
    }
    if (beforeWrite) await beforeWrite(request);
    if (request.snapshotId !== this._state.project.snapshotId || request.status !== 'pending') fail('VERSION_CONFLICT', 'The request refers to an outdated source snapshot.');
    this._assertRevisionDraftCurrent(request);
    await this._assertSourceCurrent();
    const seen = new Set(), edits = [];
    for (const edit of input.edits) {
      strict(edit, ['segmentId', 'beforeHash', 'replacement']);
      if (seen.has(edit.segmentId) || !request.segmentIds.includes(edit.segmentId)) fail('PERMISSION_DENIED', 'An edit is outside the selected request scope.');
      seen.add(edit.segmentId);
      const selected = request.segments.find(item => item.id === edit.segmentId);
      const segment = this._revisionSource(edit.segmentId, selected?.sourceAuthority);
      if (!segment || edit.beforeHash !== segment.beforeHash) fail('VERSION_CONFLICT', 'The source segment changed.');
      if (!segment.translatable) fail('UNSUPPORTED_TEX', 'Opaque blocks cannot receive generated replacements.');
      const effective = formulaSourceForRequest(segment, selected, request, this._state);
      const replacement = restoreProtected(effective, edit.replacement);
      const newline = this._files.get(segment.path).text.includes('\r\n') ? '\r\n' : '\n';
      edits.push({ kind: 'replace', segmentId: segment.id, path: segment.path, startByte: segment.startByte, endByte: segment.endByte,
        beforeHash: segment.beforeHash, before: segment.source, replacement: replacement.replace(/\r?\n/g, newline), protectedTokenIds: segment.protectedTokens.map(t => t.id), ...(segment.sourceAuthority ? { sourceAuthority: segment.sourceAuthority } : {}) });
    }
    const proposal = { schemaVersion: 1, proposalId: `proposal-${randomUUID()}`, projectId: this._state.project.id, baseSnapshotId: request.snapshotId,
      context: { requestId: request.requestId, threadBindingId: request.bindingId, translationRevision: Math.max(0, ...Object.values(request.draftRevisions)), alignmentRevision: 0 },
      author: 'ai', reviewState: 'pending', applicationState: 'notApplied', reason: input.reason, edits, createdAt: now() };
    const next = this.getState(); next.proposals.push(proposal);
    const record = next.requests.find(r => r.requestId === request.requestId);
    record.resultHash = inputHash; record.proposalId = proposal.proposalId; record.status = 'completed';
    await this._commit(next); return copy(proposal);
  }); }
  rejectProposal({ proposalId }) { return this._serial(async () => {
    this._requireProject();
    const next = this.getState(), proposal = next.proposals.find(p => p.proposalId === proposalId);
    if (!proposal) fail('PROPOSAL_NOT_FOUND', 'The proposal does not exist.');
    if (proposal.applicationState !== 'notApplied') fail('INVALID_STATE', 'An already applied external change cannot be rejected; create a recovery proposal.');
    if (proposal.reviewState !== 'pending') fail('INVALID_STATE', 'Only a pending proposal can be rejected.');
    proposal.reviewState = 'rejected'; proposal.reviewedAt = now();
    await this._commit(next); return copy(proposal);
  }); }
  async _assertSourceCurrent() {
    for (const file of this._files.values()) {
      let bytes;
      try { bytes = await boundedRead((await inside(this._root, file.path)).path, MAX_FILE); }
      catch { fail('VERSION_CONFLICT', 'An input disappeared or became inaccessible; refresh the project.'); }
      if (sha256(bytes) !== file.hash) fail('VERSION_CONFLICT', 'An external edit changed the project; refresh and review the new source.');
    }
  }
  _assertRevisionDraftCurrent(request) {
    if (!request || request.kind !== 'revision') return;
    if (request.projectId !== this._state.project.id || request.snapshotId !== this._state.project.snapshotId) fail('VERSION_CONFLICT', 'The English candidate belongs to a different source version.');
    // Reading drafts shadow canonical drafts, exactly as in the public reading
    // projection. A compiled candidate must still represent the saved author
    // text even when the edit changed prose alone, without math/reference intent.
    const draft = id => formulaDraftFromState(this._state, request.language, id);
    for (const revisions of [request.draftRevisions, request.translationUnitRevisions]) {
      for (const [id, revision] of Object.entries(revisions || {})) {
        if ((draft(id)?.revision || 0) !== revision) fail('VERSION_CONFLICT', 'The saved author translation changed; generate a new English candidate before writing it back.');
      }
    }
    for (const selected of request.segments || []) {
      const captured = selected.translationDraft;
      if (typeof captured?.text !== 'string') continue;
      const ids = captured.translationUnitIds || [selected.id];
      const current = ids.map(id => draft(id)).filter(Boolean).map(item => item.text).join('\n\n');
      if (current !== captured.text) fail('VERSION_CONFLICT', 'The saved author translation differs from this exact English candidate.');
    }
  }
  _candidate(proposalIds) {
    this._requireProject();
    if (!Array.isArray(proposalIds) || !proposalIds.length || new Set(proposalIds).size !== proposalIds.length) fail('INVALID_INPUT', 'Select unique pending proposals.');
    const proposals = proposalIds.map(id => this._state.proposals.find(p => p.proposalId === id));
    if (proposals.some(p => !p)) fail('PROPOSAL_NOT_FOUND', 'A selected proposal no longer exists.');
    if (proposals.some(p => p.baseSnapshotId !== this._state.project.snapshotId || p.reviewState !== 'pending' || p.applicationState !== 'notApplied')) fail('VERSION_CONFLICT', 'Only current pending proposals can form a candidate.');
    for (const proposal of proposals) {
      if (proposal.context?.undoOf) continue; // Exact inverse ranges are verified against transaction before-images by the application.
      const request = this._state.requests.find(item => item.requestId === proposal.context?.requestId);
      this._assertRevisionDraftCurrent(request);
      for (const edit of proposal.edits) {
        const selected = request?.segments.find(item => item.id === edit.segmentId);
        const original=this._revisionSource(edit.segmentId,selected?.sourceAuthority||edit.sourceAuthority);
        const effective=original&&request?formulaSourceForRequest(original,selected,request,this._state):original;
        const authority = selected?.sourceAuthority || edit.sourceAuthority;
        if (!authority) {if(selected?.formulaEdits?.length||selected?.referenceEdits?.length||selected?.paragraphMathIntent)maskRawReplacement(effective,edit.replacement);continue;}
        const segment = this._revisionSource(edit.segmentId, authority);
        if (JSON.stringify(edit.sourceAuthority) !== JSON.stringify(authority) || edit.path !== segment.path || edit.startByte !== segment.startByte || edit.endByte !== segment.endByte || edit.beforeHash !== segment.beforeHash || edit.before !== segment.source) fail('VERSION_CONFLICT', 'The candidate no longer matches its verified literal interval.');
        maskRawReplacement(effective||segment, edit.replacement);
      }
    }
    const edits = proposals.flatMap(p => p.edits), byFile = new Map();
    for (const edit of edits) { if (!byFile.has(edit.path)) byFile.set(edit.path, []); byFile.get(edit.path).push(edit); }
    const files = [];
    for (const [filename, fileEdits] of byFile) {
      fileEdits.sort((a, b) => a.startByte - b.startByte);
      for (let i = 1; i < fileEdits.length; i++) if (fileEdits[i].startByte < fileEdits[i - 1].endByte) fail('OVERLAPPING_EDITS', 'Two selected proposals overlap; review them separately.');
      const original = this._files.get(filename);
      let bytes = Buffer.from(original.bytes);
      for (const edit of fileEdits.toReversed()) {
        if (sha256(bytes.subarray(edit.startByte, edit.endByte)) !== edit.beforeHash) fail('VERSION_CONFLICT', 'The selected source interval no longer matches.');
        bytes = Buffer.concat([bytes.subarray(0, edit.startByte), Buffer.from(edit.replacement), bytes.subarray(edit.endByte)]);
      }
      files.push({ path: filename, content: decode(bytes), hash: sha256(bytes), beforeHash: original.hash });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const candidateHash = sha256(JSON.stringify({ baseSnapshotId: this._state.project.snapshotId, proposalIds: [...proposalIds].sort(), files: files.map(({ path, hash }) => ({ path, hash })) }));
    return { transactionId: `candidate-${candidateHash.slice(0, 24)}`, baseSnapshotId: this._state.project.snapshotId, candidateHash, proposalIds: [...proposalIds], files,
      state: 'previewOnly', compile: { status: 'unavailable', code: 'CAPABILITY_UNAVAILABLE', message: 'No verified isolated compiler is configured. This candidate has not been compiled.' }, directApply: false };
  }
  previewTransaction({ proposalIds }) { return this._serial(async () => {
    await this._assertSourceCurrent();
    const candidate = this._candidate(proposalIds);
    const next = this.getState();
    if (!next.previews.some(p => p.candidateHash === candidate.candidateHash)) next.previews.push(candidate);
    await atomicJson(path.join(this._store, 'candidates', `${candidate.candidateHash}.json`), candidate);
    await this._commit(next); return copy(candidate);
  }); }
  exportPatch({ proposalIds }) { return this._serial(async () => {
    await this._assertSourceCurrent();
    const candidate = this._candidate(proposalIds);
    let patch = '';
    for (const file of candidate.files) {
      const before = this._files.get(file.path).text;
      const beforeLines = before.match(/[^\n]*\n|[^\n]+$/g) ?? [], afterLines = file.content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      patch += `diff --git a/${file.path} b/${file.path}\n--- a/${file.path}\n+++ b/${file.path}\n@@ -1,${beforeLines.length} +1,${afterLines.length} @@\n`;
      const add = (prefix, lines) => { for (const line of lines) { patch += prefix + line; if (!line.endsWith('\n')) patch += '\n\\ No newline at end of file\n'; } };
      add('-', beforeLines); add('+', afterLines);
    }
    return { patch, filename: `paper-review-${candidate.candidateHash.slice(0, 12)}.patch`, candidateHash: candidate.candidateHash, baseSnapshotId: candidate.baseSnapshotId, compiled: false };
  }); }
  async readPdf() {
    this._requireProject();
    const projectId = this._state.project.id;
    const filename = this._state.project.mainFile.replace(/\.tex$/i, '.pdf');
    let resolved;
    try { resolved = await inside(this._root, filename); }
    catch (e) { if (e.code === 'ENOENT') fail('PDF_UNAVAILABLE', 'No existing PDF was found. Automatic compilation is unavailable.'); throw e; }
    const stat = await lstat(resolved.path);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) fail('PDF_TOO_LARGE', 'PDF exceeds the 20 MiB display limit.');
    const bytes = await boundedRead(resolved.path, 20 * 1024 * 1024, 'PDF_TOO_LARGE');
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) fail('INVALID_PDF', 'The artifact does not have a PDF signature.');
    if (this._state.project?.id !== projectId) fail('VERSION_CONFLICT', 'The selected project changed while its PDF was being read.');
    return { base64: bytes.toString('base64'), mimeType: 'application/pdf', filename, projectId, provenance: 'existing-unverified', snapshotId: null, hash: sha256(bytes) };
  }
}
