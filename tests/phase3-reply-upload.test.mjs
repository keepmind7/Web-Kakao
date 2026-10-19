import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { decodeImage,inspectImage,replyExtra,IMAGE_LIMIT } from '../experiments/local-web/message-content.mjs';
import { createReaderStore } from '../experiments/local-web/reader-data.mjs';
import { createReadOnlyReader } from '../experiments/local-web/reader-manager.mjs';
import { createReaderSession } from '../experiments/local-web/reader-session.mjs';
import { guardReaderClient } from '../experiments/local-web/reader-protocol.mjs';
import { uploadPhoto,MAX_UPLOAD_CHUNK_BYTES } from '../experiments/local-web/media-upload.mjs';
import { createLocalServer } from '../experiments/local-web/server.mjs';

// Browser control is granted only by the local launcher capability exchange.
async function browserSession(app,url){
  const issue=await fetch(url+'/api/local/launch',{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Local-Control':app.controlToken},body:'{}'});
  assert.equal(issue.status,200);assert.equal(issue.headers.get('set-cookie'),null);
  const {ticket}=await issue.json();assert.match(ticket,/^[a-f0-9]{64}$/);
  const session=await fetch(url+'/api/local/session',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify({ticket})});
  assert.equal(session.status,200);
  assert.equal(session.headers.get('set-cookie'),null);const token=(await session.json()).session;assert.match(token,/^[a-f0-9]{64}$/);
  return {auth:{'x-local-session':token},token,response:session};
}

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const room='r_'+'a'.repeat(24),message='m_'+'b'.repeat(24),uuid='12345678-1234-4123-8123-123456789abc';
const credential={userId:'999',deviceUUID:'SYNTHETIC',accessToken:'FAKE_TOKEN'};
test('reply JSON retains 64-bit numeric identifiers and rejects unsupported targets',()=>{
  const extra=replyExtra({id:'9007199254740993',authorId:'9007199254740995',type:1,text:'<img>한글😀'});
  assert.ok(extra.includes('"src_logId":9007199254740993'));assert.ok(extra.includes('"src_userId":9007199254740995'));
  assert.equal(JSON.parse(extra).src_message,'<img>한글😀');assert.deepEqual(JSON.parse(extra).src_mentions,[]);
  assert.equal(replyExtra({id:'9223372036854775808',authorId:'1',type:1,text:'x'}),null);
  assert.equal(replyExtra({id:'1',authorId:'2',type:98,text:'x'}),null);
});
test('reply resolution is room-scoped, survives receipt views and exposes no raw target IDs',()=>{
  const store=createReaderStore({chatDatas:[{c:'123',t:'DirectChat',i:['111'],k:['합성 상대']},{c:'124',t:'MemoChat'}]},'999');
  const key=store.rooms()[0].key,other=store.rooms()[1].key;
  store.push({chatId:'123',chatLog:{logId:'9007199254740993',authorId:'111',msg:'합성 원문',type:1}});
  const first=store.current(key).messages[0];assert.equal(first.canReply,true);
  assert.ok(store.replyForMessage(key,first.key));assert.equal(store.replyForMessage(other,first.key),null);
  store.writeAccepted(key,{logId:'9007199254740994'},'합성 답장',{type:26,attachment:store.replyForMessage(key,first.key)});
  const reply=store.current(key).messages.at(-1);assert.equal(reply.text,'합성 답장');assert.equal(reply.reply.text,'합성 원문');assert.equal(reply.reply.sender,'합성 상대');
  assert.equal(JSON.stringify(store.current(key)).includes('9007199254740993'),false);assert.equal(Object.hasOwn(first,'replyTarget'),false);
  store.push({chatId:'123',chatLog:{logId:'9007199254740995',authorId:'111',type:2,attachment:'{}'}});assert.equal(store.current(key).messages.at(-1).canReply,true);
  store.clear();assert.equal(store.replyForMessage(key,first.key),null);
});
test('photo admission checks bytes, dimensions, size and canonical base64 instead of filename or MIME',()=>{
  assert.deepEqual(inspectImage(png),{mime:'image/png',width:1,height:1,ext:'png'});
  assert.ok(decodeImage(png.toString('base64')));assert.equal(decodeImage('data:image/png;base64,'+png.toString('base64')),null);
  assert.equal(decodeImage(png.toString('base64')+'\n'),null);assert.equal(decodeImage(Buffer.from('<svg/>').toString('base64')),null);
  const large=Buffer.from(png);large.writeUInt32BE(4097,16);assert.equal(inspectImage(large),null);assert.equal(inspectImage(Buffer.alloc(IMAGE_LIMIT+1)),null);
});
function uploadFixture({offset=0,denial=null,disconnect=false,routeError=false,completeBody}={}){
  const calls=[],bytes=[];let media,expected=png.length-offset;
  return {calls,bytes,options:{carriage:{async request(method,body){calls.push({method,body});return {status:denial==='ship'?-203:0,body:{k:'FAKE_UPLOAD_KEY',vh:'upload.kakao.com',p:443}};}},
    createClient(){media=Object.assign(new EventEmitter(),{async connect(host,port){calls.push({method:'connect',host,port});},async request(method,body){calls.push({method,body});expected=body.s-offset;if(disconnect)throw new Error('PRIVATE');if(expected===0)queueMicrotask(()=>media.emit('push',{method:'COMPLETE',status:0,body:completeBody ?? {status:0,chatLog:{logId:'20',chatId:'123'}}}));return {status:denial==='post'?-203:0,body:{o:offset}};},async writeEncrypted(data){bytes.push(Buffer.from(data));if(bytes.reduce((sum,b)=>sum+b.length,0)===expected)media.emit('push',{method:'COMPLETE',status:0,body:completeBody ?? {status:0,chatLog:{logId:'20',chatId:'123'}}});},disconnect(){}});return media;},
    toLong:String,chatId:'123',userId:'999',messageId:'345',data:png,profile:{os:'android',appVersion:'26.1.2'},resolve:async(host,port)=>{if(routeError)throw new Error('private route');return '1.2.3.4';}}};
}
function syntheticPngWithSize(size){
  // Add a valid private ancillary chunk before IEND. Exact boundary lengths
  // do not depend on compression, production MAX or any user's photo bytes.
  const payload=Buffer.alloc(size-png.length-12),type=Buffer.from('raNd'),length=Buffer.alloc(4),crc=Buffer.alloc(4);
  length.writeUInt32BE(payload.length);let value=0xffffffff;
  for(const byte of Buffer.concat([type,payload])){value^=byte;for(let n=0;n<8;n++)value=(value>>>1)^((value&1)?0xedb88320:0);}
  crc.writeUInt32BE((value^0xffffffff)>>>0);
  return Buffer.concat([png.subarray(0,-12),length,type,payload,crc,png.subarray(-12)]);
}
test('photo uses SHIP and dedicated POST/COMPLETE once, streams remaining bytes and never WRITE',async()=>{
  const f=uploadFixture({offset:10}),outcome=await uploadPhoto(f.options);
  assert.equal(outcome.phase,'accepted');assert.equal(outcome.chatLog.logId,'20');assert.deepEqual(Buffer.concat(f.bytes),png.subarray(10));
  assert.deepEqual(f.calls.map(c=>c.method),['SHIP','connect','POST']);assert.equal(f.calls[1].host,'1.2.3.4');
  assert.equal(f.calls[2].body.f,'photo.png');assert.equal(f.calls[2].body.mm,'45005');assert.equal(f.calls[2].body.w,1);
  // APK25.11.2 and the pinned modern uploader serialize byte counts as int64.
  assert.equal(f.calls[0].body.s,String(png.length));assert.equal(f.calls[2].body.s,String(png.length));
  assert.equal(f.calls[2].body.ex,'{}');
  assert.equal(f.calls[0].body.cs,createHash('sha1').update(png).digest('hex').toUpperCase());
  assert.equal(f.calls[2].body.mid,'345');
});
test('photo failure distinguishes pre-POST, denied and uncertain delivery, with zero retries',async()=>{
  for(const [options,expected] of [[{denial:'ship'},'failed'],[{denial:'post'},'failed'],[{disconnect:true},'unknown'],[{routeError:true},'failed'],[{offset:png.length+1},'unknown']]){
    const f=uploadFixture(options),outcome=await uploadPhoto(f.options);assert.equal(outcome.phase,expected);
    assert.ok(f.calls.filter(c=>c.method==='SHIP').length<=1);assert.ok(f.calls.filter(c=>c.method==='POST').length<=1);
  }
  const f=uploadFixture(),controller=new AbortController();controller.abort();assert.equal((await uploadPhoto({...f.options,signal:controller.signal})).phase,'failed');assert.equal(f.calls.length,0);
});
test('plain-photo POST expresses scope, null supplement and the declared companion mode without changing read consent',async()=>{
  for(const subDeviceMode of [true,false,undefined]){
    const f=uploadFixture(),profile={...f.options.profile,...(subDeviceMode===undefined?{}:{subDeviceMode})};
    assert.equal((await uploadPhoto({...f.options,profile})).phase,'accepted');
    const body=f.calls.find(call=>call.method==='POST').body;
    assert.equal(body.ex,'{}');assert.equal(body.sp,null);assert.equal(body.scp,1);assert.equal(body.silence,false);assert.equal(body.ns,true);
    if(subDeviceMode===undefined)assert.equal(Object.hasOwn(body,'dt'),false);
    else assert.equal(body.dt,subDeviceMode?4:1);
  }
});
test('a COMPLETE already received with a full resume offset is not missed',async()=>{
  const f=uploadFixture({offset:png.length});assert.equal((await uploadPhoto(f.options)).phase,'accepted');assert.equal(f.bytes.length,0);
});
test('the remaining large payload uses bounded encrypted frames and an uppercase checksum',async()=>{
  const data=Buffer.concat([png,Buffer.alloc(787000)]),f=uploadFixture({offset:17}),steps=[];
  const outcome=await uploadPhoto({...f.options,data,observe:e=>steps.push(e)});
  assert.equal(outcome.phase,'accepted');assert.equal(f.bytes.length,Math.ceil((data.length-17)/MAX_UPLOAD_CHUNK_BYTES));assert.deepEqual(Buffer.concat(f.bytes),data.subarray(17));
  assert.ok(f.bytes.every(b=>b.length+12+16<=131068));
  assert.ok(f.bytes.every(b=>b.length<=65536),'reference outbound 64KiB policy is independent of the receive-frame cap');
  assert.equal(f.calls[0].body.cs,createHash('sha1').update(data).digest('hex').toUpperCase());
  assert.equal(steps.find(e=>e.stage==='await_complete').sentBytes,data.length);
  assert.equal(steps.find(e=>e.stage==='received_complete').status,0);
});
for(const size of [65535,65536,65537,131072,131073,629748])test('reference outbound 64KiB literal boundary preserves a '+size+' byte synthetic PNG',async()=>{
  const data=syntheticPngWithSize(size),f=uploadFixture();
  assert.equal(data.length,size);assert.ok(inspectImage(data));
  const result=await uploadPhoto({...f.options,data});
  assert.equal(result.phase,'accepted');assert.deepEqual(Buffer.concat(f.bytes),data);
  assert.deepEqual(f.calls.map(call=>call.method),['SHIP','connect','POST']);
  // Fixed reference: modern media-upload.ts at 8dbbd4f7 streamEncryptedFile
  // uses highWaterMark 64*1024. This asserts source compatibility, not a live
  // service limit; no test peer is made to reject otherwise valid frames.
  assert.ok(f.bytes.every(chunk=>chunk.length<=65536));
  assert.equal(f.bytes.length,Math.ceil(size/65536));
});
test('upload diagnostics isolate numeric offset and transfer stages without recording the token or image',async()=>{
  const f=uploadFixture({offset:-1}),steps=[];
  const result=await uploadPhoto({...f.options,observe:details=>steps.push(details)});
  assert.equal(result.phase,'unknown');assert.equal(steps.find(s=>s.stage==='offset').offset,-1);
  assert.equal(steps.at(-1).failure,'invalid_offset');assert.equal(f.bytes.length,0);
  const serialized=JSON.stringify(steps);for(const privateValue of ['FAKE_UPLOAD_KEY','upload.kakao.com',png.toString('base64')])assert.equal(serialized.includes(privateValue),false);
});
test('media guard allows only POST in a messaging-enabled dedicated client',async()=>{
  class Client extends EventEmitter{constructor(){super();this.pending=new Map();}async request(){return {status:0,body:{}};}}
  const On=guardReaderClient(Client,null,{messaging:true,media:true}),Off=guardReaderClient(Client,null,{media:true});
  assert.equal((await new On().request('POST',{})).status,0);await assert.rejects(new Off().request('POST',{}));
  for(const method of ['WRITE','SHIP','LOGINLIST','DELETEMSG'])await assert.rejects(new On().request(method,{}));
  await assert.rejects(new (guardReaderClient(Client,null,{messaging:true}))().request('POST',{}));
});
test('photo message identity is explicit and invalid IDs fail before any network request',async()=>{
  for(const value of [undefined,'0','-1','9223372036854775808']){const f=uploadFixture();assert.equal((await uploadPhoto({...f.options,messageId:value})).phase,'failed');assert.equal(f.calls.length,0);}
});
function childFixture(){return Object.assign(new EventEmitter(),{sent:[],send(data,callback){this.sent.push(data);callback?.();},kill(){}});}
function ready(child){child.emit('message',{type:'reader-ready'});child.emit('message',{type:'reader-rooms',source:'loginlist',rooms:[{key:room,canSend:true,kind:'DirectChat'}]});child.emit('message',{type:'reader-messages',source:'push',key:room,messages:[{key:message,text:'원문',canReply:true}]});}
test('manager idempotency includes reply and photo content, and never resends unknown photos',()=>{
  const child=childFixture(),reader=createReadOnlyReader({messaging:true,spawn:()=>child});
  try{
    reader.connect(credential);ready(child);assert.equal(reader.sendText(room,'답장',uuid,message),true);assert.equal(reader.sendText(room,'답장',uuid,message),true);assert.equal(reader.sendText(room,'답장',uuid),false);assert.equal(reader.sendPhoto(room,png.toString('base64'),uuid),false);
    const action=child.sent.at(-1);child.emit('message',{type:'reader-action',key:room,requestId:action.requestId,action:'send',phase:'accepted'});
    const imageId='22345678-1234-4123-8123-123456789abc';assert.equal(reader.sendPhoto(room,png.toString('base64'),imageId),true);reader.disconnect();assert.equal(reader.messages(room).outbox.at(-1).phase,'unknown');assert.equal(reader.sendPhoto(room,png.toString('base64'),imageId),true);
    assert.equal(child.sent.filter(m=>m.action==='photo').length,1);assert.equal(JSON.stringify(reader.messages(room)).includes(png.toString('base64')),false);
  }finally{reader.close();}
});
test('an evicted or foreign reply target is rejected before dispatch without disconnecting',()=>{
  const child=childFixture(),reader=createReadOnlyReader({messaging:true,spawn:()=>child});try{
    reader.connect(credential);ready(child);assert.equal(reader.sendText(room,'답장',uuid,'m_'+'c'.repeat(24)),false);
    assert.equal(reader.sendText(room,'답장',uuid,message),true);const action=child.sent.at(-1);child.emit('message',{type:'reader-request-rejected',key:room,requestId:action.requestId});
    assert.equal(reader.messages(room).outbox[0].phase,'failed');assert.equal(reader.snapshot().phase,'connected');
  }finally{reader.close();}
});
function sessionFixture(uploadOptions){
  const f=uploadFixture(uploadOptions),events=[];
  const carriage=Object.assign(new EventEmitter(),{connect:async()=>{},stopPing(){},disconnect(){},loginList:async()=>({status:0,body:{chatDatas:[{c:'123',t:'DirectChat',ll:'10'}]}}),request:async(method,body)=>{if(method==='SHIP')return f.options.carriage.request(method,body);f.calls.push({method,body});return {status:0,body:{logId:'20',msgId:body.msgId}};}});
  const client=()=>Object.assign(new EventEmitter(),{connect:async()=>{},disconnect(){},request:async()=>({status:0,body:{ticket:{lsl:['ticket.kakao.com']},wifi:{ports:[443]}}}),checkin:async()=>({status:0,host:'carriage.kakao.com',port:443})});
  const factory={messaging:true,booking:client,ticket:client,carriage:()=>carriage,media:f.options.createClient,resolveUpload:f.options.resolve,toLong:String,resolve:async h=>h,every:()=>0};
  return {f,events,carriage,session:createReaderSession(credential,factory,e=>events.push(e))};
}
test('session constructs type26 from a real cached target and photo COMPLETE without a second WRITE',async()=>{
  const {session,events,carriage,f}=sessionFixture();try{
    await session.start();const key=events[0].rooms[0].key;
    carriage.emit('push',{method:'MSG',status:0,body:{chatId:'123',chatLog:{logId:'10',authorId:'111',msg:'합성 원문',type:1}}});
    const target=events.find(e=>e.type==='reader-messages').messages[0].key;
    assert.equal(await session.action(key,1,'send',{text:'답장',replyTo:target}),true);const write=f.calls.find(c=>c.method==='WRITE');assert.equal(write.body.type,26);assert.equal(JSON.parse(write.body.extra).src_message,'합성 원문');
    assert.equal(await session.action(key,2,'photo',{image:png.toString('base64')}),true);assert.equal(f.calls.filter(c=>c.method==='WRITE').length,1);
    assert.equal(f.calls.find(c=>c.method==='POST').body.mid,String(BigInt(String(write.body.msgId))+1n));
    assert.equal(events.filter(e=>e.type==='reader-action').at(-1).phase,'accepted');
  }finally{session.close();}
});
test('photo completion keeps verified outer room identity through session and store without fabricating a chatLog room',async()=>{
  const completeBody={status:0,c:'123',chatLog:{logId:'20',authorId:'999',type:2}},f=sessionFixture({completeBody});
  try{
    await f.session.start();const key=f.events[0].rooms[0].key;
    await f.session.action(key,1,'photo',{image:png.toString('base64')});
    assert.equal(f.events.findLast(event=>event.type==='reader-action').phase,'accepted');
    assert.equal(f.events.findLast(event=>event.source==='sent').messages.at(-1).mine,true);
    assert.equal(Object.hasOwn(completeBody.chatLog,'chatId'),false);
    assert.equal(f.f.calls.filter(call=>call.method==='WRITE').length,0);
  }finally{f.session.close();}
});

const deferredUpload=()=>{let resolve;return {promise:new Promise(done=>{resolve=done;}),resolve:value=>resolve(value)};};
function heldUpload(stage){
  const f=uploadFixture(),begun=deferredUpload(),release=deferredUpload();
  const hold=async result=>{begun.resolve();await release.promise;return result;};
  if(stage==='ship'){
    const request=f.options.carriage.request;f.options.carriage.request=async(...args)=>hold(await request(...args));
  }else if(stage==='route'){
    const resolve=f.options.resolve;f.options.resolve=async(...args)=>hold(await resolve(...args));
  }
  const createClient=f.options.createClient;
  f.options.createClient=()=>{
    const media=createClient();
    if(stage==='connect'){const connect=media.connect;media.connect=async(...args)=>hold(await connect(...args));}
    if(stage==='post'){const request=media.request;media.request=async(...args)=>hold(await request(...args));}
    return media;
  };
  return {...f,begun,release};
}

for(const stage of ['ship','route','connect','post'])test('review: media current-context predicate cancels at '+stage+' with no retry',async()=>{
  const f=heldUpload(stage);let current=true;
  const pending=uploadPhoto({...f.options,isCurrent:()=>current});
  await f.begun.promise;current=false;f.release.resolve();
  const result=await pending;
  assert.equal(result.phase,stage==='post'?'unknown':'failed');
  assert.equal(f.calls.filter(call=>call.method==='POST').length,stage==='post'?1:0);
  assert.equal(f.bytes.length,0);assert.equal(f.calls.filter(call=>call.method==='SHIP').length,1);assert.equal(f.calls.some(call=>call.method==='WRITE'),false);
});

for(const stage of ['ship','route','connect','post'])for(const method of ['SYNCLINKDL','LEFT','SYNCMEMT'])test('review: open photo '+stage+' invalidation '+method+' revokes the captured authorization',async()=>{
  const f=heldUpload(stage),events=[];
  const carriage=Object.assign(new EventEmitter(),{async connect(){},stopPing(){},disconnect(){},async loginList(){return {status:0,body:{chatDatas:[{c:'123',t:'OM',li:'700',title:'Synthetic open',ll:'10'}]}};},async request(method,body){
    if(method==='SHIP')return f.options.carriage.request(method,body);
    f.calls.push({method,body});
    if(method==='SYNCLINK')return {status:0,body:{ltk:0,ols:[{li:'700',ac:true}],dlis:[]}};
    if(method==='CHATONROOM')return {status:0,body:{c:'123',li:'700',olu:{userId:'999',lmt:2,opt:0},mt:0}};
    throw new Error('unexpected synthetic request');
  }});
  const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['ticket.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'carriage.kakao.com',port:443};}});
  const session=createReaderSession(credential,{messaging:true,booking:bootstrap,ticket:bootstrap,carriage:()=>carriage,media:f.options.createClient,resolveUpload:f.options.resolve,toLong:String,resolve:async h=>h,every:()=>0},event=>events.push(event));
  try{
    await session.start();const key=events.find(event=>event.source==='loginlist').rooms[0].key;
    await session.action(key,1,'context');const pending=session.action(key,2,'photo',{image:png.toString('base64')});await f.begun.promise;
    carriage.emit('push',{method,status:0,body:method==='SYNCLINKDL'?{li:'700'}:method==='LEFT'?{c:'123',userId:'999'}:{c:'123',li:'700',mids:['999'],mts:[8]}});
    f.release.resolve();await pending;
    assert.equal(events.findLast(event=>event.type==='reader-action').phase,stage==='post'?'unknown':'failed');
    assert.equal(f.calls.filter(call=>call.method==='POST').length,stage==='post'?1:0);
    assert.equal(f.bytes.length,0);assert.equal(f.calls.filter(call=>call.method==='SHIP').length,1);assert.equal(f.calls.some(call=>call.method==='WRITE'),false);
  }finally{f.release.resolve();session.close();}
});

for(const stage of ['ship','route','connect','post'])test('review: abort releases a stalled '+stage+' wait before its transport result returns',async()=>{
  const f=heldUpload(stage),controller=new AbortController();let timer;
  try{
    const pending=uploadPhoto({...f.options,signal:controller.signal});await f.begun.promise;controller.abort();
    const result=await Promise.race([pending,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('abort did not release pending synthetic operation')),500);})]);
    assert.equal(result.phase,stage==='post'?'unknown':'failed');
    assert.equal(f.calls.filter(call=>call.method==='POST').length,stage==='post'?1:0);assert.equal(f.bytes.length,0);
  }finally{clearTimeout(timer);f.release.resolve();}
});
test('image and reply HTTP routes require auth/CSRF, exact fields and valid actual image bytes',async()=>{
  let sent=0,quoted;
  const app=createLocalServer({mode:'live',messaging:true,encode:()=>[[true]],transport:async op=>op==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:op==='generate'?{httpStatus:200,body:{status:0,url:'OFFLINE',remainingSeconds:60}}:{httpStatus:200,body:{status:0,user:{userId:'999'},accessToken:'FAKE'}},readerFactory:()=>({snapshot:()=>({phase:'connected'}),close(){},sendPhoto(){sent++;return true;},sendText(_room,_text,_uuid,replyTo){quoted=replyTo;return true;}})});
  const url=await app.listen(0);try{
    const {auth}=await browserSession(app,url),status=await(await fetch(url+'/api/status',{headers:auth})).json();
    const post=(path,body,origin=url)=>fetch(url+path,{method:'POST',headers:{...auth,origin,'Content-Type':'application/json','X-CSRF-Token':status.csrf},body:JSON.stringify(body)}),image={room,clientId:uuid,image:png.toString('base64')};
    assert.equal((await post('/api/reader/photo',image)).status,409);await app.lab.start();for(let i=0;i<300 && !app.lab.snapshot().credentialInMemory;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal((await post('/api/reader/photo',image,'https://evil.test')).status,403);
    for(const body of [{...image,url:'https://evil.test'}, {...image,image:'PHN2Zz4='},{...image,replyTo:message}])assert.equal((await post('/api/reader/photo',body)).status,400);
    assert.equal((await post('/api/reader/photo',image)).status,202);assert.equal(sent,1);
    assert.equal((await post('/api/reader/send',{room,text:'답장',clientId:uuid,replyTo:message})).status,202);assert.equal(quoted,message);
    assert.equal((await post('/api/reader/send',{room,text:'답장',clientId:uuid,replyTo:'123'})).status,400);
  }finally{app.lab.cancel();app.server.close();app.server.closeAllConnections();}
});
