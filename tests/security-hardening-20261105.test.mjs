// Synthetic readers/transports only; each HTTP fixture owns a fresh loopback port.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {createLocalServer} from '../experiments/local-web/server.mjs';
import {createPhotoCache,fetchPhoto,photoUrl} from '../experiments/local-web/photos.mjs';

const room='r_'+'1'.repeat(24),message='m_'+'2'.repeat(24),instanceId='a'.repeat(24);
const clientId='12345678-1234-4123-8123-123456789abc';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const photo={data:png,type:'image/png'},sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const definedHeaders=headers=>Object.fromEntries(Object.entries(headers).filter(([,value])=>value!==undefined));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function within(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('synthetic checkpoint deadline')),4000);})]);}finally{clearTimeout(timer);}}
async function until(condition){const deadline=Date.now()+4000;while(!condition()){if(Date.now()>deadline)throw new Error('synthetic condition deadline');await sleep(5);}}
async function fixture(t,{photoFetcher=async()=>photo,reuseSnapshot=false}={}){
  const calls=[],requests=new Set(),sharedSnapshot={instanceId,phase:'connected'};let attempts=1,gate=null;
  const action=name=>(...args)=>{calls.push(name);return true;};
  const app=createLocalServer({mode:'live',messaging:true,encode:()=>[[true]],preferenceStore:{},photoFetcher,
    transport:async op=>({httpStatus:200,body:op==='allowlist'?{allowlisted:true}:op==='generate'?{status:0,url:'SYNTHETIC_NO_LOGIN',remainingSeconds:60}:{status:0,user:{userId:'999'},accessToken:'SYNTHETIC_NO_ACCOUNT'}}),
    readerFactory:()=>({snapshot:()=>reuseSnapshot?Object.assign(sharedSnapshot,{attempts}):{instanceId,attempts,phase:'connected'},close(){},history:action('history'),sendText:action('send'),sendPhoto:action('photo'),seen:action('seen'),openRoom:action('context'),acknowledgeOutbox:action('ack'),view:action('view'),
      updateSettings:action('settings'),forgetSettings:action('forget'),roomPreferences:action('room-settings'),settingsSnapshot:()=>({persist:false}),claimNotifications(){calls.push('notifications');return [];},disconnect:action('disconnect'),
      photo:()=> 'https://synthetic.kakaocdn.net/shared',messages:()=>({messages:[{key:message,photos:[{src:`/api/photo?room=${room}&message=${message}&index=0`}]}]})})});
  app.server.prependListener('request',req=>{if(req.url!==gate?.path)return;const checkpoint=gate;gate=null;const original=req[Symbol.asyncIterator].bind(req);req[Symbol.asyncIterator]=()=>{const iterator=original(),next=iterator.next.bind(iterator);let reads=0;iterator.next=(...args)=>{if(++reads===2)checkpoint.resolve();return next(...args);};return iterator;};});
  const url=await app.listen(0);assert.notEqual(app.server.address().port,8787);
  const post=(path,body={},headers={})=>fetch(url+path,{method:'POST',headers:definedHeaders({Origin:url,'Content-Type':'application/json',...headers}),body:JSON.stringify(body)});
  t.after(async()=>{for(const req of requests)req.destroy();app.lab.cancel();app.server.closeAllConnections();await new Promise(resolve=>app.close(resolve));assert.equal(app.server.listening,false);});
  const issued=await post('/api/local/launch',{}, {'X-Local-Control':app.controlToken});assert.equal(issued.status,200);
  const exchanged=await post('/api/local/session',{ticket:(await issued.json()).ticket});assert.equal(exchanged.status,200);
  const auth={'X-Local-Session':(await exchanged.json()).session};
  await app.lab.start();await until(()=>app.lab.snapshot().credentialInMemory);
  const state=await(await fetch(url+'/api/status',{headers:auth})).json();
  const headers={...auth,'X-CSRF-Token':state.csrf,'X-Reader-Instance':instanceId};
  async function partial(path,body,extra={}){
    const bytes=Buffer.from(JSON.stringify(body)),checkpoint=deferred();gate={path,...checkpoint};let req;
    const result=new Promise((resolve,reject)=>{req=http.request(url+path,{method:'POST',agent:false,headers:definedHeaders({Origin:url,'Content-Type':'application/json',...headers,...extra})},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('synthetic request deadline')));requests.add(req);req.once('close',()=>requests.delete(req));req.write(bytes.subarray(0,-1));});
    await within(checkpoint.promise);return {result,finish(){req.end(bytes.subarray(-1));}};
  }
  return {app,url,auth,headers,calls,partial,advance(){attempts++;},post:(path,body={},extra={})=>post(path,body,{...headers,...extra})};
}

test('account POST bodies belong to their arrival connection even when reader instance stays the same',async t=>{
  const f=await fixture(t);
  const cases=[['history',{room},202],['send',{room,clientId,text:'SYNTHETIC'},202],['photo',{room,clientId,image:png.toString('base64')},202],['seen',{room,token:'b'.repeat(48),notify:true},202],['context',{room},202],['outbox/ack',{clientId},202],['view',{room},202],['disconnect',{},200]];
  for(const [path,body,status] of cases)await t.test(path,async()=>{
    const before=f.calls.length,old=await f.partial('/api/reader/'+path,body);f.advance();old.finish();const response=await within(old.result);
    assert.equal(response.status,409);assert.equal(response.body.error,'reader_scope_changed');assert.equal(f.calls.length,before,'stale body must not cause a reader action');
    assert.equal((await f.post('/api/reader/'+path,body)).status,status,'same-connection follow-up remains available');assert.equal(f.calls.length,before+1);
  });
  for(const [path,body,status] of [['preferences',{notifications:true},200],['preferences/forget',{},200],['preferences/room',{room,title:'Synthetic alias'},202],['notifications/claim',{},200]])await t.test(path,async()=>{
    const before=f.calls.length,old=await f.partial('/api/'+path,body);f.advance();old.finish();const response=await within(old.result);
    assert.equal(response.status,409);assert.equal(f.calls.length,before);assert.equal((await f.post('/api/'+path,body)).status,status);assert.equal(f.calls.length,before+1);
  });
});

test('headerless operator compatibility cannot carry a slow send into a new connection',async t=>{
  const f=await fixture(t),old=await f.partial('/api/reader/send',{room,clientId,text:'SYNTHETIC'},{'X-Reader-Instance':undefined});
  f.advance();old.finish();assert.equal((await within(old.result)).status,409);assert.deepEqual(f.calls,[]);
  assert.equal((await f.post('/api/reader/send',{room,clientId,text:'SYNTHETIC'},{'X-Reader-Instance':undefined})).status,202);assert.deepEqual(f.calls,['send']);
});

test('reader replacement rejects an old body even when synthetic instance and attempts are reused',async t=>{
  const f=await fixture(t),body={room,clientId,text:'SYNTHETIC'},old=await f.partial('/api/reader/send',body,{'X-Reader-Instance':undefined});
  assert.equal((await f.post('/api/cancel')).status,200);assert.equal((await f.post('/api/start')).status,202);
  await until(()=>f.app.lab.snapshot().credentialInMemory);
  old.finish();assert.equal((await within(old.result)).status,409);assert.deepEqual(f.calls,[]);
  assert.equal((await f.post('/api/reader/send',body)).status,202);assert.deepEqual(f.calls,['send']);
});

test('request connection values are copied even when a reader reuses its mutable snapshot object',async t=>{
  const f=await fixture(t,{reuseSnapshot:true}),old=await f.partial('/api/reader/history',{room});f.advance();old.finish();
  const response=await within(old.result);assert.equal(response.status,409);assert.equal(response.body.error,'reader_scope_changed');assert.deepEqual(f.calls,[]);
  assert.equal((await f.post('/api/reader/history',{room})).status,202);assert.deepEqual(f.calls,['history']);
});

test('coalesced photo consumers have a global limit and abort, completion and clear each release admission once',async()=>{
  const gates=[],cache=createPhotoCache({fetcher:()=>{const gate=deferred();gates.push(gate);return gate.promise;}}),controllers=Array.from({length:512},()=>new AbortController());
  const requests=controllers.map(controller=>cache.get('synthetic:shared',{signal:controller.signal}));requests.forEach(p=>p.catch(()=>{}));
  try{
    assert.equal(gates.length,1);await assert.rejects(within(cache.get('synthetic:other')),/photo_busy/);await assert.rejects(within(cache.get('synthetic:shared')),/photo_busy/);
    controllers[0].abort();await assert.rejects(requests[0]);const replacement=cache.get('synthetic:shared');replacement.catch(()=>{});
    await assert.rejects(within(cache.get('synthetic:shared')),/photo_busy/);gates[0].resolve(photo);assert.strictEqual(await replacement,photo);await Promise.all(requests.slice(1));
    assert.strictEqual(await cache.get('synthetic:shared'),photo,'cache hits do not consume or leak pending admission');
    const next=Array.from({length:512},()=>cache.get('synthetic:next'));next.forEach(p=>p.catch(()=>{}));assert.equal(gates.length,2,'a refused URL cannot waste a queued slot');
    cache.clear();await Promise.all(next.map(p=>assert.rejects(p)));controllers.forEach(c=>c.abort());gates[1].resolve(photo);
    const fresh=cache.get('synthetic:fresh');gates.at(-1).resolve(photo);assert.strictEqual(await fresh,photo);
  }finally{cache.clear();for(const gate of gates)gate.resolve(photo);await Promise.allSettled(requests);}
});

test('repeated synchronous photo failures do not leak global consumer admission',async()=>{
  let fail=true;const cache=createPhotoCache({fetcher:()=>{if(fail)throw new Error('synthetic_fetch_failure');return photo;}});
  try{for(let n=0;n<513;n++)await assert.rejects(cache.get('synthetic:'+n),/synthetic_fetch_failure/);fail=false;assert.strictEqual(await cache.get('synthetic:healthy'),photo);}finally{cache.clear();}
});

test('local session, Host, Origin, CSRF and request-body limits remain enforced',async t=>{
  const f=await fixture(t),body={room,clientId,text:'SYNTHETIC'};
  assert.equal((await fetch(f.url+'/api/status')).status,403);
  for(const extra of [{'X-Local-Session':'0'.repeat(64)},{Origin:'https://untrusted.invalid'},{'X-CSRF-Token':'0'.repeat(64)},{'Sec-Fetch-Site':'cross-site'}])assert.equal((await f.post('/api/reader/send',body,extra)).status,403,Object.keys(extra).join(','));
  const forgedHost=await new Promise((resolve,reject)=>{const req=http.request(f.url+'/api/reader/send',{method:'POST',agent:false,headers:{Origin:f.url,'Content-Type':'application/json',...f.headers,Host:'untrusted.invalid'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify(body));});assert.equal(forgedHost,403);
  assert.equal((await f.post('/api/reader/send',{...body,text:'x'.repeat(21000)})).status,413);assert.equal(f.calls.length,0);
  const good=await f.post('/api/reader/send',body);assert.equal(good.status,202);assert.deepEqual(f.calls,['send']);
  assert.equal(good.headers.get('access-control-allow-origin'),null);assert.equal(good.headers.get('x-content-type-options'),'nosniff');assert.equal(good.headers.get('referrer-policy'),'no-referrer');
});

test('photo capabilities cannot authorize another photo, status or cancellation',async t=>{
  const f=await fixture(t),page=await(await fetch(f.url+'/api/reader/messages?room='+room,{headers:f.auth})).json(),src=page.messages[0].photos[0].src;
  assert.equal((await fetch(f.url+src)).status,200);assert.equal((await fetch(f.url+src.replace('index=0','index=1'))).status,403);
  assert.equal((await fetch(f.url+'/api/status?'+src.split('?')[1])).status,403);
  assert.equal((await fetch(f.url+'/api/photo/cancel',{method:'POST',headers:{Origin:f.url,'Content-Type':'application/json','X-CSRF-Token':f.headers['X-CSRF-Token']},body:JSON.stringify({room,message,index:0,requestId:'1'.repeat(32)})})).status,403);
});

test('photo HTTP requests without requestId share the same 512-consumer admission limit',async t=>{
  const gate=deferred();let fetches=0,arrivals=0;
  const f=await fixture(t,{photoFetcher:(_url,{signal})=>{fetches++;signal.addEventListener('abort',()=>gate.reject(new Error('synthetic_aborted')),{once:true});return gate.promise;}});
  const page=await(await fetch(f.url+'/api/reader/messages?room='+room,{headers:f.auth})).json(),src=page.messages[0].photos[0].src;
  assert.equal(src.includes('request='),false);f.app.server.on('request',req=>{if(req.url===src)arrivals++;});
  const pending=[];
  const get=()=>new Promise((resolve,reject)=>{const req=http.get(f.url+src,{agent:false},res=>{res.resume();res.on('error',reject);res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);});
  try{
    // Batch arrivals to avoid the OS listen-backlog limit testing the client.
    for(let batch=0;batch<8;batch++){for(let n=0;n<64;n++){const request=get();request.catch(()=>{});pending.push(request);}await until(()=>arrivals>=(batch+1)*64);}
    assert.equal(fetches,1);assert.equal(await within(get()),502,'overflow must fail promptly without a second upstream fetch');assert.equal(fetches,1);
    gate.resolve(photo);assert.ok((await within(Promise.all(pending))).every(status=>status===200));
    assert.equal(await get(),200,'cached responses remain available after all consumers finish');assert.equal(fetches,1);
  }finally{gate.resolve(photo);await Promise.allSettled(pending);}
});

test('photo URL and redirect checks reject private DNS and foreign hosts without unsafe requests',async()=>{
  const source='https://synthetic.kakaocdn.net/photo';let wires=0;
  for(const url of ['https://talkv.kakao.com.untrusted.invalid/a','https://user@talkv.kakao.com/a','https://talkv.kakao.com:8443/a','http://127.0.0.1/a','file:///etc/passwd'])assert.equal(photoUrl(url),null);
  for(const address of ['127.0.0.1','10.1.1.1','169.254.169.254','::1','::ffff:127.0.0.1'])await assert.rejects(fetchPhoto(source,{resolve:async()=>[{address,family:address.includes(':')?6:4}],request(){wires++;throw new Error('forbidden wire');}}));
  assert.equal(wires,0);
  const request=(_url,options,callback)=>{wires++;assert.equal(options.autoSelectFamily,false);options.lookup('ignored',{},(error,address)=>{assert.equal(error,null);assert.equal(address,'1.1.1.1');});const req=new EventEmitter();req.end=()=>queueMicrotask(()=>callback(Object.assign(new EventEmitter(),{statusCode:302,headers:{location:'http://127.0.0.1/private'},resume(){}})));req.destroy=()=>{};return req;};
  await assert.rejects(fetchPhoto(source,{resolve:async()=>[{address:'1.1.1.1',family:4}],request}));assert.equal(wires,1);
});
