import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateDataRoot,ensurePrivateDirectory } from './private-storage.mjs';
import { randomUUID } from 'node:crypto';
import { responseStatus } from './reader-response.mjs';

const FIELDS=new Set(['chatDatas','chatInfos','chats','chatRooms','chatList','chatId','id','roomId','chatRoomId','c','t','a','n','s','l','i','k','ll','o','title','roomName','name','subject','meta','chatMetas','type','content','displayMembers','displayNickNames','displayNicknames','displayNames','nickName','nickname','profileName','displayName','lastChatLog','lastLog','chatLog','log','chatLogs','logs','msgs','messages','logId','msgId','message','msg','text','authorId','senderId','userId','writerId','sendAt','createdAt','updatedAt','lastChatLogId','lastLogId','isOK','minLogId','jsi','lastTokenId','lastChatId','status']);
const METHODS=new Set(['GETCONF','CHECKIN','LOGINLIST','SYNCMSG','MCHATLOGS','PING','MSG','KICKOUT','CHANGESVR','BLSYNC','CHATINFO','WRITE','CHATONROOM','NOTIREAD','DECUNREAD','SHIP','POST','COMPLETE']);
for(const method of ['SYNCLINK','INFOLINK','MEMBER'])METHODS.add(method);
for(const field of ['ols','dlis','ltk','li','linkId','openLinkId','ln','linkName','ac','otk','isExpired','expired','olu','lmt','opt','pv','mt','notiRead'])FIELDS.add(field);
for(const field of ['m','mi','w','watermark','chatInfo','lastSeenLogId','activeMembersCount','left','attachment','url','thumbnailUrl','imageUrls','thumbnailUrls','h','wl','hl','members','authorNickname'])FIELDS.add(field);
export const safeMethod=value=>METHODS.has(value)?value:'other';
export function schemaShape(value,depth=0){
  if(value===null)return {type:'null'};
  if(Array.isArray(value))return {type:'array',count:value.length,...(depth<2 && value.length?{sample:value.slice(0,2).map(row=>schemaShape(row,depth+1))}:{})};
  if(typeof value==='string')return {type:'string',length:value.length};
  if(typeof value!=='object')return {type:['boolean','number','bigint','undefined'].includes(typeof value)?typeof value:'other'};
  const keys=Object.keys(value);const fields={};
  if(depth<3)for(const key of keys.slice(0,200))if(FIELDS.has(key))fields[key]=schemaShape(value[key],depth+1);
  return {type:'object',fieldCount:keys.length,unknownFieldCount:keys.filter(key=>!FIELDS.has(key)).length,fields};
}
export function safeFault(error){
  const names=new Set(['Error','TypeError','RangeError','SyntaxError','BSONError','BSONRuntimeError']);
  const stack=typeof error?.stack==='string'?error.stack:'';
  return {category:names.has(error?.name)?error.name:'other',frames:['onData','decrypt','fromBuffer','deserialize','syncMsg','history','request'].filter(name=>new RegExp('\\b'+name+'\\b').test(stack))};
}
const UPLOAD_STAGES=new Set(['ship','route','connect','post','offset','stream','await_complete','received_complete','complete_observed','transport','deadline','exception']);
for(const stage of ['https_start','https_route','https_upload','https_uploaded','https_write','https_ack','https_deadline','https_exception'])UPLOAD_STAGES.add(stage);
const safeValue=(object,key)=>{try{return object?.[key];}catch{return undefined;}};
const safeOwn=(object,key)=>{try{return Object.hasOwn(object ?? {},key);}catch{return false;}};
const bounded=(value,min,max)=>Number.isSafeInteger(value) && value>=min && value<=max;
function safeSocket(value){
  const result={};
  for(const key of ['available','destroyed','writable','writableEnded','writableNeedDrain']){const item=safeValue(value,key);if(typeof item==='boolean')result[key]=item;}
  for(const key of ['writableLength','writableHighWaterMark','writtenBytesDelta','readBytesDelta']){const item=safeValue(value,key);if(bounded(item,0,2147483647))result[key]=item;}
  return result;
}
function safeWrite(value){
  const result={};
  for(const [key,min,max] of [['index',1,100000],['inputBytes',0,10*1024*1024],['elapsedMs',0,2147483647],['callMs',0,2147483647]]){const item=safeValue(value,key);if(bounded(item,min,max))result[key]=item;}
  const phase=safeValue(value,'phase');if(['calling','waiting','fulfilled','rejected','threw'].includes(phase))result.phase=phase;
  for(const key of ['before','returned','terminal']){const item=safeValue(value,key);if(item && typeof item==='object')result[key]=safeSocket(item);}
  return result;
}
function safePhotoDetails(value){
  const stage=safeValue(value,'stage');if(!UPLOAD_STAGES.has(stage))return null;
  const result={stage};
  for(const key of ['sentBytes','totalBytes','offset']){const item=safeValue(value,key);if(bounded(item,0,10*1024*1024))result[key]=item;}
  const frames=safeValue(value,'frames');if(bounded(frames,0,100000))result.frames=frames;
  const status=safeValue(value,'status');if(status===null || bounded(status,-2147483648,2147483647))result.status=status;
  const beforeStreamEnd=safeValue(value,'beforeStreamEnd');if(typeof beforeStreamEnd==='boolean')result.beforeStreamEnd=beforeStreamEnd;
  for(const [key,allowed] of [
    ['failure',['exception','closed_or_error','timeout','invalid_offset']],
    ['category',['TypeError','RangeError','Error','other']],
    ['code',['EPIPE','ECONNRESET','ETIMEDOUT','ERR_STREAM_DESTROYED','ERR_SOCKET_CLOSED','not_connected','other']],
  ]){const item=safeValue(value,key);if(allowed.includes(item))result[key]=item;}
  const write=safeValue(value,'write');if(write && typeof write==='object')result.write=safeWrite(write);
  return result;
}
const SEND_STAGES=new Set(['start','entry','member_lookup','member_verified','blocked','write_attempt','response','result']);
const SEND_PHASES=new Set(['sending','accepted','failed','unknown']);
const SEND_REASONS=new Set(['entry_unavailable','open_member_unverified','member_missing','member_rejected','member_timeout','member_invalid','permission_changed','write_rejected','write_ack_unrecognized','write_correlation','write_timeout','transport','invalidated']);
export function createReaderDiagnostic({writeSnapshot=null,writeSendSnapshot=null,debounceMs=1000}={}){

  const state={runId:randomUUID(),startedAt:Date.now(),rawValuesRecorded:false,lastOperation:'startup',readSync:{requests:0,responses:0,accepted:0,rejected:0,unknown:0},events:[],uploadStages:{}};let ended=false,timer=null,dirty=false,sendDirty=false,sendAttempted=false,streamBytes=0,outputFolder=null;
  const folder=()=>{if(!outputFolder){const path=join(privateDataRoot(),'web-auth');ensurePrivateDirectory(path);outputFolder=path;}return outputFolder;};
  const save=()=>{
    clearTimeout(timer);timer=null;
    if(dirty){dirty=false;try{const data=JSON.stringify(state)+'\n';if(writeSnapshot)writeSnapshot(data);else writeFileSync(join(folder(),'reader-diagnostic.json'),data);}catch{/* Never fall back to raw stderr. */}}
    if(sendDirty){sendDirty=false;try{const data=JSON.stringify(state.lastSend)+'\n';if(writeSendSnapshot)writeSendSnapshot(data);else if(!writeSnapshot)writeFileSync(join(folder(),'reader-send-diagnostic.json'),data);}catch{/* An injected primary writer never falls back to disk. */}}
  };
  const schedule=()=>{dirty=true;if(!timer){timer=setTimeout(save,debounceMs);timer.unref?.();}};
  return {
    note(event,details={}){
      if(ended)return;
      // Photo producers are a privacy boundary: never retain arbitrary keys,
      // socket objects, unbounded getter results or custom serialization hooks.
      const photoFramesProvided=event==='photo-upload' && safeOwn(details,'frames');
      if(event==='photo-upload'){details=safePhotoDetails(details);if(!details)return;}
      if(event==='send-stage'){
        if(!SEND_STAGES.has(details?.stage))return;
        if(details.stage==='start'){
          if(!['text','reply'].includes(details.kind))return;
          state.lastSend={rawValuesRecorded:false,startedAt:state.startedAt,kind:details.kind,events:[]};sendAttempted=false;
        }else if(!state.lastSend)return;
        sendAttempted ||= details.writeAttempted===true;
        const row={stage:details.stage,elapsedMs:Math.max(0,Math.min(2147483647,Date.now()-state.startedAt))};
        if(typeof details.writeAttempted==='boolean' || sendAttempted)row.writeAttempted=sendAttempted;
        if(SEND_PHASES.has(details.phase))row.phase=details.phase;
        if(Number.isInteger(details.status) && details.status>=-2147483648 && details.status<=2147483647)row.status=details.status;
        if(SEND_REASONS.has(details.reason))row.reason=details.reason;
        state.lastSend.events.push(row);state.lastSend.events=state.lastSend.events.slice(-12);
        state.events.push({event:'send-stage',...row});state.events=state.events.slice(-40);
        sendDirty=true;schedule();return;
      }
      if(event==='request' && details.method==='NOTIREAD')state.readSync.requests++;
      state.lastOperation=typeof details.method==='string'?safeMethod(details.method):state.lastOperation;
      const elapsedMs=Date.now()-state.startedAt;
      if(event==='photo-upload' && UPLOAD_STAGES.has(details.stage)){
        if(details.stage==='ship' || details.stage==='https_start'){state.uploadStages={};streamBytes=0;}
        const bytes=Math.max(...[details.sentBytes,details.totalBytes].filter(value=>Number.isSafeInteger(value)&&value>=0&&value<=10*1024*1024),0);
        const row=state.uploadStages[details.stage] ?? {firstElapsedMs:elapsedMs,lastElapsedMs:elapsedMs,bytes:0,frames:0,count:0};
        row.lastElapsedMs=elapsedMs;row.bytes=Math.max(row.bytes,bytes);row.count++;
        for(const name of ['sentBytes','totalBytes'])if(Number.isSafeInteger(details[name]) && details[name]>=0 && details[name]<=10*1024*1024)row[name]=Math.max(row[name] ?? 0,details[name]);
        if(details.write)row.write=details.write;
        if(details.stage==='complete_observed' && row.count===1)for(const name of ['status','beforeStreamEnd'])if(Object.hasOwn(details,name))row[name]=details[name];
        if(details.stage==='stream'){
          if(Number.isSafeInteger(details.frames) && details.frames>=0 && details.frames<=100000)row.frames=Math.max(row.frames,details.frames);
          else if(!photoFramesProvided && Number.isSafeInteger(details.sentBytes) && details.sentBytes>streamBytes && details.sentBytes<=10*1024*1024)row.frames++;
          if(Number.isSafeInteger(details.sentBytes) && details.sentBytes>=0 && details.sentBytes<=10*1024*1024)streamBytes=Math.max(streamBytes,details.sentBytes);
        }
        state.uploadStages[details.stage]=row;
      }
      state.events.push({event,elapsedMs,...details});state.events=state.events.slice(-40);schedule();
    },
    packet(direction,packet){
      const method=safeMethod(packet?.method);
      const body=packet?.body;
      if(!ended && direction==='response' && method==='NOTIREAD'){
        const status=responseStatus(packet);state.readSync.responses++;
        state.readSync[status===0?'accepted':Number.isInteger(status)?'rejected':'unknown']++;
      }
      this.note(direction,{method,status:Number.isInteger(packet?.status)?packet.status:null,bodyStatus:Number.isInteger(body?.status)?body.status:null,isOK:typeof body?.isOK==='boolean'?body.isOK:null,schema:schemaShape(body)});
    },
    flush:save,
    end(reason,error){if(ended)return;state.exitReason=reason;if(error)state.fault=safeFault(error);ended=true;dirty=true;save();},
  };
}
