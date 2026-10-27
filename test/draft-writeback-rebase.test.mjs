import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PaperApplication, buildInputHash } from '../src/application.mjs';
import { sha256 } from '../src/latex.mjs';
import { deriveEnglishWriteback } from '../ui/writeback-state.mjs';

async function fixture(t, derived = false) {
  const parent = path.resolve('work/draft-writeback-rebase'); await mkdir(parent, { recursive: true }); const temp = await mkdtemp(path.join(parent, 'case-')), root = path.join(temp, 'source'); await mkdir(root);
  const original = '\\documentclass{article}\n\\begin{document}\n\n' + (derived ? '\\def\\unrelated{opaque}\n\n' : '') + 'A precise claim uses $x=1$ and \\cite{A}; see \\eqref{eq:one}.\n\nA separate claim uses $y=2$.\n\n\\begin{equation}a=1\\label{eq:one}\\end{equation}\n\n\\begin{equation}b=2\\label{eq:two}\\end{equation}\n\\bibliography{refs}\n\\end{document}\n';
  await writeFile(path.join(root, 'main.tex'), original); await writeFile(path.join(root, 'refs.bib'), '@article{A,title={Alpha}}\n@article{B,title={Beta}}\n');
  const compiler = { probe: async () => ({ available: true, isolated: true }), build: async input => { const pdfPath = path.join(temp, `build-${randomUUID()}.pdf`); await writeFile(pdfPath, '%PDF-synthetic-draft-rebase-test'); return { buildId: `build-${randomUUID()}`, status: 'success', snapshotId: input.snapshotId, candidateHash: input.candidateHash, inputHash: buildInputHash(input), pdfPath, pdfHash: sha256(await readFile(pdfPath)), isolation: { verified: true } }; } };
  const app = new PaperApplication({ dataRoot: path.join(temp, 'private'), compiler }); await app.initialize(); await app.openProject({ root, mainFile: 'main.tex' });
  t.after(async () => { await app.close(); await Promise.allSettled([...app.jobs.values()].map(job => job.promise)); await rm(temp, { recursive: true, force: true }); });
  const paragraph = app.getState().readingParagraphs.find(row => row.source.includes('A precise claim')), other = app.getState().readingParagraphs.find(row => row.source.includes('A separate claim'));
  assert.equal(app.reading.hasDerived(paragraph.id), derived);
  const initial = String.raw`精确结论使用 $x=1$ 和 \cite{A}；见 \eqref{eq:one}。`; await app.saveDraft({ segmentId: paragraph.id, language: 'zh-CN', text: initial, expectedRevision: 0 });
  const current = id => app.getState().translations['zh-CN'][id || paragraph.id];
  const save = (text, id = paragraph.id) => app.saveTranslationDraftWithFormulaEdits({ segmentId: id, language: 'zh-CN', text, expectedRevision: current(id).revision, expectedProjectId: app.getState().project.id, expectedSnapshotId: app.getState().project.snapshotId });
  return { app, root, original, paragraph, other, initial, current, save };
}
async function apply(f, proposal) { const preview = await f.app.previewTransaction({ proposalIds: [proposal.proposalId] }); await f.app.waitJob({ jobId: preview.jobId }); const grant = await f.app.prepareAcceptance({ transactionId: preview.transactionId }); const result = await f.app.applyTransaction({ transactionId: preview.transactionId, confirmationToken: grant.confirmationToken, idempotencyKey: `apply-${randomUUID()}` }); if (result.englishPdfJobId) await f.app.waitJob({ jobId: result.englishPdfJobId }); return result; }
async function candidate(f, id = f.paragraph.id) { const source = f.app.getState().readingParagraphs.find(row => row.id === id), request = await f.app.createRequest({ kind: 'revision', language: 'zh-CN', segmentIds: [id] }); return f.app.proposeRevision({ requestId: request.requestId, reason: 'Apply the saved author intent.', edits: [{ segmentId: id, beforeHash: source.sourceHash, replacement: request.segments[0].text.replace('precise', 'explicit') }] }); }

for (const derived of [false, true]) test(`accepted ${derived ? 'derived' : 'canonical'} source supports a second formula/reference editing and writeback cycle`, async t => {
  const f = await fixture(t, derived), firstText = f.initial.replace('$x=1$', '$x=4$').replace(String.raw`\cite{A}`, String.raw`\cite{B}`).replace(String.raw`\eqref{eq:one}`, String.raw`\eqref{eq:two}`);
  await f.save(firstText); const beforeRevision = f.current().revision, first = await apply(f, await candidate(f));
  assert.equal(first.state, 'applied'); assert.equal(deriveEnglishWriteback(f.app.getState(), 'zh-CN').mode, 'empty'); const nextText = firstText.replace('$x=4$', '$x=7$').replace(String.raw`\cite{B}`, String.raw`\cite{A}`);
  await f.save(nextText);
  assert(f.current().revision > beforeRevision); const second = await apply(f, await candidate(f));
  assert.equal(second.state, 'applied'); assert.equal(f.current().text, nextText); assert.equal(f.current().sourceHash, f.app.getState().readingParagraphs.find(row => row.id === f.paragraph.id).sourceHash); assert.equal(f.current().status, 'saved');
  assert.equal(deriveEnglishWriteback(f.app.getState(), 'zh-CN').mode, 'empty');
  const text = await readFile(path.join(f.root, 'main.tex'), 'utf8'); assert(text.includes('$x=7$')); assert(text.includes(String.raw`\cite{A}`)); assert(text.includes(String.raw`\eqref{eq:two}`)); assert(text.includes(String.raw`\label{eq:one}`));
  const latest = f.app.getState().builds.find(row => row.buildId === f.app.flow.lastEnglishBuildId); assert(latest); assert.equal(latest.promotedSnapshotId || latest.snapshotId, f.app.getState().project.snapshotId);
});

test('an unrelated accepted paragraph re-epochs valid pending math without adopting or losing that pending edit', async t => {
  const f = await fixture(t); await f.app.saveDraft({ segmentId: f.other.id, language: 'zh-CN', text: '另一结论使用 $y=2$。', expectedRevision: 0 });
  await f.save('另一结论使用 $y=8$。', f.other.id); const pending = f.current(f.other.id), snapshot = f.app.getState().project.snapshotId;
  await f.save(f.initial.replace('$x=1$', '$x=4$')); await apply(f, await candidate(f));
  assert.notEqual(f.app.getState().project.snapshotId, snapshot); assert.equal(f.current(f.other.id).text, pending.text); assert.equal(f.current(f.other.id).formulaEdits[0].replacement, '$y=8$'); assert.equal(f.current(f.other.id).formulaEdits[0].snapshotId, f.app.getState().project.snapshotId);
  assert.deepEqual(deriveEnglishWriteback(f.app.getState(), 'zh-CN').sourceIds, [f.other.id]);
  await f.save('另一结论使用 $y=9$。', f.other.id); await apply(f, await candidate(f, f.other.id)); assert((await readFile(path.join(f.root, 'main.tex'), 'utf8')).includes('$y=9$')); assert.equal(deriveEnglishWriteback(f.app.getState(), 'zh-CN').mode, 'empty');
});

test('a confirmed full-paragraph formula inventory becomes the next editable baseline without retaining the old unmapped flag', async t => {
  const f = await fixture(t, true), text = f.initial.replace('$x=1$', '$z=3$ 与 $x=4$'); await f.save(text); assert(f.current().formulaEditUnmapped);
  const request = await f.app.createRequest({ kind: 'revision', language: 'zh-CN', segmentIds: [f.paragraph.id] }); assert(request.segments[0].paragraphMathIntent);
  const tokens = request.segments[0].protectedTokens.map(row => row.id), proposal = await f.app.proposeRevision({ requestId: request.requestId, reason: 'Apply the complete author mathematical inventory.', edits: [{ segmentId: f.paragraph.id, beforeHash: f.paragraph.sourceHash, replacement: `A clear claim uses ${tokens[0]} and ${tokens[1]} with ${tokens[2]}; see ${tokens[3]}.` }] });
  await apply(f, proposal); assert.equal(f.current().text, text); assert(!f.current().formulaEditUnmapped); assert(!f.current().formulaEditsConflict);
  await f.save(text.replace('$z=3$', '$z=6$')); assert.equal(f.current().formulaEdits[0].beforeRaw, '$z=3$'); await apply(f, await candidate(f)); assert((await readFile(path.join(f.root, 'main.tex'), 'utf8')).includes('$z=6$'));
});

test('a confirmed unchanged English candidate acknowledges the exact author draft without leaving a redundant writeback', async t => {
  const f = await fixture(t), request = await f.app.createRequest({ kind: 'revision', language: 'zh-CN', segmentIds: [f.paragraph.id] }), snapshot = f.app.getState().project.snapshotId;
  const proposal = await f.app.proposeRevision({ requestId: request.requestId, reason: 'The reviewed English wording already expresses this author draft.', edits: [{ segmentId: f.paragraph.id, beforeHash: f.paragraph.sourceHash, replacement: request.segments[0].text }] }); await apply(f, proposal);
  assert.equal(f.app.getState().project.snapshotId, snapshot); assert.equal(f.current().sourceWritebackReceipt.revision, f.current().revision); assert.equal(deriveEnglishWriteback(f.app.getState(), 'zh-CN').mode, 'empty'); assert.equal(await readFile(path.join(f.root, 'main.tex'), 'utf8'), f.original);
});

test('undo restores only the exact prior pending draft intent with monotonic revisions and keeps its text editable', async t => {
  const f = await fixture(t); const text = f.initial.replace('$x=1$', '$x=4$').replace(String.raw`\cite{A}`, String.raw`\cite{B}`); await f.save(text);
  const applied = await apply(f, await candidate(f)), revision = f.current().revision; const undo = await f.app.createUndoProposal({ transactionId: applied.transactionId }); await apply(f, undo);
  assert.equal(await readFile(path.join(f.root, 'main.tex'), 'utf8'), f.original); assert.equal(f.current().text, text); assert(f.current().revision > revision); assert.equal(f.current().formulaEdits[0].beforeRaw, '$x=1$'); assert.equal(f.current().formulaEdits[0].replacement, '$x=4$');
  assert.notEqual(deriveEnglishWriteback(f.app.getState(), 'zh-CN').mode, 'empty');
  await f.save(text.replace('$x=4$', '$x=5$')); await apply(f, await candidate(f)); assert((await readFile(path.join(f.root, 'main.tex'), 'utf8')).includes('$x=5$'));
});

test('undo never replaces a newer human translation with the older transaction draft', async t => {
  const f = await fixture(t, true); await f.save(f.initial.replace('$x=1$', '$x=4$')); const applied = await apply(f, await candidate(f));
  const newer = f.current().text.replace('$x=4$', '$x=9$') + ' 作者新增说明。'; await f.save(newer); const revision = f.current().revision; await apply(f, await f.app.createUndoProposal({ transactionId: applied.transactionId }));
  assert.equal(f.current().text, newer); assert.equal(f.current().revision, revision); assert.equal(f.current().status, 'stale'); assert.equal(await readFile(path.join(f.root, 'main.tex'), 'utf8'), f.original);
});

for (const conflicted of [false, true]) test(`legacy ${conflicted ? 'conflicted-current-hash' : 'stale-source-hash'} saved drafts repair only from exact accepted request evidence`, async t => {
  const f = await fixture(t, true), text = f.initial.replace('$x=1$', '$x=4$').replace(String.raw`\cite{A}`, String.raw`\cite{B}`); await f.save(text); const old = structuredClone(f.current()); const applied = await apply(f, await candidate(f));
  await f.app._flowAction(() => { delete f.app.flow.transactions.find(row => row.transactionId === applied.transactionId).draftRebases; });
  await f.app.core._serial(async () => { const state = f.app.core.getState(), namespace = state.readingDrafts?.['zh-CN']?.[f.paragraph.id] ? 'readingDrafts' : 'translations'; state[namespace]['zh-CN'][f.paragraph.id] = { ...old, status: 'stale', ...(conflicted ? { sourceHash: f.app.getState().readingParagraphs.find(row => row.id === f.paragraph.id).sourceHash, formulaEditsConflict: true, referenceEditsConflict: true } : {}) }; await f.app.core._commit(state); });
  // Keep this exact accepted legacy draft unchanged for the explicit repair.
  // New human text is durably saved as deferred intent by the free-draft API.
  const input = { segmentId: f.paragraph.id, language: 'zh-CN', expectedRevision: f.current().revision, expectedProjectId: f.app.getState().project.id, expectedSnapshotId: f.app.getState().project.snapshotId }, result = await f.app.reconcileTranslationDraft(input);
  assert.equal(result.repaired, true); assert.equal(f.current().text, text); assert.equal(f.current().sourceHash, f.app.getState().readingParagraphs.find(row => row.id === f.paragraph.id).sourceHash); assert(!f.current().formulaEditsConflict); assert(!f.current().referenceEdits?.length);
  assert.equal(deriveEnglishWriteback(f.app.getState(), 'zh-CN').mode, 'empty');
  const retry = await f.app.reconcileTranslationDraft({ ...input, expectedRevision: f.current().revision }); assert.equal(retry.repaired, false); assert.equal(retry.draft.revision, result.draft.revision);
  await f.save(text.replace('$x=4$', '$x=6$')); await apply(f, await candidate(f)); assert((await readFile(path.join(f.root, 'main.tex'), 'utf8')).includes('$x=6$'));
  assert(f.app.getState().transactions.every(row => !Object.hasOwn(row, 'draftRebases')));
});

test('legacy repair rejects unproven newer content and stale caller revisions without changing paper or draft text', async t => {
  const f = await fixture(t), text = f.initial.replace('$x=1$', '$x=4$'); await f.save(text); const before = structuredClone(f.current()); const applied = await apply(f, await candidate(f));
  await f.app._flowAction(() => { delete f.app.flow.transactions.find(row => row.transactionId === applied.transactionId).draftRebases; });
  await f.app.core._serial(async () => { const state = f.app.core.getState(); state.translations['zh-CN'][f.paragraph.id] = { ...before, text: before.text + ' 未确认的新语句。', revision: before.revision + 1, status: 'stale' }; await f.app.core._commit(state); });
  const input = { segmentId: f.paragraph.id, language: 'zh-CN', expectedRevision: f.current().revision, expectedProjectId: f.app.getState().project.id, expectedSnapshotId: f.app.getState().project.snapshotId }, saved = f.current(), bytes = await readFile(path.join(f.root, 'main.tex'));
  await assert.rejects(f.app.reconcileTranslationDraft({ ...input, expectedRevision: input.expectedRevision - 1 }), { code: 'VERSION_CONFLICT' }); await assert.rejects(f.app.reconcileTranslationDraft(input), { code: 'VERSION_CONFLICT' }); assert.deepEqual(f.current(), saved); assert.deepEqual(await readFile(path.join(f.root, 'main.tex')), bytes);
});

test('identical text at a newer draft revision does not let legacy repair clear a later human intent state', async t => {
  const f = await fixture(t); await f.save(f.initial.replace('$x=1$', '$x=4$')); const legacy = structuredClone(f.current()), applied = await apply(f, await candidate(f));
  await f.app._flowAction(() => { delete f.app.flow.transactions.find(row => row.transactionId === applied.transactionId).draftRebases; });
  await f.app.core._serial(async () => { const state = f.app.core.getState(); state.translations['zh-CN'][f.paragraph.id] = { ...legacy, revision: legacy.revision + 1, formulaEditsConflict: true, status: 'stale' }; await f.app.core._commit(state); });
  const before = structuredClone(f.current()); await assert.rejects(f.app.reconcileTranslationDraft({ segmentId: f.paragraph.id, language: 'zh-CN', expectedRevision: before.revision, expectedProjectId: f.app.getState().project.id, expectedSnapshotId: f.app.getState().project.snapshotId }), { code: 'VERSION_CONFLICT' }); assert.deepEqual(f.current(), before);
});

test('a durable prepared draft rebase replays after a commit interruption without a duplicate revision increment', async t => {
  const f = await fixture(t); await f.save(f.initial.replace('$x=1$', '$x=4$')); const revision = f.current().revision, proposal = await candidate(f), commit = f.app.core._commit.bind(f.app.core); let denied = false;
  f.app.core._commit = async state => { if (!denied && state.project.snapshotId !== proposal.baseSnapshotId && state.translations?.['zh-CN']?.[f.paragraph.id]?.revision === revision + 1) { denied = true; throw Object.assign(new Error('Synthetic draft commit interruption'), { code: 'SYNTHETIC_DRAFT_COMMIT' }); } return commit(state); };
  await assert.rejects(apply(f, proposal), { code: 'SYNTHETIC_DRAFT_COMMIT' }); f.app.core._commit = commit;
  const transaction = f.app.flow.transactions.at(-1); assert.equal(transaction.draftRebases.rows.length, 1); const recovered = await f.app.recoverTransactions(); assert.equal(recovered.recovered[0].state, 'applied'); assert.equal(f.current().revision, revision + 1);
  await f.app._flowAction(() => f.app._recordApplied(f.app.flow.transactions.find(row => row.transactionId === transaction.transactionId))); assert.equal(f.current().revision, revision + 1);
  await f.save(f.current().text.replace('$x=4$', '$x=5$'));
});

test('an interrupted explicit legacy repair retries its already proved metadata transition exactly once', async t => {
  const f = await fixture(t); await f.save(f.initial.replace('$x=1$', '$x=4$')); const legacy = structuredClone(f.current()), applied = await apply(f, await candidate(f));
  await f.app._flowAction(() => { delete f.app.flow.transactions.find(row => row.transactionId === applied.transactionId).draftRebases; });
  await f.app.core._serial(async () => { const state = f.app.core.getState(); state.translations['zh-CN'][f.paragraph.id] = { ...legacy, status: 'stale' }; await f.app.core._commit(state); });
  const input = { segmentId: f.paragraph.id, language: 'zh-CN', expectedRevision: legacy.revision, expectedProjectId: f.app.getState().project.id, expectedSnapshotId: f.app.getState().project.snapshotId }, commit = f.app.core._commit.bind(f.app.core); let failed = false;
  f.app.core._commit = async state => { if (!failed && state.translations['zh-CN'][f.paragraph.id].revision === legacy.revision + 1) { failed = true; throw Object.assign(new Error('Synthetic interrupted repair'), { code: 'SYNTHETIC_REPAIR_INTERRUPTED' }); } return commit(state); };
  await assert.rejects(f.app.reconcileTranslationDraft(input), { code: 'SYNTHETIC_REPAIR_INTERRUPTED' }); f.app.core._commit = commit;
  const repaired = await f.app.reconcileTranslationDraft(input); assert.equal(repaired.repaired, true); assert.equal(f.current().revision, legacy.revision + 1); assert.equal(f.current().text, legacy.text);
});
