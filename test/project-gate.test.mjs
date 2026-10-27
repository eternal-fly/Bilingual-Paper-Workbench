import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaperApplication } from '../src/application.mjs';
test('project switch is blocked before an asynchronous compiler job registers', async t => {
  const owned = fileURLToPath(new URL('../work/project-gate-tests/', import.meta.url)); await mkdir(owned, { recursive: true });
  const dir = await mkdtemp(path.join(owned, 'case-')); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['first', 'second']) { await mkdir(path.join(dir, name)); await writeFile(path.join(dir, name, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\nA claim.\n\n\\end{document}'); }
  const app = new PaperApplication({ dataRoot: path.join(dir, 'private'), compiler: { probe: async () => ({ available: true, isolated: true }), build: async data => ({ ...data, files: undefined, buildId: 'failed-test', status: 'failed' }) } });
  await app.initialize(); await app.openProject({ root: path.join(dir, 'first'), mainFile: 'main.tex' });
  const firstId = app.getState().project.id;
  let release, entered; const barrier = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const capture = app._capture.bind(app); app._capture = async (...args) => { const value = await capture(...args); entered(); await barrier; return value; };
  const compiling = app.compileBaseline(); await started;
  await assert.rejects(app.openProject({ root: path.join(dir, 'second'), mainFile: 'main.tex' }), { code: 'PROJECT_BUSY' });
  release(); const queued = await compiling; await app.waitJob({ jobId: queued.jobId });
  assert.equal(app.getState().project.id, firstId);
  await assert.rejects(app.configureEngine({ engine: 'cmd' }), { code: 'INVALID_INPUT' });
  await app.configureEngine({ engine: 'pdflatex' });
  assert.equal(app.getState().compiler.engine, 'pdflatex');
  const reloaded = new PaperApplication({ dataRoot: path.join(dir, 'private') });
  await reloaded.openProject({ root: path.join(dir, 'first'), mainFile: 'main.tex' });
  assert.equal(reloaded.getState().compiler.engine, 'pdflatex');
  await app.openProject({ root: path.join(dir, 'second'), mainFile: 'main.tex' }); assert.notEqual(app.getState().project.id, firstId);
  assert.equal(app.getState().compiler.engine, 'xelatex');
});
