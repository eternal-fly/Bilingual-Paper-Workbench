[CmdletBinding()]
param([string]$OutputDirectory)
$ErrorActionPreference='Stop'
$PluginRoot=Split-Path -Parent $PSScriptRoot
if(-not $OutputDirectory){$OutputDirectory=Join-Path $PluginRoot 'work/compiler-helper'}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$Compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if(-not (Test-Path -LiteralPath $Compiler)){throw 'The built-in .NET Framework compiler is unavailable.'}
& $Compiler /nologo /target:exe /platform:anycpu /reference:System.Web.Extensions.dll (('/out:')+(Join-Path $OutputDirectory 'AppContainerBroker.exe')) (Join-Path $PluginRoot 'src/compiler/AppContainerBroker.cs')
if($LASTEXITCODE -ne 0){throw 'AppContainer broker compilation failed.'}
& $Compiler /nologo /target:exe /platform:anycpu (('/out:')+(Join-Path $OutputDirectory 'AppContainerProbe.exe')) (Join-Path $PluginRoot 'src/compiler/AppContainerProbe.cs')
if($LASTEXITCODE -ne 0){throw 'AppContainer probe compilation failed.'}
[ordered]@{ok=$true;broker=(Join-Path $OutputDirectory 'AppContainerBroker.exe')} | ConvertTo-Json -Compress
