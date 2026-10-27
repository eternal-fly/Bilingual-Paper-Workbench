import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PaperService } from '../src/core.mjs';
import { CompilerWorker, inputHash } from '../src/compiler/worker.mjs';

const owned = fileURLToPath(new URL('../work/bibliography-project-tests/', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const live = process.env.PAPER_EDITOR_LIVE_COMPILER === '1';
const references = '@article{fixture,title={Immutable bibliography fixture}}\n';
const localStyle = String.raw`ENTRY { title } {} {}
FUNCTION {begin.bib} { "\begin{thebibliography}{1}" write$ newline$ }
FUNCTION {article} { "\bibitem{" write$ cite$ write$ "}" write$ newline$ title write$ "." write$ newline$ }
FUNCTION {end.bib} { "\end{thebibliography}" write$ newline$ }
READ
EXECUTE {begin.bib}
ITERATE {call.type$}
EXECUTE {end.bib}
`;
const source = style => String.raw`\documentclass[twocolumn]{article}
\begin{document}
\section{Original template}\label{sec:original}
Citation is \cite{fixture}. This remains section \ref{sec:original}.
\makeatletter
\@ifundefined{b@fixture}{\typeout{FIXTURE_CITATION_UNRESOLVED}}{\typeout{FIXTURE_CITATION_RESOLVED}}
\makeatother
\bibliographystyle{${style}}
\bibliography{references}
\end{document}
`;
async function fixture(t, style = 'styles/verified') {
  await mkdir(owned, { recursive: true }); const base = await mkdtemp(path.join(owned, 'case-')), root = path.join(base, 'source'), dataRoot = path.join(base, 'private');
  await mkdir(path.join(root, 'styles'), { recursive: true });
  await writeFile(path.join(root, 'main.tex'), source(style)); await writeFile(path.join(root, 'references.bib'), references);
  t.after(async () => { assert.ok(path.resolve(base).startsWith(path.resolve(owned) + path.sep)); await rm(base, { recursive: true, force: true }); });
  return { root, dataRoot, service: new PaperService({ dataRoot }) };
}

test('a project-local bibliography style enters the immutable source manifest and changing it invalidates the read set', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'styles/verified.bst'), localStyle);
  const state = await f.service.openProject({ root: f.root, mainFile: 'main.tex' });
  const style = state.project.files.find(file => file.path === 'styles/verified.bst'); assert.ok(style, 'The local style must be a project input, not an unchecked runtime lookup.'); assert.equal(style.hash, sha(localStyle));
  assert.deepEqual(state.project.files.map(file => file.path).sort(), ['main.tex', 'references.bib', 'styles/verified.bst']);
  await writeFile(path.join(f.root, 'styles/verified.bst'), localStyle + '\n% author changed the local style\n');
  await assert.rejects(f.service._assertSourceCurrent(), { code: 'VERSION_CONFLICT' });
  const refreshed = await f.service.refreshProject(); assert.notEqual(refreshed.project.snapshotId, state.project.snapshotId);
});

test('a distribution bibliography style remains a runtime dependency instead of a missing project input', async t => {
  const f = await fixture(t, 'plain'), state = await f.service.openProject({ root: f.root, mainFile: 'main.tex' });
  assert.ok(state.project.diagnostics.some(item => item.code === 'TOOLCHAIN_DEPENDENCY' && item.path === 'plain.bst'));
  assert.ok(!state.project.diagnostics.some(item => item.code === 'DEPENDENCY_MISSING' && item.path === 'plain.bst'));
  assert.ok(!state.project.files.some(file => file.path.endsWith('.bst')));
});

test('bibliography style traversal and dynamic names never expand beyond the authorized project', async t => {
  const f = await fixture(t, '../outside'); await assert.rejects(f.service.openProject({ root: f.root, mainFile: 'main.tex' }), { code: 'PERMISSION_DENIED' });
  await writeFile(path.join(f.root, 'main.tex'), source('\\dynamicStyle'));
  const state = await f.service.openProject({ root: f.root, mainFile: 'main.tex' }); assert.ok(state.project.diagnostics.some(item => item.code === 'UNSUPPORTED_TEX'));
  assert.ok(!state.project.files.some(file => file.path.endsWith('.bst')));
});

test('a project-local bibliography style cannot enter through a directory alias', async t => {
  const f = await fixture(t, 'linked/verified'), outside = path.join(f.dataRoot, 'outside'); await mkdir(outside, { recursive: true }); await writeFile(path.join(outside, 'verified.bst'), localStyle);
  try { await symlink(outside, path.join(f.root, 'linked'), 'junction'); } catch (error) { if (error.code === 'EPERM') return t.skip('The OS denied the synthetic test junction.'); throw error; }
  await assert.rejects(f.service.openProject({ root: f.root, mainFile: 'main.tex' }), { code: 'PERMISSION_DENIED' });
});

test('isolated distribution BibTeX compilation performs a bounded third TeX pass that resolves current bibliography citations', { skip: !live }, async t => {
  const f = await fixture(t, 'plain'), files = [{ path: 'main.tex', bytes: Buffer.from(source('plain')) }, { path: 'references.bib', bytes: Buffer.from(references) }];
  const worker = new CompilerWorker({ dataRoot: f.dataRoot }), result = await worker.build({ projectId: 'synthetic-bibliography', snapshotId: 'distribution-style', engine: 'xelatex', mainFile: 'main.tex', files });
  assert.equal(result.status, 'success', JSON.stringify(result.diagnostics));
  assert.deepEqual(result.isolation.processes.map(item => item.program), ['xelatex', 'bibtex', 'xelatex', 'xelatex', 'xdvipdfmx']);
  const log = await readFile(path.join(path.dirname(result.pdfPath), 'paper.log'), 'utf8'); assert.match(log, /FIXTURE_CITATION_RESOLVED/); assert.doesNotMatch(log, /FIXTURE_CITATION_UNRESOLVED|Citation [`'][^\n]*undefined|There were undefined (?:references|citations)/);
  assert.equal(result.inputHash, inputHash({ engine: 'xelatex', mainFile: 'main.tex', files })); assert.equal(result.isolation.verified, true);
});

test('isolated BibTeX reads a hashed project-local style without changing the original two-column source or any input', { skip: !live }, async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'styles/verified.bst'), localStyle);
  const state = await f.service.openProject({ root: f.root, mainFile: 'main.tex' }), files = await Promise.all(state.project.files.map(async file => ({ path: file.path, bytes: await readFile(path.join(f.root, file.path)) })));
  assert.ok(files.some(file => file.path === 'styles/verified.bst'));
  const worker = new CompilerWorker({ dataRoot: f.dataRoot }), result = await worker.build({ projectId: state.project.id, snapshotId: state.project.snapshotId, engine: 'pdflatex', mainFile: 'main.tex', files });
  assert.equal(result.status, 'success', JSON.stringify(result.diagnostics)); assert.equal(result.isolation.verified, true);
  assert.deepEqual(result.isolation.processes.map(item => item.program), ['pdflatex', 'bibtex', 'pdflatex', 'pdflatex']);
  const manifest = JSON.parse(await readFile(path.join(path.dirname(path.dirname(result.pdfPath)), 'build-manifest.json'), 'utf8'));
  assert.ok(manifest.inputFiles.some(file => file.path === 'styles/verified.bst' && file.hash === sha(localStyle)));
  assert.equal(result.inputHash, inputHash({ engine: 'pdflatex', mainFile: 'main.tex', files }));
  const output = path.dirname(result.pdfPath), finalLog = await readFile(path.join(output, 'paper.log'), 'utf8'); assert.match(finalLog, /FIXTURE_CITATION_RESOLVED/); assert.doesNotMatch(finalLog, /FIXTURE_CITATION_UNRESOLVED|There were undefined (?:references|citations)/);
  assert.match(await readFile(path.join(output, 'paper.bbl'), 'utf8'), /Immutable bibliography fixture/);
  for (const file of files) assert.deepEqual(await readFile(path.join(f.root, file.path)), file.bytes);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs'); const loading = getDocument({ data: new Uint8Array(await readFile(result.pdfPath)), isEvalSupported: false, useSystemFonts: false, disableFontFace: true });
  try { const pdf = await loading.promise, text = (await (await pdf.getPage(1)).getTextContent()).items.map(item => item.str || '').join(' '); assert.match(text, /Citation is \[1\]/); assert.match(text, /Immutable bibliography fixture/); assert.doesNotMatch(text, /Citation is \[\?\]/); } finally { await loading.destroy(); }
});

test('isolated BibTeX can read a bibliography generated by TeX only inside its owned output directory', { skip: !live }, async t => {
  const f = await fixture(t, 'plain');
  const generated = source('plain').replace('\\begin{document}', String.raw`\begin{document}
\newwrite\generatedbib
\immediate\openout\generatedbib=paperNotes.bib
\immediate\write\generatedbib{@misc{generated,title={Generated synthetic note},year={2026}}}
\immediate\closeout\generatedbib
\nocite{generated}
`).replace('\\bibliography{references}', '\\bibliography{paperNotes,references}');
  const files = [{ path: 'main.tex', bytes: Buffer.from(generated) }, { path: 'references.bib', bytes: Buffer.from(references) }], worker = new CompilerWorker({ dataRoot: f.dataRoot });
  const result = await worker.build({ projectId: 'synthetic-generated-bibliography', snapshotId: 'output-notes', engine: 'pdflatex', mainFile: 'main.tex', files });
  if (result.status !== 'success') assert.fail(JSON.stringify({ diagnostics: result.diagnostics, log: (await readFile(result.logPath, 'utf8')).slice(-4000) }));
  assert.equal(result.status, 'success', JSON.stringify(result.diagnostics)); assert.equal(result.isolation.verified, true);
  const output = path.dirname(result.pdfPath); assert.match(await readFile(path.join(output, 'paper.bbl'), 'utf8'), /Generated synthetic note/); assert.match(await readFile(path.join(output, 'paper.log'), 'utf8'), /FIXTURE_CITATION_RESOLVED/);
  assert.equal(result.inputHash, inputHash({ engine: 'pdflatex', mainFile: 'main.tex', files }));
});

test('the isolated pdfTeX compatibility startup preserves original source bytes and SyncTeX with a safe relative spaced main filename', { skip: !live }, async t => {
  const f = await fixture(t, 'plain'), mainFile = 'sections/main paper.tex';
  const original = Buffer.from(source('plain').replace('\\begin{document}', '\\begin{document}\n\\typeout{PROFILE_OBJECT_STREAMS=\\the\\pdfobjcompresslevel}'));
  const files = [{ path: mainFile, bytes: original }, { path: 'references.bib', bytes: Buffer.from(references) }], worker = new CompilerWorker({ dataRoot: f.dataRoot });
  const result = await worker.build({ projectId: 'synthetic-pdftex-profile', snapshotId: 'original-source-profile', engine: 'pdflatex', mainFile, files });
  assert.equal(result.status, 'success', JSON.stringify(result.diagnostics)); assert.equal(result.compilerProfile, 'pdftex-no-object-streams-v1');
  const output = path.dirname(result.pdfPath), job = path.dirname(output), finalLog = await readFile(path.join(output, 'paper.log'), 'utf8');
  assert.match(finalLog, /PROFILE_OBJECT_STREAMS=0/); assert.doesNotMatch(finalLog, /PROFILE_OBJECT_STREAMS=[1-9]/); assert.ok(result.synctexPath);
  assert.deepEqual(await readFile(path.join(job, 'input', mainFile)), original);
  const manifest = JSON.parse(await readFile(path.join(job, 'build-manifest.json'), 'utf8')); assert.equal(manifest.compilerProfile, result.compilerProfile); assert.ok(manifest.inputFiles.some(file => file.path === mainFile && file.hash === sha(original)));
  assert.equal(result.inputHash, inputHash({ engine: 'pdflatex', mainFile, files }));
  const forward = await worker.locate({ build: result, sourcePath: mainFile, line: 5 }); assert.equal(forward.verified, true); assert.ok(forward.matches.length);
  const point = forward.matches[0], inverse = await worker.inverse({ build: result, page: point.page, x: point.x, y: point.y }); assert.ok(inverse.matches.some(item => item.sourcePath === mainFile && item.line === 5));
});
