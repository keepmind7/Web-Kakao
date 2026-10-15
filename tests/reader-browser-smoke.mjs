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
let connected=false,revision=0,historyBusy=false,rejectNextQr=false,allowAuth=false,otherPreview='예시 미리보기 B',statusRequests=0;
const historyRooms=[],historyPhases=new Map(),messagesByRoom=new Map(),qrGrid=[[true]];
const makeMessages=room=>Array.from({length:40},(_,i)=>({key:'m_'+(i+1).toString(16).padStart(24,'0'),text:i===0?payload:('모의 메시지 '+(i+1)+' ').repeat(50),sender:'모의 사용자',mine:i%2===0,at:1800000000000+i*1000}));
const app=createLocalServer({mode:'live',encode:()=>qrGrid,transport:async op=>op==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:op==='generate'?{httpStatus:200,body:{status:0,url:'OFFLINE-NOT-FOR-LOGIN',remainingSeconds:60}}:rejectNextQr?{httpStatus:200,body:{status:-151}}:allowAuth?{httpStatus:200,body:{status:0,user:{userId:'246810'},accessToken:'FAKE_OFFLINE_TOKEN'}}:{httpStatus:200,body:{status:-150,nextRequestIntervalInSeconds:1}},readerFactory:()=>({
  snapshot:()=>({phase:connected?'connected':'idle',attempts:connected?1:0,canConnect:!connected,roomCount:connected?2:0,revision,historyBusy,pushBatches:0,connectedAt:connected?Date.now():null}),
  connect(){connected=true;revision++;return true;},
  rooms:()=>({revision,rooms:connected?[{key,title:'모의 대화방 A',preview:'예시 미리보기'},{key:second,title:'모의 대화방 B',preview:otherPreview}]:[]}),
  messages:room=>({key:room,messages:messagesByRoom.get(room) || [],history:{phase:historyPhases.get(room) || 'idle',receivedCount:messagesByRoom.get(room)?.length || 0,acceptedCount:messagesByRoom.get(room)?.length || 0}}),
  history(room){if(historyBusy)return false;historyRooms.push(room);historyPhases.set(room,'loading');historyBusy=true;revision++;setTimeout(()=>{if(connected){historyPhases.set(room,'loaded');if(!messagesByRoom.has(room))messagesByRoom.set(room,makeMessages(room));historyBusy=false;revision++;}},500).unref();return true;},disconnect(){connected=false;revision++;},close(){connected=false;historyBusy=false;historyPhases.clear();messagesByRoom.clear();revision++;},
})});
app.server.on('request',req=>{if(req.url==='/api/status')statusRequests++;});
const url=await app.listen(0);
let browser,ws;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
  browser=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--no-proxy-server','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+resolve(folder,'profile'),'--window-size=1280,1000',url],{windowsHide:true,stdio:'ignore'});
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
  const until=async expression=>{const until=Date.now()+10000;while(!await evaluate(expression)){if(Date.now()>until)throw new Error('browser assertion timeout: '+expression);await sleep(100);}};
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
  const image=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});writeFileSync(resolve(folder,'synthetic-reader.png'),Buffer.from(image.data,'base64'));
  await evaluate("document.getElementById('account-toggle').click()");assert.equal(await evaluate("document.getElementById('account-panel').hidden"),false);
  await evaluate("document.getElementById('cancel').click()");await until("document.getElementById('reader-panel').hidden && document.getElementById('message-list').childElementCount===0");
  assert.equal(await evaluate("document.getElementById('chat-title').textContent"),'대화방을 선택해 주세요');
  rejectNextQr=true;
  await until("!document.getElementById('start').disabled");await evaluate("document.getElementById('start').click()");
  await until("document.getElementById('diagnostic').textContent.includes('-151')");
  assert.equal(await evaluate("document.getElementById('message').textContent.includes('지원하지 않는 인증 응답')"),true);
  assert.equal(await evaluate("document.getElementById('reader-status').textContent"),'인증이 완료되지 않았습니다.');
  assert.equal(await evaluate("document.getElementById('start').disabled && document.getElementById('qr').hidden"),true);
  console.log(JSON.stringify({passed:true,scope:'synthetic offline browser only',checks:['QR draw changes only with content','room search and selection queue','loaded room avoids duplicate history request','unchanged DOM retained','other-room update retains conversation scroll','same-ID edits rendered','bottom-follow for new messages','hidden tab polling reduced','visibility changes keep one polling timer','HTML displayed as plain text','cancel purges title and messages','QR -151 neutral message'],visibleRequests,hiddenRequests,screenshot:folder+'/synthetic-reader.png',actualAccountUsed:false}));
}finally{
  ws?.close();browser?.kill();app.lab.cancel();app.server.close();app.server.closeAllConnections();
}
