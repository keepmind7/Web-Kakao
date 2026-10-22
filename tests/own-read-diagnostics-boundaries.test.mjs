// Account-free boundaries: injected pending clients, session transports and child IPC only.
// This file does not fork a worker, open a socket, read private settings or start a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import {guardReaderClient} from '../experiments/local-web/reader-protocol.mjs';
import {createReaderSession} from '../experiments/local-web/reader-session.mjs';
import {createReaderStore} from '../experiments/local-web/reader-data.mjs';
import {createReadOnlyReader} from '../experiments/local-web/reader-manager.mjs';

const helperURL=new URL('../experiments/local-web/reader-own-read-diagnostics.mjs',import.meta.url);
const loadHelper=()=>import(helperURL.href);
const workerFiles=['reader-own-read-diagnostics.mjs','reader-worker.mjs','reader-protocol.mjs','reader-session.mjs','reader-data.mjs','reader-diagnostics.mjs'];
const managerFiles=['reader-own-read-diagnostics.mjs','reader-manager.mjs','reader-room-state.mjs'];
const credential={userId:'999',deviceUUID:'SYNTHETIC_DEVICE',accessToken:'SYNTHETIC_NO_ACCOUNT'};
const room='r_'+'a'.repeat(24),message=n=>'m_'+BigInt(n).toString(16).padStart(24,'0');
const selfRead=(watermark='101',extra={})=>({method:'DECUNREAD',status:0,body:{chatId:'123',userId:'999',watermark,...extra}});

class PendingClient extends EventEmitter{
  constructor(){super();this.pending=new Map();this.sent=[];this.sequence=0;}
  request(method,body){const packetId=++this.sequence;this.sent.push({packetId,method,body});return new Promise((resolve,reject)=>this.pending.set(packetId,{method,resolve,reject,timer:null}));}
}
function settle(client){for(const [packetId,item] of client.pending){clearTimeout(item.timer);client.pending.delete(packetId);item.resolve({packetId,method:item.method,status:0,body:{}});}}
async function guarded(observe){
  const {createOwnReadDiagnostics}=await loadHelper(),diagnostic=createOwnReadDiagnostics();
  const sink={note(){},packet(){},ownRead:observe ?? ((...args)=>diagnostic.record(...args))};
  const client=new (guardReaderClient(PendingClient,sink,{messaging:true}))();
  return {client,diagnostic,sink};
}

test('guard counts collision forwarding, matched response and scoped drops without changing requests',async()=>{
  const {client,diagnostic}=await guarded(),pushed=[];client.on('push',packet=>pushed.push(packet));
  const history=client.request('SYNCMSG',{});
  try{
    client.finishPacket({...selfRead(),packetId:1});
    assert.equal(client.pending.has(1),true,'colliding receipt must not resolve history');
    assert.equal(pushed.length,1);
    client.finishPacket({packetId:1,method:'SYNCMSG',status:0,body:{chatLogs:[]}});await history;
    const info=client.request('CHATINFO',{chatId:'123'});
    client.finishPacket({packetId:2,method:'CHATINFO',status:0,body:{c:'456'}});
    assert.equal(client.pending.has(2),true);
    client.finishPacket({packetId:2,method:'CHATINFO',status:0,body:{c:'123'}});await info;
    client.finishPacket({packetId:700,method:'CHATINFO',status:0,body:{c:'123'}});
    const transport=diagnostic.snapshot().counters.transport;
    assert.equal(transport.DECUNREAD.received,1);assert.equal(transport.DECUNREAD.forwarded,1);
    assert.equal(transport.CHATINFO.received,3);assert.equal(transport.CHATINFO.matched,1);assert.equal(transport.CHATINFO.scoped_drop,2);
    assert.equal(transport.other.matched,1);assert.equal(pushed.length,1);
    assert.deepEqual(client.sent.map(item=>item.method),['SYNCMSG','CHATINFO']);
  }finally{settle(client);await history;}
});

test('an actual optional timeout quarantines its late response instead of forwarding room state',async t=>{
  const {client,diagnostic}=await guarded();let pushed=0;client.on('push',()=>pushed++);
  t.mock.timers.enable({apis:['setTimeout']});
  try{
    const waiting=client.request('CHATINFO',{chatId:'123'},25,{optional:true});
    const rejected=assert.rejects(waiting,{code:'READER_REQUEST_TIMEOUT'});
    t.mock.timers.tick(26);await rejected;
    client.finishPacket({packetId:1,method:'CHATINFO',status:0,body:{c:'123'}});
    assert.equal(client.pending.size,0);assert.equal(pushed,0);
    const counts=diagnostic.snapshot().counters.transport.CHATINFO;
    assert.equal(counts.received,1);assert.equal(counts.quarantined,1);assert.equal(counts.forwarded,0);
    assert.equal(client.sent.length,1);
  }finally{settle(client);t.mock.timers.reset();}
});

test('guard duplicate disposition preserves a later pending synthetic write until independent identity matches',async()=>{
  const {client,diagnostic}=await guarded();
  const ack=(packetId,msgId,logId)=>({packetId,method:'WRITE',status:0,body:{chatId:'123',msgId,logId}});
  try{
    const first=client.request('WRITE',{chatId:'123',msgId:'11'});client.finishPacket(ack(1,'11','1001'));await first;
    const next=client.request('WRITE',{chatId:'123',msgId:'12'});client.finishPacket(ack(2,'12','1001'));
    assert.equal(client.pending.has(2),true);assert.equal(diagnostic.snapshot().counters.transport.other.duplicate_drop,1);
    client.finishPacket(ack(2,'12','1002'));await next;
    assert.equal(client.pending.size,0);assert.equal(client.sent.length,2);
  }finally{settle(client);}
});

for(const mode of ['throwing-method','throwing-getter'])test('guard diagnostic '+mode+' cannot swallow a matched response or a receipt push',async()=>{
  const sink={note(){},packet(){}};
  if(mode==='throwing-method')sink.ownRead=()=>{throw Error('SYNTHETIC_OBSERVER_FAILURE');};
  else Object.defineProperty(sink,'ownRead',{get(){throw Error('SYNTHETIC_OBSERVER_FAILURE');}});
  const client=new (guardReaderClient(PendingClient,sink,{messaging:true}))();let pushed=0;client.on('push',()=>pushed++);
  try{
    const waiting=client.request('SYNCMSG',{});
    client.finishPacket({...selfRead(),packetId:1});assert.equal(pushed,1);assert.equal(client.pending.size,1);
    client.finishPacket({packetId:1,method:'SYNCMSG',status:0,body:{chatLogs:[]}});await waiting;
    assert.equal(client.pending.size,0);assert.equal(client.sent.length,1);
  }finally{settle(client);}
});

async function sessionFixture({messaging=true,early=[],observeOwnRead,observerGetter=false}={}){
  const events=[],observations=[],calls=[];
  const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};}});
  const carriage=Object.assign(new EventEmitter(),{async connect(){},disconnect(){},stopPing(){},async loginList(){for(const packet of early)this.emit('push',packet);return {status:0,body:{chatDatas:[{c:'123',t:'DirectChat',title:'Synthetic room',ll:'100',n:3}]}};},async request(method){calls.push(method);assert.fail('receipt fixture unexpectedly requested '+method);}});
  const factory={messaging,booking:bootstrap,ticket:bootstrap,carriage:()=>carriage,toLong:String,resolve:async host=>host,every:()=>0,
    observeOwnRead(...args){observations.push(args);observeOwnRead?.(...args);}};
  if(observerGetter)Object.defineProperty(factory,'observeOwnRead',{get(){throw Error('SYNTHETIC_OBSERVER_GETTER');}});
  const session=createReaderSession(credential,factory,event=>events.push(event));
  assert.deepEqual(await session.start(),{ok:true});
  return {session,events,observations,calls,carriage,push:packet=>carriage.emit('push',packet)};
}
const observed=(f,stage,reason)=>f.observations.filter(args=>args[0]===stage&&args[1]===reason).length;

test('session independently classifies self, peer, malformed and stale receipts using fixed callback arguments',async()=>{
  const f=await sessionFixture();try{
    f.push(selfRead());f.push(selfRead('102',{userId:'111'}));f.push(selfRead('-1'));f.push(selfRead());
    assert.equal(observed(f,'session','supported'),4);
    for(const reason of ['own_accepted','peer_accepted','invalid_position','stale_own'])assert.equal(observed(f,'classification',reason),1,reason);
    assert.equal(observed(f,'handoff','emitted'),1);
    assert.equal(f.events.filter(event=>event.type==='reader-own-read').length,1);
    assert.equal(f.events.filter(event=>event.type==='reader-messages'&&event.source==='receipt').length,1);
    for(const args of f.observations){assert.equal(args.length,2);assert.equal(typeof args[0],'string');assert.equal(typeof args[1],'string');}
    assert.equal(f.events.some(event=>event.type==='reader-failed'),false);assert.deepEqual(f.calls,[]);
    for(const value of ['123','999','111','101','SYNTHETIC'])assert.equal(JSON.stringify(f.observations).includes(value),false);
  }finally{f.session.close();}
});

test('pre-announcement self read is deferred then recomputed and flushed after a newer arrival',async()=>{
  const newer={method:'MSG',status:0,body:{chatId:'123',chatLog:{logId:'102',authorId:'111',type:1,msg:'Synthetic arrival'}}};
  const f=await sessionFixture({early:[selfRead('101'),newer]});try{
    assert.equal(observed(f,'handoff','deferred'),1);assert.equal(observed(f,'handoff','flushed'),1);
    const announcement=f.events.findIndex(event=>event.type==='reader-rooms'&&event.source==='loginlist');
    const handoff=f.events.findIndex(event=>event.type==='reader-own-read');
    assert.ok(announcement>=0&&handoff>announcement);
    assert.equal(f.events[handoff].read.clearInitial,true);assert.equal(f.events[handoff].read.clearEvents,false);
    assert.deepEqual(f.events[handoff].read.keys,[]);assert.deepEqual(f.calls,[]);
    const before=f.observations.length;f.session.close();f.push(selfRead('103'));assert.equal(f.observations.length,before);
  }finally{f.session.close();}
});

test('session distinguishes unsupported state pushes and a disabled DECUNREAD from accepted self reads',async()=>{
  const enabled=await sessionFixture(),disabled=await sessionFixture({messaging:false});
  try{
    for(const method of ['CHATINFO','UPDATECHAT','BLSYNC'])enabled.push({method,status:0,body:{chatId:'123'}});
    disabled.push(selfRead());
    assert.equal(observed(enabled,'session','unsupported'),3);assert.equal(observed(disabled,'session','disabled'),1);
    assert.equal(observed(enabled,'classification','own_accepted'),0);assert.equal(observed(disabled,'classification','own_accepted'),0);
    assert.equal(enabled.events.some(event=>event.type==='reader-own-read'),false);assert.equal(disabled.events.some(event=>event.type==='reader-own-read'),false);
    assert.deepEqual(enabled.calls,[]);assert.deepEqual(disabled.calls,[]);
  }finally{enabled.session.close();disabled.session.close();}
});

test('rejected DECUNREAD status remains a session failure and is observed without classification or handoff',async()=>{
  const f=await sessionFixture();try{
    f.push({...selfRead(),status:-203});
    assert.equal(observed(f,'session','status_rejected'),1);
    assert.ok(f.events.some(event=>event.type==='reader-failed'&&event.stage==='push'&&event.status===-203));
    assert.equal(f.observations.some(args=>args[0]==='classification'||args[0]==='handoff'),false);
    assert.deepEqual(f.calls,[]);
  }finally{f.session.close();}
});

for(const mode of ['throwing-method','throwing-getter'])test('session '+mode+' observer preserves receipt delivery and store getter isolation',async()=>{
  const f=await sessionFixture({observeOwnRead(){throw Error('SYNTHETIC_OBSERVER_FAILURE');},observerGetter:mode==='throwing-getter'});
  const options=mode==='throwing-getter'?Object.defineProperty({},'observeOwnRead',{get(){throw Error('SYNTHETIC_OBSERVER_GETTER');}}):{observeOwnRead(){throw Error('SYNTHETIC_OBSERVER_FAILURE');}};
  let store;try{
    f.push(selfRead());assert.equal(f.events.filter(event=>event.type==='reader-own-read').length,1);assert.equal(f.events.some(event=>event.type==='reader-failed'),false);
    store=createReaderStore({chatDatas:[{c:'123',t:'DirectChat',ll:'100'}]},'999',Buffer.alloc(32,4),null,options);
    assert.ok(store.readUpdate(selfRead().body)?.ownRead);
  }finally{store?.clear();f.session.close();}
});

test('worker and manager fingerprints contain only fixed basenames and actual public-file SHA-256 values',async()=>{
  const {createOwnReadDiagnostics}=await loadHelper();
  for(const [component,files] of [['worker',workerFiles],['manager',managerFiles]]){
    const diagnostic=createOwnReadDiagnostics({component}),first=diagnostic.snapshot(),source=structuredClone(first.source);
    assert.deepEqual(Object.keys(source).sort(),['capturedAt','files','loadedCodeAttested']);assert.equal(source.loadedCodeAttested,false);
    assert.deepEqual(Object.keys(source.files).sort(),[...files].sort());
    assert.ok((typeof source.capturedAt==='number'&&Number.isFinite(source.capturedAt))||(typeof source.capturedAt==='string'&&Number.isFinite(Date.parse(source.capturedAt))));
    for(const file of files)assert.equal(source.files[file],createHash('sha256').update(readFileSync(new URL(file,helperURL))).digest('hex'),file);
    diagnostic.record('classification','own_accepted');
    first.counters.classification.own_accepted=999;first.source.files[files[0]]='SYNTHETIC_PRIVATE_PATH';
    assert.deepEqual(diagnostic.snapshot().source,source);assert.equal(diagnostic.snapshot().counters.classification.own_accepted,1);
    diagnostic.reset();assert.deepEqual(diagnostic.snapshot().source,source);assert.equal(diagnostic.snapshot().counters.classification.own_accepted,0);
  }
});

// Run the real helper algorithm in a VM. Only ESM linkage/import.meta are adapted;
// counter code is unchanged, and every source read is a fixed public-code stub.
function helperVM({limit=3,failReads=false}={}){
  const code=readFileSync(helperURL,'utf8'),reads=[];let bytes='synthetic public source v1';
  function VMNumber(value){return Number(value);}Object.setPrototypeOf(VMNumber,Number);Object.defineProperty(VMNumber,'MAX_SAFE_INTEGER',{value:limit});
  const fs={readFileSync(target){
    const url=target instanceof URL?target:pathToFileURL(String(target)),name=basename(fileURLToPath(url));
    assert.ok(workerFiles.includes(name)||managerFiles.includes(name),'source reads must remain within the fixed public list');
    assert.equal(url.href,new URL(name,helperURL).href,'source reads must use this project code directory');reads.push(name);
    if(failReads)throw Error('SYNTHETIC_PRIVATE_PATH');return Buffer.from(bytes);
  }};
  const imports={'node:fs':fs,'node:crypto':{createHash},'node:path':{basename,dirname,join,resolve},'node:url':{fileURLToPath,pathToFileURL}};
  const linked=code.replace(/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?\s*$/gm,(_,bindings,specifier)=>{
    assert.ok(Object.hasOwn(imports,specifier),'VM imports must stay in the explicit builtin allowlist');
    return 'const {'+bindings.replace(/\bas\b/g,':')+'}=__imports['+JSON.stringify(specifier)+'];';
  }).replace(/\bimport\.meta\.url\b/g,'__moduleURL').replace(/\bexport\s+(?=(?:const|let|function|class)\b)/g,'');
  const api=runInNewContext(linked+'\n;({createOwnReadDiagnostics,OWN_READ_DIAGNOSTIC_VERSION});',{__imports:imports,__moduleURL:helperURL.href,Number:VMNumber,URL,Buffer,structuredClone},{filename:'synthetic-own-read-helper.vm.mjs',timeout:1000});
  return {api,reads,setBytes:value=>{bytes=value;}};
}

test('the actual helper saturates every counter family at an injected small safe-integer limit',()=>{
  const {api}=helperVM(),diagnostic=api.createOwnReadDiagnostics();assert.equal(api.OWN_READ_DIAGNOSTIC_VERSION,1);
  for(let n=0;n<11;n++){
    diagnostic.record('transport','received','DECUNREAD');diagnostic.record('transport','forwarded','SYNTHETIC_PRIVATE_METHOD');
    diagnostic.record('classification','own_accepted');diagnostic.record('session','supported');diagnostic.record('handoff','emitted');diagnostic.record('apply','received');
  }
  const counts=diagnostic.snapshot().counters;
  assert.equal(counts.transport.DECUNREAD.received,3);assert.equal(counts.transport.other.forwarded,3);
  assert.equal(counts.classification.own_accepted,3);assert.equal(counts.session.supported,3);assert.equal(counts.handoff.emitted,3);assert.equal(counts.apply.received,3);
  assert.equal(counts.transport.CHATINFO.received,0);assert.equal(JSON.stringify(counts).includes('SYNTHETIC_PRIVATE'),false);
  diagnostic.reset();assert.equal(diagnostic.snapshot().counters.apply.received,0);
});

test('helper fingerprints are captured once and source-read failures retain null without exception details',()=>{
  const good=helperVM(),diagnostic=good.api.createOwnReadDiagnostics(),source=JSON.stringify(diagnostic.snapshot().source),reads=good.reads.length;
  assert.equal(reads,workerFiles.length);good.setBytes('synthetic public source v2');
  diagnostic.record('transport','received','DECUNREAD');diagnostic.snapshot();diagnostic.reset();
  assert.equal(JSON.stringify(diagnostic.snapshot().source),source);assert.equal(good.reads.length,reads);
  const broken=helperVM({failReads:true}),snapshot=broken.api.createOwnReadDiagnostics({component:'manager'}).snapshot();
  assert.deepEqual(Object.keys(snapshot.source.files).sort(),[...managerFiles].sort());
  assert.ok(Object.values(snapshot.source.files).every(value=>value===null));assert.equal(JSON.stringify(snapshot).includes('SYNTHETIC_PRIVATE'),false);
});

function managerFixture(){
  const children=[],sent=[],profile={key:()=>Buffer.alloc(32,5),snapshot:()=>({persist:false,readSync:false,notifications:false,roomFilter:'all',storageAvailable:true}),room:()=>null,close(){}};
  const reader=createReadOnlyReader({messaging:true,preferenceStore:{account:()=>profile},spawn:()=>{const child=Object.assign(new EventEmitter(),{send(value,callback){sent.push(value);callback?.();},kill(){return true;}});children.push(child);return child;}});
  const publish=()=>children.at(-1).emit('message',{type:'reader-rooms',source:'loginlist',rooms:[{key:room,title:'Synthetic room',kind:'DirectChat',initialUnreadCount:3}],seedBounds:[{key:room,bound:'100'}],stats:{sourceRoomCount:1}});
  const connect=()=>{assert.equal(reader.connect(credential),true);publish();};connect();
  const emit=(watermark,child=children.at(-1))=>child.emit('message',{type:'reader-own-read',key:room,read:{keys:[],clearInitial:true,clearEvents:true,partial:false},proof:{watermark}});
  return {reader,children,sent,publish,connect,emit};
}

test('manager rejects old-worker observations and close ends counters without crossing its bound account',()=>{
  const f=managerFixture();try{
    f.emit('100');const old=f.children[0];assert.equal(f.reader.snapshot().ownReadDiagnostics.counters.apply.decreased,1);
    f.reader.disconnect();
    const disconnected=f.reader.snapshot(),childCount=f.children.length,sentCount=f.sent.length;
    assert.equal(disconnected.phase,'disconnected','foreign account attempt must reach an otherwise reconnectable phase');
    assert.equal(f.reader.connect({...credential,userId:'888'}),false);
    const refused=f.reader.snapshot();
    assert.equal(f.children.length,childCount);assert.equal(f.sent.length,sentCount);
    assert.deepEqual(refused.ownReadDiagnostics,disconnected.ownReadDiagnostics);
    for(const field of ['phase','revision','roomsRevision','settingsRevision','outboxRevision','attempts'])assert.equal(refused[field],disconnected[field],field);
    f.connect();assert.equal(f.children.length,childCount+1);assert.equal(f.reader.snapshot().phase,'connected');
    const before=f.reader.snapshot();f.emit('200',old);
    const after=f.reader.snapshot();assert.equal(after.roomsRevision,before.roomsRevision);assert.equal(after.revision,before.revision);
    assert.deepEqual(after.ownReadDiagnostics.counters,before.ownReadDiagnostics.counters);
    assert.equal(f.reader.connect({...credential,userId:'888'}),false);
    const clone=f.reader.snapshot().ownReadDiagnostics;clone.counters.apply.received=999;clone.source.files.injected='SYNTHETIC_PRIVATE_PATH';
    assert.deepEqual(f.reader.snapshot().ownReadDiagnostics.counters,before.ownReadDiagnostics.counters);
    f.reader.close();const closed=f.reader.snapshot();f.emit('201');
    assert.deepEqual(f.reader.snapshot().ownReadDiagnostics,closed.ownReadDiagnostics);
    assert.ok(Object.values(closed.ownReadDiagnostics.counters.apply).every(value=>value===0));
    assert.equal(f.reader.connect({...credential,userId:'888'}),false);
    assert.equal(JSON.stringify(f.reader.snapshot().ownReadDiagnostics).includes('SYNTHETIC_PRIVATE'),false);
  }finally{f.reader.close();}
});

test('manager diagnostic-only duplicate and stale observations preserve a later incoming count and all business revisions',()=>{
  const f=managerFixture();try{
    f.emit('100');
    f.children.at(-1).emit('message',{type:'reader-messages',source:'push',key:room,latestVisible:true,messages:[{key:message(102),text:'Synthetic arrival',mine:false}],arrivals:[{key:message(102),incoming:true,afterBaseline:true,userMessage:true}],arrivalProof:[{key:message(102),position:'102'}]});
    const before=f.reader.snapshot(),page=f.reader.messages(room),outbox=f.reader.outbox();f.emit('100');f.emit('99');
    const after=f.reader.snapshot();
    for(const key of ['revision','roomsRevision','settingsRevision','outboxRevision','sendRequests'])assert.equal(after[key],before[key],key);
    assert.deepEqual(after.pageRevisions,before.pageRevisions);assert.deepEqual(f.reader.messages(room),page);assert.deepEqual(f.reader.outbox(),outbox);
    assert.equal(f.reader.rooms().rooms[0].unreadLocalCount,1);
    assert.equal(after.ownReadDiagnostics.counters.apply.stale_position,before.ownReadDiagnostics.counters.apply.stale_position+2);
    assert.equal(after.ownReadDiagnostics.counters.apply.decreased,before.ownReadDiagnostics.counters.apply.decreased);
    assert.equal(f.sent.some(row=>row.type==='reader-action'),false);
  }finally{f.reader.close();}
});
