[CmdletBinding()]
param([switch]$NoOpen)
# Preserve the original entrypoint while using the full independent workbench.
& (Join-Path $PSScriptRoot 'launch-workbench.ps1') -NoOpen:$NoOpen
exit $LASTEXITCODE
