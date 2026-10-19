import { probeRoomCount } from './room-probe.mjs';
import { createReaderStore,logArray,serverId,compareReadPosition } from './reader-data.mjs';
import { responseStatus } from './reader-response.mjs';
import { decodeImage,messageKeyValid } from './message-content.mjs';
import { uploadPhoto } from './media-upload.mjs';
import { uploadPhotoHttps } from './media-upload-https.mjs';
import { DEFAULT_PHOTO_TRANSPORT,normalizePhotoTransport } from './photo-transport.mjs';
import { PROFILE } from './kakao-auth.mjs';

export const allowedReaderMethod = (method,{messaging=false}={}) => ['GETCONF','CHECKIN','LOGINLIST','SYNCMSG','MCHATLOGS','PING','CHATINFO'].includes(method)
  || messaging===true && ['WRITE','CHATONROOM','NOTIREAD','SHIP','SYNCLINK','INFOLINK','MEMBER'].includes(method);

export function createReaderSession(credential,factory,emit) {
  const photoTransport=normalizePhotoTransport(factory.photoTransport ?? DEFAULT_PHOTO_TRANSPORT);
  let carriage,store,closed=false,busy=false,resolveStop,pingTimer=null,pingPending=false,pingMisses=0;
  const cursors=new Map();
  const gapProbes=new Map();
  const readProbed=new Set();
  const entries=new Map();let activeRoom=null,selectionVersion=0;
  const discoveryQueue=new Map(),discoveryAttempts=new Map();let discoveryPromise=null,discoveryInFlight=null,discoverTimer=null;
  const now=factory.now ?? (()=>performance.now());
  let titleQueue=[],titlePromise=null,titleChanged=false,aliveAt=-Infinity;
  const memberLookups=new Set();
  // Discovery replays are bounded in bytes, not only packet counts.
  const DISCOVERY_BYTES=2*1024*1024,ATTACHMENT_BYTES=8192;
  const queuedBytes=()=>[...discoveryQueue.values(),...(discoveryInFlight?[discoveryInFlight.packets]:[])].reduce((n,packets)=>n+(packets.bytes ?? 0),0);
  const eligibleDiscovery=()=>[...discoveryQueue].find(([,packets])=>packets.ready!==false);
  const alive=()=>{const at=Date.now();if(at-aliveAt<30000)return;aliveAt=at;emit({type:'reader-alive',at});};
  let nextMessageId=Date.now()%0x3fffffff;
  const observeSend=details=>{try{factory.observeSend?.(details);}catch{/* Diagnostics cannot change a send outcome. */}};
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
    clearInterval(pingTimer);clearTimeout(discoverTimer);carriage?.stopPing();carriage?.disconnect();store?.clear();cursors.clear();memberLookups.clear();gapProbes.clear();readProbed.clear();entries.clear();activeRoom=null;discoveryQueue.clear();discoveryAttempts.clear();titleQueue=[];resolveStop();
  };
  function activate(key){
    if(activeRoom===key)return;
    const previous=activeRoom;activeRoom=key;selectionVersion++;entries.clear();store?.pin(key); // The active room is never display-LRU evicted.
    if(previous)invalidatePhoto(previous);
    if(previous && store?.has(previous))publish({...store.current(previous),entryInvalidated:true},'receipt');
  }
  function entryReady(key){return activeRoom===key && entries.get(key)?.version===store.receiptVersion(key) && entries.get(key)?.selection===selectionVersion;}
  async function ensureEntry(key,bound,trace=()=>{}){
    if(entryReady(key))return {ready:true,receiptReady:entries.get(key).receiptReady};
    if(!store.canAction(key,'context'))return {ready:false};
    const version=store.receiptVersion(key),selection=selectionVersion;
    store.recent(key);
    const response=await carriage.request('CHATONROOM',{chatId:factory.toLong(store.serverRoomId(key)),token:factory.toLong(store.entryToken(key)),opt:store.entryOption(key)},bound(5500),{recoverable:true});
    trace('entry',{status:responseStatus(response)});
    if(closed || responseStatus(response)!==0 || response.method!==undefined && response.method!=='CHATONROOM' || activeRoom!==key || selectionVersion!==selection || version!==store.receiptVersion(key))return {ready:false,status:responseStatus(response)};
    if(!store.entrySnapshot(key,response.body,version))return {ready:false,status:0};
    if(store.takeOwnMemberLookup(key,version)){
      trace('member_lookup');
      try{
        const member=await carriage.request('MEMBER',{chatId:factory.toLong(store.serverRoomId(key)),memberIds:[factory.toLong(credential.userId)]},bound(2500),{optional:true});
        if(closed || activeRoom!==key || selectionVersion!==selection || version!==store.receiptVersion(key))return {ready:false,status:0};
        const status=responseStatus(member);
        if(status===0 && (member.method===undefined || member.method==='MEMBER') && store.ownMemberSnapshot(key,member.body,version))trace('member_verified',{status:0});
        else trace('member_lookup',{status,reason:status!==0?'member_rejected':Array.isArray(member.body?.members) && member.body.members.length===0?'member_missing':'member_invalid'});
      }catch(error){trace('member_lookup',{reason:error?.code==='READER_REQUEST_TIMEOUT'?'member_timeout':'member_invalid'});}
      if(closed || activeRoom!==key || selectionVersion!==selection || version!==store.receiptVersion(key))return {ready:false,status:0};
    }
    const receiptReady=store.receiptSnapshot(key,response.body,version);
    entries.set(key,{version,selection,receiptReady});
    store.recent(key);publish(store.current(key),'receipt');void lookupMembers(key);
    return {ready:true,receiptReady};
  }
  // Read-only MEMBER name lookup: once per opened room and connection, at most
  // five exact-correlated optional requests of 100 IDs. Failure keeps aliases.
  async function lookupMembers(key){
    if(factory.messaging!==true || closed || memberLookups.has(key) || !store.has(key))return;memberLookups.add(key);
    const ids=store.unnamedMembers(key);
    for(let n=0;n<ids.length && n<500 && !closed && store.has(key);n+=100){
      const batch=ids.slice(n,n+100);
      try{
        const response=await carriage.request('MEMBER',{chatId:factory.toLong(store.serverRoomId(key)),memberIds:batch.map(id=>factory.toLong(id))},2500,{optional:true});
        if(!closed && responseStatus(response)===0 && (response.method===undefined || response.method==='MEMBER') && store.applyMembers(key,response.body,batch))emit({type:'reader-messages',...store.current(key),source:'receipt'});
      }catch{/* Optional lookup expiry/refusal leaves the current labels. */}
    }
  }
  function scheduleDiscovery(){
    clearTimeout(discoverTimer);
    if(closed || busy || discoveryPromise || titlePromise || !eligibleDiscovery() && !titleQueue.length)return;
    discoverTimer=setTimeout(()=>{
      if(closed || busy || discoveryPromise || titlePromise)return;
      const next=eligibleDiscovery();
      if(!next){
        const key=titleQueue.shift();if(!key)return;
        titlePromise=Promise.resolve().then(async()=>{
          if(closed)return;
          try{
            const response=await carriage.request('CHATINFO',{chatId:factory.toLong(store.serverRoomId(key))},3000,{optional:true});
            if(closed || responseStatus(response)!==0 || response?.method!==undefined && response.method!=='CHATINFO')return;
            if(store.recoverTitle(key,response.body))titleChanged=true;
          }catch{
            // Optional metadata rejection/decoding is nonfatal. A real socket
            // error/close still reaches the existing transport listeners.
          }
        }).finally(()=>{
          titlePromise=null;
          // One room list after the repair batch rather than one per recovered title.
          if(!closed && titleChanged && !titleQueue.length){titleChanged=false;emit({type:'reader-rooms',rooms:store.rooms(),stats:store.stats(),source:'push'});}
          scheduleDiscovery();
        });
        return;
      }
      const [id,packets]=next;discoveryQueue.delete(id);
      const attempt=discoveryAttempts.get(id);attempt.count++;attempt.terminal=true;
      discoveryInFlight={id,packets};
      discoveryPromise=(async()=>{
        try{
          const response=await carriage.request('CHATINFO',{chatId:factory.toLong(id)},5000,{optional:true});
          if(closed)return;
          if(responseStatus(response)!==0 || response?.method!==undefined && response.method!=='CHATINFO')return;
          const key=store.discover(id,response.body);if(!key)return;
          // Publish the vetted room before any messages referencing its handle.
          publish(null,'push');
          for(const packet of packets)for(const update of store.push(packet))publish(packets.partial?{...update,partial:true}:update,'push');
          if(packets.partial && !packets.length)publish({...store.current(key),partial:true},'push');
        }catch(error){
          if(!closed && error?.code==='READER_REQUEST_TIMEOUT' && attempt.count<3){
            // Retain bounded replay data, but only a later push can re-enable it.
            attempt.terminal=false;attempt.retryAt=now()+3000;packets.ready=false;discoveryQueue.set(id,packets);
          }
          // All other optional failures/refusals stay terminal and nonfatal.
        }
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
            alive();
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
                let attempt=discoveryAttempts.get(id);
                if(!attempt){if(discoveryAttempts.size>=500)continue;attempt={count:0,retryAt:0,terminal:false,partial:false};discoveryAttempts.set(id,attempt);}
                if(discoveryInFlight?.id!==id && attempt.terminal)continue;
                if(discoveryInFlight?.id!==id && !discoveryQueue.has(id)){
                  if(discoveryQueue.size+(discoveryInFlight?1:0)>=20){attempt.partial=true;continue;}
                  discoveryQueue.set(id,[]);
                }
                const packets=discoveryInFlight?.id===id?discoveryInFlight.packets:discoveryQueue.get(id);
                if(!packets)continue;
                if(discoveryInFlight?.id!==id)packets.ready=attempt.count===0 || now()>=attempt.retryAt;
                if(attempt.partial)packets.partial=true;
                const remaining=50-packets.reduce((n,p)=>n+p.chatLogs.length,0);
                const sourceLogs=logArray(packet.body) ?? [];
                const validLogs=sourceLogs.slice(0,200).filter(log=>{
                  const attached=serverId(log?.chatId ?? log?.roomId ?? log?.c);
                  return log && serverId(log.logId ?? log.msgId ?? log.id) && (!attached || attached===id);
                });
                if(sourceLogs.length>200 || validLogs.length>remaining)packets.partial=true;
                const logs=validLogs.slice(0,remaining).map(log=>({logId:serverId(log.logId ?? log.msgId ?? log.id),authorId:serverId(log.authorId ?? log.senderId ?? log.userId ?? log.writerId ?? log.sender?.userId),
                  msg:[...(typeof (log.message ?? log.msg ?? log.text ?? log.content)==='string'?(log.message ?? log.msg ?? log.text ?? log.content):'')].slice(0,4000).join(''),
                  type:Number(log.type ?? log.msgType ?? log.t ?? 1),attachment:[2,26,27].includes(Number(log.type ?? log.msgType ?? log.t ?? 1)) && typeof log.attachment==='string' && log.attachment.length<=ATTACHMENT_BYTES?log.attachment:undefined,sendAt:Number(log.sendAt ?? log.createdAt),senderName:typeof (log.senderName ?? log.authorName)==='string'?(log.senderName ?? log.authorName).slice(0,80):''}));
                const bytes=logs.reduce((n,log)=>n+256+2*(log.msg.length+(log.attachment?.length ?? 0)+log.senderName.length),0);
                // Over budget: drop this room's further replays and mark it partial.
                if(logs.length && queuedBytes()+bytes>DISCOVERY_BYTES)packets.partial=true;
                else if(logs.length){packets.push({chatId:id,chatLogs:logs});packets.bytes=(packets.bytes ?? 0)+bytes;}
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
            try{const response=await carriage.request('PING',{},10000,{recoverable:true});if(!closed && responseStatus(response)!==0)fail('ping',responseStatus(response));else{pingMisses=0;if(!closed)alive();}}
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
    view(key){if(closed || !store?.has(key))return false;activate(key);return true;},
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
      const image=action==='photo'?decodeImage(payload.image):null;if(action==='photo' && (!image || photoTransport==='loco' && typeof factory.media!=='function'))return false;
      const readTarget=action==='read'?store.readTargetForMessage(key,payload.message):null;
      const watermark=readTarget?.logId;
      if(action==='read' && !watermark)return false;
      busy=true;
      activate(key);
      let writeAttempted=false;
      const trace=(stage,details={})=>{if(action==='send')observeSend({stage,...(stage==='start'?{kind:payload.replyTo===undefined?'text':'reply'}:{}),writeAttempted,...details});};
      const blockedReason=()=>['send','photo'].includes(action) && store.isOpen(key) && !store.canAction(key,'read')?'open_member_unverified':undefined;
      const result=(phase,status=null,messageKey,reason,diagnosticReason)=>{
        if(phase==='failed' && !writeAttempted)trace('blocked',{phase,status,reason:reason ?? diagnosticReason ?? 'permission_changed'});
        trace('result',{phase,status,...(reason || diagnosticReason?{reason:reason ?? diagnosticReason}:{})});
        emit({type:'reader-action',key,requestId,action,phase,status,entryPhase:entryReady(key)?'acknowledged':'failed',...(action==='context'?{receiptPhase:entryReady(key)?entries.get(key).receiptReady?'ready':'unavailable':'idle'}:{}),...(messageKey?{messageKey}:{}),...(['open_member_unverified','photo_jpeg_required'].includes(reason)?{reason}:{})});
      };
      trace('start');
      try{
        const chatId=factory.toLong(store.serverRoomId(key));
        if(action==='context' || action==='read' || store.isOpen(key)){
          const entry=await ensureEntry(key,bound,trace);if(closed)return false;
          if(!entry.ready){result('failed',entry.status ?? null,undefined,blockedReason(),'entry_unavailable');return true;}
          if(!store.canAction(key,capability)){result(['send','photo'].includes(action)?'failed':'unavailable',0,undefined,blockedReason());return true;}
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
        if((action==='read' || store.isOpen(key)) && (!entryReady(key) || !store.canAction(key,capability))){result('failed',['send','photo'].includes(action)?0:null,undefined,blockedReason());return true;}
        if(action==='photo'){
          const version=store.receiptVersion(key),selection=selectionVersion,requiresEntry=store.isOpen(key),readOnSend=store.canAction(key,'read'),controller=new AbortController();
          activePhoto={key,controller};
          const isCurrent=()=>!closed && activeRoom===key && selectionVersion===selection && store.receiptVersion(key)===version && store.canAction(key,'photo') && (!readOnSend || store.canAction(key,'read')) && (!requiresEntry || entryReady(key));
          let outcome;
          try{
            const options={carriage,toLong:factory.toLong,chatId:store.serverRoomId(key),userId:credential.userId,messageId:String(++nextMessageId),data:image.data,signal:AbortSignal.any([uploadAbort.signal,controller.signal]),isCurrent,readOnSend,observe:factory.observeUpload};
            outcome=photoTransport==='https'
              ?await uploadPhotoHttps({...options,timeout:bound(20000),resolve:factory.resolveHttpsUpload,request:factory.requestHttpsUpload})
              :await uploadPhoto({...options,createClient:factory.media,resolve:factory.resolveUpload,profile:PROFILE});
          }
          finally{if(activePhoto?.controller===controller)activePhoto=null;}
          if(closed)return false;
          let update=null;
          if(outcome.phase==='accepted' && outcome.chatLog){update=store.writeAccepted(key,outcome.completeBody ?? {chatLog:outcome.chatLog},'[사진]',{type:2,...(outcome.attachment?{attachment:outcome.attachment}:{})});if(update)publish(update,'sent');}
          result(outcome.phase==='accepted' && !update?'unknown':outcome.phase,outcome.status,update?.messageKey,outcome.reason);
          return true;
        }
        const expectedMessageId=action==='send'?++nextMessageId:null;
        let response;
        if(action==='send'){
          const body={chatId,msgId:factory.toLong(String(expectedMessageId)),type:extra?26:1,noSeen:!store.canAction(key,'read'),msg:payload.text,scope:1,silence:false,...(extra?{extra}:{})},timeout=bound(20000);
          writeAttempted=true;
          trace('write_attempt');
          response=await carriage.request('WRITE',body,timeout);
        }else response=await carriage.request('NOTIREAD',{chatId,watermark:factory.toLong(watermark),...(store.isOpen(key)?{li:factory.toLong(store.linkId(key))}:{})},bound(9000),{recoverable:true});
        if(closed)return false;
        const status=responseStatus(response);
        trace('response',{status});
        if(status!==0){result(action==='send' && status===null?'unknown':'failed',status,undefined,undefined,Number.isInteger(status)?'write_rejected':'transport');if(!Number.isInteger(status)){emit({type:'reader-failed',stage:action,status});close();}return true;}
        if(action==='send'){
          if(response.body?.msgId!==undefined && String(response.body.msgId)!==String(expectedMessageId))throw new Error('write_correlation');
          const update=store.writeAccepted(key,response.body,payload.text,{type:extra?26:1,attachment:extra});
          if(update)publish(update,'sent');
          result(update?'accepted':'unknown',0,update?.messageKey,undefined,update?undefined:'write_ack_unrecognized');
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
        if(!closed){const beforeWrite=action==='send' && !writeAttempted,recoverable=error?.code==='READER_REQUEST_TIMEOUT' && (action!=='send' || beforeWrite);result(beforeWrite?'failed':action==='read' || action==='send' || action==='photo' && !recoverable?'unknown':'failed',null,undefined,undefined,error?.message==='write_correlation'?'write_correlation':error?.code==='READER_REQUEST_TIMEOUT'?'write_timeout':'transport');if(!recoverable){emit({type:'reader-failed',stage:action,status:null});close();}}
        return true;
      }finally{busy=false;scheduleDiscovery();}
    },
    close,
  };
}
