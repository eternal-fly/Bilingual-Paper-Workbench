import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaperApplication } from '../src/application.mjs';
import { manuscriptChunks, normalizeFullReviewNotes } from '../src/full-review.mjs';
import { assertStrictOutputSchema } from './assert-strict-output-schema.mjs';

test('whole-source chunks cover every UTF8 byte including oversized multilingual paragraphs', () => {
  const bytes = Buffer.from('A🙂中文\\cite{x}\r\n'.repeat(6000));
  const result = manuscriptChunks([{ path: 'main.tex', bytes }], []);
  const pieces = result.chunks.filter(item => item.kind === 'source');
  assert.ok(pieces.length > 1); assert.deepEqual(Buffer.concat(pieces.map(item => Buffer.from(item.text))), bytes);
  assert.ok(result.chunks.every(item => Buffer.byteLength(JSON.stringify(item)) < 60000));
});
test('a model ID mistake is rechecked against exact original quotes rather than discarding the completed full review', () => {
  const state = { project: { snapshotId: 'snap-current' }, segments: [], translations: {}, readingParagraphs: [
    { id: 'read-one', path: 'main.tex', beforeHash: 'a'.repeat(64), source: 'The first distinct statement.' },
    { id: 'read-two', path: 'main.tex', beforeHash: 'b'.repeat(64), source: 'The second distinct statement.' }
  ] };
  const notes = normalizeFullReviewNotes([{ title: 'Check scope', body: 'Please state the scope.', quote: 'The second distinct statement.', sourceSegmentIds: ['read-one'] }], state, { batchId: 'review-test' });
  assert.deepEqual(notes[0].sourceSegmentIds, ['read-two']); assert.equal(notes[0].anchorConfidence, 'exactQuote');
  assert.deepEqual(notes[0].modelClaimedSourceSegmentIds, ['read-one']);
});
test('complete manuscript review stores source-pinned opinions after every chunk completes without source writes', async t => {
  const owned = fileURLToPath(new URL('../work/full-review-tests/', import.meta.url)); await mkdir(owned, { recursive: true });
  const dir = await mkdtemp(path.join(owned, 'case-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source'); await mkdir(source);
  const content = '\\documentclass{article}\n\\begin{document}\n\nA precise claim needs its assumptions.\n\nAnother paragraph.\n\n\\end{document}'; await writeFile(path.join(source, 'main.tex'), content);
  const chatState = { connected: true, threadId: 'thread-synthetic-review', model: 'gpt-6-astra', effort: 'medium', busy: false, messages: [] };
  let last, count = 0, segment;
  const chat = { on() {}, getState: () => structuredClone(chatState), connect: async () => {}, bindPaper: async () => {}, resumeChat: async () => chatState,
    sendMessage: async input => { assertStrictOutputSchema(input.outputSchema); count++; const turnId = `turn-${count}`; last = { input, turnId }; return { turnId, threadId: chatState.threadId }; },
    waitForTurn: async () => { const schema = last.input.outputSchema, props = schema.properties; let data;
      if (props.chunkIndex) data = { reviewId: props.reviewId.const, chunkIndex: props.chunkIndex.const, chunkHash: props.chunkHash.const };
      else data = { reviewId: props.reviewId.const, notes: [{ title: 'Clarify assumptions', body: 'Make the assumptions visible.', recommendation: 'Add their scope.', suggestedSource: 'Add their scope.', suggestedTranslation: 'Add their scope.', reasonSource: 'Make the assumptions visible.', reasonTranslation: 'Make the assumptions visible.', quote: segment.source, sourceSegmentIds: [segment.id], severity: 'medium' }] };
      chatState.messages.push({ role: 'assistant', turnId: last.turnId, text: JSON.stringify(data) }); return { threadId: chatState.threadId, turnId: last.turnId, status: 'completed' }; }, interrupt: async () => ({ interrupted: true }) };
  const app = new PaperApplication({ dataRoot: path.join(dir, 'private'), chat }); await app.openProject({ root: source, mainFile: 'main.tex' }); segment = app.getState().segments[0];
  const queued = await app.fullPaperReview({ instruction: 'Check the argument and exposition.' }); const result = await app.waitJob({ jobId: queued.jobId });
  assert.equal(result.status, 'completed'); assert.ok(count >= 3);
  const state = app.getState(), batch = state.reviewBatches.find(item => item.batchId === result.batchId);
  assert.equal(batch.coverage.completedChunks, batch.coverage.totalChunks); assert.equal(batch.status, 'completed');
  assert.equal(state.reviewNotes.length, 1); assert.deepEqual(state.reviewNotes[0].sourceSegmentIds, [segment.id]);
  assert.equal(state.proposals.length, 0); assert.equal(await readFile(path.join(source, 'main.tex'), 'utf8'), content);
});
