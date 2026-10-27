import {deriveTranslationProtectedTokens} from '../ui/translation-protection.mjs';
import {scanInlineStructures} from '../ui/inline-structures.mjs';
import {topLevelReferences} from './reference-edits.mjs';
import {sha256,commands} from './latex.mjs';
import {inlineSyntaxHazard} from './inline-structure-syntax.mjs';
import {inlineFormattingNames} from '../ui/inline-structures.mjs';
import {inlineBindingRisk} from './inline-binding-risk.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),hash=s=>s.sourceHash||s.beforeHash;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export const inlineStructureFields=['inlineStructureIntent','inlineStructureConflict','inlineStructureUnmapped'];
export const hasInlineStructureIntent=draft=>inlineStructureFields.some(key=>Object.hasOwn(draft||{},key));
export function inlineStructureSafetyForFiles(files,project,{lexicalSafety=()=>false}={}){
 let safe=!project.diagnostics?.some(row=>row.code==='UNSUPPORTED_TEX');
 try{for(const file of files.values()){if(file.text===undefined&&!/\.(?:bbl|ltx|def|cfg)$/iu.test(file.path))continue;const text=file.text??new TextDecoder('utf-8',{fatal:true}).decode(file.bytes);if(inlineSyntaxHazard(text,{allowStockLexical:lexicalSafety(text)})){safe=false;break;}}}catch{safe=false;}
 return{schemaVersion:1,projectId:project.id,snapshotId:project.snapshotId,safe,...inlineBindingRisk(files,project,{lexicalSafety}),fingerprint:sha256(JSON.stringify([project.id,project.snapshotId,project.files]))};
}
function proof(project,omission=false){const value=project.inlineStructureSafety;if((!value?.safe&&!omission)||value?.schemaVersion!==1||value.projectId!==project.id||value.snapshotId!==project.snapshotId||!/^[a-f0-9]{64}$/u.test(value.fingerprint||''))fail('INLINE_STRUCTURE_SOURCE_UNSAFE','New inline controls need a verified source identity. Your draft can be retained and adapted against the protected source inventory.');return value.fingerprint;}
function omissionOnly(before,after){let cursor=0;for(const atom of after){while(cursor<before.length&&!same(before[cursor],atom))cursor++;if(cursor===before.length)return false;cursor++;}return true;}
export function inlineStructureView(text,source){
 const base=deriveTranslationProtectedTokens(text,source.protectedTokens),references=topLevelReferences(text,source),opaque=base.filter(row=>!references.some(ref=>ref.start<=row.start&&ref.end>=row.end));
 for(const ref of references)opaque.push({...ref,kind:'citation'});
 opaque.sort((a,b)=>a.start-b.start||b.end-a.end);
 const view=scanInlineStructures(text,opaque);let boundary=0;
 return{...view,signature:view.atoms.map(row=>row.editableInline?['inline',boundary,row.raw]:(boundary++,null)).filter(Boolean),critical:view.atoms.filter(row=>!row.editableInline&&row.kind!=='math'&&row.kind!=='citation').map(row=>row.raw)};
}
function formattingSpans(text,offset=0,depth=0){if(depth>24)return[];const result=[];for(const command of commands(text)){if(inlineFormattingNames.has(command.name))result.push({start:offset+command.start,end:offset+command.end,raw:command.raw,kind:'structure',opaqueBinding:true});for(const group of command.groups||[])result.push(...formattingSpans(group.inner,offset+group.start+1,depth+1));}return result;}
const riskySymbols=text=>/(?:~|\\[%&#_${} ,;:!])/u.test(text);
/** Unproved surviving invocations keep their complete original arguments. A
 * symbol/active control with unknown arity keeps its entire source range. */
export function originalSourceObjects(source,project){
 const ordinary=inlineStructureView(source.source,source).atoms;if(project.inlineStructureSafety?.safe)return{atoms:ordinary,opaqueBindings:false};
 if(project.inlineStructureSafety?.opaqueSymbolArity&&riskySymbols(source.source))return{atoms:[{start:0,end:source.source.length,raw:source.source,kind:'structure',opaqueBinding:true}],opaqueBindings:true,opaqueRange:true};
 const unsafe=new Set(project.inlineStructureSafety?.reboundControls||inlineFormattingNames),risky=formattingSpans(source.source).filter(range=>project.inlineStructureSafety?.opaqueSymbolArity||unsafe.has(/^\\([A-Za-z]+)/u.exec(range.raw)?.[1]));
 if(!risky.length)return{atoms:ordinary,opaqueBindings:false};
 const formats=[];for(const range of risky.sort((a,b)=>a.start-b.start||b.end-a.end)){if(!formats.some(outer=>range.start<outer.end&&range.end>outer.start)&&!ordinary.some(atom=>!atom.editableInline&&atom.start<=range.start&&atom.end>=range.end))formats.push(range);}
 const protectedAtoms=[...ordinary.filter(atom=>!formats.some(range=>atom.start<range.end&&atom.end>range.start)),...formats].sort((a,b)=>a.start-b.start),atoms=[];let cursor=0;for(const atom of protectedAtoms){if(atom.start>cursor)atoms.push({start:cursor,end:atom.start,raw:source.source.slice(cursor,atom.start),kind:'structure',opaqueBinding:true});atoms.push(atom);cursor=atom.end;}if(cursor<source.source.length)atoms.push({start:cursor,end:source.source.length,raw:source.source.slice(cursor),kind:'structure',opaqueBinding:true});
 return{atoms,opaqueBindings:true,opaqueRange:true};
}
export function survivingUnprovedInline(source,text,project){const objects=originalSourceObjects(source,project);if(!objects.opaqueBindings)return false;const unsafe=new Set(project.inlineStructureSafety?.reboundControls||inlineFormattingNames);return project.inlineStructureSafety?.opaqueSymbolArity&&riskySymbols(text)||formattingSpans(text).some(range=>project.inlineStructureSafety?.opaqueSymbolArity||unsafe.has(/^\\([A-Za-z]+)/u.exec(range.raw)?.[1]));}
export function validateInlineStructureText(text,source){const view=inlineStructureView(text,source);if(view.issues.length)fail('PROTECTED_TOKEN_CHANGED',`${view.issues[0].reason} Your current editor text is retained.`);return view;}
export function prepareInlineStructureIntent(source,text,project,language){
 const current=validateInlineStructureText(text,source),baseline=inlineStructureView(source.source,source);
 if(!same(current.critical,baseline.critical))fail('PROTECTED_TOKEN_CHANGED','Existing labels, document structure and unknown commands must remain unchanged. Your current editor text is retained.');
 if(same(current.signature,baseline.signature))return{};
 const omission=omissionOnly(baseline.signature,current.signature);
 return{inlineStructureIntent:{schemaVersion:1,mode:omission?'existing-inline-omission':'literal-inline-inventory',projectId:project.id,snapshotId:project.snapshotId,segmentId:source.id,sourceHash:hash(source),language,syntaxHash:proof(project,omission),before:baseline.signature,after:current.signature}};
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
