import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const helper = path.join(root, 'scripts/window-placement.ps1');
function place(area) {
  const result = spawnSync(process.env.PAPER_EDITOR_POWERSHELL || 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; . $env:PAPER_WINDOW_HELPER; $a=ConvertFrom-Json $env:PAPER_WINDOW_AREA -AsHashtable; Get-PaperWindowPlacement @a | ConvertTo-Json -Compress"], { cwd: root, env: { ...process.env, PAPER_WINDOW_HELPER: helper, PAPER_WINDOW_AREA: JSON.stringify(area) }, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function within(p, area, scale = 1) {
  assert.ok(p.width > 0 && p.height > 0);
  assert.ok(p.x >= (area.WorkLeft || 0) / scale && p.y >= (area.WorkTop || 0) / scale);
  assert.ok(p.x + p.width <= ((area.WorkLeft || 0) + area.WorkWidth) / scale);
  assert.ok(p.y + p.height <= ((area.WorkTop || 0) + area.WorkHeight) / scale);
}
test('large desktops request a centered normal1440x900 resizable workbench', () => {
  const area = { WorkWidth: 1920, WorkHeight: 1200 }, p = place(area);
  assert.equal(p.width, 1440); assert.equal(p.height, 900); assert.equal(p.x, 240); assert.equal(p.y, 150); assert.equal(p.requestedState, 'normal'); within(p, area);
});
test('laptop height caps preserve a useful reading width without exceeding the working area', () => {
  for (const area of [{ WorkWidth: 1920, WorkHeight: 1040 }, { WorkWidth: 1366, WorkHeight: 728 }, { WorkWidth: 1280, WorkHeight: 680 }]) {
    const p = place(area); within(p, area); assert.ok(p.width >= 1032); assert.ok(p.height < area.WorkHeight); assert.ok(p.width > p.height);
  }
});
test('physical pixels and DPI produce the same logical placement without changing system scaling', () => {
  const logical = place({ WorkWidth: 1920, WorkHeight: 1040 });
  for (const DpiScale of [1.25, 1.5, 2]) {
    const area = { WorkWidth: 1920 * DpiScale, WorkHeight: 1040 * DpiScale, DpiScale }, p = place(area);
    assert.deepEqual(p, logical); within(p, area, DpiScale);
  }
});
test('small and negative-origin work areas stay on screen rather than forcing desktop minimums', () => {
  for (const area of [{ WorkWidth: 900, WorkHeight: 700 }, { WorkWidth: 320, WorkHeight: 240 }, { WorkWidth: 1920, WorkHeight: 1200, WorkLeft: -1920, WorkTop: -120 }]) within(place(area), area);
  assert.ok(place({ WorkWidth: 900, WorkHeight: 700 }).width < 1000);
});
test('launcher requests a new normal window with placement and preserves the existing browser profile', async () => {
  const launcher = await readFile(path.join(root, 'scripts/launch-workbench.ps1'), 'utf8');
  const opener = await readFile(path.join(root, 'scripts/open-window.ps1'), 'utf8');
  assert.match(launcher, /dist\/background-workbench\.mjs/); assert.match(launcher, /--open-workbench/);
  const background = await readFile(path.join(root, 'src/background-workbench.mjs'), 'utf8');
  assert.match(background, /openNormalEdgeWindow/);
  assert.ok(!opener.includes('--start-maximized'));
  assert.match(opener, /--new-window/); assert.match(opener, /--window-size=/); assert.match(opener, /--window-position=/); assert.match(opener, /-WindowStyle Normal/);
  assert.match(opener, /standalone-browser/);
  assert.ok(!/SetWindowPos|ShowWindow|Remove-Item|force-device-scale-factor/.test(launcher + opener));
});
