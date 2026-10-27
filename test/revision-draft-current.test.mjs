import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PaperApplication, buildInputHash } from '../src/application.mjs';
import { sha256 } from '../src/latex.mjs';

async function fixture(t, { derived = false } = {}) {
  const owned = path.resolve('work/revision-draft-current-tests'); await mkdir(owned, { recursive: true });
  const directory = await mkdtemp(path.join(owned, 'case-')), root = path.join(directory, 'source'); await mkdir(root);
  const source = '\\documentclass{article}\n\\begin{document}\n' + (derived ? '\\def\\unrelated{opaque}\n' : '') + '\nA clear claim uses precise assumptions.\n\n\\end{document}\n';
  const filename = path.join(root, 'main.tex'); await writeFile(filename, source);
  const compiler = { probe: async () => ({ available: true, isolated: true }), build: async input => {
    const pdfPath = path.join(directory, `${randomUUID()}.pdf`); await writeFile(pdfPath, '%PDF-synthetic-current-draft-test');
    return { buildId: `build-${randomUUID()}`, status: 'success', snapshotId: input.snapshotId, candidateHash: input.candidateHash, inputHash: buildInputHash(input), pdfPath, pdfHash: sha256(await readFile(pdfPath)), isolation: { verified: true } };
  } };
  const app = new PaperApplication({ dataRoot: path.join(directory, 'private'), compiler }); await app.initialize(); await app.openProject({ root, mainFile: 'main.tex' });
  t.after(async () => { await app.close(); assert(directory.startsWith(owned + path.sep)); await rm(directory, { recursive: true, force: true }); });
  const paragraph = app.getState().readingParagraphs.find(p => p.source.includes('A clear claim')); assert(paragraph?.writableSource);
  assert.equal(app.reading.hasDerived(paragraph.id), derived);
  const save = async text => app.saveDraft({ segmentId: paragraph.id, language: 'zh-CN', text, expectedRevision: app.getState().translations['zh-CN']?.[paragraph.id]?.revision || 0 });
  await save('作者已审查的清楚表述。');
  const request = await app.createRequest({ kind: 'revision', segmentIds: [paragraph.id], language: 'zh-CN' });
  const submit = () => app.proposeRevision({ requestId: request.requestId, reason: 'Use the reviewed author text.', edits: [{ segmentId: paragraph.id, beforeHash: request.segments[0].beforeHash, replacement: request.segments[0].text.replace('clear', 'explicit') }] });
  const compile = async proposal => { const preview = await app.previewTransaction({ proposalIds: [proposal.proposalId] }); await app.waitJob(preview); return preview; };
  return { app, filename, source, paragraph, request, submit, compile, save };
}

for (const derived of [false, true]) {
  const kind = derived ? 'reading-range' : 'canonical';
  test(`${kind} prose edited after its request cannot publish an obsolete English proposal`, async t => {
    const f = await fixture(t, { derived }); await f.save('作者更新了中文限定条件。');
    await assert.rejects(f.submit(), { code: 'VERSION_CONFLICT' });
    assert.equal(f.app.getState().proposals.length, 0); assert.equal(await readFile(f.filename, 'utf8'), f.source);
  });
  test(`${kind} prose edited after its proposal cannot compile an obsolete candidate`, async t => {
    const f = await fixture(t, { derived }), proposal = await f.submit(); await f.save('作者更新了中文限定条件。');
    await assert.rejects(f.compile(proposal), { code: 'VERSION_CONFLICT' });
    assert.equal(f.app.getState().transactions.length, 0); assert.equal(await readFile(f.filename, 'utf8'), f.source);
  });
  test(`${kind} prose edited after compilation invalidates approval and a previously issued source-write token`, async t => {
    const f = await fixture(t, { derived }), proposal = await f.submit(), preview = await f.compile(proposal), acceptance = await f.app.prepareAcceptance(preview);
    await f.save('作者更新了中文限定条件。');
    await assert.rejects(f.app.prepareAcceptance(preview), { code: 'VERSION_CONFLICT' });
    await assert.rejects(f.app.applyTransaction({ transactionId: preview.transactionId, confirmationToken: acceptance.confirmationToken, idempotencyKey: 'obsolete-prose' }), { code: 'VERSION_CONFLICT' });
    assert.equal(await readFile(f.filename, 'utf8'), f.source);
  });
}

test('unchanged current prose writes once, retries idempotently and remains reversible', async t => {
  const f = await fixture(t), proposal = await f.submit(), preview = await f.compile(proposal), acceptance = await f.app.prepareAcceptance(preview);
  const input = { transactionId: preview.transactionId, confirmationToken: acceptance.confirmationToken, idempotencyKey: 'reviewed-current-prose' };
  await f.app.applyTransaction(input); await f.save('写回后继续编辑的下一版中文。');
  assert.equal((await f.app.applyTransaction(input)).idempotent, true);
  const inverse = await f.app.createUndoProposal(preview), undo = await f.compile(inverse), undoAcceptance = await f.app.prepareAcceptance(undo);
  await f.app.applyTransaction({ transactionId: undo.transactionId, confirmationToken: undoAcceptance.confirmationToken, idempotencyKey: 'reviewed-current-prose-undo' });
  assert.equal(await readFile(f.filename, 'utf8'), f.source);
});

test('the complete saved prose is checked even if persisted draft text changes without a revision increment', async t => {
  const f = await fixture(t), proposal = await f.submit(), preview = await f.compile(proposal), next = f.app.core.getState();
  next.translations['zh-CN'][f.paragraph.id].text = 'A changed persisted draft must not retain old approval.'; await f.app.core._commit(next);
  await assert.rejects(f.app.prepareAcceptance(preview), { code: 'VERSION_CONFLICT' }); assert.equal(await readFile(f.filename, 'utf8'), f.source);
});

test('a change in the second aligned translation unit revokes its complete English candidate', async t => {
  const f = await fixture(t); await f.app.splitTranslation({ segmentId: f.paragraph.id, language: 'zh-CN', splitAt: 5, expectedRevision: 1 });
  const request = await f.app.createRequest({ kind: 'revision', segmentIds: [f.paragraph.id], language: 'zh-CN' });
  assert.equal(request.segments[0].translationDraft.translationUnitIds.length, 2);
  const proposal = await f.app.proposeRevision({ requestId: request.requestId, reason: 'Use both saved translation units.', edits: [{ segmentId: f.paragraph.id, beforeHash: request.segments[0].beforeHash, replacement: request.segments[0].text.replace('clear', 'explicit') }] }), preview = await f.compile(proposal);
  const splitId = request.segments[0].translationDraft.translationUnitIds[1];
  await f.app.saveDraft({ segmentId: splitId, language: 'zh-CN', text: '更新第二个译文单元。', expectedRevision: 1 });
  await assert.rejects(f.app.prepareAcceptance(preview), { code: 'VERSION_CONFLICT' }); assert.equal(await readFile(f.filename, 'utf8'), f.source);
});

test('a source-only manually authored proposal does not acquire a nonexistent translation prerequisite', async t => {
  const f = await fixture(t), modelProposal = await f.submit(), next = f.app.core.getState(), manual = { ...structuredClone(modelProposal), proposalId: `proposal-${randomUUID()}`, author: 'human', context: {} };
  next.proposals.push(manual); await f.app.core._commit(next); await f.save('与手工英文修改独立的中文草稿。');
  const preview = await f.compile(manual), acceptance = await f.app.prepareAcceptance(preview);
  await f.app.applyTransaction({ transactionId: preview.transactionId, confirmationToken: acceptance.confirmationToken, idempotencyKey: 'manual-source-only' });
  assert.match(await readFile(f.filename, 'utf8'), /A explicit claim/);
});
