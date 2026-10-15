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
let connected=false,revision=0,history=false;
const app=createLocalServer({mode:'live',encode:()=>[[true]],transport:async op=>op==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:op==='generate'?{httpStatus:200,body:{status:0,url:'OFFLINE-NOT-FOR-LOGIN',remainingSeconds:60}}:{httpStatus:200,body:{status:0,user:{userId:'246810'},accessToken:'FAKE_OFFLINE_TOKEN'}},readerFactory:()=>({
  snapshot:()=>({phase:connected?'connected':'idle',attempts:connected?1:0,canConnect:!connected,roomCount:connected?2:0,revision,historyBusy:false,pushBatches:0,connectedAt:connected?Date.now():null}),
  connect(){connected=true;revision++;return true;},
  rooms:()=>({revision,rooms:connected?[{key,title:'모의 대화방 A',preview:'예시 미리보기'},{key:second,title:'모의 대화방 B',preview:'예시 미리보기 B'}]:[]}),
  messages:room=>({key:room,messages:history?[{key:'m_'+'a'.repeat(24),text:payload,sender:'모의 사용자',mine:false,at:1800000000000}]:[],history:{phase:history?'loaded':'idle',receivedCount:history?1:0,acceptedCount:history?1:0}}),
  history(){history=true;revision++;return true;},disconnect(){connected=false;revision++;},close(){connected=false;history=false;revision++;},
})});
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
  const evaluate=async expression=>(await call('Runtime.evaluate',{expression,returnByValue:true})).result?.value;
  const until=async expression=>{const until=Date.now()+10000;while(!await evaluate(expression)){if(Date.now()>until)throw new Error('browser assertion timeout: '+expression);await sleep(100);}};
  await until("!document.getElementById('start').disabled");await evaluate("document.getElementById('start').click()");
  await until("!document.getElementById('reader-connect').disabled");await evaluate("document.getElementById('reader-connect').click()");
  await until("document.querySelectorAll('.room-item').length===2");
  assert.equal(await evaluate("document.getElementById('title').textContent"),'대화 서버 연결됨');
  await evaluate("document.querySelectorAll('.room-item')[1].click()");await until("document.getElementById('chat-title').textContent==='모의 대화방 B'");
  await evaluate("document.getElementById('history-load').click()");await until("document.querySelectorAll('#message-list article').length===1");
  assert.equal(await evaluate('document.querySelector("#message-list p").textContent'),payload);
  assert.equal(await evaluate('document.querySelector("#message-list img")===null && globalThis.injected===undefined'),true);
  const image=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});writeFileSync(resolve(folder,'synthetic-reader.png'),Buffer.from(image.data,'base64'));
  await evaluate("document.getElementById('cancel').click()");await until("document.getElementById('reader-panel').hidden && document.getElementById('message-list').childElementCount===0");
  console.log(JSON.stringify({passed:true,scope:'synthetic offline browser only',checks:['QR UI flow with fake transport','two room list','select room','history display','HTML displayed as plain text','cancel purges DOM'],screenshot:'local-only/phase2-browser/<run>/synthetic-reader.png',actualAccountUsed:false}));
}finally{
  ws?.close();browser?.kill();app.lab.cancel();app.server.close();app.server.closeAllConnections();
}
