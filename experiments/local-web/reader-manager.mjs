import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkPinnedSource } from './kakao-auth.mjs';
import { roomKeyValid,ROOM_LIMIT,MESSAGE_LIMIT,CACHE_LIMIT } from './reader-data.mjs';

const integer=value=>Number.isSafeInteger(value) && value>=0 ? value : 0;
const text=(value,max)=>typeof value==='string'?value.slice(0,max):'';
const at=value=>Number.isFinite(value) && value>0 && value<=4102444800000?value:null;
export function safeRooms(rows){
  if(!Array.isArray(rows))return [];
  const unique=new Map();
  for(const row of rows.slice(0,ROOM_LIMIT))if(roomKeyValid(row?.key))unique.set(row.key,{key:row.key,title:text(row.title,120),titleKnown:row.titleKnown===true,...(typeof row.historyAvailable==='boolean'?{historyAvailable:row.historyAvailable}:{}),preview:text(row.preview,160),lastAt:at(row.lastAt)});
  return [...unique.values()];
}
export function safeMessages(rows){
  if(!Array.isArray(rows))return [];
  const unique=new Map();
  for(const row of rows.slice(-MESSAGE_LIMIT))if(typeof row?.key==='string' && /^m_[a-f0-9]{24}$/.test(row.key))unique.set(row.key,{key:row.key,text:text(row.text,4000),sender:text(row.sender,80),mine:row.mine===true,at:at(row.at)});
  return [...unique.values()];
}
export function createReadOnlyReader({spawn=fork,now=Date.now,onBlocked=()=>{},gapProbe=false}={}){
  let child=null,signal=null,abortHandler=null,deadline=null,phase='idle',stage=null,status=null,attempts=0,rooms=[],pages=new Map(),request=0,pending=null,revision=0,connectedAt=null;
  let historyRequests=0,historySuccesses=0,pushBatches=0,duplicates=0,sourceRoomCount=0,truncated=false;
  function terminate(){
    clearTimeout(deadline);deadline=null;pending=null;
    if(signal && abortHandler)signal.removeEventListener('abort',abortHandler);
    if(child){const owned=child;child=null;owned.removeAllListeners();owned.on('error',()=>{});owned.kill();}
  }
  function fail(nextStage,code=null){
    phase=Number.isInteger(code) && code!==0?'blocked':'disconnected';stage=nextStage;status=Number.isInteger(code)?code:null;
    if(pending){const page=pages.get(pending.key);if(page)page.history={phase:'failed'};}
    terminate();revision++;if(phase==='blocked')onBlocked();
  }
  function send(message){
    const owner=child;
    try{owner.send(message,error=>{if(error && child===owner)fail('ipc');});}catch{if(child===owner)fail('ipc');}
  }
  return {
    snapshot(){return {phase,stage,status,attempts,roomCount:rooms.length,sourceRoomCount,truncated,connectedAt,historyRequests,historySuccesses,historyBusy:pending!==null,pushBatches,duplicates,revision,canConnect:['idle','disconnected'].includes(phase)&&attempts<3,readOnly:true};},
    rooms(){return {rooms:rooms.map(row=>({...row})),revision};},
    messages(key){if(!rooms.some(row=>row.key===key))return null;return pages.get(key) ?? {key,messages:[],history:{phase:'idle'},revision};},
    connect(credential,{signal:authSignal}={}){
      if(!['idle','disconnected'].includes(phase) || attempts>=3 || authSignal?.aborted)return false;
      attempts++;phase='connecting';stage='booking';status=null;rooms=[];pages.clear();connectedAt=null;sourceRoomCount=0;truncated=false;revision++;
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
          if(message?.type==='reader-ready' && !credentialSent){credentialSent=true;send({type:'reader-start',gapProbe:gapProbe===true,credential:{userId:credential.userId,deviceUUID:credential.deviceUUID,accessToken:credential.accessToken}});}
          else if(message?.type==='reader-failed')fail(['booking','getconf','checkin','loginlist','history','ping','push','transport','decode','disconnected','worker'].includes(message.stage)?message.stage:'worker',message.status);
          else if(message?.type==='reader-rooms' && ['loginlist','push'].includes(message.source)){
            rooms=safeRooms(message.rooms);sourceRoomCount=integer(message.stats?.sourceRoomCount);truncated=message.stats?.truncated===true;duplicates=integer(message.stats?.duplicates);
            if(phase==='connecting' && message.source==='loginlist'){clearTimeout(deadline);deadline=null;phase='connected';stage='loginlist';status=0;connectedAt=now();}
            revision++;
          }else if(message?.type==='reader-messages' && roomKeyValid(message.key) && rooms.some(row=>row.key===message.key)){
            if(message.source==='history' && (!pending || pending.requestId!==message.requestId || pending.key!==message.key))return;
            if(!['push','history'].includes(message.source))return;
            const validHistory=message.unavailable!==true && message.fieldPresent===true && (message.receivedCount===0 || integer(message.acceptedCount)>0);
            const previous=pages.get(message.key);const history=message.source==='history'?{phase:message.unavailable===true?'unavailable':validHistory?'loaded':'unrecognized',hasMore:message.hasMore===true,gap:message.gap===true,receivedCount:integer(message.receivedCount),acceptedCount:integer(message.acceptedCount),rejectedCount:integer(message.rejectedCount),at:now()}:previous?.history ?? {phase:'idle'};
            pages.delete(message.key);pages.set(message.key,{key:message.key,messages:safeMessages(message.messages),history,revision:++revision});
            while(pages.size>CACHE_LIMIT)pages.delete(pages.keys().next().value);
            if(message.source==='history'){clearTimeout(deadline);deadline=null;pending=null;if(validHistory)historySuccesses++;}
            else pushBatches++;
          }else if(message?.type==='reader-request-rejected' && pending?.requestId===message.requestId)fail('history');
        });
        return true;
      }catch{fail('worker');return false;}
    },
    history(key){
      if(phase!=='connected' || pending || !roomKeyValid(key) || !rooms.some(row=>row.key===key))return false;
      const requestId=++request;pending={key,requestId};historyRequests++;
      const previous=pages.get(key);pages.set(key,{key,messages:previous?.messages ?? [],history:{phase:'loading'},revision:++revision});
      deadline=setTimeout(()=>fail('history'),22000);deadline.unref?.();send({type:'reader-history',key,requestId});return true;
    },
    disconnect(){if(['blocked','closed'].includes(phase))return;terminate();phase='disconnected';stage='manual';revision++;},
    close(){terminate();if(phase!=='blocked'){phase='closed';stage='cancelled';}rooms=[];pages.clear();revision++;},
  };
}
