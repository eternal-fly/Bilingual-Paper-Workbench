import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, browserOptions } from './ui-qa-support.mjs';

// One author-authorized real model call, through the installed full-review UI.
// Required env: TARGET_FILE, SESSION_FILE, PRIVATE_OUTPUT, EXPECTED_THREAD_ID,
// or their PAPER_EDITOR_ aliases. Optional PAPER_EDITOR_REVIEW_INSTRUCTION and
// PAPER_EDITOR_CONTEXT_DIR (the exact dedicated private two-PDF chat directory).
// This script never retries a model call, imports opinions or promotes source.
const required = (name, alias) => {
  const value = process.env[name] || process.env[alias];
  assert.ok(value, `Set ${name} (or ${alias}) for actual review-cycle acceptance.`);
  return value;
};
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (root, value) => { const relative = path.relative(root, value); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const target = required('PAPER_EDITOR_TARGET_FILE', 'TARGET_FILE'), sessionFile = required('PAPER_EDITOR_SESSION_FILE', 'SESSION_FILE');
const privateOutput = required('PAPER_EDITOR_PRIVATE_OUTPUT', 'PRIVATE_OUTPUT'), expectedThread = required('PAPER_EDITOR_EXPECTED_THREAD_ID', 'EXPECTED_THREAD_ID');
const instruction = process.env.PAPER_EDITOR_REVIEW_INSTRUCTION || '请比较最初原稿与最新英文稿，检查论证前提、符号一致性和段落衔接，并结合现有中文译稿更新中文翻译。只提出有依据的具体意见，不强行制造问题；保留全部公式、引用、数字与结论的适用范围。';
assert.ok(instruction.trim() && instruction.length <= 8000, 'Use one nonempty bounded free-form author instruction.');
for (const value of [target, sessionFile, privateOutput]) assert.ok(path.isAbsolute(value), 'Acceptance paths must be absolute.');
const repository = await realpath(fileURLToPath(new URL('../../../', import.meta.url))), resolvedTarget = await realpath(target);
assert.ok(!inside(repository, resolvedTarget), 'Actual manuscript sources must stay outside the repository.');
const projectRoot = await realpath(path.dirname(resolvedTarget)), sessionRoot = await realpath(path.dirname(sessionFile));
const privateRoot = path.basename(sessionRoot).toLowerCase() === 'sessions' ? path.dirname(sessionRoot) : sessionRoot;
assert.ok(!inside(repository, privateRoot) && inside(privateRoot, path.resolve(privateOutput)), 'Use the private application data root for all acceptance artifacts.');
await mkdir(privateOutput, { recursive: true, mode: 0o700 });
const output = await realpath(privateOutput); assert.ok(inside(privateRoot, output) && !inside(repository, output));
const session = JSON.parse(await readFile(sessionFile, 'utf8'));
let url; try { url = new URL(session.url); } catch { throw new Error('The private session URL is invalid.'); }
assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/');
assert.ok(/^#session=[A-Za-z0-9_-]{40,50}$/.test(url.hash)); assert.equal(session.mode, 'independent-workbench');
const token = new URLSearchParams(url.hash.slice(1)).get('session');
const redact = value => String(value).replaceAll(session.url, '[private session]').replaceAll(token, '[private credential]').replace(/#session=[A-Za-z0-9_-]+/g, '#session=[redacted]');
const report = { schemaVersion: 1, actualPaper: true, installedSession: true, authorizedModelActions: 1, sourceReadOnly: true, derivedDraftUpdatesAllowed: true, startedAt: new Date().toISOString(), checks: [], screenshots: [], pageErrors: [], apiActions: [], blockedActions: [], blockedNetwork: [] };
const record = (name, detail = {}) => { report.checks.push({ name, passed: true, ...detail }); console.log(`PASS ${name}`); };
const readActions = new Set(['state', 'models', 'chatState', 'readPdf', 'readVersionPair', 'readBuildLog', 'locateSource', 'locatePdf']);
const api = async (action, payload = {}) => {
  assert.ok(readActions.has(action), 'Direct acceptance API calls are read-only.');
  let response, body;
  try {
    response = await fetch(new URL('/api', url), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url.origin, Authorization: `Bearer ${token}` }, body: JSON.stringify({ action, payload }), signal: AbortSignal.timeout(45000) });
    body = await response.json();
  } catch { throw new Error(`Read-only ${action} request did not return valid data.`); }
  assert.ok(response.ok && body.ok, `${action} failed: ${redact(body.error?.code || 'API_ERROR')}`); return body;
};
const invariant = state => hash(JSON.stringify(Object.fromEntries(['project', 'segments', 'readingParagraphs', 'originals', 'originalSnapshotId', 'alignments', 'proposals', 'comments', 'transactions', 'readingAnchors', 'syncPreferences'].map(key => [key, state[key]]))));
const externalNotes = state => (state.reviewNotes || []).filter(note => !['codex', 'ai', 'model'].includes(note.origin));
const pairMetadata = pair => ({ pairId: pair.pairId, projectId: pair.projectId, revision: pair.revision, original: { hash: pair.original.hash, byteLength: pair.original.byteLength, buildId: pair.original.buildId, snapshotId: pair.original.snapshotId }, latest: { hash: pair.latest.hash, byteLength: pair.latest.byteLength, buildId: pair.latest.buildId, snapshotId: pair.latest.snapshotId } });
const pageEvidence = context => ({ pairId: context.pairId, contextHash: hash(JSON.stringify(context)), ...Object.fromEntries(['original', 'latest'].map(role => [role, { hash: context[role].hash, pageCount: context[role].pageCount, pages: context[role].pages.map(page => ({ page: page.page, textBytes: Buffer.byteLength(page.text), textHash: hash(page.text) })) }])) });
let initial, beforeIdentity, initialChat, pair, sources, browser, page, submitted, queued, finalState, completedBatch, cycleCalls = 0, contextBefore;
const sourceManifest = async project => {
  assert.ok(project?.files?.length, 'The exact current project read-set is required.');
  const entries = [];
  for (const file of project.files) {
    assert.ok(typeof file.path === 'string' && !path.isAbsolute(file.path));
    const candidate = path.resolve(projectRoot, file.path); assert.ok(inside(projectRoot, candidate));
    const resolved = await realpath(candidate); assert.ok(inside(projectRoot, resolved));
    const bytes = await readFile(resolved); assert.equal(hash(bytes), file.hash, 'A manuscript source differs from the current snapshot.');
    entries.push({ path: file.path, hash: hash(bytes), size: bytes.length });
  }
  return entries;
};
const contextManifest = async () => {
  const requested = process.env.PAPER_EDITOR_CONTEXT_DIR || process.env.CONTEXT_DIR;
  if (!requested) return null;
  assert.ok(path.isAbsolute(requested), 'The optional dedicated PDF context directory must be absolute.');
  const applicationRoot = path.basename(privateRoot).toLowerCase() === 'preview' ? path.dirname(privateRoot) : privateRoot;
  const directory = await realpath(requested); assert.ok(inside(applicationRoot, directory) && !inside(repository, directory));
  const entries = await readdir(directory, { withFileTypes: true });
  assert.deepEqual(entries.map(entry => entry.name).sort(), ['latest-english.pdf', 'original.pdf']);
  const files = [];
  for (const entry of entries) {
    const filename = path.join(directory, entry.name), info = await lstat(filename);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    const bytes = await readFile(filename), role = entry.name === 'original.pdf' ? 'original' : 'latest';
    assert.equal(hash(bytes), pair[role].hash); files.push({ filename: entry.name, hash: hash(bytes), bytes: bytes.length });
  }
  return { directory, files: files.sort((a, b) => a.filename.localeCompare(b.filename)) };
};
const screenshot = async name => { const filename = path.join(output, `${name}.png`); await page.screenshot({ path: filename, fullPage: true }); report.screenshots.push(filename); };
const validateSubmission = payload => {
  assert.equal(payload.language, 'zh-CN'); assert.equal(payload.includeTranslations, true);
  assert.equal(payload.instruction, instruction); assert.ok(!payload.conversation); assert.ok(!Object.hasOwn(payload, 'sourceSegmentIds'));
  assert.equal(payload.pairContext?.pairId, pair.pairId);
  for (const role of ['original', 'latest']) {
    const document = payload.pairContext[role]; assert.equal(document.hash, pair[role].hash);
    assert.equal(document.pageCount, expectedContext[role].pageCount);
    assert.equal(document.pages.length, document.pageCount);
    assert.deepEqual(document.pages.map(item => ({ page: item.page, hash: hash(item.text) })), expectedContext[role].pages.map(item => ({ page: item.page, hash: hash(item.text) })), 'The submitted PDF context omitted or altered an extracted page.');
  }
};
let expectedContext;
try {
  initial = (await api('state')).state;
  assert.equal(initial.project?.mainFile, path.basename(resolvedTarget));
  sources = await sourceManifest(initial.project); beforeIdentity = invariant(initial);
  report.sourceHashBefore = hash(await readFile(resolvedTarget));
  await api('models'); initialChat = (await api('chatState')).result;
  assert.equal(initialChat.threadId, expectedThread); assert.match(initialChat.model || '', /astra/i); assert.equal(initialChat.busy, false);
  pair = (await api('readVersionPair')).result;
  assert.equal(pair.projectId, initial.project.id); assert.equal(pair.latest.snapshotId, initial.project.snapshotId);
  for (const role of ['original', 'latest']) {
    const bytes = Buffer.from(pair[role].base64, 'base64'); assert.equal(hash(bytes), pair[role].hash); assert.equal(bytes.length, pair[role].byteLength);
  }
  contextBefore = await contextManifest(); report.pair = pairMetadata(pair);
  record('exact private PDF pair and idle persistent Astra thread are ready', { pair: report.pair, threadId: initialChat.threadId, model: initialChat.model, userMessagesBefore: initialChat.messages.filter(message => message.role === 'user').length, dedicatedContextFiles: contextBefore?.files || null });

  const { chromium } = await loadPlaywright(); browser = await chromium.launch(browserOptions);
  page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => report.pageErrors.push(redact(error.message)));
  await page.route('**/*', async route => {
    const request = route.request(); let requestUrl; try { requestUrl = new URL(request.url()); } catch { return route.abort(); }
    if (requestUrl.origin !== url.origin) { report.blockedNetwork.push(requestUrl.origin); await route.abort(); return; }
    if (requestUrl.pathname.startsWith('/api')) {
      const body = request.postDataJSON() || {}, action = body.action;
      report.apiActions.push({ action: action || 'missing-action', endpoint: requestUrl.pathname, payloadKeys: Object.keys(body.payload || {}) });
      if (action === 'reviewCycle') {
        cycleCalls++;
        try {
          assert.equal(cycleCalls, 1, 'Only one explicit UI review cycle is authorized by this acceptance run.');
          assert.equal(requestUrl.pathname, '/api/review-cycle'); validateSubmission(body.payload); submitted = body.payload;
        } catch (error) {
          report.blockedActions.push('reviewCycle'); report.submissionError = redact(error.message);
          await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'ACCEPTANCE_SCOPE_MISMATCH', message: 'The review request differs from the one authorized acceptance action.' } }) }); return;
        }
      } else if (!readActions.has(action)) {
        report.blockedActions.push(action || 'missing-action');
        await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'ACCEPTANCE_SCOPE_MISMATCH', message: 'Only reads and one explicit full-review cycle are permitted.' } }) }); return;
      }
    }
    await route.continue();
  });
  await page.goto(session.url, { waitUntil: 'domcontentloaded' });
  await page.locator('#pdf-container canvas').waitFor({ state: 'visible', timeout: 60000 });
  const languageMenu = page.locator('.language-menu');
  if (!await languageMenu.evaluate(node => node.open)) await languageMenu.locator('summary').click();
  await page.locator('#language').selectOption('zh-CN');
  if (await languageMenu.evaluate(node => node.open)) await languageMenu.locator('summary').click();
  assert.equal(await page.locator('#pdf-artifact').inputValue(), 'version-latest');
  await screenshot('review-cycle-before');

  // Independent extraction verifies the actual UI request's every-page payload.
  const [moduleText, workerText] = await Promise.all([readFile(new URL('../node_modules/pdfjs-dist/build/pdf.mjs', import.meta.url), 'utf8'), readFile(new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), 'utf8')]);
  expectedContext = await page.evaluate(async ({ moduleText, workerText, pair }) => {
    const moduleUrl = URL.createObjectURL(new Blob([moduleText], { type: 'text/javascript' })), workerUrl = URL.createObjectURL(new Blob([workerText], { type: 'text/javascript' }));
    const tasks = [];
    try {
      const { getDocument, GlobalWorkerOptions } = await import(moduleUrl); GlobalWorkerOptions.workerSrc = workerUrl;
      const context = { pairId: pair.pairId };
      for (const role of ['original', 'latest']) {
        const task = getDocument({ data: Uint8Array.from(atob(pair[role].base64), char => char.charCodeAt(0)), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, stopAtErrors: true, enableXfa: false, verbosity: 0 }); tasks.push(task);
        const document = await task.promise, pages = [];
        for (let number = 1; number <= document.numPages; number++) {
          const page = await document.getPage(number), content = await page.getTextContent();
          const text = content.items.filter(item => typeof item.str === 'string').map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').replace(/\r\n?/gu, '\n').trim();
          if (!text) throw new Error('A PDF page has no extractable text.'); pages.push({ page: number, text }); page.cleanup();
        }
        context[role] = { hash: pair[role].hash, pageCount: document.numPages, pages };
      }
      return context;
    } finally { await Promise.allSettled(tasks.map(task => task.destroy())); URL.revokeObjectURL(moduleUrl); URL.revokeObjectURL(workerUrl); }
  }, { moduleText, workerText, pair });
  assert.equal((expectedContext.latest.pages.map(page => page.text).join('\n').match(/\p{Script=Han}/gu) || []).length, 0, 'The latest English PDF still contains Han companion text.');
  const independentEvidence = pageEvidence(expectedContext);
  await writeFile(path.join(output, 'review-cycle-independent-page-evidence.json'), JSON.stringify(independentEvidence, null, 2), { mode: 0o600 });
  record('both exact PDFs expose all consecutive readable pages before the single review', { originalPages: expectedContext.original.pageCount, latestPages: expectedContext.latest.pageCount, latestHanCharacters: 0, contextHash: independentEvidence.contextHash });

  await page.locator('#full-review-open').click();
  await page.locator('#full-review-scope-choice').selectOption('all'); await page.locator('#full-review-translations').check();
  await page.locator('#full-review-instruction').fill(instruction);
  const responsePromise = page.waitForResponse(response => { try { return new URL(response.url()).pathname === '/api/review-cycle' && response.request().postDataJSON()?.action === 'reviewCycle'; } catch { return false; } }, { timeout: 120000 });
  await page.locator('#full-review-submit').click();
  const response = await responsePromise, result = await response.json();
  assert.ok(response.ok() && result.ok, 'The single explicit UI review request was rejected.');
  queued = result.result; assert.ok(queued?.cycleId && queued.jobId && queued.batchId); assert.equal(cycleCalls, 1); assert.ok(submitted);
  const submittedEvidence = pageEvidence(submitted.pairContext);
  await writeFile(path.join(output, 'review-cycle-submitted-page-evidence.json'), JSON.stringify(submittedEvidence, null, 2), { mode: 0o600 });
  assert.deepEqual(submittedEvidence, independentEvidence);
  record('one explicit full-review UI action submitted both complete PDFs and the free instruction', { jobId: queued.jobId, cycleId: queued.cycleId, batchId: queued.batchId, includeTranslations: true, targetLanguage: 'zh-CN', instructionHash: hash(instruction), originalPages: submitted.pairContext.original.pageCount, latestPages: submitted.pairContext.latest.pageCount, contextHash: submittedEvidence.contextHash });
  await screenshot('review-cycle-submitted');

  const deadline = Date.now() + 360000;
  for (;;) {
    finalState = (await api('state')).state;
    completedBatch = finalState.reviewBatches.find(batch => batch.cycleId === queued.cycleId);
    if (completedBatch && ['completed', 'failed', 'cancelled', 'stale'].includes(completedBatch.status)) break;
    assert.ok(Date.now() < deadline, 'The authorized review cycle did not finish in the acceptance wait window; no retry was started.');
    await page.waitForTimeout(1500);
  }
  assert.equal(completedBatch.status, 'completed', 'The one-turn review cycle did not complete.');
  assert.equal(completedBatch.scope, 'paper'); assert.equal(completedBatch.conversation, false); assert.equal(completedBatch.language, 'zh-CN');
  assert.equal(completedBatch.threadId, expectedThread); assert.equal(completedBatch.model, initialChat.model);
  assert.equal(completedBatch.sourceSnapshotId, initial.project.snapshotId); assert.equal(completedBatch.pair.pairId, pair.pairId);
  assert.equal(completedBatch.coverage.completePdfTextsDelivered, true); assert.equal(completedBatch.coverage.completedTurns, 1);
  assert.equal(completedBatch.pair.contextHash, submittedEvidence.contextHash);
  for (const role of ['original', 'latest']) {
    assert.equal(completedBatch.pair[role].hash, pair[role].hash); assert.equal(completedBatch.pair[role].pageCount, expectedContext[role].pageCount);
    assert.equal(completedBatch.coverage[`${role}Pages`], expectedContext[role].pageCount);
  }
  const afterChat = (await api('chatState')).result;
  assert.equal(afterChat.threadId, expectedThread); assert.equal(afterChat.model, initialChat.model);
  const beforeUsers = initialChat.messages.filter(message => message.role === 'user'), afterUsers = afterChat.messages.filter(message => message.role === 'user');
  assert.equal(afterUsers.length, beforeUsers.length + 1, 'The review must add exactly one user turn, with no chunk acknowledgements.');
  const newUsers = afterUsers.filter(message => !beforeUsers.some(previous => previous.id === message.id));
  assert.equal(newUsers.length, 1); assert.equal(newUsers[0].text, instruction);
  assert.equal(newUsers[0].reviewMetadata?.cycleId, queued.cycleId); assert.equal(newUsers[0].reviewMetadata?.pairId, pair.pairId);
  assert.equal(newUsers[0].turnId, completedBatch.finalTurnId); assert.equal(newUsers[0].model, initialChat.model);
  assert.ok(afterChat.messages.some(message => message.role === 'assistant' && message.turnId === completedBatch.finalTurnId));
  record('the complete dual-PDF review finished in exactly one new user turn on the same Astra thread', { threadId: expectedThread, model: afterChat.model, userMessagesBefore: beforeUsers.length, userMessagesAfter: afterUsers.length, newUserTurns: 1, finalTurnId: completedBatch.finalTurnId, coverage: completedBatch.coverage });

  const requests = finalState.requests.filter(request => !initial.requests.some(previous => previous.requestId === request.requestId));
  assert.equal(requests.length, 1); const request = requests[0];
  assert.equal(request.origin, 'reviewCycle'); assert.equal(request.cycleId, queued.cycleId); assert.equal(request.language, 'zh-CN'); assert.equal(request.bindingId, `codex:${expectedThread}`);
  const targetIds = initial.readingParagraphs.filter(paragraph => paragraph.translatable && paragraph.requestable !== false).map(paragraph => paragraph.id);
  assert.deepEqual([...request.segmentIds].sort(), [...targetIds].sort());
  assert.ok(completedBatch.translationsApplied > 0, 'At least one target-language derived draft must be published by the authorized cycle.');
  assert.equal(request.appliedSegmentIds.length, completedBatch.translationsApplied);
  assert.equal(completedBatch.translationsApplied + completedBatch.translationsHistorical, targetIds.length);
  assert.equal(request.status, completedBatch.translationsHistorical ? 'stale' : 'completed');
  for (const id of request.appliedSegmentIds) {
    const before = initial.translations['zh-CN']?.[id], after = finalState.translations['zh-CN']?.[id];
    assert.equal(after.reviewCycleId, queued.cycleId); assert.equal(after.origin, 'ai'); assert.equal(after.revision, (before?.revision || 0) + 1);
    assert.equal(after.sourceHash, initial.readingParagraphs.find(paragraph => paragraph.id === id).sourceHash);
  }
  for (const [language, drafts] of Object.entries(finalState.translations || {})) for (const [id, draft] of Object.entries(drafts)) {
    if (language === 'zh-CN' && request.appliedSegmentIds.includes(id)) continue;
    assert.deepEqual(draft, initial.translations?.[language]?.[id], 'The cycle modified a draft outside its permitted target-language write-set.');
  }
  for (const [language, drafts] of Object.entries(initial.translations || {})) for (const [id, draft] of Object.entries(drafts)) {
    if (language === 'zh-CN' && request.appliedSegmentIds.includes(id)) continue;
    assert.deepEqual(finalState.translations?.[language]?.[id], draft, 'The cycle removed a draft outside its permitted target-language write-set.');
  }
  assert.deepEqual(initial.requests, finalState.requests.filter(request => initial.requests.some(previous => previous.requestId === request.requestId)));
  assert.deepEqual(initial.reviewBatches, finalState.reviewBatches.filter(batch => initial.reviewBatches.some(previous => previous.batchId === batch.batchId)));
  assert.deepEqual(externalNotes(finalState), externalNotes(initial)); assert.equal(invariant(finalState), beforeIdentity);
  const notes = finalState.reviewNotes.filter(note => note.reviewCycleId === queued.cycleId);
  assert.equal(completedBatch.noteCount, notes.length);
  assert.ok(notes.every(note => note.origin === 'codex' && note.batchId === queued.batchId && note.pairId === pair.pairId && note.sourceSnapshotId === initial.project.snapshotId));
  report.cycle = { cycleId: queued.cycleId, batchId: queued.batchId, finalTurnId: completedBatch.finalTurnId, pair: completedBatch.pair, coverage: completedBatch.coverage, noteCount: notes.length, zeroFindings: notes.length === 0, translationsApplied: completedBatch.translationsApplied, translationsHistorical: completedBatch.translationsHistorical };
  record('only the permitted Chinese derived drafts and current model opinions were published', report.cycle);
  const draftId = request.appliedSegmentIds[0], draftIndex = await page.locator('.translation-paragraph').evaluateAll((nodes, id) => nodes.findIndex(node => node.dataset.unitId === id), draftId);
  assert.ok(draftIndex >= 0); const editor = page.locator('.translation-paragraph').nth(draftIndex).locator('.translation-input');
  await page.waitForFunction(({ id, text }) => [...document.querySelectorAll('.translation-paragraph')].find(node => node.dataset.unitId === id)?.querySelector('.translation-input')?.value === text, { id: draftId, text: finalState.translations['zh-CN'][draftId].text }, { timeout: 30000 });
  assert.equal(await editor.getAttribute('contenteditable'), 'true'); await editor.focus();
  await page.locator('#annotation-filter').selectOption('all');
  await page.waitForFunction(ids => ids.every(id => [...document.querySelectorAll('#annotation-list [data-note-id]')].some(node => node.dataset.noteId === id)), notes.map(note => note.noteId));
  if (!notes.length) assert.equal((await page.locator('#annotation-list [data-note-id]').evaluateAll(nodes => nodes.map(node => node.dataset.noteId))).filter(id => finalState.reviewNotes.find(note => note.noteId === id)?.reviewCycleId === queued.cycleId).length, 0);
  await screenshot('review-cycle-completed-drafts-opinions');
  record('installed middle and right panes show the completed derived draft and truthful opinion count', { displayedDraftId: draftId, noteCount: notes.length, zeroFindings: notes.length === 0 });
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.blockedActions, []); assert.deepEqual(report.blockedNetwork, []); assert.equal(cycleCalls, 1);
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = { message: redact(error.message), stack: redact(error.stack) }; process.exitCode = 1;
  if (page) await screenshot('review-cycle-failure').catch(() => {});
  console.error('Actual review-cycle acceptance failed. Inspect the private report; no model retry was started.');
} finally {
  try {
    if (initial) {
      const after = (await api('state')).state;
      assert.equal(invariant(after), beforeIdentity); assert.deepEqual(await sourceManifest(initial.project), sources);
      report.sourceHashAfter = hash(await readFile(resolvedTarget)); assert.equal(report.sourceHashAfter, report.sourceHashBefore);
      const afterPair = (await api('readVersionPair')).result; assert.deepEqual(pairMetadata(afterPair), pairMetadata(pair));
      if (contextBefore) assert.deepEqual(await contextManifest(), contextBefore);
      record('original English, original Chinese, all source bytes, PDF context files and source transactions remain unchanged');
    }
  } catch (error) { report.ok = false; report.invarianceError = redact(error.message); process.exitCode = 1; }
  await browser?.close(); report.completedAt = new Date().toISOString(); report.uiReviewCycleCalls = cycleCalls;
  const reportPath = path.join(output, 'review-cycle-report.json'); await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ok: report.ok, passed: report.checks.length, report: reportPath, screenshotCount: report.screenshots.length, modelCalls: cycleCalls }));
}
