/** A local display preference, independent of paper text and model requests. */
export const TRANSLATION_TEXT_SIZE = Object.freeze({min:14,max:28,default:17,key:'paper-editor-translation-text-size'});
const validSize = value => {
  if(typeof value !== 'number' && (typeof value !== 'string' || !/^\d{2}$/.test(value))) return null;
  const size=Number(value);
  return Number.isInteger(size) && size>=TRANSLATION_TEXT_SIZE.min && size<=TRANSLATION_TEXT_SIZE.max ? size : null;
};
export function initializeTranslationTypography({root=document,getInterfaceLanguage=()=>document.documentElement.lang,storage=()=>globalThis.localStorage,api=null,getState=()=>({})}={}){
  const panel=root.getElementById('translation-panel'),select=root.getElementById('translation-text-size'),reset=root.getElementById('translation-text-reset'),dialog=root.getElementById('edit-proposal-dialog');
  let size=TRANSLATION_TEXT_SIZE.default,projectId=null,authority=null,desired=null,inFlight=null,sequence=0,failed=false;
  try {size=validSize(storage()?.getItem(TRANSLATION_TEXT_SIZE.key))??size;}catch{}
  const options=Array.from({length:TRANSLATION_TEXT_SIZE.max-TRANSLATION_TEXT_SIZE.min+1},(_,index)=>{
    const option=root.createElement('option'),value=TRANSLATION_TEXT_SIZE.min+index;option.value=String(value);option.textContent=`${value} px`;return option;
  });
  select.replaceChildren(...options);
  function apply(){
    panel.style.setProperty('--translation-text-size',`${size}px`);
    // The Compare final editor is a dialog outside the second panel. Its
    // explicit origin flag scopes the CSS; ordinary source review is unchanged.
    dialog?.style.setProperty('--translation-text-size',`${size}px`);
    select.value=String(size);
  }
  function cache(){try{storage()?.setItem(TRANSLATION_TEXT_SIZE.key,String(size));}catch{}}
  function setSize(value,{persist=true}={}){
    const next=validSize(value);if(next===null)return false;size=next;apply();
    if(persist){cache();if(authority && typeof api==='function'){desired={projectId,size,sequence:++sequence};failed=false;void pump();}}
    refreshLabels();return true;
  }
  async function pump(){
    if(inFlight||!desired||failed||!authority||desired.projectId!==projectId)return;
    const sent={...desired,expectedRevision:authority.revision};
    inFlight=sent;
    try{
      const result=await api('configureDisplayPreferences',{translationTextSize:sent.size,expectedProjectId:sent.projectId,expectedRevision:sent.expectedRevision});
      const prefs=result?.state?.displayPreferences||result?.displayPreferences||result;
      if(getState()?.project?.id!==sent.projectId||projectId!==sent.projectId)return;
      if(validSize(prefs?.translationTextSize)===null||!Number.isSafeInteger(prefs.revision)||prefs.revision<=sent.expectedRevision)throw Error('Display preference confirmation unavailable.');
      if(!authority||prefs.revision>=authority.revision)authority={revision:prefs.revision,size:prefs.translationTextSize};
      if(desired?.sequence===sent.sequence){desired=null;failed=false;}
    }catch{
      if(getState()?.project?.id===sent.projectId&&projectId===sent.projectId){failed=true;}
    }finally{
      inFlight=null;refreshLabels();if(desired&&!failed)void pump();
    }
  }
  function adoptPreferences(preferences,{projectId:nextProject=getState()?.project?.id||null}={}){
    const changedProject=nextProject!==projectId;
    if(changedProject){projectId=nextProject;desired=null;failed=false;authority=null;}
    const next=validSize(preferences?.translationTextSize);
    if(next!==null && Number.isSafeInteger(preferences?.revision)&&preferences.revision>=0){
      if(!authority||preferences.revision>=authority.revision)authority={revision:preferences.revision,size:next};
      if(!desired){size=authority.size;apply();cache();}
    }else if(changedProject){
      try{size=validSize(storage()?.getItem(TRANSLATION_TEXT_SIZE.key))??TRANSLATION_TEXT_SIZE.default;}catch{size=TRANSLATION_TEXT_SIZE.default;}
      apply();
    }
    refreshLabels();return next!==null;
  }
  function refreshLabels(){
    const language=getInterfaceLanguage(),zh=language==='zh-CN',tw=language==='zh-TW';
    root.getElementById('translation-text-title').textContent=zh?'译文显示':tw?'譯文顯示':'Translation display';
    root.getElementById('translation-text-label').textContent=zh?'字号':tw?'字級':'Text size';
    select.setAttribute('aria-label',zh?'译文字号':tw?'譯文字級':'Translation text size');
    reset.textContent=zh?'重置':tw?'重設':'Reset';
    reset.title=zh?'恢复为 17 px':tw?'還原為 17 px':'Reset to 17 px';
    root.getElementById('translation-text-note').textContent=failed?(zh?'当前字号已应用；项目偏好未能保存，可重新选择后重试。':tw?'目前字級已套用；專案偏好未能儲存，可重新選擇後重試。':'Applied in this window. Project preference could not be saved; choose again to retry.'):(zh?'阅读、编辑与公式同时调整，仅影响第二栏。':tw?'閱讀、編輯與公式同步調整，僅影響第二欄。':'Reading, editing and formulas. Second column only.');
  }
  select.addEventListener('change',()=>{if(!setSize(select.value))apply();});
  reset.addEventListener('click',()=>setSize(TRANSLATION_TEXT_SIZE.default));
  apply();refreshLabels();
  return {setSize,getSize:()=>size,refreshLabels,adoptPreferences,adopt:state=>adoptPreferences(state?.displayPreferences,{projectId:state?.project?.id||null})};
}
