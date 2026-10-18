// Account-free WRITE contracts. All routing/SDK objects are injected in memory;
// pinned BSON encodes the actual request object, without opening a remote socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {createReaderSession} from '../experiments/local-web/reader-session.mjs';
const {BSON,Long,Int32}=createRequire(new URL('../local-only/spikes/modern/package.json',import.meta.url))('bson');
const credential={userId:'999',deviceUUID:'SYNTHETIC',accessToken:'SYNTHETIC_NO_ACCOUNT'};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const roomId='9007199254740993',linkId='700';
function fixture({kind='OM',entry={},link=true,write}={}){
 const calls=[],events=[],encoded=[];let disconnected=0;
 const carriage=Object.assign(new EventEmitter(),{async connect(){},disconnect(){disconnected++;},stopPing(){},
  async loginList(){return {status:0,body:{chatDatas:[{c:roomId,t:kind,title:'Synthetic WRITE room',ll:'10',...(kind==='DirectChat'?{}:{li:linkId})}]}};},
  async request(method,body){
   calls.push({method,body});
   if(method==='SYNCLINK')return {status:0,body:{ltk:0,ols:link?[{li:linkId,ln:'Synthetic existing link',ac:true}]:[]}};
   if(method==='INFOLINK')return {status:0,body:{ols:[]}};
   if(method==='CHATONROOM')return {status:0,body:{c:roomId,li:linkId,olu:{userId:'999',lmt:2,opt:0,pv:'0'},mt:0,...entry}};
   if(method==='WRITE'){
    encoded.push(BSON.serialize(body));
    return write?await write(body):{status:0,body:{status:0,chatId:roomId,logId:'20',msgId:body.msgId}};
   }
   return {status:0,body:{}};
  }});
 const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};}});
 const session=createReaderSession(credential,{messaging:true,booking:bootstrap,ticket:bootstrap,carriage:()=>carriage,toLong:value=>Long.fromString(String(value)),resolve:async host=>host,every:()=>0},event=>events.push(event));
 return {session,events,calls,encoded,disconnected:()=>disconnected,async start(){assert.equal((await session.start()).ok,true);return events.find(e=>e.type==='reader-rooms'&&e.source==='loginlist').rooms[0].key;},replyTarget(){carriage.emit('push',{method:'MSG',status:0,body:{chatId:roomId,chatLog:{logId:'10',authorId:'111',msg:'Synthetic quoted text',type:1}}});return events.findLast(e=>e.type==='reader-messages').messages[0].key;}};
}
for(const kind of ['DirectChat','OD','OM'])for(const reply of [false,true])test(kind+' '+(reply?'reply':'text')+' uses BSON Int64 msgId, scope1 and silencefalse once',async()=>{
 const f=fixture({kind});try{
  const key=await f.start(),replyTo=reply?f.replyTarget():undefined;
  assert.equal(f.calls.some(c=>['WRITE','NOTIREAD','CHATONROOM','JOINLINK'].includes(c.method)),false,'startup is metadata only');
  assert.equal(await f.session.action(key,1,'send',{text:'Synthetic explicit submit',...(reply?{replyTo}:{})}),true);
  assert.equal(f.encoded.length,1);const body=BSON.deserialize(f.encoded[0],{promoteValues:false}),request=f.calls.find(c=>c.method==='WRITE').body;
  const observed={msgIdIsInt64:Long.isLong(body.msgId),positiveMsgId:BigInt(String(body.msgId))>0n,scopeIsInt32:body.scope instanceof Int32,scope:body.scope?.valueOf()??null,silence:body.silence??null};
  console.log(JSON.stringify({kind,reply,...observed}));
  assert.deepEqual(observed,{msgIdIsInt64:true,positiveMsgId:true,scopeIsInt32:true,scope:1,silence:false});
  assert.ok(Long.isLong(body.chatId));assert.equal(String(body.chatId),roomId);assert.ok(body.type instanceof Int32);assert.equal(body.type.valueOf(),reply?26:1);assert.equal(body.msg,'Synthetic explicit submit');assert.equal(body.noSeen,false,'preserve existing verified read-on-send flag');
  assert.deepEqual(Object.keys(request).sort(),['chatId','msgId','type','noSeen','msg','scope','silence',...(reply?['extra']:[])].sort(),'no speculative open-profile/link/empty extra fields');
  if(reply)assert.equal(JSON.parse(body.extra).src_message,'Synthetic quoted text');else assert.equal(Object.hasOwn(body,'extra'),false);
  assert.equal(f.events.findLast(e=>e.type==='reader-action').phase,'accepted');assert.equal(f.calls.filter(c=>c.method==='NOTIREAD').length,0);assert.equal(f.calls.filter(c=>c.method==='WRITE').length,1);assert.equal(f.disconnected(),0);
 }finally{f.session.close();}
});
test('packet0/body-203 is failed, stays connected and never retries WRITE',async()=>{
 const f=fixture({write:()=>({status:0,body:{status:-203}})});try{const key=await f.start();assert.equal(await f.session.action(key,1,'send',{text:'Synthetic rejected submit'}),true);const result=f.events.findLast(e=>e.type==='reader-action');assert.equal(result.phase,'failed');assert.equal(result.status,-203);assert.equal(f.disconnected(),0);assert.equal(f.events.some(e=>e.type==='reader-failed'),false);await sleep(120);assert.equal(f.calls.filter(c=>c.method==='WRITE').length,1);assert.equal(f.events.some(e=>e.source==='sent'),false);}finally{f.session.close();}
});
for(const [label,write] of [['missing ACK log',body=>({status:0,body:{status:0,msgId:body.msgId}})],['mismatched ACK msgId',()=>({status:0,body:{chatId:roomId,logId:'20',msgId:Long.fromString('9223372036854775807')}})]])test(label+' stays unknown and never resends',async()=>{
 const f=fixture({write});try{const key=await f.start();await f.session.action(key,1,'send',{text:'Synthetic uncertain submit'});assert.equal(f.events.findLast(e=>e.type==='reader-action').phase,'unknown');await sleep(90);assert.equal(f.calls.filter(c=>c.method==='WRITE').length,1);assert.equal(f.events.some(e=>e.source==='sent'),false);}finally{f.session.close();}
});
for(const [label,options] of [['missing verified link',{link:false}],['foreign room context',{entry:{c:'456'}}],['foreign own member',{entry:{olu:{userId:'111',lmt:2,opt:0}}}]])test(label+' prevents all WRITE dispatch',async()=>{
 const f=fixture(options);try{const key=await f.start();await f.session.action(key,1,'send',{text:'Synthetic blocked submit'});assert.equal(f.calls.filter(c=>c.method==='WRITE').length,0);assert.equal(f.disconnected(),0);assert.equal(f.events.some(e=>e.source==='sent'),false);}finally{f.session.close();}
});
