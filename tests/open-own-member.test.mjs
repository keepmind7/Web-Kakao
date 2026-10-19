// Synthetic SDK/session/manager/diagnostic contracts; no remote socket/account.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {createReaderSession} from '../experiments/local-web/reader-session.mjs';
import {createReadOnlyReader} from '../experiments/local-web/reader-manager.mjs';
import {createReaderDiagnostic} from '../experiments/local-web/reader-diagnostics.mjs';
const {Long}=createRequire(new URL('../local-only/spikes/modern/package.json',import.meta.url))('bson');
const own='999',room='9007199254740993',link='700',credential={userId:own,deviceUUID:'SYNTHETIC',accessToken:'SYNTHETIC_NO_ACCOUNT'},clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve};};
const member=(patch={})=>({userId:own,type:1000,mt:2,opt:0,nickname:'Synthetic self',...patch});
const valid=(members=[member()],patch={})=>({status:0,body:{chatId:room,members,...patch}});
function fixture({kind='OM',entry={},answer=valid(),active=true,messaging=true,write,onEvent=()=>{}}={}){
 const calls=[],events=[],trace=[];let disconnected=0;
 const carriage=Object.assign(new EventEmitter(),{async connect(){},disconnect(){disconnected++;},stopPing(){},async loginList(){return {status:0,body:{chatDatas:[{c:room,t:kind,title:'Synthetic room',...(kind==='DirectChat'?{}:{li:link})},{c:'456',t:'DirectChat',title:'Other synthetic room'}]}};},async request(method,body,timeout,policy){
  calls.push({method,body,timeout,policy});
  if(method==='SYNCLINK')return {status:0,body:{ltk:0,ols:[{li:link,ac:active,ln:'Synthetic link'}]}};
  if(method==='INFOLINK')return {status:0,body:{ols:[]}};
  if(method==='CHATONROOM')return {status:0,body:{c:room,li:link,o:'10',mt:0,...entry}};
  if(method==='MEMBER')return typeof answer==='function'?await answer(body):answer;
  if(method==='WRITE')return write?await write(body):{status:0,body:{chatId:room,logId:'20',msgId:body.msgId}};
  return {status:0,body:{}};
 }});
 const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};}});
 const session=createReaderSession(credential,{messaging,photoTransport:'loco',booking:bootstrap,ticket:bootstrap,carriage:()=>carriage,toLong:value=>Long.fromString(String(value)),resolve:async host=>host,every:()=>0,observeSend:row=>trace.push(row),media:()=>{assert.fail('pre-WRITE blocked photo must never open upload');}},row=>{events.push(row);onEvent(row);});
 return {session,carriage,calls,events,trace,disconnected:()=>disconnected,count:method=>calls.filter(c=>c.method===method).length,async start(){assert.equal((await session.start()).ok,true);return events.find(e=>e.type==='reader-rooms'&&e.source==='loginlist').rooms.find(r=>r.kind!=='DirectChat'||kind==='DirectChat').key;}};
}
const outcome=f=>f.events.findLast(e=>e.type==='reader-action');
const noSend=f=>{for(const method of ['WRITE','SHIP','POST','NOTIREAD','JOINLINK'])assert.equal(f.count(method),0,method);assert.equal(f.disconnected(),0);assert.equal(f.events.some(e=>e.type==='reader-failed'),false);};
for(const kind of ['OD','OM'])for(const role of [1,2,4])test(kind+' missing olu verifies exactly own MEMBER role'+role+' before one WRITE',async()=>{
 const f=fixture({kind,answer:valid([member({mt:role,lmt:8})])});try{const key=await f.start();assert.equal(f.count('MEMBER'),0);await f.session.action(key,1,'send',{text:'Synthetic explicit text'});assert.equal(f.count('MEMBER'),1,'missing own context requires one self lookup');const req=f.calls.find(c=>c.method==='MEMBER');assert.deepEqual(Object.keys(req.body).sort(),['chatId','memberIds']);assert.ok(Long.isLong(req.body.chatId));assert.equal(String(req.body.chatId),room);assert.equal(req.body.memberIds.length,1);assert.ok(Long.isLong(req.body.memberIds[0]));assert.equal(String(req.body.memberIds[0]),own);assert.ok(req.timeout>0&&req.timeout<=2500);assert.equal(req.policy.optional,true);assert.equal(outcome(f).phase,'accepted');assert.equal(f.count('WRITE'),1);assert.equal(f.count('NOTIREAD'),0);await f.session.action(key,2,'send',{text:'Second explicit text'});assert.equal(f.count('MEMBER'),1,'successful same entry cache reused');assert.equal(f.count('WRITE'),2);assert.equal(f.disconnected(),0);}finally{f.session.close();}
});
for(const [name,options] of [['full olu',{entry:{olu:{userId:own,lmt:2,opt:0}}}],['normal room',{kind:'DirectChat'}]])test(name+' retains existing send and makes no own MEMBER lookup',async()=>{const f=fixture(options);try{const key=await f.start();await f.session.action(key,1,'send',{text:'Synthetic'});assert.equal(f.count('MEMBER'),0);assert.equal(f.count('WRITE'),1);assert.equal(outcome(f).phase,'accepted');}finally{f.session.close();}});
for(const [name,entry] of [['explicit null olu',{olu:null}],['foreign olu',{olu:{userId:'111',lmt:2}}],['invalid role olu',{olu:{userId:own,lmt:8}}],['bad entry token',{o:'invalid'}],['bad mute',{mt:-1}],['conflicting room',{chatId:'456'}],['conflicting link',{li:'701'}]])test(name+' never falls back or dispatches send',async()=>{
 const f=fixture({entry});try{const key=await f.start();await f.session.action(key,1,'send',{text:'Synthetic blocked'});assert.equal(f.count('MEMBER'),0);noSend(f);}finally{f.session.close();}
});
const invalidCases=[['foreign member',valid([member({userId:'111'})])],['duplicate own',valid([member(),member()])],['extra foreign member',valid([member(),member({userId:'111'})])],['missing member',valid([])],['missing type',valid([{userId:own,mt:2}])],['wrong type',valid([member({type:1})])],['missing mt despite lmt',valid([{userId:own,type:1000,lmt:2}])],['bot role8',valid([member({mt:8})])],['string role',valid([member({mt:'2'})])],['invalid opt',valid([member({opt:1.5})])],['foreign room',valid([member()],{chatId:'456'})],['conflicting room alias',valid([member()],{c:'456'})],['foreign supplied link',valid([member()],{li:'701'})],['server rejection',{status:0,body:{status:-203}}],['optional timeout',()=>{throw Object.assign(new Error('SYNTHETIC_TIMEOUT'),{code:'READER_REQUEST_TIMEOUT'});}]];
for(const [name,answer] of invalidCases)test('missing olu '+name+' is pre-WRITE failed with fixed reason, healthy and no auto retry',async()=>{
 const f=fixture({answer});try{const key=await f.start();await f.session.action(key,1,'send',{text:'Synthetic blocked'});assert.equal(outcome(f).phase,'failed','no WRITE was attempted, so unavailable/unknown is false uncertainty');assert.equal(outcome(f).reason,'open_member_unverified');assert.equal(f.count('MEMBER'),1);noSend(f);await sleep(20);assert.equal(f.count('MEMBER'),1);}finally{f.session.close();}
});
test('MEMBER opt may be absent and member mt never overwrites entry mute',async()=>{
 const f=fixture({entry:{mt:3600},answer:valid([{userId:own,type:1000,mt:2}])});try{const key=await f.start();await f.session.action(key,1,'send',{text:'Synthetic muted'});assert.equal(f.count('MEMBER'),1);noSend(f);assert.equal(outcome(f).phase,'failed');assert.ok(outcome(f).reason===undefined||outcome(f).reason==='open_member_unverified','verified mute refusal may retain neutral reason');const row=f.events.findLast(e=>e.type==='reader-rooms').rooms.find(r=>r.key===key);assert.equal(row.canText,false);assert.equal(row.canRead,true,'valid own role permits read but entry mute still prevents writing');}finally{f.session.close();}
});
for(const mutation of ['link revoked','member revision','room selection','account close'])test('held self MEMBER cannot grant after '+mutation,async()=>{
 const hold=deferred(),f=fixture({answer:()=>hold.promise});let completed=false,action;try{const key=await f.start();action=f.session.action(key,1,'send',{text:'Synthetic held'}).finally(()=>{completed=true;});for(let n=0;n<30&&!f.count('MEMBER')&&!completed;n++)await sleep(2);assert.equal(f.count('MEMBER'),1,'real self lookup must be in flight');
  if(mutation==='link revoked')f.carriage.emit('push',{method:'SYNCLINKDL',status:0,body:{li:link,ac:false}});
  else if(mutation==='member revision')f.carriage.emit('push',{method:'SYNCMEMT',status:0,body:{c:room,li:link}});
  else if(mutation==='room selection'){const second=f.events.find(e=>e.type==='reader-rooms').rooms.find(r=>r.key!==key).key;f.session.view(second);}
  else f.session.close();
  hold.resolve(valid());await action;assert.equal(f.count('WRITE'),0);assert.equal(f.events.some(e=>e.type==='reader-action'&&e.phase==='accepted'),false);
 }finally{hold.resolve(valid());await action;f.session.close();}
});
for(const [name,write] of [['missing ACK',()=>({status:0,body:{status:0}})],['mismatched ACK',()=>({status:0,body:{chatId:room,logId:'20',msgId:'99999999999'}})],['WRITE timeout',()=>{throw Object.assign(new Error('SYNTHETIC'),{code:'READER_REQUEST_TIMEOUT'});}]])test('after verified fallback '+name+' remains unknown without retry',async()=>{
 const f=fixture({write});try{const key=await f.start();await f.session.action(key,1,'send',{text:'Synthetic uncertain'});assert.equal(f.count('MEMBER'),1);assert.equal(f.count('WRITE'),1);assert.equal(outcome(f).phase,'unknown');assert.equal(outcome(f).reason==='open_member_unverified',false);await sleep(30);assert.equal(f.count('WRITE'),1);}finally{f.session.close();}
});
function memoryPreferences(){return {account:()=>({snapshot:()=>({persist:false,notifications:false,readSync:false,roomFilter:'all',storageAvailable:false,storageError:false}),room:()=>null,key:()=>Buffer.alloc(32,7),close(){}}),close(){}};}
test('session pre-WRITE refusal reaches manager public outbox as failed, fixed reason and no unknown',async()=>{
 const child=Object.assign(new EventEmitter(),{sent:[],send(row,callback){this.sent.push(row);callback?.();},kill(){}}),reader=createReadOnlyReader({messaging:true,spawn:()=>child,preferenceStore:memoryPreferences()}),f=fixture({answer:valid([]),onEvent:row=>child.emit('message',row)});
 try{assert.equal(reader.connect(credential),true);const key=await f.start();const rows=f.events.find(e=>e.type==='reader-rooms').rooms;child.emit('message',{type:'reader-rooms',source:'push',rooms:rows.map(r=>({...r,canText:true}))});assert.equal(reader.sendText(key,'Synthetic prewrite',clientId),true);const request=child.sent.findLast(r=>r.type==='reader-action');await f.session.action(key,request.requestId,'send',request.payload);const entry=reader.outbox(clientId);assert.equal(entry.phase,'failed');assert.equal(entry.reason,'open_member_unverified');assert.equal(entry.status,0);assert.equal(reader.snapshot().phase,'connected');noSend(f);assert.equal(JSON.stringify(entry).includes('Synthetic prewrite'),false);}finally{reader.close();f.session.close();}
});
test('manager exposes only the single approved pre-WRITE reason',()=>{
 const child=Object.assign(new EventEmitter(),{sent:[],send(row,cb){this.sent.push(row);cb?.();},kill(){}}),reader=createReadOnlyReader({messaging:true,spawn:()=>child,preferenceStore:memoryPreferences()}),key='r_'+'a'.repeat(24);
 try{reader.connect(credential);child.emit('message',{type:'reader-rooms',source:'loginlist',rooms:[{key,kind:'OpenMultiChat',canText:true}]});for(const [n,reason] of ['open_member_unverified','RAW_REASON_CANARY'].entries()){const id=n?'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb':clientId;assert.equal(reader.sendText(key,'Synthetic',id),true);const sent=child.sent.at(-1);child.emit('message',{...sent,phase:'failed',status:0,reason,roomId:'RAW_ROOM_CANARY'});const entry=reader.outbox(id);if(n===0)assert.equal(entry.reason,reason);else assert.equal(Object.hasOwn(entry,'reason'),false);assert.equal(JSON.stringify(entry).includes('RAW_'),false);}}finally{reader.close();}
});
test('send-stage diagnostic sanitizes BEFORE rolling events and persistent latest trace',()=>{
 const writes=[],latest=[],d=createReaderDiagnostic({writeSnapshot:raw=>writes.push(raw),writeSendSnapshot:raw=>latest.push(raw),debounceMs:10000});try{
  d.note('send-stage',{stage:'start',kind:'text',writeAttempted:false,text:'TRACE_CANARY_TEXT',token:'TRACE_CANARY_TOKEN',room:'TRACE_CANARY_ROOM'});
  d.note('send-stage',{stage:'blocked',phase:'failed',status:0,reason:'open_member_unverified',writeAttempted:false,raw:'TRACE_CANARY_RAW'});d.flush();
  assert.equal(writes.some(raw=>raw.includes('TRACE_CANARY')),false,'sensitive keys must never enter rolling events');assert.equal(latest.length,1);const state=JSON.parse(latest[0]);assert.equal(state.rawValuesRecorded,false);assert.equal(state.kind,'text');assert.ok(Number.isFinite(state.startedAt));assert.equal(state.events.at(-1).reason,'open_member_unverified');for(const row of state.events)assert.ok(Object.keys(row).every(k=>['stage','elapsedMs','writeAttempted','phase','status','reason'].includes(k)));
 }finally{d.end('synthetic');}
});
test('latest send trace survives rolling40 pushes, terminal flush and a no-send worker restart',()=>{
 const writes=[],latest=[],options={writeSnapshot:raw=>writes.push(JSON.parse(raw)),writeSendSnapshot:raw=>latest.push(JSON.parse(raw)),debounceMs:10000},d=createReaderDiagnostic(options);d.note('send-stage',{stage:'start',kind:'reply',writeAttempted:false});for(let n=0;n<20;n++)d.note('send-stage',{stage:'member_lookup',writeAttempted:false});d.note('send-stage',{stage:'result',phase:'failed',status:0,reason:'open_member_unverified',writeAttempted:false});for(let n=0;n<70;n++)d.packet('push',{method:'MSG',status:0,body:{msg:'TRACE_CANARY_BODY'}});assert.equal(latest.length,0,'debounce must avoid per-event writes');d.end('synthetic');assert.equal(latest.length,1,'terminal end flushes separate latesttrace');assert.ok(latest[0].events.length<=12);assert.equal(latest[0].events.at(-1).stage,'result');assert.equal(latest[0].kind,'reply');assert.equal(writes.at(-1).events.length,40);assert.deepEqual(writes.at(-1).lastSend,latest[0]);const count=latest.length,restart=createReaderDiagnostic(options);restart.packet('push',{method:'MSG',status:0,body:{}});restart.end('no-send-restart');assert.equal(latest.length,count,'new worker without a send preserves previous file');assert.equal(JSON.stringify(latest).includes('TRACE_CANARY'),false);
});
test('invalid send stages cannot reset trace or inject raw strings; WRITE attempt never becomes false',()=>{
 const latest=[],d=createReaderDiagnostic({writeSnapshot(){},writeSendSnapshot:raw=>latest.push(JSON.parse(raw))});try{d.note('send-stage',{stage:'result',phase:'failed'});d.flush();assert.equal(latest.length,0);d.note('send-stage',{stage:'start',kind:'text',writeAttempted:false});d.note('send-stage',{stage:'write_attempt',writeAttempted:true});d.note('send-stage',{stage:'start',kind:'TRACE_CANARY_KIND',writeAttempted:false});d.note('send-stage',{stage:'result',phase:'TRACE_CANARY_PHASE',reason:'TRACE_CANARY_REASON',status:'TRACE_CANARY_STATUS',writeAttempted:false});d.flush();assert.equal(latest.length,1);assert.equal(latest[0].kind,'text');assert.equal(JSON.stringify(latest).includes('TRACE_CANARY'),false);assert.equal(latest[0].events.at(-1).writeAttempted,true);}finally{d.end('synthetic');}
});
