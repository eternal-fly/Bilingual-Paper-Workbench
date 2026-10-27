// Local-only extraction. Uploaded content is data; no markup, macros,
// relationships, JavaScript, attachments or paths are ever executed or fetched.
import { REVIEW_IMPORT_LIMITS } from '../src/review-limits.mjs';
export { REVIEW_IMPORT_LIMITS } from '../src/review-limits.mjs';
const encoder = new TextEncoder();
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const yieldControl = () => new Promise(resolve => setTimeout(resolve, 0));
function extractionContext({ onProgress, signal } = {}) {
  if (onProgress !== undefined && typeof onProgress !== 'function' || signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) fail('INVALID_REVIEW_FILE', '导入进度或取消参数无效。');
  const check = () => { if (signal?.aborted) fail('REVIEW_IMPORT_CANCELLED', '评阅文件导入已取消；未提交部分内容。'); };
  return { signal, check, progress(stage, completed, total) { check(); onProgress?.({ stage, completed, total }); check(); } };
}
async function cancellable(promise, context) {
  context.check();
  if (!context.signal) return promise;
  let cancel;
  const aborted = new Promise((_, reject) => { cancel = () => reject(Object.assign(new Error('评阅文件导入已取消；未提交部分内容。'), { code: 'REVIEW_IMPORT_CANCELLED' })); context.signal.addEventListener('abort', cancel, { once: true }); });
  try { context.check(); return await Promise.race([promise, aborted]); }
  finally { context.signal.removeEventListener('abort', cancel); }
}
function normalized(value) { return value.replace(/^\ufeff/u, '').replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '').trim(); }
function boundedResult(text, annotations = []) {
  text = normalized(text);
  const size = encoder.encode(text).length + annotations.reduce((sum, item) => sum + encoder.encode(item.body || '').length + encoder.encode(item.title || '').length + encoder.encode(item.quote || '').length, 0);
  if (size > REVIEW_IMPORT_LIMITS.textBytes) fail('REVIEW_TOO_LARGE', `评阅文字或批注超过 ${REVIEW_IMPORT_LIMITS.textBytes / 1024 / 1024} MiB；未导入部分内容。`);
  return { text, ...(annotations.length ? { annotations } : {}) };
}
function decode(bytes) { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('INVALID_REVIEW_FILE', '文件不是有效的 UTF-8 文本。'); } }
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }

function zipDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), u16 = n => view.getUint16(n, true), u32 = n => view.getUint32(n, true);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === bytes.length) { end = i; break; }
  if (end < 0) fail('INVALID_REVIEW_FILE', 'DOCX ZIP 目录缺失或损坏。');
  const count = u16(end + 10), start = u32(end + 16), size = u32(end + 12);
  if (count === 0xffff || start === 0xffffffff || size === 0xffffffff) fail('UNSUPPORTED_REVIEW_FILE', '不支持 Zip64 DOCX。');
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count || start + size !== end || start > end) fail('INVALID_REVIEW_FILE', '不支持分卷或无效的 DOCX ZIP 目录。');
  if (count > REVIEW_IMPORT_LIMITS.zipEntries) fail('REVIEW_TOO_LARGE', 'DOCX ZIP 项目数量超过限制。');
  const entries = new Map(); let cursor = start, expanded = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) fail('INVALID_REVIEW_FILE', 'DOCX ZIP 目录条目损坏。');
    const flags = u16(cursor + 8), method = u16(cursor + 10), crc = u32(cursor + 16), compressed = u32(cursor + 20), uncompressed = u32(cursor + 24), nameLength = u16(cursor + 28), extraLength = u16(cursor + 30), commentLength = u16(cursor + 32), offset = u32(cursor + 42), next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || !nameLength) fail('INVALID_REVIEW_FILE', 'DOCX ZIP 条目长度无效。');
    if (flags & 0x41) fail('UNSUPPORTED_REVIEW_FILE', '不支持加密的 DOCX ZIP。');
    if (![0, 8].includes(method)) fail('UNSUPPORTED_REVIEW_FILE', 'DOCX ZIP 使用了不支持的压缩方法。');
    if ([compressed, uncompressed, offset].includes(0xffffffff) || u16(cursor + 34) === 0xffff) fail('UNSUPPORTED_REVIEW_FILE', '不支持 Zip64 DOCX。');
    if (u16(cursor + 34)) fail('INVALID_REVIEW_FILE', '不支持分卷 DOCX。');
    for (let extra = cursor + 46 + nameLength; extra < cursor + 46 + nameLength + extraLength;) {
      if (extra + 4 > cursor + 46 + nameLength + extraLength) fail('INVALID_REVIEW_FILE', 'DOCX ZIP 扩展字段损坏。');
      if (u16(extra) === 1) fail('UNSUPPORTED_REVIEW_FILE', '不支持 Zip64 DOCX。');
      extra += 4 + u16(extra + 2); if (extra > cursor + 46 + nameLength + extraLength) fail('INVALID_REVIEW_FILE', 'DOCX ZIP 扩展字段长度无效。');
    }
    const name = decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (name.includes('\\') || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.') || /[\u0000-\u001f:]/u.test(name) || entries.has(name)) fail('INVALID_REVIEW_FILE', 'DOCX ZIP 包含无效或重复的条目名称。');
    if (/\.xml(?:\.rels)?$/iu.test(name) || /\.rels$/iu.test(name)) expanded += uncompressed;
    if (expanded > REVIEW_IMPORT_LIMITS.expandedXmlBytes) fail('REVIEW_TOO_LARGE', `DOCX 解压 XML 超过 ${REVIEW_IMPORT_LIMITS.expandedXmlBytes / 1024 / 1024} MiB 限制。`);
    if (offset + 30 > start || u32(offset) !== 0x04034b50 || u16(offset + 6) !== flags || u16(offset + 8) !== method) fail('INVALID_REVIEW_FILE', 'DOCX ZIP 本地条目与目录不符。');
    const localNameLength = u16(offset + 26), localExtraLength = u16(offset + 28), dataStart = offset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressed > start || decode(bytes.subarray(offset + 30, offset + 30 + localNameLength)) !== name) fail('INVALID_REVIEW_FILE', 'DOCX ZIP 压缩数据越界。');
    entries.set(name, { method, crc, compressed, uncompressed, dataStart }); cursor = next;
  }
  if (cursor !== end) fail('INVALID_REVIEW_FILE', 'DOCX ZIP 目录长度不匹配。');
  return entries;
}
async function unzipXml(bytes, entry, context) {
  context.check();
  if (entry.uncompressed > REVIEW_IMPORT_LIMITS.expandedXmlBytes) fail('REVIEW_TOO_LARGE', 'DOCX XML 超过解压限制。');
  const compressed = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressed);
  let result;
  if (entry.method === 0) result = compressed;
  else {
    if (typeof DecompressionStream !== 'function') fail('UNSUPPORTED_REVIEW_FILE', '当前浏览器不支持 DOCX deflate 解压。');
    let reader; try { reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(); } catch { fail('UNSUPPORTED_REVIEW_FILE', '当前浏览器不支持 DOCX deflate 解压。'); }
    const cancel = () => { void reader.cancel().catch(() => {}); };
    context.signal?.addEventListener('abort', cancel, { once: true });
    const chunks = []; let length = 0;
    try {
      context.check();
      while (true) { const { value, done } = await reader.read(); context.check(); if (done) break; length += value.length; if (length > entry.uncompressed || length > REVIEW_IMPORT_LIMITS.expandedXmlBytes) { await reader.cancel(); fail('REVIEW_TOO_LARGE', 'DOCX 实际解压数据超过声明大小或 XML 解压限制。'); } chunks.push(value); }
    } catch (error) { if (error.code) throw error; fail('INVALID_REVIEW_FILE', 'DOCX 压缩数据损坏。'); }
    finally { context.signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
    result = new Uint8Array(length); let cursor = 0; for (const chunk of chunks) { result.set(chunk, cursor); cursor += chunk.length; }
  }
  context.check();
  if (result.length !== entry.uncompressed || crc32(result) !== entry.crc) fail('INVALID_REVIEW_FILE', 'DOCX XML 大小或校验和不符。');
  return decode(result);
}
function entities(value) {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/iu.test(value)) fail('INVALID_REVIEW_FILE', 'DOCX XML 含有不支持的实体。');
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/giu, entity => {
    const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }; if (named[entity]) return named[entity];
    const number = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    if (!Number.isInteger(number) || number <= 0 || number > 0x10ffff || number >= 0xd800 && number <= 0xdfff) fail('INVALID_REVIEW_FILE', 'DOCX XML 字符实体无效。');
    return String.fromCodePoint(number);
  });
}
async function xmlText(xml, comments, context) {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml) || !xml.includes('http://schemas.openxmlformats.org/wordprocessingml/2006/main') && !xml.includes('http://purl.oclc.org/ooxml/wordprocessingml/main')) fail('INVALID_REVIEW_FILE', 'DOCX XML 命名空间无效或包含被禁止的实体声明。');
  const stack = [], annotations = [], output = []; let current = null, textDepth = 0, textBytes = 0, tokenCount = 0;
  function append(value) {
    textBytes += encoder.encode(value).length;
    if (textBytes > REVIEW_IMPORT_LIMITS.textBytes) fail('REVIEW_TOO_LARGE', `DOCX 文字或批注超过 ${REVIEW_IMPORT_LIMITS.textBytes / 1024 / 1024} MiB 导入限制。`);
    if (comments && current) current.body += value; else if (!comments) output.push(value);
  }
  for (const [token] of xml.matchAll(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^>]*>|[^<]+/gu)) {
    if (++tokenCount % 2048 === 0) { await yieldControl(); context.check(); }
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (!token.startsWith('<')) { if (textDepth) append(entities(token)); continue; }
    const match = token.match(/^<(\/)?([A-Za-z_][\w.:-]*)(?:\s[^<>]*)?\s*(\/)?\s*>$/u);
    if (!match) fail('INVALID_REVIEW_FILE', 'DOCX XML 标签损坏。');
    const [, closing, fullName, selfClosing] = match, name = fullName.split(':').at(-1);
    if (closing) {
      if (stack.pop() !== fullName) fail('INVALID_REVIEW_FILE', 'DOCX XML 标签不匹配。');
      if (name === 't') textDepth--;
      if (name === 'p') append('\n');
      if (comments && name === 'comment') { current.body = normalized(current.body); if (current.body) annotations.push(current); current = null; }
    } else {
      if (comments && name === 'comment') { if (current) fail('INVALID_REVIEW_FILE', 'DOCX 批注嵌套无效。'); const author = token.match(/\b(?:[\w]+:)?author\s*=\s*(?:"([^"]*)"|'([^']*)')/u); current = { body: '', ...(author ? { title: entities(author[1] ?? author[2]) } : {}) }; }
      if (name === 't') textDepth++;
      if (name === 'tab' || name === 'br' || name === 'cr') append(name === 'tab' ? '\t' : '\n');
      if (!selfClosing) stack.push(fullName); else if (name === 't') textDepth--;
    }
  }
  if (stack.length) fail('INVALID_REVIEW_FILE', 'DOCX XML 未完整闭合。');
  return comments ? annotations : normalized(output.join(''));
}
async function docx(bytes, context) {
  const entries = zipDirectory(bytes), document = entries.get('word/document.xml');
  if (!document) fail('INVALID_REVIEW_FILE', 'DOCX 缺少 word/document.xml。');
  const comments = entries.get('word/comments.xml'), total = comments ? 2 : 1;
  context.progress('extracting', 0, total);
  const text = await xmlText(await unzipXml(bytes, document, context), false, context);
  context.progress('extracting', 1, total);
  const annotations = comments ? await xmlText(await unzipXml(bytes, comments, context), true, context) : [];
  if (comments) context.progress('extracting', 2, total);
  context.check();
  return boundedResult(text, annotations);
}
let workerUrl;
async function pdf(bytes, context) {
  context.check();
  if (decode(bytes.subarray(0, 5)) !== '%PDF-') fail('INVALID_REVIEW_FILE', 'PDF 文件标记无效。');
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist/build/pdf.mjs');
  if (typeof __PDF_WORKER_SOURCE__ !== 'undefined') { workerUrl ||= URL.createObjectURL(new Blob([__PDF_WORKER_SOURCE__], { type: 'text/javascript' })); GlobalWorkerOptions.workerSrc = workerUrl; }
  const task = getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, stopAtErrors: true, enableXfa: false });
  const cancel = () => { void task.destroy().catch(() => {}); };
  context.signal?.addEventListener('abort', cancel, { once: true });
  try {
    context.check();
    const document = await task.promise;
    context.check();
    if (document.numPages > REVIEW_IMPORT_LIMITS.pdfPages) fail('REVIEW_TOO_LARGE', `PDF 超过 ${REVIEW_IMPORT_LIMITS.pdfPages} 页导入限制。`);
    const pages = [], annotations = []; let textBytes = 0;
    const addBytes = value => { textBytes += encoder.encode(value).length; if (textBytes > REVIEW_IMPORT_LIMITS.textBytes) fail('REVIEW_TOO_LARGE', `PDF 文字和批注超过 ${REVIEW_IMPORT_LIMITS.textBytes / 1024 / 1024} MiB 导入限制。`); };
    context.progress('extracting', 0, document.numPages);
    for (let number = 1; number <= document.numPages; number++) {
      context.check();
      const page = await document.getPage(number);
      try {
        const content = await page.getTextContent(); context.check();
        const pageText = normalized(content.items.filter(item => typeof item.str === 'string').map(item => item.str + (item.hasEOL ? '\n' : ' ')).join(''));
        addBytes(pageText); if (number > 1) addBytes('\n\n'); pages.push(pageText);
        for (const annotation of await page.getAnnotations({ intent: 'display' })) {
          context.check();
          const body = normalized(annotation.contentsObj?.str || (typeof annotation.contents === 'string' ? annotation.contents : ''));
          if (body) { const title = normalized(annotation.titleObj?.str || ''); addBytes(body); addBytes(title); annotations.push({ body, ...(title ? { title } : {}), page: number }); }
        }
      } finally { page.cleanup(); }
      context.progress('extracting', number, document.numPages);
      await yieldControl(); context.check();
    }
    const result = boundedResult(pages.join('\n\n'), annotations);
    if (!result.text && !result.annotations?.length) fail('OCR_UNAVAILABLE', 'PDF 没有可提取文字或批注；此导入器未提供 OCR，请上传文字版评阅意见。');
    return result;
  } catch (error) { context.check(); if (error.code) throw error; fail('INVALID_REVIEW_FILE', 'PDF 无法解析，可能已加密或文件损坏。'); }
  finally { context.signal?.removeEventListener('abort', cancel); await task.destroy(); }
}

export async function parseReviewFile(file, options = {}) {
  const context = extractionContext(options); context.check();
  if (!file || typeof file.name !== 'string' || typeof file.arrayBuffer !== 'function' || !Number.isSafeInteger(file.size) || file.size < 0) fail('INVALID_REVIEW_FILE', '请选择一个有效的评阅文件。');
  if (file.size > REVIEW_IMPORT_LIMITS.fileBytes) fail('REVIEW_TOO_LARGE', `评阅文件超过 ${REVIEW_IMPORT_LIMITS.fileBytes / 1024 / 1024} MiB 导入限制。`);
  const filename = file.name.split(/[\\/]/u).at(-1);
  if (!filename || filename.length > 240 || /[\u0000-\u001f]/u.test(filename)) fail('INVALID_REVIEW_FILE', '评阅文件名无效。');
  const extension = filename.split('.').at(-1).toLowerCase(), format = extension === 'markdown' ? 'md' : extension;
  if (!['txt', 'md', 'json', 'pdf', 'docx'].includes(format)) fail('UNSUPPORTED_REVIEW_FORMAT', '支持 TXT、MD、JSON、PDF 和 DOCX 评阅文件。');
  context.progress('reading', 0, file.size);
  const bytes = new Uint8Array(await cancellable(file.arrayBuffer(), context)); context.check();
  if (bytes.length !== file.size || bytes.length > REVIEW_IMPORT_LIMITS.fileBytes) fail('REVIEW_TOO_LARGE', '评阅文件实际大小与声明不符或超过限制。');
  const fileHash = [...new Uint8Array(await cancellable(crypto.subtle.digest('SHA-256', bytes), context))].map(value => value.toString(16).padStart(2, '0')).join('');
  context.progress('reading', file.size, file.size);
  let result;
  if (format === 'pdf') result = await pdf(bytes, context);
  else if (format === 'docx') result = await docx(bytes, context);
  else {
    context.progress('extracting', 0, bytes.length);
    const text = decode(bytes);
    if (format === 'json') try { JSON.parse(text.replace(/^\ufeff/u, '')); } catch { fail('INVALID_REVIEW_FILE', '评阅 JSON 格式无效。'); }
    result = boundedResult(text);
    context.progress('extracting', bytes.length, bytes.length);
  }
  context.check();
  if (!result.text && !result.annotations?.length) fail('INVALID_REVIEW_FILE', '评阅文件没有可提取的文字或批注。');
  return { filename, format, fileHash, ...result };
}
