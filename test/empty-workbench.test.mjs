import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PaperApplication } from '../src/application.mjs';
import { WorkspaceService } from '../src/workspace-service.mjs';
import { createPaperServer } from '../src/server.mjs';

test('a fresh workspace can open an embedded panel and read status without relay recursion', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paper-empty-'));
  const app = new PaperApplication({ dataRoot: root }); await app.initialize();
  const service = new WorkspaceService({ initialApp: app, factory: async () => app, dataRoot: root, codexRoot: root });
  await service.initializeWorkspace();
  const server = createPaperServer({ service, uiHtml: '<!doctype html>' });
  const client = new Client({ name: 'empty-regression', version: '1' });
  const [cs, ss] = InMemoryTransport.createLinkedPair(); await server.connect(ss); await client.connect(cs);
  t.after(async () => { await client.close(); await server.close(); await service.close(); await rm(root, { recursive: true, force: true }); });
  for (const name of ['bilingual_paper_panel', 'bilingual_paper_get_state']) {
    const result = await client.callTool({ name, arguments: {} });
    assert.equal(result.isError, undefined, result._meta?.paperError?.message);
    assert.equal(result.structuredContent.projectOpen, false);
    assert.equal(result.structuredContent.segmentCount, 0);
    if (name === 'bilingual_paper_panel') {
      const ready = service.nativeRelay.heartbeat({ clientId: 'empty-client', sessionId: result._meta.paperRelaySession, canSendMessage: true });
      assert.equal(ready.reasonCode, 'PROJECT_REQUIRED');
    }
  }
});
