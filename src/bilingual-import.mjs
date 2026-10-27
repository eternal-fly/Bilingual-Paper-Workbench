import { commands, extractSegments, sha256 } from './latex.mjs';

// This adapter only narrows already-safe source ranges. It never expands a macro.
function languageDefinitions(source) {
  const changes = [];
  for (const command of commands(source)) {
    if (!['newcommand', 'renewcommand', 'providecommand'].includes(command.name)) continue;
    const name = /^\\([A-Za-z]+)$/.exec(command.args[0] || '')?.[1]
      || /^\s*\\([A-Za-z]+)/.exec(source.slice(command.end))?.[1];
    if (!name) continue;
    const shape = command.args.length === 2 && (command.groups.length === 2 || (command.groups.length === 3 && source[command.groups[1].start] === '[' && command.groups[1].inner === '0'));
    let label = null;
    if (command.name === 'newcommand' && shape && source[command.groups[0].start] === '{') {
      const body = command.args[1];
      if (body.length <= 512 && !/[#$%]/.test(body)) {
        // Parent safety is independently re-derived below. Removing presentation syntax
        // here only determines whether the preserved marker's literal label is EN/中.
        const literal = body.replace(/\\color\s*\{[A-Za-z][A-Za-z0-9_-]{0,63}\}/g, ' ')
          .replace(/\\[A-Za-z]+/g, ' ').replace(/[{}\s]/gu, '');
        if (literal === 'EN') label = 'en';
        if (literal === '中') label = 'zh-CN';
      }
    }
    changes.push({ name, label, end: command.end });
  }
  return changes;
}
function definitionAt(changes, name, position) {
  let label = null;
  for (const change of changes) if (change.name === name && change.end <= position) label = change.label;
  return label;
}
function braceDelta(raw) {
  if (raw.startsWith('%') || raw.startsWith('$') || raw.startsWith('\\(') || raw.startsWith('\\[')) return 0;
  let balance = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\') {
      if (!/[A-Za-z@]/.test(raw[i + 1] || '')) { i++; continue; }
      while (/[A-Za-z@]/.test(raw[i + 1] || '')) i++;
      continue;
    }
    if (raw[i] === '{') balance++;
    if (raw[i] === '}') balance--;
  }
  return balance;
}
function tokenRanges(raw, tokens) {
  const ranges = []; let cursor = 0, depth = 0;
  for (const token of tokens) {
    const start = raw.indexOf(token.raw, cursor);
    if (start < 0 || !token.raw) return null;
    depth += braceDelta(raw.slice(cursor, start));
    if (depth < 0) return null;
    ranges.push({ raw: token.raw, start, end: start + token.raw.length, depth, name: /^\\([A-Za-z]+)/.exec(token.raw)?.[1] });
    depth += braceDelta(token.raw); if (depth < 0) return null;
    cursor = start + token.raw.length;
  }
  if (depth + braceDelta(raw.slice(cursor)) !== 0) return null;
  return ranges;
}
function trimStart(raw, start, end) { while (start < end && /\s/u.test(raw[start])) start++; return start; }
function trimEnd(raw, start, end) { while (end > start && /\s/u.test(raw[end - 1])) end--; return end; }
function bodyEnd(raw, start, limit, controls) {
  let end = trimEnd(raw, start, limit);
  for (;;) {
    const token = controls.findLast(item => item.depth === 0 && item.start >= start && item.end === end);
    if (!token || !((token.name === 'par' && token.raw === '\\par') || token.name === 'end')) return end;
    end = trimEnd(raw, start, token.start);
  }
}
function prose(raw, start, end, controls) {
  let cursor = start, text = '';
  for (const token of controls) {
    if (token.end <= start || token.start >= end) continue;
    if (token.start > cursor) text += raw.slice(cursor, Math.min(token.start, end));
    cursor = Math.max(cursor, token.end);
  }
  if (cursor < end) text += raw.slice(cursor, end);
  return text;
}

/**
 * Derive explicit EN/Chinese companion pairs inside one proven-safe parent block.
 * Cross-block alignment, repeated labels and uncertain boundaries remain unpaired.
 * Supplying previous segments preserves matching IDs, never trusts their safety flag.
 */
export function extractBilingualPairs(source, filePath, previousSegments = []) {
  if (typeof source !== 'string' || typeof filePath !== 'string' || Buffer.byteLength(source) > 4 * 1024 * 1024) throw new TypeError('A bounded UTF-8 LaTeX source and relative file identity are required.');
  const definitions = languageDefinitions(source), bytes = Buffer.from(source), pairs = [];
  const parents = extractSegments(source, filePath, previousSegments);
  for (const parent of parents) {
    if (!parent.translatable) continue;
    const raw = bytes.subarray(parent.startByte, parent.endByte).toString('utf8');
    if (raw !== parent.source || sha256(raw) !== parent.beforeHash) continue;
    const controls = tokenRanges(raw, parent.protectedTokens); if (!controls) continue;
    const charStart = bytes.subarray(0, parent.startByte).toString('utf8').length;
    const markers = controls.filter(token => token.depth === 0 && token.name && token.raw === `\\${token.name}`)
      .map(token => ({ ...token, label: definitionAt(definitions, token.name, charStart + token.start) })).filter(token => token.label);
    if (!markers.length || markers.length % 2 || markers.some((token, index) => token.label !== (index % 2 ? 'zh-CN' : 'en'))) continue;
    const pending = []; let valid = true;
    for (let index = 0; index < markers.length; index += 2) {
      const en = markers[index], zh = markers[index + 1], next = markers[index + 2];
      const separator = controls.findLast(token => token.depth === 0 && token.raw === '\\par' && token.end <= zh.start && !raw.slice(token.end, zh.start).trim());
      if (!separator || separator.start < en.end) { valid = false; break; }
      const enStart = trimStart(raw, en.end, separator.start), enEnd = trimEnd(raw, enStart, separator.start);
      const zhStart = trimStart(raw, zh.end, next?.start ?? raw.length), zhEnd = bodyEnd(raw, zhStart, next?.start ?? raw.length, controls);
      if (next) {
        const trailing = controls.findLast(token => token.depth === 0 && token.raw === '\\par' && token.end <= next.start && !raw.slice(token.end, next.start).trim());
        if (!trailing || trailing.start < zhStart) { valid = false; break; }
      }
      if (enStart >= enEnd || zhStart >= zhEnd || !/\p{Script=Latin}/u.test(prose(raw, enStart, enEnd, controls)) || !/\p{Script=Han}/u.test(prose(raw, zhStart, zhEnd, controls))) { valid = false; break; }
      const sourceText = raw.slice(enStart, enEnd), translation = raw.slice(zhStart, zhEnd);
      const startByte = parent.startByte + Buffer.byteLength(raw.slice(0, enStart)), endByte = startByte + Buffer.byteLength(sourceText);
      const translationStart = parent.startByte + Buffer.byteLength(raw.slice(0, zhStart)), translationEnd = translationStart + Buffer.byteLength(translation);
      pending.push({ schemaVersion: 1, pairId: `pair-${sha256(`${filePath}\0${startByte}\0${translationStart}\0${sha256(sourceText)}`).slice(0, 24)}`, parentSegmentId: parent.id, path: filePath,
        source: sourceText, sourceStartByte: startByte, sourceEndByte: endByte, sourceHash: sha256(sourceText), sourceLanguage: 'en',
        existingTranslation: { language: 'zh-CN', text: translation, startByte: translationStart, endByte: translationEnd, hash: sha256(translation) },
        markers: { sourceName: en.name, translationName: zh.name }, confidence: 'explicitMarker' });
    }
    if (valid) pairs.push(...pending);
  }
  return pairs;
}
