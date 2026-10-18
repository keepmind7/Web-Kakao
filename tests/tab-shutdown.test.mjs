// Real loopback delayed-body/await boundaries; providers are entirely synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createLocalServer} from '../experiments/local-web/server.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t){
 const calls=[],readers=[],requests=[];let activeSse=0,gatePath=null,gateResolve,settingsEntered,settingsRelease,settingsCalls=0;
 const settingsGate=new Promise(r=>{settingsEntered=r;}),settingsResult=new Promise(r=>{settingsRelease=r;});
 const app=createLocalServer({mode:'live',encode:()=>[[true]],transport:async op=>{calls.push(op);return op==='allowlist'?{httpStatus:200,body:{allowlisted:true}}:op==='generate'?{httpStatus:200,body:{status:0,url:'SYNTHETIC_NO_LOGIN',remainingSeconds:180}}:{httpStatus:200,body:{status:0,user:{userId:'999'},accessToken:'SYNTHETIC_NO_ACCOUNT'}};},preferenceStore:{account(){assert.fail('no real preferences');},close(){}},readerFactory:()=>{const row={closed:0};readers.push(row);return {snapshot:()=>({instanceId:'a'.repeat(24),phase:'idle',canConnect:false,roomCount:0,revision:0}),rooms:()=>({rooms:[]}),settingsSnapshot:()=>({persist:false}),async updateSettings(){settingsCalls++;settingsEntered();return settingsResult;},close(){row.closed++;}};}});
 // Signal only after product header gates entered the body iterator and read a
 // partial chunk: its second next() is waiting for the still-unsent tail.
 app.server.prependListener('request',(req,res)=>{
  if(req.url!==gatePath)return;
  const original=req[Symbol.asyncIterator].bind(req);req[Symbol.asyncIterator]=()=>{const iterator=original(),next=iterator.next.bind(iterator);let reads=0;iterator.next=(...args)=>{if(++reads===2)gateResolve?.();return next(...args);};return iterator;};
  const head=res.writeHead;res.writeHead=function(code,...args){if(code===200&&String(args.at(-1)?.['Content-Type']??'').startsWith('text/event-stream')){activeSse++;res.once('close',()=>activeSse--);}return head.call(this,code,...args);};
 });
 const url=await app.listen(0);assert.notEqual(app.server.address().port,8787);
 const issue=async()=>{const r=await fetch(url+'/api/local/launch',{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Local-Control':app.controlToken},body:'{}'});assert.equal(r.status,200);return (await r.json()).ticket;};
 const exchange=await fetch(url+'/api/local/session',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify({ticket:await issue()})});assert.equal(exchange.status,200);const token=(await exchange.json()).session;
 const status=await fetch(url+'/api/status',{headers:{'X-Local-Session':token}});assert.equal(status.status,200);const csrf=(await status.json()).csrf;
 const headers={'X-Local-Session':token,'X-CSRF-Token':csrf,Origin:url,'Content-Type':'application/json',Connection:'close'};
 function request(path,body={},extra={}){
  const bytes=Buffer.from(JSON.stringify(body));let req;const result=new Promise((resolve,reject)=>{req=http.request(url+path,{method:'POST',agent:false,headers:{...headers,...extra,'Content-Length':bytes.length}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}resolve({status:res.statusCode,body:value});});res.on('error',reject);});req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('owned request deadline')));});requests.push(req);return {req,result,bytes};
 }
 async function delayed(path,body={},extra={}){gatePath=path;const entered=new Promise(r=>{gateResolve=r;}),r=request(path,body,extra);r.req.write(r.bytes.subarray(0,-1));let timer;try{await Promise.race([entered,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture did not pass header gates into partial-body wait')),2000);})]);}finally{clearTimeout(timer);}return r;}
 let closedCallback=false;function close(){const promise=new Promise((resolve,reject)=>{const returned=app.server.close(error=>{closedCallback=true;error?reject(error):resolve();});assert.equal(returned,app.server);});return promise;}
 function observations(response){return {status:response.status,error:response.body?.error??null,ticketIssued:typeof response.body?.ticket==='string',sessionExchanged:typeof response.body?.session==='string',authOperations:calls.slice(),readerCreations:readers.length,activeSse,credentialInMemory:app.lab.snapshot().credentialInMemory,closedCallback};}
 t.after(async()=>{settingsRelease(false);for(const req of requests)req.destroy();app.server.closeAllConnections();if(app.server.listening)await new Promise(r=>app.server.close(r));app.lab.cancel();assert.equal(app.server.listening,false);});
 return {app,url,headers,issue,request,delayed,close,calls,readers,observations,settingsGate,releaseSettings:()=>settingsRelease(true),get settingsCalls(){return settingsCalls;}};
}
for(const [name,path] of [['manual auth start','/api/start'],['tab presence lease','/api/presence'],['control launch ticket','/api/local/launch'],['single-use ticket exchange','/api/local/session']])test('close fences delayed body before '+name,async t=>{
 const f=await fixture(t),body=path==='/api/local/session'?{ticket:await f.issue()}:{},extra=path==='/api/local/launch'?{'X-Local-Control':f.app.controlToken}:{};
 const waiting=await f.delayed(path,body,extra),closed=f.close();assert.equal(f.app.lab.snapshot().credentialInMemory,false);waiting.req.end(waiting.bytes.subarray(-1));const response=await waiting.result;await closed;const observed=f.observations(response);t.diagnostic(JSON.stringify(observed));assert.equal(response.status,503);assert.equal(response.body?.error,'server_closing');assert.deepEqual(f.calls,[]);assert.equal(observed.activeSse,0);assert.equal(observed.ticketIssued,false);assert.equal(observed.sessionExchanged,false);assert.equal(observed.readerCreations,1);assert.equal(observed.credentialInMemory,false);assert.equal(observed.closedCallback,true);
});
test('close fences an already-running asynchronous settings result without publishing success',async t=>{
 const f=await fixture(t);await f.app.lab.start();const end=Date.now()+4500;while(!f.app.lab.snapshot().credentialInMemory){if(Date.now()>end)assert.fail('synthetic auth deadline');await sleep(10);}
 f.calls.length=0;const pending=f.request('/api/preferences',{persist:true});pending.req.end(pending.bytes);await Promise.race([f.settingsGate,sleep(2000).then(()=>assert.fail('owned settings entry deadline'))]);assert.equal(f.settingsCalls,1);const closed=f.close();f.releaseSettings();const response=await pending.result;await closed;const observed=f.observations(response);t.diagnostic(JSON.stringify({...observed,settingsCalls:f.settingsCalls}));assert.equal(response.status,503);assert.equal(response.body?.error,'server_closing');assert.deepEqual(f.calls,[]);assert.equal(f.settingsCalls,1,'only the pre-close action ran');assert.equal(observed.credentialInMemory,false);assert.ok(f.readers[0].closed>0);assert.equal(observed.closedCallback,true);
});
