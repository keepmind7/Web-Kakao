import { probeRoomCount } from './room-probe.mjs';
import { createReaderStore } from './reader-data.mjs';

export const allowedReaderMethod = method => ['GETCONF','CHECKIN','LOGINLIST','SYNCMSG','PING'].includes(method);

export function createReaderSession(credential,factory,emit) {
  let carriage,store,closed=false,busy=false,resolveStop,pingTimer=null,pingPending=false;
  const stopped=new Promise(resolve=>{resolveStop=resolve;});
  const close=()=>{
    if(closed)return;closed=true;
    clearInterval(pingTimer);carriage?.stopPing();carriage?.disconnect();store?.clear();resolveStop();
  };
  return {
    async start() {
      return new Promise(resolve=>{
        let announced=false;
        const fail=(stage,status)=>{if(closed)return;emit({type:'reader-failed',stage,status:Number.isInteger(status)?status:null});close();};
        void probeRoomCount(credential,factory,async(client,body)=>{
          if(closed)return;
          carriage=client;store=createReaderStore(body,credential.userId);
          carriage.on('disconnected',()=>fail('disconnected'));
          carriage.on('error',()=>fail('transport'));
          carriage.on('push',packet=>{
            if(closed)return;
            if(packet.status!==0){fail('push',packet.status);return;}
            if(packet?.method!=='MSG')return;
            try {
              const updates=store.push(packet.body);
              for(const update of updates)emit({type:'reader-messages',...update,source:'push'});
              if(updates.length)emit({type:'reader-rooms',rooms:store.rooms(),stats:store.stats(),source:'push'});
            } catch { fail('decode'); }
          });
          const heartbeat=async()=>{
            if(closed || pingPending)return;pingPending=true;
            try{const response=await carriage.request('PING',{});if(!closed && response.status!==0)fail('ping',response.status);}
            catch{if(!closed)fail('ping');}finally{pingPending=false;}
          };
          pingTimer=(factory.every ?? setInterval)(heartbeat,30000);pingTimer?.unref?.();
          announced=true;emit({type:'reader-rooms',rooms:store.rooms(),stats:store.stats(),source:'loginlist'});resolve({ok:true});
          await stopped;
        }).then(result=>{
          if(!announced){if(!closed)fail(result.stage,result.status);resolve({ok:false});}
        }).catch(()=>{if(!closed)fail('worker');resolve({ok:false});});
      });
    },
    async history(key,requestId) {
      if(closed || !store || !carriage || busy || !store.has(key))return false;
      busy=true;
      try {
        const response=await carriage.syncMsg(store.serverRoomId(key),0,50);
        if(closed)return false;
        if(response.status!==0){emit({type:'reader-failed',stage:'history',status:Number.isInteger(response.status)?response.status:null});close();return false;}
        const result=store.history(key,response.body);
        emit({type:'reader-messages',...result,requestId,source:'history'});return true;
      } catch {if(!closed){emit({type:'reader-failed',stage:'history',status:null});close();}return false;}
      finally{busy=false;}
    },
    close,
  };
}
