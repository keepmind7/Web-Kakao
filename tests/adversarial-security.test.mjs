import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthLab } from '../experiments/local-web/kakao-auth.mjs';
import { createLocalServer } from '../experiments/local-web/server.mjs';

// Only injected authentication/reader functions and fresh loopback servers.
// No user's server, browser, account, original files or external transport.
const ok=body=>({httpStatus:200,body});
const qr=()=>ok({status:0,url:'SYNTHETIC-NOT-FOR-LOGIN',remainingSeconds:180});
const auth=()=>ok({status:0,user:{userId:'246810'},accessToken:'SYNTHETIC_PRIVATE_ONLY'});
const control='7'.repeat(64),room='r_'+'a'.repeat(24),clientId='12345678-1234-4123-8123-123456789abc';
function authFixture(responses){
  const timers=[],calls=[];let time=100000;
  const lab=createAuthLab({transport:async(operation,payload)=>{calls.push(operation);const value=responses.shift();return typeof value==='function'?value(operation,payload):value;},encodeQr:()=>[[true]],now:()=>time,later(fn,ms){const timer={fn,due:time+ms};timers.push(timer);return timer;},clear(timer){const index=timers.indexOf(timer);if(index>=0)timers.splice(index,1);}});
  return {lab,calls,timers,advance(ms){time+=ms;},async tick(){timers.sort((a,b)=>a.due-b.due);const timer=timers.shift();assert.ok(timer,'synthetic timer should exist');return timer.fn();}};
}
async function serverFixture(t){
  const actions=[];
  const app=createLocalServer({controlToken:control,mode:'live',messaging:true,encode:()=>[[true]],transport:async operation=>operation==='allowlist'?ok({allowlisted:true}):operation==='generate'?qr():auth(),readerFactory:()=>({snapshot:()=>({phase:'idle',canConnect:true,revision:0,sendAccepted:0}),rooms(){actions.push('rooms');return {rooms:[]};},sendText(){actions.push('send');return true;},close(){},disconnect(){},history(){actions.push('history');return true;},openRoom(){actions.push('context');return true;}})});
  const url=await app.listen(0);
  t.after(async()=>{app.lab.cancel();app.server.closeAllConnections();if(app.server.listening)await new Promise(resolve=>app.server.close(resolve));t.diagnostic(JSON.stringify({syntheticSecurityServerCleanup:{serverListening:app.server.listening,actualAccountUsed:false}}));});
  return {app,url,actions};
}
async function authenticate(app,t){
  // createAuthLab captures its timer at construction. This one synthetic
  // server-login fixture waits for that existing 2s timer rather than mocking
  // the global after construction (which cannot affect the captured timer).
  await app.lab.start();const deadline=Date.now()+4000;
  while(app.lab.snapshot().phase!=='authenticated' && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(app.lab.snapshot().phase,'authenticated');
}
function post(url,path,body={},headers={}){return fetch(url+path,{method:'POST',headers:{Origin:url,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});}
async function issue(url){
  const response=await post(url,'/api/local/launch',{}, {'X-Local-Control':control});
  assert.equal(response.status,200,'the injected control capability should issue a one-use launcher ticket');
  const value=await response.json();assert.equal(typeof value.ticket,'string');assert.ok(value.ticket.length>=32);assert.equal(response.headers.get('set-cookie'),null);return value.ticket;
}
test('ordinary GET never grants the local authentication cookie',async t=>{
  const f=await serverFixture(t),page=await fetch(f.url+'/');assert.equal(page.status,200);assert.equal(page.headers.has('set-cookie'),false,'a public local page must not bootstrap authenticated browser control');assert.equal(f.actions.length,0);
});
test('secret-free local attacker cannot acquire CSRF or send as the authenticated fake user',async t=>{
  const f=await serverFixture(t);await authenticate(f.app,t);
  const page=await fetch(f.url+'/'),cookie=page.headers.get('set-cookie')?.split(';')[0]??'local_auth=invalid';
  const status=await fetch(f.url+'/api/status',{headers:{cookie}});const state=await status.json();
  const send=await post(f.url,'/api/reader/send',{room,text:'SYNTHETIC ATTACK ATTEMPT',clientId},{cookie,'X-CSRF-Token':state.csrf??'0'.repeat(64)});
  t.diagnostic(JSON.stringify({syntheticAttackResult:{status:status.status,csrfDisclosed:typeof state.csrf==='string',send:send.status,fakeActionCalls:f.actions.length}}));
  assert.equal(send.status,403,'public GET plus ordinary HTTP must never authorize a send');assert.equal(status.status,403);assert.equal(Object.hasOwn(state,'csrf'),false);assert.deepEqual(f.actions,[]);
});
test('missing or forged control capability exposes neither status nor account actions',async t=>{
  const f=await serverFixture(t);
  for(const value of [undefined,'8'.repeat(64)]){
    const headers=value?{'X-Local-Control':value}:{};
    assert.equal((await fetch(f.url+'/api/local/status',{headers})).status,403);
    assert.equal((await post(f.url,'/api/local/launch',{},headers)).status,403);
  }
  for(const path of ['/api/status','/api/reader/rooms'])assert.equal((await fetch(f.url+path,{headers:{'X-Local-Control':control}})).status,403);
  assert.equal((await post(f.url,'/api/reader/send',{room,text:'SYNTHETIC',clientId},{'X-Local-Control':control})).status,403);assert.deepEqual(f.actions,[]);
});
test('valid control status is allowlisted and never grants a cookie or browser CSRF',async t=>{
  const f=await serverFixture(t),response=await fetch(f.url+'/api/local/status',{headers:{'X-Local-Control':control}});
  assert.equal(response.status,200);assert.equal(response.headers.get('set-cookie'),null);const body=await response.json();assert.equal(body.app,'web-kakao-auth-lab-v1');
  for(const name of ['csrf','cookie','controlToken','grid','passcode','accessToken','refreshToken','userId','rooms','messages'])assert.equal(Object.hasOwn(body,name),false,name+' must not be disclosed to launcher status');assert.equal(f.actions.length,0);
});
test('a ticket exchanges exactly once and preserves previously authorized browser cookies',async t=>{
  const f=await serverFixture(t),first=await issue(f.url);
  const response=await post(f.url,'/api/local/session',{ticket:first});assert.equal(response.status,200);const header=response.headers.get('set-cookie');assert.match(header,/HttpOnly/);assert.match(header,/SameSite=Strict/);const cookie=header.split(';')[0];
  assert.equal((await fetch(f.url+'/api/status',{headers:{cookie}})).status,200);
  assert.equal((await post(f.url,'/api/local/session',{ticket:first})).status,403);
  const second=await issue(f.url);assert.equal((await post(f.url,'/api/local/session',{ticket:second})).status,200);
  assert.equal((await fetch(f.url+'/api/status',{headers:{cookie}})).status,200,'opening another authorized tab must not revoke the first cookie');assert.equal(f.actions.length,0);
});
test('missing forged and expired tickets never grant cookies',async t=>{
  // Install the clock before server construction, including implementations
  // that capture Date.now when constructing their one-use ticket store.
  let time=Date.now();t.mock.method(Date,'now',()=>time);const f=await serverFixture(t);
  for(const body of [{},{ticket:'forged-synthetic-ticket'}]){const r=await post(f.url,'/api/local/session',body);assert.equal(r.status,403);assert.equal(r.headers.get('set-cookie'),null);}
  const ticket=await issue(f.url);time+=61000;
  const expired=await post(f.url,'/api/local/session',{ticket});assert.equal(expired.status,403);assert.equal(expired.headers.get('set-cookie'),null);
});
test('simultaneous ticket reuse grants one cookie and only one success',async t=>{
  const f=await serverFixture(t),ticket=await issue(f.url);
  const responses=await Promise.all([post(f.url,'/api/local/session',{ticket}),post(f.url,'/api/local/session',{ticket})]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,403]);assert.equal(responses.filter(r=>r.headers.has('set-cookie')).length,1);
});
test('outstanding launch tickets stay bounded to at most eight usable capabilities',async t=>{
  const f=await serverFixture(t),tickets=[];
  for(let n=0;n<9;n++){const response=await post(f.url,'/api/local/launch',{}, {'X-Local-Control':control});if(response.status===200)tickets.push((await response.json()).ticket);else assert.ok([409,429].includes(response.status),'ticket cap must reject safely');}
  assert.ok(tickets.length>=8,'eight fresh launcher tickets should be available');let successes=0;for(const ticket of tickets){if((await post(f.url,'/api/local/session',{ticket})).status===200)successes++;}assert.ok(successes<=8);
});
test('ticket exchange retains Origin and JSON restrictions without consuming a rejected ticket',async t=>{
  const f=await serverFixture(t),ticket=await issue(f.url);
  const wrongOrigin=await post(f.url,'/api/local/session',{ticket},{Origin:'http://invalid.example'});assert.equal(wrongOrigin.status,403);
  const wrongType=await post(f.url,'/api/local/session',{ticket},{'Content-Type':'text/plain'});assert.equal(wrongType.status,415);
  assert.equal((await post(f.url,'/api/local/session',{ticket})).status,200);
});
test('control start is bounded and control shutdown refuses an active authentication session',async t=>{
  const f=await serverFixture(t),headers={'X-Local-Control':control};
  assert.equal((await post(f.url,'/api/local/control/start',{},headers)).status,202);
  assert.equal((await post(f.url,'/api/local/control/shutdown',{},headers)).status,409);
  assert.equal(f.app.server.listening,true);assert.ok([403,404].includes((await post(f.url,'/api/local/control/cancel',{},headers)).status));
});
test('public launcher document and script grant no cookie and use fragment-only handoff',async t=>{
  const f=await serverFixture(t),page=await fetch(f.url+'/launch'),script=await fetch(f.url+'/local-launch.js');
  assert.equal(page.status,200);assert.equal(script.status,200);assert.equal(page.headers.get('set-cookie'),null);assert.equal(script.headers.get('set-cookie'),null);
  const text=await script.text();assert.ok(text.includes('location.hash'));assert.ok(text.includes('history.replaceState'));assert.ok(text.includes('/api/local/session'));assert.ok(text.includes('location.replace'));assert.equal(text.includes('location.search'),false);assert.ok(text.indexOf('history.replaceState')<text.indexOf('fetch('),'fragment must be removed before exchange');
});

const transientCases=[['network',()=>{throw new Error('SYNTHETIC TRANSPORT');}],['HTTP5xx',{httpStatus:503,body:{status:0}}],['malformed JSON',ok(null)],['invalid status type',ok({status:'0'})],['incomplete success',ok({status:0,accessToken:'SYNTHETIC'})]];
for(const [name,failure] of transientCases)test('QR poll '+name+' permits only manual retries up to the total three-attempt limit',async()=>{
  const replies=Array.from({length:3},()=>[ok({allowlisted:true}),qr(),failure]).flat(),f=authFixture(replies);
  try{for(let n=0;n<3;n++){
    assert.equal(await f.lab.start(),true);await f.tick();const state=f.lab.snapshot();assert.equal(state.phase,'error');assert.equal(state.sessionBlocked,false,'transient failure is not an explicit server denial');assert.equal(state.canStart,n<2);assert.equal(state.credentialInMemory,false);assert.equal(f.timers.length,0);assert.equal(f.calls.filter(op=>op==='poll').length,n+1);
  }assert.equal(await f.lab.start(),false);assert.equal(f.lab.snapshot().attempts,3);}finally{f.lab.cancel();}
});
for(const failure of [ok({allowlisted:false}),{httpStatus:403,body:{}},ok({allowlisted:true,status:-997})])test('explicit authentication refusal remains locked even after local cancel',async()=>{
  const f=authFixture([failure]);try{await f.lab.start();assert.equal(f.lab.snapshot().phase,'blocked');f.lab.cancel();assert.equal(await f.lab.start(),false);assert.equal(f.lab.snapshot().sessionBlocked,true);assert.deepEqual(f.calls,['allowlist']);}finally{f.lab.cancel();}
});
for(const failure of [undefined,{phase:'failed',stage:'timeout',status:null,connectionVerified:false},{phase:'failed',stage:'worker',status:null,connectionVerified:false}])test('probe timeout worker or exception preserves valid credentials for a reader connection',async()=>{
  const f=authFixture([ok({allowlisted:true}),qr(),auth()]);
  try{await f.lab.start();await f.tick();assert.equal(await f.lab.connectReadOnly(async()=>{if(!failure)throw new Error('SYNTHETIC PROBE');return failure;}),true);const state=f.lab.snapshot();assert.equal(state.roomProbe.phase,'failed');assert.equal(state.credentialInMemory,true,'non-denial probe failure must not discard valid authentication');assert.equal(state.sessionBlocked,false);assert.equal(state.phase,'authenticated');assert.equal(f.lab.withCredential(()=>true),true);assert.equal(await f.lab.connectReadOnly(()=>{throw new Error('no automatic second probe');}),false);}finally{f.lab.cancel();}
});
test('explicit loginlist probe denial still revokes local credentials and blocks reconnect',async()=>{
  const f=authFixture([ok({allowlisted:true}),qr(),auth()]);try{await f.lab.start();await f.tick();await f.lab.connectReadOnly(async()=>({phase:'failed',stage:'loginlist',status:-203,connectionVerified:false}));assert.equal(f.lab.snapshot().sessionBlocked,true);assert.equal(f.lab.snapshot().credentialInMemory,false);assert.equal(f.lab.withCredential(()=>true),false);}finally{f.lab.cancel();}
});
test('late canceled QR completion cannot replace a newer authenticated epoch',async()=>{
  let release;const f=authFixture([ok({allowlisted:true}),qr(),()=>new Promise(resolve=>{release=resolve;}),ok({allowlisted:true}),qr(),auth()]);
  try{await f.lab.start();const oldPoll=f.tick();f.lab.cancel();await f.lab.start();await f.tick();release(ok({status:0,user:{userId:'13579'},accessToken:'SYNTHETIC_LATE'}));await oldPoll;let expected=false;f.lab.withCredential(value=>{expected=value.userId==='246810';});assert.equal(expected,true);assert.equal(f.lab.snapshot().phase,'authenticated');assert.equal(f.calls.filter(op=>op==='poll').length,2);}finally{f.lab.cancel();}
});
