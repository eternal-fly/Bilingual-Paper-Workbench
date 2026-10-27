import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { startLocalWeb } from '../src/local-web.mjs';

async function fixture(t) {
  let writes = 0;
  const service = { getState: () => ({ eventSeq: writes, project: null }), saveDraft: async () => { writes++; return { revision: writes }; } };
  const web = await startLocalWeb({ service });
  t.after(() => web.close());
  return { ...web, writes: () => writes };
}
function call(web, body, extra = {}) {
  return fetch(web.origin + '/api', { method: 'POST', headers: { Origin: web.origin, 'Content-Type': 'application/json', Authorization: `Bearer ${web.token}`, ...extra }, body: JSON.stringify(body) });
}
test('unauthenticated requests cannot read manuscript state', async t => {
  const web = await fixture(t);
  const res = await call(web, { action: 'state' }, { Authorization: '' });
  assert.equal(res.status, 401);
});
test('foreign origins and DNS rebinding hosts cannot mutate drafts', async t => {
  const web = await fixture(t);
  assert.equal((await call(web, { action: 'saveDraft', payload: {} }, { Origin: 'https://evil.example' })).status, 403);
  // fetch normalizes Host; a raw request is required to exercise DNS rebinding.
  const status = await new Promise((resolve, reject) => {
    const req = http.request(web.origin + '/api', { method: 'POST', headers: { Host: 'evil.example', Origin: web.origin, Authorization: `Bearer ${web.token}`, 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end(JSON.stringify({ action: 'saveDraft', payload: {} }));
  });
  assert.equal(status, 403);
  assert.equal(web.writes(), 0);
});
test('authenticated same-origin UI can save and read state', async t => {
  const web = await fixture(t);
  assert.equal((await call(web, { action: 'saveDraft', payload: {} })).status, 200);
  const res = await call(web, { action: 'state' });
  assert.equal((await res.json()).result.eventSeq, 1);
});
test('model-like apply and prototype action names are never dispatchable', async t => {
  const web = await fixture(t);
  for (const action of ['applyTransaction', '__proto__', 'constructor']) {
    assert.equal((await call(web, { action })).status, 400);
  }
  assert.equal(web.writes(), 0);
});
test('only JSON bodies with strict envelope are accepted', async t => {
  const web = await fixture(t);
  assert.equal((await call(web, { action: 'state', injected: true })).status, 400);
  assert.equal((await call(web, { action: 'state' }, { 'Content-Type': 'text/plain' })).status, 415);
});

test('large review uploads use a separate authenticated route without broadening ordinary requests', async t => {
  let received;
  const service = { getState: () => ({ project: null }), importReviewNotes: async payload => { received = payload.text; return { accepted: true }; } };
  const web = await startLocalWeb({ service }); t.after(() => web.close());
  const text = 'x'.repeat(32 * 1024 * 1024), body = JSON.stringify({ action: 'importReviewNotes', payload: { text } });
  const headers = { Origin: web.origin, 'Content-Type': 'application/json', Authorization: `Bearer ${web.token}` };
  const accepted = await fetch(web.origin + '/api/review-import', { method: 'POST', headers, body });
  assert.equal(accepted.status, 200); assert.ok(received === text, 'The complete 32 MiB extraction must arrive without truncation.');
  assert.equal((await fetch(web.origin + '/api', { method: 'POST', headers, body })).status, 413);
  assert.equal((await fetch(web.origin + '/api/review-import', { method: 'POST', headers: { ...headers, Authorization: '' }, body: '{}' })).status, 401);
  assert.equal((await fetch(web.origin + '/api/review-import', { method: 'POST', headers, body: JSON.stringify({ action: 'state' }) })).status, 400);
});

test('unchanged state polling avoids resending large opinions and invalidates on controller change', async t => {
  const service = new EventEmitter(); let version = 1, reads = 0;
  service.getState = () => { reads++; return { eventSeq: version }; };
  const web = await startLocalWeb({ service }); t.after(() => web.close());
  const first = await call(web, { action: 'state' }); assert.equal(first.status, 200); const etag = first.headers.get('etag'); assert.ok(etag);
  const capturedReads = reads, idle = await call(web, { action: 'state' }, { 'If-None-Match': etag });
  assert.equal(idle.status, 304); assert.equal(reads, capturedReads);
  version++; service.emit('change');
  const changed = await call(web, { action: 'state' }, { 'If-None-Match': etag }); assert.equal(changed.status, 200); assert.notEqual(changed.headers.get('etag'), etag); assert.equal((await changed.json()).state.eventSeq, 2);
});
