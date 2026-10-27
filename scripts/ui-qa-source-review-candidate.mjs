import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {loadPlaywright,browserOptions} from './ui-qa-support.mjs';

const root=path.resolve(import.meta.dirname,'..'),output=path.join(root,'work/ui-source-review-candidate-qa');await mkdir(output,{recursive:true});
const bridge=`export const api=(action,payload={})=>window.__api(action,payload);export const getHostState=()=>({mode:'local-preview',connected:false});export const sendToHost=async()=>{throw Error('No model delivery in this synthetic fixture')};export const subscribe=fn=>{window.__publish=fn;return()=>{}};`;
const bundle=await build({entryPoints:[path.join(root,'ui/app.mjs')],bundle:true,write:false,format:'iife',platform:'browser',define:{__PDF_WORKER_SOURCE__:"''"},plugins:[{name:'source-review-candidate-fixture',setup(b){b.onResolve({filter:/^\.\/bridge\.mjs$/},()=>({path:'bridge',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:bridge,loader:'js'}));}}]});
let html=await readFile(path.join(root,'ui/index.html'),'utf8');html=html.replace(/<link[^>]*href="\.\/style\.css"[^>]*>/,`<style>${await readFile(path.join(root,'ui/style.css'),'utf8')}</style>`).replace(/<script[^>]*src="\.\/app\.mjs"[^>]*><\/script>/,()=>`<script>${bundle.outputFiles[0].text.replaceAll('</script','<\\/script')}</script>`);
const{chromium}=await loadPlaywright(),browser=await chromium.launch(browserOptions),page=await browser.newPage({viewport:{width:1440,height:1000}}),checks=[],errors=[],check=name=>{checks.push(name);console.log(name);};page.on('pageerror',error=>errors.push(error.message));
await page.route('https://source-review-candidate.invalid/**',route=>route.fulfill({contentType:'text/html',body:html}));
await page.addInitScript(()=>{
 window.__reset=(mode='opaque')=>{
  const source={id:'p1',path:'main.tex',startByte:40,endByte:90,source:'An original \\Opaque{claim} keeps $x=1$.',displayText:'An original \\Opaque{claim} keeps $x=1$.',sourceHash:'a'.repeat(64),beforeHash:'a'.repeat(64),protectedTokens:[{id:'math',raw:'$x=1$',kind:'math'}],translatable:true,requestable:true,writableSource:mode==='ordinary',sourceReviewAvailable:true};
  const draft={text:'作者的完整当前意图，保留待审阅的新结构。',revision:4,sourceHash:source.sourceHash,origin:'human',status:'saved',...(mode==='ordinary'?{}:{sourceReviewRequired:true,sourceReviewDiagnostics:[{code:'SOURCE_REVIEW_REQUIRED',message:'Review the exact TeX candidate.'}]})};
  window.__state={project:{id:'synthetic-raw-review',snapshotId:'snapshot-original',mainFile:'main.tex',sourceLanguage:'en',targetLanguage:'zh-CN'},segments:[source],readingParagraphs:[source],translations:{'zh-CN':{p1:draft}},languagePreferences:{uiLanguage:'en',translationLanguage:'zh-CN'},capabilities:{codexChat:false,secureCompile:true,directApply:true},chat:{busy:false,messages:[]},requests:[],proposals:[],transactions:[],builds:[],jobs:[],comments:[],reviewNotes:[],alignments:[],markdownContext:{references:{citations:{},labels:{}},macros:{}}};
  window.__calls=[];window.__holdPrepare=false;window.__releasePrepare=null;window.__sequence=0;window.__publish?.(structuredClone(window.__state));
 };
 window.__ready=()=>{
  window.__reset('opaque');const state=window.__state,source=state.segments[0],draft=state.translations['zh-CN'].p1;
  state.requests=[{requestId:'raw-request',projectId:state.project.id,snapshotId:state.project.snapshotId,kind:'revision',mode:'source-review',status:'completed',language:'zh-CN',draftRevisions:{p1:4},translationUnitRevisions:{p1:4},segmentIds:['p1'],sourceReview:{requiresHumanSourceReview:true},segments:[{id:'p1',segmentId:'p1',sourceHash:source.sourceHash,beforeHash:source.sourceHash,text:source.source,rawSource:source.source,translationDraft:structuredClone(draft),draftReview:{mode:'raw-tex-source-review',draftRevision:4}}]}];
  state.proposals=[{proposalId:'raw-proposal',projectId:state.project.id,baseSnapshotId:state.project.snapshotId,reason:'Review the complete raw TeX candidate.',context:{requestId:'raw-request',mode:'source-review',requiresHumanSourceReview:true},author:'ai',reviewState:'pending',applicationState:'notApplied',edits:[{segmentId:'p1',path:'main.tex',beforeHash:source.sourceHash,before:source.source,replacement:'A revised \\newcommand{\\Fresh}{claim}\\Fresh keeps $x=2$.'}]}];
  state.transactions=[{transactionId:'raw-transaction',projectId:state.project.id,baseSnapshotId:state.project.snapshotId,state:'ready',proposalIds:['raw-proposal'],requiresHumanSourceReview:true,sourceReview:{requiresHumanSourceReview:true},candidateHash:'c'.repeat(64),buildId:'raw-build'}];
  state.builds=[{buildId:'raw-build',kind:'candidate',status:'success',snapshotId:state.project.snapshotId,candidateHash:'c'.repeat(64),pdfHash:'d'.repeat(64),isolation:{verified:true}}];window.__publish?.(structuredClone(state));
 };
 window.__reset();
 window.__api=async(action,payload={})=>{
  window.__calls.push({action,payload:structuredClone(payload)});const state=window.__state;
  if(action==='state')return structuredClone(state);
  if(action==='createRequest'){
   const draft=state.translations['zh-CN'].p1,source=state.segments[0],request={requestId:'prepared-'+(++window.__sequence),projectId:state.project.id,snapshotId:state.project.snapshotId,status:'pending',kind:payload.kind,language:payload.language||'zh-CN',prompt:payload.prompt||'',mode:payload.mode||'protected',segmentIds:payload.segmentIds,segments:[{id:'p1',segmentId:'p1',sourceHash:source.sourceHash,beforeHash:source.sourceHash,text:source.source,translationDraft:structuredClone(draft)}]};state.requests.push(request);return structuredClone(request);
  }
  if(action==='prepareAcceptance'){
   if(window.__holdPrepare)await new Promise(resolve=>window.__releasePrepare=resolve);
   return{transactionId:payload.transactionId,candidateHash:'c'.repeat(64),buildId:'raw-build',confirmationToken:'synthetic-raw-human-token',expiresAt:new Date(Date.now()+60000).toISOString(),requiresHumanSourceReview:true};
  }
  if(action==='applyTransaction'){
   state.transactions[0].state='applied';state.transactions[0].afterSnapshotId='snapshot-applied';state.proposals[0].applicationState='applied';state.proposals[0].transactionId='raw-transaction';state.project.snapshotId='snapshot-applied';return{state:'applied',transactionId:payload.transactionId,snapshotId:'snapshot-applied',englishPdfBuildId:'raw-build'};
  }
  throw Error('Unexpected synthetic source-review action '+action);
 };
});
const calls=action=>page.evaluate(action=>window.__calls.filter(row=>row.action===action),action),closeRequest=()=>page.locator('#request-dialog .close-dialog').click();
try{
 await page.goto('https://source-review-candidate.invalid/');await page.locator('#translation-p1').waitFor();
 assert.equal(await page.locator('#propose-selected').isEnabled(),true);await page.locator('#propose-selected').click();await page.waitForFunction(()=>window.__calls.some(row=>row.action==='createRequest'));
 assert.equal(await page.locator('#request-source-review-option').isVisible(),true);assert.equal(await page.locator('#request-source-review').isChecked(),true);assert.equal((await calls('createRequest')).at(-1).payload.mode,'source-review');assert.equal((await calls('prepareAcceptance')).length,0);assert.equal((await calls('applyTransaction')).length,0);await closeRequest();
 check('an exact source-review-available opaque paragraph prepares a raw candidate without disabling the author request or granting source approval');
 await page.evaluate(()=>window.__reset('ordinary'));await page.locator('#propose-selected').click();await page.waitForFunction(()=>window.__calls.some(row=>row.action==='createRequest'));assert.equal(await page.locator('#request-source-review').isChecked(),false);assert.notEqual((await calls('createRequest')).at(-1).payload.mode,'source-review');
 await page.locator('#request-source-review').check();await page.locator('#prepare-request').click();await page.waitForFunction(()=>window.__calls.filter(row=>row.action==='createRequest').at(-1)?.payload.mode==='source-review');assert.deepEqual((await calls('createRequest')).at(-1).payload.segmentIds,['p1']);await closeRequest();
 check('ordinary protected revision remains the default while the optional raw mode retains the same exact selected paragraph');
 await page.evaluate(()=>window.__ready());await page.locator('#writeback-english').click();await page.locator('#acceptance-dialog').waitFor({state:'visible'});
 assert.match(await page.locator('#acceptance-review-label').textContent(),/TeX/i);assert.equal(await page.locator('#acceptance-reviewed').isChecked(),false);assert.equal(await page.locator('#confirm-apply').isDisabled(),true);assert.equal((await calls('prepareAcceptance')).length,0);assert.equal((await calls('applyTransaction')).length,0);
 check('a compiled raw candidate opens an explicit TeX review and obtains no token on opening or polling');
 await page.locator('#acceptance-reviewed').check();assert.equal(await page.locator('#confirm-apply').isEnabled(),true);await page.locator('#acceptance-reviewed').uncheck();await page.locator('#acceptance-form').dispatchEvent('submit');assert.equal((await calls('prepareAcceptance')).length,0);assert.equal((await calls('applyTransaction')).length,0);await page.locator('#cancel-acceptance').click();
 check('an unchecked or cancelled raw review cannot obtain acceptance or apply source, even through a dispatched submit');
 await page.evaluate(()=>window.__ready());await page.locator('#writeback-english').click();await page.locator('#acceptance-reviewed').check();await page.locator('#confirm-apply').click();await page.waitForFunction(()=>window.__calls.some(row=>row.action==='applyTransaction'));
 const prepared=await calls('prepareAcceptance'),applied=await calls('applyTransaction');assert.equal(prepared.length,1);assert.deepEqual(prepared[0].payload,{transactionId:'raw-transaction',sourceReviewConfirmed:true});assert.equal(applied.length,1);assert.equal(applied[0].payload.transactionId,'raw-transaction');assert.equal(applied[0].payload.confirmationToken,'synthetic-raw-human-token');assert.equal(await page.evaluate(()=>window.__state.translations['zh-CN'].p1.sourceReviewRequired),true);
 check('only explicit checked submission requests raw source confirmation and applies its exact transaction and returned token once');
 for(const drift of ['source','draft','candidate','cancel']){
  await page.evaluate(()=>{window.__ready();window.__holdPrepare=true;});await page.locator('#writeback-english').click();await page.locator('#acceptance-reviewed').check();await page.locator('#confirm-apply').click();await page.waitForFunction(()=>Boolean(window.__releasePrepare));
  if(drift==='cancel')await page.locator('#cancel-acceptance').click();
  await page.evaluate(drift=>{if(drift==='source')window.__state.project.snapshotId='snapshot-changed';if(drift==='draft')window.__state.translations['zh-CN'].p1.revision++;if(drift==='candidate')window.__state.transactions[0].candidateHash='f'.repeat(64);window.__publish(structuredClone(window.__state));window.__releasePrepare();},drift);
  await page.waitForFunction(()=>document.querySelector('#acceptance-error').hidden===false||!document.querySelector('#acceptance-dialog').open);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal((await calls('applyTransaction')).length,0,drift);assert.equal(await page.evaluate(()=>window.__state.translations['zh-CN'].p1.text),'作者的完整当前意图，保留待审阅的新结构。');if(await page.locator('#acceptance-dialog').evaluate(node=>node.open))await page.locator('#cancel-acceptance').click();
 }
 assert.deepEqual(errors,[]);check('independent source, draft, candidate or review cancellation during confirmation aborts before application and preserves the current author text');
 await writeFile(path.join(output,'report.json'),JSON.stringify({syntheticOnly:true,backend:'mocked UI contract; actual compiler and native proof are tested separately',passed:checks.length,checks,pageErrors:errors},null,2));
}catch(error){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw error;}finally{await browser.close();}
