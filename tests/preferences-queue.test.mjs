import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,mkdtempSync,readdirSync,readFileSync,realpathSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createPreferenceStore } from '../experiments/local-web/preferences.mjs';
import { verifyPrivateFileAsync } from '../experiments/local-web/private-storage.mjs';

const turn=()=>new Promise(resolve=>setImmediate(resolve));
const gate=()=>{let release;const promise=new Promise(resolve=>release=resolve);return {promise,release};};
const room='a'.repeat(64);

// Hold only the injected security check. No directory is created, and closing
// every profile before release prevents the real writer from reaching disk.
async function heldFolder(){
  const folder=join(tmpdir(),'web-kakao-queue-no-write-'+randomUUID()),hold=gate(),entered=gate();
  const options={folder,asyncSecurity:true,secureFolder:()=>{entered.release();return hold.promise;},verifyFile:async()=>true};
  assert.equal(existsSync(folder),false);
  const store=createPreferenceStore(options),profile=await store.account('111');
  const otherStore=createPreferenceStore(options),other=await otherStore.account('222');
  const pending=[profile.set({persist:true})];await entered.promise;
  return {folder,store,profile,otherStore,other,pending,
    async close(){profile.close();other.close();hold.release();await Promise.allSettled(pending);assert.equal(existsSync(folder),false);}};
}

test('async settings queue bounds running plus waiting writes and reports overload truthfully',async()=>{
  const f=await heldFolder();
  try{
    for(let i=0;i<63;i++)f.pending.push(f.profile.set({notifications:i%2===0}));
    assert.ok(f.pending.every(value=>typeof value?.then==='function'));
    assert.equal(f.profile.set({readSync:true}),false,'the 65th operation must not join the held queue');
    assert.equal(f.profile.snapshot().storageError,true);
    assert.equal(f.profile.snapshot().readSync,false,'a refused change must not publish state');
  }finally{await f.close();}
});

test('another store for the same folder cannot bypass the write admission bound',async()=>{
  const f=await heldFolder();
  try{
    for(let i=0;i<63;i++)f.pending.push(f.profile.set({notifications:true}));
    assert.equal(f.other.setRoom(room,{muted:true}),false);
    assert.equal(f.other.snapshot().storageError,true);
    assert.deepEqual(f.other.room(room),{});
  }finally{await f.close();}
});

test('account preparation rejects settings_busy at a full shared folder queue',async()=>{
  const f=await heldFolder();let outcome;let request;
  try{
    for(let i=0;i<63;i++)f.pending.push(f.profile.set({notifications:true}));
    request=f.otherStore.account('333').then(profile=>{profile.close();outcome={kind:'profile'};},error=>{outcome={kind:'error',code:error.code,message:error.message};});
    await turn();
    assert.deepEqual(outcome,{kind:'error',code:'settings_busy',message:'settings_busy'});
  }finally{await f.close();await request;}
});

test('closed profiles reject changes before enqueue and cannot publish a held write',async()=>{
  const f=await heldFolder();
  try{
    f.profile.close();
    assert.equal(f.profile.set({notifications:true}),false);
    assert.equal(f.profile.setRoom(room,{muted:true}),false);
    assert.equal(f.profile.forget(),false);
    // Closed calls above must not consume any of the remaining 63 slots.
    for(let i=0;i<63;i++)f.pending.push(f.other.set({notifications:true}));
    assert.ok(f.pending.every(value=>typeof value?.then==='function'));
    assert.equal(f.other.set({readSync:true}),false);
  }finally{await f.close();}
  assert.deepEqual(await Promise.all(f.pending),Array(64).fill(false));
});

test('capacity returns after successful writes and rejected account operations settle',async()=>{
  const folder=join(tmpdir(),'web-kakao-queue-no-write-'+randomUUID());
  const store=createPreferenceStore({folder,asyncSecurity:true,secureFolder:async path=>path,verifyFile:async()=>true});
  const profile=await store.account('111');
  try{
    const writes=Array.from({length:64},()=>profile.set({notifications:true}));
    assert.equal(profile.set({readSync:true}),false);
    assert.deepEqual(await Promise.all(writes),Array(64).fill(true));
    assert.equal(await profile.set({readSync:true}),true);
    await assert.rejects(store.account('invalid'),/settings_identity/);
    const next=await store.account('222');next.close();
    assert.equal(profile.snapshot().readSync,true);
    assert.equal(existsSync(folder),false);
  }finally{profile.close();}
});

test('failed held writes release admission capacity without bypassing their security check',async()=>{
  const f=await heldFolder();
  try{
    for(let i=0;i<63;i++)f.pending.push(f.profile.set({notifications:true}));
    assert.equal(f.other.forget(),false);
  }finally{await f.close();}
  const next=await f.otherStore.account('333');
  try{assert.equal(await next.set({notifications:true}),true);assert.equal(existsSync(f.folder),false);}
  finally{next.close();}
});

// These fixtures exercise real durable writes and permission checks, delaying
// only the security boundary. Every generated folder belongs to this test.
async function diskFolder(security=async()=>{}){
  const folder=mkdtempSync(join(realpathSync(tmpdir()),'web-kakao-queue-disk-'));
  const options={folder,asyncSecurity:true,verifyFile:async path=>{await security(path);return verifyPrivateFileAsync(path);}};
  const profiles=[],pending=[];
  try{
    const store=createPreferenceStore(options),profile=await store.account('111');profiles.push(profile);
    assert.equal(await profile.set({persist:true}),true);
    const files=readdirSync(folder).filter(name=>name.endsWith('.json'));assert.equal(files.length,1);
    const path=join(folder,files[0]);
    return {folder,options,store,profile,profiles,pending,read:()=>readFileSync(path,'utf8'),
      async close(release=()=>{}){for(const profile of profiles)profile.close();release();await Promise.allSettled(pending);rmSync(folder,{recursive:true,force:true});assert.equal(existsSync(folder),false);}};
  }catch(error){for(const profile of profiles)profile.close();rmSync(folder,{recursive:true,force:true});throw error;}
}

test('admitted persistent burst reaches disk while the overflow value never does',async()=>{
  const hold=gate(),entered=gate();let block=false;
  const f=await diskFolder(async path=>{if(block && path.endsWith('.json')){entered.release();await hold.promise;}});
  const changes=Array.from({length:64},(_,i)=>({key:(i+1).toString(16).padStart(64,'0'),title:'Synthetic '+i}));
  try{
    const before=f.read();block=true;
    f.pending.push(f.profile.setRoom(changes[0].key,{title:changes[0].title}));await entered.promise;
    for(const change of changes.slice(1))f.pending.push(f.profile.setRoom(change.key,{title:change.title}));
    assert.equal(f.profile.setRoom(changes[0].key,{title:'REJECTED_OVERFLOW'}),false);
    assert.equal(f.profile.snapshot().storageError,true);
    assert.equal(f.read(),before,'admission must not report or write a held change early');
    block=false;hold.release();assert.deepEqual(await Promise.all(f.pending),Array(64).fill(true));
    const raw=JSON.parse(f.read());assert.equal(raw.settings.persist,true);assert.equal(Object.keys(raw.rooms).length,64);
    for(const change of changes)assert.deepEqual(raw.rooms[change.key],{title:change.title});
    assert.equal(f.read().includes('REJECTED_OVERFLOW'),false);
    assert.equal(readdirSync(f.folder).some(name=>name.endsWith('.tmp')),false);
  }finally{await f.close(()=>hold.release());}
});

test('two initialized stores reload and merge admitted writes into one truthful account file',async()=>{
  const hold=gate(),entered=gate();let block=false;
  const f=await diskFolder(async path=>{if(block && path.endsWith('.json')){entered.release();await hold.promise;}});
  const otherRoom='b'.repeat(64);
  try{
    assert.equal(await f.profile.setRoom(room,{title:'Seed'}),true);
    const otherStore=createPreferenceStore(f.options),other=await otherStore.account('111');f.profiles.push(other);
    assert.equal(other.key().equals(f.profile.key()),true,'both stores must load the already initialized identity key');
    const before=f.read();block=true;
    f.pending.push(f.profile.setRoom(room,{muted:true}));await entered.promise;
    f.pending.push(other.setRoom(otherRoom,{title:'Other store'}),f.profile.set({notifications:true}),other.set({readSync:true}),f.profile.setRoom(room,{pinOrder:3}));
    assert.equal(f.read(),before);
    block=false;hold.release();assert.deepEqual(await Promise.all(f.pending),[true,true,true,true,true]);
    const raw=JSON.parse(f.read());
    assert.deepEqual(raw.rooms,{[room]:{title:'Seed',muted:true,pinOrder:3},[otherRoom]:{title:'Other store'}});
    assert.deepEqual(raw.settings,{persist:true,notifications:true,readSync:true,roomFilter:'all'});
    const reopened=await createPreferenceStore(f.options).account('111');f.profiles.push(reopened);
    assert.equal(reopened.snapshot().notifications,true);assert.equal(reopened.snapshot().readSync,true);
    assert.deepEqual(reopened.room(room),{title:'Seed',muted:true,pinOrder:3});
    assert.deepEqual(reopened.room(otherRoom),{title:'Other store'});
    assert.equal(readdirSync(f.folder).filter(name=>name.endsWith('.json')).length,1);
  }finally{await f.close(()=>hold.release());}
});

test('a full burst rejected by security preserves disk and releases capacity for a later durable write',async()=>{
  const hold=gate(),entered=gate();let block=false,deny=false;
  const f=await diskFolder(async path=>{
    if(!path.endsWith('.json'))return;
    if(block){entered.release();await hold.promise;}
    if(deny)throw new Error('synthetic_security_denied');
  });
  try{
    assert.equal(await f.profile.setRoom(room,{title:'Before'}),true);
    const before=f.read();block=deny=true;
    f.pending.push(f.profile.setRoom(room,{title:'Forbidden'}));await entered.promise;
    for(let i=0;i<63;i++)f.pending.push(f.profile.set({notifications:true}));
    assert.equal(f.profile.set({readSync:true}),false);
    block=false;hold.release();assert.deepEqual(await Promise.all(f.pending),Array(64).fill(false));
    assert.equal(f.read(),before);assert.deepEqual(f.profile.room(room),{title:'Before'});
    assert.equal(f.profile.snapshot().storageError,true);
    deny=false;assert.equal(await f.profile.setRoom(room,{title:'Recovered'}),true);
    const raw=JSON.parse(f.read());assert.deepEqual(raw.rooms[room],{title:'Recovered'});
    assert.equal(raw.settings.notifications,false);assert.equal(raw.settings.readSync,false);
    assert.equal(f.profile.snapshot().storageError,false);
  }finally{await f.close(()=>hold.release());}
});

test('closing during real-file verification prevents both running and queued late disk mutations',async()=>{
  const hold=gate(),entered=gate();let block=false;
  const f=await diskFolder(async path=>{if(block && path.endsWith('.json')){entered.release();await hold.promise;}});
  try{
    assert.equal(await f.profile.setRoom(room,{title:'Before close'}),true);
    const before=f.read();block=true;
    f.pending.push(f.profile.setRoom(room,{title:'Late write'}));await entered.promise;
    f.pending.push(f.profile.set({notifications:true}));f.profile.close();
    assert.equal(f.profile.set({readSync:true}),false);assert.equal(f.read(),before);
    block=false;hold.release();assert.deepEqual(await Promise.all(f.pending),[false,false]);
    assert.equal(f.read(),before,'neither held nor queued work may publish after close');
    const reopened=await createPreferenceStore(f.options).account('111');f.profiles.push(reopened);
    assert.deepEqual(reopened.room(room),{title:'Before close'});assert.equal(reopened.snapshot().notifications,false);
    assert.equal(await reopened.set({readSync:true}),true,'settled stale work must return shared queue capacity');
    assert.equal(JSON.parse(f.read()).settings.readSync,true);
    assert.equal(readdirSync(f.folder).some(name=>name.endsWith('.tmp')),false);
  }finally{await f.close(()=>hold.release());}
});
