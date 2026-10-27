# One exact backend session owns one ordinary browser window. Neither a caption
# nor a process id alone authorizes focus: the HWND carries a private nonce and
# its browser process creation time must still match the private record.
function Initialize-PaperWindowNative {
    if ('BilingualPaperWindowNativeV1' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public sealed class BilingualPaperNativeWindow {
    public long handle; public int processId; public string title;
}
public static class BilingualPaperWindowNativeV1 {
    public delegate bool EnumProc(IntPtr window,IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window,int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder text,int length);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder text,int length);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window,uint command);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool SetProp(IntPtr window,string name,IntPtr value);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr GetProp(IntPtr window,string name);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr RemoveProp(IntPtr window,string name);
    public static BilingualPaperNativeWindow[] Windows() {
        var result=new List<BilingualPaperNativeWindow>();
        EnumWindows((window,unused)=>{
            if(!IsWindowVisible(window)||GetWindow(window,4)!=IntPtr.Zero) return true;
            var className=new StringBuilder(256);GetClassName(window,className,className.Capacity);
            if(className.ToString()!="Chrome_WidgetWin_1") return true;
            uint pid;GetWindowThreadProcessId(window,out pid);
            var title=new StringBuilder(1024);GetWindowText(window,title,title.Capacity);
            result.Add(new BilingualPaperNativeWindow {handle=window.ToInt64(),processId=(int)pid,title=title.ToString()});
            return true;
        },IntPtr.Zero);
        return result.ToArray();
    }
}
'@ -ErrorAction Stop
}

function Get-PaperWindowHash {
    param([string]$Value)
    $Sha=[Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToHexString($Sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))).ToLowerInvariant() } finally { $Sha.Dispose() }
}

function Get-PaperBrowserWindows {
    param([string]$Browser,[string]$Profile)
    Initialize-PaperWindowNative
    $Names=[IO.Path]::GetFileName($Browser).Replace("'","''")
    $Processes=@{}
    foreach($Candidate in @(Get-CimInstance -ClassName Win32_Process -Filter ("Name='"+$Names+"'") -ErrorAction Stop)) {
        if(-not $Candidate.ExecutablePath -or -not $Candidate.ExecutablePath.Equals($Browser,[StringComparison]::OrdinalIgnoreCase) -or -not $Candidate.CommandLine -or $Candidate.CommandLine -match '(?:^|\s)--type=') { continue }
        $Match=[regex]::Match($Candidate.CommandLine,'(?:^|\s)--user-data-dir=(?:"([^"]+)"|([^\s]+))',[Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if(-not $Match.Success) { continue }
        $Selected=if($Match.Groups[1].Success){$Match.Groups[1].Value}else{$Match.Groups[2].Value}
        if(-not [IO.Path]::GetFullPath($Selected).Equals($Profile,[StringComparison]::OrdinalIgnoreCase)) { continue }
        try { $Process=Get-Process -Id $Candidate.ProcessId -ErrorAction Stop; $Processes[[int]$Candidate.ProcessId]=$Process.StartTime.ToUniversalTime().Ticks } catch { continue }
    }
    foreach($Window in [BilingualPaperWindowNativeV1]::Windows()) {
        if($Processes.ContainsKey([int]$Window.processId)) { @{handle=[long]$Window.handle;processId=[int]$Window.processId;startTicks=[long]$Processes[[int]$Window.processId];title=$Window.title} }
    }
}

function Test-PaperRecordedWindow {
    param($Record,[string]$PropertyName,[string]$Browser)
    Initialize-PaperWindowNative
    $Handle=[IntPtr]([long]$Record.window.handle)
    if(-not [BilingualPaperWindowNativeV1]::IsWindow($Handle)) { return 'closed' }
    [uint32]$Owner=0;[void][BilingualPaperWindowNativeV1]::GetWindowThreadProcessId($Handle,[ref]$Owner)
    try { $Process=Get-Process -Id $Owner -ErrorAction Stop } catch { return 'closed' }
    if($Owner -ne [uint32]$Record.window.processId -or $Process.StartTime.ToUniversalTime().Ticks -ne [long]$Record.window.startTicks) { return 'closed' }
    if(-not $Process.Path -or -not $Process.Path.Equals($Browser,[StringComparison]::OrdinalIgnoreCase) -or [BilingualPaperWindowNativeV1]::GetProp($Handle,$PropertyName).ToInt64() -ne [long]$Record.nonce) { return 'foreign' }
    return 'valid'
}

function Set-PaperWindowMarker {
    param($Window,[string]$PropertyName,[long]$Nonce,[string]$Browser)
    Initialize-PaperWindowNative
    $Handle=[IntPtr]([long]$Window.handle)
    if(-not [BilingualPaperWindowNativeV1]::IsWindow($Handle)) { return $false }
    [uint32]$Owner=0;[void][BilingualPaperWindowNativeV1]::GetWindowThreadProcessId($Handle,[ref]$Owner)
    try { $Process=Get-Process -Id $Owner -ErrorAction Stop } catch { return $false }
    if($Owner -ne [uint32]$Window.processId -or $Process.StartTime.ToUniversalTime().Ticks -ne [long]$Window.startTicks -or -not $Process.Path.Equals($Browser,[StringComparison]::OrdinalIgnoreCase)) { return $false }
    return [BilingualPaperWindowNativeV1]::SetProp($Handle,$PropertyName,[IntPtr]$Nonce)
}

function Get-PaperWindowMarker {
    param($Window,[string]$PropertyName)
    Initialize-PaperWindowNative
    return [BilingualPaperWindowNativeV1]::GetProp([IntPtr]([long]$Window.handle),$PropertyName).ToInt64()
}

function Remove-PaperWindowMarker {
    param($Window,[string]$PropertyName)
    Initialize-PaperWindowNative
    [void][BilingualPaperWindowNativeV1]::RemoveProp([IntPtr]([long]$Window.handle),$PropertyName)
}

# Transfer only an already proven window after an explicit project selection.
# No launch, navigation, foreground activation or title-based discovery occurs.
function Move-PaperWindowRegistry {
    [CmdletBinding()]
    param([string]$FromUrl,[string]$ToUrl,[string]$DataRoot,[ValidateSet('complete','reserve','cancel')][string]$Mode='complete',[string]$HandoffId)
    foreach($Value in @($FromUrl,$ToUrl)) {
        $Uri=$null
        if(-not $Value -or $Value.Length -gt 2048 -or -not [Uri]::TryCreate($Value,[UriKind]::Absolute,[ref]$Uri) -or $Uri.Scheme -ne 'http' -or $Uri.Host -ne '127.0.0.1' -or $Uri.Port -lt 1 -or $Uri.AbsolutePath -ne '/' -or $Uri.Query -or $Uri.UserInfo -or $Uri.Fragment -cnotmatch '^#session=[A-Za-z0-9_-]{43}$'){throw 'PAPER_WINDOW_URL_INVALID: Invalid project window session.'}
    }
    if(-not [IO.Path]::IsPathFullyQualified($DataRoot) -or $DataRoot -match '[\x00-\x1f]'){throw 'PAPER_WINDOW_DATA_INVALID: Invalid private window directory.'}
    if($FromUrl -ceq $ToUrl){return @{reassigned=$false;reason='same-session'}}
    if($HandoffId -and $HandoffId -cnotmatch '^[a-f0-9]{48}$' -or $Mode -eq 'reserve' -and -not $HandoffId){throw 'PAPER_WINDOW_RECOVERY_REQUIRED: A bounded project navigation identity is required.'}
    $DataRoot=[IO.Path]::GetFullPath($DataRoot);$Directory=Join-Path $DataRoot 'window-registry'
    if(-not(Test-Path -LiteralPath $Directory)){return @{reassigned=$false;reason='not-registered'}}
    foreach($Folder in @($DataRoot,$Directory)){ $Info=Get-Item -LiteralPath $Folder -Force -ErrorAction Stop;if(-not $Info.PSIsContainer -or ($Info.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'PAPER_WINDOW_DATA_INVALID: Window records require physical private directories.'} }
    $FromKey=Get-PaperWindowHash $FromUrl;$ToKey=Get-PaperWindowHash $ToUrl
    $FromFile=Join-Path $Directory ($FromKey+'.json');$ToFile=Join-Path $Directory ($ToKey+'.json')
    $Profile=Join-Path $DataRoot 'standalone-browser';$ProfileHash=Get-PaperWindowHash $Profile.ToLowerInvariant()
    $ReadRecord={param($Filename,$Key)
        if(-not(Test-Path -LiteralPath $Filename)){return $null}
        $Info=Get-Item -LiteralPath $Filename -Force -ErrorAction Stop
        if($Info.PSIsContainer -or ($Info.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $Info.Length -gt 65536){throw 'PAPER_WINDOW_RECOVERY_REQUIRED: Preserve the invalid window record.'}
        try{$Record=Get-Content -LiteralPath $Filename -Raw|ConvertFrom-Json -AsHashtable -ErrorAction Stop}catch{throw 'PAPER_WINDOW_RECOVERY_REQUIRED: Preserve the unreadable window record.'}
        if($Record -isnot [Collections.IDictionary] -or $Record.schemaVersion -ne 1 -or $Record.key -cne $Key -or $Record.profileHash -cne $ProfileHash -or $Record.browser -isnot [string] -or -not [IO.Path]::IsPathFullyQualified($Record.browser) -or $Record.status -notin @('ready','opening','not-started','handoff-pending') -or $Record.nonce -isnot [long] -and $Record.nonce -isnot [int] -or $Record.nonce -lt 1 -or $Record.nonce -gt [int]::MaxValue){throw 'PAPER_WINDOW_RECOVERY_REQUIRED: The window record identity is invalid.'}
        if($Record.status -eq 'ready' -and ($Record.window -isnot [Collections.IDictionary] -or $Record.window.handle -isnot [long] -and $Record.window.handle -isnot [int] -or $Record.window.handle -lt 1 -or $Record.window.processId -isnot [long] -and $Record.window.processId -isnot [int] -or $Record.window.processId -lt 1 -or $Record.window.startTicks -isnot [long] -and $Record.window.startTicks -isnot [int] -or $Record.window.startTicks -lt 1)){throw 'PAPER_WINDOW_RECOVERY_REQUIRED: The saved native window identity is invalid.'}
        return $Record
    }
    $Identity=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $Mutex=[Threading.Mutex]::new($false,('Local\BilingualPaperEditor.Window.'+(Get-PaperWindowHash ($Identity+'|'+$Profile.ToLowerInvariant()))));$Locked=$false
    try{
        try{$Locked=$Mutex.WaitOne(10000)}catch [Threading.AbandonedMutexException]{$Locked=$true}
        if(-not $Locked){throw 'PAPER_WINDOW_OPEN_PENDING: Another project window operation is pending.'}
        $Source=&$ReadRecord $FromFile $FromKey;$Target=&$ReadRecord $ToFile $ToKey
        $FromProperty='BilingualPaperEditor.Window.'+$FromKey;$ToProperty='BilingualPaperEditor.Window.'+$ToKey
        if($Target -and $Target.status -eq 'ready'){
            $TargetState=Test-PaperRecordedWindow $Target $ToProperty $Target.browser
            if($TargetState -eq 'valid'){throw 'PROJECT_WINDOW_ALREADY_OPEN: This paper already has an open workbench window.'}
            if($TargetState -ne 'closed'){throw 'PAPER_WINDOW_IDENTITY_CHANGED: The target window no longer confirms ownership.'}
        }
        if(-not $Source -or $Source.status -eq 'not-started'){return @{reassigned=$false;reason='not-registered'}}
        if($Source.status -ne 'ready'){throw 'PAPER_WINDOW_RECOVERY_REQUIRED: The current window is still opening.'}
        $SourceState=Test-PaperRecordedWindow $Source $FromProperty $Source.browser
        if($SourceState -eq 'closed'){return @{reassigned=$false;reason='not-registered'}}
        if($SourceState -ne 'valid'){throw 'PAPER_WINDOW_IDENTITY_CHANGED: The current window no longer confirms ownership.'}
        if($Target){
            if(-not $Target.browser.Equals($Source.browser,[StringComparison]::OrdinalIgnoreCase)){throw 'PAPER_WINDOW_RECOVERY_REQUIRED: Window browsers differ.'}
            if($Target.status -eq 'opening'){throw 'PAPER_WINDOW_RECOVERY_REQUIRED: The target window is still opening.'}
            if($Target.status -eq 'handoff-pending'){
                if($Target.fromKey -cne $FromKey -or $Target.handoffId -cne $HandoffId -or $Target.nonce -ne $Source.nonce -or $Target.window.handle -ne $Source.window.handle -or $Target.window.processId -ne $Source.window.processId -or $Target.window.startTicks -ne $Source.window.startTicks){throw 'PAPER_WINDOW_RECOVERY_REQUIRED: A different project navigation owns the pending window.'}
            }
        }
        if($Mode -eq 'reserve'){
            $Reservation=$Source.Clone();$Reservation.key=$ToKey;$Reservation.status='handoff-pending';$Reservation.fromKey=$FromKey;$Reservation.handoffId=$HandoffId;$Reservation.expiresAt=[DateTime]::UtcNow.AddMinutes(2).ToString('o')
            Write-PaperWindowRecord $ToFile $Reservation
            return @{reassigned=$false;reason='reserved'}
        }
        if($Mode -eq 'cancel'){
            if($Target -and $Target.status -eq 'handoff-pending'){$Retired=$Target.Clone();$Retired.status='not-started';foreach($Name in @('window','fromKey','handoffId','expiresAt')){$Retired.Remove($Name)};Write-PaperWindowRecord $ToFile $Retired}
            return @{reassigned=$false;reason='cancelled'}
        }
        if(-not $Target -or $Target.status -ne 'handoff-pending'){throw 'PAPER_WINDOW_RECOVERY_REQUIRED: Reserve the target window before navigation.'}
        $Expires=[DateTime]::MinValue
        $DateValid=if($Target.expiresAt -is [DateTime]){$Expires=$Target.expiresAt;$true}else{[DateTime]::TryParse([string]$Target.expiresAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind,[ref]$Expires)}
        if(-not $DateValid -or $Expires.ToUniversalTime() -le [DateTime]::UtcNow){throw 'PAPER_WINDOW_RECOVERY_REQUIRED: The project window reservation expired.'}
        if(-not(Set-PaperWindowMarker $Source.window $ToProperty $Source.nonce $Source.browser)){throw 'PAPER_WINDOW_IDENTITY_CHANGED: The target marker could not be assigned.'}
        try{
            $Next=$Source.Clone();$Next.key=$ToKey;$Next.createdAt=[DateTime]::UtcNow.ToString('o')
            Write-PaperWindowRecord $ToFile $Next
            $Retired=$Source.Clone();$Retired.status='not-started';$Retired.Remove('window');Write-PaperWindowRecord $FromFile $Retired
            Remove-PaperWindowMarker $Source.window $FromProperty
        }catch{
            Remove-PaperWindowMarker $Source.window $ToProperty
            try{Write-PaperWindowRecord $FromFile $Source;if($Target){Write-PaperWindowRecord $ToFile $Target}else{Remove-Item -LiteralPath $ToFile -ErrorAction SilentlyContinue}}catch{}
            throw 'PAPER_WINDOW_RECOVERY_REQUIRED: Project window handoff did not complete; the current project remains open.'
        }
        return @{reassigned=$true}
    }finally{if($Locked){$Mutex.ReleaseMutex()};$Mutex.Dispose()}
}

function Show-PaperRecordedWindow {
    param($Record,[string]$PropertyName,[string]$Browser)
    if((Test-PaperRecordedWindow -Record $Record -PropertyName $PropertyName -Browser $Browser) -ne 'valid') { throw 'PAPER_WINDOW_IDENTITY_CHANGED: The saved paper window changed during activation.' }
    $Handle=[IntPtr]([long]$Record.window.handle)
    if([BilingualPaperWindowNativeV1]::IsIconic($Handle)) { [void][BilingualPaperWindowNativeV1]::ShowWindowAsync($Handle,9) }
    elseif(-not [BilingualPaperWindowNativeV1]::IsWindowVisible($Handle)) { [void][BilingualPaperWindowNativeV1]::ShowWindowAsync($Handle,5) }
    # Windows may decline foreground activation while the user is working in
    # another application. Do not navigate/reload or spawn a replacement.
    [void][BilingualPaperWindowNativeV1]::SetForegroundWindow($Handle)
}

function Write-PaperWindowRecord {
    param([string]$Filename,$Record)
    $Temporary=$Filename+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
    try {
        $Bytes=[Text.Encoding]::UTF8.GetBytes(($Record | ConvertTo-Json -Depth 8 -Compress))
        $Stream=[IO.File]::Open($Temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $Stream.Write($Bytes,0,$Bytes.Length);$Stream.Flush($true) } finally { $Stream.Dispose() }
        [IO.File]::Move($Temporary,$Filename,$true)
    } finally { if([IO.File]::Exists($Temporary)){[IO.File]::Delete($Temporary)} }
}

function Get-PaperOtherWindowRecords {
    param([string]$Directory,[string]$Key,[string]$ProfileHash,[string]$Browser)
    $Files=@(Get-ChildItem -LiteralPath $Directory -Filter '*.json' -Force -ErrorAction Stop)
    if($Files.Count -gt 4096){throw 'PAPER_WINDOW_RECOVERY_REQUIRED: Too many window records exist to verify ownership safely.'}
    foreach($File in $Files) {
        if($File.BaseName -ceq $Key){continue}
        if($File.BaseName -cnotmatch '^[a-f0-9]{64}$' -or $File.PSIsContainer -or ($File.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $File.Length -gt 65536){throw 'PAPER_WINDOW_RECOVERY_REQUIRED: Another window record cannot be verified safely.'}
        try{$Other=Get-Content -LiteralPath $File.FullName -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop}catch{throw 'PAPER_WINDOW_RECOVERY_REQUIRED: Preserve the unreadable window record for recovery.'}
        if($Other -isnot [Collections.IDictionary] -or $Other.schemaVersion -ne 1 -or $Other.key -cne $File.BaseName -or $Other.profileHash -isnot [string]){throw 'PAPER_WINDOW_RECOVERY_REQUIRED: Another window record has an unexpected identity.'}
        if($Other.profileHash -cne $ProfileHash){continue}
        if($Other.browser -isnot [string] -or -not $Other.browser.Equals($Browser,[StringComparison]::OrdinalIgnoreCase) -or $Other.nonce -isnot [long] -and $Other.nonce -isnot [int] -or $Other.nonce -lt 1 -or $Other.nonce -gt [int]::MaxValue -or $Other.status -notin @('opening','ready','not-started','handoff-pending')){throw 'PAPER_WINDOW_RECOVERY_REQUIRED: Another profile window record has an unexpected identity.'}
        $Other
    }
}

function Test-PaperWindowClaimedByOtherSession {
    param($Window,$OtherRecords)
    foreach($Other in $OtherRecords) {
        # A nonzero foreign marker is sufficient to reject a candidate. Never
        # overwrite it merely because a previous launch's snapshot predates it.
        if((Get-PaperWindowMarker -Window $Window -PropertyName ('BilingualPaperEditor.Window.'+$Other.key)) -ne 0){return $true}
    }
    return $false
}

function Invoke-PaperWindowRegistry {
    [CmdletBinding()]
    param([string]$Url,[string]$DataRoot,[string]$Browser,[string]$Profile,[scriptblock]$Launch)
    $DataRoot=[IO.Path]::GetFullPath($DataRoot);$Profile=[IO.Path]::GetFullPath($Profile);$Browser=(Resolve-Path -LiteralPath $Browser -ErrorAction Stop).Path
    $Directory=Join-Path $DataRoot 'window-registry';New-Item -ItemType Directory -Path $Directory -Force -ErrorAction Stop | Out-Null
    foreach($Target in @($DataRoot,$Directory)) { $Info=Get-Item -LiteralPath $Target -Force -ErrorAction Stop;if(-not $Info.PSIsContainer -or ($Info.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'PAPER_WINDOW_DATA_INVALID: Window records must stay in actual private directories.'} }
    $Key=Get-PaperWindowHash $Url;$ProfileHash=Get-PaperWindowHash $Profile.ToLowerInvariant();$PropertyName='BilingualPaperEditor.Window.'+$Key
    $Filename=Join-Path $Directory ($Key+'.json')
    $Identity=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $MutexName='Local\BilingualPaperEditor.Window.'+(Get-PaperWindowHash ($Identity+'|'+$Profile.ToLowerInvariant()))
    $Mutex=[Threading.Mutex]::new($false,$MutexName);$Locked=$false
    try {
        try { $Locked=$Mutex.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $Locked=$true }
        if(-not $Locked) { throw 'PAPER_WINDOW_OPEN_PENDING: Another request is opening this paper window.' }
        $Record=$null
        $OtherRecords=@(Get-PaperOtherWindowRecords -Directory $Directory -Key $Key -ProfileHash $ProfileHash -Browser $Browser)
        if(Test-Path -LiteralPath $Filename) {
            $Info=Get-Item -LiteralPath $Filename -Force -ErrorAction Stop
            if($Info.PSIsContainer -or ($Info.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $Info.Length -gt 65536) { throw 'PAPER_WINDOW_RECOVERY_REQUIRED: The saved window record is not a bounded regular file.' }
            try {$Record=Get-Content -LiteralPath $Filename -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop}catch{throw 'PAPER_WINDOW_RECOVERY_REQUIRED: Preserve the unreadable window record for recovery.'}
            if($Record -isnot [Collections.IDictionary] -or $Record.schemaVersion -ne 1 -or $Record.key -cne $Key -or $Record.profileHash -cne $ProfileHash -or $Record.browser -isnot [string] -or -not $Record.browser.Equals($Browser,[StringComparison]::OrdinalIgnoreCase) -or $Record.nonce -isnot [long] -and $Record.nonce -isnot [int] -or $Record.nonce -lt 1 -or $Record.nonce -gt [int]::MaxValue -or $Record.status -notin @('opening','ready','not-started','handoff-pending')) { throw 'PAPER_WINDOW_RECOVERY_REQUIRED: The saved window record has an unexpected identity.' }
            if($Record.status -eq 'handoff-pending'){throw 'PAPER_WINDOW_OPEN_PENDING: This project is being loaded in its existing workbench window.'}
            if($Record.status -eq 'ready') {
                if($Record.window -isnot [Collections.IDictionary] -or $Record.window.handle -isnot [long] -and $Record.window.handle -isnot [int] -or $Record.window.handle -lt 1 -or $Record.window.processId -isnot [long] -and $Record.window.processId -isnot [int] -or $Record.window.processId -lt 1 -or $Record.window.startTicks -isnot [long] -and $Record.window.startTicks -isnot [int] -or $Record.window.startTicks -lt 1) { throw 'PAPER_WINDOW_RECOVERY_REQUIRED: The saved window identity is invalid.' }
                $State=Test-PaperRecordedWindow -Record $Record -PropertyName $PropertyName -Browser $Browser
                if($State -eq 'valid') {Show-PaperRecordedWindow -Record $Record -PropertyName $PropertyName -Browser $Browser;return $true}
                if($State -ne 'closed') {throw 'PAPER_WINDOW_IDENTITY_CHANGED: The saved live window no longer confirms ownership.'}
            } elseif($Record.status -eq 'opening') {
                # An interrupted launch is never permission to open a second
                # window. Recover only the exact property already marked by us.
                $Owned=@(Get-PaperBrowserWindows -Browser $Browser -Profile $Profile)
                $Marked=@($Owned | Where-Object { (Get-PaperWindowMarker -Window $_ -PropertyName $PropertyName) -eq [long]$Record.nonce })
                if($Marked.Count -eq 1) {$Record.window=$Marked[0];$Record.status='ready';Write-PaperWindowRecord $Filename $Record;Show-PaperRecordedWindow -Record $Record -PropertyName $PropertyName -Browser $Browser;return $true}
                # A confirmed launch may finish just after the first helper's
                # capture deadline. Reuse the original bounded before-snapshot,
                # exact profile/process identity and branded page, not a title
                # search over pre-existing windows or another browser launch.
                $Issued=[DateTime]::MinValue
                $DateValid=if($Record.createdAt -is [DateTime]){$Issued=$Record.createdAt;$true}else{[DateTime]::TryParse([string]$Record.createdAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind,[ref]$Issued)}
                $Recent=$DateValid -and ([DateTime]::UtcNow-$Issued.ToUniversalTime()).TotalSeconds -ge 0 -and ([DateTime]::UtcNow-$Issued.ToUniversalTime()).TotalSeconds -le 60
                if($Record.launchConfirmed -is [bool] -and $Record.launchConfirmed -and $Recent -and $Record.beforeWindows -is [Array] -and $Record.beforeWindows.Count -le 256 -and -not @($Record.beforeWindows|Where-Object{$_ -isnot [string] -or $_.Length -gt 200}).Count) {
                    $Late=@($Owned|Where-Object{([string]$_.handle+':'+$_.processId+':'+$_.startTicks) -notin $Record.beforeWindows -and $_.title -ceq 'Bilingual Paper Workbench' -and -not (Test-PaperWindowClaimedByOtherSession -Window $_ -OtherRecords $OtherRecords)})
                    if($Late.Count -eq 1 -and (Set-PaperWindowMarker -Window $Late[0] -PropertyName $PropertyName -Nonce $Record.nonce -Browser $Browser)) {$Record.window=$Late[0];$Record.status='ready';Write-PaperWindowRecord $Filename $Record;Show-PaperRecordedWindow -Record $Record -PropertyName $PropertyName -Browser $Browser;return $true}
                }
                throw 'PAPER_WINDOW_RECOVERY_REQUIRED: A previous window launch was interrupted; no duplicate window was opened.'
            }
        }
        # An earlier session may still produce an unmarked window after its
        # capture deadline. Starting another app now would make that late window
        # indistinguishable from the new app; recover the earlier session first.
        if(@($OtherRecords|Where-Object{$_.status -eq 'opening'}).Count){throw 'PAPER_WINDOW_RECOVERY_REQUIRED: Another paper window launch has unresolved ownership; recover that session before opening a new one.'}
        $Before=@(Get-PaperBrowserWindows -Browser $Browser -Profile $Profile);$BeforeKeys=@{}
        foreach($Window in $Before){$BeforeKeys[([string]$Window.handle+':'+$Window.processId+':'+$Window.startTicks)]=$true}
        $Random=[Security.Cryptography.RandomNumberGenerator]::GetBytes(4);$Nonce=[BitConverter]::ToUInt32($Random,0) -band 0x7fffffff;if($Nonce -eq 0){$Nonce=1}
        if($BeforeKeys.Count -gt 256){throw 'PAPER_WINDOW_RECOVERY_REQUIRED: Too many browser windows are open to capture ownership safely.'}
        $Record=@{schemaVersion=1;key=$Key;profileHash=$ProfileHash;browser=$Browser;nonce=[int]$Nonce;status='opening';ownerPid=$PID;createdAt=[DateTime]::UtcNow.ToString('o');beforeWindows=@($BeforeKeys.Keys);launchConfirmed=$false}
        Write-PaperWindowRecord $Filename $Record
        try { & $Launch }
        catch {
            if($_.Exception.Message -match '^PAPER_WINDOW_START_NOT_CREATED:'){$Record.status='not-started';Write-PaperWindowRecord $Filename $Record}
            throw
        }
        $Record.launchConfirmed=$true;Write-PaperWindowRecord $Filename $Record
        $Deadline=[DateTime]::UtcNow.AddSeconds(10);$Stable=$null;$StableAt=[DateTime]::MinValue
        while([DateTime]::UtcNow -lt $Deadline) {
            $Candidates=@(Get-PaperBrowserWindows -Browser $Browser -Profile $Profile | Where-Object { -not $BeforeKeys.ContainsKey(([string]$_.handle+':'+$_.processId+':'+$_.startTicks)) -and $_.title -ceq 'Bilingual Paper Workbench' -and -not (Test-PaperWindowClaimedByOtherSession -Window $_ -OtherRecords $OtherRecords) })
            if($Candidates.Count -gt 1) {throw 'PAPER_WINDOW_RECOVERY_REQUIRED: More than one new browser window appeared; no unrelated window was adopted.'}
            if($Candidates.Count -eq 1) {
                $Candidate=$Candidates[0];$CandidateKey=[string]$Candidate.handle+':'+$Candidate.processId+':'+$Candidate.startTicks
                if($Stable -ceq $CandidateKey -and ([DateTime]::UtcNow-$StableAt).TotalMilliseconds -ge 200) {
                    if(-not (Set-PaperWindowMarker -Window $Candidate -PropertyName $PropertyName -Nonce $Nonce -Browser $Browser)){throw 'PAPER_WINDOW_RECOVERY_REQUIRED: The new window could not confirm ownership.'}
                    $Record.status='ready';$Record.window=$Candidate;Write-PaperWindowRecord $Filename $Record
                    return $false
                }
                if($Stable -cne $CandidateKey){$Stable=$CandidateKey;$StableAt=[DateTime]::UtcNow}
            } else {$Stable=$null}
            Start-Sleep -Milliseconds 100
        }
        throw 'PAPER_WINDOW_OPEN_PENDING: The paper window is still opening; no duplicate was launched.'
    } finally {if($Locked){$Mutex.ReleaseMutex()};$Mutex.Dispose()}
}
