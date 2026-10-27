import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { PaperApplication, buildInputHash } from '../src/application.mjs';
import { startLocalWeb } from '../src/local-web.mjs';
import { loadPlaywright, browserOptions } from './ui-qa-support.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'work/ui-review-qa');
await mkdir(output, { recursive: true });
const run = await mkdtemp(path.join(output, 'case-'));
const paper = path.join(run, 'paper');
await mkdir(paper);
const before = Buffer.from('\\documentclass{article}\n\\begin{document}\n\nFirst synthetic claim includes $x=1$ and \\cite{example}.\n\nSecond synthetic statement needs bounded assumptions.\n\n\\end{document}\n');
await writeFile(path.join(paper, 'main.tex'), before);

function syntheticPdf() {
  const stream = 'BT /F1 18 Tf 36 720 Td (Synthetic QA build - no manuscript content) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, content] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${content}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
const compiler = {
  probe: async () => ({ available: true, isolated: true }),
  build: async input => {
    const bytes = syntheticPdf(), pdfPath = path.join(run, `${randomUUID()}.pdf`);
    await writeFile(pdfPath, bytes);
    return { buildId: `build-${randomUUID()}`, status: 'success', snapshotId: input.snapshotId, candidateHash: input.candidateHash, inputHash: buildInputHash(input), pdfPath, pdfHash: createHash('sha256').update(bytes).digest('hex'), isolation: { verified: true } };
  }
};
const app = new PaperApplication({ dataRoot: path.join(run, 'private'), compiler });
await app.initialize();
await app.openProject({ root: paper, mainFile: 'main.tex' });
const sources = app.getState().segments.filter(segment => segment.translatable);
assert.equal(sources.length, 2);
const [a, b] = sources;
const aRequest = await app.createRequest({ kind: 'revision', segmentIds: [a.id] });
const original = await app.proposeRevision({ requestId: aRequest.requestId, edits: [{ segmentId: a.id, beforeHash: a.beforeHash, replacement: a.displayText.replace('claim', 'precise claim') }], reason: 'Synthetic formula-preserving clarification.' });
const bRequest = await app.createRequest({ kind: 'revision', segmentIds: [b.id] });
const second = await app.proposeRevision({ requestId: bRequest.requestId, edits: [{ segmentId: b.id, beforeHash: b.beforeHash, replacement: b.displayText.replace('bounded', 'explicit bounded') }], reason: 'Synthetic independent assumptions.' });
const oldPreview = await app.previewTransaction({ proposalIds: [original.proposalId] });
await app.waitJob({ jobId: oldPreview.jobId });
const oldAcceptance = await app.prepareAcceptance({ transactionId: oldPreview.transactionId });

const bundle = await build({ entryPoints: [path.join(root, 'ui/app.mjs')], bundle: true, format: 'iife', platform: 'browser', write: false, define: { __PDF_WORKER_SOURCE__: "''" } });
let html = await readFile(path.join(root, 'ui/index.html'), 'utf8');
html = html.replace(/<link[^>]*href="\.\/style\.css"[^>]*>/, `<style>${await readFile(path.join(root, 'ui/style.css'), 'utf8')}</style>`).replace(/<script[^>]*src="\.\/app\.mjs"[^>]*><\/script>/, () => `<script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`);
const htmlPath = path.join(run, 'workbench.html');
await writeFile(htmlPath, html);
const web = await startLocalWeb({ service: app, htmlPath });
const { chromium } = await loadPlaywright();
const browser = await chromium.launch(browserOptions);
const page = await browser.newPage({ viewport: { width: 1520, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const checks = [];
const check = name => { checks.push(name); console.log(name); };
const until = async predicate => { const end = Date.now() + 12000; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for real backend state.'); await new Promise(resolve => setTimeout(resolve, 40)); } };
try {
  await page.addInitScript(()=>{localStorage.setItem('paper-editor-ui-language-explicit-v1','zh-CN');}); // Explicit legacy Chinese fixture; production defaults to English.
  await page.goto(web.url); await page.locator('#view-source').click();
  await page.locator(`#source-${a.id}`).waitFor();
  await page.locator('#review-toggle').click();
  await page.locator(`#proposal-list button[data-proposal-id="${original.proposalId}"]`).click();
  await page.locator('#edit-proposal').click();
  await page.locator('#edit-proposal-dialog').waitFor({ state: 'visible' });
  const candidate = page.locator(`.candidate-edit-input[data-segment-id="${a.id}"]`);
  assert.equal(await candidate.evaluate(node=>node.tagName),'TEXTAREA');assert.equal(await candidate.locator('.protected-object').count(),0);
  const originalCandidate = await candidate.evaluate(node => node.value);
  await candidate.evaluate(node => {const start=node.value.indexOf('$x=1$');node.focusRange(start,start+5);});
  await page.keyboard.press('Backspace');
  assert.equal((await candidate.evaluate(node=>node.value)).includes('$x=1$'),false);await page.keyboard.press('Control+z');
  assert.equal(await candidate.evaluate(node => node.value), originalCandidate);
  await candidate.evaluate(node => node.focusAt(0));
  await page.keyboard.insertText('Author reviewed: ');
  await page.locator('#edit-proposal-reason').fill('Human precision edit for synthetic browser QA.');
  await page.locator('#save-edited-proposal').click();
  await page.locator('#edit-proposal-dialog').waitFor({ state: 'hidden' });
  await until(() => app.getState().proposals.some(proposal => proposal.supersedes === original.proposalId));
  const mixed = app.getState().proposals.find(proposal => proposal.supersedes === original.proposalId);
  assert.equal(mixed.author, 'mixed');
  assert.ok(mixed.edits[0].replacement.startsWith('Author reviewed: '));
  assert.ok(mixed.edits[0].replacement.includes('$x=1$') && mixed.edits[0].replacement.includes('\\cite{example}'));
  assert.equal(app.getState().proposals.find(proposal => proposal.proposalId === original.proposalId).reviewState, 'superseded');
  check('free candidate formula deletion and undo retain the final author text and create a scoped mixed proposal');
  assert.equal(app.getState().transactions.find(transaction => transaction.transactionId === oldPreview.transactionId).state, 'stale');
  await assert.rejects(app.applyTransaction({ transactionId: oldPreview.transactionId, confirmationToken: oldAcceptance.confirmationToken, idempotencyKey: 'must-not-write' }), { code: 'CONFIRMATION_INVALID' });
  assert.deepEqual(await readFile(path.join(paper, 'main.tex')), before);
  check('editing supersedes the old proposal and invalidates its compiled confirmation');

  await page.locator(`#source-${a.id}`).click();
  await page.locator('#comments-open').click();
  await page.locator('#comments-dialog').waitFor({ state: 'visible' });
  await page.locator('#comment-text').fill('Source anchored synthetic review note.');
  await page.locator('#add-comment').click();
  await until(() => app.getState().comments?.some(comment => comment.text === 'Source anchored synthetic review note.'));
  const sourceComment = app.getState().comments.find(comment => comment.text === 'Source anchored synthetic review note.');
  assert.deepEqual(sourceComment.segmentIds, [a.id]);
  assert.equal(sourceComment.proposalId, null);
  assert.equal(sourceComment.sourceSnapshotId, app.getState().project.snapshotId);
  const row = page.locator(`#comment-list [data-comment-id="${sourceComment.commentId}"]`);
  await row.waitFor();
  await row.getByRole('button').click();
  await until(() => app.getState().comments.find(comment => comment.commentId === sourceComment.commentId).resolved);
  assert.equal(app.getState().comments.find(comment => comment.commentId === sourceComment.commentId).revision, 2);
  check('a source comment retains exact paragraph/version anchors and resolves with a revision');
  const resolveComment = app.resolveComment.bind(app);
  let racedResolution = false;
  app.resolveComment = async input => {
    if (!racedResolution && input.commentId === sourceComment.commentId) {
      racedResolution = true;
      await resolveComment({ commentId: input.commentId, expectedRevision: input.expectedRevision, resolved: true });
    }
    return resolveComment(input);
  };
  await row.getByRole('button').click();
  await page.locator('#comment-error').waitFor({ state: 'visible' });
  assert.ok((await page.locator('#comment-error').innerText()).includes('VERSION_CONFLICT'));
  assert.equal(app.getState().comments.find(comment => comment.commentId === sourceComment.commentId).resolved, true);
  assert.equal(app.getState().comments.find(comment => comment.commentId === sourceComment.commentId).revision, 3);
  app.resolveComment = resolveComment;
  check('a concurrent comment revision is rejected visibly without overwriting its resolution');
  await page.locator('#comments-dialog .close-dialog').click();
  await page.locator(`#proposal-list button[data-proposal-id="${mixed.proposalId}"]`).click();
  await page.locator('#proposal-comments').click();
  await page.locator('#comment-text').fill('Candidate anchored synthetic review note.');
  await page.locator('#add-comment').click();
  await until(() => app.getState().comments?.some(comment => comment.proposalId === mixed.proposalId));
  assert.equal(app.getState().comments.find(comment => comment.text === 'Candidate anchored synthetic review note.').proposalId, mixed.proposalId);
  assert.equal(app.getState().proposals.find(proposal => proposal.proposalId === mixed.proposalId).reviewState, 'pending');
  check('a proposal comment is separate from approval and source changes');
  await page.locator('#comments-dialog .close-dialog').click();

  await page.locator(`input[data-select-proposal="${mixed.proposalId}"]`).check();
  await page.locator(`input[data-select-proposal="${second.proposalId}"]`).check();
  await page.waitForTimeout(1700);
  assert.equal(await page.locator(`input[data-select-proposal="${mixed.proposalId}"]`).isChecked(), true);
  assert.equal(await page.locator(`input[data-select-proposal="${second.proposalId}"]`).isChecked(), true);
  check('batch selection survives background state refresh without losing author choices');
  await page.locator('#preview-selected').click();
  await until(() => app.getState().transactions.some(transaction => transaction.proposalIds.length === 2 && transaction.proposalIds.includes(mixed.proposalId) && transaction.proposalIds.includes(second.proposalId)));
  const batch = app.getState().transactions.find(transaction => transaction.proposalIds.length === 2 && transaction.proposalIds.includes(mixed.proposalId) && transaction.proposalIds.includes(second.proposalId));
  assert.deepEqual(new Set(batch.proposalIds), new Set([mixed.proposalId, second.proposalId]));
  await until(() => app.getState().transactions.find(transaction => transaction.transactionId === batch.transactionId).state === 'ready');
  await page.locator('#accept-proposal').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.getElementById('accept-proposal').disabled);
  await page.locator('#accept-proposal').click();
  await page.locator('#acceptance-dialog').waitFor({ state: 'visible' });
  const acceptanceText = await page.locator('#acceptance-diff').innerText();
  assert.ok(acceptanceText.includes('Author reviewed: ') && acceptanceText.includes('explicit bounded'));
  assert.ok((await page.locator('#acceptance-identity').innerText()).includes(batch.candidateHash));
  assert.equal(await page.locator('#confirm-apply').isDisabled(), true);
  assert.deepEqual(await readFile(path.join(paper, 'main.tex')), before);
  check('batch preview and confirmation show the exact full proposal set before any write');
  await page.locator('#cancel-acceptance').click();
  await page.locator('#reject-selected').click();
  await until(() => [mixed.proposalId, second.proposalId].every(id => app.getState().proposals.find(proposal => proposal.proposalId === id).reviewState === 'rejected'));
  check('batch rejection acknowledges every selected proposal without source writes');
  await page.locator('#open-project').click(); await page.locator('#project-root').fill(paper); await page.locator('#project-main').fill('main.tex'); await page.locator('#project-engine').selectOption('pdflatex'); await page.locator('#project-form').getByRole('button', { name: '打开项目', exact: true }).click(); await page.locator('#project-dialog').waitFor({ state: 'hidden' });
  assert.equal(app.getState().compiler.engine, 'pdflatex'); await page.locator('#open-project').click(); assert.equal(await page.locator('#project-engine').inputValue(), 'pdflatex'); await page.keyboard.press('Escape');
  check('project engine choice persists through the exact allowlisted configuration API');
  assert.deepEqual(await readFile(path.join(paper, 'main.tex')), before);
  assert.deepEqual(errors, []);
  check('review operations preserve synthetic source bytes and have no uncaught browser errors');
  await page.screenshot({ path: path.join(output, 'review.png') });
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: checks.length, syntheticOnly: true, realBackend: true, fakeCompiler: true, checks }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ passed: checks.length, checks, error: error.stack, pageErrors: errors }, null, 2));
  throw error;
} finally {
  await browser.close();
  await web.close();
}
