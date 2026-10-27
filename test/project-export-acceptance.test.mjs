import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {deflateSync} from 'node:zlib';
import {PaperApplication} from '../src/application.mjs';
import {CompilerWorker} from '../src/compiler/worker.mjs';
import {startLocalWeb} from '../src/local-web.mjs';
import {preparePaperDownload} from '../ui/paper-export.mjs';
import {sha256} from '../src/latex.mjs';

const exec=promisify(execFile),plugin=fileURLToPath(new URL('../',import.meta.url));
function pixelPng(){
 const crc32=bytes=>{let n=0xffffffff;for(const b of bytes){n^=b;for(let k=0;k<8;k++)n=n>>>1^(n&1?0xedb88320:0);}return(n^0xffffffff)>>>0;};
 const chunk=(name,data)=>{const size=Buffer.alloc(4),type=Buffer.from(name),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([size,type,data,crc]);};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,32,96,160]))),chunk('IEND',Buffer.alloc(0))]);
}

test('authenticated source-project download passes independent ZIP verification and rebuilds from all exported dependencies', {skip:!process.env.PAPER_EDITOR_TEST_RUNTIME,timeout:120000},async t=>{
 const root=path.join(plugin,'work/project-export-acceptance');await mkdir(root,{recursive:true});const directory=await mkdtemp(path.join(root,'case-')),source=path.join(directory,'original'),extracted=path.join(directory,'extracted');await mkdir(source);await mkdir(extracted);
 const files=new Map([
  ['main.tex',Buffer.from(String.raw`\documentclass{article}
\usepackage{graphicx,localstyle}
\begin{document}
\section{Self-authored export fixture}
\input{sections/introduction}
\includegraphics[width=12pt]{figures/pixel.png}
\bibliographystyle{plain}
\bibliography{references}
\end{document}
`)],
  ['sections/introduction.tex',Buffer.from('The \\ExportWord{complete project} retains its local style, source structure, figure and reference~\\cite{fixture}.\n')],
  ['localstyle.sty',Buffer.from('\\NeedsTeXFormat{LaTeX2e}\n\\ProvidesPackage{localstyle}[2026/10/28 Synthetic export acceptance]\n\\newcommand{\\ExportWord}[1]{\\textbf{#1}}\n')],
  ['figures/pixel.png',pixelPng()],
  ['references.bib',Buffer.from('@article{fixture, author={Synthetic, Example}, title={An Independently Rebuilt Project}, journal={Synthetic Test Journal}, year={2026}, volume={1}, pages={1--2}}\n')],
 ]);
 for(const[name,bytes]of files){await mkdir(path.dirname(path.join(source,name)),{recursive:true});await writeFile(path.join(source,name),bytes);}
 const privateMarker='SYNTHETIC_PRIVATE_EDITOR_AND_REVIEW_NEVER_EXPORTED';await writeFile(path.join(source,'workflow.json'),JSON.stringify({privateMarker}));
 const compiler=new CompilerWorker({dataRoot:path.join(directory,'compiler'),runtimeRoot:process.env.PAPER_EDITOR_TEST_RUNTIME}),app=new PaperApplication({dataRoot:path.join(directory,'private-state'),compiler,engine:'pdflatex'});let rebuilt,web;
 t.after(async()=>{await web?.close();await rebuilt?.close();await app.close();await Promise.allSettled([...app.jobs.values(),...(rebuilt?.jobs.values()||[])].map(job=>job.promise));await rm(directory,{recursive:true,force:true});});
 await app.initialize();await app.openProject({root:source,mainFile:'main.tex'});const before=app.getState(),project=before.project;assert.deepEqual(new Set(project.files.map(row=>row.path)),new Set(files.keys()));
 const paragraph=before.readingParagraphs.find(row=>row.source.includes('complete project'));assert.ok(paragraph);
 await app.saveTranslationDraftWithFormulaEdits({segmentId:paragraph.id,language:'zh-CN',text:privateMarker,expectedRevision:0,expectedProjectId:project.id,expectedSnapshotId:project.snapshotId});
 await app.core._serial(async()=>{const state=app.core.getState();state.reviewNotes||=[];state.reviewNotes.push({noteId:'synthetic-private-export-review',body:privateMarker,revision:1,decision:'pending',sourceSnapshotId:project.snapshotId,sourceSegmentIds:[paragraph.id],sourceHashes:{[paragraph.id]:paragraph.sourceHash}});await app.core._commit(state);});
 await app._flowAction(()=>{app.flow.syntheticPrivateExportMarker=privateMarker;});
 const stateHash=sha256(await readFile(path.join(app.core._store,'state.json'))),workflowHash=sha256(await readFile(path.join(app.core._store,'workflow.json')));web=await startLocalWeb({service:app});
 const calls=[],api=async(action,payload)=>{calls.push(action);const response=await fetch(web.origin+'/api',{method:'POST',headers:{Origin:web.origin,'Content-Type':'application/json',Authorization:`Bearer ${web.token}`},body:JSON.stringify({action,payload})});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.ok,true);return result.result;};
 const download=await preparePaperDownload({format:'project',api,getState:()=>app.getState(),getLatestBuild:()=>null});assert.deepEqual(calls,['exportPaperProject']);assert.equal(download.mimeType,'application/zip');assert.equal(download.filename,'main-source.zip');const zipPath=path.join(directory,download.filename);await writeFile(zipPath,download.bytes);
 const expected=Object.fromEntries([...files].map(([name,bytes])=>[name,{size:bytes.length,sha256:sha256(bytes)}])),expectedPath=path.join(directory,'expected.json');await writeFile(expectedPath,JSON.stringify({mainFile:'main.tex',snapshotId:project.snapshotId,files:expected,privateMarker}));
 // Python's independent ZIP reader validates the complete CRC table before
 // extracting only path-checked entries under this test's own directory.
 const python=path.resolve(plugin,'../../.venv/Scripts/python.exe'),script=String.raw`import hashlib,json,pathlib,sys,zipfile
archive,destination,expected_path=map(pathlib.Path,sys.argv[1:])
expected=json.loads(expected_path.read_text(encoding='utf-8'))
with zipfile.ZipFile(archive) as z:
 assert z.testzip() is None, 'ZIP CRC failure'
 names=z.namelist()
 assert len(names)==len(set(names)), 'Duplicate ZIP entry'
 assert set(names)==set(expected['files'])|{'EXPORT_MANIFEST.json'}, names
 manifest=json.loads(z.read('EXPORT_MANIFEST.json'))
 assert manifest['version']==1 and manifest['mainFile']==expected['mainFile']
 assert manifest['sourceSnapshotId']==expected['snapshotId']
 indexed={row['path']:{'size':row['size'],'sha256':row['sha256']} for row in manifest['files']}
 assert indexed==expected['files'], 'Incomplete or altered manifest'
 for item in z.infolist():
  name=item.filename
  assert not item.is_dir() and not name.startswith(('/', '\\')) and '\\' not in name and ':' not in name
  assert all(part not in ('','.','..') for part in name.split('/'))
  assert (item.external_attr>>16)&0o170000 != 0o120000, 'Symlink in source export'
  target=(destination/name).resolve()
  assert target.is_relative_to(destination.resolve()), 'ZIP traversal'
  data=z.read(item)
  assert expected['privateMarker'].encode() not in data, 'Private draft or review in source export'
  if name in expected['files']:
   record=expected['files'][name]
   assert len(data)==record['size'] and hashlib.sha256(data).hexdigest()==record['sha256']
 z.extractall(destination)
print(json.dumps({'crcVerified':True,'exactManifest':True,'extractedSourceFiles':len(expected['files']),'privateStateExcluded':True}))
`;
 const verification=JSON.parse((await exec(python,['-c',script,zipPath,extracted,expectedPath],{windowsHide:true,timeout:30000,maxBuffer:1024*1024})).stdout);assert.deepEqual(verification,{crcVerified:true,exactManifest:true,extractedSourceFiles:5,privateStateExcluded:true});
 rebuilt=new PaperApplication({dataRoot:path.join(directory,'rebuilt-private'),compiler,engine:'pdflatex'});await rebuilt.initialize();await rebuilt.openProject({root:extracted,mainFile:'main.tex'});assert.deepEqual(new Set(rebuilt.getState().project.files.map(row=>row.path)),new Set(files.keys()));
 const queued=await rebuilt.compileEnglish(),build=await rebuilt.waitJob({jobId:queued.jobId});assert.equal(build.status,'success',JSON.stringify(build));assert.equal(build.isolation?.verified,true);assert.ok(build.isolation.processes.some(row=>row.program==='bibtex'),'The extracted bibliography is actually compiled.');const pdf=await readFile(build.pdfPath);assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.equal(sha256(pdf),build.pdfHash);
 for(const[name,bytes]of files){assert.deepEqual(await readFile(path.join(source,name)),bytes);assert.deepEqual(await readFile(path.join(extracted,name)),bytes);}assert.equal(sha256(await readFile(path.join(app.core._store,'state.json'))),stateHash);assert.equal(sha256(await readFile(path.join(app.core._store,'workflow.json'))),workflowHash);assert.equal(JSON.parse(await readFile(path.join(source,'workflow.json'),'utf8')).privateMarker,privateMarker);
 await writeFile(path.join(root,'receipt.json'),JSON.stringify({ok:true,syntheticOnly:true,sourceFiles:5,zipHash:sha256(Buffer.from(download.bytes)),independentPythonZip:verification,authenticatedUiAction:true,uiDownloadIntegrityChecked:true,isolatedCompile:true,bibtex:true,pdfHash:build.pdfHash,originalSourceUnchanged:true,privateStateUnchanged:true},null,2));
});
