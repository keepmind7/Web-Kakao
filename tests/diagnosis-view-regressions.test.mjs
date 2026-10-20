// Actual loopback HTTP parsing/order with injected authentication and reader.
// No account, external service, user server or browser is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createLocalServer} from '../experiments/local-web/server.mjs';

const a='r_'+'a'.repeat(24),b='r_'+'b'.repeat(24);
const tabA='11111111-1111-4111-8111-111111111111',tabB='22222222-2222-4222-8222-222222222222';
const ordered=(room,sequence,client=tabA)=>({room,viewClientId:client,viewSequence:sequence});
async function fixture(t){
  const control='f'.repeat(64),views=[],held=new Set();let attempts=1,serial=0;
  const app=createLocalServer({controlToken:control,mode:'live',messaging:true,preferenceStore:{close(){}},encode:()=>[[true]],
    transport:async operation=>({httpStatus:200,body:operation==='allowlist'?{allowlisted:true}:operation==='generate'?{status:0,url:'OFFLINE_NOT_FOR_LOGIN',remainingSeconds:60}:{status:0,user:{userId:'999'},accessToken:'SYNTHETIC_NOT_A_TOKEN'}}),
    readerFactory:()=>{const instanceId=(++serial).toString(16).padStart(24,'0');return {
      snapshot:()=>({instanceId,attempts,phase:'connected',canConnect:false,revision:1,roomCount:2}),close(){},
      view(room){if(![a,b].includes(room))return false;views.push(room);return true;},
    };},
  });
  const url=await app.listen(0);assert.notEqual(app.server.address().port,8787);
  t.after(()=>{for(const request of held)request.destroy();app.close();app.server.closeAllConnections();});
  const post=async(path,body,extra={})=>{const response=await fetch(url+path,{method:'POST',headers:{origin:url,'content-type':'application/json',...extra},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const ticket=await post('/api/local/launch',{}, {'x-local-control':control});
  const session=await post('/api/local/session',{ticket:ticket.body.ticket});assert.equal(session.status,200);
  const authHeaders={'x-local-session':session.body.session};
  await app.lab.start();const authDeadline=Date.now()+3000;
  while(!app.lab.snapshot().credentialInMemory && Date.now()<authDeadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(app.lab.snapshot().credentialInMemory,true);
  const state=await(await fetch(url+'/api/status',{headers:authHeaders})).json();
  const headers={...authHeaders,origin:url,'content-type':'application/json','x-csrf-token':state.csrf,'x-reader-instance':state.reader.instanceId};
  async function hold(body,extra={}){
    const encoded=JSON.stringify(body);let enter;
    const started=new Promise(resolve=>{enter=resolve;});
    const listener=req=>{if(req.url==='/api/reader/view'){app.server.off('request',listener);enter();}};
    app.server.on('request',listener);
    let request;
    const result=new Promise((resolve,reject)=>{
      const requestHeaders=Object.fromEntries(Object.entries({...headers,...extra}).filter(([,value])=>value!==undefined));
      request=http.request(url+'/api/reader/view',{method:'POST',headers:requestHeaders},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});
      held.add(request);request.once('error',reject);request.write(encoded.slice(0,12));
    });
    result.catch(()=>{}); // Cleanup may abort a held body after a preceding assertion fails.
    await started;
    return {finish:async()=>{request.end(encoded.slice(12));return result;}};
  }
  return {app,views,hold,headers,post:(body,extra={})=>post('/api/reader/view',body,{...headers,...extra}),rawPost:post,reconnect:()=>{attempts++;}};
}

for(const legacy of [false,true])test('D2 held A body cannot supersede later accepted B '+(legacy?'legacy':'ordered'),async t=>{
  const f=await fixture(t),first=await f.hold(legacy?{room:a}:ordered(a,1));
  assert.equal((await f.post(legacy?{room:b}:ordered(b,2))).status,202);
  assert.equal(await first.finish(),409);assert.deepEqual(f.views,[b]);
});
test('D2 reversed complete requests respect the per-page selection sequence',async t=>{
  const f=await fixture(t);assert.equal((await f.post(ordered(b,2))).status,202);
  assert.equal((await f.post(ordered(a,1))).status,409);assert.deepEqual(f.views,[b]);
  assert.equal((await f.post(ordered(b,2))).status,409,'an old duplicate cannot reclaim the view');
  assert.equal((await f.post(ordered(a,3))).status,202,'a new explicit selection can reclaim it');
});
test('D2 sequence spaces are separate for two pages sharing local authorization',async t=>{
  const f=await fixture(t);assert.equal((await f.post(ordered(a,100,tabA))).status,202);
  assert.equal((await f.post(ordered(b,1,tabB))).status,202);assert.deepEqual(f.views,[a,b]);
});
test('D2 reconnect during body receipt rejects the old intent even with the same instance',async t=>{
  const f=await fixture(t),first=await f.hold(ordered(a,1));f.reconnect();
  assert.equal(await first.finish(),409);assert.deepEqual(f.views,[]);
  assert.equal((await f.post(ordered(b,1))).status,202,'new connection gets a fresh ordering scope');
});
test('D2 reader replacement rejects a held legacy body with an omitted instance header',async t=>{
  const f=await fixture(t),first=await f.hold({room:a},{'x-reader-instance':undefined});
  f.app.lab.cancel();assert.equal((await f.rawPost('/api/start',{},f.headers)).status,202);
  const deadline=Date.now()+3000;while(!f.app.lab.snapshot().credentialInMemory && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(f.app.lab.snapshot().credentialInMemory,true,'replacement is authenticated before the old body completes');
  assert.equal(await first.finish(),409);assert.deepEqual(f.views,[]);
});
for(const body of [
  {room:a,viewSequence:1},{room:a,viewClientId:tabA},ordered(a,0),ordered(a,1.5),ordered(a,1,'invalid'),
  {...ordered(a,1),unexpected:true},
])test('D2 malformed or partial ordering fields fail closed '+JSON.stringify(body),async t=>{
  const f=await fixture(t);assert.equal((await f.post(body)).status,400);assert.deepEqual(f.views,[]);
});
test('D2 denied and unknown-room intents do not override an accepted view',async t=>{
  const f=await fixture(t);assert.equal((await f.post(ordered(a,1))).status,202);
  assert.equal((await f.post(ordered(b,2),{'x-reader-instance':'0'.repeat(24)})).status,409);
  assert.equal((await f.post(ordered('r_'+'c'.repeat(24),3))).status,409);
  assert.deepEqual(f.views,[a]);assert.equal((await f.post(ordered(b,2))).status,202);
});
test('D2 page watermarks are bounded without dropping old sequence protection and reset on reconnect',async t=>{
  const f=await fixture(t),client=n=>n.toString(16).padStart(8,'0')+'-1111-4111-8111-111111111111';
  for(let n=1;n<=128;n++)assert.equal((await f.post(ordered(a,1,client(n)))).status,202);
  assert.equal((await f.post(ordered(b,1,client(129)))).status,409);
  assert.equal((await f.post(ordered(b,1,client(1)))).status,409,'old pages cannot replay their accepted sequence');
  assert.equal((await f.post(ordered(b,2,client(1)))).status,202,'existing page can still select');
  f.reconnect();assert.equal((await f.post(ordered(a,1,client(129)))).status,202);
});
