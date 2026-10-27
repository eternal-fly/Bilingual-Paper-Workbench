import { createHash } from 'node:crypto';
import { opinionMathPreambleMacros } from './opinion-math.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const empty = () => ({ labels: {}, citations: {} });
const key = value => typeof value === 'string' && /^[A-Za-z0-9_.:/+\-]{1,128}$/.test(value);
const numeric = value => /^(?:[A-Z]{1,3}[.-]?)?\d{1,6}(?:[.-]\d{1,6})*[a-z]?$/.test(value);
function group(source, at) {
  if (source[at] !== '{') return null;
  let depth = 1;
  for (let end = at + 1; end < source.length; end++) {
    if (source[end] === '\\') { end++; continue; }
    if (source[end] === '{') depth++;
    if (source[end] === '}' && --depth === 0) return { value: source.slice(at + 1, end), end: end + 1 };
  }
  return null;
}
/** Read bounded scalar aux data only; never input or evaluate TeX. */
export function parseReferenceData(auxText, identity, expectedSnapshotId) {
  const references = empty(), diagnostics = [];
  const verified = identity?.verified === true && identity.snapshotId === expectedSnapshotId && /^build-[A-Za-z0-9_-]{1,120}$/.test(identity.buildId || '') && /^[a-f0-9]{64}$/.test(identity.inputHash || '') && /^[a-f0-9]{64}$/.test(identity.pdfHash || '');
  if (!verified || typeof auxText !== 'string' || Buffer.byteLength(auxText) > 1024 * 1024) return { references, diagnostics: [{ code: 'REFERENCE_CONTEXT_UNVERIFIED', message: 'Reference numbers require an exact verified current build.' }] };
  const blocked = { labels: new Set(), citations: new Set() };
  for (const match of auxText.matchAll(/^[\t ]*\\(newlabel|bibcite)\s*/gm)) {
    const label = group(auxText, match.index + match[0].length);
    const value = label && group(auxText, label.end);
    if (!label || !value || !key(label.value)) { diagnostics.push({ code: 'UNSUPPORTED_REFERENCE_DATA', message: 'Unsupported reference metadata remains source text.' }); continue; }
    const category = match[1] === 'newlabel' ? 'labels' : 'citations';
    const nested = value.value.startsWith('{') ? group(value.value, 0)?.value : value.value;
    if (typeof nested !== 'string' || !numeric(nested)) { diagnostics.push({ code: 'UNSUPPORTED_REFERENCE_DATA', message: 'A reference contains non-scalar TeX and was not evaluated.' }); continue; }
    if (blocked[category].has(label.value)) continue;
    if (Object.hasOwn(references[category], label.value) && references[category][label.value] !== nested) { delete references[category][label.value]; blocked[category].add(label.value); diagnostics.push({ code: 'AMBIGUOUS_REFERENCE_DATA', message: 'Conflicting reference metadata was omitted.' }); continue; }
    references[category][label.value] = nested;
  }
  return { references, diagnostics };
}
export function createMarkdownContext({ state, files, referenceContext = null } = {}) {
  if (!state?.project || !Array.isArray(files) || files.length > 500) throw Object.assign(new Error('A current authorized paper snapshot is required.'), { code: 'INVALID_INPUT' });
  let bytes = 0;
  const identities = files.map(file => {
    if (typeof file.path !== 'string' || !Buffer.isBuffer(file.bytes) || file.bytes.length > 16 * 1024 * 1024 || (bytes += file.bytes.length) > 64 * 1024 * 1024) throw Object.assign(new Error('Markdown context requires bounded source byte snapshots.'), { code: 'INVALID_INPUT' });
    return [file.path, sha(file.bytes)];
  }).sort((a, b) => a[0].localeCompare(b[0]));
  const macros = opinionMathPreambleMacros(files, state.project.mainFile), result = referenceContext ? parseReferenceData(referenceContext.auxText, referenceContext, state.project.snapshotId) : { references: empty(), diagnostics: [] };
  const contextKey = sha(JSON.stringify({ version: 1, snapshotId: state.project.snapshotId, mainFile: state.project.mainFile, identities, macros, references: result.references, buildId: referenceContext?.buildId || null }));
  return { contextKey, snapshotId: state.project.snapshotId, macros, references: result.references, diagnostics: result.diagnostics };
}
