import {getDocument,GlobalWorkerOptions} from 'pdfjs-dist/build/pdf.mjs';

let workerUrl;
const owners=new WeakMap();
export const PDF_VIEW_LIMITS=Object.freeze({minScale:.25,maxScale:4,maxRasterPixels:8*1024*1024,maxRasterSide:8192,maxCssSide:65536});
const cancelled=()=>Object.assign(new Error('The PDF view was replaced or closed.'),{name:'AbortError',code:'PDF_VIEW_CANCELLED'});
export function openPdfDocument(bytes){
  workerUrl ||= URL.createObjectURL(new Blob([__PDF_WORKER_SOURCE__],{type:'text/javascript'}));GlobalWorkerOptions.workerSrc=workerUrl;
  return getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,stopAtErrors:true});
}

/** A read-only single-page viewport. Logical zoom is independent of raster size. */
export async function renderPdf(container,bytes,{page=1,scale='fit-width',onPoint=null,onViewChange=null,onError=null}={}){
  const previous=owners.get(container),entry={destroy:null};owners.set(container,entry);void previous?.destroy?.();
  const scrollport=container.closest('.pdf-container')||container,events=new AbortController(),cleanups=[];
  let task,document,canvas,sheetHost,overlay,cursor,currentSheet,currentViewport,activeJob,activeHighlight=null,keyboardPoint=null;
  let destroyed=false,destroyPromise,revision=0,requestedPage=page,lastPromise=Promise.resolve(),wheelFrame=0,wheelTarget=null,resizeFrame=0,observedWidth=0,spaceHeld=false,drag=null,suppressClick=false;
  const alive=()=>!destroyed&&owners.get(container)===entry;
  const copy=(en,zh)=>/^zh(?:-|$)/u.test(window.document.documentElement.lang)?zh:en;
  const clamp=value=>Math.max(PDF_VIEW_LIMITS.minScale,Math.min(PDF_VIEW_LIMITS.maxScale,value));
  const listen=(node,type,fn,options={})=>node.addEventListener(type,fn,{...options,signal:events.signal});
  function view(){return{page:viewer.page,scale:viewer.scale,mode:viewer.mode,panMode:viewer.panMode,rendering:viewer.rendering};}
  function emit(){if(alive())onViewChange?.(view());}
  function refreshLabels(){if(!canvas)return;canvas.setAttribute('aria-label',copy(`English PDF page ${viewer.page} of ${document.numPages}. Arrow keys choose a point; Enter locates source. Ctrl wheel zooms; Space or middle drag pans.`,`英文 PDF 第 ${viewer.page} 页，共 ${document.numPages} 页。方向键选择位置，Enter 关联原文；Ctrl 滚轮缩放，空格或中键拖动平移。`));}
  function pageSize(){return currentSheet?{width:currentSheet.view[2]-currentSheet.view[0],height:currentSheet.view[3]-currentSheet.view[1]}:null;}
  function viewportPoint(x,y){return currentViewport.convertToViewportPoint(x+currentSheet.view[0],currentSheet.view[3]-y);}
  function positionCursor(){if(!keyboardPoint||!currentViewport){cursor.hidden=true;return;}const[x,y]=viewportPoint(keyboardPoint.x,keyboardPoint.y);cursor.style.left=`${100*x/currentViewport.width}%`;cursor.style.top=`${100*y/currentViewport.height}%`;cursor.hidden=false;}
  function positionHighlight(scroll=false){
    if(!activeHighlight||!currentSheet||!currentViewport||activeHighlight.page!==viewer.page){overlay.hidden=true;return false;}
    const match=activeHighlight,left=Number.isFinite(match.h)?match.h:match.x,top=Number.isFinite(match.v)?match.v-match.height:match.y,width=Math.max(Number(match.width)||0,3),height=Math.max(Number(match.height)||0,8);
    if(![left,top,width,height].every(Number.isFinite))return false;const first=viewportPoint(left,top),last=viewportPoint(left+width,top+height);
    overlay.style.left=`${100*Math.min(first[0],last[0])/currentViewport.width}%`;overlay.style.top=`${100*Math.min(first[1],last[1])/currentViewport.height}%`;
    overlay.style.width=`${100*Math.abs(last[0]-first[0])/currentViewport.width}%`;overlay.style.height=`${100*Math.abs(last[1]-first[1])/currentViewport.height}%`;overlay.hidden=false;
    if(scroll)overlay.scrollIntoView({block:'nearest',inline:'nearest'});return true;
  }
  function availableWidth(){const style=getComputedStyle(scrollport),width=scrollport.clientWidth||scrollport.parentElement?.clientWidth||container.clientWidth||600;return Math.max(1,width-(parseFloat(style.paddingLeft)||0)-(parseFloat(style.paddingRight)||0));}
  function anchorAt(options={}){
    if(!currentViewport||!sheetHost?.isConnected)return null;const bounds=scrollport.getBoundingClientRect(),rect=sheetHost.getBoundingClientRect();
    const clientX=Number.isFinite(options.clientX)?options.clientX:bounds.left+scrollport.clientWidth/2,clientY=Number.isFinite(options.clientY)?options.clientY:bounds.top+scrollport.clientHeight/2;
    return{clientX,clientY,x:(clientX-rect.left)/rect.width,y:(clientY-rect.top)/rect.height};
  }
  function restoreAnchor(anchor){if(!anchor)return;const rect=sheetHost.getBoundingClientRect();scrollport.scrollLeft+=rect.left+anchor.x*rect.width-anchor.clientX;scrollport.scrollTop+=rect.top+anchor.y*rect.height-anchor.clientY;}
  function applyViewport(sheet,zoom,anchor){
    const viewport=sheet.getViewport({scale:zoom});if(![viewport.width,viewport.height].every(value=>Number.isFinite(value)&&value>0&&value<=PDF_VIEW_LIMITS.maxCssSide))throw new Error('PDF page dimensions exceed the reading viewport limit.');
    currentSheet=sheet;currentViewport=viewport;sheetHost.style.width=`${viewport.width}px`;sheetHost.style.height=`${viewport.height}px`;canvas.style.width=`${viewport.width}px`;canvas.style.height=`${viewport.height}px`;restoreAnchor(anchor);positionCursor();positionHighlight();return viewport;
  }
  async function performRender(number,zoom,options={}){
    if(!alive())throw cancelled();if(!Number.isInteger(number)||number<1||number>document.numPages||zoom!=='fit-width'&&(!Number.isFinite(zoom)||zoom<PDF_VIEW_LIMITS.minScale||zoom>PDF_VIEW_LIMITS.maxScale))throw new Error('Invalid PDF page or zoom.');
    const ticket=++revision,anchor=anchorAt(options),samePage=number===viewer.page&&currentSheet;
    const previous={page:viewer.page,scale:viewer.scale,mode:viewer.mode,sheet:currentSheet,keyboardPoint,left:scrollport.scrollLeft,top:scrollport.scrollTop};
    try{
    requestedPage=number;viewer.mode=zoom==='fit-width'?'fit-width':'custom';viewer.rendering=true;canvas.setAttribute('aria-busy','true');
    if(samePage){viewer.scale=zoom==='fit-width'?clamp(availableWidth()/currentSheet.getViewport({scale:1}).width):zoom;applyViewport(currentSheet,viewer.scale,anchor);emit();}
    const prior=activeJob;if(prior){prior.cancel();try{await prior.promise;}catch{}}
    if(!alive()||ticket!==revision)return viewer;
    const sheet=samePage?currentSheet:await document.getPage(number);if(!alive()||ticket!==revision)return viewer;
    const logicalZoom=zoom==='fit-width'?clamp(availableWidth()/sheet.getViewport({scale:1}).width):zoom,viewport=sheet.getViewport({scale:logicalZoom});
    if(![viewport.width,viewport.height].every(value=>Number.isFinite(value)&&value>0&&value<=PDF_VIEW_LIMITS.maxCssSide))throw new Error('PDF page dimensions exceed the reading viewport limit.');
    const ratio=Math.min(window.devicePixelRatio||1,2,Math.sqrt(PDF_VIEW_LIMITS.maxRasterPixels/(viewport.width*viewport.height)),PDF_VIEW_LIMITS.maxRasterSide/viewport.width,PDF_VIEW_LIMITS.maxRasterSide/viewport.height);
    const scratch=window.document.createElement('canvas');scratch.width=Math.max(1,Math.floor(viewport.width*ratio));scratch.height=Math.max(1,Math.floor(viewport.height*ratio));let job;
    try{
      job=sheet.render({canvasContext:scratch.getContext('2d',{alpha:false}),viewport,transform:ratio===1?null:[ratio,0,0,ratio,0,0]});activeJob=job;await job.promise;
      if(!alive()||ticket!==revision)return viewer;
      const changedPage=!currentSheet||viewer.page!==number;viewer.page=number;viewer.scale=logicalZoom;if(changedPage){keyboardPoint=null;scrollport.scrollLeft=0;scrollport.scrollTop=0;}
      applyViewport(sheet,logicalZoom,changedPage?null:anchorAt(options));canvas.width=scratch.width;canvas.height=scratch.height;canvas.getContext('2d',{alpha:false}).drawImage(scratch,0,0);
      canvas.dataset.pdfScale=String(logicalZoom);canvas.dataset.pdfPage=String(number);viewer.rendering=false;canvas.setAttribute('aria-busy','false');refreshLabels();positionHighlight();positionCursor();return viewer;
    }catch(error){if(!alive()||ticket!==revision||error.name==='RenderingCancelledException')return viewer;throw error;}
    finally{scratch.width=0;scratch.height=0;if(activeJob===job)activeJob=null;}
    }catch(error){
      if(alive()&&ticket===revision){
        viewer.page=previous.page;viewer.scale=previous.scale;viewer.mode=previous.mode;requestedPage=previous.page;keyboardPoint=previous.keyboardPoint;
        if(previous.sheet)applyViewport(previous.sheet,previous.scale,null);
        scrollport.scrollLeft=previous.left;scrollport.scrollTop=previous.top;
      }
      throw error;
    }finally{if(alive()&&ticket===revision){viewer.rendering=false;canvas.setAttribute('aria-busy','false');emit();}}
  }
  function render(number=viewer.page,zoom=viewer.scale,options={}){const pending=performRender(number,zoom,options);lastPromise=pending;return pending;}
  function report(error){if(alive()&&error.name!=='AbortError')onError?.(error);}
  function finishDrag(){if(drag){const ended=drag;drag=null;suppressClick=ended.button===0;try{scrollport.releasePointerCapture(ended.pointerId);}catch{}}scrollport.classList.remove('pdf-dragging');}
  entry.destroy=()=>{
    if(destroyPromise)return destroyPromise;destroyed=true;revision++;activeJob?.cancel();events.abort();cancelAnimationFrame(wheelFrame);cancelAnimationFrame(resizeFrame);for(const cleanup of cleanups)cleanup();
    if(owners.get(container)===entry){owners.delete(container);container.replaceChildren();scrollport.classList.remove('pdf-pan-enabled','pdf-dragging');delete scrollport.dataset.pdfPanMode;}
    if(canvas){canvas.width=0;canvas.height=0;}destroyPromise=Promise.resolve(task?.destroy()).catch(()=>{});return destroyPromise;
  };
  const viewer={pageCount:0,page:1,scale:1,mode:scale==='fit-width'?'fit-width':'custom',panMode:false,rendering:false,render,
    setScale:(zoom,options={})=>render(requestedPage,zoom,options),fitWidth:(options={})=>render(requestedPage,'fit-width',options),resetZoom:(options={})=>render(requestedPage,1,options),
    zoomBy:(factor,options={})=>{if(!Number.isFinite(factor)||factor<=0)return Promise.reject(new Error('Invalid PDF zoom step.'));return render(requestedPage,clamp(viewer.scale*factor),options);},
    setPanMode(value){viewer.panMode=Boolean(value);scrollport.classList.toggle('pdf-pan-enabled',viewer.panMode);scrollport.dataset.pdfPanMode=String(viewer.panMode);emit();},
    highlight(match){if(!currentSheet||!currentViewport||match.page!==viewer.page)return false;activeHighlight={...match};return positionHighlight(true);},clearHighlight(){activeHighlight=null;if(overlay)overlay.hidden=true;},
    refreshLabels,async whenIdle(){if(wheelFrame)await new Promise(resolve=>requestAnimationFrame(resolve));let observed;do{observed=lastPromise;await observed;}while(observed!==lastPromise);},destroy:entry.destroy};
  try{
    task=openPdfDocument(bytes);document=await task.promise;if(!alive())throw cancelled();viewer.pageCount=document.numPages;
    canvas=window.document.createElement('canvas');canvas.tabIndex=0;canvas.style.display='block';sheetHost=window.document.createElement('div');sheetHost.className='pdf-sheet';
    overlay=window.document.createElement('div');overlay.className='pdf-location-overlay';overlay.hidden=true;overlay.setAttribute('aria-hidden','true');cursor=window.document.createElement('div');cursor.className='pdf-point-cursor';cursor.hidden=true;cursor.setAttribute('aria-hidden','true');sheetHost.append(canvas,overlay,cursor);container.replaceChildren(sheetHost);
    listen(canvas,'click',event=>{if(suppressClick){suppressClick=false;return;}if(!currentViewport||!onPoint||viewer.panMode||spaceHeld||requestedPage!==viewer.page)return;const rect=canvas.getBoundingClientRect(),[x,y]=currentViewport.convertToPdfPoint((event.clientX-rect.left)*currentViewport.width/rect.width,(event.clientY-rect.top)*currentViewport.height/rect.height);onPoint({page:viewer.page,x:x-currentSheet.view[0],y:currentSheet.view[3]-y});});
    listen(scrollport,'wheel',event=>{if(!event.ctrlKey&&!event.metaKey)return;event.preventDefault();const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?scrollport.clientHeight:1);wheelTarget={zoom:clamp((wheelTarget?.zoom||viewer.scale)*Math.exp(Math.max(-.7,Math.min(.7,-delta*.002)))),clientX:event.clientX,clientY:event.clientY};if(wheelFrame)return;wheelFrame=requestAnimationFrame(()=>{wheelFrame=0;const target=wheelTarget;wheelTarget=null;void viewer.setScale(target.zoom,target).catch(report);});},{passive:false});
    if(scrollport.tabIndex<0)scrollport.tabIndex=0;
    listen(scrollport,'pointerdown',event=>{if(event.button!==1&&!(event.button===0&&(viewer.panMode||spaceHeld))){suppressClick=false;return;}event.preventDefault();scrollport.focus({preventScroll:true});suppressClick=event.button===0;drag={pointerId:event.pointerId,button:event.button,x:event.clientX,y:event.clientY,left:scrollport.scrollLeft,top:scrollport.scrollTop};scrollport.setPointerCapture(event.pointerId);scrollport.classList.add('pdf-dragging');});
    listen(scrollport,'pointermove',event=>{if(!drag||drag.pointerId!==event.pointerId)return;event.preventDefault();scrollport.scrollLeft=drag.left-(event.clientX-drag.x);scrollport.scrollTop=drag.top-(event.clientY-drag.y);});
    listen(scrollport,'pointerup',finishDrag);listen(scrollport,'pointercancel',finishDrag);listen(scrollport,'lostpointercapture',finishDrag);listen(scrollport,'auxclick',event=>{if(event.button===1)event.preventDefault();});
    listen(scrollport,'keydown',event=>{
      if(event.target!==canvas&&event.target!==scrollport)return;
      if((event.ctrlKey||event.metaKey)&&['+','=','-','0'].includes(event.key)){event.preventDefault();void(event.key==='0'?viewer.resetZoom():viewer.zoomBy(event.key==='-'?1/1.2:1.2)).catch(report);return;}
      if(event.key===' '){event.preventDefault();spaceHeld=true;scrollport.classList.add('pdf-pan-enabled');return;}
      if((event.altKey||viewer.panMode||spaceHeld)&&event.key.startsWith('Arrow')){event.preventDefault();scrollport.scrollBy(event.key==='ArrowLeft'?-48:event.key==='ArrowRight'?48:0,event.key==='ArrowUp'?-48:event.key==='ArrowDown'?48:0);return;}
      if(!onPoint||!currentSheet||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Enter','Escape'].includes(event.key)||requestedPage!==viewer.page)return;event.preventDefault();
      if(event.key==='Escape'){keyboardPoint=null;positionCursor();return;}const size=pageSize();keyboardPoint ||= {x:size.width/2,y:size.height/2};if(event.key==='Enter'){onPoint({page:viewer.page,...keyboardPoint});return;}const step=event.shiftKey?1:12;keyboardPoint.x=Math.max(0,Math.min(size.width,keyboardPoint.x+(event.key==='ArrowRight'?step:event.key==='ArrowLeft'?-step:0)));keyboardPoint.y=Math.max(0,Math.min(size.height,keyboardPoint.y+(event.key==='ArrowDown'?step:event.key==='ArrowUp'?-step:0)));positionCursor();
    });
    listen(window,'keyup',event=>{if(event.key===' '){spaceHeld=false;scrollport.classList.toggle('pdf-pan-enabled',viewer.panMode);}});listen(window,'blur',()=>{spaceHeld=false;finishDrag();scrollport.classList.toggle('pdf-pan-enabled',viewer.panMode);});
    const observer=new ResizeObserver(()=>{const width=scrollport.clientWidth;if(!alive()||!width||width===observedWidth)return;observedWidth=width;if(viewer.mode!=='fit-width'||!currentSheet)return;cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{resizeFrame=0;void viewer.fitWidth().catch(report);});});observer.observe(scrollport);cleanups.push(()=>observer.disconnect());
    await render(page,scale);if(!alive())throw cancelled();return viewer;
  }catch(error){await entry.destroy();if(destroyed&&error.name==='RenderingCancelledException')throw cancelled();throw error;}
}
