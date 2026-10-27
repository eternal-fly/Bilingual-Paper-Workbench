import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PaperApplication } from '../src/application.mjs';
import { WorkspaceService } from '../src/workspace-service.mjs';
import { createPaperServer } from '../src/server.mjs';

async function connect(t, options) {
  const server = createPaperServer(options), client = new Client({ name: 'onboarding-test', version: '1' });
  const [cs, ss] = InMemoryTransport.createLinkedPair(); await server.connect(ss); await client.connect(cs);
  t.after(async () => { await client.close(); await server.close(); }); return client;
}
test('opening with supplied files opens first, skips unrelated host discovery, then imports in the same background', async t => {
  const calls = [], service = { getState: () => ({ project: null, segments: [] }), bootstrapHostProject: async () => { throw new Error('unrelated host discovery'); } };
  const client = await connect(t, { service, uiHtml: '<!doctype html>', backgroundWindow: true,
    openIndependentWindow: async () => { calls.push('open'); return { opened: true, mode: 'background-workbench' }; },
    dispatchBackground: async (action, payload) => { calls.push(action); assert.equal(payload.files.sourcePath, 'C:/user-supplied/paper.zip'); assert.ok(payload.originBindingId); return { result: { status: 'completed' }, state: { project: { mainFile: 'main.tex' }, segments: [{ id: 'p' }] } }; },
  });
  const result = await client.callTool({ name: 'bilingual_paper_editor', arguments: { sourcePath: 'C:/user-supplied/paper.zip', reviews: [{ path: 'C:/user-supplied/review.zip' }] } });
  assert.equal(result.isError, undefined); assert.deepEqual(calls, ['open', 'importFiles']); assert.equal(result.structuredContent.projectOpen, true);
  assert.equal(result.structuredContent.import.status, 'completed'); assert.equal(result._meta?.ui?.resourceUri, undefined);
});
test('a failed file selection keeps the successfully opened window and gives a retry action', async t => {
  const client = await connect(t, { service: { getState: () => ({ project: null }) }, uiHtml: '<!doctype html>', backgroundWindow: true,
    openIndependentWindow: async () => ({ opened: true, mode: 'background-workbench' }),
    dispatchBackground: async () => { throw Object.assign(new Error('Select the exact main TeX file.'), { code: 'MAIN_FILE_NOT_FOUND' }); },
  });
  const result = await client.callTool({ name: 'bilingual_paper_editor', arguments: { sourcePath: 'C:/user-supplied/paper.zip' } });
  assert.equal(result.isError, undefined); assert.equal(result.structuredContent.window.opened, true);
  assert.equal(result.structuredContent.import.error.code, 'MAIN_FILE_NOT_FOUND'); assert.match(result.structuredContent.import.nextStep, /bilingual_paper_import_files/);
});
test('simultaneous native open and import share one pending window and later imports only update state', async t => {
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), opening = new Promise(resolve => { entered = resolve; });
  let opens = 0, imports = 0;
  const client = await connect(t, { service: { getState: () => ({ project: null }) }, uiHtml: '<!doctype html>', backgroundWindow: true,
    openIndependentWindow: async () => { opens++; entered(); await gate; return { opened: true, mode: 'background-workbench' }; },
    dispatchBackground: async action => { if (action === 'importFiles') imports++; return { result: { status: 'completed' }, state: { project: { mainFile: 'main.tex' } } }; },
  });
  const first = client.callTool({ name: 'bilingual_paper_editor', arguments: {} }); await opening;
  const second = client.callTool({ name: 'bilingual_paper_import_files', arguments: { reviews: [{ path: 'C:/supplied/review.md' }] } });
  await new Promise(resolve => setTimeout(resolve, 10)); release();
  for (const result of await Promise.all([first, second])) assert.equal(result.isError, undefined);
  assert.equal(opens, 1); assert.equal(imports, 1);
  await client.callTool({ name: 'bilingual_paper_import_files', arguments: { reviews: [{ path: 'C:/supplied/another-review.md' }] } });
  assert.equal(opens, 1); assert.equal(imports, 2);
});
test('an already visible native window is reported as reused and repeated imports do not create app cards', async t => {
  const client = await connect(t, { service: { getState: () => ({ project: null }) }, uiHtml: '<!doctype html>', backgroundWindow: true,
    openIndependentWindow: async () => ({ opened: true, mode: 'background-workbench', reusedWindow: true }),
    dispatchBackground: async () => ({ result: { status: 'completed' }, state: { project: { mainFile: 'main.tex' } } }),
  });
  const result = await client.callTool({ name: 'bilingual_paper_editor', arguments: { reviews: [{ path: 'C:/supplied/review.md' }] } });
  assert.equal(result.structuredContent.window.reusedWindow, true);
  assert.match(result.content[0].text, /existing window/i); assert.equal(result._meta?.ui?.resourceUri, undefined);
});
test('source import opens its private copy with the correct initial engine and repeated review import stays idempotent', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paper-onboarding-')), source = path.join(root, 'author'), dataRoot = path.join(root, 'data'), codexRoot = path.join(root, 'chat');
  await mkdir(source); await mkdir(dataRoot); await mkdir(codexRoot);
  const text = '\\documentclass{article}\n\\begin{document}\nThis is the original paragraph.\n\\end{document}\n';
  await writeFile(path.join(source, 'main.tex'), text); const reviewPath = path.join(root, 'review.md'); await writeFile(reviewPath, 'Clarify the original paragraph.');
  const engines = [], factory = async record => {
    engines.push(record?.initialEngine); const app = new PaperApplication({ dataRoot: record?.stateRoot || dataRoot, engine: record?.initialEngine || 'xelatex' }); await app.initialize(); return app;
  };
  const service = new WorkspaceService({ initialApp: await factory(), factory, dataRoot, codexRoot }); await service.initializeWorkspace();
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const first = await service.importFiles({ sourcePath: path.join(source, 'main.tex'), reviews: [{ path: reviewPath }] }, { bindingId: 'import-origin' });
  assert.equal(first.status, 'completed', JSON.stringify(first.reviews)); assert.equal(first.source.engine, 'pdflatex'); assert.equal(service.active.engine, 'pdflatex'); assert.equal(engines.at(-1), 'pdflatex');
  assert.equal(first.reviews[0].status, 'imported'); assert.notEqual(service.getState().workspaceIndex.currentRecord.projectRoot, source);
  assert.equal(first.reviews[0].matching.noteCount, 1);
  const packet = await service.active.getReviewAnchorContext({ requestId: first.reviews[0].matching.requestId }, { bindingId: 'import-origin' });
  assert.equal(packet.noteCount, 1); assert.equal(packet.context.transport, 'native');
  const second = await service.importFiles({ sourcePath: path.join(source, 'main.tex'), reviews: [{ path: reviewPath }] });
  assert.equal(second.source.reused, true); assert.equal(second.reviews[0].duplicate, true); assert.equal(await readFile(path.join(source, 'main.tex'), 'utf8'), text);
  assert.equal(service.getState().reviewNotes.length, 1); assert.equal(service.getState().transactions.length, 0);
  const savedPrepare = service.active.prepareReviewAnchors;
  service.active.prepareReviewAnchors = async () => { throw Object.assign(new Error('Use a smaller matching selection.'), { code: 'REVIEW_ANCHOR_TOO_LARGE' }); };
  const third = await service.importFiles({ reviews: [{ path: reviewPath }] }, { bindingId: 'import-origin' });
  assert.equal(third.status, 'completed'); assert.equal(third.reviews[0].status, 'imported'); assert.equal(third.reviews[0].matching.status, 'unavailable'); assert.equal(service.getState().reviewNotes.length, 1);
  service.active.prepareReviewAnchors = savedPrepare;
  const firstRoot = service.currentRecord.projectRoot, firstRecord = service.currentRecord.recordId;
  service.hostContext = { ...service.hostContext, hostTaskId: 'another-explicit-task' };
  const fourth = await service.importFiles({ sourcePath: path.join(source, 'main.tex') });
  assert.equal(fourth.status, 'completed'); assert.notEqual(service.currentRecord.projectRoot, firstRoot); assert.notEqual(service.currentRecord.recordId, firstRecord);
});
