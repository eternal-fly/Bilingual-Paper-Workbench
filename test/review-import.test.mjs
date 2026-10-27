import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { parseReviewFile, REVIEW_IMPORT_LIMITS } from '../ui/review-import.mjs';

const file = (name, bytes, type = '') => new File([bytes], name, { type });
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const [name, text, options = {}] of entries) {
    const raw = Buffer.from(text), nameBytes = Buffer.from(name), data = options.deflate ? deflateRawSync(raw) : raw;
    const flags = options.flags || 0, method = options.method ?? (options.deflate ? 8 : 0), crc = crc32(raw), expanded = options.expanded ?? raw.length;
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(flags, 6); head.writeUInt16LE(method, 8); head.writeUInt32LE(crc, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(expanded, 22); head.writeUInt16LE(nameBytes.length, 26);
    local.push(head, nameBytes, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(flags, 8); c.writeUInt16LE(method, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(expanded, 24); c.writeUInt16LE(nameBytes.length, 28); c.writeUInt32LE(offset, 42); central.push(c, nameBytes); offset += head.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const documentXml = text => `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
function pdf({ text = 'Reviewer text.', comment = 'Check the proof.', pages = 1, fontSize = 12 } = {}) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ')}] /Count ${pages} >>`];
  const streamId = 3 + pages, fontId = streamId + 1, annotationId = fontId + 1;
  for (let i = 0; i < pages; i++) objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${streamId} 0 R ${comment ? `/Annots [${annotationId} 0 R]` : ''} >>`);
  const stream = text ? `BT /F1 ${fontSize} Tf 72 700 Td (${text}) Tj ET` : '';
  objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  if (comment) objects.push(`<< /Type /Annot /Subtype /Text /Rect [72 650 92 670] /Contents (${comment}) /T (Reviewer) >>`);
  let result = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result); result += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return result;
}

test('TXT and MD normalize line endings and keep only filename plus original digest', async () => {
  const bytes = '\ufeff# Review\r\n\r\n<script>steal()</script>\r\n';
  for (const name of ['review.txt', 'review.md']) {
    const parsed = await parseReviewFile(file('C:\\fakepath\\' + name, bytes));
    assert.equal(parsed.filename, name); assert.equal(parsed.text, '# Review\n\n<script>steal()</script>');
    assert.equal(parsed.fileHash, createHash('sha256').update(bytes).digest('hex')); assert.equal(parsed.path, undefined);
  }
});

test('unsupported extension, invalid UTF-8, invalid JSON and oversized input fail explicitly', async () => {
  await assert.rejects(parseReviewFile(file('review.html', '<p>text</p>')), { code: 'UNSUPPORTED_REVIEW_FORMAT' });
  await assert.rejects(parseReviewFile(file('review.txt', new Uint8Array([0xff]))), { code: 'INVALID_REVIEW_FILE' });
  await assert.rejects(parseReviewFile(file('review.json', '{bad}')), { code: 'INVALID_REVIEW_FILE' });
  await assert.rejects(parseReviewFile(file('review.txt', 'x'.repeat(32 * 1024 * 1024 + 1))), { code: 'REVIEW_TOO_LARGE' });
  await assert.rejects(parseReviewFile({ name: 'review.txt', size: 64 * 1024 * 1024 + 1, arrayBuffer() { throw new Error('must not read'); } }), { code: 'REVIEW_TOO_LARGE' });
});

test('large text and DOCX exceed the old 64 KiB ceiling without truncation', async () => {
  const text = '评阅意见。'.repeat(10000);
  for (const [name, bytes] of [['large.txt', text], ['large.docx', zip([['word/document.xml', documentXml(text), { deflate: true }]])]]) {
    const result = await parseReviewFile(file(name, bytes)); assert.equal(result.text, text); assert.ok(Buffer.byteLength(result.text) > 64 * 1024);
  }
});

test('the 32 MiB text ceiling counts UTF-8 bytes and does not split multibyte characters', async () => {
  const atLimit = '中'.repeat(Math.floor(32 * 1024 * 1024 / 3)) + 'a'.repeat(32 * 1024 * 1024 % 3);
  assert.equal((await parseReviewFile(file('exact.txt', atLimit))).text, atLimit);
  await assert.rejects(parseReviewFile(file('over.txt', atLimit + '中')), { code: 'REVIEW_TOO_LARGE' });
});

test('progress is explicit and aborting never returns partial extraction', async () => {
  const events = []; const controller = new AbortController(); controller.abort();
  await assert.rejects(parseReviewFile({ name: 'review.txt', size: 2, arrayBuffer() { throw new Error('must not read an aborted file'); } }, { signal: controller.signal }), { code: 'REVIEW_IMPORT_CANCELLED' });
  const text = 'Review text.'; const result = await parseReviewFile(file('review.txt', text), { onProgress: event => events.push(event) });
  assert.equal(result.text, text); assert.deepEqual(events.map(event => event.stage), ['reading', 'reading', 'extracting', 'extracting']);
  assert.ok(events.every(event => Number.isSafeInteger(event.completed) && Number.isSafeInteger(event.total) && event.completed <= event.total));
  let finishRead; const delayedController = new AbortController();
  const pending = parseReviewFile({ name: 'pending.txt', size: 2, arrayBuffer: () => new Promise(resolve => { finishRead = resolve; }) }, { signal: delayedController.signal });
  delayedController.abort();
  await assert.rejects(Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('abort must not wait for file read')), 100))]), { code: 'REVIEW_IMPORT_CANCELLED' });
  finishRead(new Uint8Array([65, 66]).buffer);
});

test('browser and backend share coherent file and extraction limits', () => {
  assert.deepEqual(REVIEW_IMPORT_LIMITS, { fileBytes: 64 * 1024 * 1024, textBytes: 32 * 1024 * 1024, pdfPages: 2000, zipEntries: 4096, expandedXmlBytes: 128 * 1024 * 1024, httpBytes: 96 * 1024 * 1024, ordinaryHttpBytes: 8 * 1024 * 1024 });
});

test('DOCX extracts text and comments without fetching external relationships', async () => {
  const bytes = zip([
    ['word/document.xml', documentXml('Review &amp; evidence.'), { deflate: true }],
    ['word/comments.xml', '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="Reader"><w:p><w:r><w:t>Check the assumption.</w:t></w:r></w:p></w:comment></w:comments>'],
    ['word/_rels/document.xml.rels', '<Relationships><Relationship TargetMode="External" Target="https://invalid.example/steal"/></Relationships>']
  ]);
  const previous = globalThis.fetch; globalThis.fetch = () => { throw new Error('external fetch forbidden'); };
  try { const parsed = await parseReviewFile(file('review.docx', bytes)); assert.equal(parsed.text, 'Review & evidence.'); assert.equal(parsed.annotations[0].body, 'Check the assumption.'); assert.equal(parsed.annotations[0].title, 'Reader'); }
  finally { globalThis.fetch = previous; }
});

test('DOCX retains all 5001 review annotations within its complete extraction byte budget', async () => {
  const comments = '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' + Array.from({ length: 5001 }, (_, index) => `<w:comment w:id="${index}" w:author="Reader"><w:p><w:r><w:t>Exact concern ${index + 1}.</w:t></w:r></w:p></w:comment>`).join('') + '</w:comments>';
  const result = await parseReviewFile(file('complete-review.docx', zip([['word/document.xml', documentXml('Complete synthetic review.')], ['word/comments.xml', comments, { deflate: true }]])));
  assert.equal(result.annotations.length, 5001); assert.equal(result.annotations.at(-1).body, 'Exact concern 5001.');
});

test('DOCX rejects zip bombs, encryption, Zip64, unsupported methods and XML entities', async () => {
  for (const options of [{ expanded: 128 * 1024 * 1024 + 1 }, { flags: 1 }, { method: 99 }, { expanded: 0xffffffff }]) {
    await assert.rejects(parseReviewFile(file('review.docx', zip([['word/document.xml', documentXml('x'), options]]))), error => ['REVIEW_TOO_LARGE', 'INVALID_REVIEW_FILE', 'UNSUPPORTED_REVIEW_FILE'].includes(error.code));
  }
  await assert.rejects(parseReviewFile(file('review.docx', zip([['word/document.xml', '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///secret">]>' + documentXml('&e;')]]))), { code: 'INVALID_REVIEW_FILE' });
  await assert.rejects(parseReviewFile(file('review.docx', zip([['word/document.xml', documentXml('x'.repeat(100000)), { deflate: true, expanded: 100 }]]))), { code: 'REVIEW_TOO_LARGE' });
  await assert.rejects(parseReviewFile(file('review.docx', zip([['word/document.xml', documentXml('x'.repeat(32 * 1024 * 1024 + 1)), { deflate: true }]]))), { code: 'REVIEW_TOO_LARGE' });
  await assert.rejects(parseReviewFile(file('review.docx', zip([['word/document.xml', documentXml('x')], ...Array.from({ length: 4096 }, (_, i) => [`empty-${i}.xml`, ''])]))), { code: 'REVIEW_TOO_LARGE' });
  await assert.rejects(parseReviewFile(file('review.docx', zip([['word/document.xml', documentXml('x')], ['../word/comments.xml', '']]))) , { code: 'INVALID_REVIEW_FILE' });
});

test('PDF extracts bounded selectable text and comments; image-only PDF reports OCR unavailable', async () => {
  // PDF.js 6's browser build uses this standardized browser API; Node 24
  // does not yet provide it. Keep the compatibility shim in the test only.
  const previous = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toHex');
  if (!previous) Object.defineProperty(Uint8Array.prototype, 'toHex', { configurable: true, value() { return Buffer.from(this).toString('hex'); } });
  try {
    const parsed = await parseReviewFile(file('review.pdf', pdf()));
    assert.equal(parsed.text, 'Reviewer text.'); assert.equal(parsed.annotations[0].body, 'Check the proof.'); assert.equal(parsed.annotations[0].page, 1);
    await assert.rejects(parseReviewFile(file('scan.pdf', pdf({ text: '', comment: '' }))), { code: 'OCR_UNAVAILABLE' });
    const events = [], text = 'Complete reviewer paragraph. '.repeat(15).trim();
    const large = await parseReviewFile(file('large.pdf', pdf({ pages: 220, text, comment: '', fontSize: 2 })), { onProgress: event => events.push(event) });
    assert.equal(large.text, Array(220).fill(text).join('\n\n')); assert.ok(Buffer.byteLength(large.text) > 65536);
    assert.deepEqual(events.at(-1), { stage: 'extracting', completed: 220, total: 220 });
    const controller = new AbortController();
    await assert.rejects(parseReviewFile(file('cancel.pdf', pdf({ pages: 5 })), { signal: controller.signal, onProgress: event => { if (event.stage === 'extracting' && event.completed === 2) controller.abort(); } }), { code: 'REVIEW_IMPORT_CANCELLED' });
    await assert.rejects(parseReviewFile(file('many.pdf', pdf({ pages: 2001 }))), { code: 'REVIEW_TOO_LARGE' });
  } finally { if (previous) Object.defineProperty(Uint8Array.prototype, 'toHex', previous); else delete Uint8Array.prototype.toHex; }
});
