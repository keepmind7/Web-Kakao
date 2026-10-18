import { randomBytes,createHash } from 'node:crypto';
import { roomKeyValid,ROOM_LIMIT,initialUnreadState } from './reader-data.mjs';

const messageKey=value=>typeof value==='string' && /^m_[a-f0-9]{24}$/.test(value);
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
      rooms.set(key,{title:null,pinOrder:null,muted:false,events:new Map(),exact:new Map(),sequence:0,seen:0,partial:false,seeded:false,initialUnreadCount:0});
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
    bind(rows,{reconnect=false}={}){
      for(const row of rows){
        if(!roomKeyValid(row?.key))continue;
        const existing=rooms.has(row.key),state=get(row.key);
        if(state && !state.seeded){
          const initial=initialUnreadState(row);state.seeded=true;state.initialUnreadCount=initial.initialUnreadCount;
          if(initial.initialUnreadCoverage==='partial')state.partial=true;
        }
        if(state && existing && reconnect)state.partial=true;
      }
      if(reconnect)tokens.clear();
    },
    markPartial(key){const state=rooms.get(key);if(state)state.partial=true;},
    receive(key,arrivals){
      if(!roomKeyValid(key))return;
      const state=get(key);if(!state)return;
      for(const item of Array.isArray(arrivals)?arrivals.slice(0,200):[]){
        if(!messageKey(item?.key))continue;
        const fingerprint=key+':'+item.key;
        if(exact.has(fingerprint) || state.events.has(item.key))continue;
        const positions=probes(fingerprint);
        if(positions.every(bit=>(bloom[bit>>>3]&(1<<(bit&7)))!==0)){state.partial=true;continue;}
        remember(fingerprint,state,positions);
        const countable=item.incoming===true && item.afterBaseline===true && item.userMessage===true;
        if(item.incoming===null || item.afterBaseline===null)state.partial=true;
        if(!countable)continue;
        if(state.events.size>=perRoomLimit || entries>=totalLimit || state.sequence>=Number.MAX_SAFE_INTEGER){state.partial=true;continue;}
        state.events.set(item.key,++state.sequence);entries++;
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
      for(const [message,sequence] of state.events)if(sequence<=state.seen){state.events.delete(message);entries--;}
      if(!state.events.size)notices.delete(key);
      return {message:issued.message};
    },
    clear(){rooms.clear();tokens.clear();notices.clear();exact.clear();bloom.fill(0);notifications=false;entries=0;occupiedBits=0;globalPartial=false;},
  };
}
