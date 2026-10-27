import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { PaperVersionPair } from './version-pair.mjs';
import { deriveEnglishView } from './english-view.mjs';
import { inputManifestIdentity } from './build-identity.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const inputIdentity = (engine, mainFile, files) => inputManifestIdentity({ engine, mainFile, files: files.map(file => ({ path: file.path, hash: file.hash })) });

/** The chat workspace contains two stable PDFs; compiler/undo data stays outside. */
export class VersionWorkflow {
  constructor(app, { contextDir }) { this.app = app; this.contextDir = contextDir; this.current = null; this.store = null; this.projectId = null; this.pending = null; this.problem = null; }
  state() {
    const project = this.app.core.getState().project;
    if (!this.current || this.current.projectId !== project?.id) return { available: false, reason: this.problem?.code || 'VERSION_PAIR_NOT_READY', authorFiles: 2 };
    return { ...structuredClone(this.current), available: this.current.latest.snapshotId === project.snapshotId, authorFiles: 2, latestSource: 'confirmed-source', ...(this.problem ? { error: this.problem } : {}) };
  }
  async read() {
    if (this.pending) return this.pending;
    this.pending = this._refresh().finally(() => { this.pending = null; });
    return this.pending;
  }
  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(async () => { if (this.pending) await this.pending.catch(() => {}); this.scheduled = false; this.read().catch(() => this.app.emit('change')); });
  }
  async _refresh() {
    try {
      await this.app.core._assertSourceCurrent();
      const state = this.app.core.getState(), project = state.project, sourceStore = this.app.core._store;
      if (!project || !this.app.core._store) fail('PROJECT_REQUIRED', 'Open the paper before selecting its two PDF versions.');
      if (this.projectId !== project.id) { this.projectId = project.id; this.current = null; this.store = new PaperVersionPair({ contextDir: this.contextDir, metadataDir: path.join(this.app.core._store, 'version-pair') }); }
      const store = this.store;
      const views = this.app.reading.derive().projections;
      if (views.some(item => !item.supported)) fail('ENGLISH_VIEW_UNSUPPORTED', 'The original/latest English PDF pair requires a supported reading projection.');
      const projected = new Map(views.map(item => [item.path, item.text]));
      const files = [...this.app.core._files.values()].map(file => ({ path: file.path, hash: hash(projected.has(file.path) ? Buffer.from(projected.get(file.path)) : file.bytes) })).sort((a, b) => a.path.localeCompare(b.path));
      const expectedInput = inputIdentity(this.app.engine, project.mainFile, files);
      const verified = (this.app.flow?.builds || []).filter(build => build.kind === 'english' && build.status === 'success' && build.isolation?.verified === true && !build.candidateHash);
      const promoted = (this.app.flow?.builds || []).filter(build => build.kind === 'candidate' && build.projectId === project.id && build.status === 'success' && build.isolation?.verified === true && build.promotedSnapshotId === project.snapshotId && build.candidateHash && this.app.flow.transactions?.some(transaction => transaction.state === 'applied' && transaction.projectId === project.id && !transaction.sourceChangedAgain && transaction.buildId === build.buildId && transaction.afterSnapshotId === project.snapshotId && transaction.candidateHash === build.candidateHash));
      const builds = (this.app.flow?.builds || []).filter(build => (verified.includes(build) && build.snapshotId === project.snapshotId || promoted.includes(build)) && build.inputHash === expectedInput);
      if (!builds.length) fail('VERSION_PAIR_COMPILE_REQUIRED', 'Generate the current English PDF first. Pending revisions become the latest version after compiled, confirmed source writeback.');
      const latestBuild = builds.at(-1), latestPdf = await this.app.readPdf({ buildId: latestBuild.buildId });
      if (!(latestPdf.kind === 'english' && !latestBuild.candidateHash || promoted.includes(latestBuild) && latestPdf.kind === 'candidate' && latestPdf.promoted === true && latestPdf.candidateHash === latestBuild.candidateHash) || latestPdf.provenance !== 'verified-isolated-build' || latestPdf.hash !== latestBuild.pdfHash || latestPdf.snapshotId !== project.snapshotId) fail('BUILD_IDENTITY_MISMATCH', 'The latest PDF lacks its exact isolated source identity.');
      let existing;
      try { existing = await store.read(); } catch (error) { if (error.code !== 'VERSION_PAIR_NOT_READY') throw error; }
      let originalBuild = verified.find(build => build.snapshotId === project.snapshotId && build.inputHash === expectedInput);
      if (!existing && state.originalSnapshotId && state.originalSnapshotId !== project.snapshotId) {
        if (!/^[A-Za-z0-9_.-]{1,128}$/.test(state.originalSnapshotId)) fail('ORIGINAL_VERSION_UNAVAILABLE', 'The first-source snapshot identity is invalid.');
        const filename = path.join(this.app.core._store, 'snapshots', `${state.originalSnapshotId}.json`), info = await lstat(filename).catch(() => null);
        if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 96 * 1024 * 1024) fail('ORIGINAL_VERSION_UNAVAILABLE', 'The retained first-upload source snapshot is unavailable; the latest PDF will not be relabelled as original.');
        const snapshot = JSON.parse(await readFile(filename, 'utf8'));
        if (snapshot.schemaVersion !== 1 || snapshot.snapshotId !== state.originalSnapshotId || !Array.isArray(snapshot.files) || snapshot.files.length > 500) fail('ORIGINAL_VERSION_UNAVAILABLE', 'The first-upload source snapshot cannot be verified.');
        const names = new Set(), rawManifest = [];
        const initial = snapshot.files.map(file => {
          if (typeof file.path !== 'string' || typeof file.base64 !== 'string') fail('ORIGINAL_VERSION_UNAVAILABLE', 'A retained original input is incomplete.');
          if (names.has(file.path)) fail('ORIGINAL_VERSION_UNAVAILABLE', 'The retained first-source file list contains duplicates.'); names.add(file.path);
          const bytes = Buffer.from(file.base64, 'base64'); if (hash(bytes) !== file.hash) fail('ORIGINAL_VERSION_UNAVAILABLE', 'A retained original input hash changed.');
          rawManifest.push({ path: file.path, hash: file.hash, size: bytes.length });
          const view = /\.tex$/i.test(file.path) ? deriveEnglishView(new TextDecoder('utf8', { fatal: true }).decode(bytes), file.path) : null;
          if (view && !view.supported) fail('ORIGINAL_VERSION_UNAVAILABLE', 'The first-upload English projection cannot be proven.');
          return { path: file.path, hash: view ? hash(view.text) : file.hash, originalHash: file.hash };
        });
        const originalIdentity = `snap-${hash(JSON.stringify({ mainFile: project.mainFile, files: rawManifest.sort((a, b) => a.path.localeCompare(b.path)) }))}`;
        if (originalIdentity !== state.originalSnapshotId) fail('ORIGINAL_VERSION_UNAVAILABLE', 'The retained first-source snapshot does not match its canonical identity.');
        originalBuild = verified.find(build => build.inputHash === inputIdentity(build.engine || this.app.engine, project.mainFile, initial));
        if (!originalBuild) {
          // Missing original graphics may have been supplied later. Reuse a
          // current build only when every original input remains byte-identical
          // and the complete set of textual source files is unchanged.
          const current = this.app.core._files, textual = name => /\.(?:tex|bib|sty|cls)$/i.test(name);
          const unchanged = initial.every(file => current.get(file.path)?.bytes && hash(current.get(file.path).bytes) === file.originalHash) && [...current.keys()].filter(textual).every(name => initial.some(file => file.path === name));
          if (!unchanged) fail('ORIGINAL_VERSION_UNAVAILABLE', 'No verified PDF matches the first-upload source. Keep the original baseline; do not substitute the latest version.');
          originalBuild = verified.find(build => build.snapshotId === project.snapshotId && build.inputHash === expectedInput);
        }
      }
      if (!existing && !originalBuild) fail('ORIGINAL_VERSION_UNAVAILABLE', 'No verified English PDF proves the retained first-source version.');
      const originalPdf = existing ? null : originalBuild.buildId === latestBuild.buildId ? latestPdf : await this.app.readPdf({ buildId: originalBuild.buildId });
      const original = existing ? { bytes: Buffer.from(existing.original.base64, 'base64'), snapshotId: existing.original.snapshotId, buildId: existing.original.buildId } : { bytes: Buffer.from(originalPdf.base64, 'base64'), snapshotId: originalBuild.snapshotId, buildId: originalBuild.buildId };
      const latest = { bytes: Buffer.from(latestPdf.base64, 'base64'), snapshotId: latestBuild.promotedSnapshotId || latestBuild.snapshotId, buildId: latestBuild.buildId, ...(latestBuild.candidateHash ? { candidateHash: latestBuild.candidateHash } : {}) };
      if (hash(latest.bytes) !== latestBuild.pdfHash || !existing && hash(original.bytes) !== originalBuild.pdfHash) fail('BUILD_IDENTITY_MISMATCH', 'The PDF changed after its verified build.');
      await this.app.core._assertSourceCurrent();
      const currentProject = this.app.core.getState().project;
      if (currentProject?.id !== project.id || currentProject.snapshotId !== project.snapshotId || this.app.core._store !== sourceStore || this.store !== store) fail('VERSION_CONFLICT', 'The paper changed while its PDF pair was prepared.');
      const previous = this.current?.pairId;
      const updated = await store.update({ projectId: project.id, original, latest });
      const publishedProject = this.app.core.getState().project;
      if (publishedProject?.id !== project.id || publishedProject.snapshotId !== project.snapshotId || this.app.core._store !== sourceStore || this.store !== store) fail('VERSION_CONFLICT', 'The active paper changed while its PDF pair was published.');
      this.current = updated; this.problem = null;
      if (previous !== this.current.pairId) this.app.emit('change');
      return store.read(this.current.pairId);
    } catch (error) { this.problem = { code: error.code || 'VERSION_PAIR_FAILED', message: error.message }; throw error; }
  }
}
