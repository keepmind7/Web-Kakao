import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createReaderStore, CACHE_LIMIT, MESSAGE_LIMIT } from '../experiments/local-web/reader-data.mjs';

const ownUserId='8888888888888888888';
const firstLogId=9007199254740993n;
const roomId=index=>String(9907199254740993n+BigInt(index));
const roomsBody=count=>({chats:Array.from({length:count},(_,index)=>({chatId:roomId(index)}))});
const logsFor=(room,start,count)=>Array.from({length:count},(_,index)=>({
  logId:String(firstLogId+BigInt(start+index)),
  authorId:String(20000+room*500+start+index),
  msg:'모의 메시지 '+(start+index),
}));

test('별칭 전체 상한은 캐시 퇴출 후 복구되고 방별 번호는 독립적으로 유지된다',()=>{
  const store=createReaderStore(roomsBody(CACHE_LIMIT+1),ownUserId);
  const keys=store.rooms().map(room=>room.key);
  for(let room=0;room<CACHE_LIMIT;room++){
    store.history(keys[room],{chatLogs:logsFor(room,0,125)});
    const result=store.history(keys[room],{chatLogs:logsFor(room,125,125)});
    assert.equal(result.messages.length,MESSAGE_LIMIT);
    assert.equal(result.messages.at(-1).sender,'참여자 250');
  }
  const extra={logId:String(firstLogId+300n),authorId:'9111111111111111111',msg:'상한 이후 모의 메시지'};
  assert.equal(store.history(keys[0],{chatLogs:[extra]}).messages.at(-1).sender,'작성자 미확인');

  // 새 방을 캐시에 넣으면 가장 오래 사용하지 않은 방의 별칭도 해제된다.
  assert.equal(store.history(keys[CACHE_LIMIT],{chatLogs:logsFor(CACHE_LIMIT,0,1)}).messages[0].sender,'참여자 1');
  assert.equal(store.history(keys[0],{chatLogs:[extra]}).messages.at(-1).sender,'참여자 251');
  const restored=store.history(keys[1],{chatLogs:logsFor(1,0,1)});
  assert.equal(restored.messages.length,1);
  assert.equal(restored.messages[0].sender,'참여자 1');
});

test('대량 별칭과 반복 push에서도 정밀도·최신 50개·중복 갱신·비공개 ID 경계가 유지된다',context=>{
  const store=createReaderStore(roomsBody(CACHE_LIMIT),ownUserId);
  const rooms=store.rooms(),lastLogId=String(firstLogId+199n),messageKeys=new Map();
  const started=performance.now();
  for(let room=0;room<CACHE_LIMIT;room++){
    const result=store.history(rooms[room].key,{chatLogs:logsFor(room,0,200)});
    assert.deepEqual(result.messages.map(message=>message.text),Array.from({length:MESSAGE_LIMIT},(_,index)=>'모의 메시지 '+(150+index)));
    messageKeys.set(rooms[room].key,result.messages.at(-1).key);
  }
  for(let index=0;index<4000;index++){
    const room=index%CACHE_LIMIT;
    const updates=store.push({chatId:roomId(room),chatLog:{
      logId:lastLogId,authorId:String(20000+room*500+199),msg:'모의 갱신 '+index,
    }});
    assert.equal(updates.length,1);
    assert.equal(updates[0].messages.length,MESSAGE_LIMIT);
    assert.equal(updates[0].messages.at(-1).key,messageKeys.get(rooms[room].key));
    assert.equal(updates[0].messages.at(-1).text,'모의 갱신 '+index);
    assert.equal(updates[0].messages.at(-1).sender,'참여자 200');
  }
  assert.equal(store.stats().duplicates,4000);
  for(const room of rooms){
    const result=store.history(room.key,{chatLogs:[]});
    const serialized=JSON.stringify(result);
    assert.equal(serialized.includes(roomId(0)),false);
    assert.equal(serialized.includes(lastLogId),false);
    assert.equal(serialized.includes(ownUserId),false);
  }
  // 실행 시간은 비교 자료로만 출력하고 머신 속도에 의존하는 통과 기준은 두지 않는다.
  context.diagnostic('모의 4,000개 별칭·4,000회 중복 push: '+Math.round(performance.now()-started)+'ms');
});

test('반복된 잘못된 방·부정확한 ID는 별칭과 메시지 캐시를 오염시키지 않는다',()=>{
  const store=createReaderStore(roomsBody(2),ownUserId),key=store.rooms()[0].key;
  const invalid=Array.from({length:200},(_,index)=>({
    logId:index%2?Number(firstLogId):String(firstLogId+BigInt(index)),
    chatId:index%2?roomId(0):roomId(1),authorId:String(30000+index),msg:'거절될 모의 메시지',
  }));
  const rejected=store.history(key,{chatLogs:invalid},{requireRoomId:true});
  assert.equal(rejected.acceptedCount,0);
  assert.equal(rejected.rejectedCount,200);
  assert.deepEqual(rejected.messages,[]);
  assert.equal(store.historyCursor(key,{chatLogs:invalid},{requireRoomId:true}),null);
  const accepted=store.history(key,{chatLogs:[{...logsFor(0,0,1)[0],chatId:roomId(0)}]},{requireRoomId:true});
  assert.equal(accepted.messages[0].sender,'참여자 1');
  assert.deepEqual(store.push({chatId:roomId(0),chatLog:{...logsFor(0,1,1)[0],chatId:roomId(1)}}),[]);
  assert.equal(store.history(key,{chatLogs:[]}).messages.length,1);
  store.clear();
  assert.deepEqual(store.rooms(),[]);
  assert.equal(store.has(key),false);
});
