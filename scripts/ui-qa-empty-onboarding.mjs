import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, browserOptions } from './ui-qa-support.mjs';
import { loadMarkdownCss } from './markdown-css.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)), output = path.join(root, 'work/ui-empty-onboarding-qa'); await mkdir(output, { recursive: true });
const bridge = `export const getHostState=()=>window.__host;export const api=(action,payload={})=>window.__api(action,payload);export const sendToHost=async()=>{throw Error('No message was requested')};export const subscribe=fn=>{window.__publish=fn;return()=>{}};`;
const bundle = await build({ entryPoints: [path.join(root, 'ui/app.mjs')], bundle: true, platform: 'browser', format: 'iife', write: false, define: { __PDF_WORKER_SOURCE__: "''" }, plugins: [{ name: 'empty-onboarding-fixture', setup(builder) { builder.onResolve({ filter: /^\.\/bridge\.mjs$/ }, args => ({ path: args.path, namespace: 'fixture' })); builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: bridge, loader: 'js' })); } }] });
let html = await readFile(path.join(root, 'ui/index.html'), 'utf8'); html = html.replace(/<link[^>]*href="\.\/style\.css"[^>]*>/, `<style>${await loadMarkdownCss(root)}\n${await readFile(path.join(root, 'ui/style.css'), 'utf8')}</style>`).replace(/<script[^>]*src="\.\/app\.mjs"[^>]*><\/script>/, () => `<script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`).replaceAll('../assets/paper-editor.svg', 'data:image/svg+xml;base64,' + (await readFile(path.join(root, 'assets/paper-editor.svg'))).toString('base64'));
const { chromium } = await loadPlaywright(), browser = await chromium.launch(browserOptions), page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' }), checks = [], errors = [];
const check = name => { checks.push(name); console.log(name); }; page.on('pageerror', error => errors.push(error.message));
await page.route('http://127.0.0.1:9163/', route => route.fulfill({ contentType: 'text/html', body: html }));
await page.addInitScript(() => {
  window.__calls = []; window.__host = { mode: 'native-window', connected: true, canSendMessage: false, directChat: false };
  window.__state = { project: null, segments: [], readingParagraphs: [], translations: {}, proposals: [], transactions: [], jobs: [], comments: [], requests: [], builds: [], reviewNotes: [], reviewBatches: [], capabilities: { codexChat: false, secureCompile: false }, chat: { busy: false, status: 'idle', connected: false }, languagePreferences: { revision: 0, uiLanguage: 'en', translationLanguage: 'zh-CN', effectiveTargetLanguage: 'zh-CN' } };
  window.__api = async action => { window.__calls.push(action); if (action === 'state') return structuredClone(window.__state); throw Error('Unexpected empty-workbench action ' + action); };
});
try {
  await page.goto('http://127.0.0.1:9163/'); await page.waitForFunction(() => window.__calls.includes('state'));
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.ok((await page.locator('#pdf-empty-note').textContent()).includes('source ZIP'));
  assert.ok(!/[\u4e00-\u9fff]/u.test(await page.locator('#pdf-empty').textContent()));
  assert.ok(!/[\u4e00-\u9fff]/u.test(await page.locator('#translation-content .empty-state').textContent()));
  check('a new unbound workbench starts in English with source ZIP and review import guidance');
  assert.equal(await page.locator('#load-pdf').isEnabled(), true); await page.locator('#load-pdf').click(); await page.locator('#project-dialog').waitFor({ state: 'visible' });
  assert.ok((await page.locator('#project-dialog').textContent()).includes('Open')); await page.keyboard.press('Escape');
  check('the first-use primary action opens project selection before any compiler or model request');
  assert.ok(!(await page.locator('#host-badge').textContent()).includes('connection card'));
  assert.ok(!/[\u4e00-\u9fff]/u.test(await page.locator('#connection-status').textContent()));
  check('an empty independent window explains its unselected project without requiring a chat connection card');
  for (const width of [800, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const labels = await page.evaluate(() => [...document.querySelectorAll('.rail-tool>span:not(.count),.rail-menu>summary>span')].filter(node => /^[A-Za-z]+$/.test(node.textContent.trim())).map(node => { const range = document.createRange(); range.selectNodeContents(node); return { text: node.textContent, lines: new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size, wrap: getComputedStyle(node).overflowWrap }; }));
    assert.ok(labels.every(label => label.lines === 1 && label.wrap !== 'anywhere'), JSON.stringify(labels)); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  check('English rail labels keep complete words at compact and full window widths without horizontal overflow');
  for (const theme of ['light', 'dark']) { await page.locator('#theme').selectOption(theme); await page.screenshot({ path: path.join(output, `empty-${theme}-english.png`) }); }
  assert.equal(await page.evaluate(() => window.__calls.some(action => action !== 'state')), false); assert.deepEqual(errors, []);
  check('empty-state reading and theme changes issue no model, import, compile or source mutation calls and no page errors');
  const originalDocument = await page.evaluate(() => performance.timeOrigin);
  const pollsBeforeImport = await page.evaluate(() => window.__calls.filter(action => action === 'state').length);
  await page.evaluate(() => {
    const paragraph = { id: 'imported-p1', path: 'imported.tex', source: 'Imported source paragraph.', displayText: 'Imported source paragraph.', sourceHash: '1'.repeat(64), beforeHash: '1'.repeat(64), translatable: true, writableSource: true, protectedTokens: [], sourceSegmentIds: ['imported-p1'] };
    Object.assign(window.__state, {
      project: { id: 'imported-project', rootLabel: 'Imported paper', mainFile: 'imported.tex', snapshotId: 'imported-snapshot', sourceLanguage: 'en', targetLanguage: 'zh-CN' },
      segments: [paragraph], readingParagraphs: [paragraph],
      translations: { 'zh-CN': { 'imported-p1': { text: '后台导入后的译文。', revision: 1, status: 'machineTranslated' } } },
      reviewNotes: [{ noteId: 'imported-note', origin: 'external', revision: 1, title: 'Imported review', body: '请澄清这一导入段落。', sourceSegmentIds: ['imported-p1'], sourceSnapshotId: 'imported-snapshot' }]
    });
    // A separate native import changes only the backend. Do not notify the UI,
    // navigate, reload, press Refresh, or call its adoption function here.
  });
  await page.waitForFunction(() => document.querySelector('#main-file').textContent === 'imported.tex' && document.querySelector('[data-unit-id="imported-p1"]'), null, { timeout: 3500 });
  assert.ok(await page.evaluate(count => window.__calls.filter(action => action === 'state').length > count, pollsBeforeImport));
  assert.ok((await page.locator('[data-unit-id="imported-p1"] .translation-reading').textContent()).includes('后台导入后的译文'));
  assert.equal(await page.locator('[data-note-id="imported-note"]').count(), 1);
  assert.equal(await page.evaluate(() => performance.timeOrigin), originalDocument);
  assert.equal(await page.evaluate(() => window.__calls.some(action => action !== 'state')), false); assert.deepEqual(errors, []);
  check('the initially empty window automatically adopts an out-of-band background import by state polling without reload, manual refresh or model calls');
  const refreshCount = await page.evaluate(() => { window.__state.capabilities.codexChat = true; window.__host = { mode: 'local-preview', connected: false, canSendMessage: false }; return window.__calls.length; });
  await page.waitForFunction(count => window.__calls.length > count, refreshCount);
  await page.waitForFunction(() => !document.querySelector('#full-review-open').disabled);
  await page.evaluate(() => window.__publish(null)); // A late host callback is not followed by render/applyLanguages.
  await page.locator('[data-unit-id="imported-p1"] .translation-reading').click(); // Selection/save-state callbacks also run outside render().
  const controls = ['host-badge', 'translation-heading', 'annotation-selection', 'comments-open', 'paragraph-review-run', 'review-run-status', 'selected-label', 'save-status'];
  const controlText = await page.evaluate(ids => Object.fromEntries(ids.map(id => [id, document.getElementById(id).textContent])), controls);
  assert.ok(Object.values(controlText).every(text => !/[\u4e00-\u9fff]/u.test(text)), JSON.stringify(controlText));
  assert.equal(controlText['translation-heading'], 'Translation editor');
  assert.ok(!/[\u4e00-\u9fff]/u.test(await page.locator('[data-note-id="imported-note"] .annotation-provenance').textContent()));
  assert.equal((await page.locator('[data-note-id="imported-note"] [data-review-field="body"]').textContent()).trim(), '请澄清这一导入段落。');
  assert.equal(await page.evaluate(() => window.__state.reviewNotes[0].body), '请澄清这一导入段落。');
  assert.ok(controlText['host-badge'].includes('Codex')); assert.ok(controlText['selected-label'].startsWith('Selected'));
  assert.equal(await page.locator('[data-unit-id="imported-p1"] .translation-input').evaluate(node => node.value), '后台导入后的译文。');
  assert.equal(await page.evaluate(() => window.__calls.some(action => action !== 'state')), false); assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'imported-selection-english.png') });
  check('late host, paragraph selection and save-status renders keep English controls while Chinese manuscript text remains verbatim');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ syntheticOnly: true, passed: checks.length, checks, errors }, null, 2));
} finally { await browser.close(); }
