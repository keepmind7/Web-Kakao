import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { uploadPhoto } from '../experiments/local-web/media-upload.mjs';
import { createReaderSession } from '../experiments/local-web/reader-session.mjs';

// Every transport here is injected; no DNS, socket, account or browser access.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const credential={userId:'999',deviceUUID:'SYNTHETIC',accessToken:'FAKE_TOKEN'};
function uploadFixture({deny,unknown=false,holdShip=false}={}){
  const calls=[],bytes=[];let media,releaseShip,shipStarted;
  const begun=new Promise(resolve=>{shipStarted=resolve;});
  const options={carriage:{async request(method,body){calls.push({method,body});if(holdShip){shipStarted();await new Promise(resolve=>{releaseShip=resolve;});}return {status:deny==='SHIP'?-203:0,body:{k:'SYNTHETIC',vh:'unused.invalid',p:443}};}},
    createClient(){media=Object.assign(new EventEmitter(),{async connect(){calls.push({method:'connect'});},async request(method,body){calls.push({method,body});return {status:deny==='POST'?-203:0,body:{o:0}};},async writeEncrypted(data){bytes.push(Buffer.from(data));if(unknown)media.emit('disconnected');else media.emit('push',{method:'COMPLETE',status:0,body:{chatLog:{logId:'30',chatId:'123',authorId:'999',type:2}}});},disconnect(){}});return media;},
    toLong:String,chatId:'123',userId:'999',messageId:'345',data:png,resolve:async()=> '127.0.0.1',profile:{os:'android',appVersion:'26.1.2',subDeviceMode:true}};
  return {options,calls,bytes,begun,release:()=>releaseShip?.()};
}
function sessionFixture({kind='DirectChat',writeMode,upload={}}={}){
  const f=uploadFixture(upload),events=[];
  const open=['OD','OM'].includes(kind);
  const carriage=Object.assign(new EventEmitter(),{async connect(){},stopPing(){},disconnect(){},async loginList(){return {status:0,body:{chatDatas:[{c:'123',t:kind,title:'Synthetic first',ll:'10',...(open?{li:'700'}:{})},{c:'124',t:'DirectChat',title:'Synthetic other',ll:'10'}]}};},async request(method,body){
    if(method==='SHIP')return f.options.carriage.request(method,body);
    f.calls.push({method,body});
    if(method==='SYNCLINK')return {status:0,body:{ltk:0,ols:[{li:'700',ac:true}],dlis:[]}};
    if(method==='CHATONROOM')return {status:0,body:open?{c:'123',li:'700',olu:{userId:'999',lmt:2,opt:0},mt:0}:{c:'123',m:[{userId:'999'},{userId:'111'}],a:['111'],w:['0']}};
    if(method==='WRITE'){
      if(writeMode==='unknown')throw new Error('synthetic timeout');
      if(writeMode==='failed')return {status:-203,body:{}};
      return {status:0,body:{chatId:String(body.chatId),logId:'20',msgId:body.msgId}};
    }
    throw new Error('unexpected synthetic method '+method);
  }});
  const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['ticket.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'carriage.kakao.com',port:443};}});
  const session=createReaderSession(credential,{messaging:true,booking:bootstrap,ticket:bootstrap,carriage:()=>carriage,media:f.options.createClient,resolveUpload:f.options.resolve,toLong:String,resolve:async host=>host,every:()=>0},event=>events.push(event));
  return {...f,session,carriage,events,key:()=>events.find(event=>event.source==='loginlist').rooms.find(room=>room.title==='Synthetic first').key,other:()=>events.find(event=>event.source==='loginlist').rooms.find(room=>room.title==='Synthetic other').key,
    quote(){carriage.emit('push',{method:'MSG',status:0,body:{chatId:'123',chatLog:{chatId:'123',logId:'10',authorId:'111',msg:'Synthetic quoted message',type:1}}});return events.findLast(event=>event.type==='reader-messages').messages[0].key;}};
}
function noExtraRead(calls){assert.equal(calls.filter(call=>call.method==='NOTIREAD').length,0,'send must not append a separate read request');}

for(const kind of ['DirectChat','OM'])for(const reply of [false,true])test(`explicit ${kind} ${reply?'reply':'text'} uses its scoped WRITE read flag without extra NOTIREAD`,async()=>{
  const f=sessionFixture({kind});
  try{
    assert.deepEqual(await f.session.start(),{ok:true});const key=f.key(),target=reply?f.quote():undefined;
    assert.equal(await f.session.action(key,1,'send',{text:'Synthetic explicit send',...(reply?{replyTo:target}:{})}),true);
    const writes=f.calls.filter(call=>call.method==='WRITE');assert.equal(writes.length,1);assert.equal(writes[0].body.chatId,'123');assert.equal(writes[0].body.type,reply?26:1);
    if(reply)assert.equal(JSON.parse(writes[0].body.extra).src_message,'Synthetic quoted message');
    assert.equal(f.events.findLast(event=>event.type==='reader-action').phase,'accepted');noExtraRead(f.calls);
    assert.equal(writes[0].body.noSeen,false,'an explicit send in a read-capable room must permit its own read synchronization');
  }finally{f.session.close();}
});
for(const kind of ['DirectChat','OM'])test(`explicit ${kind} photo opts in through the session/helper boundary`,async()=>{
  const f=sessionFixture({kind});
  try{
    await f.session.start();assert.equal(await f.session.action(f.key(),1,'photo',{image:png.toString('base64')}),true);
    assert.equal(f.events.findLast(event=>event.type==='reader-action').phase,'accepted');
    assert.equal(f.calls.filter(call=>call.method==='SHIP').length,1);const posts=f.calls.filter(call=>call.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].body.c,'123');assert.equal(posts[0].body.scp,1);assert.equal(posts[0].body.silence,false);assert.equal(posts[0].body.dt,4);assert.equal(f.calls.filter(call=>call.method==='WRITE').length,0);noExtraRead(f.calls);
    assert.equal(posts[0].body.ns,false,'session must explicitly opt in while standalone helper default remains conservative');
  }finally{f.session.close();}
});
test('standalone photo helper retains ns true by default and explicit readOnSend false',async()=>{
  for(const option of [{},{readOnSend:false}]){const f=uploadFixture();const result=await uploadPhoto({...f.options,...option});assert.equal(result.phase,'accepted');assert.equal(f.calls.find(call=>call.method==='POST').body.ns,true);noExtraRead(f.calls);}
});
test('standalone photo helper readOnSend true changes only its POST read option',async()=>{
  const f=uploadFixture();assert.equal((await uploadPhoto({...f.options,readOnSend:true})).phase,'accepted');
  const post=f.calls.find(call=>call.method==='POST').body;assert.equal(post.scp,1);assert.equal(post.silence,false);assert.equal(post.dt,4);assert.equal(post.sp,null);assert.equal(post.ex,'{}');assert.deepEqual(f.calls.map(call=>call.method),['SHIP','connect','POST']);noExtraRead(f.calls);assert.equal(post.ns,false);
});
test('nonboolean readOnSend values fail before SHIP DNS media construction or POST',async()=>{
  for(const value of [null,0,1,'true','false',{},[]]){
    const f=uploadFixture();let resolves=0,clients=0;
    const outcome=await uploadPhoto({...f.options,readOnSend:value,resolve:async()=>{resolves++;return '127.0.0.1';},createClient(){clients++;return f.options.createClient();}});
    assert.equal(outcome.phase,'failed',`invalid option type ${value===null?'null':typeof value}`);assert.equal(f.calls.length,0);assert.equal(resolves,0);assert.equal(clients,0);
  }
});
for(const mode of ['failed','unknown'])test(`explicit text ${mode} result never auto-retries or adds read requests`,async()=>{
  const f=sessionFixture({writeMode:mode});
  try{await f.session.start();assert.equal(await f.session.action(f.key(),1,'send',{text:'Synthetic explicit send'}),true);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.events.findLast(event=>event.type==='reader-action').phase,mode);assert.equal(f.calls.filter(call=>call.method==='WRITE').length,1);noExtraRead(f.calls);}finally{f.session.close();}
});
for(const [upload,phase,posts] of [[{deny:'SHIP'},'failed',0],[{deny:'POST'},'failed',1],[{unknown:true},'unknown',1]])test(`photo ${upload.deny||'COMPLETE unknown'} preserves outcome and performs zero retries`,async()=>{
  const f=uploadFixture(upload);const outcome=await uploadPhoto({...f.options,readOnSend:true});await new Promise(resolve=>setImmediate(resolve));assert.equal(outcome.phase,phase);assert.equal(f.calls.filter(call=>call.method==='SHIP').length,1);assert.equal(f.calls.filter(call=>call.method==='POST').length,posts);assert.equal(f.calls.filter(call=>call.method==='WRITE').length,0);noExtraRead(f.calls);
});
test('an unknown room kind cannot gain send or read permissions from the new policy',async()=>{
  const f=sessionFixture({kind:'unknown'});
  try{await f.session.start();assert.equal(await f.session.action(f.key(),1,'send',{text:'Synthetic blocked'}),false);assert.equal(await f.session.action(f.key(),2,'photo',{image:png.toString('base64')}),false);assert.equal(f.calls.length,0);}finally{f.session.close();}
});
test('a foreign reply target causes zero WRITE and read requests in the other room',async()=>{
  const f=sessionFixture();try{await f.session.start();const target=f.quote();assert.equal(await f.session.action(f.other(),1,'send',{text:'Synthetic foreign reply',replyTo:target}),false);assert.equal(f.calls.length,0);}finally{f.session.close();}
});
test('open-photo read authorization invalidated during SHIP cancels before media POST',async()=>{
  const f=sessionFixture({kind:'OM',upload:{holdShip:true}});
  try{await f.session.start();const key=f.key();const pending=f.session.action(key,1,'photo',{image:png.toString('base64')});await f.begun;
    f.carriage.emit('push',{method:'SYNCMEMT',status:0,body:{c:'123',li:'700',mids:['999'],mts:[8]}});f.release();await pending;
    assert.equal(f.events.findLast(event=>event.type==='reader-action').phase,'failed');assert.equal(f.calls.filter(call=>call.method==='SHIP').length,1);assert.equal(f.calls.filter(call=>call.method==='POST').length,0);noExtraRead(f.calls);
  }finally{f.release();f.session.close();}
});
