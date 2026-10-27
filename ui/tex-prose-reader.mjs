// Presentation-only decoding. This does not expand TeX or create source edits.
const mathEnvironments = new Set(['equation','equation*','align','align*','aligned','alignedat','alignat','alignat*','gather','gather*','gathered','matrix','pmatrix','bmatrix','Bmatrix','vmatrix','Vmatrix','smallmatrix','cases','array','split']);
const references = new Set(['cite','citep','citet','ref','eqref','autoref','cref','Cref','label']);
const wrappers = { textbf: ['**','**'], textit: ['*','*'], emph: ['*','*'], textsl: ['*','*'], textrm: ['',''], textnormal: ['',''] };
const headings = { title:'# ', section:'## ', subsection:'### ', subsubsection:'#### ', paragraph:'##### ', subparagraph:'###### ' };
function group(source, at, budget) {
  while (/\s/u.test(source[at] || '') && at < source.length) at++;
  if (source[at] !== '{') return null;
  let depth = 1;
  for (let end = at + 1; end < source.length; end++) {
    if (--budget.remaining < 0) return null;
    if (source[end] === '\\') { end++; continue; }
    if (source[end] === '{') depth++;
    if (source[end] === '}' && --depth === 0) return { start:at, end:end+1, text:source.slice(at+1,end) };
  }
  return null;
}
function mathEnd(source, at) {
  let open, close;
  if (source.startsWith('$$',at)) open=close='$$';
  else if (source[at] === '$') open=close='$';
  else if (source.startsWith('\\(',at)) { open='\\(';close='\\)'; }
  else if (source.startsWith('\\[',at)) { open='\\[';close='\\]'; }
  else { const env=/^\\begin\{([^{}]+)\}/u.exec(source.slice(at)); if (env && mathEnvironments.has(env[1])) {open=env[0];close=`\\end{${env[1]}}`;} }
  if (!open) return null;
  for(let end=at+open.length;end<source.length;end++){if(source.startsWith(close,end))return end+close.length;if(source[end]==='\\')end++;}
  return source.length;
}
// A formatting box may disappear only around one independently complete inline
// math object. mathEnd intentionally also preserves incomplete source, so its
// end offset alone is not a completeness proof for this narrow projection.
function singleInlineMath(value,budget){
  const text=value.trim(),open=text.startsWith('\\(')?'\\(':text[0]==='$'&&!text.startsWith('$$')?'$':null,close=open==='\\('? '\\)':'$';
  if(!open||/\\(?:html[A-Za-z]*|href|url|includegraphics|class|style|cssId|def|gdef|edef|xdef|let|futurelet|newcommand|renewcommand|providecommand|global|require|input|include|write|read|openin|openout|catcode|csname|endcsname|expandafter|noexpand|string|char|unicode|verb)\b/u.test(text)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]|\^\^/u.test(text))return false;
  let depth=0;
  for(let at=open.length;at<text.length;at++){
    if(--budget.remaining<0)return false;
    if(text.startsWith(close,at))return depth===0&&at+close.length===text.length;
    if(text[at]==='\\'){if('()[]'.includes(text[at+1]||'\0'))return false;at++;continue;}
    if(text[at]==='$')return false;
    if(text[at]==='%')return false;
    if(text[at]==='{'){if(++depth>128)return false;}
    else if(text[at]==='}'&&--depth<0)return false;
  }
  return false;
}
function hasUnescapedComment(text){
  for(let at=text.indexOf('%');at>=0;at=text.indexOf('%',at+1)){let slashes=0;for(let back=at-1;back>=0&&text[back]==='\\';back--)slashes++;if(slashes%2===0)return true;}
  return false;
}
export function decodeTexProse(value, { tokens = [] } = {}) {
  let source = String(value ?? ''); const diagnostics=[];
  const warn = code => { if(!diagnostics.some(item=>item.code===code))diagnostics.push({code,message:code==='TEX_PROSE_LIMIT'?'Deep or long formatting remains readable as source.':'Unsupported or incomplete prose formatting remains readable as source.'}); };
  if(source.length>256*1024){warn('TEX_PROSE_LIMIT');return {text:source,diagnostics};}
  const tokenKey = value => /^(?:⟦(P\d+(?:_[a-f0-9]{1,64})?)⟧|\[\[(P\d+(?:_[a-f0-9]{1,64})?)\]\])$/iu.exec(value)?.slice(1).find(Boolean)?.toLowerCase();
  const indexed = new Map();
  for (const token of (Array.isArray(tokens) ? tokens : [])) { const key=typeof token.id==='string'&&tokenKey(token.id);if(!key||typeof token.raw!=='string'||token.raw.length>8192)continue;if(!indexed.has(key))indexed.set(key,new Set());indexed.get(key).add(token.raw); }
  let expanded=source.length;
  source=source.replace(/⟦P\d+(?:_[^⟧\r\n]{1,160})?⟧|\[\[P\d+(?:_[^\]\r\n]{1,160})?\]\]/giu,value=>{const values=indexed.get(tokenKey(value));if(values?.size!==1)return value;const raw=values.values().next().value,next=expanded-value.length+raw.length;if(next>256*1024){warn('TEX_PROSE_LIMIT');return value;}expanded=next;return raw;});
  const budget = { remaining: Math.max(2048,source.length*16) };
  function decode(text, level=0) {
    if(level>12){warn('TEX_PROSE_LIMIT');return text;}
    let output='', list=[];
    for(let at=0;at<text.length;){
      if(--budget.remaining<0){warn('TEX_PROSE_LIMIT');output+=text.slice(at);break;}
      const end=mathEnd(text,at);if(end!==null){output+=text.slice(at,end);at=end;continue;}
      if(text[at]!=='\\'){output+=text[at++];continue;}
      const match=/^\\([A-Za-z]+)\*?/u.exec(text.slice(at));
      if(!match){output+=text.slice(at,at+2);at+=2;continue;}
      const name=match[1], begin=at;at+=match[0].length;
      if(name==='begin'||name==='end'){
        const argument=group(text,at,budget);if(argument && ['itemize','enumerate'].includes(argument.text)){
          if(name==='begin'){list.push({kind:argument.text,index:0});output+='\n';}
          else if(list.at(-1)?.kind===argument.text){list.pop();output+='\n';}
          else{warn('TEX_PROSE_UNSUPPORTED');output+=text.slice(begin,argument.end);}
          at=argument.end;continue;
        }
      }
      if(name==='item'&&list.length){const current=list.at(-1);output+=`\n${'  '.repeat(list.length-1)}${current.kind==='enumerate'?`${++current.index}.`:'-'} `;while(/[ \t]/u.test(text[at]||''))at++;continue;}
      const argument=group(text,at,budget);
      if(name==='mbox'){
        if(argument&&match[0]==='\\mbox'&&singleInlineMath(argument.text,budget)){output+=argument.text;at=argument.end;continue;}
        warn(budget.remaining<0?'TEX_PROSE_LIMIT':'TEX_PROSE_UNSUPPORTED');
        if(argument){output+=text.slice(begin,argument.end);at=argument.end;continue;}
        output+=text.slice(begin);break;
      }
      if(name==='texorpdfstring'){
        const bookmark=argument&&group(text,argument.end,budget);
        if(argument&&bookmark&&match[0]==='\\texorpdfstring'&&!hasUnescapedComment(text.slice(argument.start,bookmark.end))){output+=decode(argument.text,level+1);at=bookmark.end;continue;}
        warn(budget.remaining<0?'TEX_PROSE_LIMIT':'TEX_PROSE_UNSUPPORTED');output+=text.slice(begin);break;
      }
      if(references.has(name)&&argument){output+=text.slice(begin,argument.end);at=argument.end;continue;}
      if(argument&&(wrappers[name]||headings[name]||name==='texttt')){
        if(headings[name])output+=`\n${headings[name]}${decode(argument.text,level+1)}\n`;
        else if(name==='texttt'){const fence=argument.text.includes('`')?'``':'`';output+=`${fence}${argument.text}${fence}`;}
        else{const [open,close]=wrappers[name];output+=open+decode(argument.text,level+1)+close;}
        at=argument.end;continue;
      }
      warn('TEX_PROSE_UNSUPPORTED');output+=text.slice(begin,argument?.end??at);if(argument)at=argument.end;
    }
    if(list.length)warn('TEX_PROSE_UNSUPPORTED');
    return output;
  }
  return { text:decode(source), diagnostics };
}

export function translationUpdateCandidates(state, language) {
  const sources=state.readingParagraphs?.length?state.readingParagraphs:state.segments||[],drafts=state.translations?.[language]||{};
  const result={changed:[],missing:[]};
  for(const [index, source] of sources.entries()){
    if(!source.translatable||source.requestable===false)continue;
    const draft=drafts[source.id],hash=source.sourceHash||source.beforeHash;
    const item={id:source.id,paragraphNumber:index+1,path:source.path,section:source.section||'',manual:draft?.origin==='human',sourceHash:hash,draftRevision:draft?.revision||0};
    if(!draft?.text?.trim()){result.missing.push(item);continue;}
    if(draft.status==='stale'||hash&&draft.sourceHash&&draft.sourceHash!==hash)result.changed.push(item);
  }
  return result;
}
