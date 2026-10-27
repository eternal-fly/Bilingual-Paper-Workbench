import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFontconfig, requiredFontFamilies } from '../scripts/fonts-config.mjs';
import { readFileSync } from 'node:fs';

test('font configuration searches only the explicit bundle and Latin font roots', () => {
  const xml = buildFontconfig({ bundleDir: 'C:/private/fonts/bundle', latinDir: 'C:/runtime/tex/fonts/lm', cacheDir: 'C:/private/job/font-cache' });
  const dirs = [...xml.matchAll(/<dir>(.*?)<\/dir>/g)].map(match => match[1]);
  assert.deepEqual(dirs, ['C:/private/fonts/bundle', 'C:/runtime/tex/fonts/lm']);
  assert.ok(!xml.includes('C:/Windows') && !xml.includes('<include'));
  assert.ok(xml.includes('<cachedir>C:/private/job/font-cache</cachedir>'));
});
test('font paths are XML escaped and relative roots are rejected', () => {
  const xml = buildFontconfig({ bundleDir: 'C:/Font & Documents/bundle', latinDir: 'C:/tex/lm', cacheDir: 'C:/job/cache' });
  assert.ok(xml.includes('Font &amp; Documents'));
  assert.throws(() => buildFontconfig({ bundleDir: '../escape', latinDir: 'C:/tex/lm', cacheDir: 'C:/job/cache' }), /absolute/i);
});
test('required families preserve the manuscript font names exactly', () => {
  assert.deepEqual(requiredFontFamilies, ['Noto Serif CJK SC', 'Noto Serif CJK SC Bold', 'Noto Sans CJK SC', 'AR PL UKai CN']);
});
test('font sources are versioned official HTTPS artifacts with exact binary hashes', () => {
  const manifest = JSON.parse(readFileSync(new URL('../scripts/fonts-sources.json', import.meta.url), 'utf8'));
  assert.equal(manifest.fonts.length, 4);
  for (const font of manifest.fonts) {
    const url = new URL(font.url);
    assert.equal(url.protocol, 'https:');
    assert.ok(['raw.githubusercontent.com', 'deb.debian.org'].includes(url.hostname));
    assert.match(font.sha256, /^[a-f0-9]{64}$/);
    if (url.hostname === 'raw.githubusercontent.com') assert.match(url.pathname, /^\/notofonts\/noto-cjk\/(Serif|Sans)\d+\.\d+\//);
    else assert.ok(font.url.endsWith(`_${font.version}_all.deb`));
    assert.ok(font.license && font.licenseUrl);
  }
});
