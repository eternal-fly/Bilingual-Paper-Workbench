[CmdletBinding()]
param([string]$TeXRoot,[string]$RuntimeRoot,[string]$FontRoot)
$ErrorActionPreference='Stop'
$PluginRoot=Split-Path -Parent $PSScriptRoot
if(-not $TeXRoot){$TeXRoot=Join-Path $env:LOCALAPPDATA 'BilingualPaperEditor/compiler-tinytex-fast-2026.10/TinyTeX'}
if(-not $RuntimeRoot){$RuntimeRoot=Join-Path $env:LOCALAPPDATA 'BilingualPaperEditor/compiler/runtime64'}
if(-not $FontRoot){$FontRoot=Join-Path $env:LOCALAPPDATA 'BilingualPaperEditor/fonts/bundle'}
$RuntimeRoot=[IO.Path]::GetFullPath($RuntimeRoot)
$TeXRoot=(Resolve-Path -LiteralPath $TeXRoot).Path
$AllowedFiles=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach($Name in @('runtime-receipt.json','compiler-public-assets.json','broker/AppContainerBroker.exe','broker/AppContainerProbe.exe')){[void]$AllowedFiles.Add($Name)}
if($RuntimeRoot.StartsWith($TeXRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Worker runtime must be outside the source TeX installation.'}
New-Item -ItemType Directory -Path (Join-Path $RuntimeRoot 'bin') -Force | Out-Null
$BinRoot=Join-Path $TeXRoot 'bin/windows'
if(-not(Test-Path -LiteralPath $BinRoot)){$BinRoot=Join-Path $TeXRoot 'bin/win32'}
foreach($Name in @('xelatex.exe','pdflatex.exe','xdvipdfmx.exe','bibtex.exe')){Copy-Item -LiteralPath (Join-Path $BinRoot $Name) -Destination (Join-Path $RuntimeRoot ('bin/'+$Name)) -Force;[void]$AllowedFiles.Add('bin/'+$Name)}
if(Test-Path -LiteralPath (Join-Path $BinRoot 'synctex.exe')){Copy-Item -LiteralPath (Join-Path $BinRoot 'synctex.exe') -Destination (Join-Path $RuntimeRoot 'bin/synctex.exe') -Force;[void]$AllowedFiles.Add('bin/synctex.exe')}
Get-ChildItem -LiteralPath $BinRoot -Filter '*.dll' -File | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $RuntimeRoot 'bin') -Force;[void]$AllowedFiles.Add('bin/'+$_.Name)}
$Trees=@('texmf-dist/tex/latex','texmf-dist/tex/generic','texmf-dist/tex/plain','texmf-dist/tex/xelatex','texmf-dist/fonts/tfm','texmf-dist/fonts/vf','texmf-dist/fonts/enc','texmf-dist/fonts/map','texmf-dist/fonts/type1','texmf-dist/fonts/opentype','texmf-dist/fonts/misc','texmf-dist/bibtex/bst','texmf-dist/dvipdfmx','texmf-dist/web2c','texmf-var/web2c/xetex','texmf-var/web2c/pdftex','texmf-var/fonts/map')
foreach($Tree in $Trees){
    $Source=Join-Path $TeXRoot $Tree
    if(-not(Test-Path -LiteralPath $Source)){continue}
    $Destination=Join-Path $RuntimeRoot $Tree
    foreach($File in (Get-ChildItem -LiteralPath $Source -Recurse -File)){[void]$AllowedFiles.Add($File.FullName.Substring($TeXRoot.Length+1).Replace('\','/'))}
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    & robocopy.exe $Source $Destination /E /COPY:DAT /DCOPY:DAT /R:0 /W:0 /NFL /NDL /NJH /NJS /NP | Out-Null
    if($LASTEXITCODE -ge 8){throw "Runtime copy failed: $Tree"}
}
New-Item -ItemType Directory -Path (Join-Path $RuntimeRoot 'fonts') -Force | Out-Null
foreach($Name in @('NotoSerifCJKsc-Regular.otf','NotoSerifCJKsc-Bold.otf','NotoSansCJKsc-Regular.otf','ukai.ttc')){
    Copy-Item -LiteralPath (Join-Path $FontRoot $Name) -Destination (Join-Path $RuntimeRoot ('fonts/'+$Name)) -Force
    [void]$AllowedFiles.Add('fonts/'+$Name)
}
& (Join-Path $PSScriptRoot 'compiler-build.ps1') -OutputDirectory (Join-Path $RuntimeRoot 'broker') | Out-Null
if($LASTEXITCODE -ne 0){throw 'Worker broker build failed.'}
$SourceVersion=if(Test-Path -LiteralPath (Join-Path $TeXRoot 'release-texlive.txt')){(Get-Content -LiteralPath (Join-Path $TeXRoot 'release-texlive.txt') -TotalCount 1)}else{'TeX Live private copy'}
$Receipt=[ordered]@{schemaVersion=1;runtimeRoot=$RuntimeRoot;preparedAt=[DateTime]::UtcNow.ToString('o');sourceVersion=$SourceVersion;sourceAclModified=$false;networkCapabilities=0;engines=@('xelatex','pdflatex');broker='broker/AppContainerBroker.exe';fontSourceCopied=$true}
$Receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $RuntimeRoot 'runtime-receipt.json') -Encoding utf8NoBOM
$Inventory=[Collections.Generic.List[object]]::new()
foreach($File in (Get-ChildItem -LiteralPath $RuntimeRoot -Recurse -File)){
    $Relative=$File.FullName.Substring($RuntimeRoot.Length+1).Replace('\','/')
    if(-not $AllowedFiles.Contains($Relative)){throw "Unexpected file in public runtime; no broad read permission was granted: $Relative"}
    if(($File.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){throw 'Public runtime cannot contain reparse files.'}
    $Inventory.Add(@{path=$Relative;size=$File.Length})
}
@{schemaVersion=1;scope='public-assets-only';containsPrivateInputs=$false;containsSecrets=$false;fileCount=$Inventory.Count;files=$Inventory} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $RuntimeRoot 'compiler-public-assets.json') -Encoding utf8NoBOM
$PublicSid=[Security.Principal.SecurityIdentifier]::new('S-1-15-2-1')
$Security=Get-Acl -LiteralPath $RuntimeRoot
$Security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($PublicSid,[Security.AccessControl.FileSystemRights]::ReadAndExecute,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
Set-Acl -LiteralPath $RuntimeRoot -AclObject $Security
$AddedRules=(Get-Acl -LiteralPath $RuntimeRoot).Access | Where-Object {$_.IdentityReference.Value -eq $PublicSid.Value -or $_.IdentityReference.Value -eq 'APPLICATION PACKAGE AUTHORITY\ALL APPLICATION PACKAGES'}
foreach($Rule in $AddedRules){if(($Rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write)-ne 0 -or ($Rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Delete)-ne 0){throw 'Public runtime permission unexpectedly includes writes.'}}
$Receipt | ConvertTo-Json -Depth 5 -Compress
