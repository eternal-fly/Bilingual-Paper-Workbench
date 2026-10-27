import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaperApplication, buildInputHash } from '../src/application.mjs';
import { VersionWorkflow } from '../src/version-workflow.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, { bilingual = false } = {}) {
  const owned = fileURLToPath(new URL('../work/applied-pdf-tests/', import.meta.url)); await mkdir(owned, { recursive: true });
  const root = await mkdtemp(path.join(owned, 'case-')); let failEnglish = false;
  t.after(async () => { await app.close(); while (app.versionPair?.pending || app.versionPair?.scheduled) { if (app.versionPair.pending) await app.versionPair.pending.catch(() => {}); else await new Promise(resolve => setImmediate(resolve)); } await rm(root, { recursive: true, force: true }); });
  const source = path.join(root, 'source'); await mkdir(source);
  const body = bilingual ? String.raw`\newcommand{\eng}{\noindent{\normalfont\sffamily\scriptsize\color{Muted}EN}\enspace\ignorespaces}
\newcommand{\chin}{\noindent{\normalfont\sffamily\scriptsize\color{Muted}中}\enspace\ignorespaces}
\newenvironment{pairedoriginal}[1]{\par\begingroup\color{#1}}{\par\endgroup\smallskip}
\begin{document}
\begin{pairedoriginal}{black}
\eng A clear claim.\par\chin 原译文。
\end{pairedoriginal}` : String.raw`\begin{document}

A clear claim.`;
  const before = `\\documentclass{article}\n${body}\n\n\\end{document}\n`; await writeFile(path.join(source, 'main.tex'), before);
  const calls = [], compiler = { probe: async () => ({ available: true, isolated: true }), build: async input => {
    calls.push(input); const bytes = Buffer.from(`%PDF-1.7\n% synthetic ${hash(input.files[0].bytes)}\n%%EOF\n`), pdfPath = path.join(root, `${randomUUID()}.pdf`); await writeFile(pdfPath, bytes);
    return { buildId: `build-${randomUUID()}`, projectId: input.projectId, status: failEnglish && !input.candidateHash ? 'failed' : 'success', snapshotId: input.snapshotId, candidateHash: input.candidateHash, inputHash: buildInputHash(input), pdfPath, pdfHash: hash(bytes), isolation: { verified: true } };
  } };
  const app = new PaperApplication({ dataRoot: path.join(root, 'private'), compiler }); await app.initialize(); await app.openProject({ root: source, mainFile: 'main.tex' });
  app.versionPair = new VersionWorkflow(app, { contextDir: path.join(root, 'context') });
  const baseline = await app.compileEnglish(); await app.waitJob(baseline); const original = await app.readVersionPair();
  const segment = app.getState().readingParagraphs.find(p => p.source.includes('A clear claim.')); assert(segment?.writableSource);
  const request = await app.createRequest({ kind: 'revision', language: 'zh-CN', segmentIds: [segment.id] });
  const selected = request.segments[0], proposal = await app.proposeRevision({ requestId: request.requestId, edits: [{ segmentId: segment.id, beforeHash: selected.beforeHash, replacement: selected.text.replace('clear', 'precise') }], reason: 'Synthetic author revision.' });
  const preview = await app.previewTransaction({ proposalIds: [proposal.proposalId] }); await app.waitJob(preview);
  const accept = async () => { const acceptance = await app.prepareAcceptance(preview); return app.applyTransaction({ transactionId: preview.transactionId, confirmationToken: acceptance.confirmationToken, idempotencyKey: 'author-confirmed' }); };
  return { app, source, before, original, preview, calls, accept, setFailEnglish: value => { failEnglish = value; } };
}

test('a confirmed exact English candidate becomes latest without recompiling, while pending compilation never replaces the original/latest pair', async t => {
  const f = await fixture(t), pending = await f.app.readVersionPair();
  assert.equal(pending.latest.hash, f.original.latest.hash); assert.equal(pending.original.hash, f.original.original.hash);
  const result = await f.accept(), pair = await f.app.readVersionPair(), candidate = f.app.getState().builds.find(b => b.buildId === result.buildId);
  assert.equal(pair.latest.buildId, result.buildId); assert.equal(pair.latest.snapshotId, result.snapshotId); assert.equal(pair.latest.candidateHash, candidate.candidateHash);
  assert.notEqual(pair.latest.hash, f.original.latest.hash); assert.deepEqual(pair.original, f.original.original);
  assert.equal(f.app.flow.lastEnglishBuildId, result.buildId); assert.equal((await f.app.readPdf()).buildId, result.buildId); assert.equal(f.calls.length, 2);
  const inverse = await f.app.createUndoProposal({ transactionId: result.transactionId }), undo = await f.app.previewTransaction({ proposalIds: [inverse.proposalId] }); await f.app.waitJob(undo);
  const acceptance = await f.app.prepareAcceptance(undo); const undone = await f.app.applyTransaction({ transactionId: undo.transactionId, confirmationToken: acceptance.confirmationToken, idempotencyKey: 'author-undo' });
  const restored = await f.app.readVersionPair(); assert.equal(restored.latest.buildId, undone.buildId); assert.equal(restored.latest.hash, f.original.latest.hash); assert.deepEqual(restored.original, f.original.original); assert.equal(await readFile(path.join(f.source, 'main.tex'), 'utf8'), f.before);
});

test('confirmation schedules current pair refresh for native callers as well as UI callers', async t => {
  const f = await fixture(t); let scheduled = 0; const schedule = f.app.versionPair.schedule.bind(f.app.versionPair); f.app.versionPair.schedule = () => { scheduled++; return schedule(); };
  await f.accept(); assert(scheduled > 0, 'source confirmation must schedule the latest-PDF publication');
});

test('a bilingual source candidate is not mislabeled English and queues a projected English build after source confirmation', async t => {
  const f = await fixture(t, { bilingual: true }); const result = await f.accept();
  assert(result.englishPdfJobId, 'a changed English projection needs a separate verified build'); await f.app.waitJob({ jobId: result.englishPdfJobId });
  const pair = await f.app.readVersionPair(); assert.notEqual(pair.latest.buildId, result.buildId); assert.equal(pair.latest.snapshotId, result.snapshotId); assert.equal(pair.original.hash, f.original.original.hash);
  const latest = f.app.getState().builds.find(b => b.buildId === pair.latest.buildId); assert.equal(latest.kind, 'english'); assert.equal(f.calls.length, 3); assert(!f.calls.at(-1).files[0].bytes.toString().includes('原译文'));
});

test('failed projected English regeneration preserves the frozen/current pair without undoing a successful author-confirmed source write', async t => {
  const f = await fixture(t, { bilingual: true }); f.setFailEnglish(true); const result = await f.accept();
  assert.equal(result.state, 'applied'); assert(result.englishPdfJobId); const build = await f.app.waitJob({ jobId: result.englishPdfJobId }); assert.equal(build.status, 'failed');
  assert.match(await readFile(path.join(f.source, 'main.tex'), 'utf8'), /precise claim/); assert.equal(f.app.versionPair.current.original.hash, f.original.original.hash); assert.equal(f.app.versionPair.current.latest.hash, f.original.latest.hash); assert.equal(f.app.versionPair.state().available, false);
  await assert.rejects(f.app.readVersionPair(), { code: 'VERSION_PAIR_COMPILE_REQUIRED' });
});

test('recovering a proven completed source write refreshes latest through the same post-transaction English publication path', async t => {
  for (const bilingual of [false, true]) {
    const f = await fixture(t, { bilingual }), write = f.app.writer.write.bind(f.app.writer);
    f.app.writer.write = async (...args) => { await write(...args); throw Object.assign(new Error('Synthetic loss after durable source write.'), { code: 'SYNTHETIC_IO' }); };
    await assert.rejects(f.accept(), { code: 'SYNTHETIC_IO' }); f.app.writer.write = write;
    const result = await f.app.recoverTransactions(); assert.equal(result.recovered.length, 1);
    if (bilingual) { assert(result.englishPdfJobId); await f.app.waitJob({ jobId: result.englishPdfJobId }); }
    const pair = await f.app.readVersionPair(); assert.notEqual(pair.latest.hash, f.original.latest.hash); assert.deepEqual(pair.original, f.original.original); assert.equal(pair.latest.snapshotId, f.app.getState().project.snapshotId);
  }
});
