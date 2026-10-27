import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deriveReviewImportValidation, validateExternalReviewNote } from '../src/review-import-validation.mjs';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PaperApplication, buildInputHash } from '../src/application.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPaperServer } from '../src/server.mjs';
import { startLocalWeb } from '../src/local-web.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
function fixture() {
  const paragraphs = ['a', 'b', 'c'].map(id => ({ id, source: `Original precise paragraph ${id}.`, sourceHash: hash(id), path: 'main.tex' }));
  const notes = paragraphs.slice(0, 2).map((p, index) => ({ noteId: `note-${index}`, origin: 'external', batchId: 'batch', revision: 1, sourceSnapshotId: 'old', sourceSegmentIds: [p.id], sourceHashes: { [p.id]: p.sourceHash }, body: 'An unchanged imported concern.', decision: 'keep' }));
  const state = { project: { id: 'project', snapshotId: 'new' }, readingParagraphs: paragraphs, reviewNotes: notes, reviewBatches: [{ batchId: 'batch', origin: 'external', status: 'completed', revision: 1, fileHash: hash('review'), sourceSnapshotId: 'old' }] };
  return { state, notes, paragraphs };
}
test('changing paragraph A preserves exact-ID/hash validation of opinion B despite the old import snapshot', () => {
  const f = fixture(); f.paragraphs[0].sourceHash = hash('changed a');
  const result = deriveReviewImportValidation(f.state, f.state).batches[0];
  assert.equal(result.currentCount, 1); assert.equal(result.changedCount, 1); assert.equal(result.notes[0].status, 'changed'); assert.equal(result.notes[1].status, 'current');
  assert.deepEqual(result.notes[1].verifiedSourceSegmentIds, ['b']); assert.equal(result.importSnapshotId, 'old');
});
test('a multi-paragraph opinion remains unverified when any one linked hash changes', () => {
  const f = fixture(); f.notes[0].sourceSegmentIds = ['a', 'b']; f.notes[0].sourceHashes.b = f.paragraphs[1].sourceHash; f.paragraphs[0].sourceHash = hash('changed');
  const checked = validateExternalReviewNote(f.notes[0], f.state); assert.equal(checked.status, 'changed'); assert.deepEqual(checked.verifiedSourceSegmentIds, []);
});
test('only missing IDs can relocate by one unique exact hash and duplicate/colliding targets stay ambiguous', () => {
  const f = fixture(), note = f.notes[0]; f.paragraphs[0].id = 'new-a'; assert.equal(validateExternalReviewNote(note, f.state).status, 'relocatable');
  f.paragraphs.push({ ...f.paragraphs[0], id: 'duplicate' }); assert.equal(validateExternalReviewNote(note, f.state).status, 'ambiguous');
  f.paragraphs.pop(); note.sourceSegmentIds.push('another-missing'); note.sourceHashes['another-missing'] = note.sourceHashes.a; assert.equal(validateExternalReviewNote(note, f.state).status, 'ambiguous');
  note.sourceSegmentIds = ['a']; f.paragraphs.unshift({ id: 'a', sourceHash: hash('changed') }); assert.equal(validateExternalReviewNote(note, f.state).status, 'changed');
});
test('missing and unlocated opinions never gain a verified anchor, and validation is read-only', () => {
  const f = fixture(); const before = structuredClone(f.state); assert.equal(validateExternalReviewNote({ ...f.notes[0], sourceSegmentIds: [], sourceHashes: {} }, f.state).status, 'unlocated');
  assert.equal(validateExternalReviewNote({ ...f.notes[0], sourceSegmentIds: ['absent'], sourceHashes: { absent: hash('not in source') } }, f.state).status, 'missing');
  deriveReviewImportValidation(f.state, f.state); assert.deepEqual(f.state, before);
});

async function liveFixture(t, { adoptBeforeWrite = false, partialAdopt = false } = {}) {
  const owned = path.resolve('work/review-import-revalidation-tests'); await mkdir(owned, { recursive: true });
  const directory = await mkdtemp(path.join(owned, 'case-')), root = path.join(directory, 'source'); await mkdir(root);
  const filename = path.join(root, 'main.tex'), source = '\\documentclass{article}\n\\begin{document}\n\nThe first precise claim states an explicit bounded assumption.\n\nThe second separate paragraph gives an unchanged exact conclusion.\n\n\\end{document}\n'; await writeFile(filename, source);
  const compiler = { probe: async () => ({ available: true, isolated: true }), build: async input => { const pdfPath = path.join(directory, `${randomUUID()}.pdf`); await writeFile(pdfPath, '%PDF-synthetic-review-validation'); return { buildId: `build-${randomUUID()}`, status: 'success', snapshotId: input.snapshotId, candidateHash: input.candidateHash, inputHash: buildInputHash(input), pdfPath, pdfHash: hash(await readFile(pdfPath)), isolation: { verified: true } }; } };
  const app = new PaperApplication({ dataRoot: path.join(directory, 'private'), compiler }); await app.initialize(); await app.openProject({ root, mainFile: 'main.tex' });
  t.after(async () => { await app.close(); assert(directory.startsWith(owned + path.sep)); await rm(directory, { recursive: true, force: true }); });
  const paragraphs = app.getState().readingParagraphs;
  const uploaded = await app.importReviewNotes({ filename: 'external-review.json', format: 'json', fileHash: hash('immutable external original review'), text: JSON.stringify({ notes: [{ body: 'Clarify the first condition.', quote: paragraphs[0].source }, { body: 'Preserve the second conclusion.', quote: paragraphs[1].source }, { body: 'An unlocated imported concern.' }] }) });
  if (partialAdopt) await app.core._serial(async () => { const next = app.core.getState(), note = next.reviewNotes[0]; note.sourceSegmentIds.push(paragraphs[1].id); note.sourceHashes[paragraphs[1].id] = paragraphs[1].sourceHash; await app.core._commit(next); });
  if (adoptBeforeWrite) await app.setReviewDecision({ noteId: uploaded.notes[0].noteId, expectedRevision: uploaded.notes[0].revision, decision: 'adopt' });
  else await app.core._serial(async () => { const next = app.core.getState(); next.reviewNotes[0].decision = 'adopt'; next.reviewNotes[0].decisionSnapshotId = next.project.snapshotId; await app.core._commit(next); });
  const initial = app.core.getState(), request = await app.createRequest({ kind: 'revision', segmentIds: [paragraphs[0].id], language: 'zh-CN' }), proposal = await app.proposeRevision({ requestId: request.requestId, reason: 'Change only the first paragraph.', edits: [{ segmentId: paragraphs[0].id, beforeHash: request.segments[0].beforeHash, replacement: request.segments[0].text.replace('precise', 'revised') }] }), preview = await app.previewTransaction({ proposalIds: [proposal.proposalId] }); await app.waitJob(preview);
  const acceptance = await app.prepareAcceptance(preview); await app.applyTransaction({ transactionId: preview.transactionId, confirmationToken: acceptance.confirmationToken, idempotencyKey: 'synthetic-review-source-apply' });
  const before = app.core.getState(), input = { batchId: uploaded.batch.batchId, expectedRevision: 1, expectedFileHash: uploaded.batch.fileHash }, recheckInput = () => { const state = app.getState(), validation = state.reviewImportValidation.batches[0]; return { ...input, expectedRevision: validation.revision, expectedProjectId: state.project.id, expectedSnapshotId: state.project.snapshotId, expectedValidationHash: validation.validationHash }; };
  return { app, input, uploaded, initial, before, filename, source, paragraphs, recheckInput };
}
const organizationResult = packet => ({ requestId: packet.requestId, notes: packet.noteIds.map(noteId => ({ noteId, suggestedSource: 'A pending suggested sentence.', suggestedTranslation: '待审阅的建议语句。', reasonSource: 'Explain the original reviewer concern.', reasonTranslation: '解释原始审稿意见。' })) });

test('an older external file remains organizable per note after another paragraph changes, without altering import provenance or raw notes', async t => {
  const f = await liveFixture(t), before = f.app.core.getState();
  const packet = await f.app.prepareReviewOrganization({ ...f.input, noteIds: [f.uploaded.notes[1].noteId] });
  assert.equal(packet.context.notes[0].contextValidation.status, 'current'); assert.deepEqual(f.app.core.getState(), before);
  await f.app.submitReviewOrganization(organizationResult(packet));
  const all = await f.app.prepareReviewOrganization(f.input); assert.deepEqual(all.context.notes.map(n => n.contextValidation.status), ['changed', 'current', 'unlocated']);
  const changed = all.context.notes[0]; assert.deepEqual(changed.sourceSegmentIds, []); assert(!changed.currentSource); assert.equal(changed.originalSourceSegmentIds[0], f.paragraphs[0].id);
  assert.deepEqual(f.app.core.getState().reviewNotes[0], before.reviewNotes[0]); assert.deepEqual(f.app.core.getState().reviewBatches, before.reviewBatches);
});

test('explicit granular recheck advances only proven associations and preserves decisions, original import snapshots and paper bytes', async t => {
  const f = await liveFixture(t), paper = await readFile(f.filename), before = f.app.core.getState(), checked = await f.app.revalidateReviewImport(f.recheckInput()), after = f.app.core.getState();
  assert.equal(checked.updatedCount, 1); assert.equal(checked.unverifiedCount, 2); assert.equal(after.reviewBatches[0].sourceSnapshotId, before.reviewBatches[0].sourceSnapshotId);
  assert.equal(after.reviewNotes[1].sourceSnapshotId, after.project.snapshotId); assert.equal(after.reviewNotes[1].originalSourceSnapshotId, before.reviewNotes[1].sourceSnapshotId);
  assert.equal(after.reviewNotes[0].sourceSnapshotId, before.reviewNotes[0].sourceSnapshotId); assert.equal(after.reviewNotes[0].sourceValidation.status, 'changed'); assert.equal(after.reviewNotes[0].decision, 'adopt'); assert.equal(after.reviewNotes[0].decisionSnapshotId, before.reviewNotes[0].decisionSnapshotId);
  for (let i = 0; i < 3; i++) for (const key of ['body', 'noteId', 'batchId', 'origin', 'recommendation', 'decision', 'decisionSnapshotId']) assert.deepEqual(after.reviewNotes[i][key], before.reviewNotes[i][key]);
  assert.deepEqual(await readFile(f.filename), paper); assert.deepEqual(after.translations, before.translations); assert.deepEqual(after.proposals, before.proposals);
});

test('recheck rejects cross-project, stale source/selection and file identity changes without a partial update', async t => {
  const f = await liveFixture(t), expected = f.recheckInput(), before = f.app.core.getState();
  for (const change of [{ expectedProjectId: 'another-project' }, { expectedSnapshotId: 'obsolete' }, { expectedRevision: 99 }, { expectedFileHash: hash('wrong-file') }, { expectedValidationHash: hash('obsolete-selection') }, { noteIds: ['unknown-note'] }]) await assert.rejects(f.app.revalidateReviewImport({ ...expected, ...change }), error => ['VERSION_CONFLICT', 'INVALID_INPUT', 'REVIEW_IMPORT_UNAVAILABLE'].includes(error.code));
  assert.deepEqual(f.app.core.getState(), before);
  await f.app.core._serial(async () => { const next = f.app.core.getState(); next.reviewNotes[1].decision = 'keep'; next.reviewNotes[1].revision++; await f.app.core._commit(next); });
  await assert.rejects(f.app.revalidateReviewImport(expected), { code: 'VERSION_CONFLICT' });
});

test('organization fingerprints only selected opinion records but retains the complete source context that was supplied', async t => {
  const f = await liveFixture(t), packet = await f.app.prepareReviewOrganization({ ...f.input, noteIds: [f.uploaded.notes[1].noteId] });
  await f.app.core._serial(async () => { const next = f.app.core.getState(); next.reviewNotes[0].decision = 'keep'; next.reviewNotes[0].revision++; await f.app.core._commit(next); });
  await f.app.submitReviewOrganization(organizationResult(packet));
  const fresh = await f.app.prepareReviewOrganization({ ...f.input, noteIds: [f.uploaded.notes[1].noteId] });
  await f.app.core._serial(async () => { const next = f.app.core.getState(); next.reviewNotes[1].revision++; await f.app.core._commit(next); });
  await assert.rejects(f.app.submitReviewOrganization(organizationResult(fresh)), { code: 'RESULT_STALE' });
});

test('outdated linked opinions can be explicitly rematched while exact unchanged links stay outside matching scope', async t => {
  const f = await liveFixture(t), changedId = f.uploaded.notes[0].noteId, original = structuredClone(f.app.core.getState().reviewNotes[0]);
  await assert.rejects(f.app.prepareReviewAnchors({ ...f.input, noteIds: [f.uploaded.notes[1].noteId] }), { code: 'REVIEW_ANCHOR_UNAVAILABLE' });
  const packet = await f.app.prepareReviewAnchors({ ...f.input, noteIds: [changedId] }), current = f.app.getState().readingParagraphs[0];
  assert.equal(packet.context.notes[0].contextValidation.status, 'changed');
  await f.app.submitReviewAnchors({ requestId: packet.requestId, matches: [{ noteId: changedId, status: 'certain', reason: 'The original concern still applies to this current paragraph.', candidates: [{ sourceSegmentId: current.id, quote: current.source, reason: 'The complete current literal paragraph is unique.' }] }] });
  const updated = f.app.core.getState().reviewNotes[0]; assert.deepEqual(updated.sourceSegmentIds, [current.id]); assert.equal(updated.sourceSnapshotId, f.app.getState().project.snapshotId); assert.equal(updated.originalSourceSnapshotId, original.sourceSnapshotId);
  for (const key of ['body', 'decision', 'decisionSnapshotId']) assert.equal(updated[key], original[key]);
});

test('uncertain rematching retains old links until an exact human confirmation and old decision intent is not silently renewed', async t => {
  const f = await liveFixture(t), changedId = f.uploaded.notes[0].noteId, original = structuredClone(f.app.core.getState().reviewNotes[0]), packet = await f.app.prepareReviewAnchors({ ...f.input, noteIds: [changedId] }), paragraph = f.app.getState().readingParagraphs[0];
  await f.app.submitReviewAnchors({ requestId: packet.requestId, matches: [{ noteId: changedId, status: 'uncertain', reason: 'Retain the old link until the author confirms.', candidates: [{ sourceSegmentId: paragraph.id, quote: paragraph.source, reason: 'The current paragraph is a candidate.' }] }] });
  let updated = f.app.core.getState().reviewNotes[0]; assert.equal(updated.sourceSnapshotId, original.sourceSnapshotId); assert.deepEqual(updated.sourceHashes, original.sourceHashes);
  await f.app.confirmReviewAnchor({ noteId: updated.noteId, expectedRevision: updated.revision, matchingId: updated.anchorMatch.matchingId, sourceSegmentIds: [paragraph.id], expectedSourceHashes: { [paragraph.id]: paragraph.sourceHash } });
  updated = f.app.core.getState().reviewNotes[0]; assert.equal(updated.decisionSnapshotId, original.decisionSnapshotId);
  const reaffirmed = await f.app.setReviewDecision({ noteId: updated.noteId, expectedRevision: updated.revision, decision: 'adopt' });
  assert.equal(reaffirmed.decisionSnapshotId, f.app.getState().project.snapshotId); assert.equal(reaffirmed.idempotent, undefined); assert.deepEqual(reaffirmed.decisionSourceHashes, { [paragraph.id]: paragraph.sourceHash });
});

test('external adopt/revise uses exact per-note hashes across snapshots and rejects changed or unlocated opinions', async t => {
  const f = await liveFixture(t);
  for (const index of [0, 2]) { const note = f.app.core.getState().reviewNotes[index]; await assert.rejects(f.app.setReviewDecision({ noteId: note.noteId, expectedRevision: note.revision, decision: 'adopt' }), { code: 'REVIEW_NOTE_STALE' }); }
  const note = f.app.core.getState().reviewNotes[1], applied = await f.app.setReviewDecision({ noteId: note.noteId, expectedRevision: note.revision, decision: 'adopt' }); assert.equal(applied.decisionSnapshotId, f.app.getState().project.snapshotId);
});

test('only an opinion explicitly adopted before an actual source commit is skipped by default, and reopening retains its completion history', async t => {
  const f = await liveFixture(t, { adoptBeforeWrite: true }), state = f.app.getState(), validation = state.reviewImportValidation.batches[0], completed = validation.notes[0], paper = await readFile(f.filename), before = f.app.core.getState();
  assert.equal(validation.completedCount, 1); assert.equal(completed.status, 'completed'); assert.equal(completed.associationStatus, 'changed'); assert.equal(completed.skipInMatching, true);
  assert.equal(f.app.flow.transactions.find(tx => tx.state === 'applied').reviewCompletions[0].sourceNoteId, completed.noteId);
  const packet = await f.app.prepareReviewOrganization(f.input); assert.equal(packet.skippedCompletedCount, 1); assert.equal(packet.noteCount, 2); assert(!packet.noteIds.includes(completed.noteId));
  const matching = await f.app.prepareReviewAnchors(f.input); assert.equal(matching.skippedCompletedCount, 1); assert.deepEqual(matching.noteIds, [f.uploaded.notes[2].noteId]);
  for (const prepare of ['prepareReviewOrganization', 'prepareReviewAnchors']) await assert.rejects(f.app[prepare]({ ...f.input, noteIds: [completed.noteId] }), { code: 'REVIEW_ALREADY_APPLIED' });
  const reopen = { noteId: completed.noteId, expectedRevision: completed.revision, expectedProjectId: state.project.id, expectedSnapshotId: state.project.snapshotId, expectedCompletionHash: completed.completionHash };
  await assert.rejects(f.app.reopenReviewImportNote({ ...reopen, expectedProjectId: 'wrong-project' }), { code: 'VERSION_CONFLICT' });
  await f.app.reopenReviewImportNote(reopen); const after = f.app.core.getState(), opened = f.app.getState().reviewImportValidation.batches[0].notes[0];
  assert.equal(opened.completed, false); assert.equal(opened.status, 'changed'); assert(after.reviewNotes[0].reviewReopen); assert.equal(after.reviewNotes[0].decision, before.reviewNotes[0].decision); assert.equal(after.reviewNotes[0].decisionSnapshotId, before.reviewNotes[0].decisionSnapshotId);
  await f.app.prepareReviewOrganization({ ...f.input, noteIds: [completed.noteId] }); await f.app.prepareReviewAnchors({ ...f.input, noteIds: [completed.noteId] });
  assert.deepEqual(await readFile(f.filename), paper); assert.equal(after.reviewNotes.length, before.reviewNotes.length); assert.deepEqual(after.reviewNotes.map(n => n.body), before.reviewNotes.map(n => n.body));
});

test('granular recheck and reopening require authenticated human UI transport and expose no model mutation tools', async t => {
  const f = await liveFixture(t, { adoptBeforeWrite: true }), server = createPaperServer({ service: f.app, uiHtml: '<!doctype html>' }), client = new Client({ name: 'synthetic-review-revalidation', version: '1' }), [c, s] = InMemoryTransport.createLinkedPair(); await server.connect(s); await client.connect(c);
  t.after(async () => { await client.close(); await server.close(); });
  const catalog = await client.listTools(), ui = catalog.tools.find(tool => tool.name === 'bilingual_paper_ui'); assert.deepEqual(ui._meta.ui.visibility, ['app']); assert(!catalog.tools.some(tool => /revalidate|reopen/i.test(tool.name)));
  for (const action of ['revalidateReviewImport', 'reopenReviewImportNote']) { assert(ui.inputSchema.properties.action.enum.includes(action)); const denied = await client.callTool({ name: 'bilingual_paper_ui', arguments: { action, payload: {} } }); assert.equal(denied.structuredContent.error.code, 'UI_AUTHORIZATION_REQUIRED'); }
  const panel = await client.callTool({ name: 'bilingual_paper_panel', arguments: {} }), uiToken = panel._meta.paperUiToken;
  const rechecked = await client.callTool({ name: 'bilingual_paper_ui', arguments: { action: 'revalidateReviewImport', payload: f.recheckInput(), uiToken } }); assert.notEqual(rechecked.isError, true); assert.equal(rechecked._meta.paperResult.skippedCompletedCount, 1);
  const state = f.app.getState(), row = state.reviewImportValidation.batches[0].notes[0], opened = await client.callTool({ name: 'bilingual_paper_ui', arguments: { action: 'reopenReviewImportNote', payload: { noteId: row.noteId, expectedRevision: row.revision, expectedProjectId: state.project.id, expectedSnapshotId: state.project.snapshotId, expectedCompletionHash: row.completionHash }, uiToken } }); assert.notEqual(opened.isError, true); assert.equal(opened._meta.paperResult.reopened, true);
  const web = await startLocalWeb({ service: f.app, nativeBindingId: 'synthetic-review-revalidation' }); t.after(() => web.close());
  const call = authorized => fetch(web.origin + '/api', { method: 'POST', headers: { Origin: web.origin, 'Content-Type': 'application/json', Authorization: authorized ? 'Bearer ' + web.token : '' }, body: JSON.stringify({ action: 'revalidateReviewImport', payload: f.recheckInput() }) });
  assert.equal((await call(false)).status, 401); const result = await (await call(true)).json(); assert.equal(result.ok, true); assert.equal(result.result.sourceChanged, false);
});

test('explicit recheck can relocate a missing old ID only by a unique exact current source hash', async t => {
  const f = await liveFixture(t), before = f.app.core.getState(), old = f.paragraphs[1].id, newId = 'read-relocated-exact-paragraph';
  await f.app.core._serial(async () => { const next = f.app.core.getState(), anchor = next.readingAnchors.find(p => p.id === old); anchor.id = newId; next.readingAnchorRevision++; await f.app.core._commit(next); }); f.app.reading.cache = null;
  const row = f.app.getState().reviewImportValidation.batches[0].notes[1]; assert.equal(row.status, 'relocatable'); assert.deepEqual(row.verifiedSourceSegmentIds, [newId]);
  await f.app.revalidateReviewImport({ ...f.recheckInput(), noteIds: [row.noteId] });
  const updated = f.app.core.getState().reviewNotes[1]; assert.deepEqual(updated.sourceSegmentIds, [newId]); assert.equal(updated.sourceValidation.method, 'unique-exact-hash'); assert.equal(updated.originalSourceSnapshotId, before.reviewNotes[1].sourceSnapshotId); assert.equal(updated.body, before.reviewNotes[1].body);
});

test('a partially changed multi-paragraph opinion is not advanced or collapsed by a one-candidate model rematch', async t => {
  const f = await liveFixture(t), second = f.paragraphs[1];
  await f.app.core._serial(async () => { const next = f.app.core.getState(); next.reviewNotes[0].sourceSegmentIds.push(second.id); next.reviewNotes[0].sourceHashes[second.id] = second.sourceHash; await f.app.core._commit(next); });
  const before = f.app.core.getState().reviewNotes[0]; await f.app.revalidateReviewImport({ ...f.recheckInput(), noteIds: [before.noteId] });
  let updated = f.app.core.getState().reviewNotes[0]; assert.deepEqual(updated.sourceSegmentIds, before.sourceSegmentIds); assert.equal(updated.sourceSnapshotId, before.sourceSnapshotId);
  const validation = f.app.getState().reviewImportValidation.batches[0], packet = await f.app.prepareReviewAnchors({ ...f.input, expectedRevision: validation.revision, noteIds: [before.noteId] }), paragraph = f.app.getState().readingParagraphs[0];
  await f.app.submitReviewAnchors({ requestId: packet.requestId, matches: [{ noteId: before.noteId, status: 'certain', reason: 'This current paragraph contains the main concern.', candidates: [{ sourceSegmentId: paragraph.id, quote: paragraph.source, reason: 'A unique current literal excerpt.' }] }] });
  updated = f.app.core.getState().reviewNotes[0]; assert.equal(updated.anchorMatch.status, 'pending'); assert.deepEqual(updated.sourceSegmentIds, before.sourceSegmentIds); assert.equal(updated.sourceSnapshotId, before.sourceSnapshotId);
});

test('a partly applied multi-paragraph concern supplies completion hints, rejects repeat-only targets and can be explicitly reopened in full', async t => {
  const f = await liveFixture(t, { adoptBeforeWrite: true, partialAdopt: true }), state = f.app.getState(), row = state.reviewImportValidation.batches[0].notes[0], first = state.readingParagraphs[0], second = state.readingParagraphs[1];
  assert.equal(row.completed, false); assert.equal(row.completion.partialCompletedCount, 1);
  const organization = await f.app.prepareReviewOrganization({ ...f.input, noteIds: [row.noteId] }), noteContext = organization.context.notes[0]; assert.deepEqual(noteContext.completedSourceSegmentIds, [first.id]); assert.deepEqual(noteContext.remainingSourceSegmentIds, [second.id]);
  await assert.rejects(f.app.submitReviewOrganization({ requestId: organization.requestId, notes: [{ ...organizationResult(organization).notes[0], sourceSegmentIds: [first.id] }] }), { code: 'INVALID_REVIEW_ORGANIZATION' });
  const matching = await f.app.prepareReviewAnchors({ ...f.input, noteIds: [row.noteId] }); assert.deepEqual(matching.context.notes[0].completedSourceSegmentIds, [first.id]);
  const candidate = paragraph => ({ sourceSegmentId: paragraph.id, quote: paragraph.source, reason: 'Literal current correspondence.' });
  await assert.rejects(f.app.submitReviewAnchors({ requestId: matching.requestId, matches: [{ noteId: row.noteId, status: 'certain', candidates: [candidate(first)], reason: 'Repeating only the written paragraph is outside the remaining concern.' }] }), { code: 'INVALID_REVIEW_ANCHOR_MATCH' });
  await f.app.submitReviewAnchors({ requestId: matching.requestId, matches: [{ noteId: row.noteId, status: 'uncertain', candidates: [candidate(first), candidate(second)], reason: 'The author should choose the remaining concern scope.' }] });
  const pending = f.app.core.getState().reviewNotes[0]; assert.equal(pending.anchorMatch.partialCompletedCount, 1); assert.deepEqual(pending.sourceSegmentIds, f.app.core.getState().reviewNotes[0].sourceSegmentIds);
  const current = f.app.getState(), checked = current.reviewImportValidation.batches[0].notes[0];
  await f.app.reopenReviewImportNote({ noteId: checked.noteId, expectedRevision: checked.revision, expectedProjectId: current.project.id, expectedSnapshotId: current.project.snapshotId, expectedCompletionHash: checked.completionHash });
  const reopened = await f.app.prepareReviewAnchors({ ...f.input, noteIds: [row.noteId] }); assert.deepEqual(reopened.context.notes[0].completedSourceSegmentIds, []);
});

test('a current unlocated global opinion may record human adoption without acquiring a paragraph anchor or completion exemption', async t => {
  const f = await liveFixture(t), imported = await f.app.importReviewNotes({ filename: 'new-global-review.json', format: 'json', fileHash: hash('a genuinely current global reviewer concern'), text: JSON.stringify({ notes: [{ body: 'Improve the overall discussion of experimental relevance.' }] }) }), note = imported.notes[0];
  const adopted = await f.app.setReviewDecision({ noteId: note.noteId, expectedRevision: note.revision, decision: 'adopt' }); assert.deepEqual(adopted.sourceSegmentIds, []); assert.deepEqual(adopted.decisionSourceSegmentIds, []);
  const checked = f.app.getState().reviewImportValidation.batches.find(batch => batch.batchId === imported.batch.batchId).notes[0]; assert.equal(checked.status, 'unlocated'); assert.equal(checked.completed, false); assert.equal(checked.skipInMatching, false);
  const paragraph = f.app.getState().readingParagraphs[1], anchored = await f.app.anchorReviewNote({ noteId: note.noteId, expectedRevision: adopted.revision, sourceSegmentIds: [paragraph.id] });
  const reaffirmed = await f.app.setReviewDecision({ noteId: note.noteId, expectedRevision: anchored.revision, decision: 'adopt' });
  assert.equal(reaffirmed.idempotent, undefined); assert.deepEqual(reaffirmed.decisionSourceSegmentIds, [paragraph.id]); assert.deepEqual(reaffirmed.decisionSourceHashes, { [paragraph.id]: paragraph.sourceHash });
});

test('reopening successive applied versions preserves prior reopen intent when a later write is undone', async t => {
  const f = await liveFixture(t, { adoptBeforeWrite: true });
  const reopen = async () => { const state = f.app.getState(), row = state.reviewImportValidation.batches[0].notes[0]; assert.equal(row.completed, true); await f.app.reopenReviewImportNote({ noteId: row.noteId, expectedRevision: row.revision, expectedProjectId: state.project.id, expectedSnapshotId: state.project.snapshotId, expectedCompletionHash: row.completionHash }); return row.completion.transactionIds; };
  const firstTransactions = await reopen(), firstVersion = await readFile(f.filename), source = f.app.getState().readingParagraphs[0], note = f.app.core.getState().reviewNotes[0];
  const anchored = await f.app.anchorReviewNote({ noteId: note.noteId, expectedRevision: note.revision, sourceSegmentIds: [source.id] });
  await f.app.setReviewDecision({ noteId: anchored.noteId, expectedRevision: anchored.revision, decision: 'adopt' });
  const request = await f.app.createRequest({ kind: 'revision', segmentIds: [source.id], language: 'zh-CN' }), proposal = await f.app.proposeRevision({ requestId: request.requestId, reason: 'An explicitly reviewed second source revision.', edits: [{ segmentId: source.id, beforeHash: request.segments[0].beforeHash, replacement: request.segments[0].text.replace('revised', 'further revised') }] }), preview = await f.app.previewTransaction({ proposalIds: [proposal.proposalId] }); await f.app.waitJob(preview);
  const accept = await f.app.prepareAcceptance(preview); await f.app.applyTransaction({ transactionId: preview.transactionId, confirmationToken: accept.confirmationToken, idempotencyKey: 'second-reviewed-source-version' });
  const secondTransactions = await reopen(), markers = f.app.core.getState().reviewNotes[0].reviewReopen.transactionIds;
  assert(firstTransactions.every(id => markers.includes(id))); assert(secondTransactions.every(id => markers.includes(id)));
  const inverse = await f.app.createUndoProposal(preview), undo = await f.app.previewTransaction({ proposalIds: [inverse.proposalId] }); await f.app.waitJob(undo); const undoAccept = await f.app.prepareAcceptance(undo);
  await f.app.applyTransaction({ transactionId: undo.transactionId, confirmationToken: undoAccept.confirmationToken, idempotencyKey: 'undo-second-reviewed-source-version' });
  assert.deepEqual(await readFile(f.filename), firstVersion); const checked = f.app.getState().reviewImportValidation.batches[0].notes[0]; assert.equal(checked.completed, false); assert.equal(checked.skipInMatching, false); assert.equal(checked.completion.status, 'reopened');
});
