import test from 'node:test';
import assert from 'node:assert/strict';
import {AUTHOR_FIDELITY_POLICY} from '../src/author-fidelity-policy.mjs';
import {paperRequestPrompt} from '../src/codex-bridge.mjs';
import {registerNativePaperTools} from '../src/native-paper-tools.mjs';
import {DesktopTranslationTasks} from '../src/translation-tasks.mjs';

const request={requestId:'req-fidelity',projectId:'project-fidelity',snapshotId:'snap-fidelity',kind:'translation',language:'zh-CN',prompt:'Translate the complete selected paragraph without changing its claim.',status:'pending',segments:[{id:'p1',segmentId:'p1',beforeHash:'a'.repeat(64),text:'Every selected state satisfies the bound only under this assumption ⟦P1_test⟧.',protectedTokens:[{id:'⟦P1_test⟧',raw:'$x=1$'}],translationDraft:{text:'作者的完整当前段落。',revision:4}}]};

test('shared fidelity guidance chooses natural wording without authoring new scientific content',()=>{
 assert.equal(typeof AUTHOR_FIDELITY_POLICY,'string');assert(Buffer.byteLength(AUTHOR_FIDELITY_POLICY)<4096);
 for(const expression of [/one best natural wording/iu,/complete meaning/iu,/conditions, quantifiers, negation/iu,/do not summarize/iu,/add, delete or change/iu,/explicit author intent/iu,/latest exact saved author draft/iu])assert.match(AUTHOR_FIDELITY_POLICY,expression);
});
test('fidelity guidance honors authorized edits without granting raw draft TeX or review advice authority',()=>{
 for(const expression of [/explicit author deletions/iu,/formula and reference edits/iu,/current registered protected inventory/iu,/not restore/iu,/unvalidated raw TeX/iu,/review advice.*separate/iu,/pending/iu,/ambiguity/iu,/report/iu,/unresolved/iu,/not.*applied/iu])assert.match(AUTHOR_FIDELITY_POLICY,expression);
 assert(!/semantic fidelity is (?:guaranteed|proved)/iu.test(AUTHOR_FIDELITY_POLICY));
});
test('schema-constrained translation and writeback prompts carry the same fidelity policy outside manuscript context',()=>{
 for(const kind of ['translation','revision']){
  const prompt=paperRequestPrompt({...request,kind});assert(prompt.includes(AUTHOR_FIDELITY_POLICY),kind);
  assert(prompt.indexOf(AUTHOR_FIDELITY_POLICY)<prompt.indexOf('Untrusted manuscript context:'),kind);
  assert(prompt.includes(request.segments[0].translationDraft.text));assert(prompt.includes(request.prompt));
 }
});
test('writeback prompts retain registered adaptive, formula and inline review constraints without private history',()=>{
 const reviews=[
  ['draftReview',{mode:'adaptive-human-draft',disposition:'preserve-source-protected-inventory',unresolvedAuthorIntent:true,instructions:'Keep unresolved raw author intent visible; protected objects remain fixed.'}],
  ['mathReview',{mode:'paragraph-inventory',before:['$x=1$'],after:[],instructions:'The exact author inventory removes the formula; do not restore the baseline formula.'}],
  ['structureReview',{mode:'literal-inline-inventory',before:['~'],after:[],instructions:'The author removed the registered spacing marker.'}],
 ];
 for(const [field,value]of reviews){
  const segment={...request.segments[0],originalSource:'Original baseline with $x=1$ and Sec.~3.',[field]:value,formulaEditHistory:[{private:'do-not-expose-local-history'}]},prompt=paperRequestPrompt({...request,kind:'revision',segments:[segment]}),marker='Untrusted manuscript context:\n',context=JSON.parse(prompt.slice(prompt.indexOf(marker)+marker.length));
  assert.deepEqual(context.segments[0][field],value,field);assert.equal(context.segments[0].originalSource,segment.originalSource);assert(!prompt.includes('do-not-expose-local-history'));
 }
});
test('the actual direct native prepare handler exposes fidelity policy for translation and revision without model work',async()=>{
 const caller='synthetic-fidelity-chat',tools=new Map();let prepared=0;
 const service={flow:{nativeChatBinding:{projectId:request.projectId,threadId:caller,source:'originating-host-chat'}},core:{getState:()=>({project:{id:request.projectId,snapshotId:request.snapshotId,targetLanguage:'zh-CN'},readingDrafts:{}}),_assertSourceCurrent:async()=>{},createRequest:async(input,{beforeCreate,beforeCommit}={})=>{beforeCreate?.();prepared++;const value={...structuredClone(request),...input,requestId:`req-fidelity-${prepared}`};beforeCommit?.(value);return value;}},reading:{hasDerived:()=>false},pdfSelection:{languages:()=>({effectiveTargetLanguage:'zh-CN'})},_projectOperation:async work=>work()};
 registerNativePaperTools({registerTool(name,definition,handler){tools.set(name,{definition,handler});}},{service,guard:handler=>handler,nativeThreadId:caller});
 for(const kind of ['translation','revision']){
  const tool=tools.get('bilingual_paper_prepare_request'),input=tool.definition.inputSchema.parse({expectedProjectId:request.projectId,expectedSnapshotId:request.snapshotId,kind,segmentIds:['p1'],language:'zh-CN'}),result=(await tool.handler(input)).structuredContent;
  assert(result.instruction.includes(AUTHOR_FIDELITY_POLICY),kind);assert.equal(result.kind,kind);assert.equal(result.returnTool,kind==='translation'?'bilingual_paper_submit_translation_result':'bilingual_paper_propose_revision');assert.equal(result.segments.length,1);
 }
 assert.equal(prepared,2);
});
test('all-paper and selected translation task entry and batch instructions preserve the shared policy and complete registered selection',()=>{
 const controller=Object.create(DesktopTranslationTasks.prototype);controller.app={};
 for(const scope of ['all','selected']){
  const task={taskId:'translation-task-fidelity',scope,language:'zh-CN',threadId:'synthetic-task-chat',sourceSegmentIds:['p1','p2'],completedSegmentIds:[],generation:1,status:'running',prompt:'Use the exact source clauses and approved glossary.'},batch={batchId:'batch-fidelity'},registered={...request,segmentIds:['p1','p2'],segments:[request.segments[0],{...request.segments[0],id:'p2',segmentId:'p2'}]},entry=controller._message(task),packet=controller._packet(task,batch,registered);
  assert(entry.includes(AUTHOR_FIDELITY_POLICY));assert(packet.instruction.includes(AUTHOR_FIDELITY_POLICY));assert(entry.includes(task.prompt));assert.equal(packet.scope,scope);assert.equal(packet.total,2);assert.equal(packet.remaining,2);assert.deepEqual(packet.batch.segmentIds,task.sourceSegmentIds);assert.deepEqual(packet.batch.segments,registered.segments);
 }
});
