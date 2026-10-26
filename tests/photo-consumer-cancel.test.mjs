// Synthetic only: injected bytes/fetchers and an ephemeral loopback fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhotoCache} from '../experiments/local-web/photos.mjs';
import {createLocalServer} from '../experiments/local-web/server.mjs';
import {setTimeout as delay} from 'node:timers/promises';

const photo={data:Buffer.alloc(70),type:'image/png'};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const settle=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
function fixture(){
  const calls=[];
  const cache=createPhotoCache({fetcher:(url,{signal})=>{const gate=deferred();calls.push({url,signal,...gate});signal.addEventListener('abort',()=>gate.reject(new Error('photo_unavailable')),{once:true});return gate.promise;}});
  return {cache,calls,close(){cache.clear();for(const row of calls)row.resolve(photo);}};
}
test('one canceled consumer cannot abort a photo another consumer still needs',async()=>{
  const f=fixture(),one=new AbortController(),two=new AbortController();
  try{
    const a=f.cache.get('synthetic:shared',{signal:one.signal}),b=f.cache.get('synthetic:shared',{signal:two.signal});b.catch(()=>{});
    let state='pending';a.then(()=>state='resolved',()=>state='rejected');one.abort();await settle();assert.equal(state,'rejected');await assert.rejects(a,/photo_unavailable/);
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].signal.aborted,false);
    f.calls[0].resolve(photo);assert.strictEqual(await b,photo);
  }finally{f.close();}
});
test('the final canceled consumer aborts its upstream and frees a waiting fetch',async()=>{
  const f=fixture(),controller=new AbortController();
  try{
    const canceled=f.cache.get('synthetic:0',{signal:controller.signal}),others=Array.from({length:4},(_,n)=>f.cache.get('synthetic:'+(n+1)));
    others.forEach(row=>row.catch(()=>{}));let state='pending';canceled.then(()=>state='resolved',()=>state='rejected');
    controller.abort();await settle();assert.equal(state,'rejected');await assert.rejects(canceled,/photo_unavailable/);
    assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.calls.length,5);
    for(const row of f.calls.slice(1))row.resolve(photo);await Promise.all(others);
  }finally{f.close();}
});
test('canceling every queued consumer prevents that URL from ever reaching upstream',async()=>{
  const f=fixture(),controller=new AbortController();
  try{
    const holders=Array.from({length:4},(_,n)=>f.cache.get('synthetic:holder:'+n));holders.forEach(row=>row.catch(()=>{}));
    const queued=f.cache.get('synthetic:queued',{signal:controller.signal});let state='pending';queued.then(()=>state='resolved',()=>state='rejected');
    controller.abort();await settle();assert.equal(state,'rejected');await assert.rejects(queued,/photo_unavailable/);f.calls[0].resolve(photo);await settle();
    assert.equal(f.calls.length,4);assert.ok(f.calls.every(row=>row.url!=='synthetic:queued'));
    for(const row of f.calls)row.resolve(photo);await Promise.all(holders);
  }finally{f.close();}
});
test('an already aborted consumer creates neither a fetch nor a retained pending entry',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();
  try{const request=f.cache.get('synthetic:aborted',{signal:controller.signal});request.catch(()=>{});assert.equal(f.calls.length,0);await assert.rejects(request,/photo_unavailable/);}finally{f.close();}
});

const room='r_'+'a'.repeat(24),message='m_'+'b'.repeat(24),otherRoom='r_'+'c'.repeat(24);
const until=async condition=>{const end=Date.now()+5000;while(!condition()){if(Date.now()>end)throw new Error('synthetic photo fixture deadline');await delay(5);}};
async function serverFixture(){
  const calls=[],responses=[];
  const reader={snapshot:()=>({phase:'connected',attempts:1,instanceId:'a'.repeat(24)}),close(){},photo:()=> 'https://synthetic.kakaocdn.net/consumer',messages:()=>({messages:[{key:message,photos:[{src:`/api/photo?room=${room}&message=${message}&index=0`}]}]})};
  const app=createLocalServer({mode:'live',encode:()=>[[true]],preferenceStore:{account(){assert.fail('no private settings');}},readerFactory:()=>reader,
    transport:async operation=>operation==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:operation==='generate'?{httpStatus:200,body:{status:0,url:'SYNTHETIC_NO_LOGIN',remainingSeconds:180}}:{httpStatus:200,body:{status:0,user:{userId:'999'},accessToken:'SYNTHETIC_NO_ACCOUNT'}},
    photoFetcher:(_url,{signal})=>{const gate=deferred(),row={signal,...gate};calls.push(row);signal.addEventListener('abort',()=>gate.reject(new Error('photo_unavailable')),{once:true});return gate.promise;}});
  app.server.on('request',(request,response)=>{if(new URL(request.url,'http://synthetic.invalid').pathname==='/api/photo'){const row={closed:false};responses.push(row);response.once('close',()=>row.closed=true);}});
  const url=await app.listen(0);assert.notEqual(app.server.address().port,8787);
  const issue=await fetch(url+'/api/local/launch',{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Local-Control':app.controlToken},body:'{}'});
  const exchange=await fetch(url+'/api/local/session',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify({ticket:(await issue.json()).ticket})});
  const auth={'X-Local-Session':(await exchange.json()).session};
  const state=await(await fetch(url+'/api/status',{headers:auth})).json();await app.lab.start();await until(()=>app.lab.snapshot().credentialInMemory);
  const page=await(await fetch(url+'/api/reader/messages?room='+room,{headers:auth})).json(),src=page.messages[0].photos[0].src;
  const post=(body,{origin=url,csrf=state.csrf,authenticated=true}={})=>fetch(url+'/api/photo/cancel',{method:'POST',headers:{...(authenticated?auth:{}),Origin:origin,'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},body:JSON.stringify(body)});
  return {app,url,src,calls,responses,post,get:id=>fetch(url+src+'&request='+id),
    async close(){app.lab.cancel();app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));for(const row of calls)row.resolve(photo);}};
}
test('HTTP cancellation acknowledges close and aborts only the final shared consumer',{timeout:15000},async()=>{
  const f=await serverFixture(),one='1'.repeat(32),two='2'.repeat(32),three='3'.repeat(32);
  const body=id=>({room,message,index:0,requestId:id});
  try{
    const a=f.get(one).catch(()=>null),b=f.get(two).catch(()=>null);await until(()=>f.responses.length===2 && f.calls.length===1);
    assert.equal((await f.post({...body(one),room:otherRoom})).status,409);
    assert.equal((await f.post(body(one),{csrf:null})).status,403);
    assert.equal((await f.post(body(one),{origin:'https://foreign.invalid'})).status,403);
    assert.equal((await f.post(body(one),{authenticated:false})).status,403);
    assert.equal((await f.post({...body(one),url:'https://foreign.invalid'})).status,400);
    assert.equal((await fetch(f.url+f.src.replace(/cap=[a-f0-9]{64}/,'cap='+'0'.repeat(64))+'&request='+'4'.repeat(32))).status,403);
    const canceledOne=await f.post(body(one));assert.equal(canceledOne.status,200);assert.deepEqual(await canceledOne.json(),{canceled:true});
    assert.equal(f.responses[0].closed,true);assert.equal(f.calls[0].signal.aborted,false,'second HTTP consumer retains upstream');
    const canceledTwo=await f.post(body(two));assert.equal(canceledTwo.status,200);assert.equal(f.responses[1].closed,true);assert.equal(f.calls[0].signal.aborted,true);
    await Promise.all([a,b]);
    const fresh=f.get(three);fresh.catch(()=>{});await until(()=>f.calls.length===2);f.calls[1].resolve(photo);assert.equal((await fresh).status,200);
  }finally{await f.close();}
});
test('early cancel tombstones are scoped, idempotent, bounded and expire',{timeout:20000},async()=>{
  const f=await serverFixture(),id='5'.repeat(32),body={room,message,index:0,requestId:id};
  try{
    assert.equal((await f.post(body)).status,200);assert.equal((await f.post(body)).status,200);
    assert.equal((await f.post({...body,message:'m_'+'d'.repeat(24)})).status,409);
    assert.equal((await f.get(id)).status,409);assert.equal(f.calls.length,0);
    for(let n=1;n<512;n++)assert.equal((await f.post({...body,requestId:n.toString(16).padStart(32,'0')})).status,200);
    assert.equal((await f.post({...body,requestId:'6'.repeat(32)})).status,429);
    assert.equal((await f.get('7'.repeat(32))).status,429);
    const original=Date.now;Date.now=()=>original()+31000;
    try{assert.equal((await f.post({...body,requestId:'6'.repeat(32)})).status,200);}finally{Date.now=original;}
    assert.equal(f.calls.length,0);
  }finally{await f.close();}
});
