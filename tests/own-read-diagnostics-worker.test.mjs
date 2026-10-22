// Synthetic values and in-memory transports only; no account, socket or worker process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createReaderDiagnostic} from '../experiments/local-web/reader-diagnostics.mjs';
import {createReaderStore} from '../experiments/local-web/reader-data.mjs';

const helperURL=new URL('../experiments/local-web/reader-own-read-diagnostics.mjs',import.meta.url);
const loadHelper=()=>import(helperURL.href);

test('cumulative own-read counts survive replacement of all 40 recent diagnostic events',()=>{
  let saved;
  const diagnostic=createReaderDiagnostic({writeSnapshot:value=>{saved=JSON.parse(value);}});
  try{
    assert.equal(typeof diagnostic.ownRead,'function','diagnostic must own the cumulative helper');
    for(let n=0;n<67;n++)diagnostic.ownRead('transport','received','DECUNREAD');
    for(let n=0;n<9;n++)diagnostic.ownRead('classification','invalid_position');
    for(let n=0;n<85;n++)diagnostic.note('request',{method:'PING'});
    diagnostic.flush();
    assert.equal(saved.events.length,40);
    assert.equal(saved.ownRead.counters.transport.DECUNREAD.received,67);
    assert.equal(saved.ownRead.counters.classification.invalid_position,9);
    assert.equal(saved.events.some(event=>event.method==='DECUNREAD'),false);
  }finally{diagnostic.end('synthetic-test');}
});

test('helper rejects object hooks and arbitrary labels, and returns detached snapshots',async()=>{
  const {createOwnReadDiagnostics,OWN_READ_DIAGNOSTIC_VERSION}=await loadHelper();
  assert.equal(OWN_READ_DIAGNOSTIC_VERSION,1);
  const diagnostic=createOwnReadDiagnostics();let hooks=0;
  const poison=new Proxy(Object.create(null),{get(){hooks++;throw Error('SYNTHETIC_PRIVATE_VALUE');},ownKeys(){hooks++;throw Error('SYNTHETIC_PRIVATE_VALUE');}});
  diagnostic.record(poison,poison,poison);
  diagnostic.record('transport',poison,poison);
  diagnostic.record('transport','received',poison);
  diagnostic.record('transport','received','SYNTHETIC_PRIVATE_METHOD');
  diagnostic.record('classification','SYNTHETIC_PRIVATE_REASON');
  diagnostic.record('classification','own_accepted');
  assert.equal(hooks,0);
  const first=diagnostic.snapshot();
  assert.equal(first.counters.transport.other.received,2);
  assert.equal(first.counters.classification.own_accepted,1);
  assert.equal(JSON.stringify(first).includes('SYNTHETIC_PRIVATE'),false);
  assert.equal(first.version,1);assert.equal(first.component,'worker');
  assert.equal(first.source.loadedCodeAttested,false);
  const source=structuredClone(first.source);
  first.counters.classification.own_accepted=999;
  first.source.files.injected='SYNTHETIC_PRIVATE_VALUE';
  assert.equal(diagnostic.snapshot().counters.classification.own_accepted,1);
  assert.deepEqual(diagnostic.snapshot().source,source);
  diagnostic.reset();
  assert.equal(diagnostic.snapshot().counters.classification.own_accepted,0);
  assert.deepEqual(diagnostic.snapshot().source,source);
});

test('store classification uses one fixed reason argument and isolates observer exceptions',()=>{
  const observations=[];
  const store=createReaderStore({chatDatas:[{c:'123',t:'DirectChat',ll:'100',n:3}]},'999',Buffer.alloc(32,3),null,{observeOwnRead(...args){observations.push(args);throw Error('SYNTHETIC_OBSERVER_FAULT');}});
  const read=extra=>store.readUpdate({chatId:'123',userId:'999',watermark:'101',...extra});
  try{
    assert.equal(read({chatId:'456'}),null);
    assert.equal(read({userId:0}),null);
    assert.equal(read({watermark:'-1'}),null);
    assert.equal(read({c:'456'}),null);
    assert.ok(read()?.ownRead);
    assert.equal(read(),null);
    assert.ok(read({userId:'111'}));
    assert.deepEqual(observations,[['unknown_room'],['invalid_user'],['invalid_position'],['scope_mismatch'],['own_accepted'],['stale_own'],['peer_accepted']]);
  }finally{store.clear();}
});
