import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { prepareAssistantSource, prepareAssistantReview, parseBilingualReviewTex } from '../src/assistant-import.mjs';
import { normalizeExternalReviews } from '../src/review-notes.mjs';
import { createHash } from 'node:crypto';

function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function zip(entries) {
  const local = [], directory = []; let offset = 0;
  for (const [name, content, opts = {}] of entries) {
    const raw = Buffer.from(content), nameBytes = Buffer.from(name), bytes = opts.deflate ? deflateRawSync(raw) : raw, method = opts.deflate ? 8 : 0;
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(0x800, 6); head.writeUInt16LE(method, 8); head.writeUInt32LE(opts.crc ?? crc32(raw), 14); head.writeUInt32LE(bytes.length, 18); head.writeUInt32LE(opts.size ?? raw.length, 22); head.writeUInt16LE(nameBytes.length, 26);
    local.push(head, nameBytes, bytes);
    const item = Buffer.alloc(46); item.writeUInt32LE(0x02014b50); item.writeUInt16LE(0x314, 4); item.writeUInt16LE(0x800, 8); item.writeUInt16LE(method, 10); item.writeUInt32LE(opts.crc ?? crc32(raw), 16); item.writeUInt32LE(bytes.length, 20); item.writeUInt32LE(opts.size ?? raw.length, 24); item.writeUInt16LE(nameBytes.length, 28); item.writeUInt32LE(opts.attributes ?? 0, 38); item.writeUInt32LE(offset, 42); directory.push(item, nameBytes); offset += head.length + nameBytes.length + bytes.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...local, central, end]);
}
const source = '\\documentclass{article}\n\\begin{document}\nAn original paragraph with $x$ and \\cite{r}.\n\\bibliography{refs}\n\\end{document}\n';
const note = code => `\\changeheading{${code}}{Clarify claim}{Clarify claim}\n\\begin{pairedoriginal}{Old}\n\\eng Original claim $x$.\\par\\chin 原结论 $x$。\n\\end{pairedoriginal}\n\\proposalstart{${code}}\n{\\color{New}\\eng Suggested claim $x$.\\par\\chin 建议结论 $x$。\\par}\n\\reasonlabel\n\\eng Clarify the wording.\\par\\chin 澄清措辞。\n\\proposalend\n`;
const review = `\\documentclass{article}\n\\newcommand{\\proposalstart}[1]{do not execute}\n\\begin{document}\nFull bilingual manuscript with proposed revisions\n2 项建议\n${note('A01')}${note('M01')}\\end{document}`;
async function fixture(t) { const root = await mkdtemp(path.join(tmpdir(), 'paper-assistant-')); t.after(() => rm(root, { recursive: true, force: true })); return { root, privateRoot: path.join(root, 'private') }; }

test('source ZIP imports only selected dependency graph into a private copy and repeated import preserves edits', async t => {
  const { root, privateRoot } = await fixture(t), sourcePath = path.join(root, 'paper.zip'), original = zip([['upload/main.tex', source, { deflate: true }], ['upload/refs.bib', '@article{r,title={A}}'], ['upload/README.txt', 'not an input']]); await writeFile(sourcePath, original);
  const first = await prepareAssistantSource({ sourcePath, privateRoot }); assert.equal(first.status, 'ready'); assert.equal(first.mainFile, 'main.tex'); assert.equal(first.engine, 'pdflatex'); assert.ok(first.root.startsWith(privateRoot + path.sep)); assert.equal(await readFile(path.join(first.root, 'main.tex'), 'utf8'), source); assert.equal(await readFile(path.join(first.root, 'refs.bib'), 'utf8'), '@article{r,title={A}}'); assert.equal(first.reused, false);
  await writeFile(path.join(first.root, 'main.tex'), source.replace('original', 'edited')); const second = await prepareAssistantSource({ sourcePath, privateRoot }); assert.equal(second.root, first.root); assert.equal(second.reused, true); assert.match(await readFile(path.join(second.root, 'main.tex'), 'utf8'), /edited paragraph/); assert.deepEqual(await readFile(sourcePath), original);
});
test('ambiguous main files require explicit choice and relative user paths are rejected', async t => {
  const { root, privateRoot } = await fixture(t), sourcePath = path.join(root, 'paper.zip'); await writeFile(sourcePath, zip([['a.tex', source], ['b.tex', source], ['refs.bib', 'x']]));
  const pending = await prepareAssistantSource({ sourcePath, privateRoot }); assert.equal(pending.status, 'main-file-required'); assert.deepEqual(pending.mainCandidates, ['a.tex', 'b.tex']); const ready = await prepareAssistantSource({ sourcePath, privateRoot, mainFile: 'b.tex' }); assert.equal(ready.mainFile, 'b.tex'); await assert.rejects(prepareAssistantSource({ sourcePath: 'paper.zip', privateRoot }), { code: 'INVALID_IMPORT_PATH' });
});
test('an explicitly selected .tex copies its linked inputs without scanning unrelated siblings', async t => {
  const { root, privateRoot } = await fixture(t); await writeFile(path.join(root, 'main.tex'), source); await writeFile(path.join(root, 'refs.bib'), 'refs'); await writeFile(path.join(root, 'other.tex'), '\\documentclass{article}');
  const result = await prepareAssistantSource({ sourcePath: path.join(root, 'main.tex'), privateRoot }); assert.equal(result.status, 'ready'); assert.equal(await readFile(path.join(result.root, 'refs.bib'), 'utf8'), 'refs'); await assert.rejects(readFile(path.join(result.root, 'other.tex')), { code: 'ENOENT' });
});
test('unsafe ZIP traversal, Windows aliases, duplicate names and symlink entries fail before import', async t => {
  const { root, privateRoot } = await fixture(t), sourcePath = path.join(root, 'bad.zip');
  for (const bad of ['../escape.tex', '/escape.tex', 'C:/escape.tex', 'folder\\escape.tex', 'AUX.tex', 'folder./main.tex', 'file:stream']) { await writeFile(sourcePath, zip([['main.tex', source], [bad, 'x']])); await assert.rejects(prepareAssistantSource({ sourcePath, privateRoot }), error => error.code === 'UNSAFE_IMPORT_ARCHIVE', bad); }
  for (const entries of [[['main.tex', source], ['MAIN.tex', source]], [['main.tex', source], ['link', '/etc/passwd', { attributes: (0xa1ff << 16) >>> 0 }]]]) { await writeFile(sourcePath, zip(entries)); await assert.rejects(prepareAssistantSource({ sourcePath, privateRoot }), { code: 'UNSAFE_IMPORT_ARCHIVE' }); }
});
test('ZIP CRC mismatch and inflated data beyond declared or supported quotas are rejected', async t => {
  const { root, privateRoot } = await fixture(t), sourcePath = path.join(root, 'bad.zip');
  for (const opts of [{ crc: 1 }, { size: 2, deflate: true }, { size: 129 * 1024 * 1024 }]) { await writeFile(sourcePath, zip([['main.tex', source, opts]])); await assert.rejects(prepareAssistantSource({ sourcePath, privateRoot }), error => ['INVALID_IMPORT_ARCHIVE', 'IMPORT_TOO_LARGE'].includes(error.code)); }
});
test('recognized bilingual review TeX is read as literal data, preserves formulas and creates exactly declared suggestions', () => {
  const notes = parseBilingualReviewTex(review); assert.equal(notes.length, 2); assert.deepEqual(notes.map(item => item.reviewCode), ['A01', 'M01']); assert.equal(notes[0].suggestedSource, 'Suggested claim $x$.'); assert.equal(notes[0].suggestedTranslation, '建议结论 $x$。'); assert.equal(notes[0].reasonSource, 'Clarify the wording.'); assert.equal(notes[0].reasonTranslation, '澄清措辞。'); assert.equal(notes[0].currentSource, 'Original claim $x$.');
});
test('malformed or ordinary manuscript TeX is not mistaken for a review document', () => {
  assert.throws(() => parseBilingualReviewTex(source), { code: 'REVIEW_TEX_STRUCTURE_REQUIRED' }); for (const value of [review.replace('2 项建议', '3 项建议'), review.replace('\\reasonlabel', '\\unknown'), review.replace('\\proposalstart{M01}', '\\proposalstart{A01}')]) assert.throws(() => parseBilingualReviewTex(value), { code: 'INVALID_REVIEW_STRUCTURE' });
});
test('review ZIP selects a unique .tex member and keeps original filename/hash provenance', async t => {
  const { root } = await fixture(t), reviewPath = path.join(root, 'review.zip'); await writeFile(reviewPath, zip([['bilingual-review.tex', review, { deflate: true }], ['figures/a.pdf', '%PDF-1.4\n%%EOF'], ['README.txt', 'Read review.tex']]));
  const result = await prepareAssistantReview({ reviewPath }); assert.equal(result.status, 'ready'); assert.equal(result.input.filename, 'bilingual-review.tex'); assert.equal(result.input.format, 'json'); assert.equal(JSON.parse(result.input.text).notes.length, 2); assert.equal(result.provenance.format, 'zip'); assert.equal(result.provenance.member, 'bilingual-review.tex');
});
test('two plausible review members require a choice; explicit selected member is exact and path-safe', async t => {
  const { root } = await fixture(t), reviewPath = path.join(root, 'review.zip'); await writeFile(reviewPath, zip([['a.tex', review], ['b.tex', review]])); const pending = await prepareAssistantReview({ reviewPath }); assert.equal(pending.status, 'review-file-required'); assert.deepEqual(pending.reviewCandidates, ['a.tex', 'b.tex']); const chosen = await prepareAssistantReview({ reviewPath, entry: 'b.tex' }); assert.equal(chosen.input.filename, 'b.tex'); await assert.rejects(prepareAssistantReview({ reviewPath, entry: '../a.tex' }), { code: 'INVALID_IMPORT_ENTRY' });
});
test('ordinary explicit review text remains text with its original byte digest and no executable markup', async t => {
  const { root } = await fixture(t), reviewPath = path.join(root, 'review.md'); await writeFile(reviewPath, '# Review\n\nUse a more specific claim.'); const result = await prepareAssistantReview({ reviewPath }); assert.equal(result.input.format, 'md'); assert.equal(result.input.text, '# Review\n\nUse a more specific claim.'); assert.match(result.input.fileHash, /^[a-f0-9]{64}$/);
});
test('review context links only substantial unique literal source evidence and leaves repeated passages unlocated', async t => {
  const { root } = await fixture(t), reviewPath = path.join(root, 'review.tex'), original = 'This particular source sentence explains the physical meaning of the independently prepared state before the adaptive measurements begin.';
  await writeFile(reviewPath, review.replaceAll('Original claim $x$.', original));
  const state = { project: { snapshotId: 'snap-current' }, segments: [{ id: 's1', beforeHash: 'a'.repeat(64), source: original, displayText: original }], readingParagraphs: [] };
  let prepared = await prepareAssistantReview({ reviewPath, state }); let normalized = normalizeExternalReviews(prepared.input, state); assert.ok(normalized.notes.every(item => item.anchorConfidence === 'exactQuote' && item.sourceSegmentIds[0] === 's1')); assert.ok(normalized.notes.every(item => item.quote.length >= 64));
  state.segments.push({ id: 's2', beforeHash: 'b'.repeat(64), source: original, displayText: original }); prepared = await prepareAssistantReview({ reviewPath, state }); normalized = normalizeExternalReviews(prepared.input, state); assert.ok(normalized.notes.every(item => item.sourceSegmentIds.length === 0));
  assert.equal(prepared.input.fileHash, createHash('sha256').update(await readFile(reviewPath)).digest('hex')); assert.equal(prepared.provenance.sourceFormat, 'tex');
});
test('mutable target translation text cannot change the normalized TeX import payload for the same source snapshot', async t => {
  const { root } = await fixture(t), reviewPath = path.join(root, 'review.tex'), original = 'This particular source sentence explains the physical meaning of the independently prepared state before the adaptive measurements begin.'; await writeFile(reviewPath, review.replaceAll('Original claim $x$.', original));
  const state = { project: { snapshotId: 'snap-current' }, segments: [{ id: 's1', beforeHash: 'a'.repeat(64), source: original, displayText: original }, { id: 's2', beforeHash: 'b'.repeat(64), source: 'A different source paragraph.' }], readingParagraphs: [{ id: 's1', beforeHash: 'a'.repeat(64), source: original, translation: '原译文。' }, { id: 's2', beforeHash: 'b'.repeat(64), source: 'A different source paragraph.', translation: '另一段译文。' }] };
  const before = await prepareAssistantReview({ reviewPath, state }); state.readingParagraphs[1].translation = original; state.readingParagraphs[1].originalCN = original; const after = await prepareAssistantReview({ reviewPath, state }); assert.equal(after.input.text, before.input.text); assert.equal(after.input.fileHash, before.input.fileHash);
});
test('the isolated PDF reader extracts real selectable text without changing the host compatibility environment', async t => {
  const { root } = await fixture(t), reviewPath = path.join(root, 'review.pdf'), stream = 'BT /F1 12 Tf 72 700 Td (Check the exact source claim.) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const offsets = [0]; for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; } const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`; await writeFile(reviewPath, pdf);
  const before = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toHex'); const result = await prepareAssistantReview({ reviewPath }); assert.equal(result.status, 'ready'); assert.equal(result.input.format, 'pdf'); assert.equal(result.input.text, 'Check the exact source claim.'); assert.deepEqual(Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toHex'), before);
});
