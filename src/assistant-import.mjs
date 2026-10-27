import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, open, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { PaperService } from './core.mjs';
import { commands } from './latex.mjs';
import { discoverMainFiles } from './host-context.mjs';
import { REVIEW_IMPORT_LIMITS } from './review-limits.mjs';

export const ASSISTANT_IMPORT_LIMITS = Object.freeze({ archiveBytes: 64 * 1024 * 1024, entries: 2000, expandedBytes: 128 * 1024 * 1024, sourceBytes: 32 * 1024 * 1024, sourceFileBytes: 4 * 1024 * 1024, reviewWorkerMs: 120000 });
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const decode = bytes => { try { return new TextDecoder('utf8', { fatal: true }).decode(bytes); } catch { fail('INVALID_IMPORT_ENCODING', 'Import text must be valid UTF-8.'); } };
const absolute = value => { if (typeof value !== 'string' || !value || value.length > 4096 || !path.isAbsolute(value) || /[\x00-\x1f]/u.test(value)) fail('INVALID_IMPORT_PATH', 'Provide the exact absolute local path supplied for this import.'); return path.resolve(value); };
const relative = (value, code = 'UNSAFE_IMPORT_ARCHIVE') => {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\') || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f<>"|?*]/u.test(part) || /[. ]$/u.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part))) fail(code, 'An import entry must be a safe relative path without Windows aliases or traversal.');
  return value;
};
async function regularPath(value, directory = false) {
  const filename = absolute(value), info = await lstat(filename);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) fail('INVALID_IMPORT_PATH', 'Choose an actual local file or directory, without symbolic links.');
  const resolved = await realpath(filename);
  if (process.platform === 'win32' ? resolved.toLowerCase() !== filename.toLowerCase() : resolved !== filename) fail('INVALID_IMPORT_PATH', 'Import paths must not pass through redirected or symbolic-link directories.');
  return { filename: resolved, info };
}
async function boundedRead(filename, max) {
  const safe = await regularPath(filename), handle = await open(safe.filename, 'r');
  try {
    const before = await handle.stat(); if (!before.isFile() || before.size > max || before.dev !== safe.info.dev || before.ino !== safe.info.ino) fail('IMPORT_TOO_LARGE', 'The selected import exceeds its supported byte limit or changed while opening.');
    const bytes = Buffer.alloc(before.size + 1); let size = 0;
    while (size < bytes.length) { const read = await handle.read(bytes, size, bytes.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
    const after = await handle.stat(); if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail('IMPORT_CHANGED', 'The selected file changed during import; retry after saving it.');
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => { for (let i = 0; i < 8; i++) value = value >>> 1 ^ (0xedb88320 & -(value & 1)); return value >>> 0; });
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crc >>> 8 ^ crcTable[(crc ^ byte) & 255]; return (crc ^ 0xffffffff) >>> 0; }

/** Validate the entire archive before any output file exists. No archive paths,
 * symlinks, encrypted payloads or executable TeX are followed or evaluated. */
export function inspectAssistantZip(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > ASSISTANT_IMPORT_LIMITS.archiveBytes) fail('IMPORT_TOO_LARGE', 'The ZIP import exceeds 64 MiB.');
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
  if (end < 0) fail('INVALID_IMPORT_ARCHIVE', 'The ZIP directory is missing or damaged.');
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16), size = bytes.readUInt32LE(end + 12);
  if (count === 0xffff || start === 0xffffffff || size === 0xffffffff || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || start + size !== end || !count) fail('INVALID_IMPORT_ARCHIVE', 'Split, Zip64 or empty archives are unsupported.');
  if (count > ASSISTANT_IMPORT_LIMITS.entries) fail('IMPORT_TOO_LARGE', 'The ZIP contains more than 2000 entries.');
  const entries = new Map(), names = new Set(), ranges = []; let cursor = start, expanded = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail('INVALID_IMPORT_ARCHIVE', 'A ZIP directory entry is damaged.');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20), uncompressed = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32), attributes = bytes.readUInt32LE(cursor + 38), offset = bytes.readUInt32LE(cursor + 42), next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || !nameLength || flags & 0x41 || ![0, 8].includes(method) || [compressed, uncompressed, offset].includes(0xffffffff) || bytes.readUInt16LE(cursor + 34)) fail('INVALID_IMPORT_ARCHIVE', 'A ZIP entry is encrypted, unsupported or damaged.');
    for (let extra = cursor + 46 + nameLength; extra < cursor + 46 + nameLength + extraLength;) { if (extra + 4 > cursor + 46 + nameLength + extraLength || bytes.readUInt16LE(extra) === 1) fail('INVALID_IMPORT_ARCHIVE', 'Zip64 or damaged ZIP extension fields are unsupported.'); extra += 4 + bytes.readUInt16LE(extra + 2); if (extra > cursor + 46 + nameLength + extraLength) fail('INVALID_IMPORT_ARCHIVE', 'A ZIP extension field exceeds its entry.'); }
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength); if (!(flags & 0x800) && nameBytes.some(byte => byte >= 128)) fail('INVALID_IMPORT_ENCODING', 'Non-ASCII ZIP filenames must declare UTF-8 encoding.');
    const name = decode(nameBytes), directory = name.endsWith('/'), safe = relative(directory ? name.slice(0, -1) : name), key = safe.normalize('NFC').toLowerCase(), kind = attributes >>> 16 & 0xf000;
    if (names.has(key) || kind && kind !== 0x8000 && kind !== 0x4000 || kind === 0x4000 && !directory || attributes & 0x400 || directory && uncompressed) fail('UNSAFE_IMPORT_ARCHIVE', 'The ZIP contains duplicate paths, aliases, links or special files.'); names.add(key);
    expanded += uncompressed; if (expanded > ASSISTANT_IMPORT_LIMITS.expandedBytes || uncompressed > ASSISTANT_IMPORT_LIMITS.archiveBytes) fail('IMPORT_TOO_LARGE', 'The ZIP expanded data exceeds the import limit.');
    if (offset + 30 > start || bytes.readUInt32LE(offset) !== 0x04034b50 || bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method) fail('INVALID_IMPORT_ARCHIVE', 'A ZIP local entry differs from its directory.');
    const localName = bytes.readUInt16LE(offset + 26), localExtra = bytes.readUInt16LE(offset + 28), dataStart = offset + 30 + localName + localExtra;
    if (dataStart + compressed > start || !bytes.subarray(offset + 30, offset + 30 + localName).equals(nameBytes) || !(flags & 8) && (bytes.readUInt32LE(offset + 14) !== crc || bytes.readUInt32LE(offset + 18) !== compressed || bytes.readUInt32LE(offset + 22) !== uncompressed)) fail('INVALID_IMPORT_ARCHIVE', 'ZIP data bounds or local sizes do not match.');
    ranges.push([offset, dataStart + compressed]); if (!directory) entries.set(safe, { name: safe, method, crc, compressed, uncompressed, dataStart }); cursor = next;
  }
  if (cursor !== end) fail('INVALID_IMPORT_ARCHIVE', 'The ZIP directory length is inconsistent.');
  ranges.sort((a, b) => a[0] - b[0]); if (ranges.some((range, index) => index && range[0] < ranges[index - 1][1])) fail('INVALID_IMPORT_ARCHIVE', 'ZIP local entries overlap.');
  for (const name of entries.keys()) for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) if ([...entries.keys()].some(other => other.toLowerCase() === parent.toLowerCase())) fail('UNSAFE_IMPORT_ARCHIVE', 'A ZIP file is also used as a parent directory.');
  return entries;
}
function unzip(bytes, entry, max = ASSISTANT_IMPORT_LIMITS.archiveBytes) {
  if (entry.uncompressed > max) fail('IMPORT_TOO_LARGE', 'A selected ZIP entry exceeds its import limit.');
  const compressed = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressed); let result;
  try { result = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.min(max, entry.uncompressed) + 1 }); }
  catch { fail('INVALID_IMPORT_ARCHIVE', 'ZIP compressed data is damaged or exceeds its declared size.'); }
  if (result.length !== entry.uncompressed || crc32(result) !== entry.crc) fail('INVALID_IMPORT_ARCHIVE', 'ZIP entry size or CRC does not match.'); return result;
}
function commonPrefix(names) { let prefix = ''; while (names.length && names.every(name => name.includes('/') && name.split('/')[0] === names[0].split('/')[0])) { const part = names[0].split('/')[0] + '/'; prefix += part; names = names.map(name => name.slice(part.length)); } return prefix; }
const mainCandidate = (name, bytes) => /\.tex$/iu.test(name) && commands(decode(bytes)).some(command => command.name === 'documentclass');

/** The original input is read only. Repeating the same import reopens the same
 * private editable project rather than overwriting edits or creating copies. */
export async function prepareAssistantSource({ sourcePath, mainFile, privateRoot } = {}) {
  const sourceName = absolute(sourcePath), privateName = absolute(privateRoot), info = await lstat(sourceName); if (info.isSymbolicLink()) fail('INVALID_IMPORT_PATH', 'Linked source inputs are unsupported.');
  let candidates, sourceHash, provenance, selected, files;
  if (info.isFile() && /\.zip$/iu.test(sourceName)) {
    const bytes = await boundedRead(sourceName, ASSISTANT_IMPORT_LIMITS.archiveBytes), entries = inspectAssistantZip(bytes), visible = [...entries.keys()].filter(name => !name.startsWith('__MACOSX/') && !name.split('/').some(part => part.startsWith('.'))), prefix = commonPrefix(visible), mapped = new Map();
    for (const [name, entry] of entries) if (!name.startsWith('__MACOSX/') && !name.split('/').some(part => part.startsWith('.'))) { if (entry.uncompressed > ASSISTANT_IMPORT_LIMITS.sourceFileBytes) fail('IMPORT_TOO_LARGE', 'A source input exceeds the 4 MiB project limit.'); mapped.set(name.slice(prefix.length), { entry, bytes: unzip(bytes, entry, ASSISTANT_IMPORT_LIMITS.sourceFileBytes) }); }
    candidates = [...mapped].filter(([name, item]) => mainCandidate(name, item.bytes)).map(([name]) => name).sort(); sourceHash = hash(bytes); provenance = { filename: path.basename(sourceName), format: 'zip', fileHash: sourceHash };
    selected = mainFile === undefined ? candidates.length === 1 ? candidates[0] : null : relative(mainFile, 'INVALID_IMPORT_ENTRY');
    if (selected && !candidates.includes(selected)) fail('MAIN_FILE_NOT_FOUND', 'Select one of the TeX documents declared by this source archive.');
    if (!selected) return { status: 'main-file-required', root: null, mainCandidates: candidates, sourceHash, reused: false, provenance };
    files = [...mapped].map(([name, item]) => ({ path: name, bytes: item.bytes, hash: hash(item.bytes) }));
  } else {
    const isTex = info.isFile() && /\.tex$/iu.test(sourceName); if (!info.isDirectory() && !isTex) fail('UNSUPPORTED_SOURCE_IMPORT', 'Choose a source ZIP, project directory or main .tex file.');
    const root = (await regularPath(isTex ? path.dirname(sourceName) : sourceName, true)).filename;
    candidates = isTex ? [path.basename(sourceName)] : await discoverMainFiles(root); selected = mainFile === undefined ? candidates.length === 1 ? candidates[0] : null : relative(mainFile, 'INVALID_IMPORT_ENTRY');
    if (selected && !candidates.includes(selected)) fail('MAIN_FILE_NOT_FOUND', 'Select a main TeX document from this exact project.');
    if (!selected) return { status: 'main-file-required', root: null, mainCandidates: candidates, sourceHash: null, reused: false, provenance: { filename: path.basename(sourceName), format: info.isDirectory() ? 'directory' : 'tex' } };
    const scan = await new PaperService({ dataRoot: privateName })._scan(root, selected); files = [...scan.files.values()]; sourceHash = hash(JSON.stringify({ mainFile: selected, files: files.map(item => [item.path, item.hash]) })); provenance = { filename: path.basename(sourceName), format: isTex ? 'tex' : 'directory', fileHash: sourceHash };
  }
  if (files.length > 500 || files.reduce((sum, item) => sum + item.bytes.length, 0) > ASSISTANT_IMPORT_LIMITS.sourceBytes) fail('IMPORT_TOO_LARGE', 'The source project exceeds 500 files or 32 MiB.');
  const selectedSource = files.find(item => item.path === selected); if (!selectedSource || !mainCandidate(selected, selectedSource.bytes)) fail('MAIN_FILE_NOT_FOUND', 'The selected main file is not a standalone TeX document.');
  const engine = commands(decode(selectedSource.bytes)).some(command => ['usepackage', 'RequirePackage'].includes(command.name) && command.args[0]?.split(',').some(name => ['fontspec', 'xeCJK'].includes(name.trim()))) ? 'xelatex' : 'pdflatex';
  await mkdir(privateName, { recursive: true, mode: 0o700 }); await regularPath(privateName, true);
  const imports = path.join(privateName, 'imports'); await mkdir(imports, { recursive: true, mode: 0o700 }); await regularPath(imports, true);
  const identity = hash(JSON.stringify([sourceHash, selected])), container = path.join(imports, identity.slice(0, 16)), root = path.join(container, 'source'), manifestFile = path.join(container, 'manifest.json');
  const existing = await lstat(container).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (existing) { await regularPath(container, true); await regularPath(root, true); let manifest; try { manifest = JSON.parse((await boundedRead(manifestFile, 1024 * 1024)).toString('utf8')); } catch { fail('IMPORT_RECOVERY_REQUIRED', 'A previous import exists without a valid manifest; preserve it for recovery.'); } if (manifest.schemaVersion !== 1 || manifest.sourceHash !== sourceHash || manifest.mainFile !== selected) fail('IMPORT_RECOVERY_REQUIRED', 'A previous source import has an unexpected identity.'); return { status: 'ready', root, mainFile: selected, mainCandidates: candidates, sourceHash, reused: true, engine, provenance }; }
  const staging = path.join(imports, `.staging-${randomUUID()}`); await mkdir(path.join(staging, 'source'), { recursive: true, mode: 0o700 });
  try {
    for (const item of files) { const filename = path.join(staging, 'source', relative(item.path)); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, item.bytes, { flag: 'wx', mode: 0o600 }); }
    // A selected ZIP main brings only its dependency graph into the lasting
    // project; other manuscripts and executable archive attachments stay out.
    const scan = await new PaperService({ dataRoot: privateName })._scan(path.join(staging, 'source'), selected), used = new Set(scan.files.keys());
    for (const item of files) if (!used.has(item.path)) await rm(path.join(staging, 'source', item.path));
    await writeFile(path.join(staging, 'manifest.json'), JSON.stringify({ schemaVersion: 1, sourceHash, mainFile: selected, provenance, files: [...scan.files.values()].map(item => ({ path: item.path, hash: item.hash })), createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    try { await rename(staging, container); } catch (error) { if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) fail('IMPORT_BUSY', 'This exact source import is being prepared elsewhere; retry once it completes.'); throw error; }
  } finally { await rm(staging, { recursive: true, force: true }); }
  return { status: 'ready', root, mainFile: selected, mainCandidates: candidates, sourceHash, reused: false, engine, provenance };
}

function outerGroup(raw) {
  const value = raw.trim(); if (!value.startsWith('{')) return value; let depth = 0;
  for (let at = 0; at < value.length; at++) { if (value[at] === '\\') { at++; continue; } if (value[at] === '{') depth++; if (value[at] === '}' && --depth === 0) return at === value.length - 1 ? value.slice(1, -1).trim() : value; } return value;
}
function reviewText(value) { return value.replace(/\\par\b/gu, '\n').replace(/\\(?:smallskip|medskip|bigskip|noindent|nopagebreak)\b/gu, '').replace(/(?:^|[^\\])%[^\n]*(?:\n|$)/gu, match => match.startsWith('%') ? '\n' : match[0] + '\n').replace(/\s*\n\s*/gu, ' ').trim(); }
function languagePair(raw) {
  let value = outerGroup(raw).replace(/^\\color\{(?:New|Old|black)\}\s*/u, '');
  const markers = commands(value).filter(command => ['eng', 'chin'].includes(command.name)); if (markers.length !== 2 || markers[0].name !== 'eng' || markers[1].name !== 'chin') return null;
  const source = reviewText(value.slice(markers[0].end, markers[1].start)), translation = reviewText(value.slice(markers[1].end)); if (!source || !translation) return null; return { source, translation };
}
/** Parse a declared review template without macro expansion, input/include,
 * file IO, compilation, shell commands or interpreting prose as instructions. */
export function parseBilingualReviewTex(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > REVIEW_IMPORT_LIMITS.textBytes) fail('IMPORT_TOO_LARGE', 'Review source exceeds the 32 MiB extraction limit.');
  const all = commands(source), document = all.find(command => command.name === 'begin' && command.args[0] === 'document'); if (!document || !/Full\s+bilingual\s+manuscript\s+with\s+proposed\s+revisions/iu.test(source.slice(document.end, document.end + 12000))) fail('REVIEW_TEX_STRUCTURE_REQUIRED', 'This TeX is not a recognized bilingual review. Provide a review PDF, structured JSON or plain review text.');
  const body = source.slice(document.end), tokens = commands(body), proposals = tokens.filter(command => command.name === 'proposalstart'), reasons = tokens.filter(command => command.name === 'reasonlabel'), endings = tokens.filter(command => command.name === 'proposalend'), declared = [...body.slice(0, 12000).matchAll(/(\d{1,5})\s*项建议/gu)].map(match => Number(match[1]));
  const invalid = () => fail('INVALID_REVIEW_STRUCTURE', 'The review template contains incomplete, duplicate or inconsistent suggestion blocks; nothing was imported.');
  if (!declared.length || new Set(declared).size !== 1 || declared[0] !== proposals.length || proposals.length > REVIEW_IMPORT_LIMITS.annotations || !proposals.length || reasons.length !== proposals.length || endings.length !== proposals.length || new Set(proposals.map(command => command.args[0])).size !== proposals.length) invalid();
  return proposals.map((proposal, index) => {
    const reason = reasons[index], ending = endings[index], next = proposals[index + 1]?.start ?? body.length; if (!/^[A-Z]\d{2,4}$/u.test(proposal.args[0] || '') || !(proposal.end < reason.start && reason.end < ending.start && ending.end < next)) invalid();
    const suggested = languagePair(body.slice(proposal.end, reason.start)), rationale = languagePair(body.slice(reason.end, ending.start)); if (!suggested || !rationale) invalid();
    const start = endings[index - 1]?.end ?? 0, preceding = tokens.filter(command => command.start >= start && command.end <= proposal.start), heading = preceding.findLast(command => command.name === 'changeheading' && command.args[0] === proposal.args[0]); let current;
    if (heading) { const begin = preceding.find(command => command.start > heading.end && command.name === 'begin' && command.args[0] === 'pairedoriginal'), end = begin && preceding.find(command => command.start > begin.end && command.name === 'end' && command.args[0] === 'pairedoriginal'); if (begin && end) current = languagePair(body.slice(begin.end, end.start)); }
    return { reviewCode: proposal.args[0], title: `[${proposal.args[0]}] ${heading?.args[2] || 'Proposed revision'}`, suggestedSource: suggested.source, suggestedTranslation: suggested.translation, reasonSource: rationale.source, reasonTranslation: rationale.translation, body: rationale.translation, recommendation: suggested.translation, ...(current ? { currentSource: current.source, currentTranslation: current.translation, scope: 'paragraph' } : {}) };
  });
}
function sourceSurfaces(state) {
  const surfaces = new Map(), add = (id, values) => { if (typeof id !== 'string') return; let entry = surfaces.get(id); if (!entry) surfaces.set(id, entry = new Set()); for (const value of values) if (typeof value === 'string' && value) entry.add(value); };
  for (const segment of state?.segments || []) add(segment.id, [segment.source, segment.displayText, segment.visibleText]);
  const paragraphs = state?.readingParagraphs || [];
  for (const paragraph of paragraphs) {
    // The generated import payload must be stable for one source snapshot.
    // Mutable target-language drafts are never evidence for an English link.
    const values = [paragraph.source, paragraph.displayText, paragraph.english];
    if (/^[a-f0-9]{64}$/iu.test(paragraph.beforeHash || paragraph.sourceHash || '')) {
      add(paragraph.id, values);
      for (const id of paragraph.canonicalSegmentIds || []) if (id !== paragraph.id && !paragraphs.some(item => item.id === id)) surfaces.delete(id);
    } else for (const id of paragraph.sourceSegmentIds || []) if (surfaces.has(id)) add(id, values);
  }
  return surfaces;
}
function addLiteralQuotes(notes, state) {
  const surfaces = sourceSurfaces(state); if (!surfaces.size) return notes;
  let budget = 5000;
  const unique = quote => {
    let identity = null;
    for (const [id, values] of surfaces) {
      let matched = false;
      for (const value of values) { const at = value.indexOf(quote); if (at < 0) continue; if (value.indexOf(quote, at + quote.length) >= 0) return false; matched = true; }
      if (matched) { if (identity !== null && identity !== id) return false; identity = id; }
    }
    return identity !== null;
  };
  return notes.map(note => {
    if (!note.currentSource) return note;
    const current = note.currentSource.replace(/\s+/gu, ' ').trim(), candidates = [];
    if (Buffer.byteLength(current) <= 8192 && (current.match(/[A-Za-z]/gu)?.length || 0) >= 64) candidates.push(current);
    let attempts = 0;
    for (const run of current.slice(0, 8192).matchAll(/[A-Za-z][A-Za-z ,;:.!?'"‘’“”()\-–—]*/gu)) {
      const words = [...run[0].matchAll(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/gu)];
      for (let start = 0; start < words.length && attempts < 128 && budget > 0; start++) {
        let end = start, letters = 0;
        while (end < words.length && end - start < 12 && letters < 64) { letters += words[end][0].replace(/[^A-Za-z]/gu, '').length; end++; }
        if (end - start < 12 && letters < 64) continue;
        const last = words[end - 1]; candidates.push(run[0].slice(words[start].index, last.index + last[0].length)); attempts++; budget--;
      }
      if (attempts >= 128 || budget <= 0) break;
    }
    // A quote is only a candidate until the existing normalization layer
    // independently proves its unique literal occurrence in the active source.
    const quote = candidates.find(unique); return quote ? { ...note, quote } : note;
  });
}
async function parseInWorker(filename, bytes) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./assistant-review-worker.mjs', import.meta.url), { workerData: { filename, bytes }, execArgv: [], stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 512 } }); let completed = false;
    // PDF parsing diagnostics must never enter the MCP JSON-RPC stdout stream.
    worker.stdout.resume(); worker.stderr.resume();
    const finish = (error, result) => { if (completed) return; completed = true; clearTimeout(timer); void worker.terminate(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(Object.assign(new Error('Review extraction timed out; no partial opinions were imported.'), { code: 'REVIEW_IMPORT_TIMEOUT' })), ASSISTANT_IMPORT_LIMITS.reviewWorkerMs);
    worker.once('message', message => message?.ok ? finish(null, message.result) : finish(Object.assign(new Error(message?.error?.message || 'Review extraction failed.'), { code: message?.error?.code || 'INVALID_REVIEW_FILE' })));
    worker.once('error', error => finish(Object.assign(new Error('The isolated review reader could not start.'), { code: 'REVIEW_READER_UNAVAILABLE', cause: error })));
    worker.once('exit', code => { if (!completed) finish(Object.assign(new Error(`The isolated review reader exited before returning a result (${code}).`), { code: 'REVIEW_READER_UNAVAILABLE' })); });
  });
}
const reviewExtension = name => ['.txt', '.md', '.markdown', '.json', '.pdf', '.docx', '.tex'].includes(path.posix.extname(name).toLowerCase());
export async function prepareAssistantReview({ reviewPath, entry, state } = {}) {
  const filename = absolute(reviewPath), bytes = await boundedRead(filename, REVIEW_IMPORT_LIMITS.fileBytes), sourceHash = hash(bytes), zip = /\.zip$/iu.test(filename); let selectedName = path.basename(filename), selectedBytes = bytes;
  const provenance = { filename: path.basename(filename), format: zip ? 'zip' : path.extname(filename).slice(1).toLowerCase(), fileHash: sourceHash };
  if (zip) {
    const entries = inspectAssistantZip(bytes); let candidates = [...entries.keys()].filter(name => reviewExtension(name) && !name.split('/').some(part => part.startsWith('.') || part === '__MACOSX'));
    // Ignore source graphics and README companions when there is one actual
    // review document; never choose between two substantive review documents.
    const substantive = candidates.filter(name => !/(?:^|\/)(?:readme|license|licence|changelog)(?:\.[^/]*)?$/iu.test(name) && !/(?:^|\/)(?:figures?|images?|assets)\//iu.test(name)); if (substantive.length) candidates = substantive;
    candidates.sort(); selectedName = entry === undefined ? candidates.length === 1 ? candidates[0] : null : relative(entry, 'INVALID_IMPORT_ENTRY'); if (!selectedName) return { status: 'review-file-required', reviewCandidates: candidates, sourceHash, provenance }; if (!candidates.includes(selectedName)) fail('INVALID_IMPORT_ENTRY', 'Select an exact supported review member from this ZIP.'); selectedBytes = unzip(bytes, entries.get(selectedName), REVIEW_IMPORT_LIMITS.fileBytes); provenance.member = selectedName;
  } else if (entry !== undefined) fail('INVALID_IMPORT_ENTRY', 'An archive member can only be selected for a ZIP import.');
  if (!reviewExtension(selectedName)) fail('UNSUPPORTED_REVIEW_FORMAT', 'Choose TXT, Markdown, JSON, PDF, DOCX, or a declared bilingual review TeX file.');
  let input;
  if (/\.tex$/iu.test(selectedName)) { const notes = addLiteralQuotes(parseBilingualReviewTex(decode(selectedBytes)), state); input = { filename: path.posix.basename(selectedName), format: 'json', fileHash: hash(selectedBytes), text: JSON.stringify({ notes }) }; provenance.sourceFormat = 'tex'; provenance.memberHash = input.fileHash; if (Buffer.byteLength(input.text) > REVIEW_IMPORT_LIMITS.textBytes) fail('IMPORT_TOO_LARGE', 'The extracted review exceeds 32 MiB.'); }
  else input = await parseInWorker(path.posix.basename(selectedName), selectedBytes);
  return { status: 'ready', input, sourceHash, reviewCandidates: [selectedName], provenance };
}
