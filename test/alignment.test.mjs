import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaperApplication } from '../src/application.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const owned = path.join(root, 'work/alignment-tests'); await mkdir(owned, { recursive: true });
  const temporary = await mkdtemp(path.join(owned, 'case-')); t.after(async () => { assert.ok(temporary.startsWith(owned + path.sep)); await rm(temporary, { recursive: true, force: true }); });
  const source = path.join(temporary, 'source'); await mkdir(source);
  const before = '\\documentclass{article}\n\\begin{document}\n\nA state $x$ is measured.\n\nA second statement is retained.\n\n\\end{document}\n'; await writeFile(path.join(source, 'main.tex'), before);
  const app = new PaperApplication({ dataRoot: path.join(temporary, 'private') }); await app.openProject({ root: source, mainFile: 'main.tex' });
  const segments = app.getState().segments.filter(item => item.translatable);
  await app.saveDraft({ segmentId: segments[0].id, language: 'zh-CN', text: '状态 $x$ 被测量。\n\n第二个译文段落。', expectedRevision: 0 });
  return { app, source, before, segments };
}
test('one source can align with two independently editable translation units', async t => {
  const f = await fixture(t), first = f.segments[0];
  const draft = f.app.getState().translations['zh-CN'][first.id];
  const state = await f.app.splitTranslation({ segmentId: first.id, language: 'zh-CN', splitAt: draft.text.indexOf('\n\n') + 2, expectedRevision: 1 });
  const alignment = state.alignments[0]; assert.equal(alignment.relation, 'oneToMany'); assert.equal(alignment.translationUnitIds.length, 2);
  assert.equal(alignment.sourceSegmentIds[0], first.id);
  const unit = alignment.translationUnitIds[1]; await f.app.saveDraft({ segmentId: unit, language: 'zh-CN', text: '独立修改第二段。', expectedRevision: 1 });
  const request = await f.app.createRequest({ segmentIds: [first.id], kind: 'revision', language: 'zh-CN' });
  assert.match(request.segments[0].translationDraft.text, /独立修改第二段/);
  assert.equal(f.app.getState().orphanedDrafts.length, 0);
  assert.equal(await readFile(path.join(f.source, 'main.tex'), 'utf8'), f.before);
});
test('protected objects cannot be split and late generated translation cannot erase split human units', async t => {
  const f = await fixture(t), first = f.segments[0];
  await assert.rejects(f.app.splitTranslation({ segmentId: first.id, language: 'zh-CN', splitAt: 4, expectedRevision: 1 }), { code: 'PROTECTED_TOKEN_CHANGED' });
  const draft = f.app.getState().translations['zh-CN'][first.id];
  await f.app.splitTranslation({ segmentId: first.id, language: 'zh-CN', splitAt: draft.text.indexOf('\n\n') + 2, expectedRevision: 1 });
  const request = await f.app.createRequest({ segmentIds: [first.id], kind: 'translation', language: 'zh-CN' });
  const result = await f.app.submitTranslationResult({ requestId: request.requestId, translations: [{ segmentId: first.id, text: first.displayText }] });
  assert.equal(result.status, 'stale'); assert.equal(Object.keys(f.app.getState().translations['zh-CN']).length, 2);
});
test('manual many-to-one alignment validates exact endpoints and rejects prototype keys', async t => {
  const f = await fixture(t);
  const state = await f.app.setAlignment({ language: 'zh-CN', sourceSegmentIds: f.segments.map(item => item.id), translationUnitIds: [f.segments[0].id] });
  assert.equal(state.alignments[0].relation, 'manyToOne');
  await assert.rejects(f.app.setAlignment({ language: 'zh-CN', sourceSegmentIds: [f.segments[0].id], translationUnitIds: ['constructor'] }), { code: 'ANCHOR_AMBIGUOUS' });
  await assert.rejects(f.app.saveDraft({ language: 'toString', segmentId: f.segments[0].id, text: 'bad', expectedRevision: 0 }), { code: 'INVALID_INPUT' });
});
