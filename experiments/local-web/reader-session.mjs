import { probeRoomCount } from './room-probe.mjs';
import { createReaderStore,logArray,serverId,compareReadPosition } from './reader-data.mjs';
import { responseStatus } from './reader-response.mjs';
import { decodeImage,messageKeyValid } from './message-content.mjs';
import { uploadPhoto } from './media-upload.mjs';
import { PROFILE } from './kakao-auth.mjs';

export const allowedReaderMethod = (method,{messaging=false}={}) => ['GETCONF','CHECKIN','LOGINLIST','SYNCMSG','MCHATLOGS','PING','CHATINFO'].includes(method)
  || messaging===true && ['WRITE','CHATONROOM','NOTIREAD','SHIP'].includes(method);

export function createReaderSession(credential,factory,emit) {
  let carriage,store,closed=false,busy=false,resolveStop,pingTimer=null,pingPending=false;
  const cursors=new Map();
  const gapProbes=new Map();
  const readProbed=new Set();
  const discoveryQueue=new Map(),discoveryAttempted=new Set();let discoveryPromise=null,discoveryInFlight=null,discoverTimer=null,reportFailure;
  let nextMessageId=Date.now()%0x3fffffff;
  const uploadAbort=new AbortController();
  const publish=(update,source)=>{
    if(update)emit({type:'reader-messages',...update,source});
    emit({type:'reader-rooms',rooms:store.rooms(),stats:store.stats(),source:'push'});
  };
  const stopped=new Promise(resolve=>{resolveStop=resolve;});
  const close=()=>{
    if(closed)return;closed=true;uploadAbort.abort();
    clearInterval(pingTimer);clearTimeout(discoverTimer);carriage?.stopPing();carriage?.disconnect();store?.clear();cursors.clear();gapProbes.clear();readProbed.clear();discoveryQueue.clear();discoveryAttempted.clear();resolveStop();
  };
  function scheduleDiscovery(){
    clearTimeout(discoverTimer);
    if(closed || busy || discoveryPromise || !discoveryQueue.size)return;
    discoverTimer=setTimeout(()=>{
      if(closed || busy || discoveryPromise)return;
      const [id,packets]=discoveryQueue.entries().next().value;discoveryQueue.delete(id);discoveryAttempted.add(id);
      discoveryInFlight={id,packets};
      discoveryPromise=(async()=>{
        try{
          const response=await carriage.request('CHATINFO',{chatId:factory.toLong(id)},5000);
          if(closed)return;
          if(responseStatus(response)!==0){reportFailure('discovery',responseStatus(response));return;}
          const key=store.discover(id,response.body);if(!key)return;
          // Publish the vetted room before any messages referencing its handle.
          publish(null,'push');
          for(const packet of packets)for(const update of store.push(packet))publish(update,'push');
        }catch{if(!closed)reportFailure('discovery');}
        finally{discoveryPromise=null;discoveryInFlight=null;scheduleDiscovery();}
      })();
    },100);discoverTimer.unref?.();
  }
  return {
    async start() {
      return new Promise(resolve=>{
        let announced=false;
        const fail=(stage,status)=>{if(closed)return;emit({type:'reader-failed',stage,status:Number.isInteger(status)?status:null});close();};
        reportFailure=fail;
        void probeRoomCount(credential,factory,async(client,body)=>{
          if(closed)return;
          carriage=client;store=createReaderStore(body,credential.userId,factory.sessionSalt,factory.settingsSecret);
          carriage.on('disconnected',()=>fail('disconnected'));
          carriage.on('error',()=>fail('transport'));
          carriage.on('push',packet=>{
            if(closed)return;
            if(responseStatus(packet)!==0){fail('push',responseStatus(packet));return;}
            try {
              if(factory.messaging===true && packet?.method==='DECUNREAD'){
                const update=store.readUpdate(packet.body);if(update)publish(update,'receipt');return;
              }
              if(factory.messaging===true && ['NEWMEM','LEFT'].includes(packet?.method)){
                const update=store.invalidateReceipts(packet.body);if(update)publish(update,'receipt');return;
              }
              if(!['MSG','SYNCJOIN'].includes(packet?.method))return;
              for(const id of store.unknownRooms(packet.body)){
                if(discoveryInFlight?.id!==id && (discoveryAttempted.has(id) || discoveryAttempted.size>=500))continue;
                if(discoveryInFlight?.id!==id && !discoveryQueue.has(id) && discoveryQueue.size<20)discoveryQueue.set(id,[]);
                const packets=discoveryInFlight?.id===id?discoveryInFlight.packets:discoveryQueue.get(id);
                if(!packets)continue;
                const remaining=50-packets.reduce((n,p)=>n+p.chatLogs.length,0);
                const logs=(logArray(packet.body) ?? []).filter(log=>{
                  const attached=serverId(log?.chatId ?? log?.roomId ?? log?.c);
                  return log && serverId(log.logId ?? log.msgId ?? log.id) && (!attached || attached===id);
                }).slice(0,remaining).map(log=>({logId:serverId(log.logId ?? log.msgId ?? log.id),authorId:serverId(log.authorId ?? log.senderId ?? log.userId ?? log.writerId ?? log.sender?.userId),
                  msg:[...(typeof (log.message ?? log.msg ?? log.text ?? log.content)==='string'?(log.message ?? log.msg ?? log.text ?? log.content):'')].slice(0,4000).join(''),
                  type:Number(log.type ?? log.msgType ?? log.t ?? 1),attachment:typeof log.attachment==='string'?log.attachment.slice(0,65536):undefined,sendAt:Number(log.sendAt ?? log.createdAt),senderName:typeof (log.senderName ?? log.authorName)==='string'?(log.senderName ?? log.authorName).slice(0,80):''}));
                if(logs.length)packets.push({chatId:id,chatLogs:logs});
              }
              scheduleDiscovery();
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
      if(discoveryPromise)await discoveryPromise;
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
      finally{busy=false;scheduleDiscovery();}
    },
    async action(key,requestId,action,payload={}){
      if(discoveryPromise)await discoveryPromise;
      if(factory.messaging!==true || closed || busy || !store?.has(key) || !store.canSend(key))return false;
      if(!['send','photo','context','read'].includes(action))return false;
      if(action==='send' && (typeof payload.text!=='string' || !payload.text.trim() || [...payload.text].length>4000))return false;
      const extra=action==='send' && payload.replyTo!==undefined?messageKeyValid(payload.replyTo) && store.replyForMessage(key,payload.replyTo):null;
      if(action==='send' && payload.replyTo!==undefined && !extra)return false;
      const image=action==='photo'?decodeImage(payload.image):null;if(action==='photo' && (!image || typeof factory.media!=='function'))return false;
      const readTarget=action==='read'?store.readTargetForMessage(key,payload.message):null;
      const watermark=readTarget?.logId;
      if(action==='read' && !watermark)return false;
      busy=true;
      const result=(phase,status=null,messageKey)=>emit({type:'reader-action',key,requestId,action,phase,status,...(messageKey?{messageKey}:{})});
      try{
        const chatId=factory.toLong(store.serverRoomId(key));
        let beforeRead=null;
        const probeRead=action==='read' && factory.readProbe===true && !readProbed.has(key) && readProbed.size<8;
        const inspectRead=async()=>{
          const snapshot=await carriage.request('CHATINFO',{chatId},5000);
          if(responseStatus(snapshot)!==0)throw new Error('read_snapshot_rejected');
          return compareReadPosition(snapshot.body,store.serverRoomId(key),watermark);
        };
        if(probeRead){readProbed.add(key);beforeRead=await inspectRead();if(closed)return false;}
        if(action==='photo'){
          const outcome=await uploadPhoto({carriage,createClient:factory.media,toLong:factory.toLong,chatId:store.serverRoomId(key),userId:credential.userId,messageId:String(++nextMessageId),data:image.data,signal:uploadAbort.signal,resolve:factory.resolveUpload,profile:PROFILE,observe:factory.observeUpload});
          if(closed)return false;
          let update=null;
          if(outcome.phase==='accepted' && outcome.chatLog){update=store.writeAccepted(key,{chatLog:outcome.chatLog},'[사진]',{type:2});if(update)publish(update,'sent');}
          result(outcome.phase,outcome.status,update?.messageKey);
          if(Number.isInteger(outcome.status) && outcome.status!==0){emit({type:'reader-failed',stage:'photo',status:outcome.status});close();}
          return true;
        }
        const response=action==='send'
          ?await carriage.request('WRITE',{chatId,msgId:++nextMessageId,type:extra?26:1,noSeen:true,msg:payload.text,...(extra?{extra}:{})},20000)
          :action==='context'?await carriage.request('CHATONROOM',{chatId,token:factory.toLong('0'),opt:factory.toLong('0')})
          :await carriage.request('NOTIREAD',{chatId,watermark:factory.toLong(watermark)});
        if(closed)return false;
        const status=responseStatus(response);
        if(status!==0){result(action==='send' && status===null?'unknown':'failed',status);emit({type:'reader-failed',stage:action,status});close();return true;}
        if(action==='send'){
          if(response.body?.msgId!==undefined && String(response.body.msgId)!==String(nextMessageId))throw new Error('write_correlation');
          const update=store.writeAccepted(key,response.body,payload.text,{type:extra?26:1,attachment:extra});
          if(update)publish(update,'sent');
          result('accepted',0,update?.messageKey);
        }else if(action==='context'){
          const ready=store.receiptSnapshot(key,response.body);
          store.recent(key);publish(store.current(key),'receipt');result(ready?'accepted':'unavailable',0);
        }else{
          // status0 acknowledges the request, not the peer's displayed unread count.
          if(probeRead){
            const afterRead=await inspectRead();if(closed)return false;
            factory.observeRead?.({before:beforeRead,after:afterRead,targetIsOwn:readTarget.mine,requestedIsOwn:readTarget.requestedIsOwn});
          }
          result('accepted',0);
        }
        return true;
      }catch{
        if(!closed){result(['send','photo'].includes(action)?'unknown':'failed');emit({type:'reader-failed',stage:action,status:null});close();}
        return true;
      }finally{busy=false;scheduleDiscovery();}
    },
    close,
  };
}
