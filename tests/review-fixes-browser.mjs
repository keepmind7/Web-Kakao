// Isolated synthetic browser regressions. No real account, personal profile or port8787.
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {createLocalServer} from '../experiments/local-web/server.mjs';
import {testBrowser} from './browser-platform.mjs';

const output=resolve(process.env.WEB_KAKAO_QA_OUTPUT_ROOT || 'local-only/repair-review-20261018/qa/contracts/browser',String(Date.now()));mkdirSync(output,{recursive:true});
const profile=resolve(output,'profile'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const chrome=testBrowser();
assert.ok(chrome,'Chrome required');
const key='r_'+'a'.repeat(24),message=n=>'m_'+String(n).repeat(24);
const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64');
const checks=[],servers=[];let browser,socket,app,sequence=0;const pending=new Map();
let contextCalls=0,contextReady=false,revision=1,instance='a'.repeat(24),readerMode=false,denied=false;
function command(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method));},8000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description || 'browser evaluation failed');return r.result?.value;}
async function until(expression){const end=Date.now()+8000;while(!await evaluate(expression).catch(()=>false)){if(Date.now()>end)throw new Error('fixture UI deadline: '+expression);await sleep(25);}}
async function check(name,fn){try{const evidence=await fn();checks.push({name,status:'passed',evidence});}catch(error){checks.push({name,status:error.code==='ERR_ASSERTION'?'failed':'fixture_error',error:String(error.message).slice(0,1600)});}}
async function closeApp(){if(!app)return;app.lab.cancel();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));servers.push({listening:app.server.listening});app=null;}
async function openApp({reader=false,deny=false}={}){
  await closeApp();readerMode=reader;denied=deny;contextCalls=0;contextReady=false;revision=1;instance='a'.repeat(24);
  app=createLocalServer({mode:'live',messaging:true,encode:()=>[[true]],photoFetcher:async()=>({data:gif,type:'image/gif'}),
    transport:async op=>op==='allowlist'?{httpStatus:200,body:{allowlisted:!denied}}:op==='generate'?{httpStatus:200,body:{status:0,url:'OFFLINE-NOT-FOR-LOGIN',remainingSeconds:180}}:readerMode?{httpStatus:200,body:{status:0,user:{userId:'999'},accessToken:'SYNTHETIC_NO_ACCOUNT'}}:{httpStatus:200,body:{status:-150,nextRequestIntervalInSeconds:30}},
    readerFactory:()=>({snapshot:()=>({phase:readerMode?'connected':'idle',instanceId:instance,attempts:readerMode?1:0,canConnect:false,roomCount:readerMode?1:0,revision,historyBusy:false,operationBusy:false}),close(){},
      rooms:()=>({rooms:readerMode?[{key,title:'Synthetic room',kind:'DirectChat',canContext:true,canRead:false,canText:false,canPhoto:false,canReply:false}]:[]}),
      messages:()=>({key,messages:[1,2].map(n=>({key:message(n),text:'Synthetic photo '+n,sender:'Synthetic peer',photos:[{src:`/api/photo?room=${key}&message=${message(n)}&index=0`,width:1,height:1}]})),entryPhase:contextReady?'acknowledged':'idle',receiptPhase:contextReady?'ready':'idle',latestVisible:true,history:{phase:'loaded'}}),
      history:()=>true,openRoom(){contextCalls++;if(contextCalls===1)return false;contextReady=true;revision++;return true;},contextRetryAfterMs:()=>contextCalls===1?1000:0,photo:()=> 'https://synthetic.kakaocdn.net/offline-photo',seen:()=>true})});
  const url=await app.listen(0);assert.notEqual(app.server.address().port,8787);
  if(reader){await app.lab.start();const end=Date.now()+4000;while(!app.lab.snapshot().credentialInMemory){if(Date.now()>end)throw new Error('synthetic auth fixture deadline');await sleep(20);}}
  const launch=await fetch(url+'/api/local/launch',{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Local-Control':app.controlToken},body:'{}'});assert.equal(launch.status,200);
  await command('Page.navigate',{url:url+'/launch#launch='+(await launch.json()).ticket});
  await until("location.pathname==='/' && typeof lastState!=='undefined' && !busy && !refreshing && lastState!==null");
  await evaluate("clearTimeout(pollTimer);pollTimer=null;clearTimeout(queuedRefreshTimer);queuedRefreshTimer=null;refreshPending=false;Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'visible'});document.hasFocus=()=>true;foregroundFocused=true;showAccount(false)");
}
async function refresh(){await evaluate("(async()=>{while(busy||refreshing)await new Promise(r=>setTimeout(r,5));await refresh();clearTimeout(pollTimer);pollTimer=null;})()");}
async function select(){await evaluate('selectRoom('+JSON.stringify(key)+')');await until("currentPage?.messages?.length===2 && !busy && !refreshing && !ackInFlight && !pendingSelection");}
async function photoGate(index=0){
  await evaluate(`document.querySelectorAll('.photo-open')[${index}].click()`);await until("el('photo-dialog').open && !el('photo-download').disabled");
  await evaluate("globalThis.downloadSaves=0;globalThis.downloadFetches=0;globalThis.downloadSignal=null;globalThis.releaseBlob=null;globalThis.originalFetch=globalThis.originalFetch || window.fetch.bind(window);globalThis.originalAnchorClick=globalThis.originalAnchorClick || HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(this.download){globalThis.downloadSaves++;return;}return globalThis.originalAnchorClick.call(this);};window.fetch=async(path,options={})=>{if(String(path).startsWith('/api/photo?')){globalThis.downloadFetches++;globalThis.downloadSignal=options.signal;return {ok:true,blob:()=>new Promise(resolve=>{globalThis.releaseBlob=()=>resolve(new Blob(['synthetic'],{type:'image/gif'}));})};}return globalThis.originalFetch(path,options);};el('photo-download').click();");
  await until('typeof releaseBlob===\'function\'');
}
async function completeGate(){await evaluate("releaseBlob();window.fetch=globalThis.originalFetch");await sleep(80);return evaluate("({saves:downloadSaves,aborted:downloadSignal?.aborted,open:el('photo-dialog').open,errorHidden:el('photo-error').hidden,button:el('photo-download').textContent,disabled:el('photo-download').disabled})");}

let fatal=null,chromeExitObserved=false;
try{
  browser=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-proxy-server','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'--window-size=1100,900','about:blank'],{windowsHide:true,stdio:'ignore'});
  const portFile=resolve(profile,'DevToolsActivePort'),end=Date.now()+15000;while(!existsSync(portFile)){if(Date.now()>end)throw new Error('Chrome startup deadline');await sleep(50);}
  const port=Number(readFileSync(portFile,'utf8').split(/\r?\n/)[0]),pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message',event=>{const r=JSON.parse(event.data),entry=pending.get(r.id);if(!entry)return;pending.delete(r.id);clearTimeout(entry.timer);r.error?entry.reject(new Error(r.error.message)):entry.resolve(r.result);});
  await openApp({reader:true});
  // Prescribed producer response is injected for the UI only; Node regression separately covers real HTTP production.
  await evaluate("globalThis.nativeFetch=window.fetch.bind(window);window.fetch=async(path,opts)=>{const response=await nativeFetch(path,opts);if(path==='/api/reader/context'&&response.status===409)return new Response(JSON.stringify({error:'context_rate_limited',retryAfterMs:1000}),{status:409,headers:{'Content-Type':'application/json'}});return response;}");
  await select();await refresh();
  await check('R1 explicit local cooldown retries once after expiry through eligible refresh',async()=>{assert.equal(contextCalls,1);await refresh();assert.equal(contextCalls,1,'no retry before deadline');await sleep(1100);await refresh();await refresh();assert.equal(contextCalls,2,'the previously refused context is retried after expiry');return {calls:contextCalls};});
  // Context is disabled for independent photo continuation checks.
  await evaluate("window.fetch=nativeFetch;roomsCache[0].canContext=false");
  await check('R2 delayed blob after close is aborted and never saved',async()=>{await photoGate();await evaluate("el('photo-close').click()");await sleep(30);const r=await completeGate();assert.equal(r.saves,0);assert.equal(r.aborted,true);assert.equal(r.open,false);return r;});
  await check('R2 delayed old blob never mutates a replacement photo dialog',async()=>{await photoGate();await evaluate("el('photo-close').click()");await sleep(30);await evaluate("document.querySelectorAll('.photo-open')[1].click();el('photo-download').textContent='NEW DIALOG';el('photo-download').disabled=true");const r=await completeGate();assert.equal(r.saves,0);assert.equal(r.aborted,true);assert.equal(r.button,'NEW DIALOG');assert.equal(r.disabled,true);await evaluate("el('photo-close').click()");return r;});
  await check('R2 delayed blob after account generation change is aborted and never saved',async()=>{await photoGate();instance='b'.repeat(24);await refresh();const r=await completeGate();assert.equal(r.saves,0);assert.equal(r.aborted,true);assert.equal(r.open,false);return r;});
  await openApp();await evaluate('showAccount(true)');
  for(let n=1;n<=4;n++){await evaluate("el('start').click()");await until("lastState.phase==='waiting'&&!busy&&!refreshing");await evaluate("el('cancel').click()");await until("lastState.phase==='cancelled'&&!busy&&!refreshing");}
  await check('QR fourth manual attempt remains available with explicit unlimited counter and visible title',async()=>{const snap=app.lab.snapshot(),ui=await evaluate("({title:el('title').textContent,message:el('message').textContent,disabled:el('start').disabled,counter:el('qr-attempts').textContent})");assert.equal(snap.canStart,true);assert.equal(snap.attempts,4);assert.equal(snap.startBlockedReason,null);assert.equal(ui.disabled,false);assert.ok(ui.title.trim());assert.equal(ui.counter,'QR 발급 시도 4회 · 수동 발급 횟수 제한 없음');return {reason:snap.startBlockedReason,...ui};});
  await openApp({deny:true});await evaluate("showAccount(true);el('start').click()");await until("lastState.phase==='blocked'&&!busy&&!refreshing");await evaluate("el('cancel').click()");await until("lastState.phase==='cancelled'&&!busy&&!refreshing");
  await check('QR cancellation preserves denial guard and explains the retained reason',async()=>{const snap=app.lab.snapshot(),ui=await evaluate("({title:el('title').textContent,message:el('message').textContent,disabled:el('start').disabled})");assert.equal(snap.sessionBlocked,true);assert.equal(snap.canStart,false);assert.equal(snap.startBlockedReason,'server_denied');assert.equal(ui.disabled,true);assert.ok(ui.title.trim());assert.match(ui.message,/거절|차단|허용|재시작/);return {reason:snap.startBlockedReason,...ui};});
}catch(error){fatal=String(error.stack);}
finally{
  for(const entry of pending.values())clearTimeout(entry.timer);pending.clear();socket?.close();
  chromeExitObserved=Boolean(browser&&(browser.exitCode!==null||browser.signalCode!==null));if(browser&&!chromeExitObserved){const exit=new Promise(r=>browser.once('exit',()=>{chromeExitObserved=true;r();}));browser.kill();await Promise.race([exit,sleep(3000)]);}
  await closeApp();
  const result={actualAccount:false,checks,fatal,cleanup:{chromeExitObserved,servers,pending:pending.size},profile};writeFileSync(resolve(output,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({checks:checks.length,passed:checks.filter(c=>c.status==='passed').length,expectedRed:checks.filter(c=>c.status==='failed').length,fixtureErrors:checks.filter(c=>c.status==='fixture_error').length,fatal,chromeExitObserved,output}));
  if(fatal||checks.some(c=>c.status!=='passed'))process.exitCode=1;
}
