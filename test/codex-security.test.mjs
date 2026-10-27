import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, link, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { WindowsSourceWriter } from '../src/windows-writer.mjs';
import { PaperApplication, buildInputHash } from '../src/application.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
async function ownedCase(t) {
  const owned = path.join(root, 'work/security-review'); await mkdir(owned, { recursive: true });
  const temporary = await mkdtemp(path.join(owned, 'case-'));
  t.after(async () => { assert.ok(path.resolve(temporary).startsWith(path.resolve(owned) + path.sep)); await rm(temporary, { recursive: true, force: true }); });
  return temporary;
}
test('source promotion rejects a hard-linked file that would modify content outside the project', async t => {
  if (process.platform !== 'win32') { t.skip('Windows source writer'); return; }
  const temporary = await ownedCase(t), source = path.join(temporary, 'source'); await mkdir(source);
  const outside = path.join(temporary, 'unrelated.tex'), before = Buffer.from('unrelated original'), after = Buffer.from('candidate');
  await writeFile(outside, before); await link(outside, path.join(source, 'main.tex'));
  const writer = new WindowsSourceWriter({ dataRoot: path.join(temporary, 'private') });
  await assert.rejects(writer.write({ root: source, transactionId: 'hardlink-review', readSet: [{ path: 'main.tex', hash: hash(before) }], changes: [{ path: 'main.tex', beforeHash: hash(before), hash: hash(after), bytes: after }] }), { code: 'PERMISSION_DENIED' });
  assert.deepEqual(await readFile(outside), before);
});
test('a post-build changed PDF cannot remain labelled as the exact verified compiler artifact', async t => {
  const temporary = await ownedCase(t), source = path.join(temporary, 'source'); await mkdir(source);
  await writeFile(path.join(source, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\nA safe source paragraph.\n\n\\end{document}\n');
  const pdfPath = path.join(temporary, 'baseline.pdf'), originalPdf = Buffer.from('%PDF-original reviewed build');
  const compiler = { probe: async () => ({ available: true, isolated: true }), build: async input => { await writeFile(pdfPath, originalPdf); return { buildId: `build-${randomUUID()}`, status: 'success', inputHash: buildInputHash(input), snapshotId: input.snapshotId, candidateHash: input.candidateHash, pdfPath, pdfHash: hash(originalPdf), isolation: { verified: true } }; } };
  const app = new PaperApplication({ dataRoot: path.join(temporary, 'private'), compiler }); await app.initialize(); await app.openProject({ root: source, mainFile: 'main.tex' });
  const queued = await app.compileBaseline(); await app.waitJob({ jobId: queued.jobId });
  await writeFile(pdfPath, '%PDF-third party changed artifact');
  await assert.rejects(app.readPdf(), { code: 'BUILD_ARTIFACT_CHANGED' });
});
test('source promotion rejects a changed cached candidate even if its individual file hash is updated', async t => {
  const temporary = await ownedCase(t), source = path.join(temporary, 'source'); await mkdir(source);
  const original = '\\documentclass{article}\n\\begin{document}\n\nA clear claim.\n\n\\end{document}\n';
  await writeFile(path.join(source, 'main.tex'), original);
  const compiler = { probe: async () => ({ available: true, isolated: true }), build: async input => {
    const pdfPath = path.join(temporary, 'candidate.pdf'), bytes = Buffer.from('%PDF-original reviewed candidate'); await writeFile(pdfPath, bytes);
    return { buildId: `build-${randomUUID()}`, status: 'success', inputHash: buildInputHash(input), snapshotId: input.snapshotId, candidateHash: input.candidateHash, pdfPath, pdfHash: hash(bytes), isolation: { verified: true } };
  } };
  const app = new PaperApplication({ dataRoot: path.join(temporary, 'private'), compiler }); await app.initialize(); await app.openProject({ root: source, mainFile: 'main.tex' });
  const segment = app.getState().segments.find(item => item.translatable);
  const request = await app.createRequest({ kind: 'revision', segmentIds: [segment.id] });
  const proposal = await app.proposeRevision({ requestId: request.requestId, edits: [{ segmentId: segment.id, beforeHash: segment.beforeHash, replacement: segment.displayText.replace('clear', 'precise') }], reason: 'Clarify wording.' });
  const preview = await app.previewTransaction({ proposalIds: [proposal.proposalId] }); await app.waitJob({ jobId: preview.jobId });
  const accepted = await app.prepareAcceptance({ transactionId: preview.transactionId });
  const workflowPath = path.join(app.core._store, 'workflow.json');
  const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
  const file = workflow.transactions[0].candidate.files[0]; file.content = file.content.replace('precise', 'unreviewed'); file.hash = hash(Buffer.from(file.content));
  await writeFile(workflowPath, JSON.stringify(workflow));
  await assert.rejects(app.applyTransaction({ transactionId: preview.transactionId, confirmationToken: accepted.confirmationToken, idempotencyKey: 'tamper-proof' }), { code: 'CANDIDATE_HASH_MISMATCH' });
  assert.equal(await readFile(path.join(source, 'main.tex'), 'utf8'), original);
});

async function workflowCase(t, { multiFile = false, faultAfterFirstWrite = false } = {}) {
  const temporary = await ownedCase(t), source = path.join(temporary, 'source'), dataRoot = path.join(temporary, 'private'); await mkdir(source);
  const originals = multiFile ? { 'main.tex': '\\documentclass{article}\n\\begin{document}\n\\input{one}\n\\input{two}\n\\end{document}\n', 'one.tex': 'A clear first claim.\n', 'two.tex': 'A clear second claim.\n' } : { 'main.tex': '\\documentclass{article}\n\\begin{document}\n\nA clear first claim.\n\nA stable second paragraph.\n\n\\end{document}\n' };
  for (const [name, text] of Object.entries(originals)) await writeFile(path.join(source, name), text);
  // Controlled dependency for transaction tests; OS compiler isolation has separate integration tests.
  const compiler = { probe: async () => ({ available: true, isolated: true }), build: async input => {
    const pdfPath = path.join(temporary, `build-${randomUUID()}.pdf`), bytes = Buffer.from('%PDF-transaction fixture'); await writeFile(pdfPath, bytes);
    return { buildId: `build-${randomUUID()}`, status: 'success', inputHash: buildInputHash(input), snapshotId: input.snapshotId, candidateHash: input.candidateHash, pdfPath, pdfHash: hash(bytes), isolation: { verified: true } };
  } };
  const realWriter = new WindowsSourceWriter({ dataRoot: path.join(temporary, 'writer') }); let failOnce = faultAfterFirstWrite;
  const writer = { write: (input, callbacks) => realWriter.write(input, { ...callbacks, onProgress: async event => { await callbacks.onProgress?.(event); if (failOnce) { failOnce = false; throw Object.assign(new Error('Synthetic coordinator interruption after durable first file.'), { code: 'SIMULATED_INTERRUPTION' }); } } }) };
  const app = new PaperApplication({ dataRoot, compiler, writer }); await app.initialize(); await app.openProject({ root: source, mainFile: 'main.tex' });
  const selected = app.getState().segments.filter(item => item.translatable && item.source.includes('clear'));
  return { temporary, source, dataRoot, originals, compiler, realWriter, app, selected };
}
async function candidateFor(fixture) {
  const request = await fixture.app.createRequest({ kind: 'revision', segmentIds: fixture.selected.map(item => item.id) });
  const proposal = await fixture.app.proposeRevision({ requestId: request.requestId, edits: fixture.selected.map(item => ({ segmentId: item.id, beforeHash: item.beforeHash, replacement: item.displayText.replace('clear', 'precise') })), reason: 'Clarify the exact chosen prose.' });
  const preview = await fixture.app.previewTransaction({ proposalIds: [proposal.proposalId] }); await fixture.app.waitJob({ jobId: preview.jobId });
  const acceptance = await fixture.app.prepareAcceptance({ transactionId: preview.transactionId });
  return { preview, proposal, input: { transactionId: preview.transactionId, confirmationToken: acceptance.confirmationToken, idempotencyKey: `accept-${randomUUID()}` } };
}
test('manual translation drafts and exact IDs survive controlled apply and undo including shifted paragraphs', async t => {
  const fixture = await workflowCase(t);
  const before = fixture.app.getState(), first = fixture.selected[0], later = before.segments.find(item => item.source.includes('stable second'));
  await fixture.app.saveDraft({ segmentId: first.id, language: 'zh-CN', text: '第一段人工译稿。', expectedRevision: 0 });
  await fixture.app.saveDraft({ segmentId: later.id, language: 'zh-CN', text: '第二段人工译稿。', expectedRevision: 0 });
  const { input, proposal } = await candidateFor(fixture); await fixture.app.applyTransaction(input);
  const applied = fixture.app.getState();
  assert.equal(applied.segments.find(item => item.source.includes('precise first')).id, first.id);
  assert.equal(applied.segments.find(item => item.source.includes('stable second')).id, later.id);
  assert.equal(applied.translations['zh-CN'][first.id].text, '第一段人工译稿。');
  assert.equal(applied.translations['zh-CN'][later.id].text, '第二段人工译稿。');
  const inverse = await fixture.app.createUndoProposal({ transactionId: input.transactionId });
  const undoPreview = await fixture.app.previewTransaction({ proposalIds: [inverse.proposalId] }); await fixture.app.waitJob({ jobId: undoPreview.jobId });
  const undoAcceptance = await fixture.app.prepareAcceptance({ transactionId: undoPreview.transactionId });
  await fixture.app.applyTransaction({ transactionId: undoPreview.transactionId, confirmationToken: undoAcceptance.confirmationToken, idempotencyKey: 'undo-draft-identity' });
  const restored = fixture.app.getState();
  assert.equal(restored.segments.find(item => item.source.includes('clear first')).id, first.id);
  assert.equal(restored.translations['zh-CN'][first.id].text, '第一段人工译稿。');
  assert.equal(restored.proposals.find(item => item.proposalId === proposal.proposalId).applicationState, 'reverted');
});
test('a restarted controller recovers a proven two-file partial promotion without losing the compiled candidate', async t => {
  const fixture = await workflowCase(t, { multiFile: true, faultAfterFirstWrite: true }); const { input } = await candidateFor(fixture);
  await assert.rejects(fixture.app.applyTransaction(input), { code: 'SIMULATED_INTERRUPTION' });
  assert.match(await readFile(path.join(fixture.source, 'one.tex'), 'utf8'), /precise/);
  assert.equal(await readFile(path.join(fixture.source, 'two.tex'), 'utf8'), fixture.originals['two.tex']);
  const reopened = new PaperApplication({ dataRoot: fixture.dataRoot, compiler: fixture.compiler, writer: fixture.realWriter }); await reopened.initialize(); await reopened.openProject({ root: fixture.source, mainFile: 'main.tex' });
  const recovered = await reopened.recoverTransactions(); assert.equal(recovered.recovered.length, 1);
  assert.match(await readFile(path.join(fixture.source, 'two.tex'), 'utf8'), /precise/);
  assert.equal(reopened.getState().transactions.find(item => item.transactionId === input.transactionId).state, 'applied');
});
test('restarted recovery freezes when a partially promoted project contains third-party bytes', async t => {
  const fixture = await workflowCase(t, { multiFile: true, faultAfterFirstWrite: true }); const { input } = await candidateFor(fixture);
  await assert.rejects(fixture.app.applyTransaction(input), { code: 'SIMULATED_INTERRUPTION' });
  await writeFile(path.join(fixture.source, 'two.tex'), 'Later author content.\n');
  const reopened = new PaperApplication({ dataRoot: fixture.dataRoot, compiler: fixture.compiler, writer: fixture.realWriter }); await reopened.initialize(); await reopened.openProject({ root: fixture.source, mainFile: 'main.tex' });
  await assert.rejects(reopened.recoverTransactions(), { code: 'PARTIAL_COMMIT_RECOVERY_REQUIRED' });
  assert.equal(await readFile(path.join(fixture.source, 'two.tex'), 'utf8'), 'Later author content.\n');
  assert.match(await readFile(path.join(fixture.source, 'one.tex'), 'utf8'), /precise/);
});
