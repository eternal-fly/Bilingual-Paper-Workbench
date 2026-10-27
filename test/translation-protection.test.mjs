import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveTranslationProtectedTokens, isLiteralCitation } from '../ui/translation-protection.mjs';

test('translation atoms follow their actual draft order without inventing bibliography mappings', () => {
  const text = '见 [1--4]，保留 $x=1$，另见 [7, 9]。';
  const source = [{ id: 'source-citation', raw: '\\cite{unmapped-key}' }, { id: 'source-math', raw: '$x=1$' }];
  const before = JSON.stringify(source), atoms = deriveTranslationProtectedTokens(text, source);
  assert.deepEqual(atoms.map(atom => atom.raw), ['[1--4]', '$x=1$', '[7, 9]']);
  assert.equal(atoms[1].id, 'source-math'); assert.equal(atoms[0].kind, 'citation');
  assert.ok(atoms.every(atom => !atom.raw.includes('unmapped-key'))); assert.equal(JSON.stringify(source), before);
});
test('all balanced inline and display math are atomic even when absent from source tokens', () => {
  const text = 'A $a+b$ B $$[1,2]$$ C \\(z^2\\) D \\[t_1\\] E \\begin{align}a&=b\\\\c&=d\\end{align}.';
  assert.deepEqual(deriveTranslationProtectedTokens(text).map(atom => atom.raw), ['$a+b$', '$$[1,2]$$', '\\(z^2\\)', '\\[t_1\\]', '\\begin{align}a&=b\\\\c&=d\\end{align}']);
});
test('numeric citation ranges preserve exact spacing and Unicode separators outside math only', () => {
  const text = '[1] [1--4] [1–4] [1—4] [1,2] [ 1, 3--5 ] $[8,9]$ [name]';
  assert.deepEqual(deriveTranslationProtectedTokens(text).filter(atom => atom.kind === 'citation').map(atom => atom.raw), ['[1]', '[1--4]', '[1–4]', '[1—4]', '[1,2]', '[ 1, 3--5 ]']);
  assert.equal(isLiteralCitation('[1, 3–5]'), true); assert.equal(isLiteralCitation('[name]'), false);
});
test('source structures win overlapping inner math and references and repeated atoms remain distinct', () => {
  const source = [{ id: 'box', raw: '\\textbf{Keep $x$ [1]}' }];
  assert.deepEqual(deriveTranslationProtectedTokens('\\textbf{Keep $x$ [1]} then $x$ and [1], [1].', source).map(atom => atom.raw), ['\\textbf{Keep $x$ [1]}', '$x$', '[1]', '[1]']);
});
test('escaped delimiters and incomplete math are not rewritten or guessed', () => {
  const text = 'Cost \\$5, incomplete $x plus \\[unfinished, escaped \\[1], final [2].';
  const atoms = deriveTranslationProtectedTokens(text); assert.deepEqual(atoms.map(atom => atom.raw), ['[2]']);
  assert.ok(atoms.every(atom => text.includes(atom.raw)));
});
test('atom inference preserves source bytes and rejects an excessive draft instead of returning partial protection', () => {
  const text = '中文🙂 $x$ [1]\r\nAgain [1].';
  const atoms = deriveTranslationProtectedTokens(text); assert.equal(atoms.map(atom => atom.raw).join('|'), '$x$|[1]|[1]');
  assert.equal(text, '中文🙂 $x$ [1]\r\nAgain [1].');
  assert.throws(() => deriveTranslationProtectedTokens('a'.repeat(262145)), error => error.code === 'TRANSLATION_PROTECTION_LIMIT');
});
test('bare matrix and cases environments are protected as whole math objects', () => {
  const matrix = String.raw`\begin{pmatrix}1&[2]\\3&4\end{pmatrix}`, cases = String.raw`\begin{cases}x,&x>0\\0,&x\le0\end{cases}`;
  assert.deepEqual(deriveTranslationProtectedTokens(`${matrix} and ${cases}`).map(token => token.raw), [matrix, cases]);
});
test('structural environment boundaries never become editable formula atoms', () => {
  const raws=[String.raw`\begin{itemize}`,String.raw`\end{itemize}`,String.raw`\begin{figure}`,String.raw`\begin{table}`,String.raw`\begin{equation}`,String.raw`\end{equation}`];
  for(const raw of raws){const tokens=deriveTranslationProtectedTokens(raw,[{id:'structure',raw}]);assert.equal(tokens.length,1);assert.equal(tokens[0].kind,'structure',raw);}
  const equation=String.raw`\begin{equation}x=1\end{equation}`;
  assert.equal(deriveTranslationProtectedTokens(equation,[{id:'equation',raw:equation}])[0].kind,'math');
});
test('legitimate inline math inside a source list excludes structural begin and end tokens',()=>{
 const begin=String.raw`\begin{itemize}`,end=String.raw`\end{itemize}`,text=`${begin}\n\\item Keep $x=1$ and \\cite{one}.\n${end}`;
 const tokens=deriveTranslationProtectedTokens(text,[{id:'list-open',raw:begin},{id:'math',raw:'$x=1$'},{id:'citation',raw:String.raw`\cite{one}`},{id:'list-close',raw:end}]);
 assert.deepEqual(tokens.map(t=>t.kind),['structure','math','citation','structure']);assert.deepEqual(tokens.filter(t=>t.kind==='math').map(t=>t.raw),['$x=1$']);
});
