import { allowedReaderMethod } from './reader-session.mjs';
import { normalizedResponse } from './reader-response.mjs';
import { serverId } from './reader-data.mjs';

const WRITE_RESPONSE_LIMIT=2048;
const ROOM_RESPONSES=new Set(['CHATONROOM','CHATINFO','NOTIREAD']);
const EXACT_RESPONSES=new Set(['SYNCLINK','INFOLINK','MEMBER']);
const RECOVERABLE_METHODS=new Set(['CHATONROOM','NOTIREAD','SHIP','PING']);
const OPTIONAL_METHODS=new Set(['CHATINFO','SYNCLINK','INFOLINK','MEMBER']);
const values=(body,names)=>[body,body?.chatLog,body?.log].flatMap(value=>names.filter(name=>value && Object.hasOwn(value,name)).map(name=>value[name]));
function writeMatches(packet,request,{fallback=false}={}){
  if(!request)return !fallback;
  const rooms=values(packet.body,['chatId','roomId','c']),messages=values(packet.body,['msgId']);
  if(rooms.some(value=>serverId(value)!==request.chatId) || messages.some(value=>serverId(value)!==request.msgId))return false;
  return !fallback || Boolean(request.msgId && messages.length);
}
function roomValues(body){
  const rooms=[body,body?.chatInfo,body?.chatLog,body?.log].flatMap(value=>['chatId','roomId','chatRoomId','c'].filter(name=>value && Object.hasOwn(value,name)).map(name=>value[name]));
  return body?.chatInfo && Object.hasOwn(body.chatInfo,'id')?[...rooms,body.chatInfo.id]:rooms;
}
function roomMatches(packet,request,{fallback=false}={}){
  const rooms=roomValues(packet.body);
  return Boolean(request?.chatId) && rooms.every(value=>serverId(value)===request.chatId) && (!fallback || rooms.length>0);
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
  const observeOwnRead=(reason,method)=>{try{diagnostic?.ownRead?.('transport',reason,method);}catch{/* Observation cannot affect response correlation. */}};
  return class extends Client{
    writeRequests=new WeakMap();
    roomRequests=new WeakMap();
    completedWrites=new Set();
    completedRoomPackets=new Set();
    optionalRequests=new WeakSet();
    expiredOptional=new Set();
    cancelledWrites=new Set();
    writeCancellationObserved=false;
    async request(method,body={},timeoutMs=10000,policy={}){
      const optional=policy?.optional===true,recoverable=policy?.recoverable===true;
      if(recoverable && (!RECOVERABLE_METHODS.has(method) || !Number.isFinite(timeoutMs) || timeoutMs<=0 || timeoutMs>2147483647))throw new Error('recoverable_policy_forbidden');
      if(optional && (!OPTIONAL_METHODS.has(method) || !Number.isFinite(timeoutMs) || timeoutMs<=0 || timeoutMs>2147483647))throw new Error('optional_policy_forbidden');
      const signal=policy?.signal;
      if(signal!==undefined && (method!=='WRITE' || !(signal instanceof AbortSignal)))throw new Error('request_signal_forbidden');
      if(signal?.aborted)throw Object.assign(new Error('request_aborted'),{code:'READER_REQUEST_ABORTED'});
      if(method==='WRITE' && this.cancelledWrites.has(`${serverId(body?.chatId)}:${serverId(body?.msgId)}`))throw new Error('cancelled_write_identity_reuse');
      if(media?!(messaging && method==='POST'):!allowedReaderMethod(method,{messaging}))throw new Error('read_only_required');
      diagnostic?.note('request',{method});
      const scoped=ROOM_RESPONSES.has(method);
      const previous=method==='WRITE' || scoped || optional || recoverable?new Set(this.pending.keys()):null;
      const waiting=super.request(method,body,timeoutMs);let replacement=null,onAbort=null;
      if(previous){
        const added=[...this.pending.entries()].filter(([id,item])=>!previous.has(id) && item.method===method);
        if(added.length===1){
          const [id,item]=added[0];
          if(scoped || method==='WRITE')(scoped?this.roomRequests:this.writeRequests).set(item,{chatId:serverId(body?.chatId),msgId:serverId(body?.msgId)});
          if(signal){
            // An explicitly cancelled experimental WRITE remains unknown to its
            // caller. Retire just this request so its original SDK timer cannot
            // later destroy the carriage, and quarantine its late response.
            // Normal WRITE deadlines retain the SDK's destructive semantics;
            // recoverable WRITE is still forbidden above.
            onAbort=()=>{
              if(this.pending.get(id)!==item)return;
              clearTimeout(item.timer);this.pending.delete(id);
              this.writeCancellationObserved=true;
              const identity=this.writeRequests.get(item);
              if(identity?.chatId && identity?.msgId){
                this.cancelledWrites.add(`${identity.chatId}:${identity.msgId}`);
                while(this.cancelledWrites.size>WRITE_RESPONSE_LIMIT)this.cancelledWrites.delete(this.cancelledWrites.values().next().value);
              }
              this.expiredOptional.add(`${method}:${String(id)}`);
              while(this.expiredOptional.size>WRITE_RESPONSE_LIMIT)this.expiredOptional.delete(this.expiredOptional.values().next().value);
              item.reject(Object.assign(new Error('request_aborted'),{code:'READER_REQUEST_ABORTED'}));
            };
            signal.addEventListener('abort',onAbort,{once:true});
            if(signal.aborted)onAbort();
          }
          if(optional || recoverable){
            // The pinned SDK registers pending synchronously. Replace its
            // destructive timer; racing the original promise is insufficient.
            clearTimeout(item.timer);if(optional)this.optionalRequests.add(item);
            replacement=setTimeout(()=>{
              if(this.pending.get(id)!==item)return;
              this.pending.delete(id);this.expiredOptional.add(`${method}:${String(id)}`);
              while(this.expiredOptional.size>WRITE_RESPONSE_LIMIT)this.expiredOptional.delete(this.expiredOptional.values().next().value);
              item.reject(Object.assign(new Error(`Request ${method} timed out`),{code:'READER_REQUEST_TIMEOUT'}));
            },timeoutMs);
            item.timer=replacement;
          }
        }
      }
      try{
        const response=await waiting;
        diagnostic?.packet('response',response);
        return normalizedResponse(response);
      }finally{if(replacement)clearTimeout(replacement);if(onAbort)signal.removeEventListener('abort',onAbort);}
    }
    finishPacket(packet){
      observeOwnRead('received',packet.method);
      // After cancellation a packet number alone cannot distinguish a late old
      // ACK from a new one. Require explicit message identity for this carriage
      // lifetime, but allow a strongly matched new ACK to reuse an old number.
      const cancelledWrite=packet.method==='WRITE' && this.writeCancellationObserved;
      if(cancelledWrite && !values(packet.body,['msgId']).length || !cancelledWrite && this.expiredOptional.has(`${packet.method}:${String(packet.packetId)}`)){observeOwnRead('quarantined',packet.method);diagnostic?.packet('push',packet);return;}
      const exact=this.pending.get(packet.packetId);
      let entry=exact?.method===packet.method?[packet.packetId,exact]:null;
      if(packet.method==='WRITE'){
        if(entry && !writeMatches(packet,this.writeRequests.get(entry[1])))entry=null;
        if(!entry){
          const matches=[...this.pending.entries()].filter(([,item])=>item.method==='WRITE' && writeMatches(packet,this.writeRequests.get(item),{fallback:true}));
          if(matches.length===1)entry=matches[0];
        }
      }else if(ROOM_RESPONSES.has(packet.method)){
        if(entry && !roomMatches(packet,this.roomRequests.get(entry[1])))entry=null;
        if(!entry){
          const matches=[...this.pending.entries()].filter(([,item])=>item.method===packet.method && !this.optionalRequests.has(item) && roomMatches(packet,this.roomRequests.get(item),{fallback:true}) && !this.completedRoomPackets.has(`${packet.method}:${this.roomRequests.get(item)?.chatId}:${String(packet.packetId)}`));
          if(matches.length===1)entry=matches[0];
        }
      }else if(!entry && !EXACT_RESPONSES.has(packet.method))entry=[...this.pending.entries()].find(([,item])=>item.method===packet.method);
      if(entry){
        if(ROOM_RESPONSES.has(packet.method)){
          const prefix=`${packet.method}:${this.roomRequests.get(entry[1])?.chatId}:`;
          this.completedRoomPackets.add(prefix+String(packet.packetId));this.completedRoomPackets.add(prefix+String(entry[0]));
          while(this.completedRoomPackets.size>WRITE_RESPONSE_LIMIT)this.completedRoomPackets.delete(this.completedRoomPackets.values().next().value);
        }
        if(packet.method==='WRITE'){
          const fingerprints=writeFingerprints(packet,this.writeRequests.get(entry[1]));
          if(fingerprints.some(value=>this.completedWrites.has(value))){observeOwnRead('duplicate_drop',packet.method);return;}
          for(const value of [...fingerprints,'packet:'+String(packet.packetId),'packet:'+String(entry[0])])this.completedWrites.add(value);
          while(this.completedWrites.size>WRITE_RESPONSE_LIMIT)this.completedWrites.delete(this.completedWrites.values().next().value);
        }
        observeOwnRead('matched',packet.method);clearTimeout(entry[1].timer);this.pending.delete(entry[0]);entry[1].resolve(packet);return;
      }
      // An uncorrelated WRITE is neither another request's acknowledgement nor
      // an incoming message. Leave its pending request to time out as unknown.
      if(packet.method==='WRITE' || ROOM_RESPONSES.has(packet.method) || EXACT_RESPONSES.has(packet.method)){observeOwnRead('scoped_drop',packet.method);diagnostic?.packet('push',packet);return;}
      observeOwnRead('forwarded',packet.method);diagnostic?.packet('push',packet);this.emit('push',normalizedResponse(packet));
    }
  };
}
