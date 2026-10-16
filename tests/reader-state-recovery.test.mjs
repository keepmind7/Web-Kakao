// In-memory fixtures only: no SDK socket, real account or worker process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createReaderSession } from '../experiments/local-web/reader-session.mjs';
import { createReadOnlyReader } from '../experiments/local-web/reader-manager.mjs';
import { createReaderStore } from '../experiments/local-web/reader-data.mjs';
import { createRoomState } from '../experiments/local-web/reader-room-state.mjs';

const credential={userId:'999',accessToken:'SYNTHETIC_NO_LOGIN',deviceUUID:'SYNTHETIC_DEVICE'};
const room='r_'+'a'.repeat(24),other='r_'+'b'.repeat(24),message=n=>'m_'+n.toString(16).padStart(24,'0');
const incoming=n=>({key:message(n),incoming:true,afterBaseline:true,userMessage:true});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){const deadline=Date.now()+2000;while(!check()){if(Date.now()>deadline)throw new Error('synthetic IPC timeout');await tick();}}
const deferred=()=>{let resolve;return {promise:new Promise(done=>{resolve=done;}),resolve:value=>resolve(value)};};
const rows=(count=21)=>Array.from({length:count},(_,i)=>({c:String(1000+i),t:'DirectChat',a:2,ll:'3',lastLog:{logId:'3',authorId:'999',msg:'synthetic 3',type:1}}));
function fixture(source=rows(),members=['999','111']){
  const f={calls:[],members:[...members],reply:null};
  const logs=(id,ids=[1,2,3])=>ids.map(n=>({chatId:id,logId:String(n),authorId:n===3?'999':'111',type:1,msg:'synthetic '+n}));
  f.logs=logs;
  f.carriage=Object.assign(new EventEmitter(),{async connect(){},disconnect(){},stopPing(){},
    async loginList(){return {status:0,body:{chatDatas:source}};},
    async request(method,body){
      f.calls.push({method,body});
      if(f.reply){const value=f.reply(method,body);if(value!==undefined)return value;}
      if(method==='SYNCMSG')return {status:0,body:{isOK:true,chatLogs:String(body.cur)==='0'?logs(String(body.chatId)):[]}};
      if(method==='MCHATLOGS')return {status:0,body:{chatLogs:logs(String(body.chatIds[0]))}};
      if(method==='CHATONROOM')return {status:0,body:{c:String(body.chatId),mi:[...f.members],a:f.members.filter(id=>id!=='999'),w:f.members.filter(id=>id!=='999').map(()=>'0')}};
      throw new Error('unplanned synthetic request');
    },
  });
  const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};}});
  f.sdk={messaging:true,booking:bootstrap,ticket:bootstrap,carriage:()=>f.carriage,toLong:String,resolve:async host=>host,every:()=>0};
  return f;
}
async function sessionFixture(f){const events=[],session=createReaderSession(credential,f.sdk,event=>events.push(event));assert.equal((await session.start()).ok,true);return {events,session,rooms:events[0].rooms};}
async function managerFixture(f){
  const child=Object.assign(new EventEmitter(),{session:null,
    send(value,callback){
      if(value.type==='reader-start'){this.session=createReaderSession(value.credential,{...f.sdk,sessionSalt:value.sessionSalt,settingsSecret:Buffer.from(value.settingsSecret,'hex')},event=>this.emit('message',event));void this.session.start();}
      else if(value.type==='reader-action')void this.session.action(value.key,value.requestId,value.action,value.payload);
      else if(value.type==='reader-history')void this.session.history(value.key,value.requestId);
      callback?.();
    },kill(){this.session?.close();return true;},
  });
  const reader=createReadOnlyReader({messaging:true,spawn:()=>child});assert.equal(reader.connect(credential),true);child.emit('message',{type:'reader-ready'});await until(()=>reader.snapshot().phase==='connected');
  return {reader,child,key:reader.rooms().rooms[0].key};
}

for(const contextFirst of [false,true])test('21-room LRU reload starts from zero'+(contextFirst?' even after context seeds the evicted room':''),async()=>{
  const f=fixture(),{session,events,rooms}=await sessionFixture(f);let request=0;
  try{
    await session.history(rooms[0].key,++request);assert.equal(events.at(-1).messages.length,3);
    for(const row of rooms.slice(1))await session.history(row.key,++request);
    if(contextFirst)await session.action(rooms[0].key,++request,'context');
    await session.history(rooms[0].key,++request);
    const last=events.filter(event=>event.source==='history').at(-1);
    assert.equal(last.messages.length,3);assert.equal(last.latestVisible,true);assert.equal(last.gap,false);
    assert.deepEqual(f.calls.filter(call=>call.method==='SYNCMSG' && call.body.chatId==='1000').map(call=>call.body.cur),['0','0']);
  }finally{session.close();}
});

for(const method of ['SYNCMSG','MCHATLOGS'])test('eviction while '+method+' is in flight marks a gap and restarts next history',async()=>{
  const f=fixture(),held=deferred(),begun=deferred();let hold=false;
  if(method==='MCHATLOGS')f.sdk.gapProbe=true;
  f.reply=(name,body)=>{
    if(hold && name===method){begun.resolve();return held.promise;}
    if(hold && method==='MCHATLOGS' && name==='SYNCMSG')return {status:0,body:{isOK:true,chatLogs:f.logs(String(body.chatId),[1])}};
  };
  const {session,events,rooms}=await sessionFixture(f);
  try{
    // A resumed SYNCMSG (or a first gap probe) can lose its cache while awaiting.
    if(method==='SYNCMSG')await session.history(rooms[0].key,1);hold=true;
    const pending=session.history(rooms[0].key,2);await begun.promise;
    for(const [i,row] of rooms.slice(1).entries())f.carriage.emit('push',{method:'MSG',status:0,body:{chatId:String(1001+i),chatLog:{logId:'4',authorId:'111',msg:'synthetic push'}}});
    held.resolve({status:0,body:method==='SYNCMSG'?{isOK:true,chatLogs:[]}:{chatLogs:f.logs('1000',[2,3])}});
    await pending;
    const interrupted=events.filter(event=>event.source==='history').at(-1);
    assert.equal(interrupted.latestVisible,false);assert.equal(interrupted.gap,true);assert.equal(interrupted.hasMore,true);
    hold=false;await session.history(rooms[0].key,3);
    assert.equal(f.calls.filter(call=>call.method==='SYNCMSG' && call.body.chatId==='1000').at(-1).body.cur,'0');
    assert.equal(events.filter(event=>event.source==='history').at(-1).messages.length,3);
  }finally{held.resolve({status:0,body:{chatLogs:[]}});session.close();}
});

for(const name of ['NEWMEM','LEFT'])test(name+' invalidates manager context and accepts a complete fresh membership',async()=>{
  const before=name==='NEWMEM'?['999','111']:['999','111','222'],after=name==='NEWMEM'?['999','111','222']:['999','111'];
  const f=fixture([{c:'123',t:'MultiChat',a:before.length,ll:'3',lastLog:{logId:'3',authorId:'999',msg:'synthetic'}}],before);
  const {reader,key}=await managerFixture(f);
  try{
    assert.equal(reader.openRoom(key),true);await until(()=>!reader.snapshot().operationBusy);assert.equal(reader.messages(key).messages.at(-1).unreadCount,before.length-1);
    f.members=after;f.carriage.emit('push',{method:name,status:0,body:{c:'123'}});
    assert.equal(reader.messages(key).receiptPhase,'idle');assert.equal(reader.messages(key).messages.at(-1).unreadCount,null);
    assert.equal(reader.openRoom(key),true);assert.equal(reader.openRoom(key),true);await until(()=>!reader.snapshot().operationBusy);
    assert.equal(f.calls.filter(call=>call.method==='CHATONROOM').length,2);
    assert.equal(reader.messages(key).receiptPhase,'ready');assert.equal(reader.messages(key).messages.at(-1).unreadCount,after.length-1);
  }finally{reader.close();}
});

test('membership changes during CHATONROOM cannot restore stale ready state, and next context retries once',async()=>{
  const f=fixture([{c:'123',t:'MultiChat',a:2,ll:'3',lastLog:{logId:'3',authorId:'999',msg:'synthetic'}}]),held=deferred();
  f.reply=method=>method==='CHATONROOM'?held.promise:undefined;
  const {reader,key}=await managerFixture(f);
  try{
    reader.openRoom(key);f.carriage.emit('push',{method:'NEWMEM',status:0,body:{c:'123'}});f.carriage.emit('push',{method:'LEFT',status:0,body:{c:'123'}});
    held.resolve({status:0,body:{c:'123',mi:['999','111'],a:['111'],w:['0']}});await until(()=>!reader.snapshot().operationBusy);
    assert.equal(reader.messages(key).receiptPhase,'idle');assert.equal(reader.messages(key).messages.at(-1).unreadCount,null);
    f.reply=null;reader.openRoom(key);await until(()=>!reader.snapshot().operationBusy);
    assert.equal(reader.messages(key).receiptPhase,'ready');assert.equal(f.calls.filter(call=>call.method==='CHATONROOM').length,2);
  }finally{held.resolve({status:0,body:{}});reader.close();}
});

test('initial, foreign, incomplete and superseded membership snapshots never commit expected counts',()=>{
  const store=createReaderStore({chatDatas:[{c:'123',t:'MultiChat',a:3,ll:'3'}]},'999'),key=store.rooms()[0].key;
  const snapshot={c:'123',mi:['999','111'],a:['111'],w:['0']};
  assert.equal(store.receiptSnapshot(key,snapshot),false,'initial cardinality mismatch stays rejected');
  store.invalidateReceipts({c:'123'});const version=store.receiptVersion(key);
  for(const bad of [{...snapshot,c:'456'},{...snapshot,chatId:'456'},{...snapshot,a:[],w:[]},{...snapshot,mi:['999','111','111']},{...snapshot,a:['111','111'],w:['0','0']},{...snapshot,a:['222'],w:['0']}])assert.equal(store.receiptSnapshot(key,bad,version),false);
  store.invalidateReceipts({c:'123'});assert.equal(store.receiptSnapshot(key,snapshot,version),false);
  assert.equal(store.receiptSnapshot(key,snapshot,store.receiptVersion(key)),true,'complete current version can change cardinality');
  assert.equal(store.receiptSnapshot(key,{c:'123',mi:['999','111','222'],a:['111','222'],w:['0','0']}),false,'dirty cleared: arbitrary count change rejected again');
});

test('seen tokens preserve later arrivals, reject wrong-room/reuse, and do not recount read replay',()=>{
  const state=createRoomState();state.bind([{key:room},{key:other}]);state.receive(room,[incoming(100)]);const token=state.issue(room,message(100));state.receive(room,[incoming(101)]);
  assert.equal(state.seen(other,token),null);assert.deepEqual(state.seen(room,token),{message:message(100)});assert.equal(state.decorate({key:room}).unreadLocalCount,1);assert.equal(state.seen(room,token),null);
  state.receive(room,[incoming(100),incoming(99)]);assert.equal(state.decorate({key:room}).unreadLocalCount,2,'new lower ID is counted; old replay is not');
});

test('scaled per-room unread capacity is recovered across repeated receive/seen cycles',()=>{
  const state=createRoomState({perRoomLimit:2,totalLimit:4});state.bind([{key:room}]);
  for(let batch=0;batch<8;batch++){
    state.receive(room,[incoming(100+batch*2),incoming(101+batch*2)]);assert.equal(state.decorate({key:room}).unreadLocalCount,2);
    assert.ok(state.seen(room,state.issue(room,message(101+batch*2))));assert.equal(state.decorate({key:room}).unreadLocalCount,0);
  }
  state.receive(room,[incoming(100)]);assert.equal(state.decorate({key:room}).unreadLocalCount,0);assert.equal(state.decorate({key:room}).unreadCoverage,'partial','Bloom-only replay is conservatively marked partial');
  state.receive(room,[incoming(1)]);assert.equal(state.decorate({key:room}).unreadLocalCount,1);
});

test('production default recovers count and notification after exactly 2000 arrivals are read',()=>{
  const state=createRoomState();state.bind([{key:room}]);state.notifications(true);
  for(let offset=0;offset<2000;offset+=200)state.receive(room,Array.from({length:200},(_,i)=>incoming(offset+i+1)));
  assert.equal(state.decorate({key:room}).unreadLocalCount,2000);assert.equal(state.claim().length,1);
  assert.ok(state.seen(room,state.issue(room,message(2000))));assert.equal(state.decorate({key:room}).unreadLocalCount,0);
  state.receive(room,[incoming(2001)]);assert.equal(state.decorate({key:room}).unreadLocalCount,1);assert.equal(state.claim().length,1);
  state.receive(room,[incoming(2001)]);assert.equal(state.decorate({key:room}).unreadLocalCount,1);assert.deepEqual(state.claim(),[]);
});

test('global unread capacity recovers across rooms and does not resurrect overflowed/replayed arrivals',()=>{
  const state=createRoomState({perRoomLimit:2,totalLimit:2});state.bind([{key:room},{key:other}]);state.receive(room,[incoming(1),incoming(2)]);state.receive(other,[incoming(3)]);
  assert.equal(state.decorate({key:other}).unreadLocalCount,0);assert.equal(state.decorate({key:other}).unreadCoverage,'partial');
  state.seen(room,state.issue(room,message(2)));state.receive(other,[incoming(3),incoming(4)]);assert.equal(state.decorate({key:other}).unreadLocalCount,1);
  state.receive(room,[incoming(1),incoming(5)]);assert.equal(state.decorate({key:room}).unreadLocalCount,1);
});

test('own, baseline and control arrivals consume no unread quota and notifications resume after seen',()=>{
  const state=createRoomState({perRoomLimit:2,totalLimit:2});state.bind([{key:room}]);state.notifications(true);
  for(let i=0;i<100;i++)state.receive(room,[{...incoming(1000+i*3),incoming:false},{...incoming(1001+i*3),afterBaseline:false},{...incoming(1002+i*3),userMessage:false}]);
  assert.equal(state.decorate({key:room}).unreadLocalCount,0);assert.deepEqual(state.claim(),[]);
  state.receive(room,[incoming(1),incoming(2)]);assert.equal(state.decorate({key:room}).unreadLocalCount,2);assert.equal(state.claim().length,1);
  state.seen(room,state.issue(room,message(2)));state.receive(room,[incoming(3)]);assert.equal(state.claim().length,1);
});

test('Bloom-only positives and saturation are partial, do not invent exact counts, and reset only at account clear',()=>{
  const state=createRoomState({perRoomLimit:2,totalLimit:2,bloomBytes:1});state.bind([{key:room},{key:other}]);let suppressed=false;
  for(let i=1;i<=64;i++){
    state.receive(room,[incoming(i)]);const count=state.decorate({key:room}).unreadLocalCount;
    if(count===0){suppressed=true;assert.equal(state.decorate({key:room}).unreadCoverage,'partial');}
    else state.seen(room,state.issue(room,message(i)));
  }
  assert.equal(suppressed,true);assert.equal(state.decorate({key:other}).unreadCoverage,'partial','filter occupancy affects the account globally');
  state.receive(room,[incoming(1)]);assert.equal(state.decorate({key:room}).unreadLocalCount,0,'normal receives do not reset the filter');
  state.clear();state.bind([{key:room}]);state.receive(room,[incoming(1)]);assert.equal(state.decorate({key:room}).unreadLocalCount,1);
});

test('token and notification queues stay bounded while an older token cannot erase a later event',()=>{
  const state=createRoomState();const rooms=Array.from({length:8},(_,i)=>({key:'r_'+i.toString(16).padStart(24,'0')}));state.bind(rooms);state.notifications(true);
  for(const row of rooms)state.receive(row.key,[incoming(1)]);
  assert.equal(state.claim().length,5);assert.equal(state.claim().length,3);assert.deepEqual(state.claim(),[]);
  const first=state.issue(rooms[0].key,message(1));for(let i=0;i<200;i++)state.issue(rooms[0].key,message(1));assert.equal(state.hasToken(first),false);
  const older=state.issue(rooms[0].key,message(1));state.receive(rooms[0].key,[incoming(2)]);state.seen(rooms[0].key,state.issue(rooms[0].key,message(2)));state.receive(rooms[0].key,[incoming(3)]);state.seen(rooms[0].key,older);assert.equal(state.decorate(rooms[0]).unreadLocalCount,1);
});
