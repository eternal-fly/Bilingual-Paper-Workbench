import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml, renderMarkdown } from '../ui/markdown-reader.mjs';
import { loadMarkdownCss, loadMarkdownFontLicense } from '../scripts/markdown-css.mjs';
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { diffSentenceRanges } from '../src/paragraph-comparison.mjs';

test('Markdown paragraphs and selectable emphasis combine with inline, display and environment math', () => {
  const result = markdownToHtml(String.raw`# Reading

**State** $x^2$ and \(\ket{0}\).

$$\frac{a}{b}$$

\[\begin{pmatrix}1&0\\0&1\end{pmatrix}\]
`, { macros: { '\\ket': '\\lvert#1\\rangle' } });
  assert.match(result.html, /<h1>Reading<\/h1>/); assert.match(result.html, /<strong>State<\/strong>/);
  assert.equal(result.mathCount, 4); assert.deepEqual(result.diagnostics, []);
  assert.match(result.html, /katex-mathml/); assert.match(result.html, /<annotation encoding="application\/x-tex">/);
  const inline = markdownToHtml('Sentence **change** $x$.', { inline: true }); assert.doesNotMatch(inline.html, /<p>/);
  const target = { innerHTML: '', classList: { add() {} } };
  assert.equal(renderMarkdown(target, '$x$').mathCount, 1); assert.match(target.innerHTML, /katex/);
});
test('protected math resolves uniquely, references use only supplied labels, and missing IDs remain masked', () => {
  const result = markdownToHtml('Use ⟦P0_abc⟧, [[P1_dead]], Eq. \\eqref{eq:a} and \\cite{paper}; \\ref{missing}.', { tokens: [{ id: '⟦P0_abc⟧', raw: '$\\Ns$' }], macros: { '\\Ns': 'N_s' }, references: { labels: { 'eq:a': '4' }, citations: { paper: '17' } } });
  assert.equal(result.mathCount, 1); assert.match(result.html, /\(4\)/); assert.match(result.html, /\[17\]/);
  assert.match(result.html, /missing/); assert.doesNotMatch(result.html, /P0_abc|P1_dead/);
  assert.ok(result.diagnostics.some(item => item.code === 'UNRESOLVED_PROTECTED_TOKEN'));
  assert.ok(result.diagnostics.some(item => item.code === 'UNRESOLVED_REFERENCE'));
});
test('display registries retain the5001st protected token and reference plus macros beyond64 entries', () => {
  const tokens = Array.from({ length: 5001 }, (_, index) => ({ id: `⟦P${index}_abcd⟧`, raw: '$x_{' + index + '}$' })), labels = Object.fromEntries(tokens.map((_, index) => ['eq:' + index, String(index + 1)])), citations = Object.fromEntries(tokens.map((_, index) => ['paper:' + index, String(index + 1)])), macros = Object.fromEntries(Array.from({ length: 65 }, (_, index) => ['\\display' + String.fromCharCode(65 + Math.floor(index / 26)) + String.fromCharCode(65 + index % 26), 'y']));
  const result = markdownToHtml('⟦P5000_abcd⟧ $\\displayCM$ \\eqref{eq:5000} \\cite{paper:5000}', { tokens, macros, references: { labels, citations } });
  assert.equal(result.mathCount, 2); assert.match(result.html, /\(5001\)/); assert.match(result.html, /\[5001\]/); assert.deepEqual(result.diagnostics, []);
});
test('HTML, links, images, dangerous math extensions and mutable macros cannot create executable or external content', () => {
  const source = String.raw`<img src=x onerror=alert(1)> [link](javascript:alert(1)) ![alt](https://example.org/a.png)
$\href{https://example.org}{x}$ $\htmlClass{evil}{x}$ $\includegraphics{https://example.org/a.png}$ $\gdef\evil{x}$ $\evil$`;
  const result = markdownToHtml(source, { macros: { '\\bad': '\\href{https://example.org}{x}' } });
  assert.doesNotMatch(result.html, /<(?:img|a|script)\b/); assert.doesNotMatch(result.html, /class="evil"|<[^>]+\b(?:href|src)=/);
  assert.match(result.html, /&lt;img/); assert.ok(result.diagnostics.some(item => item.code === 'UNSUPPORTED_MATH'));
  const next = markdownToHtml('$\\evil$'); assert.equal(next.mathCount, 0);
  assert.equal(markdownToHtml('$x^2 + \\unknown$').mathCount, 0);
});
test('code spans and fenced code preserve mathematical and reference source without rendering it', () => {
  const result = markdownToHtml('`$x$ \\ref{a}`\n\n```tex\n$y$ \\ref{a}\n```', { references: { labels: { a: '4' }, citations: {} } });
  assert.equal(result.mathCount, 0); assert.match(result.html, /\\ref\{a\}/); assert.doesNotMatch(result.html, />4</);
  assert.equal(markdownToHtml(String.raw`\begin{aligned}a&=b\\c&=d\end{aligned}`).mathCount, 1);
  assert.equal(markdownToHtml(String.raw`$\text{量子态}$`).mathCount, 1);
});
test('malformed, oversized and stale math contexts fall back to readable source with bounded diagnostics', () => {
  for (const source of ['$x', '\\(x', '$' + 'x'.repeat(20000) + '$', '$^^5cinput{x}$', '$x\u202e+y$']) {
    const result = markdownToHtml(source); assert.equal(result.mathCount, 0); assert.ok(result.diagnostics.length);
  }
  const stale = markdownToHtml('⟦P0_abc⟧ $\\Ns$', { tokens: [{ id: '⟦P0_abc⟧', raw: '$WRONG$' }], macros: { '\\Ns': 'WRONG' }, sourceSnapshotId: 'old', contextSnapshotId: 'new' });
  assert.doesNotMatch(stale.html, /WRONG|P0_abc/); assert.equal(stale.mathCount, 0); assert.ok(stale.diagnostics.some(item => item.code === 'STALE_MATH_CONTEXT'));
});
test('KaTeX stylesheet embeds every referenced font without external resources', async () => {
  const css = await loadMarkdownCss(fileURLToPath(new URL('../', import.meta.url)));
  assert.match(css, /\.katex/); assert.match(css, /data:font\/woff2;base64,/);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /url\((?!["']?data:)|@import|https?:\/\//);
  assert.match(css, /SIL OPEN FONT LICENSE Version 1\.1/);
});
test('bundled font notice retains copyright and every reserved font family from the actual KaTeX font metadata', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url)), notice = await loadMarkdownFontLicense(root), fontRoot = path.join(root, 'node_modules/katex/dist/fonts');
  assert.match(notice, /Copyright \(c\) 2009-2010, Design Science/); assert.match(notice, /Copyright \(c\) 2014-2018 Khan Academy/);
  assert.match(notice, /PERMISSION & CONDITIONS/); assert.match(notice, /TERMINATION/); assert.match(notice, /OTHER DEALINGS IN THE FONT SOFTWARE\./);
  const families = new Set();
  for (const filename of (await readdir(fontRoot)).filter(value => value.endsWith('.ttf'))) {
    const bytes = await readFile(path.join(fontRoot, filename)); let nameOffset;
    for (let index = 0; index < bytes.readUInt16BE(4); index++) { const at = 12 + index * 16; if (bytes.toString('ascii', at, at + 4) === 'name') nameOffset = bytes.readUInt32BE(at + 8); }
    assert.ok(nameOffset, filename);
    const storage = nameOffset + bytes.readUInt16BE(nameOffset + 4);
    for (let index = 0; index < bytes.readUInt16BE(nameOffset + 2); index++) {
      const at = nameOffset + 6 + index * 12;
      if (bytes.readUInt16BE(at) !== 3 || bytes.readUInt16BE(at + 6) !== 13) continue;
      const start = storage + bytes.readUInt16BE(at + 10), value = Buffer.from(bytes.subarray(start, start + bytes.readUInt16BE(at + 8))).swap16().toString('utf16le');
      assert.match(value, /SIL Open Font License, Version 1\.1/);
      const family = /Reserved Font Name ([A-Za-z0-9_]+)\./.exec(value)?.[1]; assert.ok(family, filename); families.add(family); assert.ok(notice.includes(family), family);
    }
  }
  assert.equal(families.size, 12);
});
test('sentence highlighting preserves whole Markdown emphasis, headings, lists and atomic math', () => {
  const current = '# Heading\n\n**Fixed sentence. Old sentence.** _Same end._\n\n- Fixed item.\n- Old item $x^2$.';
  const recommended = current.replace('Old sentence.', 'New sentence.').replace('Old item', 'New item');
  const compared = diffSentenceRanges(current, recommended);
  const result = markdownToHtml(current, { highlights: compared.current.ranges });
  assert.equal(result.mathCount, 1); assert.deepEqual(result.diagnostics, []);
  assert.match(result.html, /<h1>/); assert.match(result.html, /<ul>/); assert.equal((result.html.match(/<li>/g) || []).length, 2);
  assert.equal((result.html.match(/<strong>/g) || []).length, 1); assert.equal((result.html.match(/<em>/g) || []).length, 1);
  assert.doesNotMatch(result.html, /\*\*Fixed|sentence\.\*\*|_Same|end\._|\\mdhl/);
  assert.match(result.html, /class="revision-sentence"[^>]*data-changed="true"[^>]*data-revision-role="current"/);
  assert.match(result.html, /data-changed="false"/);
  const inline = markdownToHtml('**Fixed. Changed.**', { inline: true, highlights: [{ start: 0, end: 9, role: 'recommended', changed: false }, { start: 9, end: 19, role: 'recommended', changed: true }] });
  assert.doesNotMatch(inline.html, /<p>/); assert.match(inline.html, /<strong>/); assert.deepEqual(inline.diagnostics, []);
  const stripColors = html => { const spans = []; return html.replace(/<span\b[^>]*>|<\/span>/g, tag => { if (tag.startsWith('</')) return spans.pop() ? '' : tag; const colored = /class="revision-sentence"/.test(tag); spans.push(colored); return colored ? '' : tag; }); };
  for (const sample of [current, '_Fixed sentence. Changed sentence._', '> **Fixed sentence.\n> Changed sentence.**\n\n- _First item. Second item._']) {
    const ranges = diffSentenceRanges(sample, sample.replace('Changed', 'Revised')).current.ranges;
    const highlighted = markdownToHtml(sample, { highlights: ranges });
    assert.deepEqual(highlighted.diagnostics, []);
    assert.equal(stripColors(highlighted.html), markdownToHtml(sample).html, 'Coloring does not alter Markdown structure or contents.');
  }
});
test('highlight offsets remain bound across protected expansion and CRLF without trusting marker input', () => {
  const text = 'Before ⟦P0_abc⟧.\r\nAfter.';
  const boundary = text.indexOf('After');
  const result = markdownToHtml(text, { tokens: [{ id: '⟦P0_abc⟧', raw: '$x^2$' }], highlights: [{ start: 0, end: boundary, role: 'current', changed: false }, { start: boundary, end: text.length, role: 'current', changed: true }] });
  assert.equal(result.mathCount, 1); assert.deepEqual(result.diagnostics, []);
  assert.match(result.html, /data-revision-index="1">After\./);
  const attack = markdownToHtml('\\mdhl{forged:0} <img src=x onerror=evil()>', { highlights: [{ start: 0, end: 45, role: 'evil', changed: true }] });
  assert.doesNotMatch(attack.html, /<img|data-revision-role="evil"/);
  assert.ok(attack.diagnostics.some(item => item.code === 'UNSUPPORTED_HIGHLIGHT'));
});
test('equation and split labels project as readable math with only verified current equation numbers',()=>{
 const source=String.raw`\begin{equation}\begin{split}\Ns&=\Tr(\rho)\\&=\ip{x}{y}\label{eq:main}\end{split}\end{equation}`;
 const options={macros:{'\\Ns':'N_s','\\Tr':'\\operatorname{Tr}','\\ip':'\\langle#1,#2\\rangle'},references:{labels:{'eq:main':'4'},citations:{}}};
 const result=markdownToHtml(source,options);assert.equal(result.mathCount,1);assert.deepEqual(result.diagnostics,[]);assert.doesNotMatch(result.html,/math-source|\\label\{/);assert.match(result.html,/class="katex-tag"/);assert.match(result.html,/>4</);assert(source.includes(String.raw`\label{eq:main}`));
 const unknown=markdownToHtml(source,{macros:options.macros});assert.equal(unknown.mathCount,1);assert.doesNotMatch(unknown.html,/class="katex-tag"|\\label\{/);assert.deepEqual(unknown.diagnostics,[]);
 const stale=markdownToHtml(source,{...options,sourceSnapshotId:'old',contextSnapshotId:'new'});assert.equal(stale.mathCount,0);assert(stale.diagnostics.some(d=>d.code==='STALE_MATH_CONTEXT'));assert.doesNotMatch(stale.html,/class="katex-tag"/);
});
test('standalone labels are hidden only in reading while source code, references and color offsets stay intact',()=>{
 const source=String.raw`\label{thm:fixed}The statement uses $x^2$. Next sentence.`;
 const result=markdownToHtml(source,{highlights:[{start:0,end:source.indexOf('Next'),role:'current',changed:false},{start:source.indexOf('Next'),end:source.length,role:'current',changed:true}]});assert.equal(result.mathCount,1);assert.doesNotMatch(result.html,/\\label\{|thm:fixed/);assert.match(result.html,/data-revision-index="1">Next sentence\./);assert.deepEqual(result.diagnostics,[]);
 assert.match(markdownToHtml('`'+String.raw`\label{thm:fixed}`+'`').html,/\\label\{/);assert.match(markdownToHtml(String.raw`See \ref{thm:fixed}.`).html,/thm:fixed/);
});
test('a single math-only mbox projects without source braces and complex wrappers remain safe source',()=>{
 const source=String.raw`The string is \mbox{$Z^v=\Tr(\rho)$} here.`,result=markdownToHtml(source,{macros:{'\\Tr':'\\operatorname{Tr}'}});assert.equal(result.mathCount,1);assert.deepEqual(result.diagnostics,[]);assert.doesNotMatch(result.html,/\\mbox\{|\}<\/p>/);assert.match(result.html,/here\./);assert(source.includes(String.raw`\mbox{`));
 for(const raw of[String.raw`\mbox{mixed $x$ prose}`,String.raw`\mbox{\href{https://example.org}{bad}$x$}`]){const unsupported=markdownToHtml(raw);assert.equal(unsupported.mathCount,0);assert.match(unsupported.html,/math-source/);assert(unsupported.diagnostics.some(d=>d.code==='UNSUPPORTED_MATH_WRAPPER'));assert.doesNotMatch(unsupported.html,/<a\b|href=/);}
});
