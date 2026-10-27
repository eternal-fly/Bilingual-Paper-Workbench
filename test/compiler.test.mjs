import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { CompilerWorker, inputHash } from '../src/compiler/worker.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('compiler input identity binds engine, entry file and exact sorted input bytes', () => {
  const files = [{ path: 'b.tex', bytes: Buffer.from('b\r\n') }, { path: 'main.tex', bytes: Buffer.from('α😀') }];
  const expected = hash(JSON.stringify({ engine: 'xelatex', mainFile: 'main.tex', files: files.map(f => ({ path: f.path, hash: hash(f.bytes) })).sort((a,b) => a.path.localeCompare(b.path)) }));
  assert.equal(inputHash({ engine: 'xelatex', mainFile: 'main.tex', files }), expected);
  assert.notEqual(inputHash({ engine: 'pdflatex', mainFile: 'main.tex', files }), expected);
});
test('compiler rejects traversal, aliases, duplicate files and arbitrary engines before spawning', async () => {
  const worker = new CompilerWorker({ dataRoot: path.join(os.tmpdir(), 'paper-invalid-compile') });
  for (const bad of ['../secret.tex','C:/secret.tex','a/../../secret.tex','NUL.tex']) {
    await assert.rejects(worker.build({ mainFile: 'main.tex', files: [{ path: bad, bytes: Buffer.from('x') }], engine: 'xelatex' }), { code: 'INVALID_INPUT' });
  }
  await assert.rejects(worker.build({ mainFile: 'main.tex', files: [{ path:'main.tex',bytes:Buffer.from('x')},{path:'MAIN.tex',bytes:Buffer.from('y')}],engine:'xelatex' }), { code:'INVALID_INPUT' });
  await assert.rejects(worker.build({ mainFile:'main.tex',files:[{path:'main.tex',bytes:Buffer.from('x')}],engine:'cmd' }), { code:'INVALID_INPUT' });
});

const live = process.env.PAPER_EDITOR_LIVE_COMPILER === '1';
test('Windows AppContainer denies private files, host writes, a live network endpoint and child creation', { skip: !live }, async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'paper-appcontainer-probe-'));
  const worker = new CompilerWorker({ dataRoot });
  const probe = await worker.probe();
  assert.equal(probe.available, true, JSON.stringify(probe));
  assert.equal(probe.isolated, true);
  assert.deepEqual({...probe.probe,socketError:undefined}, { privateRead:false, hostWrite:false, outputWrite:true, inputWrite:false, childSpawn:false, loopbackNetwork:false, socketError:undefined });
  assert.ok([10013,10060].includes(probe.probe.socketError));
});
test('isolated XeLaTeX builds exact immutable synthetic input with PDF and source identity', { skip: !live }, async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'paper-appcontainer-build-'));
  const files = [{ path: 'main.tex', bytes: Buffer.from('\\documentclass{article}\n\\usepackage{fontspec,xeCJK}\n\\setmainfont{lmroman10-regular.otf}\n\\setCJKmainfont{Noto Serif CJK SC}\n\\begin{document}\nHello, 安全编译。 $x^2+1$.\\end{document}\n') }];
  const worker = new CompilerWorker({ dataRoot });
  const result = await worker.build({ projectId:'synthetic',snapshotId:'snapshot-fixture',engine:'xelatex',mainFile:'main.tex',files,candidateHash:'candidate-fixture' });
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(result.inputHash,inputHash({engine:'xelatex',mainFile:'main.tex',files}));
  assert.equal(result.isolation.verified,true);
  assert.equal((await readFile(result.pdfPath)).subarray(0,5).toString(),'%PDF-');
  assert.equal(result.pdfHash,hash(await readFile(result.pdfPath)));
  const forward=await worker.locate({build:result,sourcePath:'main.tex',line:6});
  assert.equal(forward.verified,true);
  assert.equal(forward.pdfHash,result.pdfHash);
  assert.ok(forward.matches.length>1,'All native boxes for the mixed text line remain available as source→PDF anchors.');
  const first=forward.matches[0];
  const inverse=await worker.inverse({build:result,page:first.page,x:first.x,y:first.y});
  assert.ok(inverse.matches.some(item=>item.sourcePath==='main.tex'&&item.line===6),'The PDF location returns the exact compiled source.');
});

function syntheticGraphicPdf() {
  const stream='0.1 0.3 0.5 rg 10 10 80 50 re f\n';
  const bodies=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 70] /Resources << >> /Contents 4 0 R >>',`<< /Length ${stream.length} >>\nstream\n${stream}endstream`];
  let pdf='%PDF-1.4\n';const offsets=[0];
  for(const [index,body]of bodies.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${body}\nendobj\n`;}
  const table=Buffer.byteLength(pdf);pdf+=`xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${table}\n%%EOF\n`;
  return Buffer.from(pdf);
}
test('isolated XeLaTeX resolves relative PDF graphics from immutable snapshot instead of the output cwd', {skip:!live}, async()=>{
  const dataRoot=await mkdtemp(path.join(os.tmpdir(),'paper-appcontainer-graphics-'));
  const worker=new CompilerWorker({dataRoot});
  const files=[{path:'main.tex',bytes:Buffer.from('\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\nSnapshot graphic: \\includegraphics[width=40pt]{figures/plot.pdf}\n\\end{document}\n')},{path:'figures/plot.pdf',bytes:syntheticGraphicPdf()}];
  const result=await worker.build({projectId:'synthetic',snapshotId:'graphics-fixture',engine:'xelatex',mainFile:'main.tex',files});
  assert.equal(result.status,'success',JSON.stringify(result));
  assert.equal(result.inputHash,inputHash({engine:'xelatex',mainFile:'main.tex',files}));
  assert.equal(result.isolation.verified,true);
  assert.equal(result.pdfHash,hash(await readFile(result.pdfPath)));
});
test('sandboxed malicious TeX cannot read a synthetic host secret or write outside its output', { skip: !live }, async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'paper-appcontainer-malicious-'));
  const { writeFile, stat } = await import('node:fs/promises');
  const secretPath = path.join(dataRoot,'secret.txt');
  const escapedPath = path.join(dataRoot,'escape.txt');
  await writeFile(secretPath,'MUST_NOT_LEAK_PRIVATE_SECRET');
  const texPath = value => value.replaceAll('\\','/');
  const source = `\\documentclass{article}\n\\begin{document}\n\\newread\\secret\n\\openin\\secret="${texPath(secretPath)}"\n\\ifeof\\secret DENIED\\else\\read\\secret to\\stolen\\typeout{LEAK=\\stolen}\\fi\n\\newwrite\\out\\immediate\\openout\\out="${texPath(escapedPath)}"\\immediate\\write\\out{ESCAPED}\n\\end{document}`;
  const worker = new CompilerWorker({dataRoot});
  const result = await worker.build({projectId:'synthetic',snapshotId:'malicious',engine:'xelatex',mainFile:'main.tex',files:[{path:'main.tex',bytes:Buffer.from(source)}]});
  await assert.rejects(stat(escapedPath),{code:'ENOENT'});
  const log=await readFile(result.logPath,'utf8');
  assert.ok(!log.includes('LEAK=MUST_NOT_LEAK_PRIVATE_SECRET'));
  assert.equal(result.status,'failed');
});
test('cancelling an infinite TeX job terminates the job and never returns a promotable build', { skip: !live }, async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'paper-appcontainer-cancel-'));
  const worker=new CompilerWorker({dataRoot});
  await worker.probe();
  const controller=new AbortController();
  const pending=worker.build({projectId:'synthetic',snapshotId:'loop',engine:'xelatex',mainFile:'main.tex',files:[{path:'main.tex',bytes:Buffer.from('\\documentclass{article}\\begin{document}\\loop\\iftrue\\repeat\\end{document}')}],signal:controller.signal});
  setTimeout(()=>controller.abort(),1500);
  const result=await pending;
  assert.equal(result.status,'cancelled',JSON.stringify(result));
  assert.equal(result.pdfPath,undefined);
});
test('a new AppContainer identity cannot read an earlier job snapshot and removes its grants', {skip:!live}, async () => {
  const net=await import('node:net');
  const {writeFile}=await import('node:fs/promises');
  const dataRoot=await mkdtemp(path.join(os.tmpdir(),'paper-appcontainer-crossjob-'));
  const worker=new CompilerWorker({dataRoot});
  const outside=path.join(dataRoot,'outside');await mkdir(outside);
  const denied=path.join(outside,'private.txt');await writeFile(denied,'PRIVATE');
  const server=net.createServer(socket=>socket.end());await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const runs=[];
    for(const name of ['first','second']){
      const input=path.join(dataRoot,name,'input'),output=path.join(dataRoot,name,'output');
      await mkdir(input,{recursive:true});await mkdir(output,{recursive:true});await writeFile(path.join(input,'immutable.txt'),'IMMUTABLE');
      if(name==='first')await writeFile(path.join(input,'old-secret.txt'),'OLD_JOB_SECRET');
      const secret=name==='first'?denied:'\\\\?\\'+path.join(dataRoot,'first','input','old-secret.txt');
      const result=await worker._run({input,output,executable:path.join(worker.runtimeRoot,'broker/AppContainerProbe.exe'),arguments:[secret,path.join(outside,'escape.txt'),path.join(output,'allowed.txt'),String(server.address().port),path.join(input,'immutable.txt')],testProbe:true});
      const evidence=JSON.parse((await readFile(result.logPath,'utf8')).trim().split(/\r?\n/).at(-1));
      assert.equal(evidence.privateRead,false);
      assert.equal(result.isolation.perProcessIdentity,true);
      assert.deepEqual(result.cleanup,{aclRevoked:true,profileDeleted:true,mountsRemoved:true});
      runs.push(result);
    }
    assert.notEqual(runs[0].isolation.profile,runs[1].isolation.profile);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('the hard wall limit stops uncooperative TeX without a cancellable client', {skip:!live}, async () => {
  const dataRoot=await mkdtemp(path.join(os.tmpdir(),'paper-appcontainer-wall-'));
  const worker=new CompilerWorker({dataRoot,wallMs:750,cpuSeconds:5});
  const result=await worker.build({projectId:'synthetic',snapshotId:'wall',engine:'xelatex',mainFile:'main.tex',files:[{path:'main.tex',bytes:Buffer.from('\\documentclass{article}\\begin{document}\\loop\\iftrue\\repeat\\end{document}')}]});
  assert.equal(result.status,'failed');
  assert.ok(result.diagnostics.some(item=>item.code==='COMPILE_TIMEOUT'));
  assert.equal(result.pdfPath,undefined);
});
