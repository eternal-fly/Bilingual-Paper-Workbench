import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { DesktopQueueBridge, DesktopQueueProducer } from '../src/desktop-queue.mjs';

const threadId = 'exact-desktop-origin';
async function fixture(t, { add, read, ...options } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-queue-')); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], queued = [];
  class Bridge {
    async connect() { calls.push(['connect']); }
    async _request(method, params) {
      calls.push([method, structuredClone(params)]);
      if (method === 'thread/read') return read ? read(params) : { thread: { id: threadId, name: 'Existing Desktop chat', model: 'gpt-6-astra', reasoningEffort: 'max', cwd: root, status: { type: 'notLoaded' } } };
      if (method === 'thread/queue/add') {
        const disk = JSON.parse(await readFile(path.join(root, 'desktop-queue-outbox.json'), 'utf8'));
        assert.equal(disk.receipts.at(-1).status, 'uncertain');
        assert.equal(disk.receipts.at(-1).clientUserMessageId, params.clientUserMessageId);
        if (add) return add(params);
        const queuedSubmission = { id: `queued-${queued.length + 1}`, clientUserMessageId: params.clientUserMessageId, input: params.input }; queued.push(queuedSubmission); return { queuedSubmission };
      }
      if (method === 'thread/queue/list') return { data: queued, nextCursor: null };
      throw Error('Unexpected runtime method: ' + method);
    }
    async close() { calls.push(['close']); }
  }
  const producer = new DesktopQueueProducer({ threadId, dataRoot: root, Bridge, desktopQueueVerified: true, ...options }); t.after(() => producer.close());
  return { producer, root, calls, queued, Bridge };
}

test('desktop queue transport rejects writers, inference, model overrides, tools, foreign identities and unbounded queue reads', async () => {
  const bridge = new DesktopQueueBridge({ threadId, dataRoot: os.tmpdir() });
  for (const [method, params] of [
    ['thread/resume', { threadId }], ['thread/start', {}], ['thread/queue/start', { threadId }], ['turn/start', { threadId }], ['turn/steer', { threadId }], ['thread/settings/update', { threadId }], ['model/list', {}], ['mcpServer/tool/call', {}],
    ['thread/read', { threadId: 'foreign', includeTurns: false }], ['thread/read', { threadId, includeTurns: true }], ['thread/queue/list', { threadId }], ['thread/queue/list', { threadId, limit: 101 }],
    ['thread/queue/add', { threadId, clientUserMessageId: 'id-1', input: [{ type: 'text', text: 'Translation' }], model: 'other' }],
  ]) await assert.rejects(bridge._request(method, params), { code: 'DESKTOP_QUEUE_ONLY' });
  assert.equal(bridge._child, null); assert.equal(bridge._pending.size, 0);
});

test('enqueue verifies the fixed chat and durably records delivery before queue/add, without acquiring its writer', async t => {
  const f = await fixture(t), receipt = await f.producer.enqueue({ clientUserMessageId: 'request-1', text: 'Translate only the registered selection.' });
  assert.equal(receipt.status, 'queued'); assert.equal(receipt.queuedSubmissionId, 'queued-1'); assert.equal(receipt.threadId, threadId);
  assert.equal(f.producer.state().metadata.model, 'gpt-6-astra'); assert.equal(f.producer.state().metadata.effort, 'max');
  assert.deepEqual(f.calls.map(c => c[0]), ['connect', 'thread/read', 'thread/queue/add']);
  const disk = await readFile(path.join(f.root, 'desktop-queue-outbox.json'), 'utf8'); assert.ok(!disk.includes('Translate only')); assert.ok(!disk.includes('Existing Desktop chat'));
  const same = await f.producer.enqueue({ clientUserMessageId: 'request-1', text: 'Translate only the registered selection.' }); assert.deepEqual(same, receipt); assert.equal(f.calls.filter(c => c[0] === 'thread/queue/add').length, 1);
  await assert.rejects(f.producer.enqueue({ clientUserMessageId: 'request-1', text: 'Different request' }), { code: 'DESKTOP_QUEUE_ID_CONFLICT' });
});

test('one verified metadata callback runs before delivery and a denied preflight leaves no outbox receipt or queue call', async t => {
  const f = await fixture(t); let observations = 0;
  await assert.rejects(f.producer.enqueue({ clientUserMessageId: 'metadata-denied', text: 'Do not deliver yet.' }, { beforeEnqueue: async metadata => { observations++; assert.equal(metadata.threadId, threadId); assert.equal(metadata.model, 'gpt-6-astra'); assert.equal(metadata.effort, 'max'); assert.equal(f.calls.some(call => call[0] === 'thread/queue/add'), false); throw Object.assign(new Error('Synthetic metadata persistence denied'), { code: 'EACCES' }); } }), { code: 'EACCES', deliveryAttempted: false, clientUserMessageId: 'metadata-denied' });
  assert.equal(observations, 1); assert.equal(f.producer.state().receipts.length, 0); assert.equal(f.calls.filter(call => call[0] === 'thread/read').length, 1);
  await f.producer.enqueue({ clientUserMessageId: 'metadata-denied', text: 'Do not deliver yet.' }, { beforeEnqueue: async () => { observations++; } });
  assert.equal(observations, 2); assert.equal(f.calls.filter(call => call[0] === 'thread/read').length, 2); assert.equal(f.calls.filter(call => call[0] === 'thread/queue/add').length, 1);
});

test('an outbox persistence refusal is a proven no-delivery failure and may retry after permissions recover', async t => {
  const f = await fixture(t), save = f.producer._save.bind(f.producer); let deny = true;
  f.producer._save = async () => { if (deny) throw Object.assign(new Error('Synthetic outbox write denied'), { code: 'EACCES' }); return save(); };
  await assert.rejects(f.producer.enqueue({ clientUserMessageId: 'outbox-denied', text: 'One exact task.' }), { code: 'EACCES', deliveryAttempted: false });
  assert.equal(f.producer.state().receipts.length, 0); assert.equal(f.calls.some(call => call[0] === 'thread/queue/add'), false);
  deny = false; await f.producer.enqueue({ clientUserMessageId: 'outbox-denied', text: 'One exact task.' }); assert.equal(f.calls.filter(call => call[0] === 'thread/queue/add').length, 1);
});

test('an uncertain delivery survives restart and cannot be automatically enqueued twice', async t => {
  const f = await fixture(t, { add: async () => { throw Object.assign(Error('Acknowledgment lost'), { code: 'CODEX_TIMEOUT' }); } });
  await assert.rejects(f.producer.enqueue({ clientUserMessageId: 'request-uncertain', text: 'Translate this registered selection.' }), { code: 'DESKTOP_QUEUE_DELIVERY_UNCERTAIN' });
  assert.equal(f.producer.state().receipts[0].status, 'uncertain'); await f.producer.close();
  const restored = new DesktopQueueProducer({ threadId, dataRoot: f.root, Bridge: f.Bridge, desktopQueueVerified: true }); t.after(() => restored.close());
  await assert.rejects(restored.enqueue({ clientUserMessageId: 'request-uncertain', text: 'Translate this registered selection.' }), { code: 'DESKTOP_QUEUE_DELIVERY_UNCERTAIN' });
  assert.equal(f.calls.filter(c => c[0] === 'thread/queue/add').length, 1);
});

test('only an exact acknowledged queued payload may resolve an uncertain outbox entry', async t => {
  const f = await fixture(t, { add: async params => ({ queuedSubmission: { id: 'queued-wrong', clientUserMessageId: 'other-request', input: params.input } }) });
  await assert.rejects(f.producer.enqueue({ clientUserMessageId: 'request-1', text: 'Exact protected request' }), { code: 'DESKTOP_QUEUE_DELIVERY_UNCERTAIN' });
  f.queued.push({ id: 'queued-exact', clientUserMessageId: 'request-1', input: [{ type: 'text', text: 'Exact protected request' }] });
  const result = await f.producer.reconcile(); assert.equal(result.receipts[0].status, 'queued'); assert.equal(result.receipts[0].queuedSubmissionId, 'queued-exact'); assert.equal(f.calls.filter(c => c[0] === 'thread/queue/add').length, 1);
});

test('a missing live Desktop gate, foreign metadata or foreign outbox fails before queue mutation', async t => {
  const blocked = await fixture(t, { desktopQueueVerified: false }); await assert.rejects(blocked.producer.enqueue({ clientUserMessageId: 'r', text: 'No delivery' }), { code: 'DESKTOP_QUEUE_UNVERIFIED' }); assert.equal(blocked.calls.length, 0);
  const foreign = await fixture(t, { read: () => ({ thread: { id: 'other-thread', model: 'gpt-6-astra', cwd: os.tmpdir() } }) }); await assert.rejects(foreign.producer.enqueue({ clientUserMessageId: 'r', text: 'No delivery' }), { code: 'THREAD_MISMATCH' }); assert.equal(foreign.calls.some(c => c[0] === 'thread/queue/add'), false);
  const outbox = await fixture(t); await writeFile(path.join(outbox.root, 'desktop-queue-outbox.json'), JSON.stringify({ schemaVersion: 1, threadId: 'other-thread', receipts: [] }));
  await assert.rejects(outbox.producer.enqueue({ clientUserMessageId: 'r', text: 'No delivery' }), { code: 'DESKTOP_QUEUE_RECOVERY_REQUIRED' }); assert.equal(outbox.calls.length, 0);
});


test('concurrent clicks with one delivery identity produce exactly one native queued message', async t => {
  const f = await fixture(t), request = { clientUserMessageId: 'one-click', text: 'Translate one registered paragraph.' };
  const [first, second] = await Promise.all([f.producer.enqueue(request), f.producer.enqueue(request)]);
  assert.deepEqual(first, second); assert.equal(f.calls.filter(call => call[0] === 'thread/queue/add').length, 1);
});

test('closing while metadata is pending prevents subsequent queue mutation', async t => {
  let entered, release; const ready = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { read: () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const queued = f.producer.enqueue({ clientUserMessageId: 'closing-request', text: 'Do not deliver after the service is closed.' }); await ready;
  const closed = f.producer.close(); release({ thread: { id: threadId, model: 'gpt-6-astra', reasoningEffort: 'max', cwd: f.root } });
  await assert.rejects(queued, { code: 'DESKTOP_QUEUE_CLOSED' }); await closed;
  assert.equal(f.calls.some(call => call[0] === 'thread/queue/add'), false);
  await assert.rejects(f.producer.enqueue({ clientUserMessageId: 'late', text: 'No late delivery' }), { code: 'DESKTOP_QUEUE_CLOSED' });
});


test('the installed schema snake-case text_elements acknowledgment is accepted without resending', async t => {
  const f = await fixture(t, { add: async params => ({ queuedSubmission: { id: 'queued-schema', clientUserMessageId: params.clientUserMessageId, input: [{ type: 'text', text: params.input[0].text, text_elements: [] }] } }) });
  const receipt = await f.producer.enqueue({ clientUserMessageId: 'schema-ack', text: 'Exact registered request' });
  assert.equal(receipt.status, 'queued'); assert.equal(receipt.queuedSubmissionId, 'queued-schema'); assert.equal(f.calls.filter(c => c[0] === 'thread/queue/add').length, 1);
});

test('an explicitly verified completed Desktop turn resolves consumed uncertainty without another queue call', async t => {
  const f = await fixture(t, { add: async () => { throw Error('Acknowledgment unavailable'); } }), body = 'Exact observed user request';
  await assert.rejects(f.producer.enqueue({ clientUserMessageId: 'observed', text: body }), { code: 'DESKTOP_QUEUE_DELIVERY_UNCERTAIN' });
  await assert.rejects(f.producer.observeCompleted({ clientUserMessageId: 'observed', turnId: 'completed-turn' }, async () => ({ threadId: 'foreign', turnId: 'completed-turn', status: 'completed', userText: body })), { code: 'DESKTOP_QUEUE_OBSERVATION_MISMATCH' });
  const callsBefore = f.calls.length;
  const receipt = await f.producer.observeCompleted({ clientUserMessageId: 'observed', turnId: 'completed-turn' }, async (thread, turn) => { assert.equal(thread, threadId); assert.equal(turn, 'completed-turn'); return { threadId, turnId: turn, status: 'completed', userText: body }; });
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.observedTurnId, 'completed-turn'); assert.equal(f.calls.length, callsBefore);
  assert.equal((await f.producer.enqueue({ clientUserMessageId: 'observed', text: body })).status, 'completed'); assert.equal(f.calls.filter(c => c[0] === 'thread/queue/add').length, 1);
});

const protocol = String.raw`import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\n');});`;
async function lockFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-queue-lock-')), filename = path.join(root, '.codex-chat.lock');
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }); assert.equal(dead.status, 0);
  const saved = { owner: 'original-dead-owner', pid: dead.pid, createdAt: new Date().toISOString() };
  const bridge = new DesktopQueueBridge({ threadId, dataRoot: root, command: process.execPath }); bridge.args = ['--input-type=module', '-e', protocol];
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  return { root, filename, saved, bridge };
}
test('a queue-private lock left by a proven exited producer recovers without writer or model methods', async t => {
  const f = await lockFixture(t); await writeFile(f.filename, JSON.stringify(f.saved));
  await f.bridge.connect();
  assert.equal(f.bridge.getState().connected, true); assert.equal(f.bridge._loaded, false); assert.equal(f.bridge.getState().threadId, null);
  const owner = JSON.parse(await readFile(f.filename, 'utf8')); assert.equal(owner.pid, process.pid); assert.notEqual(owner.owner, f.saved.owner);
  assert.equal((await readdir(f.root)).some(name => name.includes('quarantine')), false);
});

test('EPERM alone stays locked, while asynchronous OS proof is checked before, after recheck and after quarantine', async t => {
  const f = await lockFixture(t); await writeFile(f.filename, JSON.stringify(f.saved)); const kill = process.kill, proofs = [];
  process.kill = function (pid, signal) { if (pid === f.saved.pid && signal === 0) throw Object.assign(Error('Synthetic Windows EPERM.'), { code: 'EPERM' }); return kill.call(process, pid, signal); };
  try {
    f.bridge.processProbe = async pid => { proofs.push(pid); return true; };
    await f.bridge.connect(); assert.equal(f.bridge.getState().connected, true); assert.deepEqual(proofs, [f.saved.pid, f.saved.pid, f.saved.pid]);
  } finally { process.kill = kill; }
});

test('the default Windows bridge recovers an exited queue owner when Node reports EPERM using real read-only OS probes', { skip: process.platform !== 'win32' }, async t => {
  const f = await lockFixture(t); await writeFile(f.filename, JSON.stringify(f.saved)); const kill = process.kill;
  process.kill = function (pid, signal) { if (pid === f.saved.pid && signal === 0) throw Object.assign(Error('Synthetic Windows EPERM.'), { code: 'EPERM' }); return kill.call(process, pid, signal); };
  try { await f.bridge.connect(); assert.equal(f.bridge.getState().connected, true); assert.equal(JSON.parse(await readFile(f.filename, 'utf8')).pid, process.pid); }
  finally { process.kill = kill; }
});

test('an asynchronous process probe that becomes alive or unknown never deletes the changed owner lock', async t => {
  for (const sequence of [[false], [true, false], [true, true, false]]) {
    const f = await lockFixture(t); const bytes = JSON.stringify(f.saved); await writeFile(f.filename, bytes); const states = [...sequence];
    f.bridge.processProbe = async () => states.shift();
    await assert.rejects(f.bridge.connect()); assert.equal(await readFile(f.filename, 'utf8'), bytes); assert.equal(f.bridge._child, null);
  }
});

test('a quarantine replaced while the final asynchronous PID proof runs is rechecked before deletion', async t => {
  const f = await lockFixture(t); await writeFile(f.filename, JSON.stringify(f.saved)); let quarantine, proofs = 0;
  const move = f.bridge._quarantineQueueLock.bind(f.bridge), replacement = JSON.stringify({ ...f.saved, owner: 'changed-during-final-proof', pid: process.pid });
  f.bridge._quarantineQueueLock = async (filename, target) => { quarantine = target; await move(filename, target); };
  f.bridge.processProbe = async () => { if (++proofs === 3) await writeFile(quarantine, replacement); return true; };
  await assert.rejects(f.bridge.connect(), { code: 'DESKTOP_QUEUE_RECOVERY_REQUIRED' }); assert.equal(await readFile(f.filename, 'utf8'), replacement); assert.equal(f.bridge._child, null);
});
test('live, malformed and non-queue conversation locks remain untouched', async t => {
  for (const kind of ['live', 'malformed', 'conversation']) {
    const f = await lockFixture(t), bytes = kind === 'malformed' ? 'not-json' : JSON.stringify({ ...f.saved, ...(kind === 'live' ? { pid: process.pid } : {}) });
    await writeFile(f.filename, bytes); if (kind === 'conversation') await writeFile(path.join(f.root, 'chat-state.json'), '{}');
    await assert.rejects(f.bridge.connect()); assert.equal(await readFile(f.filename, 'utf8'), bytes); assert.equal(f.bridge._child, null);
  }
});
test('a lock replaced during dead-owner quarantine is restored without taking over the live producer', async t => {
  const f = await lockFixture(t); await writeFile(f.filename, JSON.stringify(f.saved));
  const replacement = JSON.stringify({ ...f.saved, owner: 'live-replacement', pid: process.pid });
  const move = f.bridge._quarantineQueueLock?.bind(f.bridge); assert.equal(typeof move, 'function');
  f.bridge._quarantineQueueLock = async (...args) => { await writeFile(f.filename, replacement); await move(...args); };
  await assert.rejects(f.bridge.connect(), { code: 'DESKTOP_QUEUE_RECOVERY_REQUIRED' });
  assert.equal(await readFile(f.filename, 'utf8'), replacement); assert.equal(f.bridge._child, null);
});
test('a producer acquiring the original name during quarantine is not removed or recovered again', async t => {
  const f = await lockFixture(t); await writeFile(f.filename, JSON.stringify(f.saved));
  const replacement = JSON.stringify({ ...f.saved, owner: 'new-live-producer', pid: process.pid }), move = f.bridge._quarantineQueueLock.bind(f.bridge);
  f.bridge._quarantineQueueLock = async (...args) => { await move(...args); await writeFile(f.filename, replacement); };
  await assert.rejects(f.bridge.connect(), { code: 'CHAT_IN_USE' });
  assert.equal(await readFile(f.filename, 'utf8'), replacement); assert.equal(f.bridge._child, null);
});
test('preflight failure proves no queue delivery only for an identity with no durable receipt', async t => {
  const f = await fixture(t, { read: () => { throw Object.assign(Error('Private control lock occupied'), { code: 'CHAT_IN_USE' }); } });
  await assert.rejects(f.producer.enqueue({ clientUserMessageId: 'preflight-only', text: 'Explicit author message.' }), error => error.code === 'CHAT_IN_USE' && error.deliveryAttempted === false && error.clientUserMessageId === 'preflight-only');
  assert.equal(f.producer.state().receipts.length, 0); assert.equal(f.calls.some(call => call[0] === 'thread/queue/add'), false);
});
