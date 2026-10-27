import {deriveTranslationProtectedTokens} from '../ui/translation-protection.mjs';
import {scanInlineStructures} from '../ui/inline-structures.mjs';
import {topLevelReferences} from './reference-edits.mjs';
import {sha256} from './latex.mjs';
import {inlineSyntaxHazard} from './inline-structure-syntax.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),hash=s=>s.sourceHash||s.beforeHash;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export const inlineStructureFields=['inlineStructureIntent','inlineStructureConflict','inlineStructureUnmapped'];
export const hasInlineStructureIntent=draft=>inlineStructureFields.some(key=>Object.hasOwn(draft||{},key));
export function inlineStructureSafetyForFiles(files,project,{lexicalSafety=()=>false}={}){
 let safe=!project.diagnostics?.some(row=>row.code==='UNSUPPORTED_TEX');
 try{for(const file of files.values()){if(file.text===undefined&&!/\.(?:bbl|ltx|def|cfg)$/iu.test(file.path))continue;const text=file.text??new TextDecoder('utf-8',{fatal:true}).decode(file.bytes);if(inlineSyntaxHazard(text,{allowStockLexical:lexicalSafety(text)})){safe=false;break;}}}catch{safe=false;}
 return{schemaVersion:1,projectId:project.id,snapshotId:project.snapshotId,safe,fingerprint:sha256(JSON.stringify([project.id,project.snapshotId,project.files]))};
}
function proof(project){const value=project.inlineStructureSafety;if(!value?.safe||value.schemaVersion!==1||value.projectId!==project.id||value.snapshotId!==project.snapshotId||!/^[a-f0-9]{64}$/u.test(value.fingerprint||''))fail('INLINE_STRUCTURE_SOURCE_UNSAFE','This project can redefine inline formatting, escapes or spacing. Keep your draft; inline source changes require a source review.');return value.fingerprint;}
export function inlineStructureView(text,source){
 const base=deriveTranslationProtectedTokens(text,source.protectedTokens),references=topLevelReferences(text,source),opaque=base.filter(row=>!references.some(ref=>ref.start<=row.start&&ref.end>=row.end));
 for(const ref of references)opaque.push({...ref,kind:'citation'});
 opaque.sort((a,b)=>a.start-b.start||b.end-a.end);
 const view=scanInlineStructures(text,opaque);let boundary=0;
 return{...view,signature:view.atoms.map(row=>row.editableInline?['inline',boundary,row.raw]:(boundary++,null)).filter(Boolean),critical:view.atoms.filter(row=>!row.editableInline&&row.kind!=='math'&&row.kind!=='citation').map(row=>row.raw)};
}
export function validateInlineStructureText(text,source){const view=inlineStructureView(text,source);if(view.issues.length)fail('PROTECTED_TOKEN_CHANGED',`${view.issues[0].reason} Your current editor text is retained.`);return view;}
export function prepareInlineStructureIntent(source,text,project,language){
 const current=validateInlineStructureText(text,source),baseline=inlineStructureView(source.source,source);
 if(!same(current.critical,baseline.critical))fail('PROTECTED_TOKEN_CHANGED','Existing labels, document structure and unknown commands must remain unchanged. Your current editor text is retained.');
 if(same(current.signature,baseline.signature))return{};
 return{inlineStructureIntent:{schemaVersion:1,projectId:project.id,snapshotId:project.snapshotId,segmentId:source.id,sourceHash:hash(source),language,syntaxHash:proof(project),before:baseline.signature,after:current.signature}};
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
