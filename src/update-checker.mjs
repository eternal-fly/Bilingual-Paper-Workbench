import {readFile,writeFile,mkdir,rename,stat,unlink,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import metadata from '../package.json' with {type:'json'};

export const UPDATE_REPOSITORY='https://github.com/eternal-fly/Bilingual-Paper-Workbench';
export const UPDATE_ENDPOINT='https://api.github.com/repos/eternal-fly/Bilingual-Paper-Workbench/releases/latest';
const DAY=86400000,MAX_METADATA=256*1024,MAX_CHECKSUM=64*1024;
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
const version=value=>typeof value==='string'&&/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value)&&value.split('.').every(n=>Number.isSafeInteger(Number(n)))?value:null;
const newer=(a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i];return false;};
function strict(input,allowed){if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).some(key=>!allowed.includes(key)))fail('INVALID_INPUT','Use only the registered public update options.');}
function canonicalRelease(value){
  const v=version(value?.version),tag=value?.tag;
  if(!v||![v,'v'+v].includes(tag)||value.releaseUrl!==`${UPDATE_REPOSITORY}/releases/tag/${tag}`)return null;
  const name=`Bilingual-Paper-Workbench-${v}.zip`,runtime=value.runtime;
  if(runtime?.name!==name||runtime.url!==`${UPDATE_REPOSITORY}/releases/download/${tag}/${name}`||!/^[a-f0-9]{64}$/u.test(runtime.sha256||'')||!Number.isSafeInteger(runtime.size)||runtime.size<=0)return null;
  return{version:v,tag,releaseUrl:value.releaseUrl,runtime:{name,url:runtime.url,sha256:runtime.sha256,size:runtime.size}};
}
async function boundedText(response,maximum){
  const declared=Number(response.headers.get('content-length'));if(Number.isFinite(declared)&&declared>maximum)fail('UPDATE_METADATA_INVALID','The public release metadata exceeds its size limit.');
  if(!response.body)return'';const reader=response.body.getReader(),parts=[];let size=0;
  try{for(;;){const{done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum)fail('UPDATE_METADATA_INVALID','The public release metadata exceeds its size limit.');parts.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
  return Buffer.concat(parts).toString('utf8');
}
function fileCache(file){return{
  read:async({preference=false}={})=>{const target=preference?file+'.preferences.json':file;try{const info=await stat(target);if(info.size>MAX_METADATA)throw Error('Invalid cache');return JSON.parse(await readFile(target,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}},
  write:async(value,{preference=false}={})=>{const target=preference?file+'.preferences.json':file,directory=path.dirname(target);await mkdir(directory,{recursive:true,mode:0o700});const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Invalid update cache directory');const temporary=path.join(directory,`.updates-${randomUUID()}.tmp`);try{await writeFile(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});await rename(temporary,target);}finally{await unlink(temporary).catch(()=>{});}}
};}

/** Public metadata only. No runtime code is downloaded, executed or installed. */
export class ReleaseUpdateChecker{
  constructor({currentVersion=metadata.version,fetchImpl=fetch,now=Date.now,timeoutMs=5000,cacheFile=path.join(process.env.LOCALAPPDATA||os.homedir(),'BilingualPaperEditor','updates','stable-release.json'),readCache,writeCache}={}){
    if(!version(currentVersion))throw TypeError('Use an exact installed stable version.');
    const cache=fileCache(cacheFile);Object.assign(this,{currentVersion,fetchImpl,now,timeoutMs:Math.min(10000,Math.max(20,timeoutMs)),readCache:readCache||cache.read,writeCache:writeCache||cache.write});
    this.data={schemaVersion:1,autoCheck:true,lastCheckedAt:null,status:'idle',release:null};this.loaded=null;this.pending=null;this.cacheError=null;this.cacheWriteTail=Promise.resolve();this.preferenceOverride=null;
  }
  async _load(){this.loaded ||= (async()=>{try{const value=await this.readCache();if(value){if(value.schemaVersion!==1||value.autoCheck!==undefined&&typeof value.autoCheck!=='boolean')throw Error('Invalid cache');if(typeof value.autoCheck==='boolean')this.data.autoCheck=value.autoCheck;const stamp=Date.parse(value.lastCheckedAt),release=value.release?canonicalRelease(value.release):null;if(value.release&&!release)throw Error('Invalid cache');if(Number.isFinite(stamp)&&stamp<=this.now()+300000){this.data.lastCheckedAt=new Date(stamp).toISOString();this.data.status=['available','up-to-date','offline','rate-limited','invalid-release'].includes(value.status)?value.status:'idle';this.data.release=release;}}}catch{this.cacheError={code:'UPDATE_CACHE_READ_FAILED',message:'Saved update settings could not be read. This session remains usable.'};}await this._refreshPreference();})();await this.loaded;}
  async _refreshPreference(){
    if(this.preferenceOverride){this.data.autoCheck=this.preferenceOverride.value;return true;}
    try{const value=await this.readCache({preference:true});if(this.preferenceOverride){this.data.autoCheck=this.preferenceOverride.value;return true;}if(value){if(value.schemaVersion!==1||typeof value.autoCheck!=='boolean')throw Error('Invalid preference');this.data.autoCheck=value.autoCheck;}return true;}
    catch{this.cacheError={code:'UPDATE_CACHE_READ_FAILED',message:'Saved update settings could not be read. This session remains usable.'};return false;}
  }
  _state(cached=false){const data=structuredClone(this.data);if(data.release&&!newer(data.release.version,this.currentVersion)){data.release=null;if(data.status==='available')data.status='up-to-date';}return{...data,currentVersion:this.currentVersion,cached,nextCheckAt:data.lastCheckedAt?new Date(Date.parse(data.lastCheckedAt)+DAY).toISOString():null,...(this.cacheError?{cacheError:this.cacheError}:{})};}
  async _persist(preference=false){
    // Capture at enqueue time: an older check must never write a later choice
    // out of order, or share its mutable state object with a delayed writer.
    const snapshot=preference?{schemaVersion:1,autoCheck:this.data.autoCheck}:structuredClone(this.data);if(!preference)delete snapshot.autoCheck;
    this.cacheWriteTail=this.cacheWriteTail.then(async()=>{try{await this.writeCache(snapshot,{preference});this.cacheError=null;return true;}catch{this.cacheError={code:'UPDATE_CACHE_WRITE_FAILED',message:'Update settings could not be saved. Editing is unaffected; this session still remembers your choice.'};return false;}});
    return this.cacheWriteTail;
  }
  async state(){await this._load();await this._refreshPreference();return this._state(true);}
  async configure(input){strict(input,['autoCheck']);if(typeof input.autoCheck!=='boolean')fail('INVALID_INPUT','Choose whether to check public releases automatically.');await this._load();this.data.autoCheck=input.autoCheck;const intent={value:input.autoCheck};this.preferenceOverride=intent;const persisted=await this._persist(true);if(persisted&&this.preferenceOverride===intent)this.preferenceOverride=null;return this._state(true);}
  async check(input={}){
    strict(input,['manual']);if(input.manual!==undefined&&typeof input.manual!=='boolean')fail('INVALID_INPUT','Use an explicit manual check flag.');await this._load();const preferenceKnown=await this._refreshPreference();
    if(this.pending)return this.pending;
    if(input.manual!==true&&(!preferenceKnown||!this.data.autoCheck||this.data.lastCheckedAt&&this.now()-Date.parse(this.data.lastCheckedAt)<DAY))return this._state(true);
    this.pending=this._check();try{return await this.pending;}finally{this.pending=null;}
  }
  async _fetch(url,{signal,maximum=MAX_METADATA,checksum=false}={}){
    const headers={Accept:checksum?'text/plain':'application/vnd.github+json','User-Agent':`Bilingual-Paper-Workbench-Update/${this.currentVersion}`};
    let response=await this.fetchImpl(url,{method:'GET',headers,signal,redirect:checksum?'manual':'error',credentials:'omit'});
    if(checksum&&[301,302,303,307,308].includes(response.status)){
      let destination;try{destination=new URL(response.headers.get('location'));}catch{fail('UPDATE_METADATA_INVALID','The public checksum redirect is invalid.');}
      if(destination.protocol!=='https:'||destination.hostname!=='release-assets.githubusercontent.com'||destination.port||destination.username||destination.password||destination.hash||!destination.pathname.startsWith('/github-production-release-asset/'))fail('UPDATE_METADATA_INVALID','The public checksum redirect leaves the official release asset host.');
      response=await this.fetchImpl(destination.href,{method:'GET',headers,signal,redirect:'error',credentials:'omit'});
    }
    if([403,429].includes(response.status))fail('UPDATE_RATE_LIMITED','The public release service is rate limited. Try a manual check later.');
    if(!response.ok)fail('UPDATE_NETWORK_UNAVAILABLE','The public release service is unavailable. Editing is unaffected.');
    return boundedText(response,maximum);
  }
  async _check(){
    const signal=AbortSignal.timeout(this.timeoutMs);this.data.release=null;delete this.data.error;
    try{
      const raw=JSON.parse(await this._fetch(UPDATE_ENDPOINT,{signal})),tag=raw.tag_name,v=typeof tag==='string'?version(tag.replace(/^v/u,'')):null;
      if(raw.draft!==true&&raw.prerelease!==true&&(!v||raw.draft!==false||raw.prerelease!==false))fail('UPDATE_METADATA_INVALID','The public stable release identity is incomplete or invalid.');
      if(raw.draft!==false||raw.prerelease!==false||!v||!newer(v,this.currentVersion)){this.data.status='up-to-date';}
      else{
        const name=`Bilingual-Paper-Workbench-${v}.zip`,assets=Array.isArray(raw.assets)?raw.assets:[],matches=assets.filter(asset=>asset?.name===name);
        if(matches.length!==1||raw.html_url!==`${UPDATE_REPOSITORY}/releases/tag/${tag}`)fail('UPDATE_METADATA_INVALID','The release does not identify one official stable runtime.');
        const asset=matches[0];let sha=/^sha256:([a-f0-9]{64})$/u.exec(asset.digest||'')?.[1];
        if(!sha){const manifests=assets.filter(a=>a?.name==='SHA256SUMS.txt'&&a.browser_download_url===`${UPDATE_REPOSITORY}/releases/download/${tag}/SHA256SUMS.txt`);if(manifests.length!==1)fail('UPDATE_METADATA_INVALID','The exact runtime SHA256 metadata is missing.');const text=await this._fetch(manifests[0].browser_download_url,{signal,maximum:MAX_CHECKSUM,checksum:true}),rows=text.split(/\r?\n/u).map(row=>/^([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)$/u.exec(row.trim())).filter(row=>row?.[2]===name);if(rows.length!==1)fail('UPDATE_METADATA_INVALID','The runtime checksum is missing or ambiguous.');sha=rows[0][1].toLowerCase();}
        const release=canonicalRelease({version:v,tag,releaseUrl:raw.html_url,runtime:{name:asset.name,url:asset.browser_download_url,size:asset.size,sha256:sha}});if(!release)fail('UPDATE_METADATA_INVALID','The public runtime URL or checksum metadata is invalid.');this.data.status='available';this.data.release=release;
      }
    }catch(error){this.data.status=error.code==='UPDATE_RATE_LIMITED'?'rate-limited':error.code==='UPDATE_METADATA_INVALID'||error instanceof SyntaxError?'invalid-release':'offline';this.data.error={code:error.code==='UPDATE_RATE_LIMITED'?'UPDATE_RATE_LIMITED':this.data.status==='invalid-release'?'UPDATE_METADATA_INVALID':'UPDATE_NETWORK_UNAVAILABLE',message:this.data.status==='rate-limited'?'The public release service is rate limited. Try later.':this.data.status==='invalid-release'?'The release metadata could not be verified. No update was offered.':'The public release service could not be reached. Editing is unaffected.'};}
    this.data.lastCheckedAt=new Date(this.now()).toISOString();await this._persist();return this._state();
  }
}
let defaultChecker;
export function publicUpdateChecker(){return defaultChecker ||= new ReleaseUpdateChecker();}
