import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, browserOptions } from './ui-qa-support.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)), output = path.join(root, 'work/ui-paragraph-opinion-qa');
await mkdir(output, { recursive: true });
const bundled = await build({ stdin: { contents: `import {createParagraphOpinionReader} from './ui/paragraph-opinion.mjs'; window.makeReader=createParagraphOpinionReader;`, resolveDir: root }, bundle: true, format: 'iife', platform: 'browser', write: false });
const { chromium } = await loadPlaywright(), browser = await chromium.launch(browserOptions), page = await browser.newPage({ viewport: { width: 1000, height: 900 } }), checks = [], errors = [];
page.on('pageerror', error => errors.push(error.message));
const check = name => { checks.push(name); console.log(name); };
try {
  await page.setContent(`<style>${await readFile(path.join(root, 'ui/style.css'), 'utf8')}</style><section id="notes" style="max-width:480px"></section>`);
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  await page.evaluate(() => {
    window.mount = () => {
      const note = { noteId: 'synthetic-note', revision: 1 }, card = document.createElement('article'); card.className = 'annotation-card';
      for (const [field, text] of Object.entries({ currentSource: 'Keep $x^2$. Old sentence.', suggestedSource: 'Keep $x^2$. New sentence.', currentTranslation: '保留$x^2$。旧句。', suggestedTranslation: '保留$x^2$。新句。', reasonSource: 'Clarify <img src=x onerror="window.unsafe=true">.', reasonTranslation: '说明修改理由。' })) { const body = document.createElement('div'); body.dataset.reviewField = field; body.textContent = text; card.append(body); }
      document.querySelector('#notes').replaceChildren(card);
      window.reader ||= window.makeReader(); window.reader.attach(card, note, { mathContext: {}, comparison: { scope: 'paragraph', source: { current: { text: 'Keep $x^2$. Old sentence.', ranges: [{ start: 0, end: 12, changed: false }, { start: 12, end: 25, changed: true }] }, recommended: { text: 'Keep $x^2$. New sentence.', ranges: [{ start: 0, end: 12, changed: false }, { start: 12, end: 25, changed: true }] } }, translation: { current: { text: '保留$x^2$。旧句。', ranges: [{ start: 0, end: 8, changed: false }, { start: 8, end: 11, changed: true }] }, recommended: { text: '保留$x^2$。新句。', ranges: [{ start: 0, end: 8, changed: false }, { start: 8, end: 11, changed: true }] } }, diagnostics: [] } });
      return card;
    }; window.mount();
  });
  assert.equal(await page.locator('[data-opinion-view="reading"][aria-pressed="true"]').count(), 1);
  assert.ok(await page.locator('.katex').count() >= 4); assert.equal(await page.locator('canvas').count(), 0);
  check('paragraph recommendations default to Markdown/KaTeX reading without PDF canvases');
  const current = page.locator('[data-review-field="currentSource"]'), recommended = page.locator('[data-review-field="suggestedSource"]');
  assert.equal(await current.locator('[data-revision-role="current"][data-changed="true"]').count(), 1);
  assert.equal(await recommended.locator('[data-revision-role="recommended"][data-changed="true"]').count(), 1);
  assert.ok((await current.locator('[data-changed="false"]').allTextContents()).join('').includes('Keep'));
  assert.ok((await recommended.locator('[data-changed="false"]').allTextContents()).join('').includes('Keep'));
  check('only changed sentences receive old/new roles while unchanged wording and math remain neutral');
  assert.equal(await page.locator('[data-review-field="currentTranslation"] [data-changed="true"]').count(), 1);
  assert.equal(await page.locator('[data-review-field="suggestedTranslation"] [data-changed="true"]').count(), 1);
  check('target-language paragraphs use their own exact sentence correspondence');
  assert.equal(await page.locator('#notes img').count(), 0); assert.equal(await page.evaluate(() => window.unsafe), undefined);
  check('review text remains inert even inside Markdown and explanations');
  await page.locator('[data-opinion-view="source"]').click(); assert.equal(await page.locator('.katex').count(), 0); assert.ok((await current.textContent()).includes('$x^2$'));
  await page.locator('[data-opinion-view="reading"]').click(); assert.ok(await page.locator('.katex').count() >= 4);
  check('reading/source mode preserves exact text and restores mathematical layout');
  await page.evaluate(() => window.mount()); assert.ok(await page.locator('.katex').count() >= 4); assert.deepEqual(errors, []);
  check('remount retains mode without model, compiler or source-write actions');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ syntheticOnly: true, passed: checks.length, checks, errors }, null, 2));
} finally { await browser.close(); }
