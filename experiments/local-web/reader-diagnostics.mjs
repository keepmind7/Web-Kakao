import { mkdirSync,writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const FIELDS=new Set(['chatDatas','chatInfos','chats','chatRooms','chatList','chatId','id','roomId','chatRoomId','c','t','a','n','s','l','i','k','ll','o','title','roomName','name','subject','meta','chatMetas','type','content','displayMembers','displayNickNames','displayNicknames','displayNames','nickName','nickname','profileName','displayName','lastChatLog','lastLog','chatLog','log','chatLogs','logs','msgs','messages','logId','msgId','message','msg','text','authorId','senderId','userId','writerId','sendAt','createdAt','updatedAt','lastChatLogId','lastLogId','isOK','minLogId','jsi','lastTokenId','lastChatId','status']);
const METHODS=new Set(['GETCONF','CHECKIN','LOGINLIST','SYNCMSG','PING','MSG','KICKOUT','CHANGESVR','BLSYNC','CHATINFO']);
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
export function createReaderDiagnostic(){
  const folder=new URL('../../local-only/web-auth/',import.meta.url),path=new URL('reader-diagnostic.json',folder);
  const state={runId:randomUUID(),startedAt:Date.now(),rawValuesRecorded:false,lastOperation:'startup',events:[]};let ended=false;
  const save=()=>{try{mkdirSync(fileURLToPath(folder),{recursive:true});writeFileSync(path,JSON.stringify(state,null,2)+'\n');}catch{/* Never fall back to raw stderr. */}};
  return {
    note(event,details={}){
      if(ended)return;
      state.lastOperation=typeof details.method==='string'?safeMethod(details.method):state.lastOperation;
      state.events.push({event,elapsedMs:Date.now()-state.startedAt,...details});state.events=state.events.slice(-40);save();
    },
    packet(direction,packet){
      const method=safeMethod(packet?.method);
      const body=packet?.body;
      this.note(direction,{method,status:Number.isInteger(packet?.status)?packet.status:null,bodyStatus:Number.isInteger(body?.status)?body.status:null,isOK:typeof body?.isOK==='boolean'?body.isOK:null,schema:schemaShape(body)});
    },
    end(reason,error){if(ended)return;state.exitReason=reason;if(error)state.fault=safeFault(error);ended=true;save();},
  };
}
