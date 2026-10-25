// Account-free injected metadata contracts. No actual SDK socket, disk profile or account.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createReaderStore} from '../experiments/local-web/reader-data.mjs';
import {createReaderSession} from '../experiments/local-web/reader-session.mjs';

const own='999',roomId='9007199254740993',linkId='700',salt=Buffer.alloc(32,9);
const credential={userId:own,deviceUUID:'SYNTHETIC_DEVICE',accessToken:'SYNTHETIC_NO_ACCOUNT'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const defer=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve};};
const roster=Array.from({length:1500},(_,n)=>String(10000+n));
const row=(c=roomId,extra={})=>({c,t:'OM',li:linkId,title:'Synthetic open room',ll:'100',a:1501,lastLog:{logId:'100',authorId:own,type:1,msg:'Synthetic seed'},...extra});
const log=(author='11499',id='101',extra={})=>({chatId:roomId,logId:id,authorId:author,type:1,msg:'Synthetic text',...extra});
const members=(ids,extra={})=>({chatId:roomId,members:ids.map(userId=>({userId,nickName:'Synthetic '+userId})),...extra});
function storeFixture(extra={}){const store=createReaderStore({chatDatas:[row(roomId,extra)]},own,salt),key=store.rooms()[0].key;return {store,key};}
function verified(store,key,entry={}){store.syncLinks({ltk:0,ols:[{li:linkId,ac:true}]},store.linkSyncSnapshot());assert.equal(store.entrySnapshot(key,{c:roomId,li:linkId,mi:roster,olu:{userId:own,lmt:2,opt:0},mt:0,...entry},store.receiptVersion(key)),true);}
const sender=(store,key,id)=>store.current(key).messages.find(m=>store.logForMessage(key,m.key)===String(id))?.sender;
const stable=({store,key})=>({rooms:store.rooms(),end:store.historyEnd(key),cache:store.cacheEpoch(key),version:store.receiptVersion(key),stats:store.stats(),unread:store.current(key).messages.map(m=>m.unreadCount)});

test('1500-member room looks up visible author beyond first500 before roster fallbacks',()=>{
 const f=storeFixture();verified(f.store,f.key);f.store.history(f.key,{chatLogs:[log()]});
 const ids=f.store.unnamedMembers(f.key);assert.equal(ids[0],'11499');assert.ok(ids.length<=500);assert.equal(new Set(ids).size,ids.length);
});
test('visible-only candidates exclude roster, own, unsafe IDs, duplicates and inline names',()=>{
 const f=storeFixture();verified(f.store,f.key);f.store.history(f.key,{chatLogs:[log(),log('11499','102'),log(own,'103'),log('11498','104',{senderName:'Inline authoritative'}),log(9007199254740992,'105')]});
 assert.deepEqual(f.store.unnamedMembers(f.key,{visibleOnly:true}),['11499']);
});
test('full500 name cache accepts a new MSG nickname while protecting current authors',()=>{
 const ids=Array.from({length:500},(_,n)=>String(n+1)),f=storeFixture({i:ids,k:ids.map(id=>'Cached '+id)});verified(f.store,f.key);
 f.store.history(f.key,{chatLogs:[log('1','100'),log('2','101')]});
 f.store.push({chatId:roomId,authorNickname:'New visible name',chatLog:log('600','102')});
 assert.equal(sender(f.store,f.key,'102'),'New visible name');assert.equal(sender(f.store,f.key,'100'),'Cached 1');assert.equal(sender(f.store,f.key,'101'),'Cached 2');
 f.store.history(f.key,{chatLogs:[log('3','103')]});assert.match(sender(f.store,f.key,'103'),/^참여자 /,'oldest unprotected name is evicted rather than growing the cache');
});
test('accepted learns refresh LRU and fifty cached authors survive new names',()=>{
 const ids=Array.from({length:500},(_,n)=>String(n+1)),f=storeFixture({i:ids,k:ids.map(id=>'Cached '+id)});verified(f.store,f.key);
 f.store.history(f.key,{chatLogs:Array.from({length:49},(_,n)=>log(String(n+1),String(100+n)))});
 f.store.push({chatId:roomId,authorNickname:'Refreshed 50',chatLog:log('50','149')});
 f.store.push({chatId:roomId,authorNickname:'New 600',chatLog:log('600','150')});
 f.store.history(f.key,{chatLogs:[log('50','151'),log('51','152')]});assert.equal(sender(f.store,f.key,'151'),'Refreshed 50');assert.match(sender(f.store,f.key,'152'),/^참여자 /);
});
test('a later MSG name wins over an older delayed MEMBER result',()=>{
 const f=storeFixture();verified(f.store,f.key);f.store.history(f.key,{chatLogs:[log()]});
 f.store.push({chatId:roomId,authorNickname:'Newer visible name',chatLog:log('11499','102')});
 f.store.applyMembers(f.key,members(['11499']),['11499']);
 f.store.push({chatId:roomId,chatLog:log('11499','103')});assert.equal(sender(f.store,f.key,'103'),'Newer visible name');
});
for(const [label,patch] of [
 ['conflicting body room',{roomId:'456'}],['malformed chatInfo',{chatInfo:[]}],['null chatInfo',{chatInfo:null}],
 ['conflicting nested room',{chatInfo:{c:'456'}}],['unsafe room alias',{c:9007199254740992}],
 ['conflicting body link',{li:'701'}],['conflicting nested link',{chatInfo:{linkId:'701'}}],
 ['conflicting member room',{member:{roomId:'456'}}],['conflicting member link',{member:{openLinkId:'701'}}],
 ['malformed member',{member:null}],
])test('MEMBER display metadata rejects '+label+' without changing state',()=>{
 const f=storeFixture();verified(f.store,f.key);f.store.history(f.key,{chatLogs:[log()]});const before={...stable(f),page:f.store.current(f.key)};
 const body=members(['11499']);if(Object.hasOwn(patch,'member'))body.members=[patch.member===null?null:{...body.members[0],...patch.member}];else Object.assign(body,patch);
 assert.equal(f.store.applyMembers(f.key,body,['11499']),false);assert.deepEqual({...stable(f),page:f.store.current(f.key)},before);
});
test('MEMBER accepts exact signed64 aliases without learning own or unrequested users',()=>{
 const f=storeFixture();verified(f.store,f.key);f.store.history(f.key,{chatLogs:[log(),log('11498','102'),log(own,'103')]});
 const exact={chatId:9007199254740993n,c:roomId,li:linkId,chatInfo:{chatId:roomId,openLinkId:linkId},members:[{userId:'11499',nickName:'Exact signed64',roomId:roomId,li:linkId}]};
 assert.equal(f.store.applyMembers(f.key,exact,['11499']),true);assert.equal(sender(f.store,f.key,'101'),'Exact signed64');
 f.store.applyMembers(f.key,{chatId:roomId,members:[{userId:'11498',nickName:'Unrequested'},{userId:own,nickName:'Foreign self'}]},['11499',own]);
 assert.match(sender(f.store,f.key,'102'),/^참여자 /);assert.equal(sender(f.store,f.key,'103'),'나');
});
test('names cannot alter capability, receipt version, unread, cursor or membership',()=>{
 const f=storeFixture();verified(f.store,f.key,{mi:[own,'11499'],a:['11499'],w:['0']});
 assert.equal(f.store.receiptSnapshot(f.key,{c:roomId,mi:[own,'11499'],a:['11499'],w:['0']}),true);f.store.history(f.key,{chatLogs:[log(),log(own,'102')]});const before=stable(f);
 assert.equal(f.store.applyMembers(f.key,members(['11499'],{mt:2147483647,olu:{userId:own,lmt:8},mi:['555'],w:['999']}),['11499']),true);assert.deepEqual(stable(f),before);
});

function fixture({rows=[row()],entry={},reply,clock=0}={}){
 const calls=[],events=[],held=[];let time=clock,active=0,maxActive=0,disconnected=0;
 const identityStore=createReaderStore({chatDatas:rows},own,salt),keys=new Map(identityStore.rooms().map(room=>[identityStore.serverRoomId(room.key),room.key]));identityStore.clear();
 const carriage=Object.assign(new EventEmitter(),{async connect(){},disconnect(){disconnected++;},stopPing(){},async loginList(){return {status:0,body:{chatDatas:rows}};},async request(method,body,timeout,policy){
  const call={method,body,timeout,policy,at:time};calls.push(call);if(method==='MEMBER'){active++;maxActive=Math.max(maxActive,active);}
  try{const custom=await reply?.(method,body,call);if(custom!==undefined)return custom;
   if(method==='SYNCLINK')return {status:0,body:{ltk:0,ols:[{li:linkId,ac:true}]}};
   if(method==='CHATONROOM')return {status:0,body:{c:String(body.chatId),li:linkId,olu:{userId:own,lmt:2,opt:0},mt:0,mi:['111'],...entry}};
   if(method==='MEMBER')return {status:0,body:{chatId:String(body.chatId),members:body.memberIds.map(id=>({userId:String(id),nickName:'Lookup '+id}))}};
   if(method==='SYNCMSG')return {status:0,body:{isOK:true,chatLogs:[]}};
   if(method==='CHATINFO')return {status:0,body:{chatInfo:{c:String(body.chatId),t:'MultiChat',title:'Recovered '+body.chatId,ll:'100'}}};
   if(method==='WRITE')return {status:0,body:{chatId:String(body.chatId),logId:'200',msgId:body.msgId}};
   return {status:0,body:{}};
  }finally{if(method==='MEMBER')active--;}
 }});
 const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};}});
 const session=createReaderSession(credential,{messaging:true,booking:bootstrap,ticket:bootstrap,carriage:()=>carriage,toLong:String,resolve:async h=>h,every:()=>0,delay:async()=>{},sessionSalt:salt,now:()=>time},e=>events.push(e));
 return {session,carriage,calls,events,held,setClock:n=>{time=n;},count:m=>calls.filter(c=>c.method===m).length,maxActive:()=>maxActive,disconnected:()=>disconnected,
  async start(){assert.equal((await session.start()).ok,true);return events.find(e=>e.type==='reader-rooms'&&e.source==='loginlist').rooms[0].key;},
  key:id=>keys.get(String(id)),
  push(author='11499',id='101',extra={}){carriage.emit('push',{method:'MSG',status:0,body:{chatId:roomId,...extra,chatLog:log(author,id,extra.chatLog)}});},
  current:key=>events.findLast(e=>e.type==='reader-messages'&&e.key===key)?.messages??[],
  async settle(){await sleep(160);},
  close(){for(const d of held)d.resolve({status:0,body:{chatId:roomId,members:[]}});session.close();}
 };
}
const memberCalls=f=>f.calls.filter(c=>c.method==='MEMBER');
const quiet=f=>{assert.equal(f.events.some(e=>e.type==='reader-failed'),false);for(const m of ['WRITE','NOTIREAD','SHIP','POST','JOINLINK'])assert.equal(f.count(m),0,m);assert.equal(f.disconnected(),0);};
async function enter(f){const key=await f.start();assert.equal(await f.session.action(key,1,'context'),true);await f.settle();return key;}
test('entry prioritizes visible author in1500-member room, one bounded optional request per event',async()=>{
 const f=fixture({rows:[row(roomId,{lastLog:log('11499','100')})],entry:{mi:roster}});
 try{const key=await enter(f);const calls=memberCalls(f);assert.equal(calls.length,1);assert.equal(String(calls[0].body.memberIds[0]),'11499');assert.ok(calls[0].body.memberIds.length<=100);assert.ok(calls[0].timeout>0&&calls[0].timeout<=2500);assert.equal(calls[0].policy.optional,true);assert.equal(f.current(key).find(m=>m.text==='Synthetic text')?.sender,'Lookup 11499');quiet(f);}finally{f.close();}
});
test('new push author after first lookup is named once without querying roster again',async()=>{
 const f=fixture();try{const key=await enter(f);assert.equal(f.count('MEMBER'),1);f.push();await f.settle();assert.equal(f.count('MEMBER'),2);assert.deepEqual(memberCalls(f)[1].body.memberIds,['11499']);assert.equal(f.current(key).at(-1).sender,'Lookup 11499');f.push('11499','102');await f.settle();assert.equal(f.count('MEMBER'),2);quiet(f);}finally{f.close();}
});
test('successful current history merge repairs a new cached author after entry',async()=>{
 const f=fixture({reply:method=>method==='SYNCMSG'?{status:0,body:{isOK:true,chatLogs:[log()]}}:undefined});
 try{const key=await enter(f);assert.equal(await f.session.history(key,2),true);await f.settle();assert.equal(f.count('MEMBER'),2);assert.deepEqual(memberCalls(f)[1].body.memberIds,['11499']);assert.equal(f.current(key).find(m=>m.text==='Synthetic text')?.sender,'Lookup 11499');quiet(f);}finally{f.close();}
});
test('late names preserve explicit latestVisible false after a budget-limited history page',async()=>{
 const d=defer(),f=fixture({rows:[row(roomId,{ll:'200',lastLog:log(own,'200')})],reply:method=>{
  if(method==='MEMBER')return d.promise;
  if(method==='SYNCMSG'){f.setClock(10000);return {status:0,body:{isOK:false,chatLogs:[log('111','101')]}};}
 }});f.held.push(d);
 try{const key=await enter(f);assert.equal(f.count('MEMBER'),1);assert.equal(await f.session.history(key,2),true);
  const history=f.events.findLast(e=>e.type==='reader-messages'&&e.source==='history');assert.equal(history.latestVisible,false);assert.equal(history.hasMore,true);
  d.resolve({status:0,body:{chatId:roomId,members:[{userId:'111',nickName:'Late safe name'}]}});await f.settle();
  const updated=f.events.findLast(e=>e.type==='reader-messages'&&e.key===key);assert.equal(updated.messages.find(m=>m.text==='Synthetic text'&&m.mine===false)?.sender,'Late safe name');assert.equal(updated.latestVisible,false,'name metadata cannot promote a partial history page into eligible latest visibility');quiet(f);
 }finally{f.close();}
});
test('active-name lookup never blocks explicit text send and repeated events do not duplicate it',async()=>{
 const d=defer(),f=fixture({reply:method=>method==='MEMBER'?d.promise:undefined});f.held.push(d);
 try{const key=await enter(f);f.push('111');f.push('111','102');await f.settle();assert.equal(f.count('MEMBER'),1);assert.equal(await f.session.action(key,2,'send',{text:'Synthetic explicit intent'}),true);assert.equal(f.count('WRITE'),1);assert.equal(f.count('NOTIREAD'),0);assert.equal(f.maxActive(),1);assert.equal(f.events.findLast(e=>e.type==='reader-action').phase,'accepted');}finally{f.close();}
});
for(const invalidation of ['A-B-A','member revision','link revoked','close','disconnect'])test('late MEMBER cannot update after '+invalidation,async()=>{
 const d=defer(),f=fixture({rows:[row(roomId,{lastLog:log('111','100')}),row('456',{title:'Other synthetic room'})],reply:method=>method==='MEMBER'?d.promise:undefined});f.held.push(d);
 try{const key=await enter(f);assert.equal(f.count('MEMBER'),1);
  if(invalidation==='A-B-A'){f.session.view(f.key('456'));f.session.view(key);}else if(invalidation==='member revision')f.carriage.emit('push',{method:'NEWMEM',status:0,body:{chatId:roomId,userId:'222'}});else if(invalidation==='link revoked')f.carriage.emit('push',{method:'SYNCLINKDL',status:0,body:{li:linkId}});else if(invalidation==='close')f.session.close();else f.carriage.emit('disconnected');
  const before=f.events.length;d.resolve({status:0,body:members(['111'])});await f.settle();assert.equal(f.count('MEMBER'),1);if(['close','disconnect'].includes(invalidation))assert.equal(f.events.length,before);else assert.equal(f.current(key).some(m=>m.sender==='Synthetic 111'),false);for(const m of ['WRITE','NOTIREAD','JOINLINK'])assert.equal(f.count(m),0);
 }finally{f.close();}
});
test('global name in-flight bound follows latest selected room without applying old A response',async()=>{
 const d=defer(),f=fixture({rows:[row(roomId,{lastLog:log('111','100')}),row('456',{title:'Other synthetic room'})],reply:(method,body)=>method==='MEMBER'&&String(body.chatId)===roomId?d.promise:undefined});f.held.push(d);
 try{const key=await enter(f),other=f.key('456');f.session.view(other);await f.session.action(other,2,'context');await f.settle();assert.equal(f.maxActive(),1);assert.equal(f.count('MEMBER'),1);d.resolve({status:0,body:members(['111'])});await f.settle();assert.equal(f.count('MEMBER'),2);assert.equal(String(memberCalls(f)[1].body.chatId),'456');assert.equal(f.current(key).some(m=>m.sender==='Synthetic 111'),false);quiet(f);}finally{f.close();}
});
for(const failure of ['missing','timeout','denied','wrong method'])test(failure+' names are negative-cached five minutes and retried only on a new event',async()=>{
 const f=fixture({rows:[row(roomId,{lastLog:log('111','100')})],reply:method=>{if(method!=='MEMBER')return;if(failure==='timeout')throw Object.assign(new Error('Synthetic expiry'),{code:'READER_REQUEST_TIMEOUT'});return {status:failure==='denied'?-203:0,method:failure==='wrong method'?'WRITE':'MEMBER',body:{chatId:roomId,members:[]}};}});
 try{await enter(f);assert.equal(f.count('MEMBER'),1);f.push('111');await f.settle();assert.equal(f.count('MEMBER'),1);f.setClock(299999);f.push('111','102');await f.settle();assert.equal(f.count('MEMBER'),1);f.setClock(300000);await f.settle();assert.equal(f.count('MEMBER'),1,'time alone never schedules');f.push('111','103');await f.settle();assert.equal(f.count('MEMBER'),2);quiet(f);}finally{f.close();}
});
test('five requests per60sec room budget is enforced and later independent event resumes',async()=>{
 const f=fixture();try{const key=await enter(f);for(let n=0;n<5;n++){f.push(String(12000+n),String(101+n));await f.settle();}assert.equal(f.count('MEMBER'),5);f.setClock(60000);await f.settle();assert.equal(f.count('MEMBER'),5);f.push('13000','110');await f.settle();assert.equal(f.count('MEMBER'),6);assert.equal(f.current(key).at(-1).sender,'Lookup 13000');quiet(f);}finally{f.close();}
});
test('inactive pushes and invalidated open permissions do not cause name queries',async()=>{
 const f=fixture({rows:[row(),row('456',{title:'Other synthetic room'})]});try{const key=await enter(f);f.session.view(f.key('456'));f.push();await f.settle();assert.equal(f.count('MEMBER'),1);f.session.view(key);f.carriage.emit('push',{method:'SYNCLINKDL',status:0,body:{li:linkId}});f.push('11498','102');await f.settle();assert.equal(f.count('MEMBER'),1);quiet(f);}finally{f.close();}
});
test('new top-level nickname wins while the original MEMBER is pending',async()=>{
 const d=defer(),f=fixture({rows:[row(roomId,{lastLog:log('111','100')})],reply:method=>method==='MEMBER'?d.promise:undefined});f.held.push(d);
 try{const key=await enter(f);f.push('111','101',{authorNickname:'New push nickname'});d.resolve({status:0,body:members(['111'])});await f.settle();assert.equal(f.current(key).at(-1).sender,'New push nickname');f.push('111','102');await f.settle();assert.equal(f.current(key).at(-1).sender,'New push nickname');quiet(f);}finally{f.close();}
});
for(const mode of ['single exact','multi log','conflicting author','missing author','conflicting room'])test('discovery replay nickname scope: '+mode,async()=>{
 const f=fixture({rows:[row('456',{t:'MultiChat',title:'Existing synthetic room'})]});
 try{await f.start();const base=log('11499');if(mode==='conflicting author')base.senderId='111';if(mode==='missing author')delete base.authorId;if(mode==='conflicting room')base.roomId='456';
  const body={chatId:roomId,authorNickname:'Discovered <b>nickname</b>',...(mode==='multi log'?{chatLogs:[base,log('111','102')]}:{chatLog:base})};f.carriage.emit('push',{method:'MSG',status:0,body});await sleep(260);
  const update=f.events.findLast(e=>e.type==='reader-messages'&&e.messages.some(m=>m.text==='Synthetic text'));assert.ok(update,'synthetic discovered replay publishes logs');
  assert.equal(update.messages.some(m=>m.sender==='Discovered <b>nickname</b>'),mode==='single exact');quiet(f);
 }finally{f.close();}
});
const titleRows=()=>Array.from({length:10},(_,n)=>row(String(n+1),{t:'MultiChat',li:undefined,title:'',lastLog:null,ll:null,updatedAt:1800000000+n}));
async function waitForTitleState(predicate,description){
 const deadline=performance.now()+5000;
 while(!predicate()){assert.ok(performance.now()<deadline,'Timed out waiting for '+description);await sleep(10);}
}
async function waitForBootstrapTitles(f){
 // Counting requests alone cannot prove the final bootstrap response was applied.
 await waitForTitleState(()=>{
  const rooms=f.events.findLast(e=>e.type==='reader-rooms')?.rooms??[];
  return ['3','4','5','6','7','8','9','10'].every(id=>rooms.some(r=>r.key===f.key(id)&&r.title==='Recovered '+id));
 },'all eight bootstrap titles to be published');
 assert.equal(f.count('CHATINFO'),8);
}
async function waitForSelectedTitle(f){
 await waitForTitleState(()=>f.calls.some(c=>c.method==='CHATINFO'&&String(c.body.chatId)==='1'),'selected room CHATINFO to become pending');
 assert.equal(f.count('CHATINFO'),9,'selected room must have a real pending attempt');
 return f.calls.find(c=>c.method==='CHATINFO'&&String(c.body.chatId)==='1');
}
test('bootstrap8 remain capped; selecting unknown ninth schedules one nonblocking3sec title attempt',async()=>{
 const d=defer(),bootstrap=defer(),f=fixture({rows:titleRows(),reply:(method,body)=>method==='CHATINFO'?(String(body.chatId)==='1'?d.promise:String(body.chatId)==='3'?bootstrap.promise:undefined):undefined});f.held.push(d,bootstrap);
 try{
  await f.start();
  await waitForTitleState(()=>f.calls.some(c=>c.method==='CHATINFO'&&String(c.body.chatId)==='3'),'eighth bootstrap request to become pending');
  assert.equal(f.count('CHATINFO'),8);
  assert.equal(f.events.some(e=>e.type==='reader-rooms'&&e.rooms.some(r=>r.key===f.key('3')&&r.title==='Recovered 3')),false,'a pending bootstrap response is not completion');
  bootstrap.resolve({status:0,body:{chatInfo:{c:'3',t:'MultiChat',title:'Recovered 3',ll:'100'}}});
  await waitForBootstrapTitles(f);
  const key=f.key('1');assert.equal(f.session.view(key),true);const call=await waitForSelectedTitle(f);
  assert.equal(call.method,'CHATINFO');assert.equal(String(call.body.chatId),'1');assert.equal(call.timeout,3000);assert.equal(call.policy.optional,true);assert.equal(f.session.view(key),true);
  assert.equal(await Promise.race([f.session.history(key,2),sleep(200).then(()=>false)]),true,'history cannot wait for optional selected title');
  d.resolve({status:0,body:{chatInfo:{c:'1',title:'Selected ninth'}}});
  await waitForTitleState(()=>f.events.findLast(e=>e.type==='reader-rooms')?.rooms.some(r=>r.key===key&&r.title==='Selected ninth'),'selected title to be published');
  assert.equal(f.count('CHATINFO'),9);assert.equal(f.events.findLast(e=>e.type==='reader-rooms').rooms.find(r=>r.key===key).title,'Selected ninth');quiet(f);
 }finally{f.close();}
});
for(const outcome of ['wrong room','wrong link','timeout','A-B-A','revision','close'])test('selected-title '+outcome+' is rejected and never retried automatically',async()=>{
 const d=defer(),f=fixture({rows:titleRows(),reply:(method,body)=>method==='CHATINFO'&&String(body.chatId)==='1'?d.promise:undefined});f.held.push(d);
 try{await f.start();await waitForBootstrapTitles(f);const key=f.key('1');f.session.view(key);await waitForSelectedTitle(f);
  if(outcome==='A-B-A'){f.session.view(f.key('2'));f.session.view(key);}if(outcome==='revision')f.carriage.emit('push',{method:'NEWMEM',status:0,body:{chatId:'1',userId:'111'}});if(outcome==='close')f.session.close();
  d.resolve(outcome==='timeout'?Promise.reject(Object.assign(new Error('Synthetic optional timeout'),{code:'READER_REQUEST_TIMEOUT'})):{status:0,body:{chatInfo:{c:outcome==='wrong room'?'2':'1',...(outcome==='wrong link'?{li:'701'}:{}),title:'Must not appear'}}});
  // Observe beyond the 100ms queue tick so a forbidden retry would be visible.
  await f.settle();assert.equal(f.events.some(e=>e.type==='reader-rooms'&&e.rooms.some(r=>r.key===key&&r.title==='Must not appear')),false);if(outcome!=='close'){f.session.view(key);await f.settle();assert.equal(f.count('CHATINFO'),9);quiet(f);}
 }finally{f.close();}
});
