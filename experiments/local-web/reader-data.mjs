import { createHmac, randomBytes } from 'node:crypto';
import { preferenceId } from './preferences.mjs';
import { photoAttachments } from './photos.mjs';
import { attachmentObject,replyExtra } from './message-content.mjs';

export const ROOM_LIMIT = 500, MESSAGE_LIMIT = 50, CACHE_LIMIT = 20;
export const roomKeyValid = value => typeof value === 'string' && /^r_[a-f0-9]{24}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clean = (value,max=4000) => typeof value === 'string' ? value.slice(0,max) : '';
export function serverId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  try {
    const text = ['string','number','bigint'].includes(typeof value) ? String(value) : object(value) && typeof value.toString === 'function' ? value.toString() : '';
    return /^[1-9]\d{0,29}$/.test(text) ? text : '';
  } catch { return ''; }
}
// Relationships only: raw account, room and message identifiers stay in worker memory.
export function compareReadPosition(body,roomId,logId){
  const info=body?.chatInfo,target=serverId(logId),expected=serverId(roomId);
  if(!expected || !target || serverId(info?.chatId)!==expected)return {roomMatched:false,seenAtLeastTarget:null};
  const value=info.lastSeenLogId;
  const seen=value===0 || value===0n || value==='0'?'0':serverId(value);
  return {roomMatched:true,seenAtLeastTarget:seen?BigInt(seen)>=BigInt(target):null};
}
export function roomArray(body) {
  return ['chatDatas','chatInfos','chats','chatRooms','chatList'].map(key=>body?.[key]).find(Array.isArray);
}
export function logArray(body) {
  for (const key of ['chatLog','log','l']) if (object(body?.[key]) && !Array.isArray(body[key])) return [body[key]];
  return ['chatLogs','logs','msgs','messages','l'].map(key=>body?.[key]).find(Array.isArray);
}
const idOfRoom = row => serverId(row?.chatId ?? row?.id ?? row?.roomId ?? row?.chatRoomId ?? row?.c);
const lastLog = row => row?.lastChatLog ?? row?.lastLog ?? row?.chatLog ?? (object(row?.l) ? row.l : null);
function timestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const ms = number < 1e10 ? number*1000 : number;
  return ms >= 315532800000 && ms <= 4102444800000 ? Math.floor(ms) : null;
}
const titleText=(...values)=>values.map(value=>clean(value,120).trim()).find(Boolean) || '';
function metaTitle(value) {
  if (typeof value === 'string') {
    if (value.length>8192) return '';
    const raw=value.trim();
    try {
      const parsed=JSON.parse(raw);
      if(typeof parsed==='string')return titleText(parsed);
      if(object(parsed))return titleText(parsed.title,parsed.name,parsed.subject);
      // A title such as 123 or true remains literal text, not a lost JSON scalar.
      return !Array.isArray(parsed) && raw.length<=120?raw:'';
    } catch { return raw.length<=120 && !/^[{[\"]/.test(raw)?raw:''; }
  }
  if (!object(value)) return '';
  return titleText(value.title,value.name,value.subject);
}
function title(row,ownUserId) {
  const direct = titleText(row?.title,row?.roomName,row?.name,row?.subject);
  if (direct) return direct;
  const meta=metaTitle(row?.meta); if(meta)return meta;
  const metas=Array.isArray(row?.chatMetas) ? row.chatMetas.slice(0,50) : [];
  for(const named of metas.filter(value=>value?.type===3)){const fromMeta=metaTitle(named?.content ?? named);if(fromMeta)return fromMeta;}
  const members=Array.isArray(row?.displayMembers)?row.displayMembers.slice(0,10).filter(member=>serverId(member?.userId)!==ownUserId).map(member=>titleText(member?.nickName,member?.nickname,member?.name,member?.profileName,member?.displayName).slice(0,80)):[];
  const names=[...members,...['displayNickNames','displayNicknames','displayNames','k'].flatMap(key=>Array.isArray(row?.[key])?row[key].slice(0,10).filter((_,i)=>key!=='k' || !Array.isArray(row.i) || row.i.length!==row.k.length || serverId(row.i[i])!==ownUserId).map(name=>titleText(name).slice(0,80)):[])].filter(Boolean);
  return [...new Set(names)].slice(0,5).join(', ').slice(0,120);
}
function text(log) {
  if (!object(log)) return '';
  const kind=Number(log.type ?? log.msgType ?? log.t ?? 1);
  if (![1,26].includes(kind)) return ({2:'[사진]',27:'[사진 모음]',3:'[동영상]',5:'[음성]',18:'[파일]'})[kind] ?? '[지원하지 않는 메시지]';
  const value=log.message ?? log.msg ?? log.text ?? log.content;
  return typeof value==='string'?(value.length<=4000?value:[...value].slice(0,4000).join('')):'';
}

// Raw account/server identifiers stay inside the worker. Browser keys are
// session-scoped opaque handles; data is never serialized to disk or a log.
export function createReaderStore(body, ownUserId, salt=randomBytes(32),settingsSecret=null) {
  const rows=roomArray(body);
  if (!rows) throw new Error('room_list_missing');
  let sourceRoomCount=rows.length;
  const rooms=new Map(),byServerId=new Map(),cache=new Map(),aliases=new Map();
  let duplicates=0,invalidMessages=0,aliasCount=0;
  const opaque=(prefix,id)=>prefix+createHmac('sha256',salt).update(id).digest('hex').slice(0,24);
  function addRoom(row,{discovered=false}={}) {
    const serverRoomId=idOfRoom(row);if(!serverRoomId || byServerId.has(serverRoomId) || rooms.size>=ROOM_LIMIT)return null;
    const kind=['DirectChat','MultiChat','MemoChat'].includes(row?.t ?? row?.type)?(row.t ?? row.type):'unknown';
    const key=opaque('r_',serverRoomId),name=kind==='MemoChat'?'나와의 채팅':title(row,ownUserId),candidate=lastLog(row);
    const attached=serverId(candidate?.chatId ?? candidate?.roomId ?? candidate?.c);
    const last=attached && attached!==serverRoomId?null:candidate;
    const historyEnd=[row?.ll,row?.lastLogId,row?.lastChatLogId,last?.logId,last?.msgId].map(serverId).filter(Boolean).sort((a,b)=>BigInt(a)>BigInt(b)?-1:BigInt(a)<BigInt(b)?1:0)[0] ?? null;
    const seedId=serverId(last?.logId ?? last?.msgId);
    const seed=seedId?{logId:seedId,chatId:serverRoomId,authorId:serverId(last?.authorId ?? last?.senderId),type:last?.type ?? last?.t,attachment:last?.attachment,msg:text(last),sendAt:timestamp(last?.sendAt ?? last?.createdAt),senderName:clean(last?.senderName ?? last?.authorName,80)}:null;
    const names=new Map();
    if(Array.isArray(row?.i) && Array.isArray(row?.k))for(let n=0;n<Math.min(row.i.length,row.k.length,500);n++){const id=serverId(row.i[n]),name=clean(row.k[n],80);if(id && name)names.set(id,name);}
    rooms.set(key,{key,serverRoomId,historyEnd,baseline:discovered?'0':historyEnd,seed,names,kind,expectedMembers:Number.isSafeInteger(row.a ?? row.activeMembersCount)?(row.a ?? row.activeMembersCount):null,members:null,watermarks:new Map(),receiptReady:false,
      title:name || `이름 없는 대화방 ${rooms.size+1}`,titleKnown:Boolean(name),preview:text(last).slice(0,160),lastAt:timestamp(last?.sendAt ?? last?.createdAt ?? row?.updatedAt)});
    byServerId.set(serverRoomId,key);
    return key;
  }
  for(const row of rows.slice(0,ROOM_LIMIT))addRoom(row);
  function merge(key,logs,requireRoomId=false) {
    const room=rooms.get(key);if(!room)return null;
    const messages=cache.get(key) ?? new Map();
    cache.delete(key);cache.set(key,messages);
    while(cache.size>CACHE_LIMIT){const removed=cache.keys().next().value;cache.delete(removed);aliasCount-=aliases.get(removed)?.size ?? 0;aliases.delete(removed);}
    let roomAliases=aliases.get(key);
    let acceptedCount=0,rejectedCount=0;
    for(const log of logs.slice(0,200)) {
      if(!object(log)){rejectedCount++;invalidMessages++;continue;}
      const id=serverId(log.logId ?? log.msgId ?? log.id);
      const attachedRoom=serverId(log.chatId ?? log.roomId ?? log.c);
      if(!id || (requireRoomId && attachedRoom!==room.serverRoomId) || (attachedRoom && attachedRoom!==room.serverRoomId)){invalidMessages++;rejectedCount++;continue;}
      acceptedCount++;
      const sender=serverId(log.authorId ?? log.senderId ?? log.userId ?? log.writerId ?? log.sender?.userId);
      const mine=Boolean(sender && sender===ownUserId);
      if(sender && !roomAliases?.has(sender) && aliasCount<5000){
        if(!roomAliases){roomAliases=new Map();aliases.set(key,roomAliases);}
        roomAliases.set(sender,`참여자 ${roomAliases.size+1}`);aliasCount++;
      }
      const name=clean(log.senderName ?? log.authorName ?? log.nickname ?? log.sender?.nickname,80) || room.names.get(sender);
      if(messages.has(id))duplicates++;
      const type=Number(log.type ?? log.msgType ?? log.t ?? 1),attachment=type===26?attachmentObject(log.attachment):null;
      const reply=attachment && typeof attachment.src_message==='string'?{text:clean(attachment.src_message,4000),sender:serverId(attachment.src_userId)===ownUserId?'나':room.names.get(serverId(attachment.src_userId)) || '원본 메시지'}:null;
      const target={id,authorId:sender,type,text:text(log)};
      messages.set(id,{key:opaque('m_',room.serverRoomId+':'+id),text:text(log),photos:photoAttachments(log),sender:mine?'나':name || roomAliases?.get(sender) || '작성자 미확인',mine,reply,canReply:Boolean(replyExtra(target)),replyTarget:target,at:timestamp(log.sendAt ?? log.createdAt ?? log.created_at)});
    }
    const ordered=[...messages.keys()].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
    for(const id of ordered.slice(0,Math.max(0,ordered.length-MESSAGE_LIMIT)))messages.delete(id);
    return {...view(key,ordered.slice(-MESSAGE_LIMIT)),acceptedCount,rejectedCount};
  }
  function view(key,knownOrder){
    const room=rooms.get(key),messages=cache.get(key) ?? new Map();
    if(!room)return {messages:[],latestVisible:false};
    const ordered=knownOrder ?? [...messages.keys()].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
    return {messages:ordered.map(id=>{
      const item=messages.get(id);let unreadCount=null;
      if(item.mine && room.kind==='MemoChat')unreadCount=0;
      else if(item.mine && room.receiptReady && room.members){
        const peers=[...room.members].filter(member=>member!==ownUserId);
        if(peers.every(member=>room.watermarks.has(member)))unreadCount=peers.filter(member=>BigInt(room.watermarks.get(member))<BigInt(id)).length;
      }
      const {replyTarget,...publicItem}=item;return {...publicItem,unreadCount};
    }),latestVisible:Boolean(room.historyEnd && messages.has(room.historyEnd))};
  }
  function watermark(value){
    try{if(value===0 || value===0n || value==='0' || object(value) && value.toString?.()==='0')return '0';return serverId(value);}catch{return '';}
  }
  return {
    rooms(){return [...rooms.values()].map(room=>({key:room.key,...(settingsSecret?{preferenceKey:preferenceId(settingsSecret,'room',ownUserId,room.serverRoomId)}:{}),title:room.title,titleKnown:room.titleKnown,preview:room.preview,lastAt:room.lastAt,kind:room.kind,canSend:room.kind!=='unknown',historyAvailable:Boolean(room.historyEnd)})).sort((a,b)=>(b.lastAt ?? 0)-(a.lastAt ?? 0));},
    has:key=>rooms.has(key),
    serverRoomId:key=>rooms.get(key)?.serverRoomId,
    historyEnd:key=>rooms.get(key)?.historyEnd,
    canSend:key=>rooms.has(key) && rooms.get(key).kind!=='unknown',
    unknownRooms(body){
      if(rooms.size>=ROOM_LIMIT)return [];
      const ids=new Set();
      for(const log of (logArray(body) ?? []).slice(0,200)){
        const id=serverId(body?.chatId ?? body?.c ?? log?.chatId ?? log?.roomId),attached=serverId(log?.chatId ?? log?.roomId ?? log?.c);
        if(id && (!attached || attached===id) && serverId(log?.logId ?? log?.msgId ?? log?.id) && !byServerId.has(id))ids.add(id);
      }
      return [...ids];
    },
    discover(id,response){
      const row=response?.chatInfo;
      if(!object(row) || idOfRoom(row)!==id || row.left===true)return null;
      const key=addRoom(row,{discovered:true});if(key)sourceRoomCount++;
      return key;
    },
    current:key=>({key,...view(key)}),
    logForMessage(key,messageKey){return [...(cache.get(key)?.entries() ?? [])].find(([,message])=>message.key===messageKey)?.[0];},
    readTargetForMessage(key,messageKey){
      const entries=[...(cache.get(key)?.entries() ?? [])],requested=entries.find(([,message])=>message.key===messageKey);
      if(!requested)return null;
      let target=requested;
      if(requested[1].mine){
        const incoming=entries.filter(([id,message])=>message.replyTarget?.authorId && message.replyTarget.authorId!==ownUserId && BigInt(id)<=BigInt(requested[0]));
        for(const candidate of incoming)if(target===requested || BigInt(candidate[0])>BigInt(target[0]))target=candidate;
      }
      return {logId:target[0],mine:target[1].mine,requestedIsOwn:requested[1].mine};
    },
    replyForMessage(key,messageKey){const item=[...(cache.get(key)?.values() ?? [])].find(message=>message.key===messageKey);return item?.canReply?replyExtra(item.replyTarget):null;},
    receiptSnapshot(key,body){
      const room=rooms.get(key);if(!room)return false;room.receiptReady=false;
      if(serverId(body?.c ?? body?.chatId)!==room.serverRoomId)return false;
      const ids=Array.isArray(body.mi)?body.mi:Array.isArray(body.m)?body.m.map(member=>member?.userId):null;
      if(!ids || ids.length>100 || !Array.isArray(body.a) || !Array.isArray(body.w) || body.a.length!==body.w.length){room.receiptReady=false;return false;}
      const members=ids.map(serverId);if(members.some(id=>!id) || (room.kind!=='MemoChat' && !members.some(id=>id!==ownUserId))){room.receiptReady=false;return false;}
      const marks=new Map();
      for(let i=0;i<body.a.length;i++){const id=serverId(body.a[i]),value=watermark(body.w[i]);if(id && value)marks.set(id,value);}
      room.members=new Set([...members,ownUserId]);room.watermarks=marks;
      if(room.expectedMembers!==null && room.expectedMembers!==room.members.size){room.receiptReady=false;return false;}
      room.receiptReady=[...room.members].filter(id=>id!==ownUserId).every(id=>marks.has(id));
      return room.receiptReady;
    },
    invalidateReceipts(body){
      const key=byServerId.get(serverId(body?.chatId ?? body?.c ?? body?.chatLog?.chatId)),room=rooms.get(key);
      if(!room)return null;room.receiptReady=false;return {key,...view(key)};
    },
    readUpdate(body){
      const key=byServerId.get(serverId(body?.chatId ?? body?.c)),room=rooms.get(key);
      const user=serverId(body?.userId),mark=watermark(body?.watermark);
      if(!room || !user || !mark)return null;
      if(room.members && !room.members.has(user))room.receiptReady=false;
      const previous=room.watermarks.get(user);if(!previous || BigInt(mark)>BigInt(previous))room.watermarks.set(user,mark);
      return {key,...view(key)};
    },
    writeAccepted(key,body,message,{type=1,attachment}={}){
      const room=rooms.get(key);if(!room)return null;
      const original=body?.chatLog ?? body?.log;
      const id=serverId(original?.logId ?? body?.logId);
      if(!id)return null;
      const attached=serverId(original?.chatId ?? body?.chatId);
      if(attached && attached!==room.serverRoomId)return null;
      const update=this.push({chatId:room.serverRoomId,chatLog:{...original,chatId:room.serverRoomId,logId:id,authorId:ownUserId,type,msg:message,attachment:original?.attachment ?? attachment,sendAt:original?.sendAt ?? body?.sendAt}})[0];
      return update?{...update,messageKey:opaque('m_',room.serverRoomId+':'+id)}:null;
    },
    seedAtEnd:key=>Boolean(rooms.get(key)?.seed?.logId && rooms.get(key).seed.logId===rooms.get(key).historyEnd),
    recent(key){const seed=rooms.get(key)?.seed;return merge(key,seed?[seed]:[]);},
    historyCursor(key,response,{requireRoomId=false}={}){
      const room=rooms.get(key);if(!room)return null;
      const ids=(logArray(response) ?? []).slice(0,200).filter(log=>{
        const attached=serverId(log?.chatId ?? log?.roomId ?? log?.c);
        return requireRoomId?attached===room.serverRoomId:!attached || attached===room.serverRoomId;
      }).map(log=>serverId(log?.logId ?? log?.msgId ?? log?.id)).filter(id=>id && (!room.historyEnd || BigInt(id)<=BigInt(room.historyEnd)));
      return ids.sort((a,b)=>BigInt(a)>BigInt(b)?-1:BigInt(a)<BigInt(b)?1:0)[0] ?? null;
    },
    history(key,response,{requireRoomId=false}={}) {
      if(!rooms.has(key))throw new Error('unknown_room');
      const logs=logArray(response);
      return {key,...merge(key,logs ?? [],requireRoomId),fieldPresent:Array.isArray(logs),receivedCount:logs?.length ?? 0};
    },
    push(body) {
      const logs=logArray(body) ?? (object(body) && serverId(body.logId) ? [body] : []);
      const updates=new Map();
      for(const log of logs.slice(0,200)) {
        if(!object(log)){invalidMessages++;continue;}
        const serverRoomId=serverId(body?.chatId ?? body?.c ?? log?.chatId ?? log?.roomId);
        const key=byServerId.get(serverRoomId);if(!key)continue;
        const logId=serverId(log.logId ?? log.msgId ?? log.id);
        const attached=serverId(log.chatId ?? log.roomId ?? log.c);
        if(!logId || (attached && attached!==serverRoomId)){invalidMessages++;continue;}
        const room=rooms.get(key);
        if(logId && (!room.historyEnd || BigInt(logId)>BigInt(room.historyEnd)))room.historyEnd=logId;
        const merged=merge(key,[log]);if(!merged?.acceptedCount)continue;
        const at=timestamp(log.sendAt ?? log.createdAt);
        if(at && (!room.lastAt || at>=room.lastAt)){room.lastAt=at;room.preview=text(log).slice(0,160);}
        const sender=serverId(log.authorId ?? log.senderId ?? log.userId ?? log.writerId ?? log.sender?.userId);
        const kind=Number(log.type ?? log.msgType ?? log.t ?? 1);
        const arrivals=updates.get(key)?.arrivals ?? [];
        arrivals.push({key:opaque('m_',room.serverRoomId+':'+logId),incoming:sender?sender!==ownUserId:null,
          afterBaseline:room.baseline?BigInt(logId)>BigInt(room.baseline):null,userMessage:[1,2,3,5,18,26,27].includes(kind)});
        updates.set(key,{key,messages:merged.messages,latestVisible:merged.latestVisible,arrivals});
      }
      return [...updates.values()];
    },
    stats:()=>({sourceRoomCount,roomCount:rooms.size,truncated:sourceRoomCount>ROOM_LIMIT,duplicates,invalidMessages}),
    clear(){rooms.clear();byServerId.clear();cache.clear();aliases.clear();aliasCount=0;},
  };
}
