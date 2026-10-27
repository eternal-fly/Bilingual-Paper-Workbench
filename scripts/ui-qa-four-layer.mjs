import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { PaperApplication, buildInputHash } from '../src/application.mjs';
import { startLocalWeb } from '../src/local-web.mjs';
import { loadPlaywright, browserOptions, openTranslationEditor } from './ui-qa-support.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'work/ui-four-layer-qa');
await mkdir(output, { recursive: true });
const run = await mkdtemp(path.join(output, 'case-')), paper = path.join(run, 'paper');
await mkdir(paper);
const english = 'An original claim preserves $x=1$ and \\cite{example}.', chinese = '原始翻译保留 $x=1$ 与 \\cite{example}。';
const sourceText = '\\documentclass{article}\n\\newcommand{\\eng}{\\noindent{\\normalfont\\sffamily\\scriptsize\\color{Muted}EN}\\enspace\\ignorespaces}\n\\newcommand{\\chin}{\\noindent{\\normalfont\\sffamily\\scriptsize\\color{Muted}中}\\enspace\\ignorespaces}\n\\begin{document}\n\n' + `\\eng ${english}\\par\\chin ${chinese}` + '\n\n\\end{document}\n';
const before = Buffer.from(sourceText), sourceFile = path.join(paper, 'main.tex');
await writeFile(sourceFile, before);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Deliberately synthetic dependencies: this verifies UI/controller behavior only.
const compiler = {
  probe: async () => ({ available: true, isolated: true }),
  build: async input => {
    const bytes = Buffer.from('%PDF-1.4\n% Synthetic four-layer UI controller fixture\n%%EOF\n'), pdfPath = path.join(run, `${randomUUID()}.pdf`);
    await writeFile(pdfPath, bytes);
    return { buildId: `build-${randomUUID()}`, status: 'success', snapshotId: input.snapshotId, candidateHash: input.candidateHash, inputHash: buildInputHash(input), pdfPath, pdfHash: hash(bytes), isolation: { verified: true } };
  }
};
const writer = {
  async write(input, hooks) {
    assert.equal(path.resolve(input.root), path.resolve(paper));
    for (const file of input.readSet) { const filename = path.resolve(input.root, file.path); assert.ok(filename.startsWith(path.resolve(paper) + path.sep)); assert.equal(hash(await readFile(filename)), file.hash); }
    await hooks.onLocked?.();
    for (const file of input.changes) { const filename = path.resolve(input.root, file.path); assert.ok(filename.startsWith(path.resolve(paper) + path.sep)); assert.equal(hash(await readFile(filename)), file.beforeHash); await writeFile(filename, file.bytes); await hooks.onProgress?.({ path: file.path, hash: file.hash }); }
  }
};
const app = new PaperApplication({ dataRoot: path.join(run, 'private'), compiler, writer });
await app.initialize(); await app.openProject({ root: paper, mainFile: 'main.tex', sourceLanguage: 'en', targetLanguage: 'zh-CN' });
const segment = app.getState().segments.find(source => source.source === english);
assert.ok(segment, 'The real bilingual importer must expose the exact English source interval.');
assert.equal(app.getState().translations['zh-CN'][segment.id].text, chinese);
const draftText = '人工意图草稿，保持公式 $x=1$ 和引用 \\cite{example}。';
await app.saveDraft({ segmentId: segment.id, language: 'zh-CN', text: draftText, expectedRevision: 1 });
const request = await app.createRequest({ kind: 'revision', segmentIds: [segment.id] });
const ai = await app.proposeRevision({ requestId: request.requestId, edits: [{ segmentId: segment.id, beforeHash: segment.beforeHash, replacement: segment.displayText.replace('original claim', 'precise original claim') }], reason: 'Synthetic AI rationale remains attached to the original suggestion.' });

const bundle = await build({ entryPoints: [path.join(root, 'ui/app.mjs')], bundle: true, format: 'iife', platform: 'browser', write: false, define: { __PDF_WORKER_SOURCE__: "''" } });
let html = await readFile(path.join(root, 'ui/index.html'), 'utf8');
html = html.replace(/<link[^>]*href="\.\/style\.css"[^>]*>/, `<style>${await readFile(path.join(root, 'ui/style.css'), 'utf8')}</style>`).replace(/<script[^>]*src="\.\/app\.mjs"[^>]*><\/script>/, () => `<script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`);
const htmlPath = path.join(run, 'workbench.html'); await writeFile(htmlPath, html);
const web = await startLocalWeb({ service: app, htmlPath });
const { chromium } = await loadPlaywright();
const browser = await chromium.launch(browserOptions);
const page = await browser.newPage({ viewport: { width: 1480, height: 1000 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const checks = [], check = name => { checks.push(name); console.log(name); };
const until = async predicate => { const end = Date.now() + 12000; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for real backend state.'); await new Promise(resolve => setTimeout(resolve, 40)); } };
async function verifyOriginals() {
  assert.ok((await page.locator('#layer-original-source').innerText()).includes(english));
  assert.ok((await page.locator('#layer-original-translation').innerText()).includes(chinese));
  assert.equal(await page.locator('#layer-original-source [contenteditable="true"], #layer-original-source textarea, #layer-original-source input, #layer-original-translation [contenteditable="true"], #layer-original-translation textarea, #layer-original-translation input').count(), 0);
}
async function confirmReadyCandidate() {
  await page.waitForFunction(() => !document.getElementById('accept-proposal').disabled);
  await page.locator('#accept-proposal').click(); await page.locator('#acceptance-dialog').waitFor({ state: 'visible' });
  await page.locator('#acceptance-reviewed').check(); await page.locator('#confirm-apply').click();
  await page.locator('#acceptance-dialog').waitFor({ state: 'hidden' });
}
try {
  await page.addInitScript(()=>{localStorage.setItem('paper-editor-ui-language-explicit-v1','zh-CN');}); // Explicit legacy Chinese fixture; production defaults to English.
  await page.goto(web.url); await page.locator('#view-source').click(); await page.locator('#show-layers').click(); await page.locator(`#source-${segment.id}`).waitFor(); await page.locator(`#source-${segment.id}`).click();
  await page.locator('#four-layer-view').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#show-layers').getAttribute('aria-pressed'), 'true');
  await verifyOriginals();
  assert.ok((await page.locator('#layer-suggestions').innerText()).includes(ai.reason));
  assert.ok((await page.locator('#layer-suggestions').innerText()).includes('AI'));
  assert.equal((await page.locator('#layer-final-status').innerText()).trim(), '尚未写回');
  check('explicit four-layer comparison keeps original English and original translation immutable with AI provenance');

  await page.locator('#layer-edit-final').click(); await page.locator('#edit-proposal-dialog').waitFor({ state: 'visible' });
  const candidate = page.locator(`.candidate-edit-input[data-segment-id="${segment.id}"]`);
  assert.equal(await candidate.evaluate(node=>node.tagName),'TEXTAREA');assert.equal(await candidate.locator('.protected-object').count(),0);
  await candidate.evaluate(node => node.focusAt(0));
  await page.keyboard.insertText('Final author choice: '); await page.locator('#edit-proposal-reason').fill('Synthetic final author choice.');
  await page.locator('#save-edited-proposal').click(); await page.locator('#edit-proposal-dialog').waitFor({ state: 'hidden' });
  await until(() => app.getState().proposals.some(proposal => proposal.supersedes === ai.proposalId));
  let final = app.getState().proposals.find(proposal => proposal.supersedes === ai.proposalId);
  assert.equal(final.author, 'mixed');
  assert.ok((await page.locator('#layer-final').innerText()).includes('Final author choice: '));
  assert.ok((await page.locator('#layer-suggestions').innerText()).includes(ai.reason));
  assert.ok(!(await page.locator('#layer-suggestions').innerText()).includes('Final author choice: '));
  await verifyOriginals();
  check('final-layer editing uses free inline TeX and retains the separate original AI suggestion');

  await page.locator('#show-drafts').click();
  const draft = page.locator(`#translation-${segment.id} .translation-input`); await openTranslationEditor(page,draft);
  assert.equal(await draft.evaluate(node => node.value), draftText);
  await draft.evaluate(node => node.focusAt(0));
  await page.keyboard.insertText('保留切换缓冲：'); await page.keyboard.press('Control+s');
  await until(() => app.getState().translations['zh-CN'][segment.id].text.startsWith('保留切换缓冲：'));
  await page.locator('#show-layers').click(); await page.locator('#four-layer-view').waitFor({ state: 'visible' }); await verifyOriginals();
  assert.ok((await page.locator('#layer-final').innerText()).includes('Final author choice: '));
  await page.locator('#show-drafts').click(); assert.ok((await draft.evaluate(node => node.value)).startsWith('保留切换缓冲：')); await page.locator('#show-layers').click();
  check('switching draft and four-layer views preserves independent author buffers and original snapshots');

  const previousFinal = final;
  await assert.rejects(app.previewTransaction({ proposalIds: [previousFinal.proposalId] }), { code: 'VERSION_CONFLICT' });
  assert.deepEqual(await readFile(sourceFile), before);
  const freshRequest = await app.createRequest({ kind: 'revision', segmentIds: [segment.id] });
  assert.equal(freshRequest.segments[0].translationDraft.text, app.getState().translations['zh-CN'][segment.id].text);
  const freshAi = await app.proposeRevision({ requestId: freshRequest.requestId, edits: [{ segmentId: segment.id, beforeHash: segment.beforeHash, replacement: segment.displayText.replace('original claim', 'precise original claim') }], reason: 'Fresh synthetic AI suggestion pinned to the newly saved author buffer.' });
  final = await app.editProposal({ proposalId: freshAi.proposalId, edits: previousFinal.edits.map(edit => ({ segmentId: edit.segmentId, replacement: edit.replacement })), reason: previousFinal.reason });
  assert.equal(final.author, 'mixed');
  assert.equal(final.context.requestId, freshRequest.requestId);
  assert.equal(final.edits[0].replacement, previousFinal.edits[0].replacement);
  assert.equal(app.getState().proposals.find(proposal => proposal.proposalId === ai.proposalId).reason, ai.reason);
  await verifyOriginals();
  check('a later translation edit rejects the obsolete English candidate without writing source; a fresh pinned revision retains the exact final author choice and AI provenance');

  await page.locator('#review-toggle').click(); await page.locator(`#proposal-list button[data-proposal-id="${final.proposalId}"]`).click();
  const preview = await app.previewTransaction({ proposalIds: [final.proposalId] }); await app.waitJob({ jobId: preview.jobId });
  await confirmReadyCandidate(); await until(() => app.getState().transactions.find(transaction => transaction.transactionId === preview.transactionId).state === 'applied');
  await page.waitForFunction(() => document.getElementById('layer-final-status').textContent.trim() === '已写回');
  assert.ok((await readFile(sourceFile, 'utf8')).includes('Final author choice: ')); await verifyOriginals();
  check('formal confirmation marks the final layer written while immutable original layers remain unchanged');

  await page.locator('#undo-transaction').click();
  await until(() => app.getState().proposals.some(proposal => proposal.context?.undoOf === preview.transactionId));
  const inverse = app.getState().proposals.find(proposal => proposal.context?.undoOf === preview.transactionId);
  await until(() => app.getState().transactions.some(transaction => transaction.proposalIds.includes(inverse.proposalId) && transaction.state === 'ready'));
  await confirmReadyCandidate();
  await page.waitForFunction(() => document.getElementById('layer-final-status').textContent.trim() === '已撤销');
  assert.deepEqual(await readFile(sourceFile), before); await verifyOriginals();
  check('reviewed inverse application marks the final layer reverted and restores exact synthetic source bytes');

  await page.locator('#review-close').click();
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('[data-mobile-tab="translation"]').click();
  await page.locator('#four-layer-view').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(output, 'mobile.png') });
  await page.setViewportSize({ width: 1480, height: 1000 }); await page.screenshot({ path: path.join(output, 'desktop.png') });
  check('four-layer layout remains usable on mobile without horizontal page overflow');
  assert.deepEqual(errors, []); check('four-layer interactions have no uncaught browser errors');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: checks.length, syntheticOnly: true, realBackend: true, fakeCompiler: true, fakeWriter: true, checks }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ passed: checks.length, checks, error: error.stack, pageErrors: errors }, null, 2)); throw error;
} finally { await browser.close(); await web.close(); }
