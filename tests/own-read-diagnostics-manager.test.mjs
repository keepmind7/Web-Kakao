// Synthetic IPC only. The spawn seam never creates a process or connects an account.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createReadOnlyReader} from '../experiments/local-web/reader-manager.mjs';
import {createRoomState} from '../experiments/local-web/reader-room-state.mjs';

const room='r_'+'a'.repeat(24),foreign='r_'+'b'.repeat(24);
const read=extra=>({keys:[],clearInitial:false,clearEvents:false,partial:false,...extra});
function fixture(){
  const children=[],sent=[],profile={key:()=>Buffer.alloc(32,7),snapshot:()=>({persist:false,readSync:false,notifications:false,roomFilter:'all',storageAvailable:true}),room:()=>null,close(){}};
  const reader=createReadOnlyReader({messaging:true,preferenceStore:{account:()=>profile},spawn:()=>{
    const child=Object.assign(new EventEmitter(),{send(value,callback){sent.push(value);callback?.();},kill(){return true;}});children.push(child);return child;
  }});
  const publish=()=>children.at(-1).emit('message',{type:'reader-rooms',source:'loginlist',rooms:[{key:room,title:'Synthetic room',kind:'DirectChat',initialUnreadCount:3}],seedBounds:[{key:room,bound:'100'}],stats:{sourceRoomCount:1}});
  assert.equal(reader.connect({userId:'999',deviceUUID:'SYNTHETIC_DEVICE',accessToken:'SYNTHETIC_NO_ACCOUNT'}),true);publish();
  return {reader,children,sent,publish,emit:(fields,child=children.at(-1))=>child.emit('message',{type:'reader-own-read',key:room,read:read(),proof:{watermark:'99'},...fields})};
}

test('manager distinguishes invalid, unchanged, changed coverage and numeric decrease without diagnostic-only revisions',()=>{
  const f=fixture();try{
    const before=f.reader.snapshot();
    assert.ok(before.ownReadDiagnostics,'manager exposes bounded in-memory diagnostics');
    f.emit({key:foreign});
    f.emit({read:read({keys:['bad']})});
    f.emit({proof:{watermark:'-1'}}); // Existing boolean becomes true for coverage only.
    assert.equal(f.reader.rooms().rooms[0].unreadLocalCount,3);
    const coverage=f.reader.snapshot();
    assert.equal(coverage.roomsRevision,before.roomsRevision+1);
    f.emit({proof:{watermark:'99'}}); // Valid newer floor, unchanged decorated state.
    const unchanged=f.reader.snapshot();
    assert.equal(unchanged.roomsRevision,coverage.roomsRevision);
    f.emit({proof:{watermark:'98'}});
    f.emit({read:read({clearInitial:true,clearEvents:true}),proof:{watermark:'100'}});
    const after=f.reader.snapshot(),apply=after.ownReadDiagnostics.counters.apply;
    assert.equal(f.reader.rooms().rooms[0].unreadLocalCount,0);
    assert.equal(apply.received,6);assert.equal(apply.invalid_room,1);
    assert.equal(apply.invalid_payload,2);assert.equal(apply.stale_position,1);
    assert.equal(apply.unchanged,1);assert.equal(apply.changed,2);assert.equal(apply.decreased,1);
    assert.equal(after.roomsRevision,before.roomsRevision+2);
    assert.equal(after.sendRequests,0);assert.equal(f.sent.filter(row=>row.type==='reader-action').length,0);
    const text=JSON.stringify(after.ownReadDiagnostics);
    for(const value of [room,foreign,'SYNTHETIC_DEVICE','SYNTHETIC_NO_ACCOUNT','Synthetic room'])assert.equal(text.includes(value),false);
  }finally{f.reader.close();}
});

test('room-state observer preserves invalid-proof coverage change and isolates callback failures',()=>{
  const state=createRoomState(),row={key:room,title:'Synthetic',initialUnreadCount:3};
  state.bind([row],{seedBounds:[{key:room,bound:'100'}],generation:1});
  const reasons=[],observe=(...args)=>{reasons.push(args);throw Error('SYNTHETIC_OBSERVER_FAULT');};
  try{
    assert.equal(state.ownRead(room,read(),{watermark:'-1'},observe),true);
    assert.equal(state.decorate(row).unreadLocalCount,3);
    assert.equal(state.decorate(row).unreadCoverage,'partial');
    assert.equal(state.ownRead(room,read(),{watermark:'99'},observe),false);
    assert.equal(state.ownRead(room,read(),{watermark:'98'},observe),false);
    assert.equal(state.ownRead(room,read({clearInitial:true}),{watermark:'100'},observe),true);
    assert.deepEqual(reasons.slice(0,3),[['invalid_payload'],['unchanged'],['stale_position']]);
    for(const args of reasons){assert.equal(args.length,1);assert.ok(['invalid_payload','unchanged','stale_position','changed'].includes(args[0]));}
  }finally{state.clear();}
});
