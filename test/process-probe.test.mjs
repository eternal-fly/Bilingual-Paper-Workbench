import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { isProcessProvenDead } from '../src/process-probe.mjs';

const targetPid = 1789432671;
const denied = () => { throw Object.assign(Error('Synthetic permission denial.'), { code: 'EPERM' }); };
function adapter({ value, stdout, stderr = '', code = 0, never = false } = {}) {
  const observed = { launches: 0, kills: 0 };
  observed.spawn = (command, args, options) => {
    observed.launches++; Object.assign(observed, { command, args, options });
    const child = new EventEmitter(); observed.child = child; child.exitCode = null; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.kill = () => { observed.kills++; child.exitCode = 1; queueMicrotask(() => child.emit('close', 1)); };
    child.stdin.end = input => { observed.input = input; if (!never) queueMicrotask(() => { if (stderr) child.stderr.emit('data', Buffer.from(stderr)); child.stdout.emit('data', Buffer.from(stdout ?? JSON.stringify(value))); child.exitCode = code; child.emit('close', code); }); };
    return child;
  };
  return observed;
}

test('invalid/current PIDs and non-Windows access errors are never interpreted as dead', async () => {
  const unused = () => { throw Error('A process helper must not be launched.'); };
  for (const pid of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER, '123', process.pid]) assert.equal(await isProcessProvenDead(pid, { spawnAdapter: unused }), false);
  assert.equal(await isProcessProvenDead(targetPid, { platform: 'linux', kill: denied, spawnAdapter: unused }), false);
  assert.equal(await isProcessProvenDead(targetPid, { platform: 'win32', kill: () => { throw Object.assign(Error(), { code: 'EACCES' }); }, spawnAdapter: unused }), false);
  assert.equal(await isProcessProvenDead(targetPid, { platform: 'win32', kill: () => {}, spawnAdapter: unused }), false);
  assert.equal(await isProcessProvenDead(targetPid, { platform: 'win32', kill: () => { throw Object.assign(Error(), { code: 'ESRCH' }); }, spawnAdapter: unused }), true);
});

test('Windows EPERM recovers only exact affirmative Get-Process evidence through a fixed hidden stdin-only probe', async () => {
  for (const proof of ['not-found', 'has-exited']) {
    const f = adapter({ value: { pid: targetPid, status: 'dead', proof } });
    assert.equal(await isProcessProvenDead(targetPid, { platform: 'win32', kill: denied, spawnAdapter: f.spawn }), true);
    assert.equal(f.input, String(targetPid) + '\n'); assert.equal(f.launches, 1); assert.equal(f.options.windowsHide, true); assert.deepEqual(f.options.stdio, ['pipe', 'pipe', 'pipe']); assert.equal(f.options.env, undefined);
    assert(f.args.includes('-NonInteractive')); assert(f.args.includes('Hidden')); assert(!JSON.stringify(f.args).includes(String(targetPid))); const script = f.args.at(-1); assert(script.includes('Get-Process -Id $RequestedProcessId')); assert(script.includes('NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand')); assert(!/Stop-Process|Remove-Item|Start-Process/u.test(script));
  }
});

test('alive, access-denied, malformed, wrong-PID, oversized and failed probes preserve queue ownership', async () => {
  for (const config of [
    { value: { pid: targetPid, status: 'alive', proof: 'present' } },
    { value: { pid: targetPid, status: 'unknown', proof: 'unavailable' } },
    { value: { pid: targetPid, status: 'dead', proof: 'access-denied' } },
    { value: { pid: targetPid + 1, status: 'dead', proof: 'not-found' } },
    { value: { pid: targetPid, status: 'dead', proof: 'not-found', extra: true } },
    { stdout: 'NoProcessFoundForGivenId' },
    { stdout: 'x'.repeat(2049) },
    { value: { pid: targetPid, status: 'dead', proof: 'not-found' }, stderr: 'Unknown access error.' },
    { value: { pid: targetPid, status: 'dead', proof: 'not-found' }, code: 1 },
  ]) {
    const f = adapter(config); assert.equal(await isProcessProvenDead(targetPid, { platform: 'win32', kill: denied, spawnAdapter: f.spawn }), false);
  }
});

test('an unavailable or timed-out helper returns unknown and stops only its own helper child', async () => {
  assert.equal(await isProcessProvenDead(targetPid, { platform: 'win32', kill: denied, spawnAdapter: () => { throw Error('No helper.'); } }), false);
  const f = adapter({ never: true }); assert.equal(await isProcessProvenDead(targetPid, { platform: 'win32', kill: denied, spawnAdapter: f.spawn, timeoutMs: 20 }), false); assert.equal(f.kills, 1);
  const deniedHelper = adapter({ never: true }), unknown = isProcessProvenDead(targetPid, { platform: 'win32', kill: denied, spawnAdapter: deniedHelper.spawn, timeoutMs: 20 }); deniedHelper.child.kill = () => { throw Object.assign(Error('Synthetic helper EPERM.'), { code: 'EPERM' }); }; assert.equal(await unknown, false);
});

test('the real Windows fallback proves an exited child absent and preserves a live child despite Node EPERM', { skip: process.platform !== 'win32' }, async t => {
  const exited = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }); assert.equal(exited.status, 0);
  assert.equal(await isProcessProvenDead(exited.pid, { platform: 'win32', kill: denied, timeoutMs: 5000 }), true);
  const alive = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' }); t.after(() => alive.kill());
  assert.equal(await isProcessProvenDead(alive.pid, { platform: 'win32', kill: denied, timeoutMs: 5000 }), false);
});
