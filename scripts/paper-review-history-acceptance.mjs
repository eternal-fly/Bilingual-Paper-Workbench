import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectReviewHistory } from '../src/review-history.mjs';
import { loadPlaywright, browserOptions } from './ui-qa-support.mjs';
// This actual-paper gate never confirms clearing or changes retention preferences.
const required = name => { const value = process.env[`PAPER_EDITOR_${name}`]; assert.ok(value && path.isAbsolute(value), `Set absolute PAPER_EDITOR_${name}.`); return value; };
const sessionFile = await realpath(required('SESSION_FILE')), target = await realpath(required('TARGET_FILE'));
const repo = await realpath(fileURLToPath(new URL('../../../', import.meta.url))), privateRoot = path.dirname(path.dirname(sessionFile));
const inside = (root, value) => { const relative = path.relative(root, value); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const outputPath = path.resolve(required('PRIVATE_OUTPUT')); assert.ok(inside(privateRoot, outputPath) && !inside(repo, outputPath) && !inside(repo, privateRoot));
await mkdir(outputPath, { recursive: true, mode: 0o700 }); const output = await realpath(outputPath); assert.ok(inside(privateRoot, output));
const session = JSON.parse(await readFile(sessionFile, 'utf8')), url = new URL(session.url), token = new URLSearchParams(url.hash.slice(1)).get('session');
assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1'); assert.match(token, /^[A-Za-z0-9_-]{43}$/);
const sha = value => createHash('sha256').update(value).digest('hex');
async function state() { const response = await fetch(new URL('/api', url), { method: 'POST', headers: { Origin: url.origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'state', payload: {} }) }); const result = await response.json(); assert.ok(result.ok && response.ok); return result.result; }
const identity = s => sha(JSON.stringify(Object.fromEntries(['project', 'segments', 'readingParagraphs', 'originals', 'originalSnapshotId', 'translations', 'alignments', 'reviewNotes', 'reviewHistory', 'reviewBatches', 'reviewHistoryPreferences', 'comments', 'proposals', 'transactions', 'builds', 'versionPair'].map(key => [key, s[key]]))));
const before = await state(), baseline = identity(before); assert.equal(before.project.mainFile, path.basename(target));
const sourceHashes = await Promise.all(before.project.files.map(async file => { const filename = await realpath(path.resolve(path.dirname(target), file.path)); assert.ok(inside(path.dirname(target), filename)); return [filename, sha(await readFile(filename))]; }));
const report = { schemaVersion: 1, version: session.version, actualPaper: true, readOnly: true, checks: [], pageErrors: [], forbiddenActions: [], screenshots: [] };
const record = (name, detail = {}) => { report.checks.push({ name, passed: true, ...detail }); console.log(`PASS ${name}`); };
let browser;
try {
  const { chromium } = await loadPlaywright(); browser = await chromium.launch(browserOptions); const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  const forbidden = new Set(['configureReviewHistory', 'clearReviewHistory', 'saveDraft', 'chatSend', 'runRequest', 'reviewCycle', 'fullPaperReview', 'reviewParagraph', 'syncParagraph', 'compileReviewNote', 'compileBaseline', 'compileEnglish', 'applyTransaction', 'createUndoProposal']);
  page.on('request', request => { try { const action = request.postDataJSON()?.action; if (forbidden.has(action)) report.forbiddenActions.push(action); } catch {} });
  await page.goto(session.url); await page.locator('.translation-reading').first().waitFor();
  assert.equal(await page.locator('#review-view-current').getAttribute('aria-pressed'), 'true'); assert.equal(await page.locator('#review-view-history').getAttribute('aria-pressed'), 'false');
  record('the actual installed pane opens in current-opinion mode');
  const ids = async () => (await page.locator('#annotation-list [data-note-id]').evaluateAll(nodes => nodes.map(node => node.dataset.noteId))).sort();
  await page.locator('#annotation-filter').selectOption('all');
  const project = projectReviewHistory(before, { filter: 'all' });
  assert.deepEqual(await ids(), project.current.slice(0, 100).map(note => note.noteId).sort());
  record('default project view contains only current generations', { current: project.current.length, historical: project.history.length });
  await page.locator('#review-view-history').click(); assert.equal(await page.locator('#review-view-history').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await ids(), project.history.slice(0, 100).map(note => note.noteId).sort());
  assert.equal(await page.locator('#annotation-list [data-review-decision]:not(:disabled)[aria-pressed]').count(), 0);
  record('history is explicit and historical opinions are read-only');
  const sources = before.readingParagraphs?.length ? before.readingParagraphs : before.segments;
  const initialSelection = new Set((await page.locator('#annotation-selection').getAttribute('title') || '').split(' · ').filter(Boolean));
  const candidate = project.history.flatMap(note => note.sourceSegmentIds || []).find(id => !initialSelection.has(id) && sources.some(source => source.id === id && source.translatable)) || sources.find(source => source.translatable && !initialSelection.has(source.id))?.id;
  if (candidate) {
    const paragraph = page.locator(`[data-unit-id="${candidate}"]`); await paragraph.locator('.translation-reading').click(); await paragraph.locator('[data-translation-action="done"]').click();
    assert.equal(await page.locator('#review-view-current').getAttribute('aria-pressed'), 'true'); assert.equal(await page.locator('#annotation-filter').inputValue(), 'selected');
    const selected = projectReviewHistory(before, { sourceIds: [candidate], filter: 'selected' }); assert.deepEqual(await ids(), selected.current.slice(0, 100).map(note => note.noteId).sort());
  }
  record('selecting a paragraph resets to its current opinions instead of carrying another history view');
  await page.locator('#annotation-filter').selectOption('all'); await page.locator('#review-view-history').click(); await page.locator('#review-history-manage').click();
  assert.equal(await page.locator('#review-history-retain').isChecked(), before.reviewHistoryPreferences?.retain !== false);
  record('retention controls reflect the saved preference without modifying it');
  if (await page.locator('#review-history-clear').isEnabled()) {
    await page.locator('#review-history-clear').click(); await page.locator('#review-history-clear-dialog').waitFor({ state: 'visible' });
    assert.ok((await page.locator('#review-history-clear-preview').textContent()).trim()); assert.ok(project.globallyHistoricalIds.length);
    await page.locator('#review-history-clear-cancel').click(); await page.locator('#review-history-clear-dialog').waitFor({ state: 'hidden' });
    record('clearing presents a concrete preview and cancellation preserves all records', { globallyClearable: project.globallyHistoricalIds.length });
  } else { assert.equal(project.globallyHistoricalIds.length, 0); record('no globally historical records can be cleared when every record is still current somewhere'); }
  await page.locator('#review-view-current').click(); const screenshot = path.join(output, 'current-opinions.png'); await page.screenshot({ path: screenshot, fullPage: true }); report.screenshots.push(screenshot);
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.forbiddenActions, []); assert.equal(identity(await state()), baseline);
  for (const [filename, expected] of sourceHashes) assert.equal(sha(await readFile(filename)), expected);
  record('opinions, preferences, drafts, official PDFs and source files remain unchanged, with no model, compile or clearing action');
  report.passed = report.checks.length; report.success = true; await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
} catch (error) {
  report.success = false; report.passed = report.checks.length; report.error = { code: error.code, message: String(error.message).replaceAll(session.url, '[private session]').replaceAll(token, '[private credential]') };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.error('Actual history acceptance failed; inspect the private report.'); process.exitCode = 1;
} finally { await browser?.close(); }
