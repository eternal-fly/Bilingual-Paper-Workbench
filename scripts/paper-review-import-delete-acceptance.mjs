import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, browserOptions } from './ui-qa-support.mjs';

// Actual-paper acceptance is preview-and-cancel only. Never confirm deletion of
// an author's imported record. Positive deletion tests use synthetic fixtures.
const required = name => { const value = process.env[`PAPER_EDITOR_${name}`]; assert.ok(value && path.isAbsolute(value), `Set absolute PAPER_EDITOR_${name}.`); return value; };
const sessionFile = await realpath(required('SESSION_FILE')), target = await realpath(required('TARGET_FILE')), reviewFile = await realpath(required('REVIEW_FILE'));
const repo = await realpath(fileURLToPath(new URL('../../../', import.meta.url))), privateRoot = path.dirname(path.dirname(sessionFile));
const inside = (root, value) => { const relative = path.relative(root, value); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const outputPath = path.resolve(required('PRIVATE_OUTPUT')); assert.ok(inside(privateRoot, outputPath) && outputPath !== privateRoot && !inside(repo, outputPath) && !inside(repo, privateRoot));
await mkdir(outputPath, { recursive: true, mode: 0o700 }); const output = await realpath(outputPath); assert.ok(inside(privateRoot, output));
const session = JSON.parse(await readFile(sessionFile, 'utf8')), url = new URL(session.url), token = new URLSearchParams(url.hash.slice(1)).get('session');
assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1'); assert.match(token, /^[A-Za-z0-9_-]{43}$/);
const sha = value => createHash('sha256').update(value).digest('hex');
async function state() { const response = await fetch(new URL('/api', url), { method: 'POST', headers: { Origin: url.origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'state', payload: {} }) }); const result = await response.json(); assert.ok(result.ok && response.ok); return result.state; }
const identity = s => sha(JSON.stringify(Object.fromEntries(['project', 'segments', 'readingParagraphs', 'originals', 'originalSnapshotId', 'translations', 'alignments', 'reviewNotes', 'reviewHistory', 'reviewBatches', 'reviewHistoryPreferences', 'comments', 'proposals', 'transactions', 'requests', 'builds', 'versionPair'].map(key => [key, s[key]]))));
const before = await state(), baseline = identity(before); assert.equal(before.project.mainFile, path.basename(target));
assert.match(before.project.id, /^project-[a-f0-9]+$/);
const canonicalFile = await realpath(path.join(privateRoot, 'projects', before.project.id, 'state.json')); assert.ok(inside(privateRoot, canonicalFile));
const canonicalBytes = await readFile(canonicalFile), canonical = JSON.parse(canonicalBytes); assert.equal(canonical.project.id, before.project.id);
const fileHashes = await Promise.all([...before.project.files.map(file => path.resolve(path.dirname(target), file.path)), reviewFile].map(async candidate => { const filename = await realpath(candidate); assert.ok(inside(path.dirname(target), filename) || filename === reviewFile); return [filename, sha(await readFile(filename))]; }));
const batches = (before.reviewBatches || []).filter(batch => batch.origin === 'external'), active = batches.find(batch => batch.active !== false && batch.status === 'completed' && batch.filename === path.basename(reviewFile)), retired = batches.find(batch => batch.active === false || batch.status === 'retired');
assert.ok(active && retired, 'Acceptance requires the exact active review and a previously retired imported record.');
const report = { schemaVersion: 1, version: session.version, actualPaper: true, previewAndCancelOnly: true, checks: [], pageErrors: [], forbiddenActions: [], screenshots: [] };
const record = (name, detail = {}) => { report.checks.push({ name, passed: true, ...detail }); console.log(`PASS ${name}`); };
let browser, page;
try {
  const { chromium } = await loadPlaywright(); browser = await chromium.launch(browserOptions); page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  const allowed = new Set(['state', 'models', 'chatState', 'readPdf', 'readBuildLog', 'readVersionPair', 'recordPdfView', 'cacheVersionPairContext', 'cacheActivePdfContext', 'locateSource', 'locatePdf', 'prepareDeleteReviewImport']);
  await page.route('**/*', async route => { const request = route.request(), address = new URL(request.url()); if (address.protocol === 'data:' || address.protocol === 'blob:' && address.origin === url.origin) return route.continue(); if (address.origin !== url.origin) { report.forbiddenActions.push('EXTERNAL_REQUEST'); return route.abort(); } if (!address.pathname.startsWith('/api')) return route.continue(); let action; try { action = request.postDataJSON()?.action; } catch {} if (!allowed.has(action)) { report.forbiddenActions.push(action || 'INVALID_API_BODY'); return route.abort(); } return route.continue(); });
  await page.goto(session.url); await page.locator('.translation-reading').first().waitFor();
  // Automatic PDF preparation is a legitimate in-flight paper operation. Wait
  // for this page's ready signal before testing a separate mutation preview.
  await page.waitForFunction(() => document.getElementById('pdf-selection-status')?.textContent.includes('PDF 全文已就绪'), null, { timeout: 60000 });
  await page.locator('#import-review-file').click();
  await page.locator('#review-file-dialog').waitFor({ state: 'visible' });
  for (const batch of [active, retired]) assert.equal(await page.locator(`[data-import-batch-id="${batch.batchId}"] [data-import-delete]`).isEnabled(), true);
  record('both active and retired imported review files have an explicit delete-record option');
  for (const batch of [retired, active]) {
    const expected = [...(canonical.reviewNotes || []), ...(canonical.reviewHistory || [])].filter(note => note.batchId === batch.batchId).length;
    assert.ok(expected > 0); const row = page.locator(`[data-import-batch-id="${batch.batchId}"]`);
    await row.locator('[data-import-delete]').click(); await page.locator('#review-import-delete-dialog').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.getElementById('review-import-delete-confirm').disabled || !document.getElementById('review-import-delete-error').hidden);
    assert.equal(await page.locator('#review-import-delete-error').isVisible(), false, await page.locator('#review-import-delete-error').textContent());
    const preview = await page.locator('#review-import-delete-preview').textContent(); assert.ok(preview.includes(batch.filename)); assert.match(preview, new RegExp(String(expected)));
    assert.equal(await page.locator('#review-import-delete-confirm').isEnabled(), true);
    const screenshot = path.join(output, `${batch === retired ? 'retired' : 'active'}-delete-preview.png`); await page.screenshot({ path: screenshot, fullPage: true }); report.screenshots.push(screenshot);
    await page.locator('#review-import-delete-cancel').click(); await page.locator('#review-import-delete-dialog').waitFor({ state: 'hidden' });
    await row.waitFor(); assert.equal(identity(await state()), baseline); assert.equal(sha(await readFile(canonicalFile)), sha(canonicalBytes));
    record(`${batch === retired ? 'retired' : 'active'} file deletion previews the exact file/count and cancel preserves its full canonical record`, { count: expected });
  }
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.forbiddenActions, []); assert.equal(identity(await state()), baseline); assert.equal(sha(await readFile(canonicalFile)), sha(canonicalBytes));
  for (const [filename, expected] of fileHashes) assert.equal(sha(await readFile(filename)), expected);
  record('all imported opinions, source files, original review PDF, drafts and revision/undo records are unchanged; no deletion, model or compile action was permitted');
  report.passed = report.checks.length; report.success = true; await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
} catch (error) {
  report.success = false; report.passed = report.checks.length; report.error = { code: error.code, message: String(error.message).replaceAll(session.url, '[private session]').replaceAll(token, '[private credential]') };
  if (page) { report.dialog = await page.evaluate(() => ({ open: document.getElementById('review-import-delete-dialog')?.open, preview: document.getElementById('review-import-delete-preview')?.textContent, error: document.getElementById('review-import-delete-error')?.textContent, confirmDisabled: document.getElementById('review-import-delete-confirm')?.disabled })).catch(() => null); const screenshot = path.join(output, 'failed-delete-preview.png'); await page.screenshot({ path: screenshot, fullPage: true }).then(() => report.screenshots.push(screenshot)).catch(() => {}); }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.error('Actual import-delete preview acceptance failed; inspect the private report.'); process.exitCode = 1;
} finally { await browser?.close(); }
