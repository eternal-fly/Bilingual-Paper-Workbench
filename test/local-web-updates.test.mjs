import test from 'node:test';
import assert from 'node:assert/strict';
import {startLocalWeb} from '../src/local-web.mjs';
import {ReleaseUpdateChecker} from '../src/update-checker.mjs';
test('authenticated update routes stay lightweight and do not read mutate or block an importing paper',async t=>{
 let paperReads=0,fetches=0;const service={_assistantImportPromise:Promise.resolve(),getState(){paperReads++;throw Error('Updates cannot read the paper');}};
 const checker=new ReleaseUpdateChecker({currentVersion:'1.5.1',readCache:async()=>null,writeCache:async()=>{},fetchImpl:async()=>{fetches++;return new Response(JSON.stringify({tag_name:'v1.5.1',html_url:'https://github.com/eternal-fly/Bilingual-Paper-Workbench/releases/tag/v1.5.1',draft:false,prerelease:false,assets:[]}));}});
 const web=await startLocalWeb({service,updateChecker:checker});t.after(()=>web.close());
 const call=async(action,payload={},authorized=true)=>{const response=await fetch(web.origin+'/api',{method:'POST',headers:{Origin:web.origin,'Content-Type':'application/json',Authorization:authorized?'Bearer '+web.token:'bad'},body:JSON.stringify({action,payload})});return{status:response.status,body:await response.json()};};
 assert.equal((await call('getUpdates',{},false)).status,401);assert.equal(fetches,0);
 const state=await call('getUpdates');assert.equal(state.status,200);assert.equal(state.body.state,undefined);assert.equal(state.body.result.currentVersion,'1.5.1');assert.equal(fetches,0);
 const checked=await call('checkUpdates',{manual:false});assert.equal(checked.body.result.status,'up-to-date');assert.equal(checked.body.state,undefined);assert.equal(fetches,1);
 assert.equal((await call('configureUpdates',{autoCheck:false})).body.result.autoCheck,false);assert.equal((await call('checkUpdates',{url:'https://evil.invalid'})).status,400);assert.equal(paperReads,0);
});
