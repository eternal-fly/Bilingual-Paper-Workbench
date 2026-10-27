import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, browserOptions, openTranslationEditor } from './ui-qa-support.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)), output = path.join(root, 'work/ui-compact-geometry-qa');
await mkdir(output, { recursive: true });
let html = await readFile(path.join(root, 'ui/index.html'), 'utf8');
html = html.replace(/<script[^>]*src="\.\/app\.mjs"[^>]*><\/script>/, '').replace(/<link[^>]*href="\.\/style\.css"[^>]*>/, `<style>${await readFile(path.join(root, 'ui/style.css'), 'utf8')}</style>`).replaceAll('../assets/paper-editor.svg', 'data:image/svg+xml;base64,' + (await readFile(path.join(root, 'assets/paper-editor.svg'))).toString('base64'));
const { chromium } = await loadPlaywright(), browser = await chromium.launch(browserOptions), page = await browser.newPage({ reducedMotion: 'reduce' });
const checks = [], geometry = [];
try {
  await page.setContent(html.replace('<html lang="en">','<html lang="zh-CN">'));
  await page.evaluate(() => {
    document.querySelector('#source-scroll').hidden = true;
    const source = document.createElement('p'); source.className = 'paragraph-text'; source.textContent = 'Synthetic English manuscript text.'; document.querySelector('#source-content').append(source);
    const input = document.createElement('div'); input.className = 'translation-input'; input.contentEditable = 'true'; input.textContent = '用于布局验证的合成译文。'; document.querySelector('#translation-content').append(input);
  });
  for (const width of [375, 900, 999, 1000, 1024, 1199, 1200, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    const value = await page.evaluate(() => {
      const rect = id => { const node = document.getElementById(id), r = node.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom, visible: getComputedStyle(node).display !== 'none' && r.width > 0 }; };
      return { viewport: innerWidth, source: rect('source-panel'), translation: rect('translation-panel'), notes: rect('annotation-panel'), pdf: rect('pdf-view'), translationScroll: rect('translation-scroll'), overflow: document.documentElement.scrollWidth > innerWidth, sourceFont: parseFloat(getComputedStyle(document.querySelector('.paragraph-text')).fontSize), translationFont: parseFloat(getComputedStyle(document.querySelector('.translation-input')).fontSize) };
    });
    assert.equal(value.overflow, false);
    if (width >= 1000) {
      assert.equal(value.notes.visible, true, `${width}: notes must be visible by default`); assert.equal(value.translation.visible, true);
      assert.equal(value.notes.width, width < 1200 ? 260 : 320); assert.equal(value.source.width, value.translation.width); assert.ok(value.source.width >= 330);
      assert.ok(value.source.right <= value.translation.left + 1); assert.ok(value.translation.right <= value.notes.left + 1); assert.ok(value.notes.right <= width);
      assert.equal(value.source.top, value.translation.top); assert.equal(value.source.bottom, value.translation.bottom); assert.equal(value.translation.top, value.notes.top); assert.equal(value.translation.bottom, value.notes.bottom); assert.equal(value.pdf.top, value.translationScroll.top); assert.equal(value.pdf.bottom, value.translationScroll.bottom);
      assert.ok(value.sourceFont >= 16); assert.ok(value.translationFont >= 16);
    } else assert.equal(value.notes.visible, false);
    geometry.push(value); checks.push(`${width}px default layout keeps its intended panes, boundaries, reading font size, and page width`); console.log(checks.at(-1));
    if ([1000, 1440].includes(width)) await page.screenshot({ path: path.join(output, `${width}.png`) });
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ syntheticOnly: true, staticDefaultHtml: true, noBackendOrModelCalls: true, passed: checks.length, checks, geometry }, null, 2));
} finally { await browser.close(); }
