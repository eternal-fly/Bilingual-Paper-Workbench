import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { VersionWorkflow } from '../src/version-workflow.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const owned = fileURLToPath(new URL('../work/version-workflow-tests/', import.meta.url)); await mkdir(owned, { recursive: true }); const root = await mkdtemp(path.join(owned, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let snapshotId, originalSnapshotId, source = 'Original English.', pdf = Buffer.from('%PDF-1.7\n% synthetic original\n%%EOF\n');
  const state = () => ({ project: { id: 'project-synthetic', snapshotId, mainFile: 'main.tex' }, originalSnapshotId });
  const app = { engine: 'xelatex', emit() {}, core: { _store: path.join(root, 'private'), getState: state, _assertSourceCurrent: async () => {} }, reading: { derive: () => ({ projections: [{ path: 'main.tex', supported: true, text: source }] }) }, flow: { builds: [] } };
  const artifacts = new Map();
  const update = (text = source, marker = 'original') => {
    source = text; snapshotId = `snap-${hash(JSON.stringify({ mainFile: 'main.tex', files: [{ path: 'main.tex', hash: hash(source), size: Buffer.byteLength(source) }] }))}`; originalSnapshotId ||= snapshotId; pdf = Buffer.from(`%PDF-1.7\n% synthetic ${marker}\n%%EOF\n`); app.core._files = new Map([['main.tex', { path: 'main.tex', bytes: Buffer.from(source) }]]);
    const inputHash = hash(JSON.stringify({ engine: app.engine, mainFile: 'main.tex', files: [{ path: 'main.tex', hash: hash(source) }] }));
    app.flow.builds.push({ buildId: `build-${marker}`, kind: 'english', status: 'success', isolation: { verified: true }, snapshotId, inputHash, pdfHash: hash(pdf) });
    artifacts.set(`build-${marker}`, pdf);
  };
  update(); await mkdir(path.join(app.core._store, 'snapshots'), { recursive: true }); await writeFile(path.join(app.core._store, `snapshots/${originalSnapshotId}.json`), JSON.stringify({ schemaVersion: 1, snapshotId: originalSnapshotId, files: [{ path: 'main.tex', hash: hash(source), base64: Buffer.from(source).toString('base64') }] }));
  app.readPdf = async ({ buildId }) => { const build = app.flow.builds.find(item => item.buildId === buildId); return { kind: 'english', provenance: 'verified-isolated-build', snapshotId: build.snapshotId, hash: build.pdfHash, base64: artifacts.get(buildId).toString('base64') }; };
  const contextDir = path.join(root, 'context'); await mkdir(contextDir); return { app, update, contextDir, workflow: new VersionWorkflow(app, { contextDir }) };
}
test('only verified current English PDF bytes publish two stable author files and freeze the original', async t => {
  const { app, update, contextDir, workflow } = await fixture(t); const first = await workflow.read(); assert.equal(workflow.state().available, true);
  update('Updated English.', 'latest'); const latest = await workflow.read(); assert.equal(latest.original.hash, first.original.hash); assert.notEqual(latest.latest.hash, first.latest.hash);
  assert.deepEqual((await readdir(contextDir)).sort(), ['latest-english.pdf', 'original.pdf']); assert.equal(latest.latest.snapshotId, app.core.getState().project.snapshotId); assert.equal((await workflow.read()).pairId, latest.pairId);
});
test('a stale projection or unverified compiler result cannot become the model latest PDF', async t => {
  const { app, workflow } = await fixture(t); app.flow.builds[0].isolation.verified = false; await assert.rejects(workflow.read(), { code: 'VERSION_PAIR_COMPILE_REQUIRED' });
  app.flow.builds[0].isolation.verified = true; app.reading.derive = () => ({ projections: [{ path: 'main.tex', supported: true, text: 'A different projection.' }] }); await assert.rejects(workflow.read(), { code: 'VERSION_PAIR_COMPILE_REQUIRED' });
});
test('PDF artifact byte/hash mismatch fails before creating author-facing versions', async t => {
  const { app, workflow, contextDir } = await fixture(t); const read = app.readPdf; app.readPdf = async input => ({ ...await read(input), base64: Buffer.from('%PDF-1.7\n% changed\n%%EOF').toString('base64') });
  await assert.rejects(workflow.read(), { code: 'BUILD_IDENTITY_MISMATCH' }); assert.deepEqual(await readdir(contextDir), []);
});
test('first publication after an edit freezes the proven first-source PDF rather than the latest PDF', async t => {
  const { app, update, workflow } = await fixture(t), first = app.flow.builds[0]; update('Later author revision.', 'latest');
  const pair = await workflow.read(); assert.equal(pair.original.hash, first.pdfHash); assert.equal(pair.original.snapshotId, first.snapshotId); assert.notEqual(pair.original.hash, pair.latest.hash);
});
test('missing verified original cannot silently become a renamed latest revision', async t => {
  const { app, update, workflow, contextDir } = await fixture(t); update('Later author revision.', 'latest'); app.flow.builds.shift();
  await assert.rejects(workflow.read(), { code: 'ORIGINAL_VERSION_UNAVAILABLE' }); assert.deepEqual(await readdir(contextDir), []);
});

test('only an applied candidate with exact projected inputs may publish the latest English PDF', async t => {
  const { app, update, workflow } = await fixture(t), original = await workflow.read();
  update('Confirmed candidate English.', 'candidate'); const build = app.flow.builds.at(-1), confirmed = app.core.getState().project.snapshotId;
  Object.assign(build, { kind: 'candidate', projectId: 'project-synthetic', snapshotId: 'snap-before-confirmation', promotedSnapshotId: confirmed, candidateHash: 'exact-candidate' });
  const read = app.readPdf; app.readPdf = async input => { const result = await read(input); return input.buildId === build.buildId ? { ...result, kind: 'candidate', snapshotId: confirmed, promoted: true, candidateHash: build.candidateHash } : result; };
  await assert.rejects(workflow.read(), { code: 'VERSION_PAIR_COMPILE_REQUIRED' });
  app.flow.transactions = [{ state: 'applied', projectId: 'project-synthetic', buildId: build.buildId, afterSnapshotId: confirmed, candidateHash: build.candidateHash }];
  const pair = await workflow.read(); assert.equal(pair.latest.buildId, build.buildId); assert.equal(pair.latest.snapshotId, confirmed); assert.equal(pair.latest.candidateHash, build.candidateHash); assert.deepEqual(pair.original, original.original);
  app.flow.transactions[0].sourceChangedAgain = true; await assert.rejects(workflow.read(), { code: 'VERSION_PAIR_COMPILE_REQUIRED' });
  app.flow.transactions[0].sourceChangedAgain = false; build.projectId = 'another-project'; await assert.rejects(workflow.read(), { code: 'VERSION_PAIR_COMPILE_REQUIRED' });
  build.projectId = 'project-synthetic'; app.flow.transactions[0].projectId = 'another-project'; await assert.rejects(workflow.read(), { code: 'VERSION_PAIR_COMPILE_REQUIRED' });
  app.flow.transactions[0].projectId = 'project-synthetic'; build.inputHash = '0'.repeat(64); await assert.rejects(workflow.read(), { code: 'VERSION_PAIR_COMPILE_REQUIRED' });
});

test('a scheduled refresh arriving during an older refresh runs again after settlement', async t => {
  const { workflow } = await fixture(t); let finish, calls = 0;
  workflow._refresh = async () => { calls++; if (calls === 1) await new Promise(resolve => { finish = resolve; }); return calls; };
  const old = workflow.read(); workflow.schedule(); finish(); await old;
  for (let attempt = 0; calls < 2 && attempt < 20; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
});
