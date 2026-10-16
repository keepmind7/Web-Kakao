import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRoomState,cleanRoomTitle } from '../experiments/local-web/reader-room-state.mjs';
import { createReaderStore } from '../experiments/local-web/reader-data.mjs';
import { createReadOnlyReader } from '../experiments/local-web/reader-manager.mjs';
import { createReaderSession,allowedReaderMethod } from '../experiments/local-web/reader-session.mjs';
import { guardReaderClient } from '../experiments/local-web/reader-protocol.mjs';
import { createLocalServer } from '../experiments/local-web/server.mjs';

const room='r_'+'a'.repeat(24),other='r_'+'b'.repeat(24),msg=n=>'m_'+n.toString(16).padStart(24,'0');
const incoming=n=>({key:msg(n),incoming:true,afterBaseline:true,userMessage:true});
test('unread ledger excludes duplicates, own messages, baseline history and control events',()=>{
  const state=createRoomState();state.bind([{key:room}]);
  state.receive(room,[incoming(1),incoming(2),incoming(1),{...incoming(3),incoming:false},{...incoming(4),afterBaseline:false},{...incoming(5),userMessage:false}]);
  assert.equal(state.decorate({key:room,title:'예시'}).unreadLocalCount,2);
  state.receive(room,[incoming(1)]);assert.equal(state.decorate({key:room}).unreadLocalCount,2);
});
test('seen tokens acknowledge only the captured room and sequence, with no race loss',()=>{
  const state=createRoomState();state.bind([{key:room},{key:other}]);state.receive(room,[incoming(1)]);
  const token=state.issue(room,msg(1));state.receive(room,[incoming(2)]);
  assert.equal(state.seen(other,token),null);assert.deepEqual(state.seen(room,token),{message:msg(1)});
  assert.equal(state.decorate({key:room}).unreadLocalCount,1);assert.equal(state.seen(room,token),null);
});
test('bounded ledger reports partial coverage without counting replayed entries after overflow',()=>{
  const state=createRoomState({perRoomLimit:2,totalLimit:2});state.bind([{key:room}]);
  state.receive(room,[incoming(1),incoming(2),incoming(3),incoming(1)]);
  assert.equal(state.decorate({key:room}).unreadLocalCount,2);assert.equal(state.decorate({key:room}).unreadCoverage,'partial');
});
test('local title validation, reset and reconnect isolation do not use room titles as identities',()=>{
  const state=createRoomState();state.bind([{key:room},{key:other}]);
  assert.equal(state.rename(room,'  <img src=x>한글😀  '),true);assert.equal(state.decorate({key:room,title:'기본'}).title,'<img src=x>한글😀');
  assert.equal(state.decorate({key:other,title:'기본'}).title,'기본');state.bind([{key:room}],{reconnect:true});
  assert.equal(state.decorate({key:room}).localTitle,'<img src=x>한글😀');
  assert.equal(state.rename(room,null),true);assert.equal(state.decorate({key:room,title:'기본'}).title,'기본');
  for(const value of ['', 'a\nb','a'.repeat(121),42])assert.equal(cleanRoomTitle(value),null);
  assert.equal(cleanRoomTitle('😀'.repeat(120)),'😀'.repeat(120));state.clear();assert.equal(state.rename(room,'다른 계정'),false);
});
const source={chatDatas:[{c:'9007199254740993',t:'DirectChat',ll:'12',l:{logId:'12',msg:'합성',authorId:'111'}},{c:'10',t:'MemoChat',ll:'2'}]};
test('stable account-session salt retains opaque handles, MemoChat has a verified type-based name',()=>{
  const a=createReaderStore(source,'999',Buffer.alloc(32,7)),b=createReaderStore(source,'999',Buffer.alloc(32,7));
  assert.deepEqual(a.rooms(),b.rooms());assert.equal(a.rooms()[1].title,'나와의 채팅');
  assert.equal(JSON.stringify(a.rooms()).includes('9007199254740993'),false);
});
test('receipt counts require complete peer watermarks and update on DECUNREAD without precision loss',()=>{
  const store=createReaderStore(source,'999'),key=store.rooms()[0].key;
  store.push({chatId:'9007199254740993',chatLog:{logId:'9007199254740999',authorId:'999',msg:'합성'}});
  assert.equal(store.current(key).messages[0].unreadCount,null);
  assert.equal(store.receiptSnapshot(key,{c:'9007199254740993',m:[{userId:'999'},{userId:'111'}],a:['111'],w:['0']}),true);
  assert.equal(store.current(key).messages[0].unreadCount,1);
  store.readUpdate({chatId:'9007199254740993',userId:'111',watermark:'9007199254740999'});
  assert.equal(store.current(key).messages[0].unreadCount,0);
  store.readUpdate({chatId:'9007199254740993',userId:'111',watermark:'2'});assert.equal(store.current(key).messages[0].unreadCount,0);
  assert.equal(store.receiptSnapshot(key,{c:'9007199254740993',m:[{userId:'999'},{userId:'111'}],a:[],w:[]}),false);
  assert.equal(store.current(key).messages[0].unreadCount,null);
});
test('a foreign-room receipt and write ACK cannot alter another room or fabricate a message',()=>{
  const store=createReaderStore(source,'999'),key=store.rooms()[0].key;
  assert.equal(store.receiptSnapshot(key,{c:'10',m:[],a:[],w:[]}),false);
  assert.equal(store.writeAccepted(key,{logId:'20',chatId:'10'},'합성'),null);
  assert.equal(store.current(key).messages.length,0);
});
test('group receipts use complete membership and are hidden after membership changes',()=>{
  const store=createReaderStore({chatDatas:[{c:'123',t:'MultiChat',a:3,ll:'20'}]},'999'),key=store.rooms()[0].key;
  store.push({chatId:'123',chatLog:{logId:'20',authorId:'999',msg:'합성'}});
  assert.equal(store.receiptSnapshot(key,{c:'123',m:[{userId:'999'},{userId:'111'}],a:['111'],w:['0']}),false);
  assert.equal(store.current(key).messages[0].unreadCount,null);
  assert.equal(store.receiptSnapshot(key,{c:'123',mi:['999','111','222'],a:['111','222'],w:['0','20']}),true);
  assert.equal(store.current(key).messages[0].unreadCount,1);
  store.invalidateReceipts({chatId:'123'});assert.equal(store.current(key).messages[0].unreadCount,null);
});
test('seen API cannot notify a forged or evicted message snapshot',()=>{
  const child=worker(),reader=createReadOnlyReader({messaging:true,spawn:()=>child});reader.connect(cred);ready(child);
  assert.equal(reader.seen(room,'a'.repeat(48),true),false);
  assert.equal(child.sent.filter(row=>row.type==='reader-action').length,0);reader.close();
});
test('WRITE ACK and its MSG echo merge as one message, neither adds an incoming unread event',()=>{
  const store=createReaderStore(source,'999'),key=store.rooms()[0].key;
  const accepted=store.writeAccepted(key,{logId:'20',sendAt:1800000000},'합성');
  const echo=store.push({chatId:'9007199254740993',chatLog:{logId:'20',authorId:'999',msg:'합성',sendAt:1800000000}})[0];
  assert.equal(echo.messages.length,1);assert.equal(echo.messages[0].key,accepted.messageKey);assert.equal(echo.arrivals[0].incoming,false);
});
test('messaging methods need an explicit capability; arbitrary methods stay forbidden',async()=>{
  class Client extends EventEmitter {constructor(){super();this.pending=new Map();}async request(){return {status:0,body:{}};}}
  const Off=guardReaderClient(Client),On=guardReaderClient(Client,null,{messaging:true});
  for(const method of ['WRITE','NOTIREAD','CHATONROOM']){assert.equal(allowedReaderMethod(method),false);await assert.rejects(new Off().request(method,{}));assert.equal((await new On().request(method,{})).status,0);}
  await assert.rejects(new On().request('DELETEMSG',{}));
});
function worker(){const sent=[];return Object.assign(new EventEmitter(),{sent,send(value,callback){sent.push(value);callback?.();},kill(){}});}
const cred={userId:'999',deviceUUID:'FAKE_DEVICE',accessToken:'FAKE_TOKEN'};
function ready(child){child.emit('message',{type:'reader-ready'});child.emit('message',{type:'reader-rooms',source:'loginlist',rooms:[{key:room,title:'합성 방',canSend:true,kind:'DirectChat'}],stats:{sourceRoomCount:1}});}
test('healthy manual reconnects are not limited by the cumulative attempt count',()=>{
  const children=[],reader=createReadOnlyReader({spawn:()=>{const child=worker();children.push(child);return child;}});
  try{for(let i=0;i<6;i++){assert.equal(reader.snapshot().canConnect,true);assert.equal(reader.connect(cred),true);ready(children.at(-1));reader.disconnect();}assert.equal(reader.snapshot().attempts,6);assert.equal(reader.snapshot().canConnect,true);}finally{reader.close();}
});
test('three consecutive startup failures still stop reconnects and rejection still blocks',()=>{
  for(const rejected of [false,true]){
    const children=[],reader=createReadOnlyReader({spawn:()=>{const child=worker();children.push(child);return child;}});
    try{
      for(let i=0;i<(rejected?1:3);i++){assert.equal(reader.connect(cred),true);children.at(-1).emit('message',{type:'reader-failed',stage:'loginlist',status:rejected?-203:null});}
      assert.equal(reader.snapshot().canConnect,false);assert.equal(reader.connect(cred),false);
    }finally{reader.close();}
  }
});
test('unknown live rooms require matching CHATINFO before admission and retain write restrictions',()=>{
  const store=createReaderStore(source,'999'),packet={chatId:'222',chatLog:{logId:'50',authorId:'111',msg:'합성 새 방'}};
  assert.deepEqual(store.unknownRooms(packet),['222']);assert.equal(store.push(packet).length,0);
  assert.equal(store.discover('222',{chatInfo:{chatId:'333',type:'DirectChat'}}),null);
  assert.equal(store.discover('222',{chatInfo:{chatId:'222',type:'DirectChat',left:true}}),null);
  const key=store.discover('222',{chatInfo:{chatId:'222',type:'DirectChat',activeMembersCount:2,lastLogId:'50',displayMembers:[{nickName:'합성 상대'}]}});
  assert.equal(store.rooms().find(r=>r.key===key).title,'합성 상대');assert.equal(store.canSend(key),true);
  const update=store.push(packet)[0];assert.equal(update.arrivals[0].afterBaseline,true);assert.equal(update.messages[0].text,'합성 새 방');
  assert.deepEqual(store.unknownRooms(packet),[]);assert.equal(store.discover('222',{chatInfo:{chatId:'222',type:'DirectChat'}}),null);
  const unknown=store.discover('333',{chatInfo:{chatId:'333',type:'UnverifiedKind'}});assert.equal(store.canSend(unknown),false);
  assert.deepEqual(store.unknownRooms({chatId:'444',chatLog:{chatId:'555',logId:'51'}}),[]);
});
test('send request idempotency survives retries and does not resend an unknown operation',()=>{
  const child=worker(),reader=createReadOnlyReader({messaging:true,spawn:()=>child});reader.connect(cred);ready(child);
  const id='12345678-1234-4123-8123-123456789abc';assert.equal(reader.sendText(room,'합성',id),true);
  assert.equal(reader.sendText(room,'합성',id),true);assert.equal(reader.sendText(room,'다른 내용',id),false);
  assert.equal(child.sent.filter(value=>value.type==='reader-action').length,1);
  reader.disconnect();assert.equal(reader.messages(room).outbox[0].phase,'unknown');
  assert.equal(reader.sendText(room,'합성',id),true);assert.equal(child.sent.filter(value=>value.type==='reader-action').length,1);reader.close();
});
test('manager keeps local titles and unread state across transport reconnect but clears on account close',()=>{
  const one=worker(),two=worker();let n=0;
  const reader=createReadOnlyReader({spawn:()=>n++===0?one:two});reader.connect(cred);ready(one);
  reader.rename(room,'로컬 이름');one.emit('message',{type:'reader-messages',source:'push',key:room,arrivals:[incoming(1)],messages:[{key:msg(1),text:'합성'}]});
  assert.equal(reader.rooms().rooms[0].unreadLocalCount,1);reader.disconnect();reader.connect(cred);ready(two);
  assert.equal(one.sent[0].sessionSalt,two.sent[0].sessionSalt);assert.equal(reader.rooms().rooms[0].title,'로컬 이름');
  assert.equal(reader.rooms().rooms[0].unreadLocalCount,1);assert.equal(reader.rooms().rooms[0].unreadCoverage,'partial');reader.close();assert.equal(reader.rooms().rooms.length,0);
});
function sdkFixture(){
  const calls=[];let reject=false,timeout=false;
  const carriage=Object.assign(new EventEmitter(),{stopPing(){},disconnect(){},async request(method,body){calls.push({method,body});if(timeout && method==='WRITE')throw new Error('private payload must not be exposed');return {status:0,body:reject?{status:-203}:method==='WRITE'?{logId:'20',sendAt:1800000000}:{c:'9007199254740993',m:[{userId:'999'},{userId:'111'}],a:['111'],w:['0']}};},async loginList(){return {status:0,body:source};}});
  const client=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['ticket.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'carriage.kakao.com',port:443};}});
  carriage.connect=async()=>{};
  return {calls,carriage,deny:()=>{reject=true;},timeout:()=>{timeout=true;},sdk:{messaging:true,booking:client,ticket:client,carriage:()=>carriage,toLong:value=>value,resolve:async h=>h,every:()=>0}};
}
test('new-room pushes are buffered through one CHATINFO and published after room admission',async()=>{
  const f=sdkFixture(),events=[],original=f.carriage.request;let release,started;
  const waiting=new Promise(resolve=>{started=resolve;});
  f.carriage.request=async(method,body,...args)=>{
    if(method==='CHATINFO'){f.calls.push({method,body});started();await new Promise(resolve=>{release=resolve;});return {status:0,body:{chatInfo:{chatId:'222',type:'DirectChat',lastLogId:'52',displayMembers:[{nickName:'합성 상대'}]}}};}
    return original(method,body,...args);
  };
  const session=createReaderSession(cred,f.sdk,e=>events.push(e));
  try{
    await session.start();
    const push=n=>f.carriage.emit('push',{method:'MSG',status:0,body:{chatId:'222',chatLog:{logId:String(n),msg:'합성 '+n,authorId:'111',sendAt:1800000000}}});
    push(50);await waiting;push(51);push(52);release();
    const end=Date.now()+3000;while(events.filter(e=>e.type==='reader-messages' && e.source==='push').length<3){if(Date.now()>end)throw new Error('discovery not completed');await new Promise(r=>setTimeout(r,10));}
    assert.equal(f.calls.filter(c=>c.method==='CHATINFO').length,1);assert.deepEqual(f.calls.find(c=>c.method==='CHATINFO').body,{chatId:'222'});
    const admitted=events.findIndex(e=>e.type==='reader-rooms' && e.rooms.some(r=>r.title==='합성 상대'));
    assert.ok(admitted>=0);assert.ok(events.findIndex(e=>e.type==='reader-messages' && e.source==='push')>admitted);
    assert.deepEqual(events.filter(e=>e.type==='reader-messages' && e.source==='push').at(-1).messages.map(m=>m.text),['합성 50','합성 51','합성 52']);
  }finally{release?.();session.close();}
});
test('discovery ignores foreign CHATINFO and blocks a server denial without retry',async()=>{
  for(const deny of [false,true]){
    const f=sdkFixture(),events=[];
    f.carriage.request=async(method,body)=>{f.calls.push({method,body});return {status:deny?-203:0,body:deny?{status:-203}:{chatInfo:{chatId:'333',type:'DirectChat'}}};};
    const session=createReaderSession(cred,f.sdk,e=>events.push(e));
    try{
      await session.start();f.carriage.emit('push',{method:'SYNCJOIN',status:0,body:{c:'222',chatLog:{logId:'50',msg:'합성'}}});
      await new Promise(r=>setTimeout(r,200));
      assert.equal(events.some(e=>e.type==='reader-rooms' && e.rooms.length>2),false);
      assert.equal(f.calls.filter(c=>c.method==='CHATINFO').length,1);
      assert.equal(events.some(e=>e.type==='reader-failed' && e.stage==='discovery'),deny);
    }finally{session.close();}
  }
});
test('session sends scoped WRITE, merges ACK, then uses actual log ID for NOTIREAD',async()=>{
  const f=sdkFixture(),events=[],session=createReaderSession(cred,f.sdk,e=>events.push(e));
  try{await session.start();const key=events[0].rooms[0].key;assert.equal(await session.action(key,1,'send',{text:'합성'}),true);
    const write=f.calls.find(c=>c.method==='WRITE');assert.equal(write.body.chatId,'9007199254740993');assert.equal(write.body.msg,'합성');assert.equal(write.body.noSeen,true);
    const message=events.find(e=>e.source==='sent').messages[0];assert.equal(await session.action(key,2,'read',{message:message.key}),true);
    assert.deepEqual(f.calls.find(c=>c.method==='NOTIREAD').body,{chatId:'9007199254740993',watermark:'20'});
    assert.equal(await session.action(key,3,'read',{message:msg(100)}),false);
  }finally{session.close();}
});
test('WRITE timeout is unknown with no retry and rejection remains failed',async()=>{
  for(const mode of ['timeout','deny']){const f=sdkFixture(),events=[],session=createReaderSession(cred,f.sdk,e=>events.push(e));
    try{await session.start();f[mode]();await session.action(events[0].rooms[0].key,1,'send',{text:'합성'});
      assert.equal(events.find(e=>e.type==='reader-action').phase,mode==='timeout'?'unknown':'failed');assert.equal(f.calls.filter(c=>c.method==='WRITE').length,1);
      assert.equal(await session.action(events[0].rooms[0].key,2,'send',{text:'합성'}),false);
    }finally{session.close();}}
});
test('bounded read probe compares CHATINFO before and after NOTIREAD without another room-entry command',async()=>{
  const f=sdkFixture(),events=[],observed=[];let snapshots=0;
  const original=f.carriage.request;
  f.carriage.request=async(method,body)=>{
    if(method==='CHATINFO'){f.calls.push({method,body});return {status:0,body:{chatInfo:{chatId:'9007199254740993',lastSeenLogId:snapshots++?'20':'0'}}};}
    return original(method,body);
  };
  f.sdk.readProbe=true;f.sdk.observeRead=details=>observed.push(details);
  const session=createReaderSession(cred,f.sdk,e=>events.push(e));
  try{
    await session.start();const key=events[0].rooms[0].key;
    f.carriage.emit('push',{method:'MSG',status:0,body:{chatId:'9007199254740993',chatLog:{logId:'20',authorId:'111',msg:'Synthetic'}}});
    const message=events.find(e=>e.type==='reader-messages').messages[0];
    await session.action(key,1,'read',{message:message.key});
    assert.deepEqual(f.calls.map(row=>row.method),['CHATINFO','NOTIREAD','CHATINFO']);
    assert.deepEqual(observed,[{before:{roomMatched:true,seenAtLeastTarget:false},after:{roomMatched:true,seenAtLeastTarget:true},targetIsOwn:false,requestedIsOwn:false}]);
    await session.action(key,2,'read',{message:message.key});
    assert.equal(f.calls.filter(row=>row.method==='CHATINFO').length,2);
    assert.equal(f.calls.some(row=>row.method==='CHATONROOM' || row.method==='WRITE'),false);
  }finally{session.close();}
});
test('new HTTP actions preserve authentication, origin/CSRF and strict payload validation',async()=>{
  let sends=0,renames=0,seen=0;const app=createLocalServer({mode:'live',messaging:true,encode:()=>[[true]],transport:async op=>op==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:op==='generate'?{httpStatus:200,body:{status:0,url:'OFFLINE-NOT-FOR-LOGIN',remainingSeconds:60}}:{httpStatus:200,body:{status:0,user:{userId:'246810'},accessToken:'FAKE_PRIVATE_TOKEN'}},readerFactory:()=>({snapshot:()=>({phase:'connected',canConnect:false}),close(){},sendText(){sends++;return true;},rename(){renames++;return true;},seen(){seen++;return true;}})});
  const url=await app.listen(0);
  try{
    const root=await fetch(url),cookie=root.headers.get('set-cookie').split(';')[0];const state=await(await fetch(url+'/api/status',{headers:{cookie}})).json();
    const post=(path,body,origin=url)=>fetch(url+path,{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-csrf-token':state.csrf},body:JSON.stringify(body)});
    const body={room,text:'합성',clientId:'12345678-1234-4123-8123-123456789abc'};
    assert.equal((await post('/api/reader/send',body)).status,409);await app.lab.start();for(let i=0;i<300 && !app.lab.snapshot().credentialInMemory;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal((await post('/api/reader/send',body,'https://other.invalid')).status,403);assert.equal(sends,0);
    assert.equal((await post('/api/reader/send',{...body,extra:1})).status,400);assert.equal((await post('/api/reader/send',{...body,text:'😀'.repeat(4001)})).status,400);
    assert.equal((await post('/api/reader/send',body)).status,202);assert.equal(sends,1);
    assert.equal((await post('/api/preferences/room',{room,title:'별칭'})).status,202);assert.equal(renames,1);
    assert.equal((await post('/api/reader/seen',{room,token:'a'.repeat(48),notify:true})).status,202);assert.equal(seen,1);
    assert.equal((await post('/api/reader/seen',{room,token:'a'.repeat(48),notify:1})).status,400);
  }finally{app.lab.cancel();app.server.close();app.server.closeAllConnections();}
});
