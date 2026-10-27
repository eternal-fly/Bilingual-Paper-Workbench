[CmdletBinding()]
param([Alias('Url')][string]$WindowUrl, [Alias('DataRoot')][string]$WindowDataRoot, [Alias('Browser')][string]$WindowBrowser, [switch]$ReadUrlFromStdin)

# Shared by the native controller and the desktop shortcut. Opening a window
# never starts another paper backend or changes an existing browser window.
. (Join-Path $PSScriptRoot 'window-placement.ps1')
. (Join-Path $PSScriptRoot 'window-registry.ps1')

function Open-PaperWindow {
    [CmdletBinding()]
    param([string]$Url, [string]$DataRoot, [string]$Browser)

    $WindowUri = $null
    if (-not $Url -or $Url.Length -gt 2048 -or -not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$WindowUri) -or
        $WindowUri.Scheme -ne 'http' -or $WindowUri.Host -ne '127.0.0.1' -or $WindowUri.Port -lt 1 -or
        $WindowUri.AbsolutePath -ne '/' -or $WindowUri.Query -or $WindowUri.UserInfo -or
        $WindowUri.Fragment -cnotmatch '^#session=[A-Za-z0-9_-]{43}$') {
        throw 'PAPER_WINDOW_URL_INVALID: The private local paper session URL is invalid.'
    }
    if (-not $DataRoot -or -not [IO.Path]::IsPathFullyQualified($DataRoot) -or $DataRoot -match '["\r\n]') {
        throw 'PAPER_WINDOW_DATA_INVALID: An absolute private paper data directory is required.'
    }
    if (-not $Browser) {
        $Candidates = @()
        foreach ($BrowserBase in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
            if ($BrowserBase) { $Candidates += Join-Path $BrowserBase 'Microsoft/Edge/Application/msedge.exe' }
        }
        $Browser = $Candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    }
    if (-not $Browser -or $Browser -match '["\r\n]' -or -not (Test-Path -LiteralPath $Browser -PathType Leaf)) {
        throw 'PAPER_WINDOW_BROWSER_MISSING: Microsoft Edge was not found. Select an installed Chromium browser executable.'
    }
    $BrowserProfile = Join-Path $DataRoot 'standalone-browser'
    $WorkArea = Get-PaperScreenWorkArea
    $Placement = Get-PaperWindowPlacement @WorkArea
    $SizeArgument = '--window-size=' + $Placement.width + ',' + $Placement.height
    $PositionArgument = '--window-position=' + $Placement.x + ',' + $Placement.y
    $Reused=Invoke-PaperWindowRegistry -Url $Url -DataRoot $DataRoot -Browser $Browser -Profile $BrowserProfile -Launch {
    try {
        # Preserve the existing dedicated profile and the author's DPI/zoom.
        # Chromium owns any restore policy for an already running profile.
        Start-Process -FilePath $Browser -WindowStyle Normal -ArgumentList @(('--app="' + $Url + '"'), ('--user-data-dir="' + $BrowserProfile + '"'), '--new-window', $SizeArgument, $PositionArgument, '--no-first-run', '--no-default-browser-check') -ErrorAction Stop | Out-Null
    } catch {
        # These CreateProcess errors prove that no browser process was created.
        # Other failures remain uncertain and must not authorize another launch.
        $Cause=$_.Exception
        for($Depth=0;$Cause -and $Depth -lt 8;$Depth++) {
            if($Cause -is [ComponentModel.Win32Exception] -and $Cause.NativeErrorCode -in @(2,3,193,216)) {
                throw 'PAPER_WINDOW_START_NOT_CREATED: The browser could not be created; retry after correcting the browser installation.'
            }
            $Cause=$Cause.InnerException
        }
        # Native process exceptions can include arguments; the capability URL
        # must never be printed by the controller or the shortcut's trap.
        throw 'PAPER_WINDOW_OPEN_FAILED: The independent paper window could not be started.'
    }
    }
    $Placement['reusedWindow']=[bool]$Reused
    return $Placement
}

if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    try {
        # A native controller passes the capability through stdin, keeping it
        # out of its PowerShell process command line and public diagnostics.
        if ($ReadUrlFromStdin) { $WindowUrl = [Console]::ReadLine() }
        Open-PaperWindow -Url $WindowUrl -DataRoot $WindowDataRoot -Browser $WindowBrowser | ConvertTo-Json -Compress
    } catch {
        $Code = 'PAPER_WINDOW_OPEN_FAILED'
        if ($_.Exception.Message -match '^(PAPER_WINDOW_(?:URL_INVALID|DATA_INVALID|BROWSER_MISSING|OPEN_FAILED|OPEN_PENDING|IDENTITY_CHANGED|RECOVERY_REQUIRED)):') { $Code = $Matches[1] }
        Write-Error ($Code + ': Could not open the independent paper window.') -ErrorAction Continue
        exit 1
    }
}
