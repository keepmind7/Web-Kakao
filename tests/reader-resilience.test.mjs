// Independent resilience contracts. Only synthetic transports and a new
// ephemeral loopback peer are used; never the user's server or real account.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter,once } from 'node:events';
import { createRequire } from 'node:module';
import { createReadOnlyReader } from '../experiments/local-web/reader-manager.mjs';
import { createReaderSession } from '../experiments/local-web/reader-session.mjs';
import { createLocalServer } from '../experiments/local-web/server.mjs';
import { guardReaderClient } from '../experiments/local-web/reader-protocol.mjs';

process.env.KAKAO_DEBUG_LOCO='0';
await import('../local-only/spikes/modern/node_modules/tsx/dist/loader.mjs');
const {CarriageClient,toLong}=await import('../local-only/spikes/modern/src/kakao/forge-protocol.ts');
const {BSON}=createRequire(new URL('../local-only/spikes/modern/package.json',import.meta.url))('bson');
const credential={userId:'999',deviceUUID:'SYNTHETIC',accessToken:'SYNTHETIC_NO_ACCOUNT'};
const room='r_'+'a'.repeat(24),other='r_'+'b'.repeat(24);
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve;return {promise:new Promise(done=>{resolve=done;}),resolve:value=>resolve(value)};};
async function until(check,timeout=2000){const end=Date.now()+timeout;while(!check()){if(Date.now()>end)throw new Error('synthetic condition timed out');await sleep(5);}}
const publicRoom={key:room,title:'Synthetic',kind:'DirectChat',canSend:true,canText:true,canPhoto:true,canReply:true,canRead:true,canContext:true};
function managerFixture(options={}){
  const sent=[],child=Object.assign(new EventEmitter(),{killed:false,send(value,callback){sent.push(value);callback?.();},kill(){this.killed=true;}});
  const reader=createReadOnlyReader({messaging:true,spawn:()=>child,...options});
  return {reader,child,sent,start(ready=true){assert.equal(reader.connect(credential),true);child.emit('message',{type:'reader-ready'});if(ready)this.ready();},
    ready(){child.emit('message',{type:'reader-rooms',source:'loginlist',rooms:[publicRoom],stats:{sourceRoomCount:1}});}};
}

test('only explicit integer handshake denial while connecting invokes the local auth lock',()=>{
  for(const stage of ['booking','getconf','checkin','loginlist']){
    let blocked=0;const f=managerFixture({onBlocked:()=>blocked++});try{
      f.start(false);f.child.emit('message',{type:'reader-failed',stage,status:-203});
      assert.equal(f.reader.snapshot().phase,'blocked');assert.equal(blocked,1);
    }finally{f.reader.close();}
  }
  for(const [stage,status] of [['history',-203],['transport',-203],['loginlist',0],['loginlist',null],['loginlist','-203'],['loginlist',1.5]]){
    let blocked=0;const f=managerFixture({onBlocked:()=>blocked++});try{
      f.start(false);f.child.emit('message',{type:'reader-failed',stage,status});
      assert.notEqual(f.reader.snapshot().phase,'blocked',stage+' must not revoke authentication');assert.equal(blocked,0);
    }finally{f.reader.close();}
  }
});

test('matching history rejection releases the operation as failed without killing a healthy worker',()=>{
  let blocked=0;const f=managerFixture({onBlocked:()=>blocked++});try{
    f.start();assert.equal(f.reader.history(room),true);const request=f.sent.at(-1);
    f.child.emit('message',{type:'reader-request-rejected',key:room,requestId:request.requestId,status:-203});
    assert.equal(f.reader.snapshot().phase,'connected');assert.equal(f.reader.snapshot().operationBusy,false);
    assert.equal(f.reader.messages(room).history.phase,'failed');assert.equal(f.child.killed,false);assert.equal(blocked,0);
    assert.equal(f.reader.history(room),true,'a later explicit history request remains possible');
  }finally{f.reader.close();}
});

test('foreign or stale history rejection cannot release another pending room request',()=>{
  const f=managerFixture();try{
    f.start();f.reader.history(room);const request=f.sent.at(-1);
    for(const response of [{key:room,requestId:request.requestId+1},{key:other,requestId:request.requestId}]){
      f.child.emit('message',{type:'reader-request-rejected',...response,status:-203});
      assert.equal(f.reader.snapshot().operationBusy,true);assert.equal(f.reader.snapshot().phase,'connected');
    }
  }finally{f.reader.close();}
});

test('ordinary reader denial does not erase lab credentials through the real server onBlocked wiring',async()=>{
  let f;
  const app=createLocalServer({mode:'live',messaging:true,encode:()=>[[true]],
    transport:async op=>op==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:op==='generate'?{httpStatus:200,body:{status:0,url:'SYNTHETIC_NOT_FOR_LOGIN',remainingSeconds:60}}:{httpStatus:200,body:{status:0,user:{userId:'999'},accessToken:'SYNTHETIC_NO_ACCOUNT'}},
    readerFactory:options=>(f=managerFixture(options)).reader});
  try{
    await app.lab.start();await until(()=>app.lab.snapshot().credentialInMemory,3500);
    assert.equal(app.lab.withCredential((value,options)=>f.reader.connect(value,options)),true);
    f.child.emit('message',{type:'reader-ready'});f.ready();
    f.child.emit('message',{type:'reader-failed',stage:'history',status:-203});
    assert.equal(app.lab.snapshot().credentialInMemory,true);assert.equal(app.lab.snapshot().sessionBlocked,false);
  }finally{app.lab.cancel();f?.reader.close();app.server.closeAllConnections();}
});

function sessionFixture({source=[{c:'123',t:'DirectChat',title:'Synthetic',ll:'100'}],reply,clock={value:0},gapProbe=false,readProbe=false}={}){
  const calls=[],events=[],f={closed:0};
  const carriage=Object.assign(new EventEmitter(),{async connect(){},disconnect(){f.closed++;},stopPing(){},
    async loginList(){return {status:0,body:{chatDatas:source}};},
    async request(method,body,timeout,policy){
      calls.push({method,body,timeout,policy});const custom=reply?.(method,body,timeout,policy);if(custom!==undefined)return custom;
      if(method==='CHATONROOM')return {status:0,body:{c:String(body.chatId)}};
      if(method==='SYNCLINK')return {status:0,body:{ltk:0}};
      if(method==='INFOLINK')return {status:0,body:{ols:[]}};
      if(method==='CHATINFO')return {status:0,body:{chatInfo:{c:String(body.chatId),title:'Synthetic metadata'}}};
      if(method==='SYNCMSG')return {status:0,body:{isOK:true,chatLogs:[{chatId:'123',logId:'3',authorId:'111',type:1,msg:'Synthetic'}]}};
      if(method==='MCHATLOGS')return {status:0,body:{chatLogs:[{chatId:'123',logId:'2',authorId:'111',type:1,msg:'Synthetic gap'}]}};
      return {status:0,body:{}};
    }});
  const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};}});
  const session=createReaderSession(credential,{messaging:true,photoTransport:'loco',gapProbe,readProbe,booking:bootstrap,ticket:bootstrap,carriage:()=>carriage,toLong,resolve:async host=>host,every:()=>0,delay:async()=>{},now:()=>clock.value,media:()=>{throw new Error('unexpected media client');}},event=>events.push(event));
  return Object.assign(f,{session,calls,events,carriage,clock,async start(){assert.equal((await session.start()).ok,true);return events.findLast(event=>event.type==='reader-rooms').rooms[0].key;}});
}

test('session reports a clear history denial once as a matching handled rejection and remains usable',async()=>{
  let deny=true;const f=sessionFixture({reply:method=>method==='SYNCMSG' && deny?{status:-203,body:{status:-203}}:undefined});
  try{
    const key=await f.start();assert.equal(await f.session.history(key,41),true,'rejection was handled; worker must not invent another');
    const rejected=f.events.filter(event=>event.type==='reader-request-rejected');assert.equal(rejected.length,1);
    assert.equal(rejected[0].key,key);assert.equal(rejected[0].requestId,41);assert.equal(rejected[0].status,-203);
    assert.equal(f.events.some(event=>event.type==='reader-failed'),false);assert.equal(f.closed,0);
    deny=false;assert.equal(await f.session.history(key,42),true);
  }finally{f.session.close();}
});

for(const action of ['send','read','photo'])test('clear '+action+' denial reports failed without closing the healthy session',async()=>{
  const rejectedMethod={send:'WRITE',read:'NOTIREAD',photo:'SHIP'}[action];
  const f=sessionFixture({reply:method=>method===rejectedMethod?{status:-203,body:{status:-203}}:undefined});
  try{
    const key=await f.start();f.carriage.emit('push',{method:'MSG',status:0,body:{chatId:'123',chatLog:{logId:'3',authorId:'111',type:1,msg:'Synthetic'}}});
    const message=f.events.findLast(event=>event.type==='reader-messages').messages.at(-1).key;
    const payload=action==='send'?{text:'Synthetic'}:action==='read'?{message}:{image:png};
    assert.equal(await f.session.action(key,1,action,payload),true);
    const outcome=f.events.findLast(event=>event.type==='reader-action');assert.equal(outcome.phase,'failed');assert.equal(outcome.status,-203);
    assert.equal(f.events.some(event=>event.type==='reader-failed'),false);assert.equal(f.closed,0);
  }finally{f.session.close();}
});

test('session marks startup, title and read diagnostic metadata requests as optional',async()=>{
  const f=sessionFixture({source:[{c:'123',t:'DirectChat',ll:'100'},{c:'124',t:'OM',li:'700',title:'Synthetic open'}],readProbe:true});
  try{
    const key=await f.start();await until(()=>f.calls.some(call=>call.method==='CHATINFO'));
    f.carriage.emit('push',{method:'MSG',status:0,body:{chatId:'123',chatLog:{logId:'3',authorId:'111',type:1,msg:'Synthetic'}}});
    const message=f.events.findLast(event=>event.type==='reader-messages').messages.at(-1).key;
    await f.session.action(key,1,'read',{message});
    for(const method of ['SYNCLINK','INFOLINK','CHATINFO']){
      const calls=f.calls.filter(call=>call.method===method);assert.ok(calls.length>0,method);
      assert.ok(calls.every(call=>call.policy?.optional===true),method+' must opt in to the soft timer');
    }
  }finally{f.session.close();}
});

function responsePacket(id,method,body){const data=BSON.serialize(body),header=Buffer.alloc(22);header.writeInt32LE(id);header.write(method,6,11,'ascii');header.writeInt32LE(data.length,18);return Buffer.concat([header,data]);}
async function realPeer(t){
  const client=new (guardReaderClient(CarriageClient,null,{messaging:true}))(),sockets=new Set(),requests=[],errors=[];
  let connectionCount=0,currentSocket=null,onRequest=()=>{};
  client.on('error',()=>{});
  const server=net.createServer(socket=>{
    connectionCount++;currentSocket=socket;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    let buffer=Buffer.alloc(0),handshaked=false;
    socket.on('data',chunk=>{try{
      buffer=Buffer.concat([buffer,chunk]);
      if(!handshaked){if(buffer.length<12)return;const size=buffer.readUInt32LE(0);if(buffer.length<size+12)return;buffer=buffer.subarray(size+12);handshaked=true;}
      while(buffer.length>=4){const length=buffer.readUInt32LE(0);if(buffer.length<length+4)return;
        const raw=client.crypto.decrypt(buffer.subarray(0,length+4));buffer=buffer.subarray(length+4);
        const request={packetId:raw.readInt32LE(0),method:raw.subarray(6,17).toString('ascii').replace(/\0.*$/,''),body:BSON.deserialize(raw.subarray(22))};requests.push(request);onRequest(request);
      }
    }catch(error){errors.push(error);socket.destroy();}});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const peer={client,requests,errors,set onRequest(value){onRequest=value;},
    reply(request,body){if(currentSocket && !currentSocket.destroyed)currentSocket.write(client.crypto.encrypt(responsePacket(request.packetId,request.method,{status:0,...body})));},
    async close(){client.disconnect();const closing=[...sockets].map(socket=>new Promise(resolve=>{socket.once('close',resolve);socket.destroy();}));
      await Promise.all([new Promise(resolve=>server.close(resolve)),...closing]);
      assert.equal(server.listening,false);assert.equal(sockets.size,0);t.diagnostic(JSON.stringify({syntheticPeerCleanup:{serverListening:server.listening,remainingSockets:sockets.size,pending:client.pending.size,connectionCount}}));},
    get connectionCount(){return connectionCount;}};
  try{await client.connect('127.0.0.1',server.address().port,1000);return peer;}catch(error){await peer.close();throw error;}
}

test('real pinned SDK optional expiry preserves one socket for PING and rejects a late expired reply',async t=>{
  const f=await realPeer(t);let pending;
  try{
    await assert.rejects(f.client.request('CHATINFO',{chatId:toLong('123')},30,{optional:true}),/timed out|timeout/i);
    assert.equal(f.client.socket.destroyed,false,'optional metadata expiry must not run SDK socket.destroy');assert.equal(f.client.pending.size,0);
    f.onRequest=request=>{if(request.method==='PING')f.reply(request,{alive:true});};
    assert.equal((await f.client.request('PING',{},500)).body.alive,true);
    let settled=false;pending=f.client.request('CHATINFO',{chatId:toLong('123')},500);pending.then(()=>{settled=true;},()=>{settled=true;});
    await until(()=>f.requests.length===3);f.reply(f.requests[0],{chatInfo:{c:'123'},marker:'expired'});await sleep(15);
    assert.equal(settled,false,'late optional packet must not settle a newer REQUIRED CHATINFO');
    f.reply(f.requests[2],{chatInfo:{c:'123'},marker:'fresh'});assert.equal((await pending).body.marker,'fresh');
    assert.equal(f.connectionCount,1);assert.equal(f.errors.length,0);
  }finally{await f.close();await pending?.catch(()=>{});}
});

class PendingClient extends EventEmitter{
  constructor(){super();this.pending=new Map();this.sent=[];this.sequence=0;}
  request(method,body,timeout=500){const packetId=++this.sequence;this.sent.push({packetId,method,body});return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{this.pending.delete(packetId);reject(new Error('Request '+method+' timed out'));},timeout);timer.unref();this.pending.set(packetId,{method,resolve,reject,timer});});}
}
function settlePending(client){for(const [id,item] of client.pending){clearTimeout(item.timer);client.pending.delete(id);item.resolve({packetId:id,method:item.method,status:0,body:{}});}}

test('expired optional identity blocks room fallback into a newer required metadata request',async()=>{
  const client=new (guardReaderClient(PendingClient,null,{messaging:true}))();let next;
  try{
    // A live timer is intentional, so Node keeps the test active for its expiry.
    const keepAlive=setTimeout(()=>{},100);try{await assert.rejects(client.request('CHATINFO',{chatId:'123'},20,{optional:true}),/timed out/);}finally{clearTimeout(keepAlive);}
    next=client.request('CHATINFO',{chatId:'123'},500);client.finishPacket({packetId:1,method:'CHATINFO',status:0,body:{chatInfo:{c:'123'}}});
    assert.equal(client.pending.has(2),true,'an expired request number must never use method/room fallback');
    client.finishPacket({packetId:2,method:'CHATINFO',status:0,body:{chatInfo:{c:'123'}}});await next;
  }finally{settlePending(client);await next?.catch(()=>{});}
});

test('optional policy on WRITE NOTIREAD SHIP or media POST is rejected before any base request',async()=>{
  for(const method of ['WRITE','NOTIREAD','SHIP','POST']){
    const client=new (guardReaderClient(PendingClient,null,{messaging:true,media:method==='POST'}))();
    const waiting=client.request(method,{chatId:'123',msgId:'1'},100,{optional:true}).then(()=>({rejected:false}),()=>({rejected:true}));
    try{await sleep(0);assert.equal(client.sent.length,0,method+' must not reach super.request');assert.equal((await waiting).rejected,true);}
    finally{settlePending(client);await waiting;}
  }
});

test('real pinned SDK ordinary required timeout retains its destructive socket policy',async t=>{
  const f=await realPeer(t);try{
    await assert.rejects(f.client.request('CHATINFO',{chatId:toLong('123')},30),/timed out/);
    assert.equal(f.client.socket.destroyed,true);assert.equal(f.client.pending.size,0);
  }finally{await f.close();}
});

function slowHistory(elapsed,{gapProbe=false,complete=false}={}){
  const clock={value:0};return sessionFixture({clock,gapProbe,reply:(method,body)=>{
    if(method!=='SYNCMSG')return undefined;clock.value+=elapsed;const id=String(BigInt(String(body.cur))+1n);
    return {status:0,body:{isOK:complete,chatLogs:[{chatId:'123',logId:id,authorId:'111',type:1,msg:'Synthetic slow page'}]}};
  }});
}
test('slow healthy history stops within budget, retains partial cache and resumes only on explicit load',async()=>{
  const f=slowHistory(9000);try{
    const key=await f.start();await f.session.history(key,1);
    assert.equal(f.calls.filter(call=>call.method==='SYNCMSG').length,1);
    let page=f.events.findLast(event=>event.source==='history');assert.equal(page.messages.length,1);assert.equal(page.hasMore,true);assert.equal(page.latestVisible,false);
    assert.equal(f.calls[0].timeout,10000);await f.session.history(key,2);
    assert.deepEqual(f.calls.filter(call=>call.method==='SYNCMSG').map(call=>String(call.body.cur)),['0','1']);
    assert.equal(f.events.some(event=>event.type==='reader-failed'),false);
  }finally{f.session.close();}
});

test('history begins another required page only with at least10250ms remaining',async()=>{
  for(const [elapsed,expected] of [[7750,2],[7751,1]]){
    const f=slowHistory(elapsed);try{const key=await f.start();await f.session.history(key,1);assert.equal(f.calls.filter(call=>call.method==='SYNCMSG').length,expected,'remaining margin for '+elapsed+'ms success');}
    finally{f.session.close();}
  }
});

test('history budget includes waiting metadata and forbids even its first page below the margin',async()=>{
  const held=deferred(),clock={value:0};const f=sessionFixture({clock,source:[{c:'123',t:'DirectChat',ll:'100'}],reply:method=>method==='CHATINFO'?held.promise:undefined});
  try{
    const key=await f.start();await until(()=>f.calls.some(call=>call.method==='CHATINFO'));
    const waiting=f.session.history(key,1);await sleep(0);clock.value=8000;held.resolve({status:0,body:{chatInfo:{c:'123',title:'Synthetic recovered'}}});await waiting;
    assert.equal(f.calls.filter(call=>call.method==='SYNCMSG').length,0,'18000ms includes metadata wait, leaving only10000ms');
    const page=f.events.findLast(event=>event.source==='history');assert.equal(page.hasMore,true);assert.equal(page.latestVisible,false);
  }finally{held.resolve({status:0,body:{}});f.session.close();}
});

test('gap probe is deferred when a successful first page leaves insufficient history budget',async()=>{
  const f=slowHistory(9000,{gapProbe:true,complete:true});try{
    const key=await f.start();await f.session.history(key,1);
    assert.equal(f.calls.filter(call=>call.method==='SYNCMSG').length,1);assert.equal(f.calls.filter(call=>call.method==='MCHATLOGS').length,0);
    const page=f.events.findLast(event=>event.source==='history');assert.equal(page.hasMore,true);assert.equal(page.latestVisible,false);
  }finally{f.session.close();}
});
