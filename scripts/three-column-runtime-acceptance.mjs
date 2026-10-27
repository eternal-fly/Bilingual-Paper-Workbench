import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApplication } from '../src/runtime.mjs';
const target = process.env.PAPER_EDITOR_TARGET_FILE;
if (!target || !path.isAbsolute(target)) throw new Error('Set the exact authorized PAPER_EDITOR_TARGET_FILE.');
const phase = process.argv[2] || 'english', directory = process.env.PAPER_EDITOR_DATA_ROOT || path.join(process.env.LOCALAPPDATA || os.homedir(), 'BilingualPaperEditor/preview');
const hash = data => createHash('sha256').update(data).digest('hex'), before = hash(await readFile(target));
const app = await createApplication({ dataRoot: directory });
const report = { phase, version: '0.3.1', startedAt: new Date().toISOString(), sourceHashBefore: before, checks: [] };
const record = (name, detail = {}) => { report.checks.push({ name, passed: true, ...detail }); console.log(JSON.stringify(report.checks.at(-1))); };
try {
  await app.openProject({ root: path.dirname(target), mainFile: path.basename(target), sourceLanguage: 'en', targetLanguage: 'zh-CN' });
  const state = app.getState(); assert.ok(state.readingParagraphs.length);
  record('complete bilingual reading units preserve original byte ranges', { paragraphs: state.readingParagraphs.length, writable: state.readingParagraphs.filter(item => item.writableSource).length, englishViewAvailable: state.englishView.available });
  if (phase === 'english') {
    const queued = await app.compileEnglish(), result = await app.waitJob({ jobId: queued.jobId });
    assert.equal(result.status, 'success'); assert.equal(result.isolation.verified, true);
    const build = app.getState().englishBuilds.find(item => item.buildId === result.buildId);
    assert.equal(build.readingView.type, 'english-original'); assert.ok(build.readingView.projectedFiles.some(item => item.changed));
    const pdf = await app.readPdf({ buildId: result.buildId }); assert.equal(pdf.kind, 'english'); assert.equal(pdf.hash, result.pdfHash);
    report.build = { ...build, pdfPath: result.pdfPath };
    record('actual English original PDF compiled in verified OS isolation', { buildId: result.buildId, inputHash: result.inputHash, pdfHash: result.pdfHash, pdfBytes: Buffer.from(pdf.base64, 'base64').length });
    const paragraph = state.readingParagraphs.find(item => item.kind === 'paragraph' && !item.writableSource);
    if (paragraph) { const location = await app.locateSource({ buildId: result.buildId, segmentId: paragraph.id }); assert.equal(location.verified, true); assert.ok(location.matches.length); record('derived readonly paragraph locates the same compiled English PDF', { matches: location.matches.length, buildId: result.buildId }); }
  } else if (phase === 'review') {
    let previous = '';
    app.on('change', () => { const job = app.flow?.jobs.filter(item => item.kind === 'fullReview').at(-1); if (!job) return; const key = `${job.status}:${job.completedChunks}:${job.reviewProgress?.stage}`; if (previous !== key) { previous = key; console.log(JSON.stringify({ progress: job.reviewProgress, status: job.status })); } });
    const queued = await app.fullPaperReview({ instruction: '通读全部英文原稿、数学推导、附录和参考文献，结合中文翻译检查论证前提、符号一致性、叙述衔接和可能的实质性缺口。现有34条未采纳意见也只是待审资料，不假定已采用。仅列出有价值且可定位的具体意见；不做未运行的验证或新颖性担保。' });
    const result = await app.waitJob({ jobId: queued.jobId }); assert.equal(result.status, 'completed');
    const after = app.getState(), batch = after.reviewBatches.find(item => item.batchId === result.batchId);
    assert.equal(batch.coverage.completedChunks, batch.coverage.totalChunks); assert.equal(batch.status, 'completed');
    const notes = after.reviewNotes.filter(item => item.batchId === batch.batchId);
    report.batch = batch;
    record('actual Astra completed every full-source chunk before generating opinions', { batchId: batch.batchId, threadId: batch.threadId, model: batch.model, sourceBytes: batch.coverage.sourceBytes, completedChunks: batch.coverage.completedChunks, totalChunks: batch.coverage.totalChunks, notes: notes.length, anchoredNotes: notes.filter(item => item.sourceSegmentIds.length).length });
  } else if (phase === 'reviewRecover') {
    const batch = state.reviewBatches.filter(item => item.status === 'failed' && item.error?.code === 'INVALID_REVIEW_ANCHOR' && item.coverage?.completedChunks === item.coverage?.totalChunks).at(-1);
    assert.ok(batch); const result = await app.reviews.recoverCompleted({ batchId: batch.batchId });
    assert.equal(result.status, 'completed'); const current = app.getState(), completed = current.reviewBatches.find(item => item.batchId === batch.batchId);
    const notes = current.reviewNotes.filter(item => item.batchId === batch.batchId); report.batch = completed;
    record('actual completed full-paper result revalidated against exact source quotes', { batchId: batch.batchId, threadId: completed.threadId, model: completed.model, sourceBytes: completed.coverage.sourceBytes, completedChunks: completed.coverage.completedChunks, totalChunks: completed.coverage.totalChunks, notes: notes.length, anchoredNotes: notes.filter(item => item.sourceSegmentIds.length).length, finalTurnId: completed.finalTurnId });
  } else if (phase === 'paragraph') {
    const prose = state.readingParagraphs.filter(item => {
      if (item.kind !== 'paragraph' || /abstract|摘要/i.test(item.section || '')) return false;
      const prefix = app.core._files.get(item.path)?.bytes?.subarray(0, item.startByte).toString('utf8') || '';
      return prefix.lastIndexOf('\\begin{abstract}') <= prefix.lastIndexOf('\\end{abstract}');
    });
    const paragraph = prose[2] || prose[0]; assert.ok(paragraph);
    const queued = await app.reviewParagraph({ sourceSegmentIds: [paragraph.id], language: 'zh-CN', instruction: '请检查本段英文与现有中文译文的对应、表述清晰度和必要的限定条件。只提出有依据的具体意见，不强行制造问题。' });
    const result = await app.waitJob({ jobId: queued.jobId }); assert.equal(result.status, 'completed');
    const after = app.getState(), batch = after.reviewBatches.find(item => item.batchId === result.batchId), notes = after.reviewNotes.filter(item => item.batchId === result.batchId);
    assert.equal(batch.scope, 'paragraph'); assert.equal(batch.status, 'completed'); assert.deepEqual(batch.sourceSegmentIds, [paragraph.id]);
    assert.ok(notes.every(note => note.sourceSegmentIds.every(id => id === paragraph.id)));
    report.batch = batch;
    record('actual selected third paragraph review completed in the persistent paper chat', { batchId: batch.batchId, paragraphId: paragraph.id, threadId: batch.threadId, model: batch.model, noteCount: notes.length, anchoredNotes: notes.filter(note => note.sourceSegmentIds.length).length });
  } else if (phase === 'pair') {
    const pair = await app.readVersionPair();
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual((await readdir(app.chat.cwd)).sort(), ['latest-english.pdf', 'original.pdf']);
    assert.equal(hash(Buffer.from(pair.original.base64, 'base64')), pair.original.hash); assert.equal(hash(Buffer.from(pair.latest.base64, 'base64')), pair.latest.hash);
    assert.equal(pair.projectId, state.project.id); assert.equal(pair.latest.snapshotId, state.project.snapshotId);
    report.pair = { pairId: pair.pairId, original: { ...pair.original, base64: undefined }, latest: { ...pair.latest, base64: undefined } };
    record('paper chat project contains only frozen original and stable latest English PDF', { pairId: pair.pairId, originalHash: pair.original.hash, latestHash: pair.latest.hash, authorFiles: 2, originalBuildId: pair.original.buildId, latestBuildId: pair.latest.buildId });
  } else if (phase === 'sync') {
    const language = 'zh-CN', paragraph = state.readingParagraphs.find(item => item.kind === 'paragraph' && item.writableSource && item.requestable && state.translations[language]?.[item.id]?.text);
    assert.ok(paragraph, 'A current writable paragraph with an existing translation is required.');
    const previous = structuredClone(state.translations[language][paragraph.id]), proposalIds = [];
    const english = await app.syncParagraph({ sourceSegmentIds: [paragraph.id], direction: 'toEnglish', language, expectedDraftRevisions: { [paragraph.id]: previous.revision } });
    const englishResult = await app.waitJob({ jobId: english.jobId }); assert.equal(englishResult.status, 'completed');
    const proposal = app.getState().proposals.find(item => item.context?.requestId === english.requestId); assert.ok(proposal); assert.equal(proposal.reviewState, 'pending'); assert.equal(proposal.applicationState, 'notApplied'); proposalIds.push(proposal.proposalId);
    record('actual Chinese intent produces only a pending English candidate in the same paper chat', { requestId: english.requestId, proposalId: proposal.proposalId, paragraphId: paragraph.id, threadId: englishResult.threadId, sourceWritten: false });
    const translated = await app.syncParagraph({ sourceSegmentIds: [paragraph.id], direction: 'toTranslation', language, expectedDraftRevisions: { [paragraph.id]: previous.revision }, previousEnglish: { [paragraph.id]: paragraph.source } });
    const translationResult = await app.waitJob({ jobId: translated.jobId }); assert.equal(translationResult.status, 'completed');
    const current = structuredClone(app.getState().translations[language][paragraph.id]); assert.equal(current.revision, previous.revision + 1); assert.equal(current.sourceHash, previous.sourceHash);
    await app.core._serial(async () => {
      await app.core._assertSourceCurrent(); const next = app.core.getState(), exact = next.translations[language][paragraph.id];
      assert.equal(exact.revision, current.revision); assert.equal(exact.text, current.text);
      next.translations[language][paragraph.id] = { ...previous, revision: current.revision + 1, updatedAt: new Date().toISOString(), acceptanceRestored: true }; await app.core._commit(next);
    });
    for (const proposalId of proposalIds) await app.rejectProposal({ proposalId });
    assert.equal(app.getState().translations[language][paragraph.id].text, previous.text);
    record('actual English-to-Chinese synchronization completes, then exact author draft content is restored', { requestId: translated.requestId, paragraphId: paragraph.id, threadId: translationResult.threadId, previousRevision: previous.revision, restoredRevision: current.revision + 1, ownedAcceptanceCandidateRejected: true, sourceWritten: false });
  } else if (phase === 'external') {
    const paragraph = state.readingParagraphs.filter(item => item.kind === 'paragraph')[2] || state.readingParagraphs[0];
    const payload = { filename: '功能验收样例-非真实审稿意见.json', format: 'json', text: JSON.stringify([{ title: '功能验收样例（非真实审稿意见）', body: '仅验证外部意见自动定位和去重，不构成学术建议。', quote: paragraph.source.slice(0, 100), sourceSegmentIds: [paragraph.id] }]) };
    payload.fileHash = hash(payload.text);
    const imported = await app.importReviewNotes(payload); assert.equal(imported.notes.length, 1); assert.deepEqual(imported.notes[0].sourceSegmentIds, [paragraph.id]);
    const retry = await app.importReviewNotes(payload); assert.equal(retry.idempotent, true);
    await app.resolveReviewNote({ noteId: imported.notes[0].noteId, expectedRevision: imported.notes[0].revision, resolved: true });
    await app.core._serial(async () => {
      const next = app.core.getState(), owned = next.reviewBatches.find(item => item.batchId === imported.batch.batchId);
      assert.equal(owned.filename, payload.filename); assert.equal(owned.fileHash, payload.fileHash);
      next.reviewNotes = next.reviewNotes.filter(item => item.batchId !== imported.batch.batchId); next.reviewBatches = next.reviewBatches.filter(item => item.batchId !== imported.batch.batchId); await app.core._commit(next);
    });
    record('clearly labelled external acceptance example anchors once and resolves without source writes', { batchId: imported.batch.batchId, noteId: imported.notes[0].noteId, anchorConfidence: imported.notes[0].anchorConfidence, ownedSyntheticExampleRemoved: true });
  } else throw new Error('Unknown runtime acceptance phase.');
  assert.equal(hash(await readFile(target)), before); record('official manuscript source bytes remain unchanged'); report.ok = true;
} catch (error) { report.ok = false; report.error = { code: error.code || 'ACCEPTANCE_FAILED', message: error.message }; console.error(JSON.stringify(report.error)); process.exitCode = 1; }
finally {
  await app.close(); report.sourceHashAfter = hash(await readFile(target)); report.completedAt = new Date().toISOString();
  const output = path.join(await realpath(directory), 'acceptance'); await mkdir(output, { recursive: true }); await writeFile(path.join(output, `three-column-${phase}-${Date.now()}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
}
