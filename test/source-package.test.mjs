import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,link,utimes} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const pluginRoot=fileURLToPath(new URL('../',import.meta.url));
const module=await import('../scripts/package-source.mjs').catch(error=>({loadError:error}));
const api=()=>{assert.equal(module.loadError,undefined,'Implement the finite source packager before using this contract.');return module;};
const topFiles=['LICENSE','NOTICE','SECURITY.md','CONTRIBUTING.md','README.md','plugin.json','package.json','mcp.json','pnpm-lock.yaml','pnpm-workspace.yaml','.gitignore'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t,{reverse=false}={}){
 const owned=path.join(pluginRoot,'work/source-package-tests');await mkdir(owned,{recursive:true});const root=await mkdtemp(path.join(owned,'case-'));
 for(const directory of['src','ui','scripts','test','docs','assets','fixtures/sample-paper'])await mkdir(path.join(root,directory),{recursive:true});
 const values=topFiles.map(name=>[name,name==='package.json'?JSON.stringify({name:'bilingual-paper-editor',version:'1.6.3',license:'MIT'}):name==='plugin.json'?JSON.stringify({name:'bilingual-paper-editor',version:'1.6.3'}):name==='mcp.json'?JSON.stringify({$schema:'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',mcpServers:{'bilingual-paper-editor':{type:'stdio',command:'node',args:['${PLUGIN_ROOT}/dist/server.mjs']}}}):'Synthetic public '+name+'\n']);
 values.push(['src/main.mjs','export const sample = 1;\n'],['ui/index.html','<p>Synthetic reader</p>\n'],['scripts/build.mjs','// Synthetic build entry\n'],['test/main.test.mjs','// Synthetic source test\n'],['docs/guide.md','# Synthetic guide\n'],['assets/paper-editor.svg','<svg xmlns="http://www.w3.org/2000/svg"></svg>\n'],['assets/katex-fonts-OFL.txt','Synthetic font notice\n'],['fixtures/sample-paper/main.tex','\\documentclass{article}\n\\begin{document}Synthetic sample.\\end{document}\n']);
 for(const [name,text]of reverse?values.toReversed():values)await writeFile(path.join(root,name),text);
 await writeFile(path.join(root,'fixtures/sample-paper/main.pdf'),await readFile(path.join(pluginRoot,'fixtures/sample-paper/main.pdf')));
 t.after(async()=>{assert(root.startsWith(owned+path.sep));await rm(root,{recursive:true,force:true});});return root;
}
function zipEntries(bytes){const values=new Map();let at=0;while(bytes.readUInt32LE(at)===0x04034b50){assert.equal(bytes.readUInt16LE(at+8),0);const size=bytes.readUInt32LE(at+18),nameSize=bytes.readUInt16LE(at+26),extra=bytes.readUInt16LE(at+28),name=bytes.subarray(at+30,at+30+nameSize).toString('utf8'),start=at+30+nameSize+extra;assert(!values.has(name));values.set(name,bytes.subarray(start,start+size));at=start+size;}assert.equal(bytes.readUInt32LE(at),0x02014b50);return values;}

test('source package includes only finite public source and an exact hash manifest',async t=>{
 const root=await fixture(t);for(const name of['work/private','node_modules/private','dist/private','private','config','src/private','test/.tmp','docs/artifacts']){await mkdir(path.join(root,name),{recursive:true});await writeFile(path.join(root,name,'secret.txt'),'Excluded synthetic private data.');}
 const result=await api().createSourcePackage({root,authorizedRoot:root}),zip=zipEntries(await readFile(result.zipPath)),manifest=JSON.parse(await readFile(result.manifestPath,'utf8'));
 assert.equal(manifest.version,'1.6.3');assert.equal(manifest.schemaVersion,1);assert.deepEqual(manifest.files.map(x=>x.path),manifest.files.map(x=>x.path).toSorted());assert.equal(zip.size,manifest.files.length+1);assert.deepEqual(zip.get('source-manifest.json'),await readFile(result.manifestPath));
 for(const entry of manifest.files){assert.equal(entry.size,zip.get(entry.path).length);assert.equal(entry.sha256,hash(zip.get(entry.path)));assert(!/^(?:work|node_modules|dist|private|config)\//.test(entry.path));}assert(![...zip.keys()].some(p=>p.includes('secret')));assert(!JSON.stringify(manifest).includes(root));
 assert.equal((await api().collectSourceFiles({root,authorizedRoot:root})).files.length,manifest.files.length);
});
test('ZIP metadata and manifest bytes ignore file order, mtimes and authorized fixture root',async t=>{
 const first=await fixture(t),second=await fixture(t,{reverse:true});await utimes(path.join(second,'src/main.mjs'),new Date(1),new Date(1));const a=await api().createSourcePackage({root:first,authorizedRoot:first}),b=await api().createSourcePackage({root:second,authorizedRoot:second});assert.deepEqual(await readFile(a.zipPath),await readFile(b.zipPath));assert.deepEqual(await readFile(a.manifestPath),await readFile(b.manifestPath));
 const before=await readFile(a.zipPath);await assert.rejects(api().createSourcePackage({root:first,authorizedRoot:first}),{code:'SOURCE_OUTPUT_EXISTS'});assert.deepEqual(await readFile(a.zipPath),before);await api().createSourcePackage({root:first,authorizedRoot:first,force:true});assert.deepEqual(await readFile(a.zipPath),before);
});
test('the CLI cannot select another root and exports require exact fixture-root authorization',async t=>{
 const root=await fixture(t);assert.throws(()=>api().parseCliArguments(['--root',root]),{code:'SOURCE_ARGUMENT_REJECTED'});assert.throws(()=>api().parseCliArguments(['--authorized-root',root]),{code:'SOURCE_ARGUMENT_REJECTED'});await assert.rejects(api().collectSourceFiles({root}),{code:'SOURCE_ROOT_NOT_AUTHORIZED'});await assert.rejects(api().collectSourceFiles({root,authorizedRoot:path.dirname(root)}),{code:'SOURCE_ROOT_NOT_AUTHORIZED'});await assert.rejects(api().createSourcePackage({root,authorizedRoot:root,outputDir:path.join(root,'src/release')}),{code:'SOURCE_OUTPUT_UNSAFE'});
});
test('ZIP entry paths reject extraction escapes and collisions while relative output stays inside the authorized work tree',async t=>{
 for(const name of['../escape.txt','/escape.txt','C:/escape.txt','safe\\escape.txt'])assert.throws(()=>api().encodeSourceZip([{path:name,bytes:Buffer.from('x')}]),{code:'SOURCE_UNSAFE_ENTRY'});assert.throws(()=>api().encodeSourceZip([{path:'A.txt',bytes:Buffer.from('x')},{path:'a.txt',bytes:Buffer.from('y')}]),{code:'SOURCE_UNSAFE_ENTRY'});const root=await fixture(t),result=await api().createSourcePackage({root,authorizedRoot:root,outputDir:'work/relative-release'});assert(result.zipPath.startsWith(path.join(root,'work/relative-release')+path.sep));
});
test('links and unsupported document binaries are rejected without traversing excluded private data',async t=>{
 const root=await fixture(t);await mkdir(path.join(root,'work/secret'),{recursive:true});await writeFile(path.join(root,'work/secret/private.txt'),'Synthetic excluded content');await symlink(path.join(root,'work/secret'),path.join(root,'src/linked'),process.platform==='win32'?'junction':'dir');await assert.rejects(api().collectSourceFiles({root,authorizedRoot:root}),{code:'SOURCE_UNSAFE_ENTRY'});await rm(path.join(root,'src/linked'));await link(path.join(root,'src/main.mjs'),path.join(root,'src/hard.mjs'));await assert.rejects(api().collectSourceFiles({root,authorizedRoot:root}),{code:'SOURCE_UNSAFE_ENTRY'});await rm(path.join(root,'src/hard.mjs'));await writeFile(path.join(root,'docs/paper.pdf'),'%PDF-synthetic unsupported document');await assert.rejects(api().collectSourceFiles({root,authorizedRoot:root}),{code:'SOURCE_UNSUPPORTED_FILE'});
});
test('the exact sample paths cannot follow a linked fixture ancestor even within the authorized root',async t=>{
 const root=await fixture(t),sample=path.join(root,'fixtures/sample-paper'),target=path.join(root,'work/private-sample');assert(sample.startsWith(root+path.sep));assert(target.startsWith(root+path.sep));await mkdir(target,{recursive:true});await writeFile(path.join(target,'main.pdf'),await readFile(path.join(sample,'main.pdf')));await writeFile(path.join(target,'main.tex'),'Private synthetic research content must not enter a source archive.');await rm(sample,{recursive:true,force:true});await symlink(target,sample,process.platform==='win32'?'junction':'dir');await assert.rejects(api().collectSourceFiles({root,authorizedRoot:root}),{code:'SOURCE_UNSAFE_ENTRY'});
});
test('privacy gate rejects sensitive names, credentials, actual home paths and non-synthetic chat identities',async t=>{
 const root=await fixture(t),entry=path.join(root,'src/main.mjs'),unsafe=['sk-'+'x'.repeat(40),'C:'+String.fromCharCode(92)+'Users'+String.fromCharCode(92)+'PrivatePerson'+String.fromCharCode(92)+'paper.tex',['01234567','89ab','7abc','8def','0123456789ab'].join('-'),'Authorization: Bearer '+'A'.repeat(40)];
 for(const text of unsafe){await writeFile(entry,text);await assert.rejects(api().collectSourceFiles({root,authorizedRoot:root}),{code:'SOURCE_PRIVACY_REJECTED'});}await writeFile(entry,'// synthetic public source\n');await writeFile(path.join(root,'src/credentials.json'),'{}');await assert.rejects(api().collectSourceFiles({root,authorizedRoot:root}),{code:'SOURCE_SENSITIVE_NAME'});
});
test('installed MCP configuration and replaced sample PDFs fail before any artifact is created',async t=>{
 const root=await fixture(t),mcp=path.join(root,'mcp.json');await writeFile(mcp,JSON.stringify({mcpServers:{'bilingual-paper-editor':{type:'stdio',command:'node',args:['${PLUGIN_ROOT}/dist/server.mjs'],env:{TOKEN:'x'.repeat(40)}}}}));await assert.rejects(api().createSourcePackage({root,authorizedRoot:root}),{code:'SOURCE_UNSAFE_MCP'});await writeFile(mcp,JSON.stringify({mcpServers:{'bilingual-paper-editor':{type:'stdio',command:'node',args:['${PLUGIN_ROOT}/dist/server.mjs']}}}));await writeFile(path.join(root,'fixtures/sample-paper/main.pdf'),'%PDF-replaced-sample');await assert.rejects(api().createSourcePackage({root,authorizedRoot:root}),{code:'SOURCE_SAMPLE_MISMATCH'});
});
