// Real Chrome tabs, one isolated profile/origin, synthetic photo sources.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalServer} from '../experiments/local-web/server.mjs';
import {testBrowser} from './browser-platform.mjs';
const output=resolve(process.env.WEB_KAKAO_QA_OUTPUT_ROOT || 'local-only/photo-loading-multitab');mkdirSync(output,{recursive:true});
const temporaryRoot=mkdtempSync(join(tmpdir(),'wk-photo-tabs-')),profile=resolve(temporaryRoot,'profile'),browserEnv={...process.env,TMPDIR:resolve(temporaryRoot,'tmp')};mkdirSync(browserEnv.TMPDIR,{mode:0o700});
const chrome=testBrowser();assert.ok(chrome);const sleep=ms=>new Promise(r=>setTimeout(r,ms));
assert.ok(process.argv.slice(2).every(value=>value==='--four-tabs'),'only the supported four-tab comparison flag is accepted');
const tabCount=process.argv.includes('--four-tabs')?4:3;
const rooms=Array.from({length:tabCount+1},(_,n)=>'r_'+String.fromCharCode(97+n).repeat(24)),empty=rooms.at(-1),message=n=>'m_'+(n+1).toString(16).padStart(24,'0');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
let photos=false,browser,url,maxPhotoHTTP=0,maxServerPhotos=0,serverPhotos=0,fatal=null;
const started=Date.now(),at=()=>Date.now()-started,clients=[],timers=new Set(),trace=[],network=new Map(),checks=[];
const reader={snapshot:()=>({instanceId:'a'.repeat(24),phase:'connected',attempts:1,canConnect:false,roomCount:rooms.length,revision:photos?2:1,roomsRevision:1,pageRevisions:Object.fromEntries(rooms.map(key=>[key,photos?2:1])),historyBusy:false,operationBusy:false}),rooms:()=>({rooms:rooms.map((key,n)=>({key,title:'Synthetic tab room '+n,kind:'DirectChat',canContext:false,canRead:false,canText:false,canPhoto:false,canReply:false,historyAvailable:false}))}),
  messages:key=>({key,messages:photos&&key!==empty?Array.from({length:40},(_,n)=>({key:message(n),text:'Synthetic photo',sender:'Synthetic peer',photos:[{src:`/api/photo?room=${key}&message=${message(n)}&index=0`,width:400,height:300}]})):[{key:message(99),text:'Synthetic text',sender:'Synthetic peer'}],latestVisible:true,history:{phase:'loaded'}}),
  view:()=>true,photo:(room,key)=>`https://synthetic.kakaocdn.net/multitab/${room}/${key}`,outbox:()=>[],close(){}};
const app=createLocalServer({mode:'live',messaging:false,encode:()=>[[true]],readerFactory:()=>reader,preferenceStore:{account(){assert.fail('no private profile');}},transport:async op=>op==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:op==='generate'?{httpStatus:200,body:{status:0,url:'SYNTHETIC_NO_LOGIN',remainingSeconds:180}}:{httpStatus:200,body:{status:0,user:{userId:'999'},accessToken:'SYNTHETIC_NO_ACCOUNT'}},
  photoFetcher:async(_url,{signal})=>{await new Promise((accept,reject)=>{const abort=()=>{clearTimeout(timer);timers.delete(timer);reject(new Error('photo_unavailable'));};const timer=setTimeout(()=>{timers.delete(timer);signal.removeEventListener('abort',abort);accept();},8000);timers.add(timer);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});return {data:png,type:'image/png'};}});
app.server.on('request',(req,res)=>{const path=req.url.split('?')[0],row={path,atMs:at(),closeMs:null,probe:req.headers['x-qa-photo-probe'] || null};trace.push(row);if(path==='/api/photo'){serverPhotos++;maxServerPhotos=Math.max(maxServerPhotos,serverPhotos);res.once('close',()=>serverPhotos--);}res.once('close',()=>row.closeMs=at());});
async function connect(page,index){
  const socket=new WebSocket(page.webSocketDebuggerUrl),pending=new Map();let sequence=0;
  await new Promise((accept,reject)=>{socket.addEventListener('open',accept,{once:true});socket.addEventListener('error',reject,{once:true});});
  const call=(method,params={})=>new Promise((accept,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP deadline '+method));},12000);pending.set(id,{accept,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  socket.addEventListener('message',event=>{const v=JSON.parse(event.data),entry=pending.get(v.id);if(entry){pending.delete(v.id);clearTimeout(entry.timer);v.error?entry.reject(new Error('CDP rejected')):entry.accept(v.result);return;}const p=v.params,id=index+':'+p?.requestId;
    if(v.method==='Network.requestWillBeSent'){const parsed=new URL(p.request.url);if(parsed.origin!==url)return;network.set(id,{tab:index,path:parsed.pathname,atMs:at(),doneMs:null,canceled:false});if(parsed.pathname==='/api/photo')maxPhotoHTTP=Math.max(maxPhotoHTTP,[...network.values()].filter(r=>r.path==='/api/photo'&&r.doneMs===null).length);}
    else if(v.method==='Network.loadingFinished'||v.method==='Network.loadingFailed'){const row=network.get(id);if(row){row.doneMs=at();row.canceled=p.canceled===true;}}});
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description || 'UI evaluation failed');return r.result?.value;};
  const until=async expression=>{const end=Date.now()+12000;while(!await evaluate(expression).catch(()=>false)){if(Date.now()>end)throw new Error('UI fixture deadline');await sleep(30);}};
  const client={socket,pending,call,evaluate,until,id:page.id};clients.push(client);await call('Network.enable');await call('Page.enable');
  const ticket=await fetch(url+'/api/local/launch',{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Local-Control':app.controlToken},body:'{}'});assert.equal(ticket.status,200);
  await call('Page.navigate',{url:url+'/launch#launch='+(await ticket.json()).ticket});await until("typeof lastState!=='undefined'&&freshness==='fresh'&&!busy&&!refreshing&&presencePhase==='active'");
  await evaluate(`showAccount(false);selectRoom(${JSON.stringify(rooms[index])})`);await until(`currentPage?.key===${JSON.stringify(rooms[index])}&&!pendingSelection&&!busy&&!refreshing`);return client;
}
const check=async(name,fn)=>{try{checks.push({name,status:'passed',detail:await fn()});}catch(error){checks.push({name,status:'failed',error:error.message});}};
let cleanup;
try{
  url=await app.listen(0);assert.notEqual(app.server.address().port,8787);await app.lab.start();const authEnd=Date.now()+5000;while(!app.lab.snapshot().credentialInMemory){if(Date.now()>authEnd)throw new Error('synthetic auth deadline');await sleep(20);}
  browser=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-component-update','--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-proxy-server','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'--window-size=1100,900','about:blank'],{env:browserEnv,stdio:'ignore'});
  const portFile=resolve(profile,'DevToolsActivePort'),startupEnd=Date.now()+15000;while(!existsSync(portFile)){if(Date.now()>startupEnd)throw new Error('isolated Chrome startup deadline');await sleep(40);}
  const port=Number(readFileSync(portFile,'utf8').split(/\r?\n/)[0]);assert.notEqual(port,8787);
  const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();await connect(pages.find(p=>p.type==='page'),0);
  for(let n=1;n<tabCount;n++){const page=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();await connect(page,n);}
  photos=true;
  // Native IO does not paint new background tabs. Activate each tab once so
  // all tabs actually enter their photo viewport before measuring overlap.
  for(const c of clients){await c.call('Target.activateTarget',{targetId:c.id});await c.evaluate('queueRefresh()');await c.until("document.querySelectorAll('.photo-open img').length===40");await c.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await sleep(150);}
  await check(`${tabCount} tabs share at most two photo HTTP slots in one origin`,async()=>{assert.ok(maxPhotoHTTP<=2,`observed ${maxPhotoHTTP} browser photo requests`);assert.ok(maxServerPhotos<=2,`observed ${maxServerPhotos} server photo requests`);return {tabs:tabCount,maxPhotoHTTP,maxServerPhotos};});
  await check('all tabs can send status without waiting for slow photo responses',async()=>{const start=at();await Promise.all(clients.map((c,n)=>c.evaluate(`fetch('/api/status',{headers:{'X-Local-Session':localSession,'X-QA-Photo-Probe':${JSON.stringify(String(n))}},cache:'no-store'}).then(r=>r.json()).then(()=>true)`)));const arrivals=trace.filter(r=>r.probe!==null).map(r=>r.atMs-start);assert.equal(arrivals.length,tabCount);assert.ok(Math.max(...arrivals)<1000,`status pre-server waits: ${arrivals.join(',')}`);return {preServerWaitMs:arrivals};});
  const switched=[];
  // Each explicit selection is made in a visible tab. Hidden-tab admission is
  // intentionally deferred by the app and must not be mistaken for HTTP wait.
  // Cancel the first holder before the waiters to exercise cross-tab handoff.
  for(const [index,c] of clients.entries()){
    await c.call('Target.activateTarget',{targetId:c.id});const switchAt=at();
    await c.evaluate(`void selectRoom(${JSON.stringify(empty)});queueRefresh();true`);await c.until(`currentPage?.key===${JSON.stringify(empty)}&&!pendingSelection&&!busy&&!refreshing`);switched.push({tab:index,atMs:switchAt});
  }
  await sleep(150);
  await check('all room changes cancel images and queued cross-tab locks',async()=>{const states=await clients[0].evaluate('navigator.locks.query()');const photoLocks=[...states.held,...states.pending].filter(row=>row.name.startsWith('web-kakao-photo-'));assert.equal(photoLocks.length,0);for(const row of switched)assert.equal([...network.values()].filter(r=>r.path==='/api/photo'&&r.tab===row.tab&&r.atMs>row.atMs).length,0,'old tab queue never resumes after its own switch');assert.ok([...network.values()].filter(r=>r.path==='/api/photo').every(r=>r.doneMs!==null&&r.canceled));assert.ok(maxPhotoHTTP<=2,`handoff peak ${maxPhotoHTTP}`);assert.ok(maxServerPhotos<=2,`server handoff peak ${maxServerPhotos}`);return {heldOrPendingPhotoLocks:0,maxPhotoHTTP,maxServerPhotos};});
}catch(error){fatal=String(error.stack);}
finally{
  if(clients[0]?.socket.readyState===WebSocket.OPEN){try{await Promise.race([clients[0].call('Browser.close'),sleep(1000)]);}catch{}}
  for(const c of clients){for(const row of c.pending.values()){clearTimeout(row.timer);row.reject(new Error('test cleanup'));}c.pending.clear();c.socket.close();}
  let chromeExitObserved=Boolean(browser&&(browser.exitCode!==null||browser.signalCode!==null));if(browser&&!chromeExitObserved){const exit=new Promise(r=>browser.once('exit',()=>{chromeExitObserved=true;r();}));await Promise.race([exit,sleep(1500)]);if(!chromeExitObserved){browser.kill();await Promise.race([exit,sleep(3000)]);}if(!chromeExitObserved){browser.kill('SIGKILL');await Promise.race([exit,sleep(2000)]);}}
  app.lab.cancel();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));for(const timer of timers)clearTimeout(timer);timers.clear();
  if(chromeExitObserved)rmSync(temporaryRoot,{recursive:true,force:true,maxRetries:5,retryDelay:100});cleanup={chromeExitObserved,serverClosed:!app.server.listening,temporaryRootRemoved:!existsSync(temporaryRoot),pending:clients.reduce((n,c)=>n+c.pending.size,0)};
}
writeFileSync(resolve(output,'result.json'),JSON.stringify({classification:'account-free local Chrome integration',actualAccountUsed:false,actual8787Used:false,node:process.version,elapsedMs:at(),checks,fatal,maxPhotoHTTP,maxServerPhotos,trace,network:[...network.values()],cleanup},null,2));
console.log(JSON.stringify({checks:checks.length,passed:checks.filter(r=>r.status==='passed').length,fatal,maxPhotoHTTP,maxServerPhotos,cleanup,output}));if(fatal||checks.some(r=>r.status!=='passed')||!cleanup.chromeExitObserved||!cleanup.serverClosed||!cleanup.temporaryRootRemoved)process.exitCode=1;
