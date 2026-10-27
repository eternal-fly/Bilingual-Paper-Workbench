import test from 'node:test';
import assert from 'node:assert/strict';
import { stageResultRecords } from '../src/selection-result-staging.mjs';
const options = { identity: 'exact-request-and-source', recordKey: 'noteId' };
test('byte transport parts collect sequential complete records and finalize one atomic complete result', () => {
  const first = stageResultRecords(null, { batchOffset: 0, resultCount: 3, finalize: false, records: [{ noteId: 'a', body: 'One' }] }, options);
  assert.equal(first.complete, false); assert.equal(first.staging.received, 1); assert.equal(first.values, undefined);
  assert.deepEqual(stageResultRecords(first.staging, { batchOffset: 0, resultCount: 3, finalize: false, records: [{ noteId: 'a', body: 'One' }] }, options), first);
  const before = structuredClone(first), final = stageResultRecords(first.staging, { batchOffset: 1, resultCount: 3, finalize: true, records: [{ noteId: 'b', body: 'Two' }, { noteId: 'c', body: 'Three' }] }, options);
  assert.equal(final.complete, true); assert.deepEqual(final.values.map(row => row.noteId), ['a', 'b', 'c']); assert.deepEqual(first, before);
});
test('missing records, repeated identities, changed offsets and conflicting retries never publish a partial result', () => {
  const first = stageResultRecords(null, { batchOffset: 0, resultCount: 3, finalize: false, records: [{ noteId: 'a', body: 'One' }] }, options);
  for (const input of [{ batchOffset: 2, resultCount: 3, finalize: true, records: [{ noteId: 'c' }] }, { batchOffset: 1, resultCount: 3, finalize: true, records: [{ noteId: 'b' }] }, { batchOffset: 1, resultCount: 3, finalize: false, records: [{ noteId: 'a' }] }, { batchOffset: 0, resultCount: 3, finalize: false, records: [{ noteId: 'a', body: 'Changed' }] }]) assert.throws(() => stageResultRecords(first.staging, input, options));
  assert.throws(() => stageResultRecords(first.staging, { batchOffset: 1, resultCount: 3, finalize: true, records: [{ noteId: 'b' }, { noteId: 'c' }] }, { ...options, identity: 'other-paper' }));
});
