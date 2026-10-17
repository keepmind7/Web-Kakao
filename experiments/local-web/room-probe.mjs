import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROFILE, checkPinnedSource } from './kakao-auth.mjs';
import { responseStatus } from './reader-response.mjs';

const METHODS = new Set(['GETCONF', 'CHECKIN', 'LOGINLIST']);
export function allowedReadOnlyMethod(method) { return METHODS.has(method); }
export function safeDestination(host, port) {
  if (typeof host !== 'string' || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  const ip = isIP(host);
  if (ip === 4) {
    const [a,b,c] = host.split('.').map(Number);
    return a > 0 && a < 224 && ![10,127].includes(a) && !(a===169 && b===254) && !(a===172 && b>=16 && b<=31) && !(a===192 && b===168) && !(a===100 && b>=64 && b<=127)
      && !(a===192 && b===0 && [0,2].includes(c)) && !(a===192 && b===88 && c===99)
      && !(a===198 && [18,19].includes(b)) && !(a===198 && b===51 && c===100) && !(a===203 && b===0 && c===113);
  }
  if (ip === 6) return /^[23][a-f0-9]{3}:/i.test(host) && !/^2001:0?db8:/i.test(host) && !/^2002:/i.test(host) && !/^2001:(?:0{1,4}:|:)/i.test(host);
  return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+kakao\.com$/i.test(host);
}
export async function resolvePublicDestination(host, port, resolve = lookup) {
  if (!safeDestination(host,port)) throw new Error('invalid_route');
  if (isIP(host)) return host;
  const addresses = await resolve(host,{all:true,verbatim:true});
  const address = addresses.find(item => isIP(item.address) && safeDestination(item.address,port))?.address;
  if (!address) throw new Error('non_public_route');
  // Connect to this checked literal address, not a second DNS lookup.
  return address;
}
export function sanitizeProbe(result) {
  const stages = ['booking','getconf','checkin','loginlist','deadline','cancelled','worker'];
  const stage = stages.includes(result?.stage) ? result.stage : 'worker';
  const status = Number.isInteger(result?.status) ? result.status : null;
  const connected = result?.ok === true && stage === 'loginlist' && status === 0;
  return { phase: connected ? 'completed' : 'failed', stage, status, connectionVerified: connected,
    roomListPresent: connected && result?.roomListPresent === true,
    roomCount: connected && result?.roomListPresent === true && Number.isInteger(result?.roomCount) && result.roomCount >= 0 && result.roomCount <= 50000 ? result.roomCount : null,
    readOnly: true, rawDataRecorded: false };
}

// Injectable low-level factory permits offline verification without importing
// the original SDK or performing any real account operation in tests.
export async function probeRoomCount(credential, factory, onConnected) {
  const clients = []; let stage = 'booking';
  const track = client => {
    clients.push(client);
    client.on('error', () => client.disconnect());
    return client;
  };
  try {
    const booking = track(factory.booking()); await booking.connect(); stage = 'getconf';
    const conf = await booking.request('GETCONF', { userId: factory.toLong(credential.userId), mccmnc: '45005', os: PROFILE.os, appVer: PROFILE.appVersion });
    if (responseStatus(conf) !== 0) return {ok:false,stage,status:responseStatus(conf)};
    const ticketInfo = conf.body?.ticket ?? conf.body?.ticketInfo ?? {};
    const hosts = [...(Array.isArray(ticketInfo.lsl) ? ticketInfo.lsl : []), ...(Array.isArray(ticketInfo.lsl6) ? ticketInfo.lsl6 : [])];
    const wifi = conf.body?.wifi ?? conf.body?.connInfoForWifi ?? {};
    const mobile = conf.body?.['3g'] ?? conf.body?.connInfoForCellular ?? {};
    const ports = [...(Array.isArray(wifi.ports) ? wifi.ports : []), ...(Array.isArray(mobile.ports) ? mobile.ports : [])].map(Number).filter(value => Number.isInteger(value) && value > 0 && value <= 65535);
    const port = ports.includes(443) ? 443 : ports[0] ?? 443;
    const host = hosts.find(value => safeDestination(value,port));
    stage = 'checkin';
    let route;
    const resolveRoute = factory.resolve ?? resolvePublicDestination;
    if (host) {
      const address = await resolveRoute(host,port);
      const ticket = track(factory.ticket()); await ticket.connect(address,port); route = await ticket.checkin(credential.userId);
    } else { route = await booking.checkin(credential.userId); }
    if (responseStatus(route) !== 0 || !safeDestination(route.host,route.port)) return {ok:false,stage,status:responseStatus(route)};
    const address = await resolveRoute(route.host,route.port);
    const carriage = track(factory.carriage()); await carriage.connect(address,route.port); stage = 'loginlist';
    const earlyPush=[];let overflow=false;
    const capture=packet=>{if(earlyPush.length<200)earlyPush.push(packet);else overflow=true;};
    if(onConnected)carriage.on('push',capture);
    let login;try{login=await carriage.loginList(credential);}finally{carriage.off('push',capture);}
    if(overflow)return {ok:false,stage:'loginlist',status:null};
    if (responseStatus(login) !== 0) return {ok:false,stage,status:responseStatus(login)};
    const list = ['chatDatas','chatInfos','chats','chatRooms','chatList'].map(key => login.body?.[key]).find(Array.isArray);
    if (onConnected) {
      // Persistent read-only reader owns only the carriage after login.
      for (const client of clients.slice(0,-1)) client.disconnect();
      await onConnected(carriage,login.body,earlyPush);
    }
    // Count only. No room identifiers, names, last-message text or sender data
    // leave this worker. Missing list is distinct from a valid empty list.
    return {ok:true,stage,status:0,roomListPresent:Array.isArray(list),roomCount:list?.length ?? null};
  } catch { return {ok:false,stage}; }
  finally { for (const client of clients.reverse()) { try { client.disconnect(); } catch { /* all clients still cleaned */ } } }
}

// The worker has a hard lifetime and no stdout/stderr. A malformed SDK frame
// can fail this experiment without crashing the authentication web process.
export function runRoomProbe(credential, {signal, spawn = fork} = {}) {
  checkPinnedSource({workingCopy:true});
  return new Promise(resolve => {
    let child, done = false, sent = false, timer;
    const finish = result => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort',cancel);
      if (child) { child.removeAllListeners(); child.on('error',()=>{}); child.kill(); }
      resolve(sanitizeProbe(result));
    };
    const cancel = () => finish({stage:'cancelled'});
    if (signal?.aborted) { cancel(); return; }
    try {
      child = spawn(fileURLToPath(new URL('./room-probe-worker.mjs',import.meta.url)), [], {
        execArgv: ['--max-old-space-size=128','--import',new URL('../../local-only/spikes/modern/node_modules/tsx/dist/loader.mjs',import.meta.url).href],
        stdio: ['ignore','ignore','ignore','ipc'], windowsHide: true,
        env: {...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('KAKAO_') && !['NODE_OPTIONS','NODE_DEBUG','NODE_USE_ENV_PROXY','NPM_TOKEN','NODE_AUTH_TOKEN'].includes(key))), KAKAO_DEBUG_LOCO:'0'},
      });
      child.on('message', message => {
        if (done) return;
        if (message?.type === 'room-probe-ready' && !sent) {
          sent = true;
          const minimalCredential = {userId:credential.userId,deviceUUID:credential.deviceUUID,accessToken:credential.accessToken};
          try { child.send({type:'read-only-room-count',credential:minimalCredential},error=>{if(error)finish({stage:'worker'});}); }
          catch { finish({stage:'worker'}); }
        }
        else if (message?.type === 'room-probe-result') finish(message);
      });
      child.on('error',()=>finish({stage:'worker'})); child.on('exit',()=>finish({stage:'worker'}));
      signal?.addEventListener('abort',cancel,{once:true});
      timer = setTimeout(()=>finish({stage:'deadline'}),20000); timer.unref?.();
    } catch { finish({stage:'worker'}); }
  });
}
