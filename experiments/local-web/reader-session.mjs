import { probeRoomCount } from './room-probe.mjs';
import { createReaderStore,logArray,serverId,compareReadPosition,messageNickname,CACHE_LIMIT } from './reader-data.mjs';
import { responseStatus } from './reader-response.mjs';
import { decodeImage,messageKeyValid } from './message-content.mjs';
import { uploadPhoto } from './media-upload.mjs';
import { uploadPhotoHttps } from './media-upload-https.mjs';
import { DEFAULT_PHOTO_TRANSPORT,normalizePhotoTransport } from './photo-transport.mjs';
import { PROFILE } from './kakao-auth.mjs';
import { safeFault } from './reader-diagnostics.mjs';

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
  const linkRepairs=new Map();let activeLinkRepair=null;
  const now=factory.now ?? (()=>performance.now());
  let titleQueue=[],titlePromise=null,titleInFlight=null,titleChanged=false,aliveAt=-Infinity;
  const titleAttempts=new Set(),memberLookups=new Map(),metadataWaits=new Set();
  const visibleViews=new Map();
  const pendingOwnReads=new Set();
  let memberInFlight=null,pendingMembers=null;
  // Discovery replays are bounded in bytes, not only packet counts.
  const DISCOVERY_BYTES=2*1024*1024,ATTACHMENT_BYTES=8192;
  const queuedBytes=()=>[...discoveryQueue.values(),...(discoveryInFlight?[discoveryInFlight.packets]:[])].reduce((n,packets)=>n+(packets.bytes ?? 0),0);
  const eligibleDiscovery=()=>[...discoveryQueue].find(([,packets])=>packets.ready!==false);
  const alive=()=>{const at=Date.now();if(at-aliveAt<30000)return;aliveAt=at;emit({type:'reader-alive',at});};
  let nextMessageId=Date.now()%0x3fffffff;
  const observeSend=details=>{try{factory.observeSend?.(details);}catch{/* Diagnostics cannot change a send outcome. */}};
  const observeOwnRead=(stage,reason)=>{try{factory.observeOwnRead?.(stage,reason);}catch{/* Diagnostics cannot change inbound read handling. */}};
  const uploadAbort=new AbortController();
  let activePhoto=null;
  const invalidatePhoto=key=>{if(activePhoto?.key===key)activePhoto.controller.abort();};
  const emitRooms=source=>emit({type:'reader-rooms',rooms:store.rooms(),stats:store.stats(),source,seedBounds:store.seedBounds()});
  function emitMessages(update,source,{preserveLatest=false,arrivalProof}={}){
    // Display metadata cannot promote an incomplete history page to latest.
    const latestVisible=preserveLatest?visibleViews.get(update.key)===true:update.latestVisible===true;
    visibleViews.delete(update.key);visibleViews.set(update.key,latestVisible);
    while(visibleViews.size>CACHE_LIMIT)visibleViews.delete(visibleViews.keys().next().value);
    emit({type:'reader-messages',...update,latestVisible,source,...(source==='push'?{arrivalProof:arrivalProof ?? []}:{})});
  }
  const publish=(update,source,body)=>{
    if(update)emitMessages(update,source,{arrivalProof:source==='push'?store.arrivalProof(update.key,update.arrivals,body):undefined});
    emitRooms('push');
  };
  const stopped=new Promise(resolve=>{resolveStop=resolve;});
  const close=()=>{
    if(closed)return;closed=true;uploadAbort.abort();activeLinkRepair?.controller.abort();linkRepairs.clear();
    for(const cancel of metadataWaits)cancel();metadataWaits.clear();pendingMembers=null;memberInFlight=null;visibleViews.clear();pendingOwnReads.clear();
    clearInterval(pingTimer);clearTimeout(discoverTimer);carriage?.stopPing();carriage?.disconnect();store?.clear();cursors.clear();memberLookups.clear();gapProbes.clear();readProbed.clear();entries.clear();activeRoom=null;discoveryQueue.clear();discoveryAttempts.clear();titleQueue=[];titleAttempts.clear();resolveStop();
  };
  function activate(key){
    if(activeRoom===key)return;
    activeLinkRepair?.controller.abort();
    const previous=activeRoom;activeRoom=key;selectionVersion++;entries.clear();pendingMembers=null;store?.pin(key); // The active room is never display-LRU evicted.
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
    store.recent(key);publish(store.current(key),'receipt');lookupMembers(key,{visibleOnly:false});
    return {ready:true,receiptReady};
  }
  const scope=key=>({key,id:store.serverRoomId(key),selection:selectionVersion,version:store.receiptVersion(key),linkId:store.linkId(key)});
  const currentScope=work=>!closed && store?.has(work.key) && activeRoom===work.key && work.selection===selectionVersion
    && work.id===store.serverRoomId(work.key) && work.version===store.receiptVersion(work.key) && work.linkId===store.linkId(work.key);
  // Session deadlines also cover injected transports. Late SDK results are
  // observed but never applied after expiry, selection changes or shutdown.
  function optionalMetadata(operation,timeout){
    return new Promise((resolve,reject)=>{
      let done=false,timer;
      const finish=(fn,value)=>{if(done)return;done=true;clearTimeout(timer);metadataWaits.delete(cancel);fn(value);};
      const cancel=()=>finish(reject,new Error('metadata_cancelled'));
      metadataWaits.add(cancel);timer=setTimeout(()=>finish(reject,new Error('metadata_expired')),timeout);timer.unref?.();
      try{if(closed){cancel();return;}Promise.resolve(operation()).then(value=>finish(resolve,value),error=>finish(reject,error));}catch(error){finish(reject,error);}
    });
  }
  const namesEligible=work=>factory.messaging===true && currentScope(work) && entryReady(work.key) && store.canAction(work.key,'read');
  function nameState(key){
    const at=now();
    for(const [candidate,state] of memberLookups){
      state.requests=state.requests.filter(time=>at-time<60000);
      for(const [id,until] of state.negative)if(at>=until)state.negative.delete(id);
      if(candidate!==key && candidate!==memberInFlight?.key && !state.requests.length && !state.negative.size)memberLookups.delete(candidate);
    }
    let state=memberLookups.get(key);if(!state)state={requests:[],negative:new Map()};
    // Do not evict an unexpired budget/cache and accidentally permit a retry.
    if(!memberLookups.has(key) && memberLookups.size>=64)return null;
    memberLookups.delete(key);memberLookups.set(key,state);
    return state;
  }
  function lookupMembers(key,{visibleOnly=true}={}){
    if(closed || !store?.has(key))return;
    const work={...scope(key),visibleOnly};if(!namesEligible(work))return;
    pendingMembers=work;drainMembers();
  }
  function drainMembers(){
    if(closed || memberInFlight || !pendingMembers)return;
    const work=pendingMembers;pendingMembers=null;if(!namesEligible(work))return;
    const at=now(),state=nameState(work.key);if(!state)return;
    state.requests=state.requests.filter(time=>at-time<60000);
    for(const [id,until] of state.negative)if(at>=until)state.negative.delete(id);
    const batch=store.unnamedMembers(work.key,{visibleOnly:work.visibleOnly}).filter(id=>!state.negative.has(id)).slice(0,Math.min(100,500-state.negative.size));
    if(!batch.length || state.requests.length>=5)return;
    state.requests.push(at);memberInFlight=work;
    void (async()=>{
      let finished=false,settled=false;
      const release=()=>{if(!finished || !settled)return;if(memberInFlight===work)memberInFlight=null;drainMembers();};
      try{
        const response=await optionalMetadata(()=>{
          try{return Promise.resolve(carriage.request('MEMBER',{chatId:factory.toLong(work.id),memberIds:batch.map(id=>factory.toLong(id))},2500,{optional:true})).finally(()=>{settled=true;release();});}
          catch(error){settled=true;throw error;}
        },2500);
        if(namesEligible(work) && responseStatus(response)===0 && (response.method===undefined || response.method==='MEMBER') && store.applyMembers(work.key,response.body,batch))emitMessages(store.current(work.key),'receipt',{preserveLatest:true});
      }catch{/* Optional expiry/refusal keeps aliases and never fails the carriage. */}
      finally{
        if(namesEligible(work)){
          for(const id of batch)if(!store.memberNameKnown(work.key,id)){state.negative.delete(id);state.negative.set(id,now()+300000);}
          while(state.negative.size>500)state.negative.delete(state.negative.keys().next().value);
        }
        // Only an independent event can have queued this next pass. A response
        // never starts the next old roster batch or a timer-only retry.
        // Even a transport that ignores its deadline cannot overlap two names
        // requests. The real SDK settles its optional request at that deadline.
        finished=true;release();
      }
    })();
  }
  function selectTitle(key){
    if(closed || !store.titleMissing(key) || titleAttempts.has(key))return;
    titleAttempts.add(key);titleQueue.push({...scope(key),selected:true});scheduleDiscovery();
  }
  const needsLinkRepair=key=>factory.messaging===true && store?.has(key) && store.isOpen(key) && store.missingOpenLinkIds(1,[key]).length>0;
  const eligibleLinkRepair=()=>[...linkRepairs].find(([key,attempt])=>attempt.ready && !attempt.terminal && attempt.count<3 && now()>=attempt.retryAt && needsLinkRepair(key));
  // A discovered CHATINFO room is existing membership, not permission to JOIN
  // or send. Enrich only that room; explicit entry still verifies our member.
  async function repairLink(key){
    const attempt=linkRepairs.get(key);if(!attempt || attempt.count>=3 || !needsLinkRepair(key))return;
    attempt.ready=false;attempt.count++;
    const controller=new AbortController(),selection=selectionVersion,id=store.linkId(key),deadline=now()+6500;
    let version=store.receiptVersion(key);activeLinkRepair={key,controller};
    const current=()=>!closed && !controller.signal.aborted && selectionVersion===selection && store?.has(key) && store.receiptVersion(key)===version && store.linkId(key)===id && needsLinkRepair(key);
    const wait=operation=>new Promise((resolve,reject)=>{
      let done=false;
      const finish=(fn,value)=>{if(done)return;done=true;controller.signal.removeEventListener('abort',abort);fn(value);};
      const abort=()=>finish(reject,new Error('link_metadata_cancelled'));
      controller.signal.addEventListener('abort',abort,{once:true});
      try{if(!current())throw new Error('link_metadata_stale');Promise.resolve(operation()).then(value=>finish(resolve,value),error=>finish(reject,error));}catch(error){finish(reject,error);}
    });
    const request=(method,body,max)=>{const remaining=deadline-now();if(remaining<=0 || !current())throw new Error('link_metadata_stale');return wait(()=>carriage.request(method,body,Math.max(1,Math.min(max,remaining)),{optional:true}));};
    const timer=setTimeout(()=>controller.abort(),6500);timer.unref?.();
    try{
      try{
        const response=await request('SYNCLINK',{ltk:0},4000);
        if(current() && responseStatus(response)===0 && (response.method===undefined || response.method==='SYNCLINK')){
          store.syncLinks(response.body,new Map([[key,version]]));version=store.receiptVersion(key);
        }
      }catch{/* A bounded optional refusal can use the existing-link fallback. */}
      if(current()){
        const versions=new Map([[key,version]]);
        try{
          const response=await request('INFOLINK',{lis:[factory.toLong(id)]},2500);
          if(current() && responseStatus(response)===0 && (response.method===undefined || response.method==='INFOLINK'))store.infoLinks(response.body,[id],versions);
        }catch{/* Leave unavailable metadata disabled; never infer membership. */}
      }
    }finally{
      clearTimeout(timer);if(activeLinkRepair?.controller===controller)activeLinkRepair=null;
      if(!closed){attempt.ready=false;attempt.terminal=attempt.count>=3 || !needsLinkRepair(key);attempt.retryAt=now()+3000;emitRooms('push');}
    }
  }
  function scheduleDiscovery(){
    clearTimeout(discoverTimer);
    if(closed || busy || discoveryPromise || titlePromise || !eligibleDiscovery() && !eligibleLinkRepair() && !titleQueue.length)return;
    discoverTimer=setTimeout(()=>{
      if(closed || busy || discoveryPromise || titlePromise)return;
      const next=eligibleDiscovery();
      if(!next){
        const link=eligibleLinkRepair();
        if(link){discoveryPromise=repairLink(link[0]).finally(()=>{discoveryPromise=null;scheduleDiscovery();});return;}
        const work=titleQueue.shift();if(!work)return;const {key}=work;titleInFlight=work;
        titlePromise=Promise.resolve().then(async()=>{
          if(closed || work.selected && (!currentScope(work) || !store.titleMissing(key)))return;
          try{
            const request=()=>carriage.request('CHATINFO',{chatId:factory.toLong(store.serverRoomId(key))},3000,{optional:true});
            const response=work.selected?await optionalMetadata(request,3000):await request();
            if(closed || work.selected && !currentScope(work) || responseStatus(response)!==0 || response?.method!==undefined && response.method!=='CHATINFO')return;
            if(store.recoverTitle(key,response.body))titleChanged=true;
          }catch{
            // Optional metadata rejection/decoding is nonfatal. A real socket
            // error/close still reaches the existing transport listeners.
          }
        }).finally(()=>{
          titlePromise=null;titleInFlight=null;
          // One room list after the repair batch rather than one per recovered title.
          if(!closed && titleChanged && !titleQueue.length){titleChanged=false;emitRooms('push');}
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
          if(needsLinkRepair(key) && linkRepairs.size<500){
            linkRepairs.set(key,{count:0,retryAt:0,ready:true,terminal:false});
            await repairLink(key);if(closed)return;
          }
          for(const packet of packets){
            const body=packet.chatLog?{chatId:packet.chatId,chatLog:packet.chatLog,authorNickname:packet.authorNickname}:packet;
            for(const update of store.push(body)){publish(packets.partial?{...update,partial:true}:update,'push',body);lookupMembers(update.key);}
          }
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
          carriage=client;store=createReaderStore(body,credential.userId,factory.sessionSalt,factory.settingsSecret,{observeOwnRead:reason=>observeOwnRead('classification',reason),onCacheEvicted:key=>{cursors.delete(key);gapProbes.delete(key);visibleViews.delete(key);emit({type:'reader-cache-evicted',key,cacheEpoch:store.cacheEpoch(key)});}});
          titleQueue=store.unnamedRooms(8).map(key=>({key,selected:false}));for(const {key} of titleQueue)titleAttempts.add(key);
          carriage.on('disconnected',()=>fail('disconnected'));
          carriage.on('error',()=>fail('transport'));
          const onPush=packet=>{
            if(closed)return;
            const ownReadMethod=['DECUNREAD','CHATINFO','UPDATECHAT','BLSYNC'].includes(packet?.method);
            if(responseStatus(packet)!==0){if(ownReadMethod)observeOwnRead('session','status_rejected');fail('push',responseStatus(packet));return;}
            alive();
            try {
              if(factory.messaging===true && packet?.method==='DECUNREAD'){
                observeOwnRead('session','supported');
                const update=store.readUpdate(packet.body,{deferOwnRead:!announced});
                if(update?.ownRead){
                  if(announced){emit({type:'reader-own-read',key:update.key,read:update.ownRead,proof:store.ownReadProof(update.key)});observeOwnRead('handoff','emitted');}
                  else{pendingOwnReads.add(update.key);observeOwnRead('handoff','deferred');} // Known rooms bound this set to ROOM_LIMIT.
                }else if(update)publish(update,'receipt');return;
              }
              if(ownReadMethod)observeOwnRead('session',packet.method==='DECUNREAD'?'disabled':'unsupported');
              if(factory.messaging===true && ['NEWMEM','LEFT'].includes(packet?.method)){
                const update=store.invalidateReceipts(packet.body,{left:packet.method==='LEFT'});if(update){if(activeLinkRepair?.key===update.key)activeLinkRepair.controller.abort();entries.delete(update.key);invalidatePhoto(update.key);publish(update,'receipt');}return;
              }
              if(factory.messaging===true && ['SYNCLINKCR','SYNCLINKDL','SYNCLINKPF','SYNCMEMT','LINKKICKED','LNKDELETED'].includes(packet?.method)){
                for(const update of store.linkUpdate(packet.method,packet.body)){if(activeLinkRepair?.key===update.key)activeLinkRepair.controller.abort();entries.delete(update.key);invalidatePhoto(update.key);publish(update,'receipt');}return;
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
                const nickname=logs.length===1?messageNickname(packet.body,id):undefined;
                const bytes=logs.reduce((n,log)=>n+256+2*(log.msg.length+(log.attachment?.length ?? 0)+log.senderName.length),0)+2*(nickname?.length ?? 0);
                // Over budget: drop this room's further replays and mark it partial.
                if(logs.length && queuedBytes()+bytes>DISCOVERY_BYTES)packets.partial=true;
                else if(logs.length){packets.push({chatId:id,chatLogs:logs,...(nickname!==undefined?{chatLog:logs[0],authorNickname:nickname}:{})});packets.bytes=(packets.bytes ?? 0)+bytes;}
              }
              scheduleDiscovery();
              const updates=store.push(packet.body);
              for(const update of updates){const attempt=linkRepairs.get(update.key);if(attempt && !attempt.terminal && attempt.count<3 && now()>=attempt.retryAt && needsLinkRepair(update.key))attempt.ready=true;}
              // A push may arrive while initial link metadata is pending. Give
              // the manager its vetted room before that room's first arrivals.
              if(!announced && updates.length)emitRooms('push');
              for(const update of updates){emitMessages(update,'push',{arrivalProof:store.arrivalProof(update.key,update.arrivals,packet.body)});lookupMembers(update.key);}
              if(updates.length)emitRooms('push');
              scheduleDiscovery();
            } catch(error) {
              try{factory.observeFailure?.({stage:'decode',fault:safeFault(error)});}catch{/* Diagnostics cannot change the decode outcome. */}
              fail('decode');
            }
          };
          carriage.on('push',onPush);
          if(earlyPush.length){
            // Make opaque rooms available before replaying their initial logs.
            emitRooms('push');
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
          announced=true;emitRooms('loginlist');
          for(const key of pendingOwnReads){
            // Recompute against the current latest bound. A marker captured
            // before a later MSG must not clear that MSG at startup.
            const update=store.flushOwnRead(key);if(update){emit({type:'reader-own-read',key,read:update.ownRead,proof:store.ownReadProof(key)});observeOwnRead('handoff','flushed');}
          }
          pendingOwnReads.clear();resolve({ok:true});
          scheduleDiscovery();
          await stopped;
        }).then(result=>{
          if(!announced){if(!closed)fail(result.stage,result.status);resolve({ok:false});}
        }).catch(()=>{if(!closed)fail('worker');resolve({ok:false});});
      });
    },
    view(key){if(closed || !store?.has(key))return false;activate(key);selectTitle(key);return true;},
    async history(key,requestId) {
      const started=now(),remaining=()=>18000-(now()-started);
      const selection=selectionVersion;
      if(titlePromise && !titleInFlight?.selected)await titlePromise;
      if(discoveryPromise)await discoveryPromise;
      if(closed || !store || !carriage || busy || !store.has(key) || selectionVersion!==selection)return false;
      activate(key);
      // A zero max was rejected by the actual server. Use only a bound already
      // supplied by LOGINLIST/MSG; do not guess an ID or issue another command.
      const end=store.historyEnd(key);
      store.recent(key);
      const cacheEpoch=store.cacheEpoch(key);let cacheInvalidated=false;
      if(!end){
        emitMessages({...store.history(key,{}),requestId,unavailable:true},'history');
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
        emitMessages({...result,...(cacheInvalidated || budgetStopped?{latestVisible:false}:{}),fieldPresent,receivedCount,acceptedCount,rejectedCount,hasMore:cacheInvalidated || budgetStopped || hasMore,gap:cacheInvalidated || gap,requestId},'history');
        if(!cacheInvalidated && fieldPresent && selectionVersion===selection)lookupMembers(key);return true;
      } catch {if(!closed){emit({type:'reader-failed',stage:'history',status:null});close();}return false;}
      finally{busy=false;scheduleDiscovery();}
    },
    async action(key,requestId,action,payload={}){
      const started=Date.now(),bound=max=>{const remaining=22500-(Date.now()-started);if(remaining<=0)throw new Error('action_deadline');return Math.min(max,remaining);};
      const selection=selectionVersion;
      if(titlePromise && !titleInFlight?.selected)await titlePromise;
      if(discoveryPromise)await discoveryPromise;
      // Context/read/photo belong to the selected view, including time spent
      // waiting for metadata. Explicit text sends retain their distinct intent.
      if(['context','read','photo'].includes(action) && selectionVersion!==selection)return false;
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
