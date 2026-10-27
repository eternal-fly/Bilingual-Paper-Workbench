import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {probeBackgroundSession} from '../src/background-workbench.mjs';

test('background health accepts one current or legacy state envelope without relaxing private identity checks',async t=>{
 const token='s'.repeat(43),session={url:`http://127.0.0.1:12345/#session=${token}`,owner:'owned-background',pid:12345};
 const profile={key:'exact-profile',version:'1.6.0',viewerOnly:false,originThreadId:'exact-origin',binding:{threadId:'exact-chat'},record:{projectRoot:path.resolve('work/synthetic-envelope-paper'),mainFile:'main.tex',recordId:'exact-record'}};
 const state={project:{mainFile:'main.tex'},workspaceIndex:{currentRecord:{...profile.record}},backgroundLifecycle:{key:profile.key,owner:session.owner,pid:session.pid,version:profile.version,originThreadId:profile.originThreadId,threadId:profile.binding.threadId,viewerOnly:false}};
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let packet,requests=0;
 globalThis.fetch=async(url,options)=>{requests++;assert.equal(url,'http://127.0.0.1:12345/api');assert.equal(options.headers.Origin,'http://127.0.0.1:12345');assert.equal(options.headers.Authorization,`Bearer ${token}`);assert.deepEqual(JSON.parse(options.body),{action:'state'});assert(options.signal instanceof AbortSignal);return new Response(JSON.stringify(packet),{headers:{'Content-Type':'application/json'}});};
 for(const envelope of['result','state']){
  packet={ok:true,[envelope]:structuredClone(state)};assert.equal(await probeBackgroundSession(session,profile),true,envelope);
  for(const [name,mutate]of[['owner',s=>{s.backgroundLifecycle.owner='foreign-owner';}],['chat',s=>{s.backgroundLifecycle.threadId='foreign-chat';}],['origin',s=>{s.backgroundLifecycle.originThreadId='foreign-origin';}],['paper',s=>{s.workspaceIndex.currentRecord.recordId='foreign-record';}],['viewer',s=>{s.backgroundLifecycle.viewerOnly=true;}]]){const foreign=structuredClone(state);mutate(foreign);packet={ok:true,[envelope]:foreign};assert.equal(await probeBackgroundSession(session,profile),false,`${envelope}:${name}`);}
 }
 assert.equal(requests,12);
});
