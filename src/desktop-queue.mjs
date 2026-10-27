import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, open, rename, realpath, unlink, link } from 'node:fs/promises';
import path from 'node:path';
import { CodexBridge } from './codex-bridge.mjs';
import { isProcessProvenDead } from './process-probe.mjs';

const MAX_TEXT = 128 * 1024, MAX_RECEIPTS = 256, MAX_FILE = 1024 * 1024, PAGE = 16;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const strict = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const text = value => typeof value === 'string' && value.trim() && Buffer.byteLength(value) <= MAX_TEXT && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const inputText = input => Array.isArray(input) && input.length === 1 && strict(input[0], ['type', 'text', 'textElements', 'text_elements']) && input[0].type === 'text' && text(input[0].text) && (input[0].textElements === undefined || Array.isArray(input[0].textElements) && input[0].textElements.length === 0) && (input[0].text_elements === undefined || Array.isArray(input[0].text_elements) && input[0].text_elements.length === 0) ? input[0].text : null;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameLock = (a, b) => a.info.dev === b.info.dev && a.info.ino === b.info.ino && a.info.nlink === b.info.nlink && a.info.size === b.info.size && a.digest === b.digest && a.value.owner === b.value.owner && a.value.pid === b.value.pid;

/** A queue producer, never a chat writer. No thread can be loaded or resumed,
 * and no turn, settings update, tools or inference method reaches its process. */
export class DesktopQueueBridge extends CodexBridge {
  constructor({ threadId, dataRoot, command, requestTimeoutMs = 15000, processProbe = isProcessProvenDead } = {}) {
    if (!id(threadId)) throw new TypeError('Use one exact verified Desktop chat identity.');
    if (typeof processProbe !== 'function') throw new TypeError('Use a bounded read-only process probe.');
    super({ dataRoot, cwd: dataRoot, command, requestTimeoutMs, toolSpecs: [], handleTool: null }); this.originThreadId = threadId; this.processProbe = processProbe;
  }
  async _queueLockSnapshot(filename) {
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096 || !samePath(await realpath(filename), filename)) throw Error('Invalid control lock');
      const bytes = await readFile(filename), value = JSON.parse(bytes);
      if (bytes.length > 4096 || !strict(value, ['owner', 'pid', 'createdAt']) || !id(value.owner) || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) throw Error('Invalid control lock owner');
      return { info, value, digest: hash(bytes) };
    } catch { fail('DESKTOP_QUEUE_RECOVERY_REQUIRED', 'The queue control lock identity could not be verified. It was not removed.'); }
  }
  _quarantineQueueLock(filename, quarantine) { return rename(filename, quarantine); }
  async _recoverDeadQueueLock() {
    const filename = path.join(this.dataRoot, '.codex-chat.lock'), before = await this._queueLockSnapshot(filename);
    if (await this.processProbe(before.value.pid) !== true) fail('CHAT_IN_USE', 'A live or unverifiable queue producer owns this private control directory.');
    const checked = await this._queueLockSnapshot(filename);
    if (!sameLock(before, checked) || await this.processProbe(checked.value.pid) !== true) fail('DESKTOP_QUEUE_RECOVERY_REQUIRED', 'The queue control lock changed during recovery.');
    const quarantine = filename + '.quarantine-' + randomUUID();
    await this._quarantineQueueLock(filename, quarantine);
    let moved;
    try {
      moved = await this._queueLockSnapshot(quarantine);
      if (!sameLock(before, moved) || await this.processProbe(moved.value.pid) !== true) throw Error('Changed control lock');
      // The Windows fallback is asynchronous. Its wait must not permit a new
      // inode or owner to replace the quarantined path before deletion.
      const final = await this._queueLockSnapshot(quarantine);
      if (!sameLock(before, final)) throw Error('Changed control lock after process proof');
    } catch {
      // Never overwrite a newly acquired original lock. If a replacement was
      // moved, restore its exact inode with a non-overwriting link; otherwise
      // retain the quarantine for explicit recovery rather than delete it.
      try { await link(quarantine, filename); await unlink(quarantine); } catch {}
      fail('DESKTOP_QUEUE_RECOVERY_REQUIRED', 'The queue control lock changed. No producer was taken over.');
    }
    await unlink(quarantine);
  }
  async connect() {
    if (this._queueConnecting) return this._queueConnecting;
    this._queueConnecting = (async () => {
      const root = await lstat(this.dataRoot);
      if (!root.isDirectory() || root.isSymbolicLink() || !samePath(await realpath(this.dataRoot), this.dataRoot)) fail('DESKTOP_QUEUE_RECOVERY_REQUIRED', 'The private queue directory changed.');
      const conversation = await lstat(path.join(this.dataRoot, 'chat-state.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (conversation) fail('DESKTOP_QUEUE_RECOVERY_REQUIRED', 'A conversation state directory cannot be recovered as a queue-only control directory.');
      try { return await super.connect(); }
      catch (error) { if (error.code !== 'CHAT_IN_USE') throw error; }
      await this._recoverDeadQueueLock();
      // A concurrent producer may have acquired the original name. Its lock
      // remains authoritative; this second attempt never retries recovery.
      return super.connect();
    })();
    try { return await this._queueConnecting; } finally { this._queueConnecting = null; }
  }
  _request(method, params = {}) {
    if (!plain(params)) return Promise.reject(Object.assign(new Error('Use exact bounded Desktop queue parameters.'), { code: 'DESKTOP_QUEUE_ONLY' }));
    const fixed = params.threadId === this.originThreadId;
    const allowed = method === 'initialize'
      || method === 'thread/read' && fixed && strict(params, ['threadId', 'includeTurns']) && params.includeTurns === false
      || method === 'thread/queue/add' && fixed && strict(params, ['threadId', 'clientUserMessageId', 'input']) && id(params.clientUserMessageId) && inputText(params.input) !== null
      || method === 'thread/queue/list' && fixed && strict(params, ['threadId', 'limit', 'cursor']) && Number.isInteger(params.limit) && params.limit >= 1 && params.limit <= PAGE && (params.cursor === undefined || typeof params.cursor === 'string' && params.cursor.length > 0 && params.cursor.length <= 4096);
    if (!allowed) return Promise.reject(Object.assign(new Error('This connection only reads its exact chat identity and produces or inspects its bounded message queue.'), { code: 'DESKTOP_QUEUE_ONLY' }));
    return super._request(method, params);
  }
  _persist() { return Promise.resolve(); }
}

/** Durable receipts contain hashes and delivery identities, never manuscript
 * text. Persist uncertainty BEFORE queue/add. A crash or lost acknowledgment
 * cannot cause an automatic resend. Only Desktop's own loaded chat executes. */
export class DesktopQueueProducer {
  constructor({ threadId, dataRoot, command, Bridge = DesktopQueueBridge, desktopQueueVerified = false } = {}) {
    if (!id(threadId) || typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) || typeof Bridge !== 'function' || typeof desktopQueueVerified !== 'boolean') throw new TypeError('Use an exact chat, private absolute directory and explicit verified Desktop queue capability.');
    this.threadId = threadId; this.dataRoot = path.resolve(dataRoot); this.filename = path.join(this.dataRoot, 'desktop-queue-outbox.json'); this.command = command; this.Bridge = Bridge; this.desktopQueueVerified = desktopQueueVerified;
    this.receipts = []; this.metadata = null; this.loaded = false; this.bridge = null; this.opened = false; this.closed = false; this.pending = Promise.resolve();
  }
  state() { return structuredClone({ threadId: this.threadId, desktopQueueVerified: this.desktopQueueVerified, writerOwned: false, metadata: this.metadata, receipts: this.receipts }); }
  _serial(work) { const pending = this.pending.catch(() => {}).then(() => { if (this.closed) fail('DESKTOP_QUEUE_CLOSED', 'The Desktop queue producer is closed.'); return work(); }); this.pending = pending; return pending; }
  async _load() {
    if (this.closed) fail('DESKTOP_QUEUE_CLOSED', 'The Desktop queue producer is closed.');
    await mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    const root = await lstat(this.dataRoot);
    if (!root.isDirectory() || root.isSymbolicLink() || !samePath(await realpath(this.dataRoot), this.dataRoot)) fail('DESKTOP_QUEUE_RECOVERY_REQUIRED', 'The private queue directory identity could not be verified.');
    const info = await lstat(this.filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) { this.receipts = []; this.loaded = true; return; }
    try {
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE) throw Error('Invalid outbox file');
      const saved = JSON.parse(await readFile(this.filename, 'utf8')), seen = new Set();
      if (!strict(saved, ['schemaVersion', 'threadId', 'receipts']) || saved.schemaVersion !== 1 || saved.threadId !== this.threadId || !Array.isArray(saved.receipts) || saved.receipts.length > MAX_RECEIPTS) throw Error('Invalid outbox identity');
      for (const row of saved.receipts) {
        if (!strict(row, ['threadId', 'clientUserMessageId', 'inputHash', 'status', 'queuedSubmissionId', 'observedTurnId', 'createdAt', 'updatedAt']) || row.threadId !== this.threadId || !id(row.clientUserMessageId) || seen.has(row.clientUserMessageId) || !/^[a-f0-9]{64}$/u.test(row.inputHash || '') || !['queued', 'uncertain', 'completed'].includes(row.status) || row.status === 'queued' && !id(row.queuedSubmissionId) || row.status === 'completed' && !id(row.observedTurnId) || typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string') throw Error('Invalid outbox receipt');
        seen.add(row.clientUserMessageId);
      }
      this.receipts = saved.receipts; this.loaded = true;
    } catch { fail('DESKTOP_QUEUE_RECOVERY_REQUIRED', 'The saved Desktop delivery receipts require explicit recovery; they were not overwritten.'); }
  }
  async _save() {
    const value = JSON.stringify({ schemaVersion: 1, threadId: this.threadId, receipts: this.receipts });
    if (Buffer.byteLength(value) > MAX_FILE) fail('DESKTOP_QUEUE_FULL', 'The Desktop delivery receipt file is full.');
    const temp = this.filename + '.' + randomUUID() + '.tmp', handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, this.filename);
  }
  async _open() {
    if (!this.loaded) await this._load();
    if (!this.opened) { this.bridge ||= new this.Bridge({ threadId: this.threadId, dataRoot: this.dataRoot, command: this.command }); await this.bridge.connect(); this.opened = true; await this._load(); }
  }
  async _verify() {
    await this._open();
    const result = await this.bridge._request('thread/read', { threadId: this.threadId, includeTurns: false }), thread = result?.thread;
    if (thread?.id !== this.threadId) fail('THREAD_MISMATCH', 'The queue connection returned another chat identity.');
    if (!id(thread.model) || thread.reasoningEffort != null && !id(thread.reasoningEffort) || typeof thread.cwd !== 'string' || !path.isAbsolute(thread.cwd) || /[\x00-\x1f]/u.test(thread.cwd)) fail('DESKTOP_QUEUE_METADATA_UNAVAILABLE', 'The Desktop chat model and project metadata could not be verified.');
    this.metadata = { threadId: this.threadId, title: String(thread.name || '').replace(/[\x00-\x1f]/gu, '').slice(0, 160), model: thread.model, effort: thread.reasoningEffort || null, cwd: thread.cwd };
    return structuredClone(this.metadata);
  }
  verify() { return this._serial(() => this._verify()); }
  _existing(clientUserMessageId, inputHash) {
    const row = this.receipts.find(receipt => receipt.clientUserMessageId === clientUserMessageId); if (!row) return null;
    if (row.inputHash !== inputHash) fail('DESKTOP_QUEUE_ID_CONFLICT', 'A delivery identity cannot be reused for different text.');
    if (!['queued', 'completed'].includes(row.status)) fail('DESKTOP_QUEUE_DELIVERY_UNCERTAIN', 'Delivery needs confirmation. This request will not be automatically sent again.');
    return structuredClone(row);
  }
  enqueue(input, { beforeEnqueue } = {}) {
    return this._serial(async () => {
      if (!this.desktopQueueVerified) fail('DESKTOP_QUEUE_UNVERIFIED', 'Desktop queue execution has not been verified on this installation.');
      if (!strict(input, ['clientUserMessageId', 'text']) || !id(input.clientUserMessageId) || !text(input.text)) fail('INVALID_INPUT', 'Use one delivery identity and nonempty text of at most 128 KiB.');
      if (!this.loaded) await this._load(); const inputHash = hash(input.text), old = this._existing(input.clientUserMessageId, inputHash); if (old) return old;
      try {
        const metadata = await this._verify(); if (this.closed) fail('DESKTOP_QUEUE_CLOSED', 'The Desktop queue producer is closed.'); const concurrent = this._existing(input.clientUserMessageId, inputHash); if (concurrent) return concurrent;
        if (beforeEnqueue !== undefined && typeof beforeEnqueue !== 'function') fail('INVALID_INPUT', 'Use a trusted pre-delivery metadata callback.');
        await beforeEnqueue?.(metadata); if (this.closed) fail('DESKTOP_QUEUE_CLOSED', 'The Desktop queue producer is closed.');
        if (this.receipts.length >= MAX_RECEIPTS) fail('DESKTOP_QUEUE_FULL', 'The Desktop delivery receipt limit has been reached.');
      } catch (error) {
        if (!this.receipts.some(receipt => receipt.clientUserMessageId === input.clientUserMessageId)) Object.assign(error, { deliveryAttempted: false, clientUserMessageId: input.clientUserMessageId });
        throw error;
      }
      const now = new Date().toISOString(), row = { threadId: this.threadId, clientUserMessageId: input.clientUserMessageId, inputHash, status: 'uncertain', createdAt: now, updatedAt: now };
      this.receipts.push(row);
      try { await this._save(); } catch (error) { this.receipts = this.receipts.filter(item => item !== row); throw Object.assign(error, { deliveryAttempted: false, clientUserMessageId: input.clientUserMessageId }); }
      try {
        if (this.closed) fail('DESKTOP_QUEUE_CLOSED', 'The Desktop queue producer closed before delivery.');
        const response = await this.bridge._request('thread/queue/add', { threadId: this.threadId, clientUserMessageId: input.clientUserMessageId, input: [{ type: 'text', text: input.text }] }), queued = response?.queuedSubmission;
        if (!id(queued?.id) || queued.clientUserMessageId !== row.clientUserMessageId || inputText(queued.input) !== input.text) throw Error('Unverified queue acknowledgment');
        row.status = 'queued'; row.queuedSubmissionId = queued.id; row.updatedAt = new Date().toISOString(); await this._save(); return structuredClone(row);
      } catch (error) { row.status = 'uncertain'; delete row.queuedSubmissionId; await this._save(); throw Object.assign(new Error('The queue acknowledgment could not be verified. Check the bound Desktop chat; this request will not be automatically sent again.'), { code: 'DESKTOP_QUEUE_DELIVERY_UNCERTAIN', causeCode: /^[A-Z][A-Z0-9_]{1,63}$/u.test(error?.code || '') ? error.code : 'DESKTOP_QUEUE_ACK_MISMATCH', ...(Number.isSafeInteger(error?.rpcCode) ? { rpcCode: error.rpcCode } : {}) }); }
    });
  }
  reconcile() {
    return this._serial(async () => {
      await this._verify(); const wanted = new Map(this.receipts.filter(row => row.status === 'uncertain').map(row => [row.clientUserMessageId, row])), matches = new Map(), seen = new Set(); let cursor;
      if (!wanted.size) return this.state();
      for (let page = 0; page < 8; page++) {
        const result = await this.bridge._request('thread/queue/list', { threadId: this.threadId, limit: PAGE, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(result?.data) || result.data.length > PAGE) fail('DESKTOP_QUEUE_RECONCILIATION_CONFLICT', 'The queued receipt page could not be verified.');
        for (const item of result.data) if (wanted.has(item.clientUserMessageId)) {
          const body = inputText(item.input), row = wanted.get(item.clientUserMessageId);
          if (!id(item.id) || body === null || hash(body) !== row.inputHash || matches.has(item.clientUserMessageId)) fail('DESKTOP_QUEUE_RECONCILIATION_CONFLICT', 'The queued payload differs from its exact saved request.');
          matches.set(item.clientUserMessageId, item.id);
        }
        cursor = result.nextCursor; if (cursor == null || matches.size === wanted.size) break;
        if (typeof cursor !== 'string' || !cursor || cursor.length > 4096 || seen.has(cursor)) fail('DESKTOP_QUEUE_RECONCILIATION_CONFLICT', 'The queued receipt cursor could not be verified.'); seen.add(cursor);
      }
      for (const [clientId, queuedSubmissionId] of matches) Object.assign(wanted.get(clientId), { status: 'queued', queuedSubmissionId, updatedAt: new Date().toISOString() });
      if (matches.size) await this._save(); return this.state();
    });
  }
  observeCompleted(input, readTurn) {
    return this._serial(async () => {
      if (!strict(input, ['clientUserMessageId', 'turnId']) || !id(input.clientUserMessageId) || !id(input.turnId) || typeof readTurn !== 'function') fail('INVALID_INPUT', 'An exact saved delivery, turn and trusted read-only observation callback are required.');
      if (!this.loaded) await this._load(); const row = this.receipts.find(receipt => receipt.clientUserMessageId === input.clientUserMessageId);
      if (!row) fail('DESKTOP_QUEUE_OBSERVATION_MISMATCH', 'The observed turn has no owned delivery receipt.');
      const observed = await readTurn(this.threadId, input.turnId);
      if (this.closed || observed?.threadId !== this.threadId || observed.turnId !== input.turnId || observed.status !== 'completed' || typeof observed.userText !== 'string' || hash(observed.userText) !== row.inputHash || row.status === 'completed' && row.observedTurnId !== input.turnId) fail('DESKTOP_QUEUE_OBSERVATION_MISMATCH', 'The observed completed turn does not match the exact saved user input.');
      Object.assign(row, { status: 'completed', observedTurnId: input.turnId, updatedAt: new Date().toISOString() }); await this._save(); return structuredClone(row);
    });
  }
  async close() { if (this.closed) return; this.closed = true; await this.pending.catch(() => {}); await this.bridge?.close(); this.opened = false; }
}
