import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExternalReviews, normalizeModelNotes } from '../src/review-notes.mjs';

const hash = 'a'.repeat(64);
const state = () => ({ project: { snapshotId: 'snap-current' }, segments: [
  { id: 'seg-one', beforeHash: hash, source: 'One unique English claim.', displayText: 'One unique English claim.' },
  { id: 'seg-two', beforeHash: 'b'.repeat(64), source: 'Repeated sentence.', displayText: 'Repeated sentence.' },
  { id: 'seg-three', beforeHash: 'c'.repeat(64), source: 'Repeated sentence.', displayText: 'Repeated sentence.' }
], originals: { 'seg-one': { translation: '原有中文。' } }, translations: { 'zh-CN': { 'seg-one': { text: '当前译文。', sourceHash: hash, status: 'saved' } } } });
const upload = (text, format = 'txt') => ({ filename: 'review.' + format, format, fileHash: hash, text });

test('external opinions anchor a unique exact quote and preserve HTML only as inert text', () => {
  const input = upload(JSON.stringify({ notes: [{ title: '<img src=x onerror=alert(1)>', body: '<script>steal()</script> Clarify this.', quote: 'One unique English claim.', recommendation: 'Explain the assumption.' }] }), 'json');
  const before = state(), original = structuredClone(before);
  const { batch, notes } = normalizeExternalReviews(input, before);
  assert.equal(batch.filename, 'review.json'); assert.equal(batch.fileHash, hash);
  assert.equal(notes[0].origin, 'external'); assert.equal(notes[0].anchorConfidence, 'exactQuote');
  assert.deepEqual(notes[0].sourceSegmentIds, ['seg-one']); assert.equal(notes[0].sourceSnapshotId, 'snap-current');
  assert.deepEqual(notes[0].sourceHashes, { 'seg-one': hash }); assert.equal(notes[0].status, 'open'); assert.equal(notes[0].revision, 1);
  assert.equal(notes[0].title, '<img src=x onerror=alert(1)>'); assert.equal(notes[0].body, '<script>steal()</script> Clarify this.');
  assert.equal(notes[0].replacement, undefined); assert.deepEqual(before, original);
});

test('a repeated quote stays ambiguous and a paragraph number never guesses an anchor', () => {
  const { notes } = normalizeExternalReviews(upload('1. “Repeated sentence.” Needs support.\n\n2. Paragraph 1 needs clarity.'), state());
  assert.equal(notes.length, 2); assert.equal(notes[0].anchorConfidence, 'ambiguous');
  assert.deepEqual(notes[0].sourceSegmentIds, []); assert.deepEqual(notes[0].candidates, ['seg-two', 'seg-three']);
  assert.equal(notes[1].anchorConfidence, 'unanchored'); assert.deepEqual(notes[1].sourceSegmentIds, []);
});

test('inferred quotes preserve small delimiter, Unicode length and repeated-match behavior', () => {
  const active = state(); active.segments.push({ id: 'seg-emoji', beforeHash: 'd'.repeat(64), source: '🙂🙂🙂🙂' });
  for (const body of ['Check “One unique English claim.” please.', 'Check 「One unique English claim.」 please.', 'Check "One unique English claim." please.', 'Check “One unique English claim.」 please.']) {
    const { notes } = normalizeExternalReviews(upload(body), active);
    assert.deepEqual(notes[0].sourceSegmentIds, ['seg-one']);
  }
  const full = normalizeExternalReviews(upload('Check “🙂🙂🙂🙂” please.'), active).notes[0];
  assert.deepEqual(full.sourceSegmentIds, ['seg-emoji']);
  for (const body of ['Check “🙂🙂” please.', 'Check “One unique\nEnglish claim.” please.', '“One unique English claim.” and "One unique English claim."']) {
    const { notes } = normalizeExternalReviews(upload(body), active);
    assert.equal(notes[0].anchorConfidence, 'unanchored');
    assert.deepEqual(notes[0].sourceSegmentIds, []);
  }
});

test('32 MiB of unmatched opening quotes stays bounded without losing imported text or explicit quotes', () => {
  const limit = 32 * 1024 * 1024, body = '“'.repeat(Math.floor(limit / 3)) + 'a'.repeat(limit % 3), started = performance.now();
  const { notes } = normalizeExternalReviews(upload(body), state());
  assert.ok(performance.now() - started < 10000, 'An allowed adversarial import must not block quote inference for minutes.');
  assert.equal(notes[0].body, body);
  assert.equal(notes[0].anchorConfidence, 'unanchored');
  const explicitBody = '“'.repeat(30000);
  const [explicit] = normalizeModelNotes([{ body: explicitBody, quote: 'One unique English claim.' }], state(), { batchId: 'review-large-explicit', origin: 'external' });
  assert.equal(explicit.body, explicitBody);
  assert.deepEqual(explicit.sourceSegmentIds, ['seg-one']);
});
test('single-spaced numbered review points are separate opinions with their continuation lines', () => {
  const { notes } = normalizeExternalReviews(upload('1. Clarify the first claim.\nExplain its scope.\n2. “Repeated sentence.” Needs support.\n3、补充第三条意见。'), state());
  assert.equal(notes.length, 3); assert.ok(notes[0].body.includes('Explain its scope.')); assert.equal(notes[1].anchorConfidence, 'ambiguous');
});

test('original Chinese and current translations are exact matching surfaces', () => {
  for (const quote of ['原有中文。', '当前译文。']) {
    const { notes } = normalizeExternalReviews(upload(JSON.stringify([{ body: 'Check wording.', quote }]), 'json'), state());
    assert.equal(notes[0].anchorConfidence, 'exactQuote'); assert.deepEqual(notes[0].sourceSegmentIds, ['seg-one']);
  }
});

test('unknown IDs and mismatched snapshots are rejected rather than rescued by a quote', () => {
  for (const note of [
    { body: 'Check.', sourceSegmentIds: ['seg-unknown'], quote: 'One unique English claim.' },
    { body: 'Check.', sourceSnapshotId: 'snap-old', quote: 'One unique English claim.' }
  ]) assert.throws(() => normalizeExternalReviews(upload(JSON.stringify([note]), 'json'), state()), { code: 'INVALID_REVIEW_ANCHOR' });
});

test('reading paragraph IDs resolve only through active source mappings', () => {
  const active = state(); active.readingParagraphs = [{ id: 'read-one', sourceSegmentIds: ['seg-one'], english: 'Displayed paragraph text.' }];
  const notes = normalizeModelNotes([{ body: 'Check.', sourceSegmentIds: ['read-one'], quote: 'Displayed paragraph text.' }], active, { batchId: 'review-full-one', origin: 'codex' });
  assert.deepEqual(notes[0].sourceSegmentIds, ['seg-one']); assert.equal(notes[0].origin, 'codex');
  active.readingParagraphs[0].sourceSegmentIds = ['seg-missing'];
  assert.throws(() => normalizeModelNotes([{ body: 'Check.', sourceSegmentIds: ['read-one'] }], active, { batchId: 'review-full-one', origin: 'codex' }), { code: 'INVALID_REVIEW_ANCHOR' });
});

test('current readonly reading IDs anchor without pretending that overlapping core IDs are the same paragraph', () => {
  const active = state(); active.readingParagraphs = [{ id: 'read-hash', sourceSegmentIds: ['read-hash'], canonicalSegmentIds: ['seg-one'], sourceHash: hash, source: 'One unique English claim.', displayText: 'One unique English claim.' }];
  const notes = normalizeModelNotes([{ body: 'Check.', quote: 'One unique English claim.', sourceSegmentIds: ['read-hash'] }], active, { batchId: 'review-full-one' });
  assert.deepEqual(notes[0].sourceSegmentIds, ['read-hash']); assert.deepEqual(notes[0].sourceHashes, { 'read-hash': hash });
  const inferred = normalizeModelNotes([{ body: 'Check.', quote: 'One unique English claim.' }], active, { batchId: 'review-full-one' });
  assert.equal(inferred[0].anchorConfidence, 'exactQuote'); assert.deepEqual(inferred[0].sourceSegmentIds, ['read-hash']);
});

test('an explicit ID with no exact quote stays an unanchored candidate', () => {
  const notes = normalizeModelNotes([{ body: 'Check.', sourceSegmentIds: ['seg-one'] }], state(), { batchId: 'review-full-one' });
  assert.deepEqual(notes[0].sourceSegmentIds, []); assert.deepEqual(notes[0].candidates, ['seg-one']); assert.equal(notes[0].anchorConfidence, 'unanchored');
});

test('a completed model review may report no findings, while an empty external file is rejected', () => {
  assert.deepEqual(normalizeModelNotes([], state(), { batchId: 'review-full-one' }), []);
  assert.throws(() => normalizeExternalReviews(upload('[]', 'json'), state()), { code: 'INVALID_REVIEW' });
});

test('invalid typed fields fail with bounded review errors', () => {
  for (const note of [{ body: 'Check.', quote: {} }, { body: 'Check.', recommendation: [] }, { body: 'Check.', sourceHashes: { unknown: hash } }, { body: 'Check.', page: 2001 }, { body: 'Check.', segmentId: 'unknown', sourceSegmentIds: ['seg-one'], quote: 'One unique English claim.' }]) {
    assert.throws(() => normalizeModelNotes([note], state(), { batchId: 'review-full-one' }), error => ['INVALID_REVIEW', 'INVALID_REVIEW_ANCHOR'].includes(error.code));
  }
});

test('strict model note fields reject executable or proposal-shaped payloads', () => {
  for (const extra of [{ replacement: 'Rewrite source.' }, { edits: [] }, { path: 'C:/secret' }, { status: 'accepted' }, { __proto__: null, command: 'execute' }]) {
    assert.throws(() => normalizeModelNotes([{ body: 'Check.', ...extra }], state(), { batchId: 'review-full-one', origin: 'codex' }), { code: 'INVALID_REVIEW' });
  }
});

test('review envelopes reject formats, path metadata, empty and oversized text', () => {
  for (const input of [upload('x', 'html'), { ...upload('x'), filename: 'C:/secret/review.txt' }, upload(''), upload('中'.repeat(Math.ceil(32 * 1024 * 1024 / 3)))]) {
    assert.throws(() => normalizeExternalReviews(input, state()), error => ['INVALID_REVIEW', 'REVIEW_TOO_LARGE'].includes(error.code));
  }
});

test('large external paragraphs and more than two hundred opinions remain complete while model budgets stay bounded', () => {
  const body = '完整评阅意见。'.repeat(10000);
  const large = normalizeExternalReviews(upload(body), state()); assert.equal(large.notes.length, 1); assert.equal(large.notes[0].body, body);
  const lines = Array.from({ length: 300 }, (_, index) => `${index + 1}. Review point ${index + 1}.`).join('\n');
  const many = normalizeExternalReviews(upload(lines), state()); assert.equal(many.notes.length, 300); assert.equal(many.notes.at(-1).body, '300. Review point 300.');
  const page = normalizeExternalReviews({ ...upload('', 'pdf'), annotations: [{ body: 'End-page comment.', page: 2000 }] }, state()); assert.equal(page.notes[0].page, 2000);
  assert.throws(() => normalizeModelNotes([{ body }], state(), { batchId: 'review-full-one' }), { code: 'INVALID_REVIEW' });
  assert.equal(normalizeModelNotes(Array.from({ length: 201 }, () => ({ body: 'Check.' })), state(), { batchId: 'review-full-one' }).length, 201);
});

test('external input and backend notes count exact UTF-8 bytes at the expanded ceiling', () => {
  const content = '中'.repeat(Math.floor(32 * 1024 * 1024 / 3)) + 'a'.repeat(32 * 1024 * 1024 % 3);
  assert.equal(normalizeExternalReviews(upload(content), state()).notes[0].body, content);
  assert.throws(() => normalizeExternalReviews(upload(content + '中'), state()), error => ['INVALID_REVIEW', 'REVIEW_TOO_LARGE'].includes(error.code));
});

test('external annotations above the former 5000-opinion ceiling remain complete within the text-byte budget', () => {
  const annotations = Array.from({ length: 5000 }, (_, index) => ({ body: `Complete review annotation ${index + 1}.` }));
  const { notes } = normalizeExternalReviews({ ...upload('', 'pdf'), annotations }, state());
  assert.equal(notes.length, 5000); assert.equal(notes.at(-1).body, 'Complete review annotation 5000.');
  assert.equal(normalizeExternalReviews({ ...upload('', 'pdf'), annotations: [...annotations, { body: 'Still within the byte budget.' }] }, state()).notes.length, 5001);
});

test('PDF or DOCX annotations form separate inert opinions with bounded provenance', () => {
  const { notes } = normalizeExternalReviews({ ...upload('Reviewer introduction.', 'pdf'), annotations: [{ title: 'Reviewer', body: 'Check proof.', quote: 'One unique English claim.', page: 2 }] }, state());
  assert.equal(notes.length, 2); assert.equal(notes[1].anchorConfidence, 'exactQuote'); assert.equal(notes[1].page, 2);
});

const structuredIds = ['A01', ...Array.from({ length: 12 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`), 'F01', 'F02', ...Array.from({ length: 19 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`)];
function structuredReview(ids = structuredIds) {
  return 'Full bilingual manuscript with proposed revisions\n\n34 项建议就在相应原文后列出。\nCover material is not an opinion.\n\n' + ids.map((id, index) => `Unchanged paper section ${index} is not an opinion.\n[${id}] Synthetic heading\n原稿 / CURRENT\nEN Original passage ${index} stays out of the opinions.\n中 原译文${index}不得当作意见。\n[${id}] 建议改写 / RECOMMENDED (pending)\nEN Replacement ${index}.\n中 建议文本${index}。${index === 0 ? '\n1\n\nSynthetic paper 中英合并审阅·待确认\n' : '\n'}修改理由 / REASON\nEN Rationale ${index} remains inert: <script>notExecuted()</script>.\n中 修改理由${index}。\n你的决定 / Decision: □ 采用 / Adopt □ 再改 / Revise □ 保留 / Keep\n\nMore unmodified manuscript material ${index}.`).join('\n\n');
}

test('a structured bilingual review imports only its34 proposed edits and reasons, never manuscript paragraphs', () => {
  const { batch, notes } = normalizeExternalReviews(upload(structuredReview(), 'pdf'), state());
  assert.equal(batch.noteCount, 34); assert.equal(notes.length, 34);
  assert.equal(batch.sourceLanguage, 'en'); assert.equal(batch.language, 'zh-CN', 'imported text labels must retain their actual language when the UI target changes');
  assert.deepEqual(notes.map(note => note.title.match(/^\[([^\]]+)\]/u)[1]), structuredIds);
  for (let i = 0; i < notes.length; i++) {
    assert.equal(notes[i].reviewCode, structuredIds[i]);
    assert.equal(notes[i].currentSource, `Original passage ${i} stays out of the opinions.`); assert.equal(notes[i].currentTranslation, `原译文${i}不得当作意见。`); assert.equal(notes[i].scope, 'paragraph'); assert.equal(notes[i].currentContextProvenance, 'external-review-context');
    assert.equal(notes[i].suggestedSource, `Replacement ${i}.`); assert.equal(notes[i].suggestedTranslation, `建议文本${i}。`);
    assert.equal(notes[i].reasonSource, `Rationale ${i} remains inert: <script>notExecuted()</script>.`); assert.equal(notes[i].reasonTranslation, `修改理由${i}。`);
    assert.equal(notes[i].recommendation, `建议文本${i}。`);
    assert.equal(notes[i].body, `修改理由${i}。`);
    assert.equal(notes[i].anchorConfidence, 'unanchored');
    assert.ok(!notes[i].body.includes('not an opinion')); assert.ok(!notes[i].body.includes('原译文')); assert.ok(!notes[i].suggestedTranslation.includes('原译文'));
    assert.ok(!JSON.stringify(notes[i]).includes('Synthetic paper')); assert.ok(!JSON.stringify(notes[i]).includes('Decision:'));
  }
});

test('structured bilingual counts, identities and section boundaries fail atomically instead of importing the whole paper', () => {
  for (const content of [
    structuredReview().replace('34 项建议', '35 项建议'),
    structuredReview([...structuredIds.slice(0, -1), 'A01']),
    structuredReview().replace('修改理由 / REASON', 'Reason marker missing'),
    structuredReview().replace('你的决定 / Decision:', 'Decision marker missing'),
    structuredReview().replace('34 项建议', 'No declared proposal count'),
    structuredReview().replace('[A01] 建议改写 / RECOMMENDED (pending)', '[A01] Missing proposal heading')
  ]) assert.throws(() => normalizeExternalReviews(upload(content, 'pdf'), state()), { code: 'INVALID_REVIEW_STRUCTURE' });
});

test('ordinary review documents containing CURRENT and RECOMMENDED words keep their existing parsing', () => {
  const { notes } = normalizeExternalReviews(upload('1. CURRENT wording is unclear.\n2. RECOMMENDED: add a reference.', 'pdf'), state());
  assert.equal(notes.length, 2); assert.equal(notes[0].body, '1. CURRENT wording is unclear.');
});

test('four-field review content stays typed and complete while legacy notes remain valid', () => {
  const quartet = { reviewCode: 'F01', suggestedSource: 'Replacement.', suggestedTranslation: '修改译文。', reasonSource: 'Reason.', reasonTranslation: '修改理由。' };
  const [note] = normalizeModelNotes([quartet], state(), { batchId: 'review-four-fields' });
  for (const [key, value] of Object.entries(quartet)) assert.equal(note[key], value);
  assert.equal(note.body, quartet.reasonTranslation); assert.equal(note.recommendation, quartet.suggestedTranslation);
  const [reasonQuote] = normalizeModelNotes([{ ...quartet, reasonTranslation: '理由提及“Repeated sentence.”，不应当作原稿引文。' }], state(), { batchId: 'review-reason-quote' });
  assert.equal(reasonQuote.anchorConfidence, 'unanchored'); assert.equal(reasonQuote.quote, undefined);
  for (const bad of [
    { ...quartet, reasonSource: undefined }, { ...quartet, suggestedTranslation: '' }, { ...quartet, reasonTranslation: [] },
    { ...quartet, reasonSource: 'x'.repeat(16 * 1024 + 1) }, { ...quartet, body: 'Conflicting legacy text.' },
    { ...quartet, recommendation: 'Conflicting legacy recommendation.' }, { ...quartet, reviewCode: [] },
    { ...quartet, body: null }, { ...quartet, recommendation: null }, { body: 'Legacy.', suggestedSource: undefined }
  ]) assert.throws(() => normalizeModelNotes([bad], state(), { batchId: 'review-four-fields' }), { code: 'INVALID_REVIEW' });
  const long = 'x'.repeat(12 * 1024);
  assert.throws(() => normalizeModelNotes([{ suggestedSource: long, suggestedTranslation: long, reasonSource: long, reasonTranslation: long }], state(), { batchId: 'review-four-fields' }), { code: 'REVIEW_TOO_LARGE' });
  assert.equal(normalizeModelNotes([{ body: 'Legacy only.' }], state(), { batchId: 'review-legacy' })[0].body, 'Legacy only.');
});

test('structured review quotes come from labelled original English, without treating review codes as paragraph IDs', () => {
  const content = structuredReview().replace('EN Original passage 0 stays out of the opinions.', 'EN One unique\nEnglish claim.');
  const { notes } = normalizeExternalReviews(upload(content, 'pdf'), state());
  assert.equal(notes[0].quote, 'One unique English claim.'); assert.equal(notes[0].anchorConfidence, 'exactQuote');
  assert.deepEqual(notes[0].sourceSegmentIds, ['seg-one']); assert.equal(notes[0].reviewCode, 'A01');
});

test('structured PDF wrapping and mathematical glyphs use only a long unique literal English excerpt as fallback', () => {
  const common = 'This continuous English passage explains the experimental setting and identifies the exact quantities used throughout the argument';
  const active = state(); active.segments[0].source = `A source prefix with $x$. ${common}. A separate source suffix.`; active.segments[0].displayText = active.segments[0].source;
  const content = structuredReview().replace('EN Original passage 0 stays out of the opinions.', `EN PDF formula Ω(√n) ${common.replace('setting and', 'setting\nand')} followed by more PDF glyphs αβ.`);
  const [note] = normalizeExternalReviews(upload(content, 'pdf'), active).notes;
  assert.equal(note.anchorConfidence, 'exactQuote'); assert.deepEqual(note.sourceSegmentIds, ['seg-one']);
  assert.ok(active.segments[0].source.includes(note.quote)); assert.ok(note.quote.split(/\s+/u).length >= 12 || note.quote.replace(/[^A-Za-z]/gu, '').length >= 64);
});

test('fallback excerpts never guess between repeated text, multiple source paragraphs, or short matching phrases', () => {
  const common = 'This continuous English passage explains the experimental setting and identifies the exact quantities used throughout the argument';
  const other = 'Another separate continuous English passage documents every measurement assumption and describes the independent verification performed before publication';
  for (const scenario of ['repeated', 'multiple', 'short']) {
    const active = state();
    active.segments[0].source = scenario === 'short' ? 'Only a short matching sentence.' : common;
    active.segments[0].displayText = active.segments[0].source;
    active.segments[1].source = scenario === 'repeated' ? common : other; active.segments[1].displayText = active.segments[1].source;
    const original = scenario === 'short' ? 'Only a short matching sentence.' : scenario === 'multiple' ? `${common}. ${other}.` : common;
    const content = structuredReview().replace('EN Original passage 0 stays out of the opinions.', `EN Formula Ω ${original} trailing glyph β.`);
    const [note] = normalizeExternalReviews(upload(content, 'pdf'), active).notes;
    assert.notEqual(note.anchorConfidence, 'exactQuote', scenario); assert.deepEqual(note.sourceSegmentIds, []);
  }
});
