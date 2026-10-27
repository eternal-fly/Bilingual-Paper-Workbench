import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PaperApplication } from '../src/application.mjs';
import { createPaperServer } from '../src/server.mjs';
import { startLocalWeb } from '../src/local-web.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const emptyReading = { status: 'text', renderKey: 'synthetic-reading-key', fields: {}, pdf: null, fragments: [], diagnostics: [] };
async function fixture(t) {
  const owned = path.join(root, 'work/opinion-read-api-tests'); await mkdir(owned, { recursive: true });
  const temporary = await mkdtemp(path.join(owned, 'case-')), source = path.join(temporary, 'source'); await mkdir(source);
  const before = Buffer.from('\\documentclass{article}\n\\newcommand{\\Ns}{N^{*}}\n\\begin{document}\n\nA synthetic claim has $\\Ns$ explicit assumptions.\n\n\\end{document}\n');
  await writeFile(path.join(source, 'main.tex'), before);
  const compiler = { probe: async () => ({ available: true, isolated: true }), build: async () => { throw new Error('The API capture test must not compile a paper.'); } };
  const app = new PaperApplication({ dataRoot: path.join(temporary, 'private'), compiler });
  await app.initialize(); await app.openProject({ root: source, mainFile: 'main.tex' });
  const imported = await app.importReviewNotes({ filename: 'synthetic-review.txt', format: 'txt', fileHash: 'a'.repeat(64), text: 'State the assumptions explicitly.' });
  const note = app.getState().reviewNotes[0];
  t.after(async () => { await app.close(); assert.ok(path.resolve(temporary).startsWith(path.resolve(owned) + path.sep)); await rm(temporary, { recursive: true, force: true }); });
  return { app, source, before, note, batch: imported.batch, input: { noteId: note.noteId, expectedRevision: note.revision } };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('opinion reading captures immutable authorized inputs and leaves source, workflow, drafts and history unchanged', async t => {
  const { app, source, before, note, input } = await fixture(t);
  const stateBefore = app.core.getState(), flowBefore = structuredClone(app.flow); let captured;
  app.opinionMath.render = async value => { captured = value; return emptyReading; };
  const output = await app.compileReviewNote(input);
  assert.equal(output.projectId, stateBefore.project.id); assert.equal(output.noteId, note.noteId); assert.equal(output.noteRevision, 1);
  assert.equal(output.sourceSnapshotId, stateBefore.project.snapshotId); assert.equal(output.language, 'zh-CN');
  assert.equal(captured.files.length, 1); assert.equal(captured.files[0].path, 'main.tex');
  assert.notEqual(captured.files[0].bytes, app.core._files.get('main.tex').bytes); assert.deepEqual(captured.files[0].bytes, before);
  assert.notEqual(captured.note, app.core._state.reviewNotes[0]);
  assert.deepEqual(app.core.getState(), stateBefore); assert.deepEqual(app.flow, flowBefore); assert.equal(app.jobs.size, 0);
  assert.equal(app._pendingOps, 0); assert.deepEqual(await readFile(path.join(source, 'main.tex')), before);
});

test('opinion reading rejects arbitrary TeX, paths, language overrides, unknown notes and stale revisions before rendering', async t => {
  const { app, input } = await fixture(t); let renders = 0;
  app.opinionMath.render = async () => { renders++; return emptyReading; };
  for (const bad of [null, [], {}, { ...input, tex: '\\input{private}' }, { ...input, path: 'other.tex' }, { ...input, language: 'fr' }, { ...input, expectedRevision: 0 }, { ...input, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }]) await assert.rejects(app.compileReviewNote(bad), { code: 'INVALID_INPUT' });
  await assert.rejects(app.compileReviewNote({ ...input, noteId: 'missing-note' }), { code: 'REVIEW_NOTE_NOT_FOUND' });
  await assert.rejects(app.compileReviewNote({ ...input, expectedRevision: 2 }), { code: 'VERSION_CONFLICT' });
  assert.equal(renders, 0);
});

test('a late reading result cannot overwrite a newer opinion, language choice or import retirement', async t => {
  for (const change of ['decision', 'language', 'retire']) {
    const { app, source, input, batch } = await fixture(t), started = deferred(), resume = deferred();
    app.opinionMath.render = async () => { started.resolve(); await resume.promise; return emptyReading; };
    const pending = app.compileReviewNote(input); await started.promise;
    if (change === 'decision') await app.setReviewDecision({ ...input, decision: 'keep' });
    else if (change === 'language') await app.configureLanguages({ translationLanguage: 'fr', expectedRevision: 0 });
    else {
      const retirement = { batchId: batch.batchId, expectedFileHash: 'a'.repeat(64), expectedRevision: 1, active: false };
      await assert.rejects(app.setReviewImportActive(retirement), { code: 'PROJECT_BUSY' });
      const other = new PaperApplication({ dataRoot: app.dataRoot });
      await other.openProject({ root: source, mainFile: 'main.tex' }); await other.setReviewImportActive(retirement); await other.close();
    }
    resume.resolve(); await assert.rejects(pending, { code: change === 'retire' ? 'REVIEW_NOTE_NOT_FOUND' : 'VERSION_CONFLICT' });
    assert.equal(app._pendingOps, 0); assert.equal(app.flow.builds.length, 0); assert.equal(app.flow.transactions.length, 0);
  }
});

test('source edits during typesetting reject the late result without changing source or registering a paper build', async t => {
  const { app, source, before, input } = await fixture(t), started = deferred(), resume = deferred();
  app.opinionMath.render = async () => { started.resolve(); await resume.promise; return emptyReading; };
  const pending = app.compileReviewNote(input); await started.promise;
  const changed = Buffer.concat([before, Buffer.from('% external author edit\n')]); await writeFile(path.join(source, 'main.tex'), changed);
  resume.resolve(); await assert.rejects(pending, { code: 'VERSION_CONFLICT' });
  assert.deepEqual(await readFile(path.join(source, 'main.tex')), changed); assert.equal(app.flow.lastBaselineBuildId, null); assert.equal(app.flow.builds.length, 0);
});

test('unverified compiler cannot typeset opinions, and project switching waits for an outstanding reading request', async t => {
  const { app, source, input } = await fixture(t);
  app.probe = { available: true, isolated: false }; await assert.rejects(app.compileReviewNote(input), { code: 'COMPILER_UNAVAILABLE' });
  app.probe = { available: true, isolated: true }; const started = deferred(), resume = deferred();
  app.opinionMath.render = async () => { started.resolve(); await resume.promise; return emptyReading; };
  const pending = app.compileReviewNote(input); await started.promise;
  await assert.rejects(app.openProject({ root: source, mainFile: 'main.tex' }), { code: 'PROJECT_BUSY' });
  resume.resolve(); await pending; assert.equal(app._pendingOps, 0);
});

test('formula reading is available only through authenticated UI transport with strict note identity payloads', async t => {
  const { app, input } = await fixture(t); app.opinionMath.render = async () => emptyReading;
  const server = createPaperServer({ service: app, uiHtml: '<!doctype html>' }), client = new Client({ name: 'synthetic-opinion-reading', version: '1' }), [cs, ss] = InMemoryTransport.createLinkedPair();
  await server.connect(ss); await client.connect(cs); t.after(async () => { await client.close(); await server.close(); });
  const listed = await client.listTools(); assert.ok(!listed.tools.some(tool => /compile.*review|opinion.*math/i.test(tool.name)));
  const ui = listed.tools.find(tool => tool.name === 'bilingual_paper_ui'); assert.deepEqual(ui._meta.ui.visibility, ['app']); assert.ok(ui.inputSchema.properties.action.enum.includes('compileReviewNote'));
  const denied = await client.callTool({ name: 'bilingual_paper_ui', arguments: { action: 'compileReviewNote', payload: input } }); assert.equal(denied.structuredContent.error.code, 'UI_AUTHORIZATION_REQUIRED');
  const panel = await client.callTool({ name: 'bilingual_paper_panel', arguments: {} }), uiToken = panel._meta.paperUiToken;
  const accepted = await client.callTool({ name: 'bilingual_paper_ui', arguments: { action: 'compileReviewNote', payload: input, uiToken } }); assert.equal(accepted.isError, undefined, accepted._meta?.paperError?.message); assert.equal(accepted._meta.paperResult.noteId, input.noteId);
  const invalid = await client.callTool({ name: 'bilingual_paper_ui', arguments: { action: 'compileReviewNote', payload: { ...input, tex: '\\input{private}' }, uiToken } }); assert.equal(invalid.isError, true);
  const web = await startLocalWeb({ service: app, nativeBindingId: 'synthetic-reading-host' }); t.after(() => web.close());
  const call = (payload, authenticated = true) => fetch(web.origin + '/api', { method: 'POST', headers: { Origin: web.origin, 'Content-Type': 'application/json', Authorization: authenticated ? 'Bearer ' + web.token : '' }, body: JSON.stringify({ action: 'compileReviewNote', payload }) });
  assert.equal((await call(input, false)).status, 401);
  const result = await (await call(input)).json(); assert.equal(result.ok, true); assert.equal(result.result.noteId, input.noteId); assert.equal(result.transport.mode, 'native-window');
  const rejected = await (await call({ ...input, tex: '\\input{private}' })).json(); assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'INVALID_INPUT');
});
