# Window placement only. This helper neither changes DPI/zoom settings nor
# manipulates an existing window or the browser's saved preferences.
function Get-PaperWindowPlacement {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][ValidateRange(1,65536)][double]$WorkWidth,
        [Parameter(Mandatory=$true)][ValidateRange(1,65536)][double]$WorkHeight,
        [double]$WorkLeft = 0,
        [double]$WorkTop = 0,
        [ValidateRange(0.5,8)][double]$DpiScale = 1
    )
    # Inputs may be physical pixels when a DPI factor is supplied. Chromium's
    # window geometry is requested in logical units; WPF WorkArea already is.
    $AreaWidth = [Math]::Max(1, [Math]::Floor($WorkWidth / $DpiScale))
    $AreaHeight = [Math]::Max(1, [Math]::Floor($WorkHeight / $DpiScale))
    $AreaLeft = [Math]::Floor($WorkLeft / $DpiScale)
    $AreaTop = [Math]::Floor($WorkTop / $DpiScale)
    $Margin = [Math]::Min(24, [Math]::Max(0, [Math]::Floor([Math]::Min($AreaWidth, $AreaHeight) * 0.04)))
    $AvailableWidth = [Math]::Max(1, $AreaWidth - 2 * $Margin)
    $AvailableHeight = [Math]::Max(1, $AreaHeight - 2 * $Margin)
    # Keep the1.0 literal floating-point: PowerShell otherwise selects the
    # integer Math.Min overload and rounds a fractional fit factor up to1.
    $Factor = [Math]::Min(1.0, [Math]::Min($AvailableWidth / 1440.0, $AvailableHeight / 900.0))
    $Width = [Math]::Max(1, [Math]::Floor(1440 * $Factor))
    $Height = [Math]::Max(1, [Math]::Floor(900 * $Factor))
    # A short laptop screen may need a wider ratio than16:10. Leave room for the
    # normal window frame while keeping the compact three-column1000px layout.
    $Width = [Math]::Min($AvailableWidth, [Math]::Max($Width, [Math]::Min(1032, $AvailableWidth)))
    [ordered]@{
        width = [int]$Width
        height = [int]$Height
        x = [int]($AreaLeft + [Math]::Floor(($AreaWidth - $Width) / 2))
        y = [int]($AreaTop + [Math]::Floor(($AreaHeight - $Height) / 2))
        requestedState = 'normal'
    }
}

function Get-PaperScreenWorkArea {
    [CmdletBinding()]
    param()
    try {
        # WPF projects the primary monitor work rectangle into logical units,
        # respecting the current Windows DPI and excluding the taskbar.
        Add-Type -AssemblyName PresentationFramework -ErrorAction Stop
        $Area = [System.Windows.SystemParameters]::WorkArea
        if ($Area.Width -lt 1 -or $Area.Height -lt 1) { throw 'No usable desktop work area.' }
        return @{ WorkWidth = [double]$Area.Width; WorkHeight = [double]$Area.Height; WorkLeft = [double]$Area.Left; WorkTop = [double]$Area.Top }
    } catch {
        # Do not fail the paper session merely because screen metadata cannot
        # be queried; request a conservative ordinary window instead.
        return @{ WorkWidth = 1280; WorkHeight = 720; WorkLeft = 0; WorkTop = 0 }
    }
}
