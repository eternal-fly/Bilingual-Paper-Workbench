[CmdletBinding()]
param(
    [string]$TargetFile,
    [string]$Destination,
    [string]$Node,
    [string]$Codex,
    [string]$PrivateRoot,
    [string]$DesktopHome,
    [string]$PreferredModel = 'gpt-6-astra',
    [string]$PreferredEffort = 'medium',
    [ValidateSet('xelatex','pdflatex')][string]$Engine,
    [switch]$NoShortcuts,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$PluginSource = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'desktop-discovery.ps1')
. (Join-Path $PSScriptRoot 'shortcut-migration.ps1')
if (-not $DesktopHome) { $DesktopHome = $env:USERPROFILE }
$DesktopDiscovery = Get-PaperDesktopDiscoveryPlan -UserHome $DesktopHome
if (-not $Node) { $Node = (Get-Command node.exe -ErrorAction Stop).Source }
if (-not $Codex) { $Codex = (Get-Command codex.exe -ErrorAction Stop).Source }
$Node = (Resolve-Path -LiteralPath $Node).Path
$Codex = (Resolve-Path -LiteralPath $Codex).Path
$PowerShell = (Get-Process -Id $PID).Path
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Run the installer in PowerShell 7 or newer.' }
if (-not $PrivateRoot) { $PrivateRoot = Join-Path $env:LOCALAPPDATA 'BilingualPaperEditor' }
$PrivateRoot = [IO.Path]::GetFullPath($PrivateRoot)
if (Test-Path -LiteralPath $PrivateRoot -PathType Container) {
    # Persist the physical MSIX cache path, so an Explorer launch sees the same drafts/runtime.
    $PhysicalRoot = & $Node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' -- $PrivateRoot
    if ($LASTEXITCODE -ne 0 -or -not $PhysicalRoot) { throw 'Could not resolve the existing private data directory.' }
    $PrivateRoot = [IO.Path]::GetFullPath([string]$PhysicalRoot)
}
if (-not $Destination) {
    $CodexConfigRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $Destination = Join-Path $CodexConfigRoot 'plugins/local/paper-editor-local'
}
$Destination = [IO.Path]::GetFullPath($Destination)
$InstalledRoot = Join-Path $Destination 'plugins/bilingual-paper-editor'
$DataRoot = Join-Path $PrivateRoot 'preview'
$Required = @(
    'plugin.json', 'package.json', 'pnpm-lock.yaml', 'README.md', 'LICENSE', 'NOTICE', 'SECURITY.md', 'CONTRIBUTING.md',
    'dist/server.mjs', 'dist/local-web.mjs', 'dist/background-workbench.mjs', 'dist/assistant-review-worker.mjs', 'dist/desktop-callback.mjs', 'dist/windows-writer.ps1',
    'dist/workbench.html', 'dist/preview.html','dist/native-relay.html', 'dist/build-manifest.json', 'dist/THIRD_PARTY_NOTICES.md',
    'dist/assets/paper-editor.svg', 'dist/assets/paper-editor.ico', 'dist/assets/icon-manifest.json',
    'dist/assets/paper-editor-16.png', 'dist/assets/paper-editor-24.png', 'dist/assets/paper-editor-32.png',
    'dist/assets/paper-editor-48.png', 'dist/assets/paper-editor-64.png', 'dist/assets/paper-editor-128.png', 'dist/assets/paper-editor-256.png',
    'fixtures/sample-paper/main.tex', 'fixtures/sample-paper/main.pdf',
    'scripts/launch-preview.ps1', 'scripts/launch-workbench.ps1', 'scripts/open-window.ps1', 'scripts/reassign-window.ps1', 'scripts/window-placement.ps1', 'scripts/window-registry.ps1', 'scripts/desktop-discovery.ps1', 'scripts/shortcut-migration.ps1', 'scripts/native-app-control.mjs', 'scripts/configure-native-mcp.mjs',
    'scripts/fonts-config.mjs', 'scripts/fonts-sources.json', 'scripts/fonts-install.ps1', 'scripts/fonts-smoke.ps1',
    'scripts/compiler-build.ps1', 'scripts/compiler-prepare.ps1', 'scripts/compiler-install64.ps1',
    'src/compiler/AppContainerBroker.cs', 'src/compiler/AppContainerProbe.cs',
    'docs/USER_GUIDE.md', 'docs/core-boundaries.md', 'docs/compiler-security.md', 'docs/codex-integration.md', 'docs/fonts-support.md', 'docs/verification.md', 'docs/OPEN_SOURCE.md'
)
foreach ($Relative in $Required) {
    if (-not (Test-Path -LiteralPath (Join-Path $PluginSource $Relative) -PathType Leaf)) { throw "Missing build file: $Relative" }
}
# Verify every bundled build byte before replacing an installed file.
$Manifest = Get-Content -LiteralPath (Join-Path $PluginSource 'dist/build-manifest.json') -Raw | ConvertFrom-Json -AsHashtable
foreach ($Entry in $Manifest.files.GetEnumerator()) {
    if ($Entry.Key -match '(^|[/\\])\.\.([/\\]|$)' -or [IO.Path]::IsPathRooted($Entry.Key)) { throw 'Invalid build manifest path.' }
    $BuiltFile = Join-Path $PluginSource ('dist/' + $Entry.Key)
    if ((Get-FileHash -LiteralPath $BuiltFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Entry.Value.sha256) { throw "Build checksum mismatch: $($Entry.Key)" }
}
$Version = (Get-Content -LiteralPath (Join-Path $PluginSource 'plugin.json') -Raw | ConvertFrom-Json).version
$RuntimeEnvironment = @{
    PAPER_EDITOR_FULL_RUNTIME = '1'
    PAPER_EDITOR_INSTALL_VERSION = $Version
    PAPER_EDITOR_DATA_ROOT = $DataRoot
    PAPER_EDITOR_CODEX_ROOT = (Join-Path $PrivateRoot 'codex')
    PAPER_EDITOR_COMPILER_ROOT = (Join-Path $PrivateRoot 'compiler/runtime64')
    PAPER_EDITOR_CODEX_COMMAND = $Codex
    PAPER_EDITOR_POWERSHELL = $PowerShell
    PAPER_EDITOR_PREFERRED_MODEL = $PreferredModel
    PAPER_EDITOR_PREFERRED_EFFORT = $PreferredEffort
}
if ($Engine) { $RuntimeEnvironment.PAPER_EDITOR_ENGINE = $Engine }
if ($TargetFile) {
    $ResolvedFile = (Resolve-Path -LiteralPath $TargetFile).Path
    if ([IO.Path]::GetExtension($ResolvedFile) -ine '.tex') { throw 'Select an existing .tex main file.' }
    $RuntimeEnvironment.PAPER_EDITOR_WORKSPACE = Split-Path -Parent $ResolvedFile
    $RuntimeEnvironment.PAPER_EDITOR_MAIN_FILE = Split-Path -Leaf $ResolvedFile
} elseif (Test-Path -LiteralPath (Join-Path $InstalledRoot 'mcp.json')) {
    # Preserve an existing exact binding when upgrading without another file argument.
    $Previous = (Get-Content -LiteralPath (Join-Path $InstalledRoot 'mcp.json') -Raw | ConvertFrom-Json).mcpServers.'bilingual-paper-editor'.env
    foreach ($Name in @('PAPER_EDITOR_WORKSPACE','PAPER_EDITOR_MAIN_FILE')) { if ($Previous.$Name) { $RuntimeEnvironment[$Name] = [string]$Previous.$Name } }
}
$ShortcutPaths = if ($NoShortcuts) { @() } else { @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Bilingual Paper Workbench.lnk'),
    (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs/Bilingual Paper Workbench.lnk')
) }
$ShortcutMigration = if ($NoShortcuts) { @{ operations = @() } } else { Get-PaperShortcutMigrationPlan -ShortcutPaths $ShortcutPaths -InstalledRoots @($InstalledRoot,$DesktopDiscovery.pluginRoot) -PowerShell $PowerShell -BackupRoot (Join-Path $PrivateRoot 'shortcut-backups') }
$Plan = [ordered]@{ productName = 'Bilingual Paper Workbench'; version = $Version; installationRoot = $InstalledRoot; marketplaceRoot = $Destination; privateDataRoot = $DataRoot; targetSpecified = [bool]$RuntimeEnvironment.PAPER_EDITOR_MAIN_FILE; files = $Required; shortcuts = @($ShortcutPaths); shortcutMigration = @($ShortcutMigration.operations); fullRuntime = $true; compilerRuntime = $RuntimeEnvironment.PAPER_EDITOR_COMPILER_ROOT; preferredModel = $PreferredModel; preferredEffort = $PreferredEffort; publication = $false; sourceWriteback = 'human-confirmed-exact-isolated-candidate-only'; desktopProcessRequired = $false; desktopDiscovery = @{ pluginRoot = $DesktopDiscovery.pluginRoot; catalogPath = $DesktopDiscovery.catalogPath; sourcePath = $DesktopDiscovery.sourcePath; catalogName = $DesktopDiscovery.catalogName; pluginId = $DesktopDiscovery.pluginId; preservedExistingCatalog = [bool]$DesktopDiscovery.catalogBeforeHash; appRestartRequired = $true } }
# The viewer can open on its own; translation and feedback run in Desktop.
$Plan['desktopInferenceProcessRequired'] = $true
$Plan['inferenceMode'] = 'desktop-existing-chat-queue'
$Plan['nativeMcpRegistration'] = @{ serverName = 'bilingual-paper-editor'; scope = 'user'; protocol = 'config/batchWrite'; startupTimeoutSeconds = 120; toolTimeoutSeconds = 600; otherSettings = 'preserved'; desktopReloadRequired = $true }
if ($DryRun) { $Plan | ConvertTo-Json -Depth 6; exit 0 }
New-Item -ItemType Directory -Path $InstalledRoot -Force | Out-Null
foreach ($Relative in $Required) {
    $Target = Join-Path $InstalledRoot $Relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $Target) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PluginSource $Relative) -Destination $Target -Force
}
# These generated exact paths and paper binding are private installation state.
$McpConfig = @{ '$schema' = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'; mcpServers = @{ 'bilingual-paper-editor' = @{ type = 'stdio'; command = $Node; args = @((Join-Path $InstalledRoot 'dist/server.mjs')); env = $RuntimeEnvironment } } }
$McpConfig | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $InstalledRoot 'mcp.json') -Encoding utf8NoBOM
# Desktop discovers only repo/home .agents catalogs. CODEX_HOME may live on
# another drive, so materialize public code under the actual user home and use
# a valid ./ relative source; both copies point at the SAME private state roots.
foreach ($Relative in $Required) {
    $DesktopTarget = Join-Path $DesktopDiscovery.pluginRoot $Relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $DesktopTarget) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PluginSource $Relative) -Destination $DesktopTarget -Force
}
$DesktopMcpConfig = @{ '$schema' = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'; mcpServers = @{ 'bilingual-paper-editor' = @{ type = 'stdio'; command = $Node; args = @((Join-Path $DesktopDiscovery.pluginRoot 'dist/server.mjs')); env = $RuntimeEnvironment } } }
$DesktopMcpConfig | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $DesktopDiscovery.pluginRoot 'mcp.json') -Encoding utf8NoBOM
$null = Save-PaperDesktopDiscoveryCatalog -Plan $DesktopDiscovery
$CatalogDirectory = Join-Path $Destination '.agents/plugins'
New-Item -ItemType Directory -Path $CatalogDirectory -Force | Out-Null
$Catalog = @{ name = 'paper-editor-local'; interface = @{ displayName = 'Bilingual Paper Workbench' }; plugins = @(@{ name = 'bilingual-paper-editor'; source = @{ source = 'local'; path = './plugins/bilingual-paper-editor' }; policy = @{ installation = 'AVAILABLE'; authentication = 'ON_INSTALL' }; category = 'Productivity' }) }
$Catalog | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $CatalogDirectory 'marketplace.json') -Encoding utf8NoBOM
& $Codex plugin marketplace add $Destination --json
if ($LASTEXITCODE -ne 0) { throw 'Local marketplace registration failed.' }
& $Codex plugin add 'bilingual-paper-editor@paper-editor-local' --json
if ($LASTEXITCODE -ne 0) { throw 'Plugin installation failed.' }
# A local app launcher is not an MCP registration. Register only this packaged
# STDIO controller through the documented versioned configuration API.
& $Node (Join-Path $DesktopDiscovery.pluginRoot 'scripts/configure-native-mcp.mjs') --installed-root $DesktopDiscovery.pluginRoot
if ($LASTEXITCODE -ne 0) { throw 'Native paper MCP registration failed; inspect its diagnostic before claiming Desktop availability.' }
if (-not $NoShortcuts) {
    $null = Invoke-PaperShortcutMigration -Plan $ShortcutMigration
    $Shell = New-Object -ComObject WScript.Shell
    foreach ($ShortcutPath in $ShortcutPaths) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $ShortcutPath) -Force | Out-Null
        $Shortcut = $Shell.CreateShortcut($ShortcutPath)
        $Shortcut.TargetPath = $PowerShell
        $Shortcut.Arguments = '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $InstalledRoot 'scripts/launch-workbench.ps1') + '"'
        $Shortcut.WorkingDirectory = $InstalledRoot
        $Shortcut.Description = 'Bilingual Paper Workbench: original PDF, editable translation and paragraph reviews.'
        $Shortcut.IconLocation = (Join-Path $InstalledRoot 'dist/assets/paper-editor.ico') + ',0'
        $Shortcut.WindowStyle = 7
        $Shortcut.Save()
    }
}
New-Item -ItemType Directory -Path $PrivateRoot -Force | Out-Null
$Plan | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $PrivateRoot 'installation-receipt.json') -Encoding utf8NoBOM
$Plan | ConvertTo-Json -Depth 6
