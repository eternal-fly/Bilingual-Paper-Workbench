import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadPlaywright, browserOptions } from './ui-qa-support.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'work/ui-synctex-qa'); await mkdir(output, { recursive: true });
function vectorPdf() {
  const streams = ['q 0.15 0.35 0.72 rg 25 280 200 50 re f Q', 'q 0.1 0.5 0.3 rg 50 180 180 60 re f Q'];
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> /Contents 4 0 R >>', `<< /Length ${streams[0].length} >>\nstream\n${streams[0]}\nendstream`, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> /Contents 6 0 R >>', `<< /Length ${streams[1].length} >>\nstream\n${streams[1]}\nendstream`];
  let body = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body); body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
const pdf = vectorPdf(), pdfHash = createHash('sha256').update(pdf).digest('hex');
const bridge = `export const getHostState=()=>({mode:'local-preview',connected:false});export const api=(action,payload={})=>window.__paperApi(action,payload);export const sendToHost=async()=>{};export const subscribe=()=>()=>{};`;
const worker = await readFile(path.join(root, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'), 'utf8');
const bundle = await build({ entryPoints: [path.join(root, 'ui/app.mjs')], bundle: true, format: 'iife', platform: 'browser', write: false, define: { __PDF_WORKER_SOURCE__: JSON.stringify(worker) }, plugins: [{ name: 'synthetic-bridge', setup(builder) { builder.onResolve({ filter: /^\.\/bridge\.mjs$/ }, () => ({ path: 'synthetic-bridge', namespace: 'synthetic' })); builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({ contents: bridge, loader: 'js' })); } }] });
let html = await readFile(path.join(root, 'ui/index.html'), 'utf8');
html = html.replace(/<link[^>]*href="\.\/style\.css"[^>]*>/, `<style>${await readFile(path.join(root, 'ui/style.css'), 'utf8')}</style>`).replace(/<script[^>]*src="\.\/app\.mjs"[^>]*><\/script>/, () => `<script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`);
const { chromium } = await loadPlaywright(), browser = await chromium.launch(browserOptions), page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on('pageerror', error => errors.push(error.message)); const checks = [], check = name => { checks.push(name); console.log(name); };
await page.evaluate(({ base64, pdfHash }) => {
  const segments = ['First synthetic source.', 'Second synthetic source.'].map((source, i) => ({ id: `seg-${i + 1}`, source, visibleText: source, displayText: source, path: 'main.tex', translatable: true, protectedTokens: [], beforeHash: String(i + 1).repeat(64) }));
  window.__paperState = {languagePreferences:{revision:1,uiLanguage:'zh-CN',translationLanguage:'zh-CN',effectiveTargetLanguage:'zh-CN'}, project: { id: 'synthetic-synctex', mainFile: 'main.tex', rootLabel: 'Synthetic SyncTeX fixture', sourceLanguage: 'en', targetLanguage: 'zh-CN', snapshotId: 'snapshot-current' }, segments, translations: {}, proposals: [], builds: [{ buildId: 'build-current', kind: 'english', status: 'success', snapshotId: 'snapshot-current', pdfHash, isolation: { verified: true } }], jobs: [], transactions: [], capabilities: { secureCompile: true, directApply: false, codexChat: false } };
  window.__paperCalls = []; window.__locationOverride = null;
  window.__paperApi = async (action, payload = {}) => {
    window.__paperCalls.push({ action, payload }); const state = window.__paperState;
    if (action === 'state') return structuredClone(state);
    if (action === 'readPdf') return { base64, hash: pdfHash, provenance: 'verified-isolated-build', buildId: 'build-current', snapshotId: state.project.snapshotId };
    if (action === 'locateSource') return { buildId: 'build-current', snapshotId: state.project.snapshotId, pdfHash: window.__locationOverride === 'wrong-hash' ? 'f'.repeat(64) : pdfHash, verified: true, method: 'synctex', sourcePath: 'main.tex', line: 12, column: 0, matches: [{ page: 1, x: 25, y: 70, h: 25, v: 120, width: 200, height: 50 }, { page: 2, x: 50, y: 160, h: 50, v: 220, width: 180, height: 60 }] };
    if (action === 'locatePdf') return { buildId: 'build-current', snapshotId: state.project.snapshotId, pdfHash, verified: true, method: 'synctex', ambiguous: true, matches: [{ sourcePath: 'main.tex', line: 12, column: 0, segmentIds: ['seg-1'] }, { sourcePath: 'main.tex', line: 20, column: 0, segmentIds: ['seg-2'] }] };
    throw new Error(`Unsupported synthetic action ${action}`);
  };
}, { base64: pdf.toString('base64'), pdfHash });
try {
  await page.setContent(html.replace('<html lang="en">','<html lang="zh-CN">')); await page.waitForFunction(() => document.getElementById('view-pdf').getAttribute('aria-pressed') === 'true'); await page.locator('#view-source').click(); await page.locator('#jump-to-pdf').click();
  await page.locator('#synctex-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#synctex-choices button').count(), 2); assert.equal(await page.locator('.pdf-location-overlay:visible').count(), 0);
  check('forward mapping shows every precise match and does not choose the first silently');
  await page.locator('#synctex-choices button').nth(1).click(); await page.waitForFunction(() => document.getElementById('pdf-page-label').textContent === '2 / 2');
  const overlay = page.locator('.pdf-location-overlay'); await overlay.waitFor({ state: 'visible' });
  assert.ok(Math.abs(await overlay.evaluate(node => Number.parseFloat(node.style.left)) - 100 * 50 / 300) < .001); assert.equal(await overlay.evaluate(node => Number.parseFloat(node.style.top)), 40);
  check('selected SyncTeX box uses h and v-height in top-left PDF point coordinates');
  await page.locator('#pdf-zoom').selectOption('1.5'); await page.waitForFunction(() => document.querySelector('#pdf-container canvas').width === 450); await overlay.waitFor({ state: 'visible' });
  assert.equal(await overlay.evaluate(node => Number.parseFloat(node.style.top)), 40); check('PDF highlight remains aligned after zoom and responsive canvas scaling');
  await page.locator('#pdf-previous').click(); await page.waitForFunction(() => document.getElementById('pdf-page-label').textContent === '1 / 2');
  const canvas = page.locator('#pdf-container canvas'), box = await canvas.boundingBox(); await canvas.click({ position: { x: box.width * .25, y: box.height * .5 } });
  await page.locator('#synctex-dialog').waitFor({ state: 'visible' });
  const inverse = await page.evaluate(() => window.__paperCalls.filter(call => call.action === 'locatePdf').at(-1).payload);
  assert.ok(Math.abs(inverse.x - 75) < 1); assert.ok(Math.abs(inverse.y - 200) < 1); assert.equal(inverse.page, 1);
  assert.equal(await page.locator('#source-seg-1').getAttribute('class').then(value => value.includes('selected')), true);
  await page.locator('#synctex-choices button').nth(1).click(); assert.ok((await page.locator('#source-seg-2').getAttribute('class')).includes('selected'));
  check('inverse click converts CSS coordinates to PDF points and requires explicit source choice');
  await canvas.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter'); await page.locator('#synctex-dialog').waitFor({ state: 'visible' });
  const keyboard = await page.evaluate(() => window.__paperCalls.filter(call => call.action === 'locatePdf').at(-1).payload); assert.equal(keyboard.x, 162); assert.equal(keyboard.y, 200); await page.keyboard.press('Escape');
  check('keyboard point selection provides an accessible inverse navigation path');
  await page.evaluate(() => { window.__locationOverride = 'wrong-hash'; }); await page.locator('#locate-source').click();
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('定位证据已变化')); assert.equal(await page.locator('#synctex-dialog').isVisible(), false);
  check('a mismatched displayed PDF hash refuses navigation rather than drawing stale anchors');
  await page.evaluate(() => { window.__paperState.project.snapshotId = 'snapshot-next'; window.__paperState.builds[0].stale = true; });
  await page.waitForFunction(() => document.getElementById('jump-to-pdf').disabled && document.getElementById('locate-source').disabled); assert.equal(await canvas.count(), 0);
  check('source version changes discard the PDF and disable exact navigation');
  assert.deepEqual(errors, []); check('PDF rendering and navigation have no uncaught browser errors');
  await page.screenshot({ path: path.join(output, 'navigation.png') }); await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: checks.length, syntheticOnly: true, mockedMappingEvidence: true, nativeSyncTeXUnverified: true, checks }, null, 2));
} catch (error) { await page.screenshot({ path: path.join(output, 'failure.png') }); throw error; }
finally { await browser.close(); }
