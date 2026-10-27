// One literal stock LaTeX size-11 presentation profile. This is token matching,
// not TeX expansion or authority to read files, run controls, or choose sizes.
export const STATIC_FONT_PROFILE_BODY=String.raw`\@setfontsize\normalsize{10.95}{13.6}
\abovedisplayskip 11pt plus 3pt minus 6pt
\abovedisplayshortskip 0pt plus 3pt
\belowdisplayshortskip 6.5pt plus 3.5pt minus 3pt
\belowdisplayskip \abovedisplayskip
\let\@listi\@listI`;
export const STATIC_FONT_PROFILE_HELPERS=new Set(['@setfontsize','@listi','@listI','let','abovedisplayskip','abovedisplayshortskip','belowdisplayshortskip','belowdisplayskip']);
export const mentionsStaticFontHelper=value=>typeof value==='string'&&[...STATIC_FONT_PROFILE_HELPERS].some(name=>value.includes(`\\${name}`)||value===name||value.includes(`cmd/${name}/`));
export function fontProfileSignature(value){
 if(typeof value!=='string'||value.length>4096)return null;
 const tokens=[];let at=0;
 while(at<value.length){
  if(/[ \t\r\n]/u.test(value[at])){at++;continue;}
  if(value[at]==='%'){const end=value.indexOf('\n',at);at=end<0?value.length:end+1;continue;}
  const found=/^(?:\\[A-Za-z@]+|\\[^\r\n]|[A-Za-z@]+|[0-9.]+)/u.exec(value.slice(at)),token=found?.[0]||value[at];tokens.push(token);at+=token.length;
 }
 return JSON.stringify(tokens);
}
const expected=fontProfileSignature(STATIC_FONT_PROFILE_BODY);
export const isStaticFontProfileBody=value=>fontProfileSignature(value)===expected;
