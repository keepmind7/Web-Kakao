import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateDataRoot,ensurePrivateDirectory } from './private-storage.mjs';
import { randomUUID } from 'node:crypto';
import { responseStatus } from './reader-response.mjs';

const FIELDS=new Set(['chatDatas','chatInfos','chats','chatRooms','chatList','chatId','id','roomId','chatRoomId','c','t','a','n','s','l','i','k','ll','o','title','roomName','name','subject','meta','chatMetas','type','content','displayMembers','displayNickNames','displayNicknames','displayNames','nickName','nickname','profileName','displayName','lastChatLog','lastLog','chatLog','log','chatLogs','logs','msgs','messages','logId','msgId','message','msg','text','authorId','senderId','userId','writerId','sendAt','createdAt','updatedAt','lastChatLogId','lastLogId','isOK','minLogId','jsi','lastTokenId','lastChatId','status']);
const METHODS=new Set(['GETCONF','CHECKIN','LOGINLIST','SYNCMSG','MCHATLOGS','PING','MSG','KICKOUT','CHANGESVR','BLSYNC','CHATINFO','WRITE','CHATONROOM','NOTIREAD','DECUNREAD','SHIP','POST','COMPLETE']);
for(const method of ['SYNCLINK','INFOLINK'])METHODS.add(method);
for(const field of ['ols','dlis','ltk','li','linkId','openLinkId','ln','linkName','ac','otk','isExpired','expired','olu','lmt','opt','pv','mt','notiRead'])FIELDS.add(field);
for(const field of ['m','mi','w','watermark','chatInfo','lastSeenLogId','activeMembersCount','left','attachment','url','thumbnailUrl','imageUrls','thumbnailUrls','h','wl','hl'])FIELDS.add(field);
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
const UPLOAD_STAGES=new Set(['ship','route','connect','post','offset','stream','await_complete','received_complete','transport','deadline','exception']);
export function createReaderDiagnostic({writeSnapshot=null,debounceMs=50}={}){

  const state={runId:randomUUID(),startedAt:Date.now(),rawValuesRecorded:false,lastOperation:'startup',readSync:{requests:0,responses:0,accepted:0,rejected:0,unknown:0},events:[],uploadStages:{}};let ended=false,timer=null,dirty=false,streamBytes=0,outputFolder=null;
  const save=()=>{clearTimeout(timer);timer=null;if(!dirty)return;dirty=false;try{const data=JSON.stringify(state,null,2)+'\n';if(writeSnapshot)writeSnapshot(data);else{if(!outputFolder){const folder=join(privateDataRoot(),'web-auth');ensurePrivateDirectory(folder);outputFolder=folder;}writeFileSync(join(outputFolder,'reader-diagnostic.json'),data);}}catch{/* Never fall back to raw stderr. */}};
  const schedule=()=>{dirty=true;if(!timer){timer=setTimeout(save,debounceMs);timer.unref?.();}};
  return {
    note(event,details={}){
      if(ended)return;
      if(event==='request' && details.method==='NOTIREAD')state.readSync.requests++;
      state.lastOperation=typeof details.method==='string'?safeMethod(details.method):state.lastOperation;
      const elapsedMs=Date.now()-state.startedAt;
      if(event==='photo-upload' && UPLOAD_STAGES.has(details.stage)){
        if(details.stage==='ship'){state.uploadStages={};streamBytes=0;}
        const bytes=Math.max(...[details.sentBytes,details.totalBytes].filter(value=>Number.isSafeInteger(value)&&value>=0&&value<=10*1024*1024),0);
        const row=state.uploadStages[details.stage] ?? {firstElapsedMs:elapsedMs,lastElapsedMs:elapsedMs,bytes:0,frames:0,count:0};
        row.lastElapsedMs=elapsedMs;row.bytes=Math.max(row.bytes,bytes);row.count++;
        if(details.stage==='stream' && Number.isSafeInteger(details.sentBytes) && details.sentBytes>streamBytes && details.sentBytes<=10*1024*1024){row.frames++;streamBytes=details.sentBytes;}
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
