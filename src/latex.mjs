import { createHash, randomUUID } from 'node:crypto';
import { inlineFormattingNames } from '../ui/inline-structures.mjs';
import { inlineSyntaxHazard } from './inline-structure-syntax.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');

/** A conservative, non-expanding TeX lexer. Unknown syntax is never executable. */
export function commands(source) {
  const found = [];
  for (let i = 0; i < source.length;) {
    if (source[i] === '%') { i = source.indexOf('\n', i); if (i < 0) break; continue; }
    if (source[i] !== '\\') { i++; continue; }
    const start = i++;
    let name = '';
    while (/[A-Za-z@]/.test(source[i] ?? '') && i < source.length) name += source[i++];
    if (!name) { i++; continue; }
    if (source[i] === '*') i++;
    const args = [], groups = [];
    let end = i;
    for (let count = 0; count < 8; count++) {
      let cursor = end;
      while (source[cursor] === ' ' || source[cursor] === '\t') cursor++;
      if (source[cursor] !== '{' && source[cursor] !== '[') break;
      const group = readGroup(source, cursor);
      if (!group) break;
      groups.push(group);
      if (source[cursor] === '{') args.push(group.inner);
      end = group.end;
    }
    found.push({ name, start, end, args, groups, raw: source.slice(start, end) });
    if (name === 'begin' && ['verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted'].includes(args[0])) {
      const closing = `\\end{${args[0]}}`, closeAt = source.indexOf(closing, end);
      if (closeAt >= 0) {
        found.push({ name: 'end', start: closeAt, end: closeAt + closing.length, args: [args[0]], groups: [], raw: closing });
        i = closeAt + closing.length;
        continue;
      }
    }
    i = end;
  }
  return found;
}

function readGroup(source, start) {
  const open = source[start], close = open === '{' ? '}' : ']';
  let depth = 1;
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue; }
    if (source[i] === '%') { const next = source.indexOf('\n', i); if (next < 0) return null; i = next; continue; }
    if (source[i] === open) depth++;
    else if (source[i] === close && --depth === 0) return { start, end: i + 1, inner: source.slice(start + 1, i) };
  }
  return null;
}

const protectedCommands = new Set(['cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'nocite', 'ref', 'eqref', 'pageref', 'autoref', 'cref', 'Cref', 'label', 'url', 'path', 'includegraphics', 'input', 'include', 'bibliography', 'bibliographystyle', 'addbibresource', 'footnotemark']);
const textCommands = new Set(['section', 'subsection', 'subsubsection', 'paragraph', 'title', 'caption', ...inlineFormattingNames]);
const nonTextCommands = new Set(['maketitle', 'tableofcontents', 'printbibliography', 'clearpage', 'newpage', 'item', 'noindent', 'par', 'centering', 'vfill']);
const presentationCommands = new Set(['par', 'noindent', 'normalfont', 'rmfamily', 'sffamily', 'ttfamily', 'mdseries', 'bfseries', 'upshape', 'itshape', 'slshape', 'scshape', 'tiny', 'scriptsize', 'footnotesize', 'small', 'normalsize', 'large', 'Large', 'LARGE', 'huge', 'Huge', 'enspace', 'quad', 'qquad', 'ignorespaces']);
const fontCommands = new Set(['normalfont', 'rmfamily', 'sffamily', 'ttfamily', 'mdseries', 'bfseries', 'upshape', 'itshape', 'slshape', 'scshape', 'tiny', 'scriptsize', 'footnotesize', 'small', 'normalsize', 'large', 'Large', 'LARGE', 'huge', 'Huge']);
const namedColor = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);

export function purePresentationBody(body) {
  if (body.length > 512) return false;
  const groups = [];
  let labelLength = 0;
  for (let i = 0; i < body.length;) {
    const group = groups.at(-1);
    if (/\s/u.test(body[i])) { if (group?.labelStarted) group.labelEnded = true; i++; continue; }
    if (body[i] === '{') { groups.push({ formatting: false, labelStarted: false, labelEnded: false }); i++; continue; }
    if (body[i] === '}') { if (!groups.length) return false; groups.pop(); i++; continue; }
    if (body[i] !== '\\') {
      const letter = String.fromCodePoint(body.codePointAt(i));
      if (!group?.formatting || group.labelEnded || !/^[\p{L}\p{N}.,:;!?+\-\/|()\[\]，。；：？！·—–]$/u.test(letter) || ++labelLength > 16) return false;
      group.labelStarted = true;
      i += letter.length;
      continue;
    }
    if (group?.labelStarted) return false;
    i++;
    const start = i;
    while (i < body.length && /[A-Za-z]/.test(body[i])) i++;
    const name = body.slice(start, i);
    if (presentationCommands.has(name)) { if (group && fontCommands.has(name)) group.formatting = true; continue; }
    if (name !== 'color') return false;
    while (/\s/u.test(body[i] ?? '') && i < body.length) i++;
    if (body[i] !== '{') return false;
    const colorGroup = readGroup(body, i);
    if (!colorGroup || !namedColor(colorGroup.inner)) return false;
    if (groups.length) groups.at(-1).formatting = true;
    i = colorGroup.end;
  }
  return groups.length === 0;
}

function presentationDefinitions(source, parsed) {
  return parsed.filter(c => ['newcommand', 'renewcommand', 'providecommand'].includes(c.name)).flatMap(c => {
    const target = /^\\([A-Za-z]+)$/.exec(c.args[0] ?? '')?.[1];
    if (!target) return [];
    const shape = c.groups.length === 2 || (c.groups.length === 3 && source[c.groups[1].start] === '[' && c.groups[1].inner === '0');
    const safe = c.name === 'newcommand' && c.args.length === 2 && shape && source[c.groups[0].start] === '{'
      && !textCommands.has(target) && !protectedCommands.has(target) && !nonTextCommands.has(target) && !presentationCommands.has(target)
      && purePresentationBody(c.args[1]);
    return [{ name: target, end: c.end, safe }];
  });
}

function presentationEnvironmentDefinitions(source, parsed) {
  return parsed.filter(c => ['newenvironment', 'renewenvironment'].includes(c.name)).flatMap(c => {
    const name = c.args[0];
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name ?? '')) return [];
    const shape = c.args.length === 3 && c.groups.length === 4 && source[c.groups[1].start] === '[' && c.groups[1].inner === '1';
    const safe = c.name === 'newenvironment' && shape
      && /^\s*\\par\s*\\begingroup\s*\\color\s*\{#1\}\s*$/.test(c.args[1])
      && /^\s*\\par\s*\\endgroup\s*\\smallskip\s*$/.test(c.args[2]);
    return [{ name, start: c.start, end: c.end, safe }];
  });
}

function definitionsAt(changes, position) {
  const names = new Set();
  for (const definition of changes) if (definition.end <= position) {
    if (definition.safe) names.add(definition.name);
    else names.delete(definition.name);
  }
  return names;
}

function analyze(source, segmentId, presentationMacros = new Set(), presentationEnvironments = new Set()) {
  const tokens = [], reasons = [];
  let text = '', visible = '', hasText = false;
  const protect = raw => {
    const id = `⟦P${tokens.length + 1}_${sha256(segmentId).slice(0, 6)}⟧`;
    tokens.push({ id, raw });
    text += id;
  };
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    if (ch === '%') {
      const end = source.indexOf('\n', i);
      const stop = end < 0 ? source.length : end + 1;
      protect(source.slice(i, stop)); i = stop; continue;
    }
    if (ch === '$') {
      const delimiter = source[i + 1] === '$' ? '$$' : '$';
      let j = i + delimiter.length, end = -1;
      for (; j < source.length; j++) {
        if (source[j] === '\\') { j++; continue; }
        if (source.startsWith(delimiter, j)) { end = j + delimiter.length; break; }
      }
      if (end < 0) { reasons.push('Unclosed math mode'); protect(source.slice(i)); break; }
      protect(source.slice(i, end)); visible += ' [math] '; i = end; continue;
    }
    if (ch === '\\') {
      if ('()[]'.includes(source[i + 1] ?? '')) {
        const ending = source[i + 1] === '(' ? '\\)' : source[i + 1] === '[' ? '\\]' : null;
        const end = ending && source.indexOf(ending, i + 2);
        if (!ending || end < 0) { reasons.push('Unbalanced math delimiter'); protect(source.slice(i)); break; }
        protect(source.slice(i, end + 2)); visible += ' [math] '; i = end + 2; continue;
      }
      if (!/[A-Za-z@]/.test(source[i + 1] ?? '')) {
        const raw = source.slice(i, i + 2); protect(raw); visible += raw.slice(1); i += 2; continue;
      }
      const command = commands(source.slice(i))[0];
      if (!command || command.start !== 0) { reasons.push('Unsupported command'); protect(source.slice(i)); break; }
      if (textCommands.has(command.name) && command.groups.length === 1 && source[i + command.groups[0].start] === '{') {
        const group = command.groups[0];
        protect(source.slice(i, i + group.start + 1));
        const inner = analyze(group.inner, `${segmentId}-${tokens.length}`, presentationMacros, presentationEnvironments);
        // Nested tokens retain unique identities in the enclosing segment.
        text += inner.text; visible += inner.visible; hasText ||= inner.hasText;
        tokens.push(...inner.tokens); reasons.push(...inner.reasons);
        protect('}'); i += command.end; continue;
      }
      protect(command.raw);
      if (protectedCommands.has(command.name)) {
        visible += ` [${command.name}] `;
        if (!command.args.length) reasons.push(`Unbraced protected command: ${command.name}`);
      }
      else if (nonTextCommands.has(command.name)) { /* structural, no natural-language body */ }
      else if (presentationMacros.has(command.name) && command.groups.length === 0) { /* verified zero-argument presentation marker; preserve invocation */ }
      else if (command.name === 'begin' || command.name === 'end') {
        const verified = presentationEnvironments.has(command.args[0]) && (command.name === 'end' ? command.args.length === 1 : command.args.length === 2 && namedColor(command.args[1]));
        if (!['abstract', 'itemize', 'enumerate'].includes(command.args[0]) && !verified) reasons.push(`Opaque environment: ${command.args[0] ?? '?'}`);
      } else reasons.push(`Unknown command: ${command.name}`);
      i += command.end; continue;
    }
    if ('{}&#^_~'.includes(ch)) { protect(ch); if (ch === '{' || ch === '}') reasons.push('Unclassified group'); i++; continue; }
    text += ch; visible += ch;
    if (/[\p{L}\p{N}]/u.test(ch)) hasText = true;
    i++;
  }
  return { tokens, text, visible: visible.trim(), hasText, reasons };
}

export function extractSegments(source, filePath, previous = [], rangeOverrides = []) {
  const parsed = commands(source);
  const presentationChanges = presentationDefinitions(source, parsed);
  const environmentChanges = presentationEnvironmentDefinitions(source, parsed);
  const spans = [], environments = [];
  for (const command of parsed) {
    if (command.name === 'begin') {
      const verified = definitionsAt(environmentChanges, command.start).has(command.args[0]) && command.args.length === 2 && namedColor(command.args[1]);
      environments.push({ name: command.args[0], start: command.start, supported: ['document', 'abstract', 'itemize', 'enumerate'].includes(command.args[0]) || verified });
    }
    if (command.name === 'end') {
      const at = environments.findLastIndex(env => env.name === command.args[0]);
      if (at < 0) {
        if (command.args[0] !== 'document') spans.push({ start: 0, end: command.end, reason: 'Unmatched environment boundary.' });
      } else {
        for (const environment of environments.splice(at)) if (!environment.supported)
          spans.push({ start: environment.start, end: command.end, reason: `Opaque environment: ${environment.name}` });
      }
    }
  }
  for (const environment of environments) if (!environment.supported) spans.push({ start: environment.start, end: source.length, reason: `Unclosed opaque environment: ${environment.name}` });
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '%') { const next = source.indexOf('\n', i); if (next < 0) break; i = next; continue; }
    let delimiter, ending;
    if (source[i] === '$') delimiter = ending = source[i + 1] === '$' ? '$$' : '$';
    else if (source[i] === '\\' && ['(', '['].includes(source[i + 1])) { delimiter = source.slice(i, i + 2); ending = source[i + 1] === '(' ? '\\)' : '\\]'; }
    else if (source[i] === '\\') { i++; continue; }
    else continue;
    let end = source.length;
    for (let j = i + delimiter.length; j < source.length; j++) {
      if (source.startsWith(ending, j)) { end = j + ending.length; break; }
      if (source[j] === '\\') j++;
    }
    spans.push({ start: i, end, math: true, reason: 'Math spans a paragraph boundary; preserve it as opaque.' });
    i = end - 1;
  }
  const dynamicSyntax = inlineSyntaxHazard(source,{strictDefinitions:false}) || parsed.find(c => {
    if (['catcode', 'mathcode', 'lccode', 'uccode', 'def', 'edef', 'gdef', 'xdef', 'let', 'futurelet', 'csname', 'directlua'].includes(c.name) || c.name.startsWith('if')) return true;
    if (['renewcommand', 'newcommand', 'providecommand'].includes(c.name)) {
      const target = c.args[0]?.replace(/^\\/, '');
      return textCommands.has(target) || presentationCommands.has(target) || ['begin', 'end', 'input', 'include', 'verb', 'ensuremath', 'color'].includes(target);
    }
    if (['newenvironment', 'renewenvironment'].includes(c.name) && environmentChanges.some(d => d.safe && d.name === c.args[0] && d.end <= c.start)) return true;
    return false;
  });
  const startCommand = parsed.find(c => c.name === 'begin' && c.args[0] === 'document');
  const endCommand = parsed.find(c => c.name === 'end' && c.args[0] === 'document');
  const start = startCommand?.end ?? 0;
  const end = endCommand?.start ?? source.length;
  const body = source.slice(start, end);
  // Blocks are separated by blank lines and known section boundaries. Offsets are retained.
  const breaks = /\r?\n[\t ]*\r?\n|(?=\\(?:section|subsection|subsubsection|paragraph)\*?\{)|(?<=\})\r?\n(?=[^\r\n])/g;
  let cursor = 0, section = 'Document';
  const blocks = [];
  for (const match of body.matchAll(breaks)) {
    if (match.index > cursor) blocks.push({ start: cursor, end: match.index });
    cursor = match.index + match[0].length;
  }
  if (cursor < body.length) blocks.push({ start: cursor, end: body.length });
  const used = new Set();
  const segments = blocks.flatMap(block => {
    const raw = body.slice(block.start, block.end), lead = raw.length - raw.trimStart().length;
    const value = raw.trim();
    if (!value) return [];
    const charStart = start + block.start + lead;
    const startByte = Buffer.byteLength(source.slice(0, charStart));
    const endByte = startByte + Buffer.byteLength(value), beforeHash = sha256(value);
    const old = previous.find(s => !used.has(s.id) && s.path === filePath && s.beforeHash === beforeHash && s.startByte === startByte);
    const id = old?.id ?? `seg-${randomUUID()}`;
    if (old) used.add(old.id);
    const presentationMacros = definitionsAt(presentationChanges, charStart);
    const presentationEnvironments = definitionsAt(environmentChanges, charStart);
    const result = analyze(value, id, presentationMacros, presentationEnvironments);
    const charEnd = charStart + value.length;
    for (const span of spans) if (span.start < charEnd && span.end > charStart && (!span.math || span.start < charStart || span.end > charEnd)) result.reasons.push(span.reason);
    if (dynamicSyntax && charEnd > dynamicSyntax.start) result.reasons.push('Dynamic TeX syntax or command redefinition requires manual source review from this point onward.');
    const heading = commands(value).find(c => ['section', 'subsection', 'subsubsection', 'paragraph'].includes(c.name));
    if (heading?.args[0]) section = heading.args[0];
    return [{ id, path: filePath, startByte, endByte, beforeHash, source: value,
      displayText: result.text, visibleText: result.visible, section,
      translatable: result.reasons.length === 0 && result.hasText,
      opaqueReasons: result.reasons, protectedTokens: result.tokens }];
  });
  if (!Array.isArray(rangeOverrides)) throw Object.assign(new Error('Range overrides must be an array.'), { code: 'INVALID_RANGE_OVERRIDE' });
  if (!rangeOverrides.length) return segments;
  const invalid = message => { throw Object.assign(new Error(message), { code: 'INVALID_RANGE_OVERRIDE' }); };
  if (rangeOverrides.length > 4096) invalid('Too many source range overrides.');
  const sourceBytes = Buffer.from(source), ranges = rangeOverrides.map(item => ({ ...item }));
  const requestedIds = new Set(), coordinates = new Set();
  for (const range of ranges) {
    if (!Number.isSafeInteger(range.startByte) || !Number.isSafeInteger(range.endByte) || range.startByte < 0 || range.endByte > sourceBytes.length || range.startByte >= range.endByte)
      invalid('A source range must contain ordered UTF-8 byte coordinates.');
    for (const coordinate of [range.startByte, range.endByte]) {
      if (coordinate < sourceBytes.length && (sourceBytes[coordinate] & 0xc0) === 0x80) invalid('A source range cannot split a UTF-8 character.');
      coordinates.add(coordinate);
    }
    if (range.id !== undefined) {
      if (typeof range.id !== 'string' || !range.id || range.id.length > 160 || requestedIds.has(range.id)) invalid('Source range identities must be distinct nonempty strings.');
      requestedIds.add(range.id);
    }
  }
  ranges.sort((a, b) => a.startByte - b.startByte);
  for (let i = 1; i < ranges.length; i++) if (ranges[i].startByte < ranges[i - 1].endByte) invalid('Source range overrides cannot overlap.');
  const byteToChar = new Map();
  for (let charAt = 0, byteAt = 0; charAt <= source.length;) {
    if (coordinates.has(byteAt)) byteToChar.set(byteAt, charAt);
    if (charAt === source.length) break;
    const codePoint = String.fromCodePoint(source.codePointAt(charAt));
    charAt += codePoint.length; byteAt += Buffer.byteLength(codePoint);
  }
  const byParent = new Map();
  for (const range of ranges) {
    const parents = segments.filter(segment => range.startByte >= segment.startByte && range.endByte <= segment.endByte);
    if (parents.length !== 1 || !parents[0].translatable) invalid('A source range must be inside one already-safe canonical source block.');
    const parent = parents[0];
    // A controller can narrow prose, but cannot expose half a protected object as editable text.
    let searchAt = 0;
    for (const token of parent.protectedTokens) {
      const tokenAt = parent.source.indexOf(token.raw, searchAt);
      if (tokenAt < 0) invalid('Canonical protected token coordinates are ambiguous.');
      const tokenStart = parent.startByte + Buffer.byteLength(parent.source.slice(0, tokenAt)), tokenEnd = tokenStart + Buffer.byteLength(token.raw);
      if ((range.startByte > tokenStart && range.startByte < tokenEnd) || (range.endByte > tokenStart && range.endByte < tokenEnd)) invalid('A source range cannot split a protected TeX object.');
      searchAt = tokenAt + token.raw.length;
    }
    if (!byParent.has(parent.id)) byParent.set(parent.id, []);
    byParent.get(parent.id).push(range);
  }
  const finalIds = new Set();
  return segments.flatMap(parent => {
    const overrides = byParent.get(parent.id);
    if (!overrides) {
      if (finalIds.has(parent.id)) invalid('Source range identities collide with another canonical source block.');
      finalIds.add(parent.id); return [parent];
    }
    return overrides.map(range => {
      const charStart = byteToChar.get(range.startByte), charEnd = byteToChar.get(range.endByte);
      if (charStart === undefined || charEnd === undefined) invalid('A source range must end at valid character boundaries.');
      const value = source.slice(charStart, charEnd), beforeHash = sha256(value);
      const old = previous.find(segment => !finalIds.has(segment.id) && segment.path === filePath && segment.beforeHash === beforeHash && segment.startByte === range.startByte);
      const id = old?.id ?? range.id ?? `seg-${randomUUID()}`;
      if (finalIds.has(id)) invalid('Source range identities collide with another source block.');
      finalIds.add(id);
      const result = analyze(value, id, definitionsAt(presentationChanges, charStart), definitionsAt(environmentChanges, charStart));
      if (result.reasons.length || !result.hasText) invalid('A narrowed source range must remain safe natural-language content.');
      return { id, path: filePath, startByte: range.startByte, endByte: range.endByte, beforeHash, source: value,
        displayText: result.text, visibleText: result.visible, section: parent.section,
        translatable: true, opaqueReasons: result.reasons, protectedTokens: result.tokens };
    });
  });
}

export function restoreProtected(segment, replacement) {
  if (typeof replacement !== 'string' || Buffer.byteLength(replacement) > 128 * 1024)
    throw Object.assign(new Error('Replacement exceeds the supported size.'), { code: 'INVALID_INPUT' });
  let remaining = replacement;
  let last = -1;
  for (const token of segment.protectedTokens) {
    const first = replacement.indexOf(token.id);
    if (first < 0 || first <= last || replacement.indexOf(token.id, first + token.id.length) >= 0)
      throw Object.assign(new Error('Protected formula, reference, or structural token is missing, duplicated, or reordered.'), { code: 'PROTECTED_TOKEN_CHANGED' });
    last = first;
    if (token.raw.startsWith('%') && !token.raw.endsWith('\n') && replacement.slice(first + token.id.length).trim())
      throw Object.assign(new Error('Text cannot be appended after a protected trailing comment.'), { code: 'PROTECTED_TOKEN_CHANGED' });
    if (/\\[A-Za-z@]+$/.test(token.raw) && /^[\p{L}@]/u.test(replacement.slice(first + token.id.length)))
      throw Object.assign(new Error('A protected TeX control word must retain a separating delimiter.'), { code: 'UNSUPPORTED_TEX' });
    remaining = remaining.replace(token.id, '');
  }
  if (/[⟦⟧]/u.test(remaining)) throw Object.assign(new Error('Unknown protected token.'), { code: 'PROTECTED_TOKEN_CHANGED' });
  if (/[\\$%{}&#^_~\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(remaining))
    throw Object.assign(new Error('New TeX syntax is not permitted in a natural-language replacement.'), { code: 'UNSUPPORTED_TEX' });
  let restored = replacement;
  for (const token of segment.protectedTokens) restored = restored.replace(token.id, () => token.raw);
  return restored;
}
