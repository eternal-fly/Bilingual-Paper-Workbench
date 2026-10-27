import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, browserOptions } from './ui-qa-support.mjs';
import { loadMarkdownCss } from './markdown-css.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), output = path.join(root, 'work/ui-markdown-reader-qa');
await mkdir(output, { recursive: true });
const bundle = await build({ stdin: { contents: `import {renderMarkdown} from './ui/markdown-reader.mjs';import {diffSentenceRanges} from './src/paragraph-comparison.mjs';window.renderMarkdown=renderMarkdown;window.diffSentenceRanges=diffSentenceRanges;`, resolveDir: root }, bundle: true, platform: 'browser', format: 'iife', write: false });
const css = `${await loadMarkdownCss(root)}\n${await readFile(path.join(root, 'ui/style.css'), 'utf8')}`;
const html = `<!doctype html><html data-theme="light"><meta charset="utf-8"><style>${css}\nbody{display:block;padding:24px;background:#f7f4e9;color:#313a37}.readings{display:grid;grid-template-columns:1fr 1fr;gap:24px;max-width:1100px;margin:auto}.sample{padding:24px;background:#fffef9;border:1px solid #ded8bc;border-radius:10px;line-height:1.8}.sample h2{font-size:20px}.sample .katex-display{overflow-x:auto;overflow-y:hidden}.math-source{font-family:monospace;white-space:pre-wrap} #unsafe{margin:24px auto;max-width:1050px}</style><div class="readings"><article id="translation" class="sample"></article><article id="opinion" class="sample"></article></div><div id="unsafe" class="sample"></div><script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`;
const { chromium } = await loadPlaywright(), browser = await chromium.launch(browserOptions), page = await browser.newPage({ viewport: { width: 1300, height: 900 }, reducedMotion: 'reduce' });
const errors = [], requests = [], checks = [], check = name => { checks.push(name); console.log(name); };
page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
await page.route('http://127.0.0.1:9157/', route => route.fulfill({ contentType: 'text/html', body: html }));
try {
  await page.goto('http://127.0.0.1:9157/');
  await page.evaluate(() => {
    const colored = document.createElement('article'); colored.id = 'highlighted'; colored.className = 'sample'; document.querySelector('.readings').append(colored);
    const paragraph = '## Sentence color\n\n**Fixed sentence. Old sentence.** _Same end._\n\n- Fixed item.\n- Old item.';
    const ranges = window.diffSentenceRanges(paragraph, paragraph.replaceAll('Old', 'New')).current.ranges;
    window.highlightResult = window.renderMarkdown(colored, paragraph, { highlights: ranges });
    window.translationResult = window.renderMarkdown(document.getElementById('translation'), '# 译文阅读\n\n**量子态** ⟦P0_abc⟧ 的测量需要 $N_s=\\Theta(\\sqrt n)$ 份副本。\n\n\\[\\begin{pmatrix}1&0\\\\0&1\\end{pmatrix}\\]', { tokens: [{ id: '⟦P0_abc⟧', raw: '$\\ket{0}$' }], macros: { '\\ket': '\\lvert#1\\rangle' } });
    window.opinionResult = window.renderMarkdown(document.getElementById('opinion'), '# Paragraph opinion\n\nUse **distinct verbs** for $\\Tr(\\rho)$ and the operation in Eq. \\eqref{eq:main}.\n\n$$\\Pr[X\\ge t]\\le e^{-t^2/2}$$', { macros: { '\\Tr': '\\operatorname{Tr}' }, references: { labels: { 'eq:main': '4' }, citations: {} } });
    window.unsafeResult = window.renderMarkdown(document.getElementById('unsafe'), '<img src=x onerror="window.injected=true"> [external](https://example.org) ![image](https://example.org/a.png) $\\href{https://example.org}{x}$ $\\htmlClass{injected}{x}$');
  });
  assert.equal(await page.locator('#translation .katex').count(), 3, JSON.stringify(await page.evaluate(() => ({ result: window.translationResult, text: document.getElementById('translation').textContent })))); assert.equal(await page.locator('#opinion .katex').count(), 2);
  assert.equal(await page.locator('.katex-mathml math').count(), 5); assert.equal(await page.locator('#translation strong').textContent(), '量子态');
  assert.deepEqual(await page.evaluate(() => window.translationResult.diagnostics), []); assert.deepEqual(await page.evaluate(() => window.opinionResult.diagnostics), []);
  assert.deepEqual(await page.evaluate(() => window.highlightResult.diagnostics), []);
  assert.equal(await page.locator('#highlighted strong').count(), 1); assert.equal(await page.locator('#highlighted em').count(), 1); assert.equal(await page.locator('#highlighted li').count(), 2);
  assert.doesNotMatch(await page.locator('#highlighted').textContent(), /\*\*|_Same|\\mdhl/);
  assert.equal(await page.locator('#highlighted [data-changed=true]').first().evaluate(node => getComputedStyle(node).color), 'rgb(141, 71, 11)');
  check('both reading columns render real KaTeX HTML plus accessible MathML while Markdown prose remains selectable');
  assert.match(await page.locator('#opinion').textContent(), /Eq\. \(4\)/); assert.doesNotMatch(await page.locator('#translation').textContent(), /P0_abc/);
  check('current protected formulas and verified numeric reference context display without internal token IDs');
  await page.evaluate(() => {
    const projected = document.createElement('article'); projected.id = 'projected'; projected.className = 'sample'; document.querySelector('.readings').append(projected);
    window.projectionSource = String.raw`## Source-faithful formula reading

\label{thm:fixed}A label defines an anchor.

\begin{equation}\begin{split}\Ns&=\Tr(\rho)\\&=\ip{x}{y}\label{eq:main}\end{split}\end{equation}

The string is \mbox{$Z^v=\Tr(\rho)$}.`;
    window.projectionResult = window.renderMarkdown(projected, window.projectionSource, { macros: { '\\Ns': 'N_s', '\\Tr': '\\operatorname{Tr}', '\\ip': '\\langle#1,#2\\rangle' }, references: { labels: { 'eq:main': '4' }, citations: {} } });
  });
  assert.equal(await page.locator('#projected .katex').count(), 2); assert.equal(await page.locator('#projected .math-source').count(), 0);
  assert.deepEqual(await page.evaluate(() => window.projectionResult.diagnostics), []); assert.equal((await page.locator('#projected .katex-tag').textContent()).replace(/\s/g, ''), '(4)');
  assert.doesNotMatch(await page.locator('#projected').innerText(), /\\label\{|\\mbox\{/); assert.ok(await page.evaluate(() => window.projectionSource.includes('\\label{eq:main}') && window.projectionSource.includes('\\mbox{')));
  check('equation/split, verified numbering and math-only boxes render without changing source labels or wrappers');
  assert.equal(await page.locator('#unsafe img,#unsafe a,#unsafe script,#unsafe .injected').count(), 0); assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
  assert.ok((await page.evaluate(() => window.unsafeResult.diagnostics)).length > 0);
  check('HTML input, Markdown links/images and KaTeX external HTML extensions create no active or external content');
  await page.evaluate(() => document.fonts.ready);
  assert.ok(await page.evaluate(() => [...document.fonts].some(font => font.family.includes('KaTeX') && font.status === 'loaded')));
  assert.deepEqual(requests, ['http://127.0.0.1:9157/']);
  check('bundled KaTeX fonts load from inline data and reading causes no font/CDN/backend/model requests');
  assert.equal(await page.locator('canvas').count(), 0); assert.deepEqual(errors, []);
  check('the Markdown reading path creates no PDF canvas and reports no browser errors');
  await page.screenshot({ path: path.join(output, 'markdown-reading.png'), fullPage: true });
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ syntheticOnly: true, passed: checks.length, checks, errors, externalRequests: requests.slice(1), screenshot: 'markdown-reading.png' }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, report: path.join(output, 'report.json') }));
} finally { await browser.close(); }
