// Independent synthetic/loopback HTTP and real pinned SDK timer contracts.
// No account, production request, user media, TLS session or actual delivery.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once, getEventListeners } from 'node:events';
import { createHash } from 'node:crypto';
import { uploadPhotoHttps } from '../experiments/local-web/media-upload-https.mjs';
import { createReaderDiagnostic } from '../experiments/local-web/reader-diagnostics.mjs';
import { guardReaderClient } from '../experiments/local-web/reader-protocol.mjs';
import { makeSyntheticImage } from '../experiments/photo-method-simulation/model.mjs';

process.env.KAKAO_DEBUG_LOCO='0';
await import('../local-only/spikes/modern/node_modules/tsx/dist/loader.mjs');
const {CarriageClient,toLong}=await import('../local-only/spikes/modern/src/kakao/forge-protocol.ts');
const jpeg=()=>makeSyntheticImage({size:1024}).bytes;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const digest=(data,kind='sha1')=>createHash(kind).update(data).digest('hex');
const endpoint='https://up-m.talk.kakao.com/upload';
function ack(body,change={}){return {status:0,body:{chatId:'123',msgId:body.msgId,chatLog:{logId:'42',chatId:'123',authorId:'999',type:2,msgId:body.msgId},...change}};}
function fakeHttp({status=200,headers={},body=Buffer.from('synthetic/asset.jpg'),hang=false,bodyHang=false,requestError=false,responseError=false}={}){
  const f={calls:[],requests:[],responses:[]};
  f.request=(url,options,callback)=>{
    const req=new EventEmitter(),res=new EventEmitter();let destroyed=false,resDestroyed=false;
    res.statusCode=status;res.headers={'content-type':'text/plain',...headers};
    res.destroy=()=>{if(resDestroyed)return;resDestroyed=true;res.destroyed=true;res.emit('close');};
    req.destroy=()=>{if(destroyed)return;destroyed=true;req.destroyed=true;queueMicrotask(()=>req.emit('error',new Error('SYNTHETIC_REQUEST_DESTROYED')));};
    const send=()=>{callback(res);if(res.destroyed || bodyHang)return;if(responseError){res.emit('error',new Error('SYNTHETIC_RESPONSE_FAILURE'));return;}if(body.length)res.emit('data',body);res.emit('end');res.emit('close');};
    req.end=payload=>{f.calls.push({url:String(url),options,payload:Buffer.from(payload)});if(requestError)queueMicrotask(()=>req.emit('error',Object.assign(new Error('PRIVATE_SYNTHETIC_HTTP_ERROR'),{code:'ECONNRESET'})));else if(!hang)queueMicrotask(send);};
    f.respond=send;f.requests.push(req);f.responses.push(res);return req;
  };
  return f;
}
function fixture({httpOptions={},write,resolve,observe,timeout=1000,...changes}={}){
  const wire=fakeHttp(httpOptions),writes=[],dns=[],events=[];
  const options={data:jpeg(),chatId:'123',userId:'999',messageId:'345',toLong,timeout,
    resolve:async(host,options)=>{dns.push({host,options});return [{address:'8.8.8.8',family:4}];},
    request:wire.request,carriage:{async request(method,body,ms,policy){writes.push({method,body,ms,policy});return write?write(body,policy):ack(body);}},
    observe:event=>{events.push(event);observe?.(event);},...changes};
  if(resolve)options.resolve=resolve;
  return {options,wire,writes,dns,events,run:()=>uploadPhotoHttps(options)};
}
function assertNoWrite(f){assert.equal(f.writes.length,0);}

test('HTTPS actual loopback multipart preserves exact frozen JPEG and source-backed WRITE fields',async t=>{
  const received=[],sockets=new Set(),closed=[];let headers;
  const server=http.createServer(async(req,res)=>{headers=req.headers;for await(const part of req)received.push(part);res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end('synthetic/loopback.jpg');});
  server.on('connection',socket=>{sockets.add(socket);closed.push(new Promise(resolve=>socket.once('close',()=>{sockets.delete(socket);resolve();})));});
  server.listen(0,'127.0.0.1');await once(server,'listening');assert.notEqual(server.address().port,8787);
  const data=jpeg(),f=fixture({data});let verifiedOptions=false;
  f.options.request=(url,options,onResponse)=>{
    assert.equal(String(url),endpoint);assert.equal(options.method,'POST');assert.equal(options.rejectUnauthorized,true);assert.equal(options.servername,'up-m.talk.kakao.com');assert.equal(options.agent,false);
    options.lookup('up-m.talk.kakao.com',{},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'8.8.8.8');assert.equal(family,4);});
    options.lookup('foreign.invalid',{},error=>assert.ok(error));
    assert.equal(Object.keys(options.headers).some(key=>/authorization|cookie|^a$/i.test(key)),false);
    verifiedOptions=true;
    // Explicit injected HTTP loopback: no production DNS or TLS is performed.
    return http.request({hostname:'127.0.0.1',port:server.address().port,path:'/fixture',method:options.method,headers:options.headers},onResponse);
  };
  try{
    const result=await f.run();assert.equal(result.phase,'accepted');assert.equal(verifiedOptions,true);
    assert.deepEqual(f.dns,[{host:'up-m.talk.kakao.com',options:{all:true,verbatim:true}}]);
    const body=Buffer.concat(received),boundary=/boundary=([^;]+)$/.exec(headers['content-type'])[1];
    const expected=Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="user_id"\r\n\r\n0\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attachment_type"\r\n\r\nimage/jpeg\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),data,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    assert.deepEqual(body,expected);assert.equal(Number(headers['content-length']),body.length);
    assert.equal(f.writes.length,1);const {method,body:write,ms,policy}=f.writes[0];assert.equal(method,'WRITE');
    assert.equal(String(write.chatId),'123');assert.equal(String(write.msgId),'345');assert.equal(typeof write.chatId,'object');
    assert.deepEqual({type:write.type,msg:write.msg,noSeen:write.noSeen,scope:write.scope,silence:write.silence},{type:2,msg:'[사진]',noSeen:true,scope:1,silence:false});
    assert.deepEqual(JSON.parse(write.extra),{path:'synthetic/loopback.jpg',s:data.length,w:1,h:1,cs:digest(data),mt:'image/jpeg'});
    assert.ok(ms>0 && ms<=1000);assert.ok(policy.signal instanceof AbortSignal);assert.equal(policy.signal.aborted,true,'operation finalization retires its guard signal');
    assert.equal(result.attachment,write.extra);assert.equal(f.events.some(event=>['ship','post','received_complete'].includes(event.stage)),false);
  }finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await Promise.all(closed);assert.equal(sockets.size,0);t.diagnostic(JSON.stringify({syntheticHttpsCleanup:{serverListening:server.listening,sockets:sockets.size}}));}
});

for(const readOnSend of [false,true])test('HTTPS noSeen follows explicit readOnSend '+readOnSend,async()=>{
  const f=fixture({readOnSend});assert.equal((await f.run()).phase,'accepted');assert.equal(f.writes[0].body.noSeen,!readOnSend);
});
for(const [name,changes] of [
  ['PNG',{data:makeSyntheticImage({format:'png'}).bytes}],['empty',{data:Buffer.alloc(0)}],['oversize',{data:Buffer.alloc(10*1024*1024+1)}],
  ['invalid identity',{chatId:'0'}],['invalid author',{userId:'-1'}],['invalid message',{messageId:'9223372036854775808'}],
  ['invalid read policy',{readOnSend:'true'}],['zero deadline',{timeout:0}],['excess deadline',{timeout:22501}],
])test('HTTPS refuses '+name+' before DNS or wire',async()=>{
  const f=fixture(changes),result=await f.run();assert.equal(result.phase,'failed');assert.equal(f.dns.length,0);assert.equal(f.wire.calls.length,0);assertNoWrite(f);
  if(name==='PNG')assert.equal(result.reason,'photo_jpeg_required');
});
for(const [name,addresses] of [
  ['empty',[]],['non-array',{}],['private',[{address:'127.0.0.1',family:4}]],['mixed',[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}]],
  ['mapped private',[{address:'::ffff:127.0.0.1',family:6}]],['IPv6 private',[{address:'fc00::1',family:6}]],['invalid text',[{address:'not-an-address',family:4}]],['wrong family',[{address:'8.8.8.8',family:6}]],
])test('HTTPS rejects '+name+' DNS route without HTTP/WRITE',async()=>{
  const f=fixture({resolve:async()=>addresses}),result=await f.run();assert.equal(result.phase,'failed');assert.equal(f.wire.calls.length,0);assertNoWrite(f);
});
for(const [name,httpOptions] of [
  ['status',{status:403}],['redirect',{status:302,headers:{location:'https://foreign.invalid/path'}}],['HTML',{headers:{'content-type':'text/html'},body:Buffer.from('<html>no</html>')}],
  ['JSON',{body:Buffer.from('{"path":"synthetic.jpg"}')}],['empty',{body:Buffer.alloc(0)}],['URL',{body:Buffer.from('https://foreign.invalid/file.jpg')}],
  ['traversal',{body:Buffer.from('synthetic/../file.jpg')}],['whitespace',{body:Buffer.from('synthetic/file.jpg\n')}],['control',{body:Buffer.from('synthetic/\0file.jpg')}],
  ['invalid UTF8',{body:Buffer.from([255,254])}],['UTF8 BOM',{body:Buffer.concat([Buffer.from([239,187,191]),Buffer.from('synthetic/file.jpg')])}],
  ['oversize body',{body:Buffer.alloc(4097,97)}],['oversize length',{headers:{'content-length':'4097'}}],['mismatched length',{headers:{'content-length':'1'}}],
  ['invalid length',{headers:{'content-length':'bad'}}],['compressed',{headers:{'content-encoding':'gzip'}}],['request reset',{requestError:true}],['response error',{responseError:true}],
])test('HTTPS '+name+' upload response cannot create a WRITE',async()=>{
  const f=fixture({httpOptions}),result=await f.run();assert.equal(result.phase,'failed');assertNoWrite(f);assert.equal(f.wire.calls.length,1);
  assert.equal(JSON.stringify(f.events).includes('PRIVATE_SYNTHETIC_HTTP_ERROR'),false);
});
for(const stage of ['dns','headers','body','write'])test('HTTPS bounded lifetime covers stalled '+stage+' and cleans request',async()=>{
  const f=fixture({timeout:25,...(stage==='dns'?{resolve:()=>new Promise(()=>{})}:{}),httpOptions:stage==='headers'?{hang:true}:stage==='body'?{bodyHang:true}:{},...(stage==='write'?{write:()=>new Promise(()=>{})}:{})});
  const result=await f.run();assert.equal(result.phase,stage==='write'?'unknown':'failed');assert.equal(f.writes.length,stage==='write'?1:0);
  assert.ok(f.events.some(event=>event.stage==='https_deadline'));assert.ok(f.wire.requests.every(req=>req.destroyed));
});
test('HTTPS preaborted signal performs no DNS/HTTP/WRITE',async()=>{
  const controller=new AbortController();controller.abort();const f=fixture({signal:controller.signal});assert.equal((await f.run()).phase,'failed');assert.equal(f.dns.length,0);assert.equal(f.wire.calls.length,0);assertNoWrite(f);
});
test('HTTPS canceled pending HTTP destroys a late arriving response without WRITE',async()=>{
  const controller=new AbortController(),f=fixture({signal:controller.signal,httpOptions:{hang:true}}),pending=f.run();await flush();controller.abort();assert.equal((await pending).phase,'failed');f.wire.respond();await flush();assert.equal(f.wire.responses[0].destroyed,true);assertNoWrite(f);assert.equal(getEventListeners(controller.signal,'abort').length,0);
});
test('HTTPS deadline also destroys an HTTP callback arriving after finalization',async()=>{
  const f=fixture({timeout:20,httpOptions:{hang:true}});assert.equal((await f.run()).phase,'failed');f.wire.respond();await flush();assert.equal(f.wire.responses[0].destroyed,true);assertNoWrite(f);
});
test('HTTPS context invalidated after upload is failed before WRITE',async()=>{
  let current=true;const f=fixture({isCurrent:()=>current,observe:e=>{if(e.stage==='https_uploaded')current=false;}});assert.equal((await f.run()).phase,'failed');assertNoWrite(f);
});
test('HTTPS cancel after WRITE stays unknown and late ACK starts no retry or events',async()=>{
  const controller=new AbortController(),gate=deferred(),begun=deferred(),f=fixture({signal:controller.signal,write:()=>{begun.resolve();return gate.promise;}}),pending=f.run();await begun.promise;controller.abort();assert.equal((await pending).phase,'unknown');const snapshot=JSON.stringify(f.events);gate.resolve(ack(f.writes[0].body));await flush();assert.equal(JSON.stringify(f.events),snapshot);assert.equal(f.writes.length,1);assert.equal(getEventListeners(controller.signal,'abort').length,0);
});
test('HTTPS late ACK from a previous context cannot accept',async()=>{
  let current=true;const gate=deferred(),begun=deferred(),f=fixture({isCurrent:()=>current,write:()=>{begun.resolve();return gate.promise;}}),pending=f.run();await begun.promise;current=false;gate.resolve(ack(f.writes[0].body));assert.equal((await pending).phase,'unknown');assert.equal(f.writes.length,1);
});
test('HTTPS freezes input bytes before a held DNS lookup and tolerates observer exceptions',async()=>{
  const gate=deferred(),data=jpeg(),expected=Buffer.from(data),f=fixture({data,resolve:()=>gate.promise,observe:()=>{throw new Error('SYNTHETIC_OBSERVER');}}),pending=f.run();data.fill(0);gate.resolve([{address:'8.8.8.8',family:4}]);assert.equal((await pending).phase,'accepted');assert.ok(f.wire.calls[0].payload.includes(expected));assert.equal(JSON.parse(f.writes[0].body.extra).cs,digest(expected));
});
test('HTTPS concurrent reverse-order uploads keep each path, size and digest bound to their own WRITE',async()=>{
  const a=fixture({httpOptions:{hang:true,body:Buffer.from('synthetic/first.jpg')}}),b=fixture({data:makeSyntheticImage({size:2048}).bytes,messageId:'346',httpOptions:{hang:true,body:Buffer.from('synthetic/second.jpg')}}),pa=a.run(),pb=b.run();await flush();b.wire.respond();assert.equal((await pb).phase,'accepted');a.wire.respond();assert.equal((await pa).phase,'accepted');for(const [f,path] of [[a,'synthetic/first.jpg'],[b,'synthetic/second.jpg']]){assert.equal(f.writes.length,1);const extra=JSON.parse(f.writes[0].body.extra);assert.equal(extra.path,path);assert.equal(extra.s,f.options.data.length);assert.equal(extra.cs,digest(f.options.data));}assert.notEqual(String(a.writes[0].body.msgId),String(b.writes[0].body.msgId));
});
for(const [name,alter] of [
  ['missing room',body=>({chatLog:{logId:'42'}})],['invalid log',body=>({chatId:'123',chatLog:{logId:'0'}})],
  ['foreign room',body=>({chatId:'124'})],['foreign author',body=>({authorId:'998'})],['foreign message',body=>({msgId:'346'})],['wrong type',body=>({type:1})],
  ...['path','s','w','h','cs','mt'].map(field=>['contradictory '+field,body=>({attachment:{[field]:field==='s'||field==='w'||field==='h'?-1:'WRONG_SYNTHETIC'}})]),
])test('HTTPS ACK '+name+' cannot promote an uploaded asset to accepted',async()=>{
  const f=fixture({write:body=>{const a=ack(body);return {status:0,body:name==='missing room'?alter(body):{...a.body,...alter(body)}};}});assert.equal((await f.run()).phase,'unknown');assert.equal(f.writes.length,1);
});
test('HTTPS explicit WRITE rejection is failed, while missing response is unknown with no fallback',async()=>{
  for(const [write,phase] of [[()=>({status:-203,body:{status:-203}}),'failed'],[()=>undefined,'unknown']]){const f=fixture({write});assert.equal((await f.run()).phase,phase);assert.equal(f.writes.length,1);assert.equal(f.wire.calls.length,1);}
});
test('HTTPS diagnostic boundary retains only allowlisted counters/status without asset contents',async()=>{
  const snapshots=[],diagnostic=createReaderDiagnostic({writeSnapshot:raw=>snapshots.push(raw)}),f=fixture({observe:e=>diagnostic.note('photo-upload',{...e,path:'PRIVATE_SYNTHETIC_ASSET',bytes:jpeg(),body:'PRIVATE_SYNTHETIC_BODY'})});
  try{assert.equal((await f.run()).phase,'accepted');diagnostic.flush();const text=snapshots.at(-1);assert.ok(text.includes('https_ack'));assert.equal(text.includes('PRIVATE_SYNTHETIC'),false);assert.equal(text.includes('synthetic/asset.jpg'),false);assert.equal(text.includes(digest(jpeg())),false);}finally{diagnostic.end('synthetic');}
});

// Actual SDK request/encryption/pending/timers, with only its socket replaced by
// a test-owned writable sink. No live key/bytes are inspected or printed.
function guardFixture(){
  const client=new (guardReaderClient(CarriageClient,null,{messaging:true}))();let writes=0,destroys=0;
  const socket={destroyed:false,writable:true,write(_bytes,callback){writes++;queueMicrotask(()=>callback?.());return true;},destroy(){destroys++;this.destroyed=true;this.writable=false;}};
  client.socket=socket;client.on('error',()=>{});
  return {client,socket,get writes(){return writes;},get destroys(){return destroys;},body:msg=>({chatId:toLong('123'),msgId:toLong(String(msg)),type:2,msg:'[사진]'}),
    reply(id,msg,extra={}){client.finishPacket({packetId:id,method:'WRITE',status:0,body:{chatId:'123',...(msg===undefined?{}:{msgId:String(msg)}),logId:'201',...extra}});},
    close(){client.disconnect();assert.equal(client.pending.size,0);}};
}
test('real SDK guard preabort sends no bytes and forbidden recoverable/signal policies stay forbidden',async()=>{
  const f=guardFixture(),controller=new AbortController();controller.abort();
  try{await assert.rejects(f.client.request('WRITE',f.body(101),20,{signal:controller.signal}),{code:'READER_REQUEST_ABORTED'});for(const method of ['WRITE','POST'])await assert.rejects(f.client.request(method,{},20,{recoverable:true}));await assert.rejects(f.client.request('PING',{},20,{signal:new AbortController().signal}));assert.equal(f.writes,0);assert.equal(f.client.pending.size,0);}finally{f.close();}
});
test('real SDK guard abort destroys original timer, removes listener and preserves unrelated pending request/socket',async()=>{
  const f=guardFixture(),controller=new AbortController();let other;
  try{
    const first=f.client.request('WRITE',f.body(101),25,{signal:controller.signal});const firstHandled=first.catch(e=>e),entry=[...f.client.pending.values()][0],timer=entry.timer;
    other=f.client.request('WRITE',f.body(102),500);other.catch(()=>{});assert.equal(getEventListeners(controller.signal,'abort').length,1);controller.abort();assert.equal((await firstHandled).code,'READER_REQUEST_ABORTED');
    assert.equal(timer._destroyed,true);assert.equal(f.client.pending.size,1);assert.equal(getEventListeners(controller.signal,'abort').length,0);await sleep(50);assert.equal(f.socket.destroyed,false);assert.equal(f.destroys,0);
    f.reply(2,102);await other;assert.equal(f.client.pending.size,0);
  }finally{f.close();await other?.catch(()=>{});}
});
test('real SDK guard permits strong new ACK reusing a cancelled packet number',async()=>{
  const f=guardFixture(),controller=new AbortController();let second;
  try{const first=f.client.request('WRITE',f.body(101),1000,{signal:controller.signal});first.catch(()=>{});controller.abort();await assert.rejects(first,{code:'READER_REQUEST_ABORTED'});let resolved=false;second=f.client.request('WRITE',f.body(102),1000);second.then(()=>{resolved=true;},()=>{});f.reply(1,102);await flush();assert.equal(resolved,true,'new explicit msgId must override an old response packet number');await second;}finally{f.close();await second?.catch(()=>{});}
});
test('real SDK guard rejects weak/old cancelled ACK on a new packet number and cancelled identity reuse',async()=>{
  const f=guardFixture(),controller=new AbortController();let second;
  try{const first=f.client.request('WRITE',f.body(101),1000,{signal:controller.signal});first.catch(()=>{});controller.abort();await assert.rejects(first,{code:'READER_REQUEST_ABORTED'});let resolved=false;second=f.client.request('WRITE',f.body(102),1000);second.then(()=>{resolved=true;},()=>{});
    f.reply(2,undefined);await flush();assert.equal(resolved,false,'weak late ACK must not settle the newer request');f.reply(2,101);await flush();assert.equal(resolved,false);const wires=f.writes;await assert.rejects(f.client.request('WRITE',f.body(101),1000));assert.equal(f.writes,wires);f.reply(2,102);await second;
  }finally{f.close();await second?.catch(()=>{});}
});
test('real SDK guard normal ACK retires signal listener and later abort cannot destroy the socket',async()=>{
  const f=guardFixture(),controller=new AbortController();try{const pending=f.client.request('WRITE',f.body(101),1000,{signal:controller.signal}),timer=[...f.client.pending.values()][0].timer;f.reply(1,101);await pending;assert.equal(timer._destroyed,true);assert.equal(getEventListeners(controller.signal,'abort').length,0);controller.abort();assert.equal(f.destroys,0);assert.equal(f.client.writeCancellationObserved,false);}finally{f.close();}
});
test('real SDK ordinary WRITE timeout still destroys its socket and cancellation policy does not soften it',async()=>{
  const f=guardFixture();try{await assert.rejects(f.client.request('WRITE',f.body(101),15));assert.equal(f.socket.destroyed,true);assert.equal(f.destroys,1);assert.equal(f.client.pending.size,0);}finally{f.close();}
});
