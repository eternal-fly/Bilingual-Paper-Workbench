import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { PaperApplication } from '../src/application.mjs';

test('selected paragraph review accepts twelve paragraphs and returns twelve distinct opinions atomically', async t => {
  const owned = path.resolve('work/paragraph-review-scale-tests'); await mkdir(owned, { recursive: true }); const directory = await mkdtemp(path.join(owned, 'case-')), root = path.join(directory, 'source'); await mkdir(root);
  const source = '\\documentclass{article}\n\\begin{document}\n\n' + Array.from({ length: 12 }, (_, index) => `Precise selected paragraph ${index} retains its assumptions.`).join('\n\n') + '\n\n\\end{document}\n'; await writeFile(path.join(root, 'main.tex'), source);
  const messages = [], sent = []; let sequence = 0;
  const chat = { on() {}, connect: async () => {}, bindPaper: async () => {}, resumeChat: async () => {}, close: async () => {}, getState: () => ({ connected: true, threadId: 'selected-scale', model: 'gpt-6-astra', messages }), sendMessage: async input => { sent.push(input); return { threadId: 'selected-scale', turnId: `turn-${++sequence}` }; }, waitForTurn: async turnId => {
    const input = sent.at(-1), payload = JSON.parse(input.text.split('\n\n').at(-1)); const notes = payload.paragraphs.map((paragraph, index) => ({ title: `Concern ${index}`, body: '澄清此有界假设。', recommendation: '保留此有界假设。', suggestedSource: 'Preserve this bounded assumption.', suggestedTranslation: '保留此有界假设。', reasonSource: 'Clarify this bounded assumption.', reasonTranslation: '澄清此有界假设。', quote: paragraph.source, sourceSegmentIds: [paragraph.id], severity: 'low' }));
    messages.push({ role: 'assistant', turnId, text: JSON.stringify({ reviewId: payload.reviewId, notes }) }); return { threadId: 'selected-scale', turnId, status: 'completed' };
  } };
  const app = new PaperApplication({ dataRoot: path.join(directory, 'private'), chat }); await app.openProject({ root, mainFile: 'main.tex' }); t.after(async () => { await app.close(); assert(directory.startsWith(owned + path.sep)); await rm(directory, { recursive: true, force: true }); });
  const ids = app.getState().readingParagraphs.map(p => p.id), queued = await app.reviewParagraph({ sourceSegmentIds: ids }), result = await app.waitJob({ jobId: queued.jobId });
  assert.equal(result.status, 'completed'); assert.equal(app.getState().reviewNotes.length, 12); assert.equal(new Set(app.getState().reviewNotes.map(note => note.noteId)).size, 12); assert.equal(sent.length, 1); assert.equal(app.getState().proposals.length, 0); assert.equal(await readFile(path.join(root, 'main.tex'), 'utf8'), source);
  assert.equal(sent[0].outputSchema.properties.notes.maxItems, undefined); assert.equal(sent[0].outputSchema.properties.notes.items.properties.sourceSegmentIds.maxItems, undefined);
});
