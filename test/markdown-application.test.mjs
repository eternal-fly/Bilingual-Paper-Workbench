import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, link, rename, symlink } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaperApplication, buildInputHash } from '../src/application.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const owned = path.join(root, 'work/markdown-state-tests'); await mkdir(owned, { recursive: true });
  const directory = await mkdtemp(path.join(owned, 'case-')), source = path.join(directory, 'source'); await mkdir(source);
  await writeFile(path.join(source, 'main.tex'), String.raw`\documentclass{article}
\newcommand{\Ns}{N_s}
\begin{document}

A synthetic claim contains $\Ns$.

\end{document}`);
  const app = new PaperApplication({ dataRoot: path.join(directory, 'private') }); await app.initialize(); await app.openProject({ root: source, mainFile: 'main.tex' });
  t.after(async () => { await app.close(); assert.ok(path.resolve(directory).startsWith(path.resolve(owned) + path.sep)); await rm(directory, { recursive: true, force: true }); });
  return { app, source, directory };
}
const sha = value => createHash('sha256').update(value).digest('hex');
const numericAux = String.raw`\relax
\newlabel{eq:main}{{4}{1}}
\bibcite{paper}{1}
\input{THIS_IS_INERT_DATA}
`;
async function buildFixture(f, { kind = 'baseline', snapshotId = f.app.core.getState().project.snapshotId, aux = numericAux, manifestChange = {} } = {}) {
  const compilerRoot = path.join(f.directory, 'compiler'), buildId = `build-${randomUUID()}`, job = path.join(compilerRoot, 'compiler/jobs', buildId), output = path.join(job, 'output'); await mkdir(output, { recursive: true });
  f.app.compiler = { dataRoot: compilerRoot };
  const pdfPath = path.join(output, 'paper.pdf'), bytes = Buffer.from('%PDF-synthetic-markdown-reference-fixture'); await writeFile(pdfPath, bytes);
  const files = [...f.app.core._files.values()].map(file => ({ path: file.path, bytes: file.bytes }));
  const build = { buildId, projectId: f.app.core.getState().project.id, snapshotId, engine: 'xelatex', kind, status: 'success', isolation: { verified: true }, pdfPath, pdfHash: sha(bytes), inputHash: buildInputHash({ engine: 'xelatex', mainFile: 'main.tex', files }), candidateHash: kind === 'candidate' ? 'c'.repeat(64) : null };
  const manifest = { ...build, inputFiles: files.map(file => ({ path: file.path, hash: sha(file.bytes) })), ...manifestChange }, manifestPath = path.join(job, 'build-manifest.json'); await writeFile(manifestPath, JSON.stringify(manifest));
  const auxPath = path.join(output, 'paper.aux'); if (aux !== null) await writeFile(auxPath, aux);
  f.app.flow.builds.push(build); f.app.flow.lastBaselineBuildId = build.buildId;
  return { build, output, auxPath, manifestPath, manifest, bytes };
}
test('Markdown context follows the source snapshot without mutating paper state or exposing mutable cache aliases', async t => {
  const { app, source } = await fixture(t), canonical = app.core.getState(), first = app.getState();
  assert.equal(first.markdownContext.macros['\\Ns'], 'N_s');
  first.markdownContext.macros['\\Ns'] = 'tampered'; assert.equal(app.getState().markdownContext.macros['\\Ns'], 'N_s');
  assert.deepEqual(app.core.getState(), canonical);
  await writeFile(path.join(source, 'main.tex'), String.raw`\documentclass{article}\newcommand{\Ns}{N_t}\begin{document}A new synthetic claim $\Ns$.\end{document}`);
  await app.refreshProject(); const next = app.getState(); assert.notEqual(next.markdownContext.contextKey, first.markdownContext.contextKey); assert.equal(next.markdownContext.macros['\\Ns'], 'N_t');
});
test('unsupported display context cannot prevent reading the paper or alter formal capabilities', async t => {
  const { app } = await fixture(t), before = app.core.getState();
  app.core._files.set('unavailable.tex', { path: 'unavailable.tex', bytes: null }); app._markdownContext = null;
  const value = app.getState(); assert.equal(value.project.id, before.project.id); assert.ok(value.markdownContext.diagnostics.some(item => item.code === 'MARKDOWN_CONTEXT_UNAVAILABLE'));
  assert.equal(value.capabilities.secureCompile, false); assert.deepEqual(app.core.getState(), before); assert.equal(app.jobs.size, 0);
});
test('reading a verified current PDF exposes only scalar auxiliary references and never changes formal state', async t => {
  const f = await fixture(t), built = await buildFixture(f), canonical = f.app.core.getState(), flow = structuredClone(f.app.flow), source = await readFile(path.join(f.source, 'main.tex')), previousKey = f.app.getState().markdownContext.contextKey;
  const pdf = await f.app.readPdf({ buildId: built.build.buildId }), first = f.app.getState().markdownContext;
  assert.equal(pdf.hash, built.build.pdfHash); assert.deepEqual(first.references, { labels: { 'eq:main': '4' }, citations: { paper: '1' } }); assert.notEqual(first.contextKey, previousKey);
  assert.equal(first.referenceProvenance.type, 'verified-build-output'); assert.equal(first.referenceProvenance.displayOnly, true); assert.equal(first.referenceProvenance.auxiliaryHashAttestedAtBuild, false); assert.equal(first.referenceProvenance.auxHash, sha(Buffer.from(numericAux))); assert.ok(!JSON.stringify(first).includes('THIS_IS_INERT_DATA'));
  first.references.citations.paper = 'tampered'; assert.equal(f.app.getState().markdownContext.references.citations.paper, '1');
  await f.app.readPdf({ buildId: built.build.buildId }); assert.equal(f.app.getState().markdownContext.contextKey, first.contextKey);
  assert.deepEqual(f.app.flow, flow); assert.deepEqual(f.app.core.getState(), canonical); assert.deepEqual(await readFile(path.join(f.source, 'main.tex')), source); assert.equal(f.app.jobs.size, 0);
});
test('changed or missing auxiliary metadata falls back to source labels while PDF reading remains available', async t => {
  const f = await fixture(t), built = await buildFixture(f); await f.app.readPdf({ buildId: built.build.buildId }); const before = f.app.getState().markdownContext.contextKey;
  await writeFile(built.auxPath, '\\bibcite{paper}{99}\n'); await f.app.readPdf({ buildId: built.build.buildId });
  const changed = f.app.getState().markdownContext; assert.deepEqual(changed.references, { labels: {}, citations: {} }); assert.ok(changed.diagnostics.some(item => item.code === 'REFERENCE_CONTEXT_CHANGED')); assert.notEqual(changed.contextKey, before);
  const missing = await buildFixture(f, { aux: null }); assert.equal((await f.app.readPdf({ buildId: missing.build.buildId })).hash, missing.build.pdfHash); assert.deepEqual(f.app.getState().markdownContext.references, { labels: {}, citations: {} }); assert.ok(f.app.getState().markdownContext.diagnostics.some(item => item.code === 'REFERENCE_CONTEXT_UNAVAILABLE'));
});
test('stale original snapshots and unpromoted candidate PDFs cannot replace current numeric references', async t => {
  const f = await fixture(t), current = await buildFixture(f); await f.app.readPdf({ buildId: current.build.buildId }); const key = f.app.getState().markdownContext.contextKey;
  for (const options of [{ snapshotId: 'snapshot-history' }, { kind: 'candidate' }]) { const ignored = await buildFixture(f, { ...options, aux: '\\bibcite{paper}{99}\n' }); await f.app.readPdf({ buildId: ignored.build.buildId }); assert.equal(f.app.getState().markdownContext.contextKey, key); assert.equal(f.app.getState().markdownContext.references.citations.paper, '1'); }
});
test('auxiliary references reject tampered manifests, oversized files and hardlink aliases', async t => {
  for (const mode of ['manifest', 'oversize', 'hardlink']) {
    const f = await fixture(t), built = await buildFixture(f);
    if (mode === 'manifest') await writeFile(built.manifestPath, JSON.stringify({ ...built.manifest, pdfHash: '0'.repeat(64) }));
    if (mode === 'oversize') await writeFile(built.auxPath, 'x'.repeat(1024 * 1024 + 1));
    if (mode === 'hardlink') { const target = path.join(f.directory, 'linked-aux.txt'); await writeFile(target, numericAux); await rm(built.auxPath); await link(target, built.auxPath); }
    assert.equal((await f.app.readPdf({ buildId: built.build.buildId })).hash, built.build.pdfHash);
    const context = f.app.getState().markdownContext; assert.deepEqual(context.references, { labels: {}, citations: {} }); assert.ok(context.diagnostics.some(item => item.code === (mode === 'manifest' ? 'REFERENCE_CONTEXT_UNVERIFIED' : 'REFERENCE_CONTEXT_UNSAFE'))); assert.equal(f.app.jobs.size, 0);
  }
});
test('an auxiliary path with a reparse ancestor cannot supply numeric references', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), built = await buildFixture(f), actual = path.join(path.dirname(built.output), 'real-output'); await rename(built.output, actual); await symlink(actual, built.output, 'junction');
  assert.equal((await f.app.readPdf({ buildId: built.build.buildId })).hash, built.build.pdfHash); const context = f.app.getState().markdownContext;
  assert.deepEqual(context.references, { labels: {}, citations: {} }); assert.ok(context.diagnostics.some(item => item.code === 'REFERENCE_CONTEXT_UNSAFE'));
});
