// Shared literal syntax only: no macro expansion, document commands or files.
export const inlineFormattingNames=new Set('emph textbf textit textnormal textrm textsf texttt textsl textsc underline mbox'.split(' '));
const escape=/^\\[%&#_${} ,;:!]/u;
export const isInlineStructureRaw=raw=>raw==='~'||raw==='}'||escape.test(raw)&&raw.length===2||/^\\([A-Za-z]+)\{/u.test(raw)&&inlineFormattingNames.has(/^\\([A-Za-z]+)/u.exec(raw)[1]);

/** Parse balanced transparent wrappers around plain text. Opaque spans are
 * already independently protected math/references or exact source syntax. */
export function scanInlineStructures(text,opaque=[]){
 const atoms=[],issues=[],stack=[],ranges=new Map(opaque.map(row=>[row.start,row]));
 const add=(start,end,editableInline=false)=>atoms.push({start,end,raw:text.slice(start,end),kind:'structure',editableInline});
 for(let at=0;at<text.length;){
  const preserved=ranges.get(at);
  if(preserved&&!isInlineStructureRaw(preserved.raw)){
   atoms.push({...preserved,editableInline:false});
   if(preserved.kind==='structure'&&preserved.raw.endsWith('{')&&!preserved.raw.endsWith('\\{'))stack.push(false);
   at=preserved.end;continue;
  }
  const c=text[at];
  if(c==='~'){add(at,at+1,true);at++;continue;}
  if(c==='\\'){
   const escaped=escape.exec(text.slice(at));if(escaped){add(at,at+2,true);at+=2;continue;}
   const control=/^\\([A-Za-z]+)\{/u.exec(text.slice(at));
   if(control&&inlineFormattingNames.has(control[1])){add(at,at+control[0].length,true);stack.push(true);at+=control[0].length;continue;}
   issues.push({at,reason:'Use balanced inline formatting or keep the existing protected command unchanged.'});at++;continue;
  }
  if(c==='}'){if(!stack.length){issues.push({at,reason:'An inline closing brace has no matching opener.'});at++;continue;}const safe=stack.pop();add(at,at+1,safe);at++;continue;}
  if(c==='{'){issues.push({at,reason:'Use a supported inline formatting command before an opening brace.'});at++;continue;}
  if('$%&#^_'.includes(c)){issues.push({at,reason:'Complete formulas or escape literal TeX punctuation before saving.'});at++;continue;}
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(c))issues.push({at,reason:'Invisible TeX control characters are not permitted.'});
  at++;
 }
 if(stack.length)issues.push({at:text.length,reason:'Complete the inline formatting braces before saving.'});
 return{atoms,issues};
}
