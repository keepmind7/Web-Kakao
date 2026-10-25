import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createReadOnlyReader} from '../experiments/local-web/reader-manager.mjs';
import {createReaderLifecycle,atomicReaderFile,safeReaderDiagnostic} from '../experiments/local-web/reader-lifecycle.mjs';
import {createReaderDiagnostic} from '../experiments/local-web/reader-diagnostics.mjs';
import {mkdtempSync,realpathSync,readFileSync,writeFileSync,readdirSync,statSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const credential={userId:'999',deviceUUID:'SYNTHETIC',accessToken:'SYNTHETIC_NO_ACCOUNT'};
const room={key:'r_'+'a'.repeat(24),kind:'DirectChat',title:'Synthetic'};
function fixture(){
  const children=[],writes=[];let time=1000;
  const profile={key:()=>Buffer.alloc(32),snapshot:()=>({notifications:false}),room:()=>null,close(){}};
  const reader=createReadOnlyReader({messaging:true,now:()=>time,preferenceStore:{account:()=>profile},lifecycleOptions:{now:()=>time,writeSnapshot:raw=>writes.push(JSON.parse(raw))},spawn:()=>{
    const child=Object.assign(new EventEmitter(),{send(_message,callback){callback?.();return true;},kill(){return true;}});children.push(child);return child;
  }});
  return {reader,children,writes,advance(){time+=100;},connect(){assert.equal(reader.connect(credential),true);const child=children.at(-1);child.emit('message',{type:'reader-ready'});child.emit('message',{type:'reader-rooms',source:'loginlist',rooms:[room],stats:{sourceRoomCount:1}});return child;}};
}

// Break caught: reconnect used to erase the prior failure; terminating a child
// removed its exit listener, losing actual OS exit code/signal.
test('supervisor preserves failure and actual late exit across reconnect without changing the new session',()=>{
  const f=fixture();try{
    const old=f.connect();f.advance();old.emit('message',{type:'reader-failed',stage:'transport',status:-203});
    assert.equal(f.reader.snapshot().phase,'disconnected');f.advance();const current=f.connect();
    old.emit('exit',null,'SIGABRT');assert.equal(f.reader.snapshot().phase,'connected');
    assert.ok(f.writes.length>0,'parent supervisor must persist its own lifecycle');
    const attempts=f.writes.at(-1).attempts;assert.equal(attempts.length,2);
    assert.equal(attempts[0].failure.stage,'transport');assert.equal(attempts[0].failure.status,-203);
    assert.equal(attempts[0].terminationReason,'failure');assert.deepEqual(attempts[0].exit,{code:null,signal:'SIGABRT'});
    assert.equal(attempts[1].exit,undefined);
    f.reader.disconnect();current.emit('exit',0,null);
    const final=f.writes.at(-1).attempts;assert.equal(final[1].terminationReason,'manual');assert.deepEqual(final[1].exit,{code:0,signal:null});
  }finally{f.reader.close();}
});

// Break caught: worker diagnostics were a single overwritten file; the parent
// must retain the last safe diagnostic for each attempt, without raw IPC data.
test('supervisor retains per-attempt diagnostic summaries and abnormal exit without unsafe IPC fields',()=>{
  const f=fixture();try{
    const child=f.connect();child.emit('message',{type:'reader-diagnostic',snapshot:{lastOperation:'PING',exitReason:'fatal',fault:{category:'RangeError',frames:['onData','PRIVATE_FRAME'],message:'PRIVATE_TOKEN'},events:[{event:'response',method:'PING',status:0,elapsedMs:12,url:'https://PRIVATE.invalid'}],raw:'PRIVATE_ACCOUNT'}});
    child.emit('exit',4,null);assert.equal(f.reader.snapshot().phase,'disconnected');
    f.connect();assert.ok(f.writes.length>0,'last worker diagnostic must survive a new attempt');
    const first=f.writes.at(-1).attempts[0];assert.equal(first.diagnostic.exitReason,'fatal');assert.equal(first.diagnostic.lastOperation,'PING');
    assert.deepEqual(first.diagnostic.fault,{category:'RangeError',frames:['onData']});assert.deepEqual(first.exit,{code:4,signal:null});
    assert.equal(JSON.stringify(f.writes).includes('PRIVATE'),false);
  }finally{f.reader.close();}
});

test('reopening the bounded journal preserves cause summaries after their event rolls out',async()=>{
  const folder=realpathSync(mkdtempSync(join(tmpdir(),'wk-reader-lifecycle-')));
  try{
    const journal=createReaderLifecycle({folder}),id=journal.start();journal.record(id,'failure',{stage:'decode',status:-203});journal.record(id,'termination',{reason:'failure'});journal.record(id,'exit',{code:3221225477,signal:null});
    for(let i=0;i<20;i++)journal.record(id,'ready');
    await journal.flush();const reader=createReaderLifecycle({folder});await reader.flush();const reopened=reader.snapshot();assert.deepEqual(reopened.attempts[0].failure,{stage:'decode',status:-203});assert.equal(reopened.attempts[0].terminationReason,'failure');assert.deepEqual(reopened.attempts[0].exit,{code:3221225477,signal:null});
  }finally{rmSync(folder,{recursive:true,force:true});assert.equal(existsSync(folder),false);}
});

test('supervisor never evaluates a diagnostic IPC snapshot accessor',()=>{
  const f=fixture();let reads=0;try{const child=f.connect();const message={type:'reader-diagnostic'};Object.defineProperty(message,'snapshot',{get(){reads++;throw new Error('PRIVATE_GETTER');}});
    assert.doesNotThrow(()=>child.emit('message',message));assert.equal(reads,0);assert.equal(f.reader.snapshot().phase,'connected');
  }finally{f.reader.close();}
});

test('journal bounds attempts and event history and excludes hooks and non-allowlisted values',()=>{
  let persisted;const journal=createReaderLifecycle({writeSnapshot:raw=>{persisted=raw;}});let reads=0;
  const dangerous={lastOperation:'PRIVATE_METHOD',exitReason:'PRIVATE_REASON',toJSON(){throw new Error('PRIVATE_SERIALIZE');},fault:{category:'TypeError',frames:['onData','PRIVATE_FRAME']},events:[{event:'response',method:'PING',status:0,url:'PRIVATE_URL'}]};
  Object.defineProperty(dangerous,'startedAt',{get(){reads++;throw new Error('PRIVATE_GETTER');}});
  for(let i=0;i<10;i++){const id=journal.start();journal.record(id,'failure',{stage:'PRIVATE_STAGE',status:'PRIVATE_STATUS'});journal.record(id,'termination',{reason:'PRIVATE_REASON'});journal.diagnostic(id,dangerous);for(let k=0;k<25;k++)journal.record(id,'ready');}
  const snapshot=JSON.parse(persisted);assert.equal(snapshot.attempts.length,8);assert.ok(snapshot.attempts.reduce((n,a)=>n+a.events.length,0)<=128);assert.ok(Buffer.byteLength(persisted)<=1024*1024);assert.equal(persisted.includes('PRIVATE'),false);assert.equal(reads,0);
  assert.deepEqual(snapshot.attempts[0].failure,{stage:'other',status:null});assert.deepEqual(safeReaderDiagnostic(dangerous).fault,{category:'TypeError',frames:['onData']});
});

test('slow journal writers keep one active write and only the latest pending snapshot',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});let active=0,maxActive=0,writes=0,persisted;
  const journal=createReaderLifecycle({writeSnapshot:async raw=>{active++;maxActive=Math.max(maxActive,active);writes++;try{await gate;persisted=JSON.parse(raw);}finally{active--;}}});
  try{
    const id=journal.start();await new Promise(resolve=>setImmediate(resolve));
    for(let i=0;i<100;i++)journal.record(id,'ready');journal.record(id,'exit',{code:4,signal:null});
    assert.equal(journal.snapshot().attempts[0].exit.code,4,'memory state changes before disk completion');assert.equal(maxActive,1,'journal writes must be serial');assert.equal(writes,1);
    let timerRan=false;await new Promise(resolve=>setTimeout(()=>{timerRan=true;resolve();},0));assert.equal(timerRan,true);
    release();await journal.flush();assert.equal(active,0);assert.ok(writes<=2,'intermediate snapshots must coalesce to one latest pending write');assert.equal(persisted.attempts[0].exit.code,4);
  }finally{release();}
});

test('unsigned Windows native crash exit code survives persistence and reload',async()=>{
  let raw;const journal=createReaderLifecycle({writeSnapshot:data=>{raw=data;}}),id=journal.start();journal.record(id,'exit',{code:3221225477,signal:null});await journal.flush?.();
  assert.deepEqual(journal.snapshot().attempts[0].exit,{code:3221225477,signal:null});
  const reopened=createReaderLifecycle({readSnapshot:()=>raw,writeSnapshot(){}});await reopened.flush?.();assert.deepEqual(reopened.snapshot().attempts[0].exit,{code:3221225477,signal:null});
});

test('history loaded asynchronously merges with attempts started before the read completes',async()=>{
  let release,raw,writes=0;const gate=new Promise(resolve=>{release=resolve;});
  const old=Array.from({length:8},(_,i)=>({id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,startedAt:100+i,events:[{event:'start',at:100+i}],...(i===7?{failure:{stage:'transport',status:-203}}:{})}));
  const journal=createReaderLifecycle({readSnapshot:()=>gate,writeSnapshot:data=>{writes++;raw=data;},now:()=>1000});
  try{
    const current=journal.start();journal.record(current,'failure',{stage:'decode',status:-1});journal.record(current,'exit',{code:4,signal:null});
    assert.equal(journal.snapshot().attempts.at(-1).id,current);assert.deepEqual(journal.snapshot().attempts.at(-1).failure,{stage:'decode',status:-1});assert.equal(writes,0,'never overwrite history before its read completes');
    release(JSON.stringify({version:1,attempts:old}));await journal.flush?.();
    const attempts=journal.snapshot().attempts;assert.equal(attempts.length,8);assert.deepEqual(attempts.map(row=>row.id),[...old.slice(1).map(row=>row.id),current]);
    assert.deepEqual(attempts[6].failure,{stage:'transport',status:-203});assert.deepEqual(attempts[7].exit,{code:4,signal:null});assert.deepEqual(JSON.parse(raw).attempts,attempts);
  }finally{release(null);await journal.flush?.();}
});

test('exit codes use uint32 bounds without widening failure or diagnostic statuses',async()=>{
  let raw;const journal=createReaderLifecycle({writeSnapshot:data=>{raw=data;}});
  for(const [code,want] of [[0,0],[2147483648,2147483648],[4294967295,4294967295],[-1,null],[4294967296,null],[1.5,null]]){
    const id=journal.start();journal.record(id,'exit',{code,signal:null});assert.equal(journal.snapshot().attempts.at(-1).exit.code,want);
  }
  const id=journal.start();journal.record(id,'failure',{stage:'decode',status:3221225477});journal.diagnostic(id,{events:[{event:'response',status:3221225477,bodyStatus:-2147483648}]});await journal.flush?.();
  const reopened=createReaderLifecycle({readSnapshot:()=>raw,writeSnapshot(){}});await reopened.flush?.();
  assert.deepEqual(reopened.snapshot().attempts.slice(0,6).map(row=>row.exit.code),[0,2147483648,4294967295,null,null,null]);
  assert.deepEqual(reopened.snapshot().attempts.at(-1).failure,{stage:'decode',status:null});assert.deepEqual(reopened.snapshot().attempts.at(-1).diagnostic.events,[{event:'response',bodyStatus:-2147483648}]);
});

test('a rejected async read preserves immediate memory state without overwriting history',async()=>{
  let reject,writes=0;const read=new Promise((_resolve,fail)=>{reject=fail;});
  const journal=createReaderLifecycle({readSnapshot:()=>read,writeSnapshot:()=>{writes++;}}),id=journal.start();
  journal.record(id,'exit',{code:4,signal:null});reject(new Error('PRIVATE_READ_FAILURE'));await journal.flush();
  assert.equal(writes,0);assert.equal(journal.snapshot().storageError,true);assert.deepEqual(journal.snapshot().attempts[0].exit,{code:4,signal:null});assert.equal(JSON.stringify(journal.snapshot()).includes('PRIVATE'),false);
});

test('a rejected async writer drains the latest snapshot and reports only a safe storage error',async()=>{
  let reject,writes=0,raw;const first=new Promise((_resolve,fail)=>{reject=fail;});
  const journal=createReaderLifecycle({writeSnapshot:data=>{writes++;if(writes===1)return first;raw=data;return Promise.resolve();}}),id=journal.start();
  journal.record(id,'exit',{code:4,signal:null});reject(new Error('PRIVATE_WRITE_FAILURE'));await journal.flush();
  assert.equal(writes,2);assert.deepEqual(JSON.parse(raw).attempts[0].exit,{code:4,signal:null});assert.equal(JSON.parse(raw).storageError,true);assert.equal(journal.snapshot().storageError,true);assert.equal(raw.includes('PRIVATE'),false);
});

test('atomic storage replaces readable private files and refuses unsafe targets and oversize writes',()=>{
  const folder=realpathSync(mkdtempSync(join(tmpdir(),'wk-reader-atomic-')));
  try{
    atomicReaderFile('reader-lifecycle.json','{"version":1,"attempts":[]}',{folder});const path=join(folder,'reader-lifecycle.json'),before=statSync(path).ino;
    atomicReaderFile('reader-lifecycle.json','{"version":1,"attempts":[],"updated":true}',{folder});assert.equal(JSON.parse(readFileSync(path)).updated,true);assert.notEqual(statSync(path).ino,before);if(process.platform!=='win32')assert.equal(statSync(path).mode&0o777,0o600);
    const old=readFileSync(path,'utf8');assert.throws(()=>atomicReaderFile('reader-lifecycle.json','x'.repeat(1024*1024+1),{folder}));assert.equal(readFileSync(path,'utf8'),old);assert.deepEqual(readdirSync(folder),['reader-lifecycle.json']);
    if(process.platform!=='win32'){const target=join(folder,'own-target');writeFileSync(target,'synthetic',{mode:0o600});symlinkSync(target,join(folder,'reader-diagnostic.json'));assert.throws(()=>atomicReaderFile('reader-diagnostic.json','replacement',{folder}));assert.equal(readFileSync(target,'utf8'),'synthetic');}
  }finally{rmSync(folder,{recursive:true,force:true});assert.equal(existsSync(folder),false);}
});

test('corrupt and oversized journals are preserved rather than silently overwritten',async()=>{
  for(const data of ['{', 'x'.repeat(1024*1024+1)]){
    const folder=realpathSync(mkdtempSync(join(tmpdir(),'wk-reader-corrupt-')));
    try{const path=join(folder,'reader-lifecycle.json');writeFileSync(path,data,{mode:0o600});const journal=createReaderLifecycle({folder});journal.start();await journal.flush();assert.equal(journal.snapshot().storageError,true);assert.equal(readFileSync(path,'utf8'),data);assert.deepEqual(readdirSync(folder),['reader-lifecycle.json']);}
    finally{rmSync(folder,{recursive:true,force:true});assert.equal(existsSync(folder),false);}
  }
});

test('injected diagnostic writers retain latest/send contracts and never create the configured private folder',()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'wk-reader-writers-'))),folder=join(root,'must-not-exist');let latest,send,summary;
  try{
    const lifecycle=createReaderLifecycle({folder,writeSnapshot:()=>{throw new Error('SYNTHETIC_WRITER_FAILURE');}});const id=lifecycle.start();lifecycle.record(id,'exit',{code:4,signal:null});assert.equal(lifecycle.snapshot().storageError,true);assert.equal(existsSync(folder),false);
    const diagnostic=createReaderDiagnostic({writeSnapshot:raw=>{latest=JSON.parse(raw);},writeSendSnapshot:raw=>{send=JSON.parse(raw);},onSnapshot:value=>{summary=value;}});
    diagnostic.note('send-stage',{stage:'start',kind:'text'});diagnostic.note('send-stage',{stage:'result',phase:'failed'});diagnostic.end('fatal',Object.assign(new TypeError('PRIVATE_ERROR'),{stack:'PRIVATE at onData (PRIVATE_URL:1)'}));
    assert.equal(send.phase,undefined);assert.equal(send.events.at(-1).phase,'failed');assert.equal(latest.exitReason,'fatal');assert.equal(latest.lastSend.kind,'text');assert.deepEqual(summary.fault,{category:'TypeError',frames:['onData']});assert.equal(JSON.stringify(summary).includes('PRIVATE'),false);assert.equal(existsSync(folder),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
