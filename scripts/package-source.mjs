import {lstat,realpath,readdir,open,mkdir,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';

export const SOURCE_VERSION='1.6.2';
export const PLUGIN_ROOT=fileURLToPath(new URL('../',import.meta.url));
const TOP=['LICENSE','NOTICE','SECURITY.md','CONTRIBUTING.md','README.md','plugin.json','package.json','mcp.json','pnpm-lock.yaml','pnpm-workspace.yaml','.gitignore'];
const DIRECTORIES=['src','ui','scripts','test','docs'];
const ASSETS=new Set(['paper-editor.svg','paper-editor.ico','icon-manifest.json','katex-fonts-OFL.txt',...[16,24,32,48,64,128,256].map(n=>`paper-editor-${n}.png`)]);
const EXCLUDED=new Set(['work','node_modules','dist','.git','private','config','cache','caches','.cache','.codex','.agents','.aws','.ssh','logs','downloads','.tmp','tmp','.temp','temp','output','outputs','artifacts','coverage','.nyc_output','__pycache__','.ds_store','thumbs.db']);
const TEXT=new Set(['.mjs','.js','.cjs','.ts','.tsx','.jsx','.cs','.ps1','.json','.md','.yaml','.yml','.toml','.css','.html','.svg','.txt']);
const SAMPLE_PDF_HASH='fdcd07816ba78761f3cbd89bcf6d8cdd42c8f86f415afc1904d7a9e3469db96a';
const MAX_FILE=8*1024*1024,MAX_TOTAL=64*1024*1024,MAX_FILES=10000;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const inside=(root,target)=>{const value=path.relative(root,target);return !value||!value.startsWith('..'+path.sep)&&value!=='..'&&!path.isAbsolute(value);};
const sensitive=name=>/^(?:\.env(?:\..*)?|\.npmrc|auth(?:entication)?\.(?:json|toml)|credentials?(?:\.[^.]*)?|secrets?(?:\.[^.]*)?|config\.toml|install-receipt\.json|runtime-receipt\.json|setup-receipt\.json)$/i.test(name)||/\.(?:pem|key|p12|pfx|sqlite3?|db|log|jsonl)$/i.test(name);
const safeName=name=>/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)&&!/[ .]$/.test(name)&&!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);

async function authorize(root,authorizedRoot){
 const selected=path.resolve(root??PLUGIN_ROOT),allowed=path.resolve(authorizedRoot??PLUGIN_ROOT);
 if(!samePath(selected,allowed))fail('SOURCE_ROOT_NOT_AUTHORIZED','Only the fixed plugin root or an explicitly authorized synthetic fixture root can be collected.');
 const stat=await lstat(selected);if(!stat.isDirectory()||stat.isSymbolicLink()||!samePath(await realpath(selected),selected))fail('SOURCE_UNSAFE_ENTRY','The source root must be a physical directory without redirected ancestors.');
 return selected;
}
function privacy(text,relative){
 const homes=/(?:[A-Za-z]:[\\/]+Users[\\/]+[^\\/\r\n<>"']+|\/(?:home|Users)\/[^/\r\n<>"']+)/gu;
 for(const match of text.matchAll(homes))if(!/^[A-Za-z]:[\\/]+Users[\\/]+(?:Public|Default)$/iu.test(match[0]))fail('SOURCE_PRIVACY_REJECTED',`A user-home path remains in ${relative}. Use a neutral placeholder.`);
 const ids=text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu)||[];
 if(ids.some(id=>!/^00000000-0000-[1-8]000-[89ab]000-00000000000[0-9a-f]$/iu.test(id)))fail('SOURCE_PRIVACY_REJECTED',`A non-synthetic session/chat identity remains in ${relative}.`);
 if(/\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/u.test(text)||/\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/iu.test(text)||/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text)||/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/u.test(text)||/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/[^\s"'<>]*(?:[?#&](?:token|capability|session)[=:]|\/)[A-Za-z0-9_-]{24,}/iu.test(text))fail('SOURCE_PRIVACY_REJECTED',`Possible credentials or a private session capability remain in ${relative}.`);
}
function safeMcp(text){
 let value;try{value=JSON.parse(text);}catch{fail('SOURCE_UNSAFE_MCP','The source MCP template must be valid JSON.');}
 const servers=value?.mcpServers,entry=servers?.['bilingual-paper-editor'];
 if(!value||Object.keys(value).some(k=>!['$schema','mcpServers'].includes(k))||!servers||Object.keys(servers).length!==1||!entry||Object.keys(entry).some(k=>!['type','command','args'].includes(k))||entry.type!=='stdio'||entry.command!=='node'||JSON.stringify(entry.args)!==JSON.stringify(['${PLUGIN_ROOT}/dist/server.mjs']))fail('SOURCE_UNSAFE_MCP','Only the portable source MCP template is permitted; installed commands, environment and private endpoints are excluded.');
}
async function readSafe(root,relative){
 const filename=path.join(root,...relative.split('/'));if(!inside(root,filename))fail('SOURCE_UNSAFE_ENTRY','A source path escaped the authorized root.');
 const before=await lstat(filename);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>MAX_FILE||!samePath(await realpath(filename),filename))fail('SOURCE_UNSAFE_ENTRY',`Unsafe source entry or redirected ancestor: ${relative}`);
 const handle=await open(filename,constants.O_RDONLY|(process.platform==='win32'?0:constants.O_NOFOLLOW));
 try{const opened=await handle.stat();if(!opened.isFile()||opened.nlink!==1||opened.dev!==before.dev||opened.ino!==before.ino)fail('SOURCE_UNSAFE_ENTRY',`Source entry changed while opening: ${relative}`);const bytes=await handle.readFile();const after=await handle.stat();if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.nlink!==1)fail('SOURCE_UNSAFE_ENTRY',`Source entry changed while reading: ${relative}`);return bytes;}finally{await handle.close();}
}
/** The CLI never accepts root authority. Tests may authorize one physical fixture
 * root explicitly; that authorization never enters an archive or manifest. */
export async function collectSourceFiles({root=PLUGIN_ROOT,authorizedRoot}={}){
 root=await authorize(root,authorizedRoot);const paths=[],casePaths=new Set();let total=0;
 const add=relative=>{const key=relative.toLowerCase();if(casePaths.has(key))fail('SOURCE_UNSAFE_ENTRY','Case-colliding source paths are not portable.');casePaths.add(key);paths.push(relative);if(paths.length>MAX_FILES)fail('SOURCE_UNSUPPORTED_FILE','The finite source file limit was exceeded.');};
 async function walk(relative){
  const directory=path.join(root,...relative.split('/')),stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||!inside(root,await realpath(directory)))fail('SOURCE_UNSAFE_ENTRY',`Unsafe source directory: ${relative}`);
  for(const entry of(await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))){if(EXCLUDED.has(entry.name.toLowerCase()))continue;if(sensitive(entry.name))fail('SOURCE_SENSITIVE_NAME',`Sensitive source filename: ${relative}/${entry.name}`);if(!safeName(entry.name))fail('SOURCE_UNSAFE_ENTRY',`Unsupported source path: ${relative}/${entry.name}`);const child=relative+'/'+entry.name,info=await lstat(path.join(root,...child.split('/')));if(info.isSymbolicLink())fail('SOURCE_UNSAFE_ENTRY',`Linked source entry: ${child}`);if(info.isDirectory())await walk(child);else if(info.isFile()){if(!TEXT.has(path.extname(entry.name).toLowerCase()))fail('SOURCE_UNSUPPORTED_FILE',`Unsupported binary or document: ${child}`);add(child);}else fail('SOURCE_UNSAFE_ENTRY',`Nonregular source entry: ${child}`);}
 }
 for(const name of TOP)add(name);for(const directory of DIRECTORIES)await walk(directory);
 const assetRoot=path.join(root,'assets'),assetStat=await lstat(assetRoot);if(!assetStat.isDirectory()||assetStat.isSymbolicLink())fail('SOURCE_UNSAFE_ENTRY','Assets must be a physical directory.');
 for(const entry of await readdir(assetRoot,{withFileTypes:true})){if(entry.name==='icon-contact-sheet.png')continue;if(!ASSETS.has(entry.name))fail('SOURCE_UNSUPPORTED_FILE',`Only known icon and font-notice source assets are permitted: assets/${entry.name}`);add('assets/'+entry.name);}
 for(const name of['fixtures/sample-paper/main.tex','fixtures/sample-paper/main.pdf'])add(name);
 const files=[];for(const relative of paths.sort()){const bytes=await readSafe(root,relative);total+=bytes.length;if(total>MAX_TOTAL)fail('SOURCE_UNSUPPORTED_FILE','The complete source archive exceeds 64 MiB.');const extension=path.extname(relative).toLowerCase();if(relative==='fixtures/sample-paper/main.pdf'){if(hash(bytes)!==SAMPLE_PDF_HASH)fail('SOURCE_SAMPLE_MISMATCH','Only the verified self-authored synthetic sample PDF is permitted.');}else if(extension==='.png'){if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))fail('SOURCE_UNSUPPORTED_FILE','An icon PNG has an invalid signature.');}else if(extension==='.ico'){if(!bytes.subarray(0,4).equals(Buffer.from([0,0,1,0])))fail('SOURCE_UNSUPPORTED_FILE','The icon ICO has an invalid signature.');}else{let text;try{text=new TextDecoder('utf8',{fatal:true}).decode(bytes);}catch{fail('SOURCE_UNSUPPORTED_FILE',`Invalid UTF-8 source text: ${relative}`);}if(text.includes('\0'))fail('SOURCE_UNSUPPORTED_FILE',`Binary data in source text: ${relative}`);if(relative==='mcp.json')safeMcp(text);privacy(text,relative);if(relative==='package.json'){let pkg;try{pkg=JSON.parse(text);}catch{fail('SOURCE_UNSUPPORTED_FILE','Invalid package manifest.');}if(pkg.version!==SOURCE_VERSION)fail('SOURCE_VERSION_MISMATCH','The source package manifest must match this release version.');}}files.push({path:relative,size:bytes.length,sha256:hash(bytes),bytes});}
 return{root,files};
}
const crcTable=Array.from({length:256},(_,value)=>{for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
const crc32=bytes=>{let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return(crc^0xffffffff)>>>0;};
export function encodeSourceZip(entries){
 if(!Array.isArray(entries))fail('SOURCE_UNSAFE_ENTRY','Provide complete named source entries.');if(entries.length>65535)fail('SOURCE_ZIP_LIMIT','ZIP32 supports at most 65535 files.');let offset=0;const parts=[],central=[],names=new Set();
 for(const entry of entries.toSorted((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)){if(typeof entry.path!=='string'||!Buffer.isBuffer(entry.bytes)||entry.path.includes('\\')||entry.path.split('/').some(p=>!safeName(p)&&!(entry.path==='.gitignore'&&p==='.gitignore'))||names.has(entry.path.toLowerCase()))fail('SOURCE_UNSAFE_ENTRY','Unsafe or colliding ZIP entry path.');names.add(entry.path.toLowerCase());const name=Buffer.from(entry.path),bytes=entry.bytes,crc=crc32(bytes);if(name.length>65535||bytes.length>0xffffffff||offset>0xffffffff)fail('SOURCE_ZIP_LIMIT','The source archive exceeds ZIP32 limits.');const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x0800,6);local.writeUInt16LE(0x0021,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(name.length,26);parts.push(local,name,bytes);const index=Buffer.alloc(46);index.writeUInt32LE(0x02014b50);index.writeUInt16LE(20,4);index.writeUInt16LE(20,6);index.writeUInt16LE(0x0800,8);index.writeUInt16LE(0x0021,14);index.writeUInt32LE(crc,16);index.writeUInt32LE(bytes.length,20);index.writeUInt32LE(bytes.length,24);index.writeUInt16LE(name.length,28);index.writeUInt32LE(offset,42);central.push(index,name);offset+=local.length+name.length+bytes.length;}
 const directory=Buffer.concat(central),end=Buffer.alloc(22);if(offset+directory.length>0xffffffff)fail('SOURCE_ZIP_LIMIT','The source archive exceeds ZIP32 limits.');end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...parts,directory,end]);
}
async function outputDirectory(root,selected){
 const base=path.join(root,'work'),target=path.resolve(root,selected??path.join(base,'source-release'));if(!inside(base,target)||samePath(base,target))fail('SOURCE_OUTPUT_UNSAFE','Source output must be in a named subdirectory of this authorized root’s work directory.');
 let current=root;for(const part of path.relative(root,target).split(path.sep)){current=path.join(current,part);try{await mkdir(current);}catch(error){if(error.code!=='EEXIST')throw error;}const stat=await lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink()||!inside(root,await realpath(current)))fail('SOURCE_OUTPUT_UNSAFE','A source output directory is redirected or nonregular.');}return target;
}
async function existingFile(filename){try{const stat=await lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)fail('SOURCE_OUTPUT_UNSAFE','An existing output is linked or nonregular.');return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
export async function createSourcePackage({root=PLUGIN_ROOT,authorizedRoot,outputDir,force=false}={}){
 if(typeof force!=='boolean')fail('SOURCE_ARGUMENT_REJECTED','Force must be explicitly true or false.');const collected=await collectSourceFiles({root,authorizedRoot}),manifest={schemaVersion:1,version:SOURCE_VERSION,files:collected.files.map(({path,size,sha256})=>({path,size,sha256}))},manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n'),zip=encodeSourceZip([...collected.files,{path:'source-manifest.json',bytes:manifestBytes}]);
 const directory=await outputDirectory(collected.root,outputDir),zipPath=path.join(directory,`bilingual-paper-workbench-${SOURCE_VERSION}-source.zip`),manifestPath=path.join(directory,'source-manifest.json'),outputs=[[zipPath,zip],[manifestPath,manifestBytes]];
 for(const [filename]of outputs)if(await existingFile(filename)&&!force)fail('SOURCE_OUTPUT_EXISTS','Source artifacts already exist; choose another output directory or pass --force explicitly.');
 const staged=[],reservations=[];try{
  for(const [filename,bytes]of outputs){const temporary=path.join(directory,'.source-package-'+randomUUID()+'.tmp'),handle=await open(temporary,'wx');staged.push({temporary,filename});try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}}
  // Exclusive empty reservations prevent a default invocation from replacing
  // somebody else's existing artifact. Each complete file then appears by rename.
  if(!force)for(const [filename]of outputs){let handle;try{handle=await open(filename,'wx');const stat=await handle.stat();reservations.push({filename,ino:stat.ino,dev:stat.dev});}catch(error){if(error.code==='EEXIST')fail('SOURCE_OUTPUT_EXISTS','Another source artifact already owns this output path.');throw error;}finally{await handle?.close();}}
  for(const item of staged){if(force)await existingFile(item.filename);else{const stat=await lstat(item.filename),owned=reservations.find(r=>r.filename===item.filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size!==0||stat.ino!==owned.ino||stat.dev!==owned.dev)fail('SOURCE_OUTPUT_UNSAFE','An output reservation changed before publication.');}await rename(item.temporary,item.filename);if(!force)reservations.splice(reservations.findIndex(r=>r.filename===item.filename),1);}
 }finally{
  for(const {temporary}of staged)await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});
  for(const owned of reservations){const stat=await lstat(owned.filename).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(stat?.isFile()&&!stat.isSymbolicLink()&&stat.size===0&&stat.nlink===1&&stat.ino===owned.ino&&stat.dev===owned.dev)await unlink(owned.filename);}
 }
 return{version:SOURCE_VERSION,zipPath,manifestPath,fileCount:collected.files.length,zipSha256:hash(zip),manifestSha256:hash(manifestBytes)};
}
export function parseCliArguments(argv){const result={};for(let at=0;at<argv.length;at++){const arg=argv[at];if(arg==='--force')result.force=true;else if(arg==='--out-dir'&&typeof argv[at+1]==='string'&&!argv[at+1].startsWith('--'))result.outputDir=argv[++at];else if(arg==='--help')result.help=true;else fail('SOURCE_ARGUMENT_REJECTED','Supported arguments: --out-dir <directory inside plugin/work>, --force, --help. Source roots cannot be overridden.');}return result;}
if(process.argv[1]&&samePath(path.resolve(process.argv[1]),fileURLToPath(import.meta.url))){try{const options=parseCliArguments(process.argv.slice(2));if(options.help)console.log('node scripts/package-source.mjs [--out-dir <plugin/work/subdirectory>] [--force]');else console.log(JSON.stringify(await createSourcePackage(options)));}catch(error){console.error(`${error.code||'SOURCE_PACKAGE_FAILED'}: ${error.message}`);process.exitCode=1;}}
