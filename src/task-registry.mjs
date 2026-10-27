import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, open, rename, unlink } from 'node:fs/promises';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const hash = value => createHash('sha256').update(value).digest('hex');
const stamp = () => new Date().toISOString();
const idPattern = /^workspace-[a-f0-9]{32}$/;
const safeId = value => value === null || typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const mainName = value => typeof value === 'string' && value.length <= 1024 && /\.tex$/i.test(value) && !path.isAbsolute(value) && !value.replaceAll('\\', '/').split('/').some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f<>"|?*]/.test(part));

/** Private metadata only. Source snapshots, PDF pairs and chat messages remain in
 * their existing stores and are never copied into this index. */
export class TaskRegistry {
  constructor({ dataRoot, codexRoot }) {
    if (!path.isAbsolute(dataRoot) || !path.isAbsolute(codexRoot)) throw new TypeError('Absolute private registry roots are required.');
    this.dataRoot = dataRoot; this.codexRoot = codexRoot; this.filename = path.join(dataRoot, 'workspace-index.json'); this.queue = Promise.resolve();
  }
  paths(record) {
    if (!idPattern.test(record.recordId)) fail('REGISTRY_RECOVERY_REQUIRED', 'The saved workspace identity is invalid.');
    const stateRoot = record.legacy ? this.dataRoot : path.join(this.dataRoot, 'tasks', record.recordId);
    const chatRoot = record.legacy ? this.codexRoot : path.join(this.codexRoot, 'tasks', record.recordId);
    return { stateRoot, chatRoot, contextDir: path.join(chatRoot, 'context') };
  }
  _validate(record) {
    if (!record || !idPattern.test(record.recordId) || typeof record.projectRoot !== 'string' || !path.isAbsolute(record.projectRoot) || record.projectRoot.length > 4096 || !mainName(record.mainFile) || !safeId(record.hostTaskId) || !safeId(record.hostProjectId) || typeof record.legacy !== 'boolean' || typeof record.createdAt !== 'string' || typeof record.lastOpenedAt !== 'string' || !['mcp-roots', 'native-launch-cwd', 'explicit-launch-binding', 'human-selection', 'saved-record'].includes(record.hostSource)) fail('REGISTRY_RECOVERY_REQUIRED', 'The private workspace index is invalid; it was preserved for recovery.');
    for (const key of ['model', 'effort', 'threadId']) if (record[key] !== null && (typeof record[key] !== 'string' || record[key].length > 128)) fail('REGISTRY_RECOVERY_REQUIRED', 'A saved model binding is invalid.');
    if (record.hostProjectRoot !== undefined && record.hostProjectRoot !== null && (typeof record.hostProjectRoot !== 'string' || !path.isAbsolute(record.hostProjectRoot) || record.hostProjectRoot.length > 4096 || /[\x00-\x1f]/u.test(record.hostProjectRoot))) fail('REGISTRY_RECOVERY_REQUIRED', 'The saved invoking-project identity is invalid.');
    for (const [key, maximum] of [['paperTitle', 240], ['boundChatTitle', 160]]) if (record[key] !== undefined && record[key] !== null && (typeof record[key] !== 'string' || record[key].length > maximum || /[\x00-\x1f\x7f]/u.test(record[key]))) fail('REGISTRY_RECOVERY_REQUIRED', 'A saved project display label is invalid.');
    return record;
  }
  async _read() {
    let info; try { info = await lstat(this.filename); } catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, records: [] }; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 2 * 1024 * 1024) fail('REGISTRY_RECOVERY_REQUIRED', 'The private workspace index cannot be read safely.');
    let data; try { data = JSON.parse(await readFile(this.filename, 'utf8')); } catch { fail('REGISTRY_RECOVERY_REQUIRED', 'The private workspace index is unreadable; no records were overwritten.'); }
    if (data.schemaVersion !== 1 || !Array.isArray(data.records) || data.records.length > 2000) fail('REGISTRY_RECOVERY_REQUIRED', 'The private workspace index uses an unsupported format.');
    const seen = new Set(); let legacyCount = 0; for (const record of data.records) { this._validate(record); if (seen.has(record.recordId) || record.legacy && ++legacyCount > 1) fail('REGISTRY_RECOVERY_REQUIRED', 'Duplicate workspace identities require recovery.'); seen.add(record.recordId); }
    if (data.chatSelections !== undefined) {
      if (!Array.isArray(data.chatSelections) || data.chatSelections.length > 2000) fail('REGISTRY_RECOVERY_REQUIRED', 'Saved explicit chat selections are invalid.');
      const chats = new Set();
      for (const selection of data.chatSelections) {
        const record = data.records.find(item => item.recordId === selection?.recordId);
        if (!selection || Object.keys(selection).some(key => !['threadId', 'recordId', 'hostProjectRoot', 'selectedAt'].includes(key)) || !safeId(selection.threadId) || !selection.threadId || !record || record.threadId !== selection.threadId || chats.has(selection.threadId) || typeof selection.hostProjectRoot !== 'string' || !path.isAbsolute(selection.hostProjectRoot) || selection.hostProjectRoot.length > 4096 || /[\x00-\x1f]/u.test(selection.hostProjectRoot) || typeof selection.selectedAt !== 'string' || !Number.isFinite(Date.parse(selection.selectedAt))) fail('REGISTRY_RECOVERY_REQUIRED', 'An explicit paper/chat selection lost its exact saved identity.');
        chats.add(selection.threadId);
      }
    }
    return data;
  }
  async records() { return structuredClone((await this._read()).records.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))); }
  async get(recordId) { if (!idPattern.test(recordId || '')) fail('INVALID_INPUT', 'Choose a saved workspace record.'); const record = (await this._read()).records.find(item => item.recordId === recordId); if (!record) fail('WORKSPACE_RECORD_NOT_FOUND', 'This workspace record is unavailable.'); return { ...record, ...this.paths(record) }; }
  async chatSelection(threadId) { if (!safeId(threadId) || !threadId) return null; return structuredClone((await this._read()).chatSelections?.find(item => item.threadId === threadId) || null); }
  async selectForChat({ threadId, recordId, hostProjectRoot }) {
    return this._write(data => {
      const record = data.records.find(item => item.recordId === recordId);
      if (!safeId(threadId) || !threadId || !record || record.threadId !== threadId || typeof hostProjectRoot !== 'string' || !path.isAbsolute(hostProjectRoot) || hostProjectRoot.length > 4096 || /[\x00-\x1f]/u.test(hostProjectRoot)) fail('WORKSPACE_RECORD_CHANGED', 'Only an explicitly verified saved paper/chat pair may be selected.');
      const selection = { threadId, recordId, hostProjectRoot, selectedAt: stamp() };
      record.lastOpenedAt = selection.selectedAt;
      data.chatSelections = [...(data.chatSelections || []).filter(item => item.threadId !== threadId), selection]; return structuredClone(selection);
    });
  }
  _write(work) {
    const operation = this.queue.then(async () => {
      await mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
      const lockPath = path.join(this.dataRoot, '.workspace-index.lock'); let lock;
      try { lock = await open(lockPath, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') fail('REGISTRY_BUSY', 'Another workspace index writer is active; retry after it finishes.'); throw error; }
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: stamp() })); await lock.sync();
        const data = await this._read(), result = await work(data);
        if (data.records.length > 2000) fail('REGISTRY_FULL', 'The private workspace record limit was reached; no history was removed.');
        const serialized = JSON.stringify(data, null, 2); if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) fail('REGISTRY_FULL', 'The private workspace index reached its byte limit; no history was removed.');
        const handle = await open(temporary, 'wx', 0o600); try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, this.filename); return result;
      } finally { await unlink(temporary).catch(() => {}); await lock.close(); await unlink(lockPath); }
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  async register({ projectRoot, mainFile, hostTaskId = null, hostProjectId = null, hostProjectRoot = null, hostSource = 'human-selection', legacy = false, sourceLanguage = 'en', targetLanguage = 'zh-CN' }) {
    mainFile = mainFile.replaceAll('\\', '/');
    const identity = process.platform === 'win32' ? `${projectRoot.toLowerCase()}\0${mainFile.toLowerCase()}` : `${projectRoot}\0${mainFile}`;
    const recordId = `workspace-${hash(`${hostTaskId || 'unidentified-host'}\0${identity}`).slice(0, 32)}`;
    return this._write(data => {
      let record = data.records.find(item => item.recordId === recordId);
      if (!record) {
        if (legacy && data.records.some(item => item.legacy)) legacy = false;
        record = { recordId, projectRoot, rootLabel: path.basename(projectRoot), mainFile, hostTaskId, hostProjectId, hostProjectRoot, hostSource, legacy, sourceLanguage, targetLanguage, model: null, effort: null, threadId: null, createdAt: stamp(), lastOpenedAt: stamp() };
        this._validate(record); data.records.push(record);
      } else { record.lastOpenedAt = stamp(); if (!record.hostProjectRoot && hostProjectRoot) record.hostProjectRoot = hostProjectRoot; this._validate(record); }
      return { ...structuredClone(record), ...this.paths(record) };
    });
  }
  async touch(recordId, binding = {}) {
    return this._write(data => {
      const record = data.records.find(item => item.recordId === recordId); if (!record) fail('WORKSPACE_RECORD_NOT_FOUND', 'This workspace record is unavailable.');
      if (binding.threadId != null && data.chatSelections?.some(selection => selection.recordId === recordId && selection.threadId !== binding.threadId)) fail('WORKSPACE_RECORD_CHANGED', 'The explicit paper/chat selection must be preserved before changing its saved chat.');
      if (binding.hostProjectRoot !== undefined) {
        if (!binding.hostTaskId || record.hostTaskId !== binding.hostTaskId) fail('WORKSPACE_RECORD_CHANGED', 'Only this exact invoking task can capture its project identity.');
        if (!record.hostProjectRoot) record.hostProjectRoot = binding.hostProjectRoot;
      }
      record.lastOpenedAt = stamp();
      for (const key of ['model', 'effort', 'threadId']) if (binding[key] !== undefined && binding[key] !== null) record[key] = binding[key];
      if (binding.effort === null) record.effort = null;
      for (const key of ['paperTitle', 'boundChatTitle']) if (binding[key] !== undefined && binding[key] !== null) record[key] = binding[key];
      this._validate(record); return { ...structuredClone(record), ...this.paths(record) };
    });
  }
}
