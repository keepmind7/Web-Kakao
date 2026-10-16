// Explicit offline browser fixture. Never attach to the user's browser/profile
// or the actual account server. Only synthetic text is captured.
import { spawn } from 'node:child_process';
import { existsSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLocalServer } from '../experiments/local-web/server.mjs';
import assert from 'node:assert/strict';

const chrome=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);
if(!chrome)throw new Error('Chrome unavailable; browser test not executed');
const folder=resolve('local-only/phase2-browser',String(Date.now()));mkdirSync(folder,{recursive:true});
const key='r_'+'a'.repeat(24),second='r_'+'b'.repeat(24),payload='<img src=x onerror="globalThis.injected=true">';
let connected=false,attempts=0,revision=0,historyBusy=false,rejectNextQr=false,allowAuth=false,otherPreview='예시 미리보기 B',statusRequests=0;
const historyRooms=[],historyPhases=new Map(),messagesByRoom=new Map(),qrGrid=[[true]];
const localTitles=new Map(),unread=new Map(),contexts=new Map(),outcomes=new Map(),seenCalls=[],sendCalls=[];
const readStates=new Map(),historyGaps=new Map(),latestMissing=new Set();
let unknownSend=false,unknownPhoto=false;
const offlineMessages=new Map();
let enableSettings=false;
const defaultSettings=()=>({persist:false,notifications:false,readSync:false,roomFilter:'all',storageAvailable:true,storageError:false});
let settings=defaultSettings();const roomSettings=new Map(),notificationQueue=[];
const photoMessage='m_'+'9'.repeat(24),syntheticPhoto=Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64');
const syntheticPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const makeMessages=room=>Array.from({length:40},(_,i)=>({key:'m_'+(i+1).toString(16).padStart(24,'0'),text:i===0?payload:('모의 메시지 '+(i+1)+' ').repeat(50),sender:'모의 사용자',mine:i%2===0,canReply:true,at:1800000000000+i*1000}));
const app=createLocalServer({mode:'live',messaging:true,photoFetcher:async()=>({data:syntheticPhoto,type:'image/gif'}),encode:()=>qrGrid,transport:async op=>op==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:op==='generate'?{httpStatus:200,body:{status:0,url:'OFFLINE-NOT-FOR-LOGIN',remainingSeconds:60}}:rejectNextQr?{httpStatus:200,body:{status:-151}}:allowAuth?{httpStatus:200,body:{status:0,user:{userId:'246810'},accessToken:'FAKE_OFFLINE_TOKEN'}}:{httpStatus:200,body:{status:-150,nextRequestIntervalInSeconds:1}},readerFactory:()=>({
  snapshot:()=>({phase:connected?'connected':attempts?'disconnected':'idle',attempts,canConnect:!connected,roomCount:connected?2:0,revision,historyBusy,pushBatches:0,connectedAt:connected?Date.now():null}),
  connect(){if(attempts++) {historyPhases.clear();messagesByRoom.clear();contexts.clear();readStates.clear();}connected=true;revision++;return true;},
  rooms:()=>({revision,rooms:connected?[{key,title:'모의 대화방 A',preview:'예시 미리보기'},{key:second,title:'모의 대화방 B',preview:otherPreview}].map(row=>({...row,baseTitle:row.title,title:localTitles.get(row.key) || row.title,localTitle:localTitles.get(row.key) || null,pinOrder:roomSettings.get(row.key)?.pinOrder ?? null,muted:roomSettings.get(row.key)?.muted===true,canSend:true,kind:'DirectChat',unreadLocalCount:unread.get(row.key) || 0,unreadCoverage:'observed'})):[]}),
  messages:room=>({key:room,messages:messagesByRoom.get(room) || [],latestVisible:!latestMissing.has(room),seenToken:'c'.repeat(48),receiptPhase:contexts.get(room) || 'idle',readSync:readStates.get(room) || {phase:'idle'},outbox:[...outcomes.values()].filter(row=>row.key===room),history:{phase:historyPhases.get(room) || 'idle',gap:historyGaps.get(room)===true,receivedCount:messagesByRoom.get(room)?.length || 0,acceptedCount:messagesByRoom.get(room)?.length || 0}}),
  rename(room,title){if(title===null)localTitles.delete(room);else localTitles.set(room,title);revision++;return true;},
  settingsSnapshot:()=>enableSettings?settings:null,
  updateSettings(patch){settings={...settings,...patch};revision++;return true;},
  roomPreferences(room,patch){if(Object.hasOwn(patch,'title')){if(patch.title===null)localTitles.delete(room);else localTitles.set(room,patch.title);}roomSettings.set(room,{...roomSettings.get(room),...patch});revision++;return true;},
  forgetSettings(){settings=defaultSettings();roomSettings.clear();localTitles.clear();revision++;return true;},
  claimNotifications:()=>settings.notifications?notificationQueue.splice(0,5):[],
  photo:(_room,msg)=>msg===photoMessage?'https://talkv.kakao.com/offline-test-only':null,
  openRoom(room){contexts.set(room,'ready');revision++;return true;},
  seen(room,token,notify){seenCalls.push({room,token,notify});if(notify)readStates.set(room,{phase:'accepted',messageKey:messagesByRoom.get(room).at(-1).key});unread.set(room,0);revision++;return true;},
  sendText(room,text,clientId,replyTo){if(outcomes.has(clientId))return true;sendCalls.push({room,text,clientId,replyTo});outcomes.set(clientId,{key:room,clientId,phase:'sending'});revision++;setTimeout(()=>{outcomes.set(clientId,{key:room,clientId,phase:unknownSend?'unknown':'accepted'});if(!unknownSend)messagesByRoom.get(room).push({key:'m_'+(5000+sendCalls.length).toString(16).padStart(24,'0'),text,sender:'나',mine:true,at:1800000100000,unreadCount:1,...(replyTo?{reply:{text:messagesByRoom.get(room).find(row=>row.key===replyTo)?.text,sender:'모의 사용자'}}:{})});revision++;},150).unref();return true;},
  sendPhoto(room,image,clientId){sendCalls.push({kind:'photo',room,clientId,byteLength:Buffer.from(image,'base64').length});outcomes.set(clientId,{key:room,clientId,phase:unknownPhoto?'unknown':'accepted'});revision++;return true;},
  history(room){if(historyBusy)return false;historyRooms.push(room);historyPhases.set(room,'loading');historyBusy=true;revision++;setTimeout(()=>{if(connected){historyPhases.set(room,'loaded');if(!messagesByRoom.has(room))messagesByRoom.set(room,[...makeMessages(room),...(offlineMessages.get(room) || [])]);historyBusy=false;revision++;}},500).unref();return true;},disconnect(){connected=false;revision++;},close(){connected=false;attempts=0;historyBusy=false;historyPhases.clear();messagesByRoom.clear();localTitles.clear();unread.clear();contexts.clear();outcomes.clear();revision++;},
})});
app.server.on('request',req=>{if(req.url==='/api/status')statusRequests++;});
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
  ws.addEventListener('message',event=>{const message=JSON.parse(event.data);const item=pending.get(message.id);if(item){pending.delete(message.id);clearTimeout(item.timer);message.error?item.reject(new Error('CDP failure')):item.resolve(message.result);}});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout'));},5000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{
    const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description || 'browser evaluation failed');
    return result.result?.value;
  };
  const until=async expression=>{const until=Date.now()+10000;while(!await evaluate(expression)){if(Date.now()>until){console.log(JSON.stringify({syntheticBrowserTimeout:await evaluate("({selectedRoom,pendingSelection,busy,refreshing,ackInFlight,pageKey:currentPage?.key,history:currentPage?.history,readSync:currentPage?.readSync,reader:lastState?.reader,messageCount:document.querySelectorAll('#message-list article').length,historyButtonDisabled:el('history-load').disabled})"),historyRooms,statusRequests}));throw new Error('browser assertion timeout: '+expression);}await sleep(100);}};
  const refreshUi=()=>evaluate("(async()=>{while(refreshing || busy)await new Promise(resolve=>setTimeout(resolve,10));await refresh();})()");
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
  await until("pendingSend===null && document.getElementById('reply-preview').hidden && document.querySelector('.message-quote')");
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
  await evaluate("document.getElementById('compose-text').value='';document.getElementById('compose-text').dispatchEvent(new Event('input'))");
  messagesByRoom.get(key).push({key:photoMessage,text:'[사진]',sender:'모의 사용자',mine:false,at:1800000300000,photos:[{src:`/api/photo?room=${key}&message=${photoMessage}&index=0`,width:1,height:1}]});revision++;await refreshUi();
  await until("document.querySelector('.photo-open img')?.naturalWidth===1");
  await evaluate("document.querySelector('.photo-open').click()");await until("document.getElementById('photo-dialog').open && document.getElementById('photo-full').naturalWidth===1");
  await evaluate("document.getElementById('photo-close').click()");assert.equal(await evaluate("!document.getElementById('photo-dialog').open && !document.getElementById('photo-full').hasAttribute('src')"),true);
  const image=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});writeFileSync(resolve(folder,'synthetic-reader.png'),Buffer.from(image.data,'base64'));
  await call('Emulation.setDeviceMetricsOverride',{width:580,height:900,deviceScaleFactor:1,mobile:false});
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
  await evaluate("document.getElementById('reader-disconnect').click()");await until("lastState.reader.phase==='disconnected' && !busy");
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
  await evaluate("if(document.getElementById('account-panel').hidden)document.getElementById('account-toggle').click()");assert.equal(await evaluate("document.getElementById('account-panel').hidden"),false);
  await evaluate("document.getElementById('cancel').click()");await until("document.getElementById('reader-panel').hidden && document.getElementById('message-list').childElementCount===0");
  assert.equal(await evaluate("document.getElementById('chat-title').textContent"),'대화방을 선택해 주세요');
  assert.equal(await evaluate("pinnedRooms.size===0 && roomFilter==='all' && messageQuery==='' && document.getElementById('message-search-bar').hidden && document.getElementById('message-action-status').hidden"),true);
  rejectNextQr=true;
  await until("!document.getElementById('start').disabled");await evaluate("document.getElementById('start').click()");
  await until("document.getElementById('diagnostic').textContent.includes('-151')");
  assert.equal(await evaluate("document.getElementById('message').textContent.includes('지원하지 않는 인증 응답')"),true);
  assert.equal(await evaluate("document.getElementById('reader-status').textContent"),'인증이 완료되지 않았습니다.');
  assert.equal(await evaluate("document.getElementById('start').disabled && document.getElementById('qr').hidden"),true);
  console.log(JSON.stringify({passed:true,scope:'synthetic offline browser only',checks:['QR caching','room selection queue','DOM and scroll retention','hidden polling','text-only rendering','unread badge and total','local rename and reset','receipt count disappears on read','hidden/unfocused/scrolled room is not acknowledged','visible latest message acknowledgement','optional server read sync','IME Enter does not send','double-click sends once','unknown send preserves draft without retry','room pin ordering and filters retain selection and drafts','literal message search and result navigation','search does not acknowledge incoming messages','clipboard success and denial without OS clipboard access','pins survive transport reconnect and clear on account close','reconnect restores selected room and draft','offline messages fetched once without load button or read notification','cancel purges account data','QR -151 neutral message'],visibleRequests,hiddenRequests,screenshot:folder+'/synthetic-reader.png',actualAccountUsed:false}));
}finally{
  ws?.close();browser?.kill();app.lab.cancel();app.server.close();app.server.closeAllConnections();
}
