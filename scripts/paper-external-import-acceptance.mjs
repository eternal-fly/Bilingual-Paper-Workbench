import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, browserOptions } from './ui-qa-support.mjs';
import { REVIEW_IMPORT_LIMITS } from '../src/review-limits.mjs';

// Explicitly imports the author's exact selected review file. Paper-bearing
// evidence stays private; this gate never invokes translation or source writes.
const required = name => { const value = process.env[`PAPER_EDITOR_${name}`]; assert.ok(value && path.isAbsolute(value), `Set absolute PAPER_EDITOR_${name}.`); return value; };
const target = required('TARGET_FILE'), reviewFile = required('REVIEW_FILE'), sessionFile = required('SESSION_FILE'), output = required('PRIVATE_OUTPUT');
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (root, candidate) => { const relative = path.relative(root, candidate); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const repo = await realpath(fileURLToPath(new URL('../../../', import.meta.url))), privateRoot = path.dirname(path.dirname(await realpath(sessionFile)));
assert.ok(!inside(repo, await realpath(target)) && !inside(repo, await realpath(reviewFile)));
assert.ok(inside(privateRoot, path.resolve(output)) && !inside(repo, path.resolve(output))); await mkdir(output, { recursive: true }); assert.ok(inside(privateRoot, await realpath(output)));
const session = JSON.parse(await readFile(sessionFile, 'utf8')), url = new URL(session.url), token = new URLSearchParams(url.hash.slice(1)).get('session');
assert.equal(url.hostname, '127.0.0.1'); assert.ok(['independent-workbench', 'native-independent-workbench'].includes(session.mode)); assert.ok(/^[A-Za-z0-9_-]{40,50}$/.test(token));
const report = { actualFileImport: true, version: session.version, startedAt: new Date().toISOString(), checks: [], errors: [], screenshots: [] };
const record = (name, detail = {}) => { report.checks.push({ name, passed: true, ...detail }); console.log(`PASS ${name}`); };
const state = async () => { const response = await fetch(new URL('/api', url), { method: 'POST', headers: { Origin: url.origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'state', payload: {} }) }); const result = await response.json(); assert.ok(result.ok); return result.result; };
const identity = value => hash(JSON.stringify(Object.fromEntries(['project', 'segments', 'readingParagraphs', 'originals', 'originalSnapshotId', 'translations', 'alignments', 'proposals', 'comments', 'requests', 'transactions'].map(key => [key, value[key]]))));
let browser, page, before, captured, baseline, sourceHash;
try {
  const bytes = await readFile(reviewFile), fileHash = hash(bytes); assert.ok(bytes.length <= REVIEW_IMPORT_LIMITS.fileBytes);
  before = await state(); baseline = identity(before); sourceHash = hash(await readFile(target));
  const { chromium } = await loadPlaywright(); browser = await chromium.launch(browserOptions); page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => report.errors.push(error.message));
  const readActions = new Set(['state', 'models', 'chatState', 'readPdf', 'readBuildLog', 'locateSource', 'locatePdf', 'readVersionPair', 'recordPdfView', 'cacheVersionPairContext', 'cacheActivePdfContext']);
  await page.route('**/*', async route => {
    const request = route.request(), address = new URL(request.url());
    if (address.origin !== url.origin) { report.errors.push('Unexpected external request.'); return route.abort(); }
    if (address.pathname.startsWith('/api')) {
      const input = request.postDataJSON();
      if (input.action === 'importReviewNotes') {
        assert.equal(address.pathname, '/api/review-import'); assert.equal(input.payload.fileHash, fileHash); assert.equal(input.payload.filename, path.basename(reviewFile));
        captured = { filename: input.payload.filename, fileHash, textBytes: Buffer.byteLength(input.payload.text), extractedTextHash: hash(input.payload.text), annotations: input.payload.annotations?.length || 0,
          normalizedHash: hash(JSON.stringify({ format: input.payload.format, fileHash, text: input.payload.text, annotations: input.payload.annotations || [] })) };
      } else if (!readActions.has(input.action)) { report.errors.push(`Unexpected mutation: ${input.action}`); return route.abort(); }
    }
    return route.continue();
  });
  await page.goto(session.url, { waitUntil: 'domcontentloaded' }); await page.locator('#translation-content .translation-input').first().waitFor({ timeout: 60000 });
  await page.locator('#import-review-file').click(); await page.locator('#review-file').setInputFiles(reviewFile); await page.locator('#review-file-submit').click();
  await page.waitForFunction(() => !document.getElementById('review-file-dialog').open || !document.getElementById('review-file-error').hidden, null, { timeout: 180000 });
  const diagnostic = await page.locator('#review-file-error').textContent(); assert.equal(await page.locator('#review-file-dialog').evaluate(element => element.open), false, diagnostic || 'Import must complete.');
  assert.ok(captured, 'The complete normalized file must reach the import route.'); assert.ok(captured.textBytes > 64 * 1024, 'This actual gate must exercise the previously rejected capacity.'); assert.ok(captured.textBytes <= REVIEW_IMPORT_LIMITS.textBytes);
  const after = await state(), batch = after.reviewBatches.find(item => item.origin === 'external' && item.fileHash === fileHash && item.filename === path.basename(reviewFile));
  assert.ok(batch); assert.equal(batch.normalizedHash, captured.normalizedHash); assert.equal(batch.status, 'completed');
  const notes = after.reviewNotes.filter(note => note.batchId === batch.batchId); assert.ok(notes.length && notes.length <= REVIEW_IMPORT_LIMITS.annotations); assert.equal(notes.length, batch.noteCount);
  record('actual file picker extracts and imports the complete previously oversized review', { ...captured, batchId: batch.batchId, notes: notes.length, anchored: notes.filter(note => note.sourceSegmentIds.length).length });
  await page.locator('#annotation-filter').selectOption('all'); await page.waitForFunction(() => document.querySelectorAll('#annotation-list [data-note-id]').length > 0);
  const screenshot = path.join(output, 'actual-external-review-import.png'); await page.screenshot({ path: screenshot, fullPage: true }); report.screenshots.push(screenshot);
  assert.equal(identity(after), baseline); assert.equal(hash(await readFile(target)), sourceHash); assert.deepEqual(report.errors, []);
  record('real imported opinions persist without changing manuscript, originals, drafts or source transactions'); report.ok = true;
} catch (error) { report.ok = false; report.error = { code: error.code, message: error.message }; process.exitCode = 1; console.error('Actual external import failed; inspect the private report.'); }
finally { await browser?.close(); report.completedAt = new Date().toISOString(); const filename = path.join(output, 'external-import-report.json'); await writeFile(filename, JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, report: filename })); }
