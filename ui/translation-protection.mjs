const MAX_TEXT = 256 * 1024, MAX_CANDIDATES = 16384;
const number = String.raw`\d{1,6}(?:\s*(?:--|[-–—])\s*\d{1,6})?`;
const citationSource = String.raw`\[\s*${number}(?:\s*[,;，、]\s*${number})*\s*\]`;
const citation = new RegExp(`^${citationSource}$`, 'u');
const mathEnvironments = new Set(['equation', 'equation*', 'align', 'align*', 'aligned', 'alignedat', 'alignat', 'alignat*', 'gather', 'gather*', 'gathered', 'multline', 'multline*', 'displaymath', 'math', 'eqnarray', 'eqnarray*', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix', 'cases', 'array', 'split']);
const escaped = (text, at) => { let count = 0; while (at > 0 && text[--at] === '\\') count++; return count % 2 === 1; };
const limit = () => { throw Object.assign(new Error('Translation has too many protected objects to edit safely; its complete reading text is retained.'), { code: 'TRANSLATION_PROTECTION_LIMIT' }); };
export const isLiteralCitation = raw => typeof raw === 'string' && citation.test(raw);
function mathMarker(text, at) {
  if (escaped(text, at)) return null;
  if (text.startsWith('$$', at)) return { open: '$$', close: '$$' };
  if (text[at] === '$') return { open: '$', close: '$' };
  if (text.startsWith('\\(', at)) return { open: '\\(', close: '\\)' };
  if (text.startsWith('\\[', at)) return { open: '\\[', close: '\\]' };
  const environment = /^\\begin\{([^{}]+)\}/u.exec(text.slice(at));
  return environment && mathEnvironments.has(environment[1]) ? { open: environment[0], close: `\\end{${environment[1]}}`, environment: true } : null;
}
function mathEnd(text, start, marker) {
  let depth = 1, at = start + marker.open.length;
  for (;;) {
    const end = text.indexOf(marker.close, at); if (end < 0) return -1;
    if (escaped(text, end)) { at = end + marker.close.length; continue; }
    if (marker.environment) {
      const nested = text.indexOf(marker.open, at);
      if (nested >= 0 && nested < end && !escaped(text, nested)) { depth++; at = nested + marker.open.length; continue; }
      if (--depth) { at = end + marker.close.length; continue; }
    }
    return end + marker.close.length;
  }
}
const kindFor = raw => {
  const marker = mathMarker(raw, 0);
  if (marker && mathEnd(raw, 0, marker) === raw.length) return 'math';
  return /^\\(?:cite|ref|eqref|cref|Cref|autoref)\b/u.test(raw) || isLiteralCitation(raw) ? 'citation' : 'structure';
};

/** Local editor atoms from exact draft bytes, with no citation-key/number mapping. */
export function deriveTranslationProtectedTokens(value, sourceTokens = []) {
  const text = String(value ?? ''); if (text.length > MAX_TEXT) limit();
  const candidates = [], math = [];
  const add = candidate => { if (candidates.length >= MAX_CANDIDATES) limit(); candidates.push(candidate); };
  for (let at = 0; at < text.length;) {
    const marker = mathMarker(text, at);
    if (!marker) { at++; continue; }
    const end = mathEnd(text, at, marker);
    if (end < 0) { at += marker.open.length; continue; }
    const raw = text.slice(at, end), token = { start: at, end, raw, id: `translation-math-${at}`, kind: 'math', priority: 1 };
    math.push(token); add(token); at = end;
  }
  const seen = new Set();
  for (const source of Array.isArray(sourceTokens) ? sourceTokens : []) {
    if (!source || typeof source.raw !== 'string' || !source.raw || seen.has(source.raw)) continue;
    seen.add(source.raw); let offset = 0;
    for (;;) {
      const at = text.indexOf(source.raw, offset); if (at < 0) break;
      add({ start: at, end: at + source.raw.length, raw: source.raw, id: source.id || `translation-source-${at}`, kind: kindFor(source.raw), priority: 2 }); offset = at + source.raw.length;
    }
  }
  for (const match of text.matchAll(new RegExp(citationSource, 'gu'))) {
    if (escaped(text, match.index) || math.some(range => match.index < range.end && match.index + match[0].length > range.start)) continue;
    add({ start: match.index, end: match.index + match[0].length, raw: match[0], id: `translation-citation-${match.index}`, kind: 'citation', priority: 0 });
  }
  candidates.sort((a, b) => a.start - b.start || b.end - a.end || b.priority - a.priority);
  const result = []; let end = 0;
  for (const item of candidates) {
    if (item.start < end) continue;
    const { priority, ...token } = item; result.push(token); end = item.end;
  }
  return result;
}
