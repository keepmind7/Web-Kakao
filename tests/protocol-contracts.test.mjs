// Independent contract checks. Every transport, credential, message and image
// is synthetic; no sockets, child processes, official app or real account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createReaderSession } from '../experiments/local-web/reader-session.mjs';
import { createReaderStore } from '../experiments/local-web/reader-data.mjs';
import { createReadOnlyReader } from '../experiments/local-web/reader-manager.mjs';
import { guardReaderClient } from '../experiments/local-web/reader-protocol.mjs';
import { uploadPhoto } from '../experiments/local-web/media-upload.mjs';

const { BSON,Long }=createRequire(new URL('../local-only/spikes/modern/package.json',import.meta.url))('bson');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const toLong=value=>Long.fromString(String(value));
const credential={userId:'999',accessToken:'SYNTHETIC_ONLY',deviceUUID:'SYNTHETIC_ONLY'};
const turn=()=>new Promise(setImmediate);

function sessionFixture({entryRoom='123',readProbe=false,diagnosticStatus=0}={}){
  const calls=[],events=[];
  const carriage=Object.assign(new EventEmitter(),{
    async connect(){},disconnect(){},stopPing(){},
    async loginList(){return {status:0,body:{chatDatas:[{c:'123',t:'DirectChat',title:'Synthetic room',ll:'3'}]}};},
    async request(method,body){
      calls.push({method,body});
      if(method==='CHATONROOM')return {method,status:0,body:{c:entryRoom}}; // Deliberately no receipt members.
      if(method==='CHATINFO')return {method,status:diagnosticStatus,body:{status:diagnosticStatus,chatInfo:{chatId:'123',lastSeenLogId:'3'}}};
      return {method,status:0,body:{}};
    },
  });
  const bootstrap=()=>Object.assign(new EventEmitter(),{
    async connect(){},disconnect(){},
    async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},
    async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};},
  });
  const session=createReaderSession(credential,{messaging:true,readProbe,booking:bootstrap,ticket:bootstrap,carriage:()=>carriage,toLong,resolve:async host=>host,every:()=>0},event=>events.push(event));
  return {session,calls,events,carriage,async ready(){
    assert.equal((await session.start()).ok,true);
    const key=events.find(event=>event.source==='loginlist').rooms[0].key;
    carriage.emit('push',{method:'MSG',status:0,body:{chatId:'123',chatLog:{logId:'3',authorId:'111',type:1,msg:'Synthetic incoming'}}});
    const message=events.findLast(event=>event.type==='reader-messages').messages.at(-1).key;
    return {key,message};
  }};
}

test('direct read establishes matching entry before NOTIREAD despite an incomplete receipt snapshot',async()=>{
  const f=sessionFixture();
  try{
    const {key,message}=await f.ready();
    assert.equal(await f.session.action(key,1,'read',{message}),true);
    assert.deepEqual(f.calls.map(call=>call.method),['CHATONROOM','NOTIREAD']);
    const entry=f.calls[0].body;
    assert.equal(String(entry.chatId),'123');assert.equal(String(entry.token),'0');
    assert.ok(entry.opt===undefined || Number.isInteger(entry.opt),'optional opt must be absent or an Integer');
    assert.equal(f.events.findLast(event=>event.type==='reader-action').phase,'accepted');
  }finally{f.session.close();}
});

test('supplemental CHATINFO rejection does not prevent eligible reading or end the session',async()=>{
  const f=sessionFixture({readProbe:true,diagnosticStatus:-203});
  try{
    const {key,message}=await f.ready();
    await f.session.action(key,1,'read',{message});
    assert.equal(f.calls.filter(call=>call.method==='NOTIREAD').length,1);
    assert.equal(f.events.findLast(event=>event.type==='reader-action').phase,'accepted');
    assert.equal(f.events.some(event=>event.type==='reader-failed'),false);
  }finally{f.session.close();}
});

test('foreign CHATONROOM identity cannot authorize any NOTIREAD',async()=>{
  const f=sessionFixture({entryRoom:'456'});
  try{
    const {key,message}=await f.ready();await f.session.action(key,1,'read',{message});
    assert.equal(f.calls.filter(call=>call.method==='NOTIREAD').length,0);
    assert.notEqual(f.events.findLast(event=>event.type==='reader-action')?.phase,'accepted');
  }finally{f.session.close();}
});

class PendingClient extends EventEmitter{
  constructor(){super();this.pending=new Map();this.sent=[];this.sequence=0;}
  request(method,body){const packetId=++this.sequence;this.sent.push({packetId,method,body});return new Promise(resolve=>this.pending.set(packetId,{method,resolve,timer:null}));}
}
const guarded=()=>new (guardReaderClient(PendingClient,null,{messaging:true}))();
function resolvePending(client){for(const [packetId,item] of client.pending){client.pending.delete(packetId);item.resolve({packetId,method:item.method,status:0,body:{}});}}

test('CHATONROOM and CHATINFO exact replies must match every supplied room alias',async()=>{
  for(const method of ['CHATONROOM','CHATINFO'])for(const body of [
    {c:'456'},
    {chatId:'123',c:'456'},
    {c:'123',chatInfo:{chatId:'456'}},
  ]){
    const client=guarded(),waiting=client.request(method,{chatId:toLong('123')}),packetId=client.sent[0].packetId;
    try{
      client.finishPacket({packetId,method,status:0,body});
      assert.equal(client.pending.has(packetId),true,method+' accepted a foreign or contradictory room');
      client.finishPacket({packetId,method,status:0,body:{c:'123'}});await waiting;
    }finally{resolvePending(client);await waiting;}
  }
});

test('method fallback requires independent room identity and a unique matching entry request',async()=>{
  const client=guarded(),one=client.request('CHATONROOM',{chatId:toLong('123')}),two=client.request('CHATONROOM',{chatId:toLong('456')});
  try{
    client.finishPacket({packetId:900,method:'CHATONROOM',status:0,body:{}});
    assert.equal(client.pending.size,2,'roomless fallback must remain pending');
    client.finishPacket({packetId:901,method:'CHATONROOM',status:0,body:{c:'456'}});
    assert.equal(client.pending.has(1),true);assert.equal(client.pending.has(2),false);await two;
    client.finishPacket({packetId:1,method:'CHATONROOM',status:0,body:{}});await one;
  }finally{resolvePending(client);await Promise.all([one,two]);}
});

test('early and wrong-room CHATONROOM cannot settle a later room entry',async()=>{
  const client=guarded();
  client.finishPacket({packetId:900,method:'CHATONROOM',status:0,body:{c:'456'}});
  const waiting=client.request('CHATONROOM',{chatId:toLong('123')});
  try{
    client.finishPacket({packetId:901,method:'CHATONROOM',status:0,body:{c:'456'}});
    assert.equal(client.pending.has(1),true);
    client.finishPacket({packetId:1,method:'CHATONROOM',status:0,body:{c:'123'}});await waiting;
  }finally{resolvePending(client);await waiting;}
});

function photoFixture({body={chatLog:{logId:'777',chatId:'123',authorId:'999',type:2,msgId:'345'}},offset=0,early=false}={}){
  const calls=[],bytes=[];let media;
  const complete=()=>media.emit('push',{method:'COMPLETE',status:0,body:{status:0,...body}});
  const options={
    carriage:{async request(method,body){calls.push({method,body});return {status:0,body:{k:'SYNTHETIC_UPLOAD',vh:'upload.kakao.com',p:443}};}},
    createClient(){media=Object.assign(new EventEmitter(),{
      async connect(){},disconnect(){},
      async request(method,body){calls.push({method,body});if(early)complete();return {status:0,body:{o:offset}};},
      async writeEncrypted(data){bytes.push(Buffer.from(data));if(Buffer.concat(bytes).length===png.length-offset)complete();},
    });return media;},
    toLong,chatId:'123',userId:'999',messageId:'345',data:png,profile:{os:'android',appVersion:'26.1.2'},resolve:async()=> '192.0.2.1',
  };
  return {options,calls,bytes};
}

test('photo SHIP/POST sizes are BSON Long and plain-photo POST ex is an empty object string',async()=>{
  const f=photoFixture();assert.equal((await uploadPhoto(f.options)).phase,'accepted');
  for(const method of ['SHIP','POST']){
    const body=f.calls.find(call=>call.method===method).body;
    assert.equal(Long.isLong(body.s),true,method+'.s must preserve its wire type');
    const wire=BSON.deserialize(BSON.serialize(body),{promoteLongs:false});
    assert.equal(Long.isLong(wire.s),true);assert.equal(wire.s.toString(),String(png.length));
  }
  assert.equal(f.calls.find(call=>call.method==='POST').body.ex,'{}');
  assert.deepEqual(f.calls.map(call=>call.method),['SHIP','POST']);
});

test('unidentified or contradictory COMPLETE remains unknown without WRITE or automatic resend',async()=>{
  const base={logId:'777',chatId:'123',authorId:'999',type:2,msgId:'345'};
  for(const [name,body] of [
    ['missing room',{chatLog:{logId:'777',authorId:'999',type:2}}],
    ['foreign room',{chatLog:{...base,chatId:'456'}}],
    ['contradictory outer room',{c:'456',chatLog:base}],
    ['foreign author',{chatLog:{...base,authorId:'111'}}],
    ['contradictory outer author',{userId:'111',chatLog:base}],
    ['wrong type',{chatLog:{...base,type:1}}],
    ['wrong client msgId',{chatLog:{...base,msgId:'346'}}],
    ['wrong client mid',{mid:'346',chatLog:base}],
  ]){
    const f=photoFixture({body});assert.equal((await uploadPhoto(f.options)).phase,'unknown',name);
    await turn();assert.deepEqual(f.calls.map(call=>call.method),['SHIP','POST'],name+' must never trigger another send');
  }
});

test('early COMPLETE at full resume accepts matching identity with a distinct server logId',async()=>{
  const f=photoFixture({offset:png.length,early:true});
  const outcome=await uploadPhoto(f.options);
  assert.equal(outcome.phase,'accepted');assert.equal(outcome.chatLog.logId,'777');assert.notEqual(outcome.chatLog.logId,f.options.messageId);
  assert.equal(f.bytes.length,0);assert.deepEqual(f.calls.map(call=>call.method),['SHIP','POST']);
});

test('writeAccepted rejects supplied foreign authors and contradictory types before adding defaults',()=>{
  const store=createReaderStore({chatDatas:[{c:'123',t:'DirectChat',title:'Synthetic'}]},'999'),key=store.rooms()[0].key;
  for(const body of [
    {chatId:'123',logId:'777',authorId:'111',type:2},
    {chatId:'123',chatLog:{logId:'777',authorId:'999',senderId:'111',type:2}},
    {chatId:'123',chatLog:{logId:'777',authorId:'999',type:1}},
    {chatId:'123',type:1,chatLog:{logId:'777',authorId:'999',type:2}},
  ])assert.equal(store.writeAccepted(key,body,'[사진]',{type:2}),null);
  assert.equal(store.current(key).messages.length,0);
  assert.ok(store.writeAccepted(key,{chatId:'123',chatLog:{logId:'778',authorId:'999',type:2}},'[사진]',{type:2}));
});

test('OD/OM are recognized without initial action permission and unknown kinds remain disabled',()=>{
  const store=createReaderStore({chatDatas:[
    {c:'123',t:'OD',li:'700',title:'Synthetic open direct'},
    {c:'124',t:'OM',li:'701',title:'Synthetic open multi'},
    {c:'125',t:'UNRECOGNIZED',li:'702',title:'Synthetic unknown',canSend:true},
  ]},'999');
  const rooms=store.rooms();assert.deepEqual(rooms.map(room=>room.kind),['OpenDirectChat','OpenMultiChat','unknown']);
  for(const room of rooms){
    for(const action of ['canText','canReply','canPhoto','canRead','canContext','canSend'])assert.equal(room[action],false,room.kind+' '+action);
    for(const field of ['li','linkId','rawType','token','ltk','olu'])assert.equal(Object.hasOwn(room,field),false);
  }
});

test('manager enforces per-action capability instead of reusing the canSend text alias',()=>{
  const key='r_'+'a'.repeat(24),message='m_'+'b'.repeat(24),sent=[];
  const child=Object.assign(new EventEmitter(),{send(value,callback){sent.push(value);callback?.();},kill(){}});
  const reader=createReadOnlyReader({messaging:true,spawn:()=>child});
  try{
    assert.equal(reader.connect(credential),true);child.emit('message',{type:'reader-ready'});
    child.emit('message',{type:'reader-rooms',source:'loginlist',rooms:[{key,title:'Synthetic',kind:'OpenMultiChat',canSend:true,canText:true,canReply:false,canPhoto:false,canRead:false,canContext:false}]});
    child.emit('message',{type:'reader-messages',key,source:'push',latestVisible:true,messages:[{key:message,text:'Synthetic incoming',canReply:true}],arrivals:[]});
    assert.equal(reader.sendPhoto(key,png.toString('base64'),'12345678-1234-4123-8123-123456789abc'),false);
    assert.equal(reader.openRoom(key),false);
    assert.equal(reader.seen(key,reader.messages(key).seenToken,true),false);
    assert.equal(reader.sendText(key,'Synthetic reply','22345678-1234-4123-8123-123456789abc',message),false);
    assert.equal(sent.filter(row=>row.type==='reader-action').length,0);
    assert.equal(reader.sendText(key,'Synthetic text','32345678-1234-4123-8123-123456789abc'),true);
    assert.equal(sent.filter(row=>row.type==='reader-action').length,1);
  }finally{reader.close();}
});
