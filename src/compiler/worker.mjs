import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdir, readFile, writeFile, stat, lstat, readdir } from 'node:fs/promises';
import { buildFontconfig } from '../../scripts/fonts-config.mjs';
import { compilerProfile, inputManifestIdentity } from '../build-identity.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const fail = (code,message) => { throw Object.assign(new Error(message),{code}); };
const windows = value => value.replaceAll('\\','/');
const within = (root,value) => value===root || value.startsWith(root+path.sep);
const MAX_SOURCE = 64 * 1024 * 1024, MAX_PDF=20*1024*1024;
function relative(value) {
  if(typeof value!=='string'||!value||value.length>512||path.isAbsolute(value)||value.includes('\\')||value.split('/').some(part=>!part||part==='.'||part==='..'||/[\x00-\x1f<>:"|?*]/u.test(part)||/[. ]$/u.test(part)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part))) fail('INVALID_INPUT','Compiler inputs must have safe relative names.');
  return value;
}
function normalized(input) {
  if(!input||!['xelatex','pdflatex'].includes(input.engine)||!Array.isArray(input.files)||!input.files.length||input.files.length>500) fail('INVALID_INPUT','Choose an allowlisted engine and bounded input snapshot.');
  const mainFile=relative(input.mainFile),seen=new Set();let size=0;
  // pdfTeX's fixed startup command names only this relative manifest entry.
  // Do not let a filename become TeX syntax, even inside a quoted filename.
  if(input.engine==='pdflatex'&&/[{}%#$&^~]/u.test(mainFile))fail('INVALID_INPUT','The pdfTeX main filename cannot contain TeX metacharacters.');
  const files=input.files.map(file=>{
    const name=relative(file.path),key=name.toLowerCase();
    if(seen.has(key)||!Buffer.isBuffer(file.bytes)||file.bytes.length>16*1024*1024||(size+=file.bytes.length)>MAX_SOURCE) fail('INVALID_INPUT','Duplicate, non-byte or oversized compiler input.');
    seen.add(key);return {path:name,bytes:Buffer.from(file.bytes)};
  });
  if(!files.some(file=>file.path===mainFile)||!mainFile.toLowerCase().endsWith('.tex')) fail('INVALID_INPUT','The main TeX file is absent from the snapshot.');
  return {...input,mainFile,files};
}
export function inputHash({engine,mainFile,files}) {
  return inputManifestIdentity({engine,mainFile,files:files.map(file=>({path:file.path,hash:sha(file.bytes)}))});
}
async function noReparse(root) {
  let current=path.resolve(root);
  while(current!==path.dirname(current)) { if((await lstat(current)).isSymbolicLink()) fail('PERMISSION_DENIED','Compiler directories cannot contain reparse points.');current=path.dirname(current); }
}
async function readBounded(filename,limit) {await noReparse(filename);const metadata=await lstat(filename);if(!metadata.isFile()||metadata.nlink!==1||metadata.size>limit)fail('ARTIFACT_TOO_LARGE','Compiler artifact exceeds policy or is aliased.');const bytes=await readFile(filename);if(bytes.length>limit)fail('ARTIFACT_TOO_LARGE','Compiler artifact grew beyond policy.');return bytes;}
function configuration(runtime,input,output) {
  const rt=windows(runtime),inRoot=windows(input),out=windows(output);
  return `\n% Bilingual Paper Editor isolated worker overrides\nTEXMFROOT = ${rt}\nTEXMFDIST = $TEXMFROOT/texmf-dist\nTEXMFSYSVAR = $TEXMFROOT/texmf-var\nTEXMFVAR = ${out}/texmf-var\nTEXMFCONFIG = ${out}/texmf-config\nTEXMFHOME = ${out}/empty-home\nTEXMFLOCAL = ${out}/empty-local\nTEXMF = {$TEXMFSYSVAR,$TEXMFDIST}\nTEXMFDBS = {}\nTEXINPUTS = ${inRoot}//;$TEXMFDIST/tex//\nTEXFORMATS = $TEXMFSYSVAR/web2c/{$engine,}//\nTFMFONTS = $TEXMFDIST/fonts/tfm//\nVFFONTS = $TEXMFDIST/fonts/vf//\nT1FONTS = $TEXMFDIST/fonts/type1//\nOPENTYPEFONTS = ${rt}/fonts//;$TEXMFDIST/fonts/opentype//\nTTFONTS = ${rt}/fonts//\nTEXFONTMAPS = $TEXMFSYSVAR/fonts/map//;$TEXMFDIST/fonts/map//\nENCFONTS = $TEXMFDIST/fonts/enc//\nTEXPSHEADERS = $TEXMFDIST/fonts/type1//;$TEXMFDIST/dvips//\nDVIPDFMXINPUTS = $TEXMFDIST/dvipdfmx//\nBIBINPUTS = ${out}//;${inRoot}//\nBSTINPUTS = ${inRoot}//;$TEXMFDIST/bibtex/bst//\nopenin_any = p\nopenout_any = p\nshell_escape = f\nshell_escape_commands =\nparse_first_line = f\nMKTEXPK = 0\nMKTEXTFM = 0\nMKTEXMF = 0\nMKTEXFMT = 0\n`;
}

export class CompilerWorker {
  constructor({dataRoot,runtimeRoot,fontsRoot,wallMs=60000,cpuSeconds=45,memoryBytes=1024*1024*1024}={}) {
    if(typeof dataRoot!=='string'||!dataRoot)fail('INVALID_INPUT','A private compiler data directory is required.');
    this.dataRoot=path.resolve(dataRoot);
    this.runtimeRoot=path.resolve(runtimeRoot||process.env.PAPER_EDITOR_COMPILER_RUNTIME||path.join(process.env.LOCALAPPDATA||os.homedir(),'BilingualPaperEditor/compiler/runtime64'));
    if(within(this.runtimeRoot,this.dataRoot)||within(this.dataRoot,this.runtimeRoot))fail('INVALID_INPUT','Private compiler data must be separate from public runtime assets.');
    this.fontsRoot=fontsRoot?path.resolve(fontsRoot):path.join(this.runtimeRoot,'fonts');
    if(!within(this.runtimeRoot,this.fontsRoot))fail('INVALID_INPUT','Fonts must be provisioned inside the isolated runtime.');
    this.broker=path.join(this.runtimeRoot,'broker/AppContainerBroker.exe');
    this.limits={wallMs,cpuSeconds,memoryBytes,outputBytes:64*1024*1024,outputFiles:200};
    this._probe=null;this._queue=Promise.resolve();
  }
  async _run({input,output,executable,arguments:args,environment={},signal,testProbe=false,texConfig,fontConfig,mountHints,resourceLimits}) {
    const cancelFile=path.join(output,'cancel.flag');
    if(signal?.aborted)return{ok:true,status:'cancelled',exitCode:0,isolation:{verified:false}};
    const request={operation:'run',runtimeRoot:this.runtimeRoot,inputRoot:input,outputRoot:output,executable,arguments:args,environment,...this.limits,...resourceLimits,cancelViaStdin:true,testProbe,texConfig,fontConfig,mountHints};
    return new Promise((resolve,reject)=>{
      const child=spawn(this.broker,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
      let stdout='',stderr='',settled=false;
      const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(watchdog);signal?.removeEventListener('abort',cancel);if(error)reject(error);else resolve(result);};
      const cancel=()=>{if(!child.stdin.destroyed)child.stdin.write('cancel\n',error=>{if(error)child.kill();});};
      signal?.addEventListener('abort',cancel,{once:true});
      const watchdog=setTimeout(()=>{child.kill();finish(Object.assign(new Error('The compiler broker timed out.'),{code:'SANDBOX_TIMEOUT'}));},request.wallMs+195000);
      child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>1024*1024){child.kill();finish(Object.assign(new Error('Broker output exceeds policy.'),{code:'SANDBOX_OUTPUT_LIMIT'}));}});
      child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4096);});
      child.on('error',error=>finish(Object.assign(new Error('The isolated compiler broker could not start.'),{code:'SANDBOX_UNAVAILABLE',cause:error})));
      child.on('exit',()=>{
        try{const result=JSON.parse(stdout.trim());if(!result.ok)finish(Object.assign(new Error(result.message||'AppContainer startup failed.'),{code:'SANDBOX_UNAVAILABLE',nativeErrorCode:result.nativeErrorCode}));else if(!result.cleanup?.aclRevoked||!result.cleanup?.profileDeleted||!result.cleanup?.mountsRemoved)finish(Object.assign(new Error('Compiler sandbox cleanup requires recovery.'),{code:'SANDBOX_CLEANUP_REQUIRED'}));else finish(null,result);}
        catch(error){finish(Object.assign(new Error('The compiler broker returned no valid isolation result.'),{code:'SANDBOX_UNAVAILABLE',cause:error}));}
      });
      child.stdin.on('error',()=>{});
      child.stdin.write(JSON.stringify(request)+'\n');
    });
  }
  async probe() {
    if(process.platform!=='win32')return{available:false,isolated:false,mechanism:'Windows AppContainer',code:'PLATFORM_UNSUPPORTED'};
    if(this._probe)return structuredClone(this._probe);
    let server;
    try{
      await stat(this.broker);await noReparse(this.runtimeRoot);
      const root=path.join(this.dataRoot,'compiler','probes',randomUUID()),input=path.join(root,'input'),output=path.join(root,'output'),outside=path.join(root,'outside');
      for(const dir of[input,output,outside])await mkdir(dir,{recursive:true,mode:0o700});
      const secret=path.join(outside,'private.txt'),escape=path.join(outside,'escape.txt');await writeFile(secret,'SYNTHETIC_PRIVATE_SECRET');
      const readonlyInput=path.join(input,'immutable.txt');await writeFile(readonlyInput,'IMMUTABLE_INPUT');
      server=net.createServer(socket=>socket.end());await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      // Prove the endpoint is reachable outside the sandbox before testing its denial inside.
      await new Promise((resolve,reject)=>{const socket=net.connect({host:'127.0.0.1',port:server.address().port},()=>socket.end());socket.once('error',reject);socket.once('close',resolve);});
      const result=await this._run({input,output,executable:path.join(this.runtimeRoot,'broker/AppContainerProbe.exe'),arguments:[secret,escape,path.join(output,'allowed.txt'),String(server.address().port),readonlyInput],testProbe:true,resourceLimits:{wallMs:10000,cpuSeconds:5,memoryBytes:268435456,outputBytes:1048576,outputFiles:20}});
      const lines=(await readBounded(result.logPath,65536)).toString('utf8').trim().split(/\r?\n/);const evidence=JSON.parse(lines.at(-1));
      if(result.exitCode!==0||!result.isolation?.appContainer||!result.isolation?.zeroCapabilities||evidence.privateRead||evidence.hostWrite||evidence.inputWrite||evidence.childSpawn||evidence.loopbackNetwork||!evidence.outputWrite||![10013,10060].includes(evidence.socketError)||(await readFile(readonlyInput,'utf8'))!=='IMMUTABLE_INPUT')fail('SANDBOX_PROBE_FAILED','Operating-system isolation checks did not pass.');
      this._probe={available:true,isolated:true,mechanism:'Windows AppContainer + restricted child policy + Job Object',probe:evidence,isolation:{...result.isolation,verified:true},runtimeRoot:this.runtimeRoot};
      return structuredClone(this._probe);
    }catch(error){return{available:false,isolated:false,mechanism:'Windows AppContainer',code:error.code||'SANDBOX_UNAVAILABLE',message:error.message};}
    finally{if(server)await new Promise(resolve=>server.close(resolve));}
  }
  build(input) {
    let data;
    try{data=normalized(input);}catch(error){return Promise.reject(error);}
    const task=this._queue.then(()=>this._build(data));this._queue=task.catch(()=>{});return task;
  }
  async locate({build,sourcePath,line,column=0,signal}={}) {
    if(!build||!/^build-[a-f0-9-]{36}$/i.test(build.buildId)||!Number.isSafeInteger(line)||line<1||line>1000000||!Number.isSafeInteger(column)||column<0||column>1000000)fail('INVALID_INPUT','A verified build and a bounded source location are required.');
    sourcePath=relative(sourcePath);
    if(!sourcePath.toLowerCase().endsWith('.tex'))fail('INVALID_INPUT','Only compiled TeX source locations are supported.');
    const buildRoot=path.join(this.dataRoot,'compiler','jobs',build.buildId);
    const manifest=JSON.parse((await readBounded(path.join(buildRoot,'build-manifest.json'),1024*1024)).toString('utf8'));
    if(manifest.status!=='success'||!manifest.isolation?.verified||manifest.buildId!==build.buildId||manifest.pdfHash!==build.pdfHash||manifest.inputHash!==build.inputHash||!manifest.synctexPath)fail('VERSION_CONFLICT','The requested build is not a current verified SyncTeX artifact.');
    const selected=manifest.inputFiles.find(file=>file.path===sourcePath);if(!selected)fail('PERMISSION_DENIED','The requested file is outside the compiled source snapshot.');
    const pdf=await readBounded(path.join(buildRoot,'output/paper.pdf'),MAX_PDF);
    if(sha(pdf)!==manifest.pdfHash)fail('VERSION_CONFLICT','The PDF artifact changed after compilation.');
    const source=await readBounded(path.join(buildRoot,'input',sourcePath),16*1024*1024);if(sha(source)!==selected.hash)fail('VERSION_CONFLICT','The source snapshot changed after compilation.');
    const synctex=await readBounded(path.join(buildRoot,'output/paper.synctex.gz'),8*1024*1024);
    const query=path.join(this.dataRoot,'compiler','queries',randomUUID()),input=path.join(query,'input'),output=path.join(query,'output');
    await mkdir(input,{recursive:true});await mkdir(output,{recursive:true});await mkdir(path.dirname(path.join(input,sourcePath)),{recursive:true});
    await writeFile(path.join(input,'paper.pdf'),pdf);await writeFile(path.join(input,'paper.synctex.gz'),synctex);await writeFile(path.join(input,sourcePath),source);
    const map=manifest.pathMaps?.find(map=>Object.values(map).some(value=>path.resolve(value)===path.resolve(path.join(buildRoot,'input'))));
    if(!map)fail('ANCHOR_UNAVAILABLE','The build does not retain an exact compiler source-path map.');
    const hints={};for(const [alias,original] of Object.entries(map)){if(path.resolve(original)===path.resolve(this.runtimeRoot))hints.runtime=alias;else if(path.resolve(original)===path.resolve(path.join(buildRoot,'input')))hints.input=alias;else if(path.resolve(original)===path.resolve(path.join(buildRoot,'output')))hints.output=alias;}
    const result=await this._run({input,output,executable:path.join(this.runtimeRoot,'bin/synctex.exe'),arguments:['view','-i',`${line}:${column}:${windows(path.join(input,sourcePath))}`,'-o',windows(path.join(input,'paper.pdf'))],mountHints:hints,signal,resourceLimits:{wallMs:10000,cpuSeconds:5,memoryBytes:268435456,outputBytes:1048576,outputFiles:20}});
    if(result.status!=='exited'||result.exitCode!==0)fail(result.status==='cancelled'?'JOB_CANCELLED':'ANCHOR_UNAVAILABLE','The isolated SyncTeX query did not complete.');
    const text=(await readBounded(result.logPath,1024*1024)).toString('utf8'),matches=[];
    for(const block of text.split('SyncTeX result begin').slice(1).flatMap(block=>block.split(/(?=^Page:)/m))){
      const values={};for(const line of block.split(/\r?\n/)){const item=/^(Page|x|y|h|v|W|H):\s*(-?\d+(?:\.\d+)?)/.exec(line);if(item)values[item[1]]=Number(item[2]);}
      if(Number.isInteger(values.Page)&&values.Page>=1&&Number.isFinite(values.x)&&Number.isFinite(values.y))matches.push({page:values.Page,x:values.x,y:values.y,width:values.W||0,height:values.H||0,h:values.h,v:values.v});
    }
    return{buildId:manifest.buildId,snapshotId:manifest.snapshotId,pdfHash:manifest.pdfHash,sourcePath,line,column,matches,method:'synctex',verified:true};
  }
  async inverse({build,page,x,y,signal}={}) {
    if(!build||!/^build-[a-f0-9-]{36}$/i.test(build.buildId)||!Number.isSafeInteger(page)||page<1||page>100000||!Number.isFinite(x)||x<0||x>1000000||!Number.isFinite(y)||y<0||y>1000000)fail('INVALID_INPUT','A pinned build and bounded PDF location are required.');
    const buildRoot=path.join(this.dataRoot,'compiler','jobs',build.buildId);
    const manifest=JSON.parse((await readBounded(path.join(buildRoot,'build-manifest.json'),1024*1024)).toString('utf8'));
    if(manifest.status!=='success'||!manifest.isolation?.verified||manifest.buildId!==build.buildId||manifest.pdfHash!==build.pdfHash||manifest.inputHash!==build.inputHash||!manifest.synctexPath)fail('VERSION_CONFLICT','The build has no verified inverse SyncTeX artifact.');
    const pdf=await readBounded(path.join(buildRoot,'output/paper.pdf'),MAX_PDF);if(sha(pdf)!==manifest.pdfHash)fail('VERSION_CONFLICT','The PDF artifact changed after compilation.');
    const query=path.join(this.dataRoot,'compiler','queries',randomUUID()),input=path.join(query,'input'),output=path.join(query,'output');
    await mkdir(input,{recursive:true});await mkdir(output,{recursive:true});
    await writeFile(path.join(input,'paper.pdf'),pdf);await writeFile(path.join(input,'paper.synctex.gz'),await readBounded(path.join(buildRoot,'output/paper.synctex.gz'),8*1024*1024));
    for(const file of manifest.inputFiles.filter(file=>file.path.toLowerCase().endsWith('.tex'))){
      relative(file.path);const bytes=await readBounded(path.join(buildRoot,'input',file.path),16*1024*1024);if(sha(bytes)!==file.hash)fail('VERSION_CONFLICT','A compiled source snapshot changed.');await mkdir(path.dirname(path.join(input,file.path)),{recursive:true});await writeFile(path.join(input,file.path),bytes);
    }
    const map=manifest.pathMaps?.find(map=>Object.values(map).some(value=>path.resolve(value)===path.resolve(path.join(buildRoot,'input'))));if(!map)fail('ANCHOR_UNAVAILABLE','Compiled source-path map is absent.');
    const hints={};for(const [alias,original]of Object.entries(map)){if(path.resolve(original)===path.resolve(this.runtimeRoot))hints.runtime=alias;else if(path.resolve(original)===path.resolve(path.join(buildRoot,'input')))hints.input=alias;else if(path.resolve(original)===path.resolve(path.join(buildRoot,'output')))hints.output=alias;}
    const result=await this._run({input,output,executable:path.join(this.runtimeRoot,'bin/synctex.exe'),arguments:['edit','-o',`${page}:${x}:${y}:${windows(path.join(input,'paper.pdf'))}`],mountHints:hints,signal,resourceLimits:{wallMs:10000,cpuSeconds:5,memoryBytes:268435456,outputBytes:1048576,outputFiles:20}});
    if(result.status!=='exited'||result.exitCode!==0)fail(result.status==='cancelled'?'JOB_CANCELLED':'ANCHOR_UNAVAILABLE','The isolated inverse SyncTeX query failed.');
    const text=(await readBounded(result.logPath,1024*1024)).toString('utf8'),matches=[];
    for(const block of text.split('SyncTeX result begin').slice(1).flatMap(block=>block.split(/(?=^Input:)/m))){
      const name=/^Input:(.*)$/m.exec(block)?.[1]?.trim(),number=Number(/^Line:(\d+)/m.exec(block)?.[1]),column=Number(/^Column:(-?\d+)/m.exec(block)?.[1]);
      if(!name||!Number.isSafeInteger(number)||number<1)continue;
      const alias=windows(hints.input||'');if(!windows(name).toLowerCase().startsWith(alias.toLowerCase()))continue;
      const relativePath=windows(name).slice(alias.length),file=manifest.inputFiles.find(file=>file.path.toLowerCase()===relativePath.toLowerCase());
      if(file)matches.push({sourcePath:file.path,line:number,column:Number.isSafeInteger(column)?column:0});
    }
    return{buildId:manifest.buildId,snapshotId:manifest.snapshotId,pdfHash:manifest.pdfHash,page,x,y,matches,method:'synctex',verified:true};
  }
  async _build(data) {
    const buildId=`build-${randomUUID()}`,identity=inputHash(data);
    const profile=compilerProfile(data.engine);
    const base={buildId,projectId:data.projectId,snapshotId:data.snapshotId,candidateHash:data.candidateHash,engine:data.engine,...(profile?{compilerProfile:profile}:{}),inputHash:identity,isolation:{verified:false}};
    if(data.signal?.aborted)return{...base,status:'cancelled',diagnostics:[{code:'JOB_CANCELLED',severity:'info',message:'Compilation was cancelled.'}]};
    const capability=await this.probe();
    if(!capability.available||!capability.isolated)return{...base,status:'failed',diagnostics:[{code:capability.code||'CAPABILITY_UNAVAILABLE',severity:'error',message:capability.message||'Verified AppContainer compilation is unavailable.'}]};
    const root=path.join(this.dataRoot,'compiler','jobs',buildId),input=path.join(root,'input'),output=path.join(root,'output');
    for(const directory of[input,output])await mkdir(directory,{recursive:true,mode:0o700});
    await noReparse(root);
    for(const file of data.files){const filename=path.join(input,file.path);await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,file.bytes,{flag:'wx'});}
    const defaultConfig=await readFile(path.join(this.runtimeRoot,'texmf-dist/web2c/texmf.cnf'),'utf8');
    // Place overrides first: kpathsea keeps the first definition of a variable.
    const texConfig=configuration(this.runtimeRoot,input,output)+defaultConfig;
    const fontConfig=buildFontconfig({bundleDir:this.fontsRoot,latinDir:path.join(this.runtimeRoot,'texmf-dist/fonts/opentype/public/lm'),cacheDir:path.join(output,'font-cache')});
    // Environment precedence also overrides upstream TEXINPUTS.xelatex/pdftex.
    // Include output for generated aux files, then the immutable project for
    // relative graphics/includes, and finally the public distribution styles.
    const texInputs=[windows(output),windows(input)+'//',windows(path.join(this.runtimeRoot,'texmf-dist/tex'))+'//'].join(';');
    const bstInputs=[windows(input)+'//',windows(path.join(this.runtimeRoot,'texmf-dist/bibtex/bst'))+'//'].join(';');
    const bibInputs=[windows(output)+'//',windows(input)+'//'].join(';');
    const env={TEXMFCNF:windows(output),TEXINPUTS:texInputs,BSTINPUTS:bstInputs,BIBINPUTS:bibInputs,FONTCONFIG_FILE:windows(path.join(output,'fonts.conf')),FONTCONFIG_PATH:windows(output),HOME:windows(output),OSFONTDIR:windows(this.fontsRoot),MKTEXPK:'0',MKTEXTFM:'0',MKTEXMF:'0',MKTEXFMT:'0'};
    const records=[],logs=[],pathMaps=[];let state='success',failure,mountHints;
    const run=async(name,args)=>{
      const result=await this._run({input,output,executable:path.join(this.runtimeRoot,'bin',name+'.exe'),arguments:args,environment:env,signal:data.signal,texConfig,fontConfig,mountHints});
      mountHints=result.mountHints;pathMaps.push(result.pathMap);
      records.push({program:name,status:result.status,exitCode:result.exitCode,wallMs:result.wallMs,isolation:result.isolation});
      if(result.logPath)logs.push((await readBounded(result.logPath,8*1024*1024)).toString('utf8'));
      if(result.status==='cancelled'||data.signal?.aborted){state='cancelled';return false;}
      if(result.status!=='exited'||result.exitCode!==0){state='failed';failure=result.status==='timeout'?'COMPILE_TIMEOUT':result.status==='outputLimit'?'OUTPUT_LIMIT':'COMPILE_FAILED';return false;}
      if(!result.isolation?.appContainer||!result.isolation?.zeroCapabilities)fail('SANDBOX_UNAVAILABLE','The worker token lost its isolation evidence.');
      return true;
    };
    const texArgs=['-no-shell-escape','-halt-on-error','-interaction=nonstopmode','-file-line-error','-recorder','-synctex=1','-jobname=paper','-output-directory=.'];
    if(data.engine==='xelatex')texArgs.push('-no-pdf');
    // This only changes PDF object storage, not template or source bytes. The
    // relative entry is validated above and found through immutable TEXINPUTS;
    // no user root or arbitrary prelude enters this trusted command expression.
    texArgs.push(profile?`\\pdfobjcompresslevel=0\\relax\\input{"${data.mainFile}"}`:windows(path.join(input,data.mainFile)));
    try{
      if(await run(data.engine,texArgs)){
        const aux=await readBounded(path.join(output,'paper.aux'),1024*1024).then(bytes=>bytes.toString('utf8')).catch(error=>{if(error.code==='ENOENT')return'';throw error;});
        const bibliography=/\\bibdata\{/.test(aux);
        let ready=!bibliography||await run('bibtex',['paper']);
        if(ready)ready=await run(data.engine,texArgs);
        // The first post-BibTeX pass writes citation identities to the aux file;
        // the final bounded pass reads them before typesetting the main text.
        if(ready&&bibliography)ready=await run(data.engine,texArgs);
        if(ready&&data.engine==='xelatex')await run('xdvipdfmx',['-q','-o','paper.pdf','paper.xdv']);
      }
    }catch(error){state=data.signal?.aborted?'cancelled':'failed';failure=error.code||'COMPILE_FAILED';logs.push(error.message+(error.nativeErrorCode?` (Win32 ${error.nativeErrorCode})`:''));}
    const logPath=path.join(root,'build.log');await writeFile(logPath,logs.join('\n\n').slice(0,8*1024*1024));
    const isolation={...capability.isolation,verified:records.length>0&&records.every(item=>item.isolation?.appContainer&&item.isolation?.zeroCapabilities&&item.isolation?.perProcessIdentity),processes:records.map(({program,status,exitCode,wallMs})=>({program,status,exitCode,wallMs}))};
    const diagnostics=[];
    if(state!=='success')diagnostics.push({code:state==='cancelled'?'JOB_CANCELLED':failure||'COMPILE_FAILED',severity:state==='cancelled'?'info':'error',message:state==='cancelled'?'Compilation was cancelled.':'Compilation did not produce an acceptable isolated build. Inspect the private build log.'});
    let pdfPath,pdfHash,synctexPath;
    if(state==='success'){
      try{
        for(const file of data.files)if(sha(await readFile(path.join(input,file.path)))!==sha(file.bytes))fail('SNAPSHOT_CHANGED','The immutable input snapshot changed during compilation.');
        pdfPath=path.join(output,'paper.pdf');const pdf=await readBounded(pdfPath,MAX_PDF);if(!pdf.subarray(0,5).equals(Buffer.from('%PDF-')))fail('PDF_INVALID','The compiler did not produce a valid PDF signature.');pdfHash=sha(pdf);
        const fls=(await readBounded(path.join(output,'paper.fls'),4*1024*1024)).toString('utf8');
        for(const line of fls.split(/\r?\n/))if(line.startsWith('INPUT ')){
          let raw=line.slice(6);
          for(const map of pathMaps)for(const [alias,original] of Object.entries(map||{}))if(raw.replaceAll('\\','/').toLowerCase().startsWith(alias.replaceAll('\\','/').toLowerCase()))raw=path.join(original,raw.slice(alias.length));
          const filename=path.resolve(output,raw);
          if(!within(input,filename)&&!within(this.runtimeRoot,filename)&&!within(output,filename))fail('READSET_OUTSIDE_SANDBOX','The compiler recorder reports an input outside the approved snapshot/runtime.');
        }
        synctexPath=path.join(output,'paper.synctex.gz');await readBounded(synctexPath,8*1024*1024).catch(error=>{if(error.code==='ENOENT')synctexPath=undefined;else throw error;});
        if(logs.some(log=>/LaTeX Warning:|Overfull \\hbox|Underfull \\hbox/.test(log)))diagnostics.push({code:'COMPILE_WARNINGS',severity:'warning',message:'The engine reported layout or reference warnings; inspect the build log.'});
      }catch(error){state='failed';pdfPath=undefined;synctexPath=undefined;diagnostics.push({code:error.code||'BUILD_ARTIFACT_MISSING',severity:'error',message:error.message});}
    }
    const result={...base,status:state,isolation,diagnostics,logPath,pathMaps,...(pdfPath?{pdfPath,pdfHash}:{}),...(synctexPath?{synctexPath}:{})};
    await writeFile(path.join(root,'build-manifest.json'),JSON.stringify({...result,inputFiles:data.files.map(file=>({path:file.path,hash:sha(file.bytes)})),createdAt:new Date().toISOString()},null,2));
    return result;
  }
}
