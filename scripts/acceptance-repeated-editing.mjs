import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, readdir, chmod } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CompilerWorker } from '../src/compiler/worker.mjs';
import { PaperApplication } from '../src/application.mjs';
import { VersionWorkflow } from '../src/version-workflow.mjs';
import { DesktopTranslationTasks } from '../src/translation-tasks.mjs';
import { createPaperServer } from '../src/server.mjs';
import { startLocalWeb } from '../src/local-web.mjs';
import { ReleaseUpdateChecker } from '../src/update-checker.mjs';
import { deriveEnglishWriteback } from '../ui/writeback-state.mjs';
import { loadPlaywright, browserOptions } from './ui-qa-support.mjs';

// This opt-in acceptance creates its own paper, reviews and translations.
// It cannot select an existing manuscript or operate an existing Desktop chat.
const root = fileURLToPath(new URL('../', import.meta.url));
const releaseVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const runtimeRoot = process.env.PAPER_EDITOR_TEST_RUNTIME;
assert(runtimeRoot && path.isAbsolute(runtimeRoot), 'Set PAPER_EDITOR_TEST_RUNTIME to a prepared isolated compiler runtime.');
const parent = path.join(root, `work/a${releaseVersion.replaceAll('.', '')}`); await mkdir(parent, { recursive: true });
const run = await mkdtemp(path.join(parent, 'roundtrip-')), sourceRoot = path.join(run, 'source'), dataRoot = path.join(run, 'state'), contextDir = path.join(run, 'context');
await mkdir(sourceRoot); await mkdir(contextDir);
const hash = value => createHash('sha256').update(value).digest('hex');
const thread = 'synthetic-multiple-edit-chat', instanceId = 'synthetic-multiple-edit-session';
const failedActions = [];
const protectedSaveRetries = [];
const checks = [], artifacts = [], check = (name, details = {}) => { checks.push({ name, ...details }); console.log(JSON.stringify({ check: name, ...details })); };
const original = String.raw`\documentclass[11pt]{article}
\usepackage{amsmath,amssymb}
\usepackage{lmodern}
\renewcommand{\figurename}{Illustration}
\newcommand{\ClosedZero}{STATIC}
\newcommand{\ClosedOne}[1]{#1}
\title{A Small Synthetic Revision Study}
\author{Example Research Group}
\date{}
\begin{document}
\maketitle
\section{Introduction}

We study a synthetic revision workflow with a fixed illustrative scalar $x=1$ and an explicit reference to \cite{Alpha}. This example tests editing and persistence rather than a scientific claim; see \eqref{eq:first}.

\section{Method}

The independent second paragraph keeps the illustrative value $y=2$ while the first paragraph changes. Its source identity should remain stable when unrelated text is written back, and it cites \cite{Beta}.

\begin{equation}
a+b=c.\label{eq:first}
\end{equation}
\begin{equation}
d+e=f.\label{eq:second}
\end{equation}

\section{Limitations}

The demonstration has no experimental data and makes no accuracy guarantee. A reviewer may keep this concern pending, ask for another revision, or accept a precisely scoped wording change after checking it.

\section{Inline formatting}

An inline example uses Section~1 and \textbf{clear scope}, with a literal 10\% value. A removable sentence links Part~2 to Section~3 and Appendix~A.

\section{Special structures}

Special spacing keeps normal words, Section~4, control\ space, thin\,space and wide\quad space.

Escaped symbols remain literal \{braces\}, 25\%, \#tag, \& pair, \$price and under\_score.

Nested formatting keeps \textbf{outer \emph{inner} words} alongside \ClosedZero{} and \ClosedOne{fixed operand}.

Mathematical notation keeps $u+v=w$, $\frac{1}{2}\vec{x}\in\mathbb{R}^{n}$, and \cite{Alpha}; compare \eqref{eq:align-first}.

\begin{align}
r+s&=t,\label{eq:align-first}\\
p+q&=v.\label{eq:align-second}
\end{align}

\bibliographystyle{plain}
\bibliography{references}
\end{document}
`;
await writeFile(path.join(sourceRoot, 'main.tex'), original, { flag: 'wx' });
await writeFile(path.join(sourceRoot, 'references.bib'), '@article{Alpha,title={A synthetic first reference},author={Example, A.},journal={Example Notes},year={2026}}\n@article{Beta,title={A synthetic second reference},author={Example, B.},journal={Example Notes},year={2026}}\n', { flag: 'wx' });
const reviewDocument = { notes: [
  { title: 'R1: State the demonstration scope', body: 'Clarify that the first paragraph is an illustrative workflow, and retain its exact scalar and reference.' },
  { title: 'R2: Revise the independent method wording', body: 'Rewrite the second paragraph more directly while retaining its independent value and bibliography key.' },
  { title: 'R3: Keep limitations pending', body: 'The absence of experimental evidence should remain an explicit limitation until new evidence is available.' },
  { title: 'R4: Request another pass', body: 'Reconsider the introduction wording after the first adopted change; a later author decision is required.' },
] };
const reviewText = JSON.stringify(reviewDocument, null, 2);
await writeFile(path.join(run, 'review-comments.json'), reviewText, { flag: 'wx' });
const specialTranslationPairs = [
  ['Special structures', '特殊结构'], ['Special spacing keeps', '特殊空白保留'], ['normal words', '普通词语'],
  ['control', '控制'], ['thin', '窄'], ['wide', '宽'], ['space', '空格'],
  ['Escaped symbols remain literal', '转义符保留字面形式'], ['braces', '花括号'], ['tag', '标签'], ['pair', '配对'], ['price', '价格'], ['under', '下方'], ['score', '划线'],
  ['Nested formatting keeps', '嵌套排版保留'], ['outer', '外层'], ['inner', '内层'], ['words', '文字'], ['alongside', '以及'],
  ['Mathematical notation keeps', '数学记号保留'], ['; compare ', '；对照 '],
];
function translateFixture(text) {
  const pairs = [
    ['A Small Synthetic Revision Study', '小型合成修订研究'], ['Introduction', '引言'], ['Method', '方法'], ['Limitations', '局限性'], ['Inline formatting', '行内排版'],
    ['We study a synthetic revision workflow with a fixed illustrative scalar ', '我们研究一个合成修订流程，固定示例标量为 '],
    [' and an explicit reference to ', '，并明确引用 '],
    ['. This example tests editing and persistence rather than a scientific claim; see ', '。本示例测试编辑与持久保存流程，不提出科学结论；参见 '],
    ['The independent second paragraph keeps the illustrative value ', '独立的第二段保留示例数值 '],
    [' while the first paragraph changes. Its source identity should remain stable when unrelated text is written back, and it cites ', '，同时允许第一段发生变化。其他段落写回时，本段的源码关联应保持稳定，并引用 '],
    ['The demonstration has no experimental data and makes no accuracy guarantee. A reviewer may keep this concern pending, ask for another revision, or accept a precisely scoped wording change after checking it.', '本演示没有实验数据，也不保证准确率。审阅者可以将此意见保持待定、要求再次修改，或在核对后采纳范围明确的措辞修改。'],
    ['An inline example uses Section', '一个行内示例使用第'], ['1 and ', '1节和'], ['clear scope', '清晰的范围'], [', with a literal 10', '，其中包含字面值10'], [' value.', '。'], ['A removable sentence links Part', '可删除句子连接第'], [' to Section', '到第'], [' and Appendix', '和附录'],
  ];
  for (const [before, after] of pairs) text = text.replaceAll(before, after);
  for (const [before, after] of specialTranslationPairs) text = text.replaceAll(before, after);
  return text.replace(/\.$/u, '。');
}
function readableDraft(paragraph, state) {
  let text = state.translations['zh-CN']?.[paragraph.id]?.text || '';
  for (const token of paragraph.protectedTokens || []) if (token.raw && (token.id || token.placeholder)) text = text.replaceAll(token.placeholder || token.id, token.raw);
  return text;
}
let app, server, client, web, browser, page;
function scope() { const p = app.getState().project; return { expectedProjectId: p.id, expectedSnapshotId: p.snapshotId }; }
async function start() {
  app = new PaperApplication({ dataRoot, compiler: new CompilerWorker({ dataRoot: path.join(run, 'c'), runtimeRoot }), engine: 'pdflatex' });
  await app.initialize(); assert.equal(app.probe.available, true); assert.equal(app.probe.isolated, true);
  await app.openProject({ root: sourceRoot, mainFile: 'main.tex', sourceLanguage: 'en', targetLanguage: 'zh-CN' });
  await app._flowAction(() => { app.flow.nativeChatBinding = { projectId: app.getState().project.id, threadId: thread, model: 'synthetic-no-inference', source: 'originating-host-chat' }; });
  app.translationTasks = new DesktopTranslationTasks(app, { getThreadId: () => thread, enqueue: async () => { throw Error('The native acceptance must not enqueue another chat.'); } });
  app.versionPair = new VersionWorkflow(app, { contextDir });
  server = createPaperServer({ service: app, instanceId, nativeThreadId: thread, uiHtml: '<!doctype html>' });
  client = new Client({ name: 'synthetic-repeat-acceptance', version: releaseVersion });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  web = await startLocalWeb({ service: app, updateChecker: new ReleaseUpdateChecker({ readCache: async () => ({ schemaVersion: 1, autoCheck: false }), writeCache: async () => {}, fetchImpl: async () => { throw Error('The synthetic test must not require a public network request.'); } }) });
}
async function stop() { await client?.close(); await server?.close(); await web?.close(); await app?.close(); }
async function native(name, args = {}) { const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 }); if(result.isError){const problem=result.structuredContent?.error||{};throw Object.assign(Error(JSON.stringify(problem.code?problem:result.content)),{code:problem.code||'NATIVE_TOOL_FAILED'});} for (const block of result.content || []) if (block.type === 'text') { try { const packet = JSON.parse(block.text); if (packet && typeof packet === 'object') return packet; } catch {} } return result.structuredContent; }
async function ui(action, payload = {}) { const result = await fetch(web.origin + '/api', { method: 'POST', headers: { Origin: web.origin, Authorization: `Bearer ${web.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload }) }).then(r => r.json()); assert.equal(result.ok, true, JSON.stringify(result.error)); return result.result; }
const row = prefix => app.getState().readingParagraphs.find(p => p.source.startsWith(prefix));
const note = id => app.getState().reviewNotes.find(n => n.noteId === id);
async function decision(id, value) { return ui('setReviewDecision', { noteId: id, expectedRevision: note(id).revision, decision: value }); }
async function snapshot(label) {
  const state = app.getState(), pair = await app.readVersionPair(), sourceBytes = await readFile(path.join(sourceRoot, 'main.tex'));
  assert.equal(pair.latest.snapshotId, state.project.snapshotId); assert.equal(pair.original.hash, originalPdfHash);
  const build = state.builds.find(b => b.buildId === app.flow.lastEnglishBuildId); assert(build); assert.equal(build.promotedSnapshotId || build.snapshotId, state.project.snapshotId);
  const filename = path.join(run, label + '.pdf'); await copyFile(app.flow.builds.find(b => b.buildId === build.buildId).pdfPath, filename);
  artifacts.push({ label, sourceHash: hash(sourceBytes), snapshotId: state.project.snapshotId, pdfHash: pair.latest.hash, pdf: filename });
  return pair;
}
let originalPdfHash;
try {
  await start();
  const index = await native('bilingual_paper_read_project', { ...scope(), limit: 1000 }); assert(index.paragraphs.length > 4);
  const task = await native('bilingual_paper_prepare_translation_task', { ...scope(), scope: 'all' });
  let translated = 0;
  for (;;) {
    const packet = await native('bilingual_paper_get_request', { requestId: task.taskId });
    if (!packet.batch) { assert.equal(packet.status, 'completed'); break; }
    const values = packet.batch.segments.map(segment => ({ segmentId: segment.id || segment.segmentId, text: translateFixture(segment.text) }));
    const receipt = await native('bilingual_paper_submit_translation_result', { requestId: packet.batch.requestId, translations: values }); translated += values.length;
    if (receipt.status === 'completed' && receipt.task?.status === 'completed') break;
  }
  assert.equal(translated, task.total); assert(translated > 4); check('Complete native translation preserves the full protected selection', { translated });
  const translatedState = app.getState();
  await writeFile(path.join(run, 'initial-translation.md'), translatedState.readingParagraphs.map(p => `## ${p.kind || 'paragraph'}\n\n${readableDraft(p, translatedState)}`).join('\n\n'));
  const initialBuild = await native('bilingual_paper_compile', { kind: 'english' }); assert.equal(initialBuild.status, 'success'); assert.equal(initialBuild.isolated, true);
  const initialPair = await app.readVersionPair(); originalPdfHash = initialPair.original.hash;
  await snapshot('initial-english');
  const imported = await ui('importReviewNotes', { filename: 'review-comments.json', format: 'json', fileHash: hash(reviewText), text: reviewText });
  const intro = row('We study'), method = row('The independent'), limitation = row('The demonstration'), inline = row('An inline example'); assert(intro && method && limitation && inline);
  const batch = imported.batch, anchor = await app.prepareReviewAnchors({ batchId: batch.batchId, expectedRevision: batch.revision || 1, expectedFileHash: batch.fileHash }, { bindingId: instanceId });
  const context = await native('bilingual_paper_get_review_anchor_context', { requestId: anchor.requestId });
  const locations = [intro, method, limitation, intro];
  const matched = await native('bilingual_paper_submit_review_anchors', { requestId: anchor.requestId, matches: context.noteIds.map((noteId, i) => ({ noteId, status: 'certain', candidates: [{ sourceSegmentId: locations[i].id, quote: locations[i].displayText, reason: 'This exact synthetic passage uniquely contains the concern in the imported review.' }], reason: 'A unique literal source passage verifies the paragraph.' })) });
  assert.equal(matched.matchedCount, 4);
  const organizedRequest = await app.prepareReviewOrganization({ batchId: batch.batchId, expectedRevision: batch.revision || 1, expectedFileHash: batch.fileHash }, { bindingId: instanceId });
  const organizedContext = await native('bilingual_paper_get_review_organization_context', { requestId: organizedRequest.requestId });
  const organized = await native('bilingual_paper_submit_review_organization', { requestId: organizedRequest.requestId, notes: organizedContext.noteIds.map((noteId, i) => ({ noteId, title: reviewDocument.notes[i].title, category: 'clarity', summary: reviewDocument.notes[i].body, suggestedSource: i === 2 ? 'The demonstration remains illustrative and does not establish an experimental accuracy guarantee.' : i === 1 ? 'The separate method paragraph retains an independent illustrative value.' : 'We analyze an explicitly illustrative revision workflow.', suggestedTranslation: i === 2 ? '本演示仅用于说明流程，不构成实验精度保证。' : i === 1 ? '独立的方法段落保留一个单独的示例数值。' : '我们分析一个明确用于演示的修订流程。', reasonSource: 'Keep the workflow scope and the corresponding author decision explicit.', reasonTranslation: '明确区分演示流程的范围及作者对该意见的决定。' })) });
  assert.equal(organized.status, 'completed');
  const notes = app.getState().reviewNotes.filter(n => n.batchId === batch.batchId);
  await decision(notes[0].noteId, 'adopt'); await decision(notes[1].noteId, 'revise'); await decision(notes[2].noteId, 'pending'); await decision(notes[3].noteId, 'revise');
  check('Four imported opinions matched through native MCP and author decisions cover adopt/pending/revise');
  const { chromium } = await loadPlaywright(); browser = await chromium.launch(browserOptions); page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('response', async response => { try { if(response.request().method() !== 'POST') return; const request=response.request().postDataJSON(), body=await response.json(); if(body?.ok === false) failedActions.push({action:request?.action,code:body.error?.code}); } catch {} });
  await page.goto(web.url); await page.locator(`[data-unit-id="${intro.id}"] .translation-reading`).waitFor();
  await page.locator('#pdf-container canvas').waitFor();
  const sourceBeforeZoom = hash(await readFile(path.join(sourceRoot, 'main.tex'))), pdfBeforeZoom = (await app.readVersionPair()).latest.hash;
  const fittedWidth = await page.locator('#pdf-container canvas').evaluate(node => node.getBoundingClientRect().width);
  await page.locator('#pdf-zoom').selectOption('2');
  await page.waitForFunction(width => document.querySelector('#pdf-container canvas')?.getBoundingClientRect().width > width * 1.2, fittedWidth);
  await page.locator('#pdf-fit').click();
  await page.waitForFunction(width => Math.abs(document.querySelector('#pdf-container canvas')?.getBoundingClientRect().width - width) < 3, fittedWidth);
  assert.equal(hash(await readFile(path.join(sourceRoot, 'main.tex'))), sourceBeforeZoom); assert.equal((await app.readVersionPair()).latest.hash, pdfBeforeZoom);
  check('View-only PDF zoom visibly enlarges the actual compiled page and fit width restores it without changing source or PDF bytes');
  async function saveExactCapture(capture, sourceId, expectedText, label) {
    const beforeSource = hash(await readFile(path.join(sourceRoot, 'main.tex'))), beforeScope = scope(); let lastError;
    for(let attempt=0;attempt<3;attempt++){
      const captured=capture.drafts.find(item=>item.segmentId===sourceId);assert(captured);assert.equal(captured.text,expectedText);assert.equal(captured.composing,false);
      try{return await native('bilingual_paper_save_editor_draft',{...beforeScope,captureId:capture.captureId,segmentId:sourceId,language:'zh-CN',baseDraftRevision:captured.baseDraftRevision,textHash:captured.textHash});}
      catch(error){
        if(error.code!=='EDITOR_BUFFER_CHANGED')throw error;lastError=error;
        assert.deepEqual(scope(),beforeScope);assert.equal(hash(await readFile(path.join(sourceRoot,'main.tex'))),beforeSource);
        capture=await native('bilingual_paper_read_editor_drafts',{...beforeScope,segmentIds:[sourceId],language:'zh-CN'});const fresh=capture.drafts[0];assert.equal(fresh.text,expectedText);assert.equal(fresh.composing,false);
        protectedSaveRetries.push({label,attempt:attempt+1,reason:error.code,freshRevision:fresh.baseDraftRevision});
        const saved=app.getState().translations['zh-CN'][sourceId];
        if(fresh.saveState==='saved'&&saved?.text===expectedText&&saved.revision===fresh.baseDraftRevision)return{saved:true,alreadySavedExactBuffer:true};
      }
    }
    throw lastError;
  }
  async function editAndApply(sourceId, scalar, verb, label) {
    const host = page.locator(`[data-unit-id="${sourceId}"]`), editor = host.locator('.translation-input'); if (!await editor.isVisible()) await host.locator('.translation-reading').click(); await editor.waitFor({ state: 'visible' });
    const current = await editor.evaluate(el => el.value);
    const inlineEdit = sourceId === inline.id;
    const updated = (inlineEdit
      ? (scalar === 11 ? current.replace(/ 可删除句子[^。]*。/u, '') : current.replace(/第~1/u, '第 1').replace(String.raw`\textbf{清晰的范围}`, '清晰的范围').replace(String.raw`10\%`, '10百分比'))
      : current.replace(/\$x=\d+\$/u, `$x=${scalar}$`).replace(/\$y=\d+\$/u, `$y=${scalar}$`).replace(/\\cite\{(?:Alpha|Beta)\}/u, String.raw`\cite{${scalar === 3 ? 'Beta' : 'Alpha'}}`).replace(/\\eqref\{eq:(?:first|second)\}/u, String.raw`\eqref{eq:${scalar === 3 ? 'second' : 'first'}}`).replace(/^我们(?:研究|分析|描述)/u, verb === 'analyze' ? '我们分析' : '我们描述')) + ` 第${scalar}轮作者补充。`;
    if(inlineEdit&&scalar===11)assert.equal((current.match(/~/gu)||[]).length-(updated.match(/~/gu)||[]).length,3,'Delete exactly the three spacing atoms in the removed sentence.');
    await editor.evaluate((el, text) => { el.value = text; el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' })); }, updated + ' $');
    // Capture before the ordinary autosave debounce. Native access sees the
    // actual live text, not a screen scrape or a persisted-draft substitute.
    const capture = await native('bilingual_paper_read_editor_drafts', { ...scope(), segmentIds: [sourceId], language: 'zh-CN' });
    assert.equal(capture.drafts[0].text, updated + ' $');
    // A refused atomic draft replacement is an intentional, local fixture
    // condition. Restore the same file before the explicit native retry.
    const stateFile = path.join(app.core._store, 'state.json');
    let completeCapture;
    await chmod(stateFile, 0o444);
    try {
      await editor.evaluate((el, text) => { el.value = text; el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' })); }, updated);
      await page.waitForFunction(id => document.querySelector(`[data-unit-id="${id}"] .save-marker`)?.classList.contains('saveFailed'), sourceId);
      completeCapture = await native('bilingual_paper_read_editor_drafts', { ...scope(), segmentIds: [sourceId], language: 'zh-CN' });
      assert.equal(completeCapture.drafts[0].text, updated); assert.equal(completeCapture.drafts[0].saveState, 'saveFailed');
    } finally { await chmod(stateFile, 0o600); }
    await saveExactCapture(completeCapture,sourceId,updated,label);
    await page.waitForFunction(id => { const node = document.querySelector(`[data-unit-id="${id}"] .save-marker`); return node && /Saved|已保存/u.test(node.textContent); }, sourceId);
    await page.waitForFunction(() => { const node = document.querySelector('#notice'); return !node || node.hidden || !/EPERM|EACCES|rename.*state\.json/u.test(node.textContent); });
    await host.locator('.translation-edit-done').click();
    await page.waitForFunction(id => { const node = document.querySelector(`[data-unit-id="${id}"] .save-marker`); return node && /Saved|已保存/u.test(node.textContent); }, sourceId);
    const request = await native('bilingual_paper_prepare_request', { ...scope(), kind: 'revision', segmentIds: [sourceId], language: 'zh-CN', prompt: 'Apply only the exact saved illustrative author intent.' });
    const selected = request.segments[0];
    if(inlineEdit){assert.equal(selected.inlineStructureRequest?.mode,'existing-inline-omission');assert(!selected.draftReview);}
    const english = inlineEdit
      ? selected.text.replaceAll('一个行内示例使用第', 'An inline example uses Section').replaceAll('1节和', '1 and ').replaceAll('清晰的范围', 'clear scope').replaceAll('，其中包含字面值10', ', with a literal 10').replaceAll('百分比', ' percent').replace(/ 第(\d+)轮作者补充。/gu, ' The author adds detail for synthetic round $1.').replaceAll('。', '.')
      : selected.text.replace(/We (?:study|analyze|describe)/u, `We ${verb}`).replace('The independent second paragraph', 'The separate method paragraph');
    const proposed = await native('bilingual_paper_propose_revision', { requestId: request.requestId, reason: 'Apply the saved synthetic author edit.', edits: [{ segmentId: sourceId, beforeHash: selected.beforeHash, replacement: english + ` The author records synthetic revision ${scalar}.` }] });
    const compiled = await native('bilingual_paper_compile', { kind: 'candidate', proposalIds: [proposed.proposalId] }); assert.equal(compiled.status, 'success');
    const before = scope().expectedSnapshotId;
    // This is the authenticated human UI boundary, intentionally absent from
    // native model tools. The opt-in test author explicitly approves its own fixture.
    const grant = await ui('prepareAcceptance', { transactionId: compiled.transactionId });
    const applied = await ui('applyTransaction', { transactionId: compiled.transactionId, confirmationToken: grant.confirmationToken, idempotencyKey: label });
    assert.equal(applied.state, 'applied'); if (applied.englishPdfJobId) await app.waitJob({ jobId: applied.englishPdfJobId });
    assert.notEqual(scope().expectedSnapshotId, before);
    const pair = await snapshot(label), state = app.getState(), draft = state.translations['zh-CN'][sourceId], paragraph = state.readingParagraphs.find(p => p.id === sourceId);
    assert.equal(draft.text, updated); assert.equal(draft.sourceHash, paragraph.sourceHash || paragraph.beforeHash); assert.equal(draft.status, 'saved');
    assert.equal(deriveEnglishWriteback(state, 'zh-CN').mode, 'empty', 'Confirmed author text must not be offered again as an unwritten English change.');
    await page.waitForFunction(snapshotId => document.querySelector('#snapshot-label')?.title === snapshotId, state.project.snapshotId);
    await new Promise((resolve, reject) => { const deadline = Date.now() + 10000; const timer = setInterval(() => { const visible = app.getState().pdfSelection; if (visible.activeRole === 'latest' && visible.activePdfHash === pair.latest.hash) { clearInterval(timer); resolve(); } else if (Date.now() > deadline) { clearInterval(timer); reject(Error('The visible PDF did not acknowledge the exact latest English hash.')); } }, 40); });
    assert.equal(await page.locator('#pdf-artifact').inputValue(), 'version-latest'); assert(await page.locator('#pdf-container canvas').count() > 0);
    check('Confirmed writeback compiles, updates Latest English and keeps its translation editable', { label, pdfHash: pair.latest.hash });
    return applied;
  }
  const first = await editAndApply(intro.id, 3, 'analyze', 'first-writeback');
  assert.equal(app.getState().reviewImportValidation.batches.find(b => b.batchId === batch.batchId).notes.find(n => n.noteId === notes[0].noteId).status, 'completed');
  await editAndApply(intro.id, 5, 'describe', 'second-writeback');
  const currentIntro = app.getState().readingParagraphs.find(p => p.id === intro.id);
  const rematch = await app.prepareReviewAnchors({ batchId: batch.batchId, expectedRevision: batch.revision || 1, expectedFileHash: batch.fileHash, noteIds: [notes[3].noteId] }, { bindingId: instanceId });
  const rematched = await native('bilingual_paper_submit_review_anchors', { requestId: rematch.requestId, matches: [{ noteId: notes[3].noteId, status: 'certain', candidates: [{ sourceSegmentId: currentIntro.id, quote: currentIntro.displayText, reason: 'The current revised introduction uniquely contains the original concern.' }], reason: 'Recheck the preserved concern against the latest exact paragraph.' }] });
  assert.equal(rematched.matchedCount, 1); await decision(notes[3].noteId, 'revise');
  const repeatedImport = await ui('importReviewNotes', { filename: 'review-comments.json', format: 'json', fileHash: hash(reviewText), text: reviewText });
  assert.equal(repeatedImport.batch.batchId, batch.batchId); assert.equal(app.getState().reviewNotes.length, 4);
  check('The same review file retains four identities and a revise decision can be rematched to the updated paragraph');
  await decision(notes[1].noteId, 'adopt'); await editAndApply(method.id, 7, 'describe', 'method-writeback');
  assert.equal(note(notes[2].noteId).decision || 'pending', 'pending'); assert.equal(note(notes[3].noteId).decision, 'revise');
  const last = app.getState().transactions.filter(t => t.state === 'applied').at(-1), undo = await ui('createUndoProposal', { transactionId: last.transactionId });
  const undoneBuild = await native('bilingual_paper_compile', { kind: 'candidate', proposalIds: [undo.proposalId] }); assert.equal(undoneBuild.status, 'success');
  const undoGrant = await ui('prepareAcceptance', { transactionId: undoneBuild.transactionId });
  const undone = await ui('applyTransaction', { transactionId: undoneBuild.transactionId, confirmationToken: undoGrant.confirmationToken, idempotencyKey: 'reviewed-undo' }); if (undone.englishPdfJobId) await app.waitJob({ jobId: undone.englishPdfJobId });
  assert.equal(hash(await readFile(path.join(sourceRoot, 'main.tex'))), artifacts.find(item => item.label === 'second-writeback').sourceHash);
  await snapshot('reviewed-undo');
  await editAndApply(method.id, 9, 'describe', 'final-writeback');
  await editAndApply(inline.id, 11, 'describe', 'inline-first-writeback');
  await editAndApply(inline.id, 13, 'describe', 'inline-second-writeback');
  // Raw formatting is durable independently of source authority. A real
  // compiled partial adaptation cannot silently consume its unresolved draft.
  const inlineHost = page.locator(`[data-unit-id="${inline.id}"]`), inlineInput = inlineHost.locator('.translation-input');
  if(!await inlineInput.isVisible())await inlineHost.locator('.translation-reading').click();
  const validInline = await inlineInput.evaluate(node=>node.value), rawInline = validInline + String.raw` \textsf{unfinished`;
  await inlineInput.evaluate((node,text)=>{node.value=text;node.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));},rawInline);
  await page.waitForFunction(id=>/Saved|已保存/u.test(document.querySelector(`[data-unit-id="${id}"] .save-marker`)?.textContent||''),inline.id);
  const rawCapture = await native('bilingual_paper_read_editor_drafts',{...scope(),segmentIds:[inline.id],language:'zh-CN'}), capturedRaw = rawCapture.drafts[0];
  assert.equal(capturedRaw.text,rawInline);
  await saveExactCapture(rawCapture,inline.id,rawInline,'adaptive-raw-draft');
  assert.equal(app.getState().translations['zh-CN'][inline.id].text,rawInline);assert.equal(app.getState().translations['zh-CN'][inline.id].sourceReviewRequired,true);
  await inlineHost.locator('.translation-edit-done').click();
  async function compileAndConfirm(request,replacement,label){
    const selected=request.segments[0],p=await native('bilingual_paper_propose_revision',{requestId:request.requestId,reason:'Adapt the exact saved synthetic author text without treating unresolved formatting as resolved.',edits:[{segmentId:inline.id,beforeHash:selected.beforeHash,replacement}]});
    const compiled=await native('bilingual_paper_compile',{kind:'candidate',proposalIds:[p.proposalId]});assert.equal(compiled.status,'success');
    const grant=await ui('prepareAcceptance',{transactionId:compiled.transactionId}),applied=await ui('applyTransaction',{transactionId:compiled.transactionId,confirmationToken:grant.confirmationToken,idempotencyKey:label});assert.equal(applied.state,'applied');if(applied.englishPdfJobId)await app.waitJob({jobId:applied.englishPdfJobId});await snapshot(label);return applied;
  }
  const adaptive=await native('bilingual_paper_prepare_request',{...scope(),kind:'revision',segmentIds:[inline.id],language:'zh-CN',prompt:'Use protected baseline source while retaining unfinished author formatting for later repair.'});
  assert.equal(adaptive.segments[0].draftReview.mode,'adaptive-human-draft');assert.equal(adaptive.segments[0].translationDraft.text,rawInline);
  await compileAndConfirm(adaptive,adaptive.segments[0].text+' A bounded source adaptation retains unfinished author formatting.','adaptive-partial-writeback');
  const pendingRaw=app.getState().translations['zh-CN'][inline.id];assert.equal(pendingRaw.text,rawInline);assert.equal(pendingRaw.sourceReviewRequired,true);assert(!pendingRaw.sourceWritebackReceipt);assert.notEqual(deriveEnglishWriteback(app.getState(),'zh-CN').mode,'empty');
  if(!await inlineInput.isVisible())await inlineHost.locator('.translation-reading').click();
  await inlineInput.evaluate((node,text)=>{node.value=text;node.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));},validInline);
  await new Promise((resolve,reject)=>{const deadline=Date.now()+10000,timer=setInterval(()=>{const draft=app.getState().translations['zh-CN'][inline.id];if(draft.text===validInline&&!draft.sourceReviewRequired){clearInterval(timer);resolve();}else if(Date.now()>deadline){clearInterval(timer);reject(Error('The repaired author draft did not recover valid source intent.'));}},40);});
  await inlineHost.locator('.translation-edit-done').click();
  const repaired=await native('bilingual_paper_prepare_request',{...scope(),kind:'revision',segmentIds:[inline.id],language:'zh-CN',prompt:'Use the repaired valid author draft.'});assert(!repaired.segments[0].draftReview);
  await compileAndConfirm(repaired,repaired.segments[0].text.replace('A bounded source adaptation retains unfinished author formatting.','The repaired author paragraph is ready for final review.'),'adaptive-repaired-writeback');
  assert(!app.getState().translations['zh-CN'][inline.id].sourceReviewRequired);assert(app.getState().translations['zh-CN'][inline.id].sourceWritebackReceipt);assert.equal(deriveEnglishWriteback(app.getState(),'zh-CN').mode,'empty');
  check('Incomplete structural text saves through native capture; partial compiled adaptation preserves pending intent, and repair permits an exact final writeback');
  const specialRounds = [];
  async function nativeSpecialWrite(prefix, transform, verify, label) {
    const paragraph = row(prefix); assert(paragraph, `The self-authored special paragraph is missing: ${prefix}`);
    const saved = app.getState().translations['zh-CN'][paragraph.id], priorSource = hash(await readFile(path.join(sourceRoot, 'main.tex'))), priorPdf = (await app.readVersionPair()).latest.hash;
    const raw = readableDraft(paragraph, app.getState()), editedText = transform(raw) + ` 原生特殊修订第${specialRounds.length + 1}轮。`;
    assert.notEqual(editedText, raw); await page.waitForFunction(() => !document.querySelector('.save-marker.saving,.save-marker.saveFailed'));
    const edited = await native('bilingual_paper_edit_translation', { ...scope(), segmentId: paragraph.id, language: 'zh-CN', text: editedText, expectedRevision: saved.revision, expectedTextHash: hash(saved.text), reason: `Synthetic acceptance ${label}: change only the named inline objects and retain the exact closed calls and display labels.` });
    assert.equal(edited.saved, true); assert.equal(edited.sourceChanged, false); assert.equal(edited.draft.text, editedText); assert.equal(edited.draft.editActor.kind, 'bound-chat'); assert.equal(edited.draft.editActor.threadId, thread);
    assert.equal(edited.sourceCandidateAvailable, true, JSON.stringify(edited.diagnostics)); assert.equal(edited.sourceReviewRequired, false);
    assert.equal(hash(await readFile(path.join(sourceRoot, 'main.tex'))), priorSource);
    const request = await native('bilingual_paper_prepare_request', { ...scope(), kind: 'revision', segmentIds: [paragraph.id], language: 'zh-CN', prompt: 'Apply this exact saved special-structure author edit. Preserve unchanged custom invocations and mathematical display labels.' }), selected = request.segments[0];
    assert(!selected.draftReview, JSON.stringify(selected.draftReview));
    let english = selected.text;
    for (const [before, after] of [...specialTranslationPairs].reverse()) english = english.replaceAll(after, before);
    english = english.replace(/ 原生特殊修订第(\d+)轮。/gu, ' The author requests native special revision $1.').replaceAll('。', '.') + ` This native draft edit is special round ${specialRounds.length + 1}.`;
    const proposed = await native('bilingual_paper_propose_revision', { requestId: request.requestId, reason: `Apply the exact saved native author intent for ${label}.`, edits: [{ segmentId: paragraph.id, beforeHash: selected.beforeHash, replacement: english }] });
    const compiled = await native('bilingual_paper_compile', { kind: 'candidate', proposalIds: [proposed.proposalId] }); assert.equal(compiled.status, 'success'); assert.equal(compiled.isolated, true);
    const transaction = app.flow.transactions.find(item => item.transactionId === compiled.transactionId), candidate = transaction.candidate.files.find(file => file.path === 'main.tex').content;
    verify(candidate); assert(candidate.includes(String.raw`\label{eq:align-first}`) && candidate.includes(String.raw`\label{eq:align-second}`));
    assert(candidate.includes(String.raw`\ClosedOne{fixed operand}`) && candidate.includes(String.raw`\ClosedZero{}`));
    const grant = await ui('prepareAcceptance', { transactionId: compiled.transactionId }), applied = await ui('applyTransaction', { transactionId: compiled.transactionId, confirmationToken: grant.confirmationToken, idempotencyKey: label });
    assert.equal(applied.state, 'applied'); if (applied.englishPdfJobId) await app.waitJob({ jobId: applied.englishPdfJobId });
    const pair = await snapshot(label), currentSource = await readFile(path.join(sourceRoot, 'main.tex'), 'utf8'); verify(currentSource);
    assert.notEqual(hash(currentSource), priorSource); assert.notEqual(pair.latest.hash, priorPdf);
    const current = app.getState().translations['zh-CN'][paragraph.id]; assert.equal(current.text, editedText); assert(current.sourceWritebackReceipt); assert.equal(deriveEnglishWriteback(app.getState(), 'zh-CN').mode, 'empty');
    await page.waitForFunction(snapshotId => document.querySelector('#snapshot-label')?.title === snapshotId, scope().expectedSnapshotId);
    const proof = { label, sourceId: paragraph.id, draftRevision: current.revision, sourceHash: hash(currentSource), pdfHash: pair.latest.hash, actor: current.editActor };
    specialRounds.push(proof); check('Native protected-object edit compiles and promotes the exact English candidate', proof);
  }
  await nativeSpecialWrite('Special spacing keeps', text => {
    assert(text.includes('Section~4') && text.includes(String.raw`控制\ `));
    return text.replace('Section~4', 'Section 4').replace(String.raw`控制\ `, '控制 ');
  }, source => { assert(source.includes(String.raw`Section 4, control space, thin\,space and wide\quad space`)); }, 'native-special-spacing');
  await nativeSpecialWrite('Escaped symbols remain literal', text => {
    assert(text.includes(String.raw`25\%`)); return text.replace(String.raw`25\%`, '25 percent');
  }, source => { assert(source.includes(String.raw`\{braces\}, 25 percent, \#tag, \& pair, \$price and under\_score`)); }, 'native-special-escapes');
  await nativeSpecialWrite('Nested formatting keeps', text => {
    assert(text.includes(String.raw`\textbf{`)); return text.replace(String.raw`\textbf{`, String.raw`\textit{`);
  }, source => { assert(source.includes(String.raw`\textit{outer \emph{inner} words}`)); }, 'native-special-formatting');
  await nativeSpecialWrite('Mathematical notation keeps', text => {
    assert(text.includes('$u+v=w$') && text.includes(String.raw`\cite{Alpha}`) && text.includes(String.raw`\eqref{eq:align-first}`));
    return text.replace('$u+v=w$', '$u+v=z$').replace(String.raw`\cite{Alpha}`, String.raw`\cite{Beta}`).replace(String.raw`\eqref{eq:align-first}`, String.raw`\eqref{eq:align-second}`);
  }, source => { assert(source.includes('$u+v=z$') && source.includes(String.raw`$\frac{1}{2}\vec{x}\in\mathbb{R}^{n}$`) && source.includes(String.raw`\cite{Beta}; compare \eqref{eq:align-second}`)); }, 'native-special-math-and-references');
  assert.equal(specialRounds.length, 4); assert.equal(app.getState().reviewNotes.length, 4); assert.equal(app.getState().transactions.filter(item => item.state === 'applied').length, 13);
  const finalState = app.getState(), finalSource = await readFile(path.join(sourceRoot, 'main.tex')), finalDrafts = structuredClone(finalState.translations), finalNotes = structuredClone(finalState.reviewNotes), finalPdfHash = (await app.readVersionPair()).latest.hash;
  assert(finalSource.includes(Buffer.from('$x=5$')) && finalSource.includes(Buffer.from('$y=9$')) && finalSource.includes(Buffer.from(String.raw`\label{eq:first}`)));
  assert(finalSource.includes(Buffer.from(String.raw`Section 1 and clear scope, with a literal 10 percent.`)));
  assert(!finalSource.includes(Buffer.from('A removable sentence links Part'))&&!finalSource.includes(Buffer.from(String.raw`\textsf{unfinished`)));
  await writeFile(path.join(run, 'final-translation.md'), finalState.readingParagraphs.map(p => `## ${p.kind || 'paragraph'}\n\n${readableDraft(p, finalState)}`).join('\n\n'));
  await writeFile(path.join(run, 'final-opinions.json'), JSON.stringify(finalNotes, null, 2));
  const finalIntro = page.locator(`[data-unit-id="${intro.id}"]`); await finalIntro.scrollIntoViewIfNeeded();
  await finalIntro.locator('.translation-reading').click(); await finalIntro.locator('.translation-edit-done').click();
  assert.equal(deriveEnglishWriteback(app.getState(), 'zh-CN').mode, 'empty');
  await page.screenshot({ path: path.join(run, 'final-workbench.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close(); await stop(); await start();
  assert.deepEqual(await readFile(path.join(sourceRoot, 'main.tex')), finalSource); assert.deepEqual(app.getState().translations, finalDrafts); assert.deepEqual(app.getState().reviewNotes, finalNotes); assert.equal((await app.readVersionPair()).latest.hash, finalPdfHash); assert.equal((await app.readVersionPair()).original.hash, originalPdfHash);
  const authorFiles = (await readdir(contextDir)).filter(name => name.endsWith('.pdf')); assert.deepEqual(authorFiles.sort(), ['latest-english.pdf', 'original.pdf']);
  check('Reopening preserves final source, translations, decisions, frozen original and exactly two author PDFs');
  const receipt = { success: true, version: releaseVersion, syntheticOnly: true, originalManuscriptAccessed: false, modelTurns: 0, nativeMcpOperations: true, screenScraping: false, actualIsolatedCompiler: true, sourceWriteback: 'authenticated_ui_only', translated, checks, artifacts, sourceRoot, finalSourceHash: hash(finalSource), finalPdfHash, originalPdfHash, inlineStructureWritebacks: 2, adaptiveWritebacks: 2, specialStructureWritebacks: specialRounds, protectedSaveRetries, writebackCount: 12, undoCount: 1, reviewDecisions: finalNotes.map(n => ({ title: n.title, decision: n.decision || 'pending' })), firstTransactionId: first.transactionId };
  await writeFile(path.join(run, 'acceptance.json'), JSON.stringify(receipt, null, 2)); await writeFile(path.join(parent, 'latest-run.json'), JSON.stringify({ run, success: true }, null, 2));
  console.log(JSON.stringify({ success: true, checks: checks.length, run }));
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(run, 'failure-workbench.png'), fullPage: true }).catch(() => {}); await writeFile(path.join(run, 'failure-editor.json'), JSON.stringify(await page.locator('[data-unit-id]').evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.unitId, view: node.dataset.translationView, marker: node.querySelector('.save-marker')?.textContent, message: node.querySelector('.draft-message')?.textContent }))), null, 2)).catch(() => {}); }
  await writeFile(path.join(run, 'failure.json'), JSON.stringify({ success: false, code: error.code, message: error.message, stack: error.stack, checks, failedActions, notice: page && !page.isClosed() ? await page.locator('#notice').evaluate(node=>({text:node.textContent,hidden:node.hidden,dataset:{...node.dataset}})).catch(()=>null) : null }, null, 2));
  console.error(error); process.exitCode = 1;
} finally { await browser?.close(); await stop().catch(() => {}); }
