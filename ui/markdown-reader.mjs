import MarkdownIt from 'markdown-it';
import katex from 'katex';

const MAX_TEXT = 256 * 1024, MAX_MATH = 8192, MAX_FORMULAS = 128;
const fields = ['labels', 'citations'];
const placeholder = /⟦P\d+(?:_[^⟧\r\n]{1,160})?⟧|\[\[P\d+(?:_[^\]\r\n]{1,160})?\]\]/gi;
const keyOf = value => /^(?:⟦(P\d+(?:_[a-f0-9]{1,64})?)⟧|\[\[(P\d+(?:_[a-f0-9]{1,64})?)\]\])$/i.exec(value)?.slice(1).find(Boolean)?.toLowerCase();
const forbidden = /\\(?:html[A-Za-z]*|href|url|includegraphics|class|style|cssId|def|gdef|edef|xdef|let|futurelet|newcommand|renewcommand|providecommand|global|require|input|include|write|read|openin|openout|catcode|csname|endcsname|expandafter|noexpand|string|char|unicode|verb)\b/;
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]|\^\^/;
const environments = new Set(['equation', 'equation*', 'align', 'align*', 'aligned', 'alignedat', 'alignat', 'alignat*', 'gather', 'gather*', 'gathered', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix', 'cases', 'array', 'split']);
const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false, maxNesting: 32 }).disable(['link', 'image', 'autolink', 'linkify']);
const escaped = md.utils.escapeHtml;
let highlightSequence = 0;
function highlighted(html, env, explicit) {
  const range = explicit === undefined ? env.mathContext.activeHighlight : explicit;
  return range ? '<span class="revision-sentence" data-changed="' + String(range.changed) + '" data-revision-role="' + range.role + '" data-revision-index="' + range.index + '">' + html + '</span>' : html;
}
function addDiagnostic(env, code, message) {
  const diagnostics = env.mathContext.diagnostics;
  if (diagnostics.length < 64 && !diagnostics.some(item => item.code === code && item.message === message)) diagnostics.push({ code, message });
}
function marker(source, at) {
  if (source.startsWith('$$', at)) return { open: '$$', close: '$$', display: true };
  if (source[at] === '$') return { open: '$', close: '$', display: false };
  if (source.startsWith('\\(', at)) return { open: '\\(', close: '\\)', display: false };
  if (source.startsWith('\\[', at)) return { open: '\\[', close: '\\]', display: true };
  const match = /^\\begin\{([^{}]+)\}/.exec(source.slice(at));
  if (match && environments.has(match[1])) return { open: match[0], close: `\\end{${match[1]}}`, display: true, environment: true };
  return null;
}
function endOf(source, markerInfo, at) {
  let position = at + markerInfo.open.length;
  for (;;) {
    position = source.indexOf(markerInfo.close, position);
    if (position < 0) return -1;
    let slashes = 0; for (let back = position - 1; back >= 0 && source[back] === '\\'; back--) slashes++;
    if (slashes % 2 === 0 || markerInfo.close.startsWith('\\')) return position;
    position += markerInfo.close.length;
  }
}
function mathInline(state, silent) {
  const info = marker(state.src, state.pos); if (!info) return false;
  if (info.open === '$' && /\s/.test(state.src[state.pos + 1] || ' ')) return false;
  const end = endOf(state.src, info, state.pos);
  if (end >= 0 && info.open === '$' && /\s/.test(state.src[end - 1] || ' ')) return false;
  if (silent) return end >= 0;
  if (end < 0) {
    const token = state.push('math_source', '', 0); token.content = state.src.slice(state.pos); state.pos = state.posMax;
    addDiagnostic(state.env, 'MALFORMED_MATH', 'An unclosed mathematical delimiter remains readable as source.'); return true;
  }
  const token = state.push('math_reading', '', 0);
  token.content = info.environment ? state.src.slice(state.pos, end + info.close.length) : state.src.slice(state.pos + info.open.length, end);
  token.meta = { display: info.display, original: state.src.slice(state.pos, end + info.close.length) };
  state.pos = end + info.close.length; return true;
}
function mathBlock(state, startLine, endLine, silent) {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const start = state.bMarks[startLine] + state.tShift[startLine], info = marker(state.src, start);
  if (!info || !info.display) return false;
  const end = endOf(state.src, info, start); if (end < 0 || end - start > MAX_MATH + 256) return false;
  let line = startLine;
  while (line < endLine && state.eMarks[line] < end + info.close.length) line++;
  if (line >= endLine || line - startLine > 64 || state.src.slice(end + info.close.length, state.eMarks[line]).trim()) return false;
  if (silent) return true;
  const token = state.push('math_reading', '', 0); token.block = true; token.map = [startLine, line + 1];
  token.content = info.environment ? state.src.slice(start, end + info.close.length) : state.src.slice(start + info.open.length, end);
  token.meta = { display: true, original: state.src.slice(start, end + info.close.length) }; state.line = line + 1; return true;
}
const labelPattern = /\\label\{([A-Za-z0-9_.:/+\-]{1,128})\}/g;
function labelInline(state, silent) {
  const match = /^\\label\{([A-Za-z0-9_.:/+\-]{1,128})\}/.exec(state.src.slice(state.pos));
  if (!match) return false;
  // A label defines an anchor, rather than printable prose. Hide it in this
  // read-only projection; source/translation editing retains the exact bytes.
  state.pos += match[0].length; return true;
}
function wrapperGroup(source, start) {
  if (source[start] !== '{') return null; let depth = 1;
  for (let at = start + 1; at < source.length && at - start <= MAX_MATH + 256; at++) {
    if (source[at] === '\\') { at++; continue; }
    if (source[at] === '{') depth++;
    else if (source[at] === '}' && --depth === 0) return { body: source.slice(start + 1, at), end: at + 1 };
  }
  return null;
}
function mathWrapperInline(state, silent) {
  const match = /^\\mbox\s*\{/.exec(state.src.slice(state.pos)); if (!match) return false;
  const group = wrapperGroup(state.src, state.pos + match[0].length - 1); if (!group) return false;
  const body = group.body.trim(), info = marker(body, 0), end = info && endOf(body, info, 0);
  const singleMath = info && !info.display && end >= 0 && end + info.close.length === body.length;
  if (!silent) {
    const token = state.push(singleMath ? 'math_reading' : 'math_source', '', 0);
    token.content = singleMath ? body.slice(info.open.length, end) : state.src.slice(state.pos, group.end);
    if (singleMath) token.meta = { display: false, original: state.src.slice(state.pos, group.end) };
    else addDiagnostic(state.env, 'UNSUPPORTED_MATH_WRAPPER', 'A mixed or complex TeX box remains readable as source.');
  }
  state.pos = group.end; return true;
}
const referencePattern = /\\(eqref|ref|autoref|cref|Cref|cite|citep|citet)\{([A-Za-z0-9_.:/+,\s-]{1,512})\}/g;
function referenceValue(command, rawKeys, references, env) {
  const category = command.startsWith('cite') ? 'citations' : 'labels', keys = rawKeys.split(',').map(value => value.trim());
  const missing = keys.some(key => !Object.hasOwn(references[category], key));
  if (missing) addDiagnostic(env, 'UNRESOLVED_REFERENCE', 'An unresolved reference is shown by its source label; numbers are never guessed.');
  const values = keys.map(key => Object.hasOwn(references[category], key) ? references[category][key] : key).join(', ');
  return { value: category === 'citations' ? `[${values}]` : command === 'eqref' ? `(${values})` : values, missing };
}
function referenceInline(state, silent) {
  const match = /^\\(eqref|ref|autoref|cref|Cref|cite|citep|citet)\{([A-Za-z0-9_.:/+,\s-]{1,512})\}/.exec(state.src.slice(state.pos));
  if (!match) return false;
  if (!silent) { const token = state.push('text', '', 0); token.content = referenceValue(match[1], match[2], state.env.mathContext.references, state.env).value; }
  state.pos += match[0].length; return true;
}
function highlightInline(state, silent) {
  const match = /^\\mdhl\{[a-z0-9]+:-?\d+\}/.exec(state.src.slice(state.pos));
  if (!match || !state.env.mathContext.markerValues?.has(match[0])) return false;
  if (!silent) { const token = state.push('highlight_boundary', '', 0); token.meta = state.env.mathContext.markerValues.get(match[0]); }
  state.pos += match[0].length; return true;
}
function contentPositions(content, source, map) {
  const starts = [0]; for (let at = 0; at < source.length; at++) if (source[at] === '\n') starts.push(at + 1);
  const begin = map ? starts[map[0]] : 0, finish = map ? starts[map[1]] ?? source.length : source.length;
  if (!Number.isSafeInteger(begin)) return null;
  const window = source.slice(begin, finish), exact = window.indexOf(content);
  if (exact >= 0 && exact === window.lastIndexOf(content)) return Array.from({ length: content.length + 1 }, (_, index) => begin + exact + index);
  // Markdown strips list/blockquote indentation before inline parsing. Map each
  // retained line to exact source characters, preserving skipped prefix gaps.
  const positions = [], lines = content.split('\n'); let cursor = begin, offset = 0;
  for (let number = 0; number < lines.length; number++) {
    const line = lines[number]; let found = false;
    while (cursor <= finish) {
      let lineEnd = source.indexOf('\n', cursor); if (lineEnd < 0 || lineEnd > finish) lineEnd = finish;
      const raw = source.slice(cursor, lineEnd), at = line.length ? raw.indexOf(line) : raw.length;
      if (at >= 0 && (!line.length || at === raw.lastIndexOf(line))) {
        for (let index = 0; index < line.length; index++) positions[offset++] = cursor + at + index;
        positions[offset] = cursor + at + line.length;
        if (number < lines.length - 1) positions[offset++] = lineEnd;
        cursor = lineEnd + 1; found = true; break;
      }
      if (lineEnd >= finish) break; cursor = lineEnd + 1;
    }
    if (!found) return null;
  }
  return positions.length === content.length + 1 ? positions : null;
}
function atomicIntervals(source) {
  const intervals = [];
  for (let at = 0; at < source.length;) {
    if (source.charCodeAt(at) === 96) {
      let count = 1; while (source.charCodeAt(at + count) === 96) count++;
      const ticks = source.slice(at, at + count), end = source.indexOf(ticks, at + count);
      if (end >= 0) { intervals.push([at, end + count]); at = end + count; continue; }
    }
    const info = marker(source, at);
    if (info) { const end = endOf(source, info, at); if (end >= 0) { intervals.push([at, end + info.close.length]); at = end + info.close.length; continue; } }
    at += source[at] === '\\' ? 2 : 1;
  }
  return intervals;
}
function injectHighlights(state) {
  const context = state.env.mathContext; if (!context.highlights?.length) return;
  const containing = position => context.highlights.find(range => range.start <= position && position < range.end) || null;
  for (const token of state.tokens) {
    if (token.type === 'math_reading' && token.block) {
      const positions = contentPositions(token.meta.original, state.src, token.map);
      if (positions) token.meta.highlight = containing(positions[0]);
      continue;
    }
    if (token.type !== 'inline' || !token.content) continue;
    const positions = contentPositions(token.content, state.src, token.map);
    if (!positions) { addDiagnostic(state.env, 'UNSUPPORTED_HIGHLIGHT', 'Sentence color positions could not be mapped; complete Markdown is retained.'); continue; }
    const transitions = []; let previous;
    for (let index = 0; index < token.content.length; index++) {
      const current = containing(positions[index]), identity = current?.index ?? -1;
      if (identity !== previous) { transitions.push({ at: index, range: current }); previous = identity; }
    }
    if (!transitions.some(item => item.range)) continue;
    const intervals = atomicIntervals(token.content);
    if (transitions.some(item => intervals.some(([start, end]) => item.at > start && item.at < end))) {
      addDiagnostic(state.env, 'UNSUPPORTED_HIGHLIGHT', 'A sentence color boundary crosses a mathematical or code object; the complete object remains intact.'); continue;
    }
    transitions.push({ at: token.content.length, range: null });
    for (const transition of transitions.reverse()) {
      const literal = '\\mdhl{' + context.markerNonce + ':' + (transition.range?.index ?? -1) + '}';
      context.markerValues.set(literal, transition.range); token.content = token.content.slice(0, transition.at) + literal + token.content.slice(transition.at);
    }
  }
}
md.core.ruler.before('inline', 'highlight_reading', injectHighlights);
md.inline.ruler.before('escape', 'math_reading', mathInline);
md.inline.ruler.before('escape', 'math_wrapper_reading', mathWrapperInline);
md.inline.ruler.before('escape', 'label_reading', labelInline);
md.inline.ruler.before('escape', 'reference_reading', referenceInline);
md.inline.ruler.before('escape', 'highlight_reading', highlightInline);
md.block.ruler.before('fence', 'math_reading', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
md.renderer.rules.math_source = (tokens, index) => `<span class="math-source">${escaped(tokens[index].content)}</span>`;
md.renderer.rules.math_reading = (tokens, index, options, env) => {
  const token = tokens[index], context = env.mathContext;
  let missingReference = false;
  let tex = token.content.replace(referencePattern, (whole, command, keys) => { const resolved = referenceValue(command, keys, context.references, env); missingReference ||= resolved.missing; return resolved.value; });
  const fallback = () => `<${token.block ? 'div' : 'span'} class="math-source" title="公式源码">${escaped(token.meta.original)}</${token.block ? 'div' : 'span'}>`;
  if (missingReference || tex.length > MAX_MATH || controls.test(tex) || forbidden.test(tex) || /(^|[^\\])(?:\\\\)*%/.test(tex) || context.mathCount >= MAX_FORMULAS) {
    addDiagnostic(env, 'UNSUPPORTED_MATH', 'Unsupported or oversized mathematical input remains readable as source.'); return fallback();
  }
  const labels = [...tex.matchAll(labelPattern)].map(match => match[1]);
  tex = tex.replace(labelPattern, '');
  // Only an exact verified aux label may supply a numbered equation tag. No
  // local equation counter or inferred reference number is introduced here.
  if (token.meta.display && /^\s*\\begin\{equation\}/.test(tex) && labels.length === 1 && Object.hasOwn(context.references.labels, labels[0]) && !/\\(?:tag|notag|nonumber)\b/.test(tex)) tex += '\\tag{' + context.references.labels[labels[0]] + '}';
  // KaTeX's numbered environments otherwise introduce a fresh browser counter,
  // unrelated to the paper's aux numbering. Project them as unnumbered forms;
  // an explicit source/verified tag above still renders in display mode.
  tex = tex.replace(/\\(begin|end)\{(equation|align|gather)\}/g, '\\$1{$2*}');
  try {
    // A fresh plain string macro table per expression prevents mutation sharing.
    const output = katex.renderToString(tex, { displayMode: token.meta.display, output: 'htmlAndMathml', throwOnError: true, trust: false, maxExpand: 1000, maxSize: 20, strict: code => code === 'unicodeTextInMathMode' ? 'ignore' : 'error', macros: { ...context.macros }, globalGroup: false });
    context.mathCount++; return output;
  } catch (error) {
    const detail = String(error?.message || '').split('\n')[0].slice(0, 180);
    addDiagnostic(env, 'UNSUPPORTED_MATH', `A mathematical expression remains source text.${detail ? ` ${detail}` : ''}`); return fallback();
  }
};
md.renderer.rules.highlight_boundary = (tokens, index, options, env) => { env.mathContext.activeHighlight = tokens[index].meta; return ''; };
md.renderer.rules.text = (tokens, index, options, env) => highlighted(escaped(tokens[index].content), env);
md.renderer.rules.code_inline = (tokens, index, options, env) => highlighted('<code>' + escaped(tokens[index].content) + '</code>', env);
md.renderer.rules.math_source = (tokens, index, options, env) => highlighted('<span class="math-source">' + escaped(tokens[index].content) + '</span>', env);
const renderUncoloredMath = md.renderer.rules.math_reading;
md.renderer.rules.math_reading = (tokens, index, options, env) => highlighted(renderUncoloredMath(tokens, index, options, env), env, tokens[index].meta.highlight);
function safeMacros(input, diagnostics) {
  const macros = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return macros;
  for (const [name, body] of Object.entries(input)) {
    if (/^\\[A-Za-z]{1,64}$/.test(name) && typeof body === 'string' && body.length <= 1024 && !forbidden.test(body) && !controls.test(body)) macros[name] = body;
    else if (diagnostics.length < 64) diagnostics.push({ code: 'UNSUPPORTED_MACRO', message: 'An unsupported display macro was omitted.' });
  }
  return macros;
}
function safeReferences(input) {
  const result = { labels: {}, citations: {} };
  for (const field of fields) for (const [key, value] of Object.entries(input?.[field] || {})) if (/^[A-Za-z0-9_.:/+\-]{1,128}$/.test(key) && typeof value === 'string' && /^(?:[A-Z]{1,3}[.-]?)?\d{1,6}(?:[.-]\d{1,6})*[a-z]?$/.test(value)) result[field][key] = value;
  return result;
}
function offsetAfter(position, replacements) {
  let delta = 0;
  for (const item of replacements) {
    if (position <= item.start) return position + delta;
    if (position < item.end) return null;
    delta += item.length - (item.end - item.start);
  }
  return position + delta;
}
function colorRanges(input, textLength, mapOffset, diagnostics) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 256) { diagnostics.push({ code: 'UNSUPPORTED_HIGHLIGHT', message: 'Sentence colors exceed their bounded display schema.' }); return []; }
  const ranges = []; let previous = 0;
  for (const [index, range] of input.entries()) {
    if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < previous || range.end <= range.start || range.end > textLength || !['current', 'recommended'].includes(range.role) || typeof range.changed !== 'boolean') {
      diagnostics.push({ code: 'UNSUPPORTED_HIGHLIGHT', message: 'Invalid sentence color positions were omitted.' }); continue;
    }
    previous = range.end; const start = mapOffset(range.start), end = mapOffset(range.end);
    if (start === null || end === null || end <= start) { diagnostics.push({ code: 'UNSUPPORTED_HIGHLIGHT', message: 'A color position crosses a protected object; complete text remains readable.' }); continue; }
    ranges.push({ start, end, changed: range.changed, role: range.role, index });
  }
  return ranges;
}
function prepare(text, options, diagnostics) {
  const stale = options.sourceSnapshotId && options.contextSnapshotId && options.sourceSnapshotId !== options.contextSnapshotId;
  if (stale) diagnostics.push({ code: 'STALE_MATH_CONTEXT', message: 'The opinion belongs to an older source; current protected objects, macros and references are not substituted.' });
  const indexed = new Map();
  if (!stale) for (const token of (Array.isArray(options.tokens) ? options.tokens : [])) {
    const key = typeof token.id === 'string' ? keyOf(token.id) : null;
    if (!key || typeof token.raw !== 'string' || token.raw.length > MAX_MATH) continue;
    if (!indexed.has(key)) indexed.set(key, new Set()); indexed.get(key).add(token.raw);
  }
  let expanded = text.length;
  const replacements = [];
  const source = text.replace(placeholder, (value, at) => {
    const values = indexed.get(keyOf(value));
    if (values?.size === 1) { const raw = values.values().next().value, next = expanded - value.length + raw.length; if (next <= MAX_TEXT) { expanded = next; replacements.push({ start: at, end: at + value.length, length: raw.length }); return raw; } }
    if (!diagnostics.some(item => item.code === 'UNRESOLVED_PROTECTED_TOKEN')) diagnostics.push({ code: 'UNRESOLVED_PROTECTED_TOKEN', message: 'A protected object has no unique current source binding. See the original paper.' });
    replacements.push({ start: at, end: at + value.length, length: '受保护对象（详见原文）'.length });
    return '受保护对象（详见原文）';
  });
  const newlines = [...source.matchAll(/\r\n?/g)].map(match => ({ start: match.index, end: match.index + match[0].length, length: 1 }));
  const mapOffset = value => { const first = offsetAfter(value, replacements); return first === null ? null : offsetAfter(first, newlines); };
  const references = stale ? { labels: {}, citations: {} } : safeReferences(options.references);
  return { source: source.replace(/\r\n?/g, '\n'), highlights: colorRanges(options.highlights, text.length, mapOffset, diagnostics), references, macros: stale ? {} : safeMacros(options.macros, diagnostics) };
}
/** Returns only HTML generated by html:false Markdown-it and restricted KaTeX. */
export function markdownToHtml(text, options = {}) {
  const diagnostics = [], prepared = prepare(String(text || ''), options, diagnostics);
  if (prepared.source.length > MAX_TEXT) return { html: `<pre class="markdown-source">${escaped(prepared.source)}</pre>`, diagnostics: [...diagnostics, { code: 'MARKDOWN_DISPLAY_LIMIT', message: 'This long field is shown as source without mathematical expansion.' }], mathCount: 0 };
  let markerNonce = '';
  do { markerNonce = 'h' + (++highlightSequence).toString(36) + Math.random().toString(36).slice(2, 10); } while (prepared.source.includes('\\mdhl{' + markerNonce + ':'));
  const env = { mathContext: { diagnostics, macros: prepared.macros, references: prepared.references, highlights: prepared.highlights, markerNonce, markerValues: new Map(), activeHighlight: null, mathCount: 0 } };
  const html = options.inline ? md.renderInline(prepared.source, env) : md.render(prepared.source, env);
  return { html, diagnostics, mathCount: env.mathContext.mathCount };
}
/** The inserted markup is generated, never passed-through user HTML. */
export function renderMarkdown(target, text, options = {}) {
  if (!target || typeof target !== 'object') throw new TypeError('A Markdown reading target is required.');
  const result = markdownToHtml(text, options);
  target.innerHTML = result.html; target.classList?.add('markdown-reading');
  return { diagnostics: result.diagnostics, mathCount: result.mathCount };
}
