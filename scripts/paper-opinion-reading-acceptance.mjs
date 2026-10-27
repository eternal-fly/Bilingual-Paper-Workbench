import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, browserOptions } from './ui-qa-support.mjs';

// Read-only acceptance. Manuscript content, screenshots and credentials stay in
// the private application root; only this generic driver belongs in the package.
const required = name => { const value = process.env[name]; assert.ok(value, `Set ${name}.`); assert.ok(path.isAbsolute(value), `${name} must be absolute.`); return value; };
const sessionFile = required('PAPER_EDITOR_SESSION_FILE');
const targetFile = required('PAPER_EDITOR_TARGET_FILE');
const outputPath = required('PAPER_EDITOR_PRIVATE_OUTPUT');
const inside = (root, value) => { const relative = path.relative(root, value); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const repo = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
const sessions = await realpath(path.dirname(sessionFile));
const privateRoot = path.basename(sessions).toLowerCase() === 'sessions' ? path.dirname(sessions) : sessions;
assert.ok(!inside(repo, privateRoot) && inside(privateRoot, path.resolve(outputPath)));
await mkdir(outputPath, { recursive: true, mode: 0o700 });
const output = await realpath(outputPath); assert.ok(inside(privateRoot, output) && !inside(repo, output));
const session = JSON.parse(await readFile(sessionFile, 'utf8'));
const url = new URL(session.url);
assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/');
assert.match(url.hash, /^#session=[A-Za-z0-9_-]{43}$/);
const token = new URLSearchParams(url.hash.slice(1)).get('session');
const sha = value => createHash('sha256').update(value).digest('hex');
const api = async (action, payload = {}) => {
  const response = await fetch(new URL('/api', url), { method: 'POST', headers: { Origin: url.origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload }) });
  const body = await response.json(); assert.ok(response.ok && body.ok, `${action}: ${body.error?.code || response.status}`); return body;
};
const state = (await api('state')).state;
assert.ok(state.project); assert.equal(state.project.mainFile, path.basename(targetFile));
assert.equal((state.jobs || []).filter(job => ['running', 'queued', 'inProgress', 'cancelling'].includes(job.status)).length, 0, 'Wait for existing jobs before read-only acceptance.');
const content = s => sha(JSON.stringify({ project: s.project, originals: s.originals, originalSnapshotId: s.originalSnapshotId, segments: s.segments, readingParagraphs: s.readingParagraphs, translations: s.translations, reviewNotes: s.reviewNotes, reviewBatches: s.reviewBatches, proposals: s.proposals, transactions: s.transactions, builds: s.builds, versionPair: s.versionPair }));
const initial = content(state);
const sourceHashes = new Map();
for (const file of state.project.files) sourceHashes.set(file.path, sha(await readFile(path.join(path.dirname(targetFile), file.path))));
const formulaNotes = (state.reviewNotes || []).filter(item => ['suggestedSource', 'suggestedTranslation', 'reasonSource', 'reasonTranslation', 'body'].some(field => /\$|\\\(|\\\[|\[\[P\d|⟦P\d/u.test(item[field] || '')));
const note = formulaNotes.find(item => ['codex', 'ai', 'model'].includes(item.origin)) || formulaNotes[0];
assert.ok(note, 'A current opinion with formulas is required.');
const report = { schemaVersion: 1, actualPaper: true, readOnly: true, version: session.version, checks: [], pageErrors: [], forbiddenActions: [], screenshots: [] };
const check = (name, detail = {}) => { report.checks.push({ name, passed: true, ...detail }); console.log(`PASS ${name}`); };
const rendered = (await api('compileReviewNote', { noteId: note.noteId, expectedRevision: note.revision })).result;
assert.ok(rendered.pdf?.base64 && rendered.fragments?.length); assert.ok(['success', 'partial'].includes(rendered.status));
assert.equal(sha(Buffer.from(rendered.pdf.base64, 'base64')), rendered.pdf.hash);
check('actual opinion formulas compile through the installed read-only endpoint', { fragments: rendered.fragments.length, status: rendered.status, diagnostics: rendered.diagnostics.map(item => item.code) });
const repeated = (await api('compileReviewNote', { noteId: note.noteId, expectedRevision: note.revision })).result;
assert.equal(repeated.renderKey, rendered.renderKey); assert.equal(repeated.pdf.hash, rendered.pdf.hash);
check('identical note/context reuses the cached typeset PDF');
const external = formulaNotes.find(item => item.origin === 'external' && item.noteId !== note.noteId);
if (external) {
  const imported = (await api('compileReviewNote', { noteId: external.noteId, expectedRevision: external.revision })).result;
  assert.ok(imported.pdf?.base64 && imported.fragments?.length, 'The imported opinion must also produce readable mathematics.');
  check('imported and native opinions both support compiled reading', { externalFragments: imported.fragments.length, status: imported.status });
}
let browser;
try {
  const { chromium } = await loadPlaywright(); browser = await chromium.launch(browserOptions);
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  const forbidden = new Set(['chatSend', 'runRequest', 'reviewCycle', 'fullPaperReview', 'reviewParagraph', 'syncParagraph', 'compile', 'compileEnglish', 'apply', 'confirmApply', 'createUndoProposal']);
  page.on('request', request => { try { const action = request.postDataJSON()?.action; if (forbidden.has(action)) report.forbiddenActions.push(action); } catch {} });
  await page.goto(url.href); await page.locator('#annotation-filter').selectOption('all');
  const card = page.locator(`[data-note-id="${note.noteId}"]`); await card.scrollIntoViewIfNeeded();
  await card.locator('canvas.opinion-math-canvas').first().waitFor({ timeout: 120000 });
  assert.ok(await card.locator('canvas.opinion-math-canvas').count());
  assert.ok(!/\[\[P\d|⟦P\d/u.test(await card.innerText()), 'Internal protected-object IDs must stay hidden in reading mode.');
  check('installed reading view renders compiled math beside selectable prose');
  await card.locator('[data-opinion-view="source"]').click();
  assert.equal(await card.locator('canvas.opinion-math-canvas').count(), 0);
  assert.ok((await card.textContent()).length > 100);
  await card.locator('[data-opinion-view="reading"]').click(); await card.locator('canvas.opinion-math-canvas').first().waitFor();
  check('source and reading views switch without modifying the opinion');
  for (const theme of ['light', 'dark']) {
    await page.locator('#theme').selectOption(theme);
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#pdf-container canvas');
      if (!canvas?.width || !canvas?.height || !canvas.getAttribute('aria-label')?.startsWith('原文 PDF 第')) return false;
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0; for (let index = 0; index < pixels.length; index += 16) if (pixels[index] < 180 && pixels[index + 1] < 180 && pixels[index + 2] < 180 && ++ink > 50) return true;
      return false;
    }, null, { timeout: 45000 });
    await page.waitForFunction(id => document.querySelector(`[data-note-id="${id}"] canvas.opinion-math-canvas`), note.noteId);
    const geometry = await page.evaluate(() => { const middle = document.querySelector('#translation-panel').getBoundingClientRect(), notes = document.querySelector('#annotation-panel').getBoundingClientRect(); return { translationRight: middle.right, notesLeft: notes.left, overflow: document.documentElement.scrollWidth > innerWidth }; });
    assert.ok(geometry.notesLeft >= geometry.translationRight - 1); assert.equal(geometry.overflow, false);
    const filename = path.join(output, `opinion-reading-${theme}.png`); await page.screenshot({ path: filename, fullPage: true }); report.screenshots.push(filename);
  }
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.forbiddenActions, []);
  check('both themes preserve outward three-column geometry with no browser or model actions');
  assert.equal(content((await api('state')).state), initial);
  for (const [filename, expected] of sourceHashes) assert.equal(sha(await readFile(path.join(path.dirname(targetFile), filename))), expected);
  check('source files, drafts, raw notes and official build/version identities remain unchanged', { sourceFiles: sourceHashes.size, opinions: state.reviewNotes.length });
  report.passed = report.checks.length; report.success = true;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
} finally { await browser?.close(); }
