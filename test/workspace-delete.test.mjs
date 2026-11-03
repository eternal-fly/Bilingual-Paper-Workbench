import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskRegistry } from '../src/task-registry.mjs';
import { WorkspaceService } from '../src/workspace-service.mjs';
import { PaperApplication } from '../src/application.mjs';
import { startLocalWeb } from '../src/local-web.mjs';

const owned = fileURLToPath(new URL('../work/workspace-delete-tests/', import.meta.url));
const source = '\\documentclass{article}\n\\begin{document}\n\nSynthetic retained manuscript.\n\n\\end{document}\n';
async function fixture(t) {
  await mkdir(owned, { recursive: true }); const root = await mkdtemp(path.join(owned, 'case-'));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(owned) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const paper = path.join(root, 'paper'); await mkdir(paper); await writeFile(path.join(paper, 'main.tex'), source);
  return { root, paper, dataRoot: path.join(root, 'private'), codexRoot: path.join(root, 'chat') };
}
function chat() { const value = new EventEmitter(); value.state = { busy: false, threadId: null }; value.getState = () => structuredClone(value.state); value.close = async () => { value.closed = true; }; return value; }
async function controller(f) {
  const factory = async record => new PaperApplication({ dataRoot: record?.stateRoot || f.dataRoot, chat: chat() });
  const service = new WorkspaceService({ initialApp: await factory(null), factory, dataRoot: f.dataRoot, codexRoot: f.codexRoot, hostOptions: { native: false } });
  await service.initializeWorkspace(); await service.openProject({ root: f.paper, mainFile: 'main.tex' }); return service;
}
function guard(service, record) { const state = service.getState(); return { recordId: record.recordId, expectedRevision: record.revision, currentRecordId: state.workspaceIndex.currentRecordId, projectId: state.project?.id || null, snapshotId: state.project?.snapshotId || null }; }

test('delete hides metadata, removes exact chat selections and restores the same record without touching any retained file', async t => {
  const f = await fixture(t), registry = new TaskRegistry(f); let record = await registry.register({ projectRoot: f.paper, mainFile: 'main.tex', hostTaskId: 'synthetic-task' });
  record = await registry.touch(record.recordId, { threadId: 'synthetic-chat', model: 'synthetic-model', effort: 'high' });
  await registry.selectForChat({ recordId: record.recordId, threadId: 'synthetic-chat', hostProjectRoot: f.paper }); record = await registry.get(record.recordId);
  await mkdir(record.stateRoot, { recursive: true }); await mkdir(record.chatRoot, { recursive: true });
  const files = [[path.join(f.paper, 'main.tex'), source], [path.join(record.stateRoot, 'draft.json'), '{"draft":"retained"}'], [path.join(record.stateRoot, 'reviews.json'), '{"review":"retained"}'], [path.join(record.chatRoot, 'chat.json'), '{"messages":["retained"]}']];
  for (const [filename, text] of files) await writeFile(filename, text);
  const deleted = await registry.delete(record.recordId, { expectedRevision: record.revision });
  assert.ok(deleted.deletedAt); assert.equal(deleted.revision, record.revision + 1); assert.deepEqual(await registry.records(), []); assert.equal(await registry.chatSelection('synthetic-chat'), null);
  await assert.rejects(registry.get(record.recordId), { code: 'WORKSPACE_RECORD_DELETED' });
  await assert.rejects(registry.register({ projectRoot: f.paper, mainFile: 'main.tex', hostTaskId: 'synthetic-task' }), { code: 'WORKSPACE_RECORD_DELETED' });
  await assert.rejects(registry.touch(record.recordId, { threadId: 'other-chat' }), { code: 'WORKSPACE_RECORD_DELETED' });
  assert.equal((await registry.records({ deleted: 'deleted' }))[0].recordId, record.recordId);
  const restored = await registry.restore(record.recordId, { expectedRevision: deleted.revision });
  assert.equal(restored.recordId, record.recordId); assert.equal(restored.threadId, 'synthetic-chat'); assert.equal(restored.model, 'synthetic-model'); assert.equal(restored.effort, 'high'); assert.equal(restored.deletedAt, undefined); assert.equal(await registry.chatSelection('synthetic-chat'), null);
  for (const [filename, text] of files) assert.equal(await readFile(filename, 'utf8'), text);
});

test('metadata deletion and restoration reject stale revisions and malformed flags before changing the index', async t => {
  const f = await fixture(t), registry = new TaskRegistry(f), first = await registry.register({ projectRoot: f.paper, mainFile: 'main.tex' });
  const latest = await registry.touch(first.recordId, { paperTitle: 'Updated synthetic title' }); const before = await readFile(registry.filename);
  await assert.rejects(registry.delete(first.recordId, { expectedRevision: first.revision }), { code: 'WORKSPACE_RECORD_CHANGED' });
  await assert.rejects(registry.delete(first.recordId, {}), { code: 'INVALID_INPUT' }); assert.deepEqual(await readFile(registry.filename), before);
  const deleted = await registry.delete(first.recordId, { expectedRevision: latest.revision });
  await assert.rejects(registry.restore(first.recordId, { expectedRevision: latest.revision }), { code: 'WORKSPACE_RECORD_CHANGED' });
  await assert.rejects(registry.records({ deleted: 'yes' }), { code: 'INVALID_INPUT' });
  assert.equal((await registry.get(first.recordId, { includeDeleted: true })).revision, deleted.revision);
});

test('selected deletion detaches to an empty editor and restoration recovers saved drafts and binding', async t => {
  const f = await fixture(t), service = await controller(f); t.after(() => service.close()); const segment = service.getState().segments.find(item => item.translatable);
  await service.saveDraft({ segmentId: segment.id, language: 'zh-CN', text: 'Synthetic retained draft.', expectedRevision: 0 });
  Object.assign(service.chat.state, { threadId: 'retained-worker', model: 'synthetic-model', effort: 'high' }); service.chat.emit('change');
  let record = (await service.listWorkspaces()).records[0]; const previous = service.active, result = await service.deleteWorkspaceRecord(guard(service, record));
  assert.equal(result.deletedRecordId, record.recordId); assert.equal(service.getState().project, null); assert.equal(service.getState().workspaceIndex.currentRecordId, null); assert.equal(previous.chat.closed, true); assert.equal((await service.listWorkspaces()).records.length, 0);
  const index = await service.listWorkspaces({ deleted: 'deleted' }); record = index.records[0]; assert.ok(record.deletedAt);
  await service.restoreWorkspaceRecord({ recordId: record.recordId, expectedRevision: record.revision }); assert.equal(service.getState().project, null);
  await service.openWorkspaceRecord({ recordId: record.recordId }); assert.equal(service.getState().translations['zh-CN'][segment.id].text, 'Synthetic retained draft.'); assert.equal(service.currentRecord.threadId, 'retained-worker'); assert.equal(await readFile(path.join(f.paper, 'main.tex'), 'utf8'), source);
});

test('busy work, stale pane identity and failed empty-editor setup preserve the selected task', async t => {
  const f = await fixture(t), service = await controller(f); t.after(() => service.close()); const record = (await service.listWorkspaces()).records[0], captured = guard(service, record), app = service.active;
  service.chat.state.busy = true; await assert.rejects(service.deleteWorkspaceRecord(captured), { code: 'PROJECT_BUSY' }); service.chat.state.busy = false;
  await assert.rejects(service.deleteWorkspaceRecord({ ...captured, snapshotId: 'stale' }), { code: 'WORKSPACE_RECORD_CHANGED' });
  service.factory = async () => { throw Error('Synthetic empty setup failure'); }; await assert.rejects(service.deleteWorkspaceRecord(captured), /empty setup failure/);
  assert.equal(service.active, app); assert.notEqual(service.chat.closed, true); assert.equal((await service.listWorkspaces()).records.length, 1);
});

test('deleting another task retains the active controller and a failed metadata transaction closes no editor', async t => {
  const f = await fixture(t), service = await controller(f); t.after(() => service.close()); const other = await service.registry.register({ projectRoot: f.paper, mainFile: 'main.tex', hostTaskId: 'other-task' }), app = service.active;
  await service.deleteWorkspaceRecord(guard(service, other)); assert.equal(service.active, app); assert.notEqual(app.chat.closed, true);
  const selected = (await service.listWorkspaces()).records[0], before = service.registry.delete.bind(service.registry); service.registry.delete = async () => { throw Error('Synthetic metadata failure'); };
  await assert.rejects(service.deleteWorkspaceRecord(guard(service, selected)), /metadata failure/); service.registry.delete = before;
  assert.equal(service.active, app); assert.notEqual(app.chat.closed, true); assert.equal((await service.listWorkspaces()).records.length, 1);
});

test('failed selected-controller close rolls back its exact explicit chat selection with the record', async t => {
  const f = await fixture(t), service = await controller(f); t.after(() => service.close());
  let record = await service.registry.touch(service.currentRecord.recordId, { threadId: 'selected-chat', model: 'synthetic-model' });
  await service.registry.selectForChat({ recordId: record.recordId, threadId: record.threadId, hostProjectRoot: f.paper }); record = await service.registry.get(record.recordId);
  const selection = await service.registry.chatSelection(record.threadId), previous = service.active, close = previous.close.bind(previous);
  previous.close = async () => { throw Error('Synthetic close failure'); };
  await assert.rejects(service.deleteWorkspaceRecord(guard(service, record)), /close failure/); previous.close = close;
  assert.equal(service.active, previous); assert.equal((await service.registry.get(record.recordId)).deletedAt, undefined); assert.deepEqual(await service.registry.chatSelection(record.threadId), selection);
});

test('legacy schema-one records without revision retain revision-zero delete and restore compatibility', async t => {
  const f = await fixture(t), registry = new TaskRegistry(f), record = await registry.register({ projectRoot: f.paper, mainFile: 'main.tex' });
  const legacy = JSON.parse(await readFile(registry.filename, 'utf8')); delete legacy.records[0].revision; await writeFile(registry.filename, JSON.stringify(legacy));
  assert.equal((await registry.records())[0].revision, 0);
  const deleted = await registry.delete(record.recordId, { expectedRevision: 0 }); assert.equal(deleted.revision, 1);
  assert.equal((await registry.restore(record.recordId, { expectedRevision: 1 })).recordId, record.recordId);
});

test('durable current-paper writeback phases block delete, restore and switch with no live runtime jobs', async t => {
  const f = await fixture(t), service = await controller(f); t.after(() => { service.flow.oneClickWritebacks = []; return service.close(); });
  const selected = (await service.listWorkspaces()).records[0], captured = guard(service, selected), projectId = service.getState().project.id;
  const other = await service.registry.register({ projectRoot: f.paper, mainFile: 'main.tex', hostTaskId: 'other-task' }), deleted = await service.registry.delete(other.recordId, { expectedRevision: other.revision });
  service.jobs.clear(); assert.equal(service.jobs.size, 0);
  const task = status => ({ taskId: 'synthetic-writeback', status, projectId, authorization: { drafts: [] } });
  for (const status of ['preparing', 'waiting-model', 'compiling', 'applying', 'awaiting-editor', 'recovery-required']) {
    service.flow.oneClickWritebacks = [task(status)];
    await assert.rejects(service.deleteWorkspaceRecord(captured), { code: 'PROJECT_BUSY' }, status);
    await assert.rejects(service.restoreWorkspaceRecord({ recordId: deleted.recordId, expectedRevision: deleted.revision }), { code: 'PROJECT_BUSY' }, status);
    await assert.rejects(service.openWorkspaceRecord({ recordId: selected.recordId }), { code: 'PROJECT_BUSY' }, status);
  }
  service.flow.oneClickWritebacks = [task('completed'), task('cancelled'), task('stale'), task('failed'), { ...task('waiting-model'), projectId: 'another-paper' }];
  assert.doesNotThrow(() => service._assertIdle());
  await service.restoreWorkspaceRecord({ recordId: deleted.recordId, expectedRevision: deleted.revision });
  assert.equal((await service.listWorkspaces()).records.length, 2);
});

test('authenticated local web deletes and restores a task while denied requests preserve its exact source and saved draft', { timeout: 15000 }, async t => {
  const f = await fixture(t), service = await controller(f);
  t.after(() => service.close());
  const segment = service.getState().segments.find(item => item.translatable), draftText = 'Synthetic retained draft with $x=1$ and literal citation text.';
  await service.saveDraft({ segmentId: segment.id, language: 'zh-CN', text: draftText, expectedRevision: 0 });
  const sourceFile = path.join(f.paper, 'main.tex'), draftFile = path.join(service.active.core._store, 'state.json');
  const retained = [[sourceFile, await readFile(sourceFile)], [draftFile, await readFile(draftFile)]];
  const record = (await service.listWorkspaces()).records[0], payload = guard(service, record), beforeIndex = await readFile(service.registry.filename);
  const web = await startLocalWeb({ service }); t.after(() => web.close());
  const api = (action, value = {}, headers = {}) => fetch(web.origin + '/api', { method: 'POST', headers: { Origin: web.origin, Authorization: 'Bearer ' + web.token, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ action, payload: value }) });
  for (const [headers, status] of [[{ Authorization: 'Bearer invalid' }, 401], [{ Origin: 'https://invalid.example' }, 403]]) {
    const denied = await api('deleteWorkspaceRecord', payload, headers); assert.equal(denied.status, status); assert.equal((await denied.json()).ok, false);
    assert.deepEqual(await readFile(service.registry.filename), beforeIndex);
    for (const [filename, bytes] of retained) assert.deepEqual(await readFile(filename), bytes);
  }
  const deleted = await (await api('deleteWorkspaceRecord', payload)).json();
  assert.equal(deleted.ok, true); assert.equal(deleted.result.deletedRecordId, record.recordId); assert.equal(deleted.state.project, null);
  const active = await (await api('listWorkspaces')).json(); assert.equal(active.ok, true); assert.deepEqual(active.result.records, []);
  const history = await (await api('listWorkspaces', { deleted: 'deleted' })).json(); assert.equal(history.ok, true); assert.equal(history.result.records.length, 1);
  const tombstone = history.result.records[0]; assert.equal(tombstone.recordId, record.recordId); assert.ok(tombstone.deletedAt);
  const restored = await (await api('restoreWorkspaceRecord', { recordId: tombstone.recordId, expectedRevision: tombstone.revision })).json();
  assert.equal(restored.ok, true); assert.equal(restored.result.restoredRecordId, record.recordId); assert.equal(restored.state.project, null);
  for (const [filename, bytes] of retained) assert.deepEqual(await readFile(filename), bytes);
  const reopened = await (await api('openWorkspaceRecord', { recordId: record.recordId })).json(); assert.equal(reopened.ok, true);
  assert.equal(reopened.state.translations['zh-CN'][segment.id].text, draftText); assert.deepEqual(await readFile(sourceFile), retained[0][1]);
});
