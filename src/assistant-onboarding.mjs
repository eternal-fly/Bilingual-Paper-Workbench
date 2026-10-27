import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareAssistantSource, prepareAssistantReview } from './assistant-import.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

/** Explicit supplied paths are read into private copies. This never accepts
 * transactions, executes reviewer TeX or starts another model conversation. */
export async function importAssistantFiles(service, input = {}, { bindingId = null } = {}) {
  if (bindingId !== null && !/^[A-Za-z0-9_.:-]{1,128}$/.test(bindingId)) fail('INVALID_INPUT', 'Use the exact originating chat instance.');
  if (!plain(input) || Object.keys(input).some(key => !['sourcePath', 'mainFile', 'reviews', 'sourceLanguage', 'targetLanguage'].includes(key)) ||
      input.sourcePath !== undefined && (typeof input.sourcePath !== 'string' || !path.isAbsolute(input.sourcePath)) ||
      input.reviews !== undefined && (!Array.isArray(input.reviews) || input.reviews.length > 16) ||
      !input.sourcePath && !input.reviews?.length) fail('INVALID_INPUT', 'Supply the exact local source path or review file paths.');
  if (!service.registry?.dataRoot || service.getHostContext?.()?.native) fail('IMPORT_REQUIRES_WINDOW', 'Import supplied files through the independent window background.');
  const reviews = input.reviews || [];
  for (const item of reviews) if (!plain(item) || Object.keys(item).some(key => !['path', 'entry'].includes(key)) || typeof item.path !== 'string' || !path.isAbsolute(item.path)) fail('INVALID_INPUT', 'Each review needs its exact absolute path.');
  let source = null;
  if (input.sourcePath) {
    const taskId = service.getHostContext?.()?.hostTaskId;
    const privateRoot = taskId ? path.join(service.registry.dataRoot, 'i', createHash('sha256').update(taskId).digest('hex').slice(0, 12)) : service.registry.dataRoot;
    source = await prepareAssistantSource({ sourcePath: input.sourcePath, mainFile: input.mainFile, privateRoot });
    if (source.status !== 'ready') return { status: source.status, source, reviews: [], nextStep: 'Choose one returned mainCandidates value and retry the same sourcePath with mainFile.' };
    await service.openProject({ root: source.root, mainFile: source.mainFile, sourceLanguage: input.sourceLanguage || 'en', targetLanguage: input.targetLanguage || 'zh-CN' }, { initialEngine: source.engine });
  }
  if (!service.getState().project) return { status: 'source-required', source, reviews: [], nextStep: 'Import the source LaTeX ZIP or main .tex before its review files.' };
  const results = [];
  for (const item of reviews) {
    try {
      const prepared = await prepareAssistantReview({ reviewPath: item.path, entry: item.entry, state: service.getState() });
      if (prepared.status !== 'ready') { results.push({ filename: path.basename(item.path), ...prepared }); continue; }
      const result = await service.active.importReviewNotes(prepared.input);
      const batchId = result.batch?.batchId;
      const latest = service.getState(), unlocated = (latest.reviewNotes || []).filter(note => note.batchId === batchId && !note.sourceSegmentIds?.length);
      let matching = null;
      if (bindingId && unlocated.length) {
        const batch = (latest.reviewBatches || []).find(row => row.batchId === batchId);
        if (batch) {
          try {
            const packet = await service.active.prepareReviewAnchors({ batchId: batch.batchId, expectedRevision: batch.revision ?? 1, expectedFileHash: batch.fileHash, noteIds: unlocated.map(note => note.noteId) }, { bindingId });
            matching = { status: 'ready', requestId: packet.requestId, noteCount: packet.noteCount, readTool: 'bilingual_paper_get_review_anchor_context', returnTool: packet.returnTool, instruction: 'Match these existing imported opinions in this SAME active chat, without starting another model turn. Read the exact context once; return certain links only with unique literal source evidence and keep ambiguous matches for human confirmation.' };
          } catch (error) {
            matching = { status: 'unavailable', noteCount: unlocated.length, error: { code: error.code || 'MATCHING_NOT_READY', message: String(error.message).slice(0, 1000) }, nextStep: 'Opinions were imported successfully. Retry matching with a smaller selection in the workbench.' };
          }
        }
      }
      results.push({ filename: prepared.input.filename, status: 'imported', provenance: prepared.provenance,
        result: { batchId, noteCount: result.notes?.length || 0, idempotent: result.idempotent === true },
        duplicate: result.idempotent === true, unlocatedCount: unlocated.length, ...(matching ? { matching } : {}) });
    } catch (error) { results.push({ filename: path.basename(item.path), status: 'failed', error: { code: error.code || 'IMPORT_FAILED', message: String(error.message).slice(0, 2000) } }); }
  }
  const state = service.getState();
  return { status: results.some(item => item.status !== 'imported') ? 'partial' : 'completed', source,
    project: { mainFile: state.project.mainFile, snapshotId: state.project.snapshotId, readingParagraphs: state.readingParagraphs?.length || 0 },
    reviews: results, sourceWriteback: 'human_ui_only', modelRequestsStarted: 0,
    nextStep: results.some(item => item.status === 'review-file-required') ? 'Select the exact review ZIP entry from reviewCandidates; existing imported files stay available.' : 'The source and available review opinions are ready in this same window. Translate or organize them only when requested.' };
}
