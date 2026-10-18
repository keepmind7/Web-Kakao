// Account-free policy contracts: injected auth/readers/preferences and owned loopback only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createAuthLab} from '../experiments/local-web/kakao-auth.mjs';
import {createLocalServer} from '../experiments/local-web/server.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),ok=body=>({httpStatus:200,body});
const transport=op=>op==='allowlist'?ok({allowlisted:true}):op==='generate'?ok({status:0,url:'SYNTHETIC_NO_LOGIN',remainingSeconds:180}):ok({status:0,user:{userId:'999'},accessToken:'SYNTHETIC_NO_ACCOUNT'});
async function until(fn){const end=Date.now()+4500;while(!fn()){if(Date.now()>end)assert.fail('synthetic state deadline');await sleep(10);}}
function clock(){let time=1000,id=0;const tasks=new Map(),all=[];return {now:()=>time,jump(ms){time+=ms;},later(fn,ms){const timer={id:++id,fn,due:time+ms};tasks.set(timer.id,timer);all.push(timer);return timer;},clear(timer){tasks.delete(timer?.id);},get all(){return all;},get pending(){return tasks.size;},async advance(ms){time+=ms;for(let rounds=0;rounds<100;rounds++){const ready=[...tasks.values()].filter(t=>t.due<=time);if(!ready.length)return;for(const task of ready){tasks.delete(task.id);await task.fn();}}assert.fail('unbounded fake timers');}};}
function auth(options={}){const time=clock(),calls=[];const lab=createAuthLab({encodeQr:()=>[[true]],transport:async op=>{calls.push(op);return transport(op);},now:time.now,later:time.later,clear:time.clear,...options});return {lab,time,calls};}
async function fixture(t,{deny=false,...presenceOptions}={}){
 const time=clock(),controllers=[],calls=[],readers=[];
 const app=createLocalServer({mode:'live',encode:()=>[[true]],transport:async op=>{calls.push(op);return deny?ok({allowlisted:false}):transport(op);},preferenceStore:{account(){assert.fail('no account preferences');},close(){}},readerFactory:()=>{const row={closed:0};readers.push(row);return {snapshot:()=>({instanceId:'a'.repeat(24),phase:'idle',canConnect:false,roomCount:0,revision:0}),rooms:()=>({rooms:[]}),close(){row.closed++;}};},presenceOptions:{now:time.now,later:time.later,clear:time.clear,...presenceOptions}});
 const url=await app.listen(0);assert.notEqual(app.server.address().port,8787);
 const issue=await fetch(url+'/api/local/launch',{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Local-Control':app.controlToken},body:'{}'});assert.equal(issue.status,200);
 const session=await fetch(url+'/api/local/session',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify({ticket:(await issue.json()).ticket})});assert.equal(session.status,200);const token=(await session.json()).session;
 const get=async()=>{const response=await fetch(url+'/api/status',{headers:{'X-Local-Session':token}});assert.equal(response.status,200);return response.json();};
 const csrf=(await get()).csrf,headers={'X-Local-Session':token,'X-CSRF-Token':csrf,Origin:url,'Content-Type':'application/json'};
 const post=(path,body={},extra={})=>fetch(url+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
 async function presence(extra={},body={}){const controller=new AbortController();controllers.push(controller);const response=await fetch(url+'/api/presence',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});return {response,close(){controller.abort();}};}
 let closed=false;async function close(){if(closed)return;closed=true;for(const c of controllers)c.abort();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));assert.equal(app.server.listening,false);}
 t.after(close);return {app,url,token,csrf,get,post,presence,time,calls,readers,close};
}

test('manual QR starts exceed three without automatic generation or cancellation retries',async()=>{
 const f=auth();try{for(let n=1;n<=6;n++){assert.equal(await f.lab.start(),true,'manual start '+n);assert.equal(f.lab.snapshot().phase,'waiting');f.lab.cancel();assert.equal(f.lab.snapshot().canStart,true);assert.equal(f.lab.snapshot().attempts,n);assert.equal(f.lab.snapshot().startBlockedReason,null);}assert.deepEqual(f.calls,Array.from({length:6},()=>['allowlist','generate']).flat());assert.equal(f.time.pending,0);}finally{f.lab.cancel();}
});
test('transient auth failure permits six manual attempts but never schedules an automatic retry',async()=>{
 const f=auth({transport:async()=>{throw new Error('synthetic network');}});try{for(let n=1;n<=6;n++){assert.equal(await f.lab.start(),true);assert.equal(f.lab.snapshot().phase,'error');assert.equal(f.lab.snapshot().canStart,true);assert.equal(f.time.pending,0);}assert.equal(f.lab.snapshot().attempts,6);}finally{f.lab.cancel();}
});
test('externally managed null retention survives two hours without credential expiry and cancel aborts',async()=>{
 let f;assert.doesNotThrow(()=>{f=auth({credentialRetentionMs:null});},'null retention is the explicit external-lifetime contract');
 try{await f.lab.start();await f.time.advance(2000);assert.equal(f.lab.snapshot().credentialInMemory,true);let signal;f.lab.withCredential((_c,options)=>{signal=options.signal;});await f.time.advance(2*60*60*1000);assert.equal(f.lab.snapshot().credentialInMemory,true);assert.equal(f.lab.snapshot().credentialDeadline,null);assert.equal(f.time.pending,0);f.lab.cancel();assert.equal(signal.aborted,true);assert.equal(f.lab.withCredential(()=>true),false);}finally{f.lab.cancel();}
});
test('finite standalone auth retention remains bounded and explicit denial remains locked',async()=>{
 const f=auth({credentialRetentionMs:1000});try{await f.lab.start();await f.time.advance(2000);assert.equal(f.lab.snapshot().credentialInMemory,true);await f.time.advance(1000);assert.equal(f.lab.snapshot().credentialInMemory,false);}finally{f.lab.cancel();}
 const d=auth({transport:async()=>ok({allowlisted:false})});await d.lab.start();d.lab.cancel();assert.equal(d.lab.snapshot().sessionBlocked,true);assert.equal(await d.lab.start(),false);
});
test('authorized presence is a stream before account or QR exists and exposes only aggregate policy',async t=>{
 const f=await fixture(t),lease=await f.presence();assert.equal(lease.response.status,200,'authorized POST /api/presence opens a stream');assert.match(lease.response.headers.get('content-type'),/^text\/event-stream/);const state=await f.get();assert.equal(state.sessionPolicy,'tab-open');assert.deepEqual(Object.keys(state.tabPresence).sort(),['activeTabs','graceMs','graceRemainingMs']);assert.equal(state.tabPresence.activeTabs,1);assert.equal(state.tabPresence.graceMs,120000);assert.equal(state.tabPresence.graceRemainingMs,null);assert.equal(state.attempts,0);assert.deepEqual(f.calls,[]);assert.equal(JSON.stringify(state.tabPresence).includes(f.token),false);lease.close();await sleep(25);
});
test('presence rejects control-only origin csrf type and nonempty bodies without acquiring leases',async t=>{
 const f=await fixture(t),valid=await f.presence();assert.equal(valid.response.status,200);valid.close();await sleep(25);
 for(const [headers,body,status] of [[{'X-Local-Session':'','X-Local-Control':f.app.controlToken},{},403],[{Origin:'http://invalid.example'},{},403],[{'X-CSRF-Token':'0'.repeat(64)},{},403],[{'Content-Type':'text/plain'},{},415],[{},{extra:true},400],[{},[],400]]){const lease=await f.presence(headers,body);assert.equal(lease.response.status,status);lease.close();}
 assert.equal((await f.get()).tabPresence.activeTabs,0);assert.equal((await fetch(f.url+'/api/presence',{headers:{'X-Local-Session':f.token}})).status,404);assert.deepEqual(f.calls,[]);
});
test('default four-stream cap rejects fifth and releasing one permits exactly one replacement',async t=>{
 const f=await fixture(t),leases=[];for(let n=0;n<4;n++){const lease=await f.presence();assert.equal(lease.response.status,200);leases.push(lease);}const fifth=await f.presence();assert.equal(fifth.response.status,429);assert.equal((await f.get()).tabPresence.activeTabs,4);leases[0].close();await sleep(30);assert.equal((await f.get()).tabPresence.activeTabs,3);leases[0].close();const replacement=await f.presence();assert.equal(replacement.response.status,200);assert.equal((await f.get()).tabPresence.activeTabs,4);assert.equal((await f.presence()).response.status,429);
});
test('one remaining stream holds account policy and only last release starts a fixed grace',async t=>{
 const f=await fixture(t),a=await f.presence(),b=await f.presence();assert.equal(a.response.status,200);assert.equal(b.response.status,200);assert.equal((await f.post('/api/start')).status,202);await until(()=>f.app.lab.snapshot().phase==='waiting');a.close();await sleep(25);await f.time.advance(2*60*60*1000);assert.equal((await f.get()).tabPresence.activeTabs,1);assert.equal(f.app.lab.snapshot().phase,'waiting');b.close();await sleep(25);assert.equal((await f.get()).tabPresence.graceRemainingMs,120000);await f.time.advance(119999);for(let n=0;n<3;n++)await f.get();assert.equal((await f.get()).tabPresence.graceRemainingMs,1);await f.time.advance(1);assert.equal(f.app.lab.snapshot().phase,'cancelled');assert.equal(f.app.server.listening,true);assert.ok(f.readers.at(-1).closed>0);
});
test('reopen cancels stale expiry and early callbacks never shorten or extend the new deadline',async t=>{
 const f=await fixture(t),a=await f.presence();assert.equal(a.response.status,200);await f.post('/api/start');await until(()=>f.app.lab.snapshot().phase==='waiting');a.close();await sleep(25);const old=f.time.all.at(-1);await f.time.advance(119999);const b=await f.presence();assert.equal(b.response.status,200);await old.fn();assert.equal(f.app.lab.snapshot().phase,'waiting');assert.equal((await f.get()).tabPresence.graceRemainingMs,null);b.close();await sleep(25);const current=f.time.all.at(-1);await current.fn();assert.equal(f.app.lab.snapshot().phase,'waiting');assert.equal((await f.get()).tabPresence.graceRemainingMs,120000);await f.time.advance(119999);assert.equal(f.app.lab.snapshot().phase,'waiting');await f.time.advance(1);assert.equal(f.app.lab.snapshot().credentialInMemory,false);assert.equal(f.app.lab.snapshot().phase,'cancelled');
});
test('accepted start without a stream arms grace; later tab sees logged-out state with no implicit auth',async t=>{
 const f=await fixture(t,{onEmpty(){assert.fail('caller cannot override security cleanup');}});assert.equal((await f.post('/api/start')).status,202);await until(()=>f.app.lab.snapshot().phase==='waiting');assert.equal((await f.get()).tabPresence.graceRemainingMs,120000);await f.time.advance(119999);assert.equal((await f.post('/api/start')).status,409);assert.equal((await f.get()).tabPresence.graceRemainingMs,1);await f.time.advance(1);assert.equal(f.app.lab.snapshot().phase,'cancelled');const calls=f.calls.length,lease=await f.presence();assert.equal(lease.response.status,200);assert.equal((await f.get()).credentialInMemory,false);assert.equal((await f.get()).attempts,1);assert.equal(f.calls.length,calls);
});
test('grace cleanup of a denied attempt preserves the server refusal lock',async t=>{
 const f=await fixture(t,{deny:true}),lease=await f.presence();assert.equal(lease.response.status,200);await f.post('/api/start');await until(()=>f.app.lab.snapshot().phase==='blocked');lease.close();await sleep(25);await f.time.advance(120000);assert.equal(f.app.lab.snapshot().sessionBlocked,true);assert.equal(f.app.lab.snapshot().credentialInMemory,false);assert.equal((await f.post('/api/start')).status,409);assert.deepEqual(f.calls,['allowlist']);
});
test('production authentication uses null retention and closing the server forgets memory',async t=>{
 const f=await fixture(t),lease=await f.presence();assert.equal(lease.response.status,200);await f.post('/api/start');await until(()=>f.app.lab.snapshot().credentialInMemory);assert.equal(f.app.lab.snapshot().credentialDeadline,null,'production session is governed by live tabs');let timer;const ended=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('server.close must dispose active SSE without hanging')),600);const returned=f.app.server.close(resolve);assert.equal(returned,f.app.server);});try{await ended;}finally{clearTimeout(timer);}await f.time.advance(120000);assert.equal(f.app.lab.snapshot().credentialInMemory,false);assert.equal(f.app.server.listening,false);assert.equal(f.time.pending,0);
});
test('overdue grace is swept before reacquire status or account access despite a delayed timer',async t=>{
 for(const trigger of ['acquire','status','account']){const f=await fixture(t),a=await f.presence();assert.equal(a.response.status,200);await f.post('/api/start');await until(()=>f.app.lab.snapshot().credentialInMemory);a.close();await sleep(25);f.time.jump(120001);
  if(trigger==='acquire')assert.equal((await f.presence()).response.status,200);
  else if(trigger==='status')assert.equal((await f.get()).credentialInMemory,false);
  else assert.equal((await fetch(f.url+'/api/reader/rooms',{headers:{'X-Local-Session':f.token}})).status,409);
  assert.equal(f.app.lab.snapshot().credentialInMemory,false,'expired memory is cleared before '+trigger);assert.equal(f.app.lab.withCredential(()=>true),false);await f.close();
 }
});
test('reader worker has no independent hour expiry and still exits on parent IPC disconnect without SDK start',async t=>{
 const folder=mkdtempSync(join(tmpdir(),'tab-worker-')),preload=join(folder,'clock.mjs');writeFileSync(preload,"const callbacks=[];const real=setTimeout;globalThis.setTimeout=(fn,ms,...rest)=>{if(ms===3600000){callbacks.push(fn);return {unref(){}};}return real(fn,ms,...rest);};process.on('message',m=>{if(m?.type==='qa-hour'){for(const fn of callbacks)fn();process.send?.({type:'qa-hour-complete',hourTimers:callbacks.length});}});");
 const child=fork(fileURLToPath(new URL('../experiments/local-web/reader-worker.mjs',import.meta.url)),[],{execArgv:['--import',pathToFileURL(preload).href],stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});let exit,ready=false,stderr='';child.stderr.on('data',data=>{stderr+=data;});
 try{const result=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('owned worker deadline')),5000);child.on('error',reject);child.on('exit',code=>{exit=code;clearTimeout(timeout);resolve({earlyExit:code});});child.on('message',m=>{if(m.type==='reader-ready'){ready=true;child.send({type:'qa-hour'});}if(m.type==='qa-hour-complete'){clearTimeout(timeout);resolve({hourTimers:m.hourTimers});}});});if(exit===undefined){const ended=new Promise(r=>child.once('exit',r));child.disconnect();exit=await ended;}assert.equal(ready,true,'owned worker fixture must reach readiness: '+stderr.slice(0,400));assert.equal(result.earlyExit,undefined,'one fake hour cannot end a connected parent worker');assert.equal(result.hourTimers,0);assert.equal(exit,0);t.diagnostic('no reader-start credentials or SDK import; parent IPC disconnect observed');}finally{if(child.exitCode===null)child.kill();unlinkSync(preload);rmdirSync(folder);}
});

test('auth action responses preserve tab policy and the live lease across start cancel and refusal',async t=>{
 const f=await fixture(t),lease=await f.presence();assert.equal(lease.response.status,200);
 for(const [path,status] of [['/api/start',202],['/api/start',409],['/api/cancel',200],['/api/room-probe',409]]){const response=await f.post(path);assert.equal(response.status,status);const body=await response.json();assert.equal(body.sessionPolicy,'tab-open','auth action response retains policy: '+path);assert.equal(body.tabPresence?.activeTabs,1);assert.equal((await f.get()).tabPresence.activeTabs,1,'action response cannot implicitly release the current browser lease');}
});
