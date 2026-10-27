import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadPlaywright, browserOptions } from './ui-qa-support.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'work/ui-pdf-controls-qa');
await mkdir(output, { recursive: true });
const bridge = `export const getHostState=()=>({mode:'local-preview',connected:false});export const api=(action,payload={})=>window.__paperApi(action,payload);export const sendToHost=async()=>{};export const subscribe=listener=>{window.__notify=listener;return()=>{}};`;
const pdf = `export function openPdfDocument(){throw Error('No PDF extraction in controller fixture')}export async function renderPdf(host,bytes,options={}){const canvas=document.createElement('canvas');canvas.dataset.pdf=new TextDecoder().decode(bytes);host.append(canvas);const notify=()=>options.onViewChange?.({page:viewer.page,scale:viewer.scale,mode:viewer.mode,panMode:viewer.panMode});const viewer={pageCount:3,page:1,scale:.8,mode:'fit-width',panMode:false,async render(page,scale){viewer.page=page;viewer.mode=scale==='fit-width'?'fit-width':'custom';viewer.scale=scale==='fit-width'?.8:scale;notify();},setScale:scale=>viewer.render(viewer.page,scale),fitWidth:()=>viewer.render(viewer.page,'fit-width'),resetZoom:()=>viewer.render(viewer.page,1),zoomBy:factor=>viewer.render(viewer.page,Math.max(.25,Math.min(4,viewer.scale*factor))),setPanMode(value){viewer.panMode=value;notify();},destroy:async()=>canvas.remove(),highlight:()=>true};(window.__viewers||=[]).push({viewer,options});await viewer.render(options.page||1,options.scale||'fit-width');return viewer;};`;

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
 await page.goto('https://paper.invalid/');await visible('original');await page.waitForFunction(()=>document.querySelector('#pdf-zoom-value').value==='80');assert.equal(await page.evaluate(()=>window.__viewers[0].options.scale),'fit-width');assert.equal(await page.locator('#pdf-fit').getAttribute('aria-pressed'),'true');check('the controller opens the verified PDF fitted to its visible scrollport and displays its actual percent');
 await page.locator('#pdf-zoom').selectOption('1.5');await page.waitForFunction(()=>document.querySelector('#pdf-zoom-value').value==='150');await page.locator('#pdf-zoom-in').click();await page.waitForFunction(()=>document.querySelector('#pdf-zoom-value').value==='180');await page.locator('#pdf-zoom-out').click();await page.waitForFunction(()=>document.querySelector('#pdf-zoom-value').value==='150');check('preset and step controls update the existing viewer and synchronized percentage');
 await page.locator('#pdf-view-options summary').click();await page.locator('#pdf-zoom-value').fill('175');await page.locator('#pdf-zoom-value').press('Enter');await page.waitForFunction(()=>document.querySelector('#pdf-zoom').value==='1.75');await page.locator('#pdf-reset').click();await page.waitForFunction(()=>document.querySelector('#pdf-zoom-value').value==='100');await page.locator('#pdf-view-options summary').click();await page.locator('#pdf-fit').click();await page.waitForFunction(()=>document.querySelector('#pdf-zoom-value').value==='80');check('custom percentage, real 100 percent reset and fit-width operate without changing the chosen PDF');
 await page.locator('#pdf-pan').click();assert.equal(await page.locator('#pdf-pan').getAttribute('aria-pressed'),'true');await page.locator('#pdf-pan').click();assert.equal(await page.locator('#pdf-pan').getAttribute('aria-pressed'),'false');check('the hand control reflects the component pan mode accessibly');
 await page.evaluate(()=>window.__viewers.at(-1).viewer.setScale(2.25));await page.waitForFunction(()=>document.querySelector('#pdf-zoom-value').value==='225');assert.equal(await page.locator('#pdf-zoom').inputValue(),'2.25');check('component wheel and resize callbacks update app controls without polling or PDF reload');
 await page.locator('#pdf-artifact').selectOption('version-original');await page.waitForFunction(()=>window.__viewers.length===2);await page.waitForFunction(()=>document.querySelector('#pdf-zoom-value').value==='80');await page.evaluate(()=>{const old=window.__viewers[0];old.viewer.scale=3;old.viewer.page=3;old.options.onViewChange({page:3,scale:3,mode:'custom',panMode:true});});assert.equal(await page.locator('#pdf-zoom-value').inputValue(),'80');assert.equal(await page.locator('#pdf-page-label').textContent(),'1 / 3');check('late zoom callbacks from a replaced viewer cannot overwrite current page or zoom');
 assert.equal(await page.locator('#pdf-zoom-out').getAttribute('aria-label'),'Zoom out PDF');assert.equal(await page.locator('#pdf-fit').getAttribute('aria-label'),'Fit width');await page.evaluate(()=>{window.__paperState.languagePreferences.uiLanguage='zh-CN';window.__paperState.languagePreferences.revision++;window.__publish();});await page.waitForFunction(()=>document.querySelector('#pdf-fit').getAttribute('aria-label')==='适合宽度');await page.evaluate(()=>{window.__paperState.languagePreferences.uiLanguage='en';window.__paperState.languagePreferences.revision++;window.__publish();});await page.waitForFunction(()=>document.querySelector('#pdf-fit').getAttribute('aria-label')==='Fit width');check('new PDF control labels default to English and switch reversibly to Chinese');
 assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>window.__paperCalls.some(call=>/apply|compile|chat|createRequest|previewTransaction/i.test(call.action))),false);check('PDF control wiring creates no source, model or compile action and no page errors');
 await writeFile(path.join(output,'report.json'),JSON.stringify({syntheticOnly:true,controllerFixture:true,passed:checks.length,checks,pageErrors:errors},null,2));
}catch(error){await writeFile(path.join(output,'failure.json'),JSON.stringify({error:error.stack,checks,pageErrors:errors},null,2));throw error;}finally{await browser.close();}
