/** Model-visible operation guidance. It contains no browser/session capability. */
export const NATIVE_FIRST_INSTRUCTION = 'Operate this already-open paper through native MCP tools by default. Use bilingual_paper_read_project for exact paper identities and paragraph IDs, then bilingual_paper_read_paragraphs for saved protected text. For current, unsaved or failed-save author input, call bilingual_paper_read_editor_drafts; saved drafts are not a live editor capture. This read never saves or reconciles. Save only when explicitly requested, using bilingual_paper_save_editor_draft with the exact captured identity/hash/base revision and no replacement text. Reconcile only when requested and exact confirmed writeback proof permits bilingual_paper_reconcile_translation_draft; never force a conflict. EDITOR_NOT_CONNECTED, EDITOR_CAPTURE_TIMEOUT, EDITOR_COMPOSING and version/buffer conflicts require an honest status while preserving the input, not Computer Use, browser clicks, DOM inspection, clipboard copying or a guessed window. Native tools need no UI token, browser address or second model turn.';

export function nativeAccess(command = null) {
  return {
    mode: 'native-mcp',
    projectTool: 'bilingual_paper_read_project',
    paragraphTool: 'bilingual_paper_read_paragraphs',
    liveEditorTool: 'bilingual_paper_read_editor_drafts',
    capturedSaveTool: 'bilingual_paper_save_editor_draft',
    reconcileTool: 'bilingual_paper_reconcile_translation_draft',
    instruction: NATIVE_FIRST_INSTRUCTION,
    ...(command ? { currentTransport: { command, input: 'UTF-8 JSON on stdin; project and state allow an empty object.', verbs: ['state', 'project', 'paragraphs', 'read-editor', 'save-editor', 'reconcile-draft', 'prepare', 'prepare-translation', 'control-translation', 'languages', 'display', 'set-display', 'get', 'submit', 'revision', 'reply'], instruction: 'If this Desktop chat has an older tool catalog, use these fixed verbs through this current installed MCP transport in this same inherited Desktop turn. It starts no model or extra chat. Use project first; pass its exact identities to paragraphs/read-editor/prepare. Never choose another chat, a UI token, a raw endpoint or an arbitrary tool. Do not rebuild or inspect plugin source, use Computer Use, or enqueue another message as a fallback.' } } : {}),
  };
}

export function nativeTicketGuidance(command = null) {
  return `${NATIVE_FIRST_INSTRUCTION}${command ? ` If the native catalog is stale or lacks these tools, use the current installed transport ${command} project with {} on UTF-8 stdin, then ${command} read-editor with its exact expectedProjectId and expectedSnapshotId (and optional selected paragraph IDs). Fixed verbs paragraphs, save-editor, reconcile-draft, prepare and prepare-translation expose the corresponding native operations. Keep the inherited Desktop chat identity unchanged. The helper is transport only; do not use a browser or write an improvised client.` : ' If the host lacks these native tools and provides no current installed transport, report that capability gap instead of switching to computer control.'}`;
}
