// One bounded integration contract: real UI/server,300 synthetic rooms and delayed persistence.
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {createLocalServer} from '../experiments/local-web/server.mjs';
const output=resolve(process.env.WEB_KAKAO_QA_OUTPUT_ROOT || 'local-only/perf-portability-20261018/qa/contracts/browser',String(Date.now()));mkdirSync(output,{recursive:true});
const profile=resolve(output,'p'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const chrome=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);assert.ok(chrome,'Chrome required');
let release,entered;const hold=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
let settings={persist:false,notifications:false,readSync:false,roomFilter:'all',storageAvailable:true,storageError:false},saveCompleted=false;
const rooms=Array.from({length:300},(_,n)=>({key:'r_'+n.toString(16).padStart(24,'0'),title:'Synthetic room '+n,kind:'DirectChat',historyAvailable:false,canContext:false,canRead:false,canText:false}));
const app=createLocalServer({mode:'live',encode:()=>[[true]],transport:async op=>op==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:op==='generate'?{httpStatus:200,body:{status:0,url:'OFFLINE-NO-LOGIN',remainingSeconds:30}}:{httpStatus:200,body:{status:0,user:{userId:'999'},accessToken:'SYNTHETIC_NO_ACCOUNT'}},
  readerFactory:()=>({snapshot:()=>({instanceId:'a'.repeat(24),phase:'connected',attempts:1,canConnect:false,roomCount:300,revision:1,historyBusy:false,operationBusy:false}),rooms:()=>({rooms}),messages:key=>({key,messages:[],history:{phase:'unavailable'}}),settingsSnapshot:()=>settings,
    async updateSettings(patch){entered();await hold;settings={...settings,...patch};saveCompleted=true;return true;},close(){}})});
let browser,socket,sequence=0;const pending=new Map();let error=null,observed=null,chromeExitObserved=false;
function command(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method));},7000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description || 'browser evaluation failed');return r.result?.value;}
async function until(expression){const end=Date.now()+7000;while(!await evaluate(expression).catch(()=>false)){if(Date.now()>end)throw new Error('fixture deadline '+expression);await sleep(25);}}
try{
  const url=await app.listen(0);assert.notEqual(app.server.address().port,8787);await app.lab.start();const end=Date.now()+4000;while(!app.lab.snapshot().credentialInMemory){if(Date.now()>end)throw new Error('synthetic auth deadline');await sleep(20);}
  browser=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-proxy-server','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'--window-size=1100,900','about:blank'],{windowsHide:true,stdio:'ignore'});
  const file=resolve(profile,'DevToolsActivePort'),deadline=Date.now()+12000;while(!existsSync(file)){if(Date.now()>deadline)throw new Error('Chrome startup deadline');await sleep(40);}
  const port=Number(readFileSync(file,'utf8').split(/\r?\n/)[0]),pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});socket.addEventListener('message',event=>{const r=JSON.parse(event.data),entry=pending.get(r.id);if(!entry)return;pending.delete(r.id);clearTimeout(entry.timer);r.error?entry.reject(new Error(r.error.message)):entry.resolve(r.result);});
  const issue=await fetch(url+'/api/local/launch',{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Local-Control':app.controlToken},body:'{}'});const ticket=(await issue.json()).ticket;await command('Page.navigate',{url:url+'/launch#launch='+ticket});
  await until("typeof roomsCache!=='undefined'&&roomsCache.length===300&&!busy&&!refreshing&&personalSettings!==null");await evaluate("showAccount(true);clearTimeout(pollTimer);pollTimer=null;globalThis.heartbeat=0;globalThis.heartbeatTimer=setInterval(()=>heartbeat++,5)");
  await until("!el('persist-preferences').disabled");await evaluate("el('persist-preferences').click()");await Promise.race([started,sleep(3000).then(()=>{throw new Error('save did not enter synthetic storage');})]);await sleep(80);
  const status=await fetch(url+'/api/local/status',{headers:{'X-Local-Control':app.controlToken}});const ui=await evaluate("({settingsBusy,heartbeat,renderedRooms:document.querySelectorAll('#room-list button').length,checked:el('persist-preferences').checked})");
  observed={status:status.status,saveCompleted,ui};assert.equal(status.status,200);assert.ok(ui.heartbeat>=2);assert.equal(ui.renderedRooms,300);assert.equal(saveCompleted,false);assert.equal(ui.settingsBusy,true,'UI must remain saving until the durable settings response completes');release();
}catch(e){error={kind:e.code==='ERR_ASSERTION'?'expected_red':'fixture_error',message:String(e.message)};}
finally{
  release();for(const item of pending.values())clearTimeout(item.timer);pending.clear();socket?.close();
  chromeExitObserved=Boolean(browser&&(browser.exitCode!==null||browser.signalCode!==null));if(browser&&!chromeExitObserved){const exit=new Promise(r=>browser.once('exit',()=>{chromeExitObserved=true;r();}));browser.kill();await Promise.race([exit,sleep(3000)]);}
  app.lab.cancel();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));
  const result={checks:1,status:error?'failed':'passed',error,observed,actualAccount:false,cleanup:{chromeExitObserved,serverListening:app.server.listening,pending:pending.size},profile};writeFileSync(resolve(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({output,status:result.status,error,observed,cleanup:result.cleanup}));if(error)process.exitCode=1;
}
