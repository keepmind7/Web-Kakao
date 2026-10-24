import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes,createHash } from 'node:crypto';
import { checkPinnedSource } from './kakao-auth.mjs';
import { roomKeyValid,ROOM_LIMIT,MESSAGE_LIMIT,CACHE_LIMIT,initialUnreadState } from './reader-data.mjs';
import { createRoomState } from './reader-room-state.mjs';
import { createOwnReadDiagnostics } from './reader-own-read-diagnostics.mjs';
import { createPreferenceStore,validSettings,validRoomSettings } from './preferences.mjs';
import { photoUrl } from './photos.mjs';
import { messageKeyValid,clientIdValid,decodeImage } from './message-content.mjs';
import { DEFAULT_PHOTO_TRANSPORT,normalizePhotoTransport } from './photo-transport.mjs';

const integer=value=>Number.isSafeInteger(value) && value>=0 ? value : 0;
const text=(value,max)=>typeof value==='string'?(value.length<=max?value:[...value].slice(0,max).join('')):'';
const at=value=>Number.isFinite(value) && value>0 && value<=4102444800000?value:null;
export function safeRooms(rows){
  if(!Array.isArray(rows))return [];
  const unique=new Map();
  for(const row of rows.slice(0,ROOM_LIMIT))if(roomKeyValid(row?.key)){
    const normal=['DirectChat','MultiChat','MemoChat'].includes(row.kind),known=normal || ['OpenDirectChat','OpenMultiChat'].includes(row.kind);
    const flags=Object.fromEntries(['canText','canReply','canPhoto','canRead','canContext'].map(name=>[name,known && (typeof row[name]==='boolean'?row[name]:normal && row.canSend===true)]));
    unique.set(row.key,{key:row.key,contextRevision:integer(row.contextRevision),cacheEpoch:integer(row.cacheEpoch),title:text(row.title,120),titleKnown:row.titleKnown===true,...(typeof row.historyAvailable==='boolean'?{historyAvailable:row.historyAvailable}:{}),preview:text(row.preview,160),lastAt:at(row.lastAt),kind:known?row.kind:'unknown',...initialUnreadState(row),...flags,canSend:flags.canText});
  }
  return [...unique.values()];
}
export function safeMessages(rows){
  if(!Array.isArray(rows))return [];
  const unique=new Map();
  for(const row of rows.slice(-MESSAGE_LIMIT))if(messageKeyValid(row?.key))unique.set(row.key,{key:row.key,text:text(row.text,4000),sender:text(row.sender,80),mine:row.mine===true,canReply:row.canReply===true,reply:row.reply && typeof row.reply.text==='string'?{text:text(row.reply.text,4000),sender:text(row.reply.sender,80),verified:row.reply.verified===true}:null,at:at(row.at),photos:(Array.isArray(row.photos)?row.photos:[]).slice(0,30).map(photo=>({url:photoUrl(photo?.url),width:Number.isInteger(photo?.width)&&photo.width>0&&photo.width<=20000?photo.width:null,height:Number.isInteger(photo?.height)&&photo.height>0&&photo.height<=20000?photo.height:null})).filter(photo=>photo.url),unreadCount:row.mine===true && Number.isSafeInteger(row.unreadCount) && row.unreadCount>=0 && row.unreadCount<=100?row.unreadCount:null});
  return [...unique.values()];
}
export function createReadOnlyReader({spawn=fork,now=Date.now,onBlocked=()=>{},gapProbe=false,messaging=false,photoTransport=DEFAULT_PHOTO_TRANSPORT,preferenceStore=createPreferenceStore()}={}){
  photoTransport=normalizePhotoTransport(photoTransport);
  const instanceId=randomBytes(12).toString('hex');
  const ownReadDiagnostics=createOwnReadDiagnostics({component:'manager'});
  const observeOwnRead=reason=>{try{ownReadDiagnostics.record('apply',reason);}catch{/* Observation cannot affect receipt application. */}};
  let child=null,signal=null,abortHandler=null,deadline=null,phase='idle',stage=null,status=null,attempts=0,consecutiveFailures=0,rooms=[],pages=new Map(),request=0,pending=null,revision=0,connectedAt=null;
  let historyRequests=0,historySuccesses=0,pushBatches=0,duplicates=0,sourceRoomCount=0,truncated=false;
  const sessionSalt=randomBytes(32).toString('hex'),roomState=createRoomState(),outbox=new Map(),contexts=new Map(),readMarks=new Map(),readStates=new Map(),viewTokens=new Map();
  const entries=new Map();let activeRoom=null,pinned=null,boundAccount=null,lastActivityAt=null;
  // Safety net against tabs that keep re-entering rooms: at most 12 room entries per minute.
  const contextTimes=[];
  function contextReady(key){return messaging && phase==='connected' && !pending && rooms.some(row=>row.key===key && row.canContext) && !(activeRoom===key && entries.get(key)==='acknowledged');}
  function contextRetryAfterMs(key){
    // The optional room scopes a rejected HTTP action; other refusals must not
    // become retryable merely because the shared entry budget is exhausted.
    if(key!==undefined && !contextReady(key))return 0;
    const t=now();while(contextTimes.length && t-contextTimes[0]>60000)contextTimes.shift();
    return contextTimes.length<12?0:Math.max(1,Math.min(60001,Math.ceil(60001-(t-contextTimes[0]))));
  }
  let roomsRevision=0,settingsRevision=0,outboxRevision=0,sendRequests=0,sendAccepted=0;
  const pageRevisions=new Map(),cacheLost=new Map(),cacheEpochs=new Map(),retired=new Map();
  const touch=key=>{if(roomKeyValid(key))pageRevisions.set(key,(pageRevisions.get(key) ?? 0)+1);};
  const publicEntry=entry=>{if(!entry)return null;const {key,clientId,kind,phase,status,messageKey,reason}=entry;return {key,clientId,kind,phase,status,...(messageKey?{messageKey}:{}),...(phase==='failed' && ['open_member_unverified','photo_jpeg_required'].includes(reason)?{reason}:{})};};
  function unknownPending(){if(['send','photo'].includes(pending?.action)){const entry=outbox.get(pending.clientId);if(entry && entry.phase==='sending'){entry.phase='unknown';outboxRevision++;touch(entry.key);}}}
  function capacity(){
    if(outbox.size<1000)return true;
    const entry=[...outbox.values()].find(row=>['accepted','failed'].includes(row.phase) || row.phase==='unknown' && row.acknowledged);
    if(!entry)return false;
    outbox.delete(entry.clientId);retired.set(entry.clientId,{...entry});
    while(retired.size>1000)retired.delete(retired.keys().next().value);
    outboxRevision++;touch(entry.key);return true;
  }
  function evict(key,epoch){
    pages.delete(key);viewTokens.delete(key);cacheLost.set(key,true);cacheEpochs.set(key,Math.max((cacheEpochs.get(key) ?? 0)+1,integer(epoch)));touch(key);
  }
  function trimPages(){while(pages.size>CACHE_LIMIT){const key=[...pages.keys()].find(value=>value!==pinned);evict(key);}}

  let profile=null,preparation=0;const preferenceKeys=new Map();
  function preferenceResult(owner,result,apply){
    const finish=accepted=>{if(!accepted || profile!==owner || phase==='closed')return false;return apply();};
    return result?.then?Promise.resolve(result).then(finish,()=>false):finish(result);
  }
  function applySettings(rawRooms){
    for(const row of rawRooms ?? [])if(roomKeyValid(row?.key) && /^[a-f0-9]{64}$/.test(row?.preferenceKey))preferenceKeys.set(row.key,row.preferenceKey);
    for(const row of rooms){const saved=profile?.room(preferenceKeys.get(row.key));if(saved)roomState.settings(row.key,saved);}
    roomState.notifications(profile?.snapshot().notifications===true);
  }
  function action(key,kind,payload={},outboxEntry=null){
    const capability={context:'canContext',read:'canRead',photo:'canPhoto',send:payload.replyTo!==undefined?'canReply':'canText'}[kind];
    if(!messaging || phase!=='connected' || pending || !capability || !rooms.some(row=>row.key===key && row[capability]))return false;
    if(activeRoom!==key){if(activeRoom){entries.delete(activeRoom);touch(activeRoom);}entries.delete(key);activeRoom=key;}
    if(['context','read'].includes(kind) && entries.get(key)!=='acknowledged')entries.set(key,'loading');
    const requestId=++request;pending={key,requestId,action:kind,clientId:payload.clientId,message:payload.message};
    if(kind==='read')readStates.set(key,{phase:'sending',messageKey:payload.message});
    deadline=setTimeout(()=>fail(kind),kind==='photo'?72000:26000);deadline.unref?.();
    // Publish only admitted sends, before IPC can fail synchronously. Failure
    // cleanup must find this entry to preserve its identity as unknown.
    if(outboxEntry){outbox.set(outboxEntry.clientId,outboxEntry);sendRequests++;outboxRevision++;}
    send({type:'reader-action',key,requestId,action:kind,payload});touch(key);revision++;return true;
  }
  function terminate(){
    preparation++;
    unknownPending();
    if(pending?.action==='read' && readStates.get(pending.key)?.phase==='sending'){readStates.set(pending.key,{phase:'unknown',messageKey:pending.message});touch(pending.key);}
    clearTimeout(deadline);deadline=null;pending=null;
    for(const key of entries.keys())touch(key);entries.clear();activeRoom=null;
    if(signal && abortHandler)signal.removeEventListener('abort',abortHandler);
    if(child){const owned=child;child=null;owned.removeAllListeners();owned.on('error',()=>{});owned.kill();}
  }
  function fail(nextStage,code=null){
    const handshakeDenied=phase==='connecting' && ['booking','getconf','checkin','loginlist'].includes(nextStage) && Number.isInteger(code) && code!==0;
    phase=handshakeDenied?'blocked':'disconnected';stage=nextStage;status=Number.isInteger(code)?code:null;
    unknownPending();
    if(pending?.action==='history'){const page=pages.get(pending.key);if(page){page.history={phase:'failed'};touch(pending.key);}}
    terminate();revision++;if(phase==='blocked')onBlocked();
  }
  function send(message){
    const owner=child;
    try{owner.send(message,error=>{if(error && child===owner)fail('ipc');});}catch{if(child===owner)fail('ipc');}
  }
  return {
    snapshot(){return {instanceId,phase,stage,status,attempts,roomCount:rooms.length,sourceRoomCount,truncated,connectedAt,lastActivityAt,serverNow:now(),historyRequests,historySuccesses,historyBusy:pending?.action==='history',operationBusy:pending!==null,pushBatches,duplicates,sendRequests,sendAccepted,revision,roomsRevision,settingsRevision,outboxRevision,pageRevisions:Object.fromEntries(pageRevisions),canConnect:['idle','disconnected'].includes(phase)&&consecutiveFailures<3,readOnly:!messaging,ownReadDiagnostics:ownReadDiagnostics.snapshot()};},
    outbox(clientId){if(clientId===undefined)return [...outbox.values()].filter(entry=>['sending','unknown'].includes(entry.phase)&&!entry.acknowledged).map(publicEntry);if(!clientIdValid(clientId))return null;return publicEntry(outbox.get(clientId) ?? retired.get(clientId));},
    acknowledgeOutbox(clientId){const entry=outbox.get(clientId);if(!entry || entry.phase!=='unknown')return false;if(!entry.acknowledged){entry.acknowledged=true;outboxRevision++;touch(entry.key);revision++;}return true;},
    view(key){if(phase!=='connected' || !rooms.some(row=>row.key===key))return false;if(pinned===key)return true;pinned=key;send({type:'reader-view',key});return true;},
    rooms(){return {rooms:rooms.map(row=>roomState.decorate(row)),revision};},
    messages(key){
      if(!rooms.some(row=>row.key===key))return null;
      const page=pages.get(key) ?? {key,messages:[],history:{phase:'idle'},revision};
      const latest=page.latestVisible && page.messages?.at(-1)?.key;
      let token=null;
      if(latest){let cached=viewTokens.get(key);if(cached?.revision!==page.revision || !roomState.hasToken(cached?.token)){cached={revision:page.revision,token:roomState.issue(key,latest)};viewTokens.set(key,cached);}token=cached.token;}
      return {...page,cacheLost:cacheLost.has(key),cacheEpoch:cacheEpochs.get(key) ?? 0,messages:page.messages.map(({photos,...message})=>({...message,photos:(photos ?? []).map((photo,index)=>({src:`/api/photo?room=${key}&message=${message.key}&index=${index}`,width:photo.width,height:photo.height}))})),seenToken:token,entryPhase:entries.get(key) ?? 'idle',receiptPhase:contexts.get(key) ?? 'idle',readSync:{...(readStates.get(key) ?? {phase:'idle'})},outbox:[...outbox.values()].filter(entry=>entry.key===key && !entry.acknowledged).slice(-20).map(publicEntry)};
    },
    photo(key,message,index){return pages.get(key)?.messages.find(row=>row.key===message)?.photos?.[index]?.url ?? null;},
    settingsSnapshot(){return profile?.snapshot() ?? null;},
    updateSettings(patch){
      const owner=profile;if(!owner || !validSettings(patch))return false;
      return preferenceResult(owner,owner.set(patch,{isCurrent:()=>profile===owner}),()=>{roomState.notifications(owner.snapshot().notifications);settingsRevision++;revision++;return true;});
    },
    forgetSettings(){
      const owner=profile;if(!owner)return false;
      return preferenceResult(owner,owner.forget({isCurrent:()=>profile===owner}),()=>{for(const row of rooms)roomState.settings(row.key,{title:null,pinOrder:null,muted:false});roomState.notifications(false);settingsRevision++;roomsRevision++;revision++;return true;});
    },
    roomPreferences(key,patch){
      if(!rooms.some(row=>row.key===key) || !validRoomSettings(patch))return false;
      const id=preferenceKeys.get(key),owner=profile,isCurrent=()=>profile===owner && rooms.some(row=>row.key===key);
      const apply=()=>{if(!isCurrent())return false;roomState.settings(key,{...patch,...(typeof patch.title==='string'?{title:patch.title.trim()}:{})});settingsRevision++;roomsRevision++;revision++;return true;};
      return id && owner?preferenceResult(owner,owner.setRoom(id,patch,{isCurrent}),apply):apply();
    },
    claimNotifications(){return profile?.snapshot().notifications?roomState.claim():[];},
    rename(key,value){return this.roomPreferences(key,{title:value});},
    contextRetryAfterMs,
    openRoom(key){
      if(!messaging || phase!=='connected' || !rooms.some(row=>row.key===key && row.canContext))return false;
      if(activeRoom===key && (entries.get(key)==='acknowledged' || pending?.key===key && pending.action==='context'))return true;
      if(!contextReady(key) || contextRetryAfterMs())return false;
      const previous=contexts.get(key);contexts.set(key,'loading');
      if(!action(key,'context')){if(previous===undefined)contexts.delete(key);else contexts.set(key,previous);return false;}contextTimes.push(now());return true;
    },
    seen(key,token,notify=false){
      if(notify && (!messaging || pending || phase!=='connected' || !rooms.some(row=>row.key===key && row.canRead)))return false;
      const seen=roomState.seen(key,token);if(!seen)return false;
      revision++;roomsRevision++;touch(key);
      if(notify && readMarks.get(key)!==seen.message){if(!action(key,'read',{message:seen.message}))return false;}
      return true;
    },
    sendText(key,value,clientId,replyTo){
      if(typeof value!=='string' || !value.trim() || [...value].length>4000 || !clientIdValid(clientId) || replyTo!==undefined && !messageKeyValid(replyTo))return false;
      const payloadHash=createHash('sha256').update(JSON.stringify(['text',value,replyTo ?? null])).digest('hex'),existing=outbox.get(clientId) ?? retired.get(clientId);
      if(existing)return existing.key===key && existing.payloadHash===payloadHash;
      if(replyTo!==undefined && !pages.get(key)?.messages.some(row=>row.key===replyTo && row.canReply))return false;
      return capacity() && action(key,'send',{text:value,clientId,...(replyTo?{replyTo}:{})},{key,clientId,payloadHash,kind:'send',phase:'sending',status:null});
    },
    sendPhoto(key,value,clientId){
      if(!clientIdValid(clientId))return false;
      const image=decodeImage(value);if(!image)return false;
      const payloadHash=createHash('sha256').update('photo:').update(image.data).digest('hex'),existing=outbox.get(clientId) ?? retired.get(clientId);
      if(existing)return existing.key===key && existing.payloadHash===payloadHash;
      return capacity() && action(key,'photo',{image:value,clientId},{key,clientId,payloadHash,kind:'photo',phase:'sending',status:null});
    },
    connect(credential,{signal:authSignal}={}){
      if(!['idle','disconnected'].includes(phase) || consecutiveFailures>=3 || authSignal?.aborted)return false;
      if(typeof credential?.userId!=='string' || boundAccount!==null && boundAccount!==credential.userId)return false;
      boundAccount ??= credential.userId;
      attempts++;consecutiveFailures++;phase='connecting';stage='booking';status=null;rooms=[];pages.clear();pinned=null;cacheLost.clear();cacheEpochs.clear();pageRevisions.clear();roomsRevision++;contexts.clear();entries.clear();activeRoom=null;readMarks.clear();readStates.clear();viewTokens.clear();connectedAt=null;lastActivityAt=null;sourceRoomCount=0;truncated=false;revision++;
      signal=authSignal;abortHandler=()=>this.close();signal?.addEventListener('abort',abortHandler,{once:true});
      const epoch=++preparation,current=()=>preparation===epoch && phase==='connecting' && !authSignal?.aborted;
      deadline=setTimeout(()=>{if(current())fail('settings');},22000);deadline.unref?.();
      const startWorker=prepared=>{
      if(!current()){prepared?.close();return false;}
      if(prepared){profile=prepared;settingsRevision++;}
      clearTimeout(deadline);deadline=null;
      try{
        checkPinnedSource({workingCopy:true});
        const allowedEnv=new Set(['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','COMSPEC','LANG','LC_ALL','WEB_KAKAO_PYTHON','HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR','TMPDIR']);
        const worker=spawn(fileURLToPath(new URL('./reader-worker.mjs',import.meta.url)),[],{
          execArgv:['--max-old-space-size=128','--import',new URL('../../local-only/spikes/modern/node_modules/tsx/dist/loader.mjs',import.meta.url).href],
          stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,
          env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>allowedEnv.has(key.toUpperCase()))),KAKAO_DEBUG_LOCO:'0'},
        });
        child=worker;let credentialSent=false;
        deadline=setTimeout(()=>fail('deadline'),22000);deadline.unref?.();
        worker.on('error',()=>{if(child===worker)fail('worker');});
        worker.on('exit',()=>{if(child===worker)fail('disconnected');});
        worker.on('message',message=>{
          if(child!==worker)return;
          if(message?.type==='reader-alive'){lastActivityAt=now();return;}
          if(message?.type==='reader-ready' && !credentialSent){credentialSent=true;send({type:'reader-start',gapProbe:gapProbe===true,messaging,photoTransport,sessionSalt,settingsSecret:profile.key().toString('hex'),credential:{userId:credential.userId,deviceUUID:credential.deviceUUID,accessToken:credential.accessToken}});}
          else if(message?.type==='reader-failed')fail(['booking','getconf','checkin','loginlist','history','ping','push','transport','decode','disconnected','worker','send','photo','context','read','discovery'].includes(message.stage)?message.stage:'worker',message.status);
          else if(message?.type==='reader-rooms' && ['loginlist','push'].includes(message.source)){
            const nextRooms=safeRooms(message.rooms);
            for(const room of rooms)if(!nextRooms.some(next=>next.key===room.key && next.canContext)){entries.delete(room.key);contexts.delete(room.key);readMarks.delete(room.key);touch(room.key);}
            if(JSON.stringify(nextRooms)!==JSON.stringify(rooms))roomsRevision++;
            rooms=nextRooms;sourceRoomCount=integer(message.stats?.sourceRoomCount);truncated=message.stats?.truncated===true;duplicates=integer(message.stats?.duplicates);
            if(phase==='connecting' && message.source==='loginlist'){roomState.bind(rooms,{reconnect:attempts>1,seedBounds:message.seedBounds,generation:attempts});clearTimeout(deadline);deadline=null;phase='connected';stage='loginlist';status=0;consecutiveFailures=0;connectedAt=now();}
            else roomState.bind(rooms,{seedBounds:message.seedBounds,generation:attempts});
            applySettings(message.rooms);
            revision++;
          }else if(message?.type==='reader-own-read'){
            observeOwnRead('received');
            if(phase!=='connected'){observeOwnRead('stale_connection');return;}
            const room=roomKeyValid(message.key) && rooms.find(row=>row.key===message.key);
            if(!room){observeOwnRead('invalid_room');return;}
            const before=roomState.decorate(room).unreadLocalCount;
            const changed=roomState.ownRead(message.key,message.read,message.proof,reason=>{if(reason!=='changed')observeOwnRead(reason);});
            if(changed){
              observeOwnRead('changed');
              if(roomState.decorate(room).unreadLocalCount<before)observeOwnRead('decreased');
              roomsRevision++;revision++;
            }
          }else if(message?.type==='reader-cache-evicted' && roomKeyValid(message.key)){evict(message.key,message.cacheEpoch);revision++;
          }else if(message?.type==='reader-messages' && roomKeyValid(message.key) && rooms.some(row=>row.key===message.key)){
            if(message.source==='history' && (!pending || pending.requestId!==message.requestId || pending.key!==message.key))return;
            if(!['push','history','receipt','sent'].includes(message.source))return;
            if(message.source==='receipt' && message.receiptInvalidated===true){
              contexts.delete(message.key);
              if(pending?.action==='context' && pending.key===message.key)pending.invalidated=true;
            }
            if(message.entryInvalidated===true){entries.delete(message.key);readMarks.delete(message.key);if(pending?.key===message.key)pending.invalidated=true;}
            if(message.source==='push'){roomState.receive(message.key,message.arrivals,{arrivalProof:message.arrivalProof});if(message.partial===true)roomState.markPartial(message.key);roomsRevision++;}
            const validHistory=message.unavailable!==true && message.fieldPresent===true && (message.receivedCount===0 || integer(message.acceptedCount)>0);
            const previous=pages.get(message.key);if(message.source==='history')cacheLost.delete(message.key);const history=message.source==='history'?{phase:message.unavailable===true?'unavailable':validHistory?'loaded':'unrecognized',hasMore:message.hasMore===true,gap:message.gap===true,receivedCount:integer(message.receivedCount),acceptedCount:integer(message.acceptedCount),rejectedCount:integer(message.rejectedCount),at:now()}:previous?.history ?? {phase:'idle'};
            pages.delete(message.key);pages.set(message.key,{key:message.key,messages:safeMessages(message.messages),latestVisible:message.latestVisible===true,history,revision:++revision});
            touch(message.key);trimPages();
            if(message.source==='history'){clearTimeout(deadline);deadline=null;pending=null;if(validHistory)historySuccesses++;}
            else if(message.source==='push')pushBatches++;
          }else if(message?.type==='reader-action' && pending?.requestId===message.requestId && pending.key===message.key && pending.action===message.action){
            const kind=pending.action;
            if(!pending.invalidated && ['acknowledged','failed'].includes(message.entryPhase))entries.set(message.key,message.entryPhase);
            else if(!pending.invalidated && ['context','read'].includes(kind))entries.set(message.key,message.phase==='accepted'?'acknowledged':'failed');
            if(['send','photo'].includes(kind)){
              const entry=outbox.get(pending.clientId);
              if(entry){if(message.phase==='accepted' && entry.phase!=='accepted')sendAccepted++;entry.phase=['accepted','failed','unknown'].includes(message.phase)?message.phase:'unknown';outboxRevision++;entry.status=Number.isInteger(message.status)?message.status:null;if(/^m_[a-f0-9]{24}$/.test(message.messageKey))entry.messageKey=message.messageKey;if(entry.phase==='failed' && ['open_member_unverified','photo_jpeg_required'].includes(message.reason))entry.reason=message.reason;else delete entry.reason;}
            }else if(kind==='context'){
              if(pending.invalidated)contexts.delete(message.key);
              else contexts.set(message.key,['ready','unavailable','idle'].includes(message.receiptPhase)?message.receiptPhase:message.phase==='accepted'?'ready':'unavailable');
            }
            else if(kind==='read'){
              const accepted=!pending.invalidated && message.phase==='accepted' && message.status===0;
              readStates.set(message.key,{phase:accepted?'accepted':message.phase==='failed'?'failed':'unknown',messageKey:pending.message});
              if(accepted)readMarks.set(message.key,pending.message);
            }
            clearTimeout(deadline);deadline=null;pending=null;touch(message.key);revision++;
          }else if(message?.type==='reader-request-rejected' && pending?.requestId===message.requestId && pending.key===message.key){
            const status=Number.isInteger(message.status)?message.status:null;
            if(['send','photo'].includes(pending.action)){const entry=outbox.get(pending.clientId);if(entry){entry.phase='failed';entry.status=status;outboxRevision++;}}
            else if(pending.action==='history'){const page=pages.get(pending.key);if(page)page.history={phase:'failed',status};}
            else if(pending.action==='context'){entries.set(pending.key,'failed');contexts.set(pending.key,'unavailable');}
            else if(pending.action==='read')readStates.set(pending.key,{phase:'failed',messageKey:pending.message});
            clearTimeout(deadline);deadline=null;pending=null;touch(message.key);revision++;
          }
        });
        return true;
      }catch{fail('worker');return false;}
      };
      try{
        if(profile)return startWorker(null);
        const prepared=preferenceStore.account(credential.userId);
        if(prepared?.then){void Promise.resolve(prepared).then(startWorker).catch(()=>{if(current())fail('settings');});return true;}
        return startWorker(prepared);
      }catch{if(current())fail('settings');return false;}
    },
    history(key){
      if(phase!=='connected' || pending || !roomKeyValid(key) || !rooms.some(row=>row.key===key))return false;
      const requestId=++request;pending={key,requestId,action:'history'};historyRequests++;
      const previous=pages.get(key);touch(key);pages.set(key,{key,messages:previous?.messages ?? [],history:{phase:'loading'},revision:++revision});trimPages();
      deadline=setTimeout(()=>fail('history'),22000);deadline.unref?.();send({type:'reader-history',key,requestId});return true;
    },
    disconnect(){if(['blocked','closed'].includes(phase))return;terminate();phase='disconnected';stage='manual';revision++;},
    close(){terminate();if(phase!=='blocked'){phase='closed';stage='cancelled';}rooms=[];pages.clear();roomState.clear();ownReadDiagnostics.reset();outbox.clear();retired.clear();pageRevisions.clear();cacheLost.clear();cacheEpochs.clear();pinned=null;outboxRevision++;roomsRevision++;settingsRevision++;contexts.clear();readMarks.clear();readStates.clear();viewTokens.clear();preferenceKeys.clear();profile?.close();profile=null;revision++;},
  };
}
