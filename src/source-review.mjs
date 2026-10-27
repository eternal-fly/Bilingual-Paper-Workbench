import {sha256} from './latex.mjs';

const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const MAX_REPLACEMENT=4*1024*1024;
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
export const sourceReviewInstructions='Read the complete exact original TeX range and latest saved author draft, using the declared project context. Return the single best faithful English TeX replacement for only the registered ranges. All inline content, formulas, citations, labels, macros and environments may be added, changed or deleted according to the author intent; do not impose placeholder or TeX-content restrictions. Return text only: do not execute host commands, access unrelated host files, apply source changes or invent approval. The workbench compiles the exact candidate only inside its existing isolated no-shell-escape runtime and promotes it through the author-initiated writeback workflow with current source and draft checks. Compilation does not certify scientific correctness or faithful translation. If compilation fails, repair the pending candidate in this same chat; preserve the exact author draft and do not create another chat or extra review task.';
export function captureSourceReviewSegment(selected,source,draft){
 const current=selected.translationDraft||draft;
 return{...selected,text:source.source,rawSource:source.source,originalSource:source.source,protectedTokens:[],sourceAuthority:source.sourceAuthority,draftReview:{mode:'raw-tex-source-review',draftRevision:current?.revision||0,draftHash:sha256(current?.text||''),sourceHash:source.beforeHash,diagnostics:structuredClone(draft?.sourceReviewDiagnostics||[]),instructions:sourceReviewInstructions}};
}
function currentAuthorDraft(state,language,id){for(const namespace of [state.readingDrafts?.[language],state.translations?.[language]])if(namespace&&Object.hasOwn(namespace,id))return namespace[id];return null;}
function sourceReviewDraft(selected,request,state){
 const captured=selected.translationDraft,alignment=state.alignments?.find(row=>row.language===request.language&&row.sourceSegmentIds?.includes(selected.id)),currentUnits=alignment?.translationUnitIds||[selected.id],units=captured?.translationUnitIds||[selected.id];
 if(!Array.isArray(units)||!units.length||units.some(id=>typeof id!=='string'||!id)||new Set(units).size!==units.length||!equal(units,currentUnits))fail('VERSION_CONFLICT','The aligned author-draft units changed; prepare a fresh source-review candidate.');
 const drafts=units.map(id=>currentAuthorDraft(state,request.language,id));
 if(!captured){if(drafts.some(Boolean))fail('VERSION_CONFLICT','The saved author draft changed after source review was prepared.');return{text:'',revision:0};}
 if(drafts.some(draft=>!draft||typeof draft.text!=='string'||!Number.isSafeInteger(draft.revision)||draft.revision<0)||units.some((id,index)=>!Object.hasOwn(request.translationUnitRevisions||{},id)||request.translationUnitRevisions[id]!==drafts[index].revision))fail('VERSION_CONFLICT','An aligned author-draft unit is missing or changed; prepare a fresh source-review candidate.');
 const current={text:drafts.map(draft=>draft.text).join('\n\n'),revision:drafts.reduce((maximum,draft)=>Math.max(maximum,draft.revision),0)};
 if(captured.text!==current.text||captured.revision!==current.revision)fail('VERSION_CONFLICT','The exact combined author draft changed; prepare a fresh source-review candidate.');return current;
}
export function assertSourceReviewRequest(request,state,files){
 const manifestHash=sourceReviewManifest(state,files);
 if(request?.kind!=='revision'||request.mode!=='source-review'||request.projectId!==state.project?.id||request.snapshotId!==state.project?.snapshotId||request.sourceReview?.manifestHash!==manifestHash||request.sourceReview.requiresHumanSourceReview!==true)fail('VERSION_CONFLICT','This exact raw TeX source-review request is no longer current.');
 const intervals=[];
 for(const selected of request.segments||[]){const source=sourceReviewSource(state,files,selected.id,selected.sourceAuthority,{verifiedManifestHash:manifestHash}),draft=sourceReviewDraft(selected,request,state);
  if(selected.rawSource!==source.source||selected.text!==source.source||selected.originalSource!==source.source||selected.protectedTokens?.length||selected.draftReview?.mode!=='raw-tex-source-review'||selected.draftReview.sourceHash!==source.beforeHash||selected.draftReview.draftRevision!==(draft?.revision||0)||selected.draftReview.draftHash!==sha256(draft?.text||''))fail('VERSION_CONFLICT','The registered raw source or exact saved author draft changed; prepare a fresh source-review candidate.');
  intervals.push(source);
 }
 if(intervals.length!==request.segmentIds.length||new Set(intervals.map(row=>row.id)).size!==intervals.length||intervals.some(row=>!request.segmentIds.includes(row.id)))fail('VERSION_CONFLICT','The registered source-review selection changed.');
 intervals.sort((a,b)=>a.path.localeCompare(b.path)||a.startByte-b.startByte);for(let i=1;i<intervals.length;i++)if(intervals[i].path===intervals[i-1].path&&(intervals[i].startByte<intervals[i-1].endByte||intervals[i].startByte===intervals[i].endByte&&intervals[i-1].startByte===intervals[i-1].endByte&&intervals[i].startByte===intervals[i-1].startByte))fail('OVERLAPPING_EDITS','Source-review ranges overlap; select each source byte or insertion point once.');
 return{manifestHash,sources:new Map(intervals.map(row=>[row.id,row]))};
}
/** Validate transport encoding and size only. Exact source ranges, manifests,
 * isolated compilation and author-initiated promotion are separate boundaries;
 * this function neither parses TeX content nor executes any supplied text. */
export function validateSourceReviewReplacement(source,replacement,files){
 if(typeof replacement!=='string'||Buffer.byteLength(replacement)>MAX_REPLACEMENT||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(replacement)||Buffer.from(replacement).toString('utf8')!==replacement)fail('INVALID_INPUT','Provide bounded valid UTF-8 raw TeX for the selected source-review range.');
 return replacement;
}
export function sourceReviewCandidate(proposals){
 const raw=proposals.filter(row=>row.context?.mode==='source-review');if(!raw.length)return null;
 const edits=raw.flatMap(row=>row.edits.map(edit=>({segmentId:edit.segmentId,path:edit.path,startByte:edit.startByte,endByte:edit.endByte,beforeHash:edit.beforeHash,replacementHash:sha256(edit.replacement)})));
 return{schemaVersion:1,requiresHumanSourceReview:true,manifestHash:raw[0].edits[0].sourceAuthority.manifestHash,edits};
}
