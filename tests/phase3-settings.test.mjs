import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readdirSync,readFileSync,writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createPreferenceStore,preferenceId } from '../experiments/local-web/preferences.mjs';
import { createRoomState } from '../experiments/local-web/reader-room-state.mjs';
import { createReaderStore } from '../experiments/local-web/reader-data.mjs';
import { createReadOnlyReader } from '../experiments/local-web/reader-manager.mjs';
import { photoAttachments,photoUrl,fetchPhoto,imageType,createPhotoCache } from '../experiments/local-web/photos.mjs';
import { createLocalServer } from '../experiments/local-web/server.mjs';
const folder=()=>mkdtempSync(join(resolve('local-only'),'settings-test-'));
const room='r_'+'a'.repeat(24),message='m_'+'b'.repeat(24),secret=Buffer.alloc(32,9),privateUrl='https://talkv.kakao.com/synthetic/private-photo';
const incoming=(key=message)=>({key,incoming:true,afterBaseline:true,userMessage:true});
test('explicit persistence survives a new store without writing raw account or room IDs',()=>{
  const directory=folder(),store=createPreferenceStore({folder:directory}),profile=store.account('12345678901234567890');
  const key=preferenceId(profile.key(),'room','12345678901234567890','99998888777766665555');
  assert.equal(profile.setRoom(key,{title:'합성 이름',pinOrder:2,muted:true}),true);assert.equal(readdirSync(directory).length,0);
  assert.equal(profile.set({persist:true,notifications:true,readSync:true,roomFilter:'pinned'}),true);
  const json=readdirSync(directory).filter(path=>path.endsWith('.json'));assert.equal(json.length,1);
  const raw=readFileSync(join(directory,json[0]),'utf8');for(const value of ['12345678901234567890','99998888777766665555','accessToken','password','messages'])assert.equal(raw.includes(value),false);
  profile.close();const next=createPreferenceStore({folder:directory}).account('12345678901234567890');
  assert.equal(next.snapshot().persist,true);assert.equal(next.snapshot().readSync,true);assert.equal(next.room(key).title,'합성 이름');
});
test('account settings isolate identities and disabling storage deletes only that account file',()=>{
  const directory=folder(),store=createPreferenceStore({folder:directory}),one=store.account('111'),two=store.account('222');
  one.set({persist:true,notifications:true});two.set({persist:true,readSync:true});assert.equal(readdirSync(directory).filter(p=>p.endsWith('.json')).length,2);
  assert.equal(one.set({persist:false}),true);assert.equal(one.snapshot().notifications,true);assert.equal(two.snapshot().readSync,true);
  assert.equal(readdirSync(directory).filter(p=>p.endsWith('.json')).length,1);
  assert.equal(createPreferenceStore({folder:directory}).account('111').snapshot().notifications,false);
  assert.equal(createPreferenceStore({folder:directory}).account('222').snapshot().readSync,true);
});
test('storage failure is reported without committing or losing in-memory settings',()=>{
  const profile=createPreferenceStore({folder:folder(),secureFolder:()=>{throw new Error('fixture');}}).account('111');
  assert.equal(profile.set({readSync:true}),true);assert.equal(profile.set({persist:true}),false);
  assert.equal(profile.snapshot().persist,false);assert.equal(profile.snapshot().readSync,true);assert.equal(profile.snapshot().storageError,true);
});
test('damaged settings or installation keys do not expose another account or stop memory-only use',()=>{
  const directory=folder(),one=createPreferenceStore({folder:directory}).account('111');one.set({persist:true});
  const path=readdirSync(directory).find(p=>p.endsWith('.json'));writeFileSync(join(directory,path),'{bad');
  const damaged=createPreferenceStore({folder:directory}).account('111');assert.equal(damaged.snapshot().storageError,true);assert.equal(damaged.snapshot().notifications,false);
  writeFileSync(join(directory,'identity.key'),'bad');const broken=createPreferenceStore({folder:directory}).account('111');
  assert.equal(broken.snapshot().storageAvailable,false);assert.equal(broken.set({readSync:true}),true);assert.equal(broken.set({persist:true}),false);
});
test('settings accept only bounded names and known options, with separate HMAC domains',()=>{
  const profile=createPreferenceStore().account('111'),id=preferenceId(secret,'room','111','222');
  assert.equal(profile.set({accessToken:'forbidden'}),false);assert.equal(profile.set({notifications:1}),false);
  assert.equal(profile.setRoom(id,{title:'x\ny'}),false);assert.equal(profile.setRoom(id,{title:'😀'.repeat(121)}),false);assert.equal(profile.setRoom(id,{pinOrder:-1}),false);
  assert.notEqual(id,preferenceId(secret,'room','222','111'));assert.notEqual(id,preferenceId(secret,'account','111','222'));
});
test('a changed installation key is not overwritten by an older running session',()=>{
  const directory=folder(),profile=createPreferenceStore({folder:directory}).account('111');
  const replacement=Buffer.alloc(32,7);writeFileSync(join(directory,'identity.key'),replacement);
  assert.equal(profile.set({persist:true}),false);assert.equal(readFileSync(join(directory,'identity.key')).equals(replacement),true);
});
test('notification claims deduplicate arrivals across tabs and muted rooms retain unread badges',()=>{
  const ledger=createRoomState();ledger.bind([{key:room}]);ledger.notifications(true);
  ledger.receive(room,[incoming(),incoming(),{...incoming('m_'+'c'.repeat(24)),incoming:false}]);
  assert.equal(ledger.claim().length,1);assert.deepEqual(ledger.claim(),[]);
  ledger.settings(room,{muted:true});ledger.receive(room,[incoming('m_'+'d'.repeat(24))]);assert.equal(ledger.decorate({key:room}).unreadLocalCount,2);assert.deepEqual(ledger.claim(),[]);
});
test('read, disabled, baseline and control events do not produce old notifications',()=>{
  const ledger=createRoomState();ledger.bind([{key:room}]);ledger.notifications(true);
  ledger.receive(room,[{...incoming(),afterBaseline:false},{...incoming('m_'+'c'.repeat(24)),userMessage:false}]);assert.deepEqual(ledger.claim(),[]);
  ledger.receive(room,[incoming('m_'+'d'.repeat(24))]);const token=ledger.issue(room,message);ledger.seen(room,token);assert.deepEqual(ledger.claim(),[]);
  ledger.receive(room,[incoming('m_'+'e'.repeat(24))]);ledger.notifications(false);ledger.notifications(true);assert.deepEqual(ledger.claim(),[]);
});
test('single and multiple photos accept known CDN URLs and reject arbitrary URLs and oversized metadata',()=>{
  assert.equal(photoUrl('http://talkv.kakao.com/photo'),'https://talkv.kakao.com/photo');
  for(const url of ['https://127.0.0.1/a','https://talkv.kakao.com.evil.test/a','https://evil.test/a','https://user:pass@talkv.kakao.com/a','https://talkv.kakao.com:8443/a','data:image/svg+xml,x'])assert.equal(photoUrl(url),null);
  assert.equal(photoAttachments({type:1,attachment:JSON.stringify({url:privateUrl})}).length,0);
  assert.equal(photoAttachments({type:2,attachment:JSON.stringify({url:privateUrl,w:640,h:480})})[0].width,640);
  assert.equal(photoAttachments({type:27,attachment:{imageUrls:[privateUrl,'https://evil.test/a']}}).length,1);
  assert.deepEqual(photoAttachments({type:2,attachment:'x'.repeat(65537)}),[]);
  assert.equal(imageType(Buffer.from('<svg onload=alert(1)>')),null);
});
test('photo DNS never connects to a private address',async()=>{
  let requests=0;await assert.rejects(fetchPhoto(privateUrl,{resolve:async()=>[{address:'127.0.0.1',family:4}],request:()=>{requests++;}}));assert.equal(requests,0);
});
test('photo redirects cannot escape the CDN allowlist and use the validated address',async()=>{
  let lookups=0,requests=0;
  const request=(_url,options,callback)=>{
    requests++;assert.equal(options.autoSelectFamily,false);options.lookup('ignored',{},(_error,address)=>assert.equal(address,'1.1.1.1'));
    const req=Object.assign(new EventEmitter(),{end(){queueMicrotask(()=>callback(Object.assign(new EventEmitter(),{statusCode:302,headers:{location:'https://evil.test/photo'},resume(){}})));},destroy(){}});return req;
  };
  await assert.rejects(fetchPhoto(privateUrl,{resolve:async()=>{lookups++;return [{address:'1.1.1.1',family:4}];},request}));assert.equal(lookups,1);assert.equal(requests,1);
});
test('photo cache shares requests, aborts at account end and never resurrects an expired cache',async()=>{
  let resolveFetch,calls=0;const cache=createPhotoCache({fetcher:async(_url,{signal})=>{calls++;return new Promise(resolve=>{resolveFetch=()=>resolve({data:Buffer.alloc(12),type:'image/png'});signal.addEventListener('abort',()=>{});});}});
  const one=cache.get(privateUrl),two=cache.get(privateUrl);assert.equal(calls,1);cache.clear();resolveFetch();await assert.rejects(one);await assert.rejects(two);
});
test('photo requests wait for one of four slots instead of failing a visible gallery',async()=>{
  let active=0,max=0;const releases=[];
  const cache=createPhotoCache({fetcher:async()=>{active++;max=Math.max(max,active);return new Promise(resolve=>releases.push(()=>{active--;resolve({data:Buffer.alloc(12),type:'image/png'});}));}});
  const jobs=Array.from({length:6},(_,i)=>cache.get(privateUrl+'/'+i));assert.equal(active,4);
  releases.shift()();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(active,4);
  while(releases.length){releases.shift()();await new Promise(resolve=>setTimeout(resolve,0));}
  await Promise.all(jobs);assert.equal(max,4);cache.clear();
});
test('stable room preference identifiers and photo URLs stay out of browser DTOs',()=>{
  const child=Object.assign(new EventEmitter(),{send(_message,done){done?.();},kill(){}}),reader=createReadOnlyReader({spawn:()=>child});
  reader.connect({userId:'111',accessToken:'FAKE',deviceUUID:'FAKE'});child.emit('message',{type:'reader-ready'});
  child.emit('message',{type:'reader-rooms',source:'loginlist',rooms:[{key:room,title:'합성',preferenceKey:'e'.repeat(64)}]});
  child.emit('message',{type:'reader-messages',source:'push',key:room,messages:[{key:message,text:'[사진]',photos:[{url:privateUrl,width:20,height:30}]}]});
  const json=JSON.stringify({rooms:reader.rooms(),page:reader.messages(room)});assert.equal(json.includes(privateUrl),false);assert.equal(json.includes('preferenceKey'),false);assert.equal(json.includes('/api/photo?room='),true);assert.equal(reader.photo(room,message,0),privateUrl);reader.close();
  const store=createReaderStore({chatDatas:[{c:'222',t:'DirectChat'}]},'111',Buffer.alloc(32,1),secret);assert.equal(store.rooms()[0].preferenceKey,preferenceId(secret,'room','111','222'));
});
test('new settings and photo routes preserve authentication, CSRF and private URL boundaries',async()=>{
  let settings={persist:false,notifications:false,readSync:false,roomFilter:'all'},writes=0;
  const app=createLocalServer({mode:'live',encode:()=>[[true]],transport:async op=>op==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:op==='generate'?{httpStatus:200,body:{status:0,url:'OFFLINE',remainingSeconds:60}}:{httpStatus:200,body:{status:0,user:{userId:'111'},accessToken:'FAKE'}},photoFetcher:async()=>({data:Buffer.from('synthetic image'),type:'image/png'}),readerFactory:()=>({snapshot:()=>({phase:'connected',canConnect:false}),close(){},photo:(key,msg,index)=>key===room && msg===message && index===0?privateUrl:null,settingsSnapshot:()=>settings,updateSettings(patch){writes++;settings={...settings,...patch};return true;},claimNotifications:()=>[]})});
  const url=await app.listen(0);
  try{
    assert.equal((await fetch(url+'/api/preferences')).status,403);
    const home=await fetch(url+'/'),cookie=home.headers.get('set-cookie').split(';')[0],state=await(await fetch(url+'/api/status',{headers:{cookie}})).json();
    const post=(path,body,origin=url)=>fetch(url+path,{method:'POST',headers:{cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':state.csrf},body:JSON.stringify(body)});
    await post('/api/start',{});await new Promise(resolve=>setTimeout(resolve,2100));
    assert.equal((await post('/api/preferences',{notifications:true},'https://evil.test')).status,403);
    assert.equal((await post('/api/preferences',{notifications:true,accessToken:'forbidden'})).status,400);assert.equal(writes,0);
    assert.equal((await post('/api/preferences',{notifications:true})).status,200);assert.equal(writes,1);
    const path=`/api/photo?room=${room}&message=${message}&index=0`;
    assert.equal((await fetch(url+path,{headers:{cookie}})).status,200);
    assert.equal((await fetch(url+path+'&url='+encodeURIComponent(privateUrl),{headers:{cookie}})).status,400);
    await post('/api/cancel',{});assert.equal((await fetch(url+path,{headers:{cookie}})).status,409);
  }finally{app.lab.cancel();app.server.close();app.server.closeAllConnections();}
});
