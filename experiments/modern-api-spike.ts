// 다운로드한 원본의 mock HTTP/WebSocket 경계를 실제로 검사한다.
// 외부 네트워크 guard를 먼저 로드한 격리 spike에서만 실행한다.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const baseDir = process.cwd();
const { MockKakaoClient } = await import(pathToFileURL(resolve(baseDir, 'src/kakao/mock.ts')).href);
const { startApiServer } = await import(pathToFileURL(resolve(baseDir, 'src/api/server.ts')).href);
const client = new MockKakaoClient();
await client.login({ userId: 'mock', deviceUUID: 'mock', accessToken: 'mock', refreshToken: 'mock' });
const server = await startApiServer({ host: '127.0.0.1', port: 0, mode: 'mock', client });
const origin = `http://127.0.0.1:${server.port}`;
const checks: Array<{name: string; passed: boolean; observation?: unknown}> = [];
let socket: WebSocket | undefined;
const check = (name: string, condition: boolean, observation?: unknown) => {
  checks.push({ name, passed: condition, observation });
  assert(condition, name);
};

try {
  const health = await fetch(origin + '/api/health');
  const healthBody = await health.json();
  check('health_explicitly_mock', health.status === 200 && healthBody.mode === 'mock');
  const listing = await fetch(origin + '/api/rooms');
  const { rooms } = await listing.json();
  check('synthetic_room_list', Array.isArray(rooms) && rooms.length > 0, { count: rooms.length });
  const roomId = rooms[0].id;
  const history = await fetch(origin + `/api/rooms/${roomId}/messages?limit=3`);
  const { messages } = await history.json();
  check('synthetic_history_limit_and_order', history.status === 200 && messages.length <= 3 && messages.length > 0 &&
    messages.every((m: any, i: number) => i === 0 || m.timestamp >= messages[i - 1].timestamp), { count: messages.length });
  const invalid = await fetch(origin + `/api/rooms/${roomId}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({message:' '}) });
  check('empty_synthetic_send_rejected', invalid.status === 400, { status: invalid.status });
  const missing = await fetch(origin + '/not-a-route');
  check('unknown_http_route_rejected', missing.status === 404);

  const incoming: any[] = [];
  socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/rooms/${roomId}`);
  socket.addEventListener('message', event => incoming.push(JSON.parse(String(event.data))));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Local WS open timeout')), 5000);
    socket!.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket!.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Local WS failure')); }, { once: true });
  });
  const sent = await fetch(origin + `/api/rooms/${roomId}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({message:'synthetic-spike-message'}) });
  check('synthetic_send_http_ack', sent.status === 200 && (await sent.json()).ok === true);
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && !incoming.some(e => e.type === 'message')) await new Promise(r => setTimeout(r, 50));
  check('local_ws_ready_event', incoming.some(e => e.type === 'ready'));
  check('local_ws_synthetic_message_event', incoming.some(e => e.type === 'message' && e.message?.roomId === roomId));
  const cors = await fetch(origin + '/api/rooms', { headers: { Origin: 'https://example.invalid' } });
  check('security_observation_no_service_auth_and_wildcard_cors', cors.status === 200 &&
    cors.headers.get('access-control-allow-origin') === '*', { status: cors.status, allow_origin: cors.headers.get('access-control-allow-origin') });
  const guard = (globalThis as any).__spikeGuard;
  check('external_network_not_attempted', guard && guard.externalConnectionsBlocked === 0 && guard.externalRequestsBlocked === 0, guard);
} finally {
  if (socket && socket.readyState < 2) socket.close();
  await server.close();
  const result = { experiment: 'modern_mock_http_websocket', candidate_commit: '8dbbd4f7ed6b42542982252250622fa351af00e9',
    observed_at_utc: new Date().toISOString(), mode: 'mock', real_account_verified: false, actual_message_sent: false,
    loopback_only: true, checks, synthetic_checks_passed: checks.length === 10 && checks.every(c => c.passed),
    limitation: 'Mock API behavior only; real Kakao authentication, history, receive and send remain unexecuted' };
  const evidence = resolve(baseDir, '../../../evidence/alternatives/modern-api-spike.json');
  writeFileSync(evidence, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
