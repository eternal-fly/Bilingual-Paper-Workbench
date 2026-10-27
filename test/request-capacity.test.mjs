import test from 'node:test';
import assert from 'node:assert/strict';
import {paperRequestSchema,paperRequestPrompt,PAPER_TOOL_SPECS} from '../src/codex-bridge.mjs';
import {startLocalWeb} from '../src/local-web.mjs';
import {parseDesktopCallback} from '../src/desktop-callback.mjs';
import {registerPdfModelTools} from '../src/pdf-model-tools.mjs';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

test('the compatibility model adapter keeps all 120 registered protected paragraphs instead of rejecting after eight',()=>{
 const segments=Array.from({length:120},(_,i)=>({id:'paragraph-'+i,beforeHash:'a'.repeat(64),text:'Exact prose '+i+' ⟦P1_'+i+'⟧',protectedTokens:[{id:'⟦P1_'+i+'⟧',raw:'$x=1$'}]}));
 const request={requestId:'request-all',kind:'translation',snapshotId:'snapshot',language:'zh-CN',segments};
 const schema=paperRequestSchema(request);assert.equal(schema.properties.translations.minItems,120);assert.equal(schema.properties.translations.maxItems,120);assert(paperRequestPrompt(request).includes('Exact prose 119'));
 for(const name of ['paper_submit_translation','paper_propose_revision','paper_compile']){
  const tool=PAPER_TOOL_SPECS.find(t=>t.name===name),array=Object.values(tool.inputSchema.properties).find(field=>field.type==='array');assert.equal(array.maxItems,undefined,name);
 }
});

test('authenticated local requests accept a complete 60000-ID selection within the transport byte budget',async t=>{
 let selected=[];const state={project:{id:'paper',snapshotId:'source'},segments:[],translations:{},capabilities:{}};
 const web=await startLocalWeb({service:{getState:()=>state,createRequest:async input=>{selected=[...input.segmentIds];return{requestId:'capacity',count:selected.length};}}});t.after(()=>web.close());
 const ids=Array.from({length:60000},(_,i)=>'paragraph-'+String(i).padStart(12,'0')+'-protected-source');
 const body=JSON.stringify({action:'createRequest',payload:{segmentIds:ids,language:'zh-CN',kind:'revision'}});assert(Buffer.byteLength(body)>2*1024*1024);
 const response=await fetch(web.origin+'/api',{method:'POST',headers:{Origin:web.origin,Authorization:'Bearer '+web.token,'Content-Type':'application/json'},body});
 const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));assert.equal(value.ok,true);assert.equal(value.result.count,60000);assert.deepEqual(selected,ids);
});

test('the native Desktop callback forwards continuation offsets and staged results above eight items',()=>{
 assert.deepEqual(parseDesktopCallback(['get','registered-request','31']),{action:'get',input:{requestId:'registered-request',offset:31}});
 const result={requestId:'registered-request',translations:Array.from({length:31},(_,i)=>({segmentId:'p'+i,text:'Complete translated prose '+i})),batchOffset:0,resultCount:62,finalize:false};
 const parsed=parseDesktopCallback(['submit'],Buffer.from(JSON.stringify(result)));assert.equal(parsed.input.translations.length,31);assert.equal(parsed.input.batchOffset,0);assert.equal(parsed.input.resultCount,62);assert.equal(parsed.input.finalize,false);
 assert.throws(()=>parseDesktopCallback(['submit'],Buffer.from(JSON.stringify({...result,resultCount:undefined}))),{code:'INVALID_INPUT'});
 assert.throws(()=>parseDesktopCallback(['get','registered-request','-1']),{code:'INVALID_INPUT'});
});

test('native PDF tool schemas accept 5001 complete records, six paragraph associations and 55 compiled proposal IDs',async t=>{
 let readCount=0,noteCount=0,proposalCount=0;
 const service={getPdfContext:async input=>{readCount=input.sourceSegmentIds.length;return{count:readCount};},submitPdfReview:async input=>{noteCount=input.notes.length;assert.equal(input.notes.at(-1).sourceSegmentIds.length,6);return{count:noteCount};},previewTransaction:async input=>{proposalCount=input.proposalIds.length;return{jobId:'capacity-build',transactionId:'capacity-preview'};},waitJob:async()=>({buildId:'capacity-build',status:'succeeded',isolation:{verified:true}})};
 const server=new McpServer({name:'count-free-pdf-test',version:'1.5.0'}),client=new Client({name:'count-free-pdf-test',version:'1.5.0'});
 registerPdfModelTools(server,{service,guard:handler=>handler});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
 const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});assert.equal(result.isError,undefined,JSON.stringify(result));return result.structuredContent;};
 await call('bilingual_paper_get_pdf_context',{sourceSegmentIds:Array.from({length:5001},(_,i)=>'p'+i)});assert.equal(readCount,5001);
 const note={title:'Pending',quote:'Exact current text',sourceSegmentIds:['p0','p1','p2','p3','p4','p5'],severity:'low',suggestedSource:'Suggested text.',suggestedTranslation:'建议。',reasonSource:'Clarify wording.',reasonTranslation:'澄清。'};
 await call('bilingual_paper_submit_pdf_review',{requestId:'capacity-review',notes:Array.from({length:5001},()=>({...note})),translations:[]});assert.equal(noteCount,5001);
 await call('bilingual_paper_compile',{kind:'candidate',proposalIds:Array.from({length:55},(_,i)=>'proposal-'+i)});assert.equal(proposalCount,55);
});
