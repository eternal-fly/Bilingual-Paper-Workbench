import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {collectBundledNotices} from '../scripts/third-party-notices.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
async function fixture(t){const owned=path.join(root,'work/notice-tests');await mkdir(owned,{recursive:true});const directory=await mkdtemp(path.join(owned,'case-'));await writeFile(path.join(directory,'LICENSE'),'MIT License\nCopyright synthetic maintainer\nPermission is hereby granted.\n');t.after(async()=>{assert(directory.startsWith(owned+path.sep));await rm(directory,{recursive:true,force:true});});return directory;}
async function dependency(root,relative,{name,version='1.0.0',license='MIT',text='Synthetic complete license text.',notice}={}){const folder=path.join(root,relative);await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'package.json'),JSON.stringify({name,version,license}));if(text!==null)await writeFile(path.join(folder,'LICENSE'),text);if(notice)await writeFile(path.join(folder,'NOTICE'),notice);return relative.replaceAll('\\','/')+'/index.mjs';}

test('notices follow the actual bundle closure including indirect scoped packages and their NOTICE files',async t=>{
 const root=await fixture(t),a=await dependency(root,'node_modules/direct',{name:'direct'}),b=await dependency(root,'node_modules/.pnpm/indirect@2/node_modules/@scope/indirect',{name:'@scope/indirect',version:'2.0.0',license:'Apache-2.0',notice:'Synthetic retained upstream NOTICE.'});
 const result=await collectBundledNotices({root,metafiles:[{inputs:{[a]:{},'src/own.mjs':{}}},{inputs:{[b]:{},[a]:{}}}],fontNotice:'Synthetic OFL notice and Reserved Font Names.'});assert.deepEqual(result.packages.map(p=>p.name),['@scope/indirect','direct']);assert.equal(result.packages.length,2);assert.match(result.text,/Synthetic retained upstream NOTICE/);assert.match(result.text,/Copyright synthetic maintainer/);assert.match(result.text,/Reserved Font Names/);assert(!result.text.includes(root));
});
test('a dependency with metadata but no retained license fails instead of silently producing incomplete notices',async t=>{const root=await fixture(t),input=await dependency(root,'node_modules/unlicensed',{name:'unlicensed',text:null});await assert.rejects(collectBundledNotices({root,metafiles:[{inputs:{[input]:{}}}],fontNotice:'OFL'}),{code:'DEPENDENCY_LICENSE_MISSING'});});
test('metafiles cannot use a dependency path outside the selected checkout',async t=>{const root=await fixture(t);await assert.rejects(collectBundledNotices({root,metafiles:[{inputs:{'../unapproved/node_modules/private/index.mjs':{}}}],fontNotice:'OFL'}),{code:'BUNDLE_INPUT_OUTSIDE_ROOT'});});
test('different installed versions retain separate license records and ordering is deterministic',async t=>{const root=await fixture(t),a=await dependency(root,'node_modules/.pnpm/dep@1/node_modules/dep',{name:'dep'}),b=await dependency(root,'node_modules/.pnpm/dep@2/node_modules/dep',{name:'dep',version:'2.0.0'});const options={root,fontNotice:'OFL'};const first=await collectBundledNotices({...options,metafiles:[{inputs:{[a]:{},[b]:{}}}]}),second=await collectBundledNotices({...options,metafiles:[{inputs:{[b]:{},[a]:{}}}]});assert.equal(first.text,second.text);assert.deepEqual(first.packages.map(p=>p.version),['1.0.0','2.0.0']);});
