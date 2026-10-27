import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = new URL('../scripts/native-ui-transaction-acceptance.mjs', import.meta.url);
const digest = value => createHash('sha256').update(value).digest('hex');
const copy = value => structuredClone(value);

async function fixture(t) {
  const parent = fileURLToPath(new URL('../work/native-transaction-driver-tests/', import.meta.url));
  await mkdir(parent, { recursive: true }); const directory = await mkdtemp(path.join(parent, 'case-'));
  t.after(async () => { assert.ok(directory.startsWith(parent)); await rm(directory, { recursive: true, force: true }); });
  const source = path.join(directory, 'paper'), preview = path.join(directory, 'private/preview'), sessions = path.join(preview, 'sessions');
  await mkdir(source, { recursive: true }); await mkdir(sessions, { recursive: true });
  const original = Buffer.from('A clear claim.\r\n'), revised = Buffer.from('A precise claim.\r\n');
  const files = [{ path: 'main.tex', bytes: original }, { path: 'figure-a.pdf', bytes: Buffer.from('%PDF synthetic A') }, { path: 'figure-b.pdf', bytes: Buffer.from('%PDF synthetic B') }];
  for (const file of files) await writeFile(path.join(source, file.path), file.bytes);
  const token = 'n'.repeat(43), session = path.join(sessions, 'native-test-instance.json');
  await writeFile(session, JSON.stringify({ schemaVersion: 1, mode: 'native-independent-workbench', version: '0.4.4', pid: process.pid, createdAt: new Date().toISOString(), url: `http://127.0.0.1:12345/#session=${token}` }));
  const projectId = `project-${digest(source.toLowerCase() + '\0main.tex').slice(0, 24)}`;
  const state = { project: { id: projectId, rootLabel: 'paper', mainFile: 'main.tex', snapshotId: 'snap-before', files: files.map(f => ({ path: f.path, hash: digest(f.bytes) })) }, originalSnapshotId: 'snap-first', originals: { p1: { source: 'Original baseline', translation: '最初译文' } }, readingParagraphs: [{ id: 'p1', requestable: true, writableSource: true }], segments: [{ id: 'p1' }], translations: { 'zh-CN': { p1: { text: '保留译稿。' } } }, requests: [], proposals: [], transactions: [], builds: [] };
  const actions = [], confirmations = new Map(); let confirmationsCreated = 0;
  function addCandidate(undo = false) {
    const id = undo ? 'transaction-undo' : 'transaction-apply', proposalId = undo ? 'undo-proposal' : 'proposal-1';
    const before = undo ? revised : original, after = undo ? original : revised;
    const proposal = { proposalId, baseSnapshotId: state.project.snapshotId, reviewState: 'pending', applicationState: 'notApplied', context: undo ? { undoOf: 'transaction-apply' } : { requestId: 'req-native' }, edits: [{ path: 'main.tex', segmentId: 'p1', startByte: 0, endByte: before.length, beforeHash: digest(before), before: before.toString(), replacement: after.toString() }] };
    if (!state.proposals.some(p => p.proposalId === proposalId)) state.proposals.push(proposal);
    const candidateFiles = [{ path: 'main.tex', hash: digest(after) }];
    const candidateHash = digest(JSON.stringify({ baseSnapshotId: state.project.snapshotId, proposalIds: [proposalId], files: candidateFiles }));
    const compiledFiles = state.project.files.map(f => ({ path: f.path, hash: f.path === 'main.tex' ? digest(after) : f.hash })).sort((a,b) => a.path.localeCompare(b.path));
    const build = { buildId: `build-${id}`, kind: 'candidate', status: 'success', snapshotId: state.project.snapshotId, candidateHash, engine: 'xelatex', inputHash: digest(JSON.stringify({ engine: 'xelatex', mainFile: 'main.tex', files: compiledFiles })), isolation: { verified: true, mode: 'synthetic-test' }, pdfHash: digest('%PDF synthetic candidate'), stale: false };
    state.transactions.push({ transactionId: id, state: 'ready', projectId, baseSnapshotId: state.project.snapshotId, candidateHash, proposalIds: [proposalId], buildId: build.buildId }); state.builds.push(build); return id;
  }
  const fetchImpl = async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:12345/api'); assert.equal(init.headers.Origin, 'http://127.0.0.1:12345'); assert.equal(init.headers.Authorization, `Bearer ${token}`); assert.equal(init.redirect, 'error');
    const { action, payload } = JSON.parse(init.body); actions.push({ action, payload: copy(payload) }); let result;
    if (action === 'state') result = copy(state);
    else if (action === 'createRequest') { assert.deepEqual(payload.segmentIds, ['p1']); assert.equal(payload.kind, 'revision'); assert.equal(payload.language, 'zh-CN'); assert.equal(payload.bindingId, undefined); result = { ...payload, requestId: 'req-native', projectId, snapshotId: state.project.snapshotId, bindingId: 'test-instance', status: 'pending' }; state.requests.push(result); }
    else if (action === 'readPdf') { const build = state.builds.find(b => b.buildId === payload.buildId); result = { buildId: build.buildId, base64: Buffer.from('%PDF synthetic candidate').toString('base64'), hash: build.pdfHash, provenance: 'verified-isolated-build' }; }
    else if (action === 'prepareAcceptance') { const tx = state.transactions.find(item => item.transactionId === payload.transactionId); const confirmationToken = `never-print-this-confirmation-${++confirmationsCreated}`; confirmations.set(confirmationToken, tx.transactionId); result = { transactionId: tx.transactionId, confirmationToken, candidateHash: tx.candidateHash, buildId: tx.buildId, expiresAt: new Date(Date.now()+60000).toISOString() }; }
    else if (action === 'applyTransaction') { assert.equal(confirmations.get(payload.confirmationToken), payload.transactionId); confirmations.delete(payload.confirmationToken); const tx = state.transactions.find(item => item.transactionId === payload.transactionId); const bytes = tx.transactionId === 'transaction-undo' ? original : revised; await writeFile(path.join(source, 'main.tex'), bytes); state.project.files.find(f => f.path === 'main.tex').hash = digest(bytes); state.project.snapshotId = tx.transactionId === 'transaction-undo' ? 'snap-before' : 'snap-after'; tx.state = 'applied'; tx.afterSnapshotId = state.project.snapshotId; state.proposals.find(p => p.proposalId === tx.proposalIds[0]).applicationState = 'applied'; if(tx.transactionId === 'transaction-undo') state.transactions.find(p => p.transactionId === 'transaction-apply').revertedBy = tx.transactionId; result = { transactionId: tx.transactionId, state: 'applied', snapshotId: state.project.snapshotId, candidateHash: tx.candidateHash, buildId: tx.buildId }; }
    else if (action === 'createUndoProposal') { assert.equal(payload.transactionId, 'transaction-apply'); result = { proposalId: 'undo-proposal', context: { undoOf: payload.transactionId }, baseSnapshotId: state.project.snapshotId, edits: [{ path: 'main.tex', startByte: 0, endByte: revised.length, beforeHash: digest(revised), replacement: original.toString() }] }; state.proposals.push(result); }
    else throw new Error(`Unexpected test action ${action}`);
    return new Response(JSON.stringify({ ok: true, result, state: copy(state), transport: { mode: 'native-window', nativeChat: true, canSendMessage: false } }), { status: 200 });
  };
  return { directory, files, original, revised, state, actions, addCandidate, token, source, session, options: { env: { SESSION_FILE: session, TARGET_FILE: path.join(source, 'main.tex'), PRIVATE_OUTPUT: path.join(preview, 'acceptance') }, fetchImpl, repositoryRoot: path.join(directory, 'excluded-repository') } };
}

test('native driver prepares only one bound request and snapshots private source/baseline/text hashes', async t => {
  const { runNativeUiTransactionAcceptance: run } = await import(script);
  const f = await fixture(t), result = await run({ ...f.options, phase: 'prepare-request' });
  assert.equal(result.requestId, 'req-native'); assert.equal(result.sourceFiles, 3); assert.deepEqual(f.actions.map(a => a.action), ['state', 'createRequest']);
  const persisted = await readFile(path.join(f.options.env.PRIVATE_OUTPUT, 'native-ui-transaction.json'), 'utf8');
  assert.ok(persisted.includes(digest(f.original))); assert.ok(!persisted.includes(f.token)); assert.ok(!persisted.includes('保留译稿。')); assert.ok(!JSON.stringify(result).includes('Original baseline'));
  await assert.rejects(run({ ...f.options, phase: 'prepare-request' }), { code: 'NATIVE_ACCEPTANCE_BASELINE_EXISTS' });
});

test('native driver requires exact ACK and rejects stale or mismatched compiled candidates before confirmation', async t => {
  const { runNativeUiTransactionAcceptance: run } = await import(script); const f = await fixture(t);
  await run({ ...f.options, phase: 'prepare-request' }); f.addCandidate();
  await assert.rejects(run({ ...f.options, phase: 'apply', env: { ...f.options.env, TRANSACTION_ID: 'transaction-apply' } }), { code: 'NATIVE_ACCEPTANCE_ACK_REQUIRED' });
  f.state.builds[0].inputHash = '0'.repeat(64);
  await assert.rejects(run({ ...f.options, phase: 'apply', env: { ...f.options.env, TRANSACTION_ID: 'transaction-apply', ACK_NATIVE_MVP_WRITES: 'true' } }), { code: 'NATIVE_ACCEPTANCE_BUILD_MISMATCH' });
  assert.ok(!f.actions.some(a => a.action === 'prepareAcceptance')); assert.deepEqual(await readFile(f.options.env.TARGET_FILE), f.original);
});

test('native driver applies and undoes via separate one-use confirmations, restoring all source and draft invariants', async t => {
  const { runNativeUiTransactionAcceptance: run } = await import(script); const f = await fixture(t);
  await run({ ...f.options, phase: 'prepare-request' }); f.addCandidate();
  const applied = await run({ ...f.options, phase: 'apply', env: { ...f.options.env, ACK_NATIVE_MVP_WRITES: 'true', TRANSACTION_ID: 'transaction-apply' } });
  assert.equal(applied.state, 'applied'); assert.deepEqual(await readFile(f.options.env.TARGET_FILE), f.revised);
  const inverse = await run({ ...f.options, phase: 'prepare-undo', env: { ...f.options.env, TRANSACTION_ID: 'transaction-apply' } }); assert.equal(inverse.undoProposalId, 'undo-proposal');
  f.state.proposals = f.state.proposals.filter(p => p.proposalId !== 'undo-proposal'); f.addCandidate(true);
  const undone = await run({ ...f.options, phase: 'undo', env: { ...f.options.env, ACK_NATIVE_MVP_WRITES: 'true', UNDO_TRANSACTION_ID: 'transaction-undo' } });
  assert.equal(undone.restored, true); assert.deepEqual(await readFile(f.options.env.TARGET_FILE), f.original);
  const persisted = await readFile(path.join(f.options.env.PRIVATE_OUTPUT, 'native-ui-transaction.json'), 'utf8'); assert.ok(!persisted.includes('never-print-this-confirmation')); assert.ok(!JSON.stringify([applied,inverse,undone]).includes(f.token));
  assert.equal(f.actions.filter(a => a.action === 'prepareAcceptance').length, 2); assert.equal(f.actions.filter(a => a.action === 'applyTransaction').length, 2);
  assert.ok(!f.actions.some(a => /chat|runRequest|openProject|importResult|previewTransaction/.test(a.action)));
});

test('native driver refuses output escape, foreign main files, standalone sessions and changed source readsets', async t => {
  const { runNativeUiTransactionAcceptance: run } = await import(script); const f = await fixture(t);
  await assert.rejects(run({ ...f.options, phase: 'status', env: { ...f.options.env, PRIVATE_OUTPUT: f.source } }), { code: 'NATIVE_ACCEPTANCE_PRIVATE_PATH' });
  f.state.project.mainFile = '../main.tex'; await assert.rejects(run({ ...f.options, phase: 'status' }), { code: 'NATIVE_ACCEPTANCE_PROJECT_MISMATCH' }); f.state.project.mainFile = 'main.tex';
  await run({ ...f.options, phase: 'prepare-request' }); f.addCandidate(); await writeFile(f.options.env.TARGET_FILE, 'external edit');
  await assert.rejects(run({ ...f.options, phase: 'apply', env: { ...f.options.env, ACK_NATIVE_MVP_WRITES: 'true', TRANSACTION_ID: 'transaction-apply' } }), { code: 'NATIVE_ACCEPTANCE_SOURCE_MISMATCH' });
  assert.ok(!f.actions.some(a => a.action === 'prepareAcceptance'));
  const session = JSON.parse(await readFile(f.session, 'utf8')); session.mode = 'independent-workbench'; await writeFile(f.session, JSON.stringify(session));
  await assert.rejects(run({ ...f.options, phase: 'status' }), { code: 'NATIVE_ACCEPTANCE_SESSION_INVALID' });
});

test('native driver status is metadata-only and baseline draft/original changes block source writes', async t => {
  const { runNativeUiTransactionAcceptance: run } = await import(script); const f = await fixture(t);
  const status = await run({ ...f.options, phase: 'status' }); assert.equal(status.baselinePresent, false); assert.deepEqual(f.actions.map(a => a.action), ['state']);
  assert.ok(!JSON.stringify(status).includes('Original baseline')); assert.ok(!JSON.stringify(status).includes(f.token));
  await run({ ...f.options, phase: 'prepare-request' }); f.addCandidate();
  const options = { ...f.options, phase: 'apply', env: { ...f.options.env, ACK_NATIVE_MVP_WRITES: 'true', TRANSACTION_ID: 'transaction-apply' } };
  f.state.originals.p1.source = 'Changed original baseline'; await assert.rejects(run(options), { code: 'NATIVE_ACCEPTANCE_ORIGINALS_MISMATCH' }); f.state.originals.p1.source = 'Original baseline';
  f.state.translations['zh-CN'].p1.text = '新的译稿'; await assert.rejects(run(options), { code: 'NATIVE_ACCEPTANCE_DRAFT_MISMATCH' });
  assert.ok(!f.actions.some(a => a.action === 'prepareAcceptance')); assert.deepEqual(await readFile(f.options.env.TARGET_FILE), f.original);
});

test('native driver rechecks source after confirmation and never promotes a concurrently changed manuscript', async t => {
  const { runNativeUiTransactionAcceptance: run } = await import(script); const f = await fixture(t);
  await run({ ...f.options, phase: 'prepare-request' }); f.addCandidate();
  const fetchImpl = async (url, init) => { const response = await f.options.fetchImpl(url, init); if(JSON.parse(init.body).action === 'prepareAcceptance') await writeFile(f.options.env.TARGET_FILE, 'later external edit'); return response; };
  await assert.rejects(run({ ...f.options, fetchImpl, phase: 'apply', env: { ...f.options.env, ACK_NATIVE_MVP_WRITES: 'true', TRANSACTION_ID: 'transaction-apply' } }), { code: 'NATIVE_ACCEPTANCE_SOURCE_MISMATCH' });
  assert.equal(f.actions.filter(a => a.action === 'prepareAcceptance').length, 1); assert.ok(!f.actions.some(a => a.action === 'applyTransaction'));
  assert.ok(!(await readFile(path.join(f.options.env.PRIVATE_OUTPUT, 'native-ui-transaction.json'), 'utf8')).includes('never-print-this-confirmation'));
});

test('a verified source write remains safely undoable after reading/draft projection drift', async t => {
  const { runNativeUiTransactionAcceptance: run } = await import(script); const f = await fixture(t);
  const fetchImpl = async (url, init) => {
    const response = await f.options.fetchImpl(url, init), input = JSON.parse(init.body);
    if(input.action === 'applyTransaction') {
      if(input.payload.transactionId === 'transaction-apply') { f.state.readingParagraphs[0].id = 'temporary-projection-id'; f.state.translations['zh-CN'].p1.text = 'temporary projection drift'; }
      else { f.state.readingParagraphs[0].id = 'p1'; f.state.translations['zh-CN'].p1.text = '保留译稿。'; }
    }
    return response;
  };
  const options = { ...f.options, fetchImpl };
  await run({ ...options, phase: 'prepare-request' }); f.addCandidate();
  await assert.rejects(run({ ...options, phase: 'apply', env: { ...f.options.env, ACK_NATIVE_MVP_WRITES: 'true', TRANSACTION_ID: 'transaction-apply' } }), { code: 'NATIVE_ACCEPTANCE_READING_IDS_MISMATCH' });
  const marker = path.join(f.options.env.PRIVATE_OUTPUT, 'native-ui-transaction.json');
  const receipt = JSON.parse(await readFile(marker, 'utf8')); assert.equal(receipt.applied.sourceVerified, true); assert.equal(receipt.applied.verified, false); assert.deepEqual(await readFile(f.options.env.TARGET_FILE), f.revised);
  const inverse = await run({ ...options, phase: 'prepare-undo', env: { ...f.options.env, TRANSACTION_ID: 'transaction-apply' } }); assert.equal(inverse.undoProposalId, 'undo-proposal');
  f.state.proposals = f.state.proposals.filter(p => p.proposalId !== 'undo-proposal'); f.addCandidate(true);
  const result = await run({ ...options, phase: 'undo', env: { ...f.options.env, ACK_NATIVE_MVP_WRITES: 'true', UNDO_TRANSACTION_ID: 'transaction-undo' } });
  assert.equal(result.restored, true); assert.deepEqual(await readFile(f.options.env.TARGET_FILE), f.original);
  const restored = JSON.parse(await readFile(marker, 'utf8')); assert.equal(restored.undone.sourceVerified, true); assert.equal(restored.undone.verified, true);
  assert.equal(f.actions.filter(a => a.action === 'prepareAcceptance').length, 2); assert.equal(f.actions.filter(a => a.action === 'applyTransaction').length, 2);
});
