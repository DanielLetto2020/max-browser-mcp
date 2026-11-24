importScripts('dom.js', 'advanced.js', 'features.js', 'v3.js');
let port;
let connectionError='';
let reconnectDelay=500;
let reconnectTimer;
const lastControlledTabs=new Map();
const TAB_SCOPED_TOOLS=new Set([
  'tabs_move','tabs_activate','tabs_update','tabs_duplicate','navigate','reload','history',
  'get_page_text','read_dom','query_elements','javascript','screenshot','click','hover','drag',
  'fill','scroll','select_option','set_checked','wait_for','press_key','insert_text',
  'control_indicator','frames_list','page_snapshot','find_elements','wait_change','wait_page',
  'diagnostics_start','diagnostics_get','diagnostics_stop','upload_files','handle_dialog','resize_window',
  'emulate','route_mock','route_clear','audit_layout','wait','storage_get','storage_set','cookies_list',
  'cookies_set','cookies_delete','clipboard_read','clipboard_write','print_to_pdf','wait_network',
  'get_styles','highlight_element','audit_responsive','performance_metrics','recorder_control',
  'extract_structured','fill_form','page_fetch','session_state','scroll_to_text',
  'accessibility_audit','visual_diff','wait_until_js','network_har_export','replay_request','page_markdown'
]);
const SKIP_INDICATOR_TOOLS=new Set([
  'control_indicator','tabs_close','browser_status','screenshot','handle_dialog','wait','cookies_list',
  'extension_reload','safety_config','windows_list','wait_tab','performance_metrics','get_styles','print_to_pdf',
  'browser_config','bookmarks_and_history','extract_structured','accessibility_audit','page_markdown',
  'network_har_export','_batch_exec'
]);

function clearControlledTab(tabId){
  for(const [cid,tid] of lastControlledTabs.entries()){
    if(tid===tabId)lastControlledTabs.delete(cid);
  }
}

async function resolveTabId(tabId,clientId='default',tabMode=null){
  if(tabId!==undefined&&tabId!==null)return tabId;
  if(tabMode!=='active'){
    const remembered=lastControlledTabs.get(clientId);
    if(remembered!==undefined&&remembered!==null){
      try{const t=await chrome.tabs.get(remembered);if(t?.id!==undefined)return t.id;}catch{lastControlledTabs.delete(clientId);}
    }
  }
  const focused=await chrome.tabs.query({active:true,lastFocusedWindow:true}).catch(()=>[]);
  if(focused.length&&focused[0].id!==undefined)return focused[0].id;
  const active=await chrome.tabs.query({active:true}).catch(()=>[]);
  if(active.length&&active[0].id!==undefined)return active[0].id;
  const any=await chrome.tabs.query({}).catch(()=>[]);
  if(any.length&&any[0].id!==undefined)return any[0].id;
  throw Error('No active tab found; pass tabId or create a tab');
}

function scheduleReconnect(){
  clearTimeout(reconnectTimer);
  reconnectTimer=setTimeout(connect,reconnectDelay);
  reconnectDelay=Math.min(30000,reconnectDelay*2);
}

function splitUtf8Chunks(str,maxChunkBytes=800000){
  const encoder=new TextEncoder();
  const chunks=[];
  let start=0;
  let estChars=Math.max(1024,Math.floor(maxChunkBytes/3));
  while(start<str.length){
    let end=Math.min(str.length,start+estChars);
    while(end<str.length){
      const nextEnd=Math.min(str.length,end+65536);
      if(encoder.encode(str.slice(start,nextEnd)).length<=maxChunkBytes){
        end=nextEnd;
      }else{
        break;
      }
    }
    while(end>start&&encoder.encode(str.slice(start,end)).length>maxChunkBytes){
      end=Math.max(start+1,end-Math.max(1,Math.floor((end-start)/4)));
    }
    if(end<str.length&&end>start){
      const code=str.charCodeAt(end-1);
      if(code>=0xD800&&code<=0xDBFF)end--;
    }
    chunks.push(str.slice(start,end));
    start=end;
  }
  return chunks;
}

function postResponseChunked(current,id,result){
  const encoded=JSON.stringify({id,result});
  const byteLen=new TextEncoder().encode(encoded).length;
  if(byteLen<=900000){
    current.postMessage({id,result});
    return;
  }
  if(byteLen>32*1024*1024)throw Error('Response too large (>32MB); reduce limit or screenshot size');
  const chunks=splitUtf8Chunks(encoded,800000);
  for(let i=0;i<chunks.length;i++){
    current.postMessage({id,__chunk:i,__total:chunks.length,data:chunks[i]});
  }
}

function connect(){
  if(port)return;
  try{
    const current=chrome.runtime.connectNative('local.max.browser');port=current;
    current.onDisconnect.addListener(()=>{
      connectionError=chrome.runtime.lastError?.message||'Native host disconnected';
      if(port===current)port=null;
      chrome.action.setBadgeText({text:'!'}).catch(()=>{});scheduleReconnect();
    });
    current.onMessage.addListener(async m=>{
      try{
        const meta=m.meta||{};
        if(m.clientId&&!meta.clientId)meta.clientId=m.clientId;
        const result=await execute(m.name,m.arguments||{},meta);
        postResponseChunked(current,m.id,result);
        connectionError='';reconnectDelay=500;
        chrome.action.setBadgeText({text:''}).catch(()=>{});
      }catch(e){try{current.postMessage({id:m.id,error:String(e.message||e)});}catch{}}
    });
  }catch(e){port=null;connectionError=e.message;scheduleReconnect();}
}

function forceReconnect(){
  clearTimeout(reconnectTimer);
  reconnectDelay=500;
  if(port){
    const prev=port;
    port=null;
    try{prev.disconnect?.();}catch{}
  }
  connect();
}

function ensureAlarm(){
  const create=()=>chrome.alarms.create('max-browser-reconnect',{periodInMinutes:.5});
  if(typeof chrome.alarms.get==='function'){
    Promise.resolve(chrome.alarms.get('max-browser-reconnect')).then(a=>{if(!a)create();}).catch(create);
  }else{
    create();
  }
}
ensureAlarm();
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='max-browser-reconnect')connect();});
chrome.action.onClicked.addListener(forceReconnect);chrome.runtime.onStartup.addListener(connect);chrome.runtime.onInstalled.addListener(connect);connect();

async function execute(name,a,meta={}){
  const clientId=meta.clientId||'default';
  if(typeof runtimeConfigReady!=='undefined')await runtimeConfigReady;
  if(name==='_release_leases'){
    if(typeof releaseDebuggerLeases==='function')await releaseDebuggerLeases(clientId);
    return {released:true};
  }
  let args=(a.tabId===undefined&&TAB_SCOPED_TOOLS.has(name))?{...a,tabId:await resolveTabId(undefined,clientId,a.tab)}:(a.tab&&a.tabId===undefined?{...a}:a);
  if(typeof checkSafetyPolicy==='function'){
    await checkSafetyPolicy(name,args.tabId,name==='navigate'?args.url:null);
  }
  if(typeof resolveMarkTarget==='function'&&args.tabId!==undefined){
    args=resolveMarkTarget(args.tabId,args);
  }
  const speedMode=typeof runtimeConfig!=='undefined'?runtimeConfig.speedMode:'visual';
  const effectiveMeta=(speedMode==='instant'||speedMode==='fast')&&meta.fast===undefined?{...meta,fast:true}:meta;
  if(speedMode!=='instant'&&args.tabId!==undefined&&!SKIP_INDICATOR_TOOLS.has(name)&&!name.startsWith('diagnostics_')&&!openDialogs?.has?.(args.tabId)){
    await markControlled(args.tabId,true,false,formatToolLabel(name,args),isRestTool(name));
  }
  let result=typeof executeV3==='function'?await executeV3(name,args,effectiveMeta):NOT_HANDLED;
  if(result===NOT_HANDLED&&typeof executeFeatures==='function')result=await executeFeatures(name,args,effectiveMeta);
  if(result===NOT_HANDLED)result=await executeAdvanced(name,args,effectiveMeta);
  let value=result===NOT_HANDLED?await executeLegacy(name,args):result;
  if(name==='tabs_create'||name==='tabs_duplicate'){
    lastControlledTabs.set(clientId,value.id);
    if(speedMode!=='instant')await markControlled(value.id,true,false,formatToolLabel(name,args),true);
  }else if(args.tabId!==undefined&&name!=='control_indicator'&&!name.startsWith('diagnostics_')&&!['tabs_close','browser_status'].includes(name)){
    lastControlledTabs.set(clientId,args.tabId);
  }
  const wantCompact=(args.compact!==undefined?args.compact:(typeof runtimeConfig!=='undefined'&&runtimeConfig.compactResponses))&&!args.verbose;
  if(wantCompact&&typeof compactActionResult==='function'){
    value=compactActionResult(name,value);
  }
  return value;
}

async function inPage(tabId,func,args=[],world='ISOLATED',frameId=0){let r=await chrome.scripting.executeScript({target:{tabId,frameIds:[frameId]},world,func,args});return r[0]?.result;}

async function executeLegacy(name,a){
  if(name==='tabs_list')return (await chrome.tabs.query({})).map(t=>({id:t.id,url:t.url,title:t.title,index:t.index,windowId:t.windowId,active:t.active,pinned:t.pinned,status:t.status,groupId:t.groupId,muted:t.mutedInfo?.muted}));
  if(name==='tabs_create')return await chrome.tabs.create({url:a.url||'about:blank'});
  if(name==='tabs_move'){
    if((a.index===undefined)===(a.offset===undefined))throw Error('Specify exactly one of index or offset');
    const tab=await chrome.tabs.get(a.tabId);
    const options={index:a.index ?? Math.max(0,tab.index+a.offset)};
    if(a.windowId!==undefined)options.windowId=a.windowId;
    const moved=await chrome.tabs.move(a.tabId,options);
    return {...moved,verified:options.index===-1||moved.index===options.index,requestedIndex:options.index};
  }
  if(name==='tabs_reorder'){
    if(!Array.isArray(a.tabIds)||!a.tabIds.length||new Set(a.tabIds).size!==a.tabIds.length)throw Error('Expected unique tabIds');
    const selected=await Promise.all(a.tabIds.map(id=>chrome.tabs.get(id)));
    if(selected.some(t=>t.windowId!==selected[0].windowId))throw Error('Tabs must belong to one window');
    const tabs=(await chrome.tabs.query({windowId:selected[0].windowId})).sort((a,b)=>a.index-b.index);
    const wanted=new Set(a.tabIds);let i=0;
    const order=tabs.map(t=>wanted.has(t.id)?a.tabIds[i++]:t.id);
    const byId=new Map(tabs.map(t=>[t.id,t]));
    // Chrome keeps pinned tabs before unpinned tabs. Validate before any mutation.
    let unpinned=false;
    for(const id of order){if(!byId.get(id).pinned)unpinned=true;else if(unpinned)throw Error('Order would cross pinned-tab boundary');}
    const groups=new Map();
    for(let idx=0;idx<order.length;idx++){const groupId=byId.get(order[idx]).groupId;if(groupId>=0){const positions=groups.get(groupId)||[];positions.push(idx);groups.set(groupId,positions);}}
    for(const positions of groups.values())if(positions.at(-1)-positions[0]+1!==positions.length)throw Error('Order would split a tab group; ungroup those tabs first');
    const sim=tabs.map(t=>t.id);
    for(let index=0;index<order.length;index++){
      const targetId=order[index];
      if(sim[index]===targetId)continue;
      const curIdx=sim.indexOf(targetId);
      if(curIdx>=0){sim.splice(curIdx,1);sim.splice(index,0,targetId);}
      await chrome.tabs.move(targetId,{index});
    }
    const actual=(await chrome.tabs.query({windowId:selected[0].windowId})).sort((a,b)=>a.index-b.index);
    if(actual.some((t,idx)=>t.id!==order[idx]))throw Error('Chrome did not apply the requested order; check tab groups and pinned tabs');
    return actual.map(t=>({id:t.id,index:t.index,title:t.title}));
  }
  if(name==='tabs_activate'){const tab=await chrome.tabs.update(a.tabId,{active:true});await chrome.windows.update(tab.windowId,{focused:true});return tab;}
  if(name==='tabs_update'){const options={};for(const k of ['pinned','muted'])if(a[k]!==undefined)options[k]=a[k];return await chrome.tabs.update(a.tabId,options);}
  if(name==='tabs_close'){clearControlledTab(a.tabId);await chrome.tabs.remove(a.tabId);return {closed:a.tabId};}
  if(name==='tabs_duplicate')return await chrome.tabs.duplicate(a.tabId);
  throw Error('Unknown tool: '+name);
}
