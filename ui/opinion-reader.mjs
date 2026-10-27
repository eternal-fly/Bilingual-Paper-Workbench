import { openPdfDocument } from './pdf.mjs';

const maxEntries = 16, maxBytes = 20 * 1024 * 1024;
const node = (tag, className, text) => {
  const value = document.createElement(tag); if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
};

/** Read-only presentation. All prose is text, and only verified PDF pixels replace math. */
export function createOpinionReader({ root, api, language = () => 'zh-CN' } = {}) {
  const copy = (zh, en, tw = zh) => language() === 'zh-CN' ? zh : language() === 'zh-TW' ? tw : en;
  const mounted = new Set(), observed = new Map(), cache = new Map(), inflight = new Map(), modes = new Map(), queue = [];
  let cachedBytes = 0, running = false;
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      const view = observed.get(entry.target); if (!view) continue;
      view.visible = entry.isIntersecting;
      if (view.visible && view.mode === 'reading') schedule(view);
      else if (!view.visible) release(view);
    }
  }, { root: root || null, threshold: .01 }) : null;
  const alive = view => mounted.has(view) && view.card.isConnected;
  function remember(key, result) {
    const size = key.length * 2 + (result.pdf?.base64?.length || 0) + JSON.stringify(result.fields || {}).length * 2;
    if (size > maxBytes) return;
    if (cache.has(key)) cachedBytes -= cache.get(key).size;
    cache.delete(key); cache.set(key, { result, size }); cachedBytes += size;
    while (cache.size > maxEntries || cachedBytes > maxBytes) { const first = cache.keys().next().value; cachedBytes -= cache.get(first).size; cache.delete(first); }
  }
  async function compile(view) {
    if (cache.has(view.key)) return cache.get(view.key).result;
    if (inflight.has(view.key)) return inflight.get(view.key);
    const promise = api('compileReviewNote', { noteId: view.expected.noteId, expectedRevision: view.expected.noteRevision }).then(result => {
      if (!result || typeof result !== 'object') throw Error('意见排版没有返回可阅读内容。');
      if (Object.entries(view.expected).some(([field, value]) => result[field] !== value)) throw Object.assign(Error(copy('论文或意见身份已变化，请重新打开当前意见。', 'Paper or opinion identity changed. Reopen its current reading view.', '論文或意見識別已變化，請重新開啟目前意見。')), { code: 'VERSION_CONFLICT' });
      return result;
    });
    inflight.set(view.key, promise);
    try { const result = await promise; remember(view.key, result); return result; }
    finally { inflight.delete(view.key); }
  }
  function schedule(view) {
    if (!alive(view) || !view.visible || view.mode !== 'reading' || view.queued || view.pending || view.started || view.result) return;
    view.queued = true; queue.push(view); void drain();
  }
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const view = queue.shift(); view.queued = false;
        if (!alive(view) || !view.visible || view.mode !== 'reading' || view.pending || view.started || view.result) continue;
        view.started = true; view.pending = true; view.card.dataset.opinionStatus = 'loading'; view.status.textContent = copy('公式排版中…', 'Typesetting math…', '公式排版中…');
        try {
          const result = await compile(view);
          if (!alive(view)) continue;
          if (!view.visible) { release(view); continue; }
          view.result = result;
          view.card.dataset.opinionStatus = 'ready';
          if (view.mode === 'reading') await paint(view);
          else setStatus(view);
        } catch (error) {
          if (!alive(view)) continue;
          if (!view.visible) { release(view); continue; }
          view.card.dataset.opinionStatus = 'failed'; view.status.textContent = `${copy('公式暂无法排版，完整源码已保留。', 'Math unavailable; complete source is retained.', '公式暫無法排版，完整原始碼已保留。')}${error.code ? ` ${error.code}` : ''}`;
          view.status.title = error.message || ''; view.status.dataset.status = 'failed';
        } finally { view.pending = false; }
      }
    } finally { running = false; }
  }
  function setStatus(view) {
    const diagnostics = view.result?.diagnostics || [];
    view.status.dataset.status = diagnostics.length ? 'partial' : 'ready';
    view.status.textContent = view.mode === 'source' ? copy('源码视图 · 内容未改', 'Source view · unchanged', '原始碼檢視 · 內容未改') : diagnostics.length ? copy('部分公式保留源码，可切换核对。', 'Some math remains as source; switch to inspect.', '部分公式保留原始碼，可切換核對。') : view.result?.pdf ? copy('公式已排版 · XeLaTeX', 'Math typeset · XeLaTeX') : copy('阅读视图', 'Reading view', '閱讀檢視');
    view.status.title = diagnostics.map(item => item.message || item.code).filter(Boolean).join('\n');
  }
  async function disposePdf(view) {
    view.paintGeneration++;
    for (const task of view.renders) { try { task.cancel(); } catch {} }
    view.renders.clear();
    view.pdf = null;
    if (view.pdfTask) { const task = view.pdfTask; view.pdfTask = null; view.pdf = null; try { await task.destroy(); } catch {} }
  }
  function release(view) {
    // Keep the exact inline geometry so releasing a card above the viewport
    // does not move the reader's current paragraph. No PDF pixels remain.
    for (const canvas of view.card.querySelectorAll('.opinion-math-canvas')) {
      const placeholder = node('span', 'opinion-math-placeholder'); placeholder.setAttribute('aria-hidden', 'true');
      placeholder.style.display = 'block'; placeholder.style.width = canvas.style.width; placeholder.style.height = canvas.style.height;
      canvas.replaceWith(placeholder);
    }
    view.result = null; view.started = false; view.card.dataset.opinionStatus = 'offscreen';
    void disposePdf(view);
  }
  function source(view) {
    for (const [field, value] of view.fields) { value.body.replaceChildren(document.createTextNode(value.original)); value.body.classList.add('opinion-source-copy'); }
  }
  async function paint(view) {
    const generation = ++view.paintGeneration;
    setStatus(view);
    for (const [field, value] of view.fields) {
      value.body.classList.remove('opinion-source-copy');
      const tokens = view.result.fields?.[field];
      if (!Array.isArray(tokens)) { value.body.textContent = value.original; continue; }
      const content = document.createDocumentFragment();
      for (const token of tokens) {
        if (token.type !== 'math' || !Number.isSafeInteger(token.page) || token.page < 1 || !view.result.pdf) { content.append(document.createTextNode(token.text ?? token.tex ?? '')); continue; }
        const wrapper = node('span', `opinion-math${token.display ? ' opinion-math-display' : ''}`);
        wrapper.dataset.mathPage = String(token.page); wrapper.dataset.mathTex = token.tex || ''; wrapper.title = token.tex || '';
        wrapper.dataset.mathFontSize = String(Number.isFinite(token.fontSizePt) && token.fontSizePt >= 8 && token.fontSizePt <= 24 ? token.fontSizePt : 10);
        if (Number.isFinite(token.depthPt) && token.depthPt >= 0 && token.depthPt <= 2048) wrapper.dataset.mathDepth = String(token.depthPt);
        // This remains available to screen readers when the canvas is shown.
        wrapper.append(node('span', 'opinion-math-accessible', token.tex || '数学公式'));
        content.append(wrapper);
      }
      value.body.replaceChildren(content);
    }
    if (!view.result.pdf) return;
    try {
      if (!view.pdfTask) {
        const base64 = view.result.pdf.base64;
        if (typeof base64 !== 'string' || base64.length > 6 * 1024 * 1024) throw Error('意见公式 PDF 超出显示限制。');
        const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
        view.pdfTask = openPdfDocument(bytes);
      }
      const loading = view.pdfTask, pdf = view.pdf || await loading.promise;
      if (!alive(view) || !view.visible || view.mode !== 'reading' || generation !== view.paintGeneration || view.pdfTask !== loading) return;
      view.pdf = pdf;
      if (view.pdf.numPages > 64 || view.pdf.numPages !== view.result.pdf.pageCount) throw Error('意见公式页数无法核验。');
      for (const wrapper of view.card.querySelectorAll('.opinion-math')) {
        if (!alive(view) || !view.visible || view.mode !== 'reading' || generation !== view.paintGeneration) return;
        const fontPx = Math.max(10, Math.min(32, Number.parseFloat(getComputedStyle(wrapper.parentElement).fontSize) || 16));
        const scale = fontPx / (Number(wrapper.dataset.mathFontSize) * 72 / 72.27);
        const sheet = await view.pdf.getPage(Number(wrapper.dataset.mathPage));
        if (!alive(view) || !view.visible || view.mode !== 'reading' || generation !== view.paintGeneration) return;
        const viewport = sheet.getViewport({ scale });
        if (viewport.width > 7000 || viewport.height > 3000 || viewport.width * viewport.height > 4000000) throw Error('单个公式尺寸超出显示限制。');
        const ratio = Math.min(devicePixelRatio || 1, 2), canvas = node('canvas', 'opinion-math-canvas');
        canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`; canvas.setAttribute('aria-hidden', 'true');
        if (wrapper.dataset.mathDepth && !wrapper.classList.contains('opinion-math-display')) wrapper.style.verticalAlign = `${-Number(wrapper.dataset.mathDepth) * scale}px`;
        const rendering = sheet.render({ canvasContext: canvas.getContext('2d', { alpha: true }), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0], background: 'rgba(0,0,0,0)' });
        view.renders.add(rendering);
        try { await rendering.promise; } finally { view.renders.delete(rendering); }
        if (!alive(view) || !view.visible || view.mode !== 'reading' || generation !== view.paintGeneration) return;
        wrapper.append(canvas); wrapper.classList.add('opinion-math-ready');
      }
    } catch (error) {
      if (!alive(view) || !view.visible || view.mode !== 'reading' || generation !== view.paintGeneration) return;
      for (const wrapper of view.card.querySelectorAll('.opinion-math')) { wrapper.replaceChildren(document.createTextNode(wrapper.dataset.mathTex || '')); wrapper.classList.remove('opinion-math-ready'); wrapper.classList.add('opinion-math-fallback'); }
      view.status.textContent = copy('公式显示未完成，完整源码已保留。', 'Math display incomplete; complete source is retained.', '公式顯示未完成，完整原始碼已保留。'); view.status.dataset.status = 'failed'; view.status.title = error.message || '';
    }
  }
  function attach(card, note, { key, projectId, sourceSnapshotId, language: targetLanguage } = {}) {
    const fields = new Map([...card.querySelectorAll('[data-review-field]')].map(body => [body.dataset.reviewField, { body, original: body.textContent }]));
    if (!fields.size) return;
    const expected = { projectId, sourceSnapshotId, language: targetLanguage, noteId: note.noteId, noteRevision: note.revision || 1 };
    const view = { card, note, expected, key: JSON.stringify([expected, key || '']), fields, mode: modes.get(note.noteId) || 'reading', visible: !observer, queued: false, pending: false, started: false, result: null, paintGeneration: 0, renders: new Set(), pdfTask: null, pdf: null };
    const toolbar = node('div', 'opinion-read-toolbar'), controls = node('div', 'opinion-view-control');
    controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', copy('意见显示方式', 'Opinion display mode', '意見顯示方式'));
    const buttons = new Map();
    for (const [mode, label] of [['reading', copy('阅读', 'Read', '閱讀')], ['source', copy('源码', 'Source', '原始碼')]]) {
      const button = node('button', 'opinion-view-button', label); button.type = 'button'; button.dataset.opinionView = mode; button.dataset.opinionMode = mode; button.setAttribute('aria-pressed', String(view.mode === mode));
      button.addEventListener('click', () => {
        if (!alive(view) || view.mode === mode) return;
        view.mode = mode; card.dataset.opinionView = mode; modes.set(note.noteId, mode); while (modes.size > 128) modes.delete(modes.keys().next().value);
        for (const [value, option] of buttons) option.setAttribute('aria-pressed', String(mode === value));
        if (mode === 'source') { view.paintGeneration++; for (const task of view.renders) { try { task.cancel(); } catch {} } source(view); if (view.result) setStatus(view); else view.status.textContent = copy('源码视图 · 内容未改', 'Source view · unchanged', '原始碼檢視 · 內容未改'); }
        else if (view.result) void paint(view); else schedule(view);
      });
      controls.append(button); buttons.set(mode, button);
    }
    view.status = node('span', 'opinion-read-status', view.mode === 'reading' ? copy('阅读视图 · 按需排版公式', 'Reading view · math typeset on demand', '閱讀檢視 · 按需排版公式') : copy('源码视图 · 内容未改', 'Source view · unchanged', '原始碼檢視 · 內容未改')); view.status.setAttribute('role', 'status');
    toolbar.append(controls, view.status); card.prepend(toolbar); view.toolbar = toolbar;
    mounted.add(view); observed.set(card, view); card.dataset.opinionView = view.mode;
    if (view.mode === 'source') source(view);
    if (observer) observer.observe(card); else queueMicrotask(() => schedule(view));
    return view;
  }
  function clear() {
    observer?.disconnect(); observed.clear(); queue.length = 0;
    for (const view of mounted) { source(view); view.toolbar.remove(); delete view.card.dataset.opinionStatus; void disposePdf(view); }
    mounted.clear();
  }
  return { attach, clear, destroy() { clear(); cache.clear(); cachedBytes = 0; modes.clear(); } };
}
