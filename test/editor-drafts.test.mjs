import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EditorDraftStore } from '../src/editor-drafts.mjs';

const scope = { expectedProjectId: 'paper-one', expectedSnapshotId: 'snapshot-one' };
const clientId = 'editor-window-one';
const digest = text => createHash('sha256').update(text).digest('hex');
function fixture(t, options = {}) {
  const project = { id: 'paper-one', snapshotId: 'snapshot-one' };
  const store = new EditorDraftStore({ getProject: () => project, isKnownParagraph: id => ['paragraph-one', 'paragraph-two'].includes(id), captureTimeoutMs: 40, ...options });
  t.after(() => store.close());
  const row = { segmentId: 'paragraph-one', language: 'zh-CN', text: '未保存的输入 $x^2$，以及未完成的 $', baseDraftRevision: 8, bufferSequence: 9, saveState: 'saveFailed', composing: false, selectionStart: 5, selectionEnd: 5 };
  const publish = (captureId = null, sequence = 1, drafts = [row], extra = {}) => store.publish({ ...scope, clientId, sequence, captureId, drafts, ...extra });
  return { store, project, row, publish };
}

test('a fresh native capture returns exact failed unsaved input without saving or substituting a persisted draft', async t => {
  const { store, row, publish } = fixture(t);
  store.poll({ ...scope, clientId });
  const pending = store.read(scope);
  const challenge = store.poll({ ...scope, clientId });
  assert.ok(challenge.captureId);
  publish(challenge.captureId);
  const captured = await pending;
  assert.equal(captured.fresh, true);
  assert.equal(captured.drafts[0].text, row.text);
  assert.equal(captured.drafts[0].textHash, digest(row.text));
  assert.equal(captured.drafts[0].baseDraftRevision, 8);
  assert.equal(captured.drafts[0].saveState, 'saveFailed');
  assert.equal(captured.sourceWriteback, 'human_ui_only');
  assert.equal(store.poll({ ...scope, clientId }).captureId, null);
});

test('a native read during page startup waits for its first authenticated editor handshake', async t => {
  const { store, row, publish } = fixture(t);
  const pending = store.read(scope);
  const challenge = store.poll({ ...scope, clientId });
  assert.ok(challenge.captureId);
  publish(challenge.captureId);
  assert.equal((await pending).drafts[0].text, row.text);
});

test('read never labels a cached snapshot fresh when the live window does not answer', async t => {
  const { store, publish } = fixture(t);
  publish();
  await assert.rejects(store.read(scope), { code: 'EDITOR_CAPTURE_TIMEOUT' });
});

test('a disconnected or ambiguous editor is explicit instead of guessing a browser window', async t => {
  const { store } = fixture(t);
  await assert.rejects(store.read(scope), { code: 'EDITOR_NOT_CONNECTED' });
  store.poll({ ...scope, clientId });
  store.poll({ ...scope, clientId: 'second-editor-window' });
  await assert.rejects(store.read(scope), { code: 'EDITOR_WINDOW_AMBIGUOUS' });
});

test('out-of-order publications cannot replace the current editor text or satisfy a new capture challenge', async t => {
  const { store, row, publish } = fixture(t);
  publish(null, 4, [{ ...row, text: 'newer human input', bufferSequence: 12 }]);
  const pending = store.read(scope), challenge = store.poll({ ...scope, clientId });
  const ignored = publish(challenge.captureId, 3);
  assert.equal(ignored.accepted, false);
  publish(challenge.captureId, 5, [{ ...row, text: 'newer human input', bufferSequence: 12 }]);
  assert.equal((await pending).drafts[0].text, 'newer human input');
});

test('paper or source changes reject a captured continuation and cannot leak another paper buffer', async t => {
  const { store, project, publish } = fixture(t);
  publish();
  const pending = store.read(scope), challenge = store.poll({ ...scope, clientId });
  publish(challenge.captureId, 2);
  const captured = await pending;
  project.snapshotId = 'snapshot-two';
  await assert.rejects(store.read({ ...scope, captureId: captured.captureId }), { code: 'VERSION_CONFLICT' });
  assert.throws(() => store.publish({ ...scope, clientId, sequence: 3, drafts: [] }), { code: 'VERSION_CONFLICT' });
});

test('capture preserves IME composition and filters only explicitly requested current paragraph IDs', async t => {
  const { store, row, publish } = fixture(t);
  publish();
  const pending = store.read({ ...scope, segmentIds: ['paragraph-two'], language: 'zh-CN' });
  publish(store.poll({ ...scope, clientId }).captureId, 2, [row, { ...row, segmentId: 'paragraph-two', text: '正在输入', composing: true, selectionStart: 4, selectionEnd: 4 }]);
  const captured = await pending;
  assert.equal(captured.drafts.length, 1);
  assert.equal(captured.drafts[0].text, '正在输入');
  assert.equal(captured.drafts[0].composing, true);
  assert.throws(() => store.publish({ ...scope, clientId, sequence: 3, drafts: [{ ...row, segmentId: 'foreign-paragraph' }] }), { code: 'EDITOR_SCOPE_INVALID' });
});

test('a native save refuses newer input, active composition and changed draft revisions without writing', async t => {
  let saves = 0;
  const { store, row, publish } = fixture(t, { saveDraft: async () => { saves++; } });
  publish();
  const pending = store.read(scope);
  publish(store.poll({ ...scope, clientId }).captureId, 2);
  const captured = await pending;
  const saving = store.save({ ...scope, captureId: captured.captureId, segmentId: row.segmentId, language: row.language, baseDraftRevision: 8, textHash: digest(row.text) });
  await Promise.resolve();
  publish(store.poll({ ...scope, clientId }).captureId, 3, [{ ...row, text: 'newer input', bufferSequence: 10 }]);
  await assert.rejects(saving, { code: 'EDITOR_BUFFER_CHANGED' });
  assert.equal(saves, 0);
});

test('an explicitly requested save forwards only the exact fresh captured human text and revision', async t => {
  let received;
  const { store, row, publish } = fixture(t, { saveDraft: async payload => { received = payload; return { draft: { revision: 9, text: payload.text } }; } });
  publish();
  const pending = store.read(scope);
  publish(store.poll({ ...scope, clientId }).captureId, 2);
  const captured = await pending;
  const saving = store.save({ ...scope, captureId: captured.captureId, segmentId: row.segmentId, language: row.language, baseDraftRevision: 8, textHash: digest(row.text) });
  await Promise.resolve();
  publish(store.poll({ ...scope, clientId }).captureId, 3);
  const result = await saving;
  assert.deepEqual(received, { ...scope, segmentId: row.segmentId, language: row.language, text: row.text, expectedRevision: 8 });
  assert.equal(result.draft.revision, 9);
});

test('an asynchronous native scope rejection is awaited before a save can start', async t => {
  let saves = 0;
  const { store, row, publish } = fixture(t, { saveDraft: async () => { saves++; return {}; } });
  publish();
  const pending = store.read(scope); publish(store.poll({ ...scope, clientId }).captureId, 2); const captured = await pending;
  const saving = store.save({ ...scope, captureId: captured.captureId, segmentId: row.segmentId, language: row.language, baseDraftRevision: 8, textHash: digest(row.text) }, { beforeWrite: async () => { await Promise.resolve(); throw Object.assign(new Error('The caller was revoked.'), { code: 'THREAD_MISMATCH' }); } });
  await Promise.resolve(); publish(store.poll({ ...scope, clientId }).captureId, 3);
  await assert.rejects(saving, { code: 'THREAD_MISMATCH' }); assert.equal(saves, 0);
});
