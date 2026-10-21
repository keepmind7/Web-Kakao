// Account-free local browser integration. Fresh profile, injected session, ephemeral server only.
import {spawn,execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import assert from 'node:assert/strict';
const output=resolve(process.env.WEB_KAKAO_QA_OUTPUT_ROOT||'local-only/own-read-sync-20261021/qa/browser',String(Date.now()));mkdirSync(output,{recursive:true});
// Windows browser known-folder discovery needs the inherited Windows locations;
// its actual browser data stays in the explicit generated profile below.
const browserEnvironment={...process.env};
for(const key of ['USERPROFILE','APPDATA','LOCALAPPDATA'])browserEnvironment[key]=process.env['WEB_KAKAO_QA_BROWSER_ORIGINAL_'+key]||process.env[key];
const tempBase=resolve(tmpdir()),temporaryRoot=mkdtempSync(resolve(tempBase,'wk-own-browser-'));
const profile=resolve(temporaryRoot,'p'),environment=resolve(temporaryRoot,'env');mkdirSync(environment,{recursive:true});
for(const key of ['LOCALAPPDATA','APPDATA','USERPROFILE','TEMP','TMP']){process.env[key]=resolve(environment,key);mkdirSync(process.env[key],{recursive:true});}
const load=name=>import(pathToFileURL(resolve('experiments/local-web',name)).href);
const [{createLocalServer},{createReaderSession},{createReadOnlyReader}]=await Promise.all([load('server.mjs'),load('reader-session.mjs'),load('reader-manager.mjs')]);
const browserEngine=process.env.WEB_KAKAO_QA_BROWSER==='edge'?'Edge':'Chrome';
const chrome=(browserEngine==='Edge'?['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe']:['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']).find(existsSync);assert.ok(chrome,browserEngine+' installation required');
const own='999',credential={userId:own,deviceUUID:'SYNTHETIC_DEVICE',accessToken:'SYNTHETIC_NO_ACCOUNT'},calls=[],checks=[],pending=new Map();
const rows=[{c:'2000',t:'DirectChat',title:'Synthetic control',ll:'100',n:0},...['123','456','789','1000'].map(c=>({c,t:'DirectChat',title:'Synthetic '+c,ll:'100',n:3}))];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let child,session,reader,app,browser,socket,sequence=0,fatal=null,chromeExitObserved=false,chromeStderr='',url,controlKey,statusRequests=0,statusResponses=0;
const carriage=Object.assign(new EventEmitter(),{async connect(){},disconnect(){},stopPing(){},async loginList(){return {status:0,body:{chatDatas:rows}};},async request(method,body){calls.push({method,body});assert.fail('unselected inbound synchronization must not request '+method);}});
const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};}});
const settings={persist:false,notifications:false,readSync:false,roomFilter:'all',storageAvailable:true};
const prefs={account:()=>({key:()=>Buffer.alloc(32,8),snapshot:()=>({...settings}),room:()=>null,set(patch){Object.assign(settings,patch);return true;},setRoom:()=>true,close(){}})};
function spawnSynthetic(){
 child=Object.assign(new EventEmitter(),{send(message,callback){
  if(message.type==='reader-start'){session=createReaderSession(credential,{messaging:true,sessionSalt:message.sessionSalt,settingsSecret:Buffer.from(message.settingsSecret,'hex'),booking:bootstrap,ticket:bootstrap,carriage:()=>carriage,toLong:String,resolve:async h=>h,every:()=>0},event=>child.emit('message',event));void session.start();}
  else if(message.type==='reader-view')session.view(message.key);else if(message.type==='reader-action')void session.action(message.key,message.requestId,message.action,message.payload);else if(message.type==='reader-history')void session.history(message.key,message.requestId);else assert.fail('unexpected synthetic IPC');callback?.();
 },kill(){session?.close();return true;}});queueMicrotask(()=>child.emit('message',{type:'reader-ready'}));return child;
}
const push=(id,room='123')=>carriage.emit('push',{method:'MSG',status:0,body:{chatId:room,chatLog:{logId:String(id),authorId:'111',type:1,msg:'Synthetic '+id}}});
const read=(mark,room='123',user=own)=>carriage.emit('push',{method:'DECUNREAD',status:0,body:{chatId:room,userId:user,watermark:String(mark)}});
function command(method,params={}){return new Promise((resolve,reject)=>{const n=++sequence,timer=setTimeout(()=>{pending.delete(n);reject(new Error('CDP deadline '+method));},8000);pending.set(n,{resolve,reject,timer});socket.send(JSON.stringify({id:n,method,params}));});}
async function evaluate(expression){const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||'browser evaluation failed');return r.result?.value;}
async function until(expression){const end=Date.now()+8000;while(!await evaluate(expression).catch(()=>false)){if(Date.now()>end)throw new Error('fixture deadline '+expression);await sleep(30);}}
const ui=()=>evaluate("({selectedRoom,refreshing,readOff:!el('read-sync').checked,filter:roomFilter,href:location.href,rooms:roomsCache.map(r=>({title:r.title,count:r.unreadLocalCount})),visible:[...document.querySelectorAll('#room-list .room-item')].map(e=>({title:e.querySelector('strong')?.textContent,badge:e.querySelector('.unread-badge')?.textContent||null}))})");
async function polled(check){const before=statusRequests,end=Date.now()+4200;let state,fresh=false;do{state=await ui();fresh=statusResponses>before&&!state.refreshing;if(fresh&&check(state))break;await sleep(60);}while(Date.now()<end);assert.equal(fresh,true,'event must be followed by a new natural status poll response and completed browser refresh');return state;}
const count=(state,id)=>state.rooms.find(r=>r.title==='Synthetic '+id)?.count;
const visible=(state,id)=>state.visible.find(r=>r.title==='Synthetic '+id);
async function check(name,operation){try{checks.push({name,status:'passed',observed:await operation()});}catch(e){checks.push({name,status:e.code==='ERR_ASSERTION'?'failed':'fixture_error',error:String(e.stack).slice(0,1800)});}}
try{
 app=createLocalServer({mode:'live',messaging:true,encode:()=>[[true]],preferenceStore:prefs,
  transport:async op=>op==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:op==='generate'?{httpStatus:200,body:{status:0,url:'SYNTHETIC_NO_LOGIN',remainingSeconds:180}}:{httpStatus:200,body:{status:0,user:{userId:own},accessToken:'SYNTHETIC_NO_ACCOUNT'}},
  readerFactory:()=>reader=createReadOnlyReader({messaging:true,spawn:spawnSynthetic,preferenceStore:prefs})});
 app.server.on('request',(request,response)=>{if(request.method==='GET'&&request.url==='/api/status'){const id=++statusRequests;response.once('finish',()=>{statusResponses=Math.max(statusResponses,id);});}});
 url=await app.listen(0);assert.notEqual(app.server.address().port,8787);await app.lab.start();
 {const end=Date.now()+4000;while(!app.lab.snapshot().credentialInMemory){if(Date.now()>end)throw new Error('synthetic auth fixture deadline');await sleep(20);}}
 assert.equal(reader.connect(credential),true);{const end=Date.now()+4000;while(reader.snapshot().phase!=='connected'){if(Date.now()>end)throw new Error('synthetic session deadline');await sleep(20);}}controlKey=reader.rooms().rooms.find(r=>r.title==='Synthetic control').key;
 browser=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-proxy-server','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'--window-size=1100,900','about:blank'],{windowsHide:true,env:browserEnvironment,stdio:['ignore','ignore','pipe']});browser.stderr.on('data',data=>{chromeStderr=(chromeStderr+data.toString()).slice(-8000);});
 const file=resolve(profile,'DevToolsActivePort'),end=Date.now()+15000;while(!existsSync(file)){if(Date.now()>end)throw new Error('fresh Chrome startup deadline');await sleep(40);}
 const port=Number(readFileSync(file,'utf8').split(/\r?\n/)[0]),pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});socket.addEventListener('message',e=>{const r=JSON.parse(e.data),p=pending.get(r.id);if(!p)return;pending.delete(r.id);clearTimeout(p.timer);r.error?p.reject(new Error(r.error.message)):p.resolve(r.result);});
 const launch=await fetch(url+'/api/local/launch',{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Local-Control':app.controlToken},body:'{}'});assert.equal(launch.status,200);await command('Page.navigate',{url:url+'/launch#launch='+(await launch.json()).ticket});await until("location.pathname==='/'&&lastState?.reader?.phase==='connected'&&!busy&&!refreshing&&roomsCache.length===5");await evaluate('showAccount(false)');
 const original=await evaluate('location.href');assert.equal(await evaluate('selectedRoom'),controlKey);assert.equal(await evaluate("el('read-sync').checked"),false);
 await evaluate("el('filter-unread').click()");await until("roomFilter==='unread'&&!busy&&!refreshing");
 await check('normal polling renders initial3 plus incoming1 in sidebar and unread filter',async()=>{push(101);const state=await polled(s=>count(s,'123')===4);assert.equal(count(state,'123'),4);assert.equal(visible(state,'123')?.badge,'4');return {count:4,filter:state.filter};});
 await check('own receipt removes unselected room from unread filter without reload or read option',async()=>{read(101);const state=await polled(s=>!visible(s,'123'));assert.equal(count(state,'123'),0);assert.equal(visible(state,'123'),undefined);assert.equal(state.selectedRoom,controlKey);assert.equal(state.readOff,true);assert.equal(state.href,original);return {count:0,unselected:true,reloaded:false};});
 await check('later incoming remains unread and returns the room to the current filter',async()=>{push(102);const state=await polled(s=>count(s,'123')===1);assert.equal(count(state,'123'),1);assert.equal(visible(state,'123')?.badge,'1');return {count:1};});
 await check('partial own receipt retains the later incoming badge',async()=>{push(101,'456');push(103,'456');read(101,'456');const state=await polled(s=>count(s,'456')===1);assert.equal(count(state,'456'),1);assert.equal(visible(state,'456')?.badge,'1');return {remaining:1};});
 await check('peer receipt cannot remove the local unread room',async()=>{push(101,'789');read(101,'789','111');const state=await polled(s=>count(s,'789')===4);assert.equal(count(state,'789'),4);assert.equal(visible(state,'789')?.badge,'4');return {remaining:4};});
 await check('older own receipt cannot remove a later unread message',async()=>{read(101);const state=await polled(s=>count(s,'123')===1);assert.equal(count(state,'123'),1);assert.equal(visible(state,'123')?.badge,'1');return {remaining:1};});
 await check('late pushes at or below known own-read mark do not reappear as unread',async()=>{read(102,'1000');push(101,'1000');push(102,'1000');const state=await polled(s=>!visible(s,'1000'));assert.equal(count(state,'1000'),0);assert.equal(visible(state,'1000'),undefined);return {remaining:0};});
 await check('inbound-only synchronization preserves unselected read-OFF UI and sends zero account actions',async()=>{const state=await ui();assert.equal(state.selectedRoom,controlKey);assert.equal(state.readOff,true);assert.equal(state.href,original);for(const method of ['WRITE','NOTIREAD','SHIP','POST','JOINLINK'])assert.equal(calls.filter(c=>c.method===method).length,0,method);assert.equal(reader.snapshot().phase,'connected');return {accountActions:0,connected:true};});
}catch(e){fatal=String(e.stack);}
finally{
 for(const p of pending.values())clearTimeout(p.timer);pending.clear();chromeExitObserved=Boolean(browser&&(browser.exitCode!==null||browser.signalCode!==null));if(browser&&!chromeExitObserved){const exited=new Promise(r=>browser.once('exit',()=>{chromeExitObserved=true;r();}));if(socket?.readyState===WebSocket.OPEN)try{socket.send(JSON.stringify({id:++sequence,method:'Browser.close'}));}catch{}await Promise.race([exited,sleep(1400)]);if(!chromeExitObserved)browser.kill();await Promise.race([exited,sleep(3000)]);}socket?.close();
 session?.close();reader?.close();let serverClosed=false;if(app){app.lab.cancel();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));serverClosed=!app.server.listening;}
 assert.ok(resolve(temporaryRoot).startsWith(tempBase+sep),'generated cleanup root must remain within the original temporary directory');for(const target of [profile,environment])assert.ok(resolve(target).startsWith(resolve(temporaryRoot)+sep),'cleanup target must remain within generated own-read QA root');
 let profileProcessCount=null,cleanupError=null;try{
  if(browser&&process.platform==='win32'){
   const query="$qaProfile=$env:WEB_KAKAO_QA_OWN_PROFILE; $qaRows=@(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--user-data-dir='+$qaProfile) }); Write-Output $qaRows.Count";
   for(let attempt=0;attempt<3;attempt++){profileProcessCount=Number(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',query],{windowsHide:true,encoding:'utf8',timeout:12000,env:{...process.env,WEB_KAKAO_QA_OWN_PROFILE:profile},stdio:['ignore','pipe','pipe']}).trim());if(profileProcessCount===0)break;await sleep(400);}
  }else if(!browser)profileProcessCount=0;
  if(chromeExitObserved&&profileProcessCount===0)rmSync(temporaryRoot,{recursive:true,force:true,maxRetries:8,retryDelay:200});else rmSync(environment,{recursive:true,force:true,maxRetries:4,retryDelay:80});
 }catch(error){cleanupError={code:error.code??'cleanup_failed'};}
 const result={checks,fatal,actualAccount:false,actual8787:false,classification:'account-free local browser integration',browserEngine,chrome:{exitCode:browser?.exitCode??null,signalCode:browser?.signalCode??null,stderr:chromeStderr},cleanup:{chromeExitObserved,profileProcessCount,serverClosed,pending:pending.size,profileRemoved:!existsSync(profile),environmentRemoved:!existsSync(environment),temporaryRootRemoved:!existsSync(temporaryRoot),temporaryRoot,error:cleanupError}};writeFileSync(resolve(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({checks:checks.length,passed:checks.filter(c=>c.status==='passed').length,failed:checks.filter(c=>c.status==='failed').length,fixtureErrors:checks.filter(c=>c.status==='fixture_error').length,fatal,browserEngine,cleanup:result.cleanup,output}));if(fatal||cleanupError||profileProcessCount!==0||checks.some(c=>c.status!=='passed'))process.exitCode=1;
}
