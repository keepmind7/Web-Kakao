// Correlation is exercised with SDK-shaped synchronous pending registration.
// No account, sockets, real messages or timers are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { guardReaderClient } from '../experiments/local-web/reader-protocol.mjs';
import { createReaderSession } from '../experiments/local-web/reader-session.mjs';
import { createReaderStore } from '../experiments/local-web/reader-data.mjs';

class SyntheticClient extends EventEmitter{
  constructor(){super();this.pending=new Map();this.sent=[];this.sequence=0;}
  request(method,body){const packetId=++this.sequence;this.sent.push({packetId,method,body});return new Promise(resolve=>this.pending.set(packetId,{method,resolve,timer:null}));}
}
const make=()=>new (guardReaderClient(SyntheticClient,null,{messaging:true}))();
const ack=(packetId,body)=>({packetId,method:'WRITE',status:0,body});
const begin=(client,chatId='123',msgId='101')=>({promise:client.request('WRITE',{chatId,msgId,msg:'synthetic'}),packetId:client.sent.at(-1).packetId});

test('exact packet ID plus method wins and a colliding MSG push cannot acknowledge WRITE',async()=>{
  const client=make(),write=begin(client);let pushes=0;client.on('push',()=>pushes++);
  client.finishPacket({packetId:write.packetId,method:'MSG',status:0,body:{chatId:'123'}});assert.equal(client.pending.size,1);assert.equal(pushes,1);
  const response=ack(write.packetId,{chatId:'123',msgId:'101',logId:'1001'});client.finishPacket(response);assert.equal((await write.promise).body.logId,'1001');assert.equal(client.pending.size,0);
});

for(const nextRoom of ['123','456'])test('completed WRITE replay cannot settle the next '+(nextRoom==='123'?'same-room':'different-room')+' send',async()=>{
  const client=make(),first=begin(client),old=ack(first.packetId,{chatId:'123',msgId:'101',logId:'1001'});client.finishPacket(old);await first.promise;
  const next=begin(client,nextRoom,'102');
  for(const response of [old,ack(900,{chatId:'123',msgId:'101',logId:'1001'}),ack(next.packetId,{chatId:'123',msgId:'101',logId:'1001'}),ack(901,{chatId:nextRoom,logId:'1002'})]){client.finishPacket(response);assert.equal(client.pending.has(next.packetId),true);}
  client.finishPacket(ack(next.packetId,{chatId:nextRoom,msgId:'102',logId:'1002'}));assert.equal((await next.promise).body.logId,'1002');
});

test('WRITE method fallback needs a unique matching msgId, never room alone',async()=>{
  const client=make(),one=begin(client,'123','201'),two=begin(client,'123','202');
  client.finishPacket(ack(800,{chatId:'123',logId:'1000'}));assert.equal(client.pending.size,2);
  client.finishPacket(ack(801,{chatId:'123',msgId:'202',logId:'1002'}));assert.equal((await two.promise).body.msgId,'202');assert.equal(client.pending.has(one.packetId),true);
  client.finishPacket(ack(802,{chatId:'123',msgId:'201',logId:'1001'}));await one.promise;
});

test('reviewer reproducer: fallback response ID equal to the next request ID cannot poison its valid exact ACK',async()=>{
  const client=make();
  const one=client.request('WRITE',{chatId:'123',msgId:'101'});
  client.finishPacket({packetId:2,method:'WRITE',status:0,body:{chatId:'123',msgId:'101',logId:'201'}});
  assert.equal(client.pending.has(1),false);await one;
  const two=client.request('WRITE',{chatId:'123',msgId:'102'});
  client.finishPacket({packetId:2,method:'WRITE',status:0,body:{chatId:'123',msgId:'102',logId:'202'}});
  assert.equal(client.pending.has(2),false,'independently identified next request must complete');
  assert.equal((await two).body.logId,'202');
});

test('constant response ID completes sequential writes while every old ACK replay remains rejected',async()=>{
  const client=make(),completed=[];let pushed=0;client.on('push',()=>pushed++);
  for(let i=1;i<=6;i++){
    const request=begin(client,'123',String(100+i));
    for(const old of completed){
      const replay=[old,ack(request.packetId,old.body),ack(request.packetId,{logId:old.body.logId}),ack(request.packetId,{chatId:'123',msgId:String(100+i),logId:old.body.logId})];
      for(const packet of replay){client.finishPacket(packet);assert.equal(client.pending.has(request.packetId),true,'old response must leave the new request pending');}
    }
    const current=ack(900,{chatId:'123',msgId:String(100+i),logId:String(200+i)});
    client.finishPacket(current);assert.equal(client.pending.has(request.packetId),false);assert.equal((await request.promise).body.logId,String(200+i));completed.push(current);
  }
  assert.equal(client.sent.length,6);assert.equal(pushed,0);assert.equal(client.pending.size,0);
});

test('a weak exact ACK cannot poison a later strong fallback reusing that response number',async()=>{
  const client=make(),weak=begin(client,'123','101');client.finishPacket(ack(weak.packetId,{}));assert.equal(client.pending.has(weak.packetId),false);await weak.promise;
  const strong=begin(client,'123','102');client.finishPacket(ack(weak.packetId,{chatId:'123',msgId:'102',logId:'202'}));
  assert.equal(client.pending.has(strong.packetId),false);assert.equal((await strong.promise).body.logId,'202');
});

test('anonymous ACK history stays rejected but does not block a new strongly identified exact ACK',async()=>{
  const client=make(),one=begin(client);client.finishPacket(ack(2,{chatId:'123',msgId:'101',logId:'201'}));await one.promise;
  const two=begin(client,'123','102');client.finishPacket(ack(two.packetId,{}));assert.equal(client.pending.has(two.packetId),true,'packet-only duplicate remains ambiguous');
  client.finishPacket(ack(two.packetId,{chatId:'123',msgId:'102',logId:'202'}));assert.equal(client.pending.has(two.packetId),false);await two.promise;
});

test('a new exact log-only ACK survives packet number overlap and old log-only replay is still blocked',async()=>{
  const client=make(),one=begin(client);client.finishPacket(ack(2,{chatId:'123',msgId:'101',logId:'201'}));await one.promise;
  const two=begin(client,'123','102');client.finishPacket(ack(two.packetId,{logId:'201'}));assert.equal(client.pending.has(two.packetId),true);
  client.finishPacket(ack(two.packetId,{logId:'202'}));assert.equal(client.pending.has(two.packetId),false);assert.equal((await two.promise).body.logId,'202');
});

test('roomless log ACK identity is scoped by its correlated request room, not globally or by missing-room text',async()=>{
  const client=make(),one=begin(client,'123','101');client.finishPacket(ack(one.packetId,{logId:'201'}));await one.promise;
  const other=begin(client,'456','102');client.finishPacket(ack(other.packetId,{logId:'201'}));assert.equal(client.pending.has(other.packetId),false,'same log value in another known room has separate scope');await other.promise;
  const again=begin(client,'123','103');client.finishPacket(ack(again.packetId,{logId:'201'}));assert.equal(client.pending.has(again.packetId),true,'old log in the original room stays blocked');
  client.finishPacket(ack(again.packetId,{logId:'203'}));assert.equal(client.pending.has(again.packetId),false);await again.promise;
});

test('ambiguous duplicate msgId fallback remains pending until an exact packet correlates',async()=>{
  const client=make(),one=begin(client,'123','301'),two=begin(client,'123','301');
  client.finishPacket(ack(800,{chatId:'123',msgId:'301',logId:'1001'}));assert.equal(client.pending.size,2);
  client.finishPacket(ack(one.packetId,{chatId:'123',logId:'1001'}));await one.promise;
  client.finishPacket(ack(two.packetId,{chatId:'123',logId:'1002'}));await two.promise;
});

test('provided room/msgId conflicts in top-level and nested log cannot be overridden by packet ID',async()=>{
  const invalid=[{chatId:'456',msgId:'401'},{chatId:'123',c:'456',msgId:'401'},{chatId:'123',msgId:'999'},{chatId:'123',msgId:'401',chatLog:{chatId:'456',logId:'1001'}},{chatId:'123',msgId:'401',chatLog:{msgId:'999',logId:'1001'}},{chatId:'123',msgId:Number.MAX_SAFE_INTEGER+2}];
  for(const body of invalid){const client=make(),write=begin(client,'123','401');client.finishPacket(ack(write.packetId,body));assert.equal(client.pending.has(write.packetId),true);client.finishPacket(ack(write.packetId,{chatId:'123',msgId:'401',logId:'1001'}));await write.promise;}
});

test('read method fallback survives and an unrelated WRITE never resolves a pending read',async()=>{
  const client=make(),read=client.request('SYNCMSG',{chatId:'123'}),id=client.sent.at(-1).packetId;
  client.finishPacket(ack(id,{chatId:'123',msgId:'501',logId:'1001'}));assert.equal(client.pending.has(id),true);
  client.finishPacket({packetId:900,method:'SYNCMSG',status:0,body:{chatLogs:[]}});assert.deepEqual((await read).body.chatLogs,[]);
});

test('completed response fingerprints remain bounded across many unique successful sends',async()=>{
  const client=make();for(let i=0;i<800;i++){const request=begin(client,'123',String(i+1));client.finishPacket(ack(request.packetId,{chatId:'123',msgId:String(i+1),logId:String(i+1000)}));await request.promise;}
  assert.ok(client.completedWrites.size<=2048);assert.equal(client.pending.size,0);
});

function sessionFixture(reply){
  const calls=[],events=[];
  const carriage=Object.assign(new EventEmitter(),{async connect(){},disconnect(){},stopPing(){},async loginList(){return {status:0,body:{chatDatas:[{c:'123',t:'DirectChat',ll:'3'}]}};},async request(method,body){calls.push({method,body});return {status:0,body:reply(body)};}});
  const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};}});
  const session=createReaderSession({userId:'999',accessToken:'SYNTHETIC',deviceUUID:'SYNTHETIC'},{messaging:true,booking:bootstrap,ticket:bootstrap,carriage:()=>carriage,toLong:String,resolve:async host=>host,every:()=>0},event=>events.push(event));
  return {session,calls,events};
}

for(const [name,reply] of [
  ['no valid log',body=>({msgId:body.msgId})],
  ['unsafe log ID',body=>({msgId:body.msgId,logId:Number.MAX_SAFE_INTEGER+2})],
  ['wrong room',body=>({msgId:body.msgId,chatId:'456',logId:'1001'})],
  ['nested room conflict',body=>({msgId:body.msgId,chatId:'123',chatLog:{chatId:'456',logId:'1001'}})],
  ['wrong msgId',body=>({msgId:body.msgId+1,chatId:'123',logId:'1001'})],
])test('session status 0 with '+name+' is unknown, never accepted or invented as a sent message',async()=>{
  const f=sessionFixture(reply);try{await f.session.start();const key=f.events[0].rooms[0].key;assert.equal(await f.session.action(key,1,'send',{text:'synthetic'}),true);const result=f.events.find(event=>event.type==='reader-action');assert.equal(result.phase,'unknown');assert.equal(result.messageKey,undefined);assert.equal(f.events.some(event=>event.source==='sent'),false);assert.equal(f.calls.filter(call=>call.method==='WRITE').length,1);}finally{f.session.close();}
});

test('sequential same-room writes freeze different msgIds and preserve both valid ACK texts',async()=>{
  let id=40;const f=sessionFixture(body=>({msgId:body.msgId,chatId:'123',logId:String(++id)}));
  try{await f.session.start();const key=f.events[0].rooms[0].key;await f.session.action(key,1,'send',{text:'synthetic A'});await f.session.action(key,2,'send',{text:'synthetic B'});const writes=f.calls.filter(call=>call.method==='WRITE');assert.equal(writes.length,2);assert.notEqual(writes[0].body.msgId,writes[1].body.msgId);assert.deepEqual(f.events.filter(event=>event.type==='reader-action').map(event=>event.phase),['accepted','accepted']);assert.deepEqual(f.events.filter(event=>event.source==='sent' && event.type==='reader-messages').at(-1).messages.map(message=>message.text),['synthetic A','synthetic B']);}finally{f.session.close();}
});

test('writeAccepted checks all provided room aliases without mutating foreign-room data',()=>{
  const store=createReaderStore({chatDatas:[{c:'123',t:'DirectChat'}]},'999'),key=store.rooms()[0].key;
  for(const body of [{logId:'1',c:'456'},{logId:'1',chatId:'123',roomId:'456'},{chatId:'123',chatLog:{logId:'1',c:'456'}}])assert.equal(store.writeAccepted(key,body,'synthetic'),null);
  assert.equal(store.current(key).messages.length,0);assert.ok(store.writeAccepted(key,{chatId:'123',logId:'1'},'synthetic'));
});
