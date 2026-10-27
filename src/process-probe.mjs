import { spawn } from 'node:child_process';

const validPid = pid => Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647;
// The PID is read from stdin, never interpolated into this fixed read-only code.
const WINDOWS_PROBE = String.raw`$ErrorActionPreference='Stop'
$RequestedText=[Console]::ReadLine()
$RequestedProcessId=0
if(-not $RequestedText -or $RequestedText -cnotmatch '^[0-9]{1,10}$' -or -not [int]::TryParse($RequestedText,[ref]$RequestedProcessId) -or $RequestedProcessId -lt 1){exit 2}
$Result=@{pid=$RequestedProcessId;status='unknown';proof='unavailable'}
$ObservedProcess=$null
try{
  $ObservedProcess=Get-Process -Id $RequestedProcessId -ErrorAction Stop
  if($ObservedProcess.Id -eq $RequestedProcessId){
    try{
      if($ObservedProcess.HasExited -eq $true){$Result.status='dead';$Result.proof='has-exited'}
      else{$Result.status='alive';$Result.proof='present'}
    }catch{}
  }
}catch{
  if($_.FullyQualifiedErrorId -ceq 'NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand'){$Result.status='dead';$Result.proof='not-found'}
}finally{if($ObservedProcess){$ObservedProcess.Dispose()}}
[Console]::WriteLine(($Result|ConvertTo-Json -Compress))`;

/** Only affirmative OS evidence may retire a stale queue-control lock. */
export async function isProcessProvenDead(pid, { platform = process.platform, currentPid = process.pid, kill = process.kill.bind(process), powershell = process.env.PAPER_EDITOR_POWERSHELL || 'pwsh.exe', spawnAdapter = spawn, timeoutMs = 2500 } = {}) {
  if (!validPid(pid) || pid === currentPid || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) return false;
  try { kill(pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; if (platform !== 'win32' || error.code !== 'EPERM') return false; }
  return new Promise(resolve => {
    let child, timer, settled = false, output = '', length = 0, errorOutput = false;
    const finish = (value, terminate = false) => { if (settled) return; settled = true; clearTimeout(timer); if (terminate && child?.exitCode === null) { try { child.kill(); } catch {} } resolve(value); };
    try { child = spawnAdapter(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WINDOWS_PROBE], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { finish(false); return; }
    timer = setTimeout(() => finish(false, true), timeoutMs);
    child.stdout?.on('data', bytes => { length += bytes.length; if (length > 2048) finish(false, true); else output += bytes.toString('utf8'); });
    child.stderr?.on('data', bytes => { errorOutput ||= bytes.length > 0; length += bytes.length; if (length > 2048) finish(false, true); });
    child.on('error', () => finish(false));
    child.on('close', code => {
      if (code !== 0 || errorOutput) { finish(false); return; }
      let result; try { result = JSON.parse(output.trim()); } catch { finish(false); return; }
      finish(Boolean(result && !Array.isArray(result) && Object.keys(result).length === 3 && Object.keys(result).every(key => ['pid', 'status', 'proof'].includes(key)) && result.pid === pid && result.status === 'dead' && ['not-found', 'has-exited'].includes(result.proof)));
    });
    child.stdin?.on('error', () => finish(false, true));
    try { child.stdin.end(String(pid) + '\n'); } catch { finish(false, true); }
  });
}
