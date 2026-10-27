import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/build/pdf.mjs';

let workerUrl;
export function openPdfDocument(bytes) {
  workerUrl ||= URL.createObjectURL(new Blob([__PDF_WORKER_SOURCE__], { type: 'text/javascript' }));
  GlobalWorkerOptions.workerSrc = workerUrl;
  return getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, stopAtErrors: true });
}
export async function renderPdf(container, bytes, { page = 1, scale = 1, onPoint = null } = {}) {
  const task = openPdfDocument(bytes);
  const document = await task.promise;
  const canvas = window.document.createElement('canvas');
  const sheetHost = window.document.createElement('div'); sheetHost.className = 'pdf-sheet';
  const overlay = window.document.createElement('div'); overlay.className = 'pdf-location-overlay'; overlay.hidden = true; overlay.setAttribute('aria-hidden', 'true');
  const cursor = window.document.createElement('div'); cursor.className = 'pdf-point-cursor'; cursor.hidden = true; cursor.setAttribute('aria-hidden', 'true');
  canvas.setAttribute('aria-label', '原文 PDF 页面');
  canvas.style.maxWidth = '100%';
  canvas.style.height = 'auto';
  canvas.style.display = 'block'; canvas.tabIndex = 0;
  sheetHost.append(canvas, overlay, cursor); container.replaceChildren(sheetHost);
  let rendered, currentSheet, currentViewport, keyboardPoint = null, activeHighlight = null;
  function pageSize() { return currentSheet ? { width: currentSheet.view[2] - currentSheet.view[0], height: currentSheet.view[3] - currentSheet.view[1] } : null; }
  function viewportPoint(x, y) { return currentViewport.convertToViewportPoint(x + currentSheet.view[0], currentSheet.view[3] - y); }
  function positionCursor() {
    if (!keyboardPoint || !currentViewport) { cursor.hidden = true; return; }
    const [x, y] = viewportPoint(keyboardPoint.x, keyboardPoint.y);
    cursor.style.left = `${100 * x / currentViewport.width}%`; cursor.style.top = `${100 * y / currentViewport.height}%`; cursor.hidden = false;
  }
  canvas.addEventListener('click', event => {
    if (!currentViewport || !onPoint) return;
    const rect = canvas.getBoundingClientRect(), [x, y] = currentViewport.convertToPdfPoint((event.clientX - rect.left) * currentViewport.width / rect.width, (event.clientY - rect.top) * currentViewport.height / rect.height);
    onPoint({ page: viewer.page, x: x - currentSheet.view[0], y: currentSheet.view[3] - y });
  });
  canvas.addEventListener('keydown', event => {
    if (!onPoint || !currentSheet || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Escape') { keyboardPoint = null; positionCursor(); return; }
    const size = pageSize(); keyboardPoint ||= { x: size.width / 2, y: size.height / 2 };
    if (event.key === 'Enter') { onPoint({ page: viewer.page, ...keyboardPoint }); return; }
    const step = event.shiftKey ? 1 : 12;
    keyboardPoint.x = Math.max(0, Math.min(size.width, keyboardPoint.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0)));
    keyboardPoint.y = Math.max(0, Math.min(size.height, keyboardPoint.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0)));
    positionCursor();
    canvas.setAttribute('aria-label', `原文 PDF 第 ${viewer.page} 页，定位点 ${Math.round(keyboardPoint.x)}, ${Math.round(keyboardPoint.y)}。方向键移动，Enter 关联原文，Escape 取消。`);
  });
  const viewer = {
    pageCount: document.numPages, page: 1, scale: 1,
    async render(number = viewer.page, zoom = viewer.scale) {
      if (!Number.isInteger(number) || number < 1 || number > document.numPages || !Number.isFinite(zoom) || zoom < .5 || zoom > 3) throw new Error('页码或缩放无效。');
      if (rendered) { rendered.cancel(); try { await rendered.promise; } catch {} }
      const sheet = await document.getPage(number);
      const viewport = sheet.getViewport({ scale: zoom });
      currentSheet = sheet; currentViewport = viewport; keyboardPoint = null; overlay.hidden = true; cursor.hidden = true;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
      sheetHost.style.width = `${Math.ceil(viewport.width)}px`; canvas.style.width = '100%';
      const context = canvas.getContext('2d', { alpha: false });
      rendered = sheet.render({ canvasContext: context, viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
      await rendered.promise;
      viewer.page = number; viewer.scale = zoom;
      canvas.setAttribute('aria-label', `原文 PDF 第 ${number} 页，共 ${document.numPages} 页。点击关联原文，或使用方向键选择定位点、Enter 确认。`);
      if (activeHighlight?.page === number) viewer.highlight(activeHighlight);
      return viewer;
    },
    highlight(match) {
      if (!currentSheet || !currentViewport || match.page !== viewer.page) return false;
      const left = Number.isFinite(match.h) ? match.h : match.x, top = Number.isFinite(match.v) ? match.v - match.height : match.y;
      const width = Math.max(Number(match.width) || 0, 3), height = Math.max(Number(match.height) || 0, 8);
      if (![left, top, width, height].every(Number.isFinite)) return false;
      activeHighlight = { ...match };
      const first = viewportPoint(left, top), last = viewportPoint(left + width, top + height);
      overlay.style.left = `${100 * Math.min(first[0], last[0]) / currentViewport.width}%`; overlay.style.top = `${100 * Math.min(first[1], last[1]) / currentViewport.height}%`;
      overlay.style.width = `${100 * Math.abs(last[0] - first[0]) / currentViewport.width}%`; overlay.style.height = `${100 * Math.abs(last[1] - first[1]) / currentViewport.height}%`;
      overlay.hidden = false; overlay.scrollIntoView({ block: 'nearest', inline: 'nearest' }); return true;
    },
    clearHighlight() { activeHighlight = null; overlay.hidden = true; },
    async destroy() { if (rendered) rendered.cancel(); await task.destroy(); container.replaceChildren(); }
  };
  await viewer.render(page, scale);
  return viewer;
}
