[CmdletBinding()]
param(
    [string]$FontRoot,
    [string]$TexBin,
    [string]$Node,
    [switch]$RegisterUserFonts,
    [switch]$Offline
)
$ErrorActionPreference = 'Stop'
if (-not $FontRoot) { $FontRoot = Join-Path $env:LOCALAPPDATA 'BilingualPaperEditor/fonts' }
if (-not $TexBin) { $TexBin = Split-Path -Parent (Get-Command xelatex -ErrorAction Stop).Source }
if (-not $Node) { $Node = (Get-Command node -ErrorAction Stop).Source }
$FontRoot = [IO.Path]::GetFullPath($FontRoot)
$Bundle = Join-Path $FontRoot 'bundle'
$Downloads = Join-Path $FontRoot 'downloads'
$Licenses = Join-Path $FontRoot 'licenses'
$Cache = Join-Path $FontRoot 'cache'
$LatinBundle = Join-Path $Bundle 'latin-modern'
foreach ($Directory in @($Bundle, $Downloads, $Licenses, $Cache, $LatinBundle)) { New-Item -ItemType Directory -Path $Directory -Force | Out-Null }
$Sources = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'fonts-sources.json') -Raw | ConvertFrom-Json

function Assert-Hash([string]$File, [string]$Expected) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $File).Hash.ToLowerInvariant() -ne $Expected.ToLowerInvariant()) { throw "Pinned font hash mismatch: $([IO.Path]::GetFileName($File)). Existing bytes were preserved." }
}
function Ensure-PinnedDownload([string]$Url, [string]$Destination, [string]$Expected) {
    if (Test-Path -LiteralPath $Destination) { Assert-Hash $Destination $Expected; return }
    if ($Offline) { throw "Font artifact is unavailable offline: $([IO.Path]::GetFileName($Destination))" }
    $Uri = [Uri]$Url
    if ($Uri.Scheme -ne 'https' -or $Uri.Host -notin @('raw.githubusercontent.com','deb.debian.org')) { throw 'Unexpected font download origin.' }
    $Temporary = $Destination + '.' + [guid]::NewGuid() + '.part'
    Invoke-WebRequest -Uri $Uri -OutFile $Temporary -TimeoutSec 180 -MaximumRedirection 3
    Assert-Hash $Temporary $Expected
    Move-Item -LiteralPath $Temporary -Destination $Destination
}
$Installed = @()
foreach ($Font in $Sources.fonts) {
    if ($Font.filename -notmatch '^[A-Za-z0-9._-]+$') { throw 'Unexpected font filename.' }
    $DownloadName = if ($Font.downloadFilename) { $Font.downloadFilename } else { $Font.filename }
    if ($DownloadName -notmatch '^[A-Za-z0-9._-]+$') { throw 'Unexpected download filename.' }
    $DownloadHash = if ($Font.downloadSha256) { $Font.downloadSha256 } else { $Font.sha256 }
    $Download = Join-Path $Downloads $DownloadName
    Ensure-PinnedDownload $Font.url $Download $DownloadHash
    $Target = Join-Path $Bundle $Font.filename
    if ($Font.archivePath) {
        $Extracted = Join-Path $Downloads 'extracted'
        New-Item -ItemType Directory -Path $Extracted -Force | Out-Null
        & tar -xf $Download -C $Downloads data.tar.xz
        if ($LASTEXITCODE -ne 0) { throw 'Could not extract the pinned Debian data archive.' }
        & tar -xf (Join-Path $Downloads 'data.tar.xz') -C $Extracted $Font.archivePath $Font.licenseArchivePath
        if ($LASTEXITCODE -ne 0) { throw 'Could not extract the exact font and copyright members.' }
        $ExtractedFont = Join-Path $Extracted ($Font.archivePath -replace '^\./','')
        Assert-Hash $ExtractedFont $Font.sha256
        if (Test-Path -LiteralPath $Target) { Assert-Hash $Target $Font.sha256 } else { Copy-Item -LiteralPath $ExtractedFont -Destination $Target }
        Copy-Item -LiteralPath (Join-Path $Extracted ($Font.licenseArchivePath -replace '^\./','')) -Destination (Join-Path $Licenses 'ARPHIC-PUBLIC-LICENSE.txt') -Force
    } else {
        if (Test-Path -LiteralPath $Target) { Assert-Hash $Target $Font.sha256 } else { Copy-Item -LiteralPath $Download -Destination $Target }
        $LicenseName = if ($Font.version.StartsWith('Serif')) { 'Noto-Serif-OFL.txt' } else { 'Noto-Sans-OFL.txt' }
        $LicenseTarget = Join-Path $Licenses $LicenseName
        if (-not (Test-Path -LiteralPath $LicenseTarget)) {
            if ($Offline) { throw "Missing font license offline: $LicenseName" }
            Invoke-WebRequest -Uri $Font.licenseUrl -OutFile $LicenseTarget -TimeoutSec 60
        }
        if (-not (Select-String -LiteralPath $LicenseTarget -SimpleMatch 'SIL OPEN FONT LICENSE' -Quiet)) { throw 'Unexpected Noto license content.' }
    }
    $Installed += @{ filename = $Font.filename; family = $Font.family; style = $Font.style; sha256 = $Font.sha256; size = (Get-Item -LiteralPath $Target).Length; source = $Font.url; license = $Font.license }
}
$LatinNames = @('lmroman10-regular.otf','lmroman10-bold.otf','lmroman10-italic.otf','lmroman10-bolditalic.otf')
$LatinInstalled = @()
foreach ($LatinName in $LatinNames) {
    $Located = (& (Join-Path $TexBin 'kpsewhich.exe') $LatinName | Select-Object -First 1)
    if (-not $Located -or -not (Test-Path -LiteralPath $Located -PathType Leaf)) { throw "Required Latin Modern font missing: $LatinName" }
    $LatinTarget = Join-Path $LatinBundle $LatinName
    $LatinHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Located).Hash.ToLowerInvariant()
    if (Test-Path -LiteralPath $LatinTarget) { Assert-Hash $LatinTarget $LatinHash } else { Copy-Item -LiteralPath $Located -Destination $LatinTarget }
    $LatinInstalled += @{ filename = $LatinName; sha256 = $LatinHash; size = (Get-Item -LiteralPath $LatinTarget).Length; source = 'existing-texlive-installation'; license = 'GUST Font License' }
}
$Configuration = Join-Path $FontRoot 'fonts.conf'
& $Node (Join-Path $PSScriptRoot 'fonts-config.mjs') $Configuration $Bundle $LatinBundle $Cache | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not build the explicit font configuration.' }
$PreviousConfig = $env:FONTCONFIG_FILE
$PreviousPath = $env:FONTCONFIG_PATH
try {
    $env:FONTCONFIG_FILE = $Configuration
    $env:FONTCONFIG_PATH = $FontRoot
    $FontLookupResults = @()
    foreach ($Family in @('Noto Serif CJK SC','Noto Serif CJK SC:style=Bold','Noto Sans CJK SC','AR PL UKai CN')) {
        $Match = & (Join-Path $TexBin 'fc-match.exe') '--format=%{family}|%{style}|%{file}' $Family
        if ($LASTEXITCODE -ne 0 -or $Match -notmatch '^Noto Serif CJK SC\|Bold\|' -and $Family -like '*style=Bold*') { throw "Bold font lookup failed: $Family" }
        if ($Family -notlike '*style=Bold*' -and -not $Match.StartsWith($Family + '|')) { throw "Exact font family lookup failed: $Family" }
        $FontLookupResults += @{ requested = $Family; resolved = $Match }
    }
} finally { $env:FONTCONFIG_FILE = $PreviousConfig; $env:FONTCONFIG_PATH = $PreviousPath }
$Registered = $false
if ($RegisterUserFonts) {
    $UserFonts = Join-Path $env:LOCALAPPDATA 'Microsoft/Windows/Fonts'
    New-Item -ItemType Directory -Path $UserFonts -Force | Out-Null
    $RegistryFonts = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Fonts'
    New-Item -Path $RegistryFonts -Force | Out-Null
    if (-not ('PaperEditorFontRegistration' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PaperEditorFontRegistration {
  [DllImport("gdi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int AddFontResourceEx(string path, uint flags, IntPtr reserved);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool SendNotifyMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
}
'@
    }
    foreach ($Font in $Sources.fonts) {
        $UserTarget = Join-Path $UserFonts $Font.filename
        if (Test-Path -LiteralPath $UserTarget) { Assert-Hash $UserTarget $Font.sha256 } else { Copy-Item -LiteralPath (Join-Path $Bundle $Font.filename) -Destination $UserTarget }
        $RegistryName = if ($Font.style -eq 'Bold') { $Font.family + ' Bold (OpenType)' } elseif ($Font.filename.EndsWith('.ttc')) { $Font.family + ' (TrueType)' } else { $Font.family + ' (OpenType)' }
        $Existing = (Get-ItemProperty -LiteralPath $RegistryFonts -Name $RegistryName -ErrorAction SilentlyContinue).$RegistryName
        if ($Existing -and [IO.Path]::GetFullPath($Existing) -ne [IO.Path]::GetFullPath($UserTarget)) { throw 'A different existing user font registration was preserved.' }
        New-ItemProperty -LiteralPath $RegistryFonts -Name $RegistryName -Value $UserTarget -PropertyType String -Force | Out-Null
        if ([PaperEditorFontRegistration]::AddFontResourceEx($UserTarget, 0, [IntPtr]::Zero) -le 0) { throw "Windows could not load the user font: $($Font.filename)" }
    }
    [PaperEditorFontRegistration]::SendNotifyMessage([IntPtr]0xffff, 0x001d, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    $Registered = $true
}
$Receipt = @{ schemaVersion = 1; installedAt = [DateTime]::UtcNow.ToString('o'); fontRoot = $FontRoot; bundleDir = $Bundle; latinDir = $LatinBundle; fontconfigFile = $Configuration; userRegistered = $Registered; fonts = $Installed; latinFonts = $LatinInstalled; verifiedMatches = $FontLookupResults }
$Receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $FontRoot 'setup-receipt.json') -Encoding utf8NoBOM
@{ ok = $true; fontCount = $Installed.Count; latinFontCount = $LatinInstalled.Count; userRegistered = $Registered; fontRoot = $FontRoot; fontconfigFile = $Configuration } | ConvertTo-Json -Compress
