import test from 'node:test';
import assert from 'node:assert/strict';
import { createParagraphComparison, diffSentenceRanges, sentenceRanges } from '../src/paragraph-comparison.mjs';

function pieces(side) { return side.ranges.map(range => side.text.slice(range.start, range.end)); }
function verify(side) { assert.equal(pieces(side).join(''), side.text); let at = 0; for (const range of side.ranges) { assert.equal(range.start, at); assert.ok(range.end > range.start); at = range.end; assert.equal(range.color, range.changed ? range.role === 'current' ? '#8D470B' : '#135B7A' : null); } assert.equal(at, side.text.length); }
test('only changed complete sentences receive current/recommended colors in an intact paragraph', () => {
  const out = diffSentenceRanges('The setup is fixed. We use two copies. The conclusion is unchanged.', 'The setup is fixed. We use three copies. The conclusion is unchanged.');
  assert.deepEqual(out.current.ranges.map(range => range.changed), [false, true, false]); assert.deepEqual(out.recommended.ranges.map(range => range.changed), [false, true, false]);
  verify(out.current); verify(out.recommended); assert.deepEqual(out.diagnostics, []);
});
test('sentence alignment preserves mathematical punctuation, environments, placeholders and inline code as atomic text', () => {
  const text = 'Use $x=0.5,\\text{e.g. }y$. Then \\(z=1.25\\). See ⟦P1_abc⟧ and [[P2_def]]. Code `x.y!` remains. $$a.b!$$ End.';
  const parts = sentenceRanges(text).map(range => text.slice(range.start, range.end));
  assert.equal(parts.length, 5); assert.ok(parts[0].includes('e.g.')); assert.ok(parts[3].includes('`x.y!`')); assert.ok(parts[4].includes('$$a.b!$$'));
  assert.equal(parts.join(''), text);
  const environment = 'Start \\begin{align}x&=0.2\\\\y&=1.\\end{align} done. Next.';
  assert.equal(sentenceRanges(environment).length, 2);
});
test('English abbreviations, author initials, references and decimals do not split a sentence', () => {
  const text = 'A. Smith et al. use Eq. (4), e.g. the value 0.25 and i.e. its fixed limit. The next claim is separate.';
  assert.equal(sentenceRanges(text).length, 2);
  const out = diffSentenceRanges(text, text); assert.ok(out.current.ranges.every(range => !range.changed)); verify(out.current);
});
test('every reader-supported math environment and nested same-name environments remain indivisible during sentence highlighting', () => {
  for (const environment of ['equation', 'equation*', 'align', 'align*', 'aligned', 'alignedat', 'alignat', 'alignat*', 'gather', 'gather*', 'gathered', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix', 'cases', 'array', 'split']) {
    const text = `Before \\begin{${environment}}x. y! z.\\end{${environment}} after. Next.`;
    const ranges = sentenceRanges(text); assert.equal(ranges.length, 2, environment); assert.ok(text.slice(ranges[0].start, ranges[0].end).includes(`\\end{${environment}}`));
  }
  const nested = 'Before \\begin{matrix}x. \\begin{matrix}y.\\end{matrix} z. still math\\end{matrix} after. Next.';
  assert.equal(sentenceRanges(nested).length, 2);
});
test('Chinese sentence endings align independently from their English counterparts', () => {
  const note = { scope: 'paragraph', currentSource: 'Fixed setup. Old claim. Same end.', suggestedSource: 'Fixed setup. New claim. Same end.', currentTranslation: '设置固定。原结论。结尾不变。', suggestedTranslation: '设置固定。新结论！结尾不变。' };
  const out = createParagraphComparison({ note }); assert.equal(out.scope, 'paragraph');
  for (const language of [out.source, out.translation]) { assert.deepEqual(language.current.ranges.map(range => range.changed), [false, true, false]); assert.deepEqual(language.recommended.ranges.map(range => range.changed), [false, true, false]); verify(language.current); verify(language.recommended); }
});
test('explicit bilingual current paragraphs default to paragraph comparison while explicitly global notes retain their scope', () => {
  const note = { currentSource: 'Setup. Old.', currentTranslation: '设置。旧。', suggestedSource: 'Setup. New.', suggestedTranslation: '设置。新。' };
  const out = createParagraphComparison({ note }); assert.equal(out.scope, 'paragraph'); assert.deepEqual(out.source.current.ranges.map(range => range.changed), [false, true]);
  assert.equal(createParagraphComparison({ note: { ...note, scope: 'note' } }).scope, 'note');
});
test('insertions and deletions highlight only their respective sentences', () => {
  const out = diffSentenceRanges('One. Deleted. Last.', 'One. Last. Added.');
  assert.deepEqual(out.current.ranges.map(range => range.changed), [false, true, false]); assert.deepEqual(out.recommended.ranges.map(range => range.changed), [false, false, true]);
});
test('PDF whitespace wrapping is ignored outside math while exact output offsets are retained', () => {
  const out = diffSentenceRanges('A fixed\n  setup. Same $a  b$.', 'A fixed setup. Same $a  b$.'); assert.ok(out.current.ranges.every(range => !range.changed)); verify(out.current); verify(out.recommended);
  const math = diffSentenceRanges('Same $a  b$.', 'Same $a b$.'); assert.equal(math.current.ranges[0].changed, true);
});
test('legacy sentence advice can be placed only at a unique exact source occurrence, without guessing target context', () => {
  const note = { sourceSegmentIds: ['p1'], quote: 'Old claim.', suggestedSource: 'New claim.', suggestedTranslation: '新结论。' };
  const out = createParagraphComparison({ note, currentSource: 'Setup. Old claim. End.', currentTranslation: '设置。原结论。结尾。' });
  assert.equal(out.source.recommended.text, 'Setup. New claim. End.'); assert.equal(out.translation.current.text, ''); assert.equal(out.translation.recommended.text, '新结论。'); assert.equal(out.scope, 'sentence'); assert.ok(out.diagnostics.some(item => item.code === 'TRANSLATION_CONTEXT_UNAVAILABLE'));
  const repeated = createParagraphComparison({ note, currentSource: 'Old claim. Old claim.' }); assert.equal(repeated.source.recommended.text, 'New claim.'); assert.ok(repeated.diagnostics.some(item => item.code === 'SOURCE_CONTEXT_AMBIGUOUS'));
});
test('a whole-paragraph exact source quote permits its corresponding whole target comparison', () => {
  const note = { sourceSegmentIds: ['p1'], quote: 'One complete paragraph.', suggestedSource: 'One revised paragraph.', suggestedTranslation: '一个修改后的段落。' };
  const out = createParagraphComparison({ note, currentSource: note.quote, currentTranslation: '一个完整段落。' }); assert.equal(out.scope, 'paragraph'); assert.equal(out.translation.current.text, '一个完整段落。');
});
test('unknown anchors and incomplete paragraph context stay explicit notes instead of fabricated paragraphs', () => {
  const out = createParagraphComparison({ note: { quote: 'Old.', suggestedSource: 'New.', suggestedTranslation: '新。' }, currentSource: 'Setup. Old. End.', currentTranslation: '设置。旧。结尾。' });
  assert.equal(out.scope, 'note'); assert.equal(out.source.current.text, 'Old.'); assert.equal(out.source.recommended.text, 'New.');
  const missing = createParagraphComparison({ note: { scope: 'paragraph', suggestedSource: 'New.' } }); assert.equal(missing.scope, 'note'); assert.ok(missing.diagnostics.some(item => item.code === 'PARAGRAPH_CONTEXT_UNAVAILABLE'));
});
test('bounded alignment retains all oversized text and malformed math without truncation or HTML interpretation', () => {
  const long = 'x'.repeat(128 * 1024 + 1), out = diffSentenceRanges(long, long + '.'); assert.equal(out.current.text, long); assert.equal(out.recommended.text, long + '.'); assert.equal(out.current.ranges.length, 1); assert.equal(out.diagnostics[0].code, 'DIFF_LIMIT');
  const malformed = 'Text $x. y! remains unclosed'; assert.equal(sentenceRanges(malformed).length, 1);
  const inert = createParagraphComparison({ note: { scope: 'note', currentSource: '<img src=x onerror=alert(1)>.', currentTranslation: '旧。', suggestedSource: '<script>bad()</script>.', suggestedTranslation: '新。' } }); assert.equal(inert.source.recommended.text, '<script>bad()</script>.');
});
test('reference commands and citation notes are atomic during sentence comparison', () => {
  const current = String.raw`Keep \cite[see Fig. 2]{alpha. key,beta} and \eqref{eq. key}. Old sentence.`;
  const recommended = current.replace('Old sentence.', 'New sentence.');
  const result = diffSentenceRanges(current, recommended);
  assert.equal(result.current.ranges.length, 2); assert.equal(result.current.ranges[0].changed, false); assert.equal(result.current.ranges[1].changed, true);
});
