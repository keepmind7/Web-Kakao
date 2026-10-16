import { randomBytes } from 'node:crypto';
import { roomKeyValid } from './reader-data.mjs';

const messageKey=value=>typeof value==='string' && /^m_[a-f0-9]{24}$/.test(value);
export function cleanRoomTitle(value){
  if(typeof value!=='string')return null;
  const title=value.trim();
  return title && [...title].length<=120 && !/[\u0000-\u001f\u007f]/u.test(title)?title:null;
}

// Account-session memory only. It is independent of the 20-room display LRU.
export function createRoomState({perRoomLimit=2000,totalLimit=20000}={}){
  const rooms=new Map(),tokens=new Map(),notices=new Map();let entries=0,notifications=false;
  const get=key=>{
    if(!rooms.has(key))rooms.set(key,{title:null,pinOrder:null,muted:false,events:new Map(),sequence:0,seen:0,partial:false});
    return rooms.get(key);
  };
  return {
    bind(rows,{reconnect=false}={}){
      for(const row of rows){
        if(!roomKeyValid(row?.key))continue;
        const existing=rooms.has(row.key),state=get(row.key);
        if(existing && reconnect)state.partial=true;
      }
      tokens.clear();
    },
    receive(key,arrivals){
      if(!roomKeyValid(key))return;
      const state=get(key);
      for(const item of Array.isArray(arrivals)?arrivals.slice(0,200):[]){
        if(!messageKey(item?.key) || state.events.has(item.key))continue;
        if(state.events.size>=perRoomLimit || entries>=totalLimit){state.partial=true;continue;}
        const countable=item.incoming===true && item.afterBaseline===true && item.userMessage===true;
        if(item.incoming===null || item.afterBaseline===null)state.partial=true;
        state.events.set(item.key,countable?++state.sequence:0);entries++;
        if(countable && notifications && !state.muted)notices.set(key,{key,id:randomBytes(16).toString('hex')});
      }
    },
    decorate(row){
      const state=get(row.key);
      const count=[...state.events.values()].filter(sequence=>sequence>state.seen).length;
      return {...row,baseTitle:row.title,localTitle:state.title,title:state.title || row.title,
        pinOrder:state.pinOrder,muted:state.muted,unreadLocalCount:count,unreadCoverage:state.partial?'partial':'observed'};
    },
    settings(key,patch){if(!roomKeyValid(key))return;Object.assign(get(key),patch);if(get(key).muted)notices.delete(key);},
    notifications(enabled){notifications=enabled===true;if(!notifications)notices.clear();},
    claim(){const result=[];for(const [key,notice] of notices){notices.delete(key);const state=get(key);if(state.muted || ![...state.events.values()].some(sequence=>sequence>state.seen))continue;result.push(notice);if(result.length>=5)break;}return result;},
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
      const state=get(key);state.seen=Math.max(state.seen,issued.sequence);
      return {message:issued.message};
    },
    clear(){rooms.clear();tokens.clear();notices.clear();notifications=false;entries=0;},
  };
}
