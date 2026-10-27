import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {reassignPaperWindow} from '../src/window-handoff.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const harness=String.raw`
$ErrorActionPreference='Stop';. $env:PAPER_WINDOW_REGISTRY
$global:markers=@{};$global:alive=@{101=$true;202=$true}
function Test-PaperRecordedWindow {param($Record,$PropertyName,$Browser) if(-not $global:alive[[int]$Record.window.handle]){return 'closed'};if($global:markers[([string]$Record.window.handle+'|'+$PropertyName)] -eq $Record.nonce){return 'valid'};return 'foreign'}
function Set-PaperWindowMarker {param($Window,$PropertyName,$Nonce,$Browser) $global:markers[([string]$Window.handle+'|'+$PropertyName)]=$Nonce;return $true}
function Remove-PaperWindowMarker {param($Window,$PropertyName) $global:markers.Remove(([string]$Window.handle+'|'+$PropertyName))}
$from='http://127.0.0.1:12345/#session='+('a'*43);$to='http://127.0.0.1:12346/#session='+('b'*43)
$handoff='c'*48
$a=Get-PaperWindowHash $from;$b=Get-PaperWindowHash $to;$profile=Join-Path $env:PAPER_WINDOW_DATA 'standalone-browser'
$directory=Join-Path $env:PAPER_WINDOW_DATA 'window-registry';New-Item -ItemType Directory -Path $directory|Out-Null
$record=@{schemaVersion=1;key=$a;profileHash=(Get-PaperWindowHash $profile.ToLowerInvariant());browser=$env:PAPER_WINDOW_BROWSER;nonce=1234;status='ready';window=@{handle=101;processId=$PID;startTicks=1}}
Write-PaperWindowRecord -Filename (Join-Path $directory ($a+'.json')) -Record $record
$global:markers[('101|BilingualPaperEditor.Window.'+$a)]=1234
`;
async function run(t,body){await mkdir(path.join(root,'work'),{recursive:true});const data=await mkdtemp(path.join(root,'work/window-handoff-'));t.after(()=>rm(data,{recursive:true,force:true}));const r=spawnSync(process.env.PAPER_EDITOR_POWERSHELL||'pwsh',['-NoLogo','-NoProfile','-NonInteractive','-Command',harness+body],{cwd:root,env:{...process.env,PAPER_WINDOW_REGISTRY:path.join(root,'scripts/window-registry.ps1'),PAPER_WINDOW_DATA:data,PAPER_WINDOW_BROWSER:process.execPath},encoding:'utf8',windowsHide:true,timeout:20000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
test('project navigation transfers the exact window marker and makes later opens reuse the new session',async t=>{const r=await run(t,String.raw`
Move-PaperWindowRegistry -FromUrl $from -ToUrl $to -DataRoot $env:PAPER_WINDOW_DATA -Mode reserve -HandoffId $handoff|Out-Null
$result=Move-PaperWindowRegistry -FromUrl $from -ToUrl $to -DataRoot $env:PAPER_WINDOW_DATA -HandoffId $handoff
$target=Get-Content -LiteralPath (Join-Path $directory ($b+'.json')) -Raw|ConvertFrom-Json -AsHashtable
@{result=$result;targetState=(Test-PaperRecordedWindow $target ('BilingualPaperEditor.Window.'+$b) $target.browser);oldMarker=$global:markers[('101|BilingualPaperEditor.Window.'+$a)];handle=$target.window.handle}|ConvertTo-Json -Depth 6 -Compress
`);assert.equal(r.result.reassigned,true);assert.equal(r.targetState,'valid');assert.equal(r.handle,101);assert.equal(r.oldMarker,null);});
test('an already open target cannot claim or replace the current window',async t=>{const r=await run(t,String.raw`
$target=$record.Clone();$target.key=$b;$target.nonce=5678;$target.window=@{handle=202;processId=$PID;startTicks=1};Write-PaperWindowRecord (Join-Path $directory ($b+'.json')) $target;$global:markers[('202|BilingualPaperEditor.Window.'+$b)]=5678
try{Move-PaperWindowRegistry -FromUrl $from -ToUrl $to -DataRoot $env:PAPER_WINDOW_DATA|Out-Null;throw 'Expected rejection'}catch{if($_.Exception.Message -notmatch '^PROJECT_WINDOW_ALREADY_OPEN:'){throw}}
@{source=(Test-PaperRecordedWindow $record ('BilingualPaperEditor.Window.'+$a) $record.browser);target=(Test-PaperRecordedWindow $target ('BilingualPaperEditor.Window.'+$b) $target.browser)}|ConvertTo-Json -Compress
`);assert.equal(r.source,'valid');assert.equal(r.target,'valid');});
test('an untracked browser is not adopted and missing windows do not acquire a forged marker',async t=>{const r=await run(t,String.raw`
Remove-Item -LiteralPath (Join-Path $directory ($a+'.json'))
$result=Move-PaperWindowRegistry -FromUrl $from -ToUrl $to -DataRoot $env:PAPER_WINDOW_DATA
@{result=$result;created=(Test-Path -LiteralPath (Join-Path $directory ($b+'.json')))}|ConvertTo-Json -Depth 4 -Compress
`);assert.equal(r.result.reassigned,false);assert.equal(r.result.reason,'not-registered');assert.equal(r.created,false);});
test('failed registry publication restores the original window and cannot claim target ownership',async t=>{const r=await run(t,String.raw`
Move-PaperWindowRegistry -FromUrl $from -ToUrl $to -DataRoot $env:PAPER_WINDOW_DATA -Mode reserve -HandoffId $handoff|Out-Null
$global:SavedWrite=(Get-Item -LiteralPath Function:Write-PaperWindowRecord).ScriptBlock
function Write-PaperWindowRecord {param($Filename,$Record) if($Record.key -ceq $a -and $Record.status -eq 'not-started'){throw 'Synthetic write failure'};&$global:SavedWrite $Filename $Record}
try{Move-PaperWindowRegistry -FromUrl $from -ToUrl $to -DataRoot $env:PAPER_WINDOW_DATA -HandoffId $handoff|Out-Null;throw 'Expected rejection'}catch{if($_.Exception.Message -notmatch '^PAPER_WINDOW_RECOVERY_REQUIRED:'){throw}}
$source=Get-Content -LiteralPath (Join-Path $directory ($a+'.json')) -Raw|ConvertFrom-Json -AsHashtable
@{source=(Test-PaperRecordedWindow $source ('BilingualPaperEditor.Window.'+$a) $source.browser);targetMarker=$global:markers[('101|BilingualPaperEditor.Window.'+$b)];targetFile=(Test-Path -LiteralPath (Join-Path $directory ($b+'.json')))}|ConvertTo-Json -Compress
`);assert.equal(r.source,'valid');assert.equal(r.targetMarker,null);assert.equal(r.targetFile,true);});
test('a reserved target blocks a simultaneous normal open until arrival acknowledges or cancels',async t=>{const r=await run(t,String.raw`
$reserved=Move-PaperWindowRegistry -FromUrl $from -ToUrl $to -DataRoot $env:PAPER_WINDOW_DATA -Mode reserve -HandoffId $handoff
function Get-PaperBrowserWindows {param($Browser,$Profile) throw 'Must not discover or launch while reserved'}
try{Invoke-PaperWindowRegistry -Url $to -DataRoot $env:PAPER_WINDOW_DATA -Browser $env:PAPER_WINDOW_BROWSER -Profile $profile -Launch {throw 'Must not launch'}|Out-Null;throw 'Expected pending'}catch{if($_.Exception.Message -notmatch '^PAPER_WINDOW_OPEN_PENDING:'){throw}}
$cancelled=Move-PaperWindowRegistry -FromUrl $from -ToUrl $to -DataRoot $env:PAPER_WINDOW_DATA -Mode cancel -HandoffId $handoff
$target=Get-Content -LiteralPath (Join-Path $directory ($b+'.json')) -Raw|ConvertFrom-Json -AsHashtable
@{reserved=$reserved;cancelled=$cancelled;targetStatus=$target.status;source=(Test-PaperRecordedWindow $record ('BilingualPaperEditor.Window.'+$a) $record.browser)}|ConvertTo-Json -Depth 5 -Compress
`);assert.equal(r.reserved.reason,'reserved');assert.equal(r.cancelled.reason,'cancelled');assert.equal(r.targetStatus,'not-started');assert.equal(r.source,'valid');});
test('a different handoff nonce cannot consume or cancel a window reservation',async t=>{const r=await run(t,String.raw`
Move-PaperWindowRegistry -FromUrl $from -ToUrl $to -DataRoot $env:PAPER_WINDOW_DATA -Mode reserve -HandoffId $handoff|Out-Null
$denied=0;foreach($mode in @('complete','cancel')){try{Move-PaperWindowRegistry -FromUrl $from -ToUrl $to -DataRoot $env:PAPER_WINDOW_DATA -Mode $mode -HandoffId ('d'*48)|Out-Null}catch{if($_.Exception.Message -match '^PAPER_WINDOW_RECOVERY_REQUIRED:'){$denied++}else{throw}}}
@{denied=$denied;source=(Test-PaperRecordedWindow $record ('BilingualPaperEditor.Window.'+$a) $record.browser)}|ConvertTo-Json -Compress
`);assert.equal(r.denied,2);assert.equal(r.source,'valid');});
test('window transfer sends private URLs only through stdin and returns finite metadata',async()=>{
 const fromUrl='http://127.0.0.1:12345/#session='+'a'.repeat(43),toUrl='http://127.0.0.1:12346/#session='+'b'.repeat(43);let seen;
 const handoffId='c'.repeat(48),result=await reassignPaperWindow({fromUrl,toUrl,handoffId,dataRoot:path.join(root,'work'),spawnAdapter:(command,args,options)=>{seen={command,args,options,stdin:''};const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null,kill(){this.exitCode=1;}});child.stdin.on('data',b=>seen.stdin+=b);child.stdin.on('finish',()=>{child.stdout.write(JSON.stringify({reassigned:true}));child.exitCode=0;child.emit('close',0);});return child;}});
 assert.deepEqual(result,{reassigned:true});assert(!JSON.stringify(seen.args).includes('#session'));assert.deepEqual(JSON.parse(seen.stdin),{fromUrl,toUrl,handoffId,mode:'complete'});assert.equal(seen.options.windowsHide,true);
});
test('invalid window capabilities are rejected before a process is created',async()=>{for(const fromUrl of['https://example.com/','http://127.0.0.1:12345/?x=1#session='+'a'.repeat(43),null])await assert.rejects(reassignPaperWindow({fromUrl,toUrl:'http://127.0.0.1:12346/#session='+'b'.repeat(43),dataRoot:path.join(root,'work'),spawnAdapter:()=>{throw Error('Must not spawn');}}),{code:'PAPER_WINDOW_URL_INVALID'});});
