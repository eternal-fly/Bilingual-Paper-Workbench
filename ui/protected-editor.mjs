import { isLiteralCitation, deriveTranslationProtectedTokens } from './translation-protection.mjs';
import {uiText} from './languages.mjs';

const editableReferences = new Set(['cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'ref', 'eqref', 'pageref', 'autoref', 'cref', 'Cref']);
export const isEditableInlineReference = raw => typeof raw === 'string' && editableReferences.has(/^\\([A-Za-z]+)\*?/u.exec(raw)?.[1]);
function sourceLabels(tokens) {
  const labels = new Set(); let budget = 512 * 1024;
  for (const token of Array.isArray(tokens) ? tokens : []) {
    if (typeof token?.raw !== 'string') continue;
    budget -= token.raw.length; if (budget < 0) throw new TypeError('Source label atoms exceed the protected editor budget.');
    for (const match of token.raw.matchAll(/\\label\s*\{[^{}\\\r\n]{1,512}\}/gu)) labels.add(match[0]);
  }
  return [...labels].map((raw, index) => ({ id: `source-label-${index}`, raw, kind: 'structure' }));
}

function flatten(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.data;
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return '';
  if (node.nodeType === Node.ELEMENT_NODE && node.dataset.editorTail === 'true') return '';
  if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('protected-object')) return node.dataset.raw || '';
  if (node.nodeName === 'BR') return '\n';
  return [...node.childNodes].map(flatten).join('');
}
function objectLabel(raw, kind,language) {
  if (/^\\label\b/u.test(raw)) return `${uiText('结构',language)} ${raw.length <= 24 ? raw : raw.slice(0, 21) + '…'}`;
  if (kind === 'math' || /^(?:\$|\\\(|\\\[)/u.test(raw)) return `${uiText('公式',language)} ${raw.length <= 24 ? raw : raw.slice(0, 21) + '…'}`;
  if (kind === 'citation' || /^\\(?:cite|ref|eqref|label|cref)/u.test(raw) || isLiteralCitation(raw)) return `${uiText('引用',language)} ${raw.length <= 25 ? raw : raw.slice(0, 22) + '…'}`;
  return `${uiText('结构',language)} ${raw.length <= 20 ? raw : raw.slice(0, 17) + '…'}`;
}

function createFreeEditor() {
  const editor=document.createElement('textarea');editor.className='translation-input free-tex-editor';editor.dataset.freeEditing='true';editor.rows=4;editor.setAttribute('role','textbox');editor.setAttribute('aria-multiline','true');
  editor.refreshLabels=()=>{};
  // Existing callers may refresh source metadata. It must never replace or
  // tokenize a freely edited author buffer, including incomplete TeX.
  editor.setProtectedTokens=()=>{};
  editor.focusAt=offset=>{editor.focus({preventScroll:true});const at=Math.max(0,Math.min(editor.value.length,offset));editor.setSelectionRange(at,at);};
  editor.focusRange=(start,end=start)=>{editor.focus({preventScroll:true});editor.setSelectionRange(Math.max(0,Math.min(editor.value.length,start)),Math.max(0,Math.min(editor.value.length,end)));};
  editor.acceptCanonicalValue=(expected,canonical)=>typeof expected==='string'&&typeof canonical==='string'&&editor.value===expected.replaceAll('\r\n','\n')&&expected.replaceAll('\r\n','\n')===canonical.replaceAll('\r\n','\n');
  return editor;
}

/** Legacy protected atoms remain opt-in; the workbench uses free inline TeX. */
export function createProtectedEditor({ tokens = [], sourceTokens = tokens, onProtectedAttempt = () => {}, mathInline = false, referencesInline = false, structuresInline = false, freeEditing = false, getLanguage=()=>document.documentElement.lang||'en' } = {}) {
  if(freeEditing)return createFreeEditor();
  const editor = document.createElement('div');
  editor.className = 'translation-input protected-editor';
  editor.contentEditable = 'true';
  editor.setAttribute('role', 'textbox'); editor.setAttribute('aria-multiline', 'true');
  editor.tabIndex = 0;
  let disabled = false, lastSafe = '', expectedObjects = [], history = [{ value: '', caret: 0 }], historyIndex = 0, replaying = false;
  let fixedLabels = !structuresInline && mathInline && referencesInline ? sourceLabels(sourceTokens) : [];
  const objects = () => [...editor.querySelectorAll('.protected-object')];
  editor.refreshLabels=()=>{for(const object of objects()){const label=objectLabel(object.dataset.raw,object.dataset.protectedKind,getLanguage()),aria=`${uiText('受保护对象',getLanguage())}: ${object.dataset.raw}`;if(object.textContent!==label)object.textContent=label;if(object.getAttribute('aria-label')!==aria)object.setAttribute('aria-label',aria);}};
  const objectSignature = () => objects().map(node => node.dataset.raw);
  const value = () => editor.childNodes.length === 1 && editor.firstChild.nodeName === 'BR' ? '' : flatten(editor);
  function ensureTail() {
    let tail = editor.querySelector('[data-editor-tail="true"]');
    if (!tail) { tail = document.createElement('br'); tail.dataset.editorTail = 'true'; }
    if (editor.lastChild !== tail) editor.append(tail);
    editor.dataset.empty = String(value().length === 0);
  }
  function prefix(container, offset) {
    const range = document.createRange(); range.setStart(editor, 0); range.setEnd(container, offset); return flatten(range.cloneContents()).length;
  }
  function selectionInfo() {
    const selection = getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer) && range.startContainer !== editor) return null;
    if (!editor.contains(range.endContainer) && range.endContainer !== editor) return null;
    const inside = node => (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('.protected-object');
    return { range, start: prefix(range.startContainer, range.startOffset), end: prefix(range.endContainer, range.endOffset), inside: inside(range.startContainer) || inside(range.endContainer) };
  }
  function intervals() {
    const list = []; let cursor = 0;
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) { cursor += node.data.length; return; }
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
      if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('protected-object')) { const raw = node.dataset.raw || ''; list.push({ start: cursor, end: cursor + raw.length, raw, id: node.dataset.tokenId || '', kind: node.dataset.protectedKind || '' }); cursor += raw.length; return; }
      if (node.nodeName === 'BR') { cursor++; return; }
      for (const child of node.childNodes) walk(child);
    }
    walk(editor); return list;
  }
  function wouldTouchObject(inputType = '') {
    const selection = selectionInfo();
    if (!selection) return false;
    if (selection.inside) return true;
    const ranges = intervals();
    if (selection.start !== selection.end) return ranges.some(item => selection.start < item.end && selection.end > item.start);
    if (/^delete.*Backward$/u.test(inputType)) return ranges.some(item => selection.start > item.start && selection.start <= item.end);
    if (/^delete.*Forward$/u.test(inputType)) return ranges.some(item => selection.start >= item.start && selection.start < item.end);
    return false;
  }
  function caretAt(offset) {
    const target = Math.max(0, Math.min(value().length, offset));
    const range = document.createRange(); let cursor = 0, positioned = false;
    for (const child of editor.childNodes) {
      const size = flatten(child).length;
      if (target <= cursor + size) {
        if (child.nodeType === Node.TEXT_NODE) range.setStart(child, Math.min(child.data.length, target - cursor));
        else if (child.classList?.contains('protected-object')) target <= cursor ? range.setStartBefore(child) : range.setStartAfter(child);
        else range.setStartAfter(child);
        positioned = true; break;
      }
      cursor += size;
    }
    if (!positioned) { range.selectNodeContents(editor); range.collapse(false); } else range.collapse(true);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }
  function render(text, resetHistory = false, objectSnapshot = null) {
    const renderTokens = (mathInline ? deriveTranslationProtectedTokens(text, tokens).filter(token=>token.kind!=='math') : tokens).filter(token=>(!referencesInline||!isEditableInlineReference(token.raw))&&(!structuresInline||token.kind==='math'||token.kind==='citation'||isEditableInlineReference(token.raw)));
    const matched = []; let position = 0;
    if(objectSnapshot){for(const token of objectSnapshot)if(text.slice(token.start,token.end)===token.raw)matched.push({start:token.start,end:token.end,token});}
    else for (const token of renderTokens) {
      if (typeof token.raw !== 'string' || !token.raw.length) continue;
      const start = text.indexOf(token.raw, position);
      if (start < 0) continue;
      matched.push({ start, end: start + token.raw.length, token }); position = start + token.raw.length;
    }
    if (!objectSnapshot && fixedLabels.length) {
      for (const token of fixedLabels) { let at = 0; for (;;) { const start = text.indexOf(token.raw, at); if (start < 0) break; const end = start + token.raw.length; if (!matched.some(item => start < item.end && end > item.start)) matched.push({ start, end, token }); at = end; } }
      matched.sort((left, right) => left.start - right.start);
    }
    const fragment = document.createDocumentFragment(); position = 0;
    for (const item of matched) {
      fragment.append(document.createTextNode(text.slice(position, item.start)));
      const object = document.createElement('span'); object.className = 'protected-object'; object.contentEditable = 'false';
      object.dataset.raw = item.token.raw; object.dataset.tokenId = item.token.id || '';
      object.dataset.protectedKind = item.token.kind || ''; object.textContent = objectLabel(item.token.raw, item.token.kind,getLanguage()); object.title = item.token.raw;
      object.setAttribute('role', 'img'); object.setAttribute('aria-label', `${uiText('受保护对象',getLanguage())}: ${item.token.raw}`);
      fragment.append(object); position = item.end;
    }
    fragment.append(document.createTextNode(text.slice(position)));
    editor.replaceChildren(fragment); ensureTail(); expectedObjects = objectSignature(); lastSafe = text;
    if (resetHistory) { history = [{ value: text, caret: text.length, objects: intervals() }]; historyIndex = 0; }
  }
  function blocked(event) { event?.preventDefault(); onProtectedAttempt(); }
  function emit(inputType = 'insertText') { editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType })); }
  function insertPlain(text, inputType = 'insertText') {
    if (disabled || wouldTouchObject(inputType)) { onProtectedAttempt(); return; }
    const selection = selectionInfo();
    if (!selection) return;
    const range = selection.range; range.deleteContents(); const node = document.createTextNode(text); range.insertNode(node); range.setStart(node, node.data.length); range.collapse(true);
    getSelection().removeAllRanges(); getSelection().addRange(range); emit(inputType);
  }
  function moveHistory(direction) {
    const next = historyIndex + direction;
    if (next < 0 || next >= history.length || disabled) return;
    historyIndex = next; const snapshot = history[historyIndex]; replaying = true;
    render(snapshot.value,false,snapshot.objects); caretAt(snapshot.caret); emit(direction < 0 ? 'historyUndo' : 'historyRedo'); replaying = false;
  }
  editor.addEventListener('beforeinput', event => {
    if (disabled) { event.preventDefault(); return; }
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') { event.preventDefault(); moveHistory(event.inputType === 'historyUndo' ? -1 : 1); return; }
    if (wouldTouchObject(event.inputType)) { blocked(event); return; }
    if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') { event.preventDefault(); insertPlain('\n', event.inputType); return; }
    if (event.inputType?.startsWith('format')) event.preventDefault();
  });
  editor.addEventListener('input', () => {
    const currentObjects = objectSignature();
    if (JSON.stringify(currentObjects) !== JSON.stringify(expectedObjects)) { const caret = selectionInfo()?.start || 0; render(lastSafe); caretAt(caret); onProtectedAttempt(); return; }
    ensureTail(); const current = value(); lastSafe = current;
    if (!replaying && history[historyIndex]?.value !== current) {
      history = history.slice(0, historyIndex + 1); history.push({ value: current, caret: selectionInfo()?.start ?? current.length, objects: intervals() });
      if (history.length > 150) history.shift(); historyIndex = history.length - 1;
    }
  });
  editor.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key.toLowerCase() === 'z') { event.preventDefault(); moveHistory(event.shiftKey ? 1 : -1); }
    else if (event.key.toLowerCase() === 'y') { event.preventDefault(); moveHistory(1); }
  });
  editor.addEventListener('paste', event => { event.preventDefault(); const text = event.clipboardData?.getData('text/plain'); if (text) insertPlain(text, 'insertFromPaste'); });
  editor.addEventListener('drop', event => { event.preventDefault(); onProtectedAttempt(); });
  editor.addEventListener('copy', event => { const selected = selectionInfo(); if (selected && event.clipboardData) { event.clipboardData.setData('text/plain', flatten(selected.range.cloneContents())); event.preventDefault(); } });
  editor.addEventListener('cut', event => {
    const selected = selectionInfo(); if (!selected || !event.clipboardData) return;
    event.clipboardData.setData('text/plain', flatten(selected.range.cloneContents())); event.preventDefault();
    if (wouldTouchObject('deleteByCut')) onProtectedAttempt(); else insertPlain('', 'deleteByCut');
  });
  Object.defineProperties(editor, {
    value: { get: value, set: next => { const text = String(next ?? ''); if (value() !== text) render(text, true); } },
    selectionStart: { get: () => selectionInfo()?.start ?? value().length },
    selectionEnd: { get: () => selectionInfo()?.end ?? value().length },
    placeholder: { get: () => editor.dataset.placeholder || '', set: next => { editor.dataset.placeholder = String(next || ''); } },
    disabled: { get: () => disabled, set: next => { disabled = Boolean(next); editor.contentEditable = disabled ? 'false' : 'true'; editor.setAttribute('aria-disabled', String(disabled)); } }
  });
  editor.setProtectedTokens = (next, nextSourceTokens = null) => {
    if (!Array.isArray(next) || next.length > 16384 || next.some(token => !token || typeof token.raw !== 'string' || !token.raw)) throw new TypeError('Provide bounded exact protected editor atoms.');
    const text = value(); tokens = next.map(token => ({ id: token.id, raw: token.raw, kind: token.kind })); if (nextSourceTokens) fixedLabels = !structuresInline && mathInline && referencesInline ? sourceLabels(nextSourceTokens) : []; render(text, true);
  };
  editor.acceptCanonicalValue = (expected, canonical) => {
    if(value()!==expected||typeof canonical!=='string'||expected.replaceAll('\r\n','\n')!==canonical.replaceAll('\r\n','\n'))return false;
    if(expected===canonical)return true;
    const selection=selectionInfo(),mapOffset=offset=>{const target=expected.slice(0,offset).replaceAll('\r\n','\n').length;let count=0,at=0;for(;at<canonical.length&&count<target;at++){if(canonical[at]==='\r'&&canonical[at+1]==='\n')continue;count++;}return at;};
    const atoms=intervals().map(atom=>({...atom,start:mapOffset(atom.start),end:mapOffset(atom.end)}));render(canonical,false,atoms);
    if(history[historyIndex]?.value===expected)history[historyIndex]={value:canonical,caret:mapOffset(history[historyIndex].caret),objects:intervals()};
    if(selection&&document.activeElement===editor)caretAt(mapOffset(selection.start));return true;
  };
  editor.focusAt = offset => { editor.focus({preventScroll:true});caretAt(offset); };
  editor.focusRange = (start,end=start) => {
    editor.focus({preventScroll:true});caretAt(start);
    const selection=getSelection(),range=selection.getRangeAt(0).cloneRange();
    caretAt(end);const last=selection.getRangeAt(0);
    range.setEnd(last.endContainer,last.endOffset);selection.removeAllRanges();selection.addRange(range);
  };
  render('', true);
  return editor;
}
