import {readFile,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';

const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const inside=(root,value)=>value===root||value.startsWith(root+path.sep);
const legalName=/^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/iu;
const order=(a,b)=>a<b?-1:a>b?1:0;

/** Retain legal texts for the actual esbuild input closure, not just direct
 * package.json dependencies. Metafiles stay in memory and never enter output. */
export async function collectBundledNotices({root,metafiles,extraInputs=[],fontNotice}={}){
  const checkout=path.resolve(root),moduleRoot=path.join(checkout,'node_modules'),directories=new Set();
  const inputs=[...metafiles.flatMap(meta=>Object.keys(meta.inputs||{})),...extraInputs];
  for(const input of inputs){
    if(!/(?:^|[/\\])node_modules[/\\]/u.test(input))continue;
    const filename=path.resolve(checkout,input);
    if(!inside(moduleRoot,filename))fail('BUNDLE_INPUT_OUTSIDE_ROOT','A bundled dependency input is outside this checkout.');
    const parts=filename.split(path.sep),index=parts.lastIndexOf('node_modules');
    if(index<0||!parts[index+1]||parts[index+1].startsWith('.'))fail('BUNDLE_INPUT_INVALID','A bundled dependency has no exact package root.');
    const count=parts[index+1].startsWith('@')?2:1;
    if(count===2&&!parts[index+2])fail('BUNDLE_INPUT_INVALID','A scoped dependency has no package name.');
    directories.add(parts.slice(0,index+count+1).join(path.sep));
  }
  const physicalModules=await realpath(moduleRoot),records=new Map();
  for(const directory of [...directories].sort(order)){
    const physical=await realpath(directory);
    if(!inside(physicalModules,physical))fail('BUNDLE_INPUT_OUTSIDE_ROOT','A bundled package resolves outside this checkout dependency tree.');
    const info=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));
    if(typeof info.name!=='string'||typeof info.version!=='string')fail('DEPENDENCY_METADATA_INVALID','A bundled package has incomplete identity metadata.');
    const files=(await readdir(directory,{withFileTypes:true})).filter(entry=>entry.isFile()&&legalName.test(entry.name)).map(entry=>entry.name).sort(order),texts=[];
    for(const name of files){
      const filename=path.join(directory,name),physicalFile=await realpath(filename);
      if(!inside(physical,physicalFile))fail('BUNDLE_INPUT_OUTSIDE_ROOT','A legal notice resolves outside its package.');
      const bytes=await readFile(filename);if(bytes.length>512*1024)fail('DEPENDENCY_LICENSE_INVALID','A dependency legal notice exceeds its supported size.');
      const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).trim();if(text)texts.push({name,text});
    }
    if(!texts.some(file=>/^(?:licen[cs]e|copying)(?:[._-].*)?$/iu.test(file.name)))fail('DEPENDENCY_LICENSE_MISSING',`Retained license text is missing for ${info.name}@${info.version}.`);
    const record={name:info.name,version:info.version,license:typeof info.license==='string'?info.license:'See retained license texts',texts},key=info.name+'@'+info.version,previous=records.get(key);
    if(previous&&JSON.stringify(previous)!==JSON.stringify(record))fail('DEPENDENCY_LICENSE_CONFLICT','The same bundled dependency identity has differing legal notices.');
    records.set(key,record);
  }
  const packages=[...records.values()].sort((a,b)=>order(a.name,b.name)||order(a.version,b.version));
  const ownLicense=(await readFile(path.join(checkout,'LICENSE'),'utf8')).trim();
  if(!ownLicense.includes('MIT License')||typeof fontNotice!=='string'||!fontNotice.trim())fail('LICENSE_NOTICE_MISSING','Retain the first-party MIT grant and bundled font notice.');
  const parts=['# Third-party notices','## Bilingual Paper Workbench — first-party MIT License',ownLicense,'## Dependencies actually bundled'];
  for(const record of packages)parts.push(`### ${record.name} ${record.version}\n\nLicense: ${record.license}\n\n`+record.texts.map(file=>`#### ${file.name}\n\n${file.text}`).join('\n\n'));
  parts.push('## KaTeX bundled display fonts\n\nLicense: SIL Open Font License 1.1\n\n'+fontNotice.trim());
  return{text:parts.join('\n\n')+'\n',packages:packages.map(({name,version,license})=>({name,version,license}))};
}
