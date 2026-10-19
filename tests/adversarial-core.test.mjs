// Independent adversarial contracts: synthetic memory and new loopback peers.
// Never reads the running server, credentials, real media or personal profiles.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {EventEmitter,once} from 'node:events';
import {createRequire} from 'node:module';
import {createReaderSession} from '../experiments/local-web/reader-session.mjs';
import {createReadOnlyReader} from '../experiments/local-web/reader-manager.mjs';
import {createReaderStore} from '../experiments/local-web/reader-data.mjs';
import {createPreferenceStore} from '../experiments/local-web/preferences.mjs';
import {guardReaderClient} from '../experiments/local-web/reader-protocol.mjs';
import {createReaderDiagnostic} from '../experiments/local-web/reader-diagnostics.mjs';
import {createPhotoCache,fetchPhoto} from '../experiments/local-web/photos.mjs';
import {safeDestination} from '../experiments/local-web/room-probe.mjs';

process.env.KAKAO_DEBUG_LOCO='0';
await import('../local-only/spikes/modern/node_modules/tsx/dist/loader.mjs');
const {CarriageClient,toLong}=await import('../local-only/spikes/modern/src/kakao/forge-protocol.ts');
const {BSON}=createRequire(new URL('../local-only/spikes/modern/package.json',import.meta.url))('bson');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const end=Date.now()+2000;while(!check()){if(Date.now()>end)throw new Error('synthetic wait deadline');await sleep(2);}}
const credential={userId:'999',deviceUUID:'SYNTHETIC',accessToken:'SYNTHETIC_NO_ACCOUNT'};
const roomKey=n=>'r_'+n.toString(16).padStart(24,'0'),messageKey=n=>'m_'+n.toString(16).padStart(24,'0');
const uuid=n=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const rows=(count=23)=>Array.from({length:count},(_,n)=>({c:String(1000+n),t:'DirectChat',a:2,title:'Synthetic '+n,ll:'100'}));
const pub=n=>({key:roomKey(n),title:'Synthetic '+n,kind:'DirectChat',canSend:true,canText:true,canPhoto:true,canReply:true,canRead:true,canContext:true});
const log=(id,n)=>({chatId:String(id),logId:String(n),authorId:'111',type:1,msg:'Synthetic '+n});
const timeout=()=>Object.assign(new Error('synthetic recoverable timeout'),{code:'READER_REQUEST_TIMEOUT'});

function packet(id,method,body){const data=BSON.serialize(body),head=Buffer.alloc(22);head.writeInt32LE(id);head.write(method,6,11,'ascii');head.writeInt32LE(data.length,18);return Buffer.concat([head,data]);}
async function peer(t,{media=false}={}){
  const client=new (guardReaderClient(CarriageClient,null,{messaging:true,media}))(),sockets=new Set(),requests=[],errors=[];
  let current,connections=0,handler=()=>{};client.on('error',()=>{});
  const server=net.createServer(socket=>{current=socket;connections++;sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));let buffer=Buffer.alloc(0),handshake=false;
    socket.on('data',chunk=>{try{buffer=Buffer.concat([buffer,chunk]);if(!handshake){if(buffer.length<12)return;const size=buffer.readUInt32LE(0);if(buffer.length<size+12)return;buffer=buffer.subarray(size+12);handshake=true;}
      while(buffer.length>=4){const length=buffer.readUInt32LE(0);if(buffer.length<length+4)return;const raw=client.crypto.decrypt(buffer.subarray(0,length+4));buffer=buffer.subarray(length+4);const item={packetId:raw.readInt32LE(0),method:raw.subarray(6,17).toString('ascii').replace(/\0.*$/,''),body:BSON.deserialize(raw.subarray(22))};requests.push(item);handler(item);}
    }catch(error){errors.push(error);socket.destroy();}});
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  const f={client,requests,errors,get connections(){return connections;},set handler(value){handler=value;},reply(item,body){if(current&&!current.destroyed)current.write(client.crypto.encrypt(packet(item.packetId,item.method,{status:0,...body})));},breakTransport(){current?.destroy();},
    async close(){client.disconnect();await Promise.all([...sockets].map(socket=>new Promise(resolve=>{socket.once('close',resolve);socket.destroy();})));await new Promise(resolve=>server.close(resolve));assert.equal(server.listening,false);assert.equal(sockets.size,0);assert.equal(client.pending.size,0);t.diagnostic(JSON.stringify({cleanup:{sockets:sockets.size,pending:client.pending.size,connections}}));}};
  try{await client.connect('127.0.0.1',server.address().port,1000);return f;}catch(error){await f.close();throw error;}
}

for(const method of ['CHATONROOM','NOTIREAD','SHIP','PING'])test('real SDK recoverable '+method+' expiry preserves socket and quarantines late response',async t=>{
  const f=await peer(t);let next;
  try{
    const error=await f.client.request(method,{chatId:toLong('123')},25,{recoverable:true}).then(()=>null,error=>error);
    assert.equal(f.client.socket.destroyed,false,'one timed out operation must not destroy the SDK socket');
    assert.equal(error?.code,'READER_REQUEST_TIMEOUT','recoverable policy must report a typed local expiry');
    f.handler=item=>{if(item.method==='PING' && method!=='PING')f.reply(item,{alive:true});};
    if(method!=='PING')assert.equal((await f.client.request('PING',{},300)).body.alive,true);
    let settled=false;next=f.client.request(method,{chatId:toLong('123')},400,{recoverable:true});next.then(()=>{settled=true;},()=>{settled=true;});
    await until(()=>f.requests.filter(item=>item.method===method).length===2);
    f.reply(f.requests[0],{c:'123',marker:'expired'});await sleep(15);assert.equal(settled,false,'expired request cannot resolve a newer same-method request');
    f.reply(f.requests.at(-1),{c:'123',marker:'fresh'});assert.equal((await next).body.marker,'fresh');
    if(method==='PING'){f.handler=item=>f.reply(item,{alive:true});assert.equal((await f.client.request('PING',{},300)).body.alive,true);}
    assert.equal(f.connections,1);assert.deepEqual(f.errors,[]);
  }finally{await f.close();await next?.catch(()=>{});}
});

for(const method of ['WRITE','POST'])test('recoverable policy is forbidden for uncertain '+method+' before wire',async t=>{
  const f=await peer(t,{media:method==='POST'});try{await assert.rejects(f.client.request(method,{},25,{recoverable:true}));assert.equal(f.requests.length,0,'forbidden soft timeout policy must not send');}finally{await f.close();}
});
test('ordinary required timeout and actual transport failure retain destructive behavior',async t=>{
  const f=await peer(t);try{await assert.rejects(f.client.request('CHATINFO',{chatId:toLong('123')},25));assert.equal(f.client.socket.destroyed,true);}finally{await f.close();}
  const g=await peer(t);try{const request=g.client.request('PING',{},500,{recoverable:true});await until(()=>g.requests.length===1);g.breakTransport();await assert.rejects(request);await until(()=>g.client.socket.destroyed);assert.equal(g.client.pending.size,0);}finally{await g.close();}
});
test('existing optional metadata soft expiry remains separate from restricted recoverable actions',async t=>{
  const f=await peer(t);try{await assert.rejects(f.client.request('CHATINFO',{chatId:toLong('123')},25,{optional:true}));assert.equal(f.client.socket.destroyed,false);f.handler=item=>f.reply(item,{alive:true});assert.equal((await f.client.request('PING',{},300)).body.alive,true);assert.equal(f.connections,1);}finally{await f.close();}
});

function sessionFixture({source=rows(1),reply,earlyPush=false}={}){
  const f={events:[],calls:[],closed:0,heartbeat:null};
  f.carriage=Object.assign(new EventEmitter(),{async connect(){},disconnect(){f.closed++;},stopPing(){},async loginList(){if(earlyPush)this.emit('push',{method:'MSG',status:0,body:{chatId:'1000',chatLog:log('1000',101)}});return {status:0,body:{chatDatas:source}};},async request(method,body,ms,policy){f.calls.push({method,body,ms,policy});const custom=reply?.(method,body,ms,policy);if(custom!==undefined)return custom;
    if(method==='CHATONROOM')return {status:0,body:{c:String(body.chatId),mi:['999','111'],a:['111'],w:['0']}};
    if(method==='SYNCMSG')return {status:0,body:{isOK:true,chatLogs:Array.from({length:40},(_,i)=>log(String(body.chatId),i+1))}};
    if(method==='WRITE')return {status:0,body:{chatId:String(body.chatId),msgId:body.msgId,chatLog:{...log(String(body.chatId),102),authorId:'999',msg:body.msg}}};
    return {status:0,body:{}};}});
  const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};}});
  f.session=createReaderSession(credential,{messaging:true,photoTransport:'loco',booking:bootstrap,ticket:bootstrap,carriage:()=>f.carriage,media:()=>{throw new Error('no media expected');},toLong,resolve:async host=>host,every:callback=>{f.heartbeat=callback;return 0;},delay:async()=>{}},event=>f.events.push(event));
  f.start=async()=>{assert.equal((await f.session.start()).ok,true);return f.events.find(event=>event.type==='reader-rooms'&&event.source==='loginlist').rooms.map(row=>row.key);};return f;
}
for(const [action,method] of [['context','CHATONROOM'],['read','NOTIREAD'],['photo','SHIP']])test('session '+method+' single recoverable expiry leaves subsequent explicit action usable',async()=>{
  let expired=false;const f=sessionFixture({reply:name=>{if(name===method&&!expired){expired=true;throw timeout();}}});
  try{const [key]=await f.start();f.carriage.emit('push',{method:'MSG',status:0,body:{chatId:'1000',chatLog:log('1000',101)}});const message=f.events.findLast(event=>event.type==='reader-messages').messages.at(-1).key;
    await f.session.action(key,1,action,action==='read'?{message}:action==='photo'?{image:png.toString('base64')}:{});
    const outcome=f.events.findLast(event=>event.type==='reader-action');assert.equal(outcome.phase,action==='read'?'unknown':'failed');assert.equal(f.events.some(event=>event.type==='reader-failed'),false);assert.equal(f.closed,0);
    assert.equal(f.calls.find(call=>call.method===method).policy?.recoverable,true);assert.equal(f.calls.filter(call=>call.method===method).length,1,'no automatic retry');
    assert.equal(await f.session.action(key,2,'send',{text:'Synthetic next'}),true);assert.equal(f.events.findLast(event=>event.type==='reader-action').phase,'accepted');
  }finally{f.session.close();}
});
test('heartbeat allows two recoverable misses resets on success and closes after three consecutive misses',async()=>{
  let miss=true;const f=sessionFixture({reply:method=>{if(method==='PING'){if(miss)throw timeout();return {status:0,body:{}};}}});
  try{await f.start();await f.heartbeat();await f.heartbeat();assert.equal(f.closed,0,'first two soft misses preserve connection');miss=false;await f.heartbeat();miss=true;await f.heartbeat();await f.heartbeat();assert.equal(f.closed,0,'success resets consecutive misses');await f.heartbeat();assert.ok(f.closed>0);assert.equal(f.events.filter(event=>event.type==='reader-failed').length,1);assert.ok(f.calls.filter(call=>call.method==='PING').every(call=>call.policy?.recoverable===true));}finally{f.session.close();}
});
test('initial push in loginList callback is replayed exactly once after store listeners are ready',async()=>{
  const f=sessionFixture({earlyPush:true});try{await f.start();const messages=f.events.filter(event=>event.type==='reader-messages').flatMap(event=>event.messages);assert.equal(messages.filter(row=>row.text==='Synthetic 101').length,1,'initial push must not disappear between login response and listener setup');}finally{f.session.close();}
});

test('worker selected room retains 40 old bodies through 21 other rooms and one new push',async()=>{
  const f=sessionFixture({source:rows()});try{const keys=await f.start();await f.session.history(keys[0],1);f.session.view?.(keys[0]);for(let n=1;n<keys.length;n++)f.carriage.emit('push',{method:'MSG',status:0,body:{chatId:String(1000+n),chatLog:log(1000+n,101)}});f.carriage.emit('push',{method:'MSG',status:0,body:{chatId:'1000',chatLog:log('1000',101)}});const page=f.events.findLast(event=>event.type==='reader-messages'&&event.key===keys[0]);assert.equal(page.messages.length,41,'foreground room bodies must survive unrelated push LRU churn');}finally{f.session.close();}
});
test('preference key is derived once at room creation and remains stable during repeated room lists',()=>{
  const secret=Buffer.alloc(32,7),store=createReaderStore({chatDatas:rows(2)},'999',Buffer.alloc(32,3),secret);const initial=store.rooms().map(row=>row.preferenceKey);secret.fill(8);for(let n=0;n<10;n++)assert.deepEqual(store.rooms().map(row=>row.preferenceKey),initial,'room list rendering must not rederive HMAC preference identities');store.clear();
});
test('context revision changes only for real receipt permission changes rather than messages or active selection',()=>{
  const store=createReaderStore({chatDatas:rows(2)},'999'),key=store.rooms()[0].key;try{const before=store.rooms()[0].contextRevision;assert.ok(Number.isSafeInteger(before),'room must expose its receipt permission generation');store.recent(key);store.recent(store.rooms()[1].key);store.push({chatId:'1000',chatLog:log('1000',101)});assert.equal(store.rooms().find(row=>row.key===key).contextRevision,before);store.invalidateReceipts({c:'1000'});assert.ok(store.rooms().find(row=>row.key===key).contextRevision>before);}finally{store.clear();}
});

function managerFixture(){const children=[],sent=[];const reader=createReadOnlyReader({messaging:true,preferenceStore:createPreferenceStore(),spawn:()=>{const child=Object.assign(new EventEmitter(),{send(value,cb){sent.push(value);cb?.();},kill(){return true;}});children.push(child);return child;}});const f={reader,sent,children,get child(){return children.at(-1);},connect(rooms=[pub(1)]){assert.equal(reader.connect(credential),true);f.child.emit('message',{type:'reader-ready'});f.child.emit('message',{type:'reader-rooms',source:'loginlist',rooms,stats:{sourceRoomCount:rooms.length}});},page(n,messages,source='push'){f.child.emit('message',{type:'reader-messages',key:roomKey(n),source,messages,latestVisible:true});},finish(phase='accepted'){const request=sent.at(-1);f.child.emit('message',{type:'reader-action',key:request.key,requestId:request.requestId,action:request.action,phase,status:0,messageKey:messageKey(100)});}};return f;}
test('manager pin protects selected 40-message room from unrelated LRU eviction',()=>{
  const f=managerFixture();try{f.connect(Array.from({length:23},(_,n)=>pub(n+1)));f.page(1,Array.from({length:40},(_,i)=>({key:messageKey(i+1),text:'Synthetic '+i,mine:false})));f.reader.view?.(roomKey(1));for(let n=2;n<=23;n++)f.page(n,[{key:messageKey(1),text:'Synthetic other',mine:false}]);f.page(1,[...f.reader.messages(roomKey(1)).messages,{key:messageKey(41),text:'Synthetic new',mine:false}]);assert.equal(f.reader.messages(roomKey(1)).messages.length,41,'manager must retain selected room while other pages churn');}finally{f.reader.close();}
});
test('unresolved outbox remains discoverable after reconnect with room absent and can be explicitly acknowledged',()=>{
  const f=managerFixture();try{f.connect();assert.equal(f.reader.sendText(roomKey(1),'Synthetic uncertain',uuid(1)),true);f.reader.disconnect();f.connect([]);const unresolved=f.reader.outbox?.();assert.ok(Array.isArray(unresolved),'outbox discovery must work independently of room membership');assert.equal(unresolved.length,1);assert.equal(unresolved[0].phase,'unknown');assert.equal(unresolved[0].clientId,uuid(1));assert.equal(JSON.stringify(unresolved).includes('Synthetic uncertain'),false);assert.equal(f.reader.acknowledgeOutbox?.(uuid(1)),true);assert.deepEqual(f.reader.outbox(),[]);assert.equal(f.reader.outbox(uuid(1)).phase,'unknown');assert.equal(f.sent.filter(row=>row.action==='send').length,1);}finally{f.reader.close();}
});
test('outbox pending send cannot be explicitly acknowledged',()=>{
  const f=managerFixture();try{f.connect();assert.equal(f.reader.sendText(roomKey(1),'Synthetic scoped',uuid(1)),true);assert.equal(f.reader.acknowledgeOutbox?.(uuid(1)),false,'pending send must not be acknowledged');}finally{f.reader.close();}
});
test('retained outbox and profile cannot cross into a different account on the same manager',()=>{
  const f=managerFixture();try{f.connect();assert.equal(f.reader.sendText(roomKey(1),'Synthetic scoped',uuid(1)),true);f.reader.disconnect();assert.equal(f.reader.connect({...credential,userId:'998'}),false,'one manager cannot migrate retained requests/profile into another account');assert.equal(f.children.length,1);}finally{f.reader.close();}
});
test('1000 settled outbox results can retire without blocking new sends and retain bounded dedupe',()=>{
  const f=managerFixture();try{f.connect();for(let n=1;n<=1001;n++){assert.equal(f.reader.sendText(roomKey(1),'Synthetic '+n,uuid(n)),true,'settled entries must yield capacity at request '+n);f.finish();}const count=f.sent.length;assert.equal(f.reader.sendText(roomKey(1),'Synthetic 1',uuid(1)),true,'recent retired exact request must dedupe');assert.equal(f.sent.length,count);assert.equal(f.reader.sendText(roomKey(1),'Synthetic changed',uuid(1)),false,'retired ID with changed payload must be refused');assert.equal(f.reader.snapshot().sendRequests,1001);assert.equal(f.reader.snapshot().sendAccepted,1001);}finally{f.reader.close();}
});
test('receipt changes increment page generation without refreshing room list or settings generations',()=>{
  const f=managerFixture();try{f.connect();f.page(1,[{key:messageKey(1),text:'Synthetic',mine:true,unreadCount:2}]);const before=f.reader.snapshot();f.child.emit('message',{type:'reader-messages',key:roomKey(1),source:'receipt',messages:[{key:messageKey(1),text:'Synthetic',mine:true,unreadCount:1}],latestVisible:true});const after=f.reader.snapshot();assert.ok(Number.isSafeInteger(before.roomsRevision),'separate generations must be observable');assert.equal(after.roomsRevision,before.roomsRevision);assert.equal(after.settingsRevision,before.settingsRevision);assert.equal(after.outboxRevision,before.outboxRevision);assert.ok(after.pageRevisions?.[roomKey(1)]>before.pageRevisions?.[roomKey(1)]);}finally{f.reader.close();}
});

test('photo cache retains 64 small entries while preserving 30MiB byte eviction',async()=>{
  const calls=new Map();let large=false;const cache=createPhotoCache({fetcher:async url=>{calls.set(url,(calls.get(url)||0)+1);return {data:large?Buffer.alloc(8*1024*1024):png,type:'image/png'};}});try{for(let n=0;n<64;n++)await cache.get('synthetic:'+n);await cache.get('synthetic:0');assert.equal(calls.get('synthetic:0'),1,'small gallery should not churn at the old 12-entry cap');large=true;for(let n=0;n<4;n++)await cache.get('large:'+n);await cache.get('large:0');assert.equal(calls.get('large:0'),2,'byte bound still evicts oldest large entry');}finally{cache.clear();}
});

function trickleRequest({redirect=false}={}){const live=new Set();let calls=0;return {live,get calls(){return calls;},request(_url,_options,callback){calls++;const req=new EventEmitter(),response=new EventEmitter();response.headers=redirect&&calls===1?{location:'https://synthetic.kakaocdn.net/redirected'}:{};response.statusCode=redirect&&calls===1?302:200;response.resume=()=>{};response.destroy=()=>req.destroy();let interval;req.end=()=>{queueMicrotask(()=>{callback(response);if(response.statusCode===200){interval=setInterval(()=>response.emit('data',Buffer.from([137])),5);live.add(req);}});};req.destroy=()=>{clearInterval(interval);live.delete(req);queueMicrotask(()=>req.emit('error',new Error('synthetic canceled')));};return req;},clear(){for(const req of [...live])req.destroy();}};}
test('fetchPhoto deadline includes unresolved DNS without making any request',async()=>{
  let wires=0;const outcome=await Promise.race([fetchPhoto('https://synthetic.kakaocdn.net/photo',{resolve:()=>new Promise(()=>{}),request:()=>{wires++;throw new Error('forbidden wire');},deadlineMs:25}).then(()=> 'accepted',()=> 'rejected'),sleep(120).then(()=> 'deadline ignored')]);assert.equal(wires,0);assert.equal(outcome,'rejected','DNS wait must share the total photo deadline');
});
test('four slow redirect/trickle photos release all slots at total deadline so fifth can run',async()=>{
  const fake=trickleRequest({redirect:true}),cache=createPhotoCache({fetcher:(url,{signal})=>url.endsWith('/fifth')?Promise.resolve({data:png,type:'image/png'}):fetchPhoto(url,{signal,resolve:async()=>[{address:'8.8.8.8',family:4}],request:fake.request,deadlineMs:30})});
  try{const first=Array.from({length:4},(_,n)=>cache.get('https://synthetic.kakaocdn.net/'+n).catch(()=>null));const fifth=cache.get('https://synthetic.kakaocdn.net/fifth');const outcome=await Promise.race([fifth.then(item=>item.type),sleep(200).then(()=> 'slots stuck')]);assert.equal(outcome,'image/png','the fifth request must acquire a released slot after bounded fetch failures');await Promise.all(first);assert.equal(fake.live.size,0,'deadline must destroy all active request streams');}finally{cache.clear();fake.clear();}
});
test('public destination filtering rejects IPv6 transition tunnels as well as private/documentation ranges',()=>{
  for(const address of ['2002:7f00:1::','2001:0000:4136:e378:8000:63bf:3fff:fdd2','::ffff:127.0.0.1','2001:db8::1','fc00::1'])assert.equal(safeDestination(address,443),false,address+' must not bypass destination policy');assert.equal(safeDestination('2606:4700:4700::1111',443),true);
});
test('diagnostic write bursts debounce and explicit flush preserves bounded large-upload stage history',()=>{
  const writes=[],diagnostic=createReaderDiagnostic({writeSnapshot:raw=>writes.push(JSON.parse(raw))});try{diagnostic.note('photo-upload',{stage:'ship',totalBytes:10000});for(let n=1;n<=100;n++)diagnostic.note('photo-upload',{stage:'stream',sentBytes:n*100,totalBytes:10000});diagnostic.note('photo-upload',{stage:'received_complete',status:0});assert.ok(writes.length<=1,'102 synchronous events must not trigger 102 disk snapshots');diagnostic.flush?.();assert.ok(writes.length>=1,'flush must synchronously persist pending diagnostic state');const state=writes.at(-1);assert.equal(state.events.length,40);assert.ok(state.uploadStages?.ship,'initial upload stage must survive rolling events');assert.equal(state.uploadStages?.stream?.bytes,10000);assert.equal(state.uploadStages?.stream?.frames,100);assert.equal(state.uploadStages?.stream?.count,100);assert.ok(state.uploadStages?.stream?.lastElapsedMs>=state.uploadStages?.stream?.firstElapsedMs);assert.ok(state.uploadStages?.received_complete);diagnostic.end('synthetic');assert.equal(writes.at(-1).exitReason,'synthetic');}finally{diagnostic.end('synthetic cleanup');}
});
