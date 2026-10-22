import { createHmac, randomBytes } from 'node:crypto';
import { preferenceId } from './preferences.mjs';
import { photoAttachments } from './photos.mjs';
import { attachmentObject,replyExtra } from './message-content.mjs';

export const ROOM_LIMIT = 500, MESSAGE_LIMIT = 50, CACHE_LIMIT = 20;
const INITIAL_UNREAD_LIMIT=20000;
export function initialUnreadState(row){
  const count=row?.initialUnreadCount,coverage=row?.initialUnreadCoverage;
  const valid=count===undefined && !Object.hasOwn(row ?? {},'initialUnreadCount')
    || Number.isSafeInteger(count) && count>=0 && count<=INITIAL_UNREAD_LIMIT;
  const partial=!valid || coverage!==undefined && coverage!=='observed';
  return {initialUnreadCount:partial?0:count ?? 0,initialUnreadCoverage:partial?'partial':'observed'};
}
export const roomKeyValid = value => typeof value === 'string' && /^r_[a-f0-9]{24}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clean = (value,max=4000) => typeof value === 'string' ? value.slice(0,max) : '';
// Bound combining-mark stacks; strip controls, bidi overrides and separators from labels.
const marks = value => value.replace(/(\p{M}{4})\p{M}+/gu,'$1');
const label = (value,max) => typeof value === 'string' ? marks(value.slice(0,max*4).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g,'')).slice(0,max) : '';
// A peer's chosen name must never render as a label this client itself assigns.
const RESERVED=/^(?:나|참여자\d+|작성자미확인|원본메시지|원본확인불가)$/;
export function personName(value){const name=label(value,80).trim();return name && RESERVED.test(name.replace(/[\p{Cf}\p{Z}\s\u115f\u1160\u3164\uffa0]/gu,''))?`“${name}”`:name;}
export function serverId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  try {
    const text = ['string','number','bigint'].includes(typeof value) ? String(value) : object(value) && typeof value.toString === 'function' ? value.toString() : '';
    // The SDK's toLong wraps modulo 2^64: accept only positive signed int64 IDs.
    return /^[1-9]\d{0,18}$/.test(text) && BigInt(text)<=9223372036854775807n ? text : '';
  } catch { return ''; }
}
function quoteLogId(raw,attachment){
  if(typeof raw!=='string')return Object.hasOwn(attachment,'src_logId')?serverId(attachment.src_logId):'';
  // attachmentObject already validated this JSON object. Scan its top-level
  // members without converting numeric values through Number or matching text
  // embedded inside strings/nested objects. Decoded duplicate keys are ambiguous.
  let index=raw.indexOf('{')+1,id='';const keys=new Set();
  const whitespace=()=>{while(/\s/.test(raw[index] ?? ''))index++;};
  const string=()=>{
    const start=index++;
    while(index<raw.length){const ch=raw[index++];if(ch==='\\')index++;else if(ch==='"')break;}
    return raw.slice(start,index);
  };
  while(index<raw.length){
    whitespace();if(raw[index]==='}')break;
    const key=JSON.parse(string());if(keys.has(key))return '';keys.add(key);
    whitespace();index++;whitespace();const start=index;let depth=0;
    while(index<raw.length){
      const ch=raw[index];
      if(ch==='"'){string();continue;}
      if(ch==='{' || ch==='[')depth++;
      else if(ch==='}' || ch===']'){if(depth===0)break;depth--;}
      else if(ch===',' && depth===0)break;
      index++;
    }
    if(key==='src_logId'){
      const value=raw.slice(start,index).trim();
      id=serverId(value.startsWith('"')?JSON.parse(value):/^[1-9]\d{0,18}$/.test(value)?value:null);
    }
    if(raw[index]!==',')break;index++;
  }
  return id;
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
const signedLinkId=serverId;
const fieldsOf=(row,fields)=>fields.filter(field=>object(row) && Object.hasOwn(row,field)).map(field=>row[field]);
// MSG's top-level nickname belongs only to its one unambiguous original log.
// Check aliases before discovery normalizes them, so a conflict cannot be lost.
export function messageNickname(body,roomId){
  if(!object(body) || !object(body.chatLog) || logArray(body)?.length!==1 || typeof body.authorNickname!=='string')return undefined;
  if(['log','l','chatLogs','logs','msgs','messages'].some(field=>Object.hasOwn(body,field)))return undefined;
  const log=body.chatLog,rooms=[...fieldsOf(body,['chatId','roomId','chatRoomId','c']),...fieldsOf(log,['chatId','roomId','chatRoomId','c'])];
  const authors=[...fieldsOf(log,['authorId','senderId','userId','writerId']),...fieldsOf(log.sender,['userId'])];
  if(!serverId(roomId) || !rooms.length || rooms.some(id=>serverId(id)!==roomId) || !authors.length || !serverId(authors[0]) || authors.some(id=>serverId(id)!==serverId(authors[0]))
    || Object.hasOwn(log,'sender') && !object(log.sender))return undefined;
  return clean(body.authorNickname,80);
}
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
const titleText=(...values)=>values.map(value=>label(value,120).trim()).find(Boolean) || '';
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
  return typeof value==='string'?(value.length<=4000?marks(value):[...marks(value.slice(0,64000))].slice(0,4000).join('')):'';
}

// Raw account/server identifiers stay inside the worker. Browser keys are
// session-scoped opaque handles; data is never serialized to disk or a log.
export function createReaderStore(body, ownUserId, salt=randomBytes(32),settingsSecret=null,options={}) {
  const {onCacheEvicted=()=>{}}=options;
  const observeOwnRead=reason=>{try{options.observeOwnRead?.(reason);}catch{/* Observation must not change the store result. */}};
  const rows=roomArray(body);
  if (!rows) throw new Error('room_list_missing');
  let sourceRoomCount=rows.length;
  const rooms=new Map(),byServerId=new Map(),cache=new Map(),aliases=new Map();
  let duplicates=0,invalidMessages=0,aliasCount=0,pinned=null,unreadEntries=0;
  const opaque=(prefix,id)=>prefix+createHmac('sha256',salt).update(id).digest('hex').slice(0,24);
  const inlineAuthors=key=>new Set([...(cache.get(key)?.values() ?? [])].filter(item=>item.name.trim()).map(item=>item.authorId));
  const learn=(room,id,value)=>{
    const name=clean(value,80).trim();if(!serverId(id) || id===ownUserId || !name)return;
    if(!room.names.has(id) && room.names.size>=500){
      const protectedIds=new Set([id,...[...(cache.get(room.key)?.values() ?? [])].map(item=>item.authorId)]);
      const oldest=[...room.names.keys()].find(candidate=>!protectedIds.has(candidate));if(!oldest)return;
      room.names.delete(oldest);
    }
    room.names.delete(id);room.names.set(id,name);
  };
  function metadataScope(room,node){
    if(!object(node) || Object.hasOwn(node,'chatInfo') && !object(node.chatInfo))return false;
    const containers=[node,...(object(node.chatInfo)?[node.chatInfo]:[])];
    return containers.every(value=>fieldsOf(value,['chatId','roomId','chatRoomId','c',...(value===node.chatInfo?['id']:[])]).every(id=>serverId(id)===room.serverRoomId)
      && fieldsOf(value,['li','linkId','openLinkId']).every(id=>serverId(id)===room.linkId));
  }
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
    const counts=fieldsOf(row,['n','newMessageCount']);
    const invalidCount=counts.some(value=>!Number.isSafeInteger(value) || value<0 || value>INITIAL_UNREAD_LIMIT || value!==counts[0])
      || row?.invalidNewMessageCount!==undefined && row.invalidNewMessageCount!==false;
    const initialUnreadCount=discovered || invalidCount?0:counts[0] ?? 0,initialUnreadCoverage=!discovered && invalidCount?'partial':'observed';
    rooms.set(key,{key,serverRoomId,preferenceKey:settingsSecret?preferenceId(settingsSecret,'room',ownUserId,serverRoomId):null,historyEnd,baseline:discovered?'0':historyEnd,initialUnreadCount,initialUnreadCoverage,ownReadMark:null,ownReadPending:false,unreadLogs:new Map(),unreadPartial:false,seed,names,kind,rawType,linkId,link:null,ownMember:null,contextVerified:false,token:'0',muteUntil:0,explicitTitle:Boolean(explicitTitle(row)),left:row.left===true,cacheEpoch:0,receiptVersion:0,membershipDirty:false,expectedMembers:Number.isSafeInteger(row.a ?? row.activeMembersCount)?(row.a ?? row.activeMembersCount):null,members:null,watermarks:new Map(),receiptReady:false,
      title:name || `이름 없는 대화방 ${rooms.size+1}`,titleKnown:Boolean(name),preview:text(last).slice(0,160),lastAt:timestamp(last?.sendAt ?? last?.createdAt ?? row?.updatedAt)});
    byServerId.set(serverRoomId,key);
    return key;
  }
  for(const row of rows.slice(0,ROOM_LIMIT))addRoom(row);
  function merge(key,logs,requireRoomId=false,{preserveAck=false}={}) {
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
      const name=clean(log.senderName ?? log.authorName ?? log.nickname ?? log.sender?.nickname,80);
      if(messages.has(id))duplicates++;
      const type=Number(log.type ?? log.msgType ?? log.t ?? 1),attachment=type===26?attachmentObject(log.attachment):null;
      // The quoted author/text are sender-controlled. Keep only the claimed
      // source log; view() shows the cached original or an unverified label.
      const quote=attachment && typeof attachment.src_message==='string'?{text:marks(clean(attachment.src_message,4000)),logId:quoteLogId(log.attachment,attachment)}:null;
      const target={id,authorId:sender,type,text:text(log)};
      const previous=messages.get(id),photos=photoAttachments(log),at=timestamp(log.sendAt ?? log.createdAt ?? log.created_at);
      // Only an already identity-checked own ACK is additive. Ordinary MSG and
      // history replacements retain their existing explicit-change semantics.
      const compatible=preserveAck && previous?.authorId===ownUserId && sender===ownUserId && previous.verifiedType===type;
      const photoData=attachmentObject(log.attachment),hasPhotoFields=photoData && ['url','thumbnailUrl','imageUrls','thumbnailUrls'].some(field=>Object.hasOwn(photoData,field));
      const hasTime=['sendAt','createdAt','created_at'].some(field=>log[field]!==undefined);
      const verifiedType=['type','msgType','t'].some(field=>log[field]!==undefined)?type:undefined;
      messages.set(id,{key:opaque('m_',room.serverRoomId+':'+id),text:text(log),photos:compatible && !hasPhotoFields && !photos.length?previous.photos:photos,authorId:sender,name,mine,quote,verifiedType,canReply:Boolean(replyExtra(target)),replyTarget:target,at:compatible && !hasTime?previous.at:at});
    }
    const ordered=[...messages.keys()].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
    for(const id of ordered.slice(0,Math.max(0,ordered.length-MESSAGE_LIMIT)))messages.delete(id);
    return {...view(key,ordered.slice(-MESSAGE_LIMIT)),acceptedCount,rejectedCount};
  }
  function view(key,knownOrder){
    const room=rooms.get(key),messages=cache.get(key) ?? new Map();
    if(!room)return {messages:[],latestVisible:false};
    const ordered=knownOrder ?? [...messages.keys()].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
    // Names resolve here so a later MEMBER/CHATONROOM name updates cached rows.
    const roomAliases=aliases.get(key),senderOf=item=>item.mine?'나':personName(item.name) || personName(room.names.get(item.authorId)) || roomAliases?.get(item.authorId) || '작성자 미확인';
    return {messages:ordered.map(id=>{
      const item=messages.get(id);let unreadCount=null;
      if(item.mine && room.kind==='MemoChat')unreadCount=0;
      else if(item.mine && room.receiptReady && room.members){
        const peers=[...room.members].filter(member=>member!==ownUserId);
        if(peers.every(member=>room.watermarks.has(member)))unreadCount=peers.filter(member=>BigInt(room.watermarks.get(member))<BigInt(id)).length;
      }
      const original=item.quote?.logId?messages.get(item.quote.logId):null;
      const reply=item.quote?original?{text:original.text,sender:senderOf(original),verified:true}:{text:item.quote.text,sender:'원본 확인 불가',verified:false}:null;
      const {replyTarget,authorId,name,quote,verifiedType,...publicItem}=item;return {...publicItem,sender:senderOf(item),reply,unreadCount};
    }),latestVisible:Boolean(room.historyEnd && messages.has(room.historyEnd))};
  }
  function watermark(value){
    try{if(value===0 || value===0n || value==='0' || object(value) && value.toString?.()==='0')return '0';return serverId(value);}catch{return '';}
  }
  function ownReadUpdate(room,{release=true}={}){
    const mark=room.ownReadMark;if(mark===null)return null;
    const keys=[];
    for(const [id,key] of room.unreadLogs)if(BigInt(id)<=BigInt(mark)){
      keys.push(key);if(release){room.unreadLogs.delete(id);unreadEntries--;}
    }
    const clearInitial=room.baseline!==null && BigInt(mark)>=BigInt(room.baseline);
    const clearEvents=Boolean(room.historyEnd && BigInt(mark)>=BigInt(room.historyEnd));
    if(release)room.ownReadPending=false;
    return {key:room.key,ownRead:{keys,clearInitial,clearEvents,partial:room.unreadPartial || !clearInitial && room.initialUnreadCount>0}};
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
  function invalidate(room){room.receiptVersion++;room.contextVerified=false;room.ownMember=null;room.pendingOwnMember=null;room.receiptReady=false;room.membershipDirty=true;}
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
    rooms(){return [...rooms.values()].map(room=>({key:room.key,...(room.preferenceKey?{preferenceKey:room.preferenceKey}:{}),contextRevision:room.receiptVersion,cacheEpoch:room.cacheEpoch,title:room.title,titleKnown:room.titleKnown,preview:room.preview,lastAt:room.lastAt,kind:room.kind,initialUnreadCount:room.initialUnreadCount,initialUnreadCoverage:room.initialUnreadCoverage,...capabilities(room),historyAvailable:Boolean(room.historyEnd)})).sort((a,b)=>(b.lastAt ?? 0)-(a.lastAt ?? 0));},
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
      room.contextVerified=false;room.ownMember=null;room.pendingOwnMember=null;
      const links=[...fieldsOf(response,['li','linkId','openLinkId']),...fieldsOf(response?.chatInfo,['li','linkId','openLinkId'])];
      if(openKinds.has(room.kind) && (!room.linkId || links.some(value=>serverId(value)!==room.linkId)))return false;
      const token=response?.o===undefined?'0':watermark(response.o);if(!token)return false;
      // Pinned chat-on-room.ts: m (<=100 member structs) or mi (ids only).
      const listed=[...(Array.isArray(response.mi)?response.mi.slice(0,500):[]),...(Array.isArray(response.m)?response.m.slice(0,500).map(member=>member?.userId):[])];
      room.memberIds=new Set(listed.map(serverId).filter(Boolean));
      if(Array.isArray(response.m))for(const member of response.m.slice(0,500))learn(room,serverId(member?.userId),member?.nickName ?? member?.nickname);
      // APK CHATONROOM.o -> saved room token -> next CHATONROOM.token. A
      // LOGINLIST/global cursor is deliberately never a token source.
      room.token=token;
      if(openKinds.has(room.kind)){
        // APK25.11.2 iq.o.a: userId Long, lmt/opt Integer, pv Long.
        // context.notiRead controls count display, not this action gate.
        const nested=Object.hasOwn(response,'chatInfo');
        if(nested && !object(response.chatInfo))return true;
        const contexts=nested?[response,response.chatInfo]:[response];
        const mutes=contexts.flatMap(row=>fieldsOf(row,['mt']));
        if(mutes.some(mute=>!int32(mute) || mute<0 || mute!==mutes[0]))return true;
        const mute=mutes.length?mutes[0]:0;
        room.muteUntil=mute;
        const supplied=contexts.flatMap(row=>fieldsOf(row,['olu']));
        // Missing own metadata permits one exact self lookup, never a default role.
        if(!supplied.length){
          if(capabilities(room).canContext)room.pendingOwnMember={version,linkId:room.linkId,attempted:false};
          return true;
        }
        // Every explicit copy must be valid; a nested member cannot hide a root refusal.
        const members=supplied.map(member=>{
          if(!object(member) || serverId(member.userId)!==ownUserId || !int32(member.lmt) || ![1,2,4].includes(member.lmt)
            || member.opt!==undefined && !int32(member.opt))return null;
          return {userId:ownUserId,role:member.lmt,token:member.opt ?? -1,privilege:member.pv};
        });
        if(members.some(member=>!member))return true; // ACK/cache is distinct from permission.
        const member=members[0];
        if(members.some(value=>value.userId!==member.userId || value.role!==member.role || value.token!==member.token))return true;
        room.ownMember=member;
      }
      room.contextVerified=true;return true;
    },
    takeOwnMemberLookup(key,version){
      const room=rooms.get(key),pending=room?.pendingOwnMember;
      if(!pending || pending.attempted || pending.version!==version || room.receiptVersion!==version || pending.linkId!==room.linkId || !capabilities(room).canContext)return false;
      pending.attempted=true;return true;
    },
    ownMemberSnapshot(key,body,version){
      const room=rooms.get(key),pending=room?.pendingOwnMember;
      if(!room || !pending || !pending.attempted)return false;
      room.pendingOwnMember=null;
      if(pending.version!==version || room.receiptVersion!==version || pending.linkId!==room.linkId || !capabilities(room).canContext
        || !object(body) || serverId(body.chatId)!==room.serverRoomId || !matchingRoom(body,room.serverRoomId)
        || !Array.isArray(body.members) || body.members.length!==1)return false;
      const member=body.members[0];
      const links=[...fieldsOf(body,['li','linkId','openLinkId']),...fieldsOf(body.chatInfo,['li','linkId','openLinkId']),...fieldsOf(member,['li','linkId','openLinkId'])];
      if(!object(member) || serverId(member.userId)!==ownUserId || member.type!==1000 || !int32(member.mt) || ![1,2,4].includes(member.mt)
        || member.opt!==undefined && !int32(member.opt) || !matchingRoom(member,room.serverRoomId,{required:false}) || links.some(id=>serverId(id)!==room.linkId))return false;
      // MEMBER.mt is a role; CHATONROOM.mt remains the independent mute gate.
      room.ownMember={userId:ownUserId,role:member.mt,token:member.opt ?? -1};room.contextVerified=true;return true;
    },
    linkSyncSnapshot:()=>new Map([...rooms.values()].map(room=>[room.key,room.receiptVersion])),
    missingOpenLinkIds(limit=16,keys){
      const bounded=Number.isFinite(limit)?Math.min(16,Math.max(0,Math.floor(limit))):0,ids=new Set();
      for(const room of rooms.values())if(ids.size<bounded && (!keys || keys.includes(room.key)) && openKinds.has(room.kind) && !room.left && room.link===null){const id=signedLinkId(room.linkId);if(id)ids.add(id);}
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
    unnamedMembers(key,{visibleOnly=false}={}){
      const room=rooms.get(key);if(!room)return [];
      const inline=inlineAuthors(key),unknown=id=>serverId(id) && id!==ownUserId && !room.names.has(id) && !inline.has(id);
      const visible=[...new Set([...(cache.get(key)?.values() ?? [])].map(item=>item.authorId))].filter(unknown);
      return visible.length || visibleOnly?visible.slice(0,500):[...(room.memberIds ?? [])].filter(unknown).slice(0,500);
    },
    memberNameKnown:(key,id)=>Boolean(rooms.get(key)?.names.has(id) || inlineAuthors(key).has(id)),
    // Pinned member.ts MemberRes {chatId,members}. Only requested IDs are named.
    applyMembers(key,body,requested){
      const room=rooms.get(key);if(!room || !metadataScope(room,body) || serverId(body.chatId)!==room.serverRoomId || !Array.isArray(body.members) || !Array.isArray(requested) || requested.length>500 || body.members.length>requested.length || body.members.some(member=>!metadataScope(room,member)))return false;
      const wanted=new Set(requested.map(serverId).filter(id=>id && id!==ownUserId)),inline=inlineAuthors(key);let changed=false;
      for(const member of body.members){const id=serverId(member.userId);if(!wanted.delete(id) || room.names.has(id) || inline.has(id))continue;learn(room,id,member.nickName ?? member.nickname);changed ||= room.names.has(id);}
      return changed;
    },
    titleMissing:key=>{const room=rooms.get(key);return Boolean(room && !room.left && !room.titleKnown && room.kind!=='MemoChat');},
    unnamedRooms(limit=8){
      return [...rooms.values()].filter(room=>!room.titleKnown && room.kind!=='MemoChat')
        .sort((a,b)=>(b.lastAt ?? 0)-(a.lastAt ?? 0)).slice(0,Math.min(8,Math.max(0,limit))).map(room=>room.key);
    },
    recoverTitle(key,response){
      const room=rooms.get(key),row=response?.chatInfo;
      if(!room || room.titleKnown || room.kind==='MemoChat' || !metadataScope(room,response) || !object(row) || row.left!==undefined && row.left!==false)return false;
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
      for(const log of (logArray(body) ?? (object(body) && serverId(body.logId)?[body]:[])).slice(0,200)){
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
    readUpdate(body,{deferOwnRead=false}={}){
      const key=byServerId.get(serverId(body?.chatId ?? body?.c)),room=rooms.get(key);
      const user=serverId(body?.userId),mark=watermark(body?.watermark);
      if(!room){observeOwnRead('unknown_room');return null;}
      if(!user){observeOwnRead('invalid_user');return null;}
      if(!mark){observeOwnRead('invalid_position');return null;}
      if(!metadataScope(room,body)){observeOwnRead('scope_mismatch');return null;}
      if(user===ownUserId){
        if(room.ownReadMark!==null && BigInt(mark)<=BigInt(room.ownReadMark)){observeOwnRead('stale_own');return null;}
        room.ownReadMark=mark;room.ownReadPending=deferOwnRead;
        observeOwnRead('own_accepted');
        return ownReadUpdate(room,{release:!deferOwnRead});
      }
      if(room.members && !room.members.has(user))room.receiptReady=false;
      const previous=room.watermarks.get(user);if(!previous || BigInt(mark)>BigInt(previous))room.watermarks.set(user,mark);
      observeOwnRead('peer_accepted');
      return {key,...view(key)};
    },
    flushOwnRead(key){const room=rooms.get(key);return room?.ownReadPending?ownReadUpdate(room):null;},
    // Narrow internal IPC proof: log positions only, never room/user IDs and
    // never part of rooms(), message pages or readUpdate's opaque handoff.
    seedBounds:()=>[...rooms.values()].map(room=>({key:room.key,bound:room.baseline})),
    ownReadProof(key){const mark=rooms.get(key)?.ownReadMark;return mark===null || mark===undefined?null:{watermark:mark};},
    arrivalProof(key,arrivals,body){
      const room=rooms.get(key);if(!room || !Array.isArray(arrivals) || arrivals.length>200)return [];
      const wanted=new Set(arrivals.map(item=>item.key)),proof=[];
      for(const log of (logArray(body) ?? []).slice(0,200)){
        const id=serverId(log?.logId ?? log?.msgId ?? log?.id),message=id?opaque('m_',room.serverRoomId+':'+id):'';
        const roomIds=[...fieldsOf(body,['chatId','roomId','chatRoomId','c']),...fieldsOf(log,['chatId','roomId','chatRoomId','c'])];
        if(!wanted.has(message) || !object(log) || roomIds.some(value=>serverId(value)!==room.serverRoomId)
          || fieldsOf(log,['logId','msgId','id']).some(value=>serverId(value)!==id))continue;
        wanted.delete(message);proof.push({key:message,position:id});
      }
      return proof;
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
      const update=this.push({chatId:room.serverRoomId,chatLog:{...original,chatId:room.serverRoomId,logId:id,authorId:ownUserId,type,msg:message,attachment:original?.attachment ?? attachment,sendAt:original?.sendAt ?? body?.sendAt}},{preserveAck:true})[0];
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
    push(body,{preserveAck=false}={}) {
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
        const sender=serverId(log.authorId ?? log.senderId ?? log.userId ?? log.writerId ?? log.sender?.userId);
        const nickname=messageNickname(body,serverRoomId);if(nickname!==undefined)learn(room,sender,nickname);
        if(logId && (!room.historyEnd || BigInt(logId)>BigInt(room.historyEnd)))room.historyEnd=logId;
        const merged=merge(key,[log],false,{preserveAck});if(!merged?.acceptedCount)continue;
        const at=timestamp(log.sendAt ?? log.createdAt);
        if(at && (!room.lastAt || at>=room.lastAt)){room.lastAt=at;room.preview=text(log).slice(0,160);}
        const kind=Number(log.type ?? log.msgType ?? log.t ?? 1);
        const arrivals=updates.get(key)?.arrivals ?? [];
        const baseline=room.baseline===null?room.ownReadMark:room.ownReadMark===null?room.baseline:BigInt(room.baseline)>BigInt(room.ownReadMark)?room.baseline:room.ownReadMark;
        const arrival={key:opaque('m_',room.serverRoomId+':'+logId),incoming:sender?sender!==ownUserId:null,
          afterBaseline:baseline!==null?BigInt(logId)>BigInt(baseline):null,userMessage:[1,2,3,5,18,26,27].includes(kind)};
        if(arrival.incoming===true && arrival.afterBaseline===true && arrival.userMessage && !room.unreadLogs.has(logId)){
          if(room.unreadLogs.size<2000 && unreadEntries<20000){room.unreadLogs.set(logId,arrival.key);unreadEntries++;}
          else room.unreadPartial=true;
        }
        arrivals.push(arrival);
        updates.set(key,{key,messages:merged.messages,latestVisible:merged.latestVisible,arrivals,...(room.unreadPartial?{partial:true}:{})});
      }
      return [...updates.values()];
    },
    stats:()=>({sourceRoomCount,roomCount:rooms.size,truncated:sourceRoomCount>ROOM_LIMIT,duplicates,invalidMessages}),
    clear(){rooms.clear();byServerId.clear();cache.clear();aliases.clear();aliasCount=0;unreadEntries=0;},
  };
}
