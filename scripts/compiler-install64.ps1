[CmdletBinding()]
param([string]$RuntimeRoot,[switch]$Offline)
$ErrorActionPreference='Stop'
$PluginRoot=Split-Path -Parent $PSScriptRoot
$PrivateRoot=Join-Path $env:LOCALAPPDATA 'BilingualPaperEditor'
$Downloads=Join-Path $PrivateRoot 'compiler-downloads'
$Extracted=Join-Path $PrivateRoot 'compiler-tinytex-fast-2026.10'
$TinyRoot=Join-Path $Extracted 'TinyTeX'
New-Item -ItemType Directory -Path $Downloads -Force | Out-Null
function FetchVerified([string]$Name,[string]$Uri,[string]$Algorithm,[string]$Digest){
    $Target=Join-Path $Downloads $Name
    if(-not(Test-Path -LiteralPath $Target)){
        if($Offline){throw "Missing offline compiler asset: $Name"}
        $ProgressPreference='SilentlyContinue';Invoke-WebRequest -Uri $Uri -OutFile $Target
    }
    if((Get-FileHash -LiteralPath $Target -Algorithm $Algorithm).Hash -ne $Digest){throw "Publisher checksum mismatch: $Name"}
    return $Target
}
function ExtractBounded([string]$Archive,[string]$Destination){
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $Entries=& tar.exe -tf $Archive
    if($LASTEXITCODE -ne 0){throw 'Archive inventory failed.'}
    foreach($Entry in $Entries){if($Entry.StartsWith('/')-or $Entry -match '(^|/)\.\.(/|$)'-or $Entry -match '^[A-Za-z]:'){throw 'Archive path escape rejected.'}}
    & tar.exe -xf $Archive -C $Destination
    if($LASTEXITCODE -ne 0){throw 'Archive extraction failed.'}
}
$Archive=FetchVerified 'TinyTeX-v2026.10.zip' 'https://github.com/rstudio/tinytex-releases/releases/download/v2026.10/TinyTeX-v2026.10.zip' SHA256 'dc1d6e63b21af62130ede1dcc4113bffdc184544690a23e3f489d75340f4ff61'
if(-not(Test-Path -LiteralPath (Join-Path $TinyRoot 'texmf-var/web2c/xetex/xelatex.fmt'))){ExtractBounded $Archive $Extracted}
$Packages=@(
  @{name='revtex';revision=67271;sha512='3c0c008929457a405cabd699a6bdbb0c4ad2afde1c7155b163c52e9564f15718bddec782abfb6336e55c77ba1d0d0d88a1da39420ed1116f21efc1e4c93d4751';destination='texmf-dist'},
  @{name='xecjk';revision=80059;sha512='40e4c9c5f2195021cde4859da7b137de0cdf0c96b83f7ddbf724c682e1dd07276cb83bf4004b2b7cb5f90b6033da54940b3c58aeb2ca231b9ce449ee32d3a3d8';destination='texmf-dist'},
  @{name='ctex';revision=79993;sha512='79364716f5edaafe18185b6bd22a66b81bd8bfc8b6e9061496f0844a3ba6bb73dc8534ff7391b2736f5f12c44ffb241e1a7cf3a92656674dff3961284eb114a2';destination='texmf-dist'},
  @{name='synctex.windows';revision=78097;sha512='f483491e431e8209776ab8cd3b513d028847d4c16907c0175a97d49cd75b36ffdeb3c59af906efdac36fa1dfec90cc0ab2b11214f9b088395c542c9ab6a0a657';destination='.'}
)
foreach($Package in $Packages){
    $File=FetchVerified ($Package.name+'.tar.xz') ('https://tug.ctan.org/systems/texlive/tlnet/archive/'+$Package.name+'.tar.xz') SHA512 $Package.sha512
    ExtractBounded $File (Join-Path $TinyRoot $Package.destination)
}
& (Join-Path $PSScriptRoot 'compiler-prepare.ps1') -TeXRoot $TinyRoot -RuntimeRoot $RuntimeRoot
if($LASTEXITCODE -ne 0){throw 'Private compiler runtime preparation failed.'}
@{schemaVersion=1;tinytex='v2026.10';sha256='dc1d6e63b21af62130ede1dcc4113bffdc184544690a23e3f489d75340f4ff61';packages=$Packages;source='official release assets and TeX Live package database';systemPathChanged=$false;systemAclChanged=$false} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $PrivateRoot 'compiler-install-receipt.json') -Encoding utf8NoBOM
