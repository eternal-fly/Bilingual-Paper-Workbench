import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaperApplication } from '../src/application.mjs';

class SyntheticChat extends EventEmitter {
  constructor({ timeout = false } = {}) {
    super(); this.timeout = timeout; this.turns = new Map(); this.sequence = 0;
    this.state = { connected: true, threadId: 'synthetic-scope-thread', busy: false, turnId: null, messages: [] };
  }
  getState() { return structuredClone(this.state); }
  async connect() { this.state.connected = true; return this.getState(); }
  async bindPaper({ projectId }) { this.state.paperBinding = projectId; return this.getState(); }
  async sendMessage() {
    const turnId = `synthetic-scope-turn-${++this.sequence}`;
    this.state.busy = true; this.state.turnId = turnId;
    let resolve; const promise = new Promise(done => { resolve = done; });
    this.turns.set(turnId, { promise, resolve });
    return { threadId: this.state.threadId, turnId };
  }
  waitForTurn(turnId) {
    if (this.timeout) return Promise.reject(Object.assign(new Error('Synthetic bounded turn timeout.'), { code: 'TURN_TIMEOUT' }));
    return this.turns.get(turnId).promise;
  }
  complete(turnId, status = 'interrupted') {
    const result = { threadId: this.state.threadId, turnId, status };
    this.state.busy = false; this.state.turnId = null;
    this.turns.get(turnId)?.resolve(result); this.emit('turnCompleted', result);
  }
  async close() { for (const turnId of this.turns.keys()) this.complete(turnId); this.state.connected = false; }
}

async function fixture(t, chatOptions) {
  const owned = fileURLToPath(new URL('../work/chat-scope-tests/', import.meta.url));
  await mkdir(owned, { recursive: true }); const temporary = await mkdtemp(path.join(owned, 'case-'));
  const source = path.join(temporary, 'source'); await mkdir(source);
  await writeFile(path.join(source, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\nFirst selected paragraph.\n\nSecond selected paragraph.\n\n\\end{document}\n');
  const chat = new SyntheticChat(chatOptions), app = new PaperApplication({ dataRoot: path.join(temporary, 'private'), chat });
  await app.openProject({ root: source, mainFile: 'main.tex' });
  t.after(async () => {
    await app.close();
    await Promise.allSettled([...app.jobs.values()].map(job => job.promise));
    assert.ok(path.resolve(temporary).startsWith(path.resolve(owned) + path.sep));
    await rm(temporary, { recursive: true, force: true });
  });
  const segments = app.getState().segments.filter(segment => segment.translatable);
  const requests = [];
  for (const segment of segments) requests.push(await app.createRequest({ kind: 'translation', segmentIds: [segment.id] }));
  return { app, chat, segments, requests };
}

test('a selected Codex turn cannot read or mutate another pending request in the same paper chat', async t => {
  const { app, segments, requests: [previous, selected] } = await fixture(t);
  const started = await app.runRequest({ requestId: selected.requestId });
  const context = { threadId: started.threadId, turnId: started.turnId, callId: 'synthetic-cross-request' };
  await assert.rejects(app.handlePaperTool('paper_get_request', { requestId: previous.requestId }, context), { code: 'REQUEST_NOT_APPROVED' });
  await assert.rejects(app.handlePaperTool('paper_submit_translation', {
    requestId: previous.requestId, translations: [{ segmentId: segments[0].id, text: 'Unselected replacement.' }],
  }, context), { code: 'REQUEST_NOT_APPROVED' });
  assert.equal(app.getState().translations['zh-CN']?.[segments[0].id], undefined);
  assert.equal((await app.handlePaperTool('paper_get_request', { requestId: selected.requestId }, context)).requestId, selected.requestId);
});

test('an ordinary chat turn does not acquire mutation authority from a previous request binding', async t => {
  const { app, segments, requests: [previous] } = await fixture(t);
  const started = await app.chatSend({ text: 'Discuss the workflow without a selected paper request.' });
  await assert.rejects(app.handlePaperTool('paper_submit_translation', {
    requestId: previous.requestId, translations: [{ segmentId: segments[0].id, text: 'Unselected replacement.' }],
  }, { threadId: started.threadId, turnId: started.turnId, callId: 'synthetic-unscoped-chat' }), { code: 'REQUEST_NOT_APPROVED' });
  assert.equal(app.getState().translations['zh-CN']?.[segments[0].id], undefined);
});

test('a Codex wait timeout records a terminal failed job and releases the selected request scope', async t => {
  const { app, requests: [selected] } = await fixture(t, { timeout: true });
  const started = await app.runRequest({ requestId: selected.requestId });
  await assert.rejects(app.waitJob({ jobId: started.jobId }), { code: 'TURN_TIMEOUT' });
  const job = app.getState().jobs.find(item => item.jobId === started.jobId);
  assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'TURN_TIMEOUT');
  await assert.rejects(app.handlePaperTool('paper_get_request', { requestId: selected.requestId }, {
    threadId: started.threadId, turnId: started.turnId, callId: 'synthetic-after-timeout',
  }), { code: 'REQUEST_NOT_APPROVED' });
});
