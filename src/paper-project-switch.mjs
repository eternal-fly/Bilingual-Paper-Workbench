import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { ensureBackgroundWorkbench, readBackgroundSession, signHostProjectRefresh, signProjectWindowHandoff } from './background-workbench.mjs';
import { dispatchBackgroundRequest } from './native-window.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const scope = service => { const state = service.getState(); return JSON.stringify([state.workspaceIndex?.currentRecordId, state.project?.id, state.project?.snapshotId]); };
async function savedFlow(record) {
  const projectId = `project-${hash(record.projectRoot.toLowerCase() + '\0' + record.mainFile.toLowerCase()).slice(0, 24)}`;
  const filename = path.join(record.stateRoot, 'projects', projectId, 'workflow.json');
  let handle;
  try {
    for (let directory = path.dirname(filename);;) { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) fail('PROJECT_CHAT_REQUIRED', 'Saved project metadata cannot traverse redirected folders.'); if (directory === record.stateRoot) break; const parent = path.dirname(directory); if (parent === directory) fail('PROJECT_CHAT_REQUIRED', 'Saved project metadata left its private record.'); directory = parent; }
    const info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16 * 1024 * 1024) fail('PROJECT_CHAT_REQUIRED', 'The saved paper chat metadata cannot be verified.');
    handle = await open(filename, 'r'); const locked = await handle.stat(); if (locked.dev !== info.dev || locked.ino !== info.ino || locked.size !== info.size || locked.nlink !== 1) fail('WORKSPACE_RECORD_CHANGED', 'The saved paper metadata changed.');
    const bytes = Buffer.alloc(locked.size + 1); let length = 0; while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length, length); if (!result.bytesRead) break; length += result.bytesRead; }
    const after = await handle.stat(), named = await lstat(filename);
    if (length !== locked.size || after.size !== locked.size || after.mtimeMs !== locked.mtimeMs || after.nlink !== 1 || named.isSymbolicLink() || named.ino !== locked.ino || named.dev !== locked.dev) fail('WORKSPACE_RECORD_CHANGED', 'The saved paper metadata changed while being read.');
    const flow = JSON.parse(bytes.subarray(0, length).toString('utf8')); if (flow.schemaVersion !== 1 || flow.projectId !== projectId) fail('PROJECT_CHAT_REQUIRED', 'The saved chat belongs to a different paper identity.');
    const references = [flow.nativeChatBinding, flow.backgroundChatReference].filter(item => item?.projectId === projectId && id(item.threadId));
    if (!references.length || new Set(references.map(item => item.threadId)).size !== 1) fail('PROJECT_CHAT_REQUIRED', 'Open this paper from its existing Desktop chat to verify one saved chat first.');
    return { projectId, reference: references[0] };
  } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code) || error instanceof SyntaxError) fail('PROJECT_CHAT_REQUIRED', 'The paper has no verified saved Desktop chat.'); throw error; }
  finally { await handle?.close(); }
}

/** Human UI choice hands the same window to the target chat's canonical daemon.
 * This function is intentionally absent from all model-tool registrations. */
export async function switchPaperProject({ service, profile, session, input, ensure = ensureBackgroundWorkbench, readSession = readBackgroundSession, signRefresh = signHostProjectRefresh, signHandoff = signProjectWindowHandoff, request = dispatchBackgroundRequest, readMetadata = null, reserveWindow = async options => (await import('./window-handoff.mjs')).reservePaperWindowHandoff(options), cancelWindow = async options => (await import('./window-handoff.mjs')).cancelPaperWindowHandoff(options), readyTimeoutMs = 8000 } = {}) {
  if (!input || Object.keys(input).some(key => key !== 'recordId') || !/^workspace-[a-f0-9]{32}$/u.test(input.recordId || '')) fail('INVALID_INPUT', 'Choose one exact saved paper project.');
  const metadataReader = readMetadata || service?.originChat?.readMetadata;
  if (!service?.registry || !profile?.originThreadId || !session?.url || typeof metadataReader !== 'function') fail('PROJECT_CHAT_REQUIRED', 'Open the project selector from its verified Desktop workbench.');
  service._assertIdle?.(); const originalScope = scope(service), record = await service.registry.get(input.recordId), saved = await savedFlow(record);
  const metadata = await metadataReader(saved.reference.threadId, {});
  if (metadata?.threadId !== saved.reference.threadId || !id(metadata.model) || metadata.effort != null && !id(metadata.effort) || typeof metadata.cwd !== 'string' || !path.isAbsolute(metadata.cwd) || metadata.cwd.length > 4096 || /[\x00-\x1f]/u.test(metadata.cwd)) fail('THREAD_MISMATCH', 'The selected project chat or current model could not be verified.');
  const targetOptions = { pluginRoot: profile.pluginRoot, dataRoot: profile.dataRoot, version: profile.version, record: null, binding: null, launchId: metadata.threadId, originThreadId: metadata.threadId, hostProject: { projectRoot: metadata.cwd, source: 'native-launch-cwd', hostProjectId: null, autoOpen: false } };
  await ensure(targetOptions); const targetSession = await readSession(targetOptions);
  const handoffId = randomBytes(24).toString('hex'), reservation = { fromUrl: session.url, toUrl: targetSession.url, dataRoot: profile.dataRoot, handoffId, helperPath: path.join(profile.pluginRoot, 'scripts/reassign-window.ps1') }; let reserved = false;
  if (targetSession.url !== session.url) { const status = await reserveWindow(reservation); if (status?.reason !== 'reserved') fail('PROJECT_WINDOW_HANDOFF_UNVERIFIED', 'The source window could not reserve the selected target safely.'); reserved = true; }
  try {
  await request({ url: targetSession.url, action: 'syncHostProject', payload: await signRefresh(targetOptions, targetSession) });
  let response = await request({ url: targetSession.url, action: 'state', payload: {} }), target = response.state;
  if (target.workspaceIndex?.currentRecordId !== record.recordId) { response = await request({ url: targetSession.url, action: 'openWorkspaceRecord', payload: { recordId: record.recordId } }); target = response.state; }
  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    if (target.workspaceIndex?.currentRecordId !== record.recordId || target.project?.id !== saved.projectId) fail('WORKSPACE_RECORD_CHANGED', 'The target workbench did not retain the exact selected paper.');
    if (target.desktopExecution?.available && target.desktopExecution.threadId === metadata.threadId && target.originatingChat?.verified === true && target.originatingChat.threadId === metadata.threadId) break;
    if (Date.now() >= deadline || ['failed', 'preserved-binding'].includes(target.originatingChat?.phase)) fail('PROJECT_CHAT_NOT_READY', 'The selected paper chat is not ready. Its source and history were preserved.');
    await new Promise(resolve => setTimeout(resolve, 100)); response = await request({ url: targetSession.url, action: 'state', payload: {} }); target = response.state;
  }
  service._assertIdle?.(); if (targetSession.url !== session.url && scope(service) !== originalScope) fail('WORKSPACE_RECORD_CHANGED', 'The source workbench changed while the target project was being prepared.');
  await service.registry.selectForChat({ threadId: metadata.threadId, recordId: record.recordId, hostProjectRoot: metadata.cwd });
  const result = { recordId: record.recordId, paperTitle: target.workspaceIndex.currentRecord.paperTitle || record.paperTitle || record.mainFile, threadId: metadata.threadId, chatReady: true };
  if (targetSession.url === session.url) return { ...result, switched: false };
  const prepared = await request({ url: targetSession.url, action: 'prepareProjectWindowHandoff', payload: await signHandoff(targetOptions, targetSession, { sourceSession: session, recordId: record.recordId, snapshotId: target.project.snapshotId, handoffId }) });
  if (prepared.result?.handoffId !== handoffId) fail('BACKGROUND_HANDOFF_INVALID', 'The target workbench did not confirm the exact reserved navigation handoff.');
  return { ...result, switched: true, navigateUrl: targetSession.url + '&handoff=' + handoffId };
  } catch (error) { if (reserved) await cancelWindow(reservation).catch(() => {}); throw error; }
}
