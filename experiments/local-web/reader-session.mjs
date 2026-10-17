import { probeRoomCount } from './room-probe.mjs';
import { createReaderStore,logArray,serverId,compareReadPosition } from './reader-data.mjs';
import { responseStatus } from './reader-response.mjs';
import { decodeImage,messageKeyValid } from './message-content.mjs';
import { uploadPhoto } from './media-upload.mjs';
import { PROFILE } from './kakao-auth.mjs';

export const allowedReaderMethod = (method,{messaging=false}={}) => ['GETCONF','CHECKIN','LOGINLIST','SYNCMSG','MCHATLOGS','PING','CHATINFO'].includes(method)
  || messaging===true && ['WRITE','CHATONROOM','NOTIREAD','SHIP','SYNCLINK','INFOLINK'].includes(method);

export function createReaderSession(credential,factory,emit) {
  let carriage,store,closed=false,busy=false,resolveStop,pingTimer=null,pingPending=false,pingMisses=0;
  const cursors=new Map();
  const gapProbes=new Map();
  const readProbed=new Set();
  const entries=new Map();let activeRoom=null,selectionVersion=0;
  const discoveryQueue=new Map(),discoveryAttempted=new Set();let discoveryPromise=null,discoveryInFlight=null,discoverTimer=null;
  const now=factory.now ?? (()=>performance.now());
  let titleQueue=[],titlePromise=null;
  let nextMessageId=Date.now()%0x3fffffff;
  const uploadAbort=new AbortController();
  let activePhoto=null;
  const invalidatePhoto=key=>{if(activePhoto?.key===key)activePhoto.controller.abort();};
  const publish=(update,source)=>{
    if(update)emit({type:'reader-messages',...update,source});
    emit({type:'reader-rooms',rooms:store.rooms(),stats:store.stats(),source:'push'});
  };
  const stopped=new Promise(resolve=>{resolveStop=resolve;});
  const close=()=>{
    if(closed)return;closed=true;uploadAbort.abort();
    clearInterval(pingTimer);clearTimeout(discoverTimer);carriage?.stopPing();carriage?.disconnect();store?.clear();cursors.clear();gapProbes.clear();readProbed.clear();entries.clear();activeRoom=null;discoveryQueue.clear();discoveryAttempted.clear();titleQueue=[];resolveStop();
  };
  function activate(key){
    if(activeRoom===key)return;
    const previous=activeRoom;activeRoom=key;selectionVersion++;entries.clear();
    if(previous)invalidatePhoto(previous);
    if(previous && store?.has(previous))publish({...store.current(previous),entryInvalidated:true},'receipt');
  }
  function entryReady(key){return activeRoom===key && entries.get(key)?.version===store.receiptVersion(key) && entries.get(key)?.selection===selectionVersion;}
  async function ensureEntry(key,bound){
    if(entryReady(key))return {ready:true,receiptReady:entries.get(key).receiptReady};
    if(!store.canAction(key,'context'))return {ready:false};
    const version=store.receiptVersion(key),selection=selectionVersion;
    store.recent(key);
    const response=await carriage.request('CHATONROOM',{chatId:factory.toLong(store.serverRoomId(key)),token:factory.toLong(store.entryToken(key)),opt:store.entryOption(key)},bound(5500),{recoverable:true});
    if(closed || responseStatus(response)!==0 || activeRoom!==key || selectionVersion!==selection || version!==store.receiptVersion(key))return {ready:false,status:responseStatus(response)};
    if(!store.entrySnapshot(key,response.body,version))return {ready:false,status:0};
    const receiptReady=store.receiptSnapshot(key,response.body,version);
    entries.set(key,{version,selection,receiptReady});
    store.recent(key);publish(store.current(key),'receipt');
    return {ready:true,receiptReady};
  }
  function scheduleDiscovery(){
    clearTimeout(discoverTimer);
    if(closed || busy || discoveryPromise || titlePromise || !discoveryQueue.size && !titleQueue.length)return;
    discoverTimer=setTimeout(()=>{
      if(closed || busy || discoveryPromise || titlePromise)return;
      if(!discoveryQueue.size){
        const key=titleQueue.shift();if(!key)return;
        titlePromise=Promise.resolve().then(async()=>{
          if(closed)return;
          try{
            const response=await carriage.request('CHATINFO',{chatId:factory.toLong(store.serverRoomId(key))},3000,{optional:true});
            if(closed || responseStatus(response)!==0 || response?.method!==undefined && response.method!=='CHATINFO')return;
            if(store.recoverTitle(key,response.body))emit({type:'reader-rooms',rooms:store.rooms(),stats:store.stats(),source:'push'});
          }catch{
            // Optional metadata rejection/decoding is nonfatal. A real socket
            // error/close still reaches the existing transport listeners.
          }
        }).finally(()=>{titlePromise=null;scheduleDiscovery();});
        return;
      }
      const [id,packets]=discoveryQueue.entries().next().value;discoveryQueue.delete(id);discoveryAttempted.add(id);
      discoveryInFlight={id,packets};
      discoveryPromise=(async()=>{
        try{
          const response=await carriage.request('CHATINFO',{chatId:factory.toLong(id)},5000,{optional:true});
          if(closed)return;
          if(responseStatus(response)!==0)return;
          const key=store.discover(id,response.body);if(!key)return;
          // Publish the vetted room before any messages referencing its handle.
          publish(null,'push');
          for(const packet of packets)for(const update of store.push(packet))publish(update,'push');
        }catch{/* Optional discovery refusal/expiry does not end a healthy reader. */}
        finally{discoveryPromise=null;discoveryInFlight=null;scheduleDiscovery();}
      })();
    },100);discoverTimer.unref?.();
  }
  return {
    async start() {
      return new Promise(resolve=>{
        let announced=false;
        const fail=(stage,status)=>{if(closed)return;emit({type:'reader-failed',stage,status:Number.isInteger(status)?status:null});close();};
        void probeRoomCount(credential,factory,async(client,body,earlyPush=[])=>{
          if(closed)return;
          carriage=client;store=createReaderStore(body,credential.userId,factory.sessionSalt,factory.settingsSecret,{onCacheEvicted:key=>{cursors.delete(key);gapProbes.delete(key);emit({type:'reader-cache-evicted',key,cacheEpoch:store.cacheEpoch(key)});}});
          titleQueue=store.unnamedRooms(8);
          carriage.on('disconnected',()=>fail('disconnected'));
          carriage.on('error',()=>fail('transport'));
          const onPush=packet=>{
            if(closed)return;
            if(responseStatus(packet)!==0){fail('push',responseStatus(packet));return;}
            try {
              if(factory.messaging===true && packet?.method==='DECUNREAD'){
                const update=store.readUpdate(packet.body);if(update)publish(update,'receipt');return;
              }
              if(factory.messaging===true && ['NEWMEM','LEFT'].includes(packet?.method)){
                const update=store.invalidateReceipts(packet.body,{left:packet.method==='LEFT'});if(update){entries.delete(update.key);invalidatePhoto(update.key);publish(update,'receipt');}return;
              }
              if(factory.messaging===true && ['SYNCLINKCR','SYNCLINKDL','SYNCLINKPF','SYNCMEMT','LINKKICKED','LNKDELETED'].includes(packet?.method)){
                for(const update of store.linkUpdate(packet.method,packet.body)){entries.delete(update.key);invalidatePhoto(update.key);publish(update,'receipt');}return;
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
          };
          carriage.on('push',onPush);
          if(earlyPush.length){
            // Make opaque rooms available before replaying their initial logs.
            emit({type:'reader-rooms',rooms:store.rooms(),stats:store.stats(),source:'push'});
            for(const packet of earlyPush){if(closed)break;onPush(packet);}
          }
          if(closed)return;
          const heartbeat=async()=>{
            if(closed || pingPending)return;pingPending=true;
            try{const response=await carriage.request('PING',{},10000,{recoverable:true});if(!closed && responseStatus(response)!==0)fail('ping',responseStatus(response));else pingMisses=0;}
            catch(error){if(!closed && (error?.code!=='READER_REQUEST_TIMEOUT' || ++pingMisses>=3))fail('ping');}finally{pingPending=false;}
          };
          pingTimer=(factory.every ?? setInterval)(heartbeat,30000);pingTimer?.unref?.();
          // One bounded read-only link sync for LOGINLIST member links. Unknown
          // links cannot create membership, and no JOINLINK is ever issued.
          if(factory.messaging===true && store.hasOpenLinks()){
            const versions=store.linkSyncSnapshot();
            try{const response=await carriage.request('SYNCLINK',{ltk:0},4000,{optional:true});if(!closed && responseStatus(response)===0 && (response.method===undefined || response.method==='SYNCLINK'))store.syncLinks(response.body,versions);}catch{}
            if(!closed){
              // Pinned clients resolve missing existing links with INFOLINK.
              // Its separate parser has no cursor and cannot create membership.
              const missing=store.missingOpenLinkIds(),infoVersions=store.linkSyncSnapshot();
              if(missing.length)try{
                const response=await carriage.request('INFOLINK',{lis:missing.map(id=>factory.toLong(id))},2500,{optional:true});
                if(!closed && responseStatus(response)===0 && (response.method===undefined || response.method==='INFOLINK'))store.infoLinks(response.body,missing,infoVersions);
              }catch{/* Optional lookup failure leaves missing metadata disabled. */}
            }
          }
          if(closed)return;
          announced=true;emit({type:'reader-rooms',rooms:store.rooms(),stats:store.stats(),source:'loginlist'});resolve({ok:true});
          scheduleDiscovery();
          await stopped;
        }).then(result=>{
          if(!announced){if(!closed)fail(result.stage,result.status);resolve({ok:false});}
        }).catch(()=>{if(!closed)fail('worker');resolve({ok:false});});
      });
    },
    view(key){return !closed && Boolean(store?.pin(key));},
    async history(key,requestId) {
      const started=now(),remaining=()=>18000-(now()-started);
      if(titlePromise)await titlePromise;
      if(discoveryPromise)await discoveryPromise;
      if(closed || !store || !carriage || busy || !store.has(key))return false;
      activate(key);
      // A zero max was rejected by the actual server. Use only a bound already
      // supplied by LOGINLIST/MSG; do not guess an ID or issue another command.
      const end=store.historyEnd(key);
      store.recent(key);
      const cacheEpoch=store.cacheEpoch(key);let cacheInvalidated=false;
      if(!end){
        emit({type:'reader-messages',...store.history(key,{}),requestId,source:'history',unavailable:true});
        return true;
      }
      busy=true;
      try {
        let cur=cursors.get(key) ?? '0',result=store.current(key),receivedCount=0,acceptedCount=0,rejectedCount=0,fieldPresent=false,hasMore=false,complete=false,pages=0,budgetStopped=false;
        // SYNCMSG moves forward. Stop on a non-advancing cursor, denial, empty
        // page or a small per-click budget; never pretend a first page is latest.
        for(;pages<8;pages++){
          if(remaining()<10250){budgetStopped=true;break;}
          const response=await carriage.request('SYNCMSG',{chatId:factory.toLong(store.serverRoomId(key)),cur:factory.toLong(cur),cnt:50,max:factory.toLong(end)},10000);
          if(closed)return false;
          if(responseStatus(response)!==0){
            const status=responseStatus(response);if(!Number.isInteger(status))throw new Error('history_status_unknown');
            emit({type:'reader-request-rejected',key,requestId,status});return true;
          }
          cacheInvalidated ||= store.cacheEpoch(key)!==cacheEpoch;
          const pageBody=response.body?.isOK===true && !logArray(response.body)?{...response.body,chatLogs:[]}:response.body;
          result=store.history(key,pageBody);receivedCount+=result.receivedCount;acceptedCount+=result.acceptedCount;rejectedCount+=result.rejectedCount;
          fieldPresent ||= result.fieldPresent;
          hasMore=response.body?.isOK===false;
          complete=response.body?.isOK===true;
          const next=store.historyCursor(key,response.body);
          factory.observeHistory?.({page:pages+1,receivedCount:result.receivedCount,acceptedCount:result.acceptedCount,rejectedCount:result.rejectedCount,fieldPresent:result.fieldPresent,hasMore,cursorAdvanced:Boolean(next && BigInt(next)>BigInt(cur)),reachedBound:Boolean(next && BigInt(next)>=BigInt(end)),seedAtEnd:store.seedAtEnd(key)});
          if(cacheInvalidated)break;
          if(next && BigInt(next)>BigInt(cur)){cur=next;cursors.set(key,cur);}else break;
          if(!hasMore || !result.fieldPresent || !result.receivedCount || BigInt(cur)>=BigInt(end))break;
          await (factory.delay ?? (ms=>new Promise(resolve=>setTimeout(resolve,ms))))(100);
          if(closed)return false;
        }
        let gap=complete && BigInt(cur)<BigInt(end);
        // Experimental, opt-in server mode: one alternative read for a range
        // which SYNCMSG declared complete before the known room end.
        const gapRange=cur+':'+end;
        if(!cacheInvalidated && gap && factory.gapProbe===true && gapProbes.get(key)!==gapRange){
          if(remaining()<10250)budgetStopped=true;
          else{
            gapProbes.set(key,gapRange);
            const response=await carriage.request('MCHATLOGS',{chatIds:[factory.toLong(store.serverRoomId(key))],sinces:[factory.toLong(cur)]},10000);
            if(closed)return false;
            if(responseStatus(response)!==0){
              const status=responseStatus(response);if(!Number.isInteger(status))throw new Error('history_status_unknown');
              emit({type:'reader-request-rejected',key,requestId,status});return true;
            }
            cacheInvalidated ||= store.cacheEpoch(key)!==cacheEpoch;
            result=store.history(key,response.body,{requireRoomId:true});receivedCount+=result.receivedCount;acceptedCount+=result.acceptedCount;rejectedCount+=result.rejectedCount;fieldPresent ||= result.fieldPresent;
            const next=store.historyCursor(key,response.body,{requireRoomId:true});
            const advanced=Boolean(next && BigInt(next)>BigInt(cur));
            if(advanced && !cacheInvalidated){cur=next;cursors.set(key,cur);}
            gap=BigInt(cur)<BigInt(end);
            factory.observeHistory?.({method:'MCHATLOGS',receivedCount:result.receivedCount,acceptedCount:result.acceptedCount,rejectedCount:result.rejectedCount,fieldPresent:result.fieldPresent,cursorAdvanced:advanced,reachedBound:!gap,seedAtEnd:store.seedAtEnd(key)});
          }
        }
        cacheInvalidated ||= store.cacheEpoch(key)!==cacheEpoch;
        if(cacheInvalidated){cursors.delete(key);gapProbes.delete(key);}
        emit({type:'reader-messages',...result,...(cacheInvalidated || budgetStopped?{latestVisible:false}:{}),fieldPresent,receivedCount,acceptedCount,rejectedCount,hasMore:cacheInvalidated || budgetStopped || hasMore,gap:cacheInvalidated || gap,requestId,source:'history'});return true;
      } catch {if(!closed){emit({type:'reader-failed',stage:'history',status:null});close();}return false;}
      finally{busy=false;scheduleDiscovery();}
    },
    async action(key,requestId,action,payload={}){
      const started=Date.now(),bound=max=>{const remaining=22500-(Date.now()-started);if(remaining<=0)throw new Error('action_deadline');return Math.min(max,remaining);};
      if(titlePromise)await titlePromise;
      if(discoveryPromise)await discoveryPromise;
      if(factory.messaging!==true || closed || busy || !store?.has(key))return false;
      if(!['send','photo','context','read'].includes(action))return false;
      const capability=action==='send' && payload.replyTo!==undefined?'reply':action;
      // A member open room may establish its first verified own-member context
      // through canContext; actions are checked again after the matching ACK.
      if(!store.canAction(key,capability) && !(store.isOpen(key) && store.canAction(key,'context')))return false;
      if(action==='send' && (typeof payload.text!=='string' || !payload.text.trim() || [...payload.text].length>4000))return false;
      const extra=action==='send' && payload.replyTo!==undefined?messageKeyValid(payload.replyTo) && store.replyForMessage(key,payload.replyTo):null;
      if(action==='send' && payload.replyTo!==undefined && !extra)return false;
      const image=action==='photo'?decodeImage(payload.image):null;if(action==='photo' && (!image || typeof factory.media!=='function'))return false;
      const readTarget=action==='read'?store.readTargetForMessage(key,payload.message):null;
      const watermark=readTarget?.logId;
      if(action==='read' && !watermark)return false;
      busy=true;
      activate(key);
      const result=(phase,status=null,messageKey)=>emit({type:'reader-action',key,requestId,action,phase,status,entryPhase:entryReady(key)?'acknowledged':'failed',...(action==='context'?{receiptPhase:entryReady(key)?entries.get(key).receiptReady?'ready':'unavailable':'idle'}:{}),...(messageKey?{messageKey}:{})});
      try{
        const chatId=factory.toLong(store.serverRoomId(key));
        if(action==='context' || action==='read' || store.isOpen(key)){
          const entry=await ensureEntry(key,bound);if(closed)return false;
          if(!entry.ready){result('failed',entry.status ?? null);return true;}
          if(!store.canAction(key,capability)){result('unavailable',0);return true;}
          if(action==='context'){result(entry.receiptReady?'accepted':'unavailable',0);return true;}
        }
        let beforeRead=null;
        const probeRead=action==='read' && factory.readProbe===true && !readProbed.has(key) && readProbed.size<8;
        const inspectRead=async()=>{
          try{
            const snapshot=await carriage.request('CHATINFO',{chatId},bound(2500),{optional:true});
            if(responseStatus(snapshot)!==0)return {roomMatched:false,seenAtLeastTarget:null};
            return compareReadPosition(snapshot.body,store.serverRoomId(key),watermark);
          }catch{return {roomMatched:false,seenAtLeastTarget:null};}
        };
        if(probeRead){readProbed.add(key);beforeRead=await inspectRead();if(closed)return false;}
        if((action==='read' || store.isOpen(key)) && (!entryReady(key) || !store.canAction(key,capability))){result('failed');return true;}
        if(action==='photo'){
          const version=store.receiptVersion(key),selection=selectionVersion,requiresEntry=store.isOpen(key),readOnSend=store.canAction(key,'read'),controller=new AbortController();
          activePhoto={key,controller};
          const isCurrent=()=>!closed && activeRoom===key && selectionVersion===selection && store.receiptVersion(key)===version && store.canAction(key,'photo') && (!readOnSend || store.canAction(key,'read')) && (!requiresEntry || entryReady(key));
          let outcome;
          try{outcome=await uploadPhoto({carriage,createClient:factory.media,toLong:factory.toLong,chatId:store.serverRoomId(key),userId:credential.userId,messageId:String(++nextMessageId),data:image.data,signal:AbortSignal.any([uploadAbort.signal,controller.signal]),isCurrent,readOnSend,resolve:factory.resolveUpload,profile:PROFILE,observe:factory.observeUpload});}
          finally{if(activePhoto?.controller===controller)activePhoto=null;}
          if(closed)return false;
          let update=null;
          if(outcome.phase==='accepted' && outcome.chatLog){update=store.writeAccepted(key,outcome.completeBody ?? {chatLog:outcome.chatLog},'[사진]',{type:2});if(update)publish(update,'sent');}
          result(outcome.phase==='accepted' && !update?'unknown':outcome.phase,outcome.status,update?.messageKey);
          return true;
        }
        const expectedMessageId=action==='send'?++nextMessageId:null;
        const response=action==='send'
          ?await carriage.request('WRITE',{chatId,msgId:expectedMessageId,type:extra?26:1,noSeen:!store.canAction(key,'read'),msg:payload.text,...(extra?{extra}:{})},bound(20000))
          :await carriage.request('NOTIREAD',{chatId,watermark:factory.toLong(watermark),...(store.isOpen(key)?{li:factory.toLong(store.linkId(key))}:{})},bound(9000),{recoverable:true});
        if(closed)return false;
        const status=responseStatus(response);
        if(status!==0){result(action==='send' && status===null?'unknown':'failed',status);if(!Number.isInteger(status)){emit({type:'reader-failed',stage:action,status});close();}return true;}
        if(action==='send'){
          if(response.body?.msgId!==undefined && String(response.body.msgId)!==String(expectedMessageId))throw new Error('write_correlation');
          const update=store.writeAccepted(key,response.body,payload.text,{type:extra?26:1,attachment:extra});
          if(update)publish(update,'sent');
          result(update?'accepted':'unknown',0,update?.messageKey);
        }else{
          // status0 acknowledges the request, not the peer's displayed unread count.
          if(probeRead){
            const afterRead=await inspectRead();if(closed)return false;
            factory.observeRead?.({before:beforeRead,after:afterRead,targetIsOwn:readTarget.mine,requestedIsOwn:readTarget.requestedIsOwn});
          }
          result(entryReady(key)?'accepted':'unknown',0);
        }
        return true;
      }catch(error){
        if(!closed){const recoverable=error?.code==='READER_REQUEST_TIMEOUT' && action!=='send';result(action==='read' || action==='send' || action==='photo' && !recoverable?'unknown':'failed');if(!recoverable){emit({type:'reader-failed',stage:action,status:null});close();}}
        return true;
      }finally{busy=false;scheduleDiscovery();}
    },
    close,
  };
}
