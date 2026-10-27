/** Byte budgets bound memory/transport, never the number of selected records. */
export const MODEL_CONTEXT_BYTES = 2 * 1024 * 1024;
export const MODEL_TOOL_BYTES = 8 * 1024 * 1024;
export const REGISTERED_REQUEST_BYTES = 64 * 1024 * 1024;
export const jsonBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Pages contain complete protected records. Offsets remain bound to the same
 * registered request and version; callers never silently omit the remainder. */
export function paginateItems(base, key, items, { offset = 0, maxBytes = MODEL_CONTEXT_BYTES, itemLimit = Infinity } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length) throw Object.assign(Error('Choose a valid continuation offset for this exact registered selection.'), { code: 'INVALID_INPUT' });
  const page = [], reserved = jsonBytes({ ...base, [key]: [], offset, total: items.length, nextOffset: items.length, byteBudget: maxBytes }) + 1024;
  let bytes = reserved;
  for (let index = offset; index < items.length; index++) {
    if (page.length >= itemLimit) break;
    const next = jsonBytes(items[index]) + (page.length ? 1 : 0);
    if (bytes + next > maxBytes && page.length) break;
    if (bytes + next > MODEL_TOOL_BYTES - 4096) throw Object.assign(Error('One complete protected record exceeds the transport byte budget. Its content was retained and no incomplete record was sent.'), { code: 'ATOMIC_ITEM_TOO_LARGE' });
    page.push(items[index]); bytes += next;
  }
  const nextOffset = offset + page.length < items.length ? offset + page.length : null;
  const atomicItemException = page.length === 1 && bytes > maxBytes;
  const packet = { ...base, [key]: page, offset, total: items.length, nextOffset, targetByteBudget: maxBytes, byteBudget: atomicItemException ? MODEL_TOOL_BYTES - 4096 : maxBytes, atomicItemException, serializedBytes: 0, ...(nextOffset !== null ? { continuation: 'Read the next complete page with the same request identity and nextOffset before returning the complete result.' } : {}) };
  for (let pass = 0; pass < 3; pass++) packet.serializedBytes = jsonBytes(packet);
  return packet;
}
