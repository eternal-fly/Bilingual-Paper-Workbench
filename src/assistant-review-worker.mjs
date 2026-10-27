// A fixed data reader in an isolated JS worker. Never evaluates uploaded TeX,
// markup, links or model instructions. Compatibility stays out of the host.
import { parentPort, workerData } from 'node:worker_threads';
import {createHash} from 'node:crypto';
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs';
import { parseReviewFile } from '../ui/review-import.mjs';
globalThis.pdfjsWorker = pdfjsWorker;
if (!Uint8Array.prototype.toHex) Object.defineProperty(Uint8Array.prototype, 'toHex', { value() { return Buffer.from(this).toString('hex'); }, configurable: true });
async function paperPdfContext(){
  const fail=(code,message)=>{throw Object.assign(new Error(message),{code});},bytes=workerData.bytes;
  if(!(bytes instanceof Uint8Array)||bytes.byteLength<5||bytes.byteLength>64*1024*1024||Buffer.from(bytes.subarray(0,5)).toString('ascii')!=='%PDF-'||createHash('sha256').update(bytes).digest('hex')!==workerData.expectedHash)fail('PDF_CONTEXT_HASH_MISMATCH','PDF bytes do not match their verified artifact.');
  const {getDocument}=await import('pdfjs-dist/build/pdf.mjs');
  // Data-only loading never follows document actions, links, JavaScript, XFA,
  // attachments or URLs. Disable even optional font/CMap/wasm network fetches.
  globalThis.fetch=async()=>{fail('PDF_CONTEXT_NETWORK_DISABLED','PDF text extraction cannot fetch network resources.');};
  const task=getDocument({data:bytes,isEvalSupported:false,useSystemFonts:false,disableFontFace:true,stopAtErrors:true,enableXfa:false,verbosity:0,disableAutoFetch:true,disableRange:true,disableStream:true,useWorkerFetch:false,useWasm:false,cMapUrl:null,standardFontDataUrl:null,wasmUrl:null,docBaseUrl:null,isOffscreenCanvasSupported:false,isImageDecoderSupported:false});let encrypted=false;task.onPassword=()=>{encrypted=true;void task.destroy().catch(()=>{});};
  try{const document=await task.promise;if(!Number.isSafeInteger(document.numPages)||document.numPages<1||document.numPages>500)fail('PDF_CONTEXT_TOO_LARGE','A complete native PDF context is limited to 500 pages.');const pages=[];let textBytes=0;
    for(let number=1;number<=document.numPages;number++){const page=await document.getPage(number);try{const content=await page.getTextContent(),text=content.items.filter(item=>typeof item.str==='string').map(item=>item.str+(item.hasEOL?'\n':' ')).join('').replace(/\r\n?/gu,'\n').trim();if(!text)fail('PDF_CONTEXT_OCR_REQUIRED','Every page needs extractable text for complete review.');textBytes+=Buffer.byteLength(JSON.stringify({page:number,text}));if(textBytes>2*1024*1024)fail('PDF_CONTEXT_TOO_LARGE','The complete PDF exceeds the 2 MiB text budget.');pages.push({page:number,text});}finally{page.cleanup();}}
    return{hash:workerData.expectedHash,pageCount:document.numPages,pages};
  }catch(error){if(encrypted)fail('PDF_CONTEXT_ENCRYPTED','Encrypted PDFs cannot be read without author-provided readable source.');if(error.code)throw error;fail('PDF_CONTEXT_INVALID','The PDF could not be read completely.');}finally{await task.destroy();}
}
try {
  const result = workerData.mode==='paper-pdf-context'?await paperPdfContext():await parseReviewFile(new File([workerData.bytes], workerData.filename));
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({ ok: false, error: { code: error.code || 'INVALID_REVIEW_FILE', message: error.code ? error.message : 'The review document could not be read.' } });
}
