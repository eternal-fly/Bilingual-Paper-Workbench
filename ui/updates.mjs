const repository='https://github.com/eternal-fly/Bilingual-Paper-Workbench';
function officialRelease(value){
  const version=value?.version,tag=value?.tag,runtime=value?.runtime;
  return typeof version==='string'&&/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)&&[version,'v'+version].includes(tag)&&value.releaseUrl===`${repository}/releases/tag/${tag}`&&runtime?.name===`Bilingual-Paper-Workbench-${version}.zip`&&runtime.url===`${repository}/releases/download/${tag}/${runtime.name}`&&/^[a-f0-9]{64}$/u.test(runtime.sha256||'')?value:null;
}
/** Public update metadata is independent of paper/model ownership and editing. */
export function initializeUpdates({api,getState,getInterfaceLanguage}){
  const mount=document.querySelector('.more-menu .rail-menu-content');if(!mount)return{adopt(){},destroy(){}};
  const section=document.createElement('section');section.className='workbench-updates';section.hidden=true;
  section.innerHTML='<h3 id="updates-heading"></h3><p id="updates-current" class="helper"></p><label class="check-control"><input id="updates-auto" type="checkbox"><span id="updates-auto-label"></span></label><p id="updates-status" class="helper" role="status" aria-live="polite"></p><p id="updates-error" class="helper" hidden></p><button id="updates-check" class="button subtle" type="button"></button><button id="updates-review" class="button" type="button" hidden></button>';
  mount.append(section);
  const dialog=document.createElement('dialog');dialog.id='updates-dialog';dialog.setAttribute('aria-labelledby','updates-dialog-title');
  dialog.innerHTML='<div class="dialog-heading"><h2 id="updates-dialog-title"></h2><button id="updates-close" class="text-button" type="button"></button></div><p id="updates-release-version"></p><pre id="updates-release-details" class="helper" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre><p id="updates-install-note" class="helper"></p><div class="dialog-actions"><a id="updates-open-release" class="button primary" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"></a></div>';
  document.body.append(dialog);
  const badge=document.createElement('span');badge.id='updates-available-badge';badge.className='count';badge.hidden=true;badge.textContent='↑';document.querySelector('.more-menu > summary')?.append(badge);
  const $=id=>document.getElementById(id),copy=(en,zh)=>/^zh(?:-|$)/u.test(getInterfaceLanguage())?zh:en;
  let data=null,busy=false,started=false,destroyed=false,timer=null,localError='';
  function render(){
    if(destroyed)return;section.hidden=getState().capabilities?.releaseUpdates!==true;
    const release=officialRelease(data?.release);$('updates-heading').textContent=copy('Updates','版本更新');$('updates-current').textContent=copy('Current version: ','当前版本：')+(data?.currentVersion||'—');
    $('updates-auto-label').textContent=copy('Check stable GitHub releases automatically','自动检查 GitHub 稳定版本');$('updates-auto').checked=data?.autoCheck!==false;$('updates-auto').disabled=busy;
    const statuses={idle:copy('Not checked yet.','尚未检查。'),'up-to-date':copy('This version is up to date.','当前已是最新版。'),offline:copy('Update check offline. Editing is unaffected.','更新检查离线，不影响编辑。'),'rate-limited':copy('GitHub is rate limited. Try again later.','GitHub 访问频率受限，请稍后再试。'),'invalid-release':copy('Release metadata could not be verified.','无法核验发布版本的信息。')};
    $('updates-status').textContent=busy?copy('Checking public releases…','正在检查公开版本…'):release?copy('Version ','版本 ')+release.version+copy(' is available.',' 可更新。'):statuses[data?.status]||copy('Update information unavailable.','暂时无法检查更新。');
    const cacheMessage=data?.cacheError?.code==='UPDATE_CACHE_WRITE_FAILED'?copy('Update settings could not be saved. Editing is unaffected.','更新设置未能保存，不影响编辑。'):data?.cacheError?copy('Saved update settings could not be read. Editing is unaffected.','无法读取更新设置，不影响编辑。'):'';
    $('updates-error').textContent=localError||cacheMessage;$('updates-error').hidden=!$('updates-error').textContent;
    $('updates-check').textContent=copy('Check now','立即检查');$('updates-check').disabled=busy;$('updates-review').textContent=copy('Review update','查看更新');$('updates-review').hidden=!release;$('updates-review').disabled=busy;
    badge.hidden=!release;badge.setAttribute('aria-label',copy('A stable update is available','有稳定版本可更新'));
    $('updates-dialog-title').textContent=copy('Review update','查看更新');$('updates-close').textContent=copy('Close','关闭');$('updates-open-release').textContent=copy('Open official release','打开官方发布页');
    $('updates-install-note').textContent=copy('Review the official release, verify the ZIP checksum, and install manually when ready. This window does not download or run installers. Keep your current editor open until drafts are saved.','请查看官方发布页，核对 ZIP 校验值，准备好后手动安装。本窗口不会下载或运行安装程序；草稿保存前请保持当前编辑窗口打开。');
    $('updates-open-release').removeAttribute('href');
    if(release){$('updates-release-version').textContent=copy('Version ','版本 ')+release.version;$('updates-release-details').textContent=`${release.runtime.name}\nSHA256 ${release.runtime.sha256}`;$('updates-open-release').href=release.releaseUrl;}
    else{$('updates-release-version').textContent='';$('updates-release-details').textContent='';if(dialog.open)dialog.close();}
  }
  function schedule(){clearTimeout(timer);if(destroyed||data?.autoCheck===false)return;const due=Date.parse(data?.nextCheckAt);timer=setTimeout(()=>void check(false),Math.max(60000,Number.isFinite(due)?due-Date.now():86400000));}
  async function check(manual){if(busy||destroyed)return;busy=true;localError='';render();try{const result=await api('checkUpdates',{manual});if(!destroyed)data=result;}catch{localError=copy('Update check unavailable. Your paper and editor are unaffected.','暂时无法检查更新；论文和编辑缓冲不受影响。');}finally{busy=false;render();schedule();}}
  function adopt(){render();if(started||section.hidden||destroyed)return;started=true;void(async()=>{try{data=await api('getUpdates');render();if(data.autoCheck!==false)await check(false);else schedule();}catch{localError=copy('Update settings unavailable. Editing is unaffected.','更新设置暂不可用，不影响编辑。');render();}})();}
  $('updates-check').addEventListener('click',()=>void check(true));
  $('updates-auto').addEventListener('change',async()=>{if(busy)return;const autoCheck=$('updates-auto').checked;busy=true;render();try{data=await api('configureUpdates',{autoCheck});localError='';}catch{localError=copy('Update settings could not be saved. Editing is unaffected.','更新设置未能保存，不影响编辑。');}finally{busy=false;render();schedule();}});
  $('updates-review').addEventListener('click',()=>{render();if(officialRelease(data?.release)&&!dialog.open)dialog.showModal();});
  $('updates-close').addEventListener('click',()=>dialog.close());
  return{adopt,destroy(){destroyed=true;clearTimeout(timer);section.remove();dialog.remove();badge.remove();}};
}
