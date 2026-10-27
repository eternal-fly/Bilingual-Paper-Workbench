const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);

/** Backend-supplied origin identity chooses the Desktop route before metadata
 * is ready. Only verified metadata enables delivery or exposes its model. */
export function configuredDesktopExecution(state) {
  const execution = state.desktopExecution;
  if (execution?.mode !== 'desktop-queue') return null;
  const origin = state.originatingChat, binding = state.nativeChatBinding;
  const savedMatches = validId(execution.threadId) && binding?.threadId === execution.threadId && binding.projectId === state.project?.id;
  const originMatches = validId(origin?.threadId) && (!origin.projectId || !state.project?.id || origin.projectId === state.project.id);
  const threadId = savedMatches ? execution.threadId : originMatches ? origin.threadId : null;
  if (!threadId) return null;
  const metadataVerified = savedMatches || origin?.verified === true && execution.threadId === threadId;
  return { ...execution, threadId, metadataVerified, available: execution.available === true && metadataVerified,
    model: metadataVerified ? execution.model : null, effort: metadataVerified ? execution.effort : null, title: metadataVerified ? execution.title : null,
    messages: metadataVerified ? execution.messages || [] : [] };
}

/** Persisted Desktop tickets contain the author text and an optional returned
 * reply in one row. Keep both visible with stable transcript identities. */
export function desktopMessageHistory(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(row => {
    if (!row || typeof row !== 'object') return [];
    if (['user', 'assistant', 'tool', 'system'].includes(row.role)) return [row];
    if (!validId(row.messageId) || typeof row.text !== 'string') return [];
    const user = { ...row, id: `desktop:${row.messageId}:user`, role: 'user', text: row.text, status: row.status === 'completed' ? 'sent' : row.status };
    return [user, ...(typeof row.reply === 'string' ? [{ ...row, id: `desktop:${row.messageId}:assistant`, role: 'assistant', text: row.reply, status: 'received', createdAt: row.completedAt || row.updatedAt || row.createdAt }] : [])];
  });
}
