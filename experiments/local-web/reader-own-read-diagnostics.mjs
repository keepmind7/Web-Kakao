import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const OWN_READ_DIAGNOSTIC_VERSION=1;
const METHODS=['DECUNREAD','CHATINFO','UPDATECHAT','BLSYNC','other'];
const REASONS={
  transport:['received','matched','forwarded','quarantined','scoped_drop','duplicate_drop'],
  classification:['unknown_room','invalid_user','invalid_position','scope_mismatch','stale_own','own_accepted','peer_accepted'],
  session:['supported','unsupported','status_rejected','disabled'],
  handoff:['deferred','emitted','flushed'],
  apply:['received','stale_connection','invalid_room','invalid_payload','stale_position','unchanged','changed','decreased'],
};
const SOURCE_FILES={
  worker:['reader-own-read-diagnostics.mjs','reader-worker.mjs','reader-protocol.mjs','reader-session.mjs','reader-data.mjs','reader-diagnostics.mjs'],
  manager:['reader-own-read-diagnostics.mjs','reader-manager.mjs','reader-room-state.mjs'],
};
const empty=names=>Object.fromEntries(names.map(name=>[name,0]));
const counters=()=>Object.fromEntries(Object.entries(REASONS).map(([stage,reasons])=>[
  stage,stage==='transport'?Object.fromEntries(METHODS.map(method=>[method,empty(reasons)])):empty(reasons),
]));

export function createOwnReadDiagnostics({component='worker'}={}){
  component=component==='manager'?'manager':'worker';
  const files=Object.fromEntries(SOURCE_FILES[component].map(name=>{
    let hash=null;
    try{hash=createHash('sha256').update(readFileSync(new URL(name,import.meta.url))).digest('hex');}catch{/* Public source unavailable; retain no path or exception. */}
    return [name,hash];
  }));
  const source={capturedAt:Date.now(),loadedCodeAttested:false,files};
  let counts=counters();
  return {
    record(stage,reason,method){
      // Primitive membership checks never inspect caller objects or hooks.
      if(typeof stage!=='string' || !Object.hasOwn(REASONS,stage) || typeof reason!=='string' || !REASONS[stage].includes(reason))return;
      const bucket=stage==='transport'?counts.transport[typeof method==='string' && METHODS.includes(method)?method:'other']:counts[stage];
      bucket[reason]=Math.min(Number.MAX_SAFE_INTEGER,bucket[reason]+1);
    },
    snapshot:()=>structuredClone({version:OWN_READ_DIAGNOSTIC_VERSION,component,source,counters:counts}),
    reset(){counts=counters();},
  };
}
