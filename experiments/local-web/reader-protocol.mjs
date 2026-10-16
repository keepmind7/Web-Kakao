import { allowedReaderMethod } from './reader-session.mjs';
import { normalizedResponse } from './reader-response.mjs';
import { serverId } from './reader-data.mjs';

const WRITE_RESPONSE_LIMIT=2048;
const values=(body,names)=>[body,body?.chatLog,body?.log].flatMap(value=>names.filter(name=>value && Object.hasOwn(value,name)).map(name=>value[name]));
function writeMatches(packet,request,{fallback=false}={}){
  if(!request)return !fallback;
  const rooms=values(packet.body,['chatId','roomId','c']),messages=values(packet.body,['msgId']);
  if(rooms.some(value=>serverId(value)!==request.chatId) || messages.some(value=>serverId(value)!==request.msgId))return false;
  return !fallback || Boolean(request.msgId && messages.length);
}
function writeFingerprints(packet,request){
  const ids=values(packet.body,['msgId']).map(serverId).filter(Boolean);
  const log=serverId(packet.body?.chatLog?.logId ?? packet.body?.log?.logId ?? packet.body?.logId);
  const room=values(packet.body,['chatId','roomId','c']).map(serverId).find(Boolean) ?? request?.chatId ?? '';
  const identified=[...ids.map(id=>'message:'+id),...(log?['log:'+room+':'+log]:[])];
  // A fallback response number can be reused or equal the next request number.
  // Prefer independent body identity; packet-only history is a weak fallback.
  return identified.length?identified:[`packet:${String(packet.packetId)}`];
}

// The pinned SDK matches a packet ID before checking the method. A server push
// with the same numeric ID must not resolve a pending history request.
export function guardReaderClient(Client,diagnostic,{messaging=false,media=false}={}){
  return class extends Client{
    writeRequests=new WeakMap();
    completedWrites=new Set();
    async request(method,...args){
      if(media?!(messaging && method==='POST'):!allowedReaderMethod(method,{messaging}))throw new Error('read_only_required');
      diagnostic?.note('request',{method});
      const previous=method==='WRITE'?new Set(this.pending.keys()):null;
      const waiting=super.request(method,...args);
      if(previous){
        const added=[...this.pending.entries()].filter(([id,item])=>!previous.has(id) && item.method==='WRITE');
        if(added.length===1)this.writeRequests.set(added[0][1],{chatId:serverId(args[0]?.chatId),msgId:serverId(args[0]?.msgId)});
      }
      const response=await waiting;
      diagnostic?.packet('response',response);
      return normalizedResponse(response);
    }
    finishPacket(packet){
      const exact=this.pending.get(packet.packetId);
      let entry=exact?.method===packet.method?[packet.packetId,exact]:null;
      if(packet.method==='WRITE'){
        if(entry && !writeMatches(packet,this.writeRequests.get(entry[1])))entry=null;
        if(!entry){
          const matches=[...this.pending.entries()].filter(([,item])=>item.method==='WRITE' && writeMatches(packet,this.writeRequests.get(item),{fallback:true}));
          if(matches.length===1)entry=matches[0];
        }
      }else if(!entry)entry=[...this.pending.entries()].find(([,item])=>item.method===packet.method);
      if(entry){
        if(packet.method==='WRITE'){
          const fingerprints=writeFingerprints(packet,this.writeRequests.get(entry[1]));
          if(fingerprints.some(value=>this.completedWrites.has(value)))return;
          for(const value of [...fingerprints,'packet:'+String(packet.packetId),'packet:'+String(entry[0])])this.completedWrites.add(value);
          while(this.completedWrites.size>WRITE_RESPONSE_LIMIT)this.completedWrites.delete(this.completedWrites.values().next().value);
        }
        clearTimeout(entry[1].timer);this.pending.delete(entry[0]);entry[1].resolve(packet);return;
      }
      // An uncorrelated WRITE is neither another request's acknowledgement nor
      // an incoming message. Leave its pending request to time out as unknown.
      if(packet.method==='WRITE'){diagnostic?.packet('push',packet);return;}
      diagnostic?.packet('push',packet);this.emit('push',normalizedResponse(packet));
    }
  };
}
