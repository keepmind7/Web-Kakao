// A normal local shutdown gives pending private diagnostics a bounded drain.
// All readers/auth are synthetic and use an ephemeral loopback listener.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalServer} from '../experiments/local-web/server.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const end=Date.now()+1500;while(!check()){assert.ok(Date.now()<end,'shutdown did not reach diagnostic flush');await wait(5);}}
function fixture(flush){
  let closed=false,calls=0;
  const reader={snapshot:()=>({phase:'closed',attempts:0}),close(){closed=true;},flushDiagnostics(){assert.equal(closed,true);calls++;return flush();}};
  return {app:createLocalServer({readerFactory:()=>reader,preferenceStore:{}}),calls:()=>calls};
}
async function shutdown(app,url){return fetch(url+'/api/local/control/shutdown',{method:'POST',headers:{'X-Local-Control':app.controlToken,Origin:url,'Content-Type':'application/json'},body:'{}'});}
async function cleanup(app){app.server.closeAllConnections();if(app.server.listening)await new Promise(resolve=>app.close(resolve));}

test('shutdown waits for pending diagnostic persistence before acknowledging stop',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;}),{app,calls}=fixture(()=>held);let completed=false;
  try{
    const url=await app.listen(0);assert.notEqual(app.server.address().port,8787);
    const response=shutdown(app,url).then(value=>{completed=true;return value;});
    await until(()=>calls()===1);assert.equal(completed,false);
    const late=await fetch(url+'/api/local/control/start',{method:'POST',headers:{'X-Local-Control':app.controlToken,Origin:url,'Content-Type':'application/json'},body:'{}'});
    assert.equal(late.status,503,'an accepted stop must refuse new authentication while draining');release();
    assert.equal((await response).status,200);
  }finally{release();await cleanup(app);}
});

test('diagnostic persistence rejection does not prevent normal local shutdown',async()=>{
  const {app,calls}=fixture(()=>Promise.reject(new Error('SYNTHETIC_PRIVATE')));
  try{const url=await app.listen(0);assert.notEqual(app.server.address().port,8787);assert.equal((await shutdown(app,url)).status,200);assert.equal(calls(),1);}
  finally{await cleanup(app);}
});
