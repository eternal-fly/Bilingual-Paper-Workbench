import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { PaperApplication, buildInputHash } from '../src/application.mjs';
import { startLocalWeb } from '../src/local-web.mjs';
import { loadPlaywright, browserOptions } from './ui-qa-support.mjs';
import { loadMarkdownCss } from './markdown-css.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), output = path.join(root, 'work/ui-paragraph-math-intent-qa'); await mkdir(output, { recursive: true });
const run = await mkdtemp(path.join(output, 'case-')), paper = path.join(run, 'paper'); await mkdir(paper);
const source = String.raw`\documentclass{article}
\begin{document}

A synthetic claim uses $x=1$ and $y=2$ with \cite{one}.

\begin{thebibliography}{1}
\bibitem{one} A synthetic reference.
\end{thebibliography}
\end{document}
`;
await writeFile(path.join(paper, 'main.tex'), source);
const compiler = { probe: async () => ({ available: true, isolated: true }), build: async input => { const bytes = Buffer.from('%PDF-1.4\nSynthetic paragraph inventory PDF\n%%EOF'), pdfPath = path.join(run, randomUUID() + '.pdf'); await writeFile(pdfPath, bytes); return { buildId: 'build-' + randomUUID(), status: 'success', snapshotId: input.snapshotId, candidateHash: input.candidateHash, inputHash: buildInputHash(input), pdfPath, pdfHash: createHash('sha256').update(bytes).digest('hex'), isolation: { verified: true } }; } };
const app = new PaperApplication({ dataRoot: path.join(run, 'private'), compiler }); await app.initialize(); await app.openProject({ root: paper, mainFile: 'main.tex', sourceLanguage: 'en', targetLanguage: 'zh-CN' });
const paragraph = app.getState().readingParagraphs.find(item => item.source.includes('A synthetic claim'));
await app.saveDraft({ segmentId: paragraph.id, language: 'zh-CN', text: '结论使用 $x=1$ 和 $y=2$，见 \\cite{one}。', expectedRevision: 0 });
const edited = await app.saveTranslationDraftWithFormulaEdits({ segmentId: paragraph.id, language: 'zh-CN', text: '结论改为 $z=3$，新增 $a+b=4$，见 \\cite{one}。', expectedRevision: 1, expectedProjectId: app.getState().project.id, expectedSnapshotId: app.getState().project.snapshotId });
assert(edited.draft.formulaEditUnmapped || edited.draft.formulaEditsConflict);
const pdf = `export function openPdfDocument(){throw Error('PDF text extraction is outside this controller fixture')}export async function renderPdf(host){const canvas=document.createElement('canvas');host.append(canvas);return{pageCount:1,destroy:async()=>canvas.remove(),render:async()=>{},highlight:()=>true}};`;
const bundle = await build({ entryPoints: [path.join(root, 'ui/app.mjs')], bundle: true, format: 'iife', platform: 'browser', write: false, plugins: [{ name: 'synthetic-pdf-viewer', setup(builder) { builder.onResolve({ filter: /^\.\/pdf\.mjs$/ }, () => ({ path: 'synthetic-pdf', namespace: 'synthetic' })); builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({ contents: pdf, loader: 'js' })); } }] });
let html = await readFile(path.join(root, 'ui/index.html'), 'utf8'); html = html.replace(/<link[^>]*href="\.\/style\.css"[^>]*>/, `<style>${await loadMarkdownCss(root)}\n${await readFile(path.join(root, 'ui/style.css'), 'utf8')}</style>`).replace(/<script[^>]*src="\.\/app\.mjs"[^>]*><\/script>/, () => `<script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`);
const htmlPath = path.join(run, 'workbench.html'); await writeFile(htmlPath, html); const web = await startLocalWeb({ service: app, htmlPath });
const { chromium } = await loadPlaywright(), browser = await chromium.launch(browserOptions), page = await browser.newPage({ viewport: { width: 1550, height: 1000 } });
const errors = [], checks = [], check = text => { checks.push(text); console.log(text); }; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(web.url); await page.locator(`[data-unit-id="${paragraph.id}"]`).waitFor();
  assert.match(await page.locator(`[data-unit-id="${paragraph.id}"] .draft-message`).textContent(), /inventory.*confirmation|整段.*公式/s);
  assert.equal(await page.locator('#propose-selected').isDisabled(), false);
  check('a complete human paragraph rewrite remains eligible for a source suggestion and describes its automatic formula inventory');
  await page.locator('#propose-selected').click(); await page.locator('#request-math-review .math-intent-review').waitFor();
  assert.equal(await page.locator('#request-math-review .math-intent-inventory').count(), 2);
  assert.equal(await page.locator('#request-math-review .katex').count(), 4);
  const request = app.core.getState().requests.at(-1); assert(request.segments[0].paragraphMathIntent);
  assert.deepEqual(request.segments[0].mathReview.before, ['$x=1$', '$y=2$']); assert.deepEqual(request.segments[0].mathReview.after, ['$z=3$', '$a+b=4$']);
  assert.equal(await page.locator('#request-math-review input,#request-math-review textarea').count(), 0);
  check('the native revision request displays complete before and after math inventories without manual formula mapping controls');
  await page.locator('#request-dialog .close-dialog').click();
  const selected = request.segments[0], proposal = await app.proposeRevision({ requestId: request.requestId, edits: [{ segmentId: paragraph.id, beforeHash: selected.beforeHash, replacement: 'The revised synthetic claim uses ' + selected.protectedTokens.map(token => token.id).join(' and ') + '.' }], reason: 'Synthetic complete paragraph rewrite.' });
  await page.locator('#review-toggle').click(); await page.locator(`[data-proposal-id="${proposal.proposalId}"]`).click();
  await page.locator('#proposal-detail .math-intent-review').waitFor(); assert.equal(await page.locator('#proposal-detail .katex').count(), 4);
  check('the returned English proposal retains the same source-pinned math inventory for review');
  await page.locator('#preview-proposal').click(); await page.waitForFunction(() => !document.querySelector('#accept-proposal').disabled);
  await page.locator('#accept-proposal').click(); await page.locator('#acceptance-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#acceptance-diff .math-intent-review').count(), 1); assert.equal(await page.locator('#confirm-apply').isDisabled(), true);
  assert.equal(await readFile(path.join(paper, 'main.tex'), 'utf8'), source);
  check('the separately compiled human confirmation repeats the exact math inventory before any source write');
  await page.locator('#cancel-acceptance').click(); await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []); check('paragraph inventories preserve source bytes and narrow-screen geometry without uncaught browser errors');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ syntheticOnly: true, realBackend: true, mockedCompiler: true, passed: checks.length, checks, pageErrors: errors }, null, 2));
} catch (error) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
finally { await browser.close(); await web.close(); await app.close(); }
