import { randomBytes,createHash } from 'node:crypto';
import { roomKeyValid,ROOM_LIMIT,initialUnreadState } from './reader-data.mjs';

const messageKey=value=>typeof value==='string' && /^m_[a-f0-9]{24}$/.test(value);
const position=value=>typeof value==='string' && /^(?:0|[1-9]\d{0,18})$/.test(value) && BigInt(value)<=9223372036854775807n;
const shape=(value,fields)=>value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===fields.length && fields.every(field=>Object.hasOwn(value,field));
function seedProof(rows,proof){
  if(proof===undefined)return undefined;
  if(!Array.isArray(proof) || proof.length>ROOM_LIMIT)return null;
  const known=new Set(rows.map(row=>row.key)),result=new Map();
  for(const item of proof){if(!shape(item,['key','bound']) || !roomKeyValid(item.key) || !known.has(item.key) || result.has(item.key) || item.bound!==null && !position(item.bound))return null;result.set(item.key,item.bound);}
  return result;
}
function arrivalPositions(arrivals,proof){
  if(proof===undefined)return undefined;
  if(!Array.isArray(proof) || proof.length>200)return null;
  const keys=new Set((Array.isArray(arrivals)?arrivals:[]).slice(0,200).map(item=>item?.key)),result=new Map();
  for(const item of proof){if(!shape(item,['key','position']) || !messageKey(item.key) || !keys.has(item.key) || result.has(item.key) || !position(item.position) || item.position==='0')return null;result.set(item.key,item.position);}
  return result.size===keys.size?result:null;
}
export function cleanRoomTitle(value){
  if(typeof value!=='string')return null;
  const title=value.trim();
  return title && [...title].length<=120 && !/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/u.test(title)?title:null;
}

// Account-session memory only. It is independent of the 20-room display LRU.
export function createRoomState({perRoomLimit=2000,totalLimit=20000,bloomBytes=2*1024*1024}={}){
  const bounded=(value,max)=>Number.isSafeInteger(value) && value>0?Math.min(value,max):max;
  perRoomLimit=bounded(perRoomLimit,2000);totalLimit=bounded(totalLimit,20000);
  // Production uses a session-wide 2 MiB filter and four independent probes.
  // Smaller bounded filters are useful for account-free saturation checks.
  bloomBytes=bounded(bloomBytes,2*1024*1024);
  const bloom=Buffer.alloc(bloomBytes),bloomBits=bloom.length*8;
  const rooms=new Map(),tokens=new Map(),notices=new Map(),exact=new Map();
  let entries=0,notifications=false,occupiedBits=0,globalPartial=false;
  const get=key=>{
    if(!rooms.has(key)){
      if(rooms.size>=ROOM_LIMIT)return null;
      rooms.set(key,{title:null,pinOrder:null,muted:false,events:new Map(),positions:new Map(),exact:new Map(),sequence:0,seen:0,partial:false,seeded:false,initialUnreadCount:0,seedBound:null,currentSeedBound:null,maxObserved:null,ownFloor:null,generation:null,recoveryBound:null,recoverySequence:0});
    }
    return rooms.get(key);
  };
  function probes(fingerprint){
    const digest=createHash('sha256').update(fingerprint).digest();
    return [0,4,8,12].map(offset=>digest.readUInt32LE(offset)%bloomBits);
  }
  function remember(fingerprint,state,positions){
    for(const bit of positions){
      const byte=bit>>>3,mask=1<<(bit&7);
      if(!(bloom[byte]&mask)){bloom[byte]|=mask;occupiedBits++;}
    }
    if(occupiedBits>=bloomBits/2)globalPartial=true;
    exact.set(fingerprint,state);state.exact.set(fingerprint,true);
    while(state.exact.size>perRoomLimit){const oldest=state.exact.keys().next().value;state.exact.delete(oldest);exact.delete(oldest);}
    while(exact.size>totalLimit){const [oldest,owner]=exact.entries().next().value;exact.delete(oldest);owner.exact.delete(oldest);}
  }
  return {
    bind(rows,{reconnect=false,seedBounds,generation}={}){
      const proof=seedProof(rows,seedBounds);
      for(const row of rows){
        if(!roomKeyValid(row?.key))continue;
        const existing=rooms.has(row.key),state=get(row.key);
        if(state && generation!==undefined && state.generation!==generation){
          state.generation=generation;state.recoverySequence=state.sequence;
          state.recoveryBound=[state.seedBound,state.maxObserved].filter(value=>value!==null).sort((a,b)=>BigInt(a)>BigInt(b)?-1:BigInt(a)<BigInt(b)?1:0)[0] ?? null;
        }
        if(state && !state.seeded){
          const initial=initialUnreadState(row);state.seeded=true;state.initialUnreadCount=initial.initialUnreadCount;
          state.seedBound=proof?.get(row.key) ?? null;
          if(initial.initialUnreadCoverage==='partial')state.partial=true;
        }
        if(state){state.currentSeedBound=proof?.get(row.key) ?? null;if(proof===null)state.partial=true;}
        if(state && existing && reconnect)state.partial=true;
      }
      if(reconnect)tokens.clear();
    },
    markPartial(key){const state=rooms.get(key);if(state)state.partial=true;},
    receive(key,arrivals,{arrivalProof}={}){
      if(!roomKeyValid(key))return;
      const state=get(key);if(!state)return;
      const proof=arrivalPositions(arrivals,arrivalProof);if(proof===null)state.partial=true;
      for(const item of Array.isArray(arrivals)?arrivals.slice(0,200):[]){
        if(!messageKey(item?.key))continue;
        const logPosition=proof?.get(item.key) ?? null;
        if(logPosition && item.incoming===true && item.userMessage===true && (item.afterBaseline===true || item.afterBaseline===null && state.ownFloor!==null)){
          if(state.maxObserved===null || BigInt(logPosition)>BigInt(state.maxObserved))state.maxObserved=logPosition;
        }
        const fingerprint=key+':'+item.key;
        if(exact.has(fingerprint) || state.events.has(item.key)){
          if(state.events.has(item.key) && logPosition){const previous=state.positions.get(item.key);if(!previous)state.positions.set(item.key,logPosition);else if(previous!==logPosition)state.partial=true;}
          continue;
        }
        const positions=probes(fingerprint);
        if(positions.every(bit=>(bloom[bit>>>3]&(1<<(bit&7)))!==0)){state.partial=true;continue;}
        remember(fingerprint,state,positions);
        const covered=logPosition && state.ownFloor!==null && BigInt(logPosition)<=BigInt(state.ownFloor);
        const afterBaseline=item.afterBaseline===null && logPosition && state.ownFloor!==null?BigInt(logPosition)>BigInt(state.ownFloor):item.afterBaseline;
        const countable=!covered && item.incoming===true && afterBaseline===true && item.userMessage===true;
        if(item.incoming===null || item.afterBaseline===null)state.partial=true;
        if(!countable)continue;
        if(state.events.size>=perRoomLimit || entries>=totalLimit || state.sequence>=Number.MAX_SAFE_INTEGER){state.partial=true;continue;}
        state.events.set(item.key,++state.sequence);if(logPosition)state.positions.set(item.key,logPosition);entries++;
        if(notifications && !state.muted)notices.set(key,{key,id:randomBytes(16).toString('hex')});
      }
    },
    decorate(row){
      const state=get(row.key);
      if(!state)return {...row,unreadLocalCount:0,unreadCoverage:'partial'};
      const count=state.initialUnreadCount+state.events.size;
      return {...row,baseTitle:row.title,localTitle:state.title,title:state.title || row.title,
        pinOrder:state.pinOrder,muted:state.muted,unreadLocalCount:count,unreadCoverage:state.partial || globalPartial?'partial':'observed'};
    },
    settings(key,patch){if(!roomKeyValid(key))return;const state=get(key);if(!state)return;Object.assign(state,patch);if(state.muted)notices.delete(key);},
    notifications(enabled){notifications=enabled===true;if(!notifications)notices.clear();},
    claim(){const result=[];for(const [key,notice] of notices){notices.delete(key);const state=get(key);if(!state || state.muted || !state.events.size)continue;result.push(notice);if(result.length>=5)break;}return result;},
    rename(key,value){
      if(!roomKeyValid(key) || !rooms.has(key))return false;
      const title=value===null?null:cleanRoomTitle(value);
      if(value!==null && title===null)return false;
      get(key).title=title;return true;
    },
    issue(key,message){
      if(!roomKeyValid(key) || !messageKey(message) || !rooms.has(key))return null;
      const token=randomBytes(24).toString('hex');
      tokens.set(token,{key,message,sequence:get(key).sequence});
      while(tokens.size>200)tokens.delete(tokens.keys().next().value);
      return token;
    },
    hasToken:token=>tokens.has(token),
    seen(key,token){
      const issued=tokens.get(token);
      if(!issued || issued.key!==key || !rooms.has(key))return null;
      tokens.delete(token);
      const state=get(key);state.initialUnreadCount=0;state.seen=Math.max(state.seen,issued.sequence);
      for(const [message,sequence] of state.events)if(sequence<=state.seen){state.events.delete(message);state.positions.delete(message);entries--;}
      if(!state.events.size)notices.delete(key);
      return {message:issued.message};
    },
    ownRead(key,read,proof,observe){
      const report=reason=>{try{if(typeof observe==='function')observe(reason);}catch{/* Observation cannot affect receipt application. */}};
      const state=rooms.get(key);
      if(!roomKeyValid(key) || !state){report('invalid_room');return false;}
      if(!read || typeof read!=='object' || Array.isArray(read)
        || Object.keys(read).length!==4 || !['keys','clearInitial','clearEvents','partial'].every(field=>Object.hasOwn(read,field))
        || !Array.isArray(read.keys) || read.keys.length>2000 || read.keys.some(item=>!messageKey(item))
        || new Set(read.keys).size!==read.keys.length || ['clearInitial','clearEvents','partial'].some(field=>typeof read[field]!=='boolean')){report('invalid_payload');return false;}
      const wanted=new Set(read.keys),knownHere=message=>state.events.has(message) || state.exact.has(key+':'+message);
      // Validate the entire payload before applying its flags. These linear,
      // bounded scans avoid payload-size times total-history work. Stale own
      // keys can have left dedupe memory; only a known foreign-only key rejects.
      for(const other of rooms.values())if(other!==state)for(const message of other.events.keys())if(wanted.has(message) && !knownHere(message)){report('invalid_payload');return false;}
      for(const [fingerprint,owner] of exact)if(owner!==state){const message=fingerprint.slice(fingerprint.indexOf(':')+1);if(wanted.has(message) && !knownHere(message)){report('invalid_payload');return false;}}
      const before=state.initialUnreadCount+state.events.size,partial=state.partial || globalPartial;
      if(!shape(proof,['watermark']) || !position(proof.watermark)){state.partial=true;report('invalid_payload');return partial!==(state.partial || globalPartial);}
      const mark=proof.watermark;
      if(state.ownFloor!==null && BigInt(mark)<=BigInt(state.ownFloor)){report('stale_position');return false;}
      state.ownFloor=mark;
      const unknownPending=[...state.events.keys()].some(message=>!state.positions.has(message) && !wanted.has(message));
      const unknownRetained=[...state.events].some(([message,sequence])=>sequence<=state.recoverySequence && !state.positions.has(message) && !wanted.has(message));
      const bounds=[state.seedBound,state.recoveryBound].filter(value=>value!==null);
      const fullKnown=!unknownRetained && bounds.length>0 && bounds.every(value=>BigInt(mark)>=BigInt(value));
      if(state.seedBound!==null && BigInt(mark)>=BigInt(state.seedBound) && (state.currentSeedBound!==null || fullKnown))state.initialUnreadCount=0;
      if(read.partial)state.partial=true;
      for(const message of state.events.keys()){
        const logPosition=state.positions.get(message);
        if(wanted.has(message) || logPosition && BigInt(logPosition)<=BigInt(mark)){state.events.delete(message);state.positions.delete(message);entries--;}
      }
      if(state.initialUnreadCount || unknownPending)state.partial=true;
      if(!state.events.size)notices.delete(key);
      // Keep local seen tokens, sequence and Bloom/exact dedupe intact. The
      // next arrival receives a later sequence and cannot be cleared by this IPC.
      const changed=before!==state.initialUnreadCount+state.events.size || partial!==(state.partial || globalPartial);
      report(changed?'changed':'unchanged');return changed;
    },
    clear(){rooms.clear();tokens.clear();notices.clear();exact.clear();bloom.fill(0);notifications=false;entries=0;occupiedBits=0;globalPartial=false;},
  };
}
