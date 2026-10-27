import {deriveTranslationProtectedTokens} from '../ui/translation-protection.mjs';
import {scanInlineStructures} from '../ui/inline-structures.mjs';
import {topLevelReferences} from './reference-edits.mjs';
import {sha256} from './latex.mjs';
import {inlineSyntaxHazard} from './inline-structure-syntax.mjs';
import {inlineBindingRisk} from './inline-binding-risk.mjs';
import {literalInlineCallBindings} from './inline-call-signatures.mjs';
import {sourceInvocationFences} from './inline-source-invocations.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),hash=s=>s.sourceHash||s.beforeHash;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export const inlineStructureFields=['inlineStructureIntent','inlineStructureConflict','inlineStructureUnmapped'];
export const hasInlineStructureIntent=draft=>inlineStructureFields.some(key=>Object.hasOwn(draft||{},key));
export const INLINE_STRUCTURE_POLICY_VERSION=2;
export function inlineStructureSafetyForFiles(files,project,{lexicalSafety=()=>false}={}){
 let safe=!project.diagnostics?.some(row=>row.code==='UNSUPPORTED_TEX');
 try{for(const file of files.values()){if(file.text===undefined&&!/\.(?:bbl|ltx|def|cfg)$/iu.test(file.path))continue;const text=file.text??new TextDecoder('utf-8',{fatal:true}).decode(file.bytes);if(inlineSyntaxHazard(text,{allowStockLexical:lexicalSafety(text)})){safe=false;break;}}}catch{safe=false;}
 const risk=inlineBindingRisk(files,project,{lexicalSafety}),catalog=literalInlineCallBindings(files,{lexicalSafety}),unboundedBindings=Boolean(risk.unboundedBindings||catalog.unboundedBindings);
 return{schemaVersion:1,policyVersion:INLINE_STRUCTURE_POLICY_VERSION,analysisFingerprint:sha256(JSON.stringify([INLINE_STRUCTURE_POLICY_VERSION,project.id,project.snapshotId,project.files])),projectId:project.id,snapshotId:project.snapshotId,safe,...risk,...(unboundedBindings?{unboundedBindings:true}:{}),literalBindings:catalog.bindings,uncertainControls:catalog.uncertainControls,literalSyntaxStable:!unboundedBindings&&!project.diagnostics?.some(row=>row.code==='UNSUPPORTED_TEX'),fingerprint:sha256(JSON.stringify([project.id,project.snapshotId,project.files]))};
}
function proof(project,omission=false,before=[],after=[]){
 const value=project.inlineStructureSafety,identity=value?.schemaVersion===1&&value.projectId===project.id&&value.snapshotId===project.snapshotId&&/^[a-f0-9]{64}$/u.test(value.fingerprint||'');
 const remaining=before.map(row=>row[2]),added=[];for(const row of after){const at=remaining.indexOf(row[2]);if(at<0)added.push(row[2]);else remaining.splice(at,1);}
 const unsafe=new Set([...(value?.reboundControls||[]),...(value?.symbolControls||[]),...(value?.uncertainControls||[])]);
 const unaffected=identity&&value.literalSyntaxStable===true&&!value.unprovedConstructors&&added.every(raw=>{const name=raw==='~'?'~':/^\\([A-Za-z]+|.)/u.exec(raw)?.[1];return !name||!unsafe.has(name);});
 if(!identity||!omission&&(value.unboundedBindings||!value.safe&&!unaffected))fail('INLINE_STRUCTURE_SOURCE_UNSAFE','New inline controls need a verified source identity. Your draft can be retained and adapted against the protected source inventory.');
 return value.fingerprint;
}
function omissionOnly(before,after){let cursor=0;for(const atom of after){while(cursor<before.length&&!same(before[cursor],atom))cursor++;if(cursor===before.length)return false;cursor++;}return true;}
export function inlineStructureView(text,source){
 const base=deriveTranslationProtectedTokens(text,source.protectedTokens),references=topLevelReferences(text,source),opaque=base.filter(row=>!references.some(ref=>ref.start<=row.start&&ref.end>=row.end));
 for(const ref of references)opaque.push({...ref,kind:'citation'});
 opaque.sort((a,b)=>a.start-b.start||b.end-a.end);
 const view=scanInlineStructures(text,opaque);let boundary=0;
 return{...view,signature:view.atoms.map(row=>row.editableInline?['inline',boundary,row.raw]:(boundary++,null)).filter(Boolean),critical:view.atoms.filter(row=>!row.editableInline&&row.kind!=='math'&&row.kind!=='citation').map(row=>row.raw)};
}
const invocationOptions=project=>{const profile=project.inlineStructureSafety||{};return{bindings:profile.literalBindings||{},uncertainControls:profile.uncertainControls||[],reboundControls:profile.reboundControls||[],symbolControls:profile.symbolControls,opaqueSymbolArity:profile.opaqueSymbolArity===true,unboundedBindings:profile.unboundedBindings===true};};
/** Preserve complete original invocations only where their consumed operands
 * are literally proved. An unproved consumer retains its continuation; true
 * lexical uncertainty and unknown active controls retain the whole range. */
export function originalSourceObjects(source,project){
 const ordinary=inlineStructureView(source.source,source).atoms,fences=sourceInvocationFences(source.source,invocationOptions(project));
 if(!fences.spans.length)return{atoms:ordinary,opaqueBindings:false};
 // Never split an independently opaque original object when a newly proved
 // invocation bound is narrower than a legacy canonical token.
 const spans=fences.spans.map(range=>({...range}));for(const atom of ordinary.filter(row=>!row.editableInline))for(const range of spans)if(atom.start<range.end&&atom.end>range.start){range.start=Math.min(range.start,atom.start);range.end=Math.max(range.end,atom.end);range.raw=source.source.slice(range.start,range.end);}
 const merged=[];for(const range of spans.sort((a,b)=>a.start-b.start||b.end-a.end)){const last=merged.at(-1);if(last&&last.end>range.start){last.end=Math.max(last.end,range.end);last.raw=source.source.slice(last.start,last.end);}else merged.push(range);}
 const atoms=[...ordinary.filter(atom=>!merged.some(range=>atom.start<range.end&&atom.end>range.start)),...merged].sort((a,b)=>a.start-b.start),continuation=Number.isInteger(fences.continuationStart)?merged.find(range=>range.start<=fences.continuationStart&&range.end===source.source.length)?.start:undefined;
 return{atoms,opaqueBindings:true,opaqueRange:fences.opaqueRange===true,...(Number.isInteger(continuation)?{continuationStart:continuation}: {})};
}
export function survivingUnprovedInline(source,text,project){
 const options=invocationOptions(project),before=sourceInvocationFences(source.source,options),after=sourceInvocationFences(text,options);
 if(after.opaqueRange||Number.isInteger(after.continuationStart))return after.spans.length>0;
 // A proved, complete original invocation can coexist with independently
 // authorized math/reference/inline edits. Its original caller operand still
 // remains exact; ordinary translation cannot manufacture or retarget calls.
 const retained=before.spans.map(row=>row.raw);let cursor=0;for(const span of after.spans){while(cursor<retained.length&&retained[cursor]!==span.raw)cursor++;if(cursor===retained.length)return true;cursor++;}
 return false;
}
export function validateInlineStructureText(text,source){const view=inlineStructureView(text,source);if(view.issues.length)fail('PROTECTED_TOKEN_CHANGED',`${view.issues[0].reason} Your current editor text is retained.`);return view;}
export function prepareInlineStructureIntent(source,text,project,language){
 const current=validateInlineStructureText(text,source),baseline=inlineStructureView(source.source,source);
 if(!same(current.critical,baseline.critical))fail('PROTECTED_TOKEN_CHANGED','Existing labels, document structure and unknown commands must remain unchanged. Your current editor text is retained.');
 if(same(current.signature,baseline.signature))return{};
 const omission=omissionOnly(baseline.signature,current.signature);
 return{inlineStructureIntent:{schemaVersion:1,mode:omission?'existing-inline-omission':'literal-inline-inventory',projectId:project.id,snapshotId:project.snapshotId,segmentId:source.id,sourceHash:hash(source),language,syntaxHash:proof(project,omission,baseline.signature,current.signature),before:baseline.signature,after:current.signature}};
}
export function validateInlineStructureIntent(source,draft,project,language){
 if(draft?.inlineStructureConflict||draft?.inlineStructureUnmapped)fail('VERSION_CONFLICT','Save and validate the complete human inline structure draft before generating an English candidate.');
 const expected=prepareInlineStructureIntent(source,draft.text,project,language);
 if(!same(expected.inlineStructureIntent||null,draft.inlineStructureIntent||null))fail('VERSION_CONFLICT','The inline structure authorization changed or no longer matches this paper. Keep your editor text and validate it again.');
 return expected;
}
export function reconcileInlineStructureDraft(source,current,text,project,language){
 if(!hasInlineStructureIntent(current)){
  if(!current?.text)return{};
  try{if(same(inlineStructureView(current.text,source).signature,inlineStructureView(text,source).signature))return{};}catch{}
  return{inlineStructureUnmapped:true};
 }
 try{const expected=prepareInlineStructureIntent(source,text,project,language);if(!expected.inlineStructureIntent)return{};if(same(expected.inlineStructureIntent,current.inlineStructureIntent))return expected;}catch{}
 return{...(current.inlineStructureIntent?{inlineStructureIntent:structuredClone(current.inlineStructureIntent)}:{}),inlineStructureConflict:true};
}
