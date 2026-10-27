import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {validatePairContext} from './review-cycle.mjs';

export const NATIVE_PDF_LIMITS=Object.freeze({pdfBytes:64*1024*1024,pages:500,textBytes:2*1024*1024,timeoutMs:45000});
const controllers=new WeakMap(),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const exact=(value,keys)=>plain(value)&&Object.keys(value).every(key=>keys.includes(key));
function documentContext(value,expectedHash){
 if(!exact(value,['hash','pageCount','pages'])||value.hash!==expectedHash||!Number.isSafeInteger(value.pageCount)||value.pageCount<1||value.pageCount>NATIVE_PDF_LIMITS.pages||!Array.isArray(value.pages)||value.pages.length!==value.pageCount)fail('INVALID_PDF_CONTEXT','The native PDF reader did not return every bounded page of the verified artifact.');
 let size=0;const pages=Array.from(value.pages,(page,index)=>{if(!exact(page,['page','text'])||page.page!==index+1||typeof page.text!=='string')fail('INVALID_PDF_CONTEXT','PDF page identities must be complete and consecutive.');if(!page.text.trim())fail('PDF_CONTEXT_OCR_REQUIRED','A PDF page has no extractable text; complete review requires a text-readable document.');size+=Buffer.byteLength(JSON.stringify(page));if(size>NATIVE_PDF_LIMITS.textBytes)fail('PDF_CONTEXT_TOO_LARGE','Complete PDF text exceeds the 2 MiB context budget; partial text was not retained.');return{page:page.page,text:page.text};});
 return{hash:expectedHash,pageCount:value.pageCount,pages};
}
function checkedBytes(bytes,expectedHash){
 if(!(bytes instanceof Uint8Array)||bytes.byteLength<5||bytes.byteLength>NATIVE_PDF_LIMITS.pdfBytes)fail('PDF_CONTEXT_TOO_LARGE','A native PDF artifact must be at most 64 MiB.');
 if(!/^[a-f0-9]{64}$/u.test(expectedHash||'')||Buffer.from(bytes.buffer,bytes.byteOffset,5).toString('ascii')!=='%PDF-'||hash(bytes)!==expectedHash)fail('PDF_CONTEXT_HASH_MISMATCH','PDF bytes no longer match the verified version-pair artifact.');return bytes;
}
function decodeArtifact(artifact){
 if(typeof artifact?.base64!=='string')fail('PDF_CONTEXT_PENDING','The verified PDF pair has no readable artifact bytes; generate its current English PDF first.');
 if(artifact.base64.length>Math.ceil(NATIVE_PDF_LIMITS.pdfBytes/3)*4)fail('PDF_CONTEXT_TOO_LARGE','A native PDF artifact exceeds 64 MiB.');
 if(!artifact.base64.length||artifact.base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/u.test(artifact.base64))fail('INVALID_PDF_CONTEXT','The verified PDF artifact encoding is invalid.');
 return checkedBytes(Buffer.from(artifact.base64,'base64'),artifact.hash.toLowerCase());
}
/** This uses the existing fixed bundled reader artifact. No input path, URL,
 * model, browser, rendering or document action is handed to the worker. */
export async function extractNativePdfText(bytes,{hash:expectedHash,signal,WorkerClass=Worker,timeoutMs=NATIVE_PDF_LIMITS.timeoutMs}={}){
 checkedBytes(bytes,expectedHash);if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)fail('INVALID_INPUT','Use a bounded native PDF reader timeout.');if(signal?.aborted)fail('PDF_CONTEXT_CANCELLED','The native PDF read was cancelled.');
 return new Promise((resolve,reject)=>{
  let worker,finished=false,timer;const abort=()=>{void finish(Object.assign(new Error('The native PDF read was cancelled.'),{code:'PDF_CONTEXT_CANCELLED'}));};
  async function finish(error,result){if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);try{await worker?.terminate();}catch{}if(error)reject(error);else resolve(result);}
  try{
   const data=Uint8Array.from(bytes);worker=new WorkerClass(new URL('./assistant-review-worker.mjs',import.meta.url),{workerData:{mode:'paper-pdf-context',bytes:data,expectedHash,maxPages:NATIVE_PDF_LIMITS.pages,maxTextBytes:NATIVE_PDF_LIMITS.textBytes},transferList:[data.buffer],execArgv:[],stdout:true,stderr:true,resourceLimits:{maxOldGenerationSizeMb:512,maxYoungGenerationSizeMb:64,stackSizeMb:8}});worker.stdout?.resume();worker.stderr?.resume();
   timer=setTimeout(()=>{void finish(Object.assign(new Error('The complete native PDF read exceeded its time limit.'),{code:'PDF_CONTEXT_TIMEOUT'}));},timeoutMs);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
   worker.once('message',message=>{if(finished)return;if(message?.ok!==true){const code=/^PDF_CONTEXT_[A-Z_]+$/u.test(message?.error?.code||'')?message.error.code:'INVALID_PDF_CONTEXT';void finish(Object.assign(new Error('The verified PDF could not be read completely; no partial context was kept.'),{code}));return;}try{void finish(null,documentContext(message.result,expectedHash));}catch(error){void finish(error);}});
   worker.once('error',error=>{void finish(Object.assign(new Error('The isolated native PDF reader failed.'),{code:error?.code==='ERR_WORKER_OUT_OF_MEMORY'?'PDF_CONTEXT_RESOURCE_LIMIT':'PDF_CONTEXT_WORKER_FAILED'}));});worker.once('exit',()=>{if(!finished)void finish(Object.assign(new Error('The isolated PDF reader exited before completing every page.'),{code:'PDF_CONTEXT_WORKER_FAILED'}));});
  }catch{void finish(Object.assign(new Error('The installed native PDF reader is unavailable.'),{code:'PDF_CONTEXT_UNAVAILABLE'}));}
 });
}
function identity(pair,project){
 if(!plain(pair)||typeof pair.pairId!=='string'||!pair.pairId||pair.pairId.length>200||pair.projectId!==project?.id||pair.latest?.snapshotId!==project.snapshotId||!['original','latest'].every(role=>typeof pair[role]?.buildId==='string'&&/^[a-f0-9]{64}$/iu.test(pair[role]?.hash||'')))fail('VERSION_CONFLICT','The verified PDF pair does not match the current project and source snapshot.');
 return JSON.stringify({projectId:project.id,snapshotId:project.snapshotId,pairId:pair.pairId,original:{buildId:pair.original.buildId,hash:pair.original.hash.toLowerCase()},latest:{buildId:pair.latest.buildId,hash:pair.latest.hash.toLowerCase(),snapshotId:pair.latest.snapshotId}});
}
function cachedFor(app,pair,project){const cached=app.cycles.cached;if(cached?.projectId!==project.id||cached.snapshotId!==project.snapshotId||cached.context?.pairId!==pair.pairId||!['original','latest'].every(role=>cached.context?.[role]?.hash===pair[role].hash.toLowerCase()))return false;for(const role of['original','latest'])documentContext(cached.context[role],pair[role].hash.toLowerCase());validatePairContext(cached.context);return true;}
/** Must run outside PdfSelection.context's serial section. Publication then
 * uses the existing serial verified-pair cache API, never a source mutation. */
export async function prepareNativePdfContext(app,{extract=extractNativePdfText}={}){
 const target=app.pdfSelection.state();if(target.target==='current'&&target.activeRole!=='original'&&target.activeRole!=='latest')return{available:false,skipped:true};
 let control=controllers.get(app);if(!control){control={pending:new Map(),closed:false};controllers.set(app,control);}if(control.closed)fail('PDF_CONTEXT_CANCELLED','The paper PDF reader has closed.');
 return app._projectOperation(async()=>{
  await app.core._assertSourceCurrent();const project=structuredClone(app.core.getState().project),pair=await app.pdfSelection.pair(),key=identity(pair,project);if(cachedFor(app,pair,project))return{available:true,cached:true,pairId:pair.pairId};
  const prior=control.pending.get(key);if(prior)return prior.promise;
  if(control.pending.size)fail('PDF_CONTEXT_BUSY','A different verified PDF pair is already being read; retry after that bounded read finishes.');
  const originalBytes=decodeArtifact(pair.original),latestBytes=decodeArtifact(pair.latest),controller=new AbortController(),entry={controller,promise:null};
  entry.promise=Promise.resolve().then(async()=>{
   const texts=new Map(),pairContext={pairId:pair.pairId};
   for(const [role,bytes]of[['original',originalBytes],['latest',latestBytes]]){if(controller.signal.aborted||control.closed)fail('PDF_CONTEXT_CANCELLED','The native PDF read was cancelled.');const expectedHash=pair[role].hash.toLowerCase();if(!texts.has(expectedHash))texts.set(expectedHash,documentContext(await extract(bytes,{hash:expectedHash,signal:controller.signal}),expectedHash));pairContext[role]=structuredClone(texts.get(expectedHash));}
   const context=validatePairContext(pairContext);if(controller.signal.aborted||control.closed)fail('PDF_CONTEXT_CANCELLED','The native PDF read was cancelled.');await app.core._assertSourceCurrent();const current=app.core.getState().project,currentPair=await app.pdfSelection.pair();if(identity(currentPair,current)!==key)fail('VERSION_CONFLICT','The source or verified PDF pair changed during native extraction.');
   if(!cachedFor(app,currentPair,current))await app.cycles.cache({pairContext:context});return{available:true,cached:false,pairId:pair.pairId};
  }).finally(()=>{if(control.pending.get(key)===entry)control.pending.delete(key);});control.pending.set(key,entry);return entry.promise;
 });
}
export function closeNativePdfContext(app){const control=controllers.get(app);if(!control)return;control.closed=true;for(const entry of control.pending.values())entry.controller.abort();control.pending.clear();}
