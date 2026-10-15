import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { createAuthLab, createTransport, checkPinnedSource } from '../experiments/local-web/kakao-auth.mjs';
import { createLocalServer, encodeQr } from '../experiments/local-web/server.mjs';

const ok = body => ({ httpStatus: 200, body });
const qr = () => ok({ status: 0, url: 'kakaotalk://qrlogin?id=synthetic-test-only', remainingSeconds: 180 });
function rawStatus(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end(body);
  });
}
function fixture(responses) {
  const calls = [], timers = [];
  let time = 100000;
  const lab = createAuthLab({
    transport: async (operation, payload) => { calls.push(operation); const reply = responses.shift(); return typeof reply === 'function' ? reply(operation, payload) : reply; },
    encodeQr: () => [[true]], now: () => time,
    later: (fn, ms) => { const timer = { fn, due: time + ms }; timers.push(timer); return timer; },
    clear: timer => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
  });
  return { lab, calls, timers, advance: ms => { time += ms; }, tick: async () => { timers.sort((a,b) => a.due-b.due); const timer = timers.shift(); assert.ok(timer); await timer.fn(); } };
}

test('allowlist rejection, HTTP error and incomplete JSON never generate QR', async () => {
  for (const response of [ok({ allowlisted: false }), ok({}), ok({ allowlisted: 'true' }), ok({ allowlisted: true, status: -997 }), {httpStatus:415,body:null}]) {
    const f = fixture([response]); await f.lab.start();
    assert.equal(f.lab.snapshot().phase, 'blocked'); assert.deepEqual(f.calls, ['allowlist']); assert.equal(f.timers.length, 0);
  }
});
test('server denial with retry interval is terminal and never auto-retried', async () => {
  const f = fixture([ok({allowlisted:true}), qr(), ok({status:-997,nextRequestIntervalInSeconds:1})]);
  await f.lab.start(); await f.tick();
  assert.equal(f.lab.snapshot().phase, 'blocked'); assert.equal(f.timers.length, 0); assert.equal(f.lab.snapshot().grid, undefined);
  assert.equal(await f.lab.start(), false); assert.deepEqual(f.calls, ['allowlist','generate','poll']);
});
test('unclassified QR status -151 stops without asserting an account ban or permitting retries',async()=>{
  const f=fixture([ok({allowlisted:true}),qr(),ok({status:-151,nextRequestIntervalInSeconds:1})]);
  await f.lab.start();await f.tick();
  const state=f.lab.snapshot();assert.equal(state.phase,'blocked');assert.equal(state.apiStatus,-151);
  assert.equal(state.message,'지원하지 않는 인증 응답을 받아 중단했습니다. (상태 -151)');
  assert.equal(state.credentialInMemory,false);assert.equal(state.canStart,false);assert.equal(state.canProbe,false);
  assert.equal(state.grid,undefined);assert.equal(state.passcode,undefined);assert.equal(f.timers.length,0);
  assert.equal(await f.lab.start(),false);assert.deepEqual(f.calls,['allowlist','generate','poll']);
  assert.deepEqual(state.authEvents.map(event=>event.operation),['allowlist','generate','poll']);
  assert.equal(state.authEvents.at(-1).status,-151);assert.equal(state.authEvents.at(-1).qrAgeMs,0);
  assert.equal(JSON.stringify(state.authEvents).includes('synthetic-test-only'),false);
});
test('success keeps credentials private; cancel destroys local auth memory', async () => {
  const f = fixture([ok({allowlisted:true}), qr(), ok({status:0,user:{userId:'246810'},accessToken:'FAKE_PRIVATE_ACCESS',refreshToken:'FAKE_PRIVATE_REFRESH'})]);
  await f.lab.start(); await f.tick();
  const state = f.lab.snapshot(), serialized = JSON.stringify(state);
  assert.equal(state.phase, 'authenticated'); assert.equal(state.credentialInMemory, true);
  for (const secret of ['FAKE_PRIVATE_ACCESS','FAKE_PRIVATE_REFRESH','246810','synthetic-test-only']) assert.equal(serialized.includes(secret), false);
  assert.equal(state.actualChatConnected, false); assert.equal(state.actualMessageSent, false);
  f.lab.cancel(); assert.equal(f.lab.snapshot().credentialInMemory, false); assert.equal(f.timers.length, 0);
});
test('read-only consumer receives credentials only internally and cannot restore cancelled state', async () => {
  const f=fixture([ok({allowlisted:true}),qr(),ok({status:0,user:{userId:'246810'},accessToken:'FAKE_PRIVATE_ACCESS'})]);
  let release;
  assert.equal(await f.lab.connectReadOnly(()=>{throw new Error('not authenticated');}),false);
  await f.lab.start();await f.tick();assert.equal(f.lab.snapshot().canProbe,true);
  const pending=f.lab.connectReadOnly((cred,opts)=>{
    assert.equal(cred.accessToken,'FAKE_PRIVATE_ACCESS');assert.ok(opts.signal);return new Promise(resolve=>{release=resolve;});
  });
  assert.equal(f.lab.snapshot().canProbe,false);assert.equal(await f.lab.connectReadOnly(()=>{}),false);
  f.lab.cancel();release({phase:'completed',connectionVerified:true,roomCount:1});await pending;
  assert.equal(f.lab.snapshot().phase,'cancelled');assert.equal(f.lab.snapshot().roomProbe.stage,'cancelled');
  assert.equal(JSON.stringify(f.lab.snapshot()).includes('FAKE_PRIVATE_ACCESS'),false);
});
test('incomplete success is not authenticated', async () => {
  const f = fixture([ok({allowlisted:true}), qr(), ok({status:0,accessToken:'FAKE_TOKEN'})]);
  await f.lab.start(); await f.tick(); assert.equal(f.lab.snapshot().phase, 'blocked'); assert.equal(f.lab.snapshot().credentialInMemory, false);
});
test('cancel during network wait cannot resurrect QR or authentication', async () => {
  let release;
  const f = fixture([() => new Promise(resolve => { release = resolve; })]);
  const started = f.lab.start(); f.lab.cancel(); release(ok({allowlisted:true})); await started;
  assert.equal(f.lab.snapshot().phase, 'cancelled'); assert.deepEqual(f.calls, ['allowlist']); assert.equal(f.timers.length, 0);
});
test('cancelled or expired QR can be manually renewed, but denial stays locked', async () => {
  const f = fixture([ok({allowlisted:true}),qr(),ok({allowlisted:true}),qr(),ok({allowlisted:true}),qr()]);
  await f.lab.start(); assert.equal(f.lab.snapshot().canStart,false); f.lab.cancel(); assert.equal(f.lab.snapshot().canStart,true);
  await f.lab.start(); f.advance(181000); await f.tick(); assert.equal(f.lab.snapshot().canStart,true);
  await f.lab.start(); f.lab.cancel(); assert.equal(f.lab.snapshot().canStart,false); assert.equal(f.lab.snapshot().attempts,3);
  const denied = fixture([ok({allowlisted:false})]); await denied.lab.start(); denied.lab.cancel(); assert.equal(denied.lab.snapshot().canStart,false); assert.equal(await denied.lab.start(),false);
});
test('expiry stops polling; malformed or oversized QR content never reaches display', async () => {
  const f = fixture([ok({allowlisted:true}), qr()]); await f.lab.start(); f.advance(181000); await f.tick();
  assert.equal(f.lab.snapshot().phase, 'expired'); assert.deepEqual(f.calls, ['allowlist','generate']);
  for (const url of ['', 'invalid\ncontrol', 'x'.repeat(2049)]) {
    const bad = fixture([ok({allowlisted:true}),ok({status:0,url,remainingSeconds:180})]); await bad.lab.start();
    assert.equal(bad.lab.snapshot().phase, 'blocked'); assert.equal(bad.lab.snapshot().grid, undefined);
  }
});
test('opaque QR payload is rendered verbatim, not treated as a navigable URL', async () => {
  const seen = [];
  const f = fixture([ok({allowlisted:true}),ok({status:0,url:'opaque-server-payload-not-a-web-url',remainingSeconds:180})]);
  await f.lab.start(); assert.equal(f.lab.snapshot().phase,'waiting'); assert.equal(f.lab.snapshot().qrIssued,true);
  f.lab.cancel();
  const lab = createAuthLab({transport:async op => op==='allowlist'?ok({allowlisted:true}):ok({status:0,url:'opaque-server-payload-not-a-web-url',remainingSeconds:180}), encodeQr:text=>{seen.push(text); return [[true]];}});
  await lab.start(); assert.deepEqual(seen,['opaque-server-payload-not-a-web-url']); lab.cancel();
});
test('device approval displays only four-digit code, then honors pending interval', async () => {
  const f = fixture([ok({allowlisted:true}),qr(),ok({status:-100,passcode:'1234',nextRequestIntervalInSeconds:3}),ok({status:15,nextRequestIntervalInSeconds:1})]);
  await f.lab.start(); await f.tick(); assert.equal(f.lab.snapshot().phase,'approval'); assert.equal(f.lab.snapshot().passcode,'1234');
  await f.tick(); assert.equal(f.lab.snapshot().phase,'blocked'); assert.equal(f.lab.snapshot().passcode,undefined);
});
test('transport errors are redacted and stop before QR generation', async () => {
  const f = fixture([() => { throw new Error('sensitive error body'); }]); await f.lab.start();
  assert.equal(f.lab.snapshot().phase,'error'); assert.equal(JSON.stringify(f.lab.snapshot()).includes('sensitive error body'),false); assert.deepEqual(f.calls,['allowlist']);
});
test('unverified cross-platform pending codes are never retried', async () => {
  for (const status of [14,1]) {
    const f = fixture([ok({allowlisted:true}),qr(),ok({status,passcode:'1234',nextRequestIntervalInSeconds:1})]);
    await f.lab.start(); await f.tick(); assert.equal(f.lab.snapshot().phase,'blocked'); assert.equal(f.timers.length,0);
  }
});
test('observed unscanned -150 stays waiting only with a valid server interval', async () => {
  const f = fixture([ok({allowlisted:true}),qr(),ok({status:-150,nextRequestIntervalInSeconds:3}),ok({status:-997,nextRequestIntervalInSeconds:3})]);
  await f.lab.start(); await f.tick(); assert.equal(f.lab.snapshot().phase,'waiting'); assert.ok(f.lab.snapshot().grid);
  await f.tick(); assert.equal(f.lab.snapshot().phase,'blocked'); assert.equal(f.timers.length,0);
  const invalid = fixture([ok({allowlisted:true}),qr(),ok({status:-150})]);
  await invalid.lab.start(); await invalid.tick(); assert.equal(invalid.lab.snapshot().phase,'error');
});
test('return to scan waiting clears an old approval code', async () => {
  const f = fixture([ok({allowlisted:true}),qr(),ok({status:-100,passcode:'1234',nextRequestIntervalInSeconds:3}),ok({status:-150,nextRequestIntervalInSeconds:3})]);
  await f.lab.start(); await f.tick(); assert.equal(f.lab.snapshot().passcode,'1234');
  await f.tick(); assert.equal(f.lab.snapshot().phase,'waiting'); assert.equal(f.lab.snapshot().passcode,undefined); f.lab.cancel();
});
test('independent expiry aborts an in-flight poll and cannot be overwritten by a late token', async () => {
  let release;
  const f = fixture([ok({allowlisted:true}),qr(),() => new Promise(resolve => {release=resolve;})]);
  await f.lab.start(); const polling = f.tick();
  f.advance(181000); await f.tick();
  release(ok({status:0,user:{userId:'246810'},accessToken:'FAKE_LATE_TOKEN'})); await polling;
  assert.equal(f.lab.snapshot().phase,'expired'); assert.equal(f.lab.snapshot().credentialInMemory,false); assert.equal(f.lab.snapshot().grid,undefined);
});
test('pinned source and local QR renderer are available', () => {
  checkPinnedSource(); const grid = encodeQr('offline-synthetic-QR-not-a-login');
  assert.ok(grid.length >= 21); assert.ok(grid.every(row => row.length === grid.length && row.every(value => typeof value === 'boolean')));
});
test('HTTPS transport pins origin, path, TLS and bounded parsing; unknown operation has no request', async t => {
  const captured = [];
  t.mock.method(https, 'request', (options, callback) => {
    captured.push(options); const req = new EventEmitter();
    req.end = () => queueMicrotask(() => { const res = new EventEmitter(); res.statusCode = 415; callback(res); res.emit('data',Buffer.from('not json')); res.emit('end'); });
    return req;
  });
  const transport = createTransport();
  const result = await transport('allowlist', undefined, new AbortController().signal);
  assert.deepEqual(result,{httpStatus:415,body:null}); assert.equal(captured[0].hostname,'katalk.kakao.com'); assert.equal(captured[0].rejectUnauthorized,true);
  assert.equal(captured[0].path,'/android/account/allowlist.json?model_name=SM-T733'); assert.equal(captured[0].method,'GET');
  assert.equal(captured[0].headers['Content-Type'],'application/x-www-form-urlencoded');
  await assert.rejects(transport('send',{},new AbortController().signal)); assert.equal(captured.length,1);
});
test('local web enforces cookie, Origin, CSRF, Host and has no chat endpoints', async () => {
  let calls = 0;
  const app = createLocalServer({ transport:async () => { calls++; return ok({allowlisted:false}); }, encode:() => [[true]] });
  const url = await app.listen(0);
  try {
    assert.equal((await fetch(url+'/api/status')).status,403);
    const page = await fetch(url); const cookie = page.headers.get('set-cookie').split(';')[0];
    assert.match(page.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/); assert.equal(page.headers.get('cache-control'),'no-store, max-age=0');
    assert.equal(page.headers.get('access-control-allow-origin'),null);
    const state = await (await fetch(url+'/api/status',{headers:{cookie}})).json();
    const headers = {cookie,origin:url,'content-type':'application/json','x-csrf-token':state.csrf};
    assert.equal((await fetch(url+'/api/start',{method:'POST',headers:{...headers,origin:'https://evil.example'},body:'{}'})).status,403);
    assert.equal((await fetch(url+'/api/start',{method:'POST',headers:{...headers,'x-csrf-token':'wrong'},body:'{}'})).status,403);
    assert.equal(await rawStatus(url+'/api/start',{method:'POST',headers:{...headers,host:'evil.example'},body:'{}'}),403);
    assert.equal(await rawStatus(url+'/api/status',{headers:{cookie,'sec-fetch-site':'cross-site'}}),403);
    assert.equal((await fetch(url+'/api/start',{method:'POST',headers,body:'{"token":"never accepted"}'})).status,400);
    assert.equal(calls,0);
    assert.equal((await fetch(url+'/api/start',{method:'POST',headers,body:'{}'})).status,202);
    assert.equal(calls,1);
    assert.equal((await fetch(url+'/api/start',{method:'POST',headers,body:'{}'})).status,409);
    assert.equal((await fetch(url+'/api/messages',{method:'POST',headers,body:'{}'})).status,404);
    assert.equal((await fetch(url+'/api/room-probe',{method:'POST',headers,body:'{}'})).status,409);
    assert.equal((await fetch(url+'/api/shutdown',{method:'POST',headers,body:'{}'})).status,200);
  } finally { if (app.server.listening) { app.server.close(); app.server.closeAllConnections(); } }
});

test('authenticated web can run one protected read-only probe without exposing account fields', async () => {
  let polled, probeCalls=0;
  const ready=new Promise(resolve=>{polled=resolve;});
  const app=createLocalServer({mode:'live',encode:()=>[[true]],transport:async operation=>{
    if(operation==='allowlist')return ok({allowlisted:true});
    if(operation==='generate')return qr();
    queueMicrotask(polled);return ok({status:0,user:{userId:'246810'},accessToken:'FAKE_PRIVATE_ACCESS'});
  },probe:async credential=>{
    assert.equal(credential.accessToken,'FAKE_PRIVATE_ACCESS');probeCalls++;
    return {phase:'completed',stage:'loginlist',status:0,connectionVerified:true,roomListPresent:true,roomCount:3};
  }});
  const url=await app.listen(0);
  try {
    const page=await fetch(url);const cookie=page.headers.get('set-cookie').split(';')[0];
    const state=await (await fetch(url+'/api/status',{headers:{cookie}})).json();
    const headers={cookie,origin:url,'content-type':'application/json','x-csrf-token':state.csrf};
    const post=(path,extra={})=>fetch(url+path,{method:'POST',headers:{...headers,...extra},body:'{}'});
    assert.equal((await post('/api/room-probe')).status,409);
    await app.lab.start();await ready;await new Promise(setImmediate);
    assert.equal(app.lab.snapshot().canProbe,true);
    assert.equal((await post('/api/room-probe',{origin:'https://evil.example'})).status,403);assert.equal(probeCalls,0);
    assert.equal((await post('/api/room-probe')).status,202);assert.equal(probeCalls,1);
    assert.equal((await post('/api/room-probe')).status,409);
    const output=await (await fetch(url+'/api/status',{headers:{cookie}})).text();
    assert.equal(output.includes('FAKE_PRIVATE_ACCESS'),false);assert.equal(output.includes('246810'),false);
    const completed=JSON.parse(output);assert.equal(completed.actualChatConnected,true);assert.equal(completed.actualMessageSent,false);assert.equal(completed.roomProbe.roomCount,3);
  } finally {app.lab.cancel();app.server.close();app.server.closeAllConnections();}
});
