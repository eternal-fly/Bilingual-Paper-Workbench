import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, browserOptions } from './ui-qa-support.mjs';

// Exact identity, model and transcript are synthetic; no account or paper is read.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'work/ui-origin-chat-qa');
await mkdir(output, { recursive: true });
const bundle = await build({ stdin: { contents: `import { initializeChat } from './ui/chat.mjs';
window.__calls = []; window.__origin = null; window.__modelError = null; window.__deferModels = false;
window.__chat = { threadId: null, connected: false, status: 'idle', messages: [] };
const api = async (action, payload = {}) => {
  window.__calls.push({action, payload});
  if (action === 'models') {
    if (window.__deferModels) await new Promise(resolve => { window.__resolveModels = resolve; });
    if (window.__modelError) throw Object.assign(new Error(window.__modelError.message), {code: window.__modelError.code});
    return {models: [{id:'synthetic-astra',displayName:'Synthetic Astra',supportedReasoningEfforts:['medium','max']},{id:'synthetic-alternate',displayName:'Synthetic Alternate',supportedReasoningEfforts:['low','high']}]};
  }
  if (action === 'chatState') return structuredClone(window.__chat);
  if (action === 'chatSelectModel') { Object.assign(window.__chat, payload); return structuredClone(window.__chat); }
  throw new Error('Unexpected synthetic action: ' + action);
};
window.__controller = initializeChat({api, notify:()=>{}, getOriginatingChat:()=>window.__origin});
window.__adopt = (origin, chat = {}) => { window.__origin = origin; Object.assign(window.__chat, chat); window.__controller.adopt(window.__chat, {codexChat:true}, 'synthetic-project'); };
`, resolveDir: root, sourcefile: 'synthetic-origin-chat.mjs', loader: 'js' }, bundle: true, format: 'iife', platform: 'browser', write: false });
let html = await readFile(path.join(root, 'ui/index.html'), 'utf8');
html = html.replace(/<link[^>]*href="\.\/style\.css"[^>]*>/, `<style>${await readFile(path.join(root, 'ui/style.css'), 'utf8')}</style>`).replace(/<script[^>]*src="\.\/app\.mjs"[^>]*><\/script>/, () => `<script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`);
const { chromium } = await loadPlaywright();
const browser = await chromium.launch(browserOptions);
const errors = [], results = [];
const origin = {threadId:'synthetic-origin',title:'Synthetic opening chat',model:'synthetic-astra',effort:'max',verified:true,autoConnect:true,phase:'waiting-desktop-release'};
const history = [{id:'synthetic-history',role:'assistant',status:'completed',text:'A retained synthetic history message.'}];
const check = name => { results.push({name,passed:true}); console.log(name); };
const pages = [];
const scenario = async (value, chat = {}) => {
  const page = await browser.newPage({viewport:{width:1500,height:1000}, reducedMotion:'reduce'}); pages.push(page);
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(html);
  await page.evaluate(({value,chat}) => { window.__adopt(value, chat); window.__controller.toggle(true,false); }, {value,chat});
  return page;
};
const adopt = (page, value, chat = {}) => page.evaluate(({value,chat}) => window.__adopt(value,chat), {value,chat});
const modelCalls = page => page.evaluate(() => window.__calls.filter(call => call.action==='models').length);
try {
  const waiting = await scenario({...origin,phase:'pending-paper',verified:false,model:null,effort:null});
  await new Promise(resolve => setTimeout(resolve,1100));
  assert.equal(await modelCalls(waiting),0);
  assert.deepEqual(await waiting.evaluate(() => window.__calls),[]);
  check('opening before source import makes no competing catalog, chat read or model request');

  for (const phase of ['waiting-paper-operation','verifying','connecting','waiting-desktop-release']) {
    await adopt(waiting,{...origin,phase}, {threadId:origin.threadId,model:origin.model,effort:origin.effort,connected:false,messages:history});
    await waiting.evaluate(() => { window.__controller.toggle(false,false); window.__controller.toggle(true,false); });
    assert.equal(await modelCalls(waiting),0);
  }
  check('every automatic connection phase suppresses catalog loads when adopting and reopening');

  assert.equal(await waiting.locator('#chat-model').inputValue(),origin.model);
  assert.equal(await waiting.locator('#chat-effort').inputValue(),'max');
  assert.equal(await waiting.locator('#chat-thread').textContent(),origin.threadId);
  assert.match(await waiting.locator('#chat-binding-note').textContent(),/Synthetic opening chat/);
  assert.match(await waiting.locator('#chat-status').textContent(),/Waiting for Desktop/);
  assert.equal(await waiting.locator('#chat-error').isVisible(),false);
  check('verified waiting state shows the exact originating identity and inherited model and effort without an error');

  for (const id of ['chat-model','chat-effort','chat-connect','chat-send','chat-input','chat-disconnect']) assert.equal(await waiting.locator(`#${id}`).isDisabled(),true,id);
  assert.equal(await waiting.evaluate(() => window.__controller.isReady()),false);
  assert.equal(await waiting.locator('#chat-messages .chat-message').textContent().then(text => text.includes(history[0].text)),true);
  check('pending connection preserves history and keeps manual model, message and release actions inactive');

  await adopt(waiting,{...origin,phase:'verifying',verified:false});
  assert.equal(await waiting.locator('#chat-model').inputValue(),'');
  assert.equal(await waiting.locator('#chat-effort').inputValue(),'');
  assert.match(await waiting.locator('#chat-status').textContent(),/Verifying/);
  check('unverified metadata cannot be presented as an inherited model choice');

  // Allow a catalog request to enter before the trusted origin arrives.
  const race = await browser.newPage({viewport:{width:1500,height:1000}}); pages.push(race);race.on('pageerror',error=>errors.push(error.message));
  await race.setContent(html);
  await race.evaluate(() => { window.__deferModels=true;window.__modelError={code:'NATIVE_CHAT_IN_USE',message:'Synthetic Desktop writer busy.'};window.__adopt(null);window.__controller.toggle(true,false); });
  await race.waitForFunction(() => typeof window.__resolveModels==='function');
  await adopt(race,origin,{threadId:origin.threadId,connected:false,model:origin.model,effort:origin.effort,messages:history});
  await race.evaluate(() => window.__resolveModels());
  await race.waitForFunction(() => document.querySelector('#chat-model').value==='synthetic-astra');
  assert.equal(await race.locator('#chat-error').isVisible(),false);
  assert.equal(await modelCalls(race),1);
  assert.match(await race.locator('#chat-status').textContent(),/Waiting for Desktop/);
  check('a catalog request already in flight cannot replace automatic waiting with a stale writer-busy error');

  const prior = await browser.newPage({viewport:{width:1500,height:1000}}); pages.push(prior);prior.on('pageerror',error=>errors.push(error.message));
  await prior.setContent(html);
  await prior.evaluate(() => { window.__modelError={code:'NATIVE_CHAT_IN_USE',message:'Synthetic previous writer busy.'};window.__adopt(null);window.__controller.toggle(true,false); });
  await prior.waitForFunction(() => !document.querySelector('#chat-error').hidden);
  await adopt(prior,origin,{threadId:origin.threadId,connected:false,model:origin.model,effort:origin.effort});
  assert.equal(await prior.locator('#chat-error').isVisible(),false);
  await prior.evaluate(() => { window.__modelError=null; });
  await adopt(prior,{...origin,phase:'connected'},{connected:true,messages:history});
  await prior.waitForFunction(() => document.querySelector('#chat-model option[value="synthetic-alternate"]'));
  assert.equal(await modelCalls(prior),2);
  assert.equal(await prior.locator('#chat-model').inputValue(),origin.model);
  assert.equal(await prior.locator('#chat-effort').inputValue(),'max');
  assert.equal(await prior.locator('#chat-error').isVisible(),false);
  check('an earlier availability error clears for automatic waiting and normal catalog loading resumes once connected');

  const denied = await browser.newPage({viewport:{width:1500,height:1000}}); pages.push(denied);denied.on('pageerror',error=>errors.push(error.message));
  await denied.setContent(html);
  await denied.evaluate(() => { window.__modelError={code:'MODEL_ACCESS_DENIED',message:'Synthetic account permission failure.'};window.__adopt(null);window.__controller.toggle(true,false); });
  await denied.waitForFunction(() => !document.querySelector('#chat-error').hidden);
  await adopt(denied,origin,{threadId:origin.threadId,connected:false});
  assert.equal(await denied.locator('#chat-error').isVisible(),true);
  assert.match(await denied.locator('#chat-error').textContent(),/MODEL_ACCESS_DENIED/);
  assert.equal(await modelCalls(denied),1);
  check('unrelated account and permission failures remain visible while automatic connection is pending');

  await prior.locator('#chat-model').selectOption('synthetic-alternate');
  await prior.locator('#chat-effort').selectOption('high');
  await prior.locator('#chat-connect').click();
  assert.deepEqual(await prior.evaluate(() => window.__calls.filter(call=>call.action==='chatSelectModel').map(call=>call.payload)),[{model:'synthetic-alternate',effort:'high'}]);
  assert.equal(await prior.locator('#chat-messages .chat-message').textContent().then(text=>text.includes(history[0].text)),true);
  assert.equal(await prior.evaluate(() => window.__calls.some(call=>['chatStart','chatSend'].includes(call.action))),false);
  check('connected authors can explicitly change the model without a new chat, unsolicited turn or lost history');

  for (const phase of ['failed','released','preserved-binding']) {
    const manual = await scenario({...origin,phase},{threadId:'synthetic-explicit-chat',model:origin.model,effort:'max',connected:true});
    await manual.waitForFunction(() => document.querySelector('#chat-model option[value="synthetic-alternate"]'));
    assert.equal(await modelCalls(manual),1);
    assert.equal(await manual.locator('#chat-thread').textContent(),'synthetic-explicit-chat');
  }
  check('failed, released and preserved explicit bindings retain their normal manual connection controls');

  await adopt(waiting,origin,{threadId:origin.threadId,model:origin.model,effort:origin.effort,connected:false});
  await waiting.screenshot({path:path.join(output,'origin-waiting.png')});
  await waiting.evaluate(() => document.documentElement.lang='zh-CN');
  await adopt(waiting,origin);
  assert.match(await waiting.locator('#chat-status').textContent(),/等待桌面端/);
  assert.deepEqual(errors,[]);
  check('automatic status respects the chosen language and produces no uncaught browser errors');
  await writeFile(path.join(output,'report.json'),JSON.stringify({syntheticOnly:true,passed:results.length,results,pageErrors:errors},null,2));
} finally { await browser.close(); }
