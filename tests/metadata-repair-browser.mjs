// Real browser/server/manager/session, wholly injected account-free protocol.
// Never attach to8787 or an existing browser; all storage/profile roots are private QA-owned.
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import assert from 'node:assert/strict';
const output=resolve(process.env.WEB_KAKAO_QA_OUTPUT_ROOT||'local-only/metadata-repair-20261021/qa/browser',String(Date.now()));mkdirSync(output,{recursive:true});
const browserEnvironment={...process.env};for(const key of ['USERPROFILE','APPDATA','LOCALAPPDATA']){const original=process.env['WEB_KAKAO_QA_BROWSER_ORIGINAL_'+key];if(original)browserEnvironment[key]=original;}
const tempBase=resolve(tmpdir()),temporaryRoot=mkdtempSync(resolve(tempBase,'wk-meta-'));
const profile=resolve(temporaryRoot,'p'),environment=resolve(temporaryRoot,'env');mkdirSync(environment,{recursive:true});
for(const key of ['LOCALAPPDATA','APPDATA','USERPROFILE','TEMP','TMP']){process.env[key]=resolve(environment,key);mkdirSync(process.env[key],{recursive:true});}
const [{createLocalServer},{createReaderSession},{createReadOnlyReader}]=await Promise.all([import('../experiments/local-web/server.mjs'),import('../experiments/local-web/reader-session.mjs'),import('../experiments/local-web/reader-manager.mjs')]);
const browserEngine=process.env.WEB_KAKAO_QA_BROWSER==='edge'?'Edge':'Chrome';
const chrome=(browserEngine==='Edge'?['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe']:['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']).find(existsSync);assert.ok(chrome,browserEngine+' installation required');
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),defer=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve};};
const own='999',id='9007199254740993',link='700',credential={userId:own,deviceUUID:'SYNTHETIC_DEVICE',accessToken:'SYNTHETIC_NO_ACCOUNT'};
const malicious='<img src=x onerror="globalThis.metadataInjected=true">';
const initial=defer(),late=defer(),titleOne=defer(),titleTwo=defer(),calls=[],checks=[],pending=new Map();
const rows=[{c:id,t:'OM',li:link,title:'Synthetic large open room',ll:'100',lastLog:{logId:'100',authorId:'111',type:1,msg:'Synthetic initial text'}},...Array.from({length:10},(_,n)=>({c:String(n+1),t:'MultiChat',title:'',updatedAt:1800000000+n}))];
let child,session,reader,app,browser,socket,sequence=0,key,one,two,fatal=null,chromeExitObserved=false,chromeStderr='';
const carriage=Object.assign(new EventEmitter(),{async connect(){},disconnect(){},stopPing(){},async loginList(){return {status:0,body:{chatDatas:rows}};},async request(method,body,timeout,policy){
 calls.push({method,body,timeout,policy});
 if(method==='SYNCLINK')return {status:0,body:{ltk:0,ols:[{li:link,ac:true}]}};
 if(method==='CHATONROOM')return {status:0,body:{c:String(body.chatId),li:link,mt:0,olu:{userId:own,lmt:2,opt:0},mi:['111']}};
 if(method==='MEMBER')return String(body.memberIds[0])==='111'?initial.promise:late.promise;
 if(method==='SYNCMSG')return {status:0,body:{isOK:true,chatLogs:[]}};
 if(method==='CHATINFO')return String(body.chatId)==='1'?titleOne.promise:String(body.chatId)==='2'?titleTwo.promise:{status:0,body:{chatInfo:{c:String(body.chatId),title:'Bootstrap '+body.chatId}}};
 assert.fail('metadata fixture must not dispatch '+method);
}});
const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};}});
const prefs={account:()=>({key:()=>Buffer.alloc(32,8),snapshot:()=>({persist:false,notifications:false,readSync:false,roomFilter:'all',storageAvailable:true}),room:()=>null,set:()=>true,setRoom:()=>true,close(){}})};
function spawnSynthetic(){
 child=Object.assign(new EventEmitter(),{send(message,callback){
  if(message.type==='reader-start'){
   session=createReaderSession(credential,{messaging:true,sessionSalt:Buffer.alloc(32,7),settingsSecret:Buffer.alloc(32,8),booking:bootstrap,ticket:bootstrap,carriage:()=>carriage,toLong:String,resolve:async h=>h,every:()=>0},event=>child.emit('message',event));void session.start();
  }else if(message.type==='reader-view')session.view(message.key);else if(message.type==='reader-action')void session.action(message.key,message.requestId,message.action,message.payload);else if(message.type==='reader-history')void session.history(message.key,message.requestId);else assert.fail('unexpected synthetic IPC');callback?.();
 },kill(){session?.close();return true;}});queueMicrotask(()=>child.emit('message',{type:'reader-ready'}));return child;
}
function command(method,params={}){return new Promise((resolve,reject)=>{const n=++sequence,timer=setTimeout(()=>{pending.delete(n);reject(new Error('CDP deadline '+method));},8000);pending.set(n,{resolve,reject,timer});socket.send(JSON.stringify({id:n,method,params}));});}
async function evaluate(expression){const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||'browser evaluation failed');return r.result?.value;}
async function until(expression){const end=Date.now()+8000;while(!await evaluate(expression).catch(()=>false)){if(Date.now()>end)throw new Error('fixture deadline '+expression);await sleep(30);}}
async function check(name,operation){try{checks.push({name,status:'passed',observed:await operation()});}catch(e){checks.push({name,status:e.code==='ERR_ASSERTION'?'expected_red':'fixture_error',error:String(e.stack).slice(0,1800)});}}
async function refreshUi(){await evaluate('(async()=>{while(busy||refreshing)await new Promise(r=>setTimeout(r,5));await refresh();clearTimeout(pollTimer);pollTimer=null;})()');}
async function select(room){await evaluate('selectRoom('+JSON.stringify(room)+')');await until('currentPage?.key===selectedRoom&&!pendingSelection&&!busy&&!refreshing');}
try{
 app=createLocalServer({mode:'live',messaging:true,encode:()=>[[true]],preferenceStore:prefs,
  transport:async op=>op==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:op==='generate'?{httpStatus:200,body:{status:0,url:'SYNTHETIC_NO_LOGIN',remainingSeconds:180}}:{httpStatus:200,body:{status:0,user:{userId:own},accessToken:'SYNTHETIC_NO_ACCOUNT'}},
  readerFactory:()=>reader=createReadOnlyReader({messaging:true,spawn:spawnSynthetic,preferenceStore:prefs})});
 const url=await app.listen(0);assert.notEqual(app.server.address().port,8787);await app.lab.start();
 {const end=Date.now()+4000;while(!app.lab.snapshot().credentialInMemory){if(Date.now()>end)throw new Error('synthetic auth fixture deadline');await sleep(20);}}
 assert.equal(reader.connect(credential),true);
 {const end=Date.now()+4000;while(reader.snapshot().phase!=='connected'){if(Date.now()>end)throw new Error('synthetic session deadline');await sleep(20);}}
 const roomRows=reader.rooms().rooms;key=roomRows.find(r=>r.kind==='OpenMultiChat').key;one=roomRows.find(r=>r.title==='이름 없는 대화방 2').key;two=roomRows.find(r=>r.title==='이름 없는 대화방 3').key;
 await sleep(1050);assert.equal(calls.filter(c=>c.method==='CHATINFO').length,8);
 browser=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-proxy-server','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'--window-size=1100,900','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe'],env:browserEnvironment});browser.stderr.on('data',data=>{chromeStderr=(chromeStderr+data.toString()).slice(-8000);});
 const file=resolve(profile,'DevToolsActivePort'),end=Date.now()+15000;while(!existsSync(file)){if(Date.now()>end)throw new Error('fresh Chrome startup deadline');await sleep(40);}
 const port=Number(readFileSync(file,'utf8').split(/\r?\n/)[0]),pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});socket.addEventListener('message',e=>{const r=JSON.parse(e.data),p=pending.get(r.id);if(!p)return;pending.delete(r.id);clearTimeout(p.timer);r.error?p.reject(new Error(r.error.message)):p.resolve(r.result);});
 const launch=await fetch(url+'/api/local/launch',{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Local-Control':app.controlToken},body:'{}'});assert.equal(launch.status,200);await command('Page.navigate',{url:url+'/launch#launch='+(await launch.json()).ticket});await until("location.pathname==='/'&&lastState?.reader?.phase==='connected'&&!busy&&!refreshing");
 await evaluate("clearTimeout(pollTimer);pollTimer=null;Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.hasFocus=()=>true;foregroundFocused=true;showAccount(false)");
 await select(key);assert.equal(reader.openRoom(key),true);await sleep(180);await refreshUi();
 await check('initial name completion updates the cached message DOM and renders nickname as safe text',async()=>{
  assert.match(await evaluate("document.querySelector('#message-list article')?.textContent||''"),/참여자/);initial.resolve({status:0,body:{chatId:id,members:[{userId:'111',nickName:malicious}]}});await sleep(180);await refreshUi();
  const observed=await evaluate("({text:document.querySelector('#message-list article')?.textContent,images:document.querySelectorAll('#message-list article img').length,injected:globalThis.metadataInjected===true})");assert.ok(observed.text.includes(malicious));assert.equal(observed.images,0);assert.equal(observed.injected,false);return observed;
 });
 await check('a later push author after entry receives incremental name publication without page navigation',async()=>{
  const before=await evaluate('location.href');carriage.emit('push',{method:'MSG',status:0,body:{chatId:id,chatLog:{chatId:id,logId:'101',authorId:'11499',type:1,msg:'Synthetic later author text'}}});await sleep(180);late.resolve({status:0,body:{chatId:id,members:[{userId:'11499',nickName:'Later resolved name'}]}});await sleep(180);await refreshUi();
  const observed=await evaluate("({text:el('message-list').textContent,url:location.href})");assert.ok(observed.text.includes('Later resolved name'));assert.equal(observed.url,before);assert.equal(calls.filter(c=>c.method==='MEMBER').length,2);return {nameVisible:true,navigation:false,nameRequests:2};
 });
 await check('selecting an unnamed room beyond the first8 recovers its heading and list title',async()=>{
  await select(one);await sleep(180);titleOne.resolve({status:0,body:{chatInfo:{c:'1',title:'Selected ninth recovered'}}});await sleep(180);await refreshUi();
  const observed=await evaluate("({heading:el('chat-title').textContent,list:el('room-list').textContent})");assert.equal(observed.heading,'Selected ninth recovered');assert.ok(observed.list.includes('Selected ninth recovered'));assert.equal(calls.filter(c=>c.method==='CHATINFO'&&String(c.body.chatId)==='1').length,1);return {heading:observed.heading,attempts:1};
 });
 await check('local alias stays authoritative while selected server title arrives asynchronously',async()=>{
  assert.equal(reader.rename(two,'Local alias retained'),true);await refreshUi();await select(two);await sleep(180);titleTwo.resolve({status:0,body:{chatInfo:{c:'2',title:'Recovered base title'}}});await sleep(180);await refreshUi();
  const observed=reader.rooms().rooms.find(r=>r.key===two);assert.equal(observed.title,'Local alias retained');assert.equal(observed.baseTitle,'Recovered base title');assert.equal(await evaluate("el('chat-title').textContent"),'Local alias retained');return {heading:'Local alias retained',baseTitle:observed.baseTitle};
 });
 await check('metadata rendering sends no text, read, upload, join or official account actions',async()=>{for(const m of ['WRITE','NOTIREAD','SHIP','POST','JOINLINK'])assert.equal(calls.filter(c=>c.method===m).length,0,m);assert.equal(reader.snapshot().phase,'connected');return {forbiddenRequests:0,connected:true};});
}catch(e){fatal=String(e.stack);}
finally{
 for(const d of [initial,late,titleOne,titleTwo])d.resolve({status:0,body:{}});
 if(socket?.readyState===WebSocket.OPEN){try{await Promise.race([command('Browser.close'),sleep(2000)]);}catch{/* Retain the captured checks even if CDP closes before its response. */}}
 for(const p of pending.values())clearTimeout(p.timer);pending.clear();socket?.close();
 chromeExitObserved=Boolean(browser&&(browser.exitCode!==null||browser.signalCode!==null));if(browser&&!chromeExitObserved){const exited=new Promise(r=>browser.once('exit',()=>{chromeExitObserved=true;r();}));await Promise.race([exited,sleep(3000)]);if(!chromeExitObserved){browser.kill();await Promise.race([exited,sleep(3000)]);}}
 session?.close();reader?.close();let serverClosed=false;if(app){app.lab.cancel();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));serverClosed=!app.server.listening;}
 assert.ok(resolve(temporaryRoot).startsWith(tempBase+sep),'cleanup root must be a generated child of the original temporary directory');
 for(const target of [profile,environment])assert.ok(resolve(target).startsWith(resolve(temporaryRoot)+sep),'cleanup target must remain within this generated QA temporary root');
 let cleanupError=null;try{if(chromeExitObserved)rmSync(temporaryRoot,{recursive:true,force:true,maxRetries:8,retryDelay:200});else rmSync(environment,{recursive:true,force:true,maxRetries:8,retryDelay:200});}catch(error){cleanupError={code:error.code??'cleanup_failed'};}
 const result={checks,fatal,actualAccount:false,browserEngine,classification:'account-free local browser integration',chrome:{exitCode:browser?.exitCode??null,signalCode:browser?.signalCode??null,stderr:chromeStderr},cleanup:{chromeExitObserved,serverClosed,pending:pending.size,profileRemoved:!existsSync(profile),environmentRemoved:!existsSync(environment),temporaryRootRemoved:!existsSync(temporaryRoot),error:cleanupError,temporaryRoot}};writeFileSync(resolve(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({checks:checks.length,passed:checks.filter(c=>c.status==='passed').length,expectedRed:checks.filter(c=>c.status==='expected_red').length,fixtureErrors:checks.filter(c=>c.status==='fixture_error').length,fatal,browserEngine,chrome:result.chrome,cleanup:result.cleanup,output}));if(fatal||cleanupError||checks.some(c=>c.status!=='passed'))process.exitCode=1;
}
