import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createReaderStore,serverId } from '../experiments/local-web/reader-data.mjs';
import { createReaderSession,allowedReaderMethod } from '../experiments/local-web/reader-session.mjs';
import { createReadOnlyReader } from '../experiments/local-web/reader-manager.mjs';
import { createLocalServer } from '../experiments/local-web/server.mjs';
import { createAuthLab } from '../experiments/local-web/kakao-auth.mjs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const credential={userId:'246810',deviceUUID:'FAKE_PRIVATE_DEVICE',accessToken:'FAKE_PRIVATE_TOKEN',refreshToken:'FAKE_PRIVATE_REFRESH'};
const body={chatDatas:[{chatId:'9007199254740993',title:'예시 대화방',lastLog:{logId:'12',msg:'예시 미리보기',sendAt:1800000000}},{chatId:'9007199254740995'}]};
const tick=()=>new Promise(setImmediate);
test('reader worker exits on parent disconnect without receiving any credentials',async()=>{
  const child=fork(fileURLToPath(new URL('../experiments/local-web/reader-worker.mjs',import.meta.url)),[],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  try{
    const code=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('worker did not exit')),5000);
      child.once('error',error=>{clearTimeout(timeout);reject(error);});child.on('message',message=>{if(message?.type==='reader-ready')child.disconnect();});child.once('exit',code=>{clearTimeout(timeout);resolve(code);});
    });assert.equal(code,0);
  }finally{if(child.exitCode===null)child.kill();}
});
test('a failed Phase 1 probe also blocks the Phase 2 credential consumer and QR retries',async()=>{
  let poll;
  const lab=createAuthLab({encodeQr:()=>[[true]],later:(callback,ms)=>{if(ms===2000)poll=callback;return 0;},clear:()=>{},transport:async op=>op==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:op==='generate'?{httpStatus:200,body:{status:0,url:'fake-offline',remainingSeconds:30}}:{httpStatus:200,body:{status:0,user:{userId:credential.userId},accessToken:credential.accessToken}}});
  await lab.start();await poll();await lab.connectReadOnly(async()=>({phase:'failed',stage:'loginlist',status:-997,connectionVerified:false}));
  assert.equal(lab.snapshot().sessionBlocked,true);assert.equal(lab.snapshot().credentialInMemory,false);assert.equal(lab.withCredential(()=>{throw new Error('must not expose credential');}),false);assert.equal(lab.snapshot().canProbe,false);lab.cancel();assert.equal(lab.snapshot().canStart,false);
});
test('reader room handles preserve 64-bit IDs internally and never disclose raw identifiers',()=>{
  const store=createReaderStore(body,credential.userId);const rooms=store.rooms();
  assert.equal(rooms.length,2);assert.equal(rooms[1].titleKnown,false);
  assert.equal(store.serverRoomId(rooms[0].key),'9007199254740993');
  assert.equal(JSON.stringify(rooms).includes('9007199254740993'),false);
  assert.equal(serverId(Number('9007199254740993')),'');
  assert.equal(serverId({toString:()=> '9007199254740993'}),'9007199254740993');
  assert.throws(()=>createReaderStore({},credential.userId));
});
test('message IDs deduplicate and sort without precision loss; absent times are not fabricated',()=>{
  const store=createReaderStore(body,credential.userId),key=store.rooms()[0].key;
  const response=store.history(key,{chatLogs:[{logId:'9007199254740995',msg:'둘',authorId:'111'},{logId:'9007199254740993',msg:'하나',authorId:credential.userId},{logId:'9007199254740995',msg:'둘 수정',authorId:'111'}]});
  assert.deepEqual(response.messages.map(row=>row.text),['하나','둘 수정']);assert.equal(response.messages[0].mine,true);assert.equal(response.messages[0].at,null);
  assert.equal(store.stats().duplicates,1);assert.equal(response.acceptedCount,3);
  const serialized=JSON.stringify(response);assert.equal(serialized.includes('9007199254740993'),false);assert.equal(serialized.includes('246810'),false);
});
test('display names already present in LOGINLIST can label rooms without extra member requests',()=>{
  const store=createReaderStore({chats:[{chatId:'1001',displayMembers:[{nickName:'예시 이름'}]}]},credential.userId);
  assert.equal(store.rooms()[0].title,'예시 이름');assert.equal(store.rooms()[0].titleKnown,true);
});
test('empty, missing and entirely invalid history are distinguishable',()=>{
  const store=createReaderStore(body,credential.userId),key=store.rooms()[0].key;
  const empty=store.history(key,{chatLogs:[]});assert.equal(empty.fieldPresent,true);assert.equal(empty.receivedCount,0);
  assert.equal(store.history(key,{}).fieldPresent,false);
  const invalid=store.history(key,{chatLogs:[{msg:'ID 없음'},{logId:'14',chatId:'999',msg:'다른 방'}]});
  assert.equal(invalid.receivedCount,2);assert.equal(invalid.acceptedCount,0);assert.equal(invalid.rejectedCount,2);assert.equal(invalid.messages.length,0);
});
test('cross-room push cannot contaminate previews, and unknown rooms are not silently created',()=>{
  const store=createReaderStore(body,credential.userId),before=store.rooms();
  assert.deepEqual(store.push({chatId:'9007199254740993',chatLog:{chatId:'9007199254740995',logId:'25',msg:'잘못된 방',sendAt:1900000000}}),[]);
  assert.deepEqual(store.rooms(),before);
  assert.deepEqual(store.push({chatId:'999',chatLog:{logId:'25',msg:'미등록'}}),[]);
  const update=store.push({chatId:'9007199254740993',chatLog:{logId:'25',msg:'예시 새 메시지',sendAt:1900000000}});
  assert.equal(update.length,1);assert.equal(store.rooms()[0].preview,'예시 새 메시지');
});
test('message display is bounded and media contents are not fetched or rendered as text payloads',()=>{
  const store=createReaderStore(body,credential.userId),key=store.rooms()[0].key;
  const result=store.history(key,{chatLogs:Array.from({length:80},(_,i)=>({logId:String(i+1),msg:'x'.repeat(5000),type:i===79?2:1}))});
  assert.equal(result.messages.length,50);assert.equal(result.messages.at(-1).text,'[사진]');assert.equal(result.messages[0].text.length,4000);
  store.clear();assert.equal(store.rooms().length,0);
});
function factory({historyStatus=0,pingStatus=0}={}){
  const calls=[],closed=[];let heartbeat;
  const client=name=>Object.assign(new EventEmitter(),{
    async connect(){calls.push(name+':connect');},
    async request(method){calls.push(method);return {status:method==='PING'?pingStatus:0,body:{ticket:{lsl:['ticket.kakao.com']},wifi:{ports:[443]}}};},
    async checkin(){calls.push('CHECKIN');return {status:0,host:'carriage.kakao.com',port:443};},
    async loginList(){calls.push('LOGINLIST');return {status:0,body};},
    async syncMsg(room,cur,count){calls.push('SYNCMSG');assert.equal(room,'9007199254740993');assert.equal(cur,0);assert.equal(count,50);return {status:historyStatus,body:{chatLogs:[{logId:'30',msg:'예시 조회 메시지'}]}};},
    stopPing(){},disconnect(){closed.push(name);},
  });
  const carriage=client('carriage');
  return {calls,closed,carriage,ping:()=>heartbeat(),sdk:{booking:()=>client('booking'),ticket:()=>client('ticket'),carriage:()=>carriage,toLong:value=>value,resolve:async host=>host,every:callback=>{heartbeat=callback;return 0;}}};
}
test('persistent reader permits only read-only methods and does not query history before selection',async()=>{
  const f=factory(),events=[],session=createReaderSession(credential,f.sdk,event=>events.push(event));
  try{
    assert.deepEqual(await session.start(),{ok:true});assert.equal(f.calls.includes('SYNCMSG'),false);
    const key=events.find(event=>event.type==='reader-rooms').rooms[0].key;
    assert.equal(await session.history(key,1),true);assert.equal(events.at(-1).source,'history');
    await f.ping();assert.equal(f.calls.includes('PING'),true);
    for(const method of ['WRITE','READ','CHATONROOM','MEMBER','SYNCLINK'])assert.equal(allowedReaderMethod(method),false);
    f.carriage.emit('push',{method:'MSG',status:0,body:{chatId:'9007199254740993',chatLog:{logId:'31',msg:'예시 수신'}}});
    assert.equal(events.some(event=>event.type==='reader-messages' && event.source==='push'),true);
  }finally{session.close();}
  assert.ok(f.closed.includes('carriage'));
});
test('PING and MSG denial statuses terminate instead of being treated as healthy traffic',async()=>{
  for(const route of ['ping','push']){
    const f=factory({pingStatus:-997}),events=[],session=createReaderSession(credential,f.sdk,event=>events.push(event));
    await session.start();
    if(route==='ping')await f.ping();else f.carriage.emit('push',{method:'MSG',status:-997,body:{}});
    const failure=events.find(event=>event.type==='reader-failed');assert.equal(failure.stage,route);assert.equal(failure.status,-997);
    assert.equal(await session.history(events[0].rooms[0].key,1),false);session.close();
  }
});
test('history rejection closes the session without inventing cached history success',async()=>{
  const f=factory({historyStatus:-997}),events=[],session=createReaderSession(credential,f.sdk,event=>events.push(event));
  await session.start();assert.equal(await session.history(events[0].rooms[0].key,1),false);
  assert.equal(events.at(-1).type,'reader-failed');assert.equal(events.at(-1).status,-997);session.close();
});
function fakeWorker(){
  const sent=[];let killed=false;
  const child=Object.assign(new EventEmitter(),{send(message,callback){sent.push({message,callback});},kill(){killed=true;return true;}});
  return {child,sent,get killed(){return killed;}};
}
function ready(worker){worker.child.emit('message',{type:'reader-ready'});worker.child.emit('message',{type:'reader-rooms',source:'loginlist',rooms:[{key:'r_'+'a'.repeat(24),title:'예시 방',preview:'예시',lastAt:null,rawToken:'FAKE_PRIVATE_TOKEN'}],stats:{sourceRoomCount:1}});}
test('manager sends minimum credentials through private IPC and exposes summary only',()=>{
  const w=fakeWorker();let options;
  const reader=createReadOnlyReader({spawn:(entry,args,opts)=>{options=opts;return w.child;}});
  assert.equal(reader.connect(credential),true);ready(w);
  assert.equal(w.sent[0].message.credential.refreshToken,undefined);assert.equal(w.sent[0].message.credential.accessToken,credential.accessToken);
  assert.deepEqual(options.stdio,['ignore','ignore','ignore','ipc']);assert.equal(options.env.KAKAO_DEBUG_LOCO,'0');assert.equal(options.env.GITHUB_TOKEN,undefined);
  assert.equal(reader.snapshot().phase,'connected');assert.equal(JSON.stringify(reader.rooms()).includes('FAKE_PRIVATE_TOKEN'),false);assert.equal(JSON.stringify(reader.snapshot()).includes('예시 방'),false);reader.close();
});
test('cancel is terminal and late events cannot restore private data',()=>{
  const w=fakeWorker(),abort=new AbortController();const reader=createReadOnlyReader({spawn:()=>w.child});reader.connect(credential,{signal:abort.signal});ready(w);
  abort.abort();reader.disconnect();ready(w);
  assert.equal(reader.snapshot().phase,'closed');assert.equal(reader.snapshot().canConnect,false);assert.equal(reader.rooms().rooms.length,0);assert.equal(w.killed,true);assert.equal(reader.connect(credential),false);
});
test('old worker send errors cannot terminate a newly connected worker',()=>{
  const one=fakeWorker(),two=fakeWorker();let n=0;const reader=createReadOnlyReader({spawn:()=>n++===0?one.child:two.child});
  reader.connect(credential);ready(one);const old=one.sent[0].callback;reader.disconnect();reader.connect(credential);ready(two);old(new Error('late private error'));
  assert.equal(reader.snapshot().phase,'connected');assert.equal(two.killed,false);reader.close();
});
test('manager rejects duplicate history requests and distinguishes invalid replies from empty history',()=>{
  const w=fakeWorker(),reader=createReadOnlyReader({spawn:()=>w.child});reader.connect(credential);ready(w);const key=reader.rooms().rooms[0].key;
  assert.equal(reader.history(key),true);assert.equal(reader.history(key),false);
  const requestId=w.sent.at(-1).message.requestId;
  w.child.emit('message',{type:'reader-messages',source:'history',requestId,key,messages:[],fieldPresent:true,receivedCount:2,acceptedCount:0,rejectedCount:2});
  assert.equal(reader.messages(key).history.phase,'unrecognized');assert.equal(reader.snapshot().historySuccesses,0);
  reader.history(key);w.child.emit('message',{type:'reader-messages',source:'history',requestId:w.sent.at(-1).message.requestId,key,messages:[],fieldPresent:true,receivedCount:0,acceptedCount:0});
  assert.equal(reader.messages(key).history.phase,'loaded');assert.equal(reader.snapshot().historySuccesses,1);reader.close();
});
test('server denies reader requests before authentication and protects history and active shutdown',async()=>{
  const key='r_'+'a'.repeat(24);let release,historyCalls=0,connected=false,blockSession;
  const readyPoll=new Promise(resolve=>{release=resolve;});
  const app=createLocalServer({mode:'live',encode:()=>[[true]],transport:async op=>op==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:op==='generate'?{httpStatus:200,body:{status:0,url:'fake-offline-qr',remainingSeconds:30}}:(queueMicrotask(release),{httpStatus:200,body:{status:0,user:{userId:credential.userId},accessToken:credential.accessToken}}),readerFactory:({onBlocked})=>{blockSession=onBlocked;return {snapshot:()=>({phase:connected?'connected':'idle',canConnect:!connected,roomCount:connected?1:0}),connect(cred){assert.equal(cred.accessToken,credential.accessToken);connected=true;return true;},rooms:()=>({rooms:connected?[{key,title:'예시 방'}]:[]}),messages:value=>value===key?{key,messages:[],history:{phase:'idle'}}:null,history(value){historyCalls++;return connected && value===key;},disconnect(){connected=false;},close(){connected=false;}};}});
  const url=await app.listen(0);
  try{
    assert.equal((await fetch(url+'/api/reader/rooms')).status,403);
    const page=await fetch(url),cookie=page.headers.get('set-cookie').split(';')[0];
    let state=await(await fetch(url+'/api/status',{headers:{cookie}})).json();
    const headers={cookie,origin:url,'content-type':'application/json','x-csrf-token':state.csrf};
    const post=(path,body={},extra={})=>fetch(url+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
    assert.equal((await fetch(url+'/api/reader/rooms',{headers:{cookie}})).status,409);
    await app.lab.start();await readyPoll;await tick();
    assert.equal((await post('/api/shutdown')).status,409);
    assert.equal((await post('/api/reader/connect')).status,202);
    assert.equal((await post('/api/reader/history',{room:key},{origin:'https://evil.example'})).status,403);assert.equal(historyCalls,0);
    assert.equal((await post('/api/reader/history',{room:credential.userId})).status,400);
    assert.equal((await post('/api/reader/history',{room:key})).status,202);
    const status=await(await fetch(url+'/api/status',{headers:{cookie}})).text();assert.equal(status.includes('예시 방'),false);assert.equal(status.includes(credential.accessToken),false);
    blockSession();
    assert.equal((await post('/api/reader/connect')).status,409);assert.equal((await post('/api/room-probe')).status,409);
    await post('/api/cancel');assert.equal((await post('/api/start')).status,409);assert.equal((await fetch(url+'/api/reader/rooms',{headers:{cookie}})).status,409);
  }finally{app.lab.cancel();app.server.close();app.server.closeAllConnections();}
});
