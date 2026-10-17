// Independent bounded-bootstrap contracts: synthetic in-memory transports only.
// Never contacts a running server, account, official app, browser or REA engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createReaderSession,allowedReaderMethod } from '../experiments/local-web/reader-session.mjs';
import { createReaderStore } from '../experiments/local-web/reader-data.mjs';
import { guardReaderClient } from '../experiments/local-web/reader-protocol.mjs';
import { safeMethod,schemaShape } from '../experiments/local-web/reader-diagnostics.mjs';

const {Long}=createRequire(new URL('../local-only/spikes/modern/package.json',import.meta.url))('bson');
const toLong=value=>Long.fromString(String(value));
const memberRoom=(c='123',li='700',extra={})=>({c,t:'OM',li,title:'Synthetic member room',...extra});
const activeLink=(li='700',extra={})=>({li,ln:'Synthetic verified link',ac:true,...extra});
const ownContext=(extra={})=>({c:'123',li:'700',olu:{userId:'999',lmt:2,opt:0,pv:'0'},mt:0,...extra});
const forbiddenAutomatic=new Set(['CHATONROOM','NOTIREAD','WRITE','SHIP','JOINLINK']);
function noAutomaticActions(calls){assert.equal(calls.some(call=>forbiddenAutomatic.has(call.method)),false,'metadata startup must issue no entry/read/send/upload/join action');}

function sessionFixture({rows=[memberRoom()],sync={status:0,body:{ltk:0,ols:[]}},info={status:0,body:{ols:[activeLink()]}},messaging=true}={}){
  const calls=[],events=[];
  const carriage=Object.assign(new EventEmitter(),{
    async connect(){},disconnect(){},stopPing(){},
    async loginList(){return {status:0,body:{chatDatas:rows}};},
    async request(method,body,timeout){
      calls.push({method,body,timeout});
      if(method==='SYNCLINK'){if(sync instanceof Error)throw sync;return sync;}
      if(method==='INFOLINK')return typeof info==='function'?info(body):info;
      if(method==='CHATONROOM')return {status:0,body:ownContext()};
      throw new Error('Unplanned synthetic request');
    },
  });
  const bootstrap=()=>Object.assign(new EventEmitter(),{
    async connect(){},disconnect(){},
    async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},
    async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};},
  });
  const session=createReaderSession({userId:'999',deviceUUID:'SYNTHETIC',accessToken:'SYNTHETIC_NO_LOGIN'},
    {messaging,booking:bootstrap,ticket:bootstrap,carriage:()=>carriage,toLong,resolve:async host=>host,every:()=>0},event=>events.push(event));
  return {session,events,calls,carriage,rooms:()=>events.findLast(event=>event.type==='reader-rooms')?.rooms ?? [],
    async start(){assert.equal((await session.start()).ok,true);return this.rooms();}};
}
function storeFixture(rows=[memberRoom()]){
  const store=createReaderStore({chatDatas:rows},'999'),key=store.rooms()[0].key;
  return {store,key};
}
function info(store,response,ids=['700'],versions=store.linkSyncSnapshot()){
  // Absence is tested by observable permission state, not a missing-method error.
  return store.infoLinks?.(response,ids,versions) ?? [];
}
const missing=(store,limit=16)=>(store.missingOpenLinkIds?.(limit) ?? []).map(String);

test('empty SYNCLINK bootstraps known missing links once with Long lis and context-only permission',async()=>{
  const f=sessionFixture();
  try{
    const rooms=await f.start(),calls=f.calls.filter(call=>call.method==='INFOLINK');
    assert.equal(calls.length,1,'missing existing link needs one metadata fallback');
    assert.equal(calls[0].body.lis.length,1);assert.equal(Long.isLong(calls[0].body.lis[0]),true);assert.equal(String(calls[0].body.lis[0]),'700');
    assert.ok(Number.isInteger(calls[0].timeout) && calls[0].timeout>0 && calls[0].timeout<=2500);
    assert.equal(rooms[0].canContext,true);for(const field of ['canText','canReply','canPhoto','canRead'])assert.equal(rooms[0][field],false,field);
    noAutomaticActions(f.calls);assert.equal(f.calls.filter(call=>call.method==='SYNCLINK').length,1);
  }finally{f.session.close();}
});

test('rejected or thrown optional SYNCLINK still permits one bounded existing-link fallback',async()=>{
  for(const sync of [{status:-203,body:{status:-203}},new Error('Synthetic metadata failure')]){
    const f=sessionFixture({sync});try{
      const rooms=await f.start();assert.equal(f.calls.filter(call=>call.method==='INFOLINK').length,1);
      assert.equal(rooms[0].canContext,true);assert.equal(rooms[0].canText,false);
      assert.equal(f.events.some(event=>event.type==='reader-failed'),false);noAutomaticActions(f.calls);
    }finally{f.session.close();}
  }
});

test('missing-link selection deduplicates existing signed64 IDs and sends at most sixteen once',async()=>{
  const rows=Array.from({length:20},(_,i)=>memberRoom(String(100+i),String(700+i)));
  rows.push(memberRoom('500','700'),{c:'501',t:'UNKNOWN',li:'900',title:'Synthetic unknown'},memberRoom('502','9223372036854775808'),memberRoom('503','901',{left:true}));
  const {store}=storeFixture(rows);
  const expected=Array.from({length:16},(_,i)=>String(700+i));
  assert.deepEqual(missing(store,100),expected,'missing IDs must be valid, unique, existing, and bounded');
  const f=sessionFixture({rows,info:{status:0,body:{ols:[]}}});try{
    await f.start();const calls=f.calls.filter(call=>call.method==='INFOLINK');assert.equal(calls.length,1);
    assert.deepEqual(calls[0].body.lis.map(String),expected);assert.ok(calls[0].body.lis.every(Long.isLong));noAutomaticActions(f.calls);
  }finally{f.session.close();}
});

test('ols-only INFOLINK enables context but requires matching own-member entry before text/photo',()=>{
  const {store,key}=storeFixture();info(store,{ols:[activeLink()]});
  assert.equal(store.canAction(key,'context'),true,'valid requested metadata must be consumed without ltk');
  assert.equal(store.canAction(key,'send'),false);assert.equal(store.canAction(key,'photo'),false);
  store.entrySnapshot(key,ownContext({olu:{userId:'111',lmt:2,opt:0}}),store.receiptVersion(key));
  assert.equal(store.canAction(key,'send'),false);assert.equal(store.canAction(key,'photo'),false);
  store.entrySnapshot(key,ownContext(),store.receiptVersion(key));
  assert.equal(store.canAction(key,'send'),true);assert.equal(store.canAction(key,'photo'),true);
  assert.equal(JSON.stringify(store.rooms()).includes('"700"'),false);
});

test('unknown, unrequested and contradictory supplied link aliases cannot create context permission',()=>{
  for(const response of [
    {ols:[activeLink('999')]},
    {ols:[activeLink('700',{linkId:'701'})]},
    {ols:[activeLink('700',{openLinkId:'999'})]},
    {ols:[activeLink('700')]},
  ]){
    const {store,key}=storeFixture(),requested=response.ols[0].li==='700' && !response.ols[0].linkId && !response.ols[0].openLinkId?['701']:['700'];
    info(store,response,requested);assert.equal(store.canAction(key,'context'),false);assert.equal(store.rooms().length,1);
  }
});

test('duplicate conflicting INFOLINK rows cannot leave permissions enabled by array order',()=>{
  for(const ols of [[activeLink(),activeLink('700',{ac:false})],[activeLink('700',{ac:false}),activeLink()]]){
    const {store,key}=storeFixture();info(store,{ols});assert.equal(store.canAction(key,'context'),false);
    assert.equal(store.canAction(key,'send'),false);assert.equal(store.canAction(key,'photo'),false);
  }
});

test('late link info cannot revive a link deleted after the request revision snapshot',()=>{
  const {store,key}=storeFixture(),versions=store.linkSyncSnapshot();
  store.linkUpdate('SYNCLINKDL',{li:'700'});info(store,{ols:[activeLink()]},['700'],versions);
  assert.equal(store.canAction(key,'context'),false);assert.equal(missing(store).includes('700'),false);
});

test('late link info cannot revive a room left or changed after its captured revision',()=>{
  for(const invalidate of [store=>store.invalidateReceipts({c:'123'},{left:true}),store=>store.linkUpdate('SYNCMEMT',{c:'123',li:'700'})]){
    const {store,key}=storeFixture(),versions=store.linkSyncSnapshot();invalidate(store);
    info(store,{ols:[activeLink()]},['700'],versions);assert.equal(store.canAction(key,'context'),false);assert.equal(store.canAction(key,'send'),false);
  }
});

test('SYNCLINK deletion with omitted ols still revokes metadata and prevents fallback',async()=>{
  const {store,key}=storeFixture();store.syncLinks({ltk:0,ols:[activeLink()]});assert.equal(store.canAction(key,'context'),true);
  store.syncLinks({ltk:1,dlis:['700']});assert.equal(store.canAction(key,'context'),false,'ols and dlis are independently optional');
  assert.equal(missing(store).includes('700'),false);
  const f=sessionFixture({sync:{status:0,body:{ltk:1,dlis:['700']}}});try{
    const rooms=await f.start();assert.equal(f.calls.filter(call=>call.method==='INFOLINK').length,0);assert.equal(rooms[0].canContext,false);noAutomaticActions(f.calls);
  }finally{f.session.close();}
});

test('known inactive, left, unknown and normal room metadata never triggers missing-link probing',async()=>{
  const rows=[memberRoom(),memberRoom('124','701',{left:true}),{c:'125',t:'UNKNOWN',li:'702',title:'Synthetic unknown'},{c:'126',t:'DirectChat',li:'703',title:'Synthetic normal'}];
  const f=sessionFixture({rows,sync:{status:0,body:{ltk:1,ols:[activeLink('700',{ac:false})]}}});try{
    await f.start();assert.equal(f.calls.filter(call=>call.method==='INFOLINK').length,0);assert.equal(f.rooms()[0].canContext,false);noAutomaticActions(f.calls);
  }finally{f.session.close();}
});

test('read-only mode does not acquire link-bootstrap requests or mutating automatic actions',async()=>{
  const f=sessionFixture({messaging:false});try{
    await f.start();assert.equal(f.calls.some(call=>['SYNCLINK','INFOLINK'].includes(call.method)),false);noAutomaticActions(f.calls);
    assert.equal(allowedReaderMethod('INFOLINK'),false);assert.equal(allowedReaderMethod('INFOLINK',{messaging:false}),false);
  }finally{f.session.close();}
});

class PendingClient extends EventEmitter{
  constructor(){super();this.pending=new Map();this.sent=[];this.sequence=0;}
  request(method,body){const packetId=++this.sequence;this.sent.push({packetId,method,body});return new Promise(resolve=>this.pending.set(packetId,{method,resolve,timer:null}));}
}
const guard=()=>new (guardReaderClient(PendingClient,null,{messaging:true}))();
function clearPending(client){for(const [packetId,item] of client.pending){client.pending.delete(packetId);item.resolve({packetId,method:item.method,status:0,body:{}});}}

test('link-bootstrap response correlation requires exact packet ID and matching method',async()=>{
  for(const method of ['SYNCLINK','INFOLINK']){
    const client=guard(),waiting=client.request(method,method==='SYNCLINK'?{ltk:0}:{lis:[toLong('700')]}).catch(()=>null);let pushes=0;client.on('push',()=>pushes++);
    try{
      assert.equal(client.sent.length,1,'messaging bootstrap must dispatch its read-only metadata request');
      client.finishPacket({packetId:900,method,status:0,body:{ols:[activeLink()]}});assert.equal(client.pending.has(1),true,'method fallback must not settle link metadata');
      client.finishPacket({packetId:1,method:method==='SYNCLINK'?'INFOLINK':'SYNCLINK',status:-203,body:{}});assert.equal(client.pending.has(1),true);assert.equal(pushes,0);
      client.finishPacket({packetId:1,method,status:0,body:{ols:[activeLink()]}});await waiting;assert.equal(client.pending.size,0);
    }finally{clearPending(client);await waiting;}
  }
});

test('late or unsolicited link-bootstrap failures are never emitted as live room pushes',()=>{
  const client=guard();let pushes=0;client.on('push',()=>pushes++);
  for(const method of ['SYNCLINK','INFOLINK'])for(const status of [0,-203])client.finishPacket({packetId:900,method,status,body:{ols:[activeLink()]}});
  assert.equal(pushes,0,'response-only packets cannot terminate or mutate the active room via push');
});

test('INFOLINK is permitted only for explicit messaging metadata bootstrap',()=>{
  assert.equal(allowedReaderMethod('INFOLINK'),false);assert.equal(allowedReaderMethod('INFOLINK',{messaging:false}),false);
  assert.equal(allowedReaderMethod('INFOLINK',{messaging:true}),true,'bounded member metadata lookup needs its own allowlist entry');
  for(const method of ['JOINLINK','DELETELINK','CREATELINK'])assert.equal(allowedReaderMethod(method,{messaging:true}),false);
});

test('bootstrap diagnostics retain method and bounded field shapes without link IDs or names',()=>{
  for(const method of ['SYNCLINK','INFOLINK'])assert.equal(safeMethod(method),method);
  const shape=schemaShape({ols:[activeLink('700',{olu:{userId:'999',lmt:2}})],dlis:['701'],ltk:0});
  assert.equal(shape.fields.ols?.type,'array');assert.equal(shape.fields.dlis?.type,'array');
  assert.equal(shape.fields.ols?.sample?.[0]?.fields?.li?.type,'string');
  assert.equal(JSON.stringify(shape).includes('Synthetic verified link'),false);assert.equal(JSON.stringify(shape).includes('"700"'),false);
});
