[CmdletBinding()]
param([string]$FontRoot, [string]$TexBin)
$ErrorActionPreference = 'Stop'
if (-not $FontRoot) { $FontRoot = Join-Path $env:LOCALAPPDATA 'BilingualPaperEditor/fonts' }
if (-not $TexBin) { $TexBin = Split-Path -Parent (Get-Command xelatex -ErrorAction Stop).Source }
$Configuration = Join-Path $FontRoot 'fonts.conf'
if (-not (Test-Path -LiteralPath $Configuration -PathType Leaf)) { throw 'Run fonts-install.ps1 first.' }
$Smoke = Join-Path $FontRoot ('smoke-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Smoke | Out-Null
$Source = @'
\documentclass{article}
\usepackage{fontspec,xeCJK}
\setmainfont{lmroman10-regular.otf}[BoldFont=lmroman10-bold.otf,ItalicFont=lmroman10-italic.otf,BoldItalicFont=lmroman10-bolditalic.otf]
\setCJKmainfont{Noto Serif CJK SC}[BoldFont={Noto Serif CJK SC Bold},ItalicFont={AR PL UKai CN}]
\setCJKsansfont{Noto Sans CJK SC}
\setCJKmonofont{Noto Sans CJK SC}
\begin{document}
Synthetic font verification. This fixture contains no manuscript text.

中文正体。\textbf{中文粗体。}\textit{中文楷体。}

{\sffamily 中文无衬线。} {\ttfamily 中文等宽请求。}

Regular Latin. \textbf{Bold Latin.} \textit{Italic Latin.} \textbf{\textit{Bold Italic Latin.}}
\end{document}
'@
$Main = Join-Path $Smoke 'font-smoke.tex'
$Source | Set-Content -LiteralPath $Main -Encoding utf8NoBOM
$PreviousConfig = $env:FONTCONFIG_FILE
$PreviousPath = $env:FONTCONFIG_PATH
$PreviousTexOut = $env:TEXMFOUTPUT
try {
    $env:FONTCONFIG_FILE = $Configuration
    $env:FONTCONFIG_PATH = $FontRoot
    $env:TEXMFOUTPUT = $Smoke
    & (Join-Path $TexBin 'xelatex.exe') '-no-shell-escape' '-interaction=batchmode' '-halt-on-error' ('-output-directory=' + $Smoke) $Main
    $Exit = $LASTEXITCODE
    if ($Exit -ne 0) { throw "Synthetic font compilation failed with exit $Exit; inspect only the retained synthetic log." }
    $Pdf = Join-Path $Smoke 'font-smoke.pdf'
    if (-not (Test-Path -LiteralPath $Pdf -PathType Leaf)) { throw 'Synthetic font compilation produced no PDF.' }
    @{ ok = $true; syntheticOnly = $true; isolatedCompilerClaim = $false; pdf = $Pdf; pdfBytes = (Get-Item -LiteralPath $Pdf).Length; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Pdf).Hash.ToLowerInvariant() } | ConvertTo-Json -Compress
} finally {
    $env:FONTCONFIG_FILE = $PreviousConfig
    $env:FONTCONFIG_PATH = $PreviousPath
    $env:TEXMFOUTPUT = $PreviousTexOut
}
