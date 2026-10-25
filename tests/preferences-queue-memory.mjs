// Account-free allocation measurement. The injected held check never creates
// storage, and the profile closes before it is released. JSON goes to stdout.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createPreferenceStore } from '../experiments/local-web/preferences.mjs';

if(typeof global.gc!=='function')throw new Error('Run with --expose-gc');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const samples=async()=>{
  const result=[];
  for(let i=0;i<3;i++){global.gc();await turn();result.push(process.memoryUsage().heapUsed);}
  return result;
};
const calls=10000,folder=join(tmpdir(),'web-kakao-queue-memory-no-write-'+randomUUID());
if(existsSync(folder))throw new Error('synthetic_path_collision');
let release,entered,finish;
const hold=new Promise(resolve=>release=resolve),entry=new Promise(resolve=>entered=resolve),drained=new Promise(resolve=>finish=resolve);
const store=createPreferenceStore({folder,asyncSecurity:true,secureFolder:()=>{entered();return hold;},verifyFile:async()=>true});
const profile=await store.account('999');
let settled=0,accepted=0,rejected=0,immediateRejected=0;
const record=value=>{settled++;if(value===true)accepted++;else rejected++;if(settled===calls)finish();};
const track=value=>{if(value===false){immediateRejected++;record(false);}else void Promise.resolve(value).then(record,()=>record(false));};
track(profile.set({persist:true}));await entry;
const baselineGc3=await samples();
for(let i=1;i<calls;i++)track(profile.set({notifications:i%2===0}));
await turn();
const queuedGc3=await samples(),atHold={settled,pending:calls-settled,immediateRejected};
profile.close();await turn();
const afterClose={settled,pending:calls-settled};
release();await drained;await turn();
const drainedGc3=await samples();
console.log(JSON.stringify({schemaVersion:1,node:process.version,calls,security:'injected held secureFolder; closed before release',
  atHold,afterClose,final:{settled,accepted,rejected},baselineGc3,queuedGc3,drainedGc3,
  retainedHeapDeltaBytes:queuedGc3.at(-1)-baselineGc3.at(-1),heapRecoveredBytes:queuedGc3.at(-1)-drainedGc3.at(-1),filesCreated:existsSync(folder)},null,2));
