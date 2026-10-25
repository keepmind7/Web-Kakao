// Account-free real-Chrome regression. Uses only an ephemeral loopback server
// and its own disposable profile, never the user's account/server/browser.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalServer} from '../experiments/local-web/server.mjs';
import {testBrowser} from './browser-platform.mjs';

const chrome=testBrowser();assert.ok(chrome,'fixed-location Chrome required');
assert.ok(process.argv.slice(2).every(value=>value==='--missing-module'),'only the missing-module regression flag is accepted');
const missingModule=process.argv.includes('--missing-module');
const output=resolve(process.env.WEB_KAKAO_QA_OUTPUT_ROOT || 'local-only/photo-loading-browser');mkdirSync(output,{recursive:true});
const temporaryRoot=mkdtempSync(join(tmpdir(),'wk-photo-loading-')),profile=resolve(temporaryRoot,'profile');
const browserEnv={...process.env,TMPDIR:resolve(temporaryRoot,'tmp')};mkdirSync(browserEnv.TMPDIR,{mode:0o700});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const room='r_'+'a'.repeat(24),second='r_'+'b'.repeat(24),message=n=>'m_'+(n+1).toString(16).padStart(24,'0');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const started=Date.now(),at=()=>Date.now()-started,checks=[],trace=[],network=new Map(),timers=new Set(),pending=new Map();
let count=0,revision=1,instance='a'.repeat(24),photoDelayMs=8000,photoRound=0,textSuffix='',readerPhase='connected',browser,socket,sequence=0,maxPhotoHTTP=0,maxServerPhotos=0,serverPhotos=0,probe=null,fatal=null,url;
const rows=[room,second].map((key,n)=>({key,title:'Synthetic room '+n,kind:'DirectChat',canContext:false,canRead:false,canText:false,canReply:false,canPhoto:false,historyAvailable:false}));
const reader={snapshot:()=>({instanceId:instance,phase:readerPhase,attempts:1,canConnect:false,roomCount:2,revision,roomsRevision:revision,pageRevisions:{[room]:revision,[second]:revision},historyBusy:false,operationBusy:false,connectedAt:started}),rooms:()=>({rooms:rows}),
  messages:key=>({key,messages:key===room&&count?Array.from({length:count},(_,n)=>({key:message(n+photoRound*100),text:'Synthetic photo '+n+textSuffix,sender:'Synthetic peer',photos:[{src:`/api/photo?room=${room}&message=${message(n+photoRound*100)}&index=0`,width:400,height:300}]})):[{key:message(99),text:'Synthetic text control',sender:'Synthetic peer'}],latestVisible:true,history:{phase:'loaded'}}),
  view:()=>true,photo:(_room,key)=>`https://synthetic.kakaocdn.net/photo-loading/${key}`,close(){},outbox:()=>[]};
const app=createLocalServer({mode:'live',messaging:false,encode:()=>[[true]],readerFactory:()=>reader,preferenceStore:{account(){assert.fail('no private profile');}},
  transport:async op=>op==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:op==='generate'?{httpStatus:200,body:{status:0,url:'SYNTHETIC_NO_LOGIN',remainingSeconds:180}}:{httpStatus:200,body:{status:0,user:{userId:'999'},accessToken:'SYNTHETIC_NO_ACCOUNT'}},
  photoFetcher:async(_url,{signal})=>{if(photoDelayMs)await new Promise((accept,reject)=>{const abort=()=>{clearTimeout(timer);timers.delete(timer);reject(new Error('photo_unavailable'));};const timer=setTimeout(()=>{timers.delete(timer);signal.removeEventListener('abort',abort);accept();},photoDelayMs);timers.add(timer);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});return {data:png,type:'image/png'};}});
app.server.on('request',(req,res)=>{const path=req.url.split('?')[0],row={path,photoKey:path==='/api/photo'?new URL(req.url,'http://synthetic.invalid').searchParams.get('message'):null,arrivalMs:at(),finishMs:null,closeMs:null,probe:req.headers['x-qa-photo-probe']==='1'};trace.push(row);if(path==='/api/photo'){serverPhotos++;maxServerPhotos=Math.max(maxServerPhotos,serverPhotos);res.once('close',()=>serverPhotos--);}res.once('finish',()=>row.finishMs=at());res.once('close',()=>row.closeMs=at());if(row.probe)probe=row;});
const call=(method,params={})=>new Promise((accept,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP deadline '+method));},12000);pending.set(id,{accept,reject,timer});socket.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description || 'synthetic evaluation failed');return r.result?.value;};
const until=async expression=>{const end=Date.now()+12000;while(!await evaluate(expression)){if(Date.now()>end)throw new Error('UI fixture deadline: '+expression);await sleep(30);}};
const check=async(name,fn)=>{try{checks.push({name,status:'passed',detail:await fn()});}catch(error){checks.push({name,status:'failed',error:error.message});}};
let cleanup;
try{
  url=await app.listen(0);assert.notEqual(app.server.address().port,8787);await app.lab.start();
  const authDeadline=Date.now()+5000;while(!app.lab.snapshot().credentialInMemory){if(Date.now()>authDeadline)throw new Error('synthetic auth deadline');await sleep(20);}
  browser=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-component-update','--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-proxy-server','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'--window-size=1100,900','about:blank'],{env:browserEnv,stdio:'ignore'});
  const portFile=resolve(profile,'DevToolsActivePort'),deadline=Date.now()+15000;while(!existsSync(portFile)){if(Date.now()>deadline)throw new Error('fresh Chrome startup deadline');await sleep(40);}
  const port=Number(readFileSync(portFile,'utf8').split(/\r?\n/)[0]);assert.notEqual(port,8787);
  const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  await new Promise((accept,reject)=>{socket.addEventListener('open',accept,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message',event=>{const value=JSON.parse(event.data),entry=pending.get(value.id);if(entry){pending.delete(value.id);clearTimeout(entry.timer);value.error?entry.reject(new Error('CDP rejected '+value.error.message)):entry.accept(value.result);return;}
    if(value.method==='Fetch.requestPaused'){void call('Fetch.fulfillRequest',{requestId:value.params.requestId,responseCode:404,responseHeaders:[{name:'Content-Type',value:'text/javascript; charset=utf-8'}],body:Buffer.from('// unavailable on a running older server').toString('base64')}).catch(error=>fatal=error.message);return;}
    const p=value.params;if(value.method==='Network.requestWillBeSent'){const parsed=new URL(p.request.url);if(parsed.origin!==url)return;network.set(p.requestId,{path:parsed.pathname,type:p.type,createdMs:at(),doneMs:null,canceled:false});if(parsed.pathname==='/api/photo')maxPhotoHTTP=Math.max(maxPhotoHTTP,[...network.values()].filter(row=>row.path==='/api/photo'&&row.doneMs===null).length);}
    else if(value.method==='Network.loadingFinished'||value.method==='Network.loadingFailed'){const row=network.get(p.requestId);if(row){row.doneMs=at();row.canceled=p.canceled===true;row.error=p.errorText;}}});
  await call('Network.enable');await call('Page.enable');
  if(missingModule){count=3;photoDelayMs=0;await call('Fetch.enable',{patterns:[{urlPattern:url+'/photo-loader.js',requestStage:'Request'}]});}
  const issue=await fetch(url+'/api/local/launch',{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Local-Control':app.controlToken},body:'{}'});assert.equal(issue.status,200);
  await call('Page.navigate',{url:url+'/launch#launch='+(await issue.json()).ticket});
  if(missingModule){
    await until("location.pathname==='/'&&document.readyState==='complete'");
    await check('missing photo module preserves status, text UI and explicit local session deletion',async()=>{
      await until("typeof freshness!=='undefined'&&freshness==='fresh'&&!busy&&!refreshing");
      const core=await evaluate("({fresh:typeof freshness!=='undefined'&&freshness==='fresh',reader:lastState?.reader?.phase,cancelEnabled:!el('cancel').disabled})");
      assert.deepEqual(core,{fresh:true,reader:'connected',cancelEnabled:true});
      await evaluate(`showAccount(false);selectRoom(${JSON.stringify(room)})`);await until("currentPage?.messages?.length===3&&!pendingSelection&&!refreshing&&!busy");
      const ui=await evaluate("({note:el('photo-module-notice')?.textContent,visible:el('photo-module-notice')?.getBoundingClientRect().height>0,images:[...document.querySelectorAll('.photo-open img')].filter(i=>i.hasAttribute('src')).length,disabled:[...document.querySelectorAll('.photo-open')].every(b=>b.disabled),downloadDisabled:el('photo-download').disabled,textMessages:currentPage.messages.length,message:el('message').textContent})");
      assert.match(ui.note,/사진.*모듈.*서버.*재시작/);assert.equal(ui.visible,true);assert.equal(ui.images,0);assert.equal(ui.disabled,true);assert.equal(ui.downloadDisabled,true);assert.equal(ui.textMessages,3);assert.doesNotMatch(ui.message,/모듈|재시작/,'photo update notice must not replace the connection message');
      const friendly=await evaluate("photoLoader.run(()=>{throw new Error('must not fetch')}).then(()=>null,error=>error.message)");assert.match(friendly,/서버.*재시작/);
      await evaluate("showAccount(true);el('cancel').click()");await until("lastState?.phase==='cancelled'&&!hasAccount&&!busy&&!refreshing");
      assert.equal(app.lab.snapshot().credentialInMemory,false);assert.equal(trace.filter(row=>row.path==='/api/photo').length,0);assert.equal(trace.filter(row=>row.path==='/api/cancel').length,1);assert.ok(trace.filter(row=>row.path==='/api/status').length>0);
      return {statusWorks:true,textMessages:3,photoHTTP:0,moduleNotice:true,explicitSessionClear:1};
    });
  }else{
  await until("typeof lastState!=='undefined'&&lastState?.reader?.phase==='connected'&&freshness==='fresh'&&!busy&&!refreshing");
  await evaluate(`showAccount(false);selectRoom(${JSON.stringify(room)})`);
  await until("currentPage?.key===selectedRoom&&!pendingSelection&&!busy&&!refreshing&&presencePhase==='active'");
  count=40;revision++;
  await evaluate('queueRefresh()');await until("document.querySelectorAll('.photo-open img').length===40");
  const photoDeadline=Date.now()+5000;while(trace.filter(row=>row.path==='/api/photo').length<2){if(Date.now()>photoDeadline)throw new Error('photo fixture never started');await sleep(30);}
  await sleep(250);
  await check('photo display never starts an automatic download',async()=>{assert.equal([...network.values()].filter(row=>row.path==='/api/photo'&&row.type==='Fetch').length,0);return {photoFetchDownloads:0};});
  const probeStarted=at();await evaluate("globalThis.qaProbe=fetch('/api/status',{headers:{'X-Local-Session':localSession,'X-QA-Photo-Probe':'1'},cache:'no-store'}).then(r=>r.json()).then(()=>true)");
  const preServerWaitMs=probe.arrivalMs-probeStarted;
  await check('slow photo burst keeps at most two photo HTTP requests in progress',async()=>{assert.ok(maxPhotoHTTP<=2,`observed ${maxPhotoHTTP} photo HTTP requests`);assert.ok(maxServerPhotos<=2);return {maxPhotoHTTP,maxServerPhotos};});
  await check('status reaches server without waiting for slow photo response',async()=>{assert.ok(preServerWaitMs<1000,`status waited ${preServerWaitMs}ms before server arrival`);assert.equal(reader.snapshot().phase,'connected');return {preServerWaitMs,readerPhase:reader.snapshot().phase};});
  const switchAt=at(),beforeSwitch=trace.filter(row=>row.path==='/api/photo').length,activeBefore=[...network.values()].filter(row=>row.path==='/api/photo'&&row.doneMs===null);
  await evaluate(`selectRoom(${JSON.stringify(second)})`);await until(`currentPage?.key===${JSON.stringify(second)}&&!pendingSelection&&!busy&&!refreshing`);await sleep(150);
  await check('room change cancels in-flight images and never starts old queued images',async()=>{assert.ok(activeBefore.length>0,'cancellation fixture has active photos');assert.ok(activeBefore.every(row=>row.canceled&&row.doneMs>=switchAt),'old photo HTTP must be canceled');assert.equal(trace.filter(row=>row.path==='/api/photo').length,beforeSwitch,'no old queued image starts after switch');assert.equal(await evaluate("document.querySelectorAll('.photo-open img').length"),0);return {canceled:activeBefore.length,oldQueueStarted:0};});
  await check('hidden tab preserves presence and connected reader',async()=>{await evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))");assert.equal(await evaluate('presencePhase'),'active');assert.equal(reader.snapshot().phase,'connected');await evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'))");return {presence:'active',reader:'connected'};});
  photoDelayMs=0;photoRound++;count=4;revision++;
  await evaluate(`selectRoom(${JSON.stringify(room)})`);await until("currentPage?.messages?.length===4&&!pendingSelection&&!busy&&!refreshing&&[...document.querySelectorAll('.photo-open img')].some(i=>i.naturalWidth===1)");
  const retainedKey=await evaluate("globalThis.qaRetainedPhoto=[...document.querySelectorAll('.photo-open img')].find(i=>i.naturalWidth===1);new URL(qaRetainedPhoto.src).searchParams.get('message')");
  const retainedRequests=trace.filter(row=>row.photoKey===retainedKey).length;textSuffix=' updated';revision++;await evaluate('queueRefresh()');await until("currentPage?.messages?.[0]?.text.endsWith(' updated')&&!refreshing&&!busy");
  await check('new text retains a loaded image without another request',async()=>{assert.equal(await evaluate('qaRetainedPhoto.isConnected&&qaRetainedPhoto.naturalWidth===1'),true);assert.equal(trace.filter(row=>row.photoKey===retainedKey).length,retainedRequests);return {retainedImage:true,additionalPhotoHTTP:0};});
  const downloadsBefore=[...network.values()].filter(row=>row.path==='/api/photo'&&row.type==='Fetch').length;
  await evaluate("globalThis.qaDownloads=0;HTMLAnchorElement.prototype.click=function(){if(this.download)qaDownloads++;};qaRetainedPhoto.closest('.photo-open').click()");await until("el('photo-dialog').open&&el('photo-full').naturalWidth===1&&!el('photo-download').disabled");
  await check('enlargement uses the same bounded image loader and does not download',async()=>{assert.ok(maxPhotoHTTP<=2);assert.equal(await evaluate('qaDownloads'),0);return {photoLoaded:true,downloads:0};});
  await evaluate("el('photo-download').click()");await until("qaDownloads===1&&!el('photo-download').disabled");
  await check('only an explicit click downloads once through the shared queue',async()=>{assert.equal([...network.values()].filter(row=>row.path==='/api/photo'&&row.type==='Fetch').length-downloadsBefore,1);assert.ok(maxPhotoHTTP<=2);return {explicitDownloads:1,maxPhotoHTTP};});
  await evaluate("globalThis.qaNativeFetch=window.fetch.bind(window);globalThis.qaDownloadSignal=null;globalThis.qaReleaseBlob=null;window.fetch=async(path,options)=>{if(String(path).startsWith('/api/photo?')){qaDownloadSignal=options.signal;return {ok:true,blob:()=>new Promise(resolve=>qaReleaseBlob=()=>resolve(new Blob(['synthetic'],{type:'image/png'})))};}return qaNativeFetch(path,options);};el('photo-download').click()");await until("typeof qaReleaseBlob==='function'");
  await evaluate(`selectRoom(${JSON.stringify(second)})`);await until(`currentPage?.key===${JSON.stringify(second)}&&!pendingSelection&&!busy&&!refreshing`);await evaluate('qaReleaseBlob();window.fetch=qaNativeFetch');await sleep(50);
  await check('room change aborts a download whose old body ignores abort',async()=>{const value=await evaluate("({aborted:qaDownloadSignal.aborted,downloads:qaDownloads,open:el('photo-dialog').open,src:el('photo-full').getAttribute('src')})");assert.deepEqual(value,{aborted:true,downloads:1,open:false,src:null});return value;});
  photoDelayMs=8000;photoRound++;count=40;revision++;await evaluate(`selectRoom(${JSON.stringify(room)})`);await until("document.querySelectorAll('.photo-open img').length===40&&!pendingSelection&&!busy&&!refreshing");
  const activePhoto=()=>[...network.values()].filter(row=>row.path==='/api/photo'&&row.doneMs===null);
  const activeEnd=Date.now()+5000;while(activePhoto().length<2){if(Date.now()>activeEnd)throw new Error('new generation photos never started');await sleep(20);}
  const oldInstancePhotos=activePhoto();instance='b'.repeat(24);revision++;await evaluate('queueRefresh()');await until("readerInstance==='b'.repeat(24)&&!refreshing&&!busy");await sleep(80);
  await check('reader instance change cancels old-generation photo callbacks and HTTP',async()=>{assert.ok(oldInstancePhotos.every(row=>row.canceled));assert.equal(await evaluate("el('photo-dialog').open"),false);return {oldPhotosCanceled:oldInstancePhotos.length};});
  const pagehidePhotos=activePhoto();assert.ok(pagehidePhotos.length>0,'pagehide has an active photo');const beforeHide=trace.filter(row=>row.path==='/api/photo').length;
  await evaluate("window.dispatchEvent(new Event('pagehide'))");await sleep(100);
  await check('pagehide cancels image requests and presence without starting the old queue',async()=>{assert.ok(pagehidePhotos.every(row=>row.canceled));assert.equal(trace.filter(row=>row.path==='/api/photo').length,beforeHide);assert.equal(await evaluate('presencePhase'),'idle');assert.equal(await evaluate("[...document.querySelectorAll('.photo-open img')].some(i=>i.hasAttribute('src'))"),false);return {photosCanceled:pagehidePhotos.length,presence:'idle'};});
  await evaluate("window.dispatchEvent(new Event('pageshow'))");await until("presencePhase==='active'&&freshness==='fresh'&&!refreshing&&!busy");
  const disconnectPhotos=activePhoto();readerPhase='disconnected';revision++;await evaluate('queueRefresh()');await until("lastState?.reader?.phase==='disconnected'&&!refreshing&&!busy");await sleep(80);
  await check('reader disconnection cancels photos while preserving the authenticated account',async()=>{assert.ok(disconnectPhotos.every(row=>row.canceled));assert.equal(await evaluate('hasAccount'),true);assert.equal(await evaluate("[...document.querySelectorAll('.photo-open img')].some(i=>i.hasAttribute('src'))"),false);return {reader:'disconnected',credentialRetained:true};});
  app.lab.cancel();await evaluate('queueRefresh()');await until('!hasAccount&&!refreshing&&!busy');
  await check('account end clears photo DOM and all origin photo locks',async()=>{const state=await evaluate('navigator.locks.query()');assert.equal([...state.held,...state.pending].filter(row=>row.name.startsWith('web-kakao-photo-')).length,0);assert.equal(await evaluate("document.querySelectorAll('.photo-open img').length"),0);assert.ok(maxPhotoHTTP<=2);return {photoNodes:0,photoLocks:0,maxPhotoHTTP};});
  }
}catch(error){fatal=String(error.stack);}
finally{
  if(socket?.readyState===WebSocket.OPEN){try{await Promise.race([call('Browser.close'),sleep(1000)]);}catch{}}
  for(const row of pending.values()){clearTimeout(row.timer);row.reject(new Error('synthetic cleanup'));}pending.clear();socket?.close();
  let chromeExitObserved=Boolean(browser&&(browser.exitCode!==null||browser.signalCode!==null));if(browser&&!chromeExitObserved){const exit=new Promise(r=>browser.once('exit',()=>{chromeExitObserved=true;r();}));await Promise.race([exit,sleep(1500)]);if(!chromeExitObserved){browser.kill();await Promise.race([exit,sleep(3000)]);}if(!chromeExitObserved){browser.kill('SIGKILL');await Promise.race([exit,sleep(2000)]);}}
  app.lab.cancel();app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));for(const timer of timers)clearTimeout(timer);timers.clear();
  if(chromeExitObserved)rmSync(temporaryRoot,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  cleanup={chromeExitObserved,serverClosed:!app.server.listening,temporaryRootRemoved:!existsSync(temporaryRoot),pending:pending.size};
}
const result={classification:'account-free local Chrome integration',actualAccountUsed:false,actual8787Used:false,node:process.version,elapsedMs:at(),checks,fatal,maxPhotoHTTP,maxServerPhotos,trace,network:[...network.values()],cleanup};
writeFileSync(resolve(output,'result.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({checks:checks.length,passed:checks.filter(row=>row.status==='passed').length,fatal,maxPhotoHTTP,cleanup,output}));
if(fatal||checks.some(row=>row.status!=='passed')||!cleanup.chromeExitObserved||!cleanup.serverClosed||!cleanup.temporaryRootRemoved)process.exitCode=1;
