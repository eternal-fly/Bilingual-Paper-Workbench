import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';

export const requiredFontFamilies = Object.freeze(['Noto Serif CJK SC', 'Noto Serif CJK SC Bold', 'Noto Sans CJK SC', 'AR PL UKai CN']);
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
function directory(value) {
  if (typeof value !== 'string' || (!path.isAbsolute(value) && !path.win32.isAbsolute(value)) || value.includes('\0')) throw new TypeError('Font directories must be absolute paths.');
  return xml(value.replaceAll('\\', '/'));
}
export function buildFontconfig({ bundleDir, latinDir, cacheDir }) {
  return `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>${directory(bundleDir)}</dir>\n  <dir>${directory(latinDir)}</dir>\n  <cachedir>${directory(cacheDir)}</cachedir>\n  <config><rescan><int>0</int></rescan></config>\n</fontconfig>\n`;
}
// esbuild assigns the containing bundle URL to imported modules too. A CLI name
// check keeps importing this pure helper from starting its command-line entrypoint.
if (process.argv[1] && path.basename(process.argv[1]) === 'fonts-config.mjs' && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, , output, bundleDir, latinDir, cacheDir] = process.argv;
  if (!output || !bundleDir || !latinDir || !cacheDir) throw new Error('Usage: fonts-config.mjs output bundleDir latinDir cacheDir');
  await writeFile(output, buildFontconfig({ bundleDir, latinDir, cacheDir }), 'utf8');
  console.log(JSON.stringify({ ok: true, families: requiredFontFamilies }));
}
