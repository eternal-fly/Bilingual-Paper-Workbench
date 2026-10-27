import {inlineFormattingNames} from '../ui/inline-structures.mjs';

const symbols=new Set([...'~%&#_${} ,;:!']);
const symbolHelpers=new Set('nobreakspace nobreak space char protect active@prefix @x@protect protected@edef protected@xdef textasciitilde textbackslash textasciicircum textbraceleft textbraceright textpercent textnumbersign textdollar textampersand textunderscore tmspace thinspace negthinspace medspace negmedspace thickspace negthickspace mspace'.split(' '));
const formatHelpers=new Set('leavevmode hmode@bgroup hmode@endgroup nfss@text @text@composite @text@composite@x normalfont rmfamily sffamily ttfamily mdseries bfseries upshape itshape slshape scshape selectfont fontsize @setfontsize hbox vbox vtop box unhbox unvbox lastbox setbox copy unvcopy unhcopy vadjust raise lower kern mkern vrule hrule'.split(' '));
const declarations=new Set('newcommand renewcommand providecommand DeclareRobustCommand DeclareTextFontCommand DeclareTextCommand ProvideTextCommand DeclareTextSymbol DeclareTextAccent DeclareMathSymbol NewDocumentCommand RenewDocumentCommand ProvideDocumentCommand DeclareDocumentCommand NewExpandableDocumentCommand RenewExpandableDocumentCommand ProvideExpandableDocumentCommand DeclareExpandableDocumentCommand newrobustcmd renewrobustcmd providerobustcmd newenvironment renewenvironment provideenvironment NewDocumentEnvironment RenewDocumentEnvironment ProvideDocumentEnvironment DeclareDocumentEnvironment'.split(' '));
const primitives=new Set('def edef gdef xdef chardef mathchardef countdef dimendef skipdef muskipdef toksdef font'.split(' '));
const creatingDeclarations=new Set('newcommand providecommand NewDocumentCommand ProvideDocumentCommand NewExpandableDocumentCommand ProvideExpandableDocumentCommand newrobustcmd providerobustcmd newenvironment provideenvironment NewDocumentEnvironment ProvideDocumentEnvironment'.split(' '));
const dynamic=new Set('let futurelet expandafter catcode mathcode lccode uccode scantokens endlinechar escapechar obeylines obeyspaces newunicodechar DeclareUnicodeCharacter csname endcsname directlua latelua luadirect luafunction luaexec read readline @namedef @nameuse @namelet csdef csgdef csedef csxdef cslet csletcs csundef letcs cspreto csappto csgpreto csgappto csepreto cseappto csxpreto csxappto patchcmd xpatchcmd pretocmd apptocmd preto appto gpreto gappto epreto eappto robustify ExplSyntaxOn ProvidesExplPackage ProvidesExplClass NewCommandCopy RenewCommandCopy DeclareCommandCopy NewEnvironmentCopy RenewEnvironmentCopy DeclareEnvironmentCopy LetLtxMacro GlobalLetLtxMacro'.split(' '));
const verifiedStockLexical=new Set('catcode mathcode lccode uccode scantokens endlinechar escapechar obeylines obeyspaces newunicodechar DeclareUnicodeCharacter csname endcsname'.split(' '));
const consumers=new Set([...symbols,...inlineFormattingNames,...'protect relax leavevmode begingroup endgroup par noindent indent smallskip medskip bigskip normalfont rmfamily sffamily ttfamily mdseries bfseries upshape itshape slshape scshape tiny scriptsize footnotesize small normalsize large Large LARGE huge Huge enspace quad qquad thinspace negthinspace ignorespaces ensuremath text frac dfrac tfrac sqrt overline hat bar vec color textcolor colorbox fcolorbox footnote caption section subsection subsubsection paragraph title author href url path input include includegraphics bibliography bibliographystyle cite citep citet citealp citealt citeauthor citeyear nocite ref eqref pageref autoref cref Cref label appendix maketitle'.split(' ')]);
const lexicalConstructors=new Set([...declarations,...primitives,...dynamic,...'begin end input include documentclass usepackage RequirePackage verb makeatletter makeatother'.split(' ')]);
// Only established zero-operand roots are usable without a captured definition.
// Every literal alias is still checked against the complete captured dependency
// graph: a later redefinition or constructor alias invalidates that assumption.
const inertAliasRoots=new Set('relax space nobreakspace enspace quad qquad @empty th@plain @listI'.split(' '));
function control(text,at){if(text[at]!=='\\'||at+1>=text.length)return null;const name=/^[A-Za-z@]+/u.exec(text.slice(at+1))?.[0]||text[at+1];return{name,start:at,end:at+1+name.length};}
function skip(text,at){for(;;){while(at<text.length&&/\s/u.test(text[at]))at++;if(text[at]!=='%')return at;const end=text.indexOf('\n',at);at=end<0?text.length:end+1;}}
function target(text,at){at=skip(text,at);if(text[at]==='*')at=skip(text,at+1);const grouped=text[at]==='{';if(grouped)at=skip(text,at+1);let name,end;const c=control(text,at);if(c){name=c.name;end=c.end;}else if(text[at]==='~'){name='~';end=at+1;}else if(grouped){name=/^[A-Za-z@]+/u.exec(text.slice(at))?.[0];end=at+(name?.length||0);}if(!name||grouped&&text[skip(text,end)]!=='}')return null;return name;}
function literalAlias(text,at){at=skip(text,at);const destination=control(text,at);if(!destination)return null;at=skip(text,destination.end);if(text[at]==='=')at=skip(text,at+1);const source=control(text,at);return source?{destination:destination.name,source:source.name,end:source.end}:null;}

/** Scope only captured literal source bytes. This discovers known rebinding
 * machinery; it never expands TeX or grants authority to any author input. */
export function inlineBindingRisk(files,project,{lexicalSafety=()=>false}={}){
 let opaqueSymbolArity=false,unboundedBindings=false,unprovedConstructors=false;const rebound=new Set(),symbolControls=new Set(),aliases=new Map(),declared=new Set();
 const all=()=>{unboundedBindings=true;opaqueSymbolArity=true;for(const name of symbols)symbolControls.add(name);for(const name of inlineFormattingNames)rebound.add(name);};
 const affect=name=>{if(lexicalConstructors.has(name)){all();return;}if(symbols.has(name)||symbolHelpers.has(name)){opaqueSymbolArity=true;if(symbols.has(name))symbolControls.add(name);else{for(const symbol of symbols)symbolControls.add(symbol);for(const command of inlineFormattingNames)rebound.add(command);}}if(inlineFormattingNames.has(name))rebound.add(name);if(formatHelpers.has(name))for(const command of inlineFormattingNames)rebound.add(command);};
 try{
  for(const file of files.values()){
   if(!/\.(?:tex|sty|cls|bbl|ltx|def|cfg)$/iu.test(file.path||''))continue;
   const text=file.text===undefined?new TextDecoder('utf-8',{fatal:true}).decode(file.bytes):file.text;if(typeof text!=='string'){all();continue;}
   const stockLexicalSafe=lexicalSafety(text);
   if(text.includes('^^'))all();
   for(let at=0;at<text.length;){
    if(text[at]==='%'){const end=text.indexOf('\n',at);at=end<0?text.length:end+1;continue;}
    if(text[at]!=='\\'){at++;continue;}const c=control(text,at);if(!c){all();break;}at=c.end;
    if(c.name==='verb'){if(text[at]==='*')at++;const delimiter=text[at],end=delimiter&&text.indexOf(delimiter,at+1);if(end<0||end===undefined){all();break;}at=end+1;continue;}
    if(c.name==='begin'){const verb=/^\{(verbatim\*?|Verbatim|lstlisting|minted)\}/u.exec(text.slice(at));if(verb){const close=`\\end{${verb[1]}}`,end=text.indexOf(close,at+verb[0].length);if(end<0){all();break;}at=end+close.length;continue;}}
    if(c.name==='let'){
     const assignment=literalAlias(text,c.end);if(!assignment){all();continue;}
     affect(assignment.destination);
     if(aliases.size>=4096&&!aliases.has(assignment.destination))all();
     else{const origins=aliases.get(assignment.destination)||new Set();origins.add(assignment.source);aliases.set(assignment.destination,origins);}
     at=assignment.end;continue;
    }
    if(dynamic.has(c.name)&&!(stockLexicalSafe&&verifiedStockLexical.has(c.name))){all();continue;}
    const name=target(text,c.end);
    if(declarations.has(c.name)||primitives.has(c.name)){if(!name)all();else{declared.add(name);affect(name);if(!['newcommand','renewcommand','providecommand','DeclareRobustCommand','def'].includes(c.name)&&(symbols.has(name)||symbolHelpers.has(name)||formatHelpers.has(name)||inlineFormattingNames.has(name)))unprovedConstructors=true;if(name.includes('@')&&!creatingDeclarations.has(c.name))for(const command of inlineFormattingNames)rebound.add(command);}}
    else if(name&&!consumers.has(c.name)&&(symbols.has(name)||symbolHelpers.has(name)||formatHelpers.has(name)||inlineFormattingNames.has(name)))affect(name);
   }
  }
  // Evaluate after scanning all files so ordering cannot hide a later changed
  // meaning. This is an arity-risk boundary, not execution of the alias body.
  const resolved=new Map(),visiting=new Set();
  const inert=(name,depth=0)=>{
   if(depth>32||declared.has(name)||lexicalConstructors.has(name))return false;
   if(resolved.has(name))return resolved.get(name);if(visiting.has(name))return false;
   const origins=aliases.get(name);if(!origins)return inertAliasRoots.has(name);
   visiting.add(name);const safe=[...origins].every(origin=>inert(origin,depth+1));visiting.delete(name);resolved.set(name,safe);return safe;
  };
  for(const origins of aliases.values())if(![...origins].every(origin=>inert(origin)))all();
 }catch{all();}
 return{opaqueSymbolArity,reboundControls:[...rebound].sort(),...(opaqueSymbolArity?{symbolControls:[...symbolControls].sort()}:{}),...(unboundedBindings?{unboundedBindings:true}:{}),...(unprovedConstructors?{unprovedConstructors:true}:{})};
}
