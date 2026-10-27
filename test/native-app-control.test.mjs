import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeAppControl } from '../scripts/native-app-control.mjs';

function fixture(mode = 'configuration') {
  const control = new NativeAppControl({ transportMode: mode }), sent = [];
  control.child = { exitCode: 0, stdin: { writable: true, write: text => sent.push(JSON.parse(text)) } };
  return { control, sent };
}
test('configuration-only process refuses thread, model, MCP and resource operations before sending bytes', async () => {
  const { control, sent } = fixture();
  for (const method of ['thread/start', 'thread/resume', 'turn/start', 'model/list', 'mcpServerStatus/list', 'mcpServer/tool/call', 'mcpServer/resource/read', 'config/mcpServer/reload']) await assert.rejects(control.request(method, {}), { code: 'CONFIGURATION_ONLY' });
  assert.throws(() => control.notify('thread/unsubscribe', {}), { code: 'CONFIGURATION_ONLY' });
  assert.equal(sent.length, 0); assert.equal(control.pending.size, 0); await control.close();
});
test('configuration-only process permits exact versioned config methods and initialization notification', async () => {
  const { control, sent } = fixture();
  for (const method of ['initialize', 'config/read', 'config/batchWrite', 'config/value/write']) {
    const pending = control.request(method, { synthetic: true }); const id = sent.at(-1).id;
    control._read(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result: { metadataOnly: true } }) + '\n'));
    assert.deepEqual(await pending, { metadataOnly: true });
  }
  control.notify('initialized', {}); assert.equal(sent.length, 5); await control.close();
});
test('native proxy keeps runtime methods available and propagates bounded RPC method/code diagnostics', async () => {
  const { control, sent } = fixture('proxy'); const pending = control.request('mcpServerStatus/list', { threadId: 'synthetic-id' });
  control._read(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: sent[0].id, error: { code: -32601, message: 'unsupported' } }) + '\n'));
  await assert.rejects(pending, { code: 'NATIVE_RPC_ERROR', rpcCode: -32601, rpcMethod: 'mcpServerStatus/list' }); await control.close();
});
