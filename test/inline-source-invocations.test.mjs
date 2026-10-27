import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceInvocationFences} from '../src/inline-source-invocations.mjs';

const safe=arity=>({arity,closed:true});
const raw=value=>value.spans.map(row=>row.raw);
const fence=(text,options)=>{const value=sourceInvocationFences(text,options);for(const span of value.spans){assert.equal(span.raw,text.slice(span.start,span.end));assert.equal(span.kind,'structure');assert.equal(span.opaqueBinding,true);}return value;};

test('closed custom zero and one calls protect only their complete literal operands',()=>{
 const text=String.raw`before \zero{unrelated} then \one{literal words} after`,value=fence(text,{bindings:{zero:safe(0),one:safe(1)}});
 assert.deepEqual(raw(value),[String.raw`\zero`,String.raw`\one{literal words}`]);assert.equal(value.opaqueRange,false);assert(!Object.hasOwn(value,'continuationStart'));
});

test('exact separators nested groups and escaped braces belong to a proven braced call',()=>{
 const call=String.raw`\one % comment
 {nested {words} and \{literal\}}`,text='before '+call+' after',value=fence(text,{bindings:{one:safe(1)}});assert.deepEqual(raw(value),[call]);assert.equal(value.opaqueRange,false);
});

test('adjacent groups are not greedily mistaken for a second argument',()=>{
 const text=String.raw`before \one{operand}{unrelated words} after`,value=fence(text,{bindings:{one:safe(1)}});assert.deepEqual(raw(value),[String.raw`\one{operand}`]);
});

test('unbraced missing or unclosed operands retain the original continuation',()=>{
 for(const tail of[String.raw`\one x after`,String.raw`\one`,String.raw`\one{unfinished`]){
  const text='editable prefix '+tail,value=fence(text,{bindings:{one:safe(1)}});assert.deepEqual(raw(value),[tail]);assert.equal(value.continuationStart,'editable prefix '.length);assert.equal(value.opaqueRange,false);
 }
});

test('unknown or file-consuming operand expansion never gains a narrow call fence',()=>{
 for(const operand of[String.raw`\input`,String.raw`\input{fixed-file}`,String.raw`\unknown`,String.raw`$x$`]){
  const text=String.raw`before \one{`+operand+'} after',value=fence(text,{bindings:{one:safe(1)}});assert.equal(value.continuationStart,7);assert.deepEqual(raw(value),[text.slice(7)]);
 }
});

test('explicit uncertainty wins while a certain direct rebinding can use its proven signature',()=>{
 const text=String.raw`before \textbf{fixed words} after`,bindings={textbf:safe(1)};
 const proven=fence(text,{bindings,reboundControls:['textbf']});assert.deepEqual(raw(proven),[String.raw`\textbf{fixed words}`]);assert(!Object.hasOwn(proven,'continuationStart'));
 const uncertain=fence(text,{bindings,reboundControls:['textbf'],uncertainControls:['textbf']});assert.deepEqual(raw(uncertain),[text.slice(7)]);assert.equal(uncertain.continuationStart,7);
});

test('default formatting remains unfenced but affected children are discovered',()=>{
 const plain=String.raw`before \textbf{plain words} Sec.~3.1 \% after`;assert.deepEqual(raw(fence(plain,{})),[]);
 const nested=String.raw`before \textbf{safe \alias{operand} tail} after`,value=fence(nested,{uncertainControls:['alias']});const start=nested.indexOf(String.raw`\alias`);assert.deepEqual(raw(value),[nested.slice(start)]);assert.equal(value.continuationStart,start);
});

test('complete fixed references math comments and verbatim are not rescanned as invocations',()=>{
 const text=String.raw`% \alias{comment}
\cite[see]{\alias} $\alias$ \(\alias\) \[\alias\] \begin{equation}\alias\end{equation} \verb|\alias| \begin{verbatim}\alias\end{verbatim} actual \zero`,value=fence(text,{bindings:{zero:safe(0)},uncertainControls:['alias']});assert.deepEqual(raw(value),[String.raw`\zero`]);
});

test('affected reference and math delimiter controls are never hidden by fixed-object skipping',()=>{
 for(const [text,name] of[[String.raw`before \cite{fixed} after`,'cite'],[String.raw`before \(x\) after`,'('],[String.raw`before \(x\) after`,')'],[String.raw`before \begin{equation}x\end{equation} after`,'equation']]){
  const value=fence(text,{uncertainControls:[name]});assert.equal(value.continuationStart,7);assert.deepEqual(raw(value),[text.slice(7)]);
 }
});

test('specific escaped symbols do not poison unrelated active spacing and retain proven arguments',()=>{
 const text=String.raw`before Sec.~3.1 \%{fixed} after`,value=fence(text,{bindings:{'%':safe(1)},symbolControls:['%'],opaqueSymbolArity:true});assert.equal(value.opaqueRange,false);assert.deepEqual(raw(value),[String.raw`\%{fixed}`]);
 const unknown=fence(text,{symbolControls:['%'],opaqueSymbolArity:true});assert.equal(unknown.opaqueRange,false);assert.equal(unknown.continuationStart,text.indexOf(String.raw`\%`));
});

test('actual uncertain active spacing legacy symbol risk and global lexical risk remain exact',()=>{
 const text=String.raw`before Sec.~3.1 after`;
 for(const options of[{symbolControls:['~']},{opaqueSymbolArity:true},{unboundedBindings:true}]){const value=fence(text,options);assert.equal(value.opaqueRange,true);assert.deepEqual(raw(value),[text]);}
 const ignored=String.raw`% ~
$~$ \verb|~|`;assert.equal(fence(ignored,{symbolControls:['~']}).opaqueRange,false);
 for(const text of[String.raw`before \one{~} after`,String.raw`before \alias{x} ~ after`])assert.equal(fence(text,{bindings:{one:safe(1)},uncertainControls:['alias'],symbolControls:['~']}).opaqueRange,true);
 const fakeVerbatim=String.raw`before \begin{verbatim}~\end{verbatim} after`;assert.equal(fence(fakeVerbatim,{uncertainControls:['verbatim'],symbolControls:['~']}).opaqueRange,true);
});

test('a suffix follows earlier bounded spans and includes every outer closing delimiter',()=>{
 const text=String.raw`before \zero and \textbf{words \alias{x} tail} after`,value=fence(text,{bindings:{zero:safe(0)},uncertainControls:['alias']});assert.deepEqual(raw(value),[String.raw`\zero`,text.slice(text.indexOf(String.raw`\alias`))]);assert.equal(value.opaqueRange,false);
});

test('unregistered custom controls retain separate range-authority rejection and bounded scans fail closed',()=>{
 assert.deepEqual(raw(fence(String.raw`before \unregistered{x} after`,{})),[]);
 const text='x'.repeat(256*1024+1),value=fence(text,{});assert.equal(value.opaqueRange,true);assert.deepEqual(raw(value),[text]);
});
