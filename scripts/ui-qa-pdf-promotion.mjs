import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadPlaywright, browserOptions } from './ui-qa-support.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'work/ui-pdf-promotion-qa');
await mkdir(output, { recursive: true });
const bridge = `export const getHostState=()=>({mode:'local-preview',connected:false});export const api=(action,payload={})=>window.__paperApi(action,payload);export const sendToHost=async()=>{};export const subscribe=listener=>{window.__notify=listener;return()=>{}};`;
const pdf = `export function openPdfDocument(){throw Error('PDF text extraction is outside this controller fixture')}export async function renderPdf(host,bytes){const canvas=document.createElement('canvas');canvas.dataset.pdf=new TextDecoder().decode(bytes);host.append(canvas);return{pageCount:1,destroy:async()=>canvas.remove(),render:async()=>{},highlight:()=>true}};`;
const bundle = await build({ entryPoints: [path.join(root, 'ui/app.mjs')], bundle: true, format: 'iife', platform: 'browser', write: false, plugins: [{ name: 'synthetic-controller', setup(builder) {
  builder.onResolve({ filter: /^\.\/(bridge|pdf)\.mjs$/ }, args => ({ path: args.path, namespace: 'synthetic' }));
  builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, args => ({ contents: args.path.includes('bridge') ? bridge : pdf, loader: 'js' }));
} }] });
let html = await readFile(path.join(root, 'ui/index.html'), 'utf8');
html = html.replace(/<link[^>]*href="\.\/style\.css"[^>]*>/, `<style>${await readFile(path.join(root, 'ui/style.css'), 'utf8')}</style>`).replace(/<script[^>]*src="\.\/app\.mjs"[^>]*><\/script>/, () => `<script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`);
const artifacts = Object.fromEntries(['original', 'candidate', 'second', 'undo', 'next', 'recovered'].map(name => { const bytes = Buffer.from(`%PDF-1.4\nSynthetic ${name}`); return [name, { base64: bytes.toString('base64'), hash: createHash('sha256').update(bytes).digest('hex') }]; }));
const { chromium } = await loadPlaywright(), browser = await chromium.launch(browserOptions), page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [], checks = [], check = name => { checks.push(name); console.log(name); };
page.on('pageerror', error => errors.push(error.message));
await page.route('https://paper.invalid/**', route => route.fulfill({ contentType: 'text/html', body: html }));
await page.addInitScript(({ artifacts }) => {
  const source = 'A synthetic original English paragraph.';
  const originalBuild = { buildId: 'build-original', kind: 'english', status: 'success', snapshotId: 'snapshot-original', pdfHash: artifacts.original.hash, isolation: { verified: true } };
  const original = { buildId: originalBuild.buildId, snapshotId: originalBuild.snapshotId, hash: originalBuild.pdfHash };
  window.__paperState = { languagePreferences: { revision: 1, uiLanguage: 'en', translationLanguage: 'zh-CN', effectiveTargetLanguage: 'zh-CN' }, project: { id: 'synthetic-promotion', mainFile: 'main.tex', sourceLanguage: 'en', targetLanguage: 'zh-CN', snapshotId: 'snapshot-original' }, segments: [{ id: 'seg-1', path: 'main.tex', source, displayText: source, visibleText: source, beforeHash: 'a'.repeat(64), translatable: true, protectedTokens: [] }], translations: {}, originals: {}, proposals: [{ proposalId: 'proposal-candidate', author: 'ai', reason: 'Synthetic bounded edit.', reviewState: 'pending', applicationState: 'notApplied', edits: [{ segmentId: 'seg-1', path: 'main.tex', before: source, replacement: 'A revised synthetic English paragraph.' }] }], builds: [originalBuild], transactions: [], jobs: [], versionPair: { available: true, projectId: 'synthetic-promotion', pairId: 'pair-fixed', revision: 1, original, latest: { ...original } }, pdfSelection: { revision: 0, target: 'pair', activeRole: null, pairId: 'pair-fixed' }, capabilities: { secureCompile: true, directApply: true, codexChat: false } };
  window.__artifacts = artifacts; window.__paperCalls = [];
  window.__publish = () => window.__notify(structuredClone(window.__paperState));
  window.__paperApi = async (action, payload = {}) => {
    window.__paperCalls.push({ action, payload }); const state = window.__paperState;
    if (action === 'state') return structuredClone(state);
    if (action === 'readPdf') {
      const build = state.builds.find(item => item.buildId === payload.buildId), name = payload.buildId.replace('build-', ''), artifact = artifacts[window.__wrongOriginal && name === 'original' ? 'next' : name];
      if (!build || !artifact) throw Error('Unknown synthetic PDF');
      return { ...artifact, buildId: build.buildId, snapshotId: build.promotedSnapshotId || build.snapshotId, kind: build.kind, provenance: 'verified-isolated-build', ...(build.candidateHash ? { candidateHash: build.candidateHash } : {}), promoted: Boolean(build.promotedSnapshotId) };
    }
    if (action === 'recordPdfView') {
      if (state.versionPair.available === false) throw Object.assign(Error('The current English pair is not ready.'), { code: 'VERSION_PAIR_COMPILE_REQUIRED' });
      state.pdfSelection = { ...state.pdfSelection, revision: state.pdfSelection.revision + 1, activeRole: payload.role, activeBuildId: payload.buildId, activePdfHash: payload.pdfHash };
      if (state.pdfSelection.requestedRole === payload.role) delete state.pdfSelection.requestedRole;
      return structuredClone(state.pdfSelection);
    }
    if (action === 'previewTransaction') {
      state.jobs.push({ jobId: 'job-candidate', kind: 'candidate', status: 'running', snapshotId: state.project.snapshotId });
      state.transactions.push({ transactionId: 'transaction-candidate', proposalIds: payload.proposalIds, baseSnapshotId: state.project.snapshotId, candidateHash: 'c'.repeat(64), state: 'compiling' });
      return { jobId: 'job-candidate', candidateHash: 'c'.repeat(64) };
    }
    if (action === 'prepareAcceptance') return { transactionId: payload.transactionId, confirmationToken: 'synthetic-confirmation-only', candidateHash: 'c'.repeat(64), buildId: 'build-candidate', expiresAt: new Date(Date.now() + 60000).toISOString() };
    if (action === 'applyTransaction') {
      state.project.snapshotId = 'snapshot-applied';
      Object.assign(state.transactions[0], { state: 'applied', afterSnapshotId: state.project.snapshotId });
      Object.assign(state.proposals[0], { reviewState: 'approved', applicationState: 'applied' });
      state.builds[0].stale = true;
      Object.assign(state.builds[1], { promotedSnapshotId: state.project.snapshotId, stale: false });
      state.versionPair.available = false;
      Object.assign(state.pdfSelection, { requestedRole: 'latest', revision: state.pdfSelection.revision + 1, activeRole: null, activeBuildId: null, activePdfHash: null });
      return { transactionId: payload.transactionId, state: 'applied', snapshotId: state.project.snapshotId };
    }
    throw Error(`Unsupported synthetic action ${action}`);
  };
}, { artifacts });
const visible = name => page.waitForFunction(name => document.querySelector('#pdf-container canvas')?.dataset.pdf === `%PDF-1.4\nSynthetic ${name}`, name, { timeout: 6000 });
try {
  await page.goto('https://paper.invalid/'); await visible('original');
  assert.equal(await page.locator('#pdf-artifact').inputValue(), 'version-latest');
  check('the initial verified latest PDF opens without changing its frozen original');
  await page.locator('#review-toggle').click(); await page.locator('#preview-proposal').click();
  await page.waitForFunction(() => window.__paperCalls.some(call => call.action === 'previewTransaction'));
  await page.evaluate(() => {
    const state = window.__paperState; state.builds.push({ buildId: 'build-candidate', kind: 'candidate', status: 'success', snapshotId: state.project.snapshotId, candidateHash: 'c'.repeat(64), pdfHash: window.__artifacts.candidate.hash, isolation: { verified: true } });
    Object.assign(state.jobs[0], { status: 'completed', buildId: 'build-candidate' }); Object.assign(state.transactions[0], { state: 'ready', buildId: 'build-candidate' }); window.__publish();
  });
  await visible('candidate'); assert.match(await page.locator('#pdf-caption').textContent(), /candidate|尚未写入/i);
  assert.equal(await page.evaluate(() => window.__paperState.versionPair.latest.buildId), 'build-original');
  assert.equal(await page.evaluate(() => window.__paperCalls.some(call => call.action === 'applyTransaction')), false);
  check('successful selected candidate compilation opens a pending preview without promoting latest or writing source');
  await page.locator('#pdf-artifact').selectOption('version-original'); await visible('original');
  await page.waitForTimeout(1100); assert.equal(await page.locator('#pdf-artifact').inputValue(), 'version-original');
  check('the frozen original remains a stable explicit comparison while a candidate is pending');
  await page.locator('#accept-proposal').click(); await page.locator('#acceptance-dialog').waitFor({ state: 'visible' });
  await page.locator('#acceptance-reviewed').check(); await page.locator('#confirm-apply').click();
  await page.locator('#acceptance-dialog').waitFor({ state: 'hidden' });
  await page.evaluate(() => { const state = window.__paperState; Object.assign(state.versionPair, { available: true, revision: 2, latest: { buildId: 'build-candidate', snapshotId: state.project.snapshotId, hash: window.__artifacts.candidate.hash } }); window.__publish(); });
  await visible('candidate');
  assert.equal(await page.locator('#pdf-artifact').inputValue(), 'version-latest');
  assert.equal(await page.evaluate(() => window.__paperState.pdfSelection.activeRole), 'latest');
  assert.equal(await page.locator('#pdf-caption').evaluate(node => node.classList.contains('candidate-pdf')), false);
  assert.equal(await page.evaluate(() => window.__paperState.versionPair.original.buildId), 'build-original');
  check('human confirmation automatically replaces the viewed original with the asynchronously published latest promoted PDF');
  const reads = await page.evaluate(() => window.__paperCalls.filter(call => call.action === 'readPdf').length);
  await page.locator('#translation-panel').focus(); await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => window.__paperCalls.filter(call => call.action === 'readPdf').length), reads);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'translation-panel');
  check('ordinary state polling neither reloads the applied PDF nor moves reading focus');
  await page.evaluate(() => {
    const state=window.__paperState;state.project.snapshotId='snapshot-second-applied';state.builds[1].stale=true;
    state.builds.push({buildId:'build-second',kind:'candidate',status:'success',snapshotId:'snapshot-applied',promotedSnapshotId:state.project.snapshotId,candidateHash:'f'.repeat(64),pdfHash:window.__artifacts.second.hash,isolation:{verified:true}});
    state.transactions.push({transactionId:'transaction-second',state:'applied',afterSnapshotId:state.project.snapshotId,buildId:'build-second',candidateHash:'f'.repeat(64)});
    Object.assign(state.versionPair,{revision:3,latest:{buildId:'build-second',snapshotId:state.project.snapshotId,hash:window.__artifacts.second.hash}});
    Object.assign(state.pdfSelection,{requestedRole:'latest',revision:state.pdfSelection.revision+1,activeRole:null,activeBuildId:null,activePdfHash:null});window.__publish();
  });
  await visible('second');assert.equal(await page.locator('#pdf-artifact').inputValue(),'version-latest');assert.equal(await page.evaluate(()=>window.__paperState.pdfSelection.activeBuildId),'build-second');assert.equal(await page.evaluate(()=>window.__paperState.versionPair.original.buildId),'build-original');
  check('a second consecutive confirmed writeback replaces the same latest English viewer with its exact new artifact and retains the frozen original');
  await page.evaluate(() => {
    const state = window.__paperState; state.project.snapshotId = 'snapshot-undo'; state.builds[1].stale = true;
    state.builds.push({ buildId: 'build-undo', kind: 'candidate', status: 'success', snapshotId: 'snapshot-applied', promotedSnapshotId: 'snapshot-undo', candidateHash: 'd'.repeat(64), pdfHash: window.__artifacts.undo.hash, isolation: { verified: true } });
    state.transactions.push({ transactionId: 'transaction-undo', state: 'applied', afterSnapshotId: 'snapshot-undo', buildId: 'build-undo', candidateHash: 'd'.repeat(64) });
    Object.assign(state.versionPair, { revision: 3, latest: { buildId: 'build-undo', snapshotId: 'snapshot-undo', hash: window.__artifacts.undo.hash } }); window.__publish();
  });
  await visible('undo'); assert.equal(await page.locator('#pdf-artifact').inputValue(), 'version-latest');
  check('an independently confirmed undo updates the same latest PDF role while retaining the initial original');
  await page.evaluate(() => {
    const state = window.__paperState; state.builds.push({ buildId: 'build-next', kind: 'english', status: 'success', snapshotId: state.project.snapshotId, pdfHash: window.__artifacts.next.hash, isolation: { verified: true } });
    Object.assign(state.pdfSelection, { requestedRole: 'latest', revision: 50 }); window.__publish();
  });
  await page.waitForTimeout(80);
  await page.evaluate(() => { const state = window.__paperState; state.versionPair.revision = 4; state.versionPair.latest = { buildId: 'build-next', snapshotId: state.project.snapshotId, hash: window.__artifacts.next.hash }; window.__publish(); });
  await visible('next'); assert.equal(await page.locator('#pdf-artifact').inputValue(), 'version-latest');
  check('a changed latest build is reconciled even when the host selection revision and pair ID stay unchanged');
  const beforeUnsafe = await page.evaluate(() => window.__paperCalls.filter(call => call.action === 'readPdf').length);
  await page.evaluate(() => { const state = window.__paperState; state.jobs.push({ jobId: 'job-old', kind: 'candidate', status: 'completed', buildId: 'build-candidate', snapshotId: 'snapshot-original' }, { jobId: 'job-failed', kind: 'candidate', status: 'failed', snapshotId: state.project.snapshotId }); window.__publish(); });
  await page.waitForTimeout(1100); assert.equal(await page.evaluate(() => window.__paperCalls.filter(call => call.action === 'readPdf').length), beforeUnsafe);
  await visible('next');
  check('failed builds and unrelated obsolete completed jobs preserve the last valid displayed PDF');
  await page.evaluate(() => {
    const state = window.__paperState; state.project.snapshotId = 'snapshot-awaiting-english';
    state.transactions.push({ transactionId: 'transaction-bilingual', state: 'applied', afterSnapshotId: state.project.snapshotId, buildId: 'build-full-source', candidateHash: 'e'.repeat(64) });
    for (const build of state.builds) build.stale = true;
    state.versionPair.available = false;
    Object.assign(state.pdfSelection, { requestedRole: 'latest', revision: state.pdfSelection.revision + 1, activeRole: null, activeBuildId: null, activePdfHash: null });
    state.jobs.push({ jobId: 'job-english-failed', kind: 'english', status: 'failed', snapshotId: state.project.snapshotId }); window.__publish();
  });
  await visible('next'); assert.match(await page.locator('#pdf-caption').textContent(), /Previous successful PDF/);
  assert.equal(await page.locator('#locate-source').isDisabled(), true);
  check('a failed post-apply English projection keeps the previous PDF visibly historical and disables current-source navigation');
  await page.evaluate(() => { window.__wrongOriginal = true; });
  await page.locator('#pdf-artifact').selectOption('version-original');
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('frozen original PDF identity changed'));
  await visible('next');
  check('a misrouted frozen-original response is rejected before replacing the retained historical preview');
  await page.evaluate(() => { window.__wrongOriginal = false; });
  await page.locator('#pdf-artifact').selectOption('version-original'); await visible('original');
  await page.evaluate(() => {
    const state = window.__paperState;
    state.builds.push({ buildId: 'build-recovered', kind: 'english', status: 'success', snapshotId: state.project.snapshotId, pdfHash: window.__artifacts.recovered.hash, isolation: { verified: true } });
    Object.assign(state.versionPair, { available: true, revision: 5, latest: { buildId: 'build-recovered', snapshotId: state.project.snapshotId, hash: window.__artifacts.recovered.hash } }); window.__publish();
  });
  await page.waitForTimeout(1100); await visible('original'); assert.equal(await page.locator('#pdf-artifact').inputValue(), 'version-original');
  await page.locator('#pdf-artifact').selectOption('version-latest'); await visible('recovered');
  check('an explicit comparison choice made while English is pending takes precedence over its late automatic update');
  await page.evaluate(() => {
    const state = window.__paperState; state.project.snapshotId = 'snapshot-text-choice';
    state.transactions.push({ transactionId: 'transaction-text-choice', state: 'applied', afterSnapshotId: state.project.snapshotId });
    for (const build of state.builds) build.stale = true;
    state.versionPair.available = false;
    Object.assign(state.pdfSelection, { requestedRole: 'latest', revision: state.pdfSelection.revision + 1 }); window.__publish();
  });
  await page.locator('#view-source').click();
  await page.evaluate(() => {
    const state = window.__paperState, artifact = window.__artifacts.recovered;
    state.builds.push({ buildId: 'build-text-choice', kind: 'english', status: 'success', snapshotId: state.project.snapshotId, pdfHash: artifact.hash, isolation: { verified: true } });
    Object.assign(state.versionPair, { available: true, revision: 6, latest: { buildId: 'build-text-choice', snapshotId: state.project.snapshotId, hash: artifact.hash } }); window.__publish();
  });
  await page.waitForTimeout(1100); assert.equal(await page.locator('#view-source').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => window.__paperCalls.some(call => call.action === 'readPdf' && call.payload.buildId === 'build-text-choice')), false);
  check('an explicit text view chosen during post-apply compilation is not overridden by its late PDF request');
  assert.deepEqual(errors, []); check('candidate, promotion, undo and asynchronous pair refresh produce no uncaught browser errors');
  await page.screenshot({ path: path.join(output, 'promotion.png') });
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: checks.length, syntheticOnly: true, mockedPdfRenderer: true, checks, pageErrors: errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, checks, pageErrors: errors }, null, 2)); throw error;
} finally { await browser.close(); }
