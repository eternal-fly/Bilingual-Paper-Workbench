import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

/** Prefer the pinned checkout dependency; an explicit override and the legacy
 * host cache remain available without bundling browser tooling in the runtime. */
export async function loadPlaywright() {
  const override=process.env.PAPER_EDITOR_PLAYWRIGHT_MODULE;
  if(override){if(!path.isAbsolute(override))throw new Error('PAPER_EDITOR_PLAYWRIGHT_MODULE must name an absolute module path.');return import(pathToFileURL(override).href);}
  let local;
  try{local=import.meta.resolve('playwright');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
  if(local)return import(local);
  const modulePath=path.join(os.homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','node','node_modules','playwright','index.mjs');
  try{return await import(pathToFileURL(modulePath).href);}
  catch(error){throw new Error('Install the pinned Playwright development dependency or set PAPER_EDITOR_PLAYWRIGHT_MODULE before running UI QA.',{cause:error});}
}
export const browserOptions = { channel: process.env.PAPER_EDITOR_BROWSER_CHANNEL || (process.platform==='win32'?'msedge':'chromium'), headless: true };

/** Follow the real reading-to-editing interaction before typing in a draft. */
export async function openTranslationEditor(page, selector) {
  const editor = typeof selector === 'string' ? page.locator(selector) : selector;
  await editor.waitFor({ state: 'attached' });
  if (!await editor.isVisible()) await editor.locator('..').locator('.translation-reading').click();
  await editor.waitFor({ state: 'visible' }); await editor.focus();
  return editor;
}
