import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { prepareRangeFile, authorizeReadingRange, protectLiteralRange, maskRawReplacement } from '../src/range-authority.mjs';
import { restoreProtected, sha256 } from '../src/latex.mjs';
import { PaperApplication, buildInputHash } from '../src/application.mjs';

const preamble = String.raw`\documentclass{article}
\newcommand{\eng}{\noindent{\normalfont\sffamily\scriptsize\color{Muted}EN}\enspace\ignorespaces}
\newcommand{\chin}{\noindent{\normalfont\sffamily\scriptsize\color{Muted}中}\enspace\ignorespaces}
\newenvironment{pairedoriginal}[1]{\par\begingroup\color{#1}}{\par\endgroup\smallskip}
\newcommand{\bilingualheading}[2]{\par\textbf{#1 / #2}\par}
\newcommand{\proposalstart}[1]{\par Pending #1}
\newcommand{\reasonlabel}{Reason}
\newcommand{\proposalend}{Decision}
\begin{document}`;
const pair = (en, zh) => `\\begin{pairedoriginal}{Old}\n\\eng ${en}\\par\\chin ${zh}\n\\end{pairedoriginal}`;
const shims = String.raw`\providecommand \href [0]{\begingroup \@sanitize@url \@href}%
\providecommand \@href[1]{\@@startlink{#1}\@@href}%
\providecommand \@@href[1]{\endgroup#1\@@endlink}%
\providecommand \@sanitize@url [0]{\catcode ` + '`' + String.raw`\\12\catcode ` + '`' + String.raw`\$12\catcode ` + '`' + String.raw`\&12\catcode ` + '`' + String.raw`\#12\catcode ` + '`' + String.raw`\^12\catcode ` + '`' + String.raw`\_12\catcode ` + '`' + String.raw`\%12\relax}%
\providecommand \url [0]{\begingroup\@sanitize@url \@url }%
\providecommand \@url [1]{\endgroup\@href {#1}{\urlprefix }}%
\providecommand \BibitemShut [1]{\csname bibitem#1\endcsname}%`;
const prose = String.raw`A precise claim keeps $x_1=\{1,2\}$, \(y^2\), \[z=3\], \cite[see]{alpha,beta}, \ref{fig:one}, \textbf{nested {words}}, and \href{locked}{object} intact.`;
function complexSource({ lexical = '', includeShims = false, early = false } = {}) {
  return [preamble, early ? pair('An early original statement.', '最初中文陈述。') : '', String.raw`\def\unrelated{opaque}`, lexical,
    String.raw`\section{Methods / 方法}`, pair(prose, '原始中文意图。'),
    String.raw`\begin{theorem}`, pair('A later claim follows.', '后面的原始论述。'), String.raw`\end{theorem}`,
    String.raw`\begin{figure}\caption{An original caption $q=1$.\par\smallskip\textbf{中文图注：}原始图注。}\end{figure}`,
    String.raw`\proposalstart{1}`, pair('Pending replacement.', '待确认候选。'), String.raw`\reasonlabel \eng Pending reason.\par\chin 候选原因。`, String.raw`\proposalend`,
    includeShims ? shims : '', String.raw`\end{document}`].join('\r\n');
}
function capabilities(source) {
  const file = prepareRangeFile(source, 'main.tex');
  return { file, ranges: file.projection.paragraphs.map((range, index) => authorizeReadingRange(file, { ...range, path: 'main.tex', id: `read-${index}` }, 'snap-test')) };
}

test('literal authority covers original prose, heading and caption beyond an unrelated macro cutoff', () => {
  const source = complexSource(), { file, ranges } = capabilities(source);
  assert.equal(file.lexicalSafe, true); assert.equal(ranges.length, 4); assert.ok(ranges.every(Boolean));
  assert.deepEqual(ranges.map(range => range.kind).sort(), ['caption', 'heading', 'paragraph', 'paragraph']);
  assert.ok(ranges.every(range => !range.source.includes('Pending')));
  for (const range of ranges) assert.equal(restoreProtected(range, range.displayText), range.source);
});

test('standard grouped bibliography URL shims do not make unrelated original prose opaque', () => {
  const { file, ranges } = capabilities(complexSource({ includeShims: true }));
  assert.equal(file.lexicalSafe, true); assert.ok(ranges.every(Boolean));
});

test('direct lexical changes and modified bibliography shims remain outside range authority', () => {
  for (const lexical of [String.raw`\catcode 65=13`, String.raw`\csname dangerous\endcsname`, String.raw`\newcommand{\mutate}{\catcode 65=13}`, String.raw`\renewcommand{\textbf}[1]{\input{#1}}`, String.raw`\let\emph\input`, String.raw`\directlua{tex.catcode[65]=13}`, '^^5ccatcode65=13', shims.replace('\\endgroup#1', '\\endgroup#1\\catcode65=13'), shims.replace('\\href [0]', '\\href [1]')]) {
    const { file, ranges } = capabilities(complexSource({ lexical }));
    assert.equal(file.lexicalSafe, false); assert.ok(ranges.every(range => range === null));
  }
});

test('authority binds exact original range, file identity, source hash and current snapshot', () => {
  const { file, ranges } = capabilities(complexSource()), original = file.projection.paragraphs[1];
  for (const changed of [{ startByte: original.startByte + 1 }, { endByte: original.endByte - 1 }, { sourceHash: sha256('fake') }, { path: 'other.tex' }]) {
    assert.equal(authorizeReadingRange(file, { ...original, id: 'read-forged', path: 'main.tex', ...changed }, 'snap-test'), null);
  }
  assert.equal(ranges[1].sourceAuthority.snapshotId, 'snap-test');
  assert.equal(ranges[1].sourceAuthority.fileHash, sha256(complexSource()));
});

test('literal replacements cannot add TeX, alter or reorder protected math, citations or macros', () => {
  const range = { ...protectLiteralRange(prose, 'read-protection'), source: prose };
  assert.equal(restoreProtected(range, range.displayText.replace('precise', 'explicit')), prose.replace('precise', 'explicit'));
  for (const replacement of [prose + String.raw`\input{secret}`, prose + String.raw`\cite{new}`, prose.replace('$x_1=\\{1,2\\}$', '$x_1=9$'), prose.replace('\\cite[see]{alpha,beta}', '\\cite[see]{beta,alpha}'), prose.replace('\\href{locked}{object}', '\\href{changed}{object}'), prose + '{group}', prose + '% hide']) {
    assert.throws(() => maskRawReplacement(range, replacement), error => ['UNSUPPORTED_TEX', 'PROTECTED_TOKEN_CHANGED'].includes(error.code));
  }
  assert.equal(maskRawReplacement(range, prose.replace('precise', 'explicit')), range.displayText.replace('precise', 'explicit'));
});

test('formatting braces remain protected while their natural-language text can change', () => {
  const source = String.raw`An \emph{original \textbf{bold} phrase} and \textcolor{blue}{colored words}.`, range = protectLiteralRange(source, 'formatting');
  assert.ok(range.displayText.includes('original')); assert.ok(range.displayText.includes('colored words'));
  assert.equal(restoreProtected(range, range.displayText.replace('original', 'revised').replace('bold', 'clear').replace('colored words', 'new wording')), source.replace('original', 'revised').replace('bold', 'clear').replace('colored words', 'new wording'));
});

test('complete nested mathematical environments and unknown dynamic macro calls cannot expose editable mathematics', () => {
  const source = String.raw`The result \begin{align}x_1 &= 2 \\ \begin{split}y &=3\end{split}\end{align} is exact.`, range = protectLiteralRange(source, 'environment');
  assert.equal(range.protectedTokens.length, 1); assert.equal(range.protectedTokens[0].raw, source.slice(source.indexOf('\\begin'), source.indexOf(' is exact.')));
  assert.throws(() => maskRawReplacement(range, source.replace('x_1 &= 2', 'x_1 &= 9')), { code: 'PROTECTED_TOKEN_CHANGED' });
  for (const dynamic of [String.raw`An unknown \dynamic{argument} expands.`, String.raw`An unknown \dynamic unbracedargument expands.`, String.raw`An unclosed \begin{align}x=1.`, 'An incomplete control \\']) assert.throws(() => protectLiteralRange(dynamic, 'dynamic'), { code: 'UNSUPPORTED_TEX' });
});

async function fixture(t, options = {}) {
  const owned = fileURLToPath(new URL('../work/range-authority-tests/', import.meta.url)); await mkdir(owned, { recursive: true });
  const directory = await mkdtemp(path.join(owned, 'case-')), source = path.join(directory, 'source'); await mkdir(source);
  const before = Buffer.from(complexSource(options)), file = path.join(source, 'main.tex'); await writeFile(file, before);
  if (options.dependency) await writeFile(path.join(source, 'dependency.tex'), options.dependency);
  // Compiler I/O is synthetic here; compiler/OS isolation has its own integration tests.
  const compiler = { probe: async () => ({ available: true, isolated: true }), build: async input => {
    const pdfPath = path.join(directory, `build-${randomUUID()}.pdf`); await writeFile(pdfPath, '%PDF-synthetic-range-authority');
    return { buildId: `build-${randomUUID()}`, status: 'success', snapshotId: input.snapshotId, candidateHash: input.candidateHash, inputHash: buildInputHash(input), pdfPath, pdfHash: sha256(await readFile(pdfPath)), isolation: { verified: true } };
  } };
  const app = new PaperApplication({ dataRoot: path.join(directory, 'private'), compiler }); await app.initialize(); await app.openProject({ root: source, mainFile: 'main.tex' });
  t.after(async () => { await app.close(); await Promise.allSettled([...app.jobs.values()].map(item => item.promise)); await rm(directory, { recursive: true, force: true }); });
  return { app, file, before };
}

test('complex originals accept only registered protected candidates and revalidate before preview', async t => {
  const { app, file, before } = await fixture(t), paragraph = app.getState().readingParagraphs.find(item => item.source === prose);
  const request = await app.createRequest({ kind: 'revision', segmentIds: [paragraph.id] });
  const invalid = replacement => app.proposeRevision({ requestId: request.requestId, reason: 'Unsafe test.', edits: [{ segmentId: paragraph.id, beforeHash: paragraph.sourceHash, replacement }] });
  await assert.rejects(invalid(request.segments[0].text + String.raw`\cite{injected}`), { code: 'UNSUPPORTED_TEX' });
  const proposal = await app.proposeRevision({ requestId: request.requestId, reason: 'Clarify one word.', edits: [{ segmentId: paragraph.id, beforeHash: paragraph.sourceHash, replacement: request.segments[0].text.replace('precise', 'explicit') }] });
  assert.equal(proposal.edits[0].replacement, prose.replace('precise', 'explicit'));
  const human = await app.editProposal({ proposalId: proposal.proposalId, edits: [{ segmentId: paragraph.id, replacement: prose.replace('precise', 'explicitly supported') }] });
  assert.equal(human.edits[0].sourceAuthority.kind, 'literal-reading-v1');
  await app.core._serial(async () => { const state = app.core.getState(); state.proposals.find(item => item.proposalId === human.proposalId).edits[0].replacement += String.raw`\cite{injected}`; await app.core._commit(state); });
  await assert.rejects(app.previewTransaction({ proposalIds: [human.proposalId] }), { code: 'UNSUPPORTED_TEX' });
  assert.deepEqual(await readFile(file), before);
});

test('external source mutation prevents a late complex paragraph proposal', async t => {
  const { app, file, before } = await fixture(t), paragraph = app.getState().readingParagraphs[1];
  const request = await app.createRequest({ kind: 'revision', segmentIds: [paragraph.id] });
  await writeFile(file, Buffer.concat([before, Buffer.from('\r\n% external author change')]));
  await assert.rejects(app.proposeRevision({ requestId: request.requestId, reason: 'Late result.', edits: [{ segmentId: paragraph.id, beforeHash: paragraph.sourceHash, replacement: request.segments[0].text + ' revised' }] }), { code: 'VERSION_CONFLICT' });
  assert.equal(app.getState().proposals.length, 0);
});

test('lexical changes in an included input and unresolved dynamic dependencies cannot grant derived source authority', async t => {
  for (const options of [{ lexical: String.raw`\input{dependency}`, dependency: String.raw`\catcode 65=13` }, { lexical: String.raw`\input{\dynamic}` }]) await t.test('unsafe input', async subtest => {
    const { app } = await fixture(subtest, options), paragraph = app.getState().readingParagraphs.find(item => item.source === prose);
    assert.equal(paragraph.writableSource, false);
    await assert.rejects(app.createRequest({ kind: 'revision', segmentIds: [paragraph.id] }), { code: 'UNSUPPORTED_TEX' });
  });
});

test('multiple complex original edits compile, require confirmation, preserve immutable originals and undo byte-exactly', async t => {
  const { app, file, before } = await fixture(t), initial = app.getState(), paragraphs = initial.readingParagraphs;
  assert.ok(paragraphs.every(item => item.writableSource));
  for (const paragraph of paragraphs) {
    const draft = app.getState().translations['zh-CN'][paragraph.id];
    await app.saveDraft({ segmentId: paragraph.id, language: 'zh-CN', text: `修改后的中文意图 ${paragraph.id}。`, expectedRevision: draft?.revision || 0 });
  }
  const drafts = structuredClone(app.getState().translations['zh-CN']);
  const request = await app.createRequest({ kind: 'revision', segmentIds: paragraphs.map(item => item.id) });
  assert.ok(request.segments.every(item => item.translationDraft.text.includes('修改后的中文意图')));
  const proposal = await app.proposeRevision({ requestId: request.requestId, reason: 'Reflect the complete current Chinese intent.', edits: request.segments.map(item => ({ segmentId: item.id, beforeHash: item.beforeHash, replacement: item.text + ' Revised.' })) });
  const preview = await app.previewTransaction({ proposalIds: [proposal.proposalId] }); await app.waitJob({ jobId: preview.jobId });
  await assert.rejects(app.applyTransaction({ transactionId: preview.transactionId, confirmationToken: 'forged', idempotencyKey: 'no-confirm' }), { code: 'CONFIRMATION_INVALID' });
  assert.deepEqual(await readFile(file), before);
  const acceptance = await app.prepareAcceptance({ transactionId: preview.transactionId });
  await app.applyTransaction({ transactionId: preview.transactionId, confirmationToken: acceptance.confirmationToken, idempotencyKey: 'apply-complex' });
  const applied = app.getState(); assert.deepEqual(applied.readingParagraphs.map(item => item.id), paragraphs.map(item => item.id));
  for (const paragraph of paragraphs) {
    assert.deepEqual(applied.originals[paragraph.id], initial.originals[paragraph.id]);
    assert.equal(applied.translations['zh-CN'][paragraph.id].text, drafts[paragraph.id].text);
    assert.equal(applied.readingParagraphs.find(item => item.id === paragraph.id).source, paragraph.source + ' Revised.');
  }
  const undo = await app.createUndoProposal({ transactionId: preview.transactionId }), inverse = await app.previewTransaction({ proposalIds: [undo.proposalId] }); await app.waitJob({ jobId: inverse.jobId });
  const confirmed = await app.prepareAcceptance({ transactionId: inverse.transactionId }); await app.applyTransaction({ transactionId: inverse.transactionId, confirmationToken: confirmed.confirmationToken, idempotencyKey: 'undo-complex' });
  assert.deepEqual(await readFile(file), before);
  const restored = app.getState(); assert.deepEqual(restored.readingParagraphs.map(item => item.id), paragraphs.map(item => item.id));
  for (const paragraph of paragraphs) { assert.deepEqual(restored.originals[paragraph.id], initial.originals[paragraph.id]); assert.equal(restored.translations['zh-CN'][paragraph.id].text, drafts[paragraph.id].text); }
});

test('leading and trailing whitespace edits retain canonical and derived reading IDs, human drafts and baseline originals through undo', async t => {
  const { app, file, before } = await fixture(t, { early: true }), initial = app.getState(), paragraphs = initial.readingParagraphs;
  assert.ok(paragraphs.some(item => initial.segments.some(segment => segment.id === item.id)));
  assert.ok(paragraphs.some(item => !initial.segments.some(segment => segment.id === item.id)));
  for (const paragraph of paragraphs) {
    const revision = app.getState().translations['zh-CN'][paragraph.id]?.revision || 0;
    await app.saveDraft({ segmentId: paragraph.id, language: 'zh-CN', text: `保留最新中文意图 ${paragraph.id}。`, expectedRevision: revision });
  }
  const drafts = app.getState().translations['zh-CN'], request = await app.createRequest({ kind: 'revision', segmentIds: paragraphs.map(item => item.id) });
  const proposal = await app.proposeRevision({ requestId: request.requestId, reason: 'Whitespace identity regression.', edits: request.segments.map(item => ({ segmentId: item.id, beforeHash: item.beforeHash, replacement: ` \n${item.text.replace('An early original statement.', 'An early original statement.\n\nA continuation sentence.')} \n ` })) });
  const preview = await app.previewTransaction({ proposalIds: [proposal.proposalId] }); await app.waitJob({ jobId: preview.jobId });
  const confirmed = await app.prepareAcceptance({ transactionId: preview.transactionId }); await app.applyTransaction({ transactionId: preview.transactionId, confirmationToken: confirmed.confirmationToken, idempotencyKey: 'whitespace-apply' });
  for (const after of [app.getState()]) {
    assert.deepEqual(after.readingParagraphs.map(item => item.id), paragraphs.map(item => item.id));
    for (const paragraph of paragraphs) { assert.deepEqual(after.originals[paragraph.id], initial.originals[paragraph.id]); assert.equal(after.translations['zh-CN'][paragraph.id].text, drafts[paragraph.id].text); }
  }
  assert.ok(app.reading.hasDerived(paragraphs[0].id));
  const undo = await app.createUndoProposal({ transactionId: preview.transactionId }), inverse = await app.previewTransaction({ proposalIds: [undo.proposalId] }); await app.waitJob({ jobId: inverse.jobId });
  const acceptance = await app.prepareAcceptance({ transactionId: inverse.transactionId }); await app.applyTransaction({ transactionId: inverse.transactionId, confirmationToken: acceptance.confirmationToken, idempotencyKey: 'whitespace-undo' });
  assert.deepEqual(await readFile(file), before); assert.deepEqual(app.getState().readingParagraphs.map(item => item.id), paragraphs.map(item => item.id));
  for (const paragraph of paragraphs) { assert.deepEqual(app.getState().originals[paragraph.id], initial.originals[paragraph.id]); assert.equal(app.getState().translations['zh-CN'][paragraph.id].text, drafts[paragraph.id].text); }
});
