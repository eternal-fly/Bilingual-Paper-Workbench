import {closedInlineOperand} from './inline-call-signatures.mjs';

const MAX_TEXT=256*1024,MAX_DEPTH=32,MAX_SPANS=16384;
const REFERENCES=new Set('cite citep citet citealp citealt citeauthor citeyear nocite ref eqref pageref autoref cref Cref label'.split(' '));
const MATH_ENVIRONMENTS=new Set('equation equation* align align* aligned alignedat alignat alignat* gather gather* gathered multline multline* displaymath math eqnarray eqnarray* matrix pmatrix bmatrix Bmatrix vmatrix Vmatrix smallmatrix cases array split'.split(' '));
const VERBATIM_ENVIRONMENTS=new Set(['verbatim','verbatim*','Verbatim','lstlisting','minted']);
const SYMBOLS=new Set([...'~%&#_${} ,;:!']);
const word=c=>c!==undefined&&/[A-Za-z@]/u.test(c);
const own=(object,name)=>Object.hasOwn(object,name);
function control(text,start){
 if(text[start]!=='\\'||start+1>=text.length)return null;
 let end=start+1;while(word(text[end]))end++;if(end===start+1)end++;
 return{name:text.slice(start+1,end),start,end};
}
function skip(text,at){
 for(;;){while(at<text.length&&/\s/u.test(text[at]))at++;
  if(text[at]!=='%')return at;const newline=text.indexOf('\n',at);if(newline<0)return text.length;at=newline+1;
 }
}
function group(text,start,open='{',close='}'){
 if(text[start]!==open)return null;let depth=1;
 for(let at=start+1;at<text.length;){
  if(text[at]==='\\'){const c=control(text,at);if(!c)return null;at=c.end;continue;}
  if(text[at]==='%'){const newline=text.indexOf('\n',at);if(newline<0)return null;at=newline+1;continue;}
  if(text[at]===open){if(++depth>MAX_DEPTH)return null;}
  else if(text[at]===close&&--depth===0)return{start,end:at+1,inner:text.slice(start+1,at)};
  at++;
 }
 return null;
}
function referenceEnd(text,c){
 let at=skip(text,c.end);if(text[at]==='*')at=skip(text,at+1);
 for(let count=0;count<2&&text[at]==='[';count++){const g=group(text,at,'[',']');if(!g)return null;at=skip(text,g.end);}
 return group(text,at)?.end??null;
}
function environment(text,c){const g=group(text,skip(text,c.end));return g?{name:g.inner,end:g.end}:null;}
const environmentAffected=(name,affected)=>affected('begin')||affected('end')||affected(name)||affected('end'+name);
function verbatimEnd(text,c,affected=()=>false){
 if(c.name==='verb'){
  let at=c.end;if(text[at]==='*')at++;const delimiter=text[at];if(!delimiter||/\s/u.test(delimiter))return null;
  const end=text.indexOf(delimiter,at+1);return end<0?null:end+1;
 }
 if(c.name==='begin'){
  const env=environment(text,c);if(!env||!VERBATIM_ENVIRONMENTS.has(env.name))return undefined;
  if(environmentAffected(env.name,affected))return null;
  const end=text.indexOf(`\\end{${env.name}}`,env.end);return end<0?null:end+env.name.length+6;
 }
 return undefined;
}
function mathEnd(text,start,affected){
 let close,at,env=null,depth=1;
 if(text[start]==='$'){close=text.startsWith('$$',start)?'$$':'$';at=start+close.length;}
 else{
  const c=control(text,start);if(!c)return undefined;
  if(c.name==='('||c.name==='['){
   const closer=c.name==='('?')':']';if(affected(c.name)||affected(closer))return null;close='\\'+closer;at=c.end;
  }else if(c.name==='begin'){
   const g=environment(text,c);if(!g||!MATH_ENVIRONMENTS.has(g.name))return undefined;
   if(environmentAffected(g.name,affected))return null;env=g.name;at=g.end;
  }else return undefined;
 }
 while(at<text.length){
  if(text[at]==='%'){at=skip(text,at);continue;}
  if(text[at]==='\\'){
   const c=control(text,at);if(!c)return null;
   if(env&&(c.name==='begin'||c.name==='end')){
    const g=environment(text,c);if(g?.name===env){if(c.name==='begin'){if(++depth>MAX_DEPTH)return null;}else if(--depth===0)return g.end;at=g.end;continue;}
   }
   if(!env&&text.startsWith(close,at))return at+close.length;at=c.end;continue;
  }
  if(!env&&close[0]==='$'&&text.startsWith(close,at))return at+close.length;
  at++;
 }
 return null;
}
function hasLegacyOrActiveRisk(text,affected,legacySymbols){
 for(let at=0;at<text.length;){
  if(text[at]==='%'){at=skip(text,at);continue;}
  if(text[at]==='~'){if(legacySymbols||affected('~'))return true;at++;continue;}
  if(text[at]==='$'){const end=mathEnd(text,at,affected);at=end??at+1;continue;}
  if(text[at]!=='\\'){at++;continue;}const c=control(text,at);if(!c)return false;
  const math=mathEnd(text,at,affected);if(math!==undefined&&math!==null){at=math;continue;}
  if(legacySymbols&&SYMBOLS.has(c.name))return true;
  if(!affected(c.name)){
   if(REFERENCES.has(c.name)){const end=referenceEnd(text,c);if(end!==null){at=end;continue;}}
   const verbatim=verbatimEnd(text,c,affected);if(verbatim!==undefined&&verbatim!==null){at=verbatim;continue;}
  }
  at=c.end;
 }
 return false;
}

/** Exact original source fences only. The catalog must be freshly derived from
 * this captured snapshot. It is not permission to introduce or execute TeX.
 * A continuation fence must remain byte-exact and final in the containing range. */
export function sourceInvocationFences(text,options={}){
 const span=(start,end)=>({start,end,raw:text.slice(start,end),kind:'structure',opaqueBinding:true});
 const whole=()=>({spans:text.length?[span(0,text.length)]:[],opaqueRange:true});
 if(typeof text!=='string')return{spans:[],opaqueRange:true};
 try{
  const {bindings={},uncertainControls=[],reboundControls=[],symbolControls=[],opaqueSymbolArity=false,unboundedBindings=false}=options;
  if(unboundedBindings||text.length>MAX_TEXT)return whole();
  const uncertain=new Set(uncertainControls),rebound=new Set([...reboundControls,...symbolControls]),affected=name=>own(bindings,name)||uncertain.has(name)||rebound.has(name);
  const operandUncertain=[...new Set([...uncertain,...[...rebound].filter(name=>!own(bindings,name))])];
  const catalog={bindings,uncertainControls:operandUncertain},legacySymbols=opaqueSymbolArity&&symbolControls.length===0;
  if((legacySymbols||affected('~'))&&hasLegacyOrActiveRisk(text,affected,legacySymbols))return whole();
  const spans=[];
  const suffix=start=>({spans:[...spans,span(start,text.length)],continuationStart:start,opaqueRange:false});
  for(let at=0;at<text.length;){
   if(text[at]==='%'){at=skip(text,at);continue;}
   if(text[at]==='~'){
    if(affected('~')||legacySymbols)return whole();at++;continue;
   }
   if(text[at]==='$'){
    const end=mathEnd(text,at,affected);if(end===null)return suffix(at);at=end;continue;
   }
   if(text[at]!=='\\'){at++;continue;}const c=control(text,at);if(!c)return suffix(at);
   if(legacySymbols&&SYMBOLS.has(c.name))return whole();
   const math=mathEnd(text,at,affected);
   if(math!==undefined){if(math===null)return suffix(at);at=math;continue;}
   if(affected(c.name)){
    const binding=!uncertain.has(c.name)&&own(bindings,c.name)?bindings[c.name]:null;
    if(binding?.closed!==true||binding.arity!==0&&binding.arity!==1)return suffix(at);
    let end=c.end;
    if(binding.arity===1){
     const argument=group(text,skip(text,c.end));
     if(!argument||!closedInlineOperand(argument.inner,catalog))return suffix(at);end=argument.end;
    }
    spans.push(span(at,end));if(spans.length>MAX_SPANS)return whole();at=end;continue;
   }
   if(REFERENCES.has(c.name)){const end=referenceEnd(text,c);if(end!==null){at=end;continue;}}
   const verbatim=verbatimEnd(text,c,affected);
   if(verbatim!==undefined){if(verbatim===null)return suffix(at);at=verbatim;continue;}
   at=c.end;
  }
  return{spans,opaqueRange:false};
 }catch{return whole();}
}
