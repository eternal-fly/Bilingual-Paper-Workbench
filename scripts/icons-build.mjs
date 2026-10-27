// Rebuild optional raster derivatives using PDF.js's already locked optional
// @napi-rs/canvas 1.0.13 dependency. The normal build copies committed assets and
// does not require this native renderer or add any new package dependency.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = await readFile(path.join(root, 'assets/paper-editor.svg'));
const icon = await loadImage(source), sizes = [16, 24, 32, 48, 64, 128, 256];
const buffers = [], files = {};
for (const size of sizes) {
  const canvas = createCanvas(size, size), context = canvas.getContext('2d');
  context.drawImage(icon, 0, 0, size, size);
  const bytes = canvas.toBuffer('image/png'), name = `paper-editor-${size}.png`;
  await writeFile(path.join(root, 'assets', name), bytes); buffers.push(bytes);
  files[name] = { width: size, height: size, sha256: createHash('sha256').update(bytes).digest('hex') };
}
// Modern Windows accepts PNG-compressed frames in ICO. Preserve one real
// rendered frame for every size instead of upscaling a single bitmap.
const header = Buffer.alloc(6 + sizes.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (let i = 0; i < sizes.length; i++) {
  const at = 6 + i * 16; header[at] = sizes[i] === 256 ? 0 : sizes[i]; header[at + 1] = header[at];
  header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6); header.writeUInt32LE(buffers[i].length, at + 8); header.writeUInt32LE(offset, at + 12); offset += buffers[i].length;
}
const ico = Buffer.concat([header, ...buffers]); await writeFile(path.join(root, 'assets/paper-editor.ico'), ico);
files['paper-editor.ico'] = { frames: sizes, sha256: createHash('sha256').update(ico).digest('hex') };

const sheet = createCanvas(1024, 560), context = sheet.getContext('2d');
context.fillStyle = '#f6f0e4'; context.fillRect(0, 0, 1024, 560);
context.fillStyle = '#20364d'; context.font = '600 23px sans-serif'; context.fillText('Bilingual Paper Workbench', 32, 42);
context.font = '14px sans-serif'; context.fillStyle = '#536779'; context.fillText('Paired pages / bidirectional bridge / reviewed writing', 32, 67);
const visible = [16, 32, 64, 256], positions = [78, 222, 380, 628];
for (let row = 0; row < 2; row++) {
  const top = row ? 322 : 112;
  context.fillStyle = row ? '#161f2b' : '#fffaf0'; context.fillRect(24, top - 28, 976, 200);
  for (let index = 0; index < visible.length; index++) {
    const size = visible[index], rendered = size === 256 ? 144 : size;
    context.drawImage(icon, positions[index], top + (128 - rendered) / 2, rendered, rendered);
    context.fillStyle = row ? '#d6dee7' : '#354b60'; context.font = '13px sans-serif'; context.fillText(`${size} × ${size}${size === 256 ? '  (preview 144px)' : ''}`, positions[index], top + 151);
  }
}
await writeFile(path.join(root, 'assets/icon-contact-sheet.png'), sheet.toBuffer('image/png'));
await writeFile(path.join(root, 'assets/icon-manifest.json'), JSON.stringify({ schemaVersion: 1, source: 'paper-editor.svg', sourceSha256: createHash('sha256').update(source).digest('hex'), renderer: '@napi-rs/canvas@1.0.13 (existing PDF.js optional dependency)', colors: { ink: '#20364d', paper: '#fff6e4', translation: '#efbd5e' }, files }, null, 2) + '\n');
console.log(JSON.stringify({ ok: true, sizes, icoFrames: sizes.length, contactSheet: 'assets/icon-contact-sheet.png', addedDependencies: 0 }));
