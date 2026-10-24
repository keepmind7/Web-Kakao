// Explicit offline browser fixture. Never attach to the user's browser/profile
// or the actual account server. Only synthetic text is captured.
import { spawn } from 'node:child_process';
import { existsSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLocalServer } from '../experiments/local-web/server.mjs';
import { decodeImage } from '../experiments/local-web/message-content.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import {testBrowser} from './browser-platform.mjs';

const chrome=testBrowser();
if(!chrome)throw new Error('Chrome unavailable; browser test not executed');
const folder=resolve(process.env.WEB_KAKAO_QA_OUTPUT_ROOT || 'local-only/phase2-browser',String(Date.now()));mkdirSync(folder,{recursive:true});
const key='r_'+'a'.repeat(24),second='r_'+'b'.repeat(24),payload='<img src=x onerror="globalThis.injected=true">';
let connected=false,attempts=0,revision=0,historyBusy=false,rejectNextQr=false,allowAuth=false,requirePasscode=false,otherPreview='예시 미리보기 B',statusRequests=0;
let historyTimer=null,historyGeneration=0;
const resetHistory=()=>{historyGeneration++;clearTimeout(historyTimer);historyTimer=null;historyBusy=false;};
const historyRooms=[],historyPhases=new Map(),messagesByRoom=new Map(),qrGrid=[[true]];
const localTitles=new Map(),unread=new Map(),contexts=new Map(),outcomes=new Map(),seenCalls=[],sendCalls=[];
const photoPayloads=[];
const roomCapabilities=new Map();
const contextCalls=[],ackCalls=[],fixtureRequests=[];
const viewCalls=[];
let activeRoom=null;
const receiptVersions=new Map([[key,1],[second,1]]),pageVersions=new Map([[key,1],[second,1]]);
let adversarialFixture=false,roomsVersion=1,settingsVersion=1,outboxVersion=1,photoRequests=0;
const readStates=new Map(),historyGaps=new Map(),latestMissing=new Set();
let unknownSend=false,unknownPhoto=false,rejectPhoto=false;
const offlineMessages=new Map();
const removedRooms=new Set();
const lifecycleChecks=[];
let enableSettings=false;
const defaultSettings=()=>({persist:false,notifications:false,readSync:false,roomFilter:'all',storageAvailable:true,storageError:false});
let settings=defaultSettings();const roomSettings=new Map(),notificationQueue=[];
const photoMessage='m_'+'9'.repeat(24),syntheticPhoto=Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64');
const syntheticPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const makeMessages=room=>Array.from({length:40},(_,i)=>({key:'m_'+(i+1).toString(16).padStart(24,'0'),text:i===0?payload:('모의 메시지 '+(i+1)+' ').repeat(50),sender:'모의 사용자',mine:i%2===0,canReply:true,at:1800000000000+i*1000}));
const controlToken=randomBytes(32).toString('hex');
const app=createLocalServer({controlToken,mode:'live',messaging:true,photoFetcher:async()=>({data:syntheticPhoto,type:'image/gif'}),encode:()=>qrGrid,transport:async op=>op==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:op==='generate'?{httpStatus:200,body:{status:0,url:'OFFLINE-NOT-FOR-LOGIN',remainingSeconds:60}}:rejectNextQr?{httpStatus:200,body:{status:-151}}:requirePasscode?{httpStatus:200,body:{status:-100,passcode:'0000',nextRequestIntervalInSeconds:1}}:allowAuth?{httpStatus:200,body:{status:0,user:{userId:'246810'},accessToken:'FAKE_OFFLINE_TOKEN'}}:{httpStatus:200,body:{status:-150,nextRequestIntervalInSeconds:1}},readerFactory:()=>({
  snapshot:()=>({phase:connected?'connected':attempts?'disconnected':'idle',attempts,canConnect:!connected,roomCount:connected?2-removedRooms.size:0,revision,...(adversarialFixture?{roomsRevision:roomsVersion,settingsRevision:settingsVersion,outboxRevision:outboxVersion,pageRevisions:Object.fromEntries(pageVersions)}:{}),historyBusy,pushBatches:0,connectedAt:connected?Date.now():null}),
  connect(){resetHistory();if(attempts++) {historyPhases.clear();messagesByRoom.clear();contexts.clear();readStates.clear();}connected=true;revision++;return true;},
  rooms:()=>({revision,rooms:connected?[{key,title:'모의 대화방 A',preview:'예시 미리보기'},{key:second,title:'모의 대화방 B',preview:otherPreview}].filter(row=>!removedRooms.has(row.key)).map(row=>({...row,...(adversarialFixture?{lastAt:1800000300000}:{}),baseTitle:row.title,title:localTitles.get(row.key) || row.title,localTitle:localTitles.get(row.key) || null,pinOrder:roomSettings.get(row.key)?.pinOrder ?? null,muted:roomSettings.get(row.key)?.muted===true,canSend:true,kind:'DirectChat',...roomCapabilities.get(row.key),unreadLocalCount:unread.get(row.key) || 0,unreadCoverage:'observed'})):[]}),
  messages:room=>({key:room,messages:messagesByRoom.get(room) || [],latestVisible:!latestMissing.has(room),seenToken:'c'.repeat(48),receiptPhase:contexts.get(room) || 'idle',...(adversarialFixture?{entryPhase:contexts.get(room) || 'idle',contextRevision:receiptVersions.get(room)}:{}),readSync:readStates.get(room) || {phase:'idle'},outbox:[...outcomes.values()].filter(row=>row.key===room),history:{phase:historyPhases.get(room) || 'idle',gap:historyGaps.get(room)===true,receivedCount:messagesByRoom.get(room)?.length || 0,acceptedCount:messagesByRoom.get(room)?.length || 0}}),
  view:room=>{if(![key,second].includes(room))return false;activeRoom=room;viewCalls.push(room);return true;},
  outbox:clientId=>clientId?(outcomes.get(clientId) || null):[...outcomes.values()].filter(row=>!row.acknowledged && ['sending','unknown'].includes(row.phase)),
  acknowledgeOutbox(clientId){const row=outcomes.get(clientId);if(row?.phase!=='unknown')return false;ackCalls.push(clientId);outcomes.set(clientId,{...row,acknowledged:true});outboxVersion++;revision++;return true;},
  rename(room,title){if(title===null)localTitles.delete(room);else localTitles.set(room,title);revision++;return true;},
  settingsSnapshot:()=>enableSettings?settings:null,
  updateSettings(patch){settings={...settings,...patch};revision++;return true;},
  roomPreferences(room,patch){if(Object.hasOwn(patch,'title')){if(patch.title===null)localTitles.delete(room);else localTitles.set(room,patch.title);}roomSettings.set(room,{...roomSettings.get(room),...patch});revision++;return true;},
  forgetSettings(){settings=defaultSettings();roomSettings.clear();localTitles.clear();revision++;return true;},
  claimNotifications:()=>settings.notifications?notificationQueue.splice(0,5):[],
  photo:(_room,msg)=>msg===photoMessage?'https://talkv.kakao.com/offline-test-only':null,
  openRoom(room){activeRoom=room;contextCalls.push(room);if(adversarialFixture)for(const other of [key,second])if(other!==room)contexts.set(other,'idle');contexts.set(room,'ready');pageVersions.set(room,pageVersions.get(room)+1);revision++;return true;},
  seen(room,token,notify){seenCalls.push({room,token,notify});if(notify)readStates.set(room,{phase:'accepted',messageKey:messagesByRoom.get(room).at(-1).key});unread.set(room,0);revision++;return true;},
  sendText(room,text,clientId,replyTo){if(outcomes.has(clientId))return true;sendCalls.push({room,text,clientId,replyTo});outcomes.set(clientId,{key:room,clientId,kind:'send',phase:'sending'});outboxVersion++;pageVersions.set(room,pageVersions.get(room)+1);revision++;setTimeout(()=>{outcomes.set(clientId,{key:room,clientId,kind:'send',phase:unknownSend?'unknown':'accepted'});if(!unknownSend)messagesByRoom.get(room).push({key:'m_'+(5000+sendCalls.length).toString(16).padStart(24,'0'),text,sender:'나',mine:true,at:1800000100000,unreadCount:1,...(replyTo?{reply:{text:messagesByRoom.get(room).find(row=>row.key===replyTo)?.text,sender:'모의 사용자'}}:{})});outboxVersion++;pageVersions.set(room,pageVersions.get(room)+1);revision++;},150).unref();return true;},
  sendPhoto(room,image,clientId){if(rejectPhoto)return false;photoPayloads.push(image);sendCalls.push({kind:'photo',room,clientId,byteLength:Buffer.from(image,'base64').length,mime:decodeImage(image)?.mime});outcomes.set(clientId,{key:room,clientId,kind:'photo',phase:unknownPhoto?'unknown':'accepted'});outboxVersion++;pageVersions.set(room,pageVersions.get(room)+1);revision++;return true;},
  history(room){if(historyBusy)return false;activeRoom=room;historyRooms.push(room);historyPhases.set(room,'loading');historyBusy=true;revision++;const generation=historyGeneration;historyTimer=setTimeout(()=>{if(generation!==historyGeneration || !connected)return;historyTimer=null;historyPhases.set(room,'loaded');if(!messagesByRoom.has(room))messagesByRoom.set(room,[...makeMessages(room),...(offlineMessages.get(room) || [])]);historyBusy=false;revision++;},500);historyTimer.unref();return true;},disconnect(){resetHistory();connected=false;revision++;},close(){resetHistory();connected=false;attempts=0;historyPhases.clear();messagesByRoom.clear();localTitles.clear();unread.clear();contexts.clear();outcomes.clear();revision++;},
})});
app.server.on('request',req=>{if(req.url==='/api/status')statusRequests++;if(req.url.startsWith('/api/photo?'))photoRequests++;fixtureRequests.push({method:req.method,path:req.url.split('?')[0],room:new URL(req.url,'http://synthetic.invalid').searchParams.get('room')});});
const url=await app.listen(0);
let browser,ws;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
  browser=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--no-proxy-server','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+resolve(folder,'profile'),'--window-size=1280,1000',url],{windowsHide:true,stdio:'ignore'});
  const deadline=Date.now()+15000;const portFile=resolve(folder,'profile/DevToolsActivePort');
  while(!existsSync(portFile)){if(Date.now()>deadline)throw new Error('browser startup timeout');await sleep(100);}
  const port=Number(readFileSync(portFile,'utf8').split(/\r?\n/)[0]);
  let page;
  while(!page){const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();page=pages.find(item=>item.url===url+'/');if(!page){if(Date.now()>deadline)throw new Error('page timeout');await sleep(100);}}
  ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  let sequence=0;const pending=new Map();
  ws.addEventListener('message',event=>{const message=JSON.parse(event.data);const item=pending.get(message.id);if(item){pending.delete(message.id);clearTimeout(item.timer);message.error?item.reject(new Error(`CDP ${item.method} failed (${message.error.code}): ${String(message.error.message).slice(0,160)}`)):item.resolve(message.result);}});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP ${method} timeout`));},5000);pending.set(id,{method,resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{
    const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description || 'browser evaluation failed');
    return result.result?.value;
  };
  const until=async expression=>{const until=Date.now()+10000;while(!await evaluate(expression)){if(Date.now()>until){console.log(JSON.stringify({syntheticBrowserTimeout:await evaluate("({selectedRoom,pendingSelection,busy,refreshing,ackInFlight,pageKey:currentPage?.key,history:currentPage?.history,readSync:currentPage?.readSync,reader:lastState?.reader,freshness,connectDisabled:el('reader-connect').disabled,messageCount:document.querySelectorAll('#message-list article').length,historyButtonDisabled:el('history-load').disabled})"),historyRooms,statusRequests}));throw new Error('browser assertion timeout: '+expression);}await sleep(100);}};
  const refreshUi=()=>evaluate("(async()=>{while(refreshing || busy)await new Promise(resolve=>setTimeout(resolve,10));await refresh();})()");
  // Bootstrap through the real launcher flow: control-issued ticket, fragment handoff, header session.
  const launchUrl=async()=>{const launcher=await fetch(url+'/api/local/launch',{method:'POST',headers:{'Content-Type':'application/json','Origin':url,'X-Local-Control':controlToken},body:'{}'});assert.equal(launcher.status,200,'synthetic launch ticket must be issued');return url+'/launch#launch='+(await launcher.json()).ticket;};
  const bootstrap='control-ticket-header-session';
  await call('Page.navigate',{url:await launchUrl()});
  {const end=Date.now()+10000;while(!await evaluate("location.pathname==='/' && document.readyState==='complete' && /^[a-f0-9]{64}$/.test(sessionStorage.getItem('webKakaoLocalSession') ?? '')").catch(()=>false)){if(Date.now()>end)throw new Error('launch bootstrap timeout');await sleep(100);}}
  assert.equal(await evaluate("document.cookie"),'','header session must not use cookies');
  writeFileSync(resolve(folder,'synthetic-bootstrap.json'),JSON.stringify({actualAccountUsed:false,mode:bootstrap,secretsRecorded:false},null,2));
  async function checkAdversarialBrowser(){
    const results=[],extraSockets=[];let target;
    const ackBaseline=[...ackCalls];
    const pollingAtEntry=await evaluate('pollTimer!==null');
    const check=async(name,fn)=>{try{const observed=await fn();results.push({name,passed:true,...(observed?{observed}:{})});lifecycleChecks.push(name);}catch(error){results.push({name,passed:false,error:String(error.message).slice(0,1500)});}};
    const touch=(room=key)=>{pageVersions.set(room,pageVersions.get(room)+1);revision++;};
    const ready="typeof lastState!=='undefined' && lastState?.reader?.phase==='connected' && !busy && !refreshing && !ackInFlight && !pendingSelection";
    const stopPolling="clearTimeout(pollTimer);pollTimer=null;clearTimeout(queuedRefreshTimer);queuedRefreshTimer=null;refreshPending=false;showAccount(false);Object.defineProperty(document,'hidden',{configurable:true,get:()=>globalThis.testHidden===true});Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>globalThis.testHidden?'hidden':'visible'});globalThis.testHidden=false;globalThis.testFocus=true;document.hasFocus=()=>globalThis.testFocus;el('read-sync').checked=false;";
    async function secondTab(){
      target=await call('Target.createTarget',{url:await launchUrl()});
      const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();const remote=targets.find(row=>row.id===target.targetId);assert.ok(remote,'test-owned second target must exist');
      const socket=new WebSocket(remote.webSocketDebuggerUrl);extraSockets.push(socket);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
      let sequence=0;const pending=new Map();socket.addEventListener('message',event=>{const message=JSON.parse(event.data),entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(new Error('second target CDP error')):entry.resolve(message.result);});
      const tabCall=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('second target timeout'));},5000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
      const evalTab=async expression=>{const result=await tabCall('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description || 'second target evaluation failed');return result.result?.value;};
      const wait=async expression=>{const end=Date.now()+10000;while(!await evalTab(expression)){if(Date.now()>end)throw new Error('second target condition timeout');await sleep(50);}};
      await wait(ready);await evalTab(stopPolling);return {evaluate:evalTab,until:wait,refresh:()=>evalTab("(async()=>{while(refreshing || busy)await new Promise(resolve=>setTimeout(resolve,10));await refresh();clearTimeout(pollTimer);pollTimer=null;})()")};
    }
    try{
      adversarialFixture=true;enableSettings=true;settings=defaultSettings();settingsVersion++;roomsVersion++;
      outcomes.clear();contexts.clear();removedRooms.clear();
      for(const room of [key,second]){messagesByRoom.set(room,makeMessages(room));historyPhases.set(room,'loaded');roomCapabilities.set(room,{kind:'DirectChat',canSend:true,canText:true,canReply:true,canPhoto:true,canRead:true,canContext:true});touch(room);}
      await refreshUi();await evaluate(stopPolling);const tab=await secondTab();
      const before=contextCalls.length;
      await evaluate(`void selectRoom('${key}')`);await until(ready);await refreshUi();
      await tab.evaluate(`void selectRoom('${second}')`);await tab.until(ready);await tab.refresh();
      await check('two foreground tabs independently enter A and B once',async()=>{assert.deepEqual(contextCalls.slice(before),[key,second]);return {automaticContexts:contextCalls.length-before};});
      const afterInitial=contextCalls.length;
      for(let n=0;n<10;n++){await refreshUi();await tab.refresh();}
      await check('ten alternating polls in two foreground tabs add zero context requests',async()=>{assert.equal(contextCalls.length-afterInitial,0);return {rounds:10,additionalContexts:contextCalls.length-afterInitial};});
      await evaluate('globalThis.testHidden=true;globalThis.testFocus=false');await tab.evaluate('globalThis.testHidden=true;globalThis.testFocus=false');contexts.clear();touch(key);touch(second);
      const background=contextCalls.length;for(let n=0;n<3;n++){await refreshUi();await tab.refresh();}
      await check('hidden and unfocused tabs automatically enter zero rooms',async()=>{assert.equal(contextCalls.length-background,0);return {additionalContexts:contextCalls.length-background};});
      await evaluate('globalThis.testHidden=false;globalThis.testFocus=false');contexts.set(key,'idle');touch(key);const unfocused=contextCalls.length;for(let n=0;n<3;n++)await refreshUi();
      await check('a visible but unfocused tab automatically enters zero rooms',async()=>{assert.equal(contextCalls.length-unfocused,0);return {additionalContexts:contextCalls.length-unfocused};});
      await evaluate('globalThis.testHidden=true;globalThis.testFocus=true');contexts.set(key,'idle');touch(key);const hidden=contextCalls.length;for(let n=0;n<3;n++)await refreshUi();
      await check('a hidden but focused tab automatically enters zero rooms',async()=>{assert.equal(contextCalls.length-hidden,0);return {additionalContexts:contextCalls.length-hidden};});
      // A genuine receipt generation change permits exactly one fresh attempt;
      // changing another tab's active room alone did not create a generation.
      await evaluate('globalThis.testHidden=false;globalThis.testFocus=true');receiptVersions.set(key,receiptVersions.get(key)+1);contexts.set(key,'idle');touch(key);
      const changed=contextCalls.length;for(let n=0;n<4;n++)await refreshUi();
      await check('a genuine receipt context revision allows exactly one new automatic entry',async()=>{assert.equal(contextCalls.length-changed,1);return {additionalContexts:contextCalls.length-changed};});
      await call('Target.closeTarget',{targetId:target.targetId});target=null;for(const socket of extraSockets)socket.close();
      // Disable context for independent request/DOM checks: those checks should
      // not incidentally send or depend on room-entry scheduling.
      for(const room of [key,second])roomCapabilities.set(room,{...roomCapabilities.get(room),canContext:false});roomsVersion++;touch(key);await refreshUi();
      const selected=await evaluate('selectedRoom');assert.equal(selected,key,'the primary test target must remain A');
      const baseRequests=fixtureRequests.length;readStates.set(key,{phase:'accepted',messageKey:messagesByRoom.get(key).at(-1).key});touch(key);await refreshUi();
      await check('receipt-only selected page revision avoids room list and settings requests',async()=>{const rows=fixtureRequests.slice(baseRequests);assert.equal(rows.filter(row=>row.path==='/api/reader/rooms').length,0);assert.equal(rows.filter(row=>row.path==='/api/preferences').length,0);assert.equal(rows.filter(row=>row.path==='/api/reader/messages' && row.room===key).length,1);return {rooms:0,settings:0,selectedPages:1};});
      const unrelated=fixtureRequests.length;touch(second);await refreshUi();await refreshUi();
      await check('another room page revision does not refetch selected page rooms or settings',async()=>{const rows=fixtureRequests.slice(unrelated);assert.equal(rows.filter(row=>['/api/reader/rooms','/api/preferences','/api/reader/messages'].includes(row.path)).length,0);return {unrelatedPageRequests:0};});
      const messageRows=[{key:photoMessage,text:'[사진]',sender:'모의 사용자',mine:false,at:1800000300000,photos:[{src:`/api/photo?room=${key}&message=${photoMessage}&index=0`,width:1,height:1}]},{key:'m_'+'8'.repeat(24),text:'사진 뒤의 합성 글',sender:'나',mine:true,canReply:true,at:1800000301000,unreadCount:2}];
      messagesByRoom.set(key,messageRows);touch(key);await refreshUi();await until("document.querySelector('.photo-open img')?.naturalWidth===1");await evaluate("globalThis.retainedPhoto=document.querySelector('.photo-open img')");
      const beforePhotos=photoRequests;messageRows.push({key:'m_'+'7'.repeat(24),text:'새 합성 글',sender:'모의 사용자',mine:false,at:1800000302000});touch(key);await refreshUi();await sleep(150);
      await check('new text retains existing photo img identity with zero extra photo GET',async()=>{assert.equal(await evaluate("document.querySelector('.photo-open img')===globalThis.retainedPhoto"),true);assert.equal(photoRequests-beforePhotos,0);return {additionalPhotoGets:photoRequests-beforePhotos};});
      const beforeReceiptPhotos=photoRequests;messageRows[1].unreadCount=1;touch(key);await refreshUi();await sleep(150);
      await check('receipt change retains existing photo img identity with zero extra photo GET',async()=>{assert.equal(await evaluate("document.querySelector('.photo-open img')===globalThis.retainedPhoto"),true);assert.equal(photoRequests-beforeReceiptPhotos,0);return {additionalPhotoGets:photoRequests-beforeReceiptPhotos};});
await evaluate("globalThis.downloads=[];globalThis.originalAnchorClick=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){globalThis.downloads.push(this.download);};document.querySelector('.photo-open').click()");
await until("document.getElementById('photo-dialog').open && document.getElementById('photo-full').naturalWidth===1 && !document.getElementById('photo-download').disabled");
const beforeDownload=photoRequests;await evaluate("document.getElementById('photo-download').click()");await until("globalThis.downloads.length===1 && document.getElementById('photo-download').textContent==='다운로드'");
await check('explicit photo download fetches once and saves an image file',async()=>{const name=await evaluate("globalThis.downloads[0]");assert.match(name,/^kakao-photo-\d{8}-\d{6}\.(?:png|jpg|webp|gif)$/);assert.equal(photoRequests-beforeDownload,1);return {name,photoGets:photoRequests-beforeDownload};});
await evaluate("HTMLAnchorElement.prototype.click=globalThis.originalAnchorClick;new Promise(resolve=>{const dialog=document.getElementById('photo-dialog');dialog.addEventListener('close',()=>resolve(),{once:true});dialog.close();})");
await check('closing the photo dialog disables download',async()=>{assert.equal(await evaluate("document.getElementById('photo-download').disabled"),true);return {disabled:true};});
      // Real rendered CSS, composited through ancestors. Small text is held to
      // 4.5 even if bold; transparent badges/quotes use their actual backdrops.
      await evaluate('globalThis.testFocus=false');unread.set(key,3);roomsVersion++;roomCapabilities.set(key,{...roomCapabilities.get(key),kind:'OpenMultiChat'});touch(key);await refreshUi();
      for(const mode of ['light','dark'])await check(`${mode} remaining small text contrast is at least 4.5`,async()=>{
        await evaluate(`el('theme-mode').value='${mode}';el('theme-mode').dispatchEvent(new Event('change'));`);
        const samples=await evaluate(`(()=>{const rgba=value=>{const n=value.match(/[\\d.]+/g)?.map(Number);return n?[n[0],n[1],n[2],n[3]??1]:[0,0,0,0];};const blend=(f,b)=>[...f.slice(0,3).map((v,i)=>v*f[3]+b[i]*(1-f[3])),1];const bg=node=>{const chain=[],box=node.getBoundingClientRect();for(let n=node;n;n=n.parentElement){const r=n.getBoundingClientRect();if(n===node || box.left>=r.left && box.right<=r.right && box.top>=r.top && box.bottom<=r.bottom)chain.unshift(n);}return chain.reduce((back,n)=>blend(rgba(getComputedStyle(n).backgroundColor),back),[255,255,255,1]);};const lum=rgb=>rgb.slice(0,3).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);const selectors=['.room-item.selected .room-preview','.room-item.selected .room-time','.unread-badge','.avatar','.message:not(.mine)>.muted','.message.mine>.muted','.message-read','.send-status'];return selectors.flatMap(selector=>[...document.querySelectorAll(selector)].filter(n=>n.textContent.trim() && n.getClientRects().length).map(n=>{const s=getComputedStyle(n),back=bg(n),front=blend(rgba(s.color),back),a=lum(front),b=lum(back);return {selector,size:parseFloat(s.fontSize),ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};}));})()`);
        assert.ok(samples.some(row=>row.selector==='.unread-badge'),'contrast fixture must expose the unread badge');assert.ok(samples.some(row=>row.selector==='.avatar'),'contrast fixture must expose avatars');assert.ok(samples.some(row=>row.selector==='.message-read'),'contrast fixture must expose read-count text');
        const failures=samples.filter(row=>row.size<18.667 && row.ratio<4.5);writeFileSync(resolve(folder,`synthetic-adversarial-contrast-${mode}.json`),JSON.stringify({mode,samples,failures,actualAccountUsed:false},null,2));assert.deepEqual(failures,[]);return {samples:samples.length,minimumRatio:Math.min(...samples.map(row=>row.ratio))};
      });
      // Use a real fixture send once, then reload. Only opaque outbox metadata
      // may restore a warning; the fixture deliberately does not store drafts.
      await evaluate("showAccount(false);globalThis.testHidden=false;globalThis.testFocus=true;el('compose-text').value='새로고침 결과 불명 합성';el('compose-text').dispatchEvent(new Event('input'))");
      unknownSend=true;const beforeSend=sendCalls.length;await until("!busy && !refreshing && !ackInFlight && !el('send-message').disabled && (el('send-message').click(),true)");await sleep(250);await refreshUi();await until("pendingSend?.phase==='unknown'");const unknownId=sendCalls.at(-1).clientId;outboxVersion++;
      await call('Page.reload');await until(ready);await evaluate(stopPolling);await refreshUi();
      const warning="(()=>{const nodes=[el('send-status'),el('outbox-status'),el('outbox-warning'),...document.querySelectorAll('[data-outbox-warning]')].filter(Boolean);return nodes.some(n=>n.getClientRects().length && /결과|미확인|확인할/.test(n.textContent));})()";
      await check('unknown text outbox warning survives reload with no automatic resend',async()=>{assert.equal(await evaluate(warning),true);assert.equal(sendCalls.length-beforeSend,1);return {actualSyntheticSends:sendCalls.length-beforeSend};});
      // Retained accepted metadata must never erase a new draft, even if the
      // new draft happens to equal an older send's text.
      const acceptedId='00000000-0000-4000-8000-000000000042';outcomes.set(acceptedId,{key,clientId:acceptedId,kind:'send',phase:'accepted',messageKey:'m_'+'6'.repeat(24)});outboxVersion++;revision++;
      await evaluate("el('compose-text').value='새 초안은 보존';el('compose-text').dispatchEvent(new Event('input'))");for(let n=0;n<3;n++)await refreshUi();
      await check('old accepted outbox state does not delete a newly composed draft',async()=>{assert.equal(await evaluate("el('compose-text').value"),'새 초안은 보존');assert.equal(sendCalls.length-beforeSend,1);return {draftPreserved:true};});
      removedRooms.add(key);roomsVersion++;revision++;await refreshUi();
      await until("!busy && !refreshing && !el('reader-disconnect').disabled && (el('reader-disconnect').click(),true)");await until("lastState.reader.phase==='disconnected' && !busy && !refreshing && !el('reader-connect').disabled");roomsVersion++;await evaluate("el('reader-connect').click()");await until(ready);await refreshUi();
      await check('unknown outbox survives removed room and reconnect without resend',async()=>{assert.equal(await evaluate(warning),true);assert.equal(outcomes.get(unknownId)?.phase,'unknown');assert.equal(sendCalls.length-beforeSend,1);return {warningForAbsentRoom:true,actualSyntheticSends:sendCalls.length-beforeSend};});
      assert.deepEqual(ackCalls,ackBaseline,'no acknowledgement occurs before the explicit action');
      await evaluate("globalThis.confirm=()=>true;const ack=document.querySelector('[data-outbox-ack]') || el('outbox-ack') || el('send-reset');ack?.click();");await sleep(150);await refreshUi();
      await check('explicit unknown acknowledgement reaches outbox ack once and never sends',async()=>{assert.deepEqual(ackCalls,[...ackBaseline,unknownId]);assert.equal(ackCalls.length-ackBaseline.length,1);assert.equal(sendCalls.length-beforeSend,1);return {previousAcknowledgements:ackBaseline.length,acknowledgements:ackCalls.length-ackBaseline.length,additionalSends:0};});
    }finally{
      if(target)await call('Target.closeTarget',{targetId:target.targetId}).catch(()=>{});for(const socket of extraSockets)socket.close();
      adversarialFixture=false;unknownSend=false;removedRooms.clear();outcomes.clear();contexts.clear();roomCapabilities.clear();settings=defaultSettings();revision++;
      const pollingRestored=await evaluate('scheduleRefresh();pollTimer!==null');assert.equal(pollingRestored,true);
      writeFileSync(resolve(folder,'synthetic-adversarial.json'),JSON.stringify({passed:results.length>0 && results.every(row=>row.passed),checks:results,polling:{scheduledAtEntry:pollingAtEntry,scheduledAfterSection:pollingRestored},actualAccountUsed:false,externalNetworkUsed:false},null,2));
    }
    assert.ok(results.length>=16,'adversarial fixture must execute its independent checks');assert.deepEqual(results.filter(row=>!row.passed).map(row=>({name:row.name,error:row.error})),[],'independent adversarial browser contracts failed');
  }
  async function checkRejectedSelection(){
    // Two real synthetic targets and the real HTTP parser. Only the first A
    // request body is held; no product response is replaced with a fake 409.
    const results=[],transportTrace=[],requests=new Set();let target,socket,held,heldBody,heldEntered=false,heldStatus;
    const baseline={adversarialFixture,enableSettings,settings};
    const quiet="clearTimeout(pollTimer);pollTimer=null;clearTimeout(queuedRefreshTimer);queuedRefreshTimer=null;refreshPending=false;showAccount(false);Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.hasFocus=()=>true;el('read-sync').checked=false;";
    const ready="typeof lastState!=='undefined' && lastState?.reader?.phase==='connected' && !busy && !refreshing && !ackInFlight";
    const counts=()=>({views:viewCalls.length,history:historyRooms.length,context:contextCalls.length,seen:seenCalls.length,send:sendCalls.length});
    const check=async(name,fn)=>{try{const observed=await fn();results.push({name,passed:true,...(observed?{observed}:{})});lifecycleChecks.push(name);}catch(error){results.push({name,passed:false,error:String(error.message).slice(0,1000)});}};
    const waitNode=async predicate=>{const end=Date.now()+10000;while(!predicate()){if(Date.now()>end)throw Error('synthetic D2 transport wait timeout');await sleep(20);}};
    const requestListener=req=>{if(req.url==='/api/reader/view' && held)heldEntered=true;};
    const bindingListener=event=>{
      const message=JSON.parse(event.data);
      if(message.method!=='Runtime.bindingCalled' || message.params.name!=='syntheticHeldView')return;
      const options=JSON.parse(message.params.payload);heldBody=options.body;heldEntered=false;
      held=http.request(url+'/api/reader/view',{method:'POST',headers:{...Object.fromEntries(options.headers),origin:url,'content-length':Buffer.byteLength(heldBody)}},response=>{
        const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{
          heldStatus=response.statusCode;
          // Body/headers contain ephemeral fixture authorization. They remain
          // in memory and are never included in artifacts or error messages.
          void evaluate(`globalThis.syntheticFinishView(${JSON.stringify({status:response.statusCode,body:Buffer.concat(chunks).toString('utf8')})})`).catch(()=>{});
        });
      });requests.add(held);held.once('close',()=>requests.delete(held));
      held.once('error',()=>{void evaluate("globalThis.syntheticFailView?.()").catch(()=>{});});
      held.write(heldBody.slice(0,12));
    };
    try{
      assert.notEqual(app.server.address().port,8787,'D2 must use an ephemeral synthetic server');
      await evaluate("globalThis.syntheticD2Environment={hidden:Object.getOwnPropertyDescriptor(document,'hidden'),visibility:Object.getOwnPropertyDescriptor(document,'visibilityState'),focus:document.hasFocus,readSync:el('read-sync').checked};");
      adversarialFixture=true;enableSettings=true;settings=defaultSettings();settingsVersion++;roomsVersion++;removedRooms.clear();
      for(const room of [key,second]){messagesByRoom.set(room,makeMessages(room));historyPhases.set(room,'loaded');contexts.set(room,'idle');roomCapabilities.set(room,{kind:'DirectChat',canSend:true,canText:true,canReply:true,canPhoto:true,canRead:true,canContext:true});pageVersions.set(room,pageVersions.get(room)+1);}revision++;
      await refreshUi();await evaluate(quiet);
      // Same CDP/launch-ticket pattern as the adversarial secondTab helper.
      target=await call('Target.createTarget',{url:await launchUrl()});
      const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();const remote=targets.find(row=>row.id===target.targetId);assert.ok(remote);
      socket=new WebSocket(remote.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
      let sequence=0;const pending=new Map();socket.addEventListener('message',event=>{const message=JSON.parse(event.data),entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(Error('D2 second target CDP error')):entry.resolve(message.result);});
      const tabCall=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('D2 second target timeout'));},5000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
      const evalTab=async expression=>{const value=await tabCall('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw Error('D2 second target evaluation failed');return value.result?.value;};
      const waitTab=async expression=>{const end=Date.now()+10000;while(!await evalTab(expression)){if(Date.now()>end)throw Error('D2 second target readiness timeout');await sleep(30);}};
      await waitTab(ready);await evalTab(quiet);
      await call('Runtime.addBinding',{name:'syntheticHeldView'});ws.addEventListener('message',bindingListener);app.server.on('request',requestListener);
      await evaluate(`globalThis.syntheticOriginalFetch=fetch;globalThis.syntheticHoldNextView=false;globalThis.fetch=(path,options={})=>{
        if(String(path)==='/api/reader/view' && globalThis.syntheticHoldNextView){globalThis.syntheticHoldNextView=false;return new Promise((resolve,reject)=>{globalThis.syntheticFinishView=value=>resolve(new Response(value.body,{status:value.status,headers:{'content-type':'application/json'}}));globalThis.syntheticFailView=()=>reject(Error('synthetic held request failed'));syntheticHeldView(JSON.stringify({body:options.body,headers:[...new Headers(options.headers)]}));});}
        return syntheticOriginalFetch(path,options);
      };`);
      const rejectSelection=async()=>{
        historyPhases.set(key,'idle');contexts.set(key,'idle');pageVersions.set(key,pageVersions.get(key)+1);revision++;held=null;heldStatus=undefined;heldEntered=false;
        await evaluate(`globalThis.syntheticSelectionDone=false;globalThis.syntheticHoldNextView=true;void selectRoom('${key}').finally(()=>globalThis.syntheticSelectionDone=true);`);
        await waitNode(()=>held && heldEntered);
        const waiting=counts(),waitingRequests=fixtureRequests.length;
        // Invalidating a view cache while its actual HTTP verdict is pending
        // cannot discard that verdict or create a replacement automatic intent.
        await evaluate("window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));invalidateViewPin();void flushSelection();void advanceRoom();void maybeSeen();");await sleep(80);
        await check('D2 waiting view does not automatically load enter or read',async()=>{const after=counts();for(const name of ['history','context','seen'])assert.equal(after[name],waiting[name],name);assert.equal(fixtureRequests.slice(waitingRequests).filter(row=>row.path==='/api/reader/view').length,0,'pending view remains the sole request after cache invalidation');return {automaticRequests:0,replacementViewRequests:0,cacheInvalidationWhilePending:true};});
        await evalTab(`void selectRoom('${second}')`);await waitTab(ready+` && selectedRoom==='${second}' && !pendingSelection`);await evalTab("document.hasFocus=()=>false;clearTimeout(pollTimer);pollTimer=null;");
        assert.equal(activeRoom,second,'B must be the last accepted server view before releasing A');
        const before=counts(),requestStart=fixtureRequests.length;held.end(heldBody.slice(12));
        await until('globalThis.syntheticSelectionDone && !busy && !refreshing && !ackInFlight');await sleep(550);
        transportTrace.push({stage:'released-stale-view',status:heldStatus,activeRoom:activeRoom===second?'B':'A',delta:Object.fromEntries(Object.entries(counts()).map(([name,value])=>[name,value-before[name]])),messageGets:fixtureRequests.slice(requestStart).filter(row=>row.path==='/api/reader/messages').length});
        await check('D2 actual HTTP stale view 409 leaves B active and dispatches zero automatic history context read',async()=>{
          assert.equal(heldStatus,409);assert.equal(activeRoom,second);const after=counts();for(const name of ['views','history','context','seen'])assert.equal(after[name],before[name],name);
          return {httpStatus:heldStatus,finalActiveRoom:'B',automaticRequests:0,messageGets:fixtureRequests.slice(requestStart).filter(row=>row.path==='/api/reader/messages').length};
        });
        return counts();
      };
      let rejected=await rejectSelection();
      // A new message and receipt revision prevent stale dispatch caches from
      // making the absence of requests vacuous. GETs remain harmless observations.
      unread.set(key,3);contexts.set(key,'idle');readStates.delete(key);historyPhases.set(key,'loaded');
      messagesByRoom.get(key).push({key:'m_'+'6'.repeat(24),text:'Synthetic D2 incoming',sender:'Synthetic peer',mine:false,at:1800000400000});
      receiptVersions.set(key,receiptVersions.get(key)+1);pageVersions.set(key,pageVersions.get(key)+1);roomsVersion++;revision++;
      await evaluate("el('read-sync').checked=true;");
      for(let n=0;n<4;n++){await refreshUi();await evaluate("(()=>{clearTimeout(pollTimer);pollTimer=null;const pane=document.querySelector('.chat-scroll');pane.scrollTop=pane.scrollHeight;pane.dispatchEvent(new Event('scroll'));showAccount(true);showAccount(false);el('rename-dialog').showModal();el('rename-dialog').close();window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));invalidateViewPin();})()");await evaluate('(async()=>{await flushSelection();await advanceRoom();await maybeSeen();})()');}
      await sleep(150);
      await check('D2 rejected intent stays inert through polls receipt changes scroll overlays focus and direct automatic callbacks',async()=>{
        const after=counts();for(const name of ['views','history','context','seen'])assert.equal(after[name],rejected[name],name);assert.equal(activeRoom,second);return {rounds:4,automaticRequests:0,finalActiveRoom:'B'};
      });
      await evaluate("el('read-sync').checked=false;");historyPhases.set(key,'idle');pageVersions.set(key,pageVersions.get(key)+1);revision++;const manual=counts();
      await evaluate(`void selectRoom('${key}')`);await until(ready+' && !pendingSelection');await sleep(550);
      await check('D2 explicit same-room reselection can accept a new view and load once',async()=>{assert.equal(viewCalls.length-manual.views,1);assert.deepEqual(historyRooms.slice(manual.history),[key]);assert.equal(activeRoom,key);return {views:1,history:1};});
      // Reject a fresh attempt again before exercising the independent manual
      // load control. B is a genuine later intention in the other target.
      await evalTab('document.hasFocus=()=>true;');await rejectSelection();
      historyPhases.set(key,'loaded');pageVersions.set(key,pageVersions.get(key)+1);revision++;await refreshUi();const explicit=counts();
      assert.equal(await evaluate("el('history-load').disabled"),false,'manual history must remain available for a rejected view');
      await evaluate("el('history-load').click()");await until(ready+' && !pendingSelection');await sleep(550);
      await check('D2 explicit manual history starts a fresh view intention and queries once',async()=>{assert.equal(viewCalls.length-explicit.views,1);assert.deepEqual(historyRooms.slice(explicit.history),[key]);assert.equal(activeRoom,key);return {views:1,history:1};});
      // A rejected intention must not poison an intentional transport reconnect.
      const reconnect=counts();await evaluate("el('reader-disconnect').click()");await until("lastState.reader.phase==='disconnected' && !busy && !refreshing && !el('reader-connect').disabled");
      await evaluate("el('reader-connect').click()");await until(ready+' && !pendingSelection');await sleep(550);
      await check('D2 reconnect restore accepts view and catches up once without automatic entry or read',async()=>{assert.deepEqual(historyRooms.slice(reconnect.history),[key]);assert.equal(contextCalls.length,reconnect.context);assert.equal(seenCalls.length,reconnect.seen);assert.equal(await evaluate('!userSelected && reconnectRoom===selectedRoom'),true);assert.equal(activeRoom,key);return {history:1,context:0,read:0};});
    }finally{
      ws.removeEventListener('message',bindingListener);app.server.off('request',requestListener);for(const request of requests)request.destroy();
      await evaluate("if(globalThis.syntheticOriginalFetch)globalThis.fetch=globalThis.syntheticOriginalFetch;delete globalThis.syntheticFinishView;delete globalThis.syntheticFailView;").catch(()=>{});
      await evaluate("if(globalThis.syntheticD2Environment){const saved=globalThis.syntheticD2Environment;if(saved.hidden)Object.defineProperty(document,'hidden',saved.hidden);else delete document.hidden;if(saved.visibility)Object.defineProperty(document,'visibilityState',saved.visibility);else delete document.visibilityState;document.hasFocus=saved.focus;el('read-sync').checked=saved.readSync;delete globalThis.syntheticD2Environment;}").catch(()=>{});
      await call('Runtime.removeBinding',{name:'syntheticHeldView'}).catch(()=>{});if(target)await call('Target.closeTarget',{targetId:target.targetId}).catch(()=>{});socket?.close();
      adversarialFixture=baseline.adversarialFixture;enableSettings=baseline.enableSettings;settings=baseline.settings;roomCapabilities.clear();contexts.clear();unread.clear();revision++;
      await evaluate('scheduleRefresh()').catch(()=>{});
      writeFileSync(resolve(folder,'synthetic-d2-rejected-selection.json'),JSON.stringify({passed:results.length>=8 && results.every(row=>row.passed),checks:results,transportTrace,transport:'real loopback HTTP parser with held body and actual 409',actualAccountUsed:false,externalNetworkUsed:false},null,2));
    }
    assert.ok(results.length>=8,'D2 must exercise waiting rejection explicit recovery and reconnect');
    assert.deepEqual(results.filter(row=>!row.passed),[],'D2 rejected selection contracts failed');
  }
  async function checkManualHistoryDeferred(){
    let completed=false;
    await until("lastState?.reader?.phase==='connected' && currentPage?.history?.phase==='loaded' && !busy && !refreshing && !ackInFlight && !pendingSelection");
    const before=historyRooms.length;
    await evaluate("clearTimeout(pollTimer);pollTimer=null;globalThis.manualHistoryFetch=fetch;globalThis.manualHistoryRelease=null;globalThis.manualHistoryHold=true;globalThis.fetch=async(path,options)=>{if(String(path)==='/api/status' && manualHistoryHold){manualHistoryHold=false;await new Promise(resolve=>{globalThis.manualHistoryRelease=resolve;});}return manualHistoryFetch(path,options);};queueRefresh(true);");
    try{
      await until("freshness==='checking' && typeof manualHistoryRelease==='function'");
      assert.equal(await evaluate("el('history-load').disabled"),false,'the enabled manual control must preserve its checking click');
      await evaluate("el('history-load').click();el('history-load').click()");
      assert.equal(historyRooms.length,before);
      assert.equal(await evaluate("pendingSelection!==null && pendingSelection===selectionView && selectionView.phase==='waiting'"),true);
      await evaluate('manualHistoryRelease();scheduleRefresh()');await until("freshness==='fresh' && !refreshing && !busy");
      await refreshUi();await until("pendingSelection===null && !busy && !refreshing && !lastState.reader.historyBusy");
      for(let n=0;n<3;n++)await refreshUi();
      assert.equal(historyRooms.length,before+1,'recovery executes one manual history without a second click');
      completed=true;lifecycleChecks.push('manual history clicked while status checking stays queued and executes once after recovery');
    }finally{
      await evaluate('globalThis.manualHistoryRelease?.();globalThis.fetch=manualHistoryFetch;scheduleRefresh();').catch(()=>{});
      writeFileSync(resolve(folder,'synthetic-manual-history-deferred.json'),JSON.stringify({passed:completed,syntheticHistoryRequests:historyRooms.length-before,actualAccountUsed:false},null,2));
    }
  }
  async function checkThemeBrowser(){
    assert.ok(['light','dark'].includes(await evaluate('document.documentElement.dataset.theme')),'the running app must apply a theme before interaction');
    assert.equal(await evaluate("Boolean(el('theme-toggle') && el('theme-mode'))"),true);
    const originalMode=await evaluate("el('theme-mode').value");
    try{
      await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});
      await evaluate("el('theme-mode').value='system';el('theme-mode').dispatchEvent(new Event('change'))");
      assert.equal(await evaluate('document.documentElement.dataset.theme'),'light');
      await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]});
      await until("document.documentElement.dataset.theme==='dark'");
      await evaluate("el('theme-toggle').click()");
      assert.equal(await evaluate('document.documentElement.dataset.theme'),'light');
      assert.equal(await evaluate("localStorage.getItem('web-kakao-theme')"),'light');
      await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});
      await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]});await sleep(60);
      assert.equal(await evaluate('document.documentElement.dataset.theme'),'light','manual mode must ignore OS changes');
      await call('Page.reload');await sleep(200);
      await until("document.readyState==='complete' && document.documentElement.dataset.theme==='light' && document.querySelectorAll('.room-item').length===2");
      assert.equal(await evaluate("el('theme-mode').value"),'light');
      assert.deepEqual(await evaluate('Object.keys(localStorage)'),['web-kakao-theme'],'the UI stores only its theme string in browser storage');
      lifecycleChecks.push('theme follows system changes and manual toggle survives reload without browser account storage');
      await call('Page.enable');
      const blocked=await call('Page.addScriptToEvaluateOnNewDocument',{source:"globalThis.syntheticStorageBlocked=true;Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('Synthetic storage unavailable','SecurityError');}});"});
      try{
        await call('Page.reload');await sleep(200);await until("document.readyState==='complete' && document.documentElement.dataset.theme==='dark' && document.querySelectorAll('.room-item').length===2");
        assert.equal(await evaluate('globalThis.syntheticStorageBlocked'),true,'the storage-denial script must actually run before the app');
        assert.equal(await evaluate("(()=>{try{void localStorage;return 'available';}catch(error){return error.name;}})()"),'SecurityError');
        writeFileSync(resolve(folder,'synthetic-storage-state.json'),JSON.stringify({injectedBeforeDocument:true,actualStorageAccess:'SecurityError',initialTheme:'dark',initialMode:'system',actualAccountUsed:false},null,2));
        assert.equal(await evaluate("el('theme-mode').value"),'system');
        await evaluate("el('theme-toggle').click()");assert.equal(await evaluate('document.documentElement.dataset.theme'),'light');
        await evaluate("el('theme-mode').value='system';el('theme-mode').dispatchEvent(new Event('change'))");
        await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});await until("document.documentElement.dataset.theme==='light'");
        await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]});await until("document.documentElement.dataset.theme==='dark'");
        lifecycleChecks.push('blocked browser storage preserves initial system theme toggle and live OS changes');
      }catch(error){writeFileSync(resolve(folder,'synthetic-storage-state.json'),JSON.stringify(await evaluate("(()=>{let storage;try{storage=localStorage.getItem('web-kakao-theme');}catch(error){storage=error.name;}return {blocked:globalThis.syntheticStorageBlocked,storage,theme:document.documentElement.dataset.theme,mode:el('theme-mode')?.value,systemDark:matchMedia('(prefers-color-scheme: dark)').matches,rooms:document.querySelectorAll('.room-item').length};})()"),null,2));throw error;}
      finally{await call('Page.removeScriptToEvaluateOnNewDocument',{identifier:blocked.identifier});await call('Page.reload');await sleep(200);await until("document.readyState==='complete' && document.querySelectorAll('.room-item').length===2");}
    }finally{
      await evaluate(`el('theme-mode').value='${originalMode}';el('theme-mode').dispatchEvent(new Event('change'))`);
      await call('Emulation.setEmulatedMedia',{features:[]});
    }
  }
  async function checkMobileAndThemes(){
    const saved={messages:messagesByRoom.get(key),read:readStates.get(key),unread:unread.get(key),latest:latestMissing.has(key)};
    const visual=[],colors={};let seq=0;
    const shot=async name=>{const image=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(resolve(folder,name+'.png'),Buffer.from(image.data,'base64'));};
    await evaluate("showAccount(false);globalThis.testHidden=false;globalThis.testFocus=false;document.hasFocus=()=>globalThis.testFocus;el('read-sync').checked=false;");
    await evaluate(`void selectRoom('${key}')`);
    await until(`currentPage?.key==='${key}' && currentPage.messages.length>0 && !busy && !refreshing && !ackInFlight && !pendingSelection`);
    messagesByRoom.set(key,[{key:'m_'+(9100).toString(16).padStart(24,'0'),text:'안녕하세요. 브라우저에서 대화를 이어가고 있어요.',sender:'모의 사용자',mine:false,canReply:true,at:1800000000000},{key:'m_'+(9101).toString(16).padStart(24,'0'),text:'A형 화면을 적용했어요. 다크 모드도 확인해 주세요.',sender:'나',mine:true,canReply:true,at:1800000001000,unreadCount:1},{key:'m_'+(9102).toString(16).padStart(24,'0'),text:'방 목록으로 돌아가도 작성 중인 메시지는 유지됩니다.',sender:'모의 사용자',mine:false,canReply:true,at:1800000002000},{key:photoMessage,text:'[사진]',sender:'모의 사용자',mine:false,at:1800000003000,photos:[{src:`/api/photo?room=${key}&message=${photoMessage}&index=0`,width:1,height:1}]},{key:'m_'+(9104).toString(16).padStart(24,'0'),text:'답장과 사진 미리보기도 확인할 수 있어요.',sender:'나',mine:true,canReply:true,at:1800000004000,reply:{text:'방 목록으로 돌아가도 작성 중인 메시지는 유지됩니다.',sender:'모의 사용자'}}]);
    unread.set(key,1);readStates.delete(key);latestMissing.delete(key);revision++;await refreshUi();
    try{
      for(const mode of ['light','dark']){
        await evaluate(`el('theme-mode').value='${mode}';el('theme-mode').dispatchEvent(new Event('change'));showAccount(false)`);
        for(const width of [1280,430,320]){
          await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
          await evaluate(`void selectRoom('${key}')`);await until('!busy && !refreshing && !ackInFlight && !pendingSelection');
          const layout=await evaluate("(()=>{const pane=document.querySelector('.chat-pane'),side=document.querySelector('.sidebar'),compose=el('compose-form'),r=pane.getBoundingClientRect(),c=compose.getBoundingClientRect();return {width:innerWidth,theme:document.documentElement.dataset.theme,overflow:document.documentElement.scrollWidth>innerWidth,chatVisible:r.width>0,sidebarWidth:side.getBoundingClientRect().width,composerInside:c.left>=0 && c.right<=innerWidth && c.bottom<=innerHeight,chatBackground:getComputedStyle(pane).backgroundColor,sideBackground:getComputedStyle(side).backgroundColor};})()");
          visual.push(layout);assert.equal(layout.theme,mode);assert.equal(layout.overflow,false);assert.equal(layout.chatVisible,true);assert.equal(layout.composerInside,true);
          if(width===1280){assert.equal(layout.sidebarWidth,340);colors[mode]={chat:layout.chatBackground,side:layout.sideBackground};}
          await shot(`synthetic-a-${mode}-${width}-chat`);
          if(width<=760){
            const sends=sendCalls.length;
            await evaluate("el('compose-text').value='모바일 보존 초안';el('compose-text').dispatchEvent(new Event('input'));globalThis.mobileFirst=document.querySelector('#message-list article');el('room-list-back').click()");
            assert.equal(await evaluate("!document.querySelector('.app-shell').classList.contains('mobile-chat') && getComputedStyle(document.querySelector('.chat-pane')).display==='none' && document.querySelector('.sidebar').getBoundingClientRect().width===innerWidth"),true);
            const reads=seenCalls.length;
            const newest='m_'+(9200+seq++).toString(16).padStart(24,'0');messagesByRoom.get(key).push({key:newest,text:'목록 뒤의 합성 새 메시지',sender:'모의 사용자',mine:false,at:1800000005000+seq});unread.set(key,1);readStates.delete(key);revision++;
            await refreshUi();await evaluate("globalThis.mobileFirst=document.querySelector('#message-list article')");
            const eligibility=await evaluate("(async()=>{userSelected=true;globalThis.testFocus=true;el('read-sync').checked=true;await maybeSeen();await maybeSeen();return {focus:document.hasFocus(),latest:currentPage.latestVisible,readOptIn:el('read-sync').checked,covered:messageViewCovered(),sameRoom:currentPage.key===selectedRoom,busy,ackInFlight};})()");
            assert.equal(eligibility.focus,true);assert.equal(eligibility.latest,true);assert.equal(eligibility.readOptIn,true);assert.equal(eligibility.sameRoom,true);assert.equal(eligibility.covered,true);assert.equal(seenCalls.length,reads,'a hidden mobile chat must enqueue zero seen/read requests even with read opt-in focus and latest page');assert.equal(unread.get(key),1);assert.equal(sendCalls.length,sends);
            visual.push({mode,width,hiddenPaneReadEligibility:eligibility,actualHiddenSeenCalls:seenCalls.length-reads});
            await shot(`synthetic-a-${mode}-${width}-list`);
            await evaluate(`globalThis.testFocus=false;el('read-sync').checked=false;void selectRoom('${key}')`);await until('!busy && !refreshing && !ackInFlight && !pendingSelection');
            assert.equal(await evaluate("document.querySelector('.app-shell').classList.contains('mobile-chat') && el('compose-text').value==='모바일 보존 초안' && globalThis.mobileFirst===document.querySelector('#message-list article')"),true,'mobile back/reopen must preserve draft and unchanged message DOM');
          }
        }
        await evaluate('showAccount(true)');await shot(`synthetic-a-${mode}-320-settings`);await evaluate('showAccount(false)');
        await evaluate("el('rename-room').click()");assert.equal(await evaluate("el('rename-dialog').open"),true);await shot(`synthetic-a-${mode}-320-dialog`);await evaluate("el('rename-cancel').click()");
      }
      assert.notEqual(colors.light.chat,colors.dark.chat,'dark theme must change the visible chat color');assert.notEqual(colors.light.side,colors.dark.side,'dark theme must change the visible sidebar color');
      lifecycleChecks.push('A layout and real theme colors fit 1280 430 and 320 pixel viewports with both mobile panes');
      lifecycleChecks.push('hidden mobile chat sends zero seen or read requests despite focus latest and read opt-in');
      lifecycleChecks.push('mobile list back and reopen preserve text draft and unchanged message DOM');
      // Back during asynchronous bitmap decoding must cancel that preview only.
      const sends=sendCalls.length;
      await evaluate(`globalThis.mobileBitmapDecoder=createImageBitmap;globalThis.mobileBitmapReady=new Promise(resolve=>globalThis.mobileBitmapStarted=resolve);globalThis.createImageBitmap=async(...args)=>{const value=await globalThis.mobileBitmapDecoder(...args);globalThis.mobileHeldBitmap=value;globalThis.mobileBitmapStarted();await new Promise(resolve=>globalThis.mobileReleaseBitmap=resolve);return value;};void prepareImage(new File([Uint8Array.from(atob('${syntheticPng.toString('base64')}'),c=>c.charCodeAt(0))],'synthetic-mobile.png',{type:'image/png'}));`);
      await until('Boolean(globalThis.mobileReleaseBitmap)');await evaluate("el('room-list-back').click();globalThis.mobileReleaseBitmap();globalThis.createImageBitmap=globalThis.mobileBitmapDecoder");
      await until("globalThis.mobileHeldBitmap.width===0 && !imagePreparing");
      assert.equal(await evaluate("imageDraft===null && !el('image-send-dialog').open && el('compose-text').value==='모바일 보존 초안'"),true);assert.equal(sendCalls.length,sends);
      lifecycleChecks.push('mobile back cancels in-flight photo preparation without sending or deleting text draft');
      await evaluate(`void selectRoom('${key}')`);await until('!busy && !refreshing && !ackInFlight && !pendingSelection');
      await evaluate("el('room-actions-toggle').focus();el('room-actions-toggle').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))");
      assert.equal(await evaluate("!el('room-actions-menu').hidden && document.activeElement===el('rename-room')"),true);
      await evaluate("globalThis.mobileMenuKeys=[];for(const type of ['keydown','keypress','keyup','click'])el('rename-room').addEventListener(type,event=>globalThis.mobileMenuKeys.push({type,key:event.key,prevented:event.defaultPrevented,trusted:event.isTrusted}));");
      // A native Enter includes its carriage-return character event. Omitting
      // text here sends keydown only and does not exercise button activation.
      await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      writeFileSync(resolve(folder,'synthetic-room-menu-keyboard.json'),JSON.stringify(await evaluate("({events:globalThis.mobileMenuKeys,renameOpen:el('rename-dialog').open,active:document.activeElement?.id})"),null,2));
      assert.equal(await evaluate("el('rename-dialog').open"),true);await evaluate("el('rename-cancel').click();el('room-actions-toggle').click();el('room-actions-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
      assert.equal(await evaluate("el('room-actions-menu').hidden && document.activeElement===el('room-actions-toggle')"),true);
      lifecycleChecks.push('room actions menu supports keyboard rename and Escape focus restoration');
      writeFileSync(resolve(folder,'synthetic-a-layout.json'),JSON.stringify({passed:true,visual,colors,actualAccountUsed:false},null,2));
    }finally{
      messagesByRoom.set(key,saved.messages);if(saved.read===undefined)readStates.delete(key);else readStates.set(key,saved.read);if(saved.unread===undefined)unread.delete(key);else unread.set(key,saved.unread);if(saved.latest)latestMissing.add(key);else latestMissing.delete(key);revision++;
      await call('Emulation.clearDeviceMetricsOverride');await evaluate("globalThis.testFocus=false;el('read-sync').checked=false;closeMessageMenu();el('compose-text').value='';el('compose-text').dispatchEvent(new Event('input'));showAccount(false)");await refreshUi();
    }
  }
  async function checkConflicts(){
    await evaluate(`void selectRoom('${key}')`);
    await until(`currentPage?.key==='${key}' && currentPage.messages.length>0 && !pendingSelection && !refreshing && !busy && !ackInFlight`);
    await evaluate("clearTimeout(pollTimer);clearTimeout(queuedRefreshTimer);pollTimer=queuedRefreshTimer=null;refreshPending=false;userSelected=false;globalThis.conflictFetch=fetch;globalThis.conflictMode=null;globalThis.conflictCodes=[];globalThis.fetch=async(path,options={})=>{if((globalThis.conflictMode==='post' && path==='/api/reader/send') || (globalThis.conflictMode==='get' && path==='/api/reader/rooms')){globalThis.conflictMode=null;globalThis.conflictCodes.push(409);return new Response(JSON.stringify({error:'action_not_ready'}),{status:409,headers:{'Content-Type':'application/json'}});}return globalThis.conflictFetch(path,options);};");
    const sends=sendCalls.length;
    try{
      const post=await evaluate("(async()=>{const failures=localFailureVersion;globalThis.conflictMode='post';const accepted=await postLocal('/api/reader/send',{room:selectedRoom,text:'synthetic conflict',clientId:crypto.randomUUID()});return {accepted,failures:localFailureVersion-failures,freshness};})()");
      assert.equal(post.accepted,false);assert.equal(post.failures,0,'HTTP409 must not mark the local server unavailable');
      await refreshUi();
      const get=await evaluate("(async()=>{const failures=localFailureVersion;globalThis.conflictMode='get';let name;try{await localJson('/api/reader/rooms');}catch(error){name=error.name;}return {name,failures:localFailureVersion-failures};})()");
      assert.equal(get.name,'LocalConflict');assert.equal(get.failures,0);
      await refreshUi();
      const refresh=await evaluate("(async()=>{const failures=localFailureVersion;globalThis.conflictMode='get';readerRevision=-1;await refresh();return {failures:localFailureVersion-failures,message:el('message').textContent};})()");
      assert.equal(refresh.failures,0);assert.equal(refresh.message.includes('로컬 서버에 연결할 수 없습니다'),false);
      await refreshUi();await until("freshness==='fresh' && !refreshing && !busy");
      assert.equal(sendCalls.length,sends,'409 recovery must not retry a rejected send');
      assert.deepEqual(await evaluate('globalThis.conflictCodes'),[409,409,409]);
      writeFileSync(resolve(folder,'synthetic-conflicts.json'),JSON.stringify({post,get,refresh,actualSendCalls:sendCalls.length-sends,actualAccountUsed:false},null,2));
      lifecycleChecks.push('HTTP409 POST and GET recover status without a server outage or automatic send retry');
    }finally{await evaluate('globalThis.fetch=globalThis.conflictFetch;scheduleRefresh();');}
  }
  async function checkHeaderLayout(){
    const results=[],panelWasHidden=await evaluate("el('account-panel').hidden");await evaluate('showAccount(false)');
    try{
      for(const width of [640,1280,850,581,580,430,320]){
        await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
        await evaluate("document.querySelector('.app-shell').classList.add('mobile-chat')");
        const layout=await evaluate("(()=>{const header=document.querySelector('.chat-header'),bounds=header.getBoundingClientRect();return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,headerHeight:bounds.height,buttons:[...header.querySelectorAll('button')].filter(button=>button.getClientRects().length && getComputedStyle(button).visibility!=='hidden').map(button=>{const r=button.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(button);return {id:button.id,height:r.height,lines:range.getClientRects().length,inside:r.left>=bounds.left && r.right<=bounds.right && r.top>=bounds.top && r.bottom<=bounds.bottom};})};})()");
        results.push(layout);writeFileSync(resolve(folder,'synthetic-header-layout.json'),JSON.stringify(results,null,2));
        if([640,430].includes(width)){const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(resolve(folder,`synthetic-header-${width}.png`),Buffer.from(shot.data,'base64'));}
        assert.equal(layout.overflow,false,`header viewport ${width} must not overflow horizontally`);
        assert.ok(layout.buttons.length>=3 && layout.buttons.every(button=>button.lines===1 && button.height<=46 && button.inside),`visible header controls at ${width} must stay compact on one text line and inside the header`);
      }
      lifecycleChecks.push('compact header controls keep one-line labels and stay inside seven viewport widths');
    }finally{await call('Emulation.clearDeviceMetricsOverride');await evaluate(`document.querySelector('.app-shell').classList.remove('mobile-chat');showAccount(${!panelWasHidden})`);}
  }
  async function checkEmptyOpenContext(){
    const saved=[messagesByRoom.get(key),historyPhases.get(key),contexts.get(key),roomCapabilities.get(key)],reads=seenCalls.length,sends=sendCalls.length;
    try{
      messagesByRoom.set(key,[]);historyPhases.set(key,'loaded');contexts.delete(key);
      roomCapabilities.set(key,{kind:'OpenMultiChat',canSend:false,canText:false,canReply:false,canPhoto:false,canRead:false,canContext:true});revision++;
      await refreshUi();await evaluate(`void selectRoom('${key}')`);
      await until(`selectedRoom==='${key}' && currentPage?.history?.phase==='loaded' && !busy && !refreshing && !pendingSelection`);
      await refreshUi();await refreshUi();
      assert.equal(contexts.get(key),'ready','an explicitly selected empty existing open room must request context');
      assert.equal(seenCalls.length,reads);assert.equal(sendCalls.length,sends);
      lifecycleChecks.push('empty existing open room can request context without sending or notifying read');
    }finally{
      for(const [map,value] of [[messagesByRoom,saved[0]],[historyPhases,saved[1]],[contexts,saved[2]],[roomCapabilities,saved[3]]]){if(value===undefined)map.delete(key);else map.set(key,value);}
      revision++;await refreshUi();
    }
  }
  async function checkPhotoConversion(){
    const results=[],before=sendCalls.length;
    const check=(name)=>{results.push({name,passed:true});lifecycleChecks.push(name);};
    await refreshUi();await evaluate(`showAccount(false);el('read-sync').checked=false;void selectRoom('${key}')`);
    await until(`selectedRoom==='${key}' && currentPage?.messages?.length===40 && !busy && !refreshing && !ackInFlight && !pendingSend && !uncertainPhoto && !el('attach-image').disabled`);
    await evaluate(`globalThis.qaPhotoFile=async(type='image/png',declared=type)=>{
      const canvas=document.createElement('canvas');canvas.width=64;canvas.height=32;
      const context=canvas.getContext('2d');context.fillStyle='#d02030';context.fillRect(32,0,32,32);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,type,.9));if(blob.type!==type)throw Error('fixture encoder unavailable');
      return new File([blob],'synthetic-photo',{type:declared});
    };globalThis.qaPhotoPixels=async()=>{const blob=new Blob([Uint8Array.from(atob(imageDraft.image),char=>char.charCodeAt(0))],{type:imageDraft.mime}),bitmap=await createImageBitmap(blob),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);bitmap.close();return {mime:blob.type,bytes:blob.size,left:[...context.getImageData(8,8,1,1).data],right:[...context.getImageData(48,8,1,1).data]};};`);
    const cancelPhoto=()=>evaluate("(async()=>{const closed=new Promise(resolve=>el('image-send-dialog').addEventListener('close',resolve,{once:true}));el('image-cancel').click();await closed;})()");
    try{
      for(const type of ['image/png','image/webp']){
        await evaluate(`(async()=>{lastState.photoTransport='https-experimental';await prepareImage(await qaPhotoFile('${type}'));})()`);
        await until("el('image-send-dialog').open && !imagePreparing && !el('image-send').disabled");
        const pixels=await evaluate('qaPhotoPixels()');assert.equal(pixels.mime,'image/jpeg');assert.ok(pixels.bytes<=10*1024*1024);
        assert.equal(decodeImage(await evaluate('imageDraft.image'))?.mime,'image/jpeg');
        assert.ok(pixels.left.slice(0,3).every(channel=>channel>=245),'alpha must become white');assert.equal(pixels.left[3],255);
        assert.ok(pixels.right[0]>170 && pixels.right[1]<75 && pixels.right[2]<100,'opaque color must survive conversion');
        assert.equal(await evaluate("!el('image-format-note').hidden && el('image-format-note').textContent.includes('흰색')"),true);
        await cancelPhoto();assert.equal(sendCalls.length,before);check(type+' converts to an opaque JPEG with a white alpha background before explicit send');
      }
      // Generate the asynchronous fixture before injecting its mode so a real
      // background status poll cannot replace the intended synthetic LOCO mode.
      await evaluate("(async()=>{const file=await qaPhotoFile();lastState.photoTransport='loco';await prepareImage(file);})()");
      await until("el('image-send-dialog').open && !imagePreparing");const legacy=await evaluate('qaPhotoPixels()');assert.equal(legacy.mime,'image/png');assert.equal(legacy.left[3],0);await cancelPhoto();
      check('explicit legacy LOCO preparation preserves PNG alpha without HTTPS conversion');
      for(const declared of ['','image/x-png']){
        await evaluate(`(async()=>{lastState.photoTransport='https-experimental';await prepareImage(await qaPhotoFile('image/png','${declared}'));})()`);
        await until("el('image-send-dialog').open && !imagePreparing");assert.equal((await evaluate('qaPhotoPixels()')).mime,'image/jpeg');
        await cancelPhoto();check('valid PNG bytes with '+(declared || 'empty MIME')+' prepare as JPEG');
      }
      await evaluate(`(async()=>{sendNotes.delete(selectedRoom);lastState.photoTransport='https-experimental';await prepareImage(new File(['GIF89a invalid'],'synthetic.png',{type:'image/png'}));})()`);
      assert.equal(await evaluate("imageDraft===null && sendNotes.get(selectedRoom).endsWith('[format]')"),true);check('a PNG MIME label cannot bypass unsupported file signature rejection');
      const fallback=await evaluate(`(async()=>{const original=createImageBitmap;globalThis.createImageBitmap=async()=>{throw new Error('synthetic bitmap unavailable');};try{lastState.photoTransport='https-experimental';await prepareImage(await qaPhotoFile());return imageDraft?.mime;}finally{globalThis.createImageBitmap=original;}})()`);
      assert.equal(fallback,'image/jpeg');await cancelPhoto();check('local image decoder fallback still produces JPEG when bitmap decoding fails');
      for(const failure of ['error','timeout']){
        const cleanup=await evaluate(`(async()=>{
          const saved={bitmap:createImageBitmap,image:Image,create:URL.createObjectURL,revoke:URL.revokeObjectURL,timeout:setTimeout,clear:clearTimeout};
          const created=[],revoked=[],deadlines=[],cleared=[];let rejected=false,timerFired=false;
          globalThis.createImageBitmap=async()=>{throw Error('synthetic native decode failure');};
          URL.createObjectURL=function(blob){const url=saved.create.call(URL,blob);created.push(url);return url;};URL.revokeObjectURL=function(url){revoked.push(url);saved.revoke.call(URL,url);};
          globalThis.setTimeout=(callback,delay,...args)=>{const handler=delay===10000?(...values)=>{timerFired=true;callback(...values);}:callback;const id=saved.timeout.call(globalThis,handler,delay===10000 && '${failure}'==='timeout'?5:delay,...args);if(delay===10000)deadlines.push({id,delay});return id;};globalThis.clearTimeout=id=>{cleared.push(id);saved.clear.call(globalThis,id);};
          if('${failure}'==='timeout')globalThis.Image=class{set src(value){}removeAttribute(){}};
          try{try{await decodeSelectedImage(new Blob([new Uint8Array([137,80,78,71,13,10,26,10]),'invalid png'],{type:'image/png'}));}catch{rejected=true;}return {rejected,created:created.length,revoked:revoked.length,sameUrl:created[0]===revoked[0],deadline:deadlines.map(row=>row.delay),timerCleared:deadlines.every(row=>cleared.includes(row.id)),timerFired};}
          finally{globalThis.createImageBitmap=saved.bitmap;globalThis.Image=saved.image;URL.createObjectURL=saved.create;URL.revokeObjectURL=saved.revoke;globalThis.setTimeout=saved.timeout;globalThis.clearTimeout=saved.clear;}
        })()`);
        assert.deepEqual(cleanup,{rejected:true,created:1,revoked:1,sameUrl:true,deadline:[10000],timerCleared:true,timerFired:failure==='timeout'});
        check('fallback decoder '+failure+' releases its local URL and original 10 second timer');
      }
      await evaluate(`globalThis.qaFallbackStarted=new Promise(resolve=>globalThis.qaFallbackSignal=resolve);globalThis.qaFallbackDone=new Promise(resolve=>globalThis.qaFallbackResolve=resolve);void(async()=>{
        const file=await qaPhotoFile(),saved={bitmap:createImageBitmap,image:Image,revoke:URL.revokeObjectURL};globalThis.qaFallbackRemoved=false;globalThis.qaFallbackRevoked=0;
        globalThis.qaFallbackRestore=()=>{globalThis.createImageBitmap=saved.bitmap;globalThis.Image=saved.image;URL.revokeObjectURL=saved.revoke;};
        globalThis.createImageBitmap=async()=>{throw Error('synthetic native decode failure');};globalThis.Image=class{constructor(){globalThis.qaFallbackImage=this;this.naturalWidth=64;this.naturalHeight=32;}set src(value){globalThis.qaFallbackUrl=value;qaFallbackSignal();}removeAttribute(){globalThis.qaFallbackRemoved=true;}};
        URL.revokeObjectURL=function(url){if(url===globalThis.qaFallbackUrl)globalThis.qaFallbackRevoked++;saved.revoke.call(URL,url);};
        try{lastState.photoTransport='https-experimental';await prepareImage(file);}finally{qaFallbackRestore();qaFallbackResolve();}
      })();`);
      await evaluate('qaFallbackStarted');await evaluate(`void selectRoom('${second}')`);
      await until(`selectedRoom==='${second}' && currentPage?.key==='${second}' && !busy && !refreshing && !ackInFlight`);
      await evaluate('qaFallbackImage.onload();qaFallbackDone');
      assert.equal(await evaluate('qaFallbackRemoved && qaFallbackRevoked===1 && imageDraft===null && !imagePreparing'),true);
      assert.equal(sendCalls.length,before);check('room change during fallback decoding releases the stale source without preview or send');
      await evaluate(`void selectRoom('${key}')`);await until(`selectedRoom==='${key}' && currentPage?.key==='${key}' && !busy && !refreshing && !ackInFlight`);
      const qualityPass=await evaluate(`(async()=>{const original=HTMLCanvasElement.prototype.toBlob,attempts=[];const file=await qaPhotoFile();HTMLCanvasElement.prototype.toBlob=function(callback,mime,quality){attempts.push(quality);if(attempts.length<3)callback(new Blob([new Uint8Array(10*1024*1024+1)],{type:mime}));else original.call(this,callback,mime,quality);};try{lastState.photoTransport='https-experimental';await prepareImage(file);return {attempts,mime:imageDraft?.mime};}finally{HTMLCanvasElement.prototype.toBlob=original;}})()`);
      assert.deepEqual(qualityPass,{attempts:[.9,.8,.7],mime:'image/jpeg'});await cancelPhoto();check('oversized JPEG preparation adjusts quality locally at most three times');
      const qualityFailure=await evaluate(`(async()=>{const original=HTMLCanvasElement.prototype.toBlob,attempts=[];const file=await qaPhotoFile();HTMLCanvasElement.prototype.toBlob=function(callback,mime,quality){attempts.push(quality);callback(new Blob([new Uint8Array(10*1024*1024+1)],{type:mime}));};try{sendNotes.delete(selectedRoom);lastState.photoTransport='https-experimental';await prepareImage(file);return {attempts,draft:imageDraft!==null,note:sendNotes.get(selectedRoom)};}finally{HTMLCanvasElement.prototype.toBlob=original;}})()`);
      assert.deepEqual(qualityFailure.attempts,[.9,.8,.7]);assert.equal(qualityFailure.draft,false);assert.ok(qualityFailure.note.endsWith('[output-size]'));check('three oversized JPEG results fail before upload without a fourth encoding');
      const mismatch=await evaluate(`(async()=>{const original=HTMLCanvasElement.prototype.toBlob,file=await qaPhotoFile();HTMLCanvasElement.prototype.toBlob=callback=>callback(new Blob(['synthetic wrong mime'],{type:'image/png'}));try{sendNotes.delete(selectedRoom);lastState.photoTransport='https-experimental';await prepareImage(file);return imageDraft===null && sendNotes.get(selectedRoom).endsWith('[encode]');}finally{HTMLCanvasElement.prototype.toBlob=original;}})()`);
      assert.equal(mismatch,true);check('a browser output MIME mismatch cannot reach the JPEG-only uploader');
      // Cancellation between encoding passes must discard the old bytes and stop
      // additional quality attempts, even after a room change has finished.
      await evaluate(`globalThis.qaBlobOriginal=HTMLCanvasElement.prototype.toBlob;globalThis.qaBlobAttempts=0;globalThis.qaBlobStarted=new Promise(resolve=>globalThis.qaBlobSignal=resolve);globalThis.qaHeldBlobDone=new Promise(resolve=>globalThis.qaHeldBlobResolve=resolve);void(async()=>{const file=await qaPhotoFile();HTMLCanvasElement.prototype.toBlob=function(callback,mime){qaBlobAttempts++;globalThis.qaBlobRelease=()=>callback(new Blob([new Uint8Array(10*1024*1024+1)],{type:mime}));qaBlobSignal();};lastState.photoTransport='https-experimental';await prepareImage(file);qaHeldBlobResolve();})();`);
      await evaluate('qaBlobStarted');await evaluate(`void selectRoom('${second}')`);
      await until(`selectedRoom==='${second}' && currentPage?.key==='${second}' && !busy && !refreshing && !ackInFlight`);
      await evaluate('HTMLCanvasElement.prototype.toBlob=qaBlobOriginal;qaBlobRelease();qaHeldBlobDone');
      assert.equal(await evaluate('qaBlobAttempts===1 && imageDraft===null && !imagePreparing && !el("image-send-dialog").open'),true);
      assert.equal(sendCalls.length,before);check('room change during JPEG encoding discards old bytes and stops subsequent quality passes');
      // Submit the exact JPEG preview bytes through the actual app HTTP route.
      await evaluate("(async()=>{lastState.photoTransport='https-experimental';await prepareImage(await qaPhotoFile('image/webp'));})()");
      await until("el('image-send-dialog').open && !el('image-send').disabled");const expected=await evaluate('imageDraft.image');
      assert.equal(decodeImage(expected)?.mime,'image/jpeg');
      await evaluate("el('image-send').click();el('image-send').click()");
      await until('pendingSend===null && imageDraft===null && !imagePreparing');
      assert.equal(sendCalls.length,before+1);assert.equal(sendCalls.at(-1).room,second);assert.equal(sendCalls.at(-1).mime,'image/jpeg');assert.equal(photoPayloads.at(-1),expected);
      check('converted WebP preview bytes reach the actual photo POST handler exactly once as JPEG');
    }finally{
      await evaluate("globalThis.qaFallbackRestore?.();if(globalThis.qaBlobOriginal)HTMLCanvasElement.prototype.toBlob=qaBlobOriginal;clearImageDraft();sendNotes.delete(selectedRoom);scheduleRefresh()").catch(()=>{});
      writeFileSync(resolve(folder,'synthetic-photo-conversion.json'),JSON.stringify({passed:results.length===15,checks:results,actualAccountUsed:false,actualMessagesSent:0,syntheticSends:sendCalls.length-before},null,2));
    }
  }
  async function checkDiagnosisRecovery(){
    const results=[];
    const record=name=>{results.push({name,passed:true});lifecycleChecks.push(name);};
    await until("!busy && !refreshing && !ackInFlight && !pendingSelection && !pendingSend && !uncertainPhoto");
    await evaluate("clearTimeout(pollTimer);pollTimer=null;showAccount(false);clearImageDraft();globalThis.diagnosisOriginalFetch=fetch;");
    try{
      for(const phase of ['accepted','failed','unknown']){
        unknownPhoto=true;const before=sendCalls.length,acks=ackCalls.length;
        await evaluate(`prepareImage(new File([Uint8Array.from(atob('${syntheticPng.toString('base64')}'),c=>c.charCodeAt(0))],'synthetic-lost-response.png',{type:'image/png'}))`);
        await until("el('image-send-dialog').open && !el('image-send').disabled");
        await evaluate("globalThis.dropPhotoResponse=true;globalThis.fetch=async(input,options)=>{const response=await diagnosisOriginalFetch(input,options);if(dropPhotoResponse && String(input)==='/api/reader/photo'){dropPhotoResponse=false;await response.arrayBuffer();throw new TypeError('synthetic response loss after server processing');}return response;};el('image-send').click();");
        await until("uncertainPhoto!==null && pendingSend===null && !refreshing");
        assert.equal(sendCalls.length,before+1);const request=sendCalls.at(-1);
        assert.equal(await evaluate('uncertainPhoto.clientId'),request.clientId);
        outcomes.set(request.clientId,{...outcomes.get(request.clientId),phase});outboxVersion++;revision++;
        await refreshUi();
        if(phase==='unknown'){
          assert.equal(await evaluate("uncertainPhoto!==null && el('attach-image').disabled"),true);
          await refreshUi();assert.equal(sendCalls.length,before+1);
          await evaluate("globalThis.confirm=()=>true;el('send-reset').click()");
          await until('uncertainPhoto===null && !outboxAcknowledging');assert.equal(ackCalls.length,acks+1);
        }else{
          await until('uncertainPhoto===null && pendingSend===null');assert.equal(ackCalls.length,acks);
          assert.equal(await evaluate('imageDraft===null'),phase==='accepted');
        }
        assert.equal(await evaluate("!el('attach-image').disabled && el('send-reset').hidden"),true);
        assert.equal(sendCalls.length,before+1,'outcome recovery never repeats the photo POST');
        record('lost photo HTTP response recovers '+phase+' with one synthetic send and correct attachment state');
        await evaluate('clearImageDraft();globalThis.fetch=diagnosisOriginalFetch;');
      }
      unknownPhoto=false;
      const before=viewCalls.length;
      await evaluate(`globalThis.holdViewResponse=true;globalThis.releaseDiagnosisView=null;globalThis.fetch=async(input,options)=>{const response=await diagnosisOriginalFetch(input,options);if(holdViewResponse && String(input)==='/api/reader/view'){holdViewResponse=false;await new Promise(resolve=>{globalThis.releaseDiagnosisView=resolve;});}return response;};void selectRoom('${key}');`);
      await until("typeof releaseDiagnosisView==='function'");
      await evaluate(`void selectRoom('${second}')`);
      await until(`selectedRoom==='${second}' && viewPin===JSON.stringify([readerGeneration,readerAttempt,selectedRoom]) && !pendingSelection && !busy && !refreshing`);
      await evaluate('releaseDiagnosisView()');await refreshUi();
      assert.deepEqual(viewCalls.slice(before),[key,second]);
      assert.equal(await evaluate(`selectedRoom==='${second}' && viewPin===JSON.stringify([readerGeneration,readerAttempt,selectedRoom])`),true);
      record('late A view response cannot overwrite accepted B selection or cached view in the browser');
    }finally{
      unknownPhoto=false;
      await evaluate('globalThis.releaseDiagnosisView?.();globalThis.fetch=diagnosisOriginalFetch;clearImageDraft();scheduleRefresh();').catch(()=>{});
      writeFileSync(resolve(folder,'synthetic-diagnosis-recovery.json'),JSON.stringify({passed:results.length===4,checks:results,actualAccountUsed:false,actualMessagesSent:0},null,2));
    }
  }
  async function checkDefaultHttpsLifecycle(){
    const results=[],beforeSend=sendCalls.length,beforeAuth=app.lab.snapshot().requests;
    let completed=false;
    const record=name=>{results.push({name,passed:true});lifecycleChecks.push(name);};
    const clearLocal=async name=>{
      await evaluate("showAccount(true);el('cancel').click()");
      await until("!hasAccount && selectedRoom===null && el('message-list').childElementCount===0 && !busy && !refreshing && !el('start').disabled");
      assert.equal(app.lab.snapshot().credentialInMemory,false);assert.equal(connected,false);
      assert.equal(await evaluate("lastState.photoTransport==='https' && imageDraft===null && !imagePreparing && pendingSend===null && uncertainPhoto===null && drafts.size===0 && replyDrafts.size===0 && pinnedRooms.size===0 && !el('image-preview').hasAttribute('src') && el('qr').hidden && el('passcode').hidden && el('compose-text').value===''") ,true);
      record(name);
    };
    try{
      settings=defaultSettings();roomSettings.clear();roomCapabilities.clear();unknownSend=false;unknownPhoto=false;revision++;
      await clearLocal('default HTTPS local-session clear removes credentials room data drafts previews and pending sends');
      allowAuth=false;requirePasscode=true;rejectNextQr=false;
      await evaluate("el('start').click()");await until("!el('qr').hidden");
      await until("!el('passcode').hidden && el('code').textContent==='0000'");
      assert.equal(await evaluate("lastState.photoTransport==='https' && !hasAccount"),true);
      requirePasscode=false;await clearLocal('cancel during QR approval clears both QR and passcode and allows a new QR');
      for(let cycle=0;cycle<2;cycle++){
        allowAuth=false;await evaluate("el('start').click()");await until("!el('qr').hidden && lastState.photoTransport==='https'");
        allowAuth=true;await until("!el('reader-connect').disabled");await evaluate("el('reader-connect').click()");
        await until("lastState.reader.phase==='connected' && document.querySelectorAll('.room-item').length===2 && !busy && !refreshing");
        await evaluate(`showAccount(false);el('read-sync').checked=false;void selectRoom('${key}')`);
        await until(`currentPage?.key==='${key}' && currentPage.messages.length===40 && el('compose-text').value==='' && !el('attach-image').disabled && !busy && !refreshing && !ackInFlight`);
        assert.equal(await evaluate("lastState.photoTransport==='https' && el('mode').textContent.includes('HTTPS 사진 전송')"),true);
        record('QR login '+(cycle+1)+' and fresh room connection retain default HTTPS without an explicit photo option');
        const start=sendCalls.length;
        await evaluate(`el('compose-text').value='Synthetic default HTTPS lifecycle ${cycle+1}';el('compose-text').dispatchEvent(new Event('input'));el('send-message').click()`);
        await until("pendingSend===null && el('compose-text').value===''");assert.equal(sendCalls.length,start+1);assert.equal(sendCalls.at(-1).text,'Synthetic default HTTPS lifecycle '+(cycle+1));
        if(cycle===0){
          const path=resolve(folder,'default-https-lifecycle.png');writeFileSync(path,syntheticPng);const doc=await call('DOM.getDocument'),input=await call('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#image-file'});await call('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[path]});
        }else await evaluate(`(()=>{const data=new DataTransfer();data.items.add(new File([Uint8Array.from(atob('${syntheticPng.toString('base64')}'),c=>c.charCodeAt(0))],'synthetic.png',{type:'image/png'}));el('compose-text').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`);
        await until("el('image-send-dialog').open && !el('image-send').disabled");const image=await evaluate('imageDraft.image');assert.equal(decodeImage(image)?.mime,'image/jpeg');
        await evaluate("el('image-send').click();el('image-send').click()");await until('pendingSend===null && imageDraft===null');assert.equal(sendCalls.length,start+2);assert.equal(sendCalls.at(-1).mime,'image/jpeg');assert.equal(photoPayloads.at(-1),image);
        record('default HTTPS cycle '+(cycle+1)+' sends text and converted PNG bytes once through the app HTTP route');
        await evaluate("el('compose-text').value='Synthetic draft that must be cleared';el('compose-text').dispatchEvent(new Event('input'))");
        await clearLocal('authenticated local-session clear '+(cycle+1)+' discards the account and composed draft while preserving HTTPS selection');
      }
      assert.equal(sendCalls.length-beforeSend,4);assert.equal(app.lab.snapshot().requests.generate-beforeAuth.generate,3);
      assert.equal(results.length,8);
      completed=true;
    }finally{
      requirePasscode=false;allowAuth=true;
      writeFileSync(resolve(folder,'synthetic-default-https-lifecycle.json'),JSON.stringify({passed:completed,checks:results,syntheticSends:sendCalls.length-beforeSend,qrGenerations:app.lab.snapshot().requests.generate-beforeAuth.generate,actualAccountUsed:false,actualMessagesSent:0},null,2));
    }
  }
  async function checkCapabilities(){
    roomCapabilities.set(key,{kind:'OpenMultiChat',canSend:true,canText:true,canPhoto:false,canReply:false,canRead:false,canContext:false});revision++;
    await refreshUi();
    await evaluate(`showAccount(false);globalThis.testHidden=false;globalThis.testFocus=true;document.hasFocus=()=>true;el('read-sync').checked=true;void selectRoom('${key}')`);
    await until(`selectedRoom==='${key}' && currentPage?.messages?.length>0 && !busy && !refreshing && !ackInFlight`);
    assert.equal(await evaluate("!el('compose-text').disabled && el('attach-image').disabled"),true,'text permission must not enable photos');
    await evaluate("document.querySelector('#message-list article').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:300,clientY:200}))");
    assert.equal(await evaluate("el('message-menu-reply').hidden"),true,'text permission must not enable reply');
    await evaluate("closeMessageMenu();userSelected=true;document.querySelector('.chat-scroll').scrollTop=document.querySelector('.chat-scroll').scrollHeight");
    const reads=seenCalls.filter(call=>call.notify).length,sends=sendCalls.length;
    readStates.delete(key);revision++;await refreshUi();await evaluate('maybeSeen()');
    assert.equal(seenCalls.filter(call=>call.notify).length,reads,'canRead=false must issue zero remote notifications');
    lifecycleChecks.push('open text permission does not enable photo reply or remote read');
    roomCapabilities.set(key,{kind:'OpenMultiChat',canSend:false,canText:false,canPhoto:true,canReply:false,canRead:false,canContext:false});revision++;
    await refreshUi();assert.equal(await evaluate("el('compose-text').disabled && !el('attach-image').disabled"),true,'photo permission is independent of text');
    // UI-only state injection. The offline server keeps messaging=true; this
    // checks real DOM guidance/guards without claiming server-mode coverage.
    const beforeGuidance={sends:sendCalls.length,reads:seenCalls.length,posts:fixtureRequests.filter(row=>row.method==='POST' && ['/api/reader/send','/api/reader/photo'].includes(row.path)).length};
    const guidance=await evaluate(`(()=>{
      const room=roomNow(),originalRoom={...room},saved={messaging:lastState.messaging,hasMessaging:Object.hasOwn(lastState,'messaging'),pendingSend,uncertainPhoto,restoredOutbox,freshness,phase:lastState.reader.phase,text:el('compose-text').value,hasDraft:drafts.has(selectedRoom),draft:drafts.get(selectedRoom),hasNote:sendNotes.has(selectedRoom),note:sendNotes.get(selectedRoom),hasReply:replyDrafts.has(selectedRoom),reply:replyDrafts.get(selectedRoom)};
      const rows=[],draft='전송 모드 안내 합성 초안';
      const reset=()=>{pendingSend=null;uncertainPhoto=null;restoredOutbox=[];freshness='fresh';lastState.reader.phase='connected';lastState.messaging=false;sendNotes.delete(selectedRoom);replyDrafts.delete(selectedRoom);};
      const capture=name=>{renderComposer();rows.push({name,status:el('send-status').textContent,textDisabled:el('compose-text').disabled,photoDisabled:el('attach-image').disabled,sendDisabled:el('send-message').disabled,imageSendDisabled:el('image-send').disabled,text:el('compose-text').value,draft:drafts.get(selectedRoom)});};
      try{
        el('compose-text').value=draft;drafts.set(selectedRoom,draft);
        for(const kind of ['DirectChat','OpenMultiChat'])for(const mode of ['off','missing']){
          reset();Object.assign(room,{kind,canSend:true,canText:true,canPhoto:true,canReply:false,canRead:false,canContext:false});
          if(mode==='missing')delete lastState.messaging;
          capture(kind+'-'+mode);el('send-message').click();el('attach-image').click();el('compose-text').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
        }
        reset();Object.assign(room,{kind:'OpenMultiChat',canSend:false,canText:false,canPhoto:true});lastState.messaging=true;capture('photo-only-on');
        reset();pendingSend={kind:'text',phase:'sending',clientId:'guidance-text'};capture('pending-text');
        reset();pendingSend={kind:'photo',phase:'sending',clientId:'guidance-photo'};capture('pending-photo');
        reset();pendingSend={kind:'text',phase:'unknown',clientId:'guidance-unknown'};capture('pending-unknown');
        reset();restoredOutbox=[{kind:'text',phase:'sending',clientId:'guidance-restored'}];capture('recovered-sending');
        reset();restoredOutbox=[{kind:'photo',phase:'unknown',clientId:'guidance-restored-unknown'}];capture('recovered-unknown');
        reset();uncertainPhoto={kind:'photo',phase:'unknown',clientId:'guidance-uncertain'};capture('uncertain-photo');
        reset();freshness='checking';capture('checking');
        reset();freshness='unavailable';capture('unavailable');
        reset();sendNotes.set(selectedRoom,'합성 전송 안내 우선');capture('send-note');
        reset();lastState.reader.phase='disconnected';capture('disconnected');
        return rows;
      }finally{
        for(const field of Object.keys(room))delete room[field];Object.assign(room,originalRoom);
        if(saved.hasMessaging)lastState.messaging=saved.messaging;else delete lastState.messaging;
        pendingSend=saved.pendingSend;uncertainPhoto=saved.uncertainPhoto;restoredOutbox=saved.restoredOutbox;freshness=saved.freshness;lastState.reader.phase=saved.phase;el('compose-text').value=saved.text;
        if(saved.hasDraft)drafts.set(selectedRoom,saved.draft);else drafts.delete(selectedRoom);
        if(saved.hasNote)sendNotes.set(selectedRoom,saved.note);else sendNotes.delete(selectedRoom);
        if(saved.hasReply)replyDrafts.set(selectedRoom,saved.reply);else replyDrafts.delete(selectedRoom);
        renderComposer();
      }
    })()`);
    const guidanceNotes={'photo-only-on':'이 방에서는 사진을 보낼 수 있습니다.','pending-text':'메시지를 보내고 있습니다…','pending-photo':'사진을 보내고 있습니다…','recovered-sending':'이전 전송의 결과를 확인하고 있습니다. 다시 보내지 마세요.','checking':'연결 상태를 확인하고 있습니다…','unavailable':'로컬 서버 연결을 확인해 주세요. 입력한 내용은 유지됩니다.','send-note':'합성 전송 안내 우선','disconnected':'계정을 연결하고 대화방을 선택해 주세요.'};
    assert.equal(guidance.length,15);
    for(const row of guidance){
      assert.equal(row.text,'전송 모드 안내 합성 초안',row.name);assert.equal(row.draft,row.text,row.name);
      assert.equal(row.textDisabled,true,row.name);assert.equal(row.sendDisabled,true,row.name);assert.equal(row.imageSendDisabled,true,row.name);
      assert.equal(row.photoDisabled,row.name!=='photo-only-on',row.name);
      if(['pending-unknown','recovered-unknown','uncertain-photo'].includes(row.name))assert.match(row.status,/전송 결과를 확인할 수 없습니다.*자동으로 다시 보내지 않습니다/,row.name);
      else assert.equal(row.status,guidanceNotes[row.name] || '현재 읽기 전용으로 연결되어 있습니다.',row.name);
      lifecycleChecks.push('composer guidance '+row.name+' preserves draft and action restrictions');
    }
    await sleep(100);assert.equal(sendCalls.length,beforeGuidance.sends);assert.equal(seenCalls.length,beforeGuidance.reads);assert.equal(fixtureRequests.filter(row=>row.method==='POST' && ['/api/reader/send','/api/reader/photo'].includes(row.path)).length,beforeGuidance.posts);
    lifecycleChecks.push('composer guidance state simulation sends zero text photo or seen requests');
    await evaluate(`prepareImage(new File([Uint8Array.from(atob('${syntheticPng.toString('base64')}'),c=>c.charCodeAt(0))],'synthetic-capability.png',{type:'image/png'}))`);
    assert.equal(await evaluate("el('image-send-dialog').open && !el('image-send').disabled"),true);
    await evaluate("el('image-cancel').click();el('read-sync').checked=false");assert.equal(sendCalls.length,sends);
    lifecycleChecks.push('open photo-only preview and cancel sends zero messages');
    roomCapabilities.delete(key);revision++;await refreshUi();
    // Two event handlers can run after HTTP enqueue but before the next page
    // refresh. Hold that stale view deliberately rather than relying on timing.
    await evaluate("userSelected=false;clearTimeout(pollTimer);pollTimer=null");
    messagesByRoom.get(key).push({key:'m_'+'f'.repeat(24),text:'합성 읽음 중복 경계',sender:'모의 사용자',mine:false,at:1800000200000});unread.set(key,1);readStates.delete(key);revision++;
    await refreshUi();const beforeSeen=seenCalls.length;
    await evaluate("(async()=>{userSelected=true;el('read-sync').checked=false;const pane=document.querySelector('.chat-scroll');pane.scrollTop=pane.scrollHeight;await maybeSeen();await maybeSeen();})()");
    assert.equal(seenCalls.length,beforeSeen+1,'same stale view must enqueue seen once');
    await refreshUi();await evaluate('scheduleRefresh()');
    lifecycleChecks.push('stale view after HTTP enqueue cannot submit duplicate seen requests');
  }
  async function checkSelectionBusy(){
    await refreshUi();await evaluate("clearTimeout(pollTimer);pollTimer=null;userSelected=false");
    messagesByRoom.delete(second);historyPhases.delete(second);
    // Status can still say idle while another history request holds the worker.
    // Record the explicit rejection, then let a new revision release the queue.
    historyBusy=true;revision++;
    await evaluate("globalThis.selectionResponses=[];globalThis.selectionFetch=fetch;globalThis.fetch=async(...args)=>{const response=await globalThis.selectionFetch(...args);if(String(args[0])==='/api/reader/history')globalThis.selectionResponses.push(response.status);return response;}");
    try{
      await evaluate(`void selectRoom('${second}')`);
      await until("globalThis.selectionResponses.includes(409) && !busy && !refreshing");
      assert.equal(await evaluate(`pendingSelection?.key==='${second}'`),true,'explicitly rejected history must retain the latest room selection');
      const before=historyRooms.filter(room=>room===second).length;
      historyBusy=false;revision++;await refreshUi();await evaluate('scheduleRefresh()');
      const expectedMessages=makeMessages(second).length+(offlineMessages.get(second)?.length || 0);
      await until(`currentPage?.messages?.length===${expectedMessages} && !busy && !refreshing`);
      assert.equal(historyRooms.filter(room=>room===second).length,before+1);
      assert.equal(await evaluate('pendingSelection'),null);
      lifecycleChecks.push('history 409 retains latest selection until a new worker revision and accepts it once');
    }finally{historyBusy=false;await evaluate('globalThis.fetch=globalThis.selectionFetch;scheduleRefresh()');}
  }
  async function checkLifecycle(){
  await evaluate("globalThis.testFocus=true;document.hasFocus=()=>globalThis.testFocus;");
  // All lifecycle traffic stays on the injected synthetic loopback server.
  // Abort-ignoring headers/body readers exercise Promise.race, not just abort.
  // Capture production timer classes, then scale only test deadlines to 80 ms.
  await evaluate("document.getElementById('filter-all').click()");await until("roomFilter==='all' && !settingsBusy && !refreshing");
  await evaluate("document.querySelectorAll('.room-item')[0].click()");await until("currentPage?.messages?.length>0 && !refreshing && !ackInFlight");
  await evaluate(`globalThis.qaFetch=fetch;globalThis.qaSetTimeout=setTimeout;globalThis.qaMode=null;globalThis.qaHeld=[];globalThis.qaRequests=[];globalThis.qaDeadlines=[];globalThis.qaFast=false;globalThis.qaPatch=null;globalThis.qaStatusActive=0;globalThis.qaStatusMaximum=0;
    globalThis.setTimeout=(fn,ms,...args)=>{if(globalThis.qaFast && [12000,30000,80000].includes(ms)){globalThis.qaDeadlines.push(ms);return globalThis.qaSetTimeout(fn,80,...args);}return globalThis.qaSetTimeout(fn,ms,...args);};
    globalThis.fetch=async(input,options={})=>{
      const path=String(input);globalThis.qaRequests.push({path,method:options.method || 'GET',body:options.body || null});const mode=globalThis.qaMode;
      const status=path==='/api/status';let finished=false;if(status){globalThis.qaStatusActive++;globalThis.qaStatusMaximum=Math.max(globalThis.qaStatusMaximum,globalThis.qaStatusActive);}
      const finish=()=>{if(status && !finished){finished=true;globalThis.qaStatusActive--;}};
      const wrap=response=>status?{ok:response.ok,status:response.status,async json(){try{return await response.json();}finally{finish();}}}:response;
      if(mode==='status-headers' && status){globalThis.qaMode=null;return new Promise(resolve=>globalThis.qaHeld.push(async()=>resolve(wrap(await globalThis.qaFetch(input,{...options,signal:undefined})))));}
      let response;try{response=await globalThis.qaFetch(input,options);}catch(error){finish();throw error;}
      if(mode==='status-body' && path==='/api/status' || mode==='send-body' && path==='/api/reader/send' || mode==='act-body' && path==='/api/reader/disconnect' || mode==='old-A' && path.includes('/api/reader/messages?')){
        globalThis.qaMode=null;const data=await response.json();if(mode==='old-A' && data.messages?.length)data.messages[0].text='STALE-A-MUST-NOT-RENDER';
        return wrap({ok:response.ok,status:response.status,json:()=>new Promise(resolve=>globalThis.qaHeld.push(()=>resolve(data)))});
      }
      if(status && globalThis.qaPatch){const data=await response.json();Object.assign(data,globalThis.qaPatch,{reader:{...data.reader,...globalThis.qaPatch.reader}});return wrap({ok:response.ok,status:response.status,json:async()=>data});}
      return wrap(response);
    };`);
  try{
  const stopPoll=()=>evaluate("clearTimeout(pollTimer);pollTimer=null;clearTimeout(queuedRefreshTimer);queuedRefreshTimer=null;refreshPending=false;");
  const readyPage=async()=>{const deadline=Date.now()+6000;while(!await evaluate("currentPage?.key===selectedRoom && currentPage.messages.length>0 && currentPage.history?.phase==='loaded' && !busy && !refreshing")){if(Date.now()>deadline)throw new Error('synthetic history did not settle');await refreshUi();await sleep(20);}};
  await refreshUi();await stopPoll();
  await evaluate("document.getElementById('compose-text').value='poll-focus-draft';document.getElementById('compose-text').dispatchEvent(new Event('input'));document.getElementById('compose-text').focus()");
  await refreshUi();await refreshUi();assert.equal(await evaluate("document.activeElement.id==='compose-text' && !document.getElementById('compose-text').disabled && document.getElementById('compose-text').value==='poll-focus-draft' && freshness==='fresh'"),true);
  lifecycleChecks.push('ordinary fresh polls preserve continuous composer focus');
  const selectionRaceResults=[];
  for(const order of ['selection-first','poll-first']){
    await stopPoll();const room=await evaluate('selectedRoom'),beforeHistory=historyRooms.length;
    messagesByRoom.delete(room);historyPhases.delete(room);revision++;
    await evaluate(`readerRevision=-1;globalThis.qaMode='old-A';void ${order==='selection-first'?'selectRoom(selectedRoom)':'refresh()'}`);await until('globalThis.qaHeld.length===1');
    if(order==='selection-first')await refreshUi();
    else {await evaluate('void selectRoom(selectedRoom)');await until('pendingSelection!==null || busy || currentPage?.history?.phase!==undefined');}
    await evaluate('globalThis.qaHeld.shift()()');await until('!busy && !refreshing && !refreshPending');await stopPoll();
    selectionRaceResults.push({order,expectedHistoryRequests:1,actualHistoryRequests:historyRooms.length-beforeHistory});
    // Leave the fixture loaded for the next independent scenario even when a
    // regression was observed; the final assertion still fails this run.
    if(historyRooms.length===beforeHistory)await evaluate('void act("/api/reader/history",{room:selectedRoom})');
    await readyPage();await stopPoll();
  }
  const beforeLoadedSelection=historyRooms.length;await evaluate('void selectRoom(selectedRoom)');await readyPage();await refreshUi();assert.equal(historyRooms.length,beforeLoadedSelection);
  writeFileSync(resolve(folder,'synthetic-selection-race.json'),JSON.stringify({scope:'synthetic only',results:selectionRaceResults},null,2));
  lifecycleChecks.push('initial idle room selection versus polling GET in both response orders');
  for(const mode of ['status-headers','status-body']){
    await stopPoll();const sends=sendCalls.length,reads=seenCalls.length;
    await evaluate(`globalThis.qaMode='${mode}';globalThis.qaFast=true;void refresh();`);await until("globalThis.qaHeld.length===1");await until("!refreshing && freshness==='unavailable'");
    assert.equal(await evaluate("document.getElementById('compose-text').disabled && document.getElementById('attach-image').disabled && document.getElementById('send-message').disabled && document.getElementById('compose-text').value==='poll-focus-draft'"),true);
    await evaluate("document.getElementById('compose-form').requestSubmit();void maybeSeen();globalThis.qaHeld.shift()();globalThis.qaFast=false;");await sleep(30);
    assert.equal(await evaluate("freshness==='unavailable' && !refreshing"),true);assert.equal(sendCalls.length,sends);assert.equal(seenCalls.length,reads);
    await refreshUi();assert.equal(await evaluate("freshness==='fresh' && !document.getElementById('compose-text').disabled"),true);
  }
  assert.equal(await evaluate('globalThis.qaDeadlines.filter(ms=>ms===12000).length>=2'),true);
  lifecycleChecks.push('header and body stalls release locks preserve draft and reject late success');
  await stopPoll();await evaluate("globalThis.qaMode='old-A';void refreshMessages(selectedRoom,readerGeneration)");await until("globalThis.qaHeld.length===1");
  await evaluate("document.querySelectorAll('.room-item')[1].click()");await readyPage();
  await evaluate("document.querySelectorAll('.room-item')[0].click()");await readyPage();
  await evaluate("globalThis.qaHeld.shift()()");await sleep(30);
  assert.equal(await evaluate("!document.getElementById('message-list').textContent.includes('STALE-A-MUST-NOT-RENDER') && !currentPage.messages.some(message=>message.text==='STALE-A-MUST-NOT-RENDER')"),true);
  lifecycleChecks.push('A to B to A rejects older same-room GET by request identity');
  await refreshUi();await stopPoll();const resumeReads=seenCalls.length,resumeSends=sendCalls.length;
  await evaluate("globalThis.qaRequests=[];globalThis.qaMode='status-body';void refresh()");await until("globalThis.qaHeld.length===1");
  await evaluate("window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));window.dispatchEvent(new Event('online'))");
  assert.equal(await evaluate("refreshing && refreshPending && !userSelected && globalThis.qaRequests.filter(r=>r.path==='/api/status').length===1"),true);
  await evaluate("globalThis.qaHeld.shift()()");await until("!refreshing && !refreshPending && freshness==='fresh'");await stopPoll();
  assert.equal(await evaluate("globalThis.qaRequests.filter(r=>r.path==='/api/status').length"),2);assert.equal(seenCalls.length,resumeReads);assert.equal(sendCalls.length,resumeSends);
  assert.equal(await evaluate("globalThis.qaRequests.filter(r=>['/api/start','/api/reader/connect','/api/reader/photo','/api/reader/seen','/api/reader/send'].includes(r.path)).length"),0);
  lifecycleChecks.push('restore signals merge behind one refresh with zero send read QR connect');
  await evaluate("document.querySelector('.room-item.selected').click()");await until("userSelected && currentPage?.messages?.length>0");await evaluate("window.dispatchEvent(new Event('focus'))");await until("!refreshing && !refreshPending");assert.equal(await evaluate('userSelected'),true);await stopPoll();
  const busyRequests=await evaluate('globalThis.qaRequests.length');
  await evaluate("globalThis.qaMode='act-body';void act('/api/reader/disconnect')");await until("busy && globalThis.qaHeld.length===1");
  const busyStatuses=await evaluate("globalThis.qaRequests.filter(r=>r.path==='/api/status').length");
  await evaluate("for(let i=0;i<4;i++)window.dispatchEvent(new Event('online'))");assert.equal(await evaluate("globalThis.qaRequests.filter(r=>r.path==='/api/status').length"),busyStatuses);
  await evaluate("globalThis.qaHeld.shift()()");await until("!busy && !refreshing && !refreshPending && lastState.reader.phase==='disconnected'");await stopPoll();
  assert.equal(await evaluate("globalThis.qaRequests.filter(r=>r.path==='/api/status').length"),busyStatuses+1);
  assert.equal(await evaluate(`globalThis.qaRequests.slice(${busyRequests}).filter(r=>r.path==='/api/reader/disconnect').length`),1);
  assert.equal(await evaluate(`globalThis.qaRequests.slice(${busyRequests}).filter(r=>['/api/start','/api/reader/connect','/api/reader/seen','/api/reader/send','/api/reader/photo'].includes(r.path)).length`),0);
  lifecycleChecks.push('busy restore signals merge without repeating manual disconnect or reconnect');
  // This explicit test click is the only reconnect below.
  await evaluate("document.getElementById('reader-connect').click()");await until("lastState.reader.phase==='connected' && !busy && !refreshing");await readyPage();
  await stopPoll();unknownSend=true;const beforeTimeoutSend=sendCalls.length;
  await evaluate("globalThis.qaRequests=[];globalThis.qaMode='send-body';globalThis.qaFast=true;document.getElementById('compose-text').value='synthetic deadline send';document.getElementById('compose-text').dispatchEvent(new Event('input'));document.getElementById('compose-form').requestSubmit()");
  await until("globalThis.qaHeld.length===1 && pendingSend?.phase==='unknown'");const timedId=await evaluate('pendingSend.clientId');assert.equal(sendCalls.length,beforeTimeoutSend+1);assert.equal(sendCalls.at(-1).clientId,timedId);
  await sleep(170);await evaluate("globalThis.qaFast=false;globalThis.qaHeld.shift()();window.dispatchEvent(new Event('online'));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))");
  await until("!refreshing && !refreshPending && freshness==='fresh'");await refreshUi();await stopPoll();
  assert.equal(await evaluate(`pendingSend?.clientId===${JSON.stringify(timedId)} && pendingSend.phase==='unknown' && document.getElementById('compose-text').disabled && document.getElementById('compose-text').value==='synthetic deadline send'`),true);
  assert.equal(sendCalls.length,beforeTimeoutSend+1);assert.equal(await evaluate("globalThis.qaRequests.filter(r=>r.path==='/api/reader/send').length"),1);assert.equal(await evaluate('globalThis.qaDeadlines.includes(30000)'),true);
  assert.equal(await evaluate("globalThis.qaRequests.filter(r=>r.path.startsWith('/api/reader/messages?')).length>0"),true);
  lifecycleChecks.push('POST timeout preserves clientId unknown lock and queries outcome without resend');
  for(const patch of [{reader:{phase:'disconnected',canConnect:true}},{reader:{phase:'blocked',status:-1,canConnect:false}},{reader:{phase:'disconnected',attempts:3,canConnect:false},canOpenReader:false},{phase:'expired',credentialInMemory:false,canOpenReader:false,canStart:true,reader:{phase:'idle',canConnect:false}}]){
    await stopPoll();const n=await evaluate('globalThis.qaRequests.length'),reads=seenCalls.length,sends=sendCalls.length;
    await evaluate(`globalThis.qaPatch=${JSON.stringify(patch)};window.dispatchEvent(new Event('online'));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));`);await until("!refreshing && !refreshPending");await stopPoll();
    assert.equal(await evaluate(`globalThis.qaRequests.slice(${n}).filter(r=>['/api/start','/api/reader/connect','/api/reader/seen','/api/reader/send','/api/reader/photo'].includes(r.path)).length`),0);
    assert.equal(await evaluate("document.getElementById('compose-text').disabled && document.getElementById('attach-image').disabled"),true);assert.equal(seenCalls.length,reads);assert.equal(sendCalls.length,sends);
  }
  lifecycleChecks.push('manual blocked expired three-failure restore sends zero connect QR read text photo');
  const statusMaximum=await evaluate('globalThis.qaStatusMaximum');assert.equal(statusMaximum,1);
  unknownSend=false;await evaluate("globalThis.qaPatch=null;globalThis.fetch=globalThis.qaFetch;globalThis.setTimeout=globalThis.qaSetTimeout");await refreshUi();
  writeFileSync(resolve(folder,'synthetic-lifecycle.json'),JSON.stringify({passed:selectionRaceResults.every(result=>result.actualHistoryRequests===result.expectedHistoryRequests),checks:lifecycleChecks,statusMaximum,restoreAutomatic:{connect:0,QR:0,seen:0,text:0,photo:0},deadlineExecution:'production 12000/30000 timer classes captured; selected test deadlines scaled to 80 ms',actualAccountUsed:false},null,2));
  assert.ok(selectionRaceResults.every(result=>result.actualHistoryRequests===result.expectedHistoryRequests),'initial explicit selection must still queue exactly one history after polling supersedes its GET');
  }finally{
    unknownSend=false;
    await evaluate("globalThis.qaPatch=null;globalThis.qaFast=false;globalThis.fetch=globalThis.qaFetch;globalThis.setTimeout=globalThis.qaSetTimeout;scheduleRefresh();");
  }
  }
  await until("document.getElementById('start') && !document.getElementById('start').disabled");
  await evaluate("globalThis.qrDraws=0;const originalFill=CanvasRenderingContext2D.prototype.fillRect;CanvasRenderingContext2D.prototype.fillRect=function(...args){globalThis.qrDraws++;return originalFill.apply(this,args);}");
  await evaluate("document.getElementById('start').click()");
  await until("!document.getElementById('qr').hidden");
  const initialQrDraws=await evaluate('globalThis.qrDraws');
  await refreshUi();await refreshUi();assert.equal(await evaluate('globalThis.qrDraws'),initialQrDraws);
  qrGrid[0][0]=false;await refreshUi();assert.equal(await evaluate('globalThis.qrDraws')>initialQrDraws,true);
  qrGrid[0][0]=true;await refreshUi();allowAuth=true;
  await until("!document.getElementById('reader-connect').disabled");await evaluate("document.getElementById('reader-connect').click()");
  await until("document.querySelectorAll('.room-item').length===2");
  assert.equal(await evaluate("document.getElementById('title').textContent"),'대화 서버 연결됨');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.app-shell')).display"),'grid');
  if(process.env.WEB_KAKAO_QA_D2_ONLY==='1'){await checkRejectedSelection();console.log(JSON.stringify({passed:true,scope:'synthetic two-tab rejected view only',checks:lifecycleChecks,actualAccountUsed:false,artifacts:folder}));}
  else if(process.env.WEB_KAKAO_QA_HTTPS_LIFECYCLE_ONLY==='1'){await checkDefaultHttpsLifecycle();console.log(JSON.stringify({passed:true,scope:'synthetic default HTTPS QR and clear lifecycle',checks:lifecycleChecks,actualAccountUsed:false,artifacts:folder}));}
  else if(process.env.WEB_KAKAO_QA_PHOTO_ONLY==='1'){await checkPhotoConversion();console.log(JSON.stringify({passed:true,scope:'synthetic photo conversion and submit only',checks:lifecycleChecks,actualAccountUsed:false,artifacts:folder}));}
  else if(process.env.WEB_KAKAO_QA_ADVERSARIAL_ONLY==='1'){await checkAdversarialBrowser();console.log(JSON.stringify({passed:true,scope:'synthetic adversarial browser only',checks:lifecycleChecks,actualAccountUsed:false,artifacts:folder}));}
  else if(process.env.WEB_KAKAO_QA_UI_ONLY==='1'){await checkMobileAndThemes();await checkThemeBrowser();await checkHeaderLayout();console.log(JSON.stringify({passed:true,scope:'synthetic A UI theme and mobile only',checks:lifecycleChecks,actualAccountUsed:false,artifacts:folder}));}
  else if(process.env.WEB_KAKAO_QA_THEME_ONLY==='1'){await checkThemeBrowser();console.log(JSON.stringify({passed:true,scope:'synthetic theme only',checks:lifecycleChecks,actualAccountUsed:false,artifacts:folder}));}
  else if(process.env.WEB_KAKAO_QA_CONFLICTS_ONLY==='1'){await checkConflicts();console.log(JSON.stringify({passed:true,scope:'synthetic HTTP409 only',checks:lifecycleChecks,actualAccountUsed:false,artifacts:folder}));}
  else if(process.env.WEB_KAKAO_QA_HEADER_ONLY==='1'){await checkHeaderLayout();console.log(JSON.stringify({passed:true,scope:'synthetic header layout only',checks:lifecycleChecks,actualAccountUsed:false,artifacts:folder}));}
  else if(process.env.WEB_KAKAO_QA_OPEN_EMPTY_ONLY==='1'){await checkEmptyOpenContext();console.log(JSON.stringify({passed:true,scope:'synthetic empty open context only',checks:lifecycleChecks,actualAccountUsed:false,artifacts:folder}));}
  else if(process.env.WEB_KAKAO_QA_SELECTION_ONLY==='1'){await checkSelectionBusy();console.log(JSON.stringify({passed:true,scope:'synthetic selection only',checks:lifecycleChecks,actualAccountUsed:false,artifacts:folder}));}
  else if(process.env.WEB_KAKAO_QA_CAPABILITIES_ONLY==='1'){await checkCapabilities();console.log(JSON.stringify({passed:true,scope:'synthetic capabilities only',checks:lifecycleChecks,actualAccountUsed:false,artifacts:folder}));}
  else if(process.env.WEB_KAKAO_QA_LIFECYCLE_ONLY==='1'){await checkLifecycle();console.log(JSON.stringify({passed:true,scope:'synthetic lifecycle only',checks:lifecycleChecks,actualAccountUsed:false,artifacts:folder}));}
  else {
  // An initial default highlight is not an explicitly opened room or read intent.
  assert.equal(historyRooms.length,0);assert.equal(await evaluate('!userSelected && reconnectRoom===null'),true);
  for(let i=0;i<2;i++){
    const defaultSeen=seenCalls.length,defaultSends=sendCalls.length;
   await evaluate("document.getElementById('reader-disconnect').click()");await until("lastState.reader.phase==='disconnected' && !busy && !refreshing && !el('reader-connect').disabled");
    await evaluate("document.getElementById('reader-connect').click()");
    await until("lastState.reader.phase==='connected' && document.querySelectorAll('.room-item').length===2 && !refreshing && !busy");
    assert.equal(await evaluate('!userSelected && reconnectRoom===null && currentPage.messages.length===0'),true);
    assert.equal(historyRooms.length,0);assert.equal(seenCalls.length,defaultSeen);assert.equal(sendCalls.length,defaultSends);
  }
  await evaluate("document.getElementById('room-search').value='대화방 B';document.getElementById('room-search').dispatchEvent(new Event('input'))");
  assert.equal(await evaluate("document.querySelectorAll('.room-item').length"),1);
  await evaluate("document.getElementById('room-search').value='';document.getElementById('room-search').dispatchEvent(new Event('input'))");
  await evaluate("document.querySelectorAll('.room-item')[0].click()");
  await until("document.getElementById('history-load').disabled");
  await evaluate("document.querySelectorAll('.room-item')[1].click()");await until("document.getElementById('chat-title').textContent==='모의 대화방 B'");
  await until("document.querySelectorAll('#message-list article').length===40 && !document.getElementById('history-load').disabled");
  assert.equal(historyRooms[0],key);
  const queuedDeadline=Date.now()+6000;while(!historyRooms.includes(second)){if(Date.now()>queuedDeadline)throw new Error('latest selection was not queried');await sleep(100);}
  await until("!document.getElementById('history-load').disabled");
  const callsBeforeReselect=historyRooms.length;
  await evaluate("document.querySelector('.room-item.selected').click()");await sleep(100);
  assert.equal(historyRooms.length,callsBeforeReselect);
  await evaluate("document.querySelectorAll('.room-item')[0].click()");await until("document.getElementById('chat-title').textContent==='모의 대화방 A'");
  await refreshUi();
  assert.equal(await evaluate("document.querySelector('.chat-scroll').scrollHeight>document.querySelector('.chat-scroll').clientHeight+400"),true);
  assert.equal(await evaluate("document.querySelector('#message-list .message-reply,#message-list .message-copy')===null && document.getElementById('message-menu').hidden"),true);
  await evaluate("document.querySelector('#message-list article:last-child').scrollIntoView({block:'center'})");await sleep(200);
  const hoverPoint=await evaluate("(()=>{const r=document.querySelector('#message-list article:last-child').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+10};})()");
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',...hoverPoint});
  await until("!document.getElementById('message-menu').hidden");
  assert.equal(await evaluate("(()=>{const a=document.querySelector('#message-list article:last-child .muted').getBoundingClientRect(),b=document.getElementById('message-menu').getBoundingClientRect();return b.right<=a.left || b.left>=a.right || b.bottom<=a.top || b.top>=a.bottom;})()"),true);
  assert.equal(await evaluate("document.getElementById('reply-preview').hidden"),true);
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  assert.equal(await evaluate("document.getElementById('message-menu').hidden"),true);
  await evaluate("document.querySelector('#message-list article:last-child').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:innerWidth-1,clientY:innerHeight-1}))");
  assert.equal(await evaluate("(()=>{const r=document.getElementById('message-menu').getBoundingClientRect();return r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight && document.activeElement.id==='message-menu-reply';})()"),true);
  await evaluate("document.getElementById('message-menu-reply').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  assert.equal(await evaluate("document.getElementById('message-menu').hidden && document.activeElement.matches('#message-list article')"),true);
  await evaluate("globalThis.savedMessageNode=document.querySelector('#message-list article');globalThis.savedRoomNode=document.querySelector('.room-item.selected');document.querySelector('.chat-scroll').scrollTop=200");
  await refreshUi();await refreshUi();
  assert.equal(await evaluate("globalThis.savedMessageNode===document.querySelector('#message-list article') && globalThis.savedRoomNode===document.querySelector('.room-item.selected')"),true);
  otherPreview='다른 방의 새 미리보기';revision++;await refreshUi();
  assert.equal(await evaluate("globalThis.savedMessageNode===document.querySelector('#message-list article') && Math.abs(document.querySelector('.chat-scroll').scrollTop-200)<1"),true);
  assert.equal(await evaluate("document.getElementById('room-list').textContent.includes('다른 방의 새 미리보기')"),true);
  messagesByRoom.get(key).push({key:'m_'+'e'.repeat(24),text:'모의 새 메시지',sender:'모의 사용자',mine:false,at:1800000060000});revision++;await refreshUi();
  assert.equal(await evaluate("document.querySelectorAll('#message-list article').length===41 && Math.abs(document.querySelector('.chat-scroll').scrollTop-200)<1"),true);
  messagesByRoom.get(key)[20].text='같은 ID의 수정된 모의 본문';revision++;await refreshUi();
  assert.equal(await evaluate("document.querySelectorAll('#message-list article p')[20].textContent"),'같은 ID의 수정된 모의 본문');
  await evaluate("const sc=document.querySelector('.chat-scroll');sc.scrollTop=sc.scrollHeight");
  messagesByRoom.get(key).push({key:'m_'+'f'.repeat(24),text:'맨 아래에 추가된 모의 메시지',sender:'모의 사용자',mine:false,at:1800000061000});revision++;await refreshUi();
  assert.equal(await evaluate("(()=>{const sc=document.querySelector('.chat-scroll');return sc.scrollHeight-sc.clientHeight-sc.scrollTop<=1})()"),true);
  await evaluate("globalThis.testHidden=false;Object.defineProperty(document,'hidden',{configurable:true,get:()=>globalThis.testHidden});Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>globalThis.testHidden?'hidden':'visible'});document.dispatchEvent(new Event('visibilitychange'))");
  let previousRequests=statusRequests;await sleep(2300);const visibleRequests=statusRequests-previousRequests;assert.ok(visibleRequests>=2);
  await evaluate("globalThis.testHidden=true;document.dispatchEvent(new Event('visibilitychange'))");
  previousRequests=statusRequests;await sleep(2300);const hiddenRequests=statusRequests-previousRequests;assert.ok(hiddenRequests<=1 && hiddenRequests<visibleRequests);
  previousRequests=statusRequests;
  await evaluate("for(let i=0;i<3;i++){globalThis.testHidden=true;document.dispatchEvent(new Event('visibilitychange'));globalThis.testHidden=false;document.dispatchEvent(new Event('visibilitychange'));}");
  await sleep(2300);assert.ok(statusRequests-previousRequests>=2 && statusRequests-previousRequests<=4);
  assert.equal(await evaluate("document.getElementById('history-note').textContent.includes('서버 조회 응답')"),false);
  assert.equal(await evaluate('document.querySelector("#message-list p").textContent'),payload);
  assert.equal(await evaluate('document.querySelector("#message-list img")===null && globalThis.injected===undefined'),true);
  await evaluate("globalThis.testFocus=true;document.hasFocus=()=>globalThis.testFocus");
  // Clipboard calls are intercepted: the test never changes the OS clipboard.
  await evaluate("globalThis.clipboardCopies=[];globalThis.clipboardDenied=false;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(text){if(globalThis.clipboardDenied)throw new Error('fixture denial');globalThis.clipboardCopies.push(text)}}})");
  const navigationHistory=historyRooms.length;
  await evaluate("document.getElementById('compose-text').value='목록 전환 중 초안';document.getElementById('compose-text').dispatchEvent(new Event('input'));document.querySelectorAll('.room-item')[1].click()");
  await until("document.getElementById('chat-title').textContent==='모의 대화방 B'");
  await evaluate("document.getElementById('pin-room').click()");
  assert.equal(await evaluate("document.querySelector('.room-item strong').textContent.startsWith('모의 대화방 B') && document.querySelector('.pin-label').textContent==='고정'"),true);
  await evaluate("document.getElementById('filter-pinned').click()");
  assert.equal(await evaluate("document.querySelectorAll('.room-item').length===1 && document.getElementById('filter-pinned').getAttribute('aria-pressed')==='true'"),true);
  await evaluate("document.getElementById('pin-room').click()");
  assert.equal(await evaluate("document.querySelectorAll('.room-item').length===0 && document.getElementById('room-list').textContent.includes('고정한 대화방이 없습니다') && document.getElementById('chat-title').textContent==='모의 대화방 B'"),true);
  await evaluate("document.getElementById('filter-all').click();document.querySelectorAll('.room-item')[0].click()");
  await until("document.getElementById('chat-title').textContent==='모의 대화방 A'");
  assert.equal(await evaluate("document.getElementById('compose-text').value"),'목록 전환 중 초안');
  assert.equal(historyRooms.length,navigationHistory);
  unread.set(second,3);revision++;await refreshUi();
  const beforeFilterSeen=seenCalls.length;
  await evaluate("document.getElementById('filter-unread').click()");
  assert.equal(await evaluate("document.querySelectorAll('.room-item').length===1 && document.querySelector('.room-item strong').textContent==='모의 대화방 B' && document.getElementById('chat-title').textContent==='모의 대화방 A' && document.title.startsWith('(3)')"),true);
  await refreshUi();assert.equal(seenCalls.length,beforeFilterSeen);
  await evaluate("document.getElementById('filter-all').click()");
  const searchText='찾기 [a+b]. (예시) 😀';
  for(let i=0;i<2;i++)messagesByRoom.get(key).push({key:'m_'+(1000+i).toString(16).padStart(24,'0'),text:searchText,sender:'모의 사용자',mine:false,at:1800000070000+i*1000});
  revision++;await refreshUi();
  await evaluate("document.getElementById('message-search-toggle').click();document.getElementById('message-search').value='[a+b]. (예시)';document.getElementById('message-search').dispatchEvent(new Event('input'))");
  assert.equal(await evaluate("document.getElementById('message-search-count').textContent==='1 / 2' && document.querySelectorAll('#message-list mark').length===2 && document.querySelectorAll('.search-current').length===1"),true);
  await evaluate("document.getElementById('message-search-next').click()");assert.equal(await evaluate("document.getElementById('message-search-count').textContent"),'2 / 2');
  await evaluate("document.getElementById('message-search-prev').click()");assert.equal(await evaluate("document.getElementById('message-search-count').textContent"),'1 / 2');
  const beforeSearchSeen=seenCalls.length;unread.set(key,2);messagesByRoom.get(key).push({key:'m_'+(1002).toString(16).padStart(24,'0'),text:searchText,sender:'모의 사용자',mine:false,at:1800000072000});revision++;await refreshUi();
  assert.equal(seenCalls.length,beforeSearchSeen);assert.equal(await evaluate("document.getElementById('message-search-count').textContent"),'1 / 3');
  await evaluate("document.querySelector('#message-list article').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:300,clientY:200}));document.getElementById('message-menu-copy').click()");await until("document.getElementById('message-action-status').textContent==='복사했습니다.'");
  assert.deepEqual(await evaluate('globalThis.clipboardCopies'),[payload]);
  await evaluate("globalThis.clipboardDenied=true;document.querySelector('#message-list article').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:300,clientY:200}));document.getElementById('message-menu-copy').click()");await until("document.getElementById('message-action-status').textContent.includes('복사하지 못했습니다')");
  assert.equal(await evaluate('globalThis.clipboardCopies.length'),1);
  await evaluate("document.getElementById('message-search').value='<img src=x onerror=\"globalThis.injected=true\">';document.getElementById('message-search').dispatchEvent(new Event('input'))");
  assert.equal(await evaluate("document.querySelector('#message-list mark').textContent"),payload);
  assert.equal(await evaluate("document.querySelector('#message-list img')===null && globalThis.injected===undefined"),true);
  await evaluate("document.getElementById('message-search').value='없는 합성 검색어';document.getElementById('message-search').dispatchEvent(new Event('input'))");
  assert.equal(await evaluate("document.getElementById('message-search-count').textContent.includes('일치하는 메시지가 없습니다') && document.getElementById('message-search-next').disabled"),true);
  unread.set(key,0);revision++;
  await evaluate("document.getElementById('message-search-close').click()");await refreshUi();
  assert.equal(await evaluate("document.getElementById('message-search-bar').hidden && document.querySelector('#message-list mark')===null"),true);
  unread.set(second,3);revision++;await refreshUi();
  assert.equal(await evaluate("document.querySelectorAll('.unread-badge').length===1 && document.querySelector('.unread-badge').textContent==='3' && document.title.startsWith('(3)')"),true);
  await evaluate("document.getElementById('rename-room').click();document.getElementById('room-title-input').value='내 웹 이름 <img src=x onerror=alert(1)>';document.getElementById('rename-form').requestSubmit()");
  await until("document.getElementById('chat-title').textContent==='내 웹 이름 <img src=x onerror=alert(1)>'");
  assert.equal(await evaluate("document.querySelector('#chat-title img')===null"),true);
  await evaluate("document.getElementById('room-search').value='모의 대화방 A';document.getElementById('room-search').dispatchEvent(new Event('input'))");
  assert.equal(await evaluate("document.querySelectorAll('.room-item').length"),1);
  await evaluate("document.getElementById('room-search').value='';document.getElementById('room-search').dispatchEvent(new Event('input'));document.getElementById('rename-room').click();document.getElementById('rename-reset').click()");
  await until("document.getElementById('chat-title').textContent==='모의 대화방 A'");
  messagesByRoom.get(key)[0].unreadCount=1;revision++;await refreshUi();
  assert.equal(await evaluate("document.querySelector('.message-read').textContent"),'1');
  messagesByRoom.get(key)[0].unreadCount=0;revision++;await refreshUi();assert.equal(await evaluate("document.querySelector('.message-read')===null"),true);
  const acknowledgements=seenCalls.length;
  await evaluate("globalThis.testHidden=true");unread.set(key,2);revision++;await refreshUi();assert.equal(seenCalls.length,acknowledgements);
  await evaluate("globalThis.testHidden=false;globalThis.testFocus=false");await refreshUi();assert.equal(seenCalls.length,acknowledgements);
  await evaluate("globalThis.testFocus=true;document.querySelector('.chat-scroll').scrollTop=100");await refreshUi();assert.equal(seenCalls.length,acknowledgements);
  await evaluate("document.getElementById('new-messages').click()");await until("document.getElementById('new-messages').hidden");
  const seenDeadline=Date.now()+4000;while(seenCalls.length===acknowledgements){if(Date.now()>seenDeadline)throw new Error('visible room was not acknowledged');await sleep(50);}
  assert.equal(seenCalls.at(-1).notify,false);
  // An older missing range must not prevent acknowledging the visible latest message.
  historyGaps.set(key,true);latestMissing.add(key);revision++;await refreshUi();
  await evaluate("document.getElementById('read-sync').checked=true;document.getElementById('read-sync').dispatchEvent(new Event('change'))");
  await refreshUi();assert.equal(seenCalls.some(row=>row.notify),false);
  latestMissing.delete(key);revision++;await refreshUi();
  const readDeadline=Date.now()+5000;while(!seenCalls.some(row=>row.notify)){if(Date.now()>readDeadline)throw new Error('read sync was not requested');await sleep(50);}
  await refreshUi();assert.equal(await evaluate("currentPage.readSync.phase"),'accepted');
  const readsAfterAck=seenCalls.filter(row=>row.notify).length;
  await refreshUi();await refreshUi();assert.equal(seenCalls.filter(row=>row.notify).length,readsAfterAck);
  historyGaps.delete(key);revision++;
  // Every modal and the account overlay blocks both local seen and remote read.
  // Closing restores the ordinary foreground/latest eligibility without sends.
  let coveredSequence=0;
  for(const target of ['photo-dialog','rename-dialog','image-send-dialog','account-panel']){
    for(const notify of [false,true]){
      await until('!busy && !refreshing && !ackInFlight');
      await evaluate(`(()=>{document.getElementById('read-sync').checked=${notify};const target=document.getElementById('${target}');if('${target}'==='account-panel')showAccount(true);else target.showModal();})()`);
      const beforeCovered=seenCalls.length,beforeCoveredSend=sendCalls.length;
      const newKey='m_'+(6000+coveredSequence++).toString(16).padStart(24,'0');
      messagesByRoom.get(key).push({key:newKey,text:'모달 뒤 합성 새 메시지',sender:'모의 사용자',mine:false,at:1800000080000+coveredSequence});unread.set(key,1);revision++;
      await refreshUi();await refreshUi();await sleep(150);
      assert.equal(seenCalls.length,beforeCovered,`${target} readSync=${notify} must block seen`);
      assert.equal(unread.get(key),1);assert.equal(sendCalls.length,beforeCoveredSend);
      await evaluate(`document.getElementById('${target==='account-panel'?'account-close':target}').${target==='account-panel'?'click()':'close()'}`);
      await refreshUi();
      const resumeDeadline=Date.now()+4000;while(seenCalls.length===beforeCovered){if(Date.now()>resumeDeadline)throw new Error('read did not resume after '+target);await sleep(50);}
      assert.equal(seenCalls.length,beforeCovered+1,`${target} readSync=${notify} close must enqueue one seen request`);assert.equal(seenCalls.at(-1).notify,notify);assert.equal(unread.get(key),0);assert.equal(sendCalls.length,beforeCoveredSend);
    }
  }
  await refreshUi();
  await evaluate("document.getElementById('compose-text').focus();document.getElementById('compose-text').value='한글 모의 전송';document.getElementById('compose-text').dispatchEvent(new Event('input'));document.getElementById('compose-text').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}))");
  assert.equal(sendCalls.length,0);
  await until("!document.getElementById('send-message').disabled");
  await evaluate("document.getElementById('send-message').click();document.getElementById('send-message').click()");
  await until("document.getElementById('compose-text').value==='' && document.getElementById('message-list').textContent.includes('한글 모의 전송')");
  assert.equal(sendCalls.length,1);assert.equal(sendCalls[0].text,'한글 모의 전송');
  assert.equal(await evaluate("document.activeElement===document.getElementById('compose-text')"),true);
  assert.equal(await evaluate("[...document.querySelectorAll('#message-list article p')].filter(node=>node.textContent==='한글 모의 전송').length"),1);
  await evaluate("document.querySelector('#message-list article').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:300,clientY:200}));document.getElementById('message-menu-reply').click()");
  unknownSend=true;
  await evaluate("document.getElementById('compose-text').value='결과 불명 모의 전송';document.getElementById('compose-text').dispatchEvent(new Event('input'))");
  await until("!document.getElementById('send-message').disabled");await evaluate("document.getElementById('send-message').click()");
  await evaluate("document.getElementById('room-search').focus()");
  await until("!document.getElementById('send-reset').hidden");
  await evaluate("document.getElementById('reply-cancel').click()");
  assert.equal(await evaluate("document.getElementById('reply-preview').hidden && !document.getElementById('send-reset').hidden && pendingSend!==null"),true);
  await sleep(1200);assert.equal(sendCalls.length,2);assert.equal(await evaluate("document.getElementById('compose-text').value"),'결과 불명 모의 전송');
  assert.equal(await evaluate("document.getElementById('send-message').disabled"),true);
  const uncertain=sendCalls.at(-1);outcomes.set(uncertain.clientId,{key,clientId:uncertain.clientId,phase:'accepted'});revision++;await refreshUi();
  await until("document.getElementById('send-reset').hidden && document.getElementById('compose-text').value===''");assert.equal(sendCalls.length,2);
  assert.equal(await evaluate("document.activeElement===document.getElementById('room-search')"),true);
  unknownSend=false;
  await evaluate("document.querySelector('#message-list article').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:300,clientY:200}));document.getElementById('message-menu-reply').click()");
  assert.equal(await evaluate("!document.getElementById('reply-preview').hidden && document.getElementById('reply-text').textContent===globalThis.replyFixture && document.querySelector('#reply-preview img')===null".replace('globalThis.replyFixture',JSON.stringify(payload))),true);
  await evaluate("document.getElementById('compose-text').value='답장 초안';document.getElementById('compose-text').dispatchEvent(new Event('input'));document.getElementById('reply-cancel').click()");
  assert.equal(await evaluate("document.getElementById('reply-preview').hidden && document.getElementById('compose-text').value==='답장 초안'"),true);
  await evaluate("document.querySelector('#message-list article').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:300,clientY:200}));document.getElementById('message-menu-reply').click();document.getElementById('send-message').click()");
  await until("pendingSend===null && document.getElementById('reply-preview').hidden && document.querySelector('.message-quote') && !refreshing && !ackInFlight");
  assert.equal(await evaluate("(()=>{const pane=document.querySelector('.chat-scroll');return pane.scrollHeight-pane.clientHeight-pane.scrollTop<=1;})()"),true,'accepted own reply must be visible at the latest position');
  assert.equal(sendCalls.at(-1).replyTo,'m_'+'1'.padStart(24,'0'));
  assert.equal(await evaluate("document.querySelector('.message-quote span').textContent"),payload);assert.equal(await evaluate("document.querySelector('.message-quote img')===null && globalThis.injected===undefined"),true);
  const beforePhotos=sendCalls.length;
  // Exercise a filesystem File through the real input/change handler rather
  // than imposing File.type in JavaScript. CDP bypasses the native picker UI.
  const selectedPngPath=resolve(folder,'synthetic-picker.png');writeFileSync(selectedPngPath,syntheticPng);
  const photoDocument=await call('DOM.getDocument');
  const photoInput=await call('DOM.querySelector',{nodeId:photoDocument.root.nodeId,selector:'#image-file'});
  await evaluate("el('image-file').addEventListener('change',event=>globalThis.pickerFileType=event.target.files[0]?.type,{capture:true,once:true})");
  await call('DOM.setFileInputFiles',{nodeId:photoInput.nodeId,files:[selectedPngPath]});
  await until("el('image-send-dialog').open && el('image-preview').naturalWidth===1 && !imagePreparing");
  assert.equal(await evaluate('globalThis.pickerFileType'),'image/png');
  assert.equal(sendCalls.length,beforePhotos);
  await evaluate("(async()=>{const closed=new Promise(resolve=>el('image-send-dialog').addEventListener('close',resolve,{once:true}));el('image-cancel').click();await closed;})()");
  lifecycleChecks.push('filesystem PNG input decodes and opens preview without sending');
  // Native decoding and injected browser failures must identify the failed stage,
  // leave no sendable draft and permit a fresh valid preview after each failure.
  const validImage=`new File([Uint8Array.from(atob('${syntheticPng.toString('base64')}'),c=>c.charCodeAt(0))],'synthetic.png',{type:'image/png'})`;
  const preparationFailures=[
    {step:'format',file:"new File(['gif'],'synthetic.gif',{type:'image/gif'})"},
    {step:'input-size',file:"new File([new Uint8Array(20*1024*1024+1)],'synthetic.png',{type:'image/png'})"},
    {step:'decode',file:"new File([new Uint8Array([137,80,78,71,13,10,26,10]),'invalid png'],'synthetic.png',{type:'image/png'})"},
    {step:'pixels',setup:"globalThis.createImageBitmap=async()=>({width:40000001,height:1,close(){}})"},
    {step:'canvas',setup:"HTMLCanvasElement.prototype.getContext=()=>null"},
    {step:'encode',setup:"HTMLCanvasElement.prototype.toBlob=callback=>callback(null)"},
    {step:'output-size',setup:"HTMLCanvasElement.prototype.toBlob=(callback,mime)=>callback(new Blob([new Uint8Array(10*1024*1024+1)],{type:mime}))"},
    {step:'read',setup:"globalThis.FileReader=class{readAsDataURL(){queueMicrotask(()=>this.onerror(new Event('error')));}}"},
    {step:'preview',setup:"HTMLDialogElement.prototype.showModal=()=>{throw new DOMException('synthetic preview rejection','InvalidStateError');}"},
  ];
  for(const scenario of preparationFailures){
    const result=await evaluate(`(async()=>{
      const saved={decode:createImageBitmap,context:HTMLCanvasElement.prototype.getContext,blob:HTMLCanvasElement.prototype.toBlob,reader:FileReader,preview:HTMLDialogElement.prototype.showModal};
      sendNotes.delete(selectedRoom);
      try{${scenario.setup || ''};await prepareImage(${scenario.file || validImage});return {note:sendNotes.get(selectedRoom),draft:imageDraft!==null,preparing:imagePreparing,dialog:el('image-send-dialog').open,sendDisabled:el('image-send').disabled};}
      finally{globalThis.createImageBitmap=saved.decode;HTMLCanvasElement.prototype.getContext=saved.context;HTMLCanvasElement.prototype.toBlob=saved.blob;globalThis.FileReader=saved.reader;HTMLDialogElement.prototype.showModal=saved.preview;}
    })()`);
    assert.ok(result.note.endsWith('['+scenario.step+']'),scenario.step+' must have a specific error');
    assert.deepEqual({...result,note:undefined},{note:undefined,draft:false,preparing:false,dialog:false,sendDisabled:true});
    await evaluate(`prepareImage(${validImage})`);
    await until("el('image-send-dialog').open && el('image-preview').naturalWidth===1 && !imagePreparing");
    await evaluate("(async()=>{const closed=new Promise(resolve=>el('image-send-dialog').addEventListener('close',resolve,{once:true}));el('image-cancel').click();await closed;})()");
    assert.equal(sendCalls.length,beforePhotos,'preparation failure and recovery must not send');
    lifecycleChecks.push('photo preparation '+scenario.step+' failure is specific, cleans up and recovers without sending');
  }
  await evaluate('sendNotes.delete(selectedRoom);renderComposer()');
  assert.equal(await evaluate("(()=>{const data=new DataTransfer();data.setData('text/plain','일반 텍스트');const event=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});return document.getElementById('compose-text').dispatchEvent(event) && !event.defaultPrevented;})()"),true);
  await evaluate("document.getElementById('compose-text').value='붙여넣기 중 유지할 초안';document.getElementById('compose-text').dispatchEvent(new Event('input'))");
  assert.equal(await evaluate(`(()=>{const data=new DataTransfer();data.items.add(new File([Uint8Array.from(atob('${syntheticPng.toString('base64')}'),c=>c.charCodeAt(0))],'clipboard.png',{type:'image/png'}));const event=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});document.getElementById('compose-text').dispatchEvent(event);return event.defaultPrevented;})()`),true);
  await until("document.getElementById('image-send-dialog').open && document.getElementById('image-preview').naturalWidth===1");
  assert.equal(sendCalls.length,beforePhotos);assert.equal(await evaluate("document.getElementById('compose-text').value"),'붙여넣기 중 유지할 초안');
  await evaluate("document.getElementById('image-cancel').click()");assert.equal(await evaluate("imageDraft===null && !document.getElementById('image-preview').hasAttribute('src')"),true);
  await evaluate(`prepareImage(new File([Uint8Array.from(atob('${syntheticPng.toString('base64')}'),c=>c.charCodeAt(0))],'synthetic.png',{type:'image/png'}))`);
  await until("document.getElementById('image-send-dialog').open && document.getElementById('image-preview').naturalWidth===1");
  assert.equal(sendCalls.length,beforePhotos);assert.equal(await evaluate("document.getElementById('image-preview').src.startsWith('blob:')"),true);
  await evaluate("document.getElementById('image-cancel').click()");assert.equal(await evaluate("imageDraft===null && !document.getElementById('image-preview').hasAttribute('src')"),true);
  await evaluate(`prepareImage(new File([Uint8Array.from(atob('${syntheticPng.toString('base64')}'),c=>c.charCodeAt(0))],'synthetic.png',{type:'image/png'}))`);
  await until("document.getElementById('image-send-dialog').open && !document.getElementById('image-send').disabled");
  await evaluate("document.getElementById('compose-text').value='사진과 별도로 남길 초안';document.getElementById('compose-text').dispatchEvent(new Event('input'));document.getElementById('image-send').click();document.getElementById('image-send').click()");
  await until("pendingSend===null && imageDraft===null && !document.getElementById('image-send-dialog').open");
  assert.equal(sendCalls.length,beforePhotos+1);assert.equal(sendCalls.at(-1).kind,'photo');assert.ok(sendCalls.at(-1).byteLength>24);
  assert.equal(await evaluate("document.getElementById('compose-text').value"),'사진과 별도로 남길 초안');
  unknownPhoto=true;
  await evaluate(`prepareImage(new File([Uint8Array.from(atob('${syntheticPng.toString('base64')}'),c=>c.charCodeAt(0))],'synthetic.png',{type:'image/png'}))`);
  await until("document.getElementById('image-send-dialog').open && !document.getElementById('image-send').disabled");
  await evaluate("document.getElementById('image-send').click()");
  await until("uncertainPhoto!==null && pendingSend===null && !document.getElementById('compose-text').disabled");
  assert.equal(await evaluate("document.getElementById('attach-image').disabled && !document.getElementById('send-reset').hidden"),true);
  const photosAfterUnknown=sendCalls.filter(call=>call.kind==='photo').length;
  await evaluate("document.querySelector('#message-list article').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:300,clientY:200}));document.getElementById('message-menu-reply').click();document.getElementById('compose-text').value='사진 결과 불명 중 답장';document.getElementById('compose-text').dispatchEvent(new Event('input'))");
  await until("!document.getElementById('send-message').disabled");await evaluate("document.getElementById('send-message').click()");
  await until("pendingSend===null && document.getElementById('compose-text').value==='' && document.getElementById('reply-preview').hidden");
  assert.ok(sendCalls.at(-1).replyTo);assert.equal(sendCalls.filter(call=>call.kind==='photo').length,photosAfterUnknown);
  assert.equal(await evaluate("uncertainPhoto!==null && document.getElementById('attach-image').disabled"),true);
  await evaluate("globalThis.confirm=()=>true;document.getElementById('send-reset').click()");
  await until('uncertainPhoto===null && !outboxAcknowledging');
  assert.equal(await evaluate("uncertainPhoto===null && imageDraft===null && document.getElementById('send-reset').hidden && !document.getElementById('attach-image').disabled"),true);
  unknownPhoto=false;
  // A failed local enqueue retains a draft. Reconnect must invalidate its scope.
  await until('!busy && !refreshing && !ackInFlight && !document.getElementById("attach-image").disabled');
  rejectPhoto=true;
  await evaluate(`prepareImage(new File([Uint8Array.from(atob('${syntheticPng.toString('base64')}'),c=>c.charCodeAt(0))],'synthetic-rejected.png',{type:'image/png'}))`);
  await until("document.getElementById('image-send-dialog').open && !document.getElementById('image-send').disabled");
  const beforeDraftReconnectPhotos=sendCalls.filter(row=>row.kind==='photo').length;
  await evaluate("globalThis.rejectedDraftGeneration=imageDraft.generation;document.getElementById('image-send').click()");
  await until("pendingSend===null && imageDraft!==null && !document.getElementById('image-send-dialog').open && !busy && !refreshing && !ackInFlight");
  rejectPhoto=false;
  const beforeDraftReconnectSeen=seenCalls.length;
  await evaluate("document.getElementById('reader-disconnect').click()");await until("lastState.reader.phase==='disconnected' && !busy && !refreshing && !el('reader-connect').disabled");
  await evaluate("document.getElementById('reader-connect').click()");
  await until("lastState.reader.phase==='connected' && currentPage?.key===selectedRoom && currentPage.messages.length===40 && !busy && !refreshing && !ackInFlight");
  assert.equal(await evaluate("readerGeneration>globalThis.rejectedDraftGeneration && imageDraft===null && !document.getElementById('image-preview').hasAttribute('src') && document.getElementById('image-send').disabled"),true);
  assert.equal(await evaluate('!userSelected && reconnectRoom===selectedRoom'),true);assert.equal(seenCalls.length,beforeDraftReconnectSeen);
  await evaluate("globalThis.pickerCalls=0;globalThis.originalPickerClick=document.getElementById('image-file').click;document.getElementById('image-file').click=()=>{globalThis.pickerCalls++;};document.getElementById('attach-image').click()");
  assert.equal(await evaluate("globalThis.pickerCalls===1 && !document.getElementById('image-send-dialog').open"),true);
  await evaluate("document.getElementById('image-file').click=globalThis.originalPickerClick");
  assert.equal(sendCalls.filter(row=>row.kind==='photo').length,beforeDraftReconnectPhotos);
  // Hold bitmap decoding across another reconnect. Old work must close cleanly.
  await evaluate("globalThis.originalBitmapDecoder=createImageBitmap;globalThis.heldBitmap=null;globalThis.releaseBitmap=null;globalThis.createImageBitmap=async file=>{const bitmap=await globalThis.originalBitmapDecoder(file);globalThis.heldBitmap=bitmap;await new Promise(resolve=>{globalThis.releaseBitmap=resolve;});return bitmap;}");
  await evaluate(`void prepareImage(new File([Uint8Array.from(atob('${syntheticPng.toString('base64')}'),c=>c.charCodeAt(0))],'synthetic-delayed.png',{type:'image/png'}))`);
  await until("imagePreparing && typeof globalThis.releaseBitmap==='function'");
  await evaluate("document.getElementById('reader-disconnect').click()");await until("lastState.reader.phase==='disconnected' && !busy && !refreshing && !el('reader-connect').disabled");
  await evaluate("document.getElementById('reader-connect').click()");
  await until("lastState.reader.phase==='connected' && currentPage?.messages?.length===40 && !busy && !refreshing && !ackInFlight");
  assert.equal(await evaluate('!userSelected && reconnectRoom===selectedRoom'),true);assert.equal(seenCalls.length,beforeDraftReconnectSeen);
  await evaluate("globalThis.releaseBitmap();globalThis.createImageBitmap=globalThis.originalBitmapDecoder");
  await until("globalThis.heldBitmap.width===0 && !imagePreparing");
  assert.equal(await evaluate("imageDraft===null && !document.getElementById('image-send-dialog').open && document.getElementById('image-send').disabled"),true);
  assert.equal(sendCalls.filter(row=>row.kind==='photo').length,beforeDraftReconnectPhotos);
  await evaluate(`prepareImage(new File([Uint8Array.from(atob('${syntheticPng.toString('base64')}'),c=>c.charCodeAt(0))],'synthetic-fresh.png',{type:'image/png'}))`);
  await until("document.getElementById('image-send-dialog').open && !document.getElementById('image-send').disabled");
  assert.equal(await evaluate('imageDraft.generation===readerGeneration'),true);
  await evaluate("document.getElementById('image-cancel').click()");assert.equal(await evaluate("imageDraft===null && document.getElementById('image-send').disabled"),true);
  await evaluate("document.getElementById('compose-text').value='';document.getElementById('compose-text').dispatchEvent(new Event('input'))");
  messagesByRoom.get(key).push({key:photoMessage,text:'[사진]',sender:'모의 사용자',mine:false,at:1800000300000,photos:[{src:`/api/photo?room=${key}&message=${photoMessage}&index=0`,width:1,height:1}]});revision++;await refreshUi();
  await until("document.querySelector('.photo-open img')?.naturalWidth===1");
  await evaluate("document.querySelector('.photo-open').click()");await until("document.getElementById('photo-dialog').open && document.getElementById('photo-full').naturalWidth===1");
  await evaluate("document.getElementById('photo-close').click()");await until("!document.getElementById('photo-dialog').open && !document.getElementById('photo-full').hasAttribute('src')");
  const image=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});writeFileSync(resolve(folder,'synthetic-reader.png'),Buffer.from(image.data,'base64'));
  await call('Emulation.setDeviceMetricsOverride',{width:580,height:900,deviceScaleFactor:1,mobile:false});
  // Reconnect restores a room without opening the mobile conversation. At
  // this narrow width, explicitly open it before measuring real hover points.
  await evaluate("document.querySelector('.room-item.selected').click()");
  await until("document.querySelector('.app-shell').classList.contains('mobile-chat') && !busy && !refreshing && !ackInFlight && !pendingSelection");
  await evaluate("document.querySelectorAll('#message-list article.mine').item(document.querySelectorAll('#message-list article.mine').length-1).scrollIntoView({block:'center'})");await sleep(200);
  const narrowHover=await evaluate("(()=>{const all=document.querySelectorAll('#message-list article.mine'),r=all[all.length-1].getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+10};})()");
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',...narrowHover});await until("!document.getElementById('message-menu').hidden");
  assert.equal(await evaluate("(()=>{const all=document.querySelectorAll('#message-list article.mine'),a=all[all.length-1].querySelector('.muted').getBoundingClientRect(),b=document.getElementById('message-menu').getBoundingClientRect();return b.left>=0 && b.right<=innerWidth && (b.right<=a.left || b.left>=a.right || b.bottom<=a.top || b.top>=a.bottom);})()"),true);
  const narrowImage=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(resolve(folder,'synthetic-message-menu-narrow.png'),Buffer.from(narrowImage.data,'base64'));
  await call('Emulation.clearDeviceMetricsOverride');await evaluate('closeMessageMenu()');
  await evaluate("document.querySelectorAll('.room-item')[1].click()");
  await until("document.getElementById('chat-title').textContent==='모의 대화방 B' && !document.getElementById('history-load').disabled");
  await evaluate("document.getElementById('pin-room').click()");
  await evaluate("document.getElementById('compose-text').value='재접속 초안';document.getElementById('compose-text').dispatchEvent(new Event('input'))");
  // A room selection can enqueue history between separate CDP evaluations.
  // Click once in the same task that observes this manual control enabled.
  await until("!busy && !refreshing && !settingsBusy && !pendingSelection && !el('reader-disconnect').disabled && (el('reader-disconnect').click(),true)");await until("lastState.reader.phase==='disconnected' && !busy && !refreshing && !el('reader-connect').disabled");
  offlineMessages.set(second,['offline-A','offline-B','offline-C'].map((text,i)=>({key:'m_'+(100+i).toString(16).padStart(24,'0'),text,sender:'모의 사용자',mine:false,at:1800000200000+i*1000})));
  const beforeReconnectHistory=historyRooms.length,beforeReconnectSeen=seenCalls.length;
  await evaluate("document.getElementById('reader-connect').click()");
  try{await until("document.getElementById('chat-title').textContent==='모의 대화방 B' && document.getElementById('message-list').textContent.includes('offline-C') && !refreshing");}
  catch(error){console.log(JSON.stringify({syntheticReconnectDebug:await evaluate("({selectedRoom,reconnectRoom,pendingSelection,userSelected,readerGeneration,readerAttempt,reader:lastState.reader,busy,refreshing,title:el('chat-title').textContent})"),historyRooms}));throw error;}
  assert.deepEqual(historyRooms.slice(beforeReconnectHistory),[second]);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#message-list article p')].map(node=>node.textContent).filter(text=>text.startsWith('offline-'))"),['offline-A','offline-B','offline-C']);
  assert.equal(await evaluate("document.getElementById('compose-text').value"),'재접속 초안');
  assert.equal(await evaluate("document.getElementById('pin-room').getAttribute('aria-pressed')==='true' && document.querySelector('.room-item strong').textContent.startsWith('모의 대화방 B')"),true);
  await refreshUi();assert.equal(historyRooms.length,beforeReconnectHistory+1);assert.equal(seenCalls.length,beforeReconnectSeen);
  assert.equal(await evaluate('reconnectRoom===selectedRoom && !userSelected'),true);
  const repeatHistory=historyRooms.length,repeatSeen=seenCalls.length,repeatSends=sendCalls.length;
  await evaluate("document.getElementById('reader-disconnect').click()");await until("lastState.reader.phase==='disconnected' && !busy && !refreshing && !el('reader-connect').disabled");
  await evaluate("document.getElementById('reader-connect').click()");
  await until("document.getElementById('chat-title').textContent==='모의 대화방 B' && document.getElementById('message-list').textContent.includes('offline-C') && !refreshing");
  assert.deepEqual(historyRooms.slice(repeatHistory),[second]);assert.equal(seenCalls.length,repeatSeen);assert.equal(sendCalls.length,repeatSends);
  assert.equal(await evaluate('!userSelected && reconnectRoom===selectedRoom'),true);
  // A removed explicit target is cleared; neither the fallback nor its return
  // silently becomes a target. A later real room click may select it again.
  removedRooms.add(second);revision++;await refreshUi();
  assert.equal(await evaluate('reconnectRoom===null && !userSelected && document.querySelectorAll(".room-item").length===1'),true);
  const missingHistory=historyRooms.length,missingSeen=seenCalls.length,missingSends=sendCalls.length;
  await evaluate("document.getElementById('reader-disconnect').click()");await until("lastState.reader.phase==='disconnected' && !busy && !refreshing && !el('reader-connect').disabled");
  await evaluate("document.getElementById('reader-connect').click()");
  await until("lastState.reader.phase==='connected' && document.querySelectorAll('.room-item').length===1 && !refreshing && !busy");
  assert.equal(historyRooms.length,missingHistory);assert.equal(seenCalls.length,missingSeen);assert.equal(sendCalls.length,missingSends);
  removedRooms.delete(second);revision++;await refreshUi();assert.equal(await evaluate('reconnectRoom===null && !userSelected'),true);
  await evaluate("[...document.querySelectorAll('.room-item')].find(node=>node.querySelector('strong').textContent.startsWith('모의 대화방 B')).click()");
  await until("document.getElementById('chat-title').textContent==='모의 대화방 B' && currentPage?.messages?.length===43 && !refreshing && !busy");
  enableSettings=true;revision++;
  await evaluate("globalThis.notifications=[];globalThis.permissionRequests=0;globalThis.Notification=class{static permission='default';static async requestPermission(){globalThis.permissionRequests++;this.permission='granted';return this.permission;}get silent(){return this.options.silent;}constructor(title,options){this.title=title;this.options=options;this.closed=false;globalThis.notifications.push(this);}close(){this.closed=true;}};");
  await refreshUi();assert.equal(await evaluate('globalThis.permissionRequests'),0);
  await evaluate("document.getElementById('browser-notifications').checked=true;document.getElementById('browser-notifications').dispatchEvent(new Event('change'))");
  await until("personalSettings?.notifications===true && !settingsBusy");assert.equal(await evaluate('globalThis.permissionRequests'),1);
  unread.set(key,2);notificationQueue.push({key,id:'c'.repeat(32)});revision++;
  await evaluate("globalThis.testHidden=true");await refreshUi();
  assert.equal(await evaluate("globalThis.notifications.length===1 && globalThis.notifications[0].options.silent===true && globalThis.notifications[0].options.body==='새 메시지가 도착했습니다.'"),true);
  await refreshUi();assert.equal(await evaluate('globalThis.notifications.length'),1);
  await evaluate("document.getElementById('mute-room').click()");await until("roomNow()?.muted===true && !settingsBusy");
  unread.set(second,2);notificationQueue.push({key:second,id:'d'.repeat(32)});revision++;await refreshUi();assert.equal(await evaluate('globalThis.notifications.length'),1);
  assert.equal(await evaluate("roomNow().unreadLocalCount===2"),true);
  await evaluate("document.getElementById('browser-notifications').checked=false;document.getElementById('browser-notifications').dispatchEvent(new Event('change'))");await until("personalSettings.notifications===false && !settingsBusy");
  assert.equal(await evaluate('globalThis.notifications[0].closed'),true);
  await evaluate("document.getElementById('persist-preferences').checked=true;document.getElementById('persist-preferences').dispatchEvent(new Event('change'))");await until("personalSettings.persist===true && !settingsBusy");
  await evaluate("document.getElementById('pin-room').click()");await until("roomNow()?.pinOrder===0 && !settingsBusy");
  await evaluate("document.getElementById('filter-pinned').click()");await until("roomFilter==='pinned' && !settingsBusy");
  await call('Page.reload');await until("typeof personalSettings!=='undefined' && personalSettings?.persist===true && roomFilter==='pinned' && document.querySelectorAll('.room-item').length===1");
  assert.equal(await evaluate("document.querySelector('.room-item strong').textContent.startsWith('모의 대화방 B')"),true);
  await checkLifecycle();
  await checkCapabilities();
  await checkSelectionBusy();
  await checkHeaderLayout();
  await checkEmptyOpenContext();
  await checkConflicts();
  await checkMobileAndThemes();
  await checkThemeBrowser();
  await checkAdversarialBrowser();
  await checkRejectedSelection();
  await checkManualHistoryDeferred();
  await checkPhotoConversion();
  await checkDiagnosisRecovery();
  await checkDefaultHttpsLifecycle();
  await evaluate("if(document.getElementById('account-panel').hidden)document.getElementById('account-toggle').click()");assert.equal(await evaluate("document.getElementById('account-panel').hidden"),false);
  await evaluate("document.getElementById('cancel').click()");await until("document.getElementById('reader-panel').hidden && document.getElementById('message-list').childElementCount===0");
  assert.equal(await evaluate("document.getElementById('chat-title').textContent"),'대화방을 선택해 주세요');
  assert.equal(await evaluate("pinnedRooms.size===0 && roomFilter==='all' && messageQuery==='' && document.getElementById('message-search-bar').hidden && document.getElementById('message-action-status').hidden"),true);
  assert.equal(await evaluate('reconnectRoom===null && selectedRoom===null && !userSelected && imageDraft===null && !imagePreparing'),true);
  const finalQrBefore=app.lab.snapshot(),finalStartBefore=fixtureRequests.filter(row=>row.method==='POST' && row.path==='/api/start').length,finalStatusBefore=statusRequests;
  let finalQrPassed=false;
  try{
    rejectNextQr=true;
    await until("!document.getElementById('start').disabled");await evaluate("document.getElementById('start').click()");
    await until("document.getElementById('diagnostic').textContent.includes('-151')");
    assert.equal(await evaluate("document.getElementById('message').textContent.includes('지원하지 않는 인증 응답')"),true);
    assert.equal(await evaluate("document.getElementById('reader-status').textContent"),'인증이 완료되지 않았습니다.');
    assert.equal(await evaluate("document.getElementById('start').disabled && document.getElementById('qr').hidden"),true);
    const finalAuth=app.lab.snapshot();assert.equal(finalAuth.phase,'blocked');assert.equal(finalAuth.stage,'poll');assert.equal(finalAuth.apiStatus,-151);
    assert.equal(finalAuth.attempts-finalQrBefore.attempts,1);assert.equal(finalAuth.requests.poll-finalQrBefore.requests.poll,1);
    assert.equal(fixtureRequests.filter(row=>row.method==='POST' && row.path==='/api/start').length-finalStartBefore,1);
    assert.equal(finalAuth.authEvents.filter(event=>event.operation==='poll' && event.status===-151).length,1);
    finalQrPassed=true;
  }finally{
    const auth=app.lab.snapshot();let ui;
    try{ui=await evaluate("({phase:lastState?.phase??null,stage:lastState?.stage??null,apiStatus:lastState?.apiStatus??null,attempts:lastState?.attempts??null,requests:lastState?.requests??null,busy,refreshing,pollTimerScheduled:pollTimer!==null,diagnosticHasTarget:el('diagnostic').textContent.includes('-151')})");}catch{ui={observationUnavailable:true};}
    writeFileSync(resolve(folder,'synthetic-final-qr.json'),JSON.stringify({passed:finalQrPassed,rejectNextQr,server:{phase:auth.phase,stage:auth.stage,apiStatus:auth.apiStatus,attempts:auth.attempts,requests:auth.requests,credentialInMemory:auth.credentialInMemory},ui,finalStartRequests:fixtureRequests.filter(row=>row.method==='POST' && row.path==='/api/start').length-finalStartBefore,statusRequestsDuringFinal:statusRequests-finalStatusBefore,pollRequestsDuringFinal:auth.requests.poll-finalQrBefore.requests.poll,finalMinus151Responses:auth.authEvents.filter(event=>event.operation==='poll' && event.status===-151).length,actualAccountUsed:false,rawValuesRecorded:false},null,2));
  }
  console.log(JSON.stringify({passed:true,scope:'synthetic offline browser only',checks:['QR caching','room selection queue','DOM and scroll retention','hidden polling','text-only rendering','unread badge and total','local rename and reset','receipt count disappears on read','hidden/unfocused/scrolled room is not acknowledged','visible latest message acknowledgement','optional server read sync','IME Enter does not send','double-click sends once','unknown send preserves draft without retry','room pin ordering and filters retain selection and drafts','literal message search and result navigation','search does not acknowledge incoming messages','clipboard success and denial without OS clipboard access','pins survive transport reconnect and clear on account close','reconnect restores selected room and draft','offline messages fetched once without load button or read notification','cancel purges account data','QR -151 neutral message','all dialogs and account overlay block read and closing resumes eligible read','rejected photo draft is invalidated on reconnect','in-flight image preparation is canceled on reconnect and fresh selection remains usable','default automatic room does not become a reconnect target','changed and removed room targets stay isolated across reconnects','account close clears reconnect intent',...lifecycleChecks],visibleRequests,hiddenRequests,screenshot:folder+'/synthetic-reader.png',actualAccountUsed:false}));
  }
}finally{
  ws?.close();
  let chromeExitObserved=Boolean(browser && (browser.exitCode!==null || browser.signalCode!==null));
  if(browser && !chromeExitObserved){const exited=new Promise(resolve=>browser.once('exit',()=>{chromeExitObserved=true;resolve();}));browser.kill();await Promise.race([exited,sleep(3000)]);}
  app.lab.cancel();app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));
  writeFileSync(resolve(folder,'synthetic-cleanup.json'),JSON.stringify({actualAccountUsed:false,chromePid:browser?.pid ?? null,chromeExitObserved,chromeExitCode:browser?.exitCode ?? null,chromeSignalCode:browser?.signalCode ?? null,serverListening:app.server.listening,profile:resolve(folder,'profile')}));
}
