# Code-only Desktop discovery. Private manuscript/runtime contents are never
# copied; generated MCP configuration retains their explicit local paths.

function Get-PaperDesktopCatalogHash {
    param([Parameter(Mandatory=$true)][string]$Path)
    Set-StrictMode -Version Latest
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $Info = Get-Item -LiteralPath $Path -Force
    if (($Info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $Info.Length -gt 1MB) { throw 'Desktop plugin catalog is aliased or exceeds 1 MiB; preserve it for recovery.' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-PaperDesktopDiscoveryPlan {
    param([Parameter(Mandatory=$true)][string]$UserHome)
    Set-StrictMode -Version Latest
    if (-not [IO.Path]::IsPathFullyQualified($UserHome)) { throw 'Desktop discovery requires an absolute user-home directory.' }
    $Root = [IO.Path]::GetFullPath($UserHome).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw 'Desktop discovery user home does not exist.' }
    $Components = @('.agents','plugins','local','paper-editor-local','plugins','bilingual-paper-editor')
    $Cursor = $Root
    foreach ($Part in $Components) {
        $Cursor = Join-Path $Cursor $Part
        if (Test-Path -LiteralPath $Cursor) {
            $Info = Get-Item -LiteralPath $Cursor -Force
            if (-not $Info.PSIsContainer -or ($Info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Desktop plugin discovery cannot traverse an existing file or reparse directory.' }
        }
    }
    $PluginRoot = $Cursor
    $Relative = [IO.Path]::GetRelativePath($Root, $PluginRoot).Replace('\','/')
    if ($Relative.StartsWith('../') -or [IO.Path]::IsPathRooted($Relative)) { throw 'Desktop plugin source escaped the user home.' }
    $SourcePath = './' + $Relative
    $CatalogPath = Join-Path $Root '.agents/plugins/marketplace.json'
    $BeforeHash = Get-PaperDesktopCatalogHash -Path $CatalogPath
    if ($null -ne $BeforeHash) {
        try { $Catalog = Get-Content -LiteralPath $CatalogPath -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop } catch { throw 'Desktop plugin catalog is invalid JSON; preserve it for recovery.' }
        if ($Catalog -isnot [System.Collections.IDictionary] -or $Catalog.name -isnot [string] -or $Catalog.name -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' -or $Catalog.plugins -isnot [array]) { throw 'Desktop plugin catalog has an unsupported structure; preserve it for recovery.' }
    } else { $Catalog = @{ name = 'paper-editor-local'; interface = @{ displayName = 'Bilingual Paper Workbench' }; plugins = @() } }
    $Matches = @($Catalog.plugins | Where-Object { $_ -is [System.Collections.IDictionary] -and $_.name -eq 'bilingual-paper-editor' })
    if ($Matches.Count -gt 1) { throw 'Desktop plugin catalog contains duplicate bilingual-paper-editor entries; preserve it for recovery.' }
    if ($Matches.Count -eq 1) {
        $Entry = $Matches[0]
        if ($Entry.source -isnot [System.Collections.IDictionary] -or $Entry.source.source -ne 'local' -or $Entry.source.path -ne $SourcePath) { throw 'The existing Desktop bilingual-paper-editor entry uses a different source; no catalog entry was overwritten.' }
    } else {
        $Catalog.plugins = @($Catalog.plugins) + @(@{ name = 'bilingual-paper-editor'; source = @{ source = 'local'; path = $SourcePath }; policy = @{ installation = 'AVAILABLE'; authentication = 'ON_INSTALL' }; category = 'Productivity' })
    }
    # Rename only the product's own single-plugin catalog. A mixed or custom
    # catalog keeps its user-defined display name and all unrelated entries.
    if ($Catalog.name -eq 'paper-editor-local' -and $Catalog.plugins.Count -eq 1 -and $Catalog.plugins[0].name -eq 'bilingual-paper-editor') {
        if ($Catalog.interface -isnot [System.Collections.IDictionary]) { $Catalog.interface = @{} }
        $Catalog.interface.displayName = 'Bilingual Paper Workbench'
    }
    return @{ root = $Root; pluginRoot = $PluginRoot; catalogPath = $CatalogPath; sourcePath = $SourcePath; catalogName = $Catalog.name; catalogBeforeHash = $BeforeHash; catalog = $Catalog; pluginId = ('bilingual-paper-editor@' + $Catalog.name); appRestartRequired = $true }
}

function Save-PaperDesktopDiscoveryCatalog {
    param([Parameter(Mandatory=$true)][hashtable]$Plan)
    Set-StrictMode -Version Latest
    # Re-derive every destination and compare the original catalog revision before
    # creating directories or replacing bytes. Callers cannot inject a new path.
    $Current = Get-PaperDesktopDiscoveryPlan -UserHome $Plan.root
    if ($Current.catalogPath -ne $Plan.catalogPath -or $Current.pluginRoot -ne $Plan.pluginRoot -or $Current.catalogBeforeHash -ne $Plan.catalogBeforeHash) { throw 'Desktop plugin catalog changed during installation; no catalog was overwritten.' }
    $Text = $Current.catalog | ConvertTo-Json -Depth 32
    if ([Text.Encoding]::UTF8.GetByteCount($Text) -gt 1MB) { throw 'Merged Desktop catalog exceeds 1 MiB.' }
    if ($null -ne $Current.catalogBeforeHash -and [IO.File]::ReadAllText($Current.catalogPath) -ceq $Text) { return $Current }
    $Parent = Split-Path -Parent $Current.catalogPath
    New-Item -ItemType Directory -Path $Parent -Force | Out-Null
    $Temporary = Join-Path $Parent ('marketplace.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($Temporary, $Text, [Text.UTF8Encoding]::new($false))
        $LatestHash = Get-PaperDesktopCatalogHash -Path $Current.catalogPath
        if ($LatestHash -ne $Current.catalogBeforeHash) { throw 'Desktop plugin catalog changed before replacement; no catalog was overwritten.' }
        if ($null -ne $LatestHash) {
            # Atomic replacement retains the exact previous user catalog as one
            # private recovery file; unrelated entries and fields stay in place.
            $Backup = Join-Path $Parent ('marketplace.before-paper-editor.' + [guid]::NewGuid().ToString('N') + '.json')
            [IO.File]::Replace($Temporary, $Current.catalogPath, $Backup)
        } else { [IO.File]::Move($Temporary, $Current.catalogPath, $false) }
    } finally { if (Test-Path -LiteralPath $Temporary -PathType Leaf) { Remove-Item -LiteralPath $Temporary -Force } }
    return $Current
}
