import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaperApplication } from '../src/application.mjs';
import { DesktopTranslationTasks } from '../src/translation-tasks.mjs';
import { MODEL_CONTEXT_BYTES } from '../src/request-budgets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const threadId = 'synthetic-desktop-origin';
async function fixture(t, count = 17, { padding = 0, enqueue } = {}) {
  const owned = path.join(root, 'work/translation-task-tests'); await mkdir(owned, { recursive: true });
  const temporary = await mkdtemp(path.join(owned, 'case-')), source = path.join(temporary, 'source'), dataRoot = path.join(temporary, 'private'); await mkdir(source);
  const before = '\\documentclass{article}\n\\begin{document}\n\n' + Array.from({ length: count }, (_, i) => `Paragraph ${String(i).padStart(3, '0')} contains $x_{${i}}=1$ and \\cite{synthetic${i}}. ${'Readable prose. '.repeat(padding)} End of paragraph ${i}.`).join('\n\n') + '\n\n\\end{document}\n';
  const filename = path.join(source, 'main.tex'); await writeFile(filename, before);
  const app = new PaperApplication({ dataRoot }); await app.openProject({ root: source, mainFile: 'main.tex', targetLanguage: 'zh-CN' });
  const deliveries = [], create = (target = app) => new DesktopTranslationTasks(target, { getThreadId: () => threadId, enqueue: enqueue || (async input => { deliveries.push(input); return { messageId: input.clientUserMessageId, status: 'queued' }; }) });
  const tasks = create();
  t.after(async () => { await app.close(); assert.ok(temporary.startsWith(owned + path.sep)); await rm(temporary, { recursive: true, force: true }); });
  const start = options => tasks.start({ scope: 'all', language: 'zh-CN', expectedProjectId: app.getState().project.id, expectedSnapshotId: app.getState().project.snapshotId, ...options });
  return { app, tasks, create, start, deliveries, filename, before, dataRoot, source };
}
const translations = packet => packet.batch.segments.map(segment => ({ segmentId: segment.segmentId || segment.id, text: segment.text.replace('Paragraph', '段落') }));
const submit = (tasks, packet, values = translations(packet)) => tasks.submitBatch({ taskId: packet.taskId, batchId: packet.batch.batchId, requestId: packet.batch.requestId, translations: values }, threadId);

test('Desktop delivery includes the current packaged callback instead of requiring a cached native schema', async t => {
  const f = await fixture(t, 9); f.app.desktopCallbackCommand = "& 'trusted-node.exe' 'installed/desktop-callback.mjs'";
  const task = await f.start();
  assert.ok(f.deliveries[0].text.includes(f.app.desktopCallbackCommand + ' get'));
  assert.ok(f.deliveries[0].text.includes(task.taskId));
  assert.ok(f.deliveries[0].text.includes(f.app.desktopCallbackCommand + ' submit'));
  assert.equal(f.deliveries.length, 1);
  assert.ok(!f.deliveries[0].text.includes('Paragraph 000'));
});

test('one desktop delivery covers all 123 reading paragraphs in exact ordered protected batches', async t => {
  const f = await fixture(t, 123), original = f.app.getState(), ids = original.readingParagraphs.map(p => p.id);
  const started = await f.start({ prompt: 'Keep technical names consistent.' });
  assert.equal(started.total, 123); assert.equal(started.status, 'queued'); assert.equal(f.deliveries.length, 1);
  assert.ok(f.deliveries[0].text.includes(started.taskId)); assert.ok(f.deliveries[0].text.includes('same'));
  const covered = []; let packet, batches = 0;
  while ((packet = await f.tasks.nextBatch({ taskId: started.taskId }, threadId)).batch) {
    assert.ok(packet.batch.segmentIds.length > 8); assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= MODEL_CONTEXT_BYTES);
    assert.equal(packet.batch.bindingId, `desktop:${threadId}`); assert.ok(packet.batch.segments.every(s => s.protectedTokens.length >= 2));
    const repeated = await f.tasks.nextBatch({ taskId: started.taskId }, threadId); assert.equal(repeated.batch.requestId, packet.batch.requestId);
    covered.push(...packet.batch.segmentIds); await submit(f.tasks, packet); batches++;
  }
  assert.equal(packet.status, 'completed'); assert.equal(packet.completed, 123); assert.equal(batches, 1); assert.deepEqual(covered, ids);
  assert.equal(f.deliveries.length, 1); assert.equal(f.app.jobs.size, 0);
  const after = f.app.getState(); assert.deepEqual(after.reviewNotes, original.reviewNotes); assert.deepEqual(after.reviewHistory, original.reviewHistory);
  for (const p of after.readingParagraphs) { const draft = after.translations['zh-CN'][p.id]; assert.ok(draft.text.startsWith('段落')); assert.ok(draft.text.includes('\\cite{synthetic')); assert.ok(draft.text.includes('$x_')); }
  assert.equal(await readFile(f.filename, 'utf8'), f.before);
});

test('arbitrary selected scope has no eight-paragraph UI cap and preserves document order', async t => {
  const f = await fixture(t, 25), all = f.app.getState().readingParagraphs.map(p => p.id), selected = all.filter((_, i) => i % 3 !== 0);
  assert.equal(selected.length, 16);
  selected.push(all[0]);
  const started = await f.start({ scope: 'selected', sourceSegmentIds: [...selected].reverse() }), expected = all.filter(id => selected.includes(id));
  assert.equal(started.total, 17); const result = [];
  for (;;) { const packet = await f.tasks.nextBatch({ taskId: started.taskId }, threadId); if (!packet.batch) break; result.push(...packet.batch.segmentIds); await submit(f.tasks, packet); }
  assert.deepEqual(result, expected); assert.equal(Object.keys(f.app.getState().translations['zh-CN']).length, 17); assert.equal(f.deliveries.length, 1);
});

test('serialized request and response bytes bound batches independently of the paragraph count', async t => {
  const f = await fixture(t, 123, { padding: 1200 }), started = await f.start(); let count = 0, covered = 0;
  for (;;) { const packet = await f.tasks.nextBatch({ taskId: started.taskId }, threadId); if (!packet.batch) break; assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= MODEL_CONTEXT_BYTES); assert.ok(packet.batch.segmentIds.length > 8); covered += packet.batch.segmentIds.length; count++; await submit(f.tasks, packet); }
  assert.equal(covered, 123); assert.ok(count > 1);
});

test('protected object validation is atomic and a corrected batch can retry without losing progress', async t => {
  const f = await fixture(t), started = await f.start(), packet = await f.tasks.nextBatch({ taskId: started.taskId }, threadId), broken = translations(packet);
  broken.at(-1).text = 'Missing protected mathematics and citations.';
  await assert.rejects(submit(f.tasks, packet, broken), { code: 'PROTECTED_TOKEN_CHANGED' });
  assert.equal(Object.keys(f.app.getState().translations['zh-CN'] || {}).length, 0); assert.equal(f.tasks.state().tasks[0].completed, 0);
  await submit(f.tasks, packet); const duplicate = await submit(f.tasks, packet); assert.equal(duplicate.completed, packet.batch.segmentIds.length);
  const changed = translations(packet); changed[0].text += ' Changed.';
  await assert.rejects(submit(f.tasks, packet, changed), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(f.app.getState().translations['zh-CN'][packet.batch.segmentIds[0]].revision, 1);
});

test('manual edits pause before overwrite and explicit resume captures remaining versions only', async t => {
  const f = await fixture(t, 17, { padding: 7900 }), started = await f.start(), first = await f.tasks.nextBatch({ taskId: started.taskId }, threadId); await submit(f.tasks, first);
  const packet = await f.tasks.nextBatch({ taskId: started.taskId }, threadId), id = packet.batch.segmentIds[0];
  await f.app.saveDraft({ segmentId: id, language: 'zh-CN', text: 'Author manual edit.', expectedRevision: 0 });
  const paused = await submit(f.tasks, packet); assert.equal(paused.status, 'paused'); assert.equal(paused.completed, first.batch.segmentIds.length); assert.equal(f.app.getState().translations['zh-CN'][id].text, 'Author manual edit.');
  const resumed = await f.tasks.resume({ taskId: started.taskId }); assert.equal(resumed.completed, first.batch.segmentIds.length); assert.equal(resumed.generation, 2); assert.equal(f.deliveries.length, 2); assert.notEqual(f.deliveries[0].clientUserMessageId, f.deliveries[1].clientUserMessageId);
  await assert.rejects(submit(f.tasks, packet), { code: 'TRANSLATION_BATCH_REVOKED' });
  const next = await f.tasks.nextBatch({ taskId: started.taskId }, threadId); assert.deepEqual(next.batch.segmentIds, packet.batch.segmentIds); await submit(f.tasks, next);
  assert.equal(f.app.getState().translations['zh-CN'][id].revision, 2); assert.equal(f.app.getState().translations['zh-CN'][first.batch.segmentIds[0]].revision, 1);
});

test('source and target-language changes pause without applying late translations', async t => {
  for (const mode of ['source', 'language', 'alignment']) {
    const f = await fixture(t), started = await f.start(), packet = await f.tasks.nextBatch({ taskId: started.taskId }, threadId);
    if (mode === 'source') await writeFile(f.filename, f.before + '\n');
    if (mode === 'language') await f.app.configureLanguages({ translationLanguage: 'fr', expectedRevision: f.app.getState().languagePreferences.revision });
    if (mode === 'alignment') await f.app.setAlignment({ language: 'zh-CN', sourceSegmentIds: [packet.batch.segmentIds[0]], translationUnitIds: [packet.batch.segmentIds[0]] });
    const result = await submit(f.tasks, packet); assert.equal(result.status, 'paused', mode); assert.equal(result.completed, 0); assert.equal(Object.keys(f.app.getState().translations['zh-CN'] || {}).length, 0);
  }
});

test('language changes inside the core before-write hook still cannot race into a draft write', async t => {
  const f = await fixture(t), started = await f.start(), packet = await f.tasks.nextBatch({ taskId: started.taskId }, threadId);
  const original = f.app.sync.beforeResult.bind(f.app.sync);
  f.app.sync.beforeResult = async request => { await original(request); f.app.pdfSelection.languages = () => ({ effectiveTargetLanguage: 'fr', translationLanguage: 'fr', revision: 1 }); };
  const result = await submit(f.tasks, packet); assert.equal(result.status, 'paused'); assert.equal(Object.keys(f.app.getState().translations['zh-CN'] || {}).length, 0);
});

test('cancellation rejects pending late results without interrupting any desktop chat', async t => {
  const f = await fixture(t), started = await f.start(), packet = await f.tasks.nextBatch({ taskId: started.taskId }, threadId); let interrupts = 0;
  f.app.chatInterrupt = async () => { interrupts++; };
  const cancelled = await f.tasks.cancel({ taskId: started.taskId }); assert.equal(cancelled.status, 'cancelled');
  await assert.rejects(submit(f.tasks, packet), { code: 'TRANSLATION_TASK_CANCELLED' }); assert.equal(interrupts, 0); assert.equal(Object.keys(f.app.getState().translations['zh-CN'] || {}).length, 0);
  const resumed = await f.tasks.resume({ taskId: started.taskId }); assert.equal(resumed.generation, 2); assert.equal(f.deliveries.length, 2);
  await assert.rejects(submit(f.tasks, packet), { code: 'TRANSLATION_BATCH_REVOKED' });
});

test('only the fixed desktop origin can read or submit batches and invalid scopes never enqueue', async t => {
  const f = await fixture(t), ids = f.app.getState().readingParagraphs.map(p => p.id);
  await assert.rejects(f.start({ scope: 'selected', sourceSegmentIds: [ids[0], ids[0]] }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.start({ scope: 'selected', sourceSegmentIds: ['foreign'] }), { code: 'SEGMENT_NOT_FOUND' });
  await assert.rejects(f.start({ expectedSnapshotId: 'old' }), { code: 'VERSION_CONFLICT' }); assert.equal(f.deliveries.length, 0);
  const started = await f.start(); await assert.rejects(f.tasks.nextBatch({ taskId: started.taskId }, 'another-desktop-chat'), { code: 'TRANSLATION_ORIGIN_MISMATCH' });
  const packet = await f.tasks.nextBatch({ taskId: started.taskId }, threadId);
  await assert.rejects(f.tasks.submitBatch({ taskId: started.taskId, batchId: packet.batch.batchId, requestId: packet.batch.requestId, translations: translations(packet) }, 'another-desktop-chat'), { code: 'TRANSLATION_ORIGIN_MISMATCH' });
  assert.equal(f.tasks.ownsRequest(packet.batch.requestId), true); assert.equal(f.tasks.getTaskForRequest(packet.batch.requestId).taskId, started.taskId);
  const result = await f.tasks.receiveRequestResult({ requestId: packet.batch.requestId, translations: translations(packet) }, threadId); assert.equal(result.completed, packet.batch.segmentIds.length);
});

test('persistent pending requests and completed progress survive controller reconstruction', async t => {
  const f = await fixture(t, 17, { padding: 7900 }), started = await f.start(), first = await f.tasks.nextBatch({ taskId: started.taskId }, threadId); await submit(f.tasks, first);
  const pending = await f.tasks.nextBatch({ taskId: started.taskId }, threadId), restored = f.create();
  const same = await restored.nextBatch({ taskId: started.taskId }, threadId); assert.equal(same.batch.requestId, pending.batch.requestId); assert.equal(same.completed, first.batch.segmentIds.length); assert.equal(f.deliveries.length, 1);
  const saved = JSON.parse(await readFile(path.join(f.app.core._store, 'workflow.json'), 'utf8')); assert.equal(saved.translationTasks[0].taskId, started.taskId);
  await submit(restored, same); assert.equal(restored.state().tasks[0].completed, 17);
});

test('an applied core result is acknowledged after a crash before task progress persistence', async t => {
  const f = await fixture(t), started = await f.start(), packet = await f.tasks.nextBatch({ taskId: started.taskId }, threadId), values = translations(packet);
  await f.app.submitTranslationResult({ requestId: packet.batch.requestId, translations: values });
  const restored = f.create(), result = await submit(restored, packet, values); assert.equal(result.completed, packet.batch.segmentIds.length);
  assert.equal(f.app.getState().translations['zh-CN'][packet.batch.segmentIds[0]].revision, 1);
});

test('delivery failures are visible and resume sends one new generation without starting a model worker', async t => {
  let sends = 0; const f = await fixture(t, 17, { enqueue: async () => { sends++; if (sends === 1) throw Object.assign(Error('Desktop unavailable.'), { code: 'DESKTOP_UNAVAILABLE' }); return { status: 'queued' }; } });
  const started = await f.start(); assert.equal(started.status, 'delivery-failed'); assert.equal(started.error.code, 'DESKTOP_UNAVAILABLE');
  const resumed = await f.tasks.resume({ taskId: started.taskId }); assert.equal(resumed.status, 'queued'); assert.equal(resumed.generation, 2); assert.equal(sends, 2); assert.equal(f.app.jobs.size, 0);
});

test('an oversized single paragraph fails before delivery instead of omitting or truncating it', async t => {
  const f = await fixture(t, 1, { padding: 150000 }),before=f.app.getState();
  await assert.rejects(f.start(), error => ['REQUEST_TOO_LARGE', 'ATOMIC_ITEM_TOO_LARGE', 'UNSUPPORTED_TEX'].includes(error.code)); assert.equal(f.deliveries.length, 0); assert.equal(f.tasks.state().tasks.length, 0);
  const after=f.app.getState();assert.deepEqual(after.requests,before.requests);assert.deepEqual(after.translations,before.translations);assert.equal(await readFile(f.filename,'utf8'),f.before);
});

test('concurrent exact retries across task controllers have one atomic draft write', async t => {
  const f = await fixture(t), started = await f.start(), packet = await f.tasks.nextBatch({ taskId: started.taskId }, threadId), other = f.create();
  const results = await Promise.all([submit(f.tasks, packet), submit(other, packet)]); assert.ok(results.every(result => result.completed === packet.batch.segmentIds.length));
  assert.equal(f.app.getState().translations['zh-CN'][packet.batch.segmentIds[0]].revision, 1);
  const reordered = [...translations(packet)].reverse(); assert.equal((await submit(other, packet, reordered)).completed, packet.batch.segmentIds.length);
});

test('a real paper app restart restores the pending request without another delivery', async t => {
  const f = await fixture(t), started = await f.start(), packet = await f.tasks.nextBatch({ taskId: started.taskId }, threadId);
  await f.app.close();
  const restoredApp = new PaperApplication({ dataRoot: f.dataRoot });
  try {
    await restoredApp.openProject({ root: f.source, mainFile: 'main.tex', targetLanguage: 'zh-CN' }); const restored = f.create(restoredApp);
    const same = await restored.nextBatch({ taskId: started.taskId }, threadId); assert.equal(same.batch.requestId, packet.batch.requestId);
    await submit(restored, same); assert.equal(restored.state().tasks[0].completed, packet.batch.segmentIds.length); assert.equal(f.deliveries.length, 1);
  } finally { await restoredApp.close(); }
});

test('a manual edit interleaving protected request creation pauses that task immediately', async t => {
  const f = await fixture(t), started = await f.start(), create = f.app.createRequest.bind(f.app);
  f.app.createRequest = async input => { const request = await create(input); await f.app.saveDraft({ segmentId: input.segmentIds[0], language: 'zh-CN', text: 'Manual race wins.', expectedRevision: 0 }); return request; };
  const packet = await f.tasks.nextBatch({ taskId: started.taskId }, threadId); assert.equal(packet.status, 'paused'); assert.equal(packet.batch, null); assert.equal(packet.completed, 0);
});

test('a superseding approved request keeps the task result historical and preserves current drafts', async t => {
  const f = await fixture(t), started = await f.start(), packet = await f.tasks.nextBatch({ taskId: started.taskId }, threadId);
  await f.app.createRequest({ kind: 'translation', segmentIds: packet.batch.segmentIds, language: 'zh-CN', bindingId: `desktop:${threadId}` });
  const result = await submit(f.tasks, packet); assert.equal(result.status, 'paused'); assert.equal(result.completed, 0); assert.equal(Object.keys(f.app.getState().translations['zh-CN'] || {}).length, 0);
});
