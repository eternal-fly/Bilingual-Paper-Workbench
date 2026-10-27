import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { OpinionMathRenderer, opinionMathFingerprint } from '../src/opinion-math.mjs';
import { CompilerWorker, inputHash } from '../src/compiler/worker.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  return {
    note: { noteId: 'note-fixture', revision: 1, sourceSegmentIds: ['p1'], suggestedSource: 'Use $\\Ns=\\Tr(\\rho)$ and $x^2$.', suggestedTranslation: '使用 $\\Ns=\\Tr(\\rho)$。', reasonSource: 'Preserve the $x^2$ term.', reasonTranslation: '保留公式。' },
    state: { project: { id: 'project-fixture', snapshotId: 'snapshot-fixture', mainFile: 'main.tex' }, readingParagraphs: [{ id: 'p1', protectedTokens: [{ id: '⟦P0_abc⟧', raw: '$\\ket{0}$' }] }] },
    files: [{ path: 'main.tex', bytes: Buffer.from(String.raw`\documentclass{article}
\newcommand{\Ns}{N_s}
\newcommand{\Tr}{\operatorname{Tr}}
\newcommand{\ket}[1]{\left|#1\right\rangle}
\begin{document}SOURCE MUST NOT BE COPIED\end{document}`) }], language: 'zh-CN',
  };
}
async function compilerFixture(t, { badIdentity = false, fail = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opinion-math-test-'));
  const calls = [];
  return { calls, async build(input) {
    calls.push(input);
    if (fail) return { status: 'failed', diagnostics: [{ code: 'COMPILE_FAILED' }] };
    const count = (input.files[0].bytes.toString().match(/\\opinionmathitem\{/g) || []).length;
    const pdfPath = path.join(root, `out-${calls.length}.pdf`), logPath = path.join(root, `out-${calls.length}.log`);
    const bytes = Buffer.from('%PDF-1.4\nsynthetic compiler artifact');
    await writeFile(pdfPath, bytes); await writeFile(logPath, Array.from({ length: count }, (_, i) => `OPINION-MATH-METRIC:${i}:30.0pt:8.0pt:2.0pt`).join('\n'));
    return { status: 'success', projectId: input.projectId, snapshotId: input.snapshotId, inputHash: badIdentity ? 'wrong' : inputHash(input), buildId: 'fixture-build', isolation: { verified: true }, pdfPath, pdfHash: hash(bytes), logPath };
  } };
}
test('opinion renderer preserves selectable prose, deduplicates formula pages and uses only safe macro closure', async t => {
  const input = fixture(), compiler = await compilerFixture(t), renderer = new OpinionMathRenderer({ compiler });
  const original = Buffer.from(input.files[0].bytes), result = await renderer.render(input);
  assert.equal(result.status, 'success'); assert.equal(result.fragments.length, 2); assert.equal(result.pdf.pageCount, 2);
  assert.equal(result.fields.suggestedSource[0].text, 'Use ');
  assert.equal(result.fields.suggestedSource[1].type, 'math');
  assert.equal(result.fields.suggestedTranslation[1].page, result.fields.suggestedSource[1].page);
  assert.ok(result.fragments[0].depthPt > 0); assert.ok(result.fragments[0].widthPt < 100);
  assert.equal(compiler.calls.length, 1); assert.deepEqual(input.files[0].bytes, original);
  const source = compiler.calls[0].files[0].bytes.toString();
  assert.match(source, /\\documentclass\[multi=reviewmath,border=1pt\]\{standalone\}/);
  assert.match(source, /\\newcommand\{\\Ns\}\{N_s\}/); assert.match(source, /\\newcommand\{\\Tr\}/);
  assert.doesNotMatch(source, /SOURCE MUST NOT BE COPIED|\\newcommand\{\\ket\}/);
});
test('protected formulas resolve only inside exact note anchors and unsupported TeX stays text', async t => {
  const input = fixture(); input.note.suggestedSource = 'State ⟦P0_abc⟧, reject $\\input{secret}$ and $\\ref{a}$.';
  input.state.readingParagraphs.push({ id: 'p2', protectedTokens: [{ id: '⟦P0_abc⟧', raw: '$EVIL$' }] });
  const compiler = await compilerFixture(t), result = await new OpinionMathRenderer({ compiler }).render(input);
  assert.ok(result.fragments.some(fragment => fragment.tex === '\\ket{0}'));
  assert.ok(!result.fragments.some(fragment => /input|ref/.test(fragment.tex)));
  assert.ok(result.diagnostics.some(item => item.code === 'UNSUPPORTED_MATH'));
  assert.match(result.fields.suggestedSource.filter(token => token.type === 'text').map(token => token.text).join(''), /\\input\{secret\}/);
  input.note.sourceSegmentIds = ['unknown'];
  const missing = await new OpinionMathRenderer({ compiler }).render(input);
  assert.ok(missing.diagnostics.some(item => item.code === 'UNRESOLVED_PROTECTED_TOKEN'));
  assert.doesNotMatch(JSON.stringify(missing.fields), /P0_abc/);
});
test('malformed delimiters and unsafe or recursive custom macros fall back without executing them', async t => {
  const input = fixture(); input.note.suggestedSource = 'Bad $\\bad$; cycle $\\cycle$; broken $x';
  input.files[0].bytes = Buffer.from(String.raw`\newcommand{\bad}{\csname input\endcsname{private}}\newcommand{\cycle}{\cycle}\begin{document}`);
  const compiler = await compilerFixture(t), result = await new OpinionMathRenderer({ compiler }).render(input);
  assert.equal(result.fields.suggestedSource.length, 1);
  assert.ok(result.diagnostics.some(item => item.code === 'UNSUPPORTED_MATH'));
  assert.ok(result.diagnostics.some(item => item.code === 'MALFORMED_MATH'));
  if (compiler.calls.length) assert.doesNotMatch(compiler.calls[0].files[0].bytes.toString(), /\\csname|\\newcommand\{\\cycle\}/);
});
test('fingerprint binds source, note, language and protected context; concurrent calls coalesce and cache cannot be mutated', async t => {
  const input = fixture(), compiler = await compilerFixture(t), renderer = new OpinionMathRenderer({ compiler });
  const first = opinionMathFingerprint(input);
  const [a, b] = await Promise.all([renderer.render(input), renderer.render(input)]);
  assert.equal(compiler.calls.length, 1); assert.equal(a.renderKey, b.renderKey);
  a.fields.suggestedSource[0].text = 'tampered';
  assert.equal((await renderer.render(input)).fields.suggestedSource[0].text, 'Use ');
  for (const mutate of [x => x.note.revision++, x => x.language = 'ja', x => x.state.project.snapshotId = 'new', x => x.files[0].bytes = Buffer.from('changed'), x => x.state.readingParagraphs[0].protectedTokens[0].raw = '$z$']) {
    const copy = fixture(); mutate(copy); assert.notEqual(opinionMathFingerprint(copy), first);
  }
});
test('bad compiler identity, failure and absent compiler return explicit text fallback', async t => {
  for (const compiler of [null, await compilerFixture(t, { fail: true }), await compilerFixture(t, { badIdentity: true })]) {
    const result = await new OpinionMathRenderer({ compiler }).render(fixture());
    assert.equal(result.pdf, null); assert.equal(result.fragments.length, 0); assert.equal(result.status, 'text');
    assert.ok(result.diagnostics.length); assert.ok(result.fields.suggestedSource.every(token => token.type === 'text'));
  }
});
test('command injection, TeX character rewriting, controls, raw comments and wrong macro arity cannot reach the compiler', async t => {
  const compiler = await compilerFixture(t), renderer = new OpinionMathRenderer({ compiler });
  for (const tex of [String.raw`\csname input\endcsname{x}`, '^^5cinput{x}', 'x\u202e+y', String.raw`\end{reviewmath}`, String.raw`\newcommand{\x}{z}`, 'x%\n+y', String.raw`\ket`, String.raw`\typeout{OPINION-MATH-METRIC:0:30pt:8pt:2pt}`]) {
    const input = fixture(); input.note = { ...input.note, suggestedSource: `$${tex}$`, suggestedTranslation: '', reasonSource: '', reasonTranslation: '' };
    const result = await renderer.render(input);
    assert.equal(result.pdf, null, tex); assert.ok(result.diagnostics.some(item => item.code === 'UNSUPPORTED_MATH'), tex);
  }
  assert.equal(compiler.calls.length, 0);
  const input = fixture(); input.note.suggestedSource = String.raw`$\text{cost \$5 and 20\%}$`;
  const result = await renderer.render(input); assert.ok(result.fragments.some(item => item.tex.includes('cost')));
});
test('macro extraction uses only active top-level preamble and explicit preamble input declarations', async t => {
  const input = fixture(), compiler = await compilerFixture(t);
  input.note = { ...input.note, suggestedSource: '$\\Phantom$ $\\Scoped$ $\\Conditional$ $\\Nested$ $\\Body$ $\\Included$', suggestedTranslation: '', reasonSource: '', reasonTranslation: '' };
  input.files = [{ path: 'main.tex', bytes: Buffer.from(String.raw`\documentclass{article}
\begin{verbatim}\newcommand{\Phantom}{Z}\end{verbatim}
{\newcommand{\Scoped}{Z}}
\iftrue\newcommand{\Conditional}{Z}\fi
\newcommand{\Container}{\newcommand{\Nested}{Z}}
\input{preamble/macros}
\begin{document}\newcommand{\Body}{Z}\end{document}`) }, { path: 'preamble/macros.tex', bytes: Buffer.from(String.raw`\newcommand{\Included}{\mathbb{Z}}`) }, { path: 'unrelated.tex', bytes: Buffer.from(String.raw`\newcommand{\Phantom}{Z}`) }];
  const result = await new OpinionMathRenderer({ compiler }).render(input);
  assert.deepEqual(result.fragments.map(item => item.tex), ['\\Included']);
  const source = compiler.calls[0].files[0].bytes.toString();
  assert.match(source, /\\newcommand\{\\Included\}/); assert.doesNotMatch(source, /\\newcommand\{\\(?:Phantom|Scoped|Conditional|Nested|Body)\}/);
  input.note.suggestedSource = '$\\Changed$';
  input.files[0].bytes = Buffer.from(String.raw`\newcommand{\Changed}{N}\AtBeginDocument{\renewcommand{\Changed}{M}}\begin{document}`);
  const hooked = await new OpinionMathRenderer({ compiler }).render(input);
  assert.equal(hooked.pdf, null); assert.ok(hooked.diagnostics.some(item => item.code === 'UNSUPPORTED_MATH'));
});
test('old-source opinions never reinterpret protected objects or custom macros under a newer source snapshot', async t => {
  const input = fixture(), compiler = await compilerFixture(t);
  input.note.sourceSnapshotId = 'old-source'; input.note.suggestedSource = 'Previously ⟦P0_abc⟧ and $\\Ns$.';
  const result = await new OpinionMathRenderer({ compiler }).render(input);
  assert.equal(compiler.calls.length, 0); assert.equal(result.pdf, null);
  assert.ok(result.diagnostics.some(item => item.code === 'STALE_REVIEW_SOURCE'));
  assert.doesNotMatch(JSON.stringify(result.fields), /\\\\ket|P0_abc/);
  assert.match(result.fields.suggestedSource.map(item => item.text).join(''), /\\Ns/);
});
test('failed displays cache, cache eviction is bounded and close aborts only owned render work', async t => {
  const compiler = await compilerFixture(t, { fail: true }), renderer = new OpinionMathRenderer({ compiler, maxCacheEntries: 1 });
  await renderer.render(fixture()); await renderer.render(fixture()); assert.equal(compiler.calls.length, 1);
  const other = fixture(); other.note.revision++; await renderer.render(other); await renderer.render(fixture()); assert.equal(compiler.calls.length, 3);
  // An expired transient error may be retried; successful artifacts stay bound
  // to their exact immutable input until bounded LRU eviction.
  renderer.cache.get(opinionMathFingerprint(fixture())).expiresAt = Date.now() - 1;
  await renderer.render(fixture()); assert.equal(compiler.calls.length, 4);
  let renderSignal;
  const blocked = new OpinionMathRenderer({ compiler: { build(input) { renderSignal = input.signal; return new Promise(resolve => input.signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true })); } } });
  const rendering = blocked.render(fixture()); assert.equal(renderSignal.aborted, false);
  await blocked.close(); assert.equal(renderSignal.aborted, true); await rendering;
  assert.equal(blocked.cache.size, 0);
  const closed = await blocked.render(fixture()); assert.ok(closed.diagnostics.some(item => item.code === 'RENDER_CLOSED'));
  assert.deepEqual(Object.keys(closed).sort(), ['diagnostics', 'fields', 'fragments', 'pdf', 'renderKey', 'status']);
});

const live = process.env.PAPER_EDITOR_LIVE_COMPILER === '1';
test('real isolated compiler produces exactly one tightly cropped formula per page', { skip: !live, timeout: 240000 }, async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'opinion-math-live-'));
  const compiler = new CompilerWorker({ dataRoot, runtimeRoot: process.env.PAPER_EDITOR_COMPILER_RUNTIME });
  const input = fixture(); input.note.suggestedSource += String.raw` Also \[\begin{pmatrix}1&0\\0&1\end{pmatrix}\quad\text{量子态}\] and ⟦P0_abc⟧.`;
  const result = await new OpinionMathRenderer({ compiler }).render(input);
  assert.equal(result.status, 'success', JSON.stringify(result.diagnostics));
  assert.equal(result.fragments.length, 4); assert.equal(result.pdf.pageCount, 4);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(Buffer.from(result.pdf.base64, 'base64')), isEvalSupported: false, useSystemFonts: false, disableFontFace: true });
  const pdf = await loading.promise;
  try {
    assert.equal(pdf.numPages, 4);
    for (const fragment of result.fragments) {
      const page = await pdf.getPage(fragment.page), [x0, y0, x1, y1] = page.view;
      assert.ok(x1 - x0 < 400 && y1 - y0 < 150, `Uncropped page ${fragment.page}: ${page.view}`);
      assert.ok(Math.abs(x1 - x0 - fragment.widthPt) < 1.5, 'Recorded crop width agrees with PDF MediaBox.');
      assert.ok((await page.getTextContent()).items.length > 0, 'No blank formula page.');
    }
  } finally { await loading.destroy(); }
});
