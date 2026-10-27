import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// This list intentionally excludes UI capabilities, file import, chat creation or message sending,
// source acceptance, undo and arbitrary filesystem/shell operations.
export const BACKGROUND_MODEL_TOOLS = new Set([
  'bilingual_paper_get_state', 'bilingual_paper_read_segments',
  'bilingual_paper_get_request', 'bilingual_paper_propose_revision',
  'bilingual_paper_read_project','bilingual_paper_read_paragraphs','bilingual_paper_prepare_request','bilingual_paper_prepare_translation_task',
  'bilingual_paper_read_editor_drafts','bilingual_paper_save_editor_draft','bilingual_paper_reconcile_translation_draft',
  'bilingual_paper_workbench','bilingual_paper_edit_translation',
  'bilingual_paper_get_display_preferences','bilingual_paper_configure_display_preferences',
  'bilingual_paper_control_translation_task','bilingual_paper_configure_languages',
  'bilingual_paper_submit_translation_result', 'bilingual_paper_submit_chat_reply', 'bilingual_paper_compile',
  'bilingual_paper_list_pdfs', 'bilingual_paper_select_pdf',
  'bilingual_paper_get_pdf_context', 'bilingual_paper_submit_pdf_review',
  'bilingual_paper_get_review_organization_context',
  'bilingual_paper_submit_review_organization',
  'bilingual_paper_get_review_anchor_context', 'bilingual_paper_submit_review_anchors',
]);
const sessions = new WeakMap(), queues = new WeakMap();
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

/** Reuse the ordinary validated MCP handlers against the window's actual service.
 * Transport stays in memory; a localhost capability never enters model output. */
export async function callBackgroundModelTool(service, input) {
  if (!input || Object.keys(input).some(key => !['name', 'arguments', 'bindingId', 'originThreadId'].includes(key)) ||
      !BACKGROUND_MODEL_TOOLS.has(input.name) || input.originThreadId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(input.originThreadId || '') || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.bindingId || '') ||
      !input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) {
    fail('MODEL_TOOL_NOT_ALLOWED', 'Use one supported paper model tool with its exact originating instance.');
  }
  // A native host may issue parallel calls, including calls from a replacement
  // MCP instance. Keep setup, use and replacement in one per-daemon sequence:
  // closing a previous client's transport while its handler is awaiting a job
  // otherwise loses the reply and may duplicate a later manual retry.
  const previous = queues.get(service) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => invoke(service, input));
  queues.set(service, task);
  try { return await task; }
  finally { if (queues.get(service) === task) queues.delete(service); }
}

async function invoke(service, input) {
  // Imports can acquire the daemon after this call entered the queue. Recheck
  // at execution so a delayed tool never sees a partially imported paper.
  if (service._assistantImportPromise) fail('IMPORT_BUSY', 'Wait for the current file import to finish.');
  let current = sessions.get(service);
  if (current?.bindingId !== input.bindingId || (current?.originThreadId || null) !== (input.originThreadId || null)) {
    if (current) { sessions.delete(service); await current.client.close(); await current.server.close(); }
    const { createPaperServer } = await import('./server.mjs');
    const server = createPaperServer({ service, instanceId: input.bindingId, nativeThreadId: input.originThreadId || null, uiHtml: '<!doctype html>' });
    const client = new Client({ name: 'paper-background-model-channel', version: '1.6.3' });
    try {
      const [cs, ss] = InMemoryTransport.createLinkedPair(); await server.connect(ss); await client.connect(cs);
      current = { bindingId: input.bindingId, originThreadId: input.originThreadId || null, server, client }; sessions.set(service, current);
    } catch (error) { await client.close().catch(() => {}); await server.close().catch(() => {}); throw error; }
  }
  return current.client.callTool({ name: input.name, arguments: input.arguments }, undefined, { timeout: 180000 });
}
