import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveEnglishView } from '../src/english-view.mjs';
import { CompilerWorker } from '../src/compiler/worker.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const preamble = String.raw`\documentclass{article}
\newcommand{\eng}{\noindent{\normalfont\sffamily\scriptsize\color{Muted}EN}\enspace\ignorespaces}
\newcommand{\chin}{\noindent{\normalfont\sffamily\scriptsize\color{Muted}中}\enspace\ignorespaces}
\newenvironment{pairedoriginal}[1]{\par\begingroup\color{#1}}{\par\endgroup\smallskip}
\newcommand{\bilingualheading}[2]{\par\textbf{#1 / #2}\par}
\newcommand{\changeheading}[3]{\textbf{#1 #2}#3}
\newcommand{\proposalstart}[1]{\par Pending #1}
\newcommand{\reasonlabel}{Reason}
\newcommand{\proposalend}{Decision}
\begin{document}`;
const pair = (en, zh, color = 'black') => `\\begin{pairedoriginal}{${color}}\n\\eng\n${en}\\par\\chin\n${zh}\n\\end{pairedoriginal}`;

test('identity projection leaves ordinary English source and all line coordinates unchanged', () => {
  const source = String.raw`\documentclass{article}
\begin{document}
Original $x_1$ with \cite{safe}.
\end{document}`;
  const result = deriveEnglishView(source, 'main.tex');
  assert.equal(result.supported, true);
  assert.equal(result.changed, false);
  assert.equal(result.text, source);
  assert.equal(result.paragraphs.length, 1);
  assert.equal(result.paragraphs[0].source, 'Original $x_1$ with \\cite{safe}.');
  assert.deepEqual(result.lineMap.map(line => [line.originalLine, line.derivedLine, line.retained]), [[1,1,true],[2,2,true],[3,3,true],[4,4,true]]);
});

test('original English survives while companions and entire pending review blocks are omitted', () => {
  const original = String.raw`Original with $x_{i}$, \cite{ref} and \label{p:a}.`;
  const source = [preamble, String.raw`\begin{titlepage}Review cover 审阅封面\end{titlepage}`,
    String.raw`\bilingualheading{Introduction}{引言}`, String.raw`\changeheading{A01}{中文意见}{English review note}`,
    pair(original, '原文中文。', 'Old'), String.raw`\proposalstart{A01}`,
    String.raw`{\color{New}\eng Pending replacement.\par\chin 待确认译文。\par}`,
    String.raw`\reasonlabel \eng Pending reason.\par\chin 修改理由。`, String.raw`\proposalend`,
    String.raw`\begin{equation}\label{e:kept} x_i = \frac{1}{2}\end{equation}`,
    String.raw`{\small\color{Muted}式内文字 / Wording in the equation: or = 或\par}`,
    String.raw`{\small\color{Muted}列名 / Column labels: Query = 查询。\par}`,
    String.raw`\includegraphics{figs/English-plot.pdf}`, String.raw`\bibliography{refs}`, String.raw`\end{document}`].join('\n');
  const result = deriveEnglishView(source, 'main.tex');
  assert.equal(result.supported, true, JSON.stringify(result.diagnostics));
  assert.equal(result.changed, true);
  assert.ok(result.text.includes(original));
  for (const removed of ['Review cover', 'English review note', 'Pending replacement', 'Pending reason', '原文中文', '待确认译文', '\\changeheading{A01}']) assert.ok(!result.text.includes(removed), removed);
  assert.ok(result.text.includes('\\section*{Introduction}'));
  assert.ok(result.text.includes(String.raw`\begin{equation}\label{e:kept} x_i = \frac{1}{2}\end{equation}`));
  assert.ok(result.text.includes(String.raw`\includegraphics{figs/English-plot.pdf}`));
  assert.ok(result.text.includes(String.raw`\bibliography{refs}`));
  assert.equal(result.paragraphs.length, 2); // Heading plus the original, never the proposal or reason.
  const p = result.paragraphs.find(item => item.kind === 'paragraph');
  assert.equal(p.source, original);
  assert.equal(p.translation, '原文中文。');
  assert.equal(Buffer.from(source).subarray(p.startByte, p.endByte).toString(), original);
  assert.equal(Buffer.from(source).subarray(p.translationStartByte, p.translationEndByte).toString(), p.translation);
  assert.equal(p.sourceHash, hash(original));
  assert.equal(p.translationHash, hash(p.translation));
  assert.equal(p.sourcePath, 'main.tex');
  assert.equal(p.readOnly, true);
  assert.equal(p.originalLine, p.derivedLine);
  assert.equal(source.split('\n').length, result.text.split('\n').length);
});

test('read-only reading pairs remain complete after commands that stop the source writer', () => {
  const source = [preamble, pair('Before the cutoff.', '之前。'), String.raw`\def\unrelated{opaque}`,
    String.raw`\providecommand \bibliographyHelper [1]{\catcode 12\csname bibitem#1\endcsname}`,
    pair('After the cutoff with \\emph{nested {words}}.', '之后，仍可阅读。'), String.raw`\end{document}`].join('\n');
  const result = deriveEnglishView(source, 'paper.tex');
  assert.equal(result.supported, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.paragraphs.map(p => p.source), ['Before the cutoff.', 'After the cutoff with \\emph{nested {words}}.']);
  assert.ok(result.paragraphs.every(p => p.readOnly === true && p.translatable !== true));
});

test('CRLF, comments, nested groups and shared math retain exact original byte ranges and line positions', () => {
  const original = 'A UTF-8 café with \\textbf{nested {English}}.\r\n% \\chin is only a comment\r\nThen $x=\\{1,2\\}$ remains.';
  const source = [preamble.replaceAll('\n', '\r\n'), pair(original, '嵌套译文，保留。').replaceAll(/(?<!\r)\n/g, '\r\n'), String.raw`\end{document}`].join('\r\n');
  const result = deriveEnglishView(source, 'nested.tex');
  assert.equal(result.supported, true, JSON.stringify(result.diagnostics));
  const [p] = result.paragraphs;
  assert.equal(p.source, original);
  assert.equal(p.sourceHash, hash(original));
  assert.equal(Buffer.from(source).subarray(p.startByte, p.endByte).toString(), original);
  assert.equal(result.text.split('\r\n').length, source.split('\r\n').length);
  assert.equal(result.text.replaceAll('\r\n', '').includes('\n'), false);
  assert.equal(p.originalEndLine, p.derivedEndLine);
  assert.equal(result.lineMap[p.originalLine - 1].retained, true);
});

test('known bilingual frontmatter, captions and slash headings retain English without deleting shared math', () => {
  const source = [preamble, String.raw`\begin{center}`,
    String.raw`{\Large\bfseries An Original Title}\par\medskip`,
    String.raw`{\Large\bfseries 原始 Pauli 中文标题}\par\medskip`,
    String.raw`Alice Example/甲某$^{1,*}$,\quad Bob Example/乙某$^2$\par`,
    String.raw`{\small $^1$Example University, City, China\par`,
    String.raw`示例大学，城市\par`,
    String.raw`$^*$Equal contribution. / 共同贡献。\par}`, String.raw`\end{center}`,
    String.raw`\section{Methods for $x/y$ / 方法}`,
    String.raw`\begin{theorem}[A bound / 上界]`,
    pair('A theorem.', '定理正文。'), String.raw`\end{theorem}`,
    String.raw`\caption[Figure / 中文短标题]{English caption with $x/y$.\par\smallskip\textbf{中文图注：}中文图注。}`,
    pair('Body.', '正文。'), String.raw`\end{document}`].join('\n');
  const result = deriveEnglishView(source, 'main.tex');
  assert.equal(result.supported, true, JSON.stringify(result.diagnostics));
  assert.ok(result.text.includes('An Original Title'));
  assert.ok(result.text.includes('Alice Example'));
  assert.ok(result.text.includes('Equal contribution.'));
  assert.ok(result.text.includes('Example University, City, China'));
  assert.ok(result.text.includes(String.raw`$x/y$`));
  assert.ok(result.text.includes(String.raw`\section{Methods`));
  assert.ok(result.text.includes(String.raw`\caption[Figure `), 'Hyperref must retain the original English short-caption argument.');
  for (const removed of ['原始中文标题', '甲某', '乙某', '示例大学', '共同贡献', '方法', '中文图注']) assert.ok(!result.text.includes(removed), removed);
});

const captionRegression = () => {
  const englishCaption = 'An original caption with $x/y$.\n\nA second original English paragraph.';
  const source = [preamble.replace('\\begin{document}', '\\usepackage{xcolor,hyperref}\n\\begin{document}'),
    String.raw`\begin{figure}\centering\rule{20pt}{10pt}`,
    `\\caption[An English short caption / 中文短图注]{${englishCaption}\\par\\smallskip\\textbf{中文图注：}中文图注第一行。\n中文图注第二行。}`,
    String.raw`\end{figure}`, pair('An original body paragraph.', '原始正文段落。'), String.raw`\end{document}`].join('\n');
  return { source, englishCaption };
};

test('multiline captions keep an explicit English short argument for hyperref and unchanged original prose', () => {
  const { source, englishCaption } = captionRegression(), result = deriveEnglishView(source, 'main.tex');
  assert.equal(result.supported, true, JSON.stringify(result.diagnostics));
  assert.ok(result.text.includes(String.raw`\caption[An English short caption `));
  assert.ok(result.text.includes(englishCaption));
  assert.equal(result.paragraphs.find(item => item.kind === 'caption').source, englishCaption);
  assert.equal(result.text.split('\n').length, source.split('\n').length);
  assert.ok(!result.text.includes('中文短图注'));
});

const pageFurniture = String.raw`\usepackage{fancyhdr,amsthm}
\pagestyle{fancy}\fancyhf{}
\fancyhead[L]{\scriptsize 中文 Pauli 审阅页眉}
\fancyhead[R]{\scriptsize 待确认中文页眉}
\fancyhead[C]{Original English running title}
\fancyfoot[C]{\thepage}
\newtheorem{theorem}{Theorem / 定理}
\newtheorem{lemma}[theorem]{Lemma / 引理}
\newtheorem*{remark}{Remark / 备注}
`;

test('preamble page furniture and theorem display labels cannot emit Chinese into the English PDF', () => {
  const english = String.raw`An original mathematical statement $x^2=1$.`;
  const source = [preamble.replace('\\begin{document}', pageFurniture + '\\begin{document}'),
    String.raw`\begin{theorem}\label{t:original}`, pair(english, '原始数学陈述。'),
    String.raw`\begin{equation}\label{e:shared}x^2=1\end{equation}\end{theorem}`,
    String.raw`\begin{lemma}An English lemma.\end{lemma}`, String.raw`\end{document}`].join('\n');
  const view = deriveEnglishView(source, 'main.tex');
  assert.equal(view.supported, true, JSON.stringify(view.diagnostics));
  for (const removed of ['中文 Pauli 审阅页眉', '待确认中文页眉', '定理', '引理', '备注']) assert.ok(!view.text.includes(removed), removed);
  assert.ok(view.text.includes(String.raw`\fancyhead[C]{Original English running title}`));
  assert.ok(view.text.includes(String.raw`\fancyfoot[C]{\thepage}`));
  assert.ok(view.text.includes(String.raw`\newtheorem{theorem}{Theorem `));
  assert.ok(view.text.includes(String.raw`\newtheorem{lemma}[theorem]{Lemma `));
  assert.ok(view.text.includes(String.raw`\newtheorem*{remark}{Remark `));
  assert.ok(view.text.includes(String.raw`\begin{equation}\label{e:shared}x^2=1\end{equation}`));
  assert.equal(view.paragraphs.length, 1);
  const [paragraph] = view.paragraphs;
  assert.equal(paragraph.source, english);
  assert.equal(Buffer.from(source).subarray(paragraph.startByte, paragraph.endByte).toString(), english);
  assert.equal(paragraph.sourceHash, hash(english));
  assert.equal(paragraph.translation, '原始数学陈述。');
  assert.equal(view.lineMap.length, source.split('\n').length);
});

test('unknown preamble emitters and Chinese hidden in math or verbatim fail closed', () => {
  const unknown = [
    [preamble.replace('\\begin{document}', '\\AtBeginDocument{未知启动文字}\\begin{document}'), pair('Original.', '原文。'), String.raw`\end{document}`].join('\n'),
    [preamble.replace('\\begin{document}', '\\newcommand{\\foreignLabel}{未知标签}\\begin{document}'), pair('Original.', '原文。'), String.raw`\foreignLabel\end{document}`].join('\n'),
    [preamble, pair('Original.', '原文。'), String.raw`\[x=\mbox{未知中文}\]`, String.raw`\end{document}`].join('\n'),
    [preamble, pair('Original.', '原文。'), String.raw`\verb|未知中文|`, String.raw`\end{document}`].join('\n')
  ];
  for (const source of unknown) {
    const view = deriveEnglishView(source, 'unknown.tex');
    assert.equal(view.supported, false);
    assert.equal(view.text, null);
    assert.ok(view.diagnostics.some(item => item.code === 'UNSUPPORTED_BILINGUAL_CONTENT'));
  }
});

test('isolated XeLaTeX compiles English captions, running heads and theorem labels with zero visible Chinese', { skip: process.env.PAPER_EDITOR_LIVE_COMPILER !== '1' }, async () => {
  const owned = fileURLToPath(new URL('../work/english-caption-tests/', import.meta.url)); await mkdir(owned, { recursive: true });
  const dataRoot = await mkdtemp(path.join(owned, 'case-'));
  const { source: captionSource } = captionRegression();
  const source = captionSource.replace('\\begin{document}', String.raw`\usepackage{fontspec,xeCJK}
\setmainfont{lmroman10-regular.otf}\setCJKmainfont{Noto Serif CJK SC}
` + pageFurniture + '\\begin{document}').replace('\\end{document}', String.raw`\begin{theorem}An original English theorem $x^2=1$.\end{theorem}
\newpage\begin{lemma}An original English lemma.\end{lemma}\end{document}`);
  const view = deriveEnglishView(source, 'main.tex');
  assert.equal(view.supported, true, JSON.stringify(view.diagnostics));
  const worker = new CompilerWorker({ dataRoot });
  const result = await worker.build({ projectId: 'synthetic-caption', snapshotId: hash(source), engine: 'xelatex', mainFile: 'main.tex', files: [{ path: 'main.tex', bytes: Buffer.from(view.text) }] });
  assert.equal(result.status, 'success', JSON.stringify({ status: result.status, diagnostics: result.diagnostics, logPath: result.logPath }));
  assert.equal(result.isolation.verified, true);
  assert.equal((await readFile(result.pdfPath)).subarray(0, 5).toString(), '%PDF-');
  assert.equal(result.pdfHash, hash(await readFile(result.pdfPath)));
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(await readFile(result.pdfPath)), isEvalSupported: false, useSystemFonts: false, disableFontFace: true });
  const pdf = await loading.promise;
  try {
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) pages.push((await (await pdf.getPage(number)).getTextContent()).items.map(item => item.str || '').join(' '));
    const text = pages.join('\n');
    assert.ok(pdf.numPages >= 2);
    assert.equal((text.match(/\p{Script=Han}/gu) || []).length, 0);
    assert.match(text, /Theorem/);
    assert.match(text, /Lemma/);
    assert.match(text, /Original English running title/);
  } finally { await loading.destroy(); }
});

test('unbalanced, orphaned or ambiguous bilingual markers fail closed without a misleading English artifact', () => {
  const broken = [
    [preamble, String.raw`\begin{pairedoriginal}{black}\eng English.\par\chin 中文。`, String.raw`\end{document}`].join('\n'),
    [preamble, String.raw`\eng English.\par\chin 中文。`, String.raw`\end{document}`].join('\n'),
    [preamble, pair('First \\chin embedded.', '中文。'), String.raw`\end{document}`].join('\n'),
    [preamble, String.raw`\proposalstart{A}Pending without ending.`, String.raw`\end{document}`].join('\n'),
    [preamble, String.raw`\section{中文 / English reversed}`, pair('Original.', '正文。'), String.raw`\end{document}`].join('\n'),
    [preamble, String.raw`\newcommand{\chin}{English now}`, pair('Original.', '正文。'), String.raw`\end{document}`].join('\n')
  ];
  for (const source of broken) {
    const result = deriveEnglishView(source, 'broken.tex');
    assert.equal(result.supported, false);
    assert.equal(result.text, null);
    assert.deepEqual(result.paragraphs, []);
    assert.ok(result.diagnostics.some(item => item.severity === 'error'));
  }
});

test('unknown Chinese prose outside a supported companion fails instead of being silently erased', () => {
  const source = [preamble, pair('Known.', '已知。'), '未能识别的中文正文。', String.raw`\end{document}`].join('\n');
  const result = deriveEnglishView(source, 'unknown.tex');
  assert.equal(result.supported, false);
  assert.equal(result.text, null);
  assert.ok(result.diagnostics.some(item => item.code === 'UNSUPPORTED_BILINGUAL_CONTENT'));
});
