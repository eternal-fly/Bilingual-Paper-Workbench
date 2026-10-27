import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeFullReviewNotes, reviewNoteSchema } from '../src/full-review.mjs';
import { normalizeModelNotes, normalizeExternalReviews, enrichReviewNotePresentation } from '../src/review-notes.mjs';
import { PARAGRAPH_RECOMMENDATION_INSTRUCTION } from '../src/recommendation-format.mjs';
import { PaperApplication } from '../src/application.mjs';
import { createParagraphComparison } from '../src/paragraph-comparison.mjs';
import { assertStrictOutputSchema } from './assert-strict-output-schema.mjs';

const digest = 'a'.repeat(64);
function state() { return { project: { id: 'p', snapshotId: 'snap-current', targetLanguage: 'zh-CN' }, segments: [], readingParagraphs: [{ id: 'p1', sourceHash: digest, source: 'Setup. Old claim. End.', displayText: 'Setup. Old claim. End.' }], translations: { 'zh-CN': { p1: { text: '设置。原结论。结尾。', status: 'saved', sourceHash: digest } } } }; }
const quartet = { reviewCode: 'A01', suggestedSource: 'Setup. New claim. End.', suggestedTranslation: '设置。新结论。结尾。', reasonSource: 'Clarify the claim.', reasonTranslation: '澄清结论。', quote: 'Old claim.', sourceSegmentIds: ['p1'] };
const options = { batchId: 'review-paragraph-context', origin: 'codex' };
test('strict API opinion contracts require nullable current fields while historical input remains compatible', () => {
  assertStrictOutputSchema(reviewNoteSchema);
  for (const field of ['currentSource', 'currentTranslation', 'scope']) assert.ok(reviewNoteSchema.properties[field]);
  for (const field of ['reviewCode', 'scope', 'currentSource', 'currentTranslation']) { assert.ok(reviewNoteSchema.required.includes(field)); assert.deepEqual(reviewNoteSchema.properties[field].type, ['string', 'null']); }
  assert.ok(reviewNoteSchema.properties.scope.enum.includes(null)); assert.ok(PARAGRAPH_RECOMMENDATION_INSTRUCTION.includes('complete recommended paragraph')); assert.ok(PARAGRAPH_RECOMMENDATION_INSTRUCTION.includes('retaining all unchanged sentences'));
  assert.equal(normalizeModelNotes([{ body: 'Legacy opinion.' }], state(), options)[0].body, 'Legacy opinion.');
});

test('API null optionals are removed only at the full-review boundary without mutating payloads or relaxing imports', () => {
  const fields = ['reviewCode', 'scope', 'currentSource', 'currentTranslation'];
  const input = { ...quartet, ...Object.fromEntries(fields.map(field => [field, null])) }, before = structuredClone(input);
  const [note] = normalizeFullReviewNotes([input], state(), { ...options, attachCurrentContext: false });
  for (const field of fields) assert.equal(Object.hasOwn(note, field), false);
  assert.equal(note.suggestedSource, quartet.suggestedSource); assert.deepEqual(input, before);
  for (const field of fields) {
    assert.throws(() => normalizeModelNotes([{ ...quartet, [field]: null }], state(), options), { code: 'INVALID_REVIEW' });
    assert.throws(() => normalizeExternalReviews({ filename: 'strict.json', format: 'json', fileHash: digest, text: JSON.stringify([{ ...quartet, [field]: null }]) }, state()), { code: 'INVALID_REVIEW' });
  }
  for (const field of ['title', 'body', 'suggestedSource', 'reasonTranslation', 'unknown']) assert.throws(() => normalizeFullReviewNotes([{ ...quartet, [field]: null }], state(), options), { code: 'INVALID_REVIEW' });
});
test('current bilingual paragraph context is copied from exact server evidence, not model rewritten baseline', () => {
  const before = state(), original = structuredClone(before);
  const [note] = normalizeFullReviewNotes([{ ...quartet, scope: 'paragraph', currentSource: 'Invented baseline.', currentTranslation: '模型改写的旧译文。' }], before, options);
  assert.equal(note.currentSource, 'Setup. Old claim. End.'); assert.equal(note.currentTranslation, '设置。原结论。结尾。'); assert.equal(note.currentContextProvenance, 'server-captured'); assert.equal(note.currentContextConflict, true); assert.equal(note.scope, 'paragraph'); assert.deepEqual(before, original);
  const [omitted] = normalizeFullReviewNotes([{ ...quartet, scope: 'paragraph' }], state(), options); assert.equal(omitted.currentSource, note.currentSource); assert.equal(omitted.currentTranslation, note.currentTranslation); assert.equal(omitted.currentContextConflict, undefined);
});
test('captured review drafts remain the baseline when later current drafts differ', () => {
  const captured = state(), current = state(); current.translations['zh-CN'].p1.text = '后来才修改的译文。';
  const [note] = normalizeFullReviewNotes([{ ...quartet, scope: 'paragraph' }], current, { ...options, currentContextState: captured, language: 'zh-CN' });
  assert.equal(note.currentTranslation, '设置。原结论。结尾。'); assert.equal(current.translations['zh-CN'].p1.text, '后来才修改的译文。');
});
test('server CURRENT binding uses only active language- and snapshot-current explicit alignment', () => {
  const value = state(); value.translations['zh-CN'].currentUnit = { text: '当前明确绑定的译文。', status: 'saved' }; value.translations['zh-CN'].oldUnit = { text: '旧对齐译文。', status: 'saved' };
  value.alignments = [
    { language: 'zh-CN', sourceSegmentIds: ['p1'], translationUnitIds: ['oldUnit'], stale: true, snapshotId: 'snap-current' },
    { language: 'zh-CN', sourceSegmentIds: ['p1'], translationUnitIds: ['oldUnit'], status: 'stale', snapshotId: 'snap-current' },
    { language: 'zh-CN', sourceSegmentIds: ['p1'], translationUnitIds: ['oldUnit'], snapshotId: 'snap-old' },
    { language: 'fr', sourceSegmentIds: ['p1'], translationUnitIds: ['oldUnit'], snapshotId: 'snap-current' },
    { language: 'zh-CN', sourceSegmentIds: ['p1'], translationUnitIds: ['currentUnit'], snapshotId: 'snap-current' },
  ];
  const [note] = normalizeFullReviewNotes([{ ...quartet, scope: 'paragraph' }], value, options); assert.equal(note.currentTranslation, '当前明确绑定的译文。'); assert.equal(note.currentContextProvenance, 'server-captured');
});
test('stale, noncurrent or unbound manual mappings never fall back to the old source-ID draft', () => {
  for (const alignment of [
    { language: 'zh-CN', sourceSegmentIds: ['p1'], translationUnitIds: ['oldUnit'], stale: true },
    { language: 'zh-CN', sourceSegmentIds: ['p1'], translationUnitIds: ['oldUnit'], status: 'stale' },
    { language: 'zh-CN', sourceSegmentIds: ['p1'], translationUnitIds: ['oldUnit'], snapshotId: 'snap-old' },
    { language: 'zh-CN', sourceSegmentIds: ['anotherSource'], translationUnitIds: ['anotherUnit'], snapshotId: 'snap-current' },
  ]) {
    const value = state(); value.alignments = [alignment]; const [note] = normalizeFullReviewNotes([{ ...quartet, scope: 'paragraph' }], value, options);
    assert.equal(note.currentTranslation, undefined); assert.equal(note.scope, 'note'); assert.equal(note.currentContextProvenance, 'target-context-unavailable');
  }
});
test('an explicitly stale target draft never falls back to historical paragraph or original translations for CURRENT', () => {
  const value = state(); value.translations['zh-CN'].p1.status = 'stale'; value.readingParagraphs[0].translation = '历史段落译文。'; value.originals = { p1: { translation: '最初上传的译文。' } };
  const [note] = normalizeFullReviewNotes([{ ...quartet, scope: 'paragraph', currentSource: 'Setup. Old claim. End.', currentTranslation: '模型提供的当前译文。' }], value, options);
  assert.equal(note.currentSource, undefined); assert.equal(note.currentTranslation, undefined); assert.equal(note.scope, 'note'); assert.equal(note.currentContextProvenance, 'target-context-unavailable'); assert.equal(note.suggestedTranslation, quartet.suggestedTranslation); assert.equal(value.originals.p1.translation, '最初上传的译文。');
});
test('unavailable target context strips a model-provided CURRENT pair even without an explicit paragraph scope', () => {
  const value = state(); value.translations = {};
  const [note] = normalizeFullReviewNotes([{ ...quartet, currentSource: 'Model baseline.', currentTranslation: '模型声称的当前译文。' }], value, options);
  assert.equal(note.currentSource, undefined); assert.equal(note.currentTranslation, undefined); assert.equal(note.scope, 'note'); assert.equal(note.currentContextConflict, true); assert.equal(note.currentContextProvenance, 'target-context-unavailable');
  const comparison = createParagraphComparison({ note }); assert.equal(comparison.scope, 'note'); assert.equal(comparison.translation.current.text, ''); assert.equal(comparison.translation.recommended.text, quartet.suggestedTranslation);
});
test('unlocated and missing-target contexts do not manufacture authoritative whole paragraphs', () => {
  const [global] = normalizeFullReviewNotes([{ ...quartet, quote: 'Unknown claim.', sourceSegmentIds: [], scope: 'paragraph', currentSource: 'Provided context.', currentTranslation: '给定上下文。' }], state(), options); assert.equal(global.scope, 'note'); assert.deepEqual(global.sourceSegmentIds, []);
  const unavailable = state(); unavailable.translations = {};
  const [note] = normalizeFullReviewNotes([{ ...quartet, scope: 'paragraph' }], unavailable, options); assert.equal(note.scope, 'note'); assert.equal(note.currentTranslation, undefined); assert.equal(note.currentContextProvenance, 'target-context-unavailable');
  for (const currentSource of [[], {}]) assert.throws(() => normalizeFullReviewNotes([{ ...quartet, scope: 'paragraph', currentSource, currentTranslation: '译文。' }], state(), options), { code: 'INVALID_REVIEW' });
});
test('current field pairs and paragraph scope remain typed and bounded during normalization', () => {
  for (const change of [{ currentSource: 'Only one field.' }, { currentSource: '', currentTranslation: '译文。' }, { scope: 'whole-file' }, { scope: 'paragraph' }, { currentSource: 'x'.repeat(16 * 1024 + 1), currentTranslation: '译文。' }]) assert.throws(() => normalizeModelNotes([{ ...quartet, ...change }], state(), options), { code: 'INVALID_REVIEW' });
});
const structured = 'Full bilingual manuscript with proposed revisions\n1 项建议\n原稿 / CURRENT\nEN Setup. Old claim. End.\n中 设置。原结论。结尾。\n[A01] 建议改写 / RECOMMENDED (pending)\nEN Setup. New claim. End.\n中 设置。新结论。结尾。\n修改理由 / REASON\nEN Clarify the claim.\n中 澄清结论。\n你的决定 / Decision: □ 采用 / Adopt □ 再改 / Revise □ 保留 / Keep';
const upload = { filename: 'synthetic-review.pdf', format: 'pdf', fileHash: digest, text: structured };
test('external structured CURRENT blocks survive import as readonly context and enrich exact old notes without changing identity or decisions', () => {
  const imported = normalizeExternalReviews(upload, state()), parsed = imported.notes[0]; assert.equal(parsed.currentSource, 'Setup. Old claim. End.'); assert.equal(parsed.currentTranslation, '设置。原结论。结尾。'); assert.equal(parsed.scope, 'paragraph'); assert.equal(parsed.currentContextProvenance, 'external-review-context');
  const old = { ...parsed, noteId: 'preserved-note-id', revision: 4, decision: 'keep', status: 'resolved' }; delete old.currentSource; delete old.currentTranslation; delete old.scope;
  const before = structuredClone(old), enriched = enrichReviewNotePresentation([old], imported.notes); assert.deepEqual(enriched.updatedIds, [old.noteId]); assert.equal(enriched.notes[0].revision, 5); assert.equal(enriched.notes[0].decision, 'keep'); assert.equal(enriched.notes[0].status, 'resolved'); assert.equal(enriched.notes[0].noteId, old.noteId); assert.deepEqual(old, before);
  assert.deepEqual(enrichReviewNotePresentation(enriched.notes, imported.notes).updatedIds, []);
  assert.deepEqual(enrichReviewNotePresentation([old], [parsed, parsed]).updatedIds, []);
  assert.deepEqual(enrichReviewNotePresentation([{ ...old, origin: 'codex' }], [parsed]).updatedIds, []);
  assert.deepEqual(enrichReviewNotePresentation([old], [{ ...parsed, suggestedSource: 'Different recommendation.' }]).updatedIds, []);
});
test('reimporting the exact retained upload enriches only missing metadata once, without duplicate notes or source operations', async t => {
  const root = fileURLToPath(new URL('../work/review-paragraph-format-tests/', import.meta.url)); await mkdir(root, { recursive: true }); const temporary = await mkdtemp(path.join(root, 'case-')), source = path.join(temporary, 'source'); await mkdir(source);
  const original = Buffer.from('\\documentclass{article}\n\\begin{document}\n\nSetup. Old claim. End.\n\n\\end{document}\n'); await writeFile(path.join(source, 'main.tex'), original);
  const app = new PaperApplication({ dataRoot: path.join(temporary, 'private') }); await app.openProject({ root: source, mainFile: 'main.tex' });
  t.after(async () => { await app.close(); assert.ok(path.resolve(temporary).startsWith(path.resolve(root) + path.sep)); await rm(temporary, { recursive: true, force: true }); });
  await app.importReviewNotes(upload);
  await app.core._serial(async () => { const next = app.core.getState(), note = next.reviewNotes[0]; delete note.currentSource; delete note.currentTranslation; delete note.scope; note.decision = 'keep'; note.status = 'resolved'; note.revision = 7; await app.core._commit(next); });
  const before = app.core.getState(), oldId = before.reviewNotes[0].noteId, result = await app.importReviewNotes(upload); assert.equal(result.idempotent, true); assert.deepEqual(result.enrichedNoteIds, [oldId]); assert.equal(app.getState().reviewNotes.length, 1); assert.equal(app.getState().reviewNotes[0].noteId, oldId); assert.equal(app.getState().reviewNotes[0].revision, 8); assert.equal(app.getState().reviewNotes[0].decision, 'keep'); assert.equal(app.getState().reviewNotes[0].status, 'resolved');
  const again = await app.importReviewNotes(upload); assert.deepEqual(again.enrichedNoteIds, []); assert.equal(app.getState().reviewNotes[0].revision, 8);
  assert.deepEqual(app.core.getState().translations, before.translations); assert.deepEqual(app.core.getState().proposals, before.proposals); assert.equal(app.jobs.size, 0); assert.equal(app.flow.builds.length, 0); assert.deepEqual(await readFile(path.join(source, 'main.tex')), original);
  await assert.rejects(app.importReviewNotes({ ...upload, text: structured + '\nDifferent extraction.' }), { code: 'IDEMPOTENCY_CONFLICT' });
});
