import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function verifyIcons({ root = fileURLToPath(new URL('../', import.meta.url)) } = {}) {
  const directory = path.join(root, 'assets'), manifest = JSON.parse(await readFile(path.join(directory, 'icon-manifest.json'), 'utf8'));
  const source = await readFile(path.join(directory, 'paper-editor.svg'));
  assert.equal(manifest.schemaVersion, 1); assert.equal(hash(source), manifest.sourceSha256);
  assert.match(source.toString('utf8'), /viewBox="0 0 256 256"/); assert.ok(!/<script|<image|url\(|(?:href|src)=/i.test(source.toString('utf8')), 'Brand source must be a self-contained vector.');
  const sizes = [16, 24, 32, 48, 64, 128, 256], pngs = [];
  for (const size of sizes) {
    const name = `paper-editor-${size}.png`, bytes = await readFile(path.join(directory, name)); pngs.push(bytes);
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(bytes.readUInt32BE(16), size); assert.equal(bytes.readUInt32BE(20), size); assert.equal(bytes[25], 6, 'PNG icons must retain transparent RGBA corners.');
    assert.equal(hash(bytes), manifest.files[name].sha256);
  }
  const ico = await readFile(path.join(directory, 'paper-editor.ico'));
  assert.equal(ico.readUInt16LE(0), 0); assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), sizes.length);
  let end = 6 + sizes.length * 16;
  for (let index = 0; index < sizes.length; index++) {
    const at = 6 + index * 16, size = sizes[index];
    assert.equal(ico[at] || 256, size); assert.equal(ico[at + 1] || 256, size); assert.equal(ico.readUInt16LE(at + 4), 1); assert.equal(ico.readUInt16LE(at + 6), 32);
    assert.equal(ico.readUInt32LE(at + 12), end); assert.equal(ico.readUInt32LE(at + 8), pngs[index].length);
    assert.deepEqual(ico.subarray(end, end + pngs[index].length), pngs[index]); end += pngs[index].length;
  }
  assert.equal(ico.length, end); assert.equal(hash(ico), manifest.files['paper-editor.ico'].sha256);
  return { ok: true, pngSizes: sizes, icoFrames: sizes.length, selfContainedVector: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(await verifyIcons()));
