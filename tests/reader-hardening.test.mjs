// Synthetic-only contracts for member names, impersonation, reply quotes, ID
// bounds, discovery memory, active-room retention, liveness and diagnostics.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createReaderSession,allowedReaderMethod} from '../experiments/local-web/reader-session.mjs';
import {createReaderStore,serverId,personName} from '../experiments/local-web/reader-data.mjs';
import {guardReaderClient} from '../experiments/local-web/reader-protocol.mjs';
import {createReaderDiagnostic} from '../experiments/local-web/reader-diagnostics.mjs';
import {uploadPhoto} from '../experiments/local-web/media-upload.mjs';
import {createPhotoCache,fetchPhoto,imageDimensions} from '../experiments/local-web/photos.mjs';
import {createAuthLab} from '../experiments/local-web/kakao-auth.mjs';
import {cleanRoomTitle} from '../experiments/local-web/reader-room-state.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,ms=3000){const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw new Error('synthetic wait deadline');await sleep(5);}}
const credential={userId:'999',deviceUUID:'SYNTHETIC',accessToken:'SYNTHETIC_NO_ACCOUNT'};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const log=(room,n,extra={})=>({chatId:String(room),logId:String(n),authorId:'111',type:1,msg:'Synthetic '+n,...extra});
const msg=body=>({method:'MSG',status:0,body});
function sessionFixture({source=[{c:'1000',t:'MultiChat',ll:'100'}],reply}={}){
  const f={events:[],calls:[],closed:0};
  f.carriage=Object.assign(new EventEmitter(),{async connect(){},disconnect(){f.closed++;},stopPing(){},async loginList(){return {status:0,body:{chatDatas:source}};},
    async request(method,body,ms,policy){f.calls.push({method,body,ms,policy});const custom=await reply?.(method,body,ms,policy);if(custom!==undefined)return custom;
      if(method==='CHATONROOM')return {status:0,body:{c:String(body.chatId),mi:['999','111'],a:['111'],w:['0']}};
      if(method==='SYNCMSG')return {status:0,body:{isOK:true,chatLogs:Array.from({length:40},(_,i)=>log(String(body.chatId),i+1))}};
      return {status:0,body:{}};}});
  const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};}});
  f.session=createReaderSession(credential,{messaging:true,booking:bootstrap,ticket:bootstrap,carriage:()=>f.carriage,media:()=>{throw new Error('no media');},toLong:String,resolve:async host=>host,every:()=>0,delay:async()=>{}},event=>f.events.push(event));
  f.start=async()=>{assert.equal((await f.session.start()).ok,true);return f.events.find(event=>event.type==='reader-rooms'&&event.source==='loginlist').rooms.map(row=>row.key);};
  f.last=key=>f.events.findLast(event=>event.type==='reader-messages'&&(!key||event.key===key));
  return f;
}

test('A1 MSG top-level authorNickname names the sender instead of a numbered alias',async()=>{
  const f=sessionFixture();try{await f.start();f.carriage.emit('push',msg({chatId:'1000',authorNickname:'합성 닉네임',chatLog:log(1000,101)}));assert.equal(f.last().messages.at(-1).sender,'합성 닉네임');}finally{f.session.close();}
});
test('A2/A4 CHATONROOM m[] names update already cached messages and reply authors at view time',async()=>{
  const f=sessionFixture({reply:(method,body)=>method==='CHATONROOM'?{status:0,body:{c:String(body.chatId),m:[{userId:'111',nickName:'합성 상대'}],a:['111'],w:['0']}}:undefined});
  try{const [key]=await f.start();f.carriage.emit('push',msg({chatId:'1000',chatLog:log(1000,101)}));
    f.carriage.emit('push',msg({chatId:'1000',chatLog:log(1000,102,{authorId:'222',type:26,attachment:'{"src_logId":101,"src_userId":111,"src_type":1,"src_message":"x"}'})}));
    assert.equal(f.last().messages[0].sender,'참여자 1');
    await f.session.action(key,1,'context');const page=f.last(key).messages;
    assert.equal(page[0].sender,'합성 상대');assert.equal(page[1].reply.sender,'합성 상대');assert.equal(page[1].reply.verified,true);
    // A foreign room's CHATONROOM cannot name members of this room.
    const store=createReaderStore({chatDatas:[{c:'1000',t:'MultiChat'}]},'999'),k=store.rooms()[0].key;store.push({chatId:'1000',chatLog:log(1000,1)});
    assert.equal(store.entrySnapshot(k,{c:'2000',m:[{userId:'111',nickName:'가짜'}]},store.receiptVersion(k)),false);assert.equal(store.current(k).messages[0].sender,'참여자 1');
  }finally{f.session.close();}
});
test('A3 bounded event-driven MEMBER lookups name only requested members',async()=>{
  const ids=Array.from({length:620},(_,n)=>String(5000+n));let answered=0;
  const f=sessionFixture({reply:(method,body)=>{
    if(method==='CHATONROOM')return {status:0,body:{c:String(body.chatId),mi:['999',...ids],a:ids,w:ids.map(()=>'0')}};
    if(method==='MEMBER'){answered++;return answered===1?{status:0,method:'MEMBER',body:{chatId:String(body.chatId),members:[{userId:body.memberIds[0],nickName:'합성 멤버'},{userId:'999999',nickName:'요청 안 됨'}]}}
      :answered===2?{status:0,method:'MEMBER',body:{chatId:'2000',members:[{userId:body.memberIds[0],nickName:'다른 방'}]}}:{status:-500,body:{status:-500}};}
  }});
  try{const [key]=await f.start();f.carriage.emit('push',msg({chatId:'1000',chatLog:log(1000,101,{authorId:'5000'})}));f.carriage.emit('push',msg({chatId:'1000',chatLog:log(1000,102,{authorId:'5100'})}));
    await f.session.action(key,1,'context');await until(()=>f.calls.filter(call=>call.method==='MEMBER').length===1);await sleep(10);
    assert.equal(f.last(key).messages[0].sender,'합성 멤버');
    f.carriage.emit('push',msg({chatId:'1000',chatLog:log(1000,103,{authorId:'5200'})}));
    await until(()=>f.calls.filter(call=>call.method==='MEMBER').length===2);await sleep(10);
    const member=f.calls.filter(call=>call.method==='MEMBER');
    assert.ok(member.every(call=>call.policy?.optional===true && call.ms===2500 && call.body.chatId==='1000' && call.body.memberIds.length<=100),'bounded optional MEMBER requests');
    assert.equal(member.flatMap(call=>call.body.memberIds).includes('999'),false,'self is never looked up');
    const page=f.last(key).messages;assert.equal(page[0].sender,'합성 멤버');assert.equal(page[2].sender,'참여자 3','foreign-room MEMBER reply is ignored');
    assert.equal(JSON.stringify(f.events).includes('요청 안 됨'),false);
    await f.session.action(key,2,'context');await sleep(10);assert.equal(f.calls.filter(call=>call.method==='MEMBER').length,2,'repeated context does not walk the roster');
    f.carriage.emit('push',msg({chatId:'1000',chatLog:log(1000,104,{authorId:'5300'})}));
    await until(()=>f.calls.filter(call=>call.method==='MEMBER').length===3);await sleep(10);
    assert.equal(f.calls.filter(call=>call.method==='MEMBER').length,3,'a later new author can be supplemented on the same connection');
    assert.equal(f.closed,0);
  }finally{f.session.close();}
  assert.equal(allowedReaderMethod('MEMBER',{messaging:true}),true);assert.equal(allowedReaderMethod('MEMBER'),false);
  class Client extends EventEmitter{constructor(){super();this.pending=new Map();}async request(){return {status:0,body:{}};}}
  await assert.doesNotReject(new (guardReaderClient(Client,null,{messaging:true}))().request('MEMBER',{},2500,{optional:true}));
});

test('B peer names cannot render as client labels and controls/bidi/combining floods are neutralised',()=>{
  for(const name of ['나',' 나 ','\u202e나','나\u200b','참여자 2','작성자 미확인','원본 메시지','원본 확인 불가'])assert.notEqual(personName(name).replace(/[\u200b\u202e]/g,'').trim(),name.replace(/[\u200b\u202e]/g,'').trim(),name);
  assert.equal(personName('엄마'),'엄마');assert.equal(personName('a\u202eb\u2066c\u2028d\u0007'),'abcd');
  const store=createReaderStore({chatDatas:[{c:'1000',t:'MultiChat',title:'방\u202e제목\u2029',i:['999','222'],k:['me','나']}]},'999'),key=store.rooms()[0].key;
  assert.equal(store.rooms()[0].title,'방제목');
  store.push({chatId:'1000',chatLog:log(1000,1,{authorId:'222',msg:'e'+'\u0301'.repeat(500)})});
  const row=store.current(key).messages[0];assert.equal(row.mine,false);assert.notEqual(row.sender,'나');assert.equal(row.text,'e'+'\u0301'.repeat(4));
  assert.equal(cleanRoomTitle('a\u202eb'),null);assert.equal(cleanRoomTitle('일반 제목'),'일반 제목');
});
test('C forged reply quotes are labelled unverified and real originals show their own author and text',()=>{
  const store=createReaderStore({chatDatas:[{c:'123',t:'MultiChat',i:['999','111','222'],k:['me','엄마','공격자']}]},'999'),key=store.rooms()[0].key;
  store.push({chatId:'123',chatLog:{logId:'9007199254740993',authorId:'111',type:1,msg:'진짜 원문'}});
  store.push({chatId:'123',chatLog:{logId:'9007199254740995',authorId:'222',type:26,msg:'a',attachment:JSON.stringify({src_logId:1,src_userId:999,src_type:1,src_message:'내 계좌로 보낼게요'})}});
  store.push({chatId:'123',chatLog:{logId:'9007199254740996',authorId:'222',type:26,msg:'b',attachment:{src_logId:2,src_userId:111,src_type:1,src_message:'비밀번호 알려줘도 돼'}}});
  store.push({chatId:'123',chatLog:{logId:'9007199254740997',authorId:'222',type:26,msg:'c',attachment:'{"src_logId":9007199254740993,"src_userId":999,"src_type":1,"src_message":"조작된 문장"}'}});
  const [,forgedSelf,forgedPeer,real]=store.current(key).messages;
  for(const row of [forgedSelf,forgedPeer]){assert.equal(row.reply.sender,'원본 확인 불가');assert.equal(row.reply.verified,false);}
  assert.deepEqual(real.reply,{text:'진짜 원문',sender:'엄마',verified:true},'int64 src_logId resolves exactly and the quote cannot rewrite the original');
});
test('D IDs beyond signed int64 are refused instead of wrapping onto another room',()=>{
  const wrapped=(123n+(1n<<64n)).toString();
  assert.equal(serverId('9223372036854775808'),'');assert.equal(serverId(wrapped),'');assert.equal(serverId('9223372036854775807'),'9223372036854775807');assert.equal(serverId('0123'),'');
  const store=createReaderStore({chatDatas:[{c:'123',t:'DirectChat',title:'회사'},{c:wrapped,t:'DirectChat',title:'가족'}]},'999');
  assert.deepEqual(store.rooms().map(row=>row.title),['회사']);
});
test('E unknown-room discovery replay is byte bounded and marks an over-budget room partial',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const f=sessionFixture({reply:async(method,body)=>{if(method==='CHATINFO'){await gate;return {status:0,body:{chatInfo:{c:String(body.chatId),t:'DirectChat',title:'발견 '+body.chatId}}};}}});
  try{await f.start();
    for(let r=0;r<3;r++)for(let n=0;n<50;n++)f.carriage.emit('push',msg({chatId:String(5000+r),chatLog:log(5000+r,1000+n,{msg:'가'.repeat(4000),type:n%2?26:1,attachment:'{"src_message":"'+'x'.repeat(n%2?7000:60000)+'"}'})}));
    release();await until(()=>f.events.filter(event=>event.type==='reader-rooms').some(event=>event.rooms.length===4));await sleep(250);
    const replayed=f.events.filter(event=>event.type==='reader-messages');const keys=new Set(replayed.flatMap(event=>event.messages.map(row=>row.key)));
    assert.ok(keys.size>0 && keys.size*8000<=2.2*1024*1024,'replayed bodies stay within the discovery byte budget: '+keys.size);
    assert.ok(replayed.some(event=>event.partial===true),'a room whose replay was truncated is marked partial');
    assert.equal(f.closed,0);
  }finally{release();f.session.close();}
});
test('H the active history room survives display LRU churn without a separate view pin',async()=>{
  const f=sessionFixture({source:Array.from({length:23},(_,n)=>({c:String(1000+n),t:'DirectChat',ll:'100'}))});
  try{const keys=await f.start();await f.session.history(keys[0],1);
    for(let n=1;n<23;n++)f.carriage.emit('push',msg({chatId:String(1000+n),chatLog:log(1000+n,101)}));
    f.carriage.emit('push',msg({chatId:'1000',chatLog:log(1000,101)}));
    assert.equal(f.last(keys[0]).messages.length,41);assert.equal(f.events.some(event=>event.type==='reader-cache-evicted'&&event.key===keys[0]),false);
  }finally{f.session.close();}
});
test('I reader-alive is throttled to once per 30 seconds and auth exposes the credential deadline without a refresh token',async()=>{
  const f=sessionFixture();try{await f.start();f.carriage.emit('push',msg({chatId:'1000',chatLog:log(1000,101)}));f.carriage.emit('push',msg({chatId:'1000',chatLog:log(1000,102)}));
    const alive=f.events.filter(event=>event.type==='reader-alive');assert.equal(alive.length,1);assert.ok(Number.isSafeInteger(alive[0].at) && Math.abs(alive[0].at-Date.now())<5000);}finally{f.session.close();}
  let time=100000;const timers=[],responses=[{httpStatus:200,body:{allowlisted:true}},{httpStatus:200,body:{status:0,url:'kakaotalk://qrlogin?id=synthetic',remainingSeconds:180}},{httpStatus:200,body:{status:0,user:{userId:'246810'},accessToken:'FAKE_ACCESS',refreshToken:'FAKE_REFRESH'}}];
  const lab=createAuthLab({transport:async()=>responses.shift(),encodeQr:()=>[[true]],now:()=>time,later:fn=>{const timer={fn};timers.push(timer);return timer;},clear:()=>{}});
  assert.equal(lab.snapshot().credentialDeadline,null);assert.equal(lab.snapshot().serverNow,time);
  await lab.start();time+=2000;await timers.pop().fn();
  const snapshot=lab.snapshot();assert.equal(snapshot.phase,'authenticated');assert.equal(snapshot.credentialDeadline,102000+15*60*1000);assert.equal(snapshot.serverNow,102000);
  lab.withCredential(value=>{assert.deepEqual(Object.keys(value).sort(),['accessToken','deviceUUID','userId']);});assert.equal(JSON.stringify(snapshot).includes('FAKE_REFRESH'),false);
  lab.cancel();assert.equal(lab.snapshot().credentialDeadline,null);
});
test('J2 CHATINFO title repair emits one room list after the batch',async()=>{
  const f=sessionFixture({source:[1,2,3].map(n=>({c:String(1000+n),t:'MultiChat'})),reply:(method,body)=>method==='CHATINFO'?{status:0,body:{chatInfo:{c:String(body.chatId),title:'복구 '+body.chatId}}}:undefined});
  try{await f.start();await until(()=>f.calls.filter(call=>call.method==='CHATINFO').length===3);await sleep(30);
    const lists=f.events.filter(event=>event.type==='reader-rooms'&&event.source==='push');assert.equal(lists.length,1);assert.deepEqual(lists[0].rooms.map(row=>row.title).sort(),['복구 1001','복구 1002','복구 1003']);
  }finally{f.session.close();}
});
test('J3/J4 diagnostics write at most once per second compactly and uploads collapse stream frames',async()=>{
  const writes=[],diagnostic=createReaderDiagnostic({writeSnapshot:raw=>writes.push(raw)});
  for(let n=0;n<50;n++)diagnostic.note('request',{method:'PING'});await sleep(60);assert.equal(writes.length,0,'default debounce is about one second');
  diagnostic.end('synthetic');assert.equal(writes.length,1);assert.equal(writes[0].includes('\n  '),false,'compact JSON');
  const data=Buffer.concat([png,Buffer.alloc(700000)]),steps=[];let media,sent=0;
  const outcome=await uploadPhoto({carriage:{async request(){return {status:0,body:{k:'K',vh:'upload.kakao.com',p:443}};}},createClient(){media=Object.assign(new EventEmitter(),{async connect(){},async request(){return {status:0,body:{o:0}};},async writeEncrypted(chunk){sent+=chunk.length;if(sent===data.length)media.emit('push',{method:'COMPLETE',status:0,body:{status:0,chatLog:{logId:'20',chatId:'123'}}});},disconnect(){}});return media;},
    toLong:String,chatId:'123',userId:'999',messageId:'345',data,profile:{os:'android',appVersion:'26.1.2'},resolve:async()=> '1.2.3.4',observe:step=>steps.push(step)});
  assert.equal(outcome.phase,'accepted');const streams=steps.filter(step=>step.stage==='stream');
  assert.equal(streams.length,2,'one start and one collapsed completion event');assert.ok(streams[1].frames>1);assert.equal(streams[1].sentBytes,data.length);
  const recorded=[],upload=createReaderDiagnostic({writeSnapshot:raw=>recorded.push(JSON.parse(raw))});for(const step of steps)upload.note('photo-upload',step);upload.end('synthetic');
  assert.equal(recorded.at(-1).uploadStages.stream.frames,streams[1].frames);assert.ok(recorded.at(-1).uploadStages.ship && recorded.at(-1).uploadStages.post);
});
test('J5 photo cache has no entry-count cap and fetched images over 8192px or 40MP are refused',async()=>{
  const calls=new Map(),cache=createPhotoCache({fetcher:async url=>{calls.set(url,(calls.get(url)||0)+1);return {data:png,type:'image/png'};}});
  try{for(let n=0;n<200;n++)await cache.get('synthetic:'+n);await cache.get('synthetic:0');assert.equal(calls.get('synthetic:0'),1);}finally{cache.clear();}
  const sized=(w,h)=>{const data=Buffer.from(png);data.writeUInt32BE(w,16);data.writeUInt32BE(h,20);return data;};
  assert.deepEqual(imageDimensions(sized(8192,10)),{width:8192,height:10});
  const gif=Buffer.from('GIF89a\x10\x27\x02\x00\x00\x00','latin1');assert.deepEqual(imageDimensions(gif),{width:10000,height:2});
  const vp8x=Buffer.alloc(30);vp8x.write('RIFF',0);vp8x.write('WEBPVP8X',8);vp8x.writeUIntLE(9999,24,3);vp8x.writeUIntLE(0,27,3);assert.deepEqual(imageDimensions(vp8x),{width:10000,height:1});
  const serve=data=>(_url,_options,callback)=>{const req=new EventEmitter(),response=new EventEmitter();response.statusCode=200;response.headers={};response.destroy=()=>{};req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{callback(response);response.emit('data',data);response.emit('end');});return req;};
  const resolve=async()=>[{address:'8.8.8.8',family:4}];
  assert.equal((await fetchPhoto('https://synthetic.kakaocdn.net/p',{resolve,request:serve(sized(1,1))})).type,'image/png');
  for(const data of [sized(8193,1),sized(7000,7000),gif])await assert.rejects(fetchPhoto('https://synthetic.kakaocdn.net/p',{resolve,request:serve(data)}));
});
