import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTexProse, translationUpdateCandidates } from '../ui/tex-prose-reader.mjs';
import {markdownToHtml} from '../ui/markdown-reader.mjs';

test('static prose formatting becomes readable Markdown while mathematical and citation bytes remain exact', () => {
  const raw = String.raw`\textbf{A \emph{precise} claim} uses $\ket{x_i}$ and \cite{a,b}.`;
  const result = decodeTexProse(raw);
  assert.equal(result.text, String.raw`**A *precise* claim** uses $\ket{x_i}$ and \cite{a,b}.`);
  assert.deepEqual(result.diagnostics, []);
});
test('known section and list structure is decoded without interpreting unknown macros or raw HTML', () => {
  const raw = String.raw`\section{引言}
\begin{enumerate}\item 第一项 $x=1$.\item 第二项 \textit{说明}.\end{enumerate}
\input{secret.tex}<script>not executed</script>`;
  const result = decodeTexProse(raw);
  assert.ok(result.text.includes('## 引言'));
  assert.ok(result.text.includes('1. 第一项 $x=1$.'));
  assert.ok(result.text.includes('2. 第二项 *说明*.'));
  assert.ok(result.text.includes(String.raw`\input{secret.tex}<script>not executed</script>`));
  assert.ok(result.diagnostics.some(item => item.code === 'TEX_PROSE_UNSUPPORTED'));
});
test('malformed or overly nested formatting remains literal rather than losing an author buffer', () => {
  const raw = String.raw`保留 \textbf{unfinished $x=1$`;
  assert.equal(decodeTexProse(raw).text, raw);
  const deep = String.raw`\emph{`.repeat(40) + 'x' + '}'.repeat(40);
  assert.ok(decodeTexProse(deep).diagnostics.length);
});
test('math environments, references, and protected placeholders are not decoded as prose', () => {
  const raw = String.raw`\begin{align}x &= \textbf{y} \\ z&=1\end{align} \eqref{eq:one} ⟦P1_abcd⟧`;
  assert.equal(decodeTexProse(raw).text, raw);
});
test('unique source structure atoms decode only in presentation, preserving the original protected objects', () => {
  const tokens = [{id:'⟦P1_ab⟧',raw:String.raw`\textbf{`},{id:'⟦P2_ab⟧',raw:'}'},{id:'⟦P3_ab⟧',raw:'$x=1$'}], before=structuredClone(tokens);
  assert.equal(decodeTexProse('⟦P1_ab⟧译文⟦P2_ab⟧ ⟦P3_ab⟧',{tokens}).text,'**译文** $x=1$');
  assert.deepEqual(tokens,before);
  assert.equal(decodeTexProse('⟦P1_ab⟧',{tokens:[{id:'⟦P1_ab⟧',raw:'one'},{id:'⟦P1_ab⟧',raw:'two'}]}).text,'⟦P1_ab⟧');
});
test('source prose can resolve the5001st protected structure token without truncating its registry', () => {
  const tokens = Array.from({ length: 5001 }, (_, index) => ({ id: `⟦P${index}_abcd⟧`, raw: index === 5000 ? '\\textbf{' : '$x$' })), last = structuredClone(tokens.at(-1));
  assert.equal(decodeTexProse('⟦P5000_abcd⟧Exact text}', { tokens }).text, '**Exact text**'); assert.deepEqual(tokens.at(-1), last);
});
test('repeated unclosed formatting is bounded and unsupported styling remains literal', () => {
  const raw = String.raw`\textbf{`.repeat(1500) + 'tail';
  const result = decodeTexProse(raw); assert.equal(result.text, raw); assert.ok(result.diagnostics.some(item => item.code === 'TEX_PROSE_LIMIT'));
  const unsupported = String.raw`\underline{exact text}`; assert.equal(decodeTexProse(unsupported).text, unsupported); assert.ok(decodeTexProse(unsupported).diagnostics.length);
});
test('translation update scope uses only explicit staleness or source-hash mismatch, and lists missing translations separately', () => {
  const state = { readingParagraphs: ['fresh','changed','stale','missing','opaque'].map(id => ({ id, sourceHash: id, translatable: id !== 'opaque' })), translations: { 'zh-CN': { fresh: { text:'已译',sourceHash:'fresh' }, changed:{text:'作者草稿',sourceHash:'old',origin:'human'},stale:{text:'旧译',sourceHash:'stale',status:'stale'} } } };
  const result = translationUpdateCandidates(state, 'zh-CN');
  assert.deepEqual(result.changed.map(item => item.id), ['changed','stale']);
  assert.deepEqual(result.missing.map(item => item.id), ['missing']);
  assert.equal(result.changed[0].manual, true);
  assert.deepEqual(state.translations['zh-CN'].changed, {text:'作者草稿',sourceHash:'old',origin:'human'});
});
test('single complete inline-math boxes unwrap only in reading and retain exact math and reference bytes',()=>{
 for(const [source,expected]of[[String.raw`The value is \mbox{$Z^v=\Tr(\rho)$} and \cite{paper}.`,String.raw`The value is $Z^v=\Tr(\rho)$ and \cite{paper}.`],[String.raw`A \mbox{\(x^{2}+\ip{a}{b}\)} B.`,String.raw`A \(x^{2}+\ip{a}{b}\) B.`],[String.raw`A \mbox{ $x$ } B.`,String.raw`A  $x$  B.`]]){const before=source,result=decodeTexProse(source);assert.equal(result.text,expected);assert.deepEqual(result.diagnostics,[]);assert.equal(source,before);}
 const tokens=[{id:'⟦P1_ab⟧',raw:String.raw`\mbox{$x=1$}`}],before=structuredClone(tokens);assert.equal(decodeTexProse('Value ⟦P1_ab⟧.',{tokens}).text,'Value $x=1$.');assert.deepEqual(tokens,before);
});
test('mixed, nonmath, incomplete and unsafe boxes retain source and a warning',()=>{
 for(const source of[String.raw`\mbox{plain text}`,String.raw`\mbox{mixed $x$ prose}`,String.raw`\mbox{$x$ $y$}`,String.raw`\mbox{$x}`,String.raw`\mbox{\(x}`,String.raw`\mbox{$x^{2$}`,String.raw`\mbox{\(x$y\)}`,String.raw`\mbox{$x\)y$}`,String.raw`\mbox*{$x$}`,String.raw`\mbox{$\input{secret}$}`,String.raw`\mbox{$x$`,String.raw`\mbox{<img src=x onerror=evil()>}`]){const result=decodeTexProse(source);assert.equal(result.text,source);assert(result.diagnostics.some(item=>item.code==='TEX_PROSE_UNSUPPORTED'));}
});
test('texorpdfstring decodes the balanced display branch recursively and requires a complete bookmark argument',()=>{
 const source=String.raw`\subsection{\texorpdfstring{A \textbf{precise} regime for $x^2$}{A regime for x2}}`,result=decodeTexProse(source);assert.equal(result.text,'\n### A **precise** regime for $x^2$\n');assert.deepEqual(result.diagnostics,[]);
 const nested=decodeTexProse(String.raw`\texorpdfstring{Outer \texorpdfstring{\emph{inner} $x$}{inner x}}{outer}`);assert.equal(nested.text,'Outer *inner* $x$');assert.deepEqual(nested.diagnostics,[]);
 const escapedPercent=decodeTexProse(String.raw`\texorpdfstring{Display \%}{bookmark \%}`);assert.equal(escapedPercent.text,String.raw`Display \%`);assert.deepEqual(escapedPercent.diagnostics,[]);
 for(const malformed of[String.raw`\texorpdfstring{Display}`,String.raw`\texorpdfstring{Display}{unfinished`,String.raw`\texorpdfstring{unfinished`,String.raw`\texorpdfstring{Display %}{bookmark}`+'\ncontinued}',String.raw`\texorpdfstring{Display}{bookmark %}`+'\ncontinued}']){const bad=decodeTexProse(malformed);assert.equal(bad.text,malformed);assert(bad.diagnostics.some(item=>item.code==='TEX_PROSE_UNSUPPORTED'));}
});
test('presentation branches never execute TeX or trust HTML, and recursive display decoding remains bounded',()=>{
 const source=String.raw`\texorpdfstring{<script>window.evil=true</script> \input{secret.tex} $x$}{\input{bookmark.tex}<img src=x onerror=evil()>}`,result=decodeTexProse(source);assert.equal(result.text,String.raw`<script>window.evil=true</script> \input{secret.tex} $x$`);assert(result.diagnostics.some(item=>item.code==='TEX_PROSE_UNSUPPORTED'));const rendered=markdownToHtml(result.text);assert.doesNotMatch(rendered.html,/<script\b|<img\b/);assert.match(rendered.html,/&lt;script/);assert.equal(rendered.mathCount,1);
 const deep=String.raw`\texorpdfstring{`.repeat(40)+'x'+String.raw`}{bookmark}`.repeat(40),bounded=decodeTexProse(deep);assert(bounded.diagnostics.some(item=>item.code==='TEX_PROSE_LIMIT'));assert(bounded.text.includes(String.raw`\texorpdfstring{`));
});
