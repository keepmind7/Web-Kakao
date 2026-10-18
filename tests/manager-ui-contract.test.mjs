// In-memory fake worker only: no SDK socket, real account, worker process or preference files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createReadOnlyReader } from '../experiments/local-web/reader-manager.mjs';

const credential={userId:'999',accessToken:'SYNTHETIC_NO_LOGIN',deviceUUID:'SYNTHETIC_DEVICE'};
const keyA='r_'+'a'.repeat(24),keyB='r_'+'b'.repeat(24),msg=n=>'m_'+String(n).padStart(24,'0');
const row=key=>({key,kind:'DirectChat',title:'synthetic',canText:true,canReply:true,canPhoto:true,canRead:true,canContext:true});
const preferenceStore={account:()=>({key:()=>Buffer.alloc(32),snapshot:()=>({notifications:false}),room:()=>null,set:()=>false,setRoom:()=>false,forget:()=>false,close(){}})};
function fixture(){
  let clock=1_000_000;const sent=[];
  const child=Object.assign(new EventEmitter(),{send(value,callback){sent.push(value);callback?.();},kill(){return true;}});
  const reader=createReadOnlyReader({messaging:true,spawn:()=>child,now:()=>clock,preferenceStore});
  assert.equal(reader.connect(credential),true);
  child.emit('message',{type:'reader-rooms',source:'loginlist',rooms:[row(keyA),row(keyB)],stats:{sourceRoomCount:2}});
  assert.equal(reader.snapshot().phase,'connected');
  const answer=()=>{const action=sent.findLast(value=>value.type==='reader-action');child.emit('message',{type:'reader-action',key:action.key,requestId:action.requestId,action:action.action,phase:'accepted',entryPhase:'acknowledged'});};
  return {reader,child,sent,answer,advance:ms=>{clock+=ms;},now:()=>clock};
}

test('reader-alive is exposed as lastActivityAt with the server clock',()=>{
  const f=fixture();
  assert.equal(f.reader.snapshot().lastActivityAt,null);
  f.advance(5000);f.child.emit('message',{type:'reader-alive',at:123});
  const snap=f.reader.snapshot();
  assert.equal(snap.lastActivityAt,f.now());assert.equal(snap.serverNow,f.now());
});

test('automatic room entries are capped at 12 per minute, then recover',()=>{
  const f=fixture(),contexts=()=>f.sent.filter(value=>value.type==='reader-action' && value.action==='context').length;
  for(let i=0;i<12;i++){assert.equal(f.reader.openRoom(i%2?keyB:keyA),true);f.answer();}
  assert.equal(contexts(),12);
  // 13th switch (back to A) is refused; re-opening the already entered room sends nothing.
  assert.equal(f.reader.openRoom(keyA),false);
  assert.equal(f.reader.openRoom(keyB),true);
  assert.equal(contexts(),12);
  f.advance(61000);
  assert.equal(f.reader.openRoom(keyB),true);
});

test('reply verification flag survives the manager boundary',()=>{
  const f=fixture();
  f.child.emit('message',{type:'reader-messages',source:'push',key:keyA,arrivals:[],messages:[
    {key:msg(1),text:'a',sender:'상대',reply:{text:'quoted',sender:'원본 확인 불가',verified:false}},
    {key:msg(2),text:'b',sender:'상대',reply:{text:'quoted',sender:'친구',verified:true}},
    {key:msg(3),text:'c',sender:'상대',reply:{text:'quoted',sender:'친구',verified:'yes'}}]});
  const replies=f.reader.messages(keyA).messages.map(message=>message.reply.verified);
  assert.deepEqual(replies,[false,true,false]);
});

test('a truncated discovery replay marks the room unread count as partial',()=>{
  const f=fixture();
  const coverage=()=>f.reader.rooms().rooms.find(room=>room.key===keyA).unreadCoverage;
  assert.equal(coverage(),'observed');
  f.child.emit('message',{type:'reader-messages',source:'push',key:keyA,arrivals:[],partial:true,messages:[{key:msg(1),text:'a',sender:'상대'}]});
  assert.equal(coverage(),'partial');
});
