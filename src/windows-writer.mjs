import { spawn } from 'node:child_process';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const helper = fileURLToPath(new URL('./windows-writer.ps1', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function relative(value) {
  if (typeof value !== 'string' || path.isAbsolute(value) || value.replaceAll('\\', '/').split('/').some(part => !part || ['.', '..'].includes(part) || /[\x00-\x1f<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) fail('PERMISSION_DENIED', 'Source path is outside the authorized project.');
  return value.replaceAll('\\', '/');
}
export class WindowsSourceWriter {
  constructor({ dataRoot, powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') }) {
    this.dataRoot = dataRoot; this.powershell = powershell;
  }
  async write(input, { onLocked = async () => {}, onProgress = async () => {} } = {}) {
    if (process.platform !== 'win32') fail('CAPABILITY_UNAVAILABLE', 'This writer is verified only on Windows NTFS.');
    if (!Array.isArray(input.readSet) || input.readSet.length < 1 || input.readSet.length > 500 || !Array.isArray(input.changes) || input.changes.length > 500) fail('INVALID_INPUT', 'Invalid compiled read-set.');
    const readSet = input.readSet.map(item => ({ path: relative(item.path), hash: item.hash }));
    const keys = new Set(readSet.map(item => item.path.toLowerCase()));
    if (keys.size !== readSet.length || readSet.some(item => !/^[a-f0-9]{64}$/.test(item.hash))) fail('INVALID_INPUT', 'Invalid or duplicate read-set entry.');
    const changes = input.changes.map(item => {
      const name = relative(item.path), bytes = Buffer.from(item.bytes);
      if (!keys.has(name.toLowerCase())) fail('PERMISSION_DENIED', 'Candidate is outside the compiled read-set.');
      if (bytes.length > 4 * 1024 * 1024 || digest(bytes) !== item.hash || !/^[a-f0-9]{64}$/.test(item.beforeHash)) fail('CANDIDATE_HASH_MISMATCH', 'Candidate bytes are not the reviewed content.');
      return { path: name, base64: bytes.toString('base64'), hash: item.hash, beforeHash: item.beforeHash };
    });
    await mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    const requestFile = path.join(this.dataRoot, `writer-${randomUUID()}.json`);
    await writeFile(requestFile, JSON.stringify({ schemaVersion: 1, root: path.resolve(input.root), transactionId: input.transactionId, readSet, changes }), { flag: 'wx', mode: 0o600 });
    let child;
    try {
      return await new Promise((resolve, reject) => {
        let buffer = '', stderr = '', settled = false, outcome = null, chain = Promise.resolve(); const decoder = new StringDecoder('utf8');
        const finish = (error, result) => {
          if (outcome || settled) return;
          outcome = { error, result }; clearTimeout(timer);
          if (error && child.exitCode === null) child.kill(); else child.stdin.end();
        };
        child = spawn(this.powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-RequestFile', requestFile], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        const timer = setTimeout(() => finish(Object.assign(new Error('Source writer timed out; inspect its durable transaction journal.'), { code: 'PARTIAL_COMMIT_RECOVERY_REQUIRED' })), 30000);
        child.on('error', error => finish(error));
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1000); });
        child.stdout.on('data', chunk => {
          buffer += decoder.write(chunk);
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
            if (!line) continue;
            chain = chain.then(async () => {
              let event;
              try { event = JSON.parse(line); } catch { fail('SOURCE_WRITE_FAILED', 'Native writer returned an invalid event.'); }
              if (event.phase === 'error') fail(event.code, event.message);
              if (event.phase === 'locked') { await onLocked(event); child.stdin.write('commit\n'); }
              else if (event.phase === 'written') { await onProgress(event); child.stdin.write('continue\n'); }
              else if (event.phase === 'applied') finish(null, { status: 'applied', ...event });
            }).catch(error => finish(error));
          }
        });
        child.on('close', code => { chain.then(() => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          if (!outcome) outcome = { error: Object.assign(new Error(`Native source writer exited before completing (${code}). ${stderr}`), { code: 'PARTIAL_COMMIT_RECOVERY_REQUIRED' }) };
          outcome.error ? reject(outcome.error) : resolve(outcome.result);
        }); });
      });
    } finally { await unlink(requestFile).catch(() => {}); }
  }
}
