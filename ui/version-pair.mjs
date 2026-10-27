const MAX_PDF = 20 * 1024 * 1024, MAX_CONTEXT = 2 * 1024 * 1024, MAX_PAGES = 500;
const encoder = new TextEncoder();
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function cancelled(signal) { if (signal?.aborted) throw Object.assign(new Error('PDF pair extraction was cancelled.'), { name: 'AbortError', code: 'REVIEW_CANCELLED' }); }
let workerUrl;
async function checkedBytes(item, filename, signal) {
  cancelled(signal);
  if (!item || item.filename !== filename || !/^[a-f0-9]{64}$/u.test(item.hash || '') || !Number.isSafeInteger(item.byteLength) || item.byteLength < 32 || item.byteLength > MAX_PDF || typeof item.base64 !== 'string' || item.base64.length > Math.ceil(MAX_PDF / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(item.base64)) fail('INVALID_VERSION_PAIR', 'A complete bounded original/latest PDF pair is required.');
  let binary; try { binary = atob(item.base64); } catch { fail('INVALID_VERSION_PAIR', 'A PDF has invalid base64 bytes.'); }
  const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
  const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  cancelled(signal);
  if (bytes.length !== item.byteLength || actual !== item.hash || new TextDecoder('ascii').decode(bytes.subarray(0, 5)) !== '%PDF-') fail('VERSION_PAIR_HASH_MISMATCH', 'PDF bytes differ from the exact selected version pair.');
  return bytes;
}

/** Every page of both exact PDFs, or an explicit failure; no partial review claim. */
export async function extractVersionPair(pair, { signal, onProgress = () => {} } = {}) {
  cancelled(signal);
  if (!pair || typeof pair.pairId !== 'string' || !/^pair-[a-f0-9]{32}$/u.test(pair.pairId)) fail('INVALID_VERSION_PAIR', 'An exact version-pair identity is required.');
  const bytes = { original: await checkedBytes(pair.original, 'original.pdf', signal), latest: await checkedBytes(pair.latest, 'latest-english.pdf', signal) };
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist/build/pdf.mjs');
  if (typeof __PDF_WORKER_SOURCE__ !== 'undefined') { workerUrl ||= URL.createObjectURL(new Blob([__PDF_WORKER_SOURCE__], { type: 'text/javascript' })); GlobalWorkerOptions.workerSrc = workerUrl; }
  const tasks = [], documents = {}, context = { pairId: pair.pairId, original: { hash: pair.original.hash, pageCount: 0, pages: [] }, latest: { hash: pair.latest.hash, pageCount: 0, pages: [] } };
  const abort = () => { for (const task of tasks) void task.destroy(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (const kind of ['original', 'latest']) {
      cancelled(signal);
      const task = getDocument({ data: bytes[kind], isEvalSupported: false, useSystemFonts: false, disableFontFace: true, stopAtErrors: true, enableXfa: false });
      tasks.push(task); task.onPassword = () => { void task.destroy(); };
      const document = await task.promise; cancelled(signal);
      if (!Number.isSafeInteger(document.numPages) || document.numPages < 1 || document.numPages > MAX_PAGES) fail('VERSION_PAIR_TOO_LARGE', 'A version PDF exceeds the complete-page extraction limit.');
      documents[kind] = document; context[kind].pageCount = document.numPages;
    }
    let completedPages = 0, contextBytes = encoder.encode(JSON.stringify(context)).length; const totalPages = context.original.pageCount + context.latest.pageCount;
    for (const kind of ['original', 'latest']) for (let page = 1; page <= context[kind].pageCount; page++) {
      cancelled(signal); const current = await documents[kind].getPage(page), content = await current.getTextContent(); cancelled(signal);
      const text = content.items.filter(item => typeof item.str === 'string').map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').replace(/\r\n?/gu, '\n').trim();
      if (!text) fail('VERSION_PAIR_OCR_REQUIRED', `The ${kind} PDF page ${page} has no readable text; complete review requires OCR or a readable PDF.`);
      const item = { page, text }; contextBytes += encoder.encode(JSON.stringify(item)).length + (context[kind].pages.length ? 1 : 0);
      context[kind].pages.push(item); current.cleanup();
      if (contextBytes > MAX_CONTEXT) fail('VERSION_PAIR_CONTEXT_TOO_LARGE', 'The complete two-PDF text exceeds the 2 MiB model-context limit; no pages were silently dropped.');
      completedPages++; onProgress({ phase: kind, page, pageCount: context[kind].pageCount, completedPages, totalPages });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    cancelled(signal); return context;
  } catch (error) { cancelled(signal); if (error.code) throw error; fail('VERSION_PAIR_PDF_INVALID', 'Both selected PDFs must be completely readable; extraction did not finish.'); }
  finally { signal?.removeEventListener('abort', abort); await Promise.allSettled(tasks.map(task => task.destroy())); }
}
