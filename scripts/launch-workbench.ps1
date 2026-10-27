[CmdletBinding()]
param([switch]$NoOpen, [string]$Browser)
$ErrorActionPreference = 'Stop'
trap {
    if (-not $NoOpen) {
        try { Add-Type -AssemblyName PresentationFramework; [Windows.MessageBox]::Show([string]$_.Exception.Message, 'Bilingual Paper Workbench could not start', 'OK', 'Error') | Out-Null } catch {}
    }
    Write-Error -ErrorRecord $_ -ErrorAction Continue
    exit 1
}
$PluginRoot = Split-Path -Parent $PSScriptRoot
$Mcp = (Get-Content -LiteralPath (Join-Path $PluginRoot 'mcp.json') -Raw | ConvertFrom-Json).mcpServers.'bilingual-paper-editor'
if (-not [IO.Path]::IsPathFullyQualified([string]$Mcp.command)) { throw 'The installed Node runtime must use an absolute path.' }
if (-not $Mcp.env.PAPER_EDITOR_WORKSPACE -or -not $Mcp.env.PAPER_EDITOR_MAIN_FILE) { throw 'Select a target .tex file with the installer first.' }
$Entry = Join-Path $PluginRoot 'dist/background-workbench.mjs'
$Arguments = @('--open-workbench')
if ($NoOpen) { $Arguments += '--no-open' }
if ($Browser) {
    if (-not [IO.Path]::IsPathFullyQualified($Browser)) { throw 'Choose an absolute browser path.' }
    $Arguments += @('--browser', $Browser)
}
# This fixed Node entry reads only this installed profile and reuses the same
# background record as the native tool. Arguments remain separate; capability
# URLs, shell-built commands and global environment changes are unnecessary.
& $Mcp.command $Entry @Arguments
if ($LASTEXITCODE -ne 0) { throw 'The configured paper background workbench could not start.' }
