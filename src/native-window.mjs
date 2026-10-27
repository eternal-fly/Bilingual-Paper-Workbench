import { spawn } from 'node:child_process';
import { access, mkdir, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalWeb } from './local-web.mjs';
import { ensureBackgroundWorkbench, readBackgroundSession, signHostProjectRefresh } from './background-workbench.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function sessionUrl(value) {
  let url; try { url = new URL(value); } catch { fail('WINDOW_SESSION_INVALID', 'The native window session is invalid.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.username || url.password || !/^#session=[A-Za-z0-9_-]{43}$/.test(url.hash)) fail('WINDOW_SESSION_INVALID', 'The native window requires one exact private loopback session.');
  return url.href;
}

/** Start only a visible ordinary window for an existing authenticated service.
 * The capability URL travels through stdin to the fixed helper, never tool output.
 */
export async function openNormalEdgeWindow({ url, dataRoot, browser = null, powershell = process.env.PAPER_EDITOR_POWERSHELL || 'pwsh.exe', spawnAdapter = spawn, helperPath = path.join(ROOT, 'scripts/open-window.ps1') } = {}) {
  const validated = sessionUrl(url);
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) throw new TypeError('The native browser needs an absolute private data root.');
  await access(helperPath);
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', helperPath, '-ReadUrlFromStdin', '-DataRoot', dataRoot];
  if (browser !== null) { if (typeof browser !== 'string' || !path.isAbsolute(browser)) throw new TypeError('Use an absolute browser path.'); args.push('-Browser', browser); }
  return new Promise((resolve, reject) => {
    const child = spawnAdapter(powershell, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', outputBytes = 0, settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); if (error) { if (child.exitCode === null) child.kill(); reject(error); } else resolve(result); };
    const timer = setTimeout(() => finish(Object.assign(new Error('The ordinary window launch timed out.'), { code: 'WINDOW_OPEN_TIMEOUT' })), 40000);
    child.stderr?.on('data', () => {}); // Helper diagnostics never enter model text.
    child.stdout?.on('data', bytes => { outputBytes += bytes.length; if (outputBytes > 8192) return finish(Object.assign(new Error('The window helper returned oversized metadata.'), { code: 'WINDOW_OPEN_FAILED' })); output += bytes.toString('utf8'); });
    child.on('error', () => finish(Object.assign(new Error('The ordinary window helper could not start.'), { code: 'WINDOW_OPEN_FAILED' })));
    child.on('close', code => {
      if (code !== 0) return finish(Object.assign(new Error('The ordinary window helper failed.'), { code: 'WINDOW_OPEN_FAILED' }));
      let placement; try { placement = JSON.parse(output.trim()); } catch { return finish(Object.assign(new Error('The window helper returned invalid placement metadata.'), { code: 'WINDOW_OPEN_FAILED' })); }
      if (placement.requestedState !== 'normal' || ['width', 'height', 'x', 'y'].some(key => !Number.isFinite(placement[key])) || placement.width <= 0 || placement.height <= 0) return finish(Object.assign(new Error('The window helper did not request a bounded ordinary window.'), { code: 'WINDOW_OPEN_FAILED' }));
      finish(null, { width: placement.width, height: placement.height, x: placement.x, y: placement.y, requestedState: 'normal', reusedWindow: placement.reusedWindow === true });
    });
    child.stdin?.on('error', () => finish(Object.assign(new Error('The ordinary window session could not be delivered.'), { code: 'WINDOW_OPEN_FAILED' })));
    child.stdin.end(validated + '\n');
  });
}

/** A native window shares this exact WorkspaceService and its in-memory PDF
 * cache with the invoking chat. It does not create a backend or model worker.
 * Its HTTP lifetime is intentionally the lifetime of the native MCP process.
 */
export class NativeWindowController {
  constructor({ service, dataRoot, instanceId, htmlPath = path.join(ROOT, 'dist/preview.html'), startWeb = startLocalWeb, launchWindow = openNormalEdgeWindow, version = process.env.PAPER_EDITOR_INSTALL_VERSION || '0.6.0' } = {}) {
    if (!service || typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) || typeof instanceId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(instanceId)) throw new TypeError('A native window requires its exact service, private root and instance identity.');
    this.service = service; this.dataRoot = dataRoot; this.instanceId = instanceId; this.htmlPath = htmlPath; this.startWeb = startWeb; this.launchWindow = launchWindow; this.version = version; this.web = null; this.opening = null; this.closed = false;
  }
  open() {
    if (this.closed) return Promise.reject(Object.assign(new Error('The native window host has closed.'), { code: 'WINDOW_HOST_CLOSED' }));
    if (this.opening) return this.opening;
    this.opening = this._open().finally(() => { this.opening = null; }); return this.opening;
  }
  async _open() {
    let reusedService = Boolean(this.web);
    if (!this.web) {
      const web = await this.startWeb({ service: this.service, htmlPath: this.htmlPath, nativeBindingId: this.instanceId });
      try {
        sessionUrl(web.url);
        const directory = path.join(this.dataRoot, 'sessions'); await mkdir(directory, { recursive: true, mode: 0o700 });
        const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) fail('PERMISSION_DENIED', 'The native window session directory is not private storage.');
        const record = { schemaVersion: 1, pid: process.pid, mode: 'native-independent-workbench', version: this.version, url: web.url, createdAt: new Date().toISOString() };
        await writeFile(path.join(directory, `native-${this.instanceId}.json`), JSON.stringify(record), { flag: 'wx', mode: 0o600 }); this.web = web;
      } catch (error) { await web.close(); throw error; }
    }
    if (this.closed) fail('WINDOW_HOST_CLOSED', 'The native window host has closed.');
    const placement = await this.launchWindow({ url: this.web.url, dataRoot: this.dataRoot });
    const safePlacement = placement?.requestedState === 'normal' && ['width', 'height', 'x', 'y'].every(key => Number.isFinite(placement[key])) && placement.width > 0 && placement.height > 0 ? { width: placement.width, height: placement.height, x: placement.x, y: placement.y, requestedState: 'normal' } : null;
    return { opened: true, mode: 'native-window', requestedWindowState: 'normal', sameNativeService: true, reusedService, reusedWindow: placement?.reusedWindow === true, canSendNativeChatMessage: false, ...(safePlacement ? { placement: safePlacement } : {}) };
  }
  async close() {
    if (this.closed) return; this.closed = true;
    try { await this.opening; } catch {}
    if (this.web) { const web = this.web; this.web = null; await web.close(); }
  }
}

/** Private MCP-to-window route. Its token never enters model-visible results. */
export async function dispatchBackgroundRequest({ url, action, payload = {}, timeoutMs = 180000 } = {}) {
  const parsed = new URL(sessionUrl(url));
  if (!['state', 'importFiles', 'callNativeTool', 'syncHostProject', 'openWorkspaceRecord', 'prepareProjectWindowHandoff'].includes(action)) fail('PERMISSION_DENIED', 'This private bridge only supports paper onboarding and model tools.');
  const body = JSON.stringify({ action, payload });
  if (Buffer.byteLength(body) > 1024 * 1024) fail('INPUT_TOO_LARGE', 'The paper bridge request exceeds its bounded input size.');
  const response = await fetch(parsed.origin + '/api', { method: 'POST', signal: AbortSignal.timeout(timeoutMs), headers: { Origin: parsed.origin, Authorization: 'Bearer ' + parsed.hash.slice('#session='.length), 'Content-Type': 'application/json' }, body });
  const reader = response.body.getReader(); let length = 0; const chunks = [];
  try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 40 * 1024 * 1024) { await reader.cancel(); fail('INPUT_TOO_LARGE', 'The paper bridge response exceeds its bounded output size.'); } chunks.push(part.value); } } finally { reader.releaseLock(); }
  let result; try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('BACKGROUND_RESPONSE_INVALID', 'The paper background returned an invalid response.'); }
  if (!response.ok || result?.ok !== true) {
    const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(result?.error?.code || '') ? result.error.code : 'BACKGROUND_REQUEST_FAILED';
    fail(code, typeof result?.error?.message === 'string' ? result.error.message.slice(0, 2000) : 'The paper background request failed.');
  }
  return result;
}

/** The invoking MCP process may stop without taking down this paper window. */
export class BackgroundWindowController {
  constructor({ service, dataRoot, pluginRoot = ROOT, version = process.env.PAPER_EDITOR_INSTALL_VERSION || '1.6.3', instanceId = null, ensure = ensureBackgroundWorkbench, readSession = readBackgroundSession, launchWindow = openNormalEdgeWindow, dispatchRequest = dispatchBackgroundRequest, signProjectRefresh = signHostProjectRefresh }) {
    Object.assign(this, { service, dataRoot, pluginRoot, version, instanceId, ensure, readSession, launchWindow, dispatchRequest, signProjectRefresh }); this.pending = null; this.options = null; this.syncedHostProject = null;
  }
  open({ bootstrapHostProject = true } = {}) { if (this.pending) return this.pending; this.pending = this._open({ bootstrapHostProject }).finally(() => { this.pending = null; }); return this.pending; }
  _options({ bootstrapHostProject = this.options?.hostProject?.autoOpen ?? true } = {}) {
    const state = this.service.getState(), record = state.workspaceIndex?.currentRecord;
    const host = state.workspaceIndex?.hostContext;
    const originThreadId = host?.native === true && host.taskIdAvailable === true && typeof host.hostTaskId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(host.hostTaskId) ? host.hostTaskId : null;
    if (originThreadId) {
      const root = host.projectRoot, source = host.source;
      const hostProject = typeof root === 'string' && path.isAbsolute(root) && root.length <= 4096 && !/[\x00-\x1f]/u.test(root) && ['mcp-roots', 'native-launch-cwd'].includes(source) && host.roots?.some(item => item.root === root) ? { projectRoot: root, source, hostProjectId: host.hostProjectId || null, autoOpen: bootstrapHostProject } : null;
      return { pluginRoot: this.pluginRoot, dataRoot: this.dataRoot, version: this.version, record: null, binding: null, launchId: originThreadId, originThreadId, ...(hostProject ? { hostProject } : {}) };
    }
    if (this.options && !this.options.originThreadId) return this.options;
    if (record && state.project) {
      const binding = state.nativeChatBinding;
      return { pluginRoot: this.pluginRoot, dataRoot: this.dataRoot, version: this.version, record: { projectRoot: record.projectRoot, mainFile: record.mainFile, recordId: record.recordId }, binding: binding?.projectId === state.project.id ? { threadId: binding.threadId, model: binding.model, effort: binding.effort } : null, ...(originThreadId ? { originThreadId } : {}) };
    }
    const launchId = state.workspaceIndex?.hostContext?.hostTaskId || this.instanceId;
    if (typeof launchId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(launchId)) fail('BACKGROUND_CONFIG_INVALID', 'An empty workbench requires its exact invoking task identity.');
    return { pluginRoot: this.pluginRoot, dataRoot: this.dataRoot, version: this.version, record: null, binding: null, launchId, ...(originThreadId ? { originThreadId } : {}) };
  }
  async _ready(input) {
    const options = this._options(input), ready = await this.ensure(options); this.options = options; const session = await this.readSession(options); sessionUrl(session.url);
    const identity = options.hostProject ? JSON.stringify(options.hostProject) : null;
    if (identity && (input?.refreshHostProject || identity !== this.syncedHostProject)) { const proof = await this.signProjectRefresh(options, session); await this.dispatchRequest({ url: session.url, action: 'syncHostProject', payload: proof }); this.syncedHostProject = identity; }
    return { options, ready, session };
  }
  async _open(input) {
    const { options, ready, session } = await this._ready({ ...input, refreshHostProject: true }), placement = await this.launchWindow({ url: session.url, dataRoot: this.dataRoot });
    const safePlacement = placement?.requestedState === 'normal' && ['width', 'height', 'x', 'y'].every(key => Number.isFinite(placement[key])) && placement.width > 0 && placement.height > 0 ? { width: placement.width, height: placement.height, x: placement.x, y: placement.y, requestedState: 'normal' } : null;
    return { opened: true, mode: 'background-workbench', sameNativeService: false, reusedService: ready.reused, reusedWindow: placement?.reusedWindow === true, requestedWindowState: 'normal', desktopWindowRequired: false, nativeCardRequired: false, ...(options.record === null ? { projectRequired: true } : {}), ...(safePlacement ? { placement: safePlacement } : {}) };
  }
  async dispatch(action, payload = {}) {
    if (!['state', 'importFiles', 'callNativeTool'].includes(action)) fail('PERMISSION_DENIED', 'This private bridge only supports paper onboarding and model tools.');
    const { session, options } = await this._ready();
    return this.dispatchRequest({ url: session.url, action, payload: action === 'callNativeTool' && options.originThreadId ? { ...payload, originThreadId: options.originThreadId } : payload });
  }
  async close() {} // Background lifetime belongs to the paper window, not MCP.
}
