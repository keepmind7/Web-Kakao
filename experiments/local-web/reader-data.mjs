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
const normalKinds=new Set(['DirectChat','MultiChat','MemoChat']);
const openKinds=new Set(['OpenDirectChat','OpenMultiChat']);
const kindOf=value=>value==='OD'?'OpenDirectChat':value==='OM'?'OpenMultiChat':normalKinds.has(value) || openKinds.has(value)?value:'unknown';
const int32=value=>Number.isInteger(value) && value>=-2147483648 && value<=2147483647;
const signedLinkId=value=>{const id=serverId(value);return id && BigInt(id)<=9223372036854775807n?id:'';};
const fieldsOf=(row,fields)=>fields.filter(field=>object(row) && Object.hasOwn(row,field)).map(field=>row[field]);
function matchingRoom(body,id,{required=true}={}){
  const ids=[...fieldsOf(body,['chatId','roomId','chatRoomId','c']),...fieldsOf(body?.chatInfo,['chatId','id','roomId','chatRoomId','c'])];
  return (!required || ids.length>0) && ids.every(value=>serverId(value)===id);
}
function explicitTitle(row){return titleText(row?.title,row?.roomName,row?.name,row?.subject) || metaTitle(row?.meta) || (Array.isArray(row?.chatMetas)?row.chatMetas.slice(0,50).filter(value=>value?.type===3).map(value=>metaTitle(value.content ?? value)).find(Boolean):'') || '';}
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
export function createReaderStore(body, ownUserId, salt=randomBytes(32),settingsSecret=null,{onCacheEvicted=()=>{}}={}) {
  const rows=roomArray(body);
  if (!rows) throw new Error('room_list_missing');
  let sourceRoomCount=rows.length;
  const rooms=new Map(),byServerId=new Map(),cache=new Map(),aliases=new Map();
  let duplicates=0,invalidMessages=0,aliasCount=0,pinned=null;
  const opaque=(prefix,id)=>prefix+createHmac('sha256',salt).update(id).digest('hex').slice(0,24);
  function addRoom(row,{discovered=false}={}) {
    const serverRoomId=idOfRoom(row);if(!serverRoomId || byServerId.has(serverRoomId) || rooms.size>=ROOM_LIMIT)return null;
    const ids=fieldsOf(row,['chatId','id','roomId','chatRoomId','c']);if(ids.some(id=>serverId(id)!==serverRoomId))return null;
    const rawType=row?.t ?? row?.type,kind=row?.t!==undefined && row?.type!==undefined && kindOf(row.t)!==kindOf(row.type)?'unknown':kindOf(rawType);
    const key=opaque('r_',serverRoomId),name=kind==='MemoChat'?'나와의 채팅':title(row,ownUserId),candidate=lastLog(row);
    const attached=serverId(candidate?.chatId ?? candidate?.roomId ?? candidate?.c);
    const last=attached && attached!==serverRoomId?null:candidate;
    const historyEnd=[row?.ll,row?.lastLogId,row?.lastChatLogId,last?.logId,last?.msgId].map(serverId).filter(Boolean).sort((a,b)=>BigInt(a)>BigInt(b)?-1:BigInt(a)<BigInt(b)?1:0)[0] ?? null;
    const seedId=serverId(last?.logId ?? last?.msgId);
    const seed=seedId?{logId:seedId,chatId:serverRoomId,authorId:serverId(last?.authorId ?? last?.senderId),type:last?.type ?? last?.t,attachment:last?.attachment,msg:text(last),sendAt:timestamp(last?.sendAt ?? last?.createdAt),senderName:clean(last?.senderName ?? last?.authorName,80)}:null;
    const names=new Map();
    if(Array.isArray(row?.i) && Array.isArray(row?.k))for(let n=0;n<Math.min(row.i.length,row.k.length,500);n++){const id=serverId(row.i[n]),name=clean(row.k[n],80);if(id && name)names.set(id,name);}
    const linkIds=fieldsOf(row,['li','linkId','openLinkId']);
    const linkId=linkIds.length && linkIds.every(value=>serverId(value) && serverId(value)===serverId(linkIds[0]))?serverId(linkIds[0]):null;
    rooms.set(key,{key,serverRoomId,preferenceKey:settingsSecret?preferenceId(settingsSecret,'room',ownUserId,serverRoomId):null,historyEnd,baseline:discovered?'0':historyEnd,seed,names,kind,rawType,linkId,link:null,ownMember:null,contextVerified:false,token:'0',muteUntil:0,explicitTitle:Boolean(explicitTitle(row)),left:row.left===true,cacheEpoch:0,receiptVersion:0,membershipDirty:false,expectedMembers:Number.isSafeInteger(row.a ?? row.activeMembersCount)?(row.a ?? row.activeMembersCount):null,members:null,watermarks:new Map(),receiptReady:false,
      title:name || `이름 없는 대화방 ${rooms.size+1}`,titleKnown:Boolean(name),preview:text(last).slice(0,160),lastAt:timestamp(last?.sendAt ?? last?.createdAt ?? row?.updatedAt)});
    byServerId.set(serverRoomId,key);
    return key;
  }
  for(const row of rows.slice(0,ROOM_LIMIT))addRoom(row);
  function merge(key,logs,requireRoomId=false) {
    const room=rooms.get(key);if(!room)return null;
    const messages=cache.get(key) ?? new Map();
    cache.delete(key);cache.set(key,messages);
    while(cache.size>CACHE_LIMIT){
      const removed=[...cache.keys()].find(candidate=>candidate!==pinned);cache.delete(removed);aliasCount-=aliases.get(removed)?.size ?? 0;aliases.delete(removed);
      const evicted=rooms.get(removed);if(evicted)evicted.cacheEpoch++;
      onCacheEvicted(removed);
    }
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
  function capabilities(room){
    const normal=Boolean(room && normalKinds.has(room.kind) && !room.left);
    const linkReady=Boolean(room && openKinds.has(room.kind) && !room.left && room.linkId && room.link?.active===true && !room.link.expired);
    // Pinned node-kakao 8512e469 openlink/open-link-type.ts: OWNER=1,
    // NONE=2, MANAGER=4. This is a compatibility whitelist, not a complete
    // recovery of current privilege bits; unknown/bot roles stay disabled.
    const ready=linkReady && room.contextVerified && room.ownMember?.userId===ownUserId && [1,2,4].includes(room.ownMember.role);
    const writable=Boolean(ready && room.muteUntil===0);
    return {canText:normal || writable,canReply:normal || writable,canPhoto:normal || writable,canRead:normal || Boolean(ready),canContext:normal || linkReady,canSend:normal || writable};
  }
  function invalidate(room){room.receiptVersion++;room.contextVerified=false;room.ownMember=null;room.receiptReady=false;room.membershipDirty=true;}
  function applyLink(row,{deleted=false,eligible}={}){
    if(!object(row))return [];
    const ids=fieldsOf(row,['li','linkId','openLinkId']);
    if(!ids.length || ids.some(value=>!signedLinkId(value) || signedLinkId(value)!==signedLinkId(ids[0])))return [];
    const id=signedLinkId(ids[0]),changed=[];
    for(const room of rooms.values())if(openKinds.has(room.kind) && !room.left && room.linkId===id && (!eligible || eligible.has(room.key))){
      const active=deleted?false:row.ac===true;
      const expired=deleted || row.isExpired===true || row.expired===true; // raw ex is not an expiry field.
      const token=row.otk===undefined?null:int32(row.otk)?row.otk:null;
      const next={active,expired,token,name:titleText(row.ln,row.linkName)};
      // Any link revision can change the available actions. Do not let an old
      // context response re-enable a room after a metadata update/deletion.
      invalidate(room);room.link=next;
      if(next.name && !room.explicitTitle){room.title=next.name;room.titleKnown=true;}
      changed.push(room.key);
    }
    return changed;
  }
  function applyLinkRows(rows,{eligible,requested}={}){
    const candidates=new Map(),blocked=new Set(),changed=new Set();
    for(const row of rows){
      const ids=fieldsOf(row,['li','linkId','openLinkId']),id=ids.length?signedLinkId(ids[0]):'';
      if(!id || ids.some(value=>signedLinkId(value)!==id)){
        for(const value of ids){const attached=signedLinkId(value);if(attached && (!requested || requested.has(attached)))blocked.add(attached);}
        continue;
      }
      if(requested && !requested.has(id))continue;
      // Duplicate metadata is ambiguous even when its first row looks usable.
      // Revoke rather than let array order choose the room's available actions.
      if(candidates.has(id))blocked.add(id);else candidates.set(id,row);
    }
    for(const id of blocked)for(const key of applyLink({li:id,ac:false},{eligible}))changed.add(key);
    for(const [id,row] of candidates)if(!blocked.has(id))for(const key of applyLink(row,{eligible}))changed.add(key);
    return [...changed];
  }
  return {
    rooms(){return [...rooms.values()].map(room=>({key:room.key,...(room.preferenceKey?{preferenceKey:room.preferenceKey}:{}),contextRevision:room.receiptVersion,cacheEpoch:room.cacheEpoch,title:room.title,titleKnown:room.titleKnown,preview:room.preview,lastAt:room.lastAt,kind:room.kind,...capabilities(room),historyAvailable:Boolean(room.historyEnd)})).sort((a,b)=>(b.lastAt ?? 0)-(a.lastAt ?? 0));},
    pin(key){if(!rooms.has(key))return false;pinned=key;return true;},
    has:key=>rooms.has(key),
    serverRoomId:key=>rooms.get(key)?.serverRoomId,
    historyEnd:key=>rooms.get(key)?.historyEnd,
    cacheEpoch:key=>rooms.get(key)?.cacheEpoch,
    receiptVersion:key=>rooms.get(key)?.receiptVersion,
    canSend:key=>capabilities(rooms.get(key)).canSend,
    canAction(key,action){const name={send:'canText',reply:'canReply',photo:'canPhoto',read:'canRead',context:'canContext'}[action];return Boolean(name && capabilities(rooms.get(key))[name]);},
    isOpen:key=>openKinds.has(rooms.get(key)?.kind),
    linkId:key=>rooms.get(key)?.linkId,
    hasOpenLinks:()=>[...rooms.values()].some(room=>openKinds.has(room.kind) && !room.left && signedLinkId(room.linkId)),
    entryToken:key=>rooms.get(key)?.token ?? '0',
    entryOption:key=>rooms.get(key)?.ownMember?.token>=0?rooms.get(key).ownMember.token:0,
    entrySnapshot(key,response,version){
      const room=rooms.get(key);if(!room || version!==room.receiptVersion || !matchingRoom(response,room.serverRoomId))return false;
      const row=response?.chatInfo ?? response;
      room.contextVerified=false;room.ownMember=null;
      const links=[...fieldsOf(response,['li','linkId','openLinkId']),...fieldsOf(response?.chatInfo,['li','linkId','openLinkId'])];
      if(openKinds.has(room.kind) && (!room.linkId || links.some(value=>serverId(value)!==room.linkId)))return false;
      const token=response?.o===undefined?'0':watermark(response.o);if(!token)return false;
      // APK CHATONROOM.o -> saved room token -> next CHATONROOM.token. A
      // LOGINLIST/global cursor is deliberately never a token source.
      room.token=token;
      if(openKinds.has(room.kind)){
        // APK25.11.2 iq.o.a: userId Long, lmt/opt Integer, pv Long.
        // context.notiRead controls count display, not this action gate.
        const member=row.olu,role=member?.lmt,memberToken=member?.opt;
        const id=serverId(member?.userId);
        const mute=row.mt===undefined?0:row.mt;
        if(id!==ownUserId || !int32(role) || ![1,2,4].includes(role) || !int32(mute) || mute<0 || memberToken!==undefined && !int32(memberToken)){
          return true; // Matching entry ACK is distinct from action permission.
        }
        room.ownMember={userId:id,role,token:memberToken ?? -1,privilege:member.pv};room.muteUntil=mute;
      }
      room.contextVerified=true;return true;
    },
    linkSyncSnapshot:()=>new Map([...rooms.values()].map(room=>[room.key,room.receiptVersion])),
    missingOpenLinkIds(limit=16){
      const bounded=Number.isFinite(limit)?Math.min(16,Math.max(0,Math.floor(limit))):0,ids=new Set();
      for(const room of rooms.values())if(ids.size<bounded && openKinds.has(room.kind) && !room.left && room.link===null){const id=signedLinkId(room.linkId);if(id)ids.add(id);}
      return [...ids];
    },
    syncLinks(response,versions){
      if(!object(response) || response.ols!==undefined && (!Array.isArray(response.ols) || response.ols.length>ROOM_LIMIT) || response.dlis!==undefined && (!Array.isArray(response.dlis) || response.dlis.length>ROOM_LIMIT) || !int32(response.ltk) || response.ltk<0)return [];
      const changed=new Set();
      // Select the originally matching rooms once; an ols update itself bumps
      // their revision, so a deletion in this same snapshot must still win.
      const eligible=versions?new Set([...rooms.values()].filter(room=>versions.get(room.key)===room.receiptVersion).map(room=>room.key)):null;
      for(const key of applyLinkRows(response.ols ?? [],{eligible}))changed.add(key);
      for(const id of response.dlis ?? [])for(const key of applyLink({li:id},{deleted:true,eligible}))changed.add(key);
      return [...changed];
    },
    infoLinks(response,requestedIds,versions){
      if(!object(response) || !Array.isArray(response.ols) || response.ols.length>ROOM_LIMIT || !Array.isArray(requestedIds) || requestedIds.length>16 || !(versions instanceof Map))return [];
      const ids=requestedIds.map(signedLinkId);if(ids.some(id=>!id))return [];
      const requested=new Set(ids),eligible=new Set([...rooms.values()].filter(room=>openKinds.has(room.kind) && !room.left && room.link===null && requested.has(room.linkId) && versions.get(room.key)===room.receiptVersion).map(room=>room.key));
      return applyLinkRows(response.ols,{eligible,requested});
    },
    linkUpdate(method,response){
      if(method==='SYNCLINKPF' || method==='SYNCMEMT' || method==='LINKKICKED'){
        const roomIds=fieldsOf(response,['c','chatId','roomId']),linkIds=fieldsOf(response,['li','linkId']);
        if(!roomIds.length && !linkIds.length)return [];
        const updates=[];
        for(const room of rooms.values())if(openKinds.has(room.kind) && roomIds.every(id=>serverId(id)===room.serverRoomId) && linkIds.every(id=>serverId(id)===room.linkId)){
          invalidate(room);if(method==='LINKKICKED'){room.left=true;room.link=null;}
          updates.push({key:room.key,...view(room.key),receiptInvalidated:true,entryInvalidated:true});
        }
        return updates;
      }
      const row=response?.ol ?? response?.openLink ?? response;
      return applyLink(row,{deleted:['SYNCLINKDL','LNKDELETED'].includes(method)}).map(key=>({key,...view(key),receiptInvalidated:true,entryInvalidated:true}));
    },
    unnamedRooms(limit=8){
      return [...rooms.values()].filter(room=>!room.titleKnown && room.kind!=='MemoChat')
        .sort((a,b)=>(b.lastAt ?? 0)-(a.lastAt ?? 0)).slice(0,Math.min(8,Math.max(0,limit))).map(room=>room.key);
    },
    recoverTitle(key,response){
      const room=rooms.get(key),row=response?.chatInfo;
      if(!room || room.titleKnown || room.kind==='MemoChat' || !object(row) || row.left!==undefined && row.left!==false)return false;
      // CHATINFO is only optional display metadata here. Require an actual,
      // unambiguous response identity; never copy the requested ID into it.
      const ids=['chatId','id','roomId','chatRoomId','c'].filter(field=>Object.hasOwn(row,field));
      if(!ids.length || ids.some(field=>serverId(row[field])!==room.serverRoomId))return false;
      const name=explicitTitle(row) || room.link?.name || title(row,ownUserId);if(!name)return false;
      // In particular, displayMembers is not a verified membership snapshot.
      room.title=name;room.titleKnown=true;room.explicitTitle=Boolean(explicitTitle(row));return true;
    },
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
    receiptSnapshot(key,body,version){
      const room=rooms.get(key);if(!room || version!==undefined && version!==room.receiptVersion)return false;room.receiptReady=false;
      if(!matchingRoom(body,room.serverRoomId))return false;
      const ids=Array.isArray(body.mi)?body.mi:Array.isArray(body.m)?body.m.map(member=>member?.userId):null;
      if(!ids || ids.length>100 || !Array.isArray(body.a) || !Array.isArray(body.w) || body.a.length>100 || body.a.length!==body.w.length)return false;
      const members=ids.map(serverId);if(members.some(id=>!id) || new Set(members).size!==members.length || (room.kind!=='MemoChat' && !members.some(id=>id!==ownUserId)))return false;
      const memberSet=new Set([...members,ownUserId]);
      const marks=new Map();
      for(let i=0;i<body.a.length;i++){
        const id=serverId(body.a[i]),value=watermark(body.w[i]);
        if(!id || !value || !memberSet.has(id) || marks.has(id))return false;
        marks.set(id,value);
      }
      if(![...memberSet].filter(id=>id!==ownUserId).every(id=>marks.has(id)))return false;
      if(!room.membershipDirty && room.expectedMembers!==null && room.expectedMembers!==memberSet.size)return false;
      room.members=memberSet;room.watermarks=marks;room.expectedMembers=memberSet.size;room.membershipDirty=false;room.receiptReady=true;
      return true;
    },
    invalidateReceipts(body,{left=false}={}){
      const key=byServerId.get(serverId(body?.chatId ?? body?.c ?? body?.chatLog?.chatId)),room=rooms.get(key);
      if(!room)return null;invalidate(room);
      const suppliedLink=fieldsOf(body,['li','linkId']);
      if(suppliedLink.some(value=>serverId(value)!==room.linkId)){room.link=null;room.linkId=null;}
      if(body?.left===true || left && serverId(body?.userId)===ownUserId && body?.left!==false){room.left=true;room.link=null;}
      return {key,...view(key),receiptInvalidated:true,entryInvalidated:true};
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
      const sources=[body,body?.chatLog,body?.log];
      const attached=sources.flatMap(row=>fieldsOf(row,['chatId','roomId','chatRoomId','c']));
      if(type===2 && !attached.length || attached.some(value=>serverId(value)!==room.serverRoomId))return null;
      const authors=sources.flatMap(row=>[...fieldsOf(row,['authorId','senderId','userId','writerId']),...fieldsOf(row?.sender,['userId'])]);
      const types=sources.flatMap(row=>fieldsOf(row,['type','msgType','t']));
      const logs=sources.flatMap(row=>fieldsOf(row,['logId']));
      if(logs.some(value=>serverId(value)!==id) || authors.some(value=>serverId(value)!==ownUserId) || types.some(value=>!Number.isInteger(value) || value!==type))return null;
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
