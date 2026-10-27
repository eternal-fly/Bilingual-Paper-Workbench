import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const implementation = await import('../src/core.mjs').catch(() => ({}));
const hash = text => createHash('sha256').update(text).digest('hex');
const sample = '\\documentclass{article}\r\n\\begin{document}\r\n\\section{Introduction}\r\n\r\nA quantum state 😀 has energy $E=mc^2$ and reference \\cite{a}.\r\n\r\nThe result holds under this assumption.\r\n\r\n\\unknownmacro{Unsafe text}\r\n\\end{document}\r\n';

async function setup(t, source = sample) {
  assert.equal(typeof implementation.PaperService, 'function', 'PaperService must implement the review core');
  const tempRoot = path.resolve('test/.tmp');
  await mkdir(tempRoot, { recursive: true });
  const base = await mkdtemp(path.join(tempRoot, 'paper-core-test-'));
  const root = path.join(base, 'paper');
  await mkdir(root);
  await writeFile(path.join(root, 'main.tex'), source);
  const dataRoot = path.join(base, 'private');
  const service = new implementation.PaperService({ dataRoot });
  t.after(async () => {
    assert.ok(path.resolve(base).startsWith(tempRoot + path.sep + 'paper-core-test-'));
    await rm(base, { recursive: true, force: true });
  });
  await service.openProject({ root, mainFile: 'main.tex', sourceLanguage: 'en', targetLanguage: 'zh-CN' });
  return { service, base, root, dataRoot };
}
const safeSegment = state => state.segments.find(s => s.source.startsWith('A quantum'));

test('extracts UTF-8 byte intervals without corrupting emoji or CRLF', async t => {
  const { service } = await setup(t);
  const state = await service.getState();
  const segment = safeSegment(state);
  assert.ok(segment.translatable);
  assert.equal(Buffer.from(sample).subarray(segment.startByte, segment.endByte).toString(), segment.source);
  assert.equal(segment.beforeHash, hash(segment.source));
  assert.equal(segment.protectedTokens.length, 2);
  assert.equal(segment.protectedTokens[0].raw, '$E=mc^2$');
  assert.equal(segment.protectedTokens[1].raw, '\\cite{a}');
  assert.equal(state.capabilities.secureCompile, false);
  assert.equal(state.capabilities.directApply, false);
});

test('unknown commands stay opaque and cannot enter model requests', async t => {
  const { service } = await setup(t);
  const segment = (await service.getState()).segments.find(s => s.source.includes('unknownmacro'));
  assert.equal(segment.translatable, false);
  await assert.rejects(service.createRequest({ segmentIds: [segment.id], kind: 'revision' }), { code: 'UNSUPPORTED_TEX' });
});

test('multiple main candidates require an explicit choice', async t => {
  const { service, root } = await setup(t);
  await writeFile(path.join(root, 'second.tex'), '\\documentclass{article}\n\\begin{document}Other\\end{document}');
  const state = await service.openProject({ root });
  assert.deepEqual(state.mainCandidates, ['main.tex', 'second.tex']);
  assert.equal(state.project, null);
});

test('dependency scans preserve files and diagnose missing references', async t => {
  const { service, root } = await setup(t, '\\documentclass{article}\n\\begin{document}\n\\input{section}\n\\includegraphics{figure.png}\n\\bibliography{refs}\n\\end{document}');
  await writeFile(path.join(root, 'section.tex'), 'Included paragraph.');
  await writeFile(path.join(root, 'refs.bib'), '@article{a,title={A}}');
  const state = await service.refreshProject();
  assert.ok(state.project.files.some(f => f.path === 'section.tex'));
  assert.ok(state.segments.some(s => s.path === 'section.tex' && s.source === 'Included paragraph.'));
  assert.ok(state.project.diagnostics.some(d => d.code === 'DEPENDENCY_MISSING' && d.path === 'figure.png'));
});

test('root traversal and non-UTF8 files fail closed', async t => {
  const { service, root } = await setup(t);
  await assert.rejects(service.openProject({ root, mainFile: '../outside.tex' }), { code: 'PERMISSION_DENIED' });
  await writeFile(path.join(root, 'bad.tex'), Buffer.from([0xff, 0xfe, 0x41]));
  await assert.rejects(service.openProject({ root, mainFile: 'bad.tex' }), { code: 'UNSUPPORTED_ENCODING' });
});

test('symlinked inputs cannot escape the approved root', async t => {
  const { service, root, base } = await setup(t);
  const outside = path.join(base, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.tex'), 'Secret');
  try { await symlink(outside, path.join(root, 'linked'), 'junction'); }
  catch (e) { if (e.code === 'EPERM') return t.skip('OS denies creating test junction'); throw e; }
  await assert.rejects(service.openProject({ root, mainFile: 'linked/secret.tex' }), { code: 'PERMISSION_DENIED' });
});

test('drafts persist independently by language without touching source', async t => {
  const { service, root, dataRoot } = await setup(t);
  const segment = safeSegment(await service.getState());
  await service.saveDraft({ segmentId: segment.id, language: 'zh-CN', text: '人工译稿', expectedRevision: 0 });
  await service.saveDraft({ segmentId: segment.id, language: 'fr', text: 'Brouillon', expectedRevision: 0 });
  assert.equal(await readFile(path.join(root, 'main.tex'), 'utf8'), sample);
  const reopened = new implementation.PaperService({ dataRoot });
  await reopened.openProject({ root, mainFile: 'main.tex' });
  const state = await reopened.getState();
  const current = safeSegment(state);
  assert.equal(current.id, segment.id);
  assert.equal(state.translations['zh-CN'][current.id].text, '人工译稿');
  assert.equal(state.translations.fr[current.id].text, 'Brouillon');
});

test('concurrent draft saves use revision CAS', async t => {
  const { service } = await setup(t);
  const segment = safeSegment(await service.getState());
  const results = await Promise.allSettled([
    service.saveDraft({ segmentId: segment.id, language: 'zh-CN', text: 'first', expectedRevision: 0 }),
    service.saveDraft({ segmentId: segment.id, language: 'zh-CN', text: 'second', expectedRevision: 0 }),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'VERSION_CONFLICT');
});

test('translation results preserve protected placeholders and bind the registered request', async t => {
  const { service } = await setup(t);
  const segment = safeSegment(await service.getState());
  const request = await service.createRequest({ segmentIds: [segment.id], kind: 'translation', language: 'zh-CN', bindingId: 'thread-A' });
  assert.equal(request.bindingId, 'thread-A');
  assert.equal(request.segments[0].text.includes('$E=mc^2$'), false);
  const text = request.segments[0].text.replace('A quantum state', '一个量子态');
  await service.submitTranslationResult({ requestId: request.requestId, translations: [{ segmentId: segment.id, text }] });
  const state = await service.getState();
  assert.equal(state.translations['zh-CN'][segment.id].text.includes('$E=mc^2$'), true);
  assert.equal(state.translations['zh-CN'][segment.id].revision, 1);
});

test('missing or reordered protected tokens reject model results', async t => {
  const { service } = await setup(t);
  const segment = safeSegment(await service.getState());
  const request = await service.createRequest({ segmentIds: [segment.id], kind: 'translation', language: 'zh-CN' });
  await assert.rejects(service.submitTranslationResult({ requestId: request.requestId, translations: [{ segmentId: segment.id, text: '丢失公式与引用' }] }), { code: 'PROTECTED_TOKEN_CHANGED' });
});

test('late translation cannot overwrite a manual draft', async t => {
  const { service } = await setup(t);
  const segment = safeSegment(await service.getState());
  const request = await service.createRequest({ segmentIds: [segment.id], kind: 'translation', language: 'zh-CN' });
  await service.saveDraft({ segmentId: segment.id, language: 'zh-CN', text: '人工保留内容', expectedRevision: 0 });
  const result = await service.submitTranslationResult({ requestId: request.requestId, translations: [{ segmentId: segment.id, text: request.segments[0].text }] });
  assert.equal(result.status, 'stale');
  assert.equal((await service.getState()).translations['zh-CN'][segment.id].text, '人工保留内容');
});

test('a newer translation request supersedes an older result', async t => {
  const { service } = await setup(t);
  const segment = safeSegment(await service.getState());
  const first = await service.createRequest({ segmentIds: [segment.id], kind: 'translation', language: 'zh-CN' });
  const second = await service.createRequest({ segmentIds: [segment.id], kind: 'translation', language: 'zh-CN' });
  await service.submitTranslationResult({ requestId: second.requestId, translations: [{ segmentId: segment.id, text: second.segments[0].text }] });
  const result = await service.submitTranslationResult({ requestId: first.requestId, translations: [{ segmentId: segment.id, text: first.segments[0].text }] });
  assert.equal(result.status, 'stale');
  assert.equal((await service.getState()).translations['zh-CN'][segment.id].revision, 1);
});

test('model cannot set its own approval, project, author or application state', async t => {
  const { service } = await setup(t);
  const segment = safeSegment(await service.getState());
  const request = await service.createRequest({ segmentIds: [segment.id], kind: 'revision' });
  for (const field of ['approved', 'reviewState', 'applicationState', 'author', 'projectId']) {
    await assert.rejects(service.proposeRevision({ requestId: request.requestId, edits: [{ segmentId: segment.id, beforeHash: segment.beforeHash, replacement: request.segments[0].text }], reason: 'Test', [field]: 'applied' }), { code: 'INVALID_INPUT' });
  }
});

test('revision proposal, preview and patch export leave the CRLF source unchanged', async t => {
  const { service, root } = await setup(t);
  const segment = safeSegment(await service.getState());
  const request = await service.createRequest({ segmentIds: [segment.id], kind: 'revision', bindingId: 'thread-A' });
  const proposal = await service.proposeRevision({ requestId: request.requestId, edits: [{ segmentId: segment.id, beforeHash: segment.beforeHash, replacement: request.segments[0].text.replace('has energy', 'has total energy') }], reason: 'Clarify wording' });
  assert.equal(proposal.reviewState, 'pending');
  assert.equal(proposal.applicationState, 'notApplied');
  assert.equal(proposal.author, 'ai');
  const preview = await service.previewTransaction({ proposalIds: [proposal.proposalId] });
  assert.equal(preview.compile.status, 'unavailable');
  assert.match(preview.candidateHash, /^[a-f0-9]{64}$/);
  assert.equal(preview.files[0].content, sample.replace('has energy', 'has total energy'));
  const exported = await service.exportPatch({ proposalIds: [proposal.proposalId] });
  assert.match(exported.patch, /\+A quantum state 😀 has total energy/);
  assert.equal(await readFile(path.join(root, 'main.tex'), 'utf8'), sample);
});

test('replacement cannot inject executable TeX or invent protected objects', async t => {
  const { service } = await setup(t);
  const segment = safeSegment(await service.getState());
  const request = await service.createRequest({ segmentIds: [segment.id], kind: 'revision' });
  await assert.rejects(service.proposeRevision({ requestId: request.requestId, edits: [{ segmentId: segment.id, beforeHash: segment.beforeHash, replacement: request.segments[0].text + '\\input{secret}' }], reason: 'Bad' }), { code: 'UNSUPPORTED_TEX' });
});

test('external edits invalidate registered requests and pending proposals', async t => {
  const { service, root } = await setup(t);
  const segment = safeSegment(await service.getState());
  const request = await service.createRequest({ segmentIds: [segment.id], kind: 'revision' });
  const proposal = await service.proposeRevision({ requestId: request.requestId, edits: [{ segmentId: segment.id, beforeHash: segment.beforeHash, replacement: request.segments[0].text.replace('has energy', 'has total energy') }], reason: 'Wording' });
  await writeFile(path.join(root, 'main.tex'), sample.replace('A quantum state', 'A different state'));
  const state = await service.refreshProject();
  assert.equal(state.proposals.find(p => p.proposalId === proposal.proposalId).reviewState, 'stale');
  assert.ok(state.proposals.some(p => p.applicationState === 'externallyApplied'));
  await assert.rejects(service.previewTransaction({ proposalIds: [proposal.proposalId] }), { code: 'VERSION_CONFLICT' });
});

test('batch proposal conflicts are rejected and pending rejects do not change files', async t => {
  const { service, root } = await setup(t);
  const segment = safeSegment(await service.getState());
  const ids = [];
  for (const word of ['total', 'measured']) {
    const request = await service.createRequest({ segmentIds: [segment.id], kind: 'revision' });
    const p = await service.proposeRevision({ requestId: request.requestId, edits: [{ segmentId: segment.id, beforeHash: segment.beforeHash, replacement: request.segments[0].text.replace('has energy', `has ${word} energy`) }], reason: 'Wording' });
    ids.push(p.proposalId);
  }
  await assert.rejects(service.previewTransaction({ proposalIds: ids }), { code: 'OVERLAPPING_EDITS' });
  await service.rejectProposal({ proposalId: ids[0] });
  assert.equal((await service.getState()).proposals.find(p => p.proposalId === ids[0]).reviewState, 'rejected');
  assert.equal(await readFile(path.join(root, 'main.tex'), 'utf8'), sample);
});

test('duplicate identical proposal result returns one server-issued proposal', async t => {
  const { service } = await setup(t);
  const segment = safeSegment(await service.getState());
  const request = await service.createRequest({ segmentIds: [segment.id], kind: 'revision' });
  const dto = { requestId: request.requestId, edits: [{ segmentId: segment.id, beforeHash: segment.beforeHash, replacement: request.segments[0].text.replace('has energy', 'has total energy') }], reason: 'Clarify' };
  const first = await service.proposeRevision(dto);
  const second = await service.proposeRevision(dto);
  assert.equal(first.proposalId, second.proposalId);
  assert.equal((await service.getState()).proposals.length, 1);
  await assert.rejects(service.proposeRevision({ ...dto, reason: 'Changed retry' }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('category-code changes and redefined text commands make automatic editing opaque', async t => {
  const source = '\\documentclass{article}\n\\catcode`\\@=11\n\\renewcommand{\\emph}[1]{#1}\n\\begin{document}\nOrdinary looking text.\n\\end{document}';
  const { service } = await setup(t, source);
  const segment = (await service.getState()).segments.find(s => s.source.includes('Ordinary'));
  assert.equal(segment.translatable, false);
  assert.ok(segment.opaqueReasons.some(reason => reason.includes('syntax')));
});

test('a registered result rejects unknown segments and an incorrect source hash', async t => {
  const { service } = await setup(t);
  const state = service.getState(), segment = safeSegment(state), other = state.segments.find(s => s.translatable && s.id !== segment.id);
  const request = await service.createRequest({ segmentIds: [segment.id], kind: 'revision' });
  await assert.rejects(service.proposeRevision({ requestId: request.requestId, edits: [{ segmentId: other.id, beforeHash: other.beforeHash, replacement: other.displayText }], reason: 'Out of scope' }), { code: 'PERMISSION_DENIED' });
  await assert.rejects(service.proposeRevision({ requestId: request.requestId, edits: [{ segmentId: segment.id, beforeHash: '0'.repeat(64), replacement: segment.displayText }], reason: 'Wrong version' }), { code: 'VERSION_CONFLICT' });
});

test('readPdf labels an existing artifact as unverified and does not bind a false build', async t => {
  const { service, root } = await setup(t);
  await assert.rejects(service.readPdf(), { code: 'PDF_UNAVAILABLE' });
  await writeFile(path.join(root, 'main.pdf'), '%PDF-1.7\nsynthetic bytes, not a rendered document');
  const result = await service.readPdf();
  assert.equal(result.provenance, 'existing-unverified');
  assert.equal(result.snapshotId, null);
  assert.equal(Buffer.from(result.base64, 'base64').toString(), '%PDF-1.7\nsynthetic bytes, not a rendered document');
});

test('an external edit after proposal creation prevents export without needing manual refresh', async t => {
  const { service, root } = await setup(t);
  const segment = safeSegment(service.getState());
  const request = await service.createRequest({ segmentIds: [segment.id], kind: 'revision' });
  const proposal = await service.proposeRevision({ requestId: request.requestId, edits: [{ segmentId: segment.id, beforeHash: segment.beforeHash, replacement: segment.displayText.replace('has energy', 'has measured energy') }], reason: 'Clarify' });
  await writeFile(path.join(root, 'main.tex'), sample + '% external\r\n');
  await assert.rejects(service.exportPatch({ proposalIds: [proposal.proposalId] }), { code: 'VERSION_CONFLICT' });
});

test('identical repeated paragraphs have distinct stable IDs', async t => {
  const source = '\\documentclass{article}\n\\begin{document}\nSame paragraph.\n\nSame paragraph.\n\\end{document}';
  const { service } = await setup(t, source);
  const before = service.getState().segments.filter(s => s.source === 'Same paragraph.');
  assert.equal(before.length, 2);
  assert.notEqual(before[0].id, before[1].id);
  await service.refreshProject();
  const after = service.getState().segments.filter(s => s.source === 'Same paragraph.');
  assert.deepEqual(after.map(s => s.id), before.map(s => s.id));
});

test('harmless caption-name and abstract presentation redefinitions retain readable paragraphs', async t => {
  const source = '\\documentclass{article}\n\\renewcommand{\\figurename}{Illustration}\n\\renewcommand{\\tablename}{Table}\n\\renewenvironment{abstract}{\\begin{quote}}{\\end{quote}}\n\\begin{document}\nOrdinary text remains editable.\n\\end{document}';
  const { service } = await setup(t, source);
  assert.equal(service.getState().segments.find(s => s.source.includes('Ordinary')).translatable, true);
});

test('different main files in one directory keep separate project identities and drafts', async t => {
  const { service, root } = await setup(t);
  const initial = service.getState(), segment = safeSegment(initial);
  await service.saveDraft({ segmentId: segment.id, language: 'zh-CN', text: 'Only paper A', expectedRevision: 0 });
  await writeFile(path.join(root, 'second.tex'), sample);
  const other = await service.openProject({ root, mainFile: 'second.tex' });
  assert.notEqual(other.project.id, initial.project.id);
  assert.deepEqual(other.translations, {});
});

test('revision requests carry the selected persisted draft with its exact revision', async t => {
  const { service } = await setup(t);
  const segment = safeSegment(service.getState());
  await service.saveDraft({ segmentId: segment.id, language: 'zh-CN', text: '我的修改意图', expectedRevision: 0 });
  const request = await service.createRequest({ segmentIds: [segment.id], language: 'zh-CN', kind: 'revision' });
  assert.equal(request.segments[0].translationDraft.text, '我的修改意图');
  assert.equal(request.segments[0].translationDraft.revision, 1);
});

test('a second service reloads the durable draft before checking revision CAS', async t => {
  const { service, root, dataRoot } = await setup(t);
  const other = new implementation.PaperService({ dataRoot });
  await other.openProject({ root, mainFile: 'main.tex' });
  const segment = safeSegment(service.getState());
  await service.saveDraft({ segmentId: segment.id, language: 'zh-CN', text: 'First process draft', expectedRevision: 0 });
  await assert.rejects(other.saveDraft({ segmentId: segment.id, language: 'zh-CN', text: 'Stale process draft', expectedRevision: 0 }), { code: 'VERSION_CONFLICT' });
  assert.equal(other.getState().translations['zh-CN'][segment.id].text, 'First process draft');
});

test('an existing writer lock freezes mutation without deleting or stealing the lock', async t => {
  const { service, dataRoot } = await setup(t);
  const segment = safeSegment(service.getState()), lockPath = path.join(dataRoot, '.write.lock');
  await writeFile(lockPath, '{"owner":"another-writer-or-interrupted-session"}');
  await assert.rejects(service.saveDraft({ segmentId: segment.id, language: 'zh-CN', text: 'Do not save', expectedRevision: 0 }), { code: 'PROJECT_BUSY' });
  assert.equal(await readFile(lockPath, 'utf8'), '{"owner":"another-writer-or-interrupted-session"}');
  assert.deepEqual(service.getState().translations, {});
});

test('a failed project-open persistence leaves the previous root and draft store active', async t => {
  const { service, root, dataRoot } = await setup(t);
  const initial = service.getState(), initialRoot = service.getProjectRoot();
  const nextRoot = path.join(path.dirname(root), 'other-paper');
  await mkdir(nextRoot);
  await writeFile(path.join(nextRoot, 'main.tex'), sample.replace('A quantum state', 'Another state'));
  const nextId = `project-${hash((await realpath(nextRoot)).toLowerCase() + '\0main.tex').slice(0, 24)}`;
  await mkdir(path.join(dataRoot, 'projects', nextId, 'state.json'), { recursive: true });
  await assert.rejects(service.openProject({ root: nextRoot, mainFile: 'main.tex' }));
  assert.equal(service.getState().project.id, initial.project.id);
  assert.equal(service.getProjectRoot(), initialRoot);
  const segment = safeSegment(service.getState());
  await service.saveDraft({ segmentId: segment.id, language: 'zh-CN', text: 'Still original project', expectedRevision: 0 });
  assert.equal(service.getState().translations['zh-CN'][segment.id].text, 'Still original project');
});

test('simultaneous writers from separate service instances cannot both save revision zero', async t => {
  const { service, root, dataRoot } = await setup(t);
  const other = new implementation.PaperService({ dataRoot });
  await other.openProject({ root, mainFile: 'main.tex' });
  const segment = safeSegment(service.getState());
  const results = await Promise.allSettled([
    service.saveDraft({ segmentId: segment.id, language: 'zh-CN', text: 'Writer A', expectedRevision: 0 }),
    other.saveDraft({ segmentId: segment.id, language: 'zh-CN', text: 'Writer B', expectedRevision: 0 }),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(['PROJECT_BUSY', 'VERSION_CONFLICT'].includes(results.find(r => r.status === 'rejected').reason.code));
});

test('unsupported environment interiors remain opaque across blank lines', async t => {
  for (const environment of ['verbatim', 'equation', 'tikzpicture', 'tabular']) {
    const { service } = await setup(t, `\\documentclass{article}\n\\begin{document}\n\\begin{${environment}}\n\nNever translate this code block.\n\n\\end{${environment}}\n\nA safe paragraph.\n\\end{document}`);
    assert.equal(service.getState().segments.find(s => s.source === 'Never translate this code block.').translatable, false, environment);
    assert.equal(service.getState().segments.find(s => s.source === 'A safe paragraph.').translatable, true, environment);
  }
});

test('protected comments preserve their newline so following text cannot be swallowed', async t => {
  const { service } = await setup(t, '\\documentclass{article}\n\\begin{document}\nAlpha % kept comment\nBeta $x$.\n\\end{document}');
  const segment = service.getState().segments.find(s => s.source.startsWith('Alpha'));
  const request = await service.createRequest({ segmentIds: [segment.id], kind: 'revision' });
  const proposal = await service.proposeRevision({ requestId: request.requestId, edits: [{ segmentId: segment.id, beforeHash: segment.beforeHash, replacement: segment.displayText.replaceAll('\n', ' ') }], reason: 'Preserve comment semantics' });
  assert.equal(proposal.edits[0].replacement.includes('% kept comment\nBeta'), true);
});

test('a UTF-8 BOM does not shift source byte intervals or prevent a correct preview', async t => {
  const { service } = await setup(t, '\uFEFF' + sample);
  const segment = safeSegment(service.getState());
  const request = await service.createRequest({ segmentIds: [segment.id], kind: 'revision' });
  const proposal = await service.proposeRevision({ requestId: request.requestId, edits: [{ segmentId: segment.id, beforeHash: segment.beforeHash, replacement: segment.displayText.replace('has energy', 'has total energy') }], reason: 'BOM preserved' });
  const preview = await service.previewTransaction({ proposalIds: [proposal.proposalId] });
  assert.equal(preview.files[0].content, '\uFEFF' + sample.replace('has energy', 'has total energy'));
});

test('math spanning paragraph boundaries cannot expose internal natural-looking text for revision', async t => {
  const { service } = await setup(t, '\\documentclass{article}\n\\begin{document}\n$$\n\nNever translate this equation.\n\n$$\n\nA safe paragraph.\n\\end{document}');
  assert.equal(service.getState().segments.find(s => s.source === 'Never translate this equation.').translatable, false);
});

test('a replacement cannot merge a protected control word into following natural text', async t => {
  const { service } = await setup(t, '\\documentclass{article}\n\\begin{document}\n\\noindent Original text.\n\\end{document}');
  const segment = service.getState().segments.find(s => s.source.includes('Original'));
  const request = await service.createRequest({ segmentIds: [segment.id], kind: 'revision' });
  await assert.rejects(service.proposeRevision({ requestId: request.requestId, edits: [{ segmentId: segment.id, beforeHash: segment.beforeHash, replacement: segment.displayText.replace(' Original', 'Changed') }], reason: 'Missing control-word delimiter' }), { code: 'UNSUPPORTED_TEX' });
});

test('unbraced dependency commands remain opaque rather than exposing their path as prose', async t => {
  const { service } = await setup(t, '\\documentclass{article}\n\\begin{document}\n\\input section\n\\end{document}');
  assert.equal(service.getState().segments.find(s => s.source.includes('input')).translatable, false);
});

test('later dynamic TeX assignments do not retroactively disable earlier paragraphs', async t => {
  const source = '\\documentclass{article}\n\\begin{document}\nEarlier prose is editable.\n\n\\let\\localbib\\relax\n\nLater prose needs manual review.\n\\end{document}';
  const { service } = await setup(t, source);
  assert.equal(service.getState().segments.find(s => s.source.startsWith('Earlier')).translatable, true);
  assert.equal(service.getState().segments.find(s => s.source.startsWith('Later')).translatable, false);
});

test('declared zero-argument pure-presentation markers preserve the marker and expose adjacent prose', async t => {
  const source = '\\documentclass{article}\n\\newcommand{\\langmarker}{\\noindent\\normalfont\\sffamily\\scriptsize\\color{blue}\\enspace\\ignorespaces}\n\\begin{document}\n\\langmarker Original prose contains $x$.\n\\end{document}';
  const { service } = await setup(t, source);
  const segment = service.getState().segments.find(s => s.source.startsWith('\\langmarker'));
  assert.equal(segment.translatable, true);
  assert.equal(segment.protectedTokens[0].raw, '\\langmarker');
  const request = await service.createRequest({ segmentIds: [segment.id], kind: 'revision' });
  const proposal = await service.proposeRevision({ requestId: request.requestId, edits: [{ segmentId: segment.id, beforeHash: segment.beforeHash, replacement: segment.displayText.replace('Original prose', 'Revised prose') }], reason: 'Clarify prose' });
  assert.equal(proposal.edits[0].replacement, '\\langmarker Revised prose contains $x$.');
});

test('unknown, argument-bearing and unsafe-body markers remain opaque', async t => {
  const cases = [
    ['', '\\unknownmarker Text.'],
    ['\\newcommand{\\argmarker}[1]{\\noindent}', '\\argmarker Text.'],
    ['\\newcommand{\\filemarker}{\\input{secret}}', '\\filemarker Text.'],
    ['\\newcommand{\\textmarker}{Hidden words}', '\\textmarker Text.'],
    ['\\newcommand{\\colormarker}{\\color{\\unsafe}}', '\\colormarker Text.'],
  ];
  for (const [declaration, invocation] of cases) {
    const { service } = await setup(t, `\\documentclass{article}\n${declaration}\n\\begin{document}\n${invocation}\n\\end{document}`);
    assert.equal(service.getState().segments.find(s => s.source === invocation).translatable, false, invocation);
  }
});

test('a later marker redefinition invalidates only later marker invocations', async t => {
  const source = '\\documentclass{article}\n\\newcommand{\\marker}{\\noindent\\normalfont}\n\\begin{document}\n\\marker Earlier text.\n\n\\renewcommand{\\marker}{\\input{secret}}\n\n\\marker Later text.\n\\end{document}';
  const { service } = await setup(t, source);
  assert.equal(service.getState().segments.find(s => s.source === '\\marker Earlier text.').translatable, true);
  assert.equal(service.getState().segments.find(s => s.source === '\\marker Later text.').translatable, false);
});

test('redefined formatting primitives cannot make an unsafe marker appear presentation-only', async t => {
  const source = '\\documentclass{article}\n\\renewcommand{\\normalfont}{\\input{secret}}\n\\newcommand{\\marker}{\\normalfont}\n\\begin{document}\n\\marker Text must remain opaque.\n\\end{document}';
  const { service } = await setup(t, source);
  assert.equal(service.getState().segments.find(s => s.source.startsWith('\\marker')).translatable, false);
});

test('a bounded static language label inside a font group stays protected with its marker', async t => {
  const source = '\\documentclass{article}\n\\newcommand{\\langlabel}{\\par\\noindent{\\normalfont\\sffamily\\scriptsize\\color{Muted}EN}\\enspace\\ignorespaces}\n\\begin{document}\n\\langlabel Editable source prose.\n\\end{document}';
  const { service } = await setup(t, source);
  const segment = service.getState().segments.find(s => s.source.startsWith('\\langlabel'));
  assert.equal(segment.translatable, true);
  assert.equal(segment.protectedTokens[0].raw, '\\langlabel');
  assert.equal(segment.visibleText, 'Editable source prose.');
});

test('unformatted, spaced, or long text-producing marker bodies remain opaque', async t => {
  for (const body of ['EN', '{\\sffamily Hidden words}', '{\\sffamily UnboundedStaticLabelText}', '{\\sffamily EN\\input{secret}}']) {
    const { service } = await setup(t, `\\documentclass{article}\n\\newcommand{\\marker}{${body}}\n\\begin{document}\n\\marker Protected prose.\n\\end{document}`);
    assert.equal(service.getState().segments.find(s => s.source.startsWith('\\marker')).translatable, false, body);
  }
});

test('an exact declared named-color prose environment exposes only its natural-language contents', async t => {
  const source = '\\documentclass{article}\n\\newenvironment{coloredprose}[1]{\\par\\begingroup\\color{#1}}{\\par\\endgroup\\smallskip}\n\\begin{document}\n\\begin{coloredprose}{MainColor}\n\nReadable scientific prose with $x$.\n\n\\end{coloredprose}\n\\end{document}';
  const { service } = await setup(t, source);
  const segment = service.getState().segments.find(s => s.source.startsWith('Readable'));
  assert.equal(segment.translatable, true);
  const request = await service.createRequest({ segmentIds: [segment.id], kind: 'revision' });
  const proposal = await service.proposeRevision({ requestId: request.requestId, edits: [{ segmentId: segment.id, beforeHash: segment.beforeHash, replacement: segment.displayText.replace('Readable', 'Revised') }], reason: 'Edit prose only' });
  const preview = await service.previewTransaction({ proposalIds: [proposal.proposalId] });
  assert.equal(preview.files[0].content, source.replace('Readable', 'Revised'));
});

test('unsafe declared environments and nonliteral color arguments keep all contents opaque', async t => {
  const cases = [
    ['\\par\\begingroup\\color{#1}', '\\par\\endgroup\\smallskip', '\\dynamiccolor'],
    ['\\input{#1}', '\\par\\endgroup\\smallskip', 'MainColor'],
    ['\\par\\begingroup\\color{#1}', '\\input{secret}', 'MainColor'],
  ];
  for (const [begin, end, color] of cases) {
    const { service } = await setup(t, `\\documentclass{article}\n\\newenvironment{coloredprose}[1]{${begin}}{${end}}\n\\begin{document}\n\\begin{coloredprose}{${color}}\n\nThis content stays opaque.\n\n\\end{coloredprose}\n\\end{document}`);
    assert.equal(service.getState().segments.find(s => s.source === 'This content stays opaque.').translatable, false, color);
  }
});
