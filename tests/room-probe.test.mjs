import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allowedReadOnlyMethod, safeDestination, resolvePublicDestination, sanitizeProbe, probeRoomCount, runRoomProbe } from '../experiments/local-web/room-probe.mjs';

const credential = {userId:'246810',deviceUUID:'FAKE_PRIVATE_DEVICE',accessToken:'FAKE_PRIVATE_TOKEN',refreshToken:'FAKE_PRIVATE_REFRESH'};
test('real worker exits on parent IPC disconnect before credentials or any network operation',async()=>{
  const child=fork(fileURLToPath(new URL('../experiments/local-web/room-probe-worker.mjs',import.meta.url)),[],{
    execArgv:['--import',new URL('../local-only/spikes/modern/node_modules/tsx/dist/loader.mjs',import.meta.url).href],
    stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,
  });
  try {
    const code=await new Promise((resolve,reject)=>{
      const deadline=setTimeout(()=>reject(new Error('worker did not exit')),5000);
      child.on('error',error=>{clearTimeout(deadline);reject(error);});
      child.on('message',message=>{if(message?.type==='room-probe-ready')child.disconnect();});
      child.on('exit',code=>{clearTimeout(deadline);resolve(code);});
    });
    assert.equal(code,0);
  } finally { if(child.exitCode===null)child.kill(); }
});
function clients({confStatus=0,loginStatus=0,body={chatDatas:[{name:'FAKE_PRIVATE_ROOM',lastMessage:'FAKE_PRIVATE_MESSAGE'}]},routeHost='loco-test.kakao.com',failConnect=false}={}) {
  const calls = [], closed=[];
  const make = name => Object.assign(new EventEmitter(), {
    async connect() {calls.push(name+':connect'); if(failConnect && name==='carriage')throw new Error('private failure');},
    async request(method) {calls.push(method); return {status:confStatus,body:{ticket:{lsl:['ticket-test.kakao.com']},wifi:{ports:[443]}}};},
    async checkin() {calls.push('CHECKIN'); return {status:0,host:routeHost,port:443};},
    async loginList() {calls.push('LOGINLIST'); return {status:loginStatus,body};},
    disconnect() {closed.push(name);},
  });
  return {calls,closed,factory:{booking:()=>make('booking'),ticket:()=>make('ticket'),carriage:()=>make('carriage'),toLong:value=>value,resolve:async host=>host}};
}

test('DNS results are checked and the selected literal address is used without a second lookup',async()=>{
  await assert.rejects(resolvePublicDestination('route.kakao.com',443,async()=>[{address:'127.0.0.1'}]));
  await assert.rejects(resolvePublicDestination('route.kakao.com',443,async()=>[{address:'192.168.1.2'}]));
  assert.equal(await resolvePublicDestination('route.kakao.com',443,async()=>[{address:'10.0.0.1'},{address:'1.2.3.4'}]),'1.2.3.4');
  assert.equal(await resolvePublicDestination('1.2.3.4',443,async()=>{throw new Error('no DNS for IP');}),'1.2.3.4');
});

test('a valid advertised non-443 ticket port is retained',async()=>{
  const f=clients(); let port;
  const original=f.factory.booking;
  f.factory.booking=()=>{const client=original();client.request=async()=>({status:0,body:{ticket:{lsl:['ticket-test.kakao.com']},wifi:{ports:[5223]}}});return client;};
  const ticket=f.factory.ticket;
  f.factory.ticket=()=>{const client=ticket();const connect=client.connect;client.connect=async(host,value)=>{port=value;await connect();};return client;};
  await probeRoomCount(credential,f.factory);assert.equal(port,5223);
});
test('read-only protocol allowlist excludes sends, read receipts, history, ping and arbitrary methods',()=>{
  for(const name of ['GETCONF','CHECKIN','LOGINLIST'])assert.equal(allowedReadOnlyMethod(name),true);
  for(const name of ['WRITE','READ','CHATONROOM','SYNCMSG','PING','MEMBER','SYNCLINK'])assert.equal(allowedReadOnlyMethod(name),false);
});
test('server routes cannot point at loopback, private network or arbitrary domains',()=>{
  for(const host of ['127.0.0.1','10.0.0.1','192.168.1.1','169.254.1.1','::1','fe80::1','2::1','200::1','2001:db8::1','198.18.0.1','203.0.113.1','evil.example'])assert.equal(safeDestination(host,443),false);
  assert.equal(safeDestination('loco-test.kakao.com',443),true); assert.equal(safeDestination('loco-test.kakao.com',0),false);
});
test('only GETCONF/CHECKIN/LOGINLIST execute; only count leaves the probe; all clients close',async()=>{
  const f=clients(); const result=await probeRoomCount(credential,f.factory);
  assert.deepEqual(f.calls,['booking:connect','GETCONF','ticket:connect','CHECKIN','carriage:connect','LOGINLIST']);
  assert.deepEqual(f.closed,['carriage','ticket','booking']); assert.equal(result.roomCount,1);
  for(const value of ['FAKE_PRIVATE_ROOM','FAKE_PRIVATE_MESSAGE','FAKE_PRIVATE_TOKEN','246810'])assert.equal(JSON.stringify(result).includes(value),false);
});
test('login rejection, invalid route and transport failures stop and clean up',async()=>{
  const rejected=clients({loginStatus:-997}); const denied=await probeRoomCount(credential,rejected.factory);
  assert.equal(denied.status,-997); assert.equal(denied.ok,false); assert.deepEqual(rejected.closed,['carriage','ticket','booking']);
  const route=clients({routeHost:'127.0.0.1'}); await probeRoomCount(credential,route.factory); assert.equal(route.calls.includes('LOGINLIST'),false);
  const failure=clients({failConnect:true}); const failed=await probeRoomCount(credential,failure.factory); assert.equal(failed.ok,false); assert.deepEqual(failure.closed,['carriage','ticket','booking']);
});
test('missing room field is distinct from a valid empty list',async()=>{
  const missing=await probeRoomCount(credential,clients({body:{}}).factory); assert.equal(missing.roomListPresent,false); assert.equal(missing.roomCount,null);
  const empty=await probeRoomCount(credential,clients({body:{chats:[]}}).factory); assert.equal(empty.roomListPresent,true); assert.equal(empty.roomCount,0);
});
test('worker reply is whitelisted and cannot serialize raw data or credentials',()=>{
  const result=sanitizeProbe({ok:true,stage:'loginlist',status:0,roomListPresent:true,roomCount:1,accessToken:'FAKE_PRIVATE_TOKEN',raw:{chatDatas:['FAKE_PRIVATE_ROOM']}});
  assert.equal(result.connectionVerified,true); assert.equal(JSON.stringify(result).includes('FAKE_PRIVATE'),false);
  assert.equal(sanitizeProbe({ok:true,stage:'getconf',status:0}).connectionVerified,false);
});
test('worker credentials use private IPC only; stdout/stderr are suppressed and worker terminates',async()=>{
  let sent,options,killed=false;
  const child=Object.assign(new EventEmitter(),{
    send(message,callback){sent=message; callback?.(); queueMicrotask(()=>child.emit('message',{type:'room-probe-result',ok:true,stage:'loginlist',status:0,roomListPresent:true,roomCount:2,raw:'FAKE_PRIVATE'}));},
    kill(){killed=true;return true;},
  });
  const result=await runRoomProbe(credential,{signal:new AbortController().signal,spawn:(entry,args,opts)=>{
    options=opts; assert.equal(JSON.stringify([entry,args]).includes('FAKE_PRIVATE'),false);
    queueMicrotask(()=>child.emit('message',{type:'room-probe-ready'})); return child;
  }});
  assert.deepEqual(sent.credential,{userId:credential.userId,deviceUUID:credential.deviceUUID,accessToken:credential.accessToken});
  assert.equal('refreshToken' in sent.credential,false); assert.deepEqual(options.stdio,['ignore','ignore','ignore','ipc']); assert.equal(options.windowsHide,true);
  assert.equal(options.env.KAKAO_DEBUG_LOCO,'0'); assert.equal(result.roomCount,2); assert.equal(killed,true);
  assert.equal(JSON.stringify(result).includes('FAKE_PRIVATE'),false);
});
test('already cancelled probe never spawns a worker',async()=>{
  const controller=new AbortController();controller.abort();
  const result=await runRoomProbe(credential,{signal:controller.signal,spawn:()=>{throw new Error('must not start');}});
  assert.equal(result.stage,'cancelled'); assert.equal(result.connectionVerified,false);
});
