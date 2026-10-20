// Diagnosis D3/D4 and delayed-history selection controls. Synthetic memory only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createReaderStore} from '../experiments/local-web/reader-data.mjs';
import {createReaderSession} from '../experiments/local-web/reader-session.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const flush=async()=>{for(let i=0;i<70;i++)await Promise.resolve();};
const attachment=JSON.stringify({url:'https://synthetic.kakaocdn.net/rich.jpg',w:20,h:10});
const rich=()=>({chatId:'123',logId:'42',authorId:'999',type:2,msg:'[사진]',sendAt:1792396800,attachment});
const sparse=()=>({chatId:'123',msgId:'345',logId:'42'});
function storeFixture(){const store=createReaderStore({chatDatas:[{c:'123',t:'DirectChat',title:'Synthetic first'},{c:'124',t:'DirectChat',title:'Synthetic second'}]},'999');return {store,key:store.rooms()[0].key,other:store.rooms()[1].key};}
for(const source of ['MSG','history'])test('D3 '+source+' then sparse own photo ACK retains verified media,time,key and ordering',()=>{
  const {store,key}=storeFixture();try{
    store.push({chatId:'123',chatLog:{...rich(),logId:'41',type:1,msg:'Synthetic before'}});
    if(source==='MSG')store.push({chatId:'123',chatLog:rich()});else store.history(key,{chatLogs:[rich()]});
    store.push({chatId:'123',chatLog:{...rich(),logId:'43',type:1,msg:'Synthetic after'}});
    const before=store.current(key).messages[1];assert.equal(before.photos.length,1);
    assert.ok(store.writeAccepted(key,sparse(),'[사진]',{type:2,attachment:JSON.stringify({path:'synthetic/upload.jpg',s:100})}));
    const after=store.current(key).messages;assert.equal(after.length,3);assert.equal(after[1].key,before.key);assert.deepEqual(after[1].photos,before.photos);assert.equal(after[1].at,before.at);assert.equal(after[1].at,1792396800000);assert.equal(after[1].mine,true);
  }finally{store.clear();}
});
test('D3 ACK then rich MSG converges to one complete photo',()=>{
  const {store,key}=storeFixture();try{store.writeAccepted(key,sparse(),'[사진]',{type:2});store.push({chatId:'123',chatLog:rich()});const rows=store.current(key).messages;assert.equal(rows.length,1);assert.equal(rows[0].photos.length,1);assert.equal(rows[0].at,1792396800000);}finally{store.clear();}
});
test('D3 sparse text ACK retains known timestamp without preserving a stale explicit text replacement',()=>{
  const {store,key}=storeFixture();try{store.push({chatId:'123',chatLog:{...rich(),type:1,msg:'Synthetic original'}});store.writeAccepted(key,sparse(),'Synthetic original');assert.equal(store.current(key).messages[0].at,1792396800000);assert.equal(store.current(key).messages[0].text,'Synthetic original');}finally{store.clear();}
});
test('D3 explicit new ACK media/time can update cached details; general MSG replacement can clear them',()=>{
  const {store,key}=storeFixture();try{store.push({chatId:'123',chatLog:rich()});store.writeAccepted(key,{chatId:'123',chatLog:{...rich(),sendAt:1792396900,attachment:JSON.stringify({url:'https://synthetic.kakaocdn.net/new.jpg'})}},'[사진]',{type:2});assert.equal(store.current(key).messages[0].photos[0].url,'https://synthetic.kakaocdn.net/new.jpg');assert.equal(store.current(key).messages[0].at,1792396900000);store.push({chatId:'123',chatLog:{logId:'42',authorId:'999',type:2,attachment:null,sendAt:null}});assert.equal(store.current(key).messages[0].photos.length,0);assert.equal(store.current(key).messages[0].at,null);}finally{store.clear();}
});
for(const conflict of ['author','type'])test('D3 sparse ACK does not inherit rich data from an incompatible cached '+conflict,()=>{
  // Existing ACK replacement is unchanged; only matching own/type data can be
  // additive. Supplied foreign ACK identity is rejected in the separate case.
  const {store,key}=storeFixture();try{store.push({chatId:'123',chatLog:{...rich(),...(conflict==='author'?{authorId:'111'}:{type:1,msg:'Synthetic text'})}});assert.ok(store.writeAccepted(key,sparse(),'[사진]',{type:2}));const row=store.current(key).messages[0];assert.equal(row.photos.length,0);assert.equal(row.at,null);assert.equal(row.mine,true);}finally{store.clear();}
});
test('D3 media preservation never crosses rooms or accepts a supplied foreign identity',()=>{
  const {store,key,other}=storeFixture();try{store.push({chatId:'123',chatLog:rich()});assert.equal(store.writeAccepted(key,{...sparse(),authorId:'111'},'[사진]',{type:2}),null);assert.equal(store.writeAccepted(key,{...sparse(),chatId:'124'},'[사진]',{type:2}),null);store.writeAccepted(other,{...sparse(),chatId:'124'},'[사진]',{type:2});assert.equal(store.current(other).messages[0].photos.length,0);assert.equal(store.current(other).messages[0].at,null);assert.equal(store.current(key).messages[0].photos.length,1);}finally{store.clear();}
});
test('D3 an untyped seed is not a verified conflicting message type and remains completable',()=>{
  const store=createReaderStore({chatDatas:[{c:'123',t:'DirectChat',ll:'42',lastChatLog:{logId:'42',authorId:'999',msg:'Synthetic seed'}}]},'999'),key=store.rooms()[0].key;try{store.recent(key);assert.ok(store.writeAccepted(key,sparse(),'[사진]',{type:2}));assert.equal(store.current(key).messages[0].mine,true);assert.equal(Object.hasOwn(store.current(key).messages[0],'verifiedType'),false);}finally{store.clear();}
});
test('D3 sparse ACK does not inherit media/time from an unverified cached author',()=>{
  const {store,key}=storeFixture();try{store.push({chatId:'123',chatLog:{...rich(),authorId:undefined}});assert.ok(store.writeAccepted(key,sparse(),'[사진]',{type:2}));assert.equal(store.current(key).messages[0].photos.length,0);assert.equal(store.current(key).messages[0].at,null);}finally{store.clear();}
});

const active=()=>({li:'700',ac:true,ln:'Synthetic dynamic link'});
function sessionFixture({kind='OM',chatInfo,metadata,chatInfoGate,linkGate,messaging=true}={}){
  const calls=[],events=[],syncGate=linkGate;
  const carriage=Object.assign(new EventEmitter(),{async connect(){},stopPing(){},disconnect(){},async loginList(){return {status:0,body:{chatDatas:[{c:'123',t:'DirectChat',title:'Synthetic first',ll:'10'},{c:'124',t:'DirectChat',title:'Synthetic second',ll:'10'}]}};},async request(method,body,timeout,policy){
    calls.push({method,body,timeout,policy});
    if(method==='CHATINFO'){if(chatInfoGate)await chatInfoGate.promise;return {status:0,body:{chatInfo:chatInfo??{c:'321',t:kind,li:'700',title:'Synthetic discovered'}}};}
    if(method==='SYNCLINK'){if(syncGate)await syncGate.promise;return metadata?.(method,body)??{status:0,body:{ltk:0,ols:[]}};}
    if(method==='INFOLINK')return metadata?.(method,body)??{status:0,body:{ols:[active()]}};
    if(method==='CHATONROOM')return {status:0,body:{c:String(body.chatId),...(String(body.chatId)==='321'?{li:'700'}:{}),olu:{userId:'999',lmt:2,opt:0,pv:'0'},mt:0,mi:['999','111'],a:['111'],w:['0']}};
    if(method==='MEMBER')return {status:0,body:{chatId:'321',members:[]}};
    if(method==='SYNCMSG')return {status:0,body:{isOK:true,chatLogs:[]}};
    if(method==='SHIP')return {status:0,body:{k:'SYNTHETIC_ROUTE',vh:'unused.invalid',p:443}};
    if(method==='WRITE')return {status:0,body:{chatId:String(body.chatId),msgId:body.msgId,chatLog:{logId:'71',chatId:String(body.chatId),authorId:'999',type:body.type,msgId:body.msgId}}};
    return {status:0,body:{}};
  }});
  const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};}});
  const media=()=>{let chatId;return Object.assign(new EventEmitter(),{async connect(){calls.push({method:'media-connect'});},async request(method,body){calls.push({method});chatId=String(body.c);return {status:0,body:{o:0}};},async writeEncrypted(){this.emit('push',{method:'COMPLETE',status:0,body:{chatId,chatLog:{logId:'70',chatId,authorId:'999',type:2}}});},disconnect(){}});};
  const session=createReaderSession({userId:'999',deviceUUID:'SYNTHETIC',accessToken:'SYNTHETIC_NO_ACCOUNT'},{messaging,photoTransport:'loco',media,resolveUpload:async()=> '192.0.2.1',booking:bootstrap,ticket:bootstrap,carriage:()=>carriage,toLong:String,resolve:async host=>host,every:()=>0,now:()=>Date.now()},event=>events.push(event));
  const f={session,carriage,calls,events,rooms:()=>events.findLast(e=>e.type==='reader-rooms')?.rooms??[],push(){carriage.emit('push',{method:'MSG',status:0,body:{chatId:'321',chatLog:{chatId:'321',logId:'55',authorId:'111',type:1,msg:'Synthetic dynamic'}}});},async start(){assert.equal((await session.start()).ok,true);},close(){session.close();syncGate?.resolve();chatInfoGate?.resolve();}};
  return f;
}
async function discover(f,t){f.push();t.mock.timers.tick(100);await flush();return f.rooms().find(r=>r.kind==='OpenMultiChat'||r.kind==='OpenDirectChat');}
for(const kind of ['OM','OD'])test('D4 dynamic '+kind+' obtains bounded link metadata but own-member entry still gates sending',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});const f=sessionFixture({kind});try{await f.start();await discover(f,t);const room=f.rooms().find(r=>r.kind==='OpenMultiChat'||r.kind==='OpenDirectChat');assert.ok(room);assert.equal(f.calls.filter(c=>c.method==='SYNCLINK').length,1);assert.equal(f.calls.filter(c=>c.method==='INFOLINK').length,1);assert.equal(room.canContext,true);assert.equal(room.canText,false);assert.equal(room.canPhoto,false);assert.equal(f.calls.some(c=>['JOINLINK','CHATONROOM','WRITE','SHIP','NOTIREAD'].includes(c.method)),false);for(const call of f.calls.filter(c=>['SYNCLINK','INFOLINK'].includes(c.method))){assert.equal(call.policy.optional,true);assert.ok(call.timeout>0&&call.timeout<=4000);}assert.equal(await f.session.action(room.key,1,'context'),true);const current=f.rooms().find(r=>r.key===room.key);assert.equal(current.canText,true);assert.equal(current.canPhoto,true);}finally{f.close();t.mock.timers.reset();}
});
for(const change of ['foreign','left','normal','unknown'])test('D4 discovery '+change+' does not gain link lookup or open permissions',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});const chatInfo={c:change==='foreign'?'999':'321',t:change==='normal'?'DirectChat':change==='unknown'?'UNKNOWN':'OM',li:'700',title:'Synthetic changed',...(change==='left'?{left:true}:{})},f=sessionFixture({chatInfo});try{await f.start();await discover(f,t);assert.equal(f.calls.some(c=>['SYNCLINK','INFOLINK','JOINLINK'].includes(c.method)),false);if(change==='foreign'||change==='left')assert.equal(f.rooms().length,2);}finally{f.close();t.mock.timers.reset();}
});
test('D4 optional metadata refusal retries only on later pushes after cooldown and stops after three attempts',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});const f=sessionFixture({metadata:()=>({status:-203,body:{status:-203}})});try{await f.start();await discover(f,t);assert.equal(f.calls.filter(c=>c.method==='SYNCLINK').length,1);for(let n=0;n<5;n++){f.push();t.mock.timers.tick(100);await flush();}assert.equal(f.calls.filter(c=>c.method==='SYNCLINK').length,1);for(let n=0;n<5;n++){t.mock.timers.tick(3100);f.push();t.mock.timers.tick(100);await flush();}assert.equal(f.calls.filter(c=>c.method==='SYNCLINK').length,3);assert.equal(f.calls.filter(c=>c.method==='INFOLINK').length,3);assert.equal(f.rooms().find(r=>r.kind==='OpenMultiChat').canContext,false);assert.equal(f.events.some(e=>e.type==='reader-failed'),false);}finally{f.close();t.mock.timers.reset();}
});
for(const invalidation of ['link-delete','member-change','different-view','close','disconnect','self-left'])test('D4 late link metadata after '+invalidation+' cannot reactivate a discovered room',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});const gate=deferred(),f=sessionFixture({linkGate:gate,metadata:method=>({status:0,body:method==='SYNCLINK'?{ltk:0,ols:[active()]}:{ols:[active()]}})});try{await f.start();const original=f.rooms()[0];f.session.view(original.key);await discover(f,t);assert.equal(f.calls.filter(c=>c.method==='SYNCLINK').length,1);if(invalidation==='link-delete')f.carriage.emit('push',{method:'SYNCLINKDL',status:0,body:{li:'700'}});if(invalidation==='member-change')f.carriage.emit('push',{method:'SYNCMEMT',status:0,body:{c:'321',li:'700'}});if(invalidation==='self-left')f.carriage.emit('push',{method:'LEFT',status:0,body:{c:'321',userId:'999'}});if(invalidation==='different-view')f.session.view(f.rooms().find(r=>r.title==='Synthetic second').key);if(invalidation==='close')f.session.close();if(invalidation==='disconnect')f.carriage.emit('disconnected');const count=f.events.length;gate.resolve();await flush();const open=f.rooms().find(r=>r.kind==='OpenMultiChat');assert.equal(open?.canContext??false,false);if(['close','disconnect'].includes(invalidation))assert.equal(f.events.length,count);assert.equal(f.calls.filter(c=>c.method==='INFOLINK').length,0);}finally{f.close();t.mock.timers.reset();}
});
test('D4 held link metadata is locally bounded without enabling or automatically entering the room',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});const gate=deferred(),f=sessionFixture({linkGate:gate});try{await f.start();await discover(f,t);assert.equal(f.calls.filter(c=>c.method==='SYNCLINK').length,1);t.mock.timers.tick(6500);await flush();assert.equal(f.rooms().find(r=>r.kind==='OpenMultiChat').canContext,false);assert.equal(f.calls.some(c=>['CHATONROOM','WRITE','JOINLINK'].includes(c.method)),false);gate.resolve();await flush();assert.equal(f.calls.filter(c=>c.method==='INFOLINK').length,0);}finally{f.close();t.mock.timers.reset();}
});
test('D4 a later eligible push can repair a transient metadata refusal once without auto entry',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});let infos=0;const f=sessionFixture({metadata:method=>method==='SYNCLINK'?{status:0,body:{ltk:0,ols:[]}}:++infos===1?{status:-203,body:{status:-203}}:{status:0,body:{ols:[active()]}}});try{await f.start();await discover(f,t);assert.equal(f.rooms().find(r=>r.kind==='OpenMultiChat').canContext,false);t.mock.timers.tick(3100);f.push();t.mock.timers.tick(100);await flush();const room=f.rooms().find(r=>r.kind==='OpenMultiChat');assert.equal(room.canContext,true);assert.equal(room.canText,false);assert.equal(infos,2);assert.equal(f.calls.some(c=>['JOINLINK','CHATONROOM','WRITE'].includes(c.method)),false);}finally{f.close();t.mock.timers.reset();}
});
test('D4 dynamic read-only discovery cannot acquire messaging link requests',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});const f=sessionFixture({messaging:false});try{await f.start();await discover(f,t);assert.equal(f.calls.some(c=>['SYNCLINK','INFOLINK','JOINLINK'].includes(c.method)),false);assert.equal(f.rooms().find(r=>r.kind==='OpenMultiChat').canContext,false);}finally{f.close();t.mock.timers.reset();}
});
test('D4 an in-flight push cannot schedule a retry before cooldown or without a later eligible push',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});const gate=deferred(),f=sessionFixture({linkGate:gate,metadata:()=>({status:-203,body:{status:-203}})});try{await f.start();await discover(f,t);assert.equal(f.calls.filter(c=>c.method==='SYNCLINK').length,1);t.mock.timers.tick(1000);f.push();await flush();gate.resolve();await flush();t.mock.timers.tick(100);await flush();assert.equal(f.calls.filter(c=>c.method==='SYNCLINK').length,1,'in-flight messages do not authorize an immediate retry');t.mock.timers.tick(3100);await flush();assert.equal(f.calls.filter(c=>c.method==='SYNCLINK').length,1,'time alone cannot trigger metadata retries');f.push();t.mock.timers.tick(100);await flush();assert.equal(f.calls.filter(c=>c.method==='SYNCLINK').length,2);}finally{f.close();t.mock.timers.reset();}
});
for(const condition of ['different','same','close'])test('D2 session history held by discovery and '+condition+' view does not revive stale selection',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});const gate=deferred(),f=sessionFixture({chatInfoGate:gate,chatInfo:{c:'321',t:'DirectChat',title:'Synthetic discovered normal'}});let pending;try{await f.start();const [a,b]=f.rooms();f.session.view(a.key);await discover(f,t);assert.equal(f.calls.filter(c=>c.method==='CHATINFO').length,1);pending=f.session.history(a.key,1);if(condition==='different')f.session.view(b.key);if(condition==='same')f.session.view(a.key);if(condition==='close')f.session.close();gate.resolve();await flush();assert.equal(await pending,condition==='same');assert.equal(f.calls.filter(c=>c.method==='SYNCMSG').length,condition==='same'?1:0);}finally{f.close();await pending;t.mock.timers.reset();}
});
for(const action of ['context','read','photo'])for(const condition of ['different','same','close'])test('D2 held '+action+' and '+condition+' view honor pre-action selection intent',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});const gate=deferred(),f=sessionFixture({chatInfoGate:gate,chatInfo:{c:'321',t:'DirectChat',title:'Synthetic discovered normal'}});let pending;try{await f.start();const [a,b]=f.rooms();f.session.view(a.key);f.carriage.emit('push',{method:'MSG',status:0,body:{chatId:'123',chatLog:{logId:'10',authorId:'111',type:1,msg:'Synthetic incoming'}}});const message=f.events.findLast(e=>e.type==='reader-messages'&&e.key===a.key).messages[0].key;await discover(f,t);pending=f.session.action(a.key,1,action,action==='read'?{message}:action==='photo'?{image:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64').toString('base64')}:{});if(condition==='different')f.session.view(b.key);if(condition==='same')f.session.view(a.key);if(condition==='close')f.session.close();gate.resolve();await flush();assert.equal(await pending,condition==='same');const operations=f.calls.filter(c=>['CHATONROOM','NOTIREAD','SHIP','POST'].includes(c.method));if(condition!=='same')assert.equal(operations.length,0,'stale selection must not activate entry/read/upload');else{assert.ok(operations.length>0);assert.equal(f.events.findLast(e=>e.type==='reader-action').phase,'accepted');}}finally{f.close();await pending;t.mock.timers.reset();}
});
test('D2 explicit text send retains its distinct intent after a view change during metadata wait',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});const gate=deferred(),f=sessionFixture({chatInfoGate:gate,chatInfo:{c:'321',t:'DirectChat',title:'Synthetic discovered normal'}});let pending;try{await f.start();const [a,b]=f.rooms();f.session.view(a.key);await discover(f,t);pending=f.session.action(a.key,1,'send',{text:'Synthetic explicit send'});f.session.view(b.key);gate.resolve();await flush();assert.equal(await pending,true);const writes=f.calls.filter(c=>c.method==='WRITE');assert.equal(writes.length,1);assert.equal(String(writes[0].body.chatId),'123');assert.equal(f.events.findLast(e=>e.type==='reader-action').phase,'accepted');}finally{f.close();await pending;t.mock.timers.reset();}
});
