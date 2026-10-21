// Reconnect contracts through the actual session/store/manager/state chain.
// Every transport, credential and message is synthetic; no Kakao socket or worker process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createReaderSession} from '../experiments/local-web/reader-session.mjs';
import {createReadOnlyReader} from '../experiments/local-web/reader-manager.mjs';
import {createLocalServer} from '../experiments/local-web/server.mjs';

const self='999',peer='111',credential={userId:self,deviceUUID:'SYNTHETIC_DEVICE',accessToken:'SYNTHETIC_NO_ACCOUNT'};
const row=(id='123',extra={})=>({c:id,t:'DirectChat',title:'Synthetic '+id,ll:'100',n:3,...extra});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){const end=Date.now()+2500;while(!check()){if(Date.now()>end)throw new Error('reconnect fixture deadline');await tick();}}
function preferences(notifications=false){return {account:()=>({key:()=>Buffer.alloc(32,8),snapshot:()=>({persist:false,readSync:false,roomFilter:'all',notifications,storageAvailable:true}),room:()=>null,close(){}})};}
async function fixture({initial=[row()],notifications=false,user=self}={}){
 const f={calls:[],ipc:[],events:[],children:[],carriages:[],sessions:[],rows:initial};
 const cred={...credential,userId:user};
 const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};}});
 const spawn=()=>{
  const generation=f.children.length+1,rows=f.rows;
  const carriage=Object.assign(new EventEmitter(),{async connect(){},disconnect(){},stopPing(){},async loginList(){return {status:0,body:{chatDatas:rows}};},async request(method,body){f.calls.push({generation,method,body});assert.fail('reconnect receipt fixture must not issue '+method);}});
  const child=Object.assign(new EventEmitter(),{send(value,callback){f.ipc.push(value);if(value.type==='reader-start'){
   this.session=createReaderSession(value.credential,{messaging:true,sessionSalt:value.sessionSalt,settingsSecret:Buffer.from(value.settingsSecret,'hex'),booking:bootstrap,ticket:bootstrap,carriage:()=>carriage,toLong:String,resolve:async host=>host,every:()=>0},event=>{f.events.push({generation,...event});this.emit('message',event);});f.sessions.push(this.session);void this.session.start();
  }else if(value.type==='reader-view')this.session.view(value.key);else assert.fail('unexpected fixture IPC '+value.type);callback?.();},kill(){this.session?.close();return true;}});
  f.children.push(child);f.carriages.push(carriage);queueMicrotask(()=>child.emit('message',{type:'reader-ready'}));return child;
 };
 f.reader=createReadOnlyReader({messaging:true,spawn,preferenceStore:preferences(notifications)});
 f.cred=cred;
 f.key=(id='123')=>f.reader.rooms().rooms.find(room=>room.title==='Synthetic '+id)?.key;
 f.visible=(id='123')=>f.reader.rooms().rooms.find(room=>room.key===f.key(id));
 f.count=(id='123')=>f.visible(id).unreadLocalCount;
 f.push=(id,room='123',author=peer,generation=f.carriages.length-1)=>f.carriages[generation].emit('push',{method:'MSG',status:0,body:{chatId:room,chatLog:{logId:String(id),authorId:author,type:1,msg:'Synthetic incoming'}}});
 f.read=(mark,extra={},generation=f.carriages.length-1)=>f.carriages[generation].emit('push',{method:'DECUNREAD',status:0,body:{chatId:'123',userId:user,watermark:String(mark),...extra}});
 f.reconnect=async rows=>{f.reader.disconnect();f.rows=rows;const before=f.children.length;assert.equal(f.reader.connect(cred),true);await until(()=>f.children.length===before+1&&f.reader.snapshot().phase==='connected');};
 f.close=()=>{f.reader.close();for(const session of f.sessions)session.close();};
 assert.equal(f.reader.connect(cred),true);await until(()=>f.reader.snapshot().phase==='connected');return f;
}
function noActions(f){for(const method of ['WRITE','NOTIREAD','SHIP','POST','JOINLINK'])assert.equal(f.calls.filter(call=>call.method===method).length,0,method+' must not be caused by inbound synchronization');}
async function retained(options){const f=await fixture(options);f.push(105);assert.equal(f.count(),4);return f;}

test('lower reconnect ll90 and own90 cannot erase initial ll100 seed or retained incoming105',async()=>{
 const f=await retained();try{await f.reconnect([row('123',{ll:'90'})]);assert.equal(f.count(),4);f.read(90);assert.equal(f.count(),4);assert.equal(f.visible().unreadCoverage,'partial');noActions(f);}finally{f.close();}
});
test('missing reconnect bound plus MSG101 and own101 retains seed3 and prior incoming105',async()=>{
 const f=await retained();try{await f.reconnect([row('123',{ll:undefined})]);f.push(101);f.read(101);assert.equal(f.count(),4);assert.equal(f.visible().unreadCoverage,'partial');noActions(f);}finally{f.close();}
});
for(const bound of ['90','100'])test('own100 after reconnect ll'+bound+' clears only the known original seed and preserves105',async()=>{
 const f=await retained();try{await f.reconnect([row('123',{ll:bound})]);f.read(100);assert.equal(f.count(),1);noActions(f);}finally{f.close();}
});
for(const bound of ['90',undefined])test('a later full own105 can recover all retained known unread after '+(bound??'missing')+' reconnect bound',async()=>{
 const f=await retained();try{await f.reconnect([row('123',{ll:bound})]);f.read(105);assert.equal(f.count(),0);noActions(f);}finally{f.close();}
});
test('a newer reconnect ll110 does not stop own109 from covering old incoming105',async()=>{
 const f=await retained();try{await f.reconnect([row('123',{ll:'110'})]);f.read(104);assert.equal(f.count(),1);f.read(109);assert.equal(f.count(),0);}finally{f.close();}
});
test('later incoming106 survives own105 that clears the original seed and retained105',async()=>{
 const f=await retained();try{await f.reconnect([row('123',{ll:'90'})]);f.push(106);assert.equal(f.count(),5);f.read(105);assert.equal(f.count(),1);f.read(106);assert.equal(f.count(),0);noActions(f);}finally{f.close();}
});
test('missing reconnect bound can recover retained105 while preserving a subsequent106',async()=>{
 const f=await retained();try{await f.reconnect([row('123',{ll:undefined})]);f.read(101);f.push(106);assert.equal(f.count(),5);f.read(105);assert.equal(f.count(),1);f.read(106);assert.equal(f.count(),0);}finally{f.close();}
});
test('replayed105 after lower reconnect is deduped and own90 still preserves the original four',async()=>{
 const f=await retained();try{await f.reconnect([row('123',{ll:'90'})]);f.push(105);assert.equal(f.count(),4);f.read(90);assert.equal(f.count(),4);}finally{f.close();}
});
test('known own105 survives reconnect and excludes a first-ever late104 without relying on duplicate memory',async()=>{
 const f=await fixture({notifications:true});try{f.read(105);assert.equal(f.count(),0);await f.reconnect([row('123',{ll:'90'})]);f.push(104);assert.equal(f.count(),0);assert.deepEqual(f.reader.claimNotifications(),[]);f.push(106);assert.equal(f.count(),1);f.read(106);assert.equal(f.count(),0);noActions(f);}finally{f.close();}
});
test('reordered and duplicate receipts cannot erase retained105 or later106',async()=>{
 const f=await retained();try{await f.reconnect([row('123',{ll:'90'})]);f.read(104);assert.equal(f.count(),1);f.push(106);f.read(100);f.read(104);assert.equal(f.count(),2);f.read(105);assert.equal(f.count(),1);const stable=f.reader.snapshot();f.read(104);f.read(105);assert.equal(f.count(),1);assert.equal(f.reader.snapshot().revision,stable.revision);f.read(106);assert.equal(f.count(),0);}finally{f.close();}
});
test('a below-original-bound receipt changes neither visible unread nor revisions after reconnect already marks partial',async()=>{
 const f=await retained();try{await f.reconnect([row('123',{ll:'90'})]);const before=f.reader.snapshot();f.read(90);assert.equal(f.count(),4);const after=f.reader.snapshot();assert.equal(after.revision,before.revision);assert.equal(after.roomsRevision,before.roomsRevision);assert.deepEqual(after.pageRevisions,before.pageRevisions);assert.equal(after.settingsRevision,before.settingsRevision);assert.equal(after.outboxRevision,before.outboxRevision);}finally{f.close();}
});
test('own partial receipt after reconnect preserves pages, latest visibility, tokens and read-OFF permissions',async()=>{
 const f=await retained();try{await f.reconnect([row('123',{ll:'90'})]);f.push(106);const page=f.reader.messages(f.key()),before=f.reader.snapshot(),caps=f.visible();f.read(105);assert.equal(f.count(),1);assert.deepEqual(f.reader.messages(f.key()),page);const after=f.reader.snapshot();assert.deepEqual(after.pageRevisions,before.pageRevisions);assert.equal(after.settingsRevision,before.settingsRevision);assert.equal(after.outboxRevision,before.outboxRevision);for(const field of ['canText','canReply','canPhoto','canRead','canContext'])assert.equal(f.visible()[field],caps[field]);assert.equal(f.reader.settingsSnapshot().readSync,false);}finally{f.close();}
});
test('uncovered retained event keeps its pending notification despite a lower reconnect receipt',async()=>{
 const f=await retained({notifications:true});try{await f.reconnect([row('123',{ll:'90'})]);f.read(90);assert.equal(f.count(),4);assert.deepEqual(f.reader.claimNotifications().map(notice=>notice.key),[f.key()]);}finally{f.close();}
});
test('covering only the seed leaves the retained-event notification; full read removes it',async()=>{
 const f=await retained({notifications:true});try{await f.reconnect([row('123',{ll:'90'})]);f.read(100);assert.equal(f.count(),1);assert.equal(f.reader.claimNotifications().length,1);f.push(106);f.read(106);assert.deepEqual(f.reader.claimNotifications(),[]);}finally{f.close();}
});
test('partial reconnect receipt cannot change another room seed or event',async()=>{
 const f=await retained({initial:[row(),row('456')]});try{f.push(105,'456');await f.reconnect([row('123',{ll:'90'}),row('456',{ll:'90'})]);f.read(100);assert.equal(f.count(),1);assert.equal(f.count('456'),4);f.read(105);assert.equal(f.count(),0);assert.equal(f.count('456'),4);}finally{f.close();}
});
test('multiple reconnects cannot replace original unread proof with a progressively lower bound',async()=>{
 const f=await retained();try{for(const bound of ['95','90','85']){await f.reconnect([row('123',{ll:bound})]);f.read(bound);assert.equal(f.count(),4);}f.read(105);assert.equal(f.count(),0);}finally{f.close();}
});
test('original unknown seed remains conservative despite a new known reconnect bound and valid full receipt',async()=>{
 const f=await fixture({initial:[row('123',{ll:undefined})]});try{f.push(105);assert.equal(f.count(),3);await f.reconnect([row('123',{ll:'90'})]);f.push(106);f.read(105);assert.equal(f.count(),4);assert.equal(f.visible().unreadCoverage,'partial');f.read(106);assert.equal(f.count(),3,'unknown original seed cannot be proved read by a new child bound');const page=f.reader.messages(f.key());assert.ok(page.seenToken);assert.equal(f.reader.seen(f.key(),page.seenToken,false),true);assert.equal(f.count(),0);noActions(f);}finally{f.close();}
});
test('local seen before reconnect is not resurrected by the new count and new arrivals remain countable',async()=>{
 const f=await retained();try{assert.equal(f.reader.seen(f.key(),f.reader.messages(f.key()).seenToken,false),true);assert.equal(f.count(),0);await f.reconnect([row('123',{ll:'90',n:9})]);assert.equal(f.count(),0);f.push(106);assert.equal(f.count(),1);f.read(106);assert.equal(f.count(),0);}finally{f.close();}
});
test('a token issued after reconnect before own read cannot clear a later event',async()=>{
 const f=await retained();try{await f.reconnect([row('123',{ll:'90'})]);f.push(106);const token=f.reader.messages(f.key()).seenToken;f.read(105);f.push(107);assert.equal(f.reader.seen(f.key(),token,false),true);assert.equal(f.count(),1);noActions(f);}finally{f.close();}
});
test('retired child packets after reconnect do not apply even when a later current receipt can recover',async()=>{
 const f=await retained();try{const old=f.children[0],key=f.key();await f.reconnect([row('123',{ll:'90'})]);f.read(105,{},0);old.emit('message',{type:'reader-own-read',key,read:{keys:[],clearInitial:true,clearEvents:true,partial:false}});assert.equal(f.count(),4);f.read(105);assert.equal(f.count(),0);noActions(f);}finally{f.close();}
});
test('reader close clears retained unread without allowing an old account child to touch another reader',async()=>{
 const a=await retained(),b=await fixture({user:'1000'});try{b.push(105);const old=a.children[0],key=a.key();a.close();old.emit('message',{type:'reader-own-read',key,read:{keys:[],clearInitial:true,clearEvents:true,partial:false}});assert.equal(a.reader.rooms().rooms.length,0);assert.equal(b.count(),4);assert.equal(b.reader.connect(credential),false);b.read(105);assert.equal(b.count(),0);}finally{a.close();b.close();}
});
test('signed64 positions above Number precision compare exactly across worker generations',async()=>{
 const room='9007199254740993',baseline='9223372036854775803',later='9223372036854775805',between='9223372036854775804',f=await fixture({initial:[row(room,{ll:baseline})]});try{f.push(later,room);assert.equal(f.count(room),4);await f.reconnect([row(room,{ll:'9007199254740992'})]);f.read(between,{chatId:room});assert.equal(f.count(room),1);f.read(later,{chatId:room});assert.equal(f.count(room),0);}finally{f.close();}
});
for(const [label,fields] of [['overflow watermark',{watermark:'9223372036854775808'}],['unsafe numeric watermark',{watermark:9007199254740992}],['conflicting room alias',{c:'456'}],['foreign self',{userId:'222'}]])test('invalid or peer receipt cannot consume retained unread after reconnect: '+label,async()=>{
 const f=await retained();try{await f.reconnect([row('123',{ll:'90'})]);f.read(105,fields);assert.equal(f.count(),4);f.read(105);assert.equal(f.count(),0);}finally{f.close();}
});
test('retained2000-event capacity remains bounded and partial own read preserves exactly the later100',async()=>{
 const f=await fixture();try{for(let id=101;id<=2100;id++)f.push(id);assert.equal(f.count(),2003);await f.reconnect([row('123',{ll:'90'})]);f.read(2000);assert.equal(f.count(),100);f.push(2101);assert.equal(f.count(),101);f.read(2101);assert.equal(f.count(),0);}finally{f.close();}
});
function assertOpaque(value,positions){
 const serialized=JSON.stringify(value);for(const position of positions)assert.equal(serialized.includes(position),false,'raw synthetic position must stay outside browser-facing payload');
 const visit=node=>{if(!node||typeof node!=='object')return;for(const [key,child] of Object.entries(node)){assert.equal(/(?:watermark|baseline|logId|logPosition|unreadProof)/i.test(key),false,'private read proof field leaked: '+key);visit(child);}};visit(value);
}
test('actual local browser API projections do not expose reconnect proof positions or raw room/user identifiers',async()=>{
 const room='9007199254740993',user='9007199254740995',initial='9223372036854775803',later='9223372036854775805',f=await fixture({user,initial:[row(room,{title:'Synthetic '+room,ll:initial})]});let app;
 try{
  f.push(later,room);await f.reconnect([row(room,{ll:'9007199254740992'})]);f.read('9223372036854775804',{chatId:room});
  // Titles and text are display data. Remove the intentional synthetic ID in the title before checking projections.
  app=createLocalServer({mode:'live',messaging:true,encode:()=>[[true]],preferenceStore:preferences(),readerFactory:()=>f.reader,transport:async operation=>operation==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:operation==='generate'?{httpStatus:200,body:{status:0,url:'SYNTHETIC_NO_LOGIN',remainingSeconds:180}}:{httpStatus:200,body:{status:0,user:{userId:user},accessToken:'SYNTHETIC_NO_ACCOUNT'}}});
  const url=await app.listen(0);assert.notEqual(app.server.address().port,8787);await app.lab.start();await until(()=>app.lab.snapshot().credentialInMemory);
  const launch=await fetch(url+'/api/local/launch',{method:'POST',headers:{Origin:url,'X-Local-Control':app.controlToken,'Content-Type':'application/json'},body:'{}'});assert.equal(launch.status,200);const {ticket}=await launch.json();
  const exchange=await fetch(url+'/api/local/session',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify({ticket})});assert.equal(exchange.status,200);const {session}=await exchange.json();
  for(const path of ['/api/status','/api/reader/rooms','/api/reader/messages?room='+f.key(room),'/api/reader/outbox','/api/preferences']){const response=await fetch(url+path,{headers:{'X-Local-Session':session}});assert.equal(response.status,200);const payload=await response.json();const scrubbed=JSON.parse(JSON.stringify(payload).replaceAll('Synthetic '+room,'Synthetic room'));assertOpaque(scrubbed,[room,user,initial,later,'9007199254740992','9223372036854775804']);}
  noActions(f);
 }finally{f.close();if(app){app.lab.cancel();app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));}}
});

// Additional IPC boundary checks were appended after the original30 RED froze.
// They assert observable preservation, never a particular internal storage implementation.
const proofRoom='r_'+'a'.repeat(24),proofOther='r_'+'b'.repeat(24),proofMessage='m_'+'a'.repeat(24),proofForeign='m_'+'b'.repeat(24);
function proofFixture({seedBounds,arrivalProof}={}){
 const child=Object.assign(new EventEmitter(),{send(_message,callback){callback?.();},kill(){return true;}});
 const reader=createReadOnlyReader({messaging:true,spawn:()=>child,preferenceStore:preferences()});
 assert.equal(reader.connect(credential),true);
 child.emit('message',{type:'reader-rooms',source:'loginlist',rooms:[{key:proofRoom,title:'Synthetic proof A',kind:'DirectChat',initialUnreadCount:3},{key:proofOther,title:'Synthetic proof B',kind:'DirectChat',initialUnreadCount:3}],seedBounds:seedBounds??[{key:proofRoom,bound:'100'},{key:proofOther,bound:'100'}],stats:{sourceRoomCount:2}});
 const push=(key,message,provided)=>child.emit('message',{type:'reader-messages',source:'push',key,latestVisible:true,messages:[{key:message,text:'Synthetic incoming',mine:false}],arrivals:[{key:message,incoming:true,afterBaseline:true,userMessage:true}],arrivalProof:provided??[{key:message,position:'105'}]});
 push(proofRoom,proofMessage,arrivalProof);push(proofOther,proofForeign);
 const count=key=>reader.rooms().rooms.find(room=>room.key===key).unreadLocalCount;
 assert.equal(count(proofRoom),4);assert.equal(count(proofOther),4);
 return {reader,child,count,emit:(proof,read={keys:[],clearInitial:true,clearEvents:true,partial:false})=>child.emit('message',{type:'reader-own-read',key:proofRoom,read,...(proof===undefined?{}:{proof})})};
}
for(const [label,proof] of [
 ['missing watermark proof',undefined],
 ['unsafe numeric watermark',{watermark:9007199254740992}],
 ['out-of-signed64 watermark',{watermark:'9223372036854775808'}],
 ['extra room alias in proof',{watermark:'105',chatId:'456'}],
 ['array proof container',[]],
])test('proof boundary preserves unread and marks coverage partial: '+label,()=>{
 const f=proofFixture();try{const before=f.reader.snapshot(),page=f.reader.messages(proofRoom);f.emit(proof);assert.equal(f.count(proofRoom),4);assert.equal(f.count(proofOther),4);assert.equal(f.reader.rooms().rooms.find(room=>room.key===proofRoom).unreadCoverage,'partial');const after=f.reader.snapshot();assert.equal(after.revision,before.revision+1);assert.equal(after.roomsRevision,before.roomsRevision+1);assert.deepEqual(after.pageRevisions,before.pageRevisions);assert.equal(after.settingsRevision,before.settingsRevision);assert.equal(after.outboxRevision,before.outboxRevision);assert.deepEqual(f.reader.messages(proofRoom),page);}finally{f.reader.close();}
});
test('proof boundary rejects a conflicting foreign message key atomically even with a valid watermark',()=>{
 const f=proofFixture();try{const before=f.reader.snapshot();f.emit({watermark:'105'},{keys:[proofForeign],clearInitial:true,clearEvents:true,partial:false});assert.equal(f.count(proofRoom),4);assert.equal(f.count(proofOther),4);assert.equal(f.reader.snapshot().revision,before.revision);assert.equal(f.reader.snapshot().roomsRevision,before.roomsRevision);}finally{f.reader.close();}
});
test('malformed seed-bound proof cannot turn an unknown original seed into a clearable bound',()=>{
 const f=proofFixture({seedBounds:[{key:proofRoom,bound:'100',chatId:'456'},{key:proofOther,bound:'100'}]});try{f.emit({watermark:'105'});assert.equal(f.count(proofRoom),3,'known event can clear, but the original seed has no valid bound');assert.equal(f.count(proofOther),4);assert.equal(f.reader.rooms().rooms.find(room=>room.key===proofRoom).unreadCoverage,'partial');assertOpaque({rooms:f.reader.rooms(),messages:f.reader.messages(proofRoom)},['9223372036854775805']);}finally{f.reader.close();}
});
test('mismatched arrival-position proof leaves its event conservative instead of trusting full-clear flags',()=>{
 const f=proofFixture({arrivalProof:[{key:proofForeign,position:'105'}]});try{f.emit({watermark:'100'});assert.equal(f.count(proofRoom),1,'only the known initial seed is covered; the unproved event remains');assert.equal(f.count(proofOther),4);assert.equal(f.reader.rooms().rooms.find(room=>room.key===proofRoom).unreadCoverage,'partial');assertOpaque({rooms:f.reader.rooms(),messages:f.reader.messages(proofRoom)},['9223372036854775805']);}finally{f.reader.close();}
});
