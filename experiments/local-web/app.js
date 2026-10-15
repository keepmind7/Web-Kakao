'use strict';
const el = id => document.getElementById(id);
let csrf = null, busy = false, expiresAt = null;
let refreshing=false,hasAccount=false,readerGeneration=0,readerRevision=-1,selectedRoom=null,roomsCache=[],lastState=null,actionEpoch=0,readerAttempt=null;
let pendingSelection=null;
let renderedRooms=null,renderedMessages=null,renderedMessageRoom=null,renderedQr=null;
async function flushSelection(){
  const pending=pendingSelection;
  if(!pending || busy || lastState?.reader?.historyBusy)return;
  if(!hasAccount || pending.generation!==readerGeneration || pending.key!==selectedRoom || lastState?.reader?.phase!=='connected'){pendingSelection=null;return;}
  pendingSelection=null;
  if(roomsCache.find(room=>room.key===pending.key)?.historyAvailable!==false)await act('/api/reader/history',{room:pending.key});
}
function showAccount(show){el('account-panel').hidden=!show;el('account-toggle').setAttribute('aria-expanded',String(show));}
function renderChatHeading(){
  const room=roomsCache.find(row=>row.key===selectedRoom);
  el('chat-title').textContent=room?.title || '대화방을 선택해 주세요';
  el('chat-avatar').textContent=room?.title?.slice(0,1) || 'W';
  el('chat-subtitle').textContent=room ? '읽기 전용' : '대화방을 선택해 주세요';
  el('welcome').hidden=Boolean(room);
}
const labels = { idle:'로그인 준비', checking:'등록 허용 확인', generating:'QR 요청 중', waiting:'휴대폰으로 QR 스캔', approval:'휴대폰 승인 대기', authenticated:'인증 응답 확인', blocked:'연결 시도 중단', error:'연결 오류', expired:'인증 시간 만료', cancelled:'로컬 세션 삭제' };
function render(state) {
  lastState=state;
  const nextAttempt=Number.isInteger(state.reader?.attempts)?state.reader.attempts:null;
  if(!state.credentialInMemory || (nextAttempt!==null && nextAttempt!==readerAttempt)){
    if(hasAccount || nextAttempt!==readerAttempt)readerGeneration++;
    selectedRoom=null;roomsCache=[];readerRevision=-1;
    pendingSelection=null;
    renderedRooms=null;renderedMessages=null;renderedMessageRoom=null;
    el('room-list').replaceChildren();el('message-list').replaceChildren();el('reader-workspace').hidden=true;
    el('room-search').value='';el('history-note').textContent='대화 목록에서 방을 선택해 주세요.';renderChatHeading();
  }
  readerAttempt=nextAttempt;
  hasAccount=Boolean(state.credentialInMemory);
  if (state.csrf) csrf = state.csrf;
  el('title').textContent = labels[state.phase] || '연결 상태 확인';
  el('message').textContent = state.message;
  if(state.phase==='blocked' && state.stage==='poll' && Number.isInteger(state.apiStatus))el('message').textContent=`지원하지 않는 인증 응답을 받아 중단했습니다. (상태 ${state.apiStatus})`;
  el('mode').textContent = state.mode === 'live' ? '실제 서버 인증 실험 · 이 노트북에서만 접근' : '모의 화면 · 실제 카카오톡 로그인 아님';
  el('start').disabled = busy || !state.canStart || !csrf;
  el('start').textContent = state.phase === 'idle' ? 'QR 로그인 시작' : '새 QR 발급';
  el('cancel').disabled = busy || ['idle','cancelled'].includes(state.phase) || !csrf;
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
  el('connection-label').textContent=reader?.phase==='connected'?'● 대화 서버 연결됨':reader?.phase==='connecting'?'대화 서버 연결 중…':hasAccount?'인증됨 · 대화 연결 대기':labels[state.phase] || '연결 상태 확인';
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
}
async function localJson(path){const response=await fetch(path,{cache:'no-store'});if(!response.ok)throw new Error();return response.json();}
const time=value=>value ? new Date(value).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}) : '';
function renderRooms(){
  const query=el('room-search').value.trim().toLocaleLowerCase();
  const signature=JSON.stringify([roomsCache,selectedRoom,query]);
  if(signature===renderedRooms)return;
  renderedRooms=signature;
  const fragment=document.createDocumentFragment();
  const filtered=roomsCache.filter(room=>room.title.toLocaleLowerCase().includes(query));
  for(const room of filtered){
    const button=document.createElement('button');button.className='room-item'+(room.key===selectedRoom?' selected':'');button.type='button';button.setAttribute('aria-pressed',String(room.key===selectedRoom));
    const title=document.createElement('strong');title.textContent=room.title;
    const preview=document.createElement('span');preview.className='room-preview';preview.textContent=room.preview || '미리보기 없음';
    const avatar=document.createElement('span');avatar.className='avatar';avatar.textContent=room.title.slice(0,1);avatar.setAttribute('aria-hidden','true');
    const copy=document.createElement('span');copy.className='room-copy';copy.append(title,preview);
    const when=document.createElement('span');when.className='room-time';when.textContent=room.lastAt?new Date(room.lastAt).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}):'';
    button.append(avatar,copy,when);button.addEventListener('click',()=>selectRoom(room.key));fragment.append(button);
  }
  if(!filtered.length && roomsCache.length){const empty=document.createElement('p');empty.className='sidebar-empty';empty.textContent='검색 결과가 없습니다.';fragment.append(empty);}
  el('room-list').replaceChildren(fragment);
}
async function selectRoom(key){
  const generation=readerGeneration;
  if(key===selectedRoom && pendingSelection?.key===key)return;
  pendingSelection=null;
  if(key!==selectedRoom){renderedMessages=null;renderedMessageRoom=null;el('message-list').replaceChildren();}
  selectedRoom=key;renderRooms();el('history-note').textContent='메시지 표시를 준비하고 있습니다.';
  renderChatHeading();showAccount(false);
  if(lastState)render(lastState);
  const page=await refreshMessages(key,generation);
  if(!hasAccount || generation!==readerGeneration || key!==selectedRoom)return;
  // Live pushes already update cached rooms. Selecting a loaded room is local;
  // the explicit load button remains available for another server page.
  if(page?.history?.phase==='idle')pendingSelection={key,generation};
  await flushSelection();
}
async function refreshMessages(key,generation){
  try{
    const page=await localJson('/api/reader/messages?room='+encodeURIComponent(key));
    if(!hasAccount || generation!==readerGeneration || key!==selectedRoom)return;
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
    const fragment=document.createDocumentFragment();
    let previousDay=null;
    for(const message of page.messages || []){
      if(message.at){const day=new Date(message.at).toLocaleDateString('ko-KR');if(day!==previousDay){const label=document.createElement('div');label.className='day-label';label.textContent=day;fragment.append(label);previousDay=day;}}
      const item=document.createElement('article');item.className='message'+(message.mine?' mine':'');
      const author=document.createElement('div');author.className='muted';author.textContent=[message.sender,time(message.at)].filter(Boolean).join(' · ');
      const text=document.createElement('p');text.textContent=message.text || '[본문 없음]';item.append(author,text);fragment.append(item);
    }
    if(!page.messages?.length){const empty=document.createElement('p');empty.className='muted';empty.textContent=emptyText;fragment.append(empty);}
    el('message-list').replaceChildren(fragment);
    renderedMessageRoom=key;renderedMessages=signature;
    if(page.messages?.length)scroll.scrollTop=changedRoom || atBottom?scroll.scrollHeight:top;
    return page;
  }catch{if(key===selectedRoom && generation===readerGeneration){el('history-note').hidden=false;el('history-note').textContent='메시지를 표시할 수 없습니다. 연결 상태를 확인해 주세요.';}}
}
async function refreshReader(state){
  if(!hasAccount || !state.reader || state.reader.revision===readerRevision)return;
  const generation=readerGeneration;
  const data=await localJson('/api/reader/rooms');
  if(!hasAccount || generation!==readerGeneration)return;
  roomsCache=data.rooms || [];readerRevision=state.reader.revision;
  if(!roomsCache.some(room=>room.key===selectedRoom)){
    selectedRoom=roomsCache[0]?.key || null;renderedMessages=null;renderedMessageRoom=null;el('message-list').replaceChildren();el('history-note').textContent='메시지 표시를 준비하고 있습니다.';
  }
  el('reader-workspace').hidden=!roomsCache.length;renderRooms();
  renderChatHeading();
  if(selectedRoom)await refreshMessages(selectedRoom,generation);
  if(lastState)render(lastState);
}
async function refresh() {
  if (busy || refreshing) return;
  refreshing=true;const epoch=actionEpoch;
  try {
    let response = await fetch('/api/status', {cache:'no-store'});
    if (response.status === 403) {
      // Re-establish only the local browser cookie after an operator restart.
      // This does not start QR generation or reuse an account credential.
      const page = await fetch('/', {cache:'no-store'}); if (!page.ok) throw new Error();
      response = await fetch('/api/status', {cache:'no-store'});
    }
    if (!response.ok) throw new Error(); const state=await response.json();if(epoch!==actionEpoch)return;render(state);await refreshReader(state);await flushSelection();
  }
  catch { el('message').textContent = '로컬 서버에 연결할 수 없습니다. 실행 상태를 확인해 주세요.'; el('start').disabled = el('cancel').disabled = el('reader-connect').disabled = el('history-load').disabled = true; }
  finally{refreshing=false;}
}
async function act(path,body={}) {
  if (busy || !csrf) return;
  busy = true;actionEpoch++; el('start').disabled = el('cancel').disabled = el('history-load').disabled = true;
  try {
    const response = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':csrf}, body:JSON.stringify(body)});
    if (!response.ok && response.status !== 409) throw new Error();
    const state = await response.json(); busy = false;if(state.phase)render(state);readerRevision=-1;await refresh();
  } catch { busy = false; await refresh(); }
}
el('start').addEventListener('click', () => act('/api/start'));
el('cancel').addEventListener('click', () => act('/api/cancel'));
el('room-check').addEventListener('click', () => act('/api/room-probe'));
el('reader-connect').addEventListener('click',()=>act('/api/reader/connect'));
el('reader-disconnect').addEventListener('click',()=>act('/api/reader/disconnect'));
el('history-load').addEventListener('click',()=>{if(selectedRoom)act('/api/reader/history',{room:selectedRoom});});
el('room-search').addEventListener('input',renderRooms);
el('account-toggle').addEventListener('click',()=>showAccount(el('account-panel').hidden));
el('account-close').addEventListener('click',()=>{showAccount(false);el('account-toggle').focus();});
document.addEventListener('keydown',event=>{if(event.key==='Escape' && !el('account-panel').hidden){showAccount(false);el('account-toggle').focus();}});
let pollTimer=null;
function scheduleRefresh(){
  clearTimeout(pollTimer);
  pollTimer=setTimeout(async()=>{await refresh();scheduleRefresh();},document.hidden?10000:1000);
}
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden)void refresh();
  scheduleRefresh();
});
void refresh().finally(scheduleRefresh);
