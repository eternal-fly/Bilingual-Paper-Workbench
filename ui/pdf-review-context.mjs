const MAX_PDF = 20 * 1024 * 1024, MAX_TEXT = 2 * 1024 * 1024, MAX_PAGES = 500;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const cancelled = signal => { if (signal?.aborted) fail('REVIEW_CANCELLED', '当前 PDF 阅读已取消。'); };
let workerUrl;
/** Current candidate content is context only; it never becomes source authority. */
export async function extractActivePdfContext(artifact, { signal, onProgress = () => {} } = {}) {
  cancelled(signal);
  const hash = artifact?.hash || artifact?.pdfHash;
  if (typeof artifact?.buildId !== 'string' || !/^[a-f0-9]{64}$/i.test(hash || '') || typeof artifact?.base64 !== 'string' || artifact.base64.length > Math.ceil(MAX_PDF / 3) * 4) fail('INVALID_PDF_CONTEXT', '当前 PDF 缺少精确构建或散列。');
  let bytes; try { bytes = Uint8Array.from(atob(artifact.base64), ch => ch.charCodeAt(0)); } catch { fail('INVALID_PDF_CONTEXT', '当前 PDF 数据无效。'); }
  const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (bytes.length > MAX_PDF || new TextDecoder('ascii').decode(bytes.subarray(0, 5)) !== '%PDF-' || actual !== hash.toLowerCase()) fail('PDF_CONTEXT_HASH_MISMATCH', '当前 PDF 已变化，请重新打开后再审阅。');
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist/build/pdf.mjs');
  if (typeof __PDF_WORKER_SOURCE__ !== 'undefined') { workerUrl ||= URL.createObjectURL(new Blob([__PDF_WORKER_SOURCE__], { type: 'text/javascript' })); GlobalWorkerOptions.workerSrc = workerUrl; }
  const task = getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, stopAtErrors: true, enableXfa: false });
  task.onPassword = () => { void task.destroy(); };
  const abort = () => { task.destroy().catch(() => {}); }; signal?.addEventListener('abort', abort, { once: true });
  try {
    const document = await task.promise; cancelled(signal); if (document.numPages < 1 || document.numPages > MAX_PAGES) fail('PDF_CONTEXT_TOO_LARGE', '当前 PDF 超出完整审阅页数限制。');
    const result = { buildId: artifact.buildId, hash: actual, pageCount: document.numPages, pages: [] }; let size = 0;
    for (let page = 1; page <= document.numPages; page++) {
      cancelled(signal); const current = await document.getPage(page);
      try {
        const content = await current.getTextContent(); cancelled(signal); const text = content.items.filter(item => typeof item.str === 'string').map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').replace(/\r\n?/g, '\n').trim();
        if (!text) fail('PDF_CONTEXT_OCR_REQUIRED', `当前 PDF 第 ${page} 页没有可读取文字，需要 OCR 后才能完整审阅。`);
        size += new TextEncoder().encode(JSON.stringify({ page, text })).length; if (size > MAX_TEXT) fail('PDF_CONTEXT_TOO_LARGE', '当前 PDF 的完整上下文超过 2 MiB，未发送部分内容。');
        result.pages.push({ page, text }); onProgress({ page, pageCount: document.numPages });
      } finally { current.cleanup(); }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return result;
  } catch (problem) { cancelled(signal); if (problem.code) throw problem; fail('INVALID_PDF_CONTEXT', '当前 PDF 未完整提取，审阅未发送。'); }
  finally { signal?.removeEventListener('abort', abort); await task.destroy(); }
}
