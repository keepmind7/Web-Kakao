// Account-free regression contracts. All workers/transports and identifiers are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createReadOnlyReader} from '../experiments/local-web/reader-manager.mjs';
import {createReaderStore} from '../experiments/local-web/reader-data.mjs';
import {createReaderSession} from '../experiments/local-web/reader-session.mjs';
import {createLocalServer} from '../experiments/local-web/server.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=4000){const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw new Error('fixture condition deadline');await sleep(10);}}
const credential={userId:'999',deviceUUID:'SYNTHETIC_DEVICE',accessToken:'SYNTHETIC_NO_ACCOUNT'};
const keys=Array.from({length:14},(_,i)=>'r_'+i.toString(16).padStart(24,'0'));
const row=key=>({key,kind:'DirectChat',title:'Synthetic room',canText:true,canReply:true,canPhoto:true,canRead:true,canContext:true});
const preferenceStore={account:()=>({key:()=>Buffer.alloc(32),snapshot:()=>({notifications:false}),room:()=>null,set:()=>false,setRoom:()=>false,forget:()=>false,close(){}})};
function managerFixture(){
  let clock=1_000_000;const sent=[];
  const child=Object.assign(new EventEmitter(),{send(v,cb){sent.push(v);cb?.();},kill(){return true;}});
  const reader=createReadOnlyReader({messaging:true,spawn:()=>child,now:()=>clock,preferenceStore});
  const connect=()=>{assert.equal(reader.connect(credential),true);child.emit('message',{type:'reader-rooms',source:'loginlist',rooms:keys.map(row),stats:{sourceRoomCount:keys.length}});};
  const answer=()=>{const a=sent.findLast(v=>v.type==='reader-action');child.emit('message',{type:'reader-action',key:a.key,requestId:a.requestId,action:a.action,phase:'accepted',entryPhase:'acknowledged'});};
  return {reader,sent,connect,answer,advance:ms=>{clock+=ms;}};
}
test('R1 manager exposes exact bounded cooldown and the rejected room can recover',()=>{
  const f=managerFixture();try{f.connect();assert.equal(typeof f.reader.contextRetryAfterMs,'function','cooldown getter is part of the manager contract');
    assert.equal(f.reader.contextRetryAfterMs(),0);
    for(let i=0;i<12;i++){assert.equal(f.reader.openRoom(keys[i]),true);f.answer();}
    assert.equal(f.reader.openRoom(keys[12]),false);assert.equal(f.reader.contextRetryAfterMs(),60001);
    f.advance(60000);assert.equal(f.reader.contextRetryAfterMs(),1);assert.equal(f.reader.openRoom(keys[12]),false);
    f.advance(1);assert.equal(f.reader.contextRetryAfterMs(),0);assert.equal(f.reader.openRoom(keys[12]),true);f.answer();
    assert.equal(f.sent.filter(v=>v.type==='reader-action'&&v.key===keys[12]).length,1);
  }finally{f.reader.close();}
});
test('R1 actual loopback server distinguishes local cooldown from generic refusal',async()=>{
  let f;
  const app=createLocalServer({mode:'live',messaging:true,preferenceStore,encode:()=>[[true]],readerFactory:()=>(f=managerFixture()).reader,
    transport:async op=>op==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:op==='generate'?{httpStatus:200,body:{status:0,url:'OFFLINE-NO-LOGIN',remainingSeconds:30}}:{httpStatus:200,body:{status:0,user:{userId:'999'},accessToken:'SYNTHETIC_NO_ACCOUNT'}}});
  try{const url=await app.listen(0);assert.notEqual(app.server.address().port,8787);
    const issue=await fetch(url+'/api/local/launch',{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Local-Control':app.controlToken},body:'{}'});
    const {ticket}=await issue.json();const exchanged=await fetch(url+'/api/local/session',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify({ticket})});
    const {session}=await exchanged.json();const state=await(await fetch(url+'/api/status',{headers:{'X-Local-Session':session}})).json();
    const post=(path,body={})=>fetch(url+path,{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Local-Session':session,'X-CSRF-Token':state.csrf},body:JSON.stringify(body)});
    assert.equal((await post('/api/start')).status,202);await until(()=>app.lab.snapshot().phase==='authenticated');f.connect();
    for(let i=0;i<12;i++){assert.equal((await post('/api/reader/context',{room:keys[i]})).status,202);f.answer();}
    const refused=await post('/api/reader/context',{room:keys[12]});assert.equal(refused.status,409);const body=await refused.json();
    assert.equal(body.error,'context_rate_limited');assert.ok(Number.isInteger(body.retryAfterMs)&&body.retryAfterMs>0&&body.retryAfterMs<=60001);
    const generic=await post('/api/reader/context',{room:'r_'+'f'.repeat(24)});assert.deepEqual(await generic.json(),{error:'action_not_ready'});
    f.advance(60001);assert.equal((await post('/api/reader/context',{room:keys[12]})).status,202);f.answer();
  }finally{app.lab.cancel();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));f.reader.close();}
});

function quote(attachment){
  const store=createReaderStore({chatDatas:[{c:'123',t:'MultiChat',i:['999','111','222'],k:['Synthetic self','Author A','Author B']}]},'999');
  const key=store.rooms()[0].key;
  for(const [id,msg,authorId] of [['101','Original A','111'],['102','Original B','222'],['9007199254740993','Large original','222'],['9223372036854775807','Int64 maximum','111']])store.push({chatId:'123',chatLog:{logId:id,authorId,type:1,msg}});
  store.push({chatId:'123',chatLog:{logId:'9223372036854775806',authorId:'222',type:26,msg:'Reply',attachment}});
  return store.current(key).messages.find(m=>m.text==='Reply').reply;
}
for(const [name,attachment,text,verified] of [
  ['nested id precedes top-level id','{"nested":{"src_logId":101},"src_logId":102,"src_message":"Claim"}','Original B',true],
  ['nested id without top-level id','{"nested":{"src_logId":101},"src_message":"Claim"}','Claim',false],
  ['duplicate top-level id','{"src_logId":101,"src_logId":102,"src_message":"Claim"}','Claim',false],
  ['escaped duplicate key','{"src_logId":101,"src_\\u006cogId":102,"src_message":"Claim"}','Claim',false],
  ['embedded JSON text','{"note":"\\\"src_logId\\\":101","src_logId":102,"src_message":"Claim"}','Original B',true],
  ['lossless numeric int64','{"src_logId":9007199254740993,"src_message":"Claim"}','Large original',true],
  ['signed int64 maximum','{"src_logId":9223372036854775807,"src_message":"Claim"}','Int64 maximum',true],
  ['normal string id','{"src_logId":"102","src_message":"Claim"}','Original B',true],
  ['oversized id','{"src_logId":9223372036854775808,"src_message":"Claim"}','Claim',false],
])test('R3 quote provenance: '+name,()=>{const actual=quote(attachment);assert.equal(actual.verified,verified);assert.equal(actual.text,text);if(!verified)assert.equal(actual.sender,'원본 확인 불가');});

test('R4 first packet dropped by discovery global capacity still emits partial after its room',async()=>{
  const events=[],calls=[];let release;const gate=new Promise(r=>{release=r;});
  const carriage=Object.assign(new EventEmitter(),{async connect(){},disconnect(){},stopPing(){},async loginList(){return {status:0,body:{chatDatas:[{c:'1000',t:'DirectChat',title:'Known room'}]}};},async request(method,body){calls.push({method,body});if(method==='CHATINFO'){await gate;return {status:0,body:{chatInfo:{c:String(body.chatId),t:'DirectChat',title:'Discovered '+body.chatId}}};}return {status:0,body:{}};}});
  const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};}});
  const session=createReaderSession(credential,{messaging:true,booking:bootstrap,ticket:bootstrap,carriage:()=>carriage,toLong:String,resolve:async h=>h,every:()=>0,delay:async()=>{}},e=>events.push(e));
  try{assert.equal((await session.start()).ok,true);
    const emit=(room,count)=>carriage.emit('push',{method:'MSG',status:0,body:{chatId:String(room),chatLogs:Array.from({length:count},(_,i)=>({chatId:String(room),logId:String(100+i),authorId:'111',type:26,msg:'x'.repeat(4000),attachment:'{"src_message":"'+'q'.repeat(7900)+'"}'}))}});
    emit(5000,50);emit(5001,30);emit(5002,50);release();await until(()=>events.some(e=>e.type==='reader-rooms'&&e.rooms.some(r=>r.title==='Discovered 5002')));await sleep(30);
    const key=events.filter(e=>e.type==='reader-rooms').flatMap(e=>e.rooms).find(r=>r.title==='Discovered 5002').key;
    const roomIndex=events.findIndex(e=>e.type==='reader-rooms'&&e.rooms.some(r=>r.key===key));
    const partialIndex=events.findIndex(e=>e.type==='reader-messages'&&e.key===key&&e.partial===true);
    assert.ok(partialIndex>roomIndex,'empty retained packet array must propagate partial coverage after room announcement');
    assert.equal(events[partialIndex].messages.length,0,'over-budget first packet remains dropped');assert.equal(calls.filter(c=>c.method==='CHATINFO').length,3);
  }finally{release();session.close();}
});
