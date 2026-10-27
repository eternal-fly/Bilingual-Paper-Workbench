import { createHash } from 'node:crypto';
import { open, lstat } from 'node:fs/promises';
import { inputHash } from './compiler/worker.mjs';

// This renderer creates derived display artifacts only. No paper source, proposal,
// version-pair record or baseline build is passed to a mutation API.
const VERSION = 1;
const FIELDS = ['currentSource', 'currentTranslation', 'suggestedSource', 'suggestedTranslation', 'reasonSource', 'reasonTranslation', 'body', 'recommendation'];
const MAX_FIELD = 64 * 1024, MAX_FORMULA = 4096, MAX_FRAGMENTS = 48, MAX_TOTAL = 32 * 1024;
const MAX_PDF = 4 * 1024 * 1024;
const sha = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const PLACEHOLDER = /⟦P\d+(?:_[^⟧\r\n]{1,160})?⟧|\[\[P\d+(?:_[^\]\r\n]{1,160})?\]\]/gi;
const keyOf = value => /^(?:⟦(P\d+(?:_[a-f0-9]{1,64})?)⟧|\[\[(P\d+(?:_[a-f0-9]{1,64})?)\]\])$/i.exec(value)?.slice(1).find(Boolean)?.toLowerCase();
const builtin = new Set((`alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa varkappa lambda mu nu xi omicron pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega
frac dfrac tfrac cfrac binom dbinom tbinom sqrt overline underline widehat widetilde hat tilde bar vec dot ddot dddot ddddot acute grave check breve mathring
mathbb mathcal mathfrak mathrm mathbf mathit mathsf mathtt mathnormal boldsymbol text textnormal textrm textbf textit textsf texttt operatorname operatornamewithlimits
sum prod coprod int iint iiint iiiint oint bigcup bigcap bigvee bigwedge bigoplus bigotimes bigsqcup lim liminf limsup min max inf sup arg det dim gcd hom ker Pr tr sin cos tan cot sec csc sinh cosh tanh arcsin arccos arctan log ln exp mod bmod pmod
left right middle big Big bigg Bigg bigl bigr Bigl Bigr biggl biggr Biggl Biggr
le leq leqslant ge geq geqslant ne neq approx sim simeq cong equiv propto ll gg prec succ preceq succeq subset supset subseteq supseteq in notin ni owns parallel perp mid models vdash dashv bowtie asymp doteq
to mapsto gets rightarrow leftarrow leftrightarrow Rightarrow Leftarrow Leftrightarrow longrightarrow longleftarrow longleftrightarrow Longrightarrow Longleftarrow Longleftrightarrow hookrightarrow hookleftarrow uparrow downarrow updownarrow Uparrow Downarrow Updownarrow nearrow searrow swarrow nwarrow
times cdot ast star circ bullet oplus ominus otimes oslash odot pm mp div setminus smallsetminus cup cap uplus sqcup sqcap vee wedge wr amalg triangleleft triangleright diamond bigtriangleup bigtriangledown
infty partial nabla ell hbar imath jmath Re Im wp aleph beth emptyset varnothing forall exists neg lnot land lor top bot angle measuredangle triangle square Box Diamond surd prime backslash
langle rangle lceil rceil lfloor rfloor vert Vert lvert rvert lVert rVert ldots cdots vdots ddots dots dotsc dotsb dotsm dotsi dotso
displaystyle textstyle scriptstyle scriptscriptstyle limits nolimits nonumber notag quad qquad enspace thinspace medspace thickspace overset underset overbrace underbrace substack boxed mathbin mathrel mathord mathop mathpunct mathopen mathclose phantom vphantom hphantom`).split(/\s+/));
const environments = new Set(['aligned', 'alignedat', 'gathered', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix', 'cases', 'array', 'split']);
const mathEnvironments = new Set(['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'displaymath']);
function diagnostic(code, field, message) { return { code, field, message }; }
function pushText(tokens, text) { if (!text) return; if (tokens.at(-1)?.type === 'text') tokens.at(-1).text += text; else tokens.push({ type: 'text', text }); }
function scopedTokens({ note, state }) {
  const ids = new Set(note.sourceSegmentIds || []), index = new Map();
  for (const source of [...(state.readingParagraphs || []), ...(state.segments || [])]) {
    if (!ids.has(source.id)) continue;
    for (const token of source.protectedTokens || []) {
      const key = typeof token.id === 'string' ? keyOf(token.id) : null;
      if (!key || typeof token.raw !== 'string' || token.raw.length > MAX_FIELD) continue;
      if (!index.has(key)) index.set(key, new Set()); index.get(key).add(token.raw);
    }
  }
  return index;
}
function snapshot(input) {
  const { note, state, files, language } = input;
  if (!note || !state?.project || !Array.isArray(files) || files.length > 500) throw Object.assign(new Error('An immutable current review and authorized source snapshot are required.'), { code: 'INVALID_INPUT' });
  const fields = Object.fromEntries(FIELDS.map(field => [field, typeof note[field] === 'string' ? note[field] : '']));
  if (Object.values(fields).some(value => Buffer.byteLength(value) > MAX_FIELD)) throw Object.assign(new Error('Opinion display field exceeds its bounded rendering limit.'), { code: 'REVIEW_TOO_LARGE' });
  const index = scopedTokens(input); let totalSource = 0;
  return { fields, protected: [...index].map(([key, values]) => [key, [...values].sort()]).sort(), projectId: state.project.projectId || state.project.id || '', snapshotId: state.project.snapshotId, reviewSnapshotId: note.sourceSnapshotId || null, mainFile: state.project.mainFile || '', noteId: note.noteId, revision: note.revision, language: language || '', sourceHashes: files.map(file => {
    if (typeof file.path !== 'string' || file.path.length > 512 || !Buffer.isBuffer(file.bytes) || file.bytes.length > 16 * 1024 * 1024 || (totalSource += file.bytes.length) > 64 * 1024 * 1024) throw Object.assign(new Error('Authorized files must be bounded immutable byte snapshots.'), { code: 'INVALID_INPUT' });
    return [file.path, sha(file.bytes)];
  }).sort((a, b) => a[0].localeCompare(b[0])) };
}
export function opinionMathFingerprint(input) { return sha(JSON.stringify({ version: VERSION, ...snapshot(input) })); }
function group(source, start) {
  if (source[start] !== '{') return null;
  let depth = 1;
  for (let at = start + 1; at < source.length; at++) {
    if (source[at] === '\\') { at++; continue; }
    if (source[at] === '{') depth++;
    if (source[at] === '}' && --depth === 0) return { body: source.slice(start + 1, at), end: at + 1 };
  }
  return null;
}
function whitespace(source, at) { while (/\s/.test(source[at] || '') && at < source.length) at++; return at; }
function macroDefinitions(files, mainFile) {
  const macros = new Map(), blocked = new Set(), byPath = new Map(files.map(file => [file.path, file])), visited = new Set(); let total = 0;
  const blockNestedDefinitions = body => { for (const match of body.matchAll(/\\(?:newcommand|renewcommand|providecommand|def|gdef|edef|xdef|let)\*?\s*\{?\s*\\([A-Za-z]+)/g)) blocked.add(match[1]); };
  const scan = (filename, isMain = false) => {
    const file = byPath.get(filename);
    if (!file || visited.has(filename) || visited.size >= 16 || file.bytes.length > 4 * 1024 * 1024 || (total += file.bytes.length) > 8 * 1024 * 1024) return;
    visited.add(filename);
    // Lexical declarations are data. Only top-level main-preamble declarations
    // and explicit preamble inputs are considered. Scoped, conditional, body,
    // environment and inert nested declarations are never promoted to globals.
    const source = file.bytes.toString('utf8').replace(/(^|[^\\])(?:\\\\)*%[^\r\n]*/g, '$1');
    if (isMain && !/\\begin\s*\{document\}/.test(source)) return;
    let conditional = 0, scoped = 0;
    for (let at = 0; at < source.length;) {
      if (source[at] === '{') { const skipped = group(source, at); if (!skipped) break; blockNestedDefinitions(skipped.body); at = skipped.end; continue; }
      if (source[at] !== '\\') { at++; continue; }
      const command = /^\\([A-Za-z]+)\*?/.exec(source.slice(at));
      if (!command) { at += 2; continue; }
      const kind = command[1]; at += command[0].length;
      if (kind === 'newif') { const target = /^\s*\\[A-Za-z]+/.exec(source.slice(at)); if (target) at += target[0].length; continue; }
      if (kind.startsWith('if')) { conditional++; continue; }
      if (kind === 'fi') { conditional = Math.max(0, conditional - 1); continue; }
      if (kind === 'begingroup' || kind === 'bgroup') { scoped++; continue; }
      if (kind === 'endgroup' || kind === 'egroup') { scoped = Math.max(0, scoped - 1); continue; }
      if (kind === 'begin') {
        const env = group(source, whitespace(source, at)); if (!env) break;
        if (env.body === 'document') return;
        const end = source.indexOf(`\\end{${env.body}}`, env.end);
        if (end < 0) return; at = end + env.body.length + 6; continue;
      }
      if (kind === 'input' && !conditional && !scoped) {
        const included = group(source, whitespace(source, at)); if (!included) continue;
        at = included.end;
        if (!/^[A-Za-z0-9_./ -]{1,256}$/.test(included.body)) continue;
        const parts = [...filename.split('/').slice(0, -1), ...included.body.split('/')], clean = [];
        for (const part of parts) { if (part === '..') { if (!clean.length) { clean.push('..'); break; } clean.pop(); } else if (part && part !== '.') clean.push(part); }
        let target = clean.join('/'); if (!target.endsWith('.tex')) target += '.tex';
        if (!target.startsWith('../')) scan(target); continue;
      }
      if (!['newcommand', 'renewcommand', 'providecommand', 'def', 'gdef', 'edef', 'xdef', 'let'].includes(kind)) continue;
      let name, target; at = whitespace(source, at);
      if (source[at] === '{') { target = group(source, at); if (!target) break; name = /^\\([A-Za-z]+)$/.exec(target.body)?.[1]; at = target.end; }
      else { const bare = /^\\([A-Za-z]+)/.exec(source.slice(at)); if (!bare) continue; name = bare[1]; at += bare[0].length; }
      if (!name || macros.size >= 128 && !macros.has(name)) continue;
      let arity = 0, valid = ['newcommand', 'providecommand'].includes(kind) && !builtin.has(name);
      at = whitespace(source, at);
      if (source[at] === '[') { const arg = /^\[([0-3])\]/.exec(source.slice(at)); if (!arg) valid = false; else { arity = +arg[1]; at += arg[0].length; } }
      at = whitespace(source, at); const body = group(source, at);
      if (body) { at = body.end; blockNestedDefinitions(body.body); }
      if (conditional || scoped) { if (conditional || kind === 'gdef' || kind === 'xdef') blocked.add(name); continue; }
      if (!body || body.body.length > 1024 || !valid) { macros.set(name, null); continue; }
      const definition = { name, arity, body: body.body };
      if (macros.has(name) && JSON.stringify(macros.get(name)) !== JSON.stringify(definition)) macros.set(name, null);
      else macros.set(name, definition);
    }
  };
  scan(mainFile, true); for (const name of blocked) macros.set(name, null); return macros;
}
function validateMath(source, macros, closure, visiting = new Set(), arity = 0) {
  if (!source || Buffer.byteLength(source) > MAX_FORMULA || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]|\^\^/.test(source)) return false;
  let depth = 0, commands = 0; const stack = [];
  for (let at = 0; at < source.length; at++) {
    const character = source[at];
    if (character === '{') { if (++depth > 24) return false; continue; }
    if (character === '}') { if (--depth < 0) return false; continue; }
    if (character === '#') { if (!arity || !/[1-3]/.test(source[at + 1] || '') || +source[++at] > arity) return false; continue; }
    if (character === '$' || character === '`' || character === '%') return false;
    if (character !== '\\') continue;
    const match = /^[A-Za-z]+/.exec(source.slice(at + 1));
    if (!match) { if (!'\\,;:! |{}%$#&_'.includes(source[++at] || '\0')) return false; continue; }
    const name = match[0]; at += name.length;
    if (++commands > 256) return false;
    if (name === 'begin' || name === 'end') {
      const env = group(source, whitespace(source, at + 1));
      if (!env || !environments.has(env.body)) return false;
      if (name === 'begin') stack.push(env.body); else if (stack.pop() !== env.body) return false;
      at = env.end - 1; continue;
    }
    if (macros.has(name)) {
      const definition = macros.get(name);
      if (!definition || visiting.has(name) || visiting.size >= 8 || closure.size >= 32 && !closure.has(name)) return false;
      let argAt = at + 1;
      for (let index = 0; index < definition.arity; index++) { const arg = group(source, whitespace(source, argAt)); if (!arg) return false; argAt = arg.end; }
      if (!closure.has(name)) {
        const next = new Set(visiting); next.add(name);
        if (!validateMath(definition.body, macros, closure, next, definition.arity)) return false;
        closure.set(name, definition);
      }
      continue;
    }
    if (!builtin.has(name)) return false;
  }
  return depth === 0 && !stack.length;
}
/** Display-only, pure macro expansions. No preamble/aux source is executed. */
export function opinionMathPreambleMacros(files, mainFile) {
  const definitions = macroDefinitions(files, mainFile), result = {};
  for (const [name, definition] of definitions) {
    if (!definition || Object.keys(result).length >= 64) continue;
    const closure = new Map();
    if (validateMath(definition.body, definitions, closure, new Set([name]), definition.arity)) result[`\\${name}`] = definition.body;
  }
  return result;
}
function parseFields(input) {
  const captured = snapshot(input), stale = Boolean(captured.reviewSnapshotId && captured.reviewSnapshotId !== captured.snapshotId), macros = macroDefinitions(input.files, captured.mainFile), index = stale ? new Map() : scopedTokens(input), diagnostics = [], fields = {}, fragments = [], byFormula = new Map(), closure = new Map();
  let total = 0;
  for (const field of FIELDS) {
    let expandedBytes = Buffer.byteLength(captured.fields[field]);
    const tokens = [], source = captured.fields[field].replace(PLACEHOLDER, placeholder => {
      const values = index.get(keyOf(placeholder));
      if (values?.size === 1) {
        const raw = values.values().next().value, nextSize = expandedBytes + Buffer.byteLength(raw) - Buffer.byteLength(placeholder);
        if (nextSize <= MAX_FIELD) { expandedBytes = nextSize; return raw; }
        diagnostics.push(diagnostic('PROTECTED_DISPLAY_LIMIT', field, 'A protected object exceeds the bounded display expansion. See the original source.')); return '受保护对象（详见原文）';
      }
      diagnostics.push(diagnostic('UNRESOLVED_PROTECTED_TOKEN', field, 'A protected object has no unique anchor in this opinion. See the original source.')); return '受保护对象（详见原文）';
    });
    let cursor = 0, at = 0;
    while (at < source.length) {
      let opening, closing, display = false, envName;
      if (source[at] === '\\') {
        if (source[at + 1] === '(' || source[at + 1] === '[') { opening = source.slice(at, at + 2); closing = source[at + 1] === '(' ? '\\)' : '\\]'; display = source[at + 1] === '['; }
        else { const env = /^\\begin\{([^{}]+)\}/.exec(source.slice(at)); if (env && mathEnvironments.has(env[1])) { opening = env[0]; closing = `\\end{${env[1]}}`; display = true; envName = env[1]; } else { at += 2; continue; } }
      } else if (source[at] === '$') { opening = source[at + 1] === '$' ? '$$' : '$'; closing = opening; display = opening.length === 2; }
      if (!opening) { at++; continue; }
      let end = at + opening.length;
      for (;;) { end = source.indexOf(closing, end); if (end < 0 || source[end - 1] !== '\\' || closing.startsWith('\\')) break; end += closing.length; }
      if (end < 0) { diagnostics.push(diagnostic('MALFORMED_MATH', field, 'An unclosed mathematical delimiter is shown as source.')); break; }
      const raw = source.slice(at, end + closing.length); let tex = source.slice(at + opening.length, end).trim();
      if (envName?.startsWith('align')) tex = `\\begin{aligned}${tex}\\end{aligned}`;
      else if (envName?.startsWith('gather')) tex = `\\begin{gathered}${tex}\\end{gathered}`;
      const pending = new Map(closure);
      if (!validateMath(tex, macros, pending) || total + Buffer.byteLength(tex) > MAX_TOTAL || fragments.length >= MAX_FRAGMENTS && !byFormula.has(tex)) {
        pushText(tokens, source.slice(cursor, at)); pushText(tokens, raw);
        diagnostics.push(diagnostic('UNSUPPORTED_MATH', field, 'Unsupported or oversized mathematical source is retained without executing it.'));
      } else {
        pushText(tokens, source.slice(cursor, at));
        let fragment = byFormula.get(tex);
        if (!fragment) { fragment = { fragmentId: `math-${sha(tex).slice(0, 24)}`, tex, page: fragments.length + 1 }; fragments.push(fragment); byFormula.set(tex, fragment); total += Buffer.byteLength(tex); }
        for (const [name, definition] of pending) closure.set(name, definition);
        tokens.push({ type: 'math', tex, original: raw, fragmentId: fragment.fragmentId, page: fragment.page, display });
      }
      cursor = end + closing.length; at = cursor;
    }
    pushText(tokens, source.slice(cursor)); fields[field] = tokens;
    if (tokens.some(token => token.type === 'text' && /\\(?:eqref|ref|autoref|cref|Cref|cite\w*)\b/.test(token.text))) diagnostics.push(diagnostic('REFERENCE_SOURCE_ONLY', field, 'A reference is retained as source; this isolated formula view does not invent manuscript numbering.'));
  }
  return { captured, fields, fragments, closure, diagnostics, stale };
}
function texDocument(parsed) {
  const definitions = [...parsed.closure.values()].map(item => `\\newcommand{\\${item.name}}${item.arity ? `[${item.arity}]` : ''}{${item.body}}`).join('\n');
  return `\\documentclass[multi=reviewmath,border=1pt]{standalone}
\\usepackage{amsmath,amssymb,fontspec,xeCJK}
\\setmainfont{lmroman10-regular.otf}
\\setCJKmainfont{Noto Serif CJK SC}
\\newenvironment{reviewmath}{}{}
\\newsavebox{\\opinionmathbox}
\\newcommand{\\opinionmathitem}[2]{\\sbox{\\opinionmathbox}{\\(\\displaystyle #2\\)}\\typeout{OPINION-MATH-METRIC:#1:\\the\\wd\\opinionmathbox:\\the\\ht\\opinionmathbox:\\the\\dp\\opinionmathbox}\\begin{reviewmath}\\usebox{\\opinionmathbox}\\end{reviewmath}}
${definitions}
\\begin{document}
${parsed.fragments.map((fragment, index) => `\\opinionmathitem{${index}}{${fragment.tex}}`).join('\n')}
\\end{document}
`;
}
async function boundedRead(filename, limit) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > limit) throw Object.assign(new Error('Invalid private render artifact.'), { code: 'INVALID_RENDER_ARTIFACT' });
  const handle = await open(filename, 'r');
  try { const chunks = []; let count = 0; for (;;) { const bytes = Buffer.alloc(Math.min(65536, limit + 1 - count)), result = await handle.read(bytes, 0, bytes.length, null); if (!result.bytesRead) break; count += result.bytesRead; if (count > limit) throw new Error('Artifact limit exceeded.'); chunks.push(bytes.subarray(0, result.bytesRead)); } return Buffer.concat(chunks, count); }
  finally { await handle.close(); }
}
function textFallback(result, code) {
  result.pdf = null; result.fragments = []; result.status = 'text';
  for (const tokens of Object.values(result.fields)) { const merged = []; for (const token of tokens) pushText(merged, token.type === 'math' ? token.original : token.text); tokens.splice(0, tokens.length, ...merged); }
  result.diagnostics.push(diagnostic(code, null, 'Formula compilation is unavailable for this opinion; its source remains readable.'));
  return result;
}
export class OpinionMathRenderer {
  constructor({ compiler = null, maxCacheEntries = 24, maxCacheBytes = 20 * 1024 * 1024 } = {}) {
    this.compiler = compiler; this.maxCacheEntries = Number.isSafeInteger(maxCacheEntries) ? Math.max(1, Math.min(64, maxCacheEntries)) : 24; this.maxCacheBytes = Number.isSafeInteger(maxCacheBytes) ? Math.max(MAX_FIELD, Math.min(64 * 1024 * 1024, maxCacheBytes)) : 20 * 1024 * 1024; this.cache = new Map(); this.pending = new Map(); this.controllers = new Map(); this.cacheBytes = 0; this.closed = false;
  }
  async render(input) {
    const renderKey = opinionMathFingerprint(input);
    if (this.cache.has(renderKey)) { const cached = this.cache.get(renderKey); this.cache.delete(renderKey); this.cacheBytes -= cached.bytes; if (!cached.expiresAt || cached.expiresAt > Date.now()) { this.cache.set(renderKey, cached); this.cacheBytes += cached.bytes; return { ...clone(cached.result), cacheHit: true }; } }
    if (this.pending.has(renderKey)) return clone(await this.pending.get(renderKey));
    if (this.closed || this.pending.size >= 8) { const parsed = parseFields(input); return textFallback({ renderKey, fields: parsed.fields, diagnostics: parsed.diagnostics, fragments: [], pdf: null }, this.closed ? 'RENDER_CLOSED' : 'RENDER_BUSY'); }
    // Copy caller-owned bytes/state before the first asynchronous boundary.
    const frozen = { note: clone(input.note), state: clone(input.state), files: input.files.map(file => ({ path: file.path, bytes: Buffer.from(file.bytes) })), language: input.language };
    const controller = new AbortController(); this.controllers.set(renderKey, controller);
    const promise = this._render(frozen, renderKey, controller.signal).then(result => {
      const bytes = Buffer.byteLength(JSON.stringify(result));
      if (!this.closed && bytes <= this.maxCacheBytes) { this.cache.set(renderKey, { result: clone(result), bytes, expiresAt: !result.pdf && result.diagnostics.length ? Date.now() + 30000 : null }); this.cacheBytes += bytes; while (this.cache.size > this.maxCacheEntries || this.cacheBytes > this.maxCacheBytes) { const key = this.cache.keys().next().value; this.cacheBytes -= this.cache.get(key).bytes; this.cache.delete(key); } }
      return result;
    }).finally(() => { this.pending.delete(renderKey); this.controllers.delete(renderKey); });
    this.pending.set(renderKey, promise); return clone(await promise);
  }
  async close() { this.closed = true; for (const controller of this.controllers.values()) controller.abort(); await Promise.allSettled([...this.pending.values()]); this.cache.clear(); this.cacheBytes = 0; }
  async _render(input, renderKey, signal) {
    const parsed = parseFields(input), result = { renderKey, status: parsed.diagnostics.length ? 'partial' : 'success', fields: parsed.fields, fragments: parsed.fragments, diagnostics: parsed.diagnostics, pdf: null, cacheHit: false };
    if (parsed.stale) return textFallback(result, 'STALE_REVIEW_SOURCE');
    if (!parsed.fragments.length) { result.status = 'text'; return result; }
    if (!this.compiler?.build) return textFallback(result, 'COMPILER_UNAVAILABLE');
    const buildInput = { projectId: parsed.captured.projectId, snapshotId: parsed.captured.snapshotId, engine: 'xelatex', mainFile: 'opinion-math.tex', files: [{ path: 'opinion-math.tex', bytes: Buffer.from(texDocument(parsed)) }], signal };
    try {
      const built = await this.compiler.build(buildInput);
      if (built.status !== 'success') return textFallback(result, 'MATH_COMPILE_FAILED');
      if (built.isolation?.verified !== true || built.inputHash !== inputHash(buildInput) || built.snapshotId !== buildInput.snapshotId || built.projectId !== buildInput.projectId) return textFallback(result, 'RENDER_IDENTITY_MISMATCH');
      const pdf = await boundedRead(built.pdfPath, MAX_PDF);
      if (sha(pdf) !== built.pdfHash || pdf.subarray(0, 5).toString() !== '%PDF-') return textFallback(result, 'RENDER_ARTIFACT_CHANGED');
      const log = (await boundedRead(built.logPath, 8 * 1024 * 1024)).toString('utf8'), metrics = new Map();
      for (const match of log.matchAll(/^OPINION-MATH-METRIC:(\d+):([\d.]+)pt:([\d.]+)pt:([\d.]+)pt\s*$/gm)) metrics.set(+match[1], match.slice(2).map(Number));
      if (metrics.size !== parsed.fragments.length) return textFallback(result, 'RENDER_METRICS_INVALID');
      for (const [index, fragment] of parsed.fragments.entries()) {
        const values = metrics.get(index);
        if (!values || values.some(value => !Number.isFinite(value) || value < 0 || value > 2048) || values[0] < .1 || values[1] + values[2] < .1) return textFallback(result, 'RENDER_METRICS_INVALID');
        const [width, height, depth] = values, ratio = 72 / 72.27;
        Object.assign(fragment, { widthPt: (width + 2) * ratio, heightPt: (height + depth + 2) * ratio, depthPt: (depth + 1) * ratio, fontSizePt: 10 });
      }
      for (const tokens of Object.values(parsed.fields)) for (const token of tokens) if (token.type === 'math') Object.assign(token, parsed.fragments[token.page - 1]);
      result.pdf = { base64: pdf.toString('base64'), mimeType: 'application/pdf', hash: built.pdfHash, pageCount: parsed.fragments.length };
      return result;
    } catch { return textFallback(result, 'MATH_COMPILE_FAILED'); }
  }
}
