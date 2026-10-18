// Synthetic contracts only: in-memory SDK transports, no accounts/network/device actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createReaderStore} from '../experiments/local-web/reader-data.mjs';
import {createRoomState} from '../experiments/local-web/reader-room-state.mjs';
import {createReadOnlyReader} from '../experiments/local-web/reader-manager.mjs';
import {createReaderSession} from '../experiments/local-web/reader-session.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,ms=1200){const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw new Error('synthetic fixture condition deadline');await sleep(10);}}
const credential={userId:'999',deviceUUID:'SYNTHETIC',accessToken:'SYNTHETIC_NO_ACCOUNT'};
const key='r_'+'a'.repeat(24),second='r_'+'b'.repeat(24),message=n=>'m_'+String(n).padStart(24,'0');
const arrival=n=>({key:message(n),incoming:true,afterBaseline:true,userMessage:true});
function room(extra={}){return {c:'123',t:'DirectChat',title:'Synthetic',ll:'100',...extra};}
for(const [name,fields,count,coverage] of [
 ['compact n',{n:3},3,'observed'],['expanded count',{newMessageCount:3},3,'observed'],['same aliases',{n:3,newMessageCount:3},3,'observed'],
 ['absent count',{},0,'observed'],['zero',{n:0},0,'observed'],['upper count bound',{n:20000},20000,'observed'],
 ['conflict',{n:3,newMessageCount:4},0,'partial'],['negative',{n:-1},0,'partial'],['fraction',{n:1.5},0,'partial'],
 ['numeric string',{n:'3'},0,'partial'],['boolean',{n:true},0,'partial'],['oversized',{n:20001},0,'partial'],
 ['unsafe integer',{n:9007199254740992},0,'partial'],['invalid flag',{n:3,invalidNewMessageCount:true},0,'partial'],
 ['nonboolean flag',{n:3,invalidNewMessageCount:0},0,'partial'],['explicit valid flag',{n:3,invalidNewMessageCount:false},3,'observed'],
])test('initial unread validation: '+name,()=>{
 const store=createReaderStore({chatDatas:[room(fields)]},'999'),row=store.rooms()[0],state=createRoomState();state.bind([row]);
 const visible=state.decorate(row);assert.equal(visible.unreadLocalCount,count);assert.equal(visible.unreadCoverage,coverage);
 assert.equal(row.initialUnreadCount,count);assert.equal(row.initialUnreadCoverage,coverage);
});
test('seed3 plus one unique incoming is4; self/old/duplicate add0; captured seen clears only its view',()=>{
 const store=createReaderStore({chatDatas:[room({n:3})]},'999'),row=store.rooms()[0],state=createRoomState();state.bind([row]);
 const push=(id,author='111')=>{for(const update of store.push({chatId:'123',chatLog:{chatId:'123',logId:String(id),authorId:author,type:1,msg:'Synthetic'}}))state.receive(update.key,update.arrivals);};
 push(101);push(101);push(102,'999');push(99);assert.equal(state.decorate(row).unreadLocalCount,4);
 const token=state.issue(row.key,message(101));push(103);assert.ok(state.seen(row.key,token));assert.equal(state.decorate(row).unreadLocalCount,1,'later incoming survives captured sequence');
 assert.ok(state.seen(row.key,state.issue(row.key,message(103))));assert.equal(state.decorate(row).unreadLocalCount,0);
 state.bind([{...row,initialUnreadCount:3}],{reconnect:true});assert.equal(state.decorate(row).unreadLocalCount,0,'reconnect never resurrects cleared snapshot');push(104);assert.equal(state.decorate(row).unreadLocalCount,1);
});
test('signed64 room/message boundaries preserve seed baseline without ID-difference inference',()=>{
 const store=createReaderStore({chatDatas:[room({c:'9223372036854775807',ll:'9223372036854775806',n:3}),room({c:'9223372036854775808',n:8})]},'999'),rows=store.rooms();assert.equal(rows.length,1);
 const state=createRoomState();state.bind(rows);const update=store.push({chatId:'9223372036854775807',chatLog:{logId:'9223372036854775807',authorId:'111',type:1,msg:'Synthetic'}})[0];state.receive(update.key,update.arrivals);assert.equal(state.decorate(rows[0]).unreadLocalCount,4);
});
test('binding a newly discovered room preserves unrelated outstanding local-seen token',()=>{
 const state=createRoomState();state.bind([{key,initialUnreadCount:3,initialUnreadCoverage:'observed'}]);const token=state.issue(key,message(1));
 state.bind([{key},{key:second,initialUnreadCount:0,initialUnreadCoverage:'observed'}]);assert.equal(state.hasToken(token),true);assert.ok(state.seen(key,token));assert.equal(state.decorate({key}).unreadLocalCount,0);
});
test('discovered snapshot count is zero and queued replay counts each incoming exactly once',()=>{
 const store=createReaderStore({chatDatas:[room({n:3})]},'999'),discovered=store.discover('456',{chatInfo:room({c:'456',n:8})}),row=store.rooms().find(r=>r.key===discovered);
 const state=createRoomState();state.bind([row]);assert.equal(row.initialUnreadCount,0);for(let n=0;n<2;n++){const update=store.push({chatId:'456',chatLog:{logId:'101',authorId:'111',type:1,msg:'Synthetic'}})[0];state.receive(update.key,update.arrivals);}assert.equal(state.decorate(row).unreadLocalCount,1);
});
const preferences={account:()=>({key:()=>Buffer.alloc(32),snapshot:()=>({notifications:false}),room:()=>null,close(){}})};
test('manager propagates initial snapshot seed and does not revive it on reconnect',()=>{
 const child=Object.assign(new EventEmitter(),{send(_v,cb){cb?.();},kill(){}}),reader=createReadOnlyReader({spawn:()=>child,preferenceStore:preferences});
 const rows=[{key,title:'Synthetic',kind:'DirectChat',initialUnreadCount:3,initialUnreadCoverage:'observed'}];
 const ready=()=>child.emit('message',{type:'reader-rooms',source:'loginlist',rooms:rows,stats:{sourceRoomCount:1}});
 try{assert.equal(reader.connect(credential),true);ready();assert.equal(reader.rooms().rooms[0].unreadLocalCount,3);
  child.emit('message',{type:'reader-messages',source:'push',key,latestVisible:true,messages:[{key:message(1),text:'Synthetic',mine:false}],arrivals:[arrival(1)]});assert.equal(reader.rooms().rooms[0].unreadLocalCount,4);
  assert.equal(reader.seen(key,reader.messages(key).seenToken,false),true);assert.equal(reader.rooms().rooms[0].unreadLocalCount,0);reader.disconnect();assert.equal(reader.connect(credential),true);ready();assert.equal(reader.rooms().rooms[0].unreadLocalCount,0);
 }finally{reader.close();}
});

function fixture({rows=[room()],reply}={}){
 let clock=0,disconnected=0;const events=[],calls=[];
 const carriage=Object.assign(new EventEmitter(),{async connect(){},disconnect(){disconnected++;},stopPing(){},async loginList(){return {status:0,body:{chatDatas:rows}};},async request(method,body,timeout,policy){calls.push({method,body,timeout,policy});const custom=await reply?.(method,body);if(custom!==undefined)return custom;
  if(method==='SYNCLINK')return {status:0,body:{ltk:0,ols:[{li:'700',ln:'Synthetic link',ac:true}]}};
  if(method==='CHATONROOM')return {status:0,body:{c:'123',li:'700',olu:{userId:'999',lmt:2,opt:0,pv:'0'},mt:0}};
  if(method==='CHATINFO')return {status:0,body:{chatInfo:room({c:String(body.chatId),title:'Discovered '+body.chatId})}};
  return {status:0,body:{}};}});
 const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};}});
 const session=createReaderSession(credential,{messaging:true,booking:bootstrap,ticket:bootstrap,carriage:()=>carriage,toLong:String,resolve:async h=>h,every:()=>0,delay:async()=>{},now:()=>clock},e=>events.push(e));
 const emit=(id,log)=>carriage.emit('push',{method:'MSG',status:0,body:{chatId:String(id),chatLog:{chatId:String(id),logId:String(log),authorId:'111',type:1,msg:'Synthetic '+log}}});
 return {session,events,calls,carriage,emit,setClock:t=>{clock=t;},disconnected:()=>disconnected,start:async()=>{assert.equal((await session.start()).ok,true);return events.find(e=>e.type==='reader-rooms'&&e.source==='loginlist').rooms[0].key;}};
}
const timeout=()=>Object.assign(new Error('Synthetic optional expiry'),{code:'READER_REQUEST_TIMEOUT'});
test('discovery timeout retains queued logs and recovers only on later push after3000ms',async()=>{
 let attempts=0;const f=fixture({reply:method=>{if(method==='CHATINFO'&&++attempts===1)throw timeout();}});
 try{await f.start();f.emit(456,101);await until(()=>attempts===1);await sleep(130);f.setClock(3000);await sleep(150);assert.equal(attempts,1,'clock/cooldown alone never retries');f.emit(456,102);await sleep(220);
  assert.equal(attempts,2,'a new push must retry the transient first lookup');const announced=f.events.findIndex(e=>e.type==='reader-rooms'&&e.rooms.some(r=>r.title==='Discovered 456'));assert.ok(announced>=0);
  const discovered=f.events[announced].rooms.find(r=>r.title==='Discovered 456').key,updates=f.events.filter(e=>e.type==='reader-messages'&&e.key===discovered);assert.ok(updates.length>0);assert.ok(f.events.indexOf(updates[0])>announced);
  assert.deepEqual(updates.at(-1).messages.map(m=>m.text).sort(),['Synthetic 101','Synthetic 102']);assert.equal(new Set(updates.at(-1).messages.map(m=>m.key)).size,2);assert.equal(f.disconnected(),0);
 }finally{f.session.close();}
});
test('discovery cooldown prevents eager retry and caps repeated timeout attempts at3',async()=>{
 const f=fixture({reply:method=>{if(method==='CHATINFO')throw timeout();}});const count=()=>f.calls.filter(c=>c.method==='CHATINFO').length;
 try{await f.start();f.emit(456,101);await sleep(150);assert.equal(count(),1);f.setClock(2999);f.emit(456,102);await sleep(150);assert.equal(count(),1);
  for(let n=1;n<=4;n++){f.setClock(n*3000);f.emit(456,102+n);await sleep(150);assert.equal(count(),Math.min(1+n,3));}assert.equal(f.events.some(e=>e.type==='reader-failed'),false);
 }finally{f.session.close();}
});
for(const [label,response] of [['explicit denial',{status:-203,body:{}}],['wrong identity',{status:0,body:{chatInfo:room({c:'789'})}}]])test('discovery '+label+' is terminal and creates no membership',async()=>{
 const f=fixture({reply:method=>method==='CHATINFO'?response:undefined});
 try{await f.start();f.emit(456,101);await sleep(150);f.setClock(9000);f.emit(456,102);await sleep(150);assert.equal(f.calls.filter(c=>c.method==='CHATINFO').length,1);assert.equal(f.events.filter(e=>e.type==='reader-rooms').at(-1).rooms.length,1);assert.equal(f.calls.some(c=>c.method==='JOINLINK'),false);assert.equal(f.disconnected(),0);}
 finally{f.session.close();}
});
test('closing during discovery blocks late room/message publication and retry',async()=>{
 let release;const wait=new Promise(r=>{release=r;});const f=fixture({reply:async method=>{if(method==='CHATINFO'){await wait;return {status:0,body:{chatInfo:room({c:'456'})}};}}});
 try{await f.start();f.emit(456,101);await until(()=>f.calls.some(c=>c.method==='CHATINFO'));f.session.close();const before=f.events.length;release();await sleep(140);f.setClock(6000);f.emit(456,102);await sleep(140);assert.equal(f.events.length,before);assert.equal(f.calls.filter(c=>c.method==='CHATINFO').length,1);}
 finally{release();f.session.close();}
});
test('open send entry timeout beforeWRITE is failed with healthy connection and zeroWRITE',async()=>{
 const f=fixture({rows:[room({t:'OM',li:'700'})],reply:method=>{if(method==='CHATONROOM')throw timeout();}});
 try{const key=await f.start();assert.equal(await f.session.action(key,1,'send',{text:'Synthetic send'}),true);const result=f.events.findLast(e=>e.type==='reader-action');assert.equal(result.phase,'failed');assert.equal(f.calls.filter(c=>c.method==='WRITE').length,0);assert.equal(f.disconnected(),0);assert.equal(f.events.some(e=>e.type==='reader-failed'),false);await sleep(120);assert.equal(f.calls.filter(c=>c.method==='CHATONROOM').length,1);}
 finally{f.session.close();}
});
test('actualWRITE timeout stays unknown and sends no automatic retry',async()=>{
 const f=fixture({rows:[room({t:'OM',li:'700'})],reply:method=>{if(method==='WRITE')throw timeout();}});
 try{const key=await f.start();await f.session.action(key,1,'send',{text:'Synthetic send'});assert.equal(f.events.findLast(e=>e.type==='reader-action').phase,'unknown');assert.equal(f.calls.filter(c=>c.method==='WRITE').length,1);await sleep(140);assert.equal(f.calls.filter(c=>c.method==='WRITE').length,1);}
 finally{f.session.close();}
});
test('foreign open context preventsWRITE and mismatchedWRITE correlation remains unknown',async()=>{
 for(const mismatch of ['room','write']){const f=fixture({rows:[room({t:'OM',li:'700'})],reply:method=>method==='CHATONROOM'&&mismatch==='room'?{status:0,body:{c:'456',li:'700',olu:{userId:'999',lmt:2,opt:0}}}:method==='WRITE'?{status:0,body:{chatId:'123',logId:'110',msgId:'WRONG'}}:undefined});
  try{const key=await f.start();await f.session.action(key,1,'send',{text:'Synthetic'});assert.equal(f.events.findLast(e=>e.type==='reader-action').phase,mismatch==='room'?'failed':'unknown');assert.equal(f.calls.filter(c=>c.method==='WRITE').length,mismatch==='room'?0:1);}
  finally{f.session.close();}
 }
});
