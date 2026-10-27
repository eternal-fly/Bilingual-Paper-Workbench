import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { deriveEnglishView } from '../src/english-view.mjs';
import { protectEnglishReading, readEnglishSourceParagraphs } from '../src/english-source-paragraphs.mjs';
import { restoreProtected, sha256, extractSegments } from '../src/latex.mjs';
import { PaperApplication } from '../src/application.mjs';
import { prepareRangeFile, authorizeReadingRange } from '../src/range-authority.mjs';

const source = String.raw`\documentclass[aps,prl,reprint]{revtex4-2}
\newcommand{\prlheading}[1]{\par\indent\textit{#1}---\ignorespaces}
\newtheorem{theorem}{Theorem}
\newtheorem{lemma}{Lemma}
\begin{document}
\title{Synthetic original-format paper}
\author{Untranslated Person}
\begin{abstract}
A concise abstract with $x=1$ and \cite{alpha}.
\end{abstract}
\maketitle
\prlheading{A compact introduction}
The first complete paragraph contains a displayed relation
\begin{equation}
u = v +

w.
\end{equation}
The equation and both sentences remain one exact paragraph.

\begin{theorem}[A named statement]
Every synthetic object satisfies $f(x)\leq 1$.

The second statement paragraph cites \ref{eq:synthetic}.
\end{theorem}
\begin{proof}
Use the first assumption. The proof protects \cite{alpha,beta}.

\begin{align}
f(x)&=x,\\
g(x)&=1.
\end{align}

This completes the argument.
\end{proof}
\begin{itemize}
\item First list item.
\item[$\star$] Second list item.
\end{itemize}
\begin{figure}
\includegraphics{figure.pdf}
\caption{A clear caption with $z=2$.}
\label{fig:synthetic}
\end{figure}
\begin{table}
\begin{tabular}{cc}
DO NOT TRANSLATE CELLS & 123\\
\end{tabular}
\caption{The table caption remains readable.}
\end{table}
\appendix
\section{Further arguments}
\let\metadataAlias\relax
Later prose remains readable despite a canonical lexical cutoff.
\bibliographystyle{apsrev4-2}
\bibliography{references}
\end{document}
Forbidden text outside the document body.
`;

test('ordinary English keeps every original template byte while projecting complete prose, heading, caption and math ranges', () => {
  const view = deriveEnglishView(source, 'main.tex'); assert.equal(view.supported, true); assert.equal(view.changed, false); assert.equal(view.text, source); assert.equal(view.text.split('\n').length, source.split('\n').length);
  assert.ok(view.paragraphs.length >= 15); assert.ok(view.paragraphs.every(paragraph => paragraph.confidence === 'literalEnglishStructure'));
  for (const paragraph of view.paragraphs) { assert.equal(Buffer.from(source).subarray(paragraph.startByte, paragraph.endByte).toString('utf8'), paragraph.source); assert.equal(paragraph.sourceHash, sha256(paragraph.source)); }
  assert.ok(view.paragraphs.some(paragraph => paragraph.kind === 'heading' && paragraph.source === 'A compact introduction')); assert.ok(view.paragraphs.some(paragraph => paragraph.kind === 'title'));
  assert.ok(view.paragraphs.some(paragraph => paragraph.kind === 'math')); assert.ok(view.paragraphs.filter(paragraph => paragraph.kind === 'caption').length === 2);
  assert.ok(!view.paragraphs.some(paragraph => /DO NOT TRANSLATE CELLS|Forbidden text|Untranslated Person|bibliographystyle/.test(paragraph.source)));
});

test('blank lines inside balanced mathematics never split protected environments or adjacent complete paragraph prose', () => {
  const view = readEnglishSourceParagraphs(source, 'main.tex'), first = view.paragraphs.find(paragraph => paragraph.source.startsWith('The first complete'));
  assert.ok(first.source.includes('\\begin{equation}')); assert.ok(first.source.endsWith('one exact paragraph.')); assert.equal((first.source.match(/\\begin\{equation\}/g) || []).length, 1);
  const masked = protectEnglishReading(first.source, first.id); assert.equal(masked.requestable, true); assert.equal(restoreProtected(masked, masked.displayText), first.source); assert.ok(masked.protectedTokens.some(token => token.raw.startsWith('\\begin{equation}') && token.raw.endsWith('\\end{equation}')));
  for (const paragraph of view.paragraphs) { const protectedRange = protectEnglishReading(paragraph.source, paragraph.id); assert.equal(protectedRange.requestable, true); assert.equal(restoreProtected(protectedRange, protectedRange.displayText), paragraph.source); }
});

test('read-only protection locks unknown macro arguments, references, inline math and structure instead of exposing TeX fragments', () => {
  const text = String.raw`Surrounding prose \unknown{opaque {nested} content} remains with \cite[see]{key}, $x_{i}$ and \textbf{readable words}.`, masked = protectEnglishReading(text, 'reading-synthetic');
  assert.equal(masked.requestable, true); assert.ok(masked.protectedTokens.some(token => token.raw === String.raw`\unknown{opaque {nested} content}`)); assert.ok(masked.protectedTokens.some(token => token.raw === String.raw`\cite[see]{key}`)); assert.ok(masked.displayText.includes('readable words')); assert.equal(restoreProtected(masked, masked.displayText), text);
  assert.throws(() => restoreProtected(masked, masked.displayText.replace(masked.protectedTokens[0].id, '')), { code: 'PROTECTED_TOKEN_CHANGED' });
});

test('UTF-8, CRLF, comments and child fragments retain exact literal ranges and stable metadata IDs', () => {
  const text = '\\section{A café heading}\r\n\r\nA café paragraph with \\emph{meaning}.\r\n% a protected comment\r\nContinued prose.\r\n';
  const first = readEnglishSourceParagraphs(text, 'sections/body.tex'), second = readEnglishSourceParagraphs(text, 'sections/body.tex'); assert.deepEqual(first, second); assert.equal(first.paragraphs.length, 2);
  for (const paragraph of first.paragraphs) { assert.equal(Buffer.from(text).subarray(paragraph.startByte, paragraph.endByte).toString(), paragraph.source); assert.equal(restoreProtected(protectEnglishReading(paragraph.source, paragraph.id), protectEnglishReading(paragraph.source, paragraph.id).displayText), paragraph.source); }
  const list = readEnglishSourceParagraphs(String.raw`\begin{itemize}\item {A grouped list paragraph.}\item[Named] Another item.\end{itemize}`, 'list.tex'); assert.ok(list.paragraphs.some(paragraph => paragraph.source.includes('A grouped list paragraph.')));
});

test('unknown environments remain explicit opaque reading objects and unsupported syntax never acquires source authority', () => {
  const text = String.raw`\documentclass{article}
\begin{document}
Before an opaque block.
\begin{unknownBox}
Opaque words with \unknown{parameter}.
\end{unknownBox}
After the opaque block.
\end{document}`;
  const view = readEnglishSourceParagraphs(text, 'main.tex'), opaque = view.paragraphs.find(paragraph => paragraph.kind === 'opaque'); assert.ok(opaque); assert.equal(opaque.sourceCandidateEligible, false); assert.ok(view.diagnostics.some(diagnostic => diagnostic.code === 'ENGLISH_OPAQUE_ENVIRONMENT'));
  const masked = protectEnglishReading(opaque.source, opaque.id); assert.equal(masked.protectedTokens.length, 1); assert.equal(masked.requestable, true); assert.equal(restoreProtected(masked, masked.displayText), opaque.source);
  assert.equal(authorizeReadingRange(prepareRangeFile(text, 'main.tex', deriveEnglishView(text, 'main.tex')), opaque, 'test-snapshot'), null, 'An explicitly read-only structural interval cannot acquire authority through the independent validator.');
});

test('a standalone static font heading exposes only its natural text without relaxing unknown layout-control write protection', async t => {
  const text = String.raw`\documentclass{article}
\begin{document}
{\large\bfseries Supplementary synthetic derivation\par\medskip}

The associated paragraph is unchanged.
\end{document}`, f = await appFixture(t, text), heading = f.app.getState().readingParagraphs.find(paragraph => paragraph.kind === 'heading'); assert.equal(heading.source, 'Supplementary synthetic derivation'); assert.equal(heading.writableSource, true); assert.ok(!heading.source.includes('medskip')); assert.equal(await readFile(f.filename, 'utf8'), text);
  const externalTail = deriveEnglishView(text.replace('derivation\\par\\medskip}', 'derivation}\\par\\medskip'), 'main.tex'); assert.ok(externalTail.paragraphs.some(paragraph => paragraph.kind === 'heading' && paragraph.source === 'Supplementary synthetic derivation'));
});

test('source redefinitions and malformed environments never turn ambiguous heading or container prose into independently writable ranges', async t => {
  const text = String.raw`\documentclass{article}
\renewcommand{\section}[1]{\input{#1}}
\renewenvironment{proof}{\unknownprefix}{}
\begin{document}
\section{Not a writable file argument}
\begin{proof}
Read this proof as source evidence only.
\end{proof}
\end{document}`, f = await appFixture(t, text), rows = f.app.getState().readingParagraphs; assert.ok(rows.length >= 2); assert.ok(rows.every(row => row.writableSource === false)); assert.ok(rows.every(row => row.requestable)); assert.ok(rows.every(row => row.sourceDiagnostics.length));
  const broken = readEnglishSourceParagraphs('\\begin{document}\n\\section{Readable heading}\n\\begin{proof}\nUnclosed proof.', 'broken.tex'); assert.ok(broken.diagnostics.some(item => item.code === 'ENGLISH_STRUCTURE_UNBALANCED')); assert.ok(broken.paragraphs.every(row => row.sourceCandidateEligible === false));
  const deferred = readEnglishSourceParagraphs(text.replace('\\renewcommand{\\section}[1]{\\input{#1}}', '\\newcommand{\\deferred}{\\let\\section\\input}'), 'deferred.tex'); assert.ok(deferred.paragraphs.filter(row => row.kind === 'heading').every(row => row.sourceCandidateEligible === false));
  const alteredMacro = readEnglishSourceParagraphs(String.raw`\newcommand{\prlheading}[1]{\par\textit{#1}}
\RenewDocumentCommand\prlheading{m}{\input{#1}}
\begin{document}\prlheading{An opaque custom heading}\end{document}`, 'altered.tex'); assert.ok(!alteredMacro.paragraphs.some(row => row.kind === 'heading')); assert.ok(alteredMacro.paragraphs.some(row => row.kind === 'opaque' && row.source.includes('An opaque custom heading')));
});

async function appFixture(t, text = source) {
  const owned = fileURLToPath(new URL('../work/english-source-paragraph-tests/', import.meta.url)); await mkdir(owned, { recursive: true }); const directory = await mkdtemp(path.join(owned, 'case-')), project = path.join(directory, 'source'); await mkdir(project); const filename = path.join(project, 'main.tex'); await writeFile(filename, text);
  const app = new PaperApplication({ dataRoot: path.join(directory, 'private') }); await app.openProject({ root: project, mainFile: 'main.tex' }); t.after(async () => { await app.close(); assert.ok(path.resolve(directory).startsWith(path.resolve(owned) + path.sep)); await rm(directory, { recursive: true, force: true }); }); return { app, filename, text };
}
test('the whole original-format source exposes protected translation requests and independently verified prose candidates beyond canonical opacity', async t => {
  const f = await appFixture(t), state = f.app.getState(), canonicalWritable = state.segments.filter(segment => segment.translatable).length; assert.ok(state.readingParagraphs.length > canonicalWritable);
  assert.ok(state.readingParagraphs.every(paragraph => paragraph.requestable)); const after = state.readingParagraphs.find(paragraph => paragraph.source.startsWith('Later prose')); assert.ok(after); assert.equal(after.writableSource, true);
  const theorem = state.readingParagraphs.find(paragraph => paragraph.source.startsWith('Every synthetic')); assert.ok(theorem); assert.equal(theorem.writableSource, true);
  const request = await f.app.createRequest({ kind: 'translation', segmentIds: [theorem.id, after.id], language: 'zh-CN' }); assert.equal(request.segments.length, 2);
  const returned = request.segments.map(segment => ({ segmentId: segment.segmentId, text: segment.text.replace('Every synthetic object satisfies', '每个合成对象满足').replace('Later prose remains readable despite a canonical lexical cutoff.', '后续文字保持可读。') })); await f.app.submitTranslationResult({ requestId: request.requestId, translations: returned });
  assert.equal(f.app.getState().requests.find(item => item.requestId === request.requestId).status, 'completed'); assert.equal(await readFile(f.filename, 'utf8'), f.text);
});

test('real lexical changes keep translation reading available but deny all independently generated source candidates', async t => {
  const text = String.raw`\documentclass{article}
\catcode\%=12
\begin{document}
An unknown \custom{locked argument} and $x=1$ stay readable.

A later ordinary sentence remains readable too.
\end{document}`, f = await appFixture(t, text), state = f.app.getState(); assert.ok(state.readingParagraphs.length >= 2); assert.ok(state.readingParagraphs.every(paragraph => paragraph.requestable)); assert.ok(state.readingParagraphs.every(paragraph => paragraph.writableSource === false));
  const request = await f.app.createRequest({ kind: 'translation', segmentIds: [state.readingParagraphs[0].id] }); assert.equal(request.segments.length, 1); await assert.rejects(f.app.createRequest({ kind: 'revision', segmentIds: [state.readingParagraphs[0].id] }), { code: 'UNSUPPORTED_TEX' });
});
