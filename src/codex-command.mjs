import { access, lstat, opendir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const VERSION = /^[a-f0-9]{16,64}$/iu;
const MAX_PATH_ENTRIES = 64, MAX_VERSIONS = 64;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const samePath = (a, b, platform) => platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const absolute = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f"]/u.test(value) && path.isAbsolute(value) && !/^[\\/]{2}/u.test(value) && (process.platform !== 'win32' || /^[a-z]:[\\/]/iu.test(value));
const environment = (env, name) => Object.entries(env || {}).find(([key, value]) => key.toLowerCase() === name.toLowerCase() && typeof value === 'string')?.[1];

function officialBin(command) {
  const version = path.dirname(command), bin = path.dirname(version), codex = path.dirname(bin), openai = path.dirname(codex);
  return path.basename(command).toLowerCase() === 'codex.exe' && VERSION.test(path.basename(version)) && path.basename(bin).toLowerCase() === 'bin' && path.basename(codex).toLowerCase() === 'codex' && path.basename(openai).toLowerCase() === 'openai' ? bin : null;
}

/** Inspect a candidate without launching it. Every ancestor must be a real
 * directory; a symlink, junction or realpath redirect is never an executable. */
async function inspect(filename, platform) {
  if (!absolute(filename)) return { status: 'invalid' };
  const normalized = path.resolve(filename), parsed = path.parse(normalized), parts = normalized.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root, info;
  try {
    const root = await lstat(current);
    if (!root.isDirectory() || root.isSymbolicLink()) return { status: 'invalid' };
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]); info = await lstat(current);
      if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) return { status: 'invalid' };
    }
    if (!samePath(await realpath(normalized), normalized, platform)) return { status: 'invalid' };
    await access(normalized, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return { status: 'verified', filename: normalized, mtimeMs: info.mtimeMs };
  } catch (error) { return { status: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'invalid' }; }
}

async function siblingCandidates(bin, platform) {
  // Check the known bin directory and its ancestors before opening it.
  try {
    let current = path.resolve(bin);
    for (;;) {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) return [];
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
    if (!samePath(await realpath(bin), path.resolve(bin), platform)) return [];
    const directory = await opendir(bin), names = [];
    try {
      for (let count = 0; count < MAX_VERSIONS; count++) {
        const entry = await directory.read(); if (!entry) break;
        if (entry.isDirectory() && !entry.isSymbolicLink() && VERSION.test(entry.name)) names.push(entry.name);
      }
      // A truncated installation inventory is ambiguous. Do not choose a
      // potentially old executable from only one portion of an oversized root.
      if (await directory.read()) return [];
    } finally { await directory.close(); }
    const candidates = [];
    for (const name of names) {
      const candidate = await inspect(path.join(bin, name, 'codex.exe'), platform);
      if (candidate.status === 'verified') candidates.push(candidate);
    }
    return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filename.localeCompare(b.filename));
  } catch { return []; }
}

/** Resolve one verified executable. A Windows Desktop version follows a
 * current PATH version only within its original OpenAI/Codex/bin installation;
 * an explicitly configured custom executable remains pinned.
 * PATH entries are bounded, absolute and inspected; cwd is never searched.
 * No process, shell, model request or user configuration write occurs here. */
export async function resolveCodexCommand(command = 'codex', { env = process.env, platform = process.platform } = {}) {
  const bare = command === 'codex' || platform === 'win32' && command === 'codex.exe';
  if (!bare && !absolute(command)) fail('CODEX_COMMAND_INVALID', 'Use one absolute installed Codex executable.');
  let bin = null, pinned = null;
  if (!bare) {
    const configured = await inspect(command, platform);
    if (configured.status === 'invalid') fail('CODEX_COMMAND_INVALID', 'The configured Codex executable is redirected or unavailable for verification.');
    bin = platform === 'win32' ? officialBin(path.resolve(command)) : null;
    if (configured.status === 'verified') {
      if (!bin) return configured.filename;
      pinned = configured.filename;
    }
    if (!bin) fail('CODEX_COMMAND_UNAVAILABLE', 'The explicitly configured Codex executable is unavailable.');
  } else if (platform === 'win32') {
    const local = environment(env, 'LOCALAPPDATA');
    if (absolute(local)) bin = path.join(local, 'OpenAI/Codex/bin');
  }
  const rawPath = environment(env, 'PATH');
  const entries = typeof rawPath === 'string' && rawPath.length <= 65536 ? rawPath.split(platform === 'win32' ? ';' : ':', MAX_PATH_ENTRIES + 1).slice(0, MAX_PATH_ENTRIES) : [];
  for (const entry of entries) {
    const directory = entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
    if (!absolute(directory)) continue;
    const candidate = path.join(directory, platform === 'win32' ? 'codex.exe' : 'codex');
    if (platform === 'win32' && (!bin || !samePath(officialBin(candidate) || '', bin, platform))) continue;
    const verified = await inspect(candidate, platform);
    if (verified.status === 'verified') return verified.filename;
  }
  if (pinned) return pinned;
  if (bin) {
    const candidates = await siblingCandidates(bin, platform);
    if (candidates.length) return candidates[0].filename;
  }
  fail('CODEX_COMMAND_UNAVAILABLE', 'No verified installed Codex executable is available.');
}
