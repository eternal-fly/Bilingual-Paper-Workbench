import {inlineFormattingNames} from '../ui/inline-structures.mjs';
const protectedNames=new Set([...inlineFormattingNames,...'%&#_${} ,;:!','~']);
const declarations=new Set('newcommand renewcommand providecommand DeclareRobustCommand DeclareTextFontCommand DeclareTextCommand ProvideTextCommand DeclareTextSymbol DeclareTextAccent DeclareMathSymbol NewDocumentCommand RenewDocumentCommand ProvideDocumentCommand DeclareDocumentCommand NewExpandableDocumentCommand RenewExpandableDocumentCommand ProvideExpandableDocumentCommand DeclareExpandableDocumentCommand newrobustcmd renewrobustcmd providerobustcmd'.split(' '));
const creatingDeclarations=new Set('newcommand providecommand NewDocumentCommand ProvideDocumentCommand NewExpandableDocumentCommand ProvideExpandableDocumentCommand newrobustcmd providerobustcmd'.split(' '));
const environments=new Set('newenvironment renewenvironment provideenvironment NewDocumentEnvironment RenewDocumentEnvironment ProvideDocumentEnvironment DeclareDocumentEnvironment'.split(' '));
const primitives=new Set('def edef gdef xdef chardef mathchardef countdef dimendef skipdef muskipdef toksdef font'.split(' '));
const dynamic=new Set('catcode mathcode lccode uccode scantokens endlinechar escapechar obeylines obeyspaces newunicodechar DeclareUnicodeCharacter csname endcsname directlua latelua luadirect luafunction luaexec read readline @namedef @nameuse @namelet csdef csgdef csedef csxdef cslet csletcs csundef letcs cspreto csappto csgpreto csgappto csepreto cseappto csxpreto csxappto patchcmd xpatchcmd pretocmd apptocmd preto appto gpreto gappto epreto eappto robustify'.split(' '));
const stockLexical=new Set('catcode mathcode lccode uccode scantokens endlinechar escapechar obeylines obeyspaces newunicodechar DeclareUnicodeCharacter csname endcsname'.split(' '));
const ordinaryConsumers=new Set([...inlineFormattingNames,...'protect relax leavevmode begingroup endgroup par noindent normalfont rmfamily sffamily ttfamily mdseries bfseries upshape itshape slshape scshape tiny scriptsize footnotesize small normalsize large Large LARGE huge Huge enspace quad qquad ignorespaces ensuremath text superscript subscript textsuperscript textsubscript frac dfrac tfrac sqrt overline underline hat bar vec color textcolor colorbox fcolorbox footnote caption section subsection subsubsection paragraph title author href url path'.split(' ')]);
const control=(text,at)=>{if(text[at]!=='\\'||at+1>=text.length)return null;const word=/^[A-Za-z@]+/u.exec(text.slice(at+1)),name=word?.[0]||text[at+1];return{name,start:at,end:at+1+name.length};};
function skip(text,at){for(;;){while(/[\s]/u.test(text[at]||'')&&at<text.length)at++;if(text[at]!=='%')return at;const end=text.indexOf('\n',at);at=end<0?text.length:end+1;}}
function target(text,at,bare=false){at=skip(text,at);if(text[at]==='*')at=skip(text,at+1);if(text[at]==='{'){const end=text.indexOf('}',at+1);if(end<0)return null;const raw=text.slice(at+1,end).trim();if(raw==='~')return'~';const c=control(raw,0);return c&&c.end===raw.length?c.name:bare&&/^[A-Za-z@]+$/u.test(raw)?raw:null;}if(text[at]==='~')return'~';return control(text,at)?.name||null;}

/** Non-expanding proof boundary. Unrelated literal math definitions are fine;
 * rebinding/alias machinery that can change our new inline atoms is not. */
export function inlineSyntaxHazard(source,{allowStockLexical=false,strictDefinitions=true}={}){
 if(typeof source!=='string')return{start:0,reason:'unreadable-source'};
 const escapedSyntax=source.indexOf('^^');if(escapedSyntax>=0)return{start:escapedSyntax,reason:'tex-character-rewrite'};
 for(let at=0;at<source.length;){
  if(source[at]==='%'){const end=source.indexOf('\n',at);at=end<0?source.length:end+1;continue;}
  if(source[at]!=='\\'){at++;continue;}
  const c=control(source,at);if(!c)break;at=c.end;
  if(c.name==='verb'){const delimiter=source[at]==='*'?source[++at]:source[at],end=delimiter&&source.indexOf(delimiter,at+1);if(end<0)return{start:c.start,reason:'unclosed-verbatim'};at=end+1;continue;}
  if(c.name==='begin'){const literal=/^\{(verbatim\*?|Verbatim|lstlisting|minted)\}/u.exec(source.slice(at));if(literal){const close=`\\end{${literal[1]}}`,end=source.indexOf(close,at+literal[0].length);if(end<0)return{start:c.start,reason:'unclosed-verbatim'};at=end+close.length;continue;}}
  if(dynamic.has(c.name)&&!(allowStockLexical&&stockLexical.has(c.name))||['futurelet','expandafter','ExplSyntaxOn','ProvidesExplPackage','ProvidesExplClass','NewCommandCopy','RenewCommandCopy','DeclareCommandCopy','NewEnvironmentCopy','RenewEnvironmentCopy','DeclareEnvironmentCopy','LetLtxMacro','GlobalLetLtxMacro'].includes(c.name))return{start:c.start,reason:'dynamic-control-identity'};
  if(c.name==='let'){
   const rest=source.slice(c.end),stock=/^\s*\\@listi\s*=?\s*\\@listI(?:\s|$|[{}])/u.test(rest);
   if(!stock)return{start:c.start,reason:'unproved-control-alias'};
  }
  const name=target(source,c.end,true);
  if(primitives.has(c.name)&&strictDefinitions)return{start:c.start,reason:'unproved-primitive-definition'};
  if(declarations.has(c.name)||environments.has(c.name)){
   const stockFont=allowStockLexical&&c.name==='renewcommand'&&name==='normalsize';
   const createsOnly=creatingDeclarations.has(c.name)||['newenvironment','provideenvironment','NewDocumentEnvironment','ProvideDocumentEnvironment'].includes(c.name);
   if(!stockFont&&(!createsOnly&&strictDefinitions||!name&&strictDefinitions||protectedNames.has(name)||declarations.has(name)||environments.has(name)||primitives.has(name)||dynamic.has(name)))return{start:c.start,reason:'inline-control-redefinition'};
  }
  else if(protectedNames.has(name)&&!ordinaryConsumers.has(c.name))return{start:c.start,reason:'unknown-inline-control-constructor'};
 }
 return null;
}
