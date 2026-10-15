import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createAuthLab, createTransport, mockTransport } from './kakao-auth.mjs';
import { runRoomProbe } from './room-probe.mjs';

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
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
export function createLocalServer({ transport, mode = 'mock', encode = encodeQr, probe = runRoomProbe } = {}) {
  const lab = createAuthLab({ transport: transport ?? (mode === 'live' ? createTransport() : mockTransport()), encodeQr: encode, mode });
  const cookie = randomBytes(32).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  let origin;
  const server = http.createServer(async (req, res) => {
    const headers = {
      'Cache-Control': 'no-store, max-age=0', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    };
    const reply = (code, data, type = 'application/json; charset=utf-8', extra = {}) => {
      res.writeHead(code, { ...headers, 'Content-Type': type, ...extra });
      res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
    };
    if (req.headers.host !== new URL(origin).host || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return reply(403, { error: 'local_only' });
    if (req.headers['sec-fetch-site'] && !['none', 'same-origin'].includes(req.headers['sec-fetch-site'])) return reply(403, { error: 'same_origin_required' });
    if (req.method === 'GET' && assets.has(req.url)) {
      const [name, type] = assets.get(req.url);
      return reply(200, readFileSync(new URL(name, import.meta.url)), type,
        req.url === '/' ? { 'Set-Cookie': `local_auth=${cookie}; HttpOnly; SameSite=Strict; Path=/` } : {});
    }
    const authenticated = (req.headers.cookie ?? '').split(';').some(item => item.trim() === `local_auth=${cookie}`);
    if (!authenticated) return reply(403, { error: 'local_session_required' });
    if (req.method === 'GET' && req.url === '/api/status') return reply(200, { app: APP, csrf, ...lab.snapshot() });
    if (req.method !== 'POST' || !['/api/start', '/api/cancel', '/api/shutdown', '/api/room-probe'].includes(req.url)) return reply(404, { error: 'not_found' });
    const provided = req.headers['x-csrf-token'];
    if (req.headers.origin !== origin || typeof provided !== 'string' || !/^[a-f0-9]{64}$/.test(provided) || !timingSafeEqual(Buffer.from(provided), Buffer.from(csrf))) return reply(403, { error: 'same_origin_required' });
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return reply(415, { error: 'json_required' });
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024) { reply(413, { error: 'body_limit' }); return; } chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length) return reply(400, { error: 'empty_object_required' });
    } catch { return reply(400, { error: 'invalid_json' }); }
    if (req.url === '/api/start') {
      if (!lab.snapshot().canStart) return reply(409, { app: APP, ...lab.snapshot() });
      void lab.start();
      return reply(202, { app: APP, ...lab.snapshot() });
    }
    if (req.url === '/api/room-probe') {
      if (!lab.snapshot().canProbe || mode !== 'live') return reply(409, {app:APP,...lab.snapshot()});
      void lab.connectReadOnly(probe);
      return reply(202, {app:APP,...lab.snapshot()});
    }
    lab.cancel();
    reply(200, { app: APP, ...lab.snapshot() });
    if (req.url === '/api/shutdown') { server.close(); server.closeIdleConnections(); }
  });
  server.headersTimeout = 10000; server.requestTimeout = 15000;
  server.on('close', () => lab.cancel());
  return {
    server, lab,
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
  const app = createLocalServer({ mode });
  const url = await app.listen(port);
  const folder = fileURLToPath(new URL('../../local-only/web-auth/', import.meta.url));
  mkdirSync(folder, { recursive: true });
  writeFileSync(resolve(folder, 'runtime.json'), JSON.stringify({ app: APP, url, mode, pid: process.pid }));
  console.log(`Local authentication experiment (${mode}): ${url}`); // Never log QR, code, cookie or tokens.
  process.on('SIGINT', () => { app.lab.cancel(); app.server.close(); });
}
