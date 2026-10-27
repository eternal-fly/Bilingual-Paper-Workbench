import { createHash } from 'node:crypto';

/** Fixed worker policy, never a model- or document-supplied compiler prelude. */
export function compilerProfile(engine) {
  if (!['xelatex', 'pdflatex'].includes(engine)) throw new TypeError('Unsupported compiler engine.');
  return engine === 'pdflatex' ? 'pdftex-no-object-streams-v1' : null;
}

/** Identity of exact input bytes (already hashed) and the fixed engine policy.
 * XeLaTeX deliberately retains its previous payload and hash for saved builds. */
export function inputManifestIdentity({ engine, mainFile, files }) {
  const profile = compilerProfile(engine);
  const identity = { engine, mainFile, ...(profile ? { compilerProfile: profile } : {}), files: files.map(({ path, hash }) => ({ path, hash })).sort((a, b) => a.path.localeCompare(b.path)) };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
