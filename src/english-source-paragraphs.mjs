import { commands, restoreProtected, sha256 } from './latex.mjs';

// Reading metadata only. This scanner never expands TeX or grants source-write
// authority. The independent literal-range validator makes that decision.
const mathEnvironments = new Set(['math', 'displaymath', 'equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*', 'flalign', 'flalign*', 'gather', 'gather*', 'multline', 'multline*', 'eqnarray', 'eqnarray*', 'split', 'aligned', 'alignedat', 'gathered', 'cases', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix']);
const proseEnvironments = new Set(['abstract', 'theorem', 'lemma', 'proposition', 'corollary', 'definition', 'remark', 'assumption', 'claim', 'proof', 'acknowledgments', 'acknowledgements', 'itemize', 'enumerate', 'description', 'quote', 'quotation', 'center']);
const figureEnvironments = new Set(['figure', 'figure*', 'table', 'table*', 'longtable', 'sidewaysfigure', 'sidewaystable']);
const verbatimEnvironments = new Set(['verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted']);
const headings = new Set(['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'title', 'subtitle', 'caption']);
const definitions = new Set(['newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand', 'newenvironment', 'renewenvironment', 'def', 'edef', 'gdef', 'xdef', 'let', 'futurelet']);
const boundaries = new Set(['maketitle', 'tableofcontents', 'listoffigures', 'listoftables', 'bibliography', 'bibliographystyle', 'addbibresource', 'printbibliography', 'input', 'include', 'includeonly', 'appendix', 'clearpage', 'newpage', 'pagebreak', 'author', 'affiliation', 'email', 'date', 'thanks', 'keywords', 'pacs', 'makeatletter', 'makeatother']);
const formatting = new Map(['emph', 'textbf', 'textit', 'textnormal', 'textrm', 'textsf', 'texttt', 'textsl', 'textsc', 'underline', 'mbox', 'footnote'].map(name => [name, 1]));
formatting.set('textcolor', 2); formatting.set('colorbox', 2); formatting.set('fcolorbox', 3);
const headingControls = new Set(['par', 'indent', 'noindent', 'ignorespaces', 'textit', 'textbf', 'emph', 'textnormal', 'textrm', 'textsf', 'textsl', 'textsc', 'paragraph', 'section', 'subsection', 'subsubsection', 'normalfont', 'bfseries', 'itshape']);
const fontDeclarations = new Set(['normalfont', 'rmfamily', 'sffamily', 'ttfamily', 'mdseries', 'bfseries', 'upshape', 'itshape', 'slshape', 'scshape', 'tiny', 'scriptsize', 'footnotesize', 'small', 'normalsize', 'large', 'Large', 'LARGE', 'huge', 'Huge']);
const referenceOrLayoutControls = new Set(['cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'nocite', 'ref', 'eqref', 'pageref', 'autoref', 'cref', 'Cref', 'label', 'url', 'path', 'includegraphics', 'index', 'hspace', 'vspace', 'par', 'noindent', 'indent', 'centering', 'smallskip', 'medskip', 'bigskip', 'vfill', 'hfill', 'relax', 'protect', 'ignorespaces', 'quad', 'qquad', 'enspace', ...fontDeclarations]);
const problem = (message, at) => Object.assign(new Error(message), { at, code: 'ENGLISH_STRUCTURE_UNBALANCED' });
const whitespace = character => character !== undefined && /[ \t\r\n]/u.test(character);
function skipSpace(source, start) { let at = start; while (whitespace(source[at])) at++; return at; }
function group(source, start) {
  const open = source[start], close = open === '{' ? '}' : ']'; if (!['{', '['].includes(open)) return null;
  let depth = 1, braces = 0;
  for (let at = start + 1; at < source.length; at++) {
    if (source[at] === '\\') { at++; continue; }
    if (source[at] === '%') { const next = source.indexOf('\n', at); if (next < 0) throw problem('An argument ends inside an unclosed comment.', start); at = next; continue; }
    if (open === '[' && source[at] === '{') { braces++; continue; }
    if (open === '[' && source[at] === '}') { if (--braces < 0) throw problem('An optional argument has unbalanced braces.', start); continue; }
    if (braces) continue;
    if (source[at] === open) depth++;
    if (source[at] === close && --depth === 0) return { start, end: at + 1, innerStart: start + 1, innerEnd: at, inner: source.slice(start + 1, at), open };
  }
  throw problem('A command argument is unbalanced.', start);
}
function control(source, start) {
  let at = start + 1;
  if (!/[A-Za-z@]/u.test(source[at] || '')) return { name: source[at] || '', start, nameEnd: Math.min(source.length, at + 1), end: Math.min(source.length, at + 1), args: [], groups: [] };
  while (/[A-Za-z@]/u.test(source[at] || '')) at++;
  const name = source.slice(start + 1, at); if (source[at] === '*') at++; const nameEnd = at;
  if (name === 'verb') { const delimiter = source[at], end = delimiter && source.indexOf(delimiter, at + 1); if (!delimiter || end < 0) throw problem('A verbatim control is unclosed.', start); return { name, start, nameEnd, end: end + 1, args: [], groups: [] }; }
  if (name === 'item') { const next = skipSpace(source, at), option = source[next] === '[' ? group(source, next) : null; return { name, start, nameEnd, end: option?.end ?? at, args: [], groups: option ? [option] : [] }; }
  if (['let', 'futurelet'].includes(name)) {
    let next = skipSpace(source, at); if (source[next] === '\\') next = control(source, next).nameEnd;
    next = skipSpace(source, next); if (source[next] === '=') next = skipSpace(source, next + 1);
    if (source[next] === '\\') next = control(source, next).nameEnd; else if (next < source.length) next++;
    return { name, start, nameEnd, end: next, args: [], groups: [] };
  }
  if (['def', 'edef', 'gdef', 'xdef'].includes(name)) {
    let next = skipSpace(source, at); if (source[next] === '\\') next = control(source, next).nameEnd;
    const body = source.indexOf('{', next); if (body < 0 || body - next > 1024) throw problem('A macro definition has no bounded literal body.', start); const item = group(source, body);
    return { name, start, nameEnd, end: item.end, args: [item], groups: [item] };
  }
  if (definitions.has(name) && source[skipSpace(source, at)] === '\\') at = control(source, skipSpace(source, at)).nameEnd;
  const args = [], groups = [], required = ['begin', 'end'].includes(name) || headings.has(name) ? 1 : name === 'newtheorem' ? 2 : 12;
  for (let count = 0; count < 12 && args.length < required; count++) {
    const next = skipSpace(source, at); if (!['{', '['].includes(source[next])) break; const item = group(source, next); groups.push(item); if (item.open === '{') args.push(item); at = item.end;
  }
  if (name === 'begin') { const next = skipSpace(source, at); if (source[next] === '[') { const item = group(source, next); groups.push(item); at = item.end; } }
  return { name, start, nameEnd, end: at, args, groups };
}
function mathEnd(source, start, limit = source.length) {
  const delimiter = source[start] === '$' ? source[start + 1] === '$' ? '$$' : '$' : source.slice(start, start + 2), close = delimiter === '\\(' ? '\\)' : delimiter === '\\[' ? '\\]' : delimiter;
  for (let at = start + delimiter.length; at < limit; at++) { if (source.startsWith(close, at)) return at + close.length; if (source[at] === '\\') at++; }
  throw problem('A mathematical delimiter is unclosed.', start);
}
function environment(source, first, limit = source.length) {
  const name = first.args[0]?.inner; if (!/^[A-Za-z][A-Za-z0-9*_-]*$/u.test(name || '')) throw problem('A dynamic environment cannot be decoded for paragraph reading.', first.start);
  if (verbatimEnvironments.has(name)) { const ending = `\\end{${name}}`, at = source.indexOf(ending, first.end); if (at < 0 || at >= limit) throw problem('A verbatim environment is unclosed.', first.start); return { name, start: first.start, bodyStart: first.end, bodyEnd: at, end: at + ending.length }; }
  const stack = [name];
  for (let at = first.end; at < limit;) {
    if (source[at] === '%') { const next = source.indexOf('\n', at); at = next < 0 ? limit : next + 1; continue; }
    if (source[at] === '$' || source[at] === '\\' && ['(', '['].includes(source[at + 1])) { at = mathEnd(source, at, limit); continue; }
    if (source[at] !== '\\') { at++; continue; }
    const token = control(source, at); at = token.end;
    if (token.name === 'begin') {
      if (verbatimEnvironments.has(token.args[0]?.inner)) { at = environment(source, token, limit).end; continue; }
      stack.push(token.args[0]?.inner);
    } else if (token.name === 'end') {
      if (stack.pop() !== token.args[0]?.inner) throw problem('Environment boundaries are unbalanced.', token.start);
      if (!stack.length) return { name, start: first.start, bodyStart: first.end, bodyEnd: token.start, end: token.end };
    }
  }
  throw problem('An environment is unclosed.', first.start);
}
function trim(source, start, end) { while (start < end && /\s/u.test(source[start])) start++; while (end > start && /\s/u.test(source[end - 1])) end--; return { start, end }; }
function presentationHeading(source, start) {
  const item = group(source, start); let at = skipSpace(source, item.innerStart), declarations = 0;
  while (source[at] === '\\') { const token = control(source, at); if (!fontDeclarations.has(token.name) || token.groups.length) break; declarations++; at = skipSpace(source, token.end); }
  if (!declarations) return null;
  const tail = /(?:\s*\\(?:par|medskip|smallskip|bigskip|ignorespaces)\s*)+$/u.exec(source.slice(at, item.innerEnd)), end = tail ? at + tail.index : item.innerEnd;
  if (!/[\p{L}\p{N}]/u.test(source.slice(at, end))) return null;
  return { start: at, end, wrapperEnd: item.end };
}
function staticHeadingMacros(source) {
  const candidates = new Map(), redefined = new Set(), environmentDefinitions = new Set(), theoremNames = new Set();
  for (const token of commands(source)) {
    if (token.name === 'newtheorem' && /^[A-Za-z][A-Za-z0-9_-]*$/u.test(token.args[0] || '')) theoremNames.add(token.args[0]);
    if (['newenvironment', 'renewenvironment'].includes(token.name)) environmentDefinitions.add(token.args[0]);
    if (['newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand'].includes(token.name)) {
      const target = /^\\([A-Za-z@]+)$/u.exec(token.args[0] || '')?.[1]; if (!target) continue;
      if (headings.has(target)) redefined.add(target);
      if (candidates.has(target) || token.name !== 'newcommand') { candidates.delete(target); redefined.add(target); continue; }
      const body = token.args[1] || '', controls = [...body.matchAll(/\\([A-Za-z@]+)\*?/gu)].map(match => match[1]);
      const residue = body.replace(/\\[A-Za-z@]+\*?/gu, '').replace('#1', '').replace(/[{}\s-]/gu, '');
      if (token.groups.length === 3 && token.groups[1]?.inner === '1' && body.split('#1').length === 2 && controls.length > 0 && controls.every(name => headingControls.has(name)) && !residue && !redefined.has(target)) candidates.set(target, true);
    }
    if (['def', 'edef', 'gdef', 'xdef', 'let', 'futurelet'].includes(token.name)) {
      const target = /^\s*\\([A-Za-z@]+)/u.exec(source.slice(token.start + token.name.length + 1))?.[1]; if (target) { redefined.add(target); candidates.delete(target); }
    }
  }
  // Deferred definitions are inspected lexically too, without expanding their
  // enclosing macros. A body containing a later alias cannot certify a heading.
  for (const match of source.matchAll(/\\(?:def|edef|gdef|xdef|let|futurelet|renewcommand|providecommand|DeclareRobustCommand|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|newrobustcmd|renewrobustcmd|patchcmd|apptocmd|pretocmd|csdef|cslet|@namedef)\s*(?:\{\s*\\?([A-Za-z@]+)\s*\}|\\([A-Za-z@]+))/gu)) redefined.add(match[1] || match[2]);
  for (const match of source.matchAll(/\\(?:newenvironment|renewenvironment)\s*\{([A-Za-z][A-Za-z0-9_-]*)\}/gu)) environmentDefinitions.add(match[1]);
  for (const name of redefined) candidates.delete(name);
  return { candidates, redefined, environmentDefinitions, theoremNames };
}

/** Protect a complete reading interval without inferring write authority.
 * Unknown macro invocations and environments are retained as single objects. */
export function protectEnglishReading(source, id) {
  const protectedTokens = [], diagnostics = []; let displayText = '';
  const protect = raw => { const token = { id: `⟦P${protectedTokens.length + 1}_${sha256(id).slice(0, 6)}⟧`, raw }; protectedTokens.push(token); displayText += token.id; };
  const walk = text => {
    for (let at = 0; at < text.length;) {
      const start = at, character = text[at];
      if (character === '%') { const next = text.indexOf('\n', at); at = next < 0 ? text.length : next + 1; protect(text.slice(start, at)); continue; }
      if (character === '$' || character === '\\' && ['(', '['].includes(text[at + 1])) { at = mathEnd(text, at); protect(text.slice(start, at)); continue; }
      if (character === '\\') {
        const token = control(text, at);
        if (token.name === 'begin') { at = environment(text, token).end; protect(text.slice(start, at)); continue; }
        const required = formatting.get(token.name);
        if (required && token.args.length === required && token.groups.filter(item => item.open === '{').length === required) { const body = token.args.at(-1); protect(text.slice(start, body.innerStart)); walk(body.inner); protect('}'); at = token.end; continue; }
        at = token.end; protect(text.slice(start, at)); continue;
      }
      if ('{}&#^_~'.includes(character) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(character)) { protect(character); at++; continue; }
      displayText += character; at++;
    }
  };
  try { walk(source); if (restoreProtected({ protectedTokens }, displayText) !== source) throw problem('A protected reading interval does not round trip.', 0); return { displayText, protectedTokens, requestable: true, readingDiagnostics: diagnostics }; }
  catch (error) { return { displayText: source, protectedTokens: [], requestable: false, readingDiagnostics: [{ severity: 'warning', code: error.code || 'ENGLISH_READING_UNSUPPORTED', message: error.message }] }; }
}

export function readEnglishSourceParagraphs(source, filePath) {
  if (typeof source !== 'string' || typeof filePath !== 'string' || !filePath || Buffer.byteLength(source) > 4 * 1024 * 1024) throw new TypeError('A bounded English TeX source and file identity are required.');
  const spans = [], diagnostics = [], definitionsInfo = staticHeadingMacros(source), naturalEnvironments = new Set([...proseEnvironments, ...definitionsInfo.theoremNames]);
  let section = 'Document', document = null, structureUnsafe = false;
  const add = (start, end, kind = 'paragraph', eligible = true) => { const range = trim(source, start, end); if (range.start >= range.end) return; spans.push({ ...range, kind, section, sourceCandidateEligible: eligible }); };
  try {
    for (let at = 0; at < source.length;) {
      if (source[at] === '%') { const next = source.indexOf('\n', at); at = next < 0 ? source.length : next + 1; continue; }
      if (source[at] === '$' || source[at] === '\\' && ['(', '['].includes(source[at + 1])) { at = mathEnd(source, at); continue; }
      if (source[at] !== '\\') { at++; continue; }
      const token = control(source, at); at = token.end;
      if (token.name === 'title' && token.args[0]) add(token.args[0].innerStart, token.args[0].innerEnd, 'title', !definitionsInfo.redefined.has(token.name));
      if (token.name === 'begin' && token.args[0]?.inner === 'document') { document = environment(source, token); break; }
    }
  } catch (error) { structureUnsafe = true; diagnostics.push({ severity: 'warning', code: error.code || 'ENGLISH_STRUCTURE_UNBALANCED', message: error.message }); }
  const captionRanges = (start, end, eligible) => {
    for (let at = start; at < end;) {
      if (source[at] === '%') { const next = source.indexOf('\n', at); at = next < 0 ? end : next + 1; continue; }
      if (source[at] === '$' || source[at] === '\\' && ['(', '['].includes(source[at + 1])) { at = mathEnd(source, at, end); continue; }
      if (source[at] !== '\\') { at++; continue; }
      const token = control(source, at); at = token.end; if (token.name === 'caption' && token.args[0]) add(token.args[0].innerStart, token.args[0].innerEnd, 'caption', eligible && !definitionsInfo.redefined.has('caption'));
    }
  };
  const walk = (start, end, eligible = true) => {
    let cursor = start;
    const flush = stop => { if (stop > cursor) add(cursor, stop, 'paragraph', eligible); cursor = stop; };
    for (let at = start; at < end;) {
      if (source[at] === '%') { const next = source.indexOf('\n', at); at = next < 0 ? end : next; continue; }
      if (source[at] === '$' || source[at] === '\\' && ['(', '['].includes(source[at + 1])) { at = mathEnd(source, at, end); continue; }
      if (source[at] === '\n' || source[at] === '\r') { const blank = /^(?:\r?\n)[\t ]*(?:\r?\n)/u.exec(source.slice(at, Math.min(end, at + 8192))); if (blank) { flush(at); at += blank[0].length; cursor = at; continue; } }
      if (source[at] === '{' && !source.slice(source.lastIndexOf('\n', at - 1) + 1, at).trim()) {
        const presented = presentationHeading(source, at), nextNewline = presented && source.indexOf('\n', presented.wrapperEnd), lineEnd = nextNewline < 0 ? end : nextNewline;
        const suffix = presented && source.slice(presented.wrapperEnd, lineEnd), staticTail = suffix !== null && suffix !== false && /^(?:\s*\\(?:par|medskip|smallskip|bigskip|ignorespaces)\s*)*$/u.test(suffix || '');
        if (presented && staticTail) { flush(at); add(presented.start, presented.end, 'heading', eligible); at = lineEnd; cursor = at; continue; }
      }
      if (source[at] === '{') { at = group(source, at).end; continue; }
      if (source[at] !== '\\') { at++; continue; }
      const token = control(source, at);
      if (token.name === 'begin') {
        const env = environment(source, token, end);
        if (mathEnvironments.has(env.name)) { at = env.end; continue; }
        flush(token.start);
        if (naturalEnvironments.has(env.name)) walk(env.bodyStart, env.bodyEnd, eligible && !definitionsInfo.environmentDefinitions.has(env.name));
        else if (figureEnvironments.has(env.name)) captionRanges(env.bodyStart, env.bodyEnd, eligible);
        else { add(env.start, env.end, 'opaque', false); diagnostics.push({ severity: 'warning', code: 'ENGLISH_OPAQUE_ENVIRONMENT', message: `The ${env.name} environment is preserved as an opaque reading object.` }); }
        at = env.end; cursor = at; continue;
      }
      if (headings.has(token.name) || definitionsInfo.candidates.has(token.name)) {
        const argument = token.args[0]; if (!argument) { at = token.end; continue; } flush(token.start);
        const kind = token.name === 'caption' ? 'caption' : token.name === 'title' ? 'title' : 'heading'; if (kind === 'heading') section = argument.inner.trim();
        add(argument.innerStart, argument.innerEnd, kind, eligible && !definitionsInfo.redefined.has(token.name)); at = token.end; cursor = at; continue;
      }
      if (boundaries.has(token.name) || definitions.has(token.name) || token.name === 'item' || token.name === 'newtheorem' || token.name === 'newtheoremstyle') { flush(token.start); if (token.name === 'appendix') section = 'Appendix'; at = token.end; cursor = at; continue; }
      at = token.end;
    }
    flush(end);
  };
  try { walk(document?.bodyStart ?? 0, document?.bodyEnd ?? source.length); }
  catch (error) { structureUnsafe = true; diagnostics.push({ severity: 'warning', code: error.code || 'ENGLISH_STRUCTURE_UNBALANCED', message: error.message }); }
  const unique = [...new Map(spans.sort((a, b) => a.start - b.start || a.end - b.end).map(span => [`${span.start}:${span.end}`, span])).values()], accepted = [];
  for (const span of unique) {
    if (accepted.some(previous => previous.start < span.end && previous.end > span.start)) continue;
    const value = source.slice(span.start, span.end), masked = protectEnglishReading(value, `${filePath}:${span.start}`), prose = masked.displayText.replace(/⟦P\d+_[a-f0-9]{6}⟧/gu, '');
    if (!/[\p{L}\p{N}]/u.test(prose)) {
      if (masked.protectedTokens.some(token => /^\$|^\\[([]|^\\begin\{(?:equation|align|gather|multline|displaymath|math)/u.test(token.raw))) { span.kind = 'math'; span.sourceCandidateEligible = false; }
      else if (span.kind !== 'opaque') {
        const opaqueControl = masked.protectedTokens.find(token => { const name = /^\\([A-Za-z@]+)/u.exec(token.raw)?.[1]; return name && !referenceOrLayoutControls.has(name); });
        if (!opaqueControl) continue;
        span.kind = 'opaque'; span.sourceCandidateEligible = false; diagnostics.push({ severity: 'warning', code: 'ENGLISH_OPAQUE_CONTROL', message: 'An unsupported standalone control is retained as an opaque reading object.' });
      }
    }
    accepted.push(span);
  }
  if (structureUnsafe) for (const span of accepted) span.sourceCandidateEligible = false;
  const coordinates = new Set(accepted.flatMap(span => [span.start, span.end])), bytePositions = new Map(); let byte = 0;
  const lineStarts = [0]; for (let at = 0; at < source.length; at++) if (source[at] === '\n') lineStarts.push(at + 1);
  for (let at = 0; at <= source.length;) { if (coordinates.has(at)) bytePositions.set(at, byte); if (at === source.length) break; const point = String.fromCodePoint(source.codePointAt(at)); at += point.length; byte += Buffer.byteLength(point); }
  const lineAt = position => { let low = 0, high = lineStarts.length; while (low < high) { const middle = (low + high) >>> 1; if (lineStarts[middle] <= position) low = middle + 1; else high = middle; } return low; };
  const paragraphs = accepted.map(span => { const text = source.slice(span.start, span.end), sourceHash = sha256(text), startByte = bytePositions.get(span.start), endByte = bytePositions.get(span.end), originalLine = lineAt(span.start), originalEndLine = lineAt(span.end - 1); return { id: `read-${sha256(`${filePath}\0${startByte}\0${sourceHash}`).slice(0, 24)}`, path: filePath, sourcePath: filePath, startByte, endByte, sourceStartByte: startByte, sourceEndByte: endByte, source: text, translation: '', sourceHash, originalLine, derivedLine: originalLine, originalEndLine, derivedEndLine: originalEndLine, section: span.section, kind: span.kind, readOnly: true, sourceCandidateEligible: span.sourceCandidateEligible, confidence: 'literalEnglishStructure' }; });
  return { paragraphs, diagnostics };
}
