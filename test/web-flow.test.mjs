import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaperService } from '../src/core.mjs';
import { startLocalWeb } from '../src/local-web.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
test('local manual return imports only its own registered request and preserves source', async t => {
  const owned = path.join(root, 'work/http-tests'); await mkdir(owned, { recursive: true });
  const temporary = await mkdtemp(path.join(owned, 'state-'));
  t.after(async () => { assert.ok(path.resolve(temporary).startsWith(path.resolve(owned) + path.sep)); await rm(temporary, { recursive: true, force: true }); });
  const service = new PaperService({ dataRoot: temporary });
  await service.openProject({ root: path.join(root, 'fixtures/sample-paper'), mainFile: 'main.tex' });
  const baseline = service.getState().project.snapshotId;
  const web = await startLocalWeb({ service }); t.after(() => web.close());
  async function invoke(action, payload) {
    const response = await fetch(web.origin + '/api', { method: 'POST', headers: { Origin: web.origin, 'Content-Type': 'application/json', Authorization: `Bearer ${web.token}` }, body: JSON.stringify({ action, payload }) });
    return response.json();
  }
  const segment = service.getState().segments.find(s => s.translatable);
  const registered = await invoke('createRequest', { kind: 'translation', language: 'zh-CN', segmentIds: [segment.id] });
  const request = registered.result;
  assert.equal(request.bindingId, 'local-preview-manual');
  const imported = await invoke('importResult', { result: { requestId: request.requestId, translations: [{ segmentId: segment.id, text: request.segments[0].text }] } });
  assert.equal(imported.ok, true);
  assert.equal(service.getState().translations['zh-CN'][segment.id].origin, 'ai');
  const denied = await invoke('importResult', { result: { requestId: 'unknown', translations: [] } });
  assert.equal(denied.error.code, 'PERMISSION_DENIED');
  assert.equal(service.getState().project.snapshotId, baseline);
});
