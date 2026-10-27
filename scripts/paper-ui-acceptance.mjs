import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, browserOptions } from './ui-qa-support.mjs';

// Actual-paper acceptance is deliberately separate from the synthetic UI suites.
// Credentials and all paper-bearing artifacts stay in the user's private data root.
const required = name => {
  const value = process.env[name];
  assert.ok(value, `Set ${name} before running actual-paper UI acceptance.`);
  return value;
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, value) => {
  const relative = path.relative(root, value);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const target = required('PAPER_EDITOR_TARGET_FILE');
const sessionFile = required('PAPER_EDITOR_SESSION_FILE');
const privateOutput = required('PAPER_EDITOR_PRIVATE_OUTPUT');
const expectedThread = required('PAPER_EDITOR_EXPECTED_THREAD_ID');
for (const value of [target, sessionFile, privateOutput]) assert.ok(path.isAbsolute(value), 'Acceptance paths must be absolute.');
const repoRoot = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
const sessionRoot = await realpath(path.dirname(sessionFile));
const privateRoot = path.basename(sessionRoot).toLowerCase() === 'sessions' ? path.dirname(sessionRoot) : sessionRoot;
assert.ok(!inside(repoRoot, privateRoot), 'The private session must be outside the repository.');
assert.ok(inside(privateRoot, path.resolve(privateOutput)), 'PAPER_EDITOR_PRIVATE_OUTPUT must stay under the private session data root.');
await mkdir(privateOutput, { recursive: true, mode: 0o700 });
const output = await realpath(privateOutput);
assert.ok(inside(privateRoot, output) && !inside(repoRoot, output), 'Resolved output must remain in the private data root.');
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
const api = async (action, payload = {}) => {
  const response = await fetch(new URL('/api', url), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url.origin, Authorization: `Bearer ${token}` }, body: JSON.stringify({ action, payload }) });
  const body = await response.json();
  assert.ok(response.ok && body.ok, `${action} failed: ${redact(body.error?.code || 'API_ERROR')}`);
  return body;
};
const sourceBefore = hash(await readFile(target));
const initial = (await api('state')).state;
const contentIdentity = state => hash(JSON.stringify({ project: state.project, segments: state.segments, originals: state.originals, originalSnapshotId: state.originalSnapshotId, translations: state.translations, alignments: state.alignments, proposals: state.proposals, requests: state.requests, transactions: state.transactions }));
const initialIdentity = contentIdentity(initial);
const report = { schemaVersion: 1, actualPaper: true, standalone: true, readOnlyAcceptance: true, startedAt: new Date().toISOString(), sourceHashBefore: sourceBefore, checks: [], screenshots: [], pageErrors: [], blockedActions: [], apiActions: [] };
const record = (name, detail = {}) => { report.checks.push({ name, passed: true, ...detail }); console.log(`PASS ${name}`); };
let browser, page, cleanupAllowed = false;
const screenshot = async name => {
  const filename = path.join(output, `${name}.png`);
  await page.screenshot({ path: filename, fullPage: true }); report.screenshots.push(filename);
};
const waitResponse = action => page.waitForResponse(response => {
  try { return new URL(response.url()).pathname === '/api' && response.request().postDataJSON()?.action === action; } catch { return false; }
}, { timeout: 45000 });
const responseBody = async response => {
  const body = await response.json();
  assert.ok(response.ok() && body.ok, `UI API failed: ${redact(body.error?.code || 'API_ERROR')}`);
  return body;
};
const noOverflow = async label => {
  const geometry = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(geometry.page <= geometry.viewport && geometry.body <= geometry.viewport, `${label} has horizontal page overflow.`);
  record(`${label} has no horizontal page overflow`, geometry);
};

try {
  assert.equal(initial.project?.mainFile, path.basename(target));
  const currentFile = initial.project.files.find(file => file.path === initial.project.mainFile);
  assert.equal(currentFile?.hash, sourceBefore);
  // The bridge loads its persisted identity lazily, when its live catalog connects.
  const catalog = (await api('models')).result;
  assert.ok(catalog.models?.some(item => /astra/i.test(item.id || item.model || '')), 'The live Codex catalog must contain Astra.');
  const persistedChat = (await api('chatState')).result;
  assert.equal(persistedChat.threadId, expectedThread);
  record('live Codex catalog contains Astra and loads the persisted paper thread', { modelCount: catalog.models.length, threadId: persistedChat.threadId });
  const proposal = initial.proposals.filter(item => item.author === 'ai' && item.reviewState === 'pending' && item.applicationState === 'notApplied' && item.baseSnapshotId === initial.project.snapshotId && !item.context?.undoOf).at(-1);
  assert.ok(proposal, 'A current pending actual AI proposal is required.');
  const request = initial.requests.find(item => item.requestId === proposal.context?.requestId);
  assert.equal(request?.status, 'completed');
  assert.equal(request?.bindingId, `codex:${expectedThread}`);
  assert.equal(request?.snapshotId, initial.project.snapshotId);
  if (process.env.PAPER_EDITOR_ADVICE_NOT_BEFORE) assert.ok(Date.parse(proposal.createdAt) >= Date.parse(process.env.PAPER_EDITOR_ADVICE_NOT_BEFORE), 'Advice predates the explicitly selected acceptance run.');
  const edit = proposal.edits.find(item => initial.originals?.[item.segmentId]?.translation);
  assert.ok(edit, 'The actual advice must have a preserved original bilingual pair.');
  const segment = initial.segments.find(item => item.id === edit.segmentId);
  const original = initial.originals[segment.id];
  assert.equal(edit.beforeHash, segment.beforeHash);
  assert.equal(original.sourceHash, hash(Buffer.from(original.source)));
  assert.equal(original.translationHash, segment.bilingualCompanion?.hash);
  const actualSource = await readFile(target);
  if (segment.path === initial.project.mainFile) {
    assert.equal(actualSource.subarray(segment.startByte, segment.endByte).toString('utf8'), segment.source);
    assert.equal(actualSource.subarray(segment.bilingualCompanion.startByte, segment.bilingualCompanion.endByte).toString('utf8'), original.translation);
  }
  record('exact authorized main source and current actual AI advice are identified', { projectId: initial.project.id, snapshotId: initial.project.snapshotId, segmentId: segment.id, proposalId: proposal.proposalId, proposalCreatedAt: proposal.createdAt });
  const baseline = initial.builds.filter(build => build.status === 'success' && !build.stale && (!build.candidateHash || build.promotedSnapshotId) && (build.promotedSnapshotId || build.snapshotId) === initial.project.snapshotId).at(-1);
  assert.ok(baseline, 'A successful current baseline is required before UI acceptance.');

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch(browserOptions);
  page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  page.on('pageerror', error => report.pageErrors.push(redact(error.message)));
  const readActions = new Set(['state', 'models', 'chatState', 'readPdf', 'readBuildLog', 'locateSource', 'locatePdf']);
  await page.route('**/api', async route => {
    const action = route.request().postDataJSON()?.action;
    report.apiActions.push(action || 'missing-action');
    if (!readActions.has(action) && !(cleanupAllowed && action === 'chatDisconnect')) {
      report.blockedActions.push(action || 'missing-action');
      await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'READ_ONLY_ACCEPTANCE', message: 'This acceptance run permits read-only operations.' } }) });
      return;
    }
    await route.continue();
  });
  await page.goto(session.url, { waitUntil: 'domcontentloaded' });
  await page.locator('#pdf-container canvas').waitFor({ state: 'visible', timeout: 45000 });
  assert.ok((await page.locator('#pdf-caption').innerText()).includes(baseline.buildId));
  record('initial left pane automatically opens the verified current baseline PDF');
  await page.locator('#view-source').click();
  await page.locator(`#source-${segment.id}`).waitFor({ timeout: 45000 });
  assert.ok((await page.locator('#main-file').innerText()).includes(path.basename(target)));
  await page.locator(`#source-${segment.id}`).click();
  await page.locator('#four-layer-view').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#show-layers').getAttribute('aria-pressed'), 'true');
  const layerLabels = await page.locator('#four-layer-view .layer-heading h3').allTextContents();
  assert.deepEqual(layerLabels.map(text => text.replace(/\s+/g, ' ').trim()), ['原稿 EN', '原翻译 CN', '写作建议', '最终修改']);
  assert.ok((await page.locator('#layer-original-source .layer-original-text').allTextContents()).includes(original.source));
  assert.ok((await page.locator('#layer-original-translation .layer-original-text').allTextContents()).includes(original.translation));
  assert.equal(await page.locator('#layer-original-source [contenteditable="true"], #layer-original-source textarea, #layer-original-source input, #layer-original-translation [contenteditable="true"], #layer-original-translation textarea, #layer-original-translation input').count(), 0);
  record('four actual layers display immutable original English and original Chinese');
  assert.ok((await page.locator('#layer-suggestions').textContent()).includes(proposal.proposalId));
  assert.ok((await page.locator('#layer-suggestions').textContent()).includes(proposal.reason));
  assert.ok((await page.locator('#layer-suggestions .layer-candidate-text').allTextContents()).includes(edit.replacement));
  assert.match(await page.locator('#layer-suggestion-author').innerText(), /AI/);
  assert.equal((await page.locator('#layer-final-status').innerText()).trim(), '尚未写回');
  assert.ok((await page.locator('#layer-final .layer-candidate-text').allTextContents()).includes(edit.replacement));
  record('fresh actual AI writing advice and final candidate remain visibly not applied', { reviewState: proposal.reviewState, applicationState: proposal.applicationState });

  if (!await page.locator('#codex-panel').isVisible()) await page.locator('#chat-toggle').click();
  await page.waitForFunction(() => [...document.getElementById('chat-model').options].some(option => /astra/i.test(option.value)) && document.getElementById('chat-model').options.length > 2, null, { timeout: 45000 });
  assert.equal((await page.locator('#chat-thread').innerText()).trim(), expectedThread);
  assert.equal(await page.locator('#chat-model').isEnabled(), true);
  assert.equal(await page.locator('#chat-effort').isEnabled(), true);
  assert.equal(await page.locator('#chat-connect').isEnabled(), true);
  const choices = await page.locator('#chat-model option').evaluateAll(nodes => nodes.map(node => ({ value: node.value, label: node.textContent })));
  assert.ok(choices.some(choice => /astra/i.test(choice.value)));
  assert.match(await page.locator('#chat-model').inputValue(), /astra/i);
  const desktopChat = await page.locator('#codex-panel').boundingBox();
  const desktopMain = await page.locator('#main').boundingBox();
  assert.ok(desktopChat && desktopMain && desktopChat.x >= desktopMain.x + desktopMain.width - 2, 'The desktop Codex panel must be docked beside the manuscript.');
  assert.equal(await page.locator('#codex-panel').getAttribute('aria-modal'), null);
  record('desktop Codex dock shows Astra, selection controls and the same persistent thread', { threadId: expectedThread, selectedModel: await page.locator('#chat-model').inputValue(), modelCount: choices.filter(choice => choice.value).length, messageCount: await page.locator('#chat-messages .chat-message').count() });
  const lastReply = page.locator('#chat-messages .from-codex .chat-message-text').last();
  assert.ok((await lastReply.innerText()).includes(proposal.reason));
  assert.ok(!(await lastReply.innerText()).includes('"requestId"'));
  assert.ok(!(await lastReply.innerText()).includes('⟦P1_'));
  assert.equal(await lastReply.locator('details').count(), 1);
  assert.equal(await lastReply.locator('details').getAttribute('open'), null);
  record('structured Codex reply is human-readable with exact raw data collapsed');
  await page.locator('#view-pdf').click();
  await page.locator('#pdf-container canvas').waitFor({ state: 'visible' });
  await noOverflow('1600px desktop');
  await screenshot('desktop-four-layers-astra');
  await page.locator('#layer-final').evaluate(node => node.closest('section').scrollIntoView({ block: 'start' }));
  await screenshot('desktop-advice-final-not-applied');
  await page.locator('#layer-original-source').evaluate(node => node.scrollIntoView({ block: 'start' }));

  await page.locator('#view-source').click();
  const locating = waitResponse('locateSource');
  await page.locator('#jump-to-pdf').click();
  const location = (await responseBody(await locating)).result;
  assert.equal(location.verified, true); assert.equal(location.method, 'synctex');
  assert.equal(location.buildId, baseline.buildId); assert.equal(location.pdfHash, baseline.pdfHash);
  assert.equal(location.snapshotId, initial.project.snapshotId);
  assert.ok(location.matches?.length);
  if (location.matches.length > 1 || location.ambiguous) {
    await page.locator('#synctex-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#synctex-choices button').count(), location.matches.length);
    await screenshot('pdf-source-location-chooser');
    await page.locator('#synctex-choices button').first().click();
    await page.locator('#synctex-dialog').waitFor({ state: 'hidden' });
    record('actual PDF forward navigation exposes every ambiguous SyncTeX choice', { choiceCount: location.matches.length });
  } else record('actual PDF forward navigation has one verified SyncTeX location', { choiceCount: 1 });
  await page.locator('#pdf-container canvas').waitFor({ state: 'visible', timeout: 45000 });
  await page.locator('.pdf-location-overlay').waitFor({ state: 'visible' });
  const caption = await page.locator('#pdf-caption').innerText();
  assert.ok(caption.includes(baseline.buildId)); assert.ok(caption.includes('当前源的隔离构建'));
  assert.ok(caption.includes(initial.project.snapshotId.slice(0, 16)));
  assert.equal(await page.locator('#pdf-artifact').inputValue(), baseline.buildId);
  assert.equal(await page.locator('#locate-source').isEnabled(), true);
  const canvas = await page.locator('#pdf-container canvas').evaluate(node => ({ width: node.width, height: node.height, label: node.getAttribute('aria-label') }));
  assert.ok(canvas.width > 0 && canvas.height > 0);
  record('PDF canvas is pinned to the exact current isolated baseline', { buildId: baseline.buildId, pdfHash: baseline.pdfHash, sourceSnapshotId: location.snapshotId, canvas });
  await screenshot('desktop-current-baseline-pdf');

  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator('#codex-panel').isVisible()) await page.locator('#chat-close').click();
  await page.locator('[data-mobile-tab="translation"]').click();
  await page.locator('#four-layer-view').waitFor({ state: 'visible' });
  assert.equal((await page.locator('#layer-final-status').innerText()).trim(), '尚未写回');
  await noOverflow('390px mobile four-layer view');
  await screenshot('mobile-four-layers');
  await page.locator('#layer-original-translation').evaluate(node => node.closest('section').scrollIntoView({ block: 'start' }));
  await screenshot('mobile-original-chinese');
  await page.locator('#layer-final').evaluate(node => node.closest('section').scrollIntoView({ block: 'start' }));
  await screenshot('mobile-advice-final-not-applied');
  await page.locator('[data-mobile-tab="chat"]').click();
  await page.locator('#codex-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#codex-panel').getAttribute('aria-modal'), 'true');
  assert.equal((await page.locator('#chat-thread').innerText()).trim(), expectedThread);
  await noOverflow('390px mobile Codex drawer');
  await screenshot('mobile-astra-chat');
  record('mobile Codex drawer preserves the exact persistent paper thread');
  await page.locator('#chat-close').click();
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.locator('#view-source').click();
  if (!await page.locator('#codex-panel').isVisible()) await page.locator('#chat-toggle').click();
  await page.locator('#chat-close').click();
  await page.locator('#chat-toggle').click();
  assert.equal((await page.locator('#chat-thread').innerText()).trim(), expectedThread);
  record('closing and reopening the chat dock preserves thread identity');
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.blockedActions, []);
  record('actual-paper interactions have no uncaught UI errors or attempted content mutations');
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = { message: redact(error.message), stack: redact(error.stack) };
  if (page) await screenshot('failure').catch(() => {});
  console.error('Actual-paper UI acceptance failed. Inspect the private report for details.');
  process.exitCode = 1;
} finally {
  try {
    const current = (await api('state')).state;
    if (current.chat?.connected === true && initial.chat?.connected !== true && !current.chat?.busy) {
      cleanupAllowed = true;
      await api('chatDisconnect');
      report.chatConnectionReleased = true;
    }
    const after = (await api('state')).state;
    report.sourceHashAfter = hash(await readFile(target));
    assert.equal(report.sourceHashAfter, sourceBefore);
    assert.equal(contentIdentity(after), initialIdentity);
    assert.equal(after.chat?.threadId, expectedThread);
    record('main source bytes, original layers, drafts, proposals and transactions remain unchanged');
  } catch (error) {
    report.ok = false; report.cleanupError = redact(error.message); process.exitCode = 1;
  }
  await browser?.close();
  report.completedAt = new Date().toISOString();
  const reportPath = path.join(output, 'report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ok: report.ok, passed: report.checks.length, report: reportPath, screenshotCount: report.screenshots.length }));
}
