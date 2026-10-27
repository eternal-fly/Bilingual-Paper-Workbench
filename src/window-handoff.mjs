import {spawn} from 'node:child_process';
import {lstat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const fail=code=>Object.assign(new Error(code==='PROJECT_WINDOW_ALREADY_OPEN'?'This paper already has an open workbench window.':'The project window could not confirm its handoff. The current window is preserved.'),{code});
function session(value){if(typeof value!=='string')throw fail('PAPER_WINDOW_URL_INVALID');let u;try{u=new URL(value);}catch{throw fail('PAPER_WINDOW_URL_INVALID');}if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.pathname!=='/'||u.search||u.username||u.password||!/^#session=[A-Za-z0-9_-]{43}$/u.test(u.hash)||value.length>2048)throw fail('PAPER_WINDOW_URL_INVALID');return u.href;}
async function runWindowHandoff({fromUrl,toUrl,handoffId,mode,dataRoot,powershell=process.env.PAPER_EDITOR_POWERSHELL||'pwsh.exe',helperPath=path.join(root,'scripts/reassign-window.ps1'),spawnAdapter=spawn}={}){
 const from=session(fromUrl),to=session(toUrl);
 if(typeof dataRoot!=='string'||!path.isAbsolute(dataRoot)||/[\u0000-\u001f]/u.test(dataRoot))throw fail('PAPER_WINDOW_DATA_INVALID');
 if(typeof handoffId!=='string'||!/^[a-f0-9]{48}$/u.test(handoffId)||!['complete','reserve','cancel'].includes(mode))throw fail('PAPER_WINDOW_RECOVERY_REQUIRED');
 const info=await lstat(helperPath);if(!info.isFile()||info.isSymbolicLink())throw fail('PAPER_WINDOW_RECOVERY_REQUIRED');
 return new Promise((resolve,reject)=>{
  let settled=false,output='';const child=spawnAdapter(powershell,['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',helperPath,'-DataRoot',dataRoot],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){if(child.exitCode===null)child.kill();reject(error);}else resolve(value);};
  const timer=setTimeout(()=>finish(fail('PAPER_WINDOW_OPEN_PENDING')),15000);
  child.stdout?.on('data',bytes=>{output+=bytes.toString('utf8');if(Buffer.byteLength(output)>4096)finish(fail('PAPER_WINDOW_RECOVERY_REQUIRED'));});child.stderr?.on('data',()=>{});
  child.on('error',()=>finish(fail('PAPER_WINDOW_RECOVERY_REQUIRED')));
  child.on('close',code=>{let result;try{result=JSON.parse(output.trim());}catch{return finish(fail('PAPER_WINDOW_RECOVERY_REQUIRED'));}if(code!==0){const error=/^(?:PROJECT_WINDOW_ALREADY_OPEN|PAPER_WINDOW_(?:URL_INVALID|DATA_INVALID|OPEN_PENDING|IDENTITY_CHANGED|RECOVERY_REQUIRED))$/u.test(result.error)?result.error:'PAPER_WINDOW_RECOVERY_REQUIRED';return finish(fail(error));}if(typeof result.reassigned!=='boolean'||Object.keys(result).some(k=>!['reassigned','reason'].includes(k))||result.reason!==undefined&&!['not-registered','same-session','reserved','cancelled'].includes(result.reason))return finish(fail('PAPER_WINDOW_RECOVERY_REQUIRED'));finish(null,result);});
  child.stdin?.on('error',()=>finish(fail('PAPER_WINDOW_RECOVERY_REQUIRED')));child.stdin.end(JSON.stringify({fromUrl:from,toUrl:to,handoffId,mode})+'\n');
 });
}
export const reassignPaperWindow=options=>runWindowHandoff({...options,mode:'complete'});
export const reservePaperWindowHandoff=options=>runWindowHandoff({...options,mode:'reserve'});
export const cancelPaperWindowHandoff=options=>runWindowHandoff({...options,mode:'cancel'});
