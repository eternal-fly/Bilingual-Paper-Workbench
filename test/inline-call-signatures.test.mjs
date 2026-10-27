import test from 'node:test';
import assert from 'node:assert/strict';
import {literalInlineCallBindings,closedInlineOperand} from '../src/inline-call-signatures.mjs';

const prove=(text,extra=[])=>literalInlineCallBindings(new Map([['main.tex',{path:'main.tex',text}],...extra]));
const binding=(value,name,arity)=>assert.deepEqual(value.bindings[name],{arity,closed:true});
const uncertain=(value,...names)=>{for(const name of names){assert(!Object.hasOwn(value.bindings,name),name);assert(value.uncertainControls.includes(name),name);}};

test('literal zero and one argument declarations have independently bounded signatures',()=>{
 const value=prove(String.raw`\newcommand{\zero}{literal words}\newcommand\one[1]{#1}\renewcommand{\ren}[0]{x}\providecommand\provided[1]{\textsf{#1}}\DeclareRobustCommand{\robust}[1]{\underline{#1}}\def\plain{plain}\def\primitive#1{\textbf{#1}}`);
 for(const name of['zero','ren','plain'])binding(value,name,0);for(const name of['one','provided','robust','primitive'])binding(value,name,1);assert.deepEqual(value.uncertainControls,[]);
});

test('file consumers remain unproved even when their formal input argument is complete',()=>{
 const value=prove(String.raw`\def\closed#1{\input{#1}}\def\fixed{\input{literal-file}}\def\open#1{\input}\def\unbraced#1{\input #1}`);
 uncertain(value,'closed','fixed','open','unbraced');
});

test('literal helper DAGs are closed while cycles and unknown consumers are rejected',()=>{
 const value=prove(String.raw`\def\outer#1{\middle{#1}}\def\middle#1{\leaf{#1}}\def\leaf#1{\textit{#1}}\def\cycleA#1{\cycleB{#1}}\def\cycleB#1{\cycleA{#1}}\def\unknown#1{\unseen{#1}}`);
 for(const name of['outer','middle','leaf'])binding(value,name,1);uncertain(value,'cycleA','cycleB','unknown');
});

test('optional defaults stars xparse and delimited primitive parameters are not guessed',()=>{
 const value=prove(String.raw`\newcommand*{\star}[1]{#1}\newcommand{\default}[1][x]{#1}\newcommand{\two}[2]{#1#2}\NewDocumentCommand{\xparse}{m}{#1}\def\delimited#1!{#1}\def\spaced#1 {#1}\def\mixed#1#2{#1#2}\def{\grouped}{word}`);
 uncertain(value,'star','default','two','xparse','delimited','spaced','mixed','grouped');
 const symbol=prove(String.raw`\def~ #1{#1}`);uncertain(symbol,'~');
});

test('conditional definitions and incompatible definitions remain uncertain',()=>{
 const value=prove(String.raw`\ifdefined\flag\def\conditional#1{#1}\else\def\conditional{x}\fi\def\conflict#1{#1}\def\conflict{x}\def\identical#1{\textbf{#1}}\def\identical#1{\textbf{#1}}`);
 uncertain(value,'conditional','conflict');binding(value,'identical',1);
});

test('lookahead alias definitions and dynamic body machinery do not prove a closed tail',()=>{
 const value=prove(String.raw`\def\peek#1{\futurelet\next\helper}\def\expanded#1{\expandafter\textbf\expandafter{#1}}\def\constructed#1{\csname #1\endcsname}\def\aliased#1{\let\a\input}\def\read#1{\read0to\a}\let\alias\textbf\def\depends#1{\alias{#1}}`);
 uncertain(value,'peek','expanded','constructed','aliased','read','alias','depends');
});

test('rebound input or fixed consumers invalidate dependent closures regardless of file order',()=>{
 for(const entries of[
  [['custom.sty',{path:'custom.sty',text:String.raw`\renewcommand{\input}[1]{\unknown{#1}}`}]],
  [['custom.sty',{path:'custom.sty',text:String.raw`\let\input\unknown`}]],
 ]){const value=prove(String.raw`\def\dependent#1{\input{#1}}`,entries);uncertain(value,'dependent','input');}
 const value=prove(String.raw`\def\leaf#1{\textbf{#1}}\def\textbf#1{\futurelet\x\y}`);uncertain(value,'leaf','textbf');
 const transitive=prove(String.raw`\def\leaf#1{\textbf{#1}}\def\bfseries#1{#1}`);uncertain(transitive,'leaf');
});

test('an ordinary literal alias poisons only its destination while staged mutation is not guessed',()=>{
 const ordinary=prove(String.raw`\def\one#1{#1}\let\unrelated\unknown`);binding(ordinary,'one',1);uncertain(ordinary,'unrelated');
 for(const prefix of[String.raw`\aftergroup`,String.raw`\noexpand`,String.raw`\string`]){const value=prove(prefix+String.raw`\def\one#1{#1}`);uncertain(value,'one');}
});

test('escaped literal and active symbol declarations are parsed without invoking them',()=>{
 const value=prove(String.raw`\def~{ }\renewcommand{\%}[1]{#1}\DeclareRobustCommand\,[0]{ }\def\punct#1{\{#1\}\%\#\$\&\_\!\,~}`);
 binding(value,'~',0);binding(value,'%',1);binding(value,',',0);uncertain(value,'punct');
 const normal=prove(String.raw`\def\punct#1{\{#1\}\%\#\$\&\_\!\,~}`);binding(normal,'punct',1);
});

test('comments and verbatim bodies are inert and captured binary resources are ignored',()=>{
 const text=String.raw`% \def\fake#1{\input}
\verb|\def\fake#1{\input}|\begin{verbatim}\def\fake#1{\input}\end{verbatim}
\def\real#1{\textbf% a comment before a fixed argument
{#1}}`;
 const value=prove(text,[['image.pdf',{path:'image.pdf',bytes:Buffer.from(String.raw`\def\real{unsafe}`)}]]);binding(value,'real',1);assert(!Object.hasOwn(value.bindings,'fake'));assert(!value.uncertainControls.includes('fake'));
});

test('incomplete groups parameters and local or prefixed definitions are not signature proof',()=>{
 const value=prove(String.raw`{\def\local#1{#1}}\long\def\prefixed#1{#1}\def\badParam{#1}\def\trailing#1{\textbf}\def\unclosed#1{abc`);
 uncertain(value,'local','prefixed','badParam','trailing','unclosed');
});

test('invalid captured text and lexical mutation fail closed without reading external files',()=>{
 const lexical=prove(String.raw`\def\simple#1{#1}\catcode65=13`);uncertain(lexical,'simple');assert.equal(lexical.unboundedBindings,true);
 const invalid=prove(String.raw`\def\simple#1{#1}`,[['broken.def',{path:'broken.def',bytes:Buffer.from([255])}]]);uncertain(invalid,'simple');
 const encoded=prove(String.raw`\def\simple#1{#1} ^^5cinput`);uncertain(encoded,'simple');assert.equal(encoded.unboundedBindings,true);
 assert.equal(prove(String.raw`\aftergroup\def\simple#1{#1}`).unboundedBindings,true);
});

test('depth work and recursive helper limits fail closed with bounded output',()=>{
 const nested='{'.repeat(65)+'x'+'}'.repeat(65),value=prove(String.raw`\def\deep#1{`+nested+'}');uncertain(value,'deep');
 let chain='';for(let i=0;i<70;i++)chain+=`\\def\\c${String.fromCharCode(65+i%26)}${String.fromCharCode(65+Math.floor(i/26))}#1{\\c${String.fromCharCode(65+(i+1)%26)}${String.fromCharCode(65+Math.floor((i+1)/26))}{#1}}`;
 const bounded=prove(chain);assert.equal(Object.keys(bounded.bindings).length,0);assert(bounded.uncertainControls.length<=70);
 const oversized=prove('\\def\\'+'a'.repeat(256)+'#1{#1}');assert.equal(Object.keys(oversized.bindings).length,0);assert(oversized.uncertainControls.every(name=>name.length<=128));
});

test('original operands must themselves have closed literal expansion before a call can be narrowed',()=>{
 const catalog=prove(String.raw`\def\zero{word}\def\one#1{\textsf{#1}}`);
 for(const text of[String.raw`ordinary words`,String.raw`\textbf{bold words}`,String.raw`\one{\zero}`,String.raw`\{a\}\%\,~`])assert.equal(closedInlineOperand(text,catalog),true,text);
 for(const text of[String.raw`\input`,String.raw`\input{fixed}`,String.raw`\textbf`,String.raw`\one{\unknown}`,String.raw`\unknown{a}`,String.raw`\one x`,String.raw`#1`,String.raw`x^`,String.raw`text%terminal`,String.raw`{unfinished`])assert.equal(closedInlineOperand(text,catalog),false,text);
 const rebound=prove(String.raw`\def\textbf#1{\input{#1}}`);assert.equal(closedInlineOperand(String.raw`\textbf{fixed}`,rebound),false);
});

test('unknown constructor targets and global lexical uncertainty cannot restore builtin closure by omission',()=>{
 const constructor=prove(String.raw`\def\textbf#1{#1}\customdeclare{\textbf}{unsafe}`);uncertain(constructor,'textbf');
 const deferred=prove(String.raw`\def\leaf#1{\textbf{#1}}\def\later{\customdeclare{\textbf}{unsafe}}`);uncertain(deferred,'leaf');
 const lexical=prove(String.raw`\catcode65=13`);assert.equal(closedInlineOperand(String.raw`\textbf{word}`,lexical),false);assert.equal(closedInlineOperand(String.raw`\%`,lexical),false);
});

test('the existing complete stock lexical proof can isolate verified captured shim machinery',()=>{
 const text=String.raw`\def\ordinary#1{\textsf{#1}}\catcode65=11`,files=new Map([['main.tex',{path:'main.tex',text}]]);
 const safe=literalInlineCallBindings(files,{lexicalSafety:value=>value===text});binding(safe,'ordinary',1);
 const unsafe=literalInlineCallBindings(files,{lexicalSafety:()=>false});uncertain(unsafe,'ordinary');
});

test('ordinary presentation consumers do not impersonate helper-rebinding constructors',()=>{
 const preamble=String.raw`\documentclass{article}
\newcommand{\eng}{\noindent{\normalfont\sffamily\scriptsize\color{Muted}EN}\enspace\ignorespaces}
\newcommand{\chin}{\noindent{\normalfont\sffamily\scriptsize\color{Muted}中}\enspace\ignorespaces}
\newenvironment{pairedoriginal}[1]{\par\begingroup\color{#1}}{\par\endgroup\smallskip}
\newcommand{\bilingualheading}[2]{\par\textbf{#1 / #2}\par}
\newcommand{\reasonlabel}{Reason}
\begin{document}
\def\unrelated{opaque}
A claim keeps $x_1=\{1,2\}$, \(y^2\), \[z=3\], \cite[see]{alpha,beta}, \ref{fig:one}, \textbf{nested {words}}, and \href{locked}{object} intact.
\end{document}`;
 const value=prove(preamble);binding(value,'unrelated',0);binding(value,'reasonlabel',0);
 assert(!Object.hasOwn(value,'unboundedBindings'));
 for(const name of['~','%','textbf','textit','mbox','y','z'])assert(!value.uncertainControls.includes(name),name);
 const unsafe=prove(preamble+String.raw`\def\later{\customdeclare{\textbf}{unsafe}}`);uncertain(unsafe,'unrelated');
});

test('existing zero-argument presentation markers retain the bounded canonical body proof and dependency guards',()=>{
 const declaration=String.raw`\newcommand{\langmarker}{\noindent\normalfont\sffamily\scriptsize\color{blue}\enspace\ignorespaces}`;
 binding(prove(declaration),'langmarker',0);
 for(const suffix of[String.raw`\def\sffamily#1{\input{#1}}`,String.raw`\def\color#1{\input{#1}}`,String.raw`\def\set@color#1{\input{#1}}`,String.raw`\def\enspace#1{\input{#1}}`])uncertain(prove(declaration+suffix),'langmarker');
 uncertain(prove(String.raw`\newcommand{\langmarker}{\noindent\color{\unsafe}\ignorespaces}`),'langmarker');
});

test('unsupported environment bodies do not change the scope of following literal definitions',()=>{
 for(const declaration of[
  String.raw`\newenvironment{env}{}{\endgroup}`,
  String.raw`\NewDocumentEnvironment{env}{m}{}{\endgroup}`,
 ]){
  const value=prove('{'+declaration+String.raw`\def\local#1{#1}}\def\outside{word}`);
  uncertain(value,'local','env');binding(value,'outside',0);assert(!Object.hasOwn(value,'unboundedBindings'));
 }
 const actual=prove(String.raw`\newenvironment{env}{}{\catcode65=13}\def\outside{word}`);assert.equal(actual.unboundedBindings,true);uncertain(actual,'outside');
});

test('ordinary conditional-like math and argument consumers do not create unfinished TeX conditionals',()=>{
 for(const name of['iff','ifthenelse','ifstrequal','ifstrempty','ifblank','ifnumcomp','ifdimcomp','ifboolexpr','ifbool','iftoggle','ifdefempty','ifcsempty','ifdefstring','ifcsstring']){
  const value=prove(`\\${name}{textbf}{literal}{other}\\def\\outside{word}`);assert(!value.unboundedBindings,name);binding(value,'outside',0);assert(!value.uncertainControls.includes('textbf'),name);
 }
 assert.equal(closedInlineOperand(String.raw`\iff`),false);assert.equal(closedInlineOperand(String.raw`\ifthenelse{x}{y}{z}`),false);
 const rebound=prove(String.raw`\def\iff{\iftrue}\iff\def\outside{word}`);assert.equal(rebound.unboundedBindings,true);uncertain(rebound,'outside');
});

test('literal newif declarations do not execute their conditional while actual conditional scopes stay conservative',()=>{
 const declared=prove(String.raw`\newif\ifdraft\def\outside{word}`);assert(!declared.unboundedBindings);binding(declared,'outside',0);
 const balanced=prove(String.raw`\newif\ifdraft\ifdraft\def\local{word}\fi\def\outside{word}`);uncertain(balanced,'local');binding(balanced,'outside',0);
 for(const name of['ifdefined','ifx','ifnum','ifdraft','ifunknown']){const value=prove(`\\${name}\\flag\\def\\outside{word}`);assert.equal(value.unboundedBindings,true,name);uncertain(value,'outside');}
 for(const declaration of[String.raw`\newif\ifx`,String.raw`\newif\iff`,String.raw`\newif{\ifdraft}`,String.raw`\newif\csname ifdraft\endcsname`])assert.equal(prove(declaration).unboundedBindings,true,declaration);
});
