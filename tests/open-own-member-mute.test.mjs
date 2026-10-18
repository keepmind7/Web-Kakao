// Entry normalization regressions: injected session transports and memory store.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {createReaderSession} from '../experiments/local-web/reader-session.mjs';
import {createReaderStore} from '../experiments/local-web/reader-data.mjs';
const {Long}=createRequire(new URL('../local-only/spikes/modern/package.json',import.meta.url))('bson');
const own='999',room='9007199254740993',link='700',self=(extra={})=>({userId:own,lmt:2,opt:0,...extra}),png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
function fixture(entry,kind='OM'){
 const events=[],calls=[];let disconnected=0;
 const carriage=Object.assign(new EventEmitter(),{async connect(){},disconnect(){disconnected++;},stopPing(){},async loginList(){return {status:0,body:{chatDatas:[{c:room,t:kind,title:'Synthetic normalization room',...(kind==='DirectChat'?{}:{li:link})}]}};},async request(method,body,timeout,policy){calls.push({method,body,timeout,policy});
  if(method==='SYNCLINK')return {status:0,body:{ltk:0,ols:[{li:link,ac:true,ln:'Synthetic link'}]}};
  if(method==='INFOLINK')return {status:0,body:{ols:[]}};
  if(method==='CHATONROOM')return {status:0,body:{c:room,li:link,o:'10',...entry}};
  if(method==='MEMBER')return {status:0,body:{chatId:room,members:[{userId:own,type:1000,mt:2,opt:0}]}};
  if(method==='WRITE')return {status:0,body:{chatId:room,logId:'20',msgId:body.msgId}};
  if(method==='SHIP')return {status:-203,body:{status:-203}}; // Inert if a bad permission erroneously reaches upload.
  return {status:0,body:{}};
 }});
 const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};}});
 const session=createReaderSession({userId:own,deviceUUID:'SYNTHETIC',accessToken:'SYNTHETIC_NO_ACCOUNT'},{messaging:true,booking:bootstrap,ticket:bootstrap,carriage:()=>carriage,toLong:value=>Long.fromString(String(value)),resolve:async host=>host,every:()=>0,media:()=>{assert.fail('synthetic fixture never uploads bytes');}},e=>events.push(e));
 return {session,events,calls,count:method=>calls.filter(c=>c.method===method).length,healthy(){assert.equal(disconnected,0);assert.equal(events.some(e=>e.type==='reader-failed'),false);},async start(){assert.equal((await session.start()).ok,true);return events.find(e=>e.type==='reader-rooms').rooms[0].key;},row:key=>events.findLast(e=>e.type==='reader-rooms').rooms.find(r=>r.key===key)};
}
const noEffects=f=>{for(const method of ['WRITE','SHIP','POST','NOTIREAD','JOINLINK'])assert.equal(f.count(method),0,method);f.healthy();};
const badEntries=[
 ['root negative mute hidden by empty nested',{mt:-1,chatInfo:{}}],
 ['root null mute hidden by nested',{mt:null,chatInfo:{}}],
 ['root overflowing mute hidden by nested',{mt:2147483648,chatInfo:{}}],
 ['nested explicit undefined mute',{chatInfo:{mt:undefined}}],
 ['nested invalid mute',{chatInfo:{mt:-1}}],
 ['root fractional mute',{mt:1.5}],
 ['nested string mute',{chatInfo:{mt:'0'}}],
 ['mute conflict root3600 nested0',{mt:3600,chatInfo:{mt:0}}],
 ['mute conflict root0 nested3600',{mt:0,chatInfo:{mt:3600}}],
 ['root null own metadata hidden by nested own',{olu:null,chatInfo:{olu:self()}}],
 ['root undefined own metadata hidden by nested own',{olu:undefined,chatInfo:{olu:self()}}],
 ['root foreign own metadata hidden by nested own',{olu:self({userId:'111'}),chatInfo:{olu:self()}}],
 ['root invalid role hidden by nested own',{olu:self({lmt:8}),chatInfo:{olu:self()}}],
 ['root invalid opt hidden by nested own',{olu:self({opt:1.5}),chatInfo:{olu:self()}}],
 ['nested null cannot be hidden by valid root',{olu:self(),chatInfo:{olu:null}}],
 ['own role conflict root1 nested2',{olu:self({lmt:1}),chatInfo:{olu:self()}}],
 ['own opt conflict root0 nested1',{olu:self(),chatInfo:{olu:self({opt:1})}}],
 ['room identity remains exact',{chatId:'456',chatInfo:{olu:self()}}],
 ['link identity remains exact',{li:'701',chatInfo:{olu:self()}}],
 ['entry token remains strict',{o:'invalid',chatInfo:{olu:self()}}],
 ...[['null',null],['undefined',undefined],['number',5],['string','invalid'],['array',[]],['boolean',true]].map(([name,value])=>['explicit '+name+' chatInfo',{chatInfo:value}])
];
for(const [name,entry] of badEntries)test(name+' blocks self lookup and all account actions without disconnect',async()=>{
 const f=fixture(entry);try{const key=await f.start();await f.session.action(key,1,'send',{text:'Synthetic blocked text'});assert.equal(f.count('CHATONROOM'),1);assert.equal(f.count('MEMBER'),0,'explicit invalid/conflicting metadata must not be treated as missing');noEffects(f);const row=f.row(key);assert.equal(row.canText,false);assert.equal(row.canRead,false);assert.equal(f.events.findLast(e=>e.type==='reader-action').phase,'failed');}finally{f.session.close();}
});
for(const [name,entry,lookups] of [
 ['root positive mute hidden by empty nested',{mt:3600,chatInfo:{}},1],
 ['root positive mute with nested valid own',{mt:3600,chatInfo:{olu:self()}},0],
 ['nested positive mute',{chatInfo:{mt:3600}},1],
 ['matching positive mute duplicates',{mt:3600,chatInfo:{mt:3600}},1]
])test(name+' preserves verified read capability but dispatches zero WRITE/upload/read',async()=>{
 const f=fixture(entry);try{const key=await f.start();await f.session.action(key,1,'send',{text:'Synthetic muted text'});assert.equal(f.count('MEMBER'),lookups);noEffects(f);const row=f.row(key);assert.equal(row.canRead,true,'mute is independent from verified own role');assert.equal(row.canText,false);assert.equal(f.events.findLast(e=>e.type==='reader-action').phase,'failed');}finally{f.session.close();}
});
for(const [name,entry,lookups] of [
 ['single root own without nested',{olu:self()},0],
 ['single root own with empty nested',{olu:self(),chatInfo:{}},0],
 ['single nested own',{chatInfo:{olu:self()}},0],
 ['matching duplicate own and zero mute',{mt:0,olu:self(),chatInfo:{mt:0,olu:self()}},0],
 ['canonical absent opt equals explicit minus1',{olu:{userId:own,lmt:2},chatInfo:{olu:self({opt:-1})}},0],
 ['both own properties missing',{chatInfo:{}},1]
])test(name+' keeps the supported normal form and exactly one explicit WRITE',async()=>{
 const f=fixture(entry);try{const key=await f.start();await f.session.action(key,1,'send',{text:'Synthetic allowed text'});assert.equal(f.count('MEMBER'),lookups);assert.equal(f.count('WRITE'),1);for(const method of ['SHIP','POST','NOTIREAD','JOINLINK'])assert.equal(f.count(method),0);assert.equal(f.events.findLast(e=>e.type==='reader-action').phase,'accepted');assert.equal(f.row(key).canText,true);f.healthy();}finally{f.session.close();}
});
test('root positive mute concealed by nested own cannot dispatch SHIP for a photo',async()=>{
 const f=fixture({mt:3600,chatInfo:{olu:self()}});try{const key=await f.start();await f.session.action(key,1,'photo',{image:png});assert.equal(f.count('MEMBER'),0);noEffects(f);assert.equal(f.events.findLast(e=>e.type==='reader-action').phase,'failed');}finally{f.session.close();}
});
test('normal direct room keeps its prior send path despite open-only malformed fields',async()=>{
 const f=fixture({mt:-1,chatInfo:null},'DirectChat');try{const key=await f.start();await f.session.action(key,1,'send',{text:'Synthetic direct'});assert.equal(f.count('CHATONROOM'),0);assert.equal(f.count('MEMBER'),0);assert.equal(f.count('WRITE'),1);assert.equal(f.events.findLast(e=>e.type==='reader-action').phase,'accepted');f.healthy();}finally{f.session.close();}
});
test('store cannot retain a previously verified own capability after conflicting entry fields',()=>{
 const store=createReaderStore({chatDatas:[{c:room,t:'OM',li:link,title:'Synthetic'}]},own),key=store.rooms()[0].key;store.syncLinks({ltk:0,ols:[{li:link,ac:true}]});const version=store.receiptVersion(key);
 assert.equal(store.entrySnapshot(key,{c:room,li:link,o:'10',mt:0,olu:self()},version),true);assert.equal(store.canAction(key,'send'),true);
 store.entrySnapshot(key,{c:room,li:link,o:'11',mt:-1,chatInfo:{mt:0,olu:self()}},version);assert.equal(store.canAction(key,'send'),false);assert.equal(store.canAction(key,'read'),false);assert.equal(store.takeOwnMemberLookup(key,version),false);store.clear();
});
