import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });

/** Desktop mode proxies the existing native app-server and owns only its proxy
 * subprocess. Configuration mode launches a fresh, configuration-only process;
 * it cannot run thread/model/MCP calls and is NEVER Desktop validation evidence.
 * Neither mode resumes, unsubscribes or closes any thread automatically. Callers
 * must authorize every operation. No payloads, stderr or credentials are logged.
 */
export class NativeAppControl extends EventEmitter {
  constructor({ command = 'codex', socket = null, transportMode = 'proxy', requestTimeoutMs = 30000, maxMessageBytes = 16 * 1024 * 1024, clientInfo = { name: 'bilingual_native_acceptance', title: 'Bilingual Paper Native Acceptance', version: '1.6.4' }, onServerRequest = null } = {}) {
    super();
    if (typeof command !== 'string' || !command || socket !== null && (typeof socket !== 'string' || !socket) || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || !Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1024 || maxMessageBytes > 16 * 1024 * 1024) throw new TypeError('Use a valid native proxy command and bounded time/message limits.');
    if (!['proxy', 'configuration'].includes(transportMode) || transportMode === 'configuration' && socket !== null) throw new TypeError('Choose the Desktop proxy or a configuration-only fresh process.');
    this.command = command; this.socket = socket; this.transportMode = transportMode; this.requestTimeoutMs = requestTimeoutMs; this.maxMessageBytes = maxMessageBytes;
    this.clientInfo = { ...clientInfo }; this.onServerRequest = onServerRequest; this.child = null; this.nextId = 0; this.pending = new Map(); this.buffer = ''; this.decoder = new StringDecoder('utf8'); this.closed = false;
  }
  async open() {
    if (this.child) throw failure('CONTROL_ALREADY_OPEN', 'This native control connection is already open.');
    if (this.closed) throw failure('CONTROL_CLOSED', 'Create a new control connection after closing it.');
    const args = this.transportMode === 'configuration' ? ['app-server', '--listen', 'stdio://'] : ['app-server', 'proxy', ...(this.socket ? ['--sock', this.socket] : [])];
    this.child = spawn(this.command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', bytes => this._read(bytes));
    this.child.stderr.on('data', () => {}); // Drain without retaining auth/diagnostic text.
    this.child.on('error', error => this._fail(failure(error.code || 'CONTROL_PROCESS_FAILED', 'The native control proxy could not run.')));
    this.child.on('exit', (code, signal) => this._fail(failure('CONTROL_PROCESS_EXITED', 'The native control proxy exited.', { exitCode: code, signal })));
    try {
      const initialized = await this.request('initialize', { clientInfo: this.clientInfo, capabilities: { experimentalApi: true } });
      this.notify('initialized', {}); return initialized;
    } catch (error) { await this.close(); throw error; }
  }
  _write(value) {
    if (this.closed || !this.child?.stdin?.writable) throw failure('CONTROL_CLOSED', 'The native control proxy is not connected.');
    const line = JSON.stringify(value);
    if (Buffer.byteLength(line) > this.maxMessageBytes) throw failure('CONTROL_MESSAGE_TOO_LARGE', 'The native protocol message exceeds its bounded budget.');
    this.child.stdin.write(line + '\n');
  }
  request(method, params, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (typeof method !== 'string' || !method || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return Promise.reject(new TypeError('Use an exact method and positive timeout.'));
    if (this.transportMode === 'configuration' && !['initialize', 'config/read', 'config/batchWrite', 'config/value/write'].includes(method)) return Promise.reject(failure('CONFIGURATION_ONLY', 'A fresh configuration process cannot run thread, model, MCP or other runtime methods.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(failure('CONTROL_REQUEST_TIMEOUT', `Native method timed out: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this._write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method, params) {
    if (this.transportMode === 'configuration' && method !== 'initialized') throw failure('CONFIGURATION_ONLY', 'A fresh configuration process permits only the initialization notification.');
    this._write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }
  _read(bytes) {
    this.buffer += this.decoder.write(bytes);
    for (;;) {
      const end = this.buffer.indexOf('\n');
      if (end < 0) break;
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > this.maxMessageBytes) { this._stopMalformed('CONTROL_MESSAGE_TOO_LARGE', 'The native protocol response exceeds its bounded budget.'); return; }
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { this._stopMalformed('CONTROL_INVALID_JSON', 'The native control proxy returned invalid JSON.'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { this._stopMalformed('CONTROL_INVALID_JSON', 'The native control proxy returned a nonobject message.'); return; }
      if (message.method) {
        if (message.id !== undefined) void this._serverRequest(message);
        else this.emit('notification', message.method, message.params);
        continue;
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(failure('NATIVE_RPC_ERROR', String(message.error.message || 'The native app-server rejected the request.'), { rpcCode: message.error.code, rpcMethod: pending.method, rpcData: message.error.data }));
        else pending.resolve(message.result);
      }
    }
    if (Buffer.byteLength(this.buffer) > this.maxMessageBytes) this._stopMalformed('CONTROL_MESSAGE_TOO_LARGE', 'The native protocol response exceeds its bounded budget.');
  }
  async _serverRequest(message) {
    try {
      if (typeof this.onServerRequest !== 'function') {
        this._write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'This control client does not authorize server requests.' } });
        this.emit('serverRequestDenied', message.method); return;
      }
      const result = await this.onServerRequest(message.method, message.params);
      this._write({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      try { this._write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'The native control server-request handler failed.' } }); } catch {}
      this.emit('serverRequestFailure', message.method, error);
    }
  }
  _stopMalformed(code, message) { this._fail(failure(code, message)); this.child?.kill(); }
  _fail(error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear(); this.emit('failure', error);
  }
  async close() {
    if (this.closed) return; this.closed = true;
    const child = this.child; this.child = null;
    this._fail(failure('CONTROL_CLOSED', 'The native control connection closed.'));
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => { const timer = setTimeout(resolve, 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
      child.stdin?.end(); if (child.exitCode === null) child.kill(); await exited;
    }
    this.buffer = '';
  }
}
