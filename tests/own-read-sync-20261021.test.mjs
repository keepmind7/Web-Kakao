// Synthetic in-memory transports only. No Kakao socket, account or worker process.
// This prototype imports from the explicit project cwd so publication needs no assertion rewrite.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const load=name=>import(pathToFileURL(resolve('experiments/local-web',name)).href);
const [{createReaderStore},{createReadOnlyReader},{createReaderSession}]=await Promise.all([load('reader-data.mjs'),load('reader-manager.mjs'),load('reader-session.mjs')]);
const own='999',peer='111',credential={userId:own,deviceUUID:'SYNTHETIC_DEVICE',accessToken:'SYNTHETIC_NO_ACCOUNT'};
const row=(id='123',extra={})=>({c:id,t:'DirectChat',title:'Synthetic '+id,ll:'100',n:3,...extra});
const msg=(id,author=peer)=>({logId:String(id),authorId:author,type:1,msg:'Synthetic '+id});
const incoming=(store,id,room='123',author=peer)=>store.push({chatId:room,chatLog:msg(id,author)})[0];
const receipt=(store,mark,extra={})=>store.readUpdate({chatId:'123',userId:own,watermark:String(mark),...extra});
const keyAt=(store,id='123')=>store.rooms().find(r=>store.serverRoomId(r.key)===id).key;
const mk=n=>'m_'+BigInt(n).toString(16).padStart(24,'0');
const rk=n=>'r_'+BigInt(n).toString(16).padStart(24,'0');
const tick=()=>new Promise(r=>setImmediate(r));
async function until(check){const end=Date.now()+2500;while(!check()){if(Date.now()>end)throw new Error('synthetic fixture condition deadline');await tick();}}
function preferences({notifications=false}={}){
 const snapshot={persist:false,readSync:false,roomFilter:'all',notifications,storageAvailable:true};
 return {account:()=>({key:()=>Buffer.alloc(32,8),snapshot:()=>({...snapshot}),room:()=>null,set(patch){Object.assign(snapshot,patch);return true;},close(){}})};
}
async function pipeline({rows=[row()],notifications=false,messaging=true,beforeAnnouncement}={}){
 const f={calls:[],ipc:[],events:[],children:[],carriages:[],sessions:[]};
 const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};}});
 const spawn=()=>{
  const carriage=Object.assign(new EventEmitter(),{async connect(){},disconnect(){},stopPing(){},async loginList(){return {status:0,body:{chatDatas:rows}};},async request(method,body){
   f.calls.push({method,body});
   if(method==='SYNCLINK'){await beforeAnnouncement?.(carriage);return {status:0,body:{ltk:0,ols:[{li:'700',ac:true}]}};}
   if(method==='SYNCMSG')return {status:0,body:{isOK:true,chatLogs:[]}};
   if(method==='CHATONROOM')return {status:0,body:{c:String(body.chatId),mi:[own,peer],a:[peer],w:['0']}};
   if(method==='MEMBER')return {status:0,body:{chatId:String(body.chatId),members:[]}};
   assert.fail('unexpected synthetic request '+method);
  }});
  const child=Object.assign(new EventEmitter(),{send(value,cb){f.ipc.push(value);if(value.type==='reader-start'){
   this.session=createReaderSession(value.credential,{messaging,sessionSalt:value.sessionSalt,settingsSecret:Buffer.from(value.settingsSecret,'hex'),booking:bootstrap,ticket:bootstrap,carriage:()=>carriage,toLong:String,resolve:async h=>h,every:()=>0},event=>{f.events.push(event);this.emit('message',event);});f.sessions.push(this.session);void this.session.start();
  }else if(value.type==='reader-view')this.session.view(value.key);else if(value.type==='reader-history')void this.session.history(value.key,value.requestId);else if(value.type==='reader-action')void this.session.action(value.key,value.requestId,value.action,value.payload);else assert.fail('unexpected synthetic IPC');cb?.();},kill(){this.session?.close();return true;}});
  f.children.push(child);f.carriages.push(carriage);queueMicrotask(()=>child.emit('message',{type:'reader-ready'}));return child;
 };
 f.reader=createReadOnlyReader({messaging,spawn,preferenceStore:preferences({notifications})});
 assert.equal(f.reader.connect(credential),true);await until(()=>f.reader.snapshot().phase==='connected');
 f.child=()=>f.children.at(-1);f.transport=()=>f.carriages.at(-1);
 f.key=(id='123')=>f.reader.rooms().rooms.find(r=>r.title==='Synthetic '+id).key;
 f.count=(id='123')=>f.reader.rooms().rooms.find(r=>r.key===f.key(id)).unreadLocalCount;
 f.push=(id,room='123',author=peer)=>f.transport().emit('push',{method:'MSG',status:0,body:{chatId:room,chatLog:msg(id,author)}});
 f.read=(mark,extra={})=>f.transport().emit('push',{method:'DECUNREAD',status:0,body:{chatId:'123',userId:own,watermark:String(mark),...extra}});
 f.close=()=>{f.reader.close();for(const s of f.sessions)s.close();};return f;
}
const ownRead=update=>{assert.ok(update?.ownRead,'known-self DECUNREAD must produce the bounded ownRead handoff');return update.ownRead;};
const forbidden=f=>{for(const method of ['WRITE','NOTIREAD','SHIP','POST','JOINLINK'])assert.equal(f.calls.filter(c=>c.method===method).length,0,method+' caused by inbound synchronization');};

test('full own DECUNREAD clears initial3 plus one observed arrival through the actual session pipeline',async()=>{
 const f=await pipeline();try{f.push(101);assert.equal(f.count(),4);f.read(101);assert.equal(f.count(),0);assert.equal(f.reader.snapshot().phase,'connected');forbidden(f);}finally{f.close();}
});
test('own read before LOGINLIST publication is replayed against the later latest bound rather than clearing a newer MSG',async()=>{
 const f=await pipeline({rows:[row('123',{t:'OM',li:'700'})],beforeAnnouncement:carriage=>{
  carriage.emit('push',{method:'DECUNREAD',status:0,body:{chatId:'123',userId:own,watermark:'100'}});
  carriage.emit('push',{method:'MSG',status:0,body:{chatId:'123',chatLog:msg(101)}});
 }});try{assert.equal(f.count(),1);assert.ok(f.events.findIndex(e=>e.type==='reader-own-read')>f.events.findIndex(e=>e.type==='reader-rooms'&&e.source==='loginlist'));forbidden(f);}finally{f.close();}
});
test('own read before LOGINLIST publication suppresses a subsequent late MSG at or below its watermark',async()=>{
 const f=await pipeline({rows:[row('123',{t:'OM',li:'700'})],beforeAnnouncement:carriage=>{
  carriage.emit('push',{method:'DECUNREAD',status:0,body:{chatId:'123',userId:own,watermark:'101'}});
  carriage.emit('push',{method:'MSG',status:0,body:{chatId:'123',chatLog:msg(100)}});
 }});try{assert.equal(f.count(),0);forbidden(f);}finally{f.close();}
});
test('own receipt uses a distinct internal event and does not republish a cached message page',async()=>{
 const f=await pipeline();try{f.push(101);const before=f.events.length;f.read(101);const after=f.events.slice(before);assert.equal(after.filter(e=>e.type==='reader-own-read').length,1);assert.equal(after.filter(e=>e.type==='reader-messages').length,0);assert.equal(after.filter(e=>e.type==='reader-rooms').length,0);forbidden(f);}finally{f.close();}
});
test('partial own read removes only tracked covered keys and preserves a later event',async()=>{
 const f=await pipeline();try{f.push(101);f.push(103);f.read(101);assert.equal(f.count(),1);assert.equal(f.reader.rooms().rooms[0].unreadCoverage,'observed');f.read(103);assert.equal(f.count(),0);}finally{f.close();}
});
test('unknown initial bound preserves initial count conservatively on a partial read',async()=>{
 const f=await pipeline({rows:[row('123',{ll:undefined})]});try{f.push(101);f.read(101);f.push(103);assert.equal(f.count(),4);assert.equal(f.reader.rooms().rooms[0].unreadCoverage,'partial');}finally{f.close();}
});
test('known initial bound is not inferred from ID distance for a receipt below the initial baseline',async()=>{
 const f=await pipeline();try{f.push(101);f.read(99);assert.equal(f.count(),4);assert.equal(f.reader.rooms().rooms[0].unreadCoverage,'partial');}finally{f.close();}
});
test('full own read then late/replayed incoming at or below mark cannot revive badges or notifications',async()=>{
 const f=await pipeline({notifications:true});try{f.read(102);f.push(101);f.push(102);f.push(101);assert.equal(f.count(),0);assert.deepEqual(f.reader.claimNotifications(),[]);f.push(103);assert.equal(f.count(),1);assert.equal(f.reader.claimNotifications().length,1);}finally{f.close();}
});
test('an equal or older own receipt is idempotent and cannot clear a newer event',async()=>{
 const f=await pipeline();try{f.push(101);f.read(101);const first=f.reader.snapshot();f.read(101);f.read(100);assert.equal(f.reader.snapshot().revision,first.revision);assert.equal(f.reader.snapshot().roomsRevision,first.roomsRevision);f.push(102);const later=f.reader.snapshot();f.read(101);f.read(99);assert.equal(f.count(),1);assert.equal(f.reader.snapshot().revision,later.revision);}finally{f.close();}
});
test('valid peer DECUNREAD preserves local unread while retaining the peer bubble path',async()=>{
 const f=await pipeline();try{f.push(101);const before=f.events.length;f.read(101,{userId:peer});assert.equal(f.count(),4);assert.equal(f.events.slice(before).filter(e=>e.type==='reader-own-read').length,0);assert.equal(f.events.slice(before).filter(e=>e.type==='reader-messages'&&e.source==='receipt').length,1);forbidden(f);}finally{f.close();}
});
test('own receipt updates only overall/room revisions; page, latest, tokens, settings and outbox remain unchanged',async()=>{
 const f=await pipeline();try{f.push(101);const page=f.reader.messages(f.key()),before=f.reader.snapshot(),outbox=f.reader.outbox();f.read(101);const after=f.reader.snapshot();assert.equal(after.revision,before.revision+1);assert.equal(after.roomsRevision,before.roomsRevision+1);assert.equal(after.settingsRevision,before.settingsRevision);assert.equal(after.outboxRevision,before.outboxRevision);assert.deepEqual(after.pageRevisions,before.pageRevisions);assert.deepEqual(f.reader.messages(f.key()),page);assert.deepEqual(f.reader.outbox(),outbox);assert.equal(after.sendRequests,0);}finally{f.close();}
});
test('receipt in room A cannot change room B, and only A notification is removed',async()=>{
 const f=await pipeline({rows:[row(),row('456')],notifications:true});try{f.push(101);f.push(101,'456');f.read(101);assert.equal(f.count(),0);assert.equal(f.count('456'),4);assert.deepEqual(f.reader.claimNotifications().map(n=>n.key),[f.key('456')]);}finally{f.close();}
});
test('partial receipt retains notification for outstanding observed messages; full receipt removes it',async()=>{
 const f=await pipeline({notifications:true});try{f.push(101);f.push(102);f.read(101);assert.equal(f.count(),1);assert.equal(f.reader.claimNotifications().length,1);f.push(103);f.read(103);assert.deepEqual(f.reader.claimNotifications(),[]);}finally{f.close();}
});
test('local seen token issued before own-read retains its sequence and does not clear a later arrival',async()=>{
 const f=await pipeline();try{f.push(101);const token=f.reader.messages(f.key()).seenToken;f.read(101);f.push(102);assert.equal(f.reader.seen(f.key(),token,false),true);assert.equal(f.count(),1);assert.equal(f.reader.seen(f.key(),f.reader.messages(f.key()).seenToken,false),true);assert.equal(f.count(),0);forbidden(f);}finally{f.close();}
});
test('permissions and read OFF policy do not change on valid self receipt with no peer membership snapshot',async()=>{
 const f=await pipeline();try{const capabilities=f.reader.rooms().rooms.map(({canText,canRead,canReply,canPhoto,canContext})=>({canText,canRead,canReply,canPhoto,canContext}));f.push(101);f.read(101);assert.equal(f.count(),0);assert.deepEqual(f.reader.rooms().rooms.map(({canText,canRead,canReply,canPhoto,canContext})=>({canText,canRead,canReply,canPhoto,canContext})),capabilities);assert.equal(f.reader.settingsSnapshot().readSync,false);forbidden(f);}finally{f.close();}
});
test('data full receipt returns opaque covered keys and exact bounds without raw IDs',()=>{
 const store=createReaderStore({chatDatas:[row()]},own,Buffer.alloc(32,1));try{const pushed=incoming(store,101),read=ownRead(receipt(store,101));assert.deepEqual(read.keys,[pushed.arrivals[0].key]);assert.equal(read.clearInitial,true);assert.equal(read.clearEvents,true);assert.equal(read.partial,false);assert.deepEqual(Object.keys(read).sort(),['clearEvents','clearInitial','keys','partial']);for(const id of ['123','999','111','101'])assert.equal(JSON.stringify(receipt(store,102)).includes('"'+id+'"'),false);}finally{store.clear();}
});
test('data partial receipt lists only its covered tracked IDs, even after the50-message display cache drops them',()=>{
 const store=createReaderStore({chatDatas:[row()]},own,Buffer.alloc(32,2));try{const expected=[];for(let id=101;id<=180;id++){const u=incoming(store,id);if(id<=110)expected.push(u.arrivals[0].key);}assert.equal(store.current(keyAt(store)).messages.length,50);const read=ownRead(receipt(store,110));assert.deepEqual(read.keys,expected);assert.equal(read.clearInitial,true);assert.equal(read.clearEvents,false);}finally{store.clear();}
});
test('own-read state survives 21-room display eviction and clears the evicted room without losing coverage',async()=>{
 const rows=Array.from({length:21},(_,n)=>row(String(123+n))),f=await pipeline({rows});try{f.push(101);for(let n=1;n<21;n++)f.push(101,String(123+n));assert.equal(f.reader.messages(f.key()).cacheLost,true);f.read(101);assert.equal(f.count(),0);assert.equal(f.count('124'),4);}finally{f.close();}
});
test('duplicate arrivals do not grow the tracked receipt map or duplicate receipt keys',()=>{
 const store=createReaderStore({chatDatas:[row()]},own);try{for(let n=0;n<20;n++)incoming(store,101);const read=ownRead(receipt(store,101));assert.equal(read.keys.length,1);assert.equal(new Set(read.keys).size,1);}finally{store.clear();}
});
test('countable tracking excludes own, control and before-baseline arrivals',()=>{
 const store=createReaderStore({chatDatas:[row()]},own);try{incoming(store,101,'123',own);incoming(store,99);store.push({chatId:'123',chatLog:{...msg(102),type:999}});const good=incoming(store,103),read=ownRead(receipt(store,103));assert.deepEqual(read.keys,[good.arrivals[0].key]);}finally{store.clear();}
});
test('discovered baseline zero is a known bound rather than an unknown initial count',()=>{
 const store=createReaderStore({chatDatas:[row()]},own);try{store.discover('456',{chatInfo:row('456',{n:9})});incoming(store,101,'456');const read=ownRead(receipt(store,101,{chatId:'456'}));assert.equal(read.clearInitial,true);assert.equal(read.clearEvents,true);assert.equal(read.partial,false);}finally{store.clear();}
});
test('valid signed64 max IDs remain exact through own-read matching',()=>{
 const id='9223372036854775807',self='9007199254740993',store=createReaderStore({chatDatas:[row(id,{ll:'9223372036854775805'})]},self);try{const update=store.push({chatId:id,chatLog:msg('9223372036854775806')})[0],read=ownRead(store.readUpdate({chatId:id,userId:self,watermark:'9223372036854775806'}));assert.deepEqual(read.keys,[update.arrivals[0].key]);assert.equal(read.clearInitial,true);assert.equal(read.clearEvents,true);}finally{store.clear();}
});
const invalidReceipts=[
 ['foreign room',{chatId:'456'}],['conflicting compact room',{c:'456'}],['conflicting expanded room',{roomId:'456'}],['conflicting chatroom alias',{chatRoomId:'456'}],
 ['unsafe room number',{chatId:9007199254740992}],['overflow room',{chatId:'9223372036854775808'}],['invalid self',{userId:0}],['unsafe self number',{userId:9007199254740992}],['overflow self',{userId:'9223372036854775808'}],
 ['negative watermark',{watermark:'-1'}],['fraction watermark',{watermark:1.25}],['unsafe watermark number',{watermark:9007199254740992}],['overflow watermark',{watermark:'9223372036854775808'}],
 ['foreign nested room',{chatInfo:{chatId:'456'}}],['malformed chatInfo array',{chatInfo:[]}],['malformed chatInfo null',{chatInfo:null}],['foreign link',{li:'701'}],['conflicting link aliases',{li:'700',linkId:'701'}],['malformed nested link',{chatInfo:{openLinkId:'701'}}],
];
for(const [name,fields] of invalidReceipts)test('invalid own receipt is atomic and cannot poison a later valid mark: '+name,()=>{
 const store=createReaderStore({chatDatas:[row('123',{li:'700'})]},own);try{const pushed=incoming(store,101),before=store.current(keyAt(store));assert.equal(receipt(store,101,fields),null);assert.deepEqual(store.current(keyAt(store)),before);const read=ownRead(receipt(store,101));assert.deepEqual(read.keys,[pushed.arrivals[0].key]);}finally{store.clear();}
});
test('conflicting peer room/link identity cannot mutate the prior peer unread display state',()=>{
 const store=createReaderStore({chatDatas:[row('123',{a:2,li:'700'})]},own),key=keyAt(store);try{incoming(store,101,'123',own);assert.equal(store.receiptSnapshot(key,{c:'123',mi:[own,peer],a:[peer],w:['0']}),true);const before=store.current(key);assert.equal(before.messages.at(-1).unreadCount,1);assert.equal(store.readUpdate({chatId:'123',c:'456',userId:peer,watermark:'101'}),null);assert.deepEqual(store.current(key),before);}finally{store.clear();}
});
test('incomplete peer membership does not prevent exact own read and does not become ready afterward',()=>{
 const store=createReaderStore({chatDatas:[row('123',{a:1500})]},own);try{incoming(store,101);const before=store.rooms();const read=ownRead(receipt(store,101));assert.equal(read.clearEvents,true);assert.deepEqual(store.rooms(),before);incoming(store,102,'123',own);assert.equal(store.current(keyAt(store)).messages.at(-1).unreadCount,null);}finally{store.clear();}
});
function manual(){
 const children=[],sent=[],latest=new Map(),positions=new Map(),reader=createReadOnlyReader({messaging:true,preferenceStore:preferences(),spawn:()=>{const child=Object.assign(new EventEmitter(),{send(m,cb){sent.push(m);cb?.();},kill(){return true;}});children.push(child);return child;}});
 const rooms=[{key:rk(1),title:'A',kind:'DirectChat',initialUnreadCount:3},{key:rk(2),title:'B',kind:'DirectChat',initialUnreadCount:3}];
 const ready=()=>{const child=children.at(-1);child.emit('message',{type:'reader-rooms',source:'loginlist',rooms,seedBounds:rooms.map(room=>({key:room.key,bound:'0'})),stats:{sourceRoomCount:2}});return child;};
 assert.equal(reader.connect(credential),true);ready();
 const push=(key,n)=>{latest.set(key,Math.max(latest.get(key)??0,n));positions.set(mk(n),n);children.at(-1).emit('message',{type:'reader-messages',source:'push',key,latestVisible:true,messages:[{key:mk(n),text:'Synthetic',mine:false}],arrivals:[{key:mk(n),incoming:true,afterBaseline:true,userMessage:true}],arrivalProof:[{key:mk(n),position:String(n)}]});};
 const emit=(key,read)=>{const mark=read.clearEvents===true?latest.get(key)??0:Math.max(0,...(Array.isArray(read.keys)?read.keys.map(value=>positions.get(value)??0):[]));children.at(-1).emit('message',{type:'reader-own-read',key,read,proof:{watermark:String(mark)}});};
 return {reader,children,sent,ready,push,emit};
}

test('manager handles a bounded partial internal receipt without touching another room or a later event',()=>{
 const f=manual();try{f.push(rk(1),1);f.push(rk(1),2);f.push(rk(2),3);f.emit(rk(1),{keys:[mk(1)],clearInitial:true,clearEvents:false,partial:false});assert.deepEqual(f.reader.rooms().rooms.map(r=>r.unreadLocalCount),[1,4]);f.emit(rk(1),{keys:[],clearInitial:false,clearEvents:true,partial:false});assert.deepEqual(f.reader.rooms().rooms.map(r=>r.unreadLocalCount),[0,4]);f.push(rk(1),4);assert.equal(f.reader.rooms().rooms[0].unreadLocalCount,1);}finally{f.reader.close();}
});
const invalidPayloads=[['missing flags',{keys:[mk(1)]}],['nonarray keys',{keys:'bad',clearInitial:true,clearEvents:true,partial:false}],['invalid key',{keys:['bad'],clearInitial:true,clearEvents:true,partial:false}],['too many keys',{keys:Array.from({length:2001},(_,i)=>mk(i)),clearInitial:true,clearEvents:true,partial:false}],['duplicate keys',{keys:[mk(1),mk(1)],clearInitial:true,clearEvents:true,partial:false}],['wrong boolean',{keys:[mk(1)],clearInitial:1,clearEvents:true,partial:false}],['missing coverage',{keys:[mk(1)],clearInitial:true,clearEvents:true}],['extra raw field',{keys:[mk(1)],clearInitial:true,clearEvents:true,partial:false,watermark:'101'}],['foreign room key',{keys:[mk(3)],clearInitial:true,clearEvents:false,partial:false}]];
for(const [name,read] of invalidPayloads)test('manager rejects complete malformed/foreign payload atomically: '+name,()=>{
 const f=manual();try{f.push(rk(1),1);f.push(rk(2),3);const before=f.reader.snapshot();f.emit(rk(1),read);assert.deepEqual(f.reader.rooms().rooms.map(r=>r.unreadLocalCount),[4,4]);assert.equal(f.reader.snapshot().revision,before.revision);assert.equal(f.reader.snapshot().roomsRevision,before.roomsRevision);}finally{f.reader.close();}
});
test('manager rejects own-read events while disconnected and from retired children after reconnect',()=>{
 const f=manual();try{f.push(rk(1),1);const old=f.children[0],read={keys:[mk(1)],clearInitial:true,clearEvents:true,partial:false};f.reader.disconnect();const before=f.reader.snapshot();old.emit('message',{type:'reader-own-read',key:rk(1),read});assert.equal(f.reader.snapshot().revision,before.revision);assert.equal(f.reader.rooms().rooms[0].unreadLocalCount,4);assert.equal(f.reader.connect(credential),true);f.ready();const current=f.reader.snapshot();old.emit('message',{type:'reader-own-read',key:rk(1),read});assert.equal(f.reader.snapshot().revision,current.revision);assert.equal(f.reader.rooms().rooms[0].unreadLocalCount,4);f.emit(rk(1),read);assert.equal(f.reader.rooms().rooms[0].unreadLocalCount,0);}finally{f.reader.close();}
});
test('own-read closed account state cannot mutate a new reader or another account',()=>{
 const a=manual(),b=manual();try{a.push(rk(1),1);b.push(rk(1),1);const stale=a.children[0];a.reader.close();stale.emit('message',{type:'reader-own-read',key:rk(1),read:{keys:[mk(1)],clearInitial:true,clearEvents:true,partial:false}});assert.equal(a.reader.rooms().rooms.length,0);assert.equal(b.reader.rooms().rooms[0].unreadLocalCount,4);assert.equal(b.reader.connect({...credential,userId:'1000'}),false);}finally{a.reader.close();b.reader.close();}
});
test('tracked own-read keys are capped at2000 per room, preserve admitted keys at capacity, and release covered entries',()=>{
 const store=createReaderStore({chatDatas:[row()]},own);try{const expected=[];for(let n=101;n<=2201;n++){const update=incoming(store,n);if(n<=2100)expected.push(update.arrivals[0].key);}const partial=ownRead(receipt(store,2100));assert.equal(partial.keys.length,2000);assert.deepEqual(partial.keys,expected);assert.equal(partial.clearEvents,false);assert.equal(partial.partial,true);incoming(store,2202);const later=ownRead(receipt(store,2202));assert.equal(later.keys.length,1,'covered2000 entries must release capacity, while untracked overflow remains conservative');assert.equal(later.clearEvents,true);}finally{store.clear();}
});
test('tracked own-read keys are capped at20000 total independently of20-room message cache',()=>{
 const rows=Array.from({length:12},(_,n)=>row(String(123+n))),store=createReaderStore({chatDatas:rows},own);try{for(let room=0;room<11;room++)for(let n=101;n<=2100;n++)incoming(store,n,String(123+room));let total=0;for(let room=0;room<10;room++){const read=ownRead(receipt(store,2100,{chatId:String(123+room)}));assert.equal(read.keys.length,2000);total+=read.keys.length;}const overflow=ownRead(receipt(store,2100,{chatId:'133'}));assert.equal(overflow.keys.length,0);assert.equal(overflow.partial,true);assert.equal(total,20000);incoming(store,2101,'133');assert.equal(ownRead(receipt(store,2101,{chatId:'133'})).keys.length,1);}finally{store.clear();}
});
test('session close discards own-read state and suppresses all late push publications',async()=>{
 const f=await pipeline();try{f.push(101);f.read(101);f.sessions[0].close();const before=f.events.length;f.read(102);f.push(102);assert.equal(f.events.length,before);assert.equal(f.reader.rooms().rooms[0].unreadLocalCount,0);}finally{f.close();}
});
