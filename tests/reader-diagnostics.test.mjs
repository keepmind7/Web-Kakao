import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { schemaShape,safeFault,safeMethod } from '../experiments/local-web/reader-diagnostics.mjs';
import { guardReaderClient } from '../experiments/local-web/reader-protocol.mjs';
import { createReaderStore } from '../experiments/local-web/reader-data.mjs';

test('diagnostics contain structural metadata only, including for unknown field names and error stacks',()=>{
  const body={chatDatas:[{c:'9007199254740993',k:['FAKE_PRIVATE_PERSON'],l:{msg:'FAKE_PRIVATE_MESSAGE',logId:'9007199254740995'}}],FAKE_PRIVATE_FIELD:'FAKE_PRIVATE_TOKEN','246810':'FAKE_PRIVATE_ACCOUNT'};
  const encoded=JSON.stringify(schemaShape(body));
  for(const value of ['FAKE_PRIVATE','9007199254740993','9007199254740995','246810'])assert.equal(encoded.includes(value),false);
  assert.equal(schemaShape(body).fields.chatDatas.count,1);assert.equal(schemaShape(body).unknownFieldCount,2);
  const fault=safeFault({name:'RangeError',message:'FAKE_PRIVATE_TOKEN',stack:'RangeError FAKE_PRIVATE_MESSAGE\n at onData (C:/PRIVATE_ACCOUNT/forge-protocol.ts:1)'});
  assert.deepEqual(fault,{category:'RangeError',frames:['onData']});assert.equal(JSON.stringify(fault).includes('PRIVATE'),false);
  assert.equal(safeMethod('FAKE_PRIVATE_METHOD'),'other');
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
  assert.equal(resolved,null);assert.equal(pushed,push);assert.equal(client.pending.has(7),true);
  const response={packetId:7,method:'SYNCMSG',status:0,body:{chatLogs:[]}};client.finishPacket(response);
  assert.equal(resolved,response);assert.equal(client.pending.size,0);
});
test('method fallback still resolves the correct response and write operations remain blocked',async()=>{
  const Guarded=guardReaderClient(Client),client=new Guarded();let resolved;
  client.pending.set(7,{method:'SYNCMSG',timer:null,resolve:packet=>{resolved=packet;}});
  client.finishPacket({packetId:99,method:'SYNCMSG',status:0,body:{}});assert.equal(resolved.packetId,99);
  await assert.rejects(client.request('WRITE',{}));await assert.rejects(client.request('NOTIREAD',{}));
  assert.equal((await client.request('SYNCMSG',{})).status,0);
});
