# Rename only verified shortcuts owned by this installation. Original duplicate
# files remain recoverable in private storage; unrelated shortcuts are preserved.
function Get-PaperShortcutFileHash {
    param([Parameter(Mandatory=$true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $Info = Get-Item -LiteralPath $Path -Force
    if ($Info.PSIsContainer -or ($Info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $Info.Length -gt 1MB) { throw 'The shortcut is not a bounded regular file; preserve it for recovery.' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-PaperShortcutMigrationPlan {
    param([Parameter(Mandatory=$true)][string[]]$ShortcutPaths, [Parameter(Mandatory=$true)][string[]]$InstalledRoots, [Parameter(Mandatory=$true)][string]$PowerShell, [Parameter(Mandatory=$true)][string]$BackupRoot, [scriptblock]$ReadShortcut)
    $Roots = @($InstalledRoots | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd([IO.Path]::DirectorySeparatorChar) })
    $PowerShell = [IO.Path]::GetFullPath($PowerShell)
    $BackupRoot = [IO.Path]::GetFullPath($BackupRoot)
    if (-not $ReadShortcut) { $Shell = New-Object -ComObject WScript.Shell; $ReadShortcut = { param($ShortcutPath) $Shell.CreateShortcut($ShortcutPath) }.GetNewClosure() }
    $OwnsShortcut = {
        param($ShortcutPath)
        try {
            $Metadata = & $ReadShortcut $ShortcutPath
            if ([IO.Path]::GetFullPath([string]$Metadata.TargetPath) -ine $PowerShell) { return $false }
            foreach ($Root in $Roots) {
                $Arguments = '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $Root 'scripts/launch-workbench.ps1') + '"'
                if ([string]$Metadata.Arguments -ceq $Arguments -and [IO.Path]::GetFullPath([string]$Metadata.WorkingDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar) -ieq $Root) { return $true }
            }
        } catch { return $false }
        return $false
    }
    $Operations = @(); $Targets = @(); $Parents = @()
    foreach ($ShortcutPath in $ShortcutPaths) {
        $ShortcutPath = [IO.Path]::GetFullPath($ShortcutPath)
        if ([IO.Path]::GetFileName($ShortcutPath) -cne 'Bilingual Paper Workbench.lnk') { throw 'Use the fixed English product shortcut name.' }
        $Parent = Split-Path -Parent $ShortcutPath; $Parents += $Parent
        $TargetHash = Get-PaperShortcutFileHash -Path $ShortcutPath
        if ($TargetHash -and -not (& $OwnsShortcut $ShortcutPath)) { throw 'The English shortcut name is already used by another application; no shortcut was overwritten.' }
        $Targets += @{ path = $ShortcutPath; beforeHash = $TargetHash }
        $HasTarget = [bool]$TargetHash
        foreach ($LegacyName in @('双语论文工作台.lnk','双语论文修订.lnk')) {
            $LegacyPath = Join-Path $Parent $LegacyName; $LegacyHash = Get-PaperShortcutFileHash -Path $LegacyPath
            if (-not $LegacyHash -or -not (& $OwnsShortcut $LegacyPath)) { continue }
            $Operation = if ($HasTarget) { 'backup' } else { 'rename' }
            $NewPath = if ($HasTarget) { Join-Path $BackupRoot (([guid]::NewGuid().ToString('N')) + '-' + $LegacyName + '.bak') } else { $ShortcutPath }
            $Operations += @{ oldPath = $LegacyPath; newPath = $NewPath; beforeHash = $LegacyHash; operation = $Operation }
            $HasTarget = $true
        }
    }
    return @{ operations = @($Operations); targets = @($Targets); allowedParents = @($Parents); backupRoot = $BackupRoot }
}

function Invoke-PaperShortcutMigration {
    param([Parameter(Mandatory=$true)][hashtable]$Plan)
    # Verify the full revision and resolved, finite file destinations before any
    # rename/move. No recursive filesystem operation is used here.
    foreach ($Target in $Plan.targets) { if ((Get-PaperShortcutFileHash -Path $Target.path) -ne $Target.beforeHash) { throw 'A shortcut changed during installation; no migration was performed.' } }
    foreach ($Operation in $Plan.operations) {
        $OldPath = [IO.Path]::GetFullPath($Operation.oldPath); $NewPath = [IO.Path]::GetFullPath($Operation.newPath)
        if ((Split-Path -Parent $OldPath) -notin $Plan.allowedParents -or [IO.Path]::GetFileName($OldPath) -notin @('双语论文工作台.lnk','双语论文修订.lnk') -or (Get-PaperShortcutFileHash -Path $OldPath) -ne $Operation.beforeHash) { throw 'An owned shortcut revision or source path changed; preserve it for recovery.' }
        $SafeRename = $Operation.operation -eq 'rename' -and (Split-Path -Parent $NewPath) -eq (Split-Path -Parent $OldPath) -and [IO.Path]::GetFileName($NewPath) -ceq 'Bilingual Paper Workbench.lnk'
        $SafeBackup = $Operation.operation -eq 'backup' -and (Split-Path -Parent $NewPath) -eq $Plan.backupRoot -and [IO.Path]::GetFileName($NewPath) -match '^[a-f0-9]{32}-.+\.lnk\.bak$'
        if ((-not $SafeRename -and -not $SafeBackup) -or (Test-Path -LiteralPath $NewPath)) { throw 'The shortcut migration target is not its exact unused product path.' }
    }
    foreach ($Operation in $Plan.operations) {
        if ($Operation.operation -eq 'backup') {
            New-Item -ItemType Directory -Path $Plan.backupRoot -Force | Out-Null
            $BackupInfo = Get-Item -LiteralPath $Plan.backupRoot -Force
            if (-not $BackupInfo.PSIsContainer -or ($BackupInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'The private shortcut backup directory is aliased; no file was moved there.' }
        }
        Move-Item -LiteralPath $Operation.oldPath -Destination $Operation.newPath -ErrorAction Stop
    }
    return $Plan
}
