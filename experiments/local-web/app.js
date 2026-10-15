'use strict';
const el = id => document.getElementById(id);
let csrf = null, busy = false, expiresAt = null;
let refreshing=false,hasAccount=false,readerGeneration=0,readerRevision=-1,selectedRoom=null,roomsCache=[],lastState=null,actionEpoch=0,readerAttempt=null;
const labels = { idle:'로그인 준비', checking:'등록 허용 확인', generating:'QR 요청 중', waiting:'휴대폰으로 QR 스캔', approval:'휴대폰 승인 대기', authenticated:'인증 응답 확인', blocked:'연결 시도 중단', error:'연결 오류', expired:'인증 시간 만료', cancelled:'로컬 세션 삭제' };
function render(state) {
  lastState=state;
  const nextAttempt=Number.isInteger(state.reader?.attempts)?state.reader.attempts:null;
  if(!state.credentialInMemory || (nextAttempt!==null && nextAttempt!==readerAttempt)){
    if(hasAccount || nextAttempt!==readerAttempt)readerGeneration++;
    selectedRoom=null;roomsCache=[];readerRevision=-1;
    el('room-list').replaceChildren();el('message-list').replaceChildren();el('reader-workspace').hidden=true;
  }
  readerAttempt=nextAttempt;
  hasAccount=Boolean(state.credentialInMemory);
  if (state.csrf) csrf = state.csrf;
  el('title').textContent = labels[state.phase] || '연결 상태 확인';
  el('message').textContent = state.message;
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
  if (state.grid) {
    const size = state.grid.length, scale = Math.max(3, Math.floor(300 / (size + 8)));
    canvas.width = canvas.height = (size + 8) * scale;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = '#000';
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (state.grid[row][col]) context.fillRect((col+4)*scale, (row+4)*scale, scale, scale);
  } else { canvas.width = canvas.height = 1; }
  el('passcode').hidden = !state.passcode; el('code').textContent = state.passcode || '';
  expiresAt = state.expiresAt || null;
  el('expiry').textContent = expiresAt ? `남은 시간 ${Math.max(0, Math.ceil((expiresAt-Date.now())/1000))}초` : '';
  el('reader-panel').hidden=!hasAccount;
  el('reader-connect').disabled=busy || !state.canOpenReader || !csrf;
  el('reader-connect').textContent=state.reader?.attempts ? '대화 서버 다시 연결' : '대화방 불러오기';
  el('reader-disconnect').disabled=busy || !['connecting','connected'].includes(state.reader?.phase);
  const reader=state.reader;
  if(hasAccount && reader?.phase==='connected'){
    el('title').textContent='대화 서버 연결됨';el('message').textContent='아래에서 대화방을 선택하고 메시지 조회를 눌러 주세요.';
  }else if(hasAccount && reader?.phase==='disconnected'){
    el('title').textContent='대화 연결 종료';el('message').textContent='인증 정보는 메모리에 남아 있습니다. 서버가 거부한 상태가 아니면 수동으로 다시 연결할 수 있습니다.';
  }
  el('reader-status').textContent=reader?.phase==='connected' ? `연결 중 · 대화방 ${reader.roomCount}개 · 새 메시지 수신 묶음 ${reader.pushBatches}회${reader.truncated?' · 목록 일부만 표시':''}`
    : reader?.phase==='connecting' ? '대화 서버에 연결하고 있습니다.'
    : ['blocked','disconnected'].includes(reader?.phase) ? `연결이 종료됐습니다. 마지막 표시 내용은 새로 동기화되지 않습니다. (${reader.stage}${reader.status!==null ? `, 상태 ${reader.status}`:''})`
    : '인증이 확인됐습니다. 대화방을 불러와 주세요.';
  el('history-load').disabled=busy || !selectedRoom || reader?.phase!=='connected' || reader?.historyBusy===true;
}
async function localJson(path){const response=await fetch(path,{cache:'no-store'});if(!response.ok)throw new Error();return response.json();}
const time=value=>value ? new Date(value).toLocaleString('ko-KR') : '시간 미확인';
function renderRooms(){
  const fragment=document.createDocumentFragment();
  for(const room of roomsCache){
    const button=document.createElement('button');button.className='room-item'+(room.key===selectedRoom?' selected':'');button.type='button';button.setAttribute('aria-pressed',String(room.key===selectedRoom));
    const title=document.createElement('strong');title.textContent=room.title;
    const preview=document.createElement('span');preview.textContent=room.preview || '미리보기 없음';
    button.append(title,preview);button.addEventListener('click',()=>selectRoom(room.key));fragment.append(button);
  }
  el('room-list').replaceChildren(fragment);
}
async function selectRoom(key){
  selectedRoom=key;renderRooms();el('message-list').replaceChildren();el('history-note').textContent='메시지 표시를 준비하고 있습니다.';
  el('chat-title').textContent=roomsCache.find(room=>room.key===key)?.title || '대화방';
  if(lastState)render(lastState);
  await refreshMessages(key,readerGeneration);
}
async function refreshMessages(key,generation){
  try{
    const page=await localJson('/api/reader/messages?room='+encodeURIComponent(key));
    if(!hasAccount || generation!==readerGeneration || key!==selectedRoom)return;
    const history=page.history || {};
    el('history-note').textContent=history.phase==='loaded' ? `서버 조회 응답 ${history.receivedCount}개 · 표시 가능한 항목 ${history.acceptedCount}개. 전체 과거 이력인지는 아직 확인하지 않았습니다.`
      : history.phase==='loading' ? '서버에서 메시지를 조회하고 있습니다.'
      : history.phase==='unrecognized' ? '서버 응답에서 유효한 메시지 묶음을 확인하지 못했습니다.'
      : history.phase==='failed' ? '메시지 조회가 중단됐습니다.' : '이 방의 이력은 아직 조회하지 않았습니다. 수신된 새 메시지가 있으면 함께 표시됩니다.';
    const fragment=document.createDocumentFragment();
    for(const message of page.messages || []){
      const item=document.createElement('article');item.className='message'+(message.mine?' mine':'');
      const author=document.createElement('div');author.className='muted';author.textContent=message.sender+' · '+time(message.at);
      const text=document.createElement('p');text.textContent=message.text || '[본문 없음]';item.append(author,text);fragment.append(item);
    }
    if(!page.messages?.length){const empty=document.createElement('p');empty.className='muted';empty.textContent=history.phase==='loaded'?'서버가 반환한 이번 묶음에는 표시할 메시지가 없습니다.':history.phase==='unrecognized'?'메시지 응답을 아직 해석하지 못했습니다. 대화가 없다는 뜻은 아닙니다.':history.phase==='failed'?'메시지 조회가 중단됐습니다.':history.phase==='loading'?'메시지를 조회하고 있습니다.':'메시지 조회를 눌러 주세요.';fragment.append(empty);}
    el('message-list').replaceChildren(fragment);
  }catch{if(key===selectedRoom && generation===readerGeneration)el('history-note').textContent='메시지를 표시할 수 없습니다. 연결 상태를 확인해 주세요.';}
}
async function refreshReader(state){
  if(!hasAccount || !state.reader || state.reader.revision===readerRevision)return;
  const generation=readerGeneration;
  const data=await localJson('/api/reader/rooms');
  if(!hasAccount || generation!==readerGeneration)return;
  roomsCache=data.rooms || [];readerRevision=state.reader.revision;
  if(!roomsCache.some(room=>room.key===selectedRoom)){
    selectedRoom=roomsCache[0]?.key || null;el('message-list').replaceChildren();el('history-note').textContent='메시지 표시를 준비하고 있습니다.';
  }
  el('reader-workspace').hidden=!roomsCache.length;renderRooms();
  el('chat-title').textContent=roomsCache.find(room=>room.key===selectedRoom)?.title || '대화방을 선택해 주세요';
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
    if (!response.ok) throw new Error(); const state=await response.json();if(epoch!==actionEpoch)return;render(state);await refreshReader(state);
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
refresh(); setInterval(refresh, 1000);
