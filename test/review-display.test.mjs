import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewDisplayText } from '../ui/review-display.mjs';
const fallback = '受保护对象（详见原文）';
const source = (id, raw, token = '⟦P5_faf431⟧') => ({ id, protectedTokens: [{ id: token, raw }] });

test('review display restores exact protected objects across known Unicode and ASCII placeholder wrappers', () => {
  const display = createReviewDisplayText({ readingParagraphs: [source('p1', '$x=1$'), source('p1', '\\cite{reference}', '⟦P6_abc123⟧')] });
  assert.equal(display('Claim [[P5_faf431]] follows ⟦P6_abc123⟧.', ['p1']), 'Claim $x=1$ follows \\cite{reference}.');
});
test('anchored source mappings take priority over conflicting mappings elsewhere in the project', () => {
  const display = createReviewDisplayText({ readingParagraphs: [source('p1', '$x=1$'), source('p2', '$y=2$')] });
  assert.equal(display('Use [[P5_faf431]].', ['p1']), 'Use $x=1$.');
  assert.equal(display('Use [[P5_faf431]].', ['p1', 'p2']), `Use ${fallback}.`);
});
test('unanchored display uses only unique project-wide raw values and never guesses ambiguous objects', () => {
  let display = createReviewDisplayText({ readingParagraphs: [source('p1', '$x=1$')], segments: [source('p2', '$x=1$')] });
  assert.equal(display('[[P5_faf431]]', []), '$x=1$');
  display = createReviewDisplayText({ readingParagraphs: [source('p1', '$x=1$')], segments: [source('p2', '$y=2$')] });
  assert.equal(display('[[P5_faf431]]', []), fallback);
});
test('unknown reserved placeholders and placeholders nested in raw objects never expose internal identifiers', () => {
  const display = createReviewDisplayText({ segments: [source('p1', 'raw [[P99_deadbe]]')] });
  assert.equal(display('[[P123_abcdef]] / ⟦P44_123abc⟧', []), `${fallback} / ${fallback}`);
  assert.equal(display('[[P5_faf431]]', ['p1']), `raw ${fallback}`);
});
test('review display returns literal text and does not mutate notes or protected source data', () => {
  const state = { readingParagraphs: [source('p1', '<img src=x onerror="malicious()">')] }, note = { suggestedSource: 'Use [[P5_faf431]].', sourceSegmentIds: ['p1'] }, before = JSON.stringify({ state, note });
  const text = createReviewDisplayText(state)(note.suggestedSource, note.sourceSegmentIds);
  assert.equal(text, 'Use <img src=x onerror="malicious()">.'); assert.equal(JSON.stringify({ state, note }), before);
});
