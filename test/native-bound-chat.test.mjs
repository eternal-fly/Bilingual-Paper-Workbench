import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {NativeBoundChat} from '../src/native-bound-chat.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),threadId='native-existing-synthetic';
const fake=String.raw`import readline from 'node:readline';
const cfg=JSON.parse(process.argv[1]||'{}');let resumed=0,turns=0,updates=0,activeModel='model-a',activeEffort='low',latest={id:'peer-completed',status:'completed'},readCount=0,historyReads=0;const out=m=>process.stdout.write(JSON.stringify(m)+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line),p=m.params||{};if(!m.method)return;const reply=result=>out({id:m.id,result});
if(m.method==='initialize')return reply({userAgent:'synthetic'});if(m.method==='initialized')return;
if(m.method==='thread/start')throw Error('MUST_NOT_CREATE_THREAD');
if(m.method==='thread/read')return reply({thread:{id:cfg.wrongId?'foreign-thread':p.threadId,name:'Existing synthetic chat',status:{type:cfg.active?'active':resumed&&!cfg.metadataPersisted?'idle':'notLoaded'},...(cfg.omitMetadataSelection?{}:{model:cfg.conflictingMetadata&&updates?'conflicting-model':activeModel,reasoningEffort:cfg.metadataPersisted?'low':activeEffort}),turns:[]}});
if(m.method==='thread/turns/list'){readCount++;if(p.itemsView==='full'){historyReads++;if(cfg.hugeHistory)return reply({data:[{id:'huge-old-turn',status:'completed',itemsView:'full',items:[{id:'huge-old-message',type:'agentMessage',text:'x'.repeat(4*1024*1024+4096)}]}],nextCursor:null});const page=p.cursor==='older'?1:0;return reply(cfg.historyAfterFirstEmpty&&historyReads>1?{data:[],nextCursor:null}:cfg.historyPages?.[page]||{data:[],nextCursor:null});}if(cfg.nullLatest)return reply({data:[null]});if(cfg.invalidLatest)return reply({data:[{id:'bad',status:'unknown'}]});if(cfg.latestBusy||cfg.afterResumeBusy&&resumed>0)return reply({data:[{id:'peer-running',status:'inProgress',items:[],itemsView:'notLoaded'}]});if(cfg.changedAfterResume&&resumed>0)latest={id:'new-peer-completed',status:'completed'};return reply({data:[{...latest,items:[],itemsView:'notLoaded'}],nextCursor:null});}
if(m.method==='model/list')return reply({data:['model-a',...(cfg.secondModel?['model-b']:[])].map(model=>({id:model,model,displayName:model,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]})),nextCursor:null});
if(m.method==='config/read')return reply({config:{mcp_servers:{}}});if(m.method==='mcpServerStatus/list')return reply({data:cfg.settingsActiveMcp&&updates?[{name:'unexpected',runtimeStatus:'ready',tools:{unexpected:{}}}]:[],nextCursor:null});
if(m.method==='thread/resume'){resumed++;if(cfg.writerBusy)return out({id:m.id,error:{code:-32600,message:'thread already has an active writer'}});activeModel=p.model;return reply({thread:{id:cfg.wrongResumeId?'foreign-thread':p.threadId,name:'Existing synthetic chat'},model:activeModel,modelProvider:'synthetic',reasoningEffort:activeEffort,activePermissionProfile:{id:':read-only'}});}
if(m.method==='thread/settings/update'){updates++;if(Object.keys(p).sort().join(',')!=='effort,model,threadId')return out({id:m.id,error:{code:-32602,message:'Only scoped model and effort may change'}});activeModel=p.model;activeEffort=p.effort;const notification=()=>out({method:'thread/settings/updated',params:{threadId:cfg.settingsForeignThread?'foreign-thread':p.threadId,threadSettings:{model:cfg.settingsWrongModel?'wrong-model':activeModel,effort:cfg.settingsWrongEffort?'low':activeEffort,modelProvider:'synthetic',activePermissionProfile:{id:cfg.settingsWrongPermissions?':workspace':':read-only'}}}});if(cfg.settingsBeforeReply&&!cfg.noSettingsNotification)notification();reply({});if(!cfg.settingsBeforeReply&&!cfg.noSettingsNotification)setTimeout(notification,5);return;}
if(m.method==='thread/unsubscribe')return reply({status:'unsubscribed'});
if(m.method==='turn/start'){const id='owned-'+(++turns);reply({turn:{id,status:'inProgress'}});setTimeout(()=>{const text=p.outputSchema?'{"ok":true}':JSON.stringify({text:p.input[0].text,resumed,updates,activeModel,activeEffort,readCount,threadId:p.threadId});out({method:'item/agentMessage/delta',params:{threadId:p.threadId,turnId:id,itemId:'a-'+id,delta:text}});out({method:'item/completed',params:{threadId:p.threadId,turnId:id,item:{id:'a-'+id,type:'agentMessage',text}}});latest={id,status:'completed'};out({method:'turn/completed',params:{threadId:p.threadId,turn:{id,status:'completed'}}});},10);return;}
out({id:m.id,error:{code:-32601,message:'Unsupported synthetic method'}});});`;
async function fixture(t,cfg={}){const owned=path.join(root,'work/native-bound-chat-tests');await mkdir(owned,{recursive:true});const base=await mkdtemp(path.join(owned,'case-')),leaseRoot=path.join(base,'leases'),instances=[];
 const make=(overrides={})=>{const x=new NativeBoundChat({threadId,leaseRoot,dataRoot:path.join(base,'state-'+instances.length),cwd:base,command:process.execPath,commandArgs:['--input-type=module','-e',fake,'--',JSON.stringify(cfg)],...overrides});instances.push(x);return x;};
 t.after(async()=>{for(const x of instances)await x.close();assert.ok(path.resolve(base).startsWith(path.resolve(owned)+path.sep));await rm(base,{recursive:true,force:true});});return{base,leaseRoot,make};}

test('binding requires an exact existing identity and absolute shared lease root',()=>{
 assert.throws(()=>new NativeBoundChat({threadId:'',leaseRoot:root,dataRoot:root,cwd:root}),/thread/i);
 assert.throws(()=>new NativeBoundChat({threadId,leaseRoot:'relative',dataRoot:root,cwd:root}),/absolute/i);
});
test('connecting binds only the existing stored identity without resuming or starting a model turn',async t=>{
 const f=await fixture(t),chat=f.make();await chat.connect();const state=chat.getState();assert.equal(state.mode,'bound-existing-chat');assert.equal(state.threadId,threadId);assert.equal(state.busy,false);assert.equal(state.desktopControlVerified,false);assert.deepEqual(state.messages,[]);
 await assert.rejects(chat.startChat({model:'model-a',effort:'low'}),{code:'EXISTING_CHAT_ONLY'});
 await assert.rejects(chat.resumeChat({threadId:'different-thread',model:'model-a',effort:'low'}),{code:'NATIVE_CHAT_MISMATCH'});
});
test('direct send resumes the same identity and streams its actual complete turn without a new thread',async t=>{
 const f=await fixture(t),chat=f.make();await chat.connect();const sent=await chat.sendMessage({text:'A literal author message.',model:'model-a',effort:'low'});assert.equal(sent.threadId,threadId);assert.equal((await chat.waitForTurn(sent.turnId)).status,'completed');const answer=JSON.parse(chat.getState().messages.at(-1).text);assert.equal(answer.threadId,threadId);assert.equal(answer.text,'A literal author message.');assert.equal(answer.resumed,1);assert.ok(answer.readCount>=2);
 const second=await chat.sendMessage({text:'Next.',model:'model-a',effort:'low'});await chat.waitForTurn(second.turnId);assert.equal(JSON.parse(chat.getState().messages.at(-1).text).resumed,1);
});
test('a peer in-progress turn or malformed idle evidence fails closed before a model turn',async t=>{
 for(const cfg of [{active:true},{latestBusy:true},{invalidLatest:true},{nullLatest:true}]){const f=await fixture(t,cfg),chat=f.make();await chat.connect();await assert.rejects(chat.sendMessage({text:'Must not send',model:'model-a',effort:'low'}),error=>['CHAT_BUSY','NATIVE_CHAT_STATUS_UNAVAILABLE'].includes(error.code));assert.equal(chat.getState().messages.length,0);}
});
test('the final turn-start check rejects a peer that starts while the bound chat is being resumed',async t=>{
 const f=await fixture(t,{afterResumeBusy:true}),chat=f.make();await chat.connect();await assert.rejects(chat.sendMessage({text:'Must not race',model:'model-a',effort:'low'}),{code:'CHAT_BUSY'});assert.equal(chat.getState().busy,false);assert.ok(!chat.getState().messages.some(m=>m.status==='sent'));
});
test('a changed stored history between resume and turn start is rejected rather than using a stale session',async t=>{
 const f=await fixture(t,{changedAfterResume:true}),chat=f.make();await chat.connect();await assert.rejects(chat.sendMessage({text:'Must not lose new context',model:'model-a',effort:'low'}),{code:'NATIVE_CHAT_CHANGED'});
});
test('identity mismatches on stored read or resume never switch to a different chat',async t=>{
 const read=await fixture(t,{wrongId:true});await assert.rejects(read.make().connect(),{code:'NATIVE_CHAT_MISMATCH'});
 const resume=await fixture(t,{wrongResumeId:true}),chat=resume.make();await chat.connect();await assert.rejects(chat.resumeChat({model:'model-a',effort:'low'}),{code:'THREAD_MISMATCH'});
});
test('one hashed chat lease covers separate workspace states and closing releases only its owner',async t=>{
 const f=await fixture(t),one=f.make(),two=f.make();await one.connect();await assert.rejects(two.connect(),{code:'NATIVE_CHAT_IN_USE'});await one.close();await two.connect();assert.equal(two.getState().threadId,threadId);
 const name=createHash('sha256').update(threadId).digest('hex')+'.json',file=path.join(f.leaseRoot,name),lease=JSON.parse(await readFile(file,'utf8'));await writeFile(file,JSON.stringify({...lease,owner:'different-owner'}));await two.close();assert.equal(JSON.parse(await readFile(file,'utf8')).owner,'different-owner');
});
test('stale or malformed leases require explicit recovery and saved foreign chat state is preserved',async t=>{
 const f=await fixture(t),name=createHash('sha256').update(threadId).digest('hex')+'.json';await mkdir(f.leaseRoot,{recursive:true});const file=path.join(f.leaseRoot,name);await writeFile(file,'{"schemaVersion":1,"pid":99999999,"owner":"stale","threadId":"native-existing-synthetic"}');await assert.rejects(f.make().connect(),{code:'NATIVE_CHAT_LEASE_RECOVERY_REQUIRED'});assert.ok((await readFile(file,'utf8')).includes('stale'));
 const clean=await fixture(t),dataRoot=path.join(clean.base,'saved');await mkdir(dataRoot);const saved={schemaVersion:1,threadId:'foreign-saved-chat',messages:[{text:'Preserve this old local display.'}]};await writeFile(path.join(dataRoot,'chat-state.json'),JSON.stringify(saved));const chat=clean.make({dataRoot});await assert.rejects(chat.connect(),{code:'NATIVE_CHAT_MISMATCH'});assert.deepEqual(JSON.parse(await readFile(path.join(dataRoot,'chat-state.json'),'utf8')),saved);
});
test('a restored or foreign Desktop turn ID cannot be interrupted through this client',async t=>{
 const f=await fixture(t),chat=f.make();await chat.connect();chat._state.turnId='peer-owned-turn';assert.deepEqual(await chat.interrupt(),{interrupted:false});
});

const historyTurn=(id,text,startedAt=1700000000)=>({id,status:'completed',startedAt,completedAt:startedAt+2,itemsView:'full',items:[{id:'u-'+id,type:'userMessage',content:[{type:'text',text:'Question '+text}]},{id:'a-'+id,type:'agentMessage',text:'Answer '+text}]});
test('read-only connection restores recent paginated native history and binding model without a model turn',async t=>{
 const f=await fixture(t,{historyPages:[{data:[historyTurn('newest','newest',1700000010)],nextCursor:'older'},{data:[historyTurn('older','older')],nextCursor:null}]}),chat=f.make({bindingSelection:{model:'model-a',effort:'low'}});
 await chat.connect();const state=chat.getState();assert.deepEqual(state.messages.map(m=>m.text),['Question older','Answer older','Question newest','Answer newest']);assert.equal(state.model,'model-a');assert.equal(state.effort,'low');assert.equal(state.nativeHistory.turnCount,2);assert.equal(state.nativeHistory.hasMore,false);assert.deepEqual(state.nativeHistory.latestTurn,{id:'newest',status:'completed',startedAt:1700000010,completedAt:1700000012});assert.equal(state.busy,false);
 const sent=await chat.sendMessage({text:'Keep the restored choice.'});await chat.waitForTurn(sent.turnId);assert.equal(sent.model,'model-a');assert.equal(sent.effort,'low');assert.equal(JSON.parse(chat.getState().messages.at(-1).text).resumed,1);
});
test('history is bounded, deduplicates local display messages and retains known last-turn metadata',async t=>{
 const f=await fixture(t,{historyPages:[{data:[historyTurn('newest','newest')],nextCursor:'older'},{data:[historyTurn('older','older')],nextCursor:'older'}]}),chat=f.make();await chat.connect();
 chat._state.messages.push({id:'local-user',role:'user',turnId:'newest',text:'Author-facing request label',reviewMetadata:{kind:'review'},status:'sent'});
 const first=await chat.loadHistory({limit:1,maxPages:1});assert.equal(first.nativeHistory.hasMore,true);assert.equal(first.nativeHistory.turnCount,1);assert.equal(first.messages.filter(m=>m.turnId==='newest'&&m.role==='user').length,1);assert.equal(first.messages.find(m=>m.turnId==='newest'&&m.role==='user').text,'Author-facing request label');
 const last=structuredClone(first.nativeHistory.latestTurn);chat._state.nativeHistory.latestTurn=last;await assert.rejects(chat.loadHistory({limit:0}),{code:'INVALID_INPUT'});assert.deepEqual(chat.getState().nativeHistory.latestTurn,last);
 await assert.rejects(chat.loadHistory({limit:10,maxPages:3}),{code:'NATIVE_CHAT_HISTORY_INVALID'});assert.deepEqual(chat.getState().nativeHistory.latestTurn,last);
});
test('large history clips only visible text within the budget and keeps the native cursor',async t=>{
 const f=await fixture(t,{historyPages:[{data:[historyTurn('huge','量'.repeat(6000))],nextCursor:'older'}]}),chat=f.make();await chat.connect();chat._state.messages.push({id:'keep',role:'user',text:'Keep existing local display.'});const state=await chat.loadHistory({limit:1,maxPages:1,maxBytes:4096});
 assert.equal(state.nativeHistory.nextCursor,'older');assert.equal(state.nativeHistory.hasMore,true);assert.equal(state.nativeHistory.truncated,true);assert.ok(state.nativeHistory.bytes<=4096);assert.ok(state.messages.some(m=>m.historyTruncated&&m.text.includes('原聊天保留全文')));assert.ok(state.messages.every(m=>!m.text.includes('\ufffd')));assert.ok(state.messages.some(m=>m.id==='keep'));
});
test('malformed native history never replaces already displayed history',async t=>{
 const f=await fixture(t,{historyPages:[{data:[{...historyTurn('malformed','x'),itemsView:'summary'}],nextCursor:null}]}),chat=f.make();await chat.connect();chat._state.messages=[{id:'keep',role:'user',text:'Keep existing local display.'}];const before=structuredClone(chat.getState().messages);
 await assert.rejects(chat.loadHistory({maxBytes:4096}),{code:'NATIVE_CHAT_HISTORY_INVALID'});assert.deepEqual(chat.getState().messages,before);
});
test('active writer conflicts stay on the exact bound chat and never submit a fallback turn',async t=>{
 const f=await fixture(t,{writerBusy:true}),chat=f.make({bindingSelection:{model:'model-a',effort:'low'}});await chat.connect();await assert.rejects(chat.sendMessage({text:'Must not create a replacement thread.'}),{code:'THREAD_IN_USE'});assert.equal(chat.getState().threadId,threadId);assert.equal(chat.getState().busy,false);assert.deepEqual(chat.getState().messages,[]);
});
test('explicit recovery removes only proven-dead matching native and local leases',async t=>{
 const f=await fixture(t),chat=f.make(),name=createHash('sha256').update(threadId).digest('hex')+'.json';await mkdir(f.leaseRoot,{recursive:true});await mkdir(chat.dataRoot);const leaseFile=path.join(f.leaseRoot,name),localFile=path.join(chat.dataRoot,'.codex-chat.lock');
 await writeFile(leaseFile,JSON.stringify({schemaVersion:1,threadId,owner:'stale-owner',pid:99999999}));await writeFile(localFile,JSON.stringify({owner:'stale-local-owner',pid:99999999}));
 await writeFile(path.join(chat.dataRoot,'chat-state.json'),JSON.stringify({schemaVersion:1,threadId,messages:[]}));
 assert.deepEqual(await chat.recoverStaleLease(),{recovered:true,threadId,localLockRecovered:true});await assert.rejects(readFile(leaseFile),{code:'ENOENT'});await assert.rejects(readFile(localFile),{code:'ENOENT'});await chat.connect();assert.equal(chat.getState().threadId,threadId);
});
test('explicit recovery preserves live, malformed and foreign leases and mismatched local locks',async t=>{
 for(const replacement of [{schemaVersion:1,threadId,owner:'live-owner',pid:process.pid},{schemaVersion:1,threadId:'foreign',owner:'stale-owner',pid:99999999},{schemaVersion:1,threadId,owner:'stale-owner',pid:99999999}]){
  const f=await fixture(t),chat=f.make(),file=path.join(f.leaseRoot,createHash('sha256').update(threadId).digest('hex')+'.json');await mkdir(f.leaseRoot,{recursive:true});await mkdir(chat.dataRoot);const bytes=JSON.stringify(replacement);await writeFile(file,bytes);await writeFile(path.join(chat.dataRoot,'.codex-chat.lock'),JSON.stringify({owner:'other-local-owner',pid:process.pid}));await assert.rejects(chat.recoverStaleLease(),error=>['NATIVE_CHAT_IN_USE','NATIVE_CHAT_LEASE_RECOVERY_REQUIRED'].includes(error.code));assert.equal(await readFile(file,'utf8'),bytes);
 }
});
test('a later empty history page preserves the last observed native turn metadata',async t=>{
 const newest=historyTurn('last-known','last-known'),f=await fixture(t,{historyPages:[{data:[newest],nextCursor:null}],historyAfterFirstEmpty:true}),chat=f.make();await chat.connect();const state=await chat.loadHistory();assert.deepEqual(state.nativeHistory.latestTurn,{id:newest.id,status:newest.status,startedAt:newest.startedAt,completedAt:newest.completedAt});
});
test('parallel connects share one owned client and saved selection wins over an older binding default',async t=>{
 const f=await fixture(t),dataRoot=path.join(f.base,'saved-selection');await mkdir(dataRoot);await writeFile(path.join(dataRoot,'chat-state.json'),JSON.stringify({schemaVersion:1,threadId,messages:[],model:'saved-model',effort:'high'}));const chat=f.make({dataRoot,bindingSelection:{model:'model-a',effort:'low'}});const states=await Promise.all([chat.connect(),chat.connect()]);assert.ok(states.every(state=>state.model==='saved-model'&&state.effort==='high'));assert.equal(chat.getState().threadId,threadId);
});
test('null persisted effort defers to the selected live model default',async t=>{
 const f=await fixture(t),chat=f.make({bindingSelection:{model:'model-a',effort:null,kind:'bound-existing-chat'}});await chat.connect();const sent=await chat.sendMessage({text:'Use the real model default.'});await chat.waitForTurn(sent.turnId);assert.equal(sent.effort,'low');
});
test('one oversized native-history response is drained without ending the connection or losing its next RPC',async t=>{
 const f=await fixture(t,{hugeHistory:true}),chat=f.make({bindingSelection:{model:'model-a',effort:'low'}});await chat.connect();let state=chat.getState();assert.equal(state.connected,true);assert.equal(state.nativeHistory.historyUnavailable,true);assert.equal(state.nativeHistory.errorCode,'NATIVE_CHAT_HISTORY_TOO_LARGE');assert.equal(state.nativeHistory.truncated,true);assert.deepEqual(state.messages,[]);
 const models=await chat.listModels();assert.equal(models[0].model,'model-a');const sent=await chat.sendMessage({text:'History display failure must not disconnect this same chat.'});assert.equal((await chat.waitForTurn(sent.turnId)).status,'completed');state=chat.getState();assert.equal(state.connected,true);assert.equal(state.threadId,threadId);
});
test('oversized responses with a foreign ID or concurrent pending request retain the normal protocol failure',async t=>{
 for(const concurrent of [false,true]){
  const f=await fixture(t),chat=f.make();await chat.connect();const historyId=chat._id+1;chat._historyRequestId=historyId;let rejected=null;chat._pending.set(historyId,{timer:setTimeout(()=>{},10000),reject:error=>{rejected=error;}});if(concurrent)chat._pending.set(historyId+1,{timer:setTimeout(()=>{},10000),reject:()=>{}});
  const id=concurrent?historyId:historyId+100;chat._read(Buffer.from(JSON.stringify({id,result:{text:'x'.repeat(24*1024*1024+4096)}})+'\n'));assert.equal(rejected?.code,'PROTOCOL_LIMIT');assert.equal(chat.getState().connected,false);assert.equal(chat._discardingHistory,false);
 }
});
test('stale local recovery requires an exact saved binding and rejects a lease replaced during recovery',async t=>{
 const f=await fixture(t),chat=f.make(),leaseFile=path.join(f.leaseRoot,createHash('sha256').update(threadId).digest('hex')+'.json');await mkdir(f.leaseRoot,{recursive:true});await mkdir(chat.dataRoot);const stale=JSON.stringify({schemaVersion:1,threadId,owner:'stale-owner',pid:99999999});await writeFile(leaseFile,stale);const localFile=path.join(chat.dataRoot,'.codex-chat.lock');await writeFile(localFile,JSON.stringify({owner:'stale-local-owner',pid:99999999}));await writeFile(path.join(chat.dataRoot,'chat-state.json'),JSON.stringify({schemaVersion:1,threadId:'foreign-saved',messages:[]}));await assert.rejects(chat.recoverStaleLease(),{code:'NATIVE_CHAT_LEASE_RECOVERY_REQUIRED'});assert.equal(await readFile(leaseFile,'utf8'),stale);assert.ok((await readFile(localFile,'utf8')).includes('stale-local-owner'));
 await writeFile(path.join(chat.dataRoot,'chat-state.json'),JSON.stringify({schemaVersion:1,threadId,messages:[]}));const verify=chat._sameDeadLease.bind(chat);let calls=0;chat._sameDeadLease=async(...args)=>{if(++calls===1)await writeFile(leaseFile,JSON.stringify({schemaVersion:1,threadId,owner:'live-replacement',pid:process.pid}));return verify(...args);};await assert.rejects(chat.recoverStaleLease(),{code:'NATIVE_CHAT_LEASE_RECOVERY_REQUIRED'});assert.ok((await readFile(leaseFile,'utf8')).includes('live-replacement'));assert.ok((await readFile(localFile,'utf8')).includes('stale-local-owner'));
});
test('loaded bound model and effort changes use an exact settings notification without another resume',async t=>{
 for(const cfg of [{},{settingsBeforeReply:true},{omitMetadataSelection:true},{metadataPersisted:true}]){
  const f=await fixture(t,cfg),chat=f.make();await chat.resumeChat({model:'model-a',effort:'low'});const changed=await chat.resumeChat({model:'model-a',effort:'high'});assert.equal(changed.effort,'high');assert.equal(changed.mcpIsolation.verified,true);const sent=await chat.sendMessage({text:'Use the confirmed high effort.'});await chat.waitForTurn(sent.turnId);const answer=JSON.parse(chat.getState().messages.at(-1).text);assert.equal(answer.resumed,1);assert.equal(answer.updates,1);assert.equal(answer.activeEffort,'high');
 }
});
test('first resume returning an older stored effort is corrected using scoped settings before a turn',async t=>{
 const f=await fixture(t),chat=f.make();const resumed=await chat.resumeChat({model:'model-a',effort:'high'});assert.equal(resumed.effort,'high');const sent=await chat.sendMessage({text:'Confirmed first resume.'});await chat.waitForTurn(sent.turnId);const answer=JSON.parse(chat.getState().messages.at(-1).text);assert.equal(answer.resumed,1);assert.equal(answer.updates,1);assert.equal(answer.activeEffort,'high');
});
test('changing the loaded model preserves the same thread and requests only model and effort settings',async t=>{
 const f=await fixture(t,{secondModel:true}),chat=f.make();await chat.resumeChat({model:'model-a',effort:'low'});await chat.resumeChat({model:'model-b',effort:'high'});const sent=await chat.sendMessage({text:'Use model B.'});await chat.waitForTurn(sent.turnId);const answer=JSON.parse(chat.getState().messages.at(-1).text);assert.equal(answer.threadId,threadId);assert.equal(answer.resumed,1);assert.equal(answer.updates,1);assert.equal(answer.activeModel,'model-b');assert.equal(answer.activeEffort,'high');
});
test('missing or mismatched settings acknowledgements and live metadata conflicts fail closed before turns',async t=>{
 for(const [cfg,code] of [[{noSettingsNotification:true},'MODEL_SETTINGS_UNCONFIRMED'],[{settingsForeignThread:true},'MODEL_SETTINGS_UNCONFIRMED'],[{settingsWrongModel:true},'MODEL_MISMATCH'],[{settingsWrongEffort:true},'EFFORT_MISMATCH'],[{settingsWrongPermissions:true},'PERMISSION_MISMATCH'],[{conflictingMetadata:true},'MODEL_MISMATCH'],[{settingsActiveMcp:true},'MCP_ISOLATION_UNAVAILABLE']]){
  const f=await fixture(t,cfg),chat=f.make({requestTimeoutMs:350});await chat.resumeChat({model:'model-a',effort:'low'});await assert.rejects(chat.resumeChat({model:'model-a',effort:'high'}),{code});assert.equal(chat.getState().busy,false);assert.deepEqual(chat.getState().messages,[]);assert.equal(chat.getState().threadId,threadId);
 }
});
