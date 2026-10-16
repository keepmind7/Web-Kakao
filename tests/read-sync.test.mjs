import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createReadOnlyReader } from '../experiments/local-web/reader-manager.mjs';
import { compareReadPosition,createReaderStore } from '../experiments/local-web/reader-data.mjs';

test('read-position comparison is room-scoped, exact for 64-bit IDs and reveals no identifiers',()=>{
  const id='9007199254740993',target='900719925474099399';
  assert.deepEqual(compareReadPosition({chatInfo:{chatId:id,lastSeenLogId:'900719925474099398'}},id,target),{roomMatched:true,seenAtLeastTarget:false});
  assert.deepEqual(compareReadPosition({chatInfo:{chatId:id,lastSeenLogId:target}},id,target),{roomMatched:true,seenAtLeastTarget:true});
  assert.deepEqual(compareReadPosition({chatInfo:{chatId:'123',lastSeenLogId:target}},id,target),{roomMatched:false,seenAtLeastTarget:null});
  assert.deepEqual(compareReadPosition({chatInfo:{chatId:id}},id,target),{roomMatched:true,seenAtLeastTarget:null});
  assert.equal(compareReadPosition({chatInfo:{chatId:id,lastSeenLogId:0}},id,target).seenAtLeastTarget,false);
  assert.equal(JSON.stringify(compareReadPosition({chatInfo:{chatId:id,lastSeenLogId:target}},id,target)).includes(id),false);
});
test('a visible own reply selects the latest known incoming log at or before the visible position',()=>{
  const store=createReaderStore({chatDatas:[{c:'123',t:'DirectChat',ll:'900719925474099399'}]},'999'),key=store.rooms()[0].key;
  const push=(id,author)=>store.push({chatId:'123',chatLog:{logId:id,authorId:author,msg:'Synthetic'}})[0];
  const first=push('900719925474099397','111').messages[0].key;
  const own=push('900719925474099399','999').messages.at(-1).key;
  push('900719925474099398','111');push('900719925474099400','111');
  assert.deepEqual(store.readTargetForMessage(key,own),{logId:'900719925474099398',mine:false,requestedIsOwn:true});
  assert.deepEqual(store.readTargetForMessage(key,first),{logId:'900719925474099397',mine:false,requestedIsOwn:false});
  assert.equal(store.readTargetForMessage('r_'+'f'.repeat(24),own),null);
});

const room='r_'+'a'.repeat(24),message='m_'+'b'.repeat(24);
function fixture(){
  const sent=[],child=Object.assign(new EventEmitter(),{send(value,callback){sent.push(value);callback?.();},kill(){}});
  const reader=createReadOnlyReader({messaging:true,spawn:()=>child});
  reader.connect({userId:'999',deviceUUID:'FAKE_DEVICE',accessToken:'FAKE_TOKEN'});
  child.emit('message',{type:'reader-ready'});
  child.emit('message',{type:'reader-rooms',source:'loginlist',rooms:[{key:room,title:'Synthetic',kind:'DirectChat',canSend:true}],stats:{sourceRoomCount:1}});
  child.emit('message',{type:'reader-messages',source:'push',key:room,latestVisible:true,messages:[{key:message,text:'Synthetic',mine:false}],arrivals:[{key:message,incoming:true,afterBaseline:true,userMessage:true}]});
  return {reader,child,sent};
}

test('local seen and HTTP acceptance are separate from server read acknowledgement',()=>{
  const {reader,child,sent}=fixture();
  try{
    assert.equal(reader.seen(room,reader.messages(room).seenToken,false),true);
    assert.equal(reader.rooms().rooms[0].unreadLocalCount,0);
    assert.deepEqual(reader.messages(room).readSync,{phase:'idle'});
    assert.equal(reader.seen(room,reader.messages(room).seenToken,true),true);
    const request=sent.find(row=>row.type==='reader-action');
    assert.equal(request.action,'read');
    assert.deepEqual(reader.messages(room).readSync,{phase:'sending',messageKey:message});
    child.emit('message',{type:'reader-action',key:room,requestId:request.requestId,action:'read',phase:'accepted',status:0});
    assert.deepEqual(reader.messages(room).readSync,{phase:'accepted',messageKey:message});
    assert.equal(reader.seen(room,reader.messages(room).seenToken,true),true);
    assert.equal(sent.filter(row=>row.type==='reader-action').length,1);
  }finally{reader.close();}
});

test('disconnect before read acknowledgement never reports server acceptance',()=>{
  const {reader,sent}=fixture();
  try{
    assert.equal(reader.seen(room,reader.messages(room).seenToken,true),true);
    reader.disconnect();
    assert.deepEqual(reader.messages(room).readSync,{phase:'unknown',messageKey:message});
    assert.equal(sent.filter(row=>row.type==='reader-action').length,1);
  }finally{reader.close();}
});

test('a rejected or mismatched read result cannot acknowledge the visible message',()=>{
  for(const mismatch of [false,true]){
    const {reader,child,sent}=fixture();
    try{
      reader.seen(room,reader.messages(room).seenToken,true);
      const request=sent.find(row=>row.type==='reader-action');
      child.emit('message',{type:'reader-action',key:mismatch?'r_'+'c'.repeat(24):room,requestId:request.requestId,action:'read',phase:mismatch?'accepted':'failed',status:mismatch?0:-203});
      assert.equal(reader.messages(room).readSync.phase,mismatch?'sending':'failed');
    }finally{reader.close();}
  }
});
