const MAX_BYTES = 128 * 1024, MAX_SENTENCES = 256;
const colors = { current: '#8D470B', recommended: '#135B7A' };
const mathEnvironments = new Set(['equation', 'equation*', 'align', 'align*', 'aligned', 'alignedat', 'alignat', 'alignat*', 'gather', 'gather*', 'gathered', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix', 'cases', 'array', 'split', 'displaymath', 'math', 'multline', 'multline*', 'eqnarray', 'eqnarray*']);
const string = value => typeof value === 'string' ? value : '';
const diagnostic = (code, message) => ({ code, message });
const escaped = (text, at) => { let count = 0; while (at > 0 && text[--at] === '\\') count++; return count % 2 === 1; };
function atomicEnd(text, at) {
  let opening, closing, environment = false;
  if (text[at] === '\\') { const reference = /^\\(?:cite[pt]?|ref|eqref|autoref|[Cc]ref|label)\*?(?:\[[^\]\r\n]{0,512}\]){0,2}\{[^{}\r\n]{1,1024}\}/u.exec(text.slice(at)); if (reference) return at + reference[0].length; }
  if (text.startsWith('[[P', at)) { const end = text.indexOf(']]', at + 3); return end < 0 ? at : end + 2; }
  if (text.startsWith('⟦P', at)) { const end = text.indexOf('⟧', at + 2); return end < 0 ? at : end + 1; }
  if (text[at] === '$' && !escaped(text, at)) { opening = text[at + 1] === '$' ? '$$' : '$'; closing = opening; }
  else if (text.startsWith('\\(', at) || text.startsWith('\\[', at)) { opening = text.slice(at, at + 2); closing = opening === '\\(' ? '\\)' : '\\]'; }
  else if (text.startsWith('\\begin{', at)) { const match = /^\\begin\{([^{}]+)\}/.exec(text.slice(at)); if (match && mathEnvironments.has(match[1])) { opening = match[0]; closing = `\\end{${match[1]}}`; environment = true; } }
  else if (text[at] === '`') { const match = /^`{1,3}/.exec(text.slice(at)); opening = match[0]; closing = opening; }
  if (!opening) return at;
  let end = at + opening.length;
  if (environment) {
    let depth = 1;
    while (depth) { const nextClose = text.indexOf(closing, end), nextOpen = text.indexOf(opening, end); if (nextClose < 0) return text.length; if (nextOpen >= 0 && nextOpen < nextClose) { depth++; end = nextOpen + opening.length; } else { depth--; end = nextClose + closing.length; } }
    return end;
  }
  for (;;) { end = text.indexOf(closing, end); if (end < 0) return text.length; if (closing[0] === '\\' || !escaped(text, end)) return end + closing.length; end += closing.length; }
}
function sentenceKey(text) {
  let key = '', cursor = 0;
  for (let at = 0; at < text.length;) { const end = atomicEnd(text, at); if (end > at) { key += text.slice(cursor, at).replace(/\s+/gu, ' ') + text.slice(at, end); cursor = end; at = end; } else at++; }
  return (key + text.slice(cursor).replace(/\s+/gu, ' ')).trim();
}
function boundary(text, at) {
  const character = text[at];
  if ('。！？؟।'.includes(character)) return true;
  if (!'.!?'.includes(character)) return false;
  if (character === '.' && /\d/.test(text[at - 1] || '') && /\d/.test(text[at + 1] || '')) return false;
  if ('.!?'.includes(text[at + 1] || '\0')) return false;
  if (character === '.') {
    const before = text.slice(Math.max(0, at - 40), at + 1);
    if (/(?:\b(?:e\.g|i\.e|et al|etc|vs|cf|figs?|eqs?|secs?|refs?|dr|prof|mr|mrs|ms|st|no|vol|pp|p|ch|chap|def|prop|a\.m|p\.m)\.|(?:\b[A-Z]\.){2,})$/iu.test(before)) return false;
    if (/\b[A-Z]\.$/u.test(before) && !/\b(?:case|part|type|option|label) [A-Z]\.$/iu.test(before) && /^\s+[A-Z][a-z]/u.test(text.slice(at + 1))) return false;
  }
  return at + 1 === text.length || /[\s"'”’）)\]}>」』】]/u.test(text[at + 1]);
}
/** Exact offsets; punctuation inside math, placeholders and code is atomic. */
export function sentenceRanges(value) {
  const text = string(value), ranges = []; let start = 0;
  for (let at = 0; at < text.length;) {
    const end = atomicEnd(text, at); if (end > at) { at = end; continue; }
    if (!boundary(text, at)) { at++; continue; }
    let stop = at + 1;
    while (/["'”’）)\]}>」』】]/u.test(text[stop] || '\0')) stop++;
    while (/\s/u.test(text[stop] || '\0')) stop++;
    ranges.push({ start, end: stop }); start = stop; at = stop;
  }
  if (start < text.length) ranges.push({ start, end: text.length });
  return ranges;
}
function side(text, ranges, changed, role) {
  return { text, ranges: ranges.map((range, index) => ({ ...range, changed: changed[index], role, color: changed[index] ? colors[role] : null })) };
}
/** Independent sentence alignment. Whitespace outside math may reflect PDF wrapping. */
export function diffSentenceRanges(currentText, recommendedText) {
  const current = string(currentText), recommended = string(recommendedText), diagnostics = [];
  const encoder = new TextEncoder();
  if (encoder.encode(current).length > MAX_BYTES || encoder.encode(recommended).length > MAX_BYTES) {
    diagnostics.push(diagnostic('DIFF_LIMIT', 'This comparison exceeds its bounded sentence budget; complete text is retained with conservative highlighting.'));
    const one = text => text ? [{ start: 0, end: text.length }] : [];
    return { current: side(current, one(current), [current !== recommended], 'current'), recommended: side(recommended, one(recommended), [current !== recommended], 'recommended'), diagnostics };
  }
  const oldRanges = sentenceRanges(current), newRanges = sentenceRanges(recommended), oldChanged = oldRanges.map(() => true), newChanged = newRanges.map(() => true);
  if (oldRanges.length > MAX_SENTENCES || newRanges.length > MAX_SENTENCES) diagnostics.push(diagnostic('DIFF_LIMIT', 'This paragraph has too many sentences for alignment; complete sentences are retained with conservative highlighting.'));
  else {
    const oldKeys = oldRanges.map(range => sentenceKey(current.slice(range.start, range.end))), newKeys = newRanges.map(range => sentenceKey(recommended.slice(range.start, range.end))), width = newKeys.length + 1, table = new Uint16Array((oldKeys.length + 1) * width);
    for (let a = oldKeys.length - 1; a >= 0; a--) for (let b = newKeys.length - 1; b >= 0; b--) table[a * width + b] = oldKeys[a] === newKeys[b] ? table[(a + 1) * width + b + 1] + 1 : Math.max(table[(a + 1) * width + b], table[a * width + b + 1]);
    let a = 0, b = 0;
    while (a < oldKeys.length && b < newKeys.length) { if (oldKeys[a] === newKeys[b]) { oldChanged[a++] = false; newChanged[b++] = false; } else if (table[(a + 1) * width + b] >= table[a * width + b + 1]) a++; else b++; }
  }
  return { current: side(current, oldRanges, oldChanged, 'current'), recommended: side(recommended, newRanges, newChanged, 'recommended'), diagnostics };
}
function replaceUnique(paragraph, literal, replacement) {
  if (!paragraph || !literal || !replacement) return null;
  const at = paragraph.indexOf(literal);
  if (at < 0 || paragraph.indexOf(literal, at + 1) >= 0) return null;
  return paragraph.slice(0, at) + replacement + paragraph.slice(at + literal.length);
}
/** Display only: no baseline is guessed, and no source/proposal mutation is made. */
export function createParagraphComparison({ note = {}, currentSource, currentTranslation } = {}) {
  const diagnostics = [], sourceBaseline = string(currentSource), translationBaseline = string(currentTranslation);
  let scope = ['paragraph', 'sentence', 'note'].includes(note.scope) ? note.scope : 'sentence';
  let sourceCurrent = string(note.currentSource), translationCurrent = string(note.currentTranslation), sourceRecommended = string(note.suggestedSource), translationRecommended = string(note.suggestedTranslation || note.recommendation);
  const explicitContext = sourceCurrent && translationCurrent && note.scope !== 'sentence';
  if (explicitContext && !note.scope) scope = 'paragraph';
  if (scope === 'paragraph' && !explicitContext) { scope = 'note'; diagnostics.push(diagnostic('PARAGRAPH_CONTEXT_UNAVAILABLE', 'The complete current bilingual paragraph was not supplied; missing context was not reconstructed.')); }
  if (!explicitContext && scope !== 'paragraph' && (note.sourceSegmentIds || []).length === 1 && sourceBaseline) {
    const oldSource = string(note.quote || note.currentSource), liftedSource = replaceUnique(sourceBaseline, oldSource, sourceRecommended);
    if (liftedSource !== null) {
      const wholeSource = oldSource === sourceBaseline;
      const liftedTranslation = wholeSource && translationBaseline ? translationRecommended : replaceUnique(translationBaseline, string(note.currentTranslation), translationRecommended);
      sourceCurrent = sourceBaseline; sourceRecommended = liftedSource;
      if (liftedTranslation !== null && translationBaseline) { translationCurrent = translationBaseline; translationRecommended = liftedTranslation; scope = 'paragraph'; }
      else { translationCurrent = string(note.currentTranslation); scope = 'sentence'; diagnostics.push(diagnostic('TRANSLATION_CONTEXT_UNAVAILABLE', 'Only the uniquely matched source-language sentence could be placed in its paragraph; target-language context was not guessed.')); }
    } else diagnostics.push(diagnostic('SOURCE_CONTEXT_AMBIGUOUS', 'The original sentence has no unique literal paragraph match; the suggestion remains a separate note.'));
  }
  if (!explicitContext && !sourceCurrent) sourceCurrent = string(note.quote);
  if (!explicitContext && !note.scope && !(note.sourceSegmentIds || []).length) scope = 'note';
  if (!sourceCurrent && !translationCurrent) scope = 'note';
  const source = diffSentenceRanges(sourceCurrent, sourceRecommended), translation = diffSentenceRanges(translationCurrent, translationRecommended);
  return { scope, source: { current: source.current, recommended: source.recommended }, translation: { current: translation.current, recommended: translation.recommended }, diagnostics: [...diagnostics, ...source.diagnostics, ...translation.diagnostics] };
}
