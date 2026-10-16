import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes,createHash } from 'node:crypto';
import { checkPinnedSource } from './kakao-auth.mjs';
import { roomKeyValid,ROOM_LIMIT,MESSAGE_LIMIT,CACHE_LIMIT } from './reader-data.mjs';
import { createRoomState } from './reader-room-state.mjs';
import { createPreferenceStore,validSettings,validRoomSettings } from './preferences.mjs';
import { photoUrl } from './photos.mjs';
import { messageKeyValid,clientIdValid,decodeImage } from './message-content.mjs';

const integer=value=>Number.isSafeInteger(value) && value>=0 ? value : 0;
const text=(value,max)=>typeof value==='string'?(value.length<=max?value:[...value].slice(0,max).join('')):'';
const at=value=>Number.isFinite(value) && value>0 && value<=4102444800000?value:null;
export function safeRooms(rows){
  if(!Array.isArray(rows))return [];
  const unique=new Map();
  for(const row of rows.slice(0,ROOM_LIMIT))if(roomKeyValid(row?.key))unique.set(row.key,{key:row.key,title:text(row.title,120),titleKnown:row.titleKnown===true,...(typeof row.historyAvailable==='boolean'?{historyAvailable:row.historyAvailable}:{}),preview:text(row.preview,160),lastAt:at(row.lastAt),kind:['DirectChat','MultiChat','MemoChat'].includes(row.kind)?row.kind:'unknown',canSend:row.canSend===true});
  return [...unique.values()];
}
export function safeMessages(rows){
  if(!Array.isArray(rows))return [];
  const unique=new Map();
  for(const row of rows.slice(-MESSAGE_LIMIT))if(messageKeyValid(row?.key))unique.set(row.key,{key:row.key,text:text(row.text,4000),sender:text(row.sender,80),mine:row.mine===true,canReply:row.canReply===true,reply:row.reply && typeof row.reply.text==='string'?{text:text(row.reply.text,4000),sender:text(row.reply.sender,80)}:null,at:at(row.at),photos:(Array.isArray(row.photos)?row.photos:[]).slice(0,30).map(photo=>({url:photoUrl(photo?.url),width:Number.isInteger(photo?.width)&&photo.width>0&&photo.width<=20000?photo.width:null,height:Number.isInteger(photo?.height)&&photo.height>0&&photo.height<=20000?photo.height:null})).filter(photo=>photo.url),unreadCount:row.mine===true && Number.isSafeInteger(row.unreadCount) && row.unreadCount>=0 && row.unreadCount<=100?row.unreadCount:null});
  return [...unique.values()];
}
export function createReadOnlyReader({spawn=fork,now=Date.now,onBlocked=()=>{},gapProbe=false,messaging=false,preferenceStore=createPreferenceStore()}={}){
  let child=null,signal=null,abortHandler=null,deadline=null,phase='idle',stage=null,status=null,attempts=0,consecutiveFailures=0,rooms=[],pages=new Map(),request=0,pending=null,revision=0,connectedAt=null;
  let historyRequests=0,historySuccesses=0,pushBatches=0,duplicates=0,sourceRoomCount=0,truncated=false;
  const sessionSalt=randomBytes(32).toString('hex'),roomState=createRoomState(),outbox=new Map(),contexts=new Map(),readMarks=new Map(),readStates=new Map(),viewTokens=new Map();
  let profile=null;const preferenceKeys=new Map();
  function applySettings(rawRooms){
    for(const row of rawRooms ?? [])if(roomKeyValid(row?.key) && /^[a-f0-9]{64}$/.test(row?.preferenceKey))preferenceKeys.set(row.key,row.preferenceKey);
    for(const row of rooms){const saved=profile?.room(preferenceKeys.get(row.key));if(saved)roomState.settings(row.key,saved);}
    roomState.notifications(profile?.snapshot().notifications===true);
  }
  function action(key,kind,payload={}){
    if(!messaging || phase!=='connected' || pending || !rooms.some(row=>row.key===key && row.canSend))return false;
    const requestId=++request;pending={key,requestId,action:kind,clientId:payload.clientId,message:payload.message};
    if(kind==='read')readStates.set(key,{phase:'sending',messageKey:payload.message});
    deadline=setTimeout(()=>fail(kind),kind==='photo'?72000:26000);deadline.unref?.();
    send({type:'reader-action',key,requestId,action:kind,payload});revision++;return true;
  }
  function terminate(){
    if(pending?.action==='read' && readStates.get(pending.key)?.phase==='sending')readStates.set(pending.key,{phase:'unknown',messageKey:pending.message});
    clearTimeout(deadline);deadline=null;pending=null;
    if(signal && abortHandler)signal.removeEventListener('abort',abortHandler);
    if(child){const owned=child;child=null;owned.removeAllListeners();owned.on('error',()=>{});owned.kill();}
  }
  function fail(nextStage,code=null){
    phase=Number.isInteger(code) && code!==0?'blocked':'disconnected';stage=nextStage;status=Number.isInteger(code)?code:null;
    if(['send','photo'].includes(pending?.action)){const entry=outbox.get(pending.clientId);if(entry)entry.phase='unknown';}
    if(pending?.action==='history'){const page=pages.get(pending.key);if(page)page.history={phase:'failed'};}
    terminate();revision++;if(phase==='blocked')onBlocked();
  }
  function send(message){
    const owner=child;
    try{owner.send(message,error=>{if(error && child===owner)fail('ipc');});}catch{if(child===owner)fail('ipc');}
  }
  return {
    snapshot(){return {phase,stage,status,attempts,roomCount:rooms.length,sourceRoomCount,truncated,connectedAt,historyRequests,historySuccesses,historyBusy:pending?.action==='history',operationBusy:pending!==null,pushBatches,duplicates,sendRequests:outbox.size,sendAccepted:[...outbox.values()].filter(entry=>entry.phase==='accepted').length,revision,canConnect:['idle','disconnected'].includes(phase)&&consecutiveFailures<3,readOnly:!messaging};},
    rooms(){return {rooms:rooms.map(row=>roomState.decorate(row)),revision};},
    messages(key){
      if(!rooms.some(row=>row.key===key))return null;
      const page=pages.get(key) ?? {key,messages:[],history:{phase:'idle'},revision};
      const latest=page.latestVisible && page.messages?.at(-1)?.key;
      let token=null;
      if(latest){let cached=viewTokens.get(key);if(cached?.revision!==page.revision || !roomState.hasToken(cached?.token)){cached={revision:page.revision,token:roomState.issue(key,latest)};viewTokens.set(key,cached);}token=cached.token;}
      return {...page,messages:page.messages.map(({photos,...message})=>({...message,photos:(photos ?? []).map((photo,index)=>({src:`/api/photo?room=${key}&message=${message.key}&index=${index}`,width:photo.width,height:photo.height}))})),seenToken:token,receiptPhase:contexts.get(key) ?? 'idle',readSync:{...(readStates.get(key) ?? {phase:'idle'})},outbox:[...outbox.values()].filter(entry=>entry.key===key).slice(-20).map(({payloadHash,...entry})=>({...entry}))};
    },
    photo(key,message,index){return pages.get(key)?.messages.find(row=>row.key===message)?.photos?.[index]?.url ?? null;},
    settingsSnapshot(){return profile?.snapshot() ?? null;},
    updateSettings(patch){if(!profile || !validSettings(patch) || !profile.set(patch))return false;roomState.notifications(profile.snapshot().notifications);revision++;return true;},
    forgetSettings(){if(!profile?.forget())return false;for(const row of rooms)roomState.settings(row.key,{title:null,pinOrder:null,muted:false});roomState.notifications(false);revision++;return true;},
    roomPreferences(key,patch){
      if(!rooms.some(row=>row.key===key) || !validRoomSettings(patch))return false;
      const id=preferenceKeys.get(key);if(id && profile && !profile.setRoom(id,patch))return false;
      roomState.settings(key,{...patch,...(typeof patch.title==='string'?{title:patch.title.trim()}:{})});revision++;return true;
    },
    claimNotifications(){return profile?.snapshot().notifications?roomState.claim():[];},
    rename(key,value){return this.roomPreferences(key,{title:value});},
    openRoom(key){if(contexts.has(key))return true;if(!action(key,'context'))return false;contexts.set(key,'loading');return true;},
    seen(key,token,notify=false){
      if(notify && (!messaging || pending || phase!=='connected' || !rooms.some(row=>row.key===key && row.canSend)))return false;
      const seen=roomState.seen(key,token);if(!seen)return false;
      revision++;
      if(notify && readMarks.get(key)!==seen.message){if(!action(key,'read',{message:seen.message}))return false;}
      return true;
    },
    sendText(key,value,clientId,replyTo){
      if(typeof value!=='string' || !value.trim() || [...value].length>4000 || !clientIdValid(clientId) || replyTo!==undefined && !messageKeyValid(replyTo))return false;
      const payloadHash=createHash('sha256').update(JSON.stringify(['text',value,replyTo ?? null])).digest('hex'),existing=outbox.get(clientId);
      if(existing)return existing.key===key && existing.payloadHash===payloadHash;
      if(replyTo!==undefined && !pages.get(key)?.messages.some(row=>row.key===replyTo && row.canReply))return false;
      if(outbox.size>=1000 || !action(key,'send',{text:value,clientId,...(replyTo?{replyTo}:{})}))return false;
      outbox.set(clientId,{key,clientId,payloadHash,phase:'sending',status:null});return true;
    },
    sendPhoto(key,value,clientId){
      if(!clientIdValid(clientId))return false;
      const image=decodeImage(value);if(!image)return false;
      const payloadHash=createHash('sha256').update('photo:').update(image.data).digest('hex'),existing=outbox.get(clientId);
      if(existing)return existing.key===key && existing.payloadHash===payloadHash;
      if(outbox.size>=1000 || !action(key,'photo',{image:value,clientId}))return false;
      outbox.set(clientId,{key,clientId,payloadHash,phase:'sending',status:null});return true;
    },
    connect(credential,{signal:authSignal}={}){
      if(!['idle','disconnected'].includes(phase) || consecutiveFailures>=3 || authSignal?.aborted)return false;
      profile ??= preferenceStore.account(credential.userId);
      attempts++;consecutiveFailures++;phase='connecting';stage='booking';status=null;rooms=[];pages.clear();contexts.clear();readMarks.clear();readStates.clear();viewTokens.clear();connectedAt=null;sourceRoomCount=0;truncated=false;revision++;
      signal=authSignal;abortHandler=()=>this.close();signal?.addEventListener('abort',abortHandler,{once:true});
      try{
        checkPinnedSource({workingCopy:true});
        const allowedEnv=new Set(['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','COMSPEC','LANG','LC_ALL']);
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
          if(message?.type==='reader-ready' && !credentialSent){credentialSent=true;send({type:'reader-start',gapProbe:gapProbe===true,messaging,sessionSalt,settingsSecret:profile.key().toString('hex'),credential:{userId:credential.userId,deviceUUID:credential.deviceUUID,accessToken:credential.accessToken}});}
          else if(message?.type==='reader-failed')fail(['booking','getconf','checkin','loginlist','history','ping','push','transport','decode','disconnected','worker','send','photo','context','read','discovery'].includes(message.stage)?message.stage:'worker',message.status);
          else if(message?.type==='reader-rooms' && ['loginlist','push'].includes(message.source)){
            rooms=safeRooms(message.rooms);sourceRoomCount=integer(message.stats?.sourceRoomCount);truncated=message.stats?.truncated===true;duplicates=integer(message.stats?.duplicates);
            if(phase==='connecting' && message.source==='loginlist'){roomState.bind(rooms,{reconnect:attempts>1});clearTimeout(deadline);deadline=null;phase='connected';stage='loginlist';status=0;consecutiveFailures=0;connectedAt=now();}
            applySettings(message.rooms);
            revision++;
          }else if(message?.type==='reader-messages' && roomKeyValid(message.key) && rooms.some(row=>row.key===message.key)){
            if(message.source==='history' && (!pending || pending.requestId!==message.requestId || pending.key!==message.key))return;
            if(!['push','history','receipt','sent'].includes(message.source))return;
            if(message.source==='push')roomState.receive(message.key,message.arrivals);
            const validHistory=message.unavailable!==true && message.fieldPresent===true && (message.receivedCount===0 || integer(message.acceptedCount)>0);
            const previous=pages.get(message.key);const history=message.source==='history'?{phase:message.unavailable===true?'unavailable':validHistory?'loaded':'unrecognized',hasMore:message.hasMore===true,gap:message.gap===true,receivedCount:integer(message.receivedCount),acceptedCount:integer(message.acceptedCount),rejectedCount:integer(message.rejectedCount),at:now()}:previous?.history ?? {phase:'idle'};
            pages.delete(message.key);pages.set(message.key,{key:message.key,messages:safeMessages(message.messages),latestVisible:message.latestVisible===true,history,revision:++revision});
            while(pages.size>CACHE_LIMIT)pages.delete(pages.keys().next().value);
            if(message.source==='history'){clearTimeout(deadline);deadline=null;pending=null;if(validHistory)historySuccesses++;}
            else if(message.source==='push')pushBatches++;
          }else if(message?.type==='reader-action' && pending?.requestId===message.requestId && pending.key===message.key && pending.action===message.action){
            const kind=pending.action;
            if(['send','photo'].includes(kind)){
              const entry=outbox.get(pending.clientId);
              if(entry){entry.phase=['accepted','failed','unknown'].includes(message.phase)?message.phase:'unknown';entry.status=Number.isInteger(message.status)?message.status:null;if(/^m_[a-f0-9]{24}$/.test(message.messageKey))entry.messageKey=message.messageKey;}
            }else if(kind==='context')contexts.set(message.key,message.phase==='accepted'?'ready':'unavailable');
            else if(kind==='read'){
              const accepted=message.phase==='accepted' && message.status===0;
              readStates.set(message.key,{phase:accepted?'accepted':message.phase==='failed'?'failed':'unknown',messageKey:pending.message});
              if(accepted)readMarks.set(message.key,pending.message);
            }
            clearTimeout(deadline);deadline=null;pending=null;revision++;
          }else if(message?.type==='reader-request-rejected' && pending?.requestId===message.requestId){
            if(['send','photo'].includes(pending.action)){const entry=outbox.get(pending.clientId);if(entry)entry.phase='failed';clearTimeout(deadline);deadline=null;pending=null;revision++;}
            else fail(pending.action);
          }
        });
        return true;
      }catch{fail('worker');return false;}
    },
    history(key){
      if(phase!=='connected' || pending || !roomKeyValid(key) || !rooms.some(row=>row.key===key))return false;
      const requestId=++request;pending={key,requestId,action:'history'};historyRequests++;
      const previous=pages.get(key);pages.set(key,{key,messages:previous?.messages ?? [],history:{phase:'loading'},revision:++revision});
      deadline=setTimeout(()=>fail('history'),22000);deadline.unref?.();send({type:'reader-history',key,requestId});return true;
    },
    disconnect(){if(['blocked','closed'].includes(phase))return;if(['send','photo'].includes(pending?.action)){const entry=outbox.get(pending.clientId);if(entry)entry.phase='unknown';}terminate();phase='disconnected';stage='manual';revision++;},
    close(){terminate();if(phase!=='blocked'){phase='closed';stage='cancelled';}rooms=[];pages.clear();roomState.clear();outbox.clear();contexts.clear();readMarks.clear();readStates.clear();viewTokens.clear();preferenceKeys.clear();profile?.close();profile=null;revision++;},
  };
}
