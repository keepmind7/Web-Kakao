import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync,unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createAuthLab, createTransport, mockTransport } from './kakao-auth.mjs';
import { runRoomProbe } from './room-probe.mjs';
import { createReadOnlyReader } from './reader-manager.mjs';
import { roomKeyValid } from './reader-data.mjs';
import { createPreferenceStore,validSettings,validRoomSettings } from './preferences.mjs';
import { createPhotoCache } from './photos.mjs';
import { IMAGE_LIMIT,messageKeyValid,clientIdValid,decodeImage } from './message-content.mjs';
import { privateDataRoot,ensurePrivateDirectory,verifyPrivateFile } from './private-storage.mjs';
import { createLocalAccess,localControlStatus } from './local-access.mjs';

const APP = 'web-kakao-auth-lab-v1';
export function encodeQr(text) {
  const require = createRequire(import.meta.url);
  const QRCode = require('../../local-only/spikes/modern/node_modules/qrcode-terminal/vendor/QRCode/index.js');
  const qr = new QRCode(-1, 1); // Existing MIT-licensed QR renderer, local dependency only.
  qr.addData(text); qr.make();
  return qr.modules.map(row => row.map(Boolean));
}
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/theme.js', ['theme.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/local-launch.js', ['local-launch.js', 'text/javascript; charset=utf-8']],
]);
export function createLocalServer({ transport, mode = 'mock', encode = encodeQr, probe = runRoomProbe, readerFactory = createReadOnlyReader, gapProbe=false,messaging=false,preferenceStore=createPreferenceStore(),photoFetcher,controlToken } = {}) {
  const access=createLocalAccess({controlToken});
  const lab = createAuthLab({ transport: transport ?? (mode === 'live' ? createTransport() : mockTransport()), encodeQr: encode, mode, credentialRetentionMs:60*60*1000 });
  const photos=createPhotoCache({fetcher:photoFetcher});
  const newReader=()=>readerFactory({gapProbe,messaging,preferenceStore,onBlocked:()=>{photos.clear();reader.close();lab.blockConnection();}});
  let reader=newReader();
  const snapshot=()=>{const auth=lab.snapshot(),reading=reader.snapshot();if(!auth.credentialInMemory)photos.clear();return {build:8,preferences:typeof reader.settingsSnapshot==='function',outboxRecovery:typeof reader.outbox==='function' && typeof reader.acknowledgeOutbox==='function',viewPin:typeof reader.view==='function',gapProbe:gapProbe===true,messaging:messaging===true,...auth,actualMessageSent:auth.actualMessageSent || mode==='live' && reading.sendAccepted>0,actualChatConnected:auth.actualChatConnected || Number.isFinite(reading.connectedAt),chatConnectionActive:reading.phase==='connected',reader:reading,canOpenReader:mode==='live' && !auth.sessionBlocked && auth.credentialInMemory && auth.phase==='authenticated' && reading.canConnect};};
  const csrf = randomBytes(32).toString('hex');
  let origin,receivingImage=false;
  const server = http.createServer(async (req, res) => {
    let controlRequest=false;
    const headers = {
      'Cache-Control': 'no-store, max-age=0', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    };
    const reply = (code, data, type = 'application/json; charset=utf-8', extra = {}) => {
      if(controlRequest && data && typeof data==='object')data={...(Object.hasOwn(data,'app')?{app:data.app}:{}),...(Object.hasOwn(data,'error')?{error:data.error}:{}),...localControlStatus(data)};
      res.writeHead(code, { ...headers, 'Content-Type': type, ...extra });
      res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
    };
    if (req.headers.host !== new URL(origin).host || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return reply(403, { error: 'local_only' });
    if (req.headers['sec-fetch-site'] && !['none', 'same-origin'].includes(req.headers['sec-fetch-site'])) return reply(403, { error: 'same_origin_required' });
    if(req.method==='GET' && req.url==='/launch')return reply(200,'<!doctype html><html lang="ko"><meta charset="utf-8"><title>로컬 연결</title><script src="/local-launch.js" defer></script><body>로컬 연결을 여는 중입니다.</body></html>','text/html; charset=utf-8');
    if (req.method === 'GET' && assets.has(req.url)) {
      const [name, type] = assets.get(req.url);
      return reply(200, readFileSync(new URL(name, import.meta.url)), type);
    }
    const controlled=access.control(req.headers['x-local-control']);
    const controlPath=req.method==='POST' && /^\/api\/local\/control\/(?:start|room-probe|shutdown)$/.test(req.url);
    controlRequest=controlPath;
    const localLaunch=req.method==='POST' && req.url==='/api/local/launch';
    const localSession=req.method==='POST' && req.url==='/api/local/session';
    if(req.method==='GET' && req.url==='/api/local/status')return controlled?reply(200,{app:APP,...localControlStatus(snapshot())}):reply(403,{error:'local_control_required'});
    const authenticated = access.authenticated(req.headers.cookie);
    if ((controlPath || localLaunch) && !controlled || !(authenticated || localSession || controlled && (controlPath || localLaunch))) return reply(403, { error: 'local_session_required' });
    if (req.method === 'GET' && req.url === '/api/status') return reply(200, { app: APP, csrf, ...snapshot() });
    let requestUrl;try{requestUrl=new URL(req.url,origin);}catch{return reply(400,{error:'invalid_url'});}
    const accountPath=/^\/api\/(?:reader|preferences|notifications)(?:\/|$)/.test(requestUrl.pathname);
    // Omitted headers retain authenticated operator/legacy compatibility.
    const readerScopeMatches=()=>{const expected=req.headers['x-reader-instance'];return expected===undefined || typeof expected==='string' && /^[a-f0-9]{24}$/.test(expected) && expected===reader.snapshot().instanceId;};
    if(req.method==='GET' && accountPath && !readerScopeMatches())return reply(409,{error:'reader_scope_changed'});
    if(req.method==='GET' && requestUrl.pathname==='/api/reader/outbox'){
      if(!lab.snapshot().credentialInMemory)return reply(409,{error:'authentication_required'});
      const keys=[...requestUrl.searchParams.keys()];
      if(!keys.length)return reply(200,{entries:reader.outbox?.()??[]});
      const id=requestUrl.searchParams.get('clientId');if(keys.length!==1 || keys[0]!=='clientId' || !clientIdValid(id))return reply(400,{error:'invalid_client_id'});
      return reply(200,{entry:reader.outbox?.(id)??null});
    }
    if(req.method==='GET' && requestUrl.pathname==='/api/preferences')return lab.snapshot().credentialInMemory?reply(200,{settings:reader.settingsSnapshot?.() ?? null}):reply(409,{error:'authentication_required'});
    if(req.method==='GET' && requestUrl.pathname==='/api/photo'){
      if(!lab.snapshot().credentialInMemory)return reply(409,{error:'authentication_required'});
      const key=requestUrl.searchParams.get('room'),message=requestUrl.searchParams.get('message'),index=requestUrl.searchParams.get('index');
      if([...requestUrl.searchParams.keys()].sort().join(',')!=='index,message,room' || !roomKeyValid(key) || !/^m_[a-f0-9]{24}$/.test(message) || !/^(?:[0-9]|[12][0-9])$/.test(index))return reply(400,{error:'invalid_photo'});
      const url=reader.photo?.(key,message,Number(index));if(!url)return reply(404,{error:'photo_unavailable'});
      try{const item=await photos.get(url);if(!lab.snapshot().credentialInMemory)return reply(409,{error:'authentication_required'});return reply(200,item.data,item.type);}catch{return reply(502,{error:'photo_unavailable'});}
    }
    if(req.method==='GET' && ['/api/reader/rooms','/api/reader/messages'].includes(requestUrl.pathname)){
      if(!lab.snapshot().credentialInMemory)return reply(409,{error:'authentication_required'});
      if(requestUrl.pathname==='/api/reader/rooms')return reply(200,reader.rooms());
      const key=requestUrl.searchParams.get('room');
      if(!roomKeyValid(key) || [...requestUrl.searchParams.keys()].length!==1)return reply(400,{error:'room_required'});
      const page=reader.messages(key);return page?reply(200,page):reply(404,{error:'unknown_room'});
    }
    if (req.method !== 'POST' || !(controlPath || localLaunch || localSession || ['/api/start', '/api/cancel', '/api/shutdown', '/api/room-probe','/api/reader/connect','/api/reader/disconnect','/api/reader/history','/api/reader/send','/api/reader/photo','/api/reader/seen','/api/reader/context','/api/reader/view','/api/reader/outbox/ack','/api/preferences/room','/api/preferences','/api/preferences/forget','/api/notifications/claim'].includes(req.url))) return reply(404, { error: 'not_found' });
    const provided = req.headers['x-csrf-token'];
    if (req.headers.origin !== origin || !(localSession || controlled && (controlPath || localLaunch)) && (typeof provided !== 'string' || !/^[a-f0-9]{64}$/.test(provided) || !timingSafeEqual(Buffer.from(provided), Buffer.from(csrf)))) return reply(403, { error: 'same_origin_required' });
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return reply(415, { error: 'json_required' });
    if(accountPath && !readerScopeMatches())return reply(409,{error:'reader_scope_changed'});
    const imageRequest=req.url==='/api/reader/photo';
    if(imageRequest && (!messaging || !lab.snapshot().credentialInMemory || receivingImage))return reply(409,{error:'action_not_ready'});
    if(imageRequest)receivingImage=true;
    let body;
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > (imageRequest?Math.ceil(IMAGE_LIMIT/3)*4+2048:req.url==='/api/reader/send'?20000:2048)) { reply(413, { error: 'body_limit' }); return; } chunks.push(chunk); }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // The reader can be replaced by start while this request awaits its body.
      if(accountPath && !readerScopeMatches())return reply(409,{error:'reader_scope_changed'});
      if(!body || Array.isArray(body) || typeof body!=='object')return reply(400,{error:'invalid_object'});
      if(localSession){
        const header=Object.keys(body).join(',')==='ticket'?access.exchange(body.ticket):null;
        return header?reply(200,{accepted:true},undefined,{'Set-Cookie':header}):reply(403,{error:'launch_ticket_required'});
      }
      if(['/api/reader/history','/api/reader/context','/api/reader/view'].includes(req.url)){
        if(Object.keys(body).length!==1 || !roomKeyValid(body.room))return reply(400,{error:'room_required'});
      }else if(req.url==='/api/reader/outbox/ack'){
        if(Object.keys(body).join(',')!=='clientId' || !clientIdValid(body.clientId))return reply(400,{error:'invalid_client_id'});
      }else if(req.url==='/api/reader/send'){
        if(!['clientId,room,text','clientId,replyTo,room,text'].includes(Object.keys(body).sort().join(',')) || !roomKeyValid(body.room) || typeof body.text!=='string' || !body.text.trim() || [...body.text].length>4000 || !clientIdValid(body.clientId) || Object.hasOwn(body,'replyTo') && !messageKeyValid(body.replyTo))return reply(400,{error:'invalid_message'});
      }else if(imageRequest){
        if(Object.keys(body).sort().join(',')!=='clientId,image,room' || !roomKeyValid(body.room) || !clientIdValid(body.clientId) || !decodeImage(body.image))return reply(400,{error:'invalid_image'});
      }else if(req.url==='/api/reader/seen'){
        if(Object.keys(body).sort().join(',')!=='notify,room,token' || !roomKeyValid(body.room) || typeof body.notify!=='boolean' || typeof body.token!=='string' || !/^[a-f0-9]{48}$/.test(body.token))return reply(400,{error:'invalid_seen'});
      }else if(req.url==='/api/preferences/room'){
        const {room,...patch}=body;if(!roomKeyValid(room) || !validRoomSettings(patch))return reply(400,{error:'invalid_title'});
      }else if(req.url==='/api/preferences'){
        if(!validSettings(body))return reply(400,{error:'invalid_preferences'});
      }else if(Object.keys(body).length)return reply(400,{error:'empty_object_required'});
    } catch { return reply(400, { error: 'invalid_json' }); }
    finally{if(imageRequest)receivingImage=false;}
    if(localLaunch){const ticket=access.issue();return ticket?reply(200,{ticket}):reply(429,{error:'launch_limit'});}
    if(controlPath)req.url=req.url.replace('/api/local/control/','/api/');
    if (req.url === '/api/start') {
      if (!lab.snapshot().canStart) return reply(409, { app: APP, ...lab.snapshot() });
      reader.close();reader=newReader();
      photos.clear();
      void lab.start();
      return reply(202, { app: APP, ...lab.snapshot() });
    }
    if (req.url === '/api/room-probe') {
      if(['connecting','connected'].includes(reader.snapshot().phase))return reply(409,{app:APP,...snapshot()});
      if (!lab.snapshot().canProbe || mode !== 'live') return reply(409, {app:APP,...lab.snapshot()});
      void lab.connectReadOnly(probe);
      return reply(202, {app:APP,...lab.snapshot()});
    }
    if(req.url==='/api/reader/connect'){
      if(!snapshot().canOpenReader || lab.snapshot().roomProbe?.phase==='running')return reply(409,{app:APP,...snapshot()});
      lab.withCredential((credential,options)=>reader.connect(credential,options));
      return reply(202,{app:APP,...snapshot()});
    }
    if(req.url==='/api/reader/disconnect'){reader.disconnect();return reply(200,{app:APP,...snapshot()});}
    if(req.url==='/api/reader/history'){
      if(!lab.snapshot().credentialInMemory || !reader.history(body.room))return reply(409,{error:'reader_not_ready'});
      return reply(202,{accepted:true});
    }
    if(['/api/reader/view','/api/reader/outbox/ack'].includes(req.url)){
      if(!lab.snapshot().credentialInMemory)return reply(409,{error:'authentication_required'});
      const accepted=req.url==='/api/reader/view'?reader.view?.(body.room):reader.acknowledgeOutbox?.(body.clientId);
      return accepted?reply(202,{accepted:true}):reply(409,{error:'action_not_ready'});
    }
    if(['/api/preferences','/api/preferences/forget','/api/notifications/claim'].includes(req.url)){
      if(!lab.snapshot().credentialInMemory)return reply(409,{error:'authentication_required'});
      if(req.url==='/api/notifications/claim')return reply(200,{notices:reader.claimNotifications?.() ?? []});
      const accepted=req.url==='/api/preferences'?reader.updateSettings?.(body):reader.forgetSettings?.();
      return accepted?reply(200,{settings:reader.settingsSnapshot()}):reply(409,{error:'settings_unavailable'});
    }
    if(['/api/reader/send','/api/reader/photo','/api/reader/seen','/api/reader/context','/api/preferences/room'].includes(req.url)){
      if(!lab.snapshot().credentialInMemory)return reply(409,{error:'authentication_required'});
      const accepted=req.url==='/api/reader/send'?messaging && reader.sendText(body.room,body.text,body.clientId,body.replyTo)
        :imageRequest?messaging && reader.sendPhoto?.(body.room,body.image,body.clientId)
        :req.url==='/api/reader/context'?messaging && reader.openRoom(body.room)
        :req.url==='/api/reader/seen'?reader.seen(body.room,body.token,body.notify)
        :typeof reader.roomPreferences==='function'?reader.roomPreferences(body.room,Object.fromEntries(Object.entries(body).filter(([key])=>key!=='room'))):Object.keys(body).sort().join(',')==='room,title' && reader.rename(body.room,body.title);
      return accepted?reply(202,{accepted:true}):reply(409,{error:'action_not_ready'});
    }
    if(req.url==='/api/shutdown' && (['checking','generating','waiting','approval','authenticated'].includes(lab.snapshot().phase) || ['connecting','connected'].includes(reader.snapshot().phase)))return reply(409,{error:'active_session_cancel_first'});
    reader.close();
    photos.clear();
    lab.cancel();
    reply(200, { app: APP, ...lab.snapshot() });
    if (req.url === '/api/shutdown') { server.close(); server.closeIdleConnections(); }
  });
  server.headersTimeout = 10000; server.requestTimeout = 15000;
  server.on('close', () => {photos.clear();reader.close();lab.cancel();});
  return {
    server, lab, controlToken:access.controlToken,
    async listen(port = 8787) {
      await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
      origin = `http://127.0.0.1:${server.address().port}`;
      return origin;
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes('--live') ? 'live' : 'mock';
  const index = process.argv.indexOf('--port');
  const port = index < 0 ? 8787 : Number(process.argv[index + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid_port');
  const root=ensurePrivateDirectory(privateDataRoot());
  const folder=ensurePrivateDirectory(resolve(root,'web-auth'));
  verifyPrivateFile(resolve(folder,'runtime.json'),{maxBytes:4096});
  const app = createLocalServer({ mode,gapProbe:process.argv.includes('--gap-probe'),messaging:process.argv.includes('--messaging'),preferenceStore:createPreferenceStore({folder:resolve(root,'preferences')}) });
  const url = await app.listen(port);
  writeFileSync(resolve(folder, 'runtime.json'), JSON.stringify({ app: APP, url, mode, pid: process.pid,controlToken:app.controlToken }),{mode:0o600});
  app.server.on('close',()=>{
    const path=resolve(folder,'runtime.json');
    try{
      if(!verifyPrivateFile(path,{maxBytes:4096}))return;
      const saved=JSON.parse(readFileSync(path,'utf8'));
      if(saved.app===APP && saved.pid===process.pid && saved.url===url && saved.controlToken===app.controlToken)unlinkSync(path);
    }catch{/* Keep uncertain runtime files for explicit user inspection. */}
  });
  console.log(`Local authentication experiment (${mode}): ${url}`); // Never log QR, code, cookie or tokens.
  process.on('SIGINT', () => { app.lab.cancel(); app.server.close(); });
}
