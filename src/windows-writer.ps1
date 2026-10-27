param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PaperWriterNative {
  [StructLayout(LayoutKind.Sequential)] struct FileInfo { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr h, out FileInfo info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandle(IntPtr h, StringBuilder b, uint n, uint f);
  public static string FinalPath(IntPtr h) {
    var b=new StringBuilder(32768); var n=GetFinalPathNameByHandle(h,b,(uint)b.Capacity,0);
    if(n==0 || n>=b.Capacity) throw new System.ComponentModel.Win32Exception();
    var s=b.ToString(); return s.StartsWith("\\\\?\\") ? s.Substring(4) : s;
  }
  public static uint Links(IntPtr h) { FileInfo info; if(!GetFileInformationByHandle(h,out info)) throw new System.ComponentModel.Win32Exception(); return info.Links; }
}
'@
function Send-Event($Value) { [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 8 -Compress)); [Console]::Out.Flush() }
function Fail([string]$Code,[string]$Message) { $Failure = New-Object Exception($Message); $Failure.Data['code']=$Code; throw $Failure }
function File-Hash([IO.FileStream]$Stream) {
  $Stream.Position=0; $Hasher=[Security.Cryptography.SHA256]::Create()
  try { $Hash=[BitConverter]::ToString($Hasher.ComputeHash($Stream)).Replace('-','').ToLowerInvariant(); $Stream.Position=0; return $Hash } finally { $Hasher.Dispose() }
}
function Safe-Path([string]$Root,[string]$Relative) {
  $BadParts=@($Relative.Replace('\','/').Split('/') | Where-Object { $_ -in @('','.','..') -or $_ -match '[. ]$' -or $_ -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)' })
  if (-not $Relative -or [IO.Path]::IsPathRooted($Relative) -or $Relative -match '[\x00-\x1f<>:"|?*]' -or $BadParts.Count -gt 0) { Fail 'PERMISSION_DENIED' 'Invalid relative source path.' }
  $Resolved=[IO.Path]::GetFullPath((Join-Path $Root $Relative))
  if (-not $Resolved.StartsWith($Root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { Fail 'PERMISSION_DENIED' 'Source path escapes authorized root.' }
  $Cursor=$Root
  foreach ($Component in $Relative.Replace('\','/').Split('/')) {
    $Cursor=Join-Path $Cursor $Component
    if (([IO.File]::GetAttributes($Cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'PERMISSION_DENIED' 'Reparse inputs are unsupported.' }
  }
  return $Resolved
}
$Streams=New-Object 'Collections.Generic.Dictionary[string,IO.FileStream]' ([StringComparer]::OrdinalIgnoreCase)
$Written=0
try {
  $RequestData=Get-Content -LiteralPath $RequestFile -Raw | ConvertFrom-Json
  $Root=[IO.Path]::GetFullPath([string]$RequestData.root)
  if ($Root.StartsWith('\\') -or -not [IO.Directory]::Exists($Root) -or ([IO.File]::GetAttributes($Root) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'PERMISSION_DENIED' 'Only a local real project directory is supported.' }
  $Drive=New-Object IO.DriveInfo([IO.Path]::GetPathRoot($Root))
  if ($Drive.DriveFormat -ne 'NTFS') { Fail 'CAPABILITY_UNAVAILABLE' 'Source promotion is verified only on local NTFS.' }
  if (@($RequestData.readSet).Count -lt 1 -or @($RequestData.readSet).Count -gt 500) { Fail 'INVALID_INPUT' 'Invalid source read-set.' }
  $Changes=@{}
  foreach ($Change in $RequestData.changes) {
    $Key=([string]$Change.path).ToLowerInvariant()
    if ($Changes.ContainsKey($Key)) { Fail 'INVALID_INPUT' 'Duplicate changed source.' }
    $Bytes=[Convert]::FromBase64String([string]$Change.base64)
    if ($Bytes.Length -gt 4194304) { Fail 'INVALID_INPUT' 'Changed source exceeds limit.' }
    $Hasher=[Security.Cryptography.SHA256]::Create()
    try { $Digest=[BitConverter]::ToString($Hasher.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant() } finally { $Hasher.Dispose() }
    if ($Digest -ne [string]$Change.hash) { Fail 'CANDIDATE_HASH_MISMATCH' 'Candidate bytes differ from their hash.' }
    $Changes[$Key]=@{ bytes=$Bytes; hash=$Digest; beforeHash=[string]$Change.beforeHash }
  }
  $Total=0; $Hashes=@{}
  foreach ($Item in @($RequestData.readSet | Sort-Object path)) {
    $Relative=[string]$Item.path; $Target=Safe-Path $Root $Relative
    if ($Streams.ContainsKey($Relative)) { Fail 'INVALID_INPUT' 'Duplicate read-set source.' }
    $Access=if ($Changes.ContainsKey($Relative.ToLowerInvariant())) { [IO.FileAccess]::ReadWrite } else { [IO.FileAccess]::Read }
    try { $Stream=New-Object IO.FileStream($Target,[IO.FileMode]::Open,$Access,[IO.FileShare]::None) }
    catch {
      $OpenFailure=$_.Exception.GetBaseException(); $NativeCode=$OpenFailure.HResult -band 0xffff
      if ($OpenFailure -is [UnauthorizedAccessException] -or $NativeCode -eq 5) { Fail 'PERMISSION_DENIED' 'Access to a project source file was denied. Check its read-only setting or folder permissions; the workbench will not override them.' }
      if ($NativeCode -in @(32,33)) { Fail 'SOURCE_BUSY' 'A source file is open or locked by another process. Close that file and retry with a fresh confirmation.' }
      if ($OpenFailure -is [IO.FileNotFoundException] -or $OpenFailure -is [IO.DirectoryNotFoundException]) { Fail 'VERSION_CONFLICT' 'A compiled source file moved or disappeared before source promotion.' }
      Fail 'SOURCE_WRITE_FAILED' 'A source file could not be opened safely. No source changes were started.'
    }
    $Streams.Add($Relative,$Stream)
    $Final=[PaperWriterNative]::FinalPath($Stream.SafeFileHandle.DangerousGetHandle())
    if (-not $Final.Equals($Target,[StringComparison]::OrdinalIgnoreCase)) { Fail 'PERMISSION_DENIED' 'Opened handle path differs from authorized input.' }
    if ([PaperWriterNative]::Links($Stream.SafeFileHandle.DangerousGetHandle()) -ne 1) { Fail 'PERMISSION_DENIED' 'Hard-linked project files cannot be promoted.' }
    $Total+=$Stream.Length
    if ($Stream.Length -gt 4194304 -or $Total -gt 33554432) { Fail 'INVALID_INPUT' 'Project read-set exceeds size limits.' }
    $Digest=File-Hash $Stream
    if ($Digest -ne [string]$Item.hash) { Fail 'VERSION_CONFLICT' 'A compiled source dependency changed.' }
    $Hashes[$Relative]=$Digest
    if ($Changes.ContainsKey($Relative.ToLowerInvariant()) -and $Changes[$Relative.ToLowerInvariant()].beforeHash -ne $Digest) { Fail 'VERSION_CONFLICT' 'Changed source differs from reviewed baseline.' }
  }
  foreach ($Key in $Changes.Keys) { if (-not $Streams.ContainsKey($Key)) { Fail 'PERMISSION_DENIED' 'Candidate is outside the compiled read-set.' } }
  Send-Event @{ phase='locked'; hashes=$Hashes; mechanism='Windows FileShare.None'; filesystem='NTFS' }
  $Decision=[Console]::ReadLine()
  if ($Decision -ne 'commit') { Send-Event @{ phase='aborted'; writtenCount=0 }; exit 0 }
  foreach ($Item in @($RequestData.readSet | Sort-Object path)) {
    $Relative=[string]$Item.path; $Key=$Relative.ToLowerInvariant()
    if (-not $Changes.ContainsKey($Key)) { continue }
    $Stream=$Streams[$Relative]; $Bytes=$Changes[$Key].bytes
    $Stream.Position=0; $Stream.Write($Bytes,0,$Bytes.Length); $Stream.SetLength($Bytes.Length); $Stream.Flush($true)
    if ((File-Hash $Stream) -ne $Changes[$Key].hash) { Fail 'SOURCE_WRITE_FAILED' 'Source bytes did not verify after durable write.' }
    $Written++
    Send-Event @{ phase='written'; path=$Relative; hash=$Changes[$Key].hash; writtenCount=$Written }
    if ([Console]::ReadLine() -ne 'continue') { Fail 'PARTIAL_COMMIT_RECOVERY_REQUIRED' 'Coordinator stopped during source promotion.' }
  }
  Send-Event @{ phase='applied'; writtenCount=$Written; mechanism='Windows FileShare.None'; filesystem='NTFS' }
} catch {
  $Code=if ($_.Exception.Data['code']) { [string]$_.Exception.Data['code'] } elseif ($Written -gt 0) { 'PARTIAL_COMMIT_RECOVERY_REQUIRED' } else { 'SOURCE_WRITE_FAILED' }
  Send-Event @{ phase='error'; code=$Code; message=$_.Exception.Message; writtenCount=$Written }
  exit 1
} finally { foreach ($Stream in $Streams.Values) { $Stream.Dispose() } }
