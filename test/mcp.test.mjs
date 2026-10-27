import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));

async function launch(t) {
  const testRoot = path.join(pluginRoot, 'work');
  await mkdir(testRoot, { recursive: true });
  const dataRoot = await mkdtemp(path.join(testRoot, 'mcp-test-'));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: pluginRoot,
    env: { ...process.env, PAPER_EDITOR_DATA_ROOT: dataRoot, PAPER_EDITOR_WORKSPACE: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let pending = new Map();
  let nextId = 0;
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch (error) { for (const item of pending.values()) item.reject(error); pending.clear(); continue; }
      const item = pending.get(message.id);
      if (item) { clearTimeout(item.timer); pending.delete(message.id); item.resolve(message); }
    }
  });
  child.on('exit', code => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(`MCP server exited ${code}: ${stderr}`));
    }
    pending.clear();
  });
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    assert.ok(path.resolve(dataRoot).startsWith(path.resolve(testRoot) + path.sep));
    await rm(dataRoot, { recursive: true, force: true });
  });
  async function request(method, params = {}) {
    const id = ++nextId;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP request timed out: ${method}; ${stderr}`)); }, 10000);
      pending.set(id, { resolve, reject, timer });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return result;
  }
  const initialized = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'synthetic-mcp-test', version: '1.5.2' },
  });
  assert.equal(initialized.result?.serverInfo?.name, 'bilingual-paper-editor', 'server must complete the real MCP initialize exchange');
  assert.equal(initialized.result.serverInfo.version, '1.5.2');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return request;
}

test('native MCP exposes a thread workbench and keeps UI operations outside model tools', async t => {
  const request = await launch(t);
  const response = await request('tools/list');
  assert.equal(response.error, undefined);
  const tools = response.result.tools;
  const windowEntry = tools.find(tool => tool.name === 'bilingual_paper_editor');
  assert.ok(windowEntry);
  assert.equal(windowEntry._meta?.ui?.resourceUri,undefined,'default background opener does not mount a relay card');
  const entry = tools.find(tool => tool.name === 'bilingual_paper_panel');
  assert.ok(entry);
  assert.deepEqual(entry._meta['openai/ui'].entrypoints, [{ type: 'thread' }]);
  assert.equal(entry._meta.ui.resourceUri, 'ui://bilingual-paper-editor/workbench/v1.5.2');
  assert.equal(entry.inputSchema.required?.length ?? 0, 0);
  const ui = tools.find(tool => tool.name === 'bilingual_paper_ui');
  assert.deepEqual(ui._meta.ui.visibility, ['app']);
  assert.ok(!tools.some(tool => /apply|accept|write_source|open_project/.test(tool.name)));
  const opened = await request('tools/call', { name: 'bilingual_paper_panel', arguments: {} });
  assert.equal(opened.result.isError, undefined);
  assert.equal(opened.result.structuredContent.projectOpen, false);
  assert.ok(opened.result._meta.paperState);
  assert.equal(typeof opened.result._meta.paperUiToken, 'string');
  assert.ok(!JSON.stringify({ content: opened.result.content, structuredContent: opened.result.structuredContent }).includes(opened.result._meta.paperUiToken));
  assert.ok(!JSON.stringify(opened.result.structuredContent).includes('segments'));
});

test('MCP rejects arbitrary roots, unavailable source writeback, and unapproved segment reads', async t => {
  const request = await launch(t);
  for (const action of ['openProject', 'acceptProposal', 'applyTransaction']) {
    const response = await request('tools/call', {
      name: 'bilingual_paper_ui', arguments: { action, payload: { root: 'C:/' } },
    });
    assert.equal(response.result.isError, true, action);
  }
  const segments = await request('tools/call', {
    name: 'bilingual_paper_read_segments', arguments: { requestId: 'unapproved', segmentIds: ['invented'] },
  });
  assert.equal(segments.result.isError, true);
  const forgedSelection = await request('tools/call', {
    name: 'bilingual_paper_ui', arguments: { action: 'createRequest', payload: { segmentIds: ['invented'], kind: 'discussion' } },
  });
  assert.equal(forgedSelection.result.isError, true);
  assert.equal(forgedSelection.result.structuredContent?.error?.code, 'UI_AUTHORIZATION_REQUIRED');
  const wrongCapability = await request('tools/call', {
    name: 'bilingual_paper_ui', arguments: { action: 'createRequest', payload: { segmentIds: ['invented'], kind: 'discussion' }, uiToken: 'forged-ui-capability' },
  });
  assert.equal(wrongCapability.result.isError, true);
  assert.equal(wrongCapability.result.structuredContent?.error?.code, 'UI_AUTHORIZATION_REQUIRED');
});

test('MCP serves only selected request text and preserves the authoritative source version', async t => {
  const request = await launch(t);
  const entry = await request('tools/call', { name: 'bilingual_paper_panel', arguments: {} });
  const uiToken = entry.result._meta.paperUiToken;
  assert.equal(typeof uiToken, 'string');
  const ui = (action, payload = {}) => request('tools/call', { name: 'bilingual_paper_ui', arguments: { action, payload, uiToken } });
  const demo = await ui('demo');
  assert.equal(demo.result.isError, undefined, JSON.stringify(demo.result._meta));
  const state = demo.result._meta.paperState;
  assert.equal(demo.result.structuredContent.sourceVersion, state.project.snapshotId);
  const segment = state.segments.find(segment => segment.translatable);
  assert.ok(segment);
  const created = await ui('createRequest', { segmentIds: [segment.id], kind: 'translation', language: 'zh-CN', bindingId: 'attacker-controlled' });
  assert.equal(created.result.isError, undefined, JSON.stringify(created.result._meta));
  const selection = created.result._meta.paperResult;
  assert.equal(selection.bindingId, created.result._meta.instanceId);
  const selected = await request('tools/call', { name: 'bilingual_paper_get_request', arguments: { requestId: selection.requestId } });
  assert.equal(selected.result.isError, undefined);
  assert.equal(selected.result.structuredContent.segments.length, 1);
  assert.equal(selected.result.structuredContent.segments[0].segmentId, segment.id);
  const outside = await request('tools/call', { name: 'bilingual_paper_read_segments', arguments: { requestId: selection.requestId, segmentIds: ['unselected'] } });
  assert.equal(outside.result.isError, true);
  const wrongKind = await request('tools/call', { name: 'bilingual_paper_propose_revision', arguments: { requestId: selection.requestId, edits: [{ segmentId: segment.id, beforeHash: segment.beforeHash, replacement: segment.displayText }], reason: 'Synthetic test' } });
  assert.equal(wrongKind.result.isError, true);
  const translated = await request('tools/call', {
    name: 'bilingual_paper_submit_translation_result', arguments: { requestId: selection.requestId, translations: [{ segmentId: segment.id, text: segment.displayText }] },
  });
  assert.equal(translated.result.isError, undefined, JSON.stringify(translated.result._meta?.paperError));
  assert.equal(translated.result.structuredContent.status, 'completed');
  const draft = translated.result._meta.paperState.translations['zh-CN'][segment.id];
  const saved = await ui('saveDraft', { segmentId: segment.id, language: 'zh-CN', text: '人工审查草稿', expectedRevision: draft.revision });
  assert.equal(saved.result.isError, undefined, JSON.stringify(saved.result._meta?.paperError));
  assert.equal(saved.result._meta.paperState.translations['zh-CN'][segment.id].origin, 'human');
  const before = await readFile(path.join(pluginRoot, 'fixtures/sample-paper/main.tex'));
  const revisionRequest = await ui('createRequest', { segmentIds: [segment.id], kind: 'revision', language: 'zh-CN' });
  const proposal = await request('tools/call', {
    name: 'bilingual_paper_propose_revision', arguments: { requestId: revisionRequest.result._meta.paperResult.requestId, edits: [{ segmentId: segment.id, beforeHash: segment.beforeHash, replacement: segment.displayText + ' (revised)' }], reason: 'Synthetic transport review test' },
  });
  assert.equal(proposal.result.isError, undefined, JSON.stringify(proposal.result._meta?.paperError));
  assert.equal(proposal.result.structuredContent.reviewState, 'pending');
  assert.equal(proposal.result.structuredContent.applicationState, 'notApplied');
  assert.deepEqual(await readFile(path.join(pluginRoot, 'fixtures/sample-paper/main.tex')), before);
});

test('registered UI resource is delivered through the actual MCP resource protocol', async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createPaperServer, WORKBENCH_URI } = await import('../src/server.mjs');
  const server = createPaperServer({ service: { getState: () => ({ project: null, segments: [], proposals: [] }) }, uiHtml: '<!doctype html><title>Synthetic workbench</title>' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'synthetic-resource-test', version: '1.5.2' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverSide);
  await client.connect(clientSide);
  const response = await client.readResource({ uri: WORKBENCH_URI });
  assert.equal(response.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.match(response.contents[0].text, /Synthetic workbench/);
  assert.deepEqual(response.contents[0]._meta.ui.csp.connectDomains, []);
});

test('native UI accepts large review payloads and 5000 opinions while ordinary model inputs stay bounded', async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createPaperServer } = await import('../src/server.mjs');
  const service = { getState: () => ({ project: null }), importReviewNotes: async payload => ({ bytes: Buffer.byteLength(payload.text), notes: payload.annotations.length, page: payload.annotations.at(-1).page }) };
  const server = createPaperServer({ service, uiHtml: '<!doctype html><title>Synthetic capacity</title>' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'synthetic-large-review', version: '1.5.2' });
  t.after(async () => { await client.close(); await server.close(); }); await server.connect(serverSide); await client.connect(clientSide);
  const entry = await client.callTool({ name: 'bilingual_paper_panel', arguments: {} }), uiToken = entry._meta.paperUiToken;
  const text = 'Synthetic large review.\n'.repeat(110000), annotations = Array.from({ length: 5000 }, () => ({ body: 'Opinion.', page: 2000 }));
  const result = await client.callTool({ name: 'bilingual_paper_ui', arguments: { action: 'importReviewNotes', payload: { filename: 'synthetic.pdf', format: 'pdf', fileHash: 'a'.repeat(64), text, annotations }, uiToken } });
  assert.equal(result.isError, undefined, result._meta?.paperError?.message); assert.deepEqual(result._meta.paperResult, { bytes: Buffer.byteLength(text), notes: 5000, page: 2000 });
  const ordinary = await client.callTool({ name: 'bilingual_paper_ui', arguments: { action: 'chatSend', payload: { text:'X'.repeat(8*1024*1024+1) }, uiToken } });
  assert.equal(ordinary.isError, true); assert.equal(ordinary._meta.paperError.code, 'INPUT_TOO_LARGE');
});

