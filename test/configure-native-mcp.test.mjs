import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureNativeMcp, nativeServerConfiguration } from '../scripts/configure-native-mcp.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = { type: 'stdio', command: process.execPath, args: [path.join(root, 'dist/server.mjs')], env: { PAPER_EDITOR_FULL_RUNTIME: '1', PAPER_EDITOR_INSTALL_VERSION: '0.4.1', PAPER_EDITOR_DATA_ROOT: path.join(root, 'work/synthetic-private') } };
const file = path.join(root, 'work/synthetic-config/config.toml');
function fixture(initial, { onWrite = () => {}, failWrite = false } = {}) {
  let config = structuredClone(initial), version = 'v1'; const calls = [];
  const client = { request: async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === 'config/read') return { config: structuredClone(config), layers: [{ name: { type: 'user', file }, version, config: structuredClone(config) }], origins: {} };
    assert.equal(method, 'config/batchWrite'); assert.equal(params.filePath, file); assert.equal(params.expectedVersion, version); assert.equal(params.reloadUserConfig, true); assert.equal(params.edits.length, 1); assert.equal(params.edits[0].keyPath, 'mcp_servers.bilingual-paper-editor'); assert.equal(params.edits[0].mergeStrategy, 'replace');
    if (failWrite) throw Object.assign(new Error('Configuration revision changed.'), { code: 'VERSION_CONFLICT' });
    config.mcp_servers ||= {}; config.mcp_servers['bilingual-paper-editor'] = structuredClone(params.edits[0].value); onWrite(config); version = 'v2'; return { filePath: file, version, status: 'ok' };
  } };
  return { client, calls, current: () => structuredClone(config) };
}
test('registration edits one versioned server section while preserving unrelated settings and MCP servers', async () => {
  const initial = { model: 'author-model', features: { custom: true }, mcp_servers: { 'another-server': { command: 'other', env: { PRIVATE_SYNTHETIC_TOKEN: 'do-not-log-this' } } }, custom: { retained: [1, 2] } };
  const f = fixture(initial), result = await configureNativeMcp({ client: f.client, serverConfig: server });
  assert.deepEqual(f.calls.map(c => c.method), ['config/read', 'config/batchWrite', 'config/read']); assert.equal(result.desktopClosureVerified, false); assert.equal(result.otherConfigurationPreserved, true);
  const next = f.current(); assert.deepEqual(next.mcp_servers['another-server'], initial.mcp_servers['another-server']); assert.equal(next.model, initial.model); assert.deepEqual(next.features, initial.features); assert.deepEqual(next.custom, initial.custom);
  assert.equal(next.mcp_servers['bilingual-paper-editor'].startup_timeout_sec, 120); assert.equal(next.mcp_servers['bilingual-paper-editor'].tool_timeout_sec, 600); assert.equal(next.mcp_servers['bilingual-paper-editor'].required, undefined);
  assert.ok(!JSON.stringify(result).includes('do-not-log-this'));
});
test('DryRun validates conflicts but never calls config writes or thread/model APIs', async () => {
  const f = fixture({ model: 'author-model' }), result = await configureNativeMcp({ client: f.client, serverConfig: server, dryRun: true });
  assert.equal(result.changed, true); assert.equal(result.dryRun, true); assert.deepEqual(f.calls.map(c => c.method), ['config/read']); assert.deepEqual(f.current(), { model: 'author-model' });
});
test('existing owned configuration preserves custom tool restrictions and environment while upgrading timeouts', async () => {
  const existing = { ...nativeServerConfiguration(server), tool_timeout_sec: 60, disabled_tools: ['an-author-restricted-tool'], env: { ...server.env, CUSTOM_SYNTHETIC_ENV: 'keep-this' } };
  const f = fixture({ mcp_servers: { 'bilingual-paper-editor': existing } }); await configureNativeMcp({ client: f.client, serverConfig: server });
  const saved = f.current().mcp_servers['bilingual-paper-editor']; assert.equal(saved.tool_timeout_sec, 600); assert.equal(saved.env.CUSTOM_SYNTHETIC_ENV, 'keep-this'); assert.deepEqual(saved.disabled_tools, existing.disabled_tools);
});
test('identical existing registration is idempotent and performs no write', async () => {
  const f = fixture({ mcp_servers: { 'bilingual-paper-editor': nativeServerConfiguration(server) } }), result = await configureNativeMcp({ client: f.client, serverConfig: server });
  assert.equal(result.configured, true); assert.equal(result.changed, false); assert.deepEqual(f.calls.map(c => c.method), ['config/read']);
});
test('foreign command or arguments with the same name fail closed before a write', async () => {
  for (const existing of [{ command: path.join(root, 'foreign.exe'), args: server.args }, { command: server.command, args: [path.join(root, 'foreign.mjs')] }]) {
    const f = fixture({ mcp_servers: { 'bilingual-paper-editor': existing } }); await assert.rejects(configureNativeMcp({ client: f.client, serverConfig: server }), { code: 'NATIVE_MCP_NAME_CONFLICT' }); assert.equal(f.calls.length, 1);
  }
});
test('unsupported installed transport, extra environment authority and ambiguous user layers fail before mutation', async () => {
  for (const invalid of [{ ...server, type: 'http' }, { ...server, args: ['relative/server.mjs'] }, { ...server, env: { ...server.env, HOME: 'other' } }]) {
    const f = fixture({}); await assert.rejects(configureNativeMcp({ client: f.client, serverConfig: invalid }), { code: 'INVALID_NATIVE_MCP_CONFIG' }); assert.equal(f.calls.length, 0);
  }
  const client = { request: async method => { assert.equal(method, 'config/read'); return { layers: [], config: {} }; } };
  await assert.rejects(configureNativeMcp({ client, serverConfig: server }), { code: 'NATIVE_CONFIG_LAYER_UNAVAILABLE' });
});
test('configuration version conflict propagates without retrying or replacing unrelated data', async () => {
  const f = fixture({ model: 'author-model' }, { failWrite: true }); await assert.rejects(configureNativeMcp({ client: f.client, serverConfig: server }), { code: 'VERSION_CONFLICT' });
  assert.deepEqual(f.current(), { model: 'author-model' }); assert.equal(f.calls.length, 2);
});
test('readback detects unrelated concurrent setting changes and does not claim successful preservation', async () => {
  const f = fixture({ model: 'author-model' }, { onWrite: config => { config.model = 'concurrently-changed-model'; } });
  await assert.rejects(configureNativeMcp({ client: f.client, serverConfig: server }), { code: 'NATIVE_CONFIG_PRESERVATION_FAILED' }); assert.equal(f.calls.length, 3);
});
