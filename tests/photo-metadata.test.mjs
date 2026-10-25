// Regressions for remotely supplied photo metadata. No account or sockets.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {photoAttachments} from '../experiments/local-web/photos.mjs';
import {createReaderSession} from '../experiments/local-web/reader-session.mjs';

const url='https://synthetic.kakaocdn.net/photo.jpg';
const malformed={valueOf:0,toString:0};

test('unconvertible photo dimensions preserve safe photos with unknown dimensions',()=>{
  const photos=photoAttachments({type:27,attachment:JSON.stringify({imageUrls:[url,url],wl:[malformed,640],hl:[480,malformed]})});
  assert.deepEqual(photos,[{url,width:null,height:480},{url,width:640,height:null}]);
});

test('photo dimensions accept numeric primitives and reject coercible collections and booleans',()=>{
  for(const value of [malformed,{},[640],true,Symbol('synthetic')]){
    assert.deepEqual(photoAttachments({type:2,attachment:{url,w:value,h:'480'}}),[{url,width:null,height:480}]);
  }
  for(const [value,want] of [[640,640],['640',640],[' 640 ',640],[20000,20000],[0,null],[-1,null],[20001,null],[1.5,null],['Infinity',null],['',null],[NaN,null]]){
    assert.equal(photoAttachments({type:2,attachment:{url,w:value,h:480}})[0].width,want);
  }
});

test('photo dimension accessors are not executed while inspecting metadata',()=>{
  let accessed=0;const data={url,w:640};
  Object.defineProperty(data,'h',{get(){accessed++;throw new Error('SYNTHETIC_PRIVATE');}});
  assert.deepEqual(photoAttachments({type:2,attachment:data}),[{url,width:640,height:null}]);
  assert.equal(accessed,0);
});

test('invalid photo kinds and metadata fields cannot throw through the receiver',()=>{
  assert.deepEqual(photoAttachments({type:malformed,attachment:{url}}),[]);
  const data={};Object.defineProperty(data,'imageUrls',{get(){throw new Error('SYNTHETIC_PRIVATE');}});
  assert.deepEqual(photoAttachments({type:27,attachment:data}),[]);
  assert.deepEqual(photoAttachments({type:27,attachment:JSON.stringify({imageUrls:[url,'https://evil.test/a'],wl:[640,malformed],hl:[480,malformed]})}),[{url,width:640,height:480}]);
});

test('bundle limits, thumbnail fallback and original dimension indexes survive validation',()=>{
  const urls=Array(31).fill(url);let accessed=0;
  Object.defineProperty(urls,'0',{get(){accessed++;throw new Error('SYNTHETIC_PRIVATE');}});
  const photos=photoAttachments({type:27,attachment:{thumbnailUrls:urls,wl:Array.from({length:31},(_,i)=>i+100),hl:Array(31).fill(480)}});
  assert.equal(accessed,0);
  assert.equal(photos.length,29,'only original indexes0 through29 are considered; rejected index0 does not admit index30');
  assert.equal(photos[0].width,101);
  assert.equal(photos.at(-1).width,129);
});

test('two photo bundles with malformed dimensions keep the real reader session alive',async()=>{
  const events=[];let disconnected=0;
  const carriage=Object.assign(new EventEmitter(),{async connect(){},disconnect(){disconnected++;},stopPing(){},async loginList(){return {status:0,body:{chatDatas:[{c:'123',t:'DirectChat',title:'Synthetic'}]}};},async request(){return {status:0,body:{}};}});
  const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};}});
  const reader=createReaderSession({userId:'999',deviceUUID:'SYNTHETIC',accessToken:'SYNTHETIC_NO_ACCOUNT'},
    {booking:bootstrap,ticket:bootstrap,carriage:()=>carriage,toLong:String,resolve:async host=>host,every:()=>0,delay:async()=>{}},event=>events.push(event));
  try{
    assert.equal((await reader.start()).ok,true);
    for(let i=0;i<2;i++)carriage.emit('push',{method:'MSG',status:0,body:{chatId:'123',chatLog:{chatId:'123',logId:String(i+1),authorId:'111',type:27,msg:'',attachment:JSON.stringify({imageUrls:[url],wl:[i?malformed:640],hl:[480]})}}});
    assert.deepEqual(events.filter(e=>e.type==='reader-failed'),[]);
    assert.equal(disconnected,0);
    const page=events.findLast(e=>e.type==='reader-messages');
    assert.equal(page.messages.length,2);
    assert.equal(page.messages[1].photos.length,1);
    assert.equal(page.messages[1].photos[0].width,null);
  }finally{reader.close();}
});
