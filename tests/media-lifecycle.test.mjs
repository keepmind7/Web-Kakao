// Deterministic wrapper-lifetime contracts, deliberately separate from the
// real SDK/socket controls in media-wire.test.mjs. A held synthetic writer is
// permitted to ignore disconnect; this is not a claim about net.Socket behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { uploadPhoto,MAX_UPLOAD_CHUNK_BYTES } from '../experiments/local-web/media-upload.mjs';
import { createReaderDiagnostic } from '../experiments/local-web/reader-diagnostics.mjs';

const tiny=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const data=Buffer.concat([tiny,Buffer.alloc(MAX_UPLOAD_CHUNK_BYTES*4+17)]);
const complete={method:'COMPLETE',status:0,body:{chatLog:{logId:'20',chatId:'123',authorId:'999',type:2,msgId:'345'}}};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const flush=async()=>{for(let n=0;n<60;n++)await Promise.resolve();};

function fixture({completed=0,offset=0,stall=true,socket,observer}={}){
  const ready=deferred(),held=deferred(),controller=new AbortController(),steps=[],snapshots=[],writes=[],calls=[];
  const diagnostic=createReaderDiagnostic({writeSnapshot:raw=>snapshots.push(JSON.parse(raw)),debounceMs:1000});
  let position=offset,finished=0,disconnects=0,outcome=null,unexpected=null;
  const media=Object.assign(new EventEmitter(),{
    async connect(){calls.push('connect');},
    async request(method){calls.push(method);return {status:0,body:{o:offset}};},
    async writeEncrypted(chunk){
      writes.push(Buffer.from(chunk));
      if(socket && typeof socket==='object'){socket.bytesWritten+=chunk.length+32;socket.writableLength=chunk.length+32;socket.writableNeedDrain=true;}
      if(stall && finished===completed){ready.resolve();await held.promise;}
      position+=chunk.length;finished++;
      if(socket && typeof socket==='object'){socket.writableLength=0;socket.writableNeedDrain=false;}
      if(!stall && position===data.length)media.emit('push',complete);
    },
    // Intentionally leaves the held Promise unresolved to test the caller's
    // independent deadline/error lifetime rather than a fake socket guarantee.
    disconnect(){disconnects++;if(socket && typeof socket==='object'){socket.destroyed=true;socket.writable=false;socket.writableLength=0;}},
  });
  Object.defineProperty(media,'socket',{get(){if(socket==='throw')throw new Error('synthetic socket getter unavailable');return socket;}});
  const pending=uploadPhoto({carriage:{async request(method){calls.push(method);return {status:0,body:{k:'SYNTHETIC_UPLOAD_KEY',vh:'unused.invalid',p:443}};}},
    createClient:()=>media,toLong:String,chatId:'123',userId:'999',messageId:'345',data,signal:controller.signal,
    resolve:async()=> '192.0.2.1',profile:{os:'android',appVersion:'26.1.2'},timeout:20,
    observe:details=>{steps.push(details);diagnostic.note('photo-upload',details);observer?.(details);}});
  void pending.then(value=>{outcome=value;},error=>{unexpected=error.name;});
  return {ready:ready.promise,held,controller,media,steps,writes,calls,pending,
    get outcome(){return outcome;},get unexpected(){return unexpected;},get disconnects(){return disconnects;},
    progress(){diagnostic.flush();return snapshots.at(-1)?.uploadStages?.stream;},
    async dispose(){controller.abort();held.resolve();try{await pending;}finally{diagnostic.end('synthetic fixture cleanup');}},
  };
}

function terminate(f,reason,t){
  if(reason==='deadline')t.mock.timers.tick(10020);
  else if(reason==='error')f.media.emit('error',new Error('synthetic transport failure'));
  else f.media.emit('disconnected');
}

for(const reason of ['deadline','error','close']){
  test(reason+' releases an unresolved stream write without relying on disconnect to settle it',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});const f=fixture();
    try{
      await f.ready;terminate(f,reason,t);await flush();
      assert.equal(f.unexpected,null);
      assert.equal(f.outcome?.phase,'unknown','POST already occurred; wrapper must settle independently of the held writer');
      assert.ok(f.disconnects>=1);assert.deepEqual(f.calls,['SHIP','connect','POST']);
      assert.equal(f.writes.length,1);
    }finally{await f.dispose();t.mock.timers.reset();}
  });

  test(reason+' followed by late write and COMPLETE starts no next frame or retry',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});const f=fixture();
    try{
      await f.ready;const before=f.writes.length;terminate(f,reason,t);await flush();
      f.media.emit('push',complete);f.held.resolve();await flush();
      assert.equal(f.writes.length,before,'late completion of a terminated write must not start another encrypted frame');
      assert.equal(f.outcome?.phase,'unknown');assert.deepEqual(f.calls,['SHIP','connect','POST']);
      assert.equal(f.steps.some(row=>row.stage==='received_complete'),false);
    }finally{await f.dispose();t.mock.timers.reset();}
  });

  test(reason+' records two completed local frames at the terminal boundary before a held third resolves',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});const f=fixture({completed:2});
    try{
      await f.ready;terminate(f,reason,t);await flush();const progress=f.progress();
      assert.equal(progress.sentBytes,MAX_UPLOAD_CHUNK_BYTES*2);
      assert.equal(progress.totalBytes,data.length);assert.equal(progress.frames,2);
      assert.equal(progress.bytes,data.length,'legacy bytes remains total-size compatible');
      assert.equal(f.steps.filter(row=>row.stage==='stream').length,2,'start plus one terminal aggregate, not per-frame logging');
      assert.equal(f.writes.length,3,'the held third frame is attempted but not locally confirmed');
    }finally{await f.dispose();t.mock.timers.reset();}
  });

  test(reason+' while the first frame is held reports zero locally completed bytes and frames',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});const f=fixture();
    try{
      await f.ready;terminate(f,reason,t);await flush();const progress=f.progress();
      assert.equal(progress.sentBytes,0);assert.equal(progress.totalBytes,data.length);assert.equal(progress.frames,0);
      assert.equal(progress.bytes,data.length);assert.equal(f.steps.filter(row=>row.stage==='stream').length,2);
    }finally{await f.dispose();t.mock.timers.reset();}
  });
}

for(const completed of [0,2])test('resumed offset plus '+completed+' completed frames is a position, not bytes newly sent',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const offset=65539,f=fixture({offset,completed});
  try{
    await f.ready;terminate(f,'error',t);await flush();const progress=f.progress();
    assert.equal(progress.sentBytes,offset+completed*MAX_UPLOAD_CHUNK_BYTES);
    assert.equal(progress.totalBytes,data.length);assert.equal(progress.frames,completed);
    assert.equal(f.writes.length,completed+1);
  }finally{await f.dispose();t.mock.timers.reset();}
});

test('normal completion preserves exactly two collapsed stream events and byte integrity',async()=>{
  const f=fixture({stall:false});
  try{
    assert.equal((await f.pending).phase,'accepted');
    const stream=f.steps.filter(row=>row.stage==='stream');assert.equal(stream.length,2);
    assert.equal(stream[1].sentBytes,data.length);assert.equal(stream[1].frames,f.writes.length);
    assert.deepEqual(Buffer.concat(f.writes),data);assert.deepEqual(f.calls,['SHIP','connect','POST']);
    const report=JSON.stringify(f.steps);for(const raw of ['SYNTHETIC_UPLOAD_KEY','unused.invalid',tiny.toString('base64')])assert.equal(report.includes(raw),false);
  }finally{await f.dispose();}
});

test('explicit abort already releases a stalled writer and does not start a late next frame',async()=>{
  const f=fixture();
  try{
    await f.ready;f.controller.abort();await flush();assert.equal(f.outcome?.phase,'unknown');
    const before=f.writes.length;f.held.resolve();await flush();assert.equal(f.writes.length,before);
    assert.deepEqual(f.calls,['SHIP','connect','POST']);
  }finally{await f.dispose();}
});

test('diagnostic aggregate keeps cumulative frame totals without counting a resume offset or duplicate snapshot',()=>{
  const snapshots=[],d=createReaderDiagnostic({writeSnapshot:raw=>snapshots.push(JSON.parse(raw))});
  try{
    d.note('photo-upload',{stage:'ship',totalBytes:1000});
    for(const row of [{sentBytes:400,frames:0},{sentBytes:600,frames:2},{sentBytes:600,frames:2},{sentBytes:700,frames:3}])d.note('photo-upload',{stage:'stream',totalBytes:1000,...row});
    d.flush();const progress=snapshots.at(-1).uploadStages.stream;
    assert.equal(progress.frames,3,'frames is cumulative local completion, not cumulative totals added together');
    assert.equal(progress.sentBytes,700);assert.equal(progress.totalBytes,1000);assert.equal(progress.bytes,1000);
  }finally{d.end('synthetic');}
});

test('diagnostic legacy byte field and legacy incremental stream events remain compatible',()=>{
  const snapshots=[],d=createReaderDiagnostic({writeSnapshot:raw=>snapshots.push(JSON.parse(raw))});
  try{
    d.note('photo-upload',{stage:'ship',totalBytes:1000});
    d.note('photo-upload',{stage:'stream',totalBytes:1000});
    for(const sentBytes of [100,200,300])d.note('photo-upload',{stage:'stream',sentBytes,totalBytes:1000});
    d.flush();const progress=snapshots.at(-1).uploadStages.stream;
    assert.equal(progress.bytes,1000);assert.equal(progress.frames,3);assert.equal(progress.count,4);
  }finally{d.end('synthetic');}
});

test('a new upload clears the prior local progress and cumulative frame aggregate',()=>{
  const snapshots=[],d=createReaderDiagnostic({writeSnapshot:raw=>snapshots.push(JSON.parse(raw))});
  try{
    d.note('photo-upload',{stage:'ship',totalBytes:1000});d.note('photo-upload',{stage:'stream',sentBytes:700,totalBytes:1000,frames:3});
    d.note('photo-upload',{stage:'ship',totalBytes:150});d.note('photo-upload',{stage:'stream',sentBytes:0,totalBytes:150,frames:0});d.flush();
    const progress=snapshots.at(-1).uploadStages.stream;
    assert.equal(progress.sentBytes,0);assert.equal(progress.totalBytes,150);assert.equal(progress.frames,0);assert.equal(progress.bytes,150);
  }finally{d.end('synthetic');}
});

const syntheticSocket=()=>({destroyed:false,writable:true,writableEnded:false,writableNeedDrain:false,writableLength:0,writableHighWaterMark:16384,bytesWritten:500,bytesRead:200});
const terminalWrite=f=>f.steps.findLast(row=>row.stage==='stream' && Object.hasOwn(row,'sentBytes'))?.write;

for(const reason of ['deadline','error','close'])test('write metadata preserves waiting third call and pre-cleanup socket at '+reason,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const socket=syntheticSocket(),f=fixture({completed:2,socket});
  try{
    await f.ready;terminate(f,reason,t);await flush();assert.equal(f.outcome?.phase,'unknown');
    const write=terminalWrite(f);assert.ok(write,'terminal aggregate must carry the bounded write object');
    assert.equal(write.index,3);assert.equal(write.inputBytes,65536);assert.equal(write.phase,'waiting');
    for(const name of ['elapsedMs','callMs'])assert.ok(Number.isInteger(write[name]) && write[name]>=0 && write[name]<=2147483647);
    assert.equal(write.before.available,true);assert.equal(write.before.writtenBytesDelta,2*(65536+32));
    assert.equal(write.returned.writableLength,65536+32);assert.equal(write.returned.writtenBytesDelta,3*(65536+32));
    assert.equal(write.terminal.destroyed,false,'first terminal observation precedes our disconnect');
    assert.equal(write.terminal.writable,true);assert.equal(write.terminal.writableLength,65536+32);
    assert.equal(write.terminal.readBytesDelta,0,'counter baseline excludes handshake/POST');
    assert.equal(socket.destroyed,true,'fixture teardown deliberately changes the live socket object');
    const frozen=JSON.stringify(write);f.held.resolve();f.media.emit('push',complete);await flush();
    assert.equal(JSON.stringify(terminalWrite(f)),frozen);assert.equal(f.writes.length,3);
    assert.equal(f.steps.filter(row=>row.stage==='stream').length,2);
  }finally{await f.dispose();t.mock.timers.reset();}
});

test('normal write metadata stays on the two aggregate events and preserves bytes',async()=>{
  const f=fixture({stall:false,socket:syntheticSocket()});
  try{
    assert.equal((await f.pending).phase,'accepted');const write=terminalWrite(f);assert.ok(write);
    assert.equal(write.index,f.writes.length);assert.equal(write.inputBytes,f.writes.at(-1).length);assert.equal(write.phase,'fulfilled');
    assert.deepEqual(Buffer.concat(f.writes),data);assert.equal(f.steps.filter(row=>row.stage==='stream').length,2);
    assert.deepEqual(f.calls,['SHIP','connect','POST']);
  }finally{await f.dispose();}
});

for(const socket of [undefined,'throw'])test('missing or throwing socket metadata is safe: '+(socket??'missing'),async()=>{
  const f=fixture({stall:false,socket});
  try{
    assert.equal((await f.pending).phase,'accepted');const write=terminalWrite(f);assert.ok(write);
    assert.equal(write.before.available,false);assert.equal(write.returned.available,false);
    assert.equal(f.steps.filter(row=>row.stage==='stream').length,2);assert.deepEqual(Buffer.concat(f.writes),data);
  }finally{await f.dispose();}
});

test('observer exceptions cannot reject or prevent a normal synthetic photo upload',async()=>{
  const f=fixture({stall:false,observer(){throw new Error('synthetic observer failure');}});
  try{
    const phase=await f.pending.then(result=>result.phase,()=> 'observer_rejected');
    assert.equal(phase,'accepted');assert.deepEqual(Buffer.concat(f.writes),data);assert.deepEqual(f.calls,['SHIP','connect','POST']);
  }finally{await f.dispose().catch(()=>{});}
});

test('late held write settlement after abort changes no events and starts no next write',async()=>{
  const f=fixture({completed:2,socket:syntheticSocket()});
  try{
    await f.ready;f.controller.abort();await f.pending;const events=JSON.stringify(f.steps),count=f.writes.length;
    f.held.resolve();f.media.emit('push',complete);await flush();
    assert.equal(JSON.stringify(f.steps),events);assert.equal(f.writes.length,count);assert.equal(f.outcome.phase,'unknown');
  }finally{await f.dispose();}
});

test('photo diagnostic sanitizes nested write fields and never calls an untrusted toJSON',()=>{
  const snapshots=[],d=createReaderDiagnostic({writeSnapshot:raw=>snapshots.push(raw)});let conversions=0;
  const sentinel='PRIVATE_SYNTHETIC_DIAGNOSTIC_SENTINEL';
  try{
    d.note('photo-upload',{stage:'stream',sentBytes:12,totalBytes:100,frames:1,secret:sentinel,write:{index:1,inputBytes:65536,phase:'waiting',elapsedMs:4,callMs:0,address:sentinel,before:{available:true,destroyed:false,writable:true,writableLength:0,writableHighWaterMark:16384,writtenBytesDelta:0,readBytesDelta:0,host:sentinel,socket:{toJSON(){conversions++;return sentinel;}}},stack:sentinel,payload:Buffer.from(sentinel)}});
    d.flush();const raw=snapshots.at(-1);assert.equal(raw.includes(sentinel),false);assert.equal(conversions,0);
    const row=JSON.parse(raw).events.at(-1);assert.equal(row.write.index,1);assert.equal(row.write.before.available,true);
    assert.equal(Object.hasOwn(row,'secret'),false);assert.equal(Object.hasOwn(row.write,'address'),false);assert.equal(Object.hasOwn(row.write.before,'socket'),false);
  }finally{d.end('synthetic');}
});

test('photo diagnostic omits invalid numeric ranges and non-boolean socket state',()=>{
  const snapshots=[],d=createReaderDiagnostic({writeSnapshot:raw=>snapshots.push(JSON.parse(raw))});
  try{
    d.note('photo-upload',{stage:'stream',sentBytes:-1,totalBytes:10485761,offset:Infinity,frames:100001,status:1.5,failure:'untrusted',category:'untrusted',code:'untrusted',write:{index:0,inputBytes:10485761,phase:'untrusted',elapsedMs:-1,callMs:2147483648,before:{available:1,destroyed:'true',writableLength:-1,writableHighWaterMark:Infinity,writtenBytesDelta:-1,readBytesDelta:2147483648}}});d.flush();
    const row=snapshots.at(-1).events.at(-1);
    for(const name of ['sentBytes','totalBytes','offset','frames','status','failure','category','code'])assert.equal(Object.hasOwn(row,name),false,name+' invalid value must be omitted');
    const write=row.write??{};for(const name of ['index','inputBytes','phase','elapsedMs','callMs'])assert.equal(Object.hasOwn(write,name),false);
    const socket=write.before??{};for(const name of ['available','destroyed','writableLength','writableHighWaterMark','writtenBytesDelta','readBytesDelta'])assert.equal(Object.hasOwn(socket,name),false);
  }finally{d.end('synthetic');}
});

test('unknown photo diagnostic stage is ignored rather than stored with arbitrary details',()=>{
  const snapshots=[],d=createReaderDiagnostic({writeSnapshot:raw=>snapshots.push(JSON.parse(raw))});
  try{
    d.note('photo-upload',{stage:'ship',totalBytes:100});d.flush();const before=snapshots.at(-1).events.length;
    d.note('photo-upload',{stage:'untrusted_stage',secret:'PRIVATE_SYNTHETIC_DIAGNOSTIC_SENTINEL'});d.flush();
    assert.equal(snapshots.at(-1).events.length,before);
  }finally{d.end('synthetic');}
});

test('first COMPLETE rejection is observed while third write remains held without changing timeout outcome',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture({completed:2,socket:syntheticSocket()});
  try{
    await f.ready;
    f.media.emit('push',{method:'COMPLETE',status:0,body:{status:-203}});
    await flush();const arrival=f.steps.find(row=>row.stage==='complete_observed');
    assert.equal(f.outcome,null,'arrival metadata must not finish or cancel the existing held stream');assert.equal(f.writes.length,3);
    f.media.emit('push',complete);await flush();
    t.mock.timers.tick(10020);await flush();
    assert.equal(f.outcome?.phase,'unknown','the unchanged media deadline still determines this held-write outcome');
    assert.equal(f.writes.length,3);assert.deepEqual(f.calls,['SHIP','connect','POST']);
    assert.ok(arrival,'COMPLETE arrival must be traced before the stream finishes or times out');
    assert.equal(arrival.status,-203,'normalized body refusal is distinct from packet header0');assert.equal(arrival.beforeStreamEnd,true);
    assert.ok(f.steps.indexOf(arrival)<f.steps.findIndex(row=>row.stage==='deadline'));
    assert.equal(f.steps.filter(row=>row.stage==='complete_observed').length,1,'duplicates do not replace the first observation');
    assert.equal(f.steps.some(row=>row.stage==='received_complete'),false,'processed COMPLETE remains a later separate boundary');
    const count=f.steps.length;f.held.resolve();f.media.emit('push',complete);await flush();
    assert.equal(f.steps.length,count);assert.equal(f.writes.length,3);
  }finally{await f.dispose();t.mock.timers.reset();}
});

test('first COMPLETE arrival status and local flag survive rolling events and clear at next SHIP',()=>{
  const snapshots=[],d=createReaderDiagnostic({writeSnapshot:raw=>snapshots.push(JSON.parse(raw))});
  try{
    d.note('photo-upload',{stage:'ship',totalBytes:1000});
    d.note('photo-upload',{stage:'complete_observed',status:-203,beforeStreamEnd:true});
    d.note('photo-upload',{stage:'complete_observed',status:0,beforeStreamEnd:false});
    for(let n=0;n<45;n++)d.note('request',{method:'PING'});
    d.flush();const state=snapshots.at(-1),arrival=state.uploadStages.complete_observed;
    assert.equal(state.events.length,40);assert.equal(state.events.some(row=>row.stage==='complete_observed'),false);
    assert.ok(arrival,'first COMPLETE metadata must survive recent-event rollover');
    assert.equal(arrival.status,-203);assert.equal(arrival.beforeStreamEnd,true);
    d.note('photo-upload',{stage:'ship',totalBytes:2000});d.flush();
    assert.equal(Object.hasOwn(snapshots.at(-1).uploadStages,'complete_observed'),false);
  }finally{d.end('synthetic');}
});
