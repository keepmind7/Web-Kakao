import { probeRoomCount } from './room-probe.mjs';
import { createReaderStore,logArray } from './reader-data.mjs';
import { responseStatus } from './reader-response.mjs';

export const allowedReaderMethod = method => ['GETCONF','CHECKIN','LOGINLIST','SYNCMSG','MCHATLOGS','PING'].includes(method);

export function createReaderSession(credential,factory,emit) {
  let carriage,store,closed=false,busy=false,resolveStop,pingTimer=null,pingPending=false;
  const cursors=new Map();
  const gapProbes=new Map();
  const stopped=new Promise(resolve=>{resolveStop=resolve;});
  const close=()=>{
    if(closed)return;closed=true;
    clearInterval(pingTimer);carriage?.stopPing();carriage?.disconnect();store?.clear();cursors.clear();gapProbes.clear();resolveStop();
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
            if(responseStatus(packet)!==0){fail('push',responseStatus(packet));return;}
            if(packet?.method!=='MSG')return;
            try {
              const updates=store.push(packet.body);
              for(const update of updates)emit({type:'reader-messages',...update,source:'push'});
              if(updates.length)emit({type:'reader-rooms',rooms:store.rooms(),stats:store.stats(),source:'push'});
            } catch { fail('decode'); }
          });
          const heartbeat=async()=>{
            if(closed || pingPending)return;pingPending=true;
            try{const response=await carriage.request('PING',{});if(!closed && responseStatus(response)!==0)fail('ping',responseStatus(response));}
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
      // A zero max was rejected by the actual server. Use only a bound already
      // supplied by LOGINLIST/MSG; do not guess an ID or issue another command.
      const end=store.historyEnd(key);
      store.recent(key);
      if(!end){
        emit({type:'reader-messages',...store.history(key,{}),requestId,source:'history',unavailable:true});
        return true;
      }
      busy=true;
      try {
        let cur=cursors.get(key) ?? '0',result,receivedCount=0,acceptedCount=0,rejectedCount=0,fieldPresent=false,hasMore=false,complete=false,pages=0;
        // SYNCMSG moves forward. Stop on a non-advancing cursor, denial, empty
        // page or a small per-click budget; never pretend a first page is latest.
        for(;pages<8;pages++){
          const response=await carriage.request('SYNCMSG',{chatId:factory.toLong(store.serverRoomId(key)),cur:factory.toLong(cur),cnt:50,max:factory.toLong(end)});
          if(closed)return false;
          if(responseStatus(response)!==0){emit({type:'reader-failed',stage:'history',status:responseStatus(response)});close();return false;}
          const pageBody=response.body?.isOK===true && !logArray(response.body)?{...response.body,chatLogs:[]}:response.body;
          result=store.history(key,pageBody);receivedCount+=result.receivedCount;acceptedCount+=result.acceptedCount;rejectedCount+=result.rejectedCount;
          fieldPresent ||= result.fieldPresent;
          hasMore=response.body?.isOK===false;
          complete=response.body?.isOK===true;
          const next=store.historyCursor(key,response.body);
          factory.observeHistory?.({page:pages+1,receivedCount:result.receivedCount,acceptedCount:result.acceptedCount,rejectedCount:result.rejectedCount,fieldPresent:result.fieldPresent,hasMore,cursorAdvanced:Boolean(next && BigInt(next)>BigInt(cur)),reachedBound:Boolean(next && BigInt(next)>=BigInt(end)),seedAtEnd:store.seedAtEnd(key)});
          if(next && BigInt(next)>BigInt(cur)){cur=next;cursors.set(key,cur);}else break;
          if(!hasMore || !result.fieldPresent || !result.receivedCount || BigInt(cur)>=BigInt(end))break;
          await (factory.delay ?? (ms=>new Promise(resolve=>setTimeout(resolve,ms))))(100);
          if(closed)return false;
        }
        let gap=complete && BigInt(cur)<BigInt(end);
        // Experimental, opt-in server mode: one alternative read for a range
        // which SYNCMSG declared complete before the known room end.
        const gapRange=cur+':'+end;
        if(gap && factory.gapProbe===true && gapProbes.get(key)!==gapRange){
          gapProbes.set(key,gapRange);
          const response=await carriage.request('MCHATLOGS',{chatIds:[factory.toLong(store.serverRoomId(key))],sinces:[factory.toLong(cur)]});
          if(closed)return false;
          if(responseStatus(response)!==0){emit({type:'reader-failed',stage:'history',status:responseStatus(response)});close();return false;}
          result=store.history(key,response.body,{requireRoomId:true});receivedCount+=result.receivedCount;acceptedCount+=result.acceptedCount;rejectedCount+=result.rejectedCount;fieldPresent ||= result.fieldPresent;
          const next=store.historyCursor(key,response.body,{requireRoomId:true});
          const advanced=Boolean(next && BigInt(next)>BigInt(cur));
          if(advanced){cur=next;cursors.set(key,cur);}
          gap=BigInt(cur)<BigInt(end);
          factory.observeHistory?.({method:'MCHATLOGS',receivedCount:result.receivedCount,acceptedCount:result.acceptedCount,rejectedCount:result.rejectedCount,fieldPresent:result.fieldPresent,cursorAdvanced:advanced,reachedBound:!gap,seedAtEnd:store.seedAtEnd(key)});
        }
        emit({type:'reader-messages',...result,fieldPresent,receivedCount,acceptedCount,rejectedCount,hasMore,gap,requestId,source:'history'});return true;
      } catch {if(!closed){emit({type:'reader-failed',stage:'history',status:null});close();}return false;}
      finally{busy=false;}
    },
    close,
  };
}
