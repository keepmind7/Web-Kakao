import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { schemaShape,safeFault,safeMethod,createReaderDiagnostic } from '../experiments/local-web/reader-diagnostics.mjs';
import { guardReaderClient } from '../experiments/local-web/reader-protocol.mjs';
import { createReaderStore } from '../experiments/local-web/reader-data.mjs';
import { responseStatus } from '../experiments/local-web/reader-response.mjs';

test('diagnostics contain structural metadata only, including for unknown field names and error stacks',()=>{
  const body={chatDatas:[{c:'9007199254740993',k:['FAKE_PRIVATE_PERSON'],l:{msg:'FAKE_PRIVATE_MESSAGE',logId:'9007199254740995'}}],FAKE_PRIVATE_FIELD:'FAKE_PRIVATE_TOKEN','246810':'FAKE_PRIVATE_ACCOUNT'};
  const encoded=JSON.stringify(schemaShape(body));
  for(const value of ['FAKE_PRIVATE','9007199254740993','9007199254740995','246810'])assert.equal(encoded.includes(value),false);
  assert.equal(schemaShape(body).fields.chatDatas.count,1);assert.equal(schemaShape(body).unknownFieldCount,2);
  const fault=safeFault({name:'RangeError',message:'FAKE_PRIVATE_TOKEN',stack:'RangeError FAKE_PRIVATE_MESSAGE\n at onData (C:/PRIVATE_ACCOUNT/forge-protocol.ts:1)'});
  assert.deepEqual(fault,{category:'RangeError',frames:['onData']});assert.equal(JSON.stringify(fault).includes('PRIVATE'),false);
  assert.equal(safeMethod('FAKE_PRIVATE_METHOD'),'other');
});
test('read acknowledgement counts survive the rolling log without retaining message or room identifiers',()=>{
  let snapshot;
  const diagnostic=createReaderDiagnostic({writeSnapshot:value=>{snapshot=JSON.parse(value);}});
  for(const body of [{status:0},{status:-203},{status:'invalid'}]){
    diagnostic.note('request',{method:'NOTIREAD'});
    diagnostic.packet('response',{method:'NOTIREAD',status:0,body:{...body,chatId:'9007199254740993',msg:'FAKE_PRIVATE_TEXT'}});
  }
  for(let i=0;i<45;i++)diagnostic.note('request',{method:'PING'});
  assert.equal(snapshot.events.length,40);
  assert.deepEqual(snapshot.readSync,{requests:3,responses:3,accepted:1,rejected:1,unknown:1});
  for(const value of ['9007199254740993','FAKE_PRIVATE_TEXT'])assert.equal(JSON.stringify(snapshot).includes(value),false);
});
test('compact LOGINLIST nickname arrays label rooms without network queries',()=>{
  const store=createReaderStore({chatDatas:[{c:'9007199254740993',k:['예시 이름 A','예시 이름 B'],i:['111','222']}]},'333');
  assert.equal(store.rooms()[0].title,'예시 이름 A, 예시 이름 B');assert.equal(store.rooms()[0].titleKnown,true);
});
class Client extends EventEmitter {
  constructor(){super();this.pending=new Map();}
  async request(method){return {method,status:0,body:{}};}
}
test('MSG with a colliding packet ID cannot resolve a pending SYNCMSG request',()=>{
  const Guarded=guardReaderClient(Client),client=new Guarded();let resolved=null,pushed=null;
  client.pending.set(7,{method:'SYNCMSG',timer:null,resolve:packet=>{resolved=packet;}});client.on('push',packet=>{pushed=packet;});
  const push={packetId:7,method:'MSG',status:0,body:{}};client.finishPacket(push);
  assert.equal(resolved,null);assert.deepEqual(pushed,push);assert.equal(client.pending.has(7),true);
  const response={packetId:7,method:'SYNCMSG',status:0,body:{chatLogs:[]}};client.finishPacket(response);
  assert.equal(resolved,response);assert.equal(client.pending.size,0);
});
test('body rejection overrides a successful header without mutating wire evidence',async()=>{
  const packet={method:'SYNCMSG',status:0,body:{status:-203}};
  class BodyClient extends Client {async request(){return packet;}}
  const Guarded=guardReaderClient(BodyClient);assert.equal((await new Guarded().request('SYNCMSG',{})).status,-203);assert.equal(packet.status,0);
  assert.equal(responseStatus({status:-997,body:{status:0}}),-997);
  assert.equal(responseStatus({status:0,body:{status:'bad'}}),null);
});
test('LOGINLIST history bounds stay private and push advances them without inventing values',()=>{
  const raw='900719925474099399',store=createReaderStore({chatDatas:[{c:'123',ll:raw,k:['예시']} ]},'456');
  const key=store.rooms()[0].key;assert.equal(store.historyEnd(key),raw);assert.equal(JSON.stringify(store.rooms()).includes(raw),false);
  store.push({chatId:'123',chatLog:{logId:'900719925474099400',msg:'예시'}});assert.equal(store.historyEnd(key),'900719925474099400');
});
test('method fallback still resolves the correct response and write operations remain blocked',async()=>{
  const Guarded=guardReaderClient(Client),client=new Guarded();let resolved;
  client.pending.set(7,{method:'SYNCMSG',timer:null,resolve:packet=>{resolved=packet;}});
  client.finishPacket({packetId:99,method:'SYNCMSG',status:0,body:{}});assert.equal(resolved.packetId,99);
  await assert.rejects(client.request('WRITE',{}));await assert.rejects(client.request('NOTIREAD',{}));
  assert.equal((await client.request('SYNCMSG',{})).status,0);
});
