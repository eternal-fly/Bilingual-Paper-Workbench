import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadingWorkspace } from '../src/reading-workflow.mjs';
import { extractSegments } from '../src/latex.mjs';

function derive(unboundedBindings, { fallback = false } = {}) {
  const filename = fallback ? 'synthetic.fragment' : 'main.tex';
  const text = '\\documentclass{article}\n\\begin{document}\n\nAn ordinary synthetic claim.\n\n\\end{document}\n';
  const segments = extractSegments(text, filename), state = { project: { snapshotId: 'synthetic-snapshot', targetLanguage: 'zh-CN', inlineStructureSafety: { unboundedBindings } }, segments, translations: {}, readingAnchors: [], readingAnchorRevision: 0 };
  const core = { getState: () => state, _files: new Map([[filename, { path: filename, text, bytes: Buffer.from(text) }]]), _literalProjectSafe: () => false };
  return new ReadingWorkspace({ core }).derive(state).paragraphs;
}

for (const fallback of [false, true]) test(`unbounded snapshot bindings never advertise canonical source writeback (${fallback ? 'fallback' : 'normal'} projection)`, () => {
  const ordinary = derive(false, { fallback }); assert.ok(ordinary.length > 0); assert.ok(ordinary.every(row => row.writableSource === true));
  const opaque = derive(true, { fallback }); assert.equal(opaque.length, ordinary.length);
  assert.ok(opaque.every(row => row.writableSource === false)); assert.ok(opaque.every(row => row.requestable === true));
});
