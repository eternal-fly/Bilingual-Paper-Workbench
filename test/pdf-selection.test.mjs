import test from 'node:test';
import assert from 'node:assert/strict';
import { PdfSelection } from '../src/pdf-selection.mjs';

function fixture() {
  let data = { project: { id: 'paper', snapshotId: 's1', targetLanguage: 'zh-CN' }, segments: [], readingParagraphs: [{ id: 'p1', displayText: 'A claim.', sourceHash: 'h1', protectedTokens: [], translatable: true }], translations: {}, readingDrafts: {}, requests: [], alignments: [], reviewNotes: [], reviewBatches: [] };
  const pair = { pairId: 'pair-1', projectId: 'paper', original: { buildId: 'b1', hash: 'a'.repeat(64), snapshotId: 's0' }, latest: { buildId: 'b2', hash: 'b'.repeat(64), snapshotId: 's1' } };
  const context = { pairId: pair.pairId, original: { hash: pair.original.hash, pageCount: 1, pages: [{ page: 1, text: 'Original PDF' }] }, latest: { hash: pair.latest.hash, pageCount: 1, pages: [{ page: 1, text: 'Latest PDF' }] } };
  const app = { core: { _state: data, getState: () => structuredClone(data), _serial: async fn => fn(), _assertSourceCurrent: async () => {}, _commit: async next => { data = next; app.core._state = next; } }, getState: () => ({ ...structuredClone(data), languagePreferences: controller.languages(), pdfSelection: controller.state(), builds: [] }), versionPair: { read: async () => structuredClone(pair) }, cycles: { cached: { projectId: 'paper', snapshotId: 's1', context } }, _projectOperation: fn => fn(), emit() {} };
  const controller = new PdfSelection(app);
  return { app, controller, pair, context, mutate: fn => fn(data) };
}

test('fresh interface defaults to English while retaining the paper translation language',()=>{
 const {controller}=fixture();assert.equal(controller.languages().uiLanguage,'en');assert.equal(controller.languages().translationLanguage,'zh-CN');assert.equal(controller.languages().effectiveTargetLanguage,'zh-CN');
});
test('view acknowledgment verifies hash while preserving default pair review scope', async () => {
  const { controller } = fixture();
  await assert.rejects(controller.recordView({ role: 'latest', buildId: 'b2', pdfHash: 'c'.repeat(64) }), { code: 'VERSION_CONFLICT' });
  await controller.recordView({ role: 'latest', buildId: 'b2', pdfHash: 'b'.repeat(64), expectedPairId: 'pair-1' });
  assert.equal(controller.state().target, 'pair'); assert.equal(controller.state().activeRole, 'latest');
});
test('model PDF selection and interface-follow language preferences have CAS revisions', async () => {
  const { controller } = fixture();
  await controller.select({ target: 'original', expectedRevision: 0 }, 'model');
  assert.equal(controller.state().requestedRole, 'original');
  await assert.rejects(controller.select({ target: 'latest', expectedRevision: 0 }), { code: 'VERSION_CONFLICT' });
  await controller.configureLanguages({ uiLanguage: 'ja', translationLanguage: 'interface', expectedRevision: 0 });
  assert.equal(controller.languages().effectiveTargetLanguage, 'ja');
  await assert.rejects(controller.configureLanguages({ uiLanguage: '__proto__' }), { code: 'INVALID_INPUT' });
});
test('same-chat native review returns actual selected PDF text and preserves source', async () => {
  const { controller, app } = fixture();
  const ctx = await controller.context({ language: 'fr', includeTranslations: true });
  assert.equal(ctx.pdfs.length, 2); assert.equal(ctx.pdfs[1].pages[0].text, 'Latest PDF');
  const result = await controller.submit({ requestId: ctx.requestId, notes: [], translations: [{ segmentId: 'p1', text: 'Une affirmation.' }] });
  assert.equal(result.translationsApplied, 1); assert.equal(app.getState().readingDrafts.fr.p1.text, 'Une affirmation.');
  await assert.rejects(controller.submit({ requestId: ctx.requestId, notes: [], translations: [] }), { code: 'REQUEST_NOT_APPROVED' });
});

test('new native model feedback requires bilingual wording and reasons atomically while legacy notes stay readable', async () => {
  const { controller, app, mutate } = fixture();
  mutate(data => { data.reviewNotes = [{ noteId: 'legacy', origin: 'codex', body: 'An older readable opinion.', sourceSegmentIds: [] }]; });
  const before = app.getState(), context = await controller.context({ sourceSegmentIds: ['p1'], includeTranslations: false });
  await assert.rejects(controller.submit({ requestId: context.requestId, notes: [{ title: 'General advice only', body: 'Make it clearer.', sourceSegmentIds: [] }], translations: [] }), { code: 'RECOMMENDATION_FORMAT_REQUIRED' });
  assert.deepEqual(app.getState(), before);
  const result = await controller.submit({ requestId: context.requestId, notes: [{ title: 'Clarify the claim', suggestedSource: 'The claim applies under this assumption.', suggestedTranslation: '在此前提下，该主张成立。', reasonSource: 'Make the scope explicit.', reasonTranslation: '明确适用范围。', quote: '', sourceSegmentIds: [], severity: 'low' }], translations: [] });
  assert.equal(result.noteCount, 1); assert.ok(app.getState().reviewNotes.some(note => note.noteId === 'legacy'));
  const generated = app.getState().reviewNotes.find(note => note.noteId !== 'legacy');
  assert.equal(generated.suggestedSource, 'The claim applies under this assumption.');
  assert.equal(generated.reasonTranslation, '明确适用范围。');
});
test('native result cannot overwrite a newer draft or a changed PDF choice', async () => {
  const { controller, mutate } = fixture();
  let ctx = await controller.context({});
  mutate(data => { data.translations['zh-CN'] = { p1: { revision: 1, text: 'Author edit' } }; });
  await assert.rejects(controller.submit({ requestId: ctx.requestId, notes: [], translations: [] }), { code: 'RESULT_STALE' });
  ctx = await controller.context({}); await controller.select({ target: 'original' });
  await assert.rejects(controller.submit({ requestId: ctx.requestId, notes: [], translations: [] }), { code: 'RESULT_STALE' });
});
test('language change invalidates pending native results and no model transport is called', async () => {
  const { controller } = fixture(), ctx = await controller.context({});
  await controller.configureLanguages({ uiLanguage: 'de', translationLanguage: 'interface' });
  await assert.rejects(controller.submit({ requestId: ctx.requestId, notes: [], translations: [] }), { code: 'RESULT_STALE' });
});
test('current view requires acknowledgment and candidate replies cannot translate formal source', async () => {
  const { controller } = fixture(); await controller.select({ target: 'current' });
  await assert.rejects(controller.context({}), { code: 'PDF_VIEW_REQUIRED' });
});

test('newer overlapping native opinion request supersedes an older response without draft writes', async () => {
  const { controller } = fixture(), first = await controller.context({ includeTranslations: false }), second = await controller.context({ includeTranslations: false });
  await controller.submit({ requestId: second.requestId, notes: [], translations: [] });
  await assert.rejects(controller.submit({ requestId: first.requestId, notes: [], translations: [] }), { code: 'RESULT_STALE' });
});
test('repeated refreshes retire superseded contexts without exhausting the finite pending window', async () => {
  const { controller } = fixture(); for (let n = 0; n < 12; n++) await controller.context({});
  assert.equal(controller.requests.size, 1);
});
test('native opinion envelope supports more than200 notes and64KiB while remaining Codex-origin feedback', async () => {
  const { controller, app } = fixture(), context = await controller.context({ includeTranslations: false });
  const notes = Array.from({ length: 201 }, (_, index) => ({ title: `Finding ${index}`, body: 'A bounded review opinion. '.repeat(16), recommendation: 'Check scope.', suggestedSource: 'Check scope.', suggestedTranslation: 'Check scope.', reasonSource: 'A bounded review opinion. '.repeat(16), reasonTranslation: 'A bounded review opinion. '.repeat(16), quote: '', sourceSegmentIds: [], severity: 'low' }));
  assert.ok(Buffer.byteLength(JSON.stringify(notes)) > 64 * 1024);
  const result = await controller.submit({ requestId: context.requestId, notes, translations: [] }); assert.equal(result.noteCount, 201); assert.ok(app.getState().reviewNotes.every(note => note.origin === 'codex'));
});
test('native context includes terminology and makes manually split target mappings explicitly opinions-only', async () => {
  const { controller, mutate } = fixture(); mutate(data => { data.syncPreferences = { glossary: [{ source: 'claim', target: '主张' }] }; data.alignments = [{ language: 'zh-CN', sourceSegmentIds: ['p1'], translationUnitIds: ['p1', 'u2'], revision: 1 }]; });
  const context = await controller.context({}); assert.equal(context.glossary[0].target, '主张'); assert.equal(context.paragraphs[0].translationAllowed, false); assert.ok(context.paragraphs[0].translationRestriction);
  await assert.rejects(controller.submit({ requestId: context.requestId, notes: [], translations: [{ segmentId: 'p1', text: 'Do not silently discard me.' }] }), { code: 'REQUEST_NOT_APPROVED' });
});

test('a native selected refresh preserves other anchored opinions from the preceding whole-paper review', async () => {
  const { controller, app, mutate } = fixture();
  mutate(data => {
    data.readingParagraphs = ['First claim.', 'Second claim.', 'Third claim.'].map((displayText, index) => ({ id: `p${index + 1}`, displayText, sourceHash: String(index + 1).repeat(64), protectedTokens: [], translatable: true }));
    data.reviewNotes = [{ noteId: 'external-preserved', origin: 'external', sourceSegmentIds: ['p2'], body: 'External review stays intact.' }];
  });
  const opinion = (id, quote, body) => ({ title: 'Check claim', body, recommendation: 'Clarify assumptions.', suggestedSource: 'Clarify assumptions.', suggestedTranslation: 'Clarify assumptions.', reasonSource: body, reasonTranslation: body, quote, sourceSegmentIds: [id], severity: 'medium' });
  const full = await controller.context({ includeTranslations: false });
  await controller.submit({ requestId: full.requestId, notes: full.paragraphs.map(item => opinion(item.segmentId, item.text, `Initial opinion for ${item.segmentId}.`)), translations: [] });
  const before = app.getState(), oldAi = before.reviewNotes.filter(note => note.origin === 'codex');
  assert.ok(oldAi.every(note => note.reviewScopeIds.length === 3));
  const selected = await controller.context({ sourceSegmentIds: ['p2'], includeTranslations: false });
  await controller.submit({ requestId: selected.requestId, notes: [opinion('p2', 'Second claim.', 'Newest opinion for p2.')], translations: [] });
  const after = app.getState();
  assert.equal(after.reviewNotes.length, 4);
  for (const id of ['p1', 'p3']) { const old = oldAi.find(note => note.sourceSegmentIds.includes(id)); assert.deepEqual(after.reviewNotes.find(note => note.noteId === old.noteId), old); }
  assert.ok(!after.reviewNotes.some(note => note.noteId === oldAi.find(note => note.sourceSegmentIds.includes('p2')).noteId));
  assert.deepEqual(after.reviewNotes.find(note => note.noteId === 'external-preserved'), before.reviewNotes.find(note => note.noteId === 'external-preserved'));
  assert.deepEqual(after.readingParagraphs, before.readingParagraphs); assert.deepEqual(after.translations, before.translations);
});

test('native selected refresh preserves unversioned unlocated notes instead of guessing their generation from a context scope', async () => {
  const { controller, app, mutate } = fixture();
  mutate(data => {
    data.readingParagraphs.push({ id: 'p2', displayText: 'Second claim.', sourceHash: '2'.repeat(64), protectedTokens: [], translatable: true });
    data.reviewNotes = [
      { noteId: 'whole-paper-unlocated', origin: 'codex', sourceSegmentIds: [], reviewScopeIds: ['p1', 'p2'], body: 'Whole paper advice.' },
      { noteId: 'selected-unlocated', origin: 'codex', sourceSegmentIds: [], reviewScopeIds: ['p1'], body: 'Advice scoped to selected paragraph.' },
      { noteId: 'other-unlocated', origin: 'model', sourceSegmentIds: [], reviewScopeIds: ['p2'], body: 'Other paragraph advice.' },
      { noteId: 'unknown-scope', origin: 'ai', sourceSegmentIds: [], body: 'Scope was not recorded.' },
      { noteId: 'anchor-priority', origin: 'codex', sourceSegmentIds: ['p2'], reviewScopeIds: ['p1'], body: 'Explicit anchor wins over context scope.' },
    ];
  });
  const context = await controller.context({ sourceSegmentIds: ['p1'], includeTranslations: false });
  await controller.submit({ requestId: context.requestId, notes: [], translations: [] });
  assert.deepEqual(app.getState().reviewNotes.map(note => note.noteId), ['whole-paper-unlocated', 'selected-unlocated', 'other-unlocated', 'unknown-scope', 'anchor-priority']);
  assert.deepEqual(app.getState().reviewBatches.at(-1).reviewedSourceSegmentIds, ['p1']);
});
test('native future retention off discards only the newly superseded generation and preserves already archived opinions', async () => {
  const { controller, app, mutate } = fixture();
  mutate(data => { data.readingParagraphs[0].sourceHash = '1'.repeat(64); });
  const opinion = body => ({ title: 'Synthetic paragraph review', body, recommendation: 'A clearer claim.', suggestedSource: 'A clearer claim.', suggestedTranslation: 'A clearer claim.', reasonSource: body, reasonTranslation: body, quote: 'A claim.', sourceSegmentIds: ['p1'], severity: 'medium' });
  const first = await controller.context({ sourceSegmentIds: ['p1'], includeTranslations: false }); await controller.submit({ requestId: first.requestId, notes: [opinion('First generation.')], translations: [] }); const old = app.getState().reviewNotes[0];
  mutate(data => { data.reviewHistoryPreferences = { retain: false, revision: 1 }; data.reviewHistory = [{ noteId: 'preexisting-archive', origin: 'codex', body: 'Preserve existing history.', sourceSegmentIds: ['p1'], archivedAt: '2020-01-01T00:00:00Z' }]; });
  const second = await controller.context({ sourceSegmentIds: ['p1'], includeTranslations: false }); await controller.submit({ requestId: second.requestId, notes: [opinion('Second generation.')], translations: [] });
  assert.ok(!app.getState().reviewNotes.some(note => note.noteId === old.noteId)); assert.equal(app.getState().reviewNotes.length, 1); assert.equal(app.getState().reviewNotes[0].body, 'Second generation.'); assert.deepEqual(app.getState().reviewHistory.map(note => note.noteId), ['preexisting-archive']);
});

test('translation-only native results update exact target drafts without creating review heads or mutating any opinion/history record', async () => {
  const { controller, app, mutate } = fixture();
  mutate(data => { data.reviewNotes = [{ noteId: 'external-stays-current', origin: 'external', sourceSegmentIds: ['p1'], body: 'Imported opinion must stay visible.', revision: 1 }]; data.reviewBatches = [{ batchId: 'external-import', origin: 'external', status: 'completed', noteCount: 1 }]; data.reviewHistory = [{ noteId: 'archived-review', origin: 'codex', body: 'Prior opinion.', sourceSegmentIds: ['p1'] }]; data.reviewHistoryPreferences = { retain: true, revision: 3 }; });
  const before = app.getState(), context = await controller.context({ purpose: 'translation', language: 'fr', includeTranslations: true }); assert.equal(context.purpose, 'translation'); assert.ok(context.instructions.includes('notes=[]')); assert.equal(context.reviewNoteFormat, undefined);
  const result = await controller.submit({ requestId: context.requestId, notes: [], translations: [{ segmentId: 'p1', text: 'Une affirmation précise.' }] }); assert.equal(result.purpose, 'translation'); assert.equal(result.translationsApplied, 1); assert.equal(app.getState().readingDrafts.fr.p1.text, 'Une affirmation précise.');
  for (const field of ['reviewNotes', 'reviewBatches', 'reviewHistory', 'reviewHistoryPreferences']) assert.deepEqual(app.getState()[field], before[field]);
});

test('translation-only native context requires writable target scope and rejects opinions or missing translations atomically', async () => {
  const { controller, app } = fixture(); await assert.rejects(controller.context({ purpose: 'translation', includeTranslations: false }), { code: 'INVALID_INPUT' }); await assert.rejects(controller.context({ purpose: 'unknown' }), { code: 'INVALID_INPUT' });
  await controller.select({ target: 'original' }); await assert.rejects(controller.context({ purpose: 'translation' }), { code: 'TRANSLATION_NOT_ALLOWED' }); await controller.select({ target: 'latest' });
  const context = await controller.context({ purpose: 'translation' }), before = app.getState(), opinion = { title: 'An unrequested opinion', suggestedSource: 'A revision.', suggestedTranslation: '一处修订。', reasonSource: 'A reason.', reasonTranslation: '一个理由。', sourceSegmentIds: [], quote: '', severity: 'low' };
  await assert.rejects(controller.submit({ requestId: context.requestId, notes: [opinion], translations: [{ segmentId: 'p1', text: '不应部分写入。' }] }), { code: 'TRANSLATION_ONLY_REQUEST' }); assert.deepEqual(app.getState(), before);
  await assert.rejects(controller.submit({ requestId: context.requestId, notes: [], translations: [] }), { code: 'TRANSLATION_SCOPE_INCOMPLETE' }); assert.deepEqual(app.getState(), before);
  await controller.submit({ requestId: context.requestId, notes: [], translations: [{ segmentId: 'p1', text: '完整对应译文。' }] });
});

test('translation-only native requests retain draft/language/scope/expiry freshness, latest overlap and one-use replay guards', async () => {
  const { controller, app, mutate } = fixture(); let context = await controller.context({ purpose: 'translation' }); mutate(data => { data.translations['zh-CN'] = { p1: { revision: 1, text: 'A newer human draft.' } }; }); const human = app.getState(); await assert.rejects(controller.submit({ requestId: context.requestId, notes: [], translations: [{ segmentId: 'p1', text: '旧结果。' }] }), { code: 'RESULT_STALE' }); assert.deepEqual(app.getState(), human);
  context = await controller.context({ purpose: 'translation' }); await controller.configureLanguages({ translationLanguage: 'de' }); await assert.rejects(controller.submit({ requestId: context.requestId, notes: [], translations: [] }), { code: 'RESULT_STALE' });
  const older = await controller.context({ purpose: 'translation' }), latest = await controller.context({ purpose: 'translation' }); await assert.rejects(controller.submit({ requestId: older.requestId, notes: [], translations: [] }), { code: 'RESULT_STALE' });
  controller.requests.get(latest.requestId).expires = Date.now() - 1; await assert.rejects(controller.submit({ requestId: latest.requestId, notes: [], translations: [] }), { code: 'REQUEST_NOT_APPROVED' });
  context = await controller.context({ purpose: 'translation' }); const payload = { requestId: context.requestId, notes: [], translations: [{ segmentId: 'p1', text: 'Eine Aussage.' }] }; await controller.submit(payload); const completed = app.getState(); await assert.rejects(controller.submit(payload), { code: 'REQUEST_NOT_APPROVED' }); assert.deepEqual(app.getState(), completed);
});
