import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath, lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, browserOptions } from './ui-qa-support.mjs';
import { createParagraphComparison } from '../src/paragraph-comparison.mjs';
import { deriveTranslationProtectedTokens, isLiteralCitation } from '../ui/translation-protection.mjs';
import { projectReviewHistory } from '../src/review-history.mjs';

// Operator-only actual-paper gate. This driver never starts a model, compiles a
// paper or modifies a draft/source. The sole allowed mutation is reimporting the
// exact already imported review PDF to enrich its missing CURRENT metadata.
// All manuscript-bearing evidence and screenshots stay under the private app
// data root. Never use repository output for this script.
const required = name => { const value = process.env[`PAPER_EDITOR_${name}`]; assert.ok(value && path.isAbsolute(value), `Set absolute PAPER_EDITOR_${name}.`); return value; };
const target = await realpath(required('TARGET_FILE')), reviewFile = await realpath(required('REVIEW_FILE')), sessionFile = await realpath(required('SESSION_FILE'));
const outputPath = path.resolve(required('PRIVATE_OUTPUT'));
const sha = value => createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(item => JSON.parse(stable(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(stable(value[key]))])) : value ?? null);
const digest = value => sha(stable(value));
const inside = (root, candidate) => { const relative = path.relative(root, candidate); return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
const repo = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
const sessions = path.dirname(sessionFile), privateRoot = path.basename(sessions).toLowerCase() === 'sessions' ? path.dirname(sessions) : sessions;
assert.ok(!inside(repo, privateRoot) && !inside(repo, target) && !inside(repo, reviewFile));
assert.ok(inside(privateRoot, outputPath) && outputPath !== privateRoot && !inside(repo, outputPath));
await mkdir(outputPath, { recursive: true, mode: 0o700 }); const output = await realpath(outputPath); assert.ok(inside(privateRoot, output));
const session = JSON.parse(await readFile(sessionFile, 'utf8')), url = new URL(session.url);
assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/'); assert.match(url.hash, /^#session=[A-Za-z0-9_-]{40,50}$/);
const token = new URLSearchParams(url.hash.slice(1)).get('session');
const api = async (action, payload = {}) => {
  assert.equal(action, 'state', 'This actual gate permits direct state reads only.');
  const response = await fetch(new URL('/api', url), { method: 'POST', headers: { Origin: url.origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload }) });
  const body = await response.json(); assert.ok(response.ok && body.ok, `State unavailable: ${body.error?.code || response.status}`); return body.result;
};
async function sourceHashes(state) {
  assert.equal(state.project.mainFile, path.basename(target));
  const root = await realpath(path.dirname(target)), entries = [];
  for (const item of state.project.files) {
    assert.ok(typeof item.path === 'string' && !path.isAbsolute(item.path) && !item.path.split(/[\\/]/u).includes('..'));
    const filename = await realpath(path.resolve(root, item.path)); assert.ok(inside(root, filename));
    const metadata = await lstat(filename); assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
    const bytes = await readFile(filename); assert.equal(sha(bytes), item.hash); entries.push({ path: item.path, hash: sha(bytes), bytes: bytes.length });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
const invariantKeys = ['project', 'originalSnapshotId', 'originals', 'segments', 'readingParagraphs', 'translations', 'alignments', 'proposals', 'transactions', 'requests', 'comments', 'builds', 'versionPair'];
const invariants = state => digest(Object.fromEntries(invariantKeys.map(key => [key, state[key]])));
const presentationFields = new Set(['currentSource', 'currentTranslation', 'currentContextProvenance', 'scope', 'revision']);
const noteIdentity = note => digest(Object.fromEntries(Object.entries(note).filter(([field]) => !presentationFields.has(field))));
const busy = state => (state.jobs || []).some(job => ['running', 'queued', 'inProgress', 'cancelling', 'compiling'].includes(job.status)) || state.chat?.busy;
const report = { schemaVersion: 1, actualPaper: true, defaultMarkdownReading: true, noDraftOrSourceWrites: true, version: session.version, startedAt: new Date().toISOString(), checks: [], pageErrors: [], forbiddenActions: [], externalRequests: [], screenshots: [] };
const check = (name, detail = {}) => { report.checks.push({ name, passed: true, ...detail }); console.log(`PASS ${name}`); };
let browser, page, before, baseline, initialSources, expectedNotes, reviewHash, matchingBatch, imported, afterImport;
try {
  before = await api('state'); assert.ok(before.project && !busy(before), 'Wait for existing tasks before actual reading acceptance.');
  expectedNotes = Number(process.env.PAPER_EDITOR_EXPECTED_NOTES || 37); assert.equal(before.reviewNotes.length, expectedNotes);
  baseline = invariants(before); initialSources = await sourceHashes(before); assert.equal(initialSources.length, Number(process.env.PAPER_EDITOR_EXPECTED_SOURCE_FILES || 3));
  reviewHash = sha(await readFile(reviewFile)); matchingBatch = before.reviewBatches.find(batch => batch.origin === 'external' && batch.fileHash === reviewHash && batch.filename === path.basename(reviewFile));
  assert.ok(matchingBatch && matchingBatch.active !== false && matchingBatch.status === 'completed', 'The exact review PDF must already be the active imported review.');
  const contextDir = await realpath(process.env.PAPER_EDITOR_CONTEXT_DIR || path.join(path.dirname(privateRoot), 'codex/context'));
  assert.ok(!inside(repo, contextDir));
  const contextFiles = (await readdir(contextDir)).filter(name => name.toLowerCase().endsWith('.pdf')).sort();
  assert.equal(digest(contextFiles), digest(['latest-english.pdf', 'original.pdf']));
  const contextHashes = {};
  for (const [name, role] of [['original.pdf', 'original'], ['latest-english.pdf', 'latest']]) { contextHashes[name] = sha(await readFile(path.join(contextDir, name))); assert.equal(contextHashes[name], before.versionPair?.[role]?.hash); }
  check('baseline verifies the three exact source files, existing review identities and two author-facing PDFs', { sourceFiles: initialSources.length, notes: expectedNotes, reviewBatchId: matchingBatch.batchId });

  const { chromium } = await loadPlaywright(); browser = await chromium.launch(browserOptions);
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  const allowedReads = new Set(['state', 'models', 'chatState', 'readPdf', 'readBuildLog', 'locateSource', 'locatePdf', 'readVersionPair', 'recordPdfView', 'cacheVersionPairContext', 'cacheActivePdfContext']);
  const actionCounts = {};
  await page.route('**/*', async route => {
    const request = route.request(), address = new URL(request.url());
    if (address.protocol === 'data:' || address.protocol === 'blob:' && address.origin === url.origin) return route.continue();
    if (address.origin !== url.origin) { report.externalRequests.push(address.origin); return route.abort(); }
    if (address.pathname.startsWith('/api')) {
      let input; try { input = request.postDataJSON(); } catch { report.forbiddenActions.push('INVALID_API_BODY'); return route.abort(); }
      actionCounts[input.action] = (actionCounts[input.action] || 0) + 1;
      if (input.action === 'importReviewNotes') {
        assert.equal(actionCounts[input.action], 1, 'Only one explicit same-file reimport is allowed.');
        assert.equal(address.pathname, '/api/review-import'); assert.equal(input.payload.fileHash, reviewHash); assert.equal(input.payload.filename, path.basename(reviewFile));
        imported = { textBytes: Buffer.byteLength(input.payload.text), textHash: sha(input.payload.text), annotations: input.payload.annotations?.length || 0 };
      } else if (!allowedReads.has(input.action)) { report.forbiddenActions.push(input.action); return route.abort(); }
    }
    return route.continue();
  });
  await page.goto(session.url, { waitUntil: 'domcontentloaded' }); await page.locator('.translation-reading').first().waitFor({ timeout: 60000 });
  const openViews = await page.locator('.translation-paragraph').evaluateAll(cards => cards.map(card => card.dataset.translationView)); assert.ok(openViews.length && openViews.every(mode => mode === 'reading'));
  assert.equal(await page.locator('.translation-input:visible').count(), 0);
  await page.locator('#import-review-file').click(); await page.locator('#review-file').setInputFiles(reviewFile);
  const responsePromise = page.waitForResponse(response => response.url().startsWith(`${url.origin}/api/review-import`) && response.request().method() === 'POST', { timeout: 180000 });
  await page.locator('#review-file-submit').click(); const importResponse = await responsePromise, importBody = await importResponse.json();
  assert.ok(importBody.ok && importBody.result?.idempotent === true, `Same-file reimport failed: ${importBody.error?.code || importResponse.status()}`);
  await page.locator('#review-file-dialog').waitFor({ state: 'hidden', timeout: 60000 }); assert.ok(imported);
  afterImport = await api('state'); assert.equal(invariants(afterImport), baseline); assert.equal(digest(afterImport.reviewBatches), digest(before.reviewBatches));
  assert.equal(afterImport.reviewNotes.length, expectedNotes); assert.equal(new Set(afterImport.reviewNotes.map(note => note.noteId)).size, expectedNotes);
  const oldNotes = new Map(before.reviewNotes.map(note => [note.noteId, note])), newNotes = new Map(afterImport.reviewNotes.map(note => [note.noteId, note]));
  assert.equal(digest([...oldNotes.keys()].sort()), digest([...newNotes.keys()].sort())); let enriched = 0;
  for (const [id, original] of oldNotes) {
    const current = newNotes.get(id); assert.equal(noteIdentity(current), noteIdentity(original), 'Opinion ID, quartet, decision, anchor or non-presentation data changed.');
    if (original.currentSource !== undefined || original.currentTranslation !== undefined) assert.equal(digest(current), digest(original));
    else if (current.currentSource !== undefined || current.currentTranslation !== undefined) { assert.equal(current.batchId, matchingBatch.batchId); assert.ok(current.currentSource && current.currentTranslation); assert.equal(current.currentContextProvenance, 'external-review-context'); assert.equal(current.scope, 'paragraph'); assert.equal(current.revision, original.revision + 1); enriched++; }
    else assert.equal(digest(current), digest(original));
  }
  const contextual = afterImport.reviewNotes.filter(note => note.batchId === matchingBatch.batchId && note.currentSource && note.currentTranslation && ['suggestedSource', 'suggestedTranslation', 'reasonSource', 'reasonTranslation'].every(field => note[field]));
  assert.ok(contextual.length, 'The correct review must expose explicit CURRENT context.');
  check('one same-file picker reimport enriches CURRENT metadata without duplicating or changing the 37 opinions, quartets, decisions, anchors or batch', { enriched, contextual: contextual.length, imported });

  const language = afterImport.languagePreferences?.effectiveTargetLanguage || afterImport.project.targetLanguage || 'zh-CN';
  const readings = afterImport.readingParagraphs?.length ? afterImport.readingParagraphs : afterImport.segments;
  const draftText = paragraph => afterImport.translations?.[language]?.[paragraph.id]?.text || '';
  const protectedParagraph = readings.find(paragraph => { if (!paragraph.translatable || !draftText(paragraph)) return false; const atoms = deriveTranslationProtectedTokens(draftText(paragraph), paragraph.protectedTokens || []); return atoms.some(atom => atom.kind === 'math') && atoms.some(atom => atom.kind === 'citation' && isLiteralCitation(atom.raw)); });
  assert.ok(protectedParagraph, 'An actual translated paragraph with a formula and reference is required.');
  const paragraph = page.locator(`[data-unit-id="${protectedParagraph.id}"]`); await paragraph.scrollIntoViewIfNeeded();
  assert.ok(await paragraph.locator('.translation-reading .katex').count() > 0); await paragraph.locator('.translation-reading').click();
  const editor = paragraph.locator('.translation-input'); await editor.waitFor({ state: 'visible' }); assert.equal(await page.locator('.translation-input:visible').count(), 1);
  assert.equal(await editor.evaluate(element => element.value), draftText(protectedParagraph));
  const atoms = await editor.locator('.protected-object').evaluateAll(elements => elements.map(element => ({ raw: element.dataset.raw, editable: element.contentEditable })));
  assert.ok(atoms.some(atom => /^(?:\$|\\\(|\\\[)/u.test(atom.raw)) && atoms.some(atom => isLiteralCitation(atom.raw)) && atoms.every(atom => atom.editable === 'false'));
  assert.equal(digest(atoms.map(atom => atom.raw)), digest(deriveTranslationProtectedTokens(draftText(protectedParagraph), protectedParagraph.protectedTokens || []).map(atom => atom.raw)));
  await editor.evaluate(element => { const reference = element.querySelector('.protected-object[data-protected-kind="citation"]'); const range = document.createRange(); range.setStartAfter(reference); range.collapse(true); element.focus(); getSelection().removeAllRanges(); getSelection().addRange(range); });
  await page.keyboard.press('Backspace'); assert.equal(sha(await editor.evaluate(element => element.value)), sha(draftText(protectedParagraph)), 'Atomic reference deletion must leave the actual draft exact.');
  await paragraph.locator('[data-translation-action="done"]').click(); await page.waitForFunction(id => document.querySelector(`[data-unit-id="${id}"]`)?.dataset.translationView === 'reading', protectedParagraph.id);
  assert.equal(actionCounts.saveDraft || 0, 0, 'Unchanged inspection must not create another draft revision.');
  check('actual translation defaults to Markdown math reading and opens one protected editor with atomic formulas/references; unchanged Done restores reading', { paragraphId: protectedParagraph.id, protectedObjects: atoms.length });

  const currentProjection = projectReviewHistory(afterImport, { sourceIds: null, filter: 'all' });
  const anchored = currentProjection.current.find(note => note.sourceSegmentIds?.length === 1 && readings.some(item => item.id === note.sourceSegmentIds[0] && item.translatable)); assert.ok(anchored);
  const anchorId = anchored.sourceSegmentIds[0], anchoredParagraph = page.locator(`[data-unit-id="${anchorId}"]`);
  await anchoredParagraph.locator('.translation-reading').click(); await page.locator('#annotation-filter').selectOption('selected');
  const selectedNotes = await page.locator('#annotation-list [data-note-id]').evaluateAll(cards => cards.map(card => ({ id: card.dataset.noteId, sources: JSON.parse(card.dataset.sourceIds || '[]') })));
  assert.ok(selectedNotes.some(note => note.id === anchored.noteId)); assert.ok(selectedNotes.every(note => { const stored = newNotes.get(note.id); return note.sources.includes(anchorId) || stored?.scope === 'global' || stored?.global === true || stored?.anchorStatus === 'global'; }));
  assert.equal(digest(selectedNotes.map(note => note.id).sort()), digest(projectReviewHistory(afterImport, { sourceIds: [anchorId], filter: 'selected' }).current.map(note => note.noteId).sort()));
  await anchoredParagraph.locator('[data-translation-action="done"]').click();
  check('selecting the actual translated paragraph shows its exact anchored opinions in the third pane', { paragraphId: anchorId, opinions: selectedNotes.length });

  await page.locator('#annotation-filter').selectOption('all');
  const candidates = await page.locator('#annotation-list .annotation-bilingual-card').evaluateAll(cards => cards.map(card => ({ id: card.dataset.noteId, fields: [...card.querySelectorAll('[data-review-field]')].map(field => field.dataset.reviewField), math: card.querySelectorAll('.katex').length, changedOld: card.querySelectorAll('.revision-sentence[data-changed="true"][data-revision-role="current"]').length, changedNew: card.querySelectorAll('.revision-sentence[data-changed="true"][data-revision-role="recommended"]').length, unchanged: card.querySelectorAll('.revision-sentence[data-changed="false"]').length })));
  const candidate = candidates.find(item => item.fields.length === 6 && item.changedOld && item.changedNew && item.math) || candidates.find(item => item.fields.length === 6 && item.changedOld && item.changedNew); assert.ok(candidate);
  const card = page.locator(`[data-note-id="${candidate.id}"]`); assert.equal(digest([...candidate.fields].sort()), digest(['currentSource', 'currentTranslation', 'suggestedSource', 'suggestedTranslation', 'reasonSource', 'reasonTranslation'].sort()));
  assert.ok(await page.locator('#annotation-list .katex').count() > 0); assert.equal(await page.locator('canvas').count(), await page.locator('#pdf-container canvas').count());
  assert.ok(!/\[\[P\d|⟦P\d/u.test(await card.innerText()));
  await card.locator('[data-opinion-view="source"]').click(); assert.equal(await card.locator('.katex').count(), 0); await card.locator('[data-opinion-view="reading"]').click();
  const currentIds = new Set(currentProjection.currentIds);
  const expectedUnchanged = contextual.filter(note => currentIds.has(note.noteId)).some(note => { const comparison = createParagraphComparison({ note }); return [comparison.source.current, comparison.source.recommended, comparison.translation.current, comparison.translation.recommended].some(side => side.ranges.some(range => !range.changed)); });
  if (expectedUnchanged) assert.ok(candidates.some(item => item.unchanged));
  check('the actual review shows six CURRENT/RECOMMENDED/reason fields with Markdown math, exact changed-sentence ranges and a source toggle', { noteId: candidate.id, unchangedSentencesPresent: candidates.some(item => item.unchanged), noOpinionPdfCanvas: true });

  for (const theme of ['light', 'dark']) {
    await page.locator('#theme').selectOption(theme); await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#pdf-container canvas'); if (!canvas?.width || !canvas?.height) return false;
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; let ink = 0;
      for (let index = 0; index < pixels.length; index += 16) if (pixels[index] < 180 && pixels[index + 1] < 180 && pixels[index + 2] < 180 && ++ink > 50) return true;
      return false;
    }, null, { timeout: 45000 });
    await card.evaluate(element => { const scroll = document.getElementById('annotation-scroll'); scroll.scrollTop += element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 10; });
    const colors = await page.evaluate(id => {
      const card = document.querySelector(`[data-note-id="${id}"]`), current = card.querySelector('.revision-sentence[data-changed="true"][data-revision-role="current"]'), recommended = card.querySelector('.revision-sentence[data-changed="true"][data-revision-role="recommended"]'), unchanged = document.querySelector('.revision-sentence[data-changed="false"]'), root = getComputedStyle(document.documentElement), middle = document.getElementById('translation-panel').getBoundingClientRect(), notes = document.getElementById('annotation-panel').getBoundingClientRect();
      return { current: getComputedStyle(current).color, recommended: getComputedStyle(recommended).color, unchanged: unchanged ? getComputedStyle(unchanged).color : null, ink: root.getPropertyValue('--ink').trim(), middleRight: middle.right, notesLeft: notes.left, overflow: document.documentElement.scrollWidth > innerWidth };
    }, candidate.id);
    if (theme === 'light') { assert.equal(colors.current, 'rgb(141, 71, 11)'); assert.equal(colors.recommended, 'rgb(19, 91, 122)'); }
    else { assert.equal(colors.current, 'rgb(231, 186, 131)'); assert.equal(colors.recommended, 'rgb(158, 203, 225)'); }
    if (colors.unchanged) assert.equal(colors.unchanged, theme === 'light' ? 'rgb(55, 51, 40)' : 'rgb(231, 235, 240)');
    assert.ok(colors.notesLeft >= colors.middleRight - 1); assert.equal(colors.overflow, false);
    const screenshot = path.join(output, `paper-markdown-${theme}.png`); await page.screenshot({ path: screenshot, fullPage: true }); report.screenshots.push(screenshot);
    check(`${theme} theme keeps changed sentences distinct, unchanged text in normal ink and the third pane outside the translation`, { colors });
  }
  const final = await api('state'); assert.equal(invariants(final), baseline); assert.equal(digest(final.reviewNotes), digest(afterImport.reviewNotes)); assert.equal(digest(final.reviewBatches), digest(before.reviewBatches)); assert.equal(digest(await sourceHashes(final)), digest(initialSources));
  for (const name of contextFiles) assert.equal(sha(await readFile(path.join(contextDir, name))), contextHashes[name]);
  assert.equal(digest((await readdir(contextDir)).filter(name => name.toLowerCase().endsWith('.pdf')).sort()), digest(contextFiles)); assert.ok(!busy(final));
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.forbiddenActions, []); assert.deepEqual(report.externalRequests, []); assert.equal(actionCounts.importReviewNotes, 1);
  check('source bytes, baselines, all drafts, official PDFs, proposals and transactions remain exact with zero model/compile/source-write or external requests', { sourceFiles: initialSources.length, notes: final.reviewNotes.length, actions: actionCounts });
  report.success = true; report.passed = report.checks.length;
} catch (error) {
  report.success = false; report.error = { code: error.code || 'ACCEPTANCE_FAILED', message: error.message }; process.exitCode = 1;
  if (page) { const filename = path.join(output, 'failure.png'); await page.screenshot({ path: filename, fullPage: true }).then(() => report.screenshots.push(filename)).catch(() => {}); }
  console.error('Actual Markdown reading acceptance failed; inspect the private report.');
} finally {
  await browser?.close(); report.completedAt = new Date().toISOString(); const filename = path.join(output, 'report.json'); await writeFile(filename, JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(JSON.stringify({ success: report.success, passed: report.checks.length, report: filename }));
}
