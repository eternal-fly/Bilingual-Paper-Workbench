import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function loadMarkdownFontLicense(root = fileURLToPath(new URL('../', import.meta.url))) {
  return readFile(path.join(root, 'assets/katex-fonts-OFL.txt'), 'utf8');
}

/** KaTeX and every font are bundled into the artifact: no CDN/font requests. */
export async function loadMarkdownCss(root = fileURLToPath(new URL('../', import.meta.url))) {
  const directory = path.join(root, 'node_modules/katex/dist');
  let css = await readFile(path.join(directory, 'katex.min.css'), 'utf8');
  const replacements = new Map();
  for (const match of css.matchAll(/url\((?:["']?)(fonts\/[A-Za-z0-9_.-]+\.(woff2?|ttf))(?:["']?)\)/g)) {
    if (replacements.has(match[0])) continue;
    const bytes = await readFile(path.join(directory, match[1]));
    const extension = path.extname(match[1]).slice(1), mime = extension === 'ttf' ? 'font/ttf' : `font/${extension}`;
    replacements.set(match[0], `url(data:${mime};base64,${bytes.toString('base64')})`);
  }
  for (const [source, replacement] of replacements) css = css.replaceAll(source, replacement);
  if (/@import|url\((?!["']?data:)/.test(css)) throw new Error('An external KaTeX stylesheet resource remains.');
  return `/*!\n${await loadMarkdownFontLicense(root)}\n*/\n${css}`;
}
