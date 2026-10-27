import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { CompilerWorker } from '../src/compiler/worker.mjs';
const identity = await import('../src/build-identity.mjs').catch(() => ({}));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [{ path: 'refs.bib', hash: 'a'.repeat(64) }, { path: 'main.tex', hash: 'b'.repeat(64) }];

test('the fixed pdfTeX compatibility profile is part of the compiled input identity', () => {
  assert.equal(typeof identity.compilerProfile, 'function'); assert.equal(typeof identity.inputManifestIdentity, 'function');
  assert.equal(identity.compilerProfile('pdflatex'), 'pdftex-no-object-streams-v1');
  const expected = sha(JSON.stringify({ engine: 'pdflatex', mainFile: 'main.tex', compilerProfile: 'pdftex-no-object-streams-v1', files: [...files].sort((a, b) => a.path.localeCompare(b.path)) }));
  assert.equal(identity.inputManifestIdentity({ engine: 'pdflatex', mainFile: 'main.tex', files }), expected);
  assert.equal(identity.inputManifestIdentity({ engine: 'pdflatex', mainFile: 'main.tex', files: [...files].reverse(), compilerProfile: 'untrusted-model-profile' }), expected);
  assert.notEqual(expected, sha(JSON.stringify({ engine: 'pdflatex', mainFile: 'main.tex', files: [...files].sort((a, b) => a.path.localeCompare(b.path)) })));
});

test('XeLaTeX compiled input identities retain their exact previous payload and hash', () => {
  assert.equal(typeof identity.inputManifestIdentity, 'function'); assert.equal(identity.compilerProfile('xelatex'), null);
  assert.equal(identity.inputManifestIdentity({ engine: 'xelatex', mainFile: 'main.tex', files }), sha(JSON.stringify({ engine: 'xelatex', mainFile: 'main.tex', files: [...files].sort((a, b) => a.path.localeCompare(b.path)) })));
});

test('the trusted pdfTeX startup expression rejects main filename TeX metacharacters before invoking any engine', async () => {
  const worker = new CompilerWorker({ dataRoot: path.resolve('work/invalid-pdftex-entry') }); worker.probe = async () => { throw Error('Unsafe entry names must never reach the compiler.'); };
  for (const mainFile of ['main%.tex', 'main#.tex', 'main{.tex', 'main}.tex', 'main^.tex', 'main~.tex', 'main$.tex', 'main&.tex']) {
    await assert.rejects(worker.build({ engine: 'pdflatex', mainFile, files: [{ path: mainFile, bytes: Buffer.from('untrusted input') }] }), { code: 'INVALID_INPUT' });
  }
});
