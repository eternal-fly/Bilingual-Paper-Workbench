import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarkdownContext, parseReferenceData } from '../src/markdown-context.mjs';

const state = { project: { id: 'synthetic', mainFile: 'main.tex', snapshotId: 'snapshot-current' } };
const files = [{ path: 'main.tex', bytes: Buffer.from(String.raw`\documentclass{article}
\newcommand{\Ns}{N_s}\newcommand{\Tr}{\operatorname{Tr}}\newcommand{\ket}[1]{\lvert#1\rangle}
\newcommand{\bad}{\input{private}}\newcommand{\cycle}{\cycle}
\begin{document}Body.\end{document}`) }];
test('Markdown context exports only safe pure main-preamble math macro strings without source content', () => {
  const result = createMarkdownContext({ state, files });
  assert.deepEqual(result.macros, { '\\Ns': 'N_s', '\\Tr': '\\operatorname{Tr}', '\\ket': '\\lvert#1\\rangle' });
  assert.deepEqual(result.references, { labels: {}, citations: {} });
  assert.equal(result.snapshotId, state.project.snapshotId);
  assert.match(result.contextKey, /^[a-f0-9]{64}$/); assert.doesNotMatch(JSON.stringify(result), /private|Body\./);
  const other = createMarkdownContext({ state: { project: { ...state.project, snapshotId: 'changed' } }, files });
  assert.notEqual(result.contextKey, other.contextKey);
});
test('aux labels are parsed only as bounded numeric data under exact verified build identity', () => {
  const identity = { verified: true, snapshotId: 'snapshot-current', buildId: 'build-synthetic', inputHash: 'a'.repeat(64), pdfHash: 'b'.repeat(64) };
  const auxText = String.raw`\relax
\newlabel{eq:main}{{4}{1}{A caption}{equation.4}{}}
\newlabel{eq:appendix}{{A.2}{8}}
\bibcite{paper}{{17}{2025}{{Name}}{{}}}
\newlabel{evil}{{\input{private}}{1}}
\@writefile{toc}{\newlabel{inert}{{9}{1}}}
\input{private}
`;
  const result = parseReferenceData(auxText, identity, 'snapshot-current');
  assert.deepEqual(result.references, { labels: { 'eq:main': '4', 'eq:appendix': 'A.2' }, citations: { paper: '17' } });
  assert.ok(result.diagnostics.some(item => item.code === 'UNSUPPORTED_REFERENCE_DATA'));
  for (const bad of [{ ...identity, verified: false }, { ...identity, snapshotId: 'old' }, { ...identity, inputHash: 'wrong' }]) {
    const rejected = parseReferenceData(auxText, bad, 'snapshot-current');
    assert.deepEqual(rejected.references, { labels: {}, citations: {} }); assert.ok(rejected.diagnostics.length);
  }
  const duplicate = parseReferenceData('\\newlabel{x}{{1}{1}}\n\\newlabel{x}{{2}{1}}', identity, 'snapshot-current');
  assert.deepEqual(duplicate.references.labels, {});
});

test('verified reference data retains the 5001st scalar label within its byte budget',()=>{
 const identity={verified:true,snapshotId:'snapshot-current',buildId:'build-synthetic',inputHash:'a'.repeat(64),pdfHash:'b'.repeat(64)};
 const source=Array.from({length:5001},(_,i)=>`\\newlabel{eq:capacity-${i}}{{${i+1}}{1}}`).join('\n');
 const result=parseReferenceData(source,identity,'snapshot-current');assert.equal(Object.keys(result.references.labels).length,5001);assert.equal(result.references.labels['eq:capacity-5000'],'5001');assert.deepEqual(result.diagnostics,[]);
});
