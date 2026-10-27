import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, browserOptions } from './ui-qa-support.mjs';

// Run from the source checkout against the installed, already prepared session.
// This script never starts a review, imports opinions, edits a draft or compiles.
// Paper-bearing PDF/text, screenshots and detailed evidence stay in PRIVATE_OUTPUT.
// Required: TARGET_FILE, SESSION_FILE, PRIVATE_OUTPUT, EXPECTED_THREAD_ID (or
// their PAPER_EDITOR_ equivalents). Optional PAPER_EDITOR_PARAGRAPH_ID and
// PAPER_EDITOR_EXPECTED_NOTE_ID pin exact current identities for the screenshots.
const required = (name, alias) => {
  const value = process.env[name] || process.env[alias];
  assert.ok(value, `Set ${name} (or ${alias}) for actual-paper three-column acceptance.`);
  return value;
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, value) => {
  const relative = path.relative(root, value);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const target = required('PAPER_EDITOR_TARGET_FILE', 'TARGET_FILE');
const sessionFile = required('PAPER_EDITOR_SESSION_FILE', 'SESSION_FILE');
const privateOutput = required('PAPER_EDITOR_PRIVATE_OUTPUT', 'PRIVATE_OUTPUT');
const expectedThread = required('PAPER_EDITOR_EXPECTED_THREAD_ID', 'EXPECTED_THREAD_ID');
for (const value of [target, sessionFile, privateOutput]) assert.ok(path.isAbsolute(value), 'Acceptance paths must be absolute.');
const repoRoot = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
const resolvedTarget = await realpath(target);
assert.ok(!inside(repoRoot, resolvedTarget), 'Actual manuscript sources must be outside the repository.');
const projectRoot = await realpath(path.dirname(resolvedTarget));
const sessionRoot = await realpath(path.dirname(sessionFile));
const privateRoot = path.basename(sessionRoot).toLowerCase() === 'sessions' ? path.dirname(sessionRoot) : sessionRoot;
assert.ok(!inside(repoRoot, privateRoot), 'The launch session must be in private application data outside the repository.');
assert.ok(inside(privateRoot, path.resolve(privateOutput)), 'PRIVATE_OUTPUT must stay under the private session data root.');
await mkdir(privateOutput, { recursive: true, mode: 0o700 });
const output = await realpath(privateOutput);
assert.ok(inside(privateRoot, output) && !inside(repoRoot, output), 'Resolved output must remain in the private application data root.');
const session = JSON.parse(await readFile(sessionFile, 'utf8'));
let url;
try { url = new URL(session.url); }
catch { throw new Error('The private launch session URL is invalid.'); }
assert.equal(url.protocol, 'http:');
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.pathname, '/');
assert.ok(/^#session=[A-Za-z0-9_-]{40,50}$/.test(url.hash), 'The private launch token format is invalid.');
assert.equal(session.mode, 'independent-workbench');
const token = new URLSearchParams(url.hash.slice(1)).get('session');
const redact = value => String(value).replaceAll(session.url, '[private session]').replaceAll(token, '[private credential]').replace(/#session=[A-Za-z0-9_-]+/g, '#session=[redacted]');
const report = { schemaVersion: 1, actualPaper: true, installedSession: true, manuscriptReadOnly: true, startedAt: new Date().toISOString(), checks: [], screenshots: [], pageErrors: [], blockedActions: [], blockedNetwork: [], apiActions: [] };
const record = (name, detail = {}) => { report.checks.push({ name, passed: true, ...detail }); console.log(`PASS ${name}`); };
// Exact view acknowledgments and local PDF text caches prepare same-chat reads;
// they never send a model turn or modify manuscript/drafts/opinions.
const readActions = new Set(['state', 'models', 'chatState', 'readPdf', 'readVersionPair', 'readBuildLog', 'locateSource', 'locatePdf', 'listWorkspaces', 'recordPdfView', 'cacheVersionPairContext', 'cacheActivePdfContext']);
const api = async (action, payload = {}) => {
  assert.ok(readActions.has(action), 'Actual acceptance permits read-only API actions.');
  let response, body;
  try {
    response = await fetch(new URL('/api', url), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url.origin, Authorization: `Bearer ${token}` }, body: JSON.stringify({ action, payload }), signal: AbortSignal.timeout(45000) });
    body = await response.json();
  } catch { throw new Error(`Read-only ${action} request did not return valid data.`); }
  assert.ok(response.ok && body.ok, `${action} failed: ${redact(body.error?.code || 'API_ERROR')}`);
  return body;
};
const contentIdentity = state => hash(JSON.stringify(Object.fromEntries(['project', 'segments', 'readingParagraphs', 'originals', 'originalSnapshotId', 'translations', 'alignments', 'proposals', 'comments', 'requests', 'transactions', 'reviewNotes', 'reviewBatches', 'readingAnchors'].map(key => [key, state[key]]))));
const noteIds = note => Array.isArray(note.sourceSegmentIds) ? note.sourceSegmentIds : [];
const globalNote = note => note.scope === 'global' || note.global === true || note.anchorStatus === 'global';
let browser, page, initial, initialIdentity, sourceBefore, sourceFiles;
const screenshot = async name => {
  const filename = path.join(output, `${name}.png`);
  await page.screenshot({ path: filename, fullPage: true }); report.screenshots.push(filename);
};
const noOverflow = async label => {
  const geometry = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(geometry.page <= geometry.viewport && geometry.body <= geometry.viewport, `${label} has horizontal page overflow.`);
  record(`${label} has no horizontal page overflow`, geometry);
};
const sourceManifest = async project => {
  assert.ok(Array.isArray(project?.files) && project.files.length, 'The exact current project source graph is required.');
  const entries = [];
  for (const file of project.files) {
    assert.ok(typeof file.path === 'string' && !path.isAbsolute(file.path), 'A project read-set path must be relative.');
    const candidate = path.resolve(projectRoot, file.path);
    assert.ok(inside(projectRoot, candidate), 'A project read-set path escaped the authorized project.');
    const resolved = await realpath(candidate);
    assert.ok(inside(projectRoot, resolved), 'A resolved project file escaped the authorized project.');
    const bytes = await readFile(resolved);
    assert.equal(hash(bytes), file.hash, 'An authorized source file differs from the current snapshot.');
    entries.push({ path: file.path, resolved, hash: hash(bytes), bytes });
  }
  return entries;
};
const inAbstract = paragraph => {
  if (/abstract|摘要/iu.test(paragraph.section || '') || paragraph.kind === 'abstract') return true;
  const bytes = sourceFiles.find(file => file.path === paragraph.path)?.bytes;
  if (!bytes || !Number.isSafeInteger(paragraph.startByte)) return false;
  const prefix = bytes.subarray(0, paragraph.startByte).toString('utf8');
  return prefix.lastIndexOf('\\begin{abstract}') > prefix.lastIndexOf('\\end{abstract}');
};
try {
  sourceBefore = hash(await readFile(resolvedTarget));
  report.sourceHashBefore = sourceBefore;
  initial = (await api('state')).result;
  assert.equal(initial.project?.mainFile, path.basename(resolvedTarget));
  assert.equal(initial.project.files.find(file => file.path === initial.project.mainFile)?.hash, sourceBefore);
  sourceFiles = await sourceManifest(initial.project);
  initialIdentity = contentIdentity(initial);
  const catalog = (await api('models')).result;
  assert.ok(catalog.models?.some(item => /astra/i.test(item.id || item.model || '')), 'The live Codex catalog must contain Astra.');
  const chat = (await api('chatState')).result;
  assert.equal(chat.threadId, expectedThread);
  assert.match(chat.model || '', /astra/i);
  record('exact authorized source graph and persistent Astra paper thread are current', { projectId: initial.project.id, snapshotId: initial.project.snapshotId, sourceFileCount: sourceFiles.length, threadId: chat.threadId, model: chat.model });

  const english = [...(initial.builds || []), ...(initial.englishBuilds || [])].filter(build => build.kind === 'english' && ['success', 'completed'].includes(build.status) && !build.stale && !build.candidateHash && (build.isolation?.verified === true || build.provenance === 'verified-isolated-build') && (build.snapshotId || build.sourceSnapshotId) === initial.project.snapshotId).at(-1);
  assert.ok(english && /^[a-f0-9]{64}$/i.test(english.pdfHash || ''), 'A successful current isolated English PDF build is required.');
  const pdf = (await api('readPdf', { buildId: english.buildId })).result;
  assert.equal(pdf.kind, 'english'); assert.equal(pdf.buildId, english.buildId); assert.equal(pdf.snapshotId, initial.project.snapshotId);
  assert.equal(pdf.provenance, 'verified-isolated-build'); assert.ok(!pdf.candidateHash);
  const pdfBytes = Buffer.from(pdf.base64, 'base64');
  assert.equal(hash(pdfBytes), english.pdfHash); assert.equal(pdf.hash || pdf.pdfHash, english.pdfHash);
  await writeFile(path.join(output, 'current-english.pdf'), pdfBytes, { mode: 0o600 });
  record('reading PDF has the exact current English build identity and verified bytes', { buildId: english.buildId, pdfHash: english.pdfHash, pdfBytes: pdfBytes.length });

  const pair = (await api('readVersionPair')).result;
  assert.equal(pair.projectId, initial.project.id); assert.equal(pair.latest.snapshotId, initial.project.snapshotId);
  assert.equal(pair.latest.buildId, english.buildId); assert.equal(pair.latest.hash, english.pdfHash);
  for (const role of ['original', 'latest']) assert.equal(hash(Buffer.from(pair[role].base64, 'base64')), pair[role].hash, 'A version-pair PDF differs from its recorded bytes.');
  const review = (initial.reviewBatches || []).filter(batch => batch.origin === 'codex' && batch.cycleId && batch.scope === 'paper' && batch.conversation !== true && batch.status === 'completed' && batch.sourceSnapshotId === initial.project.snapshotId && batch.threadId === expectedThread && batch.model === chat.model).at(-1);
  assert.ok(review, 'A genuine completed current one-turn full-paper PDF review cycle is required.');
  if (process.env.PAPER_EDITOR_REVIEW_NOT_BEFORE) assert.ok(Date.parse(review.createdAt) >= Date.parse(process.env.PAPER_EDITOR_REVIEW_NOT_BEFORE), 'The completed review predates this acceptance run.');
  assert.match(review.model || '', /astra/i);
  assert.equal(review.coverage?.completePdfTextsDelivered, true); assert.equal(review.coverage?.completedTurns, 1);
  assert.ok(review.finalTurnId); assert.equal(review.pair?.pairId, pair.pairId);
  for (const role of ['original', 'latest']) {
    assert.equal(review.pair[role]?.hash, pair[role].hash);
    assert.ok(Number.isInteger(review.pair[role]?.pageCount) && review.pair[role].pageCount > 0);
    assert.equal(review.coverage[`${role}Pages`], review.pair[role].pageCount);
  }
  const reviewNotes = (initial.reviewNotes || []).filter(note => note.batchId === review.batchId);
  assert.equal(review.noteCount, reviewNotes.length);
  assert.ok(reviewNotes.every(note => note.origin === 'codex' && note.reviewCycleId === review.cycleId && note.pairId === pair.pairId && note.sourceSnapshotId === initial.project.snapshotId));
  record('genuine current review cycle delivered both complete PDFs in one paper turn', { batchId: review.batchId, cycleId: review.cycleId, pair: review.pair, coverage: review.coverage, finalTurnId: review.finalTurnId, noteCount: reviewNotes.length, zeroFindings: reviewNotes.length === 0 });

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch(browserOptions);
  page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => report.pageErrors.push(redact(error.message)));
  await page.route('**/*', async route => {
    const request = route.request(); let requestUrl;
    try { requestUrl = new URL(request.url()); } catch { return route.abort(); }
    if (requestUrl.origin !== url.origin) { report.blockedNetwork.push(requestUrl.origin); await route.abort(); return; }
    if (requestUrl.pathname.startsWith('/api')) {
      const action = request.postDataJSON()?.action; report.apiActions.push(action || 'missing-action');
      if (!readActions.has(action)) {
        report.blockedActions.push(action || 'missing-action');
        await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'READ_ONLY_ACCEPTANCE', message: 'Only read operations are permitted during actual-paper acceptance.' } }) }); return;
      }
    }
    await route.continue();
  });
  await page.goto(session.url, { waitUntil: 'domcontentloaded' });
  await page.locator('#pdf-container canvas').waitFor({ state: 'visible', timeout: 60000 });
  await page.locator('#translation-content .translation-input').first().waitFor({ state: 'visible' });
  assert.equal(await page.locator('#pdf-artifact').inputValue(), 'version-latest');
  assert.deepEqual(await page.locator('#pdf-artifact option').evaluateAll(nodes => nodes.map(node => node.value)), ['version-original', 'version-latest']);
  const pdfCaption = await page.locator('#pdf-caption').textContent();
  assert.ok(pdfCaption.includes(english.buildId));
  assert.ok(pdfCaption.includes('当前源的英文原稿构建'));
  assert.equal(await page.locator('#view-pdf').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#show-drafts').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#four-layer-view').isVisible(), false);
  assert.equal(await page.locator('#translation-content').isVisible(), true);
  assert.equal(await page.locator('#annotation-panel').isVisible(), true);
  assert.equal(await page.locator('#codex-panel').isVisible(), false);
  assert.equal(await page.locator('#annotation-filter').inputValue(), 'all');
  assert.equal(await page.locator('#language').inputValue(), 'zh-CN');
  assert.equal(await page.locator('#source-details').evaluate(node => node.open), false);
  record('installed default shows English PDF, editable translation and paragraph opinions');

  // Extract the exact selected artifact with the same bundled PDF.js in Chromium.
  // No server route, external package or real-paper text is sent to another host.
  const [pdfModule, pdfWorker] = await Promise.all([
    readFile(new URL('../node_modules/pdfjs-dist/build/pdf.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), 'utf8')
  ]);
  const extracted = await page.evaluate(async ({ moduleText, workerText, base64 }) => {
    const moduleUrl = URL.createObjectURL(new Blob([moduleText], { type: 'text/javascript' }));
    const workerUrl = URL.createObjectURL(new Blob([workerText], { type: 'text/javascript' }));
    let task;
    try {
      const { getDocument, GlobalWorkerOptions } = await import(moduleUrl); GlobalWorkerOptions.workerSrc = workerUrl;
      const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
      task = getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, stopAtErrors: true, verbosity: 0 });
      const document = await task.promise, pages = [];
      for (let number = 1; number <= document.numPages; number++) {
        const content = await (await document.getPage(number)).getTextContent();
        pages.push(content.items.map(item => item.str || '').join(' '));
      }
      return { pageCount: document.numPages, pages };
    } finally { await task?.destroy(); URL.revokeObjectURL(moduleUrl); URL.revokeObjectURL(workerUrl); }
  }, { moduleText: pdfModule, workerText: pdfWorker, base64: pdf.base64 });
  const englishText = extracted.pages.join('\n\n');
  assert.equal(extracted.pageCount, review.pair.latest.pageCount, 'The review did not cover every page of the current latest English PDF.');
  await writeFile(path.join(output, 'current-english-text.txt'), englishText, { mode: 0o600 });
  assert.ok(extracted.pageCount > 0 && englishText.match(/[A-Za-z]{3,}/g)?.length > 40, 'The English PDF must contain extractable English manuscript prose.');
  assert.equal((englishText.match(/\p{Script=Han}/gu) || []).length, 0, 'The derived English reading PDF still contains Chinese companion text.');
  record('every page of the current English PDF contains extractable English and no Han companion text', { pageCount: extracted.pageCount, textCharacters: englishText.length, textHash: hash(englishText), hanCharacters: 0 });

  const geometry = await page.evaluate(() => Object.fromEntries(['pdf-container', 'translation-scroll', 'annotation-scroll'].map(id => {
    const box = document.getElementById(id).getBoundingClientRect(); return [id, { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height }];
  })));
  for (const id of ['pdf-container']) {
    assert.ok(Math.abs(geometry[id].top - geometry['translation-scroll'].top) <= 2, 'Desktop reading panes have different top boundaries.');
    assert.ok(Math.abs(geometry[id].bottom - geometry['translation-scroll'].bottom) <= 2, 'Desktop reading panes have different bottom boundaries.');
  }
  assert.ok(geometry['translation-scroll'].height > 450);
  assert.ok(geometry['pdf-container'].right <= geometry['translation-scroll'].left && geometry['translation-scroll'].right <= geometry['annotation-scroll'].left);
  record('1600px English PDF and translation share top and bottom boundaries in the intended column order', { geometry });
  const compact = await page.evaluate(() => ({ header: document.querySelector('.project-bar').getBoundingClientRect().height, toolbar: document.querySelector('.source-toolbar').getBoundingClientRect().height, railLeft: document.querySelector('.tool-rail').getBoundingClientRect().left, railRight: document.querySelector('.tool-rail').getBoundingClientRect().right, mainLeft: document.querySelector('.workspace-main').getBoundingClientRect().left }));
  assert.ok(compact.header <= 42 && compact.toolbar <= 40 && compact.railRight <= compact.mainLeft + 1);
  record('compact header and left tool rail preserve the primary reading surface', compact);
  await noOverflow('1600px desktop');
  await screenshot('desktop-default-three-columns');

  const readings = initial.readingParagraphs?.length ? initial.readingParagraphs : initial.segments.filter(segment => segment.translatable);
  const prose = readings.filter(paragraph => paragraph.translatable !== false && (!paragraph.kind || paragraph.kind === 'paragraph') && !inAbstract(paragraph) && /[A-Za-z]{3,}/.test(paragraph.source || paragraph.displayText || ''));
  assert.ok(prose.length >= 3, 'Three actual non-abstract prose paragraphs are required.');
  const requestedParagraph = process.env.PAPER_EDITOR_PARAGRAPH_ID;
  const third = requestedParagraph ? prose.find(paragraph => paragraph.id === requestedParagraph) : prose[2];
  assert.ok(third, 'The explicitly selected acceptance paragraph must be current non-abstract prose.');
  await page.locator('#annotation-filter').selectOption('selected');
  const focusAndCheckNotes = async (paragraph, label) => {
    // Match an exact data attribute without placing source IDs in selector syntax.
    const index = await page.locator('.translation-paragraph').evaluateAll((nodes, id) => nodes.findIndex(node => node.dataset.unitId === id), paragraph.id);
    assert.ok(index >= 0, 'The selected current paragraph has no translation editor.');
    const node = page.locator('.translation-paragraph').nth(index), editor = node.locator('.translation-input');
    assert.equal(await editor.getAttribute('contenteditable'), 'true');
    assert.equal(await editor.evaluate(element => element.disabled), false);
    await editor.focus();
    await page.waitForFunction(id => document.querySelector('.translation-paragraph.selected')?.dataset.unitId === id, paragraph.id);
    const selectedIds = (await page.locator('#annotation-selection').getAttribute('title')).split(' · ').filter(Boolean);
    assert.ok(selectedIds.includes(paragraph.id), 'The selection did not retain the exact reading paragraph identity.');
    const expected = (initial.reviewNotes || []).filter(note => globalNote(note) || noteIds(note).some(id => selectedIds.includes(id))).map(note => note.noteId).sort();
    await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('#annotation-list [data-note-id]')].map(node => node.dataset.noteId).sort()) === JSON.stringify(expected), expected);
    const actual = await page.locator('#annotation-list [data-note-id]').evaluateAll(nodes => nodes.map(node => ({ noteId: node.dataset.noteId, sourceIds: JSON.parse(node.dataset.sourceIds || '[]') })));
    assert.deepEqual(actual.map(note => note.noteId).sort(), expected);
    for (const note of actual) assert.deepEqual(note.sourceIds, noteIds(initial.reviewNotes.find(item => item.noteId === note.noteId)));
    assert.equal(await editor.evaluate(element => document.activeElement === element), true);
    record(label, { paragraphId: paragraph.id, proseOrdinal: prose.findIndex(item => item.id === paragraph.id) + 1, visibleOrdinal: index + 1, selectedSourceIds: selectedIds, exactNoteIds: expected, editable: true });
    return expected;
  };
  const thirdNotes = await focusAndCheckNotes(third, 'focusing the actual non-abstract paragraph selects its exact IDs and only its matching opinions');
  await screenshot('desktop-selected-third-prose-paragraph');
  const requestedNote = process.env.PAPER_EDITOR_EXPECTED_NOTE_ID;
  let knownNote = requestedNote ? reviewNotes.find(note => note.noteId === requestedNote) : reviewNotes.find(note => noteIds(note).includes(third.id));
  if (requestedNote) assert.ok(knownNote, 'The pinned expected note is absent from the selected completed review.');
  if (!knownNote) knownNote = reviewNotes.find(note => noteIds(note).some(id => readings.some(paragraph => paragraph.id === id)));
  if (knownNote) {
    const knownParagraph = readings.find(paragraph => noteIds(knownNote).includes(paragraph.id));
    assert.ok(knownParagraph, 'The pinned cycle opinion has no current reading anchor.');
    assert.equal(knownNote.sourceHashes?.[knownParagraph.id], knownParagraph.sourceHash || knownParagraph.beforeHash);
    const matching = knownParagraph.id === third.id ? thirdNotes : await focusAndCheckNotes(knownParagraph, 'an existing current-cycle opinion follows its exact selected paragraph');
    assert.ok(matching.includes(knownNote.noteId));
    record('a genuine current-cycle opinion is visible at its exact current source anchor', { paragraphId: knownParagraph.id, noteId: knownNote.noteId, batchId: review.batchId });
  } else {
    await page.locator('#annotation-filter').selectOption(reviewNotes.length ? 'unlocated' : 'all');
    const visible = await page.locator('#annotation-list [data-note-id]').evaluateAll(nodes => nodes.map(node => node.dataset.noteId));
    assert.ok(reviewNotes.every(note => !noteIds(note).length && visible.includes(note.noteId)));
    if (!reviewNotes.length) assert.equal(visible.filter(id => initial.reviewNotes.find(note => note.noteId === id)?.reviewCycleId === review.cycleId).length, 0);
    record('current-cycle opinions retain explicit unlocated or zero-finding state without manufactured anchors', { batchId: review.batchId, noteCount: reviewNotes.length, zeroFindings: reviewNotes.length === 0 });
  }
  await screenshot('desktop-genuine-review-opinion');

  await page.locator('#show-layers').click();
  assert.equal(await page.locator('#four-layer-view').isVisible(), true);
  await page.locator('#show-drafts').click();
  assert.equal(await page.locator('#translation-content').isVisible(), true);
  record('four-layer comparison remains accessible as an explicit auxiliary view');
  await page.locator('#chat-toggle').click();
  await page.waitForFunction(id => document.getElementById('chat-thread').textContent.trim() === id, expectedThread);
  assert.equal(await page.locator('#codex-panel').getAttribute('aria-modal'), 'true');
  await page.waitForFunction(() => /astra/i.test(document.getElementById('chat-model').value) && document.getElementById('chat-model').options.length > 1, null, { timeout: 60000 });
  assert.match(await page.locator('#chat-model').inputValue(), /astra/i);
  assert.equal(await page.locator('#chat-model').isEnabled(), true);
  assert.ok(await page.locator('#chat-model option').count() > 2, 'The actual model catalog must remain selectable.');
  await screenshot('desktop-persistent-astra-chat');
  await page.locator('#chat-close').click();
  record('Codex drawer retains the exact Astra paper thread');

  for (const [label, width, height] of [['1200px desktop', 1200, 900], ['1024px tablet', 1024, 900], ['390px mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    if (width < 850) {
      await page.locator('[data-mobile-tab="translation"]').click();
      assert.equal(await page.locator('#translation-content').isVisible(), true);
      await screenshot('mobile-editable-translation');
      await page.locator('[data-mobile-tab="notes"]').click();
      assert.equal(await page.locator('#annotation-list').isVisible(), true);
      await screenshot('mobile-paragraph-opinions');
    } else if (width < 1200) {
      if (!await page.locator('#annotation-panel').isVisible()) await page.locator('#annotations-toggle').click();
      assert.equal(await page.locator('#annotation-panel').isVisible(), true);
      const outward = await page.evaluate(() => {
        const translation = document.getElementById('translation-scroll').getBoundingClientRect(), notes = document.getElementById('annotation-panel').getBoundingClientRect();
        return { translationRight: translation.right, notesLeft: notes.left, width: translation.width };
      });
      assert.ok(outward.width > 150 && outward.translationRight <= outward.notesLeft + 1, 'Paragraph opinions must reserve space outward to the right without covering editable translation.');
      await screenshot('tablet-paragraph-opinions');
      await page.locator('#annotation-close').click();
    }
    await noOverflow(label);
  }
  await page.setViewportSize({ width: 1600, height: 1100 });
  assert.deepEqual(await page.locator('#theme option').evaluateAll(options => options.map(option => option.value)), ['light', 'dark']);
  await page.locator('#theme').selectOption('dark'); await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  const darkInk = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ink'));
  await screenshot('desktop-dark-reading');
  await page.locator('#theme').selectOption('light'); await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  const lightInk = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ink')); assert.notEqual(lightInk, darkInk);
  record('installed warm light and dark reading modes are selectable');
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.blockedActions, []); assert.deepEqual(report.blockedNetwork, []);
  record('actual-paper inspection caused no UI errors, attempted mutations or external network requests');
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = { message: redact(error.message), stack: redact(error.stack) };
  if (page) await screenshot('failure').catch(() => {});
  console.error('Actual-paper three-column acceptance failed. Inspect the private report for details.');
  process.exitCode = 1;
} finally {
  try {
    if (initial) {
      const after = (await api('state')).result;
      report.sourceHashAfter = hash(await readFile(resolvedTarget));
      assert.equal(report.sourceHashAfter, sourceBefore);
      await sourceManifest(initial.project);
      assert.equal(contentIdentity(after), initialIdentity);
      const chat = (await api('chatState')).result; assert.equal(chat.threadId, expectedThread);
      record('all source bytes, immutable originals, translation drafts, opinions and transactions remain unchanged');
    }
  } catch (error) { report.ok = false; report.invarianceError = redact(error.message); process.exitCode = 1; }
  await browser?.close();
  report.completedAt = new Date().toISOString();
  const reportPath = path.join(output, 'three-column-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ok: report.ok, passed: report.checks.length, report: reportPath, screenshotCount: report.screenshots.length }));
}
