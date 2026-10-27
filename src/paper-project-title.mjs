import path from 'node:path';
import { lstat, open, realpath } from 'node:fs/promises';
import { readEnglishSourceParagraphs } from './english-source-paragraphs.mjs';

/** A display label derived from an already parsed source title; never executes TeX. */
export function paperProjectTitle(state) {
  const title = (state?.readingParagraphs || []).find(item => item.kind === 'title' && (!state.project?.mainFile || item.path === state.project.mainFile)) || (state?.readingParagraphs || []).find(item => item.kind === 'title');
  const text = title?.source;
  if (typeof text !== 'string' || Buffer.byteLength(text) > 8192) return '';
  return text.replace(/\\[A-Za-z@]+\*?(?:\[[^\]\r\n]{0,256}\])?/gu, '').replace(/[{}$]/gu, '').replace(/[\x00-\x1f\x7f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 240);
}

/** Bounded legacy-label fallback; no dependency discovery, model call or index touch. */
export async function readProjectTitle(record) {
  let handle;
  try {
    const root = await realpath(record.projectRoot); if (root.toLowerCase() !== record.projectRoot.toLowerCase()) return '';
    const filename = path.join(root, record.mainFile), info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return '';
    for (let directory = path.dirname(filename); directory !== root; directory = path.dirname(directory)) { const entry = await lstat(directory); if (!entry.isDirectory() || entry.isSymbolicLink() || directory === path.dirname(directory)) return ''; }
    handle = await open(filename, 'r'); const locked = await handle.stat(); if (locked.ino !== info.ino || locked.dev !== info.dev || locked.nlink !== 1) return '';
    const bytes = Buffer.alloc(Math.min(info.size, 64 * 1024)); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0); const after = await handle.stat(); if (after.size !== locked.size || after.mtimeMs !== locked.mtimeMs) return '';
    const source = new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, bytesRead)), reading = readEnglishSourceParagraphs(source, record.mainFile), titles = reading.paragraphs.filter(item => item.kind === 'title');
    return titles.length === 1 ? paperProjectTitle({ project: { mainFile: record.mainFile }, readingParagraphs: titles }) : '';
  } catch { return ''; } finally { await handle?.close(); }
}
