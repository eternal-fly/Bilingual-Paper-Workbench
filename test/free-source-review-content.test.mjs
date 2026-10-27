import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSourceReviewReplacement} from '../src/source-review.mjs';

test('free raw source review preserves every supplied TeX byte without a content grammar or command veto',()=>{
 const source={source:'Original $x=1$ and \\label{old}.',path:'main.tex'},files=new Map([['main.tex',{hash:'original-manifest'}]]),before=structuredClone(source);
 const content=['',String.raw`正文 $x=2$ \cite{new} \label{new} \begin{custom}text\end{custom}`,String.raw`\newcommand{\Fresh}[1]{\textit{#1}}\Fresh{all raw content is editable}`,String.raw`\input{C:/synthetic/outside.tex}`,String.raw`\input{../synthetic.tex}`,String.raw`\openout1=synthetic.txt`,String.raw`\write18{synthetic-not-executed}`,String.raw`\directlua{synthetic_not_executed()}`,String.raw`\csname input\endcsname{synthetic.tex}`,String.raw`\catcode65=13 \in^^70ut{synthetic.tex}`,'An incomplete author edit $x=2 \\Unknown{ remains pending.'];
 for(const value of content)assert.equal(validateSourceReviewReplacement(source,value,files),value);
 assert.deepEqual(source,before);assert.equal(files.get('main.tex').hash,'original-manifest');
});
test('free raw content still requires bounded valid UTF-8 but does not execute or normalize author text',()=>{
 const source={source:'Original.',path:'main.tex'},files=new Map();
 for(const value of [null,7,'\u0000','\u0001','\ud800','x'.repeat(4*1024*1024+1)])assert.throws(()=>validateSourceReviewReplacement(source,value,files),{code:'INVALID_INPUT'});
 const text='中文🙂\t$z=3$\r\n\\begin{environment}\r\n\\end{environment}\n';assert.equal(validateSourceReviewReplacement(source,text,files),text);
});
