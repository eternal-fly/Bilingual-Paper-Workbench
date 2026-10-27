import path from 'node:path';
const textExtensions=new Set(['.tex','.bib','.sty','.cls','.bst','.bbl','.cfg','.def','.clo','.fd']);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
function object(input,fields){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!fields.includes(key)))fail('INVALID_INPUT','Use only the declared project-source request fields.');}
export async function listProjectSources(app,input={}){
  object(input,[]);
  return app._projectOperation(()=>app.core._serial(async()=>{
    await app.core._assertSourceCurrent();const state=app.core.getState();
    return{projectId:state.project.id,snapshotId:state.project.snapshotId,mainFile:state.project.mainFile,files:state.project.files.map(file=>({path:file.path,hash:file.hash,size:file.size,kind:textExtensions.has(path.extname(file.path).toLowerCase())?'text':'binary'}))};
  }));
}
export async function readProjectSource(app,input){
  object(input,['path','expectedSnapshotId','expectedHash']);
  if(typeof input.path!=='string'||!input.path||input.path.length>1024||/[\u0000-\u001f]/u.test(input.path)||typeof input.expectedSnapshotId!=='string'||!input.expectedSnapshotId||input.expectedSnapshotId.length>200||typeof input.expectedHash!=='string'||!/^[a-f0-9]{64}$/i.test(input.expectedHash))fail('INVALID_INPUT','Choose an exact source file, snapshot and digest from the project inventory.');
  return app._projectOperation(()=>app.core._serial(async()=>{
    await app.core._assertSourceCurrent();const state=app.core.getState(),file=state.project.files.find(file=>file.path===input.path);
    if(!file||!textExtensions.has(path.extname(file.path).toLowerCase()))fail('PERMISSION_DENIED','Only declared text dependencies in this project may be displayed as source.');
    const cached=app.core._files.get(file.path);
    if(state.project.snapshotId!==input.expectedSnapshotId||file.hash!==input.expectedHash.toLowerCase()||!cached||cached.hash!==file.hash)fail('VERSION_CONFLICT','The project or source file changed; reload its inventory.');
    if(cached.bytes.length>4*1024*1024)fail('PROJECT_TOO_LARGE','The source file exceeds the bounded display size.');
    let content;try{content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(cached.bytes);}catch{fail('UNSUPPORTED_ENCODING','This source file is not valid UTF-8. Its original bytes were not changed.');}
    return{projectId:state.project.id,snapshotId:state.project.snapshotId,path:file.path,hash:file.hash,content,readonly:true};
  }));
}
