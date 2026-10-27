import { z } from 'zod';
import { reviewNoteSchema } from './full-review.mjs';
const id = z.string().min(1).max(128);
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

/** Native host model owns the ongoing turn; these tools never start a worker. */
export function registerPdfModelTools(server, { service, guard }) {
  if (!service.getPdfContext) return;
  server.registerTool('bilingual_paper_compile', {
    title: 'Compile this paper safely', description: 'Compile current confirmed English source (default), source baseline, or explicitly selected pending proposals in the verified OS sandbox. Returns actual build evidence. Compilation grants no source apply/undo authority; only human UI confirmation can promote a candidate.',
    inputSchema: z.object({ kind: z.enum(['english', 'baseline', 'candidate']).default('english'), proposalIds: z.array(id).min(1).optional() }).strict(), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, guard(async input => {
    if (input.kind === 'candidate' ? !input.proposalIds?.length : input.proposalIds !== undefined) throw Object.assign(new Error('Candidate compilation needs exact proposal IDs; other builds accept none.'), { code: 'INVALID_INPUT' });
    const queued = input.kind === 'candidate' ? await service.previewTransaction({ proposalIds: input.proposalIds }) : input.kind === 'baseline' ? await service.compileBaseline() : await service.compileEnglish();
    const build = await service.waitJob({ jobId: queued.jobId });
    return reply({ jobId: queued.jobId, transactionId: queued.transactionId || null, buildId: build.buildId, status: build.status, pdfHash: build.pdfHash || null, inputHash: build.inputHash || null, isolated: build.isolation?.verified === true, diagnostics: build.diagnostics || [], sourceWriteback: 'human_ui_only', scientificCorrectness: 'author_review_required' });
  }));
  server.registerTool('bilingual_paper_list_pdfs', {
    title: 'List this task’s paper PDFs', description: 'List the current task/project paper, original/latest verified PDFs, active displayed PDF and review target. No source write permission.',
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, guard(async () => { const state = service.getState(); return reply({ project: state.project, workspace: state.workspaceIndex?.currentRecord, hostTaskId: service.getHostContext?.()?.hostTaskId || null, pdfSelection: state.pdfSelection, languagePreferences: state.languagePreferences, versionPair: state.versionPair, contextReady: state.reviewCycleContext?.available || false }); }));
  server.registerTool('bilingual_paper_select_pdf', {
    title: 'Select paper PDF for review', description: 'Choose original, latest, both (default), or current displayed candidate/author PDF. Original/latest also requests the UI to show that PDF while preserving the translation caret. Candidate/original review cannot overwrite latest translations.',
    inputSchema: z.object({ target: z.enum(['original', 'latest', 'pair', 'current']), expectedPairId: id.optional(), expectedRevision: z.number().int().min(0).optional() }).strict(), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, guard(async input => reply(await service.selectPdfReviewTarget(input, 'model'))));
  server.registerTool('bilingual_paper_get_pdf_context', {
    title: 'Read complete selected PDF context in this chat', description: 'Read complete locally extracted text of verified PDFs and protected paragraph index in this SAME chat, without starting another model turn. For translation requests use purpose="translation": return notes=[] and every requested protected paragraph translation; this preserves all existing opinions, history and review generations. Default purpose="review" retains normal opinion generation. Verified PDF bytes are extracted locally in a bounded native worker when needed; no open window, browser extraction or Computer Use is required. Default scope all paragraphs, target pair, current target language. Preserve protected placeholders. Return with bilingual_paper_submit_pdf_review; never write source files.',
    inputSchema: z.object({ sourceSegmentIds: z.array(id).min(1).optional(), language: z.string().min(2).max(32).optional(), includeTranslations: z.boolean().optional(), purpose: z.enum(['review', 'translation']).optional() }).strict(), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, guard(async input => reply(await service.getPdfContext(input))));
  const note = z.object({ title: z.string().max(160), body: z.string().max(2000).optional(), recommendation: z.string().max(16000).optional(), quote: z.string().max(1000), sourceSegmentIds: z.array(id), severity: z.enum(reviewNoteSchema.properties.severity.enum), reviewCode: z.string().max(32).optional(), scope: z.enum(['paragraph', 'sentence', 'note']).optional(), currentSource: z.string().min(1).max(16000).optional(), currentTranslation: z.string().min(1).max(16000).optional(), suggestedSource: z.string().min(1).max(16000), suggestedTranslation: z.string().min(1).max(16000), reasonSource: z.string().min(1).max(16000), reasonTranslation: z.string().min(1).max(16000) }).strict();
  server.registerTool('bilingual_paper_submit_pdf_review', {
    title: 'Return this chat’s PDF opinions and translations', description: 'Atomically return a fresh exact PDF context result. Review-purpose requests publish latest opinions and permitted translations. Translation-purpose requests must have notes=[] and exact complete target translations, update only corresponding drafts, and never create review heads or alter existing opinions/history. Stale source, PDF, language, draft or alignment results fail closed. This never promotes source edits.',
    inputSchema: z.object({ requestId: id, answer: z.string().max(16000).optional(), notes: z.array(note), translations: z.array(z.object({ segmentId: id, text: z.string().max(128 * 1024) }).strict()) }).strict(), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, guard(async input => reply(await service.submitPdfReview(input)), { maximum: 1024 * 1024 }));
}
