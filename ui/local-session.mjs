const invalid = () => Object.assign(Error('The local workbench session fragment is invalid. Reopen the paper from its chat.'), { code: 'SESSION_FRAGMENT_INVALID' });

/** Capabilities never share their bearer value with the one-use window handoff. */
export function parseLocalSessionFragment(hash = '') {
  if (hash === '') return { session: null, handoffId: null };
  if (typeof hash !== 'string' || !hash.startsWith('#') || hash.length > 256) throw invalid();
  const params = new URLSearchParams(hash.slice(1)), keys = [...params.keys()];
  if (keys.some(key => !['session', 'handoff'].includes(key)) || params.getAll('session').length !== 1 || params.getAll('handoff').length > 1) throw invalid();
  const session = params.get('session'), handoffId = params.get('handoff');
  if (!/^[A-Za-z0-9_-]{43}$/.test(session || '') || handoffId !== null && !/^[a-f0-9]{48}$/.test(handoffId)) throw invalid();
  if (hash !== '#session=' + session + (handoffId ? '&handoff=' + handoffId : '')) throw invalid();
  return { session, handoffId };
}
export function isLocalWorkbenchUrl(value, { allowHandoff = false } = {}) {
  if (typeof value !== 'string' || value.length > 300 || value.trim() !== value) return false;
  try {
    const url = new URL(value), parsed = parseLocalSessionFragment(url.hash);
    return url.href === value && value.startsWith('http://127.0.0.1:') && url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port) && Number(url.port) > 0 && Number(url.port) <= 65535 && url.pathname === '/' && !url.search && !url.username && !url.password && Boolean(parsed.session) && (allowHandoff || !parsed.handoffId);
  } catch { return false; }
}
export const isCanonicalWorkbenchUrl = value => isLocalWorkbenchUrl(value);
