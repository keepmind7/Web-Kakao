import { createHmac, randomBytes } from 'node:crypto';

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
function metaTitle(value) {
  if (typeof value === 'string') {
    if (value.length>8192) return '';
    try { return metaTitle(JSON.parse(value)); } catch { return value.length<=120 ? value : ''; }
  }
  if (!object(value)) return '';
  return clean(value.title ?? value.name ?? value.subject,120);
}
function title(row) {
  const direct = clean(row?.title ?? row?.roomName ?? row?.name ?? row?.subject,120);
  if (direct) return direct;
  const meta=metaTitle(row?.meta); if(meta)return meta;
  const metas=Array.isArray(row?.chatMetas) ? row.chatMetas.slice(0,50) : [];
  const named=metas.find(value=>value?.type===3);
  const fromMeta=metaTitle(named?.content ?? named);if(fromMeta)return fromMeta;
  const members=Array.isArray(row?.displayMembers)?row.displayMembers.slice(0,10).map(member=>clean(member?.nickName ?? member?.nickname ?? member?.name ?? member?.profileName ?? member?.displayName,80)):[];
  const names=[...members,...['displayNickNames','displayNicknames','displayNames','k'].flatMap(key=>Array.isArray(row?.[key])?row[key].slice(0,10).map(name=>clean(name,80)):[])].filter(Boolean);
  return [...new Set(names)].slice(0,5).join(', ').slice(0,120);
}
function text(log) {
  if (!object(log)) return '';
  const kind=Number(log.type ?? log.msgType ?? log.t ?? 1);
  if (kind!==1) return ({2:'[사진]',3:'[동영상]',5:'[음성]',18:'[파일]'})[kind] ?? '[지원하지 않는 메시지]';
  return clean(log.message ?? log.msg ?? log.text ?? log.content);
}

// Raw account/server identifiers stay inside the worker. Browser keys are
// session-scoped opaque handles; data is never serialized to disk or a log.
export function createReaderStore(body, ownUserId, salt=randomBytes(32)) {
  const rows=roomArray(body);
  if (!rows) throw new Error('room_list_missing');
  const sourceRoomCount=rows.length;
  const rooms=new Map(),byServerId=new Map(),cache=new Map(),aliases=new Map();
  let duplicates=0,invalidMessages=0;
  const opaque=(prefix,id)=>prefix+createHmac('sha256',salt).update(id).digest('hex').slice(0,24);
  for (const row of rows.slice(0,ROOM_LIMIT)) {
    const serverRoomId=idOfRoom(row);if(!serverRoomId || byServerId.has(serverRoomId))continue;
    const key=opaque('r_',serverRoomId),name=title(row),last=lastLog(row);
    rooms.set(key,{key,serverRoomId,title:name || `이름 없는 대화방 ${rooms.size+1}`,titleKnown:Boolean(name),preview:text(last).slice(0,160),lastAt:timestamp(last?.sendAt ?? last?.createdAt ?? row?.updatedAt)});
    byServerId.set(serverRoomId,key);
  }
  function merge(key,logs) {
    const room=rooms.get(key);if(!room)return null;
    const messages=cache.get(key) ?? new Map();
    cache.delete(key);cache.set(key,messages);
    while(cache.size>CACHE_LIMIT){const removed=cache.keys().next().value;cache.delete(removed);for(const alias of aliases.keys())if(alias.startsWith(removed+':'))aliases.delete(alias);}
    let acceptedCount=0,rejectedCount=0;
    for(const log of logs.slice(0,200)) {
      if(!object(log)){rejectedCount++;invalidMessages++;continue;}
      const id=serverId(log.logId ?? log.msgId ?? log.id);
      const attachedRoom=serverId(log.chatId ?? log.roomId ?? log.c);
      if(!id || (attachedRoom && attachedRoom!==room.serverRoomId)){invalidMessages++;rejectedCount++;continue;}
      acceptedCount++;
      const sender=serverId(log.authorId ?? log.senderId ?? log.userId ?? log.writerId ?? log.sender?.userId);
      const mine=Boolean(sender && sender===ownUserId);
      const authorKey=key+':'+sender;
      if(sender && !aliases.has(authorKey) && aliases.size<5000)aliases.set(authorKey,`참여자 ${[...aliases.keys()].filter(value=>value.startsWith(key+':')).length+1}`);
      const name=clean(log.senderName ?? log.authorName ?? log.nickname ?? log.sender?.nickname,80);
      if(messages.has(id))duplicates++;
      messages.set(id,{key:opaque('m_',room.serverRoomId+':'+id),text:text(log),sender:mine?'나':name || aliases.get(authorKey) || '작성자 미확인',mine,at:timestamp(log.sendAt ?? log.createdAt ?? log.created_at)});
    }
    const ordered=[...messages.keys()].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
    for(const id of ordered.slice(0,Math.max(0,ordered.length-MESSAGE_LIMIT)))messages.delete(id);
    return {messages:[...messages.entries()].sort(([a],[b])=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0).map(([,value])=>value),acceptedCount,rejectedCount};
  }
  return {
    rooms(){return [...rooms.values()].map(({serverRoomId,last,...view})=>view).sort((a,b)=>(b.lastAt ?? 0)-(a.lastAt ?? 0));},
    has:key=>rooms.has(key),
    serverRoomId:key=>rooms.get(key)?.serverRoomId,
    history(key,response) {
      if(!rooms.has(key))throw new Error('unknown_room');
      const logs=logArray(response);
      return {key,...merge(key,logs ?? []),fieldPresent:Array.isArray(logs),receivedCount:logs?.length ?? 0};
    },
    push(body) {
      const logs=logArray(body) ?? (object(body) && serverId(body.logId) ? [body] : []);
      const updates=new Map();
      for(const log of logs.slice(0,200)) {
        const serverRoomId=serverId(body?.chatId ?? body?.c ?? log?.chatId ?? log?.roomId);
        const key=byServerId.get(serverRoomId);if(!key)continue;
        const room=rooms.get(key);const merged=merge(key,[log]);
        if(!merged?.acceptedCount)continue;
        const at=timestamp(log.sendAt ?? log.createdAt);
        if(at && (!room.lastAt || at>=room.lastAt)){room.lastAt=at;room.preview=text(log).slice(0,160);}
        updates.set(key,{key,messages:merged.messages});
      }
      return [...updates.values()];
    },
    stats:()=>({sourceRoomCount,roomCount:rooms.size,truncated:sourceRoomCount>ROOM_LIMIT,duplicates,invalidMessages}),
    clear(){rooms.clear();byServerId.clear();cache.clear();aliases.clear();},
  };
}
