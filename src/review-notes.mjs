import { createHash } from 'node:crypto';
import { REVIEW_IMPORT_LIMITS } from './review-limits.mjs';
import { MODEL_TOOL_BYTES, REGISTERED_REQUEST_BYTES } from './request-budgets.mjs';

const MODEL_OUTPUT_LIMITS = Object.freeze({ textBytes: 64 * 1024, bodyBytes: 16 * 1024, recommendationBytes: 16 * 1024 });
const BILINGUAL_FIELDS = Object.freeze(['suggestedSource', 'suggestedTranslation', 'reasonSource', 'reasonTranslation']);
const CURRENT_FIELDS = Object.freeze(['currentSource', 'currentTranslation']);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value);
function strict(value, keys) { if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) fail('INVALID_REVIEW', 'Review data contains unsupported fields.'); }
function text(value, label, max, required = true) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail('INVALID_REVIEW', `${label} must be bounded plain text.`);
  const result = value.replace(/^\ufeff/u, '').replace(/\r\n?/gu, '\n').trim();
  if (required && !result) fail('INVALID_REVIEW', `${label} cannot be empty.`);
  return result;
}

// These are matching surfaces, never source replacements. Reading paragraph IDs
// come from the current application state, not from an uploaded ordinal or path.
function anchorIndex(state) {
  if (!object(state) || !identifier(state.project?.snapshotId)) fail('INVALID_REVIEW', 'An active source snapshot is required.');
  const entries = new Map();
  for (const segment of state.segments || []) if (identifier(segment.id) && digest(segment.beforeHash || segment.sourceHash)) entries.set(segment.id, { hash: segment.beforeHash || segment.sourceHash, surfaces: new Set([segment.source, segment.displayText, segment.visibleText].filter(value => typeof value === 'string' && value.length)) });
  const mappings = new Map();
  for (const paragraph of state.readingParagraphs || []) {
    if (!identifier(paragraph.id)) continue;
    const sourceHash = paragraph.beforeHash || paragraph.sourceHash;
    if (digest(sourceHash)) {
      entries.set(paragraph.id, { hash: sourceHash, surfaces: new Set([paragraph.source, paragraph.displayText, paragraph.english, paragraph.translation, paragraph.originalCN].filter(value => typeof value === 'string' && value.length)) });
      mappings.set(paragraph.id, [paragraph.id]);
    } else if (Array.isArray(paragraph.sourceSegmentIds) && paragraph.sourceSegmentIds.length && paragraph.sourceSegmentIds.every(id => entries.has(id))) {
      mappings.set(paragraph.id, [...paragraph.sourceSegmentIds]);
      for (const id of paragraph.sourceSegmentIds) for (const value of [paragraph.source, paragraph.displayText, paragraph.english, paragraph.translation, paragraph.originalCN]) if (typeof value === 'string' && value.length) entries.get(id).surfaces.add(value);
    }
  }
  for (const [id, original] of Object.entries(state.originals || {})) if (entries.has(id) && (!original.sourceHash || original.sourceHash === entries.get(id).hash)) for (const value of [original.translation, original.originalCN]) if (typeof value === 'string' && value.length) entries.get(id).surfaces.add(value);
  for (const drafts of Object.values(state.translations || {})) for (const [id, draft] of Object.entries(drafts || {})) {
    const ids = mappings.get(id) || (entries.has(id) ? [id] : draft.sourceSegmentIds);
    if (!Array.isArray(ids) || !ids.length || draft.status === 'stale' || ids.some(key => !entries.has(key) || draft.sourceHashes?.[key] && draft.sourceHashes[key] !== entries.get(key).hash) || ids.length === 1 && draft.sourceHash && draft.sourceHash !== entries.get(ids[0]).hash) continue;
    if (typeof draft.text === 'string' && draft.text.length) for (const key of ids) entries.get(key).surfaces.add(draft.text);
  }
  // A derived whole paragraph can overlap a parser segment. The paragraph is
  // the reading namespace for that area; do not manufacture duplicate matches.
  for (const paragraph of state.readingParagraphs || []) if (entries.has(paragraph.id) && digest(paragraph.beforeHash || paragraph.sourceHash)) for (const id of paragraph.canonicalSegmentIds || []) if (id !== paragraph.id && !(state.readingParagraphs || []).some(item => item.id === id)) entries.delete(id);
  return { entries, mappings, snapshotId: state.project.snapshotId };
}
function quoted(body) {
  // Long imported opinions retain their full body and can supply an explicit
  // quote. Automatic inference is optional and stays inside the original small
  // matching budget, without retrying a long span for every opening delimiter.
  if (body.length > 64 * 1024) return null;
  const endings = new Uint32Array(body.length), characters = new Uint32Array(body.length + 1);
  for (let at = 0; at < body.length; at++) {
    const code = body.charCodeAt(at), previous = body.charCodeAt(at - 1);
    characters[at + 1] = characters[at] + (code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff ? 0 : 1);
  }
  let curly = -1, straight = -1;
  for (let at = body.length - 1; at >= 0; at--) {
    const character = body[at];
    if (character === '\n') { curly = -1; straight = -1; }
    else if (character === '”' || character === '」') curly = at;
    else if (character === '“' || character === '「') endings[at] = curly + 1;
    else if (character === '"') { endings[at] = straight + 1; straight = at; }
  }
  let value = null;
  for (let at = 0; at < body.length; at++) {
    if (!endings[at]) continue;
    const end = endings[at] - 1, length = characters[end] - characters[at + 1];
    if (length < 4 || length > 4096) continue;
    if (value !== null) return null;
    value = body.slice(at + 1, end); at = end;
  }
  return value;
}
function anchor(note, index) {
  if (note.sourceSnapshotId !== undefined && note.sourceSnapshotId !== index.snapshotId) fail('INVALID_REVIEW_ANCHOR', 'Review refers to a different source snapshot.');
  if (note.segmentId !== undefined && note.sourceSegmentIds !== undefined) fail('INVALID_REVIEW_ANCHOR', 'Review must use one explicit source ID namespace field.');
  const explicit = note.sourceSegmentIds ?? (note.segmentId ? [note.segmentId] : undefined);
  let requested;
  if (explicit !== undefined) {
    if (!Array.isArray(explicit) || new Set(explicit).size !== explicit.length || explicit.some(id => !identifier(id) || !index.entries.has(id) && !index.mappings.has(id))) fail('INVALID_REVIEW_ANCHOR', 'Review contains unknown or invalid current source IDs.');
    requested = [...new Set(explicit.flatMap(id => index.mappings.get(id) || [id]))];
    if (requested.some(id => !index.entries.has(id))) fail('INVALID_REVIEW_ANCHOR', 'Review source mapping is no longer active.');
  }
  if (note.sourceHashes !== undefined) {
    if (!object(note.sourceHashes) || Object.entries(note.sourceHashes).some(([id, value]) => !index.entries.has(id) || !digest(value) || value !== index.entries.get(id).hash)) fail('INVALID_REVIEW_ANCHOR', 'Review source hashes do not match the active snapshot.');
  }
  // A four-field note's body is its rationale, which may quote terminology or
  // equations without quoting the passage being revised. Only an explicit
  // original-source excerpt may anchor this format; legacy opinions retain
  // their existing optional quote inference.
  const quote = note.quote === undefined ? BILINGUAL_FIELDS.some(key => Object.hasOwn(note, key)) ? null : quoted(note.body) : text(note.quote, 'Quote', 8192);
  if (!quote) return { sourceSegmentIds: [], sourceHashes: {}, anchorConfidence: 'unanchored', ...(requested?.length ? { candidates: requested } : {}) };
  const matches = [];
  for (const [id, entry] of index.entries) {
    const counts = [...entry.surfaces].map(surface => { let count = 0, offset = 0; while ((offset = surface.indexOf(quote, offset)) !== -1) { count++; offset += quote.length; } return count; });
    if (counts.some(count => count > 0)) matches.push({ id, repeated: counts.some(count => count > 1) });
  }
  if (requested?.length && (!matches.length || requested.some(id => !matches.some(match => match.id === id)))) fail('INVALID_REVIEW_ANCHOR', 'The exact quote does not occur in every referenced current source segment.');
  if (matches.length === 1 && !matches[0].repeated) {
    const id = matches[0].id;
    return { quote, sourceSegmentIds: [id], sourceHashes: { [id]: index.entries.get(id).hash }, anchorConfidence: 'exactQuote' };
  }
  return { quote, sourceSegmentIds: [], sourceHashes: {}, anchorConfidence: matches.length ? 'ambiguous' : 'unanchored', ...(matches.length ? { candidates: matches.map(match => match.id) } : {}) };
}

export const createReviewNoteAnchorIndex = anchorIndex;
export function normalizeModelNotes(notes, state, { batchId, origin = 'codex', trustedPdfOutput = false, assembledOutput = false, anchorContext = null } = {}) {
  const external = origin === 'external', maxBytes = external ? REVIEW_IMPORT_LIMITS.textBytes : assembledOutput ? REGISTERED_REQUEST_BYTES : trustedPdfOutput ? MODEL_TOOL_BYTES : MODEL_OUTPUT_LIMITS.textBytes;
  if (!identifier(batchId) || !['external', 'codex', 'model'].includes(origin) || !Array.isArray(notes)) fail('INVALID_REVIEW', 'A review batch needs a valid byte-bounded note array.');
  let total = 0;
  const index = anchorContext || anchorIndex(state);
  return notes.map((input, position) => {
    strict(input, ['title', 'body', 'recommendation', 'quote', 'sourceSegmentIds', 'segmentId', 'sourceSnapshotId', 'sourceHashes', 'page', 'category', 'severity', 'reviewCode', 'scope', ...BILINGUAL_FIELDS, ...CURRENT_FIELDS]);
    const bilingual = BILINGUAL_FIELDS.some(key => Object.hasOwn(input, key)) ? Object.fromEntries(BILINGUAL_FIELDS.map(key => [key, text(input[key], key, external ? maxBytes : MODEL_OUTPUT_LIMITS.bodyBytes)])) : null;
    const current = CURRENT_FIELDS.some(key => Object.hasOwn(input, key)) ? Object.fromEntries(CURRENT_FIELDS.map(key => [key, text(input[key], key, external ? maxBytes : MODEL_OUTPUT_LIMITS.bodyBytes)])) : null;
    if (input.scope !== undefined && !['paragraph', 'sentence', 'note'].includes(input.scope) || input.scope === 'paragraph' && (!current || !bilingual)) fail('INVALID_REVIEW', 'A paragraph opinion needs complete current and recommended bilingual text.');
    const reviewCode = input.reviewCode === undefined ? undefined : text(input.reviewCode, 'Review code', 160);
    const body = text(input.body === undefined ? bilingual?.reasonTranslation : input.body, 'Review body', external ? maxBytes : MODEL_OUTPUT_LIMITS.bodyBytes), firstLineEnd = body.indexOf('\n');
    const title = input.title === undefined ? body.slice(0, Math.min(firstLineEnd < 0 ? body.length : firstLineEnd, 120)) : text(input.title, 'Review title', 1024);
    const recommendationInput = input.recommendation === undefined ? bilingual?.suggestedTranslation : input.recommendation;
    const recommendation = recommendationInput === undefined ? undefined : text(recommendationInput, 'Recommendation', external ? maxBytes : MODEL_OUTPUT_LIMITS.recommendationBytes);
    if (bilingual && (body !== bilingual.reasonTranslation || recommendation !== bilingual.suggestedTranslation)) fail('INVALID_REVIEW', 'Bilingual review content conflicts with its legacy display fields.');
    const quote = input.quote === undefined ? undefined : text(input.quote, 'Quote', 8192);
    const normalized = { ...input, body, title, ...(quote !== undefined ? { quote } : {}) };
    total += Buffer.byteLength(body) + (external && input.title === undefined ? 0 : Buffer.byteLength(title)) + Buffer.byteLength(recommendation || '') + Buffer.byteLength(quote || '') + Buffer.byteLength(reviewCode || '') + [...BILINGUAL_FIELDS, ...CURRENT_FIELDS].reduce((sum, key) => sum + Buffer.byteLength(bilingual?.[key] || current?.[key] || ''), 0);
    if (total > maxBytes) fail('REVIEW_TOO_LARGE', `Normalized review opinions exceed the ${maxBytes} byte limit.`);
    if (input.page !== undefined && (!Number.isSafeInteger(input.page) || input.page < 1 || input.page > REVIEW_IMPORT_LIMITS.pdfPages)) fail('INVALID_REVIEW', `Review page must be between one and ${REVIEW_IMPORT_LIMITS.pdfPages}.`);
    if (input.category !== undefined) text(input.category, 'Category', 160);
    if (input.severity !== undefined && !['low', 'medium', 'high', 'critical'].includes(input.severity)) fail('INVALID_REVIEW', 'Unknown review severity.');
    return { noteId: `note-${hash(JSON.stringify([batchId, position, normalized])).slice(0, 32)}`, batchId, origin, title, body, ...(recommendation ? { recommendation } : {}), ...(bilingual || {}), ...(current || {}), ...(origin === 'external' && current ? { currentContextProvenance: 'external-review-context' } : {}), ...(input.scope ? { scope: input.scope } : {}), ...(reviewCode ? { reviewCode } : {}), ...anchor(normalized, index), sourceSnapshotId: index.snapshotId, status: 'open', revision: 1,
      ...(input.page !== undefined ? { page: input.page } : {}), ...(input.category !== undefined ? { category: input.category } : {}), ...(input.severity !== undefined ? { severity: input.severity } : {}) };
  });
}

function externalParagraphs(content) {
  // Scan boundaries without constructing an array for every line of a large
  // document. Numbered points keep their continuation lines intact.
  const result = []; let cursor = 0;
  const push = value => { const body = value.trim(); if (body) result.push(body); };
  const boundaries = /\n[\t ]*\n(?:[\t ]*\n)*|\n(?=[\t ]{0,3}(?:(?:\d+|[一二三四五六七八九十百]+)[.)、．]\s*|[-*•]\s+|(?:意见|建议|Comment|Concern|Point)\s*\d+\s*[:：.)、]))/giu;
  for (const match of content.matchAll(boundaries)) { push(content.slice(cursor, match.index)); cursor = match.index + match[0].length; }
  push(content.slice(cursor));
  return result;
}

function uniqueLiteralEntry(quote, index) {
  let matched;
  for (const [id, entry] of index.entries) {
    let occurs = false;
    for (const surface of entry.surfaces) {
      const at = surface.indexOf(quote);
      if (at < 0) continue;
      if (surface.indexOf(quote, at + quote.length) >= 0) return null;
      occurs = true;
    }
    if (occurs) { if (matched !== undefined) return null; matched = id; }
  }
  return matched ?? null;
}
function bilingualLiteralExcerpt(original, index) {
  if (!original || !index.entries.size) return null;
  const whole = original.replace(/\s+/gu, ' ').trim();
  if (Buffer.byteLength(whole) <= 8192 && uniqueLiteralEntry(whole, index)) return whole;
  // PDF wrapping and mathematical glyphs can prevent a whole-paragraph exact
  // match. Search only continuous plain-English windows from CURRENT, with a
  // substantial minimum length. Every chosen quote must itself be a unique
  // literal substring of the current matching surface. No source text is
  // rewritten or fuzzy-matched, and separate matching source IDs invalidate
  // the fallback instead of selecting a likely paragraph.
  const matches = new Map(); let attempts = 0;
  for (const run of whole.slice(0, 8192).matchAll(/[A-Za-z][A-Za-z ,;:.!?'"‘’“”()\-–—]*/gu)) {
    const words = [...run[0].matchAll(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/gu)];
    for (let start = 0; start < words.length && attempts < 128; start++) {
      let end = start, letters = 0;
      while (end < words.length && end - start < 12 && letters < 64) { letters += words[end][0].replace(/[^A-Za-z]/gu, '').length; end++; }
      if (end - start < 12 && letters < 64) continue;
      attempts++;
      const last = words[end - 1], candidate = run[0].slice(words[start].index, last.index + last[0].length), id = uniqueLiteralEntry(candidate, index);
      if (id) { if (!matches.has(id)) matches.set(id, candidate); if (matches.size > 1) return null; }
    }
    if (attempts >= 128) break;
  }
  return matches.size === 1 ? matches.values().next().value : null;
}
function bilingualRevisionNotes(content, state) {
  // This declared review-package format contains an entire manuscript. Its
  // ordinary paragraphs are context, never implicit review opinions. Once the
  // cover identifies the format, malformed blocks must not fall back to the
  // generic paragraph importer and turn the manuscript into hundreds of notes.
  if (!/Full\s+bilingual\s+manuscript\s+with\s+proposed\s+revisions/iu.test(content)) return null;
  const invalid = () => fail('INVALID_REVIEW_STRUCTURE', 'The bilingual review package has incomplete, duplicate or inconsistent proposal sections; no opinions were imported.');
  const declared = [...content.slice(0, 8192).matchAll(/(\d+)\s*项建议/gu)].map(match => Number(match[1]));
  if (!declared.length || new Set(declared).size !== 1 || !Number.isSafeInteger(declared[0]) || declared[0] < 1) invalid();
  // Strip only the known running-header shape and the page footer directly
  // paired with it. Standalone numbers inside mathematics remain untouched.
  const header = '[^\\n]{1,300}中英合并审阅[\\t ]*[·・][\\t ]*待确认[\\t ]*';
  const clean = content.replace(new RegExp('\\n[\\t ]*\\d{1,4}[\\t ]*\\n(?:[\\t ]*\\n)*' + header + '(?:\\n|$)', 'gu'), '\n').replace(new RegExp('(?:^|\\n)' + header + '(?:\\n|$)', 'gu'), '\n');
  const proposed = [...clean.matchAll(/\[([A-Z]\d{2,})\]\s*建议改写\s*\/\s*RECOMMENDED\s*\(pending\)/gu)];
  const reasons = [...clean.matchAll(/修改理由\s*\/\s*REASON/gu)], decisions = [...clean.matchAll(/你的决定\s*\/\s*Decision\s*[:：]/gu)];
  if (proposed.length !== declared[0] || new Set(proposed.map(match => match[1])).size !== proposed.length || reasons.length !== proposed.length || decisions.length !== proposed.length) invalid();
  const index = anchorIndex(state);
  const languages = value => {
    const match = value.trim().match(/^EN[\t ]+([\s\S]+?)\n[\t ]*中[\t ]+([\s\S]+)$/u);
    return match && match[1].trim() && match[2].trim() ? { source: match[1].trim(), translation: match[2].trim() } : null;
  };
  return proposed.map((proposal, position) => {
    const reason = reasons[position], decision = decisions[position], next = proposed[position + 1]?.index ?? clean.length;
    if (!(proposal.index < reason.index && reason.index < decision.index && decision.index < next)) invalid();
    const suggested = languages(clean.slice(proposal.index + proposal[0].length, reason.index)), rationale = languages(clean.slice(reason.index + reason[0].length, decision.index));
    if (!suggested || !rationale) invalid();
    // A labelled CURRENT block may supply an original-English excerpt. Exact
    // current-source matching still decides the anchor; review codes and PDF
    // page/paragraph ordinals never act as source IDs.
    const preceding = clean.slice(position ? decisions[position - 1].index + decisions[position - 1][0].length : 0, proposal.index);
    const current = [...preceding.matchAll(/原稿\s*\/\s*CURRENT\s*\n/gu)].at(-1);
    const original = current ? languages(preceding.slice(current.index + current[0].length)) : null;
    const quote = original && bilingualLiteralExcerpt(original.source, index);
    return { reviewCode: proposal[1], title: `[${proposal[1]}] 建议改写 / Proposed revision`, suggestedSource: suggested.source, suggestedTranslation: suggested.translation, reasonSource: rationale.source, reasonTranslation: rationale.translation, ...(original ? { currentSource: original.source, currentTranslation: original.translation, scope: 'paragraph' } : {}), body: rationale.translation, recommendation: suggested.translation, ...(quote && Buffer.byteLength(quote) <= 8192 ? { quote } : {}) };
  });
}
export function normalizeExternalReviews(input, state) {
  strict(input, ['filename', 'format', 'fileHash', 'text', 'annotations']);
  if (typeof input.filename !== 'string' || !input.filename || input.filename.length > 240 || /[\\/\u0000-\u001f]/u.test(input.filename) || !['txt', 'md', 'json', 'pdf', 'docx'].includes(input.format) || !digest(input.fileHash)) fail('INVALID_REVIEW', 'Review requires a filename, supported format and SHA-256 digest; paths are not accepted.');
  if (typeof input.text === 'string' && Buffer.byteLength(input.text) > REVIEW_IMPORT_LIMITS.textBytes) fail('REVIEW_TOO_LARGE', `Review text exceeds the ${REVIEW_IMPORT_LIMITS.textBytes / 1024 / 1024} MiB limit.`);
  const content = text(input.text, 'Review text', REVIEW_IMPORT_LIMITS.textBytes, false);
  let items, structuredBilingual = false;
  if (input.format === 'json') {
    let parsed; try { parsed = JSON.parse(content); } catch { fail('INVALID_REVIEW', 'Review JSON is malformed.'); }
    if (object(parsed) && Object.keys(parsed).length === 1 && Array.isArray(parsed.notes)) items = parsed.notes;
    else if (Array.isArray(parsed)) items = parsed;
    else fail('INVALID_REVIEW', 'Review JSON must be a note array or an object containing only notes.');
  } else {
    const structured = content && input.format === 'pdf' ? bilingualRevisionNotes(content, state) : null;
    structuredBilingual = Array.isArray(structured);
    items = structured ?? (content ? externalParagraphs(content).map(body => ({ body })) : []);
  }
  if (input.annotations !== undefined) {
    if (!Array.isArray(input.annotations)) fail('INVALID_REVIEW', 'Review annotations must be an array within the text-byte budget.');
    const bytes = Buffer.byteLength(content) + input.annotations.reduce((sum, note) => sum + ['body', 'title', 'recommendation', 'quote', 'reviewCode', ...BILINGUAL_FIELDS, ...CURRENT_FIELDS].reduce((size, key) => size + (typeof note?.[key] === 'string' ? Buffer.byteLength(note[key]) : 0), 0), 0);
    if (bytes > REVIEW_IMPORT_LIMITS.textBytes) fail('REVIEW_TOO_LARGE', 'Review text and annotations exceed the 32 MiB limit.');
    for (const annotation of input.annotations) items.push(annotation);
  }
  if (!items.length) fail('INVALID_REVIEW', 'The external review does not contain any opinions.');
  const snapshotId = state?.project?.snapshotId;
  const batchId = `review-external-${hash(JSON.stringify([snapshotId, input.fileHash, input.format])).slice(0, 32)}`;
  const notes = normalizeModelNotes(items, state, { batchId, origin: 'external' });
  return { batch: { batchId, origin: 'external', filename: input.filename, format: input.format, fileHash: input.fileHash.toLowerCase(), sourceSnapshotId: snapshotId, noteCount: notes.length, ...(structuredBilingual ? { sourceLanguage: 'en', language: 'zh-CN' } : {}), createdAt: new Date().toISOString() }, notes };
}

/** Enrich display metadata only after the caller verifies the same imported file.
 * Matching never changes note IDs, anchors, decisions or recommendation text.
 */
export function enrichReviewNotePresentation(existingNotes, parsedNotes) {
  if (!Array.isArray(existingNotes) || !Array.isArray(parsedNotes)) fail('INVALID_REVIEW', 'Review metadata enrichment requires bounded note arrays.');
  const identity = note => JSON.stringify([note.reviewCode || null, ...BILINGUAL_FIELDS.map(key => note[key] || null)]), candidates = new Map();
  for (const note of parsedNotes) { const key = identity(note); if (!candidates.has(key)) candidates.set(key, []); candidates.get(key).push(note); }
  const existingCounts = new Map(); for (const note of existingNotes) { const key = identity(note); existingCounts.set(key, (existingCounts.get(key) || 0) + 1); }
  const updatedIds = [], notes = existingNotes.map(note => {
    const key = identity(note), matches = candidates.get(key);
    if (note.origin !== 'external' || !note.reviewCode || BILINGUAL_FIELDS.some(field => typeof note[field] !== 'string' || !note[field].trim()) || existingCounts.get(key) !== 1 || matches?.length !== 1 || matches[0].origin !== 'external' || CURRENT_FIELDS.some(field => typeof matches[0][field] !== 'string' || !matches[0][field].trim()) || CURRENT_FIELDS.some(field => note[field] !== undefined) || !Number.isSafeInteger(note.revision) || note.revision >= Number.MAX_SAFE_INTEGER) return structuredClone(note);
    const parsed = matches[0]; updatedIds.push(note.noteId);
    return { ...structuredClone(note), currentSource: parsed.currentSource, currentTranslation: parsed.currentTranslation, currentContextProvenance: 'external-review-context', scope: parsed.scope || 'paragraph', revision: note.revision + 1 };
  });
  return { notes, updatedIds };
}
