import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaperApplication } from '../src/application.mjs';
import { WorkspaceService } from '../src/workspace-service.mjs';
import { startLocalWeb } from '../src/local-web.mjs';
import { createPaperServer } from '../src/server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHash } from 'node:crypto';

async function fixture(t) {
  const parent = fileURLToPath(new URL('../work/external-job-status-tests/', import.meta.url)); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'case-')); t.after(async () => { assert.ok(directory.startsWith(parent)); await rm(directory, { recursive: true, force: true }); });
  const source = path.join(directory, 'source'); await mkdir(source); const filename = path.join(source, 'main.tex');
  await writeFile(filename, '\\documentclass{article}\n\\begin{document}\n\nA synthetic claim.\n\n\\end{document}\n');
  const app = new PaperApplication({ dataRoot: path.join(directory, 'private') }); await app.openProject({ root: source, mainFile: 'main.tex' }); t.after(() => app.close());
  const active = { jobId: 'job-foreign', kind: 'english', ownerPid: process.ppid, ownerControllerId: 'other-controller', status: 'running', snapshotId: app.getState().project.snapshotId, createdAt: '2026-10-24T00:00:00.000Z' };
  assert.ok(active.ownerPid > 0 && active.ownerPid !== process.pid);
  app.flow.jobs.push(active); app.flow.builds.push({ buildId: 'keep-local-build' }); app.flow.transactions.push({ transactionId: 'keep-local-transaction' });
  const workflow = path.join(app.core._store, 'workflow.json'); await writeFile(workflow, JSON.stringify(app.flow));
  return { app, directory, filename, workflow, active, terminal: () => ({ ...structuredClone(active), status: 'completed', completedAt: '2026-10-24T01:00:00.000Z', buildId: 'foreign-build' }) };
}
const call = (web, etag) => fetch(`${web.origin}/api`, { method: 'POST', headers: { Origin: web.origin, Authorization: `Bearer ${web.token}`, 'Content-Type': 'application/json', ...(etag ? { 'If-None-Match': etag } : {}) }, body: JSON.stringify({ action: 'state' }) });

test('authenticated HTTP polling refreshes external terminal jobs before ETag and preserves source/build/transaction state', async t => {
  const f = await fixture(t), beforeSource = await readFile(f.filename);
  const service = new WorkspaceService({ initialApp: f.app, factory: async () => { throw new Error('Must not start another controller'); }, dataRoot: path.join(f.directory, 'registry'), codexRoot: path.join(f.directory, 'chat') });
  const web = await startLocalWeb({ service }); t.after(() => web.close());
  const first = await call(web); assert.equal(first.status, 200); const etag = first.headers.get('etag'); assert.equal((await first.json()).result.jobs[0].status, 'running');
  assert.equal((await call(web, etag)).status, 304);
  const external = { ...structuredClone(f.app.flow), jobs: [f.terminal()], builds: [{ buildId: 'must-not-import' }], transactions: [{ transactionId: 'must-not-import' }] };
  const disk = JSON.stringify(external); await writeFile(f.workflow, disk);
  const changed = await call(web, etag); assert.equal(changed.status, 200); assert.notEqual(changed.headers.get('etag'), etag);
  const state = (await changed.json()).result; assert.equal(state.jobs[0].status, 'completed'); assert.equal(state.jobs[0].controllable, false);
  assert.equal(state.builds[0].buildId, 'keep-local-build'); assert.equal(state.transactions[0].transactionId, 'keep-local-transaction');
  assert.equal((await call(web, changed.headers.get('etag'))).status, 304);
  assert.equal(await readFile(f.workflow, 'utf8'), disk); assert.deepEqual(await readFile(f.filename), beforeSource);
});

test('external refresh refuses own runtime jobs and mismatched owner/controller/kind identities', async t => {
  const f = await fixture(t); let changes = 0; f.app.on('change', () => changes++);
  const variants = [
    { ...f.active, jobId: 'job-own-runtime' },
    { ...f.active, jobId: 'job-owner-mismatch' },
    { ...f.active, jobId: 'job-controller-mismatch' },
    { ...f.active, jobId: 'job-kind-mismatch' },
    { ...f.active, jobId: 'job-current-pid', ownerPid: process.pid },
  ];
  f.app.flow.jobs = structuredClone(variants); f.app.jobs.set('job-own-runtime', { finished: false });
  const incoming = variants.map(job => ({ ...job, status: 'completed' })); incoming[1].ownerPid++; incoming[2].ownerControllerId = 'different-controller'; incoming[3].kind = 'baseline';
  await writeFile(f.workflow, JSON.stringify({ ...f.app.flow, jobs: incoming }));
  const result = await f.app.refreshExternalJobStatus(); assert.equal(result.changed, false); assert.equal(changes, 0);
  assert.ok(f.app.flow.jobs.every(job => job.status === 'running'));
});

test('malformed, foreign-project and duplicate-job workflows fail closed without writing or emitting changes', async t => {
  const f = await fixture(t); let changes = 0; f.app.on('change', () => changes++);
  for(const value of ['{invalid-json', JSON.stringify({ ...f.app.flow, schemaVersion: 2, jobs: [f.terminal()] }), JSON.stringify({ ...f.app.flow, projectId: 'different-project', jobs: [f.terminal()] }), JSON.stringify({ ...f.app.flow, jobs: [f.terminal(), f.terminal()] })]) {
    await writeFile(f.workflow, value); assert.equal((await f.app.refreshExternalJobStatus()).changed, false); assert.equal(f.app.flow.jobs[0].status, 'running'); assert.equal(await readFile(f.workflow, 'utf8'), value);
  }
  assert.equal(changes, 0);
});

test('native UI state aliases await external refresh while getState stays synchronous', async t => {
  const f = await fixture(t); assert.equal(typeof f.app.getState().then, 'undefined');
  const server = createPaperServer({ service: f.app, uiHtml: '<!doctype html><title>Synthetic state refresh</title>' });
  const [a,b] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'synthetic-external-jobs', version: '1.0.0' });
  t.after(async () => { await client.close(); await server.close(); }); await server.connect(b); await client.connect(a);
  const opened = await client.callTool({ name: 'bilingual_paper_panel', arguments: {} }), uiToken = opened._meta.paperUiToken;
  for(const action of ['state','getState']) {
    f.app.flow.jobs[0] = structuredClone(f.active); await writeFile(f.workflow, JSON.stringify({ ...f.app.flow, jobs: [f.terminal()] }));
    const response = await client.callTool({ name: 'bilingual_paper_ui', arguments: { action, payload: {}, uiToken } });
    assert.equal(response.isError, undefined); assert.equal(response._meta.paperState.jobs[0].status, 'completed');
  }
});

test('workspace polling calibrates exact validated Desktop requests and exposes only unfinished runtimes as controllable', async t => {
  const f = await fixture(t), sourceBefore = await readFile(f.filename), deliveries = [];
  const selection = { threadId: 'status-audit-chat', model: 'synthetic-model', effort: 'high', title: 'Synthetic paper' };
  const service = new WorkspaceService({ initialApp: f.app, factory: async () => { throw Error('No new controller'); }, dataRoot: path.join(f.directory, 'registry'), codexRoot: path.join(f.directory, 'chat'), createDesktopProducer: async () => ({ state: () => ({ desktopQueueVerified: true }), close: async () => {}, enqueue: async (input, { beforeEnqueue }) => {
    await beforeEnqueue({ ...selection, cwd: path.dirname(f.filename) }); deliveries.push(input);
    return { threadId: selection.threadId, clientUserMessageId: input.clientUserMessageId, inputHash: createHash('sha256').update(input.text).digest('hex'), status: 'queued', queuedSubmissionId: 'status-audit-delivery' };
  } }) });
  t.after(() => service.desktopExecution.close());
  await f.app._flowAction(() => { f.app.flow.backgroundChatReference = { ...selection, projectId: f.app.getState().project.id }; });
  await service.desktopExecution.bind({ app: f.app, project: f.app.getState().project, selection });
  const segmentId = f.app.getState().segments[0].id;
  const request = await f.app.createRequest({ kind: 'translation', segmentIds: [segmentId], language: 'zh-CN', bindingId: `desktop:${selection.threadId}` });
  const sent = await service.runDesktopRequest({ requestId: request.requestId });
  assert.equal(service.getState().desktopExecution.activity.busy, true);
  assert.equal(f.app.getState().jobs.find(job => job.jobId === sent.jobId).controllable, true);
  await f.app.submitTranslationResult({ requestId: request.requestId, translations: [{ segmentId, text: '一项合成的主张。' }] });
  const refreshed = await service.refreshExternalJobStatus(); assert.equal(refreshed.changed, true);
  const state = service.getState(), job = state.jobs.find(row => row.jobId === sent.jobId);
  assert.equal(job.status, 'completed'); assert.equal(job.controllable, false);
  assert.equal(state.desktopExecution.activity.busy, false); assert.equal(state.desktopExecution.messages[0].resultState, 'validated');
  assert.equal(f.app.jobs.get(sent.jobId).finished, true); assert.equal(deliveries.length, 1);
  assert.deepEqual(await readFile(f.filename), sourceBefore);
});
