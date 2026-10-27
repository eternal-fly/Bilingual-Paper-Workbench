import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createApplication } from '../src/runtime.mjs';

const target = process.env.PAPER_EDITOR_TARGET_FILE;
if (!target || !path.isAbsolute(target)) throw new Error('Set PAPER_EDITOR_TARGET_FILE to the exact authorized main TeX file.');
const phase = process.argv[2] || 'chat';
const privateRoot = path.join(process.env.LOCALAPPDATA || os.homedir(), 'BilingualPaperEditor');
const directory = process.env.PAPER_EDITOR_DATA_ROOT || path.join(privateRoot, 'preview');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const before = await readFile(target), originalHash = hash(before);
const app = await createApplication({ dataRoot: directory });
const report = { schemaVersion: 1, phase, startedAt: new Date().toISOString(), sourceHashBefore: originalHash, checks: [] };
const record = (name, detail = {}) => { const item = { name, passed: true, ...detail }; report.checks.push(item); console.log(JSON.stringify(item)); };
try {
  await app.openProject({ root: path.dirname(target), mainFile: path.basename(target), sourceLanguage: 'en', targetLanguage: 'zh-CN' });
  const initial = app.getState();
  record('authorized paper opened', { sourceBlocks: initial.segments.length, editableBlocks: initial.segments.filter(item => item.translatable).length, explicitBilingualPairs: initial.segments.filter(item => item.bilingualCompanion).length });
  if (phase === 'chat') {
    const listed = await app.models();
    const saved = app.chatState();
    const selected = listed.models.find(item => item.model === (saved.model || listed.preferredModel));
    if (!selected) throw new Error('Choose an available paper-chat model before acceptance.');
    const chat = await app.chatStart({ model: selected.model, effort: saved.effort || selected.defaultReasoningEffort });
    record('dedicated native Codex thread resumed', { threadId: chat.threadId, model: chat.model, provider: chat.provider, effort: chat.effort });
    const segment = initial.segments.find(item => item.translatable && item.bilingualCompanion && item.source.length > 80 && item.source.length < 3000) || initial.segments.find(item => item.translatable && item.source.length > 80 && item.source.length < 3000);
    assert.ok(segment, 'A bounded safe prose paragraph must be available.');
    const request = await app.createRequest({ kind: 'translation', segmentIds: [segment.id], language: 'zh-CN', prompt: 'Translate this English paragraph into clear academic Chinese. Preserve its precise scope, all numbers, and every protected object. Do not change the source.' });
    const queued = await app.runRequest({ requestId: request.requestId });
    const translated = await app.waitJob({ jobId: queued.jobId });
    assert.equal(translated.status, 'completed');
    assert.equal(translated.imported.status, 'completed');
    record('actual selected paper translation returned and persisted', { requestId: request.requestId, turnId: queued.turnId, translationRevision: app.getState().translations['zh-CN'][segment.id].revision });
    const revision = await app.createRequest({ kind: 'revision', segmentIds: [segment.id], language: 'zh-CN', prompt: 'Suggest one minimal English clarity improvement only. Keep scientific claims, numbers, assumptions and all protected objects unchanged. A suggestion is pending author review and must not be applied.' });
    const advised = await app.runRequest({ requestId: revision.requestId });
    const proposed = await app.waitJob({ jobId: advised.jobId });
    assert.equal(proposed.status, 'completed');
    assert.equal(proposed.imported.applicationState, 'notApplied');
    record('actual paper writing advice returned as pending revision', { requestId: revision.requestId, turnId: advised.turnId, proposalId: proposed.imported.proposalId, reviewState: proposed.imported.reviewState });
  } else if (phase === 'toolCompile') {
    const listed = await app.models(), saved = app.chatState();
    await app.chatStart({ model: saved.model || listed.preferredModel, effort: saved.effort || listed.preferredEffort });
    const queued = await app.chatSend({ text: '请只调用 paper_compile 工具，proposalIds 使用空数组，编译当前绑定的论文基线。等待工具返回实际结果后，用一句中文说明成功或失败及是否隔离；不要读取任何其他文件，不要修改原文，不要把编译通过说成科学结论已验证。' });
    const completed = await app.chat.waitForTurn(queued.turnId, { timeoutMs: 240000 });
    assert.equal(completed.status, 'completed');
    const tool = app.flow.toolEvents?.find(item => item.turnId === queued.turnId && item.tool === 'paper_compile');
    assert.ok(tool, 'Codex must call the real compile controller rather than only describe it.'); assert.equal(tool.status, 'success');
    record('native Codex conversation invoked the isolated paper compiler', { threadId: queued.threadId, turnId: queued.turnId, jobId: tool.jobId, buildId: tool.buildId });
  } else if (phase === 'compile') {
    assert.equal(app.getState().capabilities.secureCompile, true);
    const queued = await app.compileBaseline();
    const build = await app.waitJob({ jobId: queued.jobId });
    if (build.status !== 'success') { report.failedBuild = build; throw Object.assign(new Error('The actual paper isolated build failed. Inspect its private diagnostic log.'), { code: build.code || 'COMPILE_FAILED' }); }
    assert.equal(build.isolation.verified, true);
    const pdf = await app.readPdf({ buildId: build.buildId });
    assert.equal(pdf.hash, build.pdfHash);
    record('actual paper compiled in verified OS isolation', { buildId: build.buildId, inputHash: build.inputHash, pdfHash: build.pdfHash, pdfBytes: Buffer.from(pdf.base64, 'base64').length, isolation: build.isolation });
  } else if (phase === 'navigation') {
    const buildId = app.flow.lastBaselineBuildId, segment = initial.segments.find(item => item.translatable && item.bilingualCompanion && item.source.length > 80);
    assert.ok(buildId && segment);
    const forward = await app.locateSource({ buildId, segmentId: segment.id });
    assert.equal(forward.verified, true); assert.ok(forward.matches.length);
    const first = forward.matches[0];
    const reverse = await app.locatePdf({ buildId, page: first.page, x: Math.max(0, first.x), y: Math.max(0, first.y) });
    assert.equal(reverse.verified, true); assert.ok(reverse.matches.length);
    record('actual paper pinned PDF source navigation in both directions', { buildId, method: forward.method, pdfHash: forward.pdfHash, forwardRegions: forward.matches.length, reverseCandidates: reverse.matches.length, ambiguous: reverse.ambiguous });
  } else if (phase === 'applyUndo') {
    const segment = initial.segments.find(item => item.translatable && item.bilingualCompanion && item.source.length > 80 && item.source.length < 3000);
    assert.ok(segment);
    const original = initial.originals[segment.id];
    // The acceptance change is one trailing TeX space, with no scientific or visible prose change.
    const request = await app.createRequest({ kind: 'revision', segmentIds: [segment.id], prompt: 'Author-authorized reversible whitespace-only source transaction acceptance.' });
    const proposal = await app.proposeRevision({ requestId: request.requestId, edits: [{ segmentId: segment.id, beforeHash: segment.beforeHash, replacement: segment.displayText + ' ' }], reason: 'Reversible whitespace-only acceptance; immediately restore through a reviewed inverse transaction.' });
    const preview = await app.previewTransaction({ proposalIds: [proposal.proposalId] });
    const built = await app.waitJob({ jobId: preview.jobId }); assert.equal(built.status, 'success');
    const pdf = await app.readPdf({ buildId: built.buildId }); assert.equal(pdf.hash, built.pdfHash);
    const acceptance = await app.prepareAcceptance({ transactionId: preview.transactionId });
    const applied = await app.applyTransaction({ transactionId: preview.transactionId, confirmationToken: acceptance.confirmationToken, idempotencyKey: `paper-apply-${Date.now()}` });
    assert.equal(applied.state, 'applied'); assert.notEqual(hash(await readFile(target)), originalHash);
    assert.deepEqual(app.getState().originals[segment.id], original);
    record('actual paper exact compiled whitespace candidate formally written', { transactionId: preview.transactionId, buildId: built.buildId, candidateHash: preview.candidateHash });
    const inverse = await app.createUndoProposal({ transactionId: preview.transactionId });
    const undoPreview = await app.previewTransaction({ proposalIds: [inverse.proposalId] });
    const undoBuild = await app.waitJob({ jobId: undoPreview.jobId }); assert.equal(undoBuild.status, 'success');
    const undoPdf = await app.readPdf({ buildId: undoBuild.buildId }); assert.equal(undoPdf.hash, undoBuild.pdfHash);
    const undoAcceptance = await app.prepareAcceptance({ transactionId: undoPreview.transactionId });
    const undone = await app.applyTransaction({ transactionId: undoPreview.transactionId, confirmationToken: undoAcceptance.confirmationToken, idempotencyKey: `paper-undo-${Date.now()}` });
    assert.equal(undone.state, 'applied'); assert.equal(hash(await readFile(target)), originalHash);
    assert.deepEqual(app.getState().originals[segment.id], original);
    record('actual paper reviewed inverse transaction restored every original byte', { transactionId: undoPreview.transactionId, buildId: undoBuild.buildId, restoredSourceHash: originalHash });
  } else throw new Error('Unknown acceptance phase.');
  assert.equal(hash(await readFile(target)), originalHash);
  record('source bytes unchanged by read/model/build phases');
  report.ok = true;
} catch (error) { report.ok = false; report.error = { code: error.code || 'ACCEPTANCE_FAILED', message: error.message }; console.error(JSON.stringify(report.error)); process.exitCode = 1; }
finally {
  await app.chat?.close();
  report.sourceHashAfter = hash(await readFile(target)); report.completedAt = new Date().toISOString();
  const output = path.join(await realpath(directory), 'acceptance'); await mkdir(output, { recursive: true });
  await writeFile(path.join(output, `${phase}-${Date.now()}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
}
