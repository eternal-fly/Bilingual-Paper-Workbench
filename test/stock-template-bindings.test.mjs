import test from 'node:test';
import assert from 'node:assert/strict';
import {inlineBindingRisk} from '../src/inline-binding-risk.mjs';
import {literalInlineCallBindings} from '../src/inline-call-signatures.mjs';
import {literalLexicalSafety} from '../src/range-authority.mjs';
import {STATIC_FONT_PROFILE_BODY} from '../src/static-font-profile.mjs';

const font=String.raw`\renewcommand\normalsize{`+STATIC_FONT_PROFILE_BODY+'}',aux=String.raw`\immediate\write\@auxout{\string\citation{syntheticStyle}}`;
const inspect=text=>{const files=new Map([['main.tex',{path:'main.tex',text}]]);return{risk:inlineBindingRisk(files,{}, {lexicalSafety:literalLexicalSafety}),catalog:literalInlineCallBindings(files,{lexicalSafety:literalLexicalSafety})};};
for(const [name,text]of[
 ['ordinary protected mathematics',String.raw`$\min\{n,M\}$`],
 ['literal bibliography alias',String.raw`\let\pre@bibdata\@empty`],
 ['literal theorem style alias',String.raw`\let\th@prlstatement\th@plain`],
 ['complete literal aux citation write',aux],
 ['exact stock normal font definition',font],
 ['literal stock list alias',String.raw`\let\@listi\@listI`],
])test(name+' does not make unrelated source bindings globally unknown',()=>{const result=inspect(text);assert(!result.risk.unboundedBindings);assert(!result.catalog.unboundedBindings);});

test('aux citation exceptions retain their complete context and reject dynamic output or changed helpers',()=>{
 for(const text of[
  String.raw`\string\citation{syntheticStyle}`,
  aux.replace('@auxout','otherstream'),
  aux.replace('syntheticStyle',String.raw`\dynamic`),
  aux.replace(String.raw`\citation`,String.raw`\input`),
  aux.replace('{syntheticStyle}','{syntheticStyle} extra'),
  aux+String.raw`\def\string#1{\input{#1}}`,
  aux+String.raw`\let\write\input`,
  String.raw`\def\@auxout{0}`+aux,
  aux+String.raw`\catcode65=13`,
 ])assert.equal(inspect(text).catalog.unboundedBindings,true,text);
});

test('stock font exception shares the exact range proof and denies changed signatures or transitive helpers',()=>{
 assert.equal(literalLexicalSafety(font),true);
 for(const text of[
  font.replace('13.6','999'),font.replace('renewcommand','newcommand'),
  font.replace('normalsize{','normalsize[0]{'),
  font.replace(STATIC_FONT_PROFILE_BODY,STATIC_FONT_PROFILE_BODY+String.raw`\input{synthetic-file}`),
  font.replace('@listI',String.raw`\dynamic`),
  font+String.raw`\def\@setfontsize#1#2#3{\input{#1}}`,
  String.raw`\let\@listI\input`+font,
  font+String.raw`\AddToHook{cmd/@setfontsize/before}{\input{synthetic-file}}`,
 ]){assert.equal(literalLexicalSafety(text),false,text);assert.equal(inspect(text).catalog.unboundedBindings,true,text);}
});
