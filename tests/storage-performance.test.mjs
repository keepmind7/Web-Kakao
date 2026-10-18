// Synthetic async-storage contracts: temporary data, injected security and ephemeral HTTP only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createPreferenceStore} from '../experiments/local-web/preferences.mjs';
import {createReadOnlyReader} from '../experiments/local-web/reader-manager.mjs';
import {createLocalServer} from '../experiments/local-web/server.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const gate=()=>{let release;const promise=new Promise(r=>{release=r;});return {promise,release};};
const output=resolve(process.env.WEB_KAKAO_QA_OUTPUT_ROOT || 'local-only/perf-portability-20261018/qa/contracts/node');mkdirSync(output,{recursive:true});
const room='a'.repeat(64),other='b'.repeat(64),key='r_'+'a'.repeat(24),credential={userId:'999',deviceUUID:'SYNTHETIC_DEVICE',accessToken:'SYNTHETIC_NO_ACCOUNT'};
const folder=()=>mkdtempSync(join(output,'p-'));
const disk=path=>readFileSync(join(path,readdirSync(path).find(n=>n.endsWith('.json'))),'utf8');
function storeOptions(path,verifyFile=async()=>true){return {folder:path,asyncSecurity:true,secureFolder:async p=>p,verifyFile};}

test('slow file verification keeps storage pending while timers advance',async()=>{
  const path=folder(),hold=gate();let block=false,entered=0,settled=false,ticks=0;
  const store=createPreferenceStore(storeOptions(path,async p=>{if(block&&p.endsWith('.json')){entered++;await hold.promise;}return true;}));
  const profile=await store.account('111');assert.equal(await profile.set({persist:true}),true);block=true;
  const timer=setInterval(()=>ticks++,5),write=Promise.resolve(profile.setRoom(room,{muted:true})).then(v=>{settled=true;return v;});
  try{await sleep(35);assert.equal(settled,false,'persistent success must wait for injected file verification');assert.ok(entered>0);assert.ok(ticks>=2,'slow security must yield to timers');hold.release();assert.equal(await write,true);assert.equal(profile.room(room).muted,true);}
  finally{hold.release();await write;clearInterval(timer);profile.close();rmSync(path,{recursive:true,force:true});}
});
test('every persistent write revalidates ACL and explicit refusal leaves disk and memory truthful',async()=>{
  const path=folder();let deny=false,checks=0;
  const profile=await createPreferenceStore(storeOptions(path,async()=>{checks++;if(deny)throw new Error('synthetic_acl_denied');return true;})).account('111');
  try{assert.equal(await profile.set({persist:true}),true);assert.equal(await profile.setRoom(room,{title:'Before'}),true);const before=disk(path),previous=checks;deny=true;
    assert.equal(await profile.setRoom(room,{title:'After'}),false,'a later permission denial must not be bypassed by a cached success');assert.ok(checks>previous);assert.equal(disk(path),before);assert.equal(profile.room(room).title,'Before');assert.equal(profile.snapshot().storageError,true);
  }finally{profile.close();rmSync(path,{recursive:true,force:true});}
});
test('concurrent profiles serialize reload merge and leave no temporary files',async()=>{
  const path=folder(),store=createPreferenceStore(storeOptions(path,async()=>{await sleep(5);return true;}));
  const one=await store.account('111'),two=await store.account('111');
  try{assert.equal(await one.set({persist:true}),true);assert.deepEqual(await Promise.all([one.setRoom(room,{muted:true}),two.setRoom(other,{title:'Other'})]),[true,true]);
    const raw=JSON.parse(disk(path));assert.equal(raw.rooms[room].muted,true);assert.equal(raw.rooms[other].title,'Other');assert.equal(readdirSync(path).some(n=>n.endsWith('.tmp')),false);
  }finally{one.close();two.close();rmSync(path,{recursive:true,force:true});}
});
test('closed profile cannot mutate or recreate persistent state',async()=>{
  const path=folder(),profile=await createPreferenceStore(storeOptions(path)).account('111');
  try{await profile.set({persist:true});const before=disk(path);profile.close();assert.equal(await profile.set({persist:true,notifications:true}),false);assert.equal(disk(path),before);assert.equal(profile.snapshot().notifications,false);}
  finally{profile.close();rmSync(path,{recursive:true,force:true});}
});
test('stale isCurrent guard prevents set setRoom and forget disk mutations',async()=>{
  const path=folder(),profile=await createPreferenceStore(storeOptions(path)).account('111');
  try{await profile.set({persist:true});const before=disk(path);const options={isCurrent:()=>false};
    assert.equal(await profile.set({notifications:true},options),false);assert.equal(await profile.setRoom(room,{muted:true},options),false);assert.equal(await profile.forget(options),false);assert.equal(disk(path),before);assert.equal(profile.snapshot().persist,true);
  }finally{profile.close();rmSync(path,{recursive:true,force:true});}
});
test('close during awaited verification denies late publication',async()=>{
  const path=folder(),hold=gate();let block=false;
  const profile=await createPreferenceStore(storeOptions(path,async p=>{if(block&&p.endsWith('.json'))await hold.promise;return true;})).account('111');
  await profile.set({persist:true});const before=disk(path);block=true;const write=Promise.resolve(profile.setRoom(room,{muted:true}));profile.close();hold.release();
  try{assert.equal(await write,false,'close must invalidate an in-flight durable write');assert.equal(disk(path),before);assert.deepEqual(profile.room(room),{});}
  finally{hold.release();profile.close();rmSync(path,{recursive:true,force:true});}
});

function managerFixture(profile,account=()=>profile){
  const child=Object.assign(new EventEmitter(),{send(_v,cb){cb?.();},kill(){return true;}});let spawned=0;
  const reader=createReadOnlyReader({spawn:()=>{spawned++;return child;},preferenceStore:{account}});
  const ready=()=>child.emit('message',{type:'reader-rooms',source:'loginlist',rooms:[{key,title:'Synthetic',kind:'DirectChat'}],stats:{sourceRoomCount:1}});
  return {reader,ready,spawned:()=>spawned};
}
const profileStub=()=>({key:()=>Buffer.alloc(32),snapshot:()=>({persist:false,notifications:false}),room:()=>null,set:()=>true,setRoom:()=>true,forget:()=>true,close(){}});
test('manager awaits profile preparation and cancellation prevents worker start',async()=>{
  const hold=gate(),profile=profileStub(),abort=new AbortController();
  // A harmless close on the unresolved fixture avoids an unrelated uncaught
  // baseline abort cleanup error; readiness and worker-start assertions remain.
  hold.promise.close=()=>{};
  const f=managerFixture(profile,()=>hold.promise);
  const connecting=Promise.resolve(f.reader.connect(credential,{signal:abort.signal}));
  try{await sleep(15);assert.equal(f.reader.snapshot().phase,'connecting');assert.equal(f.spawned(),0,'credential worker cannot start before profile readiness');abort.abort();hold.release(profile);await connecting;assert.equal(f.spawned(),0);}
  finally{abort.abort();hold.release(profile);await connecting;f.reader.close();}
});
test('manager does not publish a failed asynchronous preference result early',async()=>{
  const hold=gate(),profile=profileStub();profile.set=()=>hold.promise;const f=managerFixture(profile);await f.reader.connect(credential);f.ready();let settled=false;
  const before=f.reader.snapshot().settingsRevision,write=Promise.resolve(f.reader.updateSettings({notifications:true})).then(value=>{settled=true;return value;});
  try{await sleep(15);assert.equal(settled,false,'Promise truthiness must not count as saved settings');assert.equal(f.reader.snapshot().settingsRevision,before);hold.release(false);assert.equal(await write,false);assert.equal(f.reader.snapshot().settingsRevision,before);}
  finally{hold.release(false);await write;f.reader.close();}
});

async function httpFixture(update){
  let revision=0;const app=createLocalServer({mode:'live',encode:()=>[[true]],transport:async op=>op==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:op==='generate'?{httpStatus:200,body:{status:0,url:'OFFLINE-NO-LOGIN',remainingSeconds:30}}:{httpStatus:200,body:{status:0,user:{userId:'999'},accessToken:'SYNTHETIC_NO_ACCOUNT'}},readerFactory:()=>{const instanceId=(++revision).toString(16).padStart(24,'0');return {snapshot:()=>({instanceId,phase:'idle',canConnect:false,revision:1}),settingsSnapshot:()=>({persist:false}),updateSettings:update,close(){}};}});
  const url=await app.listen(0);assert.notEqual(app.server.address().port,8787);const issue=await fetch(url+'/api/local/launch',{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Local-Control':app.controlToken},body:'{}'});const ticket=(await issue.json()).ticket;
  const exchange=await fetch(url+'/api/local/session',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify({ticket})}),session=(await exchange.json()).session;
  const status=()=>fetch(url+'/api/status',{headers:{'X-Local-Session':session}});const initial=await(await status()).json();
  const post=(path,body={})=>fetch(url+path,{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Local-Session':session,'X-CSRF-Token':initial.csrf},body:JSON.stringify(body)});
  await app.lab.start();const end=Date.now()+4000;while(!app.lab.snapshot().credentialInMemory){if(Date.now()>end)throw new Error('synthetic auth fixture deadline');await sleep(20);}
  return {app,status,post,close:async()=>{app.lab.cancel();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));}};
}
test('HTTP preference waits for durable result while independent status and timer remain responsive',async()=>{
  const hold=gate(),entered=gate(),f=await httpFixture(async()=>{entered.release();return hold.promise;});let response=null,ticks=0;const timer=setInterval(()=>ticks++,5);
  const write=f.post('/api/preferences',{notifications:true}).then(r=>{response=r;return r;});
  try{await entered.promise;const state=await f.status();await sleep(20);assert.equal(state.status,200);assert.ok(ticks>1);assert.equal(response,null,'HTTP acceptance must wait for persistent result');hold.release(false);assert.equal((await write).status,409);}
  finally{hold.release(false);await write;clearInterval(timer);await f.close();}
});
test('HTTP old reader settings result is rejected after account replacement',async()=>{
  const hold=gate(),entered=gate(),f=await httpFixture(async()=>{entered.release();return hold.promise;});
  const write=f.post('/api/preferences',{notifications:true});
  try{await entered.promise;assert.equal((await f.post('/api/cancel')).status,200);assert.equal((await f.post('/api/start')).status,202);hold.release(true);assert.equal((await write).status,409,'old reader success cannot authorize the replacement account');}
  finally{hold.release(false);await write;await f.close();}
});
