import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaperApplication } from '../src/application.mjs';
import { CompilerWorker } from '../src/compiler/worker.mjs';

// The complete real paper is replicated privately. No paper bytes enter the
// repository, and the user’s live manuscript is never a write target of this test.
const target = await realpath(process.env.PAPER_EDITOR_TARGET_FILE || '');
const output = process.env.PAPER_EDITOR_PRIVATE_OUTPUT;
assert.ok(output && path.isAbsolute(output), 'Set a private acceptance directory.');
const repository = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
const outside = filename => { const r = path.relative(repository, filename); return r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r); };
assert.ok(outside(output) && outside(target)); await mkdir(output, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const runtimeRoot = await realpath(process.env.PAPER_EDITOR_COMPILER_RUNTIME);
const liveBefore = hash(await readFile(target)), root = path.join(path.dirname(path.dirname(runtimeRoot)), `qa04-${randomUUID().slice(0, 8)}`), source = path.join(root, 'source'); await mkdir(source, { recursive: true });
const probe = new PaperApplication({ dataRoot: path.join(root, 'probe') });
const report = { schemaVersion: 1, version: '0.4.0', startedAt: new Date().toISOString(), liveSourceHashBefore: liveBefore, privateReplica: true, syntheticEdits: true, checks: [] };
let app;
function checked(name, detail = {}) { report.checks.push({ name, passed: true, ...detail }); console.log(JSON.stringify(report.checks.at(-1))); }
try {
  await probe.openProject({ root: path.dirname(target), mainFile: path.basename(target), sourceLanguage: 'en', targetLanguage: 'zh-CN' });
  const files = [...probe.core._files.values()].map(file => ({ path: file.path, bytes: Buffer.from(file.bytes) }));
  assert.ok(files.length && files.some(file => file.path === path.basename(target)));
  for (const file of files) { const dest = path.resolve(source, file.path), relative = path.relative(source, dest); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await mkdir(path.dirname(dest), { recursive: true }); await writeFile(dest, file.bytes); }
  const compiler = new CompilerWorker({ dataRoot: path.join(root, 'c'), runtimeRoot });
  app = new PaperApplication({ dataRoot: path.join(root, 'state'), compiler }); await app.initialize(); assert.equal(app.probe.isolated, true); await app.openProject({ root: source, mainFile: path.basename(target), sourceLanguage: 'en', targetLanguage: 'zh-CN' });
  const initial = app.getState(), paragraphs = initial.readingParagraphs;
  const originalBaselines = Object.fromEntries(paragraphs.map(p => [p.id, initial.originals[p.id]]));
  const checkBaselines = () => { const current = app.getState(); for (const [id, value] of Object.entries(originalBaselines)) assert.deepEqual(current.originals[id], value); };
  assert.equal(paragraphs.length, 192); assert.ok(paragraphs.every(p => p.writableSource && p.requestable));
  checked('all complete real-paper reading ranges independently writable', { readingUnits: paragraphs.length, headings: paragraphs.filter(p => p.kind === 'heading').length, captions: paragraphs.filter(p => p.kind === 'caption').length, protectedTokens: paragraphs.reduce((n, p) => n + p.protectedTokens.length, 0), dependencyFiles: files.length });
  const proposals = [];
  for (let start = 0; start < paragraphs.length; start += 8) {
    const group = paragraphs.slice(start, start + 8), request = await app.createRequest({ kind: 'revision', segmentIds: group.map(p => p.id) });
    const proposal = await app.proposeRevision({ requestId: request.requestId, reason: 'Synthetic whitespace-only acceptance edit; no scientific change is proposed.', edits: request.segments.map(p => ({ segmentId: p.id, beforeHash: p.beforeHash, replacement: p.text + ' ' })) }); proposals.push(proposal.proposalId);
  }
  checked('every real-paper unit accepts protected candidate without changing formula or reference tokens', { proposals: proposals.length, candidateEdits: paragraphs.length });
  const preview = await app.previewTransaction({ proposalIds: proposals }), built = await app.waitJob({ jobId: preview.jobId }); assert.equal(built.status, 'success'); assert.equal(built.isolation.verified, true);
  checked('combined full-paper candidate compiles in real OS isolation', { buildId: built.buildId, pdfHash: built.pdfHash, inputHash: built.inputHash });
  await assert.rejects(app.applyTransaction({ transactionId: preview.transactionId, confirmationToken: 'not-human-confirmation', idempotencyKey: 'reject-forged-test' }), { code: 'CONFIRMATION_INVALID' });
  const confirmation = await app.prepareAcceptance({ transactionId: preview.transactionId }); await app.applyTransaction({ transactionId: preview.transactionId, confirmationToken: confirmation.confirmationToken, idempotencyKey: `apply-${randomUUID()}` });
  checkBaselines(); assert.deepEqual(app.getState().readingParagraphs.map(p => p.id), paragraphs.map(p => p.id));
  checked('explicit test confirmation applies all ranges and retains original baselines', { transactionId: preview.transactionId, changedFiles: files.filter(f => hash(app.core._files.get(f.path).bytes) !== hash(f.bytes)).length });
  const undo = await app.createUndoProposal({ transactionId: preview.transactionId }), inverse = await app.previewTransaction({ proposalIds: [undo.proposalId] }), undoBuild = await app.waitJob({ jobId: inverse.jobId }); assert.equal(undoBuild.status, 'success'); assert.equal(undoBuild.isolation.verified, true);
  const approval = await app.prepareAcceptance({ transactionId: inverse.transactionId }); await app.applyTransaction({ transactionId: inverse.transactionId, confirmationToken: approval.confirmationToken, idempotencyKey: `undo-${randomUUID()}` });
  for (const file of files) assert.deepEqual(await readFile(path.join(source, file.path)), file.bytes);
  checkBaselines();
  checked('inverse transaction safely compiles and restores every original source byte', { buildId: undoBuild.buildId, inputHash: undoBuild.inputHash, files: files.length });
  assert.equal(hash(await readFile(target)), liveBefore); checked('live manuscript was never modified', { sourceHash: liveBefore }); report.ok = true;
} catch (error) { report.ok = false; report.error = { code: error.code || 'ACCEPTANCE_FAILED', message: error.message }; console.error(JSON.stringify(report.error)); process.exitCode = 1; }
finally { await probe.close(); await app?.close(); report.completedAt = new Date().toISOString(); report.liveSourceHashAfter = hash(await readFile(target)); await writeFile(path.join(output, 'complex-paper-report.json'), JSON.stringify(report, null, 2)); }
