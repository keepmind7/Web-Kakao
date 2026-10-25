// Account-free cache lifecycle regressions; the fetcher never opens a socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhotoCache} from '../experiments/local-web/photos.mjs';

const photo=byte=>({data:Buffer.alloc(70,byte),type:'image/png'});
const deferred=()=>{
  let resolve,reject;
  const promise=new Promise((accept,fail)=>{resolve=accept;reject=fail;});
  return {promise,resolve,reject};
};
function controlledCache({ignoreAbort=false}={}){
  const calls=[],requests=[],starts=[];
  const cache=createPhotoCache({fetcher:(url,{signal})=>{
    const gate=deferred(),call={url,signal,...gate};calls.push(call);
    for(const waiter of starts)if(calls.length>=waiter.count)waiter.resolve(calls[waiter.count-1]);
    const abort=()=>gate.reject(new Error('photo_unavailable'));
    if(!ignoreAbort)signal.addEventListener('abort',abort,{once:true});
    return gate.promise.finally(()=>signal.removeEventListener('abort',abort));
  }});
  return {cache,calls,
    get(url){const request=cache.get(url);requests.push(request);request.catch(()=>{});return request;},
    started(count){if(calls.length>=count)return Promise.resolve(calls[count-1]);const gate=deferred();starts.push({count,resolve:gate.resolve});return gate.promise;},
    async close(){cache.clear();for(const call of calls)call.resolve(photo(0));await Promise.allSettled(requests);},
  };
}

test('small-photo history evicts old entries while recently viewed photos remain cached',async()=>{
  const calls=new Map(),cache=createPhotoCache({fetcher:async url=>{
    calls.set(url,(calls.get(url)||0)+1);return {data:Buffer.alloc(70),type:'image/png'};
  }});
  try{
    for(let n=0;n<512;n++)await cache.get('synthetic:'+n);
    await cache.get('synthetic:0'); // Make the oldest photo recent again.
    await cache.get('synthetic:512');
    await cache.get('synthetic:0');
    assert.equal(calls.get('synthetic:0'),1,'recent photos must survive eviction');
    await cache.get('synthetic:1');
    assert.equal(calls.get('synthetic:1'),2,'tiny payloads must not retain unlimited URL/object entries');
  }finally{cache.clear();}
});

test('a synchronous photo fetch failure releases its pending entry and allows a later request',async()=>{
  let unavailable=true,calls=0;
  const cache=createPhotoCache({fetcher:()=>{
    calls++;if(unavailable)throw new Error('synthetic_unavailable');
    return {data:Buffer.alloc(70),type:'image/png'};
  }});
  try{
    await assert.rejects(cache.get('synthetic:retry'),/synthetic_unavailable/);
    unavailable=false;
    assert.equal((await cache.get('synthetic:retry')).type,'image/png');
    assert.equal(calls,2);
  }finally{cache.clear();}
});

test('synchronous failures cannot fill all pending slots and permanently block different photos',async()=>{
  const cache=createPhotoCache({fetcher:url=>{
    if(url!=='synthetic:healthy')throw new Error('synthetic_unavailable');
    return {data:Buffer.alloc(70),type:'image/png'};
  }});
  try{
    for(let n=0;n<40;n++)await assert.rejects(cache.get('synthetic:failed:'+n),/synthetic_unavailable/);
    assert.equal((await cache.get('synthetic:healthy')).type,'image/png');
  }finally{cache.clear();}
});

test('forty pending photos share active and queued duplicates, reject the forty-first and release one slot', {timeout:5000},async()=>{
  const f=controlledCache();
  try{
    // The forty pending entries include four active fetches and thirty-six queued.
    const requests=Array.from({length:40},(_,n)=>f.get('synthetic:'+n));
    assert.deepEqual(f.calls.map(call=>call.url),['synthetic:0','synthetic:1','synthetic:2','synthetic:3']);
    const activeDuplicate=f.get('synthetic:0'),queuedDuplicate=f.get('synthetic:4');
    await assert.rejects(f.get('synthetic:40'),/photo_busy/);
    assert.equal(f.calls.length,4,'duplicates and rejected work cannot start another fetch');
    const first=photo(1);f.calls[0].resolve(first);
    assert.strictEqual(await requests[0],first);assert.strictEqual(await activeDuplicate,first);
    let retryState='pending';
    f.get('synthetic:40').then(()=>{retryState='resolved';},()=>{retryState='rejected';});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(retryState,'pending','a completed request must free admission capacity for the previously refused URL');
    const fifth=await f.started(5);assert.equal(fifth.url,'synthetic:4');assert.equal(f.calls.length,5,'one released slot starts exactly one queued fetch');
    const queued=photo(2);fifth.resolve(queued);
    assert.strictEqual(await requests[4],queued);assert.strictEqual(await queuedDuplicate,queued);
    assert.equal((await f.started(6)).url,'synthetic:5');assert.equal(f.calls.length,6);
  }finally{await f.close();}
});

test('clear aborts four active photos and rejects queued work without starting its fetchers', {timeout:5000},async()=>{
  const f=controlledCache();
  try{
    const requests=Array.from({length:40},(_,n)=>f.get('synthetic:clear:'+n));
    assert.equal(f.calls.length,4);
    f.cache.clear();
    assert.equal(f.calls.every(call=>call.signal.aborted),true,'all active fetches receive cancellation');
    const results=await Promise.allSettled(requests);
    assert.equal(results.length,40);for(const result of results){assert.equal(result.status,'rejected');assert.match(result.reason.message,/photo_unavailable/);}
    assert.equal(f.calls.length,4,'cleared queued work must never reach the fetcher');
    const fresh=f.get('synthetic:clear:39'),item=photo(3);
    assert.equal(f.calls.length,5);assert.equal(f.calls[4].signal.aborted,false);
    f.calls[4].resolve(item);assert.strictEqual(await fresh,item);
    assert.strictEqual(await f.get('synthetic:clear:39'),item);assert.equal(f.calls.length,5);
  }finally{await f.close();}
});

test('late old fetch cannot delete the same URL pending in a new epoch', {timeout:5000},async()=>{
  const f=controlledCache({ignoreAbort:true}),url='synthetic:shared-epoch';
  try{
    const old=f.get(url);f.cache.clear();assert.equal(f.calls[0].signal.aborted,true);
    const fresh=f.get(url);assert.equal(f.calls.length,2);
    const rejected=assert.rejects(old,/photo_unavailable/);f.calls[0].resolve(photo(4));await rejected;
    const duplicate=f.get(url);assert.equal(f.calls.length,2,'old cleanup must not remove the new pending entry');
    const item=photo(5);f.calls[1].resolve(item);
    assert.strictEqual(await fresh,item);assert.strictEqual(await duplicate,item);
    assert.strictEqual(await f.get(url),item);assert.equal(f.calls.length,2);
  }finally{await f.close();}
});

test('late old success cannot overwrite an already cached photo from the new epoch', {timeout:5000},async()=>{
  const f=controlledCache({ignoreAbort:true}),url='synthetic:cached-epoch';
  try{
    const old=f.get(url);f.cache.clear();const fresh=f.get(url),item=photo(6);
    f.calls[1].resolve(item);assert.strictEqual(await fresh,item);
    assert.strictEqual(await f.get(url),item);
    const rejected=assert.rejects(old,/photo_unavailable/);f.calls[0].resolve(photo(7));await rejected;
    assert.strictEqual(await f.get(url),item,'stale bytes must not replace the current cached item');
    assert.equal(f.calls.length,2);
  }finally{await f.close();}
});
