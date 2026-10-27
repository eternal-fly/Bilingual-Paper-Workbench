import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const harness=String.raw`
$ErrorActionPreference='Stop'
. $env:PAPER_WINDOW_OPENER
$global:PaperFakeWindows=@{};$global:PaperStarts=0;$global:PaperShows=0
function Get-PaperScreenWorkArea { @{WorkWidth=1920;WorkHeight=1200} }
function Start-Process {
 param($FilePath,$WindowStyle,$ArgumentList,$ErrorAction)
 $global:PaperStarts++;$key=[long](100+$global:PaperStarts)
 $global:PaperFakeWindows[$key]=@{handle=$key;processId=$PID;startTicks=1L;title='Bilingual Paper Workbench';nonce=0}
}
function Get-PaperBrowserWindows { param($Browser,$Profile) @($global:PaperFakeWindows.Values) }
function Test-PaperRecordedWindow { param($Record,$PropertyName,$Browser)
 $w=$global:PaperFakeWindows[[long]$Record.window.handle]
 if(-not $w){return 'closed'}
 if($w.propertyName -ceq $PropertyName -and $w.nonce -eq $Record.nonce){return 'valid'}
 return 'foreign'
}
function Set-PaperWindowMarker { param($Window,$PropertyName,$Nonce,$Browser)
 $global:PaperFakeWindows[[long]$Window.handle].nonce=$Nonce;$global:PaperFakeWindows[[long]$Window.handle].propertyName=$PropertyName;return $true
}
function Get-PaperWindowMarker { param($Window,$PropertyName) $w=$global:PaperFakeWindows[[long]$Window.handle];if($w.propertyName -ceq $PropertyName){return $w.nonce};return 0 }
function Show-PaperRecordedWindow { param($Record,$PropertyName,$Browser) $global:PaperShows++ }
$url='http://127.0.0.1:12345/#session='+('x'*43)
$first=Open-PaperWindow -Url $url -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER
$second=Open-PaperWindow -Url $url -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER
@{first=$first;second=$second;starts=$global:PaperStarts;shows=$global:PaperShows} | ConvertTo-Json -Depth 8 -Compress
`;
async function run(t,actions){
 await mkdir(path.join(root,'work'),{recursive:true});const data=await mkdtemp(path.join(root,'work/window-registry-'));t.after(()=>rm(data,{recursive:true,force:true}));
 const result=spawnSync(process.env.PAPER_EDITOR_POWERSHELL||'pwsh',['-NoLogo','-NoProfile','-NonInteractive','-Command',actions===undefined?harness:harness.slice(0,harness.indexOf('$first='))+actions],{cwd:root,env:{...process.env,PAPER_WINDOW_OPENER:path.join(root,'scripts/open-window.ps1'),PAPER_WINDOW_DATA:data,PAPER_WINDOW_BROWSER:process.execPath},encoding:'utf8',windowsHide:true,timeout:20000});
 assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
test('the actual opener reuses a live exact-session window instead of starting another browser',async t=>{
 const output=await run(t);assert.equal(output.starts,1);assert.equal(output.second.reusedWindow,true);assert.equal(output.first.reusedWindow,false);assert.equal(output.shows,1);
});
test('closing the exact owned window permits one replacement and leaves unrelated windows alone',async t=>{
 const o=await run(t,String.raw`
$first=Open-PaperWindow -Url $url -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER
$global:PaperFakeWindows.Remove(101L)
$global:PaperFakeWindows[999L]=@{handle=999L;processId=$PID;startTicks=1L;title='Bilingual Paper Workbench';nonce=0}
$second=Open-PaperWindow -Url $url -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER
@{starts=$global:PaperStarts;shows=$global:PaperShows;second=$second;unrelatedNonce=$global:PaperFakeWindows[999L].nonce}|ConvertTo-Json -Depth 8 -Compress
`);assert.equal(o.starts,2);assert.equal(o.second.reusedWindow,false);assert.equal(o.shows,0);assert.equal(o.unrelatedNonce,0);
});
test('two exact sessions have different windows while repeated calls reuse their own window',async t=>{
 const o=await run(t,String.raw`
$a=Open-PaperWindow -Url $url -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER
$other='http://127.0.0.1:12345/#session='+('y'*43)
$b=Open-PaperWindow -Url $other -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER
$again=Open-PaperWindow -Url $url -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER
$records=Get-ChildItem -LiteralPath (Join-Path $env:PAPER_WINDOW_DATA 'window-registry') -Filter '*.json'
$content=($records|ForEach-Object{Get-Content -LiteralPath $_.FullName -Raw}) -join ''
@{starts=$global:PaperStarts;shows=$global:PaperShows;again=$again;records=$records.Count;capabilityRetained=$content.Contains('#session=')}|ConvertTo-Json -Depth 8 -Compress
`);assert.equal(o.starts,2);assert.equal(o.shows,1);assert.equal(o.records,2);assert.equal(o.again.reusedWindow,true);assert.equal(o.capabilityRetained,false);
});
test('a live handle with a missing ownership nonce fails closed instead of focusing or opening a duplicate',async t=>{
 const o=await run(t,String.raw`
$a=Open-PaperWindow -Url $url -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER
$global:PaperFakeWindows[101L].nonce=-1
$errorCode='';try{Open-PaperWindow -Url $url -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER | Out-Null}catch{$errorCode=$_.Exception.Message.Split(':')[0]}
@{starts=$global:PaperStarts;shows=$global:PaperShows;code=$errorCode}|ConvertTo-Json -Compress
`);assert.equal(o.code,'PAPER_WINDOW_IDENTITY_CHANGED');assert.equal(o.starts,1);assert.equal(o.shows,0);
});
test('an interrupted unmarked browser launch remains pending and never blindly starts a second window',async t=>{
 const o=await run(t,String.raw`
function Set-PaperWindowMarker { param($Window,$PropertyName,$Nonce,$Browser) return $false }
$codes=@();foreach($i in 1..2){try{Open-PaperWindow -Url $url -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER|Out-Null}catch{$codes+=$_.Exception.Message.Split(':')[0]}}
@{starts=$global:PaperStarts;shows=$global:PaperShows;codes=$codes}|ConvertTo-Json -Compress
`);assert.equal(o.starts,1);assert.deepEqual(o.codes,['PAPER_WINDOW_RECOVERY_REQUIRED','PAPER_WINDOW_RECOVERY_REQUIRED']);assert.equal(o.shows,0);
});
test('malformed private window records do not erase an existing live window or create a replacement',async t=>{
 const o=await run(t,String.raw`
$a=Open-PaperWindow -Url $url -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER
$filename=(Get-ChildItem -LiteralPath (Join-Path $env:PAPER_WINDOW_DATA 'window-registry') -Filter '*.json').FullName
$record=Get-Content -LiteralPath $filename -Raw|ConvertFrom-Json -AsHashtable;$record.window.handle='not-a-handle';$record|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $filename
$code='';try{Open-PaperWindow -Url $url -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER|Out-Null}catch{$code=$_.Exception.Message.Split(':')[0]}
@{starts=$global:PaperStarts;shows=$global:PaperShows;code=$code}|ConvertTo-Json -Compress
`);assert.equal(o.code,'PAPER_WINDOW_RECOVERY_REQUIRED');assert.equal(o.starts,1);assert.equal(o.shows,0);
});
test('a proven failure before process creation permits a safe later retry',async t=>{
 const o=await run(t,String.raw`
$global:FailedOnce=$false
function Start-Process {
 param($FilePath,$WindowStyle,$ArgumentList,$ErrorAction)
 if(-not $global:FailedOnce){$global:FailedOnce=$true;throw [ComponentModel.Win32Exception]::new(2)}
 $global:PaperStarts++;$key=[long](100+$global:PaperStarts)
 $global:PaperFakeWindows[$key]=@{handle=$key;processId=$PID;startTicks=1L;title='Bilingual Paper Workbench';nonce=0}
}
$code='';try{Open-PaperWindow -Url $url -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER|Out-Null}catch{$code=$_.Exception.Message.Split(':')[0]}
$again=Open-PaperWindow -Url $url -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER
@{starts=$global:PaperStarts;again=$again;firstCode=$code}|ConvertTo-Json -Depth 8 -Compress
`);assert.equal(o.starts,1);assert.equal(o.again.reusedWindow,false);
});
test('a late window from a confirmed pending launch is marked and reused without another process',async t=>{
 const o=await run(t,String.raw`
$first=Open-PaperWindow -Url $url -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER
$filename=(Get-ChildItem -LiteralPath (Join-Path $env:PAPER_WINDOW_DATA 'window-registry') -Filter '*.json').FullName
$record=Get-Content -LiteralPath $filename -Raw|ConvertFrom-Json -AsHashtable
$record.status='opening';$record.launchConfirmed=$true;$record.beforeWindows=@();$record.Remove('window');$record.createdAt=[DateTime]::UtcNow.ToString('o')
$global:PaperFakeWindows[101L].nonce=0
$record|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $filename
$again=Open-PaperWindow -Url $url -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER
@{starts=$global:PaperStarts;again=$again;shows=$global:PaperShows}|ConvertTo-Json -Depth 8 -Compress
`);assert.equal(o.starts,1);assert.equal(o.again.reusedWindow,true);assert.equal(o.shows,1);
});

test('pending recovery never adopts a window already claimed by a different exact session',async t=>{
 const o=await run(t,String.raw`
$first=Open-PaperWindow -Url $url -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER
$filename=(Get-ChildItem -LiteralPath (Join-Path $env:PAPER_WINDOW_DATA 'window-registry') -Filter '*.json').FullName
$global:PaperFakeWindows.Remove(101L)
$other='http://127.0.0.1:12345/#session='+('y'*43)
$second=Open-PaperWindow -Url $other -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER
$otherProperty=$global:PaperFakeWindows[102L].propertyName;$otherNonce=$global:PaperFakeWindows[102L].nonce
$record=Get-Content -LiteralPath $filename -Raw|ConvertFrom-Json -AsHashtable
$record.status='opening';$record.launchConfirmed=$true;$record.beforeWindows=@();$record.Remove('window');$record.createdAt=[DateTime]::UtcNow.ToString('o')
$record|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $filename
$code='';try{Open-PaperWindow -Url $url -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER|Out-Null}catch{$code=$_.Exception.Message.Split(':')[0]}
@{code=$code;starts=$global:PaperStarts;shows=$global:PaperShows;otherPropertyUnchanged=($global:PaperFakeWindows[102L].propertyName -ceq $otherProperty);otherNonceUnchanged=($global:PaperFakeWindows[102L].nonce -eq $otherNonce)}|ConvertTo-Json -Compress
`);assert.equal(o.code,'PAPER_WINDOW_RECOVERY_REQUIRED');assert.equal(o.starts,2);assert.equal(o.shows,0);assert.equal(o.otherPropertyUnchanged,true);assert.equal(o.otherNonceUnchanged,true);
});

test('another session cannot launch while a previous profile window has unresolved ownership',async t=>{
 const o=await run(t,String.raw`
$savedMarker=(Get-Item -LiteralPath Function:Set-PaperWindowMarker).ScriptBlock
function Set-PaperWindowMarker { param($Window,$PropertyName,$Nonce,$Browser) return $false }
try{Open-PaperWindow -Url $url -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER|Out-Null}catch{}
Set-Item -LiteralPath Function:Set-PaperWindowMarker -Value $savedMarker
$other='http://127.0.0.1:12345/#session='+('y'*43)
$code='';try{Open-PaperWindow -Url $other -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER|Out-Null}catch{$code=$_.Exception.Message.Split(':')[0]}
$startsBeforeRecovery=$global:PaperStarts
$recovered=Open-PaperWindow -Url $url -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER
$second=Open-PaperWindow -Url $other -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER
@{code=$code;startsBeforeRecovery=$startsBeforeRecovery;starts=$global:PaperStarts;recovered=$recovered;second=$second}|ConvertTo-Json -Depth 8 -Compress
`);assert.equal(o.code,'PAPER_WINDOW_RECOVERY_REQUIRED');assert.equal(o.startsBeforeRecovery,1);assert.equal(o.starts,2);assert.equal(o.recovered.reusedWindow,true);assert.equal(o.second.reusedWindow,false);
});
