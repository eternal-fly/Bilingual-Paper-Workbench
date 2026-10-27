import path from 'node:path';
import {sha256} from './latex.mjs';

const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const MAX_REPLACEMENT=4*1024*1024;
const EXECUTABLE=new Set('openin openout closein closeout read readline write write18 ShellEscape directlua latelua luadirect luafunction luaexec pdfshellescape pdfextension special scantokens'.split(' '));
const FILE_CONTROLS=new Set(['input','include','includegraphics','bibliography','bibliographystyle','addbibresource','lstinputlisting','verbatiminput']);
const PACKAGE_CONTROLS=new Set(['usepackage','RequirePackage','documentclass','LoadClass']);
const VERBATIM=new Set(['verbatim','verbatim*','Verbatim','lstlisting']);

/** A source-review range is a byte capability, not a claim that arbitrary TeX
 * has been statically proved safe. Only the isolated compiler executes it. */
export function sourceReviewManifest(state,files){
 const project=state.project;
 if(!project||!(files instanceof Map)||files.size!==project.files?.length||new Set(project.files.map(row=>row.path)).size!==project.files.length)fail('VERSION_CONFLICT','The captured project manifest is unavailable or inconsistent.');
 if(project.snapshotId!==`snap-${sha256(JSON.stringify({mainFile:project.mainFile,files:project.files}))}`)fail('VERSION_CONFLICT','The source-review snapshot no longer matches its captured manifest.');
 for(const expected of project.files){const file=files.get(expected.path);if(!file||!Buffer.isBuffer(file.bytes)||file.path!==expected.path||file.hash!==expected.hash||file.bytes.length!==expected.size||sha256(file.bytes)!==expected.hash)fail('VERSION_CONFLICT','A captured source-review input differs from its exact manifest.');}
 return sha256(JSON.stringify({projectId:project.id,snapshotId:project.snapshotId,mainFile:project.mainFile,files:project.files}));
}
export function sourceReviewSource(state,files,id,expected=null,{verifiedManifestHash=null}={}){
 const manifestHash=verifiedManifestHash||sourceReviewManifest(state,files),retained=state.sourceReviewAnchors?.find(row=>row.id===id&&row.projectId===state.project.id&&row.snapshotId===state.project.snapshotId),anchor=retained||state.readingAnchors?.find(row=>row.id===id)||state.segments?.find(row=>row.id===id),file=anchor&&files.get(anchor.path);
 if(!file||!file.path.toLowerCase().endsWith('.tex')||!Number.isSafeInteger(anchor.startByte)||!Number.isSafeInteger(anchor.endByte)||anchor.startByte<0||anchor.endByte<anchor.startByte||anchor.endByte===anchor.startByte&&!retained||anchor.endByte>file.bytes.length)fail('SEGMENT_NOT_FOUND','Select a current, exact declared TeX reading range for source review.');
 const bytes=file.bytes.subarray(anchor.startByte,anchor.endByte);let source;try{source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('UNSUPPORTED_ENCODING','The selected source-review range must contain complete UTF-8 text.');}
 const beforeHash=sha256(bytes);if((anchor.sourceHash||anchor.beforeHash)!==beforeHash)fail('VERSION_CONFLICT','The selected source-review interval no longer matches its current source hash.');
 const sourceAuthority={kind:'source-review-range-v1',projectId:state.project.id,snapshotId:state.project.snapshotId,manifestHash,path:file.path,fileHash:file.hash,startByte:anchor.startByte,endByte:anchor.endByte,beforeHash};
 if(expected&&!equal(sourceAuthority,expected))fail('VERSION_CONFLICT','The exact source-review range or captured project manifest changed.');
 return{id,path:file.path,startByte:anchor.startByte,endByte:anchor.endByte,beforeHash,sourceHash:beforeHash,source,displayText:source,protectedTokens:[],translatable:true,sourceAuthority};
}
export const sourceReviewInstructions='Read the complete exact original TeX range and saved author draft, using the declared project context. Return a faithful English TeX candidate only for the registered ranges. Custom macros, environments, mathematics and references may change in this explicit source-review mode. Do not add host paths, executable/file-access capabilities, undeclared inputs, or edits outside the selected ranges. The result is pending: inspect its exact diff, compile it in the existing isolated compiler, and obtain explicit human source-review confirmation before any write. If compilation fails, prepare a fresh same-scoped request and repair the pending candidate; never apply automatically. Unresolved author-draft intent remains saved for further review.';
export function captureSourceReviewSegment(selected,source,draft){
 return{...selected,text:source.source,rawSource:source.source,originalSource:source.source,protectedTokens:[],sourceAuthority:source.sourceAuthority,draftReview:{mode:'raw-tex-source-review',draftRevision:draft?.revision||0,draftHash:sha256(draft?.text||''),sourceHash:source.beforeHash,diagnostics:structuredClone(draft?.sourceReviewDiagnostics||[]),instructions:sourceReviewInstructions}};
}
export function assertSourceReviewRequest(request,state,files){
 const manifestHash=sourceReviewManifest(state,files);
 if(request?.kind!=='revision'||request.mode!=='source-review'||request.projectId!==state.project?.id||request.snapshotId!==state.project?.snapshotId||request.sourceReview?.manifestHash!==manifestHash||request.sourceReview.requiresHumanSourceReview!==true)fail('VERSION_CONFLICT','This exact raw TeX source-review request is no longer current.');
 const intervals=[];
 for(const selected of request.segments||[]){const source=sourceReviewSource(state,files,selected.id,selected.sourceAuthority,{verifiedManifestHash:manifestHash}),draft=state.readingDrafts?.[request.language]?.[selected.id]||state.translations?.[request.language]?.[selected.id];
  if(selected.rawSource!==source.source||selected.text!==source.source||selected.originalSource!==source.source||selected.protectedTokens?.length||selected.draftReview?.mode!=='raw-tex-source-review'||selected.draftReview.sourceHash!==source.beforeHash||selected.draftReview.draftRevision!==(draft?.revision||0)||selected.draftReview.draftHash!==sha256(draft?.text||''))fail('VERSION_CONFLICT','The registered raw source or exact saved author draft changed; prepare a fresh source-review candidate.');
  intervals.push(source);
 }
 if(intervals.length!==request.segmentIds.length||new Set(intervals.map(row=>row.id)).size!==intervals.length||intervals.some(row=>!request.segmentIds.includes(row.id)))fail('VERSION_CONFLICT','The registered source-review selection changed.');
 intervals.sort((a,b)=>a.path.localeCompare(b.path)||a.startByte-b.startByte);for(let i=1;i<intervals.length;i++)if(intervals[i].path===intervals[i-1].path&&(intervals[i].startByte<intervals[i-1].endByte||intervals[i].startByte===intervals[i].endByte&&intervals[i-1].startByte===intervals[i-1].endByte&&intervals[i].startByte===intervals[i-1].startByte))fail('OVERLAPPING_EDITS','Source-review ranges overlap; select each source byte or insertion point once.');
 return{manifestHash,sources:new Map(intervals.map(row=>[row.id,row]))};
}
function argument(text,at){
 while(/\s/u.test(text[at]||''))at++;
 while(text[at]==='['){let depth=1;for(at++;at<text.length&&depth;at++){if(text[at]==='\\'){at++;continue;}if(text[at]==='[')depth++;if(text[at]===']')depth--;}while(/\s/u.test(text[at]||''))at++;}
 if(text[at]==='{'){const start=++at;let depth=1;for(;at<text.length;at++){if(text[at]==='\\'){at++;continue;}if(text[at]==='{')depth++;if(text[at]==='}'&&!--depth)return{value:text.slice(start,at),end:at+1};}return null;}
 const match=/^[^\s{}%]+/u.exec(text.slice(at));return match?{value:match[0],end:at+match[0].length}:null;
}
function controls(text){
 const result=[];for(let at=0;at<text.length;){if(text[at]==='%'){const end=text.indexOf('\n',at);if(end<0)break;at=end+1;continue;}if(text[at]!=='\\'){at++;continue;}const start=at++;let end=at;while(/[A-Za-z@_:]/u.test(text[end]||''))end++;if(end===at){at++;continue;}const name=text.slice(at,end);at=end;
  if(name==='verb'){if(text[at]==='*')at++;const delimiter=text[at++],close=delimiter&&text.indexOf(delimiter,at);at=close<0?text.length:close+1;continue;}
  const arg=argument(text,end);if(name==='begin'&&VERBATIM.has(arg?.value)){const close=text.indexOf(`\\end{${arg.value}}`,arg.end);at=close<0?text.length:close+arg.value.length+6;continue;}
  if(name==='csname'){const close=text.indexOf('\\endcsname',end);if(close>=0){const built=withoutComments(text.slice(end,close)).replace(/\s+/gu,'');if(/^[A-Za-z@_:]+$/u.test(built)&&(EXECUTABLE.has(built)||FILE_CONTROLS.has(built)||PACKAGE_CONTROLS.has(built)))result.push({name:built,start,end:close+10,arg:argument(text,close+10),constructed:true});}}
  result.push({name,start,end,arg});
 }return result;
}
function withoutComments(text){let value='';for(let at=0;at<text.length;at++){if(text[at]==='\\'){value+=text.slice(at,at+2);at++;continue;}if(text[at]==='%'){const end=text.indexOf('\n',at);if(end<0)break;at=end;continue;}value+=text[at];}return value;}
function capabilityObject(text,control){
 let at=control.end;
 if(['write','write18','openin','openout','closein','closeout','read','readline'].includes(control.name)){
  const stream=/^\s*(?:-?\d+|\\[A-Za-z@_:]+)/u.exec(text.slice(at));if(!stream)return null;at+=stream[0].length;
  if(['openin','openout'].includes(control.name)){const filename=/^\s*=\s*(?:"[^"\r\n]+"|[^\s\\{}%]+)/u.exec(text.slice(at));return filename?text.slice(control.start,at+filename[0].length):null;}
  if(['closein','closeout'].includes(control.name))return text.slice(control.start,at);
  if(['read','readline'].includes(control.name)){const target=/^\s*to\s*\\[A-Za-z@_:]+/u.exec(text.slice(at));return target?text.slice(control.start,at+target[0].length):null;}
 }
 const arg=argument(text,at);return arg&&text.slice(at,arg.end).trimStart().startsWith('{')?text.slice(control.start,arg.end):null;
}
const originalAuxiliaryWrite=object=>typeof object==='string'&&/^\\write\s*\\@auxout\s*\{\s*\\string\s*\\citation\s*\{[^\\{}%]*\}\s*\}$/u.test(object);
function declaredFile(value,source,files){
 if(!value||/[\\\x00-\x20{}#$%~^]/u.test(value)||path.posix.isAbsolute(value)||path.win32.isAbsolute(value)||value.includes(':')||value.split('/').some(part=>!part||part==='.'||part==='..'))return false;
 const names=[value,path.posix.join(path.posix.dirname(source.path),value)];
 return names.some(name=>files.has(name)||['.tex','.pdf','.png','.jpg','.jpeg','.eps','.bib','.bst'].some(extension=>files.has(name+extension)));
}
/** This is a direct capability fence, deliberately not a TeX layout grammar.
 * Macro expansion is executed only inside the unchanged AppContainer policy. */
export function validateSourceReviewReplacement(source,replacement,files){
 if(typeof replacement!=='string'||Buffer.byteLength(replacement)>MAX_REPLACEMENT||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(replacement)||Buffer.from(replacement).toString('utf8')!==replacement)fail('INVALID_INPUT','Provide bounded valid UTF-8 raw TeX for the selected source-review range.');
 if(replacement.includes('^^')&&replacement!==source.source)fail('SOURCE_REVIEW_CAPABILITY_DENIED','Normalize TeX character-rewrite notation before reviewing a changed raw range; it must not hide executable or external file controls.');
 const originalCapabilities=new Map();for(const control of controls(source.source))if(EXECUTABLE.has(control.name)){const object=capabilityObject(source.source,control);if(originalAuxiliaryWrite(object))originalCapabilities.set(object,(originalCapabilities.get(object)||0)+1);}
 for(const control of controls(replacement)){
  if(EXECUTABLE.has(control.name)&&replacement!==source.source){const object=capabilityObject(replacement,control),count=object&&originalCapabilities.get(object);if(!count)fail('SOURCE_REVIEW_CAPABILITY_DENIED','A source-review candidate cannot introduce or retarget direct executable or file-stream controls. Its raw author draft remains saved.');originalCapabilities.set(object,count-1);}
  if(FILE_CONTROLS.has(control.name)&&!control.arg?.value.split(',').every(value=>declaredFile(value.trim(),source,files)))fail('SOURCE_REVIEW_CAPABILITY_DENIED','Source-review file references must name literal inputs already captured in this project manifest.');
  if(PACKAGE_CONTROLS.has(control.name)&&(!control.arg||!control.arg.value.split(',').every(value=>/^[A-Za-z0-9_-]+$/u.test(value))))fail('SOURCE_REVIEW_CAPABILITY_DENIED','Package/class names must be literal installed names; source review cannot grant external paths.');
 }
 return replacement;
}
export function sourceReviewCandidate(proposals){
 const raw=proposals.filter(row=>row.context?.mode==='source-review');if(!raw.length)return null;
 const edits=raw.flatMap(row=>row.edits.map(edit=>({segmentId:edit.segmentId,path:edit.path,startByte:edit.startByte,endByte:edit.endByte,beforeHash:edit.beforeHash,replacementHash:sha256(edit.replacement)})));
 return{schemaVersion:1,requiresHumanSourceReview:true,manifestHash:raw[0].edits[0].sourceAuthority.manifestHash,edits};
}
