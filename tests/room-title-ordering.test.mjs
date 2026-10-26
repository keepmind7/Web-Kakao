import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {createLocalServer} from '../experiments/local-web/server.mjs';
import {createReadOnlyReader} from '../experiments/local-web/reader-manager.mjs';

const room=n=>'r_'+n.toString(16).padStart(24,'0');
const client=n=>`${n.toString(16).padStart(8,'0')}-0000-4000-8000-000000000000`;
const pause=()=>new Promise(resolve=>setImmediate(resolve));
function latch(){let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};}
async function within(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('synthetic checkpoint timeout: '+label)),4000);})]);}finally{clearTimeout(timer);}}
async function fixture({readerFactory,beforePreference,beforeForget,forgetAtAdmission=false}={}){
  const titles=new Map(),patches=[],sockets=new Set(),closed=[];let attempts=1;
  const syntheticReader=()=>({
    snapshot:()=>({instanceId:'1'.repeat(24),attempts,phase:'connected',revision:1,roomCount:500}),
    close(){},rooms:()=>({rooms:[...titles].map(([key,title])=>({key,title}))}),
    settingsSnapshot:()=>({persist:false,notifications:false,readSync:false,roomFilter:'all'}),
    forgetSettings(){
      const accepted=beforeForget?.(),reset=()=>{titles.clear();return true;};
      if(forgetAtAdmission)reset();
      const finish=value=>value!==false && (forgetAtAdmission || reset());
      return accepted?.then?Promise.resolve(accepted).then(finish):finish(accepted);
    },
    roomPreferences(key,patch,options={}){
      const apply=()=>{if(options.isCurrent?.()===false)return false;patches.push({key,...patch});if(Object.hasOwn(patch,'title'))titles.set(key,patch.title);return true;};
      const admission=beforePreference?.(key,patch,options);
      return admission?.then?Promise.resolve(admission).then(accepted=>accepted!==false && apply()):admission!==false && apply();
    },
  });
  const app=createLocalServer({mode:'live',messaging:true,controlToken:'f'.repeat(64),preferenceStore:{close(){}},encode:()=>[[true]],
    transport:async op=>({httpStatus:200,body:op==='allowlist'?{allowlisted:true}:op==='generate'?{status:0,url:'SYNTHETIC_NO_LOGIN',remainingSeconds:60}:{status:0,user:{userId:'999'},accessToken:'SYNTHETIC_NO_ACCOUNT'}}),
    readerFactory:readerFactory ?? syntheticReader});
  app.server.on('connection',socket=>{sockets.add(socket);closed.push(new Promise(resolve=>socket.once('close',()=>{sockets.delete(socket);resolve();})));});
  const url=await app.listen(0);assert.notEqual(app.server.address().port,8787);
  const request=(path,body,extra={})=>new Promise((resolve,reject)=>{
    const req=http.request(url+path,{method:'POST',agent:false,headers:{Origin:url,'Content-Type':'application/json',...extra}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.once('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
    });req.once('error',reject);req.end(JSON.stringify(body));
  });
  const issued=await request('/api/local/launch',{}, {'X-Local-Control':app.controlToken});assert.equal(issued.status,200);
  const exchanged=await request('/api/local/session',{ticket:issued.body.ticket});assert.equal(exchanged.status,200);
  const auth={'X-Local-Session':exchanged.body.session};
  await app.lab.start();
  const authenticated=async()=>{const deadline=Date.now()+4000;while(!app.lab.snapshot().credentialInMemory){assert.ok(Date.now()<deadline,'synthetic authentication did not settle');await pause();}};
  await authenticated();
  const state=await(await fetch(url+'/api/status',{headers:auth})).json();
  const headers={...auth,'X-CSRF-Token':state.csrf,...(state.reader?.instanceId?{'X-Reader-Instance':state.reader.instanceId}:{})};
  const held=new Set();
  function partial(body){
    const json=JSON.stringify(body),entered=latch();
    const listener=req=>{if(req.url==='/api/preferences/room'){app.server.off('request',listener);entered.release();}};
    app.server.on('request',listener);
    let requestObject;
    const result=new Promise((resolve,reject)=>{
      const req=requestObject=http.request(url+'/api/preferences/room',{method:'POST',agent:false,headers:{...headers,Origin:url,'Content-Type':'application/json'}},res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.once('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
      });held.add(req);req.once('close',()=>held.delete(req));req.once('error',reject);req.write(json.slice(0,10));
    });
    return {entered:entered.promise,result,finish:()=>requestObject.end(json.slice(10))};
  }
  return {app,url,titles,patches,state,headers,auth,partial,authenticated,advance:()=>attempts++,
    post:body=>request('/api/preferences/room',body,headers),request,
    async close(){for(const req of held)req.destroy();app.server.closeAllConnections();await new Promise(resolve=>app.close(resolve));await Promise.all(closed);assert.equal(app.server.listening,false);assert.equal(sockets.size,0);assert.equal(app.lab.snapshot().credentialInMemory,false);}};
}

test('an earlier partial legacy title body cannot overwrite a later completed title request',async()=>{
  const f=await fixture();
  try{
    const old=f.partial({room:room(1),title:'First edit'});await old.entered;
    assert.equal((await f.post({room:room(1),title:'Latest edit'})).status,202);
    old.finish();assert.equal((await old.result).status,409);
    assert.equal(f.titles.get(room(1)),'Latest edit');assert.deepEqual(f.patches,[{key:room(1),title:'Latest edit'}]);
  }finally{await f.close();}
});

test('room preference ordering is explicitly advertised by the local server',async()=>{
  const f=await fixture();try{assert.equal(f.state.roomPreferenceOrdering,true);}finally{await f.close();}
});

test('same-page room sequences reject lower and equal values, including title resets',async()=>{
  const f=await fixture(),metadata={preferenceClientId:client(1)};
  try{
    assert.equal((await f.post({room:room(1),title:'Latest',...metadata,preferenceSequence:2})).status,202);
    for(const sequence of [1,2]){
      const response=await f.post({room:room(1),title:'Stale',...metadata,preferenceSequence:sequence});
      assert.equal(response.status,409);assert.equal(response.body.error,'stale_room_preference');
    }
    assert.equal((await f.post({room:room(1),title:null,...metadata,preferenceSequence:3})).status,202);
    assert.equal(f.titles.get(room(1)),null);
    assert.equal((await f.post({room:room(1),title:'Stale again',...metadata,preferenceSequence:2})).status,409);
    assert.equal(f.titles.get(room(1)),null);
  }finally{await f.close();}
});

test('a higher same-page sequence wins even when its authenticated headers arrived first',async()=>{
  const f=await fixture(),metadata={preferenceClientId:client(1)};
  try{
    const latest=f.partial({room:room(1),title:'Latest intent',...metadata,preferenceSequence:2});await latest.entered;
    assert.equal((await f.post({room:room(1),title:'Earlier intent',...metadata,preferenceSequence:1})).status,202);
    latest.finish();assert.equal((await latest.result).status,202);assert.equal(f.titles.get(room(1)),'Latest intent');
  }finally{await f.close();}
});

test('title reservations are independent across rooms and from pin or mute writes',async()=>{
  const f=await fixture(),metadata={preferenceClientId:client(1),preferenceSequence:1};
  try{
    const held=f.partial({room:room(1),title:'Room one',...metadata});await held.entered;
    assert.equal((await f.post({room:room(2),title:'Room two',...metadata})).status,202);
    assert.equal((await f.post({room:room(1),pinOrder:7})).status,202);
    assert.equal((await f.post({room:room(1),muted:true})).status,202);
    held.finish();assert.equal((await held.result).status,202);
    assert.equal(f.titles.get(room(1)),'Room one');assert.equal(f.titles.get(room(2)),'Room two');
    assert.deepEqual(f.patches.filter(row=>row.key===room(1)).map(({key,...patch})=>patch),[{pinOrder:7},{muted:true},{title:'Room one'}]);
  }finally{await f.close();}
});

test('different pages have separate sequences while cross-page and legacy headers keep arrival order',async()=>{
  const f=await fixture();
  try{
    assert.equal((await f.post({room:room(1),title:'Page one',preferenceClientId:client(1),preferenceSequence:50})).status,202);
    assert.equal((await f.post({room:room(1),title:'Page two',preferenceClientId:client(2),preferenceSequence:1})).status,202);
    const old=f.partial({room:room(1),title:'Delayed page one',preferenceClientId:client(1),preferenceSequence:51});await old.entered;
    assert.equal((await f.post({room:room(1),title:'Legacy later'})).status,202);
    old.finish();const stale=await old.result;assert.equal(stale.status,409);assert.equal(stale.body.error,'stale_room_preference');
    assert.equal(f.titles.get(room(1)),'Legacy later');
    assert.equal((await f.post({room:room(1),title:'Page two later',preferenceClientId:client(2),preferenceSequence:2})).status,202);
  }finally{await f.close();}
});

test('a failed latest reservation never revives an earlier incomplete title intent',async()=>{
  const f=await fixture({beforePreference:(_key,patch)=>patch.title!=='Failed latest'});
  try{
    const old=f.partial({room:room(1),title:'Stale first',preferenceClientId:client(1),preferenceSequence:1});await old.entered;
    assert.equal((await f.post({room:room(1),title:'Failed latest',preferenceClientId:client(1),preferenceSequence:2})).status,409);
    old.finish();assert.equal((await old.result).body.error,'stale_room_preference');assert.equal(f.patches.length,0);
    assert.equal((await f.post({room:room(1),title:'Replay',preferenceClientId:client(1),preferenceSequence:2})).body.error,'stale_room_preference');
    assert.equal((await f.post({room:room(1),title:'New latest',preferenceClientId:client(1),preferenceSequence:3})).status,202);
  }finally{await f.close();}
});

test('malformed or half-present ordering metadata is rejected without invoking the reader',async()=>{
  const f=await fixture(),valid={room:room(1),title:'Synthetic'};
  try{
    const invalid=[
      {...valid,preferenceClientId:client(1)},
      {...valid,preferenceSequence:1},
      ...[0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'1',null].map(preferenceSequence=>({...valid,preferenceClientId:client(1),preferenceSequence})),
      ...['not-a-uuid','x'.repeat(128),null].map(preferenceClientId=>({...valid,preferenceClientId,preferenceSequence:1})),
      {room:room(1),pinOrder:1,preferenceClientId:client(1),preferenceSequence:1},
      {...valid,preferenceClientId:client(1),preferenceSequence:1,unknown:true},
    ];
    for(const body of invalid){const response=await f.post(body);assert.equal(response.status,400,JSON.stringify(body));assert.equal(response.body.error,'invalid_title');}
    assert.equal(f.patches.length,0);
    assert.equal((await f.post({...valid,preferenceClientId:client(1),preferenceSequence:1})).status,202,'invalid inputs cannot consume a sequence');
  }finally{await f.close();}
});

test('reconnect attempts invalidate delayed bodies even when reader instance stays the same',async()=>{
  const f=await fixture();
  try{
    const old=f.partial({room:room(1),title:'Old connection',preferenceClientId:client(1),preferenceSequence:1});await old.entered;
    f.advance();
    assert.equal((await f.post({room:room(1),title:'New connection',preferenceClientId:client(1),preferenceSequence:1})).status,202);
    old.finish();const response=await old.result;assert.equal(response.status,409);assert.equal(response.body.error,'reader_scope_changed');
    assert.equal(f.titles.get(room(1)),'New connection');
  }finally{await f.close();}
});

test('reader replacement invalidates delayed title bodies across a new synthetic login',async()=>{
  const f=await fixture();
  try{
    const old=f.partial({room:room(1),title:'Replaced reader'});await old.entered;
    assert.equal((await f.request('/api/cancel',{},f.headers)).status,200);
    assert.equal((await f.request('/api/start',{},f.headers)).status,202);await f.authenticated();
    assert.equal((await f.post({room:room(1),title:'Current reader'})).status,202);
    old.finish();const response=await old.result;assert.equal(response.status,409);assert.equal(response.body.error,'reader_scope_changed');
    assert.equal(f.titles.get(room(1)),'Current reader');
  }finally{await f.close();}
});

test('500 room title watermarks are retained until reconnect and do not evict old protection',async()=>{
  const f=await fixture();
  try{
    for(let n=1;n<=500;n++)assert.equal((await f.post({room:room(n),title:'Synthetic',preferenceClientId:client(1),preferenceSequence:1})).status,202);
    const overflow=await f.post({room:room(501),title:'Overflow',preferenceClientId:client(1),preferenceSequence:1});
    assert.equal(overflow.status,409);assert.equal(overflow.body.error,'room_preference_limit');
    assert.equal((await f.post({room:room(1),title:'Old replay',preferenceClientId:client(1),preferenceSequence:1})).body.error,'stale_room_preference');
    assert.equal((await f.post({room:room(1),title:'Existing room update',preferenceClientId:client(1),preferenceSequence:2})).status,202);
    f.advance();assert.equal((await f.post({room:room(501),title:'After reconnect',preferenceClientId:client(1),preferenceSequence:1})).status,202);
  }finally{await f.close();}
});

test('128 page watermarks per room fail closed without removing older sequence evidence',async()=>{
  const f=await fixture();
  try{
    for(let n=1;n<=128;n++)assert.equal((await f.post({room:room(1),title:'Synthetic',preferenceClientId:client(n),preferenceSequence:1})).status,202);
    const overflow=await f.post({room:room(1),title:'Overflow',preferenceClientId:client(129),preferenceSequence:1});
    assert.equal(overflow.status,409);assert.equal(overflow.body.error,'room_preference_limit');
    assert.equal((await f.post({room:room(1),title:'Old replay',preferenceClientId:client(1),preferenceSequence:1})).body.error,'stale_room_preference');
    assert.equal((await f.post({room:room(1),title:'Existing page',preferenceClientId:client(1),preferenceSequence:2})).status,202);
    assert.equal((await f.post({room:room(2),title:'Independent room',preferenceClientId:client(129),preferenceSequence:1})).status,202);
  }finally{await f.close();}
});

function managerFixture(){
  const children=[],disk=new Map(),published=[],observed=[],firstEntered=latch(),secondEntered=latch(),forgetEntered=latch(),releaseFirst=latch();
  const preferenceKey='a'.repeat(64);let reader,tail=Promise.resolve(),setRoomCalls=0;
  const profile={key:()=>Buffer.alloc(32,7),snapshot:()=>({persist:true,notifications:false,readSync:false,roomFilter:'all'}),room:key=>disk.get(key),close(){},
    setRoom(key,patch,{isCurrent=()=>true}={}){
      const index=++setRoomCalls;if(index===2)secondEntered.release();
      const job=tail.then(async()=>{
        if(index===1){firstEntered.release();await releaseFirst.promise;}
        const current=isCurrent();observed.push({title:patch.title,current,memoryTitle:reader.rooms().rooms[0]?.title});
        if(!current)return false;disk.set(key,{...disk.get(key),...patch});published.push({...patch});return true;
      });tail=job.catch(()=>{});return job;
    },
    forget({isCurrent=()=>true}={}){forgetEntered.release();const job=tail.then(()=>{if(!isCurrent())return false;disk.clear();return true;});tail=job.catch(()=>{});return job;},
  };
  reader=createReadOnlyReader({messaging:true,preferenceStore:{account:()=>profile},spawn:()=>{
    const child=Object.assign(new EventEmitter(),{send(_value,callback){callback?.();},kill(){queueMicrotask(()=>child.emit('exit',0,null));}});children.push(child);return child;
  }});
  const connect=()=>{assert.equal(reader.connect({userId:'999',deviceUUID:'SYNTHETIC',accessToken:'SYNTHETIC_NO_ACCOUNT'}),true);const child=children.at(-1);child.emit('message',{type:'reader-ready'});child.emit('message',{type:'reader-rooms',source:'loginlist',rooms:[{key:room(1),title:'Original',titleKnown:true,kind:'DirectChat',canSend:true,preferenceKey}]});assert.equal(reader.snapshot().phase,'connected');};
  connect();return {reader,profile,disk,published,observed,firstEntered,secondEntered,forgetEntered,releaseFirst,connect,preferenceKey};
}

test('a new HTTP reservation blocks an older durable profile publication and manager memory apply',async()=>{
  const m=managerFixture(),f=await fixture({readerFactory:()=>m.reader});
  let first;
  try{
    first=f.post({room:room(1),title:'Stale durable',preferenceClientId:client(1),preferenceSequence:1});await within(m.firstEntered.promise,'first durable entry');
    const latest=f.post({room:room(1),title:'Current durable',preferenceClientId:client(1),preferenceSequence:2});await within(m.secondEntered.promise,'latest durable entry');
    m.releaseFirst.release();
    const [a,b]=await Promise.all([first,latest]);assert.equal(a.status,409);assert.equal(a.body.error,'stale_room_preference');assert.equal(b.status,202);
    assert.deepEqual(m.published,[{title:'Current durable'}]);assert.equal(m.disk.get(m.preferenceKey).title,'Current durable');
    assert.deepEqual(m.observed[0],{title:'Stale durable',current:false,memoryTitle:'Original'});
    assert.equal(m.reader.rooms().rooms[0].title,'Current durable');
  }finally{m.releaseFirst.release();await first?.catch(()=>{});await f.close();}
});

test('the manager composes an external title predicate with its own profile and room guard',async()=>{
  const m=managerFixture();let current=true;
  try{
    const pending=m.reader.roomPreferences(room(1),{title:'Canceled durable'},{isCurrent:()=>current});await within(m.firstEntered.promise,'direct durable entry');
    current=false;m.releaseFirst.release();assert.equal(await pending,false);assert.equal(m.published.length,0);assert.equal(m.reader.rooms().rooms[0].title,'Original');
  }finally{m.releaseFirst.release();m.reader.close();}
});

test('legacy manager rename also forwards its external title predicate to durable storage',async()=>{
  const m=managerFixture();let current=true;
  try{
    const pending=m.reader.rename(room(1),'Canceled compatibility rename',{isCurrent:()=>current});await within(m.firstEntered.promise,'compatibility durable entry');
    current=false;m.releaseFirst.release();assert.equal(await pending,false);assert.equal(m.published.length,0);assert.equal(m.reader.rooms().rooms[0].title,'Original');
  }finally{m.releaseFirst.release();m.reader.close();}
});

test('forget completion prevents a previously incomplete title body from resurrecting an alias',async()=>{
  const f=await fixture();
  try{
    const old=f.partial({room:room(1),title:'Before reset',preferenceClientId:client(1),preferenceSequence:1});await old.entered;
    assert.equal((await f.request('/api/preferences/forget',{},f.headers)).status,200);
    old.finish();const response=await old.result;assert.equal(response.status,409);
    assert.equal(f.titles.size,0);assert.equal(f.patches.length,0);
  }finally{await f.close();}
});

test('forget admission invalidates an older manager durable write before its publication checkpoint',async()=>{
  const m=managerFixture(),f=await fixture({readerFactory:()=>m.reader});let first,reset;
  try{
    first=f.post({room:room(1),title:'Before durable reset',preferenceClientId:client(1),preferenceSequence:1});await within(m.firstEntered.promise,'pre-reset durable entry');
    reset=f.request('/api/preferences/forget',{},f.headers);await within(m.forgetEntered.promise,'forget admission');
    m.releaseFirst.release();const [a,b]=await Promise.all([first,reset]);assert.equal(a.status,409);assert.equal(b.status,200);
    assert.deepEqual(m.published,[]);assert.equal(m.disk.size,0);
    assert.equal(m.observed[0].current,false);assert.equal(m.reader.rooms().rooms[0].title,'Original');
  }finally{m.releaseFirst.release();await Promise.all([first?.catch(()=>{}),reset?.catch(()=>{})]);await f.close();}
});

test('forget failure still retires earlier incomplete alias intents',async()=>{
  const f=await fixture({beforeForget:()=>false});
  try{
    const old=f.partial({room:room(1),title:'Before failed reset'});await old.entered;
    const reset=await f.request('/api/preferences/forget',{},f.headers);assert.equal(reset.status,409);assert.equal(reset.body.error,'settings_unavailable');
    old.finish();const response=await old.result;assert.equal(response.status,409);assert.equal(f.titles.size,0);assert.equal(f.patches.length,0);
  }finally{await f.close();}
});

test('forget admission preserves new title reservations created before its delayed response',async()=>{
  const entered=latch(),release=latch(),f=await fixture({forgetAtAdmission:true,beforeForget:()=>{entered.release();return release.promise;}});let reset;
  try{
    const old=f.partial({room:room(1),title:'Before reset',preferenceClientId:client(1),preferenceSequence:1});await old.entered;
    reset=f.request('/api/preferences/forget',{},f.headers);await within(entered.promise,'delayed forget response');
    assert.equal((await f.post({room:room(1),title:'After reset',preferenceClientId:client(1),preferenceSequence:2})).status,202);
    old.finish();assert.equal((await old.result).status,409);
    release.release(true);assert.equal((await reset).status,200);assert.equal(f.titles.get(room(1)),'After reset');
    assert.equal((await f.post({room:room(1),title:'Replay after reset',preferenceClientId:client(1),preferenceSequence:2})).body.error,'stale_room_preference');
  }finally{release.release(true);await reset?.catch(()=>{});await f.close();}
});

test('rejected forget authentication or body cannot invalidate a current alias request',async()=>{
  const f=await fixture();
  try{
    const old=f.partial({room:room(1),title:'Still current'});await old.entered;
    assert.equal((await f.request('/api/preferences/forget',{unknown:true},f.headers)).status,400);
    assert.equal((await f.request('/api/preferences/forget',{}, {...f.headers,'X-CSRF-Token':'0'.repeat(64)})).status,403);
    old.finish();assert.equal((await old.result).status,202);assert.equal(f.titles.get(room(1)),'Still current');
  }finally{await f.close();}
});

test('a reconnect attempt invalidates a title already waiting at its durable publication checkpoint',async()=>{
  const m=managerFixture(),f=await fixture({readerFactory:()=>m.reader});let first,latest;
  try{
    first=f.post({room:room(1),title:'Previous attempt',preferenceClientId:client(1),preferenceSequence:1});await within(m.firstEntered.promise,'previous attempt durable entry');
    m.reader.disconnect();m.connect();
    latest=f.post({room:room(1),title:'New attempt',preferenceClientId:client(1),preferenceSequence:1});await within(m.secondEntered.promise,'new attempt durable entry');
    m.releaseFirst.release();const [a,b]=await Promise.all([first,latest]);assert.equal(a.status,409);assert.equal(a.body.error,'reader_scope_changed');assert.equal(b.status,202);
    assert.deepEqual(m.published,[{title:'New attempt'}]);assert.equal(m.observed[0].current,false);assert.equal(m.reader.rooms().rooms[0].title,'New attempt');
  }finally{m.releaseFirst.release();await Promise.all([first?.catch(()=>{}),latest?.catch(()=>{})]);await f.close();}
});
