// Anonymous GET format controls only. No QR/session/account operation.
import https from 'node:https';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

async function check(contentType) {
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'katalk.kakao.com', port: 443,
      path: '/android/account/allowlist.json?model_name=SM-T733', method: 'GET',
      rejectUnauthorized: true, signal: AbortSignal.timeout(12000),
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity',
        'User-Agent': 'KT/26.1.2 An/14 ko', A: 'android/26.1.2/ko',
        ...(contentType ? {'Content-Type':contentType} : {}) },
    }, res => {
      let size = 0; const chunks = [];
      const base = { request_content_type: contentType, https: true, http_status: res.statusCode,
        response_content_type: String(res.headers['content-type'] ?? '').slice(0,100),
        account_used: false, qr_generated: false, redirects_followed: false };
      res.on('data', chunk => { size += chunk.length; if (size > 16384) { res.destroy(); return; } chunks.push(chunk); });
      res.on('error', () => resolve({...base,outcome:'response_error'}));
      res.on('aborted', () => resolve({...base,outcome:'response_aborted'}));
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* no raw response output */ }
        resolve({...base, json_response: body !== null, allowlisted: typeof body?.allowlisted === 'boolean' ? body.allowlisted : null,
          api_status: Number.isInteger(body?.status) ? body.status : null });
      });
    });
    req.on('error', () => resolve({request_content_type:contentType,https:true,outcome:'transport_error',account_used:false,qr_generated:false}));
    req.end();
  });
}
const results = [];
// Bounded, explicit format comparison; no automatic authentication retry.
for (const type of [null,'application/json','application/x-www-form-urlencoded']) results.push(await check(type));
const result = { confirmed_date_kst:'2026-10-15', experiment:'anonymous_allowlist_content_type_controls', results,
  authentication_attempted:false, actual_message_sent:false };
const folder = fileURLToPath(new URL('../evidence/local-web/',import.meta.url));
mkdirSync(folder,{recursive:true});
writeFileSync(folder+'allowlist-format-controls.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
