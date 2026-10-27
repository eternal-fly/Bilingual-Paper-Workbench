import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const ps = value => "'" + value.replaceAll("'", "''") + "'";
async function run(t, body) {
  const parent = path.join(root, 'work/shortcut-tests'); await mkdir(parent, { recursive: true }); const dir = await mkdtemp(path.join(parent, 'case-'));
  t.after(async () => { assert.ok(path.resolve(dir).startsWith(path.resolve(parent) + path.sep)); await rm(dir, { recursive: true, force: true }); });
  const script = path.join(dir, 'run.ps1');
  await writeFile(script, `$ErrorActionPreference='Stop'\n. ${ps(path.join(root, 'scripts/shortcut-migration.ps1'))}\n$CaseRoot=${ps(dir)}\n${body}`);
  const { stdout, stderr } = await promisify(execFile)('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], { windowsHide: true }); assert.equal(stderr, ''); return JSON.parse(stdout);
}
const setup = `
$Desktop=Join-Path $CaseRoot 'Desktop';$InstallRoot=Join-Path $CaseRoot 'plugin';$BackupRoot=Join-Path $CaseRoot 'private/shortcut-backups';$PowerShell=Join-Path $CaseRoot 'pwsh.exe'
New-Item -ItemType Directory -Path $Desktop,$InstallRoot -Force|Out-Null
$English=Join-Path $Desktop 'Bilingual Paper Workbench.lnk';$Legacy=Join-Path $Desktop '双语论文工作台.lnk'
$Metadata=@{TargetPath=$PowerShell;Arguments=('-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $InstallRoot 'scripts/launch-workbench.ps1')+'"');WorkingDirectory=$InstallRoot}
$Read={param($ShortcutPath) $Metadata}
`;

test('owned legacy shortcut is reversibly renamed and migration dry-run never changes files', async t => {
  const result = await run(t, setup + `
Set-Content -LiteralPath $Legacy -Value 'owned-shortcut-original'
$Plan=Get-PaperShortcutMigrationPlan -ShortcutPaths @($English) -InstalledRoots @($InstallRoot) -PowerShell $PowerShell -BackupRoot $BackupRoot -ReadShortcut $Read
$Before=@{legacyExists=(Test-Path -LiteralPath $Legacy);englishExists=(Test-Path -LiteralPath $English)}
Invoke-PaperShortcutMigration -Plan $Plan|Out-Null
@{before=$Before;legacyExists=(Test-Path -LiteralPath $Legacy);englishText=(Get-Content -LiteralPath $English -Raw).Trim();operation=$Plan.operations[0].operation}|ConvertTo-Json -Depth 8 -Compress`);
  assert.deepEqual(result.before, { legacyExists: true, englishExists: false }); assert.equal(result.legacyExists, false); assert.equal(result.englishText, 'owned-shortcut-original'); assert.equal(result.operation, 'rename');
});

test('duplicate owned legacy shortcut is moved to a retained backup and foreign shortcuts are preserved', async t => {
  const result = await run(t, setup + `
Set-Content -LiteralPath $Legacy -Value 'legacy-original';Set-Content -LiteralPath $English -Value 'english-owned'
$Foreign=Join-Path $Desktop '双语论文修订.lnk';Set-Content -LiteralPath $Foreign -Value 'foreign-original'
$Read={param($ShortcutPath) if($ShortcutPath -eq $Foreign){return @{TargetPath=$PowerShell;Arguments='-File "C:/unrelated.ps1"';WorkingDirectory=$InstallRoot}};return $Metadata}
$Plan=Get-PaperShortcutMigrationPlan -ShortcutPaths @($English) -InstalledRoots @($InstallRoot) -PowerShell $PowerShell -BackupRoot $BackupRoot -ReadShortcut $Read
Invoke-PaperShortcutMigration -Plan $Plan|Out-Null
@{operation=$Plan.operations[0].operation;backupText=(Get-Content -LiteralPath $Plan.operations[0].newPath -Raw).Trim();englishText=(Get-Content -LiteralPath $English -Raw).Trim();foreignText=(Get-Content -LiteralPath $Foreign -Raw).Trim();legacyExists=(Test-Path -LiteralPath $Legacy)}|ConvertTo-Json -Compress`);
  assert.equal(result.operation, 'backup'); assert.equal(result.backupText, 'legacy-original'); assert.equal(result.englishText, 'english-owned'); assert.equal(result.foreignText, 'foreign-original'); assert.equal(result.legacyExists, false);
});

test('foreign English target aborts before any mutation and changed shortcut revision cannot be migrated', async t => {
  const result = await run(t, setup + `
Set-Content -LiteralPath $Legacy -Value 'original';Set-Content -LiteralPath $English -Value 'foreign'
$Read={param($ShortcutPath) if($ShortcutPath -eq $English){return @{TargetPath='C:/other.exe';Arguments=$Metadata.Arguments;WorkingDirectory=$InstallRoot}};return $Metadata}
$ForeignRejected=$false;try{$null=Get-PaperShortcutMigrationPlan -ShortcutPaths @($English) -InstalledRoots @($InstallRoot) -PowerShell $PowerShell -BackupRoot $BackupRoot -ReadShortcut $Read}catch{$ForeignRejected=$true}
Remove-Item -LiteralPath $English
$Read={param($ShortcutPath) $Metadata}
$Plan=Get-PaperShortcutMigrationPlan -ShortcutPaths @($English) -InstalledRoots @($InstallRoot) -PowerShell $PowerShell -BackupRoot $BackupRoot -ReadShortcut $Read
Set-Content -LiteralPath $Legacy -Value 'changed-after-plan'
$RevisionRejected=$false;try{Invoke-PaperShortcutMigration -Plan $Plan|Out-Null}catch{$RevisionRejected=$true}
@{foreignRejected=$ForeignRejected;revisionRejected=$RevisionRejected;legacyText=(Get-Content -LiteralPath $Legacy -Raw).Trim();englishExists=(Test-Path -LiteralPath $English)}|ConvertTo-Json -Compress`);
  assert.equal(result.foreignRejected, true); assert.equal(result.revisionRejected, true); assert.equal(result.legacyText, 'changed-after-plan'); assert.equal(result.englishExists, false);
});

test('public manifest uses the English product name without changing persistent plugin identity', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'plugin.json'), 'utf8')), face = manifest.extensions['com.openai'].interface;
  assert.equal(manifest.name, 'bilingual-paper-editor'); assert.equal(face.displayName, 'Bilingual Paper Workbench'); assert.ok(!/[\u3400-\u9fff]/u.test([manifest.description, face.shortDescription, face.longDescription].join(' ')));
});

test('only the owned single-plugin catalog is renamed while its other interface metadata is retained', async t => {
  const result = await run(t, `
. ${ps(path.join(root, 'scripts/desktop-discovery.ps1'))}
$Fresh=Get-PaperDesktopDiscoveryPlan -UserHome $CaseRoot
New-Item -ItemType Directory -Path (Split-Path -Parent $Fresh.catalogPath) -Force|Out-Null
$Fresh.catalog.interface.displayName='Paper Editor Local';$Fresh.catalog.interface.custom='keep-exactly'
$Fresh.catalog|ConvertTo-Json -Depth 20|Set-Content -LiteralPath $Fresh.catalogPath
$Upgrade=Get-PaperDesktopDiscoveryPlan -UserHome $CaseRoot
@{name=$Upgrade.catalog.interface.displayName;custom=$Upgrade.catalog.interface.custom;slug=$Upgrade.catalog.plugins[0].name}|ConvertTo-Json -Compress`);
  assert.equal(result.name, 'Bilingual Paper Workbench'); assert.equal(result.custom, 'keep-exactly'); assert.equal(result.slug, 'bilingual-paper-editor');
});
