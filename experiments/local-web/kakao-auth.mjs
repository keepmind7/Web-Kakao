import https from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PROFILE = Object.freeze({ os: 'android', model: 'SM-T733', osVersion: '14', appVersion: '26.1.2' });
const SOURCE = '../../local-only/sources/modern/8dbbd4f7ed6b42542982252250622fa351af00e9/';
export function checkPinnedSource({ workingCopy = false } = {}) {
  for (const [name, hash] of Object.entries({
    'src/kakao/auth.ts': 'e4869df418ff9accdde1b44476532e4bcaf6096025acdf073362ecf6afc8cfff',
    'src/kakao/forge-protocol.ts': '2f07f4c8fb8fa16d4e4fdd2307b2ab2d26fc4a3ced83ebf33ce1c808754c9489',
  })) {
    // Resolve against project root, not the process cwd. No original code is executed.
    const path = fileURLToPath(new URL(SOURCE + name, import.meta.url));
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== hash) throw new Error('source_mismatch');
    if (workingCopy) {
      const importedPath = fileURLToPath(new URL('../../local-only/spikes/modern/' + name, import.meta.url));
      if (createHash('sha256').update(readFileSync(importedPath)).digest('hex') !== hash) throw new Error('imported_source_mismatch');
    }
  }
}

// The only permitted remote operations. There is no arbitrary URL, token reuse,
// message, LOCO, registration bypass, redirect or automatic retry operation.
const OPERATIONS = Object.freeze({
  allowlist: ['GET', '/android/account/allowlist.json?model_name=SM-T733'],
  generate: ['POST', '/android/account/qrCodeLogin/generate'],
  poll: ['POST', '/android/account/qrCodeLogin/login'],
});
export function createTransport() {
  checkPinnedSource();
  return async function request(operation, payload, signal) {
    if (!Object.hasOwn(OPERATIONS, operation)) throw new Error('operation_not_allowed');
    const [method, path] = OPERATIONS[operation];
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'katalk.kakao.com', port: 443, path, method, rejectUnauthorized: true,
        signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
        headers: {
          Accept: 'application/json', 'Accept-Encoding': 'identity',
          A: 'android/26.1.2/ko',
          'User-Agent': operation === 'allowlist' ? 'KT/26.1.2 An/14 ko' : 'okhttp/4.12.0',
          // Anonymous format controls (2026-10-15): absent/JSON -> 415;
          // form Content-Type on this GET -> 200, status 0, allowlisted true.
          ...(operation === 'allowlist' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(body ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      }, res => {
        const chunks = []; let bytes = 0;
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 16384) { res.destroy(); req.destroy(new Error('response_limit')); return; }
          chunks.push(chunk);
        });
        res.on('error', () => reject(new Error('response_error')));
        res.on('aborted', () => reject(new Error('response_aborted')));
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* no raw body in errors */ }
          resolve({ httpStatus: res.statusCode, body: parsed });
        });
      });
      req.on('error', () => reject(new Error('transport_error')));
      req.end(body);
    });
  };
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const seconds = value => Number.isFinite(value) && value > 0 && value <= 300;
const positiveId = value => (typeof value === 'string' && /^[1-9]\d{0,30}$/.test(value)) || (Number.isSafeInteger(value) && value > 0);
export function createAuthLab({ transport, encodeQr, mode = 'live', now = Date.now, later = setTimeout, clear = clearTimeout }) {
  let view = { phase: 'idle', message: 'QR 로그인 시작을 누르면 서버 허용 여부부터 확인합니다.', stage: null };
  let credentials = null, deviceUUID = null, qrId = null, timer = null, deadlineTimer = null, epoch = 0, attempts = 0, locked = false;
  let probeAttempted = false;
  const logicalDeviceUUID = createHash('sha256').update(`dkljleskljfeisflssljeif ${randomUUID()}-${now()}`).digest('hex');
  let abort = new AbortController();
  const counts = { allowlist: 0, generate: 0, poll: 0 };
  const forget = () => { credentials = null; deviceUUID = null; qrId = null; delete view.grid; delete view.passcode; delete view.expiresAt;
    if (view.roomProbe?.phase === 'running') view.roomProbe = {phase:'failed',stage:'cancelled',connectionVerified:false}; };
  const stopTimer = () => { if (timer !== null) clear(timer); if (deadlineTimer !== null) clear(deadlineTimer); timer = null; deadlineTimer = null; };
  const terminal = (phase, message) => { ++epoch; if (['blocked','error'].includes(phase)) locked = true; stopTimer(); abort.abort(); forget(); view = { ...view, phase, message }; };
  const canStart = () => !locked && attempts < 3 && ['idle','expired','cancelled'].includes(view.phase);
  const schedule = (callback, ms) => { timer = later(callback, ms); timer?.unref?.(); };
  function responseOK(result, stage) {
    view.stage = stage;
    view.httpStatus = Number.isInteger(result?.httpStatus) ? result.httpStatus : null;
    view.apiStatus = Number.isInteger(result?.body?.status) ? result.body.status : null;
    if (result?.httpStatus !== 200 || !object(result.body)) {
      terminal('blocked', `카카오톡 서버 응답을 확인할 수 없어 중단했습니다. (${stage}, HTTP ${view.httpStatus ?? '없음'})`);
      return false;
    }
    return true;
  }
  async function call(stage, payload) { counts[stage]++; return transport(stage, payload, abort.signal); }
  async function poll(run) {
    if (run !== epoch) return;
    if (now() >= view.expiresAt) { terminal('expired', 'QR 인증 시간이 만료되었습니다.'); return; }
    try {
      const result = await call('poll', { device: { uuid: deviceUUID }, id: qrId });
      if (run !== epoch) return;
      if (now() >= view.expiresAt) { terminal('expired', 'QR 인증 시간이 만료되었습니다.'); return; }
      if (!responseOK(result, 'poll')) return;
      const body = result.body;
      if (!Number.isInteger(body.status)) { terminal('error', '인증 응답 형식을 확인할 수 없어 중단했습니다.'); return; }
      if (body.status === 0 && typeof body.accessToken === 'string' && body.accessToken.length > 0 && positiveId(body.user?.userId)) {
        stopTimer();
        credentials = { userId: String(body.user.userId), deviceUUID, accessToken: body.accessToken,
          refreshToken: typeof body.refreshToken === 'string' ? body.refreshToken : '' };
        qrId = null; delete view.grid; delete view.passcode; delete view.expiresAt;
        view = { ...view, phase: 'authenticated', message: 'QR 인증 응답과 토큰을 받았습니다. 대화 서버 연결은 아직 검증하지 않았습니다.' };
        schedule(() => terminal('expired', '인증 확인용 메모리를 지웠습니다. 휴대폰에서 등록 기기도 확인해 주세요.'), 15 * 60 * 1000);
        return;
      }
      // Do not interpret an arbitrary error plus retry interval as permission to retry.
      // Android upstream explicitly describes -100 as scanned/passcode pending:
      // play2fly/KakaoForge@4b774ea40b1347280fadb685415436584093118b src/auth/login.ts.
      // -150 was also observed on this Android route immediately after QR
      // generation, before any phone scan. It is admitted only with a valid
      // server poll interval; protection/unknown codes still stop the flow.
      if (![-150, -100].includes(body.status)) {
        terminal('blocked', `인증이 거부되었거나 지원하지 않는 응답입니다. (상태 ${body.status})`); return;
      }
      const interval = body.nextRequestIntervalInSeconds;
      if (!Number.isInteger(interval) || interval < 1 || interval > 30) {
        terminal('error', '인증 대기 간격을 확인할 수 없어 중단했습니다.'); return;
      }
      if (body.status === -100) {
        if (typeof body.passcode !== 'string' || !/^\d{4}$/.test(body.passcode)) {
          terminal('error', '기기 확인 코드 형식을 확인할 수 없어 중단했습니다.'); return;
        }
        view.phase = 'approval'; view.passcode = body.passcode;
        view.message = '휴대폰에 표시된 연결 기기와 아래 확인 코드를 확인하고 승인해 주세요.';
      } else {
        view.phase = 'waiting'; delete view.passcode;
        view.message = '휴대폰 카카오톡의 QR 스캐너로 아래 코드를 스캔해 주세요.';
      }
      schedule(() => poll(run), interval * 1000);
    } catch { if (run === epoch) terminal('error', '인증 서버 연결에 실패했습니다. 자동 재시도는 하지 않습니다.'); }
  }
  return {
    snapshot() {
      return { ...view, mode, profile: PROFILE, credentialInMemory: credentials !== null,
        canStart: canStart(), canProbe: view.phase === 'authenticated' && credentials !== null && !probeAttempted,
        attempts, actualChatConnected: view.roomProbe?.connectionVerified === true, actualMessageSent: false, requests: { ...counts } };
    },
    async start() {
      if (!canStart()) return false;
      attempts++; probeAttempted = false; abort = new AbortController(); const run = ++epoch;
      view = { phase: 'checking', message: '등록 프로필의 서버 허용 여부를 확인하고 있습니다.', stage: 'allowlist' };
      try {
        const allow = await call('allowlist');
        if (run !== epoch) return true;
        if (!responseOK(allow, 'allowlist')) return true;
        if (allow.body.allowlisted !== true || (Object.hasOwn(allow.body, 'status') && allow.body.status !== 0)) {
          terminal('blocked', '서버에서 해당 등록 프로필의 허용을 확인하지 못해 중단했습니다.'); return true;
        }
        deviceUUID = logicalDeviceUUID;
        view.phase = 'generating'; view.message = '카카오톡 로그인 QR을 요청하고 있습니다.';
        const generated = await call('generate', { device: { name: PROFILE.model, uuid: deviceUUID, model: PROFILE.model, osVersion: PROFILE.osVersion } });
        if (run !== epoch) return true;
        if (!responseOK(generated, 'generate')) return true;
        const body = generated.body;
        if (body.status !== 0 || typeof body.url !== 'string' || !body.url.length || body.url.length > 2048 || !/^[\x20-\x7e]+$/.test(body.url) || !seconds(body.remainingSeconds)) {
          terminal('blocked', '로그인 QR 응답을 확인할 수 없어 중단했습니다.'); return true;
        }
        // QR content is opaque, not a browser URL. Never navigate to it or place
        // it in HTML. Preserve exactly the server content, as upstream does.
        const match = body.url.match(/[?&]id=([^&]+)/);
        qrId = match ? match[1] : body.url;
        try { qrId = decodeURIComponent(qrId); } catch { /* upstream preserves non-URI payloads */ }
        view.qrIssued = true;
        view.grid = encodeQr(body.url); view.expiresAt = now() + body.remainingSeconds * 1000;
        view.phase = 'waiting'; view.message = '휴대폰 카카오톡의 QR 스캐너로 아래 코드를 스캔해 주세요.';
        deadlineTimer = later(() => { if (run === epoch) terminal('expired', 'QR 인증 시간이 만료되었습니다.'); }, body.remainingSeconds * 1000);
        deadlineTimer?.unref?.();
        schedule(() => poll(run), 2000);
      } catch { if (run === epoch) terminal('error', 'QR 준비 중 연결 또는 처리 오류가 발생했습니다. 자동 재시도는 하지 않습니다.'); }
      return true;
    },
    async connectReadOnly(probe) {
      if (view.phase !== 'authenticated' || !credentials || probeAttempted) return false;
      probeAttempted = true; const run = epoch;
      view.roomProbe = {phase:'running',stage:'booking',connectionVerified:false};
      try {
        const result = await probe(credentials, {signal:abort.signal});
        if (run === epoch) {
          view.roomProbe = result;
          if (result.connectionVerified) view.message = '대화 서버의 로그인 응답을 확인했습니다. 이번 검사 연결은 종료했으며 상시 수신은 아직 검증하지 않았습니다.';
          if (result.phase !== 'completed') locked = true;
        }
      } catch { if (run === epoch) { view.roomProbe = {phase:'failed',stage:'worker',connectionVerified:false}; locked = true; } }
      return true;
    },
    cancel() { ++epoch; terminal('cancelled', '로컬 인증 작업과 메모리를 지웠습니다. 원격 기기 로그아웃은 휴대폰에서 확인해 주세요.'); },
  };
}

export function mockTransport() {
  return async operation => operation === 'allowlist'
    ? { httpStatus: 200, body: { allowlisted: true } }
    : operation === 'generate'
      ? { httpStatus: 200, body: { status: 0, url: 'kakaotalk://qrlogin?id=offline-synthetic-not-for-login', remainingSeconds: 180 } }
      : { httpStatus: 200, body: { status: -100, passcode: '0000', nextRequestIntervalInSeconds: 3 } };
}
