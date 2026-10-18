// Explicit offline browser fixture. Never attach to the user's browser/profile
// or the actual account server. Only synthetic text is captured.
import { spawn } from 'node:child_process';
import { existsSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLocalServer } from '../experiments/local-web/server.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const chrome=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);
if(!chrome)throw new Error('Chrome unavailable; browser test not executed');
const folder=resolve(process.env.WEB_KAKAO_QA_OUTPUT_ROOT || 'local-only/phase2-browser',String(Date.now()));mkdirSync(folder,{recursive:true});
const key='r_'+'a'.repeat(24),second='r_'+'b'.repeat(24),payload='<img src=x onerror="globalThis.injected=true">';
let connected=false,attempts=0,revision=0,historyBusy=false,rejectNextQr=false,allowAuth=false,otherPreview='예시 미리보기 B',statusRequests=0;
const historyRooms=[],historyPhases=new Map(),messagesByRoom=new Map(),qrGrid=[[true]];
const localTitles=new Map(),unread=new Map(),contexts=new Map(),outcomes=new Map(),seenCalls=[],sendCalls=[];
const roomCapabilities=new Map();
const contextCalls=[],ackCalls=[],fixtureRequests=[];
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
const app=createLocalServer({controlToken,mode:'live',messaging:true,photoFetcher:async()=>({data:syntheticPhoto,type:'image/gif'}),encode:()=>qrGrid,transport:async op=>op==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:op==='generate'?{httpStatus:200,body:{status:0,url:'OFFLINE-NOT-FOR-LOGIN',remainingSeconds:60}}:rejectNextQr?{httpStatus:200,body:{status:-151}}:allowAuth?{httpStatus:200,body:{status:0,user:{userId:'246810'},accessToken:'FAKE_OFFLINE_TOKEN'}}:{httpStatus:200,body:{status:-150,nextRequestIntervalInSeconds:1}},readerFactory:()=>({
  snapshot:()=>({phase:connected?'connected':attempts?'disconnected':'idle',attempts,canConnect:!connected,roomCount:connected?2-removedRooms.size:0,revision,...(adversarialFixture?{roomsRevision:roomsVersion,settingsRevision:settingsVersion,outboxRevision:outboxVersion,pageRevisions:Object.fromEntries(pageVersions)}:{}),historyBusy,pushBatches:0,connectedAt:connected?Date.now():null}),
  connect(){if(attempts++) {historyPhases.clear();messagesByRoom.clear();contexts.clear();readStates.clear();}connected=true;revision++;return true;},
  rooms:()=>({revision,rooms:connected?[{key,title:'모의 대화방 A',preview:'예시 미리보기'},{key:second,title:'모의 대화방 B',preview:otherPreview}].filter(row=>!removedRooms.has(row.key)).map(row=>({...row,...(adversarialFixture?{lastAt:1800000300000}:{}),baseTitle:row.title,title:localTitles.get(row.key) || row.title,localTitle:localTitles.get(row.key) || null,pinOrder:roomSettings.get(row.key)?.pinOrder ?? null,muted:roomSettings.get(row.key)?.muted===true,canSend:true,kind:'DirectChat',...roomCapabilities.get(row.key),unreadLocalCount:unread.get(row.key) || 0,unreadCoverage:'observed'})):[]}),
  messages:room=>({key:room,messages:messagesByRoom.get(room) || [],latestVisible:!latestMissing.has(room),seenToken:'c'.repeat(48),receiptPhase:contexts.get(room) || 'idle',...(adversarialFixture?{entryPhase:contexts.get(room) || 'idle',contextRevision:receiptVersions.get(room)}:{}),readSync:readStates.get(room) || {phase:'idle'},outbox:[...outcomes.values()].filter(row=>row.key===room),history:{phase:historyPhases.get(room) || 'idle',gap:historyGaps.get(room)===true,receivedCount:messagesByRoom.get(room)?.length || 0,acceptedCount:messagesByRoom.get(room)?.length || 0}}),
  view:room=>[key,second].includes(room),
  outbox:clientId=>clientId?(outcomes.get(clientId) || null):[...outcomes.values()].filter(row=>!row.acknowledged && ['sending','unknown'].includes(row.phase)),
  acknowledgeOutbox(clientId){const row=outcomes.get(clientId);if(row?.phase!=='unknown')return false;ackCalls.push(clientId);outcomes.set(clientId,{...row,acknowledged:true});outboxVersion++;revision++;return true;},
  rename(room,title){if(title===null)localTitles.delete(room);else localTitles.set(room,title);revision++;return true;},
  settingsSnapshot:()=>enableSettings?settings:null,
  updateSettings(patch){settings={...settings,...patch};revision++;return true;},
  roomPreferences(room,patch){if(Object.hasOwn(patch,'title')){if(patch.title===null)localTitles.delete(room);else localTitles.set(room,patch.title);}roomSettings.set(room,{...roomSettings.get(room),...patch});revision++;return true;},
  forgetSettings(){settings=defaultSettings();roomSettings.clear();localTitles.clear();revision++;return true;},
  claimNotifications:()=>settings.notifications?notificationQueue.splice(0,5):[],
  photo:(_room,msg)=>msg===photoMessage?'https://talkv.kakao.com/offline-test-only':null,
  openRoom(room){contextCalls.push(room);if(adversarialFixture)for(const other of [key,second])if(other!==room)contexts.set(other,'idle');contexts.set(room,'ready');pageVersions.set(room,pageVersions.get(room)+1);revision++;return true;},
  seen(room,token,notify){seenCalls.push({room,token,notify});if(notify)readStates.set(room,{phase:'accepted',messageKey:messagesByRoom.get(room).at(-1).key});unread.set(room,0);revision++;return true;},
  sendText(room,text,clientId,replyTo){if(outcomes.has(clientId))return true;sendCalls.push({room,text,clientId,replyTo});outcomes.set(clientId,{key:room,clientId,kind:'send',phase:'sending'});outboxVersion++;pageVersions.set(room,pageVersions.get(room)+1);revision++;setTimeout(()=>{outcomes.set(clientId,{key:room,clientId,kind:'send',phase:unknownSend?'unknown':'accepted'});if(!unknownSend)messagesByRoom.get(room).push({key:'m_'+(5000+sendCalls.length).toString(16).padStart(24,'0'),text,sender:'나',mine:true,at:1800000100000,unreadCount:1,...(replyTo?{reply:{text:messagesByRoom.get(room).find(row=>row.key===replyTo)?.text,sender:'모의 사용자'}}:{})});outboxVersion++;pageVersions.set(room,pageVersions.get(room)+1);revision++;},150).unref();return true;},
  sendPhoto(room,image,clientId){if(rejectPhoto)return false;sendCalls.push({kind:'photo',room,clientId,byteLength:Buffer.from(image,'base64').length});outcomes.set(clientId,{key:room,clientId,kind:'photo',phase:unknownPhoto?'unknown':'accepted'});outboxVersion++;pageVersions.set(room,pageVersions.get(room)+1);revision++;return true;},
  history(room){if(historyBusy)return false;historyRooms.push(room);historyPhases.set(room,'loading');historyBusy=true;revision++;setTimeout(()=>{if(connected){historyPhases.set(room,'loaded');if(!messagesByRoom.has(room))messagesByRoom.set(room,[...makeMessages(room),...(offlineMessages.get(room) || [])]);historyBusy=false;revision++;}},500).unref();return true;},disconnect(){connected=false;revision++;},close(){connected=false;attempts=0;historyBusy=false;historyPhases.clear();messagesByRoom.clear();localTitles.clear();unread.clear();contexts.clear();outcomes.clear();revision++;},
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
await evaluate("HTMLAnchorElement.prototype.click=globalThis.originalAnchorClick;document.getElementById('photo-dialog').close()");
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
  if(process.env.WEB_KAKAO_QA_ADVERSARIAL_ONLY==='1'){await checkAdversarialBrowser();console.log(JSON.stringify({passed:true,scope:'synthetic adversarial browser only',checks:lifecycleChecks,actualAccountUsed:false,artifacts:folder}));}
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
