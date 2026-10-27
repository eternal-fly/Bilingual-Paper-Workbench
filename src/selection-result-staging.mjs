import { createHash } from 'node:crypto';
import { restoreProtected } from './latex.mjs';
import { REGISTERED_REQUEST_BYTES, jsonBytes } from './request-budgets.mjs';
import {assertSourceReviewRequest,validateSourceReviewReplacement} from './source-review.mjs';

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message) => { throw Object.assign(Error(message), { code }); };
export const hasResultStage = input => ['batchOffset', 'resultCount', 'finalize'].some(key => Object.hasOwn(input, key));
const identity = request => sha([request.projectId, request.snapshotId, request.kind, request.bindingId, request.language, request.segmentIds, request.draftRevisions, request.translationUnitRevisions, request.segments, ...(request.mode === 'source-review' ? [{mode:request.mode,sourceReview:request.sourceReview}] : [])]);
const receipt = (request, staging) => ({ requestId: request.requestId, status: 'staged', received: staging.received, resultCount: staging.resultCount, nextOffset: staging.received, sourceChanged: false, draftsChanged: false, instruction: 'Continue returning the remaining exact result records with batchOffset=nextOffset; set finalize=true on the last part. No partial result has been published.' });

export const RESULT_PROTOCOL = Object.freeze({ mode: 'atomic-or-staged', transportByteBudget: 8 * 1024 * 1024, fields: ['batchOffset', 'resultCount', 'finalize'], instructions: 'For a result larger than one transport message, return sequential complete-record parts with batchOffset=0 initially, fixed resultCount, and finalize=false. Use each receipt nextOffset. Set finalize=true on the final part. Only the complete assembled result is published; exact retries are idempotent. Revision parts keep the same reason.' });

/** Shared inert assembly; the owning workflow checks its exact allowed IDs,
 * version/caller and record content before committing this returned state. */
export function stageResultRecords(previous, input, { identity: capturedIdentity, recordKey, reason = null } = {}) {
  if (!Number.isSafeInteger(input.batchOffset) || input.batchOffset < 0 || !Number.isSafeInteger(input.resultCount) || input.resultCount < 1 || typeof input.finalize !== 'boolean' || !Array.isArray(input.records) || !input.records.length) fail('INVALID_INPUT', 'A result part needs its exact offset, complete count and finalization flag.');
  const partHash = sha([input.records, reason]), ids = input.records.map(record => record[recordKey]);
  if (new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !id)) fail('SELECTION_SCOPE_MISMATCH', 'Result record identities must be unique and explicit.');
  const staging = previous ? structuredClone(previous) : { schemaVersion: 1, identity: capturedIdentity, resultCount: input.resultCount, reason, received: 0, status: 'collecting', parts: [] };
  if (staging.identity !== capturedIdentity || staging.resultCount !== input.resultCount || staging.reason !== reason) fail('IDEMPOTENCY_CONFLICT', 'The result part belongs to a different captured request or scope.');
  const prior = staging.parts.find(part => part.offset === input.batchOffset);
  if (prior && (prior.hash !== partHash || prior.count !== input.records.length)) fail('IDEMPOTENCY_CONFLICT', 'This exact result offset already has a different part.');
  if (staging.status === 'published') { if (!prior) fail('IDEMPOTENCY_CONFLICT', 'No completed result receipt matches this retry.'); return { staging, published: true, result: staging.result }; }
  if (!prior) {
    if (input.batchOffset !== staging.received || staging.received + input.records.length > staging.resultCount) fail('SELECTION_SCOPE_MISMATCH', 'Continue from the exact nextOffset without missing result records.');
    const known = new Set(staging.parts.flatMap(part => part.values.map(item => item[recordKey])));
    if (ids.some(id => known.has(id))) fail('SELECTION_SCOPE_MISMATCH', 'A result identity was already returned in an earlier part.');
    staging.parts.push({ offset: input.batchOffset, count: input.records.length, hash: partHash, values: structuredClone(input.records) }); staging.received += input.records.length;
  }
  if (jsonBytes(staging) > REGISTERED_REQUEST_BYTES) fail('REQUEST_TOO_LARGE', 'The complete staged result exceeds the registered storage byte budget.');
  if (input.finalize && staging.received !== staging.resultCount) fail('SELECTION_SCOPE_MISMATCH', 'Finalization requires every declared result record.');
  return { staging, complete: input.finalize, ...(input.finalize ? { values: staging.parts.flatMap(part => part.values) } : {}) };
}

/** Byte transport parts are private, request-bound and inert until the exact
 * complete result is passed to the existing atomic validator/publication path. */
export async function stageSelectionResult(app, approved, input, { beforeWrite } = {}) {
  return app.core._serial(async () => {
    await app.core._assertSourceCurrent(); if (beforeWrite) await beforeWrite();
    const raw = app.core.getState(), request = raw.requests.find(row => row.requestId === approved.requestId);
    if (!request || request.projectId !== raw.project?.id || request.snapshotId !== raw.project?.snapshotId || request.bindingId !== approved.bindingId || !['pending', 'completed'].includes(request.status)) fail('REQUEST_NOT_APPROVED', 'The staged result no longer belongs to this approved current request.');
    const key = request.kind === 'translation' ? 'translations' : request.kind === 'revision' ? 'edits' : null;
    if (!key || !Number.isSafeInteger(input.batchOffset) || input.batchOffset < 0 || !Number.isSafeInteger(input.resultCount) || input.resultCount < 1 || typeof input.finalize !== 'boolean' || !Array.isArray(input[key]) || !input[key].length || input.resultCount > request.segmentIds.length || request.kind === 'translation' && input.resultCount !== request.segmentIds.length) fail('INVALID_INPUT', 'Return an exact result part with batchOffset, complete resultCount and finalize flag.');
    const current = app.reading?.state?.(raw) || raw;
    for (const revisions of [request.draftRevisions, request.translationUnitRevisions]) for (const [id, revision] of Object.entries(revisions || {})) if ((current.translations?.[request.language]?.[id]?.revision || 0) !== revision && !request.resultHash) fail('RESULT_STALE', 'The saved draft changed during result staging. No partial result was published.');
    const rawReview = request.mode === 'source-review' ? assertSourceReviewRequest(request,raw,app.core._files) : null;
    const ids = new Set(), selectedSegments = new Map(request.segments.map(segment => [segment.segmentId || segment.id, segment]));
    for (const item of input[key]) {
      const selected = selectedSegments.get(item.segmentId);
      if (!selected || ids.has(item.segmentId) || request.kind === 'revision' && item.beforeHash !== selected.beforeHash) fail('SELECTION_SCOPE_MISMATCH', 'Every staged record must belong once to the exact approved source scope.');
      ids.add(item.segmentId);
      if (rawReview) validateSourceReviewReplacement(rawReview.sources.get(item.segmentId),item.replacement,app.core._files);
      else restoreProtected(selected, request.kind === 'revision' ? item.replacement : item.text);
    }
    const part = stageResultRecords(request.resultStaging, { batchOffset: input.batchOffset, resultCount: input.resultCount, finalize: input.finalize, records: input[key] }, { identity: identity(request), recordKey: 'segmentId', reason: request.kind === 'revision' ? input.reason : null });
    if (part.published) return { published: true, result: part.result };
    request.resultStaging = part.staging; await app.core._commit(raw);
    if (!part.complete) return { receipt: receipt(request, part.staging) };
    return { payload: { requestId: request.requestId, [key]: part.values, ...(request.kind === 'revision' ? { reason: part.staging.reason } : {}) } };
  });
}

export async function finishSelectionResult(app, requestId, result) {
  return app.core._serial(async () => {
    const raw = app.core.getState(), request = raw.requests.find(row => row.requestId === requestId);
    if (!request?.resultHash || !request.resultStaging) return;
    request.resultStaging = { ...request.resultStaging, status: 'published', result: structuredClone(result), parts: request.resultStaging.parts.map(({ values, ...receipt }) => receipt) };
    await app.core._commit(raw);
  });
}
