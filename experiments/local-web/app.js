'use strict';
const el = id => document.getElementById(id);
let csrf = null, busy = false, expiresAt = null;
let refreshing=false,hasAccount=false,readerGeneration=0,readerRevision=-1,selectedRoom=null,roomsCache=[],lastState=null,actionEpoch=0,readerAttempt=null;
let pendingSelection=null,reconnectRoom=null,readerInstance=null;
let roomsRevision=-1,outboxRevision=-1,outboxEpoch=0,viewPin=null,viewPinEpoch=0,outboxAcknowledging=false,acknowledgingClientId=null;
let localAuthorizationRequired=false,foregroundFocused=document.hasFocus();
// Port-scoped session from the launch ticket exchange; sessionStorage only survives reload in this tab.
let localSession=null;try{const saved=sessionStorage.getItem('webKakaoLocalSession');if(/^[a-f0-9]{64}$/.test(saved ?? ''))localSession=saved;}catch{}
const pageRevisions=new Map(),contextDispatches=new Set(),contextRetryAt=new Map();
let photoDownload=null,photoDownloadEpoch=0;
let restoredOutbox=[];
let renderedRooms=null,renderedMessages=null,renderedMessageRoom=null,renderedQr=null;
let userSelected=false,currentPage=null,ackInFlight=false,pendingSend=null,uncertainPhoto=null,renameTarget=null;
const drafts=new Map(),sendNotes=new Map();
const seenDispatches=new Map();
const pinnedRooms=new Set();
let roomFilter='all',messageQuery='',searchMatches=[],searchIndex=-1,copyStatusTimer=null;
let personalSettings=null,settingsRevision=-1,settingsBusy=false,settingsEpoch=0,notificationBusy=false;
const shownNotifications=new Map();
const replyDrafts=new Map();let imageDraft=null,imagePreparing=false,imageEpoch=0;
let messageMenuTarget=null,messageMenuTimer=null;
let freshness='checking',resumeEpoch=0,localFailureVersion=0,messageRequestId=0;
let refreshPending=false,queuedRefreshTimer=null,pollTimer=null,lastPollAt=Date.now(),wasHidden=document.hidden;
let presenceController=null,presenceRetryTimer=null,presenceEpoch=0,presencePhase='idle',presencePageActive=true;
function requestStamp(){return {generation:readerGeneration,action:actionEpoch,resume:resumeEpoch};}
function stampCurrent(stamp){return stamp.generation===readerGeneration && stamp.action===actionEpoch && stamp.resume===resumeEpoch;}
function staleResult(){const error=new Error('Stale local response');error.name='StaleLocalResult';return error;}
function unavailable(){localFailureVersion++;freshness='unavailable';readerRevision=-1;renderComposer();}
function invalidateViewPin(){viewPin=null;viewPinEpoch++;}
function requireLocalAuthorization(){localAuthorizationRequired=true;csrf=null;stopTabPresence();unavailable();}
function renderLocalAuthorization(){
  el('title').textContent='브라우저 접근 승인 필요';
  el('message').textContent='로컬 도구의 open 명령으로 브라우저를 다시 열어 주세요. 작성 중인 내용은 유지됩니다.';
  el('qr-attempts').hidden=true;
  el('connection-label').textContent='브라우저 접근 승인 필요';el('connection-dot').dataset.state='error';el('session-meter').hidden=true;
  for(const id of ['start','cancel','room-check','reader-connect','reader-disconnect','history-load','rename-room','pin-room','mute-room','room-actions-toggle','read-sync','browser-notifications','persist-preferences','forget-preferences','compose-text','send-message','attach-image','image-send','send-reset','rename-reset'])el(id).disabled=true;
  for(const button of el('rename-form').querySelectorAll('button[type="submit"]'))button.disabled=true;
}
function requestDeadline(path){
  if(path==='/api/reader/photo')return 80000;
  if(['/api/reader/history','/api/reader/connect','/api/reader/send','/api/room-probe'].includes(path))return 30000;
  return 12000;
}
async function localRequest(path,options={},bodyType='json',isCurrent=()=>true){
  const stamp=requestStamp(),controller=new AbortController();let timer;
  const instanceId=lastState?.reader?.instanceId,method=(options.method || 'GET').toUpperCase();
  const headers=new Headers(options.headers);if(localSession)headers.set('X-Local-Session',localSession);
  if(['GET','POST'].includes(method) && /^\/api\/(?:reader|preferences|notifications)(?:[/?]|$)/.test(path) && typeof instanceId==='string' && /^[a-f0-9]{24}$/.test(instanceId))headers.set('X-Reader-Instance',instanceId);
  options={...options,headers};
  // Abort alone does not release a lock when a transport/body reader ignores it.
  // Race covers both response headers and the complete response body.
  const deadline=new Promise((resolve,reject)=>{timer=setTimeout(()=>{const error=new Error('Local request timed out');error.name='TimeoutError';controller.abort();reject(error);},requestDeadline(path));});
  try{const result=await Promise.race([(async()=>{const response=await fetch(path,{cache:'no-store',...options,signal:controller.signal});const data=bodyType==='text'?await response.text():await response.json();return {response,data};})(),deadline]);if(!stampCurrent(stamp) || !isCurrent())throw staleResult();if(result.response.status===403){const error=new Error('Local browser authorization required');error.name='LocalAuthorizationRequired';throw error;}return result;}
  catch(error){if(!stampCurrent(stamp) || !isCurrent())throw staleResult();if(error.name==='LocalAuthorizationRequired')requireLocalAuthorization();else if(error.name!=='StaleLocalResult')unavailable();throw error;}
  finally{clearTimeout(timer);}
}
function tabGraceLabel(){
  const ms=lastState?.tabPresence?.graceMs;
  return Number.isSafeInteger(ms) && ms>0 ? ms%60000===0?`${ms/60000}분`:`${Math.ceil(ms/1000)}초` : '잠시';
}
function renderTabPresenceNote(){
  const note=el('tab-presence-note');
  note.hidden=localAuthorizationRequired || lastState?.sessionPolicy!=='tab-open';
  if(note.hidden)return;
  const text=presencePhase==='active'?`탭 연결 유지 중 · 모든 웹카카오 탭을 닫으면 ${tabGraceLabel()} 후 종료됩니다.`
    :presencePhase==='limited'?'연결을 유지할 수 있는 탭은 최대 4개입니다. 다른 웹카카오 탭을 닫아 주세요.'
    :'탭 연결을 확인하고 있습니다. 연결이 복구되지 않으면 로그인이 종료될 수 있습니다.';
  if(note.textContent!==text)note.textContent=text;
}
function stopTabPresence(){
  presenceEpoch++;clearTimeout(presenceRetryTimer);presenceRetryTimer=null;
  const previous=presenceController;presenceController=null;presencePhase='idle';previous?.abort();
  renderTabPresenceNote();
}
function ensureTabPresence(){
  if(lastState?.sessionPolicy!=='tab-open' || localAuthorizationRequired || !localSession || !csrf || !presencePageActive){
    if(presenceController || presenceRetryTimer!==null)stopTabPresence();
    renderTabPresenceNote();return;
  }
  if(presenceController || presenceRetryTimer!==null)return;
  void connectTabPresence();
}
async function connectTabPresence(){
  const controller=new AbortController(),epoch=++presenceEpoch;
  presenceController=controller;presencePhase='connecting';renderTabPresenceNote();
  if(lastState)renderSessionMeter(lastState);
  // Only the headers have a deadline. An established stream must survive a
  // hidden/background tab without depending on the page's polling timers.
  const handshake=setTimeout(()=>controller.abort(),12000);
  let stream;
  try{
    const response=await fetch('/api/presence',{method:'POST',cache:'no-store',credentials:'omit',redirect:'error',
      headers:{'X-Local-Session':localSession,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:'{}',signal:controller.signal});
    clearTimeout(handshake);
    if(epoch!==presenceEpoch)return;
    if(response.status===403){requireLocalAuthorization();renderLocalAuthorization();return;}
    if(response.status===429){presencePhase='limited';return;}
    if(!response.ok || !/^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body)throw new Error('Local tab stream unavailable');
    presencePhase='active';renderTabPresenceNote();if(lastState)renderSessionMeter(lastState);
    stream=response.body.getReader();
    while(epoch===presenceEpoch){const part=await stream.read();if(part.done)break;}
  }catch{/* Only the local tab stream is retried; no account operation is repeated. */}
  finally{
    clearTimeout(handshake);controller.abort();stream?.releaseLock();
    if(epoch===presenceEpoch){
      presenceController=null;
      if(presencePhase!=='limited')presencePhase='retrying';
      renderTabPresenceNote();if(lastState)renderSessionMeter(lastState);
      if(presencePageActive && !localAuthorizationRequired && lastState?.sessionPolicy==='tab-open'){
        const grace=lastState?.tabPresence?.graceMs;
        const delay=Number.isSafeInteger(grace) && grace>0?Math.min(1000,Math.max(100,Math.floor(grace/4))):1000;
        presenceRetryTimer=setTimeout(()=>{presenceRetryTimer=null;ensureTabPresence();},delay);
      }
    }
  }
}
function scheduleQueuedRefresh(){
  if(!refreshPending || busy || refreshing || queuedRefreshTimer!==null)return;
  queuedRefreshTimer=setTimeout(()=>{queuedRefreshTimer=null;void refresh();},0);
}
function queueRefresh(resume=false){
  const now=Date.now(),gap=now-lastPollAt;lastPollAt=now;
  if(gap>=30000 || gap<0)resume=true;
  if(resume){resumeEpoch++;userSelected=false;freshness='checking';readerRevision=-1;closeMessageMenu();renderComposer();}
  refreshPending=true;scheduleQueuedRefresh();
}
function closeMessageMenu(restoreFocus=false){
  clearTimeout(messageMenuTimer);messageMenuTimer=null;
  const previous=messageMenuTarget;messageMenuTarget=null;el('message-menu').hidden=true;
  if(restoreFocus && previous?.element.isConnected)previous.element.focus({preventScroll:true});
}
function menuMessage(){
  const target=messageMenuTarget;
  return hasAccount && target?.generation===readerGeneration && target.room===selectedRoom && currentPage?.key===selectedRoom
    ?currentPage.messages?.find(message=>message.key===target.message):null;
}
function openMessageMenu(element,room,message,{x,y,keyboard=false}={}){
  if(!hasAccount || room!==selectedRoom)return;
  clearTimeout(messageMenuTimer);
  messageMenuTarget={element,room,message:message.key,generation:readerGeneration};
  const menu=el('message-menu'),reply=el('message-menu-reply');
  reply.hidden=!(message.canReply && roomCan('reply') && lastState?.messaging && lastState?.build>=6);
  reply.disabled=Boolean(pendingSend);menu.hidden=false;
  const bounds=element.getBoundingClientRect(),size=menu.getBoundingClientRect(),pane=document.querySelector('.chat-scroll').getBoundingClientRect();
  if(!Number.isFinite(x) || !Number.isFinite(y)){
    const side=element.classList.contains('mine')?bounds.left-size.width-8:bounds.right+8;
    if(side>=pane.left+6 && side+size.width<=pane.right-6){x=side;y=bounds.top;}
    else{x=bounds.right-size.width;y=bounds.top>=size.height+8?bounds.top-size.height-6:bounds.bottom+6;}
  }
  menu.style.left=Math.max(6,Math.min(x,window.innerWidth-size.width-6))+'px';
  menu.style.top=Math.max(6,Math.min(y,window.innerHeight-size.height-6))+'px';
  if(keyboard)(reply.hidden?el('message-menu-copy'):reply).focus();
}
function scheduleMessageMenuClose(){clearTimeout(messageMenuTimer);messageMenuTimer=setTimeout(()=>closeMessageMenu(),180);}
function closeRoomActions(restoreFocus=false){
  const menu=el('room-actions-menu'),toggle=el('room-actions-toggle');
  const wasOpen=!menu.hidden;menu.hidden=true;toggle.setAttribute('aria-expanded','false');
  if(restoreFocus && wasOpen && !toggle.disabled)toggle.focus({preventScroll:true});
}
function openRoomActions(keyboard=false){
  if(el('room-actions-toggle').disabled)return;
  closeMessageMenu();el('room-actions-menu').hidden=false;el('room-actions-toggle').setAttribute('aria-expanded','true');
  if(keyboard)el('room-actions-menu').querySelector('button:not([disabled])')?.focus();
}
function mobileRoomListShown(){return window.matchMedia('(max-width: 560px)').matches && !document.querySelector('.app-shell').classList.contains('mobile-chat');}
function returnToRoomList(){
  if(selectedRoom)drafts.set(selectedRoom,el('compose-text').value);
  userSelected=false;closeMessageMenu();closeRoomActions();clearImageDraft();
  document.activeElement?.blur();document.querySelector('.app-shell').classList.remove('mobile-chat');renderComposer();
}
function preferenceReady(){return lastState?.preferences===true && personalSettings!==null;}
function roomNow(){return roomsCache.find(room=>room.key===selectedRoom);}
function recoveredOutbox(){return restoredOutbox.filter(entry=>entry.clientId!==pendingSend?.clientId && entry.clientId!==uncertainPhoto?.clientId && entry.clientId!==acknowledgingClientId);}
function outboxWarning(){return recoveredOutbox()[0];}
function revisionFor(reader,field){return reader?.[field] ?? reader?.revision;}
function pageRevisionFor(reader,key){return reader?.pageRevisions?reader.pageRevisions[key] ?? null:reader?.revision;}
function contextGeneration(){
  if(Number.isSafeInteger(currentPage?.contextRevision) && currentPage.contextRevision>=0)return currentPage.contextRevision;
  const room=roomNow();
  if(Number.isSafeInteger(room?.contextRevision) && room.contextRevision>=0)return room.contextRevision;
  // Older servers expose permissions without a receipt generation. Only a
  // kind/capability change grants a new attempt; activation and polls do not.
  return JSON.stringify([room?.kind,...['context','text','reply','photo','read'].map(action=>roomCan(action,room)),room?.canSend===true]);
}
function roomCan(action,room=roomNow()){
  if(!['DirectChat','MultiChat','MemoChat','OpenDirectChat','OpenMultiChat'].includes(room?.kind))return false;
  const field={text:'canText',reply:'canReply',photo:'canPhoto',read:'canRead',context:'canContext'}[action];
  if(!field)return false;
  if(typeof room[field]==='boolean')return room[field];
  // Older normal-room fixtures may only expose canSend. Open rooms always
  // require the explicit, action-specific capability from this server build.
  return ['DirectChat','MultiChat','MemoChat'].includes(room.kind) && room.canSend===true;
}
function nearBottom(){const scroll=document.querySelector('.chat-scroll');return scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop<=48;}
function messageViewCovered(allowImagePreview=false){
  return mobileRoomListShown() || !el('account-panel').hidden
    || Boolean(document.querySelector(allowImagePreview?'dialog[open]:not(#image-send-dialog)':'dialog[open]'));
}
function imageContextReady(room=selectedRoom,generation=readerGeneration){
  return freshness==='fresh' && hasAccount && generation===readerGeneration && room===selectedRoom && roomCan('photo')
    && !messageViewCovered(true) && lastState?.messaging===true && lastState?.build>=6 && lastState?.reader?.phase==='connected';
}
function imageSendReady(image=imageDraft){
  return Boolean(image && imageContextReady(image.room,image.generation) && !busy && !ackInFlight && !pendingSend && !uncertainPhoto
    && !imagePreparing && lastState.reader.operationBusy!==true);
}
async function postLocal(path,body,onConflict){
  if(!csrf)return false;
  const {response,data}=await localRequest(path,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});
  if(response.status===409){onConflict?.(data);readerRevision=-1;queueRefresh();return false;}
  if(!response.ok){unavailable();return false;}
  return true;
}
function renderComposer(){
  const room=roomNow(),ready=freshness==='fresh' && hasAccount && lastState?.reader?.phase==='connected';
  const writable=ready && lastState?.messaging===true && roomCan('text',room);
  el('rename-room').disabled=!hasAccount || !room;
  el('rename-reset').disabled=!hasAccount || !room;
  el('pin-room').disabled=!hasAccount || !room || settingsBusy;
  el('room-actions-toggle').disabled=!hasAccount || !room;
  if(el('room-actions-toggle').disabled)closeRoomActions();
  const pinLabel=pinnedRooms.has(selectedRoom)?'고정 해제':'고정';
  el('pin-room').textContent=pinnedRooms.has(selectedRoom)?'★':'☆';
  el('pin-room').title=pinLabel;el('pin-room').setAttribute('aria-label',pinLabel);
  el('pin-room').setAttribute('aria-pressed',String(pinnedRooms.has(selectedRoom)));
  el('message-search-toggle').disabled=!hasAccount || !room;
  el('mute-room').disabled=!hasAccount || !room || !preferenceReady() || settingsBusy;
  const muteLabel=room?.muted?'알림 켜기':'알림 끄기';
  el('mute-room').textContent=room?.muted?'🔕':'🔔';el('mute-room').title=muteLabel;el('mute-room').setAttribute('aria-label',muteLabel);el('mute-room').setAttribute('aria-pressed',String(room?.muted===true));
  el('browser-notifications').disabled=!hasAccount || !preferenceReady() || settingsBusy || !('Notification' in window) || !('silent' in Notification.prototype);
  el('persist-preferences').disabled=!hasAccount || !preferenceReady() || !personalSettings.storageAvailable || settingsBusy;
  el('forget-preferences').disabled=!hasAccount || !preferenceReady() || settingsBusy;
  for(const filter of ['all','unread','pinned']){el('filter-'+filter).disabled=!hasAccount;el('filter-'+filter).setAttribute('aria-pressed',String(roomFilter===filter));}
  el('read-sync').disabled=lastState?.messaging!==true;
  const recovered=outboxWarning();
  el('compose-text').disabled=!writable || Boolean(pendingSend);
  el('attach-image').disabled=!imageContextReady() || Boolean(pendingSend) || Boolean(uncertainPhoto) || imagePreparing;
  el('image-send').disabled=!imageSendReady();
  const reply=replyDrafts.get(selectedRoom);el('reply-preview').hidden=!reply;
  const replyBlocked=Boolean(reply && !roomCan('reply',room));
  el('reply-author').textContent=reply?reply.sender+'에게 답장':'';el('reply-text').textContent=reply?.text || '';
  el('reply-cancel').disabled=false;
  el('send-message').disabled=!writable || replyBlocked || busy || ackInFlight || Boolean(pendingSend) || lastState?.reader?.operationBusy===true || !el('compose-text').value.trim();
  el('send-status').textContent=pendingSend?.phase==='unknown'?(pendingSend.kind==='photo'?'사진 전송 결과를 확인할 수 없습니다. 휴대폰에서 도착 여부를 확인해 주세요.':'전송 결과를 확인할 수 없습니다. 대화에서 도착 여부를 확인해 주세요.')
    :pendingSend?(pendingSend.kind==='photo'?'사진을 보내고 있습니다…':'메시지를 보내고 있습니다…'):recovered?(recovered.phase==='sending'?'이전 전송의 결과를 확인하고 있습니다. 다시 보내지 마세요.':'이전 '+(recovered.kind==='photo'?'사진':'메시지')+' 전송 결과가 미확인입니다. 휴대폰에서 도착 여부를 확인해 주세요.')+(recoveredOutbox().length>1?` (미확인 ${recoveredOutbox().length}건)`:''):freshness!=='fresh'?(freshness==='checking'?'연결 상태를 확인하고 있습니다…':'로컬 서버 연결을 확인해 주세요. 입력한 내용은 유지됩니다.'):replyBlocked?'이 방에서는 답장을 보낼 수 없습니다. 답장 선택을 취소해 주세요.':uncertainPhoto?'사진 전송 결과는 미확인입니다. 가능한 다른 대화 기능은 계속 사용할 수 있습니다.':sendNotes.get(selectedRoom) || (!ready?'계정을 연결하고 대화방을 선택해 주세요.':!writable?(roomCan('photo',room)?'이 방에서는 사진을 보낼 수 있습니다.':'이 방은 현재 읽기 전용입니다.'):'');
  const needsDeliveryCheck=pendingSend?.phase==='unknown' || Boolean(uncertainPhoto) || recovered?.phase==='unknown';
  el('send-reset').hidden=!needsDeliveryCheck;
  el('send-status').classList.toggle('delivery-warning',needsDeliveryCheck);
  if(needsDeliveryCheck)el('send-status').textContent='전송 결과를 확인할 수 없습니다. 모바일 카카오톡에서 도착 여부를 확인한 뒤 아래 버튼으로 경고를 닫아 주세요. 자동으로 다시 보내지 않습니다.';
  el('send-reset').disabled=outboxAcknowledging;
  el('send-reset').textContent='모바일 확인 후 경고 닫기';
  const count=room?.unreadLocalCount || 0;
  el('new-messages').hidden=!count || nearBottom();el('new-messages').textContent=`새 메시지 ${count>99?'99+':count}개 ↓`;
  if(localAuthorizationRequired)renderLocalAuthorization();
}
function markSendUnknown(pending){
  if(pendingSend!==pending)return;
  if(pending.kind==='photo'){pending.phase='unknown';uncertainPhoto=pending;pendingSend=null;}
  else pending.phase='unknown';
  renderComposer();
}
async function refreshPendingSend(){
  if(!pendingSend || !hasAccount)return;
  const pending=pendingSend,stamp=requestStamp();
  try{
    const recovery=lastState?.outboxRecovery===true;
    const page=await localJson(recovery?'/api/reader/outbox?clientId='+encodeURIComponent(pending.clientId):'/api/reader/messages?room='+encodeURIComponent(pending.room),()=>pendingSend===pending);
    if(pendingSend!==pending || !hasAccount || !stampCurrent(stamp))return;
    if(!recovery && page?.key!==pending.room){unavailable();return;}
    const outcome=recovery?page.entry:page.outbox?.find(entry=>entry.clientId===pending.clientId);
    if(outcome && (outcome.clientId!==pending.clientId || outcome.key!==pending.room)){unavailable();return;}
    if(!outcome || outcome.phase==='sending')return;
    if(outcome.phase==='unknown'){markSendUnknown(pending);return;}
    if(outcome.phase==='accepted'){
      if(pending.kind==='photo'){clearImageDraft();}
      else{drafts.delete(pending.room);if(selectedRoom===pending.room && el('compose-text').value===pending.text)el('compose-text').value='';if(replyDrafts.get(pending.room)?.key===pending.replyTo)replyDrafts.delete(pending.room);}
      sendNotes.set(pending.room,'서버에 전송했습니다.');
    }else{
      const status=outcome.status,rejected=Number.isInteger(status) && status!==0 && status>=-2147483648 && status<=2147483647;
      sendNotes.set(pending.room,outcome.phase==='failed' && outcome.reason==='photo_jpeg_required'?'사진을 JPEG로 준비하지 못해 전송하지 않았습니다. 화면을 새로고침한 뒤 사진을 다시 선택해 주세요.':outcome.phase==='failed' && outcome.reason==='open_member_unverified'?'본인 참여 정보를 확인하지 못해 전송하지 않았습니다. 입력한 내용은 유지됩니다.':rejected?`서버가 전송 요청을 거절했습니다. (코드 ${status})`:'전송하지 못했습니다. 입력한 내용은 유지됩니다.');
    }
    outboxEpoch++;restoredOutbox=restoredOutbox.filter(entry=>entry.clientId!==pending.clientId);
    pendingSend=null;
    renderComposer();
    if(pending.focusInput && selectedRoom===pending.room && document.hasFocus() && !document.hidden
      && ['BODY','send-message','compose-text'].includes(document.activeElement?.id || document.activeElement?.tagName)
      && !messageViewCovered() && !el('compose-text').disabled)el('compose-text').focus({preventScroll:true});
    if(outcome.phase==='accepted' && selectedRoom===pending.room){
      const generation=readerGeneration;
      await refreshMessages(pending.room,generation);
      if(hasAccount && generation===readerGeneration && selectedRoom===pending.room){const pane=document.querySelector('.chat-scroll');pane.scrollTop=pane.scrollHeight;}
    }
  }catch{/* Keep the same request identity; never automatically resend. */}
}
async function refreshOutbox(state){
  if(!hasAccount || state.outboxRecovery!==true){restoredOutbox=[];outboxRevision=-1;return;}
  const revision=revisionFor(state.reader,'outboxRevision'),epoch=outboxEpoch;
  if(outboxRevision===revision)return;
  const data=await localJson('/api/reader/outbox',()=>state===lastState);
  if(state!==lastState || !hasAccount)return;
  if(epoch!==outboxEpoch || revision!==revisionFor(lastState.reader,'outboxRevision')){outboxRevision=-1;queueRefresh();return;}
  // Keep only opaque delivery metadata. No draft or image enters browser storage.
  restoredOutbox=(data.entries || []).filter(entry=>/^[a-f0-9-]{36}$/i.test(entry.clientId) && ['send','photo'].includes(entry.kind) && ['sending','unknown'].includes(entry.phase))
    .map(({key,clientId,kind,phase,status,messageKey})=>({key,clientId,kind,phase,status,messageKey}));
  outboxRevision=revision;renderComposer();
}
async function acknowledgeUnknown(entry){
  if(!entry || entry.phase!=='unknown' || outboxAcknowledging)return false;
  if(lastState?.outboxRecovery!==true)return true;
  const stamp=requestStamp();outboxEpoch++;outboxAcknowledging=true;acknowledgingClientId=entry.clientId;renderComposer();
  try{
    if(!await postLocal('/api/reader/outbox/ack',{clientId:entry.clientId}) || !stampCurrent(stamp))return false;
    outboxEpoch++;restoredOutbox=restoredOutbox.filter(row=>row.clientId!==entry.clientId);outboxRevision=-1;return true;
  }catch{return false;}
  finally{outboxEpoch++;outboxAcknowledging=false;acknowledgingClientId=null;renderComposer();}
}
async function maybeSeen(){
  const room=roomNow(),page=currentPage;
  if(freshness!=='fresh' || ackInFlight || busy || settingsBusy || pendingSend || messageQuery || messageViewCovered() || !userSelected || document.hidden || !document.hasFocus() || !nearBottom()
    || !hasAccount || lastState?.reader?.phase!=='connected' || lastState.reader.operationBusy
    || page?.key!==selectedRoom || !page.latestVisible || !page.seenToken || ['loading','failed','unrecognized'].includes(page.history?.phase))return;
  const lastMessage=page.messages?.at(-1)?.key;
  if(!lastMessage)return;
  // A gap in older history does not undo seeing the latest message. The server
  // acknowledgement, rather than HTTP queue acceptance, determines completion.
  const submitted=page.readSync?.messageKey===lastMessage && ['sending','accepted','unknown','failed'].includes(page.readSync.phase);
  const notify=lastState.messaging===true && roomCan('read',room) && el('read-sync').checked && !submitted;
  if(!notify && !room?.unreadLocalCount)return;
  const key=selectedRoom,stamp=requestStamp(),view=[readerGeneration,key,page.seenToken,lastMessage].join(':');
  const dispatched=seenDispatches.get(view);
  if(dispatched===true || dispatched===false && !notify)return;
  ackInFlight=true;renderComposer();
  try{
    if(await postLocal('/api/reader/seen',{room:key,token:page.seenToken,notify}) && stampCurrent(stamp)){
      // Suppress duplicate dispatch from stale UI events, not receipt success.
      // A later explicit notify can follow local-only clearing for this view;
      // readSync still waits for the worker's actual request result.
      seenDispatches.set(view,notify);while(seenDispatches.size>200)seenDispatches.delete(seenDispatches.keys().next().value);
      if(key===selectedRoom){pageRevisions.delete(key);if(!lastState?.reader?.pageRevisions)readerRevision=-1;}
    }
  }
  catch{/* A failed local acknowledgement must not erase the badge. */}
  finally{ackInFlight=false;renderComposer();}
}
async function advanceRoom(){
  if(freshness!=='fresh' || ackInFlight || busy || pendingSend || document.hidden || !document.hasFocus() || messageViewCovered() || !hasAccount || lastState?.reader?.phase!=='connected' || lastState.reader.operationBusy)return;
  const beforePin=requestStamp(),roomBeforePin=selectedRoom;
  await pinSelectedRoom();
  if(!stampCurrent(beforePin) || roomBeforePin!==selectedRoom || document.hidden || !document.hasFocus() || messageViewCovered() || !userSelected)return;
  const needsEntry=currentPage?.entryPhase!==undefined?currentPage.entryPhase==='idle':currentPage?.receiptPhase==='idle';
  const contextKey=JSON.stringify([readerGeneration,readerAttempt,selectedRoom,contextGeneration()]);
  if(lastState.messaging===true && roomCan('context') && currentPage?.key===selectedRoom && (currentPage.messages?.length || ['OpenDirectChat','OpenMultiChat'].includes(roomNow()?.kind)) && needsEntry && !contextDispatches.has(contextKey) && (contextRetryAt.get(contextKey) ?? 0)<=performance.now() && currentPage.history?.phase!=='loading'){
    const key=selectedRoom,stamp=requestStamp();ackInFlight=true;renderComposer();
    contextRetryAt.delete(contextKey);contextDispatches.add(contextKey);
    try{
      if(await postLocal('/api/reader/context',{room:key},data=>{
        // Only an explicit local cooldown is safe to retry. A protocol refusal,
        // ambiguous response or changed account keeps the original suppression.
        if(stampCurrent(stamp) && data?.error==='context_rate_limited' && Number.isInteger(data.retryAfterMs) && data.retryAfterMs>0 && data.retryAfterMs<=60001){
          contextDispatches.delete(contextKey);contextRetryAt.set(contextKey,performance.now()+data.retryAfterMs);
        }
      }) && stampCurrent(stamp) && key===selectedRoom)pageRevisions.delete(key);
    }finally{ackInFlight=false;renderComposer();}
    return;
  }
  await maybeSeen();
}
async function pinSelectedRoom(){
  if(lastState?.viewPin!==true || freshness!=='fresh' || !hasAccount || lastState.reader?.phase!=='connected' || !roomNow() || document.hidden || !document.hasFocus() || messageViewCovered())return;
  const pin=JSON.stringify([readerGeneration,readerAttempt,selectedRoom]);
  if(viewPin===pin)return;
  const epoch=viewPinEpoch;viewPin=pin;
  try{if(!await postLocal('/api/reader/view',{room:selectedRoom}) && epoch===viewPinEpoch && viewPin===pin)viewPin=null;}
  catch(error){if(epoch===viewPinEpoch && viewPin===pin)viewPin=null;throw error;}
}
async function flushSelection(){
  const pending=pendingSelection;
  if(!pending || pending.inFlight || busy || lastState?.reader?.historyBusy || lastState?.reader?.operationBusy)return;
  if(!hasAccount || pending.generation!==readerGeneration || pending.key!==selectedRoom || lastState?.reader?.phase!=='connected'){pendingSelection=null;return;}
  if(pending.rejectedRevision!==undefined && pending.rejectedRevision===lastState.reader.revision)return;
  // Explicit selection waits for the newest accepted page, which may come from
  // polling instead of its own GET. Reconnect intents still force one catch-up.
  if(pending.awaitingPage){
    if(currentPage?.key!==pending.key || !currentPage.history?.phase)return;
    if(currentPage.history.phase!=='idle'){pendingSelection=null;return;}
  }
  if(roomsCache.find(room=>room.key===pending.key)?.historyAvailable===false){pendingSelection=null;return;}
  const revision=lastState.reader.revision;pending.inFlight=true;
  const accepted=await act('/api/reader/history',{room:pending.key});
  if(pendingSelection!==pending)return;
  // A 409 proves this query was not accepted. Keep only the latest intent and
  // wait for a new worker revision; uncertain POST results are never retried.
  if(accepted===false){pending.inFlight=false;pending.rejectedRevision=revision;return;}
  pendingSelection=null;
}
function showAccount(show){
  el('account-panel').hidden=!show;el('account-backdrop').hidden=!show;el('account-toggle').setAttribute('aria-expanded',String(show));
  if(show){closeMessageMenu();closeRoomActions();}
  renderComposer();
  if(!show)requestAnimationFrame(()=>void maybeSeen());
}
function renderChatHeading(){
  const room=roomsCache.find(row=>row.key===selectedRoom);
  el('chat-title').textContent=room?.title || '대화방을 선택해 주세요';
  el('chat-avatar').textContent=room?.title?.slice(0,1) || 'W';
  const label=lastState?.messaging && (roomCan('text',room) || roomCan('photo',room))?'로컬 대화':'읽기 전용';
  el('chat-subtitle').textContent=room ? (['OpenDirectChat','OpenMultiChat'].includes(room.kind)?'오픈채팅 · '+label:label) : '대화방을 선택해 주세요';
  el('welcome').hidden=Boolean(room);
}
const labels = { idle:'로그인 준비', checking:'등록 허용 확인', generating:'QR 요청 중', waiting:'휴대폰으로 QR 스캔', approval:'휴대폰 승인 대기', authenticated:'인증 응답 확인', blocked:'연결 시도 중단', error:'연결 오류', expired:'인증 시간 만료', cancelled:'로컬 세션 삭제' };
function render(state) {
  lastState=state;
  const nextInstance=typeof state.reader?.instanceId==='string' && /^[a-f0-9]{24}$/.test(state.reader.instanceId)?state.reader.instanceId:null;
  const instanceChanged=nextInstance!==null && readerInstance!==null && nextInstance!==readerInstance;
  const accountEnded=!state.credentialInMemory || instanceChanged;
  if(nextInstance!==null)readerInstance=nextInstance;
  const nextAttempt=Number.isInteger(state.reader?.attempts)?state.reader.attempts:null;
  if(state.credentialInMemory && hasAccount && selectedRoom && selectedRoom===reconnectRoom
    && (nextAttempt!==readerAttempt || ['connecting','disconnected'].includes(state.reader?.phase))){reconnectRoom=selectedRoom;drafts.set(selectedRoom,el('compose-text').value);}
  if(accountEnded || (nextAttempt!==null && nextAttempt!==readerAttempt)){
    closeMessageMenu();
    closeRoomActions();document.querySelector('.app-shell').classList.remove('mobile-chat');
    seenDispatches.clear();contextDispatches.clear();contextRetryAt.clear();pageRevisions.clear();roomsRevision=-1;outboxRevision=-1;invalidateViewPin();
    if(accountEnded)cancelPhotoDownload();
    if(accountEnded){reconnectRoom=null;renameTarget=null;outboxEpoch++;outboxAcknowledging=false;acknowledgingClientId=null;settingsBusy=false;notificationBusy=false;ackInFlight=false;}
    if(hasAccount || nextAttempt!==readerAttempt || instanceChanged)readerGeneration++;
    const staleImageRoom=imageDraft?.room || (imagePreparing?selectedRoom:null);
    if(staleImageRoom && state.credentialInMemory)sendNotes.set(staleImageRoom,'연결이 바뀌어 사진 선택을 취소했습니다. ＋에서 다시 선택해 주세요.');
    clearImageDraft();
    selectedRoom=null;roomsCache=[];readerRevision=-1;
    userSelected=false;currentPage=null;
    resetMessageSearch(true);
    if(accountEnded){drafts.clear();replyDrafts.clear();sendNotes.clear();pinnedRooms.clear();roomFilter='all';pendingSend=null;uncertainPhoto=null;restoredOutbox=[];personalSettings=null;settingsRevision=-1;settingsEpoch++;for(const notice of shownNotifications.values())notice.close();shownNotifications.clear();el('browser-notifications').checked=false;el('persist-preferences').checked=false;el('notification-status').textContent='';el('preferences-status').textContent='';if(el('photo-dialog').open)el('photo-dialog').close();clearTimeout(copyStatusTimer);el('message-action-status').hidden=true;document.title='Web Kakao · 대화';el('compose-text').value='';el('read-sync').checked=false;if(el('rename-dialog').open)el('rename-dialog').close();}
    pendingSelection=null;
    renderedRooms=null;renderedMessages=null;renderedMessageRoom=null;
    el('room-list').replaceChildren();el('message-list').replaceChildren();el('reader-workspace').hidden=true;
    el('room-search').value='';el('history-note').textContent='대화 목록에서 방을 선택해 주세요.';renderChatHeading();
  }
  readerAttempt=nextAttempt;
  hasAccount=Boolean(state.credentialInMemory);
  if (state.csrf) csrf = state.csrf;
  ensureTabPresence();renderTabPresenceNote();
  el('title').textContent = labels[state.phase] || '연결 상태 확인';
  el('message').textContent = state.message;
  if(state.phase==='blocked' && state.stage==='poll' && Number.isInteger(state.apiStatus))el('message').textContent=`지원하지 않는 인증 응답을 받아 중단했습니다. (상태 ${state.apiStatus})`;
  if(!state.canStart && ['cancelled','expired','error'].includes(state.phase)){
    const reason=state.startBlockedReason ?? (state.sessionBlocked?'server_denied':state.attemptLimit!==null && state.attempts>=3?'attempt_limit':null);
    if(reason==='attempt_limit'){
      el('title').textContent='QR 발급 횟수 제한';
      el('message').textContent='이번 서버 실행에서 QR 발급을 3회 시도했습니다. 로컬 세션을 지워도 횟수는 초기화되지 않습니다. 다시 시도하려면 로컬 서버를 종료한 뒤 시작해 주세요.';
    }else if(reason==='server_denied'){
      el('title').textContent='연결 시도 중단';
      el('message').textContent='이전 인증 요청을 서버가 거절해 추가 시도를 중단했습니다. 로컬 세션을 지워도 이 차단은 해제되지 않습니다. 표시된 오류와 휴대폰의 연결 기기를 확인해 주세요.';
    }
  }
  el('mode').textContent = (state.mode === 'live' ? '실제 서버 인증 실험 · 이 노트북에서만 접근' : '모의 화면 · 실제 카카오톡 로그인 아님')+(state.photoTransport==='https-experimental'?' · HTTPS 사진 전송 · JPEG로 변환':'');
  el('start').disabled = busy || !state.canStart || !csrf;
  el('start').textContent = state.phase === 'idle' ? 'QR 로그인 시작' : '새 QR 발급';
  el('cancel').disabled = busy || ['idle','cancelled'].includes(state.phase) || !csrf;
  const attempts=state.attempts,attemptsKnown=Number.isSafeInteger(attempts) && attempts>=0;
  el('qr-attempts').hidden=!attemptsKnown;
  if(attemptsKnown){const note=state.attemptLimit===null?`QR 발급 시도 ${attempts}회 · 수동 발급 횟수 제한 없음`:`QR 발급 시도 ${attempts}/3 · 남은 ${Math.max(0,3-attempts)}회`;if(el('qr-attempts').textContent!==note)el('qr-attempts').textContent=note;}
  el('room-panel').hidden = !state.roomProbe;
  el('room-check').disabled = busy || !state.canProbe || !csrf;
  const probe = state.roomProbe;
  if (state.phase === 'authenticated' && probe?.connectionVerified) el('title').textContent = '대화 서버 연결 성공';
  el('room-check').textContent = probe?.phase === 'completed' ? '연결 검사 완료' : probe?.phase === 'running' ? '연결 검사 중…' : '읽기 전용 연결 확인';
  el('room-result').textContent = !probe ? '인증이 확인됐습니다. 준비되면 연결을 확인해 주세요.'
    : probe.phase === 'running' ? '대화 서버 연결을 확인하고 있습니다.'
    : probe.connectionVerified ? `일회성 개수 검사에 성공했습니다.${probe.roomListPresent ? ` 방 목록 응답 ${probe.roomCount}개.` : ' 방 목록 필드는 미확인입니다.'} 이 검사 연결은 종료했습니다. 대화방을 표시하려면 아래에서 대화방 불러오기를 눌러 주세요.`
    : `연결 검사를 중단했습니다. (단계 ${probe.stage}${probe.status !== null && probe.status !== undefined ? `, 상태 ${probe.status}` : ''})`;
  el('diagnostic').textContent = state.stage ? `단계: ${state.stage}${state.httpStatus ? ` · HTTP ${state.httpStatus}` : ''}${state.apiStatus !== null && state.apiStatus !== undefined ? ` · 상태 ${state.apiStatus}` : ''}` : '';
  if(state.reader?.phase==='blocked')el('diagnostic').textContent=`대화 서버 단계: ${state.reader.stage} · 상태 ${state.reader.status}`;
  const canvas = el('qr'); canvas.hidden = !state.grid;
  const qrSignature=state.grid?JSON.stringify(state.grid):null;
  if (state.grid && qrSignature!==renderedQr) {
    const size = state.grid.length, scale = Math.max(3, Math.floor(300 / (size + 8)));
    canvas.width = canvas.height = (size + 8) * scale;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = '#000';
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (state.grid[row][col]) context.fillRect((col+4)*scale, (row+4)*scale, scale, scale);
  } else if(!state.grid && renderedQr!==null){canvas.width=canvas.height=1;}
  renderedQr=qrSignature;
  el('passcode').hidden = !state.passcode; el('code').textContent = state.passcode || '';
  expiresAt = state.expiresAt || null;
  el('expiry').textContent = expiresAt ? `남은 시간 ${Math.max(0, Math.ceil((expiresAt-Date.now())/1000))}초` : '';
  el('reader-panel').hidden=!hasAccount;
  el('reader-connect').disabled=busy || !state.canOpenReader || !csrf;
  el('reader-connect').textContent=state.reader?.attempts ? '대화 서버 다시 연결' : '대화방 불러오기';
  el('reader-disconnect').disabled=busy || !['connecting','connected'].includes(state.reader?.phase);
  const reader=state.reader;
  el('connection-label').textContent=reader?.phase==='connected'?'대화 서버 연결됨':reader?.phase==='connecting'?'대화 서버 연결 중…':hasAccount?'인증됨 · 대화 연결 대기':labels[state.phase] || '연결 상태 확인';
  el('connection-dot').dataset.state=reader?.phase==='connected'?'connected':reader?.phase==='connecting'?'connecting':['blocked','disconnected'].includes(reader?.phase)?'error':'idle';
  renderSessionMeter(state);
  el('sidebar-empty').hidden=roomsCache.length>0;
  if(hasAccount && reader?.phase==='connected'){
    el('title').textContent='대화 서버 연결됨';el('message').textContent='아래에서 대화방을 선택하고 메시지 조회를 눌러 주세요.';
  }else if(hasAccount && reader?.phase==='disconnected'){
    el('title').textContent='대화 연결 종료';el('message').textContent='인증 정보는 메모리에 남아 있습니다. 서버가 거부한 상태가 아니면 수동으로 다시 연결할 수 있습니다.';
  }
  el('reader-status').textContent=!hasAccount ? (['waiting','approval'].includes(state.phase)?'휴대폰에서 인증을 완료해 주세요.':state.phase==='blocked'?'인증이 완료되지 않았습니다.':'계정 연결이 필요합니다.')
    : reader?.phase==='connected' ? `대화방 ${reader.roomCount}개${reader.truncated?' · 목록 일부만 표시':''}`
    : reader?.phase==='connecting' ? '대화 서버에 연결하고 있습니다.'
    : ['blocked','disconnected'].includes(reader?.phase) ? `연결이 종료됐습니다. 마지막 표시 내용은 새로 동기화되지 않습니다. (${reader.stage}${reader.status!==null ? `, 상태 ${reader.status}`:''})`
    : '인증이 확인됐습니다. 대화방을 불러와 주세요.';
  el('history-load').textContent=reader?.historyBusy?'불러오는 중…':'메시지 불러오기';
  el('history-load').disabled=busy || !selectedRoom || roomsCache.find(room=>room.key===selectedRoom)?.historyAvailable===false || reader?.phase!=='connected' || reader?.historyBusy===true;
  renderComposer();
}
// Finite deadlines are retained only for older servers and bounded fixtures.
const SESSION_LIMIT_MS=60*60*1000;
const clock=ms=>{const s=Math.max(0,Math.floor(ms/1000));return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;};
function renderSessionMeter(state){
  const meter=el('session-meter'),deadline=state.credentialDeadline,reader=state.reader;
  const bar=meter.querySelector('[role="progressbar"]');
  if(state.sessionPolicy==='tab-open'){
    bar.hidden=true;meter.hidden=!hasAccount;
    if(!hasAccount)return;
    meter.dataset.level=presencePhase==='active'?'ok':'warn';
    const parts=[presencePhase==='active'?'탭이 열려 있는 동안 로그인 유지':'탭 연결 확인 중 · 복구되지 않으면 연결이 종료될 수 있습니다'];
    if(reader?.phase==='connected' && Number.isFinite(reader.connectedAt))parts.push(`연결 ${Math.max(0,Math.floor(((state.serverNow ?? Date.now())-reader.connectedAt)/60000))}분째`);
    if(reader?.phase==='connected' && Number.isFinite(reader.lastActivityAt)){const quiet=Math.max(0,Math.round(((state.serverNow ?? Date.now())-reader.lastActivityAt)/1000));parts.push(quiet>90?`응답 지연 ${quiet}초`:`마지막 응답 ${quiet}초 전`);}
    el('session-meter-text').textContent=parts.join(' · ');return;
  }
  bar.hidden=false;
  if(!hasAccount || !Number.isFinite(deadline)){meter.hidden=true;return;}
  const now=Date.now(),skew=Number.isFinite(state.serverNow)?state.serverNow-now:0,left=deadline-(now+skew);
  const parts=[`남은 연결 시간 ${clock(left)}`];
  if(reader?.phase==='connected' && Number.isFinite(reader.connectedAt))parts.push(`연결 ${Math.max(0,Math.floor((now+skew-reader.connectedAt)/60000))}분째`);
  if(reader?.phase==='connected' && Number.isFinite(reader.lastActivityAt)){const quiet=Math.max(0,Math.round((now+skew-reader.lastActivityAt)/1000));parts.push(quiet>90?`응답 지연 ${quiet}초`:`마지막 응답 ${quiet}초 전`);}
  meter.dataset.level=left<=5*60000?'danger':left<=10*60000?'warn':'ok';
  const percent=Math.max(0,Math.min(100,Math.round(left/SESSION_LIMIT_MS*100)));
  el('session-meter-fill').style.width=percent+'%';meter.querySelector('[role="progressbar"]').setAttribute('aria-valuenow',String(percent));
  el('session-meter-text').textContent=parts.join(' · ')+(left<=5*60000?' · 곧 QR 재인증이 필요합니다':'');
  meter.hidden=false;
}
async function localJson(path,isCurrent=()=>true){
  const stamp=requestStamp(),{response,data}=await localRequest(path,{},'json',isCurrent);
  if(!stampCurrent(stamp))throw staleResult();
  if(response.status===409){readerRevision=-1;const error=new Error('Local operation is not ready');error.name='LocalConflict';throw error;}
  if(!response.ok){unavailable();throw new Error('Local request rejected');}
  return data;
}
const time=value=>value ? new Date(value).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}) : '';
function renderRooms(){
  const query=el('room-search').value.trim().toLocaleLowerCase();
  const signature=JSON.stringify([roomsCache,selectedRoom,query,roomFilter,[...pinnedRooms]]);
  if(signature===renderedRooms)return;
  renderedRooms=signature;
  const fragment=document.createDocumentFragment();
  const pinRanks=new Map([...pinnedRooms].map((key,index)=>[key,index]));
  const filtered=roomsCache.filter(room=>[room.title,room.baseTitle].some(title=>title?.toLocaleLowerCase().includes(query))
    && (roomFilter!=='unread' || room.unreadLocalCount>0) && (roomFilter!=='pinned' || pinnedRooms.has(room.key)))
    .sort((a,b)=>Number(pinRanks.has(b.key))-Number(pinRanks.has(a.key)) || (pinRanks.has(a.key)?pinRanks.get(a.key)-pinRanks.get(b.key):(b.lastAt || 0)-(a.lastAt || 0)));
  for(const room of filtered){
    const button=document.createElement('button');button.className='room-item'+(room.key===selectedRoom?' selected':'');button.type='button';button.setAttribute('aria-pressed',String(room.key===selectedRoom));
    const title=document.createElement('strong');title.textContent=room.title;
    if(pinnedRooms.has(room.key)){const pin=document.createElement('span');pin.className='pin-label';pin.textContent='고정';title.append(pin);}
    if(['OpenDirectChat','OpenMultiChat'].includes(room.kind)){const tag=document.createElement('span');tag.className='room-kind';tag.textContent='오픈';title.append(tag);}
    const preview=document.createElement('span');preview.className='room-preview';preview.textContent=room.preview || '미리보기 없음';
    const avatar=document.createElement('span');avatar.className='avatar';avatar.textContent=room.title.slice(0,1);avatar.setAttribute('aria-hidden','true');
    const copy=document.createElement('span');copy.className='room-copy';copy.append(title,preview);
    const when=document.createElement('span');when.className='room-time';when.textContent=room.lastAt?new Date(room.lastAt).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}):'';
    const side=document.createElement('span');side.className='room-side';side.append(when);
    if(room.unreadLocalCount>0){const badge=document.createElement('span');badge.className='unread-badge';badge.textContent=room.unreadLocalCount>99?'99+':String(room.unreadLocalCount)+(room.unreadCoverage==='partial'?'+':'');badge.setAttribute('aria-label',`확인하지 않은 메시지 ${room.unreadLocalCount}개`);side.append(badge);}
    button.append(avatar,copy,side);button.addEventListener('click',()=>selectRoom(room.key));fragment.append(button);
  }
  if(!filtered.length && roomsCache.length){const empty=document.createElement('p');empty.className='sidebar-empty';empty.textContent=query?'검색 결과가 없습니다.':roomFilter==='unread'?'안 읽은 대화방이 없습니다.':'고정한 대화방이 없습니다.';fragment.append(empty);}
  el('room-list').replaceChildren(fragment);
  const total=roomsCache.reduce((count,room)=>count+(room.unreadLocalCount || 0),0);document.title=(total?`(${total>99?'99+':total}) `:'')+'Web Kakao · 대화';
}
async function selectRoom(key){
  closeMessageMenu();closeRoomActions();document.querySelector('.app-shell').classList.add('mobile-chat');userSelected=true;showAccount(false);
  const generation=readerGeneration,stamp=requestStamp();
  if(key===selectedRoom && pendingSelection?.key===key)return;
  const intent={key,generation,awaitingPage:true};pendingSelection=intent;
  if(selectedRoom)drafts.set(selectedRoom,el('compose-text').value);
  if(key!==selectedRoom){if(!pendingSend)clearImageDraft();resetMessageSearch(false);renderedMessages=null;renderedMessageRoom=null;el('message-list').replaceChildren();}
  selectedRoom=key;reconnectRoom=key;userSelected=true;currentPage=null;el('compose-text').value=drafts.get(key) || '';renderRooms();el('history-note').textContent='메시지 표시를 준비하고 있습니다.';
  renderChatHeading();showAccount(false);
  if(lastState)render(lastState);
  await pinSelectedRoom();
  if(!hasAccount || !stampCurrent(stamp) || key!==selectedRoom || pendingSelection!==intent)return;
  await refreshMessages(key,generation);
  if(!hasAccount || !stampCurrent(stamp) || key!==selectedRoom || pendingSelection!==intent)return;
  // Live pushes already update cached rooms. Selecting a loaded room is local;
  // the explicit load button remains available for another server page.
  await flushSelection();
}
function reconcileChildren(parent,nodes){
  const desired=new Set(nodes);
  for(const node of [...parent.childNodes])if(!desired.has(node))node.remove();
  let cursor=parent.firstChild;
  for(const node of nodes){if(node===cursor)cursor=cursor.nextSibling;else parent.insertBefore(node,cursor);}
}
function messageForItem(item,room){return hasAccount && item.dataset.generation===String(readerGeneration) && item.dataset.room===room && currentPage?.key===room && selectedRoom===room?currentPage.messages?.find(message=>message.key===item.dataset.messageKey):null;}
function createMessageItem(room,key){
  const item=document.createElement('article');item.dataset.messageKey=key;item.dataset.room=room;item.dataset.generation=String(readerGeneration);
  item.tabIndex=0;item.setAttribute('aria-haspopup','menu');item.setAttribute('aria-controls','message-menu');
  const open=options=>{const message=messageForItem(item,room);if(message)openMessageMenu(item,room,message,options);};
  item.addEventListener('mouseenter',()=>open());item.addEventListener('mouseleave',scheduleMessageMenuClose);
  item.addEventListener('contextmenu',event=>{if(event.shiftKey)return;event.preventDefault();open({x:event.clientX,y:event.clientY,keyboard:true});});
  item.addEventListener('keydown',event=>{if(event.key==='ContextMenu' || event.key==='F10' && event.shiftKey){event.preventDefault();open({keyboard:true});}});
  return item;
}
function updateMessageItem(item,message){
  item.className='message'+(message.mine?' mine':'');item.dataset.initial=message.sender?.slice(0,1) || '?';
  const author=item.querySelector(':scope > .muted') || document.createElement('div');author.className='muted';
  const authorText=[message.sender,time(message.at)].filter(Boolean).join(' · ');if(author.textContent!==authorText)author.textContent=authorText;
  const text=item.querySelector(':scope > p') || document.createElement('p');
  const body=message.text || '[본문 없음]';if(text.textContent!==body)text.textContent=body;
  const nodes=[author];
  if(message.reply){
    const quote=item.querySelector(':scope > .message-quote') || document.createElement('blockquote');quote.className=message.reply.verified===false?'message-quote unverified':'message-quote';quote.title=message.reply.verified===false?'이 웹에 원본 메시지가 없어 작성자와 내용을 확인할 수 없습니다':'';
    const name=quote.querySelector('strong') || document.createElement('strong'),content=quote.querySelector('span') || document.createElement('span');
    name.textContent=message.reply.sender || '원본 메시지';content.textContent=message.reply.text || '[본문 없음]';reconcileChildren(quote,[name,content]);nodes.push(quote);
  }
  nodes.push(text);
  const photos=(message.photos || []).filter(photo=>typeof photo?.src==='string' && /^\/api\/photo\?room=r_[a-f0-9]{24}&message=m_[a-f0-9]{24}&index=(?:[0-9]|[12][0-9])&cap=[a-f0-9]{64}$/.test(photo.src));
  text.className=photos.length?'sr-only':'';
  if(photos.length){
    const gallery=item.querySelector(':scope > .photo-gallery') || document.createElement('div');gallery.className='photo-gallery';
    const existing=new Map([...gallery.children].map(button=>[button.dataset.photoSrc,button])),buttons=[];
    for(const photo of photos){
      let button=existing.get(photo.src);
      if(!button){
        button=document.createElement('button');button.type='button';button.className='photo-open';button.dataset.photoSrc=photo.src;button.setAttribute('aria-label','사진 크게 보기');
        const image=document.createElement('img');image.loading='lazy';image.decoding='async';image.referrerPolicy='no-referrer';
        const fallback=document.createElement('span');fallback.textContent='사진을 불러올 수 없습니다. 눌러서 다시 시도';fallback.hidden=true;
        image.addEventListener('error',()=>{image.hidden=true;fallback.hidden=false;button.setAttribute('aria-label','사진 다시 불러오기');});
        image.addEventListener('load',()=>{image.hidden=false;fallback.hidden=true;button.setAttribute('aria-label','사진 크게 보기');});
        button.addEventListener('click',()=>{
          const current=messageForItem(item,item.dataset.room),src=button.dataset.photoSrc;
          if(!current?.photos?.some(row=>row.src===src))return;
          if(fallback.hidden){cancelPhotoDownload();el('photo-error').hidden=true;el('photo-full').src=src;el('photo-download').disabled=false;el('photo-dialog').showModal();}
          else{image.hidden=false;fallback.hidden=true;image.src=src;}
        });
        button.append(image,fallback);image.src=photo.src;
      }
      const image=button.querySelector('img');image.alt=message.mine?'보낸 사진':'받은 사진';
      if(photo.width && photo.height){image.width=photo.width;image.height=photo.height;}else{image.removeAttribute('width');image.removeAttribute('height');}
      buttons.push(button);
    }
    reconcileChildren(gallery,buttons);nodes.push(gallery);
  }
  if(message.mine && Number.isSafeInteger(message.unreadCount) && message.unreadCount>0){
    const unread=item.querySelector(':scope > .message-read') || document.createElement('span');unread.className='message-read';unread.textContent=String(message.unreadCount);unread.setAttribute('aria-label',`읽지 않은 사람 ${message.unreadCount}명`);nodes.push(unread);
  }
  reconcileChildren(item,nodes);
}
async function refreshMessages(key,generation){
  const stamp=requestStamp(),request=++messageRequestId,revision=pageRevisionFor(lastState?.reader,key);
  try{
    const page=await localJson('/api/reader/messages?room='+encodeURIComponent(key),()=>hasAccount && generation===readerGeneration && request===messageRequestId && key===selectedRoom);
    if(!hasAccount || generation!==readerGeneration || !stampCurrent(stamp) || request!==messageRequestId || key!==selectedRoom)return;
    if(page?.key!==key){unavailable();return;}
    currentPage=page;pageRevisions.set(key,revision);
    const history=page.history || {};
    el('history-note').textContent=history.phase==='loaded' ? (history.gap?'이전 대화 일부를 불러오지 못했습니다.':'')
      : history.phase==='unavailable' ? '서버가 조회 범위 번호를 제공하지 않아 이 방의 이력을 요청하지 않았습니다.'
      : history.phase==='loading' ? '서버에서 메시지를 조회하고 있습니다.'
      : history.phase==='unrecognized' ? '메시지를 불러오지 못했습니다.'
      : history.phase==='failed' ? '메시지를 불러오지 못했습니다. 연결 상태를 확인해 주세요.' : '';
    el('history-note').hidden=!el('history-note').textContent;
    const emptyText=history.phase==='loaded'?'서버가 반환한 이번 묶음에는 표시할 메시지가 없습니다.':history.phase==='unrecognized'?'메시지 응답을 아직 해석하지 못했습니다. 대화가 없다는 뜻은 아닙니다.':history.phase==='failed'?'메시지 조회가 중단됐습니다.':history.phase==='loading'?'메시지를 조회하고 있습니다.':'메시지 조회를 눌러 주세요.';
    const signature=JSON.stringify([page.messages || [],page.messages?.length?'':emptyText]);
    if(renderedMessageRoom===key && renderedMessages===signature)return page;
    const scroll=document.querySelector('.chat-scroll'),top=scroll.scrollTop;
    const atBottom=scroll.scrollHeight-scroll.clientHeight-top<=48;
    const changedRoom=renderedMessageRoom!==key;
    const list=el('message-list'),nodes=[];
    const existing=new Map([...list.querySelectorAll(':scope > article[data-message-key]')].map(node=>[node.dataset.messageKey,node]));
    const days=new Map([...list.querySelectorAll(':scope > .day-label')].map(node=>[node.dataset.day,node]));
    let previousDay=null;
    for(const message of page.messages || []){
      if(message.at){const day=new Date(message.at).toLocaleDateString('ko-KR');if(day!==previousDay){const dayKey=day+':'+nodes.length,label=days.get(dayKey) || document.createElement('div');label.className='day-label';label.dataset.day=dayKey;label.textContent=day;nodes.push(label);previousDay=day;}}
      const item=existing.get(message.key) || createMessageItem(key,message.key);
      updateMessageItem(item,message);nodes.push(item);
    }
    if(!page.messages?.length){const empty=document.createElement('p');empty.className='muted';empty.textContent=emptyText;nodes.push(empty);}
    closeMessageMenu();reconcileChildren(list,nodes);
    renderedMessageRoom=key;renderedMessages=signature;
    if(page.messages?.length)scroll.scrollTop=messageQuery?(changedRoom?0:top):changedRoom || atBottom?scroll.scrollHeight:top;
    updateMessageSearch();
    return page;
  }catch(error){if(error.name!=='StaleLocalResult' && key===selectedRoom && stampCurrent(stamp) && request===messageRequestId){el('history-note').hidden=false;el('history-note').textContent='메시지를 표시할 수 없습니다. 연결 상태를 확인해 주세요.';}}
}
function resetMessageSearch(close){
  messageQuery='';searchMatches=[];searchIndex=-1;el('message-search').value='';
  if(close){el('message-search-bar').hidden=true;el('message-search-toggle').setAttribute('aria-expanded','false');}
  updateMessageSearch();
}
function updateMessageSearch(move=false){
  const previousKey=searchMatches[searchIndex]?.dataset.messageKey;
  searchMatches=[];
  const pattern=messageQuery?new RegExp(messageQuery.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'giu'):null;
  for(const article of el('message-list').querySelectorAll('article')){
    article.classList.remove('search-current');
    const paragraph=article.querySelector('p'),text=paragraph.textContent;
    if(!pattern){if(paragraph.querySelector('mark'))paragraph.textContent=text;continue;}
    pattern.lastIndex=0;const matches=[...text.matchAll(pattern)];
    if(!matches.length){if(paragraph.querySelector('mark'))paragraph.textContent=text;continue;}
    const fragment=document.createDocumentFragment();let offset=0;
    for(const match of matches.slice(0,200)){fragment.append(document.createTextNode(text.slice(offset,match.index)));const mark=document.createElement('mark');mark.textContent=match[0];fragment.append(mark);offset=match.index+match[0].length;}
    fragment.append(document.createTextNode(text.slice(offset)));paragraph.replaceChildren(fragment);searchMatches.push(article);
  }
  searchIndex=searchMatches.findIndex(article=>article.dataset.messageKey===previousKey);
  if(searchMatches.length && searchIndex<0)searchIndex=0;
  el('message-search-count').textContent=!messageQuery?'':searchMatches.length?`${searchIndex+1} / ${searchMatches.length}`:'일치하는 메시지가 없습니다';
  el('message-search-prev').disabled=el('message-search-next').disabled=!searchMatches.length;
  if(searchIndex>=0){searchMatches[searchIndex].classList.add('search-current');if(move)searchMatches[searchIndex].scrollIntoView({block:'center'});}
}
function moveMessageSearch(direction){
  if(!searchMatches.length)return;
  searchMatches[searchIndex]?.classList.remove('search-current');searchIndex=(searchIndex+direction+searchMatches.length)%searchMatches.length;
  searchMatches[searchIndex].classList.add('search-current');searchMatches[searchIndex].scrollIntoView({block:'center'});
  el('message-search-count').textContent=`${searchIndex+1} / ${searchMatches.length}`;
}
async function copyMessage(text){
  const generation=readerGeneration;
  let note;
  try{if(!navigator.clipboard?.writeText)throw new Error();await navigator.clipboard.writeText(text);note='복사했습니다.';}
  catch{note='복사하지 못했습니다. 메시지를 선택해 복사해 주세요.';}
  if(!hasAccount || generation!==readerGeneration)return;
  clearTimeout(copyStatusTimer);el('message-action-status').textContent=note;el('message-action-status').hidden=false;
  copyStatusTimer=setTimeout(()=>{el('message-action-status').hidden=true;},3000);
}
async function refreshSettings(state){
  const revision=revisionFor(state.reader,'settingsRevision');
  if(!hasAccount || !state.preferences || settingsBusy || settingsRevision===revision)return;
  const generation=readerGeneration,epoch=settingsEpoch;
  try{
    const data=await localJson('/api/preferences',()=>hasAccount && epoch===settingsEpoch && state===lastState);if(!hasAccount || generation!==readerGeneration || epoch!==settingsEpoch || state!==lastState)return;
    personalSettings=data.settings;settingsRevision=revision;
    if(!personalSettings)return;
    roomFilter=personalSettings.roomFilter;el('read-sync').checked=personalSettings.readSync;
    el('browser-notifications').checked=personalSettings.notifications;el('persist-preferences').checked=personalSettings.persist;
    el('preferences-status').textContent=personalSettings.storageError?'개인 설정을 읽거나 저장하지 못했습니다.':personalSettings.persist?'이 노트북에 개인 설정을 저장합니다.':'현재 계정 연결 동안 설정을 유지합니다.';
    el('notification-status').textContent=!('Notification' in window) || !('silent' in Notification.prototype)?'이 브라우저는 무음 알림을 지원하지 않습니다.':personalSettings.notifications && Notification.permission!=='granted'?'브라우저 사이트 설정에서 알림을 허용해 주세요.':personalSettings.notifications?'웹이 열려 있는 동안 본문 없이 무음으로 알립니다.':'';
    if(!personalSettings.notifications){for(const notice of shownNotifications.values())notice.close();shownNotifications.clear();}
  }catch(error){if(error.name!=='StaleLocalResult' && hasAccount && generation===readerGeneration && epoch===settingsEpoch)el('preferences-status').textContent='개인 설정을 불러오지 못했습니다.';}
}
async function changeSettings(path,body){
  if(!preferenceReady() || settingsBusy)return false;
  const generation=readerGeneration,stamp=requestStamp();settingsBusy=true;settingsEpoch++;renderComposer();
  let success=false;
  try{success=await postLocal(path,body);if(!success)el('preferences-status').textContent='설정을 저장하지 못했습니다. 다시 확인해 주세요.';}
  catch{if(stampCurrent(stamp))el('preferences-status').textContent='설정을 저장하지 못했습니다. 연결 상태를 확인해 주세요.';}
  finally{settingsBusy=false;if(generation===readerGeneration){settingsRevision=-1;readerRevision=-1;await refresh();renderComposer();}}
  return success;
}
async function saveSettings(patch){return changeSettings('/api/preferences',patch);}
async function saveRoomSettings(patch){if(!selectedRoom)return false;return changeSettings('/api/preferences/room',{room:selectedRoom,...patch});}
async function receiveNotifications(){
  if(notificationBusy || settingsBusy || !hasAccount || !personalSettings?.notifications || !('Notification' in window) || Notification.permission!=='granted' || !('silent' in Notification.prototype))return;
  const generation=readerGeneration,stamp=requestStamp();notificationBusy=true;
  try{
    const {response,data}=await localRequest('/api/notifications/claim',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:'{}'});
    if(response.status===409){readerRevision=-1;return;}
    if(!response.ok){unavailable();return;}if(!hasAccount || !stampCurrent(stamp) || !personalSettings?.notifications)return;
    for(const item of (data.notices || []).slice(0,5)){
      const room=roomsCache.find(row=>row.key===item.key);if(!room || room.muted || !/^[a-f0-9]{32}$/.test(item.id))continue;
      if(room.key===selectedRoom && userSelected && !messageViewCovered() && !document.hidden && document.hasFocus() && nearBottom() && !messageQuery && currentPage?.latestVisible)continue;
      const notice=new Notification(room.title,{body:'새 메시지가 도착했습니다.',tag:'web-kakao-'+item.key,silent:true});
      shownNotifications.get(item.key)?.close();shownNotifications.set(item.key,notice);
      while(shownNotifications.size>8){const [key,old]=shownNotifications.entries().next().value;old.close();shownNotifications.delete(key);}
      notice.onclick=()=>{notice.close();if(hasAccount && generation===readerGeneration){window.focus();roomFilter='all';renderRooms();void selectRoom(item.key);}};
    }
  }catch{if(stampCurrent(stamp))el('notification-status').textContent='알림을 표시하지 못했습니다. 브라우저 권한을 확인해 주세요.';}
  finally{notificationBusy=false;}
}
async function refreshReader(state){
  if(!hasAccount || !state.reader)return;
  const generation=readerGeneration,epoch=actionEpoch;
  const force=readerRevision===-1,revision=revisionFor(state.reader,'roomsRevision');
  const roomsChanged=force || roomsRevision!==revision;
  if(roomsChanged){
    const data=await localJson('/api/reader/rooms');
    if(!hasAccount || generation!==readerGeneration || epoch!==actionEpoch || state!==lastState)return;
    roomsCache=data.rooms || [];roomsRevision=revision;
  }
  readerRevision=state.reader.revision;
  if(preferenceReady()){pinnedRooms.clear();for(const row of [...roomsCache].filter(row=>Number.isInteger(row.pinOrder)).sort((a,b)=>a.pinOrder-b.pinOrder))pinnedRooms.add(row.key);}
  if(state.reader.phase==='connected' && reconnectRoom && !roomsCache.some(room=>room.key===reconnectRoom))reconnectRoom=null;
  if(!roomsCache.some(room=>room.key===selectedRoom)){
    const restore=state.reader.phase==='connected' && roomsCache.some(room=>room.key===reconnectRoom)?reconnectRoom:null;
    selectedRoom=restore || roomsCache[0]?.key || null;userSelected=false;currentPage=null;el('compose-text').value=drafts.get(selectedRoom) || '';renderedMessages=null;renderedMessageRoom=null;el('message-list').replaceChildren();el('history-note').textContent='메시지 표시를 준비하고 있습니다.';
    // Keep the explicitly opened room as the target across repeated reconnects.
    // Restoring its history never grants userSelected/read eligibility.
    if(restore)pendingSelection={key:restore,generation};
  }
  el('reader-workspace').hidden=!roomsCache.length;renderRooms();
  renderChatHeading();
  if(selectedRoom && (force || !currentPage || !pageRevisions.has(selectedRoom) || pageRevisions.get(selectedRoom)!==pageRevisionFor(state.reader,selectedRoom)))await refreshMessages(selectedRoom,generation);
  if(lastState)render(lastState);
}
async function refresh() {
  if (busy || refreshing){refreshPending=true;return;}
  clearTimeout(queuedRefreshTimer);queuedRefreshTimer=null;refreshPending=false;
  refreshing=true;const epoch=actionEpoch,resume=resumeEpoch,failures=localFailureVersion;
  if(freshness!=='fresh'){freshness='checking';readerRevision=-1;settingsRevision=-1;renderComposer();}
  try {
    const {response,data:state}=await localRequest('/api/status');
    if(epoch!==actionEpoch || resume!==resumeEpoch)return;
    if(!response.ok)throw new Error();
    localAuthorizationRequired=false;
    for(const button of el('rename-form').querySelectorAll('button[type="submit"]'))button.disabled=false;
    render(state);
    await refreshSettings(state);
    if(epoch!==actionEpoch || resume!==resumeEpoch)return;
    await refreshReader(state);
    if(epoch!==actionEpoch || resume!==resumeEpoch)return;
    await refreshPendingSend();
    if(epoch!==actionEpoch || resume!==resumeEpoch)return;
    await refreshOutbox(state);
    if(epoch!==actionEpoch || resume!==resumeEpoch)return;
    await flushSelection();
    if(epoch!==actionEpoch || resume!==resumeEpoch)return;
    await receiveNotifications();
    if(epoch!==actionEpoch || resume!==resumeEpoch || failures!==localFailureVersion)return;
    freshness='fresh';renderComposer();await advanceRoom();
  }
  catch(error){if(epoch===actionEpoch && resume===resumeEpoch && error.name!=='StaleLocalResult'){
    if(error.name==='LocalAuthorizationRequired'){renderLocalAuthorization();}
    else if(error.name==='LocalConflict'){readerRevision=-1;settingsRevision=-1;}
    else{unavailable();el('message').textContent='로컬 서버에 연결할 수 없습니다. 실행 상태를 확인해 주세요.';el('start').disabled=el('cancel').disabled=el('reader-connect').disabled=el('history-load').disabled=true;}
  }}
  finally{refreshing=false;renderComposer();scheduleQueuedRefresh();}
}
async function act(path,body={}) {
  if (busy || !csrf) return null;
  let accepted=null;
  busy=true;actionEpoch++;const epoch=actionEpoch,resume=resumeEpoch;
  el('start').disabled=el('cancel').disabled=el('history-load').disabled=true;
  try {
    const {response,data:state}=await localRequest(path,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});
    if(!response.ok && response.status!==409){unavailable();throw new Error();}
    accepted=response.status===409?false:true;
    if(epoch===actionEpoch && resume===resumeEpoch && state.phase)render(state);
  }catch{/* A timed-out POST may still be running on the server. Do not retry it. */}
  finally{busy=false;readerRevision=-1;await refresh();scheduleQueuedRefresh();}
  return accepted;
}
el('start').addEventListener('click', () => act('/api/start'));
el('cancel').addEventListener('click', () => act('/api/cancel'));
el('room-check').addEventListener('click', () => act('/api/room-probe'));
el('reader-connect').addEventListener('click',()=>act('/api/reader/connect'));
el('reader-disconnect').addEventListener('click',()=>act('/api/reader/disconnect'));
el('history-load').addEventListener('click',()=>{if(selectedRoom)act('/api/reader/history',{room:selectedRoom});});
el('room-search').addEventListener('input',renderRooms);
for(const filter of ['all','unread','pinned'])el('filter-'+filter).addEventListener('click',()=>{if(preferenceReady())void saveSettings({roomFilter:filter});else{roomFilter=filter;renderRooms();renderComposer();}});
el('pin-room').addEventListener('click',()=>{if(!hasAccount || !roomNow())return;if(preferenceReady()){const order=pinnedRooms.has(selectedRoom)?null:Math.max(-1,...roomsCache.map(row=>row.pinOrder ?? -1))+1;void saveRoomSettings({pinOrder:order});}else{if(pinnedRooms.has(selectedRoom))pinnedRooms.delete(selectedRoom);else pinnedRooms.add(selectedRoom);renderRooms();renderComposer();}});
el('message-search-toggle').addEventListener('click',()=>{const open=el('message-search-bar').hidden;if(open){el('message-search-bar').hidden=false;el('message-search-toggle').setAttribute('aria-expanded','true');el('message-search').focus();}else resetMessageSearch(true);});
el('message-search').addEventListener('input',()=>{messageQuery=el('message-search').value.trim();searchMatches=[];searchIndex=-1;updateMessageSearch(true);});
el('message-search').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();moveMessageSearch(event.shiftKey?-1:1);}else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();resetMessageSearch(true);el('message-search-toggle').focus();}});
el('message-search-prev').addEventListener('click',()=>moveMessageSearch(-1));
el('message-search-next').addEventListener('click',()=>moveMessageSearch(1));
el('message-search-close').addEventListener('click',()=>{resetMessageSearch(true);el('message-search-toggle').focus();});
el('account-toggle').addEventListener('click',()=>showAccount(el('account-panel').hidden));
el('account-close').addEventListener('click',()=>{showAccount(false);el('account-toggle').focus();});
el('account-backdrop').addEventListener('click',()=>{showAccount(false);el('account-toggle').focus();});
el('room-list-back').addEventListener('click',returnToRoomList);
el('room-actions-toggle').addEventListener('click',event=>{if(el('room-actions-menu').hidden)openRoomActions(event.detail===0);else closeRoomActions(true);});
el('room-actions-toggle').addEventListener('keydown',event=>{if(event.key==='ArrowDown' || event.key==='ArrowUp'){event.preventDefault();openRoomActions(true);}});
el('room-actions-menu').addEventListener('keydown',event=>{
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeRoomActions(true);}
  else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
    event.preventDefault();const items=[...el('room-actions-menu').querySelectorAll('button')].filter(item=>!item.hidden && !item.disabled);
    const index=items.indexOf(document.activeElement),next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();
  }else if(event.key==='Tab')closeRoomActions();
});
el('compose-text').addEventListener('input',()=>{if(selectedRoom)drafts.set(selectedRoom,el('compose-text').value);renderComposer();});
el('compose-text').addEventListener('keydown',event=>{
  if(event.key==='Enter' && !event.shiftKey && !event.isComposing && event.keyCode!==229){event.preventDefault();el('compose-form').requestSubmit();}
});
el('compose-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const room=roomNow(),text=el('compose-text').value;
  if(freshness!=='fresh' || busy || ackInFlight || pendingSend || !hasAccount || !lastState?.messaging || lastState.reader?.phase!=='connected' || lastState.reader?.operationBusy || !roomCan('text',room) || !text.trim())return;
  if([...text].length>4000){sendNotes.set(selectedRoom,'메시지는 4,000자까지 보낼 수 있습니다.');renderComposer();return;}
  const replyTo=replyDrafts.get(selectedRoom)?.key;
  if(replyTo && !roomCan('reply',room))return;
  if(replyTo && !currentPage?.messages?.some(message=>message.key===replyTo && message.canReply)){sendNotes.set(selectedRoom,'원본 메시지를 다시 불러오거나 답장을 취소해 주세요.');renderComposer();return;}
  sendNotes.delete(selectedRoom);
  const pending={room:selectedRoom,text,replyTo,kind:'text',clientId:crypto.randomUUID(),phase:'sending',focusInput:['compose-text','send-message'].includes(document.activeElement?.id)};pendingSend=pending;renderComposer();
  try{
    const accepted=await postLocal('/api/reader/send',{room:pending.room,text:pending.text,clientId:pending.clientId,...(pending.replyTo?{replyTo:pending.replyTo}:{})});
    if(pendingSend!==pending || !hasAccount)return;
    if(!accepted){pendingSend=null;sendNotes.set(pending.room,'지금은 전송할 수 없습니다. 연결 상태를 확인해 주세요.');}
    readerRevision=-1;await refresh();
  }catch{markSendUnknown(pending);}
  finally{renderComposer();}
});
el('send-reset').addEventListener('click',async()=>{
  if(outboxAcknowledging)return;
  if(pendingSend?.phase==='unknown'){
    const pending=pendingSend;
    if(window.confirm('모바일 카카오톡에서 도착 여부를 확인하셨나요? 이 버튼은 경고만 닫으며 메시지를 다시 보내지 않습니다. 직접 다시 보내면 같은 내용이 중복될 수 있습니다.') && await acknowledgeUnknown(pending) && pendingSend===pending){pendingSend=null;renderComposer();}
  }else if(uncertainPhoto){
    const pending=uncertainPhoto,stamp=requestStamp();
    if(window.confirm('휴대폰에서 사진의 도착 여부를 확인하셨나요? 이 버튼은 사진을 다시 보내지 않습니다.')){
      uncertainPhoto=null;clearImageDraft();
      if(!await acknowledgeUnknown(pending) && hasAccount && stampCurrent(stamp) && !uncertainPhoto)uncertainPhoto=pending;
      renderComposer();
    }
  }else{
    const pending=outboxWarning();
    if(pending?.phase==='unknown' && window.confirm('휴대폰에서 이전 전송의 도착 여부를 확인하셨나요? 이 버튼은 다시 보내지 않습니다.') && await acknowledgeUnknown(pending)){renderComposer();queueRefresh();}
  }
});
el('reply-cancel').addEventListener('click',()=>{replyDrafts.delete(selectedRoom);renderComposer();if(!el('compose-text').disabled)el('compose-text').focus({preventScroll:true});});
el('message-menu').addEventListener('mouseenter',()=>clearTimeout(messageMenuTimer));
el('message-menu').addEventListener('mouseleave',scheduleMessageMenuClose);
el('message-menu-reply').addEventListener('click',()=>{
  const message=menuMessage();
  if(!message || pendingSend || !message.canReply || !roomCan('reply') || !lastState?.messaging)return;
  replyDrafts.set(selectedRoom,{key:message.key,sender:message.sender,text:message.text});closeMessageMenu();renderComposer();el('compose-text').focus({preventScroll:true});
});
el('message-menu-copy').addEventListener('click',()=>{const message=menuMessage();closeMessageMenu();if(message)void copyMessage(message.text || '[본문 없음]');});
el('message-menu').addEventListener('keydown',event=>{
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMessageMenu(true);}
  else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
    event.preventDefault();const items=[...el('message-menu').querySelectorAll('button')].filter(item=>!item.hidden && !item.disabled);
    const current=items.indexOf(document.activeElement),next=event.key==='Home'?0:event.key==='End'?items.length-1:(current+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();
  }else if(event.key==='Tab')closeMessageMenu();
});
document.addEventListener('pointerdown',event=>{if(messageMenuTarget && !el('message-menu').contains(event.target))closeMessageMenu();if(!el('room-actions-menu').hidden && !el('room-actions-menu').contains(event.target) && !el('room-actions-toggle').contains(event.target))closeRoomActions();});
window.addEventListener('resize',()=>{closeMessageMenu();closeRoomActions();renderComposer();});
function clearImageDraft(){imageEpoch++;if(imageDraft?.url)URL.revokeObjectURL(imageDraft.url);imageDraft=null;imagePreparing=false;el('image-preview').removeAttribute('src');el('image-file').value='';if(el('image-send-dialog').open)el('image-send-dialog').close();}
async function selectedImageType(file){
  const bytes=new Uint8Array(await file.slice(0,12).arrayBuffer());
  if([137,80,78,71,13,10,26,10].every((value,index)=>bytes[index]===value))return 'image/png';
  if(bytes[0]===255 && bytes[1]===216 && bytes[2]===255)return 'image/jpeg';
  if(bytes[0]===82 && bytes[1]===73 && bytes[2]===70 && bytes[3]===70 && bytes[8]===87 && bytes[9]===69 && bytes[10]===66 && bytes[11]===80)return 'image/webp';
  return null;
}
async function decodeSelectedImage(file){
  try{return await createImageBitmap(file);}catch{
    // Some browsers cannot use the bitmap decoder for a locally selected image.
    // This fallback still uses only a temporary local blob, never a remote URL.
    const url=URL.createObjectURL(file),image=new Image();let timer;
    try{
      await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;timer=setTimeout(()=>reject(new Error()),10000);image.src=url;});
      return {width:image.naturalWidth,height:image.naturalHeight,image,close(){image.removeAttribute('src');URL.revokeObjectURL(url);}};
    }catch(error){image.removeAttribute('src');URL.revokeObjectURL(url);throw error;}
    finally{clearTimeout(timer);image.onload=null;image.onerror=null;}
  }
}
async function prepareImage(file){
  if(!file || imagePreparing || pendingSend || uncertainPhoto || !imageContextReady())return;
  clearImageDraft();const epoch=imageEpoch,key=selectedRoom,generation=readerGeneration,jpegTransport=lastState?.photoTransport==='https-experimental';imagePreparing=true;renderComposer();let bitmap,step='input-size';
  try{
    if(file.size>20*1024*1024 || !file.size)throw new Error();
    step='format';const inputMime=await selectedImageType(file);if(!inputMime)throw new Error();
    if(epoch!==imageEpoch || !imageContextReady(key,generation))return;
    step='decode';bitmap=await decodeSelectedImage(new Blob([file],{type:inputMime}));if(epoch!==imageEpoch || !imageContextReady(key,generation))return;
    step='pixels';if(bitmap.width*bitmap.height>40000000)throw new Error();
    step='canvas';
    const mime=jpegTransport || inputMime==='image/jpeg'?'image/jpeg':'image/png';
    const scale=Math.min(1,4096/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    const context=canvas.getContext('2d');if(mime==='image/jpeg'){context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);}context.drawImage(bitmap.image || bitmap,0,0,canvas.width,canvas.height);
    step='encode';
    let blob;const qualities=jpegTransport?[.9,.8,.7]:[.9];
    for(const quality of qualities){
      blob=await new Promise(resolve=>canvas.toBlob(resolve,mime,quality));
      if(epoch!==imageEpoch || !imageContextReady(key,generation))return;
      if(!blob || blob.type!==mime)throw new Error();
      if(blob.size<=10*1024*1024)break;
    }
    step='output-size';if(blob.size>10*1024*1024)throw new Error();
    step='read';
    const image=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(blob);});
    if(epoch!==imageEpoch || !imageContextReady(key,generation))return;
    step='preview';
    imageDraft={room:key,generation,image,mime,bytes:blob.size,url:URL.createObjectURL(blob)};el('image-preview').src=imageDraft.url;el('image-recipient').textContent=(roomNow()?.title || '선택한 대화방')+'에 보냅니다.';
    el('image-format-note').textContent=jpegTransport?'JPEG로 변환해 보냅니다. 투명한 부분은 흰색 배경으로 바뀌며, 큰 사진은 화질을 조정합니다.':'';el('image-format-note').hidden=!jpegTransport;el('image-send-dialog').showModal();
  }catch{if(epoch===imageEpoch && hasAccount){
    const messages={format:'파일 형식을 확인하지 못했습니다. JPEG·PNG·WebP 파일을 선택해 주세요.',
      'input-size':'원본 사진은 0바이트보다 크고 20MiB 이하여야 합니다.',decode:'브라우저가 사진을 해독하지 못했습니다.',
      pixels:'사진은 4천만 픽셀 이하여야 합니다.',canvas:'브라우저가 사진을 그리지 못했습니다.',
      encode:'브라우저가 사진을 변환하지 못했습니다.','output-size':'변환한 사진이 10MiB를 넘습니다. 해상도나 용량을 줄여 주세요.',
      read:'변환한 사진을 읽지 못했습니다.',preview:'사진 미리보기를 열지 못했습니다.'};
    // Do not leave a sendable draft behind if opening its preview failed.
    if(imageDraft){clearImageDraft();renderComposer();}
    sendNotes.set(key,(messages[step] || '사진을 준비하지 못했습니다.')+' ['+step+']');
    renderComposer();
  }}
  finally{bitmap?.close();if(epoch===imageEpoch){imagePreparing=false;if(!imageDraft)el('image-file').value='';renderComposer();}}
}
el('attach-image').addEventListener('click',()=>{
  if(el('attach-image').disabled || !imageContextReady())return;
  if(imageDraft && imageContextReady(imageDraft.room,imageDraft.generation)){el('image-send-dialog').showModal();renderComposer();return;}
  if(imageDraft)clearImageDraft();
  el('image-file').click();
});
el('image-file').addEventListener('change',()=>void prepareImage(el('image-file').files[0]));
el('compose-text').addEventListener('paste',event=>{
  const images=[...(event.clipboardData?.items || [])].filter(item=>item.kind==='file' && item.type.startsWith('image/'));
  if(!images.length)return; // Leave ordinary text paste to the browser.
  event.preventDefault();
  if(el('attach-image').disabled || pendingSend)return;
  const file=images[0].getAsFile();if(file)void prepareImage(file);
});
el('image-cancel').addEventListener('click',()=>{clearImageDraft();renderComposer();});
el('image-send-dialog').addEventListener('cancel',()=>{clearImageDraft();renderComposer();});
el('image-send').addEventListener('click',async()=>{
  const image=imageDraft;
  if(!imageSendReady(image)){renderComposer();return;}
  sendNotes.delete(image.room);
  const pending={room:image.room,kind:'photo',clientId:crypto.randomUUID(),phase:'sending',focusInput:true};pendingSend=pending;el('image-send-dialog').close();renderComposer();
  try{const accepted=await postLocal('/api/reader/photo',{room:image.room,image:image.image,clientId:pending.clientId});if(pendingSend!==pending || !hasAccount)return;if(!accepted){pendingSend=null;sendNotes.set(image.room,'사진을 보내지 못했습니다. ＋에서 미리보기를 다시 확인할 수 있습니다.');}readerRevision=-1;await refresh();}
  catch{markSendUnknown(pending);}
  finally{renderComposer();}
});
el('rename-room').addEventListener('click',()=>{
  const room=roomNow();if(!hasAccount || !room)return;
  closeRoomActions();
  renameTarget={key:room.key,generation:readerGeneration};el('room-title-input').value=room.localTitle || room.title;el('rename-error').textContent='';el('rename-dialog').showModal();el('room-title-input').select();
});
async function saveRoomTitle(value){
  const target=renameTarget;if(!target || !hasAccount || target.generation!==readerGeneration)return;
  if(value!==null && (!value.trim() || [...value.trim()].length>120 || /[\u0000-\u001f\u007f]/u.test(value))){el('rename-error').textContent='이름은 줄바꿈 없이 1~120자로 입력해 주세요.';return;}
  try{
    if(!await postLocal('/api/preferences/room',{room:target.key,title:value===null?null:value.trim()})){el('rename-error').textContent='이름을 변경하지 못했습니다.';return;}
    if(target.generation!==readerGeneration)return;
    el('rename-dialog').close();readerRevision=-1;await refresh();
  }catch{if(target.generation===readerGeneration && renameTarget===target)el('rename-error').textContent='로컬 서버 연결을 확인해 주세요.';}
}
el('rename-form').addEventListener('submit',event=>{event.preventDefault();void saveRoomTitle(el('room-title-input').value);});
el('rename-reset').addEventListener('click',()=>void saveRoomTitle(null));
el('rename-cancel').addEventListener('click',()=>el('rename-dialog').close());
el('read-sync').addEventListener('change',()=>{if(preferenceReady())void saveSettings({readSync:el('read-sync').checked});else{readerRevision=-1;void refresh();}});
el('mute-room').addEventListener('click',()=>void saveRoomSettings({muted:!roomNow()?.muted}));
el('persist-preferences').addEventListener('change',()=>void saveSettings({persist:el('persist-preferences').checked}));
el('forget-preferences').addEventListener('click',async()=>{if(!preferenceReady() || settingsBusy || !window.confirm('이 계정의 개인 설정을 초기화하고 저장 파일을 삭제할까요?'))return;await changeSettings('/api/preferences/forget',{});});
el('browser-notifications').addEventListener('change',async()=>{
  if(el('browser-notifications').checked){
    let permission=Notification.permission;if(permission==='default')permission=await Notification.requestPermission();
    if(permission!=='granted'){el('browser-notifications').checked=false;el('notification-status').textContent='브라우저 알림 권한이 없습니다. 사이트 설정에서 허용해 주세요.';return;}
  }
  await saveSettings({notifications:el('browser-notifications').checked});
});
el('photo-close').addEventListener('click',()=>el('photo-dialog').close());
function cancelPhotoDownload(){
  photoDownloadEpoch++;const previous=photoDownload;photoDownload=null;previous?.controller.abort();
  el('photo-download').textContent='다운로드';
}
el('photo-dialog').addEventListener('close',()=>{cancelPhotoDownload();el('photo-full').removeAttribute('src');el('photo-download').disabled=true;});
// Download only on explicit click; the photo is fetched from the same local URL and never stored by the page.
el('photo-download').addEventListener('click',async()=>{
  const src=el('photo-full').getAttribute('src'),button=el('photo-download');
  if(photoDownload || !hasAccount || !el('photo-dialog').open || !src || !/^\/api\/photo\?/.test(src))return;
  const download={controller:new AbortController(),epoch:photoDownloadEpoch,generation:readerGeneration,src};photoDownload=download;
  const current=()=>photoDownload===download && photoDownloadEpoch===download.epoch && readerGeneration===download.generation && hasAccount && el('photo-dialog').open && el('photo-full').getAttribute('src')===download.src;
  const timeout=setTimeout(()=>download.controller.abort(),30000);
  button.disabled=true;button.textContent='받는 중…';
  try{
    const headers=localSession?{'X-Local-Session':localSession}:{};
    const response=await fetch(src,{cache:'no-store',headers,signal:download.controller.signal});
    if(!current() || download.controller.signal.aborted)return;
    if(!response.ok)throw new Error('photo_download_failed');
    const blob=await response.blob();if(!current() || download.controller.signal.aborted)return;
    const ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'}[blob.type] ?? 'jpg';
    const stamp=new Date().toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15);
    const url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=`kakao-photo-${stamp}.${ext}`;document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),10000);
  }catch{if(current()){el('photo-error').textContent='사진을 받지 못했습니다. 잠시 후 다시 시도해 주세요.';el('photo-error').hidden=false;}}
  finally{clearTimeout(timeout);const visible=current();if(photoDownload===download)photoDownload=null;if(visible){button.textContent='다운로드';button.disabled=false;}}
});
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('close',()=>requestAnimationFrame(()=>void maybeSeen()));
el('photo-full').addEventListener('error',()=>{el('photo-error').textContent='사진을 불러오지 못했습니다. 만료됐거나 지원하지 않는 형식일 수 있습니다.';el('photo-error').hidden=false;el('photo-download').disabled=true;});
el('new-messages').addEventListener('click',()=>{const scroll=document.querySelector('.chat-scroll');scroll.scrollTop=scroll.scrollHeight;requestAnimationFrame(()=>void maybeSeen());});
document.querySelector('.chat-scroll').addEventListener('scroll',()=>{closeMessageMenu();renderComposer();void maybeSeen();},{passive:true});
window.addEventListener('blur',()=>{foregroundFocused=false;invalidateViewPin();});
window.addEventListener('focus',()=>{if(!foregroundFocused)invalidateViewPin();foregroundFocused=true;queueRefresh();});
window.addEventListener('online',()=>{clearTimeout(presenceRetryTimer);presenceRetryTimer=null;ensureTabPresence();queueRefresh(true);});
window.addEventListener('offline',()=>{resumeEpoch++;userSelected=false;unavailable();refreshPending=true;scheduleQueuedRefresh();});
window.addEventListener('pagehide',()=>{presencePageActive=false;stopTabPresence();});
window.addEventListener('pageshow',event=>{presencePageActive=true;ensureTabPresence();queueRefresh(event.persisted===true);});
document.addEventListener('keydown',event=>{if(event.key==='Escape' && messageMenuTarget){event.preventDefault();closeMessageMenu(el('message-menu').contains(document.activeElement));}else if(event.key==='Escape' && !el('room-actions-menu').hidden){event.preventDefault();closeRoomActions(true);}else if(event.key==='Escape' && !el('account-panel').hidden){showAccount(false);el('account-toggle').focus();}});
function scheduleRefresh(){
  clearTimeout(pollTimer);
  pollTimer=setTimeout(async()=>{const now=Date.now(),gap=now-lastPollAt;lastPollAt=now;if(gap>=30000 || gap<0)queueRefresh(true);await refresh();scheduleRefresh();},document.hidden?10000:1000);
}
document.addEventListener('visibilitychange',()=>{
  if(document.hidden!==wasHidden)invalidateViewPin();
  if(document.hidden)foregroundFocused=false;
  if(!document.hidden)queueRefresh(wasHidden);
  wasHidden=document.hidden;
  scheduleRefresh();
});
void refresh().finally(scheduleRefresh);
