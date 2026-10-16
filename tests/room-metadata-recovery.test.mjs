// Synthetic injected clients only. No account SDK, socket or official app.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createReaderStore} from '../experiments/local-web/reader-data.mjs';
import {createReaderSession} from '../experiments/local-web/reader-session.mjs';
import {createReadOnlyReader} from '../experiments/local-web/reader-manager.mjs';

const credential={userId:'999',accessToken:'SYNTHETIC_ONLY',deviceUUID:'SYNTHETIC_DEVICE'};
const salt=Buffer.alloc(32,7),tick=()=>new Promise(resolve=>setImmediate(resolve));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve;return {promise:new Promise(done=>{resolve=done;}),resolve:value=>resolve(value)};};
async function until(check){const deadline=Date.now()+3500;while(!check()){if(Date.now()>deadline)throw new Error('synthetic metadata deadline');await delay(5);}}
const row=(c='123',extra={})=>({c,t:'MultiChat',a:2,ll:'3',lastLog:{logId:'3',authorId:'999',msg:'synthetic seed',type:1,sendAt:1800000000},...extra});
function storeFixture(extra={}){const store=createReaderStore({chatDatas:[row('9007199254740993',extra)]},'999',salt);return {store,key:store.rooms()[0].key};}
function sessionFixture(rows=[row()],reply=(_method,body)=>({status:0,method:'CHATINFO',body:{chatInfo:{c:String(body.chatId),title:'recovered synthetic'}}})){
  const calls=[],events=[];
  const carriage=Object.assign(new EventEmitter(),{async connect(){},disconnect(){},stopPing(){},async loginList(){return {status:0,body:{chatDatas:rows}};},request(method,body,timeout){calls.push({method,body,timeout});return reply(method,body,timeout);}});
  const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};}});
  const sdk={messaging:true,booking:bootstrap,ticket:bootstrap,carriage:()=>carriage,toLong:String,resolve:async host=>host,every:()=>0,sessionSalt:salt};
  return {session:createReaderSession(credential,sdk,event=>events.push(event)),carriage,calls,events,sdk};
}

for(const [label,info,expected] of [
  ['direct',{title:'direct',meta:'personal',chatMetas:[{type:3,content:'type3'}],displayMembers:[{userId:'111',nickName:'peer'}]},'direct'],
  ['personal meta',{title:' ',meta:'{"title":"personal"}',chatMetas:[{type:3,content:'type3'}]},'personal'],
  ['TITLE type 3',{meta:'{broken',chatMetas:[{type:2,content:'wrong type'},{type:3,content:'{"name":"type3"}'}]},'type3'],
  ['display member fallback',{displayMembers:[{userId:'999',nickName:'self'},{userId:'111',nickName:'peer'},{userId:'111',nickName:'peer'}]},'peer'],
  ['literal numeric meta',{meta:'123'},'123'],
])test('known unnamed room title uses '+label+' priority',()=>{
  const {store,key}=storeFixture();assert.deepEqual(store.unnamedRooms(),[key]);
  assert.equal(store.recoverTitle(key,{chatInfo:{c:'9007199254740993',...info}}),true);
  assert.equal(store.rooms()[0].title,expected);assert.deepEqual(store.unnamedRooms(),[]);
  assert.equal(store.recoverTitle(key,{chatInfo:{c:'9007199254740993',title:'replacement'}}),false,'known title stays authoritative');
});

test('room ID absence, alias disagreement, unsafe numeric IDs, left rooms and malformed metadata never recover',()=>{
  for(const chatInfo of [null,[],{title:'bad'},{c:'9007199254740992',title:'bad'},{c:'9007199254740993',chatId:'9007199254740994',title:'bad'},{c:9007199254740993,title:'bad'},{c:'9007199254740993',left:true,title:'bad'},{c:'9007199254740993',left:'false',title:'bad'},{c:'9007199254740993',meta:'{broken'},{c:'9007199254740993',chatMetas:[{type:2,content:'bad'}]}, {c:'9007199254740993',meta:['bad']}]){
    const {store,key}=storeFixture(),before=store.rooms();assert.equal(store.recoverTitle(key,{chatInfo}),false);assert.deepEqual(store.rooms(),before);
  }
  const {store,key}=storeFixture();assert.equal(store.recoverTitle(key,{chatInfo:{c:9007199254740993n,chatId:'9007199254740993',title:'valid exact bigint'}}),true);
});

test('title-only recovery preserves keys, history, receipt membership, expected count, kind and send gate',()=>{
  const {store,key}=storeFixture();
  store.history(key,{chatLogs:[{chatId:'9007199254740993',logId:'3',authorId:'999',msg:'synthetic seed'}]});
  assert.equal(store.receiptSnapshot(key,{c:'9007199254740993',mi:['999','111'],a:['111'],w:['0']}),true);
  const before={room:store.rooms()[0],page:store.current(key),stats:store.stats(),cache:store.cacheEpoch(key),version:store.receiptVersion(key),end:store.historyEnd(key)};
  assert.equal(store.recoverTitle(key,{chatInfo:{c:'9007199254740993',t:'MemoChat',a:900,ll:'9999',title:'only display',displayMembers:[{userId:'222',nickName:'not membership'}],mi:['222'],w:['9999'],lastLog:{logId:'9999',msg:'must not seed'}}}),true);
  const after=store.rooms()[0];assert.deepEqual({...after,title:before.room.title,titleKnown:before.room.titleKnown},before.room);
  assert.deepEqual(store.current(key),before.page);assert.deepEqual(store.stats(),before.stats);assert.equal(store.cacheEpoch(key),before.cache);assert.equal(store.receiptVersion(key),before.version);assert.equal(store.historyEnd(key),before.end);
  assert.equal(store.receiptSnapshot(key,{c:'9007199254740993',mi:['999','111','222'],a:['111','222'],w:['0','0']}),false,'title response did not change expected count');
  const unknown=storeFixture({t:'OM'});assert.equal(unknown.store.canSend(unknown.key),false);unknown.store.recoverTitle(unknown.key,{chatInfo:{c:'9007199254740993',t:'DirectChat',title:'open title'}});assert.equal(unknown.store.canSend(unknown.key),false);
});

test('unnamed selection excludes MemoChat/known titles and bounds newest candidates to eight',()=>{
  const rows=Array.from({length:12},(_,i)=>row(String(i+1),{updatedAt:1800000000+i,lastLog:null,ll:null}));
  rows.push(row('100',{t:'MemoChat'}),row('101',{title:'already known'}));
  const store=createReaderStore({chatDatas:rows},'999',salt),selected=store.unnamedRooms(500);
  assert.deepEqual(selected.map(key=>store.serverRoomId(key)),['12','11','10','9','8','7','6','5']);assert.deepEqual(store.unnamedRooms(0),[]);
});

test('known unnamed CHATINFO is asynchronous, serial, capped at eight and once per connection',async()=>{
  const held=deferred();let active=0,maximum=0;
  const f=sessionFixture(Array.from({length:12},(_,i)=>row(String(i+1))),async(method,body)=>{active++;maximum=Math.max(maximum,active);if(f.calls.length===1)await held.promise;active--;return {status:0,body:{chatInfo:{c:body.chatId,title:'recovered '+body.chatId}}};});
  try{
    assert.equal((await f.session.start()).ok,true);assert.equal(f.calls.length,0);assert.equal(f.events[0].source,'loginlist');
    await until(()=>f.calls.length===1);await delay(150);assert.equal(f.calls.length,1);held.resolve();await until(()=>f.calls.length===8);await delay(160);
    assert.equal(f.calls.length,8);assert.equal(maximum,1);assert.ok(f.calls.every(call=>call.method==='CHATINFO' && call.timeout===3000));
    f.carriage.emit('push',{method:'MSG',status:0,body:{chatId:'1',chatLog:{logId:'4',authorId:'111',msg:'synthetic'}}});await delay(150);assert.equal(f.calls.length,8);assert.equal(f.events.some(event=>event.type==='reader-failed'),false);
  }finally{held.resolve();f.session.close();}
});

test('optional sync throw, rejection, denial and wrong method continue the queue without failing transport',async()=>{
  const f=sessionFixture(Array.from({length:5},(_,i)=>row(String(i+1))),(method,body)=>{
    if(f.calls.length===1)throw new Error('synthetic synchronous decode');
    if(f.calls.length===2)return Promise.reject(new Error('synthetic rejection'));
    if(f.calls.length===3)return {status:-1,body:{chatInfo:{c:body.chatId,title:'denied'}}};
    if(f.calls.length===4)return {status:0,method:'WRITE',body:{chatInfo:{c:body.chatId,title:'wrong method'}}};
    return {status:0,body:{chatInfo:{c:body.chatId,title:'last succeeds'}}};
  });
  try{await f.session.start();await until(()=>f.calls.length===5);await tick();assert.equal(f.events.some(event=>event.type==='reader-failed'),false);assert.equal(f.events.at(-1).rooms.filter(room=>room.titleKnown).length,1);}
  finally{f.session.close();}
});

for(const stop of ['close','disconnected'])test('late optional title response is ignored after '+stop,async()=>{
  const held=deferred(),f=sessionFixture([row(),row('456')],()=>held.promise);
  try{await f.session.start();await until(()=>f.calls.length===1);if(stop==='close')f.session.close();else f.carriage.emit('disconnected');const count=f.events.length;held.resolve({status:0,body:{chatInfo:{c:'123',title:'late'}}});await delay(150);assert.equal(f.events.length,count);assert.equal(f.calls.length,1);assert.equal(f.events.filter(event=>event.type==='reader-failed').length,stop==='close'?0:1);}
  finally{held.resolve({});f.session.close();}
});

test('history and new-room discovery run before queued optional name work',async()=>{
  const held=deferred(),f=sessionFixture([row(),row('456')],(method,body)=>{
    if(method==='SYNCMSG')return held.promise;
    return {status:0,body:{chatInfo:{c:body.chatId,t:'DirectChat',title:'synthetic '+body.chatId,ll:'3'}}};
  });
  try{
    await f.session.start();const key=f.events[0].rooms[0].key,pending=f.session.history(key,1);await until(()=>f.calls.length===1);await delay(150);assert.equal(f.calls[0].method,'SYNCMSG');assert.equal(f.calls.length,1);
    f.carriage.emit('push',{method:'MSG',status:0,body:{chatId:'789',chatLog:{logId:'3',authorId:'111',msg:'new synthetic'}}});
    held.resolve({status:0,body:{isOK:true,chatLogs:[]}});await pending;await until(()=>f.calls.length===2);assert.deepEqual(f.calls[1],{method:'CHATINFO',body:{chatId:'789'},timeout:5000});
    await until(()=>f.calls.length===4);assert.equal(f.events.some(event=>event.type==='reader-failed'),false);
  }finally{held.resolve({status:0,body:{isOK:true,chatLogs:[]}});f.session.close();}
});

test('manager local alias remains authoritative after an optional recovered title publication',()=>{
  let child;const reader=createReadOnlyReader({spawn:()=>child=Object.assign(new EventEmitter(),{send(_value,callback){callback?.();},kill(){return true;}})});
  try{
    assert.equal(reader.connect(credential),true);child.emit('message',{type:'reader-ready'});
    const key='r_'+'a'.repeat(24),room={key,title:'이름 없는 대화방 1',titleKnown:false,kind:'DirectChat',canSend:true};
    child.emit('message',{type:'reader-rooms',source:'loginlist',rooms:[room]});assert.equal(reader.rename(key,'my local alias'),true);
    child.emit('message',{type:'reader-rooms',source:'push',rooms:[{...room,title:'recovered server title',titleKnown:true}]});
    assert.equal(reader.rooms().rooms[0].title,'my local alias');assert.equal(reader.rooms().rooms[0].baseTitle,'recovered server title');assert.equal(reader.rooms().rooms.length,1);
  }finally{reader.close();}
});
