[CmdletBinding()]
param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$PluginRoot = Split-Path -Parent $PSScriptRoot
$SmokeVersion = (Get-Content -LiteralPath (Join-Path $PluginRoot 'package.json') -Raw | ConvertFrom-Json).version + '-smoke'
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $PluginRoot ('work/standalone-smoke-' + [guid]::NewGuid().ToString('N')) }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$OwnedRoot = [IO.Path]::GetFullPath((Join-Path $PluginRoot 'work')) + [IO.Path]::DirectorySeparatorChar
if (-not $OutputDirectory.StartsWith($OwnedRoot,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $OutputDirectory)) { throw 'Choose a new owned directory under this plugin work/ folder.' }
New-Item -ItemType Directory -Path (Join-Path $OutputDirectory 'scripts'),(Join-Path $OutputDirectory 'dist') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'launch-workbench.ps1') -Destination (Join-Path $OutputDirectory 'scripts/launch-workbench.ps1')
foreach ($File in @('local-web.mjs','background-workbench.mjs','preview.html','windows-writer.ps1')) { Copy-Item -LiteralPath (Join-Path $PluginRoot ('dist/' + $File)) -Destination (Join-Path $OutputDirectory ('dist/' + $File)) }
$Source = (Resolve-Path -LiteralPath (Join-Path $PluginRoot 'fixtures/sample-paper')).Path
$BeforeHash = (Get-FileHash -LiteralPath (Join-Path $Source 'main.tex') -Algorithm SHA256).Hash
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Configuration = @{ mcpServers = @{ 'bilingual-paper-editor' = @{ command = $Node; env = @{
    PAPER_EDITOR_INSTALL_VERSION = $SmokeVersion; PAPER_EDITOR_DATA_ROOT = (Join-Path $OutputDirectory 'private');
    PAPER_EDITOR_CODEX_ROOT = (Join-Path $OutputDirectory 'chat'); PAPER_EDITOR_COMPILER_ROOT = (Join-Path $OutputDirectory 'compiler-unavailable');
    PAPER_EDITOR_WORKSPACE = $Source; PAPER_EDITOR_MAIN_FILE = 'main.tex'; PAPER_EDITOR_PREFERRED_MODEL = 'gpt-6-astra'
} } } }
$Configuration | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'mcp.json') -Encoding utf8NoBOM
New-Item -ItemType Directory -Path (Join-Path $OutputDirectory 'private'),(Join-Path $OutputDirectory 'chat') -Force | Out-Null
$First = $null
try {
    $First = & (Join-Path $OutputDirectory 'scripts/launch-workbench.ps1') -NoOpen | ConvertFrom-Json
    $Second = & (Join-Path $OutputDirectory 'scripts/launch-workbench.ps1') -NoOpen | ConvertFrom-Json
    if (-not $First.pid -or $First.pid -ne $Second.pid -or -not $Second.reused) { throw 'Repeated launcher did not reuse the exact healthy backend.' }
    $Session = Get-Content -LiteralPath $First.sessionFile -Raw | ConvertFrom-Json
    $Uri = [Uri]$Session.url
    if ($Uri.Scheme -ne 'http' -or $Uri.Host -ne '127.0.0.1' -or $Session.version -ne $SmokeVersion) { throw 'Unexpected private backend origin or version.' }
    $Origin = $Uri.GetLeftPart([UriPartial]::Authority)
    $State = Invoke-RestMethod -Uri ($Origin + '/api') -Method Post -ContentType 'application/json' -Body '{"action":"state","payload":{}}' -Headers @{ Authorization = ('Bearer ' + $Uri.Fragment.Substring(9)); Origin = $Origin }
    if (-not $State.ok -or $State.state.project.mainFile -ne 'main.tex' -or -not $State.state.segments.Count) { throw 'Independent authenticated paper state failed.' }
    if ((Get-FileHash -LiteralPath (Join-Path $Source 'main.tex') -Algorithm SHA256).Hash -ne $BeforeHash) { throw 'Read-only launcher smoke modified its synthetic source.' }
    $Report = [ordered]@{ ok = $true; version = $Session.version; independentBackend = $true; authenticatedLoopback = $true; reusedBackend = $true; syntheticPaper = $true; sourceUnchanged = $true; privateCapabilityPrinted = $false; visibleWindow = 'not-exercised'; desktopProcessRequired = $false; outputDirectory = $OutputDirectory }
    $Report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'report.json') -Encoding utf8NoBOM
    $Report | ConvertTo-Json -Compress
} finally {
    # This owns only the newly created synthetic backend; it never stops another panel.
    if ($First.pid) {
        $Process = Get-Process -Id $First.pid -ErrorAction SilentlyContinue
        if ($Process -and $Process.Path -eq $Node -and $First.sessionFile.StartsWith($OutputDirectory,[StringComparison]::OrdinalIgnoreCase)) { Stop-Process -Id $Process.Id }
    }
}
