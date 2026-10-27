import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Operator-only real native UI acceptance. This never creates a service, worker,
// chat or model turn. Source promotion is disabled unless the operator explicitly
// supplies ACK_NATIVE_MVP_WRITES=true and the exact reviewed transaction ID.
// Usage: node scripts/native-ui-transaction-acceptance.mjs <phase>
// Required: SESSION_FILE, TARGET_FILE, PRIVATE_OUTPUT. Optional SOURCE_SEGMENT_ID.
// Phases: prepare-request | apply | prepare-undo | undo | status.
const PHASES = new Set(['prepare-request', 'apply', 'prepare-undo', 'undo', 'status']);
const MAX_BYTES = 64 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const fail = suffix => { throw Object.assign(new Error('Native UI acceptance stopped at a verification gate.'), { code: `NATIVE_ACCEPTANCE_${suffix}` }); };
const check = (condition, suffix) => { if (!condition) fail(suffix); };
const inside = (root, target) => { const rel = path.relative(root, target); return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`); };
const stable = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(item => JSON.parse(stable(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(stable(value[key]))])) : value ?? null);
const same = (a, b) => stable(a) === stable(b);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);

async function regularBytes(filename, maximum = MAX_BYTES) {
  const stat = await lstat(filename); check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum, 'PRIVATE_PATH');
  return readFile(filename);
}
async function jsonFile(filename, maximum = MAX_BYTES) {
  try { return JSON.parse((await regularBytes(filename, maximum)).toString('utf8')); }
  catch (error) { if (error.code?.startsWith('NATIVE_ACCEPTANCE_') || error.code === 'ENOENT') throw error; fail('INVALID_RECORD'); }
}
async function privateDirectory(root, output) {
  check(inside(root, output) && root !== output, 'PRIVATE_PATH');
  let cursor = root;
  for (const component of path.relative(root, output).split(path.sep)) {
    cursor = path.join(cursor, component);
    try { const stat = await lstat(cursor); check(stat.isDirectory() && !stat.isSymbolicLink(), 'PRIVATE_PATH'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(cursor, { mode: 0o700 }); }
  }
  check((await realpath(output)) === output, 'PRIVATE_PATH');
}
const readingIds = state => (state.readingParagraphs || []).map(item => item.id);
const translationHashes = state => Object.entries(state.translations || {}).sort(([a],[b]) => a.localeCompare(b)).flatMap(([language, drafts]) => Object.entries(drafts).sort(([a],[b]) => a.localeCompare(b)).map(([id, draft]) => { check(typeof draft.text === 'string', 'DRAFT_MISMATCH'); return { language, id, hash: digest(draft.text) }; }));
function verifyOriginalBaselines(state, baseline) {
  // Derived source segmentation may add new originals. Every initial immutable
  // original must remain byte-for-byte identical; additions are not substitutions.
  check((state.originalSnapshotId ?? null) === baseline.originalSnapshotId && Object.entries(baseline.originals).every(([id, original]) => Object.hasOwn(state.originals || {}, id) && same(state.originals[id], original)), 'ORIGINALS_MISMATCH');
}
function verifyBaselines(state, baseline) {
  verifyOriginalBaselines(state, baseline);
  check(same(readingIds(state), baseline.readingIds), 'READING_IDS_MISMATCH');
  check(same(translationHashes(state), baseline.translationHashes), 'DRAFT_MISMATCH');
}
function verifyAppliedSource(state, sources, receipt) {
  check(receipt?.sourceVerified === true && same(manifestOnly(sources), receipt.readSet), 'SOURCE_MISMATCH');
  const tx = state.transactions?.find(item => item.transactionId === receipt.transactionId);
  check(tx?.state === 'applied' && tx.projectId === state.project.id && tx.afterSnapshotId === state.project.snapshotId && receipt.snapshotId === state.project.snapshotId && tx.candidateHash === receipt.candidateHash && tx.buildId === receipt.buildId && !tx.revertedBy, 'TRANSACTION_MISMATCH');
}
async function sourceManifest(state, target, root) {
  const project = state?.project;
  check(project && validId(project.id) && validId(project.snapshotId) && project.mainFile === path.basename(target) && project.rootLabel === path.basename(root), 'PROJECT_MISMATCH');
  const expectedProjectId = `project-${digest(root.toLowerCase() + '\0' + project.mainFile.toLowerCase()).slice(0, 24)}`;
  check(project.id === expectedProjectId, 'PROJECT_MISMATCH');
  check(Array.isArray(project.files) && project.files.length === 3 && new Set(project.files.map(f => f.path)).size === 3, 'SOURCE_COUNT');
  const entries = [];
  for (const file of project.files) {
    check(typeof file.path === 'string' && !path.isAbsolute(file.path) && !file.path.split(/[\\/]/).includes('..') && hashPattern.test(file.hash || ''), 'PROJECT_MISMATCH');
    const filename = path.resolve(root, file.path); check(inside(root, filename), 'PROJECT_MISMATCH');
    check(inside(root, await realpath(filename)), 'PROJECT_MISMATCH');
    const bytes = await regularBytes(filename); check(digest(bytes) === file.hash, 'SOURCE_MISMATCH');
    entries.push({ path: file.path, hash: digest(bytes), bytes: bytes.length, content: bytes });
  }
  check(entries.some(f => path.resolve(root, f.path) === target), 'PROJECT_MISMATCH');
  return entries.sort((a,b) => a.path.localeCompare(b.path));
}
const manifestOnly = entries => entries.map(({ path: filename, hash, bytes }) => ({ path: filename, hash, bytes }));

function verifiedCandidate(state, transactionId, sources, expectedProposalIds) {
  const tx = state.transactions?.find(item => item.transactionId === transactionId);
  const build = state.builds?.find(item => item.buildId === tx?.buildId);
  check(tx?.state === 'ready' && tx.projectId === state.project.id && tx.baseSnapshotId === state.project.snapshotId && Array.isArray(tx.proposalIds) && tx.proposalIds.length && new Set(tx.proposalIds).size === tx.proposalIds.length && same([...tx.proposalIds].sort(), [...expectedProposalIds].sort()), 'TRANSACTION_MISMATCH');
  check(build?.kind === 'candidate' && build.status === 'success' && build.isolation?.verified === true && build.stale === false && build.snapshotId === tx.baseSnapshotId && build.candidateHash === tx.candidateHash && hashPattern.test(build.pdfHash || '') && ['xelatex', 'pdflatex'].includes(build.engine), 'BUILD_MISMATCH');
  const edits = tx.proposalIds.flatMap(id => {
    const proposal = state.proposals?.find(item => item.proposalId === id);
    check(proposal && proposal.baseSnapshotId === tx.baseSnapshotId && proposal.reviewState === 'pending' && proposal.applicationState === 'notApplied' && Array.isArray(proposal.edits) && proposal.edits.length, 'TRANSACTION_MISMATCH'); return proposal.edits;
  });
  const changed = [];
  for (const filename of new Set(edits.map(item => item.path))) {
    const source = sources.find(file => file.path === filename); check(source, 'SOURCE_MISMATCH');
    const items = edits.filter(item => item.path === filename).sort((a,b) => a.startByte - b.startByte);
    let bytes = Buffer.from(source.content);
    for (let i = 0; i < items.length; i++) { const e = items[i]; check(Number.isSafeInteger(e.startByte) && Number.isSafeInteger(e.endByte) && e.startByte >= 0 && e.endByte >= e.startByte && e.endByte <= bytes.length && typeof e.replacement === 'string' && (i === 0 || items[i-1].endByte <= e.startByte), 'CANDIDATE_MISMATCH'); }
    for (const edit of items.toReversed()) { check(digest(bytes.subarray(edit.startByte, edit.endByte)) === edit.beforeHash, 'SOURCE_MISMATCH'); bytes = Buffer.concat([bytes.subarray(0, edit.startByte), Buffer.from(edit.replacement), bytes.subarray(edit.endByte)]); }
    changed.push({ path: filename, hash: digest(bytes), bytes: bytes.length });
  }
  changed.sort((a,b) => a.path.localeCompare(b.path));
  const after = sources.map(file => changed.find(item => item.path === file.path) || manifestOnly([file])[0]);
  const candidateHash = digest(JSON.stringify({ baseSnapshotId: tx.baseSnapshotId, proposalIds: [...tx.proposalIds].sort(), files: changed.map(({path,hash}) => ({path,hash})) }));
  const inputHash = digest(JSON.stringify({ engine: build.engine, mainFile: state.project.mainFile, files: after.map(({path,hash}) => ({path,hash})) }));
  check(candidateHash === tx.candidateHash && inputHash === build.inputHash, 'BUILD_MISMATCH');
  return { tx, build, after, changed };
}

export async function runNativeUiTransactionAcceptance({ phase, env = process.env, fetchImpl = fetch, repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url)) } = {}) {
  check(PHASES.has(phase), 'PHASE_INVALID');
  for (const key of ['SESSION_FILE','TARGET_FILE','PRIVATE_OUTPUT']) check(typeof env[key] === 'string' && path.isAbsolute(env[key]), 'PRIVATE_PATH');
  check(/\.tex$/i.test(env.TARGET_FILE), 'PROJECT_MISMATCH');
  const repository = await realpath(repositoryRoot).catch(() => path.resolve(repositoryRoot));
  const sessionFile = await realpath(env.SESSION_FILE), target = await realpath(env.TARGET_FILE), root = path.dirname(target);
  check(!inside(repository, target) && !inside(repository, sessionFile), 'PRIVATE_PATH');
  const sessionRoot = path.dirname(sessionFile), privateRoot = path.dirname(sessionRoot);
  check(path.basename(sessionRoot).toLowerCase() === 'sessions' && path.basename(privateRoot).toLowerCase() === 'preview' && /^native-[A-Za-z0-9_.:-]+\.json$/.test(path.basename(sessionFile)), 'SESSION_INVALID');
  check(!inside(repository, privateRoot), 'PRIVATE_PATH');
  const output = path.resolve(env.PRIVATE_OUTPUT); check(inside(privateRoot, output) && !inside(repository, output), 'PRIVATE_PATH');
  await privateDirectory(privateRoot, output);
  const session = await jsonFile(sessionFile, 65536);
  check(session.mode === 'native-independent-workbench' && typeof session.version === 'string' && /^\d+\.\d+\.\d+$/.test(session.version) && Number.isSafeInteger(session.pid) && session.pid > 0, 'SESSION_INVALID');
  let url; try { url = new URL(session.url); } catch { fail('SESSION_INVALID'); }
  check(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.pathname === '/' && !url.search && !url.username && !url.password && /^#session=[A-Za-z0-9_-]{43}$/.test(url.hash), 'SESSION_INVALID');
  const token = url.hash.slice('#session='.length), bindingId = path.basename(sessionFile).slice('native-'.length, -'.json'.length);
  const sessionIdentity = digest(stable({ file: sessionFile, pid: session.pid, version: session.version, createdAt: session.createdAt }));
  const marker = path.join(output, 'native-ui-transaction.json'), lock = path.join(output, 'native-ui-transaction.lock');
  let locked = false;
  try {
    try { await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); locked = true; }
    catch(error) { if(error.code === 'EEXIST') fail('BUSY'); throw error; }
    let baseline; try { baseline = await jsonFile(marker); } catch(error) { if(error.code !== 'ENOENT') throw error; }
    if(baseline) check(baseline.schemaVersion === 1 && baseline.sessionIdentity === sessionIdentity && baseline.targetFile === target, 'BASELINE_MISMATCH');
    let markerExists = Boolean(baseline);
    const persist = async () => {
      const temporary = path.join(output, `.native-transaction-${randomUUID()}.tmp`);
      try { await writeFile(temporary, JSON.stringify(baseline, null, 2), { flag: 'wx', mode: 0o600 }); if (markerExists) await regularBytes(marker); await rename(temporary, marker); markerExists = true; }
      finally { await unlink(temporary).catch(error => { if(error.code !== 'ENOENT') throw error; }); }
    };
    const api = async (action, payload = {}) => {
      check(['state','createRequest','readPdf','prepareAcceptance','applyTransaction','createUndoProposal'].includes(action), 'ACTION_DENIED');
      let response, body;
      try {
        response = await fetchImpl(new URL('/api', url), { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Origin: url.origin, Authorization: `Bearer ${token}` }, body: JSON.stringify({ action, payload }), signal: AbortSignal.timeout(120000) });
        const reader = response.body.getReader(); const chunks = []; let length = 0;
        while(true) { const item = await reader.read(); if(item.done) break; length += item.value.byteLength; if(length > MAX_BYTES) { await reader.cancel(); fail('RESPONSE_TOO_LARGE'); } chunks.push(Buffer.from(item.value)); }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch(error) { if(error.code?.startsWith('NATIVE_ACCEPTANCE_')) throw error; fail('HTTP_FAILED'); }
      check(response.ok && body.ok === true, 'API_REJECTED');
      check(body.transport?.mode === 'native-window' && body.transport.nativeChat === true && body.transport.canSendMessage === false, 'NATIVE_SERVICE_REQUIRED');
      return body;
    };
    if(['apply','undo'].includes(phase)) check(env.ACK_NATIVE_MVP_WRITES === 'true', 'ACK_REQUIRED');
    let state = (await api('state')).result;
    let sources = await sourceManifest(state, target, root);
    const context = { phase, version: session.version, mode: session.mode, pid: session.pid, projectId: state.project.id, snapshotId: state.project.snapshotId, sourceFiles: sources.length };
    if(phase === 'status') return { ...context, baselinePresent: Boolean(baseline), ...(baseline ? { requestId: baseline.requestId || null, appliedTransactionId: baseline.applied?.transactionId || null, undoProposalId: baseline.undoProposalId || null, restored: baseline.undone?.restored === true } : {}), transactions: (state.transactions || []).map(t => ({ transactionId: t.transactionId, state: t.state, candidateHash: t.candidateHash, buildId: t.buildId, proposalIds: t.proposalIds, revertedBy: t.revertedBy })) };
    if(phase === 'prepare-request') {
      check(!baseline, 'BASELINE_EXISTS');
      const paragraph = env.SOURCE_SEGMENT_ID ? state.readingParagraphs?.find(p => p.id === env.SOURCE_SEGMENT_ID) : state.readingParagraphs?.find(p => p.requestable && p.writableSource);
      check(paragraph?.requestable && paragraph.writableSource && validId(paragraph.id), 'SEGMENT_REQUIRED');
      baseline = { schemaVersion: 1, sessionIdentity, targetFile: target, projectId: state.project.id, beforeSnapshotId: state.project.snapshotId, mainFile: state.project.mainFile, createdAt: new Date().toISOString(), readSet: manifestOnly(sources), originalSnapshotId: state.originalSnapshotId ?? null, originals: state.originals || {}, readingIds: readingIds(state), translationHashes: translationHashes(state), sourceSegmentId: paragraph.id };
      await persist(); // Preserve the before-image identity before creating any request.
      const response = await api('createRequest', { kind: 'revision', segmentIds: [paragraph.id], language: 'zh-CN', prompt: '请仅改善所选段落的表述清晰度；保留公式、引用、数字与原意。' });
      const request = response.result;
      check(validId(request.requestId) && request.kind === 'revision' && request.language === 'zh-CN' && request.bindingId === bindingId && request.projectId === baseline.projectId && request.snapshotId === baseline.beforeSnapshotId && same(request.segmentIds, [paragraph.id]), 'REQUEST_MISMATCH');
      baseline.requestId = request.requestId; await persist();
      return { ...context, requestId: request.requestId, sourceSegmentId: paragraph.id, sourceReadOnly: true, modelTurnStarted: false };
    }
    check(baseline?.requestId && baseline.projectId === state.project.id, 'BASELINE_REQUIRED');
    if(phase === 'prepare-undo' || phase === 'undo') verifyOriginalBaselines(state, baseline);
    else verifyBaselines(state, baseline);
    if(phase === 'prepare-undo') {
      check(validId(env.TRANSACTION_ID) && baseline.applied?.transactionId === env.TRANSACTION_ID && !baseline.undoProposalId, 'TRANSACTION_MISMATCH');
      verifyAppliedSource(state, sources, baseline.applied);
      const applied = state.transactions?.find(t => t.transactionId === env.TRANSACTION_ID);
      check(applied?.state === 'applied' && applied.afterSnapshotId === state.project.snapshotId && !applied.revertedBy, 'TRANSACTION_MISMATCH');
      const response = await api('createUndoProposal', { transactionId: applied.transactionId }), proposal = response.result;
      check(validId(proposal.proposalId) && proposal.context?.undoOf === applied.transactionId && proposal.baseSnapshotId === state.project.snapshotId, 'UNDO_MISMATCH');
      check(Array.isArray(proposal.edits) && proposal.edits.length > 0, 'UNDO_MISMATCH');
      const changed = baseline.readSet.filter(file => baseline.applied.readSet.find(f => f.path === file.path)?.hash !== file.hash);
      check(proposal.edits.length === changed.length && new Set(proposal.edits.map(e => e.path)).size === changed.length && proposal.edits.every(e => { const original = changed.find(f => f.path === e.path), current = sources.find(f => f.path === e.path); return original && current && e.startByte === 0 && e.endByte === current.bytes && e.beforeHash === current.hash && typeof e.replacement === 'string' && digest(e.replacement) === original.hash; }), 'UNDO_MISMATCH');
      baseline.undoProposalId = proposal.proposalId; await persist();
      return { ...context, appliedTransactionId: applied.transactionId, undoProposalId: proposal.proposalId, sourceReadOnly: true, compileRequired: true };
    }
    const undo = phase === 'undo', transactionId = undo ? env.UNDO_TRANSACTION_ID : env.TRANSACTION_ID;
    check(validId(transactionId), 'TRANSACTION_REQUIRED');
    if(undo) { check(validId(baseline.undoProposalId) && !baseline.undone, 'UNDO_MISMATCH'); verifyAppliedSource(state, sources, baseline.applied); }
    else check(!baseline.applied && state.project.snapshotId === baseline.beforeSnapshotId, 'TRANSACTION_MISMATCH');
    check(same(manifestOnly(sources), undo ? baseline.applied.readSet : baseline.readSet), 'SOURCE_MISMATCH');
    const proposalIds = undo ? [baseline.undoProposalId] : (state.proposals || []).filter(p => p.context?.requestId === baseline.requestId && p.applicationState === 'notApplied').map(p => p.proposalId);
    check(proposalIds.length === 1, 'TRANSACTION_MISMATCH');
    if(undo) check(state.proposals?.find(p => p.proposalId === baseline.undoProposalId)?.context?.undoOf === baseline.applied.transactionId, 'UNDO_MISMATCH');
    const candidate = verifiedCandidate(state, transactionId, sources, proposalIds);
    if(undo) check(same(candidate.after, baseline.readSet), 'UNDO_MISMATCH');
    const pdf = (await api('readPdf', { buildId: candidate.build.buildId })).result;
    check(pdf.buildId === candidate.build.buildId && pdf.provenance === 'verified-isolated-build' && (pdf.hash || pdf.pdfHash) === candidate.build.pdfHash && typeof pdf.base64 === 'string' && digest(Buffer.from(pdf.base64, 'base64')) === candidate.build.pdfHash, 'BUILD_MISMATCH');
    const confirmation = (await api('prepareAcceptance', { transactionId })).result;
    check(confirmation.transactionId === transactionId && confirmation.candidateHash === candidate.tx.candidateHash && confirmation.buildId === candidate.build.buildId && typeof confirmation.confirmationToken === 'string' && confirmation.confirmationToken.length >= 20 && confirmation.confirmationToken.length <= 128 && Date.parse(confirmation.expiresAt) > Date.now(), 'CONFIRMATION_MISMATCH');
    // A fresh exact snapshot/read-set check follows confirmation. Tokens stay in RAM.
    state = (await api('state')).result; sources = await sourceManifest(state, target, root);
    if(undo) { verifyOriginalBaselines(state, baseline); verifyAppliedSource(state, sources, baseline.applied); }
    else verifyBaselines(state, baseline);
    check(same(manifestOnly(sources), undo ? baseline.applied.readSet : baseline.readSet), 'SOURCE_MISMATCH');
    const current = verifiedCandidate(state, transactionId, sources, proposalIds);
    check(current.tx.candidateHash === confirmation.candidateHash && current.build.buildId === confirmation.buildId, 'CONFIRMATION_MISMATCH');
    const result = (await api('applyTransaction', { transactionId, confirmationToken: confirmation.confirmationToken, idempotencyKey: `native-mvp-${randomUUID()}` })).result;
    check(result.state === 'applied' && result.transactionId === transactionId && result.candidateHash === candidate.tx.candidateHash && result.buildId === candidate.build.buildId, 'APPLY_MISMATCH');
    const receipt = { transactionId, candidateHash: result.candidateHash, buildId: result.buildId, snapshotId: result.snapshotId, readSet: candidate.after, sourceVerified: false, verified: false, at: new Date().toISOString() };
    if(undo) baseline.undone = receipt; else baseline.applied = receipt; await persist();
    state = (await api('state')).result; sources = await sourceManifest(state, target, root);
    check(same(manifestOnly(sources), candidate.after), 'SOURCE_MISMATCH');
    const appliedTx = state.transactions?.find(t => t.transactionId === transactionId);
    check(state.project.snapshotId === result.snapshotId && appliedTx?.state === 'applied' && appliedTx.projectId === state.project.id && appliedTx.afterSnapshotId === result.snapshotId && appliedTx.candidateHash === result.candidateHash && appliedTx.buildId === result.buildId, 'APPLY_MISMATCH');
    // Persist source-level proof before checking the derived UI projection. A
    // projection failure must not strand an otherwise exact reversible write.
    receipt.sourceVerified = true;
    if(undo) { check(same(manifestOnly(sources), baseline.readSet), 'UNDO_MISMATCH'); receipt.sourceRestored = true; }
    await persist();
    verifyBaselines(state, baseline);
    receipt.verified = true; if(undo) { check(same(manifestOnly(sources), baseline.readSet), 'UNDO_MISMATCH'); receipt.restored = true; } await persist();
    return { ...context, snapshotId: result.snapshotId, transactionId, candidateHash: result.candidateHash, buildId: result.buildId, state: 'applied', changedFiles: candidate.changed.length, sourceFilesVerified: sources.length, originalsPreserved: true, readingIdsPreserved: true, translationTextPreserved: true, ...(undo ? { restored: true } : {}) };
  } finally { if(locked) await unlink(lock); }
}

if(process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runNativeUiTransactionAcceptance({ phase: process.argv[2] || process.env.PHASE }).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { const code = /^NATIVE_ACCEPTANCE_[A-Z_]+$/.test(error.code || '') ? error.code : 'NATIVE_ACCEPTANCE_FAILED'; process.stderr.write(JSON.stringify({ ok: false, code }) + '\n'); process.exitCode = 1; });
}
