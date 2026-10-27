import { renderMarkdown } from './markdown-reader.mjs';

/** Pure display. Drafts, review records and source text never flow out of this reader. */
export function createParagraphOpinionReader({ language = () => 'zh-CN' } = {}) {
  const modes = new Map(), mounted = new Set();
  const text = (zh, en) => language().startsWith('zh') ? zh : en;
  const node = (tag, className, content) => { const value = document.createElement(tag); if (className) value.className = className; if (content !== undefined) value.textContent = content; return value; };
  function attach(card, note, { mathContext = {}, comparison = null, projectId = '' } = {}) {
    const key = `${projectId}:${note.noteId}`, fields = [...card.querySelectorAll('[data-review-field]')].map(body => ({ body, field: body.dataset.reviewField, original: body.textContent }));
    if (!fields.length) return;
    const compared = { currentSource: comparison?.source?.current, suggestedSource: comparison?.source?.recommended, currentTranslation: comparison?.translation?.current, suggestedTranslation: comparison?.translation?.recommended };
    const toolbar = node('div', 'opinion-read-toolbar'), controls = node('div', 'opinion-view-control'), status = node('span', 'opinion-read-status');
    controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', text('意见显示方式', 'Opinion view'));
    const buttons = new Map(); let mode = modes.get(key) || 'reading';
    function paint() {
      card.dataset.opinionView = mode;
      let mathCount = 0, failed = 0;
      for (const entry of fields) {
        const { body, field, original } = entry; body.classList.toggle('opinion-source-copy', mode === 'source'); body.replaceChildren();
        if (mode === 'source') { body.textContent = original; continue; }
        const model = compared[field], role = field.startsWith('current') ? 'current' : 'recommended';
        const highlights = model && model.text === original && Array.isArray(model.ranges) ? model.ranges.map(range => ({ start: range.start, end: range.end, changed: range.changed === true, role })) : undefined;
        const result = renderMarkdown(body, original, { ...mathContext, highlights });
        mathCount += result?.mathCount || 0; failed += result?.diagnostics?.length || 0;
      }
      status.textContent = mode === 'source' ? text('源码视图 · 内容未改', 'Source · unchanged') : failed ? text('Markdown 阅读 · 部分对象保留源码', 'Markdown reading · some objects retain source') : mathCount ? text('Markdown 阅读 · 公式已排版', 'Markdown reading · math typeset') : text('Markdown 阅读', 'Markdown reading');
      status.dataset.status = failed ? 'partial' : 'ready'; card.dataset.opinionStatus = failed ? 'partial' : 'ready'; card.dataset.mathCount = String(mathCount);
      for (const [value, button] of buttons) button.setAttribute('aria-pressed', String(value === mode));
    }
    for (const [value, label] of [['reading', text('阅读', 'Reading')], ['source', text('源码', 'Source')]]) {
      const button = node('button', 'opinion-view-button', label); button.type = 'button'; button.dataset.opinionView = value; button.dataset.opinionMode = value;
      button.addEventListener('click', () => { if (mode === value) return; mode = value; modes.delete(key); modes.set(key, mode); while (modes.size > 128) modes.delete(modes.keys().next().value); paint(); }); controls.append(button); buttons.set(value, button);
    }
    status.setAttribute('role', 'status'); toolbar.append(controls, status); card.prepend(toolbar);
    const view = { card, toolbar }; mounted.add(view); paint(); return view;
  }
  function clear() { for (const view of mounted) view.toolbar.remove(); mounted.clear(); }
  return { attach, clear, destroy() { clear(); modes.clear(); } };
}
