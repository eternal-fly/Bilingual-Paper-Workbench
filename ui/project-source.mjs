import { translationUpdateCandidates } from './tex-prose-reader.mjs';
const node = (tag, className, text) => { const value=document.createElement(tag);if(className)value.className=className;if(text!==undefined)value.textContent=text;return value; };
const key=state=>`${state.workspaceIndex?.currentRecordId||state.project?.id||''}:${state.project?.snapshotId||''}`;
const busy=state=>state.chat?.busy||(state.jobs||[]).some(job=>['queued','running','compiling','cancelling','inProgress'].includes(job.status));
function railButton(id,label,title,before){const button=node('button','rail-tool');button.id=id;button.type='button';button.title=title;button.setAttribute('aria-label',title);const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');for(const [name,value]of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))icon.setAttribute(name,value);const p=document.createElementNS(icon.namespaceURI,'path');p.setAttribute('d',id==='project-source-open'?'m8 5-6 7 6 7m8-14 6 7-6 7m-3-16-2 18':'M3 7h17m-4-4 4 4-4 4M21 17H4m4-4-4 4 4 4');icon.append(p);button.append(icon,node('span','',label));before.before(button);return button;}
function dialog(id,title,description){const value=node('dialog','source-workflow-dialog');value.id=id;const heading=node('div','dialog-heading'),group=node('div'),h=node('h2','',title),close=node('button','text-button','关闭');h.id=`${id}-title`;group.append(h,node('p','',description));close.type='button';close.setAttribute('aria-label',`关闭${title}`);close.addEventListener('click',()=>value.close());heading.append(group,close);value.setAttribute('aria-labelledby',h.id);value.append(heading);document.body.append(value);return value;}

/** Complete project reads are manifest-bound and remain read-only. */
export function initializeSourceWorkflow({api,getState,getLanguage,onTranslationRequest,onError,desktopAvailable=()=>false}){
  const sourceButton=railButton('project-source-open','源码','查看项目 LaTeX 源码',document.getElementById('workspace-history'));
  const updateButton=railButton('translation-update-open','更新译文','翻译变更或尚未翻译的段落',document.getElementById('translate-selected'));
  const sourceDialog=dialog('project-source-dialog','项目 LaTeX 源码','英文 PDF 沿用项目主文件、模板、图表和参考文献格式。这里只读查看完整源码。');
  const sourceLabel=node('label','field','项目文件'),select=node('select');select.id='project-source-file';select.setAttribute('aria-label','选择项目源文件');sourceLabel.append(select);
  const sourceStatus=node('p','helper');sourceStatus.id='project-source-status';sourceStatus.setAttribute('role','status');
  const sourceError=node('p','inline-error');sourceError.id='project-source-error';sourceError.hidden=true;sourceError.setAttribute('role','alert');
  const content=node('textarea','project-source-code mono');content.id='project-source-code';content.readOnly=true;content.spellcheck=false;content.setAttribute('aria-label','完整项目源码，只读');
  sourceDialog.append(sourceLabel,sourceStatus,sourceError,content);
  const updateDialog=dialog('translation-update-dialog','更新对应段落的译文','选择确切源段落后预览翻译请求。仅更新选段译文，英文源码不变。');
  const updateStatus=node('p','helper');updateStatus.id='translation-update-status';
  const scopeLabel=node('label','field','范围'),scope=node('select');scope.id='translation-update-scope';scope.append(new Option('源文已变更／译文已过期','changed'),new Option('尚未翻译的段落','missing'));scopeLabel.append(scope);
  const choices=node('div','translation-update-choices');choices.id='translation-update-choices';
  const updateError=node('p','inline-error');updateError.id='translation-update-error';updateError.hidden=true;updateError.setAttribute('role','alert');
  const prepare=node('button','button primary','预览选段翻译请求');prepare.id='translation-update-prepare';prepare.type='button';
  const actions=node('div','dialog-actions');actions.append(prepare);updateDialog.append(updateStatus,scopeLabel,choices,updateError,actions);
  let stateKey=key(getState()),manifest=null,loading=false,generation=0,selectionKey='',selected=new Set();
  function error(target,problem){target.textContent=[problem?.code,problem?.message||String(problem)].filter(Boolean).join('：');target.hidden=false;}
  async function loadSource(){
    const file=manifest?.files?.find(file=>file.path===select.value);if(!file||file.kind!=='text')return;
    const captured=key(getState()),ticket=++generation;sourceError.hidden=true;content.value='';sourceStatus.textContent='正在核对源版本并读取…';select.disabled=true;
    try{const response=await api('readProjectSource',{path:file.path,expectedSnapshotId:manifest.snapshotId,expectedHash:file.hash});if(ticket!==generation||captured!==key(getState())||!sourceDialog.open)return;if(response.path!==file.path||response.hash!==file.hash||response.snapshotId!==manifest.snapshotId||response.projectId!==manifest.projectId||response.readonly!==true||typeof response.content!=='string')throw Error('源码身份与选定文件不一致，请重新打开。');content.value=response.content;sourceStatus.textContent=`${file.path}${file.path===manifest.mainFile?' · 主文件':''} · 只读 · SHA-256 ${file.hash.slice(0,16)}…`;content.dataset.sourcePath=file.path;}
    catch(problem){if(ticket===generation)error(sourceError,problem);}
    finally{if(ticket===generation)select.disabled=false;}
  }
  async function openSource(){if(loading||!getState().project)return;sourceDialog.showModal();sourceError.hidden=true;sourceStatus.textContent='正在读取已授权项目的文件索引…';content.value='';loading=true;const captured=key(getState());
    try{const response=await api('listProjectSources',{});if(captured!==key(getState())||!sourceDialog.open)return;if(!response||!Array.isArray(response.files)||response.projectId!==getState().project.id||response.snapshotId!==getState().project.snapshotId)throw Error('项目索引已变化，请重新打开源码。');manifest=response;select.replaceChildren(...response.files.map(file=>{const option=new Option(`${file.path}${file.path===response.mainFile?' · 主文件':''}${file.kind!=='text'?' · 二进制依赖':''}`,file.path);option.disabled=file.kind!=='text';return option;}));select.value=response.files.some(file=>file.path===response.mainFile&&file.kind==='text')?response.mainFile:response.files.find(file=>file.kind==='text')?.path||'';await loadSource();}
    catch(problem){error(sourceError,problem);}finally{loading=false;}
  }
  function renderUpdates(){const state=getState(),desktop=desktopAvailable(),candidates=translationUpdateCandidates(state,getLanguage()),items=candidates[scope.value],nextKey=JSON.stringify([key(state),getLanguage(),scope.value,desktop,items]);if(selectionKey!==nextKey){selectionKey=nextKey;selected=new Set(items.map(item=>item.id));
      choices.replaceChildren(...items.map(item=>{const label=node('label','translation-update-choice'),box=node('input');box.type='checkbox';box.dataset.sourceId=item.id;box.checked=selected.has(item.id);box.addEventListener('change',()=>{if(box.checked)selected.add(item.id);else selected.delete(item.id);renderUpdates();});label.append(box,node('span','',`段落 ${item.paragraphNumber} · ${item.section||item.path||item.id}${item.manual?' · 含人工译文':''}`));return label;}));
      if(!items.length)choices.append(node('p','empty',scope.value==='changed'?'没有可证明已过期的译文。已人工更新的段落不会被猜测为旧译文。':'当前源段落已有译文。'));
    }
    updateStatus.textContent=document.documentElement.lang.startsWith('zh')?`${candidates.changed.length} 段待更新，${candidates.missing.length} 段未翻译；已选 ${selected.size} 段。完整范围提交，后台按内容大小分批处理。`:`${candidates.changed.length} changed, ${candidates.missing.length} untranslated; ${selected.size} selected. Submit the complete scope; the backend batches by content size.`;
    prepare.textContent=desktop?(document.documentElement.lang.startsWith('zh')?'翻译所选段落':'Translate selected paragraphs'):'预览选段翻译请求';
    prepare.disabled=busy(state)&&!desktop||selected.size===0;
  }
  sourceButton.addEventListener('click',()=>void openSource());select.addEventListener('change',()=>void loadSource());sourceDialog.addEventListener('close',()=>{generation++;content.value='';manifest=null;});
  updateButton.addEventListener('click',()=>{updateError.hidden=true;const candidates=translationUpdateCandidates(getState(),getLanguage());scope.value=candidates.changed.length?'changed':'missing';selectionKey='';renderUpdates();updateDialog.showModal();});scope.addEventListener('change',()=>{selectionKey='';renderUpdates();});
  prepare.addEventListener('click',async()=>{if(prepare.disabled)return;prepare.disabled=true;updateError.hidden=true;try{const ids=[...selected];await onTranslationRequest(ids);updateDialog.close();}catch(problem){error(updateError,problem);onError?.(problem);}finally{if(updateDialog.open)renderUpdates();}});
  return{adopt(){const state=getState(),next=key(state);sourceButton.disabled=!state.project;const candidates=translationUpdateCandidates(state,getLanguage());updateButton.disabled=!state.project||busy(state)&&!desktopAvailable();updateButton.title=`${candidates.changed.length} 段待更新，${candidates.missing.length} 段未翻译`;if(stateKey!==next){stateKey=next;generation++;manifest=null;content.value='';sourceDialog.close();updateDialog.close();selectionKey='';}if(updateDialog.open)renderUpdates();},destroy(){sourceDialog.remove();updateDialog.remove();sourceButton.remove();updateButton.remove();}};
}
