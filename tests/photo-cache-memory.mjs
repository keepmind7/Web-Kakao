// Manual, account-free memory profile. Run the bundled Node with --expose-gc.
import {performance} from 'node:perf_hooks';
import {createPhotoCache} from '../experiments/local-web/photos.mjs';

if(typeof globalThis.gc!=='function')throw new Error('Run with --expose-gc');
const sample=()=>{for(let n=0;n<3;n++)globalThis.gc();return process.memoryUsage();};
const delta=(after,before)=>Object.fromEntries(['heapUsed','external','arrayBuffers'].map(key=>[key,after[key]-before[key]]));
let fetches=0;
const cache=createPhotoCache({fetcher:async()=>{fetches++;return {data:Buffer.alloc(70),type:'image/png'};}});
try{
  // Warm the same allocation path before measuring a long small-photo history.
  for(let n=0;n<1000;n++)await cache.get('warm:'+n);
  cache.clear();fetches=0;
  const before=sample(),start=performance.now();
  for(let n=0;n<20000;n++){
    const url='https://synthetic.kakaocdn.net/'+n+'/'+Buffer.alloc(3500,65+n%26).toString();
    await cache.get(url);
  }
  const elapsedMs=performance.now()-start,retained=sample();
  // Revisit the earliest photo to observe eviction without exposing internals.
  const prior=fetches;
  await cache.get('https://synthetic.kakaocdn.net/0/'+Buffer.alloc(3500,65).toString());
  const oldestRefetched=fetches>prior;
  cache.clear();const cleared=sample();
  console.log(JSON.stringify({actualAccountUsed:false,photos:20000,payloadBytes:70,urlPaddingBytes:3500,
    elapsedMs:Math.round(elapsedMs),retainedDeltaBytes:delta(retained,before),
    clearedDeltaBytes:delta(cleared,before),oldestRefetched},null,2));
}finally{cache.clear();}
