// Deterministic offline fixture runner. No CLI arguments, network, account or files.
import {
  makeSyntheticImage, inspectImage, createPhotoSimulator, simulateOfficial,
  simulateManualShare, simulateCrypto, simulateTransportPolicy,
} from './model.mjs';
import { createHash } from 'node:crypto';

const context = { account: 'synthetic-account', room: 'synthetic-room', generation: 1 };
const small = makeSyntheticImage({ size: 1024 });
const large = makeSyntheticImage({ size: 629748 });
const cases = [];
function record(name, result, check) {
  cases.push({ name, passed: check(result) === true, result });
}
async function photo(name, { method = 'http-write', image = small, adapters = {}, policy = {}, isCurrent } = {}, check) {
  const simulator = createPhotoSimulator({ adapters, policy, isCurrent });
  const result = await simulator.send({ method, image, context, clientId: name });
  record(name, result, check);
}
await photo('loco-small', { method: 'loco' }, r => r.messagePhase === 'accepted' && !r.calls.write);
let peerLocoHash;
await photo('loco-large', { method: 'loco', image: large, adapters: { file: ({ payload }) => {
  peerLocoHash = createHash('sha256').update(payload).digest('hex'); return { status: 0 };
} } }, r => r.uploadPhase === 'complete' && r.image.bytes === 629748 && peerLocoHash === r.image.sha256);
let smallAssetBound = false;
await photo('http-small', { adapters: { write: ({ clientId, asset, registration }) => {
  smallAssetBound = clientId === 'http-small' && asset.path === 'fixture-asset:synthetic'
    && asset.s === small.bytes.length && asset.sha256 === inspectImage(small).sha256
    && registration.chatId === context.room && Number.isSafeInteger(registration.msgId)
    && registration.msgId > 0 && registration.type === 2 && registration.noSeen === true
    && registration.extra === JSON.stringify({ path: asset.path, s: asset.s });
  return { status: 0, clientId, chatId: registration.chatId, msgId: registration.msgId, asset };
} } }, r => r.uploadPhase === 'asset_uploaded' && r.messagePhase === 'accepted' && r.calls.write === 1 && smallAssetBound);
let peerHttpHash;
await photo('http-large', { image: large, adapters: { upload: ({ payload }) => {
  peerHttpHash = createHash('sha256').update(payload).digest('hex');
  return { status: 200, contentType: 'text/plain', body: 'fixture-asset:large' };
} } }, r => r.image.bytes === 629748 && r.calls.write === 1 && peerHttpHash === r.image.sha256);
await photo('png-declared-jpeg', { image: { ...makeSyntheticImage({ format: 'png' }), mime: 'image/jpeg', name: 'synthetic.jpg' } }, r => r.messagePhase === 'refused' && !r.calls.upload);
await photo('wrong-extension', { image: { ...small, name: 'synthetic.png' } }, r => r.messagePhase === 'refused');
for (const [name, response] of [
  ['http-rejected', { status: 403, contentType: 'text/plain', body: 'fixture-asset:denied' }],
  ['http-empty', { status: 200, contentType: 'text/plain', body: '' }],
  ['http-html', { status: 200, contentType: 'text/html', body: '<html>fixture</html>' }],
  ['http-oversized', { status: 200, contentType: 'text/plain', body: 'x'.repeat(257) }],
  ['http-redirect', { status: 200, contentType: 'text/plain', body: 'fixture-asset:redirect', redirected: true }],
]) await photo(name, { adapters: { upload: () => response } }, r => r.uploadPhase === 'failed' && !r.calls.write);
await photo('http-write-rejected', { adapters: { write: () => ({ status: -1 }) } }, r => r.uploadPhase === 'asset_uploaded' && r.messagePhase === 'failed');
await photo('http-write-missing', { adapters: { write: () => undefined } }, r => r.uploadPhase === 'asset_uploaded' && r.messagePhase === 'unknown');
await photo('http-write-reset', { adapters: { write: () => { throw new Error('synthetic reset'); } } }, r => r.uploadPhase === 'asset_uploaded' && r.messagePhase === 'unknown');
await photo('loco-missing-complete', { method: 'loco', adapters: { complete: () => undefined } }, r => r.messagePhase === 'unknown' && !r.calls.write);
await photo('loco-file-reset', { method: 'loco', adapters: { file: () => { throw new Error('synthetic reset'); } } }, r => r.messagePhase === 'unknown');
await photo('loco-post-stream-complete-rejection', { method: 'loco', adapters: { complete: () => ({ status: -1 }) } }, r => r.messagePhase === 'unknown');
await photo('http-media-only-block', { policy: { fileTransportBlocked: true } }, r => r.messagePhase === 'accepted' && r.calls.write === 1);
await photo('http-all-loco-block', { policy: { allLocoBlocked: true } }, r => r.uploadPhase === 'asset_uploaded' && r.messagePhase === 'failed' && !r.calls.write);
let current = true;
await photo('context-change-after-upload', { isCurrent: () => current, adapters: { upload: () => { current = false; return { status: 200, contentType: 'text/plain', body: 'fixture-asset:stale' }; } } }, r => r.messagePhase === 'refused' && !r.calls.write);
current = true;
await photo('context-change-after-write', { isCurrent: () => current, adapters: { write: () => { current = false; return { status: 0 }; } } }, r => r.messagePhase === 'unknown');
{
  let uploads = 0; let writes = 0;
  const simulator = createPhotoSimulator({ adapters: {
    upload: () => { uploads++; return { status: 200, contentType: 'text/plain', body: 'fixture-asset:dedupe' }; },
    write: () => { writes++; return { status: 0 }; },
  } });
  const request = { method: 'http-write', image: small, context, clientId: 'dedupe' };
  const results = await Promise.all([simulator.send(request), simulator.send(request)]);
  record('concurrent-dedupe', { ...results[1], actualCalls: { upload: uploads, write: writes } }, r => uploads === 1 && writes === 1 && JSON.stringify(results[0]) === JSON.stringify(results[1]));
  record('clientid-method-reuse', await simulator.send({ ...request, method: 'loco' }), r => r.reason === 'client_id_reuse_refused');
  record('clientid-content-reuse', await simulator.send({ ...request, image: large }), r => r.reason === 'client_id_reuse_refused');
  record('clientid-generation-reuse', await simulator.send({ ...request, context: { ...context, generation: 2 } }), r => r.reason === 'client_id_reuse_refused');
}
{
  const simulator = createPhotoSimulator({ adapters: { write: () => undefined } });
  await simulator.send({ method: 'http-write', image: small, context, clientId: 'unknown-original' });
  record('unknown-method-switch-lock', await simulator.send({ method: 'loco', image: small, context, clientId: 'unknown-switch' }), r => r.reason === 'unknown_content_retry_refused' && !r.calls.post);
}
for (const profile of ['cfb', 'gcm']) {
  record(`crypto-${profile}-roundtrip`, simulateCrypto({ profile }), r => r.cryptoPhase === 'roundtrip' && r.compatibility === 'unverified');
  record(`crypto-${profile}-wrong-profile`, simulateCrypto({ profile, decryptProfile: profile === 'cfb' ? 'gcm' : 'cfb' }), r => r.cryptoPhase === 'refused');
}
record('crypto-gcm-tamper', simulateCrypto({ profile: 'gcm', tamper: true }), r => r.cryptoPhase === 'rejected');
record('crypto-cfb-no-authentication', simulateCrypto({ profile: 'cfb', tamper: true }), r => r.cryptoPhase === 'modified_plaintext' && !r.authenticated);
record('official-arbitrary-room', simulateOfficial({ target: 'arbitrary-room', configured: true, consent: true }), r => r.messagePhase === 'unsupported');
record('official-missing-consent', simulateOfficial({ target: 'self', configured: true }), r => r.messagePhase === 'blocked');
record('official-self-template', simulateOfficial({ target: 'self', configured: true, consent: true }), r => r.messagePhase === 'accepted' && r.messageForm === 'image_template_card');
record('official-six-friends', simulateOfficial({ target: 'friends', configured: true, consent: true, friendUuids: Array.from({ length: 6 }, (_, i) => `fixture-${i}`) }), r => r.messagePhase === 'refused');
record('official-http200-partial', simulateOfficial({ target: 'friends', configured: true, consent: true, friendUuids: ['fixture-1', 'fixture-2'], response: { httpStatus: 200, successful_receiver_uuids: ['fixture-1'], failure_info: [{}] } }), r => r.messagePhase === 'partial_failure' && r.failedRecipients === 1);
record('official-share-selection', simulateOfficial({ target: 'share', configured: true }), r => r.messagePhase === 'requires_user_selection');
for (const [name, request, phase] of [
  ['manual-unsupported', {}, 'unsupported'],
  ['manual-can-share-false', { supported: true }, 'unsupported'],
  ['manual-no-activation', { supported: true, canShare: true }, 'blocked'],
  ['manual-cancel', { supported: true, canShare: true, userActivation: true, outcome: 'cancel' }, 'cancelled'],
  ['manual-handoff', { supported: true, canShare: true, userActivation: true }, 'handed_off'],
]) record(name, simulateManualShare(request), r => r.messagePhase === phase && r.targetApp === 'unknown');
record('policy-media-only', simulateTransportPolicy({ fileTransportBlocked: true }), r => !r.locoFilePossible && r.httpWriteRegistrationPossible && !r.httpAloneCanDeliver);
record('policy-all-loco', simulateTransportPolicy({ allLocoBlocked: true }), r => !r.httpWriteRegistrationPossible && !r.httpAloneCanDeliver);

const failed = cases.filter(c => !c.passed).length;
console.log(JSON.stringify({
  kind: 'offline-source-derived-simulation', version: 1,
  fixtures: { small: inspectImage(small), large: inspectImage(large) },
  summary: { total: cases.length, passed: cases.length - failed, failed, realDeliveryChecks: 0 },
  limitations: [
    'All transport outcomes are injected fixtures, not real SDK/server/TLS or timing measurements.',
    'HTTP asset grammar and current PHOTO metadata are unestablished; fixture paths are synthetic.',
    'Minimal type2 path+s registration is a legacy-derived proposal, not current PHOTO extra/BSON.',
    'Received paths cannot authenticate a server-side path-to-bytes link or detect a dishonest valid path swap.',
    'Accepted/COMPLETE/template response/share handoff does not prove photo arrival.',
    'CFB roundtrip does not prove service compatibility; no downgrade or transport bypass is proposed.',
    'Crypto uses one fixed 22-byte synthetic plaintext; photo-sized framing is not verified.',
    'Dedupe and uncertainty locks are memory-only; restart persistence is not modeled.',
    'Image inspection uses signature/extension checks, not a complete decoder.',
  ],
  resources: { networkConnectionsOpened: 0, filesOpenedByModel: 0, activeAccounts: 0, timersClearedAfterAdapterCalls: true },
  cases,
}, null, 2));
if (failed) process.exitCode = 1;
