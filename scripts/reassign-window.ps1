[CmdletBinding()]
param([string]$DataRoot)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'window-registry.ps1')
try{
    $InputLine=[Console]::ReadLine()
    if(-not $InputLine -or $InputLine.Length -gt 8192){throw 'PAPER_WINDOW_URL_INVALID: Invalid handoff input.'}
    $Packet=$InputLine|ConvertFrom-Json -AsHashtable
    if($Packet -isnot [Collections.IDictionary] -or $Packet.Count -ne 4 -or -not $Packet.ContainsKey('fromUrl') -or -not $Packet.ContainsKey('toUrl') -or $Packet.handoffId -cnotmatch '^[a-f0-9]{48}$' -or $Packet.mode -notin @('complete','reserve','cancel')){throw 'PAPER_WINDOW_URL_INVALID: Invalid handoff input.'}
    Move-PaperWindowRegistry -FromUrl $Packet.fromUrl -ToUrl $Packet.toUrl -DataRoot $DataRoot -HandoffId $Packet.handoffId -Mode $Packet.mode|ConvertTo-Json -Compress
}catch{
    $Code='PAPER_WINDOW_RECOVERY_REQUIRED'
    if($_.Exception.Message -match '^(PROJECT_WINDOW_ALREADY_OPEN|PAPER_WINDOW_(?:URL_INVALID|DATA_INVALID|OPEN_PENDING|IDENTITY_CHANGED|RECOVERY_REQUIRED)):'){$Code=$Matches[1]}
    @{error=$Code}|ConvertTo-Json -Compress
    exit 1
}
