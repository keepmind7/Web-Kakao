import test from 'node:test';
import assert from 'node:assert/strict';
import {createReaderStore} from '../experiments/local-web/reader-data.mjs';

const own='999',peer='111',roomId='123';
function fixture(extra={}){
  // Observe the actual store's private Maps without adding a product test API.
  // Restoration is synchronous, before any test can yield to another callback.
  const Original=globalThis.Map,maps=[];let store;
  globalThis.Map=class extends Original{constructor(...args){super(...args);maps.push(this);}};
  try{store=createReaderStore({chatDatas:[{c:roomId,t:'MultiChat',ll:'100',n:3,...extra}]},own);}
  finally{globalThis.Map=Original;}
  const room=maps.flatMap(map=>[...map.values()]).find(value=>value?.serverRoomId===roomId);
  assert.ok(room);return {store,room,key:store.rooms()[0].key};
}
const read=(store,user,mark='101')=>store.readUpdate({chatId:roomId,userId:user,watermark:mark});
const push=(store,id,author=own)=>store.push({chatId:roomId,chatLog:{logId:String(id),authorId:author,type:1,msg:'Synthetic'}})[0];
const snapshot=(store,key,peers,marks=peers.map(()=>'0'))=>store.receiptSnapshot(key,{c:roomId,mi:[own,...peers],a:peers,w:marks});
const count=({store,key})=>store.current(key).messages.at(-1).unreadCount;
function flood(store){for(let n=0;n<20000;n++)read(store,String(10000+n));}

test('unverified roster never retains 20000 distinct peer marks or invents exact counts',()=>{
  const f=fixture();try{
    push(f.store,101);flood(f.store);
    assert.equal(f.room.watermarks.size,0);assert.equal(count(f),null);
    assert.equal(f.room.receiptReady,false);
    assert.equal(snapshot(f.store,f.key,[peer]),true);
    assert.equal(f.room.watermarks.size,1);assert.equal(count(f),1);
  }finally{f.store.clear();}
});

test('verified peers remain monotone and unknown peers invalidate counts without retention',()=>{
  const f=fixture({a:2});try{
    push(f.store,101);assert.equal(snapshot(f.store,f.key,[peer]),true);
    read(f.store,peer);assert.equal(count(f),0);
    read(f.store,peer,'100');assert.equal(count(f),0);
    flood(f.store);assert.equal(f.room.watermarks.size,1);assert.equal(count(f),null);
    read(f.store,peer,'102');assert.equal(f.room.watermarks.get(peer),'102');
    assert.equal(count(f),null,'a known peer update cannot repair an unverified roster');
    assert.equal(snapshot(f.store,f.key,[peer],['102']),true);assert.equal(count(f),0);
  }finally{f.store.clear();}
});

test('100-peer boundary remains bounded and oversized roster leaves receipt counts unknown',()=>{
  const peers=Array.from({length:100},(_,n)=>String(1000+n)),f=fixture({a:101});try{
    push(f.store,101);
    assert.equal(f.store.receiptSnapshot(f.key,{c:roomId,mi:peers,a:peers,w:peers.map(()=>'0')}),true);
    assert.equal(f.room.watermarks.size,100);assert.equal(count(f),100);
    read(f.store,peers[0]);assert.equal(count(f),99);
    assert.equal(f.store.receiptSnapshot(f.key,{c:roomId,mi:[own,...peers],a:peers,w:peers.map(()=>'0')}),false);
    flood(f.store);assert.equal(f.room.watermarks.size,100);assert.equal(count(f),null);
    const large=fixture({a:1500});try{
      push(large.store,101);assert.equal(snapshot(large.store,large.key,peers),false);
      flood(large.store);assert.equal(large.room.watermarks.size,0);assert.equal(count(large),null);
    }finally{large.store.clear();}
  }finally{f.store.clear();}
});

test('membership replacement discards departed peers and never restores readiness from stale updates',()=>{
  const f=fixture({a:2});try{
    push(f.store,101);assert.equal(snapshot(f.store,f.key,[peer]),true);
    const version=f.store.receiptVersion(f.key);f.store.invalidateReceipts({c:roomId});
    assert.equal(snapshot(f.store,f.key,['222']),true);
    assert.equal(f.room.watermarks.has(peer),false);assert.equal(count(f),1);
    assert.equal(f.store.receiptSnapshot(f.key,{c:roomId,mi:[own,peer],a:[peer],w:['101']},version),false);
    assert.equal(count(f),1,'a superseded snapshot must not invalidate the current snapshot');
    read(f.store,peer);assert.equal(f.room.watermarks.has(peer),false);assert.equal(count(f),null);
    read(f.store,'222');assert.equal(f.room.watermarks.get('222'),'101');assert.equal(count(f),null);
    assert.equal(snapshot(f.store,f.key,['222'],['101']),true);assert.equal(count(f),0);
  }finally{f.store.clear();}
});

test('peer flooding preserves deferred own-read handoff, partial state and later arrivals',()=>{
  const f=fixture({a:1500});try{
    const first=push(f.store,101,peer),later=push(f.store,103,peer);flood(f.store);
    const deferred=f.store.readUpdate({chatId:roomId,userId:own,watermark:'99'},{deferOwnRead:true});
    assert.equal(deferred.ownRead.partial,true);assert.equal(deferred.ownRead.clearInitial,false);
    const partial=read(f.store,own,'101');
    assert.deepEqual(partial.ownRead.keys,[first.arrivals[0].key]);assert.equal(partial.ownRead.clearEvents,false);
    assert.equal(partial.ownRead.partial,false);assert.equal(f.room.watermarks.size,0);
    const newest=read(f.store,own,'103');assert.deepEqual(newest.ownRead.keys,[later.arrivals[0].key]);
    assert.equal(newest.ownRead.clearInitial,true);assert.equal(newest.ownRead.clearEvents,true);
    assert.equal(read(f.store,own,'102'),null);assert.equal(f.store.ownReadProof(f.key).watermark,'103');
    assert.equal(f.store.flushOwnRead(f.key),null);assert.equal(count(f),null);
    const replay=push(f.store,102,peer);assert.equal(replay.arrivals[0].afterBaseline,false);
    const next=push(f.store,104,peer);assert.equal(next.arrivals[0].afterBaseline,true);
    assert.deepEqual(read(f.store,own,'104').ownRead.keys,[next.arrivals[0].key]);
  }finally{f.store.clear();}
});
