import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomState } from '../experiments/local-web/reader-room-state.mjs';
import { createReadOnlyReader } from '../experiments/local-web/reader-manager.mjs';
import { EventEmitter } from 'node:events';

const room=n=>'r_'+n.toString(16).padStart(24,'0');
const message=n=>'m_'+n.toString(16).padStart(24,'0');
const incoming=n=>({key:message(n),incoming:true,afterBaseline:true,userMessage:true});
const seed=(n,count=0)=>({key:room(n),title:'Synthetic',initialUnreadCount:count,initialUnreadCoverage:'observed'});

test('a replacement current snapshot takes priority over 500 historical room states',()=>{
  const state=createRoomState();state.bind(Array.from({length:500},(_,index)=>seed(index+1)));
  state.bind([seed(501,7)],{reconnect:true,generation:2});
  assert.equal(state.decorate(seed(501)).unreadLocalCount,7);
  assert.equal(state.rename(room(501),'Synthetic alias'),true);
  assert.equal(state.rename(room(1),'Removed alias'),false);
});

test('remaining rooms retain unread dedupe aliases and seen sequence across snapshot replacement',()=>{
  const state=createRoomState();state.bind([seed(1),seed(2)]);
  state.rename(room(1),'Synthetic alias');state.receive(room(1),[incoming(1)]);
  const token=state.issue(room(1),message(1));state.receive(room(1),[incoming(2)]);
  state.bind([seed(1),seed(3)]);state.receive(room(1),[incoming(1)]);
  assert.equal(state.decorate(seed(1)).unreadLocalCount,2);
  assert.equal(state.decorate(seed(1)).title,'Synthetic alias');
  assert.deepEqual(state.seen(room(1),token),{message:message(1)});
  assert.equal(state.decorate(seed(1)).unreadLocalCount,1);
});

test('retiring a room releases ledger capacity notices and tokens without forgetting replay evidence',()=>{
  const state=createRoomState({totalLimit:1});state.bind([seed(1)]);state.notifications(true);
  state.receive(room(1),[incoming(1)]);const retired=state.issue(room(1),message(1));
  state.bind([seed(2)]);
  assert.equal(state.hasToken(retired),false);assert.deepEqual(state.claim(),[]);
  state.receive(room(2),[incoming(2)]);assert.equal(state.decorate(seed(2)).unreadLocalCount,1);
  state.bind([seed(1)]);state.receive(room(1),[incoming(1)]);
  assert.equal(state.decorate(seed(1)).unreadLocalCount,0,'a retired replay cannot become a new unread arrival');
  assert.equal(state.decorate(seed(1)).unreadCoverage,'partial');
});

test('the manager seeds a new room after reconnecting from a full earlier snapshot',()=>{
  const children=[],reader=createReadOnlyReader({messaging:true,spawn:()=>{
    const child=Object.assign(new EventEmitter(),{send(value,callback){callback?.();},kill(){}});children.push(child);return child;
  }});
  const credential={userId:'999',deviceUUID:'SYNTHETIC',accessToken:'SYNTHETIC_NO_ACCOUNT'};
  const ready=rows=>{const child=children.at(-1);child.emit('message',{type:'reader-ready'});child.emit('message',{type:'reader-rooms',source:'loginlist',rooms:rows.map(row=>({...row,kind:'DirectChat',canSend:true})),stats:{sourceRoomCount:rows.length}});};
  try{
    assert.equal(reader.connect(credential),true);ready(Array.from({length:500},(_,index)=>seed(index+1)));
    reader.disconnect();assert.equal(reader.connect(credential),true);ready([seed(501,7)]);
    assert.equal(reader.rooms().rooms[0].unreadLocalCount,7);assert.equal(reader.rename(room(501),'Synthetic alias'),true);
  }finally{reader.close();}
});

test('retiring a manager room releases its pending history without admitting the late result',()=>{
  const sent=[],child=Object.assign(new EventEmitter(),{send(value,callback){sent.push(value);callback?.();},kill(){}});
  const reader=createReadOnlyReader({messaging:true,spawn:()=>child});
  const publish=(source,rows)=>child.emit('message',{type:'reader-rooms',source,rooms:rows.map(row=>({...row,kind:'DirectChat',canSend:true})),stats:{sourceRoomCount:rows.length}});
  try{
    reader.connect({userId:'999',deviceUUID:'SYNTHETIC',accessToken:'SYNTHETIC_NO_ACCOUNT'});child.emit('message',{type:'reader-ready'});publish('loginlist',[seed(1)]);
    assert.equal(reader.history(room(1)),true);const request=sent.at(-1);
    publish('push',[seed(2)]);assert.equal(reader.snapshot().operationBusy,false);
    child.emit('message',{type:'reader-messages',source:'history',key:room(1),requestId:request.requestId,messages:[{key:message(1),text:'Synthetic retired'}],fieldPresent:true,receivedCount:1,acceptedCount:1});
    assert.equal(reader.messages(room(1)),null);assert.equal(reader.history(room(2)),true);assert.equal(reader.snapshot().phase,'connected');
  }finally{reader.close();}
});
