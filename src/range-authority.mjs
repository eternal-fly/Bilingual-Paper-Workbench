import { deriveEnglishView } from './english-view.mjs';
import { restoreProtected, sha256 } from './latex.mjs';
import {standaloneFormulaSource} from './formula-edits.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const syntax = /[\\$%{}&#^_~\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;
const lexicalControls = new Set(['catcode', 'mathcode', 'lccode', 'uccode', 'scantokens', 'endlinechar', 'escapechar', 'obeylines', 'obeyspaces', 'newunicodechar', 'DeclareUnicodeCharacter', 'csname', 'endcsname', 'directlua', 'latelua', 'luadirect', 'luafunction', 'luaexec', 'read', 'readline']);
const definitions = new Set(['newcommand', 'renewcommand', 'providecommand', 'newenvironment', 'renewenvironment']);
const criticalSyntaxControls = new Set(['begin', 'end', 'input', 'include', 'verb', 'makeatletter', 'makeatother', 'def', 'edef', 'gdef', 'xdef', 'let', 'futurelet', ...definitions, ...lexicalControls]);
const formatting = new Map(['emph', 'textbf', 'textit', 'textnormal', 'textrm', 'textsf', 'texttt', 'textsl', 'textsc', 'underline', 'mbox', 'footnote'].map(name => [name, 1]));
formatting.set('textcolor', 2); formatting.set('colorbox', 2); formatting.set('fcolorbox', 3);
const fixedControls = new Set(['cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'nocite', 'ref', 'eqref', 'pageref', 'autoref', 'cref', 'Cref', 'label', 'url', 'path', 'href', 'includegraphics', 'footnotemark', 'texorpdfstring', 'ensuremath', 'textsuperscript', 'textsubscript', 'hspace', 'vspace', 'color', 'par', 'noindent', 'normalfont', 'rmfamily', 'sffamily', 'ttfamily', 'mdseries', 'bfseries', 'upshape', 'itshape', 'slshape', 'scshape', 'tiny', 'scriptsize', 'footnotesize', 'small', 'normalsize', 'large', 'Large', 'LARGE', 'huge', 'Huge', 'enspace', 'quad', 'qquad', 'ignorespaces', 'linebreak', 'newline', 'pagebreak', 'nolinebreak', 'nopagebreak', 'LaTeX', 'TeX', 'textbackslash', 'textasciitilde', 'textasciicircum', 'textendash', 'textemdash', 'ldots', 'dots', 'ae', 'AE', 'oe', 'OE', 'aa', 'AA', 'o', 'O', 'ss', 'c', 'v', 'H', 'u', 'r', 't', 'b', 'd', 'k']);
function group(source, start) {
  const open = source[start], close = open === '{' ? '}' : ']';
  if (!['{', '['].includes(open)) return null;
  let depth = 1, braces = 0;
  for (let at = start + 1; at < source.length; at++) {
    if (source[at] === '\\') { at++; continue; }
    if (source[at] === '%') { const next = source.indexOf('\n', at); if (next < 0) return null; at = next; continue; }
    if (open === '[' && source[at] === '{') { braces++; continue; }
    if (open === '[' && source[at] === '}') { if (--braces < 0) return null; continue; }
    if (braces) continue;
    if (source[at] === open) depth++;
    else if (source[at] === close && --depth === 0) return { start, end: at + 1, inner: source.slice(start + 1, at) };
  }
  return null;
}
function command(source, start) {
  let at = start + 1;
  if (!/[A-Za-z@]/.test(source[at] || '')) return { name: source[at], start, end: Math.min(source.length, at + 1), groups: [] };
  while (/[A-Za-z@]/.test(source[at] || '')) at++;
  const name = source.slice(start + 1, at); if (source[at] === '*') at++;
  if (name === 'verb') { const delimiter = source[at], end = delimiter && source.indexOf(delimiter, at + 1); if (!delimiter || end < 0) fail('UNSUPPORTED_TEX', 'Unclosed verbatim control.'); return { name, start, end: end + 1, groups: [] }; }
  let target;
  if (definitions.has(name)) {
    const match = /^\s*(\\[A-Za-z@]+)/u.exec(source.slice(at));
    if (match) { target = match[1].slice(1); at += match[0].length; }
  }
  const groups = [];
  for (let count = 0; count < 12; count++) {
    let next = at; while (/[ \t\r\n]/.test(source[next] || '')) next++;
    if (!['{', '['].includes(source[next])) break;
    const item = group(source, next); if (!item) fail('UNSUPPORTED_TEX', 'Unbalanced protected command argument.');
    groups.push(item); at = item.end;
  }
  return { name, start, end: at, groups, unbracedTarget: Boolean(target), target: target || (definitions.has(name) ? groups[0]?.inner.replace(/^\\/, '') : null) };
}
// Literal, grouped URL compatibility shims emitted by standard bibliography
// generators. Their existing invocations are locked as complete objects.
const shimBodies = new Map([
  ['href', String.raw`\begingroup\@sanitize@url\@href`], ['@href', String.raw`\@@startlink{#1}\@@href`], ['@@href', String.raw`\endgroup#1\@@endlink`],
  ['url', String.raw`\begingroup\@sanitize@url\@url`], ['@url', [String.raw`\@@startlink{#1}\@@url`, String.raw`\endgroup\@href{#1}{\urlprefix}`]], ['@@url', String.raw`\endgroup#1\@@endlink`],
  ['@sanitize@url', String.raw`\catcode\x60\\12\catcode\x60\$12\catcode\x60\&12\catcode\x60\#12\catcode\x60\^12\catcode\x60\_12\catcode\x60\%12\relax`.replaceAll('\\x60', '`')],
  ['BibitemShut', String.raw`\csnamebibitem#1\endcsname`],
]);
// One literal stock LaTeX size-11 profile. It changes font/display spacing only;
// no expansion, dimensions, controls or caller-defined helper is inferred.
const staticFontProfile = String.raw`\@setfontsize\normalsize{10.95}{13.6}
\abovedisplayskip 11pt plus 3pt minus 6pt
\abovedisplayshortskip 0pt plus 3pt
\belowdisplayshortskip 6.5pt plus 3.5pt minus 3pt
\belowdisplayskip \abovedisplayskip
\let\@listi\@listI`;
const fontProfileHelpers = new Set(['@setfontsize', '@listi', '@listI', 'let', 'abovedisplayskip', 'abovedisplayshortskip', 'belowdisplayshortskip', 'belowdisplayskip']);
const dynamicNameControls = new Set(['@namedef', '@nameuse', '@namelet', 'csdef', 'csgdef', 'csedef', 'csxdef', 'cslet', 'csletcs', 'csundef', 'letcs', 'cspreto', 'csappto', 'csgpreto', 'csgappto', 'csepreto', 'cseappto', 'csxpreto', 'csxappto']);
function fontProfileSignature(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const tokens = []; let at = 0;
  while (at < value.length) {
    if (/[ \t\r\n]/u.test(value[at])) { at++; continue; }
    if (value[at] === '%') { const end = value.indexOf('\n', at); at = end < 0 ? value.length : end + 1; continue; }
    const rest = value.slice(at), found = /^(?:\\[A-Za-z@]+|\\[^\r\n]|[A-Za-z@]+|[0-9.]+)/u.exec(rest);
    const token = found?.[0] || value[at]; tokens.push(token); at += token.length;
  }
  return JSON.stringify(tokens);
}
const staticFontProfileSignature = fontProfileSignature(staticFontProfile);
const helperMention = value => [...fontProfileHelpers].some(name => value.includes(`\\${name}`) || value === name || value.includes(`cmd/${name}/`));
function lexicalSafety(source) {
  // TeX expands ^^ notation before tokenizing comments or control sequences.
  if (source.includes('^^')) return false;
  const safeDefinitions = [], occurrences = [];
  for (let at = 0; at < source.length;) {
    if (source[at] === '%') { const next = source.indexOf('\n', at); at = next < 0 ? source.length : next + 1; continue; }
    if (source[at] !== '\\') { at++; continue; }
    const token = command(source, at);
    if (dynamicNameControls.has(token.name)) return false;
    if (definitions.has(token.name)) {
      const body = token.groups.filter(item => source[item.start] === '{').at(-1)?.inner.replace(/\s/gu, '');
      const allowed = shimBodies.get(token.target);
      const parameters = token.groups.filter(item => source[item.start] === '[');
      const arity = ['@href', '@@href', '@url', '@@url', 'BibitemShut'].includes(token.target) ? '1' : '0';
      const argumentShape = token.groups.map(item => source[item.start]).join('');
      const knownShim = token.name === 'providecommand' && argumentShape === (token.unbracedTarget ? '[{' : '{[{') && parameters.length === 1 && parameters[0].inner === arity && (Array.isArray(allowed) ? allowed.includes(body) : allowed === body);
      const fontBody = token.groups.filter(item => source[item.start] === '{').at(-1)?.inner;
      const knownFontProfile = token.name === 'renewcommand' && token.target === 'normalsize' && argumentShape === (token.unbracedTarget ? '{' : '{{') && fontProfileSignature(fontBody) === staticFontProfileSignature;
      if ((fixedControls.has(token.target) || formatting.has(token.target) || criticalSyntaxControls.has(token.target)) && !knownShim && !knownFontProfile) return false;
      if (fontProfileHelpers.has(token.target)) return false;
      // This exact token stream contains no lexical operation. Skip it as one
      // validated presentation definition, without joining control words.
      if (knownFontProfile) { at = token.end; continue; }
      if (knownShim) safeDefinitions.push(token);
    }
    if (['def', 'edef', 'gdef', 'xdef', 'let', 'futurelet', 'chardef', 'mathchardef', 'countdef', 'dimendef', 'skipdef', 'muskipdef', 'toksdef', 'font'].includes(token.name)) {
      const target = /^\s*\\([A-Za-z@]+)/u.exec(source.slice(token.start + token.name.length + 1))?.[1];
      if (fixedControls.has(target) || formatting.has(target) || criticalSyntaxControls.has(target)) return false;
      if (fontProfileHelpers.has(target)) return false;
    }
    // Unknown constructors/patches must not receive these helpers, including in
    // another project file. No inference about a caller-defined macro is made.
    const nextControl = /^\s*\\([A-Za-z@]+)/u.exec(source.slice(token.start + token.name.length + 1))?.[1];
    if (!fontProfileHelpers.has(token.name) && ((!['makeatletter', 'makeatother'].includes(token.name) && fontProfileHelpers.has(nextControl)) || token.groups.some(item => helperMention(item.inner)))) return false;
    if (['ExplSyntaxOn', 'ProvidesExplPackage', 'ProvidesExplClass'].includes(token.name)) return false;
    if (lexicalControls.has(token.name) || token.name === '@sanitize@url') occurrences.push(token);
    if (token.name === 'verb') at = token.end; else at = token.start + 1 + (token.name?.length || 1);
  }
  const hasUrlShim = occurrences.some(item => item.name === 'catcode');
  if (hasUrlShim && !['href', '@href', '@@href', 'url', '@url', '@sanitize@url'].every(target => safeDefinitions.some(item => item.target === target))) return false;
  return occurrences.every(item => safeDefinitions.some(definition => item.start > definition.start && item.start < definition.end));
}
export const literalLexicalSafety = lexicalSafety;
function environmentEnd(source, first) {
  const name = first.groups[0]?.inner;
  if (!/^[A-Za-z][A-Za-z0-9*_-]*$/.test(name || '')) fail('UNSUPPORTED_TEX', 'Dynamic environments cannot acquire literal authority.');
  const stack = [name];
  for (let at = first.end; at < source.length;) {
    if (source[at] === '%') { const next = source.indexOf('\n', at); at = next < 0 ? source.length : next + 1; continue; }
    if (source[at] !== '\\') { at++; continue; }
    const token = command(source, at); at = token.end;
    if (token.name === 'begin') stack.push(token.groups[0]?.inner);
    if (token.name === 'end') {
      if (stack.pop() !== token.groups[0]?.inner) fail('UNSUPPORTED_TEX', 'Unbalanced protected environment.');
      if (!stack.length) return at;
    }
  }
  fail('UNSUPPORTED_TEX', 'Unclosed protected environment.');
}
export function protectLiteralRange(source, id) {
  const protectedTokens = []; let displayText = '';
  const protect = raw => { const token = { id: `⟦P${protectedTokens.length + 1}_${sha256(id).slice(0, 6)}⟧`, raw }; protectedTokens.push(token); displayText += token.id; };
  const walk = text => { let depth = 0;
  for (let at = 0; at < text.length;) {
    const start = at, character = text[at];
    if (character === '%') { const end = text.indexOf('\n', at); at = end < 0 ? text.length : end + 1; protect(text.slice(start, at)); continue; }
    if (character === '$' || character === '\\' && ['(', '['].includes(text[at + 1])) {
      const delimiter = character === '$' ? text[at + 1] === '$' ? '$$' : '$' : text.slice(at, at + 2), ending = delimiter === '\\(' ? '\\)' : delimiter === '\\[' ? '\\]' : delimiter;
      at += delimiter.length; let end = -1;
      for (; at < text.length; at++) { if (text.startsWith(ending, at)) { end = at + ending.length; break; } if (text[at] === '\\') at++; }
      if (end < 0) fail('UNSUPPORTED_TEX', 'Unclosed protected mathematics.'); at = end; protect(text.slice(start, at)); continue;
    }
    if (character === '\\') {
      const token = command(text, at);
      if (!token.name) fail('UNSUPPORTED_TEX', 'An incomplete TeX control cannot acquire literal authority.');
      if (token.name === 'begin') { at = environmentEnd(text, token); protect(text.slice(start, at)); continue; }
      if (formatting.has(token.name)) {
        const required = formatting.get(token.name), groups = token.groups.filter(item => text[item.start] === '{');
        if (groups.length !== required) fail('UNSUPPORTED_TEX', 'A text command has unsupported arguments.');
        const body = groups.at(-1); protect(text.slice(start, body.start + 1)); walk(body.inner); protect('}'); at = token.end; continue;
      }
      if (token.name && !fixedControls.has(token.name) && !'\\%&#_$^~{} ,;:!\'"`=-/'.includes(token.name)) fail('UNSUPPORTED_TEX', 'An unknown dynamic control cannot acquire literal authority.');
      at = token.end; protect(text.slice(start, at)); continue;
    }
    if ('{}&#^_~'.includes(character)) { if (character === '{') depth++; if (character === '}' && --depth < 0) fail('UNSUPPORTED_TEX', 'Unbalanced prose braces.'); protect(character); at++; continue; }
    displayText += character; at++;
  }
  if (depth) fail('UNSUPPORTED_TEX', 'Unbalanced prose braces.');
  };
  walk(source);
  if (restoreProtected({ protectedTokens }, displayText) !== source) fail('UNSUPPORTED_TEX', 'The protected reading range does not round trip.');
  return { protectedTokens, displayText, skeletonHash: sha256(JSON.stringify(protectedTokens.map(token => token.raw))) };
}
export function prepareRangeFile(source, filePath, view = null) {
  const projection = view || deriveEnglishView(source, filePath);
  return { source, filePath, bytes: Buffer.from(source), fileHash: sha256(source), projection, lexicalSafe: projection.supported && lexicalSafety(source) };
}
export function authorizeReadingRange(prepared, anchor, snapshotId) {
  if (!prepared.lexicalSafe || !anchor || !Number.isSafeInteger(anchor.startByte) || !Number.isSafeInteger(anchor.endByte)) return null;
  const range = prepared.projection.paragraphs.find(item => item.startByte === anchor.startByte && item.endByte === anchor.endByte && item.sourceHash === anchor.sourceHash);
  if (!range || range.sourceCandidateEligible === false && !(range.kind==='math'&&standaloneFormulaSource(range.source)) || anchor.path !== prepared.filePath || !anchor.id || prepared.bytes.subarray(anchor.startByte, anchor.endByte).toString('utf8') !== range.source) return null;
  try {
    const protectedRange = protectLiteralRange(range.source, anchor.id);
    const sourceAuthority = { kind: 'literal-reading-v1', snapshotId, path: anchor.path, startByte: anchor.startByte, endByte: anchor.endByte, sourceHash: anchor.sourceHash, fileHash: prepared.fileHash, skeletonHash: protectedRange.skeletonHash };
    return { ...range, ...protectedRange, id: anchor.id, path: anchor.path, beforeHash: anchor.sourceHash, sourceHash: anchor.sourceHash, translatable: true, sourceAuthority };
  } catch { return null; }
}
export function maskRawReplacement(segment, replacement) {
  if (typeof replacement !== 'string' || Buffer.byteLength(replacement) > 128 * 1024) fail('INVALID_INPUT', 'A literal replacement is too large.');
  let cursor = 0, masked = '';
  for (const token of segment.protectedTokens) {
    if(token.raw===''){masked+=token.id;continue;}
    const at = replacement.indexOf(token.raw, cursor);
    if (at < 0) fail('PROTECTED_TOKEN_CHANGED', 'A protected math, citation, macro or structure object changed.');
    const literal = replacement.slice(cursor, at); if (syntax.test(literal)) fail('UNSUPPORTED_TEX', 'New TeX syntax cannot be introduced in prose.');
    masked += literal + token.id; cursor = at + token.raw.length;
  }
  masked += replacement.slice(cursor);
  if (restoreProtected(segment, masked) !== replacement) fail('PROTECTED_TOKEN_CHANGED', 'The protected range replacement differs.');
  return masked;
}
