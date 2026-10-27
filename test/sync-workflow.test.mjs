import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaperApplication } from '../src/application.mjs';

function selectedPayload(text) {
  const marker='\n\nUntrusted manuscript context:\n';
  if (!text.includes(marker)) return JSON.parse(text.split('\n\n').at(-1));
  const at=text.indexOf(marker),authorMarker='\n\nRegistered author requirement:\n';
  const author=JSON.parse(text.slice(text.indexOf(authorMarker)+authorMarker.length,at));
  return {...JSON.parse(text.slice(at+marker.length)),prompt:author.instruction};
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function syntheticChat({ hold = false } = {}) {
  const gate = deferred(), entered = deferred(), inputs = [], state = { connected: true, threadId: 'thread-sync-synthetic', model: 'gpt-6-astra', effort: 'medium', busy: false, messages: [] };
  return { inputs, state, entered: entered.promise, release: gate.resolve, on() {}, getState: () => structuredClone(state), connect: async () => {}, bindPaper: async () => {},
    sendMessage: async input => { if (state.busy) throw Object.assign(new Error('Synthetic model is busy.'), { code: 'CHAT_BUSY' }); inputs.push(input); state.busy = true; return { turnId: `turn-${inputs.length}`, threadId: state.threadId }; },
    waitForTurn: async turnId => {
      const input = inputs[Number(turnId.split('-').at(-1)) - 1], payload = selectedPayload(input.text); entered.resolve(); if (hold) await gate.promise;
      const result = payload.kind === 'revision' ? { requestId: payload.requestId, edits: payload.segments.map(item => ({ segmentId: item.segmentId, beforeHash: item.beforeHash, replacement: item.text + ' revised' })), reason: 'Synchronize the selected translation intent.' }
        : { requestId: payload.requestId, translations: payload.segments.map(item => ({ segmentId: item.segmentId, text: item.text.replace('A precise claim', '精确论述') })) };
      state.messages.push({ role: 'assistant', turnId, text: JSON.stringify(result) }); state.busy = false;
      return { threadId: state.threadId, turnId, status: 'completed' };
    },
    interrupt: async () => { gate.resolve(); return { interrupted: true }; }, close: async () => { gate.resolve(); },
  };
}
const ordinary = '\\documentclass{article}\n\\begin{document}\n\nA precise claim uses a reservoir.\n\nAnother precise paragraph.\n\n\\end{document}';
const readonly = '\\documentclass{article}\n\\newcommand{\\eng}{\\noindent{\\normalfont\\sffamily\\scriptsize\\color{Muted}EN}\\enspace\\ignorespaces}\n\\newcommand{\\chin}{\\noindent{\\normalfont\\sffamily\\scriptsize\\color{Muted}中}\\enspace\\ignorespaces}\n\\newenvironment{pairedoriginal}[1]{\\par\\begingroup\\color{#1}}{\\par\\endgroup\\smallskip}\n\\begin{document}\n\\def\\unrelated{opaque}\n\\begin{pairedoriginal}{Old}\n\\eng A precise claim uses a reservoir.\\par\\chin 精确论述使用储备池。\n\\end{pairedoriginal}\n\\end{document}';
async function fixture(t, options = {}) {
  const owned = fileURLToPath(new URL('../work/sync-tests/', import.meta.url)); await mkdir(owned, { recursive: true });
  const directory = await mkdtemp(path.join(owned, 'case-')), source = path.join(directory, 'source'); await mkdir(source);
  const file = path.join(source, 'main.tex'), content = options.readonly ? readonly.replace('\\def\\unrelated{opaque}', '\\def\\unrelated{opaque}\n\\newcommand{\\mutate}{\\catcode 65=13}') : options.verified ? readonly : ordinary; await writeFile(file, content);
  const chat = syntheticChat(options), app = new PaperApplication({ dataRoot: path.join(directory, 'private'), chat }); await app.openProject({ root: source, mainFile: 'main.tex' });
  t.after(async () => { await app.close(); await Promise.allSettled([...app.jobs.values()].map(item => item.promise)); await rm(directory, { recursive: true, force: true }); });
  return { app, chat, file, content };
}

test('sync settings default to off, persist exact glossary entries and reject stale CAS or invalid bounds', async t => {
  const { app } = await fixture(t);
  assert.deepEqual(app.getState().syncPreferences, { revision: 0, sentenceEnd: false, englishToTranslation: false, glossary: [] });
  const glossary = [{ source: 'reservoir', target: '储备池' }];
  const saved = await app.configureSync({ expectedRevision: 0, sentenceEnd: true, glossary });
  assert.deepEqual(saved, { revision: 1, sentenceEnd: true, englishToTranslation: false, glossary });
  await assert.rejects(app.configureSync({ expectedRevision: 0, englishToTranslation: true }), { code: 'VERSION_CONFLICT' });
  for (const bad of [[{ source: 'x'.repeat(201), target: 'term' }], Array.from({ length: 100 }, () => ({ source: 'x'.repeat(100), target: 'y'.repeat(100) }))]) {
    await assert.rejects(app.configureSync({ expectedRevision: 1, glossary: bad }), error => ['INVALID_INPUT', 'REQUEST_TOO_LARGE'].includes(error.code));
  }
  assert.deepEqual(app.core.getState().syncPreferences, saved);
  const reopened = new PaperApplication({ dataRoot: app.dataRoot }); await reopened.openProject({ root: app.getProjectRoot(), mainFile: 'main.tex' });
  assert.deepEqual(reopened.getState().syncPreferences, saved);
});

test('Chinese-to-English sync carries the complete glossary and current draft into only a pending source proposal', async t => {
  const { app, chat, file, content } = await fixture(t), paragraph = app.getState().readingParagraphs[0];
  const glossary = Array.from({ length: 100 }, (_, index) => ({ source: `s${index}`, target: `t${index}` }));
  await app.configureSync({ expectedRevision: 0, glossary });
  await app.saveDraft({ segmentId: paragraph.id, language: 'zh-CN', text: '人工修改后的完整中文意图。', expectedRevision: 0 });
  const queued = await app.syncParagraph({ sourceSegmentIds: [paragraph.id], direction: 'toEnglish', language: 'zh-CN', expectedDraftRevisions: { [paragraph.id]: 1 }, previousEnglish: { [paragraph.id]: 'An earlier English expression.' } });
  assert.equal(queued.direction, 'toEnglish'); await app.waitJob({ jobId: queued.jobId });
  const payload = selectedPayload(chat.inputs[0].text), context = JSON.parse(payload.prompt.split('\n').at(-1));
  assert.deepEqual(context.glossary, glossary); assert.equal(context.previousEnglish[paragraph.id], 'An earlier English expression.');
  assert.equal(payload.segments[0].translationDraft.text, '人工修改后的完整中文意图。');
  const state = app.getState(); assert.equal(state.proposals.length, 1); assert.equal(state.proposals[0].reviewState, 'pending'); assert.equal(state.proposals[0].applicationState, 'notApplied');
  assert.equal(state.transactions.length, 0); assert.equal(await readFile(file, 'utf8'), content);
});

test('reading-only original IDs retain translation support without acquiring English source-write authority', async t => {
  const { app, file, content } = await fixture(t, { readonly: true }), paragraph = app.getState().readingParagraphs[0];
  assert.equal(paragraph.writableSource, false);
  await assert.rejects(app.syncParagraph({ sourceSegmentIds: [paragraph.id], direction: 'toEnglish', language: 'zh-CN' }), { code: 'UNSUPPORTED_TEX' });
  assert.equal(app.getState().requests.length, 0);
  const queued = await app.syncParagraph({ sourceSegmentIds: [paragraph.id], direction: 'toTranslation', language: 'zh-CN' }); await app.waitJob({ jobId: queued.jobId });
  assert.equal(app.getState().requests[0].status, 'completed'); assert.equal(app.getState().proposals.length, 0); assert.equal(await readFile(file, 'utf8'), content);
});

test('verified complex reading originals synchronize current Chinese intent into a pending English candidate', async t => {
  const { app, chat, file, content } = await fixture(t, { verified: true }), paragraph = app.getState().readingParagraphs[0];
  assert.equal(paragraph.writableSource, true); assert.ok(!app.getState().segments.some(item => item.id === paragraph.id));
  const previous = app.getState().translations['zh-CN'][paragraph.id];
  await app.saveDraft({ segmentId: paragraph.id, language: 'zh-CN', text: '修改后的复杂段落中文意图。', expectedRevision: previous.revision });
  const queued = await app.syncParagraph({ sourceSegmentIds: [paragraph.id], direction: 'toEnglish', language: 'zh-CN' }); await app.waitJob({ jobId: queued.jobId });
  const payload = selectedPayload(chat.inputs[0].text);
  assert.equal(payload.segments[0].translationDraft.text, '修改后的复杂段落中文意图。');
  assert.equal(app.getState().proposals[0].edits[0].sourceAuthority.kind, 'literal-reading-v1');
  assert.equal(await readFile(file, 'utf8'), content);
});

test('synchronization uses the effective PDF target language and rejects a reply after its preference revision changes', async t => {
  const { app, chat } = await fixture(t, { hold: true }), paragraph = app.getState().readingParagraphs[0], currentState = app.getState.bind(app);
  let languageRevision = 3;
  app.getState = () => ({ ...currentState(), languagePreferences: { revision: languageRevision, effectiveTargetLanguage: 'fr' } });
  const queued = await app.syncParagraph({ sourceSegmentIds: [paragraph.id], direction: 'toEnglish' }); await chat.entered;
  const request = app.core.getState().requests[0]; assert.equal(request.language, 'fr'); assert.equal(request.syncContext.languagePreferencesRevision, 3);
  languageRevision++; chat.release(); await assert.rejects(app.waitJob({ jobId: queued.jobId }), { code: 'RESULT_STALE' });
  assert.equal(app.getState().proposals.length, 0);
});

test('split translation snapshots every aligned unit and rejects stale expected revisions before request registration', async t => {
  const { app, chat } = await fixture(t), paragraph = app.getState().readingParagraphs[0], language = 'zh-CN';
  await app.saveDraft({ segmentId: paragraph.id, language, text: '第一部分。第二部分。', expectedRevision: 0 });
  await app.splitTranslation({ segmentId: paragraph.id, language, splitAt: 5, expectedRevision: 1 });
  const splitId = Object.keys(app.getState().translations[language]).find(id => id !== paragraph.id);
  await assert.rejects(app.syncParagraph({ sourceSegmentIds: [paragraph.id], direction: 'toEnglish', language, expectedDraftRevisions: { [splitId]: 0 } }), { code: 'VERSION_CONFLICT' });
  assert.equal(app.getState().requests.length, 0);
  const queued = await app.syncParagraph({ sourceSegmentIds: [paragraph.id], direction: 'toEnglish', language, expectedDraftRevisions: { [paragraph.id]: 2, [splitId]: 1 } }); await app.waitJob({ jobId: queued.jobId });
  const request = app.getState().requests[0], payload = selectedPayload(chat.inputs[0].text);
  assert.deepEqual(request.syncContext.draftRevisions, { [paragraph.id]: 2, [splitId]: 1 });
  assert.equal(payload.segments[0].translationDraft.text, '第一部分。\n\n第二部分。');
  const before = structuredClone(app.getState().translations[language]);
  const translated = await app.syncParagraph({ sourceSegmentIds: [paragraph.id], direction: 'toTranslation', language });
  const result = await app.waitJob({ jobId: translated.jobId });
  assert.equal(result.imported.status, 'stale');
  assert.deepEqual(app.getState().translations[language], before);
  assert.equal(app.getState().requests.find(item => item.requestId === translated.requestId).historicalResult.length, 1);
});

test('English-to-translation sync rejects combined and custom target-unit mappings before creating a request', async t => {
  const { app, chat, file, content } = await fixture(t), [first, second] = app.getState().readingParagraphs, language = 'zh-CN';
  await app.saveDraft({ segmentId: first.id, language, text: '合并后的完整译文。', expectedRevision: 0 });
  await app.saveDraft({ segmentId: second.id, language, text: '原第二段译文。', expectedRevision: 0 });
  await app.setAlignment({ language, sourceSegmentIds: [first.id, second.id], translationUnitIds: [first.id] });
  const before = structuredClone(app.getState().translations[language]);
  await assert.rejects(app.syncParagraph({ sourceSegmentIds: [first.id, second.id], direction: 'toTranslation', language }), { code: 'UNSUPPORTED_TEX' });
  await app.setAlignment({ language, sourceSegmentIds: [first.id], translationUnitIds: [second.id] });
  await assert.rejects(app.syncParagraph({ sourceSegmentIds: [first.id], direction: 'toTranslation', language }), { code: 'UNSUPPORTED_TEX' });
  assert.equal(app.getState().requests.length, 0); assert.equal(chat.inputs.length, 0);
  assert.deepEqual(Object.fromEntries(Object.entries(app.getState().translations[language]).map(([id, draft]) => [id, { text: draft.text, revision: draft.revision }])), Object.fromEntries(Object.entries(before).map(([id, draft]) => [id, { text: draft.text, revision: draft.revision }])));
  assert.equal(await readFile(file, 'utf8'), content);
});

test('Chinese-to-English sync requires the entire aligned source group for combined translation intent', async t => {
  const { app, chat } = await fixture(t), [first, second] = app.getState().readingParagraphs, language = 'zh-CN';
  await app.saveDraft({ segmentId: first.id, language, text: '同时对应两个英文段落的完整中文意图。', expectedRevision: 0 });
  await app.setAlignment({ language, sourceSegmentIds: [first.id, second.id], translationUnitIds: [first.id] });
  await assert.rejects(app.syncParagraph({ sourceSegmentIds: [first.id], direction: 'toEnglish', language }), { code: 'ALIGNMENT_SCOPE_MISMATCH' });
  assert.equal(app.getState().requests.length, 0); assert.equal(chat.inputs.length, 0);
  const queued = await app.syncParagraph({ sourceSegmentIds: [first.id, second.id], direction: 'toEnglish', language }); await app.waitJob({ jobId: queued.jobId });
  assert.deepEqual(app.getState().requests[0].segmentIds, [first.id, second.id]);
  assert.deepEqual(app.getState().proposals[0].edits.map(item => item.segmentId), [first.id, second.id]);
});

test('busy paper models and concurrent startup leave no unowned pending sync request', async t => {
  const { app, chat } = await fixture(t), paragraph = app.getState().readingParagraphs[0], input = { sourceSegmentIds: [paragraph.id], direction: 'toTranslation', language: 'zh-CN' };
  chat.state.busy = true; await assert.rejects(app.syncParagraph(input), { code: 'CHAT_BUSY' }); assert.equal(app.getState().requests.length, 0); chat.state.busy = false;
  const entered = deferred(), release = deferred(); app._connectChat = async () => { entered.resolve(); await release.promise; };
  const first = app.syncParagraph(input); await entered.promise;
  await assert.rejects(app.syncParagraph(input), { code: 'CHAT_BUSY' });
  await assert.rejects(app.chatSend({ text: 'Concurrent human message.' }), { code: 'CHAT_BUSY' });
  release.resolve(); const queued = await first; await app.waitJob({ jobId: queued.jobId }); assert.equal(app.getState().requests.length, 1);
});

test('complete glossary context beyond the old inline prompt budget remains registered without dropping terms', async t => {
  const { app } = await fixture(t), paragraph = app.getState().readingParagraphs[0];
  const glossary = Array.from({ length: 31 }, () => ({ source: 's'.repeat(200), target: 't'.repeat(20) }));
  await app.configureSync({ expectedRevision: 0, glossary });
  const queued = await app.syncParagraph({ sourceSegmentIds: [paragraph.id], direction: 'toEnglish', language: 'zh-CN' });
  assert(queued.requestId); assert.deepEqual(app.getState().syncPreferences.glossary, glossary); assert.equal(app.getState().requests.length, 1);
});

test('a Chinese draft mutation queued before proposal creation rejects the late sync reply atomically', async t => {
  const { app, chat, file, content } = await fixture(t, { hold: true }), paragraph = app.getState().readingParagraphs[0], language = 'zh-CN';
  await app.saveDraft({ segmentId: paragraph.id, language, text: '原中文意图。', expectedRevision: 0 });
  const queued = await app.syncParagraph({ sourceSegmentIds: [paragraph.id], direction: 'toEnglish', language }); await chat.entered;
  const entered = deferred(), release = deferred(), blocker = app.core._serial(async () => { entered.resolve(); await release.promise; }); await entered.promise;
  const mutation = app.saveDraft({ segmentId: paragraph.id, language, text: '模型返回前的更新意图。', expectedRevision: 1 });
  chat.release(); await new Promise(resolve => setImmediate(resolve)); release.resolve(); await blocker; await mutation;
  await assert.rejects(app.waitJob({ jobId: queued.jobId }), { code: 'RESULT_STALE' });
  const state = app.getState(); assert.equal(state.requests[0].status, 'stale'); assert.equal(state.proposals.length, 0); assert.ok(chat.state.messages.length > 0);
  assert.equal(await readFile(file, 'utf8'), content);
});

test('dynamic revision tools cannot bypass the stale synchronization context gate', async t => {
  const { app, chat } = await fixture(t, { hold: true }), paragraph = app.getState().readingParagraphs[0], language = 'zh-CN';
  const queued = await app.syncParagraph({ sourceSegmentIds: [paragraph.id], direction: 'toEnglish', language }); await chat.entered;
  const request = app.getState().requests[0];
  await app.saveDraft({ segmentId: paragraph.id, language, text: '后续人工修改。', expectedRevision: 0 });
  await assert.rejects(app.handlePaperTool('paper_propose_revision', { requestId: request.requestId, reason: 'A late tool result.', edits: [{ segmentId: paragraph.id, beforeHash: paragraph.beforeHash, replacement: request.segments[0].text }] }, { threadId: chat.state.threadId, turnId: app._activeChatScope.turnId }), { code: 'RESULT_STALE' });
  assert.equal(app.getState().proposals.length, 0); chat.release(); await assert.rejects(app.waitJob({ jobId: queued.jobId }), { code: 'RESULT_STALE' });
});

test('a newer overlapping sync generation makes an older reply historical', async t => {
  const { app, chat } = await fixture(t, { hold: true }), paragraph = app.getState().readingParagraphs[0];
  const queued = await app.syncParagraph({ sourceSegmentIds: [paragraph.id], direction: 'toEnglish', language: 'zh-CN' }); await chat.entered;
  await app.core._serial(async () => { const next = app.core.getState(), newer = structuredClone(next.requests[0]); newer.requestId = 'req-newer-synthetic'; newer.syncContext.generation++; next.requests.push(newer); await app.core._commit(next); });
  chat.release(); await assert.rejects(app.waitJob({ jobId: queued.jobId }), { code: 'RESULT_STALE' });
  assert.equal(app.getState().requests.find(item => item.requestId === queued.requestId).status, 'stale'); assert.equal(app.getState().proposals.length, 0);
});

test('alignment-only changes and changed glossary preferences invalidate late sync replies', async t => {
  for (const direction of ['toEnglish', 'toTranslation']) await t.test(direction, async subtest => {
    const { app, chat } = await fixture(subtest, { hold: true }), paragraph = app.getState().readingParagraphs[0], language = 'zh-CN';
    await app.saveDraft({ segmentId: paragraph.id, language, text: '当前中文。', expectedRevision: 0 });
    await app.setAlignment({ language, sourceSegmentIds: [paragraph.id], translationUnitIds: [paragraph.id] });
    const queued = await app.syncParagraph({ sourceSegmentIds: [paragraph.id], direction, language }); await chat.entered;
    await app.setAlignment({ language, sourceSegmentIds: [paragraph.id], translationUnitIds: [paragraph.id] }); chat.release();
    await assert.rejects(app.waitJob({ jobId: queued.jobId }), { code: 'RESULT_STALE' });
    assert.equal(app.getState().translations[language][paragraph.id].revision, 1); assert.equal(app.getState().proposals.length, 0);
  });
  await t.test('preferences', async subtest => {
    const { app, chat } = await fixture(subtest, { hold: true }), paragraph = app.getState().readingParagraphs[0];
    const queued = await app.syncParagraph({ sourceSegmentIds: [paragraph.id], direction: 'toEnglish', language: 'zh-CN' }); await chat.entered;
    await app.configureSync({ expectedRevision: 0, glossary: [{ source: 'reservoir', target: '量子储备池' }] }); chat.release();
    await assert.rejects(app.waitJob({ jobId: queued.jobId }), { code: 'RESULT_STALE' }); assert.equal(app.getState().proposals.length, 0);
  });
  await t.test('readonly translation preferences', async subtest => {
    const { app, chat } = await fixture(subtest, { hold: true, readonly: true }), paragraph = app.getState().readingParagraphs[0], language = 'zh-CN';
    const before = app.getState().translations[language][paragraph.id];
    const queued = await app.syncParagraph({ sourceSegmentIds: [paragraph.id], direction: 'toTranslation', language }); await chat.entered;
    await app.configureSync({ expectedRevision: 0, englishToTranslation: true }); chat.release();
    await assert.rejects(app.waitJob({ jobId: queued.jobId }), { code: 'RESULT_STALE' });
    assert.deepEqual(app.getState().translations[language][paragraph.id], before); assert.equal(app.getState().proposals.length, 0);
  });
});
