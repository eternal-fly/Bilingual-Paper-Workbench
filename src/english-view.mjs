import { createHash } from 'node:crypto';
import { readEnglishSourceParagraphs } from './english-source-paragraphs.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const han = /\p{Script=Han}/u;
const definitions = new Set(['newcommand', 'renewcommand', 'providecommand', 'newenvironment', 'renewenvironment']);
const controls = new Set(['eng', 'chin', 'pairedoriginal', 'bilingualheading', 'changeheading', 'proposalstart', 'proposalend', 'reasonlabel']);
const arity = { begin: 1, end: 1, bilingualheading: 2, changeheading: 3, proposalstart: 1,
  section: 1, subsection: 1, subsubsection: 1, paragraph: 1, caption: 1, pdfbookmark: 2,
  fancyhead: 1, newtheorem: 2 };
const verbatim = new Set(['verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted']);

// This parser never expands TeX. It only identifies balanced lexical regions of
// the supported, explicit review template. In particular it is independent of
// the source writer's conservative safety cutoff and grants no write authority.
function groupAt(source, start) {
  const open = source[start], close = open === '[' ? ']' : '}';
  if (!['[', '{'].includes(open)) return null;
  let depth = 1, braces = 0;
  for (let at = start + 1; at < source.length; at++) {
    if (source[at] === '\\') { at++; continue; }
    if (source[at] === '%') { const newline = source.indexOf('\n', at); if (newline < 0) return null; at = newline; continue; }
    if (open === '[' && source[at] === '{') { braces++; continue; }
    if (open === '[' && source[at] === '}') { if (--braces < 0) return null; continue; }
    if (braces) continue;
    if (source[at] === open) depth++;
    if (source[at] === close && --depth === 0) return { start, end: at + 1, innerStart: start + 1, innerEnd: at, inner: source.slice(start + 1, at), open };
  }
  return null;
}
function argumentsAt(source, at, count = 8) {
  const groups = [], args = [];
  while (groups.length < 12 && args.length < count) {
    let start = at;
    while (start < source.length && /[ \t\r\n]/u.test(source[start])) start++;
    if (!['{', '['].includes(source[start])) break;
    const group = groupAt(source, start);
    if (!group) throw new Error('Unbalanced command argument.');
    groups.push(group); if (group.open === '{') args.push(group);
    at = group.end;
  }
  return { groups, args, end: at };
}
function scan(source) {
  const tokens = [], opaque = [], definitionTokens = [];
  let depth = 0;
  for (let at = 0; at < source.length;) {
    const start = at;
    if (source[at] === '%') { const end = source.indexOf('\n', at); at = end < 0 ? source.length : end; opaque.push({ start, end: at, kind: 'comment' }); continue; }
    if (source[at] === '$') {
      const delimiter = source[at + 1] === '$' ? '$$' : '$'; let end = at + delimiter.length;
      for (; end < source.length; end++) { if (source[end] === '\\') { end++; continue; } if (source.startsWith(delimiter, end)) break; }
      if (end >= source.length) throw new Error('Unclosed mathematics.');
      at = end + delimiter.length; opaque.push({ start, end: at, kind: 'math' }); continue;
    }
    if (source[at] === '{') { depth++; at++; continue; }
    if (source[at] === '}') { if (--depth < 0) throw new Error('Unbalanced closing brace.'); at++; continue; }
    if (source[at] !== '\\') { at++; continue; }
    at++;
    if (['[', '('].includes(source[at])) {
      const close = source[at] === '[' ? '\\]' : '\\)'; const end = source.indexOf(close, at + 1);
      if (end < 0) throw new Error('Unclosed mathematics.');
      at = end + 2; opaque.push({ start, end: at, kind: 'math' }); continue;
    }
    if (!/[A-Za-z@]/u.test(source[at] || '')) { at++; continue; }
    const nameStart = at;
    while (/[A-Za-z@]/u.test(source[at] || '')) at++;
    const name = source.slice(nameStart, at); if (source[at] === '*') at++;
    const nameEnd = at;
    if (name === 'verb') {
      const delimiter = source[at], end = delimiter && source.indexOf(delimiter, at + 1);
      if (!delimiter || end < 0) throw new Error('Unclosed verbatim command.');
      at = end + 1; opaque.push({ start, end: at, kind: 'verbatim' }); continue;
    }
    let parsed;
    const unbracedTarget = definitions.has(name) && !name.endsWith('environment') && /^\s*(\\[A-Za-z@]+)/u.exec(source.slice(at));
    if (unbracedTarget) {
      const targetStart = at + unbracedTarget[0].indexOf('\\'), targetEnd = at + unbracedTarget[0].length;
      const target = { start: targetStart, end: targetEnd, innerStart: targetStart, innerEnd: targetEnd, inner: unbracedTarget[1], open: null };
      parsed = argumentsAt(source, targetEnd, 1); parsed.args.unshift(target); parsed.groups.unshift(target);
    } else parsed = definitions.has(name) ? argumentsAt(source, at) : argumentsAt(source, at, arity[name] || 0);
    const token = { name, start, nameEnd, end: parsed.end, args: parsed.args, groups: parsed.groups, depth };
    if (name === 'begin' && token.args[0]?.inner === 'pairedoriginal') {
      const parameter = argumentsAt(source, token.end, 1);
      token.args.push(...parameter.args); token.groups.push(...parameter.groups); token.end = parameter.end;
    }
    tokens.push(token);
    if (definitions.has(name)) { definitionTokens.push(token); at = token.end; continue; }
    if (name === 'begin' && verbatim.has(token.args[0]?.inner)) {
      const closing = `\\end{${token.args[0].inner}}`, end = source.indexOf(closing, token.end);
      if (end < 0) throw new Error('Unclosed verbatim environment.');
      opaque.push({ start: token.end, end, kind: 'verbatim' });
      tokens.push({ name: 'end', start: end, nameEnd: end + 4, end: end + closing.length, args: token.args.slice(0, 1), groups: [], depth });
      at = end + closing.length; continue;
    }
    // Arguments are deliberately visited, so nested presentation groups cannot
    // hide review markers or unmatched braces from the structural checks.
    at = nameEnd;
  }
  if (depth) throw new Error('Unbalanced opening brace.');
  const stack = [], environments = [];
  for (const token of tokens) {
    if (token.name === 'begin') stack.push(token);
    else if (token.name === 'end') {
      const begin = stack.pop();
      if (!begin || begin.args[0]?.inner !== token.args[0]?.inner) throw new Error('Unbalanced environment.');
      environments.push({ name: begin.args[0].inner, begin, end: token, start: begin.start, stop: token.end });
    }
  }
  if (stack.length) throw new Error('Unclosed environment.');
  return { tokens, opaque, definitionTokens, environments };
}
const lineAt = (source, at) => 1 + (source.slice(0, at).match(/\n/g) || []).length;
function trimRange(source, start, end) {
  while (start < end && /\s/u.test(source[start])) start++;
  while (end > start && /\s/u.test(source[end - 1])) end--;
  return { start, end };
}
function companionSlash(source, group, opaque) {
  let depth = 0, separator = -1;
  for (let at = group.innerStart; at < group.innerEnd; at++) {
    const hidden = opaque.find(range => range.start <= at && range.end > at);
    if (hidden) { at = hidden.end - 1; continue; }
    if (source[at] === '\\') { at++; continue; }
    if (source[at] === '{') depth++;
    if (source[at] === '}') depth--;
    if (source[at] === '/' && depth === 0) separator = at;
  }
  return separator;
}
function failure(code, message, line) {
  return { supported: false, changed: false, text: null, paragraphs: [], lineMap: [], diagnostics: [{ severity: 'error', code, message, ...(line ? { originalLine: line } : {}) }] };
}
function blank(text) { return text.replace(/[^\r\n]/gu, ''); }
function applyEdits(source, edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start || b.end - a.end), accepted = [];
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > source.length) throw new Error('Invalid projection range.');
    const previous = accepted.at(-1);
    if (previous && edit.start < previous.end) {
      if (edit.end <= previous.end) continue;
      throw new Error('Ambiguous overlapping projection ranges.');
    }
    if (edit.replacement?.includes('\n') || edit.replacement?.includes('\r')) throw new Error('Projection replacements must preserve line positions.');
    accepted.push(edit);
  }
  let cursor = 0, text = '';
  for (const edit of accepted) {
    text += source.slice(cursor, edit.start) + (edit.replacement || '') + blank(source.slice(edit.start, edit.end)); cursor = edit.end;
  }
  return { text: text + source.slice(cursor), edits: accepted };
}

/** Immutable English reading projection, never a source-editing adapter. */
export function deriveEnglishView(source, filePath) {
  if (typeof source !== 'string' || typeof filePath !== 'string' || !filePath || Buffer.byteLength(source) > 4 * 1024 * 1024)
    throw new TypeError('A bounded UTF-8 LaTeX source and file identity are required.');
  const identityMap = () => source.split('\n').map((_, index) => ({ originalLine: index + 1, derivedLine: index + 1, retained: true, kind: 'retained' }));
  // English sources retain their existing syntax, including constructs outside
  // this deliberately narrow template parser.
  if (!/\\(?:eng|chin|bilingualheading|changeheading|proposalstart|reasonlabel|proposalend)\b|\\begin\s*\{pairedoriginal\}/u.test(source)) {
    if (han.test(source.replace(/%[^\r\n]*/gu, ''))) return failure('UNSUPPORTED_BILINGUAL_CONTENT', 'Chinese source has no supported explicit English companion template.');
    const reading = readEnglishSourceParagraphs(source, filePath);
    return { supported: true, changed: false, text: source, paragraphs: reading.paragraphs, lineMap: identityMap(), diagnostics: reading.diagnostics };
  }
  try {
    const parsed = scan(source), { tokens, definitionTokens, environments } = parsed;
    const document = environments.find(env => env.name === 'document');
    const bodyStart = document?.begin.end || 0, bodyEnd = document?.end.start ?? source.length;
    const inBody = token => token.start >= bodyStart && token.end <= bodyEnd;
    const edits = [], paragraphs = [], covered = (start, end = start + 1) => edits.some(edit => edit.start <= start && edit.end >= end);
    const omit = (start, end, kind) => edits.push({ start, end, kind });
    const unsupportedContent = (message, at) => Object.assign(new Error(message), { projectionCode: 'UNSUPPORTED_BILINGUAL_CONTENT', originalLine: lineAt(source, at) });
    const addParagraph = (english, chinese, kind = 'paragraph', section = 'Document') => {
      const en = trimRange(source, english.start, english.end), zh = trimRange(source, chinese.start, chinese.end);
      if (en.start >= en.end || zh.start >= zh.end || !/[A-Za-z]/u.test(source.slice(en.start, en.end)) || !han.test(source.slice(zh.start, zh.end))) throw new Error('A companion pair has no unambiguous English and Chinese prose.');
      const sourceText = source.slice(en.start, en.end), translation = source.slice(zh.start, zh.end);
      const startByte = Buffer.byteLength(source.slice(0, en.start)), endByte = startByte + Buffer.byteLength(sourceText);
      const translationStartByte = Buffer.byteLength(source.slice(0, zh.start)), translationEndByte = translationStartByte + Buffer.byteLength(translation);
      const sourceHash = digest(sourceText), translationHash = digest(translation), originalLine = lineAt(source, en.start), originalEndLine = lineAt(source, en.end - 1);
      paragraphs.push({ id: `read-${digest(`${filePath}\0${startByte}\0${sourceHash}`).slice(0, 24)}`, sourcePath: filePath, path: filePath,
        startByte, endByte, sourceStartByte: startByte, sourceEndByte: endByte, source: sourceText, translation, sourceHash, translationHash,
        translationStartByte, translationEndByte, existingTranslation: { language: 'zh-CN', text: translation, startByte: translationStartByte, endByte: translationEndByte, hash: translationHash },
        originalLine, derivedLine: originalLine, originalEndLine, derivedEndLine: originalEndLine, section, kind, readOnly: true, confidence: 'explicitMarker' });
    };
    // The template controls must be literal, known definitions, never aliases or
    // redefined halfway through a paper. Other opaque user macros remain intact.
    for (const token of definitionTokens) {
      const target = token.args[0]?.inner.replace(/^\\/u, '');
      if (controls.has(target)) {
        if (token.start >= bodyStart || token.name !== (target === 'pairedoriginal' ? 'newenvironment' : 'newcommand')) throw new Error('Review controls were redefined or defined in the manuscript.');
        if (['eng', 'chin'].includes(target)) {
          const body = token.args[1]?.inner || '';
          const label = body.replace(/\\color\s*\{[^{}]*\}/gu, ' ').replace(/\\[A-Za-z@]+/gu, ' ').replace(/[{}\s]/gu, '');
          if (label !== (target === 'eng' ? 'EN' : '中') || /[#%$]/u.test(body)) throw new Error('Language marker definition is not supported.');
        }
        if (definitionTokens.some(other => other.start < token.start && other.args[0]?.inner.replace(/^\\/u, '') === target)) throw new Error('Duplicate review control definition.');
      }
      // Replace only presentation labels, retaining all mathematical definitions.
      const labels = { figurename: 'Figure', tablename: 'Table', refname: 'References', proofname: 'Proof' };
      if (labels[target] && han.test(token.args[1]?.inner || '')) edits.push({ start: token.start, end: token.end, replacement: `\\renewcommand{\\${target}}{${labels[target]}}`, kind: 'label' });
      if (target === 'abstract' && token.name === 'renewenvironment' && token.args.slice(1).some(arg => han.test(arg.inner))) edits.push({ start: token.start, end: token.end, replacement: '\\renewenvironment{abstract}{\\par\\medskip\\noindent\\textbf{Abstract}\\par}{\\par\\medskip}', kind: 'label' });
    }
    // Preamble declarations emit running heads and theorem names on later
    // pages, even when every manuscript-body companion has been removed.
    for (const token of tokens.filter(token => token.start < bodyStart)) {
      if (token.name === 'fancyhead' && token.args[0] && han.test(token.args[0].inner)) {
        const arg = token.args[0], literal = arg.inner.replace(/\\color\s*\{[^{}]*\}/gu, ' ').replace(/\\[A-Za-z@]+\*?/gu, ' ').replace(/[{}\s]/gu, '');
        if (han.test(literal[0] || '')) omit(arg.innerStart, arg.innerEnd, 'reviewRunningHead');
        else {
          const slash = companionSlash(source, arg, parsed.opaque), english = source.slice(arg.innerStart, slash);
          if (slash < 0 || han.test(english) || !/[A-Za-z]/u.test(english)) throw unsupportedContent('A running head has no supported English companion.', token.start);
          omit(slash, arg.innerEnd, 'companion');
        }
      }
      if (token.name === 'newtheorem' && token.args[1] && han.test(token.args[1].inner)) {
        const label = token.args[1], slash = companionSlash(source, label, parsed.opaque), english = source.slice(label.innerStart, slash);
        if (slash < 0 || han.test(english) || !/[A-Za-z]/u.test(english)) throw unsupportedContent('A theorem display label has no supported English companion.', token.start);
        omit(slash, label.innerEnd, 'companion');
      }
    }
    const bodyTokens = tokens.filter(inBody);
    if (bodyTokens.some(token => ['catcode', 'mathcode', 'lccode', 'uccode', 'csname', 'endcsname'].includes(token.name))) throw new Error('Dynamic lexical syntax is not supported for an English projection.');
    for (const token of bodyTokens.filter(token => ['def', 'edef', 'gdef', 'xdef', 'let', 'futurelet'].includes(token.name))) {
      const next = /^\s*\\([A-Za-z@]+)/u.exec(source.slice(token.nameEnd));
      if (controls.has(next?.[1])) throw new Error('Review control alias or redefinition is not supported.');
    }
    // Pending blocks can contain arbitrary nested prose and math. Their complete
    // balanced interval is omitted before original reading pairs are selected.
    let pending = null;
    for (const token of bodyTokens) {
      if (token.name === 'proposalstart') { if (pending) throw new Error('Nested pending proposal blocks are ambiguous.'); pending = token; }
      if (token.name === 'reasonlabel' && !pending) throw new Error('A reason is outside a pending proposal block.');
      if (token.name === 'proposalend') {
        if (!pending || token.depth !== pending.depth) throw new Error('A pending proposal block is unbalanced.');
        omit(pending.start, token.end, 'pending'); pending = null;
      }
    }
    if (pending) throw new Error('A pending proposal block is incomplete.');
    for (const env of environments.filter(env => env.name === 'titlepage' && env.start >= bodyStart)) omit(env.start, env.stop, 'reviewCover');
    for (const match of source.slice(bodyStart, bodyEnd).matchAll(/\{\\small\s*\\color\s*\{Muted\}\s*(?:式内文字\s*\/\s*Wording in the equation|列名\s*\/\s*Column labels):/gu)) {
      const start = bodyStart + match.index, group = groupAt(source, start);
      if (!group) throw new Error('A translation glossary note is unbalanced.');
      if (!covered(start, group.end)) omit(start, group.end, 'translationGloss');
    }
    for (const token of bodyTokens) if (['changeheading', 'pdfbookmark'].includes(token.name) && !covered(token.start)) omit(token.start, token.end, 'reviewDecoration');
    let section = 'Document';
    for (const token of bodyTokens) {
      if (covered(token.start)) continue;
      if (token.name === 'bilingualheading') {
        if (token.args.length !== 2 || han.test(token.args[0].inner) || !han.test(token.args[1].inner)) throw new Error('Bilingual heading order is unsupported.');
        section = token.args[0].inner;
        addParagraph({ start: token.args[0].innerStart, end: token.args[0].innerEnd }, { start: token.args[1].innerStart, end: token.args[1].innerEnd }, 'heading', section);
        edits.push({ start: token.start, end: token.nameEnd, replacement: '\\section*', kind: 'heading' });
        omit(token.args[1].start, token.args[1].end, 'companion');
      }
      if (['section', 'subsection', 'subsubsection', 'paragraph'].includes(token.name) && token.args[0] && han.test(token.args[0].inner)) {
        const arg = token.args[0], slash = companionSlash(source, arg, parsed.opaque);
        if (slash < 0 || han.test(source.slice(arg.innerStart, slash)) || !/[A-Za-z]/u.test(source.slice(arg.innerStart, slash))) throw new Error('A bilingual section heading is not English first.');
        section = source.slice(arg.innerStart, slash).trim();
        addParagraph({ start: arg.innerStart, end: slash }, { start: slash + 1, end: arg.innerEnd }, 'heading', section);
        omit(slash, arg.innerEnd, 'companion');
      }
    }
    for (const env of environments.filter(env => ['theorem', 'lemma', 'proposition', 'corollary', 'definition', 'remark', 'proof'].includes(env.name) && !covered(env.start))) {
      let optionStart = env.begin.end;
      while (/\s/u.test(source[optionStart] || '') && optionStart < env.end.start) optionStart++;
      if (source[optionStart] !== '[') continue;
      const option = groupAt(source, optionStart);
      if (!option || !han.test(option.inner)) continue;
      const slash = companionSlash(source, option, parsed.opaque);
      if (slash < 0 || han.test(source.slice(option.innerStart, slash))) throw new Error('A theorem heading is not English first.');
      addParagraph({ start: option.innerStart, end: slash }, { start: slash + 1, end: option.innerEnd }, 'heading');
      omit(slash, option.innerEnd, 'companion');
    }
    for (const env of environments.filter(env => env.name === 'pairedoriginal' && !covered(env.start, env.stop))) {
      const markers = bodyTokens.filter(token => ['eng', 'chin'].includes(token.name) && token.start >= env.begin.end && token.end <= env.end.start);
      if (markers.length !== 2 || markers[0].name !== 'eng' || markers[1].name !== 'chin' || markers.some(token => token.depth !== env.begin.depth)) throw new Error('Original bilingual paragraph markers are ambiguous.');
      const [en, zh] = markers;
      const separators = bodyTokens.filter(token => token.name === 'par' && token.start >= en.end && token.end <= zh.start && token.depth === en.depth);
      const separator = separators.at(-1);
      if (!separator || source.slice(separator.end, zh.start).trim()) throw new Error('An original English paragraph has no explicit companion separator.');
      let zhEnd = trimRange(source, zh.end, env.end.start).end;
      const trailing = bodyTokens.findLast(token => token.name === 'par' && token.start >= zh.end && token.end === zhEnd && token.depth === zh.depth);
      if (trailing) zhEnd = trimRange(source, zh.end, trailing.start).end;
      const heading = paragraphs.findLast(item => item.kind === 'heading' && item.originalLine < lineAt(source, en.start));
      addParagraph({ start: en.end, end: separator.start }, { start: zh.end, end: zhEnd }, 'paragraph', heading?.section || 'Document');
      omit(env.begin.start, env.begin.end, 'wrapper'); omit(en.start, en.end, 'marker');
      omit(zh.start, env.end.start, 'companion'); omit(env.end.start, env.end.end, 'wrapper');
    }
    // Captions use an explicit paragraph-plus-Chinese label, rather than EN/中.
    for (const token of bodyTokens.filter(token => token.name === 'caption' && token.args[0] && !covered(token.start))) {
      const arg = token.args[0]; if (!han.test(arg.inner)) continue;
      for (const option of token.groups.filter(group => group.open === '[' && han.test(group.inner))) {
        const slash = companionSlash(source, option, parsed.opaque), english = source.slice(option.innerStart, slash);
        if (slash < 0 || han.test(english) || !/[A-Za-z]/u.test(english) || /[\r\n]|\\par\b/u.test(option.inner)) throw new Error('A short caption has no supported single-line English companion.');
        // Retain the English optional argument. Hyperref/nameref otherwise read
        // the full long caption, whose original paragraph breaks are meaningful.
        omit(slash, option.innerEnd, 'companion');
      }
      const separator = bodyTokens.find(item => item.name === 'par' && item.start >= arg.innerStart && item.end <= arg.innerEnd && han.test(source.slice(item.end, arg.innerEnd)));
      if (!separator || han.test(source.slice(arg.innerStart, separator.start))) throw new Error('A bilingual caption has no explicit English-first separator.');
      let translationStart = separator.end;
      const prefix = /^\s*(?:\\(?:small|smallskip)\s*)?(?:\\textbf\s*\{中文(?:图注)?[：:]\}|中文(?:图注)?[：:])/u.exec(source.slice(translationStart, arg.innerEnd));
      if (!prefix) throw new Error('The Chinese caption label is unsupported.');
      translationStart += prefix[0].length;
      addParagraph({ start: arg.innerStart, end: separator.start }, { start: translationStart, end: arg.innerEnd }, 'caption');
      omit(separator.start, arg.innerEnd, 'companion');
    }
    // Known title/author blocks use separate Chinese lines and English/中文
    // names. Only visible Han prose is pruned; braces, commands, and mathematics
    // remain untouched, then balanced syntax and residual content are checked.
    for (const env of environments.filter(env => env.name === 'center' && !covered(env.start, env.stop))) {
      const raw = source.slice(env.begin.end, env.end.start); if (!han.test(raw)) continue;
      let cursor = env.begin.end;
      for (const line of raw.split(/(?<=\n)/u)) {
        const lineEnd = cursor + line.length;
        const visible = line.replace(/\\[A-Za-z@]+\*?/gu, '').replace(/\$[^$]*\$/gu, '').replace(/[{}0-9^_*.,，。；;：:!?！？/\s]/gu, '');
        const groupStart = cursor + line.length - line.trimStart().length;
        const headingGroup = source[groupStart] === '{' ? groupAt(source, groupStart) : null;
        if (han.test(visible[0] || '') && headingGroup && headingGroup.end <= lineEnd
          && /^\s*(?:\\(?:par|medskip|bigskip|smallskip)\s*)*$/u.test(source.slice(headingGroup.end, lineEnd))) {
          omit(groupStart, lineEnd, 'frontmatterCompanion');
        } else if (han.test(line) && !/[A-Za-z]/u.test(visible)) {
          // Retain lexical syntax, remove literal text and harmless punctuation.
          for (const match of line.matchAll(/[\p{Script=Han}，。；：、（）“”‘’—–]+/gu)) omit(cursor + match.index, cursor + match.index + match[0].length, 'frontmatterCompanion');
        } else if (han.test(line)) {
          for (const match of line.matchAll(/\s*\/\s*[\p{Script=Han}，。；：、（）“”‘’—–\s]+/gu)) omit(cursor + match.index, cursor + match.index + match[0].length, 'frontmatterCompanion');
        }
        cursor = lineEnd;
      }
    }
    for (const token of bodyTokens.filter(token => ['eng', 'chin', 'proposalstart', 'proposalend', 'reasonlabel'].includes(token.name))) if (!covered(token.start, token.end)) throw new Error('An orphaned bilingual or pending marker remains.');
    const projection = applyEdits(source, edits), projected = scan(projection.text);
    // Only the supported, unused review definitions may retain inert Chinese.
    // Unknown preamble emitters and indirect aliases must not silently acquire
    // an English-only label just because their literals sit before document.
    const inertNames = new Set(['chin', 'revmark', 'revnote', 'changeheading', 'proposalstart', 'proposalend', 'reasonlabel']);
    const inertDefinitions = projected.definitionTokens.filter(token => {
      if (!token.args.slice(1).some(arg => han.test(arg.inner))) return false;
      const target = token.args[0]?.inner.replace(/^\\/u, '');
      if (!inertNames.has(target)) return false;
      if (projected.tokens.some(other => other !== token && other.name === target)) return false;
      const reference = new RegExp(`\\\\${target}\\b`, 'u');
      return !projected.definitionTokens.some(other => other !== token && other.args.slice(1).some(arg => reference.test(arg.inner)));
    });
    for (let at = 0; at < projection.text.length; at++) {
      if (!han.test(projection.text[at])) continue;
      if (projected.opaque.some(range => range.kind === 'comment' && range.start <= at && range.end > at)) continue;
      if (inertDefinitions.some(token => token.start <= at && token.end > at)) continue;
      throw unsupportedContent('Chinese content remains outside a supported companion or an unused review definition.', at);
    }
    paragraphs.sort((a, b) => a.startByte - b.startByte);
    const sourceLines = source.split('\n'), derivedLines = projection.text.split('\n');
    if (sourceLines.length !== derivedLines.length) throw new Error('Projection line identity was not preserved.');
    const lineMap = sourceLines.map((line, index) => ({ originalLine: index + 1, derivedLine: index + 1, retained: !line.trim() || Boolean(derivedLines[index].trim()), kind: line.trim() && !derivedLines[index].trim() ? 'omitted' : 'retained' }));
    return { supported: true, changed: projection.text !== source, text: projection.text, paragraphs, lineMap, diagnostics: [] };
  } catch (error) {
    return failure(error.projectionCode || 'UNSUPPORTED_REVIEW_TEMPLATE', error.message, error.originalLine);
  }
}
