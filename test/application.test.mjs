import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { PaperApplication, buildInputHash } from '../src/application.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t, compilerOptions = {}) {
  const owned = path.join(root, 'work/application-tests'); await mkdir(owned, { recursive: true });
  const temporary = await mkdtemp(path.join(owned, 'case-'));
  t.after(async () => { assert.ok(path.resolve(temporary).startsWith(path.resolve(owned) + path.sep)); await rm(temporary, { recursive: true, force: true }); });
  const source = path.join(temporary, 'source'); await mkdir(source);
  const before = Buffer.from('\\documentclass{article}\r\n\\begin{document}\r\n\r\nA precise claim needs clear assumptions.\r\n\r\n\\end{document}\r\n');
  await writeFile(path.join(source, 'main.tex'), before);
  // A controlled external compiler dependency; real isolation is exercised separately by compiler integration tests.
  const compiler = {
    probe: async () => ({ available: true, isolated: true }),
    build: async input => {
      const pdfPath = path.join(temporary, `build-${randomUUID()}.pdf`); await writeFile(pdfPath, '%PDF-synthetic-controller-test');
      return { buildId: `build-${randomUUID()}`, status: compilerOptions.fail ? 'failed' : 'success', snapshotId: input.snapshotId, candidateHash: input.candidateHash,
        inputHash: compilerOptions.wrongHash ? 'wrong' : buildInputHash(input), pdfPath, pdfHash: createHash('sha256').update(await readFile(pdfPath)).digest('hex'), isolation: { verified: true } };
    }
  };
  const app = new PaperApplication({ dataRoot: path.join(temporary, 'private'), compiler });
  await app.initialize(); await app.openProject({ root: source, mainFile: 'main.tex' });
  const segment = app.getState().segments.find(item => item.translatable);
  if (compilerOptions.authorDraft) await app.saveDraft({ segmentId: segment.id, language: 'zh-CN', text: compilerOptions.authorDraft, expectedRevision: 0 });
  const request = await app.createRequest({ kind: 'revision', segmentIds: [segment.id] });
  const proposal = await app.proposeRevision({ requestId: request.requestId, edits: [{ segmentId: segment.id, beforeHash: segment.beforeHash, replacement: segment.displayText.replace('clear', 'explicit') }], reason: 'Clarify the presentation.' });
  const preview = await app.previewTransaction({ proposalIds: [proposal.proposalId] }); await app.waitJob({ jobId: preview.jobId });
  return { app, source, before, segment, proposal, preview };
}
test('failed or mismatched compiler output cannot authorize any source promotion', async t => {
  for (const options of [{ fail: true }, { wrongHash: true }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.app.prepareAcceptance({ transactionId: f.preview.transactionId }), { code: 'ACCEPTANCE_NOT_READY' });
    assert.deepEqual(await readFile(path.join(f.source, 'main.tex')), f.before);
  }
});
test('reviewed compiled candidate applies once and an inverse transaction restores exact source bytes', async t => {
  const f = await fixture(t, { authorDraft: '保留作者的译文草稿。' });
  const immutableOriginal = f.app.getState().originals[f.segment.id];
  const acceptance = await f.app.prepareAcceptance({ transactionId: f.preview.transactionId });
  assert.equal(JSON.stringify(f.app.getState()).includes(acceptance.confirmationToken), false);
  const input = { transactionId: f.preview.transactionId, confirmationToken: acceptance.confirmationToken, idempotencyKey: 'one-click' };
  const result = await f.app.applyTransaction(input);
  assert.equal(result.state, 'applied');
  assert.ok(f.app.getState().segments.some(item => item.id === f.segment.id));
  assert.deepEqual(f.app.getState().originals[f.segment.id], immutableOriginal);
  assert.equal(f.app.getState().translations['zh-CN'][f.segment.id].text, '保留作者的译文草稿。');
  assert.match((await readFile(path.join(f.source, 'main.tex'))).toString('utf8'), /explicit assumptions/);
  assert.equal((await f.app.applyTransaction(input)).idempotent, true);
  await assert.rejects(f.app.applyTransaction({ ...input, idempotencyKey: 'replayed-click' }), { code: 'CONFIRMATION_INVALID' });
  const inverse = await f.app.createUndoProposal({ transactionId: input.transactionId });
  await assert.rejects(f.app.editProposal({ proposalId: inverse.proposalId, edits: [] }), { code: 'INVALID_INPUT' });
  const undoPreview = await f.app.previewTransaction({ proposalIds: [inverse.proposalId] }); await f.app.waitJob({ jobId: undoPreview.jobId });
  const undoAcceptance = await f.app.prepareAcceptance({ transactionId: undoPreview.transactionId });
  await f.app.applyTransaction({ transactionId: undoPreview.transactionId, confirmationToken: undoAcceptance.confirmationToken, idempotencyKey: 'undo-click' });
  assert.deepEqual(await readFile(path.join(f.source, 'main.tex')), f.before);
  assert.equal(f.app.getState().transactions.filter(item => item.state === 'applied').length, 2);
  assert.ok(f.app.getState().segments.some(item => item.id === f.segment.id));
  assert.equal(f.app.getState().translations['zh-CN'][f.segment.id].text, '保留作者的译文草稿。');
  assert.equal(f.app.getState().proposals.find(item => item.proposalId === f.proposal.proposalId).applicationState, 'reverted');
  assert.deepEqual(f.app.getState().originals[f.segment.id], immutableOriginal);
});
test('external edits after preview block acceptance without overwriting them', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'main.tex'), 'external edit');
  await assert.rejects(f.app.prepareAcceptance({ transactionId: f.preview.transactionId }), { code: 'VERSION_CONFLICT' });
  assert.equal(await readFile(path.join(f.source, 'main.tex'), 'utf8'), 'external edit');
});
test('external edits after applying block automatic undo', async t => {
  const f = await fixture(t);
  const accepted = await f.app.prepareAcceptance({ transactionId: f.preview.transactionId });
  await f.app.applyTransaction({ transactionId: f.preview.transactionId, confirmationToken: accepted.confirmationToken, idempotencyKey: 'apply' });
  await writeFile(path.join(f.source, 'main.tex'), 'later author edit');
  await assert.rejects(f.app.createUndoProposal({ transactionId: f.preview.transactionId }), { code: 'VERSION_CONFLICT' });
  assert.equal(await readFile(path.join(f.source, 'main.tex'), 'utf8'), 'later author edit');
});
