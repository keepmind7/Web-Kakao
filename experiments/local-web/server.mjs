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
import { privateDataRoot,ensurePrivateDirectoryAsync,verifyPrivateFile,verifyPrivateFileAsync } from './private-storage.mjs';
import { createLocalAccess,localControlStatus } from './local-access.mjs';
import { createTabPresence } from './tab-presence.mjs';
import { DEFAULT_PHOTO_TRANSPORT,normalizePhotoTransport,photoTransportFromArgs } from './photo-transport.mjs';

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
  ['/photo-loader.js', ['photo-loader.js', 'text/javascript; charset=utf-8']],
  ['/theme.js', ['theme.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/local-launch.js', ['local-launch.js', 'text/javascript; charset=utf-8']],
]);
export function createLocalServer({ transport, mode = 'mock', encode = encodeQr, probe = runRoomProbe, readerFactory = createReadOnlyReader, gapProbe=false,messaging=false,photoTransport=DEFAULT_PHOTO_TRANSPORT,preferenceStore=createPreferenceStore(),photoFetcher,controlToken,presenceOptions={} } = {}) {
  photoTransport=normalizePhotoTransport(photoTransport);
  const access=createLocalAccess({controlToken});
  const lab = createAuthLab({ transport: transport ?? (mode === 'live' ? createTransport() : mockTransport()), encodeQr: encode, mode, credentialRetentionMs:null });
  const photos=createPhotoCache({fetcher:photoFetcher});
  // Local HTTP consumer ids, not Kakao operations. Closed ids/tombstones last
  // 30s; active responses have a 15s lease and are never silently evicted.
  const photoRequests=new Map();
  const prunePhotoRequests=()=>{for(const [id,row] of photoRequests)if(row.expiresAt<=Date.now())photoRequests.delete(id);};
  const clearPhotos=()=>{for(const row of photoRequests.values())if(!row.closed){row.controller.abort();row.response.destroy();}photos.clear();};
  const newReader=()=>readerFactory({gapProbe,messaging,photoTransport,preferenceStore,onBlocked:()=>{clearPhotos();reader.close();lab.blockConnection();}});
  let reader=newReader();
  // Shared worker view: accepted intent order, not an acknowledgment from Kakao.
  // A page UUID has its own sequence space; the local session is shared by tabs.
  let viewScope=null;
  const currentViewScope=()=>{
    const attempts=reader.snapshot().attempts;
    if(!viewScope || viewScope.reader!==reader || viewScope.attempts!==attempts)viewScope={reader,attempts,issued:0,accepted:0,clients:new Map()};
    return viewScope;
  };
  // Alias writes belong to one room and connection. Keep watermarks even after
  // a rejected/unknown write: an older request must never become current again.
  let roomPreferenceScope=null;
  const currentRoomPreferenceScope=()=>{
    const {attempts,instanceId}=reader.snapshot();
    if(!roomPreferenceScope || roomPreferenceScope.reader!==reader || roomPreferenceScope.attempts!==attempts || roomPreferenceScope.instanceId!==instanceId)roomPreferenceScope={reader,attempts,instanceId,issued:0,rooms:new Map()};
    return roomPreferenceScope;
  };
  const forgetAccount=()=>{try{reader.close();}finally{try{clearPhotos();}finally{lab.cancel();}}};
  // Only internal cleanup may own onEmpty; options inject bounded clocks/timers for QA.
  const presence=createTabPresence({...presenceOptions,onEmpty:forgetAccount}),streams=new Map();
  let disposed=false,closing=false;
  const dispose=()=>{
    if(disposed)return;disposed=true;presence.close();
    try{for(const finish of streams.values())finish();}finally{forgetAccount();}
  };
  const snapshot=()=>{const tabPresence=presence.snapshot(),auth=lab.snapshot(),reading=reader.snapshot();if(!auth.credentialInMemory)clearPhotos();return {build:8,photoCancellation:true,roomPreferenceOrdering:true,sessionPolicy:'tab-open',tabPresence,preferences:typeof reader.settingsSnapshot==='function',outboxRecovery:typeof reader.outbox==='function' && typeof reader.acknowledgeOutbox==='function',viewPin:typeof reader.view==='function',viewOrdering:true,gapProbe:gapProbe===true,messaging:messaging===true,photoTransport,...auth,actualMessageSent:auth.actualMessageSent || mode==='live' && reading.sendAccepted>0,actualChatConnected:auth.actualChatConnected || Number.isFinite(reading.connectedAt),chatConnectionActive:reading.phase==='connected',reader:reading,canOpenReader:mode==='live' && !auth.sessionBlocked && auth.credentialInMemory && auth.phase==='authenticated' && reading.canConnect};};
  const csrf = randomBytes(32).toString('hex');
  const withPhotoCapabilities=page=>Array.isArray(page?.messages)?{...page,messages:page.messages.map(message=>Array.isArray(message?.photos)?{...message,photos:message.photos.map(photo=>{const match=typeof photo?.src==='string' && /^\/api\/photo\?room=(r_[a-f0-9]{24})&message=(m_[a-f0-9]{24})&index=([0-9]|[12][0-9])$/.exec(photo.src);return match?{...photo,src:photo.src+'&cap='+access.photoCapability(match[1],match[2],match[3])}:photo;})}:message)}:page;
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
    if(disposed || closing)return reply(503,{error:'server_closing'});
    if (req.headers.host !== new URL(origin).host || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return reply(403, { error: 'local_only' });
    if (req.headers['sec-fetch-site'] && !['none', 'same-origin'].includes(req.headers['sec-fetch-site'])) return reply(403, { error: 'same_origin_required' });
    if(req.method==='GET' && req.url==='/launch')return reply(200,'<!doctype html><html lang="ko"><meta charset="utf-8"><title>로컬 연결</title><script src="/local-launch.js" defer></script><body>로컬 연결을 여는 중입니다.</body></html>','text/html; charset=utf-8');
    if (req.method === 'GET' && assets.has(req.url)) {
      const [name, type] = assets.get(req.url);
      return reply(200, readFileSync(new URL(name, import.meta.url)), type);
    }
    if(req.method==='GET' && /^\/api\/local\/challenge\?nonce=[a-f0-9]{64}$/.test(req.url)){const proof=access.prove(req.url.slice(-64));return reply(200,{app:APP,proof});}
    const controlled=access.control(req.headers['x-local-control']);
    const controlPath=req.method==='POST' && /^\/api\/local\/control\/(?:start|room-probe|shutdown)$/.test(req.url);
    controlRequest=controlPath;
    const localLaunch=req.method==='POST' && req.url==='/api/local/launch';
    const localSession=req.method==='POST' && req.url==='/api/local/session';
    if(req.method==='GET' && req.url==='/api/local/status')return controlled?reply(200,{app:APP,...localControlStatus(snapshot())}):reply(403,{error:'local_control_required'});
    const photoQuery=req.method==='GET' && /^\/api\/photo\?room=(r_[a-f0-9]{24})&message=(m_[a-f0-9]{24})&index=([0-9]|[12][0-9])&cap=([a-f0-9]{64})(?:&request=([a-f0-9]{32}))?$/.exec(req.url);
    const headerAuthenticated=access.authenticated(req.headers['x-local-session']);
    const authenticated = headerAuthenticated || Boolean(photoQuery) && access.photoAuthorized(photoQuery[4],photoQuery[1],photoQuery[2],photoQuery[3]);
    if ((controlPath || localLaunch) && !controlled || !(authenticated || localSession || controlled && (controlPath || localLaunch))) return reply(403, { error: 'local_session_required' });
    if(req.url==='/api/presence' && !headerAuthenticated)return reply(403,{error:'local_session_required'});
    if(authenticated || controlled && (controlPath || localLaunch))presence.snapshot();
    if (req.method === 'GET' && req.url === '/api/status') return reply(200, { app: APP, csrf, ...snapshot() });
    let requestUrl;try{requestUrl=new URL(req.url,origin);}catch{return reply(400,{error:'invalid_url'});}
    const accountPath=/^\/api\/(?:reader|preferences|notifications)(?:\/|$)/.test(requestUrl.pathname);
    // Omitted headers retain authenticated operator/legacy compatibility.
    const readerScopeMatches=()=>{presence.snapshot();const expected=req.headers['x-reader-instance'];return expected===undefined || typeof expected==='string' && /^[a-f0-9]{24}$/.test(expected) && expected===reader.snapshot().instanceId;};
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
      const fields=[...requestUrl.searchParams.keys()].sort().join(','),id=requestUrl.searchParams.get('request');
      if(!['index,message,room','cap,index,message,room','index,message,request,room','cap,index,message,request,room'].includes(fields) || !roomKeyValid(key) || !/^m_[a-f0-9]{24}$/.test(message) || !/^(?:[0-9]|[12][0-9])$/.test(index) || id!==null && !/^[a-f0-9]{32}$/.test(id))return reply(400,{error:'invalid_photo'});
      const url=reader.photo?.(key,message,Number(index));if(!url)return reply(404,{error:'photo_unavailable'});
      prunePhotoRequests();
      if(id && photoRequests.has(id))return reply(409,{error:'photo_request_retired'});
      if(id && photoRequests.size>=512)return reply(429,{error:'photo_request_limit'});
      const controller=new AbortController(),row={scope:key+':'+message+':'+index,controller,response:res,closed:false,expiresAt:Infinity};
      row.closedPromise=new Promise(resolve=>row.resolveClose=resolve);
      const finish=()=>{
        if(row.closed)return;row.closed=true;clearTimeout(row.timer);controller.abort();req.removeListener('aborted',abort);
        row.response=null;row.expiresAt=Date.now()+30000;row.resolveClose();row.resolveClose=null;
      };
      const abort=()=>controller.abort();req.once('aborted',abort);res.once('close',finish);
      row.timer=setTimeout(()=>{controller.abort();res.destroy();},15000);row.timer.unref?.();
      if(id)photoRequests.set(id,row);
      try{const item=await photos.get(url,{signal:controller.signal});if(res.destroyed)return;if(disposed || closing)return reply(503,{error:'server_closing'});presence.snapshot();if(!lab.snapshot().credentialInMemory)return reply(409,{error:'authentication_required'});return reply(200,item.data,item.type);}catch{if(res.destroyed)return;return disposed || closing?reply(503,{error:'server_closing'}):reply(502,{error:'photo_unavailable'});}
    }
    if(req.method==='GET' && ['/api/reader/rooms','/api/reader/messages'].includes(requestUrl.pathname)){
      if(!lab.snapshot().credentialInMemory)return reply(409,{error:'authentication_required'});
      if(requestUrl.pathname==='/api/reader/rooms')return reply(200,reader.rooms());
      const key=requestUrl.searchParams.get('room');
      if(!roomKeyValid(key) || [...requestUrl.searchParams.keys()].length!==1)return reply(400,{error:'room_required'});
      const page=reader.messages(key);return page?reply(200,withPhotoCapabilities(page)):reply(404,{error:'unknown_room'});
    }
    if (req.method !== 'POST' || !(controlPath || localLaunch || localSession || ['/api/presence','/api/start', '/api/cancel', '/api/shutdown', '/api/room-probe','/api/reader/connect','/api/reader/disconnect','/api/reader/history','/api/reader/send','/api/reader/photo','/api/reader/seen','/api/reader/context','/api/reader/view','/api/reader/outbox/ack','/api/preferences/room','/api/preferences','/api/preferences/forget','/api/notifications/claim','/api/photo/cancel'].includes(req.url))) return reply(404, { error: 'not_found' });
    const provided = req.headers['x-csrf-token'];
    if (req.headers.origin !== origin || !(localSession || controlled && (controlPath || localLaunch)) && (typeof provided !== 'string' || !/^[a-f0-9]{64}$/.test(provided) || !timingSafeEqual(Buffer.from(provided), Buffer.from(csrf)))) return reply(403, { error: 'same_origin_required' });
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return reply(415, { error: 'json_required' });
    if(accountPath && !readerScopeMatches())return reply(409,{error:'reader_scope_changed'});
    // Capture authenticated arrival before awaiting a potentially slow body.
    // Reconnects reuse instanceId, so both reader ownership and attempt matter.
    const viewRequest=req.url==='/api/reader/view'?{scope:currentViewScope(),order:++viewScope.issued}:null;
    const roomPreferenceRequest=req.url==='/api/preferences/room'?{scope:currentRoomPreferenceScope(),order:++roomPreferenceScope.issued}:null;
    const imageRequest=req.url==='/api/reader/photo';
    if(imageRequest && (!messaging || !lab.snapshot().credentialInMemory || receivingImage))return reply(409,{error:'action_not_ready'});
    if(imageRequest)receivingImage=true;
    let body;
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > (imageRequest?Math.ceil(IMAGE_LIMIT/3)*4+2048:req.url==='/api/reader/send'?20000:2048)) { reply(413, { error: 'body_limit' }); return; } chunks.push(chunk); }
      // Finish the iterator before rejecting: early return can destroy its socket.
      if(disposed || closing)return reply(503,{error:'server_closing'});
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(authenticated || controlled && (controlPath || localLaunch))presence.snapshot();
      // The reader can be replaced by start while this request awaits its body.
      if(accountPath && !readerScopeMatches())return reply(409,{error:'reader_scope_changed'});
      if(!body || Array.isArray(body) || typeof body!=='object')return reply(400,{error:'invalid_object'});
      if(localSession){
        const session=Object.keys(body).join(',')==='ticket'?access.exchange(body.ticket):null;
        return session?reply(200,{accepted:true,session}):reply(403,{error:'launch_ticket_required'});
      }
      if(req.url==='/api/photo/cancel'){
        if(Object.keys(body).sort().join(',')!=='index,message,requestId,room' || !roomKeyValid(body.room) || !messageKeyValid(body.message) || !Number.isInteger(body.index) || body.index<0 || body.index>29 || typeof body.requestId!=='string' || !/^[a-f0-9]{32}$/.test(body.requestId))return reply(400,{error:'invalid_photo_cancel'});
      }else if(req.url==='/api/reader/view'){
        const fields=Object.keys(body).sort().join(',');
        if(!roomKeyValid(body.room) || fields!=='room' && (fields!=='room,viewClientId,viewSequence' || !clientIdValid(body.viewClientId) || !Number.isSafeInteger(body.viewSequence) || body.viewSequence<1))return reply(400,{error:'invalid_view'});
      }else if(['/api/reader/history','/api/reader/context'].includes(req.url)){
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
        const {room,preferenceClientId,preferenceSequence,...patch}=body;
        const ordered=Object.hasOwn(body,'preferenceClientId') || Object.hasOwn(body,'preferenceSequence');
        if(!roomKeyValid(room) || !validRoomSettings(patch) || ordered && (!Object.hasOwn(patch,'title') || !clientIdValid(preferenceClientId) || !Number.isSafeInteger(preferenceSequence) || preferenceSequence<1))return reply(400,{error:'invalid_title'});
      }else if(req.url==='/api/preferences'){
        if(!validSettings(body))return reply(400,{error:'invalid_preferences'});
      }else if(Object.keys(body).length)return reply(400,{error:'empty_object_required'});
    } catch { return disposed || closing?reply(503,{error:'server_closing'}):reply(400, { error: 'invalid_json' }); }
    finally{if(imageRequest)receivingImage=false;}
    if(req.url==='/api/photo/cancel'){
      prunePhotoRequests();
      const scope=body.room+':'+body.message+':'+body.index,row=photoRequests.get(body.requestId);
      if(row && row.scope!==scope)return reply(409,{error:'photo_request_mismatch'});
      if(!row){
        if(photoRequests.size>=512)return reply(429,{error:'photo_request_limit'});
        // The cancellation can arrive before the browser's image GET.
        photoRequests.set(body.requestId,{scope,closed:true,expiresAt:Date.now()+30000});
      }else if(!row.closed){row.controller.abort();row.response.destroy();await row.closedPromise;}
      if(res.destroyed)return;return reply(200,{canceled:true});
    }
    if(req.url==='/api/presence'){
      if(req.aborted || res.destroyed)return;
      const release=presence.acquire();if(!release)return reply(429,{error:'presence_limit'});
      let interval=null,finished=false;
      const finish=()=>{
        if(finished)return;finished=true;clearInterval(interval);streams.delete(res);release();
        if(!res.destroyed && !res.writableEnded)res.end();
      };
      streams.set(res,finish);res.once('close',finish);res.once('error',finish);
      try{
        res.writeHead(200,{...headers,'Content-Type':'text/event-stream; charset=utf-8'});
        res.write(': connected\n\n');
        interval=setInterval(()=>{try{if(res.destroyed || res.writableEnded || !res.write(': keepalive\n\n')){res.destroy();finish();}}catch{res.destroy();finish();}},20000);
        interval.unref?.();
      }catch{res.destroy();finish();}
      return;
    }
    if(localLaunch){const ticket=access.issue();return ticket?reply(200,{ticket}):reply(429,{error:'launch_limit'});}
    if(controlPath)req.url=req.url.replace('/api/local/control/','/api/');
    if (req.url === '/api/start') {
      if (!lab.snapshot().canStart) return reply(409, { app: APP, ...snapshot() });
      reader.close();reader=newReader();
      clearPhotos();
      const before=lab.snapshot().attempts;void lab.start();
      if(lab.snapshot().attempts>before)presence.arm();
      return reply(202, { app: APP, ...snapshot() });
    }
    if (req.url === '/api/room-probe') {
      if(['connecting','connected'].includes(reader.snapshot().phase))return reply(409,{app:APP,...snapshot()});
      if (!lab.snapshot().canProbe || mode !== 'live') return reply(409, {app:APP,...snapshot()});
      void lab.connectReadOnly(probe);
      return reply(202, {app:APP,...snapshot()});
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
      if(viewRequest){
        const scope=currentViewScope(),client=body.viewClientId;
        if(scope!==viewRequest.scope)return reply(409,{error:'reader_scope_changed'});
        if(viewRequest.order<scope.accepted || client && (scope.clients.get(client) ?? 0)>=body.viewSequence)return reply(409,{error:'stale_view'});
        // Fail closed instead of discarding sequence watermarks and permitting
        // a delayed old page to reclaim the view. Reset on a new connection.
        if(client && !scope.clients.has(client) && scope.clients.size>=128)return reply(409,{error:'view_client_limit'});
      }
      const accepted=req.url==='/api/reader/view'?reader.view?.(body.room):reader.acknowledgeOutbox?.(body.clientId);
      if(accepted && viewRequest){
        viewRequest.scope.accepted=viewRequest.order;
        if(body.viewClientId)viewRequest.scope.clients.set(body.viewClientId,body.viewSequence);
      }
      return accepted?reply(202,{accepted:true}):reply(409,{error:'action_not_ready'});
    }
    if(['/api/preferences','/api/preferences/forget','/api/notifications/claim'].includes(req.url)){
      if(!lab.snapshot().credentialInMemory)return reply(409,{error:'authentication_required'});
      if(req.url==='/api/notifications/claim')return reply(200,{notices:reader.claimNotifications?.() ?? []});
      const owner=reader;
      // A validated explicit reset supersedes pre-reset aliases immediately,
      // even if deletion later fails. Do not clear again after awaiting: a new
      // post-reset edit already belongs to the new scope and must remain valid.
      if(req.url==='/api/preferences/forget')roomPreferenceScope=null;
      let accepted=false;try{accepted=await(req.url==='/api/preferences'?owner.updateSettings?.(body):owner.forgetSettings?.());}catch{/* A rejected durable write is not a saved setting. */}
      if(disposed || closing)return reply(503,{error:'server_closing'});
      if(reader!==owner || !readerScopeMatches() || !lab.snapshot().credentialInMemory)return reply(409,{error:'reader_scope_changed'});
      return accepted?reply(200,{settings:owner.settingsSnapshot()}):reply(409,{error:'settings_unavailable'});
    }
    if(req.url==='/api/preferences/room'){
      if(!lab.snapshot().credentialInMemory)return reply(409,{error:'authentication_required'});
      const owner=reader,scope=currentRoomPreferenceScope();
      if(scope!==roomPreferenceRequest.scope)return reply(409,{error:'reader_scope_changed'});
      const {room,preferenceClientId:client,preferenceSequence:sequence,...patch}=body;
      let state=null,reservation=null;
      if(Object.hasOwn(patch,'title')){
        state=scope.rooms.get(room);
        if(!Number.isSafeInteger(roomPreferenceRequest.order) || (!state && scope.rooms.size>=500) || (client && state && !state.clients.has(client) && state.clients.size>=128))return reply(409,{error:'room_preference_limit'});
        if(state){
          const staleSequence=client && (state.clients.get(client) ?? 0)>=sequence;
          const samePage=Boolean(client && state.latest.client===client);
          if(staleSequence || !samePage && roomPreferenceRequest.order<state.order)return reply(409,{error:'stale_room_preference'});
        }
        if(!state){state={order:0,clients:new Map(),latest:null};scope.rooms.set(room,state);}
        reservation={client};state.latest=reservation;state.order=Math.max(state.order,roomPreferenceRequest.order);
        if(client)state.clients.set(client,sequence);
      }
      const scopeCurrent=()=>!disposed && !closing && reader===owner && currentRoomPreferenceScope()===scope && readerScopeMatches() && lab.snapshot().credentialInMemory;
      const isCurrent=()=>scopeCurrent() && (!state || state.latest===reservation);
      // The same predicate fences queued/durable commits and the manager's RAM
      // projection, not just the HTTP response after a mutation has happened.
      let accepted=false;
      try{accepted=await Promise.resolve().then(()=>isCurrent() && (typeof owner.roomPreferences==='function'?owner.roomPreferences(room,patch,{isCurrent}):Object.keys(patch).join(',')==='title' && owner.rename?.(room,patch.title,{isCurrent})));}catch{/* Stale or failed storage is not a saved alias. */}
      if(disposed || closing)return reply(503,{error:'server_closing'});
      if(!scopeCurrent())return reply(409,{error:'reader_scope_changed'});
      if(!isCurrent())return reply(409,{error:'stale_room_preference'});
      return accepted?reply(202,{accepted:true}):reply(409,{error:'action_not_ready'});
    }
    if(['/api/reader/send','/api/reader/photo','/api/reader/seen','/api/reader/context'].includes(req.url)){
      if(!lab.snapshot().credentialInMemory)return reply(409,{error:'authentication_required'});
      const accepted=req.url==='/api/reader/send'?messaging && reader.sendText(body.room,body.text,body.clientId,body.replyTo)
        :imageRequest?messaging && reader.sendPhoto?.(body.room,body.image,body.clientId)
        :req.url==='/api/reader/context'?messaging && reader.openRoom(body.room)
        :reader.seen(body.room,body.token,body.notify);
      if(disposed || closing)return reply(503,{error:'server_closing'});
      if(!accepted && messaging && req.url==='/api/reader/context'){
        const retryAfterMs=reader.contextRetryAfterMs?.(body.room);
        if(Number.isInteger(retryAfterMs) && retryAfterMs>0 && retryAfterMs<=60001)return reply(409,{error:'context_rate_limited',retryAfterMs});
      }
      return accepted?reply(202,{accepted:true}):reply(409,{error:'action_not_ready'});
    }
    if(req.url==='/api/shutdown' && (['checking','generating','waiting','approval','authenticated'].includes(lab.snapshot().phase) || ['connecting','connected'].includes(reader.snapshot().phase)))return reply(409,{error:'active_session_cancel_first'});
    if(req.url==='/api/shutdown')closing=true;
    reader.close();
    clearPhotos();
    lab.cancel();
    if(req.url==='/api/shutdown' && typeof reader.flushDiagnostics==='function'){
      let timer;
      try{await Promise.race([Promise.resolve().then(()=>reader.flushDiagnostics()),new Promise(resolve=>{timer=setTimeout(resolve,1000);})]);}
      catch{/* Diagnostic storage failure must not prevent an authorized stop. */}
      finally{clearTimeout(timer);}
    }
    reply(200, { app: APP, ...snapshot() });
    if (req.url === '/api/shutdown') { server.close(); server.closeIdleConnections(); }
  });
  server.headersTimeout = 10000; server.requestTimeout = 15000;
  // Node waits for open SSE responses before emitting close. Dispose them first.
  const nativeClose=server.close;
  server.close=function(...args){dispose();return nativeClose.apply(this,args);};
  server.on('close',dispose);
  return {
    server, lab, controlToken:access.controlToken,
    close(...args){return server.close(...args);},
    async listen(port = 8787) {
      await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
      origin = `http://127.0.0.1:${server.address().port}`;
      return origin;
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes('--live') ? 'live' : 'mock';
  const photoTransport=photoTransportFromArgs(process.argv.slice(2));
  const index = process.argv.indexOf('--port');
  const port = index < 0 ? 8787 : Number(process.argv[index + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid_port');
  const root=await ensurePrivateDirectoryAsync(privateDataRoot());
  const folder=await ensurePrivateDirectoryAsync(resolve(root,'web-auth'));
  await verifyPrivateFileAsync(resolve(folder,'runtime.json'),{maxBytes:4096});
  const app = createLocalServer({ mode,gapProbe:process.argv.includes('--gap-probe'),messaging:process.argv.includes('--messaging'),photoTransport,preferenceStore:createPreferenceStore({folder:resolve(root,'preferences'),asyncSecurity:true}) });
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
  console.log(`Local authentication experiment (${mode}): ${url}`); // Never log QR, code, session or tokens.
  process.on('SIGINT', () => { app.close(); });
}
