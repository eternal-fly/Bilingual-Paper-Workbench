import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaperApplication } from '../src/application.mjs';
import { normalizeModelNotes } from '../src/review-notes.mjs';
import { assertStrictOutputSchema } from './assert-strict-output-schema.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function syntheticChat({ holdTurns = false, beforeCompletion = null, notesFor = null } = {}) {
  const state = { connected: true, threadId: 'thread-synthetic-review-race', model: 'gpt-6-astra', effort: 'medium', busy: false, messages: [] };
  const inputs = new Map(), waiting = new Map(); let sequence = 0;
  const interrupt = async () => {
    state.busy = false;
    for (const [turnId, done] of waiting) done({ threadId: state.threadId, turnId, status: 'interrupted' });
    waiting.clear();
    return { interrupted: true };
  };
  return {
    on() {}, getState: () => structuredClone(state), connect: async () => {}, bindPaper: async () => {}, resumeChat: async () => structuredClone(state),
    sendMessage: async input => {
      assertStrictOutputSchema(input.outputSchema);
      if (state.busy) throw Object.assign(new Error('A synthetic reply is active.'), { code: 'CHAT_BUSY' });
      const turnId = `turn-race-${++sequence}`; inputs.set(turnId, input); state.busy = true;
      return { turnId, threadId: state.threadId };
    },
    waitForTurn: async turnId => {
      if (holdTurns) return new Promise(done => { waiting.set(turnId, done); });
      const input = inputs.get(turnId); await beforeCompletion?.({ input, turnId });
      const properties = input.outputSchema.properties;
      const data = properties.chunkIndex
        ? { reviewId: properties.reviewId.const, chunkIndex: properties.chunkIndex.const, chunkHash: properties.chunkHash.const }
        : { reviewId: properties.reviewId.const, notes: notesFor?.(input) || [] };
      state.messages.push({ role: 'assistant', turnId, text: JSON.stringify(data) }); state.busy = false;
      return { threadId: state.threadId, turnId, status: 'completed' };
    },
    interrupt, close: interrupt,
  };
}

async function applicationFixture(t, options = {}) {
  const owned = fileURLToPath(new URL('../work/full-review-race-tests/', import.meta.url)); await mkdir(owned, { recursive: true });
  const directory = await mkdtemp(path.join(owned, 'case-')), source = path.join(directory, 'source'); await mkdir(source);
  await writeFile(path.join(source, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\nA precise claim needs its assumptions.\n\n\\end{document}');
  const app = new PaperApplication({ dataRoot: path.join(directory, 'private'), chat: syntheticChat(options) });
  await app.openProject({ root: source, mainFile: 'main.tex' });
  t.after(async () => {
    await app.close();
    await Promise.allSettled([...app.jobs.values()].map(job => job.promise));
    await rm(directory, { recursive: true, force: true });
  });
  return app;
}

test('full review reserves the paper model job before its first connection await', async t => {
  const app = await applicationFixture(t, { holdTurns: true });
  const entered = deferred(), release = deferred();
  app._connectChat = async () => { entered.resolve(); await release.promise; };
  const first = app.fullPaperReview(); await entered.promise;
  const second = app.fullPaperReview(); second.catch(() => {});
  release.resolve();
  const [firstResult, secondResult] = await Promise.allSettled([first, second]);
  assert.equal(firstResult.status, 'fulfilled');
  assert.equal(secondResult.status, 'rejected', 'A second review must fail before it can create another batch or runtime job.');
  assert.equal(secondResult.reason.code, 'CHAT_BUSY');
  assert.equal(app.getState().reviewBatches.length, 1);
  assert.equal([...app.jobs.values()].filter(job => job.kind === 'codex').length, 1);
});

test('cancelling during the final source check prevents review publication', async t => {
  const app = await applicationFixture(t);
  const entered = deferred(), release = deferred(), original = app.core._assertSourceCurrent.bind(app.core); let checks = 0;
  app.core._assertSourceCurrent = async () => {
    await original();
    if (++checks === 2) { entered.resolve(); await release.promise; }
  };
  const queued = await app.fullPaperReview(); await entered.promise;
  try { assert.equal((await app.cancelJob({ jobId: queued.jobId })).status, 'cancelling'); }
  finally { release.resolve(); }
  await assert.rejects(app.waitJob({ jobId: queued.jobId }), { code: 'JOB_CANCELLED' });
  const state = app.getState(), batch = state.reviewBatches.find(item => item.batchId === queued.batchId);
  assert.equal(batch.status, 'cancelled');
  assert.equal(state.jobs.find(item => item.jobId === queued.jobId).status, 'cancelled');
  assert.equal((state.reviewNotes || []).length, 0);
});

test('untrusted explicit IDs cannot silently resolve a globally repeated quote', () => {
  const state = { project: { snapshotId: 'snap-synthetic-current' }, segments: [
    { id: 'seg-first', beforeHash: 'a'.repeat(64), source: 'Repeated sentence.' },
    { id: 'seg-second', beforeHash: 'b'.repeat(64), source: 'Repeated sentence.' },
  ] };
  const [note] = normalizeModelNotes([{ body: 'Clarify this sentence.', quote: 'Repeated sentence.', sourceSegmentIds: ['seg-first'] }], state, { batchId: 'review-synthetic-duplicates', origin: 'external' });
  assert.equal(note.anchorConfidence, 'ambiguous');
  assert.deepEqual(note.sourceSegmentIds, []);
  assert.deepEqual(note.candidates, ['seg-first', 'seg-second']);
});
test('a stopped controller leaves an interrupted review rather than a permanently running model job', async t => {
  const app = await applicationFixture(t);
  await app.core._serial(async () => { const state = app.core.getState(); state.reviewBatches = [{ batchId: 'review-stopped', status: 'reading', coverage: { completedChunks: 2, totalChunks: 8 } }]; await app.core._commit(state); });
  app.flow.jobs.push({ jobId: 'job-stopped', batchId: 'review-stopped', kind: 'fullReview', status: 'running', ownerPid: 2147483647 });
  const state = app.getState(); assert.equal(state.jobs.at(-1).status, 'interrupted'); assert.equal(state.reviewBatches.at(-1).status, 'interrupted');
  assert.equal(state.reviewBatches.at(-1).coverage.completedChunks, 2); assert.equal(state.jobs.at(-1).controllable, false);
});
test('selected paragraph review creates an opinion batch without claiming full-paper coverage or source edits', async t => {
  const app = await applicationFixture(t), paragraph = app.getState().readingParagraphs[0];
  const queued = await app.reviewParagraph({ sourceSegmentIds: [paragraph.id] });
  const result = await app.waitJob({ jobId: queued.jobId }); assert.equal(result.status, 'completed');
  const state = app.getState(), batch = state.reviewBatches.find(item => item.batchId === result.batchId);
  assert.equal(batch.scope, 'paragraph'); assert.deepEqual(batch.sourceSegmentIds, [paragraph.id]);
  assert.equal(state.jobs.find(item => item.jobId === queued.jobId).kind, 'paragraphReview');
  assert.equal(state.proposals.length, 0);
});

function selectedParagraphNote(input) {
  const payload = JSON.parse(input.text.split('\n\n').at(-1)), paragraph = payload.paragraphs[0];
  return [{ title: 'Check wording', body: 'Review the translation wording.', recommendation: 'Preserve the scope.', suggestedSource: 'Preserve the scope.', suggestedTranslation: 'Preserve the scope.', reasonSource: 'Review the translation wording.', reasonTranslation: 'Review the translation wording.', quote: paragraph.source, sourceSegmentIds: [paragraph.id], severity: 'low' }];
}

test('paragraph review reads every aligned translation unit and detects a second-half draft change', async t => {
  const entered = deferred(), release = deferred(); let sent;
  const app = await applicationFixture(t, { notesFor: selectedParagraphNote, beforeCompletion: async ({ input }) => { sent = JSON.parse(input.text.split('\n\n').at(-1)); entered.resolve(); await release.promise; } });
  const paragraph = app.getState().readingParagraphs[0], language = 'zh-CN';
  await app.saveDraft({ segmentId: paragraph.id, language, text: '第一段译文。第二段译文。', expectedRevision: 0 });
  await app.splitTranslation({ segmentId: paragraph.id, language, splitAt: 6, expectedRevision: 1 });
  const splitId = Object.keys(app.getState().translations[language]).find(id => app.getState().translations[language][id].unitKind === 'split');
  const queued = await app.reviewParagraph({ sourceSegmentIds: [paragraph.id], language }); await entered.promise;
  try {
    await app.saveDraft({ segmentId: splitId, language, text: '第二段已修改。', expectedRevision: 1 });
  } finally { release.resolve(); }
  await app.waitJob({ jobId: queued.jobId });
  assert.equal(sent.paragraphs[0].translationDraft, '第一段译文。\n\n第二段译文。');
  const state = app.getState(), note = state.reviewNotes.find(item => item.batchId === queued.batchId), batch = state.reviewBatches.find(item => item.batchId === queued.batchId);
  assert.equal(note.translationStale, true);
  assert.equal(note.sourceDraftRevisions[splitId], 1);
  assert.equal(batch.draftRevisions[splitId], 1);
  assert.deepEqual(batch.alignmentBindings[paragraph.id].translationUnitIds, [paragraph.id, splitId]);
});

test('paragraph review detects an alignment replacement even when translation revisions stay unchanged', async t => {
  const entered = deferred(), release = deferred();
  const app = await applicationFixture(t, { notesFor: selectedParagraphNote, beforeCompletion: async () => { entered.resolve(); await release.promise; } });
  const paragraph = app.getState().readingParagraphs[0], language = 'zh-CN';
  await app.saveDraft({ segmentId: paragraph.id, language, text: '已有译文。', expectedRevision: 0 });
  const selection = { language, sourceSegmentIds: [paragraph.id], translationUnitIds: [paragraph.id] };
  await app.setAlignment(selection);
  const before = app.getState().alignments[0], queued = await app.reviewParagraph({ sourceSegmentIds: [paragraph.id], language }); await entered.promise;
  try { await app.setAlignment({ ...selection, expectedRevisions: { [before.alignmentId]: before.revision } }); }
  finally { release.resolve(); }
  await app.waitJob({ jobId: queued.jobId });
  const state = app.getState(), note = state.reviewNotes.find(item => item.batchId === queued.batchId);
  assert.equal(state.translations[language][paragraph.id].revision, 1);
  assert.equal(note.sourceDraftRevisions[paragraph.id], 1);
  assert.equal(note.sourceAlignmentBindings[paragraph.id].alignmentId, before.alignmentId);
  assert.equal(note.sourceAlignmentBindings[paragraph.id].revision, before.revision);
  assert.notEqual(state.alignments[0].alignmentId, before.alignmentId);
  assert.equal(note.translationStale, true);
});
