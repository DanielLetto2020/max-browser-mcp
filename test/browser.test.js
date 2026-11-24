const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../extension/background.js'),'utf8');
function setup(initial){
 const tabs=initial.map(t=>({...t,windowId:t.windowId??1,pinned:t.pinned??false}));
 const calls=[];const listeners={};
 const listener=name=>({addListener(fn){(listeners[name]??=[]).push(fn);},removeListener(fn){const arr=listeners[name];if(arr){const i=arr.indexOf(fn);if(i>=0)arr.splice(i,1);}}});
 const chrome={runtime:{getManifest(){return {version:'3.0.0'};},connectNative(){throw Error('offline');},onStartup:listener('startup'),onInstalled:listener('installed')},action:{onClicked:listener('clicked'),async setBadgeText(){}},
 alarms:{create(){},onAlarm:listener('alarm')},storage:{session:{async get(){return {};},async set(){}},local:{async get(){return {};},async set(){}}},permissions:{async getAll(){return {permissions:['bookmarks','history']};}},
 cookies:{async getAll(q){calls.push(['cookies',q]);return [{name:'sid',value:'secret',domain:'.example.com',path:'/',secure:true,httpOnly:true,sameSite:'lax'}];},async set(d){calls.push(['cookiesSet',d]);return d;},async remove(d){calls.push(['cookiesDelete',d]);return d;}},
 bookmarks:{async search(q){return [{id:'b1',title:'API Docs',url:'https://docs.example.com?token=sec',dateAdded:100}];}},
 history:{async search(q){return [{id:'h1',title:'Charts',url:'https://charts.example.com#jwt=abc',visitCount:3,lastVisitTime:200}];}},
 scripting:{async executeScript(){return [{result:{enabled:true}}];}},
 windows:{async update(id,opts){calls.push(['winUpdate',id,opts]);return {id,...opts};}},
 tabs:{onCreated:listener('tabCreated'),onUpdated:listener('updated'),onRemoved:listener('removed'),async sendMessage(tabId,msg){if(msg?.type!=='MAX_PAGE_OP')calls.push(['sendMessage',tabId,msg.type,msg.label??null]);return {ok:true};},async get(id){const t=tabs.find(t=>t.id===id);if(!t)throw Error('Missing tab');return {...t,index:tabs.indexOf(t)};},async query(q){const list=tabs.map((t,index)=>({...t,index}));if(q?.active)return list.filter(t=>t.active);return list;},async move(id,a){calls.push(['move',id,a]);const i=tabs.findIndex(t=>t.id===id);const [t]=tabs.splice(i,1);tabs.splice(a.index===-1?tabs.length:Math.min(a.index,tabs.length),0,t);return {...t,index:tabs.indexOf(t)};}},
 debugger:{onEvent:listener('debugEvent'),onDetach:listener('detach'),async attach(){calls.push(['attach']);},async sendCommand(_,name,params){calls.push([name,params]);throw Error('dispatch failed');},async detach(target){calls.push(['detach']);for(const fn of listeners.detach??[])fn(target,'test');}}};
 const context=vm.createContext({chrome,URL,URLSearchParams,setTimeout:(fn,ms=0)=>ms>=500?0:globalThis.setTimeout(fn,ms),clearTimeout(id){globalThis.clearTimeout(id);},TextEncoder,TextDecoder,btoa,atob,crypto:require('node:crypto').webcrypto});
 context.importScripts=(...files)=>{for(const file of files)vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../extension',file),'utf8'),context);};
 vm.runInContext(source,context);
 return {execute:context.execute,tabs,calls,chrome,listeners,context};
}
test('reorder preserves unrelated slots and page identities',async()=>{
 const s=setup([1,2,3,4,5].map(id=>({id})));
 await s.execute('tabs_reorder',{tabIds:[5,2,4]});
 assert.deepEqual(s.tabs.map(t=>t.id),[1,5,3,2,4]);
});
test('invalid mixed-window and pinned orders do not move anything',async()=>{
 for(const tabs of [[{id:1,windowId:1},{id:2,windowId:2}],[{id:1,pinned:true},{id:2}]]){
  const s=setup(tabs);await assert.rejects(s.execute('tabs_reorder',{tabIds:[2,1]}));assert.equal(s.calls.length,0);
 }
});
test('duplicate or missing IDs rejected before moving',async()=>{
 const s=setup([{id:1},{id:2}]);
 await assert.rejects(s.execute('tabs_reorder',{tabIds:[1,1]}));
 await assert.rejects(s.execute('tabs_reorder',{tabIds:[2,99]}));assert.equal(s.calls.length,0);
});
test('relative move corresponds to Ctrl Shift Page Up',async()=>{
 const s=setup([{id:1},{id:2},{id:3}]);await s.execute('tabs_move',{tabId:3,offset:-1});
 assert.deepEqual(s.tabs.map(t=>t.id),[1,3,2]);
 await assert.rejects(s.execute('tabs_move',{tabId:3,index:0,offset:-1}));
});
test('debugger detached even if keyboard dispatch fails',async()=>{
 const s=setup([{id:1}]);await assert.rejects(s.execute('press_key',{tabId:1,key:'Enter'}));
 assert.equal(s.calls.at(-1)[0],'detach');
});

test('persistent diagnostics shares debugger with screenshot then detaches on stop',async()=>{
 const s=setup([{id:1}]);
 s.chrome.debugger.sendCommand=async(_,name)=>{s.calls.push([name]);if(name==='Page.captureScreenshot')return {data:'abc'};return {};};
 await s.execute('diagnostics_start',{tabId:1});
 assert.equal(s.calls.filter(c=>c[0]==='attach').length,1);
 assert.equal(s.calls.filter(c=>c[0]==='detach').length,0);
 for(const fn of s.listeners.debugEvent)fn({tabId:1},'Network.requestWillBeSent',{requestId:'r',request:{url:'https://example.com',method:'GET'},type:'Document'});
 const logs=await s.execute('diagnostics_get',{tabId:1});assert.equal(logs.network.length,1);
 await s.execute('screenshot',{tabId:1});
 assert.equal(s.calls.filter(c=>c[0]==='attach').length,1);
 assert.equal(s.calls.filter(c=>c[0]==='detach').length,0);
 await s.execute('diagnostics_stop',{tabId:1});
 assert.equal(s.calls.filter(c=>c[0]==='detach').length,1);
});
test('diagnostics failure detaches and marks session inactive',async()=>{
 const s=setup([{id:1}]);await assert.rejects(s.execute('diagnostics_start',{tabId:1}));
 assert.equal(s.calls.at(-1)[0],'detach');
 assert.equal((await s.execute('diagnostics_get',{tabId:1})).attached,false);
});
test('network buffer is bounded and completed requests leave idle tracking',async()=>{
 const s=setup([{id:1}]);s.chrome.debugger.sendCommand=async()=>({});
 await s.execute('diagnostics_start',{tabId:1,maxEntries:10});
 for(let i=0;i<15;i++)for(const fn of s.listeners.debugEvent){fn({tabId:1},'Network.requestWillBeSent',{requestId:String(i),request:{url:'https://example.com/'+i,method:'GET'}});fn({tabId:1},'Network.loadingFinished',{requestId:String(i),encodedDataLength:50});}
 const logs=await s.execute('diagnostics_get',{tabId:1});assert.equal(logs.network.length,10);
 assert.equal(vm.runInContext('diagnosticSessions.get(1).inflight.size',s.context),0);
});
test('concurrent transient debugger commands are serialized',async()=>{
 const s=setup([{id:1}]);s.chrome.debugger.sendCommand=async()=>({data:'abc'});
 await Promise.all([s.execute('screenshot',{tabId:1}),s.execute('screenshot',{tabId:1})]);
 assert.deepEqual(s.calls.map(c=>c[0]),['attach','detach','attach','detach']);
});
test('download wait reports interrupted downloads and does not accept them',async()=>{
 const s=setup([]);s.chrome.downloads={async search(){return [{id:7,state:'interrupted',error:'NETWORK_FAILED'}];}};
 await assert.rejects(s.execute('download_wait',{downloadId:7}),/NETWORK_FAILED/);
});
test('trusted text payload is not mistaken for target visible text',async()=>{
 const s=setup([{id:1}]);const operations=[];
 s.chrome.scripting.executeScript=async options=>{
  const [operation,args]=options.args;operations.push([operation,args]);
  return [{result:operation==='focus'?{verified:true}:{tag:'input',value:operation==='describe'?'hello':''}}];
 };
 s.chrome.debugger.sendCommand=async()=>({});
 const result=await s.execute('insert_text',{tabId:1,selector:'#name',text:'hello'});
 assert.equal(result.sent,true);
 for(const [operation,args] of operations)if(['focus','describe'].includes(operation)){
  assert.equal(args.selector,'#name');assert.equal(args.text,undefined);
 }
});
test('page errors propagate as descriptive tool errors',async()=>{
 const s=setup([{id:1}]);s.chrome.scripting.executeScript=async()=>[{result:{__maxError:'Ambiguous target: 2 matches'}}];
 await assert.rejects(s.execute('click',{tabId:1,role:'button',name:'Duplicate'}),/Ambiguous target/);
});
test('orders that split existing tab groups are rejected without mutation',async()=>{
 const s=setup([{id:1,groupId:7},{id:2,groupId:7},{id:3,groupId:-1}]);
 await assert.rejects(s.execute('tabs_reorder',{tabIds:[3,2]}),/split a tab group/);
 assert.equal(s.calls.length,0);
});
test('press_key parses string combinations and sequences',async()=>{
 const s=setup([{id:1}]);
 const sent=[];
 s.chrome.debugger.sendCommand=async(_,name,params)=>{sent.push([name,params]);return {};};
 await s.execute('press_key',{tabId:1,key:'ctrl+a Backspace'});
 const downs=sent.filter(([n,p])=>n==='Input.dispatchKeyEvent'&&p.type!=='keyUp'&&p.type!=='char');
 assert.equal(downs[0][1].key,'a');
 assert.equal(downs[0][1].modifiers,2);
 assert.equal(downs[1][1].key,'Backspace');
 assert.equal(downs[1][1].modifiers,0);
});
test('diagnostics_get auto-starts, filters, and redacts sensitive URL params',async()=>{
 const s=setup([{id:1,url:'https://app.example.com'}]);
 s.chrome.debugger.sendCommand=async(_,name)=>{s.calls.push([name]);return {};};
 const first=await s.execute('diagnostics_get',{tabId:1});
 assert.equal(first.autoStarted,true);
 assert.equal(first.attached,true);
 for(const fn of s.listeners.debugEvent){
  fn({tabId:1},'Network.requestWillBeSent',{requestId:'1',request:{url:'https://api.example.com/v1?token=secret123&page=2',method:'GET'},type:'XHR'});
  fn({tabId:1},'Runtime.consoleAPICalled',{type:'log',args:[{value:'hello world'}]});
  fn({tabId:1},'Runtime.consoleAPICalled',{type:'error',args:[{value:'boom failed'}]});
 }
 const filtered=await s.execute('diagnostics_get',{tabId:1,onlyErrors:true,pattern:'boom',urlPattern:'/v1'});
 assert.equal(filtered.network.length,0);
 assert.equal(filtered.console.length,1);
 assert.equal(filtered.console[0].text,'boom failed');
});
test('js dialog short-circuits input and handle_dialog clears it',async()=>{
 const s=setup([{id:1}]);
 const sent=[];
 s.chrome.debugger.sendCommand=async(_,name,params)=>{sent.push([name,params]);return {};};
 for(const fn of s.listeners.debugEvent)fn({tabId:1},'Page.javascriptDialogOpening',{type:'confirm',message:'Sure?',url:'https://example.com'});
 const blocked=await s.execute('click',{tabId:1,coordinate:[10,10]});
 assert.equal(blocked.jsDialogOpened,true);
 assert.equal(blocked.dialog.message,'Sure?');
 assert.equal(sent.filter(([n])=>n.startsWith('Input.')).length,0);
 await s.execute('handle_dialog',{tabId:1,accept:true});
 assert.ok(sent.some(([n,p])=>n==='Page.handleJavaScriptDialog'&&p.accept===true));
});
test('coordinateContexts scales coordinates and resolves default active tab',async()=>{
 const s=setup([{id:10,active:false},{id:20,active:true}]);
 const sent=[];
 s.chrome.debugger.sendCommand=async(_,name,params)=>{sent.push([name,params]);return {};};
 vm.runInContext('coordinateContexts.set(20,{viewportWidth:1000,viewportHeight:500,imageWidth:500,imageHeight:250,clipX:0,clipY:0,clipWidth:1000,clipHeight:500})',s.context);
 await s.execute('hover',{coordinate:[100,50]});
 const moved=sent.find(([n])=>n==='Input.dispatchMouseEvent');
 assert.equal(moved[1].x,200);
 assert.equal(moved[1].y,100);
 await s.execute('resize_window',{width:1280,height:720});
 assert.ok(s.calls.some(([n,id,opts])=>n==='winUpdate'&&id===1&&opts.width===1280&&opts.height===720));
});
test('diagnostics_stop clears attached even when Chrome omits onDetach, allowing next screenshot',async()=>{
 const s=setup([{id:1}]);
 s.chrome.debugger.detach=async()=>{s.calls.push(['detach']);};
 s.chrome.debugger.sendCommand=async(_,name)=>{s.calls.push([name]);if(name==='Page.captureScreenshot')return {data:'abc'};return {};};
 await s.execute('diagnostics_start',{tabId:1});
 await s.execute('diagnostics_stop',{tabId:1});
 assert.equal(vm.runInContext('diagnosticSessions.get(1).attached',s.context),false);
 const shot=await s.execute('screenshot',{tabId:1});
 assert.equal(shot.image,'abc');
 assert.equal(s.calls.filter(c=>c[0]==='attach').length,2);
});
test('javascript falls back to CDP Runtime.evaluate when strict CSP blocks unsafe-eval',async()=>{
 const s=setup([{id:1}]);
 s.chrome.scripting.executeScript=async()=>[{result:{ok:false,error:"Evaluating a string as JavaScript violates Content Security Policy ('unsafe-eval')"}}];
 s.chrome.debugger.sendCommand=async(_,name,params)=>{
  s.calls.push([name,params]);
  if(name==='Runtime.evaluate')return {result:{value:42}};
  return {};
 };
 const res=await s.execute('javascript',{tabId:1,code:'40+2'});
 assert.equal(res,42);
 assert.ok(s.calls.some(([n,p])=>n==='Runtime.evaluate'&&p.awaitPromise===true&&p.returnByValue===true));
});
test('emulate keeps debugger attached until reset and passes CDP overrides',async()=>{
 const s=setup([{id:1}]);
 s.chrome.debugger.sendCommand=async(_,name,params)=>{s.calls.push([name,params]);return {};};
 await s.execute('emulate',{tabId:1,width:375,height:812,mobile:true,colorScheme:'dark',offline:true});
 assert.equal(s.calls.filter(c=>c[0]==='attach').length,1);
 assert.equal(s.calls.filter(c=>c[0]==='detach').length,0);
 assert.ok(s.calls.some(([n,p])=>n==='Emulation.setDeviceMetricsOverride'&&p.width===375&&p.mobile===true));
 assert.ok(s.calls.some(([n,p])=>n==='Emulation.setEmulatedMedia'&&p.features[0].value==='dark'));
 await s.execute('emulate',{tabId:1,reset:true});
 assert.equal(s.calls.filter(c=>c[0]==='detach').length,1);
});
test('route_mock intercepts matching Fetch.requestPaused and continues others',async()=>{
 const s=setup([{id:1}]);
 s.chrome.debugger.sendCommand=async(_,name,params)=>{s.calls.push([name,params]);return {};};
 await s.execute('route_mock',{tabId:1,urlPattern:'*/api/orders*',status:500,body:'{"ok":false}'});
 for(const fn of s.listeners.debugEvent){
  fn({tabId:1},'Fetch.requestPaused',{requestId:'r1',request:{url:'https://app.test/api/orders/1',method:'GET'}});
  fn({tabId:1},'Fetch.requestPaused',{requestId:'r2',request:{url:'https://app.test/static/app.js',method:'GET'}});
 }
 await new Promise(r=>setTimeout(r,20));
 assert.ok(s.calls.some(([n,p])=>n==='Fetch.fulfillRequest'&&p.requestId==='r1'&&p.responseCode===500));
 assert.ok(s.calls.some(([n,p])=>n==='Fetch.continueRequest'&&p.requestId==='r2'));
 await s.execute('route_clear',{tabId:1});
 assert.ok(s.calls.some(([n])=>n==='Fetch.disable'));
});
test('page_snapshot diff returns only added and removed lines',async()=>{
 const s=setup([{id:1,url:'https://example.com'}]);
 let step=0;
 s.chrome.scripting.executeScript=async()=>{
  step++;
  if(step===1)return [{result:{title:'T',url:'https://example.com',readyState:'complete',viewport:{width:1000,height:800},total:2,tree:'button "Save" [r-e1]\nlink "Home" [r-e2]'}}];
  return [{result:{title:'T',url:'https://example.com',readyState:'complete',viewport:{width:1000,height:800},total:2,tree:'button "Save" [r-e9]\nstatus "Saved!" [r-e10]'}}];
 };
 await s.execute('page_snapshot',{tabId:1});
 const delta=await s.execute('page_snapshot',{tabId:1,diff:true});
 assert.equal(delta.diff,true);
 assert.equal(delta.addedCount,1);
 assert.equal(delta.removedCount,1);
 assert.equal(delta.unchangedCount,1);
 assert.ok(delta.tree.includes('- link "Home"'));
 assert.ok(delta.tree.includes('+ status "Saved!"'));
});
test('cookies_list redacts cookie values by default and honors redact=false',async()=>{
 const s=setup([{id:1,url:'https://example.com'}]);
 const redacted=await s.execute('cookies_list',{tabId:1});
 assert.equal(redacted[0].value,'[redacted]');
 const raw=await s.execute('cookies_list',{tabId:1,redact:false});
 assert.equal(raw[0].value,'secret');
});
test('diagnostics captureBodies records redacted request postData and response body',async()=>{
 const s=setup([{id:1,url:'https://app.test'}]);
 s.chrome.debugger.sendCommand=async(_,name)=>{
  if(name==='Network.getResponseBody')return {body:'{"token":"abc","ok":true}',base64Encoded:false};
  return {};
 };
 await s.execute('diagnostics_start',{tabId:1,captureBodies:true});
 for(const fn of s.listeners.debugEvent){
  fn({tabId:1},'Network.requestWillBeSent',{requestId:'req1',request:{url:'https://app.test/api',method:'POST',postData:'{"password":"123"}'},type:'Fetch'});
  fn({tabId:1},'Network.responseReceived',{requestId:'req1',response:{url:'https://app.test/api',status:200,mimeType:'application/json'},type:'Fetch'});
  fn({tabId:1},'Network.loadingFinished',{requestId:'req1',encodedDataLength:25});
 }
 await new Promise(r=>setTimeout(r,20));
 const logs=await s.execute('diagnostics_get',{tabId:1});
 const req=logs.network.find(e=>e.event==='request');
 const resp=logs.network.find(e=>e.event==='response');
 assert.ok(req.postData.includes('"[redacted]"'));
 assert.ok(!req.postData.includes('"123"'));
 assert.ok(resp.body.includes('"[redacted]"'));
 assert.ok(!resp.body.includes('"abc"'));
});
test('screenshot annotate draws and cleans up marks and includes annotations metadata',async()=>{
 const s=setup([{id:1}]);
 const ops=[];
 s.chrome.scripting.executeScript=async opts=>{
  const [op]=opts.args||[];
  ops.push(op);
  if(op==='annotate_marks')return [{result:[{mark:1,ref:'e1',role:'button',name:'Save'}]}];
  if(op==='page_metrics')return [{result:{width:1000,height:800,devicePixelRatio:1}}];
  return [{result:{cleared:true}}];
 };
 s.chrome.debugger.sendCommand=async(_,name)=>name==='Page.captureScreenshot'?{data:'abc'}:{};
 const shot=await s.execute('screenshot',{tabId:1,annotate:true});
 assert.equal(shot.annotations.length,1);
 assert.ok(ops.includes('annotate_marks'));
 assert.ok(ops.includes('clear_marks'));
});
test('cross-origin iframe navigation does not clear main logs or hang networkIdle',async()=>{
 const s=setup([{id:1,url:'https://app.test'}]);
 s.chrome.debugger.sendCommand=async(_,name)=>{
  if(name==='Page.getFrameTree')return {frameTree:{frame:{id:'main-f'}}};
  return {};
 };
 await s.execute('diagnostics_start',{tabId:1});
 for(const fn of s.listeners.debugEvent){
  fn({tabId:1},'Network.requestWillBeSent',{requestId:'main1',frameId:'main-f',documentURL:'https://app.test',request:{url:'https://app.test/data.json',method:'GET'},type:'Fetch'});
  fn({tabId:1},'Network.loadingFinished',{requestId:'main1',encodedDataLength:10});
  fn({tabId:1},'Network.requestWillBeSent',{requestId:'sub-loader',frameId:'sub-f',documentURL:'https://sub.other/frame.html',request:{url:'https://sub.other/frame.html',method:'GET'},type:'Document'});
  fn({tabId:1},'Network.responseReceived',{requestId:'sub-loader',frameId:'sub-f',response:{url:'https://sub.other/frame.html',status:200,mimeType:'text/html'},type:'Document'});
 }
 const logs=await s.execute('diagnostics_get',{tabId:1});
 assert.ok(logs.network.some(e=>e.requestId==='main1'));
 assert.equal(s.context.diagnosticSessions?.get?.(1)?.inflight?.size??0,0);
 const idle=await s.execute('wait_page',{tabId:1,state:'networkIdle',idleMs:0,timeoutMs:500});
 assert.equal(idle.verified,true);
});
test('javascript CSP fallback resolves Promise via awaitPromise without replMode',async()=>{
 const s=setup([{id:1,url:'https://csp.test'}]);
 s.chrome.scripting.executeScript=async()=>[{result:{ok:false,error:"EvalError: Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in Content Security Policy"}}];
 const cdp=[];
 s.chrome.debugger.sendCommand=async(_,name,params)=>{
  cdp.push([name,params]);
  if(name==='Runtime.evaluate')return {result:{type:'object',subtype:'promise',objectId:'p1'}};
  if(name==='Runtime.awaitPromise')return {result:{type:'object',value:{asyncOk:true}}};
  return {};
 };
 const res=await s.execute('javascript',{tabId:1,code:'Promise.resolve({asyncOk:true})'});
 assert.deepEqual(res,{asyncOk:true});
 const ev=cdp.find(c=>c[0]==='Runtime.evaluate')[1];
 assert.equal(ev.replMode,undefined);
});

// --- v1.5.0 regression & optimization tests ---

test('screenshot region updates coordinateContexts and clears on resize/emulate/nav',async()=>{
 const s=setup([{id:1,url:'https://example.com'}]);
 s.chrome.scripting.executeScript=async opts=>{
  const [op]=opts.args||[];
  if(op==='page_metrics')return [{result:{width:1000,height:800,devicePixelRatio:1}}];
  return [{result:{enabled:true}}];
 };
 s.chrome.debugger.sendCommand=async(_,name)=>{
  if(name==='Page.getLayoutMetrics')return {cssVisualViewport:{pageX:0,pageY:0,clientWidth:1000,clientHeight:800}};
  if(name==='Page.captureScreenshot')return {data:'abc'};
  return {};
 };
 await s.execute('screenshot',{tabId:1,region:[100,200,500,600]});
 const ctx=vm.runInContext('coordinateContexts.get(1)',s.context);
 assert.equal(ctx.clipX,100);
 assert.equal(ctx.clipY,200);
 assert.equal(ctx.clipWidth,400);
 assert.equal(ctx.clipHeight,400);
 await s.execute('resize_window',{tabId:1,width:1200,height:900});
 assert.equal(vm.runInContext('coordinateContexts.get(1)',s.context),undefined);
 await s.execute('screenshot',{tabId:1,region:[10,20,110,120]});
 assert.ok(vm.runInContext('coordinateContexts.get(1)',s.context));
 for(const fn of s.listeners.updated)fn(1,{status:'loading'});
 assert.equal(vm.runInContext('coordinateContexts.get(1)',s.context),undefined);
});

test('press_key preserves Shift uppercase, avoids char on Alt, and tolerates missing post-describe',async()=>{
 const s=setup([{id:1}]);
 const sent=[];
 let describeCalls=0;
 s.chrome.scripting.executeScript=async opts=>{
  const [op]=opts.args||[];
  if(op==='focus')return [{result:{verified:true}}];
  if(op==='describe'){
   describeCalls++;
   if(describeCalls===2)return [{result:{__maxError:'Element not found'}}];
   return [{result:{tag:'input',rect:{x:10,y:10,width:50,height:20}}}];
  }
  return [{result:{enabled:true}}];
 };
 s.chrome.debugger.sendCommand=async(_,name,params)=>{sent.push([name,params]);return {};};
 const res=await s.execute('press_key',{tabId:1,selector:'#in',key:'Shift+A alt+x'});
 assert.equal(res.sent,true);
 assert.equal(res.after,null);
 const downs=sent.filter(([n,p])=>n==='Input.dispatchKeyEvent'&&p.type!=='keyUp');
 assert.equal(downs[0][1].key,'A');
 assert.equal(downs[0][1].text,'A');
 assert.equal(downs[0][1].modifiers,8);
 assert.equal(downs.filter(([,p])=>p.type==='char').length,0);
 assert.equal(downs[1][1].key,'x');
 assert.equal(downs[1][1].type,'rawKeyDown');
});

test('diagnostics_get onlyErrors filters network 4xx/5xx/failed with glob urlPattern and failed URL',async()=>{
 const s=setup([{id:1,url:'https://app.example.com'}]);
 s.chrome.debugger.sendCommand=async()=>({});
 await s.execute('diagnostics_start',{tabId:1});
 for(const fn of s.listeners.debugEvent){
  fn({tabId:1},'Network.requestWillBeSent',{requestId:'ok1',request:{url:'https://api.example.com/v1/ok',method:'GET'},type:'Fetch'});
  fn({tabId:1},'Network.responseReceived',{requestId:'ok1',response:{url:'https://api.example.com/v1/ok',status:200,mimeType:'application/json'},type:'Fetch'});
  fn({tabId:1},'Network.requestWillBeSent',{requestId:'err1',request:{url:'https://api.example.com/v1/fail?token=xyz',method:'POST'},type:'Fetch'});
  fn({tabId:1},'Network.loadingFailed',{requestId:'err1',errorText:'net::ERR_FAILED'});
  fn({tabId:1},'Network.requestWillBeSent',{requestId:'err2',request:{url:'https://api.example.com/v1/bad',method:'GET'},type:'Fetch'});
  fn({tabId:1},'Network.responseReceived',{requestId:'err2',response:{url:'https://api.example.com/v1/bad',status:500,mimeType:'application/json'},type:'Fetch'});
 }
 const res=await s.execute('diagnostics_get',{tabId:1,onlyErrors:true,urlPattern:'*/v1/*'});
 assert.equal(res.network.length,2);
 assert.ok(res.network.some(e=>e.event==='failed'&&e.url.includes('token=REDACTED')));
 assert.ok(res.network.some(e=>e.event==='response'&&e.status===500));
});

test('page_snapshot diff scopes cache by filter/selector/depth',async()=>{
 const s=setup([{id:1,url:'https://example.com'}]);
 s.chrome.scripting.executeScript=async opts=>{
  const [,args]=opts.args;
  const tree=args.filter==='interactive'?'button "Save" [r-e1]':'heading "Title" [r-e1]\nbutton "Save" [r-e2]';
  return [{result:{title:'T',url:'https://example.com',readyState:'complete',viewport:{width:1000,height:800},total:2,tree}}];
 };
 await s.execute('page_snapshot',{tabId:1,filter:'all'});
 const interactive=await s.execute('page_snapshot',{tabId:1,filter:'interactive',diff:true});
 assert.equal(interactive.diff,false);
 assert.ok(interactive.note.includes('No previous snapshot'));
});

test('handle_dialog skips markControlled and Page.enable for frozen dialog speed',async()=>{
 const s=setup([{id:1}]);
 s.chrome.debugger.sendCommand=async(_,name)=>{s.calls.push([name]);return {};};
 for(const fn of s.listeners.debugEvent)fn({tabId:1},'Page.javascriptDialogOpening',{type:'alert',message:'Hi',url:'https://example.com'});
 await s.execute('handle_dialog',{tabId:1,accept:true});
 assert.equal(s.calls.filter(c=>c[0]==='sendMessage').length,0);
 assert.equal(s.calls.filter(c=>c[0]==='Page.enable').length,0);
 assert.ok(s.calls.some(c=>c[0]==='Page.handleJavaScriptDialog'));
});

test('hover performs single debugger attach/detach and batch lease reuses debugger',async()=>{
 const s=setup([{id:1}]);
 s.chrome.scripting.executeScript=async opts=>{
  const [op]=opts.args||[];
  if(op==='wait_actionable')return [{result:{visible:true,disabled:false,clickPoint:{x:50,y:60},rect:{x:40,y:50,width:20,height:20}}}];
  return [{result:{enabled:true}}];
 };
 s.chrome.debugger.sendCommand=async(_,name)=>{s.calls.push([name]);return {};};
 await s.execute('hover',{tabId:1,selector:'#btn'});
 assert.equal(s.calls.filter(c=>c[0]==='attach').length,1);
 assert.equal(s.calls.filter(c=>c[0]==='detach').length,1);

 s.calls.length=0;
 await s.execute('click',{tabId:1,selector:'#btn'},{leaseMs:5000,clientId:'c1',fast:true});
 await s.execute('press_key',{tabId:1,key:'Enter'},{leaseMs:5000,clientId:'c1',fast:true});
 assert.equal(s.calls.filter(c=>c[0]==='attach').length,1);
 assert.equal(s.calls.filter(c=>c[0]==='detach').length,0);
 await s.execute('_release_leases',{},{clientId:'c1'});
 assert.equal(s.calls.filter(c=>c[0]==='detach').length,1);
});

test('per-client lastControlledTabId isolates concurrent MCP clients',async()=>{
 const s=setup([{id:10,active:true},{id:20,active:false}]);
 s.chrome.scripting.executeScript=async()=>[{result:{title:'T',url:'https://example.com',readyState:'complete',source:'body',truncated:false,text:'ok'}}];
 await s.execute('get_page_text',{tabId:10},{clientId:'clientA'});
 await s.execute('get_page_text',{tabId:20},{clientId:'clientB'});
 assert.equal(vm.runInContext("lastControlledTabs.get('clientA')",s.context),10);
 assert.equal(vm.runInContext("lastControlledTabs.get('clientB')",s.context),20);
});

test('redactUrl redacts hash fragments and redactBody redacts form and JWT secrets',async()=>{
 const s=setup([{id:1}]);
 const redUrl=s.context.redactUrl('https://app.test/cb#access_token=tok123&state=ok');
 assert.ok(!redUrl.includes('tok123'));
 assert.ok(redUrl.includes('access_token=REDACTED'));
 const redForm=s.context.redactBody('user=max&password=mysecret&jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig123');
 assert.ok(!redForm.includes('mysecret'));
 assert.ok(!redForm.includes('sig123'));
 assert.ok(redForm.includes('[redacted]'));
});

test('route_mock passes specific URL patterns to Fetch.enable and merges emulate params',async()=>{
 const s=setup([{id:1}]);
 s.chrome.debugger.sendCommand=async(_,name,params)=>{s.calls.push([name,params]);return {};};
 await s.execute('route_mock',{tabId:1,urlPattern:'https://api.test/orders*',body:'{}'});
 const fetchEnable=s.calls.find(([n])=>n==='Fetch.enable');
 assert.deepEqual(JSON.parse(JSON.stringify(fetchEnable[1].patterns)),[{urlPattern:'https://api.test/orders*',requestStage:'Request'}]);
 await s.execute('emulate',{tabId:1,userAgent:'MobileBot/1.0',locale:'ru-RU',timezone:'Europe/Moscow'});
 await s.execute('emulate',{tabId:1,colorScheme:'dark'});
 assert.ok(s.calls.some(([n,p])=>n==='Emulation.setUserAgentOverride'&&p.userAgent==='MobileBot/1.0'));
 assert.ok(s.calls.some(([n,p])=>n==='Emulation.setLocaleOverride'&&p.locale==='ru-RU'));
 assert.ok(s.calls.some(([n,p])=>n==='Emulation.setTimezoneOverride'&&p.timezoneId==='Europe/Moscow'));
 const status=await s.execute('browser_status',{});
 assert.equal(status.version,'3.0.0');
});

test('downloads_list queries once and postResponseChunked splits oversized payloads',async()=>{
 const s=setup([{id:1}]);
 let searches=0;
 s.chrome.downloads={async search(){searches++;return [{id:1,url:'https://a.test/1',filename:'1.txt',state:'complete'}];}};
 const list=await s.execute('downloads_list',{});
 assert.equal(searches,1);
 assert.equal(list.length,1);

 const posted=[];
 s.context.postResponseChunked({postMessage(m){posted.push(m);}},'req1',{big:'Ю'.repeat(500000)});
 assert.ok(posted.length>=2);
 assert.equal(posted[0].__chunk,0);
 assert.equal(posted[0].__total,posted.length);
 const joined=JSON.parse(posted.map(p=>p.data).join(''));
 assert.equal(joined.result.big.length,500000);
});

// --- v2.0.0 feature tests ---

test('screenshot annotate stores Set-of-Mark refs usable via click({ mark })',async()=>{
 const s=setup([{id:1,url:'https://example.com'}]);
 const ops=[];
 s.chrome.scripting.executeScript=async opts=>{
  const [op,args]=opts.args||[];
  ops.push([op,args]);
  if(op==='annotate_marks')return [{result:[{mark:1,ref:'ref-m1',role:'button',name:'Buy'}]}];
  if(op==='page_metrics')return [{result:{width:1000,height:800,devicePixelRatio:1}}];
  if(op==='wait_actionable')return [{result:{visible:true,disabled:false,clickPoint:{x:120,y:80},rect:{x:100,y:60,width:40,height:40}}}];
  return [{result:{cleared:true}}];
 };
 s.chrome.debugger.sendCommand=async(_,name)=>name==='Page.captureScreenshot'?{data:'abc'}:{};
 await s.execute('screenshot',{tabId:1,annotate:true});
 await s.execute('click',{tabId:1,mark:1});
 const waitCall=ops.find(([op])=>op==='wait_actionable');
 assert.equal(waitCall[1].ref,'ref-m1');
 assert.equal(waitCall[1].mark,undefined);
});

test('cookies_set and cookies_delete invoke chrome.cookies API',async()=>{
 const s=setup([{id:1,url:'https://app.example.com/path'}]);
 s.chrome.cookies.set=async d=>{s.calls.push(['cookies.set',d]);return {...d};};
 s.chrome.cookies.remove=async d=>{s.calls.push(['cookies.remove',d]);return d;};
 const setRes=await s.execute('cookies_set',{tabId:1,name:'ab_group',value:'B',httpOnly:true});
 assert.equal(setRes.set,true);
 assert.equal(setRes.cookie.value,'[redacted]');
 const delRes=await s.execute('cookies_delete',{tabId:1,name:'ab_group'});
 assert.equal(delRes.deleted,true);
});

test('route_mock supports failReason and response-stage patchJson',async()=>{
 const s=setup([{id:1}]);
 s.chrome.debugger.sendCommand=async(_,name,params)=>{
  s.calls.push([name,params]);
  if(name==='Fetch.getResponseBody')return {body:Buffer.from('{"a":1,"b":2}').toString('base64'),base64Encoded:true};
  return {};
 };
 await s.execute('route_mock',{tabId:1,urlPattern:'*/fail*',failReason:'TimedOut'});
 await s.execute('route_mock',{tabId:1,urlPattern:'*/patch*',stage:'response',patchJson:{b:99,c:3}});
 for(const fn of s.listeners.debugEvent){
  fn({tabId:1},'Fetch.requestPaused',{requestId:'f1',request:{url:'https://app.test/fail/1',method:'GET'}});
  fn({tabId:1},'Fetch.requestPaused',{requestId:'p1',responseStatusCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],request:{url:'https://app.test/patch/1',method:'GET'}});
 }
 await new Promise(r=>setTimeout(r,20));
 assert.ok(s.calls.some(([n,p])=>n==='Fetch.failRequest'&&p.requestId==='f1'&&p.errorReason==='TimedOut'));
 const fulfilled=s.calls.find(([n,p])=>n==='Fetch.fulfillRequest'&&p.requestId==='p1');
 assert.ok(fulfilled);
 assert.deepEqual(JSON.parse(Buffer.from(fulfilled[1].body,'base64').toString('utf8')),{a:1,b:99,c:3});
});

test('diagnostics records WebSocket frames and SSE events',async()=>{
 const s=setup([{id:1,url:'https://chat.test'}]);
 s.chrome.debugger.sendCommand=async()=>({});
 await s.execute('diagnostics_start',{tabId:1});
 for(const fn of s.listeners.debugEvent){
  fn({tabId:1},'Network.webSocketCreated',{requestId:'ws1',url:'wss://chat.test/ws?token=wssecret'});
  fn({tabId:1},'Network.webSocketFrameReceived',{requestId:'ws1',response:{payloadData:'{"msg":"hi","jwt":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"}'}});
  fn({tabId:1},'Network.eventSourceMessageReceived',{requestId:'sse1',eventName:'chunk',eventId:'1',data:'hello stream'});
 }
 const logs=await s.execute('diagnostics_get',{tabId:1});
 assert.equal(logs.websockets.length,3);
 assert.ok(logs.websockets[0].url.includes('token=REDACTED'));
 assert.ok(!logs.websockets[1].payload.includes('.sig'));
 assert.equal(logs.websockets[2].event,'sse');
});

test('wait_network resolves when matching response arrives',async()=>{
 const s=setup([{id:1,url:'https://app.test'}]);
 s.chrome.debugger.sendCommand=async()=>({});
 const waitProm=s.execute('wait_network',{tabId:1,urlPattern:'*/orders*',status:201,timeoutMs:1000});
 await new Promise(r=>setTimeout(r,20));
 for(const fn of s.listeners.debugEvent){
  fn({tabId:1},'Network.requestWillBeSent',{requestId:'ord1',request:{url:'https://app.test/api/orders',method:'POST'},type:'Fetch'});
  fn({tabId:1},'Network.responseReceived',{requestId:'ord1',response:{url:'https://app.test/api/orders',status:201,mimeType:'application/json'},type:'Fetch'});
 }
 const matched=await waitProm;
 assert.equal(matched.matched,true);
 assert.equal(matched.status,201);
 assert.equal(matched.method,'POST');
});

test('onDialog proactively handles alert/confirm opened by click',async()=>{
 const s=setup([{id:1}]);
 s.chrome.scripting.executeScript=async()=>[{result:{visible:true,disabled:false,clickPoint:{x:20,y:20},rect:{x:10,y:10,width:20,height:20}}}];
 s.chrome.debugger.sendCommand=async(_,name,params)=>{
  s.calls.push([name,params]);
  if(name==='Input.dispatchMouseEvent'&&params.type==='mouseReleased'){
   for(const fn of s.listeners.debugEvent)fn({tabId:1},'Page.javascriptDialogOpening',{type:'confirm',message:'Proceed?',url:'https://example.com'});
  }
  return {};
 };
 const res=await s.execute('click',{tabId:1,selector:'#del',onDialog:'accept',dialogPromptText:'yes'});
 assert.ok(res.autoHandledDialog);
 assert.equal(res.autoHandledDialog.action,'accept');
 assert.ok(s.calls.some(([n,p])=>n==='Page.handleJavaScriptDialog'&&p.accept===true));
});

test('safetyConfig enforces pause, readOnly, and blockedDomains',async()=>{
 const s=setup([{id:1,url:'https://bank.example.com/account'}]);
 await s.context.updateSafetyConfig({blockedDomains:['example.com']});
 await assert.rejects(s.execute('click',{tabId:1,coordinate:[5,5]}),/blocked by Max Browser safety policy/);
 await s.context.updateSafetyConfig({blockedDomains:[],readOnly:true});
 await assert.rejects(s.execute('click',{tabId:1,coordinate:[5,5]}),/Read-Only/);
 await s.execute('tabs_list',{});
 await s.context.updateSafetyConfig({readOnly:false,paused:true});
 await assert.rejects(s.execute('tabs_list',{}),/paused/);
 assert.equal((await s.execute('safety_config',{})).paused,true);
});

test('audit_responsive, performance_metrics, print_to_pdf, windows_list, wait_tab, and screenshot tiles work',async()=>{
 const s=setup([{id:1,url:'https://app.test'}]);
 s.chrome.windows.getAll=async()=>[{id:1,focused:true,state:'normal',type:'normal',width:1280,height:800,tabs:[{id:1,url:'https://app.test'}]}];
 s.chrome.scripting.executeScript=async opts=>{
  const [op]=opts.args||[];
  if(op==='audit_layout')return [{result:{hasHorizontalOverflow:false,scrollWidth:1000,counts:{overflow:0,brokenImages:0,clippedText:0,overlappingInteractive:0,smallTouchTargets:0},issues:{}}}];
  if(op==='perf_vitals')return [{result:{domNodes:120,vitals:{fcpMs:210,cls:0.01}}}];
  if(op==='page_metrics')return [{result:{width:1000,height:800,devicePixelRatio:1,scrollX:0,scrollY:0}}];
  if(op==='scroll')return [{result:{before:{x:0,y:0},after:{x:0,y:720}}}];
  return [{result:{enabled:true}}];
 };
 s.chrome.debugger.sendCommand=async(_,name)=>{
  if(name==='Page.printToPDF')return {data:'JVBERi0='};
  if(name==='Performance.getMetrics')return {metrics:[{name:'JSHeapUsedSize',value:10485760},{name:'Nodes',value:120}]};
  if(name==='Page.getLayoutMetrics')return {cssContentSize:{width:1000,height:1500},cssVisualViewport:{clientHeight:800}};
  if(name==='Page.captureScreenshot')return {data:'abc'};
  return {};
 };
 const resp=await s.execute('audit_responsive',{tabId:1,widths:[375,1280]});
 assert.equal(resp.breakpoints.length,2);
 const perf=await s.execute('performance_metrics',{tabId:1});
 assert.equal(perf.cdp.jsHeapUsedMB,10);
 const pdf=await s.execute('print_to_pdf',{tabId:1});
 assert.equal(pdf.data,'JVBERi0=');
 const wins=await s.execute('windows_list',{populate:true});
 assert.equal(wins[0].tabs.length,1);
 const tiled=await s.execute('screenshot',{tabId:1,tiles:true,maxTiles:3});
 assert.equal(tiled.count,2);

 const waitTabProm=s.execute('wait_tab',{urlIncludes:'popup.html',timeoutMs:1000});
 await new Promise(r=>setTimeout(r,15));
 for(const fn of s.listeners.tabCreated)fn({id:99,pendingUrl:'https://app.test/popup.html',openerTabId:1});
 const foundTab=await waitTabProm;
 assert.equal(foundTab.tab.id,99);
});

test('computeSnapshotDiff includes @@ parent context header for nested additions',async()=>{
 const s=setup([{id:1,url:'https://example.com'}]);
 let step=0;
 s.chrome.scripting.executeScript=async()=>{
  step++;
  if(step===1)return [{result:{title:'T',url:'https://example.com',readyState:'complete',viewport:{width:1000,height:800},total:2,tree:'dialog "Cart" [r1]\n button "Close" [r2]'}}];
  return [{result:{title:'T',url:'https://example.com',readyState:'complete',viewport:{width:1000,height:800},total:3,tree:'dialog "Cart" [r1]\n button "Close" [r2]\n button "Checkout" [r3]'}}];
 };
 await s.execute('page_snapshot',{tabId:1});
 const delta=await s.execute('page_snapshot',{tabId:1,diff:true});
 assert.ok(delta.tree.includes('@@ in dialog "Cart"'));
 assert.ok(delta.tree.includes('+  button "Checkout"'));
});

test('recorder_control and extension_reload work via messages and API',async()=>{
 const s=setup([{id:1,url:'https://app.test'}]);
 const st1=await s.execute('recorder_control',{action:'start',tabId:1});
 assert.equal(st1.active,true);
 for(const fn of s.listeners.runtimeMsg||[]){}
 vm.runInContext("recorderState.steps.push({name:'click',arguments:{selector:'#go'}})",s.context);
 const st2=await s.execute('recorder_control',{action:'stop',tabId:1});
 assert.equal(st2.count,1);
 assert.equal(st2.batch.actions[0].name,'click');
 let reloaded=false;
 s.chrome.runtime.reload=()=>{reloaded=true;};
 const r=await s.execute('extension_reload',{});
 assert.equal(r.reloading,true);
 await new Promise(res=>setTimeout(res,160));
 assert.equal(reloaded,true);
});

// --- v3.0.0 tests ---
test('fast-dom sendMessage bypasses executeScript and browser_config controls speed, compact & idle lease',async()=>{
 const s=setup([{id:1,url:'https://app.test'}]);
 let scriptExecs=0;
 s.chrome.scripting.executeScript=async()=>{scriptExecs++;return [{result:{enabled:true}}];};
 s.chrome.tabs.sendMessage=async(tabId,msg)=>{
  s.calls.push(['sendMessage',tabId,msg.type,msg.operation??null]);
  if(msg.type==='MAX_PAGE_OP'){
   return {ok:true,result:{clicked:true,trusted:false,before:{ref:'abc-1',name:'Go',value:''},after:{ref:'abc-1',name:'Go',value:'1'}}};
  }
  return {ok:true};
 };
 const fastClick=await s.execute('click',{tabId:1,selector:'#go',trusted:false});
 assert.equal(fastClick.clicked,true);
 assert.equal(scriptExecs,0);

 const cfg=await s.execute('browser_config',{speedMode:'instant',compactResponses:true,idleDebuggerLeaseMs:200});
 assert.equal(cfg.speedMode,'instant');
 assert.equal(cfg.compactResponses,true);
 s.calls.length=0;

 const compactClick=await s.execute('click',{tabId:1,selector:'#go',trusted:false});
 assert.deepEqual(JSON.parse(JSON.stringify(compactClick)),{ok:true,clicked:true,ref:'abc-1',value:'1'});
 assert.ok(!s.calls.some(c=>c[2]==='SHOW_AGENT_INDICATORS'));
 assert.ok(!s.calls.some(c=>c[2]==='UPDATE_PHANTOM_CURSOR'));

 const verboseClick=await s.execute('click',{tabId:1,selector:'#go',trusted:false,verbose:true});
 assert.ok(verboseClick.before&&verboseClick.after);

 s.chrome.debugger.sendCommand=async(_,name)=>name==='Page.captureScreenshot'?{data:'img1'}:{};
 await s.execute('screenshot',{tabId:1});
 assert.equal(s.calls.filter(c=>c[0]==='attach').length,1);
 assert.equal(s.calls.filter(c=>c[0]==='detach').length,0);
 await s.execute('screenshot',{tabId:1});
 assert.equal(s.calls.filter(c=>c[0]==='attach').length,1);
 await new Promise(r=>setTimeout(r,260));
 assert.equal(s.calls.filter(c=>c[0]==='detach').length,1);
});

test('screenshot preset/dedupe/grid, diagnostics summaryOnly & navigate dismissCookies + afterSnapshot work',async()=>{
 const s=setup([{id:1,url:'https://app.test',status:'complete'}]);
 const ops=[];
 s.chrome.scripting.executeScript=async o=>{
  const [op,a]=o.args||[];
  ops.push([op,a]);
  if(op==='page_metrics')return [{result:{width:1200,height:800,devicePixelRatio:1,scrollX:0,scrollY:0}}];
  if(op==='page_snapshot')return [{result:{title:'App',url:'https://app.test/next',readyState:'complete',viewport:{width:1200,height:800},total:1,tree:'button "OK" [x1-1]'}}];
  if(op==='dismiss_cookies')return [{result:{dismissed:true,text:'Accept'}}];
  if(op==='draw_grid')return [{result:{step:80,width:1200,height:800}}];
  if(op==='clear_grid')return [{result:{cleared:true}}];
  return [{result:{enabled:true}}];
 };
 s.chrome.debugger.sendCommand=async(_,name,params)=>{
  if(name==='Page.captureScreenshot'){s.calls.push(['shotParams',params]);return {data:'SAME_IMAGE_DATA'};}
  return {};
 };
 const shot1=await s.execute('screenshot',{tabId:1,preset:'fast',dedupe:true,grid:true,gridStep:80});
 assert.equal(s.calls.find(c=>c[0]==='shotParams')[1].format,'jpeg');
 assert.equal(shot1.grid.step,80);
 assert.ok(ops.some(([o])=>o==='draw_grid'));
 assert.ok(ops.some(([o])=>o==='clear_grid'));
 const shot2=await s.execute('screenshot',{tabId:1,preset:'fast',dedupe:true});
 assert.equal(shot2.unchanged,true);
 assert.equal(shot2.image,undefined);

 await s.execute('diagnostics_start',{tabId:1});
 for(const fn of s.listeners.debugEvent){
  fn({tabId:1},'Network.requestWillBeSent',{requestId:'r1',request:{url:'https://api.test/fail',method:'GET'}});
  fn({tabId:1},'Network.responseReceived',{requestId:'r1',response:{url:'https://api.test/fail',status:502,mimeType:'text/plain'}});
  fn({tabId:1},'Runtime.consoleAPICalled',{type:'error',args:[{value:'Bad gateway'}]});
 }
 const diag=await s.execute('diagnostics_get',{tabId:1,summaryOnly:true});
 assert.equal(diag.summaryOnly,true);
 assert.equal(diag.statusCounts['502'],1);
 assert.equal(diag.topNetworkErrors[0].count,1);
 assert.equal(diag.consoleLevels.error,1);

 s.chrome.tabs.update=async(id,u)=>{const t=s.tabs.find(x=>x.id===id);t.url=u.url;t.status='complete';return t;};
 const nav=await s.execute('navigate',{tabId:1,url:'https://app.test/next',waitUntil:'load',dismissCookies:true,afterSnapshot:'tree'});
 assert.equal(nav.cookiesDismissed,'Accept');
 assert.ok(nav.snapshot.tree.includes('button "OK"'));
});

test('server-side _batch_exec supports fuseDom, when, optional, repeatUntil, parallel & templates',async()=>{
 const s=setup([{id:1,url:'https://app.test/form'}]);
 const pageOps=[];
 let checkCount=0;
 s.chrome.scripting.executeScript=async o=>{
  const [op,a]=o.args||[];
  pageOps.push([op,a]);
  if(op==='dom_batch'){
   return [{result:{steps:a.steps.map((st,i)=>({index:i,operation:st.operation,ok:true,result:{verified:true,element:{ref:`r-${i}`}}})),completed:a.steps.length,total:a.steps.length,hadError:false}}];
  }
  if(op==='check_condition'){
   if(a.selector==='#missing-modal')return [{result:{matched:false}}];
   checkCount++;
   return [{result:{matched:checkCount>=2}}];
  }
  if(op==='find_elements')return [{result:{matches:[{ref:'f-99',name:'Submit'}]}}];
  if(op==='wait_actionable'){
   if(a?.selector==='#opt-err')return [{result:{__maxError:'Element not found'}}];
   return [{result:{ref:'f-99',clickPoint:{x:50,y:50}}}];
  }
  if(op==='describe')return [{result:{ref:'f-99',value:'ok'}}];
  if(op==='page_state')return [{result:{text:'body'}}];
  if(op==='page_snapshot')return [{result:{title:'T',url:'https://app.test/form',tree:'button "Done" [d-1]'}}];
  return [{result:{ok:true}}];
 };
 s.chrome.debugger.sendCommand=async()=>({});

 const bRes=await s.execute('_batch_exec',{
  fuseDom:true,
  afterSnapshot:'tree',
  actions:[
   {name:'fill',arguments:{tabId:1,selector:'#a',value:'v1'}},
   {name:'fill',arguments:{tabId:1,selector:'#b',value:'v2'}},
   {name:'click',arguments:{tabId:1,selector:'#never'},when:{selector:'#missing-modal'}},
   {name:'click',arguments:{tabId:1,selector:'#opt-err'},optional:true},
   {parallel:[
    {name:'get_page_text',arguments:{tabId:1}},
    {name:'find_elements',arguments:{tabId:1,query:'Submit'}},
   ]},
   {name:'click',arguments:{tabId:1,ref:'{{$prev[1].matches[0].ref}}',trusted:false},repeatUntil:{selector:'#done',maxIterations:4}},
  ],
 });
 assert.equal(bRes.hadError,false);
 assert.equal(bRes.completed,6);
 assert.equal(bRes.steps[0].fused,true);
 assert.equal(bRes.steps[1].fused,true);
 assert.equal(bRes.steps[2].skipped,true);
 assert.equal(bRes.steps[3].skipped,true);
 assert.ok(pageOps.some(([op])=>op==='dom_batch'));
 assert.equal(checkCount,2);
 assert.ok(bRes.snapshot.tree.includes('Done'));
});

test('page_fetch, session_state, replay_request, network_har_export, bookmarks_and_history, wait_until_js & visual_diff work',async()=>{
 const s=setup([{id:1,url:'https://app.test/home'}]);
 const stored={localStorage:{auth:'s1',pub:'ok'},sessionStorage:{tab:'1'}};
 s.chrome.scripting.executeScript=async o=>{
  if(typeof o.func==='function'&&o.world==='MAIN'){
   if(o.args.length===1)return [{result:{ok:true,value:'ready'}}];
   const [url,method]=o.args;
   return [{result:{ok:true,status:200,statusText:'OK',url:url+'?token=urlsec',headers:{'content-type':'application/json'},text:JSON.stringify({items:[1],secret:'bodysec'}),truncated:false}}];
  }
  const [op,a]=o.args||[];
  if(op==='storage_get')return [{result:stored}];
  if(op==='storage_set'){stored[(a.type||'local')+'Storage'][a.key]=a.value;return [{result:{set:a.key}}];}
  if(op==='page_metrics')return [{result:{width:100,height:100,devicePixelRatio:1,scrollX:0,scrollY:0}}];
  return [{result:{enabled:true}}];
 };
 s.chrome.debugger.sendCommand=async(_,name)=>{
  if(name==='Runtime.evaluate')return {result:{value:'ready'}};
  if(name==='Page.captureScreenshot')return {data:'BASELINE_B64'};
  return {};
 };

 // ReadOnly blocks POST page_fetch, allows GET and redacts secrets
 await vm.runInContext("updateSafetyConfig({readOnly:true})",s.context);
 await assert.rejects(s.execute('page_fetch',{tabId:1,url:'/api/post',method:'POST'}),/Read-Only/);
 const fetched=await s.execute('page_fetch',{tabId:1,url:'/api/get'});
 assert.equal(fetched.status,200);
 assert.ok(!fetched.url.includes('urlsec')&&!fetched.body.includes('bodysec'));
 assert.equal(fetched.json.secret,'[redacted]');
 await vm.runInContext("updateSafetyConfig({readOnly:false})",s.context);

 // session_state export / list / import / delete
 const exp=await s.execute('session_state',{action:'export',tabId:1,slot:'qa'});
 assert.equal(exp.cookieCount,1);
 const list=await s.execute('session_state',{action:'list',tabId:1});
 assert.equal(list[0].slot,'qa');
 const imp=await s.execute('session_state',{action:'import',tabId:1,slot:'qa'});
 assert.equal(imp.restoredCookies,1);
 assert.equal((await s.execute('session_state',{action:'delete',tabId:1,slot:'qa'})).deleted,true);

 // HAR export + replay_request
 await s.execute('diagnostics_start',{tabId:1});
 for(const fn of s.listeners.debugEvent){
  fn({tabId:1},'Network.requestWillBeSent',{requestId:'rx1',request:{url:'https://app.test/api/v3',method:'GET'}});
  fn({tabId:1},'Network.responseReceived',{requestId:'rx1',response:{url:'https://app.test/api/v3',status:200,mimeType:'application/json'}});
  fn({tabId:1},'Network.loadingFinished',{requestId:'rx1',encodedDataLength:42});
 }
 const har=await s.execute('network_har_export',{tabId:1});
 assert.equal(har.log.version,'1.2');
 assert.equal(har.count,1);
 const rep=await s.execute('replay_request',{tabId:1,urlPattern:'*/api/v3*'});
 assert.equal(rep.replayedRequestId,'rx1');
 assert.equal(rep.status,200);

 // bookmarks_and_history redaction
 const bh=await s.execute('bookmarks_and_history',{query:'test'});
 assert.ok(!bh.bookmarks[0].url.includes('sec'));
 assert.ok(!bh.history[0].url.includes('abc'));

 // wait_until_js
 const wjs=await s.execute('wait_until_js',{tabId:1,expression:'window.__ok'});
 assert.equal(wjs.value,'ready');

 // visual_diff baseline & compare (fallback mode in node:vm)
 const vb=await s.execute('visual_diff',{action:'capture_baseline',tabId:1,slot:'hero'});
 assert.equal(vb.saved,true);
 const vcSame=await s.execute('visual_diff',{action:'compare',tabId:1,slot:'hero'});
 assert.equal(vcSame.diffPercent,0);
 s.chrome.debugger.sendCommand=async(_,name)=>name==='Page.captureScreenshot'?{data:'CHANGED_B64'}:{};
 const vcDiff=await s.execute('visual_diff',{action:'compare',tabId:1,slot:'hero'});
 assert.equal(vcDiff.diffPercent,100);
});
