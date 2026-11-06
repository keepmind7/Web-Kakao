// Bounded account-free regressions, not a multi-hour soak or heap-leak proof.
// Only injected workers/fetchers and an ephemeral 127.0.0.1 SDK peer are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {EventEmitter,once} from 'node:events';
import {createRequire} from 'node:module';
import {guardReaderClient} from '../experiments/local-web/reader-protocol.mjs';
import {createReadOnlyReader} from '../experiments/local-web/reader-manager.mjs';
import {createPhotoCache} from '../experiments/local-web/photos.mjs';

process.env.KAKAO_DEBUG_LOCO='0';
await import('../local-only/spikes/modern/node_modules/tsx/dist/loader.mjs');
const {CarriageClient,toLong}=await import('../local-only/spikes/modern/src/kakao/forge-protocol.ts');
const {BSON}=createRequire(new URL('../local-only/spikes/modern/package.json',import.meta.url))('bson');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(condition){
  const deadline=Date.now()+5000;
  while(!condition()){if(Date.now()>deadline)throw new Error('synthetic stress deadline');await sleep(5);}
}
const room=n=>'r_'+n.toString(16).padStart(24,'0');
const message=n=>'m_'+n.toString(16).padStart(24,'0');
const credential={userId:'999',deviceUUID:'SYNTHETIC',accessToken:'SYNTHETIC_NO_ACCOUNT'};
function packet(id,method,body){
  const data=BSON.serialize(body),header=Buffer.alloc(22);
  header.writeInt32LE(id);header.write(method,6,11,'ascii');header.writeInt32LE(data.length,18);
  return Buffer.concat([header,data]);
}

test('bounded SDK loopback repeats optional expiry, late responses and required-timeout reconnects',{timeout:30000},async t=>{
  const client=new (guardReaderClient(CarriageClient,null,{messaging:true}))();
  const sockets=new Set(),requests=[],errors=[];let current=null,connections=0,answer=()=>{},waiting;
  client.on('error',()=>{});
  const server=net.createServer(socket=>{
    connections++;current=socket;sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
    let buffer=Buffer.alloc(0),handshaked=false;
    socket.on('data',chunk=>{
      try{
        buffer=Buffer.concat([buffer,chunk]);
        if(!handshaked){if(buffer.length<12)return;const size=buffer.readUInt32LE(0);if(buffer.length<size+12)return;buffer=buffer.subarray(size+12);handshaked=true;}
        while(buffer.length>=4){
          const size=buffer.readUInt32LE(0);if(buffer.length<size+4)return;
          const raw=client.crypto.decrypt(buffer.subarray(0,size+4));buffer=buffer.subarray(size+4);
          const request={id:raw.readInt32LE(0),method:raw.subarray(6,17).toString('ascii').replace(/\0.*$/,''),body:BSON.deserialize(raw.subarray(22))};
          requests.push(request);answer(request);
        }
      }catch(error){errors.push(error);socket.destroy();}
    });
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=server.address().port;
  const reply=(request,body)=>{assert.ok(current && !current.destroyed);current.write(client.crypto.encrypt(packet(request.id,request.method,{status:0,...body})));};
  answer=request=>{if(request.method==='PING')reply(request,{alive:true});};
  try{
    await client.connect('127.0.0.1',port,3000);
    for(let round=0;round<16;round++){
      const offset=requests.length;
      await assert.rejects(client.request('CHATINFO',{chatId:toLong('123')},90,{optional:true}),/timed out|timeout/i);
      await until(()=>requests.length>=offset+1);
      const expired=requests[offset];assert.equal(client.pending.size,0);assert.equal(client.socket.destroyed,false);
      assert.equal((await client.request('PING',{},2000)).body.alive,true);
      let settled=false;
      waiting=client.request('CHATINFO',{chatId:toLong('123')},2000);
      waiting.then(()=>{settled=true;},()=>{settled=true;});
      await until(()=>requests.length>=offset+3);
      reply(expired,{chatInfo:{c:'123'},marker:'expired'});await sleep(15);
      assert.equal(settled,false,'old metadata must not resolve the current request');
      reply(requests[offset+2],{chatInfo:{c:'123'},marker:'fresh'});
      assert.equal((await waiting).body.marker,'fresh');waiting=null;assert.equal(client.pending.size,0);
      if(round%4===3){
        await assert.rejects(client.request('CHATINFO',{chatId:toLong('123')},90),/timed out|timeout/i);
        assert.equal(client.socket.destroyed,true);await until(()=>sockets.size===0);
        assert.equal(client.pending.size,0);await client.connect('127.0.0.1',port,3000);
        assert.equal((await client.request('PING',{},2000)).body.alive,true);
      }
    }
    assert.equal(connections,5);assert.equal(errors.length,0);assert.equal(sockets.size,1);
  }finally{
    client.disconnect();await waiting?.catch(()=>{});
    const closed=[...sockets].map(socket=>new Promise(resolve=>{socket.once('close',resolve);socket.destroy();}));
    await Promise.all([new Promise(resolve=>server.close(resolve)),...closed]);
    assert.equal(server.listening,false);assert.equal(sockets.size,0);assert.equal(client.pending.size,0);
    t.diagnostic(JSON.stringify({boundedRounds:16,requiredReconnects:4,connections,remainingSockets:sockets.size,pending:client.pending.size,listenerStopped:!server.listening}));
  }
});

test('bounded manager reconnects replace full 500-room snapshots and reject old worker history',{timeout:30000},async t=>{
  const children=[];let raw=null;
  const profile={key:()=>Buffer.alloc(32),snapshot:()=>({notifications:false}),room:()=>null,close(){}};
  const reader=createReadOnlyReader({messaging:true,preferenceStore:{account:()=>profile},lifecycleOptions:{writeSnapshot:value=>{raw=value;}},spawn:()=>{
    const child=Object.assign(new EventEmitter(),{sent:[],killed:false,send(value,callback){this.sent.push(value);callback?.();},kill(){this.killed=true;}});
    children.push(child);return child;
  }});
  const response=(key,requestId,n)=>({type:'reader-messages',source:'history',key,requestId,messages:[{key:message(n),text:'Synthetic bounded history'}],latestVisible:true,fieldPresent:true,receivedCount:1,acceptedCount:1});
  let previous=null,retired=null,completed=0;
  try{
    for(let round=0;round<24;round++){
      assert.equal(reader.connect(credential),true);const child=children.at(-1);
      child.emit('message',{type:'reader-ready'});
      const rows=[{key:room(1),title:'Synthetic shared',kind:'DirectChat',canSend:true},...Array.from({length:499},(_,i)=>({key:room(2+round*499+i),title:'Synthetic rotating',kind:'DirectChat',canSend:true,initialUnreadCount:7,initialUnreadCoverage:'observed'}))];
      child.emit('message',{type:'reader-rooms',source:'loginlist',rooms:rows,stats:{sourceRoomCount:500}});
      assert.equal(reader.rooms().rooms.length,500);assert.equal(reader.snapshot().roomCount,500);
      assert.equal(reader.rename(rows.at(-1).key,'Synthetic current alias'),true);
      assert.equal(reader.rooms().rooms.at(-1).title,'Synthetic current alias');assert.equal(reader.rooms().rooms.at(-1).unreadLocalCount,7);
      if(retired){assert.equal(reader.messages(retired.key),null);assert.equal(reader.rename(retired.key,'Must not return'),false);assert.equal(reader.seen(retired.key,retired.token),false);}
      assert.equal(reader.history(room(1)),true);const request=child.sent.at(-1);
      if(previous){
        assert.equal(previous.child.listenerCount('message'),0);
        previous.child.emit('message',response(room(1),request.requestId,999999));previous.child.emit('exit',4,null);previous.child.emit('close',4,null);
        child.emit('message',response(room(1),previous.request.requestId,999998));
        assert.equal(reader.snapshot().phase,'connected');assert.equal(reader.snapshot().operationBusy,true);
        assert.equal(reader.messages(room(1)).messages.length,0,'a prior worker cannot populate the next connection');
      }
      child.emit('message',response(room(1),request.requestId,round+1));
      assert.equal(reader.snapshot().operationBusy,false);assert.deepEqual(reader.messages(room(1)).messages.map(row=>row.key),[message(round+1)]);completed++;
      const rotating=rows.at(-1).key;assert.equal(reader.history(rotating),true);
      child.emit('message',response(rotating,child.sent.at(-1).requestId,1000+round));
      retired={key:rotating,token:reader.messages(rotating).seenToken};assert.ok(retired.token);
      assert.equal(reader.history(room(1)),true);previous={child,request:child.sent.at(-1)};
      reader.disconnect();assert.equal(child.killed,true);assert.equal(reader.snapshot().operationBusy,false);
    }
  }finally{
    reader.close();for(const child of children){child.emit('exit',0,null);child.emit('close',0,null);}
    await reader.flushDiagnostics();
    assert.equal(reader.snapshot().roomCount,0);assert.equal(reader.snapshot().operationBusy,false);assert.deepEqual(reader.snapshot().pageRevisions,{});
    const journal=JSON.parse(raw);assert.equal(journal.attempts.length,8);assert.ok(journal.attempts.every(attempt=>attempt.events.length<=16));
    assert.ok(Buffer.byteLength(raw)<=1024*1024);assert.equal(raw.includes('SYNTHETIC_NO_ACCOUNT'),false);assert.equal(raw.includes('Synthetic bounded history'),false);
    assert.ok(children.every(child=>child.killed && child.listenerCount('message')===0));
    t.diagnostic(JSON.stringify({boundedReconnectRounds:completed,roomsPerSnapshot:500,retainedLifecycleAttempts:journal.attempts.length,closedWorkers:children.length}));
  }
});

test('bounded photo epochs retain four real upstream slots until settlement and reject stale success',{timeout:30000},async t=>{
  const calls=[],requests=[];let active=0,maxActive=0;
  const cache=createPhotoCache({fetcher:(url,{signal})=>{
    active++;maxActive=Math.max(maxActive,active);let resolve;
    const promise=new Promise(done=>{resolve=done;}).finally(()=>{active--;});
    const call={url,signal,resolve,promise};calls.push(call);return promise;
  }});
  const image=n=>({data:Buffer.alloc(70,n),type:'image/png'});
  const get=(url,options)=>{const promise=cache.get(url,options);promise.catch(()=>{});requests.push(promise);return promise;};
  try{
    for(let round=0;round<24;round++){
      cache.clear();const offset=calls.length,shared='synthetic:shared:'+round,first=new AbortController(),second=new AbortController();
      const a=get(shared,{signal:first.signal}),b=get(shared,{signal:second.signal});
      const batch=Array.from({length:39},(_,i)=>get('synthetic:queued:'+round+':'+i));
      assert.equal(calls.length,offset+4);assert.equal(active,4);
      first.abort();await assert.rejects(a,/photo_unavailable/);assert.equal(calls[offset].signal.aborted,false);
      second.abort();await assert.rejects(b,/photo_unavailable/);assert.equal(calls[offset].signal.aborted,true);
      assert.equal(active,4,'an abort-ignoring transport still owns its physical running slot');
      cache.clear();const canceled=await Promise.allSettled(batch);assert.ok(canceled.every(result=>result.status==='rejected'));
      assert.ok(calls.slice(offset).every(call=>call.signal.aborted));
      const fresh=get(shared);assert.equal(calls.length,offset+4,'clear must not oversubscribe old uncompleted transports');
      calls[offset+1].resolve(image(0));await until(()=>calls.length===offset+5);
      const item=image(round+1);calls[offset+4].resolve(item);assert.strictEqual(await fresh,item);
      for(const call of calls.slice(offset,offset+4))call.resolve(image(255));
      await Promise.all(calls.slice(offset).map(call=>call.promise));await until(()=>active===0);
      await new Promise(resolve=>setImmediate(resolve));
      assert.strictEqual(await get(shared),item,'late same-URL bytes cannot overwrite the new epoch');
      assert.equal(calls.length,offset+5,'queued canceled URLs must never start after clear');
    }
    assert.equal(maxActive,4);assert.equal(active,0);
  }finally{
    cache.clear();for(const call of calls)call.resolve(image(0));await Promise.allSettled(requests);await Promise.all(calls.map(call=>call.promise));
    assert.equal(active,0);t.diagnostic(JSON.stringify({boundedEpochRounds:24,upstreamOperations:calls.length,maxActualUpstream:maxActive,remainingActualUpstream:active}));
  }
});
