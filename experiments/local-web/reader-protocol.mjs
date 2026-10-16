import { allowedReaderMethod } from './reader-session.mjs';
import { normalizedResponse } from './reader-response.mjs';

// The pinned SDK matches a packet ID before checking the method. A server push
// with the same numeric ID must not resolve a pending history request.
export function guardReaderClient(Client,diagnostic,{messaging=false,media=false}={}){
  return class extends Client{
    async request(method,...args){
      if(media?!(messaging && method==='POST'):!allowedReaderMethod(method,{messaging}))throw new Error('read_only_required');
      diagnostic?.note('request',{method});
      const response=await super.request(method,...args);
      diagnostic?.packet('response',response);
      return normalizedResponse(response);
    }
    finishPacket(packet){
      const exact=this.pending.get(packet.packetId);
      let entry=exact?.method===packet.method?[packet.packetId,exact]:null;
      if(!entry)entry=[...this.pending.entries()].find(([,item])=>item.method===packet.method);
      if(entry){clearTimeout(entry[1].timer);this.pending.delete(entry[0]);entry[1].resolve(packet);return;}
      diagnostic?.packet('push',packet);this.emit('push',normalizedResponse(packet));
    }
  };
}
