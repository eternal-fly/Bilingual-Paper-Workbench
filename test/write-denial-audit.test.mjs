import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { PaperApplication, buildInputHash } from '../src/application.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const parent = path.resolve('work/write-denial-audit'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'case-')), source = path.join(directory, 'source'); await mkdir(source);
  const originals = new Map([
    ['main.tex', Buffer.from('\\documentclass{article}\r\n\\begin{document}\r\n\r\nA clear first claim.\r\n\r\n\\input{second}\r\n\\end{document}\r\n')],
    ['second.tex', Buffer.from('A clear second claim.\r\n')],
  ]);
  for (const [name, bytes] of originals) await writeFile(path.join(source, name), bytes);
  const compiler = { probe: async () => ({ available: true, isolated: true }), build: async input => {
    const pdfPath = path.join(directory, `build-${randomUUID()}.pdf`), pdf = Buffer.from('%PDF-synthetic-write-denial-audit'); await writeFile(pdfPath, pdf);
    return { buildId: `build-${randomUUID()}`, status: 'success', snapshotId: input.snapshotId, candidateHash: input.candidateHash, inputHash: buildInputHash(input), pdfPath, pdfHash: sha(pdf), isolation: { verified: true } };
  } };
  const app = new PaperApplication({ dataRoot: path.join(directory, 'private'), compiler }); await app.initialize(); await app.openProject({ root: source, mainFile: 'main.tex' });
  const selected = app.getState().segments.filter(segment => segment.translatable && segment.displayText.includes('clear'));
  assert.equal(selected.length, 2);
  for (const segment of selected) await app.saveDraft({ segmentId: segment.id, language: 'zh-CN', text: `Author draft ${segment.path}.`, expectedRevision: 0 });
  const request = await app.createRequest({ kind: 'revision', segmentIds: selected.map(segment => segment.id), language: 'zh-CN' });
  const proposal = await app.proposeRevision({ requestId: request.requestId, edits: selected.map(segment => ({ segmentId: segment.id, beforeHash: segment.beforeHash, replacement: segment.displayText.replace('clear', 'explicit') })), reason: 'Clarify both claims.' });
  const preview = await app.previewTransaction({ proposalIds: [proposal.proposalId] }); await app.waitJob({ jobId: preview.jobId });
  const draft = structuredClone(app.getState().translations['zh-CN']);
  t.after(async () => {
    for (const filename of [path.join(source, 'second.tex'), path.join(app.core._store, 'state.json'), path.join(app.core._store, 'workflow.json')]) await chmod(filename, 0o666).catch(() => {});
    await app.close(); await Promise.allSettled([...app.jobs.values()].map(job => job.promise)); assert.ok(directory.startsWith(parent + path.sep)); await rm(directory, { recursive: true, force: true });
  });
  const unchanged = async () => { for (const [name, bytes] of originals) assert.deepEqual(await readFile(path.join(source, name)), bytes); assert.deepEqual(app.getState().translations['zh-CN'], draft); assert.ok(app.getState().proposals.every(item => item.applicationState !== 'applied')); };
  const confirmation = async (transactionId = preview.transactionId, idempotencyKey = 'write-denial') => ({ transactionId, ...(await app.prepareAcceptance({ transactionId })), idempotencyKey });
  return { app, directory, source, originals, selected, proposal, preview, draft, unchanged, confirmation };
}

function assertRebasedDrafts(f) {
  const state = f.app.getState(), sources = new Map([...state.segments, ...state.readingParagraphs].map(row => [row.id, row]));
  for (const [id, before] of Object.entries(f.draft)) {
    const after = state.translations['zh-CN'][id], source = sources.get(id);
    assert.equal(after.text, before.text); assert.equal(after.origin, before.origin);
    assert.equal(after.revision, before.revision + 1); assert.equal(after.status, 'saved');
    assert.equal(after.sourceHash, source.sourceHash || source.beforeHash);
  }
}

test('OS read-only denial is reported as permission denial before any source file changes; a fresh confirmed retry succeeds', async t => {
  const f = await fixture(t), target = path.join(f.source, 'second.tex'), input = await f.confirmation();
  await chmod(target, 0o444);
  try { await assert.rejects(f.app.applyTransaction(input), { code: 'PERMISSION_DENIED' }); await f.unchanged(); assert.equal(f.app.getState().transactions.find(tx => tx.transactionId === input.transactionId).state, 'conflict'); }
  finally { await chmod(target, 0o666); }
  await assert.rejects(f.app.applyTransaction(input), { code: 'CONFIRMATION_INVALID' });
  const preview = await f.app.previewTransaction({ proposalIds: [f.proposal.proposalId] }); await f.app.waitJob({ jobId: preview.jobId });
  const result = await f.app.applyTransaction(await f.confirmation(preview.transactionId, 'permission-restored'));
  assert.equal(result.state, 'applied'); for (const name of f.originals.keys()) assert.match(await readFile(path.join(f.source, name), 'utf8'), /explicit/);
  assertRebasedDrafts(f);
});

test('private-state OS persistence denial preserves the saved author draft and permits exact-revision retry', async t => {
  const f = await fixture(t), filename = path.join(f.app.core._store, 'state.json'), segmentId = f.selected[0].id, before = await readFile(filename);
  await chmod(filename, 0o444);
  try { await assert.rejects(f.app.saveDraft({ segmentId, language: 'zh-CN', text: 'New unsaved author intent.', expectedRevision: 1 }), error => ['EACCES', 'EPERM'].includes(error.code)); await f.unchanged(); assert.deepEqual(await readFile(filename), before); }
  finally { await chmod(filename, 0o666); }
  await f.app.saveDraft({ segmentId, language: 'zh-CN', text: 'New unsaved author intent.', expectedRevision: 1 });
  assert.equal(f.app.getState().translations['zh-CN'][segmentId].revision, 2); assert.equal(f.app.getState().translations['zh-CN'][segmentId].text, 'New unsaved author intent.');
});

test('workflow journal OS denial prevents the writer from starting and an exact confirmed retry remains safe', async t => {
  const f = await fixture(t), filename = path.join(f.app.core._store, 'workflow.json'), input = await f.confirmation(); let calls = 0;
  const write = f.app.writer.write.bind(f.app.writer); f.app.writer.write = async (...args) => { calls++; return write(...args); };
  await chmod(filename, 0o444);
  try { await assert.rejects(f.app.applyTransaction(input), error => ['EACCES', 'EPERM'].includes(error.code)); assert.equal(calls, 0); await f.unchanged(); const durable = JSON.parse(await readFile(filename, 'utf8')); assert.equal(durable.transactions.find(tx => tx.transactionId === input.transactionId).state, 'ready'); }
  finally { await chmod(filename, 0o666); }
  assert.equal((await f.app.applyTransaction(input)).state, 'applied'); assert.equal(calls, 1); assertRebasedDrafts(f);
});

test('a dependency race after confirmation preserves external content and never writes an earlier candidate file', async t => {
  const f = await fixture(t), input = await f.confirmation(), target = path.join(f.source, 'second.tex'), later = Buffer.from('Later external author edit.\r\n'), write = f.app.writer.write.bind(f.app.writer);
  f.app.writer.write = async (...args) => { await writeFile(target, later); return write(...args); };
  await assert.rejects(f.app.applyTransaction(input), { code: 'VERSION_CONFLICT' });
  assert.deepEqual(await readFile(path.join(f.source, 'main.tex')), f.originals.get('main.tex')); assert.deepEqual(await readFile(target), later);
  assert.deepEqual(f.app.getState().translations['zh-CN'], f.draft); assert.ok(f.app.getState().proposals.every(item => item.applicationState !== 'applied'));
  assert.equal(f.app.getState().transactions.find(tx => tx.transactionId === input.transactionId).state, 'conflict');
});

test('journal denial after a durable first-file write never reports applied and recovers only the remaining exact source bytes', async t => {
  const f = await fixture(t), filename = path.join(f.app.core._store, 'workflow.json'), input = await f.confirmation(), write = f.app.writer.write.bind(f.app.writer);
  f.app.writer.write = async (request, callbacks) => write(request, { ...callbacks, onLocked: async event => { await callbacks.onLocked(event); await chmod(filename, 0o444); } });
  try {
    await assert.rejects(f.app.applyTransaction(input), error => ['EACCES', 'EPERM'].includes(error.code));
    assert.match(await readFile(path.join(f.source, 'main.tex'), 'utf8'), /explicit/); assert.deepEqual(await readFile(path.join(f.source, 'second.tex')), f.originals.get('second.tex'));
    assert.equal(f.app.getState().transactions.find(tx => tx.transactionId === input.transactionId).state, 'recoveryRequired');
    assert.equal(JSON.parse(await readFile(filename, 'utf8')).transactions.find(tx => tx.transactionId === input.transactionId).state, 'committing');
    assert.deepEqual(f.app.getState().translations['zh-CN'], f.draft); assert.ok(f.app.getState().proposals.every(item => item.applicationState !== 'applied'));
  } finally { await chmod(filename, 0o666); f.app.writer.write = write; }
  await assert.rejects(f.app.applyTransaction(input), { code: 'CONFIRMATION_INVALID' });
  const recovered = await f.app.recoverTransactions(); assert.equal(recovered.recovered[0].state, 'applied');
  for (const name of f.originals.keys()) assert.match(await readFile(path.join(f.source, name), 'utf8'), /explicit/);
  assertRebasedDrafts(f);
});
