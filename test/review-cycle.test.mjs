import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaperApplication } from '../src/application.mjs';
import { projectReviewHistory } from '../src/review-history.mjs';
import { assertStrictOutputSchema } from './assert-strict-output-schema.mjs';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function syntheticChat({ hold = false, resultFor = null } = {}) {
  const gate = deferred(), entered = deferred(), inputs = [], state = { connected: true, threadId: 'thread-review-cycle-synthetic', model: 'gpt-6-astra', effort: 'medium', busy: false, messages: [] }; let interrupted = false;
  return { state, inputs, entered: entered.promise, release: gate.resolve, on() {}, getState: () => structuredClone(state), connect: async () => {}, bindPaper: async () => {}, resumeChat: async () => {},
    sendMessage: async () => { throw new Error('A cycle must use the one-turn review transport.'); },
    sendReviewMessage: async input => { assertStrictOutputSchema(input.outputSchema); if (state.busy) throw Object.assign(new Error('Busy'), { code: 'CHAT_BUSY' }); state.busy = true; inputs.push(input); return { threadId: state.threadId, turnId: `turn-${inputs.length}` }; },
    waitForTurn: async turnId => {
      const input = inputs[Number(turnId.split('-').at(-1)) - 1], payload = JSON.parse(input.text.split('\n\n').at(-1)); entered.resolve(); if (hold) await gate.promise;
      state.busy = false;
      if (interrupted) return { threadId: state.threadId, turnId, status: 'interrupted' };
      const result = resultFor ? resultFor(payload) : standardResult(payload);
      state.messages.push({ role: 'assistant', turnId, text: JSON.stringify(result) });
      return { threadId: state.threadId, turnId, status: 'completed' };
    },
    interrupt: async () => { interrupted = true; gate.resolve(); return { interrupted: true }; }, close: async () => { interrupted = true; gate.resolve(); },
  };
}
function standardResult(payload) {
  const first = payload.paragraphs[0];
  return { cycleId: payload.cycleId, answer: `Feedback in ${payload.targetLanguage}.`, notes: [{ title: 'Clarify scope', body: 'State the applicable assumptions.', recommendation: 'Explain the scope.', suggestedSource: 'Explain the scope.', suggestedTranslation: 'Explain the scope.', reasonSource: 'State the applicable assumptions.', reasonTranslation: 'State the applicable assumptions.', quote: first.text, sourceSegmentIds: [first.segmentId], severity: 'medium' }], translations: payload.translationMode === 'all' ? payload.paragraphs.filter(item => item.translationAllowed).map(item => ({ segmentId: item.segmentId, text: item.text.replace('A precise claim', 'Une affirmation précise') })) : [] };
}
async function fixture(t, options = {}) {
  const owned = fileURLToPath(new URL('../work/review-cycle-tests/', import.meta.url)); await mkdir(owned, { recursive: true });
  const directory = await mkdtemp(path.join(owned, 'case-')), source = path.join(directory, 'source'); await mkdir(source);
  const content = '\\documentclass{article}\n\\begin{document}\n\nA precise claim uses $x=1$.\n\nAnother distinct paragraph.\n\nA final distinct paragraph.\n\n\\end{document}', file = path.join(source, 'main.tex'); await writeFile(file, content);
  const chat = syntheticChat(options), app = new PaperApplication({ dataRoot: path.join(directory, 'private'), chat }); await app.openProject({ root: source, mainFile: 'main.tex' });
  const project = app.getState().project, metadata = { pairId: 'pair-synthetic-review-cycle', projectId: project.id, original: { hash: 'a'.repeat(64), snapshotId: 'snap-original', buildId: 'build-original' }, latest: { hash: 'b'.repeat(64), snapshotId: project.snapshotId, buildId: 'build-latest' } };
  app.versionPair = { read: async () => structuredClone(metadata) };
  const pairContext = { pairId: metadata.pairId, original: { hash: metadata.original.hash, pageCount: 2, pages: [{ page: 1, text: 'ORIGINAL-FIRST-PAGE' }, { page: 2, text: 'ORIGINAL-LAST-PAGE' }] }, latest: { hash: metadata.latest.hash, pageCount: 2, pages: [{ page: 1, text: 'LATEST-FIRST-PAGE' }, { page: 2, text: 'LATEST-LAST-PAGE' }] } };
  const [first, second] = app.getState().readingParagraphs;
  await app.core._serial(async () => { const state = app.core.getState(); state.reviewNotes = [
    { noteId: 'old-codex-first', batchId: 'seed-review', origin: 'codex', sourceSegmentIds: [first.id], body: 'Old first opinion.' },
    { noteId: 'old-codex-second', batchId: 'seed-review', origin: 'codex', sourceSegmentIds: [second.id], body: 'Old second opinion.' },
    { noteId: 'external-first', origin: 'external', sourceSegmentIds: [first.id], body: 'External review.' },
  ]; state.reviewBatches = [{ batchId: 'seed-review', origin: 'codex', scope: 'paper', status: 'completed', noteCount: 2, createdAt: '2020-01-01T00:00:00Z', completedAt: '2020-01-01T00:00:00Z' }]; await app.core._commit(state); });
  t.after(async () => { await app.close(); await Promise.allSettled([...app.jobs.values()].map(item => item.promise)); await rm(directory, { recursive: true, force: true }); });
  return { app, chat, pairContext, metadata, content, file, source };
}

test('an unopened paper has no cached review context and performs no model work', () => {
  const app = new PaperApplication({ dataRoot: fileURLToPath(new URL('../work/review-cycle-tests/unopened/', import.meta.url)) });
  assert.deepEqual(app.getState().reviewCycleContext, { available: false });
});

test('thirty-one complete review suggestions are retained without an artificial thirty-note output cap', async t => {
  const f=await fixture(t,{resultFor:payload=>{const base=standardResult(payload);return {...base,notes:Array.from({length:31},(_,i)=>({...base.notes[0],title:'Independent concern '+i}))};}});
  const queued=await f.app.reviewCycle({pairContext:f.pairContext,language:'fr'});await f.app.waitJob({jobId:queued.jobId});
  assert.equal(f.app.getState().reviewNotes.filter(note=>note.batchId===queued.cycleId).length,31);
  assert.equal(f.chat.inputs[0].outputSchema.properties.notes.maxItems,undefined);assert.equal(await readFile(f.file,'utf8'),f.content);
});

test('one author cycle sends every page once, updates latest opinions and target-language drafts without source writes', async t => {
  const { app, chat, pairContext, content, file, source } = await fixture(t);
  pairContext.latest.pages[1].text += ' Complete latest text.'.repeat(5000);
  const queued = await app.reviewCycle({ pairContext, language: 'fr', instruction: 'Please assess both versions and translate the selected text.' });
  const result = await app.waitJob({ jobId: queued.jobId });
  assert.equal(chat.inputs.length, 1); assert.ok(Buffer.byteLength(chat.inputs[0].text) > 64 * 1024);
  const payload = JSON.parse(chat.inputs[0].text.split('\n\n').at(-1));
  assert.deepEqual(payload.pair, pairContext); assert.equal(payload.targetLanguage, 'fr'); assert.match(chat.inputs[0].text, /targetLanguage \(fr\)/u);
  assert.equal(chat.inputs[0].displayText, 'Please assess both versions and translate the selected text.');
  assert.equal(chat.inputs[0].reviewMetadata.cycleId, queued.cycleId);
  const state = app.getState(); assert.equal(result.translationsApplied, 3); assert.equal(state.proposals.length, 0); assert.equal(state.transactions.length, 0);
  assert.deepEqual(state.reviewNotes.filter(item => item.origin === 'external').map(item => item.noteId), ['external-first']);
  assert.equal(state.reviewNotes.filter(item => item.origin === 'codex').length, 1);
  assert.deepEqual(state.reviewHistory.map(item => item.noteId).sort(), ['old-codex-first', 'old-codex-second']);
  assert.equal(state.reviewBatches.at(-1).reviewedSourceSegmentIds.length, 3);
  assert.ok(state.translations.fr[state.readingParagraphs[0].id].text.includes('$x=1$'));
  assert.equal(state.jobs.find(item => item.jobId === queued.jobId).scope, 'all');
  assert.equal(state.reviewBatches.at(-1).coverage.completedTurns, 1); assert.equal(state.reviewBatches.at(-1).coverage.completePdfTextsDelivered, true);
  assert.equal(await readFile(file, 'utf8'), content); assert.deepEqual(await readdir(source), ['main.tex']);
});

test('selected review replaces only selected Codex opinions and preserves the other paragraph and external review', async t => {
  const { app, pairContext } = await fixture(t), second = app.getState().readingParagraphs[1];
  const queued = await app.reviewCycle({ pairContext, sourceSegmentIds: [second.id], includeTranslations: false }); await app.waitJob({ jobId: queued.jobId });
  const state = app.getState(); assert.ok(state.reviewNotes.some(item => item.noteId === 'old-codex-first')); assert.ok(!state.reviewNotes.some(item => item.noteId === 'old-codex-second')); assert.ok(state.reviewNotes.some(item => item.noteId === 'external-first'));
  assert.equal(state.jobs.at(-1).scope, 'selected'); assert.equal(state.requests.length, 0);
});

test('selected cycle replaces note anchors without treating a previous whole-paper context as every note’s anchor', async t => {
  const { app, pairContext } = await fixture(t), paragraphs = app.getState().readingParagraphs, ids = paragraphs.map(item => item.id), selected = paragraphs[1];
  await app.core._serial(async () => {
    const state = app.core.getState();
    for (const note of state.reviewNotes) if (note.origin === 'codex') note.reviewScopeIds = [...ids];
    state.reviewNotes.push(
      { noteId: 'old-codex-third', batchId: 'seed-review', origin: 'codex', sourceSegmentIds: [ids[2]], reviewScopeIds: [...ids], body: 'Old third opinion.' },
      { noteId: 'global-unanchored', origin: 'codex', sourceSegmentIds: [], reviewScopeIds: [...ids], body: 'Global advice retained during local refresh.' },
      { noteId: 'local-unanchored', origin: 'model', sourceSegmentIds: [], reviewScopeIds: [selected.id], body: 'Old local advice.' },
      { noteId: 'unknown-scope', origin: 'ai', sourceSegmentIds: [], body: 'Unknown scope retained.' }
    ); await app.core._commit(state);
  });
  const before = structuredClone(app.getState().reviewNotes), queued = await app.reviewCycle({ pairContext, sourceSegmentIds: [selected.id], includeTranslations: false }); await app.waitJob({ jobId: queued.jobId });
  const notes = app.getState().reviewNotes;
  for (const id of ['old-codex-first', 'old-codex-third', 'external-first', 'global-unanchored', 'local-unanchored', 'unknown-scope']) assert.deepEqual(notes.find(note => note.noteId === id), before.find(note => note.noteId === id));
  assert.ok(!notes.some(note => note.noteId === 'old-codex-second')); assert.ok(app.getState().reviewHistory.some(note => note.noteId === 'old-codex-second'));
  assert.equal(notes.filter(note => note.reviewCycleId === queued.cycleId).length, 1); assert.equal(notes.length, before.length);
});

test('the first English/Chinese baseline and current Chinese draft stay distinct in the same cycle prompt', async t => {
  const { app, chat, pairContext } = await fixture(t), first = app.getState().readingParagraphs[0];
  await app.core._serial(async () => { const next = app.core.getState(); next.originals[first.id].translation = '首次上传时保留的中文基线。'; await app.core._commit(next); });
  const baseline = structuredClone(app.getState().originals[first.id]);
  await app.saveDraft({ segmentId: first.id, language: 'zh-CN', text: '评阅前作者修改的最新中文意图。', expectedRevision: 0 });
  const queued = await app.reviewCycle({ pairContext }); await app.waitJob({ jobId: queued.jobId });
  const payload = JSON.parse(chat.inputs[0].text.split('\n\n').at(-1)), paragraph = payload.paragraphs.find(item => item.segmentId === first.id);
  assert.equal(paragraph.initialOriginal, baseline.source); assert.equal(paragraph.initialSourceHash, baseline.sourceHash);
  assert.equal(paragraph.initialTranslation, '首次上传时保留的中文基线。');
  assert.equal(paragraph.translationDrafts['zh-CN'], '评阅前作者修改的最新中文意图。');
  assert.deepEqual(app.getState().originals[first.id], baseline);
});

test('free conversation uses the cached pair, returns one readable answer and preserves opinion cards for ordinary discussion', async t => {
  const { app, chat, pairContext } = await fixture(t, { resultFor: payload => ({ cycleId: payload.cycleId, answer: 'Hello. What would you like to discuss?', notes: [], translations: [] }) });
  await app.cacheVersionPairContext({ pairContext }); assert.equal(chat.inputs.length, 0);
  const before = structuredClone(app.getState().reviewNotes), instruction = 'Hello — I want to discuss this paper.';
  const queued = await app.reviewCycle({ conversation: true, instruction }); const result = await app.waitJob({ jobId: queued.jobId });
  assert.equal(result.answer, 'Hello. What would you like to discuss?'); assert.equal(chat.inputs.length, 1); assert.equal(chat.inputs[0].displayText, instruction);
  assert.deepEqual(app.getState().reviewNotes, before); assert.equal(app.getState().jobs.at(-1).conversation, true);
  assert.ok(!JSON.stringify(app.getState().reviewCycleContext).includes('ORIGINAL-FIRST-PAGE'));
});

test('conversation feedback replaces only its returned exact anchors', async t => {
  const { app, pairContext } = await fixture(t);
  const queued = await app.reviewCycle({ pairContext, conversation: true, instruction: 'Review the first paragraph only.' }); await app.waitJob({ jobId: queued.jobId });
  assert.ok(!app.getState().reviewNotes.some(item => item.noteId === 'old-codex-first')); assert.ok(app.getState().reviewNotes.some(item => item.noteId === 'old-codex-second'));
  assert.equal(app.getState().reviewBatches.at(-1).translationsApplied, 0);
});

test('ordinary conversation does not supersede a previously registered translation selection', async t => {
  const { app, pairContext } = await fixture(t, { resultFor: payload => ({ cycleId: payload.cycleId, answer: 'Hello.', notes: [], translations: [] }) }), first = app.getState().readingParagraphs[0];
  const previous = await app.createRequest({ segmentIds: [first.id], kind: 'translation', language: 'zh-CN' });
  const queued = await app.reviewCycle({ pairContext, conversation: true, instruction: 'Hello.' }); await app.waitJob({ jobId: queued.jobId });
  const result = await app.submitTranslationResult({ requestId: previous.requestId, translations: [{ segmentId: first.id, text: previous.segments[0].text }] });
  assert.equal(result.status, 'completed');
});

test('invalid protected translation rejects the entire staged result without partial opinion or draft publication', async t => {
  const { app, pairContext } = await fixture(t, { resultFor: payload => { const result = standardResult(payload); result.translations[0].text = 'A replacement without its formula.'; return result; } });
  const before = app.getState(), queued = await app.reviewCycle({ pairContext });
  await assert.rejects(app.waitJob({ jobId: queued.jobId }), { code: 'PROTECTED_TOKEN_CHANGED' });
  assert.deepEqual(app.getState().reviewNotes, before.reviewNotes); assert.deepEqual(app.getState().translations, before.translations);
});

test('a human draft edit while the single model turn runs preserves previous opinions and the human draft', async t => {
  const { app, chat, pairContext } = await fixture(t, { hold: true }), first = app.getState().readingParagraphs[0], before = structuredClone(app.getState().reviewNotes);
  const queued = await app.reviewCycle({ pairContext, language: 'fr' }); await chat.entered;
  await app.saveDraft({ segmentId: first.id, language: 'zh-CN', text: '新的人工作者意图。', expectedRevision: 0 }); chat.release();
  await assert.rejects(app.waitJob({ jobId: queued.jobId }), { code: 'RESULT_STALE' });
  assert.deepEqual(app.getState().reviewNotes, before); assert.equal(app.getState().translations['zh-CN'][first.id].text, '新的人工作者意图。'); assert.equal(app.getState().translations.fr, undefined);
});

test('cancelling during final source validation prevents publication of any part of a completed model reply', async t => {
  const { app, pairContext } = await fixture(t), original = app.core._assertSourceCurrent.bind(app.core), entered = deferred(), release = deferred(); let checks = 0;
  app.core._assertSourceCurrent = async () => { await original(); if (++checks === 2) { entered.resolve(); await release.promise; } };
  const before = app.getState(), queued = await app.reviewCycle({ pairContext }); await entered.promise;
  try { assert.equal((await app.cancelJob({ jobId: queued.jobId })).status, 'cancelling'); } finally { release.resolve(); }
  await assert.rejects(app.waitJob({ jobId: queued.jobId }), { code: 'JOB_CANCELLED' });
  assert.deepEqual(app.getState().reviewNotes, before.reviewNotes); assert.deepEqual(app.getState().translations, before.translations); assert.equal(app.getState().jobs.at(-1).status, 'cancelled');
});

test('a changed PDF pair or an incomplete/oversized PDF context never publishes a partial cycle', async t => {
  const { app, chat, pairContext, metadata } = await fixture(t, { hold: true }), before = structuredClone(app.getState().reviewNotes);
  await assert.rejects(app.reviewCycle({ pairContext: { ...pairContext, original: { ...pairContext.original, pageCount: 3 } } }), { code: 'INVALID_VERSION_PAIR' });
  await assert.rejects(app.reviewCycle({ pairContext: { ...pairContext, original: { ...pairContext.original, pages: [{ page: 1, text: 'x'.repeat(2 * 1024 * 1024) }, { page: 2, text: 'end' }] } } }), { code: 'REVIEW_TOO_LARGE' });
  assert.equal(chat.inputs.length, 0); assert.equal(app.getState().requests.length, 0);
  const queued = await app.reviewCycle({ pairContext }); await chat.entered; metadata.latest.hash = 'c'.repeat(64); chat.release();
  await assert.rejects(app.waitJob({ jobId: queued.jobId }), { code: 'VERSION_CONFLICT' }); assert.deepEqual(app.getState().reviewNotes, before);
});

test('nonidentity translation mappings stay historical and model tools cannot publish an internal cycle request', async t => {
  const { app, chat, pairContext } = await fixture(t, { hold: true }), [first, second] = app.getState().readingParagraphs, language = 'zh-CN';
  await app.saveDraft({ segmentId: first.id, language, text: '完整合并译文。', expectedRevision: 0 });
  await app.setAlignment({ language, sourceSegmentIds: [first.id, second.id], translationUnitIds: [first.id] });
  const queued = await app.reviewCycle({ pairContext }); await chat.entered;
  await assert.rejects(app.handlePaperTool('paper_compile', { proposalIds: [] }, { threadId: chat.state.threadId, turnId: app._activeChatScope.turnId }), { code: 'PERMISSION_DENIED' });
  await assert.rejects(app.submitTranslationResult({ requestId: app.getState().requests.at(-1).requestId, translations: [] }), { code: 'PERMISSION_DENIED' });
  chat.release(); const result = await app.waitJob({ jobId: queued.jobId });
  assert.equal(result.translationsHistorical, 2); assert.equal(result.translationsApplied, 1); assert.equal(app.getState().translations[language][first.id].text, '完整合并译文。');
  assert.equal(app.getState().requests.at(-1).historicalResult.length, 2);
});

test('out-of-scope opinion IDs fail atomically instead of widening the selected review', async t => {
  let outside;
  const { app, pairContext } = await fixture(t, { resultFor: payload => { const result = standardResult(payload); result.notes[0].sourceSegmentIds = [outside]; return result; } });
  const [first, second] = app.getState().readingParagraphs; outside = second.id; const before = app.getState().reviewNotes;
  const queued = await app.reviewCycle({ pairContext, sourceSegmentIds: [first.id], includeTranslations: false }); await assert.rejects(app.waitJob({ jobId: queued.jobId }), { code: 'INVALID_REVIEW_ANCHOR' });
  assert.deepEqual(app.getState().reviewNotes, before);
});

test('zero-finding explicit review archives older Codex opinions under an empty current head without changing translations', async t => {
  const { app, pairContext } = await fixture(t, { resultFor: payload => ({ cycleId: payload.cycleId, answer: 'No current findings.', notes: [], translations: [] }) });
  const before = structuredClone(app.getState().translations), queued = await app.reviewCycle({ pairContext, includeTranslations: false }); await app.waitJob({ jobId: queued.jobId });
  assert.deepEqual(app.getState().reviewNotes.map(item => item.noteId), ['external-first']); assert.deepEqual(app.getState().reviewHistory.map(item => item.noteId).sort(), ['old-codex-first', 'old-codex-second']); assert.deepEqual(projectReviewHistory(app.getState(), { sourceIds: app.getState().readingParagraphs.map(item => item.id) }).currentIds, ['external-first']); assert.deepEqual(app.getState().translations, before);
});

test('one-turn startup reservation rejects concurrent review or ordinary chat before creating duplicate work', async t => {
  const { app, pairContext } = await fixture(t), entered = deferred(), release = deferred();
  app._connectChat = async () => { entered.resolve(); await release.promise; };
  const first = app.reviewCycle({ pairContext, includeTranslations: false }); await entered.promise;
  await assert.rejects(app.reviewCycle({ pairContext }), { code: 'CHAT_BUSY' });
  await assert.rejects(app.fullPaperReview(), { code: 'CHAT_BUSY' });
  await assert.rejects(app.chatSend({ text: 'A separate message.' }), { code: 'CHAT_BUSY' });
  release.resolve(); const queued = await first; await app.waitJob({ jobId: queued.jobId }); assert.equal(app.getState().reviewBatches.filter(batch => batch.batchId === queued.batchId).length, 1);
});

test('latest-only review sends only latest PDF pages and uses effective language preferences', async t => {
  const { app, chat, pairContext } = await fixture(t);
  await app.configureLanguages({ expectedRevision: 0, uiLanguage: 'fr', translationLanguage: 'interface' });
  await app.selectPdfReviewTarget({ target: 'latest' });
  const queued = await app.reviewCycle({ pairContext }); const result = await app.waitJob({ jobId: queued.jobId });
  const payload = JSON.parse(chat.inputs[0].text.split('\n\n').at(-1));
  assert.equal(payload.pair, undefined); assert.equal(payload.reviewTarget, 'latest'); assert.equal(payload.targetLanguage, 'fr');
  assert.deepEqual(payload.pdfs.map(item => item.role), ['latest']); assert.deepEqual(payload.pdfs[0].pages, pairContext.latest.pages);
  assert.ok(!chat.inputs[0].text.includes('ORIGINAL-FIRST-PAGE')); assert.equal(result.translationsApplied, 3);
  const coverage = app.getState().reviewBatches.at(-1).coverage;
  assert.equal(coverage.originalPages, 0); assert.equal(coverage.latestPages, 2); assert.equal(coverage.completePdfTextsDelivered, true);
});

test('original-only review remains opinions-only even when translations were requested', async t => {
  const { app, chat, pairContext } = await fixture(t), before = app.getState().translations;
  const queued = await app.reviewCycle({ pairContext, reviewTarget: 'original', includeTranslations: true }); await app.waitJob({ jobId: queued.jobId });
  const payload = JSON.parse(chat.inputs[0].text.split('\n\n').at(-1));
  assert.equal(payload.pair, undefined); assert.deepEqual(payload.pdfs.map(item => item.role), ['original']); assert.ok(!chat.inputs[0].text.includes('LATEST-FIRST-PAGE'));
  assert.equal(payload.translationMode, 'none'); assert.ok(payload.paragraphs.every(item => item.translationAllowed === false));
  assert.equal(app.getState().requests.length, 0); assert.deepEqual(app.getState().translations, before);
  assert.equal(app.getState().reviewBatches.at(-1).coverage.latestPages, 0);
});

async function candidateView(app) {
  const state = app.core.getState();
  const build = { buildId: 'build-current-candidate', status: 'success', isolation: { verified: true }, snapshotId: state.project.snapshotId, kind: 'candidate' };
  await app._flowAction(() => { app.flow.builds.push(build); });
  app.readPdf = async ({ buildId }) => ({ buildId, hash: buildId === build.buildId ? 'c'.repeat(64) : 'd'.repeat(64) });
  await app.recordPdfView({ role: 'candidate', buildId: build.buildId, pdfHash: 'c'.repeat(64) });
  return { buildId: build.buildId, hash: 'c'.repeat(64), pageCount: 1, pages: [{ page: 1, text: 'ONLY-ACTIVE-CANDIDATE-PDF-PAGE' }] };
}

test('current candidate review binds its acknowledged build and permits only opinions', async t => {
  const { app, chat, pairContext } = await fixture(t), activePdfContext = await candidateView(app);
  await app.selectPdfReviewTarget({ target: 'current' });
  const before = app.getState().translations, queued = await app.reviewCycle({ pairContext, activePdfContext }); await app.waitJob({ jobId: queued.jobId });
  const payload = JSON.parse(chat.inputs[0].text.split('\n\n').at(-1));
  assert.equal(payload.reviewTarget, 'current'); assert.equal(payload.pair, undefined); assert.deepEqual(payload.pdfs.map(item => item.role), ['candidate']);
  assert.equal(payload.pdfs[0].buildId, activePdfContext.buildId); assert.ok(chat.inputs[0].text.includes('ONLY-ACTIVE-CANDIDATE-PDF-PAGE'));
  assert.ok(!chat.inputs[0].text.includes('ORIGINAL-FIRST-PAGE')); assert.ok(!chat.inputs[0].text.includes('LATEST-FIRST-PAGE'));
  assert.equal(payload.translationMode, 'none'); assert.equal(app.getState().reviewBatches.at(-1).coverage.candidatePages, 1); assert.deepEqual(app.getState().translations, before);
});

test('a changed current PDF acknowledgement or language preference rejects late cycle results atomically', async t => {
  for (const change of ['pdf', 'language']) await t.test(change, async subtest => {
    const { app, chat, pairContext, metadata } = await fixture(subtest, { hold: true }), activePdfContext = await candidateView(app);
    await app.selectPdfReviewTarget({ target: 'current' });
    const before = app.getState(), queued = await app.reviewCycle({ pairContext, activePdfContext }); await chat.entered;
    if (change === 'pdf') await app.recordPdfView({ role: 'latest', buildId: metadata.latest.buildId, pdfHash: metadata.latest.hash });
    else await app.configureLanguages({ expectedRevision: 0, translationLanguage: 'fr' });
    chat.release(); await assert.rejects(app.waitJob({ jobId: queued.jobId }), { code: 'RESULT_STALE' });
    assert.deepEqual(app.getState().reviewNotes, before.reviewNotes); assert.deepEqual(app.getState().translations, before.translations);
  });
});

test('a model cannot return translation entries for an original PDF review target', async t => {
  const { app, pairContext } = await fixture(t, { resultFor: payload => ({ ...standardResult(payload), translations: [{ segmentId: payload.paragraphs[0].segmentId, text: payload.paragraphs[0].text }] }) }), before = app.getState();
  const queued = await app.reviewCycle({ pairContext, reviewTarget: 'original' }); await assert.rejects(app.waitJob({ jobId: queued.jobId }), { code: 'REQUEST_NOT_APPROVED' });
  assert.deepEqual(app.getState().translations, before.translations); assert.deepEqual(app.getState().reviewNotes, before.reviewNotes);
});
