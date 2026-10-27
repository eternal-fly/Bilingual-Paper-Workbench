import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadPlaywright,browserOptions} from './ui-qa-support.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const output=path.join(root,'work/ui-background-connection-qa');
await mkdir(output,{recursive:true});
const built=await build({stdin:{contents:`import {initializeBackgroundConnection} from './background-connection.mjs';window.__controller=initializeBackgroundConnection({api:async(...args)=>window.__api(...args),getState:()=>window.__state,refreshState:async()=>window.__controller.adopt(),notify:message=>{document.getElementById('notice').textContent=message;},onBusyChange:value=>{window.__busy=value;},pollIntervalMs:40,maxPolls:3});`,resolveDir:path.join(root,'ui'),sourcefile:'background-connection-qa-entry.mjs'},bundle:true,platform:'browser',format:'iife',write:false});
const html=`<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${await readFile(path.join(root,'ui/style.css'),'utf8')}</style><body><aside id="codex-panel"><div class="chat-heading-actions"></div><details id="chat-settings" open><summary>模型与推理强度</summary><select id="chat-model"><option value="gpt-6-astra">GPT-6 Astra</option></select><select id="chat-effort"><option value="medium">medium</option></select></details></aside><p id="notice" role="status"></p><script>${built.outputFiles[0].text.replaceAll('</script','<\\/script')}</script></body></html>`;
const{chromium}=await loadPlaywright();
const browser=await chromium.launch(browserOptions);
const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
const checks=[],errors=[];
const check=name=>{checks.push(name);console.log(name);};
page.on('pageerror',error=>errors.push(error.message));
await page.route('http://127.0.0.1:9163/',route=>route.fulfill({contentType:'text/html',body:html}));
await page.addInitScript(()=>{
 window.__calls=[];
 window.__readyState={project:{id:'synthetic-paper',snapshotId:'snapshot-1',mainFile:'main.tex',files:[{path:'main.tex',hash:'source-hash-1'}]},capabilities:{backgroundConnection:true},nativeChatBinding:{projectId:'synthetic-paper',threadId:'same-paper-chat',title:'Synthetic paper chat',model:'gpt-6-astra',effort:'medium',verifiedAt:'2026-01-01T00:00:00.000Z'},chat:{model:'gpt-6-astra',effort:'medium',busy:false,models:[{id:'gpt-6-astra',displayName:'GPT-6 Astra'}]},jobs:[],backgroundConnection:{phase:'inactive',serviceOnline:false}};
 window.__state={project:null,capabilities:{}};
 window.__phase='waiting-desktop-release';
 window.__api=async(action,payload)=>{
  window.__calls.push({action,payload:structuredClone(payload)});
  if(window.__hold&&action==='backgroundConnectionActivate')await new Promise(resolve=>{window.__unhold=resolve;});
  if(window.__error)throw Object.assign(Error('Synthetic connection error.'),{code:window.__error});
  const binding={...window.__state.nativeChatBinding};
  if(action==='backgroundConnectionPrepare')return{handoffId:'reviewed-handoff',projectId:'synthetic-paper',snapshotId:window.__state.project.snapshotId,...binding,threadId:window.__preparedThread||binding.threadId,model:window.__preparedModel||binding.model,phase:'prepared'};
  if(action==='backgroundConnectionActivate'||action==='backgroundConnectionStatus'){
   const result={phase:window.__phase,serviceOnline:true,binding};window.__state.backgroundConnection=result;return result;
  }
  if(action==='backgroundConnectionRelease'){
   const result={phase:'released',serviceOnline:true,binding};window.__state.backgroundConnection=result;return result;
  }
  throw Error('Unexpected action '+action);
 };
});
try{
 await page.goto('http://127.0.0.1:9163/');
 assert.deepEqual(errors,[]);
 assert.equal(await page.locator('#background-connection-controls').isHidden(),true);
 assert.equal(await page.evaluate(()=>window.__calls.length),0);
 await page.evaluate(()=>{window.__state=window.__readyState;window.__controller.adopt();});
 check('an empty first-load state initializes without exceptions or requests and can adopt a later paper');
 assert.equal(await page.locator('#background-connection-open').isVisible(),true);
 assert.equal(await page.locator('#chat-model').isVisible(),true);
 assert.equal(await page.locator('#chat-effort').isVisible(),true);
 assert.ok((await page.locator('#background-connection-summary').textContent()).includes('Synthetic paper chat'));
 assert.equal(await page.evaluate(()=>window.__calls.length),0);
 check('a compact paper-only connection control shows the trusted binding without hiding model selection or sending requests on mount');

 await page.locator('#background-connection-open').click();
 await page.waitForFunction(()=>!document.getElementById('background-connection-activate').disabled);
 assert.ok((await page.locator('#background-connection-identity').textContent()).includes('same-paper-chat'));
 assert.ok((await page.locator('#background-connection-identity').textContent()).includes('gpt-6-astra'));
 assert.equal(await page.locator('#background-connection-dialog input').count(),0);
 assert.deepEqual(await page.evaluate(()=>window.__calls.map(call=>call.action)),['backgroundConnectionPrepare']);
 await page.screenshot({path:path.join(output,'background-connection-review-light.png'),fullPage:true});
 check('opening prepares only the persisted exact paper chat and presents its verified identity without manual ID copying');

 await page.evaluate(()=>{window.__state.project.files[0].hash='source-hash-2';window.__controller.adopt();});
 assert.equal(await page.locator('#background-connection-activate').isDisabled(),true);
 assert.ok((await page.locator('#background-connection-status').textContent()).includes('变化'));
 await page.locator('#background-connection-close').click();
 await page.locator('#background-connection-open').click();
 await page.waitForFunction(()=>!document.getElementById('background-connection-activate').disabled);
 check('changed paper contents invalidate the reviewed handoff and require preparation against the current source');

 await page.evaluate(()=>{window.__hold=true;});
 await page.locator('#background-connection-activate').click();
 await page.waitForFunction(()=>Boolean(window.__unhold));
 assert.equal(await page.locator('#background-connection-activate').isDisabled(),true);
 assert.equal(await page.locator('#background-connection-close').isDisabled(),true);
 assert.equal(await page.evaluate(()=>window.__busy),true);
 await page.evaluate(()=>{window.__hold=false;window.__unhold();});
 await page.waitForFunction(()=>window.__calls.filter(call=>call.action==='backgroundConnectionStatus').length===3);
 assert.ok((await page.locator('#background-connection-status').textContent()).includes('桌面端'));
 assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call.action==='backgroundConnectionActivate').length),1);
 assert.ok(await page.evaluate(()=>window.__calls.every(call=>['backgroundConnectionPrepare','backgroundConnectionActivate','backgroundConnectionStatus'].includes(call.action))));
 check('writer contention polls connection status with bounded retries and never sends model messages, duplicates activation, or controls the desktop');

 await page.evaluate(()=>{window.__phase='connected';});
 await page.locator('#background-connection-check').click();
 await page.waitForFunction(()=>window.__state.backgroundConnection.phase==='connected');
 assert.ok((await page.locator('#background-connection-summary').textContent()).includes('后台已连接'));
 assert.ok((await page.locator('#background-connection-summary').textContent()).includes('Synthetic paper chat'));
 assert.ok((await page.locator('#background-connection-status').textContent()).includes('其他聊天'));
 await page.locator('#background-connection-close').click();
 assert.equal(await page.locator('#chat-model').isVisible(),true);
 check('manual connection checks attach the same paper identity and show background ownership while retaining model and effort controls');

 await page.evaluate(()=>{window.__state.chat.busy=true;window.__controller.adopt();});
 assert.equal(await page.locator('#background-connection-release').isDisabled(),true);
 await page.evaluate(()=>{window.__state.chat.busy=false;window.__controller.adopt();});
 await page.locator('#background-connection-release').click();
 await page.waitForFunction(()=>window.__state.backgroundConnection.phase==='released');
 assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call.action==='backgroundConnectionRelease').length),1);
 assert.deepEqual(await page.evaluate(()=>window.__calls.at(-1).payload),{threadId:'same-paper-chat',expectedProjectId:'synthetic-paper',expectedSnapshotId:'snapshot-1'});
 check('an explicit idle-only release targets only the reviewed paper chat and preserves the background service');

 await page.evaluate(()=>{window.__error='BACKGROUND_SERVICE_UNAVAILABLE';});
 await page.locator('#background-connection-open').click();
 await page.locator('#background-connection-error').waitFor();
 assert.ok((await page.locator('#background-connection-error').textContent()).includes('BACKGROUND_SERVICE_UNAVAILABLE'));
 assert.equal(await page.locator('#background-connection-activate').isDisabled(),true);
 await page.locator('#background-connection-close').click();
 await page.evaluate(()=>{window.__error=null;window.__state.nativeChatBinding.projectId='unrelated-paper';window.__state.backgroundConnection={phase:'inactive',serviceOnline:false};window.__controller.adopt();});
 assert.ok(!(await page.locator('#background-connection-summary').textContent()).includes('same-paper-chat'));
 assert.ok(!(await page.locator('#background-connection-summary').textContent()).includes('Synthetic paper chat'));
 assert.deepEqual(errors,[]);
 check('transport errors retain a usable dialog and a binding from another paper never appears as the current target');

 await page.evaluate(()=>{window.__state.nativeChatBinding.projectId='synthetic-paper';window.__preparedThread='different-chat';});
 await page.locator('#background-connection-open').click();
 await page.locator('#background-connection-error').waitFor();
 assert.equal(await page.locator('#background-connection-activate').isDisabled(),true);
 assert.ok((await page.locator('#background-connection-error').textContent()).includes('无法核验'));
 await page.locator('#background-connection-close').click();
 await page.evaluate(()=>{window.__preparedThread=null;window.__preparedModel='different-model';});
 await page.locator('#background-connection-open').click();
 await page.locator('#background-connection-error').waitFor();
 assert.equal(await page.locator('#background-connection-activate').isDisabled(),true);
 await page.locator('#background-connection-close').click();
 check('a prepared target or model that differs from the saved paper identity and explicit selection cannot be activated');

 await page.evaluate(()=>{window.__preparedModel=null;document.documentElement.dataset.theme='dark';});
 await page.setViewportSize({width:720,height:600});
 await page.locator('#background-connection-open').click();
 await page.waitForFunction(()=>!document.getElementById('background-connection-activate').disabled);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.equal(await page.locator('#background-connection-activate').isVisible(),true);
 await page.screenshot({path:path.join(output,'background-connection-review-dark-narrow.png'),fullPage:true});
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#background-connection-dialog').isVisible(),false);
 assert.equal(await page.evaluate(()=>document.activeElement?.id),'background-connection-open');
 check('the review uses inherited light and dark tokens with narrow-screen wrapping, keyboard dismissal, and restored focus');
 await page.evaluate(()=>{document.documentElement.lang='en';window.__controller.adopt();});
 assert.equal(await page.locator('#background-connection-open').textContent(),'Enable background connection');
 await page.locator('#background-connection-open').click();await page.waitForFunction(()=>!document.getElementById('background-connection-activate').disabled);
 assert.equal(await page.locator('#background-connection-title').textContent(),'Connect the paper chat');
 assert.ok(!/[\u3400-\u9fff]/u.test(await page.locator('#background-connection-dialog').textContent()));
 await page.keyboard.press('Escape');
 check('background connection controls and identity help render fully in English while preserving the same binding');

 await page.setViewportSize({width:1440,height:900});
 await page.evaluate(()=>{document.documentElement.dataset.theme='light';window.__calls=[];window.__state={project:null,jobs:[],chat:{busy:false,messages:[]},capabilities:{backgroundConnection:true},originatingChat:{threadId:'opening-chat',phase:'pending-paper',verified:false,autoConnect:true},backgroundConnection:{phase:'inactive',serviceOnline:true}};window.__controller.adopt();});
 assert.equal(await page.locator('#background-connection-controls').isVisible(),true);
 assert.ok((await page.locator('#background-connection-summary').textContent()).includes('Waiting for a paper'));
 assert.ok((await page.locator('#background-connection-summary').textContent()).includes('opening-chat'));
 assert.equal(await page.evaluate(()=>window.__calls.length),0);
 check('the chat that opened an empty workbench is identified while waiting for its source without manual binding or requests');

 await page.evaluate(()=>{window.__state={...window.__readyState,nativeChatBinding:null,backgroundConnection:{phase:'inactive',serviceOnline:true},originatingChat:{threadId:'opening-chat',phase:'verifying',verified:false,autoConnect:true,projectId:'synthetic-paper',snapshotId:'snapshot-1'}};window.__controller.adopt();});
 await page.locator('#background-connection-open').click();
 assert.equal(await page.locator('#background-connection-dialog').isVisible(),true);
 assert.equal(await page.locator('#background-connection-error').isVisible(),false);
 assert.equal(await page.locator('#background-connection-activate').isVisible(),false);
 assert.ok((await page.locator('#background-connection-status').textContent()).includes('Verifying'));
 assert.equal(await page.evaluate(()=>window.__calls.length),0);
 await page.keyboard.press('Escape');
 check('automatic origin verification opens a status-only view instead of issuing a manual prepare that could report CHAT_BINDING_REQUIRED');

 await page.evaluate(()=>{const binding={projectId:'synthetic-paper',threadId:'opening-chat',title:'Current paper task',model:'gpt-6-astra',effort:'max'};window.__state.nativeChatBinding=binding;window.__state.backgroundConnection={phase:'waiting-desktop-release',serviceOnline:true,binding};window.__state.originatingChat={...binding,phase:'waiting-desktop-release',verified:true,autoConnect:true};window.__state.chat.messages=[{id:'history-1',role:'user',text:'Preserved history.'}];window.__controller.adopt();});
 await page.locator('#background-connection-open').click();
 assert.ok((await page.locator('#background-connection-status').textContent()).includes('Desktop'));
 assert.ok((await page.locator('#background-connection-identity').textContent()).includes('opening-chat'));
 assert.ok((await page.locator('#background-connection-identity').textContent()).includes('max'));
 assert.equal(await page.locator('#background-connection-error').isVisible(),false);
 assert.equal(await page.evaluate(()=>window.__calls.length),0);
 await page.screenshot({path:path.join(output,'origin-waiting-english.png'),fullPage:true});
 await page.keyboard.press('Escape');
 check('verified origin writer contention shows the exact inherited model and effort while backend-owned retries need no UI activation or error dialog');

 await page.evaluate(()=>{window.__state.originatingChat.phase='connected';window.__state.backgroundConnection.phase='connected';window.__state.chat={...window.__state.chat,connected:true,threadId:'opening-chat',model:'gpt-6-astra',effort:'max'};document.getElementById('chat-effort').append(new Option('max','max'));document.getElementById('chat-effort').value='max';window.__controller.adopt();});
 assert.ok((await page.locator('#background-connection-summary').textContent()).includes('Current paper task'));
 assert.ok((await page.locator('#background-connection-summary').textContent()).includes('max'));
 assert.equal(await page.locator('#chat-model').isVisible(),true); assert.equal(await page.locator('#chat-effort').inputValue(),'max');
 assert.deepEqual(await page.evaluate(()=>window.__state.chat.messages),[{id:'history-1',role:'user',text:'Preserved history.'}]);
 assert.equal(await page.evaluate(()=>window.__calls.length),0);
 await page.screenshot({path:path.join(output,'origin-connected-english.png'),fullPage:true});
 check('successful automatic attachment preserves exact chat history and inherited selection while leaving model controls available');

 await page.evaluate(()=>{window.__state.nativeChatBinding={...window.__state.nativeChatBinding,threadId:'explicit-saved-chat',title:'Saved manual binding'};window.__state.backgroundConnection={phase:'released',serviceOnline:true,binding:window.__state.nativeChatBinding};window.__state.originatingChat.phase='preserved-binding';window.__controller.adopt();});
 assert.ok((await page.locator('#background-connection-summary').textContent()).includes('Saved manual binding'));
 assert.ok((await page.locator('#background-connection-summary').textContent()).includes('differs'));
 assert.equal(await page.evaluate(()=>window.__calls.length),0);
 check('an existing explicit different-chat binding remains visible and the UI explains the conflict without overwriting or reconnecting it');

 await page.evaluate(()=>{window.__state.nativeChatBinding=null;window.__state.backgroundConnection={phase:'inactive',serviceOnline:true};window.__state.originatingChat={threadId:'opening-chat',projectId:'synthetic-paper',phase:'failed',verified:false,autoConnect:true,error:{code:'ORIGIN_METADATA_UNAVAILABLE',message:'Origin metadata is temporarily unavailable.'}};window.__api=async(action,payload)=>{window.__calls.push({action,payload});if(action!=='retryOriginChat')throw Error('Unexpected action '+action);window.__state.originatingChat.phase='verifying';return window.__state.originatingChat;};window.__controller.adopt();});
 await page.locator('#background-connection-open').click();
 assert.ok((await page.locator('#background-connection-status').textContent()).includes('temporarily unavailable'));
 await page.locator('#background-origin-retry').click();
 await page.waitForFunction(()=>window.__state.originatingChat.phase==='verifying');
 assert.deepEqual(await page.evaluate(()=>window.__calls),[{action:'retryOriginChat',payload:{}}]);
 assert.equal(await page.locator('#background-connection-error').isVisible(),false);
 await page.screenshot({path:path.join(output,'origin-status-english.png'),fullPage:true});
 await page.keyboard.press('Escape');
 check('an explicit retry rechecks only the fixed host-origin identity without prompting for a chat ID or sending any model message');

 await page.screenshot({path:path.join(output,'background-connection.png'),fullPage:true});
 await writeFile(path.join(output,'report.json'),JSON.stringify({syntheticOnly:true,success:true,passed:checks.length,checks,errors},null,2));
}catch(error){
 await page.screenshot({path:path.join(output,'failed.png'),fullPage:true}).catch(()=>{});
 await writeFile(path.join(output,'report.json'),JSON.stringify({syntheticOnly:true,success:false,passed:checks.length,checks,errors,error:error.message},null,2));
 throw error;
}finally{await browser.close();}
