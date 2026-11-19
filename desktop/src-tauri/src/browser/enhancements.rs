use super::evidence::call_cdp;
use super::host::{BrowserHost, find_webview};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

pub fn validate_viewport(width: u32, height: u32) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("INVALID_VIEWPORT".into());
    }
    if width > 8192 || height > 8192 || width.saturating_mul(height) > 16_777_216 {
        return Err("VIEWPORT_BUDGET_EXCEEDED".into());
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserElement {
    pub reference_id: String,
    pub session_id: String,
    pub tab_id: String,
    pub tab_generation: u64,
    pub url: String,
    pub role: String,
    pub selector: String,
    pub xpath: String,
    pub text: String,
    pub rect: BrowserElementRect,
    pub style: BrowserElementStyle,
    pub frame_path: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserElementRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserElementStyle {
    pub display: String,
    pub position: String,
    pub visibility: String,
}

#[tauri::command]
pub async fn browser_set_viewport(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
    tab_id: String,
    width: u32,
    height: u32,
) -> Result<(), String> {
    validate_viewport(width, height)?;
    let webview = find_webview(&app, &state, &session_id, &tab_id)?;
    call_cdp(
        &webview,
        "Emulation.setDeviceMetricsOverride",
        serde_json::json!({
            "width":width,
            "height":height,
            "deviceScaleFactor":0,
            "mobile":false
        }),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn browser_clear_viewport(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
    tab_id: String,
) -> Result<(), String> {
    let webview = find_webview(&app, &state, &session_id, &tab_id)?;
    call_cdp(
        &webview,
        "Emulation.clearDeviceMetricsOverride",
        serde_json::json!({}),
    )
    .await?;
    Ok(())
}

pub fn element_picker_script(
    session_id: &str,
    tab_id: &str,
    tab_generation: u64,
) -> Result<String, String> {
    let session = serde_json::to_string(session_id).map_err(|error| error.to_string())?;
    let tab = serde_json::to_string(tab_id).map_err(|error| error.to_string())?;
    let script = r#"(()=>{
if(window.__aawPicker)return;
window.__aawPicker=true;
const sessionId=__AAW_SESSION_JSON__;
const tabId=__AAW_TAB_JSON__;
const tabGeneration=__AAW_GENERATION__;
const state={status:'active',overlayCount:0,targetSelector:null,targetRect:null,overlayRect:null,labelRect:null,viewport:{width:window.innerWidth,height:window.innerHeight}};
window.__aawPickerState=state;
let target=null;
let root=null;
let box=null;
let label=null;
let resizeObserver=null;
let rafId=0;
let timerId=0;
let targetSelector=null;
let targetRole=null;
const selectorFor=(element)=>{
if(element.id)return '#'+CSS.escape(element.id);
const parts=[];
let current=element;
while(current&&parts.length<8){
let part=current.tagName.toLowerCase();
const parent=current.parentElement;
if(parent){
const siblings=Array.from(parent.children).filter(item=>item.tagName===current.tagName);
if(siblings.length>1)part+=':nth-of-type('+(siblings.indexOf(current)+1)+')';
}
parts.unshift(part);
current=parent;
}
return parts.join(' > ');
};
const xpathFor=(element)=>{
const parts=[];
let current=element;
while(current&&current.nodeType===Node.ELEMENT_NODE){
let index=1;
let sibling=current.previousElementSibling;
while(sibling){if(sibling.tagName===current.tagName)index+=1;sibling=sibling.previousElementSibling;}
const tag=current.tagName.toLowerCase();
const part=current===document.documentElement||current===document.body?tag:tag+'['+index+']';
parts.unshift(part);
if(current===document.documentElement)break;
current=current.parentElement;
}
return '/'+parts.join('/');
};
const roleFor=(element)=>{
const explicit=element.getAttribute('role');
if(explicit)return explicit.slice(0,128);
const tag=element.tagName.toLowerCase();
if(tag==='button'||tag==='select'||tag==='textarea')return tag==='textarea'?'textbox':tag;
if(tag==='a'&&element.hasAttribute('href'))return 'link';
if(tag==='input')return ['button','submit','reset','checkbox','radio'].includes(element.getAttribute('type'))?element.getAttribute('type'):'textbox';
if(/^h[1-6]$/.test(tag))return 'heading';
if(tag==='img')return 'img';
return tag.slice(0,128);
};
const rectOf=rect=>({x:rect.x,y:rect.y,width:rect.width,height:rect.height});
const removeOverlay=()=>{root?.remove();root=null;box=null;label=null;state.overlayCount=0;state.overlayRect=null;state.labelRect=null;};
const ensureOverlay=()=>{
if(root)return;
root=document.createElement('div');
root.setAttribute('data-aaw-picker-overlay','');
root.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
box=document.createElement('div');
box.style.cssText='position:absolute;box-sizing:border-box;border:2px solid #3b82f6;background:rgba(59,130,246,.08);border-radius:2px;pointer-events:none;';
label=document.createElement('div');
label.setAttribute('data-aaw-picker-label','');
label.style.cssText='position:absolute;max-width:320px;padding:3px 6px;border-radius:4px;background:#2563eb;color:white;font:11px sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;';
root.append(box,label);
document.documentElement.append(root);
state.overlayCount=1;
};
const update=()=>{
state.viewport={width:window.innerWidth,height:window.innerHeight};
if(!target||!target.isConnected){target=null;targetSelector=null;targetRole=null;state.targetSelector=null;state.targetRect=null;removeOverlay();return;}
const rect=target.getBoundingClientRect();
if(![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite)||rect.width<=0||rect.height<=0){removeOverlay();return;}
ensureOverlay();
if(targetSelector===null)targetSelector=selectorFor(target);
if(targetRole===null)targetRole=roleFor(target);
state.targetSelector=targetSelector;
state.targetRect=rectOf(rect);
const summary=targetRole+' · '+targetSelector;
if(label.textContent!==summary)label.textContent=summary.slice(0,160);
const labelWidth=Math.min(320,label.offsetWidth||160);
const labelHeight=label.offsetHeight||20;
const left=Math.max(0,Math.min(rect.x,window.innerWidth-labelWidth));
const above=rect.y-labelHeight-4;
const top=above>=0?above:Math.max(0,Math.min(rect.bottom+4,window.innerHeight-labelHeight));
box.style.left=rect.x+'px';
box.style.top=rect.y+'px';
box.style.width=rect.width+'px';
box.style.height=rect.height+'px';
label.style.left=left+'px';
label.style.top=top+'px';
state.overlayRect=rectOf(rect);
state.labelRect={x:left,y:top,width:labelWidth,height:labelHeight};
};
const schedule=()=>{
if(rafId||timerId)return;
const run=()=>{
cancelAnimationFrame(rafId);
clearTimeout(timerId);
rafId=0;
timerId=0;
update();
};
rafId=requestAnimationFrame(run);
timerId=setTimeout(run,32);
};
const hover=event=>{
if(!(event.target instanceof Element))return;
if(target===event.target)return;
target=event.target;
targetSelector=null;
targetRole=null;
resizeObserver?.disconnect();
resizeObserver=new ResizeObserver(schedule);
resizeObserver.observe(target);
schedule();
};
const post=(element)=>{
const rect=element.getBoundingClientRect();
const style=getComputedStyle(element);
window.chrome.webview.postMessage(JSON.stringify({
type:'pick',
referenceId:crypto.randomUUID(),
sessionId,
tabId,
tabGeneration,
url:'',
role:roleFor(element),
selector:selectorFor(element),
xpath:xpathFor(element),
text:(element.innerText||element.getAttribute('aria-label')||'').slice(0,200),
rect:rectOf(rect),
style:{display:style.display.slice(0,128),position:style.position.slice(0,128),visibility:style.visibility.slice(0,128)},
framePath:[]
}));
};
const cleanup=()=>{
cancelAnimationFrame(rafId);
clearTimeout(timerId);
rafId=0;
timerId=0;
document.removeEventListener('pointermove',hover,true);
document.removeEventListener('click',select,true);
document.removeEventListener('keydown',key,true);
document.removeEventListener('scroll',schedule,true);
window.removeEventListener('resize',schedule);
window.removeEventListener('pagehide',cleanup);
window.visualViewport?.removeEventListener('resize',schedule);
window.visualViewport?.removeEventListener('scroll',schedule);
mutationObserver.disconnect();
resizeObserver?.disconnect();
removeOverlay();
cursorStyle.remove();
target=null;
targetSelector=null;
targetRole=null;
state.status='inactive';
state.targetSelector=null;
state.targetRect=null;
state.viewport={width:window.innerWidth,height:window.innerHeight};
window.__aawPicker=false;
};
const select=event=>{
if(!event.isTrusted||!(event.target instanceof Element))return;
event.preventDefault();
event.stopImmediatePropagation();
const selected=event.target;
post(selected);
target=null;
targetSelector=null;
targetRole=null;
resizeObserver?.disconnect();
state.targetSelector=null;
state.targetRect=null;
removeOverlay();
};
const key=event=>{
if(event.key!=='Escape')return;
event.preventDefault();
event.stopImmediatePropagation();
window.chrome.webview.postMessage(JSON.stringify({type:'pick-cancel',sessionId,tabId,tabGeneration}));
cleanup();
};
const mutationObserver=new MutationObserver(schedule);
mutationObserver.observe(document.documentElement,{childList:true,subtree:true});
const cursorStyle=document.createElement('style');
cursorStyle.setAttribute('data-aaw-picker-cursor','');
cursorStyle.textContent='*{cursor:crosshair !important}';
(document.head||document.documentElement).append(cursorStyle);
document.addEventListener('pointermove',hover,true);
document.addEventListener('click',select,true);
document.addEventListener('keydown',key,true);
document.addEventListener('scroll',schedule,true);
window.addEventListener('resize',schedule);
window.addEventListener('pagehide',cleanup);
window.visualViewport?.addEventListener('resize',schedule);
window.visualViewport?.addEventListener('scroll',schedule);
window.__aawCancelPicker=cleanup;
})()"#;
    Ok(script
        .replace("__AAW_SESSION_JSON__", &session)
        .replace("__AAW_TAB_JSON__", &tab)
        .replace("__AAW_GENERATION__", &tab_generation.to_string()))
}

#[tauri::command]
pub fn browser_pick_start(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
    tab_id: String,
) -> Result<(), String> {
    let generation = {
        let runtime = state.runtime.lock().map_err(|_| "BROWSER_LOCK_FAILED")?;
        runtime
            .spaces
            .get(&session_id)
            .and_then(|space| space.tabs.get(&tab_id))
            .map(|tab| tab.generation)
            .ok_or("TAB_NOT_FOUND")?
    };
    let webview = find_webview(&app, &state, &session_id, &tab_id)?;
    let script = element_picker_script(&session_id, &tab_id, generation)?;
    webview.eval(&script).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_pick_cancel(
    app: AppHandle,
    state: State<'_, BrowserHost>,
    session_id: String,
    tab_id: String,
) -> Result<(), String> {
    let webview = find_webview(&app, &state, &session_id, &tab_id)?;
    webview
        .eval("window.__aawCancelPicker?.()")
        .map_err(|error| error.to_string())?;
    app.emit(
        "aaw://browser-pick-cancel",
        serde_json::json!({"sessionId":session_id,"tabId":tab_id}),
    )
    .map_err(|error| error.to_string())
}
