const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
const fail=message=>{throw Error(message);};
const bytes64=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
export async function preparePaperDownload({format,api,getState,getLatestBuild}){
 const currentProject=getState().project;if(!currentProject)fail('Open a paper before exporting.');const project={...currentProject};let result,mimeType,filename;
 if(format==='project'){result=await api('exportPaperProject',{expectedProjectId:project.id,expectedSnapshotId:project.snapshotId});mimeType='application/zip';filename=result.filename;}
 else if(format==='pdf'){const build=getLatestBuild();if(!build||build.stale||(build.promotedSnapshotId||build.snapshotId)!==project.snapshotId)fail('The latest English PDF is not ready. Finish writeback or build it first.');result=await api('readPdf',{buildId:build.buildId});if(result.buildId!==build.buildId||result.hash!==build.pdfHash||result.snapshotId!==project.snapshotId)fail('The exported PDF does not match the current English build.');mimeType='application/pdf';filename=project.mainFile.split('/').at(-1).replace(/\.tex$/iu,'')+'.pdf';}
 else fail('Choose the source project ZIP or current English PDF.');
 if(getState().project?.id!==project.id||getState().project?.snapshotId!==project.snapshotId||result.projectId&&result.projectId!==project.id||result.snapshotId!==project.snapshotId)fail('The paper changed during export. Export the current version again.');
 const bytes=bytes64(result.base64);if(await digest(bytes)!==result.hash)fail('The exported file failed its integrity check.');if(getState().project?.id!==project.id||getState().project?.snapshotId!==project.snapshotId)fail('The paper changed during export. Export the current version again.');return{bytes,mimeType,filename};
}
export function initializePaperExport({api,getState,getLatestBuild,notify}){
 const project=document.getElementById('export-source-project'),pdf=document.getElementById('export-latest-pdf'),status=document.getElementById('paper-export-status');let busy=false;
 function render(){project.disabled=busy||!getState().project;pdf.disabled=busy||!getLatestBuild();}
 async function run(format){if(busy)return;busy=true;render();status.textContent='Preparing download…';try{const file=await preparePaperDownload({format,api,getState,getLatestBuild}),url=URL.createObjectURL(new Blob([file.bytes],{type:file.mimeType})),link=document.createElement('a');link.href=url;link.download=file.filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status.textContent='Downloaded: '+file.filename;}catch(error){status.textContent=error.message;notify(error.message,true,true);}finally{busy=false;render();}}
 const source=()=>run('project'),latest=()=>run('pdf');project.addEventListener('click',source);pdf.addEventListener('click',latest);return{adopt:render,destroy(){project.removeEventListener('click',source);pdf.removeEventListener('click',latest);}};
}
