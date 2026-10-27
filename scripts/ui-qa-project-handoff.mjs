import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, browserOptions } from './ui-qa-support.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), output = path.join(root, 'work/ui-project-handoff-qa'); await mkdir(output, { recursive: true });
const bundle = await build({ entryPoints: [path.join(root, 'ui/app.mjs')], bundle: true, format: 'iife', platform: 'browser', write: false, define: { __PDF_WORKER_SOURCE__: "''" } });
let html = await readFile(path.join(root, 'ui/index.html'), 'utf8'); html = html.replace(/<link[^>]*href="\.\/style\.css"[^>]*>/, `<style>${await readFile(path.join(root, 'ui/style.css'), 'utf8')}</style>`).replace(/<script[^>]*src="\.\/app\.mjs"[^>]*><\/script>/, () => `<script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`).replaceAll('../assets/paper-editor.svg', 'data:image/svg+xml;base64,' + (await readFile(path.join(root, 'assets/paper-editor.svg'))).toString('base64'));
const session = 'a'.repeat(43), handoffId = 'b'.repeat(48), returnUrl = 'http://127.0.0.1:9444/#session=' + 'c'.repeat(43);
const state = { project: { id: 'synthetic-paper-b', snapshotId: 'snapshot-b', mainFile: 'paper-b.tex', rootLabel: 'Selected paper B', sourceLanguage: 'en', targetLanguage: 'zh-CN' }, segments: [{ id: 'b-paragraph', path: 'paper-b.tex', source: 'A synthetic selected paper paragraph.', displayText: 'A synthetic selected paper paragraph.', translatable: true, protectedTokens: [] }], translations: { 'zh-CN': { 'b-paragraph': { text: 'Selected B draft.', revision: 1 } } }, proposals: [], builds: [], jobs: [], requests: [], transactions: [], workspaceIndex: { currentRecordId: 'record-b' }, nativeChatBinding: { threadId: 'chat-b', title: 'Selected B chat', model: 'gpt-6-astra' }, capabilities: { backgroundConnection: true, codexChat: false, secureCompile: false } };
const { chromium } = await loadPlaywright(), browser = await chromium.launch(browserOptions), checks = [], errors = [], pages = [], check = text => { checks.push(text); console.log(text); };
async function open(fragment, acknowledgement = { acknowledged: true }, savedSession = false) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), calls = [];
  pages.push(page); page.on('pageerror', error => errors.push(error.message));
  if (savedSession) await page.addInitScript(session => sessionStorage.setItem('paper-editor-session', session), session);
  await page.route('http://127.0.0.1:9333/**', async route => {
    const request = route.request();
    if (new URL(request.url()).pathname !== '/api') { await route.fulfill({ contentType: 'text/html', body: html }); return; }
    const input = request.postDataJSON(); calls.push({ action: input.action, payload: input.payload, authorization: request.headers().authorization });
    if (input.action === 'state') { await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, state, result: state }) }); return; }
    if (input.action === 'ackProjectWindow') {
      assert.equal(await page.locator('#main-file').textContent(), 'paper-b.tex');
      assert.equal(await page.locator('#translation-content').textContent().then(text => text.includes('Selected B draft.')), true);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, result: acknowledgement }) }); return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'UNEXPECTED_TEST_ACTION', message: input.action } }) });
  });
  await page.route('http://127.0.0.1:9444/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Original paper restored</title><p>Original synthetic paper restored.</p>' }));
  await page.goto('http://127.0.0.1:9333/' + fragment); return { page, calls };
}
try {
  const selected = await open('#session=' + session + '&handoff=' + handoffId);
  await selected.page.waitForFunction(() => location.hash === '');
  const ack = selected.calls.find(call => call.action === 'ackProjectWindow'); assert(ack); assert.deepEqual(ack.payload, { handoffId });
  assert(selected.calls.every(call => call.authorization === 'Bearer ' + session));
  check('the local bridge separates the bearer session from the one-use project handoff nonce');
  await selected.page.waitForTimeout(1100); assert.equal(selected.calls.filter(call => call.action === 'ackProjectWindow').length, 1);
  assert.equal(await selected.page.evaluate(() => sessionStorage.getItem('paper-editor-session')), session);
  check('the destination acknowledges only after its selected paper and draft render, then clears the nonce without repeated acknowledgements');
  const canonical = await open('#session=' + session); await canonical.page.locator('#main-file').filter({ hasText: 'paper-b.tex' }).waitFor();
  await canonical.page.waitForTimeout(1100); assert.equal(canonical.calls.some(call => call.action === 'ackProjectWindow'), false);
  check('an already open canonical project page never acknowledges another window switch');
  const malformed = await open('#session=' + session + '&session=' + session, { acknowledged: true }, true);
  await malformed.page.waitForFunction(() => document.querySelector('#notice').textContent.includes('SESSION_FRAGMENT_INVALID'));
  assert.equal(malformed.calls.length, 0);
  check('duplicate or malformed session fragments fail closed instead of falling back to an older stored session');
  const rollback = await open('#session=' + session + '&handoff=' + handoffId, { acknowledged: false, returnUrl });
  await rollback.page.waitForURL('http://127.0.0.1:9444/**'); assert.equal(await rollback.page.title(), 'Original paper restored');
  assert.equal(rollback.calls.filter(call => call.action === 'ackProjectWindow').length, 1);
  check('a failed handoff returns this same window to the validated original paper capability');
  const unsafe = await open('#session=' + session + '&handoff=' + handoffId, { acknowledged: false, returnUrl: 'https://example.com/' });
  await unsafe.page.waitForFunction(() => document.querySelector('#notice').textContent.includes('PROJECT_HANDOFF_UNCONFIRMED'));
  assert.equal(new URL(unsafe.page.url()).port, '9333'); assert.equal(unsafe.calls.filter(call => call.action === 'ackProjectWindow').length, 1);
  check('an untrusted rollback address cannot navigate the workbench away from its local paper');
  assert.deepEqual(errors, []); check('the strict local bridge and two-phase project handoff produce no uncaught browser errors');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ syntheticOnly: true, realUiBridge: true, mockedBackend: true, passed: checks.length, checks, pageErrors: errors }, null, 2));
} finally { await Promise.all(pages.map(page => page.close())); await browser.close(); }
