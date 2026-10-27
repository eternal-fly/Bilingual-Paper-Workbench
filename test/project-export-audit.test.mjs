import test from 'node:test';
import assert from 'node:assert/strict';
import {inflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {exportPaperProject} from '../src/project-export.mjs';
import {preparePaperDownload} from '../ui/paper-export.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(reserved){
 const files=new Map([['main.tex',Buffer.from(`\\documentclass{article}\\begin{document}\\input{${reserved}}\\end{document}`)],[reserved,Buffer.from('This is a valid literal TeX dependency, despite its filename.')],['_EXPORT_MANIFEST.json',Buffer.from('A second ordinary project dependency.')]].map(([path,bytes])=>[path,{path,bytes,hash:hash(bytes),size:bytes.length}]));
 const project={id:'synthetic-export-audit',snapshotId:'snapshot',mainFile:'main.tex',files:[...files.values()].map(({path,hash,size})=>({path,hash,size}))};
 return{files,project,app:{_projectOperation:f=>f(),core:{_serial:f=>f(),_assertSourceCurrent:async()=>{},getState:()=>({project}),_files:files}}};
}
function entries(zip){const result=new Map();let offset=0;while(zip.readUInt32LE(offset)===0x04034b50){const size=zip.readUInt32LE(offset+18),nameLength=zip.readUInt16LE(offset+26),extraLength=zip.readUInt16LE(offset+28),start=offset+30+nameLength+extraLength,name=zip.subarray(offset+30,offset+30+nameLength).toString('utf8');assert.equal(result.has(name),false);result.set(name,inflateRawSync(zip.subarray(start,start+size)));offset=start+size;}assert.equal(zip.readUInt32LE(offset),0x02014b50);return result;}

test('the generated export manifest never overwrites a case-insensitively matching valid project dependency',async()=>{
 for(const name of ['EXPORT_MANIFEST.json','export_manifest.json','Export_Manifest.JSON']){
  const f=fixture(name),before=[...f.files].map(([name,row])=>[name,Buffer.from(row.bytes)]),result=await exportPaperProject(f.app,{expectedProjectId:f.project.id,expectedSnapshotId:f.project.snapshotId}),values=entries(Buffer.from(result.base64,'base64'));
  assert.equal(values.size,f.files.size+1);assert.equal(new Set([...values.keys()].map(value=>value.toLowerCase())).size,values.size,'A Windows extraction must retain every original input and the generated manifest.');
  assert.equal(typeof result.exportManifestPath,'string');assert.ok(values.has(result.exportManifestPath));assert.equal([...f.files.keys()].some(value=>value.toLowerCase()===result.exportManifestPath.toLowerCase()),false);
  const manifest=JSON.parse(values.get(result.exportManifestPath));assert.equal(manifest.mainFile,'main.tex');assert.equal(manifest.sourceSnapshotId,'snapshot');assert.deepEqual(new Set(manifest.files.map(row=>row.path)),new Set(f.files.keys()));
  for(const [name,bytes]of before){assert.deepEqual(values.get(name),bytes);assert.deepEqual(f.files.get(name).bytes,bytes);const record=manifest.files.find(row=>row.path===name);assert.equal(record.sha256,hash(bytes));assert.equal(record.size,bytes.length);}
 }
});

test('a project or source change during asynchronous download hashing prevents the obsolete download',async()=>{
 const bytes=Buffer.from('Synthetic bounded ZIP transport'),result={filename:'main-source.zip',projectId:'first',snapshotId:'snapshot',hash:hash(bytes),base64:bytes.toString('base64')};
 for(const change of ['project','source']){
  let state={project:{id:'first',snapshotId:'snapshot',mainFile:'main.tex'}},reads=0,changed=false;
  const getState=()=>{if(++reads===2)queueMicrotask(()=>{changed=true;if(change==='project')state={project:{id:'second',snapshotId:'different',mainFile:'second.tex'}};else state.project.snapshotId='different';});return state;};
  await assert.rejects(preparePaperDownload({format:'project',api:async()=>result,getState,getLatestBuild:()=>null}),/paper changed|current version|source changed/i);assert.equal(changed,true);
 }
});
