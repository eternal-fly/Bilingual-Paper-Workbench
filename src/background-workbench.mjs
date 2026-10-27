import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, realpath, rename, unlink, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MODE = 'background-workbench', pending = new Map();
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const digest = value => createHash('sha256').update(value).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
function privateUrl(value) {
  let url; try { url = new URL(value); } catch { fail('BACKGROUND_SESSION_INVALID', 'The private background session is invalid.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.username || url.password || !/^#session=[A-Za-z0-9_-]{43}$/u.test(url.hash)) fail('BACKGROUND_SESSION_INVALID', 'The private background session is invalid.');
  return url;
}
async function boundedJson(filename, maximum = 16384) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) fail('BACKGROUND_HANDOFF_INVALID', 'The private launch record is not a bounded regular file.');
  return JSON.parse(await readFile(filename, 'utf8'));
}
async function installedBytes(filename,maximum,{optional=false}={}){
  let before;try{before=await lstat(filename);}catch(error){if(optional&&error.code==='ENOENT')return null;fail('BACKGROUND_CONFIG_INVALID','The installed runtime build is unavailable.');}
  const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
  if(!before.isFile()||before.isSymbolicLink()||before.size>maximum||!samePath(await realpath(filename),filename))fail('BACKGROUND_CONFIG_INVALID','The installed runtime build must be a bounded regular file.');
  let handle;try{
    handle=await open(filename,'r');if(!same(before,await handle.stat()))fail('BACKGROUND_CONFIG_INVALID','The installed runtime build changed while it was opened.');
    const chunks=[];let size=0;for(;;){const buffer=Buffer.allocUnsafe(Math.min(256*1024,maximum+1-size)),part=await handle.read(buffer,0,buffer.length,null);if(!part.bytesRead)break;size+=part.bytesRead;if(size>maximum)fail('BACKGROUND_CONFIG_INVALID','The installed runtime build exceeds its byte budget.');chunks.push(buffer.subarray(0,part.bytesRead));}
    const after=await handle.stat(),named=await lstat(filename);if(size!==before.size||!same(before,after)||!same(before,named)||!named.isFile()||named.isSymbolicLink()||!samePath(await realpath(filename),filename))fail('BACKGROUND_CONFIG_INVALID','The installed runtime build changed during identity verification.');
    return Buffer.concat(chunks,size);
  }catch(error){if(error.code==='BACKGROUND_CONFIG_INVALID')throw error;fail('BACKGROUND_CONFIG_INVALID','The installed runtime build could not be verified.');}finally{await handle?.close();}
}
async function installedBuildFingerprint(entry,pluginRoot,version){
  const bytes=await installedBytes(entry,16*1024*1024),entryHash=digest(bytes),manifestBytes=await installedBytes(path.join(pluginRoot,'dist/build-manifest.json'),256*1024,{optional:true});
  if(!manifestBytes)return digest(JSON.stringify({entryHash}));
  let manifest;try{manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifestBytes));}catch{fail('BACKGROUND_CONFIG_INVALID','The installed build manifest is unreadable.');}
  const expected=manifest?.files?.['background-workbench.mjs'];if(manifest?.schemaVersion!==1||manifest.version!==version||expected?.size!==bytes.length||expected?.sha256!==entryHash)fail('BACKGROUND_CONFIG_INVALID','The installed background entry does not match its exact versioned build manifest.');
  return digest(JSON.stringify({entryHash,manifestHash:digest(manifestBytes)}));
}
async function directory(root, name) {
  const result = path.join(root, name);
  try { await mkdir(result, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(result);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(result), result)) fail('BACKGROUND_HANDOFF_INVALID', 'Private background records cannot traverse a link.');
  return result;
}
async function atomicJson(filename, value) {
  const temporary = `${filename}.${randomBytes(12).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    // Windows may briefly deny replacement while an authenticated launcher is
    // reading this exact private record. Preserve the old file and retry rename.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, filename); break; }
      catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 10) throw error; await delay(Math.min(10 * (attempt + 1), 50)); }
    }
  }
  finally { await unlink(temporary).catch(() => {}); }
}
async function loadProfile({ pluginRoot, dataRoot, record, binding = null, launchId = null, originThreadId = null, hostProject = null, viewerOnly = false, version, configFile = path.join(pluginRoot || '', 'mcp.json') }) {
  const onboarding = record === null;
  if (typeof viewerOnly !== 'boolean' || viewerOnly && (onboarding || originThreadId !== null || binding !== null)) fail('BACKGROUND_CONFIG_INVALID', 'A signed viewer profile cannot own a model chat or first-use task.');
  if (originThreadId !== null && (!validId(originThreadId) || onboarding && originThreadId !== launchId)) fail('BACKGROUND_CONFIG_INVALID', 'The invoking chat must match its trusted launch identity.');
  if (!path.isAbsolute(pluginRoot || '') || !path.isAbsolute(dataRoot || '') || !validId(version) || (onboarding ? !validId(launchId) || binding !== null : !record || !path.isAbsolute(record.projectRoot || '') || typeof record.mainFile !== 'string' || !/\.tex$/iu.test(record.mainFile) || path.isAbsolute(record.mainFile) || record.mainFile.replaceAll('\\', '/').split('/').some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f<>"|?*]/u.test(part)) || record.recordId !== undefined && !validId(record.recordId))) fail('BACKGROUND_CONFIG_INVALID', 'Choose an exact installed plugin and paper record or first-use task identity.');
  if (binding !== null && (!binding || Object.keys(binding).some(key => !['threadId', 'model', 'effort'].includes(key)) || !validId(binding.threadId) || !validId(binding.model) || binding.effort !== undefined && binding.effort !== null && !validId(binding.effort))) fail('BACKGROUND_CONFIG_INVALID', 'The existing paper chat identity is invalid.');
  if (hostProject !== null) {
    if (!onboarding || !originThreadId || !hostProject || Object.keys(hostProject).some(key => !['projectRoot', 'source', 'hostProjectId', 'autoOpen'].includes(key)) || typeof hostProject.projectRoot !== 'string' || !path.isAbsolute(hostProject.projectRoot) || hostProject.projectRoot.length > 4096 || /[\x00-\x1f]/u.test(hostProject.projectRoot) || !['mcp-roots', 'native-launch-cwd'].includes(hostProject.source) || hostProject.hostProjectId !== null && !validId(hostProject.hostProjectId) || typeof hostProject.autoOpen !== 'boolean') fail('BACKGROUND_CONFIG_INVALID', 'Only a signed native task can supply its current transport-derived project.');
    const info = await lstat(hostProject.projectRoot).catch(() => null); if (!info?.isDirectory() || info.isSymbolicLink()) fail('BACKGROUND_CONFIG_INVALID', 'The invoking project root is unavailable or redirected.');
    hostProject = { ...hostProject, projectRoot: await realpath(hostProject.projectRoot) };
  }
  try { pluginRoot = await realpath(pluginRoot); dataRoot = await realpath(dataRoot); }
  catch { fail('BACKGROUND_CONFIG_INVALID', 'The installed plugin or private data root is unavailable.'); }
  if (!samePath(path.resolve(configFile), path.join(pluginRoot, 'mcp.json'))) fail('BACKGROUND_CONFIG_INVALID', 'Only this installed plugin profile may launch its background process.');
  const config = (await boundedJson(configFile, 65536)).mcpServers?.['bilingual-paper-editor'];
  const env = config?.env;
  if (!config || !path.isAbsolute(config.command || '') || !env || !samePath(await realpath(env.PAPER_EDITOR_DATA_ROOT || '').catch(() => ''), dataRoot) || env.PAPER_EDITOR_INSTALL_VERSION !== version) fail('BACKGROUND_CONFIG_INVALID', 'The installed background profile does not match its private data root and version.');
  const command = await realpath(config.command).catch(() => null), entry = path.join(pluginRoot, 'dist/background-workbench.mjs');
  for (const filename of [command, entry]) { const info = filename && await lstat(filename).catch(() => null); if (!info?.isFile() || info.isSymbolicLink()) fail('BACKGROUND_CONFIG_INVALID', 'The installed background runtime is unavailable.'); }
  const buildFingerprint=await installedBuildFingerprint(entry,pluginRoot,version);
  let projectRoot = null;
  if (!onboarding) {
    projectRoot = await realpath(record.projectRoot); const projectInfo = await lstat(projectRoot);
    if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink()) fail('BACKGROUND_CONFIG_INVALID', 'Choose an actual project directory.');
    record = { projectRoot, mainFile: record.mainFile.replaceAll('\\', '/'), ...(record.recordId ? { recordId: record.recordId } : {}) };
  }
  const configuredEnv = Object.fromEntries(Object.entries(env).filter(([key, value]) => /^PAPER_EDITOR_[A-Z0-9_]+$/u.test(key) && typeof value === 'string').sort(([a], [b]) => a.localeCompare(b)));
  const configHash = digest(JSON.stringify({ command, env: configuredEnv }));
  // Desktop and cached plugin copies share the same user-private installation.
  // Their exact task must reach one daemon even when the executable path differs.
  const key = digest(JSON.stringify({ dataRoot: dataRoot.toLowerCase(), record: onboarding ? { launchId } : { ...record, projectRoot: projectRoot.toLowerCase(), mainFile: record.mainFile.toLowerCase() }, ...(originThreadId ? { originThreadId } : {}), ...(viewerOnly ? { viewerOnly: true } : {}), version,buildFingerprint })).slice(0, 32);
  const controlRoot = await directory(dataRoot, 'background'), handoffRoot = await directory(controlRoot, 'handoffs');
  return { pluginRoot, dataRoot, record, binding, launchId: onboarding ? launchId : null, originThreadId, hostProject, viewerOnly, version, configFile, command, entry, env: configuredEnv, configHash, key, controlRoot, handoffRoot, sessionFile: path.join(controlRoot, `${key}.json`), lockFile: path.join(controlRoot, `${key}.lock`) };
}
async function secretFor(profile) {
  const filename = path.join(profile.controlRoot, 'handoff.key');
  try { await writeFile(filename, randomBytes(32), { mode: 0o600, flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink() || info.size !== 32) fail('BACKGROUND_HANDOFF_INVALID', 'The private handoff authority needs recovery.');
  return readFile(filename);
}

/** Private opener proof; neither the capability nor signing key is returned to a model. */
export async function signHostProjectRefresh(options, session) {
  const profile = await loadProfile(options);
  if (!profile.hostProject || !profile.originThreadId || session?.key !== profile.key || !/^[a-f0-9]{48}$/u.test(session.owner || '')) fail('BACKGROUND_HANDOFF_INVALID', 'The current project must target this exact signed task owner.');
  const payload = { schemaVersion: 1, purpose: 'sync-origin-project', key: profile.key, owner: session.owner, originThreadId: profile.originThreadId, dataRoot: profile.dataRoot, version: profile.version, hostProject: profile.hostProject, issuedAt: Date.now(), nonce: randomBytes(24).toString('hex') };
  return { payload, signature: createHmac('sha256', await secretFor(profile)).update(JSON.stringify(payload)).digest('hex') };
}
export async function signProjectWindowHandoff(options, session, { sourceSession, recordId, snapshotId, handoffId = null }) {
  const profile = await loadProfile(options);
  if (!profile.originThreadId || session?.key !== profile.key || !/^[a-f0-9]{48}$/u.test(session.owner || '') || !/^workspace-[a-f0-9]{32}$/u.test(recordId || '') || !validId(snapshotId) || !/^[a-f0-9]{32}$/u.test(sourceSession?.key || '') || !/^[a-f0-9]{48}$/u.test(sourceSession?.owner || '') || handoffId !== null && !/^[a-f0-9]{48}$/u.test(handoffId)) fail('BACKGROUND_HANDOFF_INVALID', 'The selected window handoff lacks its exact source and target owners.');
  privateUrl(sourceSession.url);
  const payload = { schemaVersion: 1, purpose: 'project-window-handoff', key: profile.key, owner: session.owner, originThreadId: profile.originThreadId, dataRoot: profile.dataRoot, version: profile.version, recordId, snapshotId, source: { url: sourceSession.url, key: sourceSession.key, owner: sourceSession.owner }, issuedAt: Date.now(), nonce: handoffId || randomBytes(24).toString('hex') };
  return { payload, signature: createHmac('sha256', await secretFor(profile)).update(JSON.stringify(payload)).digest('hex') };
}
function validSession(session, profile) {
  if (Boolean(session?.viewerOnly) !== profile.viewerOnly || session?.viewerOnly !== undefined && session.viewerOnly !== true) fail('BACKGROUND_SESSION_INVALID', 'The saved paper session has a different model-execution boundary.');
  const exactPaper = profile.record ? samePath(session?.projectRoot || '', profile.record.projectRoot) && session.mainFile === profile.record.mainFile && (session.recordId || null) === (profile.record.recordId || null) && !session.launchId : session?.projectRoot === null && session.mainFile === null && session.recordId === null && session.launchId === profile.launchId;
  if ((session?.originThreadId || null) !== profile.originThreadId || session?.schemaVersion !== 1 || session.mode !== MODE || session.key !== profile.key || session.version !== profile.version || !Number.isSafeInteger(session.pid) || session.pid < 1 || !/^[a-f0-9]{48}$/u.test(session.owner || '') || !exactPaper || (session.threadId || null) !== (profile.binding?.threadId || null)) fail('BACKGROUND_SESSION_INVALID', 'The background session belongs to another paper, task, version or chat.');
  privateUrl(session.url); return session;
}
export async function probeBackgroundSession(session, profile, { timeoutMs = 3000 } = {}) {
  const url = privateUrl(session.url), response = await fetch(url.origin + '/api', { method: 'POST', signal: AbortSignal.timeout(timeoutMs), headers: { Origin: url.origin, Authorization: 'Bearer ' + url.hash.slice('#session='.length), 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'state' }) });
  if (!response.ok || Number(response.headers.get('content-length') || 0) > 40 * 1024 * 1024) return false;
  const reader = response.body.getReader(); let length = 0, chunks = [];
  try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 40 * 1024 * 1024) { await reader.cancel(); return false; } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8')), state = result.result || result.state, lifecycle = state?.backgroundLifecycle, record = state?.workspaceIndex?.currentRecord;
  const exactPaper = profile.record ? state.project?.mainFile === profile.record.mainFile && samePath(record?.projectRoot || '', profile.record.projectRoot) && (!profile.record.recordId || record?.recordId === profile.record.recordId) : lifecycle?.launchId === profile.launchId;
  return Boolean(result.ok && Boolean(lifecycle?.viewerOnly) === profile.viewerOnly && lifecycle?.key === profile.key && lifecycle.owner === session.owner && lifecycle.pid === session.pid && lifecycle.version === profile.version && (lifecycle.originThreadId || null) === profile.originThreadId && exactPaper && (lifecycle.threadId || null) === (profile.binding?.threadId || null));
}
async function trustedSession(profile, { probeAdapter = probeBackgroundSession, isAlive = alive } = {}) {
  const session = validSession(await boundedJson(profile.sessionFile), profile);
  if (!isAlive(session.pid)) fail('BACKGROUND_STALE', 'The previous paper background process has stopped.');
  if (!await probeAdapter(session, profile).catch(() => false)) fail('BACKGROUND_OWNER_UNAVAILABLE', 'The existing paper process is still running but did not confirm its identity. Retry after it responds.');
  return session;
}
/** Capability-bearing return value is for the trusted window opener only. */
export async function readBackgroundSession(options) {
  const profile = await loadProfile(options);
  if (options.sessionFile && !samePath(path.resolve(options.sessionFile), profile.sessionFile)) fail('BACKGROUND_SESSION_INVALID', 'The requested private session is outside this paper profile.');
  return trustedSession(profile, options);
}
function publicSession(session, profile, reused) {
  return { pid: session.pid, mode: MODE, version: session.version, reused, sessionFile: profile.sessionFile, desktopWindowRequired: false, nativeCardRequired: false };
}
export async function ensureBackgroundWorkbench(options) {
  const profile = await loadProfile(options);
  if (pending.has(profile.sessionFile)) return pending.get(profile.sessionFile);
  const task = ensureReady(profile, options); pending.set(profile.sessionFile, task);
  try { return await task; } finally { if (pending.get(profile.sessionFile) === task) pending.delete(profile.sessionFile); }
}
async function ensureReady(profile, { spawnAdapter = spawn, probeAdapter = probeBackgroundSession, isAlive = alive, timeoutMs = 60000, pollMs = 100 } = {}) {
  try { return publicSession(await trustedSession(profile, { probeAdapter, isAlive }), profile, true); }
  catch (error) { if (!['ENOENT', 'BACKGROUND_STALE'].includes(error.code)) throw error; }
  const lockOwner = randomBytes(24).toString('hex'), deadline = Date.now() + Math.max(10, Math.min(timeoutMs, 60000));
  let locked = false;
  while (!locked && Date.now() < deadline) {
    try { await writeFile(profile.lockFile, JSON.stringify({ pid: process.pid, owner: lockOwner }), { flag: 'wx', mode: 0o600 }); locked = true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const lock = await boundedJson(profile.lockFile);
      if (!Number.isSafeInteger(lock.pid) || !/^[a-f0-9]{48}$/u.test(lock.owner || '')) fail('BACKGROUND_HANDOFF_INVALID', 'The paper launch lock needs recovery.');
      if (!isAlive(lock.pid)) { const current = await boundedJson(profile.lockFile); if (current.pid === lock.pid && current.owner === lock.owner) await unlink(profile.lockFile); }
      else { try { return publicSession(await trustedSession(profile, { probeAdapter, isAlive }), profile, true); } catch (cause) { if (!['ENOENT', 'BACKGROUND_STALE'].includes(cause.code)) throw cause; } await delay(pollMs); }
    }
  }
  if (!locked) fail('BACKGROUND_NOT_READY', 'The paper background launch is still pending.');
  try {
    // A competing launcher may have finished before this lock was acquired.
    try { return publicSession(await trustedSession(profile, { probeAdapter, isAlive }), profile, true); } catch (error) { if (!['ENOENT', 'BACKGROUND_STALE'].includes(error.code)) throw error; }
    const owner = randomBytes(24).toString('hex'), payload = { schemaVersion: 1, issuedAt: Date.now(), owner, pluginRoot: profile.pluginRoot, dataRoot: profile.dataRoot, record: profile.record, binding: profile.binding, ...(profile.launchId ? { launchId: profile.launchId } : {}), ...(profile.originThreadId ? { originThreadId: profile.originThreadId } : {}), ...(profile.hostProject ? { hostProject: profile.hostProject } : {}), ...(profile.viewerOnly ? { viewerOnly: true } : {}), version: profile.version, configHash: profile.configHash, key: profile.key };
    const signature = createHmac('sha256', await secretFor(profile)).update(JSON.stringify(payload)).digest('hex'), descriptorFile = path.join(profile.handoffRoot, `${profile.key}-${owner}.json`);
    await writeFile(descriptorFile, JSON.stringify({ payload, signature }), { flag: 'wx', mode: 0o600 });
    const child = spawnAdapter(profile.command, [profile.entry, '--handoff', descriptorFile], { cwd: profile.pluginRoot, env: { ...process.env, ...profile.env, PAPER_EDITOR_FULL_RUNTIME: '1' }, detached: true, windowsHide: true, stdio: 'ignore' });
    let spawnError = false; child.once?.('error', () => { spawnError = true; }); child.unref?.();
    if (!Number.isSafeInteger(child.pid)) fail('BACKGROUND_START_FAILED', 'The paper background process could not start.');
    while (Date.now() < deadline) {
      if (spawnError || !isAlive(child.pid)) fail('BACKGROUND_START_FAILED', 'The paper background process stopped before becoming ready.');
      try {
        const session = validSession(await boundedJson(profile.sessionFile), profile);
        if (!isAlive(session.pid)) fail('BACKGROUND_STALE', 'The previous paper background process has stopped.');
        if (session.pid !== child.pid || session.owner !== owner) fail('BACKGROUND_SESSION_INVALID', 'A different background process answered this launch.');
        if (await probeAdapter(session, profile).catch(() => false)) return publicSession(session, profile, false);
      }
      catch (error) { if (!['ENOENT', 'BACKGROUND_STALE'].includes(error.code)) throw error; }
      await delay(pollMs);
    }
    fail('BACKGROUND_NOT_READY', 'The paper background process did not become ready within the launch timeout.');
  } finally { const current = await boundedJson(profile.lockFile).catch(() => null); if (current?.pid === process.pid && current.owner === lockOwner) await unlink(profile.lockFile).catch(() => {}); }
}

async function restoreSignedOriginWorkspace(service, profile) {
  if (profile.record !== null || !profile.originThreadId || profile.originThreadId !== profile.launchId || typeof service.listWorkspaces !== 'function') return;
  // The existing index API returns at most 100 recent, validated headers. Never
  // discover source files, inherit installer paths, or match a worker chat ID.
  const inventory = await service.listWorkspaces();
  if (!Array.isArray(inventory?.records) || inventory.records.length > 100) fail('BACKGROUND_HOST_RESTORE_INVALID', 'The bounded saved-workspace inventory could not be verified.');
  const preference = inventory.chatSelection?.threadId === profile.originThreadId && (!profile.hostProject || samePath(inventory.chatSelection.hostProjectRoot || '', profile.hostProject.projectRoot)) ? inventory.chatSelection : null;
  const preferred = preference ? inventory.records.find(record => record.recordId === preference.recordId && record.threadId === profile.originThreadId) : null;
  if (preference && !preferred) fail('BACKGROUND_HOST_RESTORE_INVALID', 'The explicitly selected paper/chat record is outside the current bounded index or its binding changed.');
  const candidates = inventory.records.filter(record => record?.hostTaskId === profile.originThreadId && (!profile.hostProject || !record.hostProjectRoot || samePath(record.hostProjectRoot, profile.hostProject.projectRoot)) || preferred && record.recordId === preferred.recordId), seen = new Set();
  for (const record of candidates) {
    if (!/^workspace-[a-f0-9]{32}$/u.test(record.recordId || '') || seen.has(record.recordId) || typeof record.projectRoot !== 'string' || !path.isAbsolute(record.projectRoot) || record.projectRoot.length > 4096 || /[\x00-\x1f]/u.test(record.projectRoot) || typeof record.mainFile !== 'string' || record.mainFile.length > 1024 || !/\.tex$/iu.test(record.mainFile) || path.isAbsolute(record.mainFile) || record.mainFile.replaceAll('\\', '/').split('/').some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f<>"|?*]/u.test(part)) || typeof record.lastOpenedAt !== 'string' || !Number.isFinite(Date.parse(record.lastOpenedAt))) fail('BACKGROUND_HOST_RESTORE_INVALID', 'The saved originating-task workspace identity needs recovery.');
    seen.add(record.recordId);
  }
  const selected = candidates.sort((a, b) => Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt) || b.recordId.localeCompare(a.recordId))[0];
  if (!selected) return false;
  const current = service.getState();
  if (current.project?.mainFile === selected.mainFile && current.workspaceIndex?.currentRecord?.recordId === selected.recordId && (current.workspaceIndex.currentRecord.hostTaskId === profile.originThreadId || preferred && current.workspaceIndex.currentRecord.threadId === profile.originThreadId) && samePath(current.workspaceIndex.currentRecord.projectRoot || '', selected.projectRoot)) return true;
  if (typeof service.openWorkspaceRecord !== 'function') fail('BACKGROUND_HOST_RESTORE_UNAVAILABLE', 'The installed runtime cannot reopen the exact saved workspace record.');
  try { await service.openWorkspaceRecord({ recordId: selected.recordId }); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'WORKSPACE_RECORD_NOT_FOUND'].includes(error.code)) throw error;
    const state = service.getState();
    if (state.project || state.workspaceIndex?.currentRecord) fail('BACKGROUND_PROJECT_MISMATCH', 'The unavailable saved paper left an unexpected active workspace.');
    service.bootstrap = { ...(service.bootstrap || {}), status: 'workspace-required', mainCandidates: [], diagnostic: { code: 'HOST_WORKSPACE_RESTORE_UNAVAILABLE', causeCode: error.code, recordId: selected.recordId, message: 'The saved paper files or record are missing. Its history was preserved; restore the files or select a paper explicitly.' } };
    service.emit?.('change'); return false;
  }
  const state = service.getState(), opened = state.workspaceIndex?.currentRecord;
  if (opened?.recordId !== selected.recordId || !(opened.hostTaskId === profile.originThreadId || preferred && opened.threadId === profile.originThreadId) || state.project?.mainFile !== selected.mainFile || !samePath(opened.projectRoot || '', selected.projectRoot)) fail('BACKGROUND_PROJECT_MISMATCH', 'The restored workspace did not confirm the exact saved originating-task record.');
  return true;
}

async function awaitRestoredOrigin(service, profile, timeoutMs) {
  if (!service.originChat?.reconcile) return;
  const deadline = Date.now() + timeoutMs; let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); timer.unref?.(); });
  const verification = (async () => {
    for (;;) {
      const state = await service.originChat.reconcile();
      if (state?.threadId !== undefined && state.threadId !== profile.originThreadId) fail('THREAD_MISMATCH', 'The restored paper reported a different originating chat.');
      if (state?.phase === 'failed' && ['THREAD_MISMATCH', 'NATIVE_CHAT_MISMATCH', 'PERMISSION_DENIED', 'REGISTRY_RECOVERY_REQUIRED', 'ORIGIN_BINDING_CHANGED', 'BACKGROUND_HANDOFF_INVALID'].includes(state.error?.code)) fail(state.error.code, 'The restored Desktop chat identity could not be verified.');
      if (!['pending-paper', 'verifying', 'waiting-paper-operation'].includes(state?.phase)) return state;
      if (Date.now() >= deadline) return null; await delay(Math.min(100, deadline - Date.now()));
    }
  })();
  try {
    const result = await Promise.race([verification, timeout]);
    if (!result || !['desktop-ready', 'connected'].includes(result.phase)) service.bootstrap = { ...(service.bootstrap || {}), diagnostic: { code: 'ORIGIN_CHAT_NOT_READY', ...(result?.error?.code ? { causeCode: result.error.code } : {}), message: 'The saved paper is open. Its originating Desktop chat is still unavailable or awaiting verification; model requests remain disabled.' } };
  } finally { clearTimeout(timer); }
}

/** Entry for the fixed installed Node bundle; never writes URL/token to stdio. */
export async function runBackgroundWorkbench({ descriptorFile, pluginRoot = PACKAGE_ROOT, createService, startWeb, registerSignals = true, originReadyTimeoutMs = 5000, transferProjectWindow = null } = {}) {
  if (!Number.isInteger(originReadyTimeoutMs) || originReadyTimeoutMs < 1 || originReadyTimeoutMs > 15000) throw new TypeError('Use a bounded originating-chat startup wait.');
  if (!path.isAbsolute(descriptorFile || '')) fail('BACKGROUND_HANDOFF_INVALID', 'Use the private signed launch descriptor.');
  const envelope = await boundedJson(descriptorFile), payload = envelope?.payload;
  if (!payload || payload.schemaVersion !== 1 || typeof envelope.signature !== 'string' || !/^[a-f0-9]{64}$/u.test(envelope.signature) || !Number.isFinite(payload.issuedAt) || Date.now() - payload.issuedAt > 60000 || payload.issuedAt - Date.now() > 5000 || !/^[a-f0-9]{48}$/u.test(payload.owner || '') || !samePath(path.resolve(pluginRoot), payload.pluginRoot || '')) fail('BACKGROUND_HANDOFF_INVALID', 'The paper launch descriptor expired or has an invalid identity.');
  const profile = await loadProfile(payload);
  if (path.dirname(descriptorFile) !== profile.handoffRoot || path.basename(descriptorFile) !== `${profile.key}-${payload.owner}.json` || profile.key !== payload.key || profile.configHash !== payload.configHash) fail('BACKGROUND_HANDOFF_INVALID', 'The installed paper launch profile changed.');
  const expected = createHmac('sha256', await secretFor(profile)).update(JSON.stringify(payload)).digest(), supplied = Buffer.from(envelope.signature, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) fail('BACKGROUND_HANDOFF_INVALID', 'The private paper handoff signature is invalid.');
  // Claim once before opening any paper, model transport or listening socket.
  const claimed = `${descriptorFile}.claimed`; await rename(descriptorFile, claimed);
  let service, web, session, closing = false; const signalHandlers = [];
  const close = async () => {
    if (closing) return; closing = true;
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    try { await service?.close?.(); } finally { await web?.close?.(); }
    const current = await boundedJson(profile.sessionFile).catch(() => null);
    if (current?.owner === payload.owner && current.pid === process.pid) await unlink(profile.sessionFile).catch(() => {});
  };
  try {
    const factory = createService || (await import('./runtime.mjs')).createApplication;
    const env = profile.env;
    // First use never inherits the installer's paper. A signed originating task
    // may reopen only its exact known record from the bounded private index.
    const hostEnv = { ...env };
    if (profile.record) { hostEnv.PAPER_EDITOR_WORKSPACE = profile.record.projectRoot; hostEnv.PAPER_EDITOR_MAIN_FILE = profile.record.mainFile; }
    else { delete hostEnv.PAPER_EDITOR_WORKSPACE; delete hostEnv.PAPER_EDITOR_MAIN_FILE; }
    service = await factory({ dataRoot: profile.dataRoot, codexRoot: env.PAPER_EDITOR_CODEX_ROOT, compilerRoot: env.PAPER_EDITOR_COMPILER_ROOT, command: env.PAPER_EDITOR_CODEX_COMMAND, preferredModel: env.PAPER_EDITOR_PREFERRED_MODEL, preferredEffort: env.PAPER_EDITOR_PREFERRED_EFFORT, engine: env.PAPER_EDITOR_ENGINE, native: false, workspace: profile.record?.projectRoot || null, mainFile: profile.record?.mainFile || null, cwd: profile.record?.projectRoot || profile.pluginRoot, hostEnv, backgroundMode: true, backgroundBinding: profile.binding, backgroundRecordId: profile.record?.recordId || null, backgroundOriginThreadId: profile.originThreadId, desktopViewerOnly: profile.viewerOnly });
    // Only this signed launch descriptor supplies the first-use task identity.
    // Separate chat daemons must never collapse into unidentified-host records.
    if (profile.launchId && service.hostContext) service.hostContext = { ...service.hostContext, native: false, hostTaskId: profile.launchId, taskIdAvailable: Boolean(profile.originThreadId), source: 'signed-background-task', ...(profile.hostProject ? { projectRoot: profile.hostProject.projectRoot, roots: [{ root: profile.hostProject.projectRoot, name: path.basename(profile.hostProject.projectRoot) }], source: profile.hostProject.source, hostProjectId: profile.hostProject.hostProjectId } : {}) };
    if (profile.record) {
      if (profile.record.recordId) await service.openWorkspaceRecord({ recordId: profile.record.recordId });
      else await service.openProject({ root: profile.record.projectRoot, mainFile: profile.record.mainFile });
      if (profile.binding && typeof service.prepareBackgroundBinding !== 'function') fail('BACKGROUND_BINDING_UNAVAILABLE', 'The installed runtime cannot preserve this exact existing paper chat.');
      if (profile.binding && !profile.originThreadId) {
        try { await service.prepareBackgroundBinding(profile.binding); }
        catch (error) {
          // Chat availability must not hide an otherwise valid paper window.
          // Identity/security failures still abort; unavailable leases are left
          // untouched for an explicit recovery/connection action in the UI.
          if (['THREAD_MISMATCH', 'NATIVE_CHAT_MISMATCH', 'INVALID_INPUT', 'VERSION_CONFLICT', 'PERMISSION_DENIED', 'BACKGROUND_BINDING_UNAVAILABLE', 'BACKGROUND_HANDOFF_INVALID', 'BACKGROUND_CONFIG_INVALID'].includes(error.code)) throw error;
          const diagnostic = { code: /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.code || '') ? error.code : 'CHAT_CONNECTION_UNAVAILABLE', message: String(error.message || 'The saved paper chat is unavailable. Reconnect it explicitly from the workbench.').slice(0, 2000) };
          const app = service.active || service;
          app._nativeBindingError = diagnostic;
          if (app.backgroundConnection) { app.backgroundConnection.phase = 'failed'; app.backgroundConnection.error = diagnostic; }
        }
      }
      const state = service.getState(), record = state.workspaceIndex?.currentRecord;
      if (state.project?.mainFile !== profile.record.mainFile || !samePath(record?.projectRoot || '', profile.record.projectRoot) || profile.record.recordId && record?.recordId !== profile.record.recordId) fail('BACKGROUND_PROJECT_MISMATCH', 'The background process did not open the exact selected paper.');
    } else {
      if (service.getState().project || service.getState().workspaceIndex?.currentRecord) fail('BACKGROUND_PROJECT_MISMATCH', 'A first-use task must start without an inherited paper.');
      const restored = await restoreSignedOriginWorkspace(service, profile);
      if (!restored && profile.hostProject?.autoOpen && !service.bootstrap?.diagnostic && typeof service.bootstrapHostProject === 'function') await service.bootstrapHostProject();
      if (restored || service.getState().project) await awaitRestoredOrigin(service, profile, originReadyTimeoutMs);
    }
    service.startWatching?.();
    const lifecycle = { key: profile.key, owner: payload.owner, pid: process.pid, version: profile.version, threadId: profile.binding?.threadId || null, ...(profile.launchId ? { launchId: profile.launchId } : {}), ...(profile.originThreadId ? { originThreadId: profile.originThreadId } : {}), ...(profile.viewerOnly ? { viewerOnly: true } : {}) };
    const facade = new Proxy(service, { get(target, key) { if (key === 'getState') return () => { const state = target.getState(); return { ...state, capabilities: { ...state.capabilities, projectSwitch: Boolean(profile.originThreadId) }, backgroundLifecycle: lifecycle }; }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
    let syncing = false, activeHostProject = profile.hostProject; const usedProofs = new Map();
    const syncHostProject = async envelope => {
      const body = envelope?.payload;
      if (!envelope || Object.keys(envelope).some(key => !['payload', 'signature'].includes(key)) || !body || Object.keys(body).some(key => !['schemaVersion', 'purpose', 'key', 'owner', 'originThreadId', 'dataRoot', 'version', 'hostProject', 'issuedAt', 'nonce'].includes(key)) || body.schemaVersion !== 1 || body.purpose !== 'sync-origin-project' || body.key !== profile.key || body.owner !== payload.owner || body.originThreadId !== profile.originThreadId || !profile.originThreadId || body.dataRoot !== profile.dataRoot || body.version !== profile.version || !body.hostProject || !Number.isFinite(body.issuedAt) || Date.now() - body.issuedAt > 60000 || body.issuedAt - Date.now() > 5000 || !/^[a-f0-9]{48}$/u.test(body.nonce || '') || !/^[a-f0-9]{64}$/u.test(envelope.signature || '')) fail('BACKGROUND_HANDOFF_INVALID', 'The project refresh proof is invalid, stale or belongs to another task owner.');
      const expected = createHmac('sha256', await secretFor(profile)).update(JSON.stringify(body)).digest(), supplied = Buffer.from(envelope.signature, 'hex');
      if (!timingSafeEqual(expected, supplied)) fail('BACKGROUND_HANDOFF_INVALID', 'The private project refresh signature is invalid.');
      for (const [nonce, time] of usedProofs) if (Date.now() - time > 60000) usedProofs.delete(nonce);
      if (usedProofs.has(body.nonce)) fail('BACKGROUND_HANDOFF_REPLAY', 'This one-use project refresh proof was already handled.');
      if (usedProofs.size >= 128) fail('BACKGROUND_HANDOFF_BUSY', 'Finish the current bounded project refresh window before retrying.');
      const next = await loadProfile({ ...profile, hostProject: body.hostProject });
      if (syncing) fail('PROJECT_BUSY', 'The originating project is already being refreshed.');
      usedProofs.set(body.nonce, Date.now()); syncing = true;
      try {
        const current = service.getState().workspaceIndex?.currentRecord;
        const changed = Boolean(activeHostProject && !samePath(activeHostProject.projectRoot, next.hostProject.projectRoot) || current?.hostTaskId === profile.originThreadId && current.hostProjectRoot && !samePath(current.hostProjectRoot, next.hostProject.projectRoot));
        if (typeof service.adoptSignedHostProject !== 'function') fail('BACKGROUND_HOST_RESTORE_UNAVAILABLE', 'This runtime cannot refresh its signed originating project.');
        await service.adoptSignedHostProject({ ...service.hostContext, native: false, hostTaskId: profile.originThreadId, taskIdAvailable: true, hostProjectId: next.hostProject.hostProjectId, projectRoot: next.hostProject.projectRoot, roots: [{ root: next.hostProject.projectRoot, name: path.basename(next.hostProject.projectRoot) }], source: next.hostProject.source }, { reset: changed });
        activeHostProject = next.hostProject;
        const restored = await restoreSignedOriginWorkspace(service, next);
        if (!restored && next.hostProject.autoOpen && !service.bootstrap?.diagnostic) await service.bootstrapHostProject?.();
        if (service.getState().project) await awaitRestoredOrigin(service, profile, originReadyTimeoutMs);
        return { refreshed: true, contextChanged: changed, projectReady: Boolean(service.getState().project) };
      } finally { syncing = false; }
    };
    const handoffs = new Map(), consumedHandoffs = new Map();
    const projectWindowHandoff = {
      async prepare(envelope) {
        const body = envelope?.payload;
        if (!body || Object.keys(envelope).some(key => !['payload', 'signature'].includes(key)) || Object.keys(body).some(key => !['schemaVersion', 'purpose', 'key', 'owner', 'originThreadId', 'dataRoot', 'version', 'recordId', 'snapshotId', 'source', 'issuedAt', 'nonce'].includes(key)) || body.schemaVersion !== 1 || body.purpose !== 'project-window-handoff' || body.key !== profile.key || body.owner !== payload.owner || body.originThreadId !== profile.originThreadId || !profile.originThreadId || body.dataRoot !== profile.dataRoot || body.version !== profile.version || !/^workspace-[a-f0-9]{32}$/u.test(body.recordId || '') || !validId(body.snapshotId) || !Number.isFinite(body.issuedAt) || Date.now() - body.issuedAt > 60000 || body.issuedAt - Date.now() > 5000 || !/^[a-f0-9]{48}$/u.test(body.nonce || '') || !/^[a-f0-9]{64}$/u.test(envelope.signature || '') || !body.source || Object.keys(body.source).some(key => !['url', 'key', 'owner'].includes(key)) || !/^[a-f0-9]{32}$/u.test(body.source.key || '') || !/^[a-f0-9]{48}$/u.test(body.source.owner || '')) fail('BACKGROUND_HANDOFF_INVALID', 'The selected project window proof is invalid or expired.');
        privateUrl(body.source.url); const expected = createHmac('sha256', await secretFor(profile)).update(JSON.stringify(body)).digest(); if (!timingSafeEqual(expected, Buffer.from(envelope.signature, 'hex'))) fail('BACKGROUND_HANDOFF_INVALID', 'The selected window handoff signature is invalid.');
        for (const [key, row] of handoffs) if (Date.now() - row.createdAt > 10 * 60000) handoffs.delete(key); for (const [key, row] of consumedHandoffs) if (Date.now() - row.createdAt > 10 * 60000) consumedHandoffs.delete(key);
        if (handoffs.has(body.nonce) || consumedHandoffs.has(body.nonce)) fail('BACKGROUND_HANDOFF_REPLAY', 'This selected window handoff was already prepared.');
        if (handoffs.size >= 8 || consumedHandoffs.size >= 64) fail('BACKGROUND_HANDOFF_BUSY', 'The bounded project window handoff window is full.');
        const state = service.getState(); service._assertIdle?.();
        if (state.workspaceIndex?.currentRecordId !== body.recordId || state.project?.snapshotId !== body.snapshotId || state.desktopExecution?.available !== true || state.desktopExecution.threadId !== profile.originThreadId) fail('PROJECT_CHAT_NOT_READY', 'The target paper/chat pair changed before window navigation.');
        handoffs.set(body.nonce, { createdAt: Date.now(), recordId: body.recordId, snapshotId: body.snapshotId, fromUrl: body.source.url, toUrl: session.url });
        return { handoffId: body.nonce, expiresAt: new Date(Date.now() + 2 * 60000).toISOString() };
      },
      async acknowledge(input) {
        if (!input || Object.keys(input).some(key => key !== 'handoffId') || !/^[a-f0-9]{48}$/u.test(input.handoffId || '')) fail('INVALID_INPUT', 'Acknowledge only this navigation handoff.');
        const completed = consumedHandoffs.get(input.handoffId); if (completed?.promise) return completed.promise; if (completed?.result) return structuredClone(completed.result);
        const row = handoffs.get(input.handoffId); if (!row) fail('BACKGROUND_HANDOFF_INVALID', 'The one-use navigation handoff is unavailable. Reopen the paper from its Desktop chat.');
        handoffs.delete(input.handoffId); const settled = { createdAt: Date.now(), result: null }; consumedHandoffs.set(input.handoffId, settled);
        const finish = result => { settled.result = result; return structuredClone(result); };
        const operation = (async () => {
        const state = service.getState();
        const ownership = { fromUrl: row.fromUrl, toUrl: row.toUrl, dataRoot: profile.dataRoot, handoffId: input.handoffId, helperPath: path.join(profile.pluginRoot, 'scripts/reassign-window.ps1') };
        const cancel = async () => { try { await (await import('./window-handoff.mjs')).cancelPaperWindowHandoff(ownership); } catch {} };
        if (Date.now() - row.createdAt > 2 * 60000 || state.workspaceIndex?.currentRecordId !== row.recordId || state.project?.snapshotId !== row.snapshotId || state.desktopExecution?.threadId !== profile.originThreadId) { await cancel(); return finish({ acknowledged: false, code: 'PROJECT_HANDOFF_STALE', returnUrl: row.fromUrl }); }
        try { const transfer = transferProjectWindow || (async options => (await import('./window-handoff.mjs')).reassignPaperWindow(options)); const result = await transfer(ownership); if (result?.reassigned !== true) fail('PROJECT_WINDOW_HANDOFF_UNVERIFIED', 'The arriving page could not verify its managed window ownership.'); return finish({ acknowledged: true }); }
        catch (error) { await cancel(); return finish({ acknowledged: false, code: /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.code || '') ? error.code : 'PROJECT_WINDOW_HANDOFF_FAILED', returnUrl: row.fromUrl }); }
        })(); settled.promise = operation; return operation;
      },
    };
    const switchWorkspace = async input => (await import('./paper-project-switch.mjs')).switchPaperProject({ service, profile, session, input });
    web = await (startWeb || (await import('./local-web.mjs')).startLocalWeb)({ service: facade, htmlPath: path.join(profile.pluginRoot, 'dist/preview.html'), syncHostProject, switchWorkspace, projectWindowHandoff }); privateUrl(web.url);
    session = { schemaVersion: 1, mode: MODE, key: profile.key, owner: payload.owner, pid: process.pid, version: profile.version, projectRoot: profile.record?.projectRoot || null, mainFile: profile.record?.mainFile || null, recordId: profile.record?.recordId || null, ...(profile.launchId ? { launchId: profile.launchId } : {}), ...(profile.originThreadId ? { originThreadId: profile.originThreadId } : {}), ...(profile.viewerOnly ? { viewerOnly: true } : {}), threadId: profile.binding?.threadId || null, url: web.url, createdAt: new Date().toISOString() };
    await atomicJson(profile.sessionFile, session); await unlink(claimed).catch(() => {});
    if (registerSignals) for (const signal of ['SIGINT', 'SIGTERM']) { const handler = () => { close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; }); }; signalHandlers.push([signal, handler]); process.on(signal, handler); }
    return { service, sessionFile: profile.sessionFile, close };
  } catch (error) { await close().catch(() => {}); throw error; }
}

/** Desktop shortcut and native tool share the exact same per-record daemon. */
export async function openConfiguredWorkbench({ pluginRoot = PACKAGE_ROOT, noOpen = false, browser = null, createService, ensure = ensureBackgroundWorkbench, readSession = readBackgroundSession, launchWindow } = {}) {
  if (typeof noOpen !== 'boolean' || browser !== null && !path.isAbsolute(browser)) fail('BACKGROUND_CONFIG_INVALID', 'Use an absolute browser path and the installed launch profile.');
  const config = (await boundedJson(path.join(pluginRoot, 'mcp.json'), 65536)).mcpServers?.['bilingual-paper-editor'], env = config?.env || {};
  const profile = await loadProfile({ pluginRoot, dataRoot: env.PAPER_EDITOR_DATA_ROOT, version: env.PAPER_EDITOR_INSTALL_VERSION, record: { projectRoot: env.PAPER_EDITOR_WORKSPACE, mainFile: env.PAPER_EDITOR_MAIN_FILE } });
  const factory = createService || (await import('./runtime.mjs')).createApplication;
  const hostEnv = { ...env }; delete hostEnv.PAPER_EDITOR_WORKSPACE; delete hostEnv.PAPER_EDITOR_MAIN_FILE;
  const service = await factory({ dataRoot: profile.dataRoot, codexRoot: env.PAPER_EDITOR_CODEX_ROOT, compilerRoot: env.PAPER_EDITOR_COMPILER_ROOT, command: env.PAPER_EDITOR_CODEX_COMMAND, preferredModel: env.PAPER_EDITOR_PREFERRED_MODEL, preferredEffort: env.PAPER_EDITOR_PREFERRED_EFFORT, engine: env.PAPER_EDITOR_ENGINE, native: false, workspace: null, mainFile: null, cwd: profile.pluginRoot, hostEnv, backgroundMode: true, backgroundBinding: null, backgroundRecordId: null, desktopViewerOnly: true });
  let options;
  try {
    // Read bounded index headers only; do not open unrelated papers or chats.
    const records = service.registry?.records ? await service.registry.records() : (await service.listWorkspaces()).records;
    if (!Array.isArray(records) || records.length > 2000) fail('BACKGROUND_HOST_RESTORE_INVALID', 'The bounded saved-workspace headers could not be verified.');
    let selected = records.filter(record => typeof record?.projectRoot === 'string' && typeof record.mainFile === 'string' && samePath(record.projectRoot, profile.record.projectRoot) && samePath(record.mainFile.replaceAll('\\', '/'), profile.record.mainFile)).sort((a, b) => String(b.lastOpenedAt).localeCompare(String(a.lastOpenedAt)))[0];
    if (!selected) {
      if (typeof service.registry?.register !== 'function') fail('BACKGROUND_HOST_RESTORE_UNAVAILABLE', 'The runtime cannot register this exact viewer workspace without opening a chat.');
      selected = await service.registry.register({ projectRoot: profile.record.projectRoot, mainFile: profile.record.mainFile, hostTaskId: null, hostSource: 'human-selection' });
    }
    if (!/^workspace-[a-f0-9]{32}$/u.test(selected.recordId || '')) fail('BACKGROUND_HOST_RESTORE_INVALID', 'The saved shortcut record has an invalid identity.');
    const sameOrigin = validId(selected.hostTaskId) && selected.threadId === selected.hostTaskId;
    options = { pluginRoot: profile.pluginRoot, dataRoot: profile.dataRoot, version: profile.version, binding: null, ...(sameOrigin ? { record: null, launchId: selected.hostTaskId, originThreadId: selected.hostTaskId } : { record: { projectRoot: profile.record.projectRoot, mainFile: profile.record.mainFile, recordId: selected.recordId }, viewerOnly: true }) };
  } finally { await service.close(); }
  const ready = await ensure(options); let windowPlacement = null;
  if (!noOpen) {
    const session = await readSession(options); privateUrl(session.url);
    const launch = launchWindow || (await import('./native-window.mjs')).openNormalEdgeWindow;
    const placement = await launch({ url: session.url, dataRoot: profile.dataRoot, ...(browser ? { browser } : {}) });
    if (placement?.requestedState === 'normal' && ['width', 'height', 'x', 'y'].every(key => Number.isFinite(placement[key])) && placement.width > 0 && placement.height > 0) windowPlacement = { width: placement.width, height: placement.height, x: placement.x, y: placement.y, requestedState: 'normal' };
  }
  return { pid: ready.pid, mode: MODE, version: profile.version, reused: ready.reused === true, sessionFile: ready.sessionFile, independentWindow: !noOpen, windowPlacement, desktopWindowRequired: false, nativeCardRequired: false };
}

const isEntry = typeof __PAPER_ENTRY_KIND__ === 'string' ? __PAPER_ENTRY_KIND__ === 'background-workbench' : process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntry) {
  const args = process.argv.slice(2);
  if (args[0] === '--open-workbench') {
    let noOpen = false, browser = null, valid = true;
    for (let index = 1; index < args.length; index++) {
      if (args[index] === '--no-open' && !noOpen) noOpen = true;
      else if (args[index] === '--browser' && browser === null && path.isAbsolute(args[index + 1] || '')) browser = args[++index];
      else valid = false;
    }
    if (!valid) process.exitCode = 2;
    else openConfiguredWorkbench({ noOpen, browser }).then(result => { process.stdout.write(JSON.stringify(result) + '\n'); }).catch(() => { process.stderr.write('BACKGROUND_START_FAILED: configured paper workbench launch failed\n'); process.exitCode = 1; });
  } else if (args.length === 2 && args[0] === '--handoff') runBackgroundWorkbench({ descriptorFile: args[1] }).catch(() => { process.stderr.write('BACKGROUND_START_FAILED: paper background launch failed\n'); process.exitCode = 1; });
  else process.exitCode = 2;
}
