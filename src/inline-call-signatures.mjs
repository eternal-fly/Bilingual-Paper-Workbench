// This is a bounded literal proof, not a TeX evaluator. A signature describes
// the complete literal call shape; callers must also preserve and check each
// original operand before using it to bound an opaque source invocation.
import {purePresentationBody} from './latex.mjs';
import {STATIC_FONT_PROFILE_HELPERS,isStaticFontProfileBody,mentionsStaticFontHelper} from './static-font-profile.mjs';
const FILE=/\.(?:tex|sty|cls|bbl|ltx|def|cfg)$/iu;
const MAX_TEXT=8*1024*1024,MAX_BODY=128*1024,MAX_DEFINITIONS=4096,MAX_DEPTH=32;
const DECLARATIONS=new Set('newcommand renewcommand providecommand DeclareRobustCommand'.split(' '));
const ENVIRONMENTS=new Set('newenvironment renewenvironment provideenvironment'.split(' '));
const DOCUMENT_ENVIRONMENTS=new Set('NewDocumentEnvironment RenewDocumentEnvironment ProvideDocumentEnvironment DeclareDocumentEnvironment'.split(' '));
const OTHER_DECLARATIONS=new Set('newrobustcmd renewrobustcmd providerobustcmd NewDocumentCommand RenewDocumentCommand ProvideDocumentCommand DeclareDocumentCommand NewExpandableDocumentCommand RenewExpandableDocumentCommand ProvideExpandableDocumentCommand DeclareExpandableDocumentCommand DeclareTextFontCommand DeclareTextCommand ProvideTextCommand DeclareTextSymbol DeclareTextAccent DeclareMathSymbol newenvironment renewenvironment provideenvironment NewDocumentEnvironment RenewDocumentEnvironment ProvideDocumentEnvironment DeclareDocumentEnvironment edef gdef xdef chardef mathchardef countdef dimendef skipdef muskipdef toksdef font'.split(' '));
const PREFIXES=new Set('global long outer protected'.split(' '));
const DYNAMIC=new Set('futurelet expandafter aftergroup afterassignment noexpand unexpanded expanded detokenize string meaning the immediate write catcode mathcode lccode uccode scantokens endlinechar escapechar obeylines obeyspaces newunicodechar DeclareUnicodeCharacter csname endcsname directlua latelua luadirect luafunction luaexec read readline @namedef @nameuse @namelet csdef csgdef csedef csxdef cslet csletcs csundef letcs cspreto csappto csgpreto csgappto csepreto cseappto csxpreto csxappto patchcmd xpatchcmd pretocmd apptocmd preto appto gpreto gappto epreto eappto robustify ExplSyntaxOn ProvidesExplPackage ProvidesExplClass NewCommandCopy RenewCommandCopy DeclareCommandCopy NewEnvironmentCopy RenewEnvironmentCopy DeclareEnvironmentCopy LetLtxMacro GlobalLetLtxMacro'.split(' '));
const AUX_CITATION_HELPERS=new Set(['immediate','write','@auxout','string','citation']);
const STOCK_LEXICAL=new Set('catcode mathcode lccode uccode scantokens endlinechar escapechar obeylines obeyspaces newunicodechar DeclareUnicodeCharacter csname endcsname'.split(' '));
const ZERO=new Set(['~',...'%&#_${} ,;:!'.split(''),'relax','space','nobreakspace','enspace','quad','qquad','thinspace','negthinspace']);
const ONE=new Set('emph textbf textit textnormal textrm textsf texttt textsl textsc underline mbox'.split(' '));
const FORMAT_HELPERS=new Set('leavevmode hmode@bgroup hmode@endgroup nfss@text @text@composite @text@composite@x normalfont rmfamily sffamily ttfamily mdseries bfseries upshape itshape slshape scshape selectfont fontsize @setfontsize hbox vbox vtop box unhbox unvbox lastbox setbox copy unvcopy unhcopy vadjust raise lower kern mkern vrule hrule'.split(' '));
const SYMBOL_HELPERS=new Set('nobreakspace nobreak space char protect active@prefix @x@protect protected@edef protected@xdef textasciitilde textbackslash textasciicircum textbraceleft textbraceright textpercent textnumbersign textdollar textampersand textunderscore tmspace thinspace negthinspace medspace negmedspace thickspace negthickspace mspace'.split(' '));
// These names contain an "if" prefix but do not open a primitive TeX
// conditional ending in \fi. This classification grants no call/source proof.
const NONCONDITIONAL_IF=new Set('iff ifthenelse ifstrequal ifstrempty ifblank ifnumcomp ifdimcomp ifboolexpr ifbool iftoggle ifdef ifcsdef ifundef ifcsundef ifdefempty ifcsempty ifdefstring ifcsstring ifdefequal ifcsequal ifdefmacro ifcsmacro ifdefparam ifcsparam ifdefprefix ifdefprotected ifcsprotected ifpatchable'.split(' '));
const PRIMITIVE_CONDITIONALS=new Set('if ifcat ifx ifnum ifdim ifodd ifvmode ifhmode ifmmode ifinner ifvoid ifhbox ifvbox ifeof iftrue iffalse ifcase ifdefined ifcsname iffontchar ifincsname ifprimitive ifpdfprimitive ifabsnum ifabsdim'.split(' '));
// Recognition here only prevents ordinary consumers from impersonating a
// declaration constructor. It does not add them to the closed-body grammar.
const FIXED_CONSUMERS=new Set([...ZERO,...ONE,...FORMAT_HELPERS,...NONCONDITIONAL_IF,...'protect par noindent indent smallskip medskip bigskip tiny scriptsize footnotesize small normalsize large Large LARGE huge Huge ignorespaces ensuremath text frac dfrac tfrac sqrt overline hat bar vec color textcolor colorbox fcolorbox footnote input include includegraphics bibliography bibliographystyle addbibresource cite citep citet citealp citealt citeauthor citeyear nocite ref eqref pageref autoref cref Cref label url path href section subsection subsubsection paragraph title author caption documentclass usepackage RequirePackage PassOptionsToPackage begin end appendix maketitle makeatletter makeatother'.split(' ')]);
const constructor=name=>name==='def'||DECLARATIONS.has(name)||OTHER_DECLARATIONS.has(name);
const conditionalOpening=name=>/^if/u.test(name)&&!NONCONDITIONAL_IF.has(name);
const conditional=name=>conditionalOpening(name)||name==='else'||name==='or'||name==='fi';
const word=c=>c!==undefined&&/[A-Za-z@]/u.test(c);

function control(text,at){
 if(text[at]!=='\\'||at+1>=text.length)return null;
 let end=at+1;while(word(text[end]))end++;
 if(end===at+1)end++;
 return{name:text.slice(at+1,end),start:at,end};
}
function skip(text,at){
 for(;;){while(at<text.length&&/\s/u.test(text[at]))at++;
  if(text[at]!=='%')return at;const newline=text.indexOf('\n',at);if(newline<0)return text.length;at=newline+1;
 }
}
function group(text,at,open='{',close='}'){
 if(text[at]!==open)return null;
 const start=at++;let depth=1;
 while(at<text.length){
  if(text[at]==='\\'){const c=control(text,at);if(!c)return null;at=c.end;continue;}
  if(text[at]==='%'){const newline=text.indexOf('\n',at);if(newline<0)return null;at=newline+1;continue;}
  if(text[at]===open){if(++depth>MAX_DEPTH)return null;}
  else if(text[at]===close&&--depth===0)return{start,end:at+1,inner:text.slice(start+1,at)};
  at++;
 }
 return null;
}
function staticAuxCitationWrite(text,c){
 if(c.name!=='immediate')return null;
 const write=control(text,skip(text,c.end));if(write?.name!=='write')return null;
 const stream=control(text,skip(text,write.end));if(stream?.name!=='@auxout')return null;
 const body=group(text,skip(text,stream.end));if(!body||body.inner.length>4096)return null;
 const string=control(body.inner,skip(body.inner,0));if(string?.name!=='string')return null;
 const citation=control(body.inner,skip(body.inner,string.end));if(citation?.name!=='citation')return null;
 const keys=group(body.inner,skip(body.inner,citation.end));
 if(!keys||skip(body.inner,keys.end)!==body.inner.length||!/^\s*[A-Za-z0-9][A-Za-z0-9_.:+/-]*(?:\s*,\s*[A-Za-z0-9][A-Za-z0-9_.:+/-]*)*\s*$/u.test(keys.inner))return null;
 return{end:body.end};
}
function hasFontHelperOperand(text,start){
 let at=skip(text,start);for(let count=0;count<12;count++){const argument=group(text,at);if(!argument)return false;if(mentionsStaticFontHelper(argument.inner))return true;at=skip(text,argument.end);}return false;
}
function target(text,at,{plain=false}={}){
 at=skip(text,at);const grouped=text[at]==='{';let end=grouped?skip(text,at+1):at,name;
 const c=control(text,end);
 if(c){name=c.name;end=c.end;}
 else if(text[end]==='~'){name='~';end++;}
 else if(plain&&grouped){const start=end;while(word(text[end]))end++;if(end>start)name=text.slice(start,end);}
 if(!name)return null;
 if(grouped){end=skip(text,end);if(text[end]!=='}')return null;end++;}
 return{name,end,grouped};
}
function definition(text,c){
 let at=skip(text,c.end),valid=true,hasParameterSyntax=false;if(text[at]==='*'){valid=false;at=skip(text,at+1);}
 const name=target(text,at,{plain:OTHER_DECLARATIONS.has(c.name)});
 if(!name)return{name:null,valid:false,end:c.end};at=skip(text,name.end);let arity=0;
 if(ENVIRONMENTS.has(c.name)||DOCUMENT_ENVIRONMENTS.has(c.name)){
  // Unsupported environment signatures remain uncertain, but all definition
  // bodies are inert scanner input rather than executed grouping primitives.
  const document=DOCUMENT_ENVIRONMENTS.has(c.name),bodies=[];
  if(!document){for(let count=0;count<2&&text[at]==='[';count++){const option=group(text,at,'[',']');if(!option)return{name:name.name,valid:false,end:at+1,malformed:true};at=skip(text,option.end);}}
  for(let count=0;count<(document?3:2);count++){
   const body=group(text,at);if(!body)return{name:name.name,valid:false,end:at,malformed:true};bodies.push(body.inner);at=skip(text,body.end);
  }
  return{name:name.name,valid:false,body:bodies.join('\n'),end:at};
 }
 if(c.name==='def'){
  if(name.grouped||!/^[A-Za-z@]+$/u.test(name.name)&&at!==name.end)valid=false;
  if(text.slice(at,at+2)==='#1'){arity=1;if(text[at+2]!=='{')valid=false;at=skip(text,at+2);}
  if(text[at]!=='{'){
   valid=false;let steps=0;while(at<text.length&&text[at]!=='{'&&text[at]!=='\n'&&steps++<256)at++;
  }
 }else{
  if(text[at]==='['){hasParameterSyntax=true;const count=group(text,at,'[',']');if(!count)return{name:name.name,valid:false,end:at+1};
   if(!/^[01]$/u.test(count.inner.trim()))valid=false;else arity=Number(count.inner.trim());at=skip(text,count.end);
   if(text[at]==='['){valid=false;const fallback=group(text,at,'[',']');if(!fallback)return{name:name.name,valid:false,end:at+1};at=skip(text,fallback.end);}
  }
  if(!DECLARATIONS.has(c.name))valid=false;
 }
 const body=group(text,at);
 if(!body)return{name:name.name,arity,valid:false,end:Math.max(at,c.end)};
 const stockFont=valid&&!hasParameterSyntax&&c.name==='renewcommand'&&name.name==='normalsize'&&arity===0&&isStaticFontProfileBody(body.inner);
 return{name:name.name,arity,body:body.inner,stockFont,valid:valid&&body.inner.length<=MAX_BODY,end:body.end};
}
function skipVerbatim(text,c){
 if(c.name==='verb'){
  let at=c.end;if(text[at]==='*')at++;const delimiter=text[at],end=delimiter&&text.indexOf(delimiter,at+1);
  return end===undefined||end<0?text.length:end+1;
 }
 if(c.name==='begin'){
  const at=skip(text,c.end),g=group(text,at);if(g&&/^(?:verbatim\*?|Verbatim|lstlisting|minted)$/u.test(g.inner)){
   const end=text.indexOf(`\\end{${g.inner}}`,g.end);return end<0?text.length:end+g.inner.length+6;
  }
 }
 return null;
}
function bodyMutatesBindings(text,stockSafe,onStaticAux=()=>{}){
 for(let at=0;at<text.length;){
  if(text[at]==='%'){at=skip(text,at);continue;}
  if(text[at]!=='\\'){at++;continue;}const c=control(text,at);if(!c)return true;at=c.end;
  const aux=staticAuxCitationWrite(text,c);if(aux){onStaticAux();at=aux.end;continue;}
  if(constructor(c.name)||c.name==='let'||c.name==='newif'||DYNAMIC.has(c.name)&&!(stockSafe&&STOCK_LEXICAL.has(c.name)))return true;
  if(!FIXED_CONSUMERS.has(c.name)){
   if(hasFontHelperOperand(text,c.end))return true;
   const possible=target(text,c.end,{plain:true});
   if(possible&&(ZERO.has(possible.name)||ONE.has(possible.name)||FORMAT_HELPERS.has(possible.name)||SYMBOL_HELPERS.has(possible.name)))return true;
  }
 }
 return false;
}
function closedLiteral(text,arity,lookup,depth=0){
 if(depth>MAX_DEPTH)return false;
 for(let at=0;at<text.length;){
  const char=text[at];if(char==='%'){if(!text.includes('\n',at))return false;at=skip(text,at);continue;}
  if(char==='#'){if(arity!==1||text[at+1]!=='1')return false;at+=2;continue;}
  if(char==='{'){const g=group(text,at);if(!g||!closedLiteral(g.inner,arity,lookup,depth+1))return false;at=g.end;continue;}
  if(char==='}'||'$^_&'.includes(char))return false;
  let name,c;
  if(char==='\\'){c=control(text,at);if(!c)return false;name=c.name;at=c.end;}
  else if(char==='~'){name='~';at++;}
  else{at++;continue;}
  if(constructor(name)||DYNAMIC.has(name)||name==='let'||conditional(name)||PREFIXES.has(name))return false;
  const s=lookup(name,depth+1);if(!s)return false;
  if(s.arity===1){const g=group(text,skip(text,at));if(!g||!closedLiteral(g.inner,arity,lookup,depth+1))return false;at=g.end;}
 }
 return true;
}

/** A literal operand proof complements, but never grants authority to, an
 * invocation signature. Pass the complete captured binding catalog, including
 * uncertain builtins. File/I/O consumers and unknown expansion are unproved. */
export function closedInlineOperand(text,{bindings={},uncertainControls=[]}={}){
 if(typeof text!=='string'||text.length>MAX_BODY)return false;
 const uncertain=new Set(uncertainControls);
 const lookup=name=>{
  if(uncertain.has(name))return null;
  if(Object.hasOwn(bindings,name)){const value=bindings[name];return value?.closed===true&&(value.arity===0||value.arity===1)?value:null;}
  return ZERO.has(name)?{arity:0,closed:true}:ONE.has(name)?{arity:1,closed:true}:null;
 };
 try{return closedLiteral(text,0,lookup);}catch{return false;}
}

/** Inspect only supplied captured source bytes. No filesystem reads, expansion,
 * source-edit permission, or fallback to guessed parameter counts occurs here. */
export function literalInlineCallBindings(files,{lexicalSafety=()=>false}={}){
 const definitions=new Map(),uncertain=new Set(),touched=new Set();let total=0,globalUnknown=false,usedStaticAux=false,usedStockFont=false;
 const remember=name=>{if(!name||name.length>128||!touched.has(name)&&touched.size>=MAX_DEFINITIONS){globalUnknown=true;return false;}touched.add(name);return true;};
 const mark=name=>{if(name&&remember(name))uncertain.add(name);};
 try{
  for(const file of files.values()){
   if(!FILE.test(file.path||''))continue;
   const text=file.text===undefined?new TextDecoder('utf-8',{fatal:true}).decode(file.bytes):file.text;
   if(typeof text!=='string'||(total+=text.length)>MAX_TEXT){globalUnknown=true;continue;}
   let stockSafe=false;try{stockSafe=lexicalSafety(text)===true;}catch{}
   if(text.includes('^^'))globalUnknown=true;
   let depth=0,conditions=0,prefixed=false;
   for(let at=0;at<text.length;){
    if(text[at]==='%'){at=skip(text,at);continue;}
    if(text[at]==='{'){depth++;at++;continue;}if(text[at]==='}'){depth=Math.max(0,depth-1);at++;continue;}
    if(text[at]!=='\\'){at++;continue;}const c=control(text,at);if(!c){globalUnknown=true;break;}at=c.end;
    const verbatim=skipVerbatim(text,c);if(verbatim!==null){at=verbatim;prefixed=false;continue;}
    const aux=staticAuxCitationWrite(text,c);if(aux){usedStaticAux=true;at=aux.end;prefixed=false;continue;}
    if(conditionalOpening(c.name)||NONCONDITIONAL_IF.has(c.name)&&touched.has(c.name)){conditions++;prefixed=false;continue;}if(c.name==='fi'){conditions=Math.max(0,conditions-1);prefixed=false;continue;}
    if(c.name==='begingroup'||c.name==='bgroup'){depth++;continue;}if(c.name==='endgroup'||c.name==='egroup'){depth=Math.max(0,depth-1);continue;}
    if(PREFIXES.has(c.name)){prefixed=true;continue;}
    if(c.name==='newif'){
     const declaration=control(text,skip(text,c.end));
     if(!declaration||!/^if[A-Za-z@]+$/u.test(declaration.name)||PRIMITIVE_CONDITIONALS.has(declaration.name)||NONCONDITIONAL_IF.has(declaration.name)){globalUnknown=true;prefixed=false;continue;}
     mark(declaration.name);at=declaration.end;prefixed=false;continue;
    }
    if(c.name==='let'){
     const destination=target(text,c.end);if(!destination){globalUnknown=true;continue;}
     at=skip(text,destination.end);if(text[at]==='=')at=skip(text,at+1);const origin=control(text,at);
     if(destination.name==='@listi'&&origin?.name==='@listI'){at=origin.end;prefixed=false;continue;}
     mark(destination.name);
     if(origin){at=origin.end;if(constructor(origin.name)||DYNAMIC.has(origin.name)||origin.name==='let')globalUnknown=true;}
     else if(at<text.length)at++;else globalUnknown=true;
     prefixed=false;continue;
    }
    if(DYNAMIC.has(c.name)&&!(stockSafe&&STOCK_LEXICAL.has(c.name))){globalUnknown=true;prefixed=false;continue;}
    if(!constructor(c.name)){
     if(!FIXED_CONSUMERS.has(c.name)&&!conditional(c.name)){const possible=target(text,c.end,{plain:true});if(possible)mark(possible.name);if(hasFontHelperOperand(text,c.end))for(const name of STATIC_FONT_PROFILE_HELPERS)mark(name);}
     prefixed=false;continue;
    }
    const d=definition(text,c);at=Math.max(at,d.end);
    if(d.malformed)globalUnknown=true;
    if(!d.name){globalUnknown=true;prefixed=false;continue;}
    if(!remember(d.name)){prefixed=false;continue;}
    if(definitions.size>=MAX_DEFINITIONS){globalUnknown=true;mark(d.name);prefixed=false;continue;}
    if(!d.valid||depth||conditions||prefixed||d.name==='input'){mark(d.name);}
    if(d.stockFont)usedStockFont=true;
    if(d.body!==undefined&&!d.stockFont&&bodyMutatesBindings(d.body,stockSafe,()=>{usedStaticAux=true;}))globalUnknown=true;
    if(d.valid){
     const previous=definitions.get(d.name);
     if(previous&&(previous.arity!==d.arity||previous.body!==d.body))mark(d.name);
     else definitions.set(d.name,{arity:d.arity,body:d.body,stockFont:d.stockFont===true});
    }
    prefixed=false;
   }
   if(conditions||depth)globalUnknown=true;
  }
 }catch{globalUnknown=true;}
 if(usedStaticAux&&[...touched].some(name=>AUX_CITATION_HELPERS.has(name)))globalUnknown=true;
 if(usedStockFont&&[...touched].some(name=>STATIC_FONT_PROFILE_HELPERS.has(name)))globalUnknown=true;
 if(globalUnknown)for(const name of [...touched,...ZERO,...ONE,'input'])uncertain.add(name);
 // Builtin transparent wrappers depend on kernel helpers whose call shape is
 // not reproduced here. A changed helper invalidates that default assumption.
 if([...touched].some(name=>FORMAT_HELPERS.has(name)))for(const name of ONE)uncertain.add(name);
 if([...touched].some(name=>SYMBOL_HELPERS.has(name)))for(const name of [...ZERO,...ONE])uncertain.add(name);
 const resolved=new Map(),visiting=new Set(),presentationDependencyChanged=[...touched].some(name=>FORMAT_HELPERS.has(name)||SYMBOL_HELPERS.has(name)||name.includes('@'));
 function signature(name,depth){
  if(uncertain.has(name)||depth>MAX_DEPTH)return null;
  if(resolved.has(name))return resolved.get(name);
  const d=definitions.get(name);
  if(!d){if(touched.has(name))return null;return ZERO.has(name)?{arity:0,closed:true}:ONE.has(name)?{arity:1,closed:true}:null;}
  if(visiting.has(name)){uncertain.add(name);return null;}
  const presentation=d.arity===0&&!presentationDependencyChanged&&purePresentationBody(d.body)&&[...d.body.matchAll(/\\([A-Za-z@]+)/gu)].every(match=>!touched.has(match[1])&&!uncertain.has(match[1]));
  visiting.add(name);const valid=d.stockFont||closedLiteral(d.body,d.arity,signature,depth+1)||presentation;visiting.delete(name);
  if(!valid){uncertain.add(name);return null;}
  const value={arity:d.arity,closed:true};resolved.set(name,value);return value;
 }
 const bindings={};for(const name of definitions.keys()){const value=signature(name,0);if(value)Object.defineProperty(bindings,name,{value,enumerable:true,writable:true,configurable:true});}
 return{bindings,uncertainControls:[...uncertain].sort(),...(globalUnknown?{unboundedBindings:true}:{})};
}
