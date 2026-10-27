const reservedPlaceholder = /\[\[(P\d+(?:_[^\]\r\n]{1,160})?)\]\]|⟦(P\d+(?:_[^⟧\r\n]{1,160})?)⟧/gi;
const placeholderKey = value => {
  const match = /^(?:\[\[(P\d+(?:_[a-f0-9]{1,64})?)\]\]|⟦(P\d+(?:_[a-f0-9]{1,64})?)⟧)$/i.exec(value);
  return match ? (match[1] || match[2]).toLowerCase() : null;
};
function add(index, key, raw) {
  if (!index.has(key)) index.set(key, new Set()); index.get(key).add(raw);
}

/** Display-only text. The caller must assign the result with textContent. */
export function createReviewDisplayText(state, fallback = '受保护对象（详见原文）') {
  const global = new Map(), bySource = new Map(), scoped = new Map();
  for (const source of [...(state.readingParagraphs || []), ...(state.segments || [])]) {
    if (!bySource.has(source.id)) bySource.set(source.id, new Map());
    for (const token of source.protectedTokens || []) {
      const key = typeof token.id === 'string' ? placeholderKey(token.id) : null;
      if (!key || typeof token.raw !== 'string' || !token.raw.length) continue;
      add(global, key, token.raw); add(bySource.get(source.id), key, token.raw);
    }
  }
  return (text, sourceSegmentIds = []) => {
    const ids = [...new Set(Array.isArray(sourceSegmentIds) ? sourceSegmentIds : [])].sort(), scopeKey = JSON.stringify(ids);
    if (!scoped.has(scopeKey)) {
      const index = new Map();
      for (const id of ids) for (const [key, values] of bySource.get(id) || []) for (const raw of values) add(index, key, raw);
      scoped.set(scopeKey, index);
    }
    const anchored = scoped.get(scopeKey);
    return String(text || '').replace(reservedPlaceholder, placeholder => {
      const key = placeholderKey(placeholder), values = key ? anchored.get(key) || global.get(key) : null;
      return values?.size === 1 ? values.values().next().value : fallback;
    }).replace(reservedPlaceholder, fallback);
  };
}
