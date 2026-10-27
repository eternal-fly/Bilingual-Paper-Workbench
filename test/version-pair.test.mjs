import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, link, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PaperVersionPair } from '../src/version-pair.mjs';
import { extractVersionPair } from '../ui/version-pair.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function pdf(texts, width = 612) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${texts.map((_, i) => `${3 + i} 0 R`).join(' ')}] /Count ${texts.length} >>`];
  const firstStream = 3 + texts.length, font = firstStream + texts.length;
  texts.forEach((_, i) => objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${firstStream + i} 0 R >>`));
  texts.forEach(text => { const stream = text ? `BT /F1 12 Tf 72 700 Td (${text}) Tj ET` : ''; objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`); });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let bytes = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(bytes)); bytes += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(bytes);
  bytes += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(at => String(at).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(bytes);
}
async function fixture(t) {
  const owned = fileURLToPath(new URL('../work/version-pair-tests/', import.meta.url)); await mkdir(owned, { recursive: true });
  const root = await mkdtemp(path.join(owned, 'case-')); t.after(() => rm(root, { recursive: true, force: true }));
  const contextDir = path.join(root, 'context'), metadataDir = path.join(root, 'metadata');
  return { root, contextDir, metadataDir, pair: new PaperVersionPair({ contextDir, metadataDir }) };
}
const inputs = () => ({ projectId: 'synthetic-paper', original: { bytes: pdf(['First original page.', 'Second original page.']), snapshotId: 'snapshot-first', buildId: 'build-first' }, latest: { bytes: pdf(['Latest English first page.', 'Latest English second page.']), snapshotId: 'snapshot-current', buildId: 'build-current' } });
async function browserExtract(pair, options) {
  // PDF.js's browser API is present in Chromium; Node 24 needs this test-only shim.
  const previous = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toHex');
  if (!previous) Object.defineProperty(Uint8Array.prototype, 'toHex', { configurable: true, value() { return Buffer.from(this).toString('hex'); } });
  try { return await extractVersionPair(pair, options); }
  finally { if (previous) Object.defineProperty(Uint8Array.prototype, 'toHex', previous); else delete Uint8Array.prototype.toHex; }
}

test('the pair owns exactly two stable PDF filenames, preserves unknown files and stores metadata outside context', async t => {
  const f = await fixture(t), input = inputs(); await mkdir(f.contextDir); await writeFile(path.join(f.contextDir, 'unrelated.txt'), 'USER OWNED');
  const result = await f.pair.update(input), read = await f.pair.read();
  assert.equal(result.original.hash, hash(input.original.bytes)); assert.equal(result.latest.hash, hash(input.latest.bytes));
  assert.equal(read.original.base64, input.original.bytes.toString('base64')); assert.equal(read.latest.base64, input.latest.bytes.toString('base64'));
  assert.deepEqual((await readdir(f.contextDir)).sort(), ['latest-english.pdf', 'original.pdf', 'unrelated.txt']);
  assert.ok((await readdir(f.metadataDir)).some(name => name.includes('manifest')));
  assert.equal(await readFile(path.join(f.contextDir, 'unrelated.txt'), 'utf8'), 'USER OWNED');
  assert.equal((await f.pair.update(input)).pairId, result.pairId); assert.equal((await f.pair.update(input)).revision, result.revision);
});

test('latest atomically replaces its stable file while the first original and its provenance remain immutable', async t => {
  const f = await fixture(t), input = inputs(), first = await f.pair.update(input);
  const originalStat = await stat(path.join(f.contextDir, 'original.pdf'));
  const latest = { bytes: pdf(['A newer reviewed English candidate.']), snapshotId: 'snapshot-new', buildId: 'build-new', candidateHash: 'candidate-reviewed' };
  const next = await f.pair.update({ ...input, latest });
  assert.notEqual(next.pairId, first.pairId); assert.equal(next.revision, first.revision + 1);
  assert.deepEqual(next.original, first.original); assert.equal((await stat(path.join(f.contextDir, 'original.pdf'))).mtimeMs, originalStat.mtimeMs);
  assert.deepEqual(await readFile(path.join(f.contextDir, 'latest-english.pdf')), latest.bytes);
  await assert.rejects(f.pair.update({ ...input, original: { ...input.original, bytes: pdf(['Attempted original replacement.']) }, latest }), { code: 'ORIGINAL_IMMUTABLE' });
  assert.deepEqual(await readFile(path.join(f.contextDir, 'original.pdf')), input.original.bytes);
});

test('tampered managed bytes, an unrelated preexisting PDF, wrong paper identity and non-PDF input fail without overwriting', async t => {
  const f = await fixture(t), input = inputs(); await f.pair.update(input);
  await writeFile(path.join(f.contextDir, 'latest-english.pdf'), pdf(['External edit.']));
  await assert.rejects(f.pair.read(), { code: 'VERSION_PAIR_CHANGED' });
  await assert.rejects(f.pair.update(input), { code: 'VERSION_PAIR_CHANGED' });
  const other = await fixture(t); await mkdir(other.contextDir); await writeFile(path.join(other.contextDir, 'original.pdf'), pdf(['Unrelated file.']));
  await assert.rejects(other.pair.update(input), { code: 'VERSION_PAIR_UNMANAGED' });
  assert.deepEqual(await readFile(path.join(other.contextDir, 'original.pdf')), pdf(['Unrelated file.']));
  const valid = await fixture(t); await valid.pair.update(input);
  await assert.rejects(valid.pair.update({ ...input, projectId: 'another-paper' }), { code: 'VERSION_PAIR_PROJECT_MISMATCH' });
  await assert.rejects(valid.pair.update({ ...input, latest: { ...input.latest, bytes: Buffer.from('not PDF') } }), { code: 'INVALID_VERSION_PDF' });
});

test('metadata can use the paper parent directory while remaining outside its dedicated two-PDF context', async t => {
  const f = await fixture(t), pair = new PaperVersionPair({ contextDir: f.contextDir, metadataDir: f.root });
  await pair.update(inputs());
  assert.deepEqual((await readdir(f.contextDir)).sort(), ['latest-english.pdf', 'original.pdf']);
  assert.ok((await readdir(f.root)).includes('version-pair-manifest.json'));
});

test('proven interrupted first writes and completed latest replacements recover without creating another PDF version', async t => {
  const initial = await fixture(t), input = inputs(), first = await initial.pair.update(input);
  const partial = await fixture(t); await mkdir(partial.contextDir); await mkdir(partial.metadataDir);
  await writeFile(path.join(partial.contextDir, 'original.pdf'), input.original.bytes);
  await writeFile(path.join(partial.metadataDir, 'version-pair-pending.json'), JSON.stringify({ schemaVersion: 1, previous: null, next: first }) + '\n');
  await assert.rejects(partial.pair.read(), { code: 'VERSION_PAIR_RECOVERY_REQUIRED' });
  assert.deepEqual(await partial.pair.update(input), first);
  const updated = await partial.pair.update({ ...input, latest: { ...input.latest, bytes: pdf(['Recovered newer final.']), buildId: 'build-new' } });
  await writeFile(path.join(partial.metadataDir, 'version-pair-manifest.json'), JSON.stringify(first) + '\n');
  await writeFile(path.join(partial.metadataDir, 'version-pair-pending.json'), JSON.stringify({ schemaVersion: 1, previous: first, next: updated }) + '\n');
  const recovered = await partial.pair.read(); assert.equal(recovered.pairId, updated.pairId); assert.equal(recovered.latest.hash, updated.latest.hash);
  assert.deepEqual((await readdir(partial.contextDir)).sort(), ['latest-english.pdf', 'original.pdf']);
  assert.ok(!(await readdir(partial.metadataDir)).includes('version-pair-pending.json'));
});

test('path traversal, metadata in context and reparse or hard-linked managed files are rejected', async t => {
  const f = await fixture(t), input = inputs();
  assert.throws(() => new PaperVersionPair({ contextDir: path.join(f.root, 'a') + '/../context', metadataDir: f.metadataDir }));
  assert.throws(() => new PaperVersionPair({ contextDir: f.contextDir, metadataDir: path.join(f.contextDir, 'metadata') }));
  if (process.platform === 'win32') assert.throws(() => new PaperVersionPair({ contextDir: f.contextDir.toUpperCase(), metadataDir: path.join(f.contextDir.toLowerCase(), 'metadata') }));
  const elsewhere = path.join(f.root, 'elsewhere'); await mkdir(elsewhere);
  try { await symlink(elsewhere, f.contextDir, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('OS denied creating the synthetic junction.'); return; } throw error; }
  await assert.rejects(f.pair.update(input), { code: 'VERSION_PAIR_UNSAFE_PATH' });
  const hard = await fixture(t); await hard.pair.update(input); const latest = path.join(hard.contextDir, 'latest-english.pdf');
  try { await link(latest, path.join(hard.root, 'alias.pdf')); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('OS denied creating the synthetic hard link.'); return; } throw error; }
  await assert.rejects(hard.pair.read(), { code: 'VERSION_PAIR_UNSAFE_PATH' });
});

test('browser extraction verifies both exact hashes and includes every page of both PDFs', async t => {
  const f = await fixture(t); await f.pair.update(inputs()); const pair = await f.pair.read(), progress = [];
  const context = await browserExtract(pair, { onProgress: value => progress.push(value) });
  assert.equal(context.pairId, pair.pairId); assert.equal(context.original.pageCount, 2); assert.equal(context.latest.pageCount, 2);
  assert.deepEqual(context.original.pages.map(p => p.page), [1, 2]); assert.match(context.original.pages[1].text, /Second original page/);
  assert.match(context.latest.pages[1].text, /Latest English second page/); assert.equal(progress.at(-1).completedPages, 4);
  const corrupt = structuredClone(pair); corrupt.latest.hash = '0'.repeat(64);
  await assert.rejects(browserExtract(corrupt), { code: 'VERSION_PAIR_HASH_MISMATCH' });
});

test('browser extraction rejects OCR-only or incomplete pages and cancellation rather than claiming complete review', async t => {
  const f = await fixture(t), input = inputs(); input.latest.bytes = pdf(['Readable page.', '']); await f.pair.update(input); const pair = await f.pair.read();
  await assert.rejects(browserExtract(pair), { code: 'VERSION_PAIR_OCR_REQUIRED' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(browserExtract(pair, { signal: controller.signal }), { name: 'AbortError' });
});

test('browser extraction rejects oversized complete two-PDF context without dropping either document', async t => {
  // Keep all text inside the synthetic page, so clipping cannot fake a small context.
  const f = await fixture(t), input = inputs(); input.original.bytes = pdf(['A'.repeat(1100000)], 10000000); input.latest.bytes = pdf(['B'.repeat(1100000)], 10000000);
  await f.pair.update(input);
  await assert.rejects(browserExtract(await f.pair.read()), { code: 'VERSION_PAIR_CONTEXT_TOO_LARGE' });
});
