import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLocalSessionFragment, isCanonicalWorkbenchUrl } from '../ui/local-session.mjs';

const session = 'a'.repeat(43), handoff = 'b'.repeat(48);
test('local workbench sessions accept only one exact session and optional project handoff', () => {
  assert.deepEqual(parseLocalSessionFragment(''), { session: null, handoffId: null });
  assert.deepEqual(parseLocalSessionFragment('#session=' + session), { session, handoffId: null });
  assert.deepEqual(parseLocalSessionFragment('#session=' + session + '&handoff=' + handoff), { session, handoffId: handoff });
  for (const value of ['#session=short', '#session=' + session + '&session=' + session, '#session=' + session + '&unknown=x', '#session=' + session + '&handoff=short', '#handoff=' + handoff, '#session=' + session + '&handoff=' + handoff + '&handoff=' + handoff]) assert.throws(() => parseLocalSessionFragment(value), { code: 'SESSION_FRAGMENT_INVALID' });
});
test('rollback accepts canonical loopback workbench capabilities without a nested handoff', () => {
  assert(isCanonicalWorkbenchUrl('http://127.0.0.1:49152/#session=' + session));
  for (const value of ['https://127.0.0.1:49152/#session=' + session, 'http://localhost:49152/#session=' + session, 'http://0x7f000001:49152/#session=' + session, 'http://127.0.0.1:49152/path#session=' + session, 'http://127.0.0.1:49152/path/../#session=' + session, 'http://127.0.0.1:49152/?redirect=x#session=' + session, 'http://user@127.0.0.1:49152/#session=' + session, 'http://127.0.0.1:49152/#session=' + session + '&handoff=' + handoff]) assert.equal(isCanonicalWorkbenchUrl(value), false, value);
});
