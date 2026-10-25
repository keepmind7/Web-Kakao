import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createReaderSession} from '../experiments/local-web/reader-session.mjs';
import {createReaderDiagnostic} from '../experiments/local-web/reader-diagnostics.mjs';

// Break caught: decode catch discarded its exception before the worker could
// preserve safe category/frames; an observer must not alter failure semantics.
for(const throws of [false,true])test(`decode preserves only safe fault metadata with ${throws?'throwing':'normal'} observer`,async()=>{
  const events=[],faults=[];let snapshot;
  const diagnostic=createReaderDiagnostic({writeSnapshot:raw=>{snapshot=JSON.parse(raw);}});
  const bootstrap=()=>Object.assign(new EventEmitter(),{async connect(){},disconnect(){},async request(){return {status:0,body:{ticket:{lsl:['synthetic.kakao.com']},wifi:{ports:[443]}}};},async checkin(){return {status:0,host:'synthetic.kakao.com',port:443};}});
  const carriage=Object.assign(new EventEmitter(),{async connect(){},disconnect(){},stopPing(){},async loginList(){return {status:0,body:{chatDatas:[{c:'123',t:'DirectChat',title:'Synthetic',ll:'100'}]}};}});
  const session=createReaderSession({userId:'999',deviceUUID:'SYNTHETIC',accessToken:'SYNTHETIC_NO_ACCOUNT'},{booking:bootstrap,ticket:bootstrap,carriage:()=>carriage,toLong:String,resolve:async host=>host,every:()=>0,
    observeFailure:details=>{faults.push(details);diagnostic.fault(details.stage,details.fault);if(throws)throw new Error('PRIVATE_OBSERVER');},
  },event=>{events.push(event);if(event.type==='reader-failed')diagnostic.end('session-failed');});
  try{
    assert.equal((await session.start()).ok,true);
    const error=new TypeError('PRIVATE_MESSAGE');error.stack='TypeError PRIVATE_MESSAGE\n at onData (PRIVATE_URL:1)';const body={chatId:'123'};Object.defineProperty(body,'chatLog',{get(){throw error;}});
    assert.doesNotThrow(()=>carriage.emit('push',{method:'MSG',status:0,body}));
    assert.equal(faults.length,1,'decode exception must reach the safe observer');assert.deepEqual(faults[0],{stage:'decode',fault:{category:'TypeError',frames:['onData']}});
    assert.deepEqual(events.filter(event=>event.type==='reader-failed'),[{type:'reader-failed',stage:'decode',status:null}]);assert.deepEqual(snapshot.fault,{category:'TypeError',frames:['onData']});
    assert.equal(JSON.stringify({faults,snapshot}).includes('PRIVATE'),false);
  }finally{session.close();diagnostic.end('closed');}
});
