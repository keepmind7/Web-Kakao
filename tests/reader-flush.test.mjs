// Shutdown drains only already-terminated synthetic children.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {createReadOnlyReader} from '../experiments/local-web/reader-manager.mjs';

function fixture(){
  const child=Object.assign(new EventEmitter(),{send(){return true;},kill(){return true;}});let journal;
  const reader=createReadOnlyReader({spawn:()=>child,lifecycleOptions:{writeSnapshot:raw=>{journal=JSON.parse(raw);}},
    preferenceStore:{account:()=>({key:()=>Buffer.alloc(32),snapshot:()=>({}),room:()=>null,close(){}})}});
  assert.equal(reader.connect({userId:'999',deviceUUID:'SYNTHETIC',accessToken:'SYNTHETIC_NO_ACCOUNT'}),true);
  child.emit('message',{type:'reader-ready'});
  child.emit('message',{type:'reader-rooms',source:'loginlist',rooms:[],stats:{sourceRoomCount:0}});
  return {reader,child,journal:()=>journal};
}

test('diagnostic drain waits for an intentionally closed child exit before persisting',async()=>{
  const f=fixture();let drained=false;
  try{
    f.reader.close();const pending=f.reader.flushDiagnostics().then(()=>{drained=true;});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);
    f.child.emit('exit',0,null);await pending;
    assert.equal(drained,true);assert.deepEqual(f.journal().attempts[0].exit,{code:0,signal:null});
  }finally{f.child.emit('exit',0,null);f.reader.close();}
});

test('diagnostic drain does not wait for a live connected child to exit',async()=>{
  const f=fixture();
  try{await f.reader.flushDiagnostics();assert.equal(f.reader.snapshot().phase,'connected');}
  finally{f.reader.close();f.child.emit('exit',0,null);await f.reader.flushDiagnostics();}
});

test('a child that fails to start closes without exit and still drains its failure journal',async()=>{
  let child,journal;const missing=join(tmpdir(),'wk-missing-'+randomUUID(),'node');assert.equal(existsSync(missing),false);
  const reader=createReadOnlyReader({spawn:()=>{child=spawn(missing,[],{stdio:'ignore'});return child;},
    lifecycleOptions:{writeSnapshot:raw=>{journal=JSON.parse(raw);}},
    preferenceStore:{account:()=>({key:()=>Buffer.alloc(32),snapshot:()=>({}),room:()=>null,close(){}})}});
  try{
    assert.equal(reader.connect({userId:'999',deviceUUID:'SYNTHETIC',accessToken:'SYNTHETIC_NO_ACCOUNT'}),true);
    // Manager cleanup intentionally replaces operational listeners. Observe
    // its public failure state rather than installing a removable child spy.
    const end=Date.now()+2000;while(reader.snapshot().phase!=='disconnected'){assert.ok(Date.now()<end,'spawn failure did not settle');await new Promise(resolve=>setTimeout(resolve,5));}
    const drained=await Promise.race([reader.flushDiagnostics().then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),500))]);
    assert.equal(drained,true,'close without exit must settle the diagnostic drain');
    assert.equal(journal.attempts[0].failure.stage,'worker');
    assert.equal(journal.attempts[0].events.find(event=>event.event==='worker-error').code,'ENOENT');
    assert.equal(journal.attempts[0].exit,undefined,'a failed spawn has no observed process exit code');
  }finally{reader.close();}
});
