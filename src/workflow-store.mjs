import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const MAX_WORKFLOW_BYTES = 64 * 1024 * 1024;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameFile = (a, b) => a.isFile() && b.isFile() && !a.isSymbolicLink() && !b.isSymbolicLink() && a.nlink === 1 && b.nlink === 1 && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
export const workflowValueHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function serializeWorkflow(value) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  if (bytes.length > MAX_WORKFLOW_BYTES) fail('WORKFLOW_TOO_LARGE', 'The private workflow exceeds its bounded storage budget; the durable version was preserved.');
  return bytes;
}

/** Read only the selected private workflow, with an exact bounded identity.
 * Cooperating writers hold the existing PaperService data-root lock. */
export async function readWorkflowSnapshot(store, { allowMissing = false } = {}) {
  const root = path.resolve(store), filename = path.join(root, 'workflow.json');
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || !samePath(await realpath(root), root)) fail('RECOVERY_REQUIRED', 'The selected private workflow directory changed.');
  let before;
  try { before = await lstat(filename); }
  catch (error) { if (error.code === 'ENOENT' && allowMissing) return { value: null, version: { exists: false } }; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_WORKFLOW_BYTES) fail('RECOVERY_REQUIRED', 'The private workflow must remain a bounded unaliased regular file.');
  const handle = await open(filename, 'r');
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened)) fail('WORKFLOW_VERSION_CONFLICT', 'The private workflow changed before it could be read.');
    const bytes = Buffer.alloc(opened.size + 1); let length = 0;
    while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await handle.stat(), named = await lstat(filename);
    if (length !== opened.size || !sameFile(opened, after) || !sameFile(opened, named) || !samePath(await realpath(root), root)) fail('WORKFLOW_VERSION_CONFLICT', 'The private workflow changed while it was being read.');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); }
    catch { fail('RECOVERY_REQUIRED', 'The private workflow is unreadable; preserve it for recovery.'); }
    return { value, version: { exists: true, hash: createHash('sha256').update(bytes.subarray(0, length)).digest('hex'), dev: opened.dev, ino: opened.ino, size: opened.size, mtimeMs: opened.mtimeMs } };
  } finally { await handle.close(); }
}

export async function assertWorkflowVersion(store, expected) {
  if (!expected) fail('WORKFLOW_VERSION_CONFLICT', 'Load the durable workflow before saving it.');
  const actual = (await readWorkflowSnapshot(store, { allowMissing: true })).version;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('WORKFLOW_VERSION_CONFLICT', 'Another controller changed the private workflow. Its newer state and the local changes were preserved.');
}
