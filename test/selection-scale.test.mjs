import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { PaperApplication } from '../src/application.mjs';
import { DesktopTranslationTasks } from '../src/translation-tasks.mjs';
import { MODEL_CONTEXT_BYTES, paginateItems } from '../src/request-budgets.mjs';

async function fixture(t, count = 55, derived = false) {
  const owned = path.resolve('work/selection-scale-tests'); await mkdir(owned, { recursive: true }); const directory = await mkdtemp(path.join(owned, 'case-')), root = path.join(directory, 'source'); await mkdir(root);
  const source = '\\documentclass{article}\n\\begin{document}\n' + (derived ? '\\def\\unrelated{opaque}\n' : '') + '\n' + Array.from({ length: count }, (_, i) => `A precise paragraph ${i} protects $x_${i}=1$.`).join('\n\n') + '\n\n\\end{document}\n';
  await writeFile(path.join(root, 'main.tex'), source); const app = new PaperApplication({ dataRoot: path.join(directory, 'private') }); await app.openProject({ root, mainFile: 'main.tex', targetLanguage: 'zh-CN' });
  t.after(async () => { await app.close(); assert(directory.startsWith(owned + path.sep)); await rm(directory, { recursive: true, force: true }); });
  return { app, source, paragraphs: app.getState().readingParagraphs.filter(p => p.source.startsWith('A precise paragraph')) };
}
for (const derived of [false, true]) test(`a ${derived ? 'derived' : 'canonical'} request accepts more than twenty complete paragraphs`, async t => {
  const f = await fixture(t, 31, derived), ids = f.paragraphs.map(p => p.id), request = await f.app.createRequest({ kind: 'translation', language: 'zh-CN', segmentIds: ids });
  assert.equal(request.segments.length, 31); await f.app.submitTranslationResult({ requestId: request.requestId, translations: request.segments.map(s => ({ segmentId: s.id, text: s.text.replace('A precise paragraph', '精确段落') })) });
  assert.equal(Object.keys(f.app.getState().translations['zh-CN']).length, 31);
});
test('more than fifty nonoverlapping current proposals form one exact candidate', async t => {
  const f = await fixture(t), proposals = [];
  for (const paragraph of f.paragraphs) { const request = await f.app.createRequest({ kind: 'revision', segmentIds: [paragraph.id], language: 'zh-CN' }); const proposal = await f.app.proposeRevision({ requestId: request.requestId, reason: 'Explicit selected prose change.', edits: [{ segmentId: paragraph.id, beforeHash: paragraph.sourceHash || paragraph.beforeHash, replacement: request.segments[0].text.replace('precise', 'explicit') }] }); proposals.push(proposal.proposalId); }
  const candidate = await f.app.core.previewTransaction({ proposalIds: proposals }); assert.equal(candidate.proposalIds.length, 55); assert.equal((candidate.files[0].content.match(/A explicit paragraph/gu) || []).length, 55);
});
test('one short translation batch can contain more than eight paragraphs and covers the exact full selection', async t => {
  const f = await fixture(t, 31), thread = 'scale-test-native'; const tasks = new DesktopTranslationTasks(f.app, { getThreadId: () => thread, enqueue: async () => ({ status: 'queued' }) });
  const task = await tasks.prepare({ scope: 'all', language: 'zh-CN', expectedProjectId: f.app.getState().project.id, expectedSnapshotId: f.app.getState().project.snapshotId }, thread), packet = await tasks.nextBatch({ taskId: task.taskId }, thread);
  assert.equal(packet.batch.segments.length, 31); assert(Buffer.byteLength(JSON.stringify(packet)) <= MODEL_CONTEXT_BYTES);
  await tasks.receiveRequestResult({ requestId: packet.batch.requestId, translations: packet.batch.segments.map(s => ({ segmentId: s.id, text: s.text })) }, thread);
  const done = await tasks.nextBatch({ taskId: task.taskId }, thread); assert.equal(done.status, 'completed'); assert.equal(done.completed, 31);
});
test('byte pagination preserves every complete selected record and gives a bound continuation instead of a count error', () => {
  const records = Array.from({ length: 41 }, (_, id) => ({ id, text: 'A'.repeat(110000) })), covered = []; let offset = 0;
  for (;;) { const page = paginateItems({ requestId: 'same-request', snapshotId: 'same-source' }, 'segments', records, { offset }); assert(Buffer.byteLength(JSON.stringify(page)) <= MODEL_CONTEXT_BYTES); covered.push(...page.segments.map(s => s.id)); if (page.nextOffset === null) break; offset = page.nextOffset; }
  assert.deepEqual(covered, records.map(s => s.id));
});
