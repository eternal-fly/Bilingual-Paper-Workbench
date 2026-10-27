import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPaperServer } from '../src/server.mjs';
import { callBackgroundModelTool } from '../src/native-tool-dispatch.mjs';

test('background model channel validates tool name and uses actual daemon state', async () => {
  const service = { getState: () => ({ project: { id: 'project-new', snapshotId: 'snapshot-new' }, segments: [{ id: 'new' }], translations: {}, proposals: [] }) };
  const result = await callBackgroundModelTool(service, { name: 'bilingual_paper_get_state', arguments: {}, bindingId: 'origin-1' });
  assert.equal(result.structuredContent.projectOpen, true); assert.equal(result.structuredContent.segmentCount, 1);
  for (const name of ['bilingual_paper_ui', 'applyTransaction', 'bilingual_paper_panel', 'bilingual_paper_import_files']) {
    await assert.rejects(callBackgroundModelTool(service, { name, arguments: {}, bindingId: 'origin-1' }), { code: 'MODEL_TOOL_NOT_ALLOWED' });
  }
});

test('after independent open native status reads daemon instead of stale MCP state', async t => {
  const calls = [], service = { getState: () => ({ project: null, segments: [], translations: {}, proposals: [] }) };
  const server = createPaperServer({ service, uiHtml: '<!doctype html>', backgroundWindow: true,
    openIndependentWindow: async () => ({ opened: true, mode: 'background-workbench' }),
    dispatchBackground: async (action, payload) => { calls.push({ action, payload }); return { ok: true, result: { content: [{ type: 'text', text: 'daemon' }], structuredContent: { projectOpen: true, segmentCount: 123 } } }; },
  });
  const client = new Client({ name: 'forward-test', version: '1' }), [cs, ss] = InMemoryTransport.createLinkedPair();
  await server.connect(ss); await client.connect(cs); t.after(async () => { await client.close(); await server.close(); });
  await client.callTool({ name: 'bilingual_paper_editor', arguments: {} });
  const result = await client.callTool({ name: 'bilingual_paper_get_state', arguments: {} });
  assert.equal(result.structuredContent.projectOpen, true); assert.equal(result.structuredContent.segmentCount, 123);
  assert.equal(calls.at(-1).action, 'callNativeTool'); assert.equal(calls.at(-1).payload.name, 'bilingual_paper_get_state');
});


test('concurrent origins wait for the active model operation before replacing its private client', async () => {
  let enter,release,active=0,peak=0,calls=0;
  const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const service={getState:()=>({project:{id:'same-paper',snapshotId:'same-version'},segments:[],translations:{},proposals:[]}),refreshExternalJobStatus:async()=>{active++;peak=Math.max(peak,active);if(++calls===1){enter();await gate;}active--;}};
  const invoke=bindingId=>callBackgroundModelTool(service,{name:'bilingual_paper_get_state',arguments:{},bindingId}).then(result=>({result}),error=>({error}));
  const first=invoke('origin-active');await entered;
  const second=invoke('origin-next');await new Promise(resolve=>setImmediate(resolve));release();
  const results=await Promise.all([first,second]);
  assert.equal(peak,1,'a later origin must not close or overlap the active client');
  for(const outcome of results){assert.equal(outcome.error,undefined);assert.equal(outcome.result.structuredContent.projectOpen,true);}
  assert.equal(calls,2);
});


test('a queued model tool rechecks import ownership immediately before invoking its handler', async () => {
  let enter,release,calls=0;
  const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const service={getState:()=>({project:{id:'current-paper',snapshotId:'current-version'},segments:[],translations:{},proposals:[]}),refreshExternalJobStatus:async()=>{if(++calls===1){enter();await gate;}}};
  const invoke=()=>callBackgroundModelTool(service,{name:'bilingual_paper_get_state',arguments:{},bindingId:'same-origin'});
  const first=invoke();await entered;
  const queued=invoke().then(result=>({result}),error=>({error}));
  service._assistantImportPromise=Promise.resolve();release();await first;
  const blocked=await queued;assert.equal(blocked.error?.code,'IMPORT_BUSY');assert.equal(calls,1,'queued handler must not read partial import state');
  service._assistantImportPromise=null;const resumed=await invoke();assert.equal(resumed.structuredContent.projectOpen,true);assert.equal(calls,2);
});
