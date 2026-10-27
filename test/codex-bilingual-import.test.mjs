import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBilingualPairs } from '../src/bilingual-import.mjs';
import { extractSegments, restoreProtected, sha256 } from '../src/latex.mjs';
const definitions = '\\newcommand{\\eng}{\\noindent{\\normalfont\\sffamily\\scriptsize\\color{Muted}EN}\\enspace\\ignorespaces}\n\\newcommand{\\chin}{\\noindent{\\normalfont\\sffamily\\scriptsize\\color{Muted}中}\\enspace\\ignorespaces}\n';
const document = body => '\\documentclass{article}\n' + definitions + '\\begin{document}\n\n' + body + '\n\n\\end{document}\n';
test('explicit verified markers derive English-only source bytes and existing Chinese companion', () => {
  const english = 'A state $\\rho$ is measured with \\cite{sample}.', chinese = '测量一个状态 $\\rho$，引用见 \\cite{sample}。';
  const source = document(`\\eng ${english}\\par\\chin ${chinese}`), pairs = extractBilingualPairs(source, 'main.tex');
  assert.equal(pairs.length, 1); const pair = pairs[0];
  assert.equal(Buffer.from(source).subarray(pair.sourceStartByte, pair.sourceEndByte).toString('utf8'), english);
  assert.equal(pair.sourceHash, sha256(english)); assert.equal(pair.existingTranslation.text, chinese);
  assert.equal(pair.confidence, 'explicitMarker');
  assert.equal(Buffer.from(source).subarray(pair.existingTranslation.startByte, pair.existingTranslation.endByte).toString('utf8'), chinese);
});
test('BOM, emoji and CRLF preserve exact byte coordinates and delimiters', () => {
  const source = '\ufeff' + document('\\eng An emoji 🙂 remains.\\par\\chin 保留表情🙂。').replaceAll('\n', '\r\n');
  const [pair] = extractBilingualPairs(source, 'main.tex'); assert.ok(pair);
  assert.equal(Buffer.from(source).subarray(pair.sourceStartByte, pair.sourceEndByte).toString('utf8'), 'An emoji 🙂 remains.');
  const changed = Buffer.concat([Buffer.from(source).subarray(0, pair.sourceStartByte), Buffer.from('An emoji 🙂 stays.'), Buffer.from(source).subarray(pair.sourceEndByte)]).toString('utf8');
  assert.ok(changed.includes('\\eng An emoji 🙂 stays.\\par\\chin 保留表情🙂。'));
  assert.ok(changed.startsWith('\ufeff')); assert.equal(changed.split('\r\n').length, source.split('\r\n').length);
});
test('multiple unambiguous explicit pairs in one safe block retain separate identities', () => {
  const pairs = extractBilingualPairs(document('\\eng First claim.\\par\\chin 第一项。\\par\\eng Second claim.\\par\\chin 第二项。'), 'main.tex');
  assert.equal(pairs.length, 2); assert.equal(pairs[0].existingTranslation.text, '第一项。'); assert.equal(pairs[1].existingTranslation.text, '第二项。');
  assert.notEqual(pairs[0].pairId, pairs[1].pairId);
});
test('marker-looking text inside math and comments never creates a language boundary', () => {
  const source = document('\\eng A protected $\\chin$ marker. % \\chin fake\n\\par\\chin 正文。');
  const pairs = extractBilingualPairs(source, 'main.tex'); assert.equal(pairs.length, 1);
  assert.ok(pairs[0].source.includes('$\\chin$')); assert.equal(pairs[0].existingTranslation.text, '正文。');
});
test('unsafe or unknown parent regions remain unavailable even if caller fabricates a safe flag', () => {
  const source = document('\\begin{unknown}\n\n\\eng English.\\par\\chin 中文。\n\n\\end{unknown}');
  const fake = extractSegments(source, 'main.tex').map(item => ({ ...item, translatable: true }));
  assert.deepEqual(extractBilingualPairs(source, 'main.tex', fake), []);
  assert.deepEqual(extractBilingualPairs(document('\\catcode`@=11\n\n\\eng English.\\par\\chin 中文。'), 'main.tex'), []);
});
test('ambiguous marker order, unverified declarations and absent paragraph delimiters are skipped', () => {
  for (const body of ['\\eng One.\\eng Two.\\par\\chin 中文。', '\\eng English.\\par\\chin 中文。\\chin 再一段。', '\\eng English. \\chin 中文。']) assert.deepEqual(extractBilingualPairs(document(body), 'main.tex'), []);
  const source = document('\\eng English.\\par\\chin 中文。').replace('\\scriptsize\\color{Muted}EN', '\\input{private}EN');
  assert.deepEqual(extractBilingualPairs(source, 'main.tex'), []);
});
test('a verified prose environment remains outside both editable body intervals', () => {
  const environment = '\\newenvironment{coloredprose}[1]{\\par\\begingroup\\color{#1}}{\\par\\endgroup\\smallskip}\n';
  const source = document('\\begin{coloredprose}{Old}\\eng English text.\\par\\chin 中文文本。\\end{coloredprose}').replace('\\begin{document}', environment + '\\begin{document}');
  const pairs = extractBilingualPairs(source, 'main.tex'); assert.equal(pairs.length, 1);
  assert.equal(pairs[0].source, 'English text.'); assert.equal(pairs[0].existingTranslation.text, '中文文本。');
});
test('nested marker invocations and unsupported cross-block alignment are never guessed', () => {
  assert.deepEqual(extractBilingualPairs(document('\\emph{\\eng English.\\par\\chin 中文。}'), 'main.tex'), []);
  assert.deepEqual(extractBilingualPairs(document('\\eng English.\n\n\\chin 中文。'), 'main.tex'), []);
});
test('an unbraced later marker redefinition invalidates subsequent bilingual import', () => {
  const source = document('\\renewcommand\\eng{changed}\n\n\\eng English.\\par\\chin 中文。');
  assert.deepEqual(extractBilingualPairs(source, 'main.tex'), []);
});

test('range overrides narrow only English bytes and preserve full-file protection context', () => {
  const environment = '\\newenvironment{coloredprose}[1]{\\par\\begingroup\\color{#1}}{\\par\\endgroup\\smallskip}\n';
  const english = 'The \\emph{state} $\\rho$ uses \\cite{sample}.';
  const source = '\ufeff' + document(`\\section{Results}\n\n\\begin{coloredprose}{Old}\\eng ${english}\\par\\chin 保留中文。\\end{coloredprose}`).replace('\\begin{document}', environment + '\\begin{document}').replaceAll('\n', '\r\n');
  const [pair] = extractBilingualPairs(source, 'main.tex'); assert.ok(pair);
  const segments = extractSegments(source, 'main.tex', [], [{ startByte: pair.sourceStartByte, endByte: pair.sourceEndByte, id: pair.parentSegmentId }]);
  const segment = segments.find(item => item.startByte === pair.sourceStartByte);
  assert.ok(segment); assert.equal(segment.source, english); assert.equal(segment.id, pair.parentSegmentId); assert.equal(segment.section, 'Results'); assert.equal(segment.translatable, true);
  assert.deepEqual(segment.protectedTokens.filter(item => item.raw.startsWith('$') || item.raw.startsWith('\\cite')).map(item => item.raw), ['$\\rho$', '\\cite{sample}']);
  assert.equal(restoreProtected(segment, segment.displayText), english);
  assert.equal(Buffer.from(source).subarray(segment.startByte, segment.endByte).toString('utf8'), english);
  assert.ok(segments.some(item => item.source === '\\section{Results}'));
});

test('exact previous English identity takes precedence over requested canonical parent identity', () => {
  const source = document('\\eng An original 🙂 source.\\par\\chin 中文。'), [pair] = extractBilingualPairs(source, 'main.tex');
  const old = { id: 'seg-original', path: 'main.tex', startByte: pair.sourceStartByte, beforeHash: pair.sourceHash };
  const [segment] = extractSegments(source, 'main.tex', [old], [{ startByte: pair.sourceStartByte, endByte: pair.sourceEndByte, id: pair.parentSegmentId }]);
  assert.equal(segment.id, old.id); assert.equal(segment.beforeHash, pair.sourceHash);
});

test('range overrides reject split UTF-8, overlapping, cross-block and unsafe parent ranges', () => {
  const source = document('First 🙂 paragraph.\n\nSecond paragraph.'), canonical = extractSegments(source, 'main.tex'), [first, second] = canonical;
  const emojiByte = Buffer.from(source).indexOf(Buffer.from('🙂'));
  const invalid = [
    [{ startByte: emojiByte + 1, endByte: first.endByte }],
    [{ startByte: first.startByte, endByte: emojiByte + 2 }],
    [{ startByte: first.startByte, endByte: second.endByte }],
    [{ startByte: first.startByte, endByte: first.endByte }, { startByte: first.startByte + 1, endByte: first.endByte }],
    [{ startByte: first.startByte, endByte: first.endByte, id: 'same' }, { startByte: second.startByte, endByte: second.endByte, id: 'same' }],
    [{ startByte: 0, endByte: first.endByte }],
    [{ startByte: first.startByte + 0.5, endByte: first.endByte }]
  ];
  for (const overrides of invalid) assert.throws(() => extractSegments(source, 'main.tex', [], overrides), { code: 'INVALID_RANGE_OVERRIDE' });
  const unsafe = document('\\begin{unknown}\n\nAn English fragment.\n\n\\end{unknown}'), unsafeBytes = Buffer.from(unsafe), needle = Buffer.from('An English fragment.');
  assert.throws(() => extractSegments(unsafe, 'main.tex', [], [{ startByte: unsafeBytes.indexOf(needle), endByte: unsafeBytes.indexOf(needle) + needle.length }]), { code: 'INVALID_RANGE_OVERRIDE' });
  const cited = document('An English \\cite{sample} source.'), citedBytes = Buffer.from(cited), [citedParent] = extractSegments(cited, 'main.tex');
  assert.throws(() => extractSegments(cited, 'main.tex', [], [{ startByte: citedBytes.indexOf(Buffer.from('sample')), endByte: citedParent.endByte }]), { code: 'INVALID_RANGE_OVERRIDE' });
});

test('multiple disjoint overrides replace one parent without creating duplicate IDs', () => {
  const source = document('\\eng First claim.\\par\\chin 第一项。\\par\\eng Second claim.\\par\\chin 第二项。'), pairs = extractBilingualPairs(source, 'main.tex');
  const segments = extractSegments(source, 'main.tex', [], pairs.map((pair, index) => ({ startByte: pair.sourceStartByte, endByte: pair.sourceEndByte, ...(index === 0 ? { id: pair.parentSegmentId } : {}) })));
  assert.deepEqual(segments.map(item => item.source), ['First claim.', 'Second claim.']); assert.equal(new Set(segments.map(item => item.id)).size, 2);
});
