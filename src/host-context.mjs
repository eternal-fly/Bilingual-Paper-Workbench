import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, realpath, readdir, open } from 'node:fs/promises';
import { commands } from './latex.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const within = (root, filename) => { const relative = path.relative(root, filename); return !relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null;

export async function projectDirectory(value) {
  if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value)) fail('WORKSPACE_NOT_AUTHORIZED', 'Choose an absolute project directory.');
  const info = await lstat(value);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('WORKSPACE_NOT_AUTHORIZED', 'The project root must be an actual directory.');
  return realpath(value);
}

/** Only the transport supplies roots. Model arguments and arbitrary request _meta
 * are deliberately absent: MCP metadata is not an authorization mechanism. */
export async function resolveHostContext({ native = false, roots = null, cwd = process.cwd(), env = process.env, explicitWorkspace = null, explicitMainFile = null, excludedRoots = [] } = {}) {
  const hostTaskId = native ? identifier(env.CODEX_THREAD_ID) : null;
  const hostProjectId = native ? identifier(env.CODEX_PROJECT_ID) : null;
  const context = { native, hostTaskId, hostProjectId, taskIdAvailable: Boolean(hostTaskId), source: 'unavailable', projectRoot: null, roots: [], explicitMainFile: null };
  // A roots response, including an empty one, supersedes stale installer bindings.
  if (roots !== null) {
    if (!Array.isArray(roots) || roots.length > 32) fail('WORKSPACE_NOT_AUTHORIZED', 'The host returned too many project roots.');
    for (const item of roots) {
      if (!item || typeof item.uri !== 'string' || item.uri.length > 8192) continue;
      let url; try { url = new URL(item.uri); } catch { continue; }
      if (url.protocol !== 'file:' || url.hostname && url.hostname !== 'localhost') continue;
      let root; try { root = await projectDirectory(fileURLToPath(url)); } catch { continue; }
      if (!context.roots.some(item => samePath(item.root, root))) context.roots.push({ root, name: typeof item.name === 'string' ? item.name.slice(0, 160) : path.basename(root) });
    }
    context.source = 'mcp-roots';
    if (context.roots.length === 1) context.projectRoot = context.roots[0].root;
    return context;
  }
  if (native) {
    let root; try { root = await projectDirectory(cwd); } catch { /* Explicit launch binding remains a fallback. */ }
    if (root && !excludedRoots.some(excluded => within(path.resolve(excluded), root))) {
      context.source = 'native-launch-cwd'; context.projectRoot = root; context.roots = [{ root, name: path.basename(root) }];
    }
  }
  if (!context.projectRoot && explicitWorkspace) {
    const root = await projectDirectory(explicitWorkspace);
    context.source = 'explicit-launch-binding'; context.projectRoot = root; context.roots = [{ root, name: path.basename(root) }];
  }
  if (context.projectRoot && explicitWorkspace && explicitMainFile) {
    const explicit = await projectDirectory(explicitWorkspace).catch(() => null);
    if (explicit && samePath(explicit, context.projectRoot)) context.explicitMainFile = explicitMainFile;
  }
  return context;
}

/** Bounded discovery inside the exact authorized root. No parent, session-tree,
 * or filesystem-wide discovery is performed. Ambiguous mains stay unselected. */
export async function discoverMainFiles(root) {
  const candidates = []; let visited = 0, bytes = 0;
  const walk = async (directory, relative = '', depth = 0) => {
    if (depth > 6) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (++visited > 2000) fail('PROJECT_TOO_LARGE', 'Choose the main TeX file explicitly; bounded discovery reached its file limit.');
      if (entry.name.startsWith('.') || ['node_modules', 'dist', 'build'].includes(entry.name) || entry.isSymbolicLink()) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), name, depth + 1);
      else if (entry.isFile() && /\.tex$/i.test(name)) {
        const filename = path.join(root, name), info = await lstat(filename);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) continue;
        bytes += info.size; if (bytes > 32 * 1024 * 1024) fail('PROJECT_TOO_LARGE', 'Choose the main TeX file explicitly; bounded discovery reached its byte limit.');
        const handle = await open(filename, 'r');
        let buffer; try { buffer = Buffer.alloc(info.size + 1); const result = await handle.read(buffer, 0, buffer.length, 0); if (result.bytesRead > info.size) fail('VERSION_CONFLICT', 'A TeX input changed during discovery.'); buffer = buffer.subarray(0, result.bytesRead); } finally { await handle.close(); }
        let source; try { source = new TextDecoder('utf8', { fatal: true }).decode(buffer); } catch { continue; }
        if (commands(source).some(command => command.name === 'documentclass')) candidates.push(name);
      }
    }
  };
  await walk(root); return candidates.sort();
}

export function authorizedRoot(context, root) { return context?.roots?.some(item => samePath(item.root, root)) || false; }
