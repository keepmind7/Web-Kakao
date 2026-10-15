'use strict';
const el = id => document.getElementById(id);
let csrf = null, busy = false, expiresAt = null;
const labels = { idle:'로그인 준비', checking:'등록 허용 확인', generating:'QR 요청 중', waiting:'휴대폰으로 QR 스캔', approval:'휴대폰 승인 대기', authenticated:'인증 응답 확인', blocked:'연결 시도 중단', error:'연결 오류', expired:'인증 시간 만료', cancelled:'로컬 세션 삭제' };
function render(state) {
  if (state.csrf) csrf = state.csrf;
  el('title').textContent = labels[state.phase] || '연결 상태 확인';
  el('message').textContent = state.message;
  el('mode').textContent = state.mode === 'live' ? '실제 서버 인증 실험 · 이 노트북에서만 접근' : '모의 화면 · 실제 카카오톡 로그인 아님';
  el('start').disabled = busy || !state.canStart || !csrf;
  el('start').textContent = state.phase === 'idle' ? 'QR 로그인 시작' : '새 QR 발급';
  el('cancel').disabled = busy || ['idle','cancelled'].includes(state.phase) || !csrf;
  el('room-panel').hidden = typeof state.canProbe !== 'boolean' || (!state.credentialInMemory && !state.roomProbe);
  el('room-check').disabled = busy || !state.canProbe || !csrf;
  const probe = state.roomProbe;
  if (state.phase === 'authenticated' && probe?.connectionVerified) el('title').textContent = '대화 서버 연결 성공';
  el('room-check').textContent = probe?.phase === 'completed' ? '연결 검사 완료' : probe?.phase === 'running' ? '연결 검사 중…' : '읽기 전용 연결 확인';
  el('room-result').textContent = !probe ? '인증이 확인됐습니다. 준비되면 연결을 확인해 주세요.'
    : probe.phase === 'running' ? '대화 서버 연결을 확인하고 있습니다.'
    : probe.connectionVerified ? `연결 검사에 성공했습니다.${probe.roomListPresent ? ` 실제 서버에서 방 목록 응답 ${probe.roomCount}개를 받았습니다.` : ' 방 목록 필드는 아직 확인하지 못했습니다.'} 이번 화면은 개수 확인까지 제공합니다. 대화방 이름과 메시지 표시 기능은 아직 연결하지 않았습니다. 검사 연결은 종료했습니다.`
    : `연결 검사를 중단했습니다. (단계 ${probe.stage}${probe.status !== null && probe.status !== undefined ? `, 상태 ${probe.status}` : ''})`;
  el('diagnostic').textContent = state.stage ? `단계: ${state.stage}${state.httpStatus ? ` · HTTP ${state.httpStatus}` : ''}${state.apiStatus !== null && state.apiStatus !== undefined ? ` · 상태 ${state.apiStatus}` : ''}` : '';
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
}
async function refresh() {
  if (busy) return;
  try {
    let response = await fetch('/api/status', {cache:'no-store'});
    if (response.status === 403) {
      // Re-establish only the local browser cookie after an operator restart.
      // This does not start QR generation or reuse an account credential.
      const page = await fetch('/', {cache:'no-store'}); if (!page.ok) throw new Error();
      response = await fetch('/api/status', {cache:'no-store'});
    }
    if (!response.ok) throw new Error(); render(await response.json());
  }
  catch { el('message').textContent = '로컬 서버에 연결할 수 없습니다. 실행 상태를 확인해 주세요.'; el('start').disabled = el('cancel').disabled = true; }
}
async function act(path) {
  if (busy || !csrf) return;
  busy = true; el('start').disabled = el('cancel').disabled = true;
  try {
    const response = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':csrf}, body:'{}'});
    if (!response.ok && response.status !== 409) throw new Error();
    const state = await response.json(); busy = false; render(state);
  } catch { busy = false; await refresh(); }
}
el('start').addEventListener('click', () => act('/api/start'));
el('cancel').addEventListener('click', () => act('/api/cancel'));
el('room-check').addEventListener('click', () => act('/api/room-probe'));
refresh(); setInterval(refresh, 1000);
