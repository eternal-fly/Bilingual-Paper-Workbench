import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveInterfacePreference} from '../ui/interface-preferences.mjs';
import {uiText,resolveTargetLanguage} from '../ui/languages.mjs';
test('English is the fresh interface default and legacy implicit Chinese migrates without altering target language',()=>{
 assert.equal(resolveInterfacePreference(), 'en');
 assert.equal(resolveInterfacePreference({revision:0,uiLanguage:'zh-CN',translationLanguage:'zh-CN'},{storedLanguage:'zh-CN',cookieLanguage:'zh-CN'}),'en');
 assert.equal(resolveTargetLanguage('zh-CN','en'),'zh-CN');
 assert.equal(resolveTargetLanguage('interface','en'),'en');
 assert.equal(uiText('双语论文修订','en'),'Bilingual Paper Workbench');
});
test('explicit saved Chinese and other chosen interface languages remain available',()=>{
 assert.equal(resolveInterfacePreference({revision:2,uiLanguage:'zh-CN'}),'zh-CN');
 assert.equal(resolveInterfacePreference({revision:0,uiLanguage:'en'},{explicitLanguage:'zh-CN'}),'zh-CN');
 assert.equal(resolveInterfacePreference({revision:0,uiLanguage:'zh-CN'},{storedLanguage:'ja'}),'ja');
 assert.equal(resolveInterfacePreference({revision:0,uiLanguage:'zh-CN'},{cookieLanguage:'fr'}),'fr');
});
