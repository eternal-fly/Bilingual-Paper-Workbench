import path from 'node:path';
import os from 'node:os';
import { mkdir, realpath, lstat } from 'node:fs/promises';
import { PaperApplication } from './application.mjs';
import { CompilerWorker } from './compiler/worker.mjs';
import { CodexBridge, PAPER_TOOL_SPECS } from './codex-bridge.mjs';
import { NativeBoundChat } from './native-bound-chat.mjs';
import { VersionWorkflow } from './version-workflow.mjs';
import { WorkspaceService } from './workspace-service.mjs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readOriginChatMetadata, resolveOriginChatCwd } from './origin-chat-binding.mjs';
import { DesktopQueueProducer } from './desktop-queue.mjs';
import { DesktopTranslationTasks } from './translation-tasks.mjs';

async function privateDirectory(root, directory) {
  const relative = path.relative(root, directory);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Object.assign(new Error('Private task state must stay inside its configured data root.'), { code: 'PERMISSION_DENIED' });
  let cursor = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try { await mkdir(cursor, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Object.assign(new Error('Private task state cannot traverse a link or reparse directory.'), { code: 'PERMISSION_DENIED' });
  }
}

export async function createApplication({ dataRoot, codexRoot, compilerRoot, command, preferredModel, preferredEffort, engine, native = false, workspace = process.env.PAPER_EDITOR_WORKSPACE || null, mainFile = process.env.PAPER_EDITOR_MAIN_FILE || null, cwd = process.cwd(), hostEnv = process.env, backgroundBinding = null, backgroundRecordId = null, backgroundMode = false, backgroundOriginThreadId = null, desktopViewerOnly = false } = {}) {
  if (typeof desktopViewerOnly !== 'boolean' || desktopViewerOnly && backgroundOriginThreadId !== null) throw new TypeError('A paper viewer cannot acquire a Desktop execution origin.');
  const privateRoot = path.join(process.env.LOCALAPPDATA || os.homedir(), 'BilingualPaperEditor');
  dataRoot ||= process.env.PAPER_EDITOR_DATA_ROOT || path.join(privateRoot, 'workspace');
  codexRoot ||= process.env.PAPER_EDITOR_CODEX_ROOT || path.join(privateRoot, 'codex');
  compilerRoot ||= process.env.PAPER_EDITOR_COMPILER_ROOT || process.env.PAPER_EDITOR_COMPILER_RUNTIME || path.join(privateRoot, 'compiler/runtime64');
  await mkdir(dataRoot, { recursive: true, mode: 0o700 }); await mkdir(codexRoot, { recursive: true, mode: 0o700 });
  dataRoot = await realpath(dataRoot); codexRoot = await realpath(codexRoot); compilerRoot = await realpath(compilerRoot).catch(() => path.resolve(compilerRoot));
  let workspaceService;
  const factory = async (record = null) => {
    const stateRoot = record?.stateRoot || dataRoot, chatRoot = record?.chatRoot || codexRoot;
    await privateDirectory(dataRoot, stateRoot); await privateDirectory(codexRoot, chatRoot);
    // .NET Framework sandbox helpers still obey Windows MAX_PATH. New task IDs
    // must not lengthen probe/build paths; preserve legacy artifact locations.
    const compilerData = record && !record.legacy ? path.join(path.dirname(dataRoot), 'c', createHash('sha256').update(stateRoot).digest('hex').slice(0, 12)) : path.join(stateRoot, 'compiler-jobs');
    const compiler = new CompilerWorker({ dataRoot: compilerData, runtimeRoot: compilerRoot });
    const app = new PaperApplication({ dataRoot: stateRoot, compiler, engine: record?.initialEngine || engine || process.env.PAPER_EDITOR_ENGINE || 'xelatex', preferredModel: record?.model || preferredModel || process.env.PAPER_EDITOR_PREFERRED_MODEL || null, preferredEffort: record?.effort || preferredEffort || process.env.PAPER_EDITOR_PREFERRED_EFFORT || null });
    app.desktopExecutionEnabled = Boolean(backgroundOriginThreadId) || desktopViewerOnly;
    if (desktopViewerOnly) app._nativeBindingError = { code: 'LEGACY_VIEWER_ONLY', message: 'This saved paper is open without model execution. Open its verified Desktop chat to use model assistance; its saved chat binding was preserved.' };
    const projectId = record ? `project-${createHash('sha256').update(`${record.projectRoot.toLowerCase()}\0${record.mainFile.toLowerCase()}`).digest('hex').slice(0, 24)}` : null;
    const chat = new CodexBridge({ dataRoot: chatRoot, cwd: record?.contextDir || path.join(chatRoot, 'context'), paperBinding: projectId, command: command || process.env.PAPER_EDITOR_CODEX_COMMAND || 'codex', toolSpecs: PAPER_TOOL_SPECS, handleTool: ({ tool, arguments: args, ...context }) => app.handlePaperTool(tool, args, context) });
    app.backgroundMode=backgroundMode||Boolean(backgroundBinding)||Boolean(backgroundRecordId);
    app.createBoundChat = async (threadId, bindingSelection = null) => {
      if (app.desktopExecutionEnabled) throw Object.assign(new Error('Desktop owns this chat. Requests use its message queue.'), { code: 'DESKTOP_EXECUTION_REQUIRED' });
      const boundRoot = path.join(chatRoot, 'native-bound'), leaseRoot = path.join(codexRoot, 'native-leases');
      await privateDirectory(codexRoot, boundRoot); await privateDirectory(codexRoot, leaseRoot);
      const boundCwd = await resolveOriginChatCwd({ flow: app.flow, threadId, fallback: chat.cwd });
      return new NativeBoundChat({ threadId, bindingSelection: bindingSelection || app.flow?.nativeChatBinding || app.flow?.backgroundChatReference, leaseRoot, dataRoot: boundRoot, cwd: boundCwd, paperBinding: app.core.getState().project?.id || projectId, command: command || process.env.PAPER_EDITOR_CODEX_COMMAND || 'codex', toolSpecs: PAPER_TOOL_SPECS, handleTool: ({ tool, arguments: args, ...context }) => app.handlePaperTool(tool, args, context) });
    };
    app.versionPair = new VersionWorkflow(app, { contextDir: chat.cwd });
    app.attachChat(chat); await app.initialize();
    if (backgroundOriginThreadId) {
      app.desktopExecutionEnabled = true;
      const quote = value => "'" + value.replaceAll("'", "''") + "'";
      app.desktopCallbackCommand = `& ${quote(process.execPath)} ${quote(path.join(fileURLToPath(new URL('../', import.meta.url)), 'dist/desktop-callback.mjs'))}`;
      app.desktopThreadId = () => workspaceService?.desktopExecution?.state()?.available ? workspaceService.desktopExecution.state().threadId : null;
      app.desktopRequestRunner = input => workspaceService.desktopExecution.runRequest(app, input);
      app.translationTasks = new DesktopTranslationTasks(app, {
        getThreadId: () => workspaceService?.desktopExecution?.state()?.threadId || null,
        enqueue: input => workspaceService.desktopExecution.enqueueForApp(app, input),
      });
    }
    return app;
  };
  const readOriginMetadata = async (threadId, { signal } = {}) => { const directory = path.join(codexRoot, 'origin-metadata', createHash('sha256').update(threadId).digest('hex').slice(0, 16), String(process.pid)); await privateDirectory(codexRoot, directory); return readOriginChatMetadata({ threadId, dataRoot: directory, cwd: directory, command: command || process.env.PAPER_EDITOR_CODEX_COMMAND || 'codex', signal }); };
  const createDesktopProducer = backgroundOriginThreadId ? async selection => {
    const directory = path.join(codexRoot, 'desktop-queue', createHash('sha256').update(selection.threadId).digest('hex').slice(0, 20));
    await privateDirectory(codexRoot, directory);
    return new DesktopQueueProducer({ threadId: selection.threadId, dataRoot: directory, command: command || process.env.PAPER_EDITOR_CODEX_COMMAND || 'codex', desktopQueueVerified: true });
  } : null;
  const app = workspaceService = new WorkspaceService({ initialApp: await factory(), factory, dataRoot, codexRoot, originThreadId: backgroundOriginThreadId, readOriginMetadata, createDesktopProducer, hostOptions: { native, cwd, env: hostEnv, explicitWorkspace: workspace, explicitMainFile: mainFile, excludedRoots: [fileURLToPath(new URL('../', import.meta.url)), dataRoot, codexRoot] } });
  await app.initializeWorkspace(); return app;
}
