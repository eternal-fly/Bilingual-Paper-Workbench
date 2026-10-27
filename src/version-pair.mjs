import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const MAX_PDF = 20 * 1024 * 1024, MAX_META = 128 * 1024;
const filenames = { original: 'original.pdf', latest: 'latest-english.pdf' };
const inside = (root, target) => {
  if (process.platform === 'win32') { root = root.toLowerCase(); target = target.toLowerCase(); }
  return target === root || target.startsWith(root + path.sep);
};
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/u.test(value);
function directory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f]/u.test(value) || value.split(/[\\/]/u).includes('..')) fail('VERSION_PAIR_UNSAFE_PATH', 'Version-pair directories must be explicit absolute paths without traversal.');
  const resolved = path.resolve(value);
  if (resolved === path.dirname(resolved)) fail('VERSION_PAIR_UNSAFE_PATH', 'A filesystem root cannot be a version-pair directory.');
  return resolved;
}
async function noReparse(target) {
  for (let current = path.resolve(target);;) {
    try { if ((await lstat(current)).isSymbolicLink()) fail('VERSION_PAIR_UNSAFE_PATH', 'Version-pair paths cannot contain reparse points.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
async function bytesAt(filename, limit) {
  await noReparse(filename);
  let handle;
  try {
    const before = await lstat(filename);
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) fail('VERSION_PAIR_UNSAFE_PATH', 'A version-pair file is aliased, non-regular or oversized.');
    handle = await open(filename, 'r'); const locked = await handle.stat();
    if (!locked.isFile() || locked.nlink !== 1 || locked.dev !== before.dev || locked.ino !== before.ino || locked.size > limit) fail('VERSION_PAIR_UNSAFE_PATH', 'A version-pair file changed identity while opening.');
    const bytes = await handle.readFile(), after = await handle.stat(), current = await lstat(filename);
    if (bytes.length > limit || after.nlink !== 1 || current.isSymbolicLink() || current.dev !== locked.dev || current.ino !== locked.ino || after.size !== locked.size || after.mtimeMs !== locked.mtimeMs) fail('VERSION_PAIR_UNSAFE_PATH', 'A version-pair file changed while reading.');
    return bytes;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}
function pdfBytes(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) fail('INVALID_VERSION_PDF', 'Verified PDF bytes are required.');
  const bytes = Buffer.from(value);
  if (bytes.length < 32 || bytes.length > MAX_PDF || bytes.subarray(0, 5).toString() !== '%PDF-' || !/%%EOF\s*$/u.test(bytes.subarray(-2048).toString('latin1'))) fail('INVALID_VERSION_PDF', 'A version PDF must have a complete bounded PDF envelope.');
  return bytes;
}
function artifact(kind, input) {
  if (!input || !identity(input.snapshotId) || !identity(input.buildId) || input.candidateHash !== undefined && !identity(input.candidateHash)) fail('INVALID_VERSION_PDF', 'Each PDF needs exact snapshot and verified-build identities.');
  const bytes = pdfBytes(input.bytes);
  return { bytes, metadata: { filename: filenames[kind], hash: hash(bytes), byteLength: bytes.length, snapshotId: input.snapshotId, buildId: input.buildId, ...(kind === 'latest' && input.candidateHash !== undefined ? { candidateHash: input.candidateHash } : {}) } };
}
const pairIdentity = value => `pair-${hash(JSON.stringify([value.projectId, value.original.hash, value.latest.hash])).slice(0, 32)}`;
function manifest(value) {
  if (!value || value.schemaVersion !== 1 || !identity(value.projectId) || !Number.isSafeInteger(value.revision) || value.revision < 1) fail('VERSION_PAIR_METADATA_INVALID', 'The version-pair manifest is invalid.');
  for (const kind of ['original', 'latest']) {
    const item = value[kind];
    if (!item || item.filename !== filenames[kind] || !/^[a-f0-9]{64}$/u.test(item.hash || '') || !Number.isSafeInteger(item.byteLength) || item.byteLength < 32 || item.byteLength > MAX_PDF || !identity(item.snapshotId) || !identity(item.buildId) || item.candidateHash !== undefined && !identity(item.candidateHash)) fail('VERSION_PAIR_METADATA_INVALID', 'A manifest PDF identity is invalid.');
  }
  if (value.pairId !== pairIdentity(value)) fail('VERSION_PAIR_METADATA_INVALID', 'The pair identity does not match its exact PDFs.');
  return value;
}
function json(bytes) { try { return JSON.parse(bytes.toString('utf8')); } catch { fail('VERSION_PAIR_METADATA_INVALID', 'Version-pair metadata is not valid JSON.'); } }

/** Two managed PDF projections; compiler provenance must be verified by the caller. */
export class PaperVersionPair {
  constructor({ contextDir, metadataDir } = {}) {
    this.contextDir = directory(contextDir); this.metadataDir = directory(metadataDir);
    if (inside(this.contextDir, this.metadataDir)) fail('VERSION_PAIR_UNSAFE_PATH', 'Version metadata must be outside the dedicated PDF context directory.');
    this.manifestPath = path.join(this.metadataDir, 'version-pair-manifest.json');
    this.pendingPath = path.join(this.metadataDir, 'version-pair-pending.json');
    this.lockPath = path.join(this.metadataDir, 'version-pair.lock');
    this.paths = Object.fromEntries(Object.entries(filenames).map(([kind, name]) => [kind, path.join(this.contextDir, name)]));
  }
  async _locked(work) {
    for (const folder of [this.contextDir, this.metadataDir]) { await noReparse(folder); await mkdir(folder, { recursive: true, mode: 0o700 }); await noReparse(folder); if (!(await lstat(folder)).isDirectory()) fail('VERSION_PAIR_UNSAFE_PATH', 'A version-pair directory is not a directory.'); }
    let lock;
    try { lock = await open(this.lockPath, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') fail('VERSION_PAIR_BUSY', 'The version pair is already being read or updated; no lock was removed.'); throw error; }
    const owner = randomUUID();
    try { await lock.writeFile(owner); await lock.sync(); return await work(); }
    finally { await lock.close(); const bytes = await bytesAt(this.lockPath, 1024); if (bytes?.toString() === owner) await unlink(this.lockPath); }
  }
  async _atomic(filename, bytes, expected) {
    await noReparse(filename);
    const current = await bytesAt(filename, filename.endsWith('.pdf') ? MAX_PDF : MAX_META);
    if ((current ? hash(current) : null) !== expected) fail('VERSION_PAIR_CHANGED', 'A managed file changed before replacement; no external file was overwritten.');
    const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync();
      if ((await handle.stat()).nlink !== 1) fail('VERSION_PAIR_UNSAFE_PATH', 'An atomic replacement became hard-linked.');
      await handle.close(); handle = null;
      await noReparse(filename); const check = await bytesAt(filename, filename.endsWith('.pdf') ? MAX_PDF : MAX_META);
      if ((check ? hash(check) : null) !== expected) fail('VERSION_PAIR_CHANGED', 'A managed file changed during replacement.');
      await rename(temporary, filename);
    } finally {
      await handle?.close(); const remaining = await bytesAt(temporary, Math.max(MAX_PDF, MAX_META));
      if (remaining && hash(remaining) === hash(bytes)) await unlink(temporary);
    }
  }
  async _writeManifest(value, currentBytes) { const bytes = Buffer.from(JSON.stringify(value) + '\n'); await this._atomic(this.manifestPath, bytes, currentBytes ? hash(currentBytes) : null); return bytes; }
  async _files() { return { original: await bytesAt(this.paths.original, MAX_PDF), latest: await bytesAt(this.paths.latest, MAX_PDF) }; }
  _matches(files, value) { return value && ['original', 'latest'].every(kind => files[kind] && hash(files[kind]) === value[kind].hash && files[kind].length === value[kind].byteLength); }
  async _load() {
    let manifestBytes = await bytesAt(this.manifestPath, MAX_META), current = manifestBytes ? manifest(json(manifestBytes)) : null;
    const pendingBytes = await bytesAt(this.pendingPath, MAX_META), files = await this._files();
    if (!pendingBytes) {
      if (current && !this._matches(files, current)) fail('VERSION_PAIR_CHANGED', 'The current PDF pair no longer matches its manifest.');
      if (!current && (files.original || files.latest)) fail('VERSION_PAIR_UNMANAGED', 'Existing unowned PDF filenames were preserved; choose an empty dedicated context directory.');
      return { current, manifestBytes, files, pending: null };
    }
    const pending = json(pendingBytes), next = manifest(pending.next), previous = pending.previous === null ? null : manifest(pending.previous);
    if (pending.schemaVersion !== 1 || previous && (previous.projectId !== next.projectId || previous.original.hash !== next.original.hash || next.revision !== previous.revision + 1) || !previous && next.revision !== 1 || current && JSON.stringify(current) !== JSON.stringify(previous) && JSON.stringify(current) !== JSON.stringify(next)) fail('VERSION_PAIR_METADATA_INVALID', 'An interrupted PDF update cannot be proven.');
    if (this._matches(files, next)) { manifestBytes = await this._writeManifest(next, manifestBytes); await unlink(this.pendingPath); return { current: next, manifestBytes, files, pending: null }; }
    if (this._matches(files, previous)) { await unlink(this.pendingPath); return { current: previous, manifestBytes, files, pending: null }; }
    if (previous || ['original', 'latest'].some(kind => files[kind] && hash(files[kind]) !== next[kind].hash)) fail('VERSION_PAIR_CHANGED', 'Interrupted managed PDFs contain unexpected bytes.');
    return { current: null, manifestBytes, files, pending: next, pendingBytes };
  }
  async update(input) {
    if (!input || !identity(input.projectId)) fail('INVALID_INPUT', 'A stable paper project identity is required.');
    const original = artifact('original', input.original), latest = artifact('latest', input.latest);
    return this._locked(async () => {
      const loaded = await this._load(), current = loaded.current;
      if (current && current.projectId !== input.projectId) fail('VERSION_PAIR_PROJECT_MISMATCH', 'This PDF pair belongs to another paper.');
      if (current && current.original.hash !== original.metadata.hash) fail('ORIGINAL_IMMUTABLE', 'The first captured original PDF cannot be replaced.');
      const next = { schemaVersion: 1, projectId: input.projectId, revision: (current?.revision || 0) + 1, original: current?.original || original.metadata, latest: latest.metadata };
      next.pairId = pairIdentity(next);
      if (current && JSON.stringify({ ...next, revision: current.revision }) === JSON.stringify(current)) return structuredClone(current);
      if (loaded.pending && JSON.stringify(next) !== JSON.stringify(loaded.pending)) fail('VERSION_PAIR_RECOVERY_REQUIRED', 'Resume the exact interrupted first PDF pair before providing another version.');
      if (!loaded.pending) await this._atomic(this.pendingPath, Buffer.from(JSON.stringify({ schemaVersion: 1, previous: current, next }) + '\n'), null);
      if (!loaded.files.original) await this._atomic(this.paths.original, original.bytes, null);
      if (!loaded.files.latest || hash(loaded.files.latest) !== next.latest.hash) await this._atomic(this.paths.latest, latest.bytes, loaded.files.latest ? hash(loaded.files.latest) : null);
      await this._writeManifest(next, loaded.manifestBytes); await unlink(this.pendingPath);
      return structuredClone(next);
    });
  }
  async read(expectedPairId = null) {
    return this._locked(async () => {
      const loaded = await this._load();
      if (!loaded.current) fail(loaded.pending ? 'VERSION_PAIR_RECOVERY_REQUIRED' : 'VERSION_PAIR_NOT_READY', 'Both complete verified PDF versions are required before review.');
      if (expectedPairId !== null && expectedPairId !== loaded.current.pairId) fail('VERSION_PAIR_CHANGED', 'The selected PDF pair is no longer current.');
      return { ...structuredClone(loaded.current), original: { ...loaded.current.original, base64: loaded.files.original.toString('base64') }, latest: { ...loaded.current.latest, base64: loaded.files.latest.toString('base64') } };
    });
  }
}
