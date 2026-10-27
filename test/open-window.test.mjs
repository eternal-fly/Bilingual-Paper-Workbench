import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const helper = path.join(root, 'scripts/open-window.ps1');
const token = 'a'.repeat(43), url = `http://127.0.0.1:45678/#session=${token}`;
function run(script, env = {}) {
  return spawnSync(process.env.PAPER_EDITOR_POWERSHELL || 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { cwd: root, env: { ...process.env, PAPER_WINDOW_OPENER: helper, ...env }, encoding: 'utf8', windowsHide: true, timeout: 10000 });
}

test('shared window opener preserves capability privately and starts only one ordinary browser window', async t => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'paper-window-')); t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const browser = path.join(dataRoot, 'dummy-browser.exe'); await writeFile(browser, 'synthetic');
  // Registry ownership is exercised separately with synthetic windows and real
  // Edge. This unit checks the launch contract without creating a native HWND.
  const result = run("$ErrorActionPreference='Stop'; . $env:PAPER_WINDOW_OPENER; function Get-PaperScreenWorkArea { @{ WorkWidth=1920; WorkHeight=1200 } }; function Invoke-PaperWindowRegistry { param($Url,$DataRoot,$Browser,$Profile,$Launch) & $Launch; return $false }; $script:calls=@(); function Start-Process { param($FilePath,$WindowStyle,$ArgumentList) $script:calls+=@{file=$FilePath;style=$WindowStyle;args=$ArgumentList} }; $p=Open-PaperWindow -Url $env:PAPER_WINDOW_URL -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER; @{placement=$p;calls=$script:calls} | ConvertTo-Json -Compress -Depth 5", { PAPER_WINDOW_URL: url, PAPER_WINDOW_DATA: dataRoot, PAPER_WINDOW_BROWSER: browser });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout); assert.equal(value.calls.length, 1);
  assert.equal(value.calls[0].style, 'Normal'); assert.equal(value.calls[0].file, browser);
  assert.ok(value.calls[0].args.includes('--new-window')); assert.ok(value.calls[0].args.includes('--window-size=1440,900'));
  assert.ok(value.calls[0].args.includes(`--app="${url}"`));
  assert.ok(value.calls[0].args.includes(`--user-data-dir="${path.join(dataRoot, 'standalone-browser')}"`));
  assert.deepEqual(value.placement, { width: 1440, height: 900, x: 240, y: 150, requestedState: 'normal', reusedWindow: false });
});

test('window opener rejects nonlocal or malformed capability URLs before starting a browser', () => {
  for (const candidate of ['https://example.com/#session=' + token, 'http://127.0.0.1:45678/else#session=' + token, 'http://127.0.0.1:45678/#session=short']) {
    const result = run("$ErrorActionPreference='Stop'; . $env:PAPER_WINDOW_OPENER; function Start-Process { throw 'BROWSER_MUST_NOT_RUN' }; try { Open-PaperWindow -Url $env:PAPER_WINDOW_URL -DataRoot $env:TEMP -Browser 'unused' | Out-Null; exit 2 } catch { $_.Exception.Message; exit 1 }", { PAPER_WINDOW_URL: candidate });
    assert.equal(result.status, 1); assert.match(result.stdout, /PAPER_WINDOW_URL_INVALID/); assert.ok(!result.stdout.includes(token)); assert.ok(!result.stdout.includes('BROWSER_MUST_NOT_RUN'));
  }
});

test('browser launch failures never expose the capability in diagnostics', async t => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'paper-window-')); t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const browser = path.join(dataRoot, 'dummy-browser.exe'); await writeFile(browser, 'synthetic');
  const result = run("$ErrorActionPreference='Stop'; . $env:PAPER_WINDOW_OPENER; function Start-Process { throw $env:PAPER_WINDOW_URL }; try { Open-PaperWindow -Url $env:PAPER_WINDOW_URL -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER | Out-Null; exit 2 } catch { $_.Exception.Message; exit 1 }", { PAPER_WINDOW_URL: url, PAPER_WINDOW_DATA: dataRoot, PAPER_WINDOW_BROWSER: browser });
  assert.equal(result.status, 1); assert.match(result.stdout, /PAPER_WINDOW_OPEN_FAILED/); assert.ok(!result.stdout.includes(token)); assert.ok(!result.stderr.includes(token));
});

test('native stdin entrypoint reports a safe error without repeating the URL or opening a browser', () => {
  const input = `https://example.com/#session=${token}\n`;
  const result = spawnSync(process.env.PAPER_EDITOR_POWERSHELL || 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper, '-ReadUrlFromStdin', '-DataRoot', root], { cwd: root, input, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /PAPER_WINDOW_URL_INVALID/);
  assert.ok(!result.stderr.includes(token)); assert.ok(!result.stdout.includes(token)); assert.ok(!result.stderr.includes('example.com'));
});

test('dot sourcing the shared helper preserves the shortcut browser override', () => {
  const result = run("$ErrorActionPreference='Stop'; $Browser='synthetic-author-choice'; . $env:PAPER_WINDOW_OPENER; $Browser");
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'synthetic-author-choice');
});
