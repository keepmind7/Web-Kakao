import test from 'node:test';
import assert from 'node:assert/strict';
import { createReaderStore } from '../experiments/local-web/reader-data.mjs';

const room=row=>createReaderStore({chatDatas:[{c:'123',t:'DirectChat',...row}]},'999').rooms()[0];
test('empty earlier title fields do not hide a later supplied title',()=>{
  assert.equal(room({title:'',roomName:'실제 이름'}).title,'실제 이름');
  assert.equal(room({title:'  ',name:'다른 이름'}).title,'다른 이름');
  assert.equal(room({meta:{title:'',name:'개인 이름'}}).title,'개인 이름');
});
test('title metadata preserves literal titles while malformed JSON cannot become a room name',()=>{
  assert.equal(room({chatMetas:[{type:1,content:'공지'}, {type:3,content:'123'}]}).title,'123');
  assert.equal(room({meta:'{"name":'}).titleKnown,false);
  assert.equal(room({chatMetas:[{type:3,content:'"인용 이름"'}]}).title,'인용 이름');
  assert.equal(room({chatMetas:[{type:3,content:' '},{type:3,content:'정상 이름'}]}).title,'정상 이름');
});
test('member fallback uses a nonempty name and excludes only explicitly identified self',()=>{
  assert.equal(room({displayMembers:[{userId:'999',nickName:'본인'},{userId:'111',nickName:'',profileName:'상대'}]}).title,'상대');
  assert.equal(room({i:['999','111'],k:['본인','상대']} ).title,'상대');
  assert.equal(room({k:['식별 불가 이름']} ).title,'식별 불가 이름');
});
test('metadata parsing is bounded and does not enable an unsupported room kind',()=>{
  const meta='x'.repeat(8193);
  assert.equal(room({meta}).titleKnown,false);
  for(const kind of ['OM','OD','OpenChat','SecretChat','unknown']){
    const result=room({t:kind,meta:{name:'합성 이름'}});assert.equal(result.canSend,false);
    assert.equal(Object.hasOwn(result,'serverRoomId'),false);
  }
});
